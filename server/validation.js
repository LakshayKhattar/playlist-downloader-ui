import path from 'node:path';
import { DEFAULT_QUALITY } from './config.js';
import { isQualityProfile } from './quality.js';

const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'music.youtube.com',
  'm.youtube.com',
  'youtu.be',
]);
const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,100}$/;
const MAX_URL_LENGTH = 2048;

export function parsePlaylistUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('A playlist URL is required.');
  }
  if (value.length > MAX_URL_LENGTH || /[\r\n\0]/.test(value)) {
    throw new Error('The playlist URL is too long or contains invalid characters.');
  }

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('Enter a valid YouTube playlist URL.');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Use an HTTPS YouTube playlist URL.');
  }
  if (parsed.username || parsed.password || parsed.port || !ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('Only standard YouTube and YouTube Music playlist URLs are supported.');
  }

  const playlistId = parsed.searchParams.get('list');
  if (!playlistId || !PLAYLIST_ID.test(playlistId)) {
    throw new Error('The URL must include a valid YouTube playlist ID.');
  }

  return {
    url: `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`,
    playlistId,
  };
}

export function parseDownloadRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('A JSON request body is required.');
  }
  if (Object.keys(body).some((key) => !['url', 'quality'].includes(key))) {
    throw new Error('The request contains an unsupported field.');
  }
  const playlist = parsePlaylistUrl(body.url);
  const quality = body.quality ?? DEFAULT_QUALITY;
  if (!isQualityProfile(quality)) {
    throw new Error('Choose a supported download format.');
  }
  return { ...playlist, quality };
}

export function safeFolderName(value) {
  if (!PLAYLIST_ID.test(value)) throw new Error('Invalid playlist folder identifier.');
  return value;
}

export function isPathInside(root, candidate) {
  const normalize = process.platform === 'win32'
    ? (value) => path.resolve(value).toLowerCase()
    : (value) => path.resolve(value);
  const relative = path.relative(normalize(root), normalize(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
