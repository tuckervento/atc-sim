// The tower never puts two aircraft on a runway in conflict (PLAN 1.10 acceptance), across 50
// seeds on TEST and KJFK, and a long tower run is deterministic.
//
// A scripted ground "player" runs each session. It spawns departures and hands them to tower;
// spawns crossers that ask tower and cross only once approved; and taxis arrivals away (removes
// them) a seeded few seconds after they call. It never crosses without an approval, so every
// runway conflict would be tower's own doing.

import { describe, expect, it } from 'vitest';
import kjfkBase from '../../data/airports/KJFK.json' with { type: 'json' };
import kjfkOverrides from '../../data/airports/KJFK.overrides.json' with { type: 'json' };
import testAirport from '../../data/airports/TEST.json' with { type: 'json' };
import { indexAirport, type AirportIndex } from '../airport/graph.ts';
import { loadAirport } from '../airport/load.ts';
import type { RunwayId } from '../airport/types.ts';
import { addAircraft, applyCommand, createSim, drainEvents, footprintsOverlap, removeAircraft, stateHash, step, type ArrivalStream, type Sim } from './sim.ts';
import { parseTerse } from './terse.ts';

const TEST = indexAirport(loadAirport(testAirport));
const KJFK = indexAirport(loadAirport(kjfkBase, kjfkOverrides));

function transmit(sim: Sim, text: string): void {
  const result = parseTerse(text);
  if (!result.ok) throw new Error(`'${text}' doesn't parse: ${result.error.message}`);
  applyCommand(sim, result.command);
}

/** A ground flow the player runs: where its aircraft appear, and what they're told. */
interface Flow {
  prefix: string;
  type: string;
  at: { kind: 'node'; node: string; arrivedVia: string };
  /** The clearance given on spawn. */
  clearance: string;
  /** Mean seconds between spawns (± a third, from the seed). */
  everyS: number;
  /** For crossers: a node on the far side that must be clear before the player asks. */
  farSide?: string;
}

interface Scenario {
  airport: AirportIndex;
  streams: ArrivalStream[];
  flows: Flow[];
}

const arrivals = (runwayEnd: string, perHour: number, prefix: string, types: string[]): ArrivalStream => ({
  runwayEnd,
  perHour,
  flight: (n) => ({ callsign: `${prefix}${n + 1}`, type: types[n % types.length] ?? 'A320' }),
});

const TEST_WEST: Scenario = {
  airport: TEST,
  streams: [arrivals('27', 20, 'BAW', ['A320', 'B77W', 'E175', 'B738'])],
  flows: [
    // Departures east on A, across 36 at A (asking tower), into 27's line.
    { prefix: 'DAL', type: 'B738', at: { kind: 'node', node: 'aJ', arrivedVia: 'aTC-aJ' }, clearance: 'taxi 27 via A, monitor tower', everyS: 150 },
    // Crossers south on D, across 27, to the hardstand.
    { prefix: 'JBU', type: 'A320', at: { kind: 'node', node: 'dI', arrivedVia: 'aD-dI' }, clearance: 'taxi hardstand via D B G', everyS: 240, farSide: 'dHS' },
  ],
};

const KJFK_31S: Scenario = {
  airport: KJFK,
  streams: [arrivals('31L', 15, 'AAL', ['A321', 'B738', 'B77W']), arrivals('31R', 22, 'UAE', ['A388', 'A320', 'E175', 'B789'])],
  flows: [
    // Departures from the back of the 31L line on Z.
    { prefix: 'JBU', type: 'A320', at: { kind: 'node', node: 'n4057398125', arrivedVia: 'w162541297-n4057398125-n46547996' }, clearance: 'taxi 31L via Z, monitor tower', everyS: 150 },
    // Crossers east on A, right on KE across 13R/31L, to the Kilo pad.
    { prefix: 'DAL', type: 'B739', at: { kind: 'node', node: 'n13771028754', arrivedVia: 'w1356437398-n13771028753-n13771028754' }, clearance: 'taxi pad KILO via A R:KE K4 K', everyS: 240 },
  ],
};

