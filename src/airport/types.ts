// Airport data format, version 1.
//
// One format for every airport (TEST, KJFK, KLGA, KPIT, ...). Nothing here knows about a
// particular airport. An airport file is `data/airports/<ID>.json`; hand-curated corrections
// live beside it in `<ID>.overrides.json` (see `AirportOverrides` and `load.ts`).
//
// Shape in one paragraph: the movement surface is an undirected graph of `nodes` and `edges`.
// Every edge is a runway, taxiway or ramp-lane segment and carries its name. Everything else
// points into that graph by id: runway ends and exits, hold-short points, the ramp/ground
// handoff points, gates, holding pads, departure lines. Runway configurations name runway
// ends and give each one roles. Rendering uses the same positions plus edge shape points,
// widths and a few display-only `areas`.
//
// Conventions:
// - Every collection item has a string `id`, unique within its collection. Ids are opaque and
//   stable; overrides and other items refer to them.
// - Names are strings, always: taxiway "A", "KE", "C1", ramp lane "7", gate "B22".
// - Positions are meters in a local planar frame: x = east, y = north, origin at
//   `reference` (see `geo.ts` for the projection). Headings are degrees true, clockwise from
//   north.
// - Optional fields are omitted, never `null`, in a loaded airport.
//
// Extending: the loader rejects unknown fields, so a new feature is an explicit, additive
// format change. Turn restrictions (deferred, Q 2026-11-14) would be a new collection such as
// `turnRestrictions: { id, fromEdge, viaNode, toEdge }[]`, which stable edge and node ids
// already make possible.

/** The only format version this code reads. */
export const FORMAT_VERSION = 1;

/** A position in the local frame: [x meters east, y meters north] of the reference point. */
export type Point = [x: number, y: number];

export type NodeId = string;
export type EdgeId = string;
export type RunwayId = string;
/** A runway end's designator, e.g. "31L". Unique across the airport. */
export type RunwayEndDesignator = string;
export type RunwayExitId = string;
export type HoldShortId = string;
export type RampHandoffId = string;
export type TerminalId = string;
export type GateId = string;
export type HoldingAreaId = string;
export type HangarId = string;
export type DepartureLineId = string;
export type ConfigurationId = string;
export type TowerPositionId = string;
export type AreaId = string;

/** A loaded, merged airport (base file plus overrides). */
export interface Airport {
  formatVersion: typeof FORMAT_VERSION;
  /** Identifier, also the file name: "KJFK" for `data/airports/KJFK.json`. */
  id: string;
  /** Display name, e.g. "John F. Kennedy International". */
  name: string;
  /** Origin of the local frame. */
  reference: ReferencePoint;
  /** Where the data came from and under what license (OSM-derived files must say ODbL). */
  source?: SourceInfo;
  /** The configuration a session starts in unless the player picks another (an id in `configurations`). */
  defaultConfiguration?: ConfigurationId;

  nodes: Node[];
  edges: Edge[];
  runways: Runway[];
  runwayExits: RunwayExit[];
  holdShorts: HoldShort[];
  rampHandoffs: RampHandoff[];
  terminals: Terminal[];
  gates: Gate[];
  holdingAreas: HoldingArea[];
  hangars: Hangar[];
  departureLines: DepartureLine[];
  configurations: RunwayConfiguration[];
  towerPositions: TowerPosition[];
  /** Display-only shapes (aprons, buildings). Nothing routes on them. */
  areas: Area[];
}

/** The airport reference point: the lat/lon (WGS84 degrees) of local (0, 0). */
export interface ReferencePoint {
  lat: number;
  lon: number;
}

export interface SourceInfo {
  /** Free text: data sources, snapshot dates, tools used. */
  description: string;
  /** e.g. "Data © OpenStreetMap contributors, ODbL 1.0". */
  license?: string;
}

// ---------------------------------------------------------------------------------------------
// Graph

/** A point of the movement graph: an intersection, a hold line, a gate stand, a pad spot. */
export interface Node {
  id: NodeId;
  /** Meters east of the reference point. */
  x: number;
  /** Meters north of the reference point. */
  y: number;
}

