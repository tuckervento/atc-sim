// The map's viewport: how airport meters map to canvas pixels, and the pan/zoom maths. Pure.
//
// The airport's local frame is x = meters east, y = meters north (src/airport/geo.ts). The map
// keeps north up, as an FAA airport diagram does: screen x grows east, screen y grows south.

import type { Point } from '../../airport/types.ts';

export interface Viewport {
  /** The world point (meters east, north) at the middle of the screen. */
  centerX: number;
  centerY: number;
  /** Pixels per meter. */
  scale: number;
  /** Screen size in CSS pixels. */
  widthPx: number;
  heightPx: number;
}

/** A screen position in CSS pixels from the canvas's top-left corner. */
export type ScreenPoint = [x: number, y: number];

export function worldToScreen(view: Viewport, point: Point): ScreenPoint {
  return [
    view.widthPx / 2 + (point[0] - view.centerX) * view.scale,
    view.heightPx / 2 - (point[1] - view.centerY) * view.scale,
  ];
}

export function screenToWorld(view: Viewport, screen: ScreenPoint): Point {
  return [
    view.centerX + (screen[0] - view.widthPx / 2) / view.scale,
    view.centerY - (screen[1] - view.heightPx / 2) / view.scale,
  ];
}

/** Zoom limits, pixels per meter: a whole region down to one gate filling the screen. */
export const MIN_SCALE = 0.02;
export const MAX_SCALE = 40;

/**
 * Multiplies the scale by `factor` (clamped to [MIN_SCALE, MAX_SCALE]) around `anchor`: the
 * world point under `anchor` stays under it, as when zooming with the wheel at the cursor.
 */
export function zoomAt(view: Viewport, factor: number, anchor: ScreenPoint): Viewport {
  const [ax, ay] = screenToWorld(view, anchor);
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
  // Solve worldToScreen(result, [ax, ay]) = anchor for the new center.
  return {
    ...view,
    scale,
    centerX: ax - (anchor[0] - view.widthPx / 2) / scale,
    centerY: ay + (anchor[1] - view.heightPx / 2) / scale,
  };
}

/** An axis-aligned box in the local frame, meters. */
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The view that shows all of `bounds`, centered, `paddingPx` in from the tighter edges. */
export function fitView(bounds: Bounds, widthPx: number, heightPx: number, paddingPx: number): Viewport {
  // A degenerate box (one point, or one line) still gets a finite scale.
  const w = Math.max(bounds.maxX - bounds.minX, 1);
  const h = Math.max(bounds.maxY - bounds.minY, 1);
  const fit = Math.min((widthPx - 2 * paddingPx) / w, (heightPx - 2 * paddingPx) / h);
  return {
    centerX: (bounds.minX + bounds.maxX) / 2,
    centerY: (bounds.minY + bounds.maxY) / 2,
    scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, fit)),
    widthPx,
    heightPx,
  };
}

/** Drags the map by (dx, dy) screen pixels: what was under the pointer stays under it. */
export function panBy(view: Viewport, dxPx: number, dyPx: number): Viewport {
  return { ...view, centerX: view.centerX - dxPx / view.scale, centerY: view.centerY + dyPx / view.scale };
}
