# Terse command syntax

The typed form of every player command, e.g. `DAL4 taxi 31L via A R:KE hs B`. Q decided on a
terse syntax on 2026-11-14 (PLAN.md Context; PRD §9.2). Task 1.2 designed it.

- **Types:** `src/sim/commands.ts`. This is the contract. The terse parser and the Phase 2 AI
  interpreter must both produce exactly these objects.
- **Parser:** `src/sim/terse.ts`, `parseTerse(input)`.
- **Tests:** `src/sim/terse.test.ts`.
- **Used by:** the dev console (1.13), the test bot (1.14), sim tests, and the `expected`
  column of the voice test set (0.4).

Every object shown below was printed by the parser itself.

## Quick reference

| PRD | Command | Terse example |
|---|---|---|
| C1 | Taxi to a runway | `DAL4 taxi 31L via A R:KE hs B` |
| C2 | Taxi to a ramp / terminal | `UAE202 taxi ramp T4 via L:B KE` |
| C3 | Hold short | `ASA93 hs 4R` |
| C4 | Hold position / continue | `JBU1123 hold`, `IBE626 continue` |
| C5 | Cross runway(s) | `DAL4 cross 31R at KE` |
| C6 | Holding pad / penalty box, incl. out of the departure line | `AFR23 taxi pad via L:KD`, `VIR3 taxi penalty via KF B` |
| — | Hardstand / company hangar (Q, 2026-11-14) | `N123AB taxi hardstand via Q Q5`, `DAL4 taxi hangar via S` |
| C7 | Handoff | `AFR23 monitor tower`, `UAE202 contact ramp 125.05` |
| C8 | Correction | `DAL4 neg hs B`, `DLH405 neg turn R:KE` |
| C9 | ATIS correction | `JBU615 atis P alt 2992` |
| C10 | Say again | `KLM644 say-again`, `? say-again` |
| C11 | Follow / give way | *Not supported (cut first, PRD §7)* |
| C12 | Delays and restrictions | `DAL1204 ground-stop ATL`, `JBU615 release 1452`, `UAL1416 hold-for-release`, `RPA3560 delay 20` |
| — | Crossing request to tower (T key, PRD §4.5) | `DAL4 request-crossing`, `DAL4 request-crossing 31R` |

Several instructions in one transmission are separated by commas:
`DAL2340 atis P alt 2992, taxi 31L via A KD hs B`.

## Using the parser

```ts
import { parseTerse } from './terse.ts';

const result = parseTerse('DAL4 cross KE');
if (result.ok) {
  result.command; // a Command (src/sim/commands.ts)
} else {
  result.error.message; // "expected runway after 'cross', got 'KE'"
  result.error.offset;  // 11: character offset of 'KE' (input length if at end)
}
```

`parseTerse` returns a result and **never throws on bad input**. If it throws, that's a bug in
`terse.ts`. It is airport-agnostic: it checks the shape of names, runways, times and
frequencies, but not whether a taxiway or runway exists. That check comes later, against
airport data.

## What a command is

`Command` is one of two things:

- **A transmission** (`type: 'transmission'`): one radio call to one aircraft (PRD §6.1). It
  has a `callsign` and a list of `instructions` in spoken order. There is always at least one.
  - `callsign` is the ICAO-style flight ID without "heavy": `DAL4` for "Delta four", `UAE202`
    for "Emirates two zero two heavy", `BAW175` for "Speedbird one seven five".
  - `callsign` is `null` only for "aircraft calling Ground, say again your callsign". That
    transmission's only instruction is `say-again`.
- **A crossing request** (`type: 'crossing-request'`): the player asks tower for a runway
  crossing (PRD §4.5). It's a key press, not a radio call, so it can't be combined with
  instructions.

```json
{"type":"transmission","callsign":"DAL4","instructions":[
  {"type":"taxi","to":{"kind":"runway","name":"31L"},
   "via":[{"taxiway":"A","turn":null},{"taxiway":"KE","turn":"right"}],
   "holdShort":[{"kind":"taxiway","name":"B"}]}]}
```

**Canonical form.** Every field is always present. "Not given" is `null` and an empty list is
`[]`; fields are never left out. So each command has exactly one JSON form, and two commands
are equal exactly when they deep-equal.

## Lexical rules

- **Tokens** are separated by spaces. A comma is its own token wherever it appears, so
  `Y,hs` is the same as `Y, hs`.
