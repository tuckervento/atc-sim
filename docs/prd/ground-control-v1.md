# PRD: ATC Ground Control Simulator — v1 (JFK Ground)

- **Owner:** Q
- **Date:** 2026-11-13. Revised 2026-11-14 after Q's first review.
- **Status:** Draft, pending Q's approval
- **Purpose of this doc:** source document for one or more implementation plans.

### How to read the decision tags

Every requirement carries a tag saying where it came from:

| Tag | Meaning |
|---|---|
| **[Q]** | Decided by Q. Don't change it without asking. |
| **[Proposal]** | Claude's call, made during design and not objected to. Revisable; flag it if a plan wants to change it. |
| **[Builder]** | Deliberately left to the implementer. |
| **[Unverified]** | A factual belief that hasn't been checked yet. Verify before building on it. |

---

## 1. Summary

A single-player, voice-driven air traffic control game. The player works **JFK Ground**: they key a push-to-talk button and speak natural ATC instructions, and simulated pilots answer with generated voices at the pace of a real busy frequency. The main screen is a 2D top-down map of the airport plus flight strips and a status bar. A session scores how many aircraft the player gets to the runway and to the gate, and counts the mistakes along the way. **[Q]**

## 2. Why this exists

Q enjoys listening to JFK Ground on busy days, with controllers sequencing traffic across runways and taxiways. The game lets Q be that controller. **[Q]**

- **Primary user:** Q, playing alone on their own Mac. **[Q]**
- **Possible later users:** flight sim enthusiasts. This shouldn't drive v1 scope, but v1 shouldn't make sharing impossible either. **[Q]**

## 3. Goals, non-goals, anti-goals

### Goals (v1)
1. Control ground traffic at JFK entirely by voice, using natural real-world phrasing rather than a memorized script. **[Q]**
2. Pilots answer in professional "pilot" voices at the speed and cadence of a busy ground frequency. **[Q]**
3. Busy sessions: at high traffic there is almost always someone on frequency. **[Q]**
4. A clear score and an end-of-session report that can be trusted (§4.8, §9.3). **[Q]**
5. **Airports are data from the start.** The next airports are **LGA, then PIT**, so nothing in the engine may assume JFK. An airport is a data file. **[Q]** The engine should also be able to grow into other positions (approach, departure) later without a rewrite. **[Q]**
6. **The three cloud AI services sit behind interfaces:** speech-to-text, the language model that interprets commands, and the pilot voices. Each interface could also be implemented with a local backend such as Ollama. **[Q]** Only those three are abstracted this way. The rest of the code is written directly. **[Proposal]**
7. **The game recognizes when the player is causing delays.** At minimum, it detects and reports departures that miss their release window (§4.4). **[Q]** Folding delays into the score comes later (§10). **[Q]**

### Stretch goals (v1)
- **A second runway configuration: the 4s.** Land 4L, depart 4R, as an alternative to the starting 31L/31R pair, defined in data. **[Q]**
- **Real flight numbers.** Traffic built from a dataset of real JFK flights, so a callsign matches its real route. **[Q]** The data source is still open (O-5).
- **Follow and give-way instructions** (§7, C11). The first thing cut if they're too hard. **[Q]**

### Non-goals (v1)
- Approach, departure or tower positions. **[Q]**
- The player handling pushback or talking in the ramp. Ramp traffic is simulated and drawn, but not controlled by the player. **[Q]**
- Radio static, bad connections or other degraded-audio effects. **[Q]**
- **Pilot accents.** Deferred, but the voice service picked in Phase 0 must be able to do them later (§6.2). **[Q]**
- Radio calls from tugs, tows, ground crew or vehicles. Deferred to later. **[Q]**
- Multiplayer, live real-world traffic, mobile. **[Proposal]**
- Weather affecting gameplay. ATIS shows weather for flavor only (§5). **[Proposal]**
- Changing the runway configuration mid-session. **[Proposal]**
- Aircraft size limits on taxiways (e.g. where an A380 can go). **[Proposal]** Revisit if the map data supports it cheaply.

### Anti-goals (would make v1 a failure even if it technically works)
These follow from Q's stated goals. **[Proposal]**
- Having to speak in a rigid, memorized syntax for the game to understand.
- Readbacks so slow that the back-and-forth stops feeling like real radio.
- Pilots who sound robotic, repetitive, or noticeably slower than real pilots.
- Losing points to a simulation bug rather than to the player's own decisions.

---

## 4. The player's experience

### 4.1 Session setup
Before a session the player picks: **[Proposal]** unless marked
- **Runway configuration.** Fixed for the whole session and defined in data. v1 ships one: **land 31L and 31R, depart 31L**. **[Q]** (31L arrivals added 2026-11-14.) This is JFK's most-used configuration (verified in task 1.3, `docs/research/airport-data.md` §4.1). A second configuration, the 4s, is a stretch goal (§3).
- **Traffic level: light, moderate, busy or peak.** It sets how fast arrivals and departures appear. **[Q]** for "peak" as the top level.
- **Pilot error rate**, low by default.

During a session the player can pause, which stops the simulation and all audio. **[Q]**

