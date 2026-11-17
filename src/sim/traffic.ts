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
// - Footprints (the seed-6 fix, investigations/seed6-head-on.md): its own footprint (footprint.ts,
//   the shape 1.12's collision rule uses), swept along its track ahead, first overlapping another
//   body's footprint. It must keep its nose SPACING_M short of that point. The two rules above go
//   by the graph: a body on an edge it will use, or at a node it will pass, measured along the
//   track. The plane can disagree:
//   - Two nodes close in the plane with no edge between them (KJFK's twin ramp edges, e.g. T7's
//     rhW and rhW2, 2.4 m apart, until 1.13c merged them; traffic.test.ts keeps that geometry): a
//     body at one is on neither, so only this rule sees it.
//   - A body past a sharp bend (KJFK's NA stub, doubling back off A): along the track it's far
//     ahead, but its wing is beside the track before the bend.
//   For a body the graph's rules found, it counts only if the contact comes at or before their
//   stop for it, where their stop wouldn't keep them apart. Otherwise theirs stands, so nothing
//   changes where they work: applied to every body, it holds a queue looser through bends (a
//   follower's wing reaches the leader's footprint before its nose reaches the tail, though not
//   before the in-line stop), and that cost a mixed runway takeoffs (tower-capacity.test.ts) with
//   nothing there overlapping. It stops only for an overlap, never for a near miss.
//   - A movement the reservations hold (reservations.ts) isn't stopped this way for a body they
//     hold too: they keep those footprints apart already, with a margin, and their header
//     promises see-and-avoid never stops one short of what it holds for another.
//   - Already overlapping a body: not this rule's business (it's a collision); it doesn't stop.
//   - Airborne, it has no footprint on the ground (rules.ts), so it doesn't sweep one.
// - Converging (investigations/merge-throughput-17-takeoffs.md): at a junction ahead (a node of 3
//   or more edges), another mover coming in on a different edge, neither following it nor
//   head-on along its own route (in-line covers both), that will go through first. It must keep
//   its nose the mover's half-span plus SPACING_M short of the junction, as for an occupied node.
//   The rules above see only where bodies are now, so two movers converging on a free junction
//   saw each other too late to stop. Pilots don't pull out in front of moving traffic, or drive
//   into one that's pulling out: this is that, not the player's give-way (PRD C11).
//   - A mover taxis (motion 'taxi'), isn't held (no hold position, a clearance or the ramp's
//     track, and its mandatory stop beyond the junction), and isn't waiting (stopped, blocked).
//     One that's waiting yields to every mover; movers don't yield to it.
//   - Who goes first, decided the same way from both sides: one that can no longer stop short of
//     its yield point at MAX_DECEL_MPS2; then the earlier arrival at the junction, at its present
//     speed (at least ETA_FLOOR_MPS); then callsign order, so a tie never leaves both waiting.
//   - Once the first one's nose is past the junction, the rules above take over: an occupied
//     node while its wings are over it, then in line if it leaves on the yielder's next edge.
//   - Two movements the reservations hold aren't stopped this way for each other, as above.
// It plans to stop there at the planned braking rate. A body ahead never moves back (no
// reversing), so planning against where it is now is safe.
//
// Not handled:
// - Right of way, give-way, and gridlock resolution (two aircraft each waiting for the other).

import { edgesAt, type AirportIndex } from '../airport/graph.ts';
import type { EdgeId, NodeId, Point } from '../airport/types.ts';
import { MAX_DECEL_MPS2 } from './braking.ts';
import { footprintOf, polygonsOverlap, type FootprintShape } from './footprint.ts';
import { bodySpans } from './occupancy.ts';
import { nextStop } from './stops.ts';
import { placeOf, pointOf, type Track } from './track.ts';
import type { Aircraft, Sim } from './world.ts';

/** Nose-to-tail spacing behind traffic, when stopped: about a quarter of a widebody's length. */
export const SPACING_M = 20;
/**
 * Once stopped for traffic, an aircraft waits until it could move at least this far. Without
 * it, a follower would stop and start behind a leader creeping onto its own stop point.
 */
