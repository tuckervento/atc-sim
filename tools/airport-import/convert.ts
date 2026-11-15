// The convert step: an Overpass `out geom` response (research doc Query A) → an airport base
// file in format v1 (docs/airport-format.md). Pure and deterministic: no I/O, no clock; the
// same input gives the same output, byte for byte, once serialized by `serializeAirport`.
//
// OSM → format mapping (the choices are explained in docs/airports/KJFK-notes.md):
// - Graph: every runway, taxiway and taxilane way, plus every parking_position way that
//   touches one of them (the gate lead-in lines). Ways are split into edges at every node
//   shared by two ways, at way ends, and at every hold position. Interior vertices become
//   edge `points`.
// - Hold lines mapped as short ways across a taxiway (not on it) get a node where they cross
//   the taxiway centerline, unless an OSM hold node already sits on that taxiway within
//   HOLD_LINE_DUPLICATE_M of the crossing.
// - Topology repairs, each reported: a taxiway drawn across a runway without a shared node
//   gets one at the crossing (reusing a vertex within CROSSING_SNAP_M); a taxiway that
//   dead-ends within RUNWAY_JOIN_M of a runway centerline has its end node joined to the runway.
// - Edge kind: runway ways → `runway`; taxiway ways → `taxiway`; taxilane ways → `taxiway` when
//   their name is also carried by a taxiway way (the same named taxiway continuing), else
//   `rampLane`; parking_position lead-ins → `rampLane`, unnamed. Names are `ref`, else `name`.
// - Runways: grouped by `ref`, designators without leading zeros, ends assigned by the
//   centerline's true bearing against the designator.
// - Hold-shorts: see holds.ts.
// - Terminals: aeroway=terminal polygons named "Termin… <x>" become terminal "T<x>" (this
//   also reads OSM's misspelt "Terminl 8" as Terminal 8, and the report says so). Other
//   aeroway=terminal polygons (e.g. "New Terminal 1") are plain buildings.
// - Gates: a parking_position lead-in with a `ref`, whose stand (the end off the network) is
//   within GATE_TERMINAL_M of a terminal building and nearer to it than to any other
//   aeroway=terminal polygon. Name = ref. Later stands with a name already used in that
//   terminal stay in the graph without a gate.
// - Areas: aprons, terminal buildings, other aeroway=terminal polygons and hangars.
// - Not in the base (left to the overrides file): terminal airlines, ramp handoffs, runway
//   exits, holding areas, departure lines, configurations, tower positions.

import { toLocal } from '../../src/airport/geo.ts';
import { edgeLength, indexAirport } from '../../src/airport/graph.ts';
import {
  COLLECTION_KEYS,
  FORMAT_VERSION,
  type Airport,
  type Area,
  type Edge,
  type EdgeKind,
  type Gate,
  type Node,
  type Point,
  type ReferencePoint,
  type Runway,
  type RunwayEnd,
  type Terminal,
} from '../../src/airport/types.ts';
import { deriveHolds, type HoldPoint } from './holds.ts';
import { outerRings, readOverpass, tag, type LatLon, type OsmNode, type OsmRelation, type OsmWay } from './osm.ts';

/** A hold-line way crossing within this distance (m) of an OSM hold node on the same way duplicates it. */
export const HOLD_LINE_DUPLICATE_M = 25;
/** A taxiway that dead-ends this close (m) to a runway centerline is joined to the runway. */
export const RUNWAY_JOIN_M = 3;
/** A taxiway/runway crossing this close (m) to an existing vertex joins at that vertex. */
export const CROSSING_SNAP_M = 1;
/** A stand farther than this (m) from every terminal building isn't a gate. */
export const GATE_TERMINAL_M = 150;

export const OSM_LICENSE = 'Data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)';

export interface ConvertReport {
  lines: string[];
  warnings: string[];
}

/** OSM context the format can't hold, for the map sheet and the question sheet. */
export interface OsmContext {
  /** Non-movement-area boundary holds (holding_position:type=movement) on the graph. */
  movementBoundary: { node: string; osmId: number; names: string[] }[];
  /** Stands that are not gates: their node, OSM ref and why. */
  otherStands: { node: string; ref: string | null; osm: string; why: string }[];
  /** OSM hold refs, by hold-short id (OSM's own labels, e.g. "1A", "31R-APCH"). */
  holdRefs: Record<string, string>;
}

