// Parser for spikes/voice-loop/test-set/script.md. The format is documented at the top of that
// file. Zero dependencies. Throws one Error listing every problem it finds, so a malformed
// script fails loudly instead of silently dropping lines.

const ENTRY_HEADING = /^###\s+(\d{2})\s*$/;
const ANY_HEADING = /^#{1,6}\s/;
const FIELD = /^- ([a-z]+): (.*)$/;
const FENCE = /^\s*(```|~~~)/;
const TYPE = /^C(?:[1-9]|1[0-2])$/;

const REQUIRED = ['types', 'style', 'say', 'readback', 'expected'];
const OPTIONAL = ['context'];
const KNOWN = new Set([...REQUIRED, ...OPTIONAL]);
const STYLES = new Set(['textbook', 'loose']);

/**
 * @param {string} text  contents of script.md
 * @returns {{num: string, types: string[], style: string, context: string|null,
 *            say: string, readback: string, expected: string}[]}
 */
export function parseScript(text) {
  const errors = [];
  const raw = []; // { num, row, fields: Map }
  let current = null;
  let inFence = false;

  text.split(/\r?\n/).forEach((line, i) => {
    const row = i + 1;
    if (FENCE.test(line)) {
      inFence = !inFence;
      current = null;
      return;
    }
    if (inFence) return;

    const heading = line.match(ENTRY_HEADING);
    if (heading) {
      current = { num: heading[1], row, fields: new Map() };
      raw.push(current);
      return;
    }
    if (ANY_HEADING.test(line)) {
      current = null;
      return;
    }
    if (!current || line.trim() === '') return;

    const field = line.match(FIELD);
    if (!field) {
      errors.push(`row ${row} (line ${current.num}): expected "- key: value", got: ${line}`);
      return;
    }
    const [, key, value] = field;
    if (!KNOWN.has(key)) {
      errors.push(`row ${row} (line ${current.num}): unknown key "${key}" (known: ${[...KNOWN].join(', ')})`);
    } else if (current.fields.has(key)) {
      errors.push(`row ${row} (line ${current.num}): duplicate key "${key}"`);
    } else {
      current.fields.set(key, value.trim());
    }
  });

  if (inFence) errors.push('unterminated fenced code block');

  const entries = [];
  let previous = null;
  for (const { num, row, fields } of raw) {
    const where = `line ${num} (row ${row})`;
    if (previous !== null && Number(num) <= Number(previous)) {
      errors.push(`${where}: numbers must be unique and ascending (follows ${previous})`);
    }
    previous = num;

    for (const key of REQUIRED) {
      if (!fields.get(key)) errors.push(`${where}: missing or empty "${key}"`);
    }
    const types = (fields.get('types') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    for (const t of types) {
      if (!TYPE.test(t)) errors.push(`${where}: bad command type "${t}" (expected C1..C12)`);
    }
    const style = fields.get('style') ?? '';
    if (style && !STYLES.has(style)) {
      errors.push(`${where}: style must be "textbook" or "loose", got "${style}"`);
    }

    entries.push({
      num,
      types,
      style,
      context: fields.get('context') ?? null,
      say: fields.get('say') ?? '',
      readback: fields.get('readback') ?? '',
      expected: fields.get('expected') ?? '',
    });
  }

  if (entries.length === 0) errors.push('no lines found (expected "### 01" headings)');
  if (errors.length > 0) {
    throw new Error(`script.md is malformed:\n  - ${errors.join('\n  - ')}`);
  }
  return entries;
}
