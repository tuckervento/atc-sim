// The web app's entry: the airport map chosen by `?airport=<ID>` (PLAN 1.7), with mock
// traffic until the sim runs in the browser (1.13).

import { indexAirport } from '../airport/graph.ts';
import { AirportLoadError } from '../airport/load.ts';
import type { Airport } from '../airport/types.ts';
import { AIRPORT_IDS, loadMapAirport, parseAirportParam } from './map/airports.ts';
import { demoAircraft } from './map/demo.ts';
import { mountMap } from './map/map-view.ts';
import { buildScene } from './map/scene.ts';
import { DELAYED_COLOR, RUNWAY_USE_COLOR } from './map/style.ts';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('index.html is missing the #app element');
const root = app;

async function start(): Promise<void> {
  const chosen = parseAirportParam(window.location.search, AIRPORT_IDS);
  if (!chosen.ok) {
    showError(chosen.message, []);
    return;
  }
  let airport: Airport;
  try {
    airport = await loadMapAirport(chosen.id);
  } catch (e) {
    if (e instanceof AirportLoadError) showError(`${chosen.id} could not be loaded.`, e.issues);
    else showError(`${chosen.id} could not be loaded: ${e instanceof Error ? e.message : String(e)}`, []);
    throw e;
  }
  document.title = `${airport.id} map — ATC Ground`;
  const scene = buildScene(airport);
  const aircraft = demoAircraft(airport.id, indexAirport(airport));

  const map = document.createElement('div');
  map.className = 'map';
  root.replaceChildren(map, legend(airport, () => handle.fit()));
  const handle = mountMap(map, scene, aircraft);
}

function legend(airport: Airport, onFit: () => void): HTMLElement {
  const box = el('aside', 'legend');
  box.append(el('h1', '', `${airport.id} · ${airport.name}`));
  const configId = airport.defaultConfiguration ?? airport.configurations[0]?.id;
  const config = airport.configurations.find((c) => c.id === configId);
  box.append(el('p', 'config', config ? config.name : 'No runway configuration in the data'));
  const keys: [string, string][] = [
    [RUNWAY_USE_COLOR.departures, 'Departure (runway and aircraft)'],
    [RUNWAY_USE_COLOR.arrivals, 'Arrival (runway and aircraft)'],
    [DELAYED_COLOR, 'Delayed aircraft; pads and penalty box'],
  ];
  const list = el('ul', '');
  for (const [color, text] of keys) {
    const item = el('li', '');
    const swatch = el('span', 'swatch');
    swatch.style.background = color;
    item.append(swatch, document.createTextNode(text));
    list.append(item);
  }
  box.append(list);
  box.append(el('p', 'hint', 'Drag to pan · wheel to zoom · traffic is a mock'));
  const fit = el('button', '', 'Fit airport');
  fit.addEventListener('click', onFit);
  box.append(fit);
  if (airport.source?.license) box.append(el('p', 'license', airport.source.license));
  return box;
}

function showError(message: string, issues: string[]): void {
  const page = el('main', 'error');
  page.append(el('h1', '', 'Can’t show the map'));
  page.append(el('p', 'message', message));
  if (issues.length > 0) {
    const list = el('ul', 'issues');
    for (const issue of issues) list.append(el('li', '', issue));
    page.append(list);
  }
  const links = el('p', '', 'Open: ');
  AIRPORT_IDS.forEach((id, i) => {
    const a = el('a', '', id);
    a.setAttribute('href', `?airport=${encodeURIComponent(id)}`);
    links.append(...(i > 0 ? [document.createTextNode(' · '), a] : [a]));
  });
  page.append(links);
  root.replaceChildren(page);
  document.title = 'No map — ATC Ground';
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

void start();