export const RESTART_M = 2;
/**
 * The footprint sweep's sample spacing, meters of nose travel. [Builder], mine: about one tick's
 * travel at 20 kt, the spacing the collision rule itself samples at. The first overlap found is
 * then pinned down to CONTACT_TOLERANCE_M.
 */
export const SWEEP_STEP_M = 1;
const CONTACT_TOLERANCE_M = 1e-3;
/**
 * The converging rule's slowest speed for an arrival time: a stopped or crawling mover still gets
 * a finite one, so the nearer of two goes first. [Builder], mine: about 4 kt.
 */
export const ETA_FLOOR_MPS = 2;

/** Part of a body on one edge, in the edge's own frame: meters from `edge.from`, u0 < u1. */
interface Occupant {
  callsign: string;
  wingspanM: number;
  u0: number;
  u1: number;
  /** The edge's length, as the occupant's track measures it. */
  edgeLengthM: number;
}

/** A body's footprint (footprint.ts) and its bounding box: min x, min y, max x, max y. */
interface Body {
  callsign: string;
  shape: FootprintShape;
  box: Box;
}

type Box = [number, number, number, number];

/** An aircraft that taxis, coming up to a junction ahead of its nose (the header's "Converging"). */
interface Approach {
  callsign: string;
  wingspanM: number;
  v: number;
  /** Meters along its track from the nose to the junction. */
  distanceM: number;
  /** The edge it comes in on. */
  via: EdgeId;
  /** Stopped, blocked by traffic: it yields to every mover, and no one yields to it. */
  waiting: boolean;
}

/** Where every body is, at the start of a tick. */
export interface Occupancy {
  byEdge: Map<EdgeId, Occupant[]>;
  /** Bodies that are just a node: parked with no trail. */
  byNode: Map<NodeId, Occupant[]>;
  /** Every body on the ground, as its footprint. */
  bodies: Body[];
  /** The aircraft the reservations hold ground for (reservations.ts): moving, finished or parked. */
  reserved: ReadonlySet<string>;
  /** Of those, the ones with a movement under way (not done). */
  reservedMoving: ReadonlySet<string>;
  /** For each junction, the aircraft coming up to it that will go through it, nearest first. */
  approaches: Map<NodeId, Approach[]>;
}

export function occupancyOf(sim: Sim): Occupancy {
  const byEdge = new Map<EdgeId, Occupant[]>();
  const byNode = new Map<NodeId, Occupant[]>();
  const bodies: Body[] = [];
  const approaches = new Map<NodeId, Approach[]>();
  const add = <K>(map: Map<K, Occupant[]>, key: K, o: Occupant) => {
    const list = map.get(key);
    if (list) list.push(o);
    else map.set(key, [o]);
  };
  for (const ac of sim.world.aircraft) {
    // On final or after takeoff: no one's traffic (world.ts).
    if (ac.airborne) continue;
    bodies.push(bodyOf(ac));
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
    for (const [node, approach] of approachesOf(sim, ac)) {
      const list = approaches.get(node);
      if (list) list.push(approach);
      else approaches.set(node, [approach]);
    }
  }
  const movements = sim.world.reservations.movements;
  const reserved = new Set(movements.map((m) => m.id));
  const reservedMoving = new Set(movements.filter((m) => !m.done).map((m) => m.id));
  return { byEdge, byNode, bodies, reserved, reservedMoving, approaches };
}

/** The junctions `ac` will go through before its mandatory stop, if it taxis and isn't held. */
function approachesOf(sim: Sim, ac: Aircraft): [NodeId, Approach][] {
  if (ac.motion !== 'taxi' || ac.holdPosition || (ac.clearance === null && ac.controller !== 'ramp')) return [];
  const { nodes, edges, nodeAt } = ac.track;
  const stopAt = nextStop(sim.index, ac).at;
  const waiting = ac.v === 0 && ac.blockedBy !== null;
  const found: [NodeId, Approach][] = [];
  for (let j = 1; j < nodes.length; j++) {
    const [node, at, via] = [nodes[j], nodeAt[j], edges[j - 1]];
    if (node === undefined || at === undefined || via === undefined) throw new Error(`${ac.callsign}: track node ${j} is missing`);
    if (at <= ac.s) continue;
    if (at >= stopAt) break;
    if (edgesAt(sim.index, node).length < 3) continue;
    found.push([node, { callsign: ac.callsign, wingspanM: ac.wingspanM, v: ac.v, distanceM: at - ac.s, via, waiting }]);
  }
  return found;
}

