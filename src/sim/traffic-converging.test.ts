// See-and-avoid (traffic.ts) for two aircraft converging on a junction, both moving: the later
// one yields. investigations/merge-throughput-17-takeoffs.md: on TEST, an arrival turning off C
// onto A and a departure taxiing east on A met at the C/A junction and collided; neither was on
// the other's track or at the junction until it was too late to stop.

import { describe, expect, it } from 'vitest';
import testAirport from '../../data/airports/TEST.json' with { type: 'json' };
import { indexAirport } from '../airport/graph.ts';
import { loadAirport } from '../airport/load.ts';
import { addAircraft, applyCommand, createSim, footprintsOverlap, getSession, step, type Sim } from './sim.ts';
import { nextStop } from './stops.ts';
import { parseTerse } from './terse.ts';
import { occupancyOf, trafficStop } from './traffic.ts';

const TEST = indexAirport(loadAirport(testAirport));

function transmit(sim: Sim, text: string): void {
  const result = parseTerse(text);
  if (!result.ok) throw new Error(`'${text}' doesn't parse: ${result.error.message}`);
  applyCommand(sim, result.command);
}

function aircraft(sim: Sim, callsign: string) {
  const ac = sim.world.aircraft.find((a) => a.callsign === callsign);
  if (!ac) throw new Error(`no ${callsign}`);
  return ac;
}

/** Steps `ticks`, failing at the first tick two footprints overlap. */
function stepClear(sim: Sim, ticks: number, pairs: [string, string][]): void {
  for (let t = 0; t < ticks; t++) {
    step(sim, 1);
    for (const [a, b] of pairs) {
      if (footprintsOverlap(sim, a, b)) throw new Error(`tick ${sim.world.tick}: ${a} and ${b} overlap`);
    }
  }
}

/**
 * ARR1 on C and DEP1 on A, both cleared through the C/A junction (aC) and moving: ARR1
 * `arrDistanceM` short of it at `arrV`, DEP1 `depDistanceM` short at `depV`.
 */
function converging(arrDistanceM: number, arrV: number, depDistanceM: number, depV: number, arrClearance = 'taxi ramp via C R:A TC'): Sim {
  const sim = createSim(TEST, { seed: 1 });
  // C runs 110 m from cHN north to aC; A 200 m from aTB east to aC.
  addAircraft(sim, { callsign: 'ARR1', type: 'A320', role: 'arrival', terminal: 'T2', at: { kind: 'edge', edge: 'aC-cHN', from: 'cHN', distanceM: 110 - arrDistanceM } });
  addAircraft(sim, { callsign: 'DEP1', type: 'A320', at: { kind: 'edge', edge: 'aTB-aC', from: 'aTB', distanceM: 200 - depDistanceM } });
  transmit(sim, `ARR1 ${arrClearance}`);
  transmit(sim, 'DEP1 taxi 27 via A, cross 36');
  const [arr, dep] = [aircraft(sim, 'ARR1'), aircraft(sim, 'DEP1')];
  expect([at(arr, 'aC') - arr.s, at(dep, 'aC') - dep.s]).toEqual([arrDistanceM, depDistanceM]);
  [arr.v, dep.v] = [arrV, depV];
  return sim;
}

/** Who `callsign`'s nearest traffic stop is for, and where (meters short of aC). null: none. */
function stopFor(sim: Sim, callsign: string): { behind: string; shortOfJunctionM: number } | null {
  const ac = aircraft(sim, callsign);
  const stop = trafficStop(sim.index, occupancyOf(sim), ac, 300);
  return stop === null ? null : { behind: stop.behind, shortOfJunctionM: at(ac, 'aC') - stop.at };
}

/** Meters along `ac`'s track to `node`'s first visit. */
function at(ac: ReturnType<typeof aircraft>, node: string): number {
  const i = ac.track.nodes.indexOf(node);
  const s = ac.track.nodeAt[i];
  if (i < 0 || s === undefined) throw new Error(`${ac.callsign}'s track doesn't pass ${node}`);
  return s;
}

