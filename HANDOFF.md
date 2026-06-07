# StatHead — session handoff

Last updated 2026-06-07. **Resume section below is the live one;** older notes follow.

---

## ⚡ Latest session wrap (2026-06-07, PRs #322–#330)

Working branch: **`claude/scenario-builder-presets-resume-rYlS1`** (PR base `claude/nfl-fantasy-workbench-6D1yd`).

Shipped this session:
- **#322** ESPN schedule enrich (preseason venues/networks; reg-season gaps still TBD on ESPN).
- **#323** Sleeper **league import** (`sleeper.ts` + `SleeperLeagueView` + nav tab).
- **#324** `sleeper_id`→`player_key` PlayerDetail links (`lookupBySleeperId`).
- **#325** **Consensus ADP** tab (FantasyCalc redraft, daily-refreshed, Sleeper-inclusive).
- **#326** Clay 2026 player projections → committed `clay-projections-2026.json`.
- **#327** **Consensus 80/20 blend** preset wired live (+ fixed a `normalizeName` crash that broke the whole Scenario Builder).
- **#328** **SOS** now uses Consensus **defense grades** (`clay-unit-grades-2026.json`).
- **#329** **Team projections + matchup win-prob** on the Schedule view.
- **#330** Year-agnostic Clay extractor + `clay_blend_study.py`.

