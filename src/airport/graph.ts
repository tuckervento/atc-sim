// Lookup tables and geometry over a loaded airport. Pure: no I/O, no mutation of the airport.

import type { Airport, Edge, HoldingArea, Node, Point, Runway, RunwayEnd } from './types.ts';

export interface RunwayEndRef {
  runway: Runway;
  end: RunwayEnd;
  /** 0 or 1: the end's index in `runway.ends`. */
  index: 0 | 1;
}

/**
 * Maps from id to item for the collections code looks things up in, plus node adjacency.
 * When an id is duplicated (the validator reports that), the first item wins.
 */
export interface AirportIndex {
  airport: Airport;
  nodes: Map<string, Node>;
  edges: Map<string, Edge>;
  runways: Map<string, Runway>;
  /** By designator ("31L"). */
  runwayEnds: Map<string, RunwayEndRef>;
  /** Every edge touching a node, open or closed, in file order. */
  edgesAtNode: Map<string, Edge[]>;
}

export function indexAirport(airport: Airport): AirportIndex {
  const nodes = firstById(airport.nodes);
  const edges = firstById(airport.edges);
  const runways = firstById(airport.runways);
  const runwayEnds = new Map<string, RunwayEndRef>();
  for (const runway of airport.runways) {
    runway.ends.forEach((end, i) => {
      if (!runwayEnds.has(end.designator)) {
        runwayEnds.set(end.designator, { runway, end, index: i === 0 ? 0 : 1 });
      }
    });
  }
  const edgesAtNode = new Map<string, Edge[]>();
  for (const edge of airport.edges) {
    for (const nodeId of edge.from === edge.to ? [edge.from] : [edge.from, edge.to]) {
      let list = edgesAtNode.get(nodeId);
      if (!list) {
        list = [];
        edgesAtNode.set(nodeId, list);
      }
      list.push(edge);
    }
  }
  return { airport, nodes, edges, runways, runwayEnds, edgesAtNode };
}

function firstById<T extends { id: string }>(items: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    if (!map.has(item.id)) map.set(item.id, item);
  }
  return map;
}

/** The edges touching `nodeId` (empty if none). */
export function edgesAt(index: AirportIndex, nodeId: string): Edge[] {
  return index.edgesAtNode.get(nodeId) ?? [];
}

/** The node at the other end of `edge` from `nodeId`. Throws if `edge` doesn't touch it. */
export function otherEnd(edge: Edge, nodeId: string): string {
  if (edge.from === nodeId) return edge.to;
  if (edge.to === nodeId) return edge.from;
  throw new Error(`edge "${edge.id}" does not touch node "${nodeId}"`);
}

export function touches(edge: Edge, nodeId: string): boolean {
  return edge.from === nodeId || edge.to === nodeId;
}

/**
 * The edge's full polyline from `from` to `to`, shape points included. Throws if an end
 * node is missing (validate first).
 */
export function edgePolyline(index: AirportIndex, edge: Edge): Point[] {
  const from = index.nodes.get(edge.from);
  const to = index.nodes.get(edge.to);
  if (!from || !to) {
    throw new Error(`edge "${edge.id}" refers to a missing node ("${edge.from}" or "${edge.to}")`);
  }
  return [[from.x, from.y], ...(edge.points ?? []), [to.x, to.y]];
}

/** Length of the edge's polyline, in meters. */
export function edgeLength(index: AirportIndex, edge: Edge): number {
  return polylineLength(edgePolyline(index, edge));
}

export function polylineLength(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b) total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return total;
}

/**
 * A node as a player can find it on the map, for messages (node ids mean nothing to a player):
 * the taxiways and lanes that meet there, "B/MB/P", with any runway, "C1/U1 (runway 13L/31R)".
 * A node with fewer than two names and no runway goes by the nearest such junction along the
 * graph (within JUNCTION_SEARCH_M), less its own name: "U near A" (U's fork, near where it
 * meets A), "C near runway 9/27", or "near A/P1" off the named taxiways.
 */
export function junctionName(index: AirportIndex, nodeId: string): string {
  const own = labelAt(index, nodeId);
  if (own.full) return own.text;
  // Nearest first, by distance along the edges.
  const dist = new Map<string, number>([[nodeId, 0]]);
  const done = new Set<string>();
  for (;;) {
    let next: string | null = null;
    for (const [n, d] of dist) if (!done.has(n) && d <= JUNCTION_SEARCH_M && (next === null || d < (dist.get(next) ?? Infinity))) next = n;
    if (next === null) break;
    done.add(next);
    const there = labelAt(index, next);
    if (there.full) return own.text === '' ? `near ${there.text}` : `${own.text} near ${labelAt(index, next, own.text).text}`;
    for (const e of edgesAt(index, next)) {
      const to = otherEnd(e, next);
      const d = (dist.get(next) ?? 0) + edgeLength(index, e);
      if (d < (dist.get(to) ?? Infinity)) dist.set(to, d);
    }
  }
  return own.text === '' ? 'off the named taxiways' : own.text;
}

/** How far `junctionName` looks for a named junction, meters along the edges. */
export const JUNCTION_SEARCH_M = 1000;

/**
 * A node's own label; `full` when it names a junction (two names, or a name and a runway).
 * `without`: a name left out of the text ("near" a junction, the name the node is on).
 */
function labelAt(index: AirportIndex, nodeId: string, without: string | null = null): { text: string; full: boolean } {
  const edges = edgesAt(index, nodeId);
  const all = [...new Set(edges.flatMap((e) => (e.kind !== 'runway' && e.name !== undefined ? [e.name] : [])))].sort();
  const names = all.filter((n) => n !== without);
  const runways = [...new Set(edges.flatMap((e) => (e.runway !== undefined ? [e.runway] : [])))].sort();
  const runwayText = runways.length > 0 ? `runway ${runways.join(', ')}` : '';
  const text = names.length === 0 ? runwayText : [names.join('/'), runwayText && `(${runwayText})`].filter((t) => t !== '').join(' ');
  return { text, full: all.length >= 2 || (all.length === 1 && runways.length > 0) };
}

/**
 * Everything a holding area answers to as a named taxi destination, lowercased: its id, its
 * name and its spoken names. A destination name matches when it equals one, ignoring case.
 */
export function holdingAreaNames(area: HoldingArea): string[] {
  return [...new Set([area.id, area.name, ...(area.spokenNames ?? [])].map((n) => n.toLowerCase()))];
}
