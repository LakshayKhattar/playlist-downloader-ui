import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DownloadIcon, GitHubIcon, MoonIcon, SunIcon } from './icons.jsx';

const ACTIVE_STATES = new Set(['preparing', 'downloading', 'retrying', 'verifying', 'canceling', 'cancelling']);
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'canceled']);
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'music.youtube.com', 'm.youtube.com', 'youtu.be']);
const DEFAULT_FORMATS = [
  { value: 'best', label: 'Best available - MKV' },
  { value: '1080', label: 'Up to 1080p - MKV' },
  { value: '720', label: 'Up to 720p - MKV' },
];

let bootstrapRequest;

function requestBootstrap(force = false) {
  if (!bootstrapRequest || force) {
    bootstrapRequest = fetch('/api/config', {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    }).then(async (response) => {
      const payload = await readJson(response);
      if (!response.ok || !payload?.csrfToken) {
        throw new Error(payload?.error || 'The download service is unavailable.');
      }
      return payload;
    }).catch((error) => {
      bootstrapRequest = undefined;
      throw error;
    });
  }
  return bootstrapRequest;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    'content',
    theme === 'dark' ? '#0A0A0A' : '#F7F7F5',
  );
}

function initialTheme() {
  const saved = localStorage.getItem('playlist-theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function clampPercent(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : fallback;
}

function humanBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** unit)).toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

function humanSpeed(value) {
  if (typeof value === 'string') return value.trim();
  const formatted = humanBytes(value);
  return formatted ? `${formatted}/s` : '';
}

function displayState(value) {
  const state = String(value || 'queued').toLowerCase();
  if (['completed', 'complete', 'done', 'downloaded'].includes(state)) return { key: 'done', label: 'DONE' };
  if (['downloading', 'active', 'retrying'].includes(state)) return { key: 'active', label: 'RUN' };
  if (['verifying', 'checking'].includes(state)) return { key: 'checking', label: 'CHECK' };
  if (['failed', 'error'].includes(state)) return { key: 'failed', label: 'ERR' };
  if (['canceling', 'cancelling', 'cancelled', 'canceled'].includes(state)) return { key: 'cancelled', label: 'STOP' };
  return { key: 'queued', label: 'WAIT' };
}

function normalizeItems(job) {
  if (!job) return [];
  const sourceItems = Array.isArray(job.items) ? job.items : [];
  const files = Array.isArray(job.files) ? job.files : [];
  if (sourceItems.length) {
    return sourceItems.map((item, offset) => {
      const percent = clampPercent(item.percent ?? item.progress?.percent, 0);
      const completedFile = files.find((file) => Number(file.index) === Number(item.index || offset + 1));
      return {
        key: item.id || item.name || `${offset}-${item.index || ''}`,
        index: Number(item.index || item.playlistIndex || offset + 1),
        position: Number(item.batchPosition || offset + 1),
        title: item.filename || item.name || item.title || item.id || 'Playlist item',
        state: displayState(item.status || item.state),
        percent,
        speed: humanSpeed(item.speed ?? item.progress?.speed),
        eta: item.eta ?? item.progress?.eta ?? '',
        size: humanBytes(item.size ?? item.bytes),
        downloadUrl: completedFile?.downloadUrl || '',
      };
    });
  }

  const normalized = files.map((file, offset) => ({
    key: file.id || file.name || `file-${offset}`,
    index: Number(file.index || offset + 1),
    position: offset + 1,
    title: file.name || file.title || file.id || 'Downloaded item',
    state: displayState(file.verified === false ? 'failed' : file.verified ? 'done' : 'checking'),
    percent: file.verified === false ? 100 : clampPercent(file.percent, 100),
    speed: '',
    eta: '',
    size: humanBytes(file.size),
    downloadUrl: file.downloadUrl || '',
  }));

  if (job.current?.title || job.current?.id) {
    const currentKey = job.current.id || `current-${job.current.index || 0}`;
    const existingIndex = normalized.findIndex((item) => item.key === currentKey);
    const current = {
      key: currentKey,
      index: Number(job.current.index || normalized.length + 1),
      position: normalized.length + 1,
      title: job.current.filename || job.current.title || job.current.id,
      state: displayState(job.status === 'verifying' ? 'verifying' : job.status),
      percent: clampPercent(job.current.percent, 0),
      speed: humanSpeed(job.current.speed),
      eta: job.current.eta || '',
      size: '',
      downloadUrl: '',
    };
    if (existingIndex >= 0) normalized[existingIndex] = current;
    else normalized.push(current);
  }
  return normalized.sort((left, right) => left.index - right.index);
}

