// Reading an Overpass `out geom` response: typed elements, node positions, polygon rings.

export interface LatLon {
  lat: number;
  lon: number;
}

export type Tags = Record<string, string>;

export interface OsmNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Tags;
}

export interface OsmWay {
  type: 'way';
  id: number;
  nodes: number[];
  geometry: LatLon[];
  tags?: Tags;
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
}

export interface OsmMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role: string;
  geometry?: LatLon[];
}

export interface OsmRelation {
  type: 'relation';
  id: number;
  members: OsmMember[];
  tags?: Tags;
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
}

export type OsmElement = OsmNode | OsmWay | OsmRelation;

export interface OverpassResponse {
  osm3s: { timestamp_osm_base: string };
  atcSimFetch?: { fetchedAt: string; query: string };
  elements: OsmElement[];
}

/** Checks the response shape enough that later code can trust the types. Throws on surprises. */
export function readOverpass(raw: unknown): OverpassResponse {
  if (typeof raw !== 'object' || raw === null) throw new Error('raw file: expected a JSON object');
  const r = raw as Record<string, unknown>;
  const osm3s = r.osm3s as Record<string, unknown> | undefined;
  if (!osm3s || typeof osm3s.timestamp_osm_base !== 'string') throw new Error('raw file: no osm3s.timestamp_osm_base');
  if (!Array.isArray(r.elements)) throw new Error('raw file: no elements array');
  for (const [i, e] of (r.elements as unknown[]).entries()) {
    const el = e as Record<string, unknown>;
    const where = `raw file: elements[${i}] (${String(el.type)} ${String(el.id)})`;
    if (typeof el.id !== 'number') throw new Error(`${where}: no numeric id`);
    if (el.type === 'node') {
      if (typeof el.lat !== 'number' || typeof el.lon !== 'number') throw new Error(`${where}: node without lat/lon`);
    } else if (el.type === 'way') {
      if (!Array.isArray(el.nodes) || !Array.isArray(el.geometry) || el.nodes.length !== el.geometry.length) {
        throw new Error(`${where}: way without matching nodes and geometry (was the query run with "out geom"?)`);
      }
    } else if (el.type === 'relation') {
      if (!Array.isArray(el.members)) throw new Error(`${where}: relation without members`);
    } else {
      throw new Error(`${where}: unknown element type`);
    }
  }
  return raw as OverpassResponse;
}

export function tag(e: { tags?: Tags }, key: string): string | undefined {
  const v = e.tags?.[key];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
}

/**
 * The closed rings of a polygon feature: a closed way is one ring; a multipolygon relation's
 * outer member ways are joined end to end into rings. Each ring is returned without its
 * repeated closing point. Throws if outer members don't close into rings.
 */
export function outerRings(e: OsmWay | OsmRelation): LatLon[][] {
  if (e.type === 'way') {
    const first = e.nodes[0];
    if (e.nodes.length < 4 || first !== e.nodes.at(-1)) throw new Error(`way ${e.id} is not a closed polygon`);
    return [e.geometry.slice(0, -1)];
  }
  const parts = e.members
    .filter((m) => m.type === 'way' && (m.role === 'outer' || m.role === '') && m.geometry && m.geometry.length >= 2)
    .map((m) => m.geometry as LatLon[]);
  const same = (a: LatLon | undefined, b: LatLon | undefined) => a !== undefined && b !== undefined && a.lat === b.lat && a.lon === b.lon;
  const rings: LatLon[][] = [];
  const pool = [...parts];
  while (pool.length > 0) {
    let ring = [...(pool.shift() as LatLon[])];
    for (;;) {
      if (ring.length >= 4 && same(ring[0], ring.at(-1))) break;
      const i = pool.findIndex((p) => same(p[0], ring.at(-1)) || same(p.at(-1), ring.at(-1)));
      if (i < 0) throw new Error(`relation ${e.id}: outer members don't close into a ring`);
      const next = pool.splice(i, 1)[0] as LatLon[];
      ring = ring.concat(same(next[0], ring.at(-1)) ? next.slice(1) : [...next].reverse().slice(1));
    }
    rings.push(ring.slice(0, -1));
  }
  return rings;
}
