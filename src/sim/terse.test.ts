import { describe, expect, it } from 'vitest';
import type { Command, Instruction } from './commands.ts';
import { parseTerse, type ParseError } from './terse.ts';

function parse(input: string): Command {
  const result = parseTerse(input);
  if (!result.ok) throw new Error(`expected '${input}' to parse, got: ${result.error.message}`);
  return result.command;
}

/** The instructions of an addressed transmission. */
function instructions(input: string, callsign: string): Instruction[] {
  const command = parse(input);
  expect(command).toMatchObject({ type: 'transmission', callsign });
  if (command.type !== 'transmission') throw new Error('not a transmission');
  return command.instructions;
}

function errorOf(input: string): ParseError {
  const result = parseTerse(input);
  if (result.ok) throw new Error(`expected '${input}' to fail, got ${JSON.stringify(result.command)}`);
  return result.error;
}

describe('PLAN.md examples (shown to Q; must parse exactly as written)', () => {
  it('DAL4 taxi 31L via A R:KE hs B', () => {
    expect(parse('DAL4 taxi 31L via A R:KE hs B')).toEqual({
      type: 'transmission',
      callsign: 'DAL4',
      instructions: [
        {
          type: 'taxi',
          to: { kind: 'runway', name: '31L' },
          via: [
            { taxiway: 'A', turn: null },
            { taxiway: 'KE', turn: 'right' },
          ],
          holdShort: [{ kind: 'taxiway', name: 'B' }],
        },
      ],
    });
  });

  it('UAE202 taxi ramp T4 via L:B KE', () => {
    expect(parse('UAE202 taxi ramp T4 via L:B KE')).toEqual({
      type: 'transmission',
      callsign: 'UAE202',
      instructions: [
        {
          type: 'taxi',
          to: { kind: 'ramp', name: 'T4' },
          via: [
            { taxiway: 'B', turn: 'left' },
            { taxiway: 'KE', turn: null },
          ],
          holdShort: [],
        },
      ],
    });
  });

  it('DAL4 cross 31R at KE', () => {
    expect(parse('DAL4 cross 31R at KE')).toEqual({
      type: 'transmission',
      callsign: 'DAL4',
      instructions: [{ type: 'cross', runways: ['31R'], at: 'KE' }],
    });
  });

  it('JBU1123 hold', () => {
    expect(parse('JBU1123 hold')).toEqual({
      type: 'transmission',
      callsign: 'JBU1123',
      instructions: [{ type: 'hold-position' }],
    });
  });

  it('AFR23 monitor tower', () => {
    expect(parse('AFR23 monitor tower')).toEqual({
      type: 'transmission',
      callsign: 'AFR23',
      instructions: [{ type: 'handoff', mode: 'monitor', facility: 'tower', frequency: null }],
    });
  });
});

