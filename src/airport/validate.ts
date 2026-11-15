// Meaning checks on a loaded airport: unique ids, references that resolve, connectivity,
// and the consistency rules the simulation relies on. Pure, and never throws on bad data:
// every problem becomes an issue with a stable `code` and a message that says what to fix.
//
// Errors make the airport unusable; warnings are odd but possibly intended. Reachability
// checks use open (non-closed) edges only.

import { edgeLength, edgesAt, holdingAreaNames, indexAirport, otherEnd, touches, type AirportIndex } from './graph.ts';
import {
  COLLECTION_ITEM_NAMES,
  COLLECTION_KEYS,
  type Airport,
  type Edge,
  type RampHandoff,
  type Runway,
} from './types.ts';

export type IssueCode =
  // ids and references
  | 'duplicate-id'
  | 'duplicate-runway-end'
  | 'unknown-reference'
  // nodes and edges
  | 'edge-self-loop'
  | 'edge-runway-field'
  | 'zero-length-edge'
  | 'unused-node'
  | 'far-from-reference'
  | 'disconnected-network'
  // runways
  | 'runway-designator-invalid'
  | 'runway-designators-not-reciprocal'
  | 'runway-centerline-invalid'
  | 'runway-displaced-threshold-invalid'
  | 'runway-exit-not-on-runway'
  | 'runway-exit-edge-mismatch'
  | 'runway-exit-onto-runway'
  | 'runway-exit-name-mismatch'
  | 'runway-exit-closed'
  | 'runway-entry-unprotected'
  // hold-shorts
  | 'hold-short-no-runway'
  | 'hold-short-intermediate-with-runway'
  | 'hold-short-runway-repeated'
  | 'hold-short-edge-mismatch'
  | 'hold-short-on-runway'
  | 'hold-short-far-from-runway'
  // ramp, terminals, gates
  | 'ramp-handoff-not-on-boundary'
  | 'ramp-handoff-unreachable'
  | 'ramp-boundary-undeclared'
  | 'gate-not-on-ramp'
  | 'gate-unreachable'
  | 'gate-airline-not-in-terminal'
  | 'duplicate-gate-name'
  | 'terminal-airline-repeated'
  | 'terminal-without-gates'
  // holding areas
  | 'holding-area-no-spots'
  | 'holding-spot-on-runway'
  | 'holding-spot-unreachable'
  | 'holding-area-no-entrances'
  | 'holding-area-entrance-invalid'
  | 'holding-area-name-repeated'
  | 'no-holding-pad'
  | 'no-penalty-box'
  // hangars
  | 'hangar-no-spots'
  | 'hangar-spot-on-runway'
  | 'hangar-spot-unreachable'
  | 'hangar-airline-repeated'
  // departure lines
  | 'departure-line-empty'
  | 'departure-line-no-exits'
  | 'departure-line-hold-short-mismatch'
  | 'departure-line-not-a-path'
  | 'departure-line-on-runway'
  | 'departure-line-closed'
  | 'departure-line-exit-not-on-line'
  | 'departure-line-exits-out-of-order'
  | 'departure-line-exit-edge-mismatch'
  | 'departure-line-exit-onto-runway'
  | 'departure-line-exit-name-mismatch'
  | 'departure-line-exit-closed'
  // configurations, tower, display geometry
  | 'no-configurations'
  | 'no-default-configuration'
  | 'configuration-empty'
  | 'configuration-roles-invalid'
  | 'configuration-runway-repeated'
  | 'configuration-exits-without-arrivals'
  | 'configuration-exit-wrong-end'
  | 'configuration-arrival-end-without-exits'
  | 'configuration-departure-end-without-line'
  | 'configuration-incomplete'
  | 'tower-frequency-invalid'
  | 'outline-invalid';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: IssueCode;
  message: string;
  /** Ids of the items involved, first the one the issue is about. */
  ids: string[];
}

