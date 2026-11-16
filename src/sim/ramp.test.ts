// The simulated ramp (PLAN 1.11): gates, pushback, departures to the ramp edge, arrivals from
// the ramp entrance to their gate, on TEST and KJFK.

import { describe, expect, it } from 'vitest';
import kjfkBase from '../../data/airports/KJFK.json' with { type: 'json' };
import kjfkOverrides from '../../data/airports/KJFK.overrides.json' with { type: 'json' };
import testAirport from '../../data/airports/TEST.json' with { type: 'json' };
import { indexAirport } from '../airport/graph.ts';
import { loadAirport } from '../airport/load.ts';
import { AIRCRAFT_TYPES } from './aircraft-types.ts';
import { departurePlanFor } from './ramp.ts';
import { addAircraft, applyCommand, createSim, drainEvents, footprintsOverlap, getAircraft, getGate, removeAircraft, step, type Sim, type SimEvent } from './sim.ts';
import { parseTerse } from './terse.ts';

const TEST = indexAirport(loadAirport(testAirport));
const KJFK = indexAirport(loadAirport(kjfkBase, kjfkOverrides));

/** Applies a terse command, which must parse. */
function transmit(sim: Sim, text: string): void {
  const result = parseTerse(text);
  if (!result.ok) throw new Error(`'${text}' doesn't parse: ${result.error.message}`);
  applyCommand(sim, result.command);
}

describe('gates', () => {
  it('a departure added at a gate is parked there under ramp, nose on the gate, facing into the stand; the gate shows it (TEST T1-1)', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', airline: 'DAL', at: { kind: 'gate', gate: 'T1-1' } });
    const dal4 = getAircraft(sim, 'DAL4');
    expect(dal4).toMatchObject({ role: 'departure', controller: 'ramp', status: 'parked', speedMps: 0, clearance: null });
    // g1 is west of lane 7's l7A, at the end of its lead-in.
    expect(dal4.location).toEqual({ kind: 'node', node: 'g1', arrivedVia: 'l7A-g1' });
    expect(dal4.headingDeg).toBeCloseTo(270, 6);
    expect(getGate(sim, 'T1-1')).toEqual({ id: 'T1-1', terminal: 'T1', occupant: 'DAL4' });
    expect(getGate(sim, 'T1-2').occupant).toBeNull();
  });

  it("refuses a type whose parked tail would reach within its half-span of the lane (see-and-avoid's occupied junction), and a taken gate (TEST)", () => {
    const sim = createSim(TEST, { seed: 1 });
    // T1-1's stand is 70 m. A B763 (54.9 m, span 47.6 m) would end 15.1 m from l7A, inside its 23.8 m half-span.
    expect(() => addAircraft(sim, { callsign: 'DAL1', type: 'B763', at: { kind: 'gate', gate: 'T1-1' } })).toThrow(
      'DAL1: gate T1-1 is too short for a B763: its tail would be 15.1 m from the lane at l7A, inside its half-span 23.8 m',
    );
    addAircraft(sim, { callsign: 'DAL2', type: 'A321', at: { kind: 'gate', gate: 'T1-1' } });
    expect(() => addAircraft(sim, { callsign: 'DAL3', type: 'A320', at: { kind: 'gate', gate: 'T1-1' } })).toThrow('DAL3: gate T1-1 is taken by DAL2');
    expect(sim.world.aircraft.map((a) => a.callsign)).toEqual(['DAL2']);
  });

  it("refuses a departure at a gate it can't push back from, but parks an arrival there (TEST T1-3, at lane 7's dead end)", () => {
    const sim = createSim(TEST, { seed: 1 });
    // From l7B the only lane is back toward the ramp edge: pushed onto it, the nose would face the dead end.
    expect(() => addAircraft(sim, { callsign: 'DAL1', type: 'A320', at: { kind: 'gate', gate: 'T1-3' } })).toThrow(
      'DAL1: gate T1-3 has no pushback for a A320 that ends facing a way to a ramp edge for T1 (within 400 m, turns up to 135°)',
    );
    expect(sim.world.aircraft).toEqual([]);
    addAircraft(sim, { callsign: 'DAL2', type: 'A320', role: 'arrival', at: { kind: 'gate', gate: 'T1-3' } });
    step(sim, 3000);
    expect(getAircraft(sim, 'DAL2')).toMatchObject({ status: 'parked', controller: 'ramp', role: 'arrival' });
    expect(getGate(sim, 'T1-3').occupant).toBe('DAL2');
  });
});

