# PLAN: ATC Ground Control v1 — Phases 0 & 1

_Drafted: 2026-11-14_

## Goal

Phase 0 picks the speech-to-text, language-model and voice providers from measured latency,
accuracy and cost, written up in `docs/spikes/voice-loop.md`. Phase 1 delivers a TypeScript web
app that loads JFK from airport data (with LGA as a format check), renders it, and runs a
simulation in which a departure and an arrival complete end to end using typed commands.
Phase 1's scoring-path, rule-check and soak tests pass.

## Context

- **Source of truth:** `docs/prd/ground-control-v1.md`. Its tags: [Q] = Q decided, don't change
  without asking; [Proposal] = revisable; [Builder] = implementer's call; [Unverified] = check
  first. Key sections: §4 gameplay, §6 voice, §7 commands, §8 simulation, §9 architecture,
  §9.3 testing, §10 phases, §11 success criteria (median 1.0 s; cost $5/hr soft, $10/hr hard).
- **Two parallel tracks:** Phase 0 (voice test) and Phase 1 (map + sim) don't depend on each
  other, except that 0.4 needs the command format from 1.2.
- **Tech stack:** current Node LTS, npm, TypeScript (strict), Vite for the web app, Vitest.
  Repo layout: `src/sim/` (headless simulation; must not use DOM APIs, enforced by its own
  tsconfig without the DOM lib), `src/airport/` (airport format, loader, validator),
  `src/web/` (browser app), `tools/` (importers and scripts), `data/airports/` (airport files).
- **Phase 0 is throwaway.** It lives in `spikes/voice-loop/` as a standalone package with its
  own `package.json`, not part of the root workspace. Nothing in `src/` may import from
  `spikes/`. No tests are needed for spike code; the measurements are the deliverable.
- **API keys** go in `spikes/voice-loop/.env.local` (gitignored), never committed. Q has
  Anthropic and OpenAI accounts; Deepgram and ElevenLabs need sign-up, and Q is open to any
  provider they can get access to.
- **Typed commands use a terse syntax** (decided by Q 2026-11-14), e.g.
  `DAL4 taxi 31L via A R:KE hs B`. It's parsed by code into the same command object the
  Phase 2 AI interpreter will produce. This replaces PRD §9.2's line saying typed text goes
  through the interpreter.
- **Airports are data from the start** (LGA, then PIT, come next). No JFK-specific code paths;
  anything hand-curated goes in a per-airport overrides file, not code.
- **Anthropic API code:** load the `claude-api` skill before writing it, for current model
  IDs and parameters.
- **Human steps:** 0.1 (Q creates accounts), 0.2 (Q records audio), 0.5 (Q listens to voices),
  0.6 (Q runs live transmissions), 1.13 (Q runs the manual check). An agent on these tasks
  prepares everything, then hands to Q with exact instructions.
- **Provisional peak-traffic assumption for cost estimates:** the frequency is nearly always
  busy at peak, so about 450 player transmissions and 450 pilot/tower lines per hour (~4 s
  each). Phase 0 revises this from its live counts; 1.3 looks up JFK's real peak hourly
  movements for the soak test.

## Non-Goals

- Anything from PRD Phase 2+: AI interpreter inside the app, pilot voices in the game, radio
  channel scheduler, local server for the app.
- PRD Phase 3 features: traffic generator and traffic manager, release times and windows,
  ramp metering, arrival gate delays, ATIS, pilot mistakes, delay accounting, flight strips /
  status bar / radio log UI, setup and end screens, tugs.
- Stretch goals: the 4s as a playable configuration, real flight numbers, follow / give-way.
- Making LGA playable. It's a format check only.
- Turning spike code into product code.

## Tasks

### Phase 0: Voice-loop test

