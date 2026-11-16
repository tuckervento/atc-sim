import { describe, expect, it } from 'vitest';
import type { MapAircraft } from '../map/aircraft.ts';
import { interpolateAircraft } from './interpolate.ts';

function ac(callsign: string, nose: [number, number], headingDeg: number | null): MapAircraft {
  return { callsign, type: 'A320', nose, headingDeg, lengthM: 37.6, wingspanM: 35.8, role: 'departure', destination: '31L' };
}

describe('interpolateAircraft', () => {
  it('draws each aircraft alpha of the way from its last state to its current one', () => {
    const [drawn] = interpolateAircraft([ac('DAL4', [0, 0], 80)], [ac('DAL4', [10, -4], 100)], 0.25);
    expect(drawn?.nose[0]).toBeCloseTo(2.5, 9);
    expect(drawn?.nose[1]).toBeCloseTo(-1, 9);
    expect(drawn?.headingDeg).toBeCloseTo(85, 9);
  });

  it('turns the short way through north: 350° to 10° passes 0°, not 180°', () => {
    const [drawn] = interpolateAircraft([ac('DAL4', [0, 0], 350)], [ac('DAL4', [0, 0], 10)], 0.75);
    expect(drawn?.headingDeg).toBeCloseTo(5, 9);
    const [back] = interpolateAircraft([ac('DAL4', [0, 0], 10)], [ac('DAL4', [0, 0], 350)], 0.75);
    expect(back?.headingDeg).toBeCloseTo(355, 9);
  });

  it('draws an aircraft new this tick where it is, and takes the current heading when either side has none', () => {
    const now = [ac('UAE202', [5, 5], 310), ac('DAL4', [10, 0], 90), ac('JBU1', [4, 0], null)];
    const drawn = interpolateAircraft([ac('DAL4', [0, 0], null), ac('JBU1', [0, 0], 45)], now, 0.5);
    expect(drawn.map((a) => a.callsign)).toEqual(['UAE202', 'DAL4', 'JBU1']);
    expect(drawn[0]).toEqual(now[0]);
    expect(drawn[1]?.headingDeg).toBe(90);
    expect(drawn[1]?.nose).toEqual([5, 0]);
    expect(drawn[2]?.headingDeg).toBeNull();
  });
});
