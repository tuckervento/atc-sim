// Loads an airport: base data plus optional hand-curated overrides, merged, then checked for
// shape. Pure: it takes already-parsed JSON values and never reads files.
//
// Steps:
// 1. Copy both inputs (callers' objects are never mutated or aliased).
// 2. Apply the overrides to the raw base data, by id (semantics below).
// 3. Decode the merged data into an `Airport`, checking every field's type, required fields,
//    allowed values, and rejecting unknown fields (so typos like "closd" fail).
// Any problem in a step throws `AirportLoadError` listing all problems found in that step.
// This checks shape only; `validate.ts` checks meaning (references, connectivity, ...).
//
// Overrides semantics (see also `AirportOverrides` in types.ts):
// - `airport` must equal the base's `id`, and `formatVersion` must be 1.
// - `set` replaces top-level fields (`name`, `reference`, `source`, `defaultConfiguration`);
//   `null` removes one.
// - Per collection (`nodes`, `edges`, ...), four operations, each keyed by item id:
//   - `add`: append new items. The id must not exist in the base.
//   - `replace`: swap in a whole new item, at the same position. The id must exist.
//   - `patch`: shallow-merge fields into the existing item. A field set to `null` is removed;
//     other values (arrays and objects included) replace the field whole. `id` only selects.
//   - `remove`: delete by id. The id must exist. No cascade: anything that still refers to it
//     fails validation, loudly.
// - "Exist" means in the base file. Each id may appear in at most one operation per
//   collection, so the order of operations never matters. Added items go at the end, in
//   the order given.

import {
  COLLECTION_ITEM_NAMES,
  COLLECTION_KEYS,
  FORMAT_VERSION,
  type Airport,
  type Area,
  type AreaKind,
  type CollectionKey,
  type DepartureLine,
  type DepartureLineExit,
  type Edge,
  type EdgeKind,
  type Gate,
  type Hangar,
  type HoldingArea,
  type HoldingAreaKind,
  type HoldShort,
  type HoldShortKind,
  type Node,
  type Point,
  type RampHandoff,
  type RampHandoffUse,
  type Runway,
  type RunwayConfiguration,
  type RunwayEnd,
  type RunwayExit,
  type RunwayRole,
  type RunwayUse,
  type SourceInfo,
  type Terminal,
  type TowerPosition,
} from './types.ts';

/** Thrown when airport data can't be loaded. `issues` lists every problem, one per line. */
export class AirportLoadError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(
      `airport data could not be loaded (${issues.length} problem${issues.length === 1 ? '' : 's'}):\n` +
        issues.map((issue) => `  - ${issue}`).join('\n'),
    );
    this.name = 'AirportLoadError';
    this.issues = issues;
  }
}

/**
 * Merges `overrides` (if given) into `base` and decodes the result.
 * @param base the parsed `<ID>.json`
 * @param overrides the parsed `<ID>.overrides.json`, if there is one
 * @throws AirportLoadError listing every problem found
 */
export function loadAirport(base: unknown, overrides?: unknown): Airport {
  if (!isObject(base)) {
    throw new AirportLoadError([`base file: expected an object, got ${describe(base)}`]);
  }
  const issues: string[] = [];
  let raw = clone(base);
  if (overrides !== undefined) {
    raw = applyOverrides(raw, clone(overrides), issues);
    // Decoding a half-applied merge would only add noise; stop here.
    if (issues.length > 0) throw new AirportLoadError(issues);
  }
  const airport = decodeAirport(raw, issues);
  if (issues.length > 0) throw new AirportLoadError(issues);
  return airport;
}

// ---------------------------------------------------------------------------------------------
// Overrides

type Raw = Record<string, unknown>;

const OVERRIDE_KEYS = ['formatVersion', 'airport', 'description', 'set', ...COLLECTION_KEYS] as const;
const SET_KEYS = ['name', 'reference', 'source', 'defaultConfiguration'] as const;
const OPERATIONS = ['add', 'replace', 'patch', 'remove'] as const;
type Operation = (typeof OPERATIONS)[number];

