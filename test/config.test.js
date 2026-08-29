import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_QUALITY,
  DOWNLOADS_ROOT,
  normalizePublicUrl,
} from '../server/config.js';
import { isQualityProfile, publicQualityOptions } from '../server/quality.js';

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
});
