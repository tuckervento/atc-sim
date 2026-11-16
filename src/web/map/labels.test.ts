import { describe, expect, it } from 'vitest';
import { chooseLabels, createLabelLayer, LABEL_RULES, type LabelCandidate, type MeasureLabel } from './labels.ts';
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

describe('createLabelLayer', () => {
  // At 2 px/m (gates show from 1.5): K and G1 are 10 px apart, so their boxes overlap and K, the
  // taxiway, wins. B is far from both. The view's center (0, 0) is at (1000, 1000).
  const candidates: LabelCandidate[] = [
    { text: 'K', kind: 'taxiway', at: [0, 0], sizeM: 900 },
    { text: 'G1', kind: 'gate', at: [5, 0], sizeM: 50 },
    { text: 'B', kind: 'taxiway', at: [200, 0], sizeM: 900 },
  ];
  const at = (labels: { text: string; x: number; y: number }[]) => labels.map((l) => `${l.text}@${l.x},${l.y}`);

  it("hides a label an aircraft covers, and nothing else changes: the label it beat doesn't appear in its place, and the rest stay put", () => {
    const layer = createLabelLayer(candidates, measure);
    const view = viewAt(2);
    expect(at(layer.visible(view, []))).toEqual(['K@1000,1000', 'B@1400,1000']);
    // A data block over K's left end, clear of G1 (K is 13 px wide at x = 1000, G1 20 px at
    // 1010; boxes keep 2 px apart): laid out again with it as an obstacle, G1 would take K's place.
    const block = { x: 977, y: 1000, widthPx: 36, heightPx: 28 };
    expect(at(layer.visible(view, [block]))).toEqual(['B@1400,1000']);
  });

  it('keeps one layout while an aircraft crosses the map: a label blinks out as it passes over and comes back in the same place', () => {
    const layer = createLabelLayer(candidates, measure);
    const view = viewAt(2);
    const layout = layer.layout(view);
    const k = layout.find((l) => l.text === 'K');
    if (!k) throw new Error('K not laid out');
    const seen: string[] = [];
    // A 60 × 28 px data block moving east along y = 1000, from well left of K to past B.
    for (let x = 900; x <= 1500; x += 5) {
      const shown = layer.visible(view, [{ x, y: 1000, widthPx: 60, heightPx: 28 }]);
      expect(layer.layout(view)).toBe(layout);
      for (const l of shown) expect(layout).toContain(l);
      const kNow = shown.includes(k) ? 'K' : '-';
      if (seen.at(-1) !== kNow) seen.push(kNow);
    }
    expect(seen).toEqual(['K', '-', 'K']);
    expect(at(layer.visible(view, []))).toEqual(['K@1000,1000', 'B@1400,1000']);
  });

  it('lays out again only when the view changes: pan, zoom or resize', () => {
    const layer = createLabelLayer(candidates, measure);
    const first = layer.layout(viewAt(2));
    // The same view, as a new object (the map makes one per pan or zoom step).
    expect(layer.layout(viewAt(2))).toBe(first);
    // Panned 50 px right: everything moves with the map, once.
    const panned = { ...viewAt(2), centerX: -25 };
    const moved = layer.layout(panned);
    expect(moved).not.toBe(first);
    expect(at(moved)).toEqual(['K@1050,1000', 'B@1450,1000']);
    expect(layer.layout({ ...panned })).toBe(moved);
    expect(layer.layout({ ...panned, widthPx: 1500 })).not.toBe(moved);
    expect(at(layer.layout(viewAt(1)))).toEqual(['K@1000,1000', 'B@1200,1000']);
  });
});
