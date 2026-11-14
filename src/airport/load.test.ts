import { describe, expect, it } from 'vitest';
import testAirport from '../../data/airports/TEST.json' with { type: 'json' };
import { AirportLoadError, loadAirport } from './load.ts';
import type { AirportOverrides } from './types.ts';
import { validateAirport } from './validate.ts';

/** The problems a failing load reports; fails the test if the load succeeds. */
function loadIssues(base: unknown, overrides?: unknown): string[] {
  try {
    loadAirport(base, overrides);
  } catch (e) {
    if (e instanceof AirportLoadError) return e.issues;
    throw e;
  }
  throw new Error('expected loadAirport to throw AirportLoadError');
}

const header = { formatVersion: 1, airport: 'TEST' } as const;

describe('loadAirport without overrides', () => {
  it('returns every item of the file, as a copy', () => {
    const before = JSON.stringify(testAirport);
    const a = loadAirport(testAirport);
    expect([a.nodes.length, a.edges.length, a.runways.length, a.gates.length]).toEqual([65, 74, 2, 5]);
    a.nodes.length = 0;
    expect(JSON.stringify(testAirport)).toBe(before);
  });
});

describe('overrides operations', () => {
  it('add appends new items at the end, in order', () => {
    const ov = {
      ...header,
      nodes: { add: [{ id: 'new1', x: 1, y: 2 }, { id: 'new2', x: 3, y: 4 }] },
    } satisfies AirportOverrides;
    const a = loadAirport(testAirport, ov);
    expect(a.nodes.length).toBe(67);
    expect(a.nodes.slice(-2)).toEqual([{ id: 'new1', x: 1, y: 2 }, { id: 'new2', x: 3, y: 4 }]);
  });

  it('replace swaps in the whole item at the same position', () => {
    const position = testAirport.gates.findIndex((g) => g.id === 'T1-1');
    const ov = {
      ...header,
      gates: { replace: [{ id: 'T1-1', name: '1A', terminal: 'T1', node: 'g1' }] },
    } satisfies AirportOverrides;
    const a = loadAirport(testAirport, ov);
    // headingDeg was in the base item and is gone: replace is whole-item.
    expect(a.gates[position]).toEqual({ id: 'T1-1', name: '1A', terminal: 'T1', node: 'g1' });
    expect(a.gates.length).toBe(5);
  });

  it('patch sets listed fields, removes fields set to null, and keeps the rest', () => {
    const ov = {
      ...header,
      edges: {
        patch: [
          { id: 'cHS-bC', closed: null },
          { id: 'aK-wpS', name: 'KK', closed: { reason: 'NOTAM' } },
        ],
      },
    } satisfies AirportOverrides;
    const a = loadAirport(testAirport, ov);
    expect(a.edges.find((e) => e.id === 'cHS-bC')).toEqual({ id: 'cHS-bC', kind: 'taxiway', name: 'C', from: 'cHS', to: 'bC' });
    expect(a.edges.find((e) => e.id === 'aK-wpS')).toEqual({
      id: 'aK-wpS', kind: 'taxiway', name: 'KK', from: 'aK', to: 'wpS', widthM: 23, closed: { reason: 'NOTAM' },
    });
  });

  it('remove deletes by id without cascading, so dangling references fail validation', () => {
    const ov = { ...header, nodes: { remove: ['g1'] } } satisfies AirportOverrides;
    const a = loadAirport(testAirport, ov);
    expect(a.nodes.some((n) => n.id === 'g1')).toBe(false);
    expect(a.gates.some((g) => g.id === 'T1-1')).toBe(true);
    const dangling = validateAirport(a).errors.filter((e) => e.code === 'unknown-reference').map((e) => e.ids[0]);
    expect(dangling).toEqual(['l7A-g1', 'T1-1']);
  });

  it('set replaces top-level fields, and null removes an optional one', () => {
    const ov = { ...header, set: { name: 'Renamed', source: null } } satisfies AirportOverrides;
    const a = loadAirport(testAirport, ov);
    expect(a.name).toBe('Renamed');
    expect('source' in a).toBe(false);
    expect(a.id).toBe('TEST');
  });

  it('applies operations on several collections together', () => {
    const ov = {
      ...header,
      gates: { remove: ['T2-B2'] },
      terminals: { patch: [{ id: 'T2', airlines: ['BAW'] }] },
      holdingAreas: { patch: [{ id: 'padWest', outline: null }] },
    } satisfies AirportOverrides;
    const a = loadAirport(testAirport, ov);
    expect(a.gates.map((g) => g.id)).toEqual(['T1-1', 'T1-2', 'T1-3', 'T2-B1']);
    expect(a.terminals.find((t) => t.id === 'T2')?.airlines).toEqual(['BAW']);
    expect(a.holdingAreas.find((h) => h.id === 'padWest')?.outline).toBeUndefined();
    expect(validateAirport(a).ok).toBe(true);
  });
});

