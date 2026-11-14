// Live loop page (task 0.6). Hold Space to talk; the mic audio goes to the local server as
// 16 kHz PCM16 in 20 ms chunks; the pilot's readback streams back and plays as it arrives.
// No API keys ever reach this page: the server holds them and calls the providers.
//
// End-to-end clock (PRD §6.3): from the Space keyup to the moment the first readback sample is
// output, on this page's clock. The output moment is mapped from the AudioContext schedule time
// with getOutputTimestamp(), so it includes the audio device's output latency.

const STT_LABELS = { nova3: "Deepgram Nova-3", u36pro: "AssemblyAI Universal-3.6 Pro" };
const TTS_LABELS = {
  elevenlabs: "ElevenLabs Flash v2.5 (HTTP)",
  "cartesia-ws": "Cartesia sonic-3.6 (WebSocket)",
  "cartesia-http": "Cartesia sonic-3.6 (HTTP)",
};
const MIN_HOLD_MS = 300; // shorter holds are treated as accidental taps
const LEAD_S = 0.005; // scheduling margin for the first chunk of a readback
const AUDIO_FRAME = 1;

const $ = (sel) => document.querySelector(sel);

const state = {
  ws: null,
  hello: null,
  cards: [],
  index: 0,
  micReady: false,
  capCtx: null,
  node: null,
  playCtx: null,
  // Current push-to-talk: { clientId, downAt, serverId, cardId }
  talking: null,
  nextClientId: 0,
  // server id -> { cardId, releaseAt, firstChunkAt, timing, done, logged, row }
  txs: new Map(),
  pendingRelease: new Map(), // clientId -> releaseAt, until the server id is known
  lastTx: null, // server id of the latest transmission (Y/N applies to it once it's logged)
  verdicts: new Map(), // server id -> true/false
  // playback: FIFO of { id, chunks, started, ended, endTime, kind }
  playQueue: [],
  playEnd: 0,
};

// ---------- UI ----------

function setStatus(kind, text) {
  const el = $("#status");
  el.className = kind;
  el.textContent = text;
}

function showError(where, message) {
  const box = $("#errors-box");
  box.hidden = false;
  const li = document.createElement("li");
  li.textContent = `${new Date().toLocaleTimeString()} [${where}] ${message}`;
  $("#errors").prepend(li);
  while ($("#errors").children.length > 8) $("#errors").lastChild.remove();
}

function banner(text) {
  const b = $("#banner");
  b.hidden = !text;
  b.textContent = text || "";
}

function currentCard() {
  return state.cards[state.index];
}

function renderCard() {
  const c = currentCard();
  if (!c) return;
  $("#card-id").textContent = c.id;
  $("#card-count").textContent = `card ${state.index + 1} of ${state.cards.length}`;
  $("#card-types").textContent = c.types.join(", ");
  $("#situation").textContent = c.situation;
  $("#wrong").hidden = !c.wrongReadback;
  $("#wrong-text").textContent = c.wrongReadback || "";
  $("#combo").textContent = `Speech-to-text: ${STT_LABELS[c.combo.stt]} · Voice: ${TTS_LABELS[c.combo.tts]}, ${c.voice}`;
  renderProgress();
}

function renderProgress() {
  const judged = new Set();
  for (const [id, v] of state.verdicts) {
    const tx = state.txs.get(id);
    if (tx && v !== undefined) judged.add(tx.cardId);
  }
  $("#progress").textContent = state.cards.length ? `${judged.size} of ${state.cards.length} cards marked Y/N` : "";
}

function fmt(ms) {
  return ms === null || ms === undefined ? "–" : `${Math.round(ms)} ms`;
}

