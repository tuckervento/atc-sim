# Phase 1 manual test: one departure and one arrival at KJFK

PLAN 1.13's acceptance: Q completes this in Chrome, **using only typed commands and the T key**,
and the counters show **1 departure and 1 arrival**. Q's result goes in STATUS.

- **Takes:** about 11 minutes of sim time; about 3–5 real minutes at 4×, plus pauses.
- **Its scripted twin:** `src/web/game/manual-test.test.ts` does exactly the steps below, on the
  same seed, through the same session calls the app makes (Enter in the console, T on a selected
  aircraft), reacting only to the log lines below. `npm test` runs it. If you change this doc,
  change the twin to match, and the other way round.

## What you'll do

| Aircraft | | Route |
|---|---|---|
| **WJA3571**, WestJet 737-800, departure | T4 gate → pushback → checks in on **G** | `taxi 31L via G`, crossing **4L** at G, to the **31L** hold at Z, then tower |
| **ANA7953**, ANA 787-9, arrival | lands **31R**, exits right onto **D** | `taxi ramp T7 via W`, crossing **31R** at W back to the T7 side, then ramp to its gate |

Both runway crossings need tower's approval first (the T key), then your `cross` instruction.
4L/22R isn't in use on the 31s, so tower approves that one at once; 31R is landing traffic, so
tower may hold you (see "If tower holds the crossing").

## Before you start

1. In the repo: `npm run dev`. It prints a local URL, `http://localhost:5173/`.
2. Open this in Chrome: **`http://localhost:5173/?airport=KJFK&seed=5`**. The seed must be 5: it
   picks the traffic.
3. The side panel shows `KJFK · seed 5`, a clock at `0:00`, and the counters at 0. (The rate
   shows `—` until the clock has run a moment.)
4. Click **4×**. Use 4× while waiting; the steps below say when something needs you.

**Keys and the console:**
- The console is the text box at the bottom right. Type a command, press **Enter**. A typing
  mistake shows an error under the box and keeps your text; fix it and press Enter again.
- **Click an aircraft** on the map to select it: it's highlighted, and its callsign is put in the
  console for you. Its label (callsign and type) is clickable too, which is easier at the full-airport
  view; the mouse wheel zooms in.
- **T** asks tower for the selected aircraft's next runway crossing. **P** pauses and resumes.
  These keys only work when the cursor is **not** in the console: click the map first, or press
  **Esc**. After you press Enter on a command the cursor is still in the console, so it's **Esc,
  then P** to resume.
- **Pause (P) whenever you need time.** Commands you type while paused apply at once. Tower
  answers a crossing request after a few seconds of sim time, so resume after pressing T.

**The other traffic.** Other departures check in and other arrivals call clear of the runway.
Leave them alone: they wait where they called, out of these two aircraft's way. Their lines in the
log can be ignored.

## The steps

Times are the sim clock (m:ss) at the top of the side panel, from the scripted run; yours will be
within a few seconds, and later if you pause. Each step starts with a line in the log.

| # | ~Time | You see in the log | You do | Then you see |
|---|---|---|---|---|
| 1 | 0:00–5:30 | Nothing for these two yet. On the map: WJA3571 appears at T4 gate B31 at 0:34, pushes back from 1:32 to 3:11 (the only backward move in the sim), and taxis along the ramp lanes from 3:41. ANA7953 appears on final for 31R at 2:36 and lands at 4:53. | Wait at 4×. | |
| 2 | 5:34 | `ANA7953 clear of 31R at D` | Type `ANA7953 taxi ramp T7 via W` | Your line echoed (`› ANA7953 taxi …`). ANA7953 taxis along D. |
| 3 | 6:17 | `WJA3571 taxiing on G` | Type `WJA3571 taxi 31L via G` | WJA3571 taxis out along G. |
| 4 | 6:41 | `ANA7953 holding short of 31R at W` | Click ANA7953 on the map (Esc first if the cursor is in the console), press **T** | `› ANA7953 request-crossing`, then about 3 s later `TWR: ANA7953 cross 31R at W approved` |
| 5 | 6:44 | `TWR: ANA7953 cross 31R at W approved` | **Press P to pause**, type `ANA7953 cross 31R`, Enter, then **Esc, P** to resume. Do it within a minute of sim time (15 s of real time at 4×), or tower withdraws the approval. | ANA7953 crosses 31R at W. |
| 6 | 6:54 | `WJA3571 holding short of 4L at G` | Click WJA3571, press **T** | `TWR: WJA3571 cross 4L at G approved` |
| 7 | 6:57 | `TWR: WJA3571 cross 4L at G approved` | P, type `WJA3571 cross 4L`, Enter, then Esc, P | WJA3571 crosses 4L and taxis on toward 31L. |
| 8 | 7:38 | `ANA7953 at the T7 ramp entrance W` | Type `ANA7953 monitor ramp` | Ramp takes it a moment later and taxis it in. |
| 9 | 8:34 | `ANA7953 arrived at T7 gate 10` (the gate may differ) | Nothing. | **Arrivals: 1.** |
| 10 | 9:36 | `WJA3571 holding short of 31L at Z` | Type `WJA3571 monitor tower` | Tower lines it up on 31L and clears it. |
| 11 | 10:58 | `WJA3571 took off 31L` | Nothing. | **Departures: 1.** |

**Done:** the counters show Departures 1, Arrivals 1, Total 2. Note the clock, and anything that
surprised you.

## If something goes differently

- **If tower holds the crossing:** instead of "approved" you see `TWR: ANA7953 hold short of 31R,
  traffic on final; will call back` (or another reason). Don't cross. Wait at 4×: when it's clear,
  tower calls back, `TWR callback: ANA7953 cross 31R at W approved`. Then pause and type
  `ANA7953 cross 31R` as in step 5.
- **If tower cancels the approval** (`TWR: … crossing 31R cancelled: …`): it wasn't used in time,
  or landing traffic came. Don't cross; select the aircraft and press T again.
- **If the pilot says unable:** the line is `ANA7953 unable (taxi): <why>`. Nothing changed: check
  the command against the table (a typo that's still a valid name, like `V` for `W`, gives this)
  and type it again. `… which way on X? Give the turn, L:X or R:X` means add the turn to that
  taxiway in the route.
- **If a typed command shows a red error** under the console: it didn't parse; nothing was sent.
  Fix the highlighted word and press Enter.
- **If T seems to do nothing:** the cursor is probably in the console (the T went into the text).
  Press Esc, click the aircraft, press T.
- **If `… is on tower's frequency` or `… ramp's frequency, not yours`:** the aircraft isn't yours
  yet (or any more). Wait for its call in the log.
- **If a red "Session over" banner appears** over the map: a collision or gridlock ended the
  session. It names the aircraft, where, and whose they were. The map keeps running but the
  counters stop. Note it, and screenshot it; that's a bug report, not a fail of yours, if you
  followed the steps.

## For the record

- Seed 5, scripted run: arrival scored at 8:34, departure at 10:58; no unauthorized crossings;
  the session still running.
- In Chrome (2026-11-16, the agent, at 4× with slower reactions than these times): the same
  lines in the same order, each later by the agent's delays (ANA7953 at its gate 11:44,
  WJA3571 off 15:02); the counters at 1, 1 and 2. End state: `docs/screenshots/kjfk-manual-test.png`.
- The arrival's route crosses the runway it landed on: tower sends it off 31R onto D, on the far
  side from T7, so it crosses back at W. In 12 seeds tried, no arrival's direct route to its
  terminal crossed 31L or 4L/22R; every departure's route to 31L crosses 4L/22R.