export interface ConvertResult {
  airport: Airport;
  report: ConvertReport;
  context: OsmContext;
}

type WayClass = 'runway' | 'taxiway' | 'taxilane' | 'parking';

interface GraphWay {
  way: OsmWay;
  cls: WayClass;
  /** Node ids (format ids: "n<osm>" or "hl<way>" for hold-line crossings), in way order. */
  nodes: string[];
}

export function convertOverpass(id: string, rawValue: unknown): ConvertResult {
  const raw = readOverpass(rawValue);
  const warnings: string[] = [];
  const lines: string[] = [];

  const aerodromes = raw.elements.filter((e) => tag(e, 'aeroway') === 'aerodrome' && tag(e, 'icao') === id);
  const aerodrome = aerodromes[0];
  if (aerodromes.length !== 1 || !aerodrome || aerodrome.type === 'node' || !aerodrome.bounds) {
    throw new Error(`expected exactly one aerodrome way/relation tagged icao=${id} with bounds, found ${aerodromes.length}`);
  }
  const b = aerodrome.bounds;
  const reference: ReferencePoint = { lat: round((b.minlat + b.maxlat) / 2, 7), lon: round((b.minlon + b.maxlon) / 2, 7) };
  const project = (p: LatLon): Point => {
    const [x, y] = toLocal(reference, p.lat, p.lon);
    return [round(x, 1), round(y, 1)];
  };

  const ways = raw.elements.filter((e): e is OsmWay => e.type === 'way').sort((a, c) => a.id - c.id);
  const osmNodes = raw.elements.filter((e): e is OsmNode => e.type === 'node').sort((a, c) => a.id - c.id);
  const relations = raw.elements.filter((e): e is OsmRelation => e.type === 'relation').sort((a, c) => a.id - c.id);
  const aeroway = (e: { tags?: Record<string, string> }) => tag(e, 'aeroway');

  // ---- positions
  const pos = new Map<string, Point>();
  for (const w of ways) w.nodes.forEach((n, i) => pos.set(`n${n}`, project(w.geometry[i] as LatLon)));
  for (const n of osmNodes) pos.set(`n${n.id}`, project(n));

  // ---- the ways that make up the graph
  const network: GraphWay[] = [];
  for (const w of ways) {
    const a = aeroway(w);
    const cls: WayClass | null = a === 'runway' ? 'runway' : a === 'taxiway' ? 'taxiway' : a === 'taxilane' ? 'taxilane' : null;
    if (cls) network.push({ way: w, cls, nodes: w.nodes.map((n) => `n${n}`) });
  }
  const onNetwork = new Set(network.flatMap((g) => g.nodes));
  const parkingWays = ways.filter((w) => aeroway(w) === 'parking_position' && w.nodes.length >= 2);
  const unconnectedParking: OsmWay[] = [];
  for (const w of parkingWays) {
    if (w.nodes.some((n) => onNetwork.has(`n${n}`))) network.push({ way: w, cls: 'parking', nodes: w.nodes.map((n) => `n${n}`) });
    else unconnectedParking.push(w);
  }
  if (unconnectedParking.length > 0) {
    warnings.push(`${unconnectedParking.length} parking_position ways share no node with a runway, taxiway or taxilane and are left out: ${listSome(unconnectedParking.map((w) => `${w.id}${tag(w, 'ref') ? ` (${tag(w, 'ref')})` : ''}`), 12)}`);
  }

  // ---- hold positions
  const holdType = (e: { tags?: Record<string, string> }) => tag(e, 'holding_position:type') ?? 'untagged';
  const holdPoints: HoldPoint[] = [];
  const holdRefs: Record<string, string> = {};
  const holdNodeSet = new Set<string>();
  const graphNodeIds = new Set(network.flatMap((g) => g.nodes));
  for (const n of osmNodes.filter((n) => aeroway(n) === 'holding_position')) {
    const nodeId = `n${n.id}`;
    if (!graphNodeIds.has(nodeId)) {
      warnings.push(`hold node ${n.id} (${holdType(n)}) is on no runway, taxiway or taxilane way; left out`);
      continue;
    }
    holdNodeSet.add(nodeId);
    holdPoints.push({ id: `h${n.id}`, node: nodeId, osmType: holdType(n), source: `OSM hold node ${n.id}` });
    const ref = tag(n, 'ref') ?? tag(n, 'name');
    if (ref) holdRefs[`h${n.id}`] = ref;
  }
  // Hold lines drawn across a taxiway: put a node where each crosses a taxiway/taxilane centerline.
  const crossable = network.filter((g) => g.cls === 'taxiway' || g.cls === 'taxilane');
  const inserts = new Map<GraphWay, { seg: number; t: number; nodeId: string }[]>();
  for (const h of ways.filter((w) => aeroway(w) === 'holding_position')) {
    const hits: { g: GraphWay; seg: number; t: number; at: Point }[] = [];
    for (let i = 1; i < h.geometry.length; i++) {
      const p1 = project(h.geometry[i - 1] as LatLon);
      const p2 = project(h.geometry[i] as LatLon);
      for (const g of crossable) {
        for (let s = 1; s < g.nodes.length; s++) {
          const q1 = pos.get(g.nodes[s - 1] as string) as Point;
          const q2 = pos.get(g.nodes[s] as string) as Point;
          const hit = segmentIntersection(p1, p2, q1, q2);
          if (hit) hits.push({ g, seg: s - 1, t: hit.u, at: hit.point });
        }
      }
    }
    if (hits.length === 0) {
      warnings.push(`hold line way ${h.id} (${holdType(h)}) crosses no taxiway or taxilane; left out`);
      continue;
    }
    hits.sort((p, q) => p.g.way.id - q.g.way.id || p.seg - q.seg || p.t - q.t);
    hits.forEach((hit, k) => {
      const duplicate = hit.g.nodes.find((n) => holdNodeSet.has(n) && dist(pos.get(n) as Point, hit.at) <= HOLD_LINE_DUPLICATE_M);
      if (duplicate) {
        warnings.push(`hold line way ${h.id} duplicates OSM hold node ${duplicate.slice(1)} (${Math.round(dist(pos.get(duplicate) as Point, hit.at))} m apart on way ${hit.g.way.id}); the node is used`);
        return;
      }
      const nodeId = `hl${h.id}${k === 0 ? '' : `.${k + 1}`}`;
      pos.set(nodeId, [round(hit.at[0], 1), round(hit.at[1], 1)]);
      const list = inserts.get(hit.g) ?? [];
      list.push({ seg: hit.seg, t: hit.t, nodeId });
      inserts.set(hit.g, list);
      holdNodeSet.add(nodeId);
      holdPoints.push({ id: nodeId, node: nodeId, osmType: holdType(h), source: `OSM hold line way ${h.id}` });
      const ref = tag(h, 'ref') ?? tag(h, 'name');
      if (ref) holdRefs[nodeId] = ref;
    });
  }
  // A taxiway drawn across a runway without a shared node would let traffic pass through the
  // runway unseen: give the two a shared node where they cross.
  for (const t of crossable) {
    for (const r of network.filter((g) => g.cls === 'runway')) {
      for (let s = 1; s < t.nodes.length; s++) {
        for (let q = 1; q < r.nodes.length; q++) {
          const [t1, t2, r1, r2] = [t.nodes[s - 1], t.nodes[s], r.nodes[q - 1], r.nodes[q]] as string[];
          if (t1 === r1 || t1 === r2 || t2 === r1 || t2 === r2) continue;
          const hit = segmentIntersection(pos.get(r1 as string) as Point, pos.get(r2 as string) as Point, pos.get(t1 as string) as Point, pos.get(t2 as string) as Point);
          if (!hit) continue;
          const back = segmentIntersection(pos.get(t1 as string) as Point, pos.get(t2 as string) as Point, pos.get(r1 as string) as Point, pos.get(r2 as string) as Point);
          if (!back) continue;
          const add = (g: GraphWay, seg: number, u: number, nodeId: string) => {
            const list = inserts.get(g) ?? [];
            if (list.some((x) => x.nodeId === nodeId)) return false;
            list.push({ seg, t: u, nodeId });
            inserts.set(g, list);
            return true;
          };
          const what = `${t.cls} way ${t.way.id} (${wayName(t.way) ?? 'unnamed'}) crosses runway ${tag(r.way, 'ref')} (way ${r.way.id}) without a shared node`;
          // Usually the taxiway has a vertex right on the centerline that just isn't joined.
          const snapT = [t1, t2].find((n) => dist(pos.get(n as string) as Point, hit.point) <= CROSSING_SNAP_M);
          const snapR = [r1, r2].find((n) => dist(pos.get(n as string) as Point, hit.point) <= CROSSING_SNAP_M);
          if (snapT && snapR) throw new Error(`${what}, at taxiway node ${snapT} and runway node ${snapR}, both within ${CROSSING_SNAP_M} m; not handled`);
          if (snapT) {
            if (add(r, q - 1, back.u, snapT)) warnings.push(`${what}; its node ${snapT} lies ${dist(pos.get(snapT) as Point, hit.point).toFixed(2)} m from the centerline, so it is joined to the runway`);
          } else if (snapR) {
            if (add(t, s - 1, hit.u, snapR)) warnings.push(`${what}; runway node ${snapR} lies ${dist(pos.get(snapR) as Point, hit.point).toFixed(2)} m from the taxiway, so it is joined to the taxiway`);
          } else {
            const nodeId = `x${t.way.id}.${r.way.id}`;
            if (pos.has(nodeId)) throw new Error(`way ${t.way.id} crosses runway way ${r.way.id} more than once; not handled`);
            pos.set(nodeId, [round(hit.point[0], 1), round(hit.point[1], 1)]);
            add(t, s - 1, hit.u, nodeId);
            add(r, q - 1, back.u, nodeId);
            warnings.push(`${what}; added node ${nodeId} at the crossing`);
          }
        }
      }
    }
  }
  // A taxiway that stops just short of a runway centerline (a dead end within
  // RUNWAY_JOIN_M) was meant to join it: put its end node into the runway there.
  const wayUses = new Map<string, number>();
  for (const g of network) for (const n of g.nodes) wayUses.set(n, (wayUses.get(n) ?? 0) + 1);
  for (const t of crossable) {
    for (const end of [t.nodes[0], t.nodes.at(-1)] as string[]) {
      if ((wayUses.get(end) ?? 0) !== 1) continue;
      const p = pos.get(end) as Point;
      let best: { r: GraphWay; seg: number; t: number; d: number } | null = null;
      for (const r of network.filter((g) => g.cls === 'runway')) {
        for (let q = 1; q < r.nodes.length; q++) {
          const a = pos.get(r.nodes[q - 1] as string) as Point;
          const c = pos.get(r.nodes[q] as string) as Point;
          const proj = projectOnSegment(p, a, c);
          if (proj.d <= RUNWAY_JOIN_M && (!best || proj.d < best.d)) best = { r, seg: q - 1, t: proj.t, d: proj.d };
        }
      }
      if (!best) continue;
      if (inserts.get(best.r)?.some((x) => x.nodeId === end)) continue; // already joined where it crosses
      if (best.t <= 0 || best.t >= 1) throw new Error(`way ${t.way.id}'s end ${end} is ${best.d.toFixed(2)} m from runway way ${best.r.way.id}'s vertex; not handled`);
      const list = inserts.get(best.r) ?? [];
      list.push({ seg: best.seg, t: best.t, nodeId: end });
      inserts.set(best.r, list);
      warnings.push(`${t.cls} way ${t.way.id} (${wayName(t.way) ?? 'unnamed'}) ends ${best.d.toFixed(1)} m from runway ${tag(best.r.way, 'ref')}'s centerline without joining it; its end node ${end} is joined to the runway`);
    }
  }
  for (const [g, list] of inserts) {
    list.sort((p, q) => q.seg - p.seg || q.t - p.t); // insert from the back so indexes stay valid
    for (const { seg, nodeId } of list) g.nodes.splice(seg + 1, 0, nodeId);
  }

  // ---- split ways into edges
  const uses = new Map<string, number>();
  for (const g of network) for (const n of g.nodes) uses.set(n, (uses.get(n) ?? 0) + 1);
  const isSplit = (n: string, g: GraphWay, i: number) =>
    i === 0 || i === g.nodes.length - 1 || (uses.get(n) ?? 0) > 1 || holdNodeSet.has(n);

  const taxiwayNames = new Set(network.filter((g) => g.cls === 'taxiway').map((g) => wayName(g.way)).filter((n): n is string => n !== undefined));
  const runwayIdOf = (w: OsmWay) => {
    const ref = tag(w, 'ref');
    if (!ref) throw new Error(`runway way ${w.id} has no ref`);
    return normalizeRunwayRef(ref);
  };

  const edges: Edge[] = [];
  const edgeIds = new Set<string>();
  const usedNodes = new Set<string>();
  const runwayEdges = new Map<string, Edge[]>();
  const runwayWays = new Map<string, OsmWay[]>();
  for (const g of network) {
    let kind: EdgeKind;
    let name: string | undefined;
    if (g.cls === 'runway') kind = 'runway';
    else if (g.cls === 'taxiway') {
      kind = 'taxiway';
      name = wayName(g.way);
    } else if (g.cls === 'taxilane') {
      name = wayName(g.way);
      kind = name !== undefined && taxiwayNames.has(name) ? 'taxiway' : 'rampLane';
    } else kind = 'rampLane';

    // Split points, then make sure no piece starts and ends at the same node.
    const cuts = g.nodes.map((n, i) => (isSplit(n, g, i) ? i : -1)).filter((i) => i >= 0);
    const pieces: [number, number][] = [];
    for (let k = 1; k < cuts.length; k++) {
      const [a, c] = [cuts[k - 1] as number, cuts[k] as number];
      if (g.nodes[a] === g.nodes[c] && c - a >= 2) {
        const mid = Math.floor((a + c) / 2);
        pieces.push([a, mid], [mid, c]);
      } else pieces.push([a, c]);
    }
    for (const [a, c] of pieces) {
      const from = g.nodes[a] as string;
      const to = g.nodes[c] as string;
      if (from === to) {
        warnings.push(`way ${g.way.id} has a zero-length loop at ${from}; skipped`);
        continue;
      }
      let edgeId = `w${g.way.id}-${from}-${to}`;
      for (let k = 2; edgeIds.has(edgeId); k++) edgeId = `w${g.way.id}-${from}-${to}-${k}`;
      edgeIds.add(edgeId);
      const edge: Edge = { id: edgeId, kind, from, to };
      if (name !== undefined && kind !== 'runway') edge.name = name;
      if (kind === 'runway') {
        const runway = runwayIdOf(g.way);
        edge.runway = runway;
        runwayEdges.set(runway, [...(runwayEdges.get(runway) ?? []), edge]);
      }
      const inner = g.nodes.slice(a + 1, c).map((n) => pos.get(n) as Point);
      if (inner.length > 0) edge.points = inner;
      edges.push(edge);
      usedNodes.add(from).add(to);
    }
    if (g.cls === 'runway') {
      const runway = runwayIdOf(g.way);
      runwayWays.set(runway, [...(runwayWays.get(runway) ?? []), g.way]);
    }
  }
  const nodes: Node[] = [...usedNodes].sort(compareIds).map((n) => {
    const [x, y] = pos.get(n) as Point;
    return { id: n, x, y };
  });

  // ---- runways
  const runways: Runway[] = [];
  for (const [runwayId, rEdges] of [...runwayEdges].sort((p, q) => compareIds(p[0], q[0]))) {
    const ends = chainEnds(rEdges);
    if (!ends) throw new Error(`runway ${runwayId}'s ways don't form one centerline`);
    const [d0, d1] = runwayId.split('/') as [string, string];
    const p0 = pos.get(ends[0]) as Point;
    const p1 = pos.get(ends[1]) as Point;
    const bearing01 = bearingDeg(p0, p1);
    // ends[0] → ends[1] is the takeoff/landing direction of the end at ends[0].
    const fit = (designator: string, b: number) => angleDiff(Number.parseInt(designator, 10) * 10, b);
    const straight = fit(d0, bearing01) + fit(d1, (bearing01 + 180) % 360);
    const swapped = fit(d1, bearing01) + fit(d0, (bearing01 + 180) % 360);
    if (Math.min(straight, swapped) > 90) throw new Error(`runway ${runwayId}: can't match designators to ends (bearing ${bearing01.toFixed(0)}°)`);
    const [n0, n1] = straight <= swapped ? [ends[0], ends[1]] : [ends[1], ends[0]];
    const end0: RunwayEnd = { designator: d0, node: n0 };
    const end1: RunwayEnd = { designator: d1, node: n1 };
    const rWays = runwayWays.get(runwayId) ?? [];
    const widths = [...new Set(rWays.map((w) => tag(w, 'width')))];
    const width = widths.length === 1 && widths[0] !== undefined ? Number.parseFloat(widths[0]) : Number.NaN;
    if (!Number.isFinite(width) || width <= 0) throw new Error(`runway ${runwayId}: expected one numeric width tag across its ways, got ${JSON.stringify(widths)}`);
    const displaced = rWays.filter((w) => tag(w, 'runway') === 'displaced_threshold');
    if (displaced.length > 0) {
      warnings.push(`runway ${runwayId}: OSM tags ${displaced.length} of its ${rWays.length} ways runway=displaced_threshold (${displaced.map((w) => w.id).join(', ')}); ${displaced.length === 1 && rWays.length > 1 ? 'see notes' : 'ambiguous'}, so no displacedThresholdM is set by the importer`);
    }
    runways.push({ id: runwayId, ends: [end0, end1], widthM: width });
  }

  // ---- terminals and areas
  const areas: Area[] = [];
  const terminals = new Map<string, Terminal>();
  const terminalShapes: { terminal: string | null; label: string; rings: Point[][] }[] = [];
  const polygonFeatures: (OsmWay | OsmRelation)[] = [...ways, ...relations];
  for (const f of polygonFeatures) {
    const a = aeroway(f);
    if (a !== 'apron' && a !== 'terminal' && a !== 'hangar') continue;
    let rings: Point[][];
    try {
      rings = outerRings(f).map((r) => r.map(project));
    } catch (e) {
      warnings.push(`${a} ${f.type} ${f.id}: ${e instanceof Error ? e.message : String(e)}; left out`);
      continue;
    }
    const name = tag(f, 'name') ?? tag(f, 'name:en');
    const areaId = (k: number) => `${f.type === 'way' ? 'w' : 'r'}${f.id}${rings.length > 1 ? `-${k + 1}` : ''}`;
    if (a === 'terminal') {
      const t = name ? /^termin[a-z]*\s+(\S+)$/i.exec(name) : null;
      const terminalId = t ? `T${(t[1] as string).toUpperCase()}` : null;
      if (terminalId) {
        if (name && !/^terminal\s/i.test(name)) warnings.push(`terminal ${f.type} ${f.id} is named "${name}"; read as Terminal ${terminalId.slice(1)}`);
        if (!terminals.has(terminalId)) terminals.set(terminalId, { id: terminalId, name: `Terminal ${terminalId.slice(1)}`, airlines: [] });
      }
      terminalShapes.push({ terminal: terminalId, label: `${name ?? '(unnamed)'} (${f.type} ${f.id})`, rings });
      rings.forEach((outline, k) => {
        const area: Area = terminalId ? { id: areaId(k), kind: 'terminalBuilding', terminal: terminalId, outline } : { id: areaId(k), kind: 'building', outline };
        if (name) area.name = name;
        areas.push(area);
      });
    } else {
      rings.forEach((outline, k) => {
        const area: Area = { id: areaId(k), kind: a === 'apron' ? 'apron' : 'building', outline };
        const label = a === 'hangar' ? (name ?? tag(f, 'ref')) : name;
        if (label) area.name = label;
        areas.push(area);
      });
    }
  }

  // ---- gates
  const gates: Gate[] = [];
  const otherStands: OsmContext['otherStands'] = [];
  const gateNames = new Map<string, string>();
  for (const g of network.filter((x) => x.cls === 'parking')) {
    const ref = tag(g.way, 'ref') ?? null;
    const first = g.nodes[0] as string;
    const last = g.nodes.at(-1) as string;
    const firstOn = onNetwork.has(first);
    const lastOn = onNetwork.has(last);
    const osm = `parking way ${g.way.id}`;
    if (firstOn === lastOn) {
      otherStands.push({ node: lastOn ? last : first, ref, osm, why: firstOn ? 'both ends on the network' : 'neither end on the network' });
      continue;
    }
    const stand = firstOn ? last : first;
    if (ref === null) {
      otherStands.push({ node: stand, ref, osm, why: 'no ref' });
      continue;
    }
    const at = pos.get(stand) as Point;
    const near = terminalShapes
      .map((s) => ({ s, d: Math.min(...s.rings.map((r) => distanceToPolygon(at, r))) }))
      .sort((p, q) => p.d - q.d)[0];
    if (!near || near.d > GATE_TERMINAL_M) {
      otherStands.push({ node: stand, ref, osm, why: `no terminal building within ${GATE_TERMINAL_M} m` });
      continue;
    }
    if (near.s.terminal === null) {
      otherStands.push({ node: stand, ref, osm, why: `nearest terminal building is ${near.s.label}, not an operating terminal` });
      continue;
    }
    const key = `${near.s.terminal}\u0000${ref}`;
    const twin = gateNames.get(key);
    if (twin !== undefined) {
      otherStands.push({ node: stand, ref, osm, why: `gate name "${ref}" already used in ${near.s.terminal} by ${twin}` });
      continue;
    }
    const gateId = `g${g.way.id}`;
    gateNames.set(key, gateId);
    gates.push({ id: gateId, name: ref, terminal: near.s.terminal, node: stand });
  }

  // ---- hold-shorts
  const draft: Airport = {
    formatVersion: FORMAT_VERSION,
    id,
    name: tag(aerodrome, 'name') ?? id,
    reference,
    nodes,
    edges,
    runways,
    runwayExits: [],
    holdShorts: [],
    rampHandoffs: [],
    terminals: [...terminals.values()].sort((p, q) => compareIds(p.id, q.id)),
    gates,
    holdingAreas: [],
    departureLines: [],
    configurations: [],
    towerPositions: [],
    areas,
  };
  const index = indexAirport(draft);
  const holds = deriveHolds(index, holdPoints);
  draft.holdShorts = holds.holdShorts;
  warnings.push(...holds.notes);

  const movementBoundary = holdPoints
    .filter((p) => p.osmType === 'movement')
    .map((p) => ({
      node: p.node,
      osmId: Number(p.node.slice(1)),
      names: [...new Set(index.edgesAtNode.get(p.node)?.map((e) => e.name ?? '(unnamed)') ?? [])].sort(),
    }));

  const osmBase = raw.osm3s.timestamp_osm_base;
  const fetched = raw.atcSimFetch?.fetchedAt ?? 'unknown';
  draft.source = {
    description:
      `Generated by tools/import-airport.ts from OpenStreetMap via Overpass (research doc Query A: every aeroway=* feature inside the ${id} aerodrome). ` +
      `OSM snapshot ${osmBase}, fetched ${fetched}. Raw response: data/airports/raw/${id}.overpass.json. ` +
      `Reference point = centre of the OSM aerodrome boundary's bounding box. Hand-curated changes live in ${id}.overrides.json.`,
    license: OSM_LICENSE,
  };

  // ---- report
  const kinds = countBy(edges.map((e) => e.kind));
  lines.push(`OSM snapshot ${osmBase}; ${raw.elements.length} elements`);
  lines.push(`reference ${reference.lat}, ${reference.lon}`);
  lines.push(`nodes ${nodes.length}; edges ${edges.length} (${kinds})`);
  lines.push(`runways ${runways.map((r) => `${r.id} [${r.ends[0].designator}@${r.ends[0].node}, ${r.ends[1].designator}@${r.ends[1].node}]`).join('; ')}`);
  lines.push(`hold-shorts ${holds.holdShorts.length} (${countBy(holds.holdShorts.map((h) => h.kind))}); movement-boundary points ${movementBoundary.length}`);
  lines.push(`terminals ${[...terminals.keys()].sort().join(', ')}; gates ${gates.length} (${countBy(gates.map((g) => g.terminal))}); other stands ${otherStands.length}`);
  lines.push(`areas ${areas.length} (${countBy(areas.map((a) => a.kind))})`);
  const lengths = edges.reduce((m, e) => m + edgeLength(index, e), 0);
  lines.push(`total edge length ${(lengths / 1000).toFixed(1)} km`);

  return { airport: draft, report: { lines, warnings }, context: { movementBoundary, otherStands, holdRefs } };
}

