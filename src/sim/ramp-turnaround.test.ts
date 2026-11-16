// Turnarounds (ramp.ts, PLAN 1.13; Q: parked arrivals "either depart again, or go to the hangar
// (despawn)"): after a seeded time at the gate, an arrival becomes a departure from that gate
// under a new flight number, or is towed to a hangar and removed, its gate freed.

import { describe, expect, it } from 'vitest';
import kjfkBase from '../../data/airports/KJFK.json' with { type: 'json' };
import kjfkOverrides from '../../data/airports/KJFK.overrides.json' with { type: 'json' };
import testAirport from '../../data/airports/TEST.json' with { type: 'json' };
import { indexAirport } from '../airport/graph.ts';
import { loadAirport } from '../airport/load.ts';
import { addAircraft, applyCommand, createSim, drainEvents, getGate, getScore, listAircraft, removeAircraft, stateHash, step, type Sim, type SimEvent, type SimOptions } from './sim.ts';
import { departurePlansFor } from './ramp.ts';
import { parseTerse } from './terse.ts';

const TEST = indexAirport(loadAirport(testAirport));
const KJFK = indexAirport(loadAirport(kjfkBase, kjfkOverrides));

function transmit(sim: Sim, text: string): void {
  const result = parseTerse(text);
  if (!result.ok) throw new Error(`'${text}' doesn't parse: ${result.error.message}`);
  applyCommand(sim, result.command);
}

function runUntil(sim: Sim, done: (e: SimEvent) => boolean, maxTicks: number): SimEvent[] {
  const seen: SimEvent[] = [];
  for (let t = 0; t < maxTicks; t++) {
    step(sim, 1);
    const events = drainEvents(sim);
    seen.push(...events);
    if (events.some(done)) return seen;
  }
  throw new Error(`not done within ${maxTicks} ticks; events: ${seen.map((e) => e.type).join(', ')}`);
}

/** BAW1, an A320 for T2, on A at TC: handed to ramp, it parks at T2-B1 (ramp.test.ts's arrival). */
function parkedAtB1(turnaround: SimOptions['turnaround'], seed = 1): { sim: Sim; parkedTick: number } {
  const sim = createSim(TEST, { seed, turnaround });
  addAircraft(sim, { callsign: 'BAW1', type: 'A320', role: 'arrival', airline: 'BAW', terminal: 'T2', at: { kind: 'node', node: 'aTC', arrivedVia: 'aTC-aJ' } });
  transmit(sim, 'BAW1 taxi ramp via TC, monitor ramp');
  const events = runUntil(sim, (e) => e.type === 'arrived-at-gate', 10 * 60 * 10);
  expect(events.at(-1)).toMatchObject({ type: 'arrived-at-gate', callsign: 'BAW1', gate: 'T2-B1' });
  return { sim, parkedTick: sim.world.tick };
}

describe('a tow to the hangar', () => {
  it('removes the arrival after its turnaround time and frees its gate: nothing held there, and a departure can be added (TEST T2-B1)', () => {
    const { sim, parkedTick } = parkedAtB1({ narrowbodyS: [120, 120], departShare: 0 });
    const events = runUntil(sim, (e) => e.type === 'towed-to-hangar', 5 * 60 * 10);
    expect(events).toEqual([{ type: 'towed-to-hangar', tick: parkedTick + 120 * 10, callsign: 'BAW1', gate: 'T2-B1' }]);
    expect(listAircraft(sim).map((a) => a.callsign)).toEqual([]);
    expect(getGate(sim, 'T2-B1').occupant).toBeNull();
    expect(sim.world.ramp.aircraft).toEqual([]);
    expect(sim.world.reservations.movements.map((m) => m.id)).toEqual([]);
    addAircraft(sim, { callsign: 'DAL7', type: 'A320', at: { kind: 'gate', gate: 'T2-B1' } });
    expect(getGate(sim, 'T2-B1').occupant).toBe('DAL7');
  });
});

