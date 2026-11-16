// Aircraft footprints as shapes on the ground, for overlap: a collision is two footprints
// overlapping (PRD §4.8, §8.6). 1.12's collision check builds on this.
//
// A footprint is the aircraft's plan shape as a cross of three rectangles (Q's decision in
// cycle 9: span × length boxes flagged collisions between aircraft that wouldn't touch, e.g. a
// queued follower's nose by the empty corner of a leader that had turned):
// - the fuselage: the whole length, FUSELAGE_WIDTH × length wide, its front edge through the nose;
// - the wing: the whole span, from WING_FROM × length behind the nose, WING_CHORD × span deep;
// - the tailplane: TAIL_SPAN × span across, the last TAIL_CHORD × length of the body.
// They lie along the body's axis (bodyAxisOf): from the main gear, a point on the track
// MAIN_GEAR_FROM of the length behind the nose, to the nose, and on back from the nose for the
// whole length. On a straight that's the track. Through a turn the nose gear steers along the
// centreline and the body pivots about its main gear, so the tail swings out a little (Q,
// 2026-11-16: before, the map turned the body about the nose and this shape lay along the
// nose-to-tail chord, so the two disagreed in every turn). The sim's view (bodyHeadingDeg) and
// the map use the same axis.
//
// MAIN_GEAR_FROM 0.48: the published main-gear positions are 0.471 (A320) to 0.494 (A321) of
// the length (aircraft-types.ts has each, with its source). One fraction for every type,
// because a footprint knows only a body's length and span.
//
// Values [Builder], mine: proportions of the length and span (aircraft-types.ts), since that's
// all a footprint knows (the reservations ask for bodies by length and span alone). Each part
// is meant to cover the real one, not to fit it: a rectangle across a swept wing is mostly
// wing, with empty corners. The figures behind them are as I recall them, not checked against
// the manufacturers' airport planning documents:
// - FUSELAGE_WIDTH 0.11: fuselage widths are 0.084–0.105 of the length (A320 3.95 m, 737
//   3.76 m, E175 3.01 m, 777 6.20 m, A380 7.14 m). 0.11 is above all of them.
// - WING_FROM 0.30, WING_CHORD 0.40: the wing root's leading edge is about a third of the length
//   behind the nose, and the engine inlets a few metres ahead of it. Swept back 25–34°, the tips'
//   trailing edges are 0.6 (A320, 737) to 0.72 (A380) of the length back, about 0.36 of the span
//   behind the root's leading edge. So 0.30 of the length to 0.40 of the span behind that: an
//   A320's wing box is 11.3–25.6 m behind the nose, a B77W's 22.2–48.1 m, an A388's 21.8–53.7 m.
// - TAIL_SPAN 0.40, TAIL_CHORD 0.20: tailplane spans are 0.33–0.40 of the wingspan (A320
//   12.45 m, 737 14.35 m, 777 21.5 m, A380 30.4 m), and the tailplane sits in about the last
//   fifth of the length.
// The vertical fin is above the fuselage, inside its width.

import type { Point } from '../airport/types.ts';
import { pointOf, type Track } from './track.ts';
import type { Aircraft, Sim } from './world.ts';

/** How far the main gear is behind the nose, as a fraction of the length (the body's pivot). */
export const MAIN_GEAR_FROM = 0.48;

/**
 * The body's axis with the nose at `s` on `track`: from the main gear (on the track,
 * MAIN_GEAR_FROM × `lengthM` behind the nose) to the nose. `u` is the unit vector along it, nose
 * forward, x east and y north. With no length between the two (the trail runs out, or a one-node
 * track): the track's heading at the nose, or north with none; `headingDeg` is then null only
 * when the track has no heading at all.
 */
export function bodyAxisOf(track: Track, s: number, lengthM: number): { nose: Point; u: [number, number]; headingDeg: number | null } {
  const nose = pointOf(track, s);
  const gear = pointOf(track, s - MAIN_GEAR_FROM * lengthM).point;
  const [dx, dy] = [nose.point[0] - gear[0], nose.point[1] - gear[1]];
  const norm = Math.hypot(dx, dy);
  if (norm === 0) {
    const rad = ((nose.headingDeg ?? 0) * Math.PI) / 180;
    return { nose: nose.point, u: [Math.sin(rad), Math.cos(rad)], headingDeg: nose.headingDeg };
  }
  return { nose: nose.point, u: [dx / norm, dy / norm], headingDeg: ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360 };
}

/** Fuselage width, as a fraction of the length. */
export const FUSELAGE_WIDTH = 0.11;
/** How far the wing box starts behind the nose, as a fraction of the length. */
export const WING_FROM = 0.3;
/** The wing box's depth, nose to tail, as a fraction of the span. */
export const WING_CHORD = 0.4;
/** The tailplane box's span, as a fraction of the wingspan. */
export const TAIL_SPAN = 0.4;
/** The tailplane box's depth, at the tail end, as a fraction of the length. */
export const TAIL_CHORD = 0.2;