/**
 * Bodies' footprints, reused while an aircraft stays at the same place on the same track: most
 * aircraft on the ground are standing (parked, idle, holding), and a footprint is most of the
 * cost. As rules.ts's parked shapes: derived from the world, not state. A track is replaced,
 * never changed in place, so the track object and `s` identify the place.
 */
const bodyCache = new WeakMap<Aircraft, { track: Track; s: number; body: Body }>();

function bodyOf(ac: Aircraft): Body {
  const cached = bodyCache.get(ac);
  if (cached && cached.track === ac.track && cached.s === ac.s) return cached.body;
  const shape = footprintOf(ac);
  const body = { callsign: ac.callsign, shape, box: boxOf(shape) };
  bodyCache.set(ac, { track: ac.track, s: ac.s, body });
  return body;
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
  /** For each body the graph's rules (in-line, occupied nodes) found ahead, their nearest stop for it. */
  const graphStops = new Map<string, number>();
  const consider = (at: number, behind: string) => {
    if (best === null || at < best.at) best = { at, behind };
  };
  const considerGraph = (at: number, behind: string) => {
    graphStops.set(behind, Math.min(at, graphStops.get(behind) ?? Infinity));
    consider(at, behind);
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
      considerGraph(Math.max(t0, ac.s) - SPACING_M, o.callsign);
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
      if (o.callsign !== ac.callsign) considerGraph(at - (o.wingspanM / 2 + SPACING_M), o.callsign);
    }
  }

  // Converging movers, at junctions ahead.
  if (ac.motion === 'taxi') {
    for (let j = 1; j < nodes.length; j++) {
      const [node, at] = [nodes[j], nodeAt[j]];
      if (node === undefined || at === undefined) throw new Error(`${ac.callsign}: track node ${j} is missing`);
      if (at <= ac.s) continue;
      if (at > horizon) break;
      const approaches = occupancy.approaches.get(node) ?? [];
      const own = approaches.find((x) => x.callsign === ac.callsign);
      // Not going through it (held short of it, or its stop is there): nothing to yield for.
      if (own === undefined) continue;
      for (const other of approaches) {
        if (other.callsign === ac.callsign || other.waiting) continue;
        if (other.distanceM > lookaheadM || other.via === edges[j - 1] || other.via === edges[j]) continue;
        if (occupancy.reservedMoving.has(ac.callsign) && occupancy.reservedMoving.has(other.callsign)) continue;
        if (goesFirst(other, own)) considerGraph(at - (other.wingspanM / 2 + SPACING_M), other.callsign);
      }
    }
  }

  // Footprints ahead. A contact past the nearest stop so far (plus the spacing) can't come nearer.
  // (`consider` sets `best` in a closure, which TypeScript's narrowing doesn't see.)
  const nearest = best as TrafficStop | null;
  const limit = nearest === null ? horizon : Math.min(horizon, nearest.at + SPACING_M);
  for (const { at, behind } of footprintStops(occupancy, ac, limit, graphStops)) consider(at, behind);
  return best;
}

/**
 * For each body its own footprint would first overlap, swept along its track up to `horizon`:
 * SPACING_M short of that point (the header's "Footprints"). For a body in `graphStops` (the
 * graph's rules found it), only a contact at or before their stop for it counts: one after it,
 * their stop already keeps them apart. The point is pinned down to within CONTACT_TOLERANCE_M on
 * its overlapping side. Each body's sweep also ends at the nearest contact found so far: a later
 * one can't give a nearer stop.
 */