- [ ] **0.1 — Shortlist providers and set up access**
  - Scope: Research current streaming speech-to-text (OpenAI, Deepgram, plus one more, e.g.
    AssemblyAI) and low-latency voice services (OpenAI, ElevenLabs, plus optionally one more,
    e.g. Cartesia), and 1–2 language models (a Claude Haiku-class model, plus one OpenAI small
    model). Write `docs/spikes/voice-loop.md` § Shortlist. Create the standalone
    `spikes/voice-loop/` package with `check-keys.ts`. Add `.env*` to the root `.gitignore`.
    Hand to Q to create the missing accounts and fill in `.env.local`.
  - Depends on: none
  - Acceptance: The § Shortlist table lists, per candidate: streaming support, vocabulary /
    keyword hints, speaking-rate control, accented-English voices (TTS), published pricing with
    a link, and estimated $/hr at the peak assumption. `npm --prefix spikes/voice-loop run check-keys`
    prints OK for every shortlisted provider.
  - Context: Accents are deferred, but the chosen voice service must support them (PRD §6.2).
    Cost caps are in PRD §11. Pricing must come from the providers' own pages, dated.

- [ ] **0.2 — Test-set script and recorder; Q records**
  - Scope: `spikes/voice-loop/test-set/script.md`: ~30 JFK-ground instructions covering every
    command type in PRD §7 (C1–C10, C12; C11 optional). Include turn directions, multiple
    hold-shorts, crossings, corrections, ATIS, and delay advisories, in a mix of textbook and
    loose real-world phrasing, plus the matching pilot readback for each. Build a simple
    Chrome recorder page (`spikes/voice-loop/recorder/`): it shows each line, records while a
    key is held, and saves `test-set/audio/NN.webm`. Hand to Q to record all lines.
  - Depends on: none
  - Acceptance: The script has ≥ 30 lines covering every listed command type, with a coverage
    checklist at the top. 30 audio files exist, and Q confirms a spot check of 5 plays back
    correctly.
  - Context: Real JFK flavor: real airline radio names, JFK taxiway and runway names, callsign
    at the end of readbacks. Whether the audio is committed is an open question; default to
    gitignored.

- [ ] **0.3 — Speech-to-text bake-off**
  - Scope: `spikes/voice-loop/stt-bench.ts` streams each recording at real-time pace to each
    shortlisted speech-to-text service, with vocabulary hints where supported (airline radio
    names, JFK taxiway and runway names, phonetic alphabet). Record each final transcript and
    the latency from end of audio to final transcript. Score word error rate and
    critical-token accuracy (callsign, runway, taxiways, hold-short targets) against the script.
  - Depends on: 0.1, 0.2
  - Acceptance: `npm --prefix spikes/voice-loop run stt-bench` prints, per provider: median and p95
    latency, word error rate, critical-token accuracy, and $/hr. The table is copied into
    § Speech-to-text, with transcripts saved for 0.4.
  - Context: The latency budget is ≤ 0.3 s to final transcript (PRD §6.3). Measure from end of
    audio, not from request start.

- [ ] **0.4 — Interpreter bake-off**
  - Scope: Add the expected command to every script line, in 1.2's terse syntax.
    `spikes/voice-loop/interp-bench.ts` gives each model a transcript plus a fixed fake game
    context (flights on frequency and their states, JFK taxiway and runway names). The model
    must return a command object matching `src/sim/commands.ts`. Compare context-in-prompt with
    structured output against tool-call lookups, for each shortlisted model. Run on both the
    perfect transcripts (script text) and the best speech-to-text output from 0.3.
  - Depends on: 0.2, 0.3, 1.2
  - Acceptance: `npm --prefix spikes/voice-loop run interp-bench` prints, per model × approach ×
    input: median and p95 latency, exact-match %, per-field accuracy, and $/hr. Results and a
    recommendation (prompt vs. tool calls) go in § Interpreter.
  - Context: The PRD leans toward prompt context (§6.1). The budget is ≤ 0.4 s. Test
    context-based fixes like "Delta for" → DAL4. Consider prompt caching for the static
    airport context; it affects both cost and latency.

- [ ] **0.5 — Voice bake-off; Q listens**
  - Scope: `spikes/voice-loop/tts-bench.ts` sends ~15 pilot readbacks from the script through
    each shortlisted voice service. Measure time to first audio, check speaking-rate control,
    count usable "pilot" voices, and check for accented English. Save sample clips to a
    gitignored folder. Hand to Q to rate naturalness and cadence.
  - Depends on: 0.1
  - Acceptance: § Voices has, per provider: median and p95 time to first audio, number of
    usable voices, rate control (y/n), accents (y/n), and $/hr, plus Q's listening verdict.
  - Context: The budget is ≤ 0.2 s to first audio. Q wants professional pilot voices at real
    busy-frequency speed (PRD §6.2).