/** Steps until `done` matches an event (returning the events so far, drained), or fails after `maxTicks`. */
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

describe("the player's transmissions to ramp's aircraft", () => {
  it('get no reply and change nothing: parked, pushing back, taxiing out, taxiing in; crossing requests are unable (TEST)', () => {
    const sim = createSim(TEST, { seed: 2 });
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'gate', gate: 'T1-1' } });
    addAircraft(sim, { callsign: 'BAW1', type: 'A320', role: 'arrival', airline: 'BAW', terminal: 'T2', at: { kind: 'node', node: 'aTC', arrivedVia: 'aTC-aJ' } });
    transmit(sim, 'BAW1 taxi ramp via TC, monitor ramp');
    drainEvents(sim);
    const tryAll = (callsign: string) => {
      drainEvents(sim);
      const before = JSON.stringify(sim.world.aircraft.find((a) => a.callsign === callsign));
      transmit(sim, `${callsign} hold`);
      transmit(sim, `${callsign} taxi 27 via A, cross 27`);
      expect(drainEvents(sim), callsign).toEqual([
        { type: 'not-on-frequency', tick: sim.world.tick, callsign, controller: 'ramp' },
        { type: 'not-on-frequency', tick: sim.world.tick, callsign, controller: 'ramp' },
      ]);
      expect(JSON.stringify(sim.world.aircraft.find((a) => a.callsign === callsign)), callsign).toBe(before);
      transmit(sim, `${callsign} request-crossing`);
      step(sim, 40);
      expect(drainEvents(sim).filter((e) => e.callsign === callsign).map((e) => e.type)).toEqual(['crossing-requested', 'crossing-unable']);
    };
    const until = (callsign: string, status: string) => {
      const there = () => getAircraft(sim, callsign).status === status && getAircraft(sim, callsign).controller === 'ramp';
      for (let t = 0; t < 6000 && !there(); t++) step(sim, 1);
      expect(getAircraft(sim, callsign)).toMatchObject({ status, controller: 'ramp' });
    };
    tryAll('DAL4'); // parked
    until('BAW1', 'taxiing');
    tryAll('BAW1'); // taxiing in
    until('DAL4', 'pushing-back');
    tryAll('DAL4'); // pushing back
    until('DAL4', 'taxiing');
    tryAll('DAL4'); // taxiing out
    until('BAW1', 'parked');
    tryAll('BAW1'); // parked at its gate
  });
});

describe('ramp routes', () => {
  it.each([
    ['TEST', TEST],
    ['KJFK', KJFK],
  ])('every departure plan at %s stays on open ramp lanes, out of other stands, off every runway', (_name, index) => {
    const sim = createSim(index, { seed: 1 });
    const onRunway = new Set(index.airport.edges.filter((e) => e.kind === 'runway').flatMap((e) => [e.from, e.to]));
    const counts: Record<string, number> = {};
    for (const type of ['A320', 'B77W'] as const) {
      for (const gate of index.airport.gates) {
        const plan = departurePlanFor(sim, gate.id, type);
        if ('unable' in plan) {
          counts[`${type} unable`] = (counts[`${type} unable`] ?? 0) + 1;
          continue;
        }
        counts[`${type} ok`] = (counts[`${type} ok`] ?? 0) + 1;
        // Its own stand's edges are the only stand edges it uses.
        const stand = sim.ramp.stands.get(gate.id);
        const own = new Set(stand && 'edges' in stand ? stand.edges : []);
        for (const way of [plan.push, plan.out]) {
          for (const id of way.edges) {
            const edge = index.edges.get(id);
            expect(edge?.kind).toBe('rampLane');
            expect(edge?.closed).toBeUndefined();
            if (!own.has(id)) expect(sim.ramp.standEdges.has(id)).toBe(false);
          }
          for (const n of way.nodes) expect(onRunway.has(n)).toBe(false);
        }
        // It leaves by a ramp edge serving the gate's terminal, and ends on its node.
        const handoff = index.airport.rampHandoffs.find((h) => h.id === plan.rampHandoff);
        expect(handoff?.use).not.toBe('arrivals');
        expect(handoff?.terminals ?? [gate.terminal]).toContain(gate.terminal);
        expect(plan.out.nodes.at(-1)).toBe(handoff?.node);
        // The push ends at the gate; the tail has the aircraft's length behind the push point.
        expect(plan.push.nodes.at(-1)).toBe(gate.node);
        expect(plan.pushTo).toBeGreaterThanOrEqual(AIRCRAFT_TYPES[type].lengthM);
      }
    }
    // How many gates each type can use. TEST's T1-3 has no pushback, and its 70–80 m stands are too
    // short for a B77W. KJFK's are floors: the data may only get better.
    if (index === TEST) expect(counts).toEqual({ 'A320 ok': 4, 'A320 unable': 1, 'B77W unable': 5 });
    else {
      expect(counts['A320 ok']).toBeGreaterThanOrEqual(123);
      expect(counts['B77W ok']).toBeGreaterThanOrEqual(58);
    }
  });
});

