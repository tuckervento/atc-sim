# KLGA: import notes (PLAN 1.6, a format check)

_Written 2026-11-15. Sources, choices and dates for `data/airports/KLGA.json` (generated) and
`data/airports/KLGA.overrides.json` (hand-curated). LGA is not playable; it checks that the
format and importer aren't JFK-shaped. Q chose the agent's sourced picks for the hand-curated
parts (STATUS, cycle 7). Doubtful picks are the questions at the end._

## Commands

```
npm run import-airport -- KLGA            # offline: raw file (+ the overrides' check-in points and terminal buildings) → data/airports/KLGA.json
npm run render-airport -- KLGA            # → dist/maps/KLGA.html
npm run validate-airport -- KLGA
npx vitest run src/airport/klga.test.ts
```

## Sources

| What | Source | Date |
|---|---|---|
| Geometry, names, holds, stands, buildings | OpenStreetMap via Overpass, research doc Query A for KLGA (`tools/airport-import/overpass.ts`), User-Agent `atc-sim/0.1 (personal research)`. One request. | fetched 2026-11-15T20:52:01Z; OSM base 2026-11-15T20:50:51Z |
| Raw response | `data/airports/raw/KLGA.overpass.json`: the Overpass body byte for byte plus the `atcSimFetch` record. 403,220 bytes. 604 elements, the same count as research §1.2 | same |
| Tower 118.7 (one position), GND 121.7, runway lengths 7,002 ft, "Twy F lctd btn Twy BB and Twy Y clsd indef" | FAA Chart Supplement NE, 29 OCT–24 DEC 2026, p. 226 (https://aeronav.faa.gov/afd/29oct2026/ne_226_29OCT2026.pdf) | fetched 2026-11-15 |
| Names, HS 1 / HS 2, the three ILS hold lines, "Terminal A/B/C" labels, the Rwy 4 / ILS hold note, lane label positions | FAA airport diagram AL-289, cycle 2611 (https://aeronav.faa.gov/d-tpp/2611/00289ad.pdf) | fetched 2026-11-15 |
| Default configuration: arrivals 22, departures 13 | FAA, "LGA LaGuardia (New York)" Airport Capacity Profile, 2014 (https://www.faa.gov/sites/faa.gov/files/airports/planning_capacity/profiles/LGA-Airport-Capacity-Profile-2014.pdf), pp. 3–5: the profiled configuration in visual, marginal and instrument conditions, from ASPM FY2009–2010. Also: "LGA does not have a dominant airport configuration"; this one is used about 11% of visual hours | fetched 2026-11-15 |
| Terminals and airlines | laguardiaairport.com (Official, Port Authority): `/flights/airlines` (Air Canada B, American B, Delta C, Frontier B, JetBlue B, Porter B, Southwest B, United B) and `/explore-lga/terminals` ("Terminal A at LaGuardia, historically known as the Marine Air Terminal, serves Modern Aviation"; B and C as above) | fetched 2026-11-15 |

## How OSM maps to the format

Same importer and rules as KJFK (`docs/airports/KJFK-notes.md`), plus the changes below.
Import report: 462 nodes, 591 edges, 2 runways, 64 hold-shorts (runway 44, ILS 4,
intermediate 16), 55 gates in the base (TA 6, TB 21, TC 28), 21 areas. LGA has no
`holding_position:type=movement` marks, so the ramp boundary comes entirely from the check-in
points below. Runway centerlines measure 7,000 ft (4/22) and 7,003 ft (13/31) against the
Chart Supplement's 7,002 ft.

### Importer changes for LGA (generic rules; why each was a JFK-only assumption)

1. **A hold where a taxiway enters at a runway intersection protects both runways**
   (`holds.ts` step 4). A runway hold also protects every other runway whose centerline is
   nearer to the node where the hold's way enters its runway than the hold stands from that
   runway's centerline. Past the line, the aircraft is already inside the other runway's
   hold-line distance. The old step 3 walked only non-runway edges, so it never saw a runway
   that a taxiway enters at the crossing. At LGA, AA's hold `h3061622399` (74 m from 13/31)
   leads onto 13/31 at `n45244280`, 32 m from 4/22's centerline, inside HS 1. It now protects
   `["13/31", "4/22"]`.
   **This also changed one KJFK hold** (the only KJFK change; `KJFK.json` line 2409):
   `h5969626557` on K4 now protects `["13R/31L", "4L/22R"]`, not just 4L/22R. K4 enters 4L/22R at
   `n5326590520`, 75.6 m from 13R/31L's centerline. JFK's own LAHSO markings for 13R/31L on
   4L/22R stand 85–87 m from it (`h8025526865`, `h8025529439`), so the K4 entry lies inside
   them: an aircraft cleared onto 4L/22R there is inside 31L's hold line. This is JFK's HS 1
   ("Twy K and Twy J complex in close proximity to Rwy 04L and Rwy 31L"). KJFK still validates
   with its 3 known warnings, and `kjfk.test.ts`'s check that every runway hold faces each of
   its runways from 60–160 m passes for this hold (122 m from 13R/31L).
2. **Runway holds on a runway's own centerline are imported** (they were dropped as mistakes).
   OSM maps four `holding_position:type=runway` nodes on the centerlines, 75–102 m either side of
   the crossing: `h9311536458`/`459` on 4/22 and `h9311536460`/`461` on 13/31. They are runway
   holding position markings on runways (AIM 2-3-5: used for LAHSO and for taxiing on a runway).
   Each is imported like a LAHSO hold, but with kind `runway`: on its runway, facing along it to
   the crossing node, and protecting the crossing runway. JFK had no runway hold on a centerline
   (its one near-runway hold, 8025526864, is 2 m off and not on the graph), so nothing changed
   there. Taxi routes never use runway edges, so these holds affect no ground route.
3. **A runway hold at a fork guards every branch** (`holds.ts` step 5). The old rule gave each
   OSM hold one `towardEdge`. At LGA, two holds sit exactly where an unnamed fillet leaves D
   toward 4/22, so the second branch was unprotected (`runway-entry-unprotected`). Now every
   other branch with a clear way to the runway, at most 1.5× the best branch's length (so never
   the way back), gets its own hold-short, `<id>.2`: `h46537587.2` (fillet, 108 m against D's
   84 m) and `h3060033678.2` (west side, 88 m against 87 m). No KJFK hold is at such a fork.
4. **A terminal can be several buildings** (`convert.ts`, `import-options.ts`). JFK's rule was
   that a terminal's buildings are named "Terminal X". LGA's Terminal B is the headhouse
   "Terminal B" plus the "Eastern Concourse" and "Western Concourse" (and two "Terminal B …
   Pedestrian Bridge" buildings). The overrides file now assigns buildings to a terminal
   (`areas.patch` items that set `terminal`), and the importer reads those like the check-in
   points: those buildings count as the terminal's for gate matching. Result: TB went from 0 to
   21 gates. It fails loudly if an assigned id isn't an `aeroway=terminal` polygon, or the
   terminal doesn't exist. KJFK's `areas.patch` sets no `terminal`, so KJFK is unchanged.
5. **render-airport uses the same import options**, so its "stand that is not a gate" overlay
   matches the base file. Before, it re-ran the convert step without the overrides' check-in
   points (or terminal buildings), so the overlay disagreed with the data.

**Not changed, checked:** numeric names (strings throughout); the ILS rule (all four OSM ILS
nodes protect 4/22, on R near the 22 end and on B, AA and AC near the 4 end, matching the
chart's three ILS HOLD lines, one of which spans AA and AC); `GATE_TERMINAL_M` = 150 m (every
stand left out at LGA is GA/transient parking 570–700 m from any terminal, or has no ref).
**The format** (`src/airport/types.ts`, `load.ts`, `validate.ts`) **is unchanged**.

## What the overrides file sets, and why

| Item | Value | Source / reason |
|---|---|---|
| Terminals | TB `[ACA, AAL, FFT, JBU, POE, SWA, UAL]`, TC `[DAL]` | laguardiaairport.com. IATA→ICAO is mine (Air Canada ACA, American AAL, Frontier FFT, JetBlue JBU, Porter POE, Southwest SWA, United UAL, Delta DAL), not fetched |
| Terminal A (= the Marine Air Terminal) removed, with its 6 base gates (1–6) and its building's terminal link | `terminals.remove`, `gates.remove`, `areas.patch` | laguardiaairport.com: Terminal A "serves Modern Aviation" (private aviation) and no airline lists it. So it isn't in today's airline operation. Its stands' lead-ins become unnamed ground taxiways, like JFK's GA aprons |
| TB buildings: Eastern Concourse `w633420347`, Western Concourse `w677731265`, the two Terminal B pedestrian bridges `w664461080`, `w701356157` | `areas.patch` (`terminal: "TB"`), read by the importer | OSM names. The bridges join the concourses to the "Terminal B" headhouse |
| 15 ramp check-in points, named by their lane: 5 (×2), 6, 7, 8, 9 (×2), 11, 12, 15, 16, 17, 18, 19 (×2), all `use: both` | `rampHandoffs.add` | My pick (below). The format doc's own example of a check-in name is "7" |
| One tower position, 118.7, owning both runways | `towerPositions.add`, `runways.patch` | Chart Supplement: TOWER 118.7 |
| Configuration `22-13` "Land 22, depart 13", the default | `configurations.add`, `set.defaultConfiguration` | FAA Capacity Profile 2014 |
| 22 arrival exits E, C, Y, B (in landing order) | `runwayExits.add` | My pick from the geometry (below) |
| 13 departure line `line13` on P, exits BB then G | `departureLines.add` | My pick from the geometry (below) |
| Stray 5 m taxilane (OSM way 1355496893, 2 nodes, touches nothing) removed | `edges.remove`, `nodes.remove` | research §1.3's "stray component"; it caused `disconnected-network` |

### The ramp boundary (my pick)

Charted lanes at LGA are numbered (AL-289: 1, 2, 3, 5–9, 11, 12, 14–19). In OSM, gate lead-ins
hang directly off lanes **5, 6, 7, 8, 9** (TB; 9 also serves TC 61–69) and **11, 12, 15, 17,
18** (TC). **1, 2 and 3** carry no gates: they're a through network between B/D, A and alley 9,
west of the Western Concourse. 16 and 19 are inside Terminal C's east ramp.

- The check-in points are at the mouths of the gate alleys, one node inside the movement area's
  taxiway. Alleys 8, 9, 11 and 12 leave A by two stubs that merge (a Y), and 6 and 7 cross in an
  X just off A, so the point is the Y/X node, or the first lane node in from A. Putting them on A
  itself would cut the A segments between two mouths off from the movement area. So the short
  stubs from A to each check-in point (3–58 m) stay ground's `taxiway`, named for the lane, the
  same "movement-area stub" pattern as JFK's A1, W and VA.
- Terminal C's east ramp has several unnamed entries from A and Z, so its points are the heads
  of 15 (`n46532700`), 16 (`n12463874436`), 17 (`n12463874457`), 18 (`n9711578204`) and 19 (two,
  on Z).
- So **lanes 1, 2 and 3 are ground's taxiways** (they can be named in a route: `taxi 13 via #1
  #3 A G P` resolves, tested). The alleys are ramp lanes.
- `use: both` everywhere: I found no source for one-way ramp flows at LGA.
- Terminals: 5–8 → TB; 9 → TB and TC; 11–19 → TC (by the gates behind each).

### Runway exits for 22 (my pick)

Landing 22 rolls south-west, so the terminal side is on the left. Exits off 4/22 to the left,
pointing forward along the roll, by distance from the 22 end: **E** (1,110 m, a 15° turn),
**C** (1,420 m, 10°), **Y** (1,859 m, 19°), **B** (2,119 m, the end, 90°). Left out: P and G
(753–825 m, inside HS 1, the intersection hot spot), Q (HS 2 is "exiting Rwy 04 at Twy Q",
and it points backward for 22), D (115°, backward), and the unnamed fillets. No published source
gives LGA's usual 22 exits.

### The 13 departure line (my pick)

P meets 13/31 30 m from the 13 threshold, behind the runway hold `h9311536450`; that's the
front. The line runs back along P (south-east) to the AA junction `n45244275`, just inside P's
4/22 hold lines: 6 edges, 243 m, room for about 4–5 aircraft. Exits, back to front: **BB** at
`n45251341`, **G** at `n45195586` (G parallels P to the 13 end). AA isn't an exit: one AA branch
leads to the intersection (onto the runways). Departures from the terminals reach it across 4/22
on G or P. No published source gives where LGA's 13 queue forms.

### Not modelled

- **Lane 14** (the one charted name missing from OSM). I located the chart's "14" label by an
  affine fit from the chart's own lane labels (18 labels; residuals 0–6 m) to the OSM lanes: it
  falls at local (664, −424), between lanes 12 and 15 at Terminal C, by the pier with stands
  70–79. No pavement edge in OSM lies there. The nearest are three gate lead-ins, 34–66 m away.
  The label's text runs parallel to lanes 12 and 15–18. Adding lane 14 would mean inventing its
  geometry from a chart that states ±600 ft accuracy, so it's a question for Q, not data.
- **Twy F closure** "btn Twy BB and Twy Y, clsd indef" (Chart Supplement). OSM's F meets BB at
  `n45247817` and runs on west to D, but never meets Y, so I can't tell which OSM edges the
  closure covers. Not modelled; a question.
- **Pads and a penalty box**: no source for LGA. The validator's `no-holding-pad` and
  `no-penalty-box` warnings are those two gaps, by design.
- **Stands whose OSM lead-in touches no lane**, so they aren't on the graph: Terminal B's 11,
  12, 12A, 14–20 (with A suffixes), 22, 22A, 23, 24A, 26, 29, 29A, 30A, 31 (Western Concourse
  and its bridge), 40/40A, 41, 42, 46, 48, 48R, 52, 59, 59A (Eastern Concourse and its bridge);
  Terminal C's 75, 77, 80, 81, 83, 84, 85, 87, 89A; remote stands R1–R18. Most end 2–44 m from
  any lane (the alley in front of the Western Concourse isn't mapped). Two (26, 46) end exactly
  on a lane, 0 m, without sharing its node: a generic "join a lead-in that ends on a lane"
  repair would recover them, but it's outside this task (and would need a KJFK re-check). Not
  hand-traced (a format check).
- Taxiway restrictions (wingspan, deck speeds, the 50 ft tail-height bridge): v1 non-goal.

## Validation now

`npm run validate-airport -- KLGA`: **OK, 0 errors, 2 warnings**, `no-holding-pad` and
`no-penalty-box`, both justified above (nothing sourced). TB 21 gates, TC 28; 64 hold-shorts.

## Terse: numeric lanes in a route

`src/sim/terse.ts` reads a bare number as a runway, so `taxi 4 via 14 B` is an error:
"expected taxiway after 'via', got '14' (a bare number is a runway; write a name that starts
with a digit as '#14')". `taxi 4 via #14 B` parses, to taxiways "14" then "B". This is the
documented numeric-name rule (`docs/terse-syntax.md`), checked by running the parser. It isn't
changed here.

## Questions for Q (most important first)

1. **Which LGA lanes does ground control?** I made 1, 2 and 3 ground's (no gates on them) and put
   the check-in points at the mouths of the gate alleys 5–9, 11, 12, 15–19, all `both`. No public
   source I found says where LGA's ramp ends. If ground controls more (e.g. the whole of 9), the
   check-in points move and the base must be re-imported.
2. **Default configuration land 22 / depart 13**: FAA's profiled configuration, but the same
   profile says LGA has no dominant configuration (about 11% of visual hours), and the data is
   FY2009–2010. Keep it, or pick another (e.g. land 31 / depart 4, which would use the chart's
   B / ILS-hold note for Rwy 4 departures)?
3. **The 13 departure line on P** (back to the AA junction, exits BB then G) and the **22 exits
   E, C, Y, B** are mine from the geometry. Are they right?
4. **Terminal A / the Marine Air Terminal**: removed because the Port Authority lists no airline
   there (it "serves Modern Aviation"). Keep it out, or model it with no airlines (it would then
   need its own check-in point)?
5. **Lane 14**: hand-place it (where?) or leave it out?
6. **Twy F closure "btn BB and Y, clsd indef"**: model it (which pavement?) or ignore it, like
   JFK's temporary closures?
7. **The KJFK K4 change** (importer change 1): K4's hold now also protects 13R/31L. Accept?
8. The IATA→ICAO codes for the eight LGA airlines are mine (POE for Porter, FFT for Frontier).
