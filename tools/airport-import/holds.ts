// Which runway(s) each OSM hold line protects, and which way it faces. OSM never says; this
// derives it from the graph (research doc §8 item 3). The rules, per OSM holding_position:type:
//
// - runway (and untagged holds within UNTAGGED_RUNWAY_M of a runway centerline):
//   1. Protected runway: the runway whose centerline is nearest in a straight line. Hold
//      lines are set out from a centerline, so this beats distance along the taxiways where a
//      taxiway meets a runway at a shallow angle. A hold closer than HOLD_STANDOFF_M to any
//      centerline is on the runway, not a hold line for it: not imported, reported. A hold
//      more than APPROACH_BEYOND_M past the runway's end, along its extended centerline, guards
//      the approach, which the format doesn't model: not imported, reported.
//   2. Facing: of the hold node's non-runway edges, the one with the shortest way (Dijkstra
//      over non-runway edges, up to FACING_LIMIT_M) to a node of that runway that passes no
//      other runway-type hold line; if no way avoids one, the shortest way at all. That edge
//      is `towardEdge`.
//   3. More runways: every other runway reachable through `towardEdge` over non-runway edges
//      without passing another runway-type hold line, within PROTECT_LIMIT_M. Crossing a
//      runway at a node counts (the far side is walked on), so a hold before two runways with
//      no hold line between them protects both.
// - ILS: steps 1 and 2 only (ILS holds sit behind the runway hold).
// - LAHSO: the hold node is on one runway's centerline. It faces along that runway toward the
//   nearest node shared with another runway, and protects that other runway.
// - intermediate: protects nothing; faces the nearest junction (a node with 3+ edges).
// - movement (the non-movement-area boundary) is not a hold-short in the format; the importer
//   keeps the node and reports it as a candidate ramp boundary point.

import { edgeLength, edgePolyline, edgesAt, otherEnd, type AirportIndex } from '../../src/airport/graph.ts';
import type { Edge, HoldShort, HoldShortKind, NodeId } from '../../src/airport/types.ts';

export const FACING_LIMIT_M = 600;
export const PROTECT_LIMIT_M = 600;
/** An untagged hold is read as a runway hold only if a runway centerline is this close (m). */
export const UNTAGGED_RUNWAY_M = 200;
/** A hold this close (m) to a runway centerline is on the runway, not a hold line for it. */
export const HOLD_STANDOFF_M = 30;
/** A hold projecting more than this (m) past a runway end is an approach-area hold. */
export const APPROACH_BEYOND_M = 50;

export type OsmHoldType = 'runway' | 'ILS' | 'LAHSO' | 'intermediate' | 'movement' | 'untagged' | string;

export interface HoldPoint {
  /** The hold-short id to create. */
  id: string;
  node: NodeId;
  osmType: OsmHoldType;
  /** e.g. "node 45352539" or "way 1234 (hold line)". */
  source: string;
}

export interface HoldResult {
  holdShorts: HoldShort[];
  /** Human-readable notes about holds that weren't imported as-is. */
  notes: string[];
  /** Per imported hold: how far its protected runway's node is (m), for reports. */
  facingDistanceM: Map<string, number>;
}

interface Reach {
  edge: Edge;
  distM: number;
  node: NodeId;
  runways: string[];
}