function renderResult(id) {
  const tx = state.txs.get(id);
  if (!tx) return;
  $("#result").hidden = false;
  $("#r-heard").textContent = tx.transcript ?? "…";
  const cmd = $("#r-command");
  cmd.textContent = tx.command === undefined ? "…" : tx.command.valid ? tx.command.terse : `(not understood: ${tx.command.invalidReason})`;
  const exp = $("#r-expected");
  exp.textContent = "";
  if (tx.command && tx.command.expected) {
    exp.append(tx.command.expected, " ");
    const m = document.createElement("span");
    m.className = tx.command.exact ? "match" : "miss";
    m.textContent = tx.command.exact ? "match" : "different";
    exp.append(m);
  }
  $("#r-readback").textContent = tx.readback ? `"${tx.readback.text}" (${tx.readback.voice}, ${tx.readback.style ?? "–"})` : "…";
  const s = tx.stages || {};
  $("#r-timing").textContent =
    `end to end ${fmt(tx.e2eMs)}  ·  server: speech-to-text ${fmt(s.sttMs)}, interpreter ${fmt(s.interpMs)}, ` +
    `first voice byte ${fmt(s.ttsFirstByteMs)}, total ${fmt(s.serverTotalMs)}`;
  const ask = $("#verdict-ask");
  const v = state.verdicts.get(id);
  ask.className = v === undefined ? "" : "done";
  ask.textContent = v === undefined
    ? (tx.logged ? "Did it understand you? Press Y yes or N no." : "Waiting for the readback…")
    : `Marked ${v ? "Y (understood)" : "N (not understood)"}.`;
}

function addHistory(id) {
  const tx = state.txs.get(id);
  const tr = document.createElement("tr");
  tr.id = `h-${id}`;
  tr.innerHTML = "<td></td><td></td><td></td><td></td><td></td><td></td>";
  $("#history tbody").prepend(tr);
  updateHistory(id);
  $("#history-count").textContent = String(state.txs.size);
  return tx;
}

function updateHistory(id) {
  const tx = state.txs.get(id);
  const tr = document.getElementById(`h-${id}`);
  if (!tx || !tr) return;
  const cells = tr.children;
  cells[0].textContent = String(id);
  cells[1].textContent = tx.cardId;
  cells[2].textContent = `${tx.combo.stt} + ${tx.combo.tts}`;
  cells[3].textContent = fmt(tx.e2eMs);
  cells[4].textContent = tx.command ? (tx.command.exact ? "yes" : "no") : "–";
  const v = state.verdicts.get(id);
  cells[5].textContent = v === undefined ? "" : v ? "Y" : "N";
}

// ---------- socket ----------

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  state.ws = ws;
  ws.onopen = () => {
    $("#conn").textContent = "server connected";
    $("#conn").className = "pill ok";
    banner("");
  };
  ws.onclose = (e) => {
    $("#conn").textContent = "server disconnected";
    $("#conn").className = "pill bad";
    banner(`The connection to the local server closed (code ${e.code}). Is the server still running? Restart it if needed, then reload this page.`);
    if (state.talking) {
      state.node && state.node.port.postMessage("stop");
      state.talking = null;
    }
    setStatus("error", "Disconnected from the server.");
  };
  ws.onerror = () => showError("socket", "WebSocket error (see the server's terminal)");
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) onAudioFrame(e.data);
    else onMessage(JSON.parse(e.data));
  };
}

function send(obj) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showError("socket", `not connected; couldn't send ${obj.type}`);
    return false;
  }
  state.ws.send(JSON.stringify(obj));
  return true;
}

