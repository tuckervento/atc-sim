# STATUS

_Last updated: 2026-11-14 (parallel cycle 2: 1.2, 1.4, 0.3, 0.5 dispatched)_

## Snapshot

4 of 20 tasks done (0.1, 0.2, 1.1, 1.3). 1.2, 1.4, 0.3 and 0.5 in progress in parallel (Q-directed parallel cycle 2).

## Completed

- [x] 0.1 — Shortlist providers and set up access — done 2026-11-14 — verified: after Q added keys to `spikes/voice-loop/.env.local`, `npm --prefix spikes/voice-loop run check-keys` printed `OK` for anthropic, openai, deepgram, assemblyai, elevenlabs and cartesia, and exited 0. `.env.local` is gitignored. § Shortlist of `docs/spikes/voice-loop.md` is complete (checked earlier the same day).
- [x] 0.2 — Test-set script and recorder; Q records — done 2026-11-14 — verified:
  - `spikes/voice-loop/test-set/script.md` has 34 lines covering C1–C10 and C12 (C11 on line 34, unscored).
  - Recorder smoke test: GET / → 200, `/api/lines` → 34 lines.
  - Q recorded all 34 lines. I decoded each file in `test-set/audio/` (gitignored): 3.06–11.34 s.
  - Q confirmed the spot-check of 5 recordings (02, 09, 17, 24, 31) on 2026-11-14.
- [x] 1.1 — Scaffold the repo — done 2026-11-14 — verified by me after the subagent:
  - `npm install`, `npm run typecheck` (exit 0) and `npm test` (exit 0; 1 file, 1 test passed).
  - Vite dev server on :51799 returned GET / → 200 with `<title>ATC Ground — scaffold</title>`. The process was stopped and the port freed.
  - DOM exclusion: a temporary `src/sim/__verify_dom.ts` (`document.title`) made typecheck fail, exit 1, `TS2584: Cannot find name 'document'`. After removing it, typecheck passed (exit 0).
  - The page was checked with curl, not in a real Chrome window.
- [x] 1.3 — Verify airport data and facts — done 2026-11-14 — verified by me after the subagent:
  - `docs/research/airport-data.md` has every acceptance item: exact Overpass queries, counts per airport, missing named taxiways vs FAA diagrams (cycle 2611), rule citation, peak numbers with source, and the data-source decision (OSM base + overrides).
  - I re-ran the LGA query (`out tags` variant): 604 elements, per-type counts identical to the doc (e.g. 136 parking_position, 117 holding_position, 110 taxiway, 80 gate, 2 runway).
  - The FAA 7110.65 §3-7 page reads: "Issue a crossing clearance to aircraft for each runway their route crosses."
  - FAA Order 73 FR 3510 reads: "arrivals and departures will not exceed 81 per hour from 6 a.m. through 10:59 p.m."
  - Partial (documented as [Unverified] in the doc): where the 31L queue forms and its exits, the penalty box / pad locations, and the arrival/departure split of the peak.

## In Progress

- 1.2 — Command format and terse-syntax parser. Plan approved 2026-11-14; dispatched to a subagent.
- 1.4 — Airport format, loader and validator. Plan approved 2026-11-14; dispatched to a subagent.
- 0.3 — Speech-to-text bake-off. Plan approved 2026-11-14; dispatched to a subagent.
- 0.5 — Voice bake-off; Q listens. Plan approved 2026-11-14; dispatched to a subagent. Ends with a hand-off to Q (listening verdict).

## Blocked

## Deviations & Decisions

