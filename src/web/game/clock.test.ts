import { describe, expect, it } from 'vitest';
import { advanceClock, initialClock, type ClockOptions } from './clock.ts';

const OPTIONS: ClockOptions = { tickS: 0.1, maxTicksPerFrame: 8 };

describe('advanceClock', () => {
  it('runs one tick per tickS of real time at 1×, and gives the fraction of the next tick for interpolation', () => {
    const { ticks, alpha } = advanceClock(initialClock(), 0.25, { speed: 1, paused: false }, OPTIONS);
    expect(ticks).toBe(2);
    expect(alpha).toBeCloseTo(0.5, 9);
  });

  it('paused: no ticks, and the banked time (so the drawn frame) stays put', () => {
    const before = advanceClock(initialClock(), 0.25, { speed: 1, paused: false }, OPTIONS);
    const paused = advanceClock(before.state, 3, { speed: 1, paused: true }, OPTIONS);
    expect(paused.ticks).toBe(0);
    expect(paused.state).toEqual(before.state);
    expect(paused.alpha).toBeCloseTo(0.5, 9);
  });

  it('catches up at most maxTicksPerFrame, and drops the rest of a backlog (a slow frame, a hidden tab)', () => {
    const slow = advanceClock(initialClock(), 5.05, { speed: 1, paused: false }, OPTIONS);
    expect(slow.ticks).toBe(8);
    // The fraction of a tick is kept; the 42 whole ticks beyond the cap are gone.
    expect(slow.state.accumulatorS).toBeCloseTo(0.05, 9);
    expect(advanceClock(slow.state, 0.05, { speed: 1, paused: false }, OPTIONS).ticks).toBe(1);
  });

  it('runs sim time at the speed: 4× gives four ticks per tickS of real time', () => {
    expect(advanceClock(initialClock(), 0.1, { speed: 4, paused: false }, OPTIONS).ticks).toBe(4);
  });

  it('one real second of 60 fps frames is exactly TICK_HZ ticks, with no drift from rounding', () => {
    let state = initialClock();
    let total = 0;
    for (let frame = 0; frame < 600; frame++) {
      const step = advanceClock(state, 1 / 60, { speed: 1, paused: false }, OPTIONS);
      state = step.state;
      total += step.ticks;
    }
    expect(total).toBe(100);
  });

  it('throws for a negative or non-finite frame time: a caller bug, not something to bank', () => {
    for (const dt of [-0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => advanceClock(initialClock(), dt, { speed: 1, paused: false }, OPTIONS)).toThrow(`real frame time must be finite and ≥ 0, got ${dt}`);
    }
  });
});
