/**
 * Critical-token scoring against results/stt/critical-tokens.json (hand-annotated per line).
 *
 * The transcript is normalized (stt/normalize.ts) and items are pulled out of it in this
 * order, each token used at most once:
 * 1. callsign: the annotated callsign's tokens, contiguous, anywhere.
 * 2. holdShort: every "hold short [of] [runway] <target>", where <target> is a runway
 *    (1-2 digits + left/right/center) or a known taxiway name (longest match first).
 * 3. runways: every remaining <1-2 digits> + left/right/center.
 * 4. taxiways: every remaining known taxiway name, longest match first, so "kilo echo" is one
 *    taxiway and never also counts as "kilo".
 * A category's accuracy is (annotated items found) / (annotated items), counting repeats:
 * two annotated "bravo" hold-shorts need two in the transcript. Extra items the transcript
 * adds aren't penalized here (WER covers insertions).
 * Known taxiway names = every taxiway in the annotations plus stt/vocab.ts TAXIWAY_PAIRS.
 */
import { readFileSync } from "node:fs";
import { normalize } from "./normalize.ts";
import { TAXIWAY_PAIRS } from "./vocab.ts";

export const CATEGORIES = ["callsign", "runways", "taxiways", "holdShort"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface CriticalSpec {
  callsign: string | null;
  runways: string[];
  taxiways: string[];
  holdShort: string[];
}

export interface CategoryScore {
  expected: number;
  found: number;
  missed: string[];
}

export type CriticalScore = Record<Category, CategoryScore>;

const SIDES = new Set(["left", "right", "center"]);
const isDigit = (t: string | undefined): boolean => t !== undefined && /^\d$/.test(t);
const norm = (s: string): string => normalize(s).join(" ");

export function loadCritical(path: string, lineNums: string[]): Map<string, CriticalSpec> {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { lines?: Record<string, unknown> };
  if (!raw.lines || typeof raw.lines !== "object") throw new Error(`${path}: no "lines" object`);
  const problems: string[] = [];
  const specs = new Map<string, CriticalSpec>();
  for (const [num, value] of Object.entries(raw.lines)) {
    const v = value as Partial<CriticalSpec>;
    const okList = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === "string" && s.trim() !== "");
    if (!(v.callsign === null || (typeof v.callsign === "string" && v.callsign.trim() !== ""))) problems.push(`${num}: callsign must be a string or null`);
    for (const cat of ["runways", "taxiways", "holdShort"] as const) {
      if (!okList(v[cat])) problems.push(`${num}: ${cat} must be an array of non-empty strings`);
    }
    specs.set(num, v as CriticalSpec);
  }
  for (const num of lineNums) if (!specs.has(num)) problems.push(`line ${num} is in script.md but not annotated`);
  for (const num of specs.keys()) if (!lineNums.includes(num)) problems.push(`line ${num} is annotated but not in script.md`);
  if (problems.length > 0) throw new Error(`${path} is malformed:\n  - ${problems.join("\n  - ")}`);
  return specs;
}

/** Normalized taxiway names, longest first. */
export function taxiwayInventory(specs: Iterable<CriticalSpec>): string[][] {
  const names = new Set<string>(TAXIWAY_PAIRS.map(norm));
  for (const spec of specs) {
    for (const t of spec.taxiways) names.add(norm(t));
    for (const t of spec.holdShort) if (!isRunwayText(norm(t))) names.add(norm(t));
  }
  return [...names].map((n) => n.split(" ")).sort((a, b) => b.length - a.length);
}

function isRunwayText(normalized: string): boolean {
  const parts = normalized.split(" ");
  const side = parts.at(-1);
  return side !== undefined && SIDES.has(side) && parts.length >= 2 && parts.slice(0, -1).every((p) => isDigit(p));
}

export function scoreCritical(spec: CriticalSpec, transcript: string, inventory: string[][]): CriticalScore {
  const h = normalize(transcript);
  const used = h.map(() => false);
  const free = (from: number, len: number) => from >= 0 && from + len <= h.length && used.slice(from, from + len).every((u) => !u);
  const take = (from: number, len: number) => {
    for (let k = from; k < from + len; k++) used[k] = true;
  };
  const matchesAt = (at: number, words: string[]) => free(at, words.length) && words.every((w, k) => h[at + k] === w);

  const taxiwayAt = (at: number): string[] | null => {
    for (const name of inventory) if (matchesAt(at, name)) return name;
    return null;
  };
  /** Runway starting at `at`: 1-2 digits then a side. Returns its token length. */
  const runwayAt = (at: number): number => {
    for (const digits of [2, 1]) {
      const side = h[at + digits];
      if (side !== undefined && SIDES.has(side) && free(at, digits + 1) && h.slice(at, at + digits).every((t) => isDigit(t))) {
        return digits + 1;
      }
    }
    return 0;
  };

  // 1. callsign
  const callsignFound: string[] = [];
  if (spec.callsign !== null) {
    const words = normalize(spec.callsign);
    for (let i = 0; i + words.length <= h.length; i++) {
      if (matchesAt(i, words)) {
        take(i, words.length);
        callsignFound.push(words.join(" "));
        break;
      }
    }
  }

  // 2. hold-short targets
  const holdFound: string[] = [];
  for (let i = 0; i + 2 < h.length; i++) {
    if (!(h[i] === "hold" && h[i + 1] === "short" && free(i, 2))) continue;
    let q = i + 2;
    if (h[q] === "of") q++;
    if (h[q] === "runway") q++;
    const rlen = runwayAt(q);
    if (rlen > 0) {
      holdFound.push(h.slice(q, q + rlen).join(" "));
      take(i, q + rlen - i);
      continue;
    }
    const twy = taxiwayAt(q);
    if (twy) {
      holdFound.push(twy.join(" "));
      take(i, q + twy.length - i);
    }
  }

  // 3. runways: find each side word, then look back for 1-2 digits.
  const runwayFound: string[] = [];
  for (let k = 0; k < h.length; k++) {
    if (!SIDES.has(h[k]!) || used[k]) continue;
    for (const digits of [2, 1]) {
      const at = k - digits;
      if (at >= 0 && runwayAt(at) === digits + 1) {
        runwayFound.push(h.slice(at, k + 1).join(" "));
        take(at, digits + 1);
        break;
      }
    }
  }

  // 4. taxiways
  const taxiwayFound: string[] = [];
  for (let i = 0; i < h.length; ) {
    const twy = taxiwayAt(i);
    if (twy) {
      taxiwayFound.push(twy.join(" "));
      take(i, twy.length);
      i += twy.length;
    } else i++;
  }

  const compare = (expected: string[], found: string[]): CategoryScore => {
    const pool = [...found];
    const missed: string[] = [];
    for (const e of expected) {
      const idx = pool.indexOf(norm(e));
      if (idx >= 0) pool.splice(idx, 1);
      else missed.push(e);
    }
    return { expected: expected.length, found: expected.length - missed.length, missed };
  };
  return {
    callsign: compare(spec.callsign === null ? [] : [spec.callsign], callsignFound),
    runways: compare(spec.runways, runwayFound),
    taxiways: compare(spec.taxiways, taxiwayFound),
    holdShort: compare(spec.holdShort, holdFound),
  };
}
