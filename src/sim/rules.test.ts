// Rule checks (PLAN 1.12, PRD §4.8, §8.6, §9.3): collisions and gridlock end the session, and
// unauthorized runway crossings are counted. Scripted scenarios on TEST.

import { describe, expect, it } from 'vitest';
import testAirport from '../../data/airports/TEST.json' with { type: 'json' };
import { indexAirport } from '../airport/graph.ts';
import { loadAirport } from '../airport/load.ts';
import { addAircraft, applyCommand, createSim, drainEvents, footprintsOverlap, getAircraft, getScore, getSession, getUnauthorizedCrossings, stateHash, step, type Sim, type SimEvent } from './sim.ts';
import { checkRules, GRIDLOCK_S } from './rules.ts';
import { APPROVAL_TIMEOUT_S } from './tower.ts';
import { parseTerse } from './terse.ts';
import { TICK_HZ } from './movement.ts';

const TEST = indexAirport(loadAirport(testAirport));

/**
 * One tick of a wait for something to happen, failing at `WAIT_LIMIT_TICKS` instead of hanging
 * when it never does (a route that no longer goes there).
 */
function stepWaiting(sim: Sim): void {
  if (sim.world.tick >= WAIT_LIMIT_TICKS) throw new Error(`still waiting at tick ${sim.world.tick}`);
  step(sim, 1);
}

/** An hour of sim time: every wait here ends within a few minutes. */
const WAIT_LIMIT_TICKS = 36_000;

function transmit(sim: Sim, text: string): void {
  const result = parseTerse(text);
  if (!result.ok) throw new Error(`'${text}' doesn't parse: ${result.error.message}`);
  applyCommand(sim, result.command);
}

/** Steps one tick at a time until `done` holds for an event, or throws after `limit` ticks. Returns every event seen. */
function runUntil(sim: Sim, done: (e: SimEvent) => boolean, limit: number): SimEvent[] {
  const seen: SimEvent[] = [];
  for (let i = 0; i < limit; i++) {
    step(sim, 1);
    const events = drainEvents(sim);
    seen.push(...events);
    if (events.some(done)) return seen;
  }
  throw new Error(`not done within ${limit} ticks`);
}

/**
 * The player's runway incursion at TEST: DAL4 departs 27 from the east end; JBU11, northbound on
 * C, holds short of 27 at hCS. When DAL4 starts its roll, the player clears JBU11 across 27
 * without asking tower, then stops it on the runway (`hold`) once its nose is past the
 * centreline. DAL4's roll doesn't stop for traffic: tower never starts one with anyone on the
 * runway, so it doesn't need to.
 */
function incursion(seed: number): Sim {
  const sim = createSim(TEST, { seed });
  addAircraft(sim, { callsign: 'DAL4', type: 'B738', at: { kind: 'node', node: 'aP2', arrivedVia: 'aP1-aP2' } });
  addAircraft(sim, { callsign: 'JBU11', type: 'A320', at: { kind: 'node', node: 'cHS', arrivedVia: 'cHS-bC' } });
  transmit(sim, 'DAL4 taxi 27 via A, monitor tower');
  transmit(sim, 'JBU11 taxi ramp T2 via C A TC');
  runUntil(sim, (e) => e.type === 'takeoff-roll' && e.callsign === 'DAL4', 3000);
  transmit(sim, 'JBU11 cross 27');
  while (getAircraft(sim, 'JBU11').nose[1] <= 0) stepWaiting(sim);
  transmit(sim, 'JBU11 hold');
  return sim;
}

describe('collision', () => {
  it('acceptance: a forced runway collision is detected and ends the session, naming both aircraft, where, and who was moving them', () => {
    const sim = incursion(1);
    drainEvents(sim);
    // Running until the first tick the footprints overlap, then ended in that tick.
    let ticks = 0;
    while (!footprintsOverlap(sim, 'DAL4', 'JBU11')) {
      expect(getSession(sim)).toEqual({ state: 'running' });
      step(sim, 1);
      if (++ticks > 600) throw new Error('no collision within a minute');
    }
    const tick = sim.world.tick;
    const ended = getSession(sim);
    expect(ended).toMatchObject({
      state: 'ended',
      tick,
      cause: {
        kind: 'collision',
        // DAL4's nose is on r1C–rX, which ends at the intersection with 18/36, so by the
        // runway-area rule (occupancy.ts) it's in 18/36's area too, 600 m from that runway.
        runways: ['18/36', '9/27'],
        origin: 'mixed',
        aircraft: [
          { callsign: 'DAL4', type: 'B738', controller: 'tower', status: 'taking-off', runways: ['18/36', '9/27'] },
          { callsign: 'JBU11', type: 'A320', controller: 'ground', status: 'holding-position', speedMps: 0, runways: ['9/27'], location: { kind: 'edge', edge: 'cHN-r1C' } },
        ],
      },
    });
    // Where: C crosses 27 at r1C, (300, 0).
    const point = ended.state === 'ended' && ended.cause.kind === 'collision' ? ended.cause.point : null;
    expect(point?.[0]).toBeGreaterThan(280);
    expect(point?.[0]).toBeLessThan(340);
    expect(Math.abs(point?.[1] ?? NaN)).toBeLessThan(20);
    expect(drainEvents(sim).filter((e) => e.type === 'session-ended')).toEqual([{ type: 'session-ended', tick, callsign: null, cause: ended.state === 'ended' ? ended.cause : null }]);
    // The first cause is kept: still overlapping next tick, it's the same end.
    step(sim, 1);
    expect(getSession(sim)).toEqual(ended);
    expect(drainEvents(sim).filter((e) => e.type === 'session-ended')).toEqual([]);
  });
});

