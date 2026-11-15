import { describe, expect, it } from 'vitest';
import { AIRCRAFT_ROLES } from './aircraft.ts';
import { roleColor, RUNWAY_USE_COLOR } from './style.ts';

describe('roleColor', () => {
  it('gives each role its own color', () => {
    const colors = AIRCRAFT_ROLES.map(roleColor);
    expect(new Set(colors).size).toBe(AIRCRAFT_ROLES.length);
    for (const c of colors) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('matches departures and arrivals to the active-runway marking for the same use', () => {
    expect(roleColor('departure')).toBe(RUNWAY_USE_COLOR.departures);
    expect(roleColor('arrival')).toBe(RUNWAY_USE_COLOR.arrivals);
  });
});
