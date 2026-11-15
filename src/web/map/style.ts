// The map's colors and sizes. Pure data, plus the role → color rule.

import type { RunwayRole } from '../../airport/types.ts';
import type { AircraftRole } from './aircraft.ts';

/** Active-runway marking per use. Aircraft with the matching role share the color. */
export const RUNWAY_USE_COLOR: Record<RunwayRole, string> = {
  departures: '#4aa3ff',
  arrivals: '#4cd07d',
};

/**
 * Delayed aircraft, and the pads and penalty box they wait on, are magenta: far in hue from the
 * departure blue, the arrival green and the yellow taxiway signs.
 */
export const DELAYED_COLOR = '#ff5fd2';

const ROLE_COLOR: Record<AircraftRole, string> = {
  departure: RUNWAY_USE_COLOR.departures,
  arrival: RUNWAY_USE_COLOR.arrivals,
  delayed: DELAYED_COLOR,
};

export function roleColor(role: AircraftRole): string {
  return ROLE_COLOR[role];
}

/**
 * The base map: a dark ground display, so the role colors and the runway marking stand out.
 * Signs follow airfield convention: taxiway names yellow on black, runway designators white on red.
 */
export const PALETTE = {
  background: '#0d1117',
  apron: '#18202a',
  building: '#252e39',
  buildingEdge: '#3a4655',
  terminal: '#2c3a4b',
  terminalEdge: '#5a6f88',
  rampLane: '#323c48',
  taxiway: '#56616e',
  closed: '#d9534f',
  runway: '#8b949e',
  runwayCenterline: '#f0f3f6',
  runwaySign: '#b3261e',
  runwaySignText: '#ffffff',
  taxiwaySign: '#000000',
  taxiwaySignText: '#f5c518',
  gate: '#8b97a6',
  /** Pads and the penalty box: where delayed aircraft wait. */
  holding: DELAYED_COLOR,
  hardstand: '#5fd3e6',
  hangar: '#c9a46a',
  labelText: '#d5dde6',
  labelDim: '#8b97a6',
  halo: '#0d1117',
} as const;

/** Label fonts per kind (CSS px; the canvas is scaled for the device pixel ratio). */
export const LABEL_FONT = {
  runway: 'bold 13px system-ui, sans-serif',
  taxiway: 'bold 12px system-ui, sans-serif',
  place: 'italic 600 12px system-ui, sans-serif',
  terminal: 'bold 13px system-ui, sans-serif',
  rampLane: '11px system-ui, sans-serif',
  building: '11px system-ui, sans-serif',
  gate: '10px system-ui, sans-serif',
} as const;

export const AIRCRAFT_FONT = 'bold 12px ui-monospace, Menlo, monospace';

/** Narrowest a feature is drawn, px, however far out the zoom. */
export const MIN_WIDTH_PX = { runway: 4, taxiway: 2, rampLane: 1 } as const;

/** Smallest an aircraft is drawn (its length), px, so it stays visible zoomed out. */
export const MIN_AIRCRAFT_PX = 16;
