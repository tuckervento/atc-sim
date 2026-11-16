// The web app's entry (PLAN 1.7, 1.13): the airport map chosen by `?airport=<ID>`, with the sim
// running on it in real time from `?seed=<n>` (default 1). Wiring only: the session (game/
// session.ts) runs the sim, the map draws it, the side panel (game/ui.ts) holds the clock, the
// counters, the log and the dev console.

import { AirportLoadError } from '../airport/load.ts';
import type { Airport } from '../airport/types.ts';
import { withCallsign } from './game/console.ts';
import { counterRows } from './game/counters.ts';
import { formatSimTime } from './game/event-log.ts';
import { hotkeyFor } from './game/hotkeys.ts';
import { parseSeedParam } from './game/params.ts';
import { advance, createSession, drawnAircraft, requestCrossing, startupLines, submit, type Session } from './game/session.ts';
import { buildSidePanel, type SidePanel } from './game/ui.ts';
import { AIRPORT_IDS, loadMapAirport, parseAirportParam } from './map/airports.ts';
import { mountMap, type MapHandle } from './map/map-view.ts';
import { buildScene } from './map/scene.ts';
import { DELAYED_COLOR, RUNWAY_USE_COLOR } from './map/style.ts';
import { TICK_HZ } from '../sim/sim.ts';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('index.html is missing the #app element');
const root = app;

async function start(): Promise<void> {
  const chosen = parseAirportParam(window.location.search, AIRPORT_IDS);
  if (!chosen.ok) {
    showError(chosen.message, []);
    return;
  }
  const seed = parseSeedParam(window.location.search);
  if (!seed.ok) {
    showError(seed.message, []);
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
  document.title = `${airport.id} — ATC Ground`;
  play(airport, seed.seed);
}

function play(airport: Airport, seed: number): void {
  const session = createSession(airport, { seed });
  let selected: string | null = null;

  const mapBox = document.createElement('div');
  mapBox.className = 'map';
  const panel: SidePanel = buildSidePanel(`${airport.id} · seed ${seed}`, {
    onSubmit(text) {
      const result = submit(session, text);
      if (!result.ok) return result.error;
      panel.appendLines(result.lines);
      panel.setInput(selected ? withCallsign('', selected) : '');
      return null;
    },
    onTogglePause: () => togglePause(),
    onSpeed(speed) {
      session.controls.speed = speed;
      panel.setSpeed(speed);
    },
  });
  root.replaceChildren(mapBox, legend(airport, () => map.fit()), panel.element);
  const map: MapHandle = mountMap(mapBox, buildScene(airport), drawnAircraft(session), { onPick: select });
  panel.setSpeed(session.controls.speed);
  panel.appendLines(startupLines(session));

  function select(callsign: string | null): void {
    selected = callsign;
    map.setSelected(callsign);
    if (callsign) panel.setInput(withCallsign(panel.getInput(), callsign));
  }

  function togglePause(): void {
    session.controls.paused = !session.controls.paused;
    refreshClock(session, panel);
  }

  window.addEventListener('keydown', (ev) => {
    const target = ev.target;
    const inTextField = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    const key = hotkeyFor({ key: ev.key, inTextField, ctrl: ev.ctrlKey, meta: ev.metaKey, alt: ev.altKey, repeat: ev.repeat });
    if (key === null) return;
    ev.preventDefault();
    if (key === 'toggle-pause') togglePause();
    else if (key === 'deselect') select(null);
    else if (selected) panel.appendLines(requestCrossing(session, selected));
  });

  let last: number | null = null;
  const frame = (now: number) => {
    // The first frame has no previous one; rAF timestamps can also sit a hair before the last.
    const dtS = last === null ? 0 : Math.max(0, (now - last) / 1000);
    last = now;
    try {
      panel.appendLines(advance(session, dtS));
    } catch (e) {
      // A sim bug: stop the clock, say so, and keep the page as it was for a look.
      const message = e instanceof Error ? e.message : String(e);
      panel.showFatal(`The sim stopped on an error: ${message}`);
      throw e;
    }
    const aircraft = drawnAircraft(session);
    if (selected !== null && !aircraft.some((a) => a.callsign === selected)) select(null);
    map.setAircraft(aircraft);
    refreshClock(session, panel);
    panel.setCounters(counterRows(session.counters.read()));
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function refreshClock(session: Session, panel: SidePanel): void {
  panel.setClock(formatSimTime(session.sim.world.tick / TICK_HZ), session.controls.paused);
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
  box.append(el('p', 'hint', 'Drag to pan · wheel to zoom · click an aircraft to select it'));
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
