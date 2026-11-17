# KJFK: import notes (PLAN 1.5)

_Stage a written 2026-11-14; stage b (Q's answers applied) 2026-11-15. Sources, choices and
dates for `data/airports/KJFK.json` (generated) and `data/airports/KJFK.overrides.json`
(hand-curated). Q's answers are in [`KJFK-questions.md`](KJFK-questions.md); what stage b set
for each is in "Q's answers, applied" below._

## Commands

```
npm run import-airport -- KJFK            # offline: raw file (+ the overrides' check-in points) → data/airports/KJFK.json
npm run import-airport -- KJFK --fetch    # one Overpass request first (don't repeat casually)
npm run render-airport -- KJFK            # → dist/maps/KJFK.html (open in Chrome)
npm run validate-airport -- KJFK
npx vitest run src/airport/kjfk.test.ts
```

## Sources

| What | Source | Date |
|---|---|---|
| Geometry, names, holds, stands, buildings | OpenStreetMap via Overpass, research doc Query A verbatim (`tools/airport-import/overpass.ts`), User-Agent `atc-sim/0.1 (personal research)` | fetched 2026-11-14T19:17:20Z; OSM base 2026-11-14T19:15:36Z |
| Raw response | `data/airports/raw/KJFK.overpass.json`: the Overpass body byte for byte, plus one first key `atcSimFetch` (fetch time, endpoint, User-Agent, query). 1,699,310 bytes (1.70 MB) | same |
| Closures, displaced thresholds, tower frequencies, ARP | FAA Chart Supplement NE, 29 OCT–24 DEC 2026, JFK pp. 224–225 (https://aeronav.faa.gov/afd/29oct2026/ne_224_29OCT2026.pdf); closure text as quoted in the research doc §2.4 | fetched 2026-11-14 |
| Name and hold spot checks | FAA airport diagram AL-610, cycle 2611 (https://aeronav.faa.gov/d-tpp/2611/00610ad.pdf), georeferenced from its graticule (meridians 1,011 px/min, parallels 1,328 px/min at 6000 px) and overlaid on the imported graph | fetched 2026-11-14 |
| Airlines per terminal | jfkairport.com: `/explore-jfk/terminals/terminal-5` and `terminal-7` (lists in the page), `/terminal-1/airlines-at-terminal-1`, `/terminal-4/Airlines-in-T4`, `/terminal-8/airlines-at-terminal-8` (Official, Port Authority) | fetched 2026-11-14T19:40–19:41Z |

The Overpass snapshot has exactly the research doc's counts (5,176 elements; every `aeroway`
type identical, §1.2), although its OSM base time is 13 hours later.

## How OSM maps to the format (`tools/airport-import/convert.ts`)

- **Frame.** `reference` = centre of the OSM aerodrome's bounding box (40.6429062,
  −73.7858125), projected with `src/airport/geo.ts`, rounded to 0.1 m. It's about 900 m from
  the FAA ARP (N40°38.40′ W73°46.72′); the frame's origin doesn't matter, and the bbox needs no
  extra input. Changing it would move every coordinate, so it's fixed at import.
- **Graph.** Every `runway`, `taxiway` and `taxilane` way, plus every `parking_position` way
  that touches one (gate lead-ins). Ways are split at shared nodes, way ends and hold
  positions; other vertices become `points`.
- **Ids** come from OSM ids, so overrides survive re-imports or fail loudly: nodes `n<osm>`;
  edges `w<way>-<from>-<to>` (a split change makes the old id vanish rather than move);
  hold-shorts `h<osm node>` or `hl<hold-line way>`; gates `g<way>`; areas `w<way>` / `r<rel>`.
- **Edge kind (stage b: the ramp boundary rule).** The importer reads the check-in points
  curated in the overrides file (`rampHandoffs`, Q7) and floods from the runways over every
  non-runway edge, stopping at those nodes. What it reaches is `taxiway` (ground's movement
  area); what lies behind a check-in point is `rampLane`. OSM's way class is ignored, because at
  JFK many check-in marks sit in the middle of one taxilane (MA, KF, KG, G, NC, S, SA, TA, T).
  Result: 144 named taxilane edges behind the check-in points became `rampLane` (G 21, H 21,
  KF 21, HB 19, NC 16, SA 10, TA 8, MA 7, NB 5, N 4, KG 3, S 3, T 3, D, DA, W), and 38 unnamed
  lanes and lead-ins outside any ramp (cargo and hangar stands, the GA aprons, the de-icing
  stands) became unnamed `taxiway`. Afterwards every ramp-lane/taxiway boundary is a check-in
  point, so `ramp-boundary-undeclared` is gone and every gate is reachable. Changing the
  check-in points means re-importing. (Stage a's first cut, by OSM class, applies only when the
  overrides curate no check-in points.)
- **Names** = `ref`, else `name`. Runway refs lose leading zeros (`04L/22R` → `4L/22R`).
- **Runways.** Grouped by ref; ends matched to designators by the centerline's true bearing.
  Centerline lengths are within 1% of the Chart Supplement (a test checks this).
- **Gates.** A parking lead-in with a `ref` whose stand (the end off the network) is within
  150 m of a terminal building and nearer to it than to any other `aeroway=terminal` polygon.
  Terminal buildings named "Termin… N" become terminal `TN` (so OSM's misspelt "Terminl 8" counts
  as T8). "New Terminal 1" is a plain building, so stands nearest it aren't gates. Repeated
  stand names in a terminal keep the first (lowest OSM id); the rest stay as lead-ins only.
  Result: 161 gates (T1 14, T4 64, T5 33, T7 11, T8 39). 45 stands aren't gates (no ref, too
  far from a terminal, nearest NTO, or a repeat); the map shows them grey.
