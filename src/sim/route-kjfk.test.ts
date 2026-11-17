// Route resolution on KJFK (base plus overrides, as the app loads it), for the junctions Q's
// manual run couldn't route through (investigations/route-retries-q-run.md).

import { describe, expect, it } from 'vitest';
import kjfkAirport from '../../data/airports/KJFK.json' with { type: 'json' };
import kjfkOverrides from '../../data/airports/KJFK.overrides.json' with { type: 'json' };
import { edgesAt, indexAirport, otherEnd } from '../airport/graph.ts';
import { loadAirport } from '../airport/load.ts';
import type { Taxi } from './commands.ts';
import { resolveRoute, turnPicks, type RoutePath, type RouteResult } from './route.ts';
import { parseTerse } from './terse.ts';

const KJFK = indexAirport(loadAirport(kjfkAirport, kjfkOverrides));

function taxi(text: string): Taxi {
  const result = parseTerse(`TST1 ${text}`);
  if (!result.ok) throw new Error(`'${text}' doesn't parse: ${result.error.message}`);
  const [instruction] = result.command.type === 'transmission' ? result.command.instructions : [];
  if (instruction?.type !== 'taxi') throw new Error(`'${text}' is not a taxi instruction`);
  return instruction;
}

/** The edge joining two nodes. */
function edge(a: string, b: string): string {
  const found = edgesAt(KJFK, a).find((e) => otherEnd(e, a) === b);
  if (!found) throw new Error(`no edge ${a}–${b}`);
  return found.id;
}

/** `text` from `node`, having arrived along the edge from `from`, for a T-terminal aircraft. */
function route(text: string, node: string, from: string, terminal: string): RouteResult {
  return resolveRoute(KJFK, taxi(text), { node, arrivedVia: edge(from, node), terminal });
}

function pathOf(result: RouteResult): RoutePath {
  if (result.type !== 'path') throw new Error(`expected a path, got ${JSON.stringify(result)}`);
  return result;
}

describe('straight on is neither left nor right', () => {
  // P meets B and MB at n45349123. Along P from the north-west, one way along B carries
  // straight on (to n4057465067, about 1° left), the other turns sharply back left (to
  // n45345623). Both count as left today, so no route on B can be written from here.
  const [junction, alongP, straight, sharpLeft] = ['n45349123', 'n12776366538', 'n4057465067', 'n45345623'];

  it('AMX4220 at P/B/MB: no turn goes straight on, L: takes the sharp left, R: is unable', () => {
    expect(pathOf(route('taxi ramp via B LA R:A KG', junction, alongP, 'T4')).nodes[1]).toBe(straight);
    expect(pathOf(route('taxi ramp via L:B LA R:A KG', junction, alongP, 'T4')).nodes[1]).toBe(sharpLeft);
    expect(route('taxi ramp via R:B LA R:A KG', junction, alongP, 'T4')).toMatchObject({ type: 'unable' });
  });

  it('AMX4220 at Q/MB/A: the same, along Q (A straight on about 2° left, or back 123° left)', () => {
    const [qA, alongQ] = ['n1743999301', 'n45345623'];
    expect(pathOf(route('taxi ramp via A KG', qA, alongQ, 'T4')).nodes[1]).toBe('n1743722044');
    expect(pathOf(route('taxi ramp via L:A KG', qA, alongQ, 'T4')).nodes[1]).toBe('n1743722028');
    expect(route('taxi ramp via R:A KG', qA, alongQ, 'T4')).toMatchObject({ type: 'unable' });
  });
});

/**
 * Left as they are (Q, 2026-11-16): two ways through unnamed connectors with the same pick, at
 * nodes on unnamed edges only, so met only before a route's first taxiway (an unnamed exit or
 * lead-out). At C6 and DB the ways share their connector and part at its far end; at G they're
 * two gentle fillets on the same side. No rule tried tells them apart without breaking natural
 * phrasing (investigations/route-retries-q-run.md).
 */
const KNOWN_CONNECTOR_CLASHES = new Set(['n4058789602 onto G', 'n4452051911 onto C6', 'n8025529398 onto DB']);

