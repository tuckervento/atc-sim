/**
 * Phase 0, task 0.5: voice bake-off.
 *
 * Sends pilot readbacks from test-set/script.md through each shortlisted voice service and
 * measures time to first audio (request sent → first audio bytes), checks that speaking-rate
 * control works against Q's own controller cadence (test-set/audio/), counts usable pilot voices
 * and accented-English voices from each catalog, and, for OpenAI, how often the model paraphrases
 * instead of reading the line word for word. Requests run one at a time.
 *
 * Writes:
 *   samples/<provider>/<voice>/<line>-x<speed>.wav  clips for Q (gitignored)
 *   samples/index.html                             listening + rating page (open as a file)
 *   results/tts/<run>.json, <run>-summary.txt      raw timings and the printed tables
 *
 * Run: npm --prefix spikes/voice-loop run tts-bench -- [options]
 *   --provider elevenlabs|cartesia|openai   repeatable; default all three
 *   --limit N                               first N timing lines (and at most N sample/calibration lines)
 *   --voice <id>                            only this voice (a plan voice, or any provider voice id)
 *   --speed X                               skip calibration and use this speed
 *   --dry-run                               print the request plan and cost estimate; no API calls
 *   --page-only                             rebuild samples/index.html from the manifests; no API calls
 *   --out DIR                               write samples/ and results/tts/ under DIR instead (test slices)
 *
 * Never prints or saves key values; error text is redacted as in check-keys.ts.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { SAMPLE_RATE, speechSpan, wavFromPcm16 } from "./tts/audio.ts";
import { controllerCadence, loadScript, type Cadence, type ScriptLine } from "./tts/cadence.ts";
import * as cartesia from "./tts/cartesia.ts";
import {
  loadEnvLocal,
  median,
  normalizeWords,
  percentile,
  ProviderError,
  requireKey,
  sanitize,
  slug,
  SPIKE_DIR,
  wordCount,
  wordDiff,
} from "./tts/common.ts";
import * as eleven from "./tts/elevenlabs.ts";
import * as openai from "./tts/openai.ts";
import { buildPage, formatTable, mergeManifest, readManifest, type SampleEntry } from "./tts/report.ts";
import { catalogFor, PROVIDERS, VOICE_PLAN, type Catalog, type ProviderName, type VoicePick } from "./tts/voices.ts";

// ---------------------------------------------------------------------------------------------
// Plan

/** 15 readbacks: short and long, numbers, frequencies, "heavy", international airlines. */
const TIMING_LINES = ["02", "05", "06", "07", "08", "11", "16", "19", "21", "22", "24", "25", "30", "31", "33"];
/** Same lines at every speed, on the primary voice, to check rate control. Six, because the same line at the same speed varies ~10% run to run. */
const CAL_LINES = ["02", "06", "19", "22", "24", "33"];
/** What the non-primary voices read, so voices compare on equal footing. */
const SAMPLE_LINES = ["05", "06", "24", "31"];
const SPEEDS: Record<ProviderName, number[]> = {
  // ×1 already runs faster than Q in a smoke test, so one slower setting too. Range 0.7–1.2.
  elevenlabs: [0.9, 1, 1.1, 1.2],
  // sonic-3.6 treats speed as guidance and moved little in smoke tests, so the full top of the range. Range 0.6–1.5.
  cartesia: [1, 1.25, 1.5],
  // A playback-rate change after generation. Range 0.25–1.5.
  openai: [1, 1.15, 1.3],
};
/** Does `speed` work on another model of the same provider? Primary voice, two lines, two speeds. */
const MODEL_CHECKS: Partial<Record<ProviderName, { model: string; speeds: number[] }>> = {
  // The Agents docs say v4 Turbo has no rate control (shortlist note for 0.5).
  elevenlabs: { model: eleven.TURBO_MODEL, speeds: [1, 1.2] },
  // Cartesia's changelog: the 2026-01-12 sonic-3 checkpoint has "consistent speed & volume".
  cartesia: { model: "sonic-3", speeds: [1, 1.3] },
};
const MODEL_CHECK_LINES = ["02", "24"];
const ENV_VARS: Record<ProviderName, string> = {
  elevenlabs: eleven.ENV_VAR,
  cartesia: cartesia.ENV_VAR,
  openai: openai.ENV_VAR,
};
const MODELS: Record<ProviderName, string> = {
  elevenlabs: eleven.MODEL,
  cartesia: cartesia.MODEL,
  openai: openai.MODEL,
};
/** Est. $/hr at the peak assumption, from docs/spikes/voice-loop.md § Shortlist. */
const PEAK_COST: Record<ProviderName, string> = { elevenlabs: "$1.26", cartesia: "$1.20–$2.05", openai: "$0.78" };
/** Rough per-line OpenAI cost for dry runs (seen in smoke tests: ~$0.0015). */
const OPENAI_USD_PER_LINE_EST = 0.002;
/** Stop the run if estimated spend passes this (task budget ~$5). */
const SPEND_LIMIT_USD = 4;
/** Realtime reasoning effort for the main OpenAI run. "none" removed reasoning tokens and was fastest in smoke tests. */
const OPENAI_EFFORT = "none";
const MAX_CONSECUTIVE_FAILURES = 3;

