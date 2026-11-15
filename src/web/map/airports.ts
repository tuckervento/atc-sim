// Which airports the web app can show, how the URL picks one, and loading it.

import { loadAirport } from '../../airport/load.ts';
import type { Airport } from '../../airport/types.ts';

/**
 * The airports the app offers. To add one, put its files in data/airports/ and its id here;
 * nothing else changes.
 */
export const AIRPORT_IDS: readonly string[] = ['TEST', 'KJFK', 'KLGA'];

/** A lazy loader per JSON file, keyed by path, as `import.meta.glob` returns them. */
export type AirportFiles = Record<string, () => Promise<unknown>>;

const DATA_DIR = '../../../data/airports/';

// Vite resolves this at build time into one lazily fetched chunk per file, so only the chosen
// airport is downloaded. Vitest supports it too.
const FILES: AirportFiles = import.meta.glob('../../../data/airports/*.json', { import: 'default' });

/**
 * Loads `data/airports/<id>.json` plus `<id>.overrides.json` if there is one, merged by
 * src/airport/load.ts as the tools do. Throws if the base file is missing, and passes on the
 * loader's AirportLoadError.
 */
export async function loadMapAirport(id: string, files: AirportFiles = FILES): Promise<Airport> {
  const base = files[`${DATA_DIR}${id}.json`];
  if (!base) throw new Error(`data/airports/${id}.json not found`);
  const overrides = files[`${DATA_DIR}${id}.overrides.json`];
  const [baseJson, overridesJson] = await Promise.all([base(), overrides?.()]);
  return loadAirport(baseJson, overridesJson);
}

export type AirportParamResult = { ok: true; id: string } | { ok: false; message: string };

/** Reads `?airport=<ID>` from a URL query string (`location.search`). */
export function parseAirportParam(search: string, known: readonly string[]): AirportParamResult {
  const raw = new URLSearchParams(search).get('airport')?.trim() ?? '';
  const list = `Known airports: ${known.join(', ')}.`;
  if (raw === '') return { ok: false, message: `No airport chosen: add ?airport=<ID> to the URL. ${list}` };
  const id = known.find((k) => k.toUpperCase() === raw.toUpperCase());
  if (id === undefined) return { ok: false, message: `Unknown airport "${raw}". ${list}` };
  return { ok: true, id };
}