- **Commas separate instructions, and only instructions.** An instruction runs to the next
  comma or the end. Inside an instruction, words like `via`, `hs` and `at` are its clauses.
  Commas are not used inside a route: write `via A KE`, not `via A, KE`.
- **Case doesn't matter.** Keywords, turn prefixes and names can be any case. Names come out
  uppercase: `dal4 taxi 31l via a` gives callsign `DAL4`, runway `31L`, taxiway `A`.
- **Keywords are reserved:** `taxi via hs hold continue cross at monitor contact tower ramp
  pad penalty hardstand hangar neg to turn atis alt say-again ground-stop release
  hold-for-release delay request-crossing`. None of them can be a bare name (see `#` below).
- **Names** (taxiways, ramp lanes, ramps, pads, destinations) are a letter followed by
  letters and digits: `A`, `KE`, `C1`, `T4`, `D13`. Names with spaces or punctuation can't
  be written.
- **`#` marks a name explicitly.** `#` followed by letters and digits is always a name. Use
  it for a name that starts with a digit (`#13`) or is spelled like a keyword (`#VIA`). The
  `#` is not part of the name: `#13` is the name `13`.
- **Turns** prefix a route item: `L:B` is "left on Bravo" and `R:KE` is "right on Kilo
  Echo". Only `L:` and `R:` exist, and only on route items (after `via`, or after `turn` in
  a correction). `R:#13` is "right on lane 13".
- **Callsigns** start with a letter, use only letters and digits, and contain at least one
  digit: `DAL4`, `JBU1123`, `N123AB`. `?` stands for an unknown station, and is used only in
  `? say-again`.

### The numeric-name rule

LGA's ramp lanes are numbered 1–19, and its runways are 4/22 and 13/31, so "13" could be
either. The rule:

> **A bare token that starts with a digit is never a name.** Where a runway can go, it's a
> runway. Where only a name can go, it's an error. A name that starts with a digit is
> always written with `#`.

So you can always tell a runway from a lane by the token alone:

| Terse | Meaning |
|---|---|
| `hs 13` | hold short of **runway 13** |
| `hs #13` | hold short of **lane 13** |
| `via A R:#13` | route: Alpha, then right on lane 13 |
| `via A 13` | error: `expected taxiway after 'A', got '13' (a bare number is a runway; write a name that starts with a digit as '#13')` |
| `cross #13` | error: `expected runway after 'cross', got '#13'` |

```
AAL22 taxi ramp B via A R:#13 hs 13
→ {"type":"taxi","to":{"kind":"ramp","name":"B"},
   "via":[{"taxiway":"A","turn":null},{"taxiway":"13","turn":"right"}],
   "holdShort":[{"kind":"runway","name":"13"}]}
```

In the objects there is no ambiguity: a route item is always a taxiway or lane, and a
hold-short target carries `kind: 'taxiway'` or `kind: 'runway'`.

### Runway normalization

Runways are written FAA style, as in the PRD and on FAA airport diagrams: **number 1–36 with
no leading zero, then an optional `L`, `C` or `R`, in uppercase**. The parser accepts a
leading zero and lowercase, and normalizes them:

| Typed | Stored |
|---|---|
| `4L`, `04L`, `04l` | `'4L'` |
| `31r` | `'31R'` |
| `13` | `'13'` |
| `09C` | `'9C'` |
| `0L`, `37` | error: `invalid runway '37': the number must be 1–36` |
| `310` | error: `invalid runway '310': expected 1–36 with optional L, C or R (e.g. 31L)` |

OpenStreetMap writes runways as `04L/22R`. Airport data should store runway ends as `4L`, or
the loader should normalize them the same way, so names compare equal.

## Grammar

```
command       = callsign transmission
              | callsign "request-crossing" [runway]
              | "?" "say-again"
transmission  = instruction { "," instruction }

instruction   = "taxi" destination "via" route [ "hs" target { target } ]
              | "hs" target { target }                 (one hold-short per target)
              | "hold" | "continue"
              | "cross" runway { runway } [ "at" name ]
              | ("monitor" | "contact") ("tower" | "ramp") [frequency]
              | "neg" part { part }                    (each part at most once)
              | "atis" letter [ "alt" altimeter ]
              | "say-again"
              | "ground-stop" name
              | "release" time
              | "hold-for-release"
              | "delay" minutes

destination   = runway | "ramp" [name] | "pad" [name] | "penalty" [name]
              | "hardstand" [name] | "hangar" [name]
route         = routeItem { routeItem }
routeItem     = [ "L:" | "R:" ] name
target        = runway | name                          (bare digit-first token = runway)
part          = "to" destination | "via" route | "turn" turnItem { turnItem }
              | "hs" target { target } | "cross" runway { runway } [ "at" name ]
turnItem      = ("L:" | "R:") name

callsign      = letter-first letters/digits containing a digit      DAL4, N123AB
name          = letter-first letters/digits | "#" letters/digits     KE, C1, #13
runway        = 1–36 with optional L/C/R, leading zero allowed       31L, 04L, 13
frequency     = three digits "." one to three digits, 118–136 MHz    119.1, 125.05
letter        = one letter A–Z
altimeter     = four digits                                          2992
time          = HHMM or HH:MM, 00:00–23:59                           1452, 14:52
minutes       = whole number ≥ 1                                     20
```