describe('a turnaround into a departure', () => {
  it('replaces the arrival with the same aircraft as a new flight (BAW1 in, BAW2 out), which boards, pushes back and checks in under its new callsign (TEST T2-B1)', () => {
    const { sim, parkedTick } = parkedAtB1({ narrowbodyS: [120, 120], departShare: 1 });
    const events = runUntil(sim, (e) => e.type === 'check-in', 15 * 60 * 10);
    expect(events[0]).toEqual({ type: 'turnaround', tick: parkedTick + 120 * 10, callsign: 'BAW1', gate: 'T2-B1', newCallsign: 'BAW2' });
    expect(events.map((e) => [e.type, e.callsign])).toEqual([
      ['turnaround', 'BAW1'],
      ['pushback', 'BAW2'],
      ['check-in', 'BAW2'],
    ]);
    expect(events[1]).toMatchObject({ gate: 'T2-B1' });
    const views = listAircraft(sim);
    expect(views.map((a) => a.callsign)).toEqual(['BAW2']);
    expect(views[0]).toMatchObject({ type: 'A320', airline: 'BAW', role: 'departure', controller: 'ground', status: 'idle' });
    expect(sim.world.aircraft[0]?.terminal).toBe('T2');
    expect(getGate(sim, 'T2-B1').occupant).toBeNull();
  });

  it('scores each flight once: BAW1 at its gate, BAW2 at takeoff; the turnaround itself scores nothing (TEST)', () => {
    const { sim } = parkedAtB1({ narrowbodyS: [120, 120], departShare: 1 });
    const atTurn = getScore(sim);
    expect([atTurn.arrivals.total, atTurn.departures.total]).toEqual([1, 0]);
    const checkIn = runUntil(sim, (e) => e.type === 'check-in', 15 * 60 * 10).at(-1);
    if (checkIn?.type !== 'check-in') throw new Error('no check-in');
    expect(getScore(sim).arrivals.total).toBe(1);
    transmit(sim, `BAW2 taxi 27 via ${checkIn.taxilane === '7' ? '#7' : checkIn.taxilane} L:A, cross 36, monitor tower`);
    runUntil(sim, (e) => e.type === 'took-off', 15 * 60 * 10);
    expect(sim.world.score.arrivals.map((m) => m.callsign)).toEqual(['BAW1']);
    expect(sim.world.score.departures.map((m) => m.callsign)).toEqual(['BAW2']);
    const score = getScore(sim);
    expect([score.arrivals.total, score.departures.total, score.combined.total]).toEqual([1, 1, 2]);
  });
});

/** DAL4, an A320 for T4, on B at the foot of the KG stub: handed to ramp, it parks at a T4 gate (ramp.test.ts's KJFK arrival). */
function parkedAtT4(turnaround: SimOptions['turnaround'], seed = 1, type = 'A320'): { sim: Sim; gate: string } {
  const sim = createSim(KJFK, { seed, turnaround });
  addAircraft(sim, { callsign: 'DAL4', type, role: 'arrival', airline: 'DAL', terminal: 'T4', at: { kind: 'node', node: 'n45379510', arrivedVia: 'w5786355-n45352239-n45379510' } });
  transmit(sim, 'DAL4 taxi ramp via KG, monitor ramp');
  const parked = runUntil(sim, (e) => e.type === 'arrived-at-gate', 15 * 60 * 10).at(-1);
  if (parked?.type !== 'arrived-at-gate') throw new Error('DAL4 did not park');
  return { sim, gate: parked.gate };
}

describe('turnarounds at KJFK', () => {
  it('DAL4 turns into DAL5 at its T4 gate, pushes back and checks in on a T4 ramp edge as DAL5', () => {
    const { sim, gate } = parkedAtT4({ narrowbodyS: [120, 120], departShare: 1 });
    const events = runUntil(sim, (e) => e.type === 'check-in', 15 * 60 * 10);
    expect(events.map((e) => [e.type, e.callsign])).toEqual([
      ['turnaround', 'DAL4'],
      ['pushback', 'DAL5'],
      ['check-in', 'DAL5'],
    ]);
    expect(events[0]).toMatchObject({ gate, newCallsign: 'DAL5' });
    const checkIn = events[2];
    if (checkIn?.type !== 'check-in') throw new Error('no check-in');
    const edge = KJFK.airport.rampHandoffs.find((h) => h.id === checkIn.rampHandoff);
    expect(edge?.terminals === undefined || edge.terminals.includes('T4')).toBe(true);
    expect(listAircraft(sim).map((a) => [a.callsign, a.role, a.controller])).toEqual([['DAL5', 'departure', 'ground']]);
  });

  it('a tow removes DAL4 and frees its T4 gate: nothing held there, and a departure can be added at it', () => {
    const { sim, gate } = parkedAtT4({ narrowbodyS: [120, 120], departShare: 0 });
    const events = runUntil(sim, (e) => e.type === 'towed-to-hangar', 5 * 60 * 10);
    expect(events.map((e) => [e.type, e.callsign])).toEqual([['towed-to-hangar', 'DAL4']]);
    expect(events[0]).toMatchObject({ gate });
    expect(listAircraft(sim)).toEqual([]);
    expect(getGate(sim, gate).occupant).toBeNull();
    expect(sim.world.reservations.movements).toEqual([]);
    addAircraft(sim, { callsign: 'JBU9', type: 'A320', at: { kind: 'gate', gate } });
    expect(getGate(sim, gate).occupant).toBe('JBU9');
  });
});

