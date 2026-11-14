import { describe, expect, it } from 'vitest';
import testAirport from '../../data/airports/TEST.json' with { type: 'json' };
import { indexAirport, type AirportIndex } from '../airport/graph.ts';
import { loadAirport } from '../airport/load.ts';
import { validateAirport } from '../airport/validate.ts';
import type { Taxi } from './commands.ts';
import { resolveRoute, type RoutePath, type RouteResult, type RouteStart } from './route.ts';
import { parseTerse } from './terse.ts';
import eLoop from './__fixtures__/e-loop.overrides.json' with { type: 'json' };

const TEST = indexAirport(loadAirport(testAirport));
/** TEST with E1 and E2 renamed E, so E meets B at both ends (see the fixture's description). */
const E_LOOP = indexAirport(loadAirport(testAirport, eLoop));

/** The taxi instruction of a terse command, written without its callsign: `taxi 27 via A`. */
function taxi(text: string): Taxi {
  const result = parseTerse(`TST1 ${text}`);
  if (!result.ok) throw new Error(`'${text}' doesn't parse: ${result.error.message}`);
  const [instruction] = result.command.type === 'transmission' ? result.command.instructions : [];
  if (instruction?.type !== 'taxi') throw new Error(`'${text}' is not a taxi instruction`);
  return instruction;
}

function at(node: string, arrivedVia: string | null, terminal: string | null = null): RouteStart {
  return { node, arrivedVia, terminal };
}

function pathOf(result: RouteResult): RoutePath {
  if (result.type !== 'path') throw new Error(`expected a path, got ${JSON.stringify(result)}`);
  return result;
}

function route(text: string, start: RouteStart, index: AirportIndex = TEST): RouteResult {
  return resolveRoute(index, taxi(text), start);
}

describe('destinations', () => {
  it('acceptance: the path ends at the ramp entrance (A, then the stub TC into rbTC)', () => {
    // On A eastbound at aC. T2's ramp entrance is rhTC at rbTC, reached by the stub "TC".
    const path = pathOf(route('taxi ramp T2 via A', at('aC', 'aTB-aC')));
    expect(path.nodes).toEqual(['aC', 'aTC', 'rbTC']);
    expect(path.edges).toEqual(['aC-aTC', 'rbTC-aTC']);
    expect(path.lengthM).toBeCloseTo(170);
    expect(path.destination).toEqual({ kind: 'ramp', terminal: 'T2', rampHandoff: 'rhTC' });
    expect(path.holdShorts).toEqual([]);
    expect(path.clearanceHolds).toEqual([]);
  });

  it("acceptance: the path ends at the runway hold-short (A into 27's departure line, on along A9 to hA9)", () => {
    // On A eastbound at aJ. line27 runs aH2 → aP1 → aP2 → aE → a9I → a9H (A, then A9).
    const path = pathOf(route('taxi 27 via A', at('aJ', 'aTC-aJ')));
    expect(path.nodes).toEqual(['aJ', 'aH1', 'r2A', 'aH2', 'aP1', 'aP2', 'aE', 'a9I', 'a9H']);
    expect(path.edges).toEqual(['aJ-aH1', 'aH1-r2A', 'r2A-aH2', 'aH2-aP1', 'aP1-aP2', 'aP2-aE', 'aE-a9I', 'a9I-a9H']);
    expect(path.lengthM).toBeCloseTo(910);
    expect(path.destination).toEqual({ kind: 'runway', runwayEnd: '27', departureLine: 'line27', holdShort: 'hA9' });
  });

  it('ends at a penalty-box spot: D, B, E1, E, then the unnamed lead-in at e1 (the first one reached)', () => {
    // Just crossed 9/27 southbound on D. B west is the only way to E1.
    const path = pathOf(route('taxi penalty via D B E1 E', at('dHS', 'r1D-dHS')));
    expect(path.nodes).toEqual(['dHS', 'bD', 'bE1', 'eW', 'e1', 'pbS1']);
    expect(path.edges.at(-1)).toBe('e1-pbS1');
    expect(path.destination).toEqual({ kind: 'penalty-box', holdingArea: 'penaltyBox', spot: 'pbS1' });
  });

  it('ends at a pad spot: P1, then the unnamed lead-in to the nearest North pad spot, npS1', () => {
    const path = pathOf(route('taxi pad via A P1', at('a7', 'aK-a7')));
    expect(path.nodes.slice(-4)).toEqual(['aP1', 'npW', 'np1', 'npS1']);
    expect(path.destination).toEqual({ kind: 'pad', holdingArea: 'padNorth', spot: 'npS1' });
  });

  it('matches a named pad by its id, ignoring case, and is unable for a pad that does not exist', () => {
    const west = pathOf(route('taxi pad padWest via A K', at('a7', 'a7-aD')));
    expect(west.nodes).toEqual(['a7', 'aK', 'wpS']);
    expect(west.destination).toEqual({ kind: 'pad', holdingArea: 'padWest', spot: 'wpS' });
    expect(route('taxi pad Northern via A P1', at('a7', 'aK-a7'))).toEqual({ type: 'unable', reason: 'no pad NORTHERN at TEST' });
  });

  it("goes to the aircraft's own ramp when none is named; unknown ramps and runways are unable", () => {
    const offC = (terminal: string | null) => at('cHN', 'cHN-r1C', terminal);
    expect(pathOf(route('taxi ramp via A', offC('T1'))).destination).toEqual({ kind: 'ramp', terminal: 'T1', rampHandoff: 'rh7' });
    const unable = (reason: string) => ({ type: 'unable', reason });
    expect(route('taxi ramp via A', offC(null))).toEqual(unable("taxi to the ramp: no terminal named, and the aircraft's is unknown"));
    expect(route('taxi ramp T9 via A', offC(null))).toEqual(unable('no terminal T9 at TEST'));
    expect(route('taxi 31L via A', offC(null))).toEqual(unable('no runway 31L at TEST'));
    expect(route('taxi 18 via A', offC(null))).toEqual(unable('runway 18 has no departure line at TEST'));
    const noEntrance = indexAirport(
      loadAirport(testAirport, { formatVersion: 1, airport: 'TEST', rampHandoffs: { patch: [{ id: 'rhTC', use: 'departures' }] } }),
    );
    expect(route('taxi ramp T2 via A', offC(null), noEntrance)).toEqual(unable('no ramp entrance serves T2 at TEST'));
  });
});

