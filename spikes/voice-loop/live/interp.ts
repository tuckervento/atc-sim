/**
 * The interpreter for the live loop: gpt-6-luna, prompt approach, strict JSON (0.4's pick),
 * explicit cache breakpoint, reasoning effort none, on Node's fetch (keep-alive; see warm.ts).
 *
 * Why not interp/openai.ts's runner directly: `runner.run(num, transcript)` builds its game
 * context from a script line number only (liveContext(num), with interp/context.ts's private
 * per-line states). Cards need their own states. So this file builds the same request from the
 * same reused pieces (staticPrefix, TRANSMISSION_SCHEMA, the same body fields in the same
 * order), and takes the live context as a string:
 * - replay of a script line: liveContext(num), exactly 0.4's context for that line
 * - a card: cardContext(card), the same format with the card's states
 * check.ts proves the request body deep-equals what openaiRunner sends for a script line, and
 * that cardContext with no overrides equals liveContext for a line with none.
 *
 * Answer modes: "format" (strict JSON, the live loop) and "terse" (analyze.ts --terse-replay
 * only; 0.4's terse rules, optionally with the general syntax checklist below).
 */
import { performance } from "node:perf_hooks";
import { USER_AGENT, describeError, redact, requireKey } from "../stt/env.ts";
import { ATIS, FLIGHTS, describeFlight, type Flight, type FlightState } from "../interp/context.ts";
import { connectionCount } from "../interp/net.ts";
import { OPENAI_PRICING } from "../interp/openai.ts";
import { sha, staticPrefix } from "../interp/prompt.ts";
import { TRANSMISSION_SCHEMA } from "../interp/schema.ts";
import { checkShape, parseTerseAnswer } from "../interp/shape.ts";
import { MAX_OUTPUT_TOKENS, costUsd, parseAnswer, type Tokens } from "../interp/types.ts";
import type { Card } from "./cards.ts";
import { onHost } from "./warm.ts";
import type { Transmission } from "../../../src/sim/commands.ts";

export const MODEL = "gpt-6-luna";
export const HOST = "api.openai.com";
const URL = "https://api.openai.com/v1/responses";
const TIMEOUT_MS = 15_000;
export { OPENAI_PRICING };

// ---- context ---------------------------------------------------------------------------

type FlightNow = Flight & { state: FlightState };

/** Same text as interp/context.ts flightLine() (not exported there). */
function flightLine(f: FlightNow): string {
  const d = describeFlight(f);
  const parts = [`${d.callsign} "${d.spoken}" ${d.aircraft}, ${d.flight}. Position: ${d.position}.`];
  if (d.clearance) parts.push(`Clearance: ${d.clearance}.`);
  if (d.lastPilotTransmission) parts.push(`Last pilot transmission: "${d.lastPilotTransmission}"`);
  if (d.notes) parts.push(`Notes: ${d.notes}`);
  return `- ${parts.join(" ")}`;
}

export function flightsWith(states: Record<string, FlightState>): FlightNow[] {
  for (const cs of Object.keys(states)) {
    if (!FLIGHTS.some((f) => f.callsign === cs)) throw new Error(`live/interp.ts: state for unknown flight ${cs}`);
  }
  return FLIGHTS.map((f) => ({ ...f, state: states[f.callsign] ?? f.base }));
}

/** interp/context.ts liveContext(), with explicit states instead of a script line's. */
export function contextFor(states: Record<string, FlightState>, unattributed: string | null): string {
  const out = [
    `Current ATIS: information Papa (letter ${ATIS.letter}), altimeter ${ATIS.altimeter}. Runway configuration: arrivals land 31R, departures use 31L.`,
    "",
    "Flights on frequency:",
    ...flightsWith(states).map(flightLine),
  ];
  if (unattributed) out.push("", `Unattributed transmission just received (the callsign was unreadable): "${unattributed}"`);
  return out.join("\n");
}

export function cardContext(card: Card): string {
  return contextFor(card.states, card.unattributed ?? null);
}

// ---- request ---------------------------------------------------------------------------

export type AnswerMode = "format" | "terse";

/**
 * General syntax checklist for the terse answer mode (analyze.ts --terse-replay, variant
 * "terse-tuned"). Written from docs/terse-syntax.md and the error classes 0.4 reported
 * (a ramp destination without "ramp", a space after "L:"). Nothing in it comes from a card or
 * a script line, and it was fixed before the terse replay ran.
 */
export const TERSE_CHECKLIST = `## Before you answer, check the syntax

- After "taxi" comes exactly one destination: a runway (31L), ramp, ramp T4, pad or penalty. A terminal is never written alone: "taxi ramp T4", not "taxi T4".
- Then "via" and the taxiway IDs separated by single spaces. A turn is written L:A or R:KE, with no space after the colon.
- Hold-shorts that belong to a taxi clearance go at the end of that taxi instruction (taxi 31L via A KE hs B 31R), with no comma before "hs".
- Instructions are separated by ", ". Use only the instruction words listed above.
- The answer is one line that starts with the callsign (or "?" for an unknown station).`;

