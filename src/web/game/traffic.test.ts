import { describe, expect, it } from 'vitest';
import kjfkBase from '../../../data/airports/KJFK.json' with { type: 'json' };
import kjfkOverrides from '../../../data/airports/KJFK.overrides.json' with { type: 'json' };
import testAirport from '../../../data/airports/TEST.json' with { type: 'json' };
import { loadAirport } from '../../airport/load.ts';
import { FLEETS, TRAFFIC_RATES, trafficFor } from './traffic.ts';

const TEST = loadAirport(testAirport);
const KJFK = loadAirport(kjfkBase, kjfkOverrides);
const RATES = { arrivalsPerHourPerRunway: 6, departuresPerHourPerTerminal: 3 };
/** Every type can depart from every terminal. */
const ANY = () => true;

describe('trafficFor', () => {
  it("streams arrivals to every runway end that lands in the default configuration, at the rate (KJFK's 31s: 31L and 31R)", () => {
    expect(trafficFor(KJFK, 1, RATES, ANY).arrivals.map((s) => [s.runwayEnd, s.perHour])).toEqual([
      ['31L', 6],
      ['31R', 6],
    ]);
    expect(trafficFor(TEST, 1, RATES, ANY).arrivals.map((s) => s.runwayEnd)).toEqual(['27', '36']);
  });

  it("streams departures from every terminal, at the rate, each flown by one of the terminal's airlines in a type of its fleet", () => {
    const { departures } = trafficFor(KJFK, 1, RATES, ANY);
    expect(departures.map((s) => [s.flight(0).terminal, s.perHour])).toEqual(KJFK.terminals.map((t) => [t.id, 3]));
    for (const [i, stream] of departures.entries()) {
      const terminal = KJFK.terminals[i];
      for (let n = 0; n < 40; n++) {
        const flight = stream.flight(n);
        expect(flight.terminal).toBe(terminal?.id);
        const airline = flight.airline ?? '';
        expect(terminal?.airlines).toContain(airline);
        expect(FLEETS[airline]).toContain(flight.type);
        expect(flight.callsign).toMatch(new RegExp(`^${airline}[1-9][0-9]{0,3}$`));
      }
    }
  });

  it("gives each arrival a terminal, one of that terminal's airlines and a type of its fleet, across all the terminals", () => {
    const terminalsSeen = new Set<string>();
    for (const stream of trafficFor(KJFK, 1, RATES, ANY).arrivals) {
      for (let n = 0; n < 60; n++) {
        const flight = stream.flight(n);
        const terminal = KJFK.terminals.find((t) => t.id === flight.terminal);
        const airline = flight.airline ?? '';
        expect(terminal?.airlines).toContain(airline);
        expect(FLEETS[airline]).toContain(flight.type);
        expect(flight.callsign).toMatch(new RegExp(`^${airline}[1-9][0-9]{0,3}$`));
        terminalsSeen.add(terminal?.id ?? '');
      }
    }
    expect([...terminalsSeen].sort()).toEqual(KJFK.terminals.map((t) => t.id).sort());
  });

  it('never gives two flights of a session the same callsign, across all its streams', () => {
    const { arrivals, departures } = trafficFor(KJFK, 1, RATES, ANY);
    const flights = [...arrivals, ...departures].flatMap((s) => Array.from({ length: 1000 }, (_, n) => s.flight(n).callsign));
    expect(flights.length).toBe(7000);
    expect(new Set(flights).size).toBe(7000);
  });

  it('only flies a type from a terminal it can depart from (a stream retries a flight until a gate takes it)', () => {
    // Today's KJFK ramp, say: no widebody can push back at T8, and nothing at T7.
    const canDepart = (terminal: string, type: string) => terminal !== 'T7' && !(terminal === 'T8' && ['B789', 'B77W', 'A359', 'A333'].includes(type));
    const { arrivals, departures, skipped } = trafficFor(KJFK, 1, RATES, canDepart);
    expect(departures.map((s) => s.flight(0).terminal)).toEqual(['T1', 'T4', 'T5', 'T8']);
    const flights = [...arrivals, ...departures].flatMap((s) => Array.from({ length: 200 }, (_, n) => s.flight(n)));
    for (const f of flights) expect(canDepart(f.terminal ?? '', f.type)).toBe(true);
    expect(flights.some((f) => f.terminal === 'T8')).toBe(true);
    expect(skipped).toEqual([{ terminal: 'T7', reason: 'none of its airlines’ types can push back from a gate there' }]);
  });

  it("skips a terminal none of whose airlines has a fleet, saying so", () => {
    const airport = { ...TEST, terminals: TEST.terminals.map((t) => (t.id === 'T2' ? { ...t, airlines: ['XYZ'] } : t)) };
    const { departures, skipped } = trafficFor(airport, 1, RATES, ANY);
    expect(departures.map((s) => s.flight(0).terminal)).toEqual(['T1']);
    expect(skipped).toEqual([{ terminal: 'T2', reason: 'no airline of its (XYZ) has a fleet in FLEETS' }]);
  });

  it('starts every stream within the first three minutes, no two at the same moment, so play starts soon but not all at once', () => {
    const { arrivals, departures } = trafficFor(KJFK, 1, RATES, ANY);
    const starts = [...arrivals, ...departures].map((s) => s.firstAtS ?? 0);
    expect(starts.every((s) => s > 0 && s <= 180)).toBe(true);
    expect(new Set(starts).size).toBe(starts.length);
  });

  it('has rates for the airports with live traffic, TEST and KJFK, and none for the others', () => {
    expect(Object.keys(TRAFFIC_RATES).sort()).toEqual(['KJFK', 'TEST']);
  });

  it('is deterministic from the seed: the same seed gives the same flights, another seed others', () => {
    const flights = (seed: number) => {
      const { arrivals, departures } = trafficFor(KJFK, seed, RATES, ANY);
      return [...arrivals, ...departures].flatMap((s) => Array.from({ length: 20 }, (_, n) => s.flight(n)));
    };
    expect(flights(1)).toEqual(flights(1));
    const [one, two] = [flights(1), flights(2)];
    expect(one.filter((f, i) => f.callsign !== two[i]?.callsign).length).toBeGreaterThan(130);
    expect(one.filter((f, i) => f.type !== two[i]?.type).length).toBeGreaterThan(20);
  });
});
