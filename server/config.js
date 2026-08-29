import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { isQualityProfile } from './quality.js';

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(serverDirectory, '..');

dotenv.config({ path: path.join(APP_ROOT, '.env'), quiet: true });

const packageMetadata = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));

function integerSetting(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must contain digits only.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function booleanSetting(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be either true or false.`);
}

function textSetting(name, fallback, { maxLength = 80, pattern } = {}) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : raw.trim();
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must be from 1 to ${maxLength} visible characters.`);
  }
  if (pattern && !pattern.test(value)) throw new Error(`${name} contains unsupported characters.`);
  return value;
}

function optionalHttpsUrl(name, fallback = '') {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : raw.trim();
  if (!value) return '';
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL.`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || value.length > 2048) {
    throw new Error(`${name} must be a standard HTTPS URL without credentials.`);
  }
  return parsed.href;
}

function optionalSecretSetting(name) {
  const value = process.env[name] || '';
  if (!value) return '';
  if (value.length < 24 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must be from 24 to 256 characters and contain no control characters.`);
  }
  return value;
}

export function normalizePublicUrl(value) {
  if (value === undefined || value === null || String(value).trim() === '') return '';
  let parsed;
  try {
    parsed = new URL(String(value).trim());
  } catch {
    throw new Error('APP_PUBLIC_URL must be a valid URL origin.');
  }
  const localHttp = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname.toLowerCase());
  if ((parsed.protocol !== 'https:' && !localHttp) || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('APP_PUBLIC_URL must be an HTTPS origin with no path, query, fragment, or credentials.');
  }
  return parsed.origin;
}

export function renderPublicUrl(hostname) {
  const value = String(hostname || '').trim().toLowerCase();
  if (!value) return '';
  if (value.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value)) {
    throw new Error('RENDER_EXTERNAL_HOSTNAME must be a valid hostname.');
  }
  return `https://${value}`;
}

function absoluteDirectorySetting(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!path.isAbsolute(raw)) throw new Error(`${name} must be an absolute path.`);
  return path.resolve(raw);
}

