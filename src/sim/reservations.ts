// Reservations: who may be where on the ground as they move, granted a piece at a time (cycle
// 9's ramp rework). It knows nothing about the ramp: a controller describes a movement, and the
// engine grants it ground ahead of its nose and takes back what it has left. The ramp
// (ramp.ts) is its only user now; see "Plugging in" for an automated ground controller.
//
// A movement (`admit`): an aircraft's body (length, span) and its path as legs. A leg is a
// track (nodes and edges, track.ts) and the nose's track distances from and to it, either way
// (`to < from` is a pushback). Its progress is the nose's travel since the start, summed over the
// legs. It's cut into segments of about SEGMENT_M of progress; one that stays at its end (an
// arrival parking) also has a zero-length last segment: exactly where it stops.
//
// What a segment covers (derived, cached by what it depends on; not state):
// - its swept shape: for each part of the rigid footprint's cross (footprint.ts: fuselage, wing,
//   tailplane), the convex hull of that part at nose positions at most SAMPLE_M apart across the
//   segment, each corner grown by MARGIN_M all round (an octagon around a circle of that radius).
//   Part by part, not one hull of the whole cross, which filled in between wingtip, nose and
//   tailplane: seed 666's EVA1126 was refused a way past a neighbour its cross cleared by 3.38 m,
//   its hull by 1.69 m (Q, 2026-11-17: relax the ramp's tolerances; investigations/
//   ramp-stuck-arrivals-seed666.md). Round, not square: 3.0 m apart in every direction, where
//   corner squares made it up to 4.24 m on a diagonal (the octagon adds at most 8%);
// - for a leg that movement.ts moves (`seeAndAvoid`), what see-and-avoid (traffic.ts) looks at:
//   its track ahead of the nose for SPACING_M (in-line), and the nodes ahead it would have to
//   stop short of if a body were near them.
// Two segments conflict if their shapes overlap, or if see-and-avoid could stop either body for
// the other (part of one on the other's track ahead within the spacing, or within its own
// half-span of a node ahead). So see-and-avoid never stops a reserved movement short of what it
// holds for another reserved body: it stays the physical safety net underneath (against bodies
// nobody reserves for, and against mistakes here), without ever adding a wait the deadlock check
// doesn't know about.
//
// Holding. A record holds a window of its segments, `lo` to `hi`: its nose may go as far as
// bounds[hi]. Its mover stops there (movement.ts treats it as a stop; the ramp's pushback stops
// there). Once a tick (`updateReservations`, before the controllers decide), each moving
// record, oldest first, gives back the segments its nose has left (its body is then wholly in
// the later ones, by construction), and asks for more, one at a time, until it holds its leg's
// lookahead past its nose. A segment is granted only if:
// 1. it conflicts with no segment any other record holds, nor with the footprint of any body on
//    the ground that no record holds for (the player's, the tower's);
// 2. and the state is still safe after it (below).
// Refused, the record says who it waits for (`waitingFor`), and movement.ts reports that as
// traffic (`stopped-for-traffic`, `blockedBy`).
//
// Records that don't move: a parked aircraft (`reserveParked`) holds its footprint for good,
// until it moves or is dropped. A movement that stays (an arrival at its gate) becomes the same
// when it finishes. A movement that leaves (a departure handed to ground) holds where it finished
// until its own body is clear of it, then goes: it's someone else's aircraft from there.
//
// Why it can't deadlock (the check, `isSafe`; banker's algorithm, for exclusive resources whose
// future use is known). Call a state safe if the moving records can be put in an order in which
// each, when its turn comes, could be granted everything it has still to be granted: nothing it
// still needs conflicts with what the records after it hold now, with where the records before
// it stopped for good, or with anything parked for good. Each of those is a rule about a pair:
// - i's remaining segments hit what j holds now: j goes before i;
// - j stays at its end, and i's remaining segments hit that end: i goes before j;
// - i's remaining segments hit something parked for good: no order works.
// So the state is safe exactly when those rules make no cycle (a topological order exists).
// - Every grant and admission keeps the state safe (it's refused otherwise), and giving back,
//   finishing and dropping only ever remove rules. So the state is always safe.
// - In a safe state, the first record in an order needs nothing anyone else holds, and granting
//   to it only adds rules "it goes first", which can't make a cycle. So it's never refused by
//   another record, and moves on: its mover stops only at its reservation's end, and
//   see-and-avoid never stops it for another reserved body (above).
// - It finishes in finite time, and the rest are still in a safe order. By induction every
//   admitted movement finishes.
// The one thing that can hold a movement up is a body nobody reserves for (rule 1, or
// see-and-avoid): the player's aircraft in the way, which the player can move. A record that
// has left (a departure handed on) is first in any order, so it adds no rule that matters; it
// waits only for its own body, which is the player's, to move off.
//
// Priority (`admit`'s `yieldTo`; for the ramp's rule that an arrival taxiing in goes before a
// pushback, ramp.ts). A movement asking to start may be told to yield to some others. It isn't
// admitted while one of them is still moving and that one's way ahead (what it holds and has
// still to be granted) conflicts with any part of its own way. The exception: its own way
// conflicts with where that one will stop for good. Then it has to go first anyway (it frees
// that place, e.g. it's leaving the gate the other is coming to), and only the rules above apply.
// Why that can't deadlock, and holds a movement back only for a while:
// - It only ever refuses an admission. A refusal changes nothing, so the state stays safe, and
//   one waiting to start holds nothing new, so no admitted movement ever waits for it. The
//   argument above, that every admitted movement finishes, is untouched.
// - So each one it yields to finishes in finite time, and holds it back only until its way ahead
//   is clear of this one's way, or it has finished. Never for good: one that will stop for good
//   in its way, the case that would wait forever, is the exception.
// - It's bounded when the set it yields to is. A controller that names only movements admitted
//   no later than this one asked to start (the ramp does) gives a fixed, finite set: this one
//   waits at most until those have passed, then it's under the rules above alone, as it would
//   have been without priority.
// - Only at admission, never on a grant to one already moving. One already moving may hold
//   what the other still needs; making it wait for that one would then be a deadlock.
//
// Plugging in (not built): an automated ground controller would turn each taxi it decides into
// a movement, with its route's track as one leg (`seeAndAvoid` true, the lookahead its stopping
// distance at its taxi speed), `admit` it, `setLeg` when it changes tracks (a re-route after
// stopping is a new movement: `dropMovement`, then `admit` again), and `finishMovement` at its
// destination (`stays` for a parking spot or a hold it will wait at; a departure handed to tower
// leaves). movement.ts already stops any aircraft at its reservation's end, whoever controls
// it, and the engine already treats every unreserved body as something to keep clear of. Two
// things would need care: runway crossings (tower's approval is a separate gate: hold the
// runway-area segments only once approved, or add the runway as a record tower holds); and
// scale, since the check is over every pair of moving records (fine for the ramp's tens; a
// whole-airport controller with a hundred might want to split the airport into areas).
//
// Not handled:
// - Ordering is first-come at each grant, not planned: a younger movement may go ahead of an
//   older one that's waiting, when a safe order allows it (unless it's told to yield, above).
//   Nothing promises a waiting movement a start: others whose ways keep crossing its first
//   segments, one after another, could keep it waiting.
// - A movement can't change its path once admitted, except by being dropped and admitted anew.
//
// Values [Builder], mine: SEGMENT_M 10 (fine enough for one aircraft to follow another closely,
// coarse enough to keep the tables small); MARGIN_M 1.5 (shapes 3 m apart at least, up to 3.25); SAMPLE_M
// 2.5 (on a straight, the hull of the samples is exactly what the body sweeps; through a bend
// the footprint turns a little between samples, which the margin is meant to cover: not
// measured).

