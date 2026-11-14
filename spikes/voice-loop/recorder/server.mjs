// Test-set recorder server (task 0.2). Zero dependencies: node: built-ins only.
//
//   node spikes/voice-loop/recorder/server.mjs          # then open the printed URL in Chrome
//   PORT=8741 node spikes/voice-loop/recorder/server.mjs
//
// Serves the recorder page, the script lines as JSON (parsed from test-set/script.md on every
// request, so edits show up on reload), and saves uploads to test-set/audio/NN.webm.
//
// Routes:
//   GET  /, /app.js, /style.css   the page (fixed whitelist, no filesystem paths from the URL)
//   GET  /api/lines               { script, lines: [...], recorded: { "01": { bytes, mtimeMs } } }
//   POST /api/recordings/NN       body = WebM audio; NN must be a line in script.md
//   GET  /api/recordings/NN       the saved recording, for playback

import { createServer } from 'node:http';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScript } from './script.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(HERE, '../test-set/script.md');
const AUDIO_DIR = resolve(HERE, '../test-set/audio');
const HOST = '127.0.0.1'; // localhost is a secure context, so getUserMedia works over plain http
const PORT = parsePort(process.env.PORT ?? '8740');
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]); // blocks DNS rebinding

// A line is under ~10 s. Chrome's default Opus bitrate is roughly 16 KB/s, so 4 MB is several
// minutes of audio: generous for a held key, small enough to stop runaway uploads.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const LINE_NUM = /^\d{2}$/;
const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]); // every WebM file starts with these

const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

class HttpError extends Error {
  constructor(status, message, { closeConnection = false } = {}) {
    super(message);
    this.status = status;
    this.closeConnection = closeConnection;
  }
}

function parsePort(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`PORT must be an integer from 1 to 65535, got ${JSON.stringify(raw)}`);
    process.exit(1);
  }
  return n;
}

const rel = (p) => relative(process.cwd(), p) || '.';

async function loadLines() {
  return parseScript(await readFile(SCRIPT_PATH, 'utf8'));
}

async function listRecordings(nums) {
  let names;
  try {
    names = new Set(await readdir(AUDIO_DIR));
  } catch (err) {
    if (err.code === 'ENOENT') return {}; // nothing recorded yet; the dir is created on first save
    throw err;
  }
  const out = {};
  for (const num of nums) {
    if (!names.has(`${num}.webm`)) continue;
    const s = await stat(join(AUDIO_DIR, `${num}.webm`));
    out[num] = { bytes: s.size, mtimeMs: Math.round(s.mtimeMs) };
  }
  return out;
}

// Accepts only a two-digit number that is a line in the current script.md. The raw path segment
// is never decoded or joined into a path before this passes, so "../x", "%2e%2e%2fx" etc. die here.
async function audioPathFor(rawNum) {
  if (!LINE_NUM.test(rawNum)) {
    throw new HttpError(400, `bad line number ${JSON.stringify(rawNum)}: expected two digits, e.g. "07"`);
  }
  const lines = await loadLines();
  if (!lines.some((l) => l.num === rawNum)) {
    throw new HttpError(404, `line ${rawNum} is not in script.md (it has ${lines.map((l) => l.num).join(', ')})`);
  }
  const file = join(AUDIO_DIR, `${rawNum}.webm`);
  if (dirname(file) !== AUDIO_DIR) throw new HttpError(400, `refusing path outside audio dir: ${file}`);
  return { num: rawNum, file };
}

function checkDeclaredLength(req) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, `upload is ${declared} bytes; the limit is ${MAX_UPLOAD_BYTES}`, {
      closeConnection: true,
    });
  }
}

function readBody(req) {
  checkDeclaredLength(req);
  // Chunked uploads have no Content-Length, so count as we go. On overflow keep draining (so the
  // client can read our 413 instead of getting a reset) but stop buffering.
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total <= MAX_UPLOAD_BYTES) chunks.push(chunk);
      else chunks.length = 0;
    });
    req.on('end', () => {
      if (total > MAX_UPLOAD_BYTES) {
        reject(new HttpError(413, `upload is ${total} bytes; the limit is ${MAX_UPLOAD_BYTES}`));
      } else {
        resolveBody(Buffer.concat(chunks));
      }
    });
    req.on('error', reject);
  });
}