function applyOverrides(base: Raw, overrides: unknown, issues: string[]): Raw {
  const ov = checkObject(overrides, 'overrides', OVERRIDE_KEYS, issues);
  if (!ov) return base;

  if (ov.formatVersion !== FORMAT_VERSION) {
    issues.push(
      `overrides.formatVersion: expected ${FORMAT_VERSION}, got ${describe(ov.formatVersion)}`,
    );
  }
  if (typeof ov.airport !== 'string') {
    issues.push(`overrides.airport: expected the base airport's id (a string), got ${describe(ov.airport)}`);
  } else if (ov.airport !== base.id) {
    issues.push(
      `overrides.airport: "${ov.airport}" does not match the base file's id ${describe(base.id)}`,
    );
  }
  if (ov.description !== undefined && typeof ov.description !== 'string') {
    issues.push(`overrides.description: expected a string, got ${describe(ov.description)}`);
  }

  const result: Raw = { ...base };

  if (ov.set !== undefined) {
    const set = checkObject(ov.set, 'overrides.set', SET_KEYS, issues);
    if (set) {
      for (const key of SET_KEYS) {
        if (!(key in set)) continue;
        if (set[key] === null) delete result[key];
        else result[key] = set[key];
      }
    }
  }

  for (const key of COLLECTION_KEYS) {
    if (ov[key] === undefined) continue;
    const merged = applyCollection(key, result[key], ov[key], issues);
    if (merged) result[key] = merged;
  }
  return result;
}

function applyCollection(
  key: CollectionKey,
  baseValue: unknown,
  opsValue: unknown,
  issues: string[],
): unknown[] | undefined {
  const where = `overrides.${key}`;
  const item = COLLECTION_ITEM_NAMES[key];
  const ops = checkObject(opsValue, where, OPERATIONS, issues);
  if (!ops) return undefined;
  if (!Array.isArray(baseValue)) {
    issues.push(`${where}: the base file's "${key}" is ${describe(baseValue)}, not an array, so it can't be overridden`);
    return undefined;
  }

  // id -> positions in the base (more than one = duplicate ids in the base).
  const positions = new Map<string, number[]>();
  baseValue.forEach((entry, i) => {
    if (isObject(entry) && typeof entry.id === 'string') {
      const list = positions.get(entry.id) ?? [];
      list.push(i);
      positions.set(entry.id, list);
    }
  });

  const usedBy = new Map<string, Operation>();
  const claim = (id: string, op: Operation, path: string): boolean => {
    const previous = usedBy.get(id);
    if (previous) {
      issues.push(
        `${path}: id "${id}" already appears in ${where}.${previous}; each id may appear in only one operation per collection`,
      );
      return false;
    }
    usedBy.set(id, op);
    return true;
  };
  const existing = (id: string, path: string): number | undefined => {
    const found = positions.get(id);
    if (!found) {
      issues.push(`${path}: no ${item} with id "${id}" in the base file`);
      return undefined;
    }
    if (found.length > 1) {
      issues.push(`${path}: the base file has ${found.length} ${item}s with id "${id}"; fix the duplicates first`);
      return undefined;
    }
    return found[0];
  };

  const replaced = new Map<number, unknown>();
  const removed = new Set<number>();
  const added: unknown[] = [];

  // `remove` lists ids; the other operations list objects with an `id`.
  const removeList = opList(ops.remove, `${where}.remove`, issues);
  removeList.forEach((id, i) => {
    const path = `${where}.remove[${i}]`;
    if (typeof id !== 'string') {
      issues.push(`${path}: expected an id (string), got ${describe(id)}`);
      return;
    }
    if (!claim(id, 'remove', path)) return;
    const at = existing(id, path);
    if (at !== undefined) removed.add(at);
  });

  for (const op of ['replace', 'patch', 'add'] as const) {
    opList(ops[op], `${where}.${op}`, issues).forEach((entry, i) => {
      const path = `${where}.${op}[${i}]`;
      if (!isObject(entry) || typeof entry.id !== 'string') {
        issues.push(`${path}: expected an object with a string "id", got ${describe(entry)}`);
        return;
      }
      const id = entry.id;
      if (!claim(id, op, path)) return;
      if (op === 'add') {
        if (positions.has(id)) {
          issues.push(`${path}: a ${item} with id "${id}" already exists in the base file; use replace or patch`);
        } else {
          added.push(entry);
        }
        return;
      }
      const at = existing(id, path);
      if (at === undefined) return;
      if (op === 'replace') {
        replaced.set(at, entry);
      } else {
        const patched: Raw = { ...(baseValue[at] as Raw) };
        for (const [field, value] of Object.entries(entry)) {
          if (field === 'id') continue;
          if (value === null) delete patched[field];
          else patched[field] = value;
        }
        replaced.set(at, patched);
      }
    });
  }

  const merged: unknown[] = [];
  baseValue.forEach((entry, i) => {
    if (removed.has(i)) return;
    merged.push(replaced.has(i) ? replaced.get(i) : entry);
  });
  merged.push(...added);
  return merged;
}

