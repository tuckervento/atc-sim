/**
 * Transcript normalization and word error rate, applied identically to the reference
 * (script.md `say` text) and to every provider's transcript.
 *
 * Steps, in order:
 * 1. Lowercase; curly apostrophes become straight.
 * 2. Digit formatting is removed: "11:23" -> "1123", "119.1" -> "1191", "1,452" -> "1452".
 *    Spoken "point" between number words is dropped the same way (step 6), so a frequency or
 *    altimeter scores the same whether written "29.92" or "two niner niner two".
 *    A runway written "31L" / "4R" / "13C" becomes "31 left" / "4 right" / "13 center".
 *    Other letters glued to digits are split: "klm644" -> "klm 644".
 * 3. Hyphens and all other punctuation become spaces; apostrophes inside words are kept
 *    ("you'll" stays one token).
 * 4. Fillers are dropped: uh, um, uhm, er, erm, ah, hmm, mm.
 * 5. Spelling equivalences (formatting choices, not hearing): "jet blue" -> "jetblue",
 *    "speed bird" -> "speedbird", "aero mexico" -> "aeromexico", "k l m" -> "klm",
 *    "x ray" -> "xray", "call sign" -> "callsign", "all right" -> "alright", "ok" -> "okay",
 *    "going to" -> "gonna". ("call sign" and the letters-glued-to-digits split in step 2 were
 *    added after seeing provider output; every candidate was re-scored with them.)
 * 6. Numbers: every run of number words and digits becomes its digits, one token per digit.
 *    "eleven twenty-three", "one one two three", "1123" and "11 23" all become
 *    1 1 2 3. "niner" = 9. "oh"/"o" = 0 only between two number tokens ("twelve oh four").
 *    "one hundred" = 1 0 0. This makes WER count each digit of a callsign, runway or
 *    frequency as one word, which weights numbers more than a spoken-word count would.
 */

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, niner: 9,
};
const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const FILLERS = new Set(["uh", "um", "uhm", "er", "erm", "ah", "hmm", "mm"]);
const PHRASES: Array<[string[], string]> = [
  [["jet", "blue"], "jetblue"],
  [["speed", "bird"], "speedbird"],
  [["aero", "mexico"], "aeromexico"],
  [["k", "l", "m"], "klm"],
  [["x", "ray"], "xray"],
  [["call", "sign"], "callsign"],
  [["all", "right"], "alright"],
  [["going", "to"], "gonna"],
  [["ok"], "okay"],
];
const SIDES: Record<string, string> = { l: "left", r: "right", c: "center" };

const isDigits = (t: string): boolean => /^\d+$/.test(t);
const isNumberWord = (t: string): boolean =>
  t in UNITS || t in TEENS || t in TENS || t === "hundred" || t === "thousand";
const isNumberToken = (t: string): boolean => isDigits(t) || isNumberWord(t);
/** A number run can't start with "hundred"/"thousand" ("a hundred" stays words). */
const startsNumber = (t: string): boolean => isNumberToken(t) && t !== "hundred" && t !== "thousand";

export function normalize(text: string): string[] {
  let s = text.toLowerCase().replace(/[‘’ʼ]/g, "'");
  s = s.replace(/(\d)[:.,](?=\d)/g, "$1");
  s = s.replace(/\b(\d{1,2})([lrc])\b/g, (_m, digits: string, side: string) => `${digits} ${SIDES[side]}`);
  // Letters glued to digits are a formatting choice too: "klm644" -> "klm 644".
  s = s.replace(/([a-z])(?=\d)/g, "$1 ").replace(/(\d)(?=[a-z])/g, "$1 ");
  s = s.replace(/[^a-z0-9']+/g, " ");
  let tokens = s
    .split(" ")
    .map((t) => t.replace(/^'+|'+$/g, ""))
    .filter((t) => t !== "" && !FILLERS.has(t));
  tokens = applyPhrases(tokens);
  return numbersToDigits(tokens);
}

function applyPhrases(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    let matched = false;
    for (const [words, replacement] of PHRASES) {
      if (words.every((w, k) => tokens[i + k] === w)) {
        out.push(replacement);
        i += words.length;
        matched = true;
        break;
      }
    }
    if (!matched) out.push(tokens[i++]!);
  }
  return out;
}

/**
 * Convert number runs to single-digit tokens. A run is a maximal sequence of number tokens,
 * plus "oh"/"o" and "point" when they sit between two number tokens.
 */
function numbersToDigits(tokens: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (!startsNumber(tokens[i]!)) {
      out.push(tokens[i++]!);
      continue;
    }
    const run: string[] = [];
    while (i < tokens.length) {
      const t = tokens[i]!;
      const bridging = (t === "oh" || t === "o" || t === "point") && run.length > 0 && isNumberToken(tokens[i + 1] ?? "");
      if (isNumberToken(t) || bridging) {
        run.push(t);
        i++;
      } else break;
    }
    for (const ch of runToDigits(run)) out.push(ch);
  }
  return out;
}

