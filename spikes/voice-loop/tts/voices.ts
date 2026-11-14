/**
 * Which voices the bench uses per provider, and live catalog counts of usable "pilot" voices and
 * accented-English voices. Catalog requests are free and read-only.
 *
 * "Usable pilot voice" criteria (an upper bound; Q's ear decides): an adult voice that speaks
 * English and reads as calm, clear and conversational rather than a character, narrator-for-kids,
 * novelty or high-energy voice. Each provider exposes different metadata, so the filter differs:
 * - ElevenLabs labels: language en; age young or middle_aged (not old); use case conversational
 *   or informative_educational; descriptive in PILOT_DESCRIPTIVES.
 * - Cartesia has no age or use-case fields, so a keyword filter on tagline + description:
 *   at least one of CARTESIA_INCLUDE and none of CARTESIA_EXCLUDE.
 * - OpenAI has 10 built-in voices and no metadata to filter, so all 10 are candidates.
 */
import * as cartesia from "./cartesia.ts";
import * as eleven from "./elevenlabs.ts";
import * as openai from "./openai.ts";

export type ProviderName = "elevenlabs" | "cartesia" | "openai";
export const PROVIDERS: ProviderName[] = ["elevenlabs", "cartesia", "openai"];

export interface VoicePick {
  id: string;
  name: string;
  /** Why it was picked / what the provider says about it. */
  note: string;
  /** Cartesia: top-level `accent` request field. */
  accent?: string;
  /** OpenAI: extra session instructions (accent by prompt; undocumented). */
  extraInstructions?: string;
  /** Shown on the page next to the voice. */
  accentLabel: string;
}

/**
 * The first voice is the primary: it gets the speed calibration and all timing lines. The others
 * read the sample lines. ElevenLabs is limited to premade voices: the account is on the free plan,
 * which can't use Voice Library voices through the API (HTTP 402, seen 2026-11-14).
 */
