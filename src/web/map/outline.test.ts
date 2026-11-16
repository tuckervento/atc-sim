import { describe, expect, it } from 'vitest';
import testAirport from '../../../data/airports/TEST.json' with { type: 'json' };
import { indexAirport } from '../../airport/graph.ts';
import { loadAirport } from '../../airport/load.ts';
import { addAircraft, createSim, footprintOf, listAircraft } from '../../sim/sim.ts';
import { buildTrack } from '../../sim/track.ts';
import { fromAircraftView } from './aircraft.ts';
import { aircraftBox, aircraftOutline } from './outline.ts';
import { screenToWorld, type Viewport } from './view.ts';

/** Degrees clockwise from north, from `a` to `b`. */
function bearing(a: readonly number[], b: readonly number[]): number {
  return ((Math.atan2((b[0] ?? NaN) - (a[0] ?? NaN), (b[1] ?? NaN) - (a[1] ?? NaN)) * 180) / Math.PI + 360) % 360;
}

describe('aircraftOutline', () => {
  it("lies along the same axis as the sim's footprint in a 90° bend: nose at the nose, tail where the fuselage's tail is (TEST aE, true size)", () => {
    // TEST: A east to aE (1500, 200), then A9 south. An A320 (37.6 m) with its nose 10 m into the turn.
    const index = indexAirport(loadAirport(testAirport));
    const sim = createSim(index, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'node', node: 'aP2', arrivedVia: null } });
    const ac = sim.world.aircraft[0];
    if (!ac) throw new Error('not added');
    ac.track = buildTrack(index, ['aP2', 'aE', 'a9I'], ['aP2-aE', 'aE-a9I']);
    ac.s = 110;
    const [view] = listAircraft(sim);
    if (!view) throw new Error('no view');
    // 4 px/m: above MIN_AIRCRAFT_PX / length, so the shape is drawn at true size.
    const viewport: Viewport = { centerX: 1490, centerY: 200, scale: 4, widthPx: 800, heightPx: 600 };
    const outline = aircraftOutline(fromAircraftView(view, { destination: '31L', delayed: false }), viewport);
    if (!outline) throw new Error('drawn as a marker');
    const world = outline.map((p) => screenToWorld(viewport, p));

    // The shape is symmetric about its axis, nose first: the corners' mean is on the axis.
    const nose = world[0] ?? [NaN, NaN];
    const mean = [world.reduce((a, p) => a + p[0], 0) / world.length, world.reduce((a, p) => a + p[1], 0) / world.length];
    const drawnDeg = bearing(mean, nose);
    const rad = (drawnDeg * Math.PI) / 180;
    const drawnTail = [nose[0] - Math.sin(rad) * 37.6, nose[1] - Math.cos(rad) * 37.6];

    const [nl, nr, tr, tl] = footprintOf(ac).parts[0] ?? [];
    if (!nl || !nr || !tr || !tl) throw new Error('no fuselage');
    const fpNose = [(nl[0] + nr[0]) / 2, (nl[1] + nr[1]) / 2];
    const fpTail = [(tl[0] + tr[0]) / 2, (tl[1] + tr[1]) / 2];

    expect(nose[0]).toBeCloseTo(fpNose[0] ?? NaN, 6);
    expect(nose[1]).toBeCloseTo(fpNose[1] ?? NaN, 6);
    expect(drawnDeg).toBeCloseTo(bearing(fpTail, fpNose), 6);
    expect(drawnTail[0]).toBeCloseTo(fpTail[0] ?? NaN, 6);
    expect(drawnTail[1]).toBeCloseTo(fpTail[1] ?? NaN, 6);
    // And the drawing reaches exactly one length back along that axis.
    const along = Math.max(...world.map((p) => (nose[0] - p[0]) * Math.sin(rad) + (nose[1] - p[1]) * Math.cos(rad)));
    expect(along).toBeCloseTo(37.6, 6);
  });
});

describe('aircraftBox', () => {
  const viewport: Viewport = { centerX: 0, centerY: 0, scale: 2, widthPx: 800, heightPx: 600 };
  const a320 = (headingDeg: number | null) =>
    ({ callsign: 'DAL4', type: 'A320', nose: [10, 20], headingDeg, lengthM: 37.6, wingspanM: 35.8, role: 'departure', destination: '31L' }) as const;

  it('is the screen box round the shape as drawn, at any heading (what the labels it covers are hidden by)', () => {
    for (const heading of [0, 35, 90, 200]) {
      const outline = aircraftOutline({ ...a320(heading), nose: [10, 20] }, viewport) ?? [];
      const xs = outline.map((p) => p[0]);
      const ys = outline.map((p) => p[1]);
      const box = aircraftBox({ ...a320(heading), nose: [10, 20] }, viewport);
      expect(box.x).toBeCloseTo((Math.min(...xs) + Math.max(...xs)) / 2, 9);
      expect(box.y).toBeCloseTo((Math.min(...ys) + Math.max(...ys)) / 2, 9);
      expect(box.widthPx).toBeCloseTo(Math.max(...xs) - Math.min(...xs), 9);
      expect(box.heightPx).toBeCloseTo(Math.max(...ys) - Math.min(...ys), 9);
    }
  });

  it("is the marker disc's square with no heading", () => {
    // At 2 px/m an A320 is 75.2 px long; the disc at the nose has a radius of a third of that.
    expect(aircraftBox({ ...a320(null), nose: [10, 20] }, viewport)).toEqual({ x: 420, y: 260, widthPx: (2 * 75.2) / 3, heightPx: (2 * 75.2) / 3 });
  });
});