/**
 * The base file's text: top-level fields in format order, one collection item per line, so
 * diffs between imports stay readable. Deterministic given the same airport.
 */
export function serializeAirport(a: Airport): string {
  const head: [string, unknown][] = [
    ['formatVersion', a.formatVersion],
    ['id', a.id],
    ['name', a.name],
    ['reference', a.reference],
    ['source', a.source],
    ['defaultConfiguration', a.defaultConfiguration],
  ];
  const parts = head.filter(([, v]) => v !== undefined).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  for (const key of COLLECTION_KEYS) {
    const items = a[key] as unknown[];
    parts.push(items.length === 0 ? `  ${JSON.stringify(key)}: []` : `  ${JSON.stringify(key)}: [\n${items.map((i) => `    ${JSON.stringify(i)}`).join(',\n')}\n  ]`);
  }
  return `{\n${parts.join(',\n')}\n}\n`;
}

// ---------------------------------------------------------------------------------------------

function wayName(w: OsmWay): string | undefined {
  return tag(w, 'ref') ?? tag(w, 'name');
}

/** "04L/22R" → "4L/22R": FAA style, no leading zeros (format and terse parser agree). */
export function normalizeRunwayRef(ref: string): string {
  const parts = ref.split('/').map((p) => p.trim().toUpperCase().replace(/^0+(?=\d)/, ''));
  if (parts.length !== 2 || parts.some((p) => !/^([1-9]|[12]\d|3[0-6])[LCR]?$/.test(p))) throw new Error(`can't read runway ref "${ref}"`);
  return parts.join('/');
}

