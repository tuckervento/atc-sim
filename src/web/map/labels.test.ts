import { describe, expect, it } from 'vitest';
import { chooseLabels, LABEL_RULES, type LabelCandidate, type MeasureLabel } from './labels.ts';
import type { Viewport } from './view.ts';

/** Fixed-width text: 7 px a character plus 6 px padding, 14 px tall. */
const measure: MeasureLabel = (text) => ({ widthPx: 7 * text.length + 6, heightPx: 14 });

function viewAt(scale: number): Viewport {
  return { centerX: 0, centerY: 0, scale, widthPx: 2000, heightPx: 2000 };
}

const texts = (candidates: LabelCandidate[], scale: number) =>
  chooseLabels(candidates, viewAt(scale), measure).map((l) => l.text);

describe('chooseLabels', () => {
  it('shows taxiway labels only from their minimum zoom, and runway labels at every zoom', () => {
    const candidates: LabelCandidate[] = [
      { text: '31L', kind: 'runway', at: [-200, 0], sizeM: 3000 },
      { text: 'KE', kind: 'taxiway', at: [200, 0], sizeM: 3000 },
    ];
    const min = LABEL_RULES.taxiway.minScale;
    expect(texts(candidates, min * 0.9)).toEqual(['31L']);
    expect(texts(candidates, min * 1.1)).toEqual(['31L', 'KE']);
    expect(LABEL_RULES.runway.minScale).toBe(0);
  });

  it("thins a taxiway's repeated name: one label per sameTextGapPx of screen, the longest edge's first", () => {
    const gap = LABEL_RULES.taxiway.sameTextGapPx;
    const scale = 1;
    const short: LabelCandidate = { text: 'A', kind: 'taxiway', at: [0, 0], sizeM: 200 };
    const long: LabelCandidate = { text: 'A', kind: 'taxiway', at: [0, (gap * 0.8) / scale], sizeM: 400 };
    const far: LabelCandidate = { text: 'A', kind: 'taxiway', at: [0, (-gap * 1.2) / scale], sizeM: 300 };
    const placed = chooseLabels([short, long, far], viewAt(scale), measure);
    expect(placed.map((l) => l.sizeM)).toEqual([400, 300]);
  });

  it('drops a label that would overlap one already placed, earlier kinds first; runway labels always stay', () => {
    // At 2 px/m (gates show from 1.5), 5 m apart is 10 px: these boxes overlap.
    const candidates: LabelCandidate[] = [
      // A cluster: the taxiway beats the ramp lane and the gate.
      { text: 'G7', kind: 'gate', at: [0, 0], sizeM: 50 },
      { text: 'TB', kind: 'rampLane', at: [5, 0], sizeM: 300 },
      { text: 'B', kind: 'taxiway', at: [0, 5], sizeM: 100 },
      // Two runway labels overlapping each other both stay, and block the taxiway label on them.
      { text: '4L', kind: 'runway', at: [200, 0], sizeM: 3000 },
      { text: '4R', kind: 'runway', at: [203, 0], sizeM: 3000 },
      { text: 'K', kind: 'taxiway', at: [201, 2], sizeM: 900 },
    ];
    expect(texts(candidates, 2)).toEqual(['4L', '4R', 'B']);
  });

  it("labels a taxiway edge only once it's minFeaturePx long on screen, and skips labels off screen", () => {
    const min = LABEL_RULES.taxiway.minFeaturePx;
    const connector: LabelCandidate = { text: 'K1', kind: 'taxiway', at: [0, 0], sizeM: 40 };
    expect(texts([connector], (min * 0.9) / 40)).toEqual([]);
    expect(texts([connector], (min * 1.1) / 40)).toEqual(['K1']);
    // The view is 2000 px wide centered on 0: at 1 px/m, x = 1100 m is 100 px past the right edge.
    const offScreen: LabelCandidate = { text: 'Z', kind: 'taxiway', at: [1100, 0], sizeM: 500 };
    const runwayOff: LabelCandidate = { text: '13R', kind: 'runway', at: [-1100, 0], sizeM: 3000 };
    expect(texts([offScreen, runwayOff], 1)).toEqual([]);
  });

  it('keeps labels off the obstacles given (aircraft data blocks), except runway labels', () => {
    const candidates: LabelCandidate[] = [
      { text: 'Kilo pad', kind: 'place', at: [0, 0], sizeM: 200 },
      { text: '4L', kind: 'runway', at: [100, 0], sizeM: 3000 },
      { text: 'K', kind: 'taxiway', at: [-300, 0], sizeM: 1000 },
    ];
    // Boxes are centered, in screen px; the view's center (0, 0) is at (1000, 1000).
    const obstacles = [
      { x: 1000, y: 1000, widthPx: 80, heightPx: 30 },
      { x: 1100, y: 1000, widthPx: 80, heightPx: 30 },
    ];
    expect(chooseLabels(candidates, viewAt(1), measure, obstacles).map((l) => l.text)).toEqual(['4L', 'K']);
  });

  it('keeps the input order between candidates of the same kind and size', () => {
    // The scene relies on this to put a run's label on its longest edge.
    const candidates: LabelCandidate[] = ['first', 'second', 'third'].map((text, i) => ({ text, kind: 'taxiway', at: [i * 200, 0], sizeM: 1000 }));
    expect(texts(candidates, 1)).toEqual(['first', 'second', 'third']);
  });

  it('shifts a label by its offsetPx on screen, whatever the zoom', () => {
    const end: LabelCandidate = { text: '31L', kind: 'runway', at: [100, 0], sizeM: 3000, offsetPx: [12, -20] };
    for (const scale of [0.25, 4]) {
      const [placed] = chooseLabels([end], viewAt(scale), measure);
      expect(placed && [placed.x, placed.y]).toEqual([1000 + 100 * scale + 12, 1000 - 20]);
    }
  });
});
