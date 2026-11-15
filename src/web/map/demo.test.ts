import { describe, expect, it } from 'vitest';
import { indexAirport } from '../../airport/graph.ts';
import { AIRCRAFT_ROLES } from './aircraft.ts';
import { loadMapAirport } from './airports.ts';
import { DEMO_TRAFFIC, demoAircraft } from './demo.ts';

describe('demoAircraft', () => {
  it.each(Object.keys(DEMO_TRAFFIC))('places %s demo traffic through the sim, covering every role', async (id) => {
    const index = indexAirport(await loadMapAirport(id));
    const aircraft = demoAircraft(id, index);
    expect(aircraft.map((a) => a.callsign)).toEqual(DEMO_TRAFFIC[id]?.map((d) => d.spec.callsign));
    expect(new Set(aircraft.map((a) => a.role))).toEqual(new Set(AIRCRAFT_ROLES));
    for (const a of aircraft) expect(a.destination).not.toBe('');
  });

  it('has demo traffic for KJFK, and none for an airport without any', () => {
    expect(Object.keys(DEMO_TRAFFIC)).toContain('KJFK');
    expect(demoAircraft('KXYZ', indexAirport({ ...emptyAirport() }))).toEqual([]);
  });
});

function emptyAirport() {
  return {
    formatVersion: 1 as const,
    id: 'KXYZ',
    name: 'Empty',
    reference: { lat: 0, lon: 0 },
    nodes: [],
    edges: [],
    runways: [],
    runwayExits: [],
    holdShorts: [],
    rampHandoffs: [],
    terminals: [],
    gates: [],
    holdingAreas: [],
    hangars: [],
    departureLines: [],
    configurations: [],
    towerPositions: [],
    areas: [],
  };
}
