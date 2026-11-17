// The game's keys (PRD §5 controls; PLAN 1.13). Pure: a key press in, an action or nothing out.
// - T: request a runway crossing for the selected aircraft (PRD §4.5).
// - P: pause and resume. Not Space: that's the PRD's push-to-talk placeholder.
// - Escape: deselect.
// - Enter: back to the console (Q: "pressing enter should switch to the text box if it doesn't
//   have focus"). In the console, Enter applies the command; the console handles that itself.

export type Hotkey = 'request-crossing' | 'toggle-pause' | 'deselect' | 'focus-console';

/** The parts of a KeyboardEvent this reads. */
export interface KeyPress {
  key: string;
  /** Focus is in a text input (the console): typing there is text, not hotkeys. */
  inTextField: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  /** Held down, auto-repeating. */
  repeat: boolean;
}

export function hotkeyFor(press: KeyPress): Hotkey | null {
  if (press.inTextField || press.ctrl || press.meta || press.alt || press.repeat) return null;
  switch (press.key) {
    case 't':
    case 'T':
      return 'request-crossing';
    case 'p':
    case 'P':
      return 'toggle-pause';
    case 'Escape':
      return 'deselect';
    case 'Enter':
      return 'focus-console';
    default:
      return null;
  }
}