describe('C1/C2/C6 taxi', () => {
  it('turn directions on any route item, L: and R:', () => {
    expect(instructions('DLH405 taxi 31L via L:A R:KE', 'DLH405')).toEqual([
      {
        type: 'taxi',
        to: { kind: 'runway', name: '31L' },
        via: [
          { taxiway: 'A', turn: 'left' },
          { taxiway: 'KE', turn: 'right' },
        ],
        holdShort: [],
      },
    ]);
  });

  it('several hold-shorts in one clearance, taxiways and runways, in spoken order', () => {
    expect(instructions('DLH405 taxi 31L via L:A R:KE hs 31R K', 'DLH405')).toEqual([
      {
        type: 'taxi',
        to: { kind: 'runway', name: '31L' },
        via: [
          { taxiway: 'A', turn: 'left' },
          { taxiway: 'KE', turn: 'right' },
        ],
        holdShort: [
          { kind: 'runway', name: '31R' },
          { kind: 'taxiway', name: 'K' },
        ],
      },
    ]);
  });

  it('an unnamed ramp is the aircraft\'s own', () => {
    expect(instructions('JBU387 taxi ramp via KF R:A', 'JBU387')).toEqual([
      {
        type: 'taxi',
        to: { kind: 'ramp', name: null },
        via: [
          { taxiway: 'KF', turn: null },
          { taxiway: 'A', turn: 'right' },
        ],
        holdShort: [],
      },
    ]);
  });

  it('C6: exit the departure line onto a pad, unnamed or named', () => {
    expect(instructions('AFR23 taxi pad via L:KD', 'AFR23')).toEqual([
      { type: 'taxi', to: { kind: 'pad', name: null }, via: [{ taxiway: 'KD', turn: 'left' }], holdShort: [] },
    ]);
    expect(instructions('AFR23 taxi pad P2 via L:KD', 'AFR23')).toEqual([
      { type: 'taxi', to: { kind: 'pad', name: 'P2' }, via: [{ taxiway: 'KD', turn: 'left' }], holdShort: [] },
    ]);
  });

  it('C6: the penalty box', () => {
    expect(instructions('VIR3 taxi penalty via KF B', 'VIR3')).toEqual([
      {
        type: 'taxi',
        to: { kind: 'penalty-box', name: null },
        via: [
          { taxiway: 'KF', turn: null },
          { taxiway: 'B', turn: null },
        ],
        holdShort: [],
      },
    ]);
  });
});

describe('hardstands and hangars (PLAN 1.5 stage b)', () => {
  it('taxi to the hardstand, unnamed or named', () => {
    expect(instructions('N123AB taxi hardstand via Q Q5', 'N123AB')).toEqual([
      { type: 'taxi', to: { kind: 'hardstand', name: null }, via: [{ taxiway: 'Q', turn: null }, { taxiway: 'Q5', turn: null }], holdShort: [] },
    ]);
    expect(instructions('N123AB taxi hardstand south via Q5', 'N123AB')).toEqual([
      { type: 'taxi', to: { kind: 'hardstand', name: 'SOUTH' }, via: [{ taxiway: 'Q5', turn: null }], holdShort: [] },
    ]);
  });
});

describe('hangars (PLAN 1.5 stage b)', () => {
  it("taxi to the company hangar (unnamed: the aircraft's own company's) or a named one", () => {
    expect(instructions('DAL4 taxi hangar via A KF', 'DAL4')).toEqual([
      { type: 'taxi', to: { kind: 'hangar', name: null }, via: [{ taxiway: 'A', turn: null }, { taxiway: 'KF', turn: null }], holdShort: [] },
    ]);
    expect(instructions('DAL4 taxi hangar #17 via R:Q2, hold', 'DAL4')).toEqual([
      { type: 'taxi', to: { kind: 'hangar', name: '17' }, via: [{ taxiway: 'Q2', turn: 'right' }], holdShort: [] },
      { type: 'hold-position' },
    ]);
  });
});

describe('C3 hold short', () => {
  it('standalone, a runway', () => {
    expect(instructions('ASA93 hs 4R', 'ASA93')).toEqual([
      { type: 'hold-short', target: { kind: 'runway', name: '4R' } },
    ]);
  });

  it('standalone with several targets gives one instruction per target', () => {
    expect(instructions('ASA93 hs B 4R', 'ASA93')).toEqual([
      { type: 'hold-short', target: { kind: 'taxiway', name: 'B' } },
      { type: 'hold-short', target: { kind: 'runway', name: '4R' } },
    ]);
  });

  it('appended after a crossing', () => {
    expect(instructions('SWR17 cross 22R at Y, hs B', 'SWR17')).toEqual([
      { type: 'cross', runways: ['22R'], at: 'Y' },
      { type: 'hold-short', target: { kind: 'taxiway', name: 'B' } },
    ]);
  });
});

describe('C4 hold position / continue', () => {
  it('hold and continue', () => {
    expect(instructions('BAW175 hold', 'BAW175')).toEqual([{ type: 'hold-position' }]);
    expect(instructions('IBE626 continue', 'IBE626')).toEqual([{ type: 'continue' }]);
  });
});

