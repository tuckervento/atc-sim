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
 * Everything a holding area answers to as a named taxi destination, lowercased: its id, its
 * name and its spoken names. A destination name matches when it equals one, ignoring case.
 */
export function holdingAreaNames(area: HoldingArea): string[] {
  return [...new Set([area.id, area.name, ...(area.spokenNames ?? [])].map((n) => n.toLowerCase()))];
}