function footprintStops(occupancy: Occupancy, ac: Aircraft, horizon: number, graphStops: ReadonlyMap<string, number>): TrafficStop[] {
  const track = ac.track;
  let end = Math.min(horizon, track.lengthM);
  if (ac.airborne || end <= ac.s) return [];
  const own = bodyOf(ac);
  const nose = pointOf(track, ac.s).point;
  // The footprint is rigid about the nose, so every part of it is always within this of the nose.
  const reach = Math.max(...own.shape.map(([x, y]) => Math.hypot(x - nose[0], y - nose[1])));
  const corridor = corridorBox(track, ac.s, end, reach);
  const reservedMover = occupancy.reservedMoving.has(ac.callsign);
  const overlapsAt = (s: number, body: Body) => {
    const shape = footprintOf({ ...ac, s });
    return boxesOverlap(boxOf(shape), body.box) && polygonsOverlap(shape, body.shape);
  };
  const stops: TrafficStop[] = [];
  for (const body of occupancy.bodies) {
    if (body.callsign === ac.callsign) continue;
    if (reservedMover && occupancy.reserved.has(body.callsign)) continue;
    const bodyEnd = Math.min(end, graphStops.get(body.callsign) ?? Infinity);
    if (bodyEnd <= ac.s || !boxesOverlap(corridor, body.box)) continue;
    if (boxesOverlap(own.box, body.box) && polygonsOverlap(own.shape, body.shape)) continue;
    // Samples SWEEP_STEP_M apart, up to `bodyEnd`. `clear`: the farthest point known not to overlap.
    let clear = ac.s;
    let s = ac.s;
    while (s < bodyEnd) {
      s = Math.min(s + SWEEP_STEP_M, bodyEnd);
      const gap = distanceToBox(pointOf(track, s).point, body.box) - reach;
      if (gap > 0) {
        // Out of reach here, and the nose moves no farther than its travel along the track: so
        // out of reach for `gap` more.
        s = clear = Math.min(s + gap, bodyEnd);
        continue;
      }
      if (!overlapsAt(s, body)) {
        clear = s;
        continue;
      }
      let hit = s;
      while (hit - clear > CONTACT_TOLERANCE_M) {
        const mid = (clear + hit) / 2;
        if (overlapsAt(mid, body)) hit = mid;
        else clear = mid;
      }
      stops.push({ at: hit - SPACING_M, behind: body.callsign });
      end = Math.min(end, hit);
      break;
    }
  }
  return stops;
}

/**
 * Of two aircraft coming up to the same junction, whether `a` goes through before `b` (the
 * header's "Converging"): the same answer whichever of them asks.
 */
function goesFirst(a: Approach, b: Approach): boolean {
  if (a.waiting !== b.waiting) return b.waiting;
  const committed = (x: Approach, other: Approach) => (x.v * x.v) / (2 * MAX_DECEL_MPS2) > x.distanceM - (other.wingspanM / 2 + SPACING_M);
  const [ca, cb] = [committed(a, b), committed(b, a)];
  if (ca !== cb) return ca;
  const [ta, tb] = [a.distanceM / Math.max(a.v, ETA_FLOOR_MPS), b.distanceM / Math.max(b.v, ETA_FLOOR_MPS)];
  if (ta !== tb) return ta < tb;
  return a.callsign < b.callsign;
}

function boxOf(points: readonly Point[]): Box {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** The box around the track from `s0` to `s1`, grown by `pad` each way. */
function corridorBox(track: Track, s0: number, s1: number, pad: number): Box {
  const points: Point[] = [pointOf(track, s0).point, pointOf(track, s1).point];
  track.points.forEach((p, i) => {
    const at = track.pointAt[i];
    if (at !== undefined && at > s0 && at < s1) points.push(p);
  });
  const [x0, y0, x1, y1] = boxOf(points);
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

function boxesOverlap(a: Box, b: Box): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

function distanceToBox(p: Point, box: Box): number {
  const dx = Math.max(box[0] - p[0], 0, p[0] - box[2]);
  const dy = Math.max(box[1] - p[1], 0, p[1] - box[3]);
  return Math.hypot(dx, dy);
}
