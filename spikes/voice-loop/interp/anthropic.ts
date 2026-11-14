/**
 * Anthropic runner: Claude Haiku 5.5 through @anthropic-ai/sdk (1.3.0), thinking disabled.
 *
 * Checked against the claude-api skill and platform.claude.com on 2026-11-14:
 * - `thinking: {type: "disabled"}` is accepted on Haiku 5.5 at effort high or below; effort
 *   is left at its default (medium).
 * - Caching: `cache_control` on the static system block caches tools + system (the prefix
 *   order is tools, system, messages). Minimum cacheable prefix on Haiku 5.5: 512 tokens.
 *   `usage.input_tokens` excludes cache reads and writes.
 * - No sampling parameters (Haiku 5.5 rejects non-default ones) and no prefill.
 *
 * Measured, not as documented: Haiku 5.5 rejects the full command schema for grammar-
 * constrained output, both as `output_config.format` and as a strict tool, with HTTP 400
 * "The compiled grammar is too large". It passes every documented explicit limit (12 union
 * parameters of 16, 0 optional of 24). So the answer modes here are:
 * - "text" (used for the bake-off): plain JSON text, with the schema written into the
 *   cached prompt.
 * - "tool": a non-strict `submit_command` tool whose input schema is the full schema.
 *   Approach A forces it with tool_choice (Haiku 5.5 accepts forced tool use); approach B
 *   leaves tool_choice auto and the loop ends when it's called. In the probe, 3 of 3 answers
 *   left out the root `"type": "transmission"` field (non-strict tools don't enforce
 *   `required`), so it isn't used.
 * - "format": output_config.format, kept so the rejection can be reproduced.
 * Without a grammar the answer isn't guaranteed to match the schema; interp/shape.ts checks
 * it, and invalid output counts as a miss.
 */
import Anthropic from "@anthropic-ai/sdk";
import { performance } from "node:perf_hooks";
import { USER_AGENT, describeError, requireKey } from "../stt/env.ts";
import { connectionCount } from "./net.ts";
import { sha, staticPrefix, userMessage, type AnswerMode, type Approach } from "./prompt.ts";
import { TOOLS, TRANSMISSION_SCHEMA } from "./schema.ts";
import { parseTerseAnswer } from "./shape.ts";
import { runTool } from "./tools.ts";
import {
  MAX_OUTPUT_TOKENS, MAX_ROUND_TRIPS, REQUEST_TIMEOUT_MS, parseAnswer,
  type CallRecord, type InterpResult, type Pricing, type Runner,
} from "./types.ts";

const MODEL = "claude-haiku-5-5";
const HOST = "api.anthropic.com";
const SUBMIT = "submit_command";

export const ANTHROPIC_PRICING: Pricing = {
  input: 0.10, cacheRead: 0.01, cacheWrite: 0.125, output: 0.50,
  source: "docs/spikes/voice-loop.md § Shortlist (Anthropic pricing page, 2026-11-14): prompts up to 100K tokens; 5-minute cache writes",
};

