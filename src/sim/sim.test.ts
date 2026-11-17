import { describe, expect, it } from 'vitest';
import testAirport from '../../data/airports/TEST.json' with { type: 'json' };
import { indexAirport } from '../airport/graph.ts';
import { loadAirport } from '../airport/load.ts';
import { footprintsOverlap } from './footprint.ts';
import { MAX_DECEL_MPS2 } from './braking.ts';
import { SPACING_M } from './traffic.ts';
import { addAircraft, applyCommand, createSim, drainEvents, getAircraft, stateHash, step, TICK_S, type Sim } from './sim.ts';
import { parseTerse } from './terse.ts';
import eLoop from './__fixtures__/e-loop.overrides.json' with { type: 'json' };

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
/** TEST with E1 and E2 renamed E, so B then E is ambiguous from D (see the fixture's description). */
const E_LOOP = indexAirport(loadAirport(testAirport, eLoop));
/** Meters per second in one knot. */
const KNOT = 1852 / 3600;

/** Applies a terse command (`DAL4 taxi 27 via A`), which must parse. */
function transmit(sim: Sim, text: string): void {
  const result = parseTerse(text);
  if (!result.ok) throw new Error(`'${text}' doesn't parse: ${result.error.message}`);
  applyCommand(sim, result.command);
}

/** Steps `ticks` ticks one at a time, recording each node the aircraft's nose reaches. */
function traceNodes(sim: Sim, callsign: string, ticks: number): string[] {
  const nodes: string[] = [];
  const record = () => {
    const location = getAircraft(sim, callsign).location;
    const node = location.kind === 'node' ? location.node : location.from;
    if (nodes.at(-1) !== node) nodes.push(node);
  };
  record();
  for (let i = 0; i < ticks; i++) {
    step(sim, 1);
    record();
  }
  return nodes;
}

describe('movement along a resolved path', () => {
  it('acceptance: the aircraft follows the expected node sequence (out of ramp 7, left on A, into T2 by the TC stub)', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'node', node: 'rb7', arrivedVia: 'rb7-l7A' } });
    transmit(sim, 'DAL4 taxi ramp T2 via #7 L:A');
    expect(traceNodes(sim, 'DAL4', 3000)).toEqual(['rb7', 'a7', 'aD', 'aTB', 'aC', 'aTC', 'rbTC']);
    const dal4 = getAircraft(sim, 'DAL4');
    expect(dal4.status).toBe('arrived');
    expect(dal4.location).toEqual({ kind: 'node', node: 'rbTC', arrivedVia: 'rbTC-aTC' });
    expect(drainEvents(sim).filter((e) => e.type === 'arrived')).toEqual([
      { type: 'arrived', tick: expect.any(Number), callsign: 'DAL4', destination: { kind: 'ramp', terminal: 'T2', rampHandoff: 'rhTC' } },
    ]);
  });

  it('is slower through turns than on straights: 90° turns at a7 and aTC at most 10 kt, straight through aD near 20 kt', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'node', node: 'rb7', arrivedVia: 'rb7-l7A' }, taxiSpeedKt: 20 });
    transmit(sim, 'DAL4 taxi ramp T2 via #7 L:A');
    // The speed in the tick the nose leaves each node, and the fastest anywhere.
    const leaving = new Map<string, number>();
    let fastest = 0;
    for (let i = 0; i < 3000; i++) {
      step(sim, 1);
      const { location, speedMps } = getAircraft(sim, 'DAL4');
      if (location.kind === 'edge' && !leaving.has(location.from)) leaving.set(location.from, speedMps);
      fastest = Math.max(fastest, speedMps);
    }
    const kt = (node: string) => (leaving.get(node) ?? NaN) / KNOT;
    expect(kt('a7')).toBeLessThanOrEqual(10);
    expect(kt('aTC')).toBeLessThanOrEqual(10);
    expect(kt('aD')).toBeGreaterThan(19);
    expect(fastest / KNOT).toBeCloseTo(20, 5);
  });
});

