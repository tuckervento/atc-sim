// Route resolution (PLAN 1.8): turns a taxi clearance into a path on the airport graph, or says
// why the pilot can't follow it. Pure and deterministic: no I/O, no clock, no randomness.
//
// The route rule is Q's (PRD §7, "What a taxi route means"): the route names every taxiway, and
// the aircraft never finds its own way. In detail:
// - Ground routes use `taxiway` edges only. Runway edges belong to tower: a route may cross a
//   runway at a node, never travel along one. Ramp lanes belong to the simulated ramp (§8.3).
// - Each route item covers at least one edge. Going along item i, the aircraft turns onto item
//   i + 1 at the first node it reaches where it can: where that taxiway has an edge, or where an
//   unnamed connector to it starts (below). It never skips one: if no way on from there works,
//   it's unable.
// - Unnamed connectors count as turns (Q's Q6 answer, 2026-11-15). JFK's parallel taxiways (A
//   and B, ...) meet only through unnamed curved fillets, and "A, then B" means "take the
//   fillet". So between consecutive route items X and Y, the path may cross a short run of
//   unnamed taxiway edges that joins X to Y (`connectorWays`):
//   - a simple chain: every node inside it has exactly two edges (a fork makes it part of a
//     network, such as a pad's lanes, not a turn), and it ends at the first node on Y;
//   - it never touches a runway, so it can't add a crossing the route doesn't name (Q);
//   - at most CONNECTOR_MAX_M long, with no turn onto, along or off it sharper than
//     CONNECTOR_MAX_TURN_DEG, so a fillet built for the other direction is no way on;
//   - where X meets Y directly at a node, connectors from that node aren't considered.
//   The first junction is the first node with a direct edge or a usable connector to Y.
// - A turn direction picks the way by geometry, relative to the heading it arrived with.
//   Through a connector it's measured over the whole turn, from the heading along X to the
//   heading along Y (`waySide`); a jog between parallel taxiways, where that sums to under
//   CONNECTOR_JOG_DEG, turns the way its first bend does. With no direction, it takes the way
//   that completes the route; if more than one does (both ways along Y, or connectors either
//   side), it's ambiguous; if none does, unable. With no heading at all (`arrivedVia` null), a
//   direction is unable.
// - Before the first item, the aircraft's own way out: if it isn't on the first item already,
//   it goes forward along the taxiway it's on, or along unnamed taxiway edges, to the first
//   node where the first item begins. That's how it leaves a pad spot (unnamed lead-out), a
//   ramp edge (the stub out of the ramp), an exit taxiway, or a departure line at an exit.
//   The way out never crosses a runway (Q): that would be a crossing the route doesn't name,
//   so it's unable, and naming the taxiway it's on makes the crossing part of the route.
// - After the last item, only the destination's own way in: a runway end's departure line to
//   its front hold; a ramp entrance's stub (taxiway edges with the entrance's name); a holding
//   area's (pad, penalty box, hardstand) unnamed taxiway lead-in to the nearest spot; or a
//   hangar's lead-in, unnamed taxiway edges or ramp lanes that pass no ramp handoff, to the
//   nearest hangar spot. A holding area's or hangar's lead-in passes no node on a named taxiway
//   or a runway, so it can't hop across the airport on connectors. It's taken at the first
//   node along the last item where it starts and is open. A closed one is passed by, and named
//   if no open one follows.
// - Named destinations: a holding area by its id, name or a spoken name; a hangar by its id,
//   name or one of its airlines; all ignoring case. An unnamed hangar is "the company hangar":
//   the one whose airlines include `RouteStart.airline`.
// - Never back along the edge just travelled, never along any edge twice, never over a closed
//   edge.
// - Where several failures compete, the reason given is the one that got furthest along.

import { edgeLength, edgePolyline, edgesAt, holdingAreaNames, otherEnd, type AirportIndex } from '../airport/graph.ts';
import type {
  Closure,
  DepartureLine,
  DepartureLineId,
  Edge,
  EdgeId,
  Hangar,
  HangarId,
  HoldingArea,
  HoldingAreaId,
  HoldShortId,
  HoldShortKind,
  NodeId,
  Point,
  RampHandoff,
  RampHandoffId,
  RunwayEndDesignator,
  RunwayId,
  TerminalId,
} from '../airport/types.ts';
import type { HoldShortTarget, RouteItem, Taxi, Turn } from './commands.ts';

/** Where the aircraft is when it gets the clearance. */
export interface RouteStart {
  /** The node it's at, or the next node ahead if it's moving along an edge. */
  node: NodeId;
  /**
   * The edge it came along to `node`. It gives the heading that "left" and "right" are
   * relative to, and the aircraft can't reverse onto it (PRD §8.2). null: no heading, e.g.
   * parked on a pad spot. It may then leave by any edge.
   */
  arrivedVia: EdgeId | null;
  /** The aircraft's terminal, for a taxi to "the ramp" (a ramp destination with no name). */
  terminal: TerminalId | null;
  /**
   * The aircraft's airline (ICAO, e.g. "DAL"), for a taxi to "the company hangar" (a hangar
   * destination with no name). Omitted or null: unknown.
   */
  airline?: string | null;
}

export type RouteResult = RoutePath | RouteAmbiguous | RouteUnable;

export interface RoutePath {
  type: 'path';
  /** From the start node to the end of the path: one more than `edges`. */
  nodes: NodeId[];
  /** `edges[i]` runs from `nodes[i]` to `nodes[i + 1]`. */
  edges: EdgeId[];
  lengthM: number;
  /**
   * Every hold line the path passes, in order, of every kind. A hold line applies only to
   * traffic at its node about to enter its `towardEdge`, so the hold at `nodes[index]` faces
   * `edges[index]`. The sim stops at each `runway` hold unless cleared to cross (PRD §7).
   */
  holdShorts: PassedHoldShort[];
  /** Where each of the clearance's hold-shorts applies, in the clearance's order. */
  clearanceHolds: ClearanceHold[];
  /** What the path reached. Its last node is `nodes[nodes.length - 1]`. */
  destination: ReachedDestination;
}

