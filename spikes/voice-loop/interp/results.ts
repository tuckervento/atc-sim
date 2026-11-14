/**
 * Result files (results/interp/<runner>.<input>.json), the summary, and the printed tables.
 * Every sample keeps the full InterpResult: each request's timing, connection reuse, raw
 * usage, tool calls and the answer text, so --rescore can re-score without API calls.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { percentile } from "../stt/results.ts";
import type { Transmission } from "../../../src/sim/commands.ts";
import { checkShape } from "./shape.ts";
import {
  FIELDS, FIELD_LABELS, OTHER_FIELDS, scoreLine, type Field, type LineScore, type OtherField,
} from "./score.ts";
import { INPUT_LABELS, type InputName } from "./inputs.ts";
import { costUsd, sumTokens, type InterpResult, type Pricing, type Runner, type Tokens } from "./types.ts";

export const LATENCY_BUDGET_MS = 400;
export const PEAK_CALLS_PER_HR = 450;

export interface Sample {
  num: string;
  repeat: number;
  transcript: string;
  expected: string;
  runAt: string;
  result: InterpResult;
  /** The answer in terse syntax, when it passed the shape check. */
  answerTerse: string | null;
  /** Why the answer is invalid (no answer, bad JSON, or the shape check). null: valid. */
  invalidReason: string | null;
  /** null for unscored lines (34). */
  score: LineScore | null;
}

export interface Warmup {
  runAt: string;
  num: string;
  result: InterpResult;
}

interface Ratio { correct: number; applicable: number }

export interface Summary {
  samples: number;
  scored: number;
  valid: number;
  exact: number;
  exactRaw: number;
  normalizationChanged: number;
  normalizationChangedResult: number;
  linesScored: number;
  linesExactEveryRepeat: number;
  fields: Record<Field, Ratio>;
  other: Record<OtherField, Ratio>;
  latency: { warm: number; median: number | null; p95: number | null; min: number | null; max: number | null; withinBudget: number; cold: number; coldMedian: number | null };
  perRequest: { warm: number; median: number | null; p95: number | null };
  roundTrips: { mean: number | null; dist: Record<string, number> };
  meanTokens: Tokens;
  maxCacheRead: number;
  usdPerTransmission: number | null;
  usdPerHr: number | null;
  usdPerHrUncached: number | null;
  invalidReasons: Record<string, number>;
}

export interface ResultFile {
  runner: string;
  provider: string;
  model: string;
  approach: string;
  input: InputName;
  pricing: Pricing;
  config: Record<string, unknown>;
  method: Record<string, unknown>;
  updatedAt: string;
  warmups: Warmup[];
  samples: Sample[];
  summary: Summary;
}

/** Shape-check and score one sample from its saved result. */
export function judge(expected: Transmission | null, result: InterpResult): Pick<Sample, "answerTerse" | "invalidReason" | "score"> {
  let answer: Transmission | null = null;
  let answerTerse: string | null = null;
  let invalidReason: string | null = result.error;
  if (result.error === null) {
    const shape = checkShape(result.parsed);
    if (shape.ok) {
      answer = shape.command;
      answerTerse = shape.terse;
    } else {
      invalidReason = `shape: ${shape.reason}`;
    }
  }
  return { answerTerse, invalidReason, score: expected === null ? null : scoreLine(expected, answer) };
}

const isWarm = (s: Sample) => s.result.calls.every((c) => !c.newConnection);

/** Group invalid reasons by their first words, so the table stays short. */
function reasonKey(reason: string): string {
  return reason.replace(/\[\d+\]/g, "[i]").replace(/, got .*$/, "").slice(0, 120);
}

