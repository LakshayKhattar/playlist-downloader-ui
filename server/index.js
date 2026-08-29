import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  ALLOW_REMOTE_ACCESS,
  APP_NAME,
  APP_AUTH_PASSWORD,
  APP_AUTH_USERNAME,
  APP_PUBLIC_URL,
  APP_REPOSITORY_URL,
  APP_ROOT,
  APP_VERSION,
  DEFAULT_QUALITY,
  DEV_PORT,
  DOWNLOADS_LABEL,
  HOST,
  MAX_BATCH_ITEMS,
  MAX_DOWNLOAD_BYTES,
  MAX_PLAYLIST_ITEMS,
  MAX_SSE_CLIENTS,
  MAX_TOTAL_DURATION_SECONDS,
  PORT,
  resolveToolchain,
} from './config.js';
import { JobManager } from './job-manager.js';
import { publicQualityOptions } from './quality.js';
import { applySecurityHeaders, createSecurityContext } from './security.js';
import { parseDownloadRequest } from './validation.js';

const JSON_LIMIT = '16kb';
const DIST_DIRECTORY = path.join(APP_ROOT, 'dist');
const INDEX_FILE = path.join(DIST_DIRECTORY, 'index.html');

function jsonError(response, status, error, code) {
  response.status(status).json({ error, ...(code ? { code } : {}) });
}

