// The local frame airport positions are stored in, defined exactly so the importer, the
// renderer and any later tool agree.
//
// x = meters east, y = meters north of the airport's reference point, using a local
// tangent-plane approximation on the WGS84 ellipsoid: longitude differences scale by the
// prime-vertical radius × cos(reference latitude), latitude differences by the meridional
// radius, both evaluated at the reference latitude. Over an airport (a few km) this is
// within a meter or so of a true projection, far below the data's own accuracy.

import type { Point, ReferencePoint } from './types.ts';

const WGS84_A = 6378137; // semi-major axis, m
const WGS84_E2 = 0.00669437999014; // first eccentricity squared
const DEG = Math.PI / 180;

function radiiAt(latDeg: number): { meridional: number; primeVertical: number } {
  const s = Math.sin(latDeg * DEG);
  const w = 1 - WGS84_E2 * s * s;
  return {
    meridional: (WGS84_A * (1 - WGS84_E2)) / (w * Math.sqrt(w)),
    primeVertical: WGS84_A / Math.sqrt(w),
  };
}

/** Projects WGS84 lat/lon (degrees) into the airport's local frame. */
export function toLocal(reference: ReferencePoint, lat: number, lon: number): Point {
  const { meridional, primeVertical } = radiiAt(reference.lat);
  const x = (lon - reference.lon) * DEG * primeVertical * Math.cos(reference.lat * DEG);
  const y = (lat - reference.lat) * DEG * meridional;
  return [x, y];
}

/** Inverse of `toLocal`. */
export function toLatLon(reference: ReferencePoint, point: Point): { lat: number; lon: number } {
  const { meridional, primeVertical } = radiiAt(reference.lat);
  return {
    lat: reference.lat + point[1] / meridional / DEG,
    lon: reference.lon + point[0] / (primeVertical * Math.cos(reference.lat * DEG)) / DEG,
  };
}
