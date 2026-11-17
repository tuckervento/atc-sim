# Seed-6 head-on at the T7 W ramp edge

Reported (cycle 10): "an arrival taxiing in on W collided head-on with a departure sitting idle
at the W ramp edge. Both were the player's aircraft (ground's), and see-and-avoid didn't stop
them." KJFK, the app's traffic, `seed: 6`. Commands not recorded.

## FACTS (verified)

F1. Baseline at 9194022: `npm run typecheck` clean, `npm test` 439/439.

F2. Geometry (KJFK data, printed with `indexAirport`): T7 has two ramp handoffs named W, both
`use: both`, **2.4 m apart**:
- rhW  = n9328534916 (449.8, 852.5): W stub `w1256904562-n9328534916-n9328549521` (11.3 m) on the
  taxiway side; a 0.1 m lane, then a 14.9 m unnamed lane, on the ramp side.
- rhW2 = n9328526607 (447.7, 853.7): W stub `w1011116770-n9328549521-n9328526607` (11.4 m) on the
  taxiway side; a 53.1 m unnamed lane to n9328549519 on the ramp side.
- Both stubs meet W at the fork n9328549521 (454.5, 862.8). No edge joins rhW to rhW2.

F3. Reproduced headless, first try (scratch driver, `createSession` + `submit` + `requestCrossing`
+ `advance(0.2)` at 4×; arrivals told `taxi ramp <terminal> via W`, crossings requested and taken,
departures left idle where they check in):

| sim time | tick | command / event |
|---|---|---|
| 5:31 | 3312 | `FIN6993 taxi ramp T8 via W` |
| 5:59 | 3600 | `CAL9752 taxi ramp T4 via W` |
| 6:19 | 3798 | ICE988 (B738, T7 departure) checks in: "ICE988 taxiing on W" |
| 14:52 | 8928 | `EIN9265 taxi ramp T7 via W` (A333, cleared 31R at D) |
| 15:56 | 9568 | T on EIN9265 (request-crossing) |
| 16:00 | 9600 | `EIN9265 cross 31R` |
| 16:50 | 10101 | collision ICE988 / EIN9265, origin player |

At the collision: ICE988 idle, nose on n9328526607 (rhW2). EIN9265 taxiing at 1.0 m/s on the
rhW stub, nose (450.1, 853.3), 0.8 m before rhW. EIN9265's `blockedBy` is null: see-and-avoid
never named ICE988.

## THEORIES (unverified unless marked)

T1. **Neighbouring node, invisible to the graph.** EIN9265 is routed to rhW. ICE988 is
checked in at rhW2, 2.4 m away. ICE988's body lies only on the rhW2 ramp lane. That edge is not
on EIN9265's track and doesn't touch any node on it. So neither the in-line check nor the
occupied-node check sees ICE988. See-and-avoid is topological (edges, adjacency); the collision
check is geometric.

T2. **The arrival's track ends at the handoff node where the departure's nose is.** Its
mandatory stop is the end of track, at the entrance itself. Even if it saw the body, "stop at
the end" could put its nose into the departure.

T3. **Occupied-node half-span radius too small.** The node rule counts a body only within its
own half-span of the node, along an edge at the node. The departure's wing reaches the
arrival's path at a different place.

T4. **Pushed out past the ramp edge.** A taxiway-plan push (≤ 80 m) leaves the departure's body
on the taxiway, not where see-and-avoid expects.

T5. **Body facing the other way not "in line".** The in-line check fails for an opposite-facing
body on the same edge.

T6. **Cross footprint vs rectangle spacing.** The cross touches where SPACING_M assumed
clearance (a wingtip reaching sideways past a node).

## Tests

