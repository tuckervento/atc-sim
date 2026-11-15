import { describe, expect, it } from 'vitest';
import testAirport from '../../../data/airports/TEST.json' with { type: 'json' };
import { loadAirport } from '../../airport/load.ts';
import { LABEL_RULES } from './labels.ts';
import { activeRunways, buildScene, PLACE_LABEL_GAP_PX } from './scene.ts';

const TEST = loadAirport(testAirport);

describe('buildScene', () => {
  it("offers a label for every runway end, named taxiway and ramp lane, place, terminal, named building and gate, using the data's names", () => {
    const scene = buildScene(TEST);
    const byKind = (kind: string) => [...new Set(scene.labels.filter((l) => l.kind === kind).map((l) => l.text))].sort();

    expect(byKind('runway')).toEqual(['18', '27', '36', '9']);
    const named = (kind: string) => [...new Set(TEST.edges.filter((e) => e.kind === kind && e.name).map((e) => e.name))].sort();
    expect(byKind('taxiway')).toEqual(named('taxiway'));
    expect(byKind('rampLane')).toEqual(named('rampLane'));
    expect(byKind('place')).toEqual(['Delta hangar', 'North pad', 'Penalty box', 'South hardstand', 'West pad']);
    expect(byKind('terminal')).toEqual(['Terminal 1', 'Terminal 2']);
    expect(byKind('building')).toEqual(['Tower']);
    expect(byKind('gate')).toEqual([...new Set(TEST.gates.map((g) => g.name))].sort());

    // One candidate per named edge, sized by its length.
    const taxiwayEdges = TEST.edges.filter((e) => e.kind === 'taxiway' && e.name);
    expect(scene.labels.filter((l) => l.kind === 'taxiway')).toHaveLength(taxiwayEdges.length);

    // Runway 9/27 runs west (9) to east (27): 27's designator sits past the east end, 9's past the west.
    const offsetX = (text: string) => scene.labels.find((l) => l.kind === 'runway' && l.text === text)?.offsetPx?.[0];
    expect(offsetX('27')).toBeGreaterThan(0);
    expect(offsetX('9')).toBeLessThan(0);
  });

  it("offers each place's label at its center, then below and above its shape, so an aircraft there doesn't hide it", () => {
    // TEST's penalty box has an outline (x −1150 to 550, y −500 to −380).
    const box = TEST.holdingAreas.find((h) => h.id === 'penaltyBox')?.outline;
    if (!box) throw new Error('TEST has no penalty box outline');
    const ys = box.map((p) => p[1]);
    const xs = box.map((p) => p[0]);
    const cx = xs.reduce((s, x) => s + x, 0) / xs.length;
    const cy = ys.reduce((s, y) => s + y, 0) / ys.length;
    const spots = buildScene(TEST).labels.filter((l) => l.text === 'Penalty box');
    expect(spots.map((l) => [l.at, l.offsetPx ?? [0, 0]])).toEqual([
      [[cx, cy], [0, 0]],
      [[cx, Math.min(...ys)], [0, PLACE_LABEL_GAP_PX]],
      [[cx, Math.max(...ys)], [0, -PLACE_LABEL_GAP_PX]],
    ]);
    // Only one of them is ever drawn: a place's name isn't repeated within a screen.
    expect(LABEL_RULES.place.sameTextGapPx).toBeGreaterThanOrEqual(1000);
  });

  it('bounds everything drawn, place and hangar outlines included', () => {
    // TEST's Delta hangar outline reaches x = −1720, west of every node (−1640).
    const { bounds } = buildScene(TEST);
    const outlines = [...TEST.areas, ...TEST.holdingAreas, ...TEST.hangars].flatMap((a) => a.outline ?? []);
    const points = [...TEST.nodes.map((n) => [n.x, n.y] as const), ...outlines];
    expect(bounds).toEqual({
      minX: Math.min(...points.map((p) => p[0])),
      minY: Math.min(...points.map((p) => p[1])),
      maxX: Math.max(...points.map((p) => p[0])),
      maxY: Math.max(...points.map((p) => p[1])),
    });
    expect(bounds.minX).toBe(-1720);
  });

  it("sizes a taxiway's labels by its connected run of same-named edges, longest edge first", () => {
    // A taxiway split into many short edges (KJFK's KE: 7 edges, 330 m) is still one feature.
    const taxiway = (name: string) => buildScene(TEST).labels.filter((l) => l.kind === 'taxiway' && l.text === name);
    const a = taxiway('A');
    expect(a).toHaveLength(13);
    for (const l of a) expect(l.sizeM).toBeCloseTo(3000, 6);
    // A's longest edge is a7–aD (500 m, x −800 → −300 at y 200): its midpoint is offered first.
    expect(a[0]?.at).toEqual([-550, 200]);
    for (const l of taxiway('J')) expect(l.sizeM).toBeCloseTo(113.137 + 169.706, 2);
  });
});

describe('activeRunways', () => {
  it("uses the airport's default configuration", () => {
    // TEST's default "west": land 27 and 36, depart 27.
    expect(TEST.defaultConfiguration).toBe('west');
    expect(activeRunways(TEST)).toEqual(
      new Map([
        ['9/27', { end: '27', roles: ['arrivals', 'departures'] }],
        ['18/36', { end: '36', roles: ['arrivals'] }],
      ]),
    );
  });

  it('uses the first configuration when there is no default, and none when there are none', () => {
    const { defaultConfiguration: _, ...noDefault } = TEST;
    // "east" first, so the first is not also the default: depart 9, land 18.
    const eastFirst = { ...noDefault, configurations: [...TEST.configurations].reverse() };
    expect(eastFirst.configurations[0]?.id).toBe('east');
    expect(activeRunways(eastFirst)).toEqual(
      new Map([
        ['9/27', { end: '9', roles: ['departures'] }],
        ['18/36', { end: '18', roles: ['arrivals'] }],
      ]),
    );
    expect(activeRunways({ ...noDefault, configurations: [] })).toEqual(new Map());
  });
});
