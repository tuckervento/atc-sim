/**
 * Phase 0, task 0.1: verify the API key for every shortlisted provider.
 *
 * Loads spikes/voice-loop/.env.local if it exists. Its values take precedence
 * over variables already set in the shell, so this checks the file itself.
 * Then makes one free, authenticated request per provider and prints exactly
 * one stdout line per provider:
 *
 *   OK <provider>
 *   MISSING <provider> (<ENV_VAR>)
 *   FAIL <provider>: <http status and short reason>
 *
 * Exits 0 only if every provider is OK. Never prints key values.
 *
 * Run: npm --prefix spikes/voice-loop run check-keys
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import Anthropic from "@anthropic-ai/sdk";

const ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), ".env.local");
const TIMEOUT_MS = 15_000;
const MAX_REASON_CHARS = 160;

// Model IDs from docs/spikes/voice-loop.md § Shortlist. The checks confirm the
// key can see them, not just that the key is valid.
const ANTHROPIC_MODEL = "claude-haiku-5-5";
const OPENAI_MODELS = ["gpt-live-transcribe", "gpt-6-luna", "gpt-realtime-2.1-mini"];
const CARTESIA_VERSION = "2026-08-14";

type Result = { ok: true } | { ok: false; reason: string };

interface Provider {
  name: string;
  envVar: string;
  check: (key: string) => Promise<Result>;
}

const ok: Result = { ok: true };
const fail = (reason: string): Result => ({ ok: false, reason });

function loadEnvLocal(): void {
  if (!existsSync(ENV_PATH)) {
    console.error(`check-keys: no ${ENV_PATH}; reading keys from the process environment only`);
    return;
  }
  const parsed = parseEnv(readFileSync(ENV_PATH, "utf8"));
  for (const [name, value] of Object.entries(parsed)) process.env[name] = value;
  console.error(`check-keys: loaded ${ENV_PATH}`);
}

/**
 * Strip the key from any text we might print, then flatten and shorten it.
 * Some providers echo a masked key in 401 messages (OpenAI shows the first 8
 * and last 4 characters), so any word containing the key's first 6 or last 4
 * characters is redacted too.
 */
function sanitize(text: string, key: string): string {
  const head = key.slice(0, 6);
  const tail = key.slice(-4);
  const words = text
    .split(key)
    .join("[redacted]")
    .split(/\s+/)
    .filter((word) => word !== "")
    .map((word) => (key.length >= 12 && (word.includes(head) || word.includes(tail)) ? "[redacted]" : word));
  const flat = words.join(" ");
  return flat.length > MAX_REASON_CHARS ? `${flat.slice(0, MAX_REASON_CHARS - 3)}...` : flat;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return `timed out after ${TIMEOUT_MS} ms`;
    const cause = err.cause instanceof Error ? ` (${err.cause.message})` : "";
    return `${err.name}: ${err.message}${cause}`;
  }
  return String(err);
}

/** Pull a human-readable message out of a provider's JSON error body. */
function errorMessage(bodyText: string): string {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  const pick = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const field of ["message", "err_msg", "detail", "error", "title"]) {
        const found = pick(record[field]);
        if (found) return found;
      }
    }
    return undefined;
  };
  return pick(body) ?? bodyText;
}

async function httpCheck(
  url: string,
  headers: Record<string, string>,
  key: string,
  validate?: (body: unknown) => string | undefined,
): Promise<Result> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    return fail(sanitize(`network error: ${describeError(err)}`, key));
  }
  const text = await res.text();
  if (!res.ok) {
    return fail(sanitize(`HTTP ${res.status} ${errorMessage(text) || res.statusText}`, key));
  }
  if (!validate) return ok;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(`HTTP ${res.status} but the response is not JSON`);
  }
  const problem = validate(body);
  return problem ? fail(sanitize(problem, key)) : ok;
}

async function checkAnthropic(key: string): Promise<Result> {
  // Explicit apiKey: the SDK then ignores other credential sources (env tokens,
  // `ant` profiles), so this tests exactly ANTHROPIC_API_KEY.
  const client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: TIMEOUT_MS });
  try {
    await client.models.retrieve(ANTHROPIC_MODEL);
    return ok;
  } catch (err) {
    // APIConnectionError extends APIError in the TypeScript SDK, so check it first.
    if (err instanceof Anthropic.APIConnectionError) {
      return fail(sanitize(`network error: ${describeError(err)}`, key));
    }
    if (err instanceof Anthropic.NotFoundError) {
      return fail(`HTTP 404 model ${ANTHROPIC_MODEL} not found for this key`);
    }
    if (err instanceof Anthropic.APIError) {
      const detail = err.error ? errorMessage(JSON.stringify(err.error)) : err.message;
      return fail(sanitize(`HTTP ${err.status} ${detail}`, key));
    }
    throw err;
  }
}

function validateOpenAiModels(body: unknown): string | undefined {
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return "HTTP 200 but no model list in the response";
  const ids = new Set(data.map((m) => (m as { id?: unknown }).id));
  const missing = OPENAI_MODELS.filter((id) => !ids.has(id));
  return missing.length ? `key works but these models are not listed for it: ${missing.join(", ")}` : undefined;
}

const providers: Provider[] = [
  { name: "anthropic", envVar: "ANTHROPIC_API_KEY", check: checkAnthropic },
  {
    name: "openai",
    envVar: "OPENAI_API_KEY",
    check: (key) =>
      httpCheck("https://api.openai.com/v1/models", { Authorization: `Bearer ${key}` }, key, validateOpenAiModels),
  },
  {
    name: "deepgram",
    envVar: "DEEPGRAM_API_KEY",
    check: (key) => httpCheck("https://api.deepgram.com/v1/projects", { Authorization: `Token ${key}` }, key),
  },
  {
    name: "assemblyai",
    envVar: "ASSEMBLYAI_API_KEY",
    check: (key) => httpCheck("https://api.assemblyai.com/v2/transcript?limit=1", { Authorization: key }, key),
  },
  {
    name: "elevenlabs",
    envVar: "ELEVENLABS_API_KEY",
    check: (key) => httpCheck("https://api.elevenlabs.io/v2/voices?page_size=1", { "xi-api-key": key }, key),
  },
  {
    name: "cartesia",
    envVar: "CARTESIA_API_KEY",
    check: (key) =>
      httpCheck(
        "https://api.cartesia.ai/voices?limit=1",
        { Authorization: `Bearer ${key}`, "Cartesia-Version": CARTESIA_VERSION },
        key,
      ),
  },
];

async function runOne(provider: Provider): Promise<string> {
  const key = process.env[provider.envVar];
  if (key === undefined || key.trim() === "") return `MISSING ${provider.name} (${provider.envVar})`;
  // A pasted newline or space would make fetch reject the header, and its error
  // message would contain the key. Fail before sending.
  if (/\s/.test(key)) return `FAIL ${provider.name}: ${provider.envVar} contains whitespace; re-paste it`;
  try {
    const result = await provider.check(key);
    return result.ok ? `OK ${provider.name}` : `FAIL ${provider.name}: ${result.reason}`;
  } catch (err) {
    return `FAIL ${provider.name}: ${sanitize(`unexpected error: ${describeError(err)}`, key)}`;
  }
}

loadEnvLocal();
const lines = await Promise.all(providers.map(runOne));
for (const line of lines) console.log(line);
process.exitCode = lines.every((line) => line.startsWith("OK ")) ? 0 : 1;
