/**
 * Key loading and redaction for the speech-to-text bench. Same approach as check-keys.ts
 * (which can't be imported: it runs its checks at top level):
 * - spikes/voice-loop/.env.local is loaded if present and overrides the shell
 * - an empty value counts as missing; a value with whitespace is rejected before use
 * - every string we print or save goes through redact(), which removes the key itself and
 *   any word containing its first 6 or last 4 characters (OpenAI echoes masked keys)
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const SPIKE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(SPIKE_DIR, ".env.local");
const MAX_MESSAGE_CHARS = 300;

/** Not personal: identifies the spike, nothing about Q. */
export const USER_AGENT = "atc-sim-spike/0.1";

const loadedKeys: string[] = [];

export function loadEnvLocal(): void {
  if (!existsSync(ENV_PATH)) {
    console.error(`stt-bench: no ${ENV_PATH}; reading keys from the process environment only`);
    return;
  }
  const parsed = parseEnv(readFileSync(ENV_PATH, "utf8"));
  for (const [name, value] of Object.entries(parsed)) process.env[name] = value;
}

/** Returns the key, or throws a message that names the variable (never the value). */
export function requireKey(envVar: string): string {
  const key = process.env[envVar];
  if (key === undefined || key.trim() === "") {
    throw new Error(`${envVar} is missing or empty in .env.local`);
  }
  if (/\s/.test(key)) throw new Error(`${envVar} contains whitespace; re-paste it`);
  if (!loadedKeys.includes(key)) loadedKeys.push(key);
  return key;
}

/** Remove every loaded key (and masked fragments of it) from text, then shorten it. */
export function redact(text: string, maxChars = MAX_MESSAGE_CHARS): string {
  let out = text;
  for (const key of loadedKeys) out = out.split(key).join("[redacted]");
  const words = out
    .split(/\s+/)
    .filter((word) => word !== "")
    .map((word) => {
      for (const key of loadedKeys) {
        if (key.length >= 12 && (word.includes(key.slice(0, 6)) || word.includes(key.slice(-4)))) {
          return "[redacted]";
        }
      }
      return word;
    });
  const flat = words.join(" ");
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 3)}...` : flat;
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? ` (${err.cause.message})` : "";
    return redact(`${err.message}${cause}`);
  }
  return redact(String(err));
}
