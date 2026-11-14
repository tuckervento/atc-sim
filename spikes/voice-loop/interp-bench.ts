/**
 * Phase 0, task 0.4: interpreter bake-off.
 *
 * Gives each model a transcript plus a fixed fake game context (interp/context.ts) and asks
 * for one command object matching src/sim/commands.ts. Two approaches per model:
 *   prompt  game context in the prompt, one request, answer as JSON
 *   tools   transcript only; the model looks flights and names up with tools (interp/tools.ts)
 * Inputs: perfect (script text), u36pro and nova3 (0.3's saved transcripts), perturbed
 * (hand-made mishearings). Each answer is shape-checked (interp/shape.ts) and scored against
 * the line's `expected` row in test-set/script.md (interp/score.ts).
 *
 * Run:   npm --prefix spikes/voice-loop run interp-bench -- [options]
 * Options:
 *   --model <id>          claude-haiku-5-5 or gpt-6-luna (or part of one: haiku, luna)
 *   --approach <a>        prompt or tools
 *   --input <a,b>         perfect, u36pro, nova3, perturbed (comma-separated)
 *   --lines 01,02         only these script lines
 *   --limit N             only the first N (selected) lines of each input
 *   --repeats N           samples per line (default 3)
 *   --rescore             no API calls: re-score saved results and print the tables
 *   --misses              also print every scored miss
 *   --resume              keep saved samples with the same config; run only missing ones
 *   --opt key=value       runner override (needs --out): answer=text|tool|format|terse
 *                         (Anthropic; default text), answer=format|terse (OpenAI; default
 *                         format), cache=explicit|implicit (OpenAI)
 *   --out DIR             write results here instead of results/interp
 *   --max-spend USD       stop before the spend ledger passes this (default 5)
 *
 * Keys come from .env.local (see check-keys.ts); they're never printed or saved.
 * Exit codes: 2 bad usage or failed self-check, 3 spend cap reached, 4 API error.
 */
import { mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadEnvLocal, describeError, SPIKE_DIR } from "./stt/env.ts";
import { loadScript } from "./stt/script.ts";
import { appendSpend, spendTotal } from "./stt/results.ts";
import { parseTerse } from "../../src/sim/terse.ts";
import type { Transmission } from "../../src/sim/commands.ts";
import { trackConnections } from "./interp/net.ts";
import { anthropicRunner } from "./interp/anthropic.ts";
import { openaiRunner, type CacheMode } from "./interp/openai.ts";
import { INPUTS, PERTURBED, loadInput, type InputName } from "./interp/inputs.ts";
import { checkShape } from "./interp/shape.ts";
import { scoreLine } from "./interp/score.ts";
import type { AnswerMode, Approach } from "./interp/prompt.ts";
import { costUsd, sumTokens, type Runner } from "./interp/types.ts";
import {
  LATENCY_BUDGET_MS, formatMisses, formatTables, judge, loadResultFile, resultPath, saveResultFile, summarize,
  type ResultFile, type Sample,
} from "./interp/results.ts";

const RESULTS_DIR = join(SPIKE_DIR, "results", "interp");
const LEDGER = join(RESULTS_DIR, "spend-log.jsonl");
const MODELS = ["claude-haiku-5-5", "gpt-6-luna"] as const;
const APPROACHES: Approach[] = ["prompt", "tools"];
/** Conservative cost of one sample (a tools sample can take 4 requests), for the spend check. */
const SAMPLE_USD_CEILING = 0.004;

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    approach: { type: "string" },
    input: { type: "string" },
    lines: { type: "string" },
    limit: { type: "string" },
    repeats: { type: "string", default: "3" },
    rescore: { type: "boolean", default: false },
    misses: { type: "boolean", default: false },
    resume: { type: "boolean", default: false },
    opt: { type: "string", multiple: true, default: [] },
    out: { type: "string" },
    "max-spend": { type: "string", default: "5" },
  },
  strict: true,
});

function fail(message: string, code = 2): never {
  console.error(`interp-bench: ${message}`);
  process.exit(code);
}

function positiveInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) fail(`--${name} must be a positive whole number, got "${raw}"`);
  return n;
}

