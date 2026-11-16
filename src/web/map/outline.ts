// An aircraft's shape on screen, as draw.ts paints it. Pure, so tests can hold it against the
// sim's footprint (they lie along the same axis: the body's, from the main gear to the nose),
// and so the label layer can tell which labels it covers.

import type { MapAircraft } from './aircraft.ts';
import type { ScreenBox } from './labels.ts';
import { MIN_AIRCRAFT_PX } from './style.ts';
import { worldToScreen, type ScreenPoint, type Viewport } from './view.ts';

/** Px per meter for an aircraft's shape: true size, but at least MIN_AIRCRAFT_PX long. */
export function aircraftScale(ac: MapAircraft, view: Viewport): number {
  return Math.max(view.scale, MIN_AIRCRAFT_PX / ac.lengthM);
}

/**
 * The shape's corners in screen px, nose first: back from the nose along the body's heading
 * (MapAircraft.headingDeg) for the whole length. null with no heading: drawn as a disc of a
 * third of the length at the nose (aircraftMarkerRadius).
 */
export function aircraftOutline(ac: MapAircraft, view: Viewport): ScreenPoint[] | null {
  if (ac.headingDeg === null) return null;
  const [x, y] = worldToScreen(view, ac.nose);
  const k = aircraftScale(ac, view);
  const L = ac.lengthM * k;
  const W = ac.wingspanM * k;
  const f = L * 0.06; // half the fuselage width
  // Drawn nose-up (screen −y) at the origin, the body along +y; turned clockwise by the heading.
  const local: ScreenPoint[] = [
    [0, 0],
    [f, L * 0.12],
    [f, L * 0.38],
    [W / 2, L * 0.58],
    [W / 2, L * 0.64],
    [f, L * 0.56],
    [f, L * 0.84],
    [W * 0.2, L * 0.96],
    [W * 0.2, L],
    [-W * 0.2, L],
    [-W * 0.2, L * 0.96],
    [-f, L * 0.84],
    [-f, L * 0.56],
    [-W / 2, L * 0.64],
    [-W / 2, L * 0.58],
    [-f, L * 0.38],
    [-f, L * 0.12],
  ];
  const rad = (ac.headingDeg * Math.PI) / 180;
  const [c, s] = [Math.cos(rad), Math.sin(rad)];
  return local.map(([lx, ly]) => [x + lx * c - ly * s, y + lx * s + ly * c]);
}

/** The screen box round the aircraft's shape as drawn (or its disc, with no heading). */
export function aircraftBox(ac: MapAircraft, view: Viewport): ScreenBox {
  const outline = aircraftOutline(ac, view);
  if (!outline) {
    const [x, y] = worldToScreen(view, ac.nose);
    const d = 2 * aircraftMarkerRadius(ac, view);
    return { x, y, widthPx: d, heightPx: d };
  }
  const xs = outline.map((p) => p[0]);
  const ys = outline.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, widthPx: x1 - x0, heightPx: y1 - y0 };
}

/** The disc drawn for an aircraft with no heading, px. */
export function aircraftMarkerRadius(ac: MapAircraft, view: Viewport): number {
  return (ac.lengthM * aircraftScale(ac, view)) / 3;
}