export interface PassedHoldShort {
  id: HoldShortId;
  kind: HoldShortKind;
  runways: RunwayId[];
  /** The hold is at `nodes[index]`, facing `edges[index]`. */
  index: number;
}

export interface ClearanceHold {
  target: HoldShortTarget;
  /** The points where it applies, in path order. At least one. */
  at: HoldPoint[];
}

export interface HoldPoint {
  /**
   * Stop at `nodes[index]`, before entering `edges[index]`. The last node's index means the
   * end of the path: a taxi to a runway, told to hold short of that runway, holds at the
   * departure line's front hold.
   */
  index: number;
  /** The hold line at that point, if the airport has one there. */
  holdShort: HoldShortId | null;
}

export type ReachedDestination =
  /** The front of the runway end's departure line: its `runway` hold, where tower takes over. */
  | { kind: 'runway'; runwayEnd: RunwayEndDesignator; departureLine: DepartureLineId; holdShort: HoldShortId }
  /** A ramp entrance serving the terminal, where ramp takes over. */
  | { kind: 'ramp'; terminal: TerminalId; rampHandoff: RampHandoffId }
  /** One spot of a holding pad, the penalty box or a hardstand: the nearest one along the way in. */
  | { kind: HoldingDestination; holdingArea: HoldingAreaId; spot: NodeId }
  /** One spot of a hangar: the nearest one along its way in. */
  | { kind: 'hangar'; hangar: HangarId; spot: NodeId };

/** The taxi destinations that are holding areas, and the area kind each one means. */
type HoldingDestination = 'pad' | 'penalty-box' | 'hardstand';
const HOLDING_KIND: Record<HoldingDestination, HoldingArea['kind']> = { pad: 'pad', 'penalty-box': 'penaltyBox', hardstand: 'hardstand' };
const HOLDING_WHAT: Record<HoldingDestination, string> = { pad: 'pad', 'penalty-box': 'penalty box', hardstand: 'hardstand' };

/** Both ways on `taxiway` from `node` complete the route, and the clearance doesn't say which. */
export interface RouteAmbiguous {
  type: 'ambiguous';
  node: NodeId;
  taxiway: string;
  /** The edges out of `node` that each complete the route, in airport file order. */
  edges: EdgeId[];
}

/** The pilot can't follow the clearance. `reason` names the taxiways, nodes or closure involved. */
export interface RouteUnable {
  type: 'unable';
  reason: string;
}

/**
 * Resolves a taxi clearance from the aircraft's position (PRD §7, "What a taxi route means").
 *
 * The rule (Q, 2026-11-14): the aircraft follows `via` in order, along edges named for each
 * item, and turns onto the next item at the first node it reaches that the two share. After
 * the last item it takes only the destination's own way in. It never reverses, never uses a
 * closed edge, and never travels along a runway (crossing one at a node is fine). It never
 * finds its own way: a gap in the route is "unable".
 *
 * @throws Error if `start` names a node or edge that doesn't exist, or an edge that doesn't
 *   touch the node. Those are the caller's bugs; everything the player can get wrong is an
 *   `unable` result instead.
 */
export function resolveRoute(index: AirportIndex, taxi: Taxi, start: RouteStart): RouteResult {
  if (!index.nodes.has(start.node)) throw new Error(`route start: unknown node "${start.node}"`);
  let arrived: Edge | null = null;
  if (start.arrivedVia !== null) {
    const edge = index.edges.get(start.arrivedVia);
    if (!edge) throw new Error(`route start: unknown edge "${start.arrivedVia}"`);
    if (edge.from !== start.node && edge.to !== start.node) {
      throw new Error(`route start: edge "${edge.id}" doesn't touch node "${start.node}"`);
    }
    arrived = edge;
  }

  const routeProblem = checkRoute(index, taxi.via) ?? checkTargets(index, taxi.holdShort);
  if (routeProblem !== null) return { type: 'unable', reason: routeProblem };
  const wayIn = resolveWayIn(index, taxi, start);
  if ('type' in wayIn) return wayIn;
  const first = taxi.via[0];
  if (!first) throw new Error('checkRoute passed an empty route');
  // The taxiway it's on: the name of the edge it arrived along. A ramp lane's name counts: the
  // stub out of the ramp may carry it (TEST's lane 7 and stub 7). Runway edges carry no name.
  const current = arrived && arrived.kind !== 'runway' ? (arrived.name ?? null) : null;
  const ctx: Context = { index, via: taxi.via, wayIn, start: start.node, current };

  if (first.taxiway === current && first.turn !== null) {
    return { type: 'unable', reason: `already on taxiway ${current}, so it can't turn ${first.turn} onto it` };
  }
  // On the first item already, it carries on along it; otherwise it makes its way out to it.
  const outcome =
    first.taxiway === current ? walkItem(ctx, 0, start.node, arrived, [], true, null) : leadOut(ctx, start.node, arrived, []);
  switch (outcome.kind) {
    case 'failed':
      return { type: 'unable', reason: outcome.reason };
    case 'ambiguous':
      return { type: 'ambiguous', node: outcome.node, taxiway: outcome.taxiway, edges: outcome.edges };
    case 'done':
      return buildPath(index, start.node, outcome, taxi.holdShort);
  }
}

