import { describe, expect, it } from 'vitest';
import { AIRPORT_IDS, loadMapAirport, parseAirportParam } from './airports.ts';

describe('loadMapAirport', () => {
  it('loads every listed airport from data/airports', async () => {
    expect(AIRPORT_IDS).toContain('TEST');
    expect(AIRPORT_IDS).toContain('KJFK');
    const test = await loadMapAirport('TEST');
    expect(test.id).toBe('TEST');
    expect(test.runways.map((r) => r.id)).toEqual(['9/27', '18/36']);
  });

  it('offers KLGA, the format check (PLAN 1.6), with its two crossing runways', async () => {
    expect(AIRPORT_IDS).toContain('KLGA');
    const klga = await loadMapAirport('KLGA');
    expect(klga.runways.map((r) => r.id)).toEqual(['4/22', '13/31']);
  });

  it("merges an airport's overrides file", async () => {
    // KJFK.json (the OSM import) has no configurations; the overrides add "31s" as the default.
    const kjfk = await loadMapAirport('KJFK');
    expect(kjfk.defaultConfiguration).toBe('31s');
    expect(kjfk.holdingAreas.map((h) => h.name)).toContain('Penalty box');
  });

  it('fails loudly when a listed airport has no base file', async () => {
    await expect(loadMapAirport('KLGA', {})).rejects.toThrow('data/airports/KLGA.json not found');
  });
});

const KNOWN = ['TEST', 'KJFK'];

describe('parseAirportParam', () => {
  it('reads the airport id from ?airport=, ignoring case', () => {
    expect(parseAirportParam('?airport=KJFK', KNOWN)).toEqual({ ok: true, id: 'KJFK' });
    expect(parseAirportParam('?foo=1&airport=test', KNOWN)).toEqual({ ok: true, id: 'TEST' });
  });

  it('names an unknown id and lists the known ones', () => {
    expect(parseAirportParam('?airport=KXYZ', KNOWN)).toEqual({
      ok: false,
      message: 'Unknown airport "KXYZ". Known airports: TEST, KJFK.',
    });
  });

  it('says when no airport was chosen, or the parameter is empty', () => {
    const missing = { ok: false, message: 'No airport chosen: add ?airport=<ID> to the URL. Known airports: TEST, KJFK.' };
    expect(parseAirportParam('', KNOWN)).toEqual(missing);
    expect(parseAirportParam('?airport=', KNOWN)).toEqual(missing);
    expect(parseAirportParam('?airport=%20', KNOWN)).toEqual(missing);
  });
});
