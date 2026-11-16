// Rule checks (PLAN 1.12, PRD §4.5, §4.8, §8.6). They run last in every tick (sim.ts, `advance`),
// on the state the tick left and the events it emitted, while the session is running:
// - Collision: two aircraft footprints overlap (footprint.ts). It ends the session.
//   - Airborne aircraft (on final, or after lift-off) have no footprint on the ground.
//   - The cause names both aircraft, where (the point between them, the runway areas they're in)
//     and who was moving each (`controller`), summed up as `origin`: 'player' if both were
//     ground's, 'sim' if neither was, 'mixed' otherwise. 'mixed' needs judgement: a tower
//     departure hitting a crosser is the player's if the crossing was unauthorized (the record
//     says so), tower's if it was approved.
//   - A collision the sim caused ('sim') ends the session the same way. It's a sim bug, and
//     ending loudly is how it gets seen and fixed (PRD §11: no phantom collisions); the origin
//     tells it apart on the end screen and in the soak tests (1.14).
//   - The first overlapping pair in the order added is the cause, if several overlap at once.
// - Unauthorized crossing (PRD §4.5): an `entered-runway` event with `cleared` (the player's
//   crossing clearance took the nose past a runway hold line) when tower has no current approval
//   (`world.tower.approvals`) for that aircraft at that hold line. Counted once per event, and
//   recorded for the later delay and score reports.
//   - When: the check runs at the end of the tick the nose passed the line. Tower drops an
//     approval only in a later tick's decide (tower.ts, `trackApprovals`), once the body has
//     been on the runway and left it; it cancels one (unused for a minute, or landing traffic)
//     in its decide, before anything moves. So an approval current when the nose passed the line
//     is still there at the end of the tick, and one cancelled first isn't.
//   - Which approval: tower approves a crossing at one hold line ("cross 27 at C"), so it must
//     be for that hold line. Crossing elsewhere is unauthorized.
//   - From events, one per hold line passed, so it doesn't depend on runway areas (occupancy.ts):
//     a hold line protecting two runways is one crossing.
//   - Not counted: an `entered-runway` without `cleared`. That's no crossing clearance at all
//     (movement.ts stops at every runway hold line without one), so it isn't "on the player's
//     instruction" (PRD §8.6).
// - Gridlock (PRD §4.8): aircraft each stopped up against the next, in a cycle, for GRIDLOCK_S.
//   It ends the session, for now: until tugs exist (PRD §8.7), the player can't clear it.
//   - The graph: an aircraft on the ground, stopped (v = 0), points at its `blockedBy`, the
//     aircraft whose body sets its nearest stop (traffic.ts). Only a cycle can be a gridlock: an
//     aircraft queued behind a leader that will move isn't in one, nor is anything queued behind
//     a gridlock (it isn't named).
//   - No member can move forward: for each, its nearest traffic stop, against the bodies as the
//     tick left them, is its `blockedBy`, within RESTART_M of its nose. That's how movement.ts
//     decides it's stopped for traffic, so whatever its clearance (none, a hold, a hold-short
//     further on), it couldn't move up if it had one. Aircraft never reverse, so it can't clear
//     by itself. Two aircraft facing each other without clearances, far apart, aren't one.
//   - The ramp's own aircraft wait for a lane at their gates, parked (controller motion, no
//     `blockedBy`), so they're never members while they wait. Arrivals waiting at a ramp
//     entrance for ramp are ground's, stopped at the end of their taxi; they're members only of
//     a real head-on.
//   - It's the same cycle while its members are the same; it starts again if it breaks.
//
// Once the session has ended, nothing more is checked or counted; the sim itself keeps advancing
// (sim.ts, `step`), so a caller that wants the session over stops stepping.

import { footprintOf, polygonsOverlap } from './footprint.ts';
import { LOOKAHEAD_M, TICK_HZ } from './movement.ts';
import { placeOf, pointOf } from './track.ts';
import { occupancyOf, RESTART_M, trafficStop, type Occupancy } from './traffic.ts';
import type { Point } from '../airport/types.ts';
import { emit, type Aircraft, type RuleOrigin, type RuleParty, type RulesState, type SessionEndCause, type Sim, type SimEvent } from './world.ts';

/**
 * How long a gridlock lasts before it ends the session, seconds. [Builder] (PRD §4.8). Mine: a
 * cycle can't clear itself (no reversing, no give-way), so the wait is for the player. Sometimes
 * a re-route at a junction ahead frees a member; 60 s is time to notice two aircraft stopped and
 * get one transmission and readback out (about 4 s each way, PLAN's peak assumption) with room
 * to spare, and short enough that the session ends next to its cause. It matches tower's 60 s
 * for an unused approval.
 */