/** Problems with the named route itself, wherever the aircraft is. null: none. */
function checkRoute(index: AirportIndex, via: RouteItem[]): string | null {
  if (via.length === 0) return 'the route names no taxiways';
  for (const item of via) {
    if (!index.airport.edges.some((e) => e.kind === 'taxiway' && e.name === item.taxiway)) {
      return `no taxiway ${item.taxiway} at ${index.airport.id}`;
    }
  }
  let previous: string | null = null;
  for (const { taxiway } of via) {
    if (previous === taxiway) return `taxiway ${taxiway} is named twice in a row`;
    if (previous !== null && meetingNodes(index, previous, taxiway).length === 0 && connectorStarts(index, previous, taxiway).length === 0) {
      return `taxiways ${previous} and ${taxiway} don't meet`;
    }
    previous = taxiway;
  }
  return null;
}

/** Why an aircraft on taxiway `a` didn't get to taxiway `b`. */
function notReachedReason(index: AirportIndex, a: string, b: string): string {
  const meet = meetingNodes(index, a, b);
  const connectors = connectorStarts(index, a, b);
  if (meet.length === 0 && connectors.length === 0) return `taxiways ${a} and ${b} don't meet`;
  const where = [
    meet.length > 0 ? `at ${meet.join(', ')}` : null,
    connectors.length > 0 ? `through unnamed connectors from ${connectors.join(', ')}` : null,
  ].filter((w) => w !== null);
  return `taxiway ${a} doesn't reach ${b} in the direction of travel (they meet only ${where.join(' and ')})`;
}

/** Hold-short targets that don't exist at the airport. null: none. */
function checkTargets(index: AirportIndex, targets: HoldShortTarget[]): string | null {
  for (const target of targets) {
    if (target.kind === 'runway') {
      if (!index.runwayEnds.has(target.name)) return `hold short of runway ${target.name}: no runway ${target.name} at ${index.airport.id}`;
    } else if (!index.airport.edges.some((e) => e.kind !== 'runway' && e.name === target.name)) {
      return `hold short of ${target.name}: no taxiway ${target.name} at ${index.airport.id}`;
    }
  }
  return null;
}

/**
 * The nodes of taxiway `a` where an unnamed connector to taxiway `b` starts, whatever the
 * heading, in airport file order (for "don't meet" and its explanation).
 */
function connectorStarts(index: AirportIndex, a: string, b: string): NodeId[] {
  const nodes = [...new Set(index.airport.edges.filter((e) => e.kind === 'taxiway' && e.name === a).flatMap((e) => [e.from, e.to]))];
  return nodes.filter((n) => connectorWays(index, n, null, [], b).length > 0);
}

/** The nodes where taxiways `a` and `b` meet, closed segments included, in airport file order. */
function meetingNodes(index: AirportIndex, a: string, b: string): NodeId[] {
  const nodesOf = (name: string) =>
    new Set(index.airport.edges.filter((e) => e.kind === 'taxiway' && e.name === name).flatMap((e) => [e.from, e.to]));
  const onB = nodesOf(b);
  return [...nodesOf(a)].filter((n) => onB.has(n));
}

// ---------------------------------------------------------------------------------------------
// The search

interface Context {
  index: AirportIndex;
  via: RouteItem[];
  wayIn: WayIn;
  /** The start node. */
  start: NodeId;
  /** The name of the taxiway the aircraft starts on, if any. */
  current: string | null;
}

interface Step {
  edge: Edge;
  /** The node the step arrives at. */
  to: NodeId;
}

type Outcome =
  | { kind: 'done'; steps: Step[]; destination: ReachedDestination }
  | { kind: 'ambiguous'; node: NodeId; taxiway: string; edges: EdgeId[] }
  | Failed;

/** `progress` ranks failures: the one that got furthest along the route explains best. */
interface Failed {
  kind: 'failed';
  reason: string;
  progress: number;
}

/**
 * Before the first route item, when the aircraft isn't already on it: it leaves its position
 * the only ways it can without a named route, forward along the taxiway it's on or along
 * unnamed taxiway edges (a pad's lead-out, a connector), and turns onto the first item at the
 * first node where that taxiway begins.
 */
function leadOut(ctx: Context, node: NodeId, arrived: Edge | null, used: EdgeId[]): Outcome {
  const first = ctx.via[0];
  if (!first) throw new Error('route has no items');
  if (waysOnto(ctx.index, node, arrived, used, first.taxiway).length > 0) return turnOnto(ctx, 0, node, arrived, used);
  const forward = edgesAt(ctx.index, node).filter(
    (e) =>
      e.kind === 'taxiway' &&
      (e.name === undefined || e.name === ctx.current) &&
      e.id !== arrived?.id &&
      !used.includes(e.id),
  );
  if (forward.length === 0) {
    const reason =
      ctx.current === null
        ? `taxiway ${first.taxiway} can't be reached from ${ctx.start}`
        : notReachedReason(ctx.index, ctx.current, first.taxiway);
    return failed(-1, used, reason);
  }
  return choose(
    node,
    first.taxiway,
    forward.map((edge) => {
      const runway = runwayAt(ctx.index, otherEnd(edge, node));
      if (runway !== null) {
        const where = ctx.current === null ? `from ${ctx.start}` : `on ${ctx.current}`;
        return [edge, failed(-1, used, `reaching ${first.taxiway} means crossing runway ${runway} ${where}, which the route doesn't name`)];
      }
      return travel(node, edge, used, -1, (to, now) => leadOut(ctx, to, edge, now));
    }),
  );
}

/** The runway with an edge at `node`, if any: a taxiway reaching that node is on the runway. */
function runwayAt(index: AirportIndex, node: NodeId): RunwayId | null {
  return edgesAt(index, node).find((e) => e.kind === 'runway')?.runway ?? null;
}

