import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JobManager, toPublicJob } from '../server/job-manager.js';
import {
  basicCredentialsMatch,
  buildAllowedAuthorities,
  buildAllowedOrigins,
  createSecurityContext,
  isAllowedAuthority,
  isAllowedOrigin,
  isLoopbackPeer,
  tokenMatches,
} from '../server/security.js';
import { startServer } from '../server/index.js';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function request(port, {
  method = 'GET',
  route = '/',
  host = `127.0.0.1:${port}`,
  origin,
  token,
  authorization,
  body,
  contentType = 'application/json',
} = {}) {
  const payload = body === undefined ? null : String(body);
  const headers = { Host: host, Connection: 'close' };
  if (origin !== undefined) headers.Origin = origin;
  if (token !== undefined) headers['X-Playlist-Token'] = token;
  if (authorization !== undefined) headers.Authorization = authorization;
  if (payload !== null) {
    if (contentType) headers['Content-Type'] = contentType;
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname: '127.0.0.1', port, path: route, method, headers }, (response) => {
      let content = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { content += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: content }));
    });
    outgoing.once('error', reject);
    if (payload !== null) outgoing.write(payload);
    outgoing.end();
  });
}

function firstServerEvent(port, jobId) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: '127.0.0.1',
      port,
      path: `/api/events/${jobId}`,
      method: 'GET',
      headers: { Host: `127.0.0.1:${port}`, Accept: 'text/event-stream' },
    }, (response) => {
      let content = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        content += chunk;
        if (content.includes('\n\n')) {
          outgoing.destroy();
          resolve({ status: response.statusCode, headers: response.headers, body: content });
        }
      });
    });
    outgoing.once('error', (error) => {
      if (error.code !== 'ECONNRESET') reject(error);
    });
    outgoing.end();
  });
}