### 4.2 Departures
1. The aircraft pushes from its gate and taxis out of the ramp on its own, under the simulated ramp controller. It's drawn on the map the whole way. **[Q]** When departures back up, the simulated ramp holds some at the gate before they call, the way JFK meters departures. The backup can come from heavy traffic or from the player's own congestion (§4.4). **[Q]**
2. When it reaches the edge of the ramp, the pilot calls the player with their position and the ATIS letter, e.g. *"Ground, Delta four, taxiing on Kilo Foxtrot, information Oscar."* **[Q]** If it has a release time, the pilot mentions it ("...we've got a fourteen fifty-two release"). **[Proposal]** **[Unverified]**: check the real wording.
3. The player gives a route to the departure runway, adding "hold short of ___" if the plane can't go straight there. **[Q]**
4. At the departure runway's hold-short line, the player hands the aircraft to tower ("monitor tower"). Tower lines it up and launches it. **Scoring point:** the departure counts when it takes off. **[Q]**
5. If the player forgets the handoff, the pilot calls after about 30 seconds of holding short, sounding a little impatient ("Ground, Delta four, *still* holding short three one left"). **[Q]**

### 4.3 Arrivals
1. Tower lands the aircraft. After it leaves the runway, the pilot calls the player, e.g. *"Ground, Emirates two zero two heavy, clear of three one left at Kilo Echo."* **[Q]**
2. The player taxis it to the ramp entrance for its terminal and hands it to ramp ("monitor ramp"). **[Q]** (The ramp entrance as the handoff point is **[Proposal]**.)
3. The simulated ramp controller taxis it to its gate, drawn on the map. **Scoring point:** the arrival counts when it reaches its gate. **[Q]**
4. If the ramp lane is jammed, the arrival waits on the player's taxiway until it clears, so ramp congestion spills onto the player. **[Proposal]**
5. **No gate yet.** At busy and peak levels, an arrival's gate may be occupied or not yet assigned. **[Q]**
   - The pilot says so when calling in ("...clear of three one left at Kilo Echo, our gate's still occupied"), and the player parks it somewhere to wait. **[Proposal]**
   - When the gate opens, the pilot calls back ready to taxi to the ramp. **[Proposal]**

### 4.4 Delays and holding

**How it works for real** (quick research, 2026-11-14; sources in §15):
- **Traffic-flow delays come from the FAA's traffic management system, not the local tower.**
  - A flight in a delay program gets an Expect Departure Clearance Time (EDCT). It must take off between 5 minutes before and 5 minutes after it.
  - The crew normally knows its EDCT before taxiing. If a taxi request doesn't fit it, the controller asks the pilot to verify it.
- **ATC can also hold a flight for release:** "hold for release, expect (time) departure delay." This one goes from ATC to the pilot.
- **JFK meters departures.** At busy times, departures are held at the gate or a holding area, then released in time to join a short line at the runway.
- **Planes waiting for a gate** wait in what's informally called the "penalty box." Some controllers call it "the block." That's from pilot forums, not an official source.
- **Pilot-side delays** (paperwork, a maintenance message): the pilot raises these, asking for somewhere to wait or to go back to the gate. **[Unverified]**: realistic, but I found no source.

So both directions happen: ATC tells pilots about traffic-flow delays, and pilots tell ATC about their own problems.

**In the game:** **[Q]** for departure and arrival delays and for tower not launching early; mechanics are **[Proposal]** unless marked.
- **Release times.** Some departures get a release time with a ±5-minute window, shown on their strip. The player parks early planes on a holding pad or in the penalty box, then brings them back in time.
- **Tower only launches inside the window.** A plane that reaches the front of the line too early blocks everyone behind it. A plane that misses its window gets a new, later time. So poor planning costs throughput. **[Q]** for "won't launch early."
- **Delays can hit planes that are already moving.**
  - A new restriction can land on a plane that's taxiing or already in line: a ground stop for its destination, or a new, later release time.
  - The player learns about it from a notice in the status bar and a flag on the strip. They then tell the pilot and move the plane out of the way.
  - Pilots can also report their own problem mid-taxi ("Ground, Delta four, we've got a maintenance message, need somewhere to sit for a few minutes").
- **Every departure line needs a way out.** **[Q]**
  - The map data marks which taxiways form each runway's departure line, and the exits along it.
  - A plane can be pulled out of line at the next available exit and sent to wait, and the planes behind it move up.
  - Planes leave the line by the next exit taxiway, never by taxiing along the runway. **[Q]**
- **Arrival delays:** see §4.3, step 5.
- **The player tells pilots about delays in plain language** ("Delta four, ground stop for Atlanta, taxi to the pad and hold"), and pilots acknowledge (§7, C12).

**Delays the player causes:** **[Q]** for recognizing them; the method is **[Proposal]**.
- The game tracks each aircraft's delay and splits it into:
  - **system delay:** release times, ground stops, a pilot's own problem, an occupied gate, tower's normal launch spacing
  - **ATC delay:** everything else, meaning time lost to how the player handled it
- ATC delay includes:
  - waiting for an answer after calling in
  - sitting at the hold-short line without a handoff
  - waiting on a crossing the player hasn't requested
  - longer routes than needed
  - gridlock
  - sitting in a line the player let back up
  - gate holds the player's congestion triggered
- Simple rule: ATC delay = actual time minus unimpeded time, minus system delay. It's approximate on purpose. The exact accounting is **[Builder]**.
- **Missed release windows are always detected and reported**, along with whether the player caused them. **[Q]**
  - A miss counts as the player's if the plane would have made its window without the ATC delay.
- **v1 reports delays but doesn't take points away for them.** Folding delay into the score comes later. **[Q]**

