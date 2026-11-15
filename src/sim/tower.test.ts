// The simulated tower (PLAN 1.10): arrivals, departures, crossing requests and runway safety,
// on TEST and KJFK.

import { describe, expect, it } from 'vitest';
import kjfkBase from '../../data/airports/KJFK.json' with { type: 'json' };
import kjfkOverrides from '../../data/airports/KJFK.overrides.json' with { type: 'json' };
import testAirport from '../../data/airports/TEST.json' with { type: 'json' };
import { indexAirport } from '../airport/graph.ts';
import { loadAirport } from '../airport/load.ts';
import { addAircraft, applyCommand, createSim, drainEvents, getAircraft, removeAircraft, step, type Sim, type SimEvent } from './sim.ts';
import { parseTerse } from './terse.ts';

const TEST = indexAirport(loadAirport(testAirport));
const KJFK = indexAirport(loadAirport(kjfkBase, kjfkOverrides));

/** Applies a terse command, which must parse. */
function transmit(sim: Sim, text: string): void {
  const result = parseTerse(text);
  if (!result.ok) throw new Error(`'${text}' doesn't parse: ${result.error.message}`);
  applyCommand(sim, result.command);
}

describe('arrivals', () => {
  it('spawn on final: an airborne arrival under tower, on-final, before the runway end (TEST 27)', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'BAW175', type: 'A320', at: { kind: 'final', runwayEnd: '27', distanceM: 3000 } });
    const baw = getAircraft(sim, 'BAW175');
    expect(baw).toMatchObject({ role: 'arrival', controller: 'tower', airborne: true, status: 'on-final', clearance: null });
    expect(baw.final).toEqual({ runwayEnd: '27', distanceM: 3000 });
    // 27's threshold is displaced 150 m, so 3000 m before it is 2850 m before the runway end (r1E,
    // x = 1500), flying west along the centreline. Off the graph, its location is the runway end.
    expect(baw.location).toEqual({ kind: 'node', node: 'r1E', arrivedVia: null });
    expect(baw.nose[0]).toBeCloseTo(1500 + 2850, 6);
    expect(baw.nose[1]).toBeCloseTo(0, 6);
    expect(baw.headingDeg).toBeCloseTo(270, 6);
  });

  it('acceptance: an arrival lands, exits at a configured exit and calls ground, clear of the runway (TEST 27)', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'BAW175', type: 'A320', at: { kind: 'final', runwayEnd: '27', distanceM: 3000 } });
    const events = runUntil(sim, (e) => e.type === 'clear-of-runway', 3000);
    const mine = events.filter((e) => e.callsign === 'BAW175');
    // It rolls through rX, where 9/27 meets 18/36: the runway edges touching rX are in both
    // areas (occupancy.ts), so it leaves 18/36's area first.
    expect(mine.map((e) => (e.type === 'crossed-runway' ? `crossed ${e.runway}` : e.type))).toEqual(['landed', 'crossed 18/36', 'crossed 9/27', 'clear-of-runway']);
    const call = events.find((e) => e.type === 'clear-of-runway');
    // west flow's 27 exits: C, and D either way.
    expect(call).toMatchObject({ callsign: 'BAW175', runwayEnd: '27' });
    expect(call?.type === 'clear-of-runway' && [['C', 'x27C'], ['D', 'x27DN'], ['D', 'x27DS']]).toContainEqual(call?.type === 'clear-of-runway' && [call.exit, call.exitId]);
    const baw = getAircraft(sim, 'BAW175');
    expect(baw).toMatchObject({ controller: 'ground', status: 'idle', airborne: false, speedMps: 0, clearance: null, final: null, role: 'arrival' });
    expect(sim.world.aircraft.find((a) => a.callsign === 'BAW175')?.runways).toEqual([]);
    // Stopped on the exit taxiway, its tail past the exit's hold line (y = ±90 on C and D).
    expect(Math.abs(baw.nose[1])).toBeGreaterThanOrEqual(90 + baw.lengthM);
    // Ground can taxi it now.
    transmit(sim, 'BAW175 hold');
    expect(drainEvents(sim).map((e) => e.type)).toEqual(['command-applied']);
  });

  it("fails loudly for a runway end whose configured exits can't be reached braking at the maximum (TEST 36: F is 700 m in)", () => {
    const sim = createSim(TEST, { seed: 1 });
    const message = /no configured exit of runway 36 can be reached braking at most 3\.5 m\/s² from touchdown 300 m past the threshold \(x36F at 700 m past the threshold needs 6\.0 m\/s²\)/;
    expect(() => addAircraft(sim, { callsign: 'BAW175', type: 'A320', at: { kind: 'final', runwayEnd: '36', distanceM: 3000 } })).toThrow(message);
    expect(sim.world.aircraft).toEqual([]);
    expect(sim.world.tower.arrivals).toEqual([]);
    expect(() => createSim(TEST, { seed: 1, arrivals: [{ runwayEnd: '36', perHour: 10, flight: (n) => ({ callsign: `BAW${n + 1}`, type: 'A320' }) }] })).toThrow(message);
    // 9 isn't an arrival runway in the west flow.
    expect(() => addAircraft(sim, { callsign: 'BAW175', type: 'A320', at: { kind: 'final', runwayEnd: '9', distanceM: 3000 } })).toThrow("BAW175: runway 9 doesn't take arrivals in this configuration");
  });

  it('are spawned on final at the stream rate, ±15% from the seed, at 5 NM; the same seed and options give the same spawns (TEST 27)', () => {
    const spawns = (seed: number) => {
      const sim = createSim(TEST, { seed, arrivals: [{ runwayEnd: '27', perHour: 20, flight: (n) => ({ callsign: `BAW${n + 1}`, type: n % 2 ? 'B77W' : 'A320', airline: 'BAW' }) }] });
      const seen: [tick: number, callsign: string][] = [];
      for (let t = 0; t < 60 * 60 * 10; t++) {
        step(sim, 1);
        for (const ac of sim.world.aircraft) {
          if (seen.some(([, c]) => c === ac.callsign)) continue;
          seen.push([sim.world.tick, ac.callsign]);
          const view = getAircraft(sim, ac.callsign);
          expect(view).toMatchObject({ status: 'on-final', airline: 'BAW', role: 'arrival', final: { runwayEnd: '27' } });
          // Spawned at 5 NM in this tick, then flown for it.
          expect(view.final?.distanceM).toBeCloseTo(5 * 1852 - 0.1 * view.speedMps, 6);
        }
        for (const e of drainEvents(sim)) {
          if (e.type === 'clear-of-runway') removeAircraft(sim, e.callsign);
          expect(e.type).not.toBe('go-around');
        }
      }
      return seen;
    };
    const a = spawns(5);
    expect(a.map(([, c]) => c)).toEqual(a.map((_, i) => `BAW${i + 1}`));
    expect(a[0]?.[0]).toBe(1);
    const gaps = a.slice(1).map(([t], i) => (t - (a[i]?.[0] ?? 0)) / 10);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(180 * 0.85);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(180 * 1.15);
    expect(a.length).toBeGreaterThanOrEqual(18);
    expect(a.length).toBeLessThanOrEqual(23);
    expect(spawns(5)).toEqual(a);
    expect(spawns(6)).not.toEqual(a);
  });

  it('go around when the runway is occupied at the decision point, rejoining final behind the others (TEST 27)', () => {
    const sim = createSim(TEST, { seed: 1 });
    // On the runway with no clearance from tower: nose on the centreline at C.
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'node', node: 'r1C', arrivedVia: 'cHN-r1C' } });
    addAircraft(sim, { callsign: 'BAW175', type: 'A320', at: { kind: 'final', runwayEnd: '27', distanceM: 3000 } });
    addAircraft(sim, { callsign: 'BAW176', type: 'A320', at: { kind: 'final', runwayEnd: '27', distanceM: 3000 + 100 * 69.45 + 500 } });
    const events = runUntil(sim, (e) => e.type === 'go-around', 1000);
    expect(events.filter((e) => e.type === 'go-around')).toEqual([{ type: 'go-around', tick: expect.any(Number), callsign: 'BAW175', runwayEnd: '27', reason: 'DAL4 on the runway' }]);
    // Behind BAW176, at least the arrival spacing back.
    const [first, second] = [getAircraft(sim, 'BAW175'), getAircraft(sim, 'BAW176')];
    expect(first).toMatchObject({ status: 'on-final', airborne: true, controller: 'tower' });
    expect((first.final?.distanceM ?? 0) - (second.final?.distanceM ?? 0)).toBeCloseTo(100 * (135 * 1852) / 3600, 6);
    expect(events.some((e) => e.type === 'landed')).toBe(false);
    // With the runway clear, both land.
    removeAircraft(sim, 'DAL4');
    const after = runUntil(sim, (e) => e.type === 'landed' && e.callsign === 'BAW175', 6000);
    expect(after.filter((e) => e.type === 'landed').map((e) => e.callsign)).toEqual(['BAW176', 'BAW175']);
    expect(after.some((e) => e.type === 'go-around')).toBe(false);
  });

  it('are sent only to exits reached braking between 1.2 and 3.5 m/s², so they clear 31L within a minute of the threshold (KJFK)', () => {
    const used = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const sim = createSim(KJFK, { seed });
      addAircraft(sim, { callsign: 'AAL100', type: 'A321', at: { kind: 'final', runwayEnd: '31L', distanceM: 2000 } });
      const events = runUntil(sim, (e) => e.type === 'clear-of-runway', 3000);
      const call = events.find((e) => e.type === 'clear-of-runway');
      if (call?.type === 'clear-of-runway') used.add(call.exitId);
    }
    // PC to PF, 2.7–3.1 km past touchdown, would need less than 1.2 m/s²: too far to roll out to.
    expect([...used].sort()).toEqual(['x31L-MB', 'x31L-MC', 'x31L-MD', 'x31L-PA']);
  });

  it('acceptance: arrivals on 31L and 31R land, exit at one of the 31s exits and call ground, clear (KJFK)', () => {
    const exits = (end: string) => KJFK.airport.configurations.find((c) => c.id === '31s')?.runways.find((r) => r.end === end)?.arrivalExits ?? [];
    for (const [end, type, seed] of [['31L', 'A320', 1], ['31L', 'B77W', 2], ['31R', 'A321', 3], ['31R', 'A388', 4]] as const) {
      const sim = createSim(KJFK, { seed });
      addAircraft(sim, { callsign: 'UAE202', type, at: { kind: 'final', runwayEnd: end, distanceM: 4000 } });
      const events = runUntil(sim, (e) => e.type === 'clear-of-runway', 4000);
      const call = events.find((e) => e.type === 'clear-of-runway');
      if (call?.type !== 'clear-of-runway') throw new Error('no call');
      expect(call.runwayEnd, `${end} ${type}`).toBe(end);
      expect(exits(end), `${end} ${type}`).toContain(call.exitId);
      expect(call.exit, `${end} ${type}`).toBe(KJFK.airport.runwayExits.find((x) => x.id === call.exitId)?.taxiway ?? null);
      expect(events.filter((e) => e.type === 'landed')).toHaveLength(1);
      expect(getAircraft(sim, 'UAE202'), `${end} ${type}`).toMatchObject({ controller: 'ground', status: 'idle', speedMps: 0 });
      expect(sim.world.aircraft[0]?.runways, `${end} ${type}`).toEqual([]);
    }
  });
});

