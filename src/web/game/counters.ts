// The live counters panel's slot (PLAN 1.13). The counts come from 1.12's src/sim/score.ts,
// which isn't merged yet: until it's wired, the session uses NO_COUNTERS and the panel shows a
// placeholder in every row.
//
// To wire score.ts, implement `Counters` over it and pass it to createSession (session.ts):
// the session hands it every sim event as it's drained, oldest first, with the sim, then reads it
// once a frame. Pure here: the panel's rows from the values.

import type { Sim, SimEvent } from '../../sim/sim.ts';

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

/** Until score.ts is wired. */
export const NO_COUNTERS: Counters = {
  observe() {},
  read: () => null,
};

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