describe('commands applied through route resolution', () => {
  it('re-routes mid-edge from the node ahead, arrived along the edge it is on, without jumping or reversing', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'node', node: 'a7', arrivedVia: 'aK-a7' } });
    transmit(sim, 'DAL4 taxi 27 via A');
    let before = getAircraft(sim, 'DAL4');
    while (!(before.location.kind === 'edge' && before.location.edge === 'aD-aTB' && before.location.distanceM > 150)) {
      stepWaiting(sim);
      before = getAircraft(sim, 'DAL4');
    }
    transmit(sim, 'DAL4 taxi ramp T2 via A');
    const after = getAircraft(sim, 'DAL4');
    expect(after.clearance?.start).toEqual({ node: 'aTB', arrivedVia: 'aD-aTB', terminal: null });
    expect(after.location).toEqual(before.location);
    expect(after.nose).toEqual(before.nose);
    expect(after.speedMps).toBe(before.speedMps);

    let x = after.nose[0];
    const nodes: string[] = [];
    for (let i = 0; i < 2000; i++) {
      step(sim, 1);
      const { location, nose } = getAircraft(sim, 'DAL4');
      const node = location.kind === 'node' ? location.node : location.from;
      if (nodes.at(-1) !== node) nodes.push(node);
      expect(nose[0]).toBeGreaterThanOrEqual(x);
      x = nose[0];
    }
    expect(nodes).toEqual(['aD', 'aTB', 'aC', 'aTC', 'rbTC']);
    expect(getAircraft(sim, 'DAL4').status).toBe('arrived');
    expect(getAircraft(sim, 'DAL4').clearance?.path.destination).toEqual({ kind: 'ramp', terminal: 'T2', rampHandoff: 'rhTC' });
  });

  it('keeps its clearance when a new taxi is unable, and says why', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'B738', at: { kind: 'node', node: 'aJ', arrivedVia: 'aTC-aJ' } });
    transmit(sim, 'DAL4 taxi 27 via A');
    step(sim, 50);
    const before = getAircraft(sim, 'DAL4').clearance;
    drainEvents(sim);
    transmit(sim, 'DAL4 taxi 27 via A B');
    expect(drainEvents(sim)).toEqual([
      {
        type: 'unable',
        tick: 50,
        callsign: 'DAL4',
        instruction: { type: 'taxi', to: { kind: 'runway', name: '27' }, via: [{ taxiway: 'A', turn: null }, { taxiway: 'B', turn: null }], holdShort: [] },
        reason: "taxiways A and B don't meet",
      },
    ]);
    expect(getAircraft(sim, 'DAL4').clearance).toEqual(before);
    step(sim, 1200);
    expect(getAircraft(sim, 'DAL4').status).toBe('holding-short');
  });

  it('keeps its clearance when a new taxi is ambiguous, and says where (B both ways round the E loop)', () => {
    const sim = createSim(E_LOOP, { seed: 1 });
    // Just crossed 9/27 southbound on D, at dHS.
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'node', node: 'dHS', arrivedVia: 'r1D-dHS' } });
    transmit(sim, 'DAL4 taxi penalty via D R:B E');
    step(sim, 10);
    const before = getAircraft(sim, 'DAL4').clearance;
    drainEvents(sim);
    transmit(sim, 'DAL4 taxi penalty via D B E');
    expect(drainEvents(sim)).toEqual([
      {
        type: 'ambiguous',
        tick: 10,
        callsign: 'DAL4',
        instruction: {
          type: 'taxi',
          to: { kind: 'penalty-box', name: null },
          via: [{ taxiway: 'D', turn: null }, { taxiway: 'B', turn: null }, { taxiway: 'E', turn: null }],
          holdShort: [],
        },
        node: 'bD',
        at: 'B/D',
        taxiway: 'B',
        edges: ['bE1-bD', 'bD-bC'],
      },
    ]);
    expect(getAircraft(sim, 'DAL4').clearance).toEqual(before);
    step(sim, 3000);
    expect(getAircraft(sim, 'DAL4').status).toBe('arrived');
    expect(getAircraft(sim, 'DAL4').location).toMatchObject({ kind: 'node', node: 'pbS1' });
  });
});