export const GRIDLOCK_S = 60;

export function initialRulesState(): RulesState {
  return { unauthorizedCrossings: [], jams: [] };
}

/** This tick's rule checks. `events`: what the tick emitted, oldest first. */
export function checkRules(sim: Sim, events: readonly SimEvent[]): void {
  if (sim.world.session.state !== 'running') return;
  checkCrossings(sim, events);
  const collision = findCollision(sim);
  if (collision) return endSession(sim, collision);
  const gridlock = watchGridlock(sim);
  if (gridlock) endSession(sim, gridlock);
}

function endSession(sim: Sim, cause: SessionEndCause): void {
  sim.world.session = { state: 'ended', tick: sim.world.tick, cause };
  emit(sim, { type: 'session-ended', tick: sim.world.tick, callsign: null, cause });
}

// ---------------------------------------------------------------------------------------------
// Unauthorized crossings

function checkCrossings(sim: Sim, events: readonly SimEvent[]): void {
  for (const e of events) {
    if (e.type !== 'entered-runway' || !e.cleared) continue;
    const approved = sim.world.tower.approvals.some((a) => a.callsign === e.callsign && a.holdShort === e.holdShort);
    if (approved) continue;
    const crossing = { tick: e.tick, callsign: e.callsign, holdShort: e.holdShort, runways: [...e.runways] };
    sim.world.rules.unauthorizedCrossings.push(crossing);
    emit(sim, { type: 'unauthorized-crossing', ...crossing, runways: [...e.runways] });
  }
}

// ---------------------------------------------------------------------------------------------
// Collision

interface Shape {
  ac: Aircraft;
  corners: Point[];
  /** Bounding box: min x, min y, max x, max y. */
  box: [number, number, number, number];
}

/**
 * The first pair of aircraft on the ground (in the order added) whose footprints overlap. On
 * final or airborne, an aircraft has no footprint on the ground (world.ts, `airborne`).
 */
function findCollision(sim: Sim): SessionEndCause | null {
  const shapes: Shape[] = sim.world.aircraft.filter((ac) => !ac.airborne && ac.status !== 'on-final').map(shapeOf);
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const [p, q] = [shapes[i], shapes[j]];
      if (!p || !q) throw new Error('collision: shape missing');
      if (p.box[2] <= q.box[0] || q.box[2] <= p.box[0] || p.box[3] <= q.box[1] || q.box[3] <= p.box[1]) continue;
      if (!polygonsOverlap(p.corners, q.corners)) continue;
      const [cp, cq] = [centre(p.corners), centre(q.corners)];
      const parties = [partyOf(p.ac), partyOf(q.ac)];
      return {
        kind: 'collision',
        aircraft: parties,
        point: [(cp[0] + cq[0]) / 2, (cp[1] + cq[1]) / 2],
        runways: [...new Set(parties.flatMap((x) => x.runways))].sort(),
        origin: originOf(parties),
      };
    }
  }
  return null;
}

/**
 * Parked aircraft's shapes, reused while they stay parked on the same track at the same place:
 * most of the aircraft on the ground at a busy airport are parked, and building a footprint is
 * most of the collision check's cost. Derived from the world, not state, so the hash and
 * determinism are unaffected. Anything else is rebuilt every tick. A parked aircraft's track is
 * replaced, never changed in place, when it moves on (apply.ts, ramp.ts), so the track object and
 * `s` identify its place.
 */
const parkedShapes = new WeakMap<Aircraft, { track: Aircraft['track']; s: number; shape: Shape }>();

