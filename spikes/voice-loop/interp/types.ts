/** Shared types for the interpreter bench. */
import type { Approach } from "./prompt.ts";

export type Provider = "anthropic" | "openai";

/** Token counts for one request, split by how each is billed. */
export interface Tokens {
  /** Input billed at the full rate. */
  uncached: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** One HTTP request to the model (approach B makes several per transcript). */
export interface CallRecord {
  ms: number;
  newConnection: boolean;
  tokens: Tokens;
  /** The provider's raw usage object, saved as returned. */
  usage: unknown;
  stopReason: string | null;
  /** OpenAI's openai-processing-ms header, when present. */
  serverMs: number | null;
  toolCalls: Array<{ name: string; input: unknown }>;
  text: string | null;
  error: string | null;
}

export interface InterpResult {
  calls: CallRecord[];
  /** Sum of every request plus local tool time: transcript in, command out. */
  totalMs: number;
  toolTrace: Array<{ name: string; input: unknown; output: unknown }>;
  /** The model's final answer text, as returned. */
  rawText: string | null;
  /** JSON.parse(rawText), or null if it didn't parse. */
  parsed: unknown;
  /** Why there's no usable answer (API error, refusal, bad JSON, too many tool rounds). */
  error: string | null;
  /** Anything unusual that didn't make the answer invalid. */
  note?: string;
}

export interface Pricing {
  /** USD per 1M tokens. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  source: string;
}

export interface Runner {
  id: string;
  provider: Provider;
  model: string;
  approach: Approach;
  pricing: Pricing;
  config: Record<string, unknown>;
  run(num: string, transcript: string): Promise<InterpResult>;
}

export const MAX_ROUND_TRIPS = 4;
export const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_OUTPUT_TOKENS = 1024;

export function costUsd(t: Tokens, p: Pricing): number {
  return (t.uncached * p.input + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite + t.output * p.output) / 1e6;
}

export function sumTokens(list: Tokens[]): Tokens {
  return list.reduce((a, t) => ({ uncached: a.uncached + t.uncached, cacheRead: a.cacheRead + t.cacheRead, cacheWrite: a.cacheWrite + t.cacheWrite, output: a.output + t.output }), { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
}

/** Parse the answer text; a parse failure becomes the result's error (counted as invalid). */
export function parseAnswer(text: string | null): { parsed: unknown; error: string | null } {
  if (text === null || text.trim() === "") return { parsed: null, error: "no answer text" };
  try {
    return { parsed: JSON.parse(text), error: null };
  } catch (e) {
    return { parsed: null, error: `answer isn't JSON: ${(e as Error).message}` };
  }
}
