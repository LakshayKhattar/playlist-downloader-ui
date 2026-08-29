import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DOWNLOADS_ROOT,
  DOWNLOADS_LABEL,
  DOWNLOAD_INACTIVITY_MS,
  MAX_DOWNLOAD_BYTES,
  MAX_DOWNLOAD_PASSES,
  MAX_JOB_RUNTIME_MS,
  MAX_PLAYLIST_ITEMS,
  MAX_TOTAL_DURATION_SECONDS,
  MIN_FREE_BYTES,
} from './config.js';
import { QUALITY_PROFILES } from './quality.js';
import { createLineReader, parseDownloaderLine } from './progress.js';
import { runCapture, runStreaming } from './processes.js';
import { isPathInside, parseDownloadRequest, safeFolderName } from './validation.js';

const ACTIVE_STATES = new Set(['preparing', 'downloading', 'retrying', 'verifying', 'canceling']);
const MEDIA_EXTENSIONS = new Set(['.mkv', '.mp4', '.webm', '.mov']);
const FINAL_EXTENSION = '.mkv';
const MAX_SINGLE_FILE_BYTES = Math.min(20 * 1024 ** 3, MAX_DOWNLOAD_BYTES);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

class PublicJobError extends Error {
  constructor(publicMessage, diagnostic = publicMessage) {
    super(diagnostic);
    this.name = 'PublicJobError';
    this.publicMessage = publicMessage;
  }
}

function clone(value) {
  return structuredClone(value);
}