function opList(value: unknown, path: string, issues: string[]): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push(`${path}: expected an array, got ${describe(value)}`);
    return [];
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// Decoding

const AIRPORT_KEYS = ['formatVersion', 'id', 'name', 'reference', 'source', 'defaultConfiguration', ...COLLECTION_KEYS] as const;
const EDGE_KINDS: readonly EdgeKind[] = ['runway', 'taxiway', 'rampLane'];
const HOLD_SHORT_KINDS: readonly HoldShortKind[] = ['runway', 'ils', 'lahso', 'intermediate'];
const RAMP_HANDOFF_USES: readonly RampHandoffUse[] = ['departures', 'arrivals', 'both'];
const HOLDING_AREA_KINDS: readonly HoldingAreaKind[] = ['pad', 'penaltyBox', 'hardstand'];
const RUNWAY_ROLES: readonly RunwayRole[] = ['arrivals', 'departures'];
const AREA_KINDS: readonly AreaKind[] = ['apron', 'terminalBuilding', 'building'];

function decodeAirport(raw: Raw, issues: string[]): Airport {
  const f = new Fields(raw, 'airport', issues);
  f.checkKeys(AIRPORT_KEYS);
  if (raw.formatVersion !== FORMAT_VERSION) {
    issues.push(
      `airport.formatVersion: expected ${FORMAT_VERSION}, got ${describe(raw.formatVersion)} (this code reads format version ${FORMAT_VERSION} only)`,
    );
  }
  const refFields = f.object('reference', ['lat', 'lon']);
  const reference = {
    lat: refFields ? refFields.num('lat', { min: -90, max: 90 }) : 0,
    lon: refFields ? refFields.num('lon', { min: -180, max: 180 }) : 0,
  };
  const sourceFields = f.optObject('source', ['description', 'license']);
  let source: SourceInfo | undefined;
  if (sourceFields) {
    source = { description: sourceFields.str('description') };
    const license = sourceFields.optStr('license');
    if (license !== undefined) source.license = license;
  }

  const airport: Airport = {
    formatVersion: FORMAT_VERSION,
    id: f.str('id'),
    name: f.str('name'),
    reference,
    nodes: f.list('nodes', decodeNode),
    edges: f.list('edges', decodeEdge),
    runways: f.list('runways', decodeRunway),
    runwayExits: f.list('runwayExits', decodeRunwayExit),
    holdShorts: f.list('holdShorts', decodeHoldShort),
    rampHandoffs: f.list('rampHandoffs', decodeRampHandoff),
    terminals: f.list('terminals', decodeTerminal),
    gates: f.list('gates', decodeGate),
    holdingAreas: f.list('holdingAreas', decodeHoldingArea),
    hangars: f.list('hangars', decodeHangar),
    departureLines: f.list('departureLines', decodeDepartureLine),
    configurations: f.list('configurations', decodeConfiguration),
    towerPositions: f.list('towerPositions', decodeTowerPosition),
    areas: f.list('areas', decodeArea),
  };
  if (source) airport.source = source;
  const defaultConfiguration = f.optStr('defaultConfiguration');
  if (defaultConfiguration !== undefined) airport.defaultConfiguration = defaultConfiguration;
  return airport;
}