describe('collision, with parked footprints reused', () => {
  /** LEAD parked with its nose on aP2 (s 300 along aP1–aP2), and OTHER parked as built by `at`, both marked 'parked'. */
  function parked(at: Parameters<typeof addAircraft>[1]['at']): Sim {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'LEAD', type: 'A320', at: { kind: 'node', node: 'aP2', arrivedVia: 'aP1-aP2' } });
    addAircraft(sim, { callsign: 'OTHER', type: 'A320', at });
    for (const ac of sim.world.aircraft) ac.status = 'parked';
    checkRules(sim, []);
    expect(getSession(sim)).toEqual({ state: 'running' });
    return sim;
  }
  const other = (sim: Sim) => {
    const ac = sim.world.aircraft.find((a) => a.callsign === 'OTHER');
    if (!ac) throw new Error('no OTHER');
    return ac;
  };

  it('checks a parked aircraft where it is now after it moves along its track', () => {
    const sim = parked({ kind: 'edge', edge: 'aP1-aP2', from: 'aP1', distanceM: 150 });
    other(sim).s = 290;
    checkRules(sim, []);
    expect(getSession(sim)).toMatchObject({ state: 'ended', cause: { kind: 'collision' } });
  });

  it('checks a parked aircraft where it is now after its track is replaced, at the same distance along', () => {
    // OTHER's nose is on aK, 300 m along aW–aK, far west; on LEAD's track at the same 300 m it's on LEAD.
    const sim = parked({ kind: 'node', node: 'aK', arrivedVia: 'aW-aK' });
    const lead = sim.world.aircraft.find((a) => a.callsign === 'LEAD');
    if (!lead) throw new Error('no LEAD');
    expect(other(sim).s).toBe(lead.s);
    other(sim).track = lead.track;
    checkRules(sim, []);
    expect(getSession(sim)).toMatchObject({ state: 'ended', cause: { kind: 'collision' } });
  });
});

describe('after the session ends', () => {
  it('the sim keeps advancing, but nothing more is counted: the score is the session as it ended', () => {
    const sim = incursion(1);
    while (getSession(sim).state === 'running') stepWaiting(sim);
    const endTick = sim.world.tick;
    drainEvents(sim);
    const atEnd = getScore(sim);
    expect(atEnd).toMatchObject({ elapsedS: endTick / TICK_HZ, departures: { total: 0 } });
    // DAL4 rolls on through JBU11 and lifts off: not a departure that counts.
    const events = runUntil(sim, (e) => e.type === 'took-off' && e.callsign === 'DAL4', 600);
    expect(sim.world.tick).toBeGreaterThan(endTick);
    expect(events.filter((e) => e.type === 'session-ended')).toEqual([]);
    expect(getScore(sim)).toEqual(atEnd);
    expect(sim.world.score.departures).toEqual([]);
  });
});