/** Output folders; `--out DIR` moves both under DIR (for test slices). */
const paths = { samples: join(SPIKE_DIR, "samples"), results: join(SPIKE_DIR, "results", "tts") };

type Phase = "warmup" | "calibration" | "timing" | "voices" | "check";

interface Job {
  phase: Phase;
  voice: VoicePick;
  speed: number;
  line: ScriptLine;
  /** Counted in the time-to-first-audio stats. */
  inStats: boolean;
  /** Saved as a sample in this page group, or not saved. */
  group: SampleEntry["group"] | null;
  variant: string;
  model?: string;
  /** Cartesia: drop the voice's accent field (comparison). */
  noAccent?: boolean;
  /** OpenAI: reasoning effort; "default" sends no reasoning field. */
  effort?: string;
}

interface Rec {
  runId: string;
  provider: ProviderName;
  phase: Phase;
  inStats: boolean;
  voiceId: string;
  voiceName: string;
  model: string;
  speed: number;
  variant: string;
  line: string;
  text: string;
  chars: number;
  words: number;
  ok: boolean;
  error?: string;
  ttfaMs?: number;
  headersMs?: number;
  totalMs?: number;
  sessionSetupMs?: number;
  /** HTTP providers: this request opened a new HTTPS connection. */
  newConnection?: boolean;
  /** OpenAI: reasoning setting echoed by the server (first line of each session), and reasoning tokens used. */
  sessionReasoning?: string;
  reasoningTokens?: number;
  audioS?: number;
  speechS?: number;
  wpm?: number;
  transcript?: string;
  paraphraseEdits?: number;
  paraphraseOps?: string[];
  costUsd: number;
  file?: string;
}

interface Options {
  providers: ProviderName[];
  limit: number | undefined;
  voice: string | undefined;
  speed: number | undefined;
  dryRun: boolean;
  /** Rebuild samples/index.html from the manifests; no API calls. */
  pageOnly: boolean;
  /** A full run (no --limit, --voice or --speed) replaces the provider's sample manifest; a slice merges into it. */
  full: boolean;
}

function parseOptions(): Options {
  const { values } = parseArgs({
    options: {
      provider: { type: "string", multiple: true },
      limit: { type: "string" },
      voice: { type: "string" },
      speed: { type: "string" },
      "dry-run": { type: "boolean" },
      "page-only": { type: "boolean" },
      out: { type: "string" },
    },
    strict: true,
  });
  const providers = (values.provider ?? PROVIDERS).flatMap((p) => p.split(","));
  for (const p of providers) {
    if (!PROVIDERS.includes(p as ProviderName)) throw new Error(`--provider: expected one of ${PROVIDERS.join(", ")}, got '${p}'`);
  }
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error(`--limit: expected a positive integer, got '${values.limit}'`);
  const speed = values.speed === undefined ? undefined : Number(values.speed);
  if (speed !== undefined && !(speed > 0)) throw new Error(`--speed: expected a positive number, got '${values.speed}'`);
  if (values.voice !== undefined && providers.length !== 1) throw new Error("--voice needs exactly one --provider");
  if (values.out !== undefined) {
    paths.samples = join(values.out, "samples");
    paths.results = join(values.out, "results", "tts");
  }
  const full = limit === undefined && values.voice === undefined && speed === undefined;
  return { providers: providers as ProviderName[], limit, voice: values.voice, speed, dryRun: values["dry-run"] ?? false, pageOnly: values["page-only"] ?? false, full };
}

function voicesFor(provider: ProviderName, opts: Options): VoicePick[] {
  const plan = VOICE_PLAN[provider];
  if (opts.voice === undefined) return plan;
  const matches = plan.filter((v) => v.id === opts.voice);
  if (matches.length > 0) return matches.slice(0, 1);
  return [{ id: opts.voice, name: opts.voice, note: "voice given with --voice", accentLabel: "unknown" }];
}

function pickLines(script: ScriptLine[], nums: string[], limit: number | undefined): ScriptLine[] {
  return nums.slice(0, limit ?? nums.length).map((num) => {
    const line = script.find((l) => l.num === num);
    if (!line) throw new Error(`script.md has no line ${num}`);
    return line;
  });
}

