// The scripted twin of docs/phase1-manual-test.md (PLAN 1.13's acceptance): it plays the doc's
// steps on the doc's seed, exactly, through the session API the app uses. `submit` is what the
// console's Enter does; `requestCrossing` is what the T key does on a selected aircraft. It
// reacts only to the log lines Q sees, as the doc tells Q to. Keep the two in step: a change to
// one is a change to the other.

import { describe, expect, it } from 'vitest';
import kjfkBase from '../../../data/airports/KJFK.json' with { type: 'json' };
import kjfkOverrides from '../../../data/airports/KJFK.overrides.json' with { type: 'json' };
import { loadAirport } from '../../airport/load.ts';
import { getSession, getUnauthorizedCrossings } from '../../sim/sim.ts';
import { counterRows, scoreCounters } from './counters.ts';
import type { LogLine } from './event-log.ts';
import { advance, createSession, requestCrossing, submit, type Session } from './session.ts';

/** The doc's URL: `?airport=KJFK&seed=5`. */
const SEED = 5;
const DEP = 'WJA3571';
const ARR = 'ANA7953';

/**
 * The doc's steps, in the order their cue appears in the log: the line Q waits for, and what Q
 * then does (a typed command, or 'T': click the aircraft on the map and press T).
 */
const STEPS: { cue: RegExp; action: string }[] = [
  { cue: /^ANA7953 clear of 31R at D$/, action: 'ANA7953 taxi ramp T7 via W' },
  { cue: /^WJA3571 taxiing on G$/, action: 'WJA3571 taxi 31L via G' },
  { cue: /^ANA7953 holding short of 31R at W$/, action: 'T' },
  { cue: /^TWR: ANA7953 cross 31R at W approved$/, action: 'ANA7953 cross 31R' },
  { cue: /^WJA3571 holding short of 4L at G$/, action: 'T' },
  { cue: /^TWR: WJA3571 cross 4L at G approved$/, action: 'WJA3571 cross 4L' },
  { cue: /^ANA7953 at the T7 ramp entrance W$/, action: 'ANA7953 monitor ramp' },
  { cue: /^ANA7953 arrived at T7 gate \S+$/, action: '' },
  { cue: /^WJA3571 holding short of 31L at Z$/, action: 'WJA3571 monitor tower' },
  { cue: /^WJA3571 took off 31L$/, action: '' },
];

/** Plays the doc at 4× in 0.2 s frames (8 ticks each), as the app would. The log, and when each step's cue came. */
function play(): { session: Session; log: LogLine[]; cues: string[] } {
  const session = createSession(loadAirport(kjfkBase, kjfkOverrides), { seed: SEED, counters: scoreCounters() });
  session.controls.speed = 4;
  const log: LogLine[] = [];
  const cues: string[] = [];
  let next = 0;
  const act = (action: string, callsign: string) => {
    if (action === '') return;
    if (action === 'T') {
      log.push(...requestCrossing(session, callsign));
      return;
    }
    const result = submit(session, action);
    if (!result.ok) throw new Error(`the doc's command "${action}" doesn't parse: ${result.error.message}`);
    log.push(...result.lines);
  };
  // 20 sim minutes is about twice what the steps take.
  for (let t = 0; t < 20 * 60 && next < STEPS.length; t += 0.8) {
    for (const line of advance(session, 0.2)) {
      log.push(line);
      const step = STEPS[next];
      if (step && step.cue.test(line.text)) {
        cues.push(`${line.time} ${line.text}`);
        next += 1;
        act(step.action, line.callsign ?? '');
      }
    }
  }
  return { session, log, cues };
}

describe('the Phase 1 manual test (docs/phase1-manual-test.md), scripted', () => {
  it('KJFK seed 5: WJA3571 from T4 to takeoff on 31L and ANA7953 from 31R to its T7 gate, each crossing a runway with tower’s approval; the counters show 1 and 1', () => {
    const { session, log, cues } = play();
    // Every step's cue came, in the doc's order, at about the doc's times.
    expect(cues.map((c) => c.replace(/^\S+ /, ''))).toEqual([
      'ANA7953 clear of 31R at D',
      'WJA3571 taxiing on G',
      'ANA7953 holding short of 31R at W',
      'TWR: ANA7953 cross 31R at W approved',
      'WJA3571 holding short of 4L at G',
      'TWR: WJA3571 cross 4L at G approved',
      'ANA7953 at the T7 ramp entrance W',
      expect.stringMatching(/^ANA7953 arrived at T7 gate /),
      'WJA3571 holding short of 31L at Z',
      'WJA3571 took off 31L',
    ]);
    // The doc's times, as "m:ss": each within a minute of what the doc says.
    const doc = ['5:34', '6:17', '6:41', '6:44', '6:54', '6:57', '7:38', '8:34', '9:36', '10:58'];
    const seconds = (t: string) => t.split(':').reduce((s, x) => s * 60 + Number(x), 0);
    cues.forEach((c, i) => expect(Math.abs(seconds(c.split(' ')[0] ?? '') - seconds(doc[i] ?? '')), c).toBeLessThanOrEqual(60));

    // The scoring points: the departure at takeoff, the arrival at its gate.
    expect(session.sim.world.score.departures.map((m) => m.callsign)).toEqual([DEP]);
    expect(session.sim.world.score.arrivals.map((m) => m.callsign)).toEqual([ARR]);
    // The counters, as the panel shows them.
    const shown = counterRows(session.counters.read());
    expect(shown.slice(0, 3)).toEqual([
      { label: 'Departures', value: '1' },
      { label: 'Arrivals', value: '1' },
      { label: 'Total', value: '2' },
    ]);
    // Both crossings were approved before they were made, and the session is still on.
    expect(getUnauthorizedCrossings(session.sim)).toEqual([]);
    expect(getSession(session.sim)).toEqual({ state: 'running' });
    // Nothing the doc's player typed was refused.
    expect(log.filter((l) => l.kind === 'unable' && (l.callsign === DEP || l.callsign === ARR))).toEqual([]);
  }, 60_000);
});