- [ ] **0.6 — Live end-to-end loop and findings; Q tests**
  - Scope: `spikes/voice-loop/live/`: a Chrome page with hold-Space push-to-talk, and a small
    local server that holds the keys. The chain is streaming speech-to-text → interpreter →
    templated readback → streaming voice → playback, timestamping every stage, using the best
    picks from 0.3–0.5. Q runs ≥ 20 live transmissions. Then write § Findings.
  - Depends on: 0.3, 0.4, 0.5
  - Acceptance: § Findings has:
    - a per-stage and end-to-end median / p95 table from the logged timestamps, measured
      against the 1.0 s target
    - $/hr at peak against the caps, with the assumption revised from live counts
    - a named pick for speech-to-text, the language model and voice, each with a one-line
      rationale
    - a prompt-vs-tools decision
    - a recommendation on whether PRD §6.3 / §11 targets change
    - Q's sign-off on the picks, recorded in the doc
  - Context: The clock starts when push-to-talk is released (PRD §6.3).

### Phase 1: Map and simulation, typed commands

- [ ] **1.1 — Scaffold the repo**
  - Scope: Root `package.json` (npm) with scripts `dev`, `test`, `typecheck`; strict
    TypeScript; Vite app in `src/web/`; Vitest; `tsconfig.sim.json` covering `src/sim/` and
    `src/airport/` without the DOM lib; the folder layout from Context; a short README listing
    the commands.
  - Depends on: none
  - Acceptance: `npm install && npm run typecheck && npm test` pass (one placeholder test).
    `npm run dev` serves a page in Chrome. A temporary file in `src/sim/` that uses `document`
    fails `npm run typecheck` (checked once, then removed; noted in STATUS).

- [ ] **1.2 — Command format and terse-syntax parser**
  - Scope: `src/sim/commands.ts`: types for every PRD §7 command except C11. That covers route
    items with optional turn direction, multiple hold-shorts, cross runway at a taxiway,
    handoffs (tower / ramp), corrections, ATIS, say-again, and delay advisories, plus the
    player-to-tower crossing request (an action, not a radio call). `src/sim/terse.ts` parses
    the terse syntax into these objects, with specific error messages.
    `docs/terse-syntax.md` documents the syntax.
  - Depends on: 1.1
  - Acceptance: `terse.test.ts` covers every command type, including turn directions and
    multiple hold-shorts, plus ≥ 5 malformed inputs, each asserting a specific error message
    (e.g. "expected runway after 'cross', got 'KE'"). All pass.
  - Context: This is the contract the Phase 2 interpreter must output, and 0.4 uses it. Keep it
    airport-agnostic: names are strings, checked against airport data later.

- [ ] **1.3 — Verify airport data and facts**
  - Scope: Research, written to `docs/research/airport-data.md`:
    - OpenStreetMap features for JFK and LGA (taxiways with names, runways, hold positions,
      gates, taxilanes, aprons), compared against the FAA airport diagrams
    - which JFK terminals exist in the data snapshot, given the rebuild
    - JFK's departure-line taxiways and exits for 31L, and its holding pads / penalty box
    - the FAA rule on explicit runway-crossing clearances (7110.65)
    - JFK's typical peak hourly arrivals and departures
    - OpenStreetMap licensing and attribution
    - a decision: OpenStreetMap, hand-trace, or a mix
  - Depends on: none
  - Acceptance: The doc includes the exact Overpass query used and feature counts by type per
    airport, a list of named taxiways missing compared with the FAA diagram, the rule citation
    with a link, peak hourly numbers with a source, and the data-source decision.
  - Context: These are the PRD §8.1 / §4.5 [Unverified] items.