function onMessage(m) {
  switch (m.type) {
    case "hello": {
      if (m.mode !== "live") {
        banner(`This server is in ${m.mode} mode. Start it without --replay for a live session.`);
        return;
      }
      state.hello = m;
      state.cards = m.cards;
      renderCard();
      if (!state.micReady) setStatus("idle", "Enable the microphone to start.");
      return;
    }
    case "recording": {
      const t = state.talking;
      const releaseAt = state.pendingRelease.get(m.clientId);
      const cardId = m.ref && m.ref.id;
      state.txs.set(m.id, { cardId, combo: m.combo, releaseAt: releaseAt ?? null, firstChunkAt: null, stages: null, logged: false });
      if (t && t.clientId === m.clientId) t.serverId = m.id;
      state.lastTx = m.id;
      if (releaseAt !== undefined) state.pendingRelease.delete(m.clientId);
      addHistory(m.id);
      return;
    }
    case "cancelled": {
      state.txs.delete(m.id);
      const row = document.getElementById(`h-${m.id}`);
      if (row) row.remove();
      $("#history-count").textContent = String(state.txs.size);
      if (state.lastTx === m.id) state.lastTx = null;
      if (!$("#status").textContent.startsWith("That was a tap")) setStatus("idle", "Cancelled. Hold Space to try again.");
      return;
    }
    case "transcript": {
      const tx = state.txs.get(m.id);
      if (tx) tx.transcript = m.text;
      setStatus("working", "Interpreting…");
      renderResult(m.id);
      return;
    }
    case "command": {
      const tx = state.txs.get(m.id);
      if (tx) tx.command = m;
      renderResult(m.id);
      updateHistory(m.id);
      return;
    }
    case "readback": {
      const tx = state.txs.get(m.id);
      if (tx) tx.readback = m;
      renderResult(m.id);
      return;
    }
    case "audio-start":
      state.playQueue.push({ id: m.id, chunks: [], started: false, ended: false, endTime: 0, kind: m.kind || "readback", startAt: null });
      return;
    case "audio-end": {
      const entry = state.playQueue.find((q) => q.id === m.id);
      if (entry) entry.ended = true;
      advanceQueue();
      return;
    }
    case "done": {
      const tx = state.txs.get(m.id);
      if (!tx) return;
      tx.stages = m.stages;
      tx.logged = true;
      if (tx.timing) send({ type: "client-timing", id: m.id, ...tx.timing });
      if (m.errors && m.errors.length) setStatus("error", `Done with problems: ${m.errors.join("; ")}`);
      else setStatus("ok", "Done. Press Y or N.");
      renderResult(m.id);
      updateHistory(m.id);
      return;
    }
    case "verdict-saved":
      state.verdicts.set(m.id, m.understood);
      renderResult(m.id);
      updateHistory(m.id);
      renderProgress();
      return;
    case "error":
      showError(m.where, m.message);
      if (m.fatal) {
        setStatus("error", m.message);
        banner(m.message);
      }
      return;
    default:
      showError("protocol", `unknown message ${m.type}`);
  }
}

// ---------- playback ----------

function onAudioFrame(buf) {
  const view = new DataView(buf);
  if (view.getUint8(0) !== AUDIO_FRAME) return showError("audio", "unknown binary frame");
  const id = view.getUint32(1, true);
  const pcm = new Int16Array(buf.slice(5));
  const tx = state.txs.get(id);
  if (tx && tx.firstChunkAt === null) tx.firstChunkAt = performance.now();
  let entry = state.playQueue.find((q) => q.id === id);
  if (!entry) {
    entry = { id, chunks: [], started: false, ended: false, endTime: 0, kind: "readback", startAt: null };
    state.playQueue.push(entry);
  }
  entry.chunks.push(pcm);
  if (state.playQueue[0] === entry) schedule(entry);
}

function schedule(entry) {
  const ctx = state.playCtx;
  if (!ctx) return;
  while (entry.chunks.length) {
    const pcm = entry.chunks.shift();
    const f32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 0x8000;
    const ab = ctx.createBuffer(1, f32.length, 24000);
    ab.copyToChannel(f32, 0);
    const src = ctx.createBufferSource();
    src.buffer = ab;
    src.connect(ctx.destination);
    const now = ctx.currentTime;
    let at;
    if (!entry.started) {
      const earliest = now + LEAD_S;
      at = Math.max(earliest, state.playEnd);
      entry.started = true;
      entry.startAt = at;
      firstSample(entry, at, Math.max(0, at - earliest));
    } else {
      at = Math.max(now, entry.endTime);
    }
    src.start(at);
    entry.endTime = at + ab.duration;
    state.playEnd = entry.endTime;
  }
}

