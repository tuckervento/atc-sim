// The real-time scheduler: a fixed-step clock (PLAN 1.13). Each animation frame hands it the
// real time since the last frame; it says how many sim ticks to run now, and how far into the
// next tick the frame is, for drawing between the last two states. Pure: no timers.
//
// - Real time × speed accumulates; whole ticks are taken from it.
// - At most `maxTicksPerFrame` per frame. A backlog beyond that (a slow frame, a hidden tab) is
//   dropped, so the sim slows down rather than spiralling into ever longer frames.
// - Paused, time stops: no ticks, and the accumulator (so the drawn frame) stays where it was.

export interface ClockState {
  /** Sim seconds banked toward the next tick, in [0, tickS). */
  accumulatorS: number;
}

export interface ClockOptions {
  /** One sim tick, seconds (the sim's TICK_S). */
  tickS: number;
  maxTicksPerFrame: number;
}

export interface ClockControls {
  /** Sim seconds per real second, e.g. 1, 2 or 4. */
  speed: number;
  paused: boolean;
}

export interface ClockStep {
  state: ClockState;
  /** Ticks to run now. */
  ticks: number;
  /** How far the frame is between the state before the last tick and after it, in [0, 1). */
  alpha: number;
}

/** In ticks: banked time this close under a whole tick counts as the tick. */
const TICK_TOLERANCE = 1e-9;

export function initialClock(): ClockState {
  return { accumulatorS: 0 };
}

export function advanceClock(state: ClockState, realDtS: number, controls: ClockControls, options: ClockOptions): ClockStep {
  if (!(Number.isFinite(realDtS) && realDtS >= 0)) throw new Error(`real frame time must be finite and ≥ 0, got ${realDtS}`);
  if (controls.paused) return { state, ticks: 0, alpha: state.accumulatorS / options.tickS };
  const banked = state.accumulatorS + realDtS * controls.speed;
  // The tolerance: frame times that add up to a whole tick (0.05 + 0.05) must give it, though
  // in floating point they sum to a hair under.
  const due = Math.floor(banked / options.tickS + TICK_TOLERANCE);
  // Whole ticks past the cap are dropped; the fraction of the next one is kept.
  const accumulatorS = Math.max(0, banked - due * options.tickS);
  const ticks = Math.min(due, options.maxTicksPerFrame);
  return { state: { accumulatorS }, ticks, alpha: accumulatorS / options.tickS };
}
