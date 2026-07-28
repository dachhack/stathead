# StatHead MCP: feedback & to-dos

Issues and enhancement ideas surfaced while using the MCP tools for a real
analysis (the 2026 A.J. Brown PHI→NE trade: projections, share model, ADP,
bust risk vs. draft range). Ordered by severity. Each entry: **what we saw**,
*why it matters*, *likely root cause / fix*, *rough effort*.

Severity legend: 🔴 correctness (wrong numbers reach the user) · 🟠 broken tool
· 🟡 model/feature gap · 🟢 polish/DX.

---

## ✅ Session update (2026-07-28, branch `claude/projections-rankings-updates-qcx49r`)

App-team feedback round on `get_weekly_projections` / projections surface
(7 items). Shipped now vs. deferred:

**Round 22 — weekly-projections feedback fixes (MCP 1.0.63):**
- 🟢 **Staleness metadata**: every `get_weekly_projections` /
  `get_projections` response now carries `as_of` (weekly build timestamp +
  season-base build timestamp; the weekly file also commits
  `baseGeneratedAt`). Consumers can detect staleness programmatically.
- 🔴 **Injury-aware weekly numbers**: `get_weekly_projections` week mode now
  joins the latest nflverse weekly designations (same feed as
  `get_injuries`): Out/IR → 0, Doubtful ×0.25, Questionable flagged, all via
  a new `availability` column + header note. Applied only when the requested
  week ≥ the report week (no retroactive rewrites); strip mode flags the
  designation without discounting. Offseason → graceful "no report yet".
- 🟢 **Silent caps removed**: `get_weekly_projections` / `get_projections` /
  `get_sleeper_projections` limits raised 300/300/200 → 1000, and every
  truncation now says "showing top N of M — raise limit".
- 🟡 **Stable IDs**: weekly builder stamps `gsis` + `sleeper` per player from
  the crosswalk (441+443/445 coverage; null for pre-NFL rookies).
  `get_weekly_projections` and `get_projections` rows carry
  `gsis_id`/`sleeper_id` (select via `fields`); the Python loader exposes
  them as columns. Known name-drift pairs (Omar Cooper Jr., Chris Rodriguez
  Jr.) resolve via crosswalk `all_names`.
- 🟠 **`get_sleeper_projections` `fields` bug**: fixed — the case
  pre-projected rows onto a fixed column list, so `fields` couldn't reach
  raw Sleeper keys (and `fantasy_points_ppr` isn't a Sleeper key at all;
  points are `pts_ppr`/`pts_half_ppr`/`pts_std`, now documented in the
  response header). Full rows now pass through, so any raw Sleeper stat key
  is selectable. Same fix applied to both projection tools (`fields` outside
  the default columns previously fell back silently).
- 🟡 **Current-season defense blend**: the weekly builder now blends
  current-season def-vs-pos ratios over the prior season at weight
  n/(n+6) as REG weeks accumulate (auto-activates in-season; the data-file
  note reports the active blend).

**Deferred (open, in priority order):**
- 🟡 **In-season season-base re-fit.** The weekly layer inherits the season
  pool; the pool rebuilds daily but its veteran blend is a preseason recipe
  (prior-year actuals + age curve). A benched/traded player keeps his summer
  number all season. Plan: an in-season variant that re-fits games/roles
  from accumulating weekly actuals (biweekly would do). Until then, `as_of`
  makes the staleness visible.
- 🟡 **Vegas game-environment multipliers.** Replace the flat ±2% home/away
  nudge with implied team totals from game lines (the season model already
  consumes Vegas win%; `fetchOddsGameLines` exists). Only available for the
  upcoming week in-season — needs a "Vegas overlay for week N, schedule
  baseline beyond" design.
- 🟡 **Uncertainty bands.** Expose p10/p90 or a confidence field per
  projection row. The ADP model already ships `ciLower`/`ciUpper`; share
  models are noisy at depth (TE R² ≈ 0.19) — surface that instead of hiding
  it. Pairs with lifting depth coverage beyond the ~445-player pool
  (roster-dealing/DFS wants ~500–600 with low-confidence flags).
- 🟢 **`tools/list_changed` notification.** New tools don't appear in
  long-lived MCP sessions until reconnect. The stdio server's toolset is
  static per process (fine), but the remote Worker serves a stateless
  toolset per request — the gap is client-side caching of `tools/list`.
  Investigate emitting the notification from the SDK server on version
  change; document "reconnect after server upgrades" meanwhile.

---

## ✅ Session update (2026-06-16, branch `claude/gallant-noether-lyddkb`)

Shipped + corrected diagnoses. **Two original root-cause guesses were wrong**
(documented inline below).

