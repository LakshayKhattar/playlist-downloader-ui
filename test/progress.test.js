import assert from 'node:assert/strict';
import test from 'node:test';
import { createLineReader, parseDownloaderLine } from '../server/progress.js';
import { runCapture, runStreaming } from '../server/processes.js';
import {
  buildDownloadArgs,
  buildPreflightArgs,
  classifyDownloaderFailure,
  idFromFilename,
  indexFromFilename,
  JobManager,
  shouldRetryDownloaderFailure,
} from '../server/job-manager.js';

test('parses validated JSON item, progress, postprocess, and file markers', () => {
  assert.deepEqual(
    parseDownloaderLine('APP_ITEM_JSON|{"playlist_index":3,"playlist_count":61,"id":"abcdefghijk","title":"A title | with a pipe"}'),
    { type: 'item', index: 3, total: 61, id: 'abcdefghijk', title: 'A title | with a pipe' },
  );
  assert.deepEqual(
    parseDownloaderLine('APP_PROGRESS_JSON|{"info":{"id":"abcdefghijk","title":"A title","playlist_index":3,"playlist_count":61},"progress":{"downloaded_bytes":250,"total_bytes":1000,"speed":8192,"eta":10}}'),
    {
      type: 'progress', index: 3, total: 61, id: 'abcdefghijk', title: 'A title', percent: 25, speed: 8192, eta: 10,
    },
  );
  assert.deepEqual(
    parseDownloaderLine('APP_PROGRESS_JSON|{"info.id":"abcdefghijk","info.title":"A title","info.playlist_index":3,"info.playlist_count":61,"progress.downloaded_bytes":500,"progress.total_bytes":null,"progress.total_bytes_estimate":1000,"progress.speed":4096,"progress.eta":5}'),
    {
      type: 'progress', index: 3, total: 61, id: 'abcdefghijk', title: 'A title', percent: 50, speed: 4096, eta: 5,
    },
  );
  assert.deepEqual(
    parseDownloaderLine('APP_POST_JSON|{"info.id":"abcdefghijk","info.title":"A title","info.playlist_index":3,"progress.status":"processing","progress.postprocessor":"Merger"}'),
    {
      type: 'postprocess', index: 3, total: 0, id: 'abcdefghijk', title: 'A title', percent: null, speed: '', eta: '', status: 'processing', postprocessor: 'Merger',
    },
  );
  assert.deepEqual(
    parseDownloaderLine('APP_FILE_JSON|{"playlist_index":3,"playlist_count":61,"id":"abcdefghijk","title":"A title","filepath":"C:\\\\Videos\\\\03 - title [abcdefghijk].mkv"}'),
    {
      type: 'done', index: 3, total: 61, id: 'abcdefghijk', title: 'A title', filePath: 'C:\\Videos\\03 - title [abcdefghijk].mkv',
    },
  );
});

test('rejects malformed JSON markers rather than reinterpreting them', () => {
  for (const line of [
    'APP_ITEM_JSON|{"index":3,"id":"../escape","title":"bad"}',
    'APP_PROGRESS_JSON|{"index":3,"percent":25}',
    'APP_PROGRESS_JSON|{"index":3,"percent":101}',
    'APP_PROGRESS_JSON|{"index":3,"percent":false}',
    'APP_FILE_JSON|{"filePath":"C:\\\\safe\\\\bad\\npath.mkv"}',
    'APP_ITEM_JSON|not-json',
    'APP_DONE|3|61|abcdefghijk|C:\\Videos\\legacy.mkv',
  ]) {
    assert.deepEqual(parseDownloaderLine(line), { type: 'log', line });
  }
});

test('line reader preserves split UTF-8, handles carriage returns, and drops oversized lines', () => {
  const lines = [];
  const overflows = [];
  const reader = createLineReader((line) => lines.push(line), {
    maxLineBytes: 10,
    onOverflow: (error) => overflows.push(error.code),
  });
  const utf8 = Buffer.from('café\r');
  reader.push(utf8.subarray(0, 4));
  reader.push(utf8.subarray(4));
  reader.push(Buffer.from('01234567890\nok\nlast'));
  reader.flush();
  assert.deepEqual(lines, ['café', 'ok', 'last']);
  assert.deepEqual(overflows, ['ERR_CHILD_LINE_TOO_LONG']);
});

test('captured child output is bounded and receives a minimal environment', async () => {
  const secretName = 'PLAYLIST_PROCESS_TEST_SECRET';
  const previous = process.env[secretName];
  process.env[secretName] = 'must-not-leak';
  try {
    const result = await runCapture(
      process.execPath,
      ['-e', `process.stdout.write(process.env.${secretName} || 'clean')`],
      { timeoutMs: 5_000, maxOutput: 100 },
    );
    assert.equal(result.stdout, 'clean');
  } finally {
    if (previous === undefined) delete process.env[secretName];
    else process.env[secretName] = previous;
  }

  await assert.rejects(
    runCapture(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096))'], {
      timeoutMs: 5_000,
      maxOutput: 64,
    }),
    (error) => error.code === 'ERR_CHILD_OUTPUT_LIMIT',
  );
});