/**
 * Two simulated hours at TEST, turnarounds on with short times (5–15 min at the gate, 70% depart):
 * the tower lands BAW arrivals on 27 for T2, the ramp spawns departures at T1 and T2, and a
 * scripted player taxis every check-in (a turned flight's too) to 27 for tower, and every arrival
 * to T2's ramp for ramp. The state hash every 10 minutes, the event counts, and the sim.
 */
function turnaroundRun(seed: number): { hashes: string[]; counts: Record<string, number>; sim: Sim } {
  const sim = createSim(TEST, {
    seed,
    arrivals: [{ runwayEnd: '27', perHour: 8, flight: (n) => ({ callsign: `BAW${n + 1}`, type: n % 3 ? 'A320' : 'B738', airline: 'BAW', terminal: 'T2' }) }],
    departures: [
      { perHour: 4, flight: (n) => ({ callsign: `JBU${n + 1}`, type: 'A320', airline: 'JBU', terminal: 'T1' }) },
      { perHour: 4, firstAtS: 120, flight: (n) => ({ callsign: `AFR${n + 1}`, type: n % 2 ? 'A321' : 'A320', airline: 'AFR', terminal: 'T2' }) },
    ],
    turnaround: { narrowbodyS: [5 * 60, 15 * 60], departShare: 0.7, callsign: (n, inbound) => `${inbound.airline ?? 'XXX'}${5000 + n}` },
  });
  const counts: Record<string, number> = {};
  const hashes: string[] = [];
  for (let t = 1; t <= 2 * 60 * 60 * 10; t++) {
    step(sim, 1);
    for (const e of drainEvents(sim)) {
      counts[e.type] = (counts[e.type] ?? 0) + 1;
      if (e.type === 'unable' || e.type === 'ambiguous') throw new Error(`seed ${seed}: ${e.callsign} ${e.type}`);
      if (e.type === 'check-in') transmit(sim, `${e.callsign} taxi 27 via ${e.taxilane === '7' ? '#7' : e.taxilane} L:A, cross 36, monitor tower`);
      if (e.type === 'clear-of-runway') {
        // As ramp-safety.test.ts's long run: from D's south side there's no short way to T2.
        if (e.exitId === 'x27DS') removeAircraft(sim, e.callsign);
        else transmit(sim, `${e.callsign} taxi ramp via ${e.exit ?? ''} R:A TC, monitor ramp`);
      }
    }
    if (t % (10 * 60 * 10) === 0) hashes.push(stateHash(sim));
  }
  return { hashes, counts, sim };
}