/** Jobs that run after the speed is chosen. */
function laterJobs(provider: ProviderName, opts: Options, script: ScriptLine[], speed: number): Job[] {
  const voices = voicesFor(provider, opts);
  const [primary, ...others] = voices;
  if (!primary) return [];
  const timing = pickLines(script, TIMING_LINES, opts.limit);
  const samples = pickLines(script, SAMPLE_LINES, opts.limit === undefined ? undefined : Math.min(opts.limit, SAMPLE_LINES.length));
  const effort = provider === "openai" ? OPENAI_EFFORT : undefined;
  const jobs: Job[] = [];
  for (const line of timing) {
    jobs.push({ phase: "timing", voice: primary, speed, line, inStats: true, group: "voice", variant: "", effort });
  }
  for (const voice of others) {
    for (const line of samples) {
      jobs.push({ phase: "voices", voice, speed, line, inStats: true, group: "voice", variant: "", effort });
    }
  }
  if (opts.voice !== undefined) return jobs;
  const check = MODEL_CHECKS[provider];
  if (check) {
    for (const line of pickLines(script, MODEL_CHECK_LINES, opts.limit === undefined ? undefined : Math.min(opts.limit, MODEL_CHECK_LINES.length))) {
      for (const s of check.speeds) {
        jobs.push({ phase: "check", voice: primary, speed: s, line, inStats: false, group: "check", variant: `model ${check.model}`, model: check.model });
      }
    }
  }
  if (provider === "cartesia") {
    // The same accented voice without the accent field, to hear what the field changes.
    const accented = others.find((v) => v.accent);
    if (accented) {
      jobs.push({ phase: "check", voice: accented, speed, line: samples[0] as ScriptLine, inStats: false, group: "check", variant: "no accent field", noAccent: true });
    }
  }
  if (provider === "openai") {
    // Paraphrase and latency at the model's default reasoning effort, for comparison.
    for (const line of timing) {
      jobs.push({ phase: "check", voice: primary, speed, line, inStats: false, group: null, variant: "reasoning effort default", effort: "default" });
    }
  }
  return jobs;
}

function calibrationJobs(provider: ProviderName, opts: Options, script: ScriptLine[]): Job[] {
  if (opts.speed !== undefined) return [];
  const primary = voicesFor(provider, opts)[0];
  if (!primary) return [];
  const lines = pickLines(script, CAL_LINES, opts.limit === undefined ? undefined : Math.min(opts.limit, CAL_LINES.length));
  const effort = provider === "openai" ? OPENAI_EFFORT : undefined;
  return SPEEDS[provider].flatMap((speed) =>
    lines.map((line): Job => ({ phase: "calibration", voice: primary, speed, line, inStats: false, group: "speed", variant: "", effort })),
  );
}

// ---------------------------------------------------------------------------------------------
// Synthesis

interface Outcome {
  newConnection?: boolean;
  pcm: Buffer;
  ttfaMs: number;
  headersMs?: number;
  totalMs: number;
  transcript?: string;
  costUsd: number;
  sessionSetupMs?: number;
  /** OpenAI: the reasoning setting the server echoed in session.updated (first line of a session). */
  sessionReasoning?: string;
  reasoningTokens?: number;
}

/** One OpenAI session per (voice, speed, instructions, effort); a session can't change voice once it has spoken. */
class OpenAiSessions {
  private sessions = new Map<string, openai.RealtimeVoice>();
  private key: string;
  constructor(key: string) {
    this.key = key;
  }
  async get(job: Job): Promise<{ session: openai.RealtimeVoice; setupMs?: number; echoedReasoning?: string }> {
    const id = `${job.voice.id}|${job.speed}|${job.voice.extraInstructions ?? ""}|${job.effort ?? ""}`;
    const existing = this.sessions.get(id);
    if (existing) return { session: existing };
    const extra: Record<string, unknown> = {};
    if (job.effort && job.effort !== "default") extra.reasoning = { effort: job.effort };
    if (job.voice.extraInstructions) extra.instructions = `${openai.INSTRUCTIONS} ${job.voice.extraInstructions}`;
    const session = await openai.RealtimeVoice.open(this.key, job.voice.id, job.speed, extra);
    this.sessions.set(id, session);
    return { session, setupMs: session.setupMs, echoedReasoning: JSON.stringify(session.echoed.reasoning ?? null) };
  }
  closeAll(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }
}

