# KJFK: questions for Q (PLAN 1.5 stage a → stage b)

_2026-11-14. Answer against the map sheet. Names and ids below are the data's own._

**Open the map:** `npm run render-airport -- KJFK`, then open `dist/maps/KJFK.html` in Chrome.
Drag to pan, scroll to zoom. Type any id or name in **Find** (e.g. `n8025529445`, `Z`,
`h5969626554`) to zoom to it. Hover shows node and edge ids; zoom in for hold labels and gate
names. Black diamonds are OSM's non-movement boundary marks; grey dots are stands that aren't
gates. Both are OSM context, not airport data yet.

**Ids:** nodes `n…`; edges `w<way>-<from>-<to>`; hold-shorts `h…`. A hold label reads
`id runways [OSM ref]`, and its short tick points at the runway side. For a taxiway, its name is
enough; give a node only where the question asks.

**Background (docs/airports/KJFK-notes.md):**
- Closed: Z between Y and 4L/22R (n45355700 → n13858896748), and VA between the T7 apron and A.
- The 31L threshold is displaced 995 m (Chart Supplement), so a 31L arrival first touches
  pavement 995 m from the 31L end.

---

**Q1. Where does the 31L departure queue form, back to front, and which hold line is its front?**
- **Candidates near the 31L end:**
  - Z, running south from H (n4057398125) through J (n4068921630) to the 31L end, where its
    front hold would be `h8025529445`
  - JA (`h8025529443`), JB (`h8025529444`), J, H, Y (`h8025529442`, 471 m up the runway: an
    intersection departure)
- **[Proposal], forum only (airliners.net 2006/2010, unopened):**
  - "feed 31L from Z"; a long line wraps "Z to Y to F to 22R".
  - Z between Y and 4L/22R is now closed (Chart Supplement), so that wrap can't happen today.
- **Answer as:** taxiways back → front with their start node, plus the front hold id. For
  example: `Z from n4057398125 to h8025529445`.
- `Z from n4057398125 to h8025529445` mostly, though it could also extend to `Y from n45355700 to n45357551` and `Z from n46547996 to n45355700` to connect a longer queue
- i think the Z closure can be ignored, it's temporary

**Q2. The line's exits, back to front (at least 2)?**
- Candidates leaving Z between H and the 31L end: H at n4057398125, the unnamed Z–H link at
  n10709945044, J at n4068921630, and further back G and Y.
- An exit can't lead onto or toward a runway (JA and JB are runway entries).
- **Answer:**` H @ n4057398125, J @ n4068921630`.

**Q3. Holding pads: where are they, and how many aircraft does each hold?**
- The only official one is the **K run-up pad**: "Twy K runup pad clsd to acft wingspan more
  than 140 ft" (Chart Supplement).
- Neither the diagram nor OSM draws it. K near the 4L end has K/K1 n45352547, K/K2
  n4058549561 and K/K3 n4059009286.
- **Answer as:** per pad, its spot nodes (or "on K between K2 and K3, 3 spots"), and any other
  pad you use.
- The apron area directly west of K between K2 and K1, the apron area next to Z @ n8025529446, both holding 3-4 aircraft

**Q4. The penalty box: where is it?** No source names one (research §4.2).
- **Answer as:** location (nodes, or an area such as a named apron) and how many aircraft it holds.
- the 'Q loop' with Q1 near general aviation, as well as the de-icing spots at n14158137952 and similar