function decodeNode(f: Fields): Node {
  f.checkKeys(['id', 'x', 'y']);
  return { id: f.str('id'), x: f.num('x'), y: f.num('y') };
}

function decodeEdge(f: Fields): Edge {
  f.checkKeys(['id', 'kind', 'from', 'to', 'name', 'runway', 'points', 'widthM', 'closed']);
  const edge: Edge = {
    id: f.str('id'),
    kind: f.oneOf('kind', EDGE_KINDS),
    from: f.str('from'),
    to: f.str('to'),
  };
  setIfDefined(edge, 'name', f.optStr('name'));
  setIfDefined(edge, 'runway', f.optStr('runway'));
  setIfDefined(edge, 'points', f.optPoints('points'));
  setIfDefined(edge, 'widthM', f.optNum('widthM', { exclusiveMin: 0 }));
  const closed = f.optObject('closed', ['reason']);
  if (closed) edge.closed = { reason: closed.str('reason') };
  return edge;
}

function decodeRunway(f: Fields): Runway {
  f.checkKeys(['id', 'ends', 'widthM', 'towerPosition']);
  const ends = f.list('ends', decodeRunwayEnd);
  const [end0, end1] = ends;
  if (ends.length !== 2 && f.has('ends')) {
    f.issue('ends', `expected exactly 2 runway ends, got ${ends.length}`);
  }
  const placeholder: RunwayEnd = { designator: '', node: '' };
  const runway: Runway = {
    id: f.str('id'),
    ends: [end0 ?? placeholder, end1 ?? placeholder],
    widthM: f.num('widthM', { exclusiveMin: 0 }),
  };
  setIfDefined(runway, 'towerPosition', f.optStr('towerPosition'));
  return runway;
}

function decodeRunwayEnd(f: Fields): RunwayEnd {
  f.checkKeys(['designator', 'node', 'displacedThresholdM']);
  const end: RunwayEnd = { designator: f.str('designator'), node: f.str('node') };
  setIfDefined(end, 'displacedThresholdM', f.optNum('displacedThresholdM', { min: 0 }));
  return end;
}

function decodeRunwayExit(f: Fields): RunwayExit {
  f.checkKeys(['id', 'runwayEnd', 'taxiway', 'node', 'edge']);
  const exit: RunwayExit = { id: f.str('id'), runwayEnd: f.str('runwayEnd'), node: f.str('node'), edge: f.str('edge') };
  setIfDefined(exit, 'taxiway', f.optStr('taxiway'));
  return exit;
}

function decodeHoldShort(f: Fields): HoldShort {
  f.checkKeys(['id', 'kind', 'runways', 'node', 'towardEdge']);
  return {
    id: f.str('id'),
    kind: f.oneOf('kind', HOLD_SHORT_KINDS),
    runways: f.strArray('runways'),
    node: f.str('node'),
    towardEdge: f.str('towardEdge'),
  };
}

function decodeRampHandoff(f: Fields): RampHandoff {
  f.checkKeys(['id', 'name', 'node', 'use', 'terminals']);
  const handoff: RampHandoff = {
    id: f.str('id'),
    name: f.str('name'),
    node: f.str('node'),
    use: f.oneOf('use', RAMP_HANDOFF_USES),
  };
  setIfDefined(handoff, 'terminals', f.optStrArray('terminals'));
  return handoff;
}

