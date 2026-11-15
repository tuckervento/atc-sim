// Draws a scene and its aircraft onto a 2D canvas. Thin on purpose: what to draw and where
// come from the pure modules (scene, labels, view); this only paints.

import type { Point, RunwayRole } from '../../airport/types.ts';
import type { MapAircraft } from './aircraft.ts';
import { chooseLabels, type LabelKind, type MeasureLabel, type PlacedLabel, type ScreenBox } from './labels.ts';
import type { Scene, ScenePlace, SceneRunway } from './scene.ts';
import { AIRCRAFT_FONT, LABEL_FONT, MIN_AIRCRAFT_PX, MIN_WIDTH_PX, PALETTE, roleColor, RUNWAY_USE_COLOR } from './style.ts';
import { worldToScreen, type Viewport } from './view.ts';

/** Box padding around label text, px. */
const PAD_X = 4;
const PAD_Y = 2;

export function labelMeasurer(ctx: CanvasRenderingContext2D): MeasureLabel {
  const cache = new Map<string, { widthPx: number; heightPx: number }>();
  return (text, kind) => {
    const key = `${kind}\u0000${text}`;
    let size = cache.get(key);
    if (!size) {
      ctx.font = LABEL_FONT[kind];
      const m = ctx.measureText(text);
      const fontPx = Number(/(\d+)px/.exec(LABEL_FONT[kind])?.[1]);
      size = { widthPx: m.width + 2 * PAD_X, heightPx: fontPx + 2 * PAD_Y };
      cache.set(key, size);
    }
    return size;
  };
}