Scratch scripts, outside the repo (session scratchpad): `drive.ts` (the auto-player),
`inspect.ts` (a tick-exact replay of F3's commands, then inspection), `probe.ts`, `near.ts`.

**E1. Where are the two bodies, and what does see-and-avoid return, one tick before?**
- Why: to test T1, T2 and T4 together. They need the bodies' edges, the arrival's track and `trafficStop`.
- Predicted (T1): ICE988's body is on the rhW2 lane only, with no taxiway push. EIN9265's track
  ends at rhW, and `trafficStop` is null.
- Found (tick 10100):
  - ICE988: track `… n9328549519 → n9328526607`, s = track end (126.1), and its one body span on
    `w1011116770-n9328526607-n9328549519`. Heading 36.9°.
  - EIN9265: track `… n2994352435 → n9328549521 → n9328534916`, nose 0.94 m short of rhW. Heading
    199.1° (162° from ICE988's: head-on). `trafficStop(EIN9265)` = **null**.
  - At tick 10101: overlap is fuselage × fuselage.
- Means: T1 holds, and **T4 is refuted** here (the departure is on its lane, not pushed onto W).
  **T6 is refuted as a cause**: it's the fuselages, the cross's central bar, that overlap.
  Any footprint shape overlaps nose to nose at 2.4 m.

**E2. Is the arrival's destination itself inside the departure?**
- Why: T2.
- Predicted: EIN9265 with its nose at its own track end (rhW) overlaps ICE988.
- Found: overlap **true**.
- Means: T2 holds as a condition. The node the route gives the arrival as its stop is inside a
  standing body, so "stop at the end" is already a collision. It isn't independent of T1: if
  see-and-avoid saw ICE988, the traffic stop would come before the end.

**E3. Exactly why does each check miss?**
- Why: to pin down T1's mechanism, and to test T3.
- Predicted: ICE988 is only on the 53 m lane, and no edge at any node ahead holds it.
- Found:
  - `occupancy.byEdge` has ICE988 on `w1011116770-n9328526607-n9328549519` only, and in
    `byNode` nowhere.
  - The one node ahead is rhW. Its edges are the 0.1 m lane (empty) and the W stub (EIN9265 itself).
  - The fork n9328549521 is behind the nose by then. Its edges (W, both stubs) never held ICE988 either.
- Means:
  - **In-line** misses because ICE988 is on no edge of EIN9265's track.
  - **Occupied-node** misses because ICE988 is on no edge at any node of EIN9265's track.
  - The half-span radius is never reached, so **T3 is refuted**.

**E4. Control: does the occupied-node rule work when the body *is* on an edge at the node?**
- Why: to rule out a bug in the existing rule itself, as opposed to its scope.
- Predicted: EIN9265 re-tracked to rhW2 (ICE988's own node) gets a stop at about
  nodeAt(rhW2) − (17.9 + 20), behind ICE988.
- Found: `{ at: 838.36, behind: ICE988 }`, expected 838.4.
- Means: the rule is right within its scope. Its scope (graph adjacency) is the gap.

**E5. T5, a body facing the other way.**
- Found (code reading, `trafficStop`): the in-line check maps the occupant's interval by the
  *track's* direction through the edge (`edge.from === from`), not by the occupant's facing.
  `rules.test.ts` "two aircraft held facing each other with room between them" exercises it.
- Means: **T5 is refuted** as a cause here. Neither body is on the other's track at all.

**E6. Is the trigger a one-off?**
- Why: to tell a data quirk from a class of geometry.
- Found (KJFK data):
  - Three twin ramp handoffs: rhW/rhW2 2.4 m apart and rhVA/rhVA2 4.2 m apart (T7, both `use: both`);
    rhS/rhSA 2.0 m apart (T8, arrivals: two waiting arrivals can pair there too).
  - 35 node pairs under 10 m apart with no edge between them: 11 taxiway-only, 15 ramp-lane-only,
    8 lane + taxiway, 1 runway + taxiway.
- Means: wherever two nodes are close in the plane but not joined in the graph, a body at one is
  invisible to an aircraft going to the other.

**E7. Both moving: the ramp's departure taxiing out to rhW2, ground's arrival in to rhW.**
- Why: to test whether the gap also covers a moving pair, and whether a reserved ramp mover is
  protected by its reservation.
- Setup: DEP2 (B738) at T7 gate 10, whose pushback plan exits at rhW2. ARR2 (A333) added on W
  80 m along `w1256904562-n2994352435-n2994352438`, at a lead time relative to DEP2's taxi-out.
- Found, before the fix (main 9194022): every timing tried (lead 0, 6 s, 12 s) collides, at
  +199, +242 and +302 ticks. In the 6 s and 12 s cases ARR2 had already stopped at rhW, and the
  *ramp's* departure drove into it. Its reservation was granted before ARR2 got there, and
  nothing re-checks a held segment against a body that arrives later.
- Found, after the fix: at 11 timings (leads 0–15 s, ARR2 start distances 30–80 m), no overlap.
  The first to arrive stops at its own end, and the other stops short, blocked by it. When
  they converge almost at once, the second stops 1.5–4.5 m from its end with no overlap, but
  with less than SPACING_M to spare. That's the header's known "converging at once" limitation.

## Root cause

- **Immediate:** EIN9265 was routed to rhW. ICE988 sat idle with its nose on rhW2, 2.4 m away.
  ICE988's body was on no edge of EIN9265's track, and on no edge at any node of it, so
  `trafficStop` returned null. EIN9265 taxied to its track end, which is inside ICE988's footprint.
- **Systemic:** see-and-avoid decides "in my way" by **graph adjacency, measured along the
  track**: the same edge, or an edge at a node ahead. The collision rule (1.12) decides by
  **footprint geometry in the plane**. Nothing connects the two models. Anywhere the graph
  understates nearness in the plane is a blind spot:
  - twin handoffs, close parallel lanes, near-coincident junction nodes (E6);
  - a body just past a sharp bend, far along the track but beside it in the plane (E10).
- **Root:** the design treats the airport graph as the model of space for spacing, on the
  unstated assumption that "close in space ⇒ adjacent in the graph". Nothing checks it, neither
  airport validation nor a geometric guard in see-and-avoid. The OSM-derived KJFK data breaks it
  in at least 35 places. So the safety net that's meant to stop "bodies nobody reserves for"
  (reservations.ts header) was breakable wherever the data was.

## The fix (src/sim/traffic.ts)

A third see-and-avoid rule, **footprints** (final form, after E8 and E10). The aircraft's own
footprint (`footprintOf`, the shape the collision rule uses) is swept along its track ahead, up to
the lookahead, in 1 m steps. At the first nose position where it would overlap another ground
body's current footprint (bisected to 1 mm, on the overlapping side), it plans to stop SPACING_M
short. For a body the graph rules (in-line, occupied node) found, the contact counts only if it
comes at or before their stop for that body, that is, when their stop wouldn't keep the two apart.

Why it's general: it covers every place where the graph's distances disagree with the plane:
- nodes close but unjoined (E6: three twin handoffs, 35 close unjoined node pairs at KJFK);
- bodies past a sharp bend (E10).

It's stated in the collision rule's own terms (don't drive into a footprint overlap), and nothing
in it is specific to a node, a seed or an airport. It fires only where going on *would* collide, so
it adds no stop beside a parked aircraft or parallel traffic that it would clear. Where the graph
rules' stop already keeps a body clear, theirs stands, and nothing changes (E8: tower-capacity's
counts are identical).

Constraints it keeps:
- **The reservations' promise** (reservations.ts header, checked by reservations.test.ts): see-and-avoid
  never stops a reserved movement short of what it holds for another reserved body. So a movement
  under way skips bodies the reservations hold. They already keep those apart with a 1.5 m margin.
- **Exact spacing where the old rules apply** (sim.test.ts `toBeCloseTo(…, 5)`): the contact
  point is taken on its overlapping side, so on a straight queue the in-line stop wins the tie.
- **Already overlapping:** skipped. That's a collision, not this rule's business, and tests that
  overlap aircraft on purpose behave as before.
- **Airborne:** no footprint on the ground (rules.ts), so no sweep.

Cost: a first version doubled the heavy test files (51.7 s → 114.7 s for the four). A profile
showed footprints and SAT tests dominating, not `pointOf`. Three changes fixed it, none of them
changing behaviour:
1. Bodies' footprints are reused while an aircraft's track object and `s` are unchanged. A grep
   found no in-place track mutation outside tests.
2. A box test before every polygon test.
3. Skip-ahead: where the nose is `gap` beyond reach of a body's box, the next `gap` metres are clear.
4. Each body's sweep stops at the nearest stop found so far (+ SPACING_M): a later contact can't
   give a nearer stop.

**E8. The first version changed a queue's behaviour where nothing was wrong.**
- What: `tower-capacity.test.ts` (KJFK 31L) ran past its 30 s limit (51.8 s, against 7.0 s for the whole
  file at baseline). Seed 1 also had 34 takeoffs, against 37 at baseline.
- Theory: the old queue overlapped in Z's bends unnoticed (the test doesn't check overlaps), and
  the fix was now keeping it apart.
- Test: replayed the test's KJFK seed-1 hour, counting ticks with any footprint overlap.
- Found: main has **0** overlapping ticks (37 takeoffs); the first version has 0 (34). **Refuted.**
- Means: applied to every body, the footprint rule keeps SPACING_M from *footprint contact*,
  not nose-to-tail along the track. Through a bend a follower's wing reaches the leader's footprint
  before its nose reaches the tail, so the queue went looser, and it cost throughput and time
  without preventing anything.
- Change: the rule applies only to bodies **neither graph rule found ahead**, which is exactly the
  bug class. Wherever the old rules saw a body, behaviour is unchanged. Verified: tower-capacity's
  six runs give exactly the baseline counts (KJFK 37/35/38 takeoffs, 15/14/14 landings; TEST
  36/35/36, 15/15/15), in 10.4 s against 7.0 s.
- Residual (in the traffic.ts header's "Not handled"): a body the graph rules find only far
  ahead, but whose footprint reaches the path sooner, still gets only its graph stop, as before.

**E9. The app-traffic sweep, KJFK seeds 1–20, 60 sim minutes each** (scratch `sweep.ts`).
- Narrow (what the reporting agent did): `<ARR> taxi ramp <terminal> via W`, crossings requested
  and taken, arrivals left at the entrance, departures idle at check-in.
  - Before: 1 collision (seed 6, 16:50, ICE988/EIN9265); 19 running.
  - After: 0 collisions; 20 running.
  - Weak coverage: `via W` is unable for 11–12 of 12 arrivals in most seeds.
- Wide (stronger): the same, but each arrival is routed by a shortest-path search over taxiways to
  its terminal's entrances, with the sim's route resolver as the judge. Before the fix: **11
  collisions**, 1 gridlock, 8 running. After the first fix (graph-unseen bodies only): **4
  collisions** (seeds 6@50:11, 7, 8, 18), 2 gridlocks.

**E10. What the first fix still missed (seed 8, wide).**
- Theories: R1, a body the graph sees only far along the track but whose footprint reaches the path
  sooner; R2, converging movers; R3, the victim not in occupancy; R4, the reservation exemption;
  R5, already overlapping when first looked at.
- Found, one tick-frame before:
  - LOT2548 (B789) on A northbound at 5.5 m/s. `trafficStop` = in-line stop, 20 m short of DLH276's
    tail *along the track*.
  - DLH276 (A333) stands on the NA stub to rhNA, which leaves A and doubles back south-east, so
    its wing and tailplane are beside A, short of the bend. Neither is a reserved movement.
- Means: **R1**. The in-line stop was inside DLH276's footprint. R2–R5 are ruled out for this
  pair (both on the ground and in occupancy, neither reserved, no overlap yet).
- Regression test first (`traffic.test.ts`, "KJFK T1 rhNA"): failed, overlap at tick 102.
- Change: for a body the graph rules found, the footprint stop counts if its contact comes at or
  before their stop for it. Then their stop wouldn't keep them apart.
  - Test: passes.
  - tower-capacity: identical baseline counts, so no queue contact fell before an in-line stop.
  - Wide sweep: **0 collisions**, 2 gridlocks, 18 running.
- The two gridlocks:
  - Seed 1: identical before and after the fix (EVA1765/ICE8906 at 59:27), so not from this change.
  - Seed 4 was a collision before. Now KLM165 (idle on its exit, its exit track running on to node
    n1744054649) and JBU8604 (routed through that node from the other side) stop nose to nose,
    39.7 m apart, each blocked by the other. That's the header's "converging on a free
    junction" case, made by the player's routing. rules.ts counts it as a gridlock by its own
    definition.

## Later (PLAN 1.13c, 2026-11-17)

KJFK's twin ramp handoffs (W/W2, VA/VA2, S/SA) were merged into one each at Q's decision, which
settles the open questions 2 (merge them) and 4 (the near-reversal through the 2.4 m pair onto
rhW) in STATUS's seed-6 entry (Deviations, 2026-11-16). The footprint rule stays: it covers any body close in the plane but far in
the graph, and `traffic.test.ts` keeps the W/W2 geometry as a fixture (`KJFK_TWINS`).