/**
 * Who controls an edge, which is also how it's drawn.
 * - `runway`: a runway centerline segment. Owned by the (simulated) tower.
 * - `taxiway`: movement area, controlled by the player (ground). Includes unnamed
 *   connectors, pad lanes and the movement-area stub between a ramp lane and a taxiway.
 * - `rampLane`: non-movement area, controlled by the simulated ramp: ramp lanes / taxilanes
 *   and the lead-in lines to gates.
 */
export type EdgeKind = 'runway' | 'taxiway' | 'rampLane';

/**
 * One undirected segment of the graph between two nodes. Routes and aircraft move along
 * edges. A taxiway is the set of `taxiway` edges that share a `name`; a ramp lane likewise
 * for `rampLane` edges.
 */
export interface Edge {
  id: EdgeId;
  kind: EdgeKind;
  from: NodeId;
  to: NodeId;
  /**
   * Taxiway or ramp-lane name as spoken and charted ("A", "KE", "7"). Omitted for unnamed
   * connectors and gate lead-ins. Never set on `runway` edges (they use `runway`).
   */
  name?: string;
  /** Required on `runway` edges, forbidden on others: the runway this segment belongs to. */
  runway?: RunwayId;
  /** Interior shape points, from `from` toward `to`, for curves. Length follows them. */
  points?: Point[];
  /** Pavement width for drawing; the renderer picks a default per kind when omitted. */
  widthM?: number;
  /**
   * Present = closed. A closed edge stays in the data (it's drawn, as closed) but nothing
   * may route over it, and the validator's reachability checks ignore it.
   */
  closed?: Closure;
}

export interface Closure {
  /** Why and on whose authority, e.g. "Chart Supplement 29 OCT 2026: Twy Z btn Rwy 04L and 22R and Twy Y clsd UFN". */
  reason: string;
}

// ---------------------------------------------------------------------------------------------
// Runways

/**
 * A runway. Its centerline is the chain of `runway` edges whose `runway` is this id; that
 * chain must run from `ends[0].node` to `ends[1].node`. Where two runways cross, their
 * chains share the intersection node.
 */
export interface Runway {
  /** Conventionally the two designators, low first: "13R/31L", "04/22". */
  id: RunwayId;
  ends: [RunwayEnd, RunwayEnd];
  widthM: number;
  /** The tower position that owns this runway, if the airport splits tower (JFK does). */
  towerPosition?: TowerPositionId;
}

/** One direction of a runway, named by its designator. */
export interface RunwayEnd {
  /** "31L", "04", "13R". Aircraft using this end move toward the other end. */
  designator: RunwayEndDesignator;
  /** The centerline node at the physical end of the pavement where this direction begins. */
  node: NodeId;
  /**
   * Distance in meters from `node` along the centerline to the landing threshold, when the
   * threshold is displaced. Omitted = 0 (threshold at the pavement end).
   */
  displacedThresholdM?: number;
}

/**
 * A way off the runway for aircraft that landed on `runwayEnd`. Exits are per direction,
 * because high-speed exits only work one way. Their order along the runway comes from the
 * geometry (distance from the landing threshold), not from the list.
 */
export interface RunwayExit {
  id: RunwayExitId;
  /** The landing direction this exit serves. */
  runwayEnd: RunwayEndDesignator;
  /**
   * The exit's spoken name ("clear at Kilo Echo"); must equal `edge`'s name. Omitted for an
   * unnamed exit (JFK has unnamed high-speed exits off 31R): tower can still send arrivals to
   * it, but the player can't name it.
   */
  taxiway?: string;
  /** The centerline node where the exit leaves the runway. */
  node: NodeId;
  /** The first edge off the runway: touches `node`, isn't a runway edge. */
  edge: EdgeId;
}