describe('instructions with no movement effect yet, and requests', () => {
  it('records handoffs, ATIS and delay advisories on the aircraft, in order, and emits each', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'node', node: 'aJ', arrivedVia: 'aTC-aJ' } });
    transmit(sim, 'DAL4 atis P alt 2992, ground-stop ATL, release 1452, hold-for-release, delay 20, say-again, monitor tower 119.1');
    expect(drainEvents(sim).map((e) => (e.type === 'command-applied' ? e.instruction.type : e.type))).toEqual([
      'atis',
      'ground-stop',
      'release-time',
      'hold-for-release',
      'expect-delay',
      'say-again',
      'handoff',
    ]);
    expect(getAircraft(sim, 'DAL4').advisories).toEqual({
      handoff: { mode: 'monitor', facility: 'tower', frequency: '119.1', tick: expect.any(Number) },
      atis: { letter: 'P', altimeter: '2992' },
      groundStop: 'ATL',
      releaseTime: '14:52',
      holdForRelease: true,
      expectDelayMinutes: 20,
    });
    step(sim, 100);
    expect(getAircraft(sim, 'DAL4').status).toBe('idle');
    expect(getAircraft(sim, 'DAL4').location).toEqual({ kind: 'node', node: 'aJ', arrivedVia: 'aTC-aJ' });
  });

  it('emits crossing requests for tower (1.10), and says when a callsign is unknown or unreadable', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'node', node: 'aJ', arrivedVia: 'aTC-aJ' } });
    transmit(sim, 'DAL4 request-crossing 36');
    transmit(sim, 'DAL4 request-crossing');
    transmit(sim, 'ZZZ9 hold');
    transmit(sim, '? say-again');
    expect(drainEvents(sim)).toEqual([
      { type: 'crossing-requested', tick: 0, callsign: 'DAL4', runway: '36' },
      { type: 'crossing-requested', tick: 0, callsign: 'DAL4', runway: null },
      { type: 'unknown-callsign', tick: 0, callsign: 'ZZZ9' },
      { type: 'say-again-callsign', tick: 0, callsign: null },
    ]);
  });
});

describe('corrections', () => {
  it('applies a correction to the clearance and re-resolves it, keeping its progress (neg to ramp T2)', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'node', node: 'aC', arrivedVia: 'aTB-aC' } });
    transmit(sim, 'DAL4 taxi 27 via A');
    step(sim, 50);
    const before = getAircraft(sim, 'DAL4');
    expect(before.location).toMatchObject({ kind: 'edge', edge: 'aC-aTC' });
    transmit(sim, 'DAL4 neg to ramp T2');
    const after = getAircraft(sim, 'DAL4');
    // Only the destination changes: the route and start stand, and it hasn't moved.
    expect(after.clearance?.taxi).toEqual({ type: 'taxi', to: { kind: 'ramp', name: 'T2' }, via: [{ taxiway: 'A', turn: null }], holdShort: [] });
    expect(after.clearance?.start).toEqual(before.clearance?.start);
    expect(after.clearance?.path.nodes).toEqual(['aC', 'aTC', 'rbTC']);
    expect(after.location).toEqual(before.location);
    step(sim, 1000);
    expect(getAircraft(sim, 'DAL4').status).toBe('arrived');
    expect(getAircraft(sim, 'DAL4').location).toEqual({ kind: 'node', node: 'rbTC', arrivedVia: 'rbTC-aTC' });
  });

  it("resolves a corrected route from where the aircraft is when it doesn't fit the route taxied (neg via B E, on B)", () => {
    const sim = createSim(E_LOOP, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'node', node: 'dHS', arrivedVia: 'r1D-dHS' } });
    transmit(sim, 'DAL4 taxi penalty via D R:B E');
    let onB = getAircraft(sim, 'DAL4');
    while (!(onB.location.kind === 'edge' && onB.location.edge === 'bE1-bD' && onB.location.distanceM > 100)) {
      stepWaiting(sim);
      onB = getAircraft(sim, 'DAL4');
    }
    drainEvents(sim);
    // From the clearance's start (on D at dHS), "B E" is ambiguous at bD; from here, on B westbound, it isn't.
    transmit(sim, 'DAL4 neg via B E');
    expect(drainEvents(sim).map((e) => e.type)).toEqual(['command-applied']);
    const corrected = getAircraft(sim, 'DAL4');
    expect(corrected.clearance?.start).toEqual({ node: 'bE1', arrivedVia: 'bE1-bD', terminal: null });
    expect(corrected.clearance?.path.nodes).toEqual(['bE1', 'eW', 'e1', 'pbS1']);
    expect(corrected.location).toEqual(onB.location);
    step(sim, 2000);
    expect(getAircraft(sim, 'DAL4').status).toBe('arrived');
    expect(getAircraft(sim, 'DAL4').location).toMatchObject({ kind: 'node', node: 'pbS1' });
  });

  it('is unable, keeping its clearance, when the correction would change the route already taxied', () => {
    const sim = createSim(E_LOOP, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'node', node: 'dHS', arrivedVia: 'r1D-dHS' } });
    transmit(sim, 'DAL4 taxi penalty via D R:B E');
    let onB = getAircraft(sim, 'DAL4');
    while (!(onB.location.kind === 'edge' && onB.location.edge === 'bE1-bD' && onB.location.distanceM > 100)) {
      stepWaiting(sim);
      onB = getAircraft(sim, 'DAL4');
    }
    drainEvents(sim);
    // Left on B (east) would have turned off at bD, which is behind it now.
    transmit(sim, 'DAL4 neg turn L:B');
    expect(drainEvents(sim)).toEqual([
      {
        type: 'unable',
        tick: expect.any(Number),
        callsign: 'DAL4',
        instruction: { type: 'correction', to: null, via: null, turns: [{ taxiway: 'B', turn: 'left' }], holdShort: null, cross: null },
        reason: 'too late: the corrected route leaves the route taxied at B/D',
      },
    ]);
    expect(getAircraft(sim, 'DAL4').clearance).toEqual(onB.clearance);
  });
});