Lists of names, runways and targets end at the next keyword, comma or end of input.

## Commands

### C1, C2, C6: taxi

`taxi <destination> via <route> [hs <targets>]`

The destination is one of:

- a runway (C1)
- `ramp [name]` (C2): `ramp T4`, or just `ramp` for the aircraft's own ramp
- `pad [name]` (C6): a holding pad; unnamed means the sim picks one
- `penalty [name]` (C6): the penalty box; unnamed means the sim picks one
- `hardstand [name]`: ground-controlled parking off the ramp, e.g. JFK's South Hardstand;
  unnamed means the sim picks one
- `hangar [name]`: a hangar. Unnamed means **the company hangar**, the aircraft's own airline's,
  which is how it's usually said (Q). A name matches a hangar's id, name or one of its
  airlines, so `hangar DAL` is the Delta hangar.

A named pad, penalty box or hardstand matches the area's id, name or one of its spoken names,
ignoring case (`pad KILO`, `penalty QUEBEC`). A spoken name with a space ("Kilo pad") can't be
typed as one name; the AI interpreter can still output it.

`via` is required and takes at least one route item. `hs` is optional, appears at most once,
and lists every hold-short of this clearance in spoken order.

```
DAL4 taxi 31L via A R:KE hs B
→ {"type":"taxi","to":{"kind":"runway","name":"31L"},
   "via":[{"taxiway":"A","turn":null},{"taxiway":"KE","turn":"right"}],
   "holdShort":[{"kind":"taxiway","name":"B"}]}

UAE202 taxi ramp T4 via L:B KE
→ {"type":"taxi","to":{"kind":"ramp","name":"T4"},
   "via":[{"taxiway":"B","turn":"left"},{"taxiway":"KE","turn":null}],"holdShort":[]}

JBU387 taxi ramp via KF R:A
→ {"type":"taxi","to":{"kind":"ramp","name":null},
   "via":[{"taxiway":"KF","turn":null},{"taxiway":"A","turn":"right"}],"holdShort":[]}

VIR3 taxi penalty via KF B
→ {"type":"taxi","to":{"kind":"penalty-box","name":null},
   "via":[{"taxiway":"KF","turn":null},{"taxiway":"B","turn":null}],"holdShort":[]}

N123AB taxi hardstand via Q Q5
→ {"type":"taxi","to":{"kind":"hardstand","name":null},
   "via":[{"taxiway":"Q","turn":null},{"taxiway":"Q5","turn":null}],"holdShort":[]}

DAL4 taxi hangar via A KF
→ {"type":"taxi","to":{"kind":"hangar","name":null},
   "via":[{"taxiway":"A","turn":null},{"taxiway":"KF","turn":null}],"holdShort":[]}

DAL4 taxi hangar #17 via R:Q2
→ {"type":"taxi","to":{"kind":"hangar","name":"17"},
   "via":[{"taxiway":"Q2","turn":"right"}],"holdShort":[]}
```

**Out of the departure line (C6).** "Air France two three, exit the line at the next left,
Kilo Delta, and hold on the pad" is a taxi to the pad whose **first route item is the exit
taxiway**:

```
AFR23 taxi pad via L:KD
→ {"type":"taxi","to":{"kind":"pad","name":null},
   "via":[{"taxiway":"KD","turn":"left"}],"holdShort":[]}
```

No separate "exit" field exists. An aircraft in a departure line that gets a taxi clearance
leaves the line at the route's first taxiway, which must be one of the line's exits (PRD
§4.4: never along the runway). If that taxiway isn't an exit, the pilot is unable.

### C3: hold short

