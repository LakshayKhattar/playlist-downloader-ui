import { spawn } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const MAX_TIMER_MS = 2_147_483_647;
const FORCE_KILL_DELAY_MS = 2_000;
const DEFAULT_CAPTURE_TIMEOUT_MS = 120_000;
const DEFAULT_CAPTURE_MAX_OUTPUT = 20_000_000;
const DEFAULT_STREAM_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const DEFAULT_STREAM_INACTIVITY_MS = 5 * 60 * 1000;
const DEFAULT_STREAM_MAX_OUTPUT = 20_000_000;
const CHILD_ENV_KEYS = new Set([
  'ALL_PROXY',
  'APPDATA',
  'COMSPEC',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'NO_PROXY',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TZ',
  'USERPROFILE',
  'WINDIR',
]);

function minimalChildEnvironment() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && CHILD_ENV_KEYS.has(key.toUpperCase())) env[key] = value;
  }
  return env;
}

function normalizeTimeout(value, fallback, name) {
  const selected = value ?? fallback;
  if (selected === 0) return 0;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > MAX_TIMER_MS) {
    throw new TypeError(`${name} must be 0 or a positive finite number no greater than ${MAX_TIMER_MS}.`);
  }
  return Math.floor(selected);
}

function normalizeOutputLimit(value, fallback) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new TypeError('maxOutput must be a positive safe integer.');
  }
  return selected;
}

function makeProcessError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function makeAbortError(command, signal) {
  const reason = signal?.reason instanceof Error ? `: ${signal.reason.message}` : '';
  const error = makeProcessError(`${command} was cancelled${reason}.`, 'ABORT_ERR');
  error.name = 'AbortError';
  return error;
}

function formatDuration(milliseconds) {
  return milliseconds < 1_000
    ? `${milliseconds} ms`
    : `${Math.round(milliseconds / 1_000)} seconds`;
}

function spawnOptions(cwd) {
  return {
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: minimalChildEnvironment(),
    detached: process.platform !== 'win32',
    ...(cwd === undefined ? {} : { cwd }),
  };
}

function directKill(child, signal) {
  try {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  } catch {
    // The process may have exited between the state check and the signal.
  }
}

function terminateWindowsTree(child) {
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    directKill(child, 'SIGKILL');
    return;
  }

  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  const taskkill = systemRoot
    ? path.join(systemRoot, 'System32', 'taskkill.exe')
    : 'taskkill.exe';

  let killer;
  try {
    killer = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
      env: minimalChildEnvironment(),
    });
  } catch {
    directKill(child, 'SIGKILL');
    return;
  }

  killer.once('error', () => directKill(child, 'SIGKILL'));
  killer.once('close', (code) => {
    if (code !== 0) directKill(child, 'SIGKILL');
  });
}

function terminateChildTree(child, force = false) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    terminateWindowsTree(child);
    return;
  }

  const signal = force ? 'SIGKILL' : 'SIGTERM';
  const pid = child.pid;
  if (Number.isSafeInteger(pid) && pid > 0) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to the direct child when process-group signaling is unavailable.
    }
  }
  directKill(child, signal);
}

