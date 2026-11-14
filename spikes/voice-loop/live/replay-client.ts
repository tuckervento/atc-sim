/**
 * Headless replay client, started by `server.ts --replay` as its own process (with no API keys
 * in its environment). It plays the browser's part: for each test-set recording and each
 * combination, it streams the audio at real-time pace in 20 ms chunks (stt/audio.ts
 * streamPaced), sends release, and waits for the readback audio.
 *
 * - Lines run in script order; within a line the combinations run one after another, rotated
 *   by one per line, so no combination always goes first.
 * - After each readback it waits the readback's length plus --gap-ms, as if listening.
 * - Headless end-to-end = release sent -> first audio frame received (this process's clock).
 *   It's reported back to the server as the transmission's client timing.
 * - Every message the server sends is recorded to --messages (text frames verbatim; binary audio
 *   frames as id, length and sha256), so a scan can confirm no key reached the client.
 */
import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import WebSocket from "ws";
import { decodePcm, streamPaced } from "../stt/audio.ts";
import { AUDIO_DIR, loadScript } from "../stt/script.ts";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    messages: { type: "string" },
    combo: { type: "string" },
    lines: { type: "string" },
    limit: { type: "string" },
    "gap-ms": { type: "string", default: "500" },
  },
  strict: true,
});
if (!values.url || !values.messages || !values.combo) {
  console.error("replay-client: needs --url, --messages and --combo (it's started by server.ts --replay)");
  process.exit(2);
}
const gapMs = Number(values["gap-ms"]);
const combos = values.combo.split(",").map((s) => {
  const [stt, tts] = s.split("+");
  return { stt: stt!, tts: tts! };
});

let lines = await loadScript();
if (values.lines) {
  const want = new Set(values.lines.split(",").map((s) => s.trim()));
  lines = lines.filter((l) => want.has(l.num));
  const missing = [...want].filter((n) => !lines.some((l) => l.num === n));
  if (missing.length) {
    console.error(`replay-client: no such line(s): ${missing.join(", ")}`);
    process.exit(2);
  }
}
if (values.limit) lines = lines.slice(0, Number(values.limit));

const messagesPath = values.messages;
writeFileSync(messagesPath, "");
const t00 = performance.now();

type Msg = Record<string, unknown>;
const ws = new WebSocket(values.url);
const waiters: Array<{ pick: (m: Msg) => boolean; resolve: (m: Msg) => void }> = [];
const firstAudio = new Map<number, number>();
/** Every text message received, so a wait registered after its message arrived still sees it. */
const seen: Msg[] = [];
let fatal: string | null = null;

ws.on("message", (data, isBinary) => {
  const at = performance.now();
  if (isBinary) {
    const buf = data as Buffer;
    const id = buf.length >= 5 ? buf.readUInt32LE(1) : -1;
    if (!firstAudio.has(id)) firstAudio.set(id, at);
    appendFileSync(messagesPath, `${JSON.stringify({ t: Math.round(at - t00), binary: true, kind: buf[0], id, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") })}\n`);
    return;
  }
  const text = data.toString();
  appendFileSync(messagesPath, `${JSON.stringify({ t: Math.round(at - t00), text })}\n`);
  const msg = JSON.parse(text) as Msg;
  if (msg.type === "error") {
    console.error(`  server error [${String(msg.where)}] #${String(msg.id)}: ${String(msg.message)}`);
    if (msg.fatal === true) fatal = String(msg.message);
  }
  seen.push(msg);
  for (let i = 0; i < waiters.length; i++) {
    const w = waiters[i]!;
    if (w.pick(msg)) {
      waiters.splice(i, 1);
      w.resolve(msg);
      i--;
    }
  }
});

function waitFor(pick: (m: Msg) => boolean, timeoutMs: number, what: string): Promise<Msg> {
  const already = seen.find(pick);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const w = { pick, resolve: (m: Msg) => { clearTimeout(timer); resolve(m); } };
    const timer = setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      reject(new Error(fatal ?? `timed out after ${timeoutMs} ms waiting for ${what}`));
    }, timeoutMs);
    waiters.push(w);
  });
}