const repeats = positiveInt("repeats", values.repeats);
const maxSpend = Number(values["max-spend"]);
if (!Number.isFinite(maxSpend) || maxSpend <= 0) fail(`--max-spend must be a positive number, got "${values["max-spend"]}"`);
const opts = new Map<string, string>();
for (const o of values.opt) {
  const eq = o.indexOf("=");
  if (eq <= 0) fail(`--opt must be key=value, got "${o}"`);
  opts.set(o.slice(0, eq), o.slice(eq + 1));
}
for (const k of opts.keys()) if (k !== "answer" && k !== "cache") fail(`unknown --opt "${k}" (known: answer, cache)`);
const answerOpt = opts.get("answer") ?? null;
if (answerOpt !== null && !["text", "tool", "format", "terse"].includes(answerOpt)) fail(`--opt answer must be text, tool, format or terse, got "${answerOpt}"`);
const cacheMode = (opts.get("cache") ?? "explicit") as CacheMode;
if (!["explicit", "implicit"].includes(cacheMode)) fail(`--opt cache must be explicit or implicit, got "${cacheMode}"`);
if (opts.size > 0 && !values.out) fail("--opt changes the runner config, so it needs --out DIR (keeps results/interp for the standard config)");
const outDir = values.out ? resolve(values.out) : RESULTS_DIR;

// ---- selection -----------------------------------------------------------------------------

const models = MODELS.filter((m) => !values.model || m.includes(values.model));
if (models.length === 0) fail(`--model: no match for "${values.model}"; known: ${MODELS.join(", ")}`);
const approaches = APPROACHES.filter((a) => !values.approach || a === values.approach);
if (approaches.length === 0) fail(`--approach must be prompt or tools, got "${values.approach}"`);
const inputs: InputName[] = values.input ? values.input.split(",").map((s) => s.trim()) as InputName[] : [...INPUTS];
for (const i of inputs) if (!INPUTS.includes(i)) fail(`--input: unknown "${i}"; known: ${INPUTS.join(", ")}`);

loadEnvLocal();
trackConnections();
const script = await loadScript();
const expected = new Map<string, Transmission | null>();
for (const line of script) {
  if (line.expected.startsWith("UNSCORED")) {
    expected.set(line.num, null);
    continue;
  }
  const r = parseTerse(line.expected);
  if (!r.ok) fail(`script.md line ${line.num}: expected '${line.expected}' doesn't parse: ${r.error.message}`);
  if (r.command.type !== "transmission") fail(`script.md line ${line.num}: expected must be a radio transmission, got ${r.command.type}`);
  expected.set(line.num, r.command);
}
selfCheck();

let wantedLines: string[] | null = null;
if (values.lines) {
  wantedLines = values.lines.split(",").map((s) => s.trim().padStart(2, "0"));
  const unknown = wantedLines.filter((n) => !script.some((l) => l.num === n));
  if (unknown.length) fail(`--lines: not in script.md: ${unknown.join(", ")}`);
}
const limit = values.limit ? positiveInt("limit", values.limit) : null;

/** Every expected command must pass the shape check and score as an exact match against itself. */
function selfCheck(): void {
  const problems: string[] = [];
  for (const [num, cmd] of expected) {
    if (cmd === null) continue;
    const shape = checkShape(JSON.parse(JSON.stringify(cmd)));
    if (!shape.ok) { problems.push(`${num}: expected fails the shape check: ${shape.reason}`); continue; }
    const s = scoreLine(cmd, shape.command);
    if (!s.exact || Object.values(s.fields).some((v) => v === false)) problems.push(`${num}: expected doesn't score as exact against itself`);
  }
  for (const p of PERTURBED) if (expected.get(p.num) === undefined) problems.push(`perturbed line ${p.num} isn't in script.md`);
  if (problems.length) fail(`self-check failed:\n  - ${problems.join("\n  - ")}`);
}