/**
 * At `node`, turns onto route item `j`'s taxiway, either way it goes from here: directly, or
 * through an unnamed connector (see `waysOnto`).
 */
function turnOnto(ctx: Context, j: number, node: NodeId, arrived: Edge | null, used: EdgeId[]): Outcome {
  const item = ctx.via[j];
  if (!item) throw new Error(`route item ${j} doesn't exist`);
  let ways = waysOnto(ctx.index, node, arrived, used, item.taxiway);
  if (item.turn !== null) {
    const turn = item.turn;
    // Left and right are relative to a heading. With none, the turn can't be followed, and
    // guessing would be a silent fallback.
    if (arrived === null) return failed(j, used, `can't turn ${turn} onto ${item.taxiway} at ${node} with no heading`);
    ways = ways.filter((way) => waySide(ctx.index, node, arrived, way) === turn);
    if (ways.length === 0) return failed(j, used, `taxiway ${item.taxiway} doesn't go ${turn} from ${node}`);
  }
  // Each item covers at least one edge, so the next junction is looked for from the far end of
  // its first edge on.
  const follow = (way: Way): Outcome =>
    travelSteps(node, way.steps, used, j, (at, now) => travel(at, way.onto, now, j, (to, after) => walkItem(ctx, j, to, way.onto, after, true, null))[1]);
  // Ways that share their first edge (one connector, both ways along the taxiway at its end)
  // are one option here; where they part, at the connector's end, is where the pilot would ask.
  const groups = new Map<EdgeId, Way[]>();
  for (const way of ways) {
    const first = (way.steps[0]?.edge ?? way.onto).id;
    groups.set(first, [...(groups.get(first) ?? []), way]);
  }
  return choose(
    node,
    item.taxiway,
    [...groups.values()].map((group): [Edge, Outcome] => {
      const [way] = group;
      if (!way) throw new Error('empty group of ways');
      const first = way.steps[0]?.edge ?? way.onto;
      if (group.length === 1) return [first, follow(way)];
      return [first, choose(way.node, item.taxiway, group.map((w): [Edge, Outcome] => [w.onto, follow(w)]))];
    }),
  );
}

/** Travels `steps` in order from `node`, then the rest of the route from where they end. */
function travelSteps(node: NodeId, steps: Step[], used: EdgeId[], item: number, then: (at: NodeId, used: EdgeId[]) => Outcome): Outcome {
  const [step, ...rest] = steps;
  if (!step) return then(node, used);
  return travel(node, step.edge, used, item, (to, now) => travelSteps(to, rest, now, item, then))[1];
}

// ---------------------------------------------------------------------------------------------
// Unnamed connectors (Q6, 2026-11-15)

/** A connector is at most this long (m). JFK's unnamed fillets between taxiways are all under 170 m. */
export const CONNECTOR_MAX_M = 250;
/** No turn onto, along or off a connector may be sharper than this (degrees): no hairpins. */
export const CONNECTOR_MAX_TURN_DEG = 90;
/** Through a connector, a total turn smaller than this (degrees) is a jog: its side is the first turn's. */
export const CONNECTOR_JOG_DEG = 30;

/**
 * One way onto a taxiway from a node: along `steps` (an unnamed connector; empty when the
 * taxiway is right there), then onto `onto`, a taxiway edge leaving `node`'s end of the steps.
 */
interface Way {
  steps: Step[];
  onto: Edge;
  /** Where `onto` starts: the connector's far end, or the node itself. */
  node: NodeId;
}

/**
 * The ways onto taxiway `name` from `node`. Where it meets the taxiway directly, those edges
 * only. Otherwise every unnamed connector from here to it (`connectorWays`).
 */
function waysOnto(index: AirportIndex, node: NodeId, arrived: Edge | null, used: EdgeId[], name: string): Way[] {
  const direct = taxiwayEdgesAt(index, node, name, arrived, used);
  if (direct.length > 0) return direct.map((onto) => ({ steps: [], onto, node }));
  return connectorWays(index, node, arrived, used, name);
}

/**
 * Unnamed connectors from `node` to taxiway `name`: a short run of open, unnamed taxiway edges
 * that joins the two, as at JFK where parallel taxiways meet only through unnamed fillets.
 * - It's a simple chain: every node inside it has exactly two edges, both its own. It ends at
 *   the first node where the taxiway has an edge.
 * - It never touches a runway (Q: no crossing the route doesn't name), and doesn't start on one.
 * - At most CONNECTOR_MAX_M long, and no turn onto it, along it or off it onto the taxiway is
 *   sharper than CONNECTOR_MAX_TURN_DEG. With no heading (`arrived` null), the first turn isn't
 *   checked.
 * Each result is one connector and one way along the taxiway at its end.
 */
function connectorWays(index: AirportIndex, node: NodeId, arrived: Edge | null, used: EdgeId[], name: string): Way[] {
  const ways: Way[] = [];
  if (edgesAt(index, node).some((e) => e.kind === 'runway')) return ways;
  const walk = (at: NodeId, last: Edge | null, steps: Step[], length: number): void => {
    for (const edge of edgesAt(index, at)) {
      if (edge.kind !== 'taxiway' || edge.name !== undefined || edge.closed) continue;
      if (edge.id === last?.id || edge.id === arrived?.id || used.includes(edge.id)) continue;
      if (last !== null && Math.abs(turnAngle(index, at, last, edge)) > CONNECTOR_MAX_TURN_DEG) continue;
      const to = otherEnd(edge, at);
      const total = length + edgeLength(index, edge);
      if (total > CONNECTOR_MAX_M || to === node || steps.some((s) => s.to === to)) continue;
      const there = edgesAt(index, to);
      if (there.some((e) => e.kind === 'runway')) continue;
      const chain = [...steps, { edge, to }];
      const onto = there.filter((e) => e.kind === 'taxiway' && e.name === name && !used.includes(e.id));
      if (onto.length > 0) {
        for (const e of onto) {
          if (Math.abs(turnAngle(index, to, edge, e)) <= CONNECTOR_MAX_TURN_DEG) ways.push({ steps: chain, onto: e, node: to });
        }
        continue;
      }
      if (there.length === 2) walk(to, edge, chain, total);
    }
  };
  walk(node, arrived, [], 0);
  return ways;
}

