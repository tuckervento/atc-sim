/**
 * Phase 0, task 0.3: speech-to-text bake-off.
 *
 * Streams each test-set recording at real-time pace to each shortlisted speech-to-text
 * candidate (one fresh session per clip), signals end of turn the push-to-talk way, and
 * measures latency = last audio chunk sent -> final transcript received. Scores word error
 * rate and critical-token accuracy against test-set/script.md, saves every line to
 * results/stt/<candidate>.json, and prints a summary table.
 *
 * Run:   npm --prefix spikes/voice-loop run stt-bench -- [options]
 * Options:
 *   --provider openai|deepgram|assemblyai   only this provider's candidates
 *   --model <id>                            only this model (e.g. nova-3, gpt-transcribe)
 *   --lines 01,02                           only these script lines
 *   --limit N                               only the first N (selected) lines
 *   --rescore                               no API calls: re-score saved results, print table
 *   --opt key=value                         provider override (needs --out; see stt/*.ts)
 *   --out DIR                               write results here instead of results/stt
 *   --chunk-ms N                            audio chunk size (default 80)
 *   --timeout-ms N                          wait for a final transcript (default 10000)
 *   --max-spend USD                         stop before the spend ledger passes this (default 5)
 *
 * Keys come from .env.local (see check-keys.ts); they're never printed or saved.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadEnvLocal, requireKey, describeError, SPIKE_DIR } from "./stt/env.ts";
import { checkVocab } from "./stt/vocab.ts";
import { decodePcm, durationSec } from "./stt/audio.ts";
import { loadScript, AUDIO_DIR, type ScriptLine } from "./stt/script.ts";
import { loadCritical, taxiwayInventory, CATEGORIES, type CriticalSpec } from "./stt/critical.ts";
import { CANDIDATES, type Candidate } from "./stt/candidates.ts";
import {
  appendSpend, clipCost, formatTables, loadResult, saveResult, scoreLine, spendTotal, summarize,
  type LineEntry, type ResultFile,
} from "./stt/results.ts";
import type { RunOptions } from "./stt/types.ts";

const RESULTS_DIR = join(SPIKE_DIR, "results", "stt");
const CRITICAL_PATH = join(RESULTS_DIR, "critical-tokens.json");
const KEY_VARS = { openai: "OPENAI_API_KEY", deepgram: "DEEPGRAM_API_KEY", assemblyai: "ASSEMBLYAI_API_KEY" } as const;

const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    model: { type: "string" },
    lines: { type: "string" },
    limit: { type: "string" },
    rescore: { type: "boolean", default: false },
    opt: { type: "string", multiple: true, default: [] },
    out: { type: "string" },
    "chunk-ms": { type: "string", default: "80" },
    "timeout-ms": { type: "string", default: "10000" },
    "max-spend": { type: "string", default: "5" },
  },
  strict: true,
});

function fail(message: string): never {
  console.error(`stt-bench: ${message}`);
  process.exit(2);
}

function positiveNumber(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) fail(`--${name} must be a positive number, got "${raw}"`);
  return n;
}

const chunkMs = positiveNumber("chunk-ms", values["chunk-ms"]);
const finalTimeoutMs = positiveNumber("timeout-ms", values["timeout-ms"]);
const maxSpend = positiveNumber("max-spend", values["max-spend"]);
const opts = new Map<string, string>();
for (const o of values.opt) {
  const eq = o.indexOf("=");
  if (eq <= 0) fail(`--opt must be key=value, got "${o}"`);
  opts.set(o.slice(0, eq), o.slice(eq + 1));
}
if (opts.size > 0 && !values.out) fail("--opt changes the provider config, so it needs --out DIR (keeps results/stt for the standard config)");
const outDir = values.out ? resolve(values.out) : RESULTS_DIR;
const ledgerPath = join(RESULTS_DIR, "spend-log.jsonl");

// ---- select candidates and lines --------------------------------------------------------

const providers = new Set(CANDIDATES.map((c) => c.provider));
if (values.provider && !providers.has(values.provider as Candidate["provider"])) {
  fail(`--provider must be one of ${[...providers].join(", ")}, got "${values.provider}"`);
}
const candidates = CANDIDATES.filter(
  (c) => (!values.provider || c.provider === values.provider) && (!values.model || c.model === values.model || c.id === values.model),
);
if (candidates.length === 0) fail(`no candidate matches; known models: ${CANDIDATES.map((c) => c.model).join(", ")}`);

loadEnvLocal();
checkVocab();
const script = await loadScript();
const specs = loadCritical(CRITICAL_PATH, script.map((l) => l.num));
const inventory = taxiwayInventory(specs.values());
selfCheck(script, specs);

let lines = script;
if (values.lines) {
  const wanted = values.lines.split(",").map((s) => s.trim().padStart(2, "0"));
  const unknown = wanted.filter((n) => !script.some((l) => l.num === n));
  if (unknown.length) fail(`--lines: not in script.md: ${unknown.join(", ")}`);
  lines = script.filter((l) => wanted.includes(l.num));
}
if (values.limit) lines = lines.slice(0, positiveNumber("limit", values.limit));

/** The scorer must give the reference text itself 0% WER and 100% critical tokens. */
function selfCheck(all: ScriptLine[], s: Map<string, CriticalSpec>): void {
  const problems: string[] = [];
  for (const line of all) {
    const score = scoreLine(line, line.say, s.get(line.num)!, taxiwayInventory(s.values()));
    if (!score) continue;
    const edits = score.wer.substitutions + score.wer.deletions + score.wer.insertions;
    if (edits !== 0) problems.push(`${line.num}: reference vs itself has ${edits} edits`);
    for (const c of CATEGORIES) {
      if (score.critical[c].missed.length) problems.push(`${line.num}: annotated ${c} not found in the say text: ${score.critical[c].missed.join(", ")}`);
    }
  }
  if (problems.length) fail(`critical-token self-check failed:\n  - ${problems.join("\n  - ")}`);
}

