// See-and-avoid (traffic.ts) where the airport graph understates nearness: two nodes close in
// the plane with no edge between them. The seed-6 head-on (investigations/seed6-head-on.md):
// KJFK's T7 has two ramp edges named W, rhW and rhW2, 2.4 m apart, each 11 m from the same fork
// on W. A departure idle at one is on no edge of an arrival's track to the other, nor on any edge
// at a node of it, so neither the in-line nor the occupied-node rule saw it.

import { describe, expect, it } from 'vitest';
import kjfkBase from '../../data/airports/KJFK.json' with { type: 'json' };
import kjfkOverrides from '../../data/airports/KJFK.overrides.json' with { type: 'json' };
import { indexAirport } from '../airport/graph.ts';
import { loadAirport } from '../airport/load.ts';
import { addAircraft, applyCommand, createSim, footprintsOverlap, getSession, step, type Sim } from './sim.ts';
import { parseTerse } from './terse.ts';

const KJFK = indexAirport(loadAirport(kjfkBase, kjfkOverrides));

/**
 * KJFK with T7's twin W ramp edges as seed 6 found them: rhW2's node 2.4 m from rhW, its own stub
 * off W's fork and its lane, joined to rhW by nothing. 1.13c merged the twins in the data (Q);
 * the footprint rule's regression tests keep the real geometry that broke the graph-only rules.
 */
const KJFK_TWINS = indexAirport(
  loadAirport(kjfkBase, {
    ...kjfkOverrides,
    nodes: { ...kjfkOverrides.nodes, remove: kjfkOverrides.nodes.remove.filter((n) => n !== 'n9328526607') },
    edges: {
      ...kjfkOverrides.edges,
      patch: [...kjfkOverrides.edges.patch, { id: 'w1011116770-n9328549521-n9328526607', name: 'W' }],
      add: kjfkOverrides.edges.add.filter((e) => e.id !== 'x13c-W2-lane'),
      remove: kjfkOverrides.edges.remove.filter((id) => !['w1011116770-n9328549521-n9328526607', 'w1011116770-n9328526607-n9328549519'].includes(id)),
    },
    rampHandoffs: { ...kjfkOverrides.rampHandoffs, add: [...kjfkOverrides.rampHandoffs.add, { id: 'rhW2', name: 'W', node: 'n9328526607', use: 'both', terminals: ['T7'] }] },
  }),
);

/** T7's twin W ramp edges (KJFK_TWINS), the fork on W they share, and the W edge before the fork. */
const RH_W = 'n9328534916';
const RH_W2 = 'n9328526607';
const RH_W2_LANE = 'w1011116770-n9328526607-n9328549519';
const W_BEFORE_FORK = 'w1256904562-n2994352435-n2994352438';

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

