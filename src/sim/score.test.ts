// Score counters (PLAN 1.12, PRD §4.8): departures at lift-off, arrivals at the gate; totals,
// average rates and the rolling 15-minute peak, combined and separately.

import { describe, expect, it } from 'vitest';
import testAirport from '../../data/airports/TEST.json' with { type: 'json' };
import { indexAirport } from '../airport/graph.ts';
import { loadAirport } from '../airport/load.ts';
import { TICK_HZ } from './movement.ts';
import { initialScore, PEAK_WINDOW_S, recordScore, scoreView } from './score.ts';
import { addAircraft, applyCommand, createSim, drainEvents, getScore, step, type Sim } from './sim.ts';
import { parseTerse } from './terse.ts';
import type { SimEvent } from './world.ts';

const TEST = indexAirport(loadAirport(testAirport));

function transmit(sim: Sim, text: string): void {
  const result = parseTerse(text);
  if (!result.ok) throw new Error(`'${text}' doesn't parse: ${result.error.message}`);
  applyCommand(sim, result.command);
}

const MINUTE = 60 * TICK_HZ;
const tookOff = (tick: number, callsign: string): SimEvent => ({ type: 'took-off', tick, callsign, runwayEnd: '27' });
const atGate = (tick: number, callsign: string): SimEvent => ({ type: 'arrived-at-gate', tick, callsign, gate: 'T1-1' });

/** Records `events` the way the sim does: each tick's events together, in tick order. */
function record(events: SimEvent[]) {
  const score = initialScore();
  const ticks = [...new Set(events.map((e) => e.tick))].sort((a, b) => a - b);
  for (const tick of ticks) recordScore(score, events.filter((e) => e.tick === tick));
  return score;
}

describe('score', () => {
  it('acceptance: a scripted 60-minute timeline yields the exact expected totals and rates', () => {
    expect(PEAK_WINDOW_S).toBe(15 * 60);
    const events: SimEvent[] = [];
    // Departures: one every 2 minutes, at minutes 1, 3, …, 59 (30).
    for (let m = 1; m < 60; m += 2) events.push(tookOff(m * MINUTE, `DEP${m}`));
    // Arrivals: at minutes 10, 20 and 30, then a burst at 40, 41, …, 49 (13).
    for (const m of [10, 20, 30, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49]) events.push(atGate(m * MINUTE, `ARR${m}`));
    // Neither counts: landing isn't arriving at the gate, and leaving isn't lift-off.
    events.push({ type: 'landed', tick: 5 * MINUTE, callsign: 'ARR10', runwayEnd: '27' }, { type: 'departed', tick: 2 * MINUTE, callsign: 'DEP1', runwayEnd: '27' });
    const score = record(events);

    // A window is 15 minutes, (t − 15 min, t]. Departures: 8 in any window of odd minutes.
    // Arrivals: 40–49 in (34, 49]; 30 can't join them. Combined: (34, 49] holds departures 35–49 (8)
    // and arrivals 40–49 (10); a window also holding arrival 30 would end before 45.
    expect(scoreView(score, 60 * MINUTE)).toEqual({
      elapsedS: 3600,
      departures: { total: 30, perHour: 30, peakPerHour: 32 },
      arrivals: { total: 13, perHour: 13, peakPerHour: 40 },
      combined: { total: 43, perHour: 43, peakPerHour: 72 },
    });
    // The record: who, and when.
    expect(score.departures.slice(0, 2)).toEqual([
      { tick: 1 * MINUTE, callsign: 'DEP1' },
      { tick: 3 * MINUTE, callsign: 'DEP3' },
    ]);
    expect(score.arrivals.at(-1)).toEqual({ tick: 49 * MINUTE, callsign: 'ARR49' });
  });

  it('peak windows are 15 minutes, (t − 15 min, t]: exactly 15 minutes apart is two windows, a tick less is one', () => {
    const apart = record([tookOff(MINUTE, 'A1'), tookOff(16 * MINUTE, 'A2')]);
    expect(scoreView(apart, 20 * MINUTE).departures).toEqual({ total: 2, perHour: 6, peakPerHour: 4 });
    const within = record([tookOff(MINUTE, 'A1'), tookOff(16 * MINUTE - 1, 'A2')]);
    expect(scoreView(within, 20 * MINUTE).departures).toEqual({ total: 2, perHour: 6, peakPerHour: 8 });
  });

  it("counts the sim's own scoring points: a departure at lift-off, an arrival at its gate (TEST)", () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'B738', at: { kind: 'node', node: 'aP2', arrivedVia: 'aP1-aP2' } });
    addAircraft(sim, { callsign: 'BAW1', type: 'A320', role: 'arrival', airline: 'BAW', terminal: 'T2', at: { kind: 'node', node: 'aTC', arrivedVia: 'aTC-aJ' } });
    transmit(sim, 'DAL4 taxi 27 via A, monitor tower');
    transmit(sim, 'BAW1 taxi ramp via TC, monitor ramp');
    expect(getScore(sim).combined.total).toBe(0);
    const ticks = { tookOff: NaN, atGate: NaN };
    for (let i = 0; i < 6000 && (Number.isNaN(ticks.tookOff) || Number.isNaN(ticks.atGate)); i++) {
      step(sim, 1);
      for (const e of drainEvents(sim)) {
        if (e.type === 'took-off') ticks.tookOff = e.tick;
        if (e.type === 'arrived-at-gate') ticks.atGate = e.tick;
      }
      // Lift-off is the point, not the departure's leaving the sim later.
      if (sim.world.tick === ticks.tookOff) expect(getScore(sim).departures.total).toBe(1);
    }
    expect(sim.world.score).toEqual({ departures: [{ tick: ticks.tookOff, callsign: 'DAL4' }], arrivals: [{ tick: ticks.atGate, callsign: 'BAW1' }] });
    const now = sim.world.tick;
    expect(getScore(sim)).toEqual(scoreView(sim.world.score, now));
    expect(getScore(sim).combined).toEqual({ total: 2, perHour: (2 * 3600 * TICK_HZ) / now, peakPerHour: 8 });
  });

  it('has no average before any time has passed', () => {
    expect(scoreView(initialScore(), 0)).toEqual({
      elapsedS: 0,
      departures: { total: 0, perHour: null, peakPerHour: 0 },
      arrivals: { total: 0, perHour: null, peakPerHour: 0 },
      combined: { total: 0, perHour: null, peakPerHour: 0 },
    });
  });
});
