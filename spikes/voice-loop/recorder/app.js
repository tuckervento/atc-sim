// Recorder page (task 0.2). Shows one script line at a time. Hold Space to record it, release to
// save it to test-set/audio/NN.webm via the local server. Re-recording a line overwrites it.

const MIME = 'audio/webm;codecs=opus';
const MIN_TAKE_MS = 400; // shorter holds are treated as accidental taps and not saved
const SILENT_PEAK = 0.02; // a take whose loudest sample is below this is probably the wrong mic
const CLIP_PEAK = 0.98;

const $ = (sel) => document.querySelector(sel);

const state = {
  lines: [],
  recorded: {}, // num -> { bytes, mtimeMs }
  index: 0,
  stream: null,
  analyser: null,
  recorder: null,
  chunks: [],
  startedAt: 0,
  heldMs: 0,
  takePeak: 0,
  cancelReason: null,
  saving: false,
};

const current = () => state.lines[state.index];

function setStatus(kind, text) {
  const el = $('#status');
  el.className = kind;
  el.textContent = text;
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// ---------- loading and rendering ----------

async function loadLines() {
  const res = await fetch('/api/lines', { cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `GET /api/lines failed with HTTP ${res.status}`);
  state.lines = body.lines;
  state.recorded = body.recorded;
}

function render() {
  const line = current();
  $('#num').textContent = line.num;
  $('#count').textContent = `line ${state.index + 1} of ${state.lines.length}`;
  $('#tags').textContent = `${line.types.join(', ')} · ${line.style}`;
  $('#context').textContent = line.context ? `Context: ${line.context}` : '';
  $('#context').hidden = !line.context;
  $('#say').textContent = line.say;
  $('#readback').textContent = line.readback;
  renderGrid();
  renderProgress();
  updatePlayer();
}

function renderGrid() {
  const grid = $('#grid');
  grid.replaceChildren(
    ...state.lines.map((line, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = line.num;
      b.title = `${state.recorded[line.num] ? 'Recorded' : 'Not recorded'}: ${line.say}`;
      if (state.recorded[line.num]) b.classList.add('done');
      if (i === state.index) b.classList.add('current');
      b.addEventListener('click', () => {
        b.blur(); // keep Space from "clicking" this button later
        goTo(i);
      });
      return b;
    }),
  );
}

function renderProgress() {
  const done = state.lines.filter((l) => state.recorded[l.num]).length;
  $('#progress').textContent = `Recorded ${done} of ${state.lines.length}`;
}

function updatePlayer() {
  const line = current();
  const rec = state.recorded[line.num];
  const player = $('#player');
  player.pause();
  if (rec) {
    player.src = `/api/recordings/${line.num}?v=${rec.mtimeMs}`;
  } else {
    player.removeAttribute('src');
    player.load();
  }
}

function goTo(i) {
  if (state.recorder || state.saving) {
    setStatus('warn', 'Finish the current take before changing lines.');
    return;
  }
  state.index = Math.max(0, Math.min(state.lines.length - 1, i));
  render();
  const line = current();
  if (state.stream) {
    setStatus('idle', state.recorded[line.num]
      ? `Line ${line.num} already has a recording (${kb(state.recorded[line.num].bytes)}). P plays it; holding Space re-records it.`
      : `Line ${line.num}: hold Space and read the line.`);
  }
}

// ---------- microphone and level meter ----------

async function enableMic() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported(MIME)) {
    setStatus('error', `This browser can't record ${MIME}. Use Chrome.`);
    return;
  }
  try {
    // Browser-default processing (echo cancellation, noise suppression, auto gain), the same
    // defaults a live push-to-talk page would get.
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    setStatus('error', `Microphone unavailable (${err.name}: ${err.message}). Allow microphone access for this site in Chrome (lock/tune icon in the address bar), then reload.`);
    return;
  }
  const track = state.stream.getAudioTracks()[0];
  $('#mic-label').textContent = `Mic: ${track.label || 'unknown device'}`;
  track.addEventListener('ended', () => setStatus('error', 'Microphone disconnected. Reload the page.'));

  const ctx = new AudioContext();
  state.analyser = ctx.createAnalyser();
  state.analyser.fftSize = 1024;
  ctx.createMediaStreamSource(state.stream).connect(state.analyser);
  drawMeter();

  $('#start').hidden = true;
  goTo(state.index);
}

function drawMeter() {
  const buf = new Float32Array(state.analyser.fftSize);
  const fill = $('#meter-fill');
  const frame = () => {
    state.analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
    if (state.recorder) state.takePeak = Math.max(state.takePeak, peak);
    const db = peak > 0 ? 20 * Math.log10(peak) : -60; // show -60..0 dBFS
    fill.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
    fill.classList.toggle('clip', peak >= CLIP_PEAK);
    if (state.recorder) {
      const secs = ((performance.now() - state.startedAt) / 1000).toFixed(1);
      setStatus('recording', `Recording line ${current().num}… ${secs} s (release Space to save, Esc to cancel)`);
    }
    requestAnimationFrame(frame);
  };
  frame();
}

