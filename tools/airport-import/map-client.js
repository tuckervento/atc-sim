// Client side of the map sheet (tools/render-airport.ts inlines this file). Plain JS, no
// dependencies. Reads the JSON in #data and draws it into #world; pan with drag, zoom with the
// wheel. Positions: airport x east / y north in meters; SVG y is -y.
'use strict';
(() => {
  const D = JSON.parse(document.getElementById('data').textContent);
  const A = D.airport;
  const CTX = D.context;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.getElementById('svg');
  const world = document.getElementById('world');
  const panel = document.getElementById('panel');
  const hover = document.getElementById('hover');

  const nodes = new Map(A.nodes.map((n) => [n.id, n]));
  const edges = new Map(A.edges.map((e) => [e.id, e]));
  const edgesAt = new Map();
  for (const e of A.edges) for (const n of [e.from, e.to]) { if (!edgesAt.has(n)) edgesAt.set(n, []); edgesAt.get(n).push(e); }
  const holdsAt = new Map();
  for (const h of A.holdShorts) { if (!holdsAt.has(h.node)) holdsAt.set(h.node, []); holdsAt.get(h.node).push(h); }
  const holdRefs = (CTX && CTX.holdRefs) || {};

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  const layerNames = ['areas', 'dlines', 'edges', 'hits', 'holds', 'ctx', 'cur', 'gates', 'nodes', 'labels', 'rwlabels', 'holdLabels', 'gateLabels', 'ctxLabels', 'curLabels', 'hl'];
  const L = {};
  for (const name of layerNames) L[name] = el('g', { id: 'layer-' + name }, world);

  const sx = (p) => p[0];
  const sy = (p) => -p[1];
  const ptsAttr = (list) => list.map((p) => sx(p).toFixed(1) + ',' + sy(p).toFixed(1)).join(' ');
  const nodePt = (id) => { const n = nodes.get(id); return n ? [n.x, n.y] : null; };

  // Registry: what each id draws as, for search, highlight and issues.
  const reg = new Map(); // key "coll:id" -> { coll, id, label, els, bbox }
  const byId = new Map(); // bare id -> keys
  function register(coll, id, label, els, points) {
    const key = coll + ':' + id;
    let r = reg.get(key);
    if (!r) {
      r = { coll, id, label, els: [], bbox: [Infinity, Infinity, -Infinity, -Infinity] };
      reg.set(key, r);
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(key);
    }
    r.els.push(...els);
    for (const p of points) {
      r.bbox[0] = Math.min(r.bbox[0], sx(p)); r.bbox[1] = Math.min(r.bbox[1], sy(p));
      r.bbox[2] = Math.max(r.bbox[2], sx(p)); r.bbox[3] = Math.max(r.bbox[3], sy(p));
    }
    return r;
  }

  function polylineInfo(points) {
    let total = 0;
    const seg = [];
    for (let i = 1; i < points.length; i++) {
      const l = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
      seg.push(l);
      total += l;
    }
    let half = total / 2;
    for (let i = 0; i < seg.length; i++) {
      if (half <= seg[i] || i === seg.length - 1) {
        const t = seg[i] === 0 ? 0 : half / seg[i];
        const a = points[i];
        const b = points[i + 1];
        return { total, mid: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], angle: uprightAngle(a, b) };
      }
      half -= seg[i];
    }
    return { total, mid: points[0], angle: 0 };
  }
  function uprightAngle(a, b) {
    let ang = (Math.atan2(sy(b) - sy(a), sx(b) - sx(a)) * 180) / Math.PI;
    if (ang > 90) ang -= 180;
    if (ang < -90) ang += 180;
    return ang;
  }
  function text(parent, cls, p, str, extra) {
    const t = el('text', Object.assign({ class: cls, x: sx(p).toFixed(1), y: sy(p).toFixed(1), 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, extra || {}), parent);
    t.textContent = str;
    return t;
  }

  // ---- areas
  for (const a of A.areas) {
    const poly = el('polygon', { class: 'area-' + a.kind, points: ptsAttr(a.outline), 'data-k': 'area', 'data-id': a.id }, L.areas);
    const label = a.name || (a.terminal ? 'Terminal ' + a.terminal : null);
    const c = centroid(a.outline);
    register('area', a.id, label || a.id, [poly], a.outline);
    if (label) register('areaName', label.toUpperCase(), label, [poly], a.outline);
    if (label) text(L.labels, 'lbl-area', c, label, { 'data-len': '9999' });
  }
  function centroid(points) {
    let x = 0, y = 0;
    for (const p of points) { x += p[0]; y += p[1]; }
    return [x / points.length, y / points.length];
  }

  // ---- edges
  const edgeLabels = [];
  for (const e of A.edges) {
    const line = D.lines[e.id];
    if (!line) continue;
    const cls = 'edge edge-' + e.kind + (e.name === undefined && e.kind !== 'runway' ? ' unnamed' : '') + (e.closed ? ' closed' : '');
    const pl = el('polyline', { class: cls, points: ptsAttr(line) }, L.edges);
    const hit = el('polyline', { class: 'hit', points: ptsAttr(line), 'data-k': 'edge', 'data-id': e.id }, L.hits);
    register('edge', e.id, e.id, [pl], line);
    if (e.name !== undefined) register(e.kind === 'taxiway' ? 'taxiway' : 'rampLane', e.name.toUpperCase(), e.name, [pl], line);
    if (e.runway !== undefined) register('runway', e.runway, e.runway, [pl], line);
    hit.addEventListener('click', () => select('edge', e.id));
    const info = polylineInfo(line);
    if (e.name !== undefined) {
      const t = text(L.labels, 'lbl-' + e.kind, info.mid, e.name, { transform: `rotate(${info.angle.toFixed(1)} ${sx(info.mid).toFixed(1)} ${sy(info.mid).toFixed(1)})` });
      edgeLabels.push({ t, len: info.total, chars: e.name.length });
    } else if (e.kind === 'runway' && info.total > 500) {
      const t = text(L.rwlabels, 'lbl-runway', info.mid, e.runway, { transform: `rotate(${info.angle.toFixed(1)} ${sx(info.mid).toFixed(1)} ${sy(info.mid).toFixed(1)})` });
      edgeLabels.push({ t, len: info.total, chars: e.runway.length });
    }
  }
  for (const r of A.runways) {
    for (const end of r.ends) {
      const p = nodePt(end.node);
      if (!p) continue;
      const other = nodePt(r.ends[0] === end ? r.ends[1].node : r.ends[0].node);
      // Put the designator just beyond the pavement end it starts from.
      const d = other ? Math.hypot(other[0] - p[0], other[1] - p[1]) : 1;
      const q = other ? [p[0] - ((other[0] - p[0]) / d) * 120, p[1] - ((other[1] - p[1]) / d) * 120] : p;
      text(L.rwlabels, 'lbl-rwend', q, end.designator + (end.displacedThresholdM ? ' (displ. ' + Math.round(end.displacedThresholdM) + ' m)' : ''));
      register('runwayEnd', end.designator, end.designator, [], [p]);
    }
  }

  // ---- hold-shorts: a bar across the toward edge, on the node, plus "id kind runways"
  const holdLabels = [];
  for (const h of A.holdShorts) {
    const p = nodePt(h.node);
    const e = edges.get(h.towardEdge);
    if (!p || !e || !D.lines[e.id]) continue;
    const line = D.lines[e.id].slice();
    if (e.from !== h.node) line.reverse();
    const q = line[1];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const ux = (q[0] - p[0]) / len, uy = (q[1] - p[1]) / len;
    const half = 14;
    const a = [p[0] - uy * half, p[1] + ux * half];
    const b = [p[0] + uy * half, p[1] - ux * half];
    const bar = el('line', { class: 'hold hold-' + h.kind, x1: sx(a), y1: sy(a), x2: sx(b), y2: sy(b), 'data-k': 'hold', 'data-id': h.id }, L.holds);
    // Arrow tick toward the protected side.
    const tip = [p[0] + ux * 10, p[1] + uy * 10];
    const tick = el('line', { class: 'hold hold-' + h.kind, x1: sx(p), y1: sy(p), x2: sx(tip), y2: sy(tip) }, L.holds);
    bar.addEventListener('click', () => select('hold', h.id));
    register('hold', h.id, h.id, [bar, tick], [a, b]);
    const what = h.kind === 'intermediate' ? 'int.' : (h.kind === 'runway' ? '' : h.kind + ' ') + h.runways.join('+');
    const ref = holdRefs[h.id] ? ' [' + holdRefs[h.id] + ']' : '';
    const lp = [p[0] - ux * 26, p[1] - uy * 26];
    holdLabels.push(text(L.holdLabels, 'lbl-hold', lp, h.id + ' ' + what + ref));
  }

  // ---- gates
  for (const g of A.gates) {
    const p = nodePt(g.node);
    if (!p) continue;
    const c = el('circle', { class: 'gate mark', cx: sx(p), cy: sy(p), 'data-k': 'gate', 'data-id': g.id, style: 'r: calc(var(--u) * 3px)' }, L.gates);
    c.addEventListener('click', () => select('gate', g.id));
    register('gate', g.id, g.name + ' (' + g.terminal + ')', [c], [p]);
    register('gateName', g.name.toUpperCase(), g.name + ' (' + g.terminal + ')', [c], [p]);
    text(L.gateLabels, 'lbl-gate', [p[0], p[1] + 6], g.name);
  }

  // ---- curated items: ramp handoffs, runway exits, holding areas, departure lines
  for (const h of A.rampHandoffs) {
    const p = nodePt(h.node);
    if (!p) continue;
    const c = el('rect', { class: 'handoff mark', x: sx(p), y: sy(p), 'data-k': 'handoff', 'data-id': h.id, style: 'width: calc(var(--u) * 9px); height: calc(var(--u) * 9px); transform-box: fill-box; transform-origin: center; transform: translate(-50%, -50%) rotate(45deg)' }, L.cur);
    register('handoff', h.id, h.name, [c], [p]);
    register('handoffName', h.name.toUpperCase(), h.name, [c], [p]);
    text(L.curLabels, 'lbl-cur', [p[0], p[1] + 14], h.name + ' (' + h.use + (h.terminals ? ': ' + h.terminals.join(',') : '') + ')');
  }
  for (const x of A.runwayExits) {
    const p = nodePt(x.node);
    if (!p) continue;
    const c = el('circle', { class: 'exit mark', cx: sx(p), cy: sy(p), 'data-k': 'exit', 'data-id': x.id, style: 'r: calc(var(--u) * 4px)' }, L.cur);
    const exitName = x.taxiway || '(unnamed)';
    register('exit', x.id, exitName, [c], [p]);
    text(L.curLabels, 'lbl-cur', [p[0], p[1] - 14], 'exit ' + x.runwayEnd + '→' + exitName);
  }
  // Pads purple, the penalty box red, hardstands teal.
  const AREA_COLOR = { pad: '#9b27b0', penaltyBox: '#c62828', hardstand: '#00897b' };
  for (const area of A.holdingAreas) {
    const els = [];
    const ptsList = [];
    const color = AREA_COLOR[area.kind] || '#9b27b0';
    if (area.outline) els.push(el('polygon', { points: ptsAttr(area.outline), fill: color, 'fill-opacity': '0.12', stroke: color }, L.cur));
    for (const s of area.spots) {
      const p = nodePt(s);
      if (!p) continue;
      ptsList.push(p);
      els.push(el('circle', { class: 'spot mark', cx: sx(p), cy: sy(p), 'data-k': 'node', 'data-id': s, style: 'r: calc(var(--u) * 4px)' }, L.cur));
    }
    register('holdingArea', area.id, area.name, els, ptsList.length ? ptsList : area.outline || []);
    for (const n of area.spokenNames || []) register('holdingArea', n.toUpperCase(), area.name, els, ptsList.length ? ptsList : area.outline || []);
    const spoken = (area.spokenNames || []).filter((n) => n !== area.name);
    if (ptsList[0]) text(L.curLabels, 'lbl-cur', [ptsList[0][0], ptsList[0][1] + 16], area.name + ' (' + area.kind + (spoken.length ? '; "' + spoken.join('", "') + '"' : '') + ')');
  }
  for (const hangar of A.hangars || []) {
    const els = [];
    const ptsList = [];
    if (hangar.outline) els.push(el('polygon', { points: ptsAttr(hangar.outline), fill: '#5d4037', 'fill-opacity': '0.25', stroke: '#5d4037' }, L.cur));
    for (const s of hangar.spots) {
      const p = nodePt(s);
      if (!p) continue;
      ptsList.push(p);
      els.push(el('circle', { class: 'spot mark', cx: sx(p), cy: sy(p), 'data-k': 'node', 'data-id': s, style: 'r: calc(var(--u) * 4px); fill: #5d4037' }, L.cur));
    }
    register('hangar', hangar.id, hangar.name, els, ptsList.length ? ptsList : hangar.outline || []);
    for (const a of hangar.airlines) register('hangar', a, hangar.name, els, ptsList.length ? ptsList : hangar.outline || []);
    if (ptsList[0]) text(L.curLabels, 'lbl-cur', [ptsList[0][0], ptsList[0][1] + 16], hangar.name + ' (hangar' + (hangar.airlines.length ? ': ' + hangar.airlines.join(',') : '') + ')');
  }
  for (const line of A.departureLines) {
    const els = [];
    const ptsList = [];
    for (const id of line.edges) {
      const l = D.lines[id];
      if (!l) continue;
      ptsList.push(...l);
      els.push(el('polyline', { class: 'dline', points: ptsAttr(l) }, L.dlines));
    }
    register('departureLine', line.id, 'line ' + line.runwayEnd, els, ptsList);
    line.exits.forEach((x, i) => {
      const p = nodePt(x.node);
      if (p) text(L.curLabels, 'lbl-cur', [p[0], p[1] + 14], line.runwayEnd + ' line exit ' + (i + 1) + ': ' + x.taxiway);
    });
  }

  // ---- OSM context (not airport data)
  const ctxLabels = [];
  if (CTX) {
    for (const m of CTX.movementBoundary) {
      const p = nodePt(m.node);
      if (!p) continue;
      const c = el('rect', { class: 'ctx-mb mark', x: sx(p), y: sy(p), 'data-k': 'node', 'data-id': m.node, style: 'width: calc(var(--u) * 8px); height: calc(var(--u) * 8px); transform-box: fill-box; transform-origin: center; transform: translate(-50%, -50%) rotate(45deg)' }, L.ctx);
      register('movementBoundary', m.node, 'boundary on ' + m.names.join('/'), [c], [p]);
      ctxLabels.push(text(L.ctxLabels, 'lbl-ctx', [p[0], p[1] - 12], 'boundary ' + m.node));
    }
    for (const s of CTX.otherStands) {
      const p = nodePt(s.node);
      if (!p) continue;
      const c = el('circle', { class: 'ctx-stand mark', cx: sx(p), cy: sy(p), 'data-k': 'stand', 'data-id': s.node, style: 'r: calc(var(--u) * 2.5px)' }, L.ctx);
      c.dataset.why = (s.ref ? 'stand ' + s.ref : 'unnamed stand') + ' (' + s.osm + '): ' + s.why;
      if (s.ref) {
        register('stand', s.ref.toUpperCase(), 'stand ' + s.ref, [c], [p]);
        ctxLabels.push(text(L.ctxLabels, 'lbl-ctx', [p[0], p[1] + 6], s.ref));
      }
    }
  }

  // ---- nodes (hover targets)
  for (const n of A.nodes) {
    const c = el('circle', { class: 'node mark', cx: n.x, cy: -n.y, 'data-k': 'node', 'data-id': n.id, style: 'r: calc(var(--u) * 2.5px)' }, L.nodes);
    c.addEventListener('click', () => select('node', n.id));
    register('node', n.id, n.id, [c], [[n.x, n.y]]);
  }

  // ---- tooltips
  function describe(k, id) {
    if (k === 'node') {
      const n = nodes.get(id);
      if (!n) return id;
      const lines = ['node ' + id + '  (' + n.x + ', ' + n.y + ')'];
      for (const e of edgesAt.get(id) || []) lines.push('  ' + e.kind + ' ' + (e.name || e.runway || '(unnamed)') + '  ' + e.id + (e.closed ? '  CLOSED' : ''));
      for (const h of holdsAt.get(id) || []) lines.push('  hold ' + h.id + ' ' + h.kind + ' ' + h.runways.join('+') + ' → ' + h.towardEdge);
      for (const g of A.gates.filter((g) => g.node === id)) lines.push('  gate ' + g.name + ' (' + g.terminal + ') ' + g.id);
      if (CTX) {
        for (const m of CTX.movementBoundary.filter((m) => m.node === id)) lines.push('  OSM non-movement boundary mark (on ' + m.names.join(', ') + ')');
        for (const s of CTX.otherStands.filter((s) => s.node === id)) lines.push('  OSM stand ' + (s.ref || '(no ref)') + ': ' + s.why);
      }
      return lines.join('\n');
    }
    if (k === 'edge') {
      const e = edges.get(id);
      if (!e) return id;
      const len = polylineInfo(D.lines[id]).total;
      return [e.kind + ' ' + (e.name || e.runway || '(unnamed)') + '  ' + Math.round(len) + ' m', 'edge ' + e.id, 'from ' + e.from + ' to ' + e.to].concat(e.closed ? ['CLOSED: ' + e.closed.reason] : []).join('\n');
    }
    if (k === 'hold') {
      const h = A.holdShorts.find((x) => x.id === id);
      if (!h) return id;
      return ['hold-short ' + h.id + ' (' + h.kind + ')' + (holdRefs[id] ? '  OSM ref ' + holdRefs[id] : ''), 'protects ' + (h.runways.join(', ') || 'no runway'), 'at node ' + h.node + ', facing edge ' + h.towardEdge].join('\n');
    }
    if (k === 'gate') {
      const g = A.gates.find((x) => x.id === id);
      return g ? 'gate ' + g.name + ' (' + g.terminal + ')\nid ' + g.id + ', node ' + g.node : id;
    }
    if (k === 'area') {
      const a = A.areas.find((x) => x.id === id);
      return a ? a.kind + ' ' + (a.name || '') + (a.terminal ? ' (' + a.terminal + ')' : '') + '\narea ' + a.id : id;
    }
    if (k === 'handoff') {
      const h = A.rampHandoffs.find((x) => x.id === id);
      return h ? 'ramp handoff ' + h.name + ' (' + h.use + ')\nid ' + h.id + ', node ' + h.node : id;
    }
    if (k === 'exit') {
      const x = A.runwayExits.find((r) => r.id === id);
      return x ? 'runway exit ' + x.runwayEnd + ' → ' + (x.taxiway || '(unnamed)') + '\nid ' + x.id + ', node ' + x.node + ', edge ' + x.edge : id;
    }
    return id;
  }
  svg.addEventListener('mousemove', (ev) => {
    const t = ev.target;
    const k = t.getAttribute && t.getAttribute('data-k');
    if (!k) { hover.style.display = 'none'; return; }
    hover.textContent = k === 'stand' ? t.dataset.why + '\n' + describe('node', t.getAttribute('data-id')) : describe(k, t.getAttribute('data-id'));
    hover.style.display = 'block';
    hover.style.left = Math.min(ev.clientX + 14, window.innerWidth - 440) + 'px';
    hover.style.top = ev.clientY + 14 + 'px';
  });
  svg.addEventListener('mouseleave', () => { hover.style.display = 'none'; });

  // ---- pan and zoom
  let s = 1, tx = 0, ty = 0;
  const rect = () => svg.getBoundingClientRect();
  function apply() {
    world.setAttribute('transform', `translate(${tx} ${ty}) scale(${s})`);
    const u = 1 / s;
    svg.style.setProperty('--u', String(u));
    svg.style.setProperty('--fs-big', (15 * u) + 'px');
    svg.style.setProperty('--fs-tw', (12 * u) + 'px');
    svg.style.setProperty('--fs-small', (10.5 * u) + 'px');
    svg.style.setProperty('--fs-tiny', (9 * u) + 'px');
    for (const l of edgeLabels) l.t.style.display = l.len * s >= 18 + 8 * l.chars ? '' : 'none';
    L.holdLabels.style.display = s > 1.1 && on.holdLabels ? '' : 'none';
    L.gateLabels.style.display = s > 0.9 && on.gateLabels ? '' : 'none';
    L.ctxLabels.style.display = s > 0.9 && on.ctx ? '' : 'none';
    L.nodes.style.display = s > 0.45 && on.nodes ? '' : 'none';
  }
  function zoomAt(factor, cx, cy) {
    const ns = Math.max(0.02, Math.min(60, s * factor));
    tx = cx - ((cx - tx) * ns) / s;
    ty = cy - ((cy - ty) * ns) / s;
    s = ns;
    apply();
  }
  function fit(b, pad) {
    const r = rect();
    const w = Math.max(b[2] - b[0], 40), h = Math.max(b[3] - b[1], 40);
    s = Math.min((r.width - 2 * pad) / w, (r.height - 2 * pad) / h);
    tx = r.width / 2 - ((b[0] + b[2]) / 2) * s;
    ty = r.height / 2 - ((b[1] + b[3]) / 2) * s;
    apply();
  }
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const r = rect();
    zoomAt(Math.exp(-ev.deltaY * 0.0015), ev.clientX - r.left, ev.clientY - r.top);
  }, { passive: false });
  let drag = null;
  svg.addEventListener('pointerdown', (ev) => { drag = { x: ev.clientX, y: ev.clientY, tx, ty, moved: false }; });
  window.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    if (Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) > 3) { drag.moved = true; document.getElementById('map').classList.add('dragging'); }
    tx = drag.tx + ev.clientX - drag.x;
    ty = drag.ty + ev.clientY - drag.y;
    apply();
  });
  let justDragged = false;
  window.addEventListener('pointerup', () => { justDragged = !!(drag && drag.moved); drag = null; document.getElementById('map').classList.remove('dragging'); });

  // ---- highlight and selection
  let lit = [];
  function highlight(keys, zoom) {
    for (const e of lit) e.classList.remove('hl');
    lit = [];
    while (L.hl.firstChild) L.hl.removeChild(L.hl.firstChild);
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const key of keys) {
      const r = reg.get(key);
      if (!r) continue;
      for (const e of r.els) { e.classList.add('hl'); lit.push(e); }
      b[0] = Math.min(b[0], r.bbox[0]); b[1] = Math.min(b[1], r.bbox[1]); b[2] = Math.max(b[2], r.bbox[2]); b[3] = Math.max(b[3], r.bbox[3]);
      if (isFinite(r.bbox[0])) {
        el('rect', { x: r.bbox[0] - 25, y: r.bbox[1] - 25, width: r.bbox[2] - r.bbox[0] + 50, height: r.bbox[3] - r.bbox[1] + 50, fill: 'none', stroke: '#0a5cff', 'stroke-width': '2', 'stroke-dasharray': '6 4', 'vector-effect': 'non-scaling-stroke' }, L.hl);
      }
    }
    if (zoom && isFinite(b[0])) fit([b[0] - 150, b[1] - 150, b[2] + 150, b[3] + 150], 30);
  }
  function keysFor(id) { return byId.get(id) || []; }
  function select(k, id) {
    if (justDragged) { justDragged = false; return; }
    document.getElementById('selected').textContent = describe(k, id);
    highlight([k + ':' + id], false);
  }

  // ---- panel
  const on = { holdLabels: true, gateLabels: true, ctx: true, nodes: true };
  const esc = (str) => String(str).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const errors = D.issues.filter((i) => i.severity === 'error');
  const warnings = D.issues.filter((i) => i.severity === 'warning');
  const groups = new Map();
  for (const i of D.issues) { const k = i.severity + ' ' + i.code; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
  const taxiNames = [...new Set(A.edges.filter((e) => e.kind === 'taxiway' && e.name).map((e) => e.name))].sort();
  const laneNames = [...new Set(A.edges.filter((e) => e.kind === 'rampLane' && e.name).map((e) => e.name))].sort();
  panel.innerHTML = `
    <h1>${esc(A.id)} — ${esc(A.name)}</h1>
    <div class="muted">${D.files.map(esc).join(' + ')} (loaded with src/airport/load.ts)</div>
    <h2>Find</h2>
    <input id="q" type="search" placeholder="node, edge, hold, gate id, taxiway, runway…">
    <div class="matches" id="matches"></div>
    <h2>Selected</h2>
    <pre id="selected">Click a node, edge, hold bar or gate. Hover shows ids.</pre>
    <h2>Layers</h2>
    <label><input type="checkbox" data-layer="holdLabels" checked> hold labels (zoom in)</label>
    <label><input type="checkbox" data-layer="gateLabels" checked> gate names (zoom in)</label>
    <label><input type="checkbox" data-layer="nodes" checked> nodes (zoom in)</label>
    ${CTX ? '<label><input type="checkbox" data-layer="ctx" checked> OSM context (not airport data)</label>' : ''}
    <h2>Legend</h2>
    <div><span class="swatch" style="background:#3a3d42"></span>runway</div>
    <div><span class="swatch" style="background:#e0a800"></span>taxiway (named) <span class="swatch" style="background:#d257c9;margin-left:8px"></span>unnamed taxiway</div>
    <div><span class="swatch" style="background:#3c9a4a"></span>ramp lane / gate lead-in</div>
    <div><span class="swatch" style="background:repeating-linear-gradient(90deg,#d01c1c 0 5px,transparent 5px 9px)"></span>closed segment</div>
    <div><span class="swatch" style="background:#d01c1c"></span>runway hold <span class="swatch" style="background:#ff7a00;margin-left:8px"></span>ILS <span class="swatch" style="background:#9b27b0;margin-left:8px"></span>LAHSO <span class="swatch" style="background:#0b8fc6;margin-left:8px"></span>intermediate</div>
    <div class="muted">Hold bars sit on their node; the short tick points at the protected side. Label: id, runways [OSM ref].</div>
    <div><span class="swatch" style="background:#1565c0;height:8px;width:8px;border-radius:4px"></span>gate (blue dot, name beside it)</div>
    <div><span class="swatch" style="background:#ff7a00;opacity:.45;height:8px"></span>departure line <span class="swatch" style="background:#9b27b0;opacity:.4;height:8px;margin-left:8px"></span>pad <span class="swatch" style="background:#c62828;opacity:.4;height:8px;margin-left:8px"></span>penalty box <span class="swatch" style="background:#00897b;opacity:.4;height:8px;margin-left:8px"></span>hardstand <span class="swatch" style="background:#5d4037;opacity:.5;height:8px;margin-left:8px"></span>hangar</div>
    ${CTX ? '<div><span class="swatch" style="background:#111;height:8px;width:8px"></span>OSM non-movement boundary mark <span class="swatch" style="background:#7a7a7a;height:8px;width:8px;border-radius:4px;margin-left:8px"></span>OSM stand that is not a gate</div>' : ''}
    <h2>Validation: ${errors.length} error(s), ${warnings.length} warning(s)</h2>
    <div id="issues"></div>
    <h2>Taxiways (${taxiNames.length})</h2>
    <div class="muted">${taxiNames.map(esc).join(' ')}</div>
    <h2>Ramp lanes (${laneNames.length})</h2>
    <div class="muted">${laneNames.map(esc).join(' ') || '—'}</div>
    <h2>Runways and configurations</h2>
    <div class="muted">${A.runways.map((r) => esc(r.id) + (r.towerPosition ? ' (' + esc(r.towerPosition) + ')' : '')).join(', ')}</div>
    <div class="muted">${A.configurations.map((c) => esc(c.id + (c.id === A.defaultConfiguration ? ' (default)' : '') + ': ' + c.runways.map((u) => u.end + ' ' + u.roles.join('+')).join(', '))).join('<br>') || 'no configurations'}</div>
    <h2>Terminals</h2>
    <div class="muted">${A.terminals.map((t) => esc(t.id) + ': ' + (esc(t.airlines.join(' ')) || 'no airlines')).join('<br>') || '—'}</div>
    <h2>Source</h2>
    <div class="muted">${esc(A.source ? A.source.description : 'no source given')}</div>
    <div class="muted">${esc(A.source && A.source.license ? A.source.license : '')}</div>
    ${CTX ? '<div class="muted">OSM context overlay recomputed from ' + esc(D.renderedFrom) + '.</div>' : ''}
  `;
  const issuesDiv = document.getElementById('issues');
  for (const [k, list] of [...groups].sort()) {
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    sum.className = k.startsWith('error') ? 'err' : 'warn';
    sum.textContent = k + ' (' + list.length + ')';
    det.appendChild(sum);
    for (const i of list) {
      const d = document.createElement('div');
      d.className = 'issue';
      d.textContent = i.message;
      d.addEventListener('click', () => highlight(i.ids.flatMap(keysFor), true));
      det.appendChild(d);
    }
    issuesDiv.appendChild(det);
  }
  for (const box of panel.querySelectorAll('input[data-layer]')) {
    box.addEventListener('change', () => {
      const name = box.getAttribute('data-layer');
      on[name] = box.checked;
      if (name === 'ctx') L.ctx.style.display = box.checked ? '' : 'none';
      apply();
    });
  }
  const q = document.getElementById('q');
  const matches = document.getElementById('matches');
  q.addEventListener('input', () => {
    const v = q.value.trim().toUpperCase();
    matches.innerHTML = '';
    if (!v) return;
    const found = [];
    for (const [key, r] of reg) {
      const id = r.id.toUpperCase();
      if (id === v || id.startsWith(v) || (r.label && r.label.toUpperCase() === v)) found.push([key, r]);
    }
    found.sort((a, b) => (a[1].id.toUpperCase() === v ? 0 : 1) - (b[1].id.toUpperCase() === v ? 0 : 1) || a[0].localeCompare(b[0]));
    for (const [key, r] of found.slice(0, 40)) {
      const d = document.createElement('div');
      d.textContent = r.coll + ': ' + r.id + (r.label && r.label !== r.id ? ' — ' + r.label : '');
      d.addEventListener('click', () => { highlight([key], true); const [k, ...rest] = key.split(':'); document.getElementById('selected').textContent = describe(k, rest.join(':')); });
      matches.appendChild(d);
    }
    if (found.length > 40) matches.appendChild(Object.assign(document.createElement('div'), { textContent: '… ' + (found.length - 40) + ' more' }));
  });
  q.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && matches.firstChild) matches.firstChild.click(); });

  // ---- start: fit the whole airport
  const all = [Infinity, Infinity, -Infinity, -Infinity];
  for (const n of A.nodes) { all[0] = Math.min(all[0], n.x); all[1] = Math.min(all[1], -n.y); all[2] = Math.max(all[2], n.x); all[3] = Math.max(all[3], -n.y); }
  fit(all, 20);
  window.addEventListener('resize', () => apply());
  window.__map = { reg, highlight, fit, zoomAt, get scale() { return s; } };
})();