export async function createApplication({ jobs: suppliedJobs, tools, port = PORT, securityOptions = {} } = {}) {
  const jobs = suppliedJobs || new JobManager({ tools: tools || resolveToolchain() });
  await jobs.initialize?.();
  const security = createSecurityContext({
    ...securityOptions,
    port,
    devPort: DEV_PORT,
    publicUrl: APP_PUBLIC_URL,
    allowRemotePeer: securityOptions.allowRemotePeer ?? ALLOW_REMOTE_ACCESS,
    authUsername: securityOptions.authUsername ?? APP_AUTH_USERNAME,
    authPassword: securityOptions.authPassword ?? APP_AUTH_PASSWORD,
    appName: APP_NAME,
  });
  const app = express();
  const jsonParser = express.json({ limit: JSON_LIMIT, strict: true, type: 'application/json' });
  let activeStreams = 0;
  const streamResponses = new Set();

  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(applySecurityHeaders);
  app.use(security.boundaryGuard);
  app.use(security.requireAuthentication);
  app.use('/api', (_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/config', (_request, response) => {
    response.json({
      csrfToken: security.token,
      appName: APP_NAME,
      version: APP_VERSION,
      repositoryUrl: APP_REPOSITORY_URL || null,
      destinationRoot: DOWNLOADS_LABEL,
      defaultQuality: DEFAULT_QUALITY,
      formats: publicQualityOptions(),
      limits: {
        maxPlaylistItems: MAX_PLAYLIST_ITEMS,
        maxBatchItems: MAX_BATCH_ITEMS,
        maxTotalDurationHours: MAX_TOTAL_DURATION_SECONDS / 3600,
        maxDownloadGiB: MAX_DOWNLOAD_BYTES / (1024 ** 3),
      },
    });
  });

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true, version: APP_VERSION });
  });

  app.get('/api/job', (_request, response) => {
    response.json({ job: jobs.getSnapshot() });
  });

  app.get('/api/jobs/:jobId/files/:fileIndex', async (request, response, next) => {
    const { jobId, fileIndex: rawFileIndex } = request.params;
    const fileIndex = Number(rawFileIndex);
    if (!/^[0-9a-f-]{36}$/i.test(jobId) || !/^\d{1,4}$/.test(rawFileIndex)
      || !Number.isSafeInteger(fileIndex) || typeof jobs.getDownloadFile !== 'function') {
      jsonError(response, 404, 'Verified file not found.');
      return;
    }
    try {
      const file = await jobs.getDownloadFile(jobId, fileIndex);
      if (!file) {
        jsonError(response, 404, 'Verified file not found.');
        return;
      }
      response.set('Cache-Control', 'private, no-store');
      response.download(file.path, file.name, {
        acceptRanges: true,
        cacheControl: false,
        dotfiles: 'deny',
        lastModified: false,
      }, (error) => {
        if (!error) return;
        if (response.headersSent) response.destroy(error);
        else next(error);
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/download', security.requireMutation, security.limitStarts, jsonParser, (request, response) => {
    try {
      parseDownloadRequest(request.body);
    } catch (error) {
      jsonError(response, 400, error.message);
      return;
    }
    try {
      response.status(202).json({ job: jobs.start(request.body) });
    } catch (error) {
      const conflict = /already downloading|already in use/i.test(error.publicMessage || error.message);
      jsonError(response, conflict ? 409 : 503, conflict
        ? (error.publicMessage || 'A playlist is already downloading.')
        : 'The download service could not start this job.');
    }
  });

  app.post('/api/cancel', security.requireMutation, jsonParser, (request, response) => {
    const keys = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? Object.keys(request.body)
      : [];
    const current = jobs.getSnapshot();
    if (keys.length !== 1 || keys[0] !== 'jobId' || typeof request.body.jobId !== 'string'
      || !current || request.body.jobId !== current.id) {
      jsonError(response, 409, 'That download is no longer the active job.');
      return;
    }
    try {
      response.json({ job: jobs.cancel() });
    } catch (error) {
      jsonError(response, 409, error.publicMessage || 'There is no active download to cancel.');
    }
  });

  app.get('/api/events/:jobId', (request, response) => {
    const jobId = request.params.jobId;
    const current = jobs.getSnapshot();
    if (!/^[0-9a-f-]{36}$/i.test(jobId) || !current || current.id !== jobId) {
      jsonError(response, 404, 'Download job not found.');
      return;
    }
    if (activeStreams >= MAX_SSE_CLIENTS) {
      response.set('Retry-After', '5');
      jsonError(response, 503, 'Too many live progress views are open.');
      return;
    }

    activeStreams += 1;
    streamResponses.add(response);
    response.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    let writable = true;
    let pending = null;
    let closed = false;

    const drain = () => {
      writable = true;
      if (pending) {
        const next = pending;
        pending = null;
        send(next);
      }
    };
    const send = (snapshot) => {
      if (closed) return;
      if (!writable) {
        pending = snapshot;
        return;
      }
      writable = response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      if (!writable) response.once('drain', drain);
    };

    send(current);
    const unsubscribe = jobs.subscribe((snapshot) => {
      if (snapshot?.id === jobId) send(snapshot);
    });
    const heartbeat = setInterval(() => {
      if (writable && !closed) {
        writable = response.write(': keep-alive\n\n');
        if (!writable) response.once('drain', drain);
      }
    }, 15_000);

    request.once('close', () => {
      closed = true;
      activeStreams = Math.max(0, activeStreams - 1);
      streamResponses.delete(response);
      pending = null;
      clearInterval(heartbeat);
      response.removeListener('drain', drain);
      unsubscribe();
    });
  });

  app.use('/api', (_request, response) => jsonError(response, 404, 'API route not found.'));

  if (fs.existsSync(INDEX_FILE)) {
    app.use(express.static(DIST_DIRECTORY, {
      dotfiles: 'deny',
      etag: true,
      index: false,
      maxAge: '1y',
      redirect: false,
      setHeaders(response, filePath) {
        const isHashedAsset = path.dirname(filePath) === path.join(DIST_DIRECTORY, 'assets');
        response.set('Cache-Control', isHashedAsset
          ? 'public, max-age=31536000, immutable'
          : 'no-cache');
      },
    }));
    app.use((request, response, next) => {
      if (['GET', 'HEAD'].includes(request.method) && request.accepts('html')) {
        response.set('Cache-Control', 'no-cache');
        response.sendFile(INDEX_FILE);
      } else next();
    });
  }

  app.use((error, _request, response, _next) => {
    if (error?.type === 'entity.too.large') {
      jsonError(response, 413, 'The request body is too large.');
      return;
    }
    if (error instanceof SyntaxError && 'body' in error) {
      jsonError(response, 400, 'The JSON request body is malformed.');
      return;
    }
    console.error('Unhandled download service error:', error);
    jsonError(response, 500, 'The download service hit an unexpected error.');
  });

  const closeStreams = () => {
    for (const response of streamResponses) response.end();
    streamResponses.clear();
  };

  return { app, jobs, security, closeStreams };
}

export async function startServer(options = {}) {
  const port = options.port ?? PORT;
  const { app, jobs, security, closeStreams } = await createApplication({ ...options, port });
  const server = http.createServer(app);
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  server.maxRequestsPerSocket = 100;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  let stopPromise = null;
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      closeStreams();
      await jobs.shutdown?.();
      await new Promise((resolve) => {
        const forceTimer = setTimeout(() => {
          server.closeAllConnections?.();
          resolve();
        }, 10_000);
        forceTimer.unref?.();
        server.close(() => {
          clearTimeout(forceTimer);
          resolve();
        });
      });
    })();
    return stopPromise;
  };
  console.log(`${APP_NAME}: ${APP_PUBLIC_URL || `http://${HOST}:${port}`}`);
  console.log(`Downloads: ${DOWNLOADS_LABEL}`);
  return { app, jobs, security, server, stop };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  if (!fs.existsSync(INDEX_FILE)) {
    throw new Error('Production frontend is missing. Run "npm run build" before "npm start".');
  }
  const runtime = await startServer();
  const shutdown = () => {
    void runtime.stop()
      .then(() => { process.exitCode = 0; })
      .catch((error) => {
        console.error('Graceful shutdown failed:', error);
        process.exitCode = 1;
      });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
