# Airport data research (PLAN task 1.3)

_Researched 2026-11-14 by Claude for Q. Covers the PRD §8.1 / §4.4 / §4.5 [Unverified] items._

**How to read this doc**
- **Verified** = I fetched the source and read the quoted text or data myself.
- **[Unverified]** = I couldn't confirm it. Each one says why.
- **Source quality labels:**
  - **Official**: FAA, NTSB, Federal Register, Port Authority, OSM Foundation.
  - **Secondary**: press, trade sites.
  - **Forum / sim**: pilot forums, VATSIM/IVAO.
- Raw downloads were kept outside the repo and aren't committed.

---

## 0. Summary

- **Decision: a mix.** OpenStreetMap supplies the base geometry and network. The current FAA airport diagram is the authority for names and current status. A per-airport overrides file holds everything operational: departure lines, pads, hold-short ownership, closures, configurations and terminal assignments. Reasoning in §8.
- **OSM is better than the PRD feared.** JFK's taxiways, taxilanes and runways form **one connected graph**.
  - 78 of the 87 taxiway names on the FAA diagram are present.
  - About 93% of taxiway length carries a name.
  - Runway lengths match the FAA Chart Supplement to within 0.2%.
  - Most elements were edited in 2025–2026.
- **Names missing from OSM** compared with the FAA diagram (cycle 2611):
  - JFK: **A7, A8, A11, A12, A13, A14, A15, LL, Q4**, plus an unexplained "X" label in two places (§2).
  - LGA: only ramp lane **14**.
- **What OSM can't give us:** which runway a hold-short belongs to, departure lines and their exits, holding pads or penalty box, and runway configurations. These must be hand-curated.
- **31L departure line and penalty box: mostly [Unverified].**
  - Official sources confirm the *route* to 31L: B → J → cross 4L (NTSB).
  - No official source says where the queue forms, what its exits are, or where JFK's penalty box is (§4).
  - This needs Q's call.
- **Runway crossings (verified):** FAA JO 7110.65BB ¶3-7-2: "Issue a crossing clearance to aircraft for each runway their route crosses." AIM 4-3-18: "ATC will issue an explicit clearance for all runway crossings." (§5)
- **Peak rate (verified):**
  - The FAA's JFK Order caps scheduled arrivals plus departures at **81 per hour** (0600–2259 ET), extended to 2028-10-28.
  - The FAA said in June 2026 that busiest-hour slots are "generally at the limits."
  - The most-used configuration, the 31s, averaged **93.9 ops/hour** of runway capacity in 2023–24 (ASPM).
  - No source split arrivals from departures (§6).
