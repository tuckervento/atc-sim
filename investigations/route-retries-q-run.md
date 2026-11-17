# Route retries in Q's manual run (2026-11-16)

Q, after the 1.13 run: "make notes of the parts of my log that had multiple tries to get the
correct route ... there may be some minor bugs in either the map layout or the routefinding".
KJFK, seed 5, in Chrome. Times are the sim clock. Notes only: nothing here is fixed yet.

## The retries (from Q's two log pastes)

**A. EVA5194, arrival off 31L at MC, to T1** (2 failures, then a different route)
```
5:37 › EVA5194 taxi ramp via P hs B
5:37 EVA5194 unable (taxi): taxiway P doesn't lead to a ramp entrance for T1 in the direction of travel
5:37 › EVA5194 taxi ramp via P hs B          (the same again)
5:37 EVA5194 unable (taxi): taxiway P doesn't lead to a ramp entrance for T1 in the direction of travel
5:37 › EVA5194 taxi ramp via N hs Q          (accepted; reached the T1 ramp entrance NA at 7:07)
```

**B. DLH4707, arrival off 31L at MB, to T1** (2 turn questions)
```
14:59 › DLH4707 taxi ramp via B N, contact ramp
14:59 DLH4707 unable (taxi): which way on B? Give the turn, L:B or R:B
15:09 › DLH4707 taxi ramp via L:B N, contact ramp      (accepted)
16:32 › DLH4707 taxi ramp via L A N                    (a new route, while taxiing)
16:32 DLH4707 unable (taxi): which way on A? Give the turn, L:A or R:A
16:32 › DLH4707 taxi ramp via L L:A N                  (accepted; T1 ramp entrance NA at 19:38)
```
Each question was answered by adding a turn, so this one worked as designed. The re-route at
16:32 was Q's: "I had accidentally sent DLH4707 the long way around". Not a router problem.

**C. WJA7466, arrival off 31R at WW, to T4** (4 failures)
```
17:39 › WJA7466 taxi ramp via L:B G, contact ramp
17:39 WJA7466 unable (taxi): taxiway G doesn't lead to a ramp entrance for T4 in the direction of travel
18:01 › WJA7466 taxi ramp via L:B R:G, contact ramp
18:01 WJA7466 unable (taxi): taxiway G doesn't go right from n4058789613
18:11 › WJA7466 taxi ramp via L:B HB, contact ramp
18:11 WJA7466 unable (taxi): taxiway HB doesn't lead to a ramp entrance for T4 in the direction of travel
18:38 › WJA7466 taxi ramp via L:B kF, contact ramp
18:38 WJA7466 unable (taxi): taxiway KF doesn't lead to a ramp entrance for T4 in the direction of travel
18:51 › WJA7466 taxi ramp via L:B KG, contact ramp     (accepted; the log ends before it arrives)
```

**D. AMX4220, arrival off 31L at MC, to T4 (KG)** (6 failures, none accepted in the paste)
```
26:22 › AMX4220 taxi ramp via B LA A KG, contact ramp
26:22 AMX4220 unable (taxi): which way on B? Give the turn, L:B or R:B
26:22 › AMX4220 taxi ramp via P B LA A KG, contact ramp
26:22 AMX4220 unable (taxi): which way on B? Give the turn, L:B or R:B
26:22 › AMX4220 taxi ramp via P R:B LA A KG, contact ramp
26:22 AMX4220 unable (taxi): taxiway B doesn't go right from n45349123
26:22 › AMX4220 taxi ramp via N Q A KG, contact ramp
26:22 AMX4220 unable (taxi): which way on A? Give the turn, L:A or R:A
26:22 › AMX4220 taxi ramp via N Q R:A KG, contact ramp
26:22 AMX4220 unable (taxi): taxiway A doesn't go right from n1743999301
26:22 › AMX4220 taxi ramp via N Q MB B LA A KG, contact ramp
26:22 AMX4220 unable (taxi): which way on A? Give the turn, L:A or R:A
```
Q's accepted route, after: `AMX4220 taxi ramp via N Q MB B LA R:A KG, contact ramp`. It goes
round both junctions of F3: MB to B, and R:A where LA meets A, not where Q does.