function shapeOf(ac: Aircraft): Shape {
  if (ac.status === 'parked') {
    const cached = parkedShapes.get(ac);
    if (cached && cached.track === ac.track && cached.s === ac.s) return cached.shape;
  }
  const corners = footprintOf(ac);
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  const shape: Shape = { ac, corners, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
  if (ac.status === 'parked') parkedShapes.set(ac, { track: ac.track, s: ac.s, shape });
  return shape;
}

function centre(corners: Point[]): Point {
  const n = corners.length;
  return [corners.reduce((s, p) => s + p[0], 0) / n, corners.reduce((s, p) => s + p[1], 0) / n];
}

// ---------------------------------------------------------------------------------------------
// Gridlock

/** Updates `world.rules.jams` from this tick's cycles; the gridlock, if one has lasted GRIDLOCK_S. */
function watchGridlock(sim: Sim): SessionEndCause | null {
  const world = sim.world;
  const byCallsign = new Map(world.aircraft.map((ac) => [ac.callsign, ac]));
  const next = new Map<string, string>();
  for (const ac of world.aircraft) {
    if (ac.airborne || ac.v !== 0 || ac.blockedBy === null) continue;
    const blocker = byCallsign.get(ac.blockedBy);
    if (blocker && !blocker.airborne) next.set(ac.callsign, ac.blockedBy);
  }
  let occupancy: Occupancy | null = null;
  const jams: { members: string[]; since: number; cycle: string[] }[] = [];
  for (const cycle of cyclesOf(next, world.aircraft.map((ac) => ac.callsign))) {
    occupancy ??= occupancyOf(sim);
    const at = occupancy;
    if (!cycle.every((c) => upAgainst(sim, at, aircraftOf(byCallsign, c), next.get(c)))) continue;
    const members = [...cycle].sort();
    const key = members.join(' ');
    const before = world.rules.jams.find((j) => j.members.join(' ') === key);
    jams.push({ members, since: before?.since ?? world.tick, cycle });
  }
  world.rules.jams = jams.map(({ members, since }) => ({ members, since }));
  const due = jams.find((j) => world.tick - j.since >= GRIDLOCK_S * TICK_HZ);
  if (!due) return null;
  const parties = due.cycle.map((c) => partyOf(aircraftOf(byCallsign, c)));
  return { kind: 'gridlock', aircraft: parties, sinceTick: due.since, origin: originOf(parties) };
}

/**
 * The cycles of `next` (each callsign has at most one out-edge), each starting at its member
 * first in `order` and following `next`. In the order of those first members.
 */
function cyclesOf(next: ReadonlyMap<string, string>, order: readonly string[]): string[][] {
  const done = new Set<string>();
  const cycles: string[][] = [];
  for (const start of order) {
    const path: string[] = [];
    const onPath = new Map<string, number>();
    let c: string | undefined = start;
    while (c !== undefined && !done.has(c) && !onPath.has(c)) {
      onPath.set(c, path.length);
      path.push(c);
      c = next.get(c);
    }
    if (c !== undefined && onPath.has(c)) {
      const cycle = path.slice(onPath.get(c));
      const first = order.find((x) => cycle.includes(x));
      const k = first === undefined ? 0 : cycle.indexOf(first);
      cycles.push([...cycle.slice(k), ...cycle.slice(0, k)]);
    }
    for (const x of path) done.add(x);
  }
  const rank = (cycle: string[]) => order.indexOf(cycle[0] ?? '');
  return cycles.sort((a, b) => rank(a) - rank(b));
}

/** `ac`'s nearest traffic stop is `blocker`'s body, and it's within RESTART_M of it: it can't move up. */
function upAgainst(sim: Sim, occupancy: Occupancy, ac: Aircraft, blocker: string | undefined): boolean {
  const stop = trafficStop(sim.index, occupancy, ac, LOOKAHEAD_M);
  return stop !== null && stop.behind === blocker && stop.at - ac.s < RESTART_M;
}

function aircraftOf(byCallsign: ReadonlyMap<string, Aircraft>, callsign: string): Aircraft {
  const ac = byCallsign.get(callsign);
  if (!ac) throw new Error(`no aircraft ${callsign}`);
  return ac;
}

// ---------------------------------------------------------------------------------------------
// Shared

function partyOf(ac: Aircraft): RuleParty {
  const place = placeOf(ac.track, ac.s);
  const id = place.kind === 'node' ? ac.track.nodes[place.i] : ac.track.edges[place.i];
  if (id === undefined) throw new Error(`${ac.callsign}: track ${place.kind} ${place.i} is missing`);
  const nose = pointOf(ac.track, ac.s).point;
  return {
    callsign: ac.callsign,
    type: ac.type,
    controller: ac.controller,
    status: ac.status,
    speedMps: ac.v,
    location: place.kind === 'node' ? { kind: 'node', node: id } : { kind: 'edge', edge: id },
    nose: [nose[0], nose[1]],
    runways: [...ac.runways],
    blockedBy: ac.blockedBy,
  };
}

function originOf(parties: RuleParty[]): RuleOrigin {
  const ground = parties.filter((p) => p.controller === 'ground').length;
  return ground === parties.length ? 'player' : ground === 0 ? 'sim' : 'mixed';
}
