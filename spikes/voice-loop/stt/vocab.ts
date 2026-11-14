/**
 * Shared vocabulary hints for every speech-to-text candidate (task 0.3).
 *
 * One list, given unchanged to every provider that takes hints, so the comparison is fair.
 * It is kept at or under 100 terms because that's the tightest limit among the candidates:
 * - AssemblyAI `keyterms_prompt`: max 100 terms (Universal-3.6 Pro: each <= 50 characters)
 * - Deepgram Flux `keyterm`: max 100 terms
 * - Deepgram Nova-3 `keyterm`: max 500 tokens across all terms (Deepgram advises 20-50 terms)
 * - OpenAI `keywords`: no documented count limit; no `<`, `>`, CR or LF in a term
 *
 * What's in it (mirrors what the game would know from airport and traffic data):
 * - the ICAO phonetic alphabet (JFK's single-letter taxiways are all phonetic words)
 * - JFK's K-connector taxiways as spoken pairs. Kilo Charlie and Kilo Kilo are used by the
 *   test script but may not exist at JFK (script.md marks them [?]); the game would hint
 *   whatever its airport data contains.
 * - JFK runway designators, spoken digit by digit as controllers say them
 * - airline radio callsigns: every airline in the test script, plus a few more real JFK
 *   operators so the list isn't just the answer key
 * - common ground-control phrases and words
 *
 * Deliberately NOT included: flight numbers or whole callsigns. The game could hint the
 * flights currently on frequency (Nova-3, Flux and U3.6 Pro accept mid-stream updates), but
 * that's a dynamic-context experiment for later, not this bake-off.
 */

export const PHONETIC = [
  "Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India",
  "Juliet", "Kilo", "Lima", "Mike", "November", "Oscar", "Papa", "Quebec", "Romeo",
  "Sierra", "Tango", "Uniform", "Victor", "Whiskey", "X-ray", "Yankee", "Zulu",
] as const;

export const TAXIWAY_PAIRS = [
  "Kilo Charlie", "Kilo Delta", "Kilo Echo", "Kilo Foxtrot", "Kilo Golf", "Kilo Kilo",
] as const;

export const RUNWAYS = [
  "three one left", "three one right", "one three left", "one three right",
  "four left", "four right", "two two left", "two two right",
] as const;

export const AIRLINES = [
  // In the test script (Delta is already in PHONETIC).
  "JetBlue", "American", "Shamrock", "Lufthansa", "Emirates", "Alaska", "Iberia",
  "Speedbird", "Swiss", "Qatari", "Air France", "Virgin", "KLM", "Aeromexico",
  "Brickyard", "United",
  // Other real JFK operators, not in the script.
  "Endeavor", "Air Canada", "Etihad", "Cathay", "Korean Air", "Air China", "Turkish", "Avianca",
] as const;

export const ATC_PHRASES = [
  "Kennedy Ground", "niner", "heavy", "hold short", "hold position", "taxi via",
  "cross runway", "monitor tower", "contact ramp", "monitor ramp", "penalty box",
  "holding pad", "ground stop", "release time", "hold for release", "say again",
  "altimeter", "information",
  "Terminal One", "Terminal Four", "Terminal Five", "Terminal Seven", "Terminal Eight",
] as const;

export const VOCAB: readonly string[] = [
  ...PHONETIC, ...TAXIWAY_PAIRS, ...RUNWAYS, ...AIRLINES, ...ATC_PHRASES,
];

/** Free-text context for providers that take a prompt (OpenAI). Generic: no script lines. */
export const CONTEXT_PROMPT =
  "Air traffic control ground frequency at New York JFK (Kennedy Ground). A controller gives " +
  "taxi instructions to airline pilots: ICAO phonetic alphabet taxiway names (Alpha, Bravo, " +
  "Kilo Echo), runways spoken digit by digit (three one left, two two right), niner for nine, " +
  "and airline radio callsigns (JetBlue, Speedbird, Shamrock, Brickyard).";

const MAX_TERMS = 100;
const MAX_TERM_CHARS = 50;

/** Fail loudly if the shared list breaks a provider limit, instead of silently truncating. */
export function checkVocab(): void {
  const problems: string[] = [];
  if (VOCAB.length > MAX_TERMS) problems.push(`${VOCAB.length} terms (max ${MAX_TERMS})`);
  const seen = new Set<string>();
  for (const term of VOCAB) {
    if (term.length > MAX_TERM_CHARS) problems.push(`"${term}" is over ${MAX_TERM_CHARS} chars`);
    if (/[<>\r\n,;]/.test(term)) problems.push(`"${term}" contains a character some provider rejects`);
    const key = term.toLowerCase();
    if (seen.has(key)) problems.push(`duplicate term "${term}"`);
    seen.add(key);
  }
  if (problems.length > 0) throw new Error(`stt/vocab.ts breaks provider limits: ${problems.join("; ")}`);
}