export function anthropicRunner(approach: Approach, answer: AnswerMode = "text"): Runner {
  const client = new Anthropic({
    apiKey: requireKey("ANTHROPIC_API_KEY"),
    maxRetries: 0,
    timeout: REQUEST_TIMEOUT_MS,
    defaultHeaders: { "User-Agent": USER_AGENT },
  });
  const prefix = staticPrefix(approach, answer, JSON.stringify(TRANSMISSION_SCHEMA));
  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: prefix, cache_control: { type: "ephemeral" } }];
  const tools: Anthropic.Tool[] = [];
  if (approach === "tools") {
    for (const t of TOOLS) tools.push({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema, strict: true });
  }
  if (answer === "tool") {
    tools.push({
      name: SUBMIT,
      description: "Submit the controller's command. Call it exactly once, with the whole transmission.",
      input_schema: TRANSMISSION_SCHEMA as Anthropic.Tool.InputSchema,
    });
  }
  const toolChoice: Anthropic.ToolChoice | undefined = answer === "tool" && approach === "prompt" ? { type: "tool", name: SUBMIT } : undefined;
  const config = {
    model: MODEL,
    thinking: "disabled",
    effort: "default (medium)",
    max_tokens: MAX_OUTPUT_TOKENS,
    answer: answer === "tool"
      ? `non-strict ${SUBMIT} tool with the full schema${toolChoice ? ", forced with tool_choice" : ", tool_choice auto"}`
      : answer === "text" ? "JSON text, schema in the prompt"
      : answer === "terse" ? "terse syntax text, parsed with parseTerse (extra experiment)"
      : "output_config.format json_schema",
    cache: "cache_control ephemeral (5 min) on the static system block",
    tools: tools.map((t) => `${t.name}${t.strict ? " (strict)" : ""}`),
    promptSha: sha(prefix),
    schemaSha: sha(JSON.stringify(TRANSMISSION_SCHEMA)),
    toolsSha: approach === "tools" ? sha(JSON.stringify(TOOLS)) : null,
  };

  async function call(messages: Anthropic.MessageParam[]): Promise<{ record: CallRecord; message: Anthropic.Message | null }> {
    const before = connectionCount(HOST);
    const t0 = performance.now();
    try {
      const message = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        thinking: { type: "disabled" },
        system,
        ...(tools.length ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
        messages,
        ...(answer === "format" ? { output_config: { format: { type: "json_schema" as const, schema: TRANSMISSION_SCHEMA } } } : {}),
      });
      const ms = performance.now() - t0;
      const u = message.usage;
      const toolCalls = message.content.flatMap((b) => (b.type === "tool_use" ? [{ name: b.name, input: b.input }] : []));
      const texts = message.content.flatMap((b) => (b.type === "text" ? [b.text] : []));
      return {
        message,
        record: {
          ms,
          newConnection: connectionCount(HOST) > before,
          tokens: { uncached: u.input_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens },
          usage: u,
          stopReason: message.stop_reason,
          serverMs: null,
          toolCalls,
          text: texts.length ? texts.join("") : null,
          error: null,
        },
      };
    } catch (err) {
      const status = err instanceof Anthropic.APIError ? ` (HTTP ${err.status})` : "";
      return {
        message: null,
        record: {
          ms: performance.now() - t0, newConnection: connectionCount(HOST) > before,
          tokens: { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, usage: null, stopReason: null, serverMs: null,
          toolCalls: [], text: null, error: `${describeError(err)}${status}`,
        },
      };
    }
  }

  async function run(num: string, transcript: string): Promise<InterpResult> {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMessage(approach, num, transcript) }];
    const calls: CallRecord[] = [];
    const toolTrace: InterpResult["toolTrace"] = [];
    let toolMs = 0;
    const totalMs = () => calls.reduce((n, c) => n + c.ms, 0) + toolMs;
    for (let round = 1; round <= MAX_ROUND_TRIPS; round++) {
      const { record, message } = await call(messages);
      calls.push(record);
      if (!message) return { calls, totalMs: totalMs(), toolTrace, rawText: null, parsed: null, error: `API error: ${record.error}` };
      const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const submit = toolUses.find((b) => b.name === SUBMIT);
      if (submit) {
        // The answer. Lookups called in the same turn are recorded but not run.
        const extra = toolUses.length > 1 ? ` (also called ${toolUses.filter((b) => b !== submit).map((b) => b.name).join(", ")} in the same turn)` : "";
        const others = toolUses.filter((b) => b !== submit).map((b) => ({ name: b.name, input: b.input, output: "not run: submitted in the same turn" }));
        toolTrace.push(...others);
        return { calls, totalMs: totalMs(), toolTrace, rawText: JSON.stringify(submit.input), parsed: submit.input, error: null, ...(extra ? { note: extra } : {}) };
      }
      if (message.stop_reason === "tool_use" && toolUses.length > 0) {
        const t0 = performance.now();
        const results: Anthropic.ToolResultBlockParam[] = toolUses.map((tu) => {
          const output = runTool(num, tu.name, tu.input);
          toolTrace.push({ name: tu.name, input: tu.input, output });
          return { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(output) };
        });
        toolMs += performance.now() - t0;
        messages.push({ role: "assistant", content: message.content }, { role: "user", content: results });
        continue;
      }
      if (answer === "tool") {
        return { calls, totalMs: totalMs(), toolTrace, rawText: record.text, parsed: null, error: `ended (${message.stop_reason}) without calling ${SUBMIT}` };
      }
      if (message.stop_reason !== "end_turn") {
        return { calls, totalMs: totalMs(), toolTrace, rawText: record.text, parsed: null, error: `stop_reason ${message.stop_reason}` };
      }
      return { calls, totalMs: totalMs(), toolTrace, rawText: record.text, ...(answer === "terse" ? parseTerseAnswer(record.text) : parseAnswer(record.text)) };
    }
    return { calls, totalMs: totalMs(), toolTrace, rawText: null, parsed: null, error: `no answer after ${MAX_ROUND_TRIPS} round trips` };
  }

  const id = `haiku-5-5.${approach}${answer === "text" ? "" : `.${answer}-answer`}`;
  return { id, provider: "anthropic", model: MODEL, approach, pricing: ANTHROPIC_PRICING, config, run };
}