export function summarize(samples: Sample[], pricing: Pricing): Summary {
  const scored = samples.filter((s) => s.score !== null);
  const ratio = (): Ratio => ({ correct: 0, applicable: 0 });
  const fields = Object.fromEntries(FIELDS.map((f) => [f, ratio()])) as Record<Field, Ratio>;
  const other = Object.fromEntries(OTHER_FIELDS.map((f) => [f, ratio()])) as Record<OtherField, Ratio>;
  for (const s of scored) {
    for (const f of FIELDS) {
      const v = s.score!.fields[f];
      if (v !== null) { fields[f].applicable++; if (v) fields[f].correct++; }
    }
    for (const f of OTHER_FIELDS) {
      const v = s.score!.other[f];
      if (v !== null) { other[f].applicable++; if (v) other[f].correct++; }
    }
  }
  const byLine = new Map<string, Sample[]>();
  for (const s of scored) byLine.set(s.num, [...(byLine.get(s.num) ?? []), s]);
  const warm = samples.filter(isWarm);
  const cold = samples.filter((s) => !isWarm(s));
  const warmMs = warm.map((s) => s.result.totalMs);
  const warmRequests = samples.flatMap((s) => s.result.calls.filter((c) => !c.newConnection).map((c) => c.ms));
  const dist: Record<string, number> = {};
  for (const s of samples) dist[String(s.result.calls.length)] = (dist[String(s.result.calls.length)] ?? 0) + 1;
  const perSample = samples.map((s) => sumTokens(s.result.calls.map((c) => c.tokens)));
  const n = samples.length;
  const mean = (f: (t: Tokens) => number) => (n === 0 ? 0 : perSample.reduce((a, t) => a + f(t), 0) / n);
  const meanTokens: Tokens = { uncached: mean((t) => t.uncached), cacheRead: mean((t) => t.cacheRead), cacheWrite: mean((t) => t.cacheWrite), output: mean((t) => t.output) };
  const usd = n === 0 ? null : perSample.reduce((a, t) => a + costUsd(t, pricing), 0) / n;
  const usdUncached = n === 0 ? null : perSample.reduce((a, t) => a + costUsd({ uncached: t.uncached + t.cacheRead + t.cacheWrite, cacheRead: 0, cacheWrite: 0, output: t.output }, pricing), 0) / n;
  const invalidReasons: Record<string, number> = {};
  for (const s of samples) if (s.invalidReason) invalidReasons[reasonKey(s.invalidReason)] = (invalidReasons[reasonKey(s.invalidReason)] ?? 0) + 1;
  return {
    samples: n,
    scored: scored.length,
    valid: scored.filter((s) => s.score!.valid).length,
    exact: scored.filter((s) => s.score!.exact).length,
    exactRaw: scored.filter((s) => s.score!.exactRaw).length,
    normalizationChanged: scored.filter((s) => s.score!.normalizationChanged).length,
    normalizationChangedResult: scored.filter((s) => s.score!.exact && !s.score!.exactRaw).length,
    linesScored: byLine.size,
    linesExactEveryRepeat: [...byLine.values()].filter((list) => list.every((s) => s.score!.exact)).length,
    fields,
    other,
    latency: {
      warm: warm.length,
      median: percentile(warmMs, 0.5),
      p95: percentile(warmMs, 0.95),
      min: warmMs.length ? Math.min(...warmMs) : null,
      max: warmMs.length ? Math.max(...warmMs) : null,
      withinBudget: warmMs.filter((v) => v <= LATENCY_BUDGET_MS).length,
      cold: cold.length,
      coldMedian: percentile(cold.map((s) => s.result.totalMs), 0.5),
    },
    perRequest: { warm: warmRequests.length, median: percentile(warmRequests, 0.5), p95: percentile(warmRequests, 0.95) },
    roundTrips: { mean: n === 0 ? null : samples.reduce((a, s) => a + s.result.calls.length, 0) / n, dist },
    meanTokens,
    maxCacheRead: Math.max(0, ...samples.flatMap((s) => s.result.calls.map((c) => c.tokens.cacheRead))),
    usdPerTransmission: usd,
    usdPerHr: usd === null ? null : usd * PEAK_CALLS_PER_HR,
    usdPerHrUncached: usdUncached === null ? null : usdUncached * PEAK_CALLS_PER_HR,
    invalidReasons,
  };
}

export function resultPath(dir: string, runner: Runner, input: InputName): string {
  return join(dir, `${runner.id}.${input}.json`);
}

export function loadResultFile(path: string): ResultFile | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as ResultFile;
}