- [ ] **1.4 — Airport format, loader and validator**
  - Scope: `src/airport/types.ts`: an airport-agnostic format. It covers a node/edge graph
    with names; runways (ends, thresholds, exits); hold-short points tied to runways; taxiways;
    ramp lanes; gates (terminal, airlines); ramp edges and entrances (handoff points); holding
    pads / penalty box; departure lines with their exits per runway end; runway configurations;
    and rendering geometry. `src/airport/load.ts` loads base data plus an overrides file.
    `src/airport/validate.ts` runs connectivity and consistency checks. `npm run validate-airport --
    <ID>`. A small synthetic test airport at `data/airports/TEST.json` exercises every feature.
  - Depends on: 1.1
  - Acceptance: TEST passes validation. Tests show every gate is reachable from a ramp
    entrance, every hold-short is tied to a runway, and every departure line has ≥ 1 exit.
    Three broken fixtures (disconnected taxiway, orphan hold-short, unreachable gate) are each
    rejected with a specific error.

- [ ] **1.5 — Import JFK**
  - Scope: `tools/import-airport.ts` (approach per 1.3's decision) produces
    `data/airports/KJFK.json`. `data/airports/KJFK.overrides.json` holds the hand-curated parts:
    missing names, pads, penalty box, departure lines and exits, the 31s configuration (land
    31L and 31R, depart 31L), and terminal and airline assignments. Also hardstands and hangars
    (Q, 2026-11-14): ground-controlled parking off the ramp (e.g. the South Hardstand) and
    hangars become taxi destinations. That extends the airport format (1.4, which today requires
    every gate on a ramp lane), 1.2's `Destination`, and 1.8's route resolution.
  - Depends on: 1.3, 1.4 (and 1.8 for the hardstand and hangar routes)
  - Acceptance: `npm run validate-airport -- KJFK` passes. Tests confirm runways 4L/22R, 4R/22L,
    13L/31R and 13R/31L exist with correct hold-shorts. A route "A then right on KE" from a
    known node resolves to a connected path (once 1.8 exists; until then a connectivity
    check). The 31L departure line has ≥ 2 exits. A taxi to the South Hardstand and one to a
    hangar each resolve to a connected path.

- [ ] **1.6 — Import LGA as a format check**
  - Scope: Run the importer on LGA to produce `data/airports/KLGA.json` (+ overrides as
    needed). Fix any JFK-only assumptions in the format or importer. Not playable.
  - Depends on: 1.5
  - Acceptance: `npm run validate-airport -- KLGA` passes. Intersecting runways are represented
    correctly (a test confirms the intersection's hold-shorts reference both runways). Any
    format changes are listed in STATUS, and KJFK still validates.

- [ ] **1.7 — Map renderer**
  - Scope: `src/web/map/` renders any airport file: runways, labeled taxiways, gates, ramp
    lanes, pads, and the active runway marking, with pan and zoom. It also draws an aircraft
    layer from the sim's state type: labels with callsign, type and destination, and color by
    role (departure / arrival / delayed). Mock aircraft are used until 1.9 exists. Airport
    chosen by URL (`?airport=KJFK`). Canvas or SVG: implementer's call.
  - Depends on: 1.5
  - Acceptance: `npm run dev` with `?airport=KJFK` shows all four runways and the main taxiways
    labeled. Q compares it side by side with the FAA diagram and confirms it's recognizable.
    A screenshot is saved to `docs/screenshots/kjfk-map.png`.

- [ ] **1.8 — Route resolution**
  - Scope: `src/sim/route.ts`: a pure function from a taxi or ramp instruction (ordered
    taxiways, optional turn directions, destination, hold-shorts) plus the aircraft's position
    and the airport graph, to a path. It returns either a path, "ambiguous turn at X" (both
    ways reach the destination and no direction was given), or "unable" with a reason (e.g.
    taxiways don't connect).
  - Depends on: 1.2, 1.4
  - Acceptance: Tests on TEST cover: turn directions honored; with no direction, it turns
    toward the destination; the ambiguous case returns ambiguity; a non-connecting route
    returns unable with a reason; the path ends at the runway hold-short or ramp entrance.

- [ ] **1.9 — Simulation core**
  - Scope: `src/sim/`: a fixed-tick loop with a seeded random number generator, world state,
    and `step(n)` for faster-than-real-time runs. Aircraft entities (callsign, type,
    footprint, position on an edge, speed, state) move along resolved paths: faster on
    straights, slower in turns, never reversing. They stop behind traffic ahead with spacing
    (see-and-avoid), stop at every runway hold-short without a crossing clearance, and obey
    hold position / continue. Commands from 1.2 are applied through 1.8. The sim emits events
    (e.g. "holding short", "unable").
  - Depends on: 1.8
  - Acceptance: Tests on TEST cover:
    - the aircraft follows the expected node sequence
    - it stops at a runway hold-short without clearance and proceeds with one
    - a follower never overlaps its leader over 1,000 ticks
    - hold and continue work
    - same seed plus same command script gives an identical state hash after 10,000 ticks
  - Context: Taxi speeds are the implementer's call (PRD §8.2).

- [ ] **1.10 — Simulated tower**
  - Scope: `src/sim/tower.ts` owns the runways and tracks their occupancy.
    - Arrivals: spawned on final at a set rate, land, roll out, exit at a configured exit,
      and emit "clear of runway, calling ground".
    - Departures: accepted at the hold-short after "monitor tower", lined up, and launched
      with spacing.
    - Crossing requests: find the next runway crossing on the aircraft's route (or the next
      runway ahead, if it has no route), then approve if clear, or hold and emit a callback
      when clear. The sim records approvals, for 1.12's checks.
  - Depends on: 1.9
  - Acceptance: Tests on TEST and KJFK cover:
    - an arrival lands, exits and emits its call
    - a handed-off departure takes off within a bounded time when the runway is free
    - a crossing request is approved when the runway is idle and held when an arrival is
      inside the window, with the callback emitted later
    - across 50 seeds, the tower's own actions never put two aircraft on a runway in conflict
  - Context: Release windows are Phase 3; don't build them.

- [ ] **1.11 — Simulated ramp**
  - Scope: `src/sim/ramp.ts`:
    - Tracks gate occupancy.
    - Departures: spawned at a gate, pushback animated (the only time an aircraft moves
      backward), taxied through ramp lanes to the ramp edge, where they emit a check-in with
      the taxilane name.
    - Arrivals: accepted at the ramp entrance after "monitor ramp", taxied to their gate,
      which emits "arrived at gate".
    - Holds aircraft when a lane is busy, and never deadlocks itself.
  - Depends on: 1.9
  - Acceptance: Tests on TEST and KJFK cover: a departure reaches the ramp edge and emits its
    check-in; an arrival handed over at the entrance reaches its gate and emits "arrived";
    opposing ramp movements in one lane complete without deadlock across 100 seeds.
  - Context: Metering and gate-availability delays are Phase 3.

- [ ] **1.12 — Rule checks and score counters**
  - Scope: `src/sim/rules.ts`:
    - collision: footprints overlap, which ends the session with a cause
    - unauthorized crossing: entering a runway on the player's clearance without a current
      tower approval; counted once per event
    - gridlock: mutual block with no forward path, lasting a threshold time; session-ending
      for now, until tugs exist (PRD §4.8)
  - Also `src/sim/score.ts`: departures at takeoff, arrivals at gate, totals, average rate, and
    a rolling 15-minute peak rate, combined and separate.
  - Depends on: 1.10, 1.11
  - Acceptance: Scripted scenarios cover: a forced runway collision is detected and ends the
    session; a crossing without approval is counted exactly once; a nose-to-nose standoff is
    detected after the threshold; a scripted 60-minute timeline yields the exact expected
    totals and rates.

- [ ] **1.13 — Playable in the browser with typed commands; Q tests**
  - Scope: The web app runs the sim in real time and renders it with 1.7. It has:
    - a dev console that takes terse syntax
    - click to select an aircraft, then T to request a crossing
    - a text event log showing check-ins, tower replies and unables
    - live counters and pause
  - Also write `docs/phase1-manual-test.md`: a step-by-step departure (gate → ramp edge →
    taxi → handoff → takeoff) and arrival (land → exit → taxi including a runway crossing with
    tower approval → ramp → gate) at KJFK. Hand to Q.
  - Depends on: 1.7, 1.12
  - Acceptance: Q completes the manual test in Chrome using only typed commands and the T key,
    and the counters show 1 departure and 1 arrival. Q's result is recorded in STATUS.

- [ ] **1.13b — Fixes from Q's run** (added 2026-11-16, after 1.13; Q: one cycle before 1.14)
  - Scope, from Q's manual run (`investigations/route-retries-q-run.md`) and Q's decisions:
    - **Route resolution** (`src/sim/route.ts`):
      - **"Straight on" (F3, F4):** a turn of only a few degrees counts as straight on, not
        left or right. Today, at the P/B/MB and Q/MB/A junctions both ways along B (and A)
        count as "left", so no route through them can be written.
      - **A taxiway that forks into same-named branches (F6):** U's Y onto A. A turn onto the
        next taxiway (`U L:A`) settles which branch.
      - For both: a sweep of KJFK for every junction of each shape, before and after.
    - **Messages name junctions by their taxiways, never node IDs** (F5; e.g. `route.ts`
      `doesn't go <turn> from <node>`, `apply.ts` `too close to stop short of … at <node>`).
      The "which way on X?" question says where.
    - **Every ramp entrance works both ways** (Q: "they all need to be accessible by all"):
      every KJFK `rampHandoffs` entry becomes `use: both` (today T1 M, T4 KG/KF/HB/A10/G, T5
      DA/A4 and others are one-way, from Q's Q7 list in 1.5).
    - **Pushback is a three-point turn, at every stand** (Q: "back up and turn the tail away
      from the exit until the nose is pointing the right way"): reverse out of the stand,
      tail swinging away from the way out, until the nose points toward it; then taxi forward
      to a ramp entrance. It never reverses onto a taxiway, and replaces both the taxiway push
      and the swing into a neighbouring stand. Departures always leave the ramp nose first.
    - **Clearance (Q):** the turn reserves everything it sweeps and waits until neighbours are
      clear. Where it can never fit inside the ramp, the stand is unusable for that type
      (the plan settles this, or a true multi-point turn; report the count either way).
    - **ANA8115** (seed 5, ~40:28: "left backwards on VA"): explained, and gone after the change.
  - Depends on: 1.13
  - Acceptance:
    - each fix has a test that fails before it and passes after;
    - the KJFK sweeps show no junction where a turn can't pick a way, and no fork a turn onto
      the next taxiway can't settle;
    - no unable or ramp message names a node ID;
    - every KJFK ramp entrance is `use: both`, and the validator passes;
    - no aircraft ever moves backward on a taxiway edge (a check over long runs), and every
      departure leaves the ramp nose first;
    - the full suite and the 2 h runs pass with sessions running; `docs/phase1-manual-test.md`
      and its twin updated if check-in points change; usable-gate counts before and after are
      reported.

- [ ] **1.14 — Scoring-path and soak tests**
  - Scope: A test-only "perfect player" bot in `src/sim/test/bot.ts` issues correct terse
    commands from sim state: routes via 1.8, requests crossings, and hands off. A simple
    interim spawner creates arrivals and departures at a configurable rate. Tests:
    - scoring path: every correctly handed-off aircraft reaches takeoff or its gate within a
      bound
    - soak: 3 simulated hours at peak rate × 10 seeds
    - ramp and tower never jam themselves
  - Depends on: 1.12
  - Acceptance: `npm test` includes the scoring-path test and it passes. `npm run test:soak`
    reports 0 lost or stuck aircraft, 0 collisions and 0 gridlocks across all seeds, and
    finishes in under ~5 minutes.
  - Context: The bot may be conservative: throughput isn't the point, the sim's reliability
    is. Peak rate comes from 1.3. Phase 3's real traffic generator replaces the interim
    spawner later.

## Parallelizable Tracks

- **Track A (voice):**
  - 0.1 and 0.2 can start immediately.
  - 0.5 needs only 0.1, so it can run alongside 0.2 and 0.3.
  - 0.4 is the one cross-track dependency: it waits for 1.2.
- **Track B (sim):**
  - 1.1 and 1.3 can start immediately.
  - After 1.4, the airport line (1.5 → 1.6 / 1.7) and the sim line (1.8 → 1.9) run
    independently.
  - 1.10 and 1.11 can be built in parallel.
  - 1.13b (fixes from Q's run) comes before 1.14: the soak tests should run on the fixed
    router and ramp.