await new Promise<void>((resolve, reject) => {
  ws.once("open", () => resolve());
  ws.once("error", reject);
});
const hello = await waitFor((m) => m.type === "hello", 5000, "hello");
if (hello.mode !== "replay") {
  console.error(`replay-client: the server is in ${String(hello.mode)} mode, not replay`);
  process.exit(2);
}

let clientId = 0;
let done = 0;
let exact = 0;
let scored = 0;
const total = lines.length * combos.length;
console.log(`replay: ${lines.length} line(s) x ${combos.length} combination(s) = ${total} transmissions`);

outer: for (const [li, line] of lines.entries()) {
  const pcm = await decodePcm(join(AUDIO_DIR, `${line.num}.webm`), 16_000);
  for (let k = 0; k < combos.length; k++) {
    const combo = combos[(li + k) % combos.length]!;
    if (fatal) break outer;
    const cid = ++clientId;
    const recording = waitFor((m) => m.type === "recording" && m.clientId === cid, 10_000, "recording ack");
    ws.send(JSON.stringify({ type: "ptt-down", id: cid, line: line.num, combo }));
    await streamPaced(pcm, 16_000, 20, (c) => ws.send(c), () => fatal);
    ws.send(JSON.stringify({ type: "ptt-up", id: cid }));
    const releaseAt = performance.now();
    let rec: Msg;
    try {
      rec = await recording;
    } catch (err) {
      console.error(`  L${line.num} ${combo.stt}+${combo.tts}: ${err instanceof Error ? err.message : String(err)}`);
      break outer;
    }
    const id = Number(rec.id);
    const doneMsg = waitFor((m) => m.type === "done" && m.id === id, 40_000, `done for #${id}`);
    const end = waitFor((m) => m.type === "audio-end" && m.id === id, 40_000, `audio-end for #${id}`).catch(() => null);
    const cmd = waitFor((m) => m.type === "command" && m.id === id, 40_000, "command").catch(() => null);
    const tr = waitFor((m) => m.type === "transcript" && m.id === id, 40_000, "transcript").catch(() => null);
    let d: Msg;
    try {
      d = await doneMsg;
    } catch (err) {
      console.error(`  L${line.num} ${combo.stt}+${combo.tts}: ${err instanceof Error ? err.message : String(err)}`);
      break outer;
    }
    const first = firstAudio.get(id);
    const e2e = first === undefined ? null : first - releaseAt;
    ws.send(JSON.stringify({ type: "client-timing", id, e2eMs: e2e, firstChunkMs: e2e, outputLatencyMs: null, queuedBehindMs: null }));
    const [c, t] = [await cmd, await tr];
    const audioEnd = (d.errors as string[]).length === 0 || first !== undefined ? await end : null;
    done++;
    if (c && c.expected !== null) {
      scored++;
      if (c.exact === true) exact++;
    }
    const st = d.stages as Record<string, number | null>;
    const f = (v: number | null | undefined) => (v === null || v === undefined ? "  -  " : `${Math.round(v)}`.padStart(5));
    console.log(
      `${String(done).padStart(3)}/${total} L${line.num} ${`${combo.stt}+${combo.tts}`.padEnd(20)} stt${f(st.sttMs)} int${f(st.interpMs)} tts${f(st.ttsFirstByteMs)} srv${f(st.serverTotalMs)} e2e${f(e2e)}  ` +
      `${c?.exact === true ? "EXACT" : c?.expected === null ? "unsc." : "miss "} ${String(c?.terse ?? "-")}` +
      `${(d.errors as string[]).length ? `  [${(d.errors as string[]).join("; ")}]` : ""}`,
    );
    if (c && c.exact !== true && c.expected !== null) console.log(`        heard: ${String(t?.text ?? "-")}\n        expected: ${String(c.expected)}`);
    const listen = audioEnd && typeof audioEnd.audioSec === "number" ? audioEnd.audioSec * 1000 : 0;
    await new Promise((r) => setTimeout(r, listen + gapMs));
  }
}

console.log(`replay: ${done}/${total} done; exact ${exact}/${scored} scored.${fatal ? ` Stopped: ${fatal}` : ""}`);
ws.close();
process.exit(fatal ? 3 : done === total ? 0 : 4);
