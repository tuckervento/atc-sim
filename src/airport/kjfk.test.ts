// KJFK (PLAN 1.5): the imported base plus the hand-curated overrides, with Q's answers applied
// (docs/airports/KJFK-questions.md; what was set and where is in docs/airports/KJFK-notes.md).

import { describe, expect, it } from 'vitest';
import kjfkBase from '../../data/airports/KJFK.json' with { type: 'json' };
import kjfkOverrides from '../../data/airports/KJFK.overrides.json' with { type: 'json' };
import type { Taxi } from '../sim/commands.ts';
import { resolveRoute, type RoutePath, type RouteResult } from '../sim/route.ts';
import { parseTerse } from '../sim/terse.ts';
import { edgeLength, edgePolyline, edgesAt, indexAirport } from './graph.ts';
import { loadAirport } from './load.ts';
import type { Point } from './types.ts';
import { validateAirport } from './validate.ts';

const KJFK = loadAirport(kjfkBase, kjfkOverrides);
const INDEX = indexAirport(KJFK);

function pathOf(result: RouteResult): RoutePath {
  if (result.type !== 'path') throw new Error(`expected a path, got ${JSON.stringify(result)}`);
  return result;
}

/** The path is connected: each edge joins its two nodes, and none is closed or a runway edge. */
function expectConnected(path: RoutePath): void {
  expect(path.nodes.length).toBe(path.edges.length + 1);
  path.edges.forEach((id, i) => {
    const edge = INDEX.edges.get(id);
    expect(edge?.closed, id).toBeUndefined();
    expect(edge?.kind, id).not.toBe('runway');
    expect([edge?.from, edge?.to].sort(), id).toEqual([path.nodes[i], path.nodes[i + 1]].sort());
  });
}

/** The taxiway names along a path, consecutive repeats merged; unnamed edges show as "(lead-in)" or "(connector)" by position. */
function namesAlong(edges: string[]): string[] {
  const names = edges.map((id) => INDEX.edges.get(id)?.name ?? '(unnamed)');
  const merged = names.filter((n, i) => n !== names[i - 1]);
  return merged.map((n, i) => (n === '(unnamed)' ? (i === merged.length - 1 ? '(lead-in)' : '(connector)') : n));
}

