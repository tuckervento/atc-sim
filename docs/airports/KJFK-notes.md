# KJFK: import notes (PLAN 1.5, stage a)

_Written 2026-11-14. Sources, choices and dates for `data/airports/KJFK.json` (generated) and
`data/airports/KJFK.overrides.json` (hand-curated). Open items for Q are in
[`KJFK-questions.md`](KJFK-questions.md)._

## Commands

```
npm run import-airport -- KJFK            # offline: raw file → data/airports/KJFK.json
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
- **Edge kind.** `aeroway=taxiway` → `taxiway`. `aeroway=taxilane` → `taxiway` when a taxiway
  way carries the same name (G, H, N, NB, NC, S, SA–SD, T, TA, W, LA, MA, Q1, Q2, C6, HB, KF,
  KG continue as named taxiways), else `rampLane` (AA, BB, D1, D2, D5–D7, D13, HEAVY, HH,
  INNER, OUTER, unnamed). Parking lead-ins → `rampLane`, unnamed. This is only a first cut of
  the ramp boundary (research §8.9); Q's ramp answers settle it in stage b.
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
  4L/22R edge) and holds more than 50 m past a runway end (2 approach holds on FA/FB beyond
  31R).
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

## What the overrides file sets, and why

| Item | Value | Source |
|---|---|---|
| Closed: Z, 2 edges from the Y junction (n45355700) to 4L/22R (n13858896748) | `closed` | Chart Supplement: "Twy Z btn Rwy 04L and 22R and Twy Y clsd UFN" |
| Closed: VA, the edge from the T7 apron edge (n6242188066) to A (n5326590474) | `closed` | Chart Supplement: "Twy VA clsd between Trml 7 apron and Twy A". A chart "X" sits beside VA |
| D between C and hangar 7 | nothing | OSM's D ends at C (n46582784); the closed pavement isn't in the data |
| NB southbound turns onto A | nothing | Deferred (Q): needs turn restrictions |
| Displaced thresholds 4L 140.2, 22R 1043.6, 13L 276.5, 31R 313.0, 13R 623.0, 31L 994.9 m | `displacedThresholdM` | Chart Supplement "Thld dsplcd" 460, 3424, 907, 1027, 2044, 3264 ft. 4R/22L: none |
| Tower 123.9 (4L/22R, 13R/31L), 119.1 (4R/22L, 13L/31R) | `towerPositions`, `runways[].towerPosition` | Chart Supplement / FAA diagram |
| Configuration `31s`: 31L arrivals + departures, 31R arrivals; default | `configurations`, `set.defaultConfiguration` | Q (2026-11-14); ASPM (research §4.1) |
| Remove `h5607488397` | `holdShorts.remove` | Its OSM ref is "31R-APCH": an approach hold on FB beyond the 31R end. The format can't express one, and the derived facing pointed away from the approach |
| `h8025529446` (ILS, on Z between the 31L end and 4R): protects 4R/22L, faces toward 4R | `holdShorts.patch` | The diagram prints "CAT 2 HOLD" here. The Chart Supplement lists TDZL for 4L, 4R, 22L, 13L and 31R, not 31L, and CAT II needs TDZ lights, so it can't be 31L's. Geometry alone was a near tie (181 m vs 205 m). Q to confirm (questions sheet) |
| Area `w284907690` name "Terminl 8" → "Terminal 8" | `areas.patch` | OSM typo |
| Terminal airlines | `terminals.patch` | jfkairport.com, below |

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

## Validation now (stage a)

`npm run validate-airport -- KJFK` fails, as expected, on items only Q's answers fix (each
mapped to a question in the sheet):

| Code | Count | Question |
|---|---|---|
| `gate-unreachable` (error) | 161 | Q7 ramp check-in points |
| `ramp-boundary-undeclared` (warning) | 143 | Q7 |
| `configuration-arrival-end-without-exits` (error) | 2 (31L, 31R) | Q8 |
| `disconnected-network` (error) | 1 (VA stub + 6 T7 ramp-lane edges cut off by the VA closure) | Q11 |
| `configuration-departure-end-without-line` (warning) | 1 (31L) | Q1, Q2 |
| `no-holding-pad`, `no-penalty-box` (warnings) | 2 | Q3, Q4 |

**Coming in stage b:** I ran the `runway-entry-unprotected` check with a probe ramp handoff on
every one of the 143 ramp/ground boundary nodes. It finds 4 entries with no OSM hold, which
will become errors once real handoffs exist: D onto 13L/31R from the C side (3 edges at
n46582783), and FA onto 4R/22L (n45358355 → n45357837). See Q12.

## Route search on KJFK

`resolveRoute` (1.8) on KJFK, with probe pads in memory (stage a has no real destinations), 20–30
runs each: every route resolved in 0.04–0.26 ms median, 0.39 ms worst (e.g. "A D C", 3 items).
The fork branching 1.8 warned about isn't a cost at this size; no cache needed.
Also seen: "A and B don't meet". OSM joins the parallel A and B only through unnamed
connectors (or the chart's A-numbers), so a route from A to B needs Q6's names.
