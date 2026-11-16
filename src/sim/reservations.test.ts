// The reservation engine (reservations.ts), on its own: movements driven by hand, no controller.

import { describe, expect, it } from 'vitest';
import testAirport from '../../data/airports/TEST.json' with { type: 'json' };
import { indexAirport } from '../airport/graph.ts';
import { loadAirport } from '../airport/load.ts';
import { admit, dropMovement, finishMovement, reserveParked, reservedStop, SEGMENT_M, setLeg, updateReservations, type Leg, type MovementSpec } from './reservations.ts';
import { addAircraft, createSim, footprintsOverlap, removeAircraft, type Sim } from './sim.ts';
import { buildTrack } from './track.ts';
import { occupancyOf, trafficStop } from './traffic.ts';

const TEST = indexAirport(loadAirport(testAirport));

/** An aircraft of `type` on TEST, its track set to `nodes`/`edges` with the nose at `s`. Ground's and idle: nothing moves it but the test. */
function place(sim: Sim, callsign: string, type: string, nodes: string[], edges: string[], s: number): void {
  const first = nodes[0] ?? '';
  addAircraft(sim, { callsign, type, at: { kind: 'node', node: first, arrivedVia: null } });
  const ac = sim.world.aircraft.find((a) => a.callsign === callsign);
  if (!ac) throw new Error('not added');
  ac.track = buildTrack(TEST, nodes, edges);
  ac.s = s;
}

function record(sim: Sim, id: string) {
  const r = sim.world.reservations.movements.find((m) => m.id === id);
  if (!r) throw new Error(`no record for ${id}`);
  return r;
}

/**
 * Moves each listed movement's nose up to its limit at `speedMps`, leg by leg (a stand-in for
 * the controllers and movement.ts), one tick at a time. One that leaves is taken away at its end
 * (the player has it). Fails on any footprint overlap. Returns the tick each finished, or throws
 * after `maxTicks` with the records' states.
 */
function drive(sim: Sim, specs: MovementSpec[], speedMps: number, maxTicks: number): Map<string, number> {
  const ids = specs.map((s) => s.id);
  const admitted = new Set(sim.world.reservations.movements.filter((m) => !m.done).map((m) => m.id));
  const finished = new Map<string, number>();
  for (let t = 1; t <= maxTicks && finished.size < ids.length; t++) {
    // Each one not yet moving asks to start, in order, before the others ask for more.
    for (const spec of specs) if (!admitted.has(spec.id) && admit(sim, spec) === null) admitted.add(spec.id);
    updateReservations(sim);
    for (const id of ids) {
      if (finished.has(id) || !admitted.has(id)) continue;
      const r = record(sim, id);
      const ac = sim.world.aircraft.find((a) => a.callsign === id);
      const leg = r.legs[r.leg];
      if (!ac || !leg) throw new Error(`${id}: missing`);
      const limit = reservedStop(sim, ac)?.at ?? leg.to;
      const step = speedMps / 10;
      ac.s = leg.to >= leg.from ? Math.min(ac.s + step, limit, leg.to) : Math.max(ac.s - step, limit, leg.to);
      if (ac.s !== leg.to) continue;
      const next = r.legs[r.leg + 1];
      if (next) {
        setLeg(sim, id, r.leg + 1);
        ac.track = buildTrack(TEST, next.nodes, next.edges);
        ac.s = next.from;
        continue;
      }
      finishMovement(sim, id);
      finished.set(id, t);
      if (!r.stays) {
        removeAircraft(sim, id);
        dropMovement(sim, id);
      }
    }
    const ground = sim.world.aircraft.filter((a) => ids.includes(a.callsign));
    // See-and-avoid never stops a reserved movement short of what it holds, for another reserved body.
    const occupancy = occupancyOf(sim);
    for (const ac of ground) {
      const r = sim.world.reservations.movements.find((m) => m.id === ac.callsign);
      if (!r || r.done || !r.legs[r.leg]?.seeAndAvoid) continue;
      const stop = trafficStop(TEST, occupancy, ac, 300);
      const held = reservedStop(sim, ac)?.at ?? ac.track.lengthM;
      if (stop !== null && ids.includes(stop.behind) && stop.at < held - 1e-6) {
        throw new Error(`tick ${t}: see-and-avoid stops ${ac.callsign} at ${stop.at.toFixed(1)} for ${stop.behind}, short of its reservation's ${held.toFixed(1)}`);
      }
    }
    for (let i = 0; i < ground.length; i++) {
      for (let j = i + 1; j < ground.length; j++) {
        const [a, b] = [ground[i], ground[j]];
        if (a && b && footprintsOverlap(sim, a.callsign, b.callsign)) throw new Error(`tick ${t}: ${a.callsign} and ${b.callsign} overlap`);
      }
    }
  }
  if (finished.size < ids.length) {
    const states = sim.world.reservations.movements.map((m) => `${m.id}: lo ${m.lo} hi ${m.hi}/${m.bounds.length - 1} waiting for ${m.waitingFor}`);
    throw new Error(`not all done after ${maxTicks} ticks: ${states.join('; ')}`);
  }
  return finished;
}

