// Applying the player's commands (commands.ts) to the world (PLAN 1.9), with the meanings in
// docs/terse-syntax.md, "How the sim applies commands". A transmission's instructions apply in
// order, each on its own: one the pilot can't follow emits `unable` (or `ambiguous`) and
// changes nothing, and the rest still apply.
//
// Two rules beyond that contract:
// - A clearance that would put a stop (a hold line, a hold-short, the end of the route) inside
//   the aircraft's braking distance at the hard limit is unable, so the sim never makes it run
//   a hold line.
// - A runway hold-short given in any instruction (a taxi's list, `hold-short`, a correction's
//   list) withdraws earlier clearances to cross that runway: the later instruction wins.

import { junctionName } from '../airport/graph.ts';
import type { EdgeId, NodeId, RunwayId } from '../airport/types.ts';
import { MAX_DECEL_MPS2 } from './braking.ts';
import type { Command, Continue, Correction, Cross, HoldShort, HoldShortTarget, Instruction, Taxi } from './commands.ts';
import { resolveRoute, type RouteAmbiguous, type RoutePath, type RouteStart, type RouteUnable } from './route.ts';
import { copyCrossings, nextStop, nodeAt, stopsAhead } from './stops.ts';
import { requestCrossing } from './tower.ts';
import { buildTrack, placeOf, type Track } from './track.ts';
import { emit, type Aircraft, type Clearance, type CrossingClearance, type Sim } from './world.ts';

export function applyCommand(sim: Sim, command: Command): void {
  if (command.callsign === null) {
    emit(sim, { tick: sim.world.tick, type: 'say-again-callsign', callsign: null });
    return;
  }
  const ac = sim.world.aircraft.find((a) => a.callsign === command.callsign);
  if (!ac) {
    emit(sim, { tick: sim.world.tick, type: 'unknown-callsign', callsign: command.callsign });
    return;
  }
  if (command.type === 'crossing-request') {
    // The player asking tower (PRD §4.5), not the pilot. Tower answers it after a beat.
    emit(sim, { tick: sim.world.tick, callsign: ac.callsign, type: 'crossing-requested', runway: command.runway });
    requestCrossing(sim, ac, command.runway);
    return;
  }
  if (ac.controller !== 'ground') {
    // On tower's (or ramp's) frequency: the pilot doesn't hear ground. No reply, no effect.
    emit(sim, { tick: sim.world.tick, callsign: ac.callsign, type: 'not-on-frequency', controller: ac.controller });
    return;
  }
  for (const instruction of command.instructions) applyInstruction(sim, ac, instruction);
}

function applyInstruction(sim: Sim, ac: Aircraft, instruction: Instruction): void {
  switch (instruction.type) {
    case 'taxi':
      return applyTaxi(sim, ac, instruction);
    case 'cross':
      return applyCross(sim, ac, instruction);
    case 'hold-position':
      // Movement brakes it at the hard limit until it stops. The clearance stands.
      ac.holdPosition = true;
      return applied(sim, ac, instruction);
    case 'continue':
      return applyContinue(sim, ac, instruction);
    case 'hold-short':
      return applyHoldShort(sim, ac, instruction);
    case 'correction':
      return applyCorrection(sim, ac, instruction);
    // Recorded for the tasks that act on them, with no effect on movement yet. The handoff takes
    // effect at the facility's handoff point (STATUS, provisional): tower (1.10), ramp (1.11).
    case 'handoff': {
      const { mode, facility, frequency } = instruction;
      ac.advisories.handoff = { mode, facility, frequency };
      return applied(sim, ac, instruction);
    }
    case 'atis':
      ac.advisories.atis = { letter: instruction.letter, altimeter: instruction.altimeter };
      return applied(sim, ac, instruction);
    case 'ground-stop':
      ac.advisories.groundStop = instruction.destination;
      return applied(sim, ac, instruction);
    case 'release-time':
      ac.advisories.releaseTime = instruction.time;
      return applied(sim, ac, instruction);
    case 'hold-for-release':
      ac.advisories.holdForRelease = true;
      return applied(sim, ac, instruction);
    case 'expect-delay':
      ac.advisories.expectDelayMinutes = instruction.minutes;
      return applied(sim, ac, instruction);
    case 'say-again':
      // The pilot repeats their last transmission: the voice layer's job (Phase 2).
      return applied(sim, ac, instruction);
  }
  const unhandled: never = instruction;
  throw new Error(`unknown instruction ${JSON.stringify(unhandled)}`);
}

