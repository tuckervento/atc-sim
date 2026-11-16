// Drawing between sim ticks (PLAN 1.13). The sim moves in fixed 0.1 s ticks; a 60 Hz screen
// draws each aircraft part of the way from its state before the last tick to its state after,
// by the clock's alpha, so motion is smooth. Pure.

import type { MapAircraft } from '../map/aircraft.ts';

/**
 * `current`, in its order, with each aircraft moved `alpha` (0–1) of the way from its state in
 * `previous` toward its state in `current`.
 */
export function interpolateAircraft(previous: MapAircraft[], current: MapAircraft[], alpha: number): MapAircraft[] {
  const before = new Map(previous.map((a) => [a.callsign, a]));
  return current.map((now) => {
    const then = before.get(now.callsign);
    if (!then) return now;
    return {
      ...now,
      nose: [lerp(then.nose[0], now.nose[0], alpha), lerp(then.nose[1], now.nose[1], alpha)],
      headingDeg: then.headingDeg === null || now.headingDeg === null ? now.headingDeg : lerpHeading(then.headingDeg, now.headingDeg, alpha),
    };
  });
}

/** From `a` toward `b` the short way round, in [0, 360). */
function lerpHeading(a: number, b: number, t: number): number {
  const turn = ((((b - a) % 360) + 540) % 360) - 180;
  return (((a + turn * t) % 360) + 360) % 360;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
