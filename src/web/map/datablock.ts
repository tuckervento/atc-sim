// Where an aircraft's data block goes on screen: two lines up and to the right of the nose,
// joined to it by a leader line (1.7). Pure, so draw.ts paints it and click-to-select (hit.ts)
// hits it at the same place. The caller measures text (the canvas's measureText in the browser).

import type { MapAircraft } from './aircraft.ts';
import type { ScreenBox } from './labels.ts';
import { worldToScreen, type Viewport } from './view.ts';

export interface DataBlock {
  lines: [string, string];
  /** Left edge and first baseline, px. */
  left: number;
  baseline: number;
  box: ScreenBox;
}

/** From the nose to the block's left edge and first baseline, px. */
export const BLOCK_DX = 14;
export const BLOCK_DY = -22;
/** From one line's baseline to the next, px. */
export const BLOCK_LINE_PX = 14;

/** `textWidth`: a line's width in the block's font (style.ts AIRCRAFT_FONT), px. */
export function dataBlockLayout(ac: MapAircraft, view: Viewport, textWidth: (text: string) => number): DataBlock {
  const [x, y] = worldToScreen(view, ac.nose);
  const lines: [string, string] = [ac.callsign, `${ac.type} ${ac.destination}`];
  const width = Math.max(...lines.map(textWidth));
  const left = x + BLOCK_DX;
  const baseline = y + BLOCK_DY;
  // From the first line's cap height to below the second line's baseline.
  const top = baseline - 11;
  const bottom = baseline + BLOCK_LINE_PX + 4;
  return { lines, left, baseline, box: { x: left + width / 2, y: (top + bottom) / 2, widthPx: width, heightPx: bottom - top } };
}
