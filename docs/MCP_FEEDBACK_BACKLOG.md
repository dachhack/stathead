# StatHead MCP: feedback & to-dos

Issues and enhancement ideas surfaced while using the MCP tools for a real
analysis (the 2026 A.J. Brown PHI→NE trade: projections, share model, ADP,
bust risk vs. draft range). Ordered by severity. Each entry: **what we saw**,
*why it matters*, *likely root cause / fix*, *rough effort*.

Severity legend: 🔴 correctness (wrong numbers reach the user) · 🟠 broken tool
· 🟡 model/feature gap · 🟢 polish/DX.

---

## ✅ Session update (2026-06-16, branch `claude/gallant-noether-lyddkb`)

Shipped + corrected diagnoses. **Two original root-cause guesses were wrong**
(documented inline below).

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
