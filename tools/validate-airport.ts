// Validates an airport: `npm run validate-airport -- <ID>` (or `node tools/validate-airport.ts <ID>`).
//
// Reads data/airports/<ID>.json and, if present, data/airports/<ID>.overrides.json, merges
// them with src/airport/load.ts, checks the result with src/airport/validate.ts, and prints a
// summary followed by every error and warning.
// Exit codes: 0 = valid (warnings allowed), 1 = invalid or unloadable, 2 = usage / missing file.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AirportLoadError, loadAirport } from '../src/airport/load.ts';
import type { Airport } from '../src/airport/types.ts';
import { validateAirport, type ValidationIssue } from '../src/airport/validate.ts';

const DATA_DIR = new URL('../data/airports/', import.meta.url);

function main(args: string[]): number {
  const id = args[0];
  if (args.length !== 1 || id === undefined || !/^[A-Za-z0-9_-]+$/.test(id)) {
    console.error('usage: npm run validate-airport -- <ID>   (e.g. TEST, KJFK)');
    console.error(`available: ${availableIds().join(', ') || '(none)'}`);
    return 2;
  }
  const baseName = `data/airports/${id}.json`;
  const overridesName = `data/airports/${id}.overrides.json`;
  const baseUrl = new URL(`${id}.json`, DATA_DIR);
  const overridesUrl = new URL(`${id}.overrides.json`, DATA_DIR);
  if (!existsSync(baseUrl)) {
    console.error(`no airport file ${baseName}`);
    console.error(`available: ${availableIds().join(', ') || '(none)'}`);
    return 2;
  }

  const base = readJson(baseUrl, baseName);
  const overrides = existsSync(overridesUrl) ? readJson(overridesUrl, overridesName) : { ok: true as const, value: undefined };
  if (!base.ok || !overrides.ok) return 1;
  const files = overrides.value === undefined ? baseName : `${baseName} + ${overridesName}`;

  let airport: Airport;
  try {
    airport = loadAirport(base.value, overrides.value);
  } catch (e) {
    if (!(e instanceof AirportLoadError)) throw e;
    console.error(`${id}: could not load ${files}: ${e.issues.length} problem(s)`);
    for (const issue of e.issues) console.error(`  - ${issue}`);
    console.error(`FAILED: ${id} could not be loaded.`);
    return 1;
  }

  if (airport.id !== id) {
    console.error(`${baseName} has id "${airport.id}"; an airport's id must match its file name ("${id}")`);
    console.error(`FAILED: ${id} could not be loaded.`);
    return 1;
  }

  const result = validateAirport(airport);
  console.log(`${airport.id}: ${airport.name}`);
  console.log(`  from ${files}`);
  printSummary(airport);
  printIssues('Errors', result.errors);
  printIssues('Warnings', result.warnings);
  const tally = `${result.errors.length} error(s), ${result.warnings.length} warning(s)`;
  if (result.ok) {
    console.log(`OK: ${airport.id} is valid (${tally}).`);
    return 0;
  }
  console.log(`FAILED: ${airport.id} is invalid (${tally}).`);
  return 1;
}

function readJson(url: URL, name: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(url, 'utf8')) };
  } catch (e) {
    console.error(`could not read ${name} (${fileURLToPath(url)}): ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false };
  }
}

function availableIds(): string[] {
  if (!existsSync(DATA_DIR)) return [];
  return readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.overrides.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

function printSummary(a: Airport): void {
  const names = (kind: string) => [...new Set(a.edges.filter((e) => e.kind === kind && e.name !== undefined).map((e) => e.name as string))].sort();
  const taxiways = names('taxiway');
  const lanes = names('rampLane');
  const closed = a.edges.filter((e) => e.closed).length;
  const lineExits = a.departureLines.reduce((n, l) => n + l.exits.length, 0);
  const rows: [string, number, string][] = [
    ['nodes', a.nodes.length, ''],
    ['edges', a.edges.length, `${countBy(a.edges.map((e) => e.kind))}; ${closed} closed`],
    ['taxiways (named)', taxiways.length, listNames(taxiways)],
    ['ramp lanes (named)', lanes.length, listNames(lanes)],
    ['runways', a.runways.length, a.runways.map((r) => r.id).join(', ')],
    ['runway exits', a.runwayExits.length, ''],
    ['hold-shorts', a.holdShorts.length, countBy(a.holdShorts.map((h) => h.kind))],
    ['ramp handoffs', a.rampHandoffs.length, countBy(a.rampHandoffs.map((h) => h.use))],
    ['terminals', a.terminals.length, a.terminals.map((t) => t.id).join(', ')],
    ['gates', a.gates.length, ''],
    ['holding areas', a.holdingAreas.length, countBy(a.holdingAreas.map((h) => h.kind))],
    ['departure lines', a.departureLines.length, `${lineExits} exits`],
    ['configurations', a.configurations.length, a.configurations.map((c) => (c.id === a.defaultConfiguration ? `${c.id} (default)` : c.id)).join(', ')],
    ['tower positions', a.towerPositions.length, ''],
    ['areas', a.areas.length, countBy(a.areas.map((x) => x.kind))],
  ];
  for (const [label, n, detail] of rows) {
    console.log(`  ${label.padEnd(19)}${String(n).padStart(6)}${detail ? `   ${detail}` : ''}`);
  }
}

function countBy(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${k} ${n}`).join(', ');
}

function listNames(names: string[]): string {
  return names.length <= 40 ? names.join(' ') : `${names.slice(0, 40).join(' ')} … (+${names.length - 40})`;
}

function printIssues(title: string, issues: ValidationIssue[]): void {
  if (issues.length === 0) return;
  console.log(`${title} (${issues.length}):`);
  for (const issue of issues) console.log(`  [${issue.code}] ${issue.message}`);
}

process.exitCode = main(process.argv.slice(2));
