import { describe, expect, it } from 'vitest';
import type { Destination } from '../../sim/commands.ts';
import { destinationOf, type DestinationInput } from './destination.ts';

function cleared(to: Destination, role: DestinationInput['role'] = 'departure'): DestinationInput {
  return { role, clearance: { taxi: { to } }, final: null };
}

describe('destinationOf', () => {
  it("shows the clearance's runway", () => {
    expect(destinationOf(cleared({ kind: 'runway', name: '31L' }), { terminal: null, departureEnds: ['31L'] })).toBe('31L');
  });

  it("shows a ramp by name, 'the ramp' as the flight's terminal, and holding places and hangars by kind and name", () => {
    const context = { terminal: 'T4', departureEnds: ['31L'] };
    const cases: [Destination, string][] = [
      [{ kind: 'ramp', name: 'T8' }, 'T8'],
      [{ kind: 'ramp', name: null }, 'T4'],
      [{ kind: 'pad', name: null }, 'PAD'],
      [{ kind: 'pad', name: 'KILO' }, 'PAD KILO'],
      [{ kind: 'penalty-box', name: null }, 'PENALTY'],
      [{ kind: 'hardstand', name: 'SOUTH' }, 'HARDSTAND SOUTH'],
      [{ kind: 'hangar', name: null }, 'HANGAR'],
      [{ kind: 'hangar', name: '17' }, 'HANGAR 17'],
    ];
    for (const [to, label] of cases) expect(destinationOf(cleared(to, 'arrival'), context)).toBe(label);
    expect(destinationOf(cleared({ kind: 'ramp', name: null }, 'arrival'), { terminal: null, departureEnds: [] })).toBe('RAMP');
  });

  it('with no clearance: an arrival shows its terminal, else the runway it is landing on; a departure the departure runway', () => {
    const onFinal: DestinationInput = { role: 'arrival', clearance: null, final: { runwayEnd: '31R' } };
    expect(destinationOf(onFinal, { terminal: 'T4', departureEnds: ['31L'] })).toBe('T4');
    expect(destinationOf(onFinal, { terminal: null, departureEnds: ['31L'] })).toBe('31R');
    expect(destinationOf({ ...onFinal, final: null }, { terminal: null, departureEnds: ['31L'] })).toBe('');

    const atGate: DestinationInput = { role: 'departure', clearance: null, final: null };
    expect(destinationOf(atGate, { terminal: 'T4', departureEnds: ['31L'] })).toBe('31L');
    expect(destinationOf(atGate, { terminal: 'T4', departureEnds: ['31L', '4L'] })).toBe('31L/4L');
    expect(destinationOf(atGate, { terminal: 'T4', departureEnds: [] })).toBe('');
  });
});
