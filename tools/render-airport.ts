// Renders an airport as a self-contained, zoomable map sheet for answering data questions:
// `npm run render-airport -- <ID>` → dist/maps/<ID>.html (dist/ is gitignored).
//
// It draws the loaded airport (data/airports/<ID>.json plus <ID>.overrides.json, merged by
// src/airport/load.ts): runways, taxiways and ramp lanes with their names, closed segments,
// hold lines with their ids and protected runways, gates, aprons and buildings, and anything
// curated (ramp handoffs, exits, pads, departure lines). Node and edge ids show on hover, and
// the search box finds any id or name. Validation issues are listed and highlight their items.
//
// If data/airports/raw/<ID>.overpass.json exists, it also overlays OSM context the format
// can't hold yet (non-movement boundary marks, stands that aren't gates, OSM hold refs), by
// re-running the importer's convert step on that file. It's a debug view, not task 1.7's map.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { edgePolyline, indexAirport } from '../src/airport/graph.ts';
import { AirportLoadError, loadAirport } from '../src/airport/load.ts';
import type { Airport } from '../src/airport/types.ts';
import { validateAirport } from '../src/airport/validate.ts';
import { convertOverpass, type OsmContext } from './airport-import/convert.ts';
import { importOptions } from './airport-import/import-options.ts';

const ROOT = new URL('../', import.meta.url);

function main(args: string[]): number {
  const id = args[0];
  if (args.length !== 1 || id === undefined || !/^[A-Za-z0-9_-]+$/.test(id)) {
    console.error('usage: npm run render-airport -- <ID>   (e.g. KJFK, TEST)');
    return 2;
  }
  const baseUrl = new URL(`data/airports/${id}.json`, ROOT);
  const overridesUrl = new URL(`data/airports/${id}.overrides.json`, ROOT);
  const rawUrl = new URL(`data/airports/raw/${id}.overpass.json`, ROOT);
  if (!existsSync(baseUrl)) {
    console.error(`no airport file data/airports/${id}.json`);
    return 2;
  }
  const base = JSON.parse(readFileSync(baseUrl, 'utf8')) as unknown;
  const overrides = existsSync(overridesUrl) ? (JSON.parse(readFileSync(overridesUrl, 'utf8')) as unknown) : undefined;
  let airport: Airport;
  try {
    airport = loadAirport(base, overrides);
  } catch (e) {
    if (!(e instanceof AirportLoadError)) throw e;
    console.error(`${id} could not be loaded:`);
    for (const issue of e.issues) console.error(`  - ${issue}`);
    return 1;
  }
  const validation = validateAirport(airport);
  const index = indexAirport(airport);
  // Every edge's full polyline, so the page doesn't need the graph code.
  const lines: Record<string, [number, number][]> = {};
  for (const edge of airport.edges) {
    if (index.nodes.has(edge.from) && index.nodes.has(edge.to)) lines[edge.id] = edgePolyline(index, edge);
  }
  let context: OsmContext | null = null;
  // Same options as the import (check-in points, terminal buildings), so the overlay's "stands
  // that are not gates" match the base file.
  if (existsSync(rawUrl)) context = convertOverpass(id, JSON.parse(readFileSync(rawUrl, 'utf8')) as unknown, importOptions(overrides, `data/airports/${id}.overrides.json`)).context;

  const data = {
    airport,
    lines,
    issues: [...validation.errors, ...validation.warnings],
    context,
    files: [`data/airports/${id}.json`, ...(overrides === undefined ? [] : [`data/airports/${id}.overrides.json`])],
    renderedFrom: context ? `data/airports/raw/${id}.overpass.json` : null,
  };
  const client = readFileSync(new URL('airport-import/map-client.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('airport-import/map.css', import.meta.url), 'utf8');
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(airport.id)} map sheet</title>
<style>${css}</style>
</head>
<body>
<div id="map"><svg id="svg" xmlns="http://www.w3.org/2000/svg"><g id="world"></g></svg></div>
<aside id="panel"></aside>
<div id="hover"></div>
<script type="application/json" id="data">${json}</script>
<script>${client}</script>
</body>
</html>
`;
  const outDir = new URL('dist/maps/', ROOT);
  mkdirSync(outDir, { recursive: true });
  const outUrl = new URL(`${id}.html`, outDir);
  writeFileSync(outUrl, html);
  console.log(`wrote ${fileURLToPath(outUrl)} (${(Buffer.byteLength(html) / 1e6).toFixed(2)} MB)`);
  console.log(`  ${airport.nodes.length} nodes, ${airport.edges.length} edges, ${airport.holdShorts.length} hold-shorts, ${airport.gates.length} gates; ${validation.errors.length} error(s), ${validation.warnings.length} warning(s)${context ? '; OSM context overlay on' : ''}`);
  return 0;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

process.exitCode = main(process.argv.slice(2));