**Q5. Spoken names for each pad and the penalty box** (as the player says them, e.g. "Kilo
pad", "the penalty box"). Route commands will match these (1.8 follow-up).
- Kilo pad, Zulu pad, 'quebec box'

**Q6. Nine charted names that OSM doesn't have: A7, A8, A11, A12, A13, A14, A15, LL, Q4.**
None matches an unnamed OSM way clearly, so I named none. What the diagram overlay shows:

| Chart name | Where the label sits | My reading | Q's reading |
|---|---|---|---|
| A11 | between A, HB and the unnamed A–B connector `w403521117-n4057398094-n4057398092` | the stub A → T4 ramp that OSM calls **HB** (or that connector) | that connector is also HB |
| A12 | 19 m from OSM **KF** between A and its boundary mark n3273891234 | the stub A → ramp that OSM calls KF | i don't see anything unnamed here |
| A13 | 20 m from OSM **KG** between A and boundary n9316949013 | the stub A → ramp that OSM calls KG | also don't see anything on the map really |
| A14 | on A beside LA; no unnamed way near | ? | nothing is missing there? | 
| A15 | 8 m from the unnamed B–MB connector `w403399565-n4057465067-n4057465074` | that connector (weak) | i don't really see those curved connectors having names on the map, they're just used when the given route calls for a turn in that direction |
| A7 | 4 m from F, 12 m from the unnamed A–F–B connector `w403530912-…` | ? | that connector is also unnamed on my map, maybe mostly used by tugs or other ground crew? |
| A8 | 2 m from G, where G leaves A for the ramp | the G stub north of A | similarly, the criss-crossing routes near G and B are just to accommodate multiple orientations and plane routes |
| LL | between B and L near the A12/A13 labels | ? (could be an L with hold bars) | i don't see an LL |
| Q4 | the NW corner of the South Hardstand; OSM has PB running into it there (boundary n12776366536) | OSM's PB stub north of Q | Q4 seems to connect Q3 to the general aviation loop at n5324436598, may also be used during deicing procedures |

- **[Proposal]:**
  - The charted A-numbers name the movement-area stubs from A up to the ramp edge.
  - OSM's HB, KF and KG are the ramp lanes beyond it, and the check-in names. The NTSB records
    "at taxiway HB".
- Routing needs this too: A and B "don't meet" for a route, because OSM joins them only by
  unnamed connectors.
- **Answer as:** `name = edge id(s) or "A→boundary on KF"`, or "drop".

**Q7. Ramp check-in points, per terminal.** For each: its check-in name; departures (ramp
edge), arrivals (ramp entrance) or both; and its node. The black diamonds near each terminal
are OSM's boundary marks (node, taxiway):
- **T1:**
  - n1743728095: NA, both, but only for the gates it connects to
  - n4058612082: MA, both, but only for the gates it connects to
  - n5969626740: M, arrivals, for gates also served by MA
- **T4:**
  - n9316949013: KG, arrivals
  - n3273891234: KF, departures
- n9317064941: HB, departures
  - n1743805046: A10/H, arrivals
  - n45377108: G, departures
- **T5:**
  - n45368785: DA, departures
  - n46582681: A4, arrivals
  - n9328534742: D, departures
  - n5969626406: F, both 
- **T7:**
  - n1744034745: VV, both
  - n9328838863: VA, closed
  - n5969626538: the A1 stub, both
  - n9328534916 and n9328526607: W, both
- **T8:**
  - n9332675149: TA, departures
  - n9332650390: NB, both
  - n8025529430: NC, arrivals
  - n9332675155: S, arrivals
  - n5763789087 and n6365384158: SA, arrivals
  - n8025529425: T, departures
- **Answer as:** one line per point, e.g. `T8: TA, both, n9332675149`. I'll move the
  ramp-lane/taxiway boundary to the points you give. (Clears 161 `gate-unreachable` and 143
  `ramp-boundary-undeclared`.)

**Q8. Arrival exits: which exits does tower use for 31L arrivals, and for 31R?**
- The candidates are listed with their distance from the pavement end. An angle near 0° leaves
  forward, i.e. a high-speed exit.
- **31L** (threshold at 995 m):
  - MB 2,215 m, 4°
  - MC 2,643 m, 13°
  - MD 2,810 m, 9°
  - PA 3,164 m, 9°
  - PC 3,963 m, 16°
  - PD 4,174 m, 21°
  - PE 4,263 m, 8°
  - PF 4,364 m, 11°
- **31R** (threshold at 313 m):
  - D 1,368/1,417 m, 7–11°
  - two unnamed 1,787 m, 1°
  - WW 1,899 m, 0°
  - W 1,930 m, 90°
  - unnamed 2,209 m and 2,309 m, 0–2°
  - V 2,317 m
  - C5 2,382 m
  - U3 2,621 m, 1°
  - C3 2,627 m, 0°
  - U2 2,863 m
- **Answer as:** per runway, exit taxiway names in the order tower uses them. (Clears 2
  `configuration-arrival-end-without-exits` errors.)
- i removed unused exits from the list above

**Q9. The South Hardstand: which area is it, where do aircraft park, and how do they get there?**
- The diagram's "SOUTH HARDSTAND" is OSM's apron "General Aviation" (`w158041999`), south of Q.
- OSM has taxilane loops on it, entered from Q via PB (boundary n12776366536), Q5 (n5324436597)
  and Q6 (n457149820).
- The apron west of it (`w5786176`, also "General Aviation", by the GA terminal) is entered
  via Q3 (n5324436598).
- OSM has almost no stands there (only D4).
- **Answer as:**
  - which apron(s): w158041999 and w5786176
  - the entrances ground uses: Q5/PB, Q3+Q4
  - roughly how many parking spots: 5-6 across both aprons
  - its spoken name: penalty box
  - whether ground (you) or ramp controls inside it: me

**Q10. Which hangars are taxi destinations, and how is each reached?**
- **OSM hangars:** DHL Cargo, ANA (ref 66), 262 Federal Express, FedEx, United Cargo, KAL, AAL,
  SQ, DAL, JetBlue, four named "Cargo", "17" (tagged abandoned), "19", and several unnamed.
- **OSM hangar stands:** H15-*, H17-* and H19-* (grey dots, hangars 15/17/19).
- **Answer as:** per hangar, its spoken name and the taxiway (or stand) it's reached by, e.g.
  `Hangar 17 via ?, stands H17-1..4`.
- hangars are referred to usually as 'company hangar', with context about the aircraft deciding what that really means
- in general they're all reached by their nearest taxiway, i don't see any without an obvious way in/out

**Q11. The VA closure cuts off part of the T7 ramp.**
- In OSM, the lanes to stands 7, 7M and 8 connect to the rest of the airport only through VA.
- With VA closed, they're an island: one `disconnected-network` error.
- **Answer as:** how aircraft reach those stands now (e.g. a ramp lane from W or VV that OSM
  lacks), or "leave them out".
- it's a temporary closure, let's pretend like it's open

**Q12. Three missing runway holds** (not errors yet; they will be once check-in points exist):
- **D** north of 13L/31R: from C, D reaches the runway at n46582783 with no hold line.
- **FA** onto 4R/22L: from n45358355 to n45357837, no hold line.
- **Answer as:** confirm I should add a runway hold at each, or say where it is.
- confirm they should be added in a similar fashion to nearby taxiways

**Q13. Doubtful names (in OSM, not on the diagram), and the two "X" glyphs.**
- **CA** (1 edge, between C2 and C)
- **HB, KF, KG** (see Q6)
- **Q6** (Q → hardstand east entrance)
- **VV** (A → T7 ramp, between A1 and VA)
- **ZA** (5 edges between E, YA and DB, with runway hold `h1744026553` on 13L/31R)
- **"X" glyphs:** one sits beside A1/A/VA, next to VV and the closed VA; one beside MA.
- **Answer as:** keep / rename to … / drop, per name. For each X: which pavement it marks, and
  whether that pavement is closed.
- keep all; i think the X's can be ignored?

**Q14. Unnamed stubs into the ramp.** 1.8 can't route over unnamed edges into a ramp entrance.
- `w403398896-n4057452593-n1743728095`: A → T1 ramp, at boundary n1743728095; NA
- `w403518279-n1744051799-n4058675893`: TT → ramp; TT
- **Answer as:** a name each (or "not an entrance").

**Q15. Confirm these derived choices** (yes/no each):
- (a) Z wraps round the 31L end across the last 16 m of 13R/31L. I modelled it as crossing
  13R/31L there, between holds `h8025529445` and `h8025529447`.
- (b) ILS hold `h8025529446` on Z, at the diagram's "CAT 2 HOLD", protects **4R** (31L has no
  TDZ lights, so no CAT II).