export const VOICE_PLAN: Record<ProviderName, VoicePick[]> = {
  elevenlabs: [
    { id: "cjVigY5qzO86Huf0OWal", name: "Eric", note: "premade; middle-aged American male; 'Smooth, Trustworthy'; conversational", accentLabel: "American" },
    { id: "iP95p4xoKVk53GoZ742B", name: "Chris", note: "premade; middle-aged American male; 'Charming, Down-to-Earth'; casual", accentLabel: "American" },
    { id: "CwhRBWXzGAHq8TQ4Fs17", name: "Roger", note: "premade; middle-aged American male; 'Laid-Back, Casual, Resonant'", accentLabel: "American" },
    { id: "hpp4J3VqNfWAUOO0d1Us", name: "Bella", note: "premade; middle-aged American female; 'Professional, Bright, Warm'", accentLabel: "American" },
    { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel", note: "premade; middle-aged British male; 'Steady Broadcaster'; accent preview", accentLabel: "British" },
  ],
  cartesia: [
    { id: "5cf0e4d9-ca2b-4fd5-81fa-89db3b645539", name: "Derrick", note: "'Professional Man': no-nonsense, steady confidence, clear tone", accentLabel: "American" },
    { id: "5fc5c797-12c5-4f2b-ac9b-d4e53c08098f", name: "Wyatt", note: "'Dependable Dispatcher': clear American male, subtle Southern drawl", accentLabel: "Southern US" },
    { id: "f4e8781b-a420-4080-81cf-576331238efa", name: "Samantha", note: "'Support Leader': firm, confident adult female", accentLabel: "American" },
    { id: "dc52ada6-0e11-4684-a8fa-e0af5b7bdcb2", name: "Gary", note: "'Composed Advisor': measured, direct, no-nonsense; accent preview", accentLabel: "British" },
    {
      id: "b7187e84-fe22-4344-ba4a-bc013fcb533e",
      name: "Sebastian",
      note: "'Orator': native German voice speaking English, with accent=standard-german; accent preview",
      accent: "standard-german",
      accentLabel: "German (accent field)",
    },
  ],
  openai: [
    { id: "cedar", name: "cedar", note: "built-in; OpenAI recommends marin and cedar", accentLabel: "American" },
    { id: "marin", name: "marin", note: "built-in; recommended", accentLabel: "American" },
    { id: "ash", name: "ash", note: "built-in", accentLabel: "American" },
    { id: "echo", name: "echo", note: "built-in", accentLabel: "American" },
    {
      id: "cedar",
      name: "cedar + German accent instruction",
      note: "built-in cedar, told in the instructions to use a light German accent; accents aren't documented for realtime voices",
      extraInstructions: "Speak English with a light German accent, like a Lufthansa captain.",
      accentLabel: "German (by instruction, undocumented)",
    },
  ],
};

export interface Catalog {
  /** Usable pilot voices this account can use now. */
  usableNow: number;
  /** Usable pilot voices in the provider's catalog, including any that need a paid plan. */
  usableCatalog: number;
  totalEnglish: number;
  criteria: string;
  accents: { available: boolean; counts: Record<string, number>; examples: string[]; note: string };
}

const PILOT_DESCRIPTIVES = ["calm", "casual", "chill", "classy", "confident", "crisp", "formal", "neutral", "professional", "relaxed", "serious", "deep", "mature", "pleasant"];
const PILOT_USE_CASES = ["conversational", "informative_educational"];
const PILOT_AGES = ["young", "middle_aged"];
/** English-language accents to count in the ElevenLabs shared library. */
const ELEVEN_ACCENTS = ["british", "irish", "scottish", "australian", "indian", "south african", "german", "french", "spanish", "italian", "dutch", "swedish", "arabic", "nigerian"];

function elevenPilot(labels: Record<string, string> | undefined): boolean {
  if (!labels) return false;
  return (
    labels.language === "en" &&
    PILOT_AGES.includes(labels.age ?? "") &&
    PILOT_USE_CASES.includes(labels.use_case ?? "") &&
    PILOT_DESCRIPTIVES.includes(labels.descriptive ?? "")
  );
}

async function elevenCatalog(key: string): Promise<Catalog> {
  const account = await eleven.listAccountVoices(key);
  const premade = account.filter((v) => v.category === "premade");
  const usablePremade = premade.filter((v) => elevenPilot(v.labels));
  let usableShared = 0;
  for (const age of PILOT_AGES) {
    const r = await eleven.searchShared(key, { language: "en", age, use_cases: PILOT_USE_CASES, descriptives: PILOT_DESCRIPTIVES });
    usableShared += r.total;
  }
  const totalShared = (await eleven.searchShared(key, { language: "en" })).total;
  const counts: Record<string, number> = {};
  const examples: string[] = [];
  for (const accent of ELEVEN_ACCENTS) {
    const r = await eleven.searchShared(key, { language: "en", accent }, 2);
    counts[accent] = r.total;
    const ex = r.voices[0];
    if (ex) examples.push(`${ex.name} (${accent}, ${ex.gender}, ${ex.age})`);
  }
  const premadeAccents = [...new Set(usablePremade.map((v) => v.labels?.accent ?? "?"))];
  for (const v of premade.filter((p) => p.labels?.accent && p.labels.accent !== "american")) {
    counts[`premade:${v.labels?.accent}`] = (counts[`premade:${v.labels?.accent}`] ?? 0) + 1;
  }
  return {
    usableNow: usablePremade.length,
    usableCatalog: usablePremade.length + usableShared,
    totalEnglish: premade.length + totalShared,
    criteria: `labels: language en; age ${PILOT_AGES.join("|")}; use case ${PILOT_USE_CASES.join("|")}; descriptive ${PILOT_DESCRIPTIVES.join("|")}`,
    accents: {
      available: true,
      counts,
      examples,
      note:
        `Usable premade voices cover accents: ${premadeAccents.join(", ")}. Shared Voice Library counts are English voices per ` +
        "accent label (GET /v1/shared-voices?language=en&accent=...). Library voices need a paid plan for API use (HTTP 402 on this key).",
    },
  };
}

const CARTESIA_INCLUDE_WORDS = [
  "calm", "clear", "steady", "confident", "professional", "composed", "measured", "crisp", "precise", "poised",
  "authoritative", "authority", "reliable", "dependable", "polished", "seasoned", "firm", "articulate", "formal",
  "neutral", "balanced", "relaxed", "laidback", "laid-back", "easygoing", "conversational", "casual",
];
const CARTESIA_EXCLUDE_WORDS = [
  "child", "children", "kid", "kids", "teen", "teenage", "teenager", "elderly", "grandma", "grandpa", "grandmother",
  "grandfather", "whisper", "whispering", "whispery", "asmr", "meditation", "sleepy", "character", "cartoon", "villain",
  "pirate", "wizard", "broadway", "cheerleader", "enthusiastic", "energetic", "hyped", "bubbly", "cheerful", "playful",
  "sassy", "sultry", "seductive", "flirty", "sad", "scared", "surprised", "disgusted", "angry", "yelling", "dramatic",
  "emotive", "cute", "giggly", "excited", "lively", "upbeat",
];
const wordRegex = (words: string[]): RegExp => new RegExp(`\\b(${words.join("|")})\\b`, "i");
const CARTESIA_INCLUDE = wordRegex(CARTESIA_INCLUDE_WORDS);
const CARTESIA_EXCLUDE = wordRegex(CARTESIA_EXCLUDE_WORDS);

async function cartesiaCatalog(key: string): Promise<Catalog> {
  const voices = await cartesia.listVoices(key, "en");
  const usable = voices.filter((v) => {
    const text = `${v.tagline} ${v.description}`;
    return CARTESIA_INCLUDE.test(text) && !CARTESIA_EXCLUDE.test(text);
  });
  const native = (v: cartesia.CartesiaVoice) => (v.accents ?? []).filter((a) => a.is_native);
  const counts: Record<string, number> = {};
  const examples: string[] = [];
  const seen = new Set<string>();
  for (const v of usable) {
    for (const a of native(v)) {
      if (a.locale === "en-US") continue;
      const label = a.locale.startsWith("en") ? `${a.locale} ${a.accent}` : `${a.accent} (native ${a.locale}, speaks English)`;
      counts[label] = (counts[label] ?? 0) + 1;
      if (!seen.has(label)) {
        seen.add(label);
        examples.push(`${v.name} — ${v.tagline} (${label})`);
      }
    }
  }
  return {
    usableNow: usable.length,
    usableCatalog: usable.length,
    totalEnglish: voices.length,
    criteria: `tagline + description contain one of [${CARTESIA_INCLUDE_WORDS.join(", ")}] and none of [${CARTESIA_EXCLUDE_WORDS.join(", ")}]`,
    accents: {
      available: true,
      counts,
      examples,
      note:
        "Counts are usable voices by native accent, excluding en-US (GET /voices?language=en, accents[].is_native). " +
        "Voices native in another language that list an English locale speak English with that accent; " +
        "the TTS request also takes a top-level `accent` field.",
    },
  };
}

export async function catalogFor(provider: ProviderName, key: string): Promise<Catalog> {
  if (provider === "elevenlabs") return elevenCatalog(key);
  if (provider === "cartesia") return cartesiaCatalog(key);
  return {
    usableNow: openai.VOICES.length,
    usableCatalog: openai.VOICES.length,
    totalEnglish: openai.VOICES.length,
    criteria: "10 built-in voices; no metadata to filter on, so all count as candidates",
    accents: {
      available: false,
      counts: {},
      examples: [],
      note: "No accent field or accent metadata for realtime voices. The bench tries one accent by instruction (undocumented).",
    },
  };
}