test('security helpers enforce exact loopback authorities, origins, peers, and tokens', () => {
  const authorities = buildAllowedAuthorities(4173, 'https://downloads.example.com:8443');
  const origins = buildAllowedOrigins(4173, 5173, 'https://downloads.example.com:8443');
  assert.equal(isAllowedAuthority('127.0.0.1:4173', authorities), true);
  assert.equal(isAllowedAuthority('LOCALHOST:4173', authorities), true);
  assert.equal(isAllowedAuthority('localhost:4173.attacker.test', authorities), false);
  assert.equal(isAllowedAuthority('localhost.:4173', authorities), false);
  assert.equal(isAllowedAuthority('localhost:4173, attacker.test', authorities), false);
  assert.equal(isAllowedAuthority('downloads.example.com:8443', authorities), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:4173', origins), true);
  assert.equal(isAllowedOrigin('http://localhost:5173', origins), true);
  assert.equal(isAllowedOrigin('https://downloads.example.com:8443', origins), true);
  assert.equal(isAllowedOrigin('null', origins), false);
  assert.equal(isAllowedOrigin('http://localhost:4173.attacker.test', origins), false);
  assert.equal(isLoopbackPeer('127.0.0.1'), true);
  assert.equal(isLoopbackPeer('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackPeer('192.168.1.4'), false);
  assert.equal(tokenMatches('a'.repeat(43), 'a'.repeat(43)), true);
  assert.equal(tokenMatches('b'.repeat(43), 'a'.repeat(43)), false);
  assert.equal(tokenMatches('', 'a'.repeat(43)), false);

  const authorization = `Basic ${Buffer.from('playlist:a-strong-render-password').toString('base64')}`;
  assert.equal(basicCredentialsMatch(authorization, 'playlist', 'a-strong-render-password'), true);
  assert.equal(basicCredentialsMatch(authorization, 'playlist', 'wrong-password-value'), false);
  assert.equal(basicCredentialsMatch('Bearer token', 'playlist', 'a-strong-render-password'), false);
});

test('remote mode still requires the configured public authority', () => {
  const security = createSecurityContext({
    port: 10000,
    publicUrl: 'https://playlist-downloader-ui.onrender.com',
    allowRemotePeer: true,
    authUsername: 'playlist',
    authPassword: 'a-strong-render-password',
  });
  assert.equal(security.allowedAuthorities.has('127.0.0.1:10000'), false);
  assert.equal(security.allowedOrigins.has('http://localhost:5173'), false);
  assert.equal(security.allowedAuthorities.has('playlist-downloader-ui.onrender.com'), true);
  assert.equal(security.allowedOrigins.has('https://playlist-downloader-ui.onrender.com'), true);
  let allowed = false;
  const response = {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  security.boundaryGuard({
    socket: { remoteAddress: '10.0.0.8' },
    headers: { host: 'playlist-downloader-ui.onrender.com' },
  }, response, () => { allowed = true; });
  assert.equal(allowed, true);

  allowed = false;
  security.boundaryGuard({
    socket: { remoteAddress: '10.0.0.8' },
    headers: { host: 'attacker.example' },
  }, response, () => { allowed = true; });
  assert.equal(allowed, false);
  assert.equal(response.statusCode, 421);
});

test('optional HTTP authentication protects the API while leaving public documents and health available', async (t) => {
  const port = await freePort();
  const jobs = {
    async initialize() {},
    getSnapshot: () => null,
    subscribe: () => () => {},
    async shutdown() {},
  };
  const runtime = await startServer({
    port,
    jobs,
    securityOptions: {
      authUsername: 'playlist',
      authPassword: 'a-strong-render-password',
    },
  });
  t.after(() => runtime.stop());

  const health = await request(port, { route: '/api/health' });
  assert.equal(health.status, 200);

  const publicDocument = await request(port, { route: '/robots.txt' });
  assert.notEqual(publicDocument.status, 401);

  const unauthenticated = await request(port, { route: '/api/config' });
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers['www-authenticate'], /^Basic realm=/);
  assert.equal(JSON.parse(unauthenticated.body).code, 'AUTH_REQUIRED');

  const wrong = await request(port, {
    route: '/api/config',
    authorization: `Basic ${Buffer.from('playlist:not-the-password').toString('base64')}`,
  });
  assert.equal(wrong.status, 401);

  const accepted = await request(port, {
    route: '/api/config',
    authorization: `Basic ${Buffer.from('playlist:a-strong-render-password').toString('base64')}`,
  });
  assert.equal(accepted.status, 200);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const rejected = await request(port, {
      route: '/api/config',
      authorization: `Basic ${Buffer.from(`playlist:wrong-${attempt}`).toString('base64')}`,
    });
    assert.equal(rejected.status, 401);
  }
  const rateLimited = await request(port, {
    route: '/api/config',
    authorization: `Basic ${Buffer.from('playlist:another-wrong-password').toString('base64')}`,
  });
  assert.equal(rateLimited.status, 429);
  assert.equal(JSON.parse(rateLimited.body).code, 'AUTH_RATE_LIMITED');

  const ownerStillAccepted = await request(port, {
    route: '/api/config',
    authorization: `Basic ${Buffer.from('playlist:a-strong-render-password').toString('base64')}`,
  });
  assert.equal(ownerStillAccepted.status, 200);
});

test('public job DTO strips URLs, absolute paths, raw diagnostics, and media IDs', () => {
  const publicJob = toPublicJob({
    id: '00000000-0000-4000-8000-000000000000',
    status: 'downloading', message: 'Downloading playlist', playlistTitle: 'List', totalItems: 1,
    completedItems: 0, overallPercent: 10, pass: 1, destination: 'downloads\\PL1234567890', quality: 'best',
    batch: { start: 21, end: 40, requestedSize: 20, hasMore: true, nextStart: 41, unavailableCount: 0 },
    completedBatches: [{ start: 1, end: 20 }],
    current: { index: 1, title: 'Track', percent: 10, speed: '1 MiB/s', eta: '10' },
    items: [{ id: 'abcdefghijk', index: 1, title: 'Track', status: 'downloading', percent: 10, speed: '', eta: '' }],
    files: [
      { name: '001 - Track [abcdefghijk].mkv', size: 123, verified: true },
      { name: '002 - Track [lmnopqrstuv].f137.webm', size: 456, verified: false },
      { name: '003 - [zyxwvutsrqp] Track.mkv', size: 789, verified: true },
      { name: '004 - Track [mnopqrstuvw.mkv', size: 999, verified: false },
    ],
    verification: { status: 'pending', checked: 0, total: 0, valid: 0, invalidCount: 0, missingCount: 0, partialCount: 0 },
    error: null,
    url: 'https://www.youtube.com/playlist?list=secret',
    playlistId: 'secret',
    outputDirectory: 'C:\\Users\\private\\downloads',
    log: ['C:\\Users\\private\\tool-error'],
  });
  const serialized = JSON.stringify(publicJob);
  assert.equal('url' in publicJob, false);
  assert.equal('outputDirectory' in publicJob, false);
  assert.equal('log' in publicJob, false);
  assert.equal('id' in publicJob.items[0], false);
  assert.deepEqual(publicJob.batch, { start: 21, end: 40, requestedSize: 20, hasMore: true, nextStart: 41, unavailableCount: 0 });
  assert.deepEqual(publicJob.completedBatches, [{ start: 1, end: 20 }]);
  assert.equal(publicJob.files[0].name, '001 - Track.mkv');
  assert.equal(publicJob.files[0].index, 1);
  assert.equal(publicJob.files[0].downloadUrl, '/api/jobs/00000000-0000-4000-8000-000000000000/files/0');
  assert.equal(publicJob.files[1].name, '002 - Track.f137.webm');
  assert.equal(publicJob.files[1].downloadUrl, null);
  assert.equal(publicJob.files[2].name, '003 - Track.mkv');
  assert.equal(publicJob.files[3].name, '004 - Track.mkv');
  assert.doesNotMatch(serialized, /C:\\\\Users|playlist\?list=|abcdefghijk|lmnopqrstuv|zyxwvutsrqp|mnopqrstuvw/);
});

test('verified file downloads use opaque job and numeric file identifiers', async (t) => {
  const port = await freePort();
  const jobId = '00000000-0000-4000-8000-000000000000';
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'playlist-download-route-'));
  const mediaPath = path.join(temporaryDirectory, 'verified.mkv');
  await fs.writeFile(mediaPath, 'verified media fixture');
  t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
  const jobs = {
    async initialize() {},
    getSnapshot: () => null,
    getDownloadFile: async (candidateJobId, index) => (
      candidateJobId === jobId && index === 0
        ? { path: mediaPath, name: '001 - Verified track.mkv', size: 22 }
        : null
    ),
    subscribe: () => () => {},
    async shutdown() {},
  };
  const runtime = await startServer({ port, jobs });
  t.after(() => runtime.stop());

  const downloaded = await request(port, { route: `/api/jobs/${jobId}/files/0` });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.body, 'verified media fixture');
  assert.match(downloaded.headers['content-disposition'], /^attachment;/);
  assert.match(downloaded.headers['cache-control'], /no-store/);

  const invalidIndex = await request(port, { route: `/api/jobs/${jobId}/files/..%2F0` });
  assert.equal(invalidIndex.status, 404);
});