describe('arrivals', () => {
  it('acceptance: "monitor ramp", the entrance, its gate (the free one its airline uses), "arrived at gate", and the gate shows it (TEST T2)', () => {
    const sim = createSim(TEST, { seed: 1 });
    // On A at TC, westbound, an arrival for T2.
    addAircraft(sim, { callsign: 'BAW1', type: 'A320', role: 'arrival', airline: 'BAW', terminal: 'T2', at: { kind: 'node', node: 'aTC', arrivedVia: 'aTC-aJ' } });
    transmit(sim, 'BAW1 taxi ramp via TC, monitor ramp');
    expect(drainEvents(sim).map((e) => e.type)).toEqual(['command-applied', 'command-applied']);
    const events = runUntil(sim, (e) => e.type === 'arrived-at-gate', 10 * 60 * 10);
    const tick = (type: string) => events.find((e) => e.type === type)?.tick;
    expect(events.map((e) => e.type)).toEqual(['arrived', 'ramp-accepted', 'arrived-at-gate']);
    // Ramp takes it the tick after it stops at the entrance, and assigns B1: B2 is UAE's only.
    expect(events[1]).toEqual({ type: 'ramp-accepted', tick: (tick('arrived') ?? NaN) + 1, callsign: 'BAW1', rampHandoff: 'rhTC', gate: 'T2-B1' });
    expect(events[2]).toEqual({ type: 'arrived-at-gate', tick: sim.world.tick, callsign: 'BAW1', gate: 'T2-B1' });
    const baw = getAircraft(sim, 'BAW1');
    expect(baw).toMatchObject({ controller: 'ramp', status: 'parked', speedMps: 0, clearance: null, role: 'arrival' });
    expect(baw.location).toEqual({ kind: 'node', node: 'gB1', arrivedVia: 'tdA-gB1' });
    expect(baw.headingDeg).toBeCloseTo(0, 6);
    expect(getGate(sim, 'T2-B1').occupant).toBe('BAW1');
    // It stays parked.
    step(sim, 3000);
    expect(drainEvents(sim)).toEqual([]);
    expect(getAircraft(sim, 'BAW1').nose).toEqual(baw.nose);
  });

  it('acceptance: "monitor ramp", the Kilo Golf entrance, a T4 gate over ramp lanes, "arrived at gate", the gate occupied (KJFK)', () => {
    const sim = createSim(KJFK, { seed: 1 });
    // On B at the foot of the KG stub.
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', role: 'arrival', airline: 'DAL', terminal: 'T4', at: { kind: 'node', node: 'n45379510', arrivedVia: 'w5786355-n45352239-n45379510' } });
    transmit(sim, 'DAL4 taxi ramp via KG, monitor ramp');
    expect(drainEvents(sim).map((e) => e.type)).toEqual(['command-applied', 'command-applied']);
    const events = runUntil(sim, (e) => e.type === 'arrived-at-gate', 15 * 60 * 10);
    expect(events.map((e) => e.type)).toEqual(['arrived', 'ramp-accepted', 'arrived-at-gate']);
    expect(events[0]).toMatchObject({ destination: { kind: 'ramp', terminal: 'T4', rampHandoff: 'rhKG' } });
    expect(events[1]).toMatchObject({ type: 'ramp-accepted', rampHandoff: 'rhKG' });
    const done = events[2];
    if (done?.type !== 'arrived-at-gate') throw new Error('no arrival');
    const gate = KJFK.airport.gates.find((g) => g.id === done.gate);
    expect(gate?.terminal).toBe('T4');
    expect(getGate(sim, done.gate).occupant).toBe('DAL4');
    const dal4 = getAircraft(sim, 'DAL4');
    expect(dal4).toMatchObject({ controller: 'ramp', status: 'parked', speedMps: 0 });
    expect(dal4.location).toMatchObject({ kind: 'node', node: gate?.node });
    // In from the entrance over ramp lanes only.
    const track = sim.world.aircraft[0]?.track;
    const entrance = track?.nodes.indexOf(KJFK.airport.rampHandoffs.find((h) => h.id === 'rhKG')?.node ?? '') ?? -1;
    expect(entrance).toBeGreaterThanOrEqual(0);
    expect(track?.edges.slice(entrance).every((id) => KJFK.edges.get(id)?.kind === 'rampLane')).toBe(true);
  });
});

