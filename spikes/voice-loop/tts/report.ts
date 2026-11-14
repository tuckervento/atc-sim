/**
 * Sample manifests and the listening page for Q (spikes/voice-loop/samples/index.html). The page
 * is static and uses relative paths only, so it works opened directly as a file in Chrome.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROVIDERS, type ProviderName } from "./voices.ts";

export interface SampleEntry {
  /** Relative to samples/, e.g. "cartesia/derrick/02-x1.15.wav". */
  file: string;
  provider: ProviderName;
  voiceName: string;
  voiceId: string;
  accentLabel: string;
  voiceNote: string;
  /** voice: the clips to rate; speed: same line at several speeds; check: one-off comparisons. */
  group: "voice" | "speed" | "check";
  model: string;
  /** "" or what differs, e.g. "reasoning effort default", "no accent field". */
  variant: string;
  line: string;
  text: string;
  speed: number;
  ttfaMs: number;
  wpm: number;
  transcript?: string;
  paraphraseOps?: string[];
  runId: string;
}

export interface PageContext {
  cadenceMedianWpm: number;
  cadenceP25: number;
  cadenceP75: number;
  /** Per provider: model, chosen speed and TTFA median from the latest run, if known. */
  summaries: Partial<Record<ProviderName, string>>;
}

const MODEL_LABEL: Record<ProviderName, string> = {
  elevenlabs: "ElevenLabs",
  cartesia: "Cartesia",
  openai: "OpenAI",
};

export function manifestPath(samplesDir: string, provider: ProviderName): string {
  return join(samplesDir, provider, "manifest.json");
}

export function readManifest(samplesDir: string, provider: ProviderName): SampleEntry[] {
  const path = manifestPath(samplesDir, provider);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as SampleEntry[];
}

/**
 * Write a provider's manifest. `replace` (a full run) drops earlier entries; otherwise new entries
 * replace same-file entries and the rest are kept. Entries whose file is missing are dropped, so
 * the page only links files that exist.
 */
