// The simulated ramp never deadlocks itself (PLAN 1.11, PRD §8.3, §9.3): opposing ramp movements
// in one lane, across 100 seeds, each complete within a bound, with no two footprints overlapping.

import { describe, expect, it } from 'vitest';
import kjfkBase from '../../data/airports/KJFK.json' with { type: 'json' };
import kjfkOverrides from '../../data/airports/KJFK.overrides.json' with { type: 'json' };
import testAirport from '../../data/airports/TEST.json' with { type: 'json' };
import { indexAirport, type AirportIndex } from '../airport/graph.ts';
import { loadAirport } from '../airport/load.ts';
import { footprintOf, polygonsOverlap } from './footprint.ts';
import { departurePlanFor } from './ramp.ts';
import { createRng, nextFloat, type Rng } from './rng.ts';
import { addAircraft, applyCommand, createSim, drainEvents, getAircraft, removeAircraft, stateHash, step, type Sim } from './sim.ts';
import { parseTerse } from './terse.ts';

const TEST = indexAirport(loadAirport(testAirport));
const KJFK = indexAirport(loadAirport(kjfkBase, kjfkOverrides));

function transmit(sim: Sim, text: string): void {
  const result = parseTerse(text);
  if (!result.ok) throw new Error(`'${text}' doesn't parse: ${result.error.message}`);
  applyCommand(sim, result.command);
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.floor(nextFloat(rng) * items.length)];
  if (item === undefined) throw new Error('pick from nothing');
  return item;
}

interface Shape {
  callsign: string;
  corners: ReturnType<typeof footprintOf>;
  box: readonly [number, number, number, number];
  moving: boolean;
}

/**
 * Pairs of aircraft on the ground whose footprints overlap, where at least one is moving (two
 * parked aircraft don't change). A bounding-box test first, then the exact one.
 */
function overlaps(sim: Sim, parkedShapes: Map<string, Shape>): string[] {
  const ground = sim.world.aircraft.filter((a) => !a.airborne);
  const moving = (a: (typeof ground)[number]) => a.v > 0 || a.status === 'pushing-back';
  if (!ground.some(moving)) return [];
  const shapes = ground.map((a) => {
    // A parked aircraft doesn't move until its status changes: its shape is kept.
    const kept = a.status === 'parked' ? parkedShapes.get(a.callsign) : undefined;
    if (kept) return kept;
    const corners = footprintOf(a);
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    const shape: Shape = { callsign: a.callsign, corners, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], moving: moving(a) };
    if (a.status === 'parked') parkedShapes.set(a.callsign, shape);
    else parkedShapes.delete(a.callsign);
    return shape;
  });
  const found: string[] = [];
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const [p, q] = [shapes[i], shapes[j]];
      if (!p || !q || (!p.moving && !q.moving)) continue;
      if (p.box[2] <= q.box[0] || q.box[2] <= p.box[0] || p.box[3] <= q.box[1] || q.box[3] <= p.box[1]) continue;
      if (polygonsOverlap(p.corners, q.corners)) found.push(`${p.callsign}/${q.callsign}`);
    }
  }
  return found;
}

/**
 * A scenario: departures at gates, and arrivals the player brings to a ramp entrance one after
 * another at random times, handing each to ramp. The player takes each departure away at its
 * check-in. Runs until every one is done; returns the tick it took, or throws.
 */
interface Scenario {
  index: AirportIndex;
  departures: { callsign: string; gate: string }[];
  /** Where each arrival appears, and the clearance that takes it to the entrance. */
  arrival: { node: string; arrivedVia: string; terminal: string; clearance: string };
  arrivals: number;
  types: readonly string[];
  /** Seconds: each arrival appears 30 s plus up to this long after the last was taken by ramp. */
  arrivalGapS: number;
  /** Aircraft parked for the whole run (fillers). */
  parked?: { callsign: string; type: string; gate: string }[];
  boundTicks: number;
}

