// The dev console's pure parts (PLAN 1.13): pre-filling the selected aircraft's callsign, and
// recalling earlier input with the arrow keys. Parsing is parseTerse's (src/sim/terse.ts).

/** Earlier input, oldest first, and where up/down recall is. */
export interface History {
  entries: string[];
  /** The entry shown, while recalling. null: not recalling; the input holds the player's own text. */
  at: number | null;
  /** What the player had typed when recall began, given back past the newest entry. */
  draft: string;
}

export function emptyHistory(): History {
  return { entries: [], at: null, draft: '' };
}

/** After entering `line`: it's the newest entry (unless blank, or the same as the newest), and recall starts afresh. */
export function remember(history: History, line: string): History {
  const text = line.trim();
  const entries = text === '' || history.entries.at(-1) === text ? history.entries : [...history.entries, text];
  return { entries, at: null, draft: '' };
}

/** Up: the entry before the one shown (the newest, to start). Down: the one after, then the draft. */
export function recall(history: History, key: 'up' | 'down', typed: string): { history: History; text: string } {
  const { entries, at } = history;
  const draft = at === null ? typed : history.draft;
  if (key === 'up') {
    if (entries.length === 0) return { history, text: typed };
    const next = at === null ? entries.length - 1 : Math.max(0, at - 1);
    return { history: { entries, at: next, draft }, text: entries[next] ?? typed };
  }
  if (at === null) return { history, text: typed };
  if (at + 1 >= entries.length) return { history: { entries, at: null, draft: '' }, text: draft };
  return { history: { entries, at: at + 1, draft }, text: entries[at + 1] ?? typed };
}

/** A callsign as terse.ts reads one (letter first, letters and digits, at least one digit), or '?'. */
const CALLSIGN = /^(\?|[A-Za-z][A-Za-z0-9]*[0-9][A-Za-z0-9]*)$/;

/**
 * `input` addressed to `callsign`: its first word replaced if that's a callsign (or '?'),
 * else `callsign` put before it. Ends with a space after the callsign when that's all there is.
 */
export function withCallsign(input: string, callsign: string): string {
  const words = input.trim().split(/\s+/).filter((w) => w !== '');
  const rest = words[0] !== undefined && CALLSIGN.test(words[0]) ? words.slice(1) : words;
  return `${callsign} ${rest.join(' ')}`;
}