- **Areas.** Aprons, terminal buildings, "New Terminal 1" and hangars (named from `name`,
  `name:en` or `ref`).
- **Not imported:** 103 parking_position ways that touch no runway, taxiway or taxilane
  (including HS1, HS1A, HS2, HS2A, HS2B near T1/T8, and 78A), stopways/EMAS, helipads, lights.

### Repairs to OSM topology (generic rules, each reported by the importer)

- **Taxiway crossing a runway without a shared node** → joined at the crossing (snapping to an
  existing vertex within 1 m). Two cases: Z at the 31L end (n8025529448, 0.08 m off the
  centerline; the chart has hold bars on Z both sides of the end) and KD (n1743801739, 0.00 m).
- **Taxiway dead-ending within 3 m of a runway centerline** → its end joined to the runway.
  10 cases, 0.2–2.2 m off: C3, U3, H, WW and 6 unnamed ways. No other dead end is within
  40 m of a runway. I believe the runways were redrawn in OSM in 2026 (all five runway ways
  were last edited in 2026, research §1.3) and these taxiway ends were left behind; not verified.
- **Hold lines drawn as short ways across a taxiway** get a node where they cross it, unless
  an OSM hold node sits on that way within 25 m (62 of them duplicate a node). 8 hold-line ways
  cross nothing (10–20 m off DB, GG, H and one unnamed taxiway, all of which have hold nodes);
  left out.

### Hold-short ownership (`tools/airport-import/holds.ts`)

OSM gives the kind (`runway`, `ILS`, `LAHSO`, `intermediate`, `movement`), never the runway.
- **runway / ILS:** protects the runway whose centerline is nearest in a straight line; faces
  the edge with the shortest way to that runway that passes no other runway hold line (else
  the shortest way). A runway hold also protects any further runway reachable through that
  edge before another hold line (none at JFK: the 4L/22R × 13R/31L crossing has hold lines on
  each side). Not imported: holds within 30 m of a centerline (1: h8025526864 on K4, at the
  4L/22R edge; Q15d). **Approach-area holds** (stage b, Q15c): a runway hold more than 50 m past
  a runway's end is imported as a runway hold for that runway, facing where the taxiways cross
  its extended centerline (the edge with the shortest way to that crossing). At JFK: h5607488398
  on FB and h5607488399 on FA, beyond 31R, both facing the FA/FB merge, the way to FB's
  crossing of 31R's extended centerline.
- **Untagged:** imported as `runway` only within 200 m of a centerline (2 imported, on F and
  GG at 84–85 m; 2 left out at 278 and 287 m).
- **LAHSO:** on one runway, facing along it to the nearest crossing runway, which it protects.
- **intermediate:** no runways; faces the nearest junction.
- **movement** (`holding_position:type=movement`, 39 on the graph) are the non-movement-area
  boundary markings. They aren't hold-shorts; the map draws them as black diamonds, as
  candidate ramp check-in points.
- **Checks:**
  - 77 runway holds sit 60–160 m from their runway's centerline, most at 83–98 m.
  - Every runway hold's toward edge leads closer to that centerline.
  - Each of 45 runway/taxiway pairs from the chart has a protecting hold.
  - All three are asserted in `kjfk.test.ts`. A deliberately reversed hold fails the facing check.