describe('gate assignment', () => {
  it("prefers a free gate its airline uses (the gate's airlines, else the terminal's), at random among those (TEST T2, 20 seeds)", () => {
    const gateFor = (seed: number, airline: string) => {
      const sim = createSim(TEST, { seed });
      addAircraft(sim, { callsign: 'X1', type: 'A320', role: 'arrival', airline, terminal: 'T2', at: { kind: 'node', node: 'aTC', arrivedVia: 'aTC-aJ' } });
      transmit(sim, 'X1 taxi ramp via TC, monitor ramp');
      const accepted = runUntil(sim, (e) => e.type === 'ramp-accepted', 3000).find((e) => e.type === 'ramp-accepted');
      return accepted?.type === 'ramp-accepted' ? accepted.gate : null;
    };
    const seeds = Array.from({ length: 20 }, (_, i) => i + 1);
    // B2 is UAE's only; B1 has no list, so it's any T2 airline's.
    expect(new Set(seeds.map((s) => gateFor(s, 'BAW')))).toEqual(new Set(['T2-B1']));
    expect(new Set(seeds.map((s) => gateFor(s, 'UAE')))).toEqual(new Set(['T2-B1', 'T2-B2']));
  });
});

describe('arrivals waiting', () => {
  it("with no gate free, it waits at the entrance, still ground's; once the departure at B2 has gone, it gets B2 (TEST T2)", () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'AFR9', type: 'A320', role: 'arrival', at: { kind: 'gate', gate: 'T2-B1' } });
    addAircraft(sim, { callsign: 'UAE5', type: 'A320', at: { kind: 'gate', gate: 'T2-B2' } });
    addAircraft(sim, { callsign: 'BAW1', type: 'A320', role: 'arrival', airline: 'BAW', terminal: 'T2', at: { kind: 'node', node: 'aTC', arrivedVia: 'aTC-aJ' } });
    transmit(sim, 'BAW1 taxi ramp via TC, monitor ramp');
    const events = runUntil(sim, (e) => e.type === 'arrived', 600);
    expect(events.filter((e) => e.callsign === 'BAW1').map((e) => e.type)).toEqual(['command-applied', 'command-applied', 'arrived']);
    step(sim, 10);
    expect(getAircraft(sim, 'BAW1')).toMatchObject({ controller: 'ground', status: 'arrived' });
    expect(getGate(sim, 'T2-B2').occupant).toBe('UAE5');
    // Still ground's: the player can talk to it.
    transmit(sim, 'BAW1 hold');
    transmit(sim, 'BAW1 continue');
    expect(drainEvents(sim).map((e) => e.type)).toEqual(['command-applied', 'command-applied']);
    // UAE5 pushes, leaves by TB and checks in; then B2 is free, and BAW1 goes in.
    const later = runUntil(sim, (e) => e.type === 'arrived-at-gate', 15 * 60 * 10);
    const order = later.filter((e) => ['pushback', 'check-in', 'ramp-accepted', 'arrived-at-gate'].includes(e.type)).map((e) => `${e.type} ${e.callsign}`);
    expect(order).toEqual(['pushback UAE5', 'check-in UAE5', 'ramp-accepted BAW1', 'arrived-at-gate BAW1']);
    expect(later.find((e) => e.type === 'check-in')).toMatchObject({ rampHandoff: 'rhTB', taxilane: 'TB' });
    expect(later.find((e) => e.type === 'ramp-accepted')).toMatchObject({ gate: 'T2-B2' });
    expect(getGate(sim, 'T2-B2').occupant).toBe('BAW1');
  });

  it('"monitor ramp" given away from the entrance is recorded and does nothing until the aircraft stops there (TEST T2)', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'BAW1', type: 'A320', role: 'arrival', airline: 'BAW', terminal: 'T2', at: { kind: 'node', node: 'aC', arrivedVia: 'aTB-aC' } });
    transmit(sim, 'BAW1 monitor ramp');
    step(sim, 600);
    expect(getAircraft(sim, 'BAW1')).toMatchObject({ controller: 'ground', status: 'idle', advisories: { handoff: { facility: 'ramp' } } });
    expect(drainEvents(sim).map((e) => e.type)).toEqual(['command-applied']);
    expect(sim.world.ramp.aircraft).toEqual([]);
    // Taxied to the entrance later, ramp takes it there.
    transmit(sim, 'BAW1 taxi ramp via A TC');
    const events = runUntil(sim, (e) => e.type === 'arrived-at-gate', 10 * 60 * 10);
    expect(events.map((e) => e.type)).toEqual(['command-applied', 'arrived', 'ramp-accepted', 'arrived-at-gate']);
  });
});