describe('determinism', () => {
  /** A scripted session: spawns, then commands at fixed ticks, run for 10,000 ticks. */
  function run(seed: number, script: [tick: number, command: string][]): string {
    const sim = createSim(TEST, { seed });
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'node', node: 'rb7', arrivedVia: 'rb7-l7A' } });
    addAircraft(sim, { callsign: 'JBU11', type: 'B738', at: { kind: 'node', node: 'aTB', arrivedVia: 'aD-aTB' } });
    addAircraft(sim, { callsign: 'UAE202', type: 'B77W', at: { kind: 'node', node: 'dHN', arrivedVia: 'dHN-r1D' } });
    const due = new Map<number, string[]>();
    for (const [tick, command] of script) due.set(tick, [...(due.get(tick) ?? []), command]);
    for (let tick = 0; tick < 10_000; tick++) {
      for (const command of due.get(tick) ?? []) transmit(sim, command);
      step(sim, 1);
    }
    return stateHash(sim);
  }
  const script: [number, string][] = [
    [0, 'DAL4 taxi 27 via #7 L:A'],
    [0, 'JBU11 taxi 27 via A'],
    [0, 'UAE202 taxi ramp T1 via D A hs A'],
    [1500, 'JBU11 cross 36'],
    [2500, 'UAE202 continue'],
    [4000, 'DAL4 cross 36'],
  ];

  it('acceptance: the same seed and command script give an identical state hash after 10,000 ticks; a different script does not', () => {
    const hash = run(7, script);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
    expect(run(7, script)).toBe(hash);
    // Without DAL4's crossing it ends holding short at hAW, not queued at 27's line. (The state
    // keeps no history: moving JBU11's crossing from tick 1500 to 1600 changes the hash at
    // ticks 1550 and 2000, measured, but by 3000 both runs are in the same state again.)
    expect(run(7, script.filter(([, command]) => command !== 'DAL4 cross 36'))).not.toBe(hash);
    // The seed sets each pilot's taxi speed, so it shows in the state too.
    expect(run(8, script)).not.toBe(hash);
  });
});

describe('footprints', () => {
  it('overlap when bodies share pavement (nose into tail), and not with a gap, nor with a nose stopped beside another nose at a junction', () => {
    const sim = createSim(TEST, { seed: 1 });
    // A is straight east–west at y = 200: a7 is x = −800, aD x = −300. A320: 37.6 m long, 35.8 m span.
    addAircraft(sim, { callsign: 'LEAD1', type: 'A320', at: { kind: 'node', node: 'aD', arrivedVia: 'a7-aD' } });
    addAircraft(sim, { callsign: 'CLOSE1', type: 'A320', at: { kind: 'edge', edge: 'a7-aD', from: 'a7', distanceM: 470 } });
    addAircraft(sim, { callsign: 'GAP1', type: 'A320', at: { kind: 'edge', edge: 'a7-aD', from: 'a7', distanceM: 400 } });
    // Northbound on D toward aD (x = −300; dI is y = 150): nose 10 m short of A's centreline, and 50 m short.
    // WING1's nose is beside LEAD1's: 7.9 m short of LEAD1's fuselage side (half of 0.11 × 37.6 m
    // off the centreline), and ahead of LEAD1's wing, which starts 11.3 m behind its nose
    // (footprint.ts). Real aircraft there don't touch; a span × length box said they did.
    addAircraft(sim, { callsign: 'WING1', type: 'A320', at: { kind: 'edge', edge: 'aD-dI', from: 'dI', distanceM: 40 } });
    addAircraft(sim, { callsign: 'CLEAR1', type: 'A320', at: { kind: 'node', node: 'dI', arrivedVia: 'dI-dHN' } });
    expect(footprintsOverlap(sim, 'LEAD1', 'CLOSE1')).toBe(true);
    expect(footprintsOverlap(sim, 'LEAD1', 'GAP1')).toBe(false);
    expect(footprintsOverlap(sim, 'LEAD1', 'WING1')).toBe(false);
    expect(footprintsOverlap(sim, 'LEAD1', 'CLEAR1')).toBe(false);
  });
});