// ---- run ---------------------------------------------------------------------------------

mkdirSync(outDir, { recursive: true });
const method = {
  chunkMs,
  pacing: "chunk sent when its last sample would have been spoken (start + audio time of chunk end); tails < 20 ms merged into the previous chunk",
  session: "one fresh WebSocket session per clip, opened and configured before audio starts (connect time is not in latency)",
  latency: "performance.now() at final-transcript message arrival minus performance.now() just after the last audio chunk was handed to the socket; the end-of-turn signal is sent immediately after the last chunk",
  normalization: "stt/normalize.ts (lowercase, punctuation stripped, numbers to single digits, spelling equivalences)",
  wer: "corpus-level: total substitutions+deletions+insertions / total reference tokens; a line with no transcript counts as all deleted",
  criticalTokens: "results/stt/critical-tokens.json, matched by stt/critical.ts",
  p95: "nearest rank (ceil(0.95 n)-th smallest)",
};

const rows: Array<{ candidate: Candidate; summary: ResultFile["summary"] }> = [];
for (const candidate of candidates) {
  const config = candidate.describeConfig(opts);
  let file = loadResult(outDir, candidate);

  if (values.rescore) {
    if (!file) {
      console.error(`stt-bench: no saved results for ${candidate.id} in ${outDir}; skipping`);
      continue;
    }
    for (const entry of file.lines) {
      const line = script.find((l) => l.num === entry.num);
      if (!line) fail(`${candidate.id}: saved line ${entry.num} is not in script.md`);
      entry.say = line.say;
      entry.score = scoreLine(line, entry.transcript, specs.get(line.num)!, inventory);
    }
  } else {
    try {
      requireKey(KEY_VARS[candidate.provider]);
    } catch (err) {
      fail(`${candidate.id}: ${describeError(err)}`);
    }
    if (file && JSON.stringify(file.config) !== JSON.stringify(config)) {
      if (lines.length !== script.length) {
        fail(`${candidate.id}: saved results used a different config; re-run all ${script.length} lines or use --out`);
      }
      file = null;
    }
    file ??= {
      candidate: candidate.id,
      provider: candidate.provider,
      model: candidate.model,
      pricing: candidate.pricing,
      config,
      method,
      updatedAt: new Date().toISOString(),
      summary: summarize(candidate, [], specs),
      lines: [],
    };
    const current: ResultFile = file;
    console.log(`\n${candidate.id} (${lines.length} lines, ${candidate.sampleRate} Hz, ${chunkMs} ms chunks)`);
    const runOptions: RunOptions = { chunkMs, finalTimeoutMs, opts };
    for (const line of lines) {
      const pcm = await decodePcm(join(AUDIO_DIR, `${line.num}.webm`), candidate.sampleRate);
      const audioSec = durationSec(pcm, candidate.sampleRate);
      const spent = spendTotal(ledgerPath);
      const projected = spent + clipCost(candidate, audioSec * 2, null).usd;
      if (projected > maxSpend) {
        console.error(`stt-bench: stopping before ${candidate.id} line ${line.num}: estimated spend $${spent.toFixed(3)} would pass --max-spend $${maxSpend}`);
        process.exitCode = 3;
        break;
      }
      const result = await candidate.run({ num: line.num, pcm, sampleRate: candidate.sampleRate, durationSec: audioSec }, runOptions);
      const entry: LineEntry = {
        num: line.num,
        say: line.say,
        style: line.style,
        audioSec: Math.round(audioSec * 1000) / 1000,
        runAt: new Date().toISOString(),
        ...result,
        score: scoreLine(line, result.transcript, specs.get(line.num)!, inventory),
      };
      current.lines = current.lines.filter((l) => l.num !== line.num);
      current.lines.push(entry);
      current.updatedAt = new Date().toISOString();
      current.summary = summarize(candidate, current.lines, specs);
      saveResult(outDir, current);
      const cost = clipCost(candidate, audioSec, result.timings.billedSessionSec);
      appendSpend(ledgerPath, { at: entry.runAt, candidate: candidate.id, lines: 1, billedMin: cost.billedMin, estUsd: cost.usd });
      printProgress(entry, spent + cost.usd);
    }
  }
  file.summary = summarize(candidate, file.lines, specs);
  file.updatedAt = new Date().toISOString();
  saveResult(outDir, file);
  rows.push({ candidate, summary: file.summary });
}

