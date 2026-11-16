import { describe, expect, it } from 'vitest';
import { counterRows, NO_COUNTERS } from './counters.ts';

describe('counterRows', () => {
  it('shows a placeholder in every row until score.ts is wired (PLAN 1.12)', () => {
    expect(NO_COUNTERS.read()).toBeNull();
    expect(counterRows(null)).toEqual([
      { label: 'Departures', value: '—' },
      { label: 'Arrivals', value: '—' },
      { label: 'Total', value: '—' },
      { label: 'Rate /h', value: '—' },
      { label: 'Peak 15 min /h', value: '—' },
    ]);
  });

  it('shows the counts, their total, and the rates to one decimal, once wired', () => {
    expect(counterRows({ departures: 3, arrivals: 2, ratePerHour: 12.345, peak15PerHour: 20 }).map((r) => r.value)).toEqual(['3', '2', '5', '12.3', '20.0']);
    expect(counterRows({ departures: 0, arrivals: 0, ratePerHour: null, peak15PerHour: null }).map((r) => r.value)).toEqual(['0', '0', '0', '—', '—']);
  });
});