/**
 * TEST T2: an arrival in from TC along TD to B1, and a departure pushed from B2 with its tail
 * east onto tdB–tdE (the lane the arrival comes along), then taxiing west to TB.
 */
function busyLane(sim: Sim, arrivalAtS: number): { arrival: MovementSpec; departure: MovementSpec } {
  const inNodes = ['rbTC', 'tdE', 'tdB', 'tdA', 'gB1'];
  const inEdges = ['tdE-rbTC', 'tdB-tdE', 'tdA-tdB', 'tdA-gB1'];
  const pushNodes = ['tdE', 'tdB', 'gB2'];
  const pushEdges = ['tdB-tdE', 'tdB-gB2'];
  const outNodes = ['tdE', 'tdB', 'tdA', 'tdW', 'rbTB'];
  const outEdges = ['tdB-tdE', 'tdA-tdB', 'tdW-tdA', 'rbTB-tdW'];
  const push = buildTrack(TEST, pushNodes, pushEdges);
  const out = buildTrack(TEST, outNodes, outEdges);
  const pushTo = 75; // nose on tdB, tail on tdB–tdE
  place(sim, 'ARR1', 'A320', inNodes, inEdges, arrivalAtS);
  place(sim, 'DEP1', 'A320', pushNodes, pushEdges, push.lengthM);
  const body = { lengthM: 37.57, wingspanM: 35.8 };
  return {
    arrival: { id: 'ARR1', ...body, stays: true, legs: [{ nodes: inNodes, edges: inEdges, from: arrivalAtS, to: buildTrack(TEST, inNodes, inEdges).lengthM, seeAndAvoid: true, lookaheadM: 30 }] },
    departure: {
      id: 'DEP1',
      ...body,
      stays: false,
      legs: [
        { nodes: pushNodes, edges: pushEdges, from: push.lengthM, to: pushTo, seeAndAvoid: false, lookaheadM: 15 },
        { nodes: outNodes, edges: outEdges, from: pushTo, to: out.lengthM, seeAndAvoid: true, lookaheadM: 30 },
      ],
    },
  };
}

describe('opposing movements in one lane', () => {
  it('never deadlock: an arrival coming along TD and a departure pushing into it both finish, whenever each starts (TEST T2)', () => {
    // The departure starts as the arrival is at each of these points on its way in.
    for (const arrivalAtS of [40, 100, 150, 200, 260]) {
      const sim = createSim(TEST, { seed: 1 });
      const { arrival, departure } = busyLane(sim, arrivalAtS);
      const done = drive(sim, [arrival, departure], 5, 3000);
      expect([...done.keys()].sort()).toEqual(['ARR1', 'DEP1']);
    }
  });
});

