# Handoff — Scenario Builder presets & UX (Projections tab)

Goal for the next session: make the **Scenario Builder** easier to operate and add
**one-click preset scenarios** — e.g. *Industry/Consensus*, *Rookie optimistic*,
*Vet optimistic*, *Injury skeptic*. This doc is the starting point.

## TL;DR of the ask
- The builder works but is tedious (big modal, lots of manual per-player/per-team entry).
- Add a **preset picker** that fills a `ScenarioConfig` in one click; user can then tweak.
- Presets are *opinionated tilts* implemented with the **existing scenario levers**.

---

## Where everything lives

| Piece | File |
|---|---|
| Builder UI (modal) | `src/components/ScenarioBuilder.tsx` (~1500 lines) |
| Scenario math | `src/lib/scenarioEngine.ts` — `applyScenario()`, `isScenarioEmpty()`, `createEmptyScenario()`, `saveScenario()`/`loadAllScenarios()`/`deleteScenario()` (localStorage key `stathead-scenarios`) |
| Types | `src/types.ts` → `ScenarioConfig` (line ~1069) + sub-types (`TeamTendency`, `TeamVolume`, `TeamStatAdjustment`, `VolumeOverride`, `PlayerMovement`, `CustomPlayer`, `FreeAgentSigning`) |
| Host tab | `src/components/StatProjections.tsx` — owns `scenario` state, renders `<ScenarioBuilder>`, applies via `applyScenarioToProjections()` (memo at ~489). Builder opens from the **"Scenarios"** button (~1977). |

## How a scenario works today (the levers)
`ScenarioConfig` (all arrays empty = no-op):
```ts
{ id, name,
  vegasWeighting,        // 0|10|25|50 — regress projections toward position mean (market compression)
  teamTendencies[],      // {team, passRatioDelta -30..+30} pass/run balance
  teamVolumes[],         // scale a team's whole pie
  teamStatAdjustments[], // targeted per-stat team overrides
  volumeOverrides[],     // {playerId,name,team,position, volumeDelta%, rushDelta?, recDelta?, passDelta?} — ZERO-SUM within team pool (boost one, others scaled down)
  movements[],           // {playerId, fromTeam, toTeam}
  customPlayers[],       // inject new rows
  freeAgentSignings[] }  // inject a FA with scaled prior-year stats
```
`applyScenario(projections, scenario)` applies them in order (movements → tendencies →
team volume → team stat adj → player volume (zero-sum) → vegas regression → custom/FA inject).
Read the numbered comments in `scenarioEngine.ts` — they're good.

Key property: **`volumeOverrides` are zero-sum within a team** (boost a WR1 → his teammates get scaled down to preserve team totals). This is exactly what presets want.

---

## Preset design (recommended)