describe('turns', () => {
  it('acceptance: with no direction, it turns toward the destination (off C onto A, right for T2)', () => {
    // Exited 27 at C, now at cHN heading north. "via A": it follows C to A, then turns.
    const path = pathOf(route('taxi ramp T2 via A', at('cHN', 'cHN-r1C')));
    expect(path.nodes).toEqual(['cHN', 'aC', 'aTC', 'rbTC']);
    expect(path.destination).toEqual({ kind: 'ramp', terminal: 'T2', rampHandoff: 'rhTC' });
  });

  it('acceptance: turn directions honored (south on the stub 7, left on A is east, right on A is west)', () => {
    const fromRamp7 = at('rb7', 'rb7-l7A');
    const left = pathOf(route('taxi 27 via #7 L:A', fromRamp7));
    expect(left.nodes.slice(0, 3)).toEqual(['rb7', 'a7', 'aD']);
    expect(left.nodes.at(-1)).toBe('a9H');
    // West on A never meets 27's departure line. The turn is followed, not overridden.
    expect(route('taxi 27 via #7 R:A', fromRamp7)).toEqual({
      type: 'unable',
      reason: "taxiway A doesn't lead to runway 27's departure line in the direction of travel",
    });
  });
  it('is unable to turn left or right with no heading (parked on a pad spot), but goes with no turn given', () => {
    const parked = at('wpS', null);
    const path = pathOf(route('taxi 9 via K', parked));
    // K to aK, where runway 9's departure line (on A) begins.
    expect(path.nodes).toEqual(['wpS', 'aK', 'aW', 'a1H']);
    expect(path.destination).toEqual({ kind: 'runway', runwayEnd: '9', departureLine: 'line9', holdShort: 'hA1' });
    expect(route('taxi 9 via R:K', parked)).toEqual({ type: 'unable', reason: "can't turn right onto K at wpS with no heading" });
  });

  it('is unable to turn onto the taxiway it is already on, rather than ignoring the turn', () => {
    expect(route('taxi ramp T2 via R:A', at('aC', 'aTB-aC'))).toEqual({
      type: 'unable',
      reason: "already on taxiway A, so it can't turn right onto it",
    });
  });
});