describe('see-and-avoid', () => {
  it('acceptance: a follower never overlaps its leader over 1,000 ticks, including when the leader stops', () => {
    const sim = createSim(TEST, { seed: 1 });
    // Both eastbound on A (straight, y = 200). The leader is slow and stops at hAW (aH1, x = 810).
    addAircraft(sim, { callsign: 'UAE202', type: 'B77W', at: { kind: 'node', node: 'aJ', arrivedVia: 'aTC-aJ' }, taxiSpeedKt: 15 });
    addAircraft(sim, { callsign: 'JBU11', type: 'A320', at: { kind: 'node', node: 'aC', arrivedVia: 'aTB-aC' }, taxiSpeedKt: 25 });
    transmit(sim, 'UAE202 taxi 27 via A');
    transmit(sim, 'JBU11 taxi 27 via A');
    let closest = Infinity;
    for (let tick = 1; tick <= 1000; tick++) {
      if (tick === 600) transmit(sim, 'UAE202 cross 36');
      step(sim, 1);
      expect(footprintsOverlap(sim, 'UAE202', 'JBU11')).toBe(false);
      const [leader, follower] = [getAircraft(sim, 'UAE202'), getAircraft(sim, 'JBU11')];
      const gap = leader.nose[0] - leader.lengthM - follower.nose[0];
      expect(gap).toBeGreaterThan(0);
      closest = Math.min(closest, gap);
    }
    const events = drainEvents(sim);
    expect(events.filter((e) => e.type === 'stopped-for-traffic')).toEqual([
      { type: 'stopped-for-traffic', tick: expect.any(Number), callsign: 'JBU11', behind: 'UAE202' },
    ]);
    // Queued at the spacing, nose to tail, while the leader held short.
    expect(closest).toBeCloseTo(SPACING_M, 5);
    step(sim, 1000);
    expect(getAircraft(sim, 'JBU11').status).toBe('holding-short');
    expect(getAircraft(sim, 'JBU11').location).toEqual({ kind: 'node', node: 'aH1', arrivedVia: 'aJ-aH1' });
  });

  it('stays stopped-for-traffic, not taxiing, while it waits for the gap ahead to open', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'UAE202', type: 'B77W', at: { kind: 'node', node: 'aJ', arrivedVia: 'aTC-aJ' } });
    addAircraft(sim, { callsign: 'JBU11', type: 'A320', at: { kind: 'node', node: 'aC', arrivedVia: 'aTB-aC' } });
    transmit(sim, 'UAE202 taxi 27 via A');
    transmit(sim, 'JBU11 taxi 27 via A');
    step(sim, 1000);
    expect(getAircraft(sim, 'JBU11').status).toBe('stopped-for-traffic');
    transmit(sim, 'UAE202 cross 36');
    let waited = 0;
    while (getAircraft(sim, 'JBU11').speedMps === 0 && waited < 600) {
      step(sim, 1);
      if (getAircraft(sim, 'JBU11').speedMps === 0) {
        expect(getAircraft(sim, 'JBU11').status).toBe('stopped-for-traffic');
        waited++;
      }
    }
    // It waited while the leader opened the gap, then moved up.
    expect(waited).toBeGreaterThan(0);
    expect(waited).toBeLessThan(600);
    expect(drainEvents(sim).filter((e) => e.type === 'stopped-for-traffic')).toHaveLength(1);
  });

  it('stops short of a node another aircraft occupies (wings over the junction), and goes once it has moved on', () => {
    const sim = createSim(TEST, { seed: 1 });
    // DAL4 came north up D and stopped with its nose on aD, on A's centreline (x = −300).
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'node', node: 'aD', arrivedVia: 'aD-dI' } });
    addAircraft(sim, { callsign: 'JBU11', type: 'B738', at: { kind: 'node', node: 'aC', arrivedVia: 'aC-aTC' } });
    transmit(sim, 'JBU11 taxi ramp T1 via A');
    const noOverlap = (ticks: number) => {
      for (let i = 0; i < ticks; i++) {
        step(sim, 1);
        expect(footprintsOverlap(sim, 'DAL4', 'JBU11')).toBe(false);
      }
    };
    noOverlap(1500);
    const waiting = getAircraft(sim, 'JBU11');
    expect(waiting.status).toBe('stopped-for-traffic');
    expect(waiting.blockedBy).toBe('DAL4');
    // Westbound, so short of aD is east of it: half DAL4's span plus the spacing.
    expect(waiting.nose[0]).toBeCloseTo(-300 + 35.8 / 2 + SPACING_M, 5);

    transmit(sim, 'DAL4 taxi ramp T1 via A');
    noOverlap(3000);
    expect(getAircraft(sim, 'DAL4').status).toBe('arrived');
    // Behind DAL4 on the stub into ramp 7, which ends at DAL4's nose.
    const behind = getAircraft(sim, 'JBU11');
    expect(behind.status).toBe('stopped-for-traffic');
    expect(behind.location).toMatchObject({ kind: 'edge', edge: 'rb7-a7', from: 'a7', to: 'rb7' });
  });
});