Presets aren't static `ScenarioConfig` blobs — they need the **current player pool +
metadata** (who's a rookie, age, injury history) to generate the right
`volumeOverrides`. So model each preset as a **factory**:

```ts
// src/lib/scenarioPresets.ts (new)
type PresetFn = (players: SDIOProjection[], meta: PlayerMeta) => ScenarioConfig;
```
where `meta` gives per-player `yearsInLeague` / `isRookie`, `age`, and an injury/availability
signal. The builder shows a **preset dropdown**; selecting one calls the factory with the
live projection pool (already available in `StatProjections` as the `projections` passed to
`<ScenarioBuilder projections=...>`) and sets the scenario. User can then edit.

### Where to source the metadata
- **Rookie flag / yearsInLeague**: the projection rows / draft data already in `StatProjections` (`draftByName`, `rosters` `years_exp`/`entry_year`, `rookieShare()` uses `draftByName`). Easiest: a rookie = `draftPicks[name].season === PREDICT_SEASON` or roster `years_exp === 0`.
- **Age**: `draftByName[name].age + (PREDICT_SEASON - draft.season)` (see `ageFactor()` in StatProjections).
- **Injury/availability**: there's `injuries_<year>.csv.gz` in `public/data` and a `fetchInjuries` in `src/data`; also `public/data/college-availability.json` (college only). For NFL availability you'd derive a per-player games-missed history from `injuries_*` or prior-season `games` played. **Note:** this may need a small data add — see "engine gaps" below.

### Mapping the requested presets to levers
- **Rookie optimistic** — `volumeOverrides` `+15–25%` for rookies at RB/WR/TE (zero-sum lifts them over vets on their team). Optionally `+` rookie QBs’ rush.
- **Vet optimistic** — inverse: `−` rookies / `+` established vets (yearsInLeague ≥ 3) per team; consider toning down `ageFactor` isn't a scenario lever, so do it via volume.
- **Injury skeptic** — discount oft-injured / high-age players. Cleanest is a **per-player games/availability haircut**; today the only knob is `volumeDelta` (a proxy: −X% volume ≈ −X% games). A true "games" lever is a small engine add (below).
- **Industry / Consensus** — ⚠️ **licensing:** we cannot ship Clay's numbers (kept offline/uncommitted in `/private/`). Two honest options: (a) drop the literal "Clay" preset — our base projection is *already* consensus-calibrated (depth-order model + the PPG elite spread, see history below); or (b) make "Consensus" = `vegasWeighting: 25` (market compression toward the mean). Don't embed Clay data.

---

## Engine gaps you may want to add
- **Per-player games / availability lever** for "Injury skeptic" (and generally useful): add `gamesOverride?` or `availabilityDelta?` to `VolumeOverride` (or a new array) and handle it in `applyScenario` (scale a player's counting stats by `games/17`). Small, localized change.
- Presets generate many `volumeOverrides` at once — make sure the zero-sum redistribution still reconciles (it should; it already handles multiple overrides per team).

## "Easier to operate" UX ideas
- Preset dropdown + one-click apply at the top of the modal (with a short description of each).
- A "Reset to base" button (sets `createEmptyScenario()`).
- Presets are a starting point — after applying, the existing sections let the user fine-tune.
- Consider collapsing the 8 sections (accordion) so the modal isn't a wall; presets reduce the need to touch most of them.
- The saved-scenario list already exists (`loadAllScenarios`) — presets could seed it.

---

## Verify your changes (live, like we've been doing)
The Projections tab pulls **committed data** only in *production* mode, and `IS_PROD`
is gated on `hostname !== 'localhost'`, so:
```bash
bash scripts/extract-data.sh            # materialize .csv from committed .csv.gz
npx vite build                          # NOT npm run build (skip precompute)
npx vite preview --port 4200 --host 127.0.0.1
# drive headless via 127.0.0.1 (NOT localhost) so committed data loads
```
A puppeteer driver pattern (click the "Projections" home card, wait for "players projected",
read the table) is what we used; install `puppeteer` ad hoc and **revert package.json after**
(it's a verify-only dep). Scenario testing: apply a preset in-page, confirm the projected
PPG/order shifts the intended way (e.g. rookie optimistic → rookies climb their team's order).

## Conventions
- Branch off the default branch **`claude/nfl-fantasy-workbench-6D1yd`** (NOT `main` — there is no `main`). Open a PR, merge it; deploy auto-fires on push to default (runs full `npm run build` incl. precompute).
- `tsc -b` must pass; pre-existing `any`/empty-block lint in `StatProjections.tsx` is fine (don't add new).
- Don't commit Clay's data or anything under `/private/` (gitignored).

## Useful recent context (projection internals this touches)
Recently shipped (so you know how the base projection is built before scenarios apply):
- **Depth-order model** (`scripts/train_depth_order_model.py` → `public/data/depth-order-2026.json`) seeds each team's RB/WR/TE/QB ordering (public-data, ~65–71% top-1).
- **ML-PPG anchor** in `StatProjections` sets WR/TE point *levels* from `score-store/ppg.json`; a within-team reorder makes the depth-order #1 lead.
- **PPG elite-tier spread calibration** (`precompute-features.ts`, k=QB1.30/others1.15) lifts studs.
- These all run *before* `applyScenario`, so presets tilt on top of an already consensus-calibrated base.

Scenario engine ground truth is `scenarioEngine.ts` — start there, then the preset factory.
