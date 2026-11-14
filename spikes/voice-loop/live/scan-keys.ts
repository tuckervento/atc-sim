/**
 * Key scan for 0.6's files: every file under live/ (except live/audio/, Q's recordings),
 * results/live/ (logs, replay message recordings, spend log) and results/0.6-findings.md is
 * searched for every value in .env.local, and for each value's first and last 10 characters.
 * Prints counts only; never prints a value.
 *   node live/scan-keys.ts [more paths]  exit 0 if no hits, 1 if any
 *   node live/scan-keys.ts --self-test  positive control: scanning .env.local itself must hit
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseEnv } from "node:util";
import { SPIKE_DIR } from "../stt/env.ts";

const envPath = join(SPIKE_DIR, ".env.local");
if (!existsSync(envPath)) {
  console.error("scan-keys: no .env.local to scan for");
  process.exit(2);
}
const values = Object.values(parseEnv(readFileSync(envPath, "utf8"))).filter((v): v is string => typeof v === "string" && v.length >= 12);
const needles = values.flatMap((v) => [v, v.slice(0, 10), v.slice(-10)]);

function walk(dir: string, skip: Set<string>): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (skip.has(p)) return [];
    return statSync(p).isDirectory() ? walk(p, skip) : [p];
  });
}

if (process.argv.includes("--self-test")) {
  // Positive control: .env.local itself must hit every value.
  const buf = readFileSync(envPath);
  const n = values.filter((k) => buf.indexOf(k) !== -1).length;
  console.log(`scan-keys self-test: ${n}/${values.length} values found in .env.local (expect all)`);
  process.exit(n === values.length && n > 0 ? 0 : 1);
}

// Extra paths (files or directories) can be given as arguments, e.g. a test run's logs.
const extra = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const files = [
  ...walk(join(SPIKE_DIR, "live"), new Set([join(SPIKE_DIR, "live", "audio")])),
  ...walk(join(SPIKE_DIR, "results", "live"), new Set()),
  ...[join(SPIKE_DIR, "results", "0.6-findings.md")].filter(existsSync),
  ...extra.flatMap((p) => (statSync(p).isDirectory() ? walk(p, new Set()) : [p])),
];
let hits = 0;
let bytes = 0;
for (const f of files) {
  const buf = readFileSync(f);
  bytes += buf.length;
  const n = needles.filter((k) => buf.indexOf(k) !== -1).length;
  if (n > 0) console.log(`HIT: ${relative(SPIKE_DIR, f)} contains ${n} key value(s) or fragment(s)`);
  hits += n;
}
console.log(`scan-keys: ${values.length} key values (plus head/tail fragments) x ${files.length} files (${(bytes / 1e6).toFixed(1)} MB): ${hits} hit(s)`);
process.exit(hits === 0 ? 0 : 1);