function runToDigits(run: string[]): string {
  let digits = "";
  let i = 0;
  // Parse one spoken group starting at run[i]; returns [digits, tokens consumed].
  const group = (): [string, number] => {
    const t = run[i]!;
    if (isDigits(t)) return [t, 1];
    if (t === "oh" || t === "o") return ["0", 1];
    if (t === "point") return ["", 1];
    let value: number | null = null;
    let used = 0;
    const below100 = (k: number): [number, number] | null => {
      const w = run[k];
      if (w === undefined) return null;
      if (w in TEENS) return [TEENS[w]!, 1];
      if (w in TENS) {
        const next = run[k + 1];
        if (next !== undefined && next in UNITS && UNITS[next]! > 0) return [TENS[w]! + UNITS[next]!, 2];
        return [TENS[w]!, 1];
      }
      if (w in UNITS) return [UNITS[w]!, 1];
      return null;
    };
    // "hundred"/"thousand" right after a digit string ("1 hundred"): a multiplier.
    if (t === "hundred") return ["00", 1];
    if (t === "thousand") return ["000", 1];
    const first = below100(i);
    if (first === null) throw new Error(`normalize: unexpected token "${t}" in number run`);
    [value, used] = first;
    // "<n> hundred [and] [<m>]", "<n> thousand [<m> hundred] [<k>]"
    if (run[i + used] === "thousand") {
      value *= 1000;
      used += 1;
      const h = below100(i + used);
      if (h && run[i + used + h[1]] === "hundred") {
        value += h[0] * 100;
        used += h[1] + 1;
      }
      const rest = below100(i + used);
      if (rest) {
        value += rest[0];
        used += rest[1];
      }
    } else if (run[i + used] === "hundred") {
      value *= 100;
      used += 1;
      const rest = below100(i + used);
      if (rest) {
        value += rest[0];
        used += rest[1];
      }
    }
    return [String(value), used];
  };
  while (i < run.length) {
    const [d, used] = group();
    digits += d;
    i += used;
  }
  return digits;
}

export interface WerCounts {
  refWords: number;
  substitutions: number;
  deletions: number;
  insertions: number;
}

/** Levenshtein alignment over tokens. */
export function wer(ref: string[], hyp: string[]): WerCounts {
  const n = ref.length;
  const m = hyp.length;
  // cost[i][j] = edits to turn ref[0..i) into hyp[0..j)
  const cost: number[][] = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = cost[i - 1]![j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      cost[i]![j] = Math.min(sub, cost[i - 1]![j]! + 1, cost[i]![j - 1]! + 1);
    }
  }
  let i = n;
  let j = m;
  const counts: WerCounts = { refWords: n, substitutions: 0, deletions: 0, insertions: 0 };
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && cost[i]![j] === cost[i - 1]![j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      if (ref[i - 1] !== hyp[j - 1]) counts.substitutions++;
      i--;
      j--;
    } else if (i > 0 && cost[i]![j] === cost[i - 1]![j]! + 1) {
      counts.deletions++;
      i--;
    } else {
      counts.insertions++;
      j--;
    }
  }
  return counts;
}