describe('every KJFK junction: each way onto a taxiway can be picked', () => {
  it('no two ways onto a taxiway share a pick (left, right or straight on), directly or through a connector', () => {
    const clashes: string[] = [];
    for (const node of KJFK.nodes.keys()) {
      const here = edgesAt(KJFK, node).filter((e) => e.kind === 'taxiway' && !e.closed);
      const names = new Set(here.flatMap((e) => (e.name === undefined ? [] : [e.name])));
      for (const arrived of here) {
        // Onto every other taxiway met here, or reached from here through a connector.
        const targets = new Set(names);
        for (const e of edgesAt(KJFK, node)) if (e.name === undefined) for (const f of edgesAt(KJFK, otherEnd(e, node))) if (f.name !== undefined) targets.add(f.name);
        for (const name of targets) {
          if (name === arrived.name) continue;
          const ways = turnPicks(KJFK, node, arrived.id, name);
          const picks = ways.map((w) => w.pick);
          if (new Set(picks).size < picks.length) {
            const detail = ways.map((w) => `${w.pick} by ${w.edges.length - 1} connector edge(s), turns ${w.turnsDeg.join('/')}°`).join('; ');
            if (!KNOWN_CONNECTOR_CLASHES.has(`${node} onto ${name}`)) clashes.push(`${node} along ${arrived.id} onto ${name}: ${detail}`);
          }
        }
      }
    }
    expect(clashes).toEqual([]);
  });
});

describe('a taxiway that forks into same-named branches', () => {
  // U runs from U1 to n9328929569, where it forks: one branch meets A at n1743805056, the other
  // at n1743805057, west of it. A1 starts on A 24 m east of n1743805056. ICE6492 (Q's run) was
  // on C1; no route along U onto A could be written.
  const [c1u1, alongC1, fork, eastEnd, westEnd] = ['n45293435', 'n4066683376', 'n9328929569', 'n1743805056', 'n1743805057'];
  const after = (path: RoutePath, node: string) => path.nodes[path.nodes.indexOf(node) + 1];

  it('ICE6492: left onto A (east, to A1) takes the branch built for it', () => {
    const path = pathOf(route('taxi ramp via U1 L:U L:A A1', c1u1, alongC1, 'T7'));
    expect(after(path, fork)).toBe(eastEnd);
  });

  it('ICE6492: right onto A (west) takes the other branch', () => {
    const path = pathOf(route('taxi ramp via U1 L:U R:A A1', c1u1, alongC1, 'T7'));
    expect(after(path, fork)).toBe(westEnd);
  });

  it('with no turn onto A, where both ways along A complete the route, it asks which way on A (the turn that settles it)', () => {
    expect(route('taxi ramp via U1 L:U A A1', c1u1, alongC1, 'T7')).toMatchObject({ type: 'ambiguous', node: fork, taxiway: 'A' });
  });
});

/**
 * At every KJFK fork (a node with three or more edges of one taxiway's name), coming in along
 * each of them: the ways onto each other taxiway Y at the first junction with Y along each
 * branch, all branches together, with their picks. `fork` false: as if there were no fork rule.
 */
function forkPicks(fork: boolean): { at: string; picks: string[] }[] {
  const found: { at: string; picks: string[] }[] = [];
  for (const node of KJFK.nodes.keys()) {
    const byName = new Map<string, ReturnType<typeof edgesAt>>();
    for (const e of edgesAt(KJFK, node)) if (e.kind === 'taxiway' && e.name !== undefined && !e.closed) byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
    for (const [name, edges] of byName) {
      if (edges.length < 3) continue;
      for (const arrived of edges) {
        const onto = new Map<string, string[]>();
        for (const branch of edges.filter((e) => e.id !== arrived.id)) {
          const seen = new Set<string>();
          let [at, last, walked] = [otherEnd(branch, node), branch, 0];
          for (let hops = 0; hops < 50; hops++) {
            const others = new Set<string>();
            for (const e of edgesAt(KJFK, at)) {
              if (e.name !== undefined && e.name !== name) others.add(e.name);
              if (e.name === undefined && e.kind === 'taxiway') for (const f of edgesAt(KJFK, otherEnd(e, at))) if (f.name !== undefined && f.name !== name) others.add(f.name);
            }
            for (const y of others) {
              if (seen.has(y)) continue;
              const ways = turnPicks(KJFK, at, last.id, y, fork ? { node, arrivedVia: arrived.id } : null);
              if (ways.length === 0) continue;
              seen.add(y);
              onto.set(y, [...(onto.get(y) ?? []), ...ways.map((w) => w.pick)]);
            }
            const on = edgesAt(KJFK, at).filter((e) => e.name === name && e.id !== last.id);
            const [nextEdge] = on;
            if (on.length !== 1 || !nextEdge || walked > 400) break;
            walked += 1;
            [at, last] = [otherEnd(nextEdge, at), nextEdge];
          }
        }
        for (const [y, picks] of onto) found.push({ at: `${node} along ${name} (${arrived.id}) onto ${y}`, picks });
      }
    }
  }
  return found;
}

