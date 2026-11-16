import { describe, expect, it } from 'vitest';
import type { MapAircraft } from './aircraft.ts';
import { hitTest } from './hit.ts';
import type { Viewport } from './view.ts';

/** 1 px per meter, world (0, 0) at screen (400, 300). */
const VIEW: Viewport = { centerX: 0, centerY: 0, scale: 1, widthPx: 800, heightPx: 600 };

function ac(callsign: string, nose: [number, number], headingDeg: number | null): MapAircraft {
  // An A320: 37.6 m long, 35.8 m span.
  return { callsign, type: 'A320', nose, headingDeg, lengthM: 37.6, wingspanM: 35.8, role: 'departure', destination: '31L' };
}

describe('hitTest', () => {
  it('hits the footprint behind the nose, and misses ahead of it or past a wingtip', () => {
    const north = [ac('DAL4', [0, 0], 0)];
    expect(hitTest(north, VIEW, [400, 320], [])).toBe('DAL4');
    expect(hitTest(north, VIEW, [415, 330], [])).toBe('DAL4');
    expect(hitTest(north, VIEW, [400, 290], [])).toBeNull();
    expect(hitTest(north, VIEW, [425, 320], [])).toBeNull();
    expect(hitTest(north, VIEW, [400, 345], [])).toBeNull();
  });

  it('turns the footprint with the heading: heading east, the body lies west of the nose', () => {
    const east = [ac('DAL4', [0, 0], 90)];
    expect(hitTest(east, VIEW, [380, 300], [])).toBe('DAL4');
    expect(hitTest(east, VIEW, [380, 285], [])).toBe('DAL4');
    expect(hitTest(east, VIEW, [420, 300], [])).toBeNull();
    expect(hitTest(east, VIEW, [400, 325], [])).toBeNull();
  });

  it('with no heading, hits the round marker draw.ts draws at the nose (radius a third of the length)', () => {
    const parked = [ac('DAL4', [0, 0], null)];
    expect(hitTest(parked, VIEW, [410, 295], [])).toBe('DAL4');
    expect(hitTest(parked, VIEW, [400, 335], [])).toBeNull();
  });

  it("hits an aircraft's data block; where shapes overlap, the one drawn last (on top) wins, and a shape beats a block", () => {
    const two = [ac('DAL4', [0, 0], 0), ac('UAL9', [0, -10], 0)];
    const blocks = [
      { x: 460, y: 270, widthPx: 50, heightPx: 28 },
      { x: 460, y: 300, widthPx: 50, heightPx: 28 },
    ];
    expect(hitTest(two, VIEW, [470, 265], blocks)).toBe('DAL4');
    expect(hitTest(two, VIEW, [470, 310], blocks)).toBe('UAL9');
    expect(hitTest(two, VIEW, [400, 320], blocks)).toBe('UAL9');
    expect(hitTest(two, VIEW, [400, 305], [])).toBe('DAL4');
    expect(hitTest([ac('DAL4', [0, 0], 0), ac('UAL9', [100, 0], 0)], VIEW, [400, 320], [{ x: 0, y: 0, widthPx: 0, heightPx: 0 }, { x: 400, y: 320, widthPx: 50, heightPx: 28 }])).toBe('DAL4');
  });

  it('zoomed out, hits the shape at the size it is drawn: never shorter than MIN_AIRCRAFT_PX', () => {
    const far: Viewport = { ...VIEW, scale: 0.05 };
    // Drawn 16 px long, so 16 × 35.8 / 37.6 ≈ 15 px across.
    expect(hitTest([ac('DAL4', [0, 0], 0)], far, [405, 314], [])).toBe('DAL4');
    expect(hitTest([ac('DAL4', [0, 0], 0)], far, [400, 324], [])).toBeNull();
  });
});