function normalizeFormats(formats) {
  if (!Array.isArray(formats) || formats.length === 0) return DEFAULT_FORMATS;
  const normalized = formats.flatMap((format) => {
    if (typeof format === 'string') {
      const fallback = DEFAULT_FORMATS.find((entry) => entry.value === format);
      return fallback ? [fallback] : [{ value: format, label: format }];
    }
    if (!format || typeof format !== 'object' || typeof format.value !== 'string') return [];
    return [{ value: format.value, label: String(format.label || format.value) }];
  });
  return normalized.length ? normalized : DEFAULT_FORMATS;
}

function validatePlaylistUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) return 'Enter a YouTube playlist URL.';
  if (value.length > 2048 || /[\r\n\0]/.test(value)) return 'The playlist URL is too long or contains invalid characters.';
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.port
      || !YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())
    ) {
      return 'Use an HTTPS URL from YouTube or YouTube Music.';
    }
    if (!/^[A-Za-z0-9_-]{10,100}$/.test(parsed.searchParams.get('list') || '')) {
      return 'The playlist URL must include a valid list ID.';
    }
    return '';
  } catch {
    return 'Enter a complete YouTube playlist URL.';
  }
}

function ThemeSwitcher({ theme, onChange }) {
  return (
    <div className="theme-switcher" role="group" aria-label="Appearance">
      <button
        className="theme-button"
        type="button"
        aria-label="Light theme"
        aria-pressed={theme === 'light'}
        title="Light theme"
        onClick={() => onChange('light')}
      >
        <SunIcon size={15} />
      </button>
      <button
        className="theme-button"
        type="button"
        aria-label="Dark theme"
        aria-pressed={theme === 'dark'}
        title="Dark theme"
        onClick={() => onChange('dark')}
      >
        <MoonIcon size={15} />
      </button>
    </div>
  );
}

function ErrorBanner({ title, children }) {
  return (
    <section className="error-banner" role="alert">
      <div>
        <strong>{title}</strong>
        <p>{children}</p>
      </div>
    </section>
  );
}

function QueueRow({ item, total }) {
  const percent = clampPercent(item.percent, item.state.key === 'done' ? 100 : 0);
  const position = String(item.position || 0).padStart(String(Math.max(total, 1)).length, '0');
  const meta = [`PLAYLIST #${item.index}`, item.state.label, item.speed, item.eta ? `ETA ${item.eta}` : '', item.size].filter(Boolean);

  return (
    <li className="queue-row" data-state={item.state.key}>
      <div className="queue-row__line">
        <span className="queue-index">[{position}/{total || '?'}]</span>
        <span className="queue-filename" tabIndex="0" title={item.title}>{item.title}</span>
        <span className="queue-percent">{Math.round(percent)}%</span>
      </div>
      <div className="queue-row__meta" aria-label={`Status ${item.state.label}`}>
        {meta.map((value, index) => <span key={`${value}-${index}`}>{value}</span>)}
        {item.downloadUrl && (
          <a className="file-download" href={item.downloadUrl} download>Save file</a>
        )}
      </div>
      <progress max="100" value={percent} aria-label={`${item.title} progress: ${Math.round(percent)} percent`} />
    </li>
  );
}