async function synthesize(provider: ProviderName, key: string, job: Job, sessions: OpenAiSessions | undefined): Promise<Outcome> {
  const text = job.line.readback;
  if (provider === "elevenlabs") {
    const r = await eleven.synth(key, { text, voiceId: job.voice.id, speed: job.speed, model: job.model });
    return { ...r, costUsd: text.length * eleven.USD_PER_CHAR };
  }
  if (provider === "cartesia") {
    const accent = job.noAccent ? undefined : job.voice.accent;
    const r = await cartesia.synth(key, { text, voiceId: job.voice.id, speed: job.speed, accent, model: job.model });
    return { ...r, costUsd: text.length * cartesia.USD_PER_CHAR };
  }
  if (!sessions) throw new Error("internal: OpenAI sessions not set up");
  const { session, setupMs, echoedReasoning } = await sessions.get(job);
  const r = await session.say(text);
  return {
    pcm: r.pcm,
    ttfaMs: r.ttfaMs,
    totalMs: r.totalMs,
    transcript: r.transcript,
    costUsd: r.costUsd,
    sessionSetupMs: setupMs,
    sessionReasoning: echoedReasoning,
    reasoningTokens: r.usage.output_token_details?.reasoning_tokens ?? 0,
  };
}

class SpendLimitError extends Error {}

class Spend {
  total = 0;
  add(usd: number): void {
    this.total += usd;
    if (this.total > SPEND_LIMIT_USD) {
      throw new SpendLimitError(`estimated spend $${this.total.toFixed(2)} passed the $${SPEND_LIMIT_USD} limit; stopping`);
    }
  }
}

function sampleFile(provider: ProviderName, job: Job): string {
  const variant = job.variant ? `-${slug(job.variant)}` : "";
  // Calibration clips get their own folder: the timing set reads some of the same lines at the chosen speed.
  const folder = job.group === "speed" ? "speed/" : "";
  return `${provider}/${slug(job.voice.name)}/${folder}${job.line.num}-x${job.speed}${variant}.wav`;
}

async function runJob(provider: ProviderName, key: string, job: Job, ctx: RunContext): Promise<Rec> {
  const text = job.line.readback;
  const base: Rec = {
    runId: ctx.runId,
    provider,
    phase: job.phase,
    inStats: job.inStats,
    voiceId: job.voice.id,
    voiceName: job.voice.name,
    model: job.model ?? MODELS[provider],
    speed: job.speed,
    variant: job.variant,
    line: job.line.num,
    text,
    chars: text.length,
    words: wordCount(text),
    ok: false,
    costUsd: 0,
  };
  let out: Outcome;
  try {
    out = await synthesize(provider, key, job, ctx.sessions);
  } catch (err) {
    if (err instanceof SpendLimitError) throw err;
    // ProviderError messages are already redacted; anything else is unexpected, and redacted too.
    const message = err instanceof ProviderError ? err.message : sanitize(`unexpected: ${err instanceof Error ? err.message : String(err)}`, key);
    // Failed requests are rarely billed; count the characters anyway to stay conservative.
    if (provider !== "openai") ctx.spend.add(job.line.readback.length * (provider === "elevenlabs" ? eleven.USD_PER_CHAR : cartesia.USD_PER_CHAR));
    return { ...base, error: message };
  }
  ctx.spend.add(out.costUsd);
  const span = speechSpan(out.pcm, SAMPLE_RATE);
  const rec: Rec = {
    ...base,
    ok: true,
    ttfaMs: out.ttfaMs,
    headersMs: out.headersMs,
    totalMs: out.totalMs,
    sessionSetupMs: out.sessionSetupMs,
    newConnection: out.newConnection,
    sessionReasoning: out.sessionReasoning,
    reasoningTokens: out.reasoningTokens,
    audioS: span.totalS,
    speechS: span.speechS,
    wpm: span.speechS > 0 ? (base.words / span.speechS) * 60 : Number.NaN,
    costUsd: out.costUsd,
  };
  if (out.transcript !== undefined) {
    const diff = wordDiff(normalizeWords(text), normalizeWords(out.transcript));
    rec.transcript = out.transcript;
    rec.paraphraseEdits = diff.edits;
    rec.paraphraseOps = diff.ops;
  }
  if (job.group) {
    const file = sampleFile(provider, job);
    mkdirSync(dirname(join(paths.samples, file)), { recursive: true });
    writeFileSync(join(paths.samples, file), wavFromPcm16(out.pcm, SAMPLE_RATE));
    rec.file = file;
    ctx.samples.push({
      file,
      provider,
      voiceName: job.voice.name,
      voiceId: job.voice.id,
      accentLabel: job.noAccent ? `${job.voice.accentLabel}, without the accent field` : job.voice.accentLabel,
      voiceNote: job.voice.note,
      group: job.group,
      model: rec.model,
      variant: job.variant,
      line: job.line.num,
      text,
      speed: job.speed,
      ttfaMs: out.ttfaMs,
      wpm: rec.wpm as number,
      transcript: rec.transcript,
      paraphraseOps: rec.paraphraseOps,
      runId: ctx.runId,
    });
  }
  return rec;
}

interface RunContext {
  runId: string;
  spend: Spend;
  sessions: OpenAiSessions | undefined;
  samples: SampleEntry[];
}

// ---------------------------------------------------------------------------------------------
// Per-provider run