function runManaged(command, args, {
  signal,
  cwd,
  timeoutMs,
  inactivityMs = 0,
  onStdout,
  onStderr,
}) {
  if (signal?.aborted) return Promise.reject(makeAbortError(command, signal));

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, spawnOptions(cwd));
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    let terminationError = null;
    let timeoutTimer = null;
    let inactivityTimer = null;
    let forceKillTimer = null;

    const clearTimers = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(inactivityTimer);
      clearTimeout(forceKillTimer);
    };

    const onAbort = () => requestTermination(makeAbortError(command, signal));

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimers();
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(result);
    };

    const requestTermination = (error) => {
      if (settled || terminationError) return;
      terminationError = error instanceof Error ? error : new Error(String(error));
      clearTimeout(timeoutTimer);
      clearTimeout(inactivityTimer);
      terminateChildTree(child);
      forceKillTimer = setTimeout(() => terminateChildTree(child, true), FORCE_KILL_DELAY_MS);
      forceKillTimer.unref?.();
    };

    const resetInactivityTimer = () => {
      if (!inactivityMs || terminationError) return;
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        requestTermination(makeProcessError(
          `${command} produced no output for ${formatDuration(inactivityMs)}.`,
          'ERR_CHILD_INACTIVITY_TIMEOUT',
        ));
      }, inactivityMs);
      inactivityTimer.unref?.();
    };

    const handleChunk = (callback, chunk) => {
      if (terminationError) return;
      resetInactivityTimer();
      try {
        callback?.(chunk);
      } catch (error) {
        requestTermination(error);
      }
    };

    child.stdout.on('data', (chunk) => handleChunk(onStdout, chunk));
    child.stderr.on('data', (chunk) => handleChunk(onStderr, chunk));
    child.once('error', (error) => {
      if (terminationError) return;
      if (!Number.isSafeInteger(child.pid)) finish(error);
      else requestTermination(error);
    });
    child.once('close', (code, childSignal) => {
      finish(terminationError, { code, signal: childSignal });
    });

    if (timeoutMs) {
      timeoutTimer = setTimeout(() => {
        requestTermination(makeProcessError(
          `${command} timed out after ${formatDuration(timeoutMs)}.`,
          'ERR_CHILD_TIMEOUT',
        ));
      }, timeoutMs);
      timeoutTimer.unref?.();
    }
    resetInactivityTimer();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function createTextCollector() {
  const decoder = new StringDecoder('utf8');
  let value = '';
  return {
    push(chunk) {
      value += decoder.write(chunk);
    },
    finish() {
      value += decoder.end();
      return value;
    },
  };
}

export async function runCapture(command, args, {
  timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS,
  maxOutput = DEFAULT_CAPTURE_MAX_OUTPUT,
  signal,
  cwd,
} = {}) {
  const totalTimeout = normalizeTimeout(timeoutMs, DEFAULT_CAPTURE_TIMEOUT_MS, 'timeoutMs');
  const outputLimit = normalizeOutputLimit(maxOutput, DEFAULT_CAPTURE_MAX_OUTPUT);
  const stdout = createTextCollector();
  const stderr = createTextCollector();
  let outputBytes = 0;

  const collect = (collector, chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > outputLimit) {
      throw makeProcessError(
        `${command} exceeded the ${outputLimit}-byte output limit.`,
        'ERR_CHILD_OUTPUT_LIMIT',
      );
    }
    collector.push(chunk);
  };

  const result = await runManaged(command, args, {
    signal,
    cwd,
    timeoutMs: totalTimeout,
    onStdout: (chunk) => collect(stdout, chunk),
    onStderr: (chunk) => collect(stderr, chunk),
  });
  return { ...result, stdout: stdout.finish(), stderr: stderr.finish() };
}

export function runStreaming(command, args, {
  onStdout,
  onStderr,
  signal,
  timeoutMs = DEFAULT_STREAM_TIMEOUT_MS,
  inactivityMs = DEFAULT_STREAM_INACTIVITY_MS,
  cwd,
  maxOutput = DEFAULT_STREAM_MAX_OUTPUT,
} = {}) {
  const totalTimeout = normalizeTimeout(timeoutMs, DEFAULT_STREAM_TIMEOUT_MS, 'timeoutMs');
  const inactivityTimeout = normalizeTimeout(
    inactivityMs,
    DEFAULT_STREAM_INACTIVITY_MS,
    'inactivityMs',
  );
  const outputLimit = normalizeOutputLimit(maxOutput, DEFAULT_STREAM_MAX_OUTPUT);
  let outputBytes = 0;

  const forward = (callback, chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > outputLimit) {
      throw makeProcessError(
        `${command} exceeded the ${outputLimit}-byte output limit.`,
        'ERR_CHILD_OUTPUT_LIMIT',
      );
    }
    callback?.(chunk);
  };

  return runManaged(command, args, {
    signal,
    cwd,
    timeoutMs: totalTimeout,
    inactivityMs: inactivityTimeout,
    onStdout: (chunk) => forward(onStdout, chunk),
    onStderr: (chunk) => forward(onStderr, chunk),
  });
}
