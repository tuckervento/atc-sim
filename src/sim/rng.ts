// The sim's only source of randomness (PRD §8.2: a seeded random number generator, so any
// session can be replayed). Mulberry32: one 32-bit integer of state, fast, and good enough for
// game variation (not for cryptography). The state lives in the world state, so it's part of
// the state hash, and the same seed plus the same commands gives the same session.

export interface Rng {
  /** The generator's whole state, a 32-bit signed integer. */
  state: number;
}

/** A generator seeded with `seed`, an integer (only its low 32 bits count). */
export function createRng(seed: number): Rng {
  if (!Number.isInteger(seed)) throw new Error(`rng seed must be an integer, got ${seed}`);
  return { state: seed | 0 };
}

/** The next number in [0, 1). Advances `rng`. */
export function nextFloat(rng: Rng): number {
  rng.state = (rng.state + 0x6d2b79f5) | 0;
  let t = Math.imul(rng.state ^ (rng.state >>> 15), 1 | rng.state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** The next number in [lo, hi). Advances `rng`. */
export function nextInRange(rng: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * nextFloat(rng);
}
