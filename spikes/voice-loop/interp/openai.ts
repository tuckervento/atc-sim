/**
 * OpenAI runner: gpt-6-luna on the Responses API, called with fetch (as 0.3 and 0.5 did).
 *
 * Checked against developers.openai.com on 2026-11-14:
 * - gpt-6-luna takes reasoning effort none…max (default medium); this runs `none`.
 *   Chat Completions only allows function calling at effort none; the Responses API is used
 *   for both approaches.
 * - Structured output: `text.format: {type: "json_schema", name, schema, strict: true}`.
 *   Function tools: `{type: "function", name, description, parameters, strict: true}`;
 *   results go back as `function_call_output` items with the call's `call_id`.
 * - Caching: on by default; minimum 1,024 tokens for GPT-5.6 and later. Usage reports
 *   `input_tokens_details.cached_tokens` and `cache_write_tokens`. Writes cost 1.25x for
 *   the default 30-minute lifetime. In the default ("implicit") mode the breakpoint goes at
 *   the end of the latest user message, so a varying user message never reuses a static
 *   prefix; the guide's fix is `prompt_cache_options: {mode: "explicit"}` plus a
 *   `prompt_cache_breakpoint` on the static block. Both modes are selectable here.
 * - `store: false`: nothing is kept server-side, so each round trip resends the input.
 */
import { performance } from "node:perf_hooks";
import { USER_AGENT, describeError, redact, requireKey } from "../stt/env.ts";
import { connectionCount } from "./net.ts";
import { sha, staticPrefix, userMessage, type Approach } from "./prompt.ts";
import { TOOLS, TRANSMISSION_SCHEMA } from "./schema.ts";
import { parseTerseAnswer } from "./shape.ts";
import { runTool } from "./tools.ts";
import {
  MAX_OUTPUT_TOKENS, MAX_ROUND_TRIPS, REQUEST_TIMEOUT_MS, parseAnswer,
  type CallRecord, type InterpResult, type Pricing, type Runner,
} from "./types.ts";

const MODEL = "gpt-6-luna";
const HOST = "api.openai.com";
const URL = "https://api.openai.com/v1/responses";

export const OPENAI_PRICING: Pricing = {
  input: 0.10, cacheRead: 0.01, cacheWrite: 0.125, output: 0.50,
  source: "docs/spikes/voice-loop.md § Shortlist and developers.openai.com/api/docs/models/gpt-6-luna (2026-11-14); 30-minute cache writes",
};

export type CacheMode = "explicit" | "implicit";

interface OutputItem {
  type: string;
  [k: string]: unknown;
}