describe('unauthorized crossing', () => {
  it('acceptance: a crossing without approval is counted exactly once', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'JBU11', type: 'A320', at: { kind: 'node', node: 'cHS', arrivedVia: 'cHS-bC' } });
    // Cleared across 27 by the player, with no request to tower.
    transmit(sim, 'JBU11 taxi ramp T2 via C A TC, cross 27');
    const events = runUntil(sim, (e) => e.type === 'arrived' && e.callsign === 'JBU11', 3000);
    const entered = events.filter((e) => e.type === 'entered-runway');
    expect(entered).toEqual([expect.objectContaining({ callsign: 'JBU11', holdShort: 'hCS', runways: ['9/27'], cleared: true })]);
    const tick = entered[0]?.tick;
    const crossing = { tick, callsign: 'JBU11', holdShort: 'hCS', runways: ['9/27'] };
    expect(getUnauthorizedCrossings(sim)).toEqual([crossing]);
    expect(events.filter((e) => e.type === 'unauthorized-crossing')).toEqual([{ type: 'unauthorized-crossing', ...crossing }]);
    // Still once, long after: its body on the runway, off it, and parked at the ramp entrance.
    step(sim, 3000);
    expect(getUnauthorizedCrossings(sim)).toEqual([crossing]);
    expect(drainEvents(sim).filter((e) => e.type === 'unauthorized-crossing')).toEqual([]);
    expect(getSession(sim)).toEqual({ state: 'running' });
  });

  it('is not counted when tower approved that crossing and the approval is current', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'JBU11', type: 'A320', at: { kind: 'node', node: 'cHS', arrivedVia: 'cHS-bC' } });
    transmit(sim, 'JBU11 taxi ramp T2 via C A TC');
    runUntil(sim, (e) => e.type === 'holding-short' && e.callsign === 'JBU11', 100);
    transmit(sim, 'JBU11 request-crossing');
    runUntil(sim, (e) => e.type === 'crossing-approved' && e.callsign === 'JBU11', 100);
    transmit(sim, 'JBU11 cross 27');
    const events = runUntil(sim, (e) => e.type === 'arrived' && e.callsign === 'JBU11', 3000);
    expect(events.filter((e) => e.type === 'entered-runway')).toEqual([expect.objectContaining({ callsign: 'JBU11', holdShort: 'hCS', cleared: true })]);
    expect(getUnauthorizedCrossings(sim)).toEqual([]);
    expect(events.filter((e) => e.type === 'unauthorized-crossing')).toEqual([]);
  });

  it('is counted when the approval lapsed in the same tick, before the nose passed the line; not a tick earlier', () => {
    // Tower cancels an unused approval in its decide, at the start of the tick (tower.ts), before
    // anything moves. Cleared across `lead` ticks before that tick, the nose passes the line
    // (it's on it) in the first tick it moves.
    const crossAt = (lead: number) => {
      const sim = createSim(TEST, { seed: 1 });
      addAircraft(sim, { callsign: 'JBU11', type: 'A320', at: { kind: 'node', node: 'cHS', arrivedVia: 'cHS-bC' } });
      transmit(sim, 'JBU11 taxi ramp T2 via C A TC');
      runUntil(sim, (e) => e.type === 'holding-short', 100);
      transmit(sim, 'JBU11 request-crossing');
      runUntil(sim, (e) => e.type === 'crossing-approved', 100);
      const lapses = sim.world.tick + APPROVAL_TIMEOUT_S * TICK_HZ;
      step(sim, lapses - lead - sim.world.tick);
      transmit(sim, 'JBU11 cross 27');
      const events = runUntil(sim, (e) => e.type === 'entered-runway', 10);
      return { lapses, events: events.filter((e) => e.type !== 'command-applied'), counted: getUnauthorizedCrossings(sim) };
    };
    const late = crossAt(1);
    expect(late.events.map((e) => `${e.tick} ${e.type}`)).toEqual([`${late.lapses} crossing-cancelled`, `${late.lapses} entered-runway`, `${late.lapses} unauthorized-crossing`]);
    expect(late.counted).toEqual([{ tick: late.lapses, callsign: 'JBU11', holdShort: 'hCS', runways: ['9/27'] }]);
    const inTime = crossAt(2);
    expect(inTime.events.map((e) => `${e.tick} ${e.type}`)).toEqual([`${inTime.lapses - 1} entered-runway`]);
    expect(inTime.counted).toEqual([]);
  });
});

/** Whether each of `callsigns` is stopped for traffic, blocked by the next (the last by the first). */
function inCycle(sim: Sim, callsigns: string[]): boolean {
  return callsigns.every((c, i) => {
    const ac = getAircraft(sim, c);
    return ac.status === 'stopped-for-traffic' && ac.speedMps === 0 && ac.blockedBy === callsigns[(i + 1) % callsigns.length];
  });
}

