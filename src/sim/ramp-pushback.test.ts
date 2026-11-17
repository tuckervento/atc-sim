// Pushback on KJFK stays inside the ramp (Q, 2026-11-16, after the 1.13 run: "back up and turn
// the tail away from the exit until the nose is pointing the right way", never onto a taxiway,
// so every departure leaves the ramp nose first). PLAN 1.13b.

import { describe, expect, it } from 'vitest';
import kjfkAirport from '../../data/airports/KJFK.json' with { type: 'json' };
import kjfkOverrides from '../../data/airports/KJFK.overrides.json' with { type: 'json' };
import { indexAirport } from '../airport/graph.ts';
import { loadAirport } from '../airport/load.ts';
import { departurePlansFor } from './ramp.ts';
import { createSim } from './sim.ts';

const KJFK = indexAirport(loadAirport(kjfkAirport, kjfkOverrides));

describe('KJFK pushback never touches a taxiway', () => {
  it('every plan, at every gate, for the A320, B77W and B789: push and taxi-out on ramp lanes only, ending at a ramp handoff', () => {
    const sim = createSim(KJFK, { seed: 1 });
    const handoffNodes = new Set(KJFK.airport.rampHandoffs.map((h) => h.node));
    const offRamp: string[] = [];
    const notAtHandoff: string[] = [];
    for (const type of ['A320', 'B77W', 'B789'] as const) {
      for (const gate of KJFK.airport.gates) {
        const plans = departurePlansFor(sim, gate.id, type);
        if ('unable' in plans) continue;
        for (const plan of plans) {
          const edges = [...plan.push.edges, ...plan.out.edges].map((id) => KJFK.edges.get(id));
          const notLane = edges.filter((e) => e?.kind !== 'rampLane').map((e) => `${e?.name ?? '(unnamed)'} ${e?.kind}`);
          if (notLane.length > 0) offRamp.push(`${gate.terminal} ${gate.id} ${type}: ${[...new Set(notLane)].join(', ')}`);
          if (!handoffNodes.has(plan.out.nodes.at(-1) ?? '')) notAtHandoff.push(`${gate.terminal} ${gate.id} ${type}`);
        }
      }
    }
    expect(offRamp).toEqual([]);
    expect(notAtHandoff).toEqual([]);
  });
});