/**
 * - `runway`: a runway holding position. Aircraft stop here unless cleared to cross or
 *   enter every runway it lists.
 * - `ils`: an ILS critical-area hold. Used only when instructed.
 * - `lahso`: a land-and-hold-short point on one runway, protecting the runway(s) it lists.
 * - `intermediate`: a taxiway/taxiway intersection hold. Protects no runway.
 */
export type HoldShortKind = 'runway' | 'ils' | 'lahso' | 'intermediate';

/**
 * A hold line at a graph node. It's directional: it applies to an aircraft standing at
 * `node` about to move onto `towardEdge`, the edge on the protected side. Aircraft moving
 * the other way (vacating the runway) pass it freely.
 */
export interface HoldShort {
  id: HoldShortId;
  kind: HoldShortKind;
  /**
   * The runways it protects. One or more for `runway`, `ils` and `lahso`. More than one
   * where runways intersect (e.g. a hold near JFK's 4L/22R × 13R/31L crossing, or LGA's
   * intersection). Empty for `intermediate`.
   */
  runways: RunwayId[];
  node: NodeId;
  /** The edge from `node` toward the protected runway(s) or taxiway. */
  towardEdge: EdgeId;
}

// ---------------------------------------------------------------------------------------------
// Ramp, terminals, gates

/**
 * - `departures`: a ramp edge. Departures leave the ramp here and check in with the
 *   player ("Ground, Delta four, at Kilo Foxtrot, information Oscar").
 * - `arrivals`: a ramp entrance. The player taxis arrivals here and hands them to ramp.
 * - `both`: one point used in both directions.
 */
export type RampHandoffUse = 'departures' | 'arrivals' | 'both';

/**
 * A handoff point between the simulated ramp and the player: a node where a `rampLane` edge
 * meets a `taxiway` edge.
 */
export interface RampHandoff {
  id: RampHandoffId;
  /** Check-in name as spoken and as typed in commands: "KF", "HB", "TA", "7". */
  name: string;
  node: NodeId;
  use: RampHandoffUse;
  /**
   * Terminals whose gates this point serves. Omitted = any gate it reaches over ramp
   * lanes. The ramp sends a terminal's departures out, and the player brings its
   * arrivals in, only through points that serve it.
   */
  terminals?: TerminalId[];
}

export interface Terminal {
  /** "T4". */
  id: TerminalId;
  /** "Terminal 4". */
  name: string;
  /** ICAO airline designators that use this terminal: "DAL", "JBU". */
  airlines: string[];
}

/** A parking position. Aircraft push back from it and taxi in to it over ramp lanes. */
export interface Gate {
  /** Unique across the airport, e.g. "T4-B22". */
  id: GateId;
  /** As shown and spoken: "B22". Unique within its terminal. */
  name: string;
  terminal: TerminalId;
  /** Where the parked aircraft's nose stops: a node touched only by `rampLane` edges. */
  node: NodeId;
  /** Heading of the parked aircraft's nose. Omitted = facing along its lead-in edge into the stand. */
  headingDeg?: number;
  /** Airlines that use this gate, a subset of its terminal's. Omitted = any of the terminal's. */
  airlines?: string[];
}

// ---------------------------------------------------------------------------------------------
// Delays and ground-controlled parking: holding areas, hangars, departure lines

/**
 * - `pad`: a holding pad where the player parks departures that must wait.
 * - `penaltyBox`: where arrivals wait for a gate ("the penalty box").
 * - `hardstand`: ground-controlled parking off the ramp (JFK's South Hardstand). Aircraft park
 *   there for longer, but the player, not the ramp, taxis them in and out.
 *
 * A hardstand is a holding-area kind rather than its own collection because it has exactly a
 * holding area's shape (spots, spoken names, an outline), its spots are entered the same way
 * (unnamed taxiway lead-ins, see `entrances`), and the same checks apply (spots reachable over
 * taxiways, runway entries protected). Only the destination it answers to differs.
 */
export type HoldingAreaKind = 'pad' | 'penaltyBox' | 'hardstand';

