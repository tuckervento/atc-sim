// The session's URL parameters beyond 1.7's `?airport=` (map/airports.ts). Pure.

export type SeedParamResult = { ok: true; seed: number } | { ok: false; message: string };

/** The sim's RNG keeps 32 bits of the seed (src/sim/rng.ts), so larger seeds would repeat smaller ones. */
const MAX_SEED = 2 ** 32 - 1;

/** `?seed=<whole number>` from a query string (`location.search`). Absent or empty: 1. */
export function parseSeedParam(search: string): SeedParamResult {
  const raw = new URLSearchParams(search).get('seed') ?? '';
  if (raw === '') return { ok: true, seed: 1 };
  const seed = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (!(seed <= MAX_SEED)) return { ok: false, message: `Bad seed "${raw}": use a whole number from 0 to ${MAX_SEED}, e.g. ?seed=7.` };
  return { ok: true, seed };
}
