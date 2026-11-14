// The command format: everything the player can say to an aircraft (PRD §7, C1–C10 and C12)
// or do to it with a key (the runway-crossing request, PRD §4.5), as plain JSON-ready data.
//
// This is the contract between input and simulation. The terse parser (`terse.ts`) produces
// it from typed text, and the Phase 2 AI interpreter must produce exactly the same objects
// from speech. The full reference, with examples and the meaning of each command, is
// `docs/terse-syntax.md`.
//
// Conventions:
// - Every union is discriminated by `type` (commands and instructions) or `kind` (destinations
//   and hold-short targets). No classes, no enums.
// - Every field is always present. "Not given" is `null`, and an empty list is `[]`; fields
//   are never omitted. So each command has one canonical JSON form, and deep equality works.
// - Names (callsigns, taxiways, ramp lanes, ramps, pads, destinations) are uppercase strings
//   and airport-agnostic: they are checked against airport data later, not here. A name may
//   be all digits (LGA's ramp lanes are numbered 1–19).
// - Runways are strings in FAA style: number 1–36 without a leading zero, then an optional
//   L, C or R: '4L', '31R', '13'. Never '04L'.

/** Which way to turn onto a taxiway. */
export type Turn = 'left' | 'right';

/** One taxiway or ramp lane in a taxi route. */
export interface RouteItem {
  /** Taxiway or ramp-lane name, e.g. 'A', 'KE', 'C1', or '13' (an LGA lane). */
  taxiway: string;
  /**
   * The turn onto this taxiway, when the player said one ("right on Kilo Echo").
   * null: none given; the aircraft turns toward its destination (PRD §7).
   */
  turn: Turn | null;
}

/** What a hold-short refers to: a taxiway (or ramp lane) or a runway. */
export type HoldShortTarget =
  | { kind: 'taxiway'; name: string }
  | { kind: 'runway'; name: string };

/** Where a taxi clearance ends. */
export type Destination =
  /** A departure runway (C1), e.g. '31L'. */
  | { kind: 'runway'; name: string }
  /** A ramp / terminal (C2), e.g. 'T4'. null: "the ramp", meaning the aircraft's own. */
  | { kind: 'ramp'; name: string | null }
  /** A holding pad (C6). null: "the pad", unnamed; the sim picks it. */
  | { kind: 'pad'; name: string | null }
  /** The penalty box (C6). null: "the penalty box", unnamed; the sim picks it. */
  | { kind: 'penalty-box'; name: string | null };

/**
 * C1, C2, C6: taxi to a destination via a route.
 * It replaces the aircraft's destination, route and hold-short list.
 * Pulling a plane out of the departure line ("exit the line at Kilo Delta, hold on the pad")
 * is a taxi to a pad or the penalty box whose first route item is the exit taxiway.
 */
export interface Taxi {
  type: 'taxi';
  to: Destination;
  /** Taxiways in the order taxied. At least one. */
  via: RouteItem[];
  /** Hold-shorts given with this clearance, in the order spoken. May be empty. */
  holdShort: HoldShortTarget[];
}

/**
 * C3: hold short of one taxiway or runway on the current route. It's used on its own
 * ("hold short of runway four right") or after another instruction ("cross 22R at Yankee,
 * hold short of Bravo"). One instruction per target. Hold-shorts that are part of a taxi
 * clearance go in `Taxi.holdShort` instead.
 */
export interface HoldShort {
  type: 'hold-short';
  target: HoldShortTarget;
}

/** C4: stop now and wait ("hold position"). */
export interface HoldPosition {
  type: 'hold-position';
}

/**
 * C4: resume taxiing ("continue"). It releases a hold-position, or a taxiway hold-short the
 * aircraft is stopped at. It never releases a runway hold-short; that takes `Cross`.
 */
export interface Continue {
  type: 'continue';
}

/**
 * C5: cross one or more runways. FAA 7110.65 ¶3-7-2 requires each runway crossed to be named,
 * and allows several in one clearance where centerlines are 1,300 ft apart or less.
 */
export interface Cross {
  type: 'cross';
  /** Runways in the order crossed. At least one. */
  runways: string[];
  /** The taxiway where it crosses. null: none given; wherever its route next meets them. */
  at: string | null;
}