export function deriveHolds(index: AirportIndex, points: HoldPoint[]): HoldResult {
  const notes: string[] = [];
  const holdShorts: HoldShort[] = [];
  const facingDistanceM = new Map<string, number>();
  const runwaysAt = (node: NodeId) => [...new Set(edgesAt(index, node).filter((e) => e.kind === 'runway').map((e) => e.runway as string))].sort();
  const centerlines = new Map<string, [number, number][][]>();
  for (const e of index.airport.edges) {
    if (e.kind !== 'runway' || e.runway === undefined) continue;
    centerlines.set(e.runway, [...(centerlines.get(e.runway) ?? []), edgePolyline(index, e)]);
  }
  // Nodes whose hold line stops the "protected runways" walk.
  const blocking = new Set(points.filter((p) => p.osmType === 'runway' || p.osmType === 'LAHSO' || p.osmType === 'untagged').map((p) => p.node));

  for (const p of points) {
    const onRunway = runwaysAt(p.node);
    if (p.osmType === 'movement') continue;
    if (p.osmType === 'LAHSO') {
      const lahso = lahsoHold(index, p, onRunway);
      if (typeof lahso === 'string') notes.push(lahso);
      else holdShorts.push(lahso);
      continue;
    }
    if (onRunway.length > 0) {
      notes.push(`${p.source} (${p.osmType}) sits on runway ${onRunway.join(', ')}'s centerline; not imported`);
      continue;
    }
    if (p.osmType === 'intermediate') {
      const toward = towardJunction(index, p.node);
      if (!toward) {
        notes.push(`${p.source} (intermediate) has no junction to face; not imported`);
        continue;
      }
      holdShorts.push({ id: p.id, kind: 'intermediate', runways: [], node: p.node, towardEdge: toward.id });
      continue;
    }
    // The protected runway is the one whose centerline is nearest in a straight line (hold
    // lines are set out from a centerline); it faces the edge with the shortest way there.
    const node = index.nodes.get(p.node);
    if (!node) throw new Error(`hold ${p.id}: unknown node ${p.node}`);
    const byCenterline = [...centerlines]
      .map(([runway, lines]) => ({ runway, d: Math.min(...lines.map((l) => distanceToPolyline([node.x, node.y], l))) }))
      .sort((a, b) => a.d - b.d || (a.runway < b.runway ? -1 : 1));
    const nearest = byCenterline[0];
    if (!nearest) throw new Error('airport has no runways');
    if (nearest.d < HOLD_STANDOFF_M) {
      notes.push(`${p.source} (${p.osmType}) is ${nearest.d.toFixed(0)} m from runway ${nearest.runway}'s centerline, too close to be a hold line for any runway; not imported`);
      continue;
    }
    const target = nearest.runway;
    const beyond = beyondRunwayEnd(index, target, [node.x, node.y]);
    if (beyond > APPROACH_BEYOND_M) {
      notes.push(`${p.source} (${p.osmType}) lies ${beyond.toFixed(0)} m beyond an end of runway ${target}, along its extended centerline: an approach-area hold, which the format doesn't model; not imported`);
      continue;
    }
    // Prefer a way to the runway that passes no other hold line; else any way.
    const toTarget = (n: NodeId) => runwaysAt(n).filter((r) => r === target);
    const others = new Set([...blocking].filter((n) => n !== p.node));
    const candidates = edgesAt(index, p.node).filter((e) => e.kind !== 'runway');
    const byDistance = (a: Reach, b: Reach) => a.distM - b.distM || (a.edge.id < b.edge.id ? -1 : 1);
    const clear = candidates.map((e) => nearestRunway(index, p.node, e, toTarget, others)).filter((r): r is Reach => r !== null).sort(byDistance);
    const reaches = clear.length > 0 ? clear : candidates.map((e) => nearestRunway(index, p.node, e, toTarget, new Set())).filter((r): r is Reach => r !== null).sort(byDistance);
    const best = reaches[0];
    if (!best) {
      notes.push(`${p.source} (${p.osmType}): its nearest runway, ${target} (${nearest.d.toFixed(0)} m), can't be reached within ${FACING_LIMIT_M} m along the taxiways; not imported`);
      continue;
    }
    const second = byCenterline[1];
    if (second && second.d < nearest.d * 1.3) {
      notes.push(`${p.source} (${p.osmType}): runway ${target}'s centerline is ${nearest.d.toFixed(0)} m away and ${second.runway}'s ${second.d.toFixed(0)} m; protecting ${target}`);
    }
    let kind: HoldShortKind;
    if (p.osmType === 'runway') kind = 'runway';
    else if (p.osmType === 'ILS') kind = 'ils';
    else if (p.osmType === 'untagged') {
      if (nearest.d > UNTAGGED_RUNWAY_M) {
        notes.push(`${p.source} (untagged) is ${nearest.d.toFixed(0)} m from the nearest runway centerline (${target}; more than ${UNTAGGED_RUNWAY_M} m); not imported`);
        continue;
      }
      kind = 'runway';
      notes.push(`${p.source} (untagged) imported as a runway hold: runway ${target}'s centerline is ${nearest.d.toFixed(0)} m away`);
    } else {
      notes.push(`${p.source} has unknown holding_position:type "${p.osmType}"; not imported`);
      continue;
    }
    let runways = [target];
    if (kind === 'runway') {
      // Also every runway reached beyond it before another hold line (e.g. two runways close together).
      const guarded = protectedRunways(index, p.node, best.edge, blocking, runwaysAt);
      runways = [...new Set([target, ...guarded])].sort();
      if (runways.length > 1) notes.push(`${p.source} protects ${runways.join(' and ')}: no hold line between them along ${best.edge.id}`);
    }
    facingDistanceM.set(p.id, nearest.d);
    holdShorts.push({ id: p.id, kind, runways, node: p.node, towardEdge: best.edge.id });
  }
  return { holdShorts, notes, facingDistanceM };
}

/** How far (m) `p` projects past the nearer end of `runwayId`'s end-to-end line; ≤ 0 when beside it. */
function beyondRunwayEnd(index: AirportIndex, runwayId: string, p: [number, number]): number {
  const runway = index.runways.get(runwayId);
  const a = runway && index.nodes.get(runway.ends[0].node);
  const b = runway && index.nodes.get(runway.ends[1].node);
  if (!a || !b) throw new Error(`runway ${runwayId} has unknown end nodes`);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const s = ((p[0] - a.x) * (b.x - a.x) + (p[1] - a.y) * (b.y - a.y)) / len;
  return Math.max(-s, s - len);
}

