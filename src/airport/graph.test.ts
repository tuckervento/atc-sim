import { describe, expect, it } from 'vitest';
import kjfkAirport from '../../data/airports/KJFK.json' with { type: 'json' };
import kjfkOverrides from '../../data/airports/KJFK.overrides.json' with { type: 'json' };
import testAirport from '../../data/airports/TEST.json' with { type: 'json' };
import { indexAirport, junctionName } from './graph.ts';
import { loadAirport } from './load.ts';

const TEST = indexAirport(loadAirport(testAirport));
const KJFK = indexAirport(loadAirport(kjfkAirport, kjfkOverrides));

describe('junctionName: a node as a player can find it on the map (no node ids)', () => {
  it('names a junction by the taxiways that meet there', () => {
    expect(junctionName(TEST, 'aC')).toBe('A/C');
    expect(junctionName(KJFK, 'n45349123')).toBe('B/MB/P');
    expect(junctionName(KJFK, 'n1743999301')).toBe('A/MB/Q');
  });

  it('adds the runway when the junction is on one', () => {
    expect(junctionName(KJFK, 'n45293435')).toBe('C1/U1 (runway 13L/31R)');
  });

  it('names a node on one taxiway by its side of the nearest junction along the graph', () => {
    // U's fork, U edges only; both branch ends meet A within about 60 m. The nearer along the
    // graph is the west branch's (n1743805057), about 20° from the fork. Less its own name.
    expect(junctionName(KJFK, 'n9328929569')).toBe('U north of A');
  });

  it("tells apart the nodes either side of a junction (seed 666: two different nodes were both 'F near B')", () => {
    expect(junctionName(KJFK, 'n9328972991')).toBe('F west of B');
    expect(junctionName(KJFK, 'n4058789617')).toBe('F east of B');
  });
});