describe('a turnaround that has to wait', () => {
  it('waits, parked, while every stand its pushback could swing into is taken, and goes once one is free (KJFK g1009800791, whose only pushbacks are swings)', () => {
    // White-box. A real arrival's gate is random, so DAL4 is placed at such a gate and its
    // turnaround set due, as park would. Each swing stand is taken by a parked E175 where one
    // fits. A stand too close for one (beside DAL4, or beside a filler) can still be taken by a
    // departure's claim on it for its tail swing (RampAircraft.swingInto): a filler claims it.
    const gate = 'g1009800791';
    const sim = createSim(KJFK, { seed: 1 });
    const plans = departurePlansFor(sim, gate, 'A320');
    if ('unable' in plans || plans.some((p) => p.swing === null)) throw new Error(`${gate}: expected swing plans only`);
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', role: 'arrival', airline: 'DAL', at: { kind: 'gate', gate } });
    const unfilled: string[] = [];
    for (const swing of new Set(plans.map((p) => p.swing ?? ''))) {
      const n = sim.world.ramp.aircraft.length;
      try {
        addAircraft(sim, { callsign: `PRK${n}`, type: 'E175', role: 'arrival', at: { kind: 'gate', gate: swing } });
      } catch (e) {
        if (!String(e).includes('is blocked')) throw e;
        unfilled.push(swing);
      }
    }
    const fillers = sim.world.ramp.aircraft.filter((r) => r.callsign.startsWith('PRK'));
    expect(fillers.length).toBeGreaterThanOrEqual(unfilled.length);
    unfilled.forEach((swing, i) => Object.assign(fillers[i] ?? {}, { swingInto: swing }));
    const record = sim.world.ramp.aircraft.find((r) => r.callsign === 'DAL4');
    if (!record) throw new Error('no record for DAL4');
    record.turnaround = { tick: sim.world.tick + 1, then: 'depart' };
    step(sim, 600);
    expect(drainEvents(sim)).toEqual([]);
    expect(getGate(sim, gate).occupant).toBe('DAL4');
    // A filler leaves, with its claim: a stand is free, so DAL4 can push back, and turns.
    removeAircraft(sim, fillers[0]?.callsign ?? '');
    step(sim, 1);
    expect(drainEvents(sim)).toEqual([{ type: 'turnaround', tick: sim.world.tick, callsign: 'DAL4', gate, newCallsign: 'DAL5' }]);
  });
});

describe('the defaults', () => {
  it('narrowbodies turn in 35–60 min and widebodies in 75–120 min at the gate; about 80% depart again, the rest are towed', () => {
    const minutes = (sim: Sim) => {
      const r = sim.world.ramp.aircraft[0];
      if (!r?.turnaround) throw new Error('no turnaround drawn');
      return { min: (r.turnaround.tick - r.since) / 600, then: r.turnaround.then };
    };
    const narrow = Array.from({ length: 100 }, (_, i) => minutes(parkedAtB1(undefined, i + 1).sim));
    const wide = Array.from({ length: 20 }, (_, i) => minutes(parkedAtT4(undefined, i + 1, 'B77W').sim));
    for (const n of narrow) expect(n.min >= 35 && n.min <= 60, `${n.min}`).toBe(true);
    for (const w of wide) expect(w.min >= 75 && w.min <= 120, `${w.min}`).toBe(true);
    // Spread over the span, not stuck at one end.
    expect(Math.min(...narrow.map((n) => n.min))).toBeLessThan(40);
    expect(Math.max(...narrow.map((n) => n.min))).toBeGreaterThan(55);
    const departs = [...narrow, ...wide].filter((x) => x.then === 'depart').length;
    expect(departs).toBeGreaterThanOrEqual(84);
    expect(departs).toBeLessThanOrEqual(108);
  }, 30_000);
});

describe('an arrival added parked', () => {
  it('(a fixture, addAircraft at a gate) stays for good, turnarounds on: only an arrival the ramp parked turns around (TEST T1-1)', () => {
    const sim = createSim(TEST, { seed: 1, turnaround: { narrowbodyS: [60, 60] } });
    addAircraft(sim, { callsign: 'ARR1', type: 'A320', role: 'arrival', at: { kind: 'gate', gate: 'T1-1' } });
    expect(sim.world.ramp.aircraft.map((r) => r.turnaround)).toEqual([null]);
    step(sim, 30 * 60 * 10);
    expect(drainEvents(sim)).toEqual([]);
    expect(getGate(sim, 'T1-1').occupant).toBe('ARR1');
  });
});

describe('bad options', () => {
  it('a span or share that makes no sense throws at createSim; the default callsign throws for a callsign that is not letters then a number', () => {
    expect(() => createSim(TEST, { seed: 1, turnaround: { narrowbodyS: [600, 300] } })).toThrow('turnaround narrowbodyS: expected 0 ≤ min ≤ max seconds, got [600, 300]');
    expect(() => createSim(TEST, { seed: 1, turnaround: { widebodyS: [-1, 300] } })).toThrow('turnaround widebodyS: expected 0 ≤ min ≤ max seconds, got [-1, 300]');
    expect(() => createSim(TEST, { seed: 1, turnaround: { departShare: 1.5 } })).toThrow('turnaround departShare: expected 0–1, got 1.5');
    const sim = createSim(TEST, { seed: 1, turnaround: { narrowbodyS: [60, 60], departShare: 1 } });
    addAircraft(sim, { callsign: 'N123AB', type: 'A320', role: 'arrival', terminal: 'T2', at: { kind: 'node', node: 'aTC', arrivedVia: 'aTC-aJ' } });
    transmit(sim, 'N123AB taxi ramp via TC, monitor ramp');
    runUntil(sim, (e) => e.type === 'arrived-at-gate', 10 * 60 * 10);
    expect(() => step(sim, 61 * 10)).toThrow('N123AB: the default turnaround callsign needs letters then a flight number; give RampOptions.turnaround.callsign');
  });
});

