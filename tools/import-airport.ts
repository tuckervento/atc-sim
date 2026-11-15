// Imports an airport from OpenStreetMap: `npm run import-airport -- <ICAO> [--fetch]`.
//
// Two steps (docs/airports/KJFK-notes.md has the mapping and the choices):
// 1. Fetch (only with --fetch): run the research doc's Overpass Query A once and save the
//    response, dated, to data/airports/raw/<ICAO>.overpass.json.
// 2. Convert (always): read that raw file offline and write data/airports/<ICAO>.json.
//    Deterministic: the same raw file gives byte-identical output, and ids derive from OSM
//    ids, so <ICAO>.overrides.json stays valid across re-imports.
// Exit codes: 0 = written, 1 = failed, 2 = usage / missing raw file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { convertOverpass, serializeAirport, type ConvertReport } from './airport-import/convert.ts';
import { datedRaw, fetchOverpass } from './airport-import/overpass.ts';

const DATA_DIR = new URL('../data/airports/', import.meta.url);
const RAW_DIR = new URL('../data/airports/raw/', import.meta.url);

async function main(args: string[]): Promise<number> {
  const flags = args.filter((a) => a.startsWith('--'));
  const ids = args.filter((a) => !a.startsWith('--'));
  const id = ids[0];
  const unknown = flags.filter((f) => f !== '--fetch');
  if (ids.length !== 1 || id === undefined || !/^[A-Z0-9]{4}$/.test(id) || unknown.length > 0) {
    console.error('usage: npm run import-airport -- <ICAO> [--fetch]   (e.g. KJFK)');
    console.error('  --fetch  query Overpass once and save data/airports/raw/<ICAO>.overpass.json first');
    if (unknown.length > 0) console.error(`unknown option(s): ${unknown.join(' ')}`);
    return 2;
  }
  const rawUrl = new URL(`${id}.overpass.json`, RAW_DIR);
  const rawName = `data/airports/raw/${id}.overpass.json`;

  if (flags.includes('--fetch')) {
    console.log(`fetching ${id} from Overpass ...`);
    const { body, record } = await fetchOverpass(id);
    mkdirSync(RAW_DIR, { recursive: true });
    writeFileSync(rawUrl, datedRaw(body, record));
    console.log(`saved ${rawName}: ${record.responseBytes} bytes from Overpass, fetched ${record.fetchedAt}`);
  }

  if (!existsSync(rawUrl)) {
    console.error(`no raw file ${rawName} (${fileURLToPath(rawUrl)}); run with --fetch once to create it`);
    return 2;
  }
  const rawText = readFileSync(rawUrl, 'utf8');
  const { airport, report } = convertOverpass(id, JSON.parse(rawText) as unknown);
  const outName = `data/airports/${id}.json`;
  writeFileSync(new URL(`${id}.json`, DATA_DIR), serializeAirport(airport));
  printReport(outName, rawName, Buffer.byteLength(rawText, 'utf8'), report);
  return 0;
}

function printReport(outName: string, rawName: string, rawBytes: number, report: ConvertReport): void {
  console.log(`read ${rawName} (${(rawBytes / 1e6).toFixed(2)} MB)`);
  console.log(`wrote ${outName}`);
  for (const line of report.lines) console.log(`  ${line}`);
  if (report.warnings.length > 0) {
    console.log(`import warnings (${report.warnings.length}):`);
    for (const w of report.warnings) console.log(`  - ${w}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(`import failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exitCode = 1;
  },
);
