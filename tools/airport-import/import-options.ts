// What the convert step takes from an airport's overrides file: the curated ramp check-in points
// (they set the ramp boundary) and the buildings assigned to a terminal (they count for gate
// matching). Shared by tools/import-airport.ts, which writes the base file from them, and
// tools/render-airport.ts, whose OSM-context overlay must match that import.

import type { ConvertOptions } from './convert.ts';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The convert options an overrides file implies (none for undefined). Throws on malformed entries. */
export function importOptions(overrides: unknown, name: string): ConvertOptions {
  if (overrides === undefined) return {};
  const rampBoundary = checkInNodes(overrides, name);
  const terminalBuildings = terminalAssignments(overrides, name);
  return {
    ...(rampBoundary === undefined ? {} : { rampBoundary }),
    ...(terminalBuildings === undefined ? {} : { terminalBuildings }),
  };
}

/**
 * The check-in nodes curated in an overrides file: the `node` of every ramp handoff it adds or
 * replaces. undefined when it curates none. Throws on a malformed entry (fail loudly).
 */
function checkInNodes(overrides: unknown, name: string): string[] | undefined {
  if (!isObj(overrides)) throw new Error(`${name}: expected an object`);
  const handoffs = overrides.rampHandoffs;
  if (handoffs === undefined) return undefined;
  if (!isObj(handoffs)) throw new Error(`${name}: rampHandoffs: expected an object`);
  const nodes: string[] = [];
  for (const op of ['add', 'replace'] as const) {
    const list = handoffs[op];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new Error(`${name}: rampHandoffs.${op}: expected an array`);
    list.forEach((h: unknown, i) => {
      if (!isObj(h) || typeof h.node !== 'string') throw new Error(`${name}: rampHandoffs.${op}[${i}]: expected an object with a string "node"`);
      nodes.push(h.node);
    });
  }
  return nodes.length === 0 ? undefined : nodes;
}

/**
 * The terminal buildings an overrides file assigns: area id → terminal id, from every
 * `areas.patch` / `areas.replace` item that sets a string `terminal`. undefined when there are
 * none. Throws on a malformed entry.
 */
function terminalAssignments(overrides: unknown, name: string): Record<string, string> | undefined {
  if (!isObj(overrides)) throw new Error(`${name}: expected an object`);
  const areas = overrides.areas;
  if (areas === undefined) return undefined;
  if (!isObj(areas)) throw new Error(`${name}: areas: expected an object`);
  const out: Record<string, string> = {};
  for (const op of ['patch', 'replace'] as const) {
    const list = areas[op];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new Error(`${name}: areas.${op}: expected an array`);
    list.forEach((a: unknown, i) => {
      if (!isObj(a) || typeof a.id !== 'string') throw new Error(`${name}: areas.${op}[${i}]: expected an object with a string "id"`);
      if (a.terminal === undefined || a.terminal === null) return;
      if (typeof a.terminal !== 'string') throw new Error(`${name}: areas.${op}[${i}].terminal: expected a string`);
      out[a.id] = a.terminal;
    });
  }
  return Object.keys(out).length === 0 ? undefined : out;
}