function QueuePanel({ job, onCancel, cancelling, expanded, onToggle, onSelectNextBatch, nextBatchLabel }) {
  const items = useMemo(() => normalizeItems(job), [job]);
  const active = ACTIVE_STATES.has(job?.status);
  const total = Number(job?.totalItems) || items.length;
  const overall = clampPercent(job?.overallPercent, total ? (Number(job?.completedItems || 0) / total) * 100 : 0);
  const queueStatus = job?.status ? String(job.status).toUpperCase() : 'IDLE';
  const batchLabel = job?.batch ? `${job.batch.start}-${job.batch.end}` : null;

  return (
    <section className="queue-panel" aria-labelledby="queue-title" data-collapsed={!expanded}>
      <div className="panel-heading">
        <button
          className="queue-toggle"
          type="button"
          aria-expanded={expanded}
          aria-controls="queue-content"
          onClick={onToggle}
        >
          <span>
            <span className="panel-label">QUEUE{batchLabel ? ` / BATCH ${batchLabel}` : ''} / {queueStatus}</span>
            <span className="queue-title" id="queue-title" role="heading" aria-level="2">Download queue</span>
          </span>
          <span className="queue-toggle__mark" aria-hidden="true">{expanded ? '-' : '+'}</span>
        </button>
        <div className="queue-actions">
          {job && total > 0 && <span className="queue-total">{Number(job.completedItems || 0)}/{total}</span>}
          {active && (
            <button className="secondary-button" type="button" onClick={onCancel} disabled={cancelling}>
              {cancelling ? 'Stopping...' : 'Cancel'}
            </button>
          )}
          {job?.status === 'completed' && job.batch?.hasMore && (
            <button className="secondary-button" type="button" onClick={onSelectNextBatch}>
              Select {nextBatchLabel}
            </button>
          )}
        </div>
      </div>

      <div className="queue-content" id="queue-content" hidden={!expanded}>
        {job && total > 0 && (
          <div className="overall-progress">
            <div>
              <span>{batchLabel ? `Batch ${batchLabel}` : 'Overall'}</span>
              <span>{Math.round(overall)}%</span>
            </div>
            <progress max="100" value={overall} aria-label={`Overall progress: ${Math.round(overall)} percent`} />
          </div>
        )}

        {items.length ? (
          <ol className="queue-list">
            {items.map((item) => <QueueRow key={item.key} item={item} total={total} />)}
          </ol>
        ) : (
          <div className="queue-empty">
            <span aria-hidden="true">[--]</span>
            <p>Ready to inspect this playlist after you start the download.</p>
          </div>
        )}

        {job?.destination && (
          <div className="queue-destination">
            <span>OUTPUT</span>
            <code tabIndex="0" title={job.destination}>{job.destination}</code>
          </div>
        )}
      </div>
    </section>
  );
}