describe('ambiguity', () => {
  it('the E-loop fixture is a valid airport', () => {
    const result = validateAirport(E_LOOP.airport);
    expect(result.errors.map((e) => e.message)).toEqual([]);
  });

  it('acceptance: the ambiguous case returns ambiguity (both ways on B reach the penalty box, no direction)', () => {
    // South on D at dHS. West on B meets E at bE1, east at bE2; both lead to a penalty-box spot.
    expect(route('taxi penalty via D B E', at('dHS', 'r1D-dHS'), E_LOOP)).toEqual({
      type: 'ambiguous',
      node: 'bD',
      taxiway: 'B',
      edges: ['bE1-bD', 'bD-bC'],
    });
  });

  it('honors turn directions where both ways work: heading south, left on B is east, right is west', () => {
    const left = pathOf(route('taxi penalty via D L:B E', at('dHS', 'r1D-dHS'), E_LOOP));
    expect(left.nodes).toEqual(['dHS', 'bD', 'bC', 'bE2', 'eE', 'e2', 'pbS2']);
    expect(left.destination).toEqual({ kind: 'penalty-box', holdingArea: 'penaltyBox', spot: 'pbS2' });
    const right = pathOf(route('taxi penalty via D R:B E', at('dHS', 'r1D-dHS'), E_LOOP));
    expect(right.nodes).toEqual(['dHS', 'bD', 'bE1', 'eW', 'e1', 'pbS1']);
  });


  it('is not ambiguous on TEST itself: there, B and E never meet (E1 and E2 must be named)', () => {
    expect(route('taxi penalty via D B E', at('dHS', 'r1D-dHS'))).toEqual({
      type: 'unable',
      reason: "taxiways B and E don't meet",
    });
  });
});

describe('unable, with a reason', () => {
  it('acceptance: a non-connecting route returns unable with a reason naming the taxiways', () => {
    const onA = at('aJ', 'aTC-aJ');
    expect(route('taxi 27 via A B', onA)).toEqual({ type: 'unable', reason: "taxiways A and B don't meet" });
    expect(route('taxi 27 via A KZ', onA)).toEqual({ type: 'unable', reason: 'no taxiway KZ at TEST' });
    // A and D do meet, at aD, but that's behind an aircraft westbound at a7.
    expect(route('taxi ramp T1 via A D', at('a7', 'a7-aD'))).toEqual({
      type: 'unable',
      reason: "taxiway A doesn't reach D in the direction of travel (they meet only at aD)",
    });
  });

  it('is unable for a route that names no taxiways, or the same one twice in a row', () => {
    const empty: Taxi = { type: 'taxi', to: { kind: 'runway', name: '27' }, via: [], holdShort: [] };
    expect(resolveRoute(TEST, empty, at('aJ', 'aTC-aJ'))).toEqual({ type: 'unable', reason: 'the route names no taxiways' });
    expect(route('taxi 27 via A A', at('aJ', 'aTC-aJ'))).toEqual({ type: 'unable', reason: 'taxiway A is named twice in a row' });
  });

  it('never reverses: T1 is behind an aircraft eastbound at aC, so it is unable; westbound it goes', () => {
    expect(route('taxi ramp T1 via A', at('aC', 'aTB-aC'))).toEqual({
      type: 'unable',
      reason: "taxiway A doesn't lead to a ramp entrance for T1 in the direction of travel",
    });
    const west = pathOf(route('taxi ramp T1 via A', at('aC', 'aC-aTC')));
    expect(west.nodes).toEqual(['aC', 'aTB', 'aD', 'a7', 'rb7']);
    expect(west.destination).toEqual({ kind: 'ramp', terminal: 'T1', rampHandoff: 'rh7' });
  });

  it('never uses a closed edge: the route needs C south of the runway, closed, so the reason names it', () => {
    expect(route('taxi penalty via C B E1 E', at('aC', 'aTB-aC'))).toEqual({
      type: 'unable',
      reason: 'taxiway C is closed between cHS and bC (Construction: Twy C closed between Rwy 9/27 and Twy B (synthetic))',
    });
  });

  it('turns at the first junction and never skips one: E closed at bE2 is unable, not a detour to bE1', () => {
    // Off runway 36 at F, westbound at bF. On B, the first junction with E is bE2.
    const offF = at('bF', 'bF-fH');
    expect(pathOf(route('taxi penalty via B E', offF, E_LOOP)).nodes).toEqual(['bF', 'bE2', 'eE', 'e2', 'pbS2']);
    const closedAtBE2 = indexAirport(
      loadAirport(testAirport, {
        formatVersion: 1,
        airport: 'TEST',
        edges: { patch: [{ id: 'bE1-eW', name: 'E' }, { id: 'bE2-eE', name: 'E', closed: { reason: 'test closure' } }] },
      }),
    );
    expect(route('taxi penalty via B E', offF, closedAtBE2)).toEqual({
      type: 'unable',
      reason: 'taxiway E is closed between bE2 and eE (test closure)',
    });
  });

  it("never uses a closed edge in the destination's way in: 27's line closed on A9 names the closure", () => {
    const lineClosed = indexAirport(
      loadAirport(testAirport, {
        formatVersion: 1,
        airport: 'TEST',
        edges: { patch: [{ id: 'aE-a9I', closed: { reason: 'test closure' } }] },
      }),
    );
    expect(route('taxi 27 via A', at('aJ', 'aTC-aJ'), lineClosed)).toEqual({
      type: 'unable',
      reason: 'taxiway A9 is closed between aE and a9I (test closure)',
    });
  });

  it("names the closure when the ramp entrance's stub is closed", () => {
    const stubClosed = indexAirport(
      loadAirport(testAirport, {
        formatVersion: 1,
        airport: 'TEST',
        edges: { patch: [{ id: 'rbTC-aTC', closed: { reason: 'test closure' } }] },
      }),
    );
    expect(route('taxi ramp T2 via A', at('aC', 'aTB-aC'), stubClosed)).toEqual({
      type: 'unable',
      reason: 'taxiway TC is closed between aTC and rbTC (test closure)',
    });
  });
});