describe('a busy lane', () => {
  // UAE5 pushes from B2 tail-first east into tdB–tdE, the lane BAW1 comes in along from TC.
  const setup = (seed: number) => {
    const sim = createSim(TEST, { seed });
    addAircraft(sim, { callsign: 'UAE5', type: 'A320', airline: 'UAE', at: { kind: 'gate', gate: 'T2-B2' } });
    addAircraft(sim, { callsign: 'BAW1', type: 'A320', role: 'arrival', airline: 'BAW', terminal: 'T2', at: { kind: 'node', node: 'aTC', arrivedVia: 'aTC-aJ' } });
    return sim;
  };
  const tickOf = (events: SimEvent[], type: string, callsign: string) => events.find((e) => e.type === type && e.callsign === callsign)?.tick ?? NaN;

  it('an arrival at the entrance waits there, ground\'s, while a departure pushes into its lane and taxis out (TEST T2)', () => {
    const sim = setup(1);
    const events = runUntil(sim, (e) => e.type === 'pushback', 1000);
    transmit(sim, 'BAW1 taxi ramp via TC, monitor ramp');
    events.push(...runUntil(sim, (e) => e.type === 'arrived', 1000));
    // At the entrance during the push: it stays there, ground's, with its gate held.
    for (let t = 0; t < 10 * 60 * 10 && !events.some((e) => e.type === 'check-in'); t++) {
      step(sim, 1);
      events.push(...drainEvents(sim));
      if (events.some((e) => e.type === 'check-in')) break;
      expect(getAircraft(sim, 'BAW1')).toMatchObject({ controller: 'ground', status: 'arrived', speedMps: 0 });
    }
    expect(getGate(sim, 'T2-B1').occupant).toBe('BAW1');
    events.push(...runUntil(sim, (e) => e.type === 'arrived-at-gate', 10 * 60 * 10));
    expect(tickOf(events, 'arrived', 'BAW1')).toBeLessThan(tickOf(events, 'check-in', 'UAE5'));
    expect(tickOf(events, 'ramp-accepted', 'BAW1')).toBeGreaterThanOrEqual(tickOf(events, 'check-in', 'UAE5'));
  });

  it("a departure doesn't push into the lane an arrival is taxiing in along: it waits at the gate until the arrival has parked (TEST T2)", () => {
    const sim = setup(4);
    transmit(sim, 'BAW1 taxi ramp via TC, monitor ramp');
    const readyTick = sim.world.ramp.aircraft.find((r) => r.callsign === 'UAE5')?.readyTick ?? NaN;
    const events = runUntil(sim, (e) => e.type === 'arrived-at-gate', 10 * 60 * 10);
    // UAE5 was ready to push while BAW1 was on its way in, and stayed parked.
    expect(readyTick).toBeGreaterThan(tickOf(events, 'ramp-accepted', 'BAW1'));
    expect(readyTick).toBeLessThan(sim.world.tick);
    expect(events.some((e) => e.type === 'pushback')).toBe(false);
    expect(getAircraft(sim, 'UAE5')).toMatchObject({ status: 'parked', speedMps: 0 });
    events.push(...runUntil(sim, (e) => e.type === 'check-in', 10 * 60 * 10));
    expect(tickOf(events, 'pushback', 'UAE5')).toBeGreaterThanOrEqual(tickOf(events, 'arrived-at-gate', 'BAW1'));
  });
});