describe('C5 cross', () => {
  it('without a taxiway', () => {
    expect(instructions('DAL4 cross 31R', 'DAL4')).toEqual([{ type: 'cross', runways: ['31R'], at: null }]);
  });

  it('several runways in one clearance, each named', () => {
    expect(instructions('DAL4 cross 4L 4R at J', 'DAL4')).toEqual([
      { type: 'cross', runways: ['4L', '4R'], at: 'J' },
    ]);
  });

  it('followed by a new taxi clearance', () => {
    expect(instructions('QTR701 cross 31R at KE, taxi 31L via K', 'QTR701')).toEqual([
      { type: 'cross', runways: ['31R'], at: 'KE' },
      { type: 'taxi', to: { kind: 'runway', name: '31L' }, via: [{ taxiway: 'K', turn: null }], holdShort: [] },
    ]);
  });
});

describe('C7 handoff', () => {
  it('contact ramp', () => {
    expect(instructions('UAE202 contact ramp', 'UAE202')).toEqual([
      { type: 'handoff', mode: 'contact', facility: 'ramp', frequency: null },
    ]);
  });

  it('with a frequency; trailing zeros dropped', () => {
    expect(instructions('BAW175 monitor tower 119.1', 'BAW175')).toEqual([
      { type: 'handoff', mode: 'monitor', facility: 'tower', frequency: '119.1' },
    ]);
    expect(instructions('BAW175 contact tower 123.900', 'BAW175')).toEqual([
      { type: 'handoff', mode: 'contact', facility: 'tower', frequency: '123.9' },
    ]);
    expect(instructions('BAW175 contact ramp 125.05', 'BAW175')).toEqual([
      { type: 'handoff', mode: 'contact', facility: 'ramp', frequency: '125.05' },
    ]);
  });
});

describe('C8 correction', () => {
  const none = { type: 'correction', to: null, via: null, turns: [], holdShort: null, cross: null };

  it('missed hold-short: replaces the hold-short list', () => {
    expect(instructions('DAL4 neg hs B', 'DAL4')).toEqual([{ ...none, holdShort: [{ kind: 'taxiway', name: 'B' }] }]);
  });

  it('wrong turn: fixes one route item', () => {
    expect(instructions('DLH405 neg turn R:KE', 'DLH405')).toEqual([
      { ...none, turns: [{ taxiway: 'KE', turn: 'right' }] },
    ]);
  });

  it('wrong runway: replaces the destination', () => {
    expect(instructions('AAL100 neg to 31L', 'AAL100')).toEqual([{ ...none, to: { kind: 'runway', name: '31L' } }]);
  });

  it('wrong taxiways: replaces route and hold-shorts together', () => {
    expect(instructions('EIN104 neg via A J hs B', 'EIN104')).toEqual([
      {
        ...none,
        via: [
          { taxiway: 'A', turn: null },
          { taxiway: 'J', turn: null },
        ],
        holdShort: [{ kind: 'taxiway', name: 'B' }],
      },
    ]);
  });

  it('wrong crossing: replaces the crossing clearance', () => {
    expect(instructions('DAL4 neg cross 31R at KE', 'DAL4')).toEqual([
      { ...none, cross: { runways: ['31R'], at: 'KE' } },
    ]);
  });

  it("a comma ends the correction; 'hs' after it is a separate hold-short", () => {
    expect(instructions('DAL4 neg turn R:KE, hs B, monitor tower', 'DAL4')).toEqual([
      { ...none, turns: [{ taxiway: 'KE', turn: 'right' }] },
      { type: 'hold-short', target: { kind: 'taxiway', name: 'B' } },
      { type: 'handoff', mode: 'monitor', facility: 'tower', frequency: null },
    ]);
  });
});