describe('hold position and continue', () => {
  it('acceptance: hold position stops it as soon as it can within the braking limit, and continue resumes', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'B738', at: { kind: 'node', node: 'rb7', arrivedVia: 'rb7-l7A' }, taxiSpeedKt: 20 });
    transmit(sim, 'DAL4 taxi ramp T2 via #7 L:A');
    step(sim, 400);
    const moving = getAircraft(sim, 'DAL4');
    expect(moving.speedMps / KNOT).toBeCloseTo(20, 5);

    transmit(sim, 'DAL4 hold');
    const speeds = [moving.speedMps];
    while ((speeds.at(-1) ?? 0) > 0 && speeds.length < 1000) {
      step(sim, 1);
      speeds.push(getAircraft(sim, 'DAL4').speedMps);
    }
    // Firm braking from the first tick, never harder than the limit.
    const drops = speeds.slice(1).map((v, i) => (speeds[i] ?? 0) - v);
    expect(Math.max(...drops)).toBeLessThanOrEqual(MAX_DECEL_MPS2 * TICK_S + 1e-9);
    expect(drops.slice(0, -1).every((d) => d > MAX_DECEL_MPS2 * TICK_S - 1e-9)).toBe(true);
    expect(speeds.length - 1).toBe(Math.ceil(moving.speedMps / (MAX_DECEL_MPS2 * TICK_S)));

    const held = getAircraft(sim, 'DAL4');
    expect(held.status).toBe('holding-position');
    step(sim, 600);
    expect(getAircraft(sim, 'DAL4').location).toEqual(held.location);
    expect(getAircraft(sim, 'DAL4').status).toBe('holding-position');

    transmit(sim, 'DAL4 continue');
    step(sim, 3000);
    expect(getAircraft(sim, 'DAL4').status).toBe('arrived');
  });
});

describe('hold position and new clearances', () => {
  it('is released by a new taxi clearance (docs/terse-syntax.md), and not by a correction', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'B738', at: { kind: 'node', node: 'rb7', arrivedVia: 'rb7-l7A' } });
    transmit(sim, 'DAL4 taxi ramp T2 via #7 L:A');
    step(sim, 400);
    transmit(sim, 'DAL4 hold');
    step(sim, 100);
    const held = getAircraft(sim, 'DAL4');
    expect(held).toMatchObject({ status: 'holding-position', speedMps: 0 });
    transmit(sim, 'DAL4 neg turn L:A');
    step(sim, 100);
    expect(getAircraft(sim, 'DAL4')).toMatchObject({ status: 'holding-position', location: held.location });
    transmit(sim, 'DAL4 taxi 27 via A');
    expect(getAircraft(sim, 'DAL4').holdPosition).toBe(false);
    step(sim, 2000);
    expect(getAircraft(sim, 'DAL4')).toMatchObject({ status: 'holding-short', location: { kind: 'node', node: 'aH1' } });
    expect(drainEvents(sim).filter((e) => e.type === 'unable' || e.type === 'ambiguous')).toEqual([]);
  });
});