describe('priority (yieldTo)', () => {
  it("one told to yield to a moving one isn't admitted while that one still has to pass where it goes; it is once that one is past, and that one never waits for it (TEST T2)", () => {
    const sim = createSim(TEST, { seed: 1 });
    const { arrival, departure } = busyLane(sim, 40);
    expect(admit(sim, arrival)).toBeNull();
    // Without priority the departure is admitted here (as the opposing-movements test has it).
    expect(admit(sim, departure, 0, ['ARR1'])).toBe('ARR1');
    expect(sim.world.reservations.movements.map((m) => m.id)).toEqual(['ARR1']);
    // The arrival taxis in; the departure asks again every tick.
    const ac = sim.world.aircraft.find((a) => a.callsign === 'ARR1');
    const leg = arrival.legs[0];
    if (!ac || !leg) throw new Error('no arrival');
    let admittedAt: number | null = null;
    for (let t = 0; t < 3000 && ac.s < leg.to; t++) {
      if (admittedAt === null && admit(sim, departure, 0, ['ARR1']) === null) admittedAt = t;
      updateReservations(sim);
      expect(record(sim, 'ARR1').waitingFor).toBeNull();
      ac.s = Math.min(ac.s + 0.5, reservedStop(sim, ac)?.at ?? leg.to);
    }
    expect(ac.s).toBe(leg.to);
    finishMovement(sim, 'ARR1');
    expect(admittedAt).not.toBeNull();
    // Then the departure goes, past the parked arrival.
    expect([...drive(sim, [departure], 5, 3000).keys()]).toEqual(['DEP1']);
  });

  it("one told to yield isn't held for a moving one that will stop for good in its way: it frees that place, so it goes first, and both finish (TEST T2, a turnover at B2)", () => {
    const sim = createSim(TEST, { seed: 1 });
    const { departure } = busyLane(sim, 40);
    // ARR1 comes in to B2, where DEP1 is. DEP1's body has no record yet (the engine sees it as
    // an outsider), so ARR1 can be admitted; it would wait at DEP1's body.
    const inNodes = ['rbTC', 'tdE', 'tdB', 'gB2'];
    const inEdges = ['tdE-rbTC', 'tdB-tdE', 'tdB-gB2'];
    const arr = sim.world.aircraft.find((a) => a.callsign === 'ARR1');
    if (!arr) throw new Error('no arrival');
    arr.track = buildTrack(TEST, inNodes, inEdges);
    const arrival: MovementSpec = { id: 'ARR1', lengthM: 37.57, wingspanM: 35.8, stays: true, legs: [{ nodes: inNodes, edges: inEdges, from: 40, to: arr.track.lengthM, seeAndAvoid: true, lookaheadM: 30 }] };
    expect(admit(sim, arrival)).toBeNull();
    expect(admit(sim, departure, 0, ['ARR1'])).toBeNull();
    // DEP1 pushes out first; ARR1 follows it into B2 (parking before DEP1 has taxied out).
    const done = drive(sim, [arrival, departure], 5, 6000);
    expect([...done.keys()].sort()).toEqual(['ARR1', 'DEP1']);
  });
});

describe('something parked', () => {
  it("in a movement's way stops it starting (it waits for it); nothing can be parked where a movement is going (TEST T2)", () => {
    const sim = createSim(TEST, { seed: 1 });
    const { arrival } = busyLane(sim, 40);
    // An aircraft parked on TD between tdB and tdA, where the arrival goes.
    place(sim, 'PRK1', 'A320', ['tdA', 'tdB'], ['tdA-tdB'], 100);
    expect(reserveParked(sim, { id: 'PRK1', nodes: ['tdA', 'tdB'], edges: ['tdA-tdB'], s: 100, lengthM: 37.57, wingspanM: 35.8 })).toBeNull();
    expect(admit(sim, arrival)).toBe('PRK1');
    expect(sim.world.reservations.movements.map((m) => m.id)).toEqual(['PRK1']);
    dropMovement(sim, 'PRK1');
    expect(admit(sim, arrival)).toBeNull();
    // Now the arrival is coming, PRK1 can't be parked there again.
    expect(reserveParked(sim, { id: 'PRK1', nodes: ['tdA', 'tdB'], edges: ['tdA-tdB'], s: 100, lengthM: 37.57, wingspanM: 35.8 })).toBe('ARR1');
  });
});

describe('one that stops for good on the way', () => {
  // On TEST's lane 7, north from the ramp edge: SHORT stops for good with its nose on l7A; LONG
  // goes on past it to l7B.
  const body = { lengthM: 37.57, wingspanM: 35.8 };
  const leg = (nodes: string[], edges: string[], from: number): Leg => ({ nodes, edges, from, to: buildTrack(TEST, nodes, edges).lengthM, seeAndAvoid: true, lookaheadM: 30 });
  const fromStub = { nodes: ['a7', 'rb7', 'l7A'], edges: ['rb7-a7', 'rb7-l7A'] };
  const longFromStub = { nodes: ['a7', 'rb7', 'l7A', 'l7B'], edges: ['rb7-a7', 'rb7-l7A', 'l7A-l7B'] };
  const onLane = { nodes: ['rb7', 'l7A'], edges: ['rb7-l7A'] };
  const longOnLane = { nodes: ['rb7', 'l7A', 'l7B'], edges: ['rb7-l7A', 'l7A-l7B'] };

  it('can go ahead of one that passes it, so both finish (TEST lane 7)', () => {
    const sim = createSim(TEST, { seed: 1 });
    place(sim, 'LONG', 'A320', longOnLane.nodes, longOnLane.edges, 60);
    place(sim, 'SHORT', 'A320', fromStub.nodes, fromStub.edges, 40);
    const specs = [
      { id: 'LONG', ...body, stays: true, legs: [leg(longOnLane.nodes, longOnLane.edges, 60)] },
      { id: 'SHORT', ...body, stays: true, legs: [leg(fromStub.nodes, fromStub.edges, 40)] },
    ];
    expect([...drive(sim, specs, 5, 3000).keys()].sort()).toEqual(['LONG', 'SHORT']);
  });

  it("is never followed by one that would have to pass where it stops: that one doesn't start (TEST lane 7)", () => {
    const sim = createSim(TEST, { seed: 1 });
    place(sim, 'SHORT', 'A320', onLane.nodes, onLane.edges, 60);
    place(sim, 'LONG', 'A320', longFromStub.nodes, longFromStub.edges, 40);
    const short = { id: 'SHORT', ...body, stays: true, legs: [leg(onLane.nodes, onLane.edges, 60)] };
    const long = { id: 'LONG', ...body, stays: true, legs: [leg(longFromStub.nodes, longFromStub.edges, 40)] };
    expect(admit(sim, short)).toBeNull();
    expect(admit(sim, long)).toBe('SHORT');
    drive(sim, [short], 5, 3000);
    expect(admit(sim, long)).toBe('SHORT');
  });
});