### 4.5 Runway crossings
- The simulated tower owns every runway. **[Proposal]**
- The game follows the real U.S. rule that a taxiing aircraft stops before every runway on its route unless explicitly told to cross that specific runway. **[Proposal]** **[Unverified]**: I believe this is current FAA practice; confirm the exact rule.
- **To get permission (Q picked option B):**
  - There's one request key, not one per runway. **[Proposal]**
  - The player selects an aircraft with the mouse (its strip or its label on the map) and presses the key. **[Proposal]**
  - The request is for the next runway crossing on that aircraft's route. If it has no route yet, it's for the next runway ahead of it. **[Proposal]**
  - After a short pause, tower answers by voice: approved ("cross four left at Juliet approved"), or "hold, traffic on final" with a callback once it's clear. **[Q]** for "tower answers after a beat."
  - The player then passes the crossing clearance to the pilot by voice. **[Q]**
- Tower speaks in its own distinct voice through the same one-speaker-at-a-time scheduler as the pilots (§4.7). Its lines are labeled as the tower line in the radio log. **[Proposal]**
- **Unauthorized crossing:** the player tells an aircraft to cross a runway without a current tower approval. It's counted in the stats whether or not anything happens. **[Q]**
- Pilots obey crossing clearances without second-guessing. That's what lets a collision happen, so the stakes are real. **[Proposal]**

### 4.6 Pilot mistakes and corrections
- Now and then a pilot reads back wrong (wrong runway, wrong taxiway, wrong turn direction, missed hold-short, out-of-date ATIS letter). The player is expected to catch it and correct it ("negative, hold short Bravo"). **[Q]** (The list of mistake types is **[Proposal]**.)
- If the player doesn't catch it, the pilot does what they read back, not what the player said. That's what makes catching it matter. **[Proposal]**
- An **uncaught pilot mistake** is counted in the stats. **[Q]**
- **When is a mistake "caught"?** The player issues a correction before the aircraft acts on the wrong part, e.g. before passing the hold-short line it left out. **[Proposal]** The exact rule per mistake type is **[Builder]**.
- **ATIS:** the game keeps a current information letter, which changes occasionally during a session. A pilot reporting an old letter is one of the mistakes ("verify you have information Papa"). **[Proposal]**

### 4.7 Radio discipline
- One shared frequency. Pilots never talk over each other or over the player. They wait for the frequency to be clear, plus a short natural gap. **[Q]**
- After the player gives an instruction, the addressed pilot's readback gets priority over new calls. **[Proposal]**
- **Back-to-back transmissions.** The player may unkey and immediately rekey to address a different pilot. **[Q]** The game must: **[Proposal]**
  - never block capture of the next transmission while the last one is still being processed
  - process each transmission on its own, in order
  - hold pilot replies until the player has been off the mic for a short gap, then play the readbacks in the order the instructions were given
  - The gap length is **[Builder]**. Processing continues during the gap, so it shouldn't add to response time.
- The player can key up at any time. If a pilot is mid-transmission, it plays through, and the player's speech is still captured. Doubled-up transmissions are not simulated in v1. **[Proposal]**

### 4.8 Failure, score and session end
- **A collision ends the session immediately.** **[Q]** A collision means two aircraft footprints overlap. The realistic danger is on runways: an aircraft crossing or entering while another lands or takes off. **[Proposal]**
- **On taxiways, pilots stop rather than hit the plane ahead (see-and-avoid).** Airliners can't back up, so the taxiway danger is gridlock, not collision. **[Proposal]**
- **Gridlock:** if two planes end up nose to nose, the player selects one and calls a tug (§8.7). Each tow counts in the stats. **[Q]**
  - If tugs turn out not to be feasible, gridlock ends the session the same way a collision does. **[Q]**
  - The game detects gridlock when two or more aircraft block each other, none can move forward, and the jam lasts a set time. The threshold is **[Builder]**.
  - Q's reasoning: ground collisions are rare but real (Q cites a recent fatal collision at LaGuardia), so a jam the player created should carry real stakes.
- **Otherwise the session runs until the player ends it.** **[Proposal]**
- **Scoring must be trustworthy.** **[Q]**
  - Points only count at takeoff and at the gate.
  - So the simulated ramp and tower must never stop a correctly handed-off plane from getting there.
  - The only acceptable way to lose those points is congestion the player caused, at the ramp or the runway.
  - This needs dedicated tests (§9.3).
- **The end-of-session report shows:** **[Q]** for the stats; the 15-minute peak window is **[Proposal]**.
  - departures and arrivals-at-gate: total, average rate and peak rate, combined and separately
  - unauthorized runway crossings
  - uncaught pilot mistakes
  - tows called
  - missed release windows, and how many the player caused **[Q]**
  - total ATC delay, in minutes **[Proposal]**
  - collision or gridlock (yes/no, and what happened)

```
SESSION OVER — 47:12
Departures     38      Arrivals to gate   41
Avg rate   100/hr      Peak rate (15 min) 132/hr
Unauthorized crossings  1   Uncaught pilot errors  2   Tows  0
Missed release windows  3 (yours: 1)            ATC delay 42 min
```

---

## 5. Screen and UI

Q picked layout **C** (map, flight strips, status bar and radio log), with the radio log on a toggle. **[Q]**