describe('departure streams', () => {
  it('spawn at free gates of their terminal at the stream rate, ±15% from the seed; the same seed gives the same spawns (TEST T1)', () => {
    const spawns = (seed: number) => {
      const departures = [{ perHour: 12, flight: (n: number) => ({ callsign: `JBU${n + 1}`, type: n % 2 ? 'A321' : 'A320', airline: 'JBU', terminal: 'T1' }) }];
      const sim = createSim(TEST, { seed, departures });
      const seen: [tick: number, callsign: string, gate: string][] = [];
      for (let t = 0; t < 60 * 60 * 10; t++) {
        step(sim, 1);
        for (const e of drainEvents(sim)) if (e.type === 'check-in') removeAircraft(sim, e.callsign); // gone: the player's
        for (const r of sim.world.ramp.aircraft) if (!seen.some(([, c]) => c === r.callsign)) seen.push([sim.world.tick, r.callsign, r.gate]);
      }
      return seen;
    };
    const one = spawns(1);
    expect(one.map(([, c]) => c)).toEqual(Array.from({ length: one.length }, (_, i) => `JBU${i + 1}`));
    // An hour at 12 an hour, the first at once: 12 or 13 with the jitter.
    expect(one.length).toBeGreaterThanOrEqual(12);
    expect(one.length).toBeLessThanOrEqual(13);
    expect(one[0]?.[0]).toBe(1);
    // T1-3 has no pushback, so only T1-1 and T1-2.
    expect(new Set(one.map(([, , g]) => g))).toEqual(new Set(['T1-1', 'T1-2']));
    for (let i = 1; i < one.length; i++) {
      const gap = ((one[i]?.[0] ?? NaN) - (one[i - 1]?.[0] ?? NaN)) / 10;
      expect(gap).toBeGreaterThanOrEqual(300 * 0.85);
      expect(gap).toBeLessThanOrEqual(300 * 1.15 + 0.1);
    }
    expect(spawns(1)).toEqual(one);
    expect(spawns(2)).not.toEqual(one);
  });
});