/** C7: hand the aircraft to tower or ramp. */
export interface Handoff {
  type: 'handoff';
  /** "monitor" (listen, don't call) or "contact" (call them). */
  mode: 'monitor' | 'contact';
  facility: 'tower' | 'ramp';
  /** MHz as written, trailing zeros dropped, e.g. '119.1', '125.05'. null: none given. */
  frequency: string | null;
}

/** A corrected turn direction for a taxiway already in the route. */
export interface TurnFix {
  taxiway: string;
  turn: Turn;
}

/**
 * C8: "negative, …". It corrects the aircraft's current clearance: the version the pilot will
 * fly, which is their readback, including any mistake (or the game's mishearing).
 *
 * Each non-null field (or non-empty `turns`) replaces that part. Parts left null stand.
 * At least one part is given. `via` and `turns` are never both given.
 * - `to` replaces the taxi destination.
 * - `via` replaces the whole route.
 * - `turns` sets the turn on the first route item with that taxiway, leaving the rest of the
 *   route alone.
 * - `holdShort` replaces the whole hold-short list. To keep a hold-short, restate it.
 * - `cross` replaces the most recent crossing clearance.
 */
export interface Correction {
  type: 'correction';
  to: Destination | null;
  via: RouteItem[] | null;
  turns: TurnFix[];
  holdShort: HoldShortTarget[] | null;
  cross: { runways: string[]; at: string | null } | null;
}

/** C9: "information Papa is current", optionally with the altimeter. */
export interface Atis {
  type: 'atis';
  /** The current ATIS letter, 'A'–'Z'. */
  letter: string;
  /** Altimeter in hundredths of inches, four digits: '2992'. null: not given. */
  altimeter: string | null;
}

/** C10: ask the pilot to repeat their last transmission. */
export interface SayAgain {
  type: 'say-again';
}

/** C12: ground stop for a destination ("ground stop for Atlanta"). */
export interface GroundStop {
  type: 'ground-stop';
  /** Destination code as spoken in the game, e.g. 'ATL'. */
  destination: string;
}

/** C12: a release time ("release time one four five two"). */
export interface ReleaseTime {
  type: 'release-time';
  /** Game-clock time, 'HH:MM' (24-hour), e.g. '14:52'. */
  time: string;
}

/** C12: "hold for release". */
export interface HoldForRelease {
  type: 'hold-for-release';
}

/** C12: an expected delay ("expect about twenty minutes"). */
export interface ExpectDelay {
  type: 'expect-delay';
  /** Whole minutes, at least 1. */
  minutes: number;
}

/** One instruction within a transmission. */
export type Instruction =
  | Taxi
  | HoldShort
  | HoldPosition
  | Continue
  | Cross
  | Handoff
  | Correction
  | Atis
  | SayAgain
  | GroundStop
  | ReleaseTime
  | HoldForRelease
  | ExpectDelay;

/**
 * One radio transmission from the player to one aircraft (PRD §6.1). Its instructions are
 * in spoken order and apply in that order. At least one.
 */
export interface AddressedTransmission {
  type: 'transmission';
  /** ICAO-style callsign, uppercase, without "heavy": 'DAL4', 'UAE202', 'N123AB'. */
  callsign: string;
  instructions: Instruction[];
}

/**
 * "Aircraft calling Ground, say again your callsign": addressed to whoever just called,
 * because their callsign wasn't understood. Say-again is the only instruction allowed.
 */
export interface UnknownStationTransmission {
  type: 'transmission';
  callsign: null;
  instructions: [SayAgain];
}

export type Transmission = AddressedTransmission | UnknownStationTransmission;

/**
 * The player's crossing request to tower (PRD §4.5): a key press on a selected aircraft, not
 * a radio call to the pilot.
 */
export interface CrossingRequest {
  type: 'crossing-request';
  callsign: string;
  /** A specific runway. null: the next runway crossing on its route, or ahead of it. */
  runway: string | null;
}

/** Everything the player can do to an aircraft: talk to it, or request a crossing for it. */
export type Command = Transmission | CrossingRequest;