function run(scenario: Scenario, seed: number): { ticks: number; checkIns: number; atGate: number } {
  const sim = createSim(scenario.index, { seed });
  const rng = createRng(seed * 7919 + 1);
  for (const p of scenario.parked ?? []) addAircraft(sim, { ...p, role: 'arrival', at: { kind: 'gate', gate: p.gate } });
  for (const d of scenario.departures) addAircraft(sim, { callsign: d.callsign, type: pick(rng, scenario.types), at: { kind: 'gate', gate: d.gate } });
  let spawned = 0;
  let nextArrivalTick = Math.round(nextFloat(rng) * scenario.arrivalGapS * 10);
  let waitingFor: string | null = null;
  let checkIns = 0;
  let atGate = 0;
  const parkedShapes = new Map<string, Shape>();
  const done = () => checkIns === scenario.departures.length && atGate === scenario.arrivals;
  while (!done()) {
    if (sim.world.tick >= scenario.boundTicks) {
      const states = sim.world.aircraft.filter((a) => a.controller !== 'ramp' || a.status !== 'parked').map((a) => `${a.callsign}:${a.controller}/${a.status}`);
      throw new Error(`seed ${seed}: not done after ${scenario.boundTicks} ticks (${checkIns} check-ins, ${atGate} at gate): ${states.join(' ')}`);
    }
    if (waitingFor === null && spawned < scenario.arrivals && sim.world.tick >= nextArrivalTick) {
      const callsign = `ARR${++spawned}`;
      const { node, arrivedVia, terminal, clearance } = scenario.arrival;
      addAircraft(sim, { callsign, type: pick(rng, scenario.types), role: 'arrival', terminal, at: { kind: 'node', node, arrivedVia } });
      transmit(sim, `${callsign} ${clearance}, monitor ramp`);
      waitingFor = callsign;
    }
    step(sim, 1);
    for (const e of drainEvents(sim)) {
      if (e.type === 'unable' || e.type === 'ambiguous') throw new Error(`seed ${seed}: ${e.callsign} ${e.type}`);
      if (e.type === 'check-in') {
        checkIns += 1;
        removeAircraft(sim, e.callsign);
      }
      if (e.type === 'arrived-at-gate') atGate += 1;
      if (e.type === 'ramp-accepted' && e.callsign === waitingFor) {
        waitingFor = null;
        // At least 30 s, so the last one is clear of where the next appears.
        nextArrivalTick = sim.world.tick + Math.round((30 + nextFloat(rng) * scenario.arrivalGapS) * 10);
      }
    }
    const hit = overlaps(sim, parkedShapes);
    if (hit.length > 0) throw new Error(`seed ${seed}, tick ${sim.world.tick}: footprints overlap: ${hit.join(', ')}`);
  }
  return { ticks: sim.world.tick, checkIns, atGate };
}

/**
 * Two simulated hours at TEST with ramp and tower together: the tower lands a stream on 27, the
 * ramp spawns departures at T1 and T2, and a scripted player taxis each departure from its
 * check-in to 27 (handing it to tower), each arrival from its exit to T2's ramp (handing it to
 * ramp), and removes parked arrivals after a 1-minute turnaround. Checks every tick that on the
 * ground, motion is backward only in a pushback. Returns the state hash every 10 minutes.
 */
function longRun(seed: number): { hashes: string[]; counts: Record<string, number> } {
  const sim = createSim(TEST, {
    seed,
    arrivals: [{ runwayEnd: '27', perHour: 8, flight: (n) => ({ callsign: `BAW${n + 1}`, type: n % 3 ? 'A320' : 'B738', airline: 'BAW', terminal: 'T2' }) }],
    departures: [
      { perHour: 6, flight: (n) => ({ callsign: `JBU${n + 1}`, type: 'A320', airline: 'JBU', terminal: 'T1' }) },
      { perHour: 6, firstAtS: 120, flight: (n) => ({ callsign: `AFR${n + 1}`, type: n % 2 ? 'A321' : 'A320', airline: 'AFR', terminal: 'T2' }) },
    ],
  });
  const counts: Record<string, number> = {};
  const hashes: string[] = [];
  const turnaround = new Map<string, number>();
  let last = new Map<string, { track: string; s: number; nose: [number, number]; heading: number | null; pushing: boolean }>();
  for (let t = 1; t <= 2 * 60 * 60 * 10; t++) {
    step(sim, 1);
    for (const [callsign, tick] of turnaround) {
      if (sim.world.tick < tick) continue;
      removeAircraft(sim, callsign);
      turnaround.delete(callsign);
    }
    for (const e of drainEvents(sim)) {
      counts[e.type] = (counts[e.type] ?? 0) + 1;
      if (e.type === 'unable' || e.type === 'ambiguous') throw new Error(`seed ${seed}: ${e.callsign} ${e.type}`);
      if (e.type === 'check-in') transmit(sim, `${e.callsign} taxi 27 via ${e.taxilane === '7' ? '#7' : e.taxilane} L:A, cross 36, monitor tower`);
      if (e.type === 'arrived-at-gate') turnaround.set(e.callsign, sim.world.tick + 600);
      if (e.type === 'clear-of-runway') {
        // From C or the north side of D, A leads east to TC; from D's south side there's no short way.
        const exitTaxiway = e.exit ?? '';
        if (e.exitId === 'x27DS') {
          counts['no route'] = (counts['no route'] ?? 0) + 1;
          removeAircraft(sim, e.callsign);
        } else transmit(sim, `${e.callsign} taxi ramp via ${exitTaxiway} R:A TC, monitor ramp`);
      }
    }
    // Backward only in a pushback: on an unchanged track, s never decreases; when the track is
    // replaced, the nose never moves against its heading.
    const now = new Map<string, { track: string; s: number; nose: [number, number]; heading: number | null; pushing: boolean }>();
    for (const ac of sim.world.aircraft) {
      if (ac.airborne) continue;
      const view = getAircraft(sim, ac.callsign);
      const track = `${ac.track.nodes.join(',')}|${ac.track.nodeAt.at(-1)}`;
      const entry = { track, s: ac.s, nose: view.nose, heading: view.headingDeg, pushing: ac.status === 'pushing-back' };
      now.set(ac.callsign, entry);
      const before = last.get(ac.callsign);
      // Pushing back now (including the tick it starts, on its new push track) is the exception.
      // The switch from the push to the taxi-out isn't: its nose must stay put.
      if (!before || entry.pushing) continue;
      if (before.track === track) {
        if (ac.s < before.s) throw new Error(`seed ${seed}, tick ${sim.world.tick}: ${ac.callsign} went back from ${before.s} to ${ac.s} (${ac.status})`);
      } else if (before.heading !== null) {
        const rad = (before.heading * Math.PI) / 180;
        const along = (entry.nose[0] - before.nose[0]) * Math.sin(rad) + (entry.nose[1] - before.nose[1]) * Math.cos(rad);
        if (along < -1e-6) throw new Error(`seed ${seed}, tick ${sim.world.tick}: ${ac.callsign} moved ${along} m backward on a new track`);
      }
    }
    last = now;
    if (t % (10 * 60 * 10) === 0) hashes.push(stateHash(sim));
  }
  return { hashes, counts };
}