**E. ICE6492, arrival off 31R (no exit named in its call), to T7** (15 failures)
```
36:51 ICE6492 clear of 31R
37:06 › ICE6492 taxi ramp via R:C W R:A A1, contact ramp
37:06 ICE6492 unable (taxi): already on taxiway C, so it can't turn right onto it
37:06 › ICE6492 taxi ramp via C W R:A A1, contact ramp
37:06 ICE6492 unable (taxi): taxiway C doesn't reach W in the direction of travel (they meet only at n46568719)
37:06 › ICE6492 taxi ramp via W R:A A1, contact ramp
37:06 ICE6492 unable (taxi): taxiway C doesn't reach W in the direction of travel (they meet only at n46568719)
37:06 › ICE6492 taxi ramp via C1 U1 U A A1, contact ramp
37:06 ICE6492 unable (taxi): which way on U? Give the turn, L:U or R:U
37:06 › ICE6492 taxi ramp via C1 U1 L:U A A1, contact ramp
37:06 ICE6492 unable (taxi): which way on U? Give the turn, L:U or R:U
37:06 › ICE6492 taxi ramp via U A A1, contact ramp
37:06 ICE6492 unable (taxi): taxiways C and U don't meet
37:06 › ICE6492 taxi ramp via C1 U A A1, contact ramp
37:06 ICE6492 unable (taxi): taxiways C1 and U don't meet
37:06 › ICE6492 taxi ramp via C1 U1 A A1, contact ramp
37:06 ICE6492 unable (taxi): taxiways U1 and A don't meet
37:06 › ICE6492 taxi ramp via C1 U1 U A A1, contact ramp
37:06 ICE6492 unable (taxi): which way on U? Give the turn, L:U or R:U
37:06 › ICE6492 taxi ramp via C1 U1 R:U A A1, contact ramp
37:06 ICE6492 unable (taxi): taxiway U doesn't go right from n45294136
37:06 › ICE6492 taxi ramp via C1 U1 L:U A A1, contact ramp
37:06 ICE6492 unable (taxi): which way on U? Give the turn, L:U or R:U
37:06 › ICE6492 taxi ramp via C1 U1 L:U A1, contact ramp
37:06 ICE6492 unable (taxi): taxiways U and A1 don't meet
37:06 › ICE6492 taxi ramp via C1 U1 L:U, contact ramp
37:06 ICE6492 unable (taxi): taxiway U doesn't lead to a ramp entrance for T7 in the direction of travel
37:06 › ICE6492 taxi ramp via C1 U1 L:U L:A, contact ramp
37:06 ICE6492 unable (taxi): which way on U? Give the turn, L:U or R:U
37:06 › ICE6492 taxi ramp via C1 U1 L:U L:B VA R:A A1, contact ramp
37:06 ICE6492 unable (taxi): taxiway B doesn't go left from n9328929610
37:06 › ICE6492 taxi ramp via C1 U1 L:U R:B TB L:A A1, contact ramp   (no unable after it in the paste)
```

**Not a route, but the same kind of message:**
`11:35 ANA9089 unable (hold-short): too close to stop short of J at n10709945044`.

## FACTS (verified)

The app loads `KJFK.json` merged with `KJFK.overrides.json` (`src/web/map/airports.ts`); every
lookup below uses the merged airport. (My first lookup used the base file alone, which has no
ramp entrances and no taxiway names on these nodes. Wrong source, discarded.)

F1. **The nodes in the messages** (merged KJFK; bearings node to node, not the drawn lines):
- `n45349123` (−790, −337): P (to bearing 301), MB (183 and 4), B (120 and 333). The P/B/MB junction.
- `n1743999301` (−784, −239): Q (303), MB (183), A (360 and 121). The Q/MB/A junction.
- `n4058789613` (1107, −251): B (30 and 211) and one unnamed edge (183). G is not at this node.
- `n10709945044` (1382, −1123): Z (196 and 0) and one unnamed edge (62).

F2. **T1 and T4's ramp entrances** (`rampHandoffs`, merged):
- T1: NA (both ways), MA (both), M (arrivals only).
- T4: KG (arrivals only), A10 (arrivals only), and KF, HB, G (**departures only**).