```
┌──────────────────────────────────────────────────────────────────────┐
│ ATIS O ▸ │ 14:37Z │ 31L DEP/ARR · 31R ARR │ TWR: cross 4L @ J… │ DEP 12 ARR 15 │
├──────────────────────────────────────────────┬───────────────────────┤
│                                              │ DEPARTURES            │
│        top-down JFK map                      │ ▌DAL4  B739 31L       │
│        - runways (active ones marked)        │ ▌  A KE · HS B        │
│        - taxiways + names                    │ ▌JBU1123 A320 31L     │
│        - terminals, gates, ramp lanes        │ ▌  HOLD SHORT 31L→TWR │
│        - holding pads / penalty box          │ ▌AFR23 A359 REL 1452  │
│        - aircraft with labels                │ ARRIVALS              │
│          (callsign, type, runway/gate)       │ ▌UAE202 A388 → T4 NEW │
│                                              │ ▌AAL100 B77W → T8     │
├──────────────────────────────────────────────┴───────────────────────┤
│ [radio log — toggle]  DAL4: Ground, Delta four, taxiing on KF, info O │
│                       YOU: Delta four, 31L, taxi A, KE, HS B         │
│                       heard: "delta four three one left taxi alpha…" │
└──────────────────────────────────────────────────────────────────────┘
```

**Map** **[Proposal]** unless marked:
- Real JFK layout: runways, taxiways, gates, ramp lanes, holding pads and the penalty box, labeled with their real names. **[Q]** for "real JFK".
- Aircraft are colored by role: departure, arrival, or delayed.
- Each aircraft has a label showing callsign, type, and where it's going.
- Active runways are visibly marked.

**Flight strips:** **[Proposal]**
- One strip per aircraft the player is working, grouped into Departures and Arrivals.
- Each strip shows:
  - the route as given and any hold-short
  - release time, and any delay or restriction flag
  - for arrivals, gate status (assigned, occupied, open)
  - crossing-request state
- A strip shows the instruction as the game understood the player, never the pilot's readback. Pilot mistakes have to be caught by ear. A mishearing by the game can show up on the strip, which is fair, since that one is the game's fault.

**Status bar:** ATIS letter, game clock, active runway configuration, pending tower requests, traffic-flow notices (e.g. "GROUND STOP ATL"), and the live departure and arrival counts. **[Proposal]**

**ATIS readout:** **[Q]** for showing the letter and the readout; the contents are **[Proposal]**.
- The status bar always shows the current information letter.
- Clicking it opens the full current ATIS text, generated to match the session:
  - time, wind, visibility, sky, temperature and altimeter
  - runways in use
  - a NOTAM or two
- The weather is for flavor and doesn't affect gameplay in v1.

**Radio log:** **[Q]** for the log and its toggle. Hidden by default and the toggle key are **[Proposal]**.
- A transcript of the frequency: every pilot line, and every player line paired with what the game heard.
- Hidden by default so the player listens rather than reads. A key toggles it.

**Controls:** **[Proposal]**
- Hold a key to talk (Space is a placeholder).
- Click a strip or label to select an aircraft.
- One crossing-request key (T is a placeholder; §4.5).
- A tow key (§8.7).
- A radio-log toggle key.
- Pause.

**Reference material in the game:** **[Q]**
- Airline radio names (e.g. "Speedbird" = British Airways).
- The phonetic alphabet and number pronunciation.
- A cheat sheet of ATC phrases.

The cheat sheet is generated from the same list of commands the game understands, so it never lists something the game can't handle. **[Proposal]**

---

## 6. Voice

### 6.1 Player input
- Push-to-talk. Speech is captured only while the key is held. **[Proposal]**
- **Natural phrasing is the goal.** Loose real-world talk ("go ahead and…", reordered routes, dropped words) should work, as far as the speech services allow. **[Q]**
- **The interpreter uses game context.** **[Q]**
  - When it turns a transcript into a command, it's told which aircraft are on frequency, their current state and instructions, and the airport's taxiway and runway names.
  - That lets it fix mishearings ("Delta for" → DAL4) and resolve short forms.
- **Context in the prompt, or tool calls?** Phase 0 decides whether the context goes straight into the prompt or is fetched with tool calls. **[Builder]**
  - My lean is to put it in the prompt and ask for one structured command back, because each tool call adds another network round trip. **[Proposal]**
- **One transmission addresses one aircraft**, though the player may send several in quick succession (§4.7). **[Q]**
- **When the game can't understand:**
  - If it can't work out an instruction, the addressed pilot says "say again". If it can't work out who was addressed, the response is something like "station calling Ground, say again". **[Proposal]**
  - If it mishears, the pilot reads back what the game heard. A mishearing works like a pilot mistake: the readback is where the player catches it. **[Proposal]**
  - If it hears an instruction that's impossible (e.g. taxiways that don't connect), the pilot says "unable" or asks to verify the route. **[Q]**
- **Session logs:** each session saves, locally, the transcript of what the player said, what the game heard and the command it produced, so recognition accuracy can be measured and tuned. **[Q]**
  - Logs are text only; raw audio isn't saved by default. **[Q]**

### 6.2 Pilot output
- Professional "pilot" voices at the speed and cadence of a busy frequency. **[Q]**
- No radio effects. **[Q]**
- Each flight keeps one voice from first call to handoff, and nearby aircraft get voices that are easy to tell apart. **[Proposal]**
- Pilot lines follow real radio habits: short, with the callsign at the end of a readback ("Kilo, Alpha, hold short three one left, Delta four"). **[Proposal]**
- **Lots of variety.** **[Q]** for variety; the method is **[Proposal]**.
  - Wording comes from templates, not free-form AI generation, so it stays fast and the phrasing is always correct.
  - Templating is extensive: many phrasings for each type of message, picked at random.
  - Each pilot has a style (terse or chatty) that stays the same for that flight.
