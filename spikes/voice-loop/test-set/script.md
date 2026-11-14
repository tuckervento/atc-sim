# Voice-loop test set: script

Task 0.2 in `PLAN.md`. Thirty-four JFK Ground transmissions for Q to record with the recorder
(`node spikes/voice-loop/recorder/server.mjs`). Each one is something the ground controller (Q)
says to a pilot, plus the pilot's reply. Recordings go to `test-set/audio/NN.webm` (gitignored).
Tasks 0.3 (speech-to-text) and 0.4 (interpreter) score against this file.

- **Runway configuration:** land 31R, depart 31L.
- **Current ATIS:** information Papa, altimeter 29.92 ("two niner niner two"). Oscar is the
  previous, out-of-date letter.
- **Phrasing mix:** 13 textbook lines and 21 loose ones ("go ahead and…", dropped words,
  reordered routes, fillers). PRD §6.1 makes natural phrasing the goal.
- **Edited after recording (2026-11-14):** the `say` text of 05, 10, 27, 30 and 32 now matches
  what Q actually said, found in 0.3. Line 32's readback changed to match its new delay.

## Coverage checklist

Types are the command types in PRD §7. A line can cover more than one. A hold-short given
inside a taxi clearance counts as part of C1 or C2. C3 lines are hold-short instructions on
their own, or tacked on after another instruction.

| Type | Instruction | Lines |
|---|---|---|
| C1 | Taxi to runway via route, with turn directions and hold-shorts | 01, 02, 03, 04, 05, 06, 19 |
| C2 | Taxi to ramp / terminal via route | 08, 09, 10 |
| C3 | Hold short of a taxiway or runway | 11, 12, 13, 18 |
| C4 | Hold position / continue taxi | 14, 15, 16 |
| C5 | Cross runway (after tower approval) | 17, 18, 19 |
| C6 | Send to holding pad / penalty box, including out of the departure line | 20, 21, 22, 23 |
| C7 | Handoff (monitor tower, contact / monitor ramp) | 09, 24, 25 |
| C8 | Correction of a wrong readback | 26, 27, 28, 29 |
| C9 | ATIS correction | 06, 07 |
| C10 | Player "say again" | 30, 31 |
| C11 | Follow / give way (optional; 1.2 has no C11 command, so 0.4 may skip it) | 34 |
| C12 | Delay or restriction advisory | 21, 22, 32, 33 |

Specific things the plan asks for:

| Feature | Lines |
|---|---|
| Turn directions ("right on", "left", "next left") | 01, 05, 08, 09, 10, 20, 21, 27 |
| Multiple hold-shorts in one clearance | 02, 05 |
| Hold short of a runway | 02, 03, 05, 11, 12 |
| Runway crossing | 17 (31R), 18 (22R), 19 (31R) |
| Pulled out of the departure line at the next exit | 20, 21 |
| Arrival parked because its gate is occupied | 23 |
| Ground stop | 21, 32 |
| Release time / hold for release | 22, 33 |
| Readback corrections: missed hold-short, wrong turn, wrong runway, wrong taxiway | 26, 27, 28, 29 |
| Out-of-date ATIS letter | 06, 07 |
| Say again with a known callsign / an unreadable callsign | 30, 31 |
| Handoffs: monitor tower, contact ramp, monitor ramp | 24, 25, 09 |
| Textbook phrasing | 01, 02, 06, 08, 11, 14, 17, 20, 24, 26, 31, 32, 33 |
| Loose phrasing | 03, 04, 05, 07, 09, 10, 12, 13, 15, 16, 18, 19, 21, 22, 23, 25, 27, 28, 29, 30, 34 |

## Format

The recorder (`recorder/script.mjs`) and later tasks parse this file. It fails loudly on
anything malformed.

- Each line starts with a level-3 heading made of exactly two digits: `### 01`, `### 02`, …
  Numbers are unique and ascending.
- The heading is followed by fields, one per row, in the form `- key: value`. The value is the
  rest of that row, with no line wrapping. Blank rows are allowed.