import type { EdgeId, NodeId, Point } from '../airport/types.ts';
import { footprintOf, polygonsOverlap, type FootprintShape } from './footprint.ts';
import { buildTrack, type Track } from './track.ts';
import { SPACING_M } from './traffic.ts';
import type { Aircraft, Sim } from './world.ts';

/** A movement is cut into pieces of about this much nose travel: what it's granted and gives back. */
export const SEGMENT_M = 10;
/** Every reserved shape is grown by this much each way, so two held shapes stay this far apart twice over. */
export const MARGIN_M = 1.5;
/** Footprints are sampled at least this often along a segment's nose travel. */
const SAMPLE_M = 2.5;
/** MARGIN_M all round, as an octagon around its circle: added to every corner of a reserved shape. */
const MARGIN_OCTAGON: readonly Point[] = Array.from({ length: 8 }, (_, k) => {
  const angle = Math.PI / 8 + (k * Math.PI) / 4;
  const r = MARGIN_M / Math.cos(Math.PI / 8);
  return [r * Math.cos(angle), r * Math.sin(angle)] as Point;
});
/** The widest half-span of any type, for how far ahead a node's see-and-avoid rule can reach. */
const MAX_HALF_SPAN_M = 40;

export interface Leg {
  /** The track the aircraft is on for this leg, as nodes and edges (track.ts). */
  nodes: NodeId[];
  edges: EdgeId[];
  /** Nose track distances: where the leg starts and ends. `to < from` is backward (pushback). */
  from: number;
  to: number;
  /**
   * Whether see-and-avoid moves it on this leg (movement.ts, motion 'taxi'). Its reservations
   * then also cover whatever see-and-avoid would stop it for, so see-and-avoid never stops it
   * short of what it holds for another reserved body.
   */
  seeAndAvoid: boolean;
  /** How far past the nose it asks to hold, meters of nose travel: at least its stopping distance. */
  lookaheadM: number;
}

