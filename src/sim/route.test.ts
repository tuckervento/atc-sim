import { describe, expect, it } from 'vitest';
import testAirport from '../../data/airports/TEST.json' with { type: 'json' };
import { indexAirport, type AirportIndex } from '../airport/graph.ts';
import { loadAirport } from '../airport/load.ts';
import { validateAirport } from '../airport/validate.ts';
import type { Taxi } from './commands.ts';
import { resolveRoute, type RoutePath, type RouteResult, type RouteStart } from './route.ts';
import { parseTerse } from './terse.ts';
import connector from './__fixtures__/connector.overrides.json' with { type: 'json' };
import eLoop from './__fixtures__/e-loop.overrides.json' with { type: 'json' };

const TEST = indexAirport(loadAirport(testAirport));
/** TEST with E1 and E2 renamed E, so E meets B at both ends (see the fixture's description). */
const E_LOOP = indexAirport(loadAirport(testAirport, eLoop));
/** TEST with E1 unnamed, so B and E meet only through that unnamed connector (Q6). */
const CONNECTOR = indexAirport(loadAirport(testAirport, connector));

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
      loadAirport(testAirport, {
        formatVersion: 1,
        airport: 'TEST',
        rampHandoffs: { patch: [{ id: 'rhTC', terminals: ['T1'] }, { id: 'rhTB', terminals: ['T1'] }] },
      }),
    );
    expect(route('taxi ramp T2 via A', offC(null), noEntrance)).toEqual(unable('no ramp entrance serves T2 at TEST'));
  });

  it("takes arrivals in at an entrance marked for departures (Q's run: \"they all need to be accessible by all\")", () => {
    // TB serves every terminal and is marked for departures; east on A from a7, it comes before TC.
    const path = pathOf(route('taxi ramp T2 via A TB', at('a7', 'aK-a7')));
    expect(path.destination).toEqual({ kind: 'ramp', terminal: 'T2', rampHandoff: 'rhTB' });
  });
});

describe('hardstands and hangars (PLAN 1.5 stage b)', () => {
  it("ends at a hardstand spot: B, G, then the hardstand's own unnamed lead-in to the nearest spot", () => {
    // Eastbound on B at bE2. G runs south from bF to gS; hsS1 and hsS2 are 85 m on, a tie: the first wins.
    const path = pathOf(route('taxi hardstand via B G', at('bE2', 'bC-bE2')));
    expect(path.nodes).toEqual(['bE2', 'bF', 'gS', 'hsS1']);
    expect(path.destination).toEqual({ kind: 'hardstand', holdingArea: 'hardstand', spot: 'hsS1' });
  });

  it('matches holding areas by spoken name, ignoring case (the terse parser uppercases names)', () => {
    const named = (kind: 'hardstand' | 'penalty-box', name: string): Taxi => ({ type: 'taxi', to: { kind, name }, via: [{ taxiway: 'G', turn: null }], holdShort: [] });
    expect(pathOf(resolveRoute(TEST, named('hardstand', 'THE HARDSTAND'), at('bF', 'bE2-bF'))).destination).toEqual({ kind: 'hardstand', holdingArea: 'hardstand', spot: 'hsS1' });
    expect(pathOf(resolveRoute(TEST, named('hardstand', 'SOUTH HARDSTAND'), at('bF', 'bE2-bF'))).nodes).toEqual(['bF', 'gS', 'hsS1']);
    expect(resolveRoute(TEST, named('hardstand', 'NORTH'), at('bF', 'bE2-bF'))).toEqual({ type: 'unable', reason: 'no hardstand NORTH at TEST' });
  });

  it("goes to the company hangar (no name) by the aircraft's airline, over the hangar's ramp-lane lead-in", () => {
    // Westbound on A at aK. A ends at aW, where the Delta hangar's lead-in (a ramp lane) starts.
    const path = pathOf(resolveRoute(TEST, taxi('taxi hangar via A'), { ...at('aK', 'aK-a7'), airline: 'DAL' }));
    expect(path.nodes).toEqual(['aK', 'aW', 'hgD']);
    expect(path.edges).toEqual(['aW-aK', 'aW-hgD']);
    expect(path.destination).toEqual({ kind: 'hangar', hangar: 'hangarDAL', spot: 'hgD' });
  });

  it('is unable to find the company hangar with no airline or none for it; names match id, name or airline', () => {
    const onA = (airline?: string | null) => ({ ...at('aK', 'aK-a7'), airline });
    const unable = (reason: string) => ({ type: 'unable', reason });
    expect(resolveRoute(TEST, taxi('taxi hangar via A'), onA())).toEqual(unable("taxi to the company hangar: the aircraft's airline is unknown"));
    expect(resolveRoute(TEST, taxi('taxi hangar via A'), onA(null))).toEqual(unable("taxi to the company hangar: the aircraft's airline is unknown"));
    expect(resolveRoute(TEST, taxi('taxi hangar via A'), onA('JBU'))).toEqual(unable('no company hangar for JBU at TEST'));
    for (const name of ['DAL', 'hangarDAL']) {
      expect(pathOf(resolveRoute(TEST, taxi(`taxi hangar ${name} via A`), onA('JBU'))).destination).toEqual({ kind: 'hangar', hangar: 'hangarDAL', spot: 'hgD' });
    }
    expect(resolveRoute(TEST, taxi('taxi hangar UAL via A'), onA())).toEqual(unable('no hangar UAL at TEST'));
  });

  it("never enters a hangar's lead-in through a ramp handoff: a hangar inside ramp 7 is unable", () => {
    // With stub 7 unnamed, only the handoff at rb7 stands between A and ramp lane 7.
    const inRamp = indexAirport(
      loadAirport(testAirport, {
        formatVersion: 1,
        airport: 'TEST',
        edges: { patch: [{ id: 'rb7-a7', name: null }] },
        hangars: { add: [{ id: 'hg7', name: 'Ramp hangar', airlines: [], spots: ['g3'] }] },
      }),
    );
    expect(resolveRoute(inRamp, taxi('taxi hangar hg7 via A'), at('aD', 'aD-aTB'))).toEqual({
      type: 'unable',
      reason: "taxiway A doesn't lead to hangar HG7 in the direction of travel",
    });
  });
});

