# Arrivals stuck at ramp entrances, seed 666 (2026-11-16)

Q, playing KJFK seed 666: EVA1126 and AAL3885 "don't seem to be switching over to the ramp ...
they're just sitting there for minutes, and i'm not getting a 'they're not listening to you'
error when i try to tell them to switch to ramp multiple times". Notes only: nothing is fixed yet.

## How it was reproduced

A headless replay of the `›` commands in Q's log paste (which starts at 3:47) on seed 666,
through the session API the app uses (`createSession`, `submit`, `advance` at 0.1 s steps), run to
24:13, then the sim state inspected. The scripts were scratch files, not kept in the repo.
The replay runs the working tree, not Q's build, so the log differs a little: junction names
(`A/N` for `n2994352436`), and AAL3885's `R:B` was refused with a different reason, so its first
`taxi ramp via B S` route stood. The end state matches Q's: both waiting, ground's.

## FACTS (verified in the replay)

### Why there's no "not on frequency" reply
- Both are still `controller: 'ground'`, stopped (`v 0`) at the end of a taxi to a ramp entrance,
  with `advisories.handoff = { mode: 'contact', facility: 'ramp' }`.
- `apply.ts` only says `not-on-frequency` when `controller !== 'ground'`. A handoff only records
  the advisory; ramp makes the aircraft its own (`controller: 'ramp'`, `ramp-accepted`) only in
  `startTaxiIn` (`ramp.ts`). Until then each `contact ramp` records the same advisory again and
  emits `command-applied`, which the log doesn't print, so the player sees nothing.
- This is the documented behaviour (ramp.ts header, "Not handled"; docs/terse-syntax.md, "no gate
  free"), not a crash or a lost state.

### EVA1126 (B77W, T1, entrance NA): a gate it can't get to
- It has a ramp record: phase `called`, gate `g632238190`, since tick 9330. Every tick
  `startTaxiIn` asks `admit` for its way in and is refused. The blocker returned is `THY1613`:
  the A359 parked at T1 gate 3 (`g632238191`, the neighbouring gate) since 10:18.
- The refusal is a shape overlap, not see-and-avoid: it's refused the same with the leg's
  `seeAndAvoid` off. THY1613's tail is 77 m inside its own stand, nowhere near the lane.
- The way in is 133.6 → 415.5 m of nose travel; EVA1126's own lead-in is 302.4 → 415.5. The first
  refused stop is at about 381 m, inside its lead-in. Its parked spot at the gate is clear (8.7 m
  between the crosses), as `assignGate` checked.
- With the same way, a span of 60.39 m or less is admitted; the B77W's is 64.8 m.
- Closest approach along the way in, measured at 1 m steps:
  - the real cross footprints (footprint.ts's three rectangles): **3.38 m**, near s = 404;
  - their convex hulls, which the reservations use: **1.69 m**, near s = 389.
  The reservations grow every hull corner by a MARGIN_M square (1.5 m each way), so two shapes
  need more than 3.0 m between them (up to 4.24 m on a diagonal).
- THY1613's turnaround is due at tick 76861 (2:08:06 sim time, `then: 'depart'`). Until then
  EVA1126 waits at NA, about 1h44m after the replay's end.
- **Systemic cause:** `assignGate` picks a gate whose parked footprint is clear and to which a
  lane path exists. It doesn't ask whether the way in is passable past what's parked for good.
  Once assigned, the gate is held (`<callsign> gate`) and never re-picked. So ramp can promise
  a gate the arrival can't reach.

### AAL3885 (A321, T8, entrance S): no gate at all
- It has no ramp record: `entranceOf` returns the entrance (it's at the end of its route, `rhS`
  serves T8 arrivals), so `assignGate` returns null each tick.
- T8 has 39 gates: 3 occupied, 4 too short for an A321, 32 free that it fits and can leave.
- Over ramp lanes, forward from S as it arrived, only 2 of them are reachable (the ramp's
  `arrivalWays` cache: 2 ways, 33 none): **32F**, where BAW4372 is parked (since 9:09), and
  **32G**. 32G passes every other filter, so `parkedConflict` must refuse it: inferred by
  elimination (pickGate returns a gate for any non-empty pool), not called directly. BAW4372 at
  32F, next door, is the likely conflict.
- Another entrance would have worked: the same replay with only AAL3885's command changed, at
  18:13:
  - `taxi ramp via B NC, contact ramp`: at NC 21:32, parked at T8 gate 14 at 23:42;
  - `taxi ramp via B NB, contact ramp`: at NB 21:49, parked at T8 gate 5 at 23:02;
  - `taxi ramp via B SA, contact ramp`: stopped at the T8 ramp entrance **S**, not SA, and waited
    as before.
- T8's entrances (data/airports/KJFK.overrides.json): TA and T departures; NB both; NC, S, SA
  arrivals.

## THEORIES / open questions (not tested)

1. Ramp lanes past S: are 32F and 32G really all S can reach, or is there a lane missing in the
   data, or a turn over MAX_TURN_DEG (135°) cutting the rest off? Look at the map.
2. `via B SA` ending at S: the router may stop at the first ramp entrance for the terminal along
   the route (S comes before SA on the way), or SA's node may sit past S on the same chain.
3. Would 32G and 32F both be usable with less conservative shapes? Their parked hulls conflict;
   their crosses may not.
4. How common EVA1126's case is: neighbouring widebody stands at T1 (and elsewhere) whose ways in
   pass within the hull of a parked neighbour. A sweep over gate pairs and types would count it.
5. Where the margin comes from: corner squares (Chebyshev growth) make the needed gap depend on
   orientation (3.0–4.24 m). A round offset would make it 3.0 m everywhere.

## Tolerances in play (for relaxing; Q: "the tolerances inside the ramp need to be relaxed")

From the most to the least slack, as measured here:
- **Convex hulls** of the cross (reservations.ts, `segmentsOf`): the hull fills in between
  wingtip, nose and tailplane tips. In EVA1126's case it cost 1.7 m (3.38 → 1.69) and is what
  turns a pass into a refusal. The footprint header records the cross was chosen over boxes for
  exactly this kind of false conflict (cycle 9); the hull brings some of that back.
- **MARGIN_M 1.5 m**, grown as a square at every corner: 3.0 m apart at least, up to 4.24 m.
- **Footprint proportions** (footprint.ts): each part meant to cover the real one (wing rectangle
  across a swept wing, FUSELAGE_WIDTH 0.11, TAIL_SPAN 0.4).
- **Stand fit** (ramp.ts): tail farther from the lane junction than the half-span. Not involved
  here.

## Proposed (Q agreed in principle to 1 and 3; the tolerance change is open)

1. `assignGate` offers only a gate whose way in is passable past what's parked for good, and
   re-picks when that's the refusal.
2. AAL3885's case: Q asked whether another entrance would have worked (yes, above). The "no gate
   yet" call is Phase 3.
3. A reply to a repeated handoff to ramp from an arrival waiting at an entrance (e.g. "waiting
   for a gate"), so the player sees why it hasn't gone.
4. Relax the ramp's tolerances: see above for which.