describe('C9 ATIS', () => {
  it('letter only, and with altimeter', () => {
    expect(instructions('JBU615 atis P', 'JBU615')).toEqual([{ type: 'atis', letter: 'P', altimeter: null }]);
    expect(instructions('JBU615 atis P alt 2992', 'JBU615')).toEqual([
      { type: 'atis', letter: 'P', altimeter: '2992' },
    ]);
  });

  it('combined with a taxi clearance', () => {
    expect(instructions('DAL2340 atis P alt 2992, taxi 31L via A KD hs B', 'DAL2340')).toEqual([
      { type: 'atis', letter: 'P', altimeter: '2992' },
      {
        type: 'taxi',
        to: { kind: 'runway', name: '31L' },
        via: [
          { taxiway: 'A', turn: null },
          { taxiway: 'KD', turn: null },
        ],
        holdShort: [{ kind: 'taxiway', name: 'B' }],
      },
    ]);
  });
});

describe('C10 say again', () => {
  it('to a known aircraft', () => {
    expect(instructions('KLM644 say-again', 'KLM644')).toEqual([{ type: 'say-again' }]);
  });

  it('to an unknown station', () => {
    expect(parse('? say-again')).toEqual({
      type: 'transmission',
      callsign: null,
      instructions: [{ type: 'say-again' }],
    });
  });
});

describe('C12 delay and restriction advisories', () => {
  it('ground stop with expected delay', () => {
    expect(instructions('RPA3560 ground-stop BOS, delay 20', 'RPA3560')).toEqual([
      { type: 'ground-stop', destination: 'BOS' },
      { type: 'expect-delay', minutes: 20 },
    ]);
  });

  it('release time, as HHMM or HH:MM', () => {
    expect(instructions('JBU615 release 1452', 'JBU615')).toEqual([{ type: 'release-time', time: '14:52' }]);
    expect(instructions('JBU615 release 09:05', 'JBU615')).toEqual([{ type: 'release-time', time: '09:05' }]);
  });

  it('hold for release', () => {
    expect(instructions('UAL1416 hold-for-release, delay 15', 'UAL1416')).toEqual([
      { type: 'hold-for-release' },
      { type: 'expect-delay', minutes: 15 },
    ]);
  });

  it('ground stop, then out of the line to the penalty box', () => {
    expect(instructions('DAL1204 ground-stop ATL, taxi penalty via R:KC', 'DAL1204')).toEqual([
      { type: 'ground-stop', destination: 'ATL' },
      { type: 'taxi', to: { kind: 'penalty-box', name: null }, via: [{ taxiway: 'KC', turn: 'right' }], holdShort: [] },
    ]);
  });
});

describe('crossing request (key press, not a radio call)', () => {
  it('for the next crossing on the route', () => {
    expect(parse('DAL4 request-crossing')).toEqual({ type: 'crossing-request', callsign: 'DAL4', runway: null });
  });

  it('for a specific runway', () => {
    expect(parse('DAL4 request-crossing 04L')).toEqual({ type: 'crossing-request', callsign: 'DAL4', runway: '4L' });
  });
});

describe('runway normalization', () => {
  it('drops a leading zero and uppercases L/C/R', () => {
    expect(instructions('DAL4 cross 04L 4r 13 09C', 'DAL4')).toEqual([
      { type: 'cross', runways: ['4L', '4R', '13', '9C'], at: null },
    ]);
    expect(instructions('DAL4 taxi 04l via A', 'DAL4')).toEqual([
      { type: 'taxi', to: { kind: 'runway', name: '4L' }, via: [{ taxiway: 'A', turn: null }], holdShort: [] },
    ]);
  });
});

