import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const APP_URL = process.env.PLAYLIST_APP_URL || 'http://127.0.0.1:4173/';
const PLAYLIST_URL = process.env.PLAYLIST_E2E_URL || process.argv[2] || '';
const DOCS_SCREENSHOT = process.env.PLAYLIST_DOCS_SCREENSHOT === '1';
const EDGE = process.env.EDGE_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const projectRoot = path.resolve(import.meta.dirname, '..');
const artifactsDirectory = path.join(projectRoot, 'test-artifacts');
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(check, timeoutMs, label) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Could not connect to Edge DevTools.')), { once: true });
  });

  let sequence = 0;
  const pending = new Map();
  const browserErrors = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      clearTimeout(timer);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      browserErrors.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text || 'Runtime exception');
    }
  });

  function send(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 20_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const response = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    return response.result?.value;
  }

  return { socket, send, evaluate, browserErrors };
}

const profileDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'playlist-ui-edge-'));
const edge = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--remote-debugging-port=0',
  `--user-data-dir=${profileDirectory}`,
  'about:blank',
], { windowsHide: true, stdio: 'ignore' });

let cdp;
try {
  const portFile = path.join(profileDirectory, 'DevToolsActivePort');
  const portText = await waitFor(async () => {
    try {
      return await fs.readFile(portFile, 'utf8');
    } catch {
      return null;
    }
  }, 15_000, 'Edge DevTools port');
  const port = Number.parseInt(portText.split(/\r?\n/)[0], 10);
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
  const page = targets.find((target) => target.type === 'page');
  if (!page) throw new Error('Edge did not expose a page target.');

  cdp = await connectCdp(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send('Page.navigate', { url: APP_URL });
  await waitFor(
    () => cdp.evaluate("document.readyState === 'complete' && Boolean(document.querySelector('#playlist-url'))"),
    15_000,
    'the React page',
  );
  await waitFor(
    () => cdp.evaluate("document.querySelector('.service-status')?.dataset.status === 'online'"),
    15_000,
    'the local service',
  );

  const title = await cdp.evaluate('document.title');
  const heading = await cdp.evaluate("document.querySelector('h1')?.textContent");
  if (title !== 'Playlist Downloader | Secure yt-dlp Web Interface' || heading !== 'Download playlists with yt-dlp.') {
    throw new Error(`Unexpected page content: ${title} / ${heading}`);
  }
  const initialQueueVisible = await cdp.evaluate("Boolean(document.querySelector('.queue-panel'))");
  if (initialQueueVisible) throw new Error('Queue should stay hidden until a URL or job exists.');

  const batchControls = await cdp.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('.batch-option')];
    return {
      size: document.querySelector('#batch-size')?.value,
      ranges: buttons.map((button) => button.querySelector('span')?.textContent),
    };
  })()`);
  if (batchControls.size !== 'Automatic - 20 videos' || batchControls.ranges.length !== 0) {
    throw new Error(`Batch controls are not ready: ${JSON.stringify(batchControls)}`);
  }

  const browserMutationStatus = await cdp.evaluate(`(async () => {
    const config = await fetch('/api/config', { cache: 'no-store' }).then((response) => response.json());
    const response = await fetch('/api/cancel', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Playlist-Token': config.csrfToken,
      },
      body: JSON.stringify({ jobId: '00000000-0000-4000-8000-000000000000' }),
    });
    return response.status;
  })()`);
  if (browserMutationStatus !== 409) {
    throw new Error(`Same-origin mutation security check failed with ${browserMutationStatus}.`);
  }

  await cdp.evaluate("document.querySelector('[aria-label=\"Light theme\"]')?.click()");
  const lightTheme = await waitFor(() => cdp.evaluate('document.documentElement.dataset.theme'), 2_000, 'light theme');
  if (lightTheme !== 'light') throw new Error('Theme switcher did not apply light mode.');
  await cdp.evaluate("document.querySelector('[aria-label=\"Dark theme\"]')?.click()");
  const theme = await waitFor(() => cdp.evaluate('document.documentElement.dataset.theme'), 2_000, 'dark theme');
  if (theme !== 'dark') throw new Error('Theme switcher did not apply dark mode.');

  const setInput = async (value) => {
    await cdp.evaluate(`(() => {
      const input = document.querySelector('#playlist-url');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value;
    })()`);
    await sleep(150);
  };

  await setInput('');
  await cdp.evaluate("document.querySelector('.download-panel').requestSubmit()");
  const emptyValidation = await waitFor(
    () => cdp.evaluate("document.querySelector('.field-error')?.textContent"),
    2_000,
    'empty URL validation',
  );
  const focusedField = await cdp.evaluate('document.activeElement?.id');
  if (!emptyValidation.includes('Enter a YouTube playlist URL') || focusedField !== 'playlist-url') {
    throw new Error('Empty URL validation was not inline and focused.');
  }
  const emptyQueueVisible = await cdp.evaluate("Boolean(document.querySelector('.queue-panel'))");
  if (emptyQueueVisible) throw new Error('Empty URL validation should not reveal the queue.');

  await setInput('https://example.com/not-a-playlist');
  await waitFor(
    () => cdp.evaluate("Boolean(document.querySelector('.queue-panel'))"),
    2_000,
    'conditional queue',
  );
  await cdp.evaluate("document.querySelector('.queue-toggle')?.click()");
  const collapsedQueue = await cdp.evaluate(`({
    expanded: document.querySelector('.queue-toggle')?.getAttribute('aria-expanded'),
    hidden: document.querySelector('#queue-content')?.hidden
  })`);
  if (collapsedQueue.expanded !== 'false' || collapsedQueue.hidden !== true) {
    throw new Error(`Queue collapse check failed: ${JSON.stringify(collapsedQueue)}`);
  }
  await cdp.evaluate("document.querySelector('.queue-toggle')?.click()");
  await cdp.evaluate("document.querySelector('.download-panel').requestSubmit()");
  const validationMessage = await waitFor(
    () => cdp.evaluate("document.querySelector('.field-error')?.textContent"),
    2_000,
    'inline URL validation',
  );
  if (!validationMessage.includes('HTTPS URL from YouTube')) throw new Error('URL validation message was not useful.');

  let started = false;
  let cancelled = false;
  if (PLAYLIST_URL) {
    await setInput(PLAYLIST_URL);
    await cdp.evaluate("document.querySelector('.download-panel').requestSubmit()");
    await waitFor(
      () => cdp.evaluate("document.querySelectorAll('.queue-row').length > 0"),
      180_000,
      'bounded playlist preflight',
    );
    const inspectedBatchControls = await cdp.evaluate(`(() => ({
      ranges: [...document.querySelectorAll('.batch-option')].map((button) => button.querySelector('span')?.textContent),
      status: document.querySelector('.activity-panel')?.dataset.status,
      liveTitle: document.querySelector('#activity-title')?.textContent,
    }))()`);
    if (inspectedBatchControls.ranges[0] !== '1-20'
      || !inspectedBatchControls.ranges[1]?.startsWith('21-')
      || !['downloading', 'retrying'].includes(inspectedBatchControls.status)
      || !inspectedBatchControls.liveTitle?.includes('batch 1-20')) {
      throw new Error(`Automatic batch discovery or live status failed: ${JSON.stringify(inspectedBatchControls)}`);
    }
    started = true;
    await cdp.evaluate("document.querySelector('.queue-actions .secondary-button')?.click()");
    await waitFor(
      () => cdp.evaluate("/CANCELED|CANCELLED/.test(document.querySelector('.panel-label')?.textContent || '')"),
      30_000,
      'safe cancellation',
    );
    cancelled = true;
  }

  if (DOCS_SCREENSHOT) {
    await setInput('');
    await waitFor(
      () => cdp.evaluate("!document.querySelector('.queue-panel') && !document.querySelector('.field-error')"),
      2_000,
      'clean documentation state',
    );
  }

  await fs.mkdir(artifactsDirectory, { recursive: true });
  const desktopPath = DOCS_SCREENSHOT
    ? path.join(projectRoot, 'docs', 'images', 'playlist-downloader-ui.png')
    : path.join(artifactsDirectory, 'desktop.png');
  await fs.mkdir(path.dirname(desktopPath), { recursive: true });
  const desktopCapture = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await fs.writeFile(desktopPath, Buffer.from(desktopCapture.data, 'base64'));

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await sleep(250);
  const mobileLayout = await cdp.evaluate(`({
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    buttonWidth: Math.round(document.querySelector('.download-button').getBoundingClientRect().width),
    formWidth: Math.round(document.querySelector('.download-panel').getBoundingClientRect().width)
  })`);
  if (mobileLayout.overflow || mobileLayout.buttonWidth < mobileLayout.formWidth - 40) {
    throw new Error(`Mobile layout check failed: ${JSON.stringify(mobileLayout)}`);
  }
  const mobileCapture = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await fs.writeFile(path.join(artifactsDirectory, 'mobile.png'), Buffer.from(mobileCapture.data, 'base64'));

  if (cdp.browserErrors.length) throw new Error(`Browser runtime errors: ${cdp.browserErrors.join('; ')}`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    title,
    heading,
    initialQueueVisible,
    collapsedQueue,
    browserMutationStatus,
    lightTheme,
    theme,
    emptyValidation,
    validationMessage,
    mobileLayout,
    playlistStarted: started,
    playlistCancelled: cancelled,
    screenshots: [
      desktopPath,
      path.join(artifactsDirectory, 'mobile.png'),
    ],
  }, null, 2)}\n`);
} finally {
  try { await cdp?.send('Browser.close'); } catch {}
  try { cdp?.socket.close(); } catch {}
  edge.kill();
  await sleep(500);
  const safeTempRoot = `${path.resolve(os.tmpdir())}${path.sep}`.toLowerCase();
  if (path.resolve(profileDirectory).toLowerCase().startsWith(safeTempRoot)) {
    await fs.rm(profileDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