export interface InterpCall {
  ms: number;
  newConnection: boolean;
  serverMs: number | null;
  tokens: Tokens;
  usd: number;
  status: number | null;
  rawText: string | null;
  /** Valid command, or null with a reason. */
  command: Transmission | null;
  terse: string | null;
  invalidReason: string | null;
  /** API or network error (no answer at all). */
  error: string | null;
  /** Rough JSON callsign from an invalid answer, for "say again, <callsign>". */
  invalidCallsign: string | null;
}

export class Interpreter {
  readonly mode: AnswerMode;
  readonly tuned: boolean;
  private readonly key: string;
  private readonly staticBlock: Record<string, unknown>;
  readonly promptSha: string;

  constructor(mode: AnswerMode = "format", tuned = false) {
    if (mode === "format" && tuned) throw new Error("the tuned checklist is for terse answers only");
    this.mode = mode;
    this.tuned = tuned;
    this.key = requireKey("OPENAI_API_KEY");
    const text = mode === "terse" && tuned ? `${staticPrefix("prompt", "terse")}\n\n${TERSE_CHECKLIST}` : staticPrefix("prompt", mode);
    this.promptSha = sha(text);
    // Same block as interp/openai.ts with cacheMode "explicit".
    this.staticBlock = { type: "input_text", text, prompt_cache_breakpoint: { mode: "explicit" } };
  }

  /** The request body, field for field and in the same order as interp/openai.ts call(). */
  body(context: string, transcript: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: MODEL,
      reasoning: { effort: "none" },
      store: false,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      input: [
        { role: "developer", content: [this.staticBlock] },
        // interp/prompt.ts userMessage("prompt", ...): `${liveContext}\n\nTranscript: "${t}"`
        { role: "user", content: [{ type: "input_text", text: `${context}\n\nTranscript: "${transcript}"` }] },
      ],
    };
    if (this.mode === "format") body.text = { format: { type: "json_schema", name: "transmission", schema: TRANSMISSION_SCHEMA, strict: true } };
    body.prompt_cache_options = { mode: "explicit" };
    return body;
  }

  async interpret(context: string, transcript: string): Promise<InterpCall> {
    const before = connectionCount(HOST);
    const t0 = performance.now();
    const out: InterpCall = {
      ms: 0, newConnection: false, serverMs: null, tokens: { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, usd: 0,
      status: null, rawText: null, command: null, terse: null, invalidReason: null, error: null, invalidCallsign: null,
    };
    let json: Record<string, unknown>;
    let res: Response;
    try {
      const got = await onHost(HOST, async () => {
        const r = await fetch(URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json", "User-Agent": USER_AGENT },
          body: JSON.stringify(this.body(context, transcript)),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        return { r, text: await r.text() };
      });
      res = got.r;
      const text = got.text;
      out.status = res.status;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        out.error = `HTTP ${res.status}, body isn't JSON: ${redact(text)}`;
        return out;
      }
    } catch (err) {
      out.error = describeError(err);
      return out;
    } finally {
      out.ms = performance.now() - t0;
      out.newConnection = connectionCount(HOST) > before;
    }
    if (!res.ok) {
      const e = json.error as { message?: string } | undefined;
      out.error = `HTTP ${res.status}: ${redact(e?.message ?? JSON.stringify(json))}`;
      return out;
    }
    const u = (json.usage ?? {}) as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } };
    const cached = u.input_tokens_details?.cached_tokens ?? 0;
    const written = u.input_tokens_details?.cache_write_tokens ?? 0;
    out.tokens = { uncached: (u.input_tokens ?? 0) - cached - written, cacheRead: cached, cacheWrite: written, output: u.output_tokens ?? 0 };
    out.usd = costUsd(out.tokens, OPENAI_PRICING);
    const server = res.headers.get("openai-processing-ms");
    out.serverMs = server !== null && Number.isFinite(Number(server)) ? Number(server) : null;
    const texts: string[] = [];
    for (const item of (json.output ?? []) as Array<{ type: string; content?: Array<{ type: string; text?: string }> }>) {
      if (item.type !== "message") continue;
      for (const c of item.content ?? []) if (c.type === "output_text" && typeof c.text === "string") texts.push(c.text);
    }
    out.rawText = texts.length ? texts.join("") : null;
    if (String(json.status) !== "completed") {
      out.invalidReason = `status ${String(json.status)}`;
      return out;
    }
    const parsed = this.mode === "terse" ? parseTerseAnswer(out.rawText) : parseAnswer(out.rawText);
    if (parsed.error) {
      out.invalidReason = parsed.error;
      return out;
    }
    const shape = checkShape(parsed.parsed);
    if (!shape.ok) {
      out.invalidReason = `shape: ${shape.reason}`;
      const cs = (parsed.parsed as { callsign?: unknown } | null)?.callsign;
      out.invalidCallsign = typeof cs === "string" ? cs : null;
      return out;
    }
    out.command = shape.command;
    out.terse = shape.terse;
    return out;
  }
}
