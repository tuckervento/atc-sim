// Parser for the terse typed-command syntax, e.g. `DAL4 taxi 31L via A R:KE hs B`.
// It produces the command objects in `commands.ts`. The syntax reference is
// `docs/terse-syntax.md`.
//
// API: `parseTerse(input)` returns `{ ok: true, command }` or `{ ok: false, error }`. It never
// throws on bad input; an exception escaping it is a bug in this file. The error carries a
// specific message (e.g. "expected runway after 'cross', got 'KE'") and the character offset
// of the offending token.
//
// It is airport-agnostic: it checks the shape of names, runways, times and frequencies, not
// whether they exist at an airport.

import type {
  Command,
  Correction,
  Destination,
  HoldShortTarget,
  Instruction,
  RouteItem,
  Turn,
  TurnFix,
} from './commands.ts';

export interface ParseError {
  message: string;
  /** 0-based character offset in the input of the offending token; the input length at end. */
  offset: number;
}

export type ParseResult = { ok: true; command: Command } | { ok: false; error: ParseError };

export function parseTerse(input: string): ParseResult {
  try {
    return { ok: true, command: parseCommand(new Cursor(input)) };
  } catch (e) {
    if (e instanceof TerseError) {
      return { ok: false, error: { message: e.message, offset: e.offset } };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Tokens

interface Token {
  /** As typed. */
  text: string;
  offset: number;
}

/** Thrown inside the parser only; `parseTerse` turns it into a ParseError. */
class TerseError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(message);
    this.offset = offset;
  }
}

/** Words that start an instruction. */
const INSTRUCTION_WORDS = new Set([
  'taxi',
  'hs',
  'hold',
  'continue',
  'cross',
  'monitor',
  'contact',
  'neg',
  'atis',
  'say-again',
  'ground-stop',
  'release',
  'hold-for-release',
  'delay',
]);

/** Every reserved word. None can be a bare name; write `#VIA` for a name spelled like one. */
const KEYWORDS = new Set([
  ...INSTRUCTION_WORDS,
  'request-crossing',
  'via',
  'at',
  'to',
  'turn',
  'alt',
  'tower',
  'ramp',
  'pad',
  'penalty',
]);

const CORRECTION_PARTS = ['to', 'via', 'turn', 'hs', 'cross'] as const;
type CorrectionPart = (typeof CORRECTION_PARTS)[number];

const NAME = /^[A-Z][A-Z0-9]*$/i;
const ESCAPED_NAME = /^#([A-Z0-9]+)$/i;
const RUNWAY = /^(\d{1,2})([LCR]?)$/i;
const TURN_PREFIX = /^([^:]*):(.*)$/;

class Cursor {
  readonly tokens: Token[];
  readonly end: number;
  private pos = 0;
  /** The last token consumed, for "after 'X'" in messages. */
  private last: Token | undefined;

  constructor(input: string) {
    this.tokens = [];
    for (const m of input.matchAll(/,|[^\s,]+/g)) {
      this.tokens.push({ text: m[0], offset: m.index });
    }
    this.end = input.length;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token | undefined {
    const tok = this.tokens[this.pos];
    if (tok !== undefined) {
      this.pos += 1;
      this.last = tok;
    }
    return tok;
  }

  /** Text of the last consumed token, for messages. */
  lastText(): string {
    return this.last === undefined ? '' : this.last.text;
  }

  fail(message: string, tok: Token | undefined): never {
    throw new TerseError(message, tok === undefined ? this.end : tok.offset);
  }
}

function keyword(tok: Token | undefined): string | null {
  if (tok === undefined) return null;
  const lower = tok.text.toLowerCase();
  return KEYWORDS.has(lower) ? lower : null;
}

function isComma(tok: Token | undefined): boolean {
  return tok !== undefined && tok.text === ',';
}

/** True if the token can't continue a list of names: end, comma or keyword. */
function endsList(tok: Token | undefined): boolean {
  return tok === undefined || isComma(tok) || keyword(tok) !== null;
}

/** A capture group that the pattern always fills; throws (a bug here) if it didn't. */
function group(m: RegExpExecArray, i: number): string {
  const g = m[i];
  if (g === undefined) throw new Error(`terse: capture group ${i} missing for '${m[0]}'`);
  return g;
}

function startsWithDigit(text: string): boolean {
  return /^\d/.test(text);
}

function got(tok: Token | undefined): string {
  return tok === undefined ? 'end of input' : `'${tok.text}'`;
}

// ---------------------------------------------------------------------------------------------
// Command level

function parseCommand(c: Cursor): Command {
  const first = c.next();
  if (first === undefined) c.fail('empty command: expected a callsign (e.g. DAL4)', undefined);

  if (first.text === '?') {
    const tok = c.next();
    if (keyword(tok) !== 'say-again') {
      c.fail(`only 'say-again' can be addressed to an unknown station '?', got ${got(tok)}`, tok);
    }
    const after = c.peek();
    if (after !== undefined) {
      c.fail(`only 'say-again' can be addressed to an unknown station '?', got ${got(after)}`, after);
    }
    return { type: 'transmission', callsign: null, instructions: [{ type: 'say-again' }] };
  }

  const callsign = parseCallsign(c, first);

  if (keyword(c.peek()) === 'request-crossing') {
    c.next();
    let runway: string | null = null;
    const tok = c.peek();
    if (tok !== undefined && !isComma(tok)) runway = parseRunway(c, c.next(), 'request-crossing');
    const after = c.peek();
    if (after !== undefined) {
      c.fail(
        `'request-crossing' is a key-press action, not a radio call; it can't be combined with other input, got ${got(after)}`,
        after,
      );
    }
    return { type: 'crossing-request', callsign, runway };
  }

  const instructions: Instruction[] = [];
  for (;;) {
    instructions.push(...parseInstruction(c));
    const tok = c.peek();
    if (tok === undefined) break;
    if (isComma(tok)) {
      c.next();
      continue;
    }
    const kw = keyword(tok);
    if (kw !== null && (INSTRUCTION_WORDS.has(kw) || kw === 'request-crossing')) {
      c.fail(`expected ',' before '${tok.text}' (separate instructions with commas)`, tok);
    }
    c.fail(`unexpected ${got(tok)} after '${c.lastText()}'`, tok);
  }
  return { type: 'transmission', callsign, instructions };
}

function parseCallsign(c: Cursor, tok: Token): string {
  const text = tok.text;
  if (keyword(tok) !== null || !NAME.test(text) || !/\d/.test(text)) {
    c.fail(`expected callsign (e.g. DAL4), got '${text}'`, tok);
  }
  return text.toUpperCase();
}

/** One instruction clause. `hs` with several targets yields one HoldShort per target. */
function parseInstruction(c: Cursor): Instruction[] {
  const after = c.lastText();
  const tok = c.next();
  const kw = keyword(tok);
  switch (kw) {
    case 'taxi':
      return [parseTaxi(c)];
    case 'hs':
      return parseTargets(c, 'hs').map((target) => ({ type: 'hold-short', target }));
    case 'hold':
      return [{ type: 'hold-position' }];
    case 'continue':
      return [{ type: 'continue' }];
    case 'cross':
      return [{ type: 'cross', ...parseCrossBody(c) }];
    case 'monitor':
    case 'contact':
      return [parseHandoff(c, kw)];
    case 'neg':
      return [parseCorrection(c)];
    case 'atis':
      return [parseAtis(c)];
    case 'say-again':
      return [{ type: 'say-again' }];
    case 'ground-stop':
      return [{ type: 'ground-stop', destination: parseName(c, c.next(), 'destination', 'ground-stop') }];
    case 'release':
      return [{ type: 'release-time', time: parseTime(c, c.next()) }];
    case 'hold-for-release':
      return [{ type: 'hold-for-release' }];
    case 'delay':
      return [{ type: 'expect-delay', minutes: parseMinutes(c, c.next()) }];
    case 'request-crossing':
      return c.fail(
        `'request-crossing' is a key-press action, not a radio call; it can't be combined with other input`,
        tok,
      );
    default:
      return c.fail(`expected an instruction after '${after}', got ${got(tok)}`, tok);
  }
}

// ---------------------------------------------------------------------------------------------
// Instructions

function parseTaxi(c: Cursor): Instruction {
  const to = parseDestination(c, 'taxi');
  const viaTok = c.peek();
  if (keyword(viaTok) !== 'via') {
    c.fail(`expected 'via' after '${c.lastText()}', got ${got(viaTok)}`, viaTok);
  }
  c.next();
  const via = parseRoute(c, 'via');
  let holdShort: HoldShortTarget[] = [];
  if (keyword(c.peek()) === 'hs') {
    c.next();
    holdShort = parseTargets(c, 'hs');
    const again = c.peek();
    if (keyword(again) === 'hs') {
      c.fail(`duplicate 'hs' in taxi clearance; list every hold-short after one 'hs' (e.g. 'hs B 31R')`, again);
    }
  }
  return { type: 'taxi', to, via, holdShort };
}

function parseDestination(c: Cursor, after: string): Destination {
  const tok = c.next();
  const kw = keyword(tok);
  if (kw === 'ramp' || kw === 'pad' || kw === 'penalty') {
    const name = endsList(c.peek()) ? null : parseName(c, c.next(), `${kw} name`, kw);
    if (kw === 'ramp') return { kind: 'ramp', name };
    if (kw === 'pad') return { kind: 'pad', name };
    return { kind: 'penalty-box', name };
  }
  if (tok !== undefined && startsWithDigit(tok.text)) {
    return { kind: 'runway', name: parseRunway(c, tok, after) };
  }
  return c.fail(`expected runway, 'ramp', 'pad' or 'penalty' after '${after}', got ${got(tok)}`, tok);
}

/** One or more route items, up to the next keyword, comma or end. */
function parseRoute(c: Cursor, after: string): RouteItem[] {
  const items: RouteItem[] = [parseRouteItem(c, c.next(), after)];
  while (!endsList(c.peek())) {
    const prev = c.lastText();
    items.push(parseRouteItem(c, c.next(), prev));
  }
  return items;
}

function parseRouteItem(c: Cursor, tok: Token | undefined, after: string): RouteItem {
  const split = tok === undefined ? null : splitTurn(c, tok);
  if (split === null) return { taxiway: parseName(c, tok, 'taxiway', after), turn: null };
  return { taxiway: parseName(c, split.rest, 'taxiway', `${split.prefix}:`), turn: split.turn };
}

/** Splits `L:KE` / `R:KE`. null if the token has no turn prefix. */
function splitTurn(c: Cursor, tok: Token): { turn: Turn; prefix: string; rest: Token } | null {
  const m = TURN_PREFIX.exec(tok.text);
  if (m === null) return null;
  const prefix = group(m, 1);
  const restText = group(m, 2);
  const upper = prefix.toUpperCase();
  if (upper !== 'L' && upper !== 'R') {
    c.fail(`unknown turn '${prefix}:' in '${tok.text}' (use L: or R:)`, tok);
  }
  if (restText === '') c.fail(`expected taxiway after '${prefix}:' in '${tok.text}'`, tok);
  const rest = { text: restText, offset: tok.offset + prefix.length + 1 };
  return { turn: upper === 'L' ? 'left' : 'right', prefix, rest };
}

/** One or more hold-short targets: a bare number is a runway, anything else a taxiway name. */
function parseTargets(c: Cursor, after: string): HoldShortTarget[] {
  const targets: HoldShortTarget[] = [parseTarget(c, c.next(), after)];
  while (!endsList(c.peek())) {
    const prev = c.lastText();
    targets.push(parseTarget(c, c.next(), prev));
  }
  return targets;
}

function parseTarget(c: Cursor, tok: Token | undefined, after: string): HoldShortTarget {
  if (tok !== undefined && startsWithDigit(tok.text)) {
    return { kind: 'runway', name: parseRunway(c, tok, after) };
  }
  return { kind: 'taxiway', name: parseName(c, tok, 'taxiway or runway', after) };
}

/** `<runway>+ [at <taxiway>]`, after 'cross'. */
function parseCrossBody(c: Cursor): { runways: string[]; at: string | null } {
  const runways = [parseRunway(c, c.next(), 'cross')];
  for (;;) {
    const tok = c.peek();
    if (tok !== undefined && startsWithDigit(tok.text)) {
      const prev = c.lastText();
      runways.push(parseRunway(c, c.next(), prev));
      continue;
    }
    if (keyword(tok) === 'at') {
      c.next();
      return { runways, at: parseName(c, c.next(), 'taxiway', 'at') };
    }
    if (!endsList(tok)) {
      c.fail(`expected runway or 'at' after '${c.lastText()}', got ${got(tok)}`, tok);
    }
    return { runways, at: null };
  }
}

function parseHandoff(c: Cursor, mode: 'monitor' | 'contact'): Instruction {
  const tok = c.next();
  const kw = keyword(tok);
  if (kw !== 'tower' && kw !== 'ramp') {
    c.fail(`expected 'tower' or 'ramp' after '${mode}', got ${got(tok)}`, tok);
  }
  let frequency: string | null = null;
  const next = c.peek();
  if (next !== undefined && startsWithDigit(next.text)) {
    frequency = parseFrequency(c, c.next(), kw);
  }
  return { type: 'handoff', mode, facility: kw, frequency };
}

/** `118.0`–`136.975`; trailing zeros dropped: '121.900' → '121.9'. */
function parseFrequency(c: Cursor, tok: Token | undefined, after: string): string {
  const m = tok === undefined ? null : /^(\d{3})\.(\d{1,3})$/.exec(tok.text);
  if (m === null) c.fail(`expected frequency like 119.1 after '${after}', got ${got(tok)}`, tok);
  const mhz = Number(m[1]);
  if (mhz < 118 || mhz > 136) {
    c.fail(`frequency '${tok?.text}' is outside the airband (118.0–136.975)`, tok);
  }
  const decimals = group(m, 2).replace(/0+$/, '');
  return `${m[1]}.${decimals === '' ? '0' : decimals}`;
}

function parseCorrection(c: Cursor): Correction {
  const result: Correction = { type: 'correction', to: null, via: null, turns: [], holdShort: null, cross: null };
  const seen = new Set<CorrectionPart>();
  for (;;) {
    const tok = c.peek();
    const kw = keyword(tok);
    const part = CORRECTION_PARTS.find((p) => p === kw);
    if (part === undefined) break;
    if (seen.has(part)) c.fail(`duplicate '${part}' in correction`, tok);
    seen.add(part);
    c.next();
    switch (part) {
      case 'to':
        result.to = parseDestination(c, 'to');
        break;
      case 'via':
        result.via = parseRoute(c, 'via');
        break;
      case 'turn':
        result.turns = parseTurnFixes(c);
        break;
      case 'hs':
        result.holdShort = parseTargets(c, 'hs');
        break;
      case 'cross':
        result.cross = parseCrossBody(c);
        break;
    }
  }
  if (seen.size === 0) {
    const tok = c.peek();
    c.fail(`expected 'to', 'via', 'turn', 'hs' or 'cross' after 'neg', got ${got(tok)}`, tok);
  }
  if (seen.has('via') && seen.has('turn')) {
    c.fail(`a correction can't have both 'via' and 'turn'; put the turns in the 'via' route`, c.peek());
  }
  return result;
}

/** One or more `L:X` / `R:X` items after 'turn'. */
function parseTurnFixes(c: Cursor): TurnFix[] {
  const fixes: TurnFix[] = [];
  let after = 'turn';
  do {
    const tok = c.next();
    const item = parseRouteItem(c, tok, after);
    if (item.turn === null) {
      c.fail(`expected taxiway with a turn (e.g. R:KE) after '${after}', got ${got(tok)}`, tok);
    }
    fixes.push({ taxiway: item.taxiway, turn: item.turn });
    after = c.lastText();
  } while (!endsList(c.peek()));
  return fixes;
}

function parseAtis(c: Cursor): Instruction {
  const tok = c.next();
  if (tok === undefined || !/^[A-Z]$/i.test(tok.text)) {
    c.fail(`expected ATIS letter (A–Z) after 'atis', got ${got(tok)}`, tok);
  }
  let altimeter: string | null = null;
  if (keyword(c.peek()) === 'alt') {
    c.next();
    const alt = c.next();
    if (alt === undefined || !/^\d{4}$/.test(alt.text)) {
      c.fail(`expected altimeter as four digits (e.g. 2992) after 'alt', got ${got(alt)}`, alt);
    }
    altimeter = alt.text;
  }
  return { type: 'atis', letter: tok.text.toUpperCase(), altimeter };
}

/** `HHMM` or `HH:MM` → 'HH:MM'. */
function parseTime(c: Cursor, tok: Token | undefined): string {
  const m = tok === undefined ? null : /^(\d{2}):?(\d{2})$/.exec(tok.text);
  if (m === null) {
    c.fail(`expected release time as HHMM or HH:MM (e.g. 1452) after 'release', got ${got(tok)}`, tok);
  }
  const hh = group(m, 1);
  const mm = group(m, 2);
  if (Number(hh) > 23) c.fail(`invalid release time '${tok?.text}': hours must be 00–23`, tok);
  if (Number(mm) > 59) c.fail(`invalid release time '${tok?.text}': minutes must be 00–59`, tok);
  return `${hh}:${mm}`;
}

function parseMinutes(c: Cursor, tok: Token | undefined): number {
  if (tok === undefined || !/^\d+$/.test(tok.text)) {
    c.fail(`expected delay in whole minutes after 'delay', got ${got(tok)}`, tok);
  }
  const minutes = Number(tok.text);
  if (minutes < 1) c.fail(`delay must be at least 1 minute, got '${tok.text}'`, tok);
  return minutes;
}

// ---------------------------------------------------------------------------------------------
// Names and runways

/**
 * A name: letters and digits starting with a letter (`KE`, `C1`, `T4`), or `#` and letters and
 * digits (`#13`, for names that start with a digit or are spelled like a keyword). Uppercased.
 * A bare token starting with a digit is never a name, so it can't be confused with a runway.
 */
function parseName(c: Cursor, tok: Token | undefined, what: string, after: string): string {
  if (tok === undefined || isComma(tok) || keyword(tok) !== null) {
    return c.fail(`expected ${what} after '${after}', got ${got(tok)}`, tok);
  }
  const text = tok.text;
  const escaped = ESCAPED_NAME.exec(text);
  if (escaped !== null) return group(escaped, 1).toUpperCase();
  if (NAME.test(text)) return text.toUpperCase();
  if (startsWithDigit(text)) {
    return c.fail(
      `expected ${what} after '${after}', got '${text}' (a bare number is a runway; write a name that starts with a digit as '#${text}')`,
      tok,
    );
  }
  if (TURN_PREFIX.test(text)) {
    return c.fail(`a turn (L:/R:) is only allowed on route items, got '${text}' after '${after}'`, tok);
  }
  return c.fail(`expected ${what} after '${after}', got '${text}'`, tok);
}

/** `31L`, `04l`, `4L`, `13` → '31L', '4L', '4L', '13'. */
function parseRunway(c: Cursor, tok: Token | undefined, after: string): string {
  if (tok === undefined || !startsWithDigit(tok.text)) {
    return c.fail(`expected runway after '${after}', got ${got(tok)}`, tok);
  }
  const m = RUNWAY.exec(tok.text);
  if (m === null) {
    return c.fail(`invalid runway '${tok.text}': expected 1–36 with optional L, C or R (e.g. 31L)`, tok);
  }
  const num = Number(m[1]);
  if (num < 1 || num > 36) {
    c.fail(`invalid runway '${tok.text}': the number must be 1–36`, tok);
  }
  return `${num}${group(m, 2).toUpperCase()}`;
}