describe("the clearance's hold-shorts", () => {
  it('stops at a taxiway hold-short added to the clearance (A, at dI on D), and continue releases it', () => {
    const sim = createSim(TEST, { seed: 1 });
    // Off 27 at D, northbound at dHN. Path: dHN, dI, aD, a7, rb7.
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'node', node: 'dHN', arrivedVia: 'dHN-r1D' } });
    transmit(sim, 'DAL4 taxi ramp T1 via D A');
    transmit(sim, 'DAL4 hs A');
    step(sim, 600);
    const holding = getAircraft(sim, 'DAL4');
    expect(holding.status).toBe('holding-short');
    expect(holding.location).toEqual({ kind: 'node', node: 'dI', arrivedVia: 'dI-dHN' });
    expect(holding.clearance?.taxi.holdShort).toEqual([{ kind: 'taxiway', name: 'A' }]);
    expect(drainEvents(sim).filter((e) => e.type === 'holding-short')).toEqual([
      { type: 'holding-short', tick: expect.any(Number), callsign: 'DAL4', node: 'dI', holdShort: 'hDI', runways: [], target: { kind: 'taxiway', name: 'A' } },
    ]);
    step(sim, 600);
    expect(getAircraft(sim, 'DAL4').location).toEqual(holding.location);

    transmit(sim, 'DAL4 continue');
    step(sim, 2000);
    expect(getAircraft(sim, 'DAL4').status).toBe('arrived');
    expect(getAircraft(sim, 'DAL4').location).toEqual({ kind: 'node', node: 'rb7', arrivedVia: 'rb7-a7' });
  });

  it('is unable to hold short when too close to stop for it, braking at the hard limit, and keeps its clearance', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'node', node: 'dHN', arrivedVia: 'dHN-r1D' } });
    transmit(sim, 'DAL4 taxi ramp T1 via D A');
    // dHN to dI is 60 m. Step until the nose is within 5 m of dI.
    let near = getAircraft(sim, 'DAL4');
    while (!(near.location.kind === 'edge' && near.location.from === 'dHN' && near.location.distanceM >= 55)) {
      stepWaiting(sim);
      near = getAircraft(sim, 'DAL4');
    }
    expect((near.speedMps * near.speedMps) / (2 * MAX_DECEL_MPS2)).toBeGreaterThan(5);
    drainEvents(sim);
    transmit(sim, 'DAL4 hs A');
    expect(drainEvents(sim)).toEqual([
      {
        type: 'unable',
        tick: expect.any(Number),
        callsign: 'DAL4',
        instruction: { type: 'hold-short', target: { kind: 'taxiway', name: 'A' } },
        reason: 'too close to stop short of A at D south of A',
      },
    ]);
    expect(getAircraft(sim, 'DAL4').clearance?.taxi.holdShort).toEqual([]);
    step(sim, 2000);
    expect(getAircraft(sim, 'DAL4').status).toBe('arrived');
    expect(drainEvents(sim).filter((e) => e.type === 'holding-short')).toEqual([]);
  });
});