- **Spot-checked against the diagram overlay:** the 31L end (Z, JA, JB, J), the HS 1 / K
  complex (K, KD, KE, K4), the 31R/22L corner (FA, FB, E, Y, YA), H at 4R/22L.

## What the overrides file sets, and why (stage b)

Generated items keep OSM ids. Hand-made items start with `x`: nodes `xk…` (Kilo pad), `xz…`
(Zulu pad), `xs…` (hardstand), `xg…` (hangar spots), `xhD13L` (a hold node); their edges
`xk-…`, `xz-…`, `xs-…`, `xg-…`, `xM-…`, `xD13L-…`.

| Item | Value | Source |
|---|---|---|
| Closures | none (stage a's Z and VA closures removed) | Q1, Q11: temporary, ignore |
| Displaced thresholds 4L 140.2, 22R 1043.6, 13L 276.5, 31R 313.0, 13R 623.0, 31L 994.9 m | `displacedThresholdM` | Chart Supplement "Thld dsplcd" 460, 3424, 907, 1027, 2044, 3264 ft. 4R/22L: none |
| Tower 123.9 (4L/22R, 13R/31L), 119.1 (4R/22L, 13L/31R) | `towerPositions`, `runways[].towerPosition` | Chart Supplement / FAA diagram |
| Configuration `31s`: 31L arrivals + departures, 31R arrivals; default; arrival exits below | `configurations`, `set.defaultConfiguration` | Q (2026-11-14), Q8 |
| `h8025529446` (ILS, on Z, the diagram's "CAT 2 HOLD"): protects 4R/22L | `holdShorts.patch` | Q15b: accepted |
| `h5607488397` (OSM ref "31R-APCH", on FB just past the 31R end): kept, faces down FB toward the crossing | `holdShorts.patch` (stage a removed it) | Q15c |
| Runway hold `hxD13L` on D north of 13L/31R, 84.1 m from the centerline like D's south hold h8025529400 (84.3 m); D's edge from C split at node `xhD13L` | `nodes.add`, `edges.remove`/`add`, `holdShorts.add` | Q12 |
| Runway hold `hxFA4R` onto 4R/22L at the FA/FB merge n45358355, facing only the edge onto the runway | `holdShorts.add` | Q12; see "Judgment calls" |
| 24 ramp check-in points (23 of Q's, plus VA's second mark) with name, use, terminal | `rampHandoffs.add` | Q7 |
| Ramp lane `M` from M's check-in (where OSM's M ends) to MA's lane, 164 m | `edges.add` | Q7: "M, arrivals, for gates also served by MA" |
| Stub names NA (A → T1), TT (B → JetBlue hangar); and the 6–11 m pieces from A1, W and VA to their check-in marks named A1, W, VA | `edges.patch` | Q14; a ramp entrance's way in is its named stub |
| 23 remote stands east of T4 as T4 gates: 72, 73 A380, 73A, 73B, 74, 78, 78B, 79, 79A, 79B, H1, H1A, H2–H11, H14 | `gates.add` | Q16 follow-up |
| 31L departure line `line31L`: Y from n45357551 to n45355700, then Z to n4057398125 (Q1's longer queue), then Z to h8025529445 (Q1's line, 3 edges, 563 m); exits H at n4057398125 (west branch), J at n4068921630 (west branch) | `departureLines.add` | Q1, Q2 |
| Kilo pad, Zulu pad, penalty box, South Hardstand | `nodes.add`, `edges.add`, `holdingAreas.add` | Q3–Q5, Q9, follow-ups; below |
| 9 hangars | `nodes.add`, `edges.add`, `hangars.add` | Q10; below |
| 21 arrival exits (31L 8, 31R 13), in Q's order | `runwayExits.add`, `configurations[31s].arrivalExits` | Q8 |
| Area `w284907690` name "Terminl 8" → "Terminal 8" | `areas.patch` | OSM typo |
| Ramp-lane stubs for pushbacks (`x13b-…`): one at T1 off n5763789134 (84 m, 290°) for the four T1 stands off N; at T7, off n9328838876 (g1011144698) and n9328838893 (g1011144701), and off new junctions where the stand lanes of g1011144697 (VV, 4 m in) and g1011144695 (VA, 10 m in) are split | `nodes.add`, `edges.add`, `edges.remove` | Q, PLAN 1.13b: pushback stays inside the ramp; below |
| Terminal airlines | `terminals.patch` | jfkairport.com, below |

### Q's answers, applied

| Q | Answer (follow-up wins) | Set |
|---|---|---|
| Q1 | 31L line: Z from n4057398125 to h8025529445; could extend back along Y and northern Z; Z closure temporary | `line31L`; closure removed. The longer queue is modelled: Q's extension is one path back from n4057398125 (Z north through n46547996 to n45355700, then Y to n45357551 at F), so the line is that full extent, back to front Y, Z. A queue fills from its front hold, so the Y/northern-Z part is used only when it's long ("mostly" the Z part). |
| Q2 | Exits H @ n4057398125, J @ n4068921630 | `line31L.exits` = H, J (each takes the branch away from the 31L end: H west toward Y, J west toward JA/JB's junctions) |
| Q3 | Kilo pad (apron west of K between K1 and K2), Zulu pad (apron by Z at n8025529446), 3–4 each | `kilo`, `zulu`, 3 spots each |
| Q4, follow-up | Penalty box: the Q loop with Q1 by GA, plus the de-icing spots at n14158137952 and similar | `quebec`: Q1 loop nodes n5969625842, n14158137907; de-icing stands H19-1 n14158137951, H19-3 n14158137952, H19-5 n14158137954, and n5969625810 (the similar stand off Q2) |
| Q5, follow-up | "Kilo pad", "Zulu pad", "Quebec box", "penalty box" | `spokenNames` (also the one-word forms Kilo, Zulu, Quebec, for terse) |
| Q6 | No names for the curved connectors; they're the turns | no charted names added; route rule changed (src/sim/route.ts) |
| Q7 | 23 check-in points | `rampHandoffs`, terminals as Q grouped them; ramp boundary moved there (importer) |
| Q8 | 31L: MB, MC, MD, PA, PC, PD, PE, PF; 31R: D, two unnamed, WW, W, unnamed (2,209/2,309 m), V, C5, U3, C3, U2 | `runwayExits` `x31L-*`, `x31R-*`; the unnamed ones have no `taxiway`. D is two edges (1,368 and 1,417 m); "unnamed at 2,209/2,309 m" is two edges; W is its 90° branch |
| Q9, follow-up | South Hardstand: aprons w158041999 and w5786176, via Q5/PB and Q3+Q4, 5–6 spots, ground controls; name not settled | `south`, kind hardstand, 5 spots, entrances PB, Q5, Q3; spoken "South Hardstand", "hardstand" (the default) |
| Q10 | Company hangars, each from its nearest taxiway | 9 hangars, below |
| Q11 | VA closure temporary | removed; VA is a T7 check-in, use both |
| Q12 | Add runway holds on D and FA | `hxD13L`, `hxFA4R` |
| Q13 | Keep all doubtful names; ignore the X glyphs | nothing changed |
| Q14 | NA and TT | `edges.patch` |
| Q15 | (a), (b), (d), (e) as derived; (c) approach holds as runway holds for 13L/31R facing the extended centerline | (c): importer rule plus the h5607488397 patch |
| Q16, follow-up | Remote stands are T4 parking handled by ramp | 23 T4 gates; reached through the T4 check-in points |

### Placing what OSM doesn't have (method)

Computed once by a scratch script from the base geometry, then written into the overrides.
Every added edge was checked: it crosses no existing edge (except at its ends) and no building,
and every pad and hardstand spot lies inside its apron polygon.

- **Kilo pad** (apron w632238147): a lane parallel to K, 45 m west of it, joined to K at the K1
  junction (n45352547) and the K2 junction (n4058549561); three spots 35 m further west, at the
  lane's ends and middle.
- **Zulu pad** (apron w5938321): an entry node on the apron's long axis level with
  n8025529446 (39 m from Z), and three spots spread along the axis (55 m north; 45 and 85 m
  south, 10 m either side), each on its own lead-in.
- **South Hardstand**: OSM's lanes are its lead-ins. Spots: the end of the PB lane
  (n14158137994), the end of the Q5 lane (n14158137989), the tip of the west apron's loop
  (n4066683435, via Q3 and the unnamed piece Q calls Q4), and one stub into each loop's middle
  (`xsE` 60 m, `xsW` 55 m). D4 (off Q6) isn't a spot: Q didn't list Q6 as an entrance.
- **Hangars**: an existing stand within 60 m of the building whose lead-in reaches a named
  taxiway, else a new spot 20 m outside the building toward its nearest taxiway node, with a
  straight unnamed lead-in from that node.

| Hangar | Airlines | Spot | Reached from |
|---|---|---|---|
| Delta (r3778810) | DAL | stand n12546344193 | S |
| American (w284907758) | AAL | `xgAAL` (lead-in 18 m) | SC |
| JetBlue (w843327546) | JBU | stand n4058675894 | TT |
| Korean Air (w284907751) | KAL | `xgKAL` (77 m) | SC |
| Singapore (w284907764, "SQ") | SIA | `xgSIA` (32 m) | SB |
| ANA (w284907702) | ANA | `xgANA` (115 m) | S / R junction |
| FedEx (w284907714 and "262 Federal Express" w284907711, one hangar, two spots) | FDX | `xgFDX1`, `xgFDX2` (127, 144 m) | C2 / C3 junction |
| United Cargo (w284907736) | UAL | `xgUAL` (144 m) | W |
| DHL Cargo (w284907684) | none (no single ICAO operator) | stand n9020941108 | SB |

Not attributed (no company in OSM): four hangars named "Cargo" (w284907886, w284907927,
w843327540, w843327541), "17" (w284911961, tagged abandoned), "19" (w842894938, next to the
de-icing stands), and six unnamed (w284907728, w284907733, w284907740, w284907867,
w284907891, w843327547). The IATA → ICAO codes (SQ → SIA, FedEx → FDX, United → UAL) are
mine, not sourced.

### Judgment calls

- **FA hold onto 4R/22L.** FA and FB merge at n45358355, already 39.5 m from 4R/22L's
  centerline, and FA's last edge (204 m) runs alongside the runway into it. So no point on it
  is ~95 m out like the nearby holds (F's h12213645048 is 95.7 m). The only places that far out
  are FA and FB before the merge, where the approach holds already stand; making those also
  protect 4R/22L would stop traffic just crossing between FA and FB for a runway it never
  enters. So `hxFA4R` sits at the merge and applies only to the edge onto the runway.
- **VA check-in.** Q listed VA as "closed" with no use; with the closure gone (Q11), it's
  `both`, at OSM's two marks there: n9328838863 (stand 7) and n5326590473 (stands 7M and 8).
- **SA check-in.** Q's second SA node, n6365384158, ends a 20 m dead-end stub with no ramp
  lane behind it, so SA is one check-in point, n5763789087.
- **A10/H** is named A10: the movement-area stub to it is A10; H is the ramp lane behind it.
- **31L line exits** take the branch away from the 31L end (H west, J west).

### Twin ramp handoffs merged (PLAN 1.13c, 2026-11-17)

Three check-in points were two nodes a few metres apart, joined by nothing: W/W2 (2.4 m, T7), VA's
two marks (4.2 m, T7) and S/SA (2.0 m, T8). They caused odd behaviour: seed 6's head-on between W
and W2, a near-reversal through the W pair, and seed 666's `via B SA` ending at S. Q decided to
merge them: each keeps one node (rhW, rhVA, rhS), the other's ramp lane is re-pointed to it
(`x13c-W2-lane`, `x13c-VA2-lane`, `x13c-SA-lane`, same shape), and its stub, node and handoff are
removed. S keeps its name; SA's taxiway stub is gone (my default: Q may prefer the name SA). No gate
gains or loses a type. This supersedes "VA check-in" and "SA check-in" under Judgment calls.

T8 from S: only the 11 stands on the north face of the north pier are reachable over lanes (the
pier lies between S's lane and NC's): the real layout. An arrival for the stands between the piers
comes in at NC (or TA's lane); for the south face, NB.

Open (Q): C3 and U3 meet runway 13L/31R at two nodes 7 m apart, so no route can go from one to the
other (a runway is crossed at a node, never travelled along). One crossing point, or as it is?

### Stands with room to push back inside the ramp (PLAN 1.13b, 2026-11-16)

Pushback never puts any of the aircraft on a taxiway (Q, after the 1.13 run). Nine stands had
no way out without one: T1 g632238189, …190, …191, …193 (N lane, toward NA) and T7
g1011144695 (VA), …697 (VV), …698 (A1), …701, and, for the 777 only, g1011116768 (W). Each
stub was found by a search: a straight ramp lane from a node on the push path, every 10°, long
enough for the longest type the stand takes plus 10 m; kept only if it stays on the apron,
crosses no lane, taxiway or building, ends 15 m clear of other edges, and gives the ramp's own
planner a plan inside the ramp for those types. Q approved them from rendered maps.

**Open, needs data work by hand (Q, 2026-11-16):** two T7 stands can't take a B777-300ER
(B77W), arriving or departing, because no pushback for one stays inside the ramp:
- **g1011144695 (by VA):** the corner has no room for a stub long enough for a 777's tail. It
  takes every other type up to the A333 (not the A359 or A380 either).
- **g1011116768 (by W):** its only workable stub would make every other type there leave by W
  instead of W2, head-on with arrivals coming in at W (the seed-6 test, traffic.test.ts). Left
  without one: it takes every type except the B77W.

T7 still takes the B77W at g1011144698 and g1011144701. KJFK has 71 stands a B77W can use
(73 before 1.13b, all of the difference being these two).

### Airlines (jfkairport.com, fetched 2026-11-14T19:40–19:41Z)

The site gives IATA codes; the format wants ICAO. **The IATA→ICAO mapping is mine, from ICAO
designators I know, not fetched.** Check any that look wrong.

- **T1 (25):** Air China CA/CCA, Air France AF/AFR, Air New Zealand NZ/ANZ, Air Serbia JU/ASL,
  Asiana OZ/AAR, Austrian OS/AUA, SATA International (Azores Airlines) S4/RZO, Brussels SN/BEL,
  China Eastern MU/CES, EgyptAir MS/MSR, EVA Air BR/EVA, Gulf Air GF/GFA, ITA AZ/ITY,
  Korean Air KE/KAL, LOT LO/LOT, Lufthansa LH/DLH, Neos NO/NOS, Philippine PR/PAL,
  Royal Air Maroc AT/RAM, Saudia SV/SVA, SAS SK/SAS, SWISS LX/SWR, TAP TP/TAP,
  Turkish TK/THY, Viva Aerobus VB/VIV.
- **T4 (21 on the page; 20 here):** Aeromexico AM/AMX, Air Europa UX/AEA, Air India AI/AIC,
  Arkia IZ/AIZ, Avianca AV/AVA, Caribbean BW/BWA, China Airlines CI/CAL, Copa CM/CMP,
  Delta DL/DAL, El Al LY/ELY, Emirates EK/UAE, Etihad EY/ETD, Kenya Airways KQ/KQA, KLM KL/KLM,
  LATAM LA/LAN, Singapore SQ/SIA, Uzbekistan HY/UZB, Virgin Atlantic VS/VIR,
  WestJet WS/WJA, Xiamen MF/CXA. The 21st, JetBlue, is listed for T4 only for international
  arrivals 10:30 p.m.–5:00 a.m. I put JBU in T5 only.
- **T5 (3):** JetBlue B6/JBU, Cape Air 9K/KAP, Sun Country SY/SCX.
- **T7 (6):** ANA NH/ANA, Aer Lingus EI/EIN, Condor DE/CFG, Kuwait KU/KAC, Norse N0/NBT,
  Icelandair FI/ICE.
- **T8 (14):** Alaska AS/ASA, American AA/AAL, British Airways BA/BAW, Cathay CX/CPA,
  China Southern CZ/CSN, Finnair AY/FIN, GOL G3/GLO, Hawaiian HA/HAL, Iberia IB/IBE,
  JAL JL/JAL, LEVEL LL/LVL, Qantas QF/QFA, Qatar QR/QTR, Royal Jordanian RJ/RJA.

Gates have no `airlines` yet (any of the terminal's).

## Validation now (stage b)

`npm run validate-airport -- KJFK`: **OK, 0 errors, 3 warnings**, all
`hold-short-far-from-runway` on the approach holds h5607488397, h5607488398 and h5607488399.
They protect 13L/31R's extended centerline beyond the 31R end, not its pavement, so by design no
13L/31R node lies within 500 m beyond them.

## Route search on KJFK (stage b)

`resolveRoute` on the real data (no probe pads), 30 runs each, median / worst: every route
0.01–0.20 ms / ≤ 0.47 ms, except the first call (JIT warm-up, 1.88 ms worst). Routes timed:
A R:KE K4 K to the Kilo pad; A B F over the A/B fillet; A B K to the Kilo pad (8.3 km); the
hardstand via Q Q5 and Q Q3; the Delta hangar via S; 31L via Z; the Zulu pad via Z; the penalty
box via Q Q2 and Q Q1 (ambiguous at the Q1 fork). The connector search adds nothing noticeable.