function decodeTerminal(f: Fields): Terminal {
  f.checkKeys(['id', 'name', 'airlines']);
  return { id: f.str('id'), name: f.str('name'), airlines: f.strArray('airlines') };
}

function decodeGate(f: Fields): Gate {
  f.checkKeys(['id', 'name', 'terminal', 'node', 'headingDeg', 'airlines']);
  const gate: Gate = {
    id: f.str('id'),
    name: f.str('name'),
    terminal: f.str('terminal'),
    node: f.str('node'),
  };
  setIfDefined(gate, 'headingDeg', f.optNum('headingDeg', { min: 0, exclusiveMax: 360 }));
  setIfDefined(gate, 'airlines', f.optStrArray('airlines'));
  return gate;
}

function decodeHoldingArea(f: Fields): HoldingArea {
  f.checkKeys(['id', 'name', 'kind', 'spokenNames', 'entrances', 'spots', 'outline']);
  const area: HoldingArea = {
    id: f.str('id'),
    name: f.str('name'),
    kind: f.oneOf('kind', HOLDING_AREA_KINDS),
    spots: f.strArray('spots'),
  };
  setIfDefined(area, 'spokenNames', f.optStrArray('spokenNames'));
  setIfDefined(area, 'entrances', f.optStrArray('entrances'));
  setIfDefined(area, 'outline', f.optPoints('outline'));
  return area;
}

function decodeHangar(f: Fields): Hangar {
  f.checkKeys(['id', 'name', 'airlines', 'spots', 'outline']);
  const hangar: Hangar = { id: f.str('id'), name: f.str('name'), airlines: f.strArray('airlines'), spots: f.strArray('spots') };
  setIfDefined(hangar, 'outline', f.optPoints('outline'));
  return hangar;
}

function decodeDepartureLine(f: Fields): DepartureLine {
  f.checkKeys(['id', 'runwayEnd', 'holdShort', 'edges', 'exits']);
  return {
    id: f.str('id'),
    runwayEnd: f.str('runwayEnd'),
    holdShort: f.str('holdShort'),
    edges: f.strArray('edges'),
    exits: f.list('exits', decodeDepartureLineExit),
  };
}

function decodeDepartureLineExit(f: Fields): DepartureLineExit {
  f.checkKeys(['taxiway', 'node', 'edge']);
  return { taxiway: f.str('taxiway'), node: f.str('node'), edge: f.str('edge') };
}

function decodeConfiguration(f: Fields): RunwayConfiguration {
  f.checkKeys(['id', 'name', 'runways']);
  return { id: f.str('id'), name: f.str('name'), runways: f.list('runways', decodeRunwayUse) };
}

function decodeRunwayUse(f: Fields): RunwayUse {
  f.checkKeys(['end', 'roles', 'arrivalExits']);
  const use: RunwayUse = { end: f.str('end'), roles: f.oneOfArray('roles', RUNWAY_ROLES) };
  setIfDefined(use, 'arrivalExits', f.optStrArray('arrivalExits'));
  return use;
}

function decodeTowerPosition(f: Fields): TowerPosition {
  f.checkKeys(['id', 'name', 'frequency']);
  return { id: f.str('id'), name: f.str('name'), frequency: f.str('frequency') };
}

function decodeArea(f: Fields): Area {
  f.checkKeys(['id', 'kind', 'name', 'terminal', 'outline']);
  const area: Area = { id: f.str('id'), kind: f.oneOf('kind', AREA_KINDS), outline: f.points('outline') };
  setIfDefined(area, 'name', f.optStr('name'));
  setIfDefined(area, 'terminal', f.optStr('terminal'));
  return area;
}

// ---------------------------------------------------------------------------------------------
// Field readers. Each records a problem and returns a placeholder on bad input; the caller
// throws if any problem was recorded, so placeholders never escape.