F3. **AMX4220's junctions can't be resolved by any turn** (`resolveRoute` on the merged airport,
arriving at the node along the edge named, terminal T4; scratch `turns-q.ts`):

| Start | Route | Result |
|---|---|---|
| n45349123, along P | `via B LA A KG` | ambiguous at n45349123 on B, 2 ways |
| | `via L:B LA A KG` | **ambiguous** at n45349123 on B, 2 ways |
| | `via R:B LA A KG` | unable: B doesn't go right from n45349123 |
| n1743999301, along Q | `via A KG` | ambiguous at n1743999301 on A, 2 ways |
| | `via L:A KG` | **ambiguous** at n1743999301 on A, 2 ways |
| | `via R:A KG` | unable: A doesn't go right from n1743999301 |

Both ways along B (and along A) count as "left", so L: matches both, R: matches neither, and
no route through those junctions can be written. This is a start at the junction itself, not
AMX4220's actual position, which wasn't recorded; Q's messages name these same two nodes.

F4. **Why both count as left** (`src/sim/route.ts`): `turnSide` calls any direct edge left or
right once it's more than 1e-6° off dead straight (line 569); there's no "straight on". By the
node bearings, one way along B is about 1° left of P's heading (straight on) and the other
about 148° left (a sharp turn back); along A from Q, about 2° and 123° left. `turnAngle`
measures the drawn lines' last and first stretches, so the real angles differ a little.

F6. **ICE6492: a fork in U onto A can't be resolved** (`resolveRoute`, merged airport; scratch
`ice-q2.ts`). Start: the C1/U1 node `n45293435` (on 31R), arriving along C1 from the north,
terminal T7. ICE6492's real position wasn't recorded (it was on C), so this is a stand-in.
- U runs from U1 (at `n45294136`, a node with only U1 and U: one way on) to `n9328929569`,
  where it forks into two branches, both ending on A: at `n1743805056` and at `n1743805057`.
  A1 starts on A at `n4058675842`, 24 m east of `n1743805056`.

| Route (from the C1/U1 node) | Result |
|---|---|
| `via U1 U A A1`, `via U1 L:U A A1` | ambiguous at n9328929569 (the fork) on U, 2 ways |
| `via U1 L:U L:A A1`, `L:U R:A A1`, `U L:A A1`, `U R:A A1` | **ambiguous**, the same |
| `via U1 R:U A A1` | unable: U doesn't go right from n45294136 (correct: it goes left only) |
| `via U1 L:U L:B VA R:A A1` | unable: B doesn't go left from n9328929610 |
| `via U1 L:U R:B TB L:A A1` | resolved (Q's last command) |

  So `U A A1`, the natural route, can't be given at all: a turn onto U is about U's start, and
  a turn onto A doesn't settle the fork. Why the turn onto A doesn't prune a branch is not yet
  known (both branches may count as the same side onto A, as in F4, or the fork may be decided
  before the turn onto A is looked at).

F7. **ICE6492's "don't meet" answers are right by the data** (merged; shared nodes and the
closest node pair): C and U, closest 173 m; C1 and U, 100 m (U1 joins them); U1 and A, 613 m; U
and A1, 24 m (U meets A, and A1 begins on A 24 m on). Not a layout bug by these numbers; whether
the map makes any of them look joined is not checked.

F8. **T7's ramp entrances** (merged): VV, VA (two nodes), A1, W (two nodes), all both ways.

F5. **Node IDs reach the player** from at least `src/sim/route.ts:369` (`doesn't go <turn> from
<node>`) and `src/sim/apply.ts:344` (`too close to stop short of <target> at <node>`).

## THEORIES (unverified unless marked)

1. **[Confirmed for D] No "straight on" in turn sides.** Where a taxiway carries straight on
   through a junction and also branches back the same side, both directions get the same side
   and nothing can disambiguate. A tolerance (e.g. under some degrees counts as straight, so a
   turn picks the other) would fix D. To check: how many KJFK junctions have both ways along a
   taxiway on the same side (a sweep over every node and arrival edge).
