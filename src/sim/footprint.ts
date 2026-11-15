// Aircraft footprints as shapes on the ground, for overlap: a collision is two footprints
// overlapping (PRD §4.8, §8.6). 1.12's collision check builds on this.
//
// A footprint is a rectangle, length × wingspan, with its front edge through the nose. It lies
// along the body's axis: the line from the tail (one length back along the track) to the nose.
// On a straight that's exact. Through a turn the rectangle is a rigid stand-in for a body that
// bends along the centreline, so it sweeps a little wider than the real aircraft.

import type { Point } from '../airport/types.ts';
import { pointOf } from './track.ts';
import type { Aircraft, Sim } from './world.ts';

/** The footprint's four corners: nose left, nose right, tail right, tail left. */
export function footprintOf(ac: Aircraft): Point[] {
  const nose = pointOf(ac.track, ac.s);
  const tail = pointOf(ac.track, ac.s - ac.lengthM).point;
  let [ux, uy] = [nose.point[0] - tail[0], nose.point[1] - tail[1]];
  let norm = Math.hypot(ux, uy);
  if (norm === 0) {
    // No trail to lie along (parked on a node with no edge): face the way the track goes, or north.
    const rad = ((nose.headingDeg ?? 0) * Math.PI) / 180;
    [ux, uy, norm] = [Math.sin(rad), Math.cos(rad), 1];
  }
  [ux, uy] = [ux / norm, uy / norm];
  // Right of the heading is (uy, −ux) in an x-east, y-north frame.
  const [rx, ry] = [(uy * ac.wingspanM) / 2, (-ux * ac.wingspanM) / 2];
  const [nx, ny] = nose.point;
  const [bx, by] = [nx - ux * ac.lengthM, ny - uy * ac.lengthM];
  return [
    [nx - rx, ny - ry],
    [nx + rx, ny + ry],
    [bx + rx, by + ry],
    [bx - rx, by - ry],
  ];
}

/** Whether two convex polygons overlap by more than touching (separating-axis test). */
export function polygonsOverlap(a: Point[], b: Point[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      if (!p || !q) throw new Error('polygon has a missing corner');
      const [ax, ay] = [q[1] - p[1], p[0] - q[0]];
      const project = (pts: Point[]) => pts.map(([x, y]) => x * ax + y * ay);
      const [pa, pb] = [project(a), project(b)];
      if (Math.max(...pa) <= Math.min(...pb) || Math.max(...pb) <= Math.min(...pa)) return false;
    }
  }
  return true;
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