describe('numeric lanes vs runways (LGA has lanes 1–19 and runways 4/22, 13/31)', () => {
  it("a bare number is a runway: 'hs 13' is runway 13", () => {
    expect(instructions('DAL4 hs 13', 'DAL4')).toEqual([
      { type: 'hold-short', target: { kind: 'runway', name: '13' } },
    ]);
  });

  it("'#13' is the lane named 13", () => {
    expect(instructions('DAL4 hs #13', 'DAL4')).toEqual([
      { type: 'hold-short', target: { kind: 'taxiway', name: '13' } },
    ]);
  });

  it('numeric lanes in a route, with and without a turn', () => {
    expect(instructions('AAL22 taxi ramp B via A R:#13 #4 hs 4 #4', 'AAL22')).toEqual([
      {
        type: 'taxi',
        to: { kind: 'ramp', name: 'B' },
        via: [
          { taxiway: 'A', turn: null },
          { taxiway: '13', turn: 'right' },
          { taxiway: '4', turn: null },
        ],
        holdShort: [
          { kind: 'runway', name: '4' },
          { kind: 'taxiway', name: '4' },
        ],
      },
    ]);
  });

  it('a bare number in a route is rejected, never read as a lane', () => {
    expect(errorOf('AAL22 taxi ramp B via A 13').message).toBe(
      "expected taxiway after 'A', got '13' (a bare number is a runway; write a name that starts with a digit as '#13')",
    );
  });

  it('a lane is rejected where a runway is required', () => {
    expect(errorOf('AAL22 cross #13').message).toBe("expected runway after 'cross', got '#13'");
  });

  it("'#' also escapes a name spelled like a keyword", () => {
    expect(instructions('DAL4 taxi 31L via #VIA', 'DAL4')).toEqual([
      { type: 'taxi', to: { kind: 'runway', name: '31L' }, via: [{ taxiway: 'VIA', turn: null }], holdShort: [] },
    ]);
  });
});

describe('case and spacing', () => {
  it('keywords, turn prefixes and names are case-insensitive; names come out uppercase', () => {
    expect(parse('dal4 TAXI 31l Via a r:ke HS b')).toEqual(parse('DAL4 taxi 31L via A R:KE hs B'));
  });

  it('extra spaces and commas without spaces are fine', () => {
    expect(parse('  SWR17   cross 22R at Y,hs B  ')).toEqual(parse('SWR17 cross 22R at Y, hs B'));
  });
});

