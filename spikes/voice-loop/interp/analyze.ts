/**
 * Extra analysis over saved results (no API calls), for the 0.4 write-up:
 * - warm request latency against output tokens: least-squares fit ms = a + b * tokens,
 *   per runner, to see how much of the latency is generation
 * - approach B: what the model looked up, and how often it skipped the lookups
 * - format vs content: for answers that weren't pure JSON, would the first JSON object in
 *   the text have scored? (Not used in the main scoring, which is strict.)
 * Run: node interp/analyze.ts [results dir]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SPIKE_DIR } from "../stt/env.ts";
import { parseTerse } from "../../../src/sim/terse.ts";
import type { Transmission } from "../../../src/sim/commands.ts";
import type { ResultFile } from "./results.ts";
import { checkShape } from "./shape.ts";
import { scoreLine } from "./score.ts";

const dir = resolve(process.argv[2] ?? join(SPIKE_DIR, "results", "interp"));
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as ResultFile);

function fit(xs: number[], ys: number[]): { a: number; b: number; r: number } {
  const n = xs.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  const b = sxx === 0 ? 0 : sxy / sxx;
  return { a: my - b * mx, b, r: sxx === 0 || syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy) };
}

const byRunner = new Map<string, ResultFile[]>();
for (const f of files) byRunner.set(f.runner, [...(byRunner.get(f.runner) ?? []), f]);

console.log("Warm requests: ms = a + b × output tokens (least squares), and the same against uncached input tokens\n");
console.log("| Runner | Requests | Median output tokens | a (ms) | b (ms per output token) | r | b (ms per 1K uncached input tokens) | r |");
console.log("|---|---|---|---|---|---|---|---|");
for (const [runner, list] of byRunner) {
  const calls = list.flatMap((f) => f.samples.flatMap((s) => s.result.calls)).filter((c) => !c.newConnection && c.error === null);
  const out = calls.map((c) => c.tokens.output);
  const inp = calls.map((c) => c.tokens.uncached / 1000);
  const ms = calls.map((c) => c.ms);
  const f1 = fit(out, ms);
  const f2 = fit(inp, ms);
  const sorted = [...out].sort((a, b) => a - b);
  console.log(`| ${runner} | ${calls.length} | ${sorted[Math.floor(sorted.length / 2)]} | ${Math.round(f1.a)} | ${f1.b.toFixed(2)} | ${f1.r.toFixed(2)} | ${Math.round(f2.b)} | ${f2.r.toFixed(2)} |`);
}

console.log("\nApproach B lookups (all inputs): samples by tools called before answering\n");
for (const [runner, list] of byRunner) {
  if (!runner.includes(".tools")) continue;
  const samples = list.flatMap((f) => f.samples);
  const kinds = new Map<string, number>();
  for (const s of samples) {
    const k = s.result.toolTrace.map((t) => t.name).join("+") || "(none)";
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  console.log(`${runner} (${samples.length} samples): ${[...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join("; ")}`);
}

/** The first balanced {...} in the text, respecting strings. null if none. */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

console.log("\nAnswers that weren't pure JSON: would the first JSON object in the text pass? (strict scoring counts them all as invalid)\n");
console.log("| Runner | Input | Not pure JSON | First object passes the shape check | ...and is an exact match |");
console.log("|---|---|---|---|---|");
for (const f of files) {
  const bad = f.samples.filter((s) => s.score !== null && s.result.error?.startsWith("answer isn't JSON"));
  if (!bad.length) continue;
  let shapeOk = 0;
  let exact = 0;
  for (const s of bad) {
    const obj = s.result.rawText ? firstJsonObject(s.result.rawText) : null;
    if (!obj) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(obj); } catch { continue; }
    const shape = checkShape(parsed);
    if (!shape.ok) continue;
    shapeOk++;
    const exp = parseTerse(s.expected);
    if (exp.ok && scoreLine(exp.command as Transmission, shape.command).exact) exact++;
  }
  console.log(`| ${f.runner} | ${f.input} | ${bad.length} | ${shapeOk} | ${exact} |`);
}
