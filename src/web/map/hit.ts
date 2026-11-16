// Click-to-select (PLAN 1.13): which aircraft is under a screen point. Pure. It uses the shape as
// draw.ts draws it: the footprint (length × wingspan) behind the nose along the heading, at true
// size but never shorter than MIN_AIRCRAFT_PX; or the aircraft's data block.

import type { MapAircraft } from './aircraft.ts';
import type { ScreenBox } from './labels.ts';
import { MIN_AIRCRAFT_PX } from './style.ts';
import { worldToScreen, type ScreenPoint, type Viewport } from './view.ts';

/** Slack around a footprint, px, so a small aircraft is easy to click. */
export const HIT_PAD_PX = 4;

/**
 * The aircraft at `point`: the last drawn (on top) whose footprint is under it, else the last
 * whose data block is (`blocks[i]` is `aircraft[i]`'s). null: none.
 */
export function hitTest(aircraft: readonly MapAircraft[], view: Viewport, point: ScreenPoint, blocks: readonly ScreenBox[]): string | null {
  for (let i = aircraft.length - 1; i >= 0; i--) {
    const ac = aircraft[i];
    if (ac && onFootprint(ac, view, point)) return ac.callsign;
  }
  for (let i = aircraft.length - 1; i >= 0; i--) {
    const [ac, box] = [aircraft[i], blocks[i]];
    if (ac && box && Math.abs(point[0] - box.x) * 2 <= box.widthPx && Math.abs(point[1] - box.y) * 2 <= box.heightPx) return ac.callsign;
  }
  return null;
}

function onFootprint(ac: MapAircraft, view: Viewport, [px, py]: ScreenPoint): boolean {
  const [x, y] = worldToScreen(view, ac.nose);
  const k = Math.max(view.scale, MIN_AIRCRAFT_PX / ac.lengthM);
  const length = ac.lengthM * k;
  const span = ac.wingspanM * k;
  const [dx, dy] = [px - x, py - y];
  // No heading: drawn as a disc of a third of the length at the nose.
  if (ac.headingDeg === null) return Math.hypot(dx, dy) <= length / 3 + HIT_PAD_PX;
  const rad = (ac.headingDeg * Math.PI) / 180;
  // Into the drawing's frame: nose at the origin, pointing to screen -y, the body along +y.
  const across = dx * Math.cos(rad) + dy * Math.sin(rad);
  const along = -dx * Math.sin(rad) + dy * Math.cos(rad);
  return along >= -HIT_PAD_PX && along <= length + HIT_PAD_PX && Math.abs(across) <= span / 2 + HIT_PAD_PX;
}