`hs <target> [<target> ...]`. A target is a runway (bare digit-first token) or a taxiway or
lane (name). It's used on its own, or after another instruction with a comma. Each target
gives **one `hold-short` instruction**:

```
ASA93 hs 4R      → {"type":"hold-short","target":{"kind":"runway","name":"4R"}}
ASA93 hs B 4R    → [{"type":"hold-short","target":{"kind":"taxiway","name":"B"}},
                    {"type":"hold-short","target":{"kind":"runway","name":"4R"}}]
SWR17 cross 22R at Y, hs B
```

Hold-shorts that are part of a taxi clearance go inside the `taxi` (`taxi … hs B`), not in a
following `hold-short`. Both give the same sim behaviour, but only the first is canonical
(see "Notes for task 0.4").

### C4: hold position / continue

```
JBU1123 hold      → {"type":"hold-position"}
IBE626 continue   → {"type":"continue"}
```

### C5: cross runway(s)

`cross <runway> [<runway> ...] [at <taxiway>]`. Each runway is named explicitly. FAA 7110.65
¶3-7-2 requires a clearance for each runway crossed, and allows several in one clearance
where centerlines are 1,300 ft apart or less. `at` is optional. Without it, the crossing is
wherever the aircraft's route next meets each runway.

```
DAL4 cross 31R at KE   → {"type":"cross","runways":["31R"],"at":"KE"}
DAL4 cross 4L 4R       → {"type":"cross","runways":["4L","4R"],"at":null}
QTR701 cross 31R at KE, taxi 31L via K
```

### C7: handoff

`monitor|contact tower|ramp [frequency]`. The frequency is in MHz, with trailing zeros
dropped (`123.900` becomes `'123.9'`).

```
BAW175 monitor tower 119.1  → {"type":"handoff","mode":"monitor","facility":"tower","frequency":"119.1"}
UAE202 contact ramp         → {"type":"handoff","mode":"contact","facility":"ramp","frequency":null}
```

### C8: correction

`neg <part> [<part> ...]`. A correction is "negative, …" after a wrong readback. See
"Corrections" below for exactly what it changes.

```
DAL4 neg hs B          → {"type":"correction","to":null,"via":null,"turns":[],
                          "holdShort":[{"kind":"taxiway","name":"B"}],"cross":null}
DLH405 neg turn R:KE   → {"type":"correction","to":null,"via":null,
                          "turns":[{"taxiway":"KE","turn":"right"}],"holdShort":null,"cross":null}
AAL100 neg to 31L      → {"type":"correction","to":{"kind":"runway","name":"31L"},"via":null,
                          "turns":[],"holdShort":null,"cross":null}
EIN104 neg via A J hs B → {"type":"correction","to":null,
                          "via":[{"taxiway":"A","turn":null},{"taxiway":"J","turn":null}],
                          "turns":[],"holdShort":[{"kind":"taxiway","name":"B"}],"cross":null}
DAL4 neg cross 31R at KE
```

### C9: ATIS

`atis <letter> [alt <altimeter>]`: "information Papa is current, altimeter two niner niner
two".

```
JBU615 atis P alt 2992  → {"type":"atis","letter":"P","altimeter":"2992"}
```

### C10: say again

```
KLM644 say-again  → {"type":"transmission","callsign":"KLM644","instructions":[{"type":"say-again"}]}
? say-again       → {"type":"transmission","callsign":null,"instructions":[{"type":"say-again"}]}
```

`? say-again` is "aircraft calling Ground, say again your callsign". It goes to whoever just
called and wasn't understood.

### C12: delays and restrictions

```
DAL1204 ground-stop ATL   → {"type":"ground-stop","destination":"ATL"}
JBU615 release 1452       → {"type":"release-time","time":"14:52"}    (14:52 also accepted)
UAL1416 hold-for-release  → {"type":"hold-for-release"}
RPA3560 delay 20          → {"type":"expect-delay","minutes":20}
```

These combine with each other and with a move to a pad or the penalty box:
`RPA3560 ground-stop BOS, delay 20` and `DAL1204 ground-stop ATL, taxi penalty via R:KC`.

### Crossing request (not a radio call)

```
DAL4 request-crossing      → {"type":"crossing-request","callsign":"DAL4","runway":null}
DAL4 request-crossing 31R  → {"type":"crossing-request","callsign":"DAL4","runway":"31R"}
```

`runway: null` means the next runway crossing on the aircraft's route, or the next runway ahead
of it if it has no route (PRD §4.5). In the game this comes from the T key. The terse form
exists for the console and for tests.