interface NumRange {
  min?: number;
  max?: number;
  exclusiveMin?: number;
  exclusiveMax?: number;
}

class Fields {
  readonly raw: Raw;
  readonly path: string;
  readonly issues: string[];

  constructor(raw: Raw, path: string, issues: string[]) {
    this.raw = raw;
    this.path = path;
    this.issues = issues;
  }

  issue(key: string, message: string): void {
    this.issues.push(`${this.path}.${key}: ${message}`);
  }

  has(key: string): boolean {
    return this.raw[key] !== undefined;
  }

  checkKeys(allowed: readonly string[]): void {
    for (const key of Object.keys(this.raw)) {
      if (!allowed.includes(key)) {
        this.issues.push(`${this.path}: unknown field "${key}" (allowed: ${allowed.join(', ')})`);
      }
    }
  }

  private missing(key: string, what: string): void {
    this.issue(key, `missing (required ${what})`);
  }

  str(key: string): string {
    const v = this.raw[key];
    if (v === undefined) {
      this.missing(key, 'string');
      return '';
    }
    return this.checkStr(key, v);
  }

  optStr(key: string): string | undefined {
    const v = this.raw[key];
    return v === undefined ? undefined : this.checkStr(key, v);
  }

  private checkStr(key: string, v: unknown): string {
    if (typeof v !== 'string' || v.length === 0) {
      this.issue(key, `expected a non-empty string, got ${describe(v)}`);
      return '';
    }
    return v;
  }

  num(key: string, range: NumRange = {}): number {
    const v = this.raw[key];
    if (v === undefined) {
      this.missing(key, 'number');
      return 0;
    }
    return this.checkNum(key, v, range);
  }

  optNum(key: string, range: NumRange = {}): number | undefined {
    const v = this.raw[key];
    return v === undefined ? undefined : this.checkNum(key, v, range);
  }