test('job manager resolves only verified regular media inside its output directory', async (t) => {
  const jobId = '00000000-0000-4000-8000-000000000000';
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'playlist-download-file-'));
  const mediaName = '001 - [abcdefghijk] Verified track.mkv';
  await fs.writeFile(path.join(temporaryDirectory, mediaName), 'verified media fixture');
  t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));

  const jobs = Object.create(JobManager.prototype);
  jobs.rootReal = temporaryDirectory;
  jobs.job = {
    id: jobId,
    outputDirectory: temporaryDirectory,
    files: [{ name: mediaName, verified: true }],
  };

  const file = await jobs.getDownloadFile(jobId, 0);
  assert.equal(file.name, '001 - Verified track.mkv');
  assert.equal(path.basename(file.path), mediaName);
  assert.equal(await fs.readFile(file.path, 'utf8'), 'verified media fixture');
  assert.equal(await jobs.getDownloadFile('11111111-1111-4111-8111-111111111111', 0), null);
  jobs.job.files[0] = { name: '../outside.mkv', verified: true };
  assert.equal(await jobs.getDownloadFile(jobId, 0), null);
});

test('HTTP boundary blocks hostile hosts/origins and requires a launch token before parsing JSON', async (t) => {
  const port = await freePort();
  let starts = 0;
  const snapshot = {
    id: '00000000-0000-4000-8000-000000000000', status: 'preparing', message: 'Reading playlist details',
    playlistTitle: '', totalItems: 0, completedItems: 0, overallPercent: 0, pass: 0,
    destination: 'downloads\\PL1234567890', quality: 'best', current: {}, items: [], files: [],
    verification: { status: 'pending', checked: 0, total: 0, valid: 0, invalidCount: 0, missingCount: 0, partialCount: 0 }, error: null,
  };
  const jobs = {
    async initialize() {},
    getSnapshot: () => snapshot,
    start: () => { starts += 1; return snapshot; },
    cancel: () => snapshot,
    subscribe: () => () => {},
    async shutdown() {},
  };
  const runtime = await startServer({ port, jobs });
  t.after(() => runtime.stop());
  const origin = `http://127.0.0.1:${port}`;

  const hostileHost = await request(port, { route: '/api/health', host: `attacker.example:${port}`, origin: `http://attacker.example:${port}` });
  assert.equal(hostileHost.status, 421);

  const foreignOrigin = await request(port, { route: '/api/health', origin: 'http://attacker.example' });
  assert.equal(foreignOrigin.status, 403);

  const health = await request(port, { route: '/api/health' });
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).downloadsRoot, undefined);
  assert.equal(health.headers['x-content-type-options'], 'nosniff');
  assert.match(health.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(health.headers['access-control-allow-origin'], undefined);

  const config = await request(port, { route: '/api/config', host: `localhost:${port}` });
  assert.equal(config.status, 200);
  assert.match(config.headers['cache-control'], /no-store/);
  assert.equal(config.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
  const configBody = JSON.parse(config.body);
  const { csrfToken } = configBody;
  assert.ok(csrfToken.length >= 32);
  assert.equal(typeof configBody.appName, 'string');
  assert.ok(['best', '1080', '720'].includes(configBody.defaultQuality));
  assert.deepEqual(configBody.formats.map(({ value }) => value), ['best', '1080', '720']);
  assert.equal(path.isAbsolute(configBody.destinationRoot), false);
  assert.ok(configBody.limits.maxPlaylistItems > 0);
  assert.ok(configBody.limits.maxBatchItems > 0);

  const event = await firstServerEvent(port, snapshot.id);
  assert.equal(event.status, 200);
  assert.match(event.headers['content-type'], /text\/event-stream/);
  assert.deepEqual(JSON.parse(event.body.match(/data: (.+)\n/)?.[1]), snapshot);

  const noOrigin = await request(port, { method: 'POST', route: '/api/download', token: csrfToken, body: '{}' });
  assert.equal(noOrigin.status, 403);
  const wrongContentType = await request(port, {
    method: 'POST', route: '/api/download', origin, token: csrfToken, body: '{}', contentType: 'text/plain',
  });
  assert.equal(wrongContentType.status, 415);
  const wrongToken = await request(port, { method: 'POST', route: '/api/download', origin, token: 'x'.repeat(43), body: '{not json' });
  assert.equal(wrongToken.status, 403);
  assert.equal(starts, 0);

  const malformed = await request(port, { method: 'POST', route: '/api/download', origin, token: csrfToken, body: '{not json' });
  assert.equal(malformed.status, 400);
  assert.equal(starts, 0);

  const accepted = await request(port, {
    method: 'POST', route: '/api/download', origin, token: csrfToken,
    body: JSON.stringify({ url: 'https://www.youtube.com/playlist?list=PL1234567890', quality: 'best' }),
  });
  assert.equal(accepted.status, 202);
  assert.equal(starts, 1);

  const staleCancel = await request(port, {
    method: 'POST', route: '/api/cancel', origin, token: csrfToken,
    body: JSON.stringify({ jobId: '11111111-1111-4111-8111-111111111111' }),
  });
  assert.equal(staleCancel.status, 409);
  const devOriginCancel = await request(port, {
    method: 'POST', route: '/api/cancel', origin: 'http://localhost:5173', token: csrfToken,
    body: JSON.stringify({ jobId: snapshot.id }),
  });
  assert.equal(devOriginCancel.status, 200);
});
