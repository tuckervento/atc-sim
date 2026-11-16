// The session-ended banner and log line (session-end.ts, PLAN 1.13 over 1.12's rules): what
// ended it, which aircraft, where, and whose aircraft they were.

import { describe, expect, it } from 'vitest';
import type { RuleParty, SessionEndCause } from '../../sim/sim.ts';
import { sessionEnd, type EndContext } from './session-end.ts';

const CONTEXT: EndContext = {
  tickHz: 10,
  runwayName: (id) => ({ '13R/31L': '31L', '4L/22R': '4L' })[id] ?? `?${id}`,
  nearestTaxiway: (p) => (p[0] < 0 ? 'KE' : null),
};

function party(callsign: string, over: Partial<RuleParty> = {}): RuleParty {
  return { callsign, type: 'A320', controller: 'ground', status: 'taxiing', speedMps: 5, location: { kind: 'edge', edge: 'e1' }, nose: [-10, 0], runways: [], blockedBy: null, ...over };
}

describe('sessionEnd', () => {
  it('a collision on a runway: both aircraft with their type, controller and status; the runway and the nearest taxiway; the origin explained', () => {
    const cause: SessionEndCause = {
      kind: 'collision',
      aircraft: [party('DAL4', { status: 'taxiing' }), party('JBU9', { type: 'B738', controller: 'tower', status: 'taking-off', speedMps: 60 })],
      point: [-5, 0],
      runways: ['13R/31L'],
      origin: 'mixed',
    };
    expect(sessionEnd({ tick: 7240, cause }, CONTEXT)).toEqual({
      title: 'Session over at 12:04: collision',
      details: [
        'DAL4 (A320, yours, taxiing) and JBU9 (B738, tower’s, taking off) collided on 31L, near KE.',
        'Origin: mixed — one was yours, the other tower’s or ramp’s.',
      ],
      log: 'SESSION OVER: collision of DAL4 and JBU9 on 31L, near KE (origin: mixed)',
    });
  });

  it('a gridlock off the runways: the aircraft in the cycle, since when, near which taxiway; a sim origin says it is a sim bug', () => {
    const cause: SessionEndCause = { kind: 'gridlock', aircraft: [party('DAL4'), party('JBU9'), party('AAL1')], sinceTick: 6640, origin: 'sim' };
    expect(sessionEnd({ tick: 7240, cause }, CONTEXT)).toEqual({
      title: 'Session over at 12:04: gridlock',
      details: ['DAL4, JBU9 and AAL1 have blocked each other since 11:04, near KE.', 'Origin: sim — none of them was yours: a bug in the simulation.'],
      log: 'SESSION OVER: gridlock of DAL4, JBU9 and AAL1, near KE (origin: sim)',
    });
  });

  it('with no named taxiway near, it says neither; a player origin says they were all yours', () => {
    const cause: SessionEndCause = { kind: 'collision', aircraft: [party('DAL4', { nose: [10, 0] }), party('JBU9', { nose: [12, 0] })], point: [11, 0], runways: [], origin: 'player' };
    expect(sessionEnd({ tick: 10, cause }, CONTEXT).details).toEqual(['DAL4 (A320, yours, taxiing) and JBU9 (A320, yours, taxiing) collided.', 'Origin: player — both were yours.']);
  });
});