interface Stats {
  landed: number;
  tookOff: number;
  approved: number;
  goArounds: number;
  /** Every runway conflict and overlap seen, as text. */
  conflicts: string[];
}

/** A cheap deterministic number in [0, 1) from integers, for the player's own choices. */
function hash01(...xs: number[]): number {
  let h = 2166136261;
  for (const x of xs) h = Math.imul(h ^ (x | 0), 16777619) >>> 0;
  return (h % 10007) / 10007;
}

/** Runs one session of `ticks` ticks. `check` turns on the per-tick conflict checks. */
function run(scenario: Scenario, seed: number, ticks: number, check: boolean): { sim: Sim; stats: Stats } {
  const sim = createSim(scenario.airport, { seed, arrivals: scenario.streams });
  const stats: Stats = { landed: 0, tookOff: 0, approved: 0, goArounds: 0, conflicts: [] };
  const next = scenario.flows.map((_, i) => Math.round(hash01(seed, i) * 600));
  const count = scenario.flows.map(() => 0);
  const removeAt = new Map<string, number>();
  /** Aircraft holding short of a runway, waiting for the player to ask. */
  const toAsk = new Set<string>();
  const flowOf = (callsign: string) => scenario.flows.find((f) => callsign.startsWith(f.prefix) && /\d$/.test(callsign));
  const near = (node: string, metres: number) => {
    const n = sim.index.nodes.get(node);
    if (!n) throw new Error(`no node ${node}`);
    return sim.world.aircraft.some((a) => !a.airborne && Math.hypot(nose(a)[0] - n.x, nose(a)[1] - n.y) < metres);
  };
  for (let t = 0; t < ticks; t++) {
    // The player: new aircraft, when there's room for them.
    scenario.flows.forEach((flow, i) => {
      if (sim.world.tick < (next[i] ?? 0) || near(flow.at.node, 120)) return;
      count[i] = (count[i] ?? 0) + 1;
      const callsign = `${flow.prefix}${count[i]}`;
      addAircraft(sim, { callsign, type: flow.type, at: flow.at });
      transmit(sim, `${callsign} ${flow.clearance}`);
      next[i] = sim.world.tick + Math.round(flow.everyS * (0.67 + 0.67 * hash01(seed, i, count[i] ?? 0)) * 10);
    });
    for (const callsign of toAsk) {
      const flow = flowOf(callsign);
      if (flow?.farSide !== undefined && near(flow.farSide, 120)) continue;
      transmit(sim, `${callsign} request-crossing`);
      toAsk.delete(callsign);
    }

    step(sim, 1);

    for (const e of drainEvents(sim)) {
      if (e.type === 'landed') stats.landed++;
      if (e.type === 'took-off') stats.tookOff++;
      if (e.type === 'go-around') stats.goArounds++;
      if (e.type === 'clear-of-runway') removeAt.set(e.callsign, sim.world.tick + 30 + Math.round(hash01(seed, sim.world.tick) * 400));
      if (e.type === 'holding-short' && e.runways.length > 0) toAsk.add(e.callsign);
      if (e.type === 'crossing-cancelled') toAsk.add(e.callsign);
      if (e.type === 'crossing-approved') {
        stats.approved++;
        transmit(sim, `${e.callsign} cross ${e.designators.join(' ')}`);
      }
      if (e.type === 'arrived' && e.destination.kind !== 'runway') removeAt.set(e.callsign, sim.world.tick);
      if (e.type === 'entered-runway' && !e.cleared) stats.conflicts.push(`${e.tick}: ${e.callsign} entered ${e.runways.join(' ')} uncleared`);
    }
    for (const [callsign, at] of removeAt) {
      if (sim.world.tick < at) continue;
      removeAircraft(sim, callsign);
      removeAt.delete(callsign);
    }
    if (check) stats.conflicts.push(...conflicts(sim));
  }
  return { sim, stats };
}