export function saveResultFile(path: string, file: ResultFile): void {
  file.samples.sort((a, b) => a.num.localeCompare(b.num) || a.repeat - b.repeat);
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

// ---- tables ------------------------------------------------------------------------------

const ms = (v: number | null) => (v === null ? "—" : `${Math.round(v)} ms`);
const pct = (num: number, den: number) => (den === 0 ? "—" : `${((num / den) * 100).toFixed(1)}%`);
const ratioCell = (r: Ratio) => (r.applicable === 0 ? "—" : `${pct(r.correct, r.applicable)} (${r.correct}/${r.applicable})`);
const usd = (v: number | null) => (v === null ? "—" : `$${v.toFixed(3)}`);

export interface Row {
  file: ResultFile;
}

function label(f: ResultFile): string {
  return `| ${f.model} | ${f.approach} | ${INPUT_LABELS[f.input]} |`;
}

export function formatTables(rows: ResultFile[]): string {
  const out: string[] = [];
  out.push(
    `Latency: warm samples only (every request on a reused keep-alive connection); budget ${LATENCY_BUDGET_MS} ms. $/hr: ${PEAK_CALLS_PER_HR} transmissions/hr × measured mean cost.`,
    "",
    "| Model | Approach | Input | Samples | Valid | Exact match | Lines exact every repeat | Median | p95 | ≤ 400 ms | Round trips (mean) | Cache-read tokens / request | $/hr measured | $/hr uncached |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const f of rows) {
    const s = f.summary;
    const requests = f.samples.reduce((a, x) => a + x.result.calls.length, 0);
    const readPerReq = requests === 0 ? 0 : (s.meanTokens.cacheRead * s.samples) / requests;
    out.push(
      `${label(f)} ${s.scored} | ${pct(s.valid, s.scored)} | ${pct(s.exact, s.scored)} (${s.exact}/${s.scored}) | ${s.linesExactEveryRepeat}/${s.linesScored} | ${ms(s.latency.median)} | ${ms(s.latency.p95)} | ${s.latency.withinBudget}/${s.latency.warm} | ${s.roundTrips.mean === null ? "—" : s.roundTrips.mean.toFixed(2)} | ${Math.round(readPerReq)} | ${usd(s.usdPerHr)} | ${usd(s.usdPerHrUncached)} |`,
    );
  }
  out.push("", `Per-field accuracy: correct / lines where the expected or the model's command has the field. An invalid answer counts as wrong on every expected field.`, "");
  out.push(`| Model | Approach | Input | ${FIELDS.map((f) => FIELD_LABELS[f]).join(" | ")} |`, `|---|---|---|${FIELDS.map(() => "---|").join("")}`);
  for (const f of rows) out.push(`${label(f)} ${FIELDS.map((k) => ratioCell(f.summary.fields[k])).join(" | ")} |`);
  out.push("", "Other values, in detail:", "");
  out.push(`| Model | Approach | Input | ${OTHER_FIELDS.map((f) => FIELD_LABELS[f]).join(" | ")} |`, `|---|---|---|${OTHER_FIELDS.map(() => "---|").join("")}`);
  for (const f of rows) out.push(`${label(f)} ${OTHER_FIELDS.map((k) => ratioCell(f.summary.other[k])).join(" | ")} |`);
  out.push("", "Latency detail, cold connections, tokens and normalization:", "");
  out.push(
    "| Model | Approach | Input | Request median (warm) | Request p95 (warm) | Cold samples (median) | Round trips | Mean tokens: uncached / cache read / cache write / output | Hold-short fold changed answer (changed result) |",
    "|---|---|---|---|---|---|---|---|---|",
  );
  for (const f of rows) {
    const s = f.summary;
    const dist = Object.entries(s.roundTrips.dist).sort().map(([k, v]) => `${k}:${v}`).join(" ");
    const t = s.meanTokens;
    out.push(`${label(f)} ${ms(s.perRequest.median)} | ${ms(s.perRequest.p95)} | ${s.latency.cold} (${ms(s.latency.coldMedian)}) | ${dist} | ${Math.round(t.uncached)} / ${Math.round(t.cacheRead)} / ${Math.round(t.cacheWrite)} / ${Math.round(t.output)} | ${s.normalizationChanged} (${s.normalizationChangedResult}) |`);
  }
  const invalid = rows.filter((f) => Object.keys(f.summary.invalidReasons).length > 0);
  if (invalid.length) {
    out.push("", "Invalid answers:");
    for (const f of invalid) {
      for (const [reason, count] of Object.entries(f.summary.invalidReasons)) out.push(`- ${f.runner} ${f.input}: ${count} × ${reason}`);
    }
  }
  return out.join("\n");
}

/** Every scored miss: line, repeat, expected and what the model gave. */
export function formatMisses(rows: ResultFile[]): string {
  const out: string[] = [];
  for (const f of rows) {
    const misses = f.samples.filter((s) => s.score !== null && !s.score.exact);
    if (!misses.length) continue;
    out.push(`\n${f.runner} ${f.input} (${misses.length} misses):`);
    for (const s of misses) {
      const wrong = Object.entries(s.score!.fields).filter(([, v]) => v === false).map(([k]) => k).join(",");
      out.push(`  ${s.num}#${s.repeat} expected ${s.expected} | got ${s.answerTerse ?? `INVALID ${s.invalidReason}`} | wrong: ${wrong} | heard: ${JSON.stringify(s.transcript).slice(0, 100)}`);
    }
  }
  return out.join("\n");
}
