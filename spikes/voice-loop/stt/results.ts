/**
 * Per-candidate result files (results/stt/<candidate>.json), scoring and the summary table.
 * A run for a subset of lines (--lines, --limit) replaces only those entries in the file,
 * so slices can be re-run cheaply; the summary is recomputed over every entry.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { normalize, wer, type WerCounts } from "./normalize.ts";
import { CATEGORIES, scoreCritical, type Category, type CriticalScore, type CriticalSpec } from "./critical.ts";
import { peakCost, type Candidate, type PeakCost } from "./candidates.ts";
import type { ClipRun } from "./types.ts";
import type { ScriptLine } from "./script.ts";

export interface LineScore {
  refTokens: string[];
  hypTokens: string[];
  wer: WerCounts;
  critical: CriticalScore;
  allCriticalCorrect: boolean;
}

export interface LineEntry extends ClipRun {
  num: string;
  say: string;
  style: string;
  audioSec: number;
  runAt: string;
  score: LineScore | null;
}

export interface Summary {
  lines: number;
  withFinal: number;
  errors: string[];
  /** Lines where transcript text arrived after the final (the final was incomplete). */
  lateText: string[];
  latencyMs: { median: number | null; p95: number | null; min: number | null; max: number | null; withinBudget: number };
  firstTextMs: { median: number | null };
  wer: number | null;
  critical: { overall: number | null } & Record<Category, number | null>;
  criticalCounts: Record<Category, { expected: number; found: number }>;
  linesAllCriticalCorrect: number;
  audioSec: number;
  billedSessionSec: number | null;
  peakCostPerHr: PeakCost;
}

export interface ResultFile {
  candidate: string;
  provider: string;
  model: string;
  pricing: Candidate["pricing"];
  config: Record<string, unknown>;
  method: Record<string, unknown>;
  updatedAt: string;
  summary: Summary;
  lines: LineEntry[];
}

export const LATENCY_BUDGET_MS = 300;

export function scoreLine(line: ScriptLine, transcript: string | null, spec: CriticalSpec, inventory: string[][]): LineScore | null {
  if (transcript === null) return null;
  const refTokens = normalize(line.say);
  const hypTokens = normalize(transcript);
  const critical = scoreCritical(spec, transcript, inventory);
  return {
    refTokens,
    hypTokens,
    wer: wer(refTokens, hypTokens),
    critical,
    allCriticalCorrect: CATEGORIES.every((c) => critical[c].found === critical[c].expected),
  };
}