- 2026-11-14 — **Parallel cycle.** Q directed iterate-plan to run 0.1, 0.2, 1.1 and 1.3 at once with parallel subagents (Opus), instead of one task per cycle. So In Progress held four tasks this cycle. Each subagent owned a separate set of paths (recorded in `~/.claude/plans/zany-snacking-llama.md`).
- 2026-11-14 — **npm instead of pnpm.** pnpm and corepack aren't installed; Node v26.13.0 and npm 11.20.0 are. Q chose npm. PLAN.md's commands were updated to match (`npm run …`, `npm --prefix spikes/voice-loop run …`); task IDs and scope unchanged.
- 2026-11-14 — **`.gitignore` handled centrally**, not inside 0.1, so the parallel agents didn't edit the same file. Added: `node_modules/`, `dist/`, `.env` and `.env.*` (except `.env.example`), `spikes/voice-loop/test-set/audio/`, `spikes/voice-loop/samples/`, `.DS_Store`.
- 2026-11-14 — **Test-set audio stays out of git** (PLAN 0.2's default; Q accepted the draft as is).
- 2026-11-14 — **PRD §9.2 updated** to describe the terse typed-command syntax (Q decided during draft-plan).
- 2026-11-14 — **1.1 choices:**
  - The page is `src/web/index.html`, with Vite's root set to `src/web`, so Vite never scans HTML under `spikes/`.
  - Extra configs: `tsconfig.base.json`, `tsconfig.node.json` (for configs and `tools/`), and a root `tsconfig.json` with references for editors. Plain `tsc` checks nothing; `npm run typecheck` is the real check.
  - Extra strict flags: `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `erasableSyntaxOnly` (which bans enums, namespaces and parameter properties).
  - TypeScript 7.0.2 (the native release), Vite 8.3.8, Vitest 5.1.0. A `build` script was added.
  - Two questions are pending Q: allow `console` in sim code (currently a type error)? Deny fsevents' install script? (I checked: the package has no install script; only the lockfile's `hasInstallScript` flag triggers npm's warning, and the prebuilt binary loads fine.)
- 2026-11-14 — **0.1 choices and findings:**
  - Six providers, adding Cartesia as the optional third voice service because it's strongest on accents.
  - OpenAI retirements, which I confirmed on OpenAI's deprecations page:
    - `tts-1`, `tts-1-hd` and `gpt-4o-mini-tts` shut down 2027-01-06, so the OpenAI voice is `gpt-realtime-2.1-mini`. It has no verbatim mode and no documented accents, which makes it the weakest voice option.
    - `whisper-1` and `gpt-4o(-mini)-transcribe` shut down 2027-02-26, so OpenAI speech-to-text is `gpt-live-transcribe` or `gpt-transcribe`.
    - `gpt-5-nano` shuts down 2026-12-11, replaced by `gpt-6-luna`, which is the OpenAI interpreter candidate.
  - ElevenLabs pick: `eleven_flash_v2_5`. The agent reports v3, v4 and v4 Turbo lack rate control; I haven't checked this myself.
  - Estimated cost at the peak assumption: $1.06–$2.77/hr across combinations, all under the $5 soft cap. Voices are 50–75% of it.
  - Implementation:
    - No `tsx`: Node 26's built-in type stripping runs the scripts.
    - Anthropic check uses `@anthropic-ai/sdk` pinned to 1.3.0.
    - `.env.local` overrides the shell, and an empty value counts as MISSING.
    - check-keys redacts key fragments that providers echo back in error messages (OpenAI does).
- 2026-11-14 — **0.2 choices:**
  - 34 lines instead of ~30, so each command type gets at least two. Each line has an added `style` field (textbook or loose).
  - A shared parser, `recorder/script.mjs`, for 0.3 and 0.4 to reuse.
  - Takes auto-save when Space is released. The recorder uses port 8740.
  - The routes are invented but consistent with each other.
  - Taxiway names flagged as possibly not at JFK: KC, KK, H, J, Y.
  - Line 34 (C11) has no command in 1.2's format, so 0.4 may leave it unscored.
  - The recorder still needs a real-microphone test; Q's recording session was the first one.
- 2026-11-14 — **Incident (1.3): Q's email address was sent to an external service.** The subagent's first Overpass request put Q's email in its User-Agent header. This can't be undone. Later requests used a generic header.
  - Cause: Overpass asks for client identification, and the agent had Q's email in its context.
  - Prevention: agent prompts for tasks that touch external services must forbid personal information in requests.
  - Note: Overpass returns HTTP 406 for curl's default User-Agent. A descriptive, non-personal one, `atc-sim/0.1 (personal research)`, works.
- 2026-11-14 — **1.3 findings that affect later tasks:**
  - JFK's most-used setup is the 31s, but real arrivals use 31L as well as 31R. The PRD's "land 31R only" is a simplification.
  - Runways intersect at JFK too (4L/22R crosses both 13s), so a hold-short must be able to reference more than one runway.
  - 7110.65 allows several runway crossings in one clearance where centerlines are 1,300 ft apart or less.
  - The PRD §4.3 example "clear of 31R at Kilo Echo" is geographically wrong: KE touches only 13R/31L.
  - Peak is 81 scheduled ops/hour (FAA order cap); the doc proposes a 40/41 split.
  - LGA's ramp lanes are numbers, so names must be strings, and the terse parser must accept numeric lanes.
  - Six questions for Q are in §11 of the doc. Q's answers are in the next entry.
- 2026-11-14 — **Q's decisions after the parallel cycle** (all applied or recorded for the task that needs them):
  - **`console` allowed in sim and airport code.** Added `src/sim/console.d.ts`, which declares `log`, `info`, `warn`, `error` and `debug` only. Verified:
    - A temp file using `console.log` passes typecheck (exit 0).
    - The same file with `setTimeout` and `document` fails (TS2304 and TS2584, exit 1).
    - With the temp file removed, typecheck and test both exit 0.
  - **fsevents install script denied.** `npm install-scripts deny fsevents` added `"allowScripts": { "fsevents": false }` to `package.json`. `npm install` no longer warns, and fsevents still loads.
  - **0.5:** keep all six providers, including Cartesia. Benchmark OpenAI's voice, but rank it last: it may paraphrase, and has no documented accents.
  - **0.4:** script line 34 (C11 follow / give way) stays in the test set, unscored.
  - **1.5:** only today's operating terminals go in the data: T1, T4, T5, T7, T8. New Terminal One is expected Q1 2027, and T6 isn't confirmed open. Q will supply the 31L departure line, its exits, the holding pads and the penalty box from their own maps when 1.5 needs them. Ask Q; don't guess.
  - **31L also takes arrivals.** The 31s are now: land 31L and 31R, depart 31L. Updated:
    - PRD §4.1, §5 mockup, §8.4 and §14
    - PLAN 1.5 scope
  - **1.10 must interleave landings and takeoffs on 31L**, because it's now used for both. This isn't in 1.10's Acceptance line yet, so the 1.10 plan should add a test for it.
  - **1.14 soak peak:** 81 operations/hour, 40 arrivals and 41 departures (the FAA order cap), plus a stress run at about 94/hour (the 31s' capacity). The 40/41 split is an assumption.
  - **PRD Kilo Echo examples fixed.** KE meets only 13R/31L (OpenStreetMap and FAA diagram).
    - Arrival examples now read "clear of three one left at Kilo Echo".
    - Crossing examples now read "cross four left at Juliet". The NTSB report AIR-24-01 calls B/A → J, crossing 4L, the standard route to 31L.
  - **1.4 / 1.5 closures:** model taxiway closures as data (closed segments in the overrides file). Defer the "no southbound turns from NB onto A" restriction; it needs a turn-restriction concept in the format.
- 2026-11-14 — **Parallel cycle 2.** Q directed 1.2, 1.4, 0.3 and 0.5 to run at once with parallel subagents (Opus). Each owns a separate set of paths (recorded in `~/.claude/plans/zany-snacking-llama.md`). 0.3 and 0.5 write their doc sections as drafts in `spikes/voice-loop/results/`, which I merge into `docs/spikes/voice-loop.md`, so they never edit the same file.
- 2026-11-14 — **Import convention: relative imports name the `.ts` file** (`./route.ts`). `tsconfig.base.json` gained `allowImportingTsExtensions` and `resolveJsonModule`. So `tools/` scripts run with plain `node` (Node 26's built-in type stripping, no `tsx`), the same code works in Vite and Vitest, and tests can import `data/airports/*.json` (with `with { type: "json" }`). Verified:
  - A scratchpad `.ts` importing `.ts` and `.json` ran under Node (exit 0).
  - Root typecheck and test still exit 0.
- 2026-11-14 — **Spike package set up centrally for 0.3 and 0.5:**
  - Added `ws` (dependency) and `@types/ws` (dev), for provider WebSockets that need auth headers.
  - Added scripts `stt-bench` → `node stt-bench.ts` and `tts-bench` → `node tts-bench.ts`.
  - Spike typecheck exits 0, and check-keys still shows 6 OK, exit 0.
  - Agents don't edit the spike's `package.json`.

## Next Up

- 1.2 — Command format and terse-syntax parser. It depends only on 1.1, which is done, and 0.4 waits on it.
- Also eligible now: 1.4 (needs 1.1), 0.3 (needs 0.1 and 0.2) and 0.5 (needs 0.1). All their dependencies are done.
