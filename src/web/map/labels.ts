// Which labels to draw at the current zoom, and where on screen. Pure: the caller passes a
// text measurer (the canvas's in the browser).
//
// Labels are drawn at a fixed pixel size, so they stay readable at any zoom; what changes with
// zoom is how many are shown.

import type { Point } from '../../airport/types.ts';
import { worldToScreen, type ScreenPoint, type Viewport } from './view.ts';

export type LabelKind = 'runway' | 'taxiway' | 'place' | 'terminal' | 'rampLane' | 'building' | 'gate';

/** Something that could be labeled. */
export interface LabelCandidate {
  text: string;
  kind: LabelKind;
  /** Where the label's center goes, in the local frame. */
  at: Point;
  /** Size of the feature it names, meters (an edge's length, an outline's span). Bigger is labeled first. */
  sizeM: number;
  /** Shift from `at` on screen, px, kept at every zoom (e.g. a runway designator just past the pavement end). */
  offsetPx?: ScreenPoint;
}

/** A label to draw: its candidate plus its screen box. */
export interface PlacedLabel extends LabelCandidate, ScreenBox {}

/** A screen box: center and size, CSS px. */
export interface ScreenBox {
  x: number;
  y: number;
  widthPx: number;
  heightPx: number;
}

export type MeasureLabel =(text: string, kind: LabelKind) => { widthPx: number; heightPx: number };

export interface LabelRule {
  /** Hidden below this zoom, px per meter. */
  minScale: number;
  /**
   * A label is skipped when one with the same text is already placed closer than this, in
   * screen px: a taxiway split into many edges gets one label per stretch of screen, not one
   * per edge. 0: no thinning.
   */
  sameTextGapPx: number;
  /**
   * Hidden while the feature (`sizeM`) is shorter than this on screen, px: short connectors
   * get their names only once zoomed in far enough to see them. 0: no minimum.
   */
  minFeaturePx: number;
}

export const LABEL_RULES: Record<LabelKind, LabelRule> = {
  runway: { minScale: 0, sameTextGapPx: 0, minFeaturePx: 0 },
  taxiway: { minScale: 0.12, sameTextGapPx: 260, minFeaturePx: 24 },
  // A place offers several positions (scene.ts); a huge gap keeps one per name on screen.
  place: { minScale: 0.15, sameTextGapPx: 5000, minFeaturePx: 0 },
  terminal: { minScale: 0.1, sameTextGapPx: 400, minFeaturePx: 0 },
  rampLane: { minScale: 0.7, sameTextGapPx: 260, minFeaturePx: 24 },
  building: { minScale: 0.6, sameTextGapPx: 200, minFeaturePx: 0 },
  gate: { minScale: 1.5, sameTextGapPx: 0, minFeaturePx: 0 },
};

/** Placement order: earlier kinds win when labels would overlap. */
const KIND_ORDER: readonly LabelKind[] = ['runway', 'taxiway', 'place', 'terminal', 'rampLane', 'building', 'gate'];

/**
 * The labels to draw: placed by kind (KIND_ORDER), then bigger features first, then in the
 * given order. A label is skipped when it's below its kind's zoom or feature-size threshold,
 * off screen, near a placed label with the same text, or overlapping a placed label. Runway
 * labels are never skipped for overlap, and everything else avoids them. Aircraft play no part
 * (createLabelLayer hides what they cover).
 */
export function chooseLabels(candidates: LabelCandidate[], view: Viewport, measure: MeasureLabel): PlacedLabel[] {
  const rank = (c: LabelCandidate) => KIND_ORDER.indexOf(c.kind);
  const ordered = candidates
    .filter((c) => view.scale >= LABEL_RULES[c.kind].minScale && c.sizeM * view.scale >= LABEL_RULES[c.kind].minFeaturePx)
    // Stable: equal kind and size keep the caller's order.
    .sort((a, b) => rank(a) - rank(b) || b.sizeM - a.sizeM);
  const placed: PlacedLabel[] = [];
  for (const c of ordered) {
    const [ax, ay] = worldToScreen(view, c.at);
    const x = ax + (c.offsetPx?.[0] ?? 0);
    const y = ay + (c.offsetPx?.[1] ?? 0);
    const gap = LABEL_RULES[c.kind].sameTextGapPx;
    if (gap > 0 && placed.some((p) => p.text === c.text && Math.hypot(p.x - x, p.y - y) < gap)) continue;
    const label: PlacedLabel = { ...c, x, y, ...measure(c.text, c.kind) };
    if (!onScreen(label, view)) continue;
    // Runway labels are always kept, and everything after them must avoid them.
    if (c.kind !== 'runway' && placed.some((p) => overlaps(p, label))) continue;
    placed.push(label);
  }
  return placed;
}

/**
 * The map's labels as drawn each frame (Q, 2026-11-16: "it should just toggle visibility of the
 * occluded icons, but they should still be treated as if they are there for the overall map
 * positioning"):
 * - `layout`: chooseLabels against the map alone, no aircraft. Laid out again only when the view
 *   changes (pan, zoom, resize); otherwise the same array as last time.
 * - `visible`: that layout, less any label one of `covers` overlaps (aircraft shapes and data
 *   blocks, screen boxes). Nothing is laid out again, so the rest stay where they are, and a
 *   label a covered one beat stays hidden.
 */
export interface LabelLayer {
  layout(view: Viewport): PlacedLabel[];
  visible(view: Viewport, covers: readonly ScreenBox[]): PlacedLabel[];
}

export function createLabelLayer(candidates: LabelCandidate[], measure: MeasureLabel): LabelLayer {
  let last: { view: Viewport; labels: PlacedLabel[] } | null = null;
  const layout = (view: Viewport) => {
    if (!last || !sameView(last.view, view)) last = { view: { ...view }, labels: chooseLabels(candidates, view, measure) };
    return last.labels;
  };
  return {
    layout,
    visible: (view, covers) => layout(view).filter((label) => !covers.some((c) => overlaps(c, label))),
  };
}

function sameView(a: Viewport, b: Viewport): boolean {
  return a.centerX === b.centerX && a.centerY === b.centerY && a.scale === b.scale && a.widthPx === b.widthPx && a.heightPx === b.heightPx;
}

/** Space kept clear around each label, px. */
const LABEL_MARGIN_PX = 2;

/** Any part of the label's box is inside the view. */
function onScreen(l: PlacedLabel, view: Viewport): boolean {
  return l.x + l.widthPx / 2 >= 0 && l.x - l.widthPx / 2 <= view.widthPx && l.y + l.heightPx / 2 >= 0 && l.y - l.heightPx / 2 <= view.heightPx;
}

function overlaps(a: ScreenBox, b: ScreenBox): boolean {
  return (
    Math.abs(a.x - b.x) * 2 < a.widthPx + b.widthPx + 2 * LABEL_MARGIN_PX &&
    Math.abs(a.y - b.y) * 2 < a.heightPx + b.heightPx + 2 * LABEL_MARGIN_PX
  );
}