function applied(sim: Sim, ac: Aircraft, instruction: Instruction): void {
  emit(sim, { tick: sim.world.tick, callsign: ac.callsign, type: 'command-applied', instruction });
}

function unable(sim: Sim, ac: Aircraft, instruction: Instruction, reason: string): void {
  emit(sim, { tick: sim.world.tick, callsign: ac.callsign, type: 'unable', instruction, reason });
}

// ---------------------------------------------------------------------------------------------
// Instructions

/**
 * `taxi`: a new clearance from where the aircraft is now (rerouteFromHere). It releases a
 * hold-position. Unable or ambiguous: it keeps the clearance it had.
 */
function applyTaxi(sim: Sim, ac: Aircraft, taxi: Taxi): void {
  let crossings = ac.crossings;
  for (const target of taxi.holdShort) {
    if (target.kind === 'runway') crossings = withdrawCrossing(sim, crossings, target.name);
  }
  if (settle(sim, ac, taxi, rerouteFromHere(sim, ac, taxi, crossings))) ac.holdPosition = false;
}

/**
 * `cross`: clears it across each named runway, at `at` or wherever its route next meets the
 * runway. If it's holding short of one, it goes. Kept until used, so it may come before the
 * taxi clearance it applies to (`cross 31R at KE, taxi 31L via K`).
 */
function applyCross(sim: Sim, ac: Aircraft, cross: Cross): void {
  const runways = runwayIds(sim, cross.runways);
  if (typeof runways === 'string') return unable(sim, ac, cross, runways);
  ac.crossings.push({ runways, at: cross.at });
  applied(sim, ac, cross);
}

/**
 * `continue`: releases a hold-position, and the clearance's taxiway hold-shorts it's stopped
 * at (commands.ts). A hold-short it's only slowing for isn't released. It never releases a
 * runway hold line: with nothing else to release there, it's unable.
 */
function applyContinue(sim: Sim, ac: Aircraft, instruction: Continue): void {
  const clearance = ac.clearance;
  const here = clearance && ac.v === 0 ? stopsAhead(sim.index, ac).filter((stop) => stop.at === ac.s) : [];
  const taxiwayHolds = here.flatMap((stop) => (stop.kind === 'clearance-hold' ? [stop.pathIndex] : []));
  const runwayHold = here.find((stop) => stop.kind === 'runway-hold');
  if (!ac.holdPosition && taxiwayHolds.length === 0 && runwayHold) {
    const runways = runwayHold.runways.join(' and ');
    const at = junctionName(sim.index, nodeOf(ac.track, runwayHold.trackIndex));
    return unable(sim, ac, instruction, `holding short of runway ${runways} at ${at}: crossing it takes a crossing clearance`);
  }
  ac.holdPosition = false;
  clearance?.released.push(...taxiwayHolds);
  applied(sim, ac, instruction);
}

/**
 * `hold-short`: adds one target to the clearance's hold-short list (docs/terse-syntax.md). The
 * clearance is resolved again from where it was given, which gives the same path plus where the
 * new hold-short applies. Unable with no clearance, when the route never meets the target, when
 * the aircraft is already past it, or when it's too close to stop for.
 */