describe('the start position', () => {
  it("throws for a start that isn't on the airport: that's the caller's bug, not the pilot's", () => {
    const go = taxi('taxi 27 via A');
    expect(() => resolveRoute(TEST, go, at('nowhere', null))).toThrow('route start: unknown node "nowhere"');
    expect(() => resolveRoute(TEST, go, at('aJ', 'noEdge'))).toThrow('route start: unknown edge "noEdge"');
    expect(() => resolveRoute(TEST, go, at('aJ', 'aW-aK'))).toThrow('route start: edge "aW-aK" doesn\'t touch node "aJ"');
  });
});

describe("the numeric ramp lane name '7'", () => {
  it('routes a departure out of ramp spot 7 along the stub 7, and an arrival in along it', () => {
    const out = pathOf(route('taxi 27 via #7 A', at('rb7', 'rb7-l7A')));
    expect(out.nodes.slice(0, 3)).toEqual(['rb7', 'a7', 'aD']);
    expect(out.destination).toEqual({ kind: 'runway', runwayEnd: '27', departureLine: 'line27', holdShort: 'hA9' });
    const into = pathOf(route('taxi ramp T1 via A #7', at('aD', 'aD-aTB')));
    expect(into.nodes).toEqual(['aD', 'a7', 'rb7']);
    expect(into.edges).toEqual(['a7-aD', 'rb7-a7']);
    expect(into.destination).toEqual({ kind: 'ramp', terminal: 'T1', rampHandoff: 'rh7' });
  });
});

describe("the aircraft's own way out, before the first route item", () => {
  it('leaves a pad spot over its unnamed edges to the first taxiway, and no further', () => {
    const parked = at('npS1', null);
    const path = pathOf(route('taxi 27 via P2', parked));
    expect(path.nodes).toEqual(['npS1', 'np1', 'np2', 'npE', 'aP2', 'aE', 'a9I', 'a9H']);
    expect(path.destination).toEqual({ kind: 'runway', runwayEnd: '27', departureLine: 'line27', holdShort: 'hA9' });
    // A is past P1 or P2: the route has to name one.
    expect(route('taxi 27 via A', parked)).toEqual({ type: 'unable', reason: "taxiway A can't be reached from npS1" });
  });

  it("leaves the departure line at the route's first taxiway, an exit ahead (docs/terse-syntax.md, C6)", () => {
    // Queued in 27's line on A at aH2: "exit the line at the next left, P1, hold on the pad".
    const path = pathOf(route('taxi pad via L:P1', at('aH2', 'r2A-aH2')));
    expect(path.nodes).toEqual(['aH2', 'aP1', 'npW', 'np1', 'npS1']);
    // Already past P1 at aP2: it can't go back.
    expect(route('taxi pad via L:P1', at('aP2', 'aP1-aP2'))).toEqual({
      type: 'unable',
      reason: "taxiway A doesn't reach P1 in the direction of travel (they meet only at aP1)",
    });
  });

  it("never crosses a runway the route doesn't name: southbound on D, 'via B' would cross 9/27 (Q)", () => {
    const onD = at('dHN', 'dI-dHN');
    expect(route('taxi penalty via B E1 E', onD)).toEqual({
      type: 'unable',
      reason: "reaching B means crossing runway 9/27 on D, which the route doesn't name",
    });
    // Named, the crossing is the player's: the path goes, and stops at D's hold line.
    const named = pathOf(route('taxi penalty via D B E1 E', onD));
    expect(named.nodes.slice(0, 4)).toEqual(['dHN', 'r1D', 'dHS', 'bD']);
    expect(named.holdShorts.map((h) => h.id)).toEqual(['hDN']);
  });
});