interface SpeedRow {
  speed: number;
  n: number;
  medianWpm: number;
  /** Median over lines of (speech time at 1.0) / (speech time at this speed). */
  speedup: number;
}

interface ProviderResult {
  provider: ProviderName;
  model: string;
  catalog: Catalog | undefined;
  catalogError: string | undefined;
  records: Rec[];
  chosenSpeed: number | undefined;
  speedRows: SpeedRow[];
  /** MODEL_CHECKS result: speed on another model. */
  checkRows: SpeedRow[];
  aborted: string | undefined;
  costUsd: number;
}

function log(msg: string): void {
  console.error(msg);
}

function describeRec(r: Rec): string {
  const what = `${r.provider} ${r.voiceName} ×${r.speed}${r.variant ? ` [${r.variant}]` : ""} line ${r.line}`;
  if (!r.ok) return `  FAIL ${what}: ${r.error}`;
  const para = r.transcript === undefined ? "" : r.paraphraseEdits ? ` changed: ${(r.paraphraseOps ?? []).join(", ")}` : " word-for-word";
  const conn = r.newConnection ? " (new connection)" : "";
  return `  ${r.phase.padEnd(11)} ${what}: first audio ${Math.round(r.ttfaMs ?? 0)} ms${conn}, ${r.speechS?.toFixed(2)} s speech, ${Math.round(r.wpm ?? 0)} wpm${para}`;
}

function speedTable(records: Rec[], speeds: number[]): SpeedRow[] {
  const ok = records.filter((r) => r.ok && r.speechS);
  const at = (s: number) => ok.filter((r) => r.speed === s);
  const base = new Map(at(1).map((r) => [r.line, r.speechS as number]));
  return speeds
    .map((speed) => {
      const rows = at(speed);
      const ratios = rows.filter((r) => base.has(r.line)).map((r) => (base.get(r.line) as number) / (r.speechS as number));
      return { speed, n: rows.length, medianWpm: median(rows.map((r) => r.wpm as number)), speedup: median(ratios) };
    })
    .filter((row) => row.n > 0);
}

/** The tested speed whose median wpm is closest to Q's median. */
function chooseSpeed(rows: SpeedRow[], targetWpm: number): number | undefined {
  let best: SpeedRow | undefined;
  for (const row of rows) {
    if (!best || Math.abs(row.medianWpm - targetWpm) < Math.abs(best.medianWpm - targetWpm)) best = row;
  }
  return best?.speed;
}

async function runProvider(provider: ProviderName, opts: Options, script: ScriptLine[], cadence: Cadence, ctx: RunContext): Promise<ProviderResult> {
  const result: ProviderResult = {
    provider,
    model: MODELS[provider],
    catalog: undefined,
    catalogError: undefined,
    records: [],
    chosenSpeed: undefined,
    speedRows: [],
    checkRows: [],
    aborted: undefined,
    costUsd: 0,
  };
  const spendBefore = ctx.spend.total;
  const key = requireKey(ENV_VARS[provider]);
  log(`\n== ${provider} (${MODELS[provider]})`);
  try {
    result.catalog = await catalogFor(provider, key);
    log(`  catalog: ${result.catalog.usableNow} usable now, ${result.catalog.usableCatalog} in catalog, ${result.catalog.totalEnglish} English voices`);
  } catch (err) {
    result.catalogError = err instanceof Error ? err.message : String(err);
    log(`  catalog FAILED: ${result.catalogError}`);
  }
  ctx.sessions = provider === "openai" ? new OpenAiSessions(key) : undefined;
  let consecutive = 0;
  const run = async (jobs: Job[]): Promise<void> => {
    for (const job of jobs) {
      if (result.aborted) return;
      const rec = await runJob(provider, key, job, ctx);
      result.records.push(rec);
      log(describeRec(rec));
      if (rec.ok) {
        consecutive = 0;
        continue;
      }
      consecutive++;
      if (/^HTTP (401|402|403)\b/.test(rec.error ?? "")) result.aborted = `stopped after an auth/plan error: ${rec.error}`;
      else if (consecutive >= MAX_CONSECUTIVE_FAILURES) result.aborted = `stopped after ${consecutive} failures in a row; last: ${rec.error}`;
    }
  };
  try {
    const primary = voicesFor(provider, opts)[0];
    if (provider !== "openai" && primary) {
      // Opens the HTTPS connection so later requests reuse it, as a game server would. Not in the stats.
      const line = pickLines(script, [TIMING_LINES[0] as string], undefined)[0] as ScriptLine;
      await run([{ phase: "warmup", voice: primary, speed: 1, line, inStats: false, group: null, variant: "" }]);
    }
    await run(calibrationJobs(provider, opts, script));
    result.speedRows = speedTable(result.records.filter((r) => r.phase === "calibration"), SPEEDS[provider]);
    result.chosenSpeed = opts.speed ?? chooseSpeed(result.speedRows, cadence.medianWpm) ?? 1;
    log(`  speed: ${result.speedRows.map((r) => `×${r.speed} → ${Math.round(r.medianWpm)} wpm`).join(", ") || "not calibrated"}; using ×${result.chosenSpeed} (Q: ${Math.round(cadence.medianWpm)} wpm)`);
    await run(laterJobs(provider, opts, script, result.chosenSpeed));
    const check = MODEL_CHECKS[provider];
    if (check) result.checkRows = speedTable(result.records.filter((r) => r.variant === `model ${check.model}`), check.speeds);
  } finally {
    ctx.sessions?.closeAll();
    ctx.sessions = undefined;
    result.costUsd = ctx.spend.total - spendBefore;
  }
  if (result.aborted) log(`  ${result.aborted}`);
  return result;
}