function applyHoldShort(sim: Sim, ac: Aircraft, instruction: HoldShort): void {
  const target = instruction.target;
  const clearance = ac.clearance;
  if (!clearance) return unable(sim, ac, instruction, `no taxi clearance to hold short of ${describeTarget(target)} on`);
  const taxi: Taxi = { ...clearance.taxi, holdShort: [...clearance.taxi.holdShort, target] };
  const result = resolveRoute(sim.index, taxi, clearance.start);
  if (result.type === 'unable') return unable(sim, ac, instruction, result.reason);
  if (result.type === 'ambiguous' || !samePath(result, clearance.path)) {
    // Hold-shorts don't steer the route, and resolution is deterministic.
    throw new Error(`${ac.callsign}: adding a hold-short changed the resolved route`);
  }
  const points = result.clearanceHolds.at(-1)?.at ?? [];
  if (!points.some((p) => nodeAt(ac.track, p.index + clearance.pathOffset) >= ac.s)) {
    return unable(sim, ac, instruction, `already past ${describeTarget(target)}`);
  }
  const updated: Aircraft = {
    ...ac,
    clearance: { ...clearance, taxi, path: result },
    crossings: target.kind === 'runway' ? withdrawCrossing(sim, ac.crossings, target.name) : ac.crossings,
  };
  const problem = stopProblem(sim, updated);
  if (problem !== null) return unable(sim, ac, instruction, problem);
  ac.clearance = updated.clearance;
  ac.crossings = updated.crossings;
  applied(sim, ac, instruction);
}

/**
 * `correction` ("negative, …"): each part given replaces that part of the clearance, and the
 * rest stands (commands.ts; docs/terse-syntax.md, "Corrections"). The corrected clearance is
 * resolved again from where the clearance was given, and taken if it starts with the route
 * already taxied, so the aircraft keeps its progress. A correction with a new route (`via`)
 * that doesn't fit is resolved from where the aircraft is instead, as a new taxi would be.
 * All or nothing: if any part can't be followed, it's unable (or ambiguous) and nothing
 * changes. `cross` replaces the latest crossing clearance not yet used, or adds one. A
 * correction leaves a hold-position as it is.
 */
function applyCorrection(sim: Sim, ac: Aircraft, correction: Correction): void {
  let crossings = ac.crossings;
  if (correction.cross) {
    const runways = runwayIds(sim, correction.cross.runways);
    if (typeof runways === 'string') return unable(sim, ac, correction, runways);
    crossings = [...copyCrossings(crossings.slice(0, -1)), { runways, at: correction.cross.at }];
  }
  const changesRoute = correction.to !== null || correction.via !== null || correction.turns.length > 0 || correction.holdShort !== null;
  if (!changesRoute) {
    ac.crossings = crossings;
    return applied(sim, ac, correction);
  }
  const clearance = ac.clearance;
  if (!clearance) return unable(sim, ac, correction, 'no taxi clearance to correct');
  let via = correction.via ?? clearance.taxi.via;
  for (const fix of correction.turns) {
    const i = via.findIndex((item) => item.taxiway === fix.taxiway);
    if (i < 0) return unable(sim, ac, correction, `the route has no taxiway ${fix.taxiway} to turn ${fix.turn} onto`);
    via = via.map((item, k) => (k === i ? { ...item, turn: fix.turn } : item));
  }
  const holdShort = correction.holdShort ?? clearance.taxi.holdShort;
  const taxi: Taxi = { type: 'taxi', to: correction.to ?? clearance.taxi.to, via, holdShort };
  for (const target of correction.holdShort ?? []) {
    if (target.kind === 'runway') crossings = withdrawCrossing(sim, crossings, target.name);
  }
  const fromStart = rerouteFromStart(sim, ac, clearance, taxi, crossings);
  settle(sim, ac, correction, fromStart.kind !== 'ok' && correction.via !== null ? rerouteFromHere(sim, ac, taxi, crossings) : fromStart);
}

// ---------------------------------------------------------------------------------------------
// Rerouting

/** A new clearance and track for an aircraft, or why it can't have one. */
type Reroute =
  | { kind: 'ok'; updated: Aircraft }
  | { kind: 'unable'; reason: string }
  | { kind: 'ambiguous'; node: NodeId; taxiway: string; edges: EdgeId[] };