export interface MovementRecord {
  /** The aircraft's callsign. One record per aircraft. */
  id: string;
  lengthM: number;
  wingspanM: number;
  legs: Leg[];
  /** The leg it's on (setLeg). */
  leg: number;
  /** Segment k is nose progress bounds[k] to bounds[k + 1]: meters travelled since the start, either way. */
  bounds: number[];
  /** It holds segments lo (inclusive) to hi (exclusive): its nose may go as far as bounds[hi]. */
  lo: number;
  hi: number;
  /** At its end it stays there (an arrival parked at its gate); otherwise it leaves (a departure handed to ground). */
  stays: boolean;
  /** Finished, or never moving (parked): it holds where it is and asks for nothing. */
  done: boolean;
  /** Refused its next segment: who it's waiting for. null: not refused. */
  waitingFor: string | null;
}

export interface ReservationState {
  /** In the order made: oldest first. */
  movements: MovementRecord[];
}

export interface MovementSpec {
  id: string;
  lengthM: number;
  wingspanM: number;
  legs: Leg[];
  stays: boolean;
}

export function initialReservations(): ReservationState {
  return { movements: [] };
}

// ---------------------------------------------------------------------------------------------
// Derived, not state: segment shapes and conflicts, worked out from the records when first needed

/** Part of a body, or of the stretch ahead of a nose, on one edge: meters from `edge.from`, u0 < u1. */
interface Interval {
  edge: EdgeId;
  u0: number;
  u1: number;
  len: number;
  from: NodeId;
  to: NodeId;
}

/** A node ahead of the nose during a segment, for see-and-avoid's occupied-node rule. */
interface NodeAhead {
  node: NodeId;
  /** The node's track distance minus the nose's at the end of the segment. */
  gap: number;
  /** The track's own edges at the node (see-and-avoid's in-line rule covers those). */
  own: EdgeId[];
}

interface Segment {
  /** The swept, grown cross (the header): a hull per part, as `parts`. */
  shape: FootprintShape;
  box: [number, number, number, number];
  body: Interval[];
  ahead: Interval[];
  nodes: NodeAhead[];
}

/**
 * Conflicts between two records' segments: for each segment of the first, the segments of the
 * second it conflicts with; and for each segment of the second, the last segment of the first
 * that conflicts with it (-1: none), for the deadlock check.
 */
interface PairTable {
  conflicts: number[][];
  lastOf: number[];
}

/** By a record's key (keyOf): what its shapes depend on, so records alike share them. */
interface Cache {
  /** Each distinct key, as a small number. */
  ids: Map<string, number>;
  tracks: Map<number, Track[]>;
  segments: Map<number, Segment[]>;
  /** By the two records' keys, `a|b`. */
  pairs: Map<string, PairTable>;
}

const caches = new WeakMap<Sim, Cache>();
const keys = new WeakMap<MovementRecord, number>();

/** Everything a record's segments depend on (its body, whether it stays, and its legs), as a number. */
function keyOf(sim: Sim, rec: MovementRecord): number {
  let key = keys.get(rec);
  if (key === undefined) {
    const legs = rec.legs.map((l) => `${l.nodes.join(',')}/${l.edges.join(',')}/${l.from}/${l.to}/${l.seeAndAvoid}`);
    const text = `${rec.lengthM}/${rec.wingspanM}/${rec.stays}|${legs.join('|')}`;
    const ids = cacheOf(sim).ids;
    key = ids.get(text);
    if (key === undefined) {
      key = ids.size;
      ids.set(text, key);
    }
    keys.set(rec, key);
  }
  return key;
}

function cacheOf(sim: Sim): Cache {
  let cache = caches.get(sim);
  if (!cache) {
    cache = { ids: new Map(), tracks: new Map(), segments: new Map(), pairs: new Map() };
    caches.set(sim, cache);
  }
  return cache;
}

function tracksOf(sim: Sim, rec: MovementRecord): Track[] {
  const cache = cacheOf(sim);
  let tracks = cache.tracks.get(keyOf(sim, rec));
  if (!tracks) {
    tracks = rec.legs.map((leg) => buildTrack(sim.index, leg.nodes, leg.edges));
    cache.tracks.set(keyOf(sim, rec), tracks);
  }
  return tracks;
}

