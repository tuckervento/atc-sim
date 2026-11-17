// What the map draws, worked out once per airport from the loaded data. Pure: no DOM.

import type { Airport, AreaKind, EdgeKind, HoldingAreaKind, Point, RunwayEndDesignator, RunwayId, RunwayRole } from '../../airport/types.ts';
import { edgePolyline, indexAirport, polylineLength } from '../../airport/graph.ts';
import type { LabelCandidate } from './labels.ts';
import type { Bounds } from './view.ts';

export interface SceneEdge {
  kind: Exclude<EdgeKind, 'runway'>;
  line: Point[];
  /** Pavement width, meters (the data's, or a default per kind). */
  widthM: number;
  closed: boolean;
}

export interface SceneRunwayEnd {
  designator: RunwayEndDesignator;
  /** The pavement end this direction starts from. */
  at: Point;
  /** Unit vector from this end along the runway toward the other end. */
  along: Point;
}

export interface SceneRunway {
  id: RunwayId;
  widthM: number;
  ends: [SceneRunwayEnd, SceneRunwayEnd];
  /** Present when the runway is in use in the session's configuration. */
  active?: ActiveRunway;
}

export interface ScenePlace {
  kind: HoldingAreaKind | 'hangar';
  name: string;
  outline?: Point[];
  spots: Point[];
}

export interface Scene {
  /** Everything drawn, for the initial fit. */
  bounds: Bounds;
  areas: { kind: AreaKind; outline: Point[] }[];
  edges: SceneEdge[];
  runways: SceneRunway[];
  places: ScenePlace[];
  gates: { id: string; name: string; at: Point }[];
  labels: LabelCandidate[];
}

/** Drawing widths when an edge has no `widthM`, meters. */
export const DEFAULT_WIDTH_M = { taxiway: 23, rampLane: 12 } as const;

/** How far a place's fallback labels sit below or above its shape, px. */
export const PLACE_LABEL_GAP_PX = 10;

/** How far past the pavement end a runway designator sits, px. */
const RUNWAY_LABEL_OFFSET_PX = 18;

export function buildScene(airport: Airport): Scene {
  const index = indexAirport(airport);
  const nodeAt = (id: string): Point => {
    const n = index.nodes.get(id);
    if (!n) throw new Error(`${airport.id}: unknown node "${id}"`);
    return [n.x, n.y];
  };
  const labels: LabelCandidate[] = [];

  const edges: SceneEdge[] = [];
  const named: NamedEdge[] = [];
  for (const edge of airport.edges) {
    if (edge.kind === 'runway') continue; // drawn as the runway's pavement
    const line = edgePolyline(index, edge);
    edges.push({ kind: edge.kind, line, widthM: edge.widthM ?? DEFAULT_WIDTH_M[edge.kind], closed: edge.closed !== undefined });
    if (edge.name !== undefined) named.push({ kind: edge.kind, name: edge.name, from: edge.from, to: edge.to, line, lengthM: polylineLength(line) });
  }
  // One candidate per named edge (so a long taxiway can be labeled along its length), sized
  // by its run: the connected stretch of same-named edges it belongs to. Within a run the
  // longest edges come first, so with one label it sits on the run's longest edge.
  for (const run of namedRuns(named)) {
    const runM = run.reduce((sum, e) => sum + e.lengthM, 0);
    for (const e of [...run].sort((x, y) => y.lengthM - x.lengthM)) {
      labels.push({ text: e.name, kind: e.kind, at: midpoint(e.line), sizeM: runM });
    }
  }

  const active = activeRunways(airport);
  const runways: SceneRunway[] = airport.runways.map((runway) => {
    const a = nodeAt(runway.ends[0].node);
    const b = nodeAt(runway.ends[1].node);
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const ab: Point = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    const ends: [SceneRunwayEnd, SceneRunwayEnd] = [
      { designator: runway.ends[0].designator, at: a, along: ab },
      { designator: runway.ends[1].designator, at: b, along: [-ab[0], -ab[1]] },
    ];
    for (const end of ends) {
      // Outward is -along; screen y points south, so north (+y) is -y on screen.
      const offsetPx: [number, number] = [-end.along[0] * RUNWAY_LABEL_OFFSET_PX, end.along[1] * RUNWAY_LABEL_OFFSET_PX];
      labels.push({ text: end.designator, kind: 'runway', at: end.at, sizeM: length, offsetPx });
    }
    const use = active.get(runway.id);
    return { id: runway.id, widthM: runway.widthM, ends, ...(use ? { active: use } : {}) };
  });

  const places: ScenePlace[] = [
    ...airport.holdingAreas.map((h) => ({ kind: h.kind, name: h.name, outline: h.outline, spots: h.spots.map(nodeAt) })),
    ...airport.hangars.map((h) => ({ kind: 'hangar' as const, name: h.name, outline: h.outline, spots: h.spots.map(nodeAt) })),
  ];
  for (const place of places) {
    const shape = place.outline ?? place.spots;
    if (shape.length === 0) continue;
    // Center first; below and above the shape as fallbacks when an aircraft's data block (or
    // another label) is in the way. The place rule's same-text gap keeps it to one.
    const [cx, cy] = centroid(shape);
    const b = boundsOf(shape);
    const sizeM = span(shape);
    labels.push({ text: place.name, kind: 'place', at: [cx, cy], sizeM });
    labels.push({ text: place.name, kind: 'place', at: [cx, b.minY], sizeM, offsetPx: [0, PLACE_LABEL_GAP_PX] });
    labels.push({ text: place.name, kind: 'place', at: [cx, b.maxY], sizeM, offsetPx: [0, -PLACE_LABEL_GAP_PX] });
  }

  const terminalNames = new Map(airport.terminals.map((t) => [t.id, t.name]));
  for (const area of airport.areas) {
    const text = area.kind === 'terminalBuilding' && area.terminal !== undefined ? (terminalNames.get(area.terminal) ?? area.name) : area.name;
    if (text === undefined) continue;
    labels.push({ text, kind: area.kind === 'terminalBuilding' ? 'terminal' : 'building', at: centroid(area.outline), sizeM: span(area.outline) });
  }

  const gates = airport.gates.map((g) => ({ id: g.id, name: g.name, at: nodeAt(g.node) }));
  for (const gate of gates) labels.push({ text: gate.name, kind: 'gate', at: gate.at, sizeM: 0 });

  return {
    bounds: boundsOf([
      ...airport.nodes.map((n): Point => [n.x, n.y]),
      ...airport.areas.flatMap((a) => a.outline),
      ...places.flatMap((p) => p.outline ?? []),
    ]),
    areas: airport.areas.map((a) => ({ kind: a.kind, outline: a.outline })),
    edges,
    runways,
    places,
    gates,
    labels,
  };
}