/**
 * Applies a reroute if the aircraft can stop in time for its next stop, or emits why it can't
 * be followed. Returns whether it was applied.
 */
function settle(sim: Sim, ac: Aircraft, instruction: Instruction, reroute: Reroute): boolean {
  if (reroute.kind === 'ambiguous') {
    const { node, taxiway, edges } = reroute;
    emit(sim, { tick: sim.world.tick, callsign: ac.callsign, type: 'ambiguous', instruction, node, at: junctionName(sim.index, node), taxiway, edges });
    return false;
  }
  if (reroute.kind === 'unable') {
    unable(sim, ac, instruction, reroute.reason);
    return false;
  }
  const problem = stopProblem(sim, reroute.updated);
  if (problem !== null) {
    unable(sim, ac, instruction, problem);
    return false;
  }
  const { track, s, clearance, crossings } = reroute.updated;
  Object.assign(ac, { track, s, clearance, crossings });
  applied(sim, ac, instruction);
  return true;
}

function failure(result: RouteUnable | RouteAmbiguous): Reroute {
  return result.type === 'unable'
    ? { kind: 'unable', reason: result.reason }
    : { kind: 'ambiguous', node: result.node, taxiway: result.taxiway, edges: result.edges };
}

/**
 * `taxi` resolved from where the aircraft is now: the node its nose is on, or the node ahead if
 * it's mid-edge, having arrived along the edge it's on (it can't turn mid-edge, or reverse).
 */
function rerouteFromHere(sim: Sim, ac: Aircraft, taxi: Taxi, crossings: CrossingClearance[]): Reroute {
  const { start, nodeIndex } = routeStartOf(ac);
  const result = resolveRoute(sim.index, taxi, start);
  if (result.type !== 'path') return failure(result);
  const { track, s, pathOffset } = rerouted(sim, ac, nodeIndex, result);
  return { kind: 'ok', updated: { ...ac, track, s, crossings, clearance: { taxi, start, path: result, pathOffset, released: [] } } };
}

/**
 * `taxi` resolved from where `clearance` was given, kept only if it starts with every path
 * edge the nose has entered, so the aircraft carries on from where it is.
 */
function rerouteFromStart(sim: Sim, ac: Aircraft, clearance: Clearance, taxi: Taxi, crossings: CrossingClearance[]): Reroute {
  const result = resolveRoute(sim.index, taxi, clearance.start);
  if (result.type !== 'path') return failure(result);
  const place = placeOf(ac.track, ac.s);
  const entered = Math.max(0, (place.kind === 'node' ? place.i : place.i + 1) - clearance.pathOffset);
  for (let k = 0; k < entered; k++) {
    if (result.edges[k] !== clearance.path.edges[k]) {
      const at = junctionName(sim.index, nodeOf(ac.track, k + clearance.pathOffset));
      return { kind: 'unable', reason: `too late: the corrected route leaves the route taxied at ${at}` };
    }
  }
  // The track up to the path's start, then the new path: the part already taxied is the same.
  const track = buildTrack(
    sim.index,
    [...ac.track.nodes.slice(0, clearance.pathOffset + 1), ...result.nodes.slice(1)],
    [...ac.track.edges.slice(0, clearance.pathOffset), ...result.edges],
  );
  return { kind: 'ok', updated: { ...ac, track, crossings, clearance: { ...clearance, taxi, path: result } } };
}

/**
 * Where a new route starts: the node the nose is at, or the node ahead if it's mid-edge, with
 * the edge it arrived along. `nodeIndex` is that node's index in the current track.
 */
function routeStartOf(ac: Aircraft): { start: RouteStart; nodeIndex: number } {
  const place = placeOf(ac.track, ac.s);
  const nodeIndex = place.kind === 'node' ? place.i : place.i + 1;
  const arrivedVia = nodeIndex > 0 ? (ac.track.edges[nodeIndex - 1] ?? null) : null;
  // The airline only when known: an unknown one is left out (RouteStart's "omitted or null").
  const airline = ac.airline === null ? {} : { airline: ac.airline };
  return { start: { node: nodeOf(ac.track, nodeIndex), arrivedVia, terminal: ac.terminal, ...airline }, nodeIndex };
}

