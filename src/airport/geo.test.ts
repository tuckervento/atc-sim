import { describe, expect, it } from 'vitest';
import { toLatLon, toLocal } from './geo.ts';

describe('local frame projection', () => {
  it('puts the reference point at the origin, x east and y north', () => {
    const ref = { lat: 40.64, lon: -73.78 };
    expect(toLocal(ref, ref.lat, ref.lon)).toEqual([0, 0]);
    const [x, y] = toLocal(ref, ref.lat + 0.001, ref.lon + 0.001);
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(0);
  });

  it('matches known WGS84 distances', () => {
    // 0.01° of longitude on the equator: a × π/180 × 0.01.
    expect(toLocal({ lat: 0, lon: 0 }, 0, 0.01)[0]).toBeCloseTo(1113.195, 2);
    // One arc-minute of latitude at 40.64°N is about 1,850.8 m (meridional radius ≈ 6,362.5 km).
    expect(toLocal({ lat: 40.64, lon: -73.78 }, 40.64 + 1 / 60, -73.78)[1]).toBeCloseTo(1850.8, 0);
  });

  it('round-trips through toLatLon', () => {
    const ref = { lat: 40.64, lon: -73.78 };
    const { lat, lon } = toLatLon(ref, [1500, -2300]);
    const [x, y] = toLocal(ref, lat, lon);
    expect(x).toBeCloseTo(1500, 6);
    expect(y).toBeCloseTo(-2300, 6);
  });
});