/**
 * The side a way turns onto its taxiway, for an aircraft that arrived at `node` along
 * `arrived`. Directly: the turn at the node. Through a connector: the whole turn, from the
 * heading it arrived with to the heading it leaves along the taxiway, summed over every bend.
 * A jog between parallel taxiways sums to about nothing, so under CONNECTOR_JOG_DEG it takes
 * the side of its first turn: the side the taxiway lies on.
 */
function waySide(index: AirportIndex, node: NodeId, arrived: Edge, way: Way): Turn | null {
  if (way.steps.length === 0) return turnSide(index, node, arrived, way.onto);
  const angles: number[] = [];
  let [at, last] = [node, arrived];
  for (const step of way.steps) {
    angles.push(turnAngle(index, at, last, step.edge));
    [at, last] = [step.to, step.edge];
  }
  angles.push(turnAngle(index, at, last, way.onto));
  const total = angles.reduce((sum, a) => sum + a, 0);
  if (Math.abs(total) >= CONNECTOR_JOG_DEG) return total > 0 ? 'right' : 'left';
  const first = angles.find((a) => Math.abs(a) >= 1);
  return first === undefined ? null : first > 0 ? 'right' : 'left';
}

/**
 * Walks route item `i` forward from `node`, having arrived along `arrived`. `used` holds the
 * ids of the edges travelled so far. With `checkHere`, `node` itself may be where the aircraft
 * turns onto the next item (or enters the destination's way in, after the last item).
 * `closedWayIn`: on the last item, why a way in passed earlier on this taxiway was closed.
 */
function walkItem(
  ctx: Context,
  i: number,
  node: NodeId,
  arrived: Edge | null,
  used: EdgeId[],
  checkHere: boolean,
  closedWayIn: string | null,
): Outcome {
  const item = ctx.via[i];
  if (!item) throw new Error(`route item ${i} doesn't exist`);
  const next = ctx.via[i + 1];
  if (checkHere) {
    if (next) {
      // The first junction with the next taxiway is where it turns. It never skips one.
      if (waysOnto(ctx.index, node, arrived, used, next.taxiway).length > 0) return turnOnto(ctx, i + 1, node, arrived, used);
    } else {
      // A closed way in doesn't end the walk: another one may come further on.
      const entered = tryWayIn(ctx, node, arrived, used);
      if (entered?.kind === 'failed') closedWayIn ??= entered.reason;
      else if (entered) return entered;
    }
  }
  const forward = taxiwayEdgesAt(ctx.index, node, item.taxiway, arrived, used);
  if (forward.length === 0) {
    const reason = next
      ? notReachedReason(ctx.index, item.taxiway, next.taxiway)
      : (closedWayIn ?? `taxiway ${item.taxiway} doesn't lead to ${ctx.wayIn.describe} in the direction of travel`);
    return failed(i, used, reason);
  }
  return choose(
    node,
    item.taxiway,
    forward.map((edge) => travel(node, edge, used, i, (to, now) => walkItem(ctx, i, to, edge, now, true, closedWayIn))),
  );
}

/**
 * Combines the ways on from a node. If exactly one completes the route, it's that one (which
 * may itself be ambiguous further on). If several do, the route is ambiguous here, the first
 * place the pilot would have to ask. If none does, the failure that got furthest (the first of
 * equals).
 */
function choose(node: NodeId, taxiway: string, options: [Edge, Outcome][]): Outcome {
  const completing = options.filter(([, o]) => o.kind !== 'failed');
  const [only] = completing;
  if (only && completing.length === 1) return only[1];
  if (completing.length > 1) return { kind: 'ambiguous', node, taxiway, edges: completing.map(([e]) => e.id) };
  let best: Failed | null = null;
  for (const [, o] of options) {
    if (o.kind === 'failed' && (best === null || o.progress > best.progress)) best = o;
  }
  if (!best) throw new Error(`no ways on from "${node}" on taxiway ${taxiway}`);
  return best;
}

/** `item`: the route item being travelled, -1 before the first, `via.length` in the way in. */
function failed(item: number, used: EdgeId[], reason: string): Failed {
  return { kind: 'failed', reason, progress: (item + 1) * 1_000_000 + used.length };
}

/**
 * Which way `edge` turns off at `node`, for an aircraft that arrived along `arrived`: by the
 * last stretch of `arrived` into the node and the first stretch of `edge` out of it. null:
 * straight ahead or straight back.
 */
function turnSide(index: AirportIndex, node: NodeId, arrived: Edge, edge: Edge): Turn | null {
  const relative = turnAngle(index, node, arrived, edge);
  const epsilon = 1e-6;
  if (Math.abs(relative) < epsilon || Math.abs(relative) > 180 - epsilon) return null;
  return relative > 0 ? 'right' : 'left';
}

/**
 * The turn at `node` from `arrived` onto `edge`, in degrees in [-180, 180): clockwise
 * (right) is positive. By the last stretch of `arrived` into the node and the first stretch of
 * `edge` out of it.
 */