/**
 * A footprint: every corner of its parts, together (for a bounding box, a hull or a centre), and
 * the parts themselves, each a convex quadrilateral: fuselage, wing, tailplane.
 */
export type FootprintShape = Point[] & { readonly parts: readonly Point[][] };

/**
 * The footprint (above). Each part's corners go nose left, nose right, tail right, tail left;
 * the list is the fuselage's four, then the wing's, then the tailplane's.
 */
export function footprintOf(ac: Aircraft): FootprintShape {
  const { lengthM: length, wingspanM: span } = ac;
  const axis = bodyAxisOf(ac.track, ac.s, length);
  const [ux, uy] = axis.u;
  const [nx, ny] = axis.nose;
  /** A box `back0` to `back1` behind the nose, `width` across the axis. */
  const box = (back0: number, back1: number, width: number): Point[] => {
    // Right of the heading is (uy, −ux) in an x-east, y-north frame.
    const [rx, ry] = [(uy * width) / 2, (-ux * width) / 2];
    const [fx, fy] = [nx - ux * back0, ny - uy * back0];
    const [bx, by] = [nx - ux * back1, ny - uy * back1];
    return [
      [fx - rx, fy - ry],
      [fx + rx, fy + ry],
      [bx + rx, by + ry],
      [bx - rx, by - ry],
    ];
  };
  const wingFrom = WING_FROM * length;
  const parts = [box(0, length, FUSELAGE_WIDTH * length), box(wingFrom, wingFrom + WING_CHORD * span, span), box((1 - TAIL_CHORD) * length, length, TAIL_SPAN * span)];
  return Object.assign(parts.flat(), { parts });
}

/**
 * Whether two shapes overlap by more than touching: footprints (footprintOf) part by part, any
 * part of one with any part of the other; anything else as a convex polygon (separating-axis
 * test). Throws for a polygon that isn't convex: a footprint's corners without its parts.
 */
export function polygonsOverlap(a: readonly Point[], b: readonly Point[]): boolean {
  const pa = partsOf(a);
  const pb = partsOf(b);
  return pa.some((x) => pb.some((y) => convexOverlap(x, y)));
}

function partsOf(shape: readonly Point[]): readonly (readonly Point[])[] {
  if ('parts' in shape) return (shape as FootprintShape).parts;
  if (!isConvex(shape)) throw new Error(`polygonsOverlap: a ${shape.length}-corner polygon that isn't convex (a footprint's corners without its parts?)`);
  return [shape];
}

/** Whether the corners, in order, turn the same way all round (straight runs allowed). */
function isConvex(poly: readonly Point[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const [p, q, r] = [poly[i], poly[(i + 1) % poly.length], poly[(i + 2) % poly.length]];
    if (!p || !q || !r) throw new Error('polygon has a missing corner');
    const cross = (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]);
    if (Math.abs(cross) < 1e-9) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

/** Separating-axis test for two convex polygons: no edge's normal separates them. */
function convexOverlap(a: readonly Point[], b: readonly Point[]): boolean {
  return !separatedByEdgeOf(a, a, b) && !separatedByEdgeOf(b, a, b);
}

/** Whether a normal of one of `poly`'s edges separates `a` from `b` (touching counts as separate). */
function separatedByEdgeOf(poly: readonly Point[], a: readonly Point[], b: readonly Point[]): boolean {
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    if (!p || !q) throw new Error('polygon has a missing corner');
    const [ax, ay] = [q[1] - p[1], p[0] - q[0]];
    let [aMin, aMax, bMin, bMax] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const [x, y] of a) {
      const d = x * ax + y * ay;
      if (d < aMin) aMin = d;
      if (d > aMax) aMax = d;
    }
    for (const [x, y] of b) {
      const d = x * ax + y * ay;
      if (d < bMin) bMin = d;
      if (d > bMax) bMax = d;
    }
    if (aMax <= bMin || bMax <= aMin) return true;
  }
  return false;
}

/** Whether the footprints of the aircraft with callsigns `a` and `b` overlap. Throws if either doesn't exist. */
export function footprintsOverlap(sim: Sim, a: string, b: string): boolean {
  return polygonsOverlap(footprintOf(find(sim, a)), footprintOf(find(sim, b)));
}

function find(sim: Sim, callsign: string): Aircraft {
  const ac = sim.world.aircraft.find((x) => x.callsign === callsign);
  if (!ac) throw new Error(`no aircraft ${callsign}`);
  return ac;
}
