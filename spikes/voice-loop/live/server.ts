/**
 * Task 0.6 live loop server. Holds every API key; the browser never sees one.
 *
 * Live session (Q):
 *   npm --prefix spikes/voice-loop run live
 *   then open http://127.0.0.1:8741/ in Chrome. Ctrl+C stops the server.
 *
 * Replay (headless; streams the 34 test-set recordings through this same server pipeline):
 *   npm --prefix spikes/voice-loop run live -- --replay [--lines 01,05] [--limit N]
 *     [--combo nova3+elevenlabs,u36pro+cartesia-ws,...] [--out replay-name.jsonl] [--gap-ms 500]
 *
 * --out also works in live mode (for a test run that mustn't look like one of Q's sessions):
 * the log goes there and the captured audio to an audio/ folder next to it.
 *
 * Options (both modes):
 *   --max-spend USD            refuse a transmission if results/live/spend-log.jsonl (plus any open
 *                              AssemblyAI session) would pass this. Default 5 (0.6's total budget).
 *   --cartesia-transport ws|http   the Cartesia transport for the live cards (default ws). Replay
 *                              names it per combo instead (cartesia-ws / cartesia-http).
 *   --assembly-session long-lived|per-turn   AssemblyAI session handling (default long-lived).
 *   --seed N                   readback variant seed (default 1).
 *   --port N                   default 8741. Always bound to 127.0.0.1 only.
 *
 * Logs: results/live/session-<timestamp>.jsonl (live) or replay-<timestamp>.jsonl (replay), one
 * row per transmission; Q's audio in live/audio/ (gitignored). analyze.ts reads the logs.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { WebSocketServer } from "ws";
import { SPIKE_DIR, loadEnvLocal, requireKey } from "../stt/env.ts";
import { loadScript } from "../stt/script.ts";
import { trackConnections } from "../interp/net.ts";
import { cardVoicePlan, comboPlan } from "./cards.ts";
import { Interpreter } from "./interp.ts";
import { RowLog } from "./log.ts";
import { LIVE_AUDIO_DIR, LIVE_DIR, LIVE_RESULTS_DIR } from "./paths.ts";
import { ClientConn, warmUp, type Services } from "./pipeline.ts";
import { spent } from "./spend.ts";
import { AssemblyStt, type AssemblySessionMode } from "./stt.ts";
import { Voices } from "./tts.ts";
import { STT_IDS, TTS_IDS, type SttId, type TtsId } from "./voices.ts";
import { Warmer } from "./warm.ts";

const HOST = "127.0.0.1";
const KEY_VARS = ["DEEPGRAM_API_KEY", "ASSEMBLYAI_API_KEY", "OPENAI_API_KEY", "ELEVENLABS_API_KEY", "CARTESIA_API_KEY"];

function fail(msg: string, code = 2): never {
  console.error(`live: ${msg}`);
  process.exit(code);
}

const { values } = parseArgs({
  options: {
    replay: { type: "boolean", default: false },
    lines: { type: "string" },
    limit: { type: "string" },
    combo: { type: "string" },
    out: { type: "string" },
    "gap-ms": { type: "string", default: "500" },
    "max-spend": { type: "string", default: "5" },
    "cartesia-transport": { type: "string", default: "ws" },
    "assembly-session": { type: "string", default: "long-lived" },
    seed: { type: "string", default: "1" },
    port: { type: "string", default: "8741" },
  },
  strict: true,
});

const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`--port must be 1-65535, got "${values.port}"`);
const maxSpend = Number(values["max-spend"]);
if (!Number.isFinite(maxSpend) || maxSpend <= 0) fail(`--max-spend must be a positive number, got "${values["max-spend"]}"`);
const seed = Number(values.seed);
if (!Number.isInteger(seed)) fail(`--seed must be an integer, got "${values.seed}"`);
const transport = values["cartesia-transport"];
if (transport !== "ws" && transport !== "http") fail(`--cartesia-transport must be ws or http, got "${transport}"`);
const cartesiaTts: "cartesia-ws" | "cartesia-http" = transport === "ws" ? "cartesia-ws" : "cartesia-http";
const assemblyMode = values["assembly-session"] as AssemblySessionMode;
if (assemblyMode !== "long-lived" && assemblyMode !== "per-turn") fail(`--assembly-session must be long-lived or per-turn, got "${values["assembly-session"]}"`);
const mode: "live" | "replay" = values.replay ? "replay" : "live";
if (mode === "live") {
  for (const k of ["lines", "limit", "combo"] as const) if (values[k] !== undefined) fail(`--${k} is a replay option (add --replay)`);
}

// Replay combos: explicit, or the 4 speech-to-text x voice-provider combinations.
const combos: Array<{ stt: SttId; tts: TtsId }> = (values.combo ?? `nova3+elevenlabs,nova3+${cartesiaTts},u36pro+elevenlabs,u36pro+${cartesiaTts}`)
  .split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const [stt, tts] = s.split("+");
    if (!STT_IDS.includes(stt as SttId) || !TTS_IDS.includes(tts as TtsId)) fail(`bad --combo "${s}" (stt: ${STT_IDS.join("|")}; tts: ${TTS_IDS.join("|")})`);
    return { stt: stt as SttId, tts: tts as TtsId };
  });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
mkdirSync(LIVE_RESULTS_DIR, { recursive: true });
let logPath = join(LIVE_RESULTS_DIR, `${mode === "live" ? "session" : "replay"}-${stamp}.jsonl`);
if (values.out !== undefined) {
  // A bare name goes in results/live/; an absolute path is used as is. A relative path with
  // directories is refused (0.4's relative --out created a stray directory).
  if (isAbsolute(values.out)) logPath = values.out;
  else if (basename(values.out) === values.out) logPath = join(LIVE_RESULTS_DIR, values.out);
  else fail(`--out must be a file name (saved in results/live/) or an absolute path, got "${values.out}"`);
  if (!logPath.endsWith(".jsonl")) fail("--out must end in .jsonl");
  if (mode === "replay" && basename(logPath).startsWith("session-")) fail("replay logs must not be named session-*: those are Q's live sessions");
  if (mode === "live" && basename(logPath).startsWith("replay-")) fail("live-mode logs must not be named replay-*");
}
// Q's audio goes to live/audio/ (gitignored), or next to a live --out log (e.g. a test run).
const audioDir = mode === "live" && values.out !== undefined ? join(dirname(logPath), "audio") : LIVE_AUDIO_DIR;

loadEnvLocal();
const keys = KEY_VARS.map((v) => {
  try {
    return requireKey(v);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});
const [deepgramKey, assemblyKey, , elevenKey, cartesiaKey] = keys as [string, string, string, string, string];
trackConnections();

const script = new Map((await loadScript()).map((l) => [l.num, l] as const));
const interp = new Interpreter("format");
const voices = new Voices(elevenKey, cartesiaKey);
const assembly = new AssemblyStt(assemblyKey, assemblyMode);
const log = new RowLog(logPath);
let lastId = 0;
const plan = comboPlan(cartesiaTts);
const svc: Services = {
  mode, sessionTag: `${mode}-${stamp}`, deepgramKey, assembly, interp, voices, log, seed, maxSpend,
  plan, voicePlan: cardVoicePlan(plan), audioDir, cartesiaTts, script, keys, nextId: () => ++lastId,
};
assembly.onNotice = (m) => console.error(`live: ${m}`);

console.log(`live: ${mode} mode. Spend logged so far: $${spent().toFixed(4)} (cap --max-spend $${maxSpend}).`);
const startCap = spent() + 0.05 > maxSpend;
if (startCap) fail(`spend so far $${spent().toFixed(4)} leaves no room under --max-spend $${maxSpend}`, 3);
console.log("live: warming the interpreter and every voice (first use of a library voice is slow)...");
const ttsInUse = mode === "live" ? (["elevenlabs", cartesiaTts] as TtsId[]) : [...new Set(combos.map((c) => c.tts))];
try {
  await warmUp(svc, ttsInUse, (s) => console.log(s));
} catch (err) {
  fail(err instanceof Error ? err.message : String(err), 4);
}
const warmer = new Warmer();
warmer.start();

// ---- HTTP: the page, from a fixed whitelist (no filesystem paths from the URL) ----------

const STATIC = new Map<string, [string, string]>([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/client.js", ["client.js", "text/javascript; charset=utf-8"]],
  ["/capture-worklet.js", ["capture-worklet.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

function handle(req: IncomingMessage, res: ServerResponse): void {
  if (!allowedHosts.has(req.headers.host ?? "")) {
    res.writeHead(421, { "Content-Type": "text/plain" }).end("wrong host\n");
    return;
  }
  const path = new URL(req.url ?? "/", `http://${req.headers.host}`).pathname;
  if (path === "/favicon.ico") {
    // Chrome asks for one on every load; answer "nothing" so the console shows no 404.
    res.writeHead(204).end();
    return;
  }
  const hit = req.method === "GET" ? STATIC.get(path) : undefined;
  if (!hit) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found\n");
    return;
  }
  const body = readFileSync(join(LIVE_DIR, hit[0]));
  res.writeHead(200, { "Content-Type": hit[1], "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }).end(body);
}

const server = createServer(handle);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
server.on("upgrade", (req, socket, head) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  const origin = req.headers.origin;
  // Browsers always send Origin; refuse other sites (cross-site WebSocket hijacking). The
  // headless replay client sends none.
  if (path !== "/ws" || !allowedHosts.has(req.headers.host ?? "") || (origin !== undefined && !allowedOrigins.has(origin))) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => new ClientConn(ws, svc));
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, HOST, () => resolve());
});
console.log(`live: listening on http://${HOST}:${port}/ (127.0.0.1 only). Log: ${relative(process.cwd(), logPath)}`);

let stopping = false;
async function shutdown(code: number): Promise<never> {
  if (!stopping) {
    stopping = true;
    warmer.stop();
    await assembly.close("server stop").catch(() => undefined);
    voices.close();
    for (const c of wss.clients) c.close(1001);
    server.close();
    console.log(`live: stopped. ${log.size} transmission(s) in ${relative(process.cwd(), logPath)}. Spend logged: $${spent().toFixed(4)}.`);
  }
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

if (mode === "live") {
  console.log(`live: open http://${HOST}:${port}/ in Chrome. Ctrl+C to stop.`);
} else {
  // The replay client runs as its own process with no keys in its environment.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || KEY_VARS.includes(k) || /KEY|SECRET|TOKEN/i.test(k)) continue;
    env[k] = v;
  }
  const messagesPath = logPath.replace(/\.jsonl$/, ".messages.jsonl");
  const args = [join(LIVE_DIR, "replay-client.ts"), "--url", `ws://${HOST}:${port}/ws`, "--messages", messagesPath,
    "--combo", combos.map((c) => `${c.stt}+${c.tts}`).join(","), "--gap-ms", values["gap-ms"]!];
  if (values.lines) args.push("--lines", values.lines);
  if (values.limit) args.push("--limit", values.limit);
  const child = spawn(process.execPath, args, { env, stdio: "inherit" });
  child.on("exit", (code) => {
    console.log(`live: replay client exited ${code}. Pings: ${warmer.pings} ok, ${warmer.pingErrors} failed. AssemblyAI sessions opened: ${assembly.sessionsOpened}. Cartesia WS opens: ${voices.cartesiaWsOpens}.`);
    console.log(`live: messages recorded in ${relative(process.cwd(), messagesPath)}`);
    void shutdown(code ?? 1);
  });
}