describe('runway hold-shorts', () => {
  it('acceptance: stops at a runway hold-short without clearance (hAW, 18/36 on A at r2A), and proceeds with one', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'B738', at: { kind: 'node', node: 'aJ', arrivedVia: 'aTC-aJ' } });
    transmit(sim, 'DAL4 taxi 27 via A');
    step(sim, 1200);
    let dal4 = getAircraft(sim, 'DAL4');
    // Nose on the hold line: at the hold node, not into the edge toward the runway.
    expect(dal4.status).toBe('holding-short');
    expect(dal4.location).toEqual({ kind: 'node', node: 'aH1', arrivedVia: 'aJ-aH1' });
    expect(drainEvents(sim).filter((e) => e.type === 'holding-short')).toEqual([
      { type: 'holding-short', tick: expect.any(Number), callsign: 'DAL4', node: 'aH1', holdShort: 'hAW', runways: ['18/36'], target: null },
    ]);

    transmit(sim, 'DAL4 cross 36');
    step(sim, 3000);
    dal4 = getAircraft(sim, 'DAL4');
    expect(dal4.status).toBe('arrived');
    expect(dal4.location).toEqual({ kind: 'node', node: 'a9H', arrivedVia: 'a9I-a9H' });
    // Used once crossed. The ILS hold on A9 (hA9ils) isn't named by the clearance, so it didn't stop there.
    expect(dal4.crossings).toEqual([]);
    const events = drainEvents(sim);
    expect(events.filter((e) => e.type === 'holding-short')).toEqual([]);
    expect(events.filter((e) => e.type === 'entered-runway')).toEqual([
      { type: 'entered-runway', tick: expect.any(Number), callsign: 'DAL4', holdShort: 'hAW', runways: ['18/36'], cleared: true },
    ]);
    expect(events.filter((e) => e.type === 'crossed-runway')).toEqual([
      { type: 'crossed-runway', tick: expect.any(Number), callsign: 'DAL4', runway: '18/36' },
    ]);
  });

  it("crosses only at the crossing's named taxiway; a correction replaces the latest crossing clearance", () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'B738', at: { kind: 'node', node: 'aJ', arrivedVia: 'aTC-aJ' } });
    transmit(sim, 'DAL4 taxi 27 via A, cross 36 at J');
    step(sim, 1200);
    // Its route crosses 18/36 on A, not J: the clearance doesn't apply there.
    expect(getAircraft(sim, 'DAL4')).toMatchObject({ status: 'holding-short', location: { kind: 'node', node: 'aH1' } });
    expect(getAircraft(sim, 'DAL4').crossings).toEqual([{ runways: ['18/36'], at: 'J' }]);
    transmit(sim, 'DAL4 neg cross 36 at A');
    expect(getAircraft(sim, 'DAL4').crossings).toEqual([{ runways: ['18/36'], at: 'A' }]);
    step(sim, 100);
    expect(drainEvents(sim).filter((e) => e.type === 'entered-runway')).toEqual([
      expect.objectContaining({ holdShort: 'hAW', runways: ['18/36'], cleared: true }),
    ]);
    expect(getAircraft(sim, 'DAL4').crossings).toEqual([]);
  });

  it('a later runway hold-short withdraws an earlier clearance to cross that runway: the later instruction wins', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'B738', at: { kind: 'node', node: 'aJ', arrivedVia: 'aTC-aJ' } });
    addAircraft(sim, { callsign: 'JBU11', type: 'B738', at: { kind: 'node', node: 'aTB', arrivedVia: 'aD-aTB' } });
    transmit(sim, 'DAL4 taxi 27 via A, cross 36, hs 36');
    transmit(sim, 'JBU11 cross 36, taxi 27 via A hs 36');
    expect(getAircraft(sim, 'DAL4').crossings).toEqual([]);
    expect(getAircraft(sim, 'JBU11').crossings).toEqual([]);
    step(sim, 2000);
    expect(getAircraft(sim, 'DAL4')).toMatchObject({ status: 'holding-short', location: { kind: 'node', node: 'aH1' } });
    expect(getAircraft(sim, 'JBU11')).toMatchObject({ status: 'stopped-for-traffic', blockedBy: 'DAL4' });
  });

  it('is unable to take a taxi clearance that puts a hold line inside its braking distance, so it never runs one', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'B738', at: { kind: 'node', node: 'aTC', arrivedVia: 'aC-aTC' } });
    transmit(sim, 'DAL4 taxi 27 via A, cross 36');
    // aJ to aH1 (hAW) is 110 m. Step until the nose is 5 m short of it.
    let near = getAircraft(sim, 'DAL4');
    while (!(near.location.kind === 'edge' && near.location.edge === 'aJ-aH1' && near.location.distanceM >= 105)) {
      stepWaiting(sim);
      near = getAircraft(sim, 'DAL4');
    }
    drainEvents(sim);
    transmit(sim, 'DAL4 taxi 27 via A hs 36');
    expect(drainEvents(sim)).toEqual([
      expect.objectContaining({ type: 'unable', callsign: 'DAL4', reason: 'too close to stop at the hold line for runway 18/36 at A west of runway 18/36' }),
    ]);
    expect(getAircraft(sim, 'DAL4').crossings).toEqual([{ runways: ['18/36'], at: null }]);
    step(sim, 100);
    expect(drainEvents(sim).filter((e) => e.type === 'entered-runway')).toEqual([
      expect.objectContaining({ holdShort: 'hAW', cleared: true }),
    ]);
  });

  it('is not released by continue: that takes a crossing clearance (commands.ts)', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'B738', at: { kind: 'node', node: 'aJ', arrivedVia: 'aTC-aJ' } });
    transmit(sim, 'DAL4 taxi 27 via A');
    step(sim, 1200);
    const holding = getAircraft(sim, 'DAL4');
    expect(holding.status).toBe('holding-short');
    drainEvents(sim);
    transmit(sim, 'DAL4 continue');
    expect(drainEvents(sim)).toEqual([
      {
        type: 'unable',
        tick: expect.any(Number),
        callsign: 'DAL4',
        instruction: { type: 'continue' },
        reason: 'holding short of runway 18/36 at A west of runway 18/36: crossing it takes a crossing clearance',
      },
    ]);
    step(sim, 600);
    expect(getAircraft(sim, 'DAL4').status).toBe('holding-short');
    expect(getAircraft(sim, 'DAL4').location).toEqual(holding.location);
  });
});