function distanceToPolyline(p: [number, number], line: [number, number][]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1] as [number, number];
    const b = line[i] as [number, number];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return best;
}

/**
 * Dijkstra from `start` leaving by `first`, over non-runway edges; stops at the first node
 * where `runwaysAt` is non-empty. It never walks on past a node in `stopAt` (another hold line).
 */
function nearestRunway(index: AirportIndex, start: NodeId, first: Edge, runwaysAt: (n: NodeId) => string[], stopAt: Set<NodeId>): Reach | null {
  const best = new Map<NodeId, number>([[start, 0]]);
  const queue: [NodeId, number][] = [[otherEnd(first, start), edgeLength(index, first)]];
  while (queue.length > 0) {
    queue.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1));
    const [node, d] = queue.pop() as [NodeId, number];
    if (d > FACING_LIMIT_M) return null;
    if ((best.get(node) ?? Infinity) <= d && best.has(node)) continue;
    best.set(node, d);
    const runways = runwaysAt(node);
    if (runways.length > 0) return { edge: first, distM: d, node, runways };
    if (stopAt.has(node)) continue;
    for (const e of edgesAt(index, node)) {
      if (e.kind === 'runway') continue;
      const next = otherEnd(e, node);
      if (next === start) continue;
      const nd = d + edgeLength(index, e);
      if (nd < (best.get(next) ?? Infinity)) queue.push([next, nd]);
    }
  }
  return null;
}

/** Runways reachable through `first` without passing another blocking hold line. */
function protectedRunways(
  index: AirportIndex,
  start: NodeId,
  first: Edge,
  blocking: Set<NodeId>,
  runwaysAt: (n: NodeId) => string[],
): string[] {
  const found = new Set<string>();
  const best = new Map<NodeId, number>([[start, 0]]);
  const queue: [NodeId, number][] = [[otherEnd(first, start), edgeLength(index, first)]];
  while (queue.length > 0) {
    queue.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1));
    const [node, d] = queue.pop() as [NodeId, number];
    if (d > PROTECT_LIMIT_M) break;
    if (best.has(node) && (best.get(node) as number) <= d) continue;
    best.set(node, d);
    for (const r of runwaysAt(node)) found.add(r);
    if (blocking.has(node)) continue;
    for (const e of edgesAt(index, node)) {
      if (e.kind === 'runway') continue;
      const next = otherEnd(e, node);
      if (next === start) continue;
      const nd = d + edgeLength(index, e);
      if (nd < (best.get(next) ?? Infinity)) queue.push([next, nd]);
    }
  }
  return [...found].sort();
}

/** A LAHSO hold on runway A faces along A to the nearest node A shares with another runway. */
function lahsoHold(index: AirportIndex, p: HoldPoint, onRunway: string[]): HoldShort | string {
  if (onRunway.length !== 1) return `${p.source} (LAHSO) is on ${onRunway.length} runways (${onRunway.join(', ')}); expected exactly 1; not imported`;
  const own = onRunway[0] as string;
  let best: { edge: Edge; distM: number; runways: string[] } | null = null;
  for (const first of edgesAt(index, p.node).filter((e) => e.kind === 'runway' && e.runway === own)) {
    let node = otherEnd(first, p.node);
    let edge = first;
    let d = edgeLength(index, first);
    for (;;) {
      const others = [...new Set(edgesAt(index, node).filter((e) => e.kind === 'runway' && e.runway !== own).map((e) => e.runway as string))].sort();
      if (others.length > 0) {
        if (!best || d < best.distM) best = { edge: first, distM: d, runways: others };
        break;
      }
      const next = edgesAt(index, node).find((e) => e.kind === 'runway' && e.runway === own && e.id !== edge.id);
      if (!next) break;
      edge = next;
      node = otherEnd(next, node);
      d += edgeLength(index, next);
    }
  }
  if (!best) return `${p.source} (LAHSO) on runway ${own} has no crossing runway along it; not imported`;
  return { id: p.id, kind: 'lahso', runways: best.runways, node: p.node, towardEdge: best.edge.id };
}

/** The edge from `start` toward the nearest junction (3+ edges), following 2-edge chains. */
function towardJunction(index: AirportIndex, start: NodeId): Edge | null {
  let best: { edge: Edge; distM: number } | null = null;
  for (const first of edgesAt(index, start)) {
    let node = otherEnd(first, start);
    let edge = first;
    let d = edgeLength(index, first);
    const seen = new Set([start]);
    while (edgesAt(index, node).length === 2 && !seen.has(node)) {
      seen.add(node);
      const next = edgesAt(index, node).find((e) => e.id !== edge.id);
      if (!next) break;
      edge = next;
      node = otherEnd(next, node);
      d += edgeLength(index, next);
    }
    if (edgesAt(index, node).length >= 3 && (!best || d < best.distM || (d === best.distM && first.id < best.edge.id))) {
      best = { edge: first, distM: d };
    }
  }
  return best?.edge ?? null;
}