- **Accents are deferred.** **[Q]**
  - Phase 0 must pick a voice service that can do accented English later, so adding accents doesn't mean changing providers. **[Q]**
  - When they're added, voices are probably assigned by airline region. **[Proposal]**

### 6.3 Latency target
- **Target: median 1.0 s or less** from the player releasing push-to-talk to the pilot starting to answer. **[Q]**
- **Slowest 5%: about 2 s or less.** **[Proposal]**
- **These are goals.** Q notes they may be hard to hit with network services. Phase 0 measures what's achievable, and the targets get adjusted from there. **[Q]**
- Rough budget for 1.0 s **[Proposal]**:
  - final transcript ≤ 0.3 s
  - interpretation ≤ 0.4 s
  - first voice audio ≤ 0.2 s
  - scheduling ≤ 0.1 s
- When the player transmits back to back, the clock starts at their last release.

---

## 7. Commands the game must understand (v1)

Natural phrasing for all of these. **[Q]** for natural phrasing; the list is **[Proposal]**, and Q reviewed it.

| # | Instruction | Example | Priority |
|---|---|---|---|
| C1 | Taxi to runway via route, with turn directions and hold-short(s) as needed | "Delta four, three one left, taxi Alpha, right on Kilo Echo, hold short Bravo" | Must |
| C2 | Taxi to ramp/terminal via route | "Emirates two zero two heavy, left on Bravo, Kilo Echo to the ramp" | Must |
| C3 | Hold short of (taxiway or runway) | "...hold short of three one right" | Must |
| C4 | Hold position / continue taxi | "JetBlue eleven twenty three, hold position" | Must |
| C5 | Cross runway (after tower approval) | "Delta four, cross four left at Juliet" | Must |
| C6 | Send to holding pad / penalty box, including out of the departure line | "Air France two three, exit the line at Kilo Delta, hold on the pad" | Must |
| C7 | Handoff | "monitor tower", "contact ramp" | Must |
| C8 | Correction of a readback | "negative, hold short Bravo" | Must |
| C9 | ATIS correction | "information Papa is current" | Must |
| C10 | Player "say again" (ask pilot to repeat) | "Delta four, say again" | Must |
| C11 | Follow / give way to another aircraft | "follow the JetBlue A320", "give way to the Emirates" | **Cut first** **[Q]** |
| C12 | Tell the pilot about a delay or restriction | "Delta four, ground stop for Atlanta, expect about twenty minutes" | Must |

If C11 is cut, the player can get the same result with C3, C4 and re-routing. **[Q]**

**What a taxi route means:**
- A route is an ordered list of taxiways ending at the destination. The aircraft follows those taxiways in order. **[Q]** (2026-11-14)
  - The route has to name every taxiway. After the last one, the aircraft only takes the destination's own way in: the departure line to the runway's hold, the entrance stub to the ramp, or the lead-in to a pad or penalty-box spot. **[Q]**
  - If the named taxiways don't get there, the pilot says "unable" and asks for the route. The aircraft never finds its own way, so it never picks up a runway crossing the player didn't plan. **[Q]**
