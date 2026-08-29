FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS base

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY server ./server
COPY src ./src
COPY test ./test
RUN npm test && npm run build && npm prune --omit=dev

FROM base AS runtime

ARG YT_DLP_VERSION=2026.8.19

LABEL org.opencontainers.image.source="https://github.com/LakshayKhattar/playlist-downloader-ui" \
      org.opencontainers.image.description="Authenticated web UI and job layer for yt-dlp" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates ffmpeg python3 python3-venv \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp[default]==${YT_DLP_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PATH="/opt/yt-dlp/bin:${PATH}"

WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /app/downloads && chown node:node /app/downloads

USER node
EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const p=process.env.PORT||10000;const h=process.env.RENDER_EXTERNAL_HOSTNAME||new URL(process.env.APP_PUBLIC_URL).host;fetch('http://127.0.0.1:'+p+'/api/health',{headers:{Host:h}}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