  private checkNum(key: string, v: unknown, range: NumRange): number {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.issue(key, `expected a finite number, got ${describe(v)}`);
      return 0;
    }
    const { min, max, exclusiveMin, exclusiveMax } = range;
    if (
      (min !== undefined && v < min) ||
      (max !== undefined && v > max) ||
      (exclusiveMin !== undefined && v <= exclusiveMin) ||
      (exclusiveMax !== undefined && v >= exclusiveMax)
    ) {
      const bounds = [
        min !== undefined ? `>= ${min}` : '',
        exclusiveMin !== undefined ? `> ${exclusiveMin}` : '',
        max !== undefined ? `<= ${max}` : '',
        exclusiveMax !== undefined ? `< ${exclusiveMax}` : '',
      ].filter(Boolean);
      this.issue(key, `expected a number ${bounds.join(' and ')}, got ${v}`);
    }
    return v;
  }

  oneOf<T extends string>(key: string, values: readonly T[]): T {
    const v = this.raw[key];
    const fallback = values[0] as T;
    if (v === undefined) {
      this.missing(key, `one of ${values.map((x) => `"${x}"`).join(', ')}`);
      return fallback;
    }
    if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
      this.issue(key, `expected one of ${values.map((x) => `"${x}"`).join(', ')}, got ${describe(v)}`);
      return fallback;
    }
    return v as T;
  }

  oneOfArray<T extends string>(key: string, values: readonly T[]): T[] {
    return this.strArray(key).filter((v, i): v is T => {
      if ((values as readonly string[]).includes(v)) return true;
      this.issue(`${key}[${i}]`, `expected one of ${values.map((x) => `"${x}"`).join(', ')}, got "${v}"`);
      return false;
    });
  }

  strArray(key: string): string[] {
    const v = this.raw[key];
    if (v === undefined) {
      this.missing(key, 'array of strings');
      return [];
    }
    return this.checkStrArray(key, v);
  }

  optStrArray(key: string): string[] | undefined {
    const v = this.raw[key];
    return v === undefined ? undefined : this.checkStrArray(key, v);
  }

  private checkStrArray(key: string, v: unknown): string[] {
    if (!Array.isArray(v)) {
      this.issue(key, `expected an array of strings, got ${describe(v)}`);
      return [];
    }
    const out: string[] = [];
    v.forEach((item, i) => {
      if (typeof item !== 'string' || item.length === 0) {
        this.issue(`${key}[${i}]`, `expected a non-empty string, got ${describe(item)}`);
      } else {
        out.push(item);
      }
    });
    return out;
  }

  points(key: string): Point[] {
    const v = this.raw[key];
    if (v === undefined) {
      this.missing(key, 'array of [x, y] points');
      return [];
    }
    return this.checkPoints(key, v);
  }

  optPoints(key: string): Point[] | undefined {
    const v = this.raw[key];
    return v === undefined ? undefined : this.checkPoints(key, v);
  }

  private checkPoints(key: string, v: unknown): Point[] {
    if (!Array.isArray(v)) {
      this.issue(key, `expected an array of [x, y] points, got ${describe(v)}`);
      return [];
    }
    const out: Point[] = [];
    v.forEach((p, i) => {
      if (
        Array.isArray(p) &&
        p.length === 2 &&
        typeof p[0] === 'number' &&
        typeof p[1] === 'number' &&
        Number.isFinite(p[0]) &&
        Number.isFinite(p[1])
      ) {
        out.push([p[0], p[1]]);
      } else {
        this.issue(`${key}[${i}]`, `expected an [x, y] pair of finite numbers, got ${describe(p)}`);
      }
    });
    return out;
  }

  object(key: string, allowed: readonly string[]): Fields | undefined {
    const v = this.raw[key];
    if (v === undefined) {
      this.missing(key, 'object');
      return undefined;
    }
    return this.checkObj(key, v, allowed);
  }

  optObject(key: string, allowed: readonly string[]): Fields | undefined {
    const v = this.raw[key];
    return v === undefined ? undefined : this.checkObj(key, v, allowed);
  }

  private checkObj(key: string, v: unknown, allowed: readonly string[]): Fields | undefined {
    const o = checkObject(v, `${this.path}.${key}`, allowed, this.issues);
    return o ? new Fields(o, `${this.path}.${key}`, this.issues) : undefined;
  }

  /** Decodes an array of objects. Item paths include the item's id when it has one. */
  list<T>(key: string, decode: (f: Fields) => T): T[] {
    const v = this.raw[key];
    if (v === undefined) {
      this.missing(key, 'array (may be empty)');
      return [];
    }
    if (!Array.isArray(v)) {
      this.issue(key, `expected an array, got ${describe(v)}`);
      return [];
    }
    const out: T[] = [];
    v.forEach((item, i) => {
      const id = isObject(item) && typeof item.id === 'string' ? ` ("${item.id}")` : '';
      const path = `${this.path === 'airport' ? '' : `${this.path}.`}${key}[${i}]${id}`;
      if (!isObject(item)) {
        this.issues.push(`${path}: expected an object, got ${describe(item)}`);
        return;
      }
      out.push(decode(new Fields(item, path, this.issues)));
    });
    return out;
  }
}

/** Checks `v` is a plain object whose keys are all in `allowed`. */
function checkObject(v: unknown, path: string, allowed: readonly string[], issues: string[]): Raw | undefined {
  if (!isObject(v)) {
    issues.push(`${path}: expected an object, got ${describe(v)}`);
    return undefined;
  }
  for (const key of Object.keys(v)) {
    if (!allowed.includes(key)) {
      issues.push(`${path}: unknown field "${key}" (allowed: ${allowed.join(', ')})`);
    }
  }
  return v;
}

function setIfDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

function isObject(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'nothing';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'string') return v.length > 40 ? `"${v.slice(0, 40)}…"` : `"${v}"`;
  if (typeof v === 'object') return 'an object';
  return String(v);
}