/** Map the first sample's schedule time to page time, and record the end-to-end figure. */
function firstSample(entry, at, queuedS) {
  const tx = state.txs.get(entry.id);
  if (!tx || entry.kind !== "readback") return;
  setStatus("working", "Pilot speaking…");
  const ctx = state.playCtx;
  const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
  let playPerf;
  if (ts && ts.performanceTime > 0) playPerf = ts.performanceTime + (at - ts.contextTime) * 1000;
  else playPerf = performance.now() + (at - ctx.currentTime) * 1000 + (ctx.outputLatency || 0) * 1000;
  if (tx.releaseAt === null) return showError("timing", `no release time for #${entry.id}`);
  tx.e2eMs = playPerf - tx.releaseAt;
  tx.timing = {
    e2eMs: tx.e2eMs,
    firstChunkMs: tx.firstChunkAt === null ? null : tx.firstChunkAt - tx.releaseAt,
    outputLatencyMs: (ctx.outputLatency || 0) * 1000,
    queuedBehindMs: queuedS * 1000,
  };
  if (tx.logged) send({ type: "client-timing", id: entry.id, ...tx.timing });
  renderResult(entry.id);
  updateHistory(entry.id);
}

/** When the head readback has all its audio, move on to the next one in order. */
function advanceQueue() {
  while (state.playQueue.length && state.playQueue[0].ended && state.playQueue[0].chunks.length === 0 && state.playQueue[0].started) {
    state.playQueue.shift();
    if (state.playQueue[0]) schedule(state.playQueue[0]);
  }
  // A readback that ended with no audio at all (an error) must not block the queue.
  while (state.playQueue.length && state.playQueue[0].ended && !state.playQueue[0].started && state.playQueue[0].chunks.length === 0) {
    state.playQueue.shift();
    if (state.playQueue[0]) schedule(state.playQueue[0]);
  }
}

// ---------- microphone and push-to-talk ----------

async function enableMic() {
  $("#start").disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); // same constraints as the 0.2 recorder
    const capCtx = new AudioContext({ sampleRate: 16000 });
    if (capCtx.sampleRate !== 16000) throw new Error(`the capture context runs at ${capCtx.sampleRate} Hz, not 16000`);
    await capCtx.audioWorklet.addModule("/capture-worklet.js");
    const src = capCtx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(capCtx, "capture");
    src.connect(node);
    node.port.onmessage = (e) => onWorklet(e.data);
    state.capCtx = capCtx;
    state.node = node;
    state.playCtx = new AudioContext();
    await state.playCtx.resume();
    await capCtx.resume();
    state.micReady = true;
    const track = stream.getAudioTracks()[0];
    $("#mic-label").textContent = `Mic: ${track ? track.label : "?"}`;
    track && track.addEventListener("ended", () => {
      state.micReady = false;
      showError("mic", "the microphone stopped (unplugged or permission revoked)");
      setStatus("error", "Microphone lost. Reload the page.");
    });
    setStatus("idle", "Ready. Read the card, then hold Space and talk.");
  } catch (err) {
    $("#start").disabled = false;
    const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
    const msg = denied
      ? "Microphone access was denied. Click the mic icon at the right of Chrome's address bar, allow it, then click Enable microphone again."
      : `Couldn't start the microphone: ${err && err.message ? err.message : err}`;
    showError("mic", msg);
    setStatus("error", msg);
  }
}