- **Terminals:** OSM has T1, T4, T5, T7, T8 and the **New Terminal One building (not yet open; now expected Q1 2027)**. It has **no T6 (under construction)** and no T2 (closed 2023). JFK's own site lists T1, T4, T5, T7 and T8 as operating, with T6 "coming soon" (§3).
- **PRD corrections for Q** (I didn't edit the PRD):
  - The most-used JFK configuration in ASPM is **arrive 31L & 31R, depart 31L**, slightly different from "land 31R, depart 31L".
  - The PRD's example "clear of three one right at **Kilo Echo**" pairs 31R with a taxiway that sits on **13R/31L** (§4.4).

---

## 1. OpenStreetMap data

### 1.1 Queries (exact text; re-runnable)

Run with `curl -sS --data-urlencode data@query.overpassql https://overpass-api.de/api/interpreter`.

**Query A, the feature dump** (used for every count and name list below). This is the KJFK version. The KLGA query is identical with every `KJFK` (three occurrences, one in the comment) replaced by `KLGA`:

```
[out:json][timeout:180];
// The aerodrome feature for KJFK (a way or relation tagged aeroway=aerodrome + icao=KJFK)
wr["aeroway"="aerodrome"]["icao"="KJFK"]->.ap;
.ap map_to_area->.a;
(
  nwr["aeroway"](area.a);   // every feature carrying any aeroway=* tag inside the aerodrome boundary
  .ap;                      // plus the aerodrome itself
);
out geom;
```

**Query B, edit-date check** (JFK only):

```
[out:json][timeout:120];
wr["aeroway"="aerodrome"]["icao"="KJFK"]->.ap;
.ap map_to_area->.a;
nwr["aeroway"~"^(taxiway|taxilane|holding_position|terminal|runway|gate)$"](area.a);
out meta;
```

**Snapshot timestamps** (`osm3s.timestamp_osm_base`):
- KJFK: 2026-11-14T06:12:48Z
- KLGA: 2026-11-14T06:13:52Z
- Query B: 2026-11-14T06:35:32Z

Query B returned 644 elements. That equals Query A's count for the same six types (5 + 166 + 92 + 234 + 10 + 137), which cross-checks Query A.

Overpass endpoint: overpass-api.de. I made three requests in total and all returned HTTP 200.

### 1.2 Feature counts by `aeroway` type

| `aeroway` value | KJFK total | KJFK split | KLGA total | KLGA split |
|---|---:|---|---:|---|
| navigationaid | 3,932 | node 3,932 (lights, see below) | 0 | – |
| parking_position | 380 | node 71, way 309 | 136 | node 9, way 127 |
| holding_position | 234 | node 167, way 67 | 117 | node 70, way 47 |
| taxiway | 166 | way 166 | 110 | way 110 |
| jet_bridge | 160 | way 160 | 79 | way 79 |
| gate | 137 | node 137 | 80 | node 80 |
| taxilane | 92 | node 2, way 90 | 47 | way 47 |
| hangar | 22 | way 21, rel 1 | 1 | way 1 |
| apron | 19 | way 19 | 11 | way 9, rel 2 |
| terminal | 10 | node 1, way 6, rel 3 | 9 | way 8, rel 1 |
| stopway | 8 | way 8 | 8 | way 8 |
| passenger_pickup | 5 | node 5 | 0 | – |
| runway | 5 | way 5 | 2 | way 2 |
| helipad | 3 | way 3 | 1 | way 1 |
| aerodrome | 1 | way 1 | 1 | way 1 |
| office | 1 | way 1 | 0 | – |
| tower | 1 | node 1 | 1 | way 1 |
| marking | 0 | – | 1 | node 1 |
| **Total elements** | **5,176** | | **604** | |

- **JFK `navigationaid` subtypes** are all lights and beacons: txc 1,127, rwe 898, rwc 673, tdz 540, als 472, rwt 123, txe 90, papi 8, beacon 1. They aren't needed for ground routing.
- **`holding_position:type` values:**
  - JFK: runway 142, movement 40, intermediate 28, ILS 9, LAHSO 8, untagged 7.
  - LGA: runway 38, intermediate 16, ILS 4, untagged 59. 41 LGA holds also carry `direction`.
- **Hold refs:** only 19 JFK and 9 LGA holds have a `ref`, and none says which runway it protects.
- **OSM has no pads.** There's no tag or name for holding pads, a penalty box or departure queues at either airport.

### 1.3 Network quality (computed from Query A)

| Check | KJFK | KLGA |
|---|---|---|
| Taxiway + taxilane + runway ways forming one connected graph (shared nodes) | **Yes**: 261 ways, 2,858 nodes, 1 component | 159 ways, 2 components; the stray one is a single unnamed taxilane |
| Hold-position nodes lying on a taxiway/taxilane/runway way | 164 of 167 | 70 of 70 |
| Runway-runway intersections modelled as a shared node | 13R/31L × 4L/22R; 4L/22R × 13L/31R | 13/31 × 04/22 |
| Named taxiway length vs unnamed | 125 ways / 56.3 km named; 41 ways / 4.3 km unnamed | 84 ways / 17.0 km named; 26 / 1.9 km unnamed |
| Named taxilane length vs unnamed | 47 / 11.6 km named; 43 / 4.9 km unnamed | 35 / 5.1 km named; 12 / 1.1 km unnamed |
| Ways carrying 2007-era `tiger:*` import tags (rougher geometry, likely) | 32 taxiway + 13 taxilane | 0 |
| Last edit year (Query B, JFK) | taxiways mostly 2025 (63) and 2026 (28), older back to 2016; holding positions mostly 2025 (124); all 5 runway ways 2026 | not measured |

**JFK runway lengths: OSM polyline vs FAA Chart Supplement**

| Runway | OSM | Chart Supplement |
|---|---:|---:|
| 13R/31L | 14,487 ft | 14,511 ft |
| 4L/22R | 12,080 ft | 12,079 ft |
| 4R/22L | 8,401 ft | 8,400 ft |
| 13L/31R | 8,957 ft + 1,030 ft displaced-threshold segment | 10,000 ft |

LGA: 13/31 is 6,993 ft and 04/22 is 7,001 ft in OSM; the Chart Supplement gives 7,002 ft for both.

### 1.4 Named taxiways in OSM (`ref`, with `name` used where `ref` is missing)

**KJFK, `aeroway=taxiway`** (85 distinct):
- A, A1, A4, A10, B
- C, C1, C2, C3, C5, C6, C7, CA
- D, DA, DB, E, EA, EE
- F, FA, FB, G, GG, H, HB
- J, JA, JB, K, K1, K2, K3, K4, KD, KE, KF, KG
- L, LA, M, MA, MB, MC, MD, N, NA, NB, NC
- P, PA, PB, PC, PD, PE, PF, Q, Q1, Q2, Q3, Q5, Q6
- R, S, SA, SB, SC, SD, T, TA, TB, TT
- U, U1, U2, U3, V, VA, VV, W, WW, Y, YA, Z, ZA

**KJFK, `aeroway=taxilane`** (refs and names): AA, BB, C6, D1, D2, D5, D6, D7, D13, G, H, HB, HEAVY, HH, INNER, KF, KG, LA, MA, N, NB, NC, OUTER, Q1, Q2, S, SA, SB, SC, SD, T, TA, W.

**KLGA, `aeroway=taxiway`** (40 distinct):
- Lettered: A, AA, AC, B, BB, C, CC, CY, D, DD, E, F, G, GG, H, J, K, L, M, N, P, Q, R, S, T, U, V, W, Y, YY, Z
- Numbered ramp lanes: 1, 3, 5, 6, 7, 8, 9, 11, 12

**KLGA, `aeroway=taxilane`:** 1, 2, 3, 5, 6, 7, 8, 9, 11, 12, 15, 16, 17, 18, 19, Z.

**Runways:**
- JFK: 04L/22R, 04R/22L, 13L/31R (2 ways), 13R/31L.
- LGA: 04/22, 13/31.

---

## 2. Comparison with the FAA airport diagrams

### 2.1 Charts used (Official, FAA d-TPP cycle **2611**, valid **29 OCT 2026 – 26 NOV 2026**)

| Airport | Chart | Version code printed on chart | URL |
|---|---|---|---|
| JFK | AL-610 (FAA) Airport Diagram | 26302 | https://aeronav.faa.gov/d-tpp/2611/00610ad.pdf |
| LGA | AL-289 (FAA) Airport Diagram | 26134 | https://aeronav.faa.gov/d-tpp/2611/00289ad.pdf |

- I believe the version code is YYDDD, the cycle in which the chart last changed: JFK 2026-10-29 (this cycle) and LGA 2026-05-14. Both decode exactly to d-TPP cycle start dates, which supports this, but I haven't confirmed it from an FAA definition.
- I found the cycle with the FAA d-TPP search (`https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dtpp/search/results/?cycle=2611&ident=JFK`).
- The chart legend is on page 16 of `https://aeronav.faa.gov/d-tpp/2611/frntmatter.pdf`. Two legend facts matter here:
  - "Positional accuracy within ± 600 feet unless otherwise noted on the chart." The diagram is a poor geometry source.
  - Under-construction areas are drawn as a dotted outline, and closed surfaces as small "x x x".

**Method.** The PDFs are vector charts, so I used two independent methods and compared them.
1. I extracted every text glyph and its position from the PDF content streams.
2. I rendered the charts at 7× zoom and read every label by eye.

Every name in the "missing" lists below was confirmed by both. I compared **names only**, not geometry; 1.7's side-by-side check covers geometry.

### 2.2 JFK

**Taxiway labels on the FAA diagram (87):**
- Single letters: A B C D E F G H J K L M N P Q R S T U V W Y Z
- Letter + number: A1 A4 A7 A8 A10 A11 A12 A13 A14 A15, C1 C2 C3 C5 C6 C7, K1 K2 K3 K4, Q1 Q2 Q3 Q4 Q5, U1 U2 U3
- Two letters: DA DB EA EE FA FB GG JA JB KD KE LA LL MA MB MC MD NA NB NC PA PB PC PD PE PF SA SB SC SD TA TB TT VA WW YA

**On the FAA diagram, missing from OSM entirely (9):** **A7, A8, A11, A12, A13, A14, A15, LL, Q4.**
- The A7, A8 and A10–A15 labels sit beside the A/B label stacks around the central terminal area; I didn't check exactly which pavement each one names. LL is near A13/LA; Q4 is on Q near the South Hardstand.
- OSM has 41 unnamed taxiway ways (4.3 km). Whether those include these connectors is **[Unverified]**; check during 1.5.

**"X" appears twice on the diagram**, in the same size and orientation as taxiway labels: next to "A1 A … VA" and next to "MA". OSM has no X.
- I believe these mark closed pavement, not a taxiway named X. The Chart Supplement says "Twy VA clsd between Trml 7 apron and Twy A", and one X sits beside VA.
- But the legend's closed-surface symbol is small lowercase "x x x" on grey, which isn't quite what's drawn. **[Unverified]**

**In OSM as taxiways but not on the FAA diagram (7):** CA, HB, KF, KG, Q6, VV, ZA.
- HB, KF and KG are probably ramp (non-movement) lane names. The FAA diagram doesn't name ramp lanes, and NTSB records a real check-in "at taxiway HB" (§4.2). That's a belief.
- CA, Q6, VV and ZA may be stale or renamed. **[Unverified]**

**OSM taxilane names not on the diagram:** AA, BB, D1, D2, D5, D6, D7, D13, HB, HEAVY, HH, INNER, KF, KG, OUTER. These are expected: ramp lanes.

**Other chart facts:**
- Hot spot **HS 1**. The hot-spot list (https://aeronav.faa.gov/d-tpp/2611/ne2hotspot.pdf) gives it as: "Maintain vigilance Twy K and Twy J complex int close proximity to Rwy 04L and Rwy 31L."
- A "CAT 2 HOLD" near the 31L/4R end.
- EMAS at the 4R and 22L ends.
- Note: "CAUTION: BE ALERT TO RUNWAY CROSSING CLEARANCES. READBACK OF ALL RUNWAY HOLDING INSTRUCTIONS IS REQUIRED."
- Runway Status Lights and ASDE-X in operation.
- Building labels: "INTERNATIONAL ARRIVAL TERMINAL U.S. CUSTOMS", "GA TERMINAL", "SOUTH HARDSTAND", "TWR". Terminals aren't numbered on the chart.
- A dotted under-construction outline in the central terminal area, south of the TWR building. Which project it is, is **[Unverified]**.
- Short double bars beside some labels (for example Z at the 31L end) are the legend's "Runway Holding Position Markings" symbol, not underlines.

### 2.3 LGA

**Labels on the FAA diagram (47):**
- Single letters: A B C D E F G H J K L M N P Q R S T U V W Y Z
- Two letters: AA AC BB CC CY DD GG YY
- Numbered ramp lanes: 1 2 3 5 6 7 8 9 11 12 14 15 16 17 18 19

**Missing from OSM entirely:** ramp lane **14** only.
- Every lettered taxiway is present.
- Lanes 2 and 15–19 are in OSM tagged `taxilane`, not `taxiway`.
- OSM's numeric "taxiway" refs (1, 3, 5, …) match real ramp lanes and aren't errors.

**In OSM but not on the diagram:** none.

**Other chart facts:**
- HS 1 is "Int of rwys and Twy G, Twy P, Twy R, Twy S"; HS 2 is "Exiting Rwy 04 at Twy Q".
- Three "ILS HOLD" lines.
- Notes: "AIRCRAFT TAXIING ON TWY B FOR RWY 4 DEPARTURE, MAY BE INSTRUCTED TO HOLD AT THE ILS HOLD LINE" and "OVERHEAD PEDESTRIAN BRIDGE MAX TAIL HEIGHT 50 FEET".
- Terminals A, B and C are labelled.

### 2.4 FAA Chart Supplement remarks that affect the data (Official)

Source: NE Chart Supplement, effective **29 OCT 2026 – 24 DEC 2026**.
- JFK entry, pp. 224–225: https://aeronav.faa.gov/afd/29oct2026/ne_224_29OCT2026.pdf
- LGA entry, p. 226: https://aeronav.faa.gov/afd/29oct2026/ne_226_29OCT2026.pdf

**JFK**
- "Metering procedures in effect–ctc ramp ctl prior to pushback 1200–1500Z‡ daily, 1900–0300Z‡ daily."
- Closures and limits:
  - "Twy Z btn Rwy 04L and 22R and Twy Y clsd UFN."
  - "Twy VA clsd between Trml 7 apron and Twy A."
  - "Ufn Twy D between Twy C and hangar 7 clsd."
  - "Twy NB clsd to SB turns at Twy A." This is a **turn restriction**, not a closure.
  - "Twy K runup pad clsd to acft wingspan more than 140 ft."
  - "Acft are not permitted to stop on either Twy A or B bridges."
- "Converging ops on Rwy 13R and Rwy 22L conducted via arr distance window."
- Tower: 119.1 (Rwys 04R–22L and 13L–31R), 123.9 (Rwy 04L–22R and 13R–31L). GND CON 121.9; RAMP CTL 125.05.
- "Special Air Traffic Rules—Part 93 High Density Arpt."

**LGA**
- Tower 118.7, GND CON 121.7 (one of each).
- "Twy F lctd btn Twy BB and Twy Y clsd indef."
- Wingspan limit on F and D west of BB (125 ft).
- Deck speed limits on Twy G, P, R and U.

---

## 3. JFK terminals: OSM snapshot vs today

| Terminal | In OSM (2026-11-14) | Status today | Source (quality) |
|---|---|---|---|
| T1 | Yes, "Terminal 1" | Operating. To be demolished once NTO phase 1 opens | jfkairport.com/explore-jfk/terminals (Official, fetched 2026-11-14); TPG 2026-09-15 (Secondary) |
| T2 | No | Closed January 2023; Delta moved to T4; the site is part of NTO | TPG "JFK Terminal 2 closed", Patch, Untapped Cities (Secondary; **seen in search-result summaries only, pages not opened**) |
| T4 | Yes, "Terminal 4" (alt_name "International Arrivals Building") plus a node "Delta Concourse" | Operating | jfkairport.com (Official) |
| T5 | Yes, a way and a relation, operator JetBlue | Operating | jfkairport.com (Official) |
| T6 (new) | **No** | Under construction. The Port Authority project page says "First five gates open in 2026" (10 gates, 9 wide-body). jfkairport.com calls it "coming soon" with no date. **No source confirms it has opened as of 2026-11-14.** | portauthoritybuilds.com T6 page (Official, undated); jfkairport.com (Official) |
| T7 | Yes, relation, operator British Airways | Operating. The Port Authority page says T7 "will continue operations until the second phase of Terminal 6 construction begins in 2026" | jfkairport.com; portauthoritybuilds.com (Official) |
| T8 | Yes, a way and a relation, plus a third feature misspelled "Terminl 8" | Operating | jfkairport.com (Official) |
| New Terminal One | **Yes**, way 1359238780 "New Terminal 1", `building=yes`, last edited 2026-02-20 | **Not open.** NTO officials told TPG on 2026-09-15 it "expects to begin welcoming passengers during the first quarter of 2027" (it had been targeting mid-2026). jfkairport.com doesn't list it | TPG (Secondary, quoting an NTO spokesperson); jfkairport.com (Official) |

**What this means for the snapshot.** OSM draws a terminal (NTO) that isn't open, and lacks one (T6) that may open soon. The game will drift either way, as PRD §8.1 accepts.

My [Proposal]: v1 uses the terminals operating on 2026-11-14 (T1, T4, T5, T7, T8). The NTO footprint is either drawn as an inactive building with no gates or dropped. This is Q's call.

---

## 4. JFK 31L departure line, holding pads and penalty box

### 4.1 Verified (Official)

**Configuration**
- In ASPM data for 09/2023–08/2024, JFK's most-used configuration was **"31L, 31R | 31L"**: arrivals on 31L and 31R, departures on 31L.
  - Used 20% of hours, with no weather impact.
  - Average runway capacity 93.9 ops/hour; average taxi-out 24.3 min, taxi-in 9.9 min.
  - Source: FAA, "Airport Capacity Trends at JFK", K. Duffy, FAA Office of Airports, JFK Roundtable, 2024-09-09, slide 13. Hosted at https://panynj.gov/content/dam/port-authority/aircraft-noise/jfkac-presentation-sep-2024.pdf.
- The PRD's "land 31R, depart 31L" is therefore the common setup, simplified: real arrivals also use 31L.
- An FAA 2009 construction briefing also lists "Land 31R & 31L Depart 31L" as a planned configuration (https://www.faa.gov/sites/faa.gov/files/airports/runway_safety/controllers/resources/JFK_Ops-During-Rwy-Closure-Final.pdf).

**Route to 31L**
- NTSB AIR-24-01 (2024), on the 2023-01-13 runway incursion: "taxiway TA, left on B, and hold short at J, which he stated was the standard route to runway 31L from the American Airlines gates." It also refers to "taxiing onto taxiway J and crossing runway 4L (the standard route to runway 31L)."
- Taxiway K is where "the standard routes to runways 4L and 31L diverged."
- So departures for 31L reach it via **B (or A) → J, crossing runway 4L/22R**.
- Report: https://www.ntsb.gov/investigations/AccidentReports/Reports/AIR2401.pdf

**Real JFK ground exchanges** (NTSB ATC Group Chair Factual Report, DCA23LA125): https://data.ntsb.gov/Docket/Document/docBLOB?ID=16431711&FileExtension=pdf&FileName=ATC+Group+Chair+Factual+Report+JFK+DCA23LA125-docket-Rel.pdf
- DAL1943 "reporting they were at taxiway HB, and had … information whiskey" was told to "taxi to runway 4L, via right turn on taxiway A, and to hold short of taxiway J". Later: "follow company traffic to their right, cross runway 31L at taxiway K, and monitor the tower frequency."
- AAL106 "at taxiway TA, and ready to taxi" was told to "taxi to runway 4L, via a left turn on taxiway B, and hold short of taxiway K".
- This supports the PRD's check-in at a named ramp exit (HB, TA) and the "monitor tower" handoff.

**Runway, tower and taxiways near the 31L end**
- In a different configuration (arrive 22L, depart 22R and 31L), the FAA 2014 capacity profile says: "Departures from Runway 31L begin takeoff roll after the intersection with Runway 4L."
- 31L belongs to the **123.9** tower position, shared with 4L/22R.
- The FAA diagram labels these taxiways at or near the 31L threshold: **Z, JA, JB, J, H, Y**, plus a "CAT 2 HOLD".
- In OSM, the taxiways that share a node with 13R/31L are: K, KE, L, M, MB, MC, MD, JA, JB, PA, PC, PD, PE, PF, Y, Z.
- Current closure: "Twy Z btn Rwy 04L and 22R and Twy Y clsd UFN" (§2.4).
- Hot spot HS 1 covers the K/J complex next to 4L and 31L.

**Pads (Chart Supplement):** "Twy K runup pad clsd to acft wingspan more than 140 ft." This is the only pad any official source names.

### 4.2 [Unverified]

**Which taxiways the 31L queue forms on.**
- The only claim I found is forum-level and old. Airliners.net threads from 2006 and 2010 say departures "feed 31L from taxiway Z" and, when the line is long, wrap "Z to Y to F to 22R".
- I saw this **only in a search-result summary**. The page redirects to a pay-per-crawl gateway, so I didn't open it.
- The current Z closure between 4L-22R and Y may have changed this.

**The exits along the 31L line.** No source found. Taxiways connecting to Z and J near the threshold (JA, JB, J, H, Y on the diagram) are geometric candidates only.

**JFK holding pads and penalty box.**
- No official, secondary or sim source names a location.
- "Penalty box" shows up only as a generic term in pilot and passenger forums (as the PRD already says), and the FAA diagram labels no pad.
- Candidates if Q wants to designate some, as a [Proposal] only: the K run-up pad (official, §2.4) and the **South Hardstand** (FAA diagram label).

**Sim sources.** VATSIM vZNY's JFK ground SOP didn't turn up. The IVAO KJFK SOP page returned HTTP 403, and I didn't try to work around it.

### 4.3 What 1.5 needs from Q

Pick the 31L departure line, its ordered exits, and the pads/penalty box. Two options:
- (a) Designate them by hand from the FAA diagram as plausible (a [Proposal], flagged as not sourced).
- (b) Find a better source first, for example listening to LiveATC JFK Ground in the 31s, or a controller contact.

### 4.4 PRD fact-check: "Kilo Echo"

- PRD §4.3's example is "clear of three one right at Kilo Echo".
- In OSM, KE shares a node only with **13R/31L**. On the FAA diagram, both KE labels sit beside 13R/31L near HS 1.
- So a 31R arrival wouldn't exit at KE.
- The PLAN's terse example (`taxi 31L via A R:KE hs B`) is consistent, because KE is on the 31L side.
- The taxiways that touch **13L/31R** in OSM are: D, E, V, W, Y, C1, C5, DB, U1, U2, YA, ZA. Those are the candidate exits for 31R arrivals.

---

## 5. FAA rule on runway-crossing clearances

**FAA Order JO 7110.65BB**, Air Traffic Control, Change 3, effective 7/9/2026 (Official).
- Index: https://www.faa.gov/air_traffic/publications/atpubs/atc_html/
- **Para 3-7-2, Taxi and Ground Movement Operations:** https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap3_section_7.html

**3-7-2.d** (letter inferred from list order in the FAA HTML):

> "Issue a crossing clearance to aircraft for each runway their route crosses. An aircraft must have crossed a previous runway before another runway crossing clearance may be issued. At those airports where the taxi distance between runway centerlines is 1,300 feet or less, multiple runway crossings may be issued with a single clearance. The air traffic manager must submit a request to the appropriate Service Area Director of Air Traffic Operations and receive approval before authorizing multiple runway crossings."

**Also in 3-7-2:**
- When holding short of a runway: "issue the route up to the runway hold short point. When issuing a runway crossing clearance, include specific instructions on where to cross the runway".
- Phraseology: "CROSS (runway), at (runway/taxiway)".
- NOTE: "The absence of holding instructions authorizes an aircraft/vehicle to cross all taxiways that intersect the taxi route." This covers **taxiways only**.

**Pilot side, AIM 4-3-18** (Official): https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap4_section_3.html

> "A clearance must be obtained prior to crossing any runway. ATC will issue an explicit clearance for all runway crossings."

The same paragraph adds that assigning a takeoff runway "does not authorize the aircraft to 'enter' or 'cross' the assigned departure runway at any point."

**What this means for the game.** The PRD §4.5 rule holds: stop at every runway unless explicitly cleared to cross *that* runway.
- One clearance per runway, issued only after the previous runway is crossed.
- Multi-runway single clearances are a local exception needing approval. They aren't needed for v1.

---

## 6. JFK peak hourly arrivals and departures

| Figure | Value | Source (quality, year) |
|---|---|---|
| Cap on scheduled operations | **81 scheduled arrivals + departures per hour, 0600–2259 ET**: "scheduled U.S. air carrier and foreign air carrier arrivals and departures will not exceed 81 per hour from 6 a.m. through 10:59 p.m., Eastern Time" | FAA Order, 73 FR 3510 (2008-01-18), ¶4.b: https://www.govinfo.gov/content/pkg/FR-2008-01-18/pdf/08-171.pdf (Official) |
| The cap is current and binding at peak | Extended to **2028-10-28**. "Since 2024, when this Order was last extended, allocated slots in the busiest hours were generally at the limits imposed by this Order." | 91 FR 37769 (2026-06-23): https://www.govinfo.gov/content/pkg/FR-2026-06-23/pdf/2026-12591.pdf (Official). Also FR 2026-20784 (2026-10-09): JFK is IATA Level 3 (https://www.federalregister.gov/d/2026-20784) |
| Runway capacity in the 31s (arrive 31L/31R, depart 31L) | **93.9 ops/hour** average, 20% of hours, Sep 2023 – Aug 2024 | FAA presentation, ASPM data, 2024 (Official) |
| Other configurations, same period | 72.9 – 94.2 ops/hour | same |
| Older capacity profile | Visual 84–87 (arrival priority) / 90–93 (departure priority); marginal 85–86; instrument 74–84 ops/hour. Doesn't include the 31s. FY2009–10 data | FAA JFK Airport Capacity Profile 2014: https://www.faa.gov/sites/faa.gov/files/airports/planning_capacity/profiles/JFK-Airport-Capacity-Profile-2014.pdf (Official, dated) |

- **[Unverified]: the arrival/departure split.** None of these sources splits peak hours into arrivals versus departures. The 2014 profile says JFK "tends to operate in an arrival or departure priority mode", so real peaks are often unbalanced.
- **[Proposal] for 1.14's soak test:**
  - Peak = **81 ops/hour**, split roughly 40 arrivals / 41 departures. The even split is my assumption.
  - Optionally add a stress run at about **94 ops/hour** (47/47), the 31s' average capacity.
  - The 81 counts scheduled carrier operations only; GA and other unscheduled traffic is on top.

---

## 7. OpenStreetMap licensing (ODbL), in plain terms

Sources (Official):
- https://www.openstreetmap.org/copyright
- https://osmfoundation.org/wiki/Licence/Attribution_Guidelines (adopted 2021-06-25; page last edited 2026-09-10)
- Licence text: https://opendatacommons.org/licenses/odbl/1-0/ (linked for reference; I didn't fetch it)

**What the licence says**
- OSM data is under the **Open Database License (ODbL)**.
- "If you alter or build upon our data, you may distribute the result only under the same license."
- **Attribution:** credit "OpenStreetMap" and make clear the data is under the ODbL. "© OpenStreetMap contributors" is still accepted.
  - For games, the guideline allows a startup splash screen, the credits page or a menu.
  - It applies when the work is **used publicly**; the guideline says internal use isn't covered.
- **Derivative Database:** a substantial extract of OSM, such as `data/airports/KJFK.json`. If it's used publicly, it must be offered under the ODbL.
- **Produced Work:** the game itself, or a rendered map. It needs attribution only.

**What this means for us** (my reading; not legal advice)
- **Today, with Q playing alone on Q's Mac:** nothing is triggered.
- **Cheap good practice now:** put a `source`/`license` note ("Data © OpenStreetMap contributors, ODbL 1.0") inside each OSM-derived airport file, and a one-line credit in the app's about/credits screen.
- **If the game is ever shared publicly:**
  - Ship or offer the OSM-derived airport files under the ODbL.
  - The game code isn't affected.
  - Keep hand-curated overrides in separate files. Overrides drawn from FAA charts are, I believe, US-government public domain (not verified here).

---

## 8. Decision: OSM, hand-trace, or a mix

**Decision: a mix, with OSM as the base.** The importer (1.5) builds the node/edge graph, runway geometry, gates, parking positions and hold-position points from OSM. A per-airport overrides file fixes and adds what OSM lacks, using the FAA diagram as the authority for names and current status.

**Why**
1. **OSM's geometry and topology are good enough to route on.**
   - JFK is one connected graph with runway intersections modelled.
   - 164 of 167 hold nodes sit on the network.
   - Runway lengths are within 0.2% of the FAA figures.
   - It's being actively edited (2025–2026).
   - LGA is the same, apart from one stray lane.
2. **Hand-tracing from the FAA diagram would be slower and less accurate.** The chart itself states positional accuracy of only ±600 ft and isn't to scale for geometry. JFK alone has about 87 named taxiways.
3. **OSM's gaps are small and enumerable.** It lacks 9 JFK names and 1 LGA name, has 7 doubtful JFK names, and doesn't model a few closures. These fit an overrides file, which PLAN already requires ("anything hand-curated goes in a per-airport overrides file, not code").
4. **OSM has no operational semantics.** Departure lines, pads, configurations and hold ownership are hand-curated for any data source, so choosing OSM doesn't add work there.

**To hand-curate in `KJFK.overrides.json` (PLAN 1.5)**

1. **Names**
   - Add A7, A8, A11–A15, LL and Q4 by matching unnamed OSM ways to the diagram.
   - Review OSM-only CA, HB, KF, KG, Q6, VV and ZA: keep real ramp lanes and check-in points, drop stale ones.
   - Merge or fix "Terminl 8".
   - Decide what the "X" glyphs mean.
2. **Closures and restrictions** (Chart Supplement, Oct 2026)
   - VA closed between the T7 apron and A.
   - Z closed between 4L-22R and Y.
   - D closed between C and hangar 7.
   - **NB: no southbound turns onto A.** This needs a turn-restriction concept in the format.
   - The decision whether to model closures at all is Q's.
3. **Hold-short ownership.** OSM holds don't say which runway they protect.
   - Derive it from geometry, then verify by hand.
   - Mark ILS/CAT II holds (9 ILS-type in OSM, plus the "CAT 2 HOLD") and LAHSO holds (8).
4. **Runway exits** for 31R arrivals: candidates D, E, V, W, Y, C1, C5, DB, U1, U2, YA, ZA (§4.4).
5. **The 31L departure line and its ordered exits.** Needs Q's decision (§4.3).
6. **Holding pads and penalty box.** Needs Q's decision. Candidates: the K run-up pad and the South Hardstand.
7. **Runway configurations**
   - The 31s: arrive 31R (ASPM also shows 31L arrivals), depart 31L.
   - The 4s as a stretch configuration.
   - Optionally, the tower position per runway (123.9 for 4L/22R and 13R/31L; 119.1 for 4R/22L and 13L/31R).
8. **Terminals, gates and airlines**
   - Which terminals exist in the snapshot (§3).
   - Gate → terminal mapping: OSM has 137 gate nodes with refs but no terminal tag.
   - Airline → terminal assignments: needs a current source such as the jfkairport.com terminal pages.
9. **Ramp boundary**
   - The ramp edges and entrances that serve as handoff points.
   - Their check-in names (for example TA, HB, KF).
   - OSM `taxilane` is only a rough hint of "ramp".

For **LGA** (format check only): add lane 14, the ILS hold lines, and terminal/gate mapping (Terminals A, B, C; OSM also has the Marine Air Terminal).

---

## 9. LGA layout notes for the airport-agnostic format

- **Runways that intersect are normal, not an LGA special case.**
  - LGA's 04/22 and 13/31 (both 7,002 ft) cross. OSM models this with a shared node, and HS 1 is the intersection itself.
  - JFK has intersections too: 4L/22R crosses both 13R/31L and 13L/31R.
  - A point on the runway intersection belongs to **two runways**. A crossing there can need approval for both, and the format must let a hold-short reference more than one runway (PLAN 1.6 acceptance).
- **Hold-short types differ.** The format should type them:
  - runway holds
  - **ILS critical-area holds**: LGA has three "ILS HOLD" lines, and the chart notes Rwy 4 departures on B "may be instructed to hold at the ILS hold line"; JFK has CAT II holds
  - LAHSO holds on a runway, for the other runway
  - plain intermediate holds
- **Names aren't always letters.** LGA's ramp lanes are numbers (1–19), and they appear on the FAA diagram. Names must be strings, and the terse parser should accept a numeric lane in a route.
- **Ramp naming differs by airport.** LGA's ramp lanes are charted; JFK's (KF, HB, …) aren't. The format can't assume ramp lanes come from the chart.
- **Tower layout differs.** LGA has one tower frequency for both runways; JFK splits tower by runway pair. If tower positions are ever modelled, map runway → position in data.
- **Taxiway restrictions exist** at both airports (wingspan, tail height, speed), but they're out of v1 scope (PRD non-goal). Don't model them yet.

---

## 10. PRD [Unverified] items: outcome

| PRD item | Outcome |
|---|---|
| §4.1 "land 31R, depart 31L" is a common JFK setup | **Mostly verified.** The 31s are JFK's most-used configuration (20% of hours, 2023–24), but ASPM records arrivals on 31L and 31R (§4.1) |
| §8.1 OSM is detailed enough | **Verified, with gaps** (§1, §2, §8) |
| §8.1 terminal rebuild status | **Verified** as of 2026-11-14: NTO not open (Q1 2027 expected); T6 not confirmed open; T7, T1, T4, T5, T8 operating (§3) |
| §8.1 LGA runways cross in a tight space | **Verified** (§9) |
| §4.4 "penalty box" | **Still [Unverified].** Forum-level term only; no JFK location found (§4.2) |
| §4.5 explicit crossing clearance per runway | **Verified**: 7110.65BB 3-7-2.d, AIM 4-3-18 (§5) |
| PLAN Context: JFK real peak hourly movements | **Verified as a combined figure**: 81 scheduled ops/hour cap at peak; 93.9 ops/hour capacity in the 31s. Arrival/departure split **[Unverified]** (§6) |

---

## 11. Open questions for Q

1. Terminal snapshot: operating terminals only (T1, T4, T5, T7, T8), or include NTO and/or T6 ahead of opening? (§3)
2. The 31L departure line, its exits, the pads and the penalty box: designate by hand as unsourced, or look for a better source first? (§4.3)
3. v1 configuration: keep "land 31R only", or also land on 31L as ASPM shows? (§4.1)
4. Soak-test peak: 81 ops/hour (40 arrivals / 41 departures) plus a 94/hour stress run? (§6)
5. Fix the PRD §4.3 "31R at Kilo Echo" example? (§4.4)
6. Model Chart Supplement closures and the NB turn restriction in v1, or ignore them? (§8)

---

## 12. Sources

**Official, FAA**
- d-TPP cycle 2611 airport diagrams: JFK https://aeronav.faa.gov/d-tpp/2611/00610ad.pdf · LGA https://aeronav.faa.gov/d-tpp/2611/00289ad.pdf
- d-TPP front matter and legend: https://aeronav.faa.gov/d-tpp/2611/frntmatter.pdf
- NE hot spots: https://aeronav.faa.gov/d-tpp/2611/ne2hotspot.pdf
- Chart Supplement NE, 29 Oct – 24 Dec 2026: https://aeronav.faa.gov/afd/29oct2026/ne_224_29OCT2026.pdf (JFK) · https://aeronav.faa.gov/afd/29oct2026/ne_226_29OCT2026.pdf (LGA)
- JO 7110.65BB ¶3-7-2: https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap3_section_7.html
- AIM 4-3-18: https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap4_section_3.html
- JFK Airport Capacity Profile 2014: https://www.faa.gov/sites/faa.gov/files/airports/planning_capacity/profiles/JFK-Airport-Capacity-Profile-2014.pdf
- "Airport Capacity Trends at JFK" (FAA, 2024-09-09; hosted by the Port Authority): https://panynj.gov/content/dam/port-authority/aircraft-noise/jfkac-presentation-sep-2024.pdf
- JFK Bay Runway Construction briefing (2009): https://www.faa.gov/sites/faa.gov/files/airports/runway_safety/controllers/resources/JFK_Ops-During-Rwy-Closure-Final.pdf

**Official, Federal Register**
- 73 FR 3510 (2008): https://www.govinfo.gov/content/pkg/FR-2008-01-18/pdf/08-171.pdf
- 91 FR 37769 (2026): https://www.govinfo.gov/content/pkg/FR-2026-06-23/pdf/2026-12591.pdf
- FR 2026-20784: https://www.federalregister.gov/d/2026-20784

**Official, NTSB**
- AIR-24-01: https://www.ntsb.gov/investigations/AccidentReports/Reports/AIR2401.pdf
- ATC Group Chair Factual Report, DCA23LA125: https://data.ntsb.gov/Docket/Document/docBLOB?ID=16431711&FileExtension=pdf&FileName=ATC+Group+Chair+Factual+Report+JFK+DCA23LA125-docket-Rel.pdf

**Official, Port Authority**
- https://www.jfkairport.com/explore-jfk/terminals (fetched 2026-11-14)
- https://www.portauthoritybuilds.com/redevelopment/us/en/jfk/planned-projects/terminal-6.html

**Official, OSM**
- https://www.openstreetmap.org/copyright
- https://osmfoundation.org/wiki/Licence/Attribution_Guidelines
- Overpass API: https://overpass-api.de/api/interpreter

**Secondary**
- The Points Guy, "New York JFK's new Terminal One delayed until early 2027" (2026-09-15): https://thepointsguy.com/news/new-york-jfk-new-terminal-one-delayed-2027
- T2 closure, from search-result summaries only: https://thepointsguy.com/news/jfk-terminal-2-closed · https://www.patch.com/new-york/queens/terminal-2-jfk-airport-permanently-close

**Forum / sim** (lowest weight; not opened)
- airliners.net "JFK 31L Taxi Patterns": https://www.airliners.net/forum/viewtopic.php?t=409045 (search summary only)
- Airline Pilot Central "Penalty box" (cited in the PRD): https://www.airlinepilotforums.com/technical/33438-penalty-box-print.html
