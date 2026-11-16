// Score counters (PLAN 1.12, PRD §4.8). Points count only at the scoring points: a departure at
// lift-off (`took-off`), an arrival at its gate (`arrived-at-gate`). The record (`world.score`)
// is each scoring movement's tick and callsign; the rates are worked out from it when read, so
// there's nothing derived to keep in step. It counts while the session is running (sim.ts,
// `advance`); after the session ends it stays as it was.
//
// The rates, per hour, for departures and arrivals separately and combined:
// - Average: the total over the time since the session started (tick 0), to now, or to the tick
//   the session ended. null at tick 0, when no time has passed.
// - Peak: the most movements in any PEAK_WINDOW_S window, (t − 15 min, t], times the windows in an
//   hour (4). A movement exactly 15 minutes before another isn't in its window. Before the session
//   has run 15 minutes, a window reaches back before the start, so the peak counts what there is
//   as if over the full window: a lower bound, never a rate from a shorter span. [Proposal] (PRD
//   §4.8) for the window length.

import { TICK_HZ } from './movement.ts';
import type { ScoredMovement, ScoreState, SimEvent } from './world.ts';

/** The peak rate's window, seconds (PRD §4.8's 15 minutes). */
export const PEAK_WINDOW_S = 15 * 60;

/** Totals and rates for one kind of movement, or both. */
export interface Rates {
  total: number;
  /** Average per hour since the session started. null when no time has passed. */
  perHour: number | null;
  /** The most in any PEAK_WINDOW_S window, per hour. */
  peakPerHour: number;
}

/** What the counters show (PRD §4.8): plain data. */
export interface ScoreView {
  /** Session time the averages are over, seconds. */
  elapsedS: number;
  departures: Rates;
  arrivals: Rates;
  combined: Rates;
}

export function initialScore(): ScoreState {
  return { departures: [], arrivals: [] };
}

/** Counts this tick's scoring points from its events. */
export function recordScore(score: ScoreState, events: readonly SimEvent[]): void {
  for (const e of events) {
    if (e.type === 'took-off') score.departures.push({ tick: e.tick, callsign: e.callsign });
    if (e.type === 'arrived-at-gate') score.arrivals.push({ tick: e.tick, callsign: e.callsign });
  }
}

/** The counters as of `nowTick`. */
export function scoreView(score: ScoreState, nowTick: number): ScoreView {
  const elapsedS = nowTick / TICK_HZ;
  const rates = (movements: readonly ScoredMovement[]): Rates => ({
    total: movements.length,
    perHour: elapsedS > 0 ? (movements.length * 3600) / elapsedS : null,
    peakPerHour: (peakCount(movements.map((m) => m.tick)) * 3600) / PEAK_WINDOW_S,
  });
  const both = [...score.departures, ...score.arrivals];
  return { elapsedS, departures: rates(score.departures), arrivals: rates(score.arrivals), combined: rates(both) };
}

/** The most ticks in any window (t − PEAK_WINDOW_S, t]. */
function peakCount(ticks: number[]): number {
  const sorted = [...ticks].sort((a, b) => a - b);
  const window = PEAK_WINDOW_S * TICK_HZ;
  let best = 0;
  let i = 0;
  for (let j = 0; j < sorted.length; j++) {
    const t = sorted[j] ?? NaN;
    while ((sorted[i] ?? NaN) <= t - window) i++;
    best = Math.max(best, j - i + 1);
  }
  return best;
}