describe('KJFK', () => {
  it('loads from the base file plus overrides', () => {
    expect(KJFK.id).toBe('KJFK');
    expect(KJFK.source?.license).toContain('ODbL');
    expect(KJFK.terminals.map((t) => t.id)).toEqual(['T1', 'T4', 'T5', 'T7', 'T8']);
    expect(KJFK.defaultConfiguration).toBe('31s');
    // The Z and VA closures were temporary (Q1, Q11), so nothing is closed.
    expect(KJFK.edges.filter((e) => e.closed).length).toBe(0);
    // Q7's check-in points (VA and W at two nodes each); Q16's remote stands as T4 gates.
    expect(KJFK.rampHandoffs.map((h) => h.name)).toEqual(['NA', 'MA', 'M', 'KG', 'KF', 'HB', 'A10', 'G', 'DA', 'A4', 'D', 'F', 'VV', 'VA', 'VA', 'A1', 'W', 'W', 'TA', 'NB', 'NC', 'S', 'SA', 'T']);
    expect(KJFK.gates.length).toBe(161 + 23);
    expect(KJFK.gates.filter((g) => /^(7[2-9]|H\d)/.test(g.name)).every((g) => g.terminal === 'T4')).toBe(true);
    expect(KJFK.hangars.map((h) => [h.id, h.airlines])).toEqual([
      ['hgDAL', ['DAL']], ['hgAAL', ['AAL']], ['hgJBU', ['JBU']], ['hgKAL', ['KAL']], ['hgSIA', ['SIA']],
      ['hgANA', ['ANA']], ['hgFDX', ['FDX']], ['hgUAL', ['UAL']], ['hgDHL', []],
    ]);
  });

  it('validates with no errors; the only warnings are the approach holds beyond 31R, which guard no pavement', () => {
    const result = validateAirport(KJFK);
    expect(result.errors.map((e) => `${e.code}: ${e.message}`)).toEqual([]);
    expect(result.warnings.map((w) => [w.code, w.ids[0]])).toEqual([
      ['hold-short-far-from-runway', 'h5607488397'],
      ['hold-short-far-from-runway', 'h5607488398'],
      ['hold-short-far-from-runway', 'h5607488399'],
    ]);
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
      '4R/22L': ['E', 'F', 'Z', 'FA'],
      '13L/31R': ['Y', 'YA', 'C1', 'C5', 'DB', 'D', 'E', 'U', 'U2', 'V', 'W', 'WW', 'ZA', 'FB'],
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
    // stands 60–160 m from it (JFK's hold lines are about 85 m out; shallow exits more). Except:
    // - the three approach holds on FA/FB beyond 31R (Q15c), which face 13L/31R's extended
    //   centerline, not its pavement (checked below);
    // - Q12's FA hold onto 4R/22L, at the FA/FB merge 39.5 m out: FA runs into 22L alongside
    //   the runway, so no point on its last edge is farther out (docs/airports/KJFK-notes.md).
    const centerline = (runway: string) => KJFK.edges.filter((e) => e.runway === runway).map((e) => edgePolyline(index, e));
    const distanceTo = (runway: string, p: Point) => Math.min(...centerline(runway).map((line) => distanceToLine(p, line)));
    const runwayHolds = KJFK.holdShorts.filter((h) => h.kind === 'runway');
    // 77 from stage a, plus Q15c's three approach holds (one, "31R-APCH", was removed in stage a)
    // and Q12's two added holds, on D north of 13L/31R and on FA onto 4R/22L.
    expect(runwayHolds.length).toBe(82);
    const approach = ['h5607488397', 'h5607488398', 'h5607488399'];
    const atMerge = 'hxFA4R';
    for (const id of approach) {
      const h = runwayHolds.find((x) => x.id === id);
      expect(h?.runways, id).toEqual(['13L/31R']);
      // It faces FB's crossing of 31R's extended centerline: the edge toward the FA/FB merge, or
      // for the one north of the crossing, toward the next hold down FB.
      expect(h?.towardEdge, id).toBe(
        { h5607488397: 'w5786535-n5607488398-n5607488397', h5607488398: 'w5786535-n45358355-n5607488398', h5607488399: 'w5786512-n5607488399-n45358355' }[id],
      );
    }
    const merge = runwayHolds.find((h) => h.id === atMerge);
    expect(merge && [merge.node, merge.towardEdge, merge.runways]).toEqual(['n45358355', 'w5786512-n45358355-n45357837', ['4R/22L']]);
    expect(distanceTo('4R/22L', [index.nodes.get('n45358355')?.x ?? 0, index.nodes.get('n45358355')?.y ?? 0])).toBeCloseTo(39.5, 0);
    for (const h of runwayHolds.filter((x) => !approach.includes(x.id) && x.id !== atMerge)) {
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

  it("has the 31L departure line: Z from H to the front hold h8025529445, back along Z and Y for a long queue, with exits H then J (Q1, Q2)", () => {
    const lines = KJFK.departureLines.filter((l) => l.runwayEnd === '31L');
    expect(lines.map((l) => [l.id, l.holdShort])).toEqual([['line31L', 'h8025529445']]);
    const line = lines[0];
    if (!line) throw new Error('no 31L line');
    // Back to front: Y from n45357551 to n45355700, then Z all the way (Q1's longer queue, then
    // Q1's line from n4057398125).
    expect(line.edges.map((id) => INDEX.edges.get(id)?.name)).toEqual(['Y', 'Z', 'Z', 'Z', 'Z', 'Z']);
    expect(line.edges[0]).toBe('w586977161-n45355700-n45357551');
    expect(line.edges.slice(3).every((id) => id.startsWith('w162541291') || id.startsWith('w5938318'))).toBe(true);
    expect(line.exits.length).toBeGreaterThanOrEqual(2);
    expect(line.exits.map((x) => [x.taxiway, x.node])).toEqual([
      ['H', 'n4057398125'],
      ['J', 'n4068921630'],
    ]);
    // From the back of the line, a taxi to 31L runs the whole line to its front hold.
    const back = { node: 'n4057398125', arrivedVia: 'w162541297-n4057398125-n46547996', terminal: null };
    const path = pathOf(resolveRoute(INDEX, taxiOf('taxi 31L via Z'), back));
    expect(path.edges).toEqual(line.edges.slice(3));
    // Joining from Y at its back, it runs the whole line.
    const onF = { node: 'n45357551', arrivedVia: 'w5786477-n460010256-n45357551', terminal: null };
    expect(pathOf(resolveRoute(INDEX, taxiOf('taxi 31L via Y'), onF)).edges).toEqual(line.edges);
    expect(path.destination).toEqual({ kind: 'runway', runwayEnd: '31L', departureLine: 'line31L', holdShort: 'h8025529445' });
  });

  it('resolves "A, then right on KE" to a connected path, on to the Kilo pad over K4 and K', () => {
    // Eastbound on A, arriving at the A/KF junction from the west. KE crosses 13R/31L, K4 meets K
    // at n4057398142, and K leads south to the Kilo pad's lead-in at the K2 junction (Q3).
    const start = { node: 'n13771028754', arrivedVia: 'w1356437398-n13771028753-n13771028754', terminal: null };
    const path = pathOf(resolveRoute(INDEX, taxiOf('taxi pad KILO via A R:KE K4 K'), start));
    expect(path.nodes.slice(0, 4)).toEqual(['n13771028754', 'n1743798183', 'n45369878', 'n5969626554']);
    expect(namesAlong(path.edges)).toEqual(['A', 'KE', 'K4', 'K', '(lead-in)']);
    expectConnected(path);
    // It crosses one runway, 13R/31L, at KE's hold north of it; then passes K4's ILS hold.
    expect(path.holdShorts.map((h) => [h.id, h.kind, h.runways])).toEqual([
      ['h5969626554', 'runway', ['13R/31L']],
      ['h5969626556', 'ils', ['13R/31L']],
    ]);
    expect(path.destination).toEqual({ kind: 'pad', holdingArea: 'kilo', spot: 'xkS3' });
    // KE only branches off to the right here.
    expect(resolveRoute(INDEX, taxiOf('taxi pad KILO via A L:KE K4 K'), start)).toEqual({ type: 'unable', reason: "taxiway KE doesn't go left from A/KE" });
  });

  it('resolves a taxi to the South Hardstand to a connected path, by each of its entrances (Q9)', () => {
    // Westbound on Q at the Q/Q6 junction.
    const onQ = { node: 'n4057466119', arrivedVia: 'w5786123-n45348120-n4057466119', terminal: null };
    const cases: [route: string, spot: string][] = [
      ['taxi hardstand via Q Q5', 'n14158137989'],
      ['taxi hardstand via Q PB', 'n14158137994'],
      ['taxi hardstand via Q Q3', 'xsW'],
    ];
    for (const [route, spot] of cases) {
      const path = pathOf(resolveRoute(INDEX, taxiOf(route), onQ));
      expectConnected(path);
      expect(path.destination, route).toEqual({ kind: 'hardstand', holdingArea: 'south', spot });
    }
    // Q's default spoken names reach it too ("South Hardstand", "hardstand").
    const named: Taxi = { type: 'taxi', to: { kind: 'hardstand', name: 'SOUTH HARDSTAND' }, via: [{ taxiway: 'Q', turn: null }, { taxiway: 'Q5', turn: null }], holdShort: [] };
    expect(pathOf(resolveRoute(INDEX, named, onQ)).destination).toEqual({ kind: 'hardstand', holdingArea: 'south', spot: 'n14158137989' });
  });

  it("resolves a taxi to the company hangar (no name) by the aircraft's airline to a connected path (Q10)", () => {
    // Delta: north on S, then the stand west of S by the Delta hangar.
    const onS = { node: 'n12546344190', arrivedVia: 'w5786731-n45365993-n12546344190', terminal: null, airline: 'DAL' };
    const delta = pathOf(resolveRoute(INDEX, taxiOf('taxi hangar via S'), onS));
    expectConnected(delta);
    expect(delta.destination).toEqual({ kind: 'hangar', hangar: 'hgDAL', spot: 'n12546344193' });
    // JetBlue: off B onto TT (Q14's name for the stub), which leads to the JetBlue hangar.
    const onB = { node: 'n45295620', arrivedVia: 'w162535324-n45295620-n45295623', terminal: null, airline: 'JBU' };
    const jetblue = pathOf(resolveRoute(INDEX, taxiOf('taxi hangar via TT'), onB));
    expectConnected(jetblue);
    expect(namesAlong(jetblue.edges)).toEqual(['TT', '(lead-in)']);
    expect(jetblue.destination).toEqual({ kind: 'hangar', hangar: 'hgJBU', spot: 'n4058675894' });
    // Another company's hangar isn't on that way in; an airline with none is unable.
    expect(resolveRoute(INDEX, taxiOf('taxi hangar via S'), { ...onS, airline: 'JBU' })).toEqual({ type: 'unable', reason: "taxiway S doesn't lead to the JBU hangar in the direction of travel" });
    expect(resolveRoute(INDEX, taxiOf('taxi hangar via S'), { ...onS, airline: 'BAW' })).toEqual({ type: 'unable', reason: 'no company hangar for BAW at KJFK' });
  });

  it('resolves "A, then B" over the unnamed fillet between them (Q6: unnamed connectors count as turns)', () => {
    // North-east on A at the A/HB junction. A and B share no node here; an 87 m unnamed fillet
    // joins them, and B lies to the right, so the jog is a right turn onto B.
    const onA = { node: 'n4057398094', arrivedVia: 'w1356437398-n1743802427-n4057398094', terminal: null };
    const path = pathOf(resolveRoute(INDEX, taxiOf('taxi ramp T5 via A B F'), onA));
    expectConnected(path);
    expect(path.edges[0]).toBe('w403521117-n4057398094-n4057398092');
    expect(namesAlong(path.edges)).toEqual(['(connector)', 'B', 'F']);
    expect(path.destination).toEqual({ kind: 'ramp', terminal: 'T5', rampHandoff: 'rhF' });
    expect(pathOf(resolveRoute(INDEX, taxiOf('taxi ramp T5 via A R:B F'), onA)).edges).toEqual(path.edges);
    expect(resolveRoute(INDEX, taxiOf('taxi ramp T5 via A L:B F'), onA)).toEqual({ type: 'unable', reason: "taxiway B doesn't go left from A/HB" });
  });

  it('has the Kilo and Zulu pads and the penalty box by their spoken names (Q3–Q5)', () => {
    const answers = (kind: string, names: string[]) =>
      KJFK.holdingAreas.filter((a) => a.kind === kind).map((a) => [a.id, a.spots.length, names.every((n) => [a.name, ...(a.spokenNames ?? [])].map((x) => x.toLowerCase()).includes(n))]);
    expect(answers('pad', ['kilo pad'])).toEqual([['kilo', 3, true], ['zulu', 3, false]]);
    expect(answers('pad', ['zulu pad'])).toEqual([['kilo', 3, false], ['zulu', 3, true]]);
    expect(answers('penaltyBox', ['penalty box', 'quebec box'])).toEqual([['quebec', 6, true]]);
    // Down Z from the back of the 31L line, round the 31L end, to the Zulu pad.
    const back = { node: 'n4057398125', arrivedVia: 'w162541297-n4057398125-n46547996', terminal: null };
    expect(pathOf(resolveRoute(INDEX, taxiOf('taxi pad ZULU via Z'), back)).destination).toEqual({ kind: 'pad', holdingArea: 'zulu', spot: 'xzS2' });
    // Along Q onto Q2, to a de-icing stand of the penalty box.
    const onQ = { node: 'n4057466119', arrivedVia: 'w5786123-n45348120-n4057466119', terminal: null };
    const box = pathOf(resolveRoute(INDEX, taxiOf('taxi penalty via Q Q2'), onQ));
    expectConnected(box);
    expect(box.destination).toEqual({ kind: 'penalty-box', holdingArea: 'quebec', spot: 'n14158137954' });
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