const method = {
  latency: "performance.now() from just before each request to the parsed response (non-streaming); a tools sample sums every request plus local tool time",
  connections: "Node fetch (undici) keep-alive; new connections counted from the undici:client:connected diagnostics channel. Samples where any request opened a connection are 'cold' and left out of the latency stats",
  warmup: "one unscored request (line 01, perfect text) per runner and input before the samples, to open the connection, compile any schema grammar and write the prompt cache",
  order: "for each repeat, every selected line in script order; requests one at a time",
  repeats,
  budgetMs: LATENCY_BUDGET_MS,
  p95: "nearest rank (ceil(0.95 n)-th smallest)",
  scoring: "interp/score.ts: exact match after folding hold-shorts that follow a taxi into it; per-field over lines where either side has the field",
  shape: "interp/shape.ts: exact keys and formats per src/sim/commands.ts, plus a terse round trip through parseTerse",
  cost: "USD from each request's measured usage at the runner's pricing; $/hr = 450 x mean per transmission",
};

// ---- rescore -------------------------------------------------------------------------------

if (values.rescore) {
  mkdirSync(outDir, { recursive: true });
  const files = readdirSync(outDir).filter((f) => f.endsWith(".json")).sort();
  const rows: ResultFile[] = [];
  for (const name of files) {
    const file = loadResultFile(join(outDir, name));
    if (!file || !Array.isArray(file.samples)) continue;
    if (!models.includes(file.model as (typeof MODELS)[number]) || !approaches.includes(file.approach as Approach) || !inputs.includes(file.input)) continue;
    for (const s of file.samples) {
      const line = script.find((l) => l.num === s.num);
      if (!line) fail(`${name}: saved line ${s.num} isn't in script.md`);
      s.expected = line.expected;
      Object.assign(s, judge(expected.get(s.num) ?? null, s.result));
    }
    file.summary = summarize(file.samples, file.pricing);
    file.updatedAt = new Date().toISOString();
    saveResultFile(join(outDir, name), file);
    rows.push(file);
  }
  if (!rows.length) fail(`no saved results match in ${outDir}`);
  printAll(rows);
  process.exit(0);
}

// ---- run -----------------------------------------------------------------------------------

mkdirSync(outDir, { recursive: true });
const rows: ResultFile[] = [];
for (const model of models) {
  for (const approach of approaches) {
    let runner: Runner;
    try {
      if (model === "claude-haiku-5-5") {
        runner = anthropicRunner(approach, (answerOpt ?? "text") as AnswerMode);
      } else {
        const a = answerOpt ?? "format";
        if (a !== "format" && a !== "terse") fail(`gpt-6-luna takes --opt answer=format or terse, got "${a}" (use --model haiku)`);
        runner = openaiRunner(approach, cacheMode, a);
      }
    } catch (err) {
      fail(`${model}: ${describeError(err)}`);
    }
    for (const input of inputs) rows.push(await runInput(runner, input));
  }
}
printAll(rows);

