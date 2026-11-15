import { describe, expect, it } from 'vitest';
import { fitView, MAX_SCALE, MIN_SCALE, panBy, screenToWorld, worldToScreen, zoomAt, type Viewport } from './view.ts';

/** 1000 × 800 px, 2 px per meter, centered on (100 m east, 50 m north). */
const VIEW: Viewport = { centerX: 100, centerY: 50, scale: 2, widthPx: 1000, heightPx: 800 };

describe('worldToScreen', () => {
  it('puts the view center in the middle of the screen, north up and east right', () => {
    expect(worldToScreen(VIEW, [100, 50])).toEqual([500, 400]);
    // 10 m north is 20 px up (screen y grows downward); 10 m east is 20 px right.
    expect(worldToScreen(VIEW, [100, 60])).toEqual([500, 380]);
    expect(worldToScreen(VIEW, [110, 50])).toEqual([520, 400]);
  });
});

describe('screenToWorld', () => {
  it('inverts worldToScreen', () => {
    expect(screenToWorld(VIEW, [500, 400])).toEqual([100, 50]);
    expect(screenToWorld(VIEW, [520, 380])).toEqual([110, 60]);
    const back = screenToWorld(VIEW, worldToScreen(VIEW, [-1234.5, 987.25]));
    expect(back[0]).toBeCloseTo(-1234.5, 9);
    expect(back[1]).toBeCloseTo(987.25, 9);
  });
});

describe('zoomAt', () => {
  it('scales by the factor and keeps the world point under the cursor fixed', () => {
    const cursor: [number, number] = [137, 652];
    const before = screenToWorld(VIEW, cursor);
    for (const factor of [2, 0.5, 1.37]) {
      const zoomed = zoomAt(VIEW, factor, cursor);
      expect(zoomed.scale).toBeCloseTo(VIEW.scale * factor, 12);
      const after = worldToScreen(zoomed, before);
      expect(after[0]).toBeCloseTo(cursor[0], 9);
      expect(after[1]).toBeCloseTo(cursor[1], 9);
    }
  });

  it('clamps the scale to [MIN_SCALE, MAX_SCALE], still keeping the cursor point fixed', () => {
    const cursor: [number, number] = [800, 100];
    const before = screenToWorld(VIEW, cursor);
    const far = zoomAt(VIEW, 1e6, cursor);
    expect(far.scale).toBe(MAX_SCALE);
    const after = worldToScreen(far, before);
    expect(after[0]).toBeCloseTo(cursor[0], 9);
    expect(after[1]).toBeCloseTo(cursor[1], 9);
    expect(zoomAt(VIEW, 1e-6, cursor).scale).toBe(MIN_SCALE);
  });
});

describe('fitView', () => {
  it('centers the bounds and scales them to fill the screen inside the padding on the tighter axis', () => {
    // 2000 m wide × 500 m tall into 1000 × 800 px with 50 px padding: width limits, 900/2000 px/m.
    const view = fitView({ minX: -1000, minY: 0, maxX: 1000, maxY: 500 }, 1000, 800, 50);
    expect(view.scale).toBeCloseTo(0.45, 12);
    expect(worldToScreen(view, [-1000, 250])).toEqual([50, 400]);
    expect(worldToScreen(view, [1000, 250])).toEqual([950, 400]);
    // Height limits instead when the bounds are tall.
    const tall = fitView({ minX: 0, minY: -350, maxX: 10, maxY: 350 }, 1000, 800, 50);
    expect(tall.scale).toBeCloseTo(1, 12);
    expect(worldToScreen(tall, [5, 350])).toEqual([500, 50]);
  });
});

describe('panBy', () => {
  it('moves the map with the pointer: the point that was under it follows the drag', () => {
    const grabbed = screenToWorld(VIEW, [300, 200]);
    const panned = panBy(VIEW, 45, -30);
    expect(panned.scale).toBe(VIEW.scale);
    expect(worldToScreen(panned, grabbed)).toEqual([345, 170]);
  });
});
