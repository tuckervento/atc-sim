import { describe, expect, it } from 'vitest';
import type { MapAircraft } from './aircraft.ts';
import { dataBlockLayout } from './datablock.ts';
import type { Viewport } from './view.ts';

const VIEW: Viewport = { centerX: 0, centerY: 0, scale: 1, widthPx: 800, heightPx: 600 };
const DAL4: MapAircraft = { callsign: 'DAL4', type: 'A320', nose: [10, 20], headingDeg: 0, lengthM: 37.6, wingspanM: 35.8, role: 'departure', destination: '31L' };

describe('dataBlockLayout', () => {
  it('puts the two lines up and to the right of the nose, its box as wide as the wider line (as 1.7 drew it)', () => {
    // The nose is at screen (410, 280).
    const width = (text: string) => text.length * 7;
    expect(dataBlockLayout(DAL4, VIEW, width)).toEqual({
      lines: ['DAL4', 'A320 31L'],
      left: 424,
      baseline: 258,
      box: { x: 424 + 28, y: (247 + 276) / 2, widthPx: 56, heightPx: 29 },
    });
  });
});
