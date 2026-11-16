// The aircraft types the sim knows, with their footprint: overall length and wingspan, for
// spacing behind traffic and for overlap (a collision, PRD §4.8 and §8.6).
//
// Dimensions are the manufacturers' published overall length and wingspan, rounded to 0.1 m,
// as I know them from their airport planning documents. Not re-checked against the documents
// for this table. Where a type has wingtip options, it's the common JFK fit: sharklets on the
// A320 family, blended winglets on the 737NG, no winglets on the 767-300ER.
//
// mainGearM: how far the main gear is behind the nose tip (nose tip to nose gear, plus the
// wheelbase), 0.1 m. It's what the body turns about (footprint.ts). The footprint knows only a
// body's length and span, so it puts the gear at MAIN_GEAR_FROM of the length for every type;
// these values are the evidence for that fraction, and a test (body-axis.test.ts) keeps each
// within 0.03 of the length of it. Sources, Airbus "Aircraft Characteristics – Airport and
// Maintenance Planning" (AC), read 2026-11-16 from Airbus's site:
// - A320: 5.07 m nose to nose gear + 12.64 m wheelbase (AC A320, 01-Jul-2026, 2-2-0 General
//   Aircraft Dimensions) = 17.71 m, 0.471 of 37.57 m. The 4-7-0 line-up corrections agree on the
//   wheelbase (ASDA − TODA = 24.3 − 11.7 = 12.6 m).
// - A321: 5.07 m + 16.90 m (AC A321, 01-Jul-2026, 2-2-0; 4-7-0 gives 29.5 − 12.6 = 16.9 m)
//   = 21.97 m, 0.494 of 44.51 m.
// - A333: 25.375 m wheelbase (AC A330, Dec-2025, landing gear table; 4-7-0 gives 49.1 − 23.7 =
//   25.4 m) + about 5.6 m nose to nose gear, a figure value I couldn't match to its label
//   (unverified) = 31.0 m, 0.487 of 63.67 m.
// - A388: the wing gear is 33.58 m and the body gear 36.85 m behind the nose (AC A380, Dec-2025,
//   2-2-0, as I read the figure's labels: with its 4.97 m nose to nose gear, that's wheelbases of
//   28.6 and 31.9 m, and 4-7-0's line-up corrections give 29.8–30.1 m between them). The
//   midpoint, 35.2 m: 0.484 of 72.73 m.
// - [estimate] E175, B738, B739, B763, B789, A359, B77W: 0.5 × length, as Q asked where no
//   published position was found. Boeing's planning documents give these only in drawings
//   whose text I couldn't extract; Embraer's and the A350's I didn't find in a readable form.

export interface Footprint {
  /** Nose to tail, meters. */
  lengthM: number;
  /** Wingtip to wingtip, meters. */
  wingspanM: number;
  /** Nose tip to the main gear, meters (sources above). */
  mainGearM: number;
}

/** By ICAO type designator. */
export const AIRCRAFT_TYPES = {
  E175: { lengthM: 31.7, wingspanM: 26.0, mainGearM: 15.9 },
  A320: { lengthM: 37.6, wingspanM: 35.8, mainGearM: 17.7 },
  A321: { lengthM: 44.5, wingspanM: 35.8, mainGearM: 22.0 },
  B738: { lengthM: 39.5, wingspanM: 35.8, mainGearM: 19.8 },
  B739: { lengthM: 42.1, wingspanM: 35.8, mainGearM: 21.1 },
  B763: { lengthM: 54.9, wingspanM: 47.6, mainGearM: 27.5 },
  B789: { lengthM: 62.8, wingspanM: 60.1, mainGearM: 31.4 },
  A333: { lengthM: 63.7, wingspanM: 60.3, mainGearM: 31.0 },
  A359: { lengthM: 66.8, wingspanM: 64.8, mainGearM: 33.4 },
  B77W: { lengthM: 73.9, wingspanM: 64.8, mainGearM: 37.0 },
  A388: { lengthM: 72.7, wingspanM: 79.8, mainGearM: 35.2 },
} as const satisfies Record<string, Footprint>;

export type AircraftTypeCode = keyof typeof AIRCRAFT_TYPES;

export function isAircraftType(code: string): code is AircraftTypeCode {
  return Object.hasOwn(AIRCRAFT_TYPES, code);
}