/** Where each leg starts, in progress. */
function legStarts(rec: MovementRecord): number[] {
  const starts: number[] = [];
  let p = 0;
  for (const leg of rec.legs) {
    starts.push(p);
    p += Math.abs(leg.to - leg.from);
  }
  return starts;
}

/** The leg and nose track distance at progress `p`, on the first leg that reaches it. */
function placeAt(rec: MovementRecord, p: number): { leg: number; s: number } {
  const starts = legStarts(rec);
  for (let i = 0; i < rec.legs.length; i++) {
    const leg = rec.legs[i];
    const start = starts[i];
    if (!leg || start === undefined) throw new Error(`${rec.id}: leg ${i} is missing`);
    const len = Math.abs(leg.to - leg.from);
    if (p <= start + len || i === rec.legs.length - 1) {
      const d = Math.min(Math.max(p - start, 0), len);
      return { leg: i, s: leg.to >= leg.from ? leg.from + d : leg.from - d };
    }
  }
  throw new Error(`${rec.id}: no legs`);
}

function segmentsOf(sim: Sim, rec: MovementRecord): Segment[] {
  const cache = cacheOf(sim);
  let segs = cache.segments.get(keyOf(sim, rec));
  if (segs) return segs;
  const tracks = tracksOf(sim, rec);
  segs = [];
  for (let k = 0; k + 1 < rec.bounds.length; k++) {
    const [p0, p1] = [rec.bounds[k], rec.bounds[k + 1]];
    if (p0 === undefined || p1 === undefined) throw new Error(`${rec.id}: segment ${k} has no bounds`);
    // A segment never spans two legs (bounds include every leg's ends).
    const a = placeAt(rec, p0);
    const b = placeAt(rec, Math.max(p0, p1 - 1e-9));
    const leg = rec.legs[a.leg];
    const track = tracks[a.leg];
    if (!leg || !track) throw new Error(`${rec.id}: leg ${a.leg} is missing`);
    const end = a.leg === b.leg ? b.s : leg.to;
    const [sLo, sHi] = [Math.min(a.s, end), Math.max(a.s, end)];
    const n = Math.max(1, Math.ceil((sHi - sLo) / SAMPLE_M));
    const partPoints: Point[][] = [];
    for (let i = 0; i <= n; i++) {
      const s = sLo + ((sHi - sLo) * i) / n;
      footprintAt(track, s, rec.lengthM, rec.wingspanM).parts.forEach((part, j) => {
        const into = (partPoints[j] ??= []);
        for (const [x, y] of part) for (const [dx, dy] of MARGIN_OCTAGON) into.push([x + dx, y + dy]);
      });
    }
    const parts = partPoints.map(convexHull);
    const shape: FootprintShape = Object.assign(parts.flat(), { parts });
    const xs = shape.map((p) => p[0]);
    const ys = shape.map((p) => p[1]);
    const forward = leg.to >= leg.from;
    const ahead: Interval[] = leg.seeAndAvoid && forward ? intervals(sim, track, sHi, sHi + SPACING_M + MARGIN_M) : [];
    const nodes: NodeAhead[] = [];
    if (leg.seeAndAvoid && forward) {
      track.nodes.forEach((node, j) => {
        const at = track.nodeAt[j];
        if (at === undefined || at <= sLo || at > sHi + MAX_HALF_SPAN_M + SPACING_M + MARGIN_M) return;
        nodes.push({ node, gap: at - sHi, own: [track.edges[j - 1], track.edges[j]].filter((e) => e !== undefined) });
      });
    }
    segs.push({
      shape,
      box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      body: intervals(sim, track, Math.max(0, sLo - rec.lengthM), sHi),
      ahead,
      nodes,
    });
  }
  cache.segments.set(keyOf(sim, rec), segs);
  return segs;
}

/** The rigid footprint (footprint.ts) of a body of this size with its nose at `s` on `track`. */
function footprintAt(track: Track, s: number, lengthM: number, wingspanM: number): FootprintShape {
  // footprintOf reads only the track, s, length and wingspan.
  return footprintOf({ track, s, lengthM, wingspanM } as Aircraft);
}

/** Track distances `a` to `b` (clamped to the track), as parts of edges in each edge's own frame. */
function intervals(sim: Sim, track: Track, a: number, b: number): Interval[] {
  const out: Interval[] = [];
  const [lo, hi] = [Math.max(0, a), Math.min(track.lengthM, b)];
  for (let i = 0; i < track.edges.length; i++) {
    const [id, from, start, end] = [track.edges[i], track.nodes[i], track.nodeAt[i], track.nodeAt[i + 1]];
    if (id === undefined || from === undefined || start === undefined || end === undefined) throw new Error(`track edge ${i} is missing`);
    const [x, y] = [Math.max(start, lo), Math.min(end, hi)];
    if (y <= x) continue;
    const edge = sim.index.edges.get(id);
    if (!edge) throw new Error(`no edge ${id}`);
    const len = end - start;
    const [u0, u1] = edge.from === from ? [x - start, y - start] : [len - (y - start), len - (x - start)];
    out.push({ edge: id, u0, u1, len, from: edge.from, to: edge.to });
  }
  return out;
}

