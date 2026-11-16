// The live counters panel (PLAN 1.13), over 1.12's score (src/sim/score.ts, the sim's getScore):
// `scoreCounters` is what the app passes to createSession (main.ts). The session hands it every
// sim event as it's drained, oldest first, with the sim, then the page reads it once a frame.
// The score stops counting when the session ends, so the counters freeze with it. NO_COUNTERS
// shows placeholders: the session's default, for tests that don't look at the panel. Pure here:
// the panel's rows from the values.

import { getScore, type Sim, type SimEvent } from '../../sim/sim.ts';

/** PRD §4.2–4.3 scoring points: a departure counts at takeoff, an arrival at its gate. */
export interface CounterValues {
  departures: number;
  arrivals: number;
  /** Movements (departures + arrivals) an hour, averaged since the start. null: too early to say. */
  ratePerHour: number | null;
  /** The busiest rolling 15 minutes so far, as movements an hour. null: too early to say. */
  peak15PerHour: number | null;
}

export interface Counters {
  /** Every sim event, in order, as the session drains it; `sim` as of the end of those ticks. */
  observe(events: readonly SimEvent[], sim: Sim): void;
  /** The current values. null: not wired, so the panel shows placeholders. */
  read(): CounterValues | null;
}

/** No counters: placeholders in every row. */
export const NO_COUNTERS: Counters = {
  observe() {},
  read: () => null,
};

/**
 * The counters from the sim's score (getScore), combined for the rates: departures at takeoff,
 * arrivals at the gate (PRD §4.2–4.3). They read the sim they last observed, so they show
 * placeholders until the first observe (the session observes once at its start).
 */
export function scoreCounters(): Counters {
  let sim: Sim | null = null;
  return {
    observe(_events, observed) {
      sim = observed;
    },
    read() {
      if (sim === null) return null;
      const score = getScore(sim);
      return { departures: score.departures.total, arrivals: score.arrivals.total, ratePerHour: score.combined.perHour, peak15PerHour: score.combined.peakPerHour };
    },
  };
}

export interface CounterRow {
  label: string;
  value: string;
}

const PLACEHOLDER = '—';
const LABELS = ['Departures', 'Arrivals', 'Total', 'Rate /h', 'Peak 15 min /h'] as const;

export function counterRows(values: CounterValues | null): CounterRow[] {
  if (values === null) return LABELS.map((label) => ({ label, value: PLACEHOLDER }));
  const rate = (r: number | null) => (r === null ? PLACEHOLDER : r.toFixed(1));
  const shown = [values.departures, values.arrivals, values.departures + values.arrivals].map(String);
  shown.push(rate(values.ratePerHour), rate(values.peak15PerHour));
  return LABELS.map((label, i) => ({ label, value: shown[i] ?? PLACEHOLDER }));
}