export interface HoldingArea {
  id: HoldingAreaId;
  /** Display name, also spoken: "Kilo pad", "the penalty box", "South Hardstand". */
  name: string;
  kind: HoldingAreaKind;
  /**
   * Other ways the player names it ("penalty box", "Quebec box"). A taxi destination with a
   * name matches the area whose id, `name` or any spoken name equals it, ignoring case.
   */
  spokenNames?: string[];
  /**
   * The taxiways it's entered from (names). From each one, a spot must be reachable over the
   * area's own lead-in: open, unnamed taxiway edges. Required for a `hardstand`; optional for
   * the others.
   */
  entrances?: string[];
  /** Nodes where one aircraft each can park and wait, reachable over open taxiway edges. */
  spots: NodeId[];
  /** Outline for drawing. */
  outline?: Point[];
}

/**
 * A hangar that aircraft taxi to ("taxi to the company hangar"). Ground controls the taxi all
 * the way in: from the route's last taxiway, over unnamed taxiway edges or ramp-lane lead-ins
 * (never through a ramp handoff point), to one of its spots.
 */
export interface Hangar {
  id: HangarId;
  /** Display name: "Delta hangar". A named taxi destination matches its id, name or an airline. */
  name: string;
  /**
   * ICAO designators of the airlines whose company hangar it is ("DAL"). An airline has at most
   * one hangar. Empty: no company's; it's reached by name only.
   */
  airlines: string[];
  /** Where aircraft stop: nodes reachable over open taxiway edges plus the hangar's lead-ins. */
  spots: NodeId[];
  /** Outline for drawing (the building). */
  outline?: Point[];
}

/**
 * Where departures queue for one runway end, and how a delayed plane gets out of the queue.
 * A plane leaves the line at the next exit ahead of it, never along the runway (Q).
 */
export interface DepartureLine {
  id: DepartureLineId;
  runwayEnd: RunwayEndDesignator;
  /** The `runway` hold-short at the front of the line, where the player hands off to tower. */
  holdShort: HoldShortId;
  /**
   * The line's edges in queue order, from the back of the line to the front. They form one
   * path; the last edge ends at `holdShort`'s node. A line may span several taxiways.
   */
  edges: EdgeId[];
  /** The ways out, ordered from the back of the line to the front. At least one. */
  exits: DepartureLineExit[];
}

export interface DepartureLineExit {
  /** Spoken name ("exit the line at Kilo Delta"); must equal `edge`'s name. */
  taxiway: string;
  /** A node on the line where the exit branches off. */
  node: NodeId;
  /** The first edge off the line: not part of it, not a runway, not toward a runway. */
  edge: EdgeId;
}

// ---------------------------------------------------------------------------------------------
// Configurations and tower

export type RunwayRole = 'arrivals' | 'departures';

/**
 * A runway configuration: which runway ends are in use and for what. Fixed for a session.
 * JFK's "31s" (Q): land 31L and 31R, depart 31L, i.e.
 * `[{ end: "31L", roles: ["arrivals", "departures"] }, { end: "31R", roles: ["arrivals"] }]`.
 */
export interface RunwayConfiguration {
  id: ConfigurationId;
  /** "Land 31L and 31R, depart 31L". */
  name: string;
  /** At most one entry per runway: a runway is used in one direction at a time. */
  runways: RunwayUse[];
}

export interface RunwayUse {
  end: RunwayEndDesignator;
  /** One or both roles. A runway with both interleaves landings and takeoffs. */
  roles: RunwayRole[];
  /**
   * The exits the tower sends arrivals to (ids of `runwayExits` for this end). Only with the
   * `arrivals` role. Omitted = every exit of the end.
   */
  arrivalExits?: RunwayExitId[];
}

/** A tower position. Runways name the position that owns them. */
export interface TowerPosition {
  id: TowerPositionId;
  /** "Kennedy Tower (4L/22R, 13R/31L)". */
  name: string;
  /** MHz as written on the chart: "123.9", "118.700". */
  frequency: string;
}

// ---------------------------------------------------------------------------------------------
// Display-only geometry