2. **Departures-only ramp entrances aren't visible to the player** (C). G, HB and KF are T4
   entrances, but for departures only (F2), so "doesn't lead to a ramp entrance for T4" is
   right but reads as wrong. Does the map show entrance names, and which way they work? Not
   checked. The message could name the entrances that serve arrivals there (KG, A10).
3. **"In the direction of travel" hides the cause** (A). P may reach a T1 entrance (NA, MA or
   M) only the other way, or not at all, or only through one that's departures-only. Not
   checked: resolve `via P` from EVA5194's exit at MC, and both directions.
4. **`R:G` at a node without G** (C, 18:01): G is reached from B through the unnamed edge at
   n4058789613 (F1), so the side is measured over the connector (`waySide`). Whether R:G
   should have matched is not checked; L:G would still have failed on theory 2.
5. **The "which way" question doesn't say where** (B, D). The event carries the node, but the
   log line only names the taxiway, so the player can't tell which junction is asked about.
6. **Node IDs in messages** (F5): unactionable for a player. Name the junction by its
   taxiways ("at B/MB") instead.
7. **Map layout:** a taxiway label that's far from a junction, or two taxiways drawn as
   meeting where the graph doesn't join them, would lead to routes the router refuses. No
   evidence for it yet: every failure above has a router-side explanation, and E's four
   "don't meet" answers match the data (F7).
8. **[Confirmed for E] A taxiway that forks into two same-named branches (a Y onto another
   taxiway) can't be resolved** (F6). No syntax picks a branch partway along an item, and a
   turn onto the next taxiway doesn't either. To check: why the turn onto A doesn't prune one
   branch, and how many KJFK taxiways fork like U (a node with 3+ edges of the same name).
9. **"Clear of 31R" with no exit name** (E, 36:51): the other calls name the exit ("clear of
   31L at MC"). Not checked: which exit ICE6492 took, and whether it has no name in the data.

## Q's answers (2026-11-16)

- B: "I had accidentally sent DLH4707 the long way around, so I tried to get it going the
  right direction."
- D: accepted with `AMX4220 taxi ramp via N Q MB B LA R:A KG, contact ramp`.
- D and E are later in the same seed-5 session as the 1.13 run.

## Seed 666 (Q's second run, 2026-11-16)

Q: "there's also a lot of problems with some of the northern taxiways. is this going to be
addressed by the current plan?" The same run as `ramp-stuck-arrivals-seed666.md`, KJFK seed 666,
24:19–30:03. **Q's app was running older code than the working tree**: its messages name node
IDs, and the same commands replayed on the working tree name junctions. So each retry below was
replayed headlessly on the working tree (1.13b in progress, uncommitted): seed 666, every `›`
command from both of Q's pastes (from 3:47) at its sim time, through the session API. The
replay drifts a little from Q's run (AAL3885's route earlier), but each aircraft below was at
the same place when its commands came.

**G. JBU639, arrival off 31L at MB, to T5** (6 failures, then A4)
```
24:19 › JBU639 taxi ramp via R:B G      unable: G doesn't lead to a ramp entrance for T5 ...
24:19 › JBU639 taxi ramp via R:B Z      unable: taxiways B and Z don't meet
24:19 › JBU639 taxi ramp via R:B F      unable: F doesn't lead to a ramp entrance for T5 ...
24:19 › JBU639 taxi ramp via R:B DA     unable: DA doesn't lead to a ramp entrance for T5 ...
24:19 › JBU639 taxi ramp via R:B D      unable: D doesn't lead to a ramp entrance for T5 ...
24:19 › JBU639 taxi ramp via R:B A4     (accepted)
```

**H. Departures checking in onto A** (ANA5021 on W; VIR9890, EIN5508, UAE9403, ASA7780)
```
24:55 › ANA5021 taxi 31l via a f z      unable: taxiway A can't be reached from n9328526607
24:55 › ANA5021 taxi 31l via w a f z    unable: which way on A? Give the turn, L:A or R:A
24:55 › ANA5021 taxi 31l via w r:a f z  (accepted)
26:18 › ASA7780 taxi 31l via a f z      unable: which way on A? ...
```