if (rows.length > 0) {
  console.log(`\nResults (${outDir}):\n`);
  console.log(formatTables(rows));
  const missing = rows.filter((r) => r.summary.lines < script.length).map((r) => `${r.candidate.id} has ${r.summary.lines}/${script.length} lines`);
  if (missing.length) console.log(`\nIncomplete: ${missing.join("; ")}`);
  for (const r of rows) {
    if (r.summary.errors.length) console.log(`\n${r.candidate.id} errors:\n  ${r.summary.errors.join("\n  ")}`);
    if (r.summary.lateText.length) console.log(`\n${r.candidate.id} text after the final (final was incomplete):\n  ${r.summary.lateText.join("\n  ")}`);
  }
}
console.log(`\nEstimated spend so far (all runs, spend-log.jsonl, list rates): $${spendTotal(ledgerPath).toFixed(3)}`);

function printProgress(e: LineEntry, total: number): void {
  const lat = e.latencyMs === null ? "   —   " : `${String(Math.round(e.latencyMs)).padStart(5)} ms`;
  let score = "";
  if (e.score) {
    const edits = e.score.wer.substitutions + e.score.wer.deletions + e.score.wer.insertions;
    const exp = CATEGORIES.reduce((n, c) => n + e.score!.critical[c].expected, 0);
    const found = CATEGORIES.reduce((n, c) => n + e.score!.critical[c].found, 0);
    score = `WER ${((edits / Math.max(1, e.score.wer.refWords)) * 100).toFixed(0).padStart(3)}%  crit ${found}/${exp}`;
  }
  const text = e.error ? `ERROR ${e.error}` : JSON.stringify(e.transcript ?? "");
  console.log(`  ${e.num} ${e.audioSec.toFixed(2)} s  ${lat}  ${score}  $${total.toFixed(3)}  ${text.slice(0, 110)}`);
}