/** Nearest-rank percentile: the ceil(p*n)-th smallest value. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

export function summarize(candidate: Candidate, lines: LineEntry[], specs: Map<string, CriticalSpec>): Summary {
  const latencies = lines.map((l) => l.latencyMs).filter((v): v is number => v !== null);
  const firstTexts = lines.map((l) => l.timings.firstTextMs).filter((v): v is number => v !== null);
  // WER and critical tokens count a line with no transcript as all-deleted / all-missed.
  let refWords = 0;
  let edits = 0;
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, { expected: 0, found: 0 }])) as Record<Category, { expected: number; found: number }>;
  let allCorrect = 0;
  for (const l of lines) {
    const spec = specs.get(l.num);
    if (l.score) {
      refWords += l.score.wer.refWords;
      edits += l.score.wer.substitutions + l.score.wer.deletions + l.score.wer.insertions;
      for (const c of CATEGORIES) {
        counts[c].expected += l.score.critical[c].expected;
        counts[c].found += l.score.critical[c].found;
      }
      if (l.score.allCriticalCorrect) allCorrect++;
    } else {
      const ref = normalize(l.say).length;
      refWords += ref;
      edits += ref;
      if (spec) {
        counts.callsign.expected += spec.callsign === null ? 0 : 1;
        counts.runways.expected += spec.runways.length;
        counts.taxiways.expected += spec.taxiways.length;
        counts.holdShort.expected += spec.holdShort.length;
      }
    }
  }
  const rate = (c: { expected: number; found: number }) => (c.expected === 0 ? null : c.found / c.expected);
  const totalExpected = CATEGORIES.reduce((n, c) => n + counts[c].expected, 0);
  const totalFound = CATEGORIES.reduce((n, c) => n + counts[c].found, 0);
  const audioSec = lines.reduce((n, l) => n + l.audioSec, 0);
  const billed = lines.map((l) => l.timings.billedSessionSec);
  const billedSessionSec = candidate.pricing.basis === "session" && billed.every((b) => b !== null)
    ? (billed as number[]).reduce((a, b) => a + b, 0)
    : null;
  return {
    lines: lines.length,
    withFinal: latencies.length,
    errors: lines.filter((l) => l.error).map((l) => `${l.num}: ${l.error}`),
    lateText: lines.filter((l) => l.lateText).map((l) => `${l.num}: ${l.lateText}`),
    latencyMs: {
      median: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      min: latencies.length ? Math.min(...latencies) : null,
      max: latencies.length ? Math.max(...latencies) : null,
      withinBudget: latencies.filter((v) => v <= LATENCY_BUDGET_MS).length,
    },
    firstTextMs: { median: percentile(firstTexts, 0.5) },
    wer: refWords === 0 ? null : edits / refWords,
    critical: {
      overall: totalExpected === 0 ? null : totalFound / totalExpected,
      callsign: rate(counts.callsign),
      runways: rate(counts.runways),
      taxiways: rate(counts.taxiways),
      holdShort: rate(counts.holdShort),
    },
    criticalCounts: counts,
    linesAllCriticalCorrect: allCorrect,
    audioSec,
    billedSessionSec,
    peakCostPerHr: peakCost(candidate.pricing, billedSessionSec !== null && audioSec > 0 ? billedSessionSec / audioSec : null),
  };
}

export function resultPath(dir: string, candidate: Candidate): string {
  return join(dir, `${candidate.id}.json`);
}

export function loadResult(dir: string, candidate: Candidate): ResultFile | null {
  const path = resultPath(dir, candidate);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as ResultFile;
}

export function saveResult(dir: string, file: ResultFile): void {
  file.lines.sort((a, b) => a.num.localeCompare(b.num));
  writeFileSync(join(dir, `${file.candidate}.json`), `${JSON.stringify(file, null, 2)}\n`);
}

// ---- spend ledger -----------------------------------------------------------------------

export interface SpendEntry {
  at: string;
  candidate: string;
  lines: number;
  billedMin: number;
  estUsd: number;
}

/** Estimated cost of one clip: audio basis bills the audio, session basis the session. */
export function clipCost(candidate: Candidate, audioSec: number, billedSessionSec: number | null): { billedMin: number; usd: number } {
  const p = candidate.pricing;
  const billedSec = p.basis === "session" ? (billedSessionSec ?? audioSec) : audioSec;
  // Spend tracking uses the list rate where there is one, to stay conservative.
  const perMin = p.listPerMin ?? p.perMin;
  return { billedMin: billedSec / 60, usd: (billedSec / 60) * perMin };
}

export function spendTotal(ledgerPath: string): number {
  if (!existsSync(ledgerPath)) return 0;
  return readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .reduce((sum, l) => sum + (JSON.parse(l) as SpendEntry).estUsd, 0);
}

export function appendSpend(ledgerPath: string, entry: SpendEntry): void {
  appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`);
}

// ---- table ------------------------------------------------------------------------------

const ms = (v: number | null) => (v === null ? "—" : `${Math.round(v)} ms`);
const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
const usd = (v: number | null) => (v === null ? "—" : `$${v.toFixed(2)}`);

function costCell(c: Candidate, s: Summary): string {
  const pc = s.peakCostPerHr;
  if (c.pricing.basis === "audio") return pc.high === null ? usd(pc.low) : `${usd(pc.low)} promo / ${usd(pc.high)} list`;
  const measured = pc.measured === null ? "" : ` (measured sessions: ${usd(pc.measured)})`;
  return `${usd(pc.low)}–${usd(pc.high)}${measured}`;
}

export function formatTables(rows: Array<{ candidate: Candidate; summary: Summary }>): string {
  const out: string[] = [];
  out.push(
    "| Candidate | Lines with final | Latency median | Latency p95 | ≤ 300 ms | WER | Critical tokens | Lines all critical right | $/hr at peak |",
    "|---|---|---|---|---|---|---|---|---|",
  );
  for (const { candidate: c, summary: s } of rows) {
    out.push(
      `| ${c.id} | ${s.withFinal}/${s.lines} | ${ms(s.latencyMs.median)} | ${ms(s.latencyMs.p95)} | ${s.latencyMs.withinBudget}/${s.withFinal} | ${pct(s.wer)} | ${pct(s.critical.overall)} | ${s.linesAllCriticalCorrect}/${s.lines} | ${costCell(c, s)} |`,
    );
  }
  out.push("", "| Candidate | Callsign | Runway | Taxiway | Hold-short target | First partial text (median, from audio start) |", "|---|---|---|---|---|---|");
  for (const { candidate: c, summary: s } of rows) {
    const cell = (cat: Category) => `${pct(s.critical[cat])} (${s.criticalCounts[cat].found}/${s.criticalCounts[cat].expected})`;
    out.push(`| ${c.id} | ${cell("callsign")} | ${cell("runways")} | ${cell("taxiways")} | ${cell("holdShort")} | ${ms(s.firstTextMs.median)} |`);
  }
  return out.join("\n");
}