function onWorklet(d) {
  if (d.type === "level") {
    $("#meter-fill").style.width = `${Math.min(100, Math.round(d.peak * 140))}%`;
  } else if (d.type === "chunk") {
    if (state.talking && state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(d.pcm);
  } else if (d.type === "stopped") {
    const t = state.stopping;
    state.stopping = null;
    if (t) send({ type: "ptt-up", id: t.clientId });
  }
}

function startTalk() {
  if (!state.micReady) return setStatus("error", "Enable the microphone first.");
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return setStatus("error", "Not connected to the server.");
  if (state.talking || state.stopping) return;
  const card = currentCard();
  if (!card) return;
  const clientId = ++state.nextClientId;
  state.talking = { clientId, downAt: performance.now(), serverId: null, cardId: card.id };
  send({ type: "ptt-down", id: clientId, cardId: card.id });
  state.node.port.postMessage("start");
  setStatus("recording", "Transmitting… release Space when done.");
}

function endTalk() {
  const t = state.talking;
  if (!t) return;
  const releaseAt = performance.now();
  state.talking = null;
  if (releaseAt - t.downAt < MIN_HOLD_MS) {
    state.node.port.postMessage("stop");
    send({ type: "cancel", id: t.clientId });
    setStatus("idle", "That was a tap, not a transmission. Hold Space while you talk.");
    return;
  }
  if (t.serverId !== null && state.txs.has(t.serverId)) state.txs.get(t.serverId).releaseAt = releaseAt;
  else state.pendingRelease.set(t.clientId, releaseAt);
  // Hand the tail to the worklet; it pads it to 20 ms and then we send ptt-up.
  state.stopping = t;
  state.node.port.postMessage("stop");
  setStatus("working", "Listening to you…");
}

function cancelTalk(reason) {
  const t = state.talking;
  if (!t) return;
  state.talking = null;
  state.node.port.postMessage("stop");
  send({ type: "cancel", id: t.clientId });
  setStatus("idle", `Cancelled: ${reason}.`);
}

function verdict(understood) {
  const id = state.lastTx;
  if (id === null) return setStatus("error", "Nothing to mark yet: transmit first, and wait for the readback.");
  const tx = state.txs.get(id);
  if (!tx || !tx.logged) return setStatus("working", "Still working on that transmission; press Y or N after the readback.");
  if (tx.cardId !== (currentCard() && currentCard().id)) return setStatus("error", `Your last transmission was for ${tx.cardId}, not this card. Transmit for this card first, or go back with the left arrow.`);
  if (!send({ type: "verdict", id, understood })) return;
  state.verdicts.set(id, understood);
  renderResult(id);
  updateHistory(id);
  if (state.index < state.cards.length - 1) {
    state.index++;
    renderCard();
    setStatus("idle", "Next card. Hold Space and talk.");
  } else {
    renderProgress();
    setStatus("ok", "That was the last card. You can stop the server (Ctrl+C in its terminal).");
  }
}

function move(delta) {
  if (state.talking) return;
  state.index = Math.max(0, Math.min(state.cards.length - 1, state.index + delta));
  renderCard();
}

function playWrong() {
  const c = currentCard();
  if (!c || !c.wrongReadback) return;
  if (!state.playCtx) return setStatus("error", "Enable the microphone first (it also starts audio playback).");
  send({ type: "play-wrong", cardId: c.id });
}

window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === "Space") {
    e.preventDefault();
    if (!e.repeat) startTalk();
    return;
  }
  if (e.repeat) return;
  if (e.code === "Escape") cancelTalk("Esc pressed");
  else if (e.code === "KeyY") verdict(true);
  else if (e.code === "KeyN") verdict(false);
  else if (e.code === "ArrowRight") move(1);
  else if (e.code === "ArrowLeft") move(-1);
  else if (e.code === "KeyP") playWrong();
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    endTalk();
  }
});
// If focus leaves the page mid-transmission, the Space keyup never arrives.
window.addEventListener("blur", () => cancelTalk("the window lost focus while you were talking"));

$("#start").addEventListener("click", (e) => {
  e.currentTarget.blur(); // keep Space from "clicking" the button later
  void enableMic();
});
$("#play-wrong").addEventListener("click", (e) => {
  e.currentTarget.blur();
  playWrong();
});

connect();