test('streaming child processes honor abort, total, and inactivity limits', async () => {
  const controller = new AbortController();
  const aborted = runStreaming(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    signal: controller.signal,
    timeoutMs: 5_000,
    inactivityMs: 5_000,
    maxOutput: 1_024,
  });
  setTimeout(() => controller.abort(new Error('test abort')), 50);
  await assert.rejects(aborted, (error) => error.name === 'AbortError' && error.code === 'ABORT_ERR');

  await assert.rejects(
    runStreaming(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 5_000,
      inactivityMs: 50,
      maxOutput: 1_024,
    }),
    (error) => error.code === 'ERR_CHILD_INACTIVITY_TIMEOUT',
  );

  await assert.rejects(
    runStreaming(process.execPath, ['-e', 'setInterval(() => process.stdout.write("."), 10)'], {
      timeoutMs: 75,
      inactivityMs: 1_000,
      maxOutput: 1_024,
    }),
    (error) => error.code === 'ERR_CHILD_TIMEOUT',
  );
});

test('download arguments preserve failure signals and final MKV output', () => {
  const args = buildDownloadArgs({
    url: 'https://www.youtube.com/playlist?list=PL1234567890',
    outputDirectory: 'C:\\Downloads',
    archivePath: 'C:\\Downloads\\.download-archive.txt',
    startIndex: 21,
    endIndex: 40,
  });
  assert.ok(args.includes('--no-abort-on-error'));
  assert.ok(args.includes('--abort-on-unavailable-fragments'));
  assert.ok(args.includes('--check-formats'));
  assert.ok(args.includes('--no-remote-components'));
  assert.ok(args.includes('--remux-video'));
  assert.ok(!args.includes('--ignore-errors'));
  assert.equal(args[args.indexOf('--playlist-start') + 1], '21');
  assert.equal(args[args.indexOf('--playlist-end') + 1], '40');
  assert.equal(args[args.indexOf('--max-downloads') + 1], '20');
  assert.match(args[args.indexOf('--output') + 1], /%\(playlist_index\)03d - \[%\(id\)s\]/);
});

test('preflight discovers the real playlist length and progress uses batch positions', () => {
  const args = buildPreflightArgs('https://www.youtube.com/playlist?list=PL1234567890');
  assert.equal(args[args.indexOf('--playlist-start') + 1], '1');
  assert.equal(args[args.indexOf('--playlist-end') + 1], '501');

  const jobs = Object.create(JobManager.prototype);
  jobs.job = { items: [{ id: 'abcdefghijk', index: 21 }, { id: 'lmnopqrstuv', index: 22 }] };
  assert.equal(jobs.batchPosition({ index: 21 }), 1);
  assert.equal(jobs.batchPosition({ id: 'lmnopqrstuv' }), 2);
});

test('yt-dlp diagnostics become safe actionable public failures', () => {
  assert.deepEqual(
    classifyDownloaderFailure('ERROR: Sign in to confirm you are not a bot'),
    {
      code: 'YOUTUBE_ACCESS_BLOCKED',
      message: 'YouTube rejected this server\'s shared cloud IP before media transfer started. A free Render service cannot reliably repair this response. Run the app locally so yt-dlp uses your normal connection.',
    },
  );
  assert.equal(shouldRetryDownloaderFailure('YOUTUBE_ACCESS_BLOCKED'), false);
  assert.equal(shouldRetryDownloaderFailure('NETWORK_FAILURE'), true);
  assert.equal(classifyDownloaderFailure('ERROR: HTTP Error 403: Forbidden').code, 'YOUTUBE_MEDIA_FORBIDDEN');
  assert.equal(classifyDownloaderFailure('ERROR: Requested format is not available').code, 'FORMAT_UNAVAILABLE');
  assert.equal(classifyDownloaderFailure('unexpected extractor failure').code, 'YTDLP_FAILED');
});

test('media identity survives new names and resumes legacy truncated names by playlist index', () => {
  assert.equal(idFromFilename('005 - [abcdefghijk] A long title.mkv'), 'abcdefghijk');
  assert.equal(idFromFilename('005 - A title [abcdefghijk].mkv'), 'abcdefghijk');
  assert.equal(idFromFilename('005 - A title without the suffix.mkv'), null);
  assert.equal(indexFromFilename('005 - A title without the suffix.mkv'), 5);
});
