/**
 * Self-checks for the live loop. No network, no keys, no spend:
 *   node live/check.ts
 *
 * 1. Readbacks (live/readback.ts): a few exact readbacks, and over every script and card command:
 *    callsign last, no digits, every instruction type covered, same seed = same text.
 * 2. Cards (live/cards.ts): every expected command parses with parseTerse and passes the shape
 *    check; states name real flights; types cover C1-C10 and C12; no card copies a script
 *    `expected`; the combo plan is balanced and keeps one provider per flight.
 * 3. Interpreter request (live/interp.ts): the body deep-equals what interp/openai.ts's
 *    openaiRunner("prompt", "explicit", "format") sends for the same script line (fetch is
 *    stubbed; nothing leaves the process), and the card context builder reproduces
 *    liveContext() for a line with no overrides.
 * Exits 1 on the first failed check, printing which.
 */
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { parseTerse } from "../../../src/sim/terse.ts";
import type { Instruction, Transmission } from "../../../src/sim/commands.ts";
import { FLIGHTS, liveContext } from "../interp/context.ts";
import { trackConnections } from "../interp/net.ts";
import { checkShape } from "../interp/shape.ts";
import { loadScript } from "../stt/script.ts";
import { CARDS, cardVoicePlan, comboPlan, unknownFlightsIn, voiceFlightOf } from "./cards.ts";
import { GENERIC_SAY_AGAIN, readbackText, sayAgainText, seededRng, styleFor, type Style } from "./readback.ts";
import { providerOf } from "./voices.ts";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`ok   ${name}`);
    })
    .catch((err: unknown) => {
      console.log(`FAIL ${name}\n     ${err instanceof Error ? err.message.split("\n").join("\n     ") : String(err)}`);
      process.exit(1);
    });
}

function cmd(terse: string): Transmission {
  const r = parseTerse(terse);
  if (!r.ok) throw new Error(`'${terse}' doesn't parse: ${r.error.message}`);
  if (r.command.type !== "transmission") throw new Error(`'${terse}' isn't a transmission`);
  return r.command;
}

const spoken = (cs: string): string => {
  const f = FLIGHTS.find((x) => x.callsign === cs);
  if (!f) throw new Error(`no flight ${cs}`);
  return f.spoken;
};

/** A readback with an rng that always picks the first variant. */
function first(terse: string, style: Style = "terse", repeat: string | null = null): string {
  const c = cmd(terse);
  return readbackText({ command: c, callsignSpoken: spoken(c.callsign!), style, rng: () => 0, repeat });
}

// ---- 1. readbacks ----------------------------------------------------------------------

await check("readback: taxi to runway, first variant", () => {
  assert.equal(first("DAL4 taxi 31L via A R:KE hs B"), "Three one left, Alpha, right Kilo Echo, hold short Bravo, Delta four.");
});
await check("readback: two hold-shorts, runway words", () => {
  assert.equal(first("JBU1123 taxi 31L via A KD hs B 31R"), "Three one left, Alpha, Kilo Delta, hold short Bravo and three one right, JetBlue eleven twenty-three.");
});
await check("readback: ramp destination", () => {
  assert.equal(first("UAE202 taxi ramp T4 via KE L:A"), "Terminal Four ramp via Kilo Echo, left Alpha, Emirates two zero two heavy.");
});
await check("readback: niner in frequency, handoff", () => {
  assert.equal(first("BAW175 monitor tower 119.1"), "Monitor tower one one niner point one, Speedbird one seven five heavy.");
});
await check("readback: ATIS with altimeter", () => {
  assert.equal(first("JBU615 atis P alt 2992"), "Papa, two niner niner two, JetBlue six one five.");
});
await check("readback: consecutive hold-shorts merge, after a crossing", () => {
  assert.equal(first("SWR17 cross 22R at Y, hs B"), "Cross two two right at Yankee, hold short Bravo, Swiss one seven heavy.");
});
await check("readback: correction of a turn", () => {
  assert.equal(first("DLH405 neg turn R:KE"), "Right on Kilo Echo, Lufthansa four zero five heavy.");
});
await check("readback: ground stop city and delay", () => {
  assert.equal(first("RPA3560 ground-stop BOS, delay 20"), "Ground stop Boston, twenty minutes, Brickyard thirty-five sixty.");
});
await check("readback: release time, hold for release", () => {
  assert.equal(first("JBU615 release 1452, hold-for-release"), "Release one four five two, hold for release, JetBlue six one five.");
});
await check("readback: say-again repeats the last call", () => {
  assert.equal(first("KLM644 say-again", "terse", "Ground, KLM six four four heavy, Terminal Four, ready to taxi."), "Ground, KLM six four four heavy, Terminal Four, ready to taxi.");
});
await check("readback: say-again (didn't understand) and the generic line", () => {
  assert.equal(sayAgainText("Delta four", () => 0), "Say again for Delta four.");
  assert.equal(GENERIC_SAY_AGAIN, "Station calling Ground, say again.");
});

