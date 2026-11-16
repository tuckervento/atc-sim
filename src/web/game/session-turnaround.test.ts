// The session's side of turnarounds (PLAN 1.13): the sim takes a turned flight's callsign from
// the session's traffic, and the session remembers that flight's terminal for its label.

import { describe, expect, it } from 'vitest';
import kjfkBase from '../../../data/airports/KJFK.json' with { type: 'json' };
import kjfkOverrides from '../../../data/airports/KJFK.overrides.json' with { type: 'json' };
import { loadAirport } from '../../airport/load.ts';
import { createSession } from './session.ts';
import { TRAFFIC_RATES, trafficFor } from './traffic.ts';

const KJFK = loadAirport(kjfkBase, kjfkOverrides);

describe("a session's turnarounds", () => {
  it("take their callsigns from the session's traffic, and the session knows the turned flight's terminal (KJFK)", () => {
    const session = createSession(KJFK, { seed: 1 });
    const turnaround = session.sim.ramp.turnaround;
    if (turnaround === null) throw new Error('turnarounds are off in the session');
    // An inbound the session spawned: its terminal is remembered at spawn.
    const inbound = session.sim.ramp.streams[0]?.flight(0);
    if (!inbound) throw new Error('no departure stream');
    const traffic = trafficFor(KJFK, 1, TRAFFIC_RATES['KJFK'] ?? { arrivalsPerHourPerRunway: 0, departuresPerHourPerTerminal: 0 }, () => true);
    const named = turnaround.callsign(0, { callsign: inbound.callsign, type: 'A320', airline: inbound.airline ?? null, gate: 'g1009800796' });
    expect(named).toBe(traffic.turnaroundCallsign(0, { callsign: inbound.callsign, airline: inbound.airline ?? null }));
    expect(session.terminals.get(named)).toBe(inbound.terminal);
  });
});