export function drawMap(ctx: CanvasRenderingContext2D, scene: Scene, view: Viewport, aircraft: MapAircraft[], measure: MeasureLabel): void {
  ctx.fillStyle = PALETTE.background;
  ctx.fillRect(0, 0, view.widthPx, view.heightPx);
  const px = (p: Point) => worldToScreen(view, p);

  // Display-only areas, under everything.
  for (const area of scene.areas) {
    path(ctx, area.outline.map(px), true);
    if (area.kind === 'apron') {
      ctx.fillStyle = PALETTE.apron;
      ctx.fill();
    } else {
      ctx.fillStyle = area.kind === 'terminalBuilding' ? PALETTE.terminal : PALETTE.building;
      ctx.fill();
      ctx.strokeStyle = area.kind === 'terminalBuilding' ? PALETTE.terminalEdge : PALETTE.buildingEdge;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  for (const place of scene.places) drawPlace(ctx, place, view);

  // Pavement: ramp lanes, then taxiways, then runways on top.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const kind of ['rampLane', 'taxiway'] as const) {
    for (const edge of scene.edges) {
      if (edge.kind !== kind) continue;
      path(ctx, edge.line.map(px), false);
      ctx.strokeStyle = kind === 'taxiway' ? PALETTE.taxiway : PALETTE.rampLane;
      ctx.lineWidth = Math.max(edge.widthM * view.scale, MIN_WIDTH_PX[kind]);
      ctx.stroke();
      if (edge.closed) {
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = PALETTE.closed;
        ctx.lineWidth = Math.max(2, ctx.lineWidth / 3);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }
  for (const runway of scene.runways) drawRunway(ctx, runway, view);

  if (view.scale >= 0.5) {
    ctx.fillStyle = PALETTE.gate;
    for (const gate of scene.gates) {
      const [x, y] = px(gate.at);
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  // Aircraft data blocks first in layout, so map labels make room for them.
  const blocks = aircraft.map((ac) => dataBlock(ctx, ac, view));
  const labels = chooseLabels(scene.labels, view, measure, blocks.map((b) => b.box));
  const activeEnds = activeEndRoles(scene);
  for (const label of labels) drawLabel(ctx, label, activeEnds.get(label.text));

  aircraft.forEach((ac, i) => {
    drawAircraft(ctx, ac, view);
    const block = blocks[i];
    if (block) drawDataBlock(ctx, ac, block);
  });
}

/** Data block: two lines up and to the right of the nose, joined to it by a leader line. */
interface DataBlock {
  lines: [string, string];
  /** Left edge and first baseline, px. */
  left: number;
  baseline: number;
  box: ScreenBox;
}

const BLOCK_DX = 14;
const BLOCK_DY = -22;
const BLOCK_LINE_PX = 14;

function dataBlock(ctx: CanvasRenderingContext2D, ac: MapAircraft, view: Viewport): DataBlock {
  const [x, y] = worldToScreen(view, ac.nose);
  const lines: [string, string] = [ac.callsign, `${ac.type} ${ac.destination}`];
  ctx.font = AIRCRAFT_FONT;
  const width = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const left = x + BLOCK_DX;
  const baseline = y + BLOCK_DY;
  // From the first line's cap height to below the second line's baseline.
  const top = baseline - 11;
  const bottom = baseline + BLOCK_LINE_PX + 4;
  return { lines, left, baseline, box: { x: left + width / 2, y: (top + bottom) / 2, widthPx: width, heightPx: bottom - top } };
}

function drawDataBlock(ctx: CanvasRenderingContext2D, ac: MapAircraft, block: DataBlock): void {
  const color = roleColor(ac.role);
  const [x, y] = [block.left - BLOCK_DX, block.baseline - BLOCK_DY];
  ctx.beginPath();
  ctx.moveTo(x + 3, y - 3);
  ctx.lineTo(block.left - 2, block.baseline + 6);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.font = AIRCRAFT_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  haloText(ctx, block.lines[0], block.left, block.baseline, color);
  haloText(ctx, block.lines[1], block.left, block.baseline + BLOCK_LINE_PX, color);
}

function path(ctx: CanvasRenderingContext2D, points: Point[], close: boolean): void {
  ctx.beginPath();
  points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  if (close) ctx.closePath();
}

function drawPlace(ctx: CanvasRenderingContext2D, place: ScenePlace, view: Viewport): void {
  const color = place.kind === 'hangar' ? PALETTE.hangar : place.kind === 'hardstand' ? PALETTE.hardstand : PALETTE.holding;
  if (place.outline) {
    path(ctx, place.outline.map((p) => worldToScreen(view, p)), true);
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(place.kind === 'hangar' ? [] : [5, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // Spots: a ring each, sized like a parked aircraft (~60 m) but never smaller than 3 px.
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  for (const spot of place.spots) {
    const [x, y] = worldToScreen(view, spot);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(3, 30 * view.scale), 0, 2 * Math.PI);
    ctx.stroke();
  }
}

function drawRunway(ctx: CanvasRenderingContext2D, runway: SceneRunway, view: Viewport): void {
  const [a, b] = runway.ends.map((e) => worldToScreen(view, e.at));
  if (!a || !b) return;
  const width = Math.max(runway.widthM * view.scale, MIN_WIDTH_PX.runway);
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.strokeStyle = PALETTE.runway;
  ctx.lineWidth = width;
  ctx.stroke();
  if (view.scale >= 0.4) {
    ctx.setLineDash([12, 10]);
    ctx.strokeStyle = PALETTE.runwayCenterline;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Active marking: a band along each side in the use's color. Both roles: departures on one
  // side, arrivals on the other. Plus a chevron at the end in use, pointing the way traffic goes.
  const active = runway.active;
  if (active) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / len;
    const ny = (b[0] - a[0]) / len;
    const off = width / 2 + 3;
    const sides = bandColors(active.roles);
    sides.forEach((color, i) => {
      const s = i === 0 ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(a[0] + nx * off * s, a[1] + ny * off * s);
      ctx.lineTo(b[0] + nx * off * s, b[1] + ny * off * s);
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.stroke();
    });
    const end = runway.ends.find((e) => e.designator === active.end);
    if (end) {
      const [x, y] = worldToScreen(view, end.at);
      const dx = end.along[0];
      const dy = -end.along[1];
      const size = Math.max(10, width * 1.2);
      // Chevron just inside the threshold, pointing along the runway.
      const tipX = x + dx * size * 2.2;
      const tipY = y + dy * size * 2.2;
      ctx.beginPath();
      ctx.moveTo(tipX - dx * size + -dy * size * 0.7, tipY - dy * size + dx * size * 0.7);
      ctx.lineTo(tipX, tipY);
      ctx.lineTo(tipX - dx * size - -dy * size * 0.7, tipY - dy * size - dx * size * 0.7);
      ctx.strokeStyle = sides[0] ?? PALETTE.runwayCenterline;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  }
  ctx.lineCap = 'round';
}

function bandColors(roles: RunwayRole[]): string[] {
  const dep = roles.includes('departures');
  const arr = roles.includes('arrivals');
  if (dep && arr) return [RUNWAY_USE_COLOR.departures, RUNWAY_USE_COLOR.arrivals];
  const one = dep ? RUNWAY_USE_COLOR.departures : RUNWAY_USE_COLOR.arrivals;
  return [one, one];
}

/** Active runway end designators → their roles, to color their signs. */
function activeEndRoles(scene: Scene): Map<string, RunwayRole[]> {
  const map = new Map<string, RunwayRole[]>();
  for (const r of scene.runways) if (r.active) map.set(r.active.end, r.active.roles);
  return map;
}

function drawLabel(ctx: CanvasRenderingContext2D, label: PlacedLabel, activeRoles: RunwayRole[] | undefined): void {
  const kind: LabelKind = label.kind;
  ctx.font = LABEL_FONT[kind];
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const left = label.x - label.widthPx / 2;
  const top = label.y - label.heightPx / 2;
  if (kind === 'runway' || kind === 'taxiway') {
    if (kind === 'runway' && activeRoles && activeRoles.length > 0) {
      // An active end's sign in its use's color(s): split left/right when it has both.
      const colors = bandColors(activeRoles);
      ctx.fillStyle = colors[0] ?? PALETTE.runwaySign;
      ctx.fillRect(left, top, label.widthPx / 2, label.heightPx);
      ctx.fillStyle = colors[1] ?? PALETTE.runwaySign;
      ctx.fillRect(left + label.widthPx / 2, top, label.widthPx / 2, label.heightPx);
      ctx.fillStyle = '#000000';
    } else {
      ctx.fillStyle = kind === 'runway' ? PALETTE.runwaySign : PALETTE.taxiwaySign;
      ctx.fillRect(left, top, label.widthPx, label.heightPx);
      ctx.strokeStyle = kind === 'runway' ? PALETTE.runwaySignText : PALETTE.taxiwaySignText;
      ctx.lineWidth = 1;
      ctx.strokeRect(left + 0.5, top + 0.5, label.widthPx - 1, label.heightPx - 1);
      ctx.fillStyle = kind === 'runway' ? PALETTE.runwaySignText : PALETTE.taxiwaySignText;
    }
    ctx.fillText(label.text, label.x, label.y + 0.5);
    return;
  }
  const color = kind === 'place' || kind === 'terminal' ? PALETTE.labelText : PALETTE.labelDim;
  haloText(ctx, label.text, label.x, label.y, color);
}

function haloText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
  ctx.lineJoin = 'round';
  ctx.strokeStyle = PALETTE.halo;
  ctx.lineWidth = 3;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function drawAircraft(ctx: CanvasRenderingContext2D, ac: MapAircraft, view: Viewport): void {
  const [x, y] = worldToScreen(view, ac.nose);
  const color = roleColor(ac.role);
  // Px per meter for the shape: true size, but at least MIN_AIRCRAFT_PX long.
  const k = Math.max(view.scale, MIN_AIRCRAFT_PX / ac.lengthM);
  const L = ac.lengthM * k;
  const W = ac.wingspanM * k;
  ctx.save();
  ctx.translate(x, y);
  if (ac.headingDeg === null) {
    ctx.beginPath();
    ctx.arc(0, 0, L / 3, 0, 2 * Math.PI);
  } else {
    // Drawn nose-up (screen -y) at the origin; rotating by the heading turns it clockwise from north.
    ctx.rotate((ac.headingDeg * Math.PI) / 180);
    const f = L * 0.06; // half the fuselage width
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(f, L * 0.12);
    ctx.lineTo(f, L * 0.38);
    ctx.lineTo(W / 2, L * 0.58);
    ctx.lineTo(W / 2, L * 0.64);
    ctx.lineTo(f, L * 0.56);
    ctx.lineTo(f, L * 0.84);
    ctx.lineTo(W * 0.2, L * 0.96);
    ctx.lineTo(W * 0.2, L);
    ctx.lineTo(-W * 0.2, L);
    ctx.lineTo(-W * 0.2, L * 0.96);
    ctx.lineTo(-f, L * 0.84);
    ctx.lineTo(-f, L * 0.56);
    ctx.lineTo(-W / 2, L * 0.64);
    ctx.lineTo(-W / 2, L * 0.58);
    ctx.lineTo(-f, L * 0.38);
    ctx.lineTo(-f, L * 0.12);
    ctx.closePath();
  }
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = PALETTE.halo;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}