/** Tower movements sharing their runway's area with another ground aircraft, and overlaps involving tower's aircraft. */
function conflicts(sim: Sim): string[] {
  const found: string[] = [];
  const ground = sim.world.aircraft.filter((a) => !a.airborne);
  for (const ac of ground) {
    if (!['landing', 'lining-up', 'lined-up', 'taking-off'].includes(ac.status)) continue;
    const runway = towerRunway(sim, ac.callsign);
    for (const other of ground) {
      if (other !== ac && other.runways.includes(runway)) found.push(`${sim.world.tick}: ${ac.callsign} (${ac.status}) and ${other.callsign} (${other.status}) on ${runway}`);
    }
  }
  for (let i = 0; i < ground.length; i++) {
    for (let j = i + 1; j < ground.length; j++) {
      const [a, b] = [ground[i], ground[j]];
      if (!a || !b || (a.controller !== 'tower' && b.controller !== 'tower')) continue;
      if (footprintsOverlap(sim, a.callsign, b.callsign)) found.push(`${sim.world.tick}: ${a.callsign} and ${b.callsign} overlap`);
    }
  }
  return found;
}

function towerRunway(sim: Sim, callsign: string): RunwayId {
  const end = sim.world.tower.arrivals.find((a) => a.callsign === callsign)?.runwayEnd ?? sim.world.tower.departures.find((d) => d.callsign === callsign)?.runwayEnd;
  const runway = end === undefined ? undefined : sim.tower.ends.get(end)?.runway;
  if (runway === undefined) throw new Error(`${callsign}: not tower's`);
  return runway;
}

function nose(ac: Sim['world']['aircraft'][number]): [number, number] {
  const i = Math.max(0, ac.track.pointAt.findIndex((d) => d >= ac.s));
  const p = ac.track.points[i] ?? ac.track.points[0];
  return p ? [p[0], p[1]] : [0, 0];
}

const SESSION_TICKS = 20 * 60 * 10; // 20 simulated minutes

describe('runway safety', () => {
  for (const [name, scenario] of [['TEST (west flow: 27 mixed, crossings of 27 and 36)', TEST_WEST], ['KJFK (the 31s: 31L mixed, 31R arrivals, crossings of 31L at KE)', KJFK_31S]] as const) {
    it(`acceptance: across 50 seeds, tower's own actions never put two aircraft on a runway in conflict — ${name}`, () => {
      const started = Date.now();
      const totals = { landed: 0, tookOff: 0, approved: 0, goArounds: 0 };
      for (let seed = 1; seed <= 50; seed++) {
        const { stats } = run(scenario, seed, SESSION_TICKS, true);
        expect(stats.conflicts, `seed ${seed}`).toEqual([]);
        // Not vacuous: every session lands, launches and crosses.
        expect(stats.landed, `seed ${seed} landings`).toBeGreaterThan(0);
        expect(stats.tookOff, `seed ${seed} takeoffs`).toBeGreaterThan(0);
        expect(stats.approved, `seed ${seed} crossings`).toBeGreaterThan(0);
        totals.landed += stats.landed;
        totals.tookOff += stats.tookOff;
        totals.approved += stats.approved;
        totals.goArounds += stats.goArounds;
      }
      console.info(`${name}: 50 × 20 min in ${((Date.now() - started) / 1000).toFixed(1)} s;`, JSON.stringify(totals));
    }, 60_000);
  }
});

describe('determinism', () => {
  it('acceptance: the same seed and script give the same state hash after 20,000 ticks of arrivals, departures and crossings (TEST and KJFK)', () => {
    for (const scenario of [TEST_WEST, KJFK_31S]) {
      const first = run(scenario, 7, 20_000, false);
      const again = run(scenario, 7, 20_000, false);
      const other = run(scenario, 8, 20_000, false);
      const name = scenario.airport.airport.id;
      // A real session: it landed, launched and crossed.
      expect(first.stats.landed, name).toBeGreaterThan(5);
      expect(first.stats.tookOff, name).toBeGreaterThan(5);
      expect(first.stats.approved, name).toBeGreaterThan(5);
      expect(stateHash(again.sim), name).toBe(stateHash(first.sim));
      expect(stateHash(other.sim), name).not.toBe(stateHash(first.sim));
    }
  }, 60_000);
});