describe('ramp and tower together', () => {
  it('over two simulated hours: backward motion only in pushbacks; the same seed gives the same state hash all the way (TEST)', () => {
    const first = longRun(1);
    // It flowed: departures pushed, checked in and took off; arrivals reached their gates.
    expect(first.counts['pushback']).toBeGreaterThanOrEqual(20);
    expect(first.counts['check-in']).toBe(first.counts['pushback']);
    expect(first.counts['took-off']).toBeGreaterThanOrEqual(18);
    expect(first.counts['arrived-at-gate']).toBeGreaterThanOrEqual(8);
    expect(first.hashes).toHaveLength(12);
    expect(longRun(1).hashes).toEqual(first.hashes);
    const other = longRun(2).hashes;
    expect(other.at(-1)).not.toBe(first.hashes.at(-1));
  }, 60_000);
});

describe('opposing ramp movements in one lane', () => {
  it('complete without deadlock or overlap across 100 seeds: two departures pushing into TD, two arrivals coming in along it (TEST T2)', () => {
    const scenario: Scenario = {
      index: TEST,
      // B1's push swings its tail east onto tdA–tdB, B2's onto tdB–tdE: the lane arrivals from TC use.
      departures: [
        { callsign: 'DEP1', gate: 'T2-B1' },
        { callsign: 'DEP2', gate: 'T2-B2' },
      ],
      arrival: { node: 'aTC', arrivedVia: 'aTC-aJ', terminal: 'T2', clearance: 'taxi ramp via TC' },
      arrivals: 2,
      // Every type T2's 80 m stands take.
      types: ['E175', 'A320', 'A321', 'B738', 'B739', 'B763'],
      arrivalGapS: 150,
      boundTicks: 30 * 60 * 10,
    };
    for (let seed = 1; seed <= 100; seed++) {
      expect(run(scenario, seed)).toMatchObject({ checkIns: 2, atGate: 2 });
    }
  }, 60_000);

  it('complete without deadlock or overlap across 100 seeds: departures out to Kilo Foxtrot against arrivals in from Kilo Golf, in one T4 alley (KJFK)', () => {
    // Arrivals from KG to 793, 795 and 797 come up the lane that departures from 794, 796 and 798
    // push into and taxi out along to KF. Every other usable T4 gate is taken, so those are the
    // arrivals' gates (and the departures', once they've left).
    const alley = ['g1009800793', 'g1009800794', 'g1009800795', 'g1009800796', 'g1009800797', 'g1009800798'];
    const probe = createSim(KJFK, { seed: 1 });
    const fillers = KJFK.airport.gates.filter((g) => g.terminal === 'T4' && !alley.includes(g.id) && !('unable' in departurePlanFor(probe, g.id, 'E175')));
    const scenario: Scenario = {
      index: KJFK,
      departures: [
        { callsign: 'DEP1', gate: 'g1009800794' },
        { callsign: 'DEP2', gate: 'g1009800796' },
        { callsign: 'DEP3', gate: 'g1009800798' },
      ],
      arrival: { node: 'n45379510', arrivedVia: 'w5786355-n45352239-n45379510', terminal: 'T4', clearance: 'taxi ramp via KG' },
      arrivals: 3,
      // The types all six gates take.
      types: ['E175', 'A320', 'B738'],
      arrivalGapS: 120,
      parked: fillers.map((g, i) => ({ callsign: `PRK${i + 1}`, type: 'E175', gate: g.id })),
      boundTicks: 40 * 60 * 10,
    };
    expect(fillers.length).toBeGreaterThan(0);
    for (let seed = 1; seed <= 100; seed++) {
      expect(run(scenario, seed)).toMatchObject({ checkIns: 3, atGate: 3 });
    }
  }, 120_000);
});