describe('departures', () => {
  /** Ticks from `from` (an event type) to `to`, for `callsign`. */
  const ticksBetween = (events: SimEvent[], callsign: string, from: SimEvent['type'], to: SimEvent['type']) => {
    const [a, b] = [events.find((e) => e.callsign === callsign && e.type === from), events.find((e) => e.callsign === callsign && e.type === to)];
    if (!a || !b) throw new Error(`${callsign}: no ${a ? to : from}`);
    return b.tick - a.tick;
  };

  it('acceptance: a departure handed off at the hold-short takes off within 2 minutes when the runway is free, then leaves (TEST 27)', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'B738', at: { kind: 'node', node: 'aP2', arrivedVia: 'aP1-aP2' } });
    transmit(sim, 'DAL4 taxi 27 via A, monitor tower');
    drainEvents(sim);
    const events = runUntil(sim, (e) => e.type === 'departed', 6000).filter((e) => e.callsign === 'DAL4');
    // On the roll it leaves the stretch by rX that's in 18/36's area too (occupancy.ts); leaving
    // the ground isn't crossing a runway, so there's no event for 9/27.
    expect(events.map((e) => (e.type === 'crossed-runway' ? `crossed ${e.runway}` : e.type))).toEqual([
      'arrived',
      'tower-accepted',
      'lining-up',
      'takeoff-roll',
      'crossed 18/36',
      'took-off',
      'departed',
    ]);
    expect(events.find((e) => e.type === 'tower-accepted')).toMatchObject({ runwayEnd: '27' });
    expect(ticksBetween(events, 'DAL4', 'arrived', 'took-off')).toBeLessThanOrEqual(120 * 10);
    expect(sim.world.aircraft).toEqual([]);
    expect(sim.world.tower.departures).toEqual([]);
  });

  it('launches a departure behind a heavy 2 minutes after its roll began (TEST 27)', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'BAW1', type: 'B77W', at: { kind: 'node', node: 'aE', arrivedVia: 'aP2-aE' } });
    addAircraft(sim, { callsign: 'DAL2', type: 'B738', at: { kind: 'node', node: 'aP1', arrivedVia: 'aH2-aP1' } });
    transmit(sim, 'BAW1 taxi 27 via A, monitor tower');
    transmit(sim, 'DAL2 taxi 27 via A, monitor tower');
    const rolls: { tick: number; callsign: string }[] = [];
    for (let t = 0; t < 6000 && rolls.length < 2; t++) {
      step(sim, 1);
      for (const e of drainEvents(sim)) if (e.type === 'takeoff-roll') rolls.push(e);
    }
    expect(rolls.map((r) => r.callsign)).toEqual(['BAW1', 'DAL2']);
    expect((rolls[1]?.tick ?? 0) - (rolls[0]?.tick ?? 0)).toBe(120 * 10);
  });

  it("isn't taken by tower at a runway the configuration doesn't depart from (TEST: 9 in the west flow)", () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'B738', at: { kind: 'node', node: 'a7', arrivedVia: 'a7-aD' } });
    transmit(sim, 'DAL4 taxi 9 via A, monitor tower');
    drainEvents(sim);
    step(sim, 3000);
    expect(drainEvents(sim).map((e) => e.type)).toEqual(['arrived']);
    expect(getAircraft(sim, 'DAL4')).toMatchObject({ controller: 'ground', status: 'arrived' });
  });

  it("doesn't line up while an aircraft is on the runway without tower's approval, and goes once it's gone (TEST 27)", () => {
    const sim = createSim(TEST, { seed: 1 });
    // On the runway with no clearance from tower: nose on the centreline at D.
    addAircraft(sim, { callsign: 'JBU11', type: 'A320', at: { kind: 'node', node: 'r1D', arrivedVia: 'dHN-r1D' } });
    addAircraft(sim, { callsign: 'DAL4', type: 'B738', at: { kind: 'node', node: 'aP2', arrivedVia: 'aP1-aP2' } });
    transmit(sim, 'DAL4 taxi 27 via A, monitor tower');
    drainEvents(sim);
    const waiting = runUntil(sim, (e) => e.type === 'tower-accepted', 1000);
    step(sim, 3000);
    expect([...waiting, ...drainEvents(sim)].filter((e) => e.callsign === 'DAL4').map((e) => e.type)).toEqual(['arrived', 'tower-accepted']);
    removeAircraft(sim, 'JBU11');
    expect(runUntil(sim, (e) => e.type === 'took-off', 1500).filter((e) => e.callsign === 'DAL4').map((e) => e.type)).toEqual(['lining-up', 'takeoff-roll', 'crossed-runway', 'took-off']);
  });

  it('acceptance: a departure handed off at the 31L hold takes off within 2 minutes when the runway is free (KJFK, A320 and B77W)', () => {
    for (const type of ['A320', 'B77W']) {
      const sim = createSim(KJFK, { seed: 1 });
      // The back of the 31L line, on Z (kjfk.test.ts).
      addAircraft(sim, { callsign: 'JBU11', type, at: { kind: 'node', node: 'n4057398125', arrivedVia: 'w162541297-n4057398125-n46547996' } });
      transmit(sim, 'JBU11 taxi 31L via Z, monitor tower');
      drainEvents(sim);
      const events = runUntil(sim, (e) => e.type === 'departed', 9000).filter((e) => e.callsign === 'JBU11');
      const flow = events.filter((e) => e.type !== 'crossed-runway').map((e) => e.type);
      expect(flow, type).toEqual(['arrived', 'tower-accepted', 'lining-up', 'takeoff-roll', 'took-off', 'departed']);
      expect(events.every((e) => !('runwayEnd' in e) || e.runwayEnd === '31L'), type).toBe(true);
      expect(ticksBetween(events, 'JBU11', 'arrived', 'took-off'), type).toBeLessThanOrEqual(120 * 10);
      expect(sim.world.aircraft, type).toEqual([]);
    }
  });
});