describe('paths that only meet at a junction', () => {
  it("are taken one at a time: two departures whose ways out cross at one node don't meet there (KJFK T4, out by HB and by G)", () => {
    const sim = createSim(KJFK, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL1', type: 'A320', at: { kind: 'gate', gate: 'g744203522' } });
    addAircraft(sim, { callsign: 'DAL2', type: 'A320', at: { kind: 'gate', gate: 'g744203549' } });
    const [p1, p2] = [departurePlanFor(sim, 'g744203522', 'A320'), departurePlanFor(sim, 'g744203549', 'A320')];
    if ('unable' in p1 || 'unable' in p2) throw new Error('no plan');
    // No edge in common; node n4068921741 in common.
    const e1 = new Set([...p1.push.edges, ...p1.out.edges]);
    expect([...p2.push.edges, ...p2.out.edges].some((e) => e1.has(e))).toBe(false);
    const n1 = new Set([...p1.push.nodes, ...p1.out.nodes]);
    expect([...new Set([...p2.push.nodes, ...p2.out.nodes])].filter((n) => n1.has(n))).toEqual(['n4068921741']);
    // Both ready to push on the same tick (set directly, rather than hunting for a seed).
    for (const r of sim.world.ramp.aircraft) r.readyTick = 300;
    const events: SimEvent[] = [];
    for (let t = 0; t < 20 * 60 * 10 && events.filter((e) => e.type === 'check-in').length < 2; t++) {
      step(sim, 1);
      events.push(...drainEvents(sim));
      expect(footprintsOverlap(sim, 'DAL1', 'DAL2')).toBe(false);
    }
    expect(events.filter((e) => e.type === 'check-in').map((e) => e.callsign).sort()).toEqual(['DAL1', 'DAL2']);
    expect(events.filter((e) => e.type === 'stopped-for-traffic')).toEqual([]);
    // The second pushes only once the first is out.
    const [first, second] = events.filter((e) => e.type === 'pushback');
    expect(second?.tick ?? NaN).toBeGreaterThanOrEqual(events.find((e) => e.type === 'check-in' && e.callsign === first?.callsign)?.tick ?? NaN);
  });
});

describe('removing an aircraft', () => {
  it('frees its gate and whatever it held: a waiting arrival goes in once the departure pushing ahead of it is removed (TEST T2)', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'AFR9', type: 'A320', role: 'arrival', at: { kind: 'gate', gate: 'T2-B1' } });
    removeAircraft(sim, 'AFR9');
    expect(getGate(sim, 'T2-B1').occupant).toBeNull();
    expect(sim.world.ramp.aircraft).toEqual([]);
    addAircraft(sim, { callsign: 'UAE5', type: 'A320', airline: 'UAE', at: { kind: 'gate', gate: 'T2-B2' } });
    addAircraft(sim, { callsign: 'BAW1', type: 'A320', role: 'arrival', airline: 'BAW', terminal: 'T2', at: { kind: 'node', node: 'aTC', arrivedVia: 'aTC-aJ' } });
    runUntil(sim, (e) => e.type === 'pushback', 1000);
    transmit(sim, 'BAW1 taxi ramp via TC, monitor ramp');
    runUntil(sim, (e) => e.type === 'arrived', 1000);
    step(sim, 50);
    expect(getAircraft(sim, 'BAW1').controller).toBe('ground');
    removeAircraft(sim, 'UAE5');
    expect(getGate(sim, 'T2-B2').occupant).toBeNull();
    const events = runUntil(sim, (e) => e.type === 'ramp-accepted', 2);
    expect(events.map((e) => e.type)).toEqual(['ramp-accepted']);
  });
});