function cleanText(value, fallback = '') {
  const text = typeof value === 'string' ? value : fallback;
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function uniqueEntries(entries = [], fallbackStart = 1) {
  const found = new Set();
  return entries.flatMap((entry, offset) => {
    if (!entry || !VIDEO_ID.test(entry.id || '') || found.has(entry.id)) return [];
    found.add(entry.id);
    return [{
      id: entry.id,
      index: Number.isSafeInteger(Number(entry.playlist_index))
        ? Math.max(1, Number(entry.playlist_index))
        : fallbackStart + offset,
      title: cleanText(entry.title, entry.id),
      duration: Number.isFinite(Number(entry.duration)) && Number(entry.duration) >= 0
        ? Number(entry.duration)
        : null,
      live: Boolean(entry.is_live) || ['is_live', 'is_upcoming'].includes(entry.live_status),
    }];
  });
}

export function idFromFilename(filename) {
  return filename.match(/^\d{1,6}\s+-\s+\[([A-Za-z0-9_-]{11})\]\s/)?.[1]
    || filename.match(/\[([A-Za-z0-9_-]{11})\](?=(?:\.[^.]+)+$)/)?.[1]
    || null;
}

export function indexFromFilename(filename) {
  const value = Number.parseInt(filename.match(/^(\d{1,6})\s+-\s+/)?.[1] || '', 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function publicFileName(name) {
  if (typeof name !== 'string') return 'Downloaded file';
  return name
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/^(\d{1,6}\s+-\s+)\[[A-Za-z0-9_-]{11}\]\s*/, '$1')
    .replace(/\s*\[[A-Za-z0-9_-]{11}\](?=(?:\.[^.]+)+$)/, '')
    .replace(/\s*\[[A-Za-z0-9_-]{11}(?=(?:\.[^.]+)+$)/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240) || 'Downloaded file';
}

export function buildPreflightArgs(url, { startIndex = 1, endIndex = MAX_PLAYLIST_ITEMS } = {}) {
  const probeEnd = Math.min(MAX_PLAYLIST_ITEMS, endIndex + 1);
  return [
    '--ignore-config',
    '--flat-playlist',
    '--dump-single-json',
    '--ignore-errors',
    '--no-warnings',
    '--no-cache-dir',
    '--encoding', 'utf-8',
    '--js-runtimes', 'node',
    '--no-remote-components',
    '--no-plugin-dirs',
    '--ies', 'youtube:tab,youtube',
    '--playlist-start', String(startIndex),
    '--playlist-end', String(probeEnd),
    url,
  ];
}

export function buildDownloadArgs({
  url,
  outputDirectory,
  archivePath,
  quality = 'best',
  ffmpegPath,
  startIndex = 1,
  endIndex = MAX_PLAYLIST_ITEMS,
}) {
  const outputTemplate = path.join(
    outputDirectory,
    '%(playlist_index)03d - [%(id)s] %(title).140B.%(ext)s',
  );
  const format = QUALITY_PROFILES[quality]?.format;
  if (!format) throw new Error('Unsupported quality profile.');

  const args = [
    '--ignore-config', '--yes-playlist', '--concat-playlist', 'never', '--no-simulate', '--continue',
    '--no-overwrites', '--no-abort-on-error', '--abort-on-unavailable-fragments', '--check-formats',
    '--match-filter', '!is_live',
    '--playlist-start', String(startIndex), '--playlist-end', String(endIndex),
    '--max-downloads', String(Math.max(1, endIndex - startIndex + 1)),
    '--max-filesize', String(MAX_SINGLE_FILE_BYTES), '--retries', '20', '--fragment-retries', '20',
    '--extractor-retries', '10', '--file-access-retries', '10',
    '--retry-sleep', 'http:exp=1:20', '--retry-sleep', 'fragment:exp=1:20',
    '--retry-sleep', 'extractor:exp=1:20', '--socket-timeout', '30', '--concurrent-fragments', '4',
    '--encoding', 'utf-8', '--js-runtimes', 'node', '--no-remote-components', '--no-plugin-dirs',
    '--no-cache-dir', '--ies', 'youtube:tab,youtube', '--color', 'stdout:never', '--color', 'stderr:never',
    '--download-archive', archivePath, '--windows-filenames', '--trim-filenames', '220', '--no-mtime',
    '--embed-metadata', '--embed-chapters', '--format', format, '--merge-output-format', 'mkv',
    '--remux-video', 'mkv', '--output', outputTemplate,
    '--print', 'video:APP_ITEM_JSON|%(.{id,title,playlist_index,playlist_count,duration,format_id})j',
    '--print', 'after_move:APP_FILE_JSON|%(.{id,title,playlist_index,playlist_count,duration,filepath,ext})j',
    '--progress-template', 'download:APP_PROGRESS_JSON|%(.{info.id,info.title,info.playlist_index,info.playlist_count,progress.status,progress.downloaded_bytes,progress.total_bytes,progress.total_bytes_estimate,progress.elapsed,progress.eta,progress.speed,progress.filename,progress.tmpfilename,progress.fragment_index,progress.fragment_count})j',
    '--progress-template', 'postprocess:APP_POST_JSON|%(.{info.id,info.title,info.playlist_index,info.filepath,progress.status,progress.postprocessor})j',
    '--progress', '--newline', '--progress-delta', '0.75',
  ];
  if (ffmpegPath) args.push('--ffmpeg-location', path.dirname(ffmpegPath));
  args.push(url);
  return args;
}

async function assertNormalDirectory(directory, expectedRoot) {
  const lexical = path.resolve(directory);
  if (!isPathInside(expectedRoot, lexical)) throw new Error('Unsafe download directory.');
  const stat = await fs.lstat(lexical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Download destination is not a regular directory.');
  const [realRoot, realDirectory] = await Promise.all([fs.realpath(expectedRoot), fs.realpath(lexical)]);
  if (!isPathInside(realRoot, realDirectory)) throw new Error('Download destination leaves the app storage directory.');
  return realDirectory;
}

async function assertNormalFileIfPresent(filePath, root) {
  if (!isPathInside(root, filePath)) throw new Error('Unsafe app data path.');
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('App data path is not a regular file.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function listMediaFiles(outputDirectory) {
  const entries = await fs.readdir(outputDirectory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const fullPath = path.join(outputDirectory, entry.name);
    if (!isPathInside(outputDirectory, fullPath)) continue;
    const stat = await fs.lstat(fullPath);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    files.push({
      name: entry.name,
      path: fullPath,
      size: stat.size,
      id: idFromFilename(entry.name),
      index: indexFromFilename(entry.name),
    });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

async function listPartialFiles(outputDirectory, expectedIndexes = null) {
  const entries = await fs.readdir(outputDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
    .filter((entry) => /\.part(?:$|-)/i.test(entry.name) || /\.ytdl$/i.test(entry.name))
    .filter((entry) => !expectedIndexes || expectedIndexes.has(indexFromFilename(entry.name)))
    .map((entry) => entry.name);
}

async function directoryBytes(outputDirectory) {
  const entries = await fs.readdir(outputDirectory, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const stat = await fs.lstat(path.join(outputDirectory, entry.name));
    total += stat.size;
    if (total > MAX_DOWNLOAD_BYTES) return total;
  }
  return total;
}

async function checkStorage(outputDirectory) {
  const used = await directoryBytes(outputDirectory);
  if (used > MAX_DOWNLOAD_BYTES) {
    throw new PublicJobError(`This playlist folder reached the configured ${MAX_DOWNLOAD_BYTES / (1024 ** 3)} GiB safety limit.`);
  }
  if (typeof fs.statfs === 'function') {
    const disk = await fs.statfs(outputDirectory);
    const available = Number(disk.bavail) * Number(disk.bsize);
    if (Number.isFinite(available) && available < MIN_FREE_BYTES) {
      throw new PublicJobError(`Download stopped because less than ${MIN_FREE_BYTES / (1024 ** 3)} GiB of free disk space remains.`);
    }
  }
}

async function removeMissingIdsFromArchive(archivePath, missingIds, outputDirectory) {
  if (!missingIds.size) return;
  await assertNormalFileIfPresent(archivePath, outputDirectory);
  try {
    const content = await fs.readFile(archivePath, 'utf8');
    const kept = content.split(/\r?\n/).filter(Boolean)
      .filter((line) => !missingIds.has(line.trim().split(/\s+/).at(-1))).join('\n');
    await fs.writeFile(archivePath, kept ? `${kept}\n` : '', { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function inspectMedia(file, expectedEntry, tools, signal) {
  try {
    const result = await runCapture(tools.ffprobe, [
      '-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file.path,
    ], { timeoutMs: 60_000, maxOutput: 1_000_000, signal, cwd: path.dirname(file.path) });
    if (result.code !== 0) return { ...file, verified: false, reason: 'ffprobe could not read the file.' };
    const data = JSON.parse(result.stdout);
    const duration = Number.parseFloat(data.format?.duration);
    const streamTypes = new Set((data.streams || []).map((stream) => stream.codec_type));
    const expectedDuration = expectedEntry?.duration;
    const tolerance = Number.isFinite(expectedDuration) ? Math.max(5, expectedDuration * 0.02) : null;
    const durationMatches = tolerance === null || Math.abs(duration - expectedDuration) <= tolerance;
    const extensionMatches = path.extname(file.name).toLowerCase() === FINAL_EXTENSION;
    const verified = Boolean(expectedEntry) && extensionMatches && Number.isFinite(duration) && duration > 0
      && streamTypes.has('video') && streamTypes.has('audio') && durationMatches;
    let reason = null;
    if (!expectedEntry) reason = 'File does not match this playlist.';
    else if (!extensionMatches) reason = 'Final file is not MKV.';
    else if (!durationMatches) reason = 'Media duration does not match playlist metadata.';
    else if (!verified) reason = 'A readable video and audio stream were not both found.';
    return { ...file, verified, duration: Number.isFinite(duration) ? duration : null, reason };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return { ...file, verified: false, reason: 'Media inspection failed.' };
  }
}

async function readArchiveIds(archivePath, outputDirectory) {
  await assertNormalFileIfPresent(archivePath, outputDirectory);
  try {
    const content = await fs.readFile(archivePath, 'utf8');
    return new Set(content.split(/\r?\n/).filter(Boolean).map((line) => line.trim().split(/\s+/).at(-1)));
  } catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw error;
  }
}

async function assessOutput(outputDirectory, expected, archivePath, tools, signal) {
  const expectedById = new Map(expected.map((entry) => [entry.id, entry]));
  const expectedByIndex = new Map(expected.map((entry) => [entry.index, entry]));
  const files = (await listMediaFiles(outputDirectory)).filter((file) => (
    expectedById.has(file.id) || expectedByIndex.has(file.index)
  ));
  const inspected = [];
  const validIds = new Set();
  for (const file of files) {
    const matchedEntry = expectedById.get(file.id) || expectedByIndex.get(file.index);
    const result = await inspectMedia(file, matchedEntry, tools, signal);
    if (result.verified) result.id = matchedEntry.id;
    if (result.verified && validIds.has(file.id)) {
      result.verified = false;
      result.reason = 'Duplicate final file.';
    } else if (result.verified) validIds.add(file.id);
    inspected.push(result);
  }
  const archiveIds = await readArchiveIds(archivePath, outputDirectory);
  const partialFiles = await listPartialFiles(outputDirectory, new Set(expectedByIndex.keys()));
  return {
    inspected,
    validIds,
    missing: expected.filter((entry) => !validIds.has(entry.id)),
    archiveMissing: expected.filter((entry) => !archiveIds.has(entry.id)),
    partialFiles,
  };
}

async function preserveInvalidFiles(files, missingIds, recoveryDirectory, root) {
  const candidates = files.filter((file) => file.id && missingIds.has(file.id) && !file.verified);
  if (!candidates.length) return;
  if (!isPathInside(root, recoveryDirectory)) throw new Error('Unsafe recovery directory.');
  await fs.mkdir(recoveryDirectory, { recursive: true, mode: 0o700 });
  await assertNormalDirectory(recoveryDirectory, root);
  for (const file of candidates) {
    if (!isPathInside(root, file.path)) continue;
    await fs.rename(file.path, path.join(recoveryDirectory, `${Date.now()}-${file.name}`));
  }
}

export function toPublicJob(job) {
  if (!job) return null;
  const publicFiles = job.files.map(({ name, size, verified }, index) => ({
    name: publicFileName(name),
    index: indexFromFilename(name) || index + 1,
    size,
    verified,
    downloadUrl: verified === true
      ? `/api/jobs/${encodeURIComponent(job.id)}/files/${index}`
      : null,
  }));
  return clone({
    id: job.id,
    status: job.status,
    message: job.message,
    playlistTitle: job.playlistTitle,
    totalItems: job.totalItems,
    completedItems: job.completedItems,
    overallPercent: job.overallPercent,
    pass: job.pass,
    destination: job.destination,
    quality: job.quality,
    batch: job.batch ? {
      start: job.batch.start,
      end: job.batch.end,
      requestedSize: job.batch.requestedSize,
      hasMore: job.batch.hasMore,
      nextStart: job.batch.nextStart,
      unavailableCount: job.batch.unavailableCount,
    } : null,
    completedBatches: (job.completedBatches || []).map(({ start, end }) => ({ start, end })),
    current: job.current,
    items: job.items.map(({ id: _id, ...item }) => item),
    files: publicFiles,
    verification: {
      status: job.verification.status,
      checked: job.verification.checked,
      total: job.verification.total,
      valid: job.verification.valid,
      invalidCount: job.verification.invalidCount,
      missingCount: job.verification.missingCount,
      partialCount: job.verification.partialCount,
    },
    error: job.error,
  });
}

export class JobManager {
  constructor({ tools } = {}) {
    if (!tools?.ytDlp || !tools?.ffprobe || !tools?.ffmpeg) throw new Error('The verified media toolchain is required.');
    this.tools = tools;
    this.root = DOWNLOADS_ROOT;
    this.rootReal = null;
    this.job = null;
    this.listeners = new Set();
    this.abortController = null;
    this.runPromise = null;
    this.lockPath = null;
    this.resourceError = null;
    this.completedBatches = new Map();
  }

  async initialize() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    this.rootReal = await assertNormalDirectory(this.root, this.root);
  }

  getSnapshot() {
    return toPublicJob(this.job);
  }

  async getDownloadFile(jobId, fileIndex) {
    if (!this.job || jobId !== this.job.id || !Number.isSafeInteger(fileIndex) || fileIndex < 0) return null;
    const file = this.job.files[fileIndex];
    if (!file || file.verified !== true || typeof file.name !== 'string'
      || path.basename(file.name) !== file.name
      || !MEDIA_EXTENSIONS.has(path.extname(file.name).toLowerCase())) return null;

    const outputDirectory = await assertNormalDirectory(this.job.outputDirectory, this.rootReal);
    const candidate = path.resolve(outputDirectory, file.name);
    if (!isPathInside(outputDirectory, candidate)) return null;
    try {
      const stat = await fs.lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_SINGLE_FILE_BYTES) return null;
      const realFile = await fs.realpath(candidate);
      if (!isPathInside(outputDirectory, realFile)) return null;
      return { path: realFile, name: publicFileName(file.name), size: stat.size };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  update(patch) {
    if (!this.job) return;
    Object.assign(this.job, patch);
    this.emit();
  }

  setItem(identifier, patch) {
    const item = this.job?.items.find((candidate) => (
      (identifier.id && candidate.id === identifier.id)
      || (identifier.index && candidate.index === identifier.index)
    ));
    if (item) Object.assign(item, patch);
  }

  start(requestBody) {
    if (!this.rootReal) throw new Error('Download service is still starting.');
    if (this.runPromise || (this.job && ACTIVE_STATES.has(this.job.status))) {
      throw new PublicJobError('A playlist is already downloading.');
    }
    const { url, playlistId, quality, startIndex, batchSize, endIndex } = parseDownloadRequest(requestBody);
    const folder = safeFolderName(playlistId);
    const outputDirectory = path.join(this.rootReal, folder);
    if (!isPathInside(this.rootReal, outputDirectory)) throw new Error('Unsafe playlist destination.');
    this.job = {
      id: randomUUID(), url, playlistId, quality, playlistTitle: '', status: 'preparing',
      message: 'Reading playlist details', totalItems: 0, completedItems: 0, overallPercent: 0,
      destination: `${DOWNLOADS_LABEL}/${folder}`,
      batch: {
        start: startIndex, end: endIndex, requestedSize: batchSize,
        hasMore: null, nextStart: null, unavailableCount: 0,
      },
      completedBatches: clone(this.completedBatches.get(playlistId) || []),
      current: { index: 0, title: '', percent: null, speed: '', eta: '' },
      items: [], files: [],
      verification: { status: 'pending', checked: 0, total: 0, valid: 0, invalidCount: 0, missingCount: 0, partialCount: 0 },
      outputDirectory, pass: 0, error: null, startedAt: Date.now(),
    };
    this.abortController = new AbortController();
    this.resourceError = null;
    this.emit();
    this.runPromise = this.run()
      .catch((error) => this.fail(error))
      .finally(async () => {
        await this.releaseLock();
        this.runPromise = null;
      });
    return this.getSnapshot();
  }

  cancel() {
    if (!this.job || !ACTIVE_STATES.has(this.job.status)) throw new PublicJobError('There is no active download to cancel.');
    this.update({ status: 'canceling', message: 'Stopping safely; partial files will be kept for resume' });
    this.abortController?.abort(new DOMException('Canceled by user.', 'AbortError'));
    return this.getSnapshot();
  }

  async shutdown() {
    if (this.job && ACTIVE_STATES.has(this.job.status)) this.abortController?.abort(new DOMException('Service stopped.', 'AbortError'));
    if (this.runPromise) await this.runPromise.catch(() => {});
  }

  async acquireLock(outputDirectory) {
    this.lockPath = path.join(outputDirectory, '.playlist-downloader.lock');
    await assertNormalFileIfPresent(this.lockPath, outputDirectory);
    const create = async () => {
      const handle = await fs.open(this.lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, jobId: this.job.id }), 'utf8');
      } finally {
        await handle.close();
      }
    };
    try {
      await create();
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    let stale = false;
    try {
      const stat = await fs.lstat(this.lockPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
        throw new PublicJobError('This playlist folder contains an unsafe session lock.');
      }
      const lock = JSON.parse(await fs.readFile(this.lockPath, 'utf8'));
      if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) stale = true;
      else if (lock.pid === process.pid) stale = true;
      else {
        try {
          process.kill(lock.pid, 0);
        } catch (error) {
          if (error.code === 'ESRCH') stale = true;
          else if (error.code !== 'EPERM') throw error;
        }
      }
    } catch (error) {
      if (error instanceof PublicJobError) throw error;
      if (error instanceof SyntaxError) stale = true;
      else throw error;
    }
    if (!stale) throw new PublicJobError('This playlist folder is already in use by another downloader session.');
    await fs.unlink(this.lockPath);
    await create();
  }

  async releaseLock() {
    const lockPath = this.lockPath;
    this.lockPath = null;
    if (!lockPath) return;
    try {
      const content = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      if (content.jobId === this.job?.id && content.pid === process.pid) await fs.unlink(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Could not release playlist lock:', error.message);
    }
  }

  async run() {
    await fs.mkdir(this.job.outputDirectory, { recursive: true, mode: 0o700 });
    this.job.outputDirectory = await assertNormalDirectory(this.job.outputDirectory, this.rootReal);
    await this.acquireLock(this.job.outputDirectory);
    await checkStorage(this.job.outputDirectory);
    const archivePath = path.join(this.job.outputDirectory, '.download-archive.txt');
    await assertNormalFileIfPresent(archivePath, this.job.outputDirectory);

    const preflight = await runCapture(this.tools.ytDlp, buildPreflightArgs(this.job.url, {
      startIndex: this.job.batch.start,
      endIndex: this.job.batch.end,
    }), {
      timeoutMs: 180_000, maxOutput: 30_000_000, signal: this.abortController.signal,
      cwd: this.job.outputDirectory,
    });
    if (preflight.code !== 0 || !preflight.stdout.trim()) {
      throw new PublicJobError('The playlist could not be read. Check the URL and your internet connection.');
    }
    let playlist;
    try {
      playlist = JSON.parse(preflight.stdout);
    } catch {
      throw new PublicJobError('The playlist service returned data that could not be read.');
    }

    const rawEntries = Array.isArray(playlist.entries) ? playlist.entries : [];
    const batchEntries = rawEntries.slice(0, this.job.batch.requestedSize);
    const unavailableCount = batchEntries.filter((entry) => !entry || !VIDEO_ID.test(entry.id || '')).length;
    const expected = uniqueEntries(batchEntries, this.job.batch.start);
    if (!expected.length) throw new PublicJobError('No downloadable videos were found in this batch range.');
    if (expected.some((entry) => entry.live)) throw new PublicJobError('Live or upcoming streams cannot be downloaded by this app.');
    const knownDuration = expected.reduce((total, entry) => total + (entry.duration || 0), 0);
    if (knownDuration > MAX_TOTAL_DURATION_SECONDS) {
      throw new PublicJobError(`This batch exceeds the ${MAX_TOTAL_DURATION_SECONDS / 3600}-hour duration limit. Select a smaller batch size and retry.`);
    }
    const fallbackEnd = this.job.batch.start + batchEntries.length - 1;
    const lastKnownIndex = expected.reduce((maximum, entry) => Math.max(maximum, entry.index), 0);
    const actualEnd = Math.min(this.job.batch.end, Math.max(this.job.batch.start, fallbackEnd, lastKnownIndex));
    const hasMore = actualEnd < MAX_PLAYLIST_ITEMS && rawEntries.length > batchEntries.length;

    this.update({
      playlistTitle: cleanText(playlist.title || playlist.playlist_title, 'YouTube playlist'),
      totalItems: expected.length,
      batch: {
        ...this.job.batch,
        end: actualEnd,
        hasMore,
        nextStart: hasMore ? actualEnd + 1 : null,
        unavailableCount,
      },
      items: expected.map((entry, offset) => ({
        index: entry.index, batchPosition: offset + 1, id: entry.id,
        title: entry.title, status: 'queued', percent: 0, speed: '', eta: '',
      })),
      message: `Batch ${this.job.batch.start}-${actualEnd}: ${expected.length} downloadable item${expected.length === 1 ? '' : 's'}${unavailableCount ? `; ${unavailableCount} unavailable skipped` : ''}`,
    });

    let missing = new Set(expected.map((entry) => entry.id));
    let assessment = null;
    const recoveryDirectory = path.join(this.rootReal, '.recovery', this.job.id);
    for (let pass = 1; pass <= MAX_DOWNLOAD_PASSES && missing.size > 0; pass += 1) {
      if (pass > 1) await removeMissingIdsFromArchive(archivePath, missing, this.job.outputDirectory);
      for (const item of this.job.items) {
        if (missing.has(item.id)) Object.assign(item, { status: 'queued', percent: 0, speed: '', eta: '' });
      }
      this.update({
        status: pass === 1 ? 'downloading' : 'retrying', pass,
        message: pass === 1 ? 'Downloading playlist' : `Retrying ${missing.size} incomplete item${missing.size === 1 ? '' : 's'}`,
      });

      let passError = null;
      try {
        await this.downloadPass(archivePath);
      } catch (error) {
        if (this.abortController.signal.aborted) throw error;
        passError = error;
      }
      await checkStorage(this.job.outputDirectory);
      assessment = await assessOutput(this.job.outputDirectory, expected, archivePath, this.tools, this.abortController.signal);
      missing = new Set(assessment.missing.map((entry) => entry.id));
      for (const item of this.job.items) {
        if (assessment.validIds.has(item.id)) Object.assign(item, { status: 'done', percent: 100, speed: '', eta: '' });
      }
      this.update({
        files: assessment.inspected.map(({ name, size, verified }) => ({ name, size, verified })),
        completedItems: expected.length - missing.size,
        overallPercent: ((expected.length - missing.size) / expected.length) * 100,
      });
      if (!missing.size) break;
      if (passError && pass === MAX_DOWNLOAD_PASSES) throw passError;
      if (pass < MAX_DOWNLOAD_PASSES) await preserveInvalidFiles(assessment.inspected, missing, recoveryDirectory, this.rootReal);
    }
    await this.verify(expected, archivePath, assessment);
  }

  async downloadPass(archivePath) {
    await checkStorage(this.job.outputDirectory);
    const rejectOversizedLine = (error) => { throw error; };
    const stdoutReader = createLineReader((line) => this.handleLine(line), { onOverflow: rejectOversizedLine });
    const stderrReader = createLineReader((line) => this.handleLine(line), { onOverflow: rejectOversizedLine });
    const remaining = Math.max(1_000, MAX_JOB_RUNTIME_MS - (Date.now() - this.job.startedAt));
    const storageTimer = setInterval(() => {
      void checkStorage(this.job.outputDirectory).catch((error) => {
        this.resourceError = error;
        this.abortController.abort(error);
      });
    }, 30_000);
    try {
      const result = await runStreaming(this.tools.ytDlp, buildDownloadArgs({
        url: this.job.url,
        outputDirectory: this.job.outputDirectory,
        archivePath,
        quality: this.job.quality,
        ffmpegPath: this.tools.ffmpeg,
        startIndex: this.job.batch.start,
        endIndex: this.job.batch.end,
      }), {
        onStdout: (chunk) => stdoutReader.push(chunk),
        onStderr: (chunk) => stderrReader.push(chunk),
        signal: this.abortController.signal,
        timeoutMs: remaining,
        inactivityMs: DOWNLOAD_INACTIVITY_MS,
        cwd: this.job.outputDirectory,
        maxOutput: 100_000_000,
      });
      stdoutReader.flush();
      stderrReader.flush();
      if (result.code !== 0) throw new Error(`yt-dlp exited with code ${result.code}.`);
    } finally {
      clearInterval(storageTimer);
    }
  }

  batchPosition(identifier) {
    const offset = this.job?.items.findIndex((item) => (
      (identifier.id && item.id === identifier.id)
      || (identifier.index && item.index === identifier.index)
    ));
    return offset >= 0 ? offset + 1 : 1;
  }

  handleLine(line) {
    const event = parseDownloaderLine(line);
    if (!this.job || event.type === 'log') return;
    if (event.type === 'item') {
      this.setItem(event, { status: 'downloading', percent: 0, speed: '', eta: '' });
      this.update({ current: { index: event.index, title: event.title, percent: 0, speed: '', eta: '' } });
      return;
    }
    if (event.type === 'progress') {
      const index = event.index || this.job.current.index || 1;
      const batchPosition = this.batchPosition(event);
      const percent = event.percent ?? this.job.current.percent ?? 0;
      const completeBefore = Math.max(0, batchPosition - 1);
      this.setItem(event, { status: 'downloading', percent, speed: event.speed, eta: event.eta });
      this.update({
        overallPercent: Math.min(99.9, ((completeBefore + percent / 100) / Math.max(1, this.job.totalItems)) * 100),
        current: { index, title: event.title || this.job.current.title, percent, speed: event.speed, eta: event.eta },
      });
      return;
    }
    if (event.type === 'postprocess') {
      this.setItem(event, { status: 'verifying', percent: 100, speed: '', eta: '' });
      this.update({ current: { ...this.job.current, index: event.index, title: event.title || this.job.current.title, percent: 100, speed: '', eta: '' } });
      return;
    }
    if (event.type === 'done') {
      const batchPosition = this.batchPosition(event);
      const completedItems = Math.max(this.job.completedItems, Math.min(batchPosition, this.job.totalItems));
      this.setItem(event, { status: 'done', percent: 100, speed: '', eta: '' });
      this.update({
        completedItems,
        overallPercent: this.job.totalItems ? (completedItems / this.job.totalItems) * 100 : this.job.overallPercent,
        current: { index: event.index, title: event.title || this.job.current.title, percent: 100, speed: '', eta: '' },
      });
      void this.addCompletedFile(event.filePath);
    }
  }

  async addCompletedFile(filePath) {
    if (typeof filePath !== 'string' || filePath.length > 32_768) return;
    const candidate = path.resolve(this.job.outputDirectory, filePath);
    if (!isPathInside(this.job.outputDirectory, candidate)) return;
    try {
      const stat = await fs.lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) return;
      const name = path.basename(candidate);
      if (!this.job.files.some((file) => file.name === name)) {
        this.job.files.push({ name, size: stat.size, verified: null });
        this.emit();
      }
    } catch {
      // The final directory scan is authoritative; remux can replace an intermediate path.
    }
  }

  async verify(expected, archivePath, previousAssessment) {
    const expectedById = new Map(expected.map((entry) => [entry.id, entry]));
    const expectedByIndex = new Map(expected.map((entry) => [entry.index, entry]));
    const files = (await listMediaFiles(this.job.outputDirectory)).filter((file) => (
      expectedById.has(file.id) || expectedByIndex.has(file.index)
    ));
    this.update({
      status: 'verifying', message: 'Checking every final media file',
      current: { index: 0, title: '', percent: null, speed: '', eta: '' },
      verification: { status: 'running', checked: 0, total: files.length, valid: 0, invalidCount: 0, missingCount: previousAssessment?.missing.length || 0, partialCount: 0 },
    });
    const inspected = [];
    const validIds = new Set();
    for (const file of files) {
      const matchedEntry = expectedById.get(file.id) || expectedByIndex.get(file.index);
      const result = await inspectMedia(file, matchedEntry, this.tools, this.abortController.signal);
      if (result.verified) result.id = matchedEntry.id;
      if (result.verified && validIds.has(result.id)) {
        result.verified = false;
        result.reason = 'Duplicate final file.';
      } else if (result.verified) validIds.add(result.id);
      inspected.push(result);
      const invalidCount = inspected.filter((item) => !item.verified).length;
      this.job.files = inspected.map(({ name, size, verified }) => ({ name, size, verified }));
      this.job.verification = { ...this.job.verification, checked: inspected.length, valid: inspected.length - invalidCount, invalidCount };
      this.emit();
    }

    const archiveIds = await readArchiveIds(archivePath, this.job.outputDirectory);
    const partialFiles = await listPartialFiles(this.job.outputDirectory, new Set(expectedByIndex.keys()));
    const missing = expected.filter((entry) => !validIds.has(entry.id));
    const archiveMissing = expected.filter((entry) => !archiveIds.has(entry.id));
    const invalid = inspected.filter((file) => !file.verified);
    if (missing.length || invalid.length || archiveMissing.length || partialFiles.length) {
      for (const item of this.job.items) if (missing.some((entry) => entry.id === item.id)) item.status = 'failed';
      const problemCount = Math.max(missing.length, invalid.length, archiveMissing.length, partialFiles.length);
      this.update({
        status: 'failed', message: 'Verification did not pass',
        error: `${problemCount} item${problemCount === 1 ? '' : 's'} remain incomplete after ${MAX_DOWNLOAD_PASSES} automatic passes. Partial files were kept for resume.`,
        verification: {
          ...this.job.verification, status: 'failed', invalidCount: invalid.length,
          missingCount: Math.max(missing.length, archiveMissing.length), partialCount: partialFiles.length,
        },
      });
      return;
    }
    const completedBatches = [
      ...(this.completedBatches.get(this.job.playlistId) || []).filter((batch) => (
        batch.start !== this.job.batch.start || batch.end !== this.job.batch.end
      )),
      { start: this.job.batch.start, end: this.job.batch.end },
    ].sort((left, right) => left.start - right.start);
    this.completedBatches.set(this.job.playlistId, completedBatches);
    this.update({
      status: 'completed', message: `Batch ${this.job.batch.start}-${this.job.batch.end} downloaded and verified`,
      completedItems: expected.length, completedBatches,
      overallPercent: 100, error: null,
      verification: { ...this.job.verification, status: 'passed', missingCount: 0, invalidCount: 0, partialCount: 0 },
    });
  }

  fail(error) {
    if (!this.job) return;
    if (this.resourceError) error = this.resourceError;
    if (this.abortController?.signal.aborted && !this.resourceError) {
      this.update({ status: 'canceled', message: 'Download canceled; partial files are available to resume', error: null });
      return;
    }
    console.error('Download job failed:', error);
    const message = error instanceof PublicJobError
      ? error.publicMessage
      : 'The download could not finish. Check the local service console, then retry to resume.';
    this.update({ status: 'failed', message: 'Download stopped', error: message });
  }
}
