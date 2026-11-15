// Mock traffic for the map until the sim runs in the browser (PLAN 1.13). Real sim aircraft,
// placed with createSim/addAircraft on real node and edge ids, with the sim's own roles; only
// the destination and the delayed flag are made up here (the sim doesn't track delay yet).

import type { AirportIndex } from '../../airport/graph.ts';
import { addAircraft, createSim, listAircraft, type AircraftSpec } from '../../sim/sim.ts';
import { fromAircraftView, type MapAircraft } from './aircraft.ts';

export interface DemoAircraft {
  spec: AircraftSpec;
  destination: string;
  delayed: boolean;
}

/** Per airport id. An airport not listed shows no aircraft. */
export const DEMO_TRAFFIC: Record<string, DemoAircraft[]> = {
  // Ids from sim.test.ts.
  TEST: [
    { spec: { callsign: 'DAL4', type: 'A320', role: 'departure', at: { kind: 'node', node: 'rb7', arrivedVia: 'rb7-l7A' } }, destination: '27', delayed: false },
    { spec: { callsign: 'UAL9', type: 'B738', role: 'arrival', at: { kind: 'node', node: 'aJ', arrivedVia: 'aTC-aJ' } }, destination: 'T2', delayed: false },
    { spec: { callsign: 'AFR23', type: 'A359', role: 'departure', at: { kind: 'node', node: 'a7', arrivedVia: 'aK-a7' } }, destination: '27', delayed: true },
  ],
  // Land 31L and 31R, depart 31L (the "31s", KJFK's default configuration).
  KJFK: [
    // Parked at Terminal 4 gate B25, nose in along its lead-in.
    { spec: { callsign: 'DAL4', type: 'B739', role: 'departure', terminal: 'T4', at: { kind: 'node', node: 'n6965046827', arrivedVia: 'w744203516-n6965046847-n6965046827' } }, destination: '31L', delayed: false },
    // In the 31L departure line on Z.
    { spec: { callsign: 'JBU1123', type: 'A320', role: 'departure', at: { kind: 'edge', edge: 'w162541291-n4068921630-n10709945044', from: 'n4068921630', distanceM: 150 } }, destination: '31L', delayed: false },
    // Just off 31L at Mike Bravo.
    { spec: { callsign: 'UAE202', type: 'A388', role: 'arrival', at: { kind: 'edge', edge: 'w5786235-n4058790036-n13771028756', from: 'n4058790036', distanceM: 40 } }, destination: 'T4', delayed: false },
    // Taxiing in on B.
    { spec: { callsign: 'AAL100', type: 'B77W', role: 'arrival', at: { kind: 'edge', edge: 'w5786355-n45298966-n4058789613', from: 'n45298966', distanceM: 200 } }, destination: 'T8', delayed: false },
    // A departure parked on the Kilo pad.
    { spec: { callsign: 'AFR23', type: 'A359', role: 'departure', at: { kind: 'node', node: 'xkS1', arrivedVia: 'xk-xkL1-xkS1' } }, destination: '31L', delayed: true },
    // An arrival waiting for its gate in the penalty box.
    { spec: { callsign: 'KAL82', type: 'B77W', role: 'arrival', at: { kind: 'node', node: 'n14158137951', arrivedVia: 'w1556624934-n14158137945-n14158137951' } }, destination: 'T1', delayed: true },
  ],
};

/** The demo traffic for `airportId`, placed by a fresh sim on `index`. Throws if an id isn't on the airport. */
export function demoAircraft(airportId: string, index: AirportIndex): MapAircraft[] {
  const traffic = DEMO_TRAFFIC[airportId] ?? [];
  const sim = createSim(index, { seed: 1 });
  for (const d of traffic) addAircraft(sim, d.spec);
  return listAircraft(sim).map((view) => {
    const d = traffic.find((t) => t.spec.callsign === view.callsign);
    if (!d) throw new Error(`demo: the sim lists ${view.callsign}, which isn't in the demo traffic`);
    return fromAircraftView(view, { destination: d.destination, delayed: d.delayed });
  });
}
