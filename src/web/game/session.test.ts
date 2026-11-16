import { describe, expect, it } from 'vitest';
import kjfkBase from '../../../data/airports/KJFK.json' with { type: 'json' };
import kjfkOverrides from '../../../data/airports/KJFK.overrides.json' with { type: 'json' };
import klgaBase from '../../../data/airports/KLGA.json' with { type: 'json' };
import klgaOverrides from '../../../data/airports/KLGA.overrides.json' with { type: 'json' };
import testAirport from '../../../data/airports/TEST.json' with { type: 'json' };
import { loadAirport } from '../../airport/load.ts';
import type { LogLine } from './event-log.ts';
import { drainEvents } from '../../sim/sim.ts';
import { advance, createSession, drawnAircraft, requestCrossing, startupLines, submit, type Session } from './session.ts';

const TEST = loadAirport(testAirport);

/** Runs `simSeconds` of sim time in 4× frames of 0.2 s (8 ticks each), collecting the log lines. */
function run(session: Session, simSeconds: number): LogLine[] {
  session.controls.speed = 4;
  const lines: LogLine[] = [];
  for (let t = 0; t < simSeconds; t += 0.8) lines.push(...advance(session, 0.2));
  return lines;
}

describe('a session', () => {
  it("runs the airport's traffic in real time: on TEST, departures push back and check in, and arrivals call clear of the runway", () => {
    const session = createSession(TEST, { seed: 1 });
    const lines = run(session, 8 * 60);
    expect(lines.some((l) => l.kind === 'pilot' && / taxiing on /.test(l.text))).toBe(true);
    expect(lines.some((l) => l.kind === 'pilot' && / clear of (27|36)/.test(l.text))).toBe(true);
  });

  it('runs KJFK on the 31s: departures check in, arrivals call clear of 31L or 31R; the same seed gives the same session', () => {
    const kjfk = loadAirport(kjfkBase, kjfkOverrides);
    const texts = (seed: number) => run(createSession(kjfk, { seed }), 10 * 60).map((l) => l.text);
    const one = texts(1);
    expect(one.filter((t) => / taxiing on /.test(t)).length).toBeGreaterThanOrEqual(2);
    expect(one.some((t) => / clear of 31[LR]/.test(t))).toBe(true);
    expect(texts(1)).toEqual(one);
    expect(texts(2)).not.toEqual(one);
    // Every KJFK terminal has a type that can push back since the ramp rework (swings into neighbouring stands).
    expect(startupLines(createSession(kjfk, { seed: 1 })).map((l) => l.text)).toEqual([]);
  }, 30_000);

  it("tells the player at the start which terminals have no traffic, and why (TEST's T2: its widebodies can't push back there)", () => {
    expect(startupLines(createSession(TEST, { seed: 1 }))).toEqual([
      { tick: 0, time: '0:00', kind: 'info', callsign: null, text: 'No traffic at T2: none of its airlines’ types can push back from a gate there' },
    ]);
  });

  it('runs no traffic at an airport without live traffic (KLGA), and says so', () => {
    const session = createSession(loadAirport(klgaBase, klgaOverrides), { seed: 1 });
    expect(startupLines(session).map((l) => l.text)).toEqual(['No live traffic at KLGA: the map only. Traffic runs at KJFK and TEST.']);
    run(session, 120);
    expect(drawnAircraft(session)).toEqual([]);
  });

  it('stops time when paused: no ticks, and the aircraft are drawn where they were', () => {
    const session = createSession(TEST, { seed: 1 });
    run(session, 120);
    session.controls.paused = true;
    const [tick, drawn] = [session.sim.world.tick, drawnAircraft(session)];
    for (let i = 0; i < 100; i++) advance(session, 0.2);
    expect(session.sim.world.tick).toBe(tick);
    expect(drawnAircraft(session)).toEqual(drawn);
  });

  it("labels each aircraft with where it's going: an arrival its terminal, a departure the departure runway", () => {
    const session = createSession(TEST, { seed: 1 });
    run(session, 4 * 60);
    const drawn = drawnAircraft(session);
    const roles = new Set(drawn.map((a) => a.role));
    expect(roles).toEqual(new Set(['arrival', 'departure']));
    for (const a of drawn) expect(a.destination).toBe(a.role === 'arrival' ? 'T1' : '27');
  });

  it("submits typed terse syntax: a parse error comes back with parseTerse's message and offset, and nothing is applied", () => {
    const session = createSession(TEST, { seed: 1 });
    const result = submit(session, 'DAL4 cross KE');
    expect(result).toEqual({ ok: false, error: { message: "expected runway after 'cross', got 'KE'", offset: 11 } });
    expect(drainEvents(session.sim)).toEqual([]);
  });

  it("requests a crossing for an aircraft (the T key), and tower's reply comes after its beat", () => {
    const session = createSession(TEST, { seed: 1 });
    let checkIn: LogLine | undefined;
    while (!checkIn && session.sim.world.tick < 10 * 60 * 10) checkIn = run(session, 0.8).find((l) => / taxiing on /.test(l.text));
    const callsign = checkIn?.callsign ?? '';
    expect(callsign).not.toBe('');
    const asked = requestCrossing(session, callsign);
    expect(asked.map((l) => [l.kind, l.text])).toEqual([['player', `${callsign} request-crossing`]]);
    const reply = run(session, 5).filter((l) => l.callsign === callsign);
    expect(reply.map((l) => l.kind)).toEqual(['tower']);
    expect(reply[0]?.text).toMatch(new RegExp(`^TWR: ${callsign} (cross|hold short|unable crossing)`));
  });

  it('applies a command, echoing it as the player, with the lines it causes right away', () => {
    const session = createSession(TEST, { seed: 1 });
    expect(submit(session, '  xyz1 hold ')).toEqual({
      ok: true,
      lines: [
        { tick: 0, time: '0:00', kind: 'player', callsign: 'XYZ1', text: 'xyz1 hold' },
        { tick: 0, time: '0:00', kind: 'unable', callsign: 'XYZ1', text: 'No aircraft XYZ1' },
      ],
    });
  });
});