const script = await loadScript();
const scored = script.filter((l) => !l.expected.startsWith("UNSCORED"));
const commands: Transmission[] = [
  ...scored.map((l) => cmd(l.expected)),
  ...CARDS.map((c) => cmd(c.expected)),
].filter((c) => c.callsign !== null);

await check(`readback: ${commands.length} script + card commands x 3 seeds x both styles: callsign last, no digits, no 'undefined'`, () => {
  for (const c of commands) {
    for (const seed of [1, 2, 3]) {
      for (const style of ["terse", "chatty"] as const) {
        const text = readbackText({ command: c, callsignSpoken: spoken(c.callsign!), style, rng: seededRng(seed), repeat: "Ground, test call." });
        const isRepeat = (c.instructions as Instruction[]).every((i) => i.type === "say-again");
        if (!isRepeat) assert.ok(text.endsWith(`, ${spoken(c.callsign!)}.`), `callsign not last: ${text}`);
        assert.ok(!/\d/.test(text), `digit in readback: ${text}`);
        assert.ok(!/undefined|null|NaN/.test(text), `bad token in readback: ${text}`);
        assert.ok(/^[A-Z]/.test(text), `not capitalized: ${text}`);
      }
    }
  }
});
await check("readback: every instruction type in commands.ts is exercised", () => {
  const types = new Set(commands.flatMap((c) => (c.instructions as Instruction[]).map((i) => i.type)));
  const all = ["taxi", "hold-short", "hold-position", "continue", "cross", "handoff", "correction", "atis", "say-again", "ground-stop", "release-time", "hold-for-release", "expect-delay"];
  assert.deepEqual(all.filter((t) => !types.has(t as Instruction["type"])), []);
  const dests = new Set(commands.flatMap((c) => (c.instructions as Instruction[]).flatMap((i) => (i.type === "taxi" ? [i.to.kind] : []))));
  assert.deepEqual([...dests].sort(), ["pad", "penalty-box", "ramp", "runway"]);
});
await check("readback: same seed gives the same text; variants do vary", () => {
  const c = cmd("DAL4 taxi 31L via A R:KE hs B");
  const a = readbackText({ command: c, callsignSpoken: "Delta four", style: "chatty", rng: seededRng(7), repeat: null });
  const b = readbackText({ command: c, callsignSpoken: "Delta four", style: "chatty", rng: seededRng(7), repeat: null });
  assert.equal(a, b);
  const seen = new Set<string>();
  for (let s = 1; s <= 30; s++) seen.add(readbackText({ command: c, callsignSpoken: "Delta four", style: "chatty", rng: seededRng(s), repeat: null }));
  assert.ok(seen.size >= 4, `only ${seen.size} variants over 30 seeds`);
});
await check("readback: style is fixed per flight and both styles occur", () => {
  for (const f of FLIGHTS) assert.equal(styleFor(f.callsign, 1), styleFor(f.callsign, 1));
  const styles = new Set(FLIGHTS.map((f) => styleFor(f.callsign, 1)));
  assert.deepEqual([...styles].sort(), ["chatty", "terse"]);
});

// ---- 2. cards --------------------------------------------------------------------------

