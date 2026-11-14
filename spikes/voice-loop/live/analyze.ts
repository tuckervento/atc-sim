/**
 * Analysis of live-loop logs (results/live/session-*.jsonl or replay-*.jsonl):
 *   node live/analyze.ts results/live/replay-full-1.jsonl [more.jsonl ...]
 *   node live/analyze.ts <log.jsonl ...> --terse-replay [--max-spend 3] [--limit N]
 *
 * Prints markdown tables:
 * - per-stage and end-to-end median / p95, per combination and overall, against PRD §6.3
 *   (final transcript <= 0.3 s, interpretation <= 0.4 s, first voice audio <= 0.2 s,
 *   end to end <= 1.0 s median and ~2 s p95). Each stage is one clock: server stages on the
 *   server's clock from release received; end to end on the client's clock (browser: Space up ->
 *   first sample played; headless replay: release sent -> first audio frame received).
 * - accuracy: exact match after normalizeCommand (and Q's Y/N for sessions)
 * - $/hr at peak against the $5 soft / $10 hard caps (PRD §11), with the peak assumption's
 *   volumes revised from the logged counts. 450 transmissions/hr is kept (PLAN Context): the
 *   logs measure per-transmission size, not how often a controller transmits at peak.
 * --terse-replay re-runs every scored, logged transcript through gpt-6-luna three ways,
 *   interleaved so time-of-day effects hit all three alike: the live loop's strict JSON, 0.4's
 *   terse answer prompt, and that prompt plus a general syntax checklist (live/interp.ts
 *   TERSE_CHECKLIST, written before this ran and not tuned on cards or script lines).
 * p95 is nearest-rank, as in 0.3-0.5.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseTerse } from "../../../src/sim/terse.ts";
import type { Transmission } from "../../../src/sim/commands.ts";
import { liveContext } from "../interp/context.ts";
import { trackConnections } from "../interp/net.ts";
import { sha } from "../interp/prompt.ts";
import { scoreLine } from "../interp/score.ts";
import { OPENAI_PRICING } from "../interp/openai.ts";
import { costUsd, type Tokens } from "../interp/types.ts";
import { loadEnvLocal } from "../stt/env.ts";
import { percentile } from "../stt/results.ts";
import { cardById } from "./cards.ts";
import { cardContext, Interpreter, type InterpCall } from "./interp.ts";
import type { Row } from "./log.ts";
import { LIVE_RESULTS_DIR } from "./paths.ts";
import { ASSEMBLY_USD_PER_SEC, NOVA_USD_PER_MIN, TTS_USD_PER_CHAR, overCap, record } from "./spend.ts";
import { providerOf, type TtsId } from "./voices.ts";

const PEAK_TX_PER_HR = 450;
const SOFT_CAP = 5;
const HARD_CAP = 10;
const BUDGET = { stt: 300, interp: 400, tts: 200, e2e: 1000, e2eP95: 2000 };

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "terse-replay": { type: "boolean", default: false },
    "max-spend": { type: "string", default: "5" },
    limit: { type: "string" },
  },
});
if (positionals.length === 0) {
  console.error("usage: node live/analyze.ts <log.jsonl> [more.jsonl ...] [--terse-replay] [--max-spend USD] [--limit N]");
  process.exit(2);
}

const rows: Row[] = positionals.flatMap((p) =>
  readFileSync(p, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Row));
const modes = new Set(rows.map((r) => r.mode));
const isSession = modes.has("live");
if (modes.size > 1) {
  console.error("analyze: these files mix live sessions and replays; analyze them separately");
  process.exit(2);
}

// ---- helpers ---------------------------------------------------------------------------

const nums = (xs: Array<number | null | undefined>): number[] => xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
const med = (xs: number[]) => percentile(xs, 0.5);
const p95 = (xs: number[]) => percentile(xs, 0.95);
const ms = (v: number | null) => (v === null ? "–" : `${Math.round(v)} ms`);
const pct = (a: number, b: number) => (b === 0 ? "–" : `${((a / b) * 100).toFixed(1)}% (${a}/${b})`);
const usd = (v: number) => `$${v.toFixed(2)}`;
const comboOf = (r: Row) => `${r.combo.stt}+${r.combo.tts}`;

function cell(xs: number[], budget?: number): string {
  if (xs.length === 0) return "–";
  const m = med(xs)!;
  const flag = budget !== undefined ? (m <= budget ? " ✓" : " ✗") : "";
  return `${ms(m)} / ${ms(p95(xs))}${flag}`;
}

function within(xs: number[], limit: number): string {
  return xs.length === 0 ? "–" : pct(xs.filter((x) => x <= limit).length, xs.length);
}

function groups(): Array<[string, Row[]]> {
  const by = new Map<string, Row[]>();
  for (const r of rows) {
    const k = comboOf(r);
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(r);
  }
  return [...[...by.entries()].sort(([a], [b]) => a.localeCompare(b)), ["all", rows]];
}

const e2eOf = (r: Row) => r.client?.e2eMs ?? null;
const out: string[] = [];
const p = (s = "") => out.push(s);

// ---- latency ---------------------------------------------------------------------------

const clock = isSession ? "browser: Space released → first readback sample played" : "headless: release sent → first audio frame received";
p(`## ${isSession ? "Live session" : "Replay"}: ${rows.length} transmissions from ${positionals.length} file(s)`);
p();
p(`Median / p95 per stage, against PRD §6.3. ✓/✗ marks the median against the budget. End to end is the client clock (${clock}); every other column is the server clock, from release received.`);
p();
p("| Combination | n | Final transcript (≤ 300) | Interpreter (≤ 400) | Template | First voice byte (≤ 200) | Server total | End to end (≤ 1000) | E2E ≤ 1.0 s | E2E ≤ 2.0 s |");
p("|---|---|---|---|---|---|---|---|---|---|");
for (const [k, rs] of groups()) {
  const e2e = nums(rs.map(e2eOf));
  p(`| ${k} | ${rs.length} | ${cell(nums(rs.map((r) => r.stages.sttMs)), BUDGET.stt)} | ${cell(nums(rs.map((r) => r.stages.interpMs)), BUDGET.interp)} | ${cell(nums(rs.map((r) => r.stages.templateMs)))} | ${cell(nums(rs.map((r) => r.stages.ttsFirstByteMs)), BUDGET.tts)} | ${cell(nums(rs.map((r) => r.stages.serverTotalMs)))} | ${cell(e2e, BUDGET.e2e)} | ${within(e2e, 1000)} | ${within(e2e, 2000)} |`);
}
p();

// Per provider, pooled across the other stage's choices.
p("Per provider (pooled over the other stage's choice):");
p();
p("| Stage | Provider | n | Median / p95 | Within budget | Notes |");
p("|---|---|---|---|---|---|");
for (const stt of ["nova3", "u36pro"]) {
  const rs = rows.filter((r) => r.combo.stt === stt);
  if (!rs.length) continue;
  const x = nums(rs.map((r) => r.stages.sttMs));
  const hidden = rs.filter((r) => r.stt.readyBeforeRelease === true).length;
  const fresh = rs.filter((r) => r.stt.newSession === true).length;
  const conn = nums(rs.map((r) => r.stt.connectMs));
  const sess = rs[0]?.combo.assemblySession;
  const notes = `connect hidden by the hold ${hidden}/${rs.length}; new sessions ${fresh}${conn.length ? `, connect median ${ms(med(conn))}` : ""}${sess ? `; AssemblyAI ${sess}` : ""}`;
  p(`| Final transcript | ${stt} | ${x.length} | ${cell(x)} | ${within(x, BUDGET.stt)} | ${notes} |`);
}
{
  const x = nums(rows.map((r) => r.stages.interpMs));
  const server = nums(rows.map((r) => r.interp.serverMs));
  const cold = rows.filter((r) => r.interp.newConnection === true).length;
  p(`| Interpreter | gpt-6-luna (strict JSON) | ${x.length} | ${cell(x)} | ${within(x, BUDGET.interp)} | OpenAI's own processing header median ${ms(med(server))}; new connections ${cold}/${rows.filter((r) => r.interp.called).length} |`);
}
for (const tts of ["elevenlabs", "cartesia-ws", "cartesia-http"]) {
  const rs = rows.filter((r) => r.combo.tts === tts);
  if (!rs.length) continue;
  const x = nums(rs.map((r) => r.stages.ttsFirstByteMs));
  const cold = rs.filter((r) => r.readback.newConnection === true).length;
  const slow = x.filter((v) => v >= 300).length;
  p(`| First voice byte | ${tts} | ${x.length} | ${cell(x)} | ${within(x, BUDGET.tts)} | new connections ${cold}/${rs.length}; ≥ 300 ms: ${slow}/${x.length} |`);
}
p();

if (rows.some((r) => r.combo.stt === "u36pro")) {
  const rs = rows.filter((r) => r.combo.stt === "u36pro");
  const first = nums(rs.filter((r) => r.stt.newSession === true).map((r) => r.stages.sttMs));
  const later = nums(rs.filter((r) => r.stt.newSession === false).map((r) => r.stages.sttMs));
  p(`AssemblyAI turns: first turn of a session ${cell(first)} (n ${first.length}); later turns on the same session ${cell(later)} (n ${later.length}). Transmissions where one turn split into several end-of-turns: ${rs.filter((r) => (r.stt.turns ?? 1) > 1).length}.`);
  p();
}

// Voices: speaking rate per voice (Q's controller cadence is 165 wpm, 0.5).
{
  const by = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.readback.voice || r.readback.wpm === null) continue;
    const k = `${r.combo.tts} · ${r.readback.voice.name} ×${r.readback.voice.speed}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(r.readback.wpm);
  }
  if (by.size) {
    p("Readback speaking rate per voice (words per minute over the speech span; Q's cadence: median 165 wpm):");
    p();
    p("| Voice | Readbacks | Median wpm | Range |");
    p("|---|---|---|---|");
    for (const [k, xs] of [...by.entries()].sort()) p(`| ${k} | ${xs.length} | ${Math.round(med(xs)!)} | ${Math.round(Math.min(...xs))}–${Math.round(Math.max(...xs))} |`);
    p();
  }
}

// What end to end is made of, at the median of each part.
{
  const e2e = nums(rows.map(e2eOf));
  const parts = ["sttMs", "interpMs", "templateMs", "ttsFirstByteMs", "sendMs"] as const;
  const meds = parts.map((k) => med(nums(rows.map((r) => r.stages[k]))) ?? 0);
  const serverMed = med(nums(rows.map((r) => r.stages.serverTotalMs)));
  const e2eMed = med(e2e);
  p(`Where the time goes (medians, all rows): final transcript ${ms(meds[0]!)}, interpreter ${ms(meds[1]!)}, template ${ms(meds[2]!)}, first voice byte ${ms(meds[3]!)}, send ${ms(meds[4]!)}; server total ${ms(serverMed)}; end to end ${ms(e2eMed)}. The interpreter is ${serverMed ? Math.round((meds[1]! / serverMed) * 100) : "–"}% of the server total.`);
  if (isSession) {
    const outLat = nums(rows.map((r) => r.client?.outputLatencyMs));
    const queued = nums(rows.map((r) => r.client?.queuedBehindMs)).filter((x) => x > 1);
    p(`Browser audio output latency (AudioContext.outputLatency) median ${ms(med(outLat))}; readbacks queued behind another: ${queued.length}.`);
  }
  p();
}

// ---- accuracy --------------------------------------------------------------------------

p("### Accuracy");
p();
p(`Exact match after normalizeCommand (interp/score.ts), against the ${isSession ? "card's" : "script's"} expected command.${isSession ? " Y/N is Q's \"understood me\"." : ""}`);
p();
p(`| Combination | Scored | Exact | Valid answers | Say-again / generic replies |${isSession ? " Y (understood) | N |" : ""}`);
p(`|---|---|---|---|---|${isSession ? "---|---|" : ""}`);
for (const [k, rs] of groups()) {
  const scored = rs.filter((r) => r.expected !== null);
  const ex = scored.filter((r) => r.exact === true).length;
  const valid = rs.filter((r) => r.interp.valid).length;
  const sayAgain = rs.filter((r) => r.readback.kind === "say-again" || r.readback.kind === "generic-say-again").length;
  const yn = isSession ? ` ${rs.filter((r) => r.understood === true).length} | ${rs.filter((r) => r.understood === false).length} |` : "";
  p(`| ${k} | ${scored.length} | ${pct(ex, scored.length)} | ${pct(valid, rs.filter((r) => r.interp.called).length)} | ${sayAgain} |${yn}`);
}
p();
const misses = rows.filter((r) => r.expected !== null && r.exact !== true);
if (misses.length) {
  p("Misses:");
  p();
  p("| # | Ref | Combination | Heard | Got | Expected |");
  p("|---|---|---|---|---|---|");
  for (const r of misses) {
    const ref = r.ref.kind === "card" ? r.ref.id : `L${r.ref.num}`;
    const got = r.interp.terse ?? (r.interp.invalidReason ? `invalid: ${r.interp.invalidReason}` : r.interp.error ?? r.stt.error ?? r.errors.join("; "));
    p(`| ${r.id} | ${ref} | ${comboOf(r)} | ${(r.stt.transcript ?? "–").replace(/\|/g, "/")} | \`${got}\` | \`${r.expected}\` |`);
  }
  p();
}
if (isSession) {
  const both = rows.filter((r) => r.understood !== null && r.exact !== null);
  const agree = both.filter((r) => r.understood === r.exact).length;
  p(`Q's Y/N agrees with exact match on ${pct(agree, both.length)} of transmissions that have both.`);
  p();
}
const errorRows = rows.filter((r) => r.errors.length > 0);
if (errorRows.length) {
  p(`Rows with errors: ${errorRows.length}. ${errorRows.slice(0, 10).map((r) => `#${r.id}: ${r.errors.join("; ")}`).join(" · ")}`);
  p();
}

// ---- cost ------------------------------------------------------------------------------

{
  const audioSec = nums(rows.map((r) => r.audio.sec));
  const chars = nums(rows.filter((r) => r.readback.text).map((r) => r.readback.chars));
  const toks = rows.map((r) => r.interp.tokens).filter((t): t is Tokens => t !== null);
  const meanTok: Tokens = {
    uncached: toks.reduce((a, t) => a + t.uncached, 0) / (toks.length || 1),
    cacheRead: toks.reduce((a, t) => a + t.cacheRead, 0) / (toks.length || 1),
    cacheWrite: toks.reduce((a, t) => a + t.cacheWrite, 0) / (toks.length || 1),
    output: toks.reduce((a, t) => a + t.output, 0) / (toks.length || 1),
  };
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const aSec = mean(audioSec);
  const cPer = mean(chars);
  const interpHr = PEAK_TX_PER_HR * costUsd(meanTok, OPENAI_PRICING);
  p("### Cost at peak");
  p();
  p(`Revised volumes from these ${rows.length} rows, against the PLAN assumption: player audio ${aSec.toFixed(2)} s per transmission (assumed 4 s); readback ${Math.round(cPer)} characters (assumed 70); interpreter ${Math.round(meanTok.cacheRead)} cached + ${Math.round(meanTok.uncached)} uncached input and ${Math.round(meanTok.output)} output tokens per call (assumed 3,000 + 1,030 and 150). Kept: ${PEAK_TX_PER_HR} transmissions/hr and one readback per transmission.${isSession ? "" : " Replay audio is Q's test-set recordings, not live phrasing."}`);
  p();
  p("| Combination | Speech-to-text | Interpreter | Voice | Total $/hr | vs $5 soft / $10 hard |");
  p("|---|---|---|---|---|---|");
  const combos = [...new Set(rows.map(comboOf))].sort();
  for (const k of combos) {
    const [stt, tts] = k.split("+") as [string, TtsId];
    // Nova-3 bills audio sent. Universal-3.6 Pro long-lived bills the open hour.
    const sttHr = stt === "nova3" ? PEAK_TX_PER_HR * (aSec / 60) * NOVA_USD_PER_MIN : 3600 * ASSEMBLY_USD_PER_SEC;
    const ttsHr = PEAK_TX_PER_HR * cPer * TTS_USD_PER_CHAR[providerOf(tts)];
    const total = sttHr + interpHr + ttsHr;
    p(`| ${k} | ${usd(sttHr)} | ${usd(interpHr)} | ${usd(ttsHr)} | ${usd(total)} | ${total <= SOFT_CAP ? "under both" : total <= HARD_CAP ? "over soft, under hard" : "OVER HARD CAP"} |`);
  }
  p();
  p(`Prices: Nova-3 list $${NOVA_USD_PER_MIN.toFixed(4)}/min incl. keyterms; Universal-3.6 Pro $0.45/hr of session (one session open all hour); gpt-6-luna per interp/openai.ts; ElevenLabs $0.04/1K characters pay-as-you-go; Cartesia $65/1M characters (Pro overage). Plan credits make the voice cost lower in practice.`);
  p();
}

console.log(out.join("\n"));

// ---- terse replay ----------------------------------------------------------------------

if (values["terse-replay"]) {
  const maxSpend = Number(values["max-spend"]);
  loadEnvLocal();
  trackConnections();
  const variants: Array<{ name: string; interp: Interpreter }> = [
    { name: "json (live loop)", interp: new Interpreter("format") },
    { name: "terse (0.4 prompt)", interp: new Interpreter("terse") },
    { name: "terse-tuned (+ checklist)", interp: new Interpreter("terse", true) },
  ];
  // Unique (context, transcript) pairs with an expected command.
  const seen = new Map<string, { context: string; transcript: string; expected: string; ref: string }>();
  for (const r of rows) {
    if (r.expected === null || !r.stt.transcript) continue;
    const context = r.ref.kind === "line" ? liveContext(r.ref.num) : cardContext(cardById(r.ref.id));
    if (sha(context) !== r.contextSha) throw new Error(`row ${r.id}: the context changed since it was logged (sha ${sha(context)} vs ${r.contextSha})`);
    const key = `${r.contextSha}|${r.stt.transcript}`;
    if (!seen.has(key)) seen.set(key, { context, transcript: r.stt.transcript, expected: r.expected, ref: r.ref.kind === "line" ? `L${r.ref.num}` : r.ref.id });
  }
  let items = [...seen.values()];
  if (values.limit) items = items.slice(0, Number(values.limit));
  const perVariant = new Map<string, Array<{ call: InterpCall; exact: boolean; item: (typeof items)[number] }>>();
  for (const v of variants) perVariant.set(v.name, []);
  const outPath = join(LIVE_RESULTS_DIR, `terse-replay-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  writeFileSync(outPath, "");
  console.log(`\n## Terse-output experiment: ${items.length} unique logged transcripts x ${variants.length} variants, interleaved`);
  // Unscored warm-up per variant (connection, cache write).
  for (const v of variants) {
    const w = await v.interp.interpret(items[0]!.context, items[0]!.transcript);
    record(`terse-replay warm-up ${v.name}`, w.usd);
    if (w.error) throw new Error(`warm-up failed for ${v.name}: ${w.error}`);
  }
  for (const [i, item] of items.entries()) {
    const capped = overCap(maxSpend, 0);
    if (capped) {
      console.error(`analyze: stopping the terse replay: ${capped}`);
      break;
    }
    const order = variants.map((_, k) => variants[(i + k) % variants.length]!);
    for (const v of order) {
      const call = await v.interp.interpret(item.context, item.transcript);
      record(`terse-replay ${v.name} ${item.ref}`, call.usd);
      const exp = parseTerse(item.expected);
      const expected = exp.ok ? (exp.command as Transmission) : null;
      const exact = expected !== null && call.command !== null && scoreLine(expected, call.command).exact;
      perVariant.get(v.name)!.push({ call, exact, item });
      writeFileSync(outPath, `${JSON.stringify({ variant: v.name, ref: item.ref, transcript: item.transcript, expected: item.expected, terse: call.terse, rawText: call.rawText, invalidReason: call.invalidReason, error: call.error, exact, ms: call.ms, serverMs: call.serverMs, newConnection: call.newConnection, tokens: call.tokens })}\n`, { flag: "a" });
    }
  }
  const t: string[] = [];
  t.push("", "| Variant | n | Exact | Valid | Median | p95 | Output tokens (mean) | $/hr at peak |", "|---|---|---|---|---|---|---|---|");
  for (const v of variants) {
    const xs = perVariant.get(v.name)!;
    const lat = xs.filter((x) => !x.call.error).map((x) => x.call.ms);
    const valid = xs.filter((x) => x.call.command !== null).length;
    const outTok = xs.reduce((a, x) => a + x.call.tokens.output, 0) / (xs.length || 1);
    const usdPer = xs.reduce((a, x) => a + x.call.usd, 0) / (xs.length || 1);
    t.push(`| ${v.name} | ${xs.length} | ${pct(xs.filter((x) => x.exact).length, xs.length)} | ${pct(valid, xs.length)} | ${ms(med(lat))} | ${ms(p95(lat))} | ${outTok.toFixed(0)} | ${usd(usdPer * PEAK_TX_PER_HR)} |`);
  }
  const tuned = perVariant.get(variants[2]!.name)!;
  const tunedMiss = tuned.filter((x) => !x.exact);
  if (tunedMiss.length) {
    t.push("", "Terse-tuned misses:", "", "| Ref | Heard | Got | Expected |", "|---|---|---|---|");
    for (const x of tunedMiss) t.push(`| ${x.item.ref} | ${x.item.transcript.replace(/\|/g, "/")} | \`${x.call.terse ?? `invalid: ${x.call.invalidReason ?? x.call.error}`}\` | \`${x.item.expected}\` |`);
  }
  t.push("", `Raw results: ${outPath}`);
  console.log(t.join("\n"));
}
