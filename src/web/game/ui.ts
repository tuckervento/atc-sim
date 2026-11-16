// The game's side panel (PLAN 1.13): sim clock, pause and speed, the live counters' slot, the
// event log and the dev console. DOM only, kept thin: what to show comes from the pure modules
// (counters.ts, event-log.ts, console.ts); main.ts wires it to the session.

import type { ParseError } from '../../sim/terse.ts';
import { emptyHistory, recall, remember, type History } from './console.ts';
import type { CounterRow } from './counters.ts';
import type { LogLine } from './event-log.ts';

/** The log keeps this many lines on the page; older ones are dropped. */
const LOG_LIMIT = 500;
export const SPEEDS = [1, 2, 4] as const;

export interface SidePanelHandlers {
  /** Enter in the console. Return the parse error to show (the input is kept), or null when applied. */
  onSubmit(text: string): ParseError | null;
  onTogglePause(): void;
  onSpeed(speed: number): void;
}

export interface SidePanel {
  element: HTMLElement;
  setClock(text: string, paused: boolean): void;
  setSpeed(speed: number): void;
  setCounters(rows: CounterRow[]): void;
  appendLines(lines: LogLine[]): void;
  /** The console's text (for pre-filling a callsign); setting it keeps focus where it is. */
  getInput(): string;
  setInput(text: string): void;
  /** A banner over the log: the sim stopped on an error. */
  showFatal(message: string): void;
}

export function buildSidePanel(title: string, handlers: SidePanelHandlers): SidePanel {
  const side = el('aside', 'side');

  // Clock, pause, speed.
  const bar = el('div', 'bar');
  const clock = el('span', 'clock', '0:00');
  const pause = el('button', 'pause', 'Pause (P)');
  pause.addEventListener('click', () => handlers.onTogglePause());
  const speeds = el('span', 'speeds');
  const speedButtons = SPEEDS.map((s) => {
    const b = el('button', '', `${s}×`);
    b.addEventListener('click', () => handlers.onSpeed(s));
    speeds.append(b);
    return { speed: s, button: b };
  });
  bar.append(el('h1', '', title), clock, pause, speeds);

  // Counters (PLAN 1.12's slot: placeholders until score.ts is wired).
  const counters = el('dl', 'counters');

  // Log.
  const log = el('ol', 'log');
  const fatal = el('p', 'fatal');
  fatal.hidden = true;

  // Console.
  const form = el('form', 'console');
  const input = el('input', '');
  input.type = 'text';
  input.name = 'command';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.placeholder = 'e.g. DAL4 taxi 31L via A R:KE hs B';
  input.setAttribute('aria-label', 'Dev console: terse command');
  const error = el('p', 'error');
  error.hidden = true;
  const hint = el('p', 'hint', 'Enter applies · ↑/↓ history · Esc leaves the console. On the map: click an aircraft, T asks tower for its crossing, P pauses.');
  form.append(input, error, hint);

  let history: History = emptyHistory();
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = input.value;
    if (text.trim() === '') return;
    const problem = handlers.onSubmit(text);
    history = remember(history, text);
    if (problem) {
      showError(text, problem);
      return;
    }
    error.hidden = true;
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      const r = recall(history, ev.key === 'ArrowUp' ? 'up' : 'down', input.value);
      history = r.history;
      input.value = r.text;
    } else if (ev.key === 'Escape') {
      input.blur();
    }
  });
  input.addEventListener('input', () => {
    error.hidden = true;
  });

  function showError(text: string, problem: ParseError): void {
    const at = text.trimStart();
    const lead = text.length - at.length;
    // parseTerse's offset is into the trimmed text; select the token it points at.
    const start = lead + problem.offset;
    const end = start >= text.length ? text.length : start + (/^\S+/.exec(text.slice(start))?.[0].length ?? 0);
    error.textContent = problem.message;
    error.hidden = false;
    input.focus();
    input.setSelectionRange(start, end);
  }

  side.append(bar, counters, fatal, log, form);

  let lastCounters = '';
  return {
    element: side,
    setClock(text, paused) {
      clock.textContent = paused ? `${text} · PAUSED` : text;
      clock.classList.toggle('paused', paused);
      pause.textContent = paused ? 'Resume (P)' : 'Pause (P)';
    },
    setSpeed(speed) {
      for (const { speed: s, button } of speedButtons) button.classList.toggle('on', s === speed);
    },
    setCounters(rows) {
      const key = rows.map((r) => `${r.label}=${r.value}`).join('|');
      if (key === lastCounters) return;
      lastCounters = key;
      counters.replaceChildren(...rows.flatMap((r) => [el('dt', '', r.label), el('dd', '', r.value)]));
    },
    appendLines(lines) {
      if (lines.length === 0) return;
      const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
      for (const line of lines) {
        const item = el('li', line.kind);
        item.append(el('time', '', line.time), document.createTextNode(` ${line.kind === 'player' ? '› ' : ''}${line.text}`));
        log.append(item);
      }
      while (log.childElementCount > LOG_LIMIT) log.firstElementChild?.remove();
      if (atBottom) log.scrollTop = log.scrollHeight;
    },
    getInput: () => input.value,
    setInput(text) {
      input.value = text;
      error.hidden = true;
    },
    showFatal(message) {
      fatal.textContent = message;
      fatal.hidden = false;
    },
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
