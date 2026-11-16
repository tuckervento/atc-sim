import { describe, expect, it } from 'vitest';
import { emptyHistory, recall, remember, type History } from './console.ts';
import { withCallsign } from './console.ts';

describe('history', () => {
  /** Up/down from `h` with `typed` in the input: the new history and what the input shows. */
  function press(h: History, key: 'up' | 'down', typed: string): [History, string] {
    const r = recall(h, key, typed);
    return [r.history, r.text];
  }

  it('recalls earlier input with up, later with down, and the draft past the newest', () => {
    let h = remember(remember(remember(emptyHistory(), 'DAL4 hold'), 'DAL4 continue'), 'UAL9 taxi 27 via A');
    let text: string;
    [h, text] = press(h, 'up', 'JBU1 ta');
    expect(text).toBe('UAL9 taxi 27 via A');
    [h, text] = press(h, 'up', text);
    expect(text).toBe('DAL4 continue');
    [h, text] = press(h, 'up', text);
    expect(text).toBe('DAL4 hold');
    [h, text] = press(h, 'up', text);
    expect(text).toBe('DAL4 hold');
    [h, text] = press(h, 'down', text);
    expect(text).toBe('DAL4 continue');
    [h, text] = press(h, 'down', text);
    [h, text] = press(h, 'down', text);
    expect(text).toBe('JBU1 ta');
    [, text] = press(h, 'down', text);
    expect(text).toBe('JBU1 ta');
  });

  it("doesn't record blank input or an immediate repeat, and starts recall afresh after each entry", () => {
    let h = remember(remember(remember(remember(emptyHistory(), 'DAL4 hold'), '  '), 'DAL4 hold'), ' DAL4 continue ');
    expect(h.entries).toEqual(['DAL4 hold', 'DAL4 continue']);
    h = recall(h, 'up', '').history;
    h = remember(h, 'UAL9 hold');
    expect(recall(h, 'up', '').text).toBe('UAL9 hold');
    expect(recall(emptyHistory(), 'up', 'typed').text).toBe('typed');
  });
});

describe('withCallsign', () => {
  it("puts the selected aircraft's callsign first: in an empty input, in place of another callsign, or before an instruction", () => {
    expect(withCallsign('', 'DAL4')).toBe('DAL4 ');
    expect(withCallsign('   ', 'DAL4')).toBe('DAL4 ');
    expect(withCallsign('UAL9 ', 'DAL4')).toBe('DAL4 ');
    expect(withCallsign('ual9 taxi 27 via A', 'DAL4')).toBe('DAL4 taxi 27 via A');
    expect(withCallsign('? say-again', 'DAL4')).toBe('DAL4 say-again');
    expect(withCallsign('taxi 27 via A', 'DAL4')).toBe('DAL4 taxi 27 via A');
  });
});