describe('crossing requests', () => {
  it('acceptance: are approved after a beat when the runway is idle; the approval is kept until the crossing is done (TEST, 27 on D)', () => {
    const sim = createSim(TEST, { seed: 1 });
    // Southbound on D, to the hardstand across 27: it stops at hDN (dHN).
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'node', node: 'dI', arrivedVia: 'aD-dI' } });
    transmit(sim, 'DAL4 taxi hardstand via D B G');
    runUntil(sim, (e) => e.type === 'holding-short', 600);
    transmit(sim, 'DAL4 request-crossing');
    expect(drainEvents(sim)).toEqual([{ type: 'crossing-requested', tick: expect.any(Number), callsign: 'DAL4', runway: null }]);
    const asked = sim.world.tick;
    const answer = runUntil(sim, (e) => e.type.startsWith('crossing-'), 100);
    expect(answer).toEqual([
      { type: 'crossing-approved', tick: asked + 30, callsign: 'DAL4', runways: ['9/27'], designators: ['27'], taxiway: 'D', holdShort: 'hDN' },
    ]);
    expect(sim.world.tower.approvals).toEqual([
      { callsign: 'DAL4', tick: asked + 30, entered: false, runways: ['9/27'], holdShort: 'hDN', node: 'dHN', runwayNode: 'r1D', taxiway: 'D', areas: ['9/27'] },
    ]);
    transmit(sim, 'DAL4 cross 27');
    const crossing = runUntil(sim, (e) => e.type === 'crossed-runway', 1200);
    expect(crossing.filter((e) => e.type === 'entered-runway')).toEqual([expect.objectContaining({ callsign: 'DAL4', holdShort: 'hDN', cleared: true })]);
    expect(sim.world.tower.approvals.map((a) => a.entered)).toEqual([true]);
    step(sim, 1);
    expect(sim.world.tower.approvals).toEqual([]);
  });

  it('acceptance: are held while an arrival is inside the window, with the callback once it is clear (TEST, 27 on D)', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'node', node: 'dI', arrivedVia: 'aD-dI' } });
    transmit(sim, 'DAL4 taxi hardstand via D B G');
    runUntil(sim, (e) => e.type === 'holding-short', 600);
    // 60 s out: inside the 80 s window.
    addAircraft(sim, { callsign: 'BAW175', type: 'A320', at: { kind: 'final', runwayEnd: '27', distanceM: 60 * 69.45 } });
    transmit(sim, 'DAL4 request-crossing');
    drainEvents(sim);
    const asked = sim.world.tick;
    const events = runUntil(sim, (e) => e.type === 'crossing-approved', 3000);
    const towerSays = events.filter((e) => e.type.startsWith('crossing-') && e.type !== 'crossed-runway');
    expect(towerSays).toEqual([
      { type: 'crossing-held', tick: asked + 30, callsign: 'DAL4', runways: ['9/27'], designators: ['27'], reason: 'traffic on final' },
      { type: 'crossing-approved', tick: expect.any(Number), callsign: 'DAL4', runways: ['9/27'], designators: ['27'], taxiway: 'D', holdShort: 'hDN' },
    ]);
    // The callback comes once the arrival is clear of 27: off at C, as DAL4's route uses both D exits.
    const clear = events.find((e) => e.callsign === 'BAW175' && e.type === 'crossed-runway' && e.runway === '9/27');
    const approved = towerSays[1];
    expect(clear && approved && approved.tick >= clear.tick).toBe(true);
    // Its call to ground comes after, once it has stopped.
    const call = runUntil(sim, (e) => e.type === 'clear-of-runway', 600).find((e) => e.type === 'clear-of-runway');
    expect(call).toMatchObject({ callsign: 'BAW175', exit: 'C' });
    expect(getAircraft(sim, 'DAL4').status).toBe('holding-short');
  });

  it('approvals not used within a minute are cancelled; one not yet used is withdrawn for landing traffic (TEST, 27 on D)', () => {
    const holding = () => {
      const sim = createSim(TEST, { seed: 1 });
      addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'node', node: 'dI', arrivedVia: 'aD-dI' } });
      transmit(sim, 'DAL4 taxi hardstand via D B G');
      runUntil(sim, (e) => e.type === 'holding-short', 600);
      transmit(sim, 'DAL4 request-crossing');
      const approved = runUntil(sim, (e) => e.type === 'crossing-approved', 100).find((e) => e.type === 'crossing-approved');
      return { sim, at: approved?.tick ?? NaN };
    };
    const cancelled = (tick: number, reason: string) => ({ type: 'crossing-cancelled', tick, callsign: 'DAL4', runways: ['9/27'], designators: ['27'], reason });

    const unused = holding();
    const late = runUntil(unused.sim, (e) => e.type === 'crossing-cancelled', 700);
    expect(late.filter((e) => e.type === 'crossing-cancelled')).toEqual([cancelled(unused.at + 600, 'not used')]);
    expect(unused.sim.world.tower.approvals).toEqual([]);

    // An arrival appears 25 s out (only a test can put one there): at its decision point tower
    // withdraws the approval DAL4 hasn't used, and lands it.
    const landing = holding();
    addAircraft(landing.sim, { callsign: 'BAW175', type: 'A320', at: { kind: 'final', runwayEnd: '27', distanceM: 25 * 69.45 } });
    const events = runUntil(landing.sim, (e) => e.type === 'landed', 400);
    expect(events.filter((e) => e.type === 'crossing-cancelled')).toEqual([cancelled(expect.any(Number) as unknown as number, 'landing traffic')]);
    expect(events.some((e) => e.type === 'go-around')).toBe(false);
    expect(landing.sim.world.tower.approvals).toEqual([]);
  });

  it('with no route are for the next runway ahead; tower says unable when there is no such crossing (TEST)', () => {
    const answer = (spawn: Parameters<typeof addAircraft>[1]['at'], commands: string[], request: string) => {
      const sim = createSim(TEST, { seed: 1 });
      addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: spawn });
      for (const c of commands) transmit(sim, c);
      transmit(sim, request);
      drainEvents(sim);
      return runUntil(sim, (e) => e.type.startsWith('crossing-'), 100).filter((e) => e.type.startsWith('crossing-'));
    };
    const east = { kind: 'node', node: 'aJ', arrivedVia: 'aTC-aJ' } as const;
    // No route, eastbound on A: the next runway ahead is 18/36, at hAW.
    expect(answer(east, [], 'DAL4 request-crossing')).toEqual([
      { type: 'crossing-approved', tick: 30, callsign: 'DAL4', runways: ['18/36'], designators: ['36'], taxiway: 'A', holdShort: 'hAW' },
    ]);
    const unable = (reason: string) => [{ type: 'crossing-unable', tick: 30, callsign: 'DAL4', reason }];
    // A dead end (a penalty box spot), and a route with no runway on it.
    expect(answer({ kind: 'node', node: 'pbS1', arrivedVia: 'e1-pbS1' }, [], 'DAL4 request-crossing')).toEqual(unable('no runway crossing ahead of DAL4'));
    expect(answer({ kind: 'node', node: 'aC', arrivedVia: 'aTB-aC' }, ['DAL4 taxi ramp T2 via A'], 'DAL4 request-crossing')).toEqual(unable("no runway crossing on DAL4's route"));
    // A named runway its route doesn't cross (27 is its destination, not a crossing), and one that doesn't exist.
    expect(answer(east, ['DAL4 taxi 27 via A'], 'DAL4 request-crossing 9')).toEqual(unable("no crossing of runway 9 on DAL4's route"));
    expect(answer(east, ['DAL4 taxi 27 via A'], 'DAL4 request-crossing 36')).toEqual([expect.objectContaining({ type: 'crossing-approved', holdShort: 'hAW' })]);
    expect(answer(east, [], 'DAL4 request-crossing 4L')).toEqual(unable('no runway 4L at TEST'));
  });

  it('acceptance: are approved when 31L is idle, and held for an arrival inside the window with the callback later (KJFK, 13R/31L on KE)', () => {
    const setUp = () => {
      const sim = createSim(KJFK, { seed: 1 });
      // Eastbound on A at the A/KF junction, then right on KE across 13R/31L (kjfk.test.ts).
      addAircraft(sim, { callsign: 'DAL4', type: 'B739', at: { kind: 'node', node: 'n13771028754', arrivedVia: 'w1356437398-n13771028753-n13771028754' } });
      transmit(sim, 'DAL4 taxi pad KILO via A R:KE K4 K');
      const held = runUntil(sim, (e) => e.type === 'holding-short', 1200).find((e) => e.type === 'holding-short');
      expect(held).toMatchObject({ holdShort: 'h5969626554', runways: ['13R/31L'] });
      return sim;
    };
    const approved = { type: 'crossing-approved', callsign: 'DAL4', runways: ['13R/31L'], designators: ['31L'], taxiway: 'KE', holdShort: 'h5969626554' };

    const idle = setUp();
    transmit(idle, 'DAL4 request-crossing');
    drainEvents(idle);
    expect(runUntil(idle, (e) => e.type.startsWith('crossing-'), 100)).toEqual([{ ...approved, tick: idle.world.tick }]);

    const busy = setUp();
    addAircraft(busy, { callsign: 'AAL100', type: 'A321', at: { kind: 'final', runwayEnd: '31L', distanceM: 60 * 69.45 } });
    transmit(busy, 'DAL4 request-crossing');
    drainEvents(busy);
    const events = runUntil(busy, (e) => e.type === 'crossing-approved', 3000);
    expect(events.filter((e) => e.type.startsWith('crossing-')).map((e) => e.type)).toEqual(['crossing-held', 'crossing-approved']);
    expect(events.find((e) => e.type === 'crossing-held')).toMatchObject({ reason: 'traffic on final' });
    expect(events.at(-1)).toMatchObject(approved);
    const clear = events.find((e) => e.callsign === 'AAL100' && e.type === 'crossed-runway' && e.runway === '13R/31L');
    expect(clear && clear.tick <= (events.at(-1)?.tick ?? 0)).toBe(true);
  });
});