describe('unnamed connectors count as turns (Q6)', () => {
  it('the connector fixture is a valid airport', () => {
    expect(validateAirport(CONNECTOR.airport).errors.map((e) => e.message)).toEqual([]);
  });

  it('acceptance: "B, then E" resolves over the unnamed connector that joins them', () => {
    // South on D at dHS. West on B to bE1, round the connector to eW, east on E to the box.
    const path = pathOf(route('taxi penalty via D B E', at('dHS', 'r1D-dHS'), CONNECTOR));
    expect(path.nodes).toEqual(['dHS', 'bD', 'bE1', 'eW', 'e1', 'pbS1']);
    expect(path.edges).toEqual(['dHS-bD', 'bE1-bD', 'bE1-eW', 'eW-e1', 'e1-pbS1']);
    expect(path.destination).toEqual({ kind: 'penalty-box', holdingArea: 'penaltyBox', spot: 'pbS1' });
  });

  it('measures a turn direction through the connector: west on B, it curls left round onto E eastbound', () => {
    const left = pathOf(route('taxi penalty via D B L:E', at('dHS', 'r1D-dHS'), CONNECTOR));
    expect(left.nodes).toEqual(['dHS', 'bD', 'bE1', 'eW', 'e1', 'pbS1']);
    expect(route('taxi penalty via D B R:E', at('dHS', 'r1D-dHS'), CONNECTOR)).toEqual({
      type: 'unable',
      reason: "taxiway E doesn't go right from B near D",
    });
  });

  // E1 and E2 both unnamed: B and E are joined by a connector at each end.
  const BOTH = indexAirport(loadAirport(testAirport, { ...connector, edges: { patch: [{ id: 'bE1-eW', name: null }, { id: 'bE2-eE', name: null }] } }));

  it('is ambiguous when connectors reach the next taxiway both ways and no direction is given', () => {
    expect(route('taxi penalty via D B E', at('dHS', 'r1D-dHS'), BOTH)).toEqual({
      type: 'ambiguous',
      node: 'bD',
      taxiway: 'B',
      edges: ['bE1-bD', 'bD-bC'],
    });
  });

  it('turns at the first connector and never skips one; a jog onto a parallel taxiway turns the way it leaves', () => {
    // West on B from bF: the first connector to E is at bE2, straight south (left), then right
    // onto E westbound. The whole turn is nothing, so its side is the first turn's: left.
    const offF = at('bF', 'bF-fH');
    expect(pathOf(route('taxi penalty via B E', offF, BOTH)).nodes).toEqual(['bF', 'bE2', 'eE', 'e2', 'pbS2']);
    expect(pathOf(route('taxi penalty via B L:E', offF, BOTH)).nodes).toEqual(['bF', 'bE2', 'eE', 'e2', 'pbS2']);
    expect(route('taxi penalty via B R:E', offF, BOTH)).toEqual({ type: 'unable', reason: "taxiway E doesn't go right from B near C" });
  });

  it("never crosses a runway: an unnamed edge from F's hold onto 18/36, where Z starts, is no connector", () => {
    const acrossRunway = indexAirport(
      loadAirport(testAirport, {
        formatVersion: 1,
        airport: 'TEST',
        nodes: { add: [{ id: 'zE', x: 1000, y: -200 }] },
        edges: { patch: [{ id: 'fH-r2F', name: null }], add: [{ id: 'r2F-zE', kind: 'taxiway', name: 'Z', from: 'r2F', to: 'zE' }] },
      }),
    );
    expect(route('taxi 27 via B F Z', at('bE2', 'bC-bE2'), acrossRunway)).toEqual({ type: 'unable', reason: "taxiways F and Z don't meet" });
  });

  it('is no connector when longer than CONNECTOR_MAX_M (E1 unnamed but bent out to 497 m)', () => {
    const long = indexAirport(
      loadAirport(testAirport, { formatVersion: 1, airport: 'TEST', edges: { patch: [{ id: 'bE1-eW', name: null, points: [[-1300, -260], [-1300, -340]] }] } }),
    );
    expect(route('taxi penalty via D B E', at('dHS', 'r1D-dHS'), long)).toEqual({ type: 'unable', reason: "taxiways B and E don't meet" });
  });

  it('is no connector for a hairpin: sharper than CONNECTOR_MAX_TURN_DEG from the heading it arrives with', () => {
    // An unnamed edge from bD south-east to a new taxiway H: a 45° right turn eastbound on B, a
    // 135° hairpin westbound.
    const hairpin = indexAirport(
      loadAirport(testAirport, {
        formatVersion: 1,
        airport: 'TEST',
        nodes: { add: [{ id: 'hp', x: -200, y: -300 }, { id: 'hq', x: -200, y: -380 }] },
        edges: { add: [{ id: 'bD-hp', kind: 'taxiway', from: 'bD', to: 'hp' }, { id: 'hp-hq', kind: 'taxiway', name: 'H', from: 'hp', to: 'hq' }] },
        holdingAreas: { add: [{ id: 'padH', name: 'H pad', kind: 'pad', spots: ['hq'] }] },
      }),
    );
    expect(pathOf(route('taxi pad padH via B H', at('bD', 'bE1-bD'), hairpin)).nodes).toEqual(['bD', 'hp', 'hq']);
    expect(route('taxi pad padH via B H', at('bD', 'bD-bC'), hairpin)).toEqual({
      type: 'unable',
      reason: "taxiway B doesn't reach H in the direction of travel (they meet only through unnamed connectors from B/D)",
    });
  });

  it('is no connector with a fork in it: a stub off its middle makes it part of a network, not a turn', () => {
    const forked = indexAirport(
      loadAirport(testAirport, {
        formatVersion: 1,
        airport: 'TEST',
        nodes: { add: [{ id: 'cM', x: -1140, y: -300 }, { id: 'cS', x: -1200, y: -300 }] },
        edges: {
          remove: ['bE1-eW'],
          add: [
            { id: 'bE1-cM', kind: 'taxiway', from: 'bE1', to: 'cM' },
            { id: 'cM-eW', kind: 'taxiway', from: 'cM', to: 'eW' },
            { id: 'cM-cS', kind: 'taxiway', from: 'cM', to: 'cS' },
          ],
        },
      }),
    );
    expect(route('taxi penalty via D B E', at('dHS', 'r1D-dHS'), forked)).toEqual({ type: 'unable', reason: "taxiways B and E don't meet" });
  });

  it('takes the taxiway directly where it meets it, ignoring connectors from the same node', () => {
    // G leaves bF directly; an unnamed edge from bF also reaches a second piece of G at gX.
    const both = indexAirport(
      loadAirport(testAirport, {
        formatVersion: 1,
        airport: 'TEST',
        nodes: { add: [{ id: 'gX', x: 760, y: -300 }] },
        edges: { add: [{ id: 'bF-gX', kind: 'taxiway', from: 'bF', to: 'gX' }, { id: 'gX-gS', kind: 'taxiway', name: 'G', from: 'gX', to: 'gS' }] },
      }),
    );
    expect(pathOf(route('taxi hardstand via B G', at('bE2', 'bC-bE2'), both)).nodes).toEqual(['bE2', 'bF', 'gS', 'hsS1']);
  });

  it("explains a connector behind the aircraft: east on B, E's connector is back at bE1", () => {
    expect(route('taxi penalty via B E', at('bD', 'bE1-bD'), CONNECTOR)).toEqual({
      type: 'unable',
      reason: "taxiway B doesn't reach E in the direction of travel (they meet only through unnamed connectors from B near D)",
    });
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
    expect(route('taxi 9 via R:K', parked)).toEqual({ type: 'unable', reason: "can't turn right onto K at K near A with no heading" });
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
      reason: "taxiway A doesn't reach D in the direction of travel (they meet only at A/D)",
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
      reason: 'taxiway C is closed between C near runway 9/27 and B/C (Construction: Twy C closed between Rwy 9/27 and Twy B (synthetic))',
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
      reason: 'taxiway E is closed between B/E and E near B (test closure)',
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
      reason: 'taxiway A9 is closed between A/A9 and A9 near A (test closure)',
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
      reason: 'taxiway TC is closed between A/TC and TC near A (test closure)',
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
    expect(route('taxi 27 via A', parked)).toEqual({ type: 'unable', reason: "taxiway A can't be reached from near A/P1" });
  });

  it("leaves the departure line at the route's first taxiway, an exit ahead (docs/terse-syntax.md, C6)", () => {
    // Queued in 27's line on A at aH2: "exit the line at the next left, P1, hold on the pad".
    const path = pathOf(route('taxi pad via L:P1', at('aH2', 'r2A-aH2')));
    expect(path.nodes).toEqual(['aH2', 'aP1', 'npW', 'np1', 'npS1']);
    // Already past P1 at aP2: it can't go back.
    expect(route('taxi pad via L:P1', at('aP2', 'aP1-aP2'))).toEqual({
      type: 'unable',
      reason: "taxiway A doesn't reach P1 in the direction of travel (they meet only at A/P1)",
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