- (c) OSM's approach holds on FA/FB beyond 31R (one tagged "31R-APCH") are left out. The
  format has no approach-hold kind. Needed for the 31s?
- (d) OSM hold `8025526864`, sitting on the K4/4L junction, is left out.
- (e) Two untagged OSM holds, on F and GG about 85 m from 4L/22R, are runway holds.

**Q16. Remote stands east of T4.**
- By my 150 m rule, stands 61, 61A, 61B, 62, 63, 63A, 63B (and A380 variants) and 29B became
  **T4 gates**.
- 72–79 and H1–H14 did not.
- **Answer as:** which of these are T4 gates and which are hardstands (or ignore).
- all of those are hardstands

---

## Follow-up answers (Q, 2026-11-15)

- **Q15:** accept all five as derived. For (c), model the FA/FB approach holds beyond 31R as
  runway holds protecting 13L/31R, facing the extended centerline. Ground traffic stops for 31R
  arrivals.
- **Q4 / Q9: two places.**
  - The **penalty box** ("penalty box" or "Quebec box") is the Q loop with Q1 near general
    aviation, plus the de-icing spots at n14158137952 and similar.
  - The **South Hardstand** (aprons w158041999 and w5786176, entered via Q5/PB and Q3+Q4, 5–6
    spots) is a separate parking destination that ground controls. Q9's "penalty box" as its
    spoken name is superseded. Its spoken name isn't settled; the default is "the hardstand" or
    "South Hardstand".
- **Q16:** the remote stands east of T4 (61–63, 72–79, H1–H14) are T4 parking handled by the
  simulated **ramp**, like gates. They're reached through the T4 check-in points.
- **Q6, how it affects routing (my reading of Q's answer):** the curved connectors stay
  unnamed. A route treats an unnamed connector between two consecutive named taxiways as the
  turn from one onto the other, e.g. "A, then B" may use the unnamed A–B connector. This
  changes 1.8's strict rule, so stage b updates `route.ts` and its tests.
