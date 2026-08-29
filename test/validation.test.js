import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_QUALITY } from '../server/config.js';
import {
  isPathInside,
  parseDownloadRequest,
  parsePlaylistUrl,
  safeFolderName,
} from '../server/validation.js';

const MUSIC_URL = 'https://music.youtube.com/playlist?list=RDCLAK5uy_lj-zBExVYl7YN_NxXboDIh4A-wKGfgzNY';

test('accepts and canonicalizes an HTTPS YouTube Music playlist URL', () => {
  const parsed = parsePlaylistUrl(`${MUSIC_URL}&feature=share#ignored`);
  assert.equal(parsed.playlistId, 'RDCLAK5uy_lj-zBExVYl7YN_NxXboDIh4A-wKGfgzNY');
  assert.equal(parsed.url, 'https://www.youtube.com/playlist?list=RDCLAK5uy_lj-zBExVYl7YN_NxXboDIh4A-wKGfgzNY');
});

test('rejects non-HTTPS, credentials, ports, foreign hosts, and missing playlist IDs', () => {
  assert.throws(() => parsePlaylistUrl('http://www.youtube.com/playlist?list=PL1234567890'), /HTTPS/);
  assert.throws(() => parsePlaylistUrl('https://user:pass@www.youtube.com/playlist?list=PL1234567890'), /standard YouTube/);
  assert.throws(() => parsePlaylistUrl('https://www.youtube.com:444/playlist?list=PL1234567890'), /standard YouTube/);
  assert.throws(() => parsePlaylistUrl('https://youtube.com.example/playlist?list=PL1234567890'), /standard YouTube/);
  assert.throws(() => parsePlaylistUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), /playlist ID/);
  assert.throws(() => parsePlaylistUrl('file:///tmp/video'), /HTTPS/);
});

test('rejects control characters and oversized URLs', () => {
  assert.throws(() => parsePlaylistUrl(`${MUSIC_URL}\nignored`), /invalid characters/);
  assert.throws(() => parsePlaylistUrl(`${MUSIC_URL}&x=${'a'.repeat(2100)}`), /too long/);
});

test('accepts only the supported request schema and quality profiles', () => {
  assert.equal(parseDownloadRequest({ url: MUSIC_URL }).quality, DEFAULT_QUALITY);
  assert.equal(parseDownloadRequest({ url: MUSIC_URL, quality: '1080' }).quality, '1080');
  assert.equal(parseDownloadRequest({ url: MUSIC_URL, quality: '720' }).quality, '720');
  assert.throws(() => parseDownloadRequest({ url: MUSIC_URL, quality: 'audio' }), /supported download format/);
  assert.throws(() => parseDownloadRequest({ url: MUSIC_URL, destination: 'C:\\' }), /unsupported field/);
  assert.throws(() => parseDownloadRequest(null), /JSON request body/);
});

test('playlist folders are validated rather than rewritten', () => {
  assert.equal(safeFolderName('PL-good_ID-123'), 'PL-good_ID-123');
  assert.throws(() => safeFolderName('PL-good_ID../bad'), /Invalid playlist folder/);
});

test('path containment accepts the root and descendants but rejects traversal and siblings', () => {
  const root = path.resolve('test-root');
  assert.equal(isPathInside(root, root), true);
  assert.equal(isPathInside(root, path.join(root, 'playlist', 'file.mkv')), true);
  assert.equal(isPathInside(root, path.resolve(root, '..', 'sibling')), false);
  assert.equal(isPathInside(root, `${root}-lookalike`), false);
});