// ---------- takes ----------

function startTake() {
  if (!state.stream) {
    setStatus('error', 'Click "Enable microphone" first.');
    return;
  }
  if (state.recorder || state.saving) return;
  const line = current();
  const rec = new MediaRecorder(state.stream, { mimeType: MIME });
  state.chunks = [];
  state.cancelReason = null;
  state.takePeak = 0;
  rec.ondataavailable = (ev) => {
    if (ev.data.size > 0) state.chunks.push(ev.data);
  };
  rec.onstop = () => finishTake(line, rec);
  rec.onerror = (ev) => setStatus('error', `Recorder error: ${ev.error?.name ?? 'unknown'}: ${ev.error?.message ?? ''}`);
  $('#player').pause();
  rec.start();
  state.recorder = rec;
  state.startedAt = performance.now();
}

function stopTake() {
  if (!state.recorder || state.recorder.state !== 'recording') return;
  state.heldMs = performance.now() - state.startedAt;
  state.recorder.stop();
}

function cancelTake(reason) {
  if (!state.recorder || state.recorder.state !== 'recording') return;
  state.cancelReason = reason;
  state.recorder.stop();
}

async function finishTake(line, rec) {
  state.recorder = null;
  if (state.cancelReason) {
    setStatus('warn', `Line ${line.num} not saved: ${state.cancelReason}. Any earlier take is unchanged.`);
    return;
  }
  const secs = (state.heldMs / 1000).toFixed(1);
  if (state.heldMs < MIN_TAKE_MS) {
    setStatus('warn', `Line ${line.num} not saved: only ${secs} s (treated as an accidental tap). Any earlier take is unchanged.`);
    return;
  }
  const blob = new Blob(state.chunks, { type: rec.mimeType || MIME });
  state.saving = true;
  setStatus('saving', `Saving line ${line.num} (${secs} s, ${kb(blob.size)})…`);
  try {
    const res = await fetch(`/api/recordings/${line.num}`, {
      method: 'POST',
      headers: { 'content-type': blob.type },
      body: blob,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    state.recorded[line.num] = { bytes: body.bytes, mtimeMs: Date.now() };
    renderGrid();
    renderProgress();
    if (current().num === line.num) updatePlayer();
    let note = 'P to play it back, Space to re-record, → for the next line.';
    if (state.takePeak < SILENT_PEAK) note = 'WARNING: this take looks silent. Check the mic shown above, then re-record.';
    else if (state.takePeak >= CLIP_PEAK) note = 'WARNING: the level hit the top (clipping). Back off the mic a little and re-record.';
    setStatus(note.startsWith('WARNING') ? 'warn' : 'saved', `Saved ${body.file} (${secs} s, ${kb(body.bytes)}). ${note}`);
  } catch (err) {
    setStatus('error', `Saving line ${line.num} failed: ${err.message}. Nothing was saved; record it again.`);
  } finally {
    state.saving = false;
  }
}

function play() {
  const line = current();
  if (!state.recorded[line.num]) {
    setStatus('warn', `Line ${line.num} has no recording yet.`);
    return;
  }
  $('#player').play().catch((err) => setStatus('error', `Playback failed: ${err.name}: ${err.message}`));
}

// ---------- keys ----------

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault(); // no page scroll, no button activation
    if (!e.repeat) startTake();
    return;
  }
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'ArrowRight') goTo(state.index + 1);
  else if (e.code === 'ArrowLeft') goTo(state.index - 1);
  else if (e.code === 'KeyP') play();
  else if (e.code === 'Escape') cancelTake('cancelled with Esc');
}, { capture: true });

window.addEventListener('keyup', (e) => {
  if (e.code !== 'Space') return;
  e.preventDefault();
  stopTake();
}, { capture: true });

// If focus leaves the page mid-take, the Space keyup never arrives, so cancel the take.
window.addEventListener('blur', () => cancelTake('the window lost focus while recording'));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) cancelTake('the tab was hidden while recording');
});

// ---------- start ----------

$('#start').addEventListener('click', (e) => {
  e.currentTarget.blur();
  enableMic();
});

try {
  await loadLines();
  const firstMissing = state.lines.findIndex((l) => !state.recorded[l.num]);
  state.index = firstMissing === -1 ? 0 : firstMissing;
  render();
} catch (err) {
  setStatus('error', `Could not load the script: ${err.message}`);
  $('#start').disabled = true;
}