interface NamedEdge {
  kind: 'taxiway' | 'rampLane';
  name: string;
  from: string;
  to: string;
  line: Point[];
  lengthM: number;
}

/** Groups edges of one kind and name that touch (share a node) into connected runs. */
function namedRuns(edges: NamedEdge[]): NamedEdge[][] {
  // Union-find over edge indices; edges join when same kind and name meet at a node.
  const parent = edges.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] ?? r;
    parent[i] = r;
    return r;
  };
  const firstAt = new Map<string, number>();
  edges.forEach((e, i) => {
    for (const node of [e.from, e.to]) {
      const key = `${e.kind}\u0000${e.name}\u0000${node}`;
      const j = firstAt.get(key);
      if (j === undefined) firstAt.set(key, i);
      else parent[find(i)] = find(j);
    }
  });
  const runs = new Map<number, NamedEdge[]>();
  edges.forEach((e, i) => {
    const r = find(i);
    const run = runs.get(r);
    if (run) run.push(e);
    else runs.set(r, [e]);
  });
  return [...runs.values()];
}

/** The point halfway along a polyline. */
function midpoint(line: Point[]): Point {
  let remaining = polylineLength(line) / 2;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    if (!a || !b) continue;
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (remaining <= seg) {
      const t = seg === 0 ? 0 : remaining / seg;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    remaining -= seg;
  }
  const last = line.at(-1);
  if (!last) throw new Error('midpoint of an empty polyline');
  return last;
}

/** Mean of the vertices: good enough to place a label inside a building or pad. */
function centroid(points: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
  }
  return [x / points.length, y / points.length];
}

/** The larger side of the points' bounding box, meters. */
function span(points: Point[]): number {
  const b = boundsOf(points);
  return Math.max(b.maxX - b.minX, b.maxY - b.minY);
}

function boundsOf(points: Point[]): Bounds {
  if (points.length === 0) throw new Error('bounds of nothing');
  const b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of points) {
    b.minX = Math.min(b.minX, x);
    b.minY = Math.min(b.minY, y);
    b.maxX = Math.max(b.maxX, x);
    b.maxY = Math.max(b.maxY, y);
  }
  return b;
}

/** How an active runway is used: the end in use and its roles. */
export interface ActiveRunway {
  end: RunwayEndDesignator;
  roles: RunwayRole[];
}

/**
 * The runways in use, by runway id: from the airport's `defaultConfiguration`, or its first
 * configuration if it names none. Empty if it has no configurations.
 */
export function activeRunways(airport: Airport): Map<RunwayId, ActiveRunway> {
  const chosen = airport.defaultConfiguration;
  const config =
    chosen === undefined ? airport.configurations[0] : airport.configurations.find((c) => c.id === chosen);
  if (chosen !== undefined && config === undefined) {
    throw new Error(`${airport.id}: defaultConfiguration "${chosen}" is not one of its configurations`);
  }
  const active = new Map<RunwayId, ActiveRunway>();
  for (const use of config?.runways ?? []) {
    const runway = airport.runways.find((r) => r.ends.some((e) => e.designator === use.end));
    if (!runway) throw new Error(`${airport.id}: configuration "${config?.id}" uses unknown runway end "${use.end}"`);
    active.set(runway.id, { end: use.end, roles: [...use.roles] });
  }
  return active;
}