await check(`cards: ${CARDS.length} cards; every expected parses and passes the shape check`, () => {
  assert.ok(CARDS.length >= 22 && CARDS.length <= 26, `expected about 24 cards, got ${CARDS.length}`);
  for (const c of CARDS) {
    const t = cmd(c.expected);
    const shape = checkShape(t);
    assert.ok(shape.ok, `${c.id}: ${shape.ok ? "" : shape.reason}`);
    assert.equal(t.callsign, c.callsign, `${c.id}: callsign field disagrees with expected`);
  }
  assert.equal(new Set(CARDS.map((c) => c.id)).size, CARDS.length, "duplicate card ids");
});
await check("cards: states name flights on frequency; correction cards have a wrong readback; say-again cards a repeat", () => {
  for (const c of CARDS) {
    assert.deepEqual(unknownFlightsIn(c), [], c.id);
    if (c.callsign) assert.ok(FLIGHTS.some((f) => f.callsign === c.callsign), `${c.id}: addressee not on frequency`);
    if (c.types.includes("C8")) assert.ok(c.wrongReadback, `${c.id}: correction card without wrongReadback`);
    if (c.types.includes("C10")) assert.ok(c.repeat, `${c.id}: say-again card without repeat`);
    if (c.callsign === null) assert.ok(c.unattributed, `${c.id}: unknown station without an unattributed call`);
  }
});
await check("cards: cover C1-C10 and C12, not C11", () => {
  const types = new Set(CARDS.flatMap((c) => c.types));
  const want = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "C12"];
  assert.deepEqual(want.filter((t) => !types.has(t)), []);
  assert.ok(!types.has("C11"));
});
await check("cards: no card repeats a script line's expected command (except '? say-again', which has only one form)", () => {
  // An unknown-station say-again can only be written one way, so c23 necessarily shares line
  // 31's command. Its situation (caller, place) is new.
  const scriptExpected = new Set(scored.map((l) => l.expected));
  const dupes = CARDS.filter((c) => c.expected !== "? say-again" && scriptExpected.has(c.expected)).map((c) => c.id);
  assert.deepEqual(dupes, []);
});
for (const transport of ["cartesia-ws", "cartesia-http"] as const) {
  await check(`cards: combo plan (${transport}) balanced; one voice per flight; voices balanced`, () => {
    const plan = comboPlan(transport);
    const count = (pred: (k: string) => boolean) => CARDS.filter((c) => pred(`${plan.get(c.id)!.stt}+${plan.get(c.id)!.tts}`)).length;
    const n = CARDS.length;
    const half = (k: number) => Math.abs(k - n / 2) <= 1;
    assert.ok(half(count((k) => k.startsWith("nova3"))), "STT not balanced");
    assert.ok(half(count((k) => k.endsWith("elevenlabs"))), "TTS not balanced");
    for (const combo of [`nova3+elevenlabs`, `nova3+${transport}`, `u36pro+elevenlabs`, `u36pro+${transport}`]) {
      const k = count((x) => x === combo);
      assert.ok(Math.abs(k - n / 4) <= 1.5, `combo ${combo} has ${k} cards`);
    }
    const voices = cardVoicePlan(plan);
    const byFlight = new Map<string, Set<string>>();
    const perVoice = new Map<string, number>();
    for (const c of CARDS) {
      const f = voiceFlightOf(c);
      const v = voices.get(f);
      assert.ok(v, `${f} has no planned voice`);
      assert.equal(v.provider, providerOf(plan.get(c.id)!.tts), `${f}: voice ${v.name} isn't a ${plan.get(c.id)!.tts} voice`);
      if (!byFlight.has(f)) byFlight.set(f, new Set());
      byFlight.get(f)!.add(plan.get(c.id)!.tts);
      byFlight.get(f)!.add(v.name);
      perVoice.set(v.name, (perVoice.get(v.name) ?? 0) + 1);
    }
    for (const [f, s] of byFlight) assert.equal(s.size, 2, `${f} would change voice: ${[...s].join(", ")}`);
    const counts = [...perVoice.values()];
    assert.equal(perVoice.size, 6, `only ${perVoice.size} of 6 voices get a card`);
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 2, `voices unbalanced: ${JSON.stringify(Object.fromEntries(perVoice))}`);
    console.log(`     cards per voice: ${JSON.stringify(Object.fromEntries(perVoice))}`);
  });
}

// ---- 3. interpreter request --------------------------------------------------------------

await check("interp: card context builder reproduces liveContext() for line 01 (no overrides)", async () => {
  const { contextFor } = await import("./interp.ts");
  assert.equal(contextFor({}, null), liveContext("01"));
});
await check("interp: request body deep-equals interp/openai.ts's for script lines 01, 12 and 31 (fetch stubbed)", async () => {
  // A placeholder key, never a real one: this check makes no request.
  process.env.OPENAI_API_KEY = "placeholder-for-offline-check";
  trackConnections();
  const { openaiRunner } = await import("../interp/openai.ts");
  const { Interpreter } = await import("./interp.ts");
  const realFetch = globalThis.fetch;
  const captured: unknown[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    captured.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status: "completed", output: [], usage: {} }), { status: 200 });
  }) as typeof fetch;
  try {
    const runner = openaiRunner("prompt", "explicit", "format");
    const mine = new Interpreter("format");
    for (const num of ["01", "12", "31"]) {
      captured.length = 0;
      await runner.run(num, "test transcript");
      assert.equal(captured.length, 1);
      const theirs = captured[0];
      const ours = JSON.parse(JSON.stringify(mine.body(liveContext(num), "test transcript")));
      assert.ok(isDeepStrictEqual(theirs, ours), `line ${num}: bodies differ`);
      assert.equal(JSON.stringify(theirs), JSON.stringify(ours), `line ${num}: same content, different key order`);
    }
    const terseRunner = openaiRunner("prompt", "explicit", "terse");
    const terseMine = new Interpreter("terse");
    captured.length = 0;
    await terseRunner.run("05", "test transcript");
    assert.equal(JSON.stringify(captured[0]), JSON.stringify(terseMine.body(liveContext("05"), "test transcript")), "terse bodies differ");
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log(`\n${passed} checks passed.`);
