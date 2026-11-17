import { describe, expect, it } from 'vitest';
import { hotkeyFor, type KeyPress } from './hotkeys.ts';

const key = (k: string, more: Partial<KeyPress> = {}): KeyPress => ({ key: k, inTextField: false, ctrl: false, meta: false, alt: false, repeat: false, ...more });

describe('hotkeyFor', () => {
  it('T requests a crossing, P pauses, Escape deselects, Enter goes to the console, either case', () => {
    expect(hotkeyFor(key('t'))).toBe('request-crossing');
    expect(hotkeyFor(key('T'))).toBe('request-crossing');
    expect(hotkeyFor(key('p'))).toBe('toggle-pause');
    expect(hotkeyFor(key('P'))).toBe('toggle-pause');
    expect(hotkeyFor(key('Escape'))).toBe('deselect');
    // Q (BACKLOG): "pressing enter should switch to the text box if it doesn't have focus".
    expect(hotkeyFor(key('Enter'))).toBe('focus-console');
    expect(hotkeyFor(key('x'))).toBeNull();
    // Space is the PRD's push-to-talk placeholder, so it isn't pause.
    expect(hotkeyFor(key(' '))).toBeNull();
  });

  it('gives nothing while typing in the console, with a modifier held (the browser keeps Cmd+P, Ctrl+T), or on auto-repeat', () => {
    for (const k of ['t', 'p', 'Escape', 'Enter']) {
      expect(hotkeyFor(key(k, { inTextField: true }))).toBeNull();
      expect(hotkeyFor(key(k, { ctrl: true }))).toBeNull();
      expect(hotkeyFor(key(k, { meta: true }))).toBeNull();
      expect(hotkeyFor(key(k, { alt: true }))).toBeNull();
      expect(hotkeyFor(key(k, { repeat: true }))).toBeNull();
    }
  });
});