// ---------------------------------------------------------------------------------------------
// Summary

const fmtMs = (x: number): string => (Number.isFinite(x) ? `${Math.round(x)} ms` : "—");

function ttfaStats(records: Rec[]): { n: number; median: number; p95: number; min: number; max: number } {
  const xs = records.filter((r) => r.ok && r.inStats).map((r) => r.ttfaMs as number);
  return { n: xs.length, median: median(xs), p95: percentile(xs, 95), min: Math.min(...xs), max: Math.max(...xs) };
}

/**
 * Verdict from the paired speedup at the fastest setting (same lines, speech time at ×1 divided
 * by speech time at that speed): y ≥ 1.10, weak 1.03–1.10, n below. Run-to-run variation of the
 * same line is ~10%, so smaller effects aren't distinguishable with six lines.
 */
function rateControl(rows: SpeedRow[]): string {
  const fastest = rows[rows.length - 1];
  if (rows.length < 2 || !fastest || !Number.isFinite(fastest.speedup)) return "not checked";
  const verdict = fastest.speedup >= 1.1 ? "y" : fastest.speedup >= 1.03 ? "weak" : "n";
  return `${verdict} (×${fastest.speed} → ${fastest.speedup.toFixed(2)}× faster)`;
}

function paraphrase(records: Rec[], effortVariant: string): { changed: number; total: number } {
  const rs = records.filter((r) => r.ok && r.transcript !== undefined && r.variant === effortVariant);
  return { changed: rs.filter((r) => (r.paraphraseEdits ?? 0) > 0).length, total: rs.length };
}

