/**
 * Scoring a model's command against the line's expected command (parseTerse(expected)).
 *
 * Normalization, applied to both sides before comparing (one rule):
 *   A run of hold-short instructions immediately after a taxi instruction is folded into
 *   that taxi's holdShort list, in order. `taxi 31L via A, hs B` and `taxi 31L via A hs B`
 *   give the same sim behaviour (docs/terse-syntax.md, C3), but different objects.
 *   Hold-shorts after any other instruction (e.g. after a cross) stay separate.
 * The expected commands are already canonical, so the rule only ever changes model output.
 *
 * Exact match: deep equality after normalization.
 * Per-field: each field is pulled out of both commands as a list, in spoken order. A field
 * counts for a line when the expected or the model's command has it (so a missing value
 * and an invented one both count as wrong). An invalid answer has every expected field wrong.
 */
import { isDeepStrictEqual } from "node:util";
import type { Instruction, Transmission } from "../../../src/sim/commands.ts";

export function normalizeCommand(t: Transmission): Transmission {
  const out: Instruction[] = [];
  for (const ins of t.instructions as Instruction[]) {
    const prev = out[out.length - 1];
    if (ins.type === "hold-short" && prev && prev.type === "taxi") {
      out[out.length - 1] = { ...prev, holdShort: [...prev.holdShort, ins.target] };
      continue;
    }
    out.push(ins);
  }
  return { ...t, instructions: out } as Transmission;
}

export const FIELDS = [
  "callsign", "types", "destination", "route", "turns", "holdShorts", "crossings", "other",
] as const;
export type Field = (typeof FIELDS)[number];

export const OTHER_FIELDS = [
  "atisLetter", "altimeter", "handoff", "frequency", "delay", "groundStop", "releaseTime",
] as const;
export type OtherField = (typeof OTHER_FIELDS)[number];

export const FIELD_LABELS: Record<Field | OtherField, string> = {
  callsign: "Callsign", types: "Instruction types", destination: "Destination", route: "Route taxiways",
  turns: "Turns", holdShorts: "Hold-shorts", crossings: "Crossings", other: "Other values",
  atisLetter: "ATIS letter", altimeter: "Altimeter", handoff: "Handoff (mode, facility)", frequency: "Frequency",
  delay: "Delay minutes", groundStop: "Ground-stop destination", releaseTime: "Release time",
};

type Values = unknown[];

function extractOther(t: Transmission): Record<OtherField, Values> {
  const ins = t.instructions as Instruction[];
  return {
    atisLetter: ins.flatMap((i) => (i.type === "atis" ? [i.letter] : [])),
    altimeter: ins.flatMap((i) => (i.type === "atis" && i.altimeter !== null ? [i.altimeter] : [])),
    handoff: ins.flatMap((i) => (i.type === "handoff" ? [`${i.mode} ${i.facility}`] : [])),
    frequency: ins.flatMap((i) => (i.type === "handoff" && i.frequency !== null ? [i.frequency] : [])),
    delay: ins.flatMap((i) => (i.type === "expect-delay" ? [i.minutes] : [])),
    groundStop: ins.flatMap((i) => (i.type === "ground-stop" ? [i.destination] : [])),
    releaseTime: ins.flatMap((i) => (i.type === "release-time" ? [i.time] : [])),
  };
}

export function extract(t: Transmission): Record<Field, Values> & { otherParts: Record<OtherField, Values> } {
  const ins = t.instructions as Instruction[];
  const otherParts = extractOther(t);
  return {
    callsign: [t.callsign],
    types: [ins.map((i) => i.type).join(",")],
    destination: ins.flatMap((i) => (i.type === "taxi" ? [i.to] : i.type === "correction" && i.to ? [i.to] : [])),
    route: ins.flatMap((i) => (i.type === "taxi" || (i.type === "correction" && i.via) ? [(i.type === "taxi" ? i.via : i.via!).map((r) => r.taxiway)] : [])),
    turns: ins.flatMap((i) => {
      if (i.type === "taxi") return i.via.filter((r) => r.turn !== null).map((r) => `${r.taxiway}:${r.turn}`);
      if (i.type === "correction") return [...(i.via ?? []).filter((r) => r.turn !== null).map((r) => `${r.taxiway}:${r.turn}`), ...i.turns.map((r) => `${r.taxiway}:${r.turn}`)];
      return [];
    }),
    holdShorts: ins.flatMap((i) => {
      if (i.type === "taxi") return i.holdShort.map((h) => `${h.kind}:${h.name}`);
      if (i.type === "hold-short") return [`${i.target.kind}:${i.target.name}`];
      if (i.type === "correction" && i.holdShort) return i.holdShort.map((h) => `${h.kind}:${h.name}`);
      return [];
    }),
    crossings: ins.flatMap((i) => (i.type === "cross" ? [`${i.runways.join("+")}@${i.at}`] : i.type === "correction" && i.cross ? [`${i.cross.runways.join("+")}@${i.cross.at}`] : [])),
    other: [otherParts],
    otherParts,
  };
}

export interface FieldScore {
  /** null: the field doesn't apply to this line (neither side has it). */
  correct: boolean | null;
}

export interface LineScore {
  valid: boolean;
  exact: boolean;
  /** Exact match without the hold-short folding rule. */
  exactRaw: boolean;
  /** The folding rule changed the model's command. */
  normalizationChanged: boolean;
  fields: Record<Field, boolean | null>;
  other: Record<OtherField, boolean | null>;
}

function hasAny(v: Values): boolean {
  if (v.length === 0) return false;
  if (v.length === 1 && typeof v[0] === "object" && v[0] !== null && !Array.isArray(v[0])) {
    return Object.values(v[0] as Record<string, Values>).some((x) => x.length > 0);
  }
  return true;
}

export function scoreLine(expected: Transmission, got: Transmission | null): LineScore {
  const exp = extract(normalizeCommand(expected));
  if (got === null) {
    const fields = Object.fromEntries(FIELDS.map((f) => [f, hasAny(exp[f]) ? false : null])) as Record<Field, boolean | null>;
    const other = Object.fromEntries(OTHER_FIELDS.map((f) => [f, exp.otherParts[f].length ? false : null])) as Record<OtherField, boolean | null>;
    return { valid: false, exact: false, exactRaw: false, normalizationChanged: false, fields, other };
  }
  const norm = normalizeCommand(got);
  const g = extract(norm);
  const fields = Object.fromEntries(FIELDS.map((f) => {
    if (!hasAny(exp[f]) && !hasAny(g[f])) return [f, null];
    return [f, isDeepStrictEqual(exp[f], g[f])];
  })) as Record<Field, boolean | null>;
  const other = Object.fromEntries(OTHER_FIELDS.map((f) => {
    if (exp.otherParts[f].length === 0 && g.otherParts[f].length === 0) return [f, null];
    return [f, isDeepStrictEqual(exp.otherParts[f], g.otherParts[f])];
  })) as Record<OtherField, boolean | null>;
  return {
    valid: true,
    exact: isDeepStrictEqual(normalizeCommand(expected), norm),
    exactRaw: isDeepStrictEqual(expected, got),
    normalizationChanged: !isDeepStrictEqual(norm, got),
    fields,
    other,
  };
}
