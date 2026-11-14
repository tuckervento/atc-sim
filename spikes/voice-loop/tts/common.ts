/**
 * Shared helpers for the task 0.5 voice bench: key loading and redaction (the same approach as
 * check-keys.ts), stats, and word normalization for speaking rate and paraphrase checks.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

/** spikes/voice-loop/ */
export const SPIKE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
/** Never put personal information in requests. */
export const USER_AGENT = "atc-sim-spike/0.1";
export const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REASON_CHARS = 300;

/** Loads spikes/voice-loop/.env.local. Its values override the shell, as in check-keys. */
export function loadEnvLocal(): void {
  const path = join(SPIKE_DIR, ".env.local");
  if (!existsSync(path)) {
    console.error(`tts-bench: no ${path}; reading keys from the process environment only`);
    return;
  }
  for (const [name, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) process.env[name] = value;
}

/** Returns the key, or throws a message naming the variable (never the value). */
export function requireKey(envVar: string): string {
  const key = process.env[envVar];
  if (key === undefined || key.trim() === "") throw new Error(`${envVar} is missing or empty in .env.local`);
  // A stray newline would make fetch reject the header with the key in the message.
  if (/\s/.test(key)) throw new Error(`${envVar} contains whitespace; re-paste it`);
  return key;
}

/**
 * Strip the key from any text we might print or save, then flatten and shorten it. Some providers
 * echo a masked key in errors, so any word containing the key's first 6 or last 4 characters is
 * redacted too (same rule as check-keys.ts).
 */
export function sanitize(text: string, key: string): string {
  const head = key.slice(0, 6);
  const tail = key.slice(-4);
  const flat = text
    .split(key)
    .join("[redacted]")
    .split(/\s+/)
    .filter((word) => word !== "")
    .map((word) => (key.length >= 12 && (word.includes(head) || word.includes(tail)) ? "[redacted]" : word))
    .join(" ");
  return flat.length > MAX_REASON_CHARS ? `${flat.slice(0, MAX_REASON_CHARS - 3)}...` : flat;
}

/** Pull a human-readable message out of a provider's JSON error body. */
export function errorMessage(bodyText: string): string {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  const pick = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(pick).filter(Boolean).join("; ") || undefined;
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const field of ["message", "msg", "detail", "error", "title", "status"]) {
        const found = pick(record[field]);
        if (found) return found;
      }
    }
    return undefined;
  };
  return pick(body) ?? bodyText;
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return `timed out after ${REQUEST_TIMEOUT_MS} ms`;
    const cause = err.cause instanceof Error ? ` (${err.cause.message})` : "";
    return `${err.message}${cause}`;
  }
  return String(err);
}

/** A failed provider request. `message` is already sanitized. */
export class ProviderError extends Error {
  status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

/** GET a provider JSON endpoint; throws a sanitized ProviderError on failure. */
export async function getJson(url: string, headers: Record<string, string>, key: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, ...headers },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ProviderError(sanitize(`network error: ${describeError(err)}`, key));
  }
  const text = await res.text();
  if (!res.ok) throw new ProviderError(sanitize(`HTTP ${res.status} ${errorMessage(text)}`, key), res.status);
  return JSON.parse(text);
}

export function median(xs: number[]): number {
  return percentile(xs, 50);
}

/** Nearest-rank percentile (p in 0..100). NaN for an empty list. */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number;
}

/**
 * Words as spoken: lowercase, hyphens split ("twenty-three" is two words), punctuation dropped,
 * apostrophes kept inside words ("Oscar's").
 */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‐-―-]/g, " ")
    .replace(/[^a-z0-9'.\s]/g, " ")
    .replace(/(?<![0-9])\.|\.(?![0-9])/g, " ")
    .replace(/(^|\s)'+|'+(\s|$)/g, " ")
    .split(/\s+/)
    .filter((w) => w !== "");
}

export function wordCount(text: string): number {
  return normalizeWords(text).length;
}

/**
 * Word-level alignment of reference vs hypothesis (Levenshtein). Returns the edit count and the
 * edits as readable strings: "niner→nine" (substitution), "+word" (inserted), "-word" (dropped).
 */
export function wordDiff(ref: string[], hyp: string[]): { edits: number; ops: string[] } {
  const d: number[][] = [];
  for (let i = 0; i <= ref.length; i++) {
    const row: number[] = [];
    for (let j = 0; j <= hyp.length; j++) {
      if (i === 0) row.push(j);
      else if (j === 0) row.push(i);
      else {
        const sub = (d[i - 1]![j - 1] as number) + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
        row.push(Math.min(sub, (d[i - 1]![j] as number) + 1, (row[j - 1] as number) + 1));
      }
    }
    d.push(row);
  }
  const ops: string[] = [];
  let i = ref.length;
  let j = hyp.length;
  while (i > 0 || j > 0) {
    const here = d[i]![j] as number;
    if (i > 0 && j > 0 && here === (d[i - 1]![j - 1] as number) + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      if (ref[i - 1] !== hyp[j - 1]) ops.push(`${ref[i - 1]}→${hyp[j - 1]}`);
      i--;
      j--;
    } else if (i > 0 && here === (d[i - 1]![j] as number) + 1) {
      ops.push(`-${ref[i - 1]}`);
      i--;
    } else {
      ops.push(`+${hyp[j - 1]}`);
      j--;
    }
  }
  return { edits: d[ref.length]![hyp.length] as number, ops: ops.reverse() };
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