**I. EIN3398, arrival off 31R at C5, to T7** (13 failures)
```
30:03 › EIN3398 taxi ramp via c3 u3 u l:a a1         unable: C3 and U3 don't meet
30:03 › EIN3398 taxi ramp via c1 u1 u l:a a1         unable: which way on U?
30:03 › EIN3398 taxi ramp via c1 u1 l:u l:a a1       unable: which way on U?
30:03 › EIN3398 taxi ramp via c1 u1 r:u l:a a1       unable: U doesn't go right from n45294136
   ... 9 more: L:U1/R:U1, "U is named twice in a row", "C and U1 don't meet", "V and U don't
   meet", "C3 doesn't go right", "C3 doesn't reach C2 / C in the direction of travel"
```
The paste ends there, with nothing accepted.

### FACTS (verified in the replay, working tree)

F9. **Already fixed in the working tree** (the same commands, the same places):
- EIN3398 `taxi ramp via c1 u1 u l:a a1`: **accepted**. U's fork onto A (F6, theory 8) is
  settled by the turn onto A, as 1.13b intends. EIN3398's later failures were Q looking for a
  way round it, so they don't arise.
- ANA5021 `taxi 31l via w a f z`: **accepted**, with no turn (1.13b's straight on).
- JBU639 `via R:B DA` and `via R:B D`: **accepted**, to rhDA and rhD. Both are still
  `use: departures` in the data. The working tree's router takes arrivals at any entrance
  serving the terminal, whatever its `use` (the `route.ts` diff: "they all need to be
  accessible by all"). In Q's build they were refused for that reason.
- No node IDs: e.g. "taxiway A can't be reached from W near A", "which way on A at A/TA?",
  "U doesn't go right from U/U1".

F10. **Still failing in the working tree: JBU639 to the T5 entrance F.**
- T5's entrances: DA, D (departures), A4 (arrivals), F (both). F's entrance `rhF`
  (`n5969626406`, at (1192, 172)) is F's west end, where it meets ramp lanes OUTER, HEAVY and
  INNER.
- F runs west to east: rhF, A/F (1251, 159), "F near B" (`n9328972991`), B/F (`n45298966`,
  (1335, 138)), "F near B" (`n4058789617`), F/Z, runway 4L/22R, F/FA, F/Y, runway 4R/22L.
- At B/F the two cross square: B at bearings 17 and 210, F at 284 (west, to A and rhF) and 104
  (east). Unnamed fillets join B and F on either side of the crossing (`n9328972991` and
  `n4058789617` each have two unnamed taxiway edges).
- From JBU639's place at 24:19 (on MB, stopped):

| Route | Result |
|---|---|
| `via R:B F` | unable: F doesn't lead to a ramp entrance for T5 in the direction of travel |
| `via R:B L:F` | unable: the same |
| `via R:B R:F` | unable: taxiway F doesn't go right from **B near F** |
| `via R:B F A` | unable: F doesn't reach A in the direction of travel (they meet only at A/F and through unnamed connectors from F near B) |

  So the turn onto F is judged at a node named "B near F", not at B/F, and no route from B onto
  F reaches A or rhF.

F11. **The turn onto A at a check-in** (H): A is a ring, so both ways along it are real routes,
and the question is right. Q: "the L:A R:A is a little annoying, but i understand why it's a
problem...they're both ring roads, so either is technically a possible route." Not a bug.

### THEORIES (seed 666)

10. **A fillet before the real crossing is taken as the junction with F** (F10). The router
    "turns at the first junction and never skips one", and an unnamed connector between two
    named taxiways counts as the turn between them (STATUS, 1.5's connector rule). If the first
    place along B where F can be reached is a fillet that only joins F eastbound, the B/F
    crossing behind it is never tried. STATUS records the same shape at LGA (`taxi 13 via #1
    R:B P`). Not yet checked: which way JBU639 travels on B there, which node "B near F" is,
    and whether `R:B F` works arriving at B/F from the other side.
11. **"B near F" names more than one node.** Two different nodes along F are both "F near B";
    a message naming one doesn't say which. 1.13b's junction names may need a tiebreak.
12. **"Doesn't lead to a ramp entrance" still doesn't say which do** (G: G, F, DA, D before
    A4). Theory 2 above, and STATUS's open friction item 2. 1.13b doesn't cover it.
13. **EIN3398's C3 answers** ("C3 doesn't reach C2 / C in the direction of travel", though they
    meet) are probably right for an aircraft on C past C3: C3's other junctions are behind it.
    Not checked, and moot now that the route Q wanted is accepted (F9).
14. **The "don't meet" answers** (C3/U3, B/Z, C/U1, V/U): not checked against the data here;
    in seed 5 all of them matched it (F7).

## Resolution of seed 5's findings (PLAN 1.13b, 2026-11-16)

The seed-666 section above was written by another session against the working tree during
1.13b; its theories 10–14 are not covered here and stay open.

- **Theory 1, straight on (F3, F4): fixed.** `STRAIGHT_ON_DEG` 10 in `route.ts`: a direct turn
  within 10° of straight is neither left nor right, and with no turn given a straight-on way
  that completes the route is taken. AMX4220's junctions route (`route-kjfk.test.ts`). The KJFK
  sweep test finds 7 same-pick junctions with the old rule and 0 now, except 3 connector-only
  nodes on unnamed edges (G, C6, DB) that Q chose to leave (they're named in the test).
- **Theory 8, same-name forks (F6): fixed.** After a fork, the turn onto the next item takes its
  side from the heading at the fork, and a direct turn sharper than CONNECTOR_MAX_TURN_DEG at the
  branch's end is no way on (the branch built for the other direction). Still ambiguous, it asks
  about the next item. ICE6492's `U1 L:U L:A A1` takes the east branch, `R:A` the west. The fork
  sweep test: 9 clashes over 7 forks without the rule, 0 with it.
- **Theories 5 and 6, node ids in messages (F5): fixed.** `junctionName` (`graph.ts`) names a node
  by the taxiways at it ("B/MB/P"), or the nearest junction ("U near A"); every route and apply
  message uses it, and "which way on X at B/MB/P?" says where. A test over KJFK route reasons
  finds no node, edge or hold-short id in any.
- **Theory 2, departure-marked entrances (C): changed by Q's rule.** Every ramp entrance takes
  arrivals and departures, the ones marked for each first: a taxi to the ramp uses an
  arrival-marked entrance when one completes the route, any other only when none does; the ramp's
  departures leave by departure-marked exits, any other only with no way out by those. WJA7466's
  `taxi ramp via G` now resolves to G.
- **ANA8115 "left backwards on VA": explained and gone.** Pushback could run out past a ramp edge
  onto the taxiway (T7 g1011144695's only plan for a B789 went out past VA). No pushback touches a
  taxiway now; stands that needed one got ramp-lane stubs (docs/airports/KJFK-notes.md).
- **Theory 3 (EVA5194, `via P` for T1) and theory 7 (map layout):** not pursued; no evidence of a
  layout problem turned up.

## Resolution of seed 666's findings (PLAN 1.13c, 2026-11-17)

- **Theory 10 (F10, JBU639 to F): not a router bug.** Replayed on the committed code: from the
  south along MB at B/MB/P, `R:B F` and `R:B L:F` reach F, as they did before 1.13b. The replay's
  results (`R:B R:F`: "doesn't go right from B near F") match only arriving along MB from the
  north, where right onto B is west, away from F; there `L:B F` works. So JBU639 was heading
  south. The identical names hid it (theory 11).
- **Theory 11, fixed:** a node on one taxiway is named by its compass side of the nearest
  junction: "F west of B", "F east of B" (`junctionName`).
- **Theory 12, fixed:** a route that misses every entrance for its terminal lists them: "(T5's
  ramp entrances: A4, D, DA, F)".
- **Theory 14:** B/Z (108 m apart), C/U1 (105 m) and V/U (56 m) don't meet, as said. C3 and U3
  meet runway 13L/31R at two nodes 7 m apart: right by the route rule (a runway is crossed at a
  node, never travelled along), but a data question for Q (STATUS).
- **Seed 5's theory 3 (EVA5194, `via P` for T1):** right: none of T1's entrances (NA, MA, M) is on
  P; `via P B` reaches MA. The reason now lists them.