describe('gridlock', () => {
  it('acceptance: a nose-to-nose standoff is detected after the threshold, and not before', () => {
    const sim = createSim(TEST, { seed: 1 });
    // Head-on on A between aTC and aJ: DAL4 east to 27, JBU11 west to TC.
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'node', node: 'aTC', arrivedVia: 'aC-aTC' } });
    addAircraft(sim, { callsign: 'JBU11', type: 'A320', at: { kind: 'node', node: 'aJ', arrivedVia: 'aJ-aH1' } });
    transmit(sim, 'DAL4 taxi 27 via A');
    transmit(sim, 'JBU11 taxi ramp T2 via A TC');
    while (!inCycle(sim, ['DAL4', 'JBU11'])) {
      stepWaiting(sim);
      if (sim.world.tick > 3000) throw new Error('no standoff');
    }
    const since = sim.world.tick;
    drainEvents(sim);
    step(sim, GRIDLOCK_S * TICK_HZ - 1);
    expect(getSession(sim)).toEqual({ state: 'running' });
    step(sim, 1);
    const ended = getSession(sim);
    const tick = since + GRIDLOCK_S * TICK_HZ;
    expect(ended).toMatchObject({
      state: 'ended',
      tick,
      cause: {
        kind: 'gridlock',
        sinceTick: since,
        origin: 'player',
        aircraft: [
          { callsign: 'DAL4', controller: 'ground', status: 'stopped-for-traffic', speedMps: 0, blockedBy: 'JBU11', location: { kind: 'edge', edge: 'aTC-aJ' } },
          { callsign: 'JBU11', controller: 'ground', status: 'stopped-for-traffic', speedMps: 0, blockedBy: 'DAL4', location: { kind: 'edge', edge: 'aTC-aJ' } },
        ],
      },
    });
    expect(drainEvents(sim).filter((e) => e.type === 'session-ended')).toEqual([{ type: 'session-ended', tick, callsign: null, cause: ended.state === 'ended' ? ended.cause : null }]);
  });

  it("isn't an aircraft queued behind a leader that's holding short, however long it waits", () => {
    const sim = createSim(TEST, { seed: 1 });
    // UAE202 holds short of 18/36 at hAW; JBU11 queues behind it.
    addAircraft(sim, { callsign: 'UAE202', type: 'B77W', at: { kind: 'node', node: 'aJ', arrivedVia: 'aTC-aJ' } });
    addAircraft(sim, { callsign: 'JBU11', type: 'A320', at: { kind: 'node', node: 'aC', arrivedVia: 'aTB-aC' } });
    transmit(sim, 'UAE202 taxi 27 via A');
    transmit(sim, 'JBU11 taxi 27 via A');
    step(sim, 10 * GRIDLOCK_S * TICK_HZ);
    expect(getAircraft(sim, 'JBU11')).toMatchObject({ status: 'stopped-for-traffic', blockedBy: 'UAE202', speedMps: 0 });
    expect(getAircraft(sim, 'UAE202')).toMatchObject({ status: 'holding-short', blockedBy: null });
    expect(getSession(sim)).toEqual({ state: 'running' });
    expect(sim.world.rules.jams).toEqual([]);
  });

  it("isn't two aircraft held facing each other with room between them: each could still move up", () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'node', node: 'aTC', arrivedVia: 'aC-aTC' } });
    addAircraft(sim, { callsign: 'JBU11', type: 'A320', at: { kind: 'node', node: 'aJ', arrivedVia: 'aJ-aH1' } });
    transmit(sim, 'DAL4 taxi 27 via A, hold');
    transmit(sim, 'JBU11 taxi ramp T2 via A TC, hold');
    step(sim, 3 * GRIDLOCK_S * TICK_HZ);
    // Stopped, each the other's nearest traffic, 300 m apart.
    expect(getAircraft(sim, 'DAL4')).toMatchObject({ status: 'holding-position', blockedBy: 'JBU11', speedMps: 0 });
    expect(getAircraft(sim, 'JBU11')).toMatchObject({ status: 'holding-position', blockedBy: 'DAL4', speedMps: 0 });
    expect(getSession(sim)).toEqual({ state: 'running' });
    expect(sim.world.rules.jams).toEqual([]);
  });
});

describe('determinism', () => {
  it('the same seed and script give the same state hash with rules and score running, the ended session and its counts included', () => {
    const run = (seed: number) => {
      const sim = incursion(seed);
      step(sim, 2000);
      return sim;
    };
    const [first, again] = [run(3), run(3)];
    expect(getSession(first).state).toBe('ended');
    expect(getUnauthorizedCrossings(first)).toHaveLength(1);
    expect(stateHash(again)).toBe(stateHash(first));
    // The hash covers the rule and score state: a change there alone changes it.
    const before = stateHash(again);
    again.world.rules.unauthorizedCrossings = [];
    expect(stateHash(again)).not.toBe(before);
    again.world.session = { state: 'running' };
    again.world.score.departures.push({ tick: 1, callsign: 'X' });
    expect(stateHash(again)).not.toBe(before);
  });
});
