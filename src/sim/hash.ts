// A stable fingerprint of plain data, for determinism checks: the same state always gives the
// same hash, on any run (PRD §8.2, §9.3). The serialization sorts object keys, so it doesn't
// depend on the order fields were set in. It accepts only plain JSON data and throws on
// anything else (undefined, NaN, Infinity, functions, Maps), so a stray value can't hash the
// same as a missing one.
//
// The same engine gives the same floats for the same operations, so the hash is stable from
// run to run. Across JS engines it isn't guaranteed: Math.atan2, Math.hypot and friends may
// round differently.

/** JSON with object keys sorted at every level. Throws on values JSON can't represent exactly. */
export function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`stableStringify: ${value} isn't a finite number`);
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new Error('stableStringify: only plain objects and arrays');
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
    }
    default:
      throw new Error(`stableStringify: can't serialize a ${typeof value}`);
  }
}

/** 32-bit FNV-1a over the UTF-8 bytes of `text`, as 8 hex digits. */
export function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  const feed = (byte: number) => {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  };
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === undefined) throw new Error('fnv1a32: empty character');
    if (code < 0x80) feed(code);
    else if (code < 0x800) [0xc0 | (code >> 6), 0x80 | (code & 0x3f)].forEach(feed);
    else if (code < 0x10000) [0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)].forEach(feed);
    else [0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)].forEach(feed);
  }
  return hash.toString(16).padStart(8, '0');
}

/** The hash of plain data: FNV-1a of its stable serialization. */
export function hashOf(value: unknown): string {
  return fnv1a32(stableStringify(value));
}