describe('turned off', () => {
  it('with turnaround: false an arrival stays parked for good: nothing happens in two hours at the gate (TEST T2-B1)', () => {
    const { sim } = parkedAtB1(false);
    expect(sim.world.ramp.aircraft.map((r) => r.turnaround)).toEqual([null]);
    step(sim, 2 * 60 * 60 * 10);
    expect(drainEvents(sim)).toEqual([]);
    expect(listAircraft(sim).map((a) => [a.callsign, a.status])).toEqual([['BAW1', 'parked']]);
  });
});

describe('a long run with turnarounds', () => {
  it('is deterministic: the same seed gives the same state hash every 10 minutes over 2 hours, with both kinds of turnaround happening (TEST)', () => {
    const first = turnaroundRun(1);
    expect(first.counts['turnaround']).toBeGreaterThanOrEqual(3);
    expect(first.counts['towed-to-hangar']).toBeGreaterThanOrEqual(1);
    expect(first.hashes).toHaveLength(12);
    expect(turnaroundRun(1).hashes).toEqual(first.hashes);
    expect(turnaroundRun(2).hashes.at(-1)).not.toBe(first.hashes.at(-1));
    expect(first.sim.world.session).toEqual({ state: 'running' });
  }, 60_000);

  it('is deterministic at KJFK too: T4 arrivals in at Kilo Golf one after another for 90 minutes, turning or towed, the same hash every 10 minutes for the same seed', () => {
    const kjfkRun = (seed: number) => {
      const sim = createSim(KJFK, { seed, turnaround: { narrowbodyS: [5 * 60, 15 * 60], departShare: 0.7, callsign: (n) => `DAL${5000 + n}` } });
      const types = ['A320', 'B738', 'E175', 'A321'];
      const counts: Record<string, number> = {};
      const hashes: string[] = [];
      let next = 1;
      let waiting: string | null = null;
      let spawnAt = 10;
      for (let t = 1; t <= 90 * 60 * 10; t++) {
        if (waiting === null && t >= spawnAt) {
          waiting = `DAL${next * 10}`;
          addAircraft(sim, { callsign: waiting, type: types[next % types.length] ?? 'A320', role: 'arrival', airline: 'DAL', terminal: 'T4', at: { kind: 'node', node: 'n45379510', arrivedVia: 'w5786355-n45352239-n45379510' } });
          transmit(sim, `${waiting} taxi ramp via KG, monitor ramp`);
          next += 1;
        }
        step(sim, 1);
        for (const e of drainEvents(sim)) {
          counts[e.type] = (counts[e.type] ?? 0) + 1;
          if (e.type === 'ramp-accepted' && e.callsign === waiting) [waiting, spawnAt] = [null, t + 4 * 60 * 10];
          // A turned flight's check-in: it's ground's; out of the way, so the next arrival's entrance stays clear.
          if (e.type === 'check-in') removeAircraft(sim, e.callsign);
        }
        if (t % (10 * 60 * 10) === 0) hashes.push(stateHash(sim));
      }
      return { hashes, counts };
    };
    const first = kjfkRun(1);
    expect(first.counts['arrived-at-gate']).toBeGreaterThanOrEqual(8);
    expect(first.counts['turnaround']).toBeGreaterThanOrEqual(3);
    expect(first.counts['check-in']).toBeGreaterThanOrEqual(3);
    expect(first.hashes).toHaveLength(9);
    expect(kjfkRun(1).hashes).toEqual(first.hashes);
    expect(kjfkRun(2).hashes.at(-1)).not.toBe(first.hashes.at(-1));
  }, 60_000);
});