function summarize(results: ProviderResult[], cadence: Cadence, spend: Spend): string {
  const out: string[] = [];
  const main: string[][] = [
    ["Provider", "Model", "First audio median", "p95", "n", "Usable voices (now / catalog)", "Rate control (verified)", "Accents", "$/hr at peak", "Paraphrase"],
  ];
  for (const r of results) {
    const s = ttfaStats(r.records);
    const c = r.catalog;
    const p = r.provider === "openai" ? paraphrase(r.records, "") : undefined;
    main.push([
      r.provider,
      r.model,
      fmtMs(s.median),
      fmtMs(s.p95),
      String(s.n),
      c ? `${c.usableNow} / ${c.usableCatalog}` : `catalog failed`,
      rateControl(r.speedRows),
      c ? (c.accents.available ? "y" : "n") : "?",
      PEAK_COST[r.provider],
      p ? `${p.changed}/${p.total} lines changed` : "n/a (verbatim API)",
    ]);
  }
  out.push("Voices: time to first audio (request sent → first audio bytes), timing + voice lines at the chosen speed");
  out.push(formatTable(main));

  out.push("", `Speaking rate (primary voice, calibration lines). Q's controller cadence: median ${Math.round(cadence.medianWpm)} wpm, middle half ${Math.round(cadence.p25Wpm)}–${Math.round(cadence.p75Wpm)}, pooled ${Math.round(cadence.pooledWpm)} (${cadence.lines.length} recordings)`);
  const rate: string[][] = [["Provider", "Speed", "n", "Median wpm", "Speech-time speedup vs ×1", "vs Q's median", "Chosen"]];
  for (const r of results) {
    for (const row of r.speedRows) {
      rate.push([
        r.provider,
        `×${row.speed}`,
        String(row.n),
        String(Math.round(row.medianWpm)),
        Number.isFinite(row.speedup) ? `${row.speedup.toFixed(2)}×` : "—",
        `${row.medianWpm >= cadence.medianWpm ? "+" : ""}${Math.round(((row.medianWpm - cadence.medianWpm) / cadence.medianWpm) * 100)}%`,
        row.speed === r.chosenSpeed ? "◀" : "",
      ]);
    }
    for (const row of r.checkRows) {
      rate.push([`${r.provider} ${MODEL_CHECKS[r.provider]?.model ?? "?"}`, `×${row.speed}`, String(row.n), String(Math.round(row.medianWpm)), Number.isFinite(row.speedup) ? `${row.speedup.toFixed(2)}×` : "—", "", ""]);
    }
  }
  out.push(formatTable(rate));

  out.push("", "Time to first audio by voice (in-stats lines)");
  const byVoice: string[][] = [["Provider", "Voice", "n", "Median", "p95", "Min", "Max", "Median wpm", "New connections"]];
  for (const r of results) {
    for (const name of [...new Set(r.records.filter((x) => x.inStats).map((x) => x.voiceName))]) {
      const rs = r.records.filter((x) => x.inStats && x.voiceName === name);
      const s = ttfaStats(rs);
      const conns = r.provider === "openai" ? "n/a" : String(rs.filter((x) => x.newConnection).length);
      byVoice.push([r.provider, name, String(s.n), fmtMs(s.median), fmtMs(s.p95), fmtMs(s.min), fmtMs(s.max), String(Math.round(median(rs.filter((x) => x.ok).map((x) => x.wpm as number)))), conns]);
    }
    const warm = r.records.find((x) => x.phase === "warmup");
    if (warm?.ok) byVoice.push([r.provider, `(warm-up, not in stats)`, "1", fmtMs(warm.ttfaMs ?? Number.NaN), "", "", "", "", warm.newConnection ? "1" : "0"]);
    const setups = r.records.filter((x) => x.sessionSetupMs !== undefined).map((x) => x.sessionSetupMs as number);
    if (setups.length > 0) byVoice.push([r.provider, `(session setup: connect → session.updated)`, String(setups.length), fmtMs(median(setups)), fmtMs(percentile(setups, 95)), fmtMs(Math.min(...setups)), fmtMs(Math.max(...setups)), "", ""]);
    const def = r.records.filter((x) => x.variant === "reasoning effort default");
    if (def.length > 0) {
      const xs = def.filter((x) => x.ok).map((x) => x.ttfaMs as number);
      byVoice.push([r.provider, `(primary, reasoning effort default)`, String(xs.length), fmtMs(median(xs)), fmtMs(percentile(xs, 95)), fmtMs(Math.min(...xs)), fmtMs(Math.max(...xs)), "", ""]);
    }
  }
  out.push(formatTable(byVoice));

  const oa = results.find((r) => r.provider === "openai");
  if (oa) {
    out.push("", `OpenAI paraphrasing (its transcript of what it said vs the input line; words normalized for case, punctuation, hyphens)`);
    for (const [label, variant] of [[`effort ${OPENAI_EFFORT} (main run)`, ""], ["effort default", "reasoning effort default"]] as const) {
      const p = paraphrase(oa.records, variant);
      const rs = oa.records.filter((r) => r.ok && r.variant === variant);
      const echoed = [...new Set(rs.map((r) => r.sessionReasoning).filter((x) => x !== undefined))].join(" / ") || "—";
      const tokens = rs.map((r) => r.reasoningTokens).filter((x): x is number => x !== undefined);
      out.push(`  ${label}: ${p.changed}/${p.total} lines changed; server echoed reasoning ${echoed}; reasoning tokens per line median ${tokens.length ? median(tokens) : "—"}`);
    }
    const changed = oa.records.filter((r) => r.ok && (r.paraphraseEdits ?? 0) > 0);
    const ops = new Map<string, number>();
    for (const r of changed) for (const op of r.paraphraseOps ?? []) ops.set(op, (ops.get(op) ?? 0) + 1);
    out.push(`  edits seen (all OpenAI lines incl. calibration): ${[...ops.entries()].sort((a, b) => b[1] - a[1]).map(([op, n]) => `${op} ×${n}`).join(", ") || "none"}`);
  }

  out.push("", "Catalog");
  for (const r of results) {
    const c = r.catalog;
    if (!c) {
      out.push(`  ${r.provider}: catalog failed: ${r.catalogError}`);
      continue;
    }
    out.push(`  ${r.provider}: ${c.usableNow} usable now, ${c.usableCatalog} in catalog, of ${c.totalEnglish} English voices. Criteria: ${c.criteria}`);
    out.push(`    accents: ${c.accents.available ? "y" : "n"}. ${c.accents.note}`);
    const counts = Object.entries(c.accents.counts).map(([k, n]) => `${k} ${n}`);
    if (counts.length > 0) out.push(`    counts: ${counts.join(", ")}`);
    if (c.accents.examples.length > 0) out.push(`    examples: ${c.accents.examples.slice(0, 8).join("; ")}`);
  }

  const failures = results.flatMap((r) => r.records.filter((x) => !x.ok));
  out.push("", `Failures: ${failures.length}`);
  for (const f of failures) out.push(describeRec(f));
  for (const r of results) if (r.aborted) out.push(`  ${r.provider}: ${r.aborted}`);
  out.push("", `Estimated spend this run: ${results.map((r) => `${r.provider} $${r.costUsd.toFixed(3)}`).join(", ")}; total $${spend.total.toFixed(3)}`);
  return out.join("\n");
}