export default function App() {
  const [theme, setTheme] = useState(initialTheme);
  const [url, setUrl] = useState('');
  const [quality, setQuality] = useState('best');
  const [batchStart, setBatchStart] = useState(1);
  const [batchSize, setBatchSize] = useState(20);
  const [config, setConfig] = useState(null);
  const [job, setJob] = useState(null);
  const [serviceState, setServiceState] = useState('checking');
  const [fieldError, setFieldError] = useState('');
  const [actionError, setActionError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [queueExpanded, setQueueExpanded] = useState(true);
  const [announcement, setAnnouncement] = useState('');
  const tokenRef = useRef('');
  const eventSourceRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const inputRef = useRef(null);
  const previousStatusRef = useRef('');
  const qualityInitializedRef = useRef(false);
  const batchInitializedRef = useRef(false);

  const active = ACTIVE_STATES.has(job?.status);
  const formats = useMemo(() => normalizeFormats(config?.formats), [config?.formats]);
  const maxPlaylistItems = Number(config?.limits?.maxPlaylistItems) || 1;
  const maxBatchItems = Number(config?.limits?.maxBatchItems) || 20;
  const batchSizes = useMemo(() => {
    const sizes = [5, 10, 20].filter((size) => size <= maxBatchItems);
    if (!sizes.includes(maxBatchItems)) sizes.push(maxBatchItems);
    return [...new Set(sizes)].sort((left, right) => left - right);
  }, [maxBatchItems]);
  const batchOptions = useMemo(() => {
    const options = [];
    for (let start = 1; start <= maxPlaylistItems; start += batchSize) {
      options.push({ start, end: Math.min(maxPlaylistItems, start + batchSize - 1) });
    }
    return options;
  }, [batchSize, maxPlaylistItems]);
  const selectedBatch = batchOptions.find((batch) => batch.start === batchStart) || batchOptions[0];
  const destination = job?.destination || config?.destinationRoot || 'downloads';
  const appName = config?.appName || 'Playlist Downloader';
  const queueVisible = Boolean(url.trim() || job);

  const loadBootstrap = useCallback(async (force = false) => {
    const next = await requestBootstrap(force);
    tokenRef.current = next.csrfToken;
    setConfig(next);
    if (!qualityInitializedRef.current && next.defaultQuality) {
      setQuality(next.defaultQuality);
      qualityInitializedRef.current = true;
    }
    if (!batchInitializedRef.current && next.limits?.maxBatchItems) {
      setBatchSize(next.limits.maxBatchItems);
      setBatchStart(1);
      batchInitializedRef.current = true;
    }
    setServiceState('online');
    return next;
  }, []);

  const apiMutation = useCallback(async (path, body) => {
    if (!tokenRef.current) await loadBootstrap();
    const run = async () => fetch(path, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Playlist-Token': tokenRef.current,
      },
      body: JSON.stringify(body || {}),
    });

    let response = await run();
    if (response.status === 401 || response.status === 403) {
      await loadBootstrap(true);
      response = await run();
    }
    const payload = await readJson(response);
    if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status}).`);
    return payload;
  }, [loadBootstrap]);

  const fetchCurrentJob = useCallback(async () => {
    const response = await fetch('/api/job', {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    const payload = await readJson(response);
    if (!response.ok) throw new Error(payload?.error || 'Could not read the download queue.');
    if (payload.job) setJob(payload.job);
    return payload.job || null;
  }, []);

  const connectToJob = useCallback((jobId) => {
    if (!jobId) return;
    eventSourceRef.current?.close();
    clearTimeout(reconnectTimerRef.current);
    const events = new EventSource(`/api/events/${encodeURIComponent(jobId)}`);
    eventSourceRef.current = events;

    events.addEventListener('snapshot', (event) => {
      try {
        const next = JSON.parse(event.data);
        setJob(next);
        setServiceState('online');
        if (TERMINAL_STATES.has(next.status)) events.close();
      } catch {
        setActionError('The local service sent an unreadable progress update.');
      }
    });

    events.onerror = () => {
      events.close();
      fetchCurrentJob().then((current) => {
        if (current && ACTIVE_STATES.has(current.status)) {
          reconnectTimerRef.current = setTimeout(() => connectToJob(current.id), 1500);
        }
      }).catch(() => setServiceState('offline'));
    };
  }, [fetchCurrentJob]);

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem('playlist-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.title = appName;
  }, [appName]);

  useEffect(() => {
    if (active) setQueueExpanded(true);
  }, [active]);

  useEffect(() => {
    if (batchStart > maxPlaylistItems || !batchOptions.some((batch) => batch.start === batchStart)) {
      setBatchStart(batchOptions[0]?.start || 1);
    }
  }, [batchOptions, batchStart, maxPlaylistItems]);

  useEffect(() => {
    let live = true;
    Promise.all([loadBootstrap(), fetchCurrentJob()])
      .then(([, current]) => {
        if (!live) return;
        setActionError('');
        if (current && ACTIVE_STATES.has(current.status)) connectToJob(current.id);
      })
      .catch(() => {
        if (!live) return;
        setServiceState('offline');
      });
    return () => {
      live = false;
      clearTimeout(reconnectTimerRef.current);
      eventSourceRef.current?.close();
    };
  }, [connectToJob, fetchCurrentJob, loadBootstrap]);

  useEffect(() => {
    const status = job?.status || '';
    if (status && status !== previousStatusRef.current) {
      const messages = {
        preparing: 'Reading playlist details.',
        downloading: 'Playlist download started.',
        retrying: 'Retrying missing playlist items.',
        verifying: 'Verifying downloaded files.',
        completed: 'Playlist download completed and verified.',
        failed: 'Playlist download needs attention.',
        canceling: 'Stopping the playlist download safely.',
        cancelling: 'Stopping the playlist download safely.',
        cancelled: 'Playlist download cancelled.',
        canceled: 'Playlist download cancelled.',
      };
      setAnnouncement(messages[status] || `Queue status changed to ${status}.`);
      previousStatusRef.current = status;
    }
  }, [job?.status]);

  async function submit(event) {
    event.preventDefault();
    const validationMessage = validatePlaylistUrl(url);
    setFieldError(validationMessage);
    setActionError('');
    if (validationMessage) {
      inputRef.current?.focus();
      return;
    }

    setSubmitting(true);
    setQueueExpanded(true);
    try {
      const payload = await apiMutation('/api/download', {
        url: url.trim(), quality, startIndex: selectedBatch.start, batchSize,
      });
      if (!payload.job?.id) throw new Error('The local service did not create a download job.');
      setJob(payload.job);
      setServiceState('online');
      connectToJob(payload.job.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not start the download.');
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelJob() {
    setCancelling(true);
    setActionError('');
    try {
      const payload = await apiMutation('/api/cancel', { jobId: job?.id });
      if (payload.job) setJob(payload.job);
      else await fetchCurrentJob();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not cancel the download.');
    } finally {
      setCancelling(false);
    }
  }

  function selectBatch(start) {
    setBatchStart(start);
    setActionError('');
    setAnnouncement(`Batch starting at playlist item ${start} selected.`);
  }

  function selectNextBatch() {
    const nextStart = Number(job?.batch?.nextStart);
    if (!Number.isSafeInteger(nextStart)) return;
    selectBatch(nextStart);
    document.querySelector('.download-panel')?.scrollIntoView({ behavior: 'auto', block: 'center' });
  }

  const formDisabled = active || submitting;
  const selectedBatchLabel = `${selectedBatch?.start || 1}-${selectedBatch?.end || batchSize}`;
  const nextBatchEnd = Math.min(maxPlaylistItems, Number(job?.batch?.nextStart || 1) + batchSize - 1);
  const nextBatchLabel = `${job?.batch?.nextStart || 1}-${nextBatchEnd}`;
  const buttonText = submitting || job?.status === 'preparing'
    ? 'Starting...'
    : active ? 'Download running' : `Download batch ${selectedBatchLabel}`;
  const completedBatchKeys = new Set((job?.completedBatches || []).map((batch) => `${batch.start}-${batch.end}`));

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="titlebar__inner content-width">
          <a className="brand" href="/" aria-label={`${appName} home`}>
            <span className="brand-mark" aria-hidden="true"><DownloadIcon size={18} /></span>
            <span>{appName}</span>
          </a>
          <div className="titlebar__controls">
            <div className="service-status" data-status={serviceState} role="status" aria-label={`Download service ${serviceState}`}>
              <span className="service-dot" aria-hidden="true" />
              <span>{serviceState}</span>
            </div>
            <ThemeSwitcher theme={theme} onChange={setTheme} />
          </div>
        </div>
      </header>

      <main className="content-width main-content">
        <section className="intro" aria-labelledby="page-title">
          <h1 id="page-title">Download playlists with yt-dlp.</h1>
          <p>Queue, resume, and verify every file from one focused interface.</p>
        </section>

        <form className="download-panel" onSubmit={submit} noValidate>
          <div className="field-group url-field">
            <label htmlFor="playlist-url">Playlist URL</label>
            <div className="primary-form-row">
              <input
                ref={inputRef}
                id="playlist-url"
                name="playlist-url"
                type="url"
                inputMode="url"
                autoComplete="url"
                spellCheck="false"
                placeholder="https://www.youtube.com/playlist?list=..."
                value={url}
                disabled={formDisabled}
                aria-invalid={Boolean(fieldError)}
                aria-describedby={fieldError ? 'playlist-url-error' : undefined}
                onChange={(event) => {
                  setUrl(event.target.value);
                  if (fieldError) setFieldError('');
                }}
              />
              <button className="primary-button download-button" type="submit" disabled={formDisabled || serviceState === 'offline'}>
                <DownloadIcon size={16} />
                <span>{buttonText}</span>
              </button>
            </div>
            {fieldError && <p className="field-error" id="playlist-url-error" role="alert">{fieldError}</p>}
          </div>

          <div className="options-row">
            <div className="field-group">
              <label htmlFor="download-format">Format</label>
              <select
                id="download-format"
                value={quality}
                disabled={formDisabled}
                onChange={(event) => {
                  qualityInitializedRef.current = true;
                  setQuality(event.target.value);
                }}
              >
                {formats.map((format) => <option key={format.value} value={format.value}>{format.label}</option>)}
              </select>
            </div>
            <div className="field-group">
              <label htmlFor="batch-size">Batch size</label>
              <select
                id="batch-size"
                value={batchSize}
                disabled={formDisabled}
                onChange={(event) => {
                  setBatchSize(Number(event.target.value));
                  setBatchStart(1);
                  setActionError('');
                }}
              >
                {batchSizes.map((size) => <option key={size} value={size}>{size} videos</option>)}
              </select>
            </div>
            <div className="field-group destination-field">
              <label htmlFor="download-destination">Destination</label>
              <input id="download-destination" type="text" value={destination} readOnly aria-readonly="true" />
            </div>
          </div>
          <div className="batch-navigation" aria-labelledby="batch-navigation-title">
            <div className="batch-navigation__heading">
              <span id="batch-navigation-title">Playlist batches</span>
              <span>Choose one range at a time</span>
            </div>
            <div className="batch-options">
              {batchOptions.map((batch) => {
                const key = `${batch.start}-${batch.end}`;
                const isCurrent = Number(job?.batch?.start) === batch.start;
                const state = completedBatchKeys.has(key) || (isCurrent && job?.status === 'completed')
                  ? 'done'
                  : isCurrent && active
                    ? 'running'
                    : isCurrent && job?.status === 'failed'
                      ? 'retry'
                      : batchStart === batch.start ? 'selected' : 'queued';
                const stateLabel = {
                  done: 'DONE', running: 'RUN', retry: 'RETRY', selected: 'SELECTED', queued: 'WAIT',
                }[state];
                return (
                  <button
                    className="batch-option"
                    data-state={state}
                    key={key}
                    type="button"
                    disabled={formDisabled}
                    aria-pressed={batchStart === batch.start}
                    aria-label={`Playlist items ${batch.start} through ${batch.end}: ${stateLabel.toLowerCase()}`}
                    onClick={() => selectBatch(batch.start)}
                  >
                    <span>{batch.start}-{batch.end}</span>
                    <small>{stateLabel}</small>
                  </button>
                );
              })}
            </div>
          </div>
          {config?.limits && (
            <p className="config-note">
              Up to {config.limits.maxPlaylistItems} videos / {config.limits.maxBatchItems} per batch / {config.limits.maxTotalDurationHours}h and {config.limits.maxDownloadGiB} GiB safety limits
            </p>
          )}
        </form>

        {serviceState === 'offline' && (
          <ErrorBanner title="Download service unavailable">
            The page cannot reach the download backend. Confirm the service is running at this origin, then reload.
          </ErrorBanner>
        )}
        {actionError && <ErrorBanner title="The request could not be completed">{actionError}</ErrorBanner>}
        {job?.status === 'failed' && job.error && <ErrorBanner title="Download stopped">{job.error}</ErrorBanner>}

        {queueVisible && (
          <QueuePanel
            job={job}
            onCancel={cancelJob}
            cancelling={cancelling}
            expanded={queueExpanded}
            onToggle={() => setQueueExpanded((value) => !value)}
            onSelectNextBatch={selectNextBatch}
            nextBatchLabel={nextBatchLabel}
          />
        )}
        <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
      </main>

      <footer className="footer">
        <div className="content-width footer__inner">
          <div className="footer-copy">
            <span>Powered by yt-dlp</span>
            <span className="version-tag">{config?.version ? `v${config.version}` : 'version loading'}</span>
          </div>
          {config?.repositoryUrl && (
            <a
              className="github-link"
              href={config.repositoryUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open the ${appName} GitHub repository`}
              title="Project repository"
            >
              <GitHubIcon size={18} />
            </a>
          )}
        </div>
      </footer>
    </div>
  );
}