describe('overrides fail loudly', () => {
  it('on ids that do not exist, for replace, patch and remove', () => {
    const issues = loadIssues(testAirport, {
      ...header,
      edges: {
        replace: [{ id: 'nope1', kind: 'taxiway', from: 'aW', to: 'aK' }],
        patch: [{ id: 'nope2', name: 'X' }],
        remove: ['nope3'],
      },
    });
    expect(issues).toEqual([
      'overrides.edges.remove[0]: no edge with id "nope3" in the base file',
      'overrides.edges.replace[0]: no edge with id "nope1" in the base file',
      'overrides.edges.patch[0]: no edge with id "nope2" in the base file',
    ]);
  });

  it('on adding an id that already exists', () => {
    expect(loadIssues(testAirport, { ...header, gates: { add: [{ id: 'T1-1', name: 'x', terminal: 'T1', node: 'g1' }] } })).toEqual([
      'overrides.gates.add[0]: a gate with id "T1-1" already exists in the base file; use replace or patch',
    ]);
  });

  it('on the same id in two operations', () => {
    expect(loadIssues(testAirport, { ...header, gates: { patch: [{ id: 'T1-1', name: 'x' }], remove: ['T1-1'] } })).toEqual([
      'overrides.gates.patch[0]: id "T1-1" already appears in overrides.gates.remove; each id may appear in only one operation per collection',
    ]);
  });

  it('on the wrong airport or format version', () => {
    expect(loadIssues(testAirport, { formatVersion: 2, airport: 'KJFK' })).toEqual([
      'overrides.formatVersion: expected 1, got 2',
      'overrides.airport: "KJFK" does not match the base file\'s id "TEST"',
    ]);
  });

  it('on unknown collections and operations', () => {
    expect(loadIssues(testAirport, { ...header, edgez: {}, edges: { update: [] } })).toEqual([
      'overrides: unknown field "edgez" (allowed: formatVersion, airport, description, set, nodes, edges, runways, runwayExits, holdShorts, rampHandoffs, terminals, gates, holdingAreas, departureLines, configurations, towerPositions, areas)',
      'overrides.edges: unknown field "update" (allowed: add, replace, patch, remove)',
    ]);
  });

  it('on a merged result with the wrong shape, naming the item', () => {
    const issues = loadIssues(testAirport, {
      ...header,
      edges: { patch: [{ id: 'aK-wpS', closd: { reason: 'typo' } }, { id: 'aW-aK', kind: 'taxilane' }] },
      terminals: { patch: [{ id: 'T1', name: null }] },
    });
    const at = (id: string) => testAirport.edges.findIndex((e) => e.id === id);
    expect(issues).toEqual([
      `edges[${at('aW-aK')}] ("aW-aK").kind: expected one of "runway", "taxiway", "rampLane", got "taxilane"`,
      `edges[${at('aK-wpS')}] ("aK-wpS"): unknown field "closd" (allowed: id, kind, from, to, name, runway, points, widthM, closed)`,
      'terminals[0] ("T1").name: missing (required string)',
    ]);
  });
});

describe('base file shape', () => {
  it('requires every collection, the format version and finite numbers', () => {
    const { gates: _gates, ...noGates } = testAirport;
    expect(loadIssues({ ...noGates, formatVersion: 2 })).toEqual([
      'airport.formatVersion: expected 1, got 2 (this code reads format version 1 only)',
      'airport.gates: missing (required array (may be empty))',
    ]);
    const badNode = { ...testAirport, nodes: [{ id: 'n', x: '1', y: null }] };
    expect(loadIssues(badNode)).toEqual([
      'nodes[0] ("n").x: expected a finite number, got "1"',
      'nodes[0] ("n").y: expected a finite number, got null',
    ]);
  });

  it('requires exactly two runway ends', () => {
    const [first, ...rest] = testAirport.runways;
    const oneEnd = { ...testAirport, runways: [{ ...first, ends: first?.ends.slice(0, 1) }, ...rest] };
    expect(loadIssues(oneEnd)).toEqual(['runways[0] ("9/27").ends: expected exactly 2 runway ends, got 1']);
  });

  it('rejects input that is not an object', () => {
    expect(loadIssues([])).toEqual(['base file: expected an object, got an array']);
    expect(loadIssues(testAirport, 'nope')).toEqual(['overrides: expected an object, got "nope"']);
  });
});