## Corrections

A pilot sometimes reads back wrong: wrong runway, wrong taxiway, wrong turn, or a missed
hold-short (PRD §4.6). If it isn't caught, the pilot flies their readback. The game's own
mishearings behave the same way. So the **aircraft's current clearance** is the version the
pilot will fly: their readback, including any mistake.

A `correction` changes that current clearance. **Each part it gives replaces that part. Parts
it doesn't give stand.**

| Part | Field | Effect |
|---|---|---|
| `to <destination>` | `to` | Replaces the taxi destination. |
| `via <route>` | `via` | Replaces the whole route. |
| `turn <L:/R: items>` | `turns` | Sets the turn on the first route item with that taxiway. The rest of the route is unchanged. If the route has no such taxiway, the pilot is unable. |
| `hs <targets>` | `holdShort` | Replaces the whole hold-short list. **To keep a hold-short, restate it.** |
| `cross <runways> [at <taxiway>]` | `cross` | Replaces the most recent crossing clearance. |

A correction has at least one part. `via` and `turn` are never used together; put the turns in
the `via` route. A correction can be followed by other instructions after a comma:
`DAL4 neg hs B, monitor tower`.

The four corrections in the voice test set (lines 26–29 of
`spikes/voice-loop/test-set/script.md`), with the original clearance, the wrong readback, and
the result:

| Line | Cleared | Read back | Correction | Result |
|---|---|---|---|---|
| 26 | 31L via A R:KE, hs B | 31L via A R:KE | `neg hs B` | hold-shorts: [B] |
| 27 | 31L via L:A R:KE, hs 31R K | …L:A **L:KE**… | `neg turn R:KE` | KE turn: right; A stays L |
| 28 | 31L via A KF, hs 31R | **31R** via A KF | `neg to 31L` | destination: 31L |
| 29 | 31L via A J, hs B | 31L via **B** J, hs **A** | `neg via A J hs B` | route [A, J], hold-shorts [B] |

A hold-short given on its own, without `neg` (`DAL4 hs 31R`), **adds** to the list. A
correction's `hs` **replaces** the list. Use `neg` when the readback had a wrong hold-short
that must be removed.

## How the sim applies commands

This is the intended meaning, the contract for tasks 1.8–1.12. Those tasks implement it. If
one needs to change it, update this section and note it in STATUS.

- A transmission's instructions apply **in order**.
- **`taxi`** replaces the aircraft's destination, route and hold-short list, and releases a
  hold-position. Crossing clearances already given still stand. They name a runway and apply
  where the route meets it, so `cross 31R at KE, taxi 31L via K` works.
- **`hold-short`** adds one target to the hold-short list. The aircraft stops at the next
  point where its route meets that taxiway or runway.
- Aircraft **always** stop at a runway hold-short unless they have a crossing clearance for
  that runway (PRD §4.5). A runway hold-short in a clearance is then redundant for the sim,
  but it is still recorded, because it's what the pilot reads back.
- **`hold-position`** stops the aircraft now. Its clearance is kept.
- **`continue`** releases a hold-position, or the **taxiway** hold-short it's stopped at.
  It never releases a runway hold-short; that takes `cross`.
- **`cross`** clears the aircraft across each listed runway: at `at`, or where its route next
  meets the runway. If it's stopped short of one, it goes. Whether tower had approved the
  crossing is checked when the aircraft enters the runway (unauthorized crossing, PRD §4.5).
- **`handoff`** hands the aircraft to tower or ramp. Its clearance is unchanged. The receiving
  facility takes it at its handoff point: the runway hold-short for tower (1.10), the ramp
  entrance for ramp (1.11).
- **`correction`**: see "Corrections".
- **`atis`** gives the pilot the current letter. It fixes an out-of-date-ATIS mistake.
- **`say-again`**: the pilot repeats their last transmission.
- **C12 advisories** inform the pilot, who acknowledges. They don't move the aircraft. A
  move goes with them as a separate `taxi`.
- **`crossing-request`** goes to the simulated tower (1.10), which approves it, or holds it
  and calls back.

## Errors

`parseTerse` stops at the **first** problem. It returns `{ ok: false, error: { message,
offset } }`, where `offset` is the 0-based character position of the offending token, or the
input length when the problem is "end of input". Messages follow the pattern
`expected <what> after '<previous token>', got '<token>'`, and quote tokens as typed.
Examples, all of them tested:

| Input | Message |
|---|---|
| `DAL4 cross KE` | `expected runway after 'cross', got 'KE'` |
| `DAL4 cross 31R KE` | `expected runway or 'at' after '31R', got 'KE'` |
| `DAL4 cross 31R at KE hs B` | `expected ',' before 'hs' (separate instructions with commas)` |
| `DAL4 taxi 31L A R:KE` | `expected 'via' after '31L', got 'A'` |
| `DAL4 taxi via A` | `expected runway, 'ramp', 'pad', 'penalty', 'hardstand' or 'hangar' after 'taxi', got 'via'` |
| `DAL4 taxi hangar 17 via A` | `expected hangar name after 'hangar', got '17' (a bare number is a runway; write a name that starts with a digit as '#17')` |
| `DAL4 taxi hardstand south` | `expected 'via' after 'south', got end of input` |
| `DAL4 taxi 31L via A, R:KE` | `expected an instruction after ',', got 'R:KE'` |
| `DAL4 taxi 31L via X:KE` | `unknown turn 'X:' in 'X:KE' (use L: or R:)` |
| `DAL4 taxi 31L via A hs B hs K` | `duplicate 'hs' in taxi clearance; list every hold-short after one 'hs' (e.g. 'hs B 31R')` |
| `AAL22 taxi ramp B via A 13` | `expected taxiway after 'A', got '13' (a bare number is a runway; write a name that starts with a digit as '#13')` |
| `DAL4 taxi 37 via A` | `invalid runway '37': the number must be 1–36` |
| `DAL4 hs L:B` | `a turn (L:/R:) is only allowed on route items, got 'L:B' after 'hs'` |
| `DAL4 monitor ground` | `expected 'tower' or 'ramp' after 'monitor', got 'ground'` |
| `DAL4 monitor tower 1191` | `expected frequency like 119.1 after 'tower', got '1191'` |
| `DAL4 neg B` | `expected 'to', 'via', 'turn', 'hs' or 'cross' after 'neg', got 'B'` |
| `DAL4 neg via A turn R:KE` | `a correction can't have both 'via' and 'turn'; put the turns in the 'via' route` |
| `DAL4 release 1460` | `invalid release time '1460': minutes must be 00–59` |
| `taxi 31L via A` | `expected callsign (e.g. DAL4), got 'taxi'` |
| `DAL4` | `expected an instruction after 'DAL4', got end of input` |
| `? taxi 31L via A` | `only 'say-again' can be addressed to an unknown station '?', got 'taxi'` |
| `DAL4 request-crossing, hold` | `'request-crossing' is a key-press action, not a radio call; it can't be combined with other input, got ','` |

The full list is the `malformed input` table in `src/sim/terse.test.ts`.

The parser can't catch a typo that is still a valid name. In `via A KE hss B`, `HSS` is read as
a taxiway, and only the airport-data check flags it as unknown.

## Not expressible, or deliberately dropped

- **C11 follow / give way:** cut first (PRD §7). No command exists.
- **Information with no sim effect** isn't recorded: traffic advisories ("traffic on short
  final", "a Delta seven sixty-seven passing left to right"), sequence ("number two for
  departure"), and pleasantries. The command is what the aircraft must do.
- **"When you get there"** on a handoff ("monitor ramp when you get there") isn't recorded.
  Every handoff takes effect at the facility's handoff point anyway (see "How the sim applies
  commands").
- **Removing every hold-short** in a correction ("negative, no hold-short") has no form; `neg
  hs` needs at least one target.
- **Taxiing along a runway** as a route item isn't supported. Route items are taxiways and
  lanes only. The numeric-name rule keeps room to add runway route items later without
  ambiguity.
- **Names with spaces or punctuation** can't be typed. Airport data should give every
  addressable feature a single-token ID (letters and digits).

## Notes for task 0.4 (interpreter output)

The interpreter must produce `Transmission` objects (`commands.ts`). The crossing request is
a key press and never comes from speech. To make exact-match scoring meaningful, expected
outputs use the canonical form:

- Every field is present, with `null` or `[]` when not given.
- Instructions appear in spoken order. Hold-shorts given with a taxi clearance go in
  `taxi.holdShort`. A standalone hold-short is one `hold-short` instruction per target.
- Callsigns are ICAO flight IDs, uppercase, without "heavy". Runways are FAA style
  (`4L`, not `04L`). Names are uppercase.
- The `expected` column of `spikes/voice-loop/test-set/script.md` can be filled with terse
  strings and turned into objects with `parseTerse`.