describe('following', () => {
  it('one behind another the same way keeps clear of see-and-avoid: it holds no closer than the spacing behind the tail ahead, and both finish (TEST lane 7)', () => {
    const sim = createSim(TEST, { seed: 1 });
    const body = { lengthM: 37.57, wingspanM: 35.8 };
    const nodes = ['a7', 'rb7', 'l7A', 'l7B'];
    const edges = ['rb7-a7', 'rb7-l7A', 'l7A-l7B'];
    const end = buildTrack(TEST, nodes, edges).lengthM;
    place(sim, 'LEAD', 'A320', nodes, edges, 100);
    place(sim, 'NEXT', 'A320', nodes, edges, 40);
    // NEXT starts 22 m behind LEAD's tail: it can't start until LEAD has moved on.
    const specs = [
      { id: 'LEAD', ...body, stays: false, legs: [{ nodes, edges, from: 100, to: end, seeAndAvoid: true, lookaheadM: 30 }] },
      { id: 'NEXT', ...body, stays: false, legs: [{ nodes, edges, from: 40, to: end - 1, seeAndAvoid: true, lookaheadM: 30 }] },
    ];
    expect([...drive(sim, specs, 5, 3000).keys()].sort()).toEqual(['LEAD', 'NEXT']);
  });
});

describe('an aircraft no one reserves for (the player\'s)', () => {
  it('is never reserved into: a movement stops short of its body and says it waits for it, then goes on once it has left (TEST lane 7)', () => {
    const sim = createSim(TEST, { seed: 1 });
    const nodes = ['a7', 'rb7', 'l7A', 'l7B'];
    const edges = ['rb7-a7', 'rb7-l7A', 'l7A-l7B'];
    const end = buildTrack(TEST, nodes, edges).lengthM;
    place(sim, 'MOV1', 'A320', nodes, edges, 40);
    // Ground's, stopped on lane 7 between l7A and l7B, facing north.
    place(sim, 'GND1', 'A320', ['l7A', 'l7B'], ['l7A-l7B'], 80);
    const spec = { id: 'MOV1', lengthM: 37.57, wingspanM: 35.8, stays: false, legs: [{ nodes, edges, from: 40, to: end, seeAndAvoid: false, lookaheadM: 30 }] };
    expect(() => drive(sim, [spec], 5, 1200)).toThrow('MOV1: lo');
    expect(record(sim, 'MOV1').waitingFor).toBe('GND1');
    expect(footprintsOverlap(sim, 'MOV1', 'GND1')).toBe(false);
    removeAircraft(sim, 'GND1');
    expect([...drive(sim, [spec], 5, 1200).keys()]).toEqual(['MOV1']);
  });
});

