// An aircraft's track: the chain of edges it's on, as one polyline with distances along it.
// Pure geometry over the airport graph; plain JSON data, so it's part of the hashed state.
//
// A track runs from the edge holding the aircraft's tail (its trail) through its resolved path
// (route.ts) to the end of the path. Positions on it are distances from its start, in meters,
// and only ever grow: aircraft never reverse (PRD §8.2).
//
// At a node: distance `nodeAt[i]` is node `nodes[i]`, and an aircraft whose nose is exactly
// there has arrived at it along `edges[i - 1]` but not yet entered `edges[i]`. That's route.ts's
// hold-point convention ("stop at nodes[index], before entering edges[index]").

import { edgePolyline, type AirportIndex } from '../airport/graph.ts';
import type { EdgeId, NodeId, Point } from '../airport/types.ts';

export interface Track {
  /** One more than `edges`. A track with no edges is a single node. */
  nodes: NodeId[];
  /** `edges[i]` runs from `nodes[i]` to `nodes[i + 1]`, whichever way it's stored. */
  edges: EdgeId[];
  /** Distance of `nodes[i]` from the start of the track. */
  nodeAt: number[];
  /** Every polyline vertex in order: nodes and the edges' shape points. */
  points: Point[];
  /** Distance of `points[i]` from the start of the track. */
  pointAt: number[];
  /** Every vertex where the polyline changes direction, in order. */
  bends: Bend[];
  lengthM: number;
}

export interface Bend {
  /** Distance along the track. */
  at: number;
  /** How far the direction turns there, 0–180 degrees, either way. */
  deflectionDeg: number;
}

/** Where a distance along a track falls: exactly at a node, or inside an edge. */
export type TrackPlace = { kind: 'node'; i: number } | { kind: 'edge'; i: number };

/**
 * Builds the track along `edges` from `nodes[0]`. Throws if the chain doesn't connect or names
 * something that isn't in the airport: callers build tracks from resolved paths, so that's a bug.
 */
export function buildTrack(index: AirportIndex, nodes: NodeId[], edges: EdgeId[]): Track {
  if (nodes.length !== edges.length + 1) {
    throw new Error(`track: ${nodes.length} nodes for ${edges.length} edges`);
  }
  const first = nodes[0];
  const start = first === undefined ? undefined : index.nodes.get(first);
  if (!start) throw new Error(`track: unknown start node "${first}"`);
  const points: Point[] = [[start.x, start.y]];
  const pointAt = [0];
  const nodeAt = [0];
  let distance = 0;
  edges.forEach((id, i) => {
    const edge = index.edges.get(id);
    if (!edge) throw new Error(`track: unknown edge "${id}"`);
    const [a, b] = [nodes[i], nodes[i + 1]];
    const polyline = edgePolyline(index, edge);
    if (edge.from === a && edge.to === b) {
      // stored the way it's travelled
    } else if (edge.to === a && edge.from === b) {
      polyline.reverse();
    } else {
      throw new Error(`track: edge "${id}" doesn't join "${a}" to "${b}"`);
    }
    for (let k = 1; k < polyline.length; k++) {
      const [p, q] = [polyline[k - 1], polyline[k]];
      if (!p || !q) throw new Error(`track: edge "${id}" polyline has a hole`);
      distance += Math.hypot(q[0] - p[0], q[1] - p[1]);
      points.push(q);
      pointAt.push(distance);
    }
    nodeAt.push(distance);
  });
  return { nodes, edges, nodeAt, points, pointAt, bends: bendsOf(points, pointAt), lengthM: distance };
}

function bendsOf(points: Point[], pointAt: number[]): Bend[] {
  const bends: Bend[] = [];
  for (let v = 1; v + 1 < points.length; v++) {
    const [p, q, r] = [points[v - 1], points[v], points[v + 1]];
    const at = pointAt[v];
    if (!p || !q || !r || at === undefined) throw new Error(`track: vertex ${v} is missing`);
    const [ax, ay] = [q[0] - p[0], q[1] - p[1]];
    const [bx, by] = [r[0] - q[0], r[1] - q[1]];
    // A repeated point has no direction; skip it rather than invent one.
    if ((ax === 0 && ay === 0) || (bx === 0 && by === 0)) continue;
    const deflectionDeg = Math.abs((Math.atan2(ax * by - ay * bx, ax * bx + ay * by) * 180) / Math.PI);
    if (deflectionDeg > 0) bends.push({ at, deflectionDeg });
  }
  return bends;
}

/** Where distance `s` falls on the track. Clamped to its ends. */
export function placeOf(track: Track, s: number): TrackPlace {
  const last = track.nodes.length - 1;
  if (s <= 0) return { kind: 'node', i: 0 };
  if (s >= track.lengthM) return { kind: 'node', i: last };
  // The last node at or before s.
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (at(track.nodeAt, mid) <= s) lo = mid;
    else hi = mid - 1;
  }
  return at(track.nodeAt, lo) === s ? { kind: 'node', i: lo } : { kind: 'edge', i: lo };
}

/** The point at distance `s`, and the heading there (degrees clockwise from north; null on a one-node track). */
export function pointOf(track: Track, s: number): { point: Point; headingDeg: number | null } {
  const { points, pointAt } = track;
  if (points.length === 1) {
    const only = points[0];
    if (!only) throw new Error('track: no points');
    return { point: only, headingDeg: null };
  }
  const clamped = Math.min(Math.max(s, 0), track.lengthM);
  // The first segment [v, v + 1] that reaches `clamped`.
  let v = 0;
  while (v + 2 < points.length && at(pointAt, v + 1) < clamped) v++;
  const [p, q] = [points[v], points[v + 1]];
  if (!p || !q) throw new Error(`track: segment ${v} is missing`);
  const length = at(pointAt, v + 1) - at(pointAt, v);
  const f = length === 0 ? 0 : (clamped - at(pointAt, v)) / length;
  const point: Point = [p[0] + f * (q[0] - p[0]), p[1] + f * (q[1] - p[1])];
  const headingDeg = length === 0 ? null : (((Math.atan2(q[0] - p[0], q[1] - p[1]) * 180) / Math.PI) + 360) % 360;
  return { point, headingDeg };
}

function at(values: number[], i: number): number {
  const value = values[i];
  if (value === undefined) throw new Error(`track: index ${i} out of range`);
  return value;
}