describe('see-and-avoid: two aircraft converging on a junction', () => {
  it('TEST C/A junction: an arrival turning off C onto A and a departure on A, both starting about 100 m out, both get through without overlapping', () => {
    const sim = createSim(TEST, { seed: 1 });
    // The arrival, clear of 18/36 on C, northbound: 110 m to the junction (aC, 300,200).
    addAircraft(sim, { callsign: 'ARR1', type: 'A320', role: 'arrival', terminal: 'T2', at: { kind: 'node', node: 'cHN', arrivedVia: 'cHN-r1C' } });
    // The departure on A, eastbound, 100 m short of the junction.
    addAircraft(sim, { callsign: 'DEP1', type: 'A320', at: { kind: 'edge', edge: 'aTB-aC', from: 'aTB', distanceM: 100 } });
    transmit(sim, 'ARR1 taxi ramp via C R:A TC');
    transmit(sim, 'DEP1 taxi 27 via A, cross 36');
    const [arr, dep] = [aircraft(sim, 'ARR1'), aircraft(sim, 'DEP1')];

    // 2 min: both well past the junction at taxi speeds.
    stepClear(sim, 1200, [['ARR1', 'DEP1']]);
    expect(getSession(sim)).toEqual({ state: 'running' });
    expect(arr.s).toBeGreaterThan(at(arr, 'aC'));
    expect(dep.s).toBeGreaterThan(at(dep, 'aC'));
  });

  it('one that can no longer stop short goes first, even arriving later: DEP1 40 m out at 3 m/s (13 s) against ARR1 80 m out at 10 m/s (8 s)', () => {
    // A320 half-span 17.9 m, plus 20 m: DEP1's yield point is 2.1 m ahead, inside its 3 m to stop
    // at the hard limit. ARR1's is 42.1 m ahead, outside its 33.3 m.
    const sim = converging(80, 10, 40, 3);

    expect(stopFor(sim, 'ARR1')).toEqual({ behind: 'DEP1', shortOfJunctionM: expect.closeTo(17.9 + 20, 1) });
    expect(stopFor(sim, 'DEP1')).toBeNull();
  });

  it('an exact tie goes by callsign, and both then get through: both 60 m out, at rest', () => {
    const sim = converging(60, 0, 60, 0);

    expect(stopFor(sim, 'DEP1')).toEqual({ behind: 'ARR1', shortOfJunctionM: expect.closeTo(17.9 + 20, 1) });
    expect(stopFor(sim, 'ARR1')).toBeNull();
    stepClear(sim, 1200, [['ARR1', 'DEP1']]);
    expect(getSession(sim)).toEqual({ state: 'running' });
    const [arr, dep] = [aircraft(sim, 'ARR1'), aircraft(sim, 'DEP1')];
    expect(arr.s).toBeGreaterThan(at(arr, 'aC'));
    expect(dep.s).toBeGreaterThan(at(dep, 'aC'));
  });

  it("one held short of the junction isn't going through it, so no one yields to it: ARR1 at C's end, held short of A, against DEP1 on A 190 m out at 2 m/s", () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'ARR1', type: 'A320', role: 'arrival', terminal: 'T2', at: { kind: 'node', node: 'cHN', arrivedVia: 'cHN-r1C' } });
    addAircraft(sim, { callsign: 'DEP1', type: 'A320', at: { kind: 'edge', edge: 'aTB-aC', from: 'aTB', distanceM: 10 } });
    transmit(sim, 'ARR1 taxi ramp via C R:A TC hs A');
    transmit(sim, 'DEP1 taxi 27 via A, cross 36');
    const [arr, dep] = [aircraft(sim, 'ARR1'), aircraft(sim, 'DEP1')];
    // Its stop, short of A, comes before the junction.
    expect(nextStop(sim.index, arr)).toMatchObject({ kind: 'clearance-hold' });
    expect(nextStop(sim.index, arr).at).toBeLessThan(at(arr, 'aC'));
    // Not held, ARR1 would go first: 110 m at the 2 m/s floor (55 s) against 190 m at 2 m/s (95 s).
    expect([at(arr, 'aC') - arr.s, at(dep, 'aC') - dep.s]).toEqual([110, 190]);
    dep.v = 2;

    expect(stopFor(sim, 'DEP1')).toBeNull();
  });

  it("a follower on the same edge in isn't converging (in line covers it): DEP2 150 m out at 10 m/s behind DEP1 60 m out at rest", () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'DEP1', type: 'A320', at: { kind: 'edge', edge: 'aTB-aC', from: 'aTB', distanceM: 140 } });
    addAircraft(sim, { callsign: 'DEP2', type: 'A320', at: { kind: 'edge', edge: 'aTB-aC', from: 'aTB', distanceM: 50 } });
    transmit(sim, 'DEP1 taxi 27 via A, cross 36');
    transmit(sim, 'DEP2 taxi 27 via A, cross 36');
    const [lead, follower] = [aircraft(sim, 'DEP1'), aircraft(sim, 'DEP2')];
    expect([at(lead, 'aC') - lead.s, at(follower, 'aC') - follower.s]).toEqual([60, 150]);
    // By arrival time alone DEP2 would be first: 150 m at 10 m/s (15 s) against 60 m at the 2 m/s floor (30 s).
    follower.v = 10;

    expect(stopFor(sim, 'DEP1')).toBeNull();
    // In line: SPACING_M (20 m) behind DEP1's tail, well back from the 37.9 m a yield would give.
    expect(stopFor(sim, 'DEP2')).toEqual({ behind: 'DEP1', shortOfJunctionM: expect.closeTo(60 + 37.6 + 20, 0) });
  });
});