describe('every KJFK fork: each way onto the next taxiway can be picked', () => {
  it('no two ways onto a taxiway after a fork share a pick, over all its branches', () => {
    const clashes = forkPicks(true).filter(({ picks }) => new Set(picks).size < picks.length);
    expect(clashes.map(({ at, picks }) => `${at}: ${picks.join(', ')}`)).toEqual([]);
  });
});

describe('reasons name places as a player finds them, never by id', () => {
  it('no unable reason, over routes from every KJFK junction onto every taxiway met there, contains a node, edge or hold-short id', () => {
    const ids = new Set([...KJFK.nodes.keys(), ...KJFK.edges.keys(), ...KJFK.airport.holdShorts.map((h) => h.id)]);
    const leaks = new Set<string>();
    let reasons = 0;
    for (const node of KJFK.nodes.keys()) {
      const here = edgesAt(KJFK, node).filter((e) => e.kind === 'taxiway' && !e.closed);
      const names = [...new Set(here.flatMap((e) => (e.name === undefined ? [] : [e.name])))];
      if (names.length < 2) continue;
      for (const arrived of here) {
        for (const name of names) {
          if (name === arrived.name) continue;
          for (const turn of ['', 'L:', 'R:']) {
            const result = resolveRoute(KJFK, taxi(`taxi ramp via ${turn}${name}`), { node, arrivedVia: arrived.id, terminal: 'T4' });
            if (result.type !== 'unable') continue;
            reasons++;
            for (const token of result.reason.split(/[\s,()/:]+/)) if (ids.has(token)) leaks.add(result.reason);
          }
        }
      }
    }
    expect(reasons).toBeGreaterThan(1000);
    expect([...leaks]).toEqual([]);
  });
});

describe('ramp entrances: all take arrivals, the arrival-marked ones first', () => {
  it("WJA7466 (Q's run): an arrival for T4 can be taken in at G, an exit marked for departures, when the route goes there", () => {
    // B meets G at n45377378. Before, G was no entrance for an arrival: "G doesn't lead to a ramp
    // entrance for T4". KG and A10, marked for arrivals, aren't reached along G.
    const [bG, alongB] = ['n45377378', 'n4058789613'];
    expect(pathOf(route('taxi ramp via G', bG, alongB, 'T4')).destination).toEqual({ kind: 'ramp', terminal: 'T4', rampHandoff: 'rhG' });
    expect(pathOf(route('taxi ramp via R:G', bG, alongB, 'T4')).destination).toMatchObject({ rampHandoff: 'rhG' });
  });
});

describe('a ramp route that misses', () => {
  it("names the terminal's ramp entrances, so the player knows which do lead there (seed 666, JBU639: six tries for T5)", () => {
    // Off 31L northbound on MB at B/MB/P; right onto B is east, and G meets no T5 entrance.
    expect(route('taxi ramp via R:B G', 'n45349123', 'n5969626551', 'T5')).toEqual({
      type: 'unable',
      reason: "taxiway G doesn't lead to a ramp entrance for T5 in the direction of travel (T5's ramp entrances: A4, D, DA, F)",
    });
  });
});
