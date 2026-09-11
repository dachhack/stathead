# Week 1 (2026) weekly-projection validation

Validated `public/data/weekly-projections-2026.json` (built 2026-09-11 19:05 UTC,
after the Wednesday and Thursday games) against the nflverse week-1 roster,
depth-chart and injury snapshots committed the same morning, the two games
already played, Sleeper's week-1 projections, and news reports for the
disputed starters. Reproduce with:

```
python3 scripts/validate-weekly-projections.py --week 1 --sleeper <sleeper-week1.jsonl>
```

(the Sleeper file is the jsonl output of `get_sleeper_projections season=2026
week=1 limit=1000 fields=full_name,position,team,pts_ppr`).

## Verdict

The matchup layer is fine: for regular starters our week-1 numbers agree with
Sleeper at r = 0.86 (RB), 0.83 (WR), 0.72 (TE) and 0.51 (QB), with a mean
absolute gap of 1.6–2.2 points, and the market/def-vs-pos multipliers move
players by the few percent they are meant to. The problems are all upstream of
the multipliers, in **who is on the list and what team/role they carry**, and
one is in the builder's in-week bookkeeping. Ranked by how much they distort a
week-1 lineup:

### 1. Roster status is never read, so unavailable players carry full strips

The pool and the weekly builder take team from an April roster spine plus
manual overrides, and never look at the roster `status` column. The MCP zeroes
players only when the nflverse injury report says Out/IR, which does not cover
reserve lists, the exempt list, practice squads or retirements. Week-1 rows
that should be zero or absent:

| player | ours wk1 | why |
|---|---|---|
| Josh Jacobs (GB RB1) | 16.8 | Commissioner's exempt list since early September; Sleeper 0. MarShawn Lloyd (ours 2.2, Sleeper 9.5) and Chris Brooks inherit. |
| Brock Bowers (LV TE1) | 15.4 | Meniscus trim on Tuesday, DNP, expected to miss "a game or two". Sleeper 0. Michael Mayer (ours 5.8, Sleeper 8.5) inherits. Not yet Out in the committed injury file because designations post Friday — the report should be re-pulled before Sunday. |
| Jordyn Tyson (NO WR2) | 10.8 | Reserve (R48). Devaughn Vele (Sleeper 9.7) is not in our pool at all. |
| Jayden Higgins (HOU WR2) | 8.4 | Injured reserve. Kayshon Boutte (Sleeper 9.0) is not in our pool. |
| Ricky Pearsall (SF WR2) | 7.8 | Injured reserve. |
| Isiah Pacheco (DET RB) | 7.7 | Injured reserve. |
| Zach Charbonnet (SEA RB) | 7.0 | Reserve/PUP (R04); did not play Wednesday. |
| Tank Dell, James Conner, Trevor Etienne, Devin Neal, Chris Brazzell | 4–6 | Reserve lists. |
| Teddy Bridgewater (DET QB2) | 18.0 | Retired (R02). |
| Nick Mullens, Joe Milton, Britain Covey, Michael Carter, Greg Dortch | 7–20 | Practice squad. |
| Cam Miller, Connor Bazelak | 13–14 | Waived. |

25 skill players projected at 4+ points are not on an active roster; the full
list is in the appendix.

### 2. Two week-1 starting quarterbacks are wrong, one team has no starter at all