**Round 21 — IDP fantasy events + slim hosted id-map (MCP 1.0.61):**
- 🟡 **`get_fantasy_pbp` per-defender IDP events** (opt-in `idp=true`, default
  off): `{kind: tackle (tackle_type solo|assist) | tfl | sack (sack=1/0.5) |
  qb_hit | int | pd | ff | fr | def_td}`, each keyed to the defender's gsis,
  team=defteam. Filter to a roster with player_ids. No regen (1.0.60 artifacts
  already carry the columns).
- 🟢 **Slim hosted id-map** `public/data/player-id-map.json` (new
  `scripts/build-id-map.mjs`): 12,267 players, 1.76 MB (vs Sleeper's ~5 MB),
  compact `{gsis, sleeper, espn, name, pos, team, headshot}` — replaces the
  client-side Sleeper directory download for runtime id mapping. Fetch directly
  from the hosted data base. Exported `fetchRosters` from the bundle for the
  builder.

**Round 20 — per-defender IDP attribution in PBP (MCP 1.0.60):**
- 🔴 **IDP unblocked.** Added the standard nflverse per-defender id columns to
  `PBP_SLIM_COLS` (project via fields, all gsis/crosswalkable): solo_tackle_1/2,
  assist_tackle_1..4, tackle_for_loss_1/2, sack_player_id, half_sack_1/2,
  qb_hit_1/2, interception_player_id, pass_defense_1/2, forced_fumble_player_2
  (forced_fumble_1 + fumble_recovery_1 already added in R19; defensive/ST TD
  scorer = td_player_id with td_team=defteam). All 2016–2025 artifacts
  regenerated (~3.8 MB gz, under cap).
- The crosswalk already covers the IDP universe (5,773 defensive players: LB/DB/
  DL/CB/S…); espn_id + headshot resolve for defenders via the R19 roster
  fallback (verified: tackler 00-0034780 → Isaac Yiadom DB w/ headshot).
- Verified 2025 wk1: sack/QB-hit/TFL credited to the defender, INT vs
  pass-defense to distinct players.

**Round 19 — Drip League batch: headshots for rookies, fair_catch + exact fumble
attribution, kickoff schedule (MCP 1.0.59):**
- 🟢 **get_player_crosswalk headshots for fresh rookies.** espn_id genuinely
  lags for unindexed in-season rookies (nflverse rosters also null them), so a
  new `headshot` field falls back to the roster `headshot_url` (NFL.com) when no
  espn_id — apps can source photos from Stathead alone. espn_id + sleeper_id are
  also backfilled from the season rosters when the static crosswalk lags;
  `espn_headshot` stays ESPN-specific.
- 🟡 **PBP fair_catch + exact fumble attribution.** Added a derived `fair_catch`
  (punt||kickoff) plus `fumble_recovery_1_player_id`/`_name` and
  `forced_fumble_player_1_player_id`/`_name` to `PBP_SLIM_COLS`
  (`fumbled_1_player_id` was already there) — resolves multi-player fumbles. All
  2016–2025 artifacts regenerated. (return_yards + kickoff/punt_returner ids
  were already projectable since 1.0.51.)
- 🟢 **get_games kickoff schedule.** Added `gameday`/`weekday`/`gametime` (ET
  kickoff) to the default output — derive day/time windows and byes (a team
  absent from a week is on bye) from Stathead.
- Payload ergonomics (#5) already shipped earlier: game_id filter (1.0.47),
  offset cursor (1.0.49), raised caps to whole-week/season (1.0.58),
  jsonl/csv + fields projection.

**Round 18 — allow whole-week / whole-season PBP in one call (MCP 1.0.58):**
- 🟢 Raised the row caps so a full week or whole season comes back in a single
  call (the 1000 cap was forcing offset loops). `get_play_by_play` max
  1000→60000 (week ~2.4k, season ~43k); `get_fantasy_pbp` max 5000→80000
  (season ~62k events). Defaults unchanged (50 / 5000). Guidance added to the
  tool descriptions: use output_format=jsonl/csv (+ fields) for large pulls;
  offset cursor still available for chunking. Verified 2025: week=1 → 2357
  plays, whole season → 42,584 plays, fantasy whole season → 61,464 events,
  all complete.

**Round 17 — stable player-id keys across the joinable tools (MCP 1.0.56–1.0.57):**
- 1.0.56: added `play_id` to `get_fantasy_pbp` events (traceable to the
  `get_play_by_play` source row; not unique within the fantasy log since one
  play fans out to multiple events).
- 1.0.57: surfaced the stable id in the default output of every joinable tool
  that was emitting name-only rows — gsis where the source carries it
  (`get_player_weekly_stats` `player_id`, `get_rosters` `gsis_id`,
  `get_next_gen_stats` `player_gsis_id`, `get_depth_charts` `gsis_id`,
  `get_player_metrics` `player_id`), and the native stable id where gsis isn't
  in-source (`get_snap_counts` `pfr_player_id`, `get_combine_results`
  `pfr_id`/`cfb_id` — both crosswalkable). `get_rosters`/`get_snap_counts`/
  `get_depth_charts` also widened to full `fields` projection (rosters exposes
  espn/pfr/sleeper/esb ids). Handler-only, no regen.

**Round 16 — real (wall-clock) timestamps on PBP (MCP 1.0.55):**
- 🟢 Added `game_date`, `start_time` (kickoff), and `time_of_day` (the real UTC
  instant a play was run — vs the game-clock `time`) to `PBP_SLIM_COLS`;
  projectable on `get_play_by_play`. `time_of_day` is a full ISO UTC timestamp
  (e.g. `2025-09-07T17:02:38.787Z`), monotonic per play. `get_fantasy_pbp`
  events now carry `game_date` + `time_of_day` for true chronological ordering.
  All 2016–2025 artifacts regenerated; coverage reported per season (2025 =
  100%).

**Round 15 — 2-point conversions in player stats (MCP 1.0.54):**
- 🟢 2pt conversions were already in PBP (`two_point_attempt`,
  `two_point_conv_result`) and `get_fantasy_pbp` (`two_point` flag +
  `two_point_result` on offensive events). The gap was the player stats tools:
  the season aggregation computed `passing/rushing/receiving_2pt_conversions`
  but the handlers dropped them. Now in the default output of
  `get_player_season_stats` + `get_player_weekly_stats`, and both tools widen to
  full-column `fields` projection (also reaches fumbles_lost splits,
  special_teams_tds, and any raw nflverse weekly column). Handler-only, no regen.

**Round 14 — per-player committed turnovers (INT thrown / fumble lost) (MCP 1.0.53):**
- 🟡 **Turnovers now attributed to the committing offensive player**, not just
  the defense. `get_fantasy_pbp` emits `{kind: int_thrown, turnover: 1}` (to the
  passer) and `{kind: fumble_lost, turnover: 1}` (to the ball carrier who lost
  it). The team-defense takeaway events are unchanged — these are the offense
  side of the same play.
- `get_play_by_play` exposes the attribution columns: `interception` (+ the
  existing `passer_player_id` = who threw it) and `fumble_lost` (+ new
  `fumbled_1_player_id` / `fumbled_1_player_name` / `fumbled_1_team` = who lost
  it). Added to `PBP_SLIM_COLS`; all 2016–2025 artifacts regenerated. The
  fumbler id also feeds the `player_ids` filter.
- Verified 2025 wk1: 16 int_thrown (B.Young CAR → his gsis) + 14 fumble_lost
  (D.Henry BAL → his gsis).

**Round 13 — enrich get_injuries: gsis_id, secondary/practice detail, roster
filter (MCP 1.0.52):**
- 🟢 Weekly nflverse injury reports already existed; exposed the dropped
  `gsis_id` (join key) plus `report_secondary_injury`,
  `practice_primary_injury`, `practice_secondary_injury`, and added a
  `player_ids` (gsis) roster filter. Handler-only, no regen.

**Round 12 — kick/punt return yardage + returner columns (MCP 1.0.51):**
- 🟡 **`get_play_by_play` now exposes return detail** (was silently dropped —
  only `return_touchdown` worked). Added to `PBP_SLIM_COLS` (all 2016–2025
  artifacts regenerated): `return_yards`, `return_team`,
  `kickoff_returner_player_id`/`_name`, `punt_returner_player_id`/`_name`.
  (Note: the requester's `kick_returner_*` names were actually
  `kickoff_returner_*` in nflverse.) `yards_gained` reads 0 on return plays, so
  `return_yards` is the one to use.
- Returner gsis ids now also feed the `player_ids` filter, so a roster pull
  picks up its players' return plays.
- 🟡 **`get_fantasy_pbp` emits return events** `{kind: kr|pr, yards, td}`
  attributed to the returner (gsis). Return TDs continue to also count as ST
  TDs in the team-defense `def_td`.
- Verified on 2025 wk1: punt returns project (R.Shaheed 7 yds, NO), fantasy log
  emits 118 KR + 85 PR events (G.Dortch KR 22 yds), returner ids crosswalkable.

**Round 11 — espn_headshot URL on get_player_crosswalk (MCP 1.0.50):**
- 🟢 Derived a ready-to-use ESPN headshot URL from `espn_id`
  (`https://a.espncdn.com/i/headshots/nfl/players/full/<espn_id>.png`) so apps
  can surface player photos. Computed in the handler (no data regen); omitted
  when a player has no `espn_id`. URL verified 200 image/png.

**Round 10 — bulk PBP extraction: player_ids/team-list filter, cursor, + a
fantasy play-log endpoint (MCP 1.0.49):**
- 🟢 **`get_play_by_play` player/team bulk filter (highest leverage).** New
  `player_ids` param (comma-separated gsis; matches if the id is the passer,
  rusher, receiver, kicker, or TD scorer on the play) and `team` now accepts a
  comma-separated list. Returning only relevant plays shrinks payloads ~5–10×,
  killing the token-cap auto-save and proxy rejections on bulk pulls. One
  week of a roster now fits in a single call.
- 🟢 **Cursor pagination + raised cap.** Added `offset` (the result header
  reports the next offset when more rows remain) and bumped the row cap
  250→1000. A season is now ~14 calls instead of ~203.
- 🟡 **New `get_fantasy_pbp` tool (the "build-anyway" version).** Week-level,
  gsis-attributed, fantasy-shaped event log so consumers need neither the
  crosswalk nor a client-side play reducer. Offensive events
  `{kind: pass|rush|rec|incomplete, yards, td, is_reception, is_target,
  two_point}`, kicker `{kind: fg|xp, distance, result, made}`, team-defense
  `{kind: def, sack, interception, fumble_recovered, def_td, safety}` + a
  `points_allowed` summary per team-game. `player_ids` scopes offense/kicker
  events and auto-scopes team-defense to those players' teams.
- Plumbing: added typed columns to `PBP_SLIM_COLS` (`complete_pass`,
  `passing_yards`/`rushing_yards`/`receiving_yards`,
  `pass_touchdown`/`rush_touchdown`) so the fantasy log is exact, not
  heuristic; all 2016–2025 artifacts regenerated (~2.7 MB gz each, under cap).
- Verified on 2025: Allen wk1 player-filter (64 plays, all involve him),
  offset paging headers, and `get_fantasy_pbp` for DAL@PHI — Hurts 152 pass
  yds (matches official), points_allowed PHI 20 / DAL 24 (matches 24-20
  final), FG/XP/def/reception events all resolve; roster-scoped pull correctly
  limited to BUF.

**Round 9 — kicker + defense/ST PBP columns for K & DST scoring (MCP 1.0.48):**
- 🟡 **`get_play_by_play` now exposes kicker/defense/special-teams columns via
  `fields`.** Root cause was twofold: the slim artifact only stored 28 columns
  *and* the handler pre-stripped to a fixed curated set *before* `fields` was
  applied, so projecting K/DST columns came back absent. Fixed both — the
  default view stays lean, but `fields` can now project any slim column.
- New selectable columns (added to `PBP_SLIM_COLS`, all 2016–2025 artifacts
  regenerated): **kicker** — `kicker_player_id`, `kicker_player_name`,
  `kick_distance`, `extra_point_result`; **defense/turnovers** — `sack`,
  `interception`, `fumble`, `fumble_lost`, `fumble_recovery_1_team`, `safety`;
  **TD attribution** — `td_player_id`, `td_team`, `return_touchdown` (separates
  defensive/ST TDs from offensive — previously a pick-6 was indistinguishable
  from an offensive TD); **two-point** — `two_point_attempt`,
  `two_point_conv_result`.
- Verified on 2025_01_DAL_PHI: FGs (B.Aubrey 41/53 made w/ `kick_distance`),
  TD attribution (`td_team`/`td_player_id`), sacks, fumbles all resolve.
  Artifact size grew ~2.37→2.53 MB gz (well under the 25 MiB cap). Note: when
  projecting with `fields`, callers should include `game_id`/`play_id`/
  `posteam`/`defteam` themselves if needed for joins (PBP has no auto-kept
  identifier columns).

**Round 8 — game-sim joinability: game_id filter, game_id in get_games, stable
PBP player IDs + crosswalk tool (MCP 1.0.47):**
- 🟡 **`get_play_by_play` now filters by `game_id`.** One full game per call
  (~130–170 plays) — the way to page a whole season: list games (now emit
  `game_id`) and fetch one id at a time. Row cap bumped 200→250 so an OT game
  can't truncate.
- 🟡 **`get_games` now emits the canonical `game_id`** (e.g. `2024_04_BUF_BAL`) —
  no more fragile `{season}_{week}_{away}_{home}` reconstruction for
  neutral-site/relocated games.
- 🟡 **Stable player IDs on PBP rows.** Added `passer_player_id`,
  `rusher_player_id`, `receiver_player_id` (nflverse gsis_id) alongside the
  abbreviated names — disambiguates surname collisions and joins cleanly to
  name-keyed endpoints. Added to `PBP_SLIM_COLS`; all pbp-slim artifacts
  (2016–2025) regenerated (new `scripts/build-pbp-slim.mjs`, pbp-only so it
  doesn't perturb team/player-metrics artifacts).
- 🟡 **New `get_player_crosswalk` tool.** Maps a stable id (gsis/pfr/sleeper/espn)
  → canonical full name + every cross-source id (pfr/sleeper/espn/pff/yahoo/
  sportradar/esb) + position/college/birth/active-season span. Backed by the
  existing `player-crosswalk.json` (12,267 players). Filter by `player_id`,
  `player_name`, `position`, or active `season`.

**Round 7 — coach scheme features INTO the share model (retrain):**
- 🟡 **Model-integration half of the coaching gap — done.** Added 4 leakage-safe
  head-coach scheme features (`coachHistNeutralPass`, `coachHistTargetHHI`,
  `coachHistWR1Share`, `newCoachFlag`; coach history < season) to the share
  model. Measured first: LOSO target-share R² lift WR 0.319→0.327, RB
  0.346→0.351, **TE 0.132→0.190** (TE usage is the most scheme-dependent). The
  reunion features were dropped — they rank near-bottom (redundant with
  `priorTargetShare`).
- Plumbing: `backfill_coach_share_features.py` patches the training cache;
  `SHARE_FEATURE_KEYS` += the 4; share models retrained
  (`model-cache-share-v58.json`); `precompute-features.ts` computes the same 4 for
  2026 pred rows (219/258) so scoring matches training; feature-matrix + shares +
  model-eval regenerated. No Worker redeploy needed (data read live).
- Honest note: the headline Brown case barely moved (0.158→0.16) — WR coach
  signal is marginal and prior usage dominates; the real model win is TE + new-
  coach situations. sklearn/lightgbm were pip-installed to enable the retrain.

**Round 6 — coaching tendencies + coach×player reunion (MCP 1.0.44):**
- 🟡 **Coaching/scheme data gap (the largest model gap) — data+tool half shipped.**
  New `get_coach_tendencies` tool + `coach-tendencies.json` artifact: per head
  coach (career + last-3 avg) neutral pass rate, pace, shotgun, RZ TD rate, PPG,
  target HHI (concentration), WR1/RB/TE target share, plus a coach×player
  **reunion** lookup (a player's target share / PPG / games under a coach). Built
  from the team-metrics artifacts (backfilled 2016–2025) + nflverse game coaches
  + player target shares — no PBP at serve time, no retrain. Resolves by coach
  name, team+season (incl. the upcoming season), or player.
- Verified the motivating case: Vrabel career 51.6% neutral pass / 23% WR1 share
  / HHI 0.13; A.J. Brown under Vrabel (TEN 2019–21) ran **20% / 22.9% / 20.9%**
  target share — i.e. ~21%, refining the report's ~25% hand-estimate.
- **Still deferred (needs ML session):** feeding these coach features INTO the
  trained share model (sklearn retrain) — this round ships the descriptive
  data/tool, not the model integration.

**Round 5 — calibrated veteran Hit/Bust vs ADP (MCP 1.0.43):**
- 🔴/🟡 **VOR label was uninformative + no veteran bust probability — fixed.** Root
  cause: the absolute VOR threshold is calibrated against the whole historical
  population, so 100% of the DRAFTABLE pool clears "hit" (even after z-scoring) —
  it can't discriminate. Replaced with a **calibrated Hit/Bust % relative to
  draft cost**: per-position historical base rates (ground-truth isHit/isBust by
  ADP from the training cache) tilted by the model's value-vs-ADP lean, computed
  at the **live consensus ADP** at serve time (also fixes the stale-ADP-on-card
  concern). build-model-eval emits a per-position base-rate curve (`hitBustCalib`)
  + per-player `calibLean`; get_player_features interpolates at the live ADP.
- Verified: A.J. Brown (live ADP 22.8) Hit 27% / Bust 9% (value lean); Cooper
  Kupp (235.8) Hit 8% / Bust 65% (elevated bust risk); Bijan (1.4) 33%/4%. Tracks
  draft cost and the model's lean; discriminates within the draftable pool.
- No retrain needed (sklearn unavailable) — calibration is pure historical base
  rates + model ranks, all in build-model-eval.mjs (Node).

**Round 4 — get_player_metrics target_share/wopr/racr fix + clock/score on PBP (MCP 1.0.40–1.0.42):**
- 🔴 **target_share / air_yards_share / wopr / racr were a single game, not the
  season.** computeSkillMetrics read `lastWeek` (the player's final weekly row),
  so the values didn't track season targets — e.g. 2025 Diggs (102 tgt) showed
  15% while Henry (87 tgt) showed 25%. Now computed from EXACT team totals
  (team targets / air yards summed per team-week across all players, over the
  player's played weeks): Diggs 21.2% > Henry 18% > Henderson 8.7% — monotonic
  with targets; Brown 2024 = 34.3% (PHI's very low pass volume — verified by two
  independent methods). Required regenerating the player-metrics artifacts.
- **Game clock + scoring on get_play_by_play:** added `time` (game clock at
  snap), `total_home_score`/`total_away_score` (running score), and
  `sp`/`touchdown`/`field_goal_result`. (nflverse's literal `play_clock` field is
  0 for 100% of plays, so it was left out.)

**Round 3 — metrics tools fixed via precomputed artifacts (MCP 1.0.39):**
- The streaming rewrite (1.0.36/37) did NOT fix the metrics tools on the hosted
  Worker — a follow-up test confirmed get_player_metrics / get_team_metrics /
  get_play_by_play still failed 100% ("Invalid content from server", a hard
  worker crash that bypasses try/catch). Root cause is the request-time ~99MB
  PBP fetch+parse itself exceeding Worker limits — streaming cut memory but not
  the download/parse time within the proxy timeout.
- **Fix:** precompute offline and serve committed JSON (like model-eval /
  projections). New `scripts/build-metrics-artifacts.mjs` + bundle export
  `buildMetricsArtifacts(season)` write `team-metrics-<season>.json`,
  `player-metrics-<season>.json`, `pbp-slim-<season>.json.gz`. The three
  handlers read the artifact first and fall back to live compute (npm/stdio,
  no limits). Compute is shared between the builder and the live path so they
  can't drift. CI: `.github/workflows/build-metrics-artifacts.yml` (weekly +
  dispatch). Committed 2024 + 2025; CI backfills others.
- Verified locally: PHI 2024 ppg 27.24 / 1375 plays (exact baseline match),
  A.J. Brown yprr 2.52 / 27.8% target share, real PBP — all served from the
  artifacts. (The hosted-Worker memory/timeout is sidestepped entirely since no
  99MB fetch happens in-request.)

**Round 2 — consolidated-report polish (MCP 1.0.38):**
- **get_sleeper_projections migrated** off the dead `api.sleeper.app/v1` endpoint
  to the current `api.sleeper.app/projections/nfl/<season>[/<week>]` endpoint
  (array of `{player, stats}`, populated) — verified live (Bijan 2026 ≈ 324.9
  PPR). Season-long now uses Sleeper's season projection directly (no week-sum).
- **speed_score pre-computed** (weight×200/forty⁴) on get_combine_results and
  get_rookie_class so analysts don't hand-roll it.
- **import_excel diff summary**: projections imports now print old→new changes
  vs the StatHead model (sorted by |Δ|, top 15 + unchanged count), not just a count.
- **"See also: get_metadata"** appended to every tool description (surfaces
  coverage/enums/caveats at point of need).
- Note: the report's "combine silent truncation" (P1) was already fixed
  (handler appends "showing first N of M; raise limit…").

**Done (verified locally against the bundle):**
- **Reliable current ADP feed (🔴 + the user's priority).** New default
  `get_adp` source **`consensus`** — a freshness/confidence-weighted blend of
  FantasyPros expert-consensus rank (DynastyProcess `db_fpecr`, reachable
  everywhere + daily), Sleeper draft ADP, and the FFC committed board. Per-source
  columns + disagreement spread + per-source `as_of`. A.J. Brown: stale feeds
  read 30.6 (Sleeper-dominated blend) / 17.7 (frozen FFC Sept-2025 window);
  the consensus blends to **~22.7** (fp 16.5 / sleeper 30.8 / ffc 17.7), near
  the ~21 market consensus. FantasyPros also added to the site-side blend
  (`src/lib/adpSources.ts`, source `fp`) for My Rankings / Draft Kit / Consensus.
- **`get_player_features` ADP reconcile (🔴#1, "reconcile + as_of").** Re-joins
  the live consensus ADP at serve time and shows it next to the scored ADP,
  flagging when the model was scored on a stale value (≥5-pick drift) + `as_of`.
- **`get_player_season_stats` null-deref (🟠).** `normalizeNameForMatch` now
  coerces null→'' — 2025 name lookups without `position` no longer crash.
- **`fields` drops identifiers (🟠).** `resolveCols` always re-prepends
  identifier columns (name/position/team) present in the row.

**Corrected diagnoses (original guesses were wrong):**
- **ADP staleness was NOT just "feature card stale vs live `get_adp`."** BOTH
  stored values were stale: feature-matrix's 30.6 ≈ the Sleeper-dominated blend
  (FFC's committed 2026 board is frozen at the Sept-2025 window, auto-floored to
  ~0.02 weight by recency), and `get_adp`'s 17.7 IS that frozen FFC window. The
  fix is a multi-source CURRENT blend anchored by FantasyPros, not swapping one
  stale source for another.
- **`get_player_metrics` / `get_team_metrics` is NOT a NaN serialization bug.**
  Root cause: the full-season play-by-play CSV is **~99 MB**; `response.text()`
  + papaparse OOMs the Cloudflare Worker's 128 MB limit. `get_play_by_play`
  fails identically (same `fetchPlayByPlay`); `get_advanced_stats` (small CSV)
  works. **Local Node has no cap, so it can't reproduce — only verifiable after
  deploy.** Real fix = stream `response.body` + project only needed columns.

**Remaining (decided with the user, not yet done):**
- ~~**PBP-memory streaming rewrite**~~ — ✅ DONE (MCP 1.0.36). `fetchPlayByPlay`
  now streams `response.body` chunk-by-chunk via a new quote-aware,
  column-projecting `streamCsvRows`; each consumer (get_team_metrics,
  get_player_metrics, get_play_by_play) requests only the columns it reads
  (~20x less retained data), so the 99MB file fits the 128MB Worker cap.
  Parser unit-tested (quoted commas/escapes/CRLF/embedded-newlines/chunk-
  boundary/coercion) + all projected column names confirmed in the live header.
  **Worker-memory behavior is only observable after deploy** (local Node has no
  cap; the 99MB end-to-end download is too slow to finish in-sandbox).
  `pbp_participation` (the other big CSV get_player_metrics loads, for route
  estimation) got the same streaming treatment in 1.0.37 — projected to its 3
  needed columns (nflverse_game_id, play_id, offense_players), confirmed present
  in the 2023/2024 headers.
- **Calibrated veteran pHit/pBust** — user chose "full calibrated" — but the VOR
  scale (≈14.9) ≠ the documented z-scored thresholds (0.47), and **sklearn is
  not installed in this env** (`ModuleNotFoundError`), so a Python retrain can't
  run/verify here. Needs a session with ML deps. (A no-retrain interim:
  distributional pHit/pBust from VOR + CI vs thresholds, computable in
  `build-model-eval.mjs` once the VOR↔threshold scale is reconciled.)

---

## 🔴 Data correctness

### Stale & inconsistent ADP in model cards
**What we saw**: `get_player_features` reports an `ADP` that diverges sharply
from the live `get_adp` (ffc) board for the same player, same season:

| Player | Feature-card ADP | Live ffc ADP |
| --- | --- | --- |
| A.J. Brown | 30.6 | 17.7 |
| Brian Thomas Jr. | 87.1 | 15.2 |
| Tee Higgins | 35.4 | 21.6 |
| Bucky Irving | 31.3 | 17.6 |
| Jonathan Taylor | 7.9 | 20.0 |

*Why it matters*: **ADP is the single highest-importance feature in the
Hit/Bust model** (per `get_model_docs`) and the anchor of the "value vs ADP"
read. A wrong ADP silently distorts every VOR/hit-bust output. In this
exercise it flipped the entire conclusion — Brown looked like a Round-3 value
at ADP 30.6 but is actually a top-10 WR price at 17.7. The card ADPs are also
not internally consistent with each other (some too high, some too low), so
this is a stale/misjoined snapshot, not a uniform offset.
*Root cause / fix*: the feature matrix appears to bake in an old ADP snapshot.
Refresh the ADP join at serve time (or on a schedule) against
`src/lib/adpSources.ts`; stamp each ADP with an `as_of` date; add a build
assertion that feature-matrix ADP == latest `adpSources` ADP within tolerance.
*Effort*: medium.

### VOR scale doesn't match the documented hit/bust thresholds
**What we saw**: `get_player_features` prints e.g. `VOR 14.9 (Likely Hit)`,
but `get_model_docs` lists the WR thresholds as **hit ≥ 0.47 / bust ≤ −0.64**.
The per-player VOR values (≈8–16) are on a completely different scale than the
thresholds, and *every* player we pulled came back "Likely Hit" — so the label
never discriminates.
*Why it matters*: users can't tie the displayed number to the documented model,
and the hit/bust label is uninformative for ranking risk.
*Root cause / fix*: decide on one scale. Either display the z-scored VOR that
the thresholds use, or keep the current scale but (a) document it in
`get_model_docs` and (b) compute the label from the matching threshold. Better:
expose a calibrated `pHit`/`pBust` (see model gap below).
*Effort*: small (display) / medium (calibration).

### Season-projection PPG implies a different usage than the share model
**What we saw**: Brown's Season-Projection PPG (16.0) implies a ~22–25% target
share at a ~500-target team volume, but the Usage-Share model on the same card
says 15.8%. The two sub-models emit mutually inconsistent implied usage.
*Why it matters*: a careful user reconciling the cards (as we did) finds they
contradict; it undercuts trust and makes stat-line construction ambiguous.
*Root cause / fix*: reconcile the pipelines, or surface the projected **team
pass volume** and **implied targets/receptions** the PPG projection used, so
the bridge between PPG and share is explicit.
*Effort*: medium.

---

## 🟠 Broken / flaky tools

### `get_player_metrics` and `get_team_metrics` fail 100% of the time
**What we saw**: every call (single and batched, all `output_format`s) returns
`Streamable HTTP error … Anthropic Proxy: Invalid content from server`. Other
tools on the same server work, so it's specific to these two.
*Why it matters*: these are the natural tools for efficiency/role analysis
(target share, YPRR, pass rate, HHI). We had to reconstruct everything from
`get_player_season_stats` + QB attempts by hand.
*Root cause / fix*: almost certainly non-JSON-serializable values in the
payload — `NaN`/`Infinity`/`-Infinity` from divisions, or non-finite floats —
which the proxy rejects. Sanitize non-finite numbers to `null` before
serialization and add a serialization smoke test over all 32 teams / a large
player sample.
*Effort*: small once root cause confirmed.

### `get_player_season_stats` null-derefs on 2025 name lookups
**What we saw**: `Error: Cannot read properties of null (reading 'toLowerCase')`
when `player_name` is passed **without** `position` for season 2025; adding
`position` works. Bulk (no name filter) also works.
*Why it matters*: per-player 2025 lookups silently fail unless you know to add a
position; some split-team rows (e.g. traded players) still error.
*Root cause / fix*: a row with a `null` name/team/position breaks the
case-insensitive matcher's `.toLowerCase()`. Null-guard the comparison
(`(x ?? '').toLowerCase()`) in the `get_player_season_stats` handler in
`src/tools.ts`.
*Effort*: tiny.

### `fields` silently drops identifier columns (`player_name`, `team`)
**What we saw**: requesting `fields=player_name,position,team,...` on
`get_player_season_stats` returned only the stat columns — no name, no team — so
a 100-row bulk pull couldn't be tied to players or teams. (Inconsistent:
`get_adp` *did* honor `team`.)
*Why it matters*: makes team-level reconstruction impossible from the bulk
endpoint; we couldn't isolate the NE/TEN rooms without per-name calls.
*Root cause / fix*: never drop requested identifier columns from the projection;
or always include `player_name`/`team` regardless of `fields`.
*Effort*: small.

---

## 🟡 Model / feature gaps

### No calibrated bust probability for scored veterans
**What we saw**: only prospects (`get_prospect_outcomes`) expose calibrated
boom/bust probabilities. Scored vets get VOR + an 80% CI but no `pBust`.
*Why it matters*: "how much bust risk vs. his range?" is a core draft question;
we had to approximate from CI width/floor + historical ADP→finish base rates.
*Fix*: expose `pHit`/`pBust` (e.g. P(finish outside positional top-24) and
P(top-12)) for scored players, calibrated against historical residuals; include
on the Hit/Bust card.
*Effort*: medium.

### No coaching / scheme-tendency data, and the share model ignores coach×player history
**What we saw**: to judge whether NE would funnel targets to Brown we had to
hand-reconstruct Mike Vrabel's Titans tendencies (run-heavy, but a ~24–25% WR1
target share for Brown himself) from team/player stats. Nothing in the tools
exposes coach tendencies, and the share model projected Brown at just 15.8% —
it can't see that he's *reuniting with the coach who ran him at ~25%*.
*Why it matters*: the most important variable in this trade analysis was
coaching, and the model is blind to it.
*Fix*: add coach-level features/a tool — career neutral pass rate, target
concentration (HHI), WR1 target share under that coach — plus a **coach×player
reunion** flag. Feed target-HHI (conditioned on WR talent tier / depth-chart
gap) into the share model so acquiring a clear alpha concentrates the pie.
*Effort*: large.

---

## 🟢 Polish / DX

- **`get_adp` has no position filter.** Had to pull the overall board and count
  WRs to derive positional ADP rank. Add a `position` param and return
  `adp_pos_rank`. *(small)*
- **`get_adp` ESPN source returns all-zero ADP for 2026.** Either populate,
  fall back to ffc, or flag "not available for season" instead of silent `0`s.
  *(small)*
- **`get_projections` exposes only `ppg`/`recPG`.** Building a stat line forced
  manual assumptions about targets/receptions/yards/TDs and team volume. Expose
  the component projections (targets, receptions, yards, TDs, team pass volume).
  *(medium)*
- **Add an `as_of` / freshness timestamp** to derived outputs (ADP, dynasty
  value, projections) so staleness is visible to the caller. *(small)*

---

## What worked well (keep)
- `get_player_features` per-model driver breakdown (Hit/Bust, Season Projection,
  Usage Share) is genuinely useful for *explaining* a projection, not just
  emitting one — the model-specific percentile bands are great.
- `get_adp_with_results` (ADP joined to actual finish + value) made the
  historical "finish-by-ADP" base-rate analysis a one-call job.
- `get_model_docs` feature-importance-by-position is exactly the context needed
  to interpret the cards (and is how we caught the ADP issue).
- `csv`/`jsonl` `output_format` kept large pulls token-cheap.