function turnAngle(index: AirportIndex, node: NodeId, arrived: Edge, edge: Edge): number {
  const inward = edgePolyline(index, arrived);
  if (arrived.to !== node) inward.reverse();
  const outward = edgePolyline(index, edge);
  if (edge.from !== node) outward.reverse();
  const [a, b] = [inward.at(-2), inward.at(-1)];
  const [c, d] = [outward[0], outward[1]];
  if (!a || !b || !c || !d) throw new Error(`edge "${arrived.id}" or "${edge.id}" has no length`);
  const delta = bearing(c, d) - bearing(a, b);
  return (((delta % 360) + 540) % 360) - 180;
}

/** Degrees clockwise from north (the local frame's +y), from `a` toward `b`. */
function bearing(a: Point, b: Point): number {
  return (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
}

/** The taxiway edges named `name` at `node`, other than `arrived` and edges already used. */
function taxiwayEdgesAt(index: AirportIndex, node: NodeId, name: string, arrived: Edge | null, used: EdgeId[]): Edge[] {
  return edgesAt(index, node).filter(
    (e) => e.kind === 'taxiway' && e.name === name && e.id !== arrived?.id && !used.includes(e.id),
  );
}

/**
 * One way on from `node` along `edge`, as an option for `choose`: the rest of the route from
 * the far end (`then`, given that node and the edges used so far), or, if the edge is closed,
 * a failure naming the closure. `item` is the route item being travelled (-1 before the first).
 */
function travel(
  node: NodeId,
  edge: Edge,
  used: EdgeId[],
  item: number,
  then: (to: NodeId, used: EdgeId[]) => Outcome,
): [Edge, Outcome] {
  if (edge.closed) return [edge, failed(item, used, closedReason(node, edge, edge.closed))];
  const to = otherEnd(edge, node);
  return [edge, prefix({ edge, to }, then(to, [...used, edge.id]))];
}

function closedReason(node: NodeId, edge: Edge, closure: Closure): string {
  const what = edge.name === undefined ? 'the taxiway' : `taxiway ${edge.name}`;
  return `${what} is closed between ${node} and ${otherEnd(edge, node)} (${closure.reason})`;
}

function prefix(step: Step, outcome: Outcome): Outcome {
  return outcome.kind === 'done' ? { ...outcome, steps: [step, ...outcome.steps] } : outcome;
}

// ---------------------------------------------------------------------------------------------
// The destination's own way in

type WayIn =
  | { kind: 'runway'; describe: string; runwayEnd: RunwayEndDesignator; lines: LineWay[] }
  | { kind: 'ramp'; describe: string; terminal: TerminalId; handoffs: RampHandoff[] }
  | { kind: 'holding'; describe: string; destination: HoldingDestination; areas: HoldingArea[] }
  | { kind: 'hangar'; describe: string; hangars: Hangar[] };

/** A departure line walked in queue order, back to front: `steps[i]` leaves `nodes[i]`. */
interface LineWay {
  line: DepartureLine;
  nodes: NodeId[];
  steps: Step[];
}

/** Orders a departure line's nodes from its back to its front hold. Throws on broken data (validate first). */
function lineWay(index: AirportIndex, line: DepartureLine): LineWay {
  const hold = index.airport.holdShorts.find((h) => h.id === line.holdShort);
  if (!hold) throw new Error(`departure line "${line.id}" refers to unknown hold-short "${line.holdShort}"`);
  const nodes = [hold.node];
  const steps: Step[] = [];
  let ahead = hold.node;
  for (const id of [...line.edges].reverse()) {
    const edge = index.edges.get(id);
    if (!edge) throw new Error(`departure line "${line.id}" refers to unknown edge "${id}"`);
    const behind = otherEnd(edge, ahead);
    nodes.unshift(behind);
    steps.unshift({ edge, to: ahead });
    ahead = behind;
  }
  return { line, nodes, steps };
}

function resolveWayIn(index: AirportIndex, taxi: Taxi, start: RouteStart): WayIn | RouteUnable {
  const to = taxi.to;
  switch (to.kind) {
    case 'runway': {
      if (!index.runwayEnds.has(to.name)) return { type: 'unable', reason: `no runway ${to.name} at ${index.airport.id}` };
      const lines = index.airport.departureLines.filter((l) => l.runwayEnd === to.name).map((l) => lineWay(index, l));
      if (lines.length === 0) return { type: 'unable', reason: `runway ${to.name} has no departure line at ${index.airport.id}` };
      return { kind: 'runway', describe: `runway ${to.name}'s departure line`, runwayEnd: to.name, lines };
    }
    case 'ramp': {
      const name = to.name ?? start.terminal;
      if (name === null) return { type: 'unable', reason: "taxi to the ramp: no terminal named, and the aircraft's is unknown" };
      // A ramp is named by its terminal's id, the short spoken form ("T4"), not its display name
      // ("Terminal 4"). Command names are uppercase, so case is ignored.
      const terminal = index.airport.terminals.find((t) => t.id.toUpperCase() === name.toUpperCase());
      if (!terminal) return { type: 'unable', reason: `no terminal ${name} at ${index.airport.id}` };
      const handoffs = index.airport.rampHandoffs.filter(
        (h) => h.use !== 'departures' && (h.terminals === undefined || h.terminals.includes(terminal.id)),
      );
      if (handoffs.length === 0) return { type: 'unable', reason: `no ramp entrance serves ${terminal.id} at ${index.airport.id}` };
      return { kind: 'ramp', describe: `a ramp entrance for ${terminal.id}`, terminal: terminal.id, handoffs };
    }
    case 'pad':
    case 'penalty-box':
    case 'hardstand': {
      const kind = HOLDING_KIND[to.kind];
      const name = to.name;
      // A name matches the area's id, name or a spoken name ("Quebec box"). Command names are
      // uppercase and ids free-form ("padNorth"), so case is ignored.
      const areas = index.airport.holdingAreas.filter(
        (a) => a.kind === kind && (name === null || holdingAreaNames(a).includes(name.toLowerCase())),
      );
      const what = HOLDING_WHAT[to.kind];
      if (areas.length === 0) {
        const reason = name === null ? `${index.airport.id} has no ${what}` : `no ${what} ${name} at ${index.airport.id}`;
        return { type: 'unable', reason };
      }
      const describe = name !== null ? `${what} ${name}` : to.kind === 'pad' ? 'a pad' : `the ${what}`;
      return { kind: 'holding', describe, destination: to.kind, areas };
    }
    case 'hangar': {
      const all = index.airport.hangars;
      if (to.name === null) {
        // "The company hangar": the one belonging to the aircraft's airline.
        const airline = start.airline ?? null;
        if (airline === null) return { type: 'unable', reason: "taxi to the company hangar: the aircraft's airline is unknown" };
        const hangars = all.filter((h) => h.airlines.some((a) => a.toUpperCase() === airline.toUpperCase()));
        if (hangars.length === 0) return { type: 'unable', reason: `no company hangar for ${airline} at ${index.airport.id}` };
        return { kind: 'hangar', describe: `the ${airline} hangar`, hangars };
      }
      // A name matches the hangar's id, name or one of its airlines, ignoring case.
      const name = to.name.toLowerCase();
      const hangars = all.filter((h) => [h.id, h.name, ...h.airlines].some((n) => n.toLowerCase() === name));
      if (hangars.length === 0) return { type: 'unable', reason: `no hangar ${to.name} at ${index.airport.id}` };
      return { kind: 'hangar', describe: `hangar ${to.name}`, hangars };
    }
  }
}

/**
 * Enters the destination's way in at `node`, if it starts here. null: it doesn't start here.
 * A failure: it starts here but is closed.
 */
function tryWayIn(ctx: Context, node: NodeId, arrived: Edge | null, used: EdgeId[]): Outcome | null {
  const wayIn = ctx.wayIn;
  if (wayIn.kind === 'runway') {
    for (const { line, nodes, steps: lineSteps } of wayIn.lines) {
      const j = nodes.indexOf(node);
      if (j < 0) continue;
      const steps = lineSteps.slice(j);
      // Joining here would mean reversing along the line.
      if (steps[0] && steps[0].edge.id === arrived?.id) continue;
      const closed = steps.find((s) => s.edge.closed);
      if (closed?.edge.closed) {
        return failed(ctx.via.length, used, closedReason(otherEnd(closed.edge, closed.to), closed.edge, closed.edge.closed));
      }
      const destination = { kind: 'runway' as const, runwayEnd: wayIn.runwayEnd, departureLine: line.id, holdShort: line.holdShort };
      return { kind: 'done', steps, destination };
    }
    return null;
  }
  if (wayIn.kind === 'hangar') {
    const handoffs = new Set(ctx.index.airport.rampHandoffs.map((h) => h.node));
    const hangarOf = (n: NodeId) => wayIn.hangars.find((h) => h.spots.includes(n));
    // Unnamed taxiway edges, or ramp lanes that don't pass a ramp handoff (the ramp's own area).
    const ok = (e: Edge) =>
      (e.kind === 'taxiway' && e.name === undefined) || (e.kind === 'rampLane' && !handoffs.has(e.from) && !handoffs.has(e.to));
    const found = leadIn(ctx.index, node, arrived, used, ok, (n) => hangarOf(n) !== undefined, offRouteNetwork(ctx.index));
    if (found === null) return null;
    if (found.kind === 'closed') return failed(ctx.via.length, used, found.reason);
    const spot = found.steps.at(-1)?.to ?? node;
    const hangar = hangarOf(spot);
    if (!hangar) throw new Error(`lead-in ended off a hangar spot, at "${spot}"`);
    return { kind: 'done', steps: found.steps, destination: { kind: 'hangar', hangar: hangar.id, spot } };
  }
  if (wayIn.kind === 'holding') {
    const areaOf = (n: NodeId) => wayIn.areas.find((a) => a.spots.includes(n));
    const found = leadIn(
      ctx.index,
      node,
      arrived,
      used,
      (e) => e.kind === 'taxiway' && e.name === undefined,
      (n) => areaOf(n) !== undefined,
      offRouteNetwork(ctx.index),
    );
    if (found === null) return null;
    if (found.kind === 'closed') return failed(ctx.via.length, used, found.reason);
    // With no steps, the aircraft is on a spot already.
    const spot = found.steps.at(-1)?.to ?? node;
    const area = areaOf(spot);
    if (!area) throw new Error(`lead-in ended off a spot, at "${spot}"`);
    return { kind: 'done', steps: found.steps, destination: { kind: wayIn.destination, holdingArea: area.id, spot } };
  }
  let closed: string | null = null;
  for (const handoff of wayIn.handoffs) {
    const found = leadIn(ctx.index, node, arrived, used, (e) => e.kind === 'taxiway' && e.name === handoff.name, (n) => n === handoff.node, () => true);
    if (found?.kind === 'open') {
      return { kind: 'done', steps: found.steps, destination: { kind: 'ramp', terminal: wayIn.terminal, rampHandoff: handoff.id } };
    }
    if (found?.kind === 'closed') closed ??= found.reason;
  }
  return closed === null ? null : failed(ctx.via.length, used, closed);
}

type LeadIn = { kind: 'open'; steps: Step[] } | { kind: 'closed'; reason: string };

/**
 * A lead-in may pass only nodes off the route network: no named taxiway and no runway there.
 * Otherwise a holding area's or hangar's unnamed lead-in could hop across connectors and other
 * taxiways, and the aircraft would be finding its own way.
 */
function offRouteNetwork(index: AirportIndex): (node: NodeId) => boolean {
  return (node) => !edgesAt(index, node).some((e) => e.kind === 'runway' || (e.kind === 'taxiway' && e.name !== undefined));
}

/**
 * The shortest way from `start` to a goal node over the edges that pass `edgeOk`, through
 * nodes (after `start`) that pass `passable`. null: there is none. `closed`: there is one, but
 * only through a closed edge, which the reason names.
 */
function leadIn(
  index: AirportIndex,
  start: NodeId,
  arrived: Edge | null,
  used: EdgeId[],
  edgeOk: (edge: Edge) => boolean,
  isGoal: (node: NodeId) => boolean,
  passable: (node: NodeId) => boolean,
): LeadIn | null {
  const open = shortestWay(index, start, arrived, used, (e) => !e.closed && edgeOk(e), isGoal, passable);
  if (open) return { kind: 'open', steps: open };
  const any = shortestWay(index, start, arrived, used, edgeOk, isGoal, passable);
  if (!any) return null;
  let from = start;
  for (const step of any) {
    if (step.edge.closed) return { kind: 'closed', reason: closedReason(from, step.edge, step.edge.closed) };
    from = step.to;
  }
  throw new Error(`a way from "${start}" was found only with closed edges allowed, but has none`);
}

/**
 * Dijkstra by length over (node, edge arrived along), so it never reverses onto the edge just
 * travelled, and never reuses `used`. Ways in are a few edges long, so a linear scan for the
 * nearest label is enough. Ties go to the label queued first, which keeps it deterministic.
 */
function shortestWay(
  index: AirportIndex,
  start: NodeId,
  arrived: Edge | null,
  used: EdgeId[],
  edgeOk: (edge: Edge) => boolean,
  isGoal: (node: NodeId) => boolean,
  passable: (node: NodeId) => boolean,
): Step[] | null {
  interface Label {
    node: NodeId;
    via: Edge | null;
    dist: number;
    steps: Step[];
  }
  const queue: Label[] = [{ node: start, via: arrived, dist: 0, steps: [] }];
  const settled = new Set<string>();
  while (queue.length > 0) {
    const label = queue.reduce((a, b) => (b.dist < a.dist ? b : a));
    queue.splice(queue.indexOf(label), 1);
    const key = `${label.node}|${label.via?.id ?? ''}`;
    if (settled.has(key)) continue;
    settled.add(key);
    if (isGoal(label.node)) return label.steps;
    if (label.node !== start && !passable(label.node)) continue;
    for (const edge of edgesAt(index, label.node)) {
      if (edge.id === label.via?.id || used.includes(edge.id) || !edgeOk(edge)) continue;
      if (label.steps.some((s) => s.edge.id === edge.id)) continue;
      const to = otherEnd(edge, label.node);
      queue.push({ node: to, via: edge, dist: label.dist + edgeLength(index, edge), steps: [...label.steps, { edge, to }] });
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The result

function buildPath(
  index: AirportIndex,
  startNode: NodeId,
  done: Extract<Outcome, { kind: 'done' }>,
  targets: HoldShortTarget[],
): RoutePath | RouteUnable {
  const nodes = [startNode, ...done.steps.map((s) => s.to)];
  const edges = done.steps.map((s) => s.edge.id);
  const lengthM = done.steps.reduce((sum, s) => sum + edgeLength(index, s.edge), 0);
  const holdShorts: PassedHoldShort[] = [];
  edges.forEach((edge, i) => {
    for (const h of index.airport.holdShorts) {
      if (h.node === nodes[i] && h.towardEdge === edge) holdShorts.push({ id: h.id, kind: h.kind, runways: h.runways, index: i });
    }
  });
  const lineAt = (i: number) => holdShorts.find((h) => h.index === i)?.id ?? null;

  const clearanceHolds: ClearanceHold[] = [];
  for (const target of targets) {
    if (target.kind === 'runway') {
      const runway = index.runwayEnds.get(target.name)?.runway;
      if (!runway) throw new Error(`checkTargets passed unknown runway "${target.name}"`);
      const at: HoldPoint[] = holdShorts
        .filter((h) => h.kind === 'runway' && h.runways.includes(runway.id))
        .map((h) => ({ index: h.index, holdShort: h.id }));
      // A taxi to a runway ends at its departure line's front hold, facing the runway.
      if (done.destination.kind === 'runway') {
        const frontId = done.destination.holdShort;
        const front = index.airport.holdShorts.find((h) => h.id === frontId);
        if (front?.runways.includes(runway.id)) at.push({ index: nodes.length - 1, holdShort: front.id });
      }
      if (at.length === 0) {
        return { type: 'unable', reason: `hold short of runway ${target.name}: the route doesn't cross runway ${runway.id}` };
      }
      clearanceHolds.push({ target, at });
      continue;
    }
    // The first node on the taxiway that the path reaches from off it: entering or crossing.
    const name = target.name;
    const i = nodes.findIndex(
      (n, k) => k > 0 && done.steps[k - 1]?.edge.name !== name && edgesAt(index, n).some((e) => e.kind !== 'runway' && e.name === name),
    );
    if (i < 0) return { type: 'unable', reason: `hold short of ${name}: the route never meets taxiway ${name}` };
    clearanceHolds.push({ target, at: [{ index: i - 1, holdShort: lineAt(i - 1) }] });
  }
  return { type: 'path', nodes, edges, lengthM, holdShorts, clearanceHolds, destination: done.destination };
}
