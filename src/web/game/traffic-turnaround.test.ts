// The traffic's callsigns for turned-around flights (traffic.ts, PLAN 1.13): the sim asks for one
// when a parked arrival departs again (ramp.ts, "Turnarounds").

import { describe, expect, it } from 'vitest';
import kjfkBase from '../../../data/airports/KJFK.json' with { type: 'json' };
import kjfkOverrides from '../../../data/airports/KJFK.overrides.json' with { type: 'json' };
import { loadAirport } from '../../airport/load.ts';
import { trafficFor } from './traffic.ts';

const KJFK = loadAirport(kjfkBase, kjfkOverrides);
const RATES = { arrivalsPerHourPerRunway: 6, departuresPerHourPerTerminal: 3 };
const ANY = () => true;

describe("the traffic's turnaround callsigns", () => {
  it("are the inbound's airline and a new flight number, never one a stream's flight has, nor another turnaround's (KJFK, 1,000 of each stream's and 1,000 turnarounds)", () => {
    const { arrivals, departures, turnaroundCallsign } = trafficFor(KJFK, 1, RATES, ANY);
    const flights = [...arrivals, ...departures].flatMap((s) => Array.from({ length: 1000 }, (_, n) => s.flight(n).callsign));
    const turned = Array.from({ length: 1000 }, (_, n) => turnaroundCallsign(n, { callsign: 'DAL402', airline: 'DAL' }));
    for (const c of turned) expect(c).toMatch(/^DAL[1-9][0-9]{0,3}$/);
    const number = (c: string) => c.replace(/^[A-Z]+/, '');
    const numbers = new Set([...flights, ...turned].map(number));
    expect(numbers.size).toBe(flights.length + turned.length);
    expect(turnaroundCallsign(3, { callsign: 'BAW1', airline: 'BAW' })).toBe(`BAW${number(turned[3] ?? '')}`);
  });
});
