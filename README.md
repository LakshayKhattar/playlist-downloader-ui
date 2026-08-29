# Playlist Downloader UI

An independent, secure, and resumable UI and orchestration layer for [`yt-dlp`](https://github.com/yt-dlp/yt-dlp), built with React and Express. Each playlist is stored in one flat folder and verified with `ffprobe` after download.

> Download only media you are permitted to save. You are responsible for complying with YouTube's terms and applicable law.

## Features

- Best available, 1080p, and 720p quality profiles
- Live speed, ETA, item, pass, and total progress over SSE
- Collapsible queue that appears only after a playlist URL is entered
- Resume-aware retries, archive tracking, and final media verification
- Configurable storage, app identity, quality, resource limits, ports, and tool paths
- Dark and light responsive UI with keyboard and reduced-motion support
- Loopback-only backend with strict origin, input, filesystem, and process controls

## Requirements

- Node.js 20.19 or newer
- Current `yt-dlp`
- `ffmpeg` and `ffprobe`

The three media tools can be on `PATH`, or configured using absolute paths in `.env`.

## Quick start

```powershell
git clone https://github.com/LakshayKhattar/playlist-downloader-ui.git
cd playlist-downloader-ui
Copy-Item .env.example .env
npm ci
npm run verify
npm start
```

Open <http://127.0.0.1:4173>. Downloads default to `downloads/<playlist-id>/` and remain resumable after a cancel or restart.

For development, run the backend and Vite in separate terminals:

```powershell
npm run dev:server
npm run dev
```

## Configuration

Copy [`.env.example`](.env.example) to `.env`. All settings are optional and have safe defaults. Common settings are:

| Setting | Default | Purpose |
| --- | --- | --- |
| `APP_NAME` | `Playlist Downloader` | Name shown in the UI and page title |
| `DEFAULT_QUALITY` | `best` | `best`, `1080`, or `720` |
| `PLAYLIST_DOWNLOADS_ROOT` | `<app>/downloads` | Absolute persistent output directory |
| `PORT` / `DEV_PORT` | `4173` / `5173` | Backend and Vite development ports |
| `APP_PUBLIC_URL` | empty | Exact HTTPS reverse-proxy origin for hosted use |
| `YT_DLP_BIN` | auto-detected | Absolute `yt-dlp` executable path |
| `FFMPEG_BIN` / `FFPROBE_BIN` | auto-detected | Absolute media-tool paths |

The example file documents the complete resource-limit configuration.

## Verification

```powershell
npm run verify
npm run test:ui
```

`verify` runs backend tests, a production frontend build, and the offline high-severity dependency audit. The UI test exercises the production app without downloading media. A deliberately bounded real-download smoke test can be run with:

```powershell
npm run test:ui -- "https://www.youtube.com/playlist?list=PLAYLIST_ID"
```

## Deployment

This app requires a long-running Node process, SSE connections, media executables, and persistent disk. It is not compatible with static-only or serverless hosting. See [GUIDE.md](GUIDE.md) for local staging and a same-origin VPS deployment using systemd and Caddy.

Do not expose the Node port directly. The server binds only to `127.0.0.1`; hosted deployments should put an authenticated HTTPS reverse proxy on the same machine. See [SECURITY.md](SECURITY.md) for the security boundary and reporting policy.

## Credits

The download engine is the open-source [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) project, maintained by the yt-dlp contributors. Media inspection and merging are provided by [FFmpeg](https://ffmpeg.org/). This repository supplies an independent web UI, job-management layer, safety controls, and verification workflow; it is not affiliated with or endorsed by yt-dlp, FFmpeg, or YouTube.

## License

[MIT](LICENSE)