export interface ValidationResult {
  /** True when there are no errors (warnings allowed). */
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** A hold-short should be within this graph distance (m) of each runway it protects. */
export const HOLD_SHORT_REACH_M = 500;
/** Positions farther than this (m) from the reference point suggest a projection mistake. */
export const MAX_DISTANCE_FROM_REFERENCE_M = 20_000;

/** FAA style, as the terse parser normalizes it: 1–36, no leading zero, optional L/C/R. */
const DESIGNATOR = /^([1-9]|[12][0-9]|3[0-6])([LCR]?)$/;
const FREQUENCY = /^\d{3}\.\d{1,3}$/;

export function validateAirport(airport: Airport): ValidationResult {
  const v = new Validator(airport);
  v.run();
  return { ok: v.errors.length === 0, errors: v.errors, warnings: v.warnings };
}

/**
 * The nodes reachable from `start` over open `rampLane` edges (`start` included): where the
 * simulated ramp can move an aircraft from there without using the movement area.
 */
export function rampReach(index: AirportIndex, start: string): Set<string> {
  const seen = new Set([start]);
  const queue = [start];
  for (let node = queue.shift(); node !== undefined; node = queue.shift()) {
    for (const edge of edgesAt(index, node)) {
      if (edge.kind !== 'rampLane' || edge.closed) continue;
      const next = otherEnd(edge, node);
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

interface RunwayInfo {
  runway: Runway;
  /** Every node of the runway's edges. */
  nodes: Set<string>;
  /** Total centerline length, when the centerline is a valid path with known geometry. */
  lengthM?: number;
}

class Validator {
  readonly errors: ValidationIssue[] = [];
  readonly warnings: ValidationIssue[] = [];
  private readonly a: Airport;
  private readonly index: AirportIndex;
  private readonly runwayInfo = new Map<string, RunwayInfo>();
  /** Nodes of the largest component of open edges: "the airport's network". */
  private mainNodes = new Set<string>();

  constructor(airport: Airport) {
    this.a = airport;
    this.index = indexAirport(airport);
  }

  run(): void {
    this.checkIds();
    this.checkEdges();
    this.checkNodes();
    this.checkRunways();
    this.checkRunwayExits();
    this.checkHoldShorts();
    this.checkNetwork();
    this.checkRunwayEntries();
    this.checkRamp();
    this.checkHoldingAreas();
    this.checkHangars();
    this.checkDepartureLines();
    this.checkConfigurations();
    this.checkTowerAndAreas();
  }

  private error(code: IssueCode, message: string, ids: string[]): void {
    this.errors.push({ severity: 'error', code, message, ids });
  }

  private warn(code: IssueCode, message: string, ids: string[]): void {
    this.warnings.push({ severity: 'warning', code, message, ids });
  }

  /** Reports an unknown reference; returns whether the target exists. */
  private ref(exists: boolean, owner: string, what: string, id: string, ownerId: string): boolean {
    if (!exists) this.error('unknown-reference', `${owner} refers to unknown ${what} "${id}"`, [ownerId, id]);
    return exists;
  }

  private nodeRef(id: string, owner: string, ownerId: string): boolean {
    return this.ref(this.index.nodes.has(id), owner, 'node', id, ownerId);
  }

  private edgeRef(id: string, owner: string, ownerId: string): Edge | undefined {
    const edge = this.index.edges.get(id);
    this.ref(edge !== undefined, owner, 'edge', id, ownerId);
    return edge;
  }

  /** Edge length, or undefined when an end node is missing (already reported). */
  private lengthOf(edge: Edge): number | undefined {
    if (!this.index.nodes.has(edge.from) || !this.index.nodes.has(edge.to)) return undefined;
    return edgeLength(this.index, edge);
  }

  // -------------------------------------------------------------------------------------------

  private checkIds(): void {
    for (const key of COLLECTION_KEYS) {
      const counts = new Map<string, number>();
      for (const item of this.a[key] as { id: string }[]) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
      for (const [id, n] of counts) {
        if (n > 1) {
          this.error('duplicate-id', `${n} ${COLLECTION_ITEM_NAMES[key]}s have id "${id}"; ids must be unique within "${key}"`, [id]);
        }
      }
    }
    const ends = new Map<string, string[]>();
    for (const runway of this.a.runways) {
      for (const end of runway.ends) ends.set(end.designator, [...(ends.get(end.designator) ?? []), runway.id]);
    }
    for (const [designator, runways] of ends) {
      if (runways.length > 1) {
        this.error('duplicate-runway-end', `runway end "${designator}" is defined ${runways.length} times (runways ${quoteList(runways)}); designators must be unique`, [designator, ...runways]);
      }
    }
  }

  private checkEdges(): void {
    for (const e of this.a.edges) {
      const owner = `edge "${e.id}"`;
      this.nodeRef(e.from, owner, e.id);
      this.nodeRef(e.to, owner, e.id);
      if (e.from === e.to) this.error('edge-self-loop', `${owner} starts and ends at node "${e.from}"`, [e.id]);
      if (e.kind === 'runway') {
        if (e.runway === undefined) {
          this.error('edge-runway-field', `runway ${owner} has no "runway"; set it to the id of the runway it belongs to`, [e.id]);
        } else {
          this.ref(this.index.runways.has(e.runway), owner, 'runway', e.runway, e.id);
        }
        if (e.name !== undefined) {
          this.error('edge-runway-field', `runway ${owner} has a name ("${e.name}"); runway edges are identified by "runway", names are for taxiways and ramp lanes`, [e.id]);
        }
      } else if (e.runway !== undefined) {
        this.error('edge-runway-field', `${e.kind} ${owner} has "runway" set; only runway edges may`, [e.id]);
      }
      const length = this.lengthOf(e);
      if (length === 0 && e.from !== e.to) {
        this.warn('zero-length-edge', `${owner} has zero length (its nodes share a position and it has no shape points)`, [e.id]);
      }
    }
  }

  private checkNodes(): void {
    for (const n of this.a.nodes) {
      if (edgesAt(this.index, n.id).length === 0) this.warn('unused-node', `node "${n.id}" has no edges`, [n.id]);
    }
    const far: string[] = [];
    const tooFar = (x: number, y: number) => Math.hypot(x, y) > MAX_DISTANCE_FROM_REFERENCE_M;
    for (const n of this.a.nodes) if (tooFar(n.x, n.y)) far.push(`node "${n.id}"`);
    for (const e of this.a.edges) if (e.points?.some(([x, y]) => tooFar(x, y))) far.push(`edge "${e.id}"`);
    for (const shape of [...this.a.areas, ...this.a.holdingAreas, ...this.a.hangars]) {
      if (shape.outline?.some(([x, y]) => tooFar(x, y))) far.push(`outline of "${shape.id}"`);
    }
    if (far.length > 0) {
      this.warn('far-from-reference', `${far.length} position(s) lie more than ${MAX_DISTANCE_FROM_REFERENCE_M / 1000} km from the reference point (${listSome(far)}); check the projection and the reference lat/lon`, []);
    }
  }

  private checkRunways(): void {
    for (const runway of this.a.runways) {
      const owner = `runway "${runway.id}"`;
      const [end0, end1] = runway.ends;
      for (const end of runway.ends) {
        if (!DESIGNATOR.test(end.designator)) {
          this.error('runway-designator-invalid', `${owner} end "${end.designator}" is not a runway designator: expected 1–36 without a leading zero, then optional L, C or R (e.g. "4L", "31R", "9")`, [runway.id]);
        }
        this.nodeRef(end.node, `${owner} end "${end.designator}"`, runway.id);
      }
      if (!reciprocal(end0.designator, end1.designator)) {
        this.warn('runway-designators-not-reciprocal', `${owner} ends "${end0.designator}" and "${end1.designator}" aren't reciprocal (expected numbers 18 apart, L↔R, C↔C)`, [runway.id]);
      }
      if (runway.towerPosition !== undefined) {
        this.ref(this.a.towerPositions.some((t) => t.id === runway.towerPosition), owner, 'tower position', runway.towerPosition, runway.id);
      }
      this.runwayInfo.set(runway.id, this.checkCenterline(runway));
    }
  }

  /** The runway's edges must form one path from ends[0].node to ends[1].node. */
  private checkCenterline(runway: Runway): RunwayInfo {
    const owner = `runway "${runway.id}"`;
    const edges = this.a.edges.filter((e) => e.kind === 'runway' && e.runway === runway.id);
    const info: RunwayInfo = { runway, nodes: new Set(edges.flatMap((e) => [e.from, e.to])) };
    const [end0, end1] = runway.ends;
    if (edges.length === 0) {
      this.error('runway-centerline-invalid', `${owner} has no edges; add "runway" edges with runway "${runway.id}" from node "${end0.node}" to node "${end1.node}"`, [runway.id]);
      return info;
    }
    const at = new Map<string, Edge[]>();
    for (const e of edges) for (const n of [e.from, e.to]) at.set(n, [...(at.get(n) ?? []), e]);
    const fail = (why: string) => {
      this.error('runway-centerline-invalid', `${owner}'s edges must form one path from end "${end0.designator}" (node "${end0.node}") to end "${end1.designator}" (node "${end1.node}"), but ${why}`, [runway.id]);
      return info;
    };
    for (const end of runway.ends) {
      const degree = at.get(end.node)?.length ?? 0;
      if (degree !== 1) return fail(`end "${end.designator}"'s node "${end.node}" has ${degree} runway edges (expected 1)`);
    }
    const used = new Set<string>();
    let node = end0.node;
    let length: number | undefined = 0;
    for (;;) {
      const next = (at.get(node) ?? []).filter((e) => !used.has(e.id));
      if (next.length === 0) break;
      if (next.length > 1) return fail(`it branches at node "${node}" (edges ${quoteList(next.map((e) => e.id))})`);
      const edge = next[0] as Edge;
      used.add(edge.id);
      const l = this.lengthOf(edge);
      length = length === undefined || l === undefined ? undefined : length + l;
      node = otherEnd(edge, node);
    }
    if (node !== end1.node) return fail(`the path from "${end0.node}" stops at node "${node}"`);
    if (used.size !== edges.length) {
      return fail(`edges ${quoteList(edges.filter((e) => !used.has(e.id)).map((e) => e.id))} are not on that path`);
    }
    if (length !== undefined) {
      info.lengthM = length;
      for (const end of runway.ends) {
        if ((end.displacedThresholdM ?? 0) >= length) {
          this.error('runway-displaced-threshold-invalid', `${owner} end "${end.designator}" has a displaced threshold of ${end.displacedThresholdM} m, but the runway is only ${Math.round(length)} m long`, [runway.id]);
        }
      }
    }
    return info;
  }

  private checkRunwayExits(): void {
    for (const x of this.a.runwayExits) {
      const owner = `runway exit "${x.id}"`;
      const end = this.index.runwayEnds.get(x.runwayEnd);
      this.ref(end !== undefined, owner, 'runway end', x.runwayEnd, x.id);
      const nodeOk = this.nodeRef(x.node, owner, x.id);
      const edge = this.edgeRef(x.edge, owner, x.id);
      const info = end && this.runwayInfo.get(end.runway.id);
      if (info && nodeOk && !info.nodes.has(x.node)) {
        this.error('runway-exit-not-on-runway', `${owner}: node "${x.node}" is not on runway "${info.runway.id}"'s centerline`, [x.id, x.node]);
      }
      if (!edge) continue;
      if (!touches(edge, x.node)) {
        this.error('runway-exit-edge-mismatch', `${owner}: edge "${edge.id}" doesn't touch node "${x.node}"; "edge" must be the first edge off the runway at that node`, [x.id, edge.id]);
      }
      if (edge.kind === 'runway') {
        this.error('runway-exit-onto-runway', `${owner}: edge "${edge.id}" is a runway edge; an exit leads off the runway onto a taxiway`, [x.id, edge.id]);
      }
      if (edge.name !== x.taxiway) {
        const called = x.taxiway === undefined ? 'unnamed' : `called "${x.taxiway}"`;
        this.error('runway-exit-name-mismatch', `${owner} is ${called} but its edge "${edge.id}" is named ${edge.name === undefined ? 'nothing' : `"${edge.name}"`}`, [x.id, edge.id]);
      }
      if (edge.closed) {
        this.error('runway-exit-closed', `${owner}: edge "${edge.id}" is closed (${edge.closed.reason}); remove the exit or reopen the edge`, [x.id, edge.id]);
      }
    }
  }

  private checkHoldShorts(): void {
    for (const h of this.a.holdShorts) {
      const owner = `hold-short "${h.id}"`;
      if (h.kind === 'intermediate') {
        if (h.runways.length > 0) {
          this.error('hold-short-intermediate-with-runway', `${owner} is kind "intermediate" but lists runways ${quoteList(h.runways)}; intermediate holds protect taxiway intersections. Use kind "runway", "ils" or "lahso" for a runway hold`, [h.id]);
        }
      } else if (h.runways.length === 0) {
        this.error('hold-short-no-runway', `${owner} (kind "${h.kind}", at node "${h.node}") protects no runway; list the runway(s) it protects in "runways" (more than one where runways intersect)`, [h.id]);
      }
      if (new Set(h.runways).size !== h.runways.length) {
        this.error('hold-short-runway-repeated', `${owner} lists a runway more than once: ${quoteList(h.runways)}`, [h.id]);
      }
      const nodeOk = this.nodeRef(h.node, owner, h.id);
      const edge = this.edgeRef(h.towardEdge, owner, h.id);
      if (edge && !touches(edge, h.node)) {
        this.error('hold-short-edge-mismatch', `${owner}: towardEdge "${edge.id}" doesn't touch its node "${h.node}"; it must be the edge from that node toward what the hold protects`, [h.id, edge.id]);
      }
      for (const runwayId of new Set(h.runways)) {
        if (!this.ref(this.index.runways.has(runwayId), owner, 'runway', runwayId, h.id)) continue;
        const info = this.runwayInfo.get(runwayId);
        if (!info || !nodeOk) continue;
        if (info.nodes.has(h.node)) {
          this.error('hold-short-on-runway', `${owner} sits on the centerline of runway "${runwayId}" (node "${h.node}"), the runway it protects; a hold line belongs before the runway, on the taxiway (or, for LAHSO, on the other runway)`, [h.id, runwayId]);
        } else if (edge && touches(edge, h.node) && !this.withinReach(h.node, edge, info.nodes, HOLD_SHORT_REACH_M)) {
          this.warn('hold-short-far-from-runway', `${owner} protects runway "${runwayId}", but no node of that runway is within ${HOLD_SHORT_REACH_M} m beyond it (via towardEdge "${edge.id}"); check its runways and towardEdge`, [h.id, runwayId]);
        }
      }
    }
  }

  /** Is any of `targets` within `limit` meters of `start`, leaving by `first`? */
  private withinReach(start: string, first: Edge, targets: Set<string>, limit: number): boolean {
    const firstLength = this.lengthOf(first);
    if (firstLength === undefined) return true; // geometry unknown; reported elsewhere
    const dist = new Map<string, number>([[start, 0]]);
    const frontier: [string, number][] = [[otherEnd(first, start), firstLength]];
    while (frontier.length > 0) {
      frontier.sort((p, q) => q[1] - p[1]);
      const [node, d] = frontier.pop() as [string, number];
      if (d > limit) return false;
      if ((dist.get(node) ?? Infinity) < d) continue;
      dist.set(node, d);
      if (targets.has(node)) return true;
      for (const e of edgesAt(this.index, node)) {
        const l = this.lengthOf(e);
        if (l === undefined) continue;
        const next = otherEnd(e, node);
        if (d + l < (dist.get(next) ?? Infinity)) frontier.push([next, d + l]);
      }
    }
    return false;
  }

  /** Every open edge must belong to one connected network. */
  private checkNetwork(): void {
    const open = this.a.edges.filter((e) => !e.closed && this.index.nodes.has(e.from) && this.index.nodes.has(e.to));
    const parent = new Map<string, string>();
    const find = (n: string): string => {
      let root = n;
      for (let up = parent.get(root); up !== undefined && up !== root; up = parent.get(root)) root = up;
      parent.set(n, root);
      return root;
    };
    for (const e of open) {
      for (const n of [e.from, e.to]) if (!parent.has(n)) parent.set(n, n);
      const [ra, rb] = [find(e.from), find(e.to)];
      if (ra !== rb) parent.set(ra, rb);
    }
    const components = new Map<string, { nodes: Set<string>; edges: Edge[] }>();
    for (const e of open) {
      const root = find(e.from);
      let c = components.get(root);
      if (!c) {
        c = { nodes: new Set(), edges: [] };
        components.set(root, c);
      }
      c.edges.push(e);
      c.nodes.add(e.from).add(e.to);
    }
    let main: { nodes: Set<string>; edges: Edge[] } | undefined;
    for (const c of components.values()) if (!main || c.edges.length > main.edges.length) main = c;
    if (!main) return;
    this.mainNodes = main.nodes;
    for (const c of components.values()) {
      if (c === main) continue;
      const bridges = this.a.edges.filter((e) => e.closed && ((c.nodes.has(e.from) && main.nodes.has(e.to)) || (c.nodes.has(e.to) && main.nodes.has(e.from))));
      const viaClosed = bridges.length > 0 ? ` It joins the network only through closed edge(s) ${quoteList(bridges.map((e) => e.id))}.` : '';
      const one = c.edges.length === 1;
      this.error('disconnected-network', `${describeEdges(c.edges)} ${one ? 'is' : 'are'} not connected to the rest of the airport's open network (${main.edges.length} edges): edge${one ? '' : 's'} ${listSome(c.edges.map((e) => `"${e.id}"`))} share${one ? 's' : ''} no node with it.${viaClosed} Connect ${one ? 'it' : 'them'}, or close or remove ${one ? 'it' : 'them'}`, c.edges.map((e) => e.id));
    }
  }

  /**
   * Taxiing from the ramp or a holding spot must never reach a runway without passing one of
   * its `runway` hold-shorts (in the protected direction). Runway edges themselves aren't
   * walked: aircraft cross runways at nodes, they don't taxi along them.
   */
  private checkRunwayEntries(): void {
    const sources = [
      ...this.a.rampHandoffs.map((h) => h.node),
      ...this.a.holdingAreas.flatMap((a) => a.spots),
      ...this.a.hangars.flatMap((h) => h.spots),
    ].filter((n) => this.index.nodes.has(n));
    if (sources.length === 0) return;
    for (const info of this.runwayInfo.values()) {
      const blocked = new Set(
        this.a.holdShorts.filter((h) => h.kind === 'runway' && h.runways.includes(info.runway.id)).map((h) => `${h.node}\u0000${h.towardEdge}`),
      );
      const seen = new Set(sources.filter((n) => !info.nodes.has(n)));
      const queue = [...seen];
      const entries = new Map<string, { from: string; to: string; edge: Edge }>();
      for (let node = queue.shift(); node !== undefined; node = queue.shift()) {
        for (const edge of edgesAt(this.index, node)) {
          if (edge.closed || edge.kind === 'runway' || blocked.has(`${node}\u0000${edge.id}`)) continue;
          const next = otherEnd(edge, node);
          if (info.nodes.has(next)) {
            if (!entries.has(edge.id)) entries.set(edge.id, { from: node, to: next, edge });
          } else if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      for (const { from, to, edge } of entries.values()) {
        this.error('runway-entry-unprotected', `runway "${info.runway.id}" can be entered without passing a runway hold-short for it: ${edge.kind} edge "${edge.id}"${edge.name ? ` (${edge.name})` : ''} leads from node "${from}" onto runway node "${to}". Add a holdShort (kind "runway", runways including "${info.runway.id}") on that way in, with towardEdge pointing at the runway`, [info.runway.id, edge.id]);
      }
    }
  }

  private checkRamp(): void {
    const handoffNodes = new Set(this.a.rampHandoffs.map((h) => h.node));
    const terminalIds = new Set(this.a.terminals.map((t) => t.id));
    const reach = new Map<string, Set<string>>();
    const reachOf = (h: RampHandoff) => {
      let r = reach.get(h.id);
      if (!r) {
        r = rampReach(this.index, h.node);
        reach.set(h.id, r);
      }
      return r;
    };

    for (const h of this.a.rampHandoffs) {
      const owner = `ramp handoff "${h.id}" ("${h.name}")`;
      for (const t of h.terminals ?? []) this.ref(terminalIds.has(t), owner, 'terminal', t, h.id);
      if (!this.nodeRef(h.node, owner, h.id)) continue;
      const edges = edgesAt(this.index, h.node);
      const hasRamp = edges.some((e) => e.kind === 'rampLane');
      const hasTaxiway = edges.some((e) => e.kind === 'taxiway');
      if (!hasRamp || !hasTaxiway) {
        this.error('ramp-handoff-not-on-boundary', `${owner} at node "${h.node}" must be where a ramp lane meets a taxiway, but that node touches no ${hasRamp ? 'taxiway' : 'rampLane'} edge`, [h.id]);
      } else if (!this.mainNodes.has(h.node)) {
        this.error('ramp-handoff-unreachable', `${owner} at node "${h.node}" is not connected to the airport's network over open edges`, [h.id]);
      }
    }

    const gateNodes = new Set(this.a.gates.map((g) => g.node));
    const hangarSpots = new Set(this.a.hangars.flatMap((h) => h.spots));
    for (const n of this.a.nodes) {
      if (handoffNodes.has(n.id)) continue;
      const edges = edgesAt(this.index, n.id);
      const ramp = edges.filter((e) => e.kind === 'rampLane');
      const ground = edges.filter((e) => e.kind !== 'rampLane');
      if (ramp.length > 0 && ground.length > 0) {
        // A hangar's ramp-lane lead-in: ground taxis into it, and there's no gate behind it.
        const behind = [...rampReach(this.index, n.id)];
        if (behind.some((m) => hangarSpots.has(m)) && !behind.some((m) => gateNodes.has(m))) continue;
        this.warn('ramp-boundary-undeclared', `node "${n.id}" joins ramp lane edge(s) ${quoteList(ramp.map((e) => e.id))} to ${ground[0]?.kind} edge(s) ${quoteList(ground.map((e) => e.id))} but is not a ramp handoff; declare one there (with its check-in name) if aircraft pass between ramp and ground here`, [n.id]);
      }
    }

    const terminals = new Map(this.a.terminals.map((t) => [t.id, t]));
    for (const t of this.a.terminals) {
      if (new Set(t.airlines).size !== t.airlines.length) {
        this.error('terminal-airline-repeated', `terminal "${t.id}" lists an airline more than once: ${quoteList(t.airlines)}`, [t.id]);
      }
      if (!this.a.gates.some((g) => g.terminal === t.id)) {
        this.warn('terminal-without-gates', `terminal "${t.id}" ("${t.name}") has no gates`, [t.id]);
      }
    }

    const names = new Map<string, string>();
    for (const g of this.a.gates) {
      const owner = `gate "${g.id}" ("${g.name}")`;
      const terminal = terminals.get(g.terminal);
      this.ref(terminal !== undefined, owner, 'terminal', g.terminal, g.id);
      const key = `${g.terminal}\u0000${g.name}`;
      const twin = names.get(key);
      if (twin !== undefined) {
        this.error('duplicate-gate-name', `gates "${twin}" and "${g.id}" are both named "${g.name}" in terminal "${g.terminal}"`, [g.id, twin]);
      } else {
        names.set(key, g.id);
      }
      if (terminal && g.airlines) {
        const extra = g.airlines.filter((x) => !terminal.airlines.includes(x));
        if (extra.length > 0) {
          this.error('gate-airline-not-in-terminal', `${owner} lists airline(s) ${quoteList(extra)} that terminal "${terminal.id}" doesn't have; a gate's airlines are a subset of its terminal's`, [g.id]);
        }
      }
      if (!this.nodeRef(g.node, owner, g.id)) continue;
      const notRamp = edgesAt(this.index, g.node).filter((e) => e.kind !== 'rampLane');
      if (notRamp.length > 0) {
        this.error('gate-not-on-ramp', `${owner} at node "${g.node}" touches ${notRamp[0]?.kind} edge(s) ${quoteList(notRamp.map((e) => e.id))}; gates sit at the end of ramp-lane lead-ins, inside the ramp`, [g.id]);
      }
      const serves = (h: RampHandoff) => h.terminals === undefined || h.terminals.includes(g.terminal);
      const inOk = this.a.rampHandoffs.some((h) => h.use !== 'departures' && serves(h) && reachOf(h).has(g.node));
      const outOk = this.a.rampHandoffs.some((h) => h.use !== 'arrivals' && serves(h) && reachOf(h).has(g.node));
      if (inOk && outOk) continue;
      const how = !inOk && !outOk
        ? 'reached from any ramp entrance (arrivals), nor left toward any ramp edge (departures),'
        : !inOk
          ? 'reached from any ramp entrance (arrivals)'
          : 'left toward any ramp edge (departures)';
      this.error('gate-unreachable', `${owner} can't be ${how} serving terminal "${g.terminal}" over open ramp lanes. ${this.gateHint(g.node, g.terminal, handoffNodes)}`, [g.id]);
    }
  }

  private gateHint(node: string, terminal: string, handoffNodes: Set<string>): string {
    const area = rampReach(this.index, node);
    if (area.size === 1) return 'It has no open ramp-lane edge (its lead-in is missing or closed).';
    const boundary = [...area].filter((n) => edgesAt(this.index, n).some((e) => e.kind !== 'rampLane'));
    const undeclared = boundary.filter((n) => !handoffNodes.has(n));
    if (undeclared.length > 0) {
      return `Its ramp lanes meet the taxiways at node(s) ${quoteList(undeclared)}, where no ramp handoff is declared: add one there.`;
    }
    if (boundary.length === 0) return "Its ramp lanes don't reach any taxiway.";
    const reached = this.a.rampHandoffs.filter((h) => area.has(h.node)).map((h) => h.id);
    return `The ramp handoff(s) its lanes reach (${quoteList(reached)}) don't serve terminal "${terminal}" in that direction.`;
  }

  private checkHoldingAreas(): void {
    for (const area of this.a.holdingAreas) {
      const owner = `holding area "${area.id}" ("${area.name}")`;
      if (area.spots.length === 0) {
        this.error('holding-area-no-spots', `${owner} has no spots; list the nodes where aircraft park in "spots"`, [area.id]);
      }
      for (const spot of area.spots) {
        if (!this.nodeRef(spot, owner, area.id)) continue;
        if (edgesAt(this.index, spot).some((e) => e.kind === 'runway')) {
          this.error('holding-spot-on-runway', `${owner}: spot "${spot}" is on a runway`, [area.id, spot]);
        } else if (!this.mainNodes.has(spot)) {
          this.error('holding-spot-unreachable', `${owner}: spot "${spot}" is not connected to the airport's network over open edges`, [area.id, spot]);
        } else if (!this.reachesNamedTaxiway(spot, (e) => e.kind === 'taxiway')) {
          this.error('holding-spot-unreachable', `${owner}: spot "${spot}" can't be reached from a named taxiway over open taxiway edges; ground taxis aircraft to it, so its lead-in must be taxiway edges`, [area.id, spot]);
        }
      }
      if (area.kind === 'hardstand' && (area.entrances ?? []).length === 0) {
        this.error('holding-area-no-entrances', `${owner} is a hardstand but lists no entrances; list the taxiways it is entered from in "entrances"`, [area.id]);
      }
      const spots = new Set(area.spots);
      for (const entrance of area.entrances ?? []) {
        const starts = this.a.edges.filter((e) => e.kind === 'taxiway' && e.name === entrance).flatMap((e) => [e.from, e.to]);
        if (starts.length === 0) {
          this.error('holding-area-entrance-invalid', `${owner}: entrance "${entrance}" is not a taxiway`, [area.id]);
        } else if (!starts.some((n) => [...this.leadInReach(n)].some((m) => spots.has(m)))) {
          this.error('holding-area-entrance-invalid', `${owner}: no spot is reached from taxiway ${entrance} over open, unnamed taxiway edges (the area's lead-in); remove the entrance or connect it`, [area.id]);
        }
      }
      if (area.outline && area.outline.length < 3) {
        this.error('outline-invalid', `${owner}'s outline has ${area.outline.length} point(s); a polygon needs at least 3`, [area.id]);
      }
    }
    const answering = new Map<string, string>();
    for (const area of this.a.holdingAreas) {
      for (const name of holdingAreaNames(area)) {
        const key = `${area.kind}\u0000${name}`;
        const other = answering.get(key);
        if (other === undefined) answering.set(key, area.id);
        else if (other !== area.id) {
          this.error('holding-area-name-repeated', `holding areas "${other}" and "${area.id}" (both kind "${area.kind}") both answer to "${name}"; a taxi to a named ${area.kind === 'penaltyBox' ? 'penalty box' : area.kind} must mean one`, [area.id, other]);
        }
      }
    }
    if (!this.a.holdingAreas.some((a) => a.kind === 'pad')) {
      this.warn('no-holding-pad', 'the airport has no holding pad (kind "pad"); the player has nowhere to park delayed departures', []);
    }
    if (!this.a.holdingAreas.some((a) => a.kind === 'penaltyBox')) {
      this.warn('no-penalty-box', 'the airport has no penalty box (kind "penaltyBox"); arrivals waiting for a gate have nowhere to wait', []);
    }
  }

  private checkHangars(): void {
    const handoffNodes = new Set(this.a.rampHandoffs.map((h) => h.node));
    // A hangar's own lead-ins: taxiway edges, or ramp lanes that don't pass a ramp handoff.
    const leadIn = (e: Edge, from: string, to: string) =>
      e.kind === 'taxiway' || (e.kind === 'rampLane' && !handoffNodes.has(from) && !handoffNodes.has(to));
    const byAirline = new Map<string, string>();
    for (const hangar of this.a.hangars) {
      const owner = `hangar "${hangar.id}" ("${hangar.name}")`;
      if (hangar.spots.length === 0) {
        this.error('hangar-no-spots', `${owner} has no spots; list the nodes where aircraft stop in "spots"`, [hangar.id]);
      }
      for (const spot of hangar.spots) {
        if (!this.nodeRef(spot, owner, hangar.id)) continue;
        if (edgesAt(this.index, spot).some((e) => e.kind === 'runway')) {
          this.error('hangar-spot-on-runway', `${owner}: spot "${spot}" is on a runway`, [hangar.id, spot]);
        } else if (!this.reachesNamedTaxiway(spot, leadIn)) {
          this.error('hangar-spot-unreachable', `${owner}: spot "${spot}" can't be reached from a named taxiway over open taxiway edges and its own lead-ins (ramp lanes that pass no ramp handoff)`, [hangar.id, spot]);
        }
      }
      for (const airline of hangar.airlines) {
        const other = byAirline.get(airline);
        if (other !== undefined) {
          this.error('hangar-airline-repeated', `airline "${airline}" has two company hangars, "${other}" and "${hangar.id}"; a taxi to "the company hangar" must mean one`, [hangar.id, other]);
        } else {
          byAirline.set(airline, hangar.id);
        }
      }
      if (hangar.outline && hangar.outline.length < 3) {
        this.error('outline-invalid', `${owner}'s outline has ${hangar.outline.length} point(s); a polygon needs at least 3`, [hangar.id]);
      }
    }
  }

  /**
   * Does `start` connect to a named, open taxiway over open edges that pass `edgeOk`? That's
   * whether ground can taxi an aircraft between it and the route network.
   */
  private reachesNamedTaxiway(start: string, edgeOk: (edge: Edge, from: string, to: string) => boolean): boolean {
    const seen = new Set([start]);
    const queue = [start];
    for (let node = queue.shift(); node !== undefined; node = queue.shift()) {
      const edges = edgesAt(this.index, node).filter((e) => !e.closed);
      if (edges.some((e) => e.kind === 'taxiway' && e.name !== undefined)) return true;
      for (const edge of edges) {
        const next = otherEnd(edge, node);
        if (!seen.has(next) && edgeOk(edge, node, next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return false;
  }

  /** Nodes reached from `start` over open, unnamed taxiway edges: a holding area's lead-in. */
  private leadInReach(start: string): Set<string> {
    const seen = new Set([start]);
    const queue = [start];
    for (let node = queue.shift(); node !== undefined; node = queue.shift()) {
      for (const edge of edgesAt(this.index, node)) {
        if (edge.kind !== 'taxiway' || edge.name !== undefined || edge.closed) continue;
        const next = otherEnd(edge, node);
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  }

  private checkDepartureLines(): void {
    const holdShorts = new Map(this.a.holdShorts.map((h) => [h.id, h]));
    for (const line of this.a.departureLines) {
      const owner = `departure line "${line.id}" (runway ${line.runwayEnd})`;
      const end = this.index.runwayEnds.get(line.runwayEnd);
      this.ref(end !== undefined, owner, 'runway end', line.runwayEnd, line.id);
      const front = holdShorts.get(line.holdShort);
      this.ref(front !== undefined, owner, 'hold-short', line.holdShort, line.id);
      const edges = line.edges.map((id) => this.edgeRef(id, owner, line.id));
      if (line.edges.length === 0) {
        this.error('departure-line-empty', `${owner} has no edges; list its edges from the back of the line to the front hold-short`, [line.id]);
      }
      if (line.exits.length === 0) {
        this.error('departure-line-no-exits', `${owner} has no exits; every departure line needs at least one way out. Add exits (taxiways that branch off the line), ordered from the back of the line to the front`, [line.id]);
      }
      if (front && end && (front.kind !== 'runway' || !front.runways.includes(end.runway.id))) {
        this.error('departure-line-hold-short-mismatch', `${owner}: its front hold-short "${front.id}" must be a "runway" hold protecting runway "${end.runway.id}" (it is kind "${front.kind}" protecting ${quoteList(front.runways)})`, [line.id, front.id]);
      }
      for (const edge of edges) {
        if (!edge) continue;
        if (edge.kind === 'runway') {
          this.error('departure-line-on-runway', `${owner} includes runway edge "${edge.id}"; the line ends at the hold line, before the runway`, [line.id, edge.id]);
        } else if (front && edge.id === front.towardEdge) {
          this.error('departure-line-on-runway', `${owner} includes edge "${edge.id}", which is past its hold-short "${front.id}" (toward the runway); the line ends at the hold line`, [line.id, edge.id]);
        }
        if (edge.closed) {
          this.error('departure-line-closed', `${owner} includes closed edge "${edge.id}" (${edge.closed.reason})`, [line.id, edge.id]);
        }
      }

      // Walk from the front (the hold-short node) back along the listed edges.
      let position: Map<string, number> | undefined;
      if (front && edges.length > 0 && edges.every((e) => e !== undefined) && this.index.nodes.has(front.node)) {
        const resolved = edges as Edge[];
        const backward = [front.node];
        let node = front.node;
        let broken = false;
        for (let i = resolved.length - 1; i >= 0 && !broken; i--) {
          const edge = resolved[i] as Edge;
          if (!touches(edge, node)) {
            const why = i === resolved.length - 1
              ? `its last edge "${edge.id}" doesn't end at the front hold-short's node "${front.node}"`
              : `edge "${edge.id}" doesn't connect to the next edge "${resolved[i + 1]?.id}" at node "${node}"`;
            this.error('departure-line-not-a-path', `${owner}: ${why}; list the edges as one path from the back of the line to the front`, [line.id, edge.id]);
            broken = true;
            break;
          }
          node = otherEnd(edge, node);
          if (backward.includes(node)) {
            this.error('departure-line-not-a-path', `${owner} visits node "${node}" twice; the line must be a simple path`, [line.id, node]);
            broken = true;
            break;
          }
          backward.push(node);
        }
        if (!broken) position = new Map(backward.reverse().map((n, i) => [n, i]));
      }

      const lineEdges = new Set(line.edges);
      let previous = -1;
      line.exits.forEach((x, i) => {
        const xOwner = `${owner} exit ${i} ("${x.taxiway}")`;
        this.nodeRef(x.node, xOwner, line.id);
        const edge = this.edgeRef(x.edge, xOwner, line.id);
        if (position) {
          const at = position.get(x.node);
          if (at === undefined) {
            this.error('departure-line-exit-not-on-line', `${xOwner}: node "${x.node}" is not on the line`, [line.id, x.node]);
          } else {
            if (at <= previous) {
              this.error('departure-line-exits-out-of-order', `${xOwner} at node "${x.node}" is not after the previous exit along the line; list exits from the back of the line to the front`, [line.id, x.node]);
            }
            previous = Math.max(previous, at);
          }
        }
        if (!edge) return;
        if (!touches(edge, x.node)) {
          this.error('departure-line-exit-edge-mismatch', `${xOwner}: edge "${edge.id}" doesn't touch node "${x.node}"`, [line.id, edge.id]);
        } else if (lineEdges.has(edge.id)) {
          this.error('departure-line-exit-edge-mismatch', `${xOwner}: edge "${edge.id}" is part of the line itself; an exit is an edge that leaves the line`, [line.id, edge.id]);
        }
        if (edge.kind === 'runway') {
          this.error('departure-line-exit-onto-runway', `${xOwner}: edge "${edge.id}" is a runway edge; planes leave the line by a taxiway, never along the runway`, [line.id, edge.id]);
        } else {
          const toward = this.a.holdShorts.find((h) => h.kind === 'runway' && h.node === x.node && h.towardEdge === edge.id);
          if (toward) {
            this.error('departure-line-exit-onto-runway', `${xOwner}: edge "${edge.id}" leads past runway hold-short "${toward.id}" toward runway ${quoteList(toward.runways)}; planes leave the line by a taxiway, never onto the runway`, [line.id, edge.id]);
          }
        }
        if (edge.name !== x.taxiway) {
          this.error('departure-line-exit-name-mismatch', `${xOwner}: its edge "${edge.id}" is named ${edge.name === undefined ? 'nothing' : `"${edge.name}"`}`, [line.id, edge.id]);
        }
        if (edge.closed) {
          this.error('departure-line-exit-closed', `${xOwner}: edge "${edge.id}" is closed (${edge.closed.reason})`, [line.id, edge.id]);
        }
      });
    }
  }

  private checkConfigurations(): void {
    if (this.a.configurations.length === 0) {
      this.warn('no-configurations', 'the airport has no runway configurations; a session needs one', []);
    }
    const def = this.a.defaultConfiguration;
    if (def !== undefined) {
      this.ref(this.a.configurations.some((c) => c.id === def), 'defaultConfiguration', 'configuration', def, this.a.id);
    } else if (this.a.configurations.length > 0) {
      this.warn('no-default-configuration', 'the airport has runway configurations but no defaultConfiguration; set one to the usual flow', []);
    }
    const exits = new Map(this.a.runwayExits.map((x) => [x.id, x]));
    for (const c of this.a.configurations) {
      const owner = `configuration "${c.id}"`;
      if (c.runways.length === 0) {
        this.error('configuration-empty', `${owner} uses no runways`, [c.id]);
        continue;
      }
      const byRunway = new Map<string, string>();
      for (const use of c.runways) {
        const uOwner = `${owner} runway ${use.end}`;
        const end = this.index.runwayEnds.get(use.end);
        this.ref(end !== undefined, owner, 'runway end', use.end, c.id);
        if (use.roles.length === 0 || new Set(use.roles).size !== use.roles.length) {
          this.error('configuration-roles-invalid', `${uOwner}: roles must be "arrivals", "departures" or both, each once (got ${quoteList(use.roles)})`, [c.id]);
        }
        if (end) {
          const other = byRunway.get(end.runway.id);
          if (other !== undefined) {
            this.error('configuration-runway-repeated', `${owner} uses runway "${end.runway.id}" twice (${other} and ${use.end}); list each runway once, with all its roles`, [c.id, end.runway.id]);
          }
          byRunway.set(end.runway.id, use.end);
        }
        const arrivals = use.roles.includes('arrivals');
        if (use.arrivalExits !== undefined) {
          if (!arrivals) {
            this.error('configuration-exits-without-arrivals', `${uOwner} lists arrivalExits but doesn't take arrivals`, [c.id]);
          }
          for (const id of use.arrivalExits) {
            const x = exits.get(id);
            if (!this.ref(x !== undefined, uOwner, 'runway exit', id, c.id)) continue;
            if (x && x.runwayEnd !== use.end) {
              this.error('configuration-exit-wrong-end', `${uOwner}: arrival exit "${id}" serves runway ${x.runwayEnd}, not ${use.end}`, [c.id, id]);
            }
          }
        }
        if (arrivals && end) {
          const available = use.arrivalExits ?? this.a.runwayExits.filter((x) => x.runwayEnd === use.end).map((x) => x.id);
          if (available.length === 0) {
            this.error('configuration-arrival-end-without-exits', `${uOwner} takes arrivals but has no exits; add runwayExits for ${use.end}`, [c.id]);
          }
        }
        if (use.roles.includes('departures') && end && !this.a.departureLines.some((l) => l.runwayEnd === use.end)) {
          this.warn('configuration-departure-end-without-line', `${uOwner} takes departures but no departure line is defined for ${use.end}`, [c.id]);
        }
      }
      const roles = new Set(c.runways.flatMap((u) => u.roles));
      if (!roles.has('arrivals') || !roles.has('departures')) {
        this.warn('configuration-incomplete', `${owner} has no runway for ${roles.has('arrivals') ? 'departures' : 'arrivals'}`, [c.id]);
      }
    }
  }

  private checkTowerAndAreas(): void {
    for (const t of this.a.towerPositions) {
      if (!FREQUENCY.test(t.frequency)) {
        this.error('tower-frequency-invalid', `tower position "${t.id}" frequency "${t.frequency}" isn't a frequency in MHz like "123.9" or "118.700"`, [t.id]);
      }
    }
    const terminalIds = new Set(this.a.terminals.map((t) => t.id));
    for (const area of this.a.areas) {
      if (area.terminal !== undefined) this.ref(terminalIds.has(area.terminal), `area "${area.id}"`, 'terminal', area.terminal, area.id);
      if (area.outline.length < 3) {
        this.error('outline-invalid', `area "${area.id}"'s outline has ${area.outline.length} point(s); a polygon needs at least 3`, [area.id]);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------

function reciprocal(a: string, b: string): boolean {
  const ma = DESIGNATOR.exec(a);
  const mb = DESIGNATOR.exec(b);
  if (!ma || !mb) return true; // reported as invalid designators instead
  const [na, nb] = [Number(ma[1]), Number(mb[1])];
  const sides: Record<string, string> = { L: 'R', R: 'L', C: 'C', '': '' };
  return Math.abs(na - nb) === 18 && sides[ma[2] ?? ''] === (mb[2] ?? '');
}

/** "taxiway \"Z\"", "taxiways \"Y\", \"Z\" and 2 unnamed edges", "ramp lane \"7\"", ... */
function describeEdges(edges: Edge[]): string {
  const parts: string[] = [];
  const named = (kind: Edge['kind'], one: string, many: string) => {
    const names = [...new Set(edges.filter((e) => e.kind === kind && e.name !== undefined).map((e) => e.name as string))];
    if (names.length > 0) parts.push(`${names.length === 1 ? one : many} ${quoteList(names)}`);
  };
  named('taxiway', 'taxiway', 'taxiways');
  named('rampLane', 'ramp lane', 'ramp lanes');
  const runways = [...new Set(edges.filter((e) => e.kind === 'runway').map((e) => e.runway ?? '?'))];
  if (runways.length > 0) parts.push(`runway ${quoteList(runways)}`);
  const unnamed = edges.filter((e) => e.kind !== 'runway' && e.name === undefined).length;
  if (unnamed > 0) parts.push(`${unnamed} unnamed edge${unnamed === 1 ? '' : 's'}`);
  return parts.join(', ');
}

function quoteList(items: string[]): string {
  return listSome(items.map((s) => `"${s}"`));
}

function listSome(items: string[], max = 8): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}
