// The aircraft types the sim knows, with their footprint: overall length and wingspan, for
// spacing behind traffic and for overlap (a collision, PRD §4.8 and §8.6).
//
// Dimensions are the manufacturers' published overall length and wingspan, rounded to 0.1 m,
// as I know them from their airport planning documents. Not re-checked against the documents
// for this table. Where a type has wingtip options, it's the common JFK fit: sharklets on the
// A320 family, blended winglets on the 737NG, no winglets on the 767-300ER.

export interface Footprint {
  /** Nose to tail, meters. */
  lengthM: number;
  /** Wingtip to wingtip, meters. */
  wingspanM: number;
}

/** By ICAO type designator. */
export const AIRCRAFT_TYPES = {
  E175: { lengthM: 31.7, wingspanM: 26.0 },
  A320: { lengthM: 37.6, wingspanM: 35.8 },
  A321: { lengthM: 44.5, wingspanM: 35.8 },
  B738: { lengthM: 39.5, wingspanM: 35.8 },
  B739: { lengthM: 42.1, wingspanM: 35.8 },
  B763: { lengthM: 54.9, wingspanM: 47.6 },
  B789: { lengthM: 62.8, wingspanM: 60.1 },
  A333: { lengthM: 63.7, wingspanM: 60.3 },
  A359: { lengthM: 66.8, wingspanM: 64.8 },
  B77W: { lengthM: 73.9, wingspanM: 64.8 },
  A388: { lengthM: 72.7, wingspanM: 79.8 },
} as const satisfies Record<string, Footprint>;

export type AircraftTypeCode = keyof typeof AIRCRAFT_TYPES;

export function isAircraftType(code: string): code is AircraftTypeCode {
  return Object.hasOwn(AIRCRAFT_TYPES, code);
}
