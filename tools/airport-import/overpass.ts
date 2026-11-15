// The one network step of the airport importer: run the research doc's Query A (docs/research/
// airport-data.md §1.1) against Overpass and keep the response, dated, in data/airports/raw/.
// Everything after this reads that file offline.
//
// Politeness and privacy (STATUS, 1.3 incident): one request per explicit `--fetch`, and a
// generic User-Agent with no personal information in it. Overpass answers curl's default
// User-Agent with HTTP 406, so one must be sent.

export const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
export const USER_AGENT = 'atc-sim/0.1 (personal research)';

/**
 * Query A from the research doc, exactly, for one ICAO code. The doc's text is the KJFK
 * version; the KLGA one replaces every "KJFK" (three occurrences, one in the comment).
 */
export function overpassQuery(icao: string): string {
  if (!/^[A-Z0-9]{4}$/.test(icao)) throw new Error(`expected a 4-character ICAO code, got "${icao}"`);
  return [
    '[out:json][timeout:180];',
    `// The aerodrome feature for ${icao} (a way or relation tagged aeroway=aerodrome + icao=${icao})`,
    `wr["aeroway"="aerodrome"]["icao"="${icao}"]->.ap;`,
    '.ap map_to_area->.a;',
    '(',
    '  nwr["aeroway"](area.a);   // every feature carrying any aeroway=* tag inside the aerodrome boundary',
    '  .ap;                      // plus the aerodrome itself',
    ');',
    'out geom;',
    '',
  ].join('\n');
}

/** What the fetch step records about itself, stored as the raw file's first key. */
export interface FetchRecord {
  /** ISO time the response arrived. */
  fetchedAt: string;
  endpoint: string;
  userAgent: string;
  query: string;
  /** Size of the Overpass response body, before this record was added. */
  responseBytes: number;
}

/** Runs the query once. Throws with the status and the start of the body on any failure. */
export async function fetchOverpass(icao: string): Promise<{ body: string; record: FetchRecord }> {
  const query = overpassQuery(icao);
  const response = await fetch(OVERPASS_ENDPOINT, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: query }).toString(),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Overpass returned HTTP ${response.status} ${response.statusText}: ${body.slice(0, 300)}`);
  }
  checkResponse(body);
  return {
    body,
    record: {
      fetchedAt: new Date().toISOString(),
      endpoint: OVERPASS_ENDPOINT,
      userAgent: USER_AGENT,
      query,
      responseBytes: Buffer.byteLength(body, 'utf8'),
    },
  };
}

/**
 * Overpass reports runtime errors (timeouts, out of memory) as HTTP 200 with a `remark`, and
 * possibly a truncated element list. Treat that as a failure, never as data.
 */
function checkResponse(body: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(`Overpass response is not JSON (${e instanceof Error ? e.message : String(e)}): ${body.slice(0, 300)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { elements?: unknown }).elements)) {
    throw new Error(`Overpass response has no "elements" array: ${body.slice(0, 300)}`);
  }
  const remark = (parsed as { remark?: unknown }).remark;
  if (remark !== undefined) throw new Error(`Overpass reported a problem: ${String(remark)}`);
  if ((parsed as { elements: unknown[] }).elements.length === 0) {
    throw new Error('Overpass returned no elements; check the ICAO code and that the aerodrome is tagged icao=<code>');
  }
}

/**
 * The raw file: the Overpass body byte for byte, with the fetch record spliced in as the
 * first key of its top-level object. Nothing else is touched.
 */
export function datedRaw(body: string, record: FetchRecord): string {
  const open = body.indexOf('{');
  if (open < 0 || body.slice(0, open).trim() !== '') throw new Error('Overpass body does not start with a JSON object');
  const out = `{\n  "atcSimFetch": ${JSON.stringify(record)},${body.slice(open + 1)}`;
  JSON.parse(out); // the splice must leave valid JSON
  return out;
}