/** answer "format": strict JSON via text.format (the bake-off). "terse": plain text in terse syntax (extra experiment). */
export function openaiRunner(approach: Approach, cacheMode: CacheMode = "explicit", answer: "format" | "terse" = "format"): Runner {
  const key = requireKey("OPENAI_API_KEY");
  const staticBlock: Record<string, unknown> = { type: "input_text", text: staticPrefix(approach, answer) };
  if (cacheMode === "explicit") staticBlock.prompt_cache_breakpoint = { mode: "explicit" };
  const tools = approach === "tools"
    ? TOOLS.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: true }))
    : [];
  const config = {
    model: MODEL,
    api: "responses",
    reasoning_effort: "none",
    max_output_tokens: MAX_OUTPUT_TOKENS,
    text_format: answer === "format" ? "json_schema strict (interp/schema.ts)" : "none: terse syntax text, parsed with parseTerse (extra experiment)",
    store: false,
    cache: cacheMode === "explicit"
      ? "prompt_cache_options.mode explicit, breakpoint on the static developer block (30 min)"
      : "default (no cache parameters)",
    tools: approach === "tools" ? TOOLS.map((t) => t.name) : [],
    promptSha: sha(staticPrefix(approach, answer)),
    schemaSha: sha(JSON.stringify(TRANSMISSION_SCHEMA)),
    toolsSha: approach === "tools" ? sha(JSON.stringify(TOOLS)) : null,
  };

  async function call(input: unknown[]): Promise<{ record: CallRecord; output: OutputItem[] | null }> {
    const body: Record<string, unknown> = {
      model: MODEL,
      reasoning: { effort: "none" },
      store: false,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      input,
    };
    if (answer === "format") body.text = { format: { type: "json_schema", name: "transmission", schema: TRANSMISSION_SCHEMA, strict: true } };
    if (tools.length) body.tools = tools;
    if (cacheMode === "explicit") body.prompt_cache_options = { mode: "explicit" };
    const before = connectionCount(HOST);
    const t0 = performance.now();
    const failed = (error: string): { record: CallRecord; output: null } => ({
      output: null,
      record: {
        ms: performance.now() - t0, newConnection: connectionCount(HOST) > before,
        tokens: { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, usage: null, stopReason: null, serverMs: null,
        toolCalls: [], text: null, error,
      },
    });
    let res: Response;
    let json: Record<string, unknown>;
    try {
      res = await fetch(URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return failed(`HTTP ${res.status}, body isn't JSON: ${redact(text)}`);
      }
    } catch (err) {
      return failed(describeError(err));
    }
    const ms = performance.now() - t0;
    if (!res.ok) {
      const e = json.error as { message?: string } | undefined;
      return failed(`HTTP ${res.status}: ${redact(e?.message ?? JSON.stringify(json))}`);
    }
    const output = (json.output ?? []) as OutputItem[];
    const u = (json.usage ?? {}) as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } };
    const cached = u.input_tokens_details?.cached_tokens ?? 0;
    const written = u.input_tokens_details?.cache_write_tokens ?? 0;
    const texts: string[] = [];
    let refusal: string | null = null;
    for (const item of output) {
      if (item.type !== "message") continue;
      for (const c of (item.content ?? []) as Array<{ type: string; text?: string; refusal?: string }>) {
        if (c.type === "output_text" && typeof c.text === "string") texts.push(c.text);
        if (c.type === "refusal") refusal = c.refusal ?? "refused";
      }
    }
    const status = String(json.status ?? "");
    const incomplete = json.incomplete_details as { reason?: string } | null | undefined;
    const serverMs = Number(res.headers.get("openai-processing-ms"));
    return {
      output,
      record: {
        ms,
        newConnection: connectionCount(HOST) > before,
        // input_tokens includes cached and written tokens (checked in the probe; see the draft).
        tokens: { uncached: (u.input_tokens ?? 0) - cached - written, cacheRead: cached, cacheWrite: written, output: u.output_tokens ?? 0 },
        usage: json.usage ?? null,
        stopReason: refusal ? "refusal" : status === "incomplete" ? `incomplete: ${incomplete?.reason ?? "?"}` : status,
        serverMs: Number.isFinite(serverMs) && res.headers.has("openai-processing-ms") ? serverMs : null,
        toolCalls: output.filter((o) => o.type === "function_call").map((o) => ({ name: String(o.name), input: o.arguments })),
        text: texts.length ? texts.join("") : null,
        error: null,
      },
    };
  }

  async function run(num: string, transcript: string): Promise<InterpResult> {
    const input: unknown[] = [
      { role: "developer", content: [staticBlock] },
      { role: "user", content: [{ type: "input_text", text: userMessage(approach, num, transcript) }] },
    ];
    const calls: CallRecord[] = [];
    const toolTrace: InterpResult["toolTrace"] = [];
    let toolMs = 0;
    const totalMs = () => calls.reduce((n, c) => n + c.ms, 0) + toolMs;
    for (let round = 1; round <= MAX_ROUND_TRIPS; round++) {
      const { record, output } = await call(input);
      calls.push(record);
      if (!output) return { calls, totalMs: totalMs(), toolTrace, rawText: null, parsed: null, error: `API error: ${record.error}` };
      const fnCalls = output.filter((o) => o.type === "function_call");
      if (fnCalls.length > 0) {
        const t0 = performance.now();
        // Send back the model's output items (as the function-calling guide does), then the results.
        input.push(...output);
        for (const fc of fnCalls) {
          let args: unknown;
          try {
            args = JSON.parse(String(fc.arguments));
          } catch {
            args = { unparsed: fc.arguments };
          }
          const result = runTool(num, String(fc.name), args);
          toolTrace.push({ name: String(fc.name), input: args, output: result });
          input.push({ type: "function_call_output", call_id: fc.call_id, output: JSON.stringify(result) });
        }
        toolMs += performance.now() - t0;
        continue;
      }
      if (record.stopReason !== "completed") {
        return { calls, totalMs: totalMs(), toolTrace, rawText: record.text, parsed: null, error: `status ${record.stopReason}` };
      }
      return { calls, totalMs: totalMs(), toolTrace, rawText: record.text, ...(answer === "terse" ? parseTerseAnswer(record.text) : parseAnswer(record.text)) };
    }
    return { calls, totalMs: totalMs(), toolTrace, rawText: null, parsed: null, error: `no answer after ${MAX_ROUND_TRIPS} round trips` };
  }

  const id = `gpt-6-luna.${approach}${cacheMode === "implicit" ? ".implicit-cache" : ""}${answer === "terse" ? ".terse-answer" : ""}`;
  return { id, provider: "openai", model: MODEL, approach, pricing: OPENAI_PRICING, config, run };
}
