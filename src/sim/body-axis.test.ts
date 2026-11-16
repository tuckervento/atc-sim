// The body's axis (footprint.ts): from the main gear, a point on the track MAIN_GEAR_FROM of the
// length behind the nose, to the nose. The sim's view exposes it as bodyHeadingDeg, and the
// footprint lies along it. Placed by hand on TEST, where A runs east at y = 200 (aP2 x = 1400,
// aE x = 1500) and A9 turns south from aE (a9I y = 150): a 90° right turn at aE.

import { describe, expect, it } from 'vitest';
import testAirport from '../../data/airports/TEST.json' with { type: 'json' };
import { indexAirport } from '../airport/graph.ts';
import { loadAirport } from '../airport/load.ts';
import { MAIN_GEAR_FROM } from './footprint.ts';
import { AIRCRAFT_TYPES, addAircraft, createSim, footprintOf, getAircraft, type Sim } from './sim.ts';
import { buildTrack, pointOf } from './track.ts';

const TEST = indexAirport(loadAirport(testAirport));
const BEND = { nodes: ['aP2', 'aE', 'a9I', 'a9H'], edges: ['aP2-aE', 'aE-a9I', 'a9I-a9H'] };
/** aE's distance along BEND. */
const CORNER = 100;

/** An aircraft of `type` on TEST, its track set to `nodes`/`edges` with the nose at `s`. */
function place(sim: Sim, callsign: string, type: string, nodes: string[], edges: string[], s: number): void {
  addAircraft(sim, { callsign, type, at: { kind: 'node', node: nodes[0] ?? '', arrivedVia: null } });
  const ac = sim.world.aircraft.find((a) => a.callsign === callsign);
  if (!ac) throw new Error('not added');
  ac.track = buildTrack(TEST, nodes, edges);
  ac.s = s;
}