describe('malformed input gives a specific error', () => {
  const cases: [input: string, message: string][] = [
    ['DAL4 cross KE', "expected runway after 'cross', got 'KE'"],
    ['DAL4 cross 31R KE', "expected runway or 'at' after '31R', got 'KE'"],
    ['DAL4 cross 31R at', "expected taxiway after 'at', got end of input"],
    ['DAL4 cross 31R at KE hs B', "expected ',' before 'hs' (separate instructions with commas)"],
    ['DAL4 taxi 31L A R:KE', "expected 'via' after '31L', got 'A'"],
    ['DAL4 taxi via A', "expected runway, 'ramp', 'pad', 'penalty', 'hardstand' or 'hangar' after 'taxi', got 'via'"],
    [
      'DAL4 taxi hangar 17 via A',
      "expected hangar name after 'hangar', got '17' (a bare number is a runway; write a name that starts with a digit as '#17')",
    ],
    ['DAL4 taxi hardstand south', "expected 'via' after 'south', got end of input"],
    ['DAL4 taxi hangar L:A via B', "a turn (L:/R:) is only allowed on route items, got 'L:A' after 'hangar'"],
    ['DAL4 taxi 31L via', "expected taxiway after 'via', got end of input"],
    ['DAL4 taxi 31L via A, R:KE', "expected an instruction after ',', got 'R:KE'"],
    ['DAL4 taxi 31L via A,', "expected an instruction after ',', got end of input"],
    ['DAL4 taxi 31L via X:KE', "unknown turn 'X:' in 'X:KE' (use L: or R:)"],
    ['DAL4 taxi 31L via L:', "expected taxiway after 'L:' in 'L:'"],
    ['DAL4 taxi 31L via A hs', "expected taxiway or runway after 'hs', got end of input"],
    [
      'DAL4 taxi 31L via A hs B hs K',
      "duplicate 'hs' in taxi clearance; list every hold-short after one 'hs' (e.g. 'hs B 31R')",
    ],
    [
      'DAL4 taxi ramp 4 via A',
      "expected ramp name after 'ramp', got '4' (a bare number is a runway; write a name that starts with a digit as '#4')",
    ],
    ['DAL4 taxi 37 via A', "invalid runway '37': the number must be 1–36"],
    ['DAL4 taxi 0L via A', "invalid runway '0L': the number must be 1–36"],
    ['DAL4 taxi 310 via A', "invalid runway '310': expected 1–36 with optional L, C or R (e.g. 31L)"],
    ['DAL4 hs L:B', "a turn (L:/R:) is only allowed on route items, got 'L:B' after 'hs'"],
    ['DAL4 hold short B', "unexpected 'short' after 'hold'"],
    ['DAL4 monitor ground', "expected 'tower' or 'ramp' after 'monitor', got 'ground'"],
    ['DAL4 monitor tower 1191', "expected frequency like 119.1 after 'tower', got '1191'"],
    ['DAL4 monitor tower 150.2', "frequency '150.2' is outside the airband (118.0–136.975)"],
    ['DAL4 neg B', "expected 'to', 'via', 'turn', 'hs' or 'cross' after 'neg', got 'B'"],
    ['DAL4 neg', "expected 'to', 'via', 'turn', 'hs' or 'cross' after 'neg', got end of input"],
    ['DAL4 neg via A turn R:KE', "a correction can't have both 'via' and 'turn'; put the turns in the 'via' route"],
    ['DAL4 neg turn KE', "expected taxiway with a turn (e.g. R:KE) after 'turn', got 'KE'"],
    ['DAL4 neg hs B hs K', "duplicate 'hs' in correction"],
    ['DAL4 atis PA', "expected ATIS letter (A–Z) after 'atis', got 'PA'"],
    ['DAL4 atis P alt 29.92', "expected altimeter as four digits (e.g. 2992) after 'alt', got '29.92'"],
    ['DAL4 ground-stop', "expected destination after 'ground-stop', got end of input"],
    ['DAL4 release 252', "expected release time as HHMM or HH:MM (e.g. 1452) after 'release', got '252'"],
    ['DAL4 release 2552', "invalid release time '2552': hours must be 00–23"],
    ['DAL4 release 1460', "invalid release time '1460': minutes must be 00–59"],
    ['DAL4 delay twenty', "expected delay in whole minutes after 'delay', got 'twenty'"],
    ['DAL4 delay 0', "delay must be at least 1 minute, got '0'"],
    ['', 'empty command: expected a callsign (e.g. DAL4)'],
    ['DAL4', "expected an instruction after 'DAL4', got end of input"],
    ['DAL4 taxii 31L via A', "expected an instruction after 'DAL4', got 'taxii'"],
    ['taxi 31L via A', "expected callsign (e.g. DAL4), got 'taxi'"],
    ['JBU taxi 31L via A', "expected callsign (e.g. DAL4), got 'JBU'"],
    ['? taxi 31L via A', "only 'say-again' can be addressed to an unknown station '?', got 'taxi'"],
    ['? say-again, hold', "only 'say-again' can be addressed to an unknown station '?', got ','"],
    [
      'DAL4 request-crossing, hold',
      "'request-crossing' is a key-press action, not a radio call; it can't be combined with other input, got ','",
    ],
    [
      'DAL4 hold, request-crossing',
      "'request-crossing' is a key-press action, not a radio call; it can't be combined with other input",
    ],
  ];

  it.each(cases)('%s', (input, message) => {
    expect(errorOf(input).message).toBe(message);
  });

  it('points at the offending token, or the end of input', () => {
    expect(errorOf('DAL4 cross KE').offset).toBe(11);
    expect(errorOf('DAL4 taxi 31L via R:13').offset).toBe(20);
    expect(errorOf('DAL4').offset).toBe(4);
  });

  it('never throws on junk', () => {
    const junk = [' ', ',', ',,,', '?', '#', 'DAL4 #', 'DAL4 taxi #', 'DAL4 ::::', 'DAL4 L:R:B', '✈️ taxi', 'DAL4 taxi 31L via A'.repeat(50)];
    for (const input of junk) {
      const result = parseTerse(input);
      expect(result.ok, input).toBe(false);
    }
  });
});
