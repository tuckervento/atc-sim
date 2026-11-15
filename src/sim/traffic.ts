// See-and-avoid (PRD §4.8, §8.2): aircraft stop for traffic ahead rather than hit it.
//
// Every tick, each aircraft looks along its own track ahead of its nose (within the lookahead)
// for two things, using every body's position at the start of the tick:
// - In line: any part of another body on its track's edges ahead, either way round. It must
//   keep its nose SPACING_M short of the nearest part.
// - An occupied node: at a node ahead, another body on one of the node's other edges (not the
//   track's own), or parked on the node itself, that comes within its own half-span of the
//   node, so its wings may be over the junction. It must keep its nose that half-span plus
//   SPACING_M short of the node.
// It plans to stop there at the planned braking rate. A body ahead never moves back (no
// reversing), so planning against where it is now is safe.
//
// Not handled:
// - Two aircraft converging on a free junction at once: neither occupies it yet, so neither
//   waits. The first to reach it occupies it; the other stops only if it still can, braking at
//   the hard limit, and may overlap otherwise. That's 1.12's collision check to catch.
// - Right of way, give-way, and gridlock resolution (two aircraft each waiting for the other).

import { edgesAt, type AirportIndex } from '../airport/graph.ts';
import type { EdgeId, NodeId } from '../airport/types.ts';
import { bodySpans } from './occupancy.ts';
import { placeOf } from './track.ts';
import type { Aircraft, Sim } from './world.ts';

/** Nose-to-tail spacing behind traffic, when stopped: about a quarter of a widebody's length. */
export const SPACING_M = 20;
/**
 * Once stopped for traffic, an aircraft waits until it could move at least this far. Without
 * it, a follower would stop and start behind a leader creeping onto its own stop point.
 */
export const RESTART_M = 2;

/** Part of a body on one edge, in the edge's own frame: meters from `edge.from`, u0 < u1. */
interface Occupant {
  callsign: string;
  wingspanM: number;
  u0: number;
  u1: number;
  /** The edge's length, as the occupant's track measures it. */
  edgeLengthM: number;
}

/** Where every body is, at the start of a tick. */
export interface Occupancy {
  byEdge: Map<EdgeId, Occupant[]>;
  /** Bodies that are just a node: parked with no trail. */
  byNode: Map<NodeId, Occupant[]>;
}

export function occupancyOf(sim: Sim): Occupancy {
  const byEdge = new Map<EdgeId, Occupant[]>();
  const byNode = new Map<NodeId, Occupant[]>();
  const add = <K>(map: Map<K, Occupant[]>, key: K, o: Occupant) => {
    const list = map.get(key);
    if (list) list.push(o);
    else map.set(key, [o]);
  };
  for (const ac of sim.world.aircraft) {
    // On final or after takeoff: no one's traffic (world.ts).
    if (ac.airborne) continue;
    const { nodes, edges, nodeAt } = ac.track;
    const spans = bodySpans(ac);
    if (spans.length === 0) {
      const place = placeOf(ac.track, ac.s);
      const node = nodes[place.i];
      if (place.kind !== 'node' || node === undefined) throw new Error(`${ac.callsign}: a body with no extent must be on a node`);
      add(byNode, node, { callsign: ac.callsign, wingspanM: ac.wingspanM, u0: 0, u1: 0, edgeLengthM: 0 });
    }
    for (const { i, a, b } of spans) {
      const [id, from, start, end] = [edges[i], nodes[i], nodeAt[i], nodeAt[i + 1]];
      const edge = id === undefined ? undefined : sim.index.edges.get(id);
      if (!edge || from === undefined || start === undefined || end === undefined) throw new Error(`${ac.callsign}: track edge ${i} is missing`);
      const len = end - start;
      const forward = edge.from === from;
      const [u0, u1] = forward ? [a - start, b - start] : [len - (b - start), len - (a - start)];
      add(byEdge, edge.id, { callsign: ac.callsign, wingspanM: ac.wingspanM, u0, u1, edgeLengthM: len });
    }
  }
  return { byEdge, byNode };
}

/** Where an aircraft must stop for traffic: distance along its track, and who's in the way. */
export interface TrafficStop {
  at: number;
  behind: string;
}

/** The nearest point ahead (within `lookaheadM`) where `ac` must stop for traffic. null: none. */
export function trafficStop(index: AirportIndex, occupancy: Occupancy, ac: Aircraft, lookaheadM: number): TrafficStop | null {
  const { nodes, edges, nodeAt } = ac.track;
  const horizon = ac.s + lookaheadM;
  let best: TrafficStop | null = null;
  const consider = (at: number, behind: string) => {
    if (best === null || at < best.at) best = { at, behind };
  };

  // In line, from the edge the nose is on (or about to enter).
  for (let i = placeOf(ac.track, ac.s).i; i < edges.length; i++) {
    const [id, from, start, end] = [edges[i], nodes[i], nodeAt[i], nodeAt[i + 1]];
    if (id === undefined || from === undefined || start === undefined || end === undefined) throw new Error(`${ac.callsign}: track edge ${i} is missing`);
    if (start > horizon) break;
    const edge = index.edges.get(id);
    if (!edge) throw new Error(`${ac.callsign}: unknown edge "${id}"`);
    const len = end - start;
    for (const o of occupancy.byEdge.get(id) ?? []) {
      if (o.callsign === ac.callsign) continue;
      const [t0, t1] = edge.from === from ? [start + o.u0, start + o.u1] : [start + len - o.u1, start + len - o.u0];
      if (t1 <= ac.s) continue; // behind the nose
      consider(Math.max(t0, ac.s) - SPACING_M, o.callsign);
    }
  }

  // Occupied nodes ahead.
  for (let j = 0; j < nodes.length; j++) {
    const [node, at] = [nodes[j], nodeAt[j]];
    if (node === undefined || at === undefined) throw new Error(`${ac.callsign}: track node ${j} is missing`);
    if (at <= ac.s) continue;
    if (at > horizon) break;
    const own = new Set([edges[j - 1], edges[j]]);
    const near: Occupant[] = [...(occupancy.byNode.get(node) ?? [])];
    for (const edge of edgesAt(index, node)) {
      if (own.has(edge.id)) continue;
      for (const o of occupancy.byEdge.get(edge.id) ?? []) {
        const distance = edge.from === node ? o.u0 : o.edgeLengthM - o.u1;
        if (distance <= o.wingspanM / 2) near.push(o);
      }
    }
    for (const o of near) {
      if (o.callsign !== ac.callsign) consider(at - (o.wingspanM / 2 + SPACING_M), o.callsign);
    }
  }
  return best;
}
