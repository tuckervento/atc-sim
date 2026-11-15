// KJFK (PLAN 1.5 stage a): the imported base plus the hand-curated overrides. The departure
// line, its exits, pads, the penalty box, ramp handoffs, hardstands and hangars come in
// stage b, after Q's answers (docs/airports/KJFK-questions.md), so this file doesn't test them.

import { describe, expect, it } from 'vitest';
import kjfkBase from '../../data/airports/KJFK.json' with { type: 'json' };
import kjfkOverrides from '../../data/airports/KJFK.overrides.json' with { type: 'json' };
import type { Taxi } from '../sim/commands.ts';
import { resolveRoute } from '../sim/route.ts';
import { parseTerse } from '../sim/terse.ts';
import { edgeLength, edgePolyline, edgesAt, indexAirport } from './graph.ts';
import { loadAirport } from './load.ts';
import type { Point } from './types.ts';
import { validateAirport } from './validate.ts';

const KJFK = loadAirport(kjfkBase, kjfkOverrides);

describe('KJFK', () => {
  it('loads from the base file plus overrides', () => {
    expect(KJFK.id).toBe('KJFK');
    expect(KJFK.source?.license).toContain('ODbL');
    expect(KJFK.terminals.map((t) => t.id)).toEqual(['T1', 'T4', 'T5', 'T7', 'T8']);
    expect(KJFK.defaultConfiguration).toBe('31s');
    expect(KJFK.edges.filter((e) => e.closed).length).toBe(3);
  });

  it('has runways 4L/22R, 4R/22L, 13L/31R and 13R/31L, each a valid centerline with its tower position', () => {
    expect(KJFK.runways.map((r) => [r.id, r.ends[0].designator, r.ends[1].designator, r.towerPosition])).toEqual([
      ['4L/22R', '4L', '22R', 'twr-123.9'],
      ['4R/22L', '4R', '22L', 'twr-119.1'],
      ['13L/31R', '13L', '31R', 'twr-119.1'],
      ['13R/31L', '13R', '31L', 'twr-123.9'],
    ]);
    const index = indexAirport(KJFK);
    // Centerline length against the Chart Supplement (feet), within 1%.
    const chartFeet: Record<string, number> = { '4L/22R': 12079, '4R/22L': 8400, '13L/31R': 10000, '13R/31L': 14511 };
    for (const r of KJFK.runways) {
      const lengthM = KJFK.edges.filter((e) => e.runway === r.id).reduce((m, e) => m + edgeLength(index, e), 0);
      expect(Math.abs(lengthM / 0.3048 / (chartFeet[r.id] as number) - 1), r.id).toBeLessThan(0.01);
    }
    const codes = validateAirport(KJFK).errors.map((e) => e.code);
    expect(codes.filter((c) => c.startsWith('runway-') || c === 'duplicate-runway-end')).toEqual([]);
  });

  it('has runway hold-shorts protecting each runway on the taxiways that meet it, facing it', () => {
    const index = indexAirport(KJFK);
    // Taxiways that meet each runway on the FAA diagram (AL-610, cycle 2611), spot-checked
    // against the imported holds on the map sheet.
    const expected: Record<string, string[]> = {
      '4L/22R': ['J', 'K1', 'K2', 'K3', 'K4', 'H', 'G', 'F', 'EE', 'FB', 'C', 'YA'],
      '4R/22L': ['E', 'F', 'Z'],
      '13L/31R': ['Y', 'YA', 'C1', 'C5', 'DB', 'D', 'E', 'U', 'U2', 'V', 'W', 'WW', 'ZA'],
      '13R/31L': ['KE', 'KD', 'K', 'L', 'M', 'MB', 'MC', 'MD', 'PA', 'PC', 'PD', 'PE', 'PF', 'JA', 'JB', 'Y', 'Z'],
    };
    const runwayHoldsOn = (runway: string, taxiway: string) =>
      KJFK.holdShorts.filter(
        (h) => h.kind === 'runway' && h.runways.includes(runway) && edgesAt(index, h.node).some((e) => e.kind === 'taxiway' && e.name === taxiway),
      );
    for (const [runway, taxiways] of Object.entries(expected)) {
      for (const taxiway of taxiways) expect(runwayHoldsOn(runway, taxiway).length, `${runway} on ${taxiway}`).toBeGreaterThan(0);
    }

    // Every runway hold faces its runway (its towardEdge leads closer to the centerline) and
    // stands 60–160 m from it (JFK's hold lines are about 85 m out; shallow exits more).
    const centerline = (runway: string) => KJFK.edges.filter((e) => e.runway === runway).map((e) => edgePolyline(index, e));
    const distanceTo = (runway: string, p: Point) => Math.min(...centerline(runway).map((line) => distanceToLine(p, line)));
    const runwayHolds = KJFK.holdShorts.filter((h) => h.kind === 'runway');
    expect(runwayHolds.length).toBe(77);
    for (const h of runwayHolds) {
      const node = index.nodes.get(h.node);
      const toward = index.edges.get(h.towardEdge);
      expect(node && toward, h.id).toBeTruthy();
      if (!node || !toward) continue;
      const line = edgePolyline(index, toward);
      const next = (toward.from === h.node ? line[1] : line.at(-2)) as Point;
      for (const runway of h.runways) {
        const here = distanceTo(runway, [node.x, node.y]);
        expect(here, `${h.id} from ${runway}`).toBeGreaterThan(60);
        expect(here, `${h.id} from ${runway}`).toBeLessThan(160);
        expect(distanceTo(runway, next), `${h.id} faces ${runway}`).toBeLessThan(here);
      }
    }
    expect(validateAirport(KJFK).errors.filter((e) => e.code.startsWith('hold-short-'))).toEqual([]);
  });

  it('resolves "A, then right on KE" to a connected path', () => {
    // Stage a has no departure lines, ramp handoffs or pads yet, and resolveRoute needs a
    // destination. So this test adds a probe pad, in memory only, whose spot is KE's runway
    // hold north of 13R/31L. The route itself is real data.
    const probe = indexAirport({ ...KJFK, holdingAreas: [{ id: 'PROBE', name: 'test probe', kind: 'pad', spots: ['n5969626554'] }] });
    // Eastbound on A, arriving at the A/KF junction from the west.
    const start = { node: 'n13771028754', arrivedVia: 'w1356437398-n13771028753-n13771028754', terminal: null };
    const result = resolveRoute(probe, taxiOf('taxi pad PROBE via A R:KE'), start);
    if (result.type !== 'path') throw new Error(`expected a path, got ${JSON.stringify(result)}`);
    expect(result.nodes).toEqual(['n13771028754', 'n1743798183', 'n45369878', 'n5969626554']);
    expect(result.edges).toEqual(['w1356437398-n13771028754-n1743798183', 'w5786872-n45369878-n1743798183', 'w5786872-n5969626554-n45369878']);
    result.edges.forEach((id, i) => {
      const edge = probe.edges.get(id);
      expect(edge?.kind).toBe('taxiway');
      expect(edge?.closed).toBeUndefined();
      expect([edge?.from, edge?.to].sort()).toEqual([result.nodes[i], result.nodes[i + 1]].sort());
    });
    expect(result.destination).toEqual({ kind: 'pad', holdingArea: 'PROBE', spot: 'n5969626554' });
    // KE only branches off to the right here.
    expect(resolveRoute(probe, taxiOf('taxi pad PROBE via A L:KE'), start)).toEqual({ type: 'unable', reason: "taxiway KE doesn't go left from n1743798183" });
  });
});

/** The taxi instruction of a terse command written without its callsign. */
function taxiOf(text: string): Taxi {
  const parsed = parseTerse(`TST1 ${text}`);
  if (!parsed.ok) throw new Error(`'${text}' doesn't parse: ${parsed.error.message}`);
  const [instruction] = parsed.command.type === 'transmission' ? parsed.command.instructions : [];
  if (instruction?.type !== 'taxi') throw new Error(`'${text}' is not a taxi instruction`);
  return instruction;
}

function distanceToLine(p: Point, line: Point[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1] as Point, line[i] as Point];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return best;
}