/** The convex hull of `points` (monotone chain), counter-clockwise. */
function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  if (pts.length <= 2) return pts;
  const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2] as Point, lower[lower.length - 1] as Point, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i] as Point;
    while (upper.length >= 2 && cross(upper[upper.length - 2] as Point, upper[upper.length - 1] as Point, p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function boxesOverlap(a: Segment['box'], b: Segment['box']): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

/**
 * Whether see-and-avoid (traffic.ts) could stop the body of segment `x` for the body of segment
 * `y`, whose half-span is `halfY`: part of y on x's track ahead of x's nose within the spacing,
 * or y within its half-span of a node ahead that x would have to stop short of.
 */
function seeAndAvoidStops(x: Segment, y: Segment, halfY: number): boolean {
  for (const a of x.ahead) for (const b of y.body) if (a.edge === b.edge && a.u0 < b.u1 && b.u0 < a.u1) return true;
  for (const n of x.nodes) {
    if (n.gap >= halfY + SPACING_M + MARGIN_M) continue;
    for (const b of y.body) {
      if (n.own.includes(b.edge)) continue;
      const distance = b.from === n.node ? b.u0 : b.to === n.node ? b.len - b.u1 : Infinity;
      if (distance <= halfY) return true;
    }
  }
  return false;
}

function segmentsConflict(x: Segment, halfX: number, y: Segment, halfY: number): boolean {
  if (boxesOverlap(x.box, y.box) && polygonsOverlap(x.shape, y.shape)) return true;
  return seeAndAvoidStops(x, y, halfY) || seeAndAvoidStops(y, x, halfX);
}

/** The conflicts between `a`'s segments and `b`'s. Cached both ways round. */
function pairTable(sim: Sim, a: MovementRecord, b: MovementRecord): PairTable {
  const cache = cacheOf(sim);
  const [ka, kb] = [keyOf(sim, a), keyOf(sim, b)];
  const key = `${ka}|${kb}`;
  const cached = cache.pairs.get(key);
  if (cached) return cached;
  const [sa, sb] = [segmentsOf(sim, a), segmentsOf(sim, b)];
  const ab: number[][] = sa.map(() => []);
  const ba: number[][] = sb.map(() => []);
  sa.forEach((x, i) => {
    sb.forEach((y, j) => {
      if (!segmentsConflict(x, a.wingspanM / 2, y, b.wingspanM / 2)) return;
      ab[i]?.push(j);
      ba[j]?.push(i);
    });
  });
  const last = (lists: number[][]) => lists.map((l) => (l.length === 0 ? -1 : Math.max(...l)));
  const table = { conflicts: ab, lastOf: last(ba) };
  cache.pairs.set(key, table);
  cache.pairs.set(`${kb}|${ka}`, { conflicts: ba, lastOf: last(ab) });
  return table;
}

// ---------------------------------------------------------------------------------------------
// Making, granting and giving back

function boundsOf(legs: Leg[], stays: boolean): number[] {
  const bounds = [0];
  let p = 0;
  for (const leg of legs) {
    const len = Math.abs(leg.to - leg.from);
    const n = Math.max(1, Math.ceil(len / SEGMENT_M));
    for (let i = 1; i <= n; i++) bounds.push(i === n ? p + len : p + (len * i) / n);
    p += len;
  }
  // One that stays ends on a zero-length segment: exactly where it stops.
  if (stays) bounds.push(p);
  return bounds;
}

/**
 * Makes a movement for aircraft `spec.id` and grants it, all at once, everything up to nose
 * progress `atLeast` (at least its first segment), replacing any record it had (it was parked).
 * It yields to the movements named in `yieldTo` (priority, the header's "Priority"): it isn't
 * admitted while one of them, still moving, has its way ahead through any of this one's way,
 * unless this one's way is through where that one will stop for good. null: admitted. Otherwise
 * who it waits for, and nothing changes.
 */
export function admit(sim: Sim, spec: MovementSpec, atLeast = 0, yieldTo: readonly string[] = []): string | null {
  const state = sim.world.reservations;
  const rec = newRecord(spec);
  const others = state.movements.filter((m) => m.id !== spec.id);
  for (const o of others) if (yieldTo.includes(o.id) && yieldsTo(sim, rec, o)) return o.id;
  const outsiders = outsidersOf(sim).filter((o) => o.id !== spec.id);
  do {
    const blocker = grantNext(sim, rec, others, outsiders);
    if (blocker !== null) return blocker;
  } while (rec.hi + 1 < rec.bounds.length && (rec.bounds[rec.hi] ?? Infinity) < atLeast);
  state.movements = [...others, rec];
  return null;
}

/** A movement's record before anything is granted. */
function newRecord(spec: MovementSpec): MovementRecord {
  return {
    id: spec.id,
    lengthM: spec.lengthM,
    wingspanM: spec.wingspanM,
    legs: spec.legs.map((l) => ({ ...l, nodes: [...l.nodes], edges: [...l.edges] })),
    leg: 0,
    bounds: boundsOf(spec.legs, spec.stays),
    lo: 0,
    hi: 0,
    stays: spec.stays,
    done: false,
    waitingFor: null,
  };
}

/**
 * Whatever's parked for good (a record that's done and stays: an aircraft at its gate, or a gate
 * held for one coming) that any of `spec`'s way would conflict with, other than those in `ignore`:
 * the movement could never get past it, however long it waited. null: nothing. It changes nothing.
 */
export function parkedInTheWay(sim: Sim, spec: MovementSpec, ignore: readonly string[] = []): string | null {
  const rec = newRecord(spec);
  for (const o of sim.world.reservations.movements) {
    if (!o.done || !o.stays || o.id === spec.id || ignore.includes(o.id)) continue;
    if (pairTable(sim, rec, o).conflicts.some((js) => js.some((b) => b >= o.lo && b < o.hi))) return o.id;
  }
  return null;
}

/**
 * Whether `rec`, not yet admitted, must wait for `o`, a movement it yields to: `o` is still
 * moving, its way ahead (what it holds and has still to be granted) conflicts with some of
 * `rec`'s way, and `rec`'s way doesn't conflict with where `o` stops for good (then `rec` has to
 * go first: it frees that place, e.g. the gate `o` is coming to).
 */
function yieldsTo(sim: Sim, rec: MovementRecord, o: MovementRecord): boolean {
  if (o.done) return false;
  if (o.stays && futureHitsEnd(sim, rec, o)) return false;
  return pairTable(sim, rec, o).conflicts.some((js) => js.some((j) => j >= o.lo));
}

/** Whether `id`'s movement holds all the way to its end (so it may finish). */
export function holdsEnd(sim: Sim, id: string): boolean {
  const rec = recordOf(sim, id);
  return rec !== undefined && !rec.done && rec.hi === rec.bounds.length - 1;
}

/** A body on the ground that no record holds for (the player's, the tower's): where it is now. */
interface Outsider {
  id: string;
  footprint: Point[];
  box: Segment['box'];
}

/** Every body on the ground with no record. */
function outsidersOf(sim: Sim): Outsider[] {
  const held = new Set(sim.world.reservations.movements.map((m) => m.id));
  const out: Outsider[] = [];
  for (const ac of sim.world.aircraft) {
    if (ac.airborne || held.has(ac.callsign)) continue;
    const footprint = footprintOf(ac);
    const xs = footprint.map((p) => p[0]);
    const ys = footprint.map((p) => p[1]);
    out.push({ id: ac.callsign, footprint, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
  }
  return out;
}

/**
 * Grants `rec` its next segment if no one else holds a conflicting one: its hi goes up. null:
 * granted. Otherwise who's in the way.
 */
function grantNext(sim: Sim, rec: MovementRecord, others: MovementRecord[], outsiders: Outsider[]): string | null {
  const x = rec.hi;
  for (const o of others) {
    const table = pairTable(sim, rec, o).conflicts[x] ?? [];
    if (table.some((b) => b >= o.lo && b < o.hi)) return o.id;
  }
  const seg = segmentsOf(sim, rec)[x];
  if (!seg) throw new Error(`${rec.id}: no segment ${x}`);
  for (const o of outsiders) if (o.id !== rec.id && boxesOverlap(seg.box, o.box) && polygonsOverlap(seg.shape, o.footprint)) return o.id;
  rec.hi += 1;
  const all = [...others, rec];
  if (isSafe(sim, all)) return null;
  rec.hi -= 1;
  return culprit(sim, rec, others);
}

/** Whether anything `i` has still to be granted conflicts with what `j` holds now. */
function futureHitsHeld(sim: Sim, i: MovementRecord, j: MovementRecord): boolean {
  const { lastOf } = pairTable(sim, i, j);
  for (let b = j.lo; b < j.hi; b++) if ((lastOf[b] ?? -1) >= i.hi) return true;
  return false;
}

/** Whether anything `i` has still to be granted conflicts with where `j` will stop for good. */
function futureHitsEnd(sim: Sim, i: MovementRecord, j: MovementRecord): boolean {
  return (pairTable(sim, i, j).lastOf[j.bounds.length - 2] ?? -1) >= i.hi;
}

/**
 * Whether every moving record can still finish (the deadlock check): there's an order to
 * finish them in where each, when its turn comes, needs nothing held by those still to go,
 * nor where those gone before stopped for good, nor anything parked for good. Those are
 * pairwise rules, so such an order exists exactly when they make no cycle:
 * - i's remaining way hits what j holds: j goes first.
 * - j stays at its end, and i's remaining way hits it: i goes first.
 * - i's remaining way hits a record parked for good: never.
 * A record that leaves once it's done (a departure handed on) holds only until its body has
 * gone, so it's first in any order: it adds no rule that can make a cycle, and isn't counted.
 */
function isSafe(sim: Sim, recs: MovementRecord[]): boolean {
  const moving = recs.filter((r) => !r.done);
  const parked = recs.filter((r) => r.done && r.stays);
  for (const i of moving) for (const d of parked) if (futureHitsHeld(sim, i, d)) return false;
  // before[n]: the indices in `moving` that must finish before moving[n].
  const before = moving.map(() => new Set<number>());
  moving.forEach((i, a) => {
    moving.forEach((j, b) => {
      if (a === b) return;
      if (futureHitsHeld(sim, i, j)) before[a]?.add(b);
      if (j.stays && futureHitsEnd(sim, i, j)) before[b]?.add(a);
    });
  });
  // Kahn: repeatedly finish one with nothing left before it.
  const left = new Set(moving.map((_, n) => n));
  let progress = true;
  while (left.size > 0 && progress) {
    progress = false;
    for (const n of left) {
      if ([...(before[n] ?? [])].some((m) => left.has(m))) continue;
      left.delete(n);
      progress = true;
    }
  }
  return left.size === 0;
}

/** Who `rec` waits for, refused a segment as unsafe: one that must finish before it. */
function culprit(sim: Sim, rec: MovementRecord, others: MovementRecord[]): string {
  for (const o of others) if (o.done && o.stays && futureHitsHeld(sim, rec, o)) return o.id;
  for (const o of others) if (!o.done && futureHitsHeld(sim, rec, o)) return o.id;
  for (const o of others) if (!o.done && rec.stays && futureHitsEnd(sim, o, rec)) return o.id;
  const other = others.find((o) => !o.done) ?? others[0];
  if (!other) throw new Error(`${rec.id}: refused with no one else holding anything`);
  return other.id;
}

export interface ParkedSpec {
  id: string;
  /** The aircraft's track, and its nose on it. */
  nodes: NodeId[];
  edges: EdgeId[];
  s: number;
  lengthM: number;
  wingspanM: number;
}

/**
 * Holds where an aircraft is parked, for good (until it moves, or is dropped), replacing any
 * record it had. null: done. Otherwise who's in the way (holding a conflicting segment, or
 * moving with that place still ahead of it), and nothing changes.
 */
export function reserveParked(sim: Sim, spec: ParkedSpec): string | null {
  const { rec, blocker } = tryParked(sim, spec);
  if (blocker !== null) return blocker;
  const state = sim.world.reservations;
  state.movements = [...state.movements.filter((m) => m.id !== spec.id), rec];
  return null;
}

/** Who'd be in the way of reserveParked(spec), or null. It changes nothing. */
export function parkedConflict(sim: Sim, spec: ParkedSpec): string | null {
  return tryParked(sim, spec).blocker;
}

function tryParked(sim: Sim, spec: ParkedSpec): { rec: MovementRecord; blocker: string | null } {
  const state = sim.world.reservations;
  const rec: MovementRecord = {
    id: spec.id,
    lengthM: spec.lengthM,
    wingspanM: spec.wingspanM,
    legs: [{ nodes: [...spec.nodes], edges: [...spec.edges], from: spec.s, to: spec.s, seeAndAvoid: false, lookaheadM: 0 }],
    leg: 0,
    bounds: [0, 0],
    lo: 0,
    hi: 1,
    stays: true,
    done: true,
    waitingFor: null,
  };
  const others = state.movements.filter((m) => m.id !== spec.id);
  for (const o of others) if ((pairTable(sim, rec, o).conflicts[0] ?? []).some((b) => b >= o.lo && b < o.hi)) return { rec, blocker: o.id };
  if (!isSafe(sim, [...others, rec])) {
    const mover = others.find((o) => !o.done && futureHitsHeld(sim, o, rec));
    if (!mover) throw new Error(`${spec.id}: parking it is unsafe, but no movement has it ahead`);
    return { rec, blocker: mover.id };
  }
  return { rec, blocker: null };
}

/** The movement has moved on to leg `leg` (its controller has put the aircraft on that leg's track). */
export function setLeg(sim: Sim, id: string, leg: number): void {
  const rec = recordOf(sim, id);
  if (!rec || rec.done || leg < 0 || leg >= rec.legs.length) throw new Error(`${id}: no leg ${leg} to move on to`);
  rec.leg = leg;
}

/**
 * The movement is at its end. One that stays keeps holding where it stopped, for good (until
 * dropped). One that leaves keeps holding where it stopped until its body is clear of it: it's
 * someone else's now (a departure handed to ground), and it moves off on another track.
 */
export function finishMovement(sim: Sim, id: string): void {
  const rec = recordOf(sim, id);
  if (!rec || rec.done) throw new Error(`${id}: no movement to finish`);
  const last = rec.bounds.length - 2;
  if (rec.hi !== last + 1) throw new Error(`${id}: finished without holding its end`);
  [rec.lo, rec.done, rec.waitingFor] = [last, true, null];
}

/** Forgets everything `id` holds: it has left the sim (removeAircraft). */
export function dropMovement(sim: Sim, id: string): void {
  const state = sim.world.reservations;
  state.movements = state.movements.filter((m) => m.id !== id);
}

/**
 * Where `ac` must stop on its current track for what it holds: the end of its reservation, if
 * that's on this leg, and who it's waiting for (null: no one, it just hasn't asked that far).
 * null: no stop (no movement, finished, or it holds past this leg's end).
 */
export function reservedStop(sim: Sim, ac: Aircraft): { at: number; behind: string | null } | null {
  const rec = recordOf(sim, ac.callsign);
  if (!rec || rec.done) return null;
  const limit = rec.bounds[rec.hi] ?? Infinity;
  const leg = rec.legs[rec.leg];
  const start = legStarts(rec)[rec.leg];
  if (!leg || start === undefined) throw new Error(`${rec.id}: leg ${rec.leg} is missing`);
  const d = Math.max(0, limit - start);
  // At (or within rounding of) the leg's end: the track's own end stops it there.
  if (d >= Math.abs(leg.to - leg.from) - 1e-9) return null;
  return { at: leg.to >= leg.from ? leg.from + d : leg.from - d, behind: rec.waitingFor };
}

function recordOf(sim: Sim, id: string): MovementRecord | undefined {
  return sim.world.reservations.movements.find((m) => m.id === id);
}

/** The aircraft's nose progress on its record's current leg. */
function progressOf(sim: Sim, rec: MovementRecord): number | null {
  const ac = sim.world.aircraft.find((a) => a.callsign === rec.id);
  if (!ac) return null;
  const leg = rec.legs[rec.leg];
  const start = legStarts(rec)[rec.leg];
  if (!leg || start === undefined) throw new Error(`${rec.id}: leg ${rec.leg} is missing`);
  const len = Math.abs(leg.to - leg.from);
  return start + Math.min(Math.max(Math.abs(ac.s - leg.from), 0), len);
}

/**
 * Once a tick, before the controllers decide: each moving record, oldest first, gives back the
 * segments its nose has left, then asks for more until it holds its leg's lookahead past its nose.
 */
export function updateReservations(sim: Sim): void {
  const state = sim.world.reservations;
  // One that has left holds where it finished until its body is clear of it (or gone).
  state.movements = state.movements.filter((rec) => {
    if (!rec.done || rec.stays) return true;
    const ac = sim.world.aircraft.find((a) => a.callsign === rec.id);
    if (!ac) return false;
    const footprint = footprintOf(ac);
    return segmentsOf(sim, rec)
      .slice(rec.lo, rec.hi)
      .some((seg) => polygonsOverlap(seg.shape, footprint));
  });
  const outsiders = outsidersOf(sim);
  for (const rec of state.movements) {
    if (rec.done) continue;
    const p = progressOf(sim, rec);
    if (p === null) continue;
    while (rec.lo + 1 < rec.hi && (rec.bounds[rec.lo + 1] ?? Infinity) <= p) rec.lo += 1;
    const leg = rec.legs[rec.leg];
    if (!leg) throw new Error(`${rec.id}: leg ${rec.leg} is missing`);
    const want = p + leg.lookaheadM;
    const others = state.movements.filter((m) => m !== rec);
    rec.waitingFor = null;
    while (rec.hi + 1 < rec.bounds.length && (rec.bounds[rec.hi] ?? Infinity) < want) {
      const blocker = grantNext(sim, rec, others, outsiders);
      if (blocker !== null) {
        rec.waitingFor = blocker;
        break;
      }
    }
  }
}