/**
 * - `apron`: paved ramp area.
 * - `terminalBuilding`: a terminal's footprint (set `terminal`).
 * - `building`: any other building worth drawing (hangars, tower).
 */
export type AreaKind = 'apron' | 'terminalBuilding' | 'building';

export interface Area {
  id: AreaId;
  kind: AreaKind;
  /** Label to draw, if any. */
  name?: string;
  /** For a `terminalBuilding`: whose. */
  terminal?: TerminalId;
  /** Closed polygon, at least 3 points; the last point joins the first. */
  outline: Point[];
}

// ---------------------------------------------------------------------------------------------
// Collections, as listed by loaders, overrides and tools

/** The airport's id-keyed collections, in file order. */
export const COLLECTION_KEYS = [
  'nodes',
  'edges',
  'runways',
  'runwayExits',
  'holdShorts',
  'rampHandoffs',
  'terminals',
  'gates',
  'holdingAreas',
  'hangars',
  'departureLines',
  'configurations',
  'towerPositions',
  'areas',
] as const;

export type CollectionKey = (typeof COLLECTION_KEYS)[number];

/** Singular, human names for messages: `edges` → "edge". */
export const COLLECTION_ITEM_NAMES: Record<CollectionKey, string> = {
  nodes: 'node',
  edges: 'edge',
  runways: 'runway',
  runwayExits: 'runway exit',
  holdShorts: 'hold-short',
  rampHandoffs: 'ramp handoff',
  terminals: 'terminal',
  gates: 'gate',
  holdingAreas: 'holding area',
  hangars: 'hangar',
  departureLines: 'departure line',
  configurations: 'configuration',
  towerPositions: 'tower position',
  areas: 'area',
};

// ---------------------------------------------------------------------------------------------
// Overrides (`<ID>.overrides.json`)

/**
 * Hand-curated changes applied on top of a base airport file. See `load.ts` for the exact
 * semantics; in short, per collection:
 * - `add`: new items. Their ids must not exist in the base.
 * - `replace`: whole items, in place. Their ids must exist in the base.
 * - `patch`: a partial item with its `id`; the listed fields are set (shallow), and a field
 *   set to `null` is removed. The id must exist in the base.
 * - `remove`: ids to delete. They must exist in the base. Nothing cascades: whatever still
 *   refers to a removed item fails validation.
 * An id may appear in only one operation per collection. Anything that refers to an id that
 * doesn't exist fails loudly.
 */
export interface AirportOverrides {
  formatVersion: typeof FORMAT_VERSION;
  /** Must equal the base file's `id`. */
  airport: string;
  /** Free text: what this file curates and from what sources. */
  description?: string;
  /** Replaces top-level fields of the base. `source: null` removes the base's source. */
  set?: {
    name?: string;
    reference?: ReferencePoint;
    source?: SourceInfo | null;
    defaultConfiguration?: ConfigurationId | null;
  };
  nodes?: CollectionOverrides<Node>;
  edges?: CollectionOverrides<Edge>;
  runways?: CollectionOverrides<Runway>;
  runwayExits?: CollectionOverrides<RunwayExit>;
  holdShorts?: CollectionOverrides<HoldShort>;
  rampHandoffs?: CollectionOverrides<RampHandoff>;
  terminals?: CollectionOverrides<Terminal>;
  gates?: CollectionOverrides<Gate>;
  holdingAreas?: CollectionOverrides<HoldingArea>;
  hangars?: CollectionOverrides<Hangar>;
  departureLines?: CollectionOverrides<DepartureLine>;
  configurations?: CollectionOverrides<RunwayConfiguration>;
  towerPositions?: CollectionOverrides<TowerPosition>;
  areas?: CollectionOverrides<Area>;
}

export interface CollectionOverrides<T extends { id: string }> {
  add?: T[];
  replace?: T[];
  patch?: Patch<T>[];
  remove?: string[];
}

/** `id` selects the item; every other field is optional, and `null` removes it. */
export type Patch<T extends { id: string }> = { id: string } & {
  [K in Exclude<keyof T, 'id'>]?: T[K] | null;
};