describe('one that leaves', () => {
  it('holds where it finished until its body has moved clear of it, then lets it go (TEST lane 7)', () => {
    const sim = createSim(TEST, { seed: 1 });
    const nodes = ['l7B', 'l7A', 'rb7'];
    const edges = ['l7A-l7B', 'rb7-l7A'];
    const end = buildTrack(TEST, nodes, edges).lengthM;
    place(sim, 'DEP1', 'A320', nodes, edges, 40);
    const spec = { id: 'DEP1', lengthM: 37.57, wingspanM: 35.8, stays: false, legs: [{ nodes, edges, from: 40, to: end, seeAndAvoid: true, lookaheadM: 30 }] };
    expect(admit(sim, spec)).toBeNull();
    for (let t = 0; t < 1000 && reservedStop(sim, sim.world.aircraft[0] as never) !== null; t++) {
      updateReservations(sim);
      const ac = sim.world.aircraft[0];
      if (ac) ac.s = Math.min(ac.s + 0.5, reservedStop(sim, ac)?.at ?? end);
    }
    const ac = sim.world.aircraft[0];
    if (!ac) throw new Error('gone');
    ac.s = end;
    updateReservations(sim);
    finishMovement(sim, 'DEP1');
    // Handed on, it's still on the end of lane 7: still held.
    updateReservations(sim);
    expect(sim.world.reservations.movements.map((m) => m.id)).toEqual(['DEP1']);
    // It taxis off down the stub (another track now): once clear, nothing's held.
    ac.track = buildTrack(TEST, ['rb7', 'a7'], ['rb7-a7']);
    ac.s = 10;
    updateReservations(sim);
    expect(sim.world.reservations.movements.map((m) => m.id)).toEqual(['DEP1']);
    ac.s = ac.track.lengthM;
    updateReservations(sim);
    expect(sim.world.reservations.movements).toEqual([]);
  });
});

describe('a wide body past a short stand (1.11\'s question 4)', () => {
  it("isn't admitted past a parked aircraft its rigid footprint would overlap, though see-and-avoid wouldn't stop it; a narrower one passes (TEST lane 7 past T1-1)", () => {
    // An E175 parked at T1-1: its tail 38.3 m from lane 7 at l7A, outside its own 13 m half-span
    // (the stand rule and see-and-avoid), but inside an A388's 39.9 m.
    const nodes = ['a7', 'rb7', 'l7A', 'l7B'];
    const edges = ['rb7-a7', 'rb7-l7A', 'l7A-l7B'];
    const end = buildTrack(TEST, nodes, edges).lengthM;
    const passer = (type: string, lengthM: number, wingspanM: number) => {
      const sim = createSim(TEST, { seed: 1 });
      addAircraft(sim, { callsign: 'PRK1', type: 'E175', role: 'arrival', at: { kind: 'gate', gate: 'T1-1' } });
      place(sim, 'WIDE', type, nodes, edges, lengthM + 1);
      const spec = { id: 'WIDE', lengthM, wingspanM, stays: true, legs: [{ nodes, edges, from: lengthM + 1, to: end, seeAndAvoid: true, lookaheadM: 30 }] };
      return { sim, spec };
    };
    const wide = passer('A388', 72.7, 79.8);
    expect(admit(wide.sim, wide.spec)).toBe('PRK1');
    const narrow = passer('A320', 37.6, 35.8);
    expect([...drive(narrow.sim, [narrow.spec], 5, 3000).keys()]).toEqual(['WIDE']);
    expect(footprintsOverlap(narrow.sim, 'WIDE', 'PRK1')).toBe(false);
  });
});

describe('a lone movement', () => {
  it('is granted only as far ahead as it asks, and gives back what is behind its nose as it goes (TEST lane 7, north from the ramp edge)', () => {
    const sim = createSim(TEST, { seed: 1 });
    const nodes = ['rb7', 'l7A', 'l7B'];
    const edges = ['rb7-l7A', 'l7A-l7B'];
    place(sim, 'DAL1', 'A320', nodes, edges, 40);
    const leg: Leg = { nodes, edges, from: 40, to: buildTrack(TEST, nodes, edges).lengthM, seeAndAvoid: true, lookaheadM: 30 };
    expect(admit(sim, { id: 'DAL1', lengthM: 37.57, wingspanM: 35.8, legs: [leg], stays: true })).toBeNull();
    updateReservations(sim);
    const r = record(sim, 'DAL1');
    const limit = () => r.bounds[r.hi] ?? NaN;
    // Progress 0: held from the start to the first boundary at or past 30 m.
    expect(r.lo).toBe(0);
    expect(limit()).toBeGreaterThanOrEqual(30);
    expect(limit()).toBeLessThan(30 + SEGMENT_M);
    // 25 m on: the segments it has left are given back, and it holds 30 m past its nose again.
    const ac = sim.world.aircraft[0];
    if (!ac) throw new Error('no aircraft');
    ac.s += 25;
    updateReservations(sim);
    expect(r.bounds[r.lo] ?? NaN).toBeLessThanOrEqual(25);
    expect(r.bounds[r.lo + 1] ?? NaN).toBeGreaterThan(25);
    expect(limit()).toBeGreaterThanOrEqual(55);
    expect(limit()).toBeLessThan(55 + SEGMENT_M);
  });
});