describe("the clearance's hold-shorts", () => {
  it('holds short of a taxiway at the node just before the path enters it, naming the hold line there', () => {
    // Off 27 at D, northbound at dHN. "hs A": stop at dI, where the intermediate hold hDI faces A.
    const path = pathOf(route('taxi ramp T1 via D A hs A', at('dHN', 'dHN-r1D')));
    expect(path.nodes).toEqual(['dHN', 'dI', 'aD', 'a7', 'rb7']);
    expect(path.holdShorts).toEqual([{ id: 'hDI', kind: 'intermediate', runways: [], index: 1 }]);
    expect(path.clearanceHolds).toEqual([{ target: { kind: 'taxiway', name: 'A' }, at: [{ index: 1, holdShort: 'hDI' }] }]);
  });

  it('holds short of a runway at the hold line(s) on the path protecting it: 36 is runway 18/36, at hAW', () => {
    const path = pathOf(route('taxi 27 via A hs 36', at('aJ', 'aTC-aJ')));
    expect(path.clearanceHolds).toEqual([{ target: { kind: 'runway', name: '36' }, at: [{ index: 1, holdShort: 'hAW' }] }]);
  });

  it('holds short of the departure runway itself at the end of the path, the front hold hA9', () => {
    const path = pathOf(route('taxi 27 via A hs 27', at('aJ', 'aTC-aJ')));
    expect(path.nodes).toHaveLength(9);
    expect(path.clearanceHolds).toEqual([{ target: { kind: 'runway', name: '27' }, at: [{ index: 8, holdShort: 'hA9' }] }]);
  });

  it('is unable when a hold-short target is off the path, or unknown', () => {
    const unable = (reason: string) => ({ type: 'unable', reason });
    expect(route('taxi 27 via A hs B', at('aJ', 'aTC-aJ'))).toEqual(unable('hold short of B: the route never meets taxiway B'));
    // aC → aTC → rbTC crosses no runway.
    expect(route('taxi ramp T2 via A hs 36', at('aC', 'aTB-aC'))).toEqual(
      unable("hold short of runway 36: the route doesn't cross runway 18/36"),
    );
    expect(route('taxi 27 via A hs KZ', at('aJ', 'aTC-aJ'))).toEqual(unable('hold short of KZ: no taxiway KZ at TEST'));
    expect(route('taxi 27 via A hs 31R', at('aJ', 'aTC-aJ'))).toEqual(unable('hold short of runway 31R: no runway 31R at TEST'));
  });
});

describe('hold-short lines the path passes', () => {
  it('lists the runway crossing on A (18/36 at r2A): hAW eastbound, then the ILS hold on A9', () => {
    const path = pathOf(route('taxi 27 via A', at('aJ', 'aTC-aJ')));
    expect(path.holdShorts).toEqual([
      { id: 'hAW', kind: 'runway', runways: ['18/36'], index: 1 },
      { id: 'hA9ils', kind: 'ils', runways: ['9/27'], index: 7 },
    ]);
    expect([path.nodes[1], path.nodes[7]]).toEqual(['aH1', 'a9I']);
    // The front hold hA9 isn't passed: the path ends at it, facing the runway.
  });

  it('lists hAE for the same crossing westbound, and not hAW (holds are one-way)', () => {
    const path = pathOf(route('taxi ramp T2 via A', at('aP1', 'aP1-aP2')));
    expect(path.nodes).toEqual(['aP1', 'aH2', 'r2A', 'aH1', 'aJ', 'aTC', 'rbTC']);
    expect(path.holdShorts).toEqual([{ id: 'hAE', kind: 'runway', runways: ['18/36'], index: 1 }]);
  });
});