**Two things waiting on the user (next session):**
1. **More historic Clay PDFs** (esp. 2025) to finalize per-position blend weights — user hit the upload limit; has ~5 more. Extracted **2023 + 2024 + 2026 player projections are now committed** to `public/data/clay-projections-<year>.json` (PR #332), so the study runs across sessions WITHOUT re-uploading: `python3 scripts/clay_blend_study.py --years 2023,2024`. Add new years by extracting their PDF to the same path, then re-run + set per-position weights in `scenarioPresets.ts` (flat `0.8` today; QB ~0.4 is the exception). (PDFs themselves stay out of the repo.) Historic **unit grades** are also committed (`clay-unit-grades-{2023,2024,2026}.json`, page 61 in older guides — `extract_clay_unit_grades.py <pdf> <year> 61`). Matchups + team-projections are committed for 2026 only (historic ones need a `schedule-<year>.json` for team fingerprinting — not built yet).
2. **Sleeper as its own main site section** — see the "NEXT ROUND — Sleeper" note in Task 2 (sleeper_wrapper, all-leagues-by-username, matchups, gsis→player_key).

---

## ⚡ Resume here (2026-06-07) — Scenario Builder / Schedule / Sleeper

Working branch: **`claude/scenario-builder-presets-resume-rYlS1`** (PR base `claude/nfl-fantasy-workbench-6D1yd`). Many PRs merged (#294–#322); Sleeper league import shipped in #323.

### Allowlist — RESOLVED (2026-06-07)
`site.api.espn.com` + `api.sleeper.app` are both reachable (`200`) now. Re-test if needed:
```
curl -s -o /dev/null -w '%{http_code}\n' "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=1&dates=2026"
curl -s -o /dev/null -w '%{http_code}\n' "https://api.sleeper.app/v1/state/nfl"
```
(If they ever 403 again: env likely saved as **Custom** without "include default package managers", or domains have a stray `https://`/path.)

### Task 1 — commit ESPN schedule data ✅ (PR #322)
- `scripts/enrich_schedule_espn.mjs` — reproducible server-side mirror of `overlayEspn`. Fills *missing* reg-season networks then re-runs `build_schedule.mjs`; fills preseason network + venue.
- Committed **49 preseason venues + 5 preseason networks**.
- ⚠️ The "~24 missing reg-season networks" (weeks 16–18) are still **TBD on ESPN itself** (flex scheduling) — ESPN has the same 248/272 we do, only cosmetic naming diffs (`Prime`→`Prime Video`, `NETFLIX`→`Netflix`) that the runtime overlay already applies live. Re-run `node scripts/enrich_schedule_espn.mjs 2026` once ESPN finalizes weeks 16–18 and they'll fill in.

### Task 2 — Sleeper features (`https://docs.sleeper.com/`)
- ✅ **League import** (PR #323): `src/lib/sleeper.ts` (`importLeague(id)`) + `src/components/SleeperLeagueView.tsx` + "Sleeper League" nav tab (Projections group). Enter a league id → standings + per-team rosters (starters w/ slot labels + bench), player names resolved via the existing `fetchSleeperPlayers()` map in `data.ts`. League id persists in localStorage. Verified against real league `1182033380414181376`.
- Pre-existing (retired `'sleeper'` tab, `SleeperView.tsx`): **trending adds/drops + Sleeper projections** already shipped via `fetchSleeperTrending`/`fetchSleeperProjections` in `data.ts`.
- Remaining Sleeper ideas: Sleeper **ADP** as a consensus source; sync `sleeper_id`→`player_key` so league rosters link to PlayerDetail/career model.

### ▶ NEXT ROUND — Sleeper as its own main site section (user request 2026-06-07)
Promote Sleeper from the single League-import tab to a **dedicated top-level site section** (its own nav group) covering: league import (have it), standings, per-team rosters, trending adds/drops + projections (exist in retired `SleeperView`), **a user's all-leagues view** (enter a Sleeper username → list every league), and per-league matchups/standings.
The user suggests the **`sleeper_wrapper`** Python package (`pip install sleeper_wrapper`) for any Python-side pulls — wraps League / Players / User / Drafts. (The TS app can keep using the CORS-open REST API directly, as `data.ts`/`sleeper.ts` already do; `sleeper_wrapper` is for offline/Python pipelines.) Example the user provided:
```python
from sleeper_wrapper import League, Players, User
league = League(1180266430665863168)
rosters = league.get_rosters(); users = league.get_users()
standings = league.get_standings(rosters, users)          # standings tuple list
players = Players().get_all_players()                       # id -> {full_name, position, team, gsis_id, ...}
lgs = User("dachhack").get_all_leagues('nfl', 2026)         # every league for a username/season
```
Key endpoints this implies for the TS side: `GET /v1/user/<name>` → user_id; `GET /v1/user/<user_id>/leagues/nfl/<season>` (all leagues); `GET /v1/league/<id>/matchups/<week>`. `get_all_players()` has `gsis_id` → join straight to our crosswalk by gsis for `player_key` (cleaner than the name match we use now).

### Conventions
One PR per feature; `tsc -b` + eslint + `vite build` green before shipping; verify UI with headless puppeteer (`npm i --no-save puppeteer`) against `npx vite preview` on a fresh port (don't `pkill`). Merge via GitHub MCP tools. Commit/PR footer = session URL; never commit the model id.

### Gotchas
- `public/data/*` is gitignored with `!` allowlist exceptions — new committed data files need a matching `!` line (`!public/data/schedule-*.json` already added).
- ESPN abbrevs → ours: `LAR→LA`, `WSH→WAS` (`ESPN_TO_OURS`). Our codes == nflverse.
- Committed-date ET offset heuristic: `-04:00` (Aug–Oct) else `-05:00`. Headless test browser is UTC so times display shifted there (fine in user's browser).
- Build sandbox egress = curated allowlist (GitHub reachable). App also fetches live in the browser (KTC, schedule ESPN overlay) — not subject to the sandbox allowlist.

### Shipped this stretch
- Scenario Builder = full-page tab (`embedBuilder` on `StatProjections`; scenario in `App`). Team Workspace primary: division selector+logos, click ▲/▼ steppers (step 1), targets/carries cascade to rec/yds re-based off original rates, all team levers in one "Team adjustments" box (Pass/Run, Team Volume, 11 team-stat sliders), Tgt column, subtotals + Team Total + "Δ vs Base", PPR-delta badge, collapsible current roster, clickable names → PlayerDetail, Overall Rankings panel.
- Excel export (`src/lib/exportTeamXlsx.ts`, exceljs, live formulas).
- Schedule & SOS tab (`src/components/ScheduleView.tsx`, `src/lib/nflSchedule.ts`): committed nflverse reg season + committed networks (`scripts/parse_schedule_pdf.py`) + committed preseason (`scripts/build_preseason.mjs`) + ESPN runtime overlay. SOS = opponent offensive strength, reg-season only (overall + thirds + per-game).
- Fixed player-card career chip 100× scaling; rookie-optimistic preset → +25%.

### To-do list (user's original 8, with status)
1. ✅ Collapsible current-team rosters in Scenario Builder (PR #316)
2. ✅ Team schedules + estimated SOS (PRs #318–#321; reg+preseason committed, SOS overall/thirds)
3. ⬜ Clean up + test the **My Rankings** page (scope it with the user — bugs? layout?)
4. 🟡 **Consensus Projections** = blend Clay + our base. Clay 2026 guide extracted: `scripts/extract_clay_projections.py <pdf>` → `public/data/clay-projections-2026.json` (448 offensive players QB/RB/WR/TE/K, 98% joined to player_key) (PR #326). ⚠️ PDF is a manual drop, NOT committed (ESPN's; surfaced only as "Consensus"); re-run the extractor on each new guide. The **80% Clay / 20% us blend now ships** as the "Consensus" preset in the Scenario Builder (PR #327): `StatProjections` loads the committed file → `clayPprMap`; the pre-existing `consensus` preset in `scenarioPresets.ts` blends per-player PPR via `pointsOverrides`. PR #327 also hardened `normalizeName` (was crashing the whole projections build on a missing-name data row). **Still open**: richer pipelines from the PDF — unit grades p63 → SOS opponent-quality, projected SOS p62, team projections pp2-33, IDP, win prob.
5. ✅ **Sleeper API** features — league import (#323), `sleeper_id`→`player_key` PlayerDetail links (#324), Consensus ADP (#325); trending/projections already existed. (Note: Sleeper has no public ADP API — Consensus ADP uses FantasyCalc's Sleeper-inclusive redraft snapshot, already refreshed daily by `fetch-fantasycalc-snapshot.yml`. `maybeAdp` is null in offseason; the view shows live consensus value/rank and auto-reveals the ADP column in-season.)
6. ⬜ Add **Scenario Builder to the Home/intro page menu** (quick win).
7. ⬜ Better **player cards** with stats + images (career-chip scaling already fixed; build a richer inline card).
8. ⬜ Test + clean up the **Draft Optimizer** for the upcoming season.

Extra (not on original list): ✅ SOS true opponent-quality — now uses Consensus DEFENSE grades (PR #328: `scripts/extract_clay_unit_grades.py` → `public/data/clay-unit-grades-2026.json`; `nflSchedule.ts` `teamStrength`/`computeSOS` take optional grades, fall back to offense proxy when absent). ✅ Team projections + matchup win-prob (PR #329: `scripts/extract_clay_team_pages.py` → `clay-matchups-2026.json` (272 games: proj score + win prob) + `clay-team-projections-2026.json` (32 teams: PF/PA, proj wins, Off/Def/Ovr rank); Schedule view shows a per-game Proj column + a "Consensus team outlook" strip; team pages identified by opponent-fingerprint match vs committed schedule). The ~24 reg-season network gaps remain TBD on ESPN (re-run `enrich_schedule_espn.mjs` once assigned).

**Clay PDF pipeline status**: extractors = `extract_clay_projections.py` (players; now year-agnostic — detects position by page title, takes optional out-path), `extract_clay_unit_grades.py` (p63 grades), `extract_clay_team_pages.py` (pp2-33 matchups + team proj). Re-run all three on each new PDF drop. Remaining unused: IDP defenders (pp46-55), category leaders (pp58-60), projected standings/draft order (p61), coaching staffs (p74), projected starters w/ ratings (pp75-82).

**Blend-weight study** (`scripts/clay_blend_study.py`): scores Clay + a prior-year-rates baseline vs actual season PPR (`player_stats_<Y>`) and sweeps the per-position blend weight. Historic player projections are committed under `public/data/clay-projections-<year>.json` (2023/2024/2026 present); just run:
```
python3 scripts/clay_blend_study.py --years 2023,2024          # add years as PDFs are processed
# new PDF: python3 scripts/extract_clay_projections.py <hist.pdf> <year> public/data/clay-projections-<year>.json
```
Findings so far (2023-2024, n=284, non-rookie): aggregate optimal ≈ **0.80 Clay** (validates the flat 80/20). By position: **QB ~0.40-0.45** (Clay no better than priors!), RB ~0.85-0.90, WR ~0.70-0.80, TE ~0.80-1.0. ⚠️ "baseline" is prior-year rates, not our real ensemble → these are UPPER BOUNDS on Clay weight; rookies excluded (a Clay strength — keep Clay high for them). **TODO when more historic PDFs arrive (user has 5, esp. 2025)**: re-run, then set per-position weights in `scenarioPresets.ts` (currently flat `CONSENSUS_CLAY_WEIGHT = 0.8`), mainly pulling QB down.

---

## Where things stand

**Default branch**: `claude/nfl-fantasy-workbench-6D1yd` (NOT `main`). Deploy workflow fires on push there.

**Last working branch**: `claude/fix-percentile-score-inconsistency-NGos1` — merged into default as of `d50cf9b`. Assume clean.

## What shipped recently (PRs in reverse chron order)

| PR | Topic |
|---|---|
| (merged 88a48b3) | `player_key` stamped onto `player_stats` via DuckDB LEFT JOIN. Python: `resolve_player`, `get_player`, `load_player_profile`. Ask-tab prompt tells Claude to prefer `player_key` joins. 14/14 smoke tests. |
| 211 | Unified `player_crosswalk` — 11669 players, `sh_<hex>` keys. 0 unresolved cases. Alias file at `public/data/player-aliases.json`. Builder: `scripts/build-player-crosswalk.py`. |
| 210 | Ask mode in Data Query tab — Claude tool-use over DuckDB, single `run_sql` tool, api key in localStorage. |
| 209 | "Dedupe rows" toggle on Data Query. |
| 207 | Reddit scrape gated behind `ENABLE_REDDIT_SCRAPE=1` (features never populated). |
| 206 | Publish workflow supports `workflow_dispatch` (mobile-friendly PyPI releases). |
| 205 | QB boomZ/bustZ now surface on Dynasty Prospects. |
| 204 | Big roll-up: WR-R1 cap authoritative in Python/TS, name-merge infrastructure, manual CFBD overrides for 10 players, team-talent forward-fill, Data Query (SQL) tab with DuckDB-WASM, `stathead` Python package + CI. |

## Data surfaces, one-liner each

| Surface | Where | Notes |
|---|---|---|
| Dynasty Prospects tab | `src/components/RookieProspectsView.tsx` | Has a Download CSV button. |
| My Prospect Rankings tab | `src/components/MyProspectRankings.tsx` | Shows **Pctl** column + model tier names (Alpha / Blue Chip / …). |
| Career Backtest tab | `src/components/RookieCareerBacktest.tsx` | WR-R1 cap is defense-in-depth here (canonical cap lives in Python). |
| ZAP Compare tab | `src/components/ZapComparison.tsx` | Methodology text is model tier names. Legacy-year rows read already-capped Python backtest. |
| Data Query tab | `src/components/DataQuery.tsx` + `src/lib/duckdb.ts` | DuckDB-WASM, 8 tables. "SQL" and "Ask" modes. |
| Model Docs | `src/components/ModelDocumentation.tsx` | Feature labels live in `src/lib/featureTypes.ts` FEATURES. |
| Player cards | `src/components/PlayerCard.tsx` | `ZERO_MEANS_MISSING` set at top; PDF/RSP features are NOT in it (have has-indicators instead). |

## DuckDB tables in the SQL tab (for Ask mode too)

All joinable on `player_key`:

- `player_crosswalk` — canonical identity; every known alt ID (gsis/pfr/sleeper/espn/pff/yahoo/sportradar/ktc).
- `career_2026` — 2026 rookies, flattened features, `player_key` stamped.
- `backtest` — historical 2010-2025 rookies with pred + actual, `player_key` stamped.
- `prospects` — 2026 draft scouting grades.
- `player_stats` — weekly NFL stats 2010-2026; `player_key` stamped via crosswalk join on gsis.
- `adp_historical` — 4507 rows, 2010-2025, training ADP, `player_key` stamped.
- `adp_ffc` — FFC API raw (currently 2025 only — **2024 and earlier still missing**).
- `ktc` — current dynasty values.
- `ktc_history` — daily KTC value history.

## Python package (`python/`)

`stathead 0.1.0` published via workflow_dispatch. Exports: `load_*` loaders + `resolve_player`, `get_player`, `load_player_profile`. Tests in `python/tests/test_smoke.py` (14/14). Cache under `~/.cache/stathead/<ref>/`.

To release `0.2.0` (includes the three new helpers):

1. Bump version in `python/pyproject.toml` + `python/src/stathead/__init__.py` to `0.2.0`.
2. Commit + push.
3. Actions → **Publish stathead to PyPI** → **Run workflow** → branch `claude/nfl-fantasy-workbench-6D1yd` → Run. PyPI trusted publisher (OIDC) handles auth.

## Open work items (ranked by leverage)

1. **Post-draft rookie key-promotion** — time-sensitive (draft ~just happened). Script to diff nflverse rosters; when a 2026 rookie lands on an NFL roster, add their GSIS as an alias on the existing `COL:` synthetic crosswalk record (or promote canonical to the GSIS-based key and keep COL as alias). Otherwise KTC / ADP / career_2026 show the same player under two keys.

2. **CI-run `scripts/build-player-crosswalk.py`** on every data refresh. Today it only runs when I invoke it; the daily KTC snapshot + weekly roster fetch don't rebuild the crosswalk. Add a step to `.github/workflows/refresh-data.yml` (or the auto-commit workflow).

3. **Player detail page** at `/player/sh_<key>` that merges every table (career pred + ADP history chart + KTC trend + game logs + scout grades + all IDs). Biggest visible UX win; now trivially joinable via `player_key`.

4. **Refresh `adp_ffc` coverage** — only 2025 committed (sandbox firewall blocked FFC API). Run `bash scripts/pull-all-data-sources.sh` from an unrestricted environment to pull 2018-2024 + 2026.

5. **Consolidate the 4 `normalizeName` copies** in UI components (RookieProspectsView, ZapComparison, MyProspectRankings, PlayerCard) into a single shared util that accepts `player_key` with name fallback.

6. **Re-key `feature-store/*.json` shards** by `player_key::season` instead of `name::season`. Big refactor but cleaner long-term.

7. **Alias-conflict detection** — flag canonical crosswalk records whose alias entries disagree on DOB or college. No-op today, tripwire for future merges.

## Known quirks / gotchas

- **Default branch is `claude/nfl-fantasy-workbench-6D1yd`**, not `main`. Deploy + auto-commit both target it.
- **Base keeps moving during long sessions** — the auto-commit workflow pushes data refreshes to the default branch every few hours. A feature branch open for >2 hours will often need a base merge with `public/data/feature-matrix.json` conflicts. Always take **ours** on regenerable data files (feature-matrix, model-cache-career-\*, prospect-boom-bust, score-store/\*) because our branch has code changes base doesn't.
- **This sandbox's git proxy blocks tag pushes** (HTTP 403). Use `workflow_dispatch` on `python-publish.yml` for PyPI releases; can't `git push --tags`.
- **GitHub MCP server is flaky** — connects and disconnects intermittently within a session. When MCP tools are available, use them to open + merge PRs. When they're gone, direct user to the GitHub mobile web UI. The pattern is: `git push` from sandbox → paste compare-page URL → user taps Create PR + Squash merge.
- **FFC API is not reachable from this sandbox** — host not on allowlist. Any 2024-FFC-ADP pull has to happen outside the sandbox.
- **Roster files start at 2010** — players retired before 2010 (or cup-of-coffee guys like Clyde Gates) aren't in the crosswalk spine; they get minted as synthetic COL keys.
- **Pre-commit hook** at `.githooks/pre-commit` catches conflict markers + malformed JSON in `public/data/**`. Never try to commit files with `<<<<<<<` in them — fix conflicts first.
- **`training-rows-cache-v49.json` is frozen** — rebuilding from scratch requires CSV downloads this sandbox can't fetch. The backfill script (`scripts/backfill_cfbd_variants.py`) patches the cache in place. If a code change requires retraining on fresh features, bump the cache version rather than trying to rebuild v49.
- **WR Alpha tier cap** — requires first-round draft capital. Non-R1 WRs max at BlueChip. Enforced in `train_career_models.py` and `precompute-features.ts`; UI has defensive cap in `RookieCareerBacktest.tsx`.

## Useful one-liners

```bash
# Rebuild crosswalk (fast — ~10 seconds)
python3 scripts/build-player-crosswalk.py

# Regenerate feature-matrix.json (stamps player_key on career_2026)
npm run build:features

# Retrain career models (pre + post-draft; ~60 seconds)
python3 scripts/train_career_models.py

# Run Python smoke tests
python3 -m pytest python/tests -q

# Patch CFBD features on the training cache
python3 scripts/backfill_cfbd_variants.py
```

## Key file paths

```
scripts/
  train_career_models.py          — career model training, Python
  precompute-features.ts          — feature matrix + 2026 prospect scoring, TS
  build-player-crosswalk.py       — unified crosswalk builder
  backfill_cfbd_variants.py       — patch CFBD features onto training cache
  pull-all-data-sources.sh        — refresh all nflverse + FFC + college data
src/
  lib/duckdb.ts                   — DuckDB-WASM loader, table docs, example queries
  lib/askData.ts                  — Ask mode tool + system prompt
  lib/featureTypes.ts             — FEATURES catalog + nameVariants + FIRST_NAME_ALIASES
  components/DataQuery.tsx        — SQL / Ask tab with table-detail modal
  components/AskData.tsx          — chat UI for Ask mode
python/
  src/stathead/                   — pandas loaders + crosswalk helpers
  tests/test_smoke.py             — 14 tests
public/data/
  player-crosswalk.json           — 11669 canonical player records
  player-aliases.json             — 18 manual overrides + unresolved cases
  manual-cfbd-overrides.json      — 10 players missing from CFBD player-usage
  model-cache-career-v72.json     — trained career model, backtest rows
  feature-matrix.json             — 2026 predictions + feature importance
  feature-store/profile.json      — historical ADP (4507 rows, 2010-2025)
  feature-store/players.json      — per-player position + display name
```

## Context to carry into the next session

- User is dachhack, on mobile, building a fantasy football research site (stathead.xyz-style).
- Heavy investment in the rookie career model; recent work focused on data-quality (name merges, manual overrides, crosswalk), not new model features.
- Data Query tab is the crown jewel for analysts; Ask mode is new and unproven — user hasn't reported live usage yet.
- Python package is shipped but user hasn't promoted `0.2.0` yet.
- 2026 NFL draft happened (or is happening) — rookie key-promotion is time-sensitive.
- Keep new surfaces consistent with the model tier system (Alpha / Blue Chip / Starter / Contributor / Depth / Longshot). The old ZAP tier names (Legendary / Elite / Weekly Starter / …) still live in `src/lib/tierScore.ts` for PPG-to-tier-score mapping but should not appear in new UI.

## Quick sanity check on session start

```bash
git status                            # clean?
git fetch origin                      # sync refs
git log --oneline origin/claude/nfl-fantasy-workbench-6D1yd -n 5
python3 -m pytest python/tests -q    # 14/14 should pass
```

Good hunting.