async function saveRecording(req, res, rawNum) {
  const { num, file } = await audioPathFor(rawNum);
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'audio/webm') {
    throw new HttpError(415, `Content-Type must be audio/webm, got ${JSON.stringify(req.headers['content-type'] ?? '')}`);
  }
  const body = await readBody(req);
  if (body.length === 0) throw new HttpError(400, 'empty upload');
  if (body.length < 4 || !body.subarray(0, 4).equals(EBML_MAGIC)) {
    throw new HttpError(415, 'upload is not a WebM file (missing EBML header bytes 1A 45 DF A3)');
  }

  await mkdir(AUDIO_DIR, { recursive: true });
  // Write then rename, so a failed write never leaves a truncated NN.webm behind.
  const partial = join(AUDIO_DIR, `.${num}.webm.partial`);
  try {
    await writeFile(partial, body);
    await rename(partial, file); // overwrites an earlier take of the same line
  } catch (err) {
    await unlink(partial).catch((e) => {
      if (e.code !== 'ENOENT') console.error(`could not remove ${partial}:`, e);
    });
    throw err;
  }
  console.log(`saved ${rel(file)} (${body.length} bytes)`);
  sendJson(res, 200, { ok: true, num, bytes: body.length, file: rel(file) });
}

async function sendRecording(res, rawNum) {
  const { num, file } = await audioPathFor(rawNum);
  let data;
  try {
    data = await readFile(file);
  } catch (err) {
    if (err.code === 'ENOENT') throw new HttpError(404, `line ${num} has no recording yet`);
    throw err;
  }
  res.writeHead(200, { 'content-type': 'audio/webm', 'content-length': data.length, 'cache-control': 'no-store' });
  res.end(data);
}

function sendJson(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

async function route(req, res) {
  if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) {
    throw new HttpError(403, `unexpected Host ${JSON.stringify(req.headers.host)}; open http://${HOST}:${PORT}/`);
  }
  // WHATWG URL parsing resolves dot segments ("/api/recordings/../x" becomes "/api/x").
  const { pathname } = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

  if (STATIC.has(pathname)) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, `${req.method} not allowed on ${pathname}`);
    const [name, type] = STATIC.get(pathname);
    const data = await readFile(join(HERE, name));
    res.writeHead(200, { 'content-type': type, 'content-length': data.length, 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : data);
    return;
  }

  if (pathname === '/favicon.ico') {
    res.writeHead(204, { 'cache-control': 'max-age=86400' }); // Chrome asks on every load; nothing to send
    res.end();
    return;
  }

  if (pathname === '/api/lines') {
    if (req.method !== 'GET') throw new HttpError(405, `${req.method} not allowed on ${pathname}`);
    const lines = await loadLines();
    const recorded = await listRecordings(lines.map((l) => l.num));
    sendJson(res, 200, { script: rel(SCRIPT_PATH), lines, recorded });
    return;
  }

  const m = pathname.match(/^\/api\/recordings\/([^/]*)$/);
  if (m) {
    if (req.method === 'POST') return saveRecording(req, res, m[1]);
    if (req.method === 'GET') return sendRecording(res, m[1]);
    throw new HttpError(405, `${req.method} not allowed on ${pathname}`);
  }

  throw new HttpError(404, `no route for ${req.method} ${pathname}`);
}

function handle(req, res) {
  route(req, res).catch((err) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(`${req.method} ${req.url} -> 500`, err);
    else console.warn(`${req.method} ${req.url} -> ${status}: ${err.message}`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendJson(res, status, { ok: false, error: err.message }, err.closeConnection ? { connection: 'close' } : {});
    req.resume(); // discard any unread request body
  });
}

const server = createServer(handle);

// curl (not browsers) sends "Expect: 100-continue" for large bodies. Refuse oversized uploads
// before the client sends them; otherwise continue as normal.
server.on('checkContinue', (req, res) => {
  try {
    checkDeclaredLength(req);
  } catch (err) {
    console.warn(`${req.method} ${req.url} -> ${err.status}: ${err.message}`);
    sendJson(res, err.status, { ok: false, error: err.message }, { connection: 'close' });
    return;
  }
  res.writeContinue();
  handle(req, res);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} on ${HOST} is already in use. Is the recorder already running?`);
    console.error(`Stop it, or pick another port: PORT=${PORT + 1} node ${rel(fileURLToPath(import.meta.url))}`);
  } else {
    console.error('server error:', err);
  }
  process.exit(1);
});

let startupLines;
try {
  startupLines = await loadLines();
} catch (err) {
  console.error(`Cannot start: ${rel(SCRIPT_PATH)}: ${err.message}`);
  process.exit(1);
}

server.listen(PORT, HOST, async () => {
  const recorded = await listRecordings(startupLines.map((l) => l.num));
  console.log(`Recorder: http://${HOST}:${PORT}/`);
  console.log(`  script: ${rel(SCRIPT_PATH)} (${startupLines.length} lines)`);
  console.log(`  audio:  ${rel(AUDIO_DIR)} (${Object.keys(recorded).length} of ${startupLines.length} recorded)`);
  console.log('Open the URL in Chrome. Ctrl+C to stop.');
});
