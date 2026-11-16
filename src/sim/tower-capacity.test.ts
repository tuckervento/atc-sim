// A mixed runway's capacity (Q, 2026-11-15): with a full departure queue and 15 arrivals an
// hour, tower launches about one departure every 2 minutes. For 1 simulated hour, on KJFK 31L
// and TEST 27: ≥ 28 takeoffs (aiming for 30), ≥ 14 landings, and no go-arounds.
//
// The queue is kept full: whenever no ground aircraft is near its back, another departure
// appears there, cleared to the runway and handed to tower. Arrivals leave as soon as they call
// ground (as if taxied away), so exits stay free.

import { describe, expect, it } from 'vitest';
import kjfkBase from '../../data/airports/KJFK.json' with { type: 'json' };
import kjfkOverrides from '../../data/airports/KJFK.overrides.json' with { type: 'json' };
import testAirport from '../../data/airports/TEST.json' with { type: 'json' };
import { indexAirport, type AirportIndex } from '../airport/graph.ts';
import { loadAirport } from '../airport/load.ts';
import { addAircraft, applyCommand, createSim, drainEvents, listAircraft, removeAircraft, step } from './sim.ts';
import { parseTerse } from './terse.ts';

const TEST = indexAirport(loadAirport(testAirport));
const KJFK = indexAirport(loadAirport(kjfkBase, kjfkOverrides));

interface Queue {
  airport: AirportIndex;
  runwayEnd: string;
  /** The back of the departure queue: where each new departure appears. */
  node: string;
  arrivedVia: string;
  clearance: string;
}

const QUEUES: Record<string, Queue> = {
  // The back of the 31L line on Z (kjfk.test.ts).
  'KJFK 31L': { airport: KJFK, runwayEnd: '31L', node: 'n46547996', arrivedVia: 'w162541297-n46547996-n45355700', clearance: 'taxi 31L via Z, monitor tower' },
  // The back of 27's line on A, east of 18/36.
  'TEST 27': { airport: TEST, runwayEnd: '27', node: 'aP1', arrivedVia: 'aH2-aP1', clearance: 'taxi 27 via A, monitor tower' },
};

/** One simulated hour with the queue kept full and `perHour` arrivals: the runway's ops. */
function capacity(q: Queue, perHour: number, seed: number): { takeoffs: number; landings: number; goArounds: number } {
  const sim = createSim(q.airport, { seed, arrivals: [{ runwayEnd: q.runwayEnd, perHour, flight: (n) => ({ callsign: `AAL${n + 1}`, type: 'A321' }) }] });
  const back = q.airport.nodes.get(q.node);
  if (!back) throw new Error(`no node ${q.node}`);
  const counts = { takeoffs: 0, landings: 0, goArounds: 0 };
  let n = 0;
  for (let t = 0; t < 60 * 60 * 10; t++) {
    if (!listAircraft(sim).some((a) => !a.airborne && Math.hypot(a.nose[0] - back.x, a.nose[1] - back.y) < 120)) {
      const callsign = `JBU${++n}`;
      addAircraft(sim, { callsign, type: 'A320', at: { kind: 'node', node: q.node, arrivedVia: q.arrivedVia } });
      const parsed = parseTerse(`${callsign} ${q.clearance}`);
      if (!parsed.ok) throw new Error(parsed.error.message);
      applyCommand(sim, parsed.command);
    }
    step(sim, 1);
    for (const e of drainEvents(sim)) {
      if (e.type === 'clear-of-runway') removeAircraft(sim, e.callsign);
      if (e.type === 'took-off') counts.takeoffs++;
      if (e.type === 'landed') counts.landings++;
      if (e.type === 'go-around') counts.goArounds++;
    }
  }
  return counts;
}

describe('a mixed runway’s capacity (Q, 2026-11-15)', () => {
  for (const name of Object.keys(QUEUES)) {
    it(`acceptance: with a full departure queue and 15 arrivals an hour, ≥ 28 takeoffs and ≥ 14 landings an hour, no go-arounds — ${name}`, () => {
      const q = QUEUES[name];
      if (!q) throw new Error(name);
      for (const seed of [1, 2, 3]) {
        const got = capacity(q, 15, seed);
        console.info(`${name}, seed ${seed}, 15 arrivals an hour:`, JSON.stringify(got));
        expect(got.goArounds, `${name} seed ${seed}`).toBe(0);
        expect(got.landings, `${name} seed ${seed}`).toBeGreaterThanOrEqual(14);
        expect(got.takeoffs, `${name} seed ${seed}`).toBeGreaterThanOrEqual(28);
      }
    }, 30_000);
  }
});