/**
 * The track for `path`, which starts at current track node `nodeIndex`: the current track from
 * the edge holding the tail up to that node (the trail, so the body stays on the graph), then
 * the path. The nose keeps its place: exactly on a node stays exactly on it.
 */
function rerouted(sim: Sim, ac: Aircraft, nodeIndex: number, path: RoutePath): { track: Track; s: number; pathOffset: number } {
  const old = ac.track;
  if (old.nodes[nodeIndex] !== path.nodes[0]) {
    throw new Error(`${ac.callsign}: path starts at "${path.nodes[0]}", not track node "${old.nodes[nodeIndex]}"`);
  }
  const tail = placeOf(old, Math.max(0, ac.s - ac.lengthM));
  const t0 = Math.min(tail.i, nodeIndex);
  const track = buildTrack(sim.index, [...old.nodes.slice(t0, nodeIndex + 1), ...path.nodes.slice(1)], [
    ...old.edges.slice(t0, nodeIndex),
    ...path.edges,
  ]);
  const nose = placeOf(old, ac.s);
  const s = nose.kind === 'node' ? nodeAt(track, nose.i - t0) : nodeAt(track, nose.i - t0) + (ac.s - nodeAt(old, nose.i));
  return { track, s, pathOffset: nodeIndex - t0 };
}

// ---------------------------------------------------------------------------------------------
// Helpers

/**
 * Why the aircraft couldn't stop at its next stop in time, braking at the hard limit. null:
 * it can.
 */
function stopProblem(sim: Sim, ac: Aircraft): string | null {
  const stop = nextStop(sim.index, ac);
  const braking = (ac.v * ac.v) / (2 * MAX_DECEL_MPS2);
  if (stop.at - ac.s >= braking - 1e-9) return null;
  switch (stop.kind) {
    case 'runway-hold':
      return `too close to stop at the hold line for runway ${stop.runways.join(' and ')} at ${junctionName(sim.index, nodeOf(ac.track, stop.trackIndex))}`;
    case 'clearance-hold':
      return `too close to stop short of ${describeTarget(stop.target)} at ${junctionName(sim.index, nodeOf(ac.track, stop.trackIndex))}`;
    case 'end':
      return `too close to stop at the end of the route at ${junctionName(sim.index, nodeOf(ac.track, ac.track.nodes.length - 1))}`;
  }
}

/** The crossing clearances without runway `designator`'s runway. */
function withdrawCrossing(sim: Sim, crossings: CrossingClearance[], designator: string): CrossingClearance[] {
  const runway = sim.index.runwayEnds.get(designator)?.runway.id;
  return crossings.map((c) => ({ ...c, runways: c.runways.filter((r) => r !== runway) })).filter((c) => c.runways.length > 0);
}

/** The runway ids for runway-end designators, without repeats, or why one doesn't exist. */
function runwayIds(sim: Sim, designators: string[]): RunwayId[] | string {
  const ids: RunwayId[] = [];
  for (const designator of designators) {
    const runway = sim.index.runwayEnds.get(designator)?.runway;
    if (!runway) return `no runway ${designator} at ${sim.index.airport.id}`;
    if (!ids.includes(runway.id)) ids.push(runway.id);
  }
  return ids;
}

function samePath(a: RoutePath, b: RoutePath): boolean {
  return a.nodes.length === b.nodes.length && a.nodes.every((n, i) => n === b.nodes[i]) && a.edges.every((e, i) => e === b.edges[i]);
}

function describeTarget(target: HoldShortTarget): string {
  return target.kind === 'runway' ? `runway ${target.name}` : target.name;
}

function nodeOf(track: Track, i: number): NodeId {
  const node = track.nodes[i];
  if (node === undefined) throw new Error(`track node ${i} is out of range`);
  return node;
}