describe('departures', () => {
  it('push back after boarding: tail-first out of the stand and north onto lane 7, ending nose on l7A facing south toward the ramp edge (TEST T1-1)', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'gate', gate: 'T1-1' } });
    const events = runUntil(sim, (e) => e.type === 'pushback', 90 * 10 + 1);
    expect(events).toEqual([{ type: 'pushback', tick: sim.world.tick, callsign: 'DAL4', gate: 'T1-1' }]);
    expect(sim.world.tick).toBeGreaterThanOrEqual(30 * 10);
    let last = getAircraft(sim, 'DAL4');
    expect(last.status).toBe('pushing-back');
    // Until it stops: backward, never faster than the push speed, its nose always facing the gate's way.
    for (let t = 0; t < 3000 && !(last.speedMps === 0 && last.location.kind === 'node' && last.location.node === 'l7A'); t++) {
      step(sim, 1);
      const now = getAircraft(sim, 'DAL4');
      expect(now.status).toBe('pushing-back');
      expect(now.speedMps).toBeLessThanOrEqual(1.5 + 1e-9);
      const moved: [number, number] = [now.nose[0] - last.nose[0], now.nose[1] - last.nose[1]];
      const rad = ((now.headingDeg ?? NaN) * Math.PI) / 180;
      expect(moved[0] * Math.sin(rad) + moved[1] * Math.cos(rad)).toBeLessThanOrEqual(1e-9);
      last = now;
    }
    // Pushed: on lane 7, nose on l7A, facing south (toward rb7), tail north up the lane.
    expect(last.location).toEqual({ kind: 'node', node: 'l7A', arrivedVia: 'l7A-l7B' });
    expect(last.headingDeg).toBeCloseTo(180, 6);
    expect(last.speedMps).toBe(0);
    expect(last.nose).toEqual([-800, 400]);
    expect(drainEvents(sim)).toEqual([]);
  });

  it('acceptance: gate → pushback → ramp edge → check-in on 7, then ground, whose taxi from there resolves (TEST T1-2)', () => {
    const sim = createSim(TEST, { seed: 3 });
    addAircraft(sim, { callsign: 'JBU1', type: 'A321', airline: 'JBU', at: { kind: 'gate', gate: 'T1-2' } });
    const cruise = sim.world.aircraft[0]?.cruiseMps;
    const events = runUntil(sim, (e) => e.type === 'check-in', 10 * 60 * 10);
    expect(events.map((e) => e.type)).toEqual(['pushback', 'check-in']);
    expect(events.at(-1)).toEqual({ type: 'check-in', tick: sim.world.tick, callsign: 'JBU1', rampHandoff: 'rh7', taxilane: '7', atis: null });
    const jbu = getAircraft(sim, 'JBU1');
    // Ground's now, stopped with its nose on the ramp edge, having come down lane 7, at its own speed again.
    expect(jbu).toMatchObject({ controller: 'ground', status: 'idle', speedMps: 0, clearance: null });
    expect(jbu.location).toEqual({ kind: 'node', node: 'rb7', arrivedVia: 'rb7-l7A' });
    expect(sim.world.aircraft[0]?.cruiseMps).toBe(cruise);
    expect(sim.world.aircraft[0]?.motion).toBe('taxi');
    expect(getGate(sim, 'T1-2').occupant).toBeNull();
    transmit(sim, 'JBU1 taxi 27 via #7 L:A');
    expect(drainEvents(sim).map((e) => e.type)).toEqual(['command-applied']);
    expect(getAircraft(sim, 'JBU1').clearance?.path.nodes.slice(0, 3)).toEqual(['rb7', 'a7', 'aD']);
    step(sim, 100);
    expect(getAircraft(sim, 'JBU1').speedMps).toBeGreaterThan(0);
  });

  it('acceptance: gate → pushback → ramp edge → check-in on Kilo Foxtrot, then a taxi to 31L from there resolves (KJFK T4)', () => {
    const sim = createSim(KJFK, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', airline: 'DAL', at: { kind: 'gate', gate: 'g1009800796' } });
    expect(getAircraft(sim, 'DAL4')).toMatchObject({ controller: 'ramp', status: 'parked' });
    const events = runUntil(sim, (e) => e.type === 'check-in', 10 * 60 * 10);
    expect(events.map((e) => e.type)).toEqual(['pushback', 'check-in']);
    expect(events.at(-1)).toEqual({ type: 'check-in', tick: sim.world.tick, callsign: 'DAL4', rampHandoff: 'rhKF', taxilane: 'KF', atis: null });
    const dal4 = getAircraft(sim, 'DAL4');
    expect(dal4).toMatchObject({ controller: 'ground', status: 'idle', speedMps: 0 });
    expect(dal4.location).toMatchObject({ kind: 'node', node: KJFK.airport.rampHandoffs.find((h) => h.id === 'rhKF')?.node });
    // It came out over ramp lanes only.
    const track = sim.world.aircraft[0]?.track;
    expect(track?.edges.every((id) => KJFK.edges.get(id)?.kind === 'rampLane')).toBe(true);
    transmit(sim, 'DAL4 taxi 31L via KF L:A G Z');
    expect(drainEvents(sim).map((e) => e.type)).toEqual(['command-applied']);
    expect(getAircraft(sim, 'DAL4').clearance?.path.destination).toMatchObject({ kind: 'runway', runwayEnd: '31L' });
  });
});