export function mergeManifest(samplesDir: string, provider: ProviderName, entries: SampleEntry[], replace: boolean): SampleEntry[] {
  const byFile = new Map(replace ? [] : readManifest(samplesDir, provider).map((e) => [e.file, e]));
  for (const e of entries) byFile.set(e.file, e);
  const merged = [...byFile.values()].filter((e) => existsSync(join(samplesDir, e.file)));
  writeFileSync(manifestPath(samplesDir, provider), `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ms = (x: number): string => (Number.isFinite(x) ? `${Math.round(x)} ms` : "—");
const fmtWpm = (x: number): string => (Number.isFinite(x) ? `${Math.round(x)}` : "—");

function clipRow(e: SampleEntry, showTranscript: boolean): string {
  const transcript = showTranscript
    ? `<td class="tx">${e.transcript === undefined ? "—" : esc(e.transcript)}${
        e.paraphraseOps && e.paraphraseOps.length > 0
          ? `<div class="para">changed: ${esc(e.paraphraseOps.join(", "))}</div>`
          : e.transcript !== undefined
            ? `<div class="same">word for word</div>`
            : ""
      }</td>`
    : "";
  return `<tr><td class="num">${esc(e.line)}</td><td>${esc(e.text)}${e.variant ? `<div class="variant">${esc(e.variant)}</div>` : ""}</td>
<td><audio controls preload="none" src="${esc(e.file)}"></audio></td><td class="num">×${e.speed}</td><td class="num">${ms(e.ttfaMs)}</td><td class="num">${fmtWpm(e.wpm)}</td>${transcript}</tr>`;
}

function clipTable(entries: SampleEntry[], showTranscript: boolean): string {
  const head = `<tr><th>Line</th><th>Text</th><th>Audio</th><th>Speed</th><th>First audio</th><th>wpm</th>${showTranscript ? "<th>What it said (its own transcript)</th>" : ""}</tr>`;
  return `<table class="clips"><thead>${head}</thead><tbody>${entries.map((e) => clipRow(e, showTranscript)).join("\n")}</tbody></table>`;
}

const slugish = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const byLine = (a: SampleEntry, b: SampleEntry): number => a.line.localeCompare(b.line) || a.speed - b.speed || a.variant.localeCompare(b.variant);

export function buildPage(entriesByProvider: Record<ProviderName, SampleEntry[]>, ctx: PageContext): string {
  const sections: string[] = [];
  const ratingRows: string[] = [];
  for (const provider of PROVIDERS) {
    const entries = entriesByProvider[provider];
    if (entries.length === 0) continue;
    const showTranscript = provider === "openai";
    const parts: string[] = [];
    const voices = [...new Set(entries.filter((e) => e.group === "voice").map((e) => e.voiceName))];
    for (const voice of voices) {
      const clips = entries.filter((e) => e.group === "voice" && e.voiceName === voice).sort(byLine);
      const first = clips[0] as SampleEntry;
      const wpms = clips.map((e) => e.wpm).filter(Number.isFinite).sort((a, b) => a - b);
      const medianWpm = wpms.length ? (wpms[Math.ceil(wpms.length / 2) - 1] as number) : Number.NaN;
      parts.push(
        `<h3 id="${esc(`${provider}-${voice}`)}">${esc(voice)} <span class="accent">${esc(first.accentLabel)}</span></h3>` +
          `<p class="note">${esc(first.voiceNote)} · median ${fmtWpm(medianWpm)} wpm at ×${first.speed} · voice id <code>${esc(first.voiceId)}</code> · model <code>${esc(first.model)}</code></p>` +
          clipTable(clips, showTranscript),
      );
      const key = `${MODEL_LABEL[provider]} — ${voice}`;
      const field = (f: string, label: string): string => `data-f="${f}" name="${esc(`${slugish(key)}-${f}`)}" aria-label="${esc(`${key}: ${label}`)}"`;
      const scale = [1, 2, 3, 4, 5].map((n) => `<option>${n}</option>`).join("");
      ratingRows.push(
        `<tr data-key="${esc(key)}"><td>${esc(MODEL_LABEL[provider])}</td><td>${esc(voice)}</td>` +
          `<td><select ${field("nat", "naturalness")}><option></option>${scale}</select></td>` +
          `<td><select ${field("cad", "cadence")}><option></option>${scale}</select></td>` +
          `<td><select ${field("pilot", "sounds like a pilot")}><option></option><option>y</option><option>n</option></select></td>` +
          `<td><input ${field("notes", "notes")} type="text" size="30"></td></tr>`,
      );
    }
    const speed = entries.filter((e) => e.group === "speed");
    // Runs before the speed/ folder existed overwrote the chosen-speed calibration clip with the
    // timing clip of the same line, voice and speed. Fill the gap with that take, labelled.
    for (const line of new Set(speed.map((e) => e.line))) {
      const voiceName = speed.find((e) => e.line === line)?.voiceName;
      const have = new Set(speed.filter((e) => e.line === line).map((e) => e.speed));
      for (const e of entries) {
        if (e.group === "voice" && e.voiceName === voiceName && e.line === line && !have.has(e.speed)) {
          speed.push({ ...e, variant: "same take as in the voice list above" });
          have.add(e.speed);
        }
      }
    }
    speed.sort(byLine);
    if (speed.length > 0) {
      parts.push(
        `<h3>Speed comparison</h3><p class="note">The same lines at each tested speed setting (${esc(speed[0]?.voiceName ?? "")}). Q's own cadence: median ${Math.round(ctx.cadenceMedianWpm)} wpm, middle half ${Math.round(ctx.cadenceP25)}–${Math.round(ctx.cadenceP75)}.</p>` +
          clipTable(speed, showTranscript),
      );
    }
    const checks = entries.filter((e) => e.group === "check").sort(byLine);
    if (checks.length > 0) parts.push(`<h3>Checks</h3>${clipTable(checks, showTranscript)}`);
    sections.push(
      `<section><h2>${esc(MODEL_LABEL[provider])}</h2>${ctx.summaries[provider] ? `<p class="summary">${esc(ctx.summaries[provider] ?? "")}</p>` : ""}${parts.join("\n")}</section>`,
    );
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pilot Voice Samples</title>
<style>
:root { --bg: #fbfbf9; --fg: #1d1d1b; --muted: #6b6b66; --line: #deded8; --accent: #2f5d8a; --warn: #9a4b00; --ok: #2c6e3f; --panel: #f1f1ec; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #e8e8e3; --muted: #a0a09a; --line: #3a3a36; --accent: #8db8e3; --warn: #f0a560; --ok: #7fc794; --panel: #20201e; } }
body { background: var(--bg); color: var(--fg); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0 auto; max-width: 1200px; padding: 16px; }
h1 { font-size: 1.5rem; margin: 0.2em 0; } h2 { border-top: 2px solid var(--line); margin-top: 2em; padding-top: 0.6em; } h3 { margin: 1.4em 0 0.2em; }
.accent { color: var(--accent); font-size: 0.85em; font-weight: 500; margin-left: 0.4em; }
.note, .summary { color: var(--muted); margin: 0.2em 0 0.6em; } .summary { color: var(--fg); }
table { border-collapse: collapse; width: 100%; } th, td { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: middle; }
th { font-size: 0.85em; color: var(--muted); font-weight: 600; } td.num { white-space: nowrap; font-variant-numeric: tabular-nums; }
audio { height: 32px; width: 260px; max-width: 60vw; } code { font-size: 0.85em; }
.variant { color: var(--accent); font-size: 0.85em; } .para { color: var(--warn); font-size: 0.85em; } .same { color: var(--ok); font-size: 0.85em; } .tx { font-size: 0.9em; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 10px 14px; }
textarea { width: 100%; min-height: 9em; font: 13px/1.4 ui-monospace, Menlo, monospace; background: var(--bg); color: var(--fg); border: 1px solid var(--line); }
select, input, button, textarea { font-size: 14px; } button { padding: 4px 12px; }
.wrap { overflow-x: auto; }
</style>
</head>
<body>
<h1>JFK Ground pilot voices: samples for Q</h1>
<div class="panel">
<p><strong>What to do:</strong> listen to each voice's clips, then rate it in the table at the bottom: naturalness 1–5, cadence 1–5 (does it sound like a busy frequency without sounding rushed?), and whether it sounds like a pilot (y/n). Press <em>Copy as Markdown</em> and paste the result into the "Q's listening verdict" table in <code>spikes/voice-loop/results/0.5-voices.md</code>. Ratings are remembered in this browser while you work.</p>
<p>No radio effects are applied (PRD §6.2). "First audio" is the time from sending the request to the first audio bytes arriving (the budget is 0.2 s). "wpm" is words per minute over the speech in the clip; your own controller recordings run at a median of ${Math.round(ctx.cadenceMedianWpm)} wpm (middle half ${Math.round(ctx.cadenceP25)}–${Math.round(ctx.cadenceP75)}).</p>
</div>
${sections.join("\n")}
<h2 id="rate">Your ratings</h2>
<div class="wrap"><table id="ratings"><thead><tr><th>Provider</th><th>Voice</th><th>Naturalness 1–5</th><th>Cadence 1–5</th><th>Sounds like a pilot</th><th>Notes</th></tr></thead><tbody>
${ratingRows.join("\n")}
</tbody></table></div>
<p><button id="copy">Copy as Markdown</button> <span id="copied" class="note"></span></p>
<textarea id="md" readonly placeholder="The Markdown table appears here."></textarea>
<script>
(() => {
  const KEY = "atc-voice-ratings-v1";
  const rows = [...document.querySelectorAll("#ratings tbody tr")];
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { saved = {}; }
  for (const row of rows) {
    const s = saved[row.dataset.key] || {};
    for (const el of row.querySelectorAll("[data-f]")) {
      if (s[el.dataset.f] !== undefined) el.value = s[el.dataset.f];
      el.addEventListener("change", save);
      el.addEventListener("input", save);
    }
  }
  function collect() {
    const out = {};
    for (const row of rows) {
      const r = {};
      for (const el of row.querySelectorAll("[data-f]")) r[el.dataset.f] = el.value;
      out[row.dataset.key] = r;
    }
    return out;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(collect())); } catch (e) { /* storage unavailable */ } }
  document.getElementById("copy").addEventListener("click", async () => {
    const data = collect();
    const cell = (s) => String(s || "").replace(/\\|/g, "/");
    const lines = ["| Provider | Voice | Naturalness (1–5) | Cadence (1–5) | Sounds like a pilot (y/n) | Notes |", "|---|---|---|---|---|---|"];
    for (const row of rows) {
      const r = data[row.dataset.key];
      const [provider, voice] = row.dataset.key.split(" — ");
      lines.push("| " + [provider, voice, r.nat, r.cad, r.pilot, r.notes].map(cell).join(" | ") + " |");
    }
    const md = lines.join("\\n");
    const box = document.getElementById("md");
    box.value = md;
    box.select();
    let ok = false;
    try { await navigator.clipboard.writeText(md); ok = true; } catch (e) { ok = false; }
    document.getElementById("copied").textContent = ok ? "Copied." : "Select the text below and copy it.";
  });
})();
</script>
</body>
</html>
`;
}

/** Plain-text table with padded columns. */
export function formatTable(rows: string[][]): string {
  const widths = (rows[0] ?? []).map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  const line = (r: string[]): string => `| ${r.map((cell, c) => cell.padEnd(widths[c] ?? 0)).join(" | ")} |`;
  const [head, ...body] = rows;
  if (!head) return "";
  return [line(head), `|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`, ...body.map(line)].join("\n");
}