| team | pool QB1 (wk1) | actual week-1 starter | source |
|---|---|---|---|
| ATL | Michael Penix Jr. 14.8 (Tua 16.1 as a 2-game backup) | **Cooper Rush** — Tua was named starter Sep 7, then ruled out Friday with an oblique injury; Penix is inactive. Rush is not in our pool. | [ESPN](https://www.espn.com/nfl/story/_/id/49905536/tagovailoa-rush-start-qb-falcons-vs-steelers), [NFL.com](https://www.nfl.com/news/falcons-tua-tagovailoa-starting-quarterback-week-1-steelers) |
| CLE | Shedeur Sanders 12.8 (Watson 10.7 as a 3-game backup) | **Deshaun Watson**, named Aug 24; "not a week-to-week decision". Sleeper: Watson 10.9, Sanders 0. | [NFL.com](https://www.nfl.com/news/browns-deshaun-watson-starting-qb-week-1-2026-season) |
| SEA | Sam Darnold 14.9 | Darnold left Wednesday's game on the first series (hip); Drew Lock, not in our pool, threw for 187 and a TD. Matters from week 2. | [ESPN](https://www.espn.com/nfl/story/_/id/49882128/2026-nfl-week-1-new-england-patriots-seattle-seahawks-drake-maye-sam-darnold) |

The nflverse depth chart of Sep 11 already lists Tua and Watson as QB1; the
pool's `depth` field comes from `depth-order-2026.json`, a model output last
regenerated Sep 7 that is not in any workflow.

### 3. The pool caps each team at 5 WR / 4 RB / 3 TE by that stale depth order, so late signings are missing entirely

Players who are on a roster, project for 8–10 Sleeper points, and have no
row anywhere in our data:

| player | team | Sleeper wk1 | note |
|---|---|---|---|
| Deebo Samuel Sr. | SF | 10.0 | Scored 18.0 on Thursday. Depth order ranks him SF WR6 behind two reserve-list players. |
| Stefon Diggs | WAS | 10.0 | |
| Cooper Rush | ATL | 9.8 | Week-1 starter (see above). |
| Devaughn Vele | NO | 9.7 | |
| Kayshon Boutte | HOU | 9.0 | |
| Darren Waller | CAR | 8.5 | |
| Keenan Allen | IND | 8.1 | |
| Demarcus Robinson | SF | — | Scored 13.0 on Thursday. |
| Drew Lock | SEA | — | Scored 12.8 on Wednesday. |

All are active on the Sep 11 roster. The builder's roster fill-in pass adds
them as candidates, but the per-team cut keeps the depth-order model's
top 5, and that model still ranks Pearsall (IR) and Kirk (reserve) above them.

### 4. Backups' conditional rates flood the top of the QB board

Twenty-four rows in the week-1 top 80 have gp ≤ 3. Their `wk` value is a
per-game rate from a 1–3 game season line (Justin Fields 44 pts / 2 games =
22.0 ppg, Nick Mullens 21 / 1), so any consumer that ranks on points without
`gp` sees Fields QB3, Trey Lance QB6, Mullens QB9, Rattler QB10, Milton QB12,
Flacco QB18 — all above Hurts, Allen, Burrow. Sleeper carries every one of
them at 0. The MCP header warns about this; the JSON does not.

### 5. `playedThrough` flips to 1 after the first game of the week

`weeks_played()` returns the highest week with any final score, so after two
of sixteen week-1 games `playedThrough = 1`. Consequences right now:

- `rosPts / rosGames / rosPPG` exclude week 1 for all 28 teams that have not
  played (a 17-game season is reported as 16 remaining).
- The def-vs-pos blend gives 2026 a 1/(1+6) = 14% weight on the strength of
  four team-games (the LA / SF / NE / SEA rows in `player_stats_2026`).

A week should count as played only once every scheduled game in it has a
score (or once the week's last kickoff is in the past).

### 6. Smaller items

- **Greg Dortch** is projected on DET (7.9); he is on BUF's practice squad.
  The April `rosterOverrides.ts` entry overrides the current nflverse team
  unconditionally, so an override is never allowed to expire. It is the only
  override that currently disagrees with the roster.
- **Luther Burden III** (CHI) is 3.4 in our pool vs Sleeper 13.1; the pool has
  Zavion Thomas as the CHI WR2 at 154 season points after the DJ Moore trade.
  Same stale-depth-order cause as item 3.
- **Chuba Hubbard / Jonathon Brooks** (CAR): ours 16.9 / 2.6, Sleeper 10.8 /
  9.9 — Sleeper expects a split; worth a look before the pool is trusted for
  CAR RBs.
- **Rhamondre Stevenson**: the MCP promotion logic worked as designed (+6.1
  for Henderson Out) but NE had already played when the file was built; his
  12.0 base vs Sleeper's 16.4 is the residual.
- **Jacoby Brissett** (ARI): ours 17.7 vs Sleeper 10.8 is the largest
  starter-level QB gap; the season line (18.7 ppg over 15 games) looks hot.
- Sleeper's projections tool returns 0 for every kicker and no DEF rows, so
  K/DST could not be checked externally this way.

## What the two played games say

35 matched rows: MAE 5.4, projected total 323 vs actual 226 (SEA 13, NE 10; a
low-scoring SF@LA). Nothing systematic can be read from two games, but the
largest misses were role errors rather than matchup errors: Deebo Samuel
(18.0, no row), Demarcus Robinson (13.0, no row), Drew Lock (12.8, no row),
Mike Evans 7.8 → 16.9, Stafford 17.3 → 4.1, Davante Adams 14.6 → 5.6.

## Recommended fixes, in order

1. **Read roster status in the weekly builder** (and/or the MCP week mode):
   zero the week for RES / EXE / CUT / RET / DEV, and let the existing
   promotion logic hand the production to the healthy teammates. The roster
   snapshot is already downloaded every run.
2. **Fix `weeks_played()`** to require all of a week's scheduled games to have
   scores (schedule-2026.json has the game list) before counting the week.
3. **Re-rank each team/position group by the current nflverse depth chart**
   (with reserve-list players dropped) before the per-team cut, instead of
   the hand-retrained depth-order file — or at minimum retrain that file in
   the refresh workflow. This fixes ATL/CLE QB1, brings in Deebo, Diggs,
   Rush, Vele, Boutte, Waller, Allen, and moves Burden up.
4. **Expected-value column** in the JSON (`wk × gp/17`, or a `backup` flag for
   gp ≤ 3) so ranking consumers stop surfacing 1-game backups.
5. Give `rosterOverrides.ts` entries an expiry or apply them only when the
   roster has no team for the player.
6. Re-pull the injury report Friday evening and Sunday morning during the
   season; the 12:21 UTC Friday snapshot predates Bowers' and Tua's
   designations.

## Fix status (2026-09-11, same day)

| # | fix | status |
|---|---|---|
| 1 | Roster status read by the weekly builder: RET/CUT rows dropped, RES/EXE/DEV/FA rows kept with `active=false`, `status`, and every week from `currentWeek` on zeroed | done — `scripts/build-weekly-projections.py` |
| 2 | `weeks_played()` counts a week only when every scheduled game is final; the def-vs-pos, K/DST and IDP in-season blends use only completed weeks | done |
| 3 | Pool ranks each team/position group by the newest nflverse depth chart ahead of the depth-order model; RET/CUT/EXE/DEV never enter the pool, RES sorts last | done — `src/lib/buildProjectionPool.ts`, `scripts/build-projection-pool.ts`. Local rebuild: Tua ATL QB1, Watson CLE QB1, Deebo/Diggs/Vele/Boutte/Burden/Allen/Waller/Lock now have rows |
| 4 | `backup=true` on 1–3 game lines for depth-2+ players; `depth` now comes from the nflverse chart first | done (JSON only — the MCP's week-mode sort is in a bundle whose source is not in the repo, see below) |
| 5 | `rosterOverrides.ts` entries expire on `ROSTER_OVERRIDES_2026_EXPIRES` (2026-09-01) | done |
| 6 | Injury report re-pull timing | not changed — `refresh-data.yml` already runs every two hours; Friday designations land in the 20:00/22:00 UTC runs |

Open follow-ups:

- **Pool-level redistribution.** Dropping Josh Jacobs hands GB's backfield to Chris Brooks (334 pts) via prior-usage shares, not to MarShawn Lloyd (31); RB/WR shares come from the ML share model or prior-year usage, so removing a player does not re-split the pie sensibly. The weekly MCP's promotion logic is the right shape; it belongs in the pool.
- **MCP week mode.** `get_weekly_projections` (and the K/DST/IDP/schedule-strength tools) exist only in the committed bundle `mcp/dist/server.mjs`; no branch has their source in `src/tools.ts`. Until that source is recovered the MCP cannot read the new `active`/`backup` fields or sort backups below starters.
- Sleeper's projection tool returns 0 for kickers and nothing for DEF, so K/DST still have no external check.

## Daily audit plan

Two layers, both in place after this change:

**1. Automatic, every refresh (every two hours, 12:00–04:00 UTC).**
`refresh-data.yml` now runs `scripts/validate-weekly-projections.py --week auto`
right after the weekly build and commits
`public/data/weekly-projections-audit.md` (the full report) and
`weekly-projections-audit.json` (counts). The daily report email gets a
"Weekly projection audit" card; three buckets count as incomplete surfaces
and turn the subject line red: a team mismatch, a non-active player still
carrying points, a depth-chart QB1 the pool disagrees with, or a player who
scored 5+ without a row. Undesignated DNPs and backups inside the top 24 show
as warnings only.

**2. A daily Claude session for the judgment calls.** A Routine spawns a
fresh session each morning after the 12:00 UTC refresh. It reads the audit
JSON, the injury report and the news for anyone flagged, and fixes what the
automation cannot decide on its own: a starter change the depth chart has not
caught up with, a stale override, a builder bug the audit exposes. It commits
to a dated branch and reports in the session; it does not touch the MCP
bundle. The prompt is in the Routine itself; edit it there.

What "fixed" looks like each day: the audit JSON has empty
`teamMismatches`, `inactiveWithPoints`, `qb1Disagreements` and
`scoredWithoutRow`, `playedThroughWrong` is false, and the daily report subject
is green.

## Appendix: script output

Run captured 2026-09-11 (headings demoted one level).

Generated from `weekly-projections-2026.json` built 2026-09-11T19:05:34+00:00 (season base 2026-09-11T19:05:13.965Z); playedThrough = 1.

### 1. Games played

2 of 16 week-1 games have stat lines: SF@LA, NE@SEA.

**playedThrough = 1 although 14 games are still to be played** — rest-of-season figures (rosPts / rosGames / rosPPG) exclude week 1 for every player, and the def-vs-pos blend is already weighting 2 game(s) as a full week.

### 2. Team mismatches (projection vs nflverse roster)

| player | pos | projected team | roster team | status | wk1 |
|---|---|---|---|---|---|
| Greg Dortch | WR | DET | BUF | DEV | 7.85 |

### 3. Projected ≥ 4 pts but not on the active roster

RES = reserve (IR/PUP/NFI), EXE = commissioner exempt, DEV = practice squad, CUT = waived, RET = retired, INA = inactive for a game already played.

| player | pos | team | status | code | wk1 | gp |
|---|---|---|---|---|---|---|
| Nick Mullens | QB | JAX | DEV | P07 | 20.11 | 1 |
| Joe Milton III | QB | DAL | DEV | P06 | 19.56 | 1 |
| Teddy Bridgewater | QB | DET | RET | R02 | 18.03 | 1 |
| Jalen Milroe | QB | SEA | INA | A01 | 17.73 | 1 |
| Josh Jacobs | RB | GB | EXE | E02 | 16.81 | 15 |
| Ty Simpson | QB | LA | INA | A01 | 16.7 | 1 |
| Behren Morton | QB | NE | INA | A01 | 16.53 | 1 |
| Cam Miller | QB | MIA | CUT | W03 | 14.33 | 3 |
| Connor Bazelak | QB | TB | CUT | W03 | 13.14 | 1 |
| TreVeyon Henderson | RB | NE | INA | A01 | 12.82 | 17 |
| Jordyn Tyson | WR | NO | RES | R48 | 10.82 | 14 |
| Britain Covey | WR | PHI | DEV | P07 | 8.57 | 10 |
| Jayden Higgins | WR | HOU | RES | R01 | 8.39 | 17 |
| Greg Dortch | WR | DET | DEV | P07 | 7.85 | 14 |
| Ricky Pearsall | WR | SF | RES | R01 | 7.78 | 12 |
| Isiah Pacheco | RB | DET | RES | R01 | 7.66 | 14 |
| Tory Horton | WR | SEA | INA | A01 | 7.54 | 11 |
| Michael Carter | RB | TEN | DEV | P07 | 7.1 | 14 |
| Zach Charbonnet | RB | SEA | RES | R04 | 7.03 | 16 |
| Devin Neal | RB | NO | RES | R01 | 5.84 | 12 |
| Tank Dell | WR | HOU | RES | R48 | 5.46 | 14 |
| James Conner | RB | ARI | RES | R48 | 4.66 | 8 |
| Max Klare | TE | LA | INA | A01 | 4.6 | 14 |
| Trevor Etienne | RB | CAR | RES | R48 | 4.32 | 17 |
| Chris Brazzell II | WR | CAR | RES | R01 | 4.09 | 14 |

### 4. Week 1 injury report (designated, or DNP without a designation yet)

| player | pos | team | status | practice | injury | wk1 |
|---|---|---|---|---|---|---|
| Tyson Bagent | QB | CHI | (no designation yet) | Did Not Participate In Practice | Back | 17.38 |
| Brock Bowers | TE | LV | (no designation yet) | Did Not Participate In Practice | Knee | 15.35 |
| TreVeyon Henderson | RB | NE | Out | Did Not Participate In Practice | Ankle | 12.82 |
| Tory Horton | WR | SEA | Questionable | Limited Participation in Practice | Hamstring | 7.54 |
| Oscar Delp | TE | NO | (no designation yet) | Did Not Participate In Practice | Hamstring | 5.88 |
| Ty Johnson | RB | BUF | (no designation yet) | Did Not Participate In Practice | Hamstring | 4.87 |

### 5. Depth-chart QB1 disagrees with the pool (depth charts as of 2026-09-11T12:21:50Z)

| team | depth-chart QB1 | pool QB1 | wk1 | gp |
|---|---|---|---|---|
| ATL | Tua Tagovailoa | Michael Penix Jr. | 14.75 | 15 |
| CLE | Deshaun Watson | Shedeur Sanders | 12.76 | 14 |

### 6. Backups (gp ≤ 3) inside the top 24 at their position

Their weekly points are a per-game rate conditional on playing, computed from a 1–3 game season line; any ranking that ignores gp puts them above starters.

| pos | rank | player | team | wk1 | gp | depth |
|---|---|---|---|---|---|---|
| QB | 1 | Justin Fields | KC | 20.91 | 2 | 2 |
| QB | 3 | Trey Lance | LAC | 20.62 | 1 | 2 |
| QB | 5 | Nick Mullens | JAX | 20.11 | 1 | 2 |
| QB | 6 | Spencer Rattler | NO | 19.91 | 2 | 2 |
| QB | 7 | Joe Milton III | DAL | 19.56 | 1 | 2 |
| QB | 9 | Joe Flacco | CIN | 19.04 | 3 | 2 |
| QB | 15 | Teddy Bridgewater | DET | 18.03 | 1 | 2 |
| QB | 16 | Mason Rudolph | PIT | 17.92 | 1 | 2 |
| QB | 17 | Jameis Winston | NYG | 17.88 | 2 | 2 |
| QB | 18 | Jalen Milroe | SEA | 17.73 | 1 | 2 |
| QB | 24 | Tyson Bagent | CHI | 17.38 | 1 | 2 |

### 7. Sleeper comparison

### Sleeper ≥ 8 pts, absent from our pool

| player | pos | team | sleeper |
|---|---|---|---|
| Stefon Diggs | WR | WAS | 10 |
| Deebo Samuel | WR | SF | 10 |
| Cooper Rush | QB | ATL | 9.8 |
| Devaughn Vele | WR | NO | 9.7 |
| Kayshon Boutte | WR | HOU | 9 |
| Darren Waller | TE | CAR | 8.5 |
| Keenan Allen | WR | IND | 8.1 |

### QB: we are higher than Sleeper

| player | team | ours | sleeper | diff | gp | depth |
|---|---|---|---|---|---|---|
| Nick Mullens | JAX | 20.11 | 0 | +20.1 | 1 | 2 |
| Mason Rudolph | PIT | 17.92 | 0 | +17.9 | 1 | 2 |
| Jalen Milroe | SEA | 17.73 | 0 | +17.7 | 1 | 2 |
| Tyson Bagent | CHI | 17.38 | 0 | +17.4 | 1 | 2 |
| Mac Jones | SF | 17.31 | 0 | +17.3 | 2 | 2 |
| Marcus Mariota | WAS | 16.36 | 0 | +16.4 | 3 | 2 |
| Jacoby Brissett | ARI | 17.68 | 10.8 | +6.9 | 15 | 1 |
| Daniel Jones | IND | 17.59 | 13.4 | +4.2 | 14 | 1 |

### QB: Sleeper is higher than us

| player | team | ours | sleeper | diff | gp | depth |
|---|---|---|---|---|---|---|
| Lamar Jackson | BAL | 16.2 | 19.3 | -3.1 | 14 | 1 |

### RB: we are higher than Sleeper

| player | team | ours | sleeper | diff | gp | depth |
|---|---|---|---|---|---|---|
| Josh Jacobs | GB | 16.81 | 0 | +16.8 | 15 | 1 |
| Zach Charbonnet | SEA | 7.03 | 0 | +7.0 | 16 | 1 |
| Chuba Hubbard | CAR | 16.86 | 10.8 | +6.1 | 15 | 1 |
| Justice Hill | BAL | 10.75 | 5.1 | +5.7 | 12 | 3 |
| Jonathan Taylor | IND | 24.63 | 19 | +5.6 | 17 | 1 |
| Sean Tucker | TB | 6.14 | 0.7 | +5.4 | 17 | 3 |
| Tyrone Tracy Jr. | NYG | 9.81 | 4.5 | +5.3 | 15 | 2 |
| Kimani Vidal | LAC | 6.22 | 1.4 | +4.8 | 14 | 3 |

### RB: Sleeper is higher than us

| player | team | ours | sleeper | diff | gp | depth |
|---|---|---|---|---|---|---|
| Jonathon Brooks | CAR | 2.55 | 9.9 | -7.4 | 14 | 3 |
| MarShawn Lloyd | GB | 2.23 | 9.5 | -7.3 | 14 | 3 |
| Rhamondre Stevenson | NE | 12.03 | 16.4 | -4.4 | 15 | 1 |
| Mike Washington Jr. | LV | 2.6 | 6.5 | -3.9 | 14 | 2 |

### WR: we are higher than Sleeper

| player | team | ours | sleeper | diff | gp | depth |
|---|---|---|---|---|---|---|
| Brenen Thompson | LAC | 10.86 | 1.3 | +9.6 | 14 | 3 |
| Darius Slayton | NYG | 7.93 | 0 | +7.9 | 15 | 3 |
| Greg Dortch | DET | 7.85 | 0 | +7.8 | 14 | 3 |
| Zavion Thomas | CHI | 10.65 | 3.1 | +7.6 | 14 | 2 |
| Marvin Mims Jr. | DEN | 11.14 | 4.3 | +6.8 | 15 | 3 |
| Kyle Williams | NE | 6.53 | 0.4 | +6.1 | 15 | 5 |
| Tank Dell | HOU | 5.46 | 0 | +5.5 | 14 | 5 |
| Nikko Remigio | KC | 5.26 | 0.1 | +5.2 | 15 | 3 |

### WR: Sleeper is higher than us

| player | team | ours | sleeper | diff | gp | depth |
|---|---|---|---|---|---|---|
| Luther Burden III | CHI | 3.42 | 13.1 | -9.7 | 15 | 3 |
| Malachi Fields | NYG | 2.12 | 7.6 | -5.5 | 14 | 4 |
| Mike Evans | SF | 7.84 | 12.7 | -4.9 | 14 | 1 |
| Tre Harris | LAC | 1.13 | 5.9 | -4.8 | 16 | 4 |
| Jayden Reed | GB | 7.55 | 12 | -4.5 | 9 | 3 |
| Ja'Kobi Lane | BAL | 1.11 | 5.1 | -4.0 | 14 | 4 |
| Kendrick Bourne | ARI | 0.6 | 4.4 | -3.8 | 15 | 4 |
| Chris Godwin Jr. | TB | 8.31 | 11.7 | -3.4 | 12 | 2 |

### TE: we are higher than Sleeper

| player | team | ours | sleeper | diff | gp | depth |
|---|---|---|---|---|---|---|
| Brock Bowers | LV | 15.35 | 0 | +15.3 | 15 | 1 |
| Oronde Gadsden II | LAC | 11.61 | 4.8 | +6.8 | 15 | 1 |
| Sam Roush | CHI | 8.16 | 1.9 | +6.3 | 14 | 2 |
| Oscar Delp | NO | 5.88 | 0 | +5.9 | 14 | 2 |
| Max Klare | LA | 4.6 | 0 | +4.6 | 14 | 2 |
| Colby Parkinson | LA | 9.41 | 5.5 | +3.9 | 15 | 1 |
| Jake Tonges | SF | 5.75 | 2.2 | +3.5 | 12 | 2 |
| Evan Engram | DEN | 7.2 | 3.8 | +3.4 | 16 | 1 |

### TE: Sleeper is higher than us

| player | team | ours | sleeper | diff | gp | depth |
|---|---|---|---|---|---|---|
| Daniel Bellinger | TEN | 0.5 | 5.1 | -4.6 | 14 | 3 |
| Juwan Johnson | NO | 6.65 | 10.4 | -3.8 | 17 | 1 |
| Will Kacmarek | MIA | 0.78 | 3.9 | -3.1 | 14 | 2 |
| Cole Kmet | CHI | 1.3 | 4.4 | -3.1 | 16 | 3 |

### Agreement on regular starters (gp ≥ 10, Sleeper ≥ 5)

| pos | n | r | mean ours | mean sleeper | MAE |
|---|---|---|---|---|---|
| QB | 30 | 0.51 | 17.1 | 16.5 | 1.6 |
| RB | 54 | 0.85 | 12.7 | 11.6 | 2.2 |
| WR | 76 | 0.83 | 10.7 | 11.1 | 1.8 |
| TE | 30 | 0.72 | 9.4 | 9.3 | 1.6 |

### 8. Teams already played: projection vs actual PPR

| player | pos | team | projected | actual | gp |
|---|---|---|---|---|---|
| Jaxon Smith-Njigba | WR | SEA | 16.64 | 26.2 | 17 |
| Brock Purdy | QB | SF | 15.22 | 21.1 | 15 |
| Deebo Samuel Sr. | WR | SF |  | 18.0 |  |
| Mike Evans | WR | SF | 7.84 | 16.9 | 14 |
| Kyren Williams | RB | LA | 16.04 | 15.5 | 17 |
| Rhamondre Stevenson | RB | NE | 12.03 | 14.5 | 15 |
| Christian McCaffrey | RB | SF | 20.61 | 13.8 | 17 |
| Demarcus Robinson | WR | SF |  | 13.0 |  |
| Drew Lock | QB | SEA |  | 12.8 |  |
| Puka Nacua | WR | LA | 19.75 | 12.4 | 16 |
| Drake Maye | QB | NE | 18.14 | 9.8 | 16 |
| Mack Hollins | WR | NE | 3.78 | 9.1 | 15 |
| Kaelon Black | RB | SF | 4.99 | 8.0 | 14 |
| Jadarian Price | RB | SEA | 11.69 | 7.8 | 14 |
| Eli Raridon | TE | NE | 1.66 | 7.2 | 14 |
| DeMario Douglas | WR | NE | 7.03 | 7.0 | 16 |
| Davante Adams | WR | LA | 14.62 | 5.6 | 15 |
| Hunter Henry | TE | NE | 11.21 | 5.6 | 17 |
| A.J. Brown | WR | NE | 14.21 | 5.6 | 15 |
| Cooper Kupp | WR | SEA | 7.62 | 5.5 | 16 |
| Blake Corum | RB | LA | 10.57 | 5.4 | 17 |
| Matthew Stafford | QB | LA | 17.31 | 4.1 | 16 |
| Brady Russell | RB | SEA |  | 4.0 |  |
| Luke Farrell | TE | SF | 1.05 | 3.9 | 14 |
| Ronnie Rivers | RB | LA | 0.31 | 3.4 | 10 |
| AJ Barner | TE | SEA | 9.16 | 3.3 | 17 |
| George Kittle | TE | SF | 10.67 | 3.2 | 15 |
| George Holani | RB | SEA | 6.07 | 2.9 | 12 |
| Colby Parkinson | TE | LA | 9.41 | 1.6 | 15 |
| Rashid Shaheed | WR | SEA | 9.17 | 1.4 | 17 |
| Sam Darnold | QB | SEA | 14.9 | 0.5 | 16 |
| Romeo Doubs | WR | NE | 9.2 | 0.0 | 16 |
| Kyle Williams | WR | NE | 6.53 | 0.0 | 15 |


35 matched rows: MAE 5.4, projected total 323 vs actual 226.

Scored ≥ 5 with no projection row: Deebo Samuel Sr. (SF WR, 18.0), Demarcus Robinson (SF WR, 13.0), Drew Lock (SEA QB, 12.8).

