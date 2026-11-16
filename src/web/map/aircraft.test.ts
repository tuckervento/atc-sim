import { describe, expect, it } from 'vitest';
import testAirport from '../../../data/airports/TEST.json' with { type: 'json' };
import { indexAirport } from '../../airport/graph.ts';
import { loadAirport } from '../../airport/load.ts';
import { addAircraft, createSim, listAircraft } from '../../sim/sim.ts';
import { buildTrack } from '../../sim/track.ts';
import { fromAircraftView } from './aircraft.ts';

describe('fromAircraftView', () => {
  it("takes callsign, type, nose, heading, size and role from the sim's view, and the destination from the caller", () => {
    const sim = createSim(indexAirport(loadAirport(testAirport)), { seed: 1 });
    addAircraft(sim, { callsign: 'UAL9', type: 'A320', role: 'arrival', at: { kind: 'node', node: 'rb7', arrivedVia: 'rb7-l7A' } });
    const [view] = listAircraft(sim);
    if (!view) throw new Error('the sim lists no aircraft');
    expect(view.headingDeg).not.toBeNull();

    const ac = fromAircraftView(view, { destination: 'T2', delayed: false });

    expect(ac).toEqual({
      callsign: 'UAL9',
      type: 'A320',
      nose: view.nose,
      headingDeg: view.headingDeg,
      lengthM: 37.6,
      wingspanM: 35.8,
      role: 'arrival',
      destination: 'T2',
    });
    // A copy: the renderer never holds the sim's own arrays.
    expect(ac.nose).not.toBe(view.nose);
  });

  it("draws the body along its axis from the main gear (the view's bodyHeadingDeg), not the track's heading at the nose: they differ in a bend", () => {
    // TEST: A east to aE (1500, 200), then A9 south. The nose 10 m into the turn.
    const index = indexAirport(loadAirport(testAirport));
    const sim = createSim(index, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'node', node: 'aP2', arrivedVia: null } });
    const ac = sim.world.aircraft[0];
    if (!ac) throw new Error('not added');
    ac.track = buildTrack(index, ['aP2', 'aE', 'a9I'], ['aP2-aE', 'aE-a9I']);
    ac.s = 110;
    const [view] = listAircraft(sim);
    if (!view || view.bodyHeadingDeg === null) throw new Error('no heading');
    expect(view.bodyHeadingDeg).not.toBeCloseTo(view.headingDeg ?? NaN, 0);

    expect(fromAircraftView(view, { destination: '31L', delayed: false }).headingDeg).toBe(view.bodyHeadingDeg);
  });

  it("shows a delayed aircraft as delayed, whatever the sim's role (the sim doesn't track delay yet)", () => {
    const sim = createSim(indexAirport(loadAirport(testAirport)), { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', role: 'departure', at: { kind: 'node', node: 'rb7', arrivedVia: 'rb7-l7A' } });
    const [view] = listAircraft(sim);
    if (!view) throw new Error('the sim lists no aircraft');

    expect(fromAircraftView(view, { destination: '27', delayed: true }).role).toBe('delayed');
  });
});
