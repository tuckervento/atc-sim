// Mounts the map in a container: a canvas sized to it (sharp on high-DPI screens), pan by
// drag, zoom by wheel around the cursor. Redraws on the next animation frame after a change.

import type { MapAircraft } from './aircraft.ts';
import { drawMap, labelMeasurer } from './draw.ts';
import type { Scene } from './scene.ts';
import { fitView, panBy, zoomAt, type Viewport } from './view.ts';

/** Space around the airport in the first view, px. */
const FIT_PADDING_PX = 40;
/** Zoom per wheel pixel: a typical 100 px notch is ×1.16. */
const WHEEL_ZOOM_PER_PX = 0.0015;

export interface MapHandle {
  /** Replaces the aircraft drawn (1.13 calls this every frame). */
  setAircraft(aircraft: MapAircraft[]): void;
  /** Back to the whole-airport view. */
  fit(): void;
  getView(): Viewport;
}

export function mountMap(container: HTMLElement, scene: Scene, initialAircraft: MapAircraft[]): MapHandle {
  const canvas = document.createElement('canvas');
  canvas.className = 'map-canvas';
  container.append(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('this browser gives no 2D canvas context');
  const measure = labelMeasurer(ctx);

  let aircraft = initialAircraft;
  let view: Viewport = fitView(scene.bounds, container.clientWidth, container.clientHeight, FIT_PADDING_PX);
  let fitted = true;
  let frame = 0;

  const redraw = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawMap(ctx, scene, view, aircraft, measure);
    });
  };

  const resize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    // Until the user moves the map, keep the whole airport in view; after, keep their center.
    view = fitted ? fitView(scene.bounds, w, h, FIT_PADDING_PX) : { ...view, widthPx: w, heightPx: h };
    redraw();
  };
  new ResizeObserver(resize).observe(container);
  resize();

  canvas.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect();
      // Line-mode wheels (some mice, Firefox) report lines, not pixels.
      const deltaPx = ev.deltaMode === WheelEvent.DOM_DELTA_LINE ? ev.deltaY * 16 : ev.deltaY;
      view = zoomAt(view, Math.exp(-deltaPx * WHEEL_ZOOM_PER_PX), [ev.clientX - rect.left, ev.clientY - rect.top]);
      fitted = false;
      redraw();
    },
    { passive: false },
  );

  let drag: { x: number; y: number; pointer: number } | null = null;
  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    drag = { x: ev.clientX, y: ev.clientY, pointer: ev.pointerId };
    canvas.setPointerCapture(ev.pointerId);
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.pointer) return;
    view = panBy(view, ev.clientX - drag.x, ev.clientY - drag.y);
    drag.x = ev.clientX;
    drag.y = ev.clientY;
    fitted = false;
    redraw();
  });
  const endDrag = (ev: PointerEvent) => {
    if (!drag || ev.pointerId !== drag.pointer) return;
    drag = null;
    canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  return {
    setAircraft(next) {
      aircraft = next;
      redraw();
    },
    fit() {
      fitted = true;
      resize();
    },
    getView: () => view,
  };
}
