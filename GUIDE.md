# Staging and deployment guide

This application needs Node.js, `yt-dlp`, `ffmpeg`, persistent storage, and long-lived HTTP/SSE connections. It is not suitable for static-only or serverless hosting.

## 1. Test a local staging build

```powershell
git clone https://github.com/LakshayKhattar/playlist-downloader-ui.git
cd playlist-downloader-ui
Copy-Item .env.example .env
npm ci
npm run verify
npm run build
npm start
```

Install `yt-dlp`, `ffmpeg`, and `ffprobe` first, or put their absolute paths in `.env`. Open `http://127.0.0.1:4173`.

In a second PowerShell window:

```powershell
curl.exe http://127.0.0.1:4173/api/health
npm run test:ui
```

The UI test checks the production frontend, same-origin API protection, validation, queue collapse, themes, and mobile layout without downloading media. Supplying a playlist URL explicitly runs a bounded start-and-cancel test:

```powershell
npm run test:ui -- "https://www.youtube.com/playlist?list=PLAYLIST_ID"
```

## 2. Configure staging or production

Copy `.env.example` to `.env`. Important values:

- `APP_PUBLIC_URL`: exact HTTPS origin used by the reverse proxy; leave blank locally.
- `PLAYLIST_DOWNLOADS_ROOT`: absolute persistent-storage path.
- `DEFAULT_QUALITY`: `best`, `1080`, or `720`.
- `YT_DLP_BIN`, `FFMPEG_BIN`, `FFPROBE_BIN`: optional absolute tool paths.
- Resource limits: keep the supplied defaults unless storage and workload have been reviewed.

Never commit `.env`. The service always binds to `127.0.0.1`; do not expose its Node port directly.

## 3. Deploy on an Ubuntu VPS

Install Node.js 22, Git, Caddy, ffmpeg, and a current yt-dlp release. Create a dedicated service account and persistent directories:

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin playlistdl
sudo mkdir -p /opt/playlist-downloader /var/lib/playlist-downloader
sudo chown -R playlistdl:playlistdl /opt/playlist-downloader /var/lib/playlist-downloader
sudo -u playlistdl git clone https://github.com/LakshayKhattar/playlist-downloader-ui.git /opt/playlist-downloader/app
cd /opt/playlist-downloader/app
sudo -u playlistdl npm ci
sudo -u playlistdl npm run verify
sudo -u playlistdl npm run build
```

Create `/opt/playlist-downloader/app/.env`:

```dotenv
NODE_ENV=production
APP_PUBLIC_URL=https://downloads.example.com
PLAYLIST_DOWNLOADS_ROOT=/var/lib/playlist-downloader
DOWNLOADS_LABEL=downloads
PORT=4173
DEFAULT_QUALITY=best
YT_DLP_BIN=/usr/local/bin/yt-dlp
FFMPEG_BIN=/usr/bin/ffmpeg
FFPROBE_BIN=/usr/bin/ffprobe
```

Protect the file:

```bash
sudo chown playlistdl:playlistdl /opt/playlist-downloader/app/.env
sudo chmod 600 /opt/playlist-downloader/app/.env
```

Create `/etc/systemd/system/playlist-downloader.service`:

```ini
[Unit]
Description=Playlist Downloader
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=playlistdl
Group=playlistdl
WorkingDirectory=/opt/playlist-downloader/app
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/playlist-downloader

[Install]
WantedBy=multi-user.target
```

Start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now playlist-downloader
sudo systemctl status playlist-downloader
```

Put Caddy on the same host so the backend still sees a loopback peer. Require authentication before proxying:

```caddyfile
downloads.example.com {
    basic_auth {
        owner REPLACE_WITH_CADDY_PASSWORD_HASH
    }
    reverse_proxy 127.0.0.1:4173
}
```

Point DNS to the VPS, generate a Caddy password hash, reload Caddy, and allow only ports 80/443 through the firewall. Keep port 4173 private.

## 4. Frontend and backend hosting boundaries

- Frontend: `npm run build` creates `dist/` with immutable hashed assets.
- Backend: `node server/index.js` serves the API, SSE progress, and `dist/`.
- Media tools: yt-dlp/ffmpeg must run on the backend host.
- Storage: the configured downloads directory must be persistent and writable only by the service account.
- Origin: serve frontend and `/api` from the same public origin. Do not split them across unrelated domains.

## 5. Release and rollback

```bash
cd /opt/playlist-downloader/app
sudo -u playlistdl git pull --ff-only
sudo -u playlistdl npm ci
sudo -u playlistdl npm run verify
sudo -u playlistdl npm run build
sudo systemctl restart playlist-downloader
```

Tag known-good releases. To roll back, check out the previous tag, repeat `npm ci` and `npm run build`, then restart the service.
