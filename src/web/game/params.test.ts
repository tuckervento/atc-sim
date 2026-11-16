import { describe, expect, it } from 'vitest';
import { parseSeedParam } from './params.ts';

describe('parseSeedParam', () => {
  it('reads ?seed=<whole number>, default 1', () => {
    expect(parseSeedParam('?airport=KJFK')).toEqual({ ok: true, seed: 1 });
    expect(parseSeedParam('?airport=KJFK&seed=')).toEqual({ ok: true, seed: 1 });
    expect(parseSeedParam('?airport=KJFK&seed=42')).toEqual({ ok: true, seed: 42 });
    expect(parseSeedParam('?seed=0')).toEqual({ ok: true, seed: 0 });
    expect(parseSeedParam('?seed=4294967295')).toEqual({ ok: true, seed: 4294967295 });
  });

  it("says what's wrong with a seed that isn't a whole number from 0 to 4294967295 (the sim's RNG uses 32 bits)", () => {
    for (const bad of ['abc', '1.5', '-3', '4294967296', '1e3', ' 7']) {
      expect(parseSeedParam(`?seed=${encodeURIComponent(bad)}`)).toEqual({
        ok: false,
        message: `Bad seed "${bad}": use a whole number from 0 to 4294967295, e.g. ?seed=7.`,
      });
    }
  });
});