describe('a runway used for both arrivals and departures (Q, 2026-11-14)', () => {
  /**
   * Runs a steady arrival stream against queued departures; returns the runway's ops in order, L
   * or T. Each arrival leaves once it calls ground (as if taxied away), so exits stay free.
   */
  function ops(sim: Sim, departures: number, ticks: number): string {
    let sequence = '';
    let rolled = 0;
    for (let t = 0; t < ticks && rolled < departures; t++) {
      step(sim, 1);
      for (const e of drainEvents(sim)) {
        if (e.type === 'clear-of-runway') removeAircraft(sim, e.callsign);
        if (e.type === 'landed') sequence += 'L';
        if (e.type === 'takeoff-roll') [sequence, rolled] = [sequence + 'T', rolled + 1];
        expect(e.type, `${e.callsign} at ${e.tick}`).not.toBe('go-around');
      }
    }
    return sequence;
  }
  const stream = (runwayEnd: string, perHour: number) => [{ runwayEnd, perHour, flight: (n: number) => ({ callsign: `BAW${n + 1}`, type: 'A320' }) }];

  it('interleaves landings and takeoffs on 27 while departures wait, with arrivals as close as tower allows (TEST, west flow)', () => {
    const sim = createSim(TEST, { seed: 3, arrivals: stream('27', 40) });
    // Three departures queued on A for 27's line, handed off; front to back.
    const queue: [callsign: string, node: string, arrivedVia: string][] = [
      ['DAL1', 'aE', 'aP2-aE'],
      ['DAL2', 'aP2', 'aP1-aP2'],
      ['DAL3', 'aP1', 'aH2-aP1'],
    ];
    for (const [callsign, node, arrivedVia] of queue) {
      addAircraft(sim, { callsign, type: 'B738', at: { kind: 'node', node, arrivedVia } });
      transmit(sim, `${callsign} taxi 27 via A, monitor tower`);
    }
    const sequence = ops(sim, 3, 60 * 60 * 10);
    expect(sequence).toMatch(/^L?(TL)+T$/);
    expect(sequence.match(/T/g)).toHaveLength(3);
  });

  it('interleaves landings and takeoffs on 31L while departures wait (KJFK, the 31s)', () => {
    const sim = createSim(KJFK, { seed: 3, arrivals: stream('31L', 40) });
    // Three departures queued on Z in the 31L line, handed off; front to back.
    const queue: [callsign: string, node: string, arrivedVia: string][] = [
      ['JBU1', 'n4068921630', 'w162541291-n4068921630-n10709945044'],
      ['JBU2', 'n4057398125', 'w162541297-n4057398125-n46547996'],
      ['JBU3', 'n46547996', 'w162541297-n46547996-n45355700'],
    ];
    for (const [callsign, node, arrivedVia] of queue) {
      addAircraft(sim, { callsign, type: 'A321', at: { kind: 'node', node, arrivedVia } });
      transmit(sim, `${callsign} taxi 31L via Z, monitor tower`);
    }
    const sequence = ops(sim, 3, 60 * 60 * 10);
    expect(sequence).toMatch(/^L?(TL)+T$/);
    expect(sequence.match(/T/g)).toHaveLength(3);
  });
});

