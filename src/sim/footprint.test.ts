// Footprints (footprint.ts): the plan shape of an aircraft on the ground, for overlap (a
// collision, PRD §4.8, §8.6). Placed by hand on TEST: ground's and idle, so nothing moves them.

import { describe, expect, it } from 'vitest';
import testAirport from '../../data/airports/TEST.json' with { type: 'json' };
import { indexAirport } from '../airport/graph.ts';
import { loadAirport } from '../airport/load.ts';
import { addAircraft, createSim, footprintOf, footprintsOverlap, polygonsOverlap, type Sim } from './sim.ts';
import { buildTrack } from './track.ts';

const TEST = indexAirport(loadAirport(testAirport));

/** An aircraft of `type` on TEST, its track set to `nodes`/`edges` with the nose at `s`. */
function place(sim: Sim, callsign: string, type: string, nodes: string[], edges: string[], s: number): void {
  addAircraft(sim, { callsign, type, at: { kind: 'node', node: nodes[0] ?? '', arrivedVia: null } });
  const ac = sim.world.aircraft.find((a) => a.callsign === callsign);
  if (!ac) throw new Error('not added');
  ac.track = buildTrack(TEST, nodes, edges);
  ac.s = s;
}

describe('footprints', () => {
  it("don't overlap where the bodies wouldn't touch: a queued follower's nose by the corner of a leader that has turned (TEST aE, 1.12's sweep, seed 4)", () => {
    // A runs east at y = 200: aP2 x = 1400, aE x = 1500. A9 runs south from aE: a9I y = 150.
    // As found at tick 7526: the leader, a B738 (39.5 m long, 35.8 m span), has turned south onto
    // A9 and stopped with its tail 11 m south of A's centreline. The follower, a B738 east on A,
    // has its nose 17.74 m short of aE. A span × length box puts the leader's tail at full
    // half-span, across the follower's nose box; neither has structure there.
    const sim = createSim(TEST, { seed: 1 });
    place(sim, 'DAL4', 'B738', ['aP2', 'aE', 'a9I', 'a9H'], ['aP2-aE', 'aE-a9I', 'a9I-a9H'], 100 + 39.5 + 11);
    place(sim, 'DAL5', 'B738', ['aP2', 'aE'], ['aP2-aE'], 100 - 17.74);
    expect(footprintsOverlap(sim, 'DAL4', 'DAL5')).toBe(false);
  });

  it("overlap when a nose reaches a fuselage's side, and not a metre short of it (TEST: an A388 north on D into an E175 on A, ahead of its wing)", () => {
    // A is y = 200 (a7 x = −800, aD x = −300); D runs north to aD (dHN y = 90, dI y = 150).
    // The E175 (31.7 m long) has its nose 4.75 m east of aD, so D crosses its forward fuselage,
    // 3.2 m wide there and ahead of its wing (9.5 m behind its nose). The A388's own wing is
    // 21.8 m behind its nose: its fuselage is all that can reach.
    const at = (noseY: number) => {
      const sim = createSim(TEST, { seed: 1 });
      place(sim, 'EJA1', 'E175', ['a7', 'aD', 'aTB'], ['a7-aD', 'aD-aTB'], 500 + 4.75);
      place(sim, 'UAE1', 'A388', ['dHN', 'dI', 'aD'], ['dI-dHN', 'aD-dI'], 110 - (200 - noseY));
      return footprintsOverlap(sim, 'EJA1', 'UAE1');
    };
    const side = 200 - (0.11 * 31.7) / 2;
    expect(at(side + 0.75)).toBe(true);
    expect(at(side - 1)).toBe(false);
  });

  it("overlap when a wing reaches another's wing, with neither nose near a fuselage; not when it's a metre short (TEST: two A320s at D and A)", () => {
    // The A320 on A (37.6 m long, 35.8 m span) has its nose 8 m east of aD: its wing is 11.3 to
    // 25.6 m behind its nose (x −317.6 to −303.3), out to 17.9 m either side of A (y 182.1 to 217.9).
    // The one north on D stops short of A's centreline: its nose clear of the other's fuselage
    // (y 197.9), its wing the same 11.3 to 25.6 m behind its nose, across x −318 to −282.
    const at = (noseY: number) => {
      const sim = createSim(TEST, { seed: 1 });
      place(sim, 'DAL1', 'A320', ['a7', 'aD', 'aTB'], ['a7-aD', 'aD-aTB'], 500 + 8);
      place(sim, 'JBU1', 'A320', ['dHN', 'dI', 'aD'], ['dI-dHN', 'aD-dI'], 110 - (200 - noseY));
      return footprintsOverlap(sim, 'DAL1', 'JBU1');
    };
    const wingFront = 0.3 * 37.6;
    expect(at(197)).toBe(true);
    expect(at(200 - 35.8 / 2 + wingFront - 1)).toBe(false);
  });

  it('list every corner of their three parts (what the reservations hull), and refuse to be read as one polygon without them', () => {
    const sim = createSim(TEST, { seed: 1 });
    place(sim, 'DAL1', 'A320', ['a7', 'aD', 'aTB'], ['a7-aD', 'aD-aTB'], 500);
    const ac = sim.world.aircraft[0];
    if (!ac) throw new Error('no aircraft');
    const shape = footprintOf(ac);
    expect(shape.parts).toHaveLength(3);
    expect([...shape]).toEqual(shape.parts.flat());
    // Eastbound at y = 200, nose at aD (x = −300): the wingtips are the widest corners.
    const ys = shape.map((p) => p[1]);
    expect(Math.min(...ys)).toBeCloseTo(200 - 35.8 / 2, 9);
    expect(Math.max(...ys)).toBeCloseTo(200 + 35.8 / 2, 9);
    expect(() => polygonsOverlap([...shape], shape)).toThrow(/isn't convex/);
  });
});
