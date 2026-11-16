# One takeoff short after merging the collision fix with the main-gear turning (2026-11-16)

## Facts (verified)

- `main` with both merged (uncommitted): 454 of 455. `ramp-safety.test.ts:209`
  `expect(first.counts['took-off']).toBeGreaterThanOrEqual(18)` gets 17.
- The turning branch alone (worktree agent-a6a34ca214be9154f): 450 of 450.
- The collision branch alone (worktree agent-a6075ed1d596b6797): 444 of 444.
- The other assertions in that test pass on `main` (vitest reports the first failure only, so not
  yet verified for the lines after 209).
- `traffic.ts` `footprintStops` assumes "the footprint is rigid about the nose" for its reach
  bound and skip-ahead. With the main-gear axis that's no longer exact in a bend.

## Theories

1. The footprint rule fires more with the new footprint in bends (the wing reaches the leader
   earlier along the track), so queues spread and one takeoff slips past 2 h.
2. The reach bound is wrong under the new footprint: but that would miss contacts (fewer stops),
   so on its own it can't cost a takeoff. It could change *which* stops happen, though.
3. The turning change alone alters timing (no footprint rule involved), and the collision change
   alone too; together the butterfly lands one takeoff past the 2 h mark. Not a slowdown, chance.
4. A real new stop: a body the graph rules don't see, which the new footprint now overlaps and
   the old didn't (or the reverse), e.g. at the T2/T1 ramp entrances.
5. The new footprint changes the reservations or rules.ts (collision ends the session?) path
   rather than traffic.ts: e.g. a stand rule or pushback geometry reading `footprintOf`.

## Tests

Probe: a copy of the test's `longRun` (scratchpad `thr/longrun.ts`), run against four code roots:
neither (HEAD 9194022), turning only, collision only, both (main, uncommitted).

1. **Seed 1, four roots.** neither / turning / collision: 23 takeoffs, 12 at gate. both: 17, 9.
   Not chance (theory 3 out): something gets stuck.
2. **Per-aircraft timeline.** In both, nothing takes off after JBU9 checks in (tick 50575).
3. **Dump at 52000.** JBU9 (eastbound on A) and BAW12 (off C, to TC) stopped, noses 1 m apart at the
   C/A junction (300, 200), each `blockedBy` the other.
4. **Trace 51000–52000, all four roots.** All four collide at tick 51898
   (`session.cause.kind = collision`, JBU9+BAW12), HEAD included. JBU9 at 9.9 m/s sees BAW12 at
   ~24 m (51870), too late. On HEAD BAW12's nose clears the node (s 110.4 at 51900) and drives on;
   in both it stops 1.6 m short (s 108.5).
5. **Per tick, BAW12's stop.** collision only: first stop at 51879 (72.10, graph occupied-node
   rule). both: the footprint rule finds the contact at 51871 (stop 104.46), 8 ticks earlier, so
   it brakes sooner and ends short of the node, where the occupied-node rule holds it for good.
6. **Session state, seeds 1–5, HEAD and both.** HEAD: seed 1 collides, 2–5 run. both: seed 1
   collides; seed 3 ends in **gridlock** JBU6+AFR6 at 34982 (10 takeoffs). Seed 3 on turning only:
   **collision** JBU6+AFR6 at 34365; on collision only: runs.
7. **Seed 3 trace (turning only).** AFR6 turns out of T2's lane (TB, x=100) onto A in front of
   JBU6 (10.7 m/s on A, sees it ~40 m out, overruns its in-line stop at ~80 to 85.6). With the
   main-gear axis AFR6's tail lies back over A, not up TB, so the overrun touches it. In both, the
   footprint rule stops it first, but AFR6 can't go on: its tail swing would hit JBU6's nose, and
   JBU6 can't back up. Gridlock after 60 s.

## Conclusion

- Root cause: see-and-avoid plans against where bodies are now, so two movers converging on a
  junction don't see each other until one is in the other's path. traffic.ts lists this as
  "Not handled" since 1.4 ("1.12's collision check to catch"); STATUS 1.4 records it too.
- Why it went unseen: the 2 h TEST run never asserts the session is still on. It has ended in a
  collision on seed 1 since the collision rule landed.
- The turning change makes it bite more (a merging aircraft's tail now lies over the through
  taxiway, as a real one's does); the footprint rule turns overlaps into standoffs (gridlock).
  Neither branch is wrong on its own terms.

## Resolution (Q, 2026-11-16: "option 1, pilots yield, and add the session check")

- traffic.ts gains a fourth see-and-avoid rule, "Converging": at a junction ahead, a mover coming
  in on another edge (not following, not head-on) that goes first makes this one stop its
  half-span plus SPACING_M short. First: can no longer stop short, then earlier arrival (at least
  ETA_FLOOR_MPS), then callsign. Tests: src/sim/traffic-converging.test.ts (5, each with a killed
  mutation; the "yield ends" case is covered by tests 1 and 3).
- Session checks added: ramp-safety (longRun on seeds 1 and 2, every run() seed), tower-safety,
  tower-capacity. A temporary trace on rules.ts showed no other test's sim ends a session except
  the deliberate ones (rules.test.ts, session-log.test.ts).
- 2 h run, seeds 1–5: session running on all; takeoffs and gate arrivals identical to HEAD
  (23/12, 23/12, 22/8, 22/9, 22/8).
- tower-capacity: counts identical on all six runs; 16.0 s against 15.2 s.
