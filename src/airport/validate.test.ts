import { describe, expect, it } from 'vitest';
import testAirport from '../../data/airports/TEST.json' with { type: 'json' };
import disconnectedTaxiway from './__fixtures__/disconnected-taxiway.overrides.json' with { type: 'json' };
import orphanHoldShort from './__fixtures__/orphan-hold-short.overrides.json' with { type: 'json' };
import unreachableGate from './__fixtures__/unreachable-gate.overrides.json' with { type: 'json' };
import { indexAirport } from './graph.ts';
import { loadAirport } from './load.ts';
import { rampReach, validateAirport, type ValidationIssue } from './validate.ts';

const format = (issues: ValidationIssue[]) => issues.map((i) => `${i.code}: ${i.message}`);
const codes = (issues: ValidationIssue[]) => issues.map((i) => i.code);

describe('TEST airport', () => {
  it('loads and passes validation with no errors or warnings', () => {
    const result = validateAirport(loadAirport(testAirport));
    expect(format(result.errors)).toEqual([]);
    expect(format(result.warnings)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  const airport = loadAirport(testAirport);
  const index = indexAirport(airport);

  it('has every gate reachable from a ramp entrance serving its terminal, and able to reach a ramp edge', () => {
    expect(airport.gates.length).toBeGreaterThanOrEqual(4);
    expect(new Set(airport.gates.map((g) => g.terminal)).size).toBe(2);
    const serves = (terminals: string[] | undefined, t: string) => terminals === undefined || terminals.includes(t);
    for (const gate of airport.gates) {
      const entrances = airport.rampHandoffs.filter((h) => h.use !== 'departures' && serves(h.terminals, gate.terminal));
      const edges = airport.rampHandoffs.filter((h) => h.use !== 'arrivals' && serves(h.terminals, gate.terminal));
      expect(entrances.some((h) => rampReach(index, h.node).has(gate.node)), `${gate.id} from an entrance`).toBe(true);
      expect(edges.some((h) => rampReach(index, h.node).has(gate.node)), `${gate.id} to a ramp edge`).toBe(true);
    }
  });

  it('has every runway hold-short tied to at least one existing runway, with all four kinds present', () => {
    const runwayIds = new Set(airport.runways.map((r) => r.id));
    for (const h of airport.holdShorts) {
      if (h.kind === 'intermediate') {
        expect(h.runways, h.id).toEqual([]);
      } else {
        expect(h.runways.length, h.id).toBeGreaterThanOrEqual(1);
        for (const r of h.runways) expect(runwayIds.has(r), `${h.id} → ${r}`).toBe(true);
      }
    }
    expect(new Set(airport.holdShorts.map((h) => h.kind))).toEqual(new Set(['runway', 'ils', 'lahso', 'intermediate']));
    // The hold on J, next to the runway intersection, protects both runways.
    expect(airport.holdShorts.find((h) => h.id === 'hJ')?.runways).toEqual(['9/27', '18/36']);
  });

  it('has every departure line with at least one exit, and 27 with two in order', () => {
    expect(airport.departureLines.length).toBeGreaterThanOrEqual(1);
    for (const line of airport.departureLines) expect(line.exits.length, line.id).toBeGreaterThanOrEqual(1);
    expect(airport.departureLines.find((l) => l.runwayEnd === '27')?.exits.map((x) => x.taxiway)).toEqual(['P1', 'P2']);
  });

  it('has a configuration where one runway takes arrivals and departures', () => {
    expect(airport.configurations.length).toBeGreaterThanOrEqual(2);
    const west = airport.configurations.find((c) => c.id === 'west');
    expect(west?.runways.find((u) => u.end === '27')?.roles).toEqual(['arrivals', 'departures']);
  });

  it('has a numeric ramp lane, check-in names, a closed segment, a pad and a penalty box', () => {
    expect(airport.edges.some((e) => e.kind === 'rampLane' && e.name === '7')).toBe(true);
    expect(airport.rampHandoffs.map((h) => h.name)).toEqual(['7', 'TB', 'TC']);
    expect(airport.edges.filter((e) => e.closed).map((e) => e.id)).toEqual(['cHS-bC']);
    expect(new Set(airport.holdingAreas.map((h) => h.kind))).toEqual(new Set(['pad', 'penaltyBox']));
  });
});

describe('checks (one change to TEST each)', () => {
  const check = (overrides: Record<string, unknown>) =>
    validateAirport(loadAirport(testAirport, { formatVersion: 1, airport: 'TEST', ...overrides }));

  it('rejects a departure line with no exits', () => {
    const r = check({ departureLines: { patch: [{ id: 'line9', exits: [] }] } });
    expect(codes(r.errors)).toEqual(['departure-line-no-exits']);
    expect(r.errors[0]?.message).toContain('departure line "line9" (runway 9) has no exits');
  });

  it('rejects departure-line exits listed out of order', () => {
    const line = testAirport.departureLines.find((l) => l.id === 'line27');
    const r = check({ departureLines: { patch: [{ id: 'line27', exits: [...(line?.exits ?? [])].reverse() }] } });
    expect(codes(r.errors)).toEqual(['departure-line-exits-out-of-order']);
  });

  it('rejects a departure-line exit that leads onto the runway', () => {
    const line = testAirport.departureLines.find((l) => l.id === 'line27');
    const exits = [...(line?.exits ?? []), { taxiway: 'A9', node: 'a9H', edge: 'a9H-r1E' }];
    const r = check({ departureLines: { patch: [{ id: 'line27', exits }] } });
    expect(codes(r.errors)).toEqual(['departure-line-exit-onto-runway']);
  });

  it('rejects a way onto a runway with no runway hold-short', () => {
    const r = check({ holdShorts: { remove: ['hCN'] } });
    expect(codes(r.errors)).toEqual(['runway-entry-unprotected']);
    expect(r.errors[0]?.ids).toEqual(['9/27', 'cHN-r1C']);
  });

  it('rejects a hold-short on the centerline of the runway it protects', () => {
    const r = check({ holdShorts: { patch: [{ id: 'hCN', node: 'r1C', towardEdge: 'r1C-rX' }] } });
    expect(codes(r.errors)).toEqual(['hold-short-on-runway', 'runway-entry-unprotected']);
  });

  it('rejects a hold-short naming a runway that does not exist', () => {
    const r = check({ holdShorts: { patch: [{ id: 'hF', runways: ['99/27'] }] } });
    expect(codes(r.errors)).toEqual(['unknown-reference', 'runway-entry-unprotected']);
    expect(r.errors[0]?.message).toBe('hold-short "hF" refers to unknown runway "99/27"');
  });

  it('rejects an intermediate hold that lists runways', () => {
    const r = check({ holdShorts: { patch: [{ id: 'hDI', runways: ['9/27'] }] } });
    expect(codes(r.errors)).toEqual(['hold-short-intermediate-with-runway']);
  });

  it('ignores closed edges for reachability: closing ramp lane 7 strands T1', () => {
    const r = check({ edges: { patch: [{ id: 'rb7-l7A', closed: { reason: 'test' } }] } });
    expect(codes(r.errors)).toEqual(['disconnected-network', 'gate-unreachable', 'gate-unreachable', 'gate-unreachable']);
    expect(r.errors[0]?.message).toContain('only through closed edge(s) "rb7-l7A"');
    expect(r.errors.slice(1).map((e) => e.ids[0])).toEqual(['T1-1', 'T1-2', 'T1-3']);
  });

  it('rejects a broken runway centerline', () => {
    const r = check({ edges: { remove: ['r1D-r1C'] } });
    expect(codes(r.errors)).toEqual(['runway-centerline-invalid']);
    expect(r.errors[0]?.message).toContain('stops at node "r1D"');
  });

  it('rejects a runway exit whose name does not match its edge', () => {
    const r = check({ runwayExits: { patch: [{ id: 'x27C', taxiway: 'D' }] } });
    expect(codes(r.errors)).toEqual(['runway-exit-name-mismatch']);
  });

  it('rejects runway designators with a leading zero (FAA style, as the terse parser writes them)', () => {
    const r = check({ runways: { patch: [{ id: '18/36', ends: [{ designator: '18', node: 'r2N' }, { designator: '036', node: 'r2S' }] }] } });
    expect(codes(r.errors)).toContain('runway-designator-invalid');
  });

  it('rejects a configuration that uses both ends of one runway', () => {
    const r = check({ configurations: { patch: [{ id: 'east', runways: [{ end: '9', roles: ['departures'] }, { end: '27', roles: ['arrivals'] }] }] } });
    expect(codes(r.errors)).toEqual(['configuration-runway-repeated']);
  });

  it('rejects a configuration landing on an end with no exits, or on an unknown end', () => {
    const noExits = check({ configurations: { patch: [{ id: 'west', runways: [{ end: '27', roles: ['arrivals', 'departures'] }, { end: '36', roles: ['arrivals'], arrivalExits: [] }] }] } });
    expect(codes(noExits.errors)).toEqual(['configuration-arrival-end-without-exits']);
    const unknown = check({ configurations: { patch: [{ id: 'west', runways: [{ end: '31L', roles: ['arrivals', 'departures'] }] }] } });
    expect(codes(unknown.errors)).toEqual(['unknown-reference']);
  });

  it('rejects a default configuration that does not exist', () => {
    const r = check({ set: { defaultConfiguration: 'north' } });
    expect(codes(r.errors)).toEqual(['unknown-reference']);
    expect(r.errors[0]?.message).toContain('defaultConfiguration refers to unknown configuration "north"');
  });

  it('warns when there are configurations but no default', () => {
    const r = check({ set: { defaultConfiguration: null } });
    expect(format(r.errors)).toEqual([]);
    expect(codes(r.warnings)).toEqual(['no-default-configuration']);
    expect(r.ok).toBe(true);
  });

  it('rejects duplicate ids in a base file', () => {
    const first = testAirport.nodes[0];
    const r = validateAirport(loadAirport({ ...testAirport, nodes: [...testAirport.nodes, first] }));
    expect(codes(r.errors)).toEqual(['duplicate-id']);
    expect(r.errors[0]?.ids).toEqual(['r1W']);
  });
});

describe('broken fixtures', () => {
  it('rejects a disconnected taxiway, naming it', () => {
    const result = validateAirport(loadAirport(testAirport, disconnectedTaxiway));
    expect(codes(result.errors)).toEqual(['disconnected-network']);
    expect(result.errors[0]?.message).toContain('taxiway "Z"');
    expect(result.errors[0]?.ids).toEqual(['zW-zE']);
    expect(format(result.warnings)).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it('rejects an orphan hold-short (no runway), naming it', () => {
    const result = validateAirport(loadAirport(testAirport, orphanHoldShort));
    expect(codes(result.errors)).toEqual(['hold-short-no-runway']);
    expect(result.errors[0]?.message).toContain('hold-short "hOrphan"');
    expect(format(result.warnings)).toEqual([]);
  });

  it('rejects an unreachable gate, naming it and the undeclared boundary', () => {
    const result = validateAirport(loadAirport(testAirport, unreachableGate));
    expect(codes(result.errors)).toEqual(['gate-unreachable']);
    expect(result.errors[0]?.message).toContain('gate "T2-U1"');
    expect(result.errors[0]?.message).toContain('"aJ"');
    expect(codes(result.warnings)).toEqual(['ramp-boundary-undeclared']);
    expect(result.warnings[0]?.ids).toEqual(['aJ']);
  });
});