- Keys (lowercase):
  - `types`: required. PRD §7 command types, comma-separated, e.g. `C5, C3`.
  - `style`: required. `textbook` or `loose`.
  - `context`: optional. What happened just before: the pilot's call, a wrong readback, or a
    tower approval. Q doesn't say it. It's there for 0.4's fake game context.
  - `say`: required. Exactly what Q says and records. Numbers and letters are written as
    spoken words ("three one left", "Kilo Echo"), so it doubles as the reference transcript
    for 0.3. Scoring should normalize case, punctuation, hyphens and number formats.
  - `readback`: required. The pilot's reply, callsign last. On say-again lines (C10) it's the
    pilot repeating their call.
  - `expected`: required. The command in 1.2's terse syntax. It's `TODO(0.4)` until task 0.4
    fills it in.
- Any other heading (`#`, `##`, or a `###` that isn't two digits) ends the current line.
  Text outside line entries, and anything inside fenced code blocks, is ignored. Any other
  text inside an entry is an error.

Example:

```
### 99
- types: C4
- style: textbook
- context: Departure taxiing on Alpha.
- say: Delta four, hold position.
- readback: Holding position, Delta four.
- expected: TODO(0.4)
```

## Names, and how sure I am they exist at JFK

None of these has been checked against the FAA airport diagram; task 1.3 does that. Names
marked **[?]** are plausible guesses that may not exist at JFK. That's acceptable for testing
hearing and interpretation, but they mustn't be copied into airport data without checking.

| Name (spoken) | Used in | Confidence |
|---|---|---|
| Runways 13L/31R, 13R/31L, 4L/22R, 4R/22L | many | Real (PRD). The 13s are only referred to by their 31 ends, as in a 31s configuration. |
| A, B (Alpha, Bravo) | many | Believed real: the two taxiways ringing the central terminal area. Which one is the inner ring is **[?]**. |
| K, KD, KE, KF (Kilo, Kilo Delta / Echo / Foxtrot) | many | From the PRD and plan examples. Believed real, unverified. |
| KC (Kilo Charlie) | 21 | **[?]** |
| KK (Kilo Kilo) | 22 | **[?]** |
| H (Hotel) | 10 | **[?]** |
| J (Juliet) | 04, 29 | **[?]** |
| Y (Yankee) | 18 | **[?]** |
| "the pad", "the penalty box" | 20–23 | Generic. JFK's real holding pads and penalty box are 1.3's job. |
| Terminals 4, 5, 8 | many (mostly in `context`) | Believed real through the rebuild (Delta/Emirates/KLM at 4, JetBlue/Aer Lingus at 5, American at 8). |
| "Kennedy Ground" | 07, 31 | Believed to be JFK Ground's radio name. |
| Tower on 119.1 ("one one niner point one") | 24 | **[?]** Believed to be a JFK tower frequency. |

**Assumed geometry, for consistency between lines only (all [?]):** Alpha is the inner ring and
Bravo the outer. Ramps are entered from Alpha. The connectors KD, KE and KF run outward from the
rings across 31R to Kilo, and Kilo is the 31L departure line. The departure line's exits include KC and
KD, and the pads sit off it. Arrivals exit 31R onto KD, KE or KF. Some routes cross the
inactive 4L/22R and 4R/22L. Routes are plausible, not real. These lines test hearing and
interpretation, not routing.

Where a callsign appears more than once, the lines tell one flight's story: Delta four in 01,
26, 12 and 17; JetBlue eleven twenty-three in 02, 14 and 34; JetBlue six one five in 07 and 22;
Emirates two zero two heavy in 08, 25 and 34; Iberia in 13 and 15; Speedbird in 16 and 24;
American one hundred in 03 and 28; Shamrock in 04 and 29; Lufthansa in 05 and 27.

## Lines

### 01
- types: C1
- style: textbook
- context: Departure. Pilot: "Ground, Delta four, taxiing out of the Terminal Four ramp, information Papa."
- say: Delta four, runway three one left, taxi via Alpha, right on Kilo Echo, hold short of Bravo.
- readback: Three one left, Alpha, right Kilo Echo, hold short Bravo, Delta four.
- expected: TODO(0.4)

### 02
- types: C1
- style: textbook
- context: Departure. Pilot: "Ground, JetBlue eleven twenty-three, out of the Terminal Five ramp, information Papa."
- say: JetBlue eleven twenty-three, three one left, taxi via Alpha, Kilo Delta, hold short of Bravo and hold short of runway three one right.
- readback: Three one left, Alpha, Kilo Delta, hold short Bravo and three one right, JetBlue eleven twenty-three.
- expected: TODO(0.4)

### 03
- types: C1
- style: loose
- context: Departure. Pilot: "Ground, American one hundred, Terminal Eight, ready to taxi with Papa."
- say: American one hundred, okay, three one left, go ahead and take Alpha to Kilo Foxtrot, hold short three one right.
- readback: Three one left, Alpha, Kilo Foxtrot, hold short three one right, American one hundred.
- expected: TODO(0.4)

### 04
- types: C1
- style: loose
- context: Departure. Pilot: "Ground, Shamrock one zero four, Terminal Five, information Papa."
- say: Shamrock one zero four, three one left, Alpha, Juliet, hold short Bravo.
- readback: Three one left, Alpha, Juliet, hold short Bravo, Shamrock one zero four.
- expected: TODO(0.4)

### 05
- types: C1
- style: loose
- context: Departure. Pilot: "Ground, Lufthansa four zero five heavy, ready to taxi, information Papa."
- say: Lufthansa four zero five heavy, left on Alpha, right on Kilo Echo, three one left, hold short three one right, then hold short Kilo.
- readback: Left Alpha, right Kilo Echo, three one left, hold short three one right, then Kilo, Lufthansa four zero five heavy.
- expected: TODO(0.4)

### 06
- types: C1, C9
- style: textbook
- context: Departure reporting the out-of-date ATIS. Pilot: "Ground, Delta twenty-three forty, taxiing out of the Terminal Four ramp, with Oscar."
- say: Delta twenty-three forty, information Papa is current, altimeter two niner niner two, runway three one left, Alpha, Kilo Delta, hold short Bravo.
- readback: Papa, two niner niner two, three one left, Alpha, Kilo Delta, hold short Bravo, Delta twenty-three forty.
- expected: TODO(0.4)

### 07
- types: C9
- style: loose
- context: Departure reporting the out-of-date ATIS. Pilot: "Ground, JetBlue six one five, Terminal Five, ready to taxi, information Oscar."
- say: JetBlue six one five, Kennedy Ground, Oscar's old, information Papa is current, altimeter two niner niner two.
- readback: Copy Papa, two niner niner two, JetBlue six one five.
- expected: TODO(0.4)

### 08
- types: C2
- style: textbook
- context: Arrival for Terminal Four. Pilot: "Ground, Emirates two zero two heavy, clear of three one right at Kilo Echo."
- say: Emirates two zero two heavy, taxi to the Terminal Four ramp via Kilo Echo, left on Alpha.
- readback: Terminal Four ramp via Kilo Echo, left Alpha, Emirates two zero two heavy.
- expected: TODO(0.4)

### 09
- types: C2, C7
- style: loose
- context: Arrival for Terminal Five. Pilot: "Ground, JetBlue three eighty-seven, clear three one right at Kilo Foxtrot."
- say: JetBlue three eighty-seven, alright, Kilo Foxtrot, right on Alpha into the ramp, and monitor ramp when you get there.
- readback: Kilo Foxtrot, right Alpha to the ramp, monitor ramp, JetBlue three eighty-seven.
- expected: TODO(0.4)

### 10
- types: C2
- style: loose
- context: Arrival for Terminal Eight. Pilot: "Ground, American one forty-two heavy, clear of three one right at Kilo Delta."
- say: American one forty-two heavy, gonna be Kilo Delta, right on Bravo, left Hotel to Terminal Eight, hold short Alpha.
- readback: Kilo Delta, right Bravo, left Hotel, hold short Alpha, American one forty-two heavy.
- expected: TODO(0.4)

### 11
- types: C3
- style: textbook
- context: Alaska niner three is taxiing toward runway four right. It's inactive in this configuration, but every runway still needs a crossing clearance.
- say: Alaska niner three, hold short of runway four right.
- readback: Hold short four right, Alaska niner three.
- expected: TODO(0.4)

### 12
- types: C3
- style: loose
- context: Delta four (after 01 and 26) has been told to continue past Bravo on Kilo Echo. It's approaching runway three one right, with an arrival on short final.
- say: Delta four, actually, I need you to hold short of three one right, traffic on short final.
- readback: Holding short three one right, Delta four.
- expected: TODO(0.4)

### 13
- types: C3
- style: loose
- context: Departure approaching Bravo while a Delta Boeing 767 taxis along Bravo. The "Delta seven sixty-seven" isn't the addressee.
- say: Iberia six two six heavy, hold short of Bravo, you'll have a Delta seven sixty-seven passing left to right.
- readback: Hold short Bravo, Iberia six two six heavy.
- expected: TODO(0.4)

### 14
- types: C4
- style: textbook
- context: JetBlue eleven twenty-three (02) taxiing on Alpha.
- say: JetBlue eleven twenty-three, hold position.
- readback: Holding position, JetBlue eleven twenty-three.
- expected: TODO(0.4)

### 15
- types: C4
- style: loose
- context: Iberia six two six heavy (13) holding short of Bravo. The Delta has passed.
- say: Iberia six two six heavy, traffic's by, go ahead and continue, thanks for waiting.
- readback: Continuing, Iberia six two six heavy.
- expected: TODO(0.4)

### 16
- types: C4
- style: loose
- context: Speedbird one seven five heavy taxiing on Kilo. The aircraft ahead has stopped suddenly.
- say: Speedbird one seven five heavy, stop, stop, hold your position.
- readback: Holding position, Speedbird one seven five heavy.
- expected: TODO(0.4)

### 17
- types: C5
- style: textbook
- context: Delta four (12) holding short of runway three one right on Kilo Echo. Tower: "Cross three one right at Kilo Echo approved."
- say: Delta four, cross runway three one right at Kilo Echo.
- readback: Cross three one right at Kilo Echo, Delta four.
- expected: TODO(0.4)

### 18
- types: C5, C3
- style: loose
- context: Arrival holding short of runway two two right on Yankee. Tower approved the crossing.
- say: Swiss one seven heavy, go ahead and cross two two right at Yankee, then hold short of Bravo.
- readback: Cross two two right at Yankee, hold short Bravo, Swiss one seven heavy.
- expected: TODO(0.4)

### 19
- types: C5, C1
- style: loose
- context: Departure for three one left holding short of runway three one right on Kilo Echo. Tower approved the crossing.
- say: Qatari seven zero one heavy, at Kilo Echo, cross three one right, then Kilo to three one left.
- readback: Cross three one right at Kilo Echo, Kilo to three one left, Qatari seven zero one heavy.
- expected: TODO(0.4)

### 20
- types: C6
- style: textbook
- context: Air France two three heavy is in the three one left departure line on Kilo, but its release time is still twenty minutes away.
- say: Air France two three heavy, exit the line at the next left, Kilo Delta, and hold on the pad.
- readback: Exit left at Kilo Delta, hold on the pad, Air France two three heavy.
- expected: TODO(0.4)

### 21
- types: C12, C6
- style: loose
- context: Delta twelve oh four, bound for Atlanta, is in the three one left departure line on Kilo when a ground stop for Atlanta comes in.
- say: Delta twelve oh four, bad news, ground stop for Atlanta, take the next right at Kilo Charlie and head over to the penalty box.
- readback: Ground stop Atlanta, right Kilo Charlie to the penalty box, Delta twelve oh four.
- expected: TODO(0.4)

### 22
- types: C12, C6
- style: loose
- context: JetBlue six one five (07) has a release time of 1452, well in the future.
- say: JetBlue six one five, release time one four five two for you, taxi to the pad via Alpha, Kilo Kilo, and sit tight.
- readback: Fourteen fifty-two release, pad via Alpha, Kilo Kilo, JetBlue six one five.
- expected: TODO(0.4)

### 23
- types: C6
- style: loose
- context: Arrival whose gate is occupied. Pilot: "Ground, Virgin three, clear of three one right at Kilo Foxtrot, our gate's still occupied."
- say: Virgin three, roger, taxi to the penalty box via Kilo Foxtrot, Bravo, and let me know when your gate opens up.
- readback: Penalty box via Kilo Foxtrot, Bravo, Virgin three.
- expected: TODO(0.4)

### 24
- types: C7
- style: textbook
- context: Speedbird one seven five heavy (16) at the runway three one left hold-short line, second in line.
- say: Speedbird one seven five heavy, number two for departure, monitor tower one one niner point one.
- readback: Monitor tower one one niner point one, Speedbird one seven five heavy.
- expected: TODO(0.4)

### 25
- types: C7
- style: loose
- context: Emirates two zero two heavy (08) at the Terminal Four ramp entrance.
- say: Emirates two zero two heavy, contact ramp, so long.
- readback: Over to ramp, so long, Emirates two zero two heavy.
- expected: TODO(0.4)

### 26
- types: C8
- style: textbook
- context: Wrong readback of 01, leaving out the hold-short. Pilot: "Three one left, Alpha, right Kilo Echo, Delta four."
- say: Delta four, negative, hold short of Bravo, hold short Bravo.
- readback: Hold short Bravo, Delta four.
- expected: TODO(0.4)

### 27
- types: C8
- style: loose
- context: Wrong readback of 05, with the wrong turn direction. Pilot: "Left Alpha, left Kilo Echo, three one left, hold short three one right, then Kilo, Lufthansa four zero five heavy."
- say: Lufthansa four zero five heavy, negative, that's a right turn on Kilo Echo, right on Kilo Echo.
- readback: Right on Kilo Echo, Lufthansa four zero five heavy.
- expected: TODO(0.4)

### 28
- types: C8
- style: loose
- context: Wrong readback of 03, with the wrong runway. Pilot: "Three one right, Alpha, Kilo Foxtrot, hold short three one right, American one hundred."
- say: American one hundred, nope, departure runway is three one left, not right.
- readback: Three one left, American one hundred.
- expected: TODO(0.4)

### 29
- types: C8
- style: loose
- context: Wrong readback of 04, with Alpha and Bravo swapped. Pilot: "Three one left, Bravo, Juliet, hold short Alpha, Shamrock one zero four."
- say: Shamrock one zero four, negative, you've got them backwards, it's Alpha, Juliet, hold short Bravo.
- readback: Alpha, Juliet, hold short Bravo, Shamrock one zero four.
- expected: TODO(0.4)

### 30
- types: C10
- style: loose
- context: Two aircraft transmitted at once. Only "KLM six four four heavy" was readable.
- say: KLM six four four heavy, sorry, you got stepped on, go ahead and say it again.
- readback: Ground, KLM six four four heavy, Terminal Four, ready to taxi with Papa.
- expected: TODO(0.4)

### 31
- types: C10
- style: textbook
- context: A pilot called, but the callsign was unreadable: "Ground, [unreadable], clear of three one right at Kilo Foxtrot."
- say: Aircraft calling Kennedy Ground, say again your callsign.
- readback: Ground, Aeromexico four zero niner, clear of three one right at Kilo Foxtrot.
- expected: TODO(0.4)

### 32
- types: C12
- style: textbook
- context: Brickyard thirty-five sixty, bound for Boston, is taxiing on Alpha when a ground stop for Boston comes in.
- say: Brickyard thirty-five sixty, ground stop for Boston, expect twenty thirty minutes.
- readback: Ground stop Boston, twenty to thirty minutes, Brickyard thirty-five sixty.
- expected: TODO(0.4)

### 33
- types: C12
- style: textbook
- context: United fourteen sixteen has called ready to taxi. Traffic management has it on hold for release.
- say: United fourteen sixteen, hold for release, expect one five minutes departure delay.
- readback: Hold for release, one five minutes, United fourteen sixteen.
- expected: TODO(0.4)

### 34
- types: C11
- style: loose
- context: Optional C11 line; 0.4 may skip it. JetBlue eleven twenty-three (02) is on Alpha, and Emirates two zero two heavy (08) is turning from Kilo Echo onto Alpha.
- say: JetBlue eleven twenty-three, give way to the Emirates heavy coming off Kilo Echo, then follow him on Alpha.
- readback: Give way to the Emirates, then follow him on Alpha, JetBlue eleven twenty-three.
- expected: TODO(0.4)