function resolveExecutable(name, configuredPath) {
  if (configuredPath) {
    if (!path.isAbsolute(configuredPath)) throw new Error(`${name} path must be absolute.`);
    const resolved = path.resolve(configuredPath);
    if (!fs.statSync(resolved).isFile()) throw new Error(`${name} was not found at the configured path.`);
    return resolved;
  }

  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const output = execFileSync(locator, [name], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const first = output.split(/\r?\n/).map((value) => value.trim()).find(Boolean);
  if (!first || !path.isAbsolute(first) || !fs.statSync(first).isFile()) {
    throw new Error(`${name} could not be resolved to an installed executable.`);
  }
  return path.resolve(first);
}

function packageRepositoryUrl() {
  const repository = typeof packageMetadata.repository === 'string'
    ? packageMetadata.repository
    : packageMetadata.repository?.url;
  if (!repository) return '';
  return repository.replace(/^git\+/, '').replace(/\.git$/, '');
}

export const APP_NAME = textSetting('APP_NAME', 'Playlist Downloader', { maxLength: 64 });
export const APP_VERSION = packageMetadata.version;
export const APP_REPOSITORY_URL = optionalHttpsUrl('APP_REPOSITORY_URL', packageRepositoryUrl());
export const APP_PUBLIC_URL = normalizePublicUrl(
  process.env.APP_PUBLIC_URL || renderPublicUrl(process.env.RENDER_EXTERNAL_HOSTNAME),
);
export const ALLOW_REMOTE_ACCESS = booleanSetting('ALLOW_REMOTE_ACCESS');
export const HOST = textSetting('BIND_HOST', ALLOW_REMOTE_ACCESS ? '0.0.0.0' : '127.0.0.1', {
  maxLength: 15,
  pattern: /^(?:127\.0\.0\.1|0\.0\.0\.0)$/,
});
export const PORT = integerSetting('PORT', 4173, { min: 1024, max: 65535 });
export const DEV_PORT = integerSetting('DEV_PORT', 5173, { min: 1024, max: 65535 });
export const APP_AUTH_USERNAME = textSetting('APP_AUTH_USERNAME', 'playlist', {
  maxLength: 64,
  pattern: /^[A-Za-z0-9._-]+$/,
});
export const APP_AUTH_PASSWORD = optionalSecretSetting('APP_AUTH_PASSWORD');
export const AUTHENTICATION_ENABLED = Boolean(APP_AUTH_PASSWORD);
export const DOWNLOADS_ROOT = absoluteDirectorySetting(
  'PLAYLIST_DOWNLOADS_ROOT',
  path.join(APP_ROOT, 'downloads'),
);
export const DOWNLOADS_LABEL = textSetting('DOWNLOADS_LABEL', 'downloads', {
  maxLength: 64,
  pattern: /^[A-Za-z0-9 ._-]+$/,
});
export const MAX_PLAYLIST_ITEMS = integerSetting('MAX_PLAYLIST_ITEMS', 500, { min: 1, max: 2000 });
export const MAX_TOTAL_DURATION_SECONDS = integerSetting('MAX_TOTAL_DURATION_SECONDS', 72 * 60 * 60, { min: 60, max: 30 * 24 * 60 * 60 });
export const MAX_DOWNLOAD_BYTES = integerSetting('MAX_DOWNLOAD_BYTES', 80 * 1024 ** 3, { min: 1024 ** 3, max: 500 * 1024 ** 3 });
export const MIN_FREE_BYTES = integerSetting('MIN_FREE_BYTES', 4 * 1024 ** 3, { min: 512 * 1024 ** 2, max: 100 * 1024 ** 3 });
export const MAX_JOB_RUNTIME_MS = integerSetting('MAX_JOB_RUNTIME_MS', 24 * 60 * 60 * 1000, { min: 60_000, max: 7 * 24 * 60 * 60 * 1000 });
export const DOWNLOAD_INACTIVITY_MS = integerSetting('DOWNLOAD_INACTIVITY_MS', 15 * 60 * 1000, { min: 60_000, max: 60 * 60 * 1000 });
export const MAX_DOWNLOAD_PASSES = integerSetting('MAX_DOWNLOAD_PASSES', 3, { min: 1, max: 5 });
export const MAX_SSE_CLIENTS = integerSetting('MAX_SSE_CLIENTS', 4, { min: 1, max: 20 });
export const DEFAULT_QUALITY = (() => {
  const value = process.env.DEFAULT_QUALITY || 'best';
  if (!isQualityProfile(value)) throw new Error('DEFAULT_QUALITY must be best, 1080, or 720.');
  return value;
})();

if (ALLOW_REMOTE_ACCESS) {
  if (HOST !== '0.0.0.0') throw new Error('Remote access requires BIND_HOST=0.0.0.0.');
  if (!APP_PUBLIC_URL) throw new Error('Remote access requires APP_PUBLIC_URL or RENDER_EXTERNAL_HOSTNAME.');
  if (new URL(APP_PUBLIC_URL).protocol !== 'https:') throw new Error('Remote access requires an HTTPS public URL.');
  if (!AUTHENTICATION_ENABLED) throw new Error('Remote access requires APP_AUTH_PASSWORD.');
} else if (HOST !== '127.0.0.1') {
  throw new Error('BIND_HOST can be public only when ALLOW_REMOTE_ACCESS=true.');
}

export function resolveToolchain() {
  const ytDlp = resolveExecutable('yt-dlp', process.env.YT_DLP_BIN);
  const ffprobe = resolveExecutable('ffprobe', process.env.FFPROBE_BIN);
  const ffmpeg = resolveExecutable('ffmpeg', process.env.FFMPEG_BIN);
  return { ytDlp, ffprobe, ffmpeg };
}