function pageSummary(r: ProviderResult): string {
  const s = ttfaStats(r.records);
  return `Model ${r.model}. Speed ×${r.chosenSpeed ?? "?"} (closest to your cadence). First audio median ${fmtMs(s.median)}, p95 ${fmtMs(s.p95)} over ${s.n} requests (budget 200 ms).`;
}

function rebuildPage(cadence: Cadence): string {
  const entries = Object.fromEntries(PROVIDERS.map((p) => [p, readManifest(paths.samples, p)])) as Record<ProviderName, SampleEntry[]>;
  const summaries: Partial<Record<ProviderName, string>> = {};
  for (const p of PROVIDERS) {
    const path = join(paths.samples, p, "summary.txt");
    if (existsSync(path)) summaries[p] = readFileSync(path, "utf8").trim();
  }
  const html = buildPage(entries, { cadenceMedianWpm: cadence.medianWpm, cadenceP25: cadence.p25Wpm, cadenceP75: cadence.p75Wpm, summaries });
  const path = join(paths.samples, "index.html");
  writeFileSync(path, html);
  return path;
}

// ---------------------------------------------------------------------------------------------
// Main

function dryRun(opts: Options, script: ScriptLine[]): void {
  let total = 0;
  for (const provider of opts.providers) {
    const jobs = [...calibrationJobs(provider, opts, script), ...laterJobs(provider, opts, script, opts.speed ?? 1)];
    if (provider !== "openai") jobs.push(jobs[0] as Job);
    const chars = jobs.reduce((sum, j) => sum + j.line.readback.length, 0);
    const usd =
      provider === "openai" ? jobs.length * OPENAI_USD_PER_LINE_EST : chars * (provider === "elevenlabs" ? eleven.USD_PER_CHAR : cartesia.USD_PER_CHAR);
    total += usd;
    console.log(`${provider}: ${jobs.length} requests, ${chars} characters, est. $${usd.toFixed(3)}`);
  }
  console.log(`total est. $${total.toFixed(3)} (limit $${SPEND_LIMIT_USD})`);
}

async function main(): Promise<void> {
  const opts = parseOptions();
  const script = await loadScript();
  if (opts.dryRun) {
    dryRun(opts, script);
    return;
  }
  const cadence = await controllerCadence(script);
  if (opts.pageOnly) {
    console.log(`Rebuilt ${rebuildPage(cadence)}`);
    return;
  }
  loadEnvLocal();
  log(`Q's controller cadence: median ${Math.round(cadence.medianWpm)} wpm (p25 ${Math.round(cadence.p25Wpm)}, p75 ${Math.round(cadence.p75Wpm)}) over ${cadence.lines.length} recordings`);
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${opts.providers.join("+")}`;
  const ctx: RunContext = { runId, spend: new Spend(), sessions: undefined, samples: [] };
  const results: ProviderResult[] = [];
  let stopped: string | undefined;
  mkdirSync(paths.results, { recursive: true });
  mkdirSync(paths.samples, { recursive: true });
  for (const provider of opts.providers) {
    try {
      const r = await runProvider(provider, opts, script, cadence, ctx);
      results.push(r);
    } catch (err) {
      if (!(err instanceof SpendLimitError)) throw err;
      stopped = err.message;
      log(`\n${stopped}`);
      break;
    } finally {
      const mine = ctx.samples.filter((s) => s.provider === provider);
      if (mine.length > 0) mergeManifest(paths.samples, provider, mine, opts.full);
      const r = results.find((x) => x.provider === provider);
      if (r && r.records.some((x) => x.inStats && x.ok)) writeFileSync(join(paths.samples, provider, "summary.txt"), `${pageSummary(r)}\n`);
    }
  }
  const summary = summarize(results, cadence, ctx.spend) + (stopped ? `\n\nSTOPPED: ${stopped}` : "");
  console.log(`\n${summary}`);
  const page = rebuildPage(cadence);
  writeFileSync(join(paths.results, `${runId}-summary.txt`), `${summary}\n`);
  writeFileSync(
    join(paths.results, `${runId}.json`),
    `${JSON.stringify({ runId, options: opts, constants: { TIMING_LINES, CAL_LINES, SAMPLE_LINES, SPEEDS, OPENAI_EFFORT, instructions: openai.INSTRUCTIONS }, cadence, results }, null, 1)}\n`,
  );
  console.log(`\nSaved ${join(paths.results, runId)}.json and -summary.txt; samples page: ${page}`);
  if (stopped || results.some((r) => r.aborted || r.records.some((x) => !x.ok))) process.exitCode = 1;
}

await main();