describe('see-and-avoid at nodes close in the plane but not joined in the graph', () => {
  it('KJFK T7 twin W ramp edges (seed-6 head-on): an arrival taxiing in to rhW stops short of a departure idle at rhW2, 2.4 m away', () => {
    const sim = createSim(KJFK_TWINS, { seed: 1 });
    // The departure, checked in and left idle: ground's, nose on rhW2, its body back along the lane.
    addAircraft(sim, { callsign: 'DEP1', type: 'B738', terminal: 'T7', at: { kind: 'node', node: RH_W2, arrivedVia: RH_W2_LANE } });
    // The arrival on W, past 31R, heading for the fork.
    addAircraft(sim, { callsign: 'ARR1', type: 'A333', role: 'arrival', terminal: 'T7', at: { kind: 'edge', edge: W_BEFORE_FORK, from: 'n2994352438', distanceM: 80 } });
    transmit(sim, 'ARR1 taxi ramp T7 via W');
    const arr = aircraft(sim, 'ARR1');
    // The geometry under test: the route ends at rhW, not at the departure's own node.
    expect(arr.track.nodes.at(-1)).toBe(RH_W);

    // 90 s: well past the time to reach rhW (about 130 m at up to 20 kt).
    stepClear(sim, 900, [['ARR1', 'DEP1']]);
    expect(getSession(sim)).toEqual({ state: 'running' });
    expect(arr.v).toBe(0);
    expect(arr.blockedBy).toBe('DEP1');
    expect(arr.s).toBeLessThan(arr.track.lengthM);
  });

  // A body the graph does find, but only far along the track: past a sharp bend. KJFK's NA stub
  // leaves A northbound and doubles back south-east to T1's ramp edge rhNA. An aircraft standing
  // on it has its wing and tailplane over A, beside the approach, though along the track it's
  // past the bend. The in-line rule's stop, SPACING_M short of its tail along the track, is
  // already inside its footprint. (Found by the app-traffic sweep, seed 8, after the first fix.)
  it('KJFK T1 rhNA: an aircraft taxiing up A to NA stops short of one standing on the NA stub, whose wing is over A before the bend', () => {
    const sim = createSim(KJFK, { seed: 1 });
    addAircraft(sim, { callsign: 'DLH1', type: 'A333', role: 'arrival', terminal: 'T1', at: { kind: 'node', node: 'n1743728095', arrivedVia: 'w403398896-n4057452593-n1743728095' } });
    addAircraft(sim, { callsign: 'LOT1', type: 'B789', role: 'arrival', terminal: 'T1', at: { kind: 'edge', edge: 'w1356437398-n2994352436-n1743722028', from: 'n1743722028', distanceM: 70 } });
    transmit(sim, 'LOT1 taxi ramp T1 via A NA');
    const lot = aircraft(sim, 'LOT1');
    expect(lot.track.nodes.at(-1)).toBe('n1743728095');

    stepClear(sim, 900, [['LOT1', 'DLH1']]);
    expect(getSession(sim)).toEqual({ state: 'running' });
    expect(lot.v).toBe(0);
    expect(lot.blockedBy).toBe('DLH1');
  });

  // The ramp's departure from T7 gate 10 taxis out along the rhW2 lane (53 m) and checks in at
  // rhW2; ground's arrival comes down W to rhW. Head-on, 162° apart, and neither ever on an edge
  // of the other's track. Before the footprint rule, every one of these timings collided.
  for (const leadTicks of [0, 60, 120]) {
    it(`KJFK T7 twin W ramp edges, both moving head-on (the arrival starts ${leadTicks / 10} s before the departure taxis out): whoever gets there first stops at its end, the other stops short, blocked by it; they never overlap`, () => {
      const sim = createSim(KJFK_TWINS, { seed: 1 });
      addAircraft(sim, { callsign: 'DEP2', type: 'B738', at: { kind: 'gate', gate: 'g1011116768' } });
      const record = () => sim.world.ramp.aircraft.find((r) => r.callsign === 'DEP2');
      for (let t = 0; record()?.phase !== 'pushed'; t++) {
        if (t > 20_000) throw new Error('DEP2 never finished its pushback');
        step(sim, 1);
      }
      const pushed = record();
      if (!pushed) throw new Error('no DEP2 record');
      // It taxis out PUSH_SETTLE_S (30 s) after the push ends.
      step(sim, pushed.since + 300 - leadTicks - sim.world.tick);
      addAircraft(sim, { callsign: 'ARR2', type: 'A333', role: 'arrival', terminal: 'T7', at: { kind: 'edge', edge: W_BEFORE_FORK, from: 'n2994352438', distanceM: 80 } });
      transmit(sim, 'ARR2 taxi ramp T7 via W');
      const [dep, arr] = [aircraft(sim, 'DEP2'), aircraft(sim, 'ARR2')];
      expect(arr.track.nodes.at(-1)).toBe(RH_W);

      stepClear(sim, 1200, [['ARR2', 'DEP2']]);
      expect(getSession(sim)).toEqual({ state: 'running' });
      expect([dep.v, arr.v]).toEqual([0, 0]);
      // One is at its end (the ramp edge it was going to); the other short of its own, blocked by it.
      const short = [dep, arr].filter((ac) => ac.s < ac.track.lengthM);
      expect(short).toHaveLength(1);
      const [waiting] = short;
      expect(waiting?.blockedBy).toBe(waiting === dep ? 'ARR2' : 'DEP2');
    });
  }
});
