/**
 * Shape check for the model's answer, and a terse renderer.
 *
 * checkShape() decides whether a parsed JSON value is a valid `Transmission` from
 * src/sim/commands.ts: exact keys, types, enums, non-empty lists, name and runway formats,
 * and the correction rules. It returns the first problem as a reason.
 *
 * toTerse() writes a valid Transmission back in terse syntax. It's used to print answers
 * compactly, and as a second check: parseTerse(toTerse(x)) must deep-equal x, so anything
 * the check above lets through that the terse parser wouldn't produce is caught too.
 */
import { isDeepStrictEqual } from "node:util";
import { parseTerse } from "../../../src/sim/terse.ts";
import type {
  Destination, HoldShortTarget, Instruction, RouteItem, Transmission, TurnFix,
} from "../../../src/sim/commands.ts";

type Obj = Record<string, unknown>;

class ShapeError extends Error {}

function fail(path: string, msg: string): never {
  throw new ShapeError(`${path}: ${msg}`);
}

const NAME = /^[A-Z0-9]+$/;
const LETTER_NAME = /^[A-Z][A-Z0-9]*$/;
const RUNWAY = /^([1-9]|[12]\d|3[0-6])[LCR]?$/;
const CALLSIGN = /^[A-Z][A-Z0-9]*$/;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function keys(v: unknown, path: string, expected: string[]): Obj {
  if (!isObj(v)) fail(path, `expected an object, got ${JSON.stringify(v)}`);
  const got = Object.keys(v).sort();
  const want = [...expected].sort();
  if (!isDeepStrictEqual(got, want)) fail(path, `keys ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  return v;
}

function name(v: unknown, path: string): string {
  if (typeof v !== "string" || !NAME.test(v)) fail(path, `expected an uppercase name, got ${JSON.stringify(v)}`);
  return v;
}

function runway(v: unknown, path: string): string {
  if (typeof v !== "string" || !RUNWAY.test(v)) fail(path, `expected a runway like 31L, got ${JSON.stringify(v)}`);
  return v;
}

function nullOr<T>(v: unknown, f: (x: unknown) => T): T | null {
  return v === null ? null : f(v);
}

function list<T>(v: unknown, path: string, f: (x: unknown, p: string) => T, min: number): T[] {
  if (!Array.isArray(v)) fail(path, `expected an array, got ${JSON.stringify(v)}`);
  if (v.length < min) fail(path, `expected at least ${min} item(s)`);
  return v.map((x, i) => f(x, `${path}[${i}]`));
}

function routeItem(v: unknown, path: string): RouteItem {
  const o = keys(v, path, ["taxiway", "turn"]);
  if (o.turn !== null && o.turn !== "left" && o.turn !== "right") fail(`${path}.turn`, `expected left, right or null, got ${JSON.stringify(o.turn)}`);
  return { taxiway: name(o.taxiway, `${path}.taxiway`), turn: o.turn };
}

function target(v: unknown, path: string): HoldShortTarget {
  const o = keys(v, path, ["kind", "name"]);
  if (o.kind === "runway") return { kind: "runway", name: runway(o.name, `${path}.name`) };
  if (o.kind === "taxiway") return { kind: "taxiway", name: name(o.name, `${path}.name`) };
  fail(`${path}.kind`, `expected taxiway or runway, got ${JSON.stringify(o.kind)}`);
}

function destination(v: unknown, path: string): Destination {
  const o = keys(v, path, ["kind", "name"]);
  const n = (x: unknown) => name(x, `${path}.name`);
  switch (o.kind) {
    case "runway": return { kind: "runway", name: runway(o.name, `${path}.name`) };
    case "ramp": return { kind: "ramp", name: nullOr(o.name, n) };
    case "pad": return { kind: "pad", name: nullOr(o.name, n) };
    case "penalty-box": return { kind: "penalty-box", name: nullOr(o.name, n) };
    default: fail(`${path}.kind`, `unknown destination kind ${JSON.stringify(o.kind)}`);
  }
}

function crossPart(o: Obj, path: string): { runways: string[]; at: string | null } {
  return {
    runways: list(o.runways, `${path}.runways`, runway, 1),
    at: nullOr(o.at, (x) => name(x, `${path}.at`)),
  };
}

function instruction(v: unknown, path: string): Instruction {
  if (!isObj(v)) fail(path, `expected an object, got ${JSON.stringify(v)}`);
  const t = v.type;
  switch (t) {
    case "taxi": {
      const o = keys(v, path, ["type", "to", "via", "holdShort"]);
      return { type: "taxi", to: destination(o.to, `${path}.to`), via: list(o.via, `${path}.via`, routeItem, 1), holdShort: list(o.holdShort, `${path}.holdShort`, target, 0) };
    }
    case "hold-short": {
      const o = keys(v, path, ["type", "target"]);
      return { type: "hold-short", target: target(o.target, `${path}.target`) };
    }
    case "hold-position": keys(v, path, ["type"]); return { type: "hold-position" };
    case "continue": keys(v, path, ["type"]); return { type: "continue" };
    case "cross": {
      const o = keys(v, path, ["type", "runways", "at"]);
      return { type: "cross", ...crossPart(o, path) };
    }
    case "handoff": {
      const o = keys(v, path, ["type", "mode", "facility", "frequency"]);
      if (o.mode !== "monitor" && o.mode !== "contact") fail(`${path}.mode`, `got ${JSON.stringify(o.mode)}`);
      if (o.facility !== "tower" && o.facility !== "ramp") fail(`${path}.facility`, `got ${JSON.stringify(o.facility)}`);
      const frequency = nullOr(o.frequency, (x) => {
        if (typeof x !== "string" || !/^1(1[89]|2\d|3[0-6])\.\d{0,2}[1-9]$/.test(x)) fail(`${path}.frequency`, `expected MHz like 119.1, got ${JSON.stringify(x)}`);
        return x;
      });
      return { type: "handoff", mode: o.mode, facility: o.facility, frequency };
    }
    case "correction": {
      const o = keys(v, path, ["type", "to", "via", "turns", "holdShort", "cross"]);
      const to = nullOr(o.to, (x) => destination(x, `${path}.to`));
      const via = nullOr(o.via, (x) => list(x, `${path}.via`, routeItem, 1));
      const turns = list(o.turns, `${path}.turns`, (x, p): TurnFix => {
        const ti = keys(x, p, ["taxiway", "turn"]);
        const turn = ti.turn;
        if (turn !== "left" && turn !== "right") fail(`${p}.turn`, `expected left or right, got ${JSON.stringify(turn)}`);
        return { taxiway: name(ti.taxiway, `${p}.taxiway`), turn };
      }, 0);
      const holdShort = nullOr(o.holdShort, (x) => list(x, `${path}.holdShort`, target, 1));
      const cross = nullOr(o.cross, (x) => crossPart(keys(x, `${path}.cross`, ["runways", "at"]), `${path}.cross`));
      if (to === null && via === null && turns.length === 0 && holdShort === null && cross === null) fail(path, "a correction must give at least one part");
      if (via !== null && turns.length > 0) fail(path, "a correction can't have both via and turns");
      return { type: "correction", to, via, turns, holdShort, cross };
    }
    case "atis": {
      const o = keys(v, path, ["type", "letter", "altimeter"]);
      if (typeof o.letter !== "string" || !/^[A-Z]$/.test(o.letter)) fail(`${path}.letter`, `expected one letter A-Z, got ${JSON.stringify(o.letter)}`);
      const altimeter = nullOr(o.altimeter, (x) => {
        if (typeof x !== "string" || !/^\d{4}$/.test(x)) fail(`${path}.altimeter`, `expected four digits, got ${JSON.stringify(x)}`);
        return x;
      });
      return { type: "atis", letter: o.letter, altimeter };
    }
    case "say-again": keys(v, path, ["type"]); return { type: "say-again" };
    case "ground-stop": {
      const o = keys(v, path, ["type", "destination"]);
      if (typeof o.destination !== "string" || !LETTER_NAME.test(o.destination)) fail(`${path}.destination`, `expected a code like ATL, got ${JSON.stringify(o.destination)}`);
      return { type: "ground-stop", destination: o.destination };
    }
    case "release-time": {
      const o = keys(v, path, ["type", "time"]);
      if (typeof o.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(o.time)) fail(`${path}.time`, `expected HH:MM, got ${JSON.stringify(o.time)}`);
      return { type: "release-time", time: o.time };
    }
    case "hold-for-release": keys(v, path, ["type"]); return { type: "hold-for-release" };
    case "expect-delay": {
      const o = keys(v, path, ["type", "minutes"]);
      if (typeof o.minutes !== "number" || !Number.isInteger(o.minutes) || o.minutes < 1) fail(`${path}.minutes`, `expected a whole number >= 1, got ${JSON.stringify(o.minutes)}`);
      return { type: "expect-delay", minutes: o.minutes };
    }
    default: fail(`${path}.type`, `unknown instruction type ${JSON.stringify(t)}`);
  }
}

/** For the "terse" answer mode: the model's line through parseTerse. */
export function parseTerseAnswer(text: string | null): { parsed: unknown; error: string | null } {
  if (text === null || text.trim() === "") return { parsed: null, error: "no answer text" };
  const r = parseTerse(text.trim());
  if (!r.ok) return { parsed: null, error: `terse answer doesn't parse: ${r.error.message}` };
  if (r.command.type !== "transmission") return { parsed: null, error: `terse answer is a ${r.command.type}, not a transmission` };
  return { parsed: r.command, error: null };
}

export type ShapeResult = { ok: true; command: Transmission; terse: string } | { ok: false; reason: string };

export function checkShape(value: unknown): ShapeResult {
  try {
    const o = keys(value, "$", ["type", "callsign", "instructions"]);
    if (o.type !== "transmission") fail("$.type", `expected "transmission", got ${JSON.stringify(o.type)}`);
    const instructions = list(o.instructions, "$.instructions", instruction, 1);
    let command: Transmission;
    if (o.callsign === null) {
      if (instructions.length !== 1 || instructions[0]!.type !== "say-again") fail("$", "an unknown-station (null callsign) transmission may only contain say-again");
      command = { type: "transmission", callsign: null, instructions: [{ type: "say-again" }] };
    } else {
      if (typeof o.callsign !== "string" || !CALLSIGN.test(o.callsign) || !/\d/.test(o.callsign)) fail("$.callsign", `expected an ICAO callsign like DAL4, got ${JSON.stringify(o.callsign)}`);
      command = { type: "transmission", callsign: o.callsign, instructions };
    }
    const terse = toTerse(command);
    const back = parseTerse(terse);
    if (!back.ok) return { ok: false, reason: `terse round trip: '${terse}' doesn't parse: ${back.error.message}` };
    if (!isDeepStrictEqual(back.command, command)) return { ok: false, reason: `terse round trip: '${terse}' parses to a different object` };
    return { ok: true, command, terse };
  } catch (e) {
    if (e instanceof ShapeError) return { ok: false, reason: e.message };
    throw e;
  }
}

// ---- terse rendering ---------------------------------------------------------------------

const nm = (n: string) => (/^\d/.test(n) ? `#${n}` : n);
const item = (r: RouteItem) => `${r.turn === "left" ? "L:" : r.turn === "right" ? "R:" : ""}${nm(r.taxiway)}`;
const tgt = (t: HoldShortTarget) => (t.kind === "runway" ? t.name : nm(t.name));

function dest(d: Destination): string {
  if (d.kind === "runway") return d.name;
  const word = d.kind === "penalty-box" ? "penalty" : d.kind;
  return d.name === null ? word : `${word} ${nm(d.name)}`;
}

function instrTerse(i: Instruction): string {
  switch (i.type) {
    case "taxi": return `taxi ${dest(i.to)} via ${i.via.map(item).join(" ")}${i.holdShort.length ? ` hs ${i.holdShort.map(tgt).join(" ")}` : ""}`;
    case "hold-short": return `hs ${tgt(i.target)}`;
    case "hold-position": return "hold";
    case "continue": return "continue";
    case "cross": return `cross ${i.runways.join(" ")}${i.at ? ` at ${nm(i.at)}` : ""}`;
    case "handoff": return `${i.mode} ${i.facility}${i.frequency ? ` ${i.frequency}` : ""}`;
    case "correction": {
      const parts: string[] = [];
      if (i.to) parts.push(`to ${dest(i.to)}`);
      if (i.via) parts.push(`via ${i.via.map(item).join(" ")}`);
      if (i.turns.length) parts.push(`turn ${i.turns.map((t) => `${t.turn === "left" ? "L:" : "R:"}${nm(t.taxiway)}`).join(" ")}`);
      if (i.holdShort) parts.push(`hs ${i.holdShort.map(tgt).join(" ")}`);
      if (i.cross) parts.push(`cross ${i.cross.runways.join(" ")}${i.cross.at ? ` at ${nm(i.cross.at)}` : ""}`);
      return `neg ${parts.join(" ")}`;
    }
    case "atis": return `atis ${i.letter}${i.altimeter ? ` alt ${i.altimeter}` : ""}`;
    case "say-again": return "say-again";
    case "ground-stop": return `ground-stop ${nm(i.destination)}`;
    case "release-time": return `release ${i.time}`;
    case "hold-for-release": return "hold-for-release";
    case "expect-delay": return `delay ${i.minutes}`;
  }
}

/**
 * Terse form of a transmission. Adjacent hold-short instructions are written as one `hs`
 * clause (`hs B 4R`), which the parser expands back to one instruction per target.
 */
export function toTerse(t: Transmission): string {
  const chunks: string[] = [];
  let i = 0;
  const ins = t.instructions as Instruction[];
  while (i < ins.length) {
    const cur = ins[i]!;
    if (cur.type === "hold-short") {
      const targets: HoldShortTarget[] = [];
      while (i < ins.length && ins[i]!.type === "hold-short") {
        targets.push((ins[i] as { target: HoldShortTarget }).target);
        i++;
      }
      chunks.push(`hs ${targets.map(tgt).join(" ")}`);
      continue;
    }
    chunks.push(instrTerse(cur));
    i++;
  }
  return `${t.callsign ?? "?"} ${chunks.join(", ")}`;
}