async function runInput(runner: Runner, input: InputName): Promise<ResultFile> {
  const transcripts = loadInput(input, script);
  let lines = [...transcripts.keys()].sort();
  if (wantedLines) lines = lines.filter((n) => wantedLines!.includes(n));
  if (limit !== null) lines = lines.slice(0, limit);
  const path = resultPath(outDir, runner, input);
  let file = loadResultFile(path);
  const fullRun = lines.length === transcripts.size;
  if (file && JSON.stringify(file.config) !== JSON.stringify(runner.config)) {
    if (!fullRun || values.resume) fail(`${runner.id} ${input}: saved results used a different config; re-run every line of the input, or use --out`);
    file = null;
  }
  file ??= {
    runner: runner.id, provider: runner.provider, model: runner.model, approach: runner.approach, input,
    pricing: runner.pricing, config: runner.config, method, updatedAt: new Date().toISOString(),
    warmups: [], samples: [], summary: summarize([], runner.pricing),
  };
  const current: ResultFile = file;
  const done = new Set(values.resume ? current.samples.map((s) => `${s.num}#${s.repeat}`) : []);
  if (!values.resume) current.samples = current.samples.filter((s) => !lines.includes(s.num));
  const todo = lines.length * repeats - [...done].filter((k) => lines.includes(k.split("#")[0]!) && Number(k.split("#")[1]) <= repeats).length;
  console.log(`\n${runner.id} × ${input}: ${lines.length} lines × ${repeats} repeats (${todo} to run)`);
  if (todo === 0) return finish(current, path);

  checkSpend(runner, "warm-up");
  const warm = await runner.run("01", script.find((l) => l.num === "01")!.say);
  recordSpend(runner, input, warm.calls.map((c) => c.tokens), "warmup");
  current.warmups.push({ runAt: new Date().toISOString(), num: "01", result: warm });
  if (warm.error?.startsWith("API error")) stopOnApiError(runner, input, current, path, warm.error);
  console.log(`  warm-up ${Math.round(warm.totalMs)} ms, ${warm.calls.length} request(s), new connection: ${warm.calls.some((c) => c.newConnection)}`);

  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const num of lines) {
      if (done.has(`${num}#${repeat}`)) continue;
      checkSpend(runner, `${num}#${repeat}`, current, path);
      const transcript = transcripts.get(num)!;
      const result = await runner.run(num, transcript);
      recordSpend(runner, input, result.calls.map((c) => c.tokens), `${num}#${repeat}`);
      if (result.error?.startsWith("API error")) stopOnApiError(runner, input, current, path, result.error);
      const sample: Sample = {
        num, repeat, transcript, expected: script.find((l) => l.num === num)!.expected,
        runAt: new Date().toISOString(), result, ...judge(expected.get(num) ?? null, result),
      };
      current.samples = current.samples.filter((s) => !(s.num === num && s.repeat === repeat));
      current.samples.push(sample);
      current.summary = summarize(current.samples, current.pricing);
      current.updatedAt = new Date().toISOString();
      saveResultFile(path, current);
      printProgress(sample);
    }
  }
  return finish(current, path);
}

function finish(file: ResultFile, path: string): ResultFile {
  file.summary = summarize(file.samples, file.pricing);
  file.updatedAt = new Date().toISOString();
  saveResultFile(path, file);
  return file;
}

function checkSpend(runner: Runner, what: string, file?: ResultFile, path?: string): void {
  const spent = spendTotal(LEDGER);
  if (spent + SAMPLE_USD_CEILING > maxSpend) {
    if (file && path) finish(file, path);
    fail(`stopping before ${runner.id} ${what}: spend so far $${spent.toFixed(4)} + up to $${SAMPLE_USD_CEILING} would pass --max-spend $${maxSpend}`, 3);
  }
}

function recordSpend(runner: Runner, input: InputName, tokens: Parameters<typeof sumTokens>[0], what: string): void {
  const usd = costUsd(sumTokens(tokens), runner.pricing);
  appendSpend(LEDGER, { at: new Date().toISOString(), candidate: `${runner.id}.${input} ${what}`, lines: 1, billedMin: 0, estUsd: usd });
}

function stopOnApiError(runner: Runner, input: InputName, file: ResultFile, path: string, error: string): never {
  finish(file, path);
  fail(`${runner.id} ${input}: ${error}\n  Saved samples are kept; re-run with --resume to continue.`, 4);
}

function printProgress(s: Sample): void {
  const rt = s.result.calls.length;
  const cold = s.result.calls.some((c) => c.newConnection) ? " cold" : "";
  const mark = s.score === null ? "·" : s.score.exact ? "✓" : s.score.valid ? "✗" : "!";
  const what = s.answerTerse ?? `INVALID ${s.invalidReason}`;
  console.log(`  ${s.num}#${s.repeat} ${String(Math.round(s.result.totalMs)).padStart(5)} ms rt=${rt}${cold} ${mark} ${what.slice(0, 90)}${s.score && !s.score.exact ? `   (expected ${s.expected})` : ""}`);
}

function printAll(list: ResultFile[]): void {
  const order = (f: ResultFile) => `${f.model}|${APPROACHES.indexOf(f.approach as Approach)}|${INPUTS.indexOf(f.input)}`;
  const sorted = [...list].sort((a, b) => order(a).localeCompare(order(b)));
  console.log(`\nResults (${outDir}):\n`);
  console.log(formatTables(sorted));
  if (values.misses) console.log(formatMisses(sorted));
  console.log(`\nEstimated spend so far (all runs, results/interp/spend-log.jsonl): $${spendTotal(LEDGER).toFixed(4)}`);
}
