import { StringDecoder } from 'node:string_decoder';

const DEFAULT_MAX_LINE_BYTES = 64 * 1024;
const MAX_JSON_BYTES = DEFAULT_MAX_LINE_BYTES;
const MAX_INDEX = 1_000_000;
const MAX_ID_BYTES = 100;
const MAX_TITLE_BYTES = 4_096;
const MAX_STATUS_BYTES = 256;
const MAX_PATH_BYTES = 32_768;

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function boundedString(value, maxBytes, { allowEmpty = true, trim = true } = {}) {
  if (typeof value !== 'string' || value.includes('\0')) return null;
  const normalized = trim ? value.trim() : value;
  if ((!allowEmpty && !normalized) || byteLength(normalized) > maxBytes) return null;
  return normalized;
}

function optionalString(value, maxBytes) {
  if (value === undefined || value === null || value === 'NA') return '';
  return boundedString(value, maxBytes);
}

function optionalMetric(value, maxBytes) {
  if (value === undefined || value === null || value === '' || value === 'NA') return '';
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  return boundedString(value, maxBytes);
}

function nonNegativeInteger(value) {
  if (value === undefined || value === null || value === '' || value === 'NA') return 0;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return null;
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_INDEX ? parsed : null;
}

function percentage(value) {
  if (value === undefined || value === null || value === '' || value === 'NA') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const normalized = typeof value === 'string' ? value.replace(/%$/, '').trim() : value;
  if (typeof normalized === 'string' && !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null;
  const parsed = typeof normalized === 'number' ? normalized : Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function knownField(payload, ...paths) {
  for (const fieldPath of paths) {
    if (hasOwn(payload, fieldPath)) return payload[fieldPath];
    let current = payload;
    let found = true;
    for (const segment of fieldPath.split('.')) {
      if (!isRecord(current) || !hasOwn(current, segment)) {
        found = false;
        break;
      }
      current = current[segment];
    }
    if (found) return current;
  }
  return undefined;
}

function isUnavailable(value) {
  return value === undefined || value === null || value === '' || value === 'NA';
}

function nonNegativeNumber(value) {
  if (isUnavailable(value)) return undefined;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const normalized = typeof value === 'string' ? value.trim() : value;
  if (typeof normalized === 'string' && !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) {
    return null;
  }
  const parsed = typeof normalized === 'number' ? normalized : Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function invalidMarker(line) {
  return { type: 'log', line };
}

function commonFields(payload) {
  const index = nonNegativeInteger(knownField(
    payload,
    'index',
    'playlist_index',
    'info.playlist_index',
  ));
  const total = nonNegativeInteger(knownField(
    payload,
    'total',
    'playlist_count',
    'info.playlist_count',
  ));
  const id = optionalString(knownField(payload, 'id', 'info.id'), MAX_ID_BYTES);
  const title = optionalString(knownField(payload, 'title', 'info.title'), MAX_TITLE_BYTES);
  if (index === null || total === null || id === null || title === null) return null;
  return { index, total, id, title };
}

function validIdentifier(id, required = false) {
  return (!required && !id) || /^[A-Za-z0-9_-]{1,100}$/.test(id);
}

function parseItem(payload, line) {
  const fields = commonFields(payload);
  if (!fields || !validIdentifier(fields.id, true)) return invalidMarker(line);
  return { type: 'item', ...fields };
}

function parseProgress(payload, line) {
  const fields = commonFields(payload);
  const percentValue = knownField(
    payload,
    'percent',
    'progress.percent',
    '_percent_str',
    'progress._percent_str',
  );
  let percent = percentage(percentValue);
  if (isUnavailable(percentValue)) {
    const downloaded = nonNegativeNumber(knownField(
      payload,
      'downloaded_bytes',
      'progress.downloaded_bytes',
    ));
    let totalBytes = nonNegativeNumber(knownField(payload, 'total_bytes', 'progress.total_bytes'));
    if (totalBytes === undefined || totalBytes === 0) {
      totalBytes = nonNegativeNumber(knownField(
        payload,
        'total_bytes_estimate',
        'progress.total_bytes_estimate',
      ));
    }
    if (downloaded === null || totalBytes === null) return invalidMarker(line);
    if (downloaded !== undefined && totalBytes !== undefined && totalBytes > 0) {
      percent = Math.min(100, (downloaded / totalBytes) * 100);
    }
  }
  const speed = optionalMetric(knownField(payload, 'speed', 'progress.speed'), MAX_STATUS_BYTES);
  const eta = optionalMetric(knownField(payload, 'eta', 'progress.eta'), MAX_STATUS_BYTES);
  if (!fields || !validIdentifier(fields.id, true) || speed === null || eta === null) {
    return invalidMarker(line);
  }
  if (!isUnavailable(percentValue) && percent === null) return invalidMarker(line);
  return { type: 'progress', ...fields, percent, speed, eta };
}

function parsePostprocess(payload, line) {
  const fields = commonFields(payload);
  const percentValue = knownField(payload, 'percent', 'progress.percent');
  const percent = percentage(percentValue);
  const speed = optionalMetric(knownField(payload, 'speed', 'progress.speed'), MAX_STATUS_BYTES);
  const eta = optionalMetric(knownField(payload, 'eta', 'progress.eta'), MAX_STATUS_BYTES);
  const status = optionalString(knownField(payload, 'status', 'progress.status'), MAX_STATUS_BYTES);
  const postprocessor = optionalString(
    knownField(payload, 'postprocessor', 'progress.postprocessor'),
    MAX_STATUS_BYTES,
  );
  if (!fields || !validIdentifier(fields.id, true) || speed === null || eta === null
    || status === null || postprocessor === null) {
    return invalidMarker(line);
  }
  if (!isUnavailable(percentValue) && percent === null) return invalidMarker(line);
  return { type: 'postprocess', ...fields, percent, speed, eta, status, postprocessor };
}

function parseFile(payload, line) {
  const fields = commonFields(payload);
  const filePath = boundedString(knownField(
    payload,
    'filePath',
    'filepath',
    'info.filepath',
  ), MAX_PATH_BYTES, {
    allowEmpty: false,
  });
  if (!fields || !validIdentifier(fields.id, true) || !filePath || /[\r\n]/.test(filePath)) {
    return invalidMarker(line);
  }
  return { type: 'done', ...fields, filePath };
}

const JSON_MARKERS = new Map([
  ['APP_ITEM_JSON|', parseItem],
  ['APP_PROGRESS_JSON|', parseProgress],
  ['APP_POST_JSON|', parsePostprocess],
  ['APP_FILE_JSON|', parseFile],
]);

export function createLineReader(onLine, {
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  onOverflow,
} = {}) {
  if (typeof onLine !== 'function') throw new TypeError('onLine must be a function.');
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
    throw new TypeError('maxLineBytes must be a positive safe integer.');
  }
  if (onOverflow !== undefined && typeof onOverflow !== 'function') {
    throw new TypeError('onOverflow must be a function when provided.');
  }

  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let bufferBytes = 0;
  let discarding = false;
  let ended = false;

  const emit = () => {
    if (!discarding) {
      const trimmed = buffer.trim();
      if (trimmed) onLine(trimmed);
    }
    buffer = '';
    bufferBytes = 0;
    discarding = false;
  };

  const append = (segment) => {
    if (discarding || !segment) return;
    const segmentBytes = byteLength(segment);
    if (bufferBytes + segmentBytes > maxLineBytes) {
      buffer = '';
      bufferBytes = 0;
      discarding = true;
      const error = new Error(`Child output line exceeded ${maxLineBytes} bytes.`);
      error.code = 'ERR_CHILD_LINE_TOO_LONG';
      onOverflow?.(error);
      return;
    }
    buffer += segment;
    bufferBytes += segmentBytes;
  };

  const consume = (text) => {
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (character !== '\r' && character !== '\n') continue;
      append(text.slice(start, index));
      emit();
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      start = index + 1;
    }
    append(text.slice(start));
  };

  return {
    push(chunk) {
      if (ended) throw new Error('Cannot push output after the line reader is flushed.');
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      consume(decoder.write(bytes));
    },
    flush() {
      if (ended) return;
      ended = true;
      consume(decoder.end());
      if (buffer || discarding) emit();
    },
  };
}

export function parseDownloaderLine(line) {
  if (typeof line !== 'string' || byteLength(line) > MAX_JSON_BYTES) {
    return { type: 'log', line: typeof line === 'string' ? line : String(line) };
  }

  for (const [prefix, parse] of JSON_MARKERS) {
    if (!line.startsWith(prefix)) continue;
    let payload;
    try {
      payload = JSON.parse(line.slice(prefix.length));
    } catch {
      return invalidMarker(line);
    }
    return isRecord(payload) ? parse(payload, line) : invalidMarker(line);
  }

  return { type: 'log', line };
}