/** Degrees clockwise from north, from `a` to `b`. */
function bearing(a: readonly number[], b: readonly number[]): number {
  const [dx, dy] = [(b[0] ?? NaN) - (a[0] ?? NaN), (b[1] ?? NaN) - (a[1] ?? NaN)];
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

describe('the body axis', () => {
  it("points from the main gear (on the track, MAIN_GEAR_FROM of the length behind the nose) to the nose: in a bend it's between the two legs' headings", () => {
    const sim = createSim(TEST, { seed: 1 });
    // An A320 (37.6 m) with its nose 10 m into the turn south: its main gear is still on A.
    place(sim, 'DAL1', 'A320', BEND.nodes, BEND.edges, CORNER + 10);
    const view = getAircraft(sim, 'DAL1');
    const track = buildTrack(TEST, BEND.nodes, BEND.edges);
    const gear = pointOf(track, CORNER + 10 - MAIN_GEAR_FROM * 37.6).point;
    expect(gear[1]).toBe(200);
    expect(view.headingDeg).toBeCloseTo(180, 9);
    expect(view.bodyHeadingDeg).toBeCloseTo(bearing(gear, view.nose), 9);
    expect(view.bodyHeadingDeg).toBeGreaterThan(90);
    expect(view.bodyHeadingDeg).toBeLessThan(180);
  });

  it("is the footprint's axis too: in the bend, the fuselage runs back from the nose along bodyHeadingDeg", () => {
    const sim = createSim(TEST, { seed: 1 });
    place(sim, 'DAL1', 'A320', BEND.nodes, BEND.edges, CORNER + 10);
    const ac = sim.world.aircraft[0];
    if (!ac) throw new Error('no aircraft');
    const view = getAircraft(sim, 'DAL1');
    // The fuselage's corners: nose left, nose right, tail right, tail left.
    const [nl, nr, tr, tl] = footprintOf(ac).parts[0] ?? [];
    if (!nl || !nr || !tr || !tl) throw new Error('no fuselage');
    const noseMid = [(nl[0] + nr[0]) / 2, (nl[1] + nr[1]) / 2];
    const tailMid = [(tl[0] + tr[0]) / 2, (tl[1] + tr[1]) / 2];
    expect(noseMid[0]).toBeCloseTo(view.nose[0], 9);
    expect(noseMid[1]).toBeCloseTo(view.nose[1], 9);
    expect(Math.hypot((noseMid[0] ?? 0) - (tailMid[0] ?? 0), (noseMid[1] ?? 0) - (tailMid[1] ?? 0))).toBeCloseTo(37.6, 9);
    expect(bearing(tailMid, noseMid)).toBeCloseTo(view.bodyHeadingDeg ?? NaN, 9);
  });

  it("swings the tail out of the path behind it by at most 0.6 of the length through TEST's sharp 90° corner, where turning about the nose swings it out by the whole length", () => {
    // The tail drawn along each heading, `lengthM` back from the nose, and its distance from the
    // path the body has come along (the track from 10 m behind the tail to the nose). At a
    // corner with no fillet, a body pivoting on its main gear swings its tail out by
    // (1 − MAIN_GEAR_FROM)·L·sin, at most about 0.59 L; turning about the nose, it swings the
    // whole length out the moment the nose turns.
    const track = buildTrack(TEST, BEND.nodes, BEND.edges);
    const offset = (tail: readonly number[], s: number, length: number) => {
      let best = Infinity;
      for (let t = s - length - 10; t <= s; t += 0.05) {
        const p = pointOf(track, t).point;
        best = Math.min(best, Math.hypot((tail[0] ?? NaN) - p[0], (tail[1] ?? NaN) - p[1]));
      }
      return best;
    };
    const tailAlong = (nose: readonly number[], headingDeg: number | null, length: number) => {
      const rad = ((headingDeg ?? NaN) * Math.PI) / 180;
      return [(nose[0] ?? NaN) - Math.sin(rad) * length, (nose[1] ?? NaN) - Math.cos(rad) * length];
    };
    for (const [type, length] of [['E175', 31.7], ['A320', 37.6], ['B77W', 73.9]] as const) {
      let [body, nosePivot] = [0, 0];
      for (let s = CORNER + 0.25; s <= CORNER + length; s += 0.25) {
        const sim = createSim(TEST, { seed: 1 });
        place(sim, 'DAL1', type, BEND.nodes, BEND.edges, s);
        const view = getAircraft(sim, 'DAL1');
        body = Math.max(body, offset(tailAlong(view.nose, view.bodyHeadingDeg, length), s, length));
        nosePivot = Math.max(nosePivot, offset(tailAlong(view.nose, view.headingDeg, length), s, length));
      }
      expect(nosePivot).toBeGreaterThan(0.99 * length);
      expect(body).toBeLessThan(0.6 * length);
    }
  });

  it("puts the main gear within 0.03 of the length of every type's published (or estimated) position (aircraft-types.ts)", () => {
    // The footprint knows only length and span (the reservations ask for bodies by those alone),
    // so the gear is one fraction of the length for every type. This keeps the fraction honest.
    for (const [type, t] of Object.entries(AIRCRAFT_TYPES)) {
      expect({ type, off: Math.abs(t.mainGearM / t.lengthM - MAIN_GEAR_FROM) <= 0.03 }).toEqual({ type, off: true });
    }
  });

  it("is the track's heading on a straight, wherever the nose is on it (even with less trail than the main gear's distance); none with no heading", () => {
    for (const s of [0, 5, 40, 99.5]) {
      const sim = createSim(TEST, { seed: 1 });
      place(sim, 'DAL1', 'B77W', BEND.nodes, BEND.edges, s);
      const view = getAircraft(sim, 'DAL1');
      expect(view.headingDeg).toBeCloseTo(90, 9);
      expect(view.bodyHeadingDeg).toBeCloseTo(90, 9);
    }
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL2', type: 'A320', at: { kind: 'node', node: 'aE', arrivedVia: null } });
    const parked = getAircraft(sim, 'DAL2');
    expect(parked.headingDeg).toBeNull();
    expect(parked.bodyHeadingDeg).toBeNull();
  });
});