- **Turn directions:** a route can say which way to turn onto a taxiway ("right on Bravo", "left Kilo Echo"), and the aircraft turns that way. **[Q]**
  - If no direction is given, it turns the way that reaches the next taxiway in the route (or the destination's way in). **[Q]**
  - If both ways do, the pilot asks ("left or right on Bravo?"). **[Q]**
- It stops at every runway hold-short line on the way unless it has a crossing clearance for that runway (§4.5). **[Proposal]**

---

## 8. Simulation

### 8.1 Airport model
- **Real JFK geometry, stored as data.** **[Q]** for real JFK.
  - The data is a network of taxiways, runways, ramp lanes, gates, holding pads, the penalty box and hold-short points, each with its real name.
  - It also marks each runway's departure-line taxiways and the exits along them (§4.4).
  - The leading candidate source is OpenStreetMap's airport features for JFK. I believe they're detailed but haven't checked. The fallback is tracing the FAA airport diagram by hand. **[Proposal]** **[Unverified]**
- **JFK is in the middle of a major terminal rebuild (New Terminal One, Terminal 6), so map data may not match today's airport.** Pick one snapshot and accept the drift. **[Unverified]**: confirm current status.
- **Terminal and gate assignments per airline live in data.** **[Proposal]**
- **Ground also taxis aircraft to parking off the ramp and to hangars.** **[Q]** (2026-11-14)
  - Some JFK parking, e.g. the South Hardstand, is controlled by ground, not ramp.
  - Hangars are taxi destinations too.
  - Both arrive with the JFK import (PLAN 1.5).
- **The format can't assume JFK.** JFK first, then LGA, then PIT. **[Q]**
  - To catch JFK-only assumptions early, Phase 1 also imports LGA's map as a check (the map loads and routes work), without making it playable. **[Proposal]**
  - LGA's two runways cross each other in a tight space, which makes it a good stress test of the format. **[Unverified]**

### 8.2 Aircraft movement
- Aircraft move along the taxi network at realistic taxi speeds: faster on straights, slower through turns. **[Proposal]** The exact speeds are **[Builder]**.
- Aircraft can't reverse. **[Proposal]**
- Aircraft stop for traffic ahead on the same path (see-and-avoid). **[Proposal]**
- **The player always plays in real time.** Tests can run the simulation faster than real time (§9.3). **[Proposal]**
- A fixed simulation tick and a seeded random number generator make sessions reproducible for testing. **[Proposal]**

### 8.3 Simulated ramp controller
**[Q]** for "ramp is automatic but visible". Behavior details are **[Proposal]**.
- Pushes departures from their gates (animated pushback, no tug interaction) and taxis them to the ramp edge, then triggers the pilot's check-in call to the player.
- Holds some departures at the gate to meter them, as JFK does, whenever departures back up, whether from heavy traffic or from the player's congestion. Gate-hold time caused by the player's congestion counts as ATC delay (§4.4). **[Q]**
- Takes arrivals from the ramp entrance to the gate.
- Tracks which gates are occupied, so an arrival can be told its gate isn't ready (§4.3).
- Holds aircraft when the ramp lane is busy, without ever blocking itself (§9.3).

### 8.4 Simulated tower
**[Proposal]**
- Lands arrivals on the arrival runways at a rate set by the traffic level, sends them off at an exit, and has them call the player.
- On a runway used for both arrivals and departures (31L in the 31s), interleaves landings and takeoffs.
- Takes departures from the hold-short line in order and launches them at realistic spacing.
- Launches a plane only inside its release window, and gives a later time to one that misses it (§4.4). **[Q]** for "won't launch early."
- Approves or holds crossing requests based on runway traffic, and calls back when a held request becomes possible.
- Tower's spacing rules and timing values are **[Builder]**, within "feels like JFK".

### 8.5 Traffic generation
**[Proposal]** unless marked
- A JFK-style airline mix, using real airline radio names (Delta, JetBlue, American, "Speedbird", "Shamrock", etc.).
- Aircraft types fit each airline.
- Terminal and gate fit each airline.
- A share of departures gets release times.
- The traffic level sets how many flights appear and how fast.
- **A simulated traffic manager** issues restrictions during busy and peak sessions: ground stops for a destination, or new release times. Some hit planes already taxiing (§4.4).
- **Real flight numbers (stretch):** **[Q]** for the goal.
  - Traffic is built from a dataset of real JFK flights: callsign, airline, aircraft type, origin or destination, and terminal. A callsign then matches its real route.
  - Possible sources are OpenSky Network's historical data, or commercial flight-data APIs. **[Unverified]**: availability, licensing and cost aren't checked yet (O-5).
  - Made-up flights stay as the fallback, and they fill out traffic levels the dataset can't. **[Proposal]**

### 8.6 Rule checks
**[Q]** for what gets counted. Detection details are **[Proposal]**.
- **Collision:** two aircraft footprints overlap. Ends the session.
- **Unauthorized crossing:** an aircraft enters a runway on the player's instruction without a current tower approval.
- **Uncaught pilot mistake:** see §4.6.
- **Gridlock:** see §4.8.
- **Delay accounting:** system vs. ATC delay per aircraft, and missed release windows (§4.4).

### 8.7 Tugs (for gridlock)
**[Q]** for the tug option. Behavior details are **[Proposal]**.
- The player selects a stuck aircraft and presses the tow key.
- After a delay of a few minutes, a tug appears, hooks up and pulls the aircraft backward to the nearest point where it can turn around or take another route. The tug then leaves.
- The towed aircraft waits for new instructions.
- Each tow counts in the stats.
- The player doesn't talk to the tug. Tug radio calls are a later enhancement (§3).

---

## 9. Technical approach

### 9.1 Approaches considered

| Approach | Upside | Downside | Status |
|---|---|---|---|
| **A. Browser app plus cloud AI services** | Best understanding and voice quality; fastest to build; easy to share later as a web page | Needs internet; depends on three outside services; costs money per session (estimated a few dollars an hour at most, mostly the pilot voices; **[Unverified]**) | **Chosen [Q]** |
| **B. Everything local on Q's Mac** | Free to run, works offline, private | Pilot voices sound noticeably less natural, with fewer of them; small local models handle loose phrasing less well; anyone Q shares with needs a capable machine | Kept possible through the AI service interfaces **[Q]** |
| **C. Game engine (Godot / Unity)** | Strong rendering and game feel | The screen is a map plus text panels, which web tools handle well; speech services are easiest to reach from web code; slower to iterate | Dropped **[Proposal]** |

### 9.2 Architecture (approach A)
- **Client:** a TypeScript web app running on Q's Mac in Chrome. It does the map rendering, UI, audio capture and playback, and runs the simulation. **[Proposal]** Whether the simulation runs in the browser or the local server is **[Builder]**. The rendering technology (Canvas, SVG or a 2D library) is **[Builder]**.
- **Local server:** a small TypeScript server running on the same Mac. It holds API keys and relays calls to the cloud services. **[Proposal]**
- **Voice pipeline:**
  ```
  push-to-talk audio
    → speech-to-text service      streaming, told the airport's vocabulary
    → interpreter (language model + game context) → structured command
                                  (or "unintelligible" / "ambiguous")
    → validate against the sim    (route connects? callsign on frequency?)
    → sim applies the command, maybe injecting a pilot mistake
    → pilot response text         templates
    → voice service               the flight's assigned voice, first audio streamed fast
    → radio channel scheduler     one speaker at a time; handles back-to-back transmissions
  ```
- **AI service interfaces:** **[Q]**
  - Speech-to-text, the interpreter's language model and the pilot voices each sit behind their own interface, with a cloud implementation first.
  - Moving one to a local model means writing another implementation of that interface. Nothing else changes.
  - For the language model, an implementation that speaks the OpenAI-compatible chat format would cover Ollama, LM Studio and similar local servers. **[Proposal]**
  - Local speech-to-text and voices would need other local servers. As far as I know, Ollama only serves language models. **[Unverified]**
- **The specific providers** for each service (which speech-to-text and voice services, which language model) are picked by the Phase 0 test, not by this PRD. **[Proposal]**
- **Typed command console:** a developer-only text box that takes commands in a terse syntax (e.g. `DAL4 taxi 31L via A R:KE hs B`). Code parses them into the same command objects the interpreter produces, skipping speech-to-text and the language model. The simulation can then be built and tested without a microphone or any AI service. **[Q]** (decided 2026-11-14; syntax documented in `docs/terse-syntax.md`)

### 9.3 Testing requirements
**[Q]** for "scoring needs good tests." The approach is **[Proposal]**.
- **Headless simulation:** the simulation runs without the UI or voice, and faster than real time in tests.
- **Scoring-path tests:**
  - Every departure handed to tower at its hold-short line takes off within its release window.
  - Every arrival handed to ramp reaches its gate within a set time.
  - The only exception is a blockage the player caused.
- **Ramp and tower never jam themselves:** the simulated controllers must not block each other or a lane indefinitely.
- **Soak tests:** a scripted "perfect player" runs multi-hour peak sessions, and no plane may get stuck or lost.
- **Rule-check tests:** scripted scenarios check that collisions, gridlock, unauthorized crossings and uncaught mistakes are each detected and counted correctly.
- **Delay-accounting tests:** scripted scenarios check that system delays (release times, ground stops, occupied gates) aren't charged to the player, and that delays the player caused are.
- **Voice regression set:** the recorded instructions from Phase 0 become a test set for speech-to-text and the interpreter. Accuracy is re-measured whenever a provider or prompt changes.
- **Reproducible failures:** seeded randomness (§8.2) means any failure can be replayed.

---

## 10. Suggested phases

**[Proposal]**. Plans may re-cut these, but Phase 0 should stay first.

| Phase | What | Done when |
|---|---|---|
| **0. Voice-loop test (throwaway)** | Push-to-talk → speech-to-text → language model → template → voice, with no game. Test 2–3 speech-to-text and 2 voice options on ~30 recorded JFK-style instructions, spoken naturally. Check that each voice option can do accents later. Try context-in-prompt vs. tool calls. | Measured latency (median and slowest), accuracy and cost per hour for each option, against the 1.0 s target and the cost caps (§11); providers picked; targets confirmed or revised |
| **1. Map + simulation, typed commands** | Import JFK data, plus LGA's as a format check; render map; headless simulation; aircraft movement; simulated ramp and tower; hold-shorts, crossings, turn directions, rule checks; scoring-path and soak tests; typed command console | A scripted departure and arrival complete via typed commands; scoring-path tests pass; LGA's map loads and routes |
| **2. Voice in the game** | AI service interfaces with cloud implementations; interpreter with game context; pilot templates and voices; radio channel scheduler including back-to-back transmissions; say-again / unable handling | Q can taxi a departure and an arrival entirely by voice |
| **3. Full session** | Traffic generation and the traffic manager; release times, departure-line exits, holding pads and the penalty box; arrival gate delays; ATIS and its readout; pilot mistakes; scoring and delay accounting; setup and end screens; strips; radio log toggle; tugs; session logs | Q can play a 30+ minute peak session end to end; soak tests pass |
| **4. Reference + polish** | In-game reference (airline names, phonetic alphabet, cheat sheet), template variety, tuning; stretch goals: the 4s configuration, real flight numbers, follow / give-way | — |
| **Later** | Delay folded into the score; accents; local (Ollama etc.) implementations of the AI services; LGA, then PIT playable; mid-session runway changes; pushback / ramp position; radio calls from tugs, ground crew and vehicles; approach / departure; sharing with enthusiasts | — |

## 11. Success criteria for v1

- Q plays a 30+ minute session at peak traffic and wants to play again. **[Proposal]**
- The pilot starts answering within **1.0 s typically (median)**. **[Q]**
- The slowest 5% of responses take about 2 s or less. **[Proposal]**
- Both latency numbers get adjusted based on what Phase 0 shows is achievable. **[Q]**
- ≥ 90% of instructions in the Phase 0 test set are understood correctly the first time. **[Proposal]**
- **Running cost at peak traffic:**
  - ideally **$5 per hour of play** or less. That's the soft cap; above it, Q starts getting concerned. **[Q]**
  - never over **$10 per hour**. That's the hard cap; above it, we have to find another solution, such as cheaper providers, caching common pilot lines, or local implementations. **[Q]**
- **Scoring-path and soak tests pass:** no plane is lost to a simulation bug. **[Q]**
- **No session-ending bugs in the simulation**, such as stuck aircraft the player didn't cause, or phantom collisions. **[Proposal]**

## 12. Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| Speech-to-text mangles callsigns, taxiway names and runway numbers | Core experience | Vocabulary hints, context-aware interpreter, measured in Phase 0 |
| Speed of the full voice round trip | The radio rhythm is the whole point; 1.0 s over the network is ambitious | Streaming everywhere; measured in Phase 0 before building on it |
| The simulation costs the player points it shouldn't | Undermines the score | Scoring-path, rule-check and soak tests (§9.3) |
| Delay accounting blames the player for delays they didn't cause | Undermines trust in the report | Simple, explainable rule; delay-accounting tests (§9.3) |
| JFK map data incomplete or out of date (terminal rebuild) | Realism, and route checking | Verify OpenStreetMap data in Phase 1; hand-trace fallback; pick one snapshot |
| Map format quietly assumes JFK | Blocks LGA and PIT | Import LGA's map in Phase 1 as a check |
| Running cost | Q's caps: $5/hr soft, $10/hr hard (§11) | Measured in Phase 0; providers picked within the caps; cache repeated pilot lines; local implementations as the escape hatch |
| Real flight data unavailable, restricted or expensive | The stretch goal slips | Made-up flights stay as the fallback |
| Real airline names and branding if ever shared publicly | Possible trademark issues | Fine for personal use; revisit before any public release |

## 13. Open questions

- **O-5.** Which real flight-data source, and what are its availability, licensing and cost? Research item, during Phase 3 or 4.

Resolved:
- **O-3.** Second runway means opening the 4s (land 4L, depart 4R), as a second configuration (§3).
- **O-4.** Delayed planes leave the departure line at the next exit taxiway, not along the runway (§4.4).
- **O-1.** Gridlock: call a tug. If tugs aren't feasible, gridlock ends the session (§4.8, §8.7).
- **O-2.** Cost: $5/hr soft cap, $10/hr hard cap (§11).

## 14. Decisions log

| Decision | By |
|---|---|
| Ground control at JFK; extensible later to other positions | Q |
| Airports are data from the start; LGA next, then PIT | Q |
| Player is ground only; ramp and tower are simulated | Q (pushback out); Proposal (tower) |
| Planes drawn all the way to and from gates | Q |
| Departure check-in from the ramp lane, with ATIS | Q |
| Start with land 31L and 31R / depart 31L; the 4s (land 4L, depart 4R) are a stretch goal | Q |
| The game recognizes player-caused delay; missed release windows always reported; delay in the score later | Q |
| Ramp gate holds triggered by backups, including ones the player caused | Q |
| Traffic levels top out at "peak" | Q |
| Pause | Q |
| Crossing approval via request key; tower answers after a beat | Q (option B) |
| Pilot calls back if not handed to tower | Q |
| Score: departures plus arrivals at gate, total, average and peak rate; collision ends session; crossings and uncaught mistakes counted | Q |
| Scoring must be trustworthy, backed by tests | Q |
| Gridlock: call a tug; if tugs aren't feasible, gridlock ends the session | Q |
| Delays on departures and arrivals; tower won't launch early; every departure line has a way out, at the next exit taxiway | Q |
| Pilots don't step on each other; occasional wrong readbacks | Q |
| Back-to-back transmissions to different aircraft | Q |
| Professional voices, real cadence, no radio effects | Q |
| Accents later, but the voice service must support them | Q |
| Templated pilot wording, with lots of variety | Q |
| Natural phrasing; interpreter uses game context | Q |
| "Unable" / verify for impossible instructions | Q |
| Text-only session logs | Q |
| Turn directions in taxi routes | Q |
| Layout C, radio log on a toggle; ATIS letter and readout in the UI | Q |
| In-game reference material | Q |
| Follow / give-way cut first | Q |
| Real flight numbers as a stretch goal | Q |
| Tug / ground crew radio calls later | Q |
| Approach A (browser plus cloud); AI services behind interfaces with possible Ollama implementations | Q |
| Latency target: median 1.0 s, adjusted after Phase 0 | Q |
| Running cost: $5/hr soft cap, $10/hr hard cap | Q |
| Taxi routes spelled out in full; no direction given → toward the next taxiway, both ways → pilot asks (2026-11-14) | Q |
| Hardstand parking and hangars as taxi destinations (2026-11-14) | Q |
| Everything else tagged [Proposal] | Claude |

## 15. Sources

Research done 2026-11-13 and 2026-11-14. Secondary sources are marked as such.

- Ramp control handles pushback: [AOPA — Ramp control](https://www.aopa.org/news-and-media/all-news/2022/may/flight-training-magazine/ramp-control)
- JFK "contact ramp control prior to pushback" during metering: [FAA Chart Supplement NE 228 (JFK)](https://airportdocs.iflightplanner.com/AFD/241226/ne_228.pdf)
- Ramp vs. ground coordination at JFK, anecdotal: [PPRuNe — Danger of JFK ramp and ground ops](https://www.pprune.org/accidents-close-calls/657324-danger-jfk-ramp-ground-ops.html?nojs=1)
- Release times and hold for release: [FAA JO 7110.65, Chapter 4 Section 3](https://www.faa.gov/air_traffic/publications/atpubs/ATC_html/chap4_section_3.html), [SKYbrary — Hold for Release](https://skybrary.aero/articles/hold-release)
- EDCT ±5 min window and verifying the EDCT, via AIM excerpts: [faraim.org AIM text](https://faraim.org/faa/aim/356/pdf.txt), [Boldmethod — ATC delays](https://www.boldmethod.com/learn-to-fly/regulations/what-every-pilot-should-know-about-atc-delays/)
- JFK departure metering (Ground Management Program): [Stroiney et al., MIT, DASC 2013](https://www.mit.edu/~hamsa/pubs/StroineyLevyKhadilkarBalakrishnanDASC2013.pdf)
- "Penalty box," forum-level: [Airline Pilot Central — Penalty box](https://www.airlinepilotforums.com/technical/33438-penalty-box-print.html)