describe("the player's transmissions to tower's aircraft", () => {
  it('get no reply and change nothing: on final, rolling out, waiting at the hold, lined up (TEST 27)', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'BAW175', type: 'A320', at: { kind: 'final', runwayEnd: '27', distanceM: 3000 } });
    addAircraft(sim, { callsign: 'DAL4', type: 'B738', at: { kind: 'node', node: 'aP2', arrivedVia: 'aP1-aP2' } });
    transmit(sim, 'DAL4 taxi 27 via A, monitor tower');
    drainEvents(sim);
    const tryAll = (callsign: string) => {
      drainEvents(sim);
      const before = sim.world.aircraft.find((a) => a.callsign === callsign);
      const copy = JSON.stringify(before);
      transmit(sim, `${callsign} hold`);
      transmit(sim, `${callsign} taxi ramp T1 via C A, cross 27`);
      expect(drainEvents(sim), callsign).toEqual([
        { type: 'not-on-frequency', tick: sim.world.tick, callsign, controller: 'tower' },
        { type: 'not-on-frequency', tick: sim.world.tick, callsign, controller: 'tower' },
      ]);
      expect(JSON.stringify(sim.world.aircraft.find((a) => a.callsign === callsign)), callsign).toBe(copy);
    };
    const at = (callsign: string, status: string) => () => getAircraft(sim, callsign).status === status && getAircraft(sim, callsign).controller === 'tower';
    tryAll('BAW175'); // on final
    stepUntil(sim, at('BAW175', 'landing'), 1000);
    tryAll('BAW175'); // rolling out
    stepUntil(sim, at('DAL4', 'arrived'), 2000);
    tryAll('DAL4'); // waiting at the hold
    stepUntil(sim, at('DAL4', 'lining-up'), 2000);
    step(sim, 50);
    tryAll('DAL4'); // lining up
    drainEvents(sim);
    // Its crossing requests go to tower, which says it isn't ground's.
    transmit(sim, 'DAL4 request-crossing');
    expect(runUntil(sim, (e) => e.type === 'crossing-unable', 100).filter((e) => e.type === 'crossing-unable')).toEqual([
      { type: 'crossing-unable', tick: expect.any(Number), callsign: 'DAL4', reason: "DAL4 isn't on ground's frequency" },
    ]);
    // Once tower hands the arrival to ground, the player's commands work.
    stepUntil(sim, () => getAircraft(sim, 'BAW175').controller === 'ground', 2000);
    drainEvents(sim);
    transmit(sim, 'BAW175 hold');
    expect(drainEvents(sim).map((e) => e.type)).toEqual(['command-applied']);
  });
});

/** Steps until `done` (or `maxTicks` pass, which fails). Leaves the events undrained. */
function stepUntil(sim: Sim, done: () => boolean, maxTicks: number): void {
  for (let i = 0; i < maxTicks; i++) {
    step(sim, 1);
    if (done()) return;
  }
  throw new Error(`not done in ${maxTicks} ticks`);
}

/** Steps until an event matches (or `maxTicks` pass, which fails), returning every event since. */
function runUntil(sim: Sim, done: (e: SimEvent) => boolean, maxTicks: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < maxTicks; i++) {
    step(sim, 1);
    const now = drainEvents(sim);
    events.push(...now);
    if (now.some(done)) return events;
  }
  throw new Error(`nothing matched in ${maxTicks} ticks; events: ${events.map((e) => e.type).join(', ')}`);
}