/** The two end nodes of a set of edges forming one simple path, or null. */
function chainEnds(edges: Edge[]): [string, string] | null {
  const degree = new Map<string, number>();
  for (const e of edges) for (const n of [e.from, e.to]) degree.set(n, (degree.get(n) ?? 0) + 1);
  const ends = [...degree].filter(([, d]) => d === 1).map(([n]) => n);
  if (ends.length !== 2 || [...degree.values()].some((d) => d > 2)) return null;
  return [ends[0] as string, ends[1] as string];
}

function bearingDeg(a: Point, b: Point): number {
  return ((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI + 360) % 360;
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function segmentIntersection(p1: Point, p2: Point, q1: Point, q2: Point): { point: Point; u: number } | null {
  const r: Point = [p2[0] - p1[0], p2[1] - p1[1]];
  const s: Point = [q2[0] - q1[0], q2[1] - q1[1]];
  const denom = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(denom) < 1e-9) return null;
  const qp: Point = [q1[0] - p1[0], q1[1] - p1[1]];
  const t = (qp[0] * s[1] - qp[1] * s[0]) / denom;
  const u = (qp[0] * r[1] - qp[1] * r[0]) / denom;
  if (t < 0 || t > 1 || u <= 0 || u >= 1) return null;
  return { point: [p1[0] + t * r[0], p1[1] + t * r[1]], u };
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Where `p` projects onto segment a–b: parameter t (unclamped) and the distance to the clamped point. */
function projectOnSegment(p: Point, a: Point, b: Point): { t: number; d: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  const c = Math.max(0, Math.min(1, t));
  return { t, d: Math.hypot(p[0] - (a[0] + c * dx), p[1] - (a[1] + c * dy)) };
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** 0 inside the polygon, else the distance to its boundary. */
function distanceToPolygon(p: Point, ring: Point[]): number {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as Point;
    const c = ring[j] as Point;
    if (a[1] > p[1] !== c[1] > p[1] && p[0] < ((c[0] - a[0]) * (p[1] - a[1])) / (c[1] - a[1]) + a[0]) inside = !inside;
    best = Math.min(best, distanceToSegment(p, a, c));
  }
  return inside ? 0 : best;
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

/** Ids compare by their text, with digit runs compared as numbers ("n9" < "n10"). */
export function compareIds(a: string, b: string): number {
  const pa = a.match(/\d+|\D+/g) ?? [];
  const pb = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const [x, y] = [pa[i] as string, pb[i] as string];
    if (x === y) continue;
    const nx = /^\d/.test(x);
    const ny = /^\d/.test(y);
    if (nx && ny) return Number(x) - Number(y) || (x < y ? -1 : 1);
    return x < y ? -1 : 1;
  }
  return pa.length - pb.length || (a < b ? -1 : a > b ? 1 : 0);
}

function countBy(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((p, q) => compareIds(p[0], q[0])).map(([k, n]) => `${k} ${n}`).join(', ');
}

function listSome(items: string[], max: number): string {
  return items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}
