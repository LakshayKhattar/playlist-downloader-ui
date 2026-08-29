import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_QUALITY,
  DOWNLOADS_ROOT,
  normalizePublicUrl,
  renderPublicUrl,
} from '../server/config.js';
import { isQualityProfile, publicQualityOptions } from '../server/quality.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configUrl = pathToFileURL(path.join(projectRoot, 'server', 'config.js')).href;

function importConfig(overrides) {
  const environment = { ...process.env };
  for (const name of ['ALLOW_REMOTE_ACCESS', 'APP_AUTH_PASSWORD', 'APP_PUBLIC_URL', 'BIND_HOST', 'RENDER_EXTERNAL_HOSTNAME']) {
    delete environment[name];
  }
  Object.assign(environment, overrides);
  return spawnSync(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(configUrl)});`], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: environment,
  });
}

test('runtime metadata and default profile are valid', () => {
  assert.ok(APP_NAME.length > 0);
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+/);
  assert.equal(path.isAbsolute(DOWNLOADS_ROOT), true);
  assert.equal(isQualityProfile(DEFAULT_QUALITY), true);
  assert.deepEqual(publicQualityOptions().map(({ value }) => value), ['best', '1080', '720']);
});

test('public URL accepts exact HTTPS origins and local HTTP staging only', () => {
  assert.equal(normalizePublicUrl(''), '');
  assert.equal(normalizePublicUrl('https://downloads.example.com'), 'https://downloads.example.com');
  assert.equal(normalizePublicUrl('https://downloads.example.com:8443/'), 'https://downloads.example.com:8443');
  assert.equal(normalizePublicUrl('http://127.0.0.1:4173'), 'http://127.0.0.1:4173');
  assert.throws(() => normalizePublicUrl('http://downloads.example.com'), /HTTPS origin/);
  assert.throws(() => normalizePublicUrl('https://downloads.example.com/app'), /HTTPS origin/);
  assert.throws(() => normalizePublicUrl('https://user:pass@downloads.example.com'), /HTTPS origin/);
  assert.equal(renderPublicUrl('playlist-downloader-ui.onrender.com'), 'https://playlist-downloader-ui.onrender.com');
  assert.throws(() => renderPublicUrl('https://playlist-downloader-ui.onrender.com'), /valid hostname/);
});

test('remote binding fails closed unless origin and authentication are configured', () => {
  const missingAuthentication = importConfig({
    ALLOW_REMOTE_ACCESS: 'true',
    BIND_HOST: '0.0.0.0',
    RENDER_EXTERNAL_HOSTNAME: 'playlist-downloader-ui.onrender.com',
  });
  assert.notEqual(missingAuthentication.status, 0);
  assert.match(missingAuthentication.stderr, /requires APP_AUTH_PASSWORD/);

  const publicBindWithoutOptIn = importConfig({ BIND_HOST: '0.0.0.0' });
  assert.notEqual(publicBindWithoutOptIn.status, 0);
  assert.match(publicBindWithoutOptIn.stderr, /only when ALLOW_REMOTE_ACCESS=true/);

  const insecureRemoteOrigin = importConfig({
    ALLOW_REMOTE_ACCESS: 'true',
    APP_AUTH_PASSWORD: 'a-strong-render-password',
    APP_PUBLIC_URL: 'http://127.0.0.1:4173',
    BIND_HOST: '0.0.0.0',
  });
  assert.notEqual(insecureRemoteOrigin.status, 0);
  assert.match(insecureRemoteOrigin.stderr, /requires an HTTPS public URL/);

  const configured = importConfig({
    ALLOW_REMOTE_ACCESS: 'true',
    APP_AUTH_PASSWORD: 'a-strong-render-password',
    BIND_HOST: '0.0.0.0',
    RENDER_EXTERNAL_HOSTNAME: 'playlist-downloader-ui.onrender.com',
  });
  assert.equal(configured.status, 0, configured.stderr);
});

test('batch size is fixed at twenty videos', () => {
  const invalidBatchLimit = importConfig({
    MAX_BATCH_ITEMS: '10',
  });
  assert.notEqual(invalidBatchLimit.status, 0);
  assert.match(invalidBatchLimit.stderr, /MAX_BATCH_ITEMS/);
});
