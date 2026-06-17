# StatHead MCP: feedback & to-dos

Issues and enhancement ideas surfaced while using the MCP tools for a real
analysis (the 2026 A.J. Brown PHI→NE trade: projections, share model, ADP,
bust risk vs. draft range). Ordered by severity. Each entry: **what we saw**,
*why it matters*, *likely root cause / fix*, *rough effort*.

Severity legend: 🔴 correctness (wrong numbers reach the user) · 🟠 broken tool
· 🟡 model/feature gap · 🟢 polish/DX.

Status legend: ✅ fixed · ⚠️ partial · ❌ open (verified by re-test).

---

## Verification log (2026-06-16, two re-test rounds)

**Fixed ✅**
- `get_team_metrics` — was 100% crash, now returns data (NE 2025: 53.1% pass,
  55.1% neutral, 28.8 PPG; values plausible).
- `get_player_metrics` — was 100% crash, now runs. Single-player values look
  correct (A.J. Brown 2024: 27.78% target share, 2.52 YPRR). **But see new bug
  below — multi-row `target_share`/`wopr` are misaligned.**
- `get_adp` — identifier columns (`player_name`, `team`) now returned; `as_of`
  timestamps + staleness warnings added; **new `consensus` source** blends
  FantasyPros + Sleeper + FFC with freshness weighting + per-source spread.
  Directly addresses the stale-ADP correctness issue.
- `get_player_season_stats` — null-deref on 2025 name lookups resolved (with
  `position`); now returns `player_display_name` + `recent_team`.

**Partial ⚠️**
- `get_player_features` ADP — now *flags* staleness ("scored-ADP 30.6 · live
  consensus ADP 22.8 ⚠️"), but the Hit/Bust model is **still scored on 30.6**
  (VOR, driver bands, label unchanged). Transparency added; re-scoring pending.
  See "Stale & inconsistent ADP" below.

**Open ❌**
- `get_player_metrics` / `get_team_metrics` multi-row `target_share`/`wopr`
  misaligned — see new entry below.
- `get_player_season_stats` without `position` on 2025 — still errors (now a
  serialization error rather than null-deref); `position` is the workaround.
- VOR scale vs documented thresholds; projection↔share reconciliation; veteran
  bust probability; coaching features — all unaddressed (expected, bigger lifts).

---

## 🔴 Data correctness

### `target_share` / `wopr` misaligned in multi-row `get_player_metrics` (NEW)
**What we saw**: filtering `get_player_metrics` by team (NE 2025) returns a
`target_share` column that does **not** track the `targets` column:

| Player | targets | target_share shown |
| --- | --- | --- |
| Stefon Diggs | 102 | 15 |
| Hunter Henry | 87 | 25 |
| Mack Hollins | 65 | 21.43 |
| TreVeyon Henderson | 42 | 0 |

The player with the most targets shows a *lower* share than teammates with
fewer; an RB with 42 targets shows 0%. `wopr` is similarly off (Diggs lowest
despite most targets). The **single-player** path is correct (Brown 2024 =
27.78%), so the bug is in the team/multi-row aggregation — likely a wrong/
per-player denominator, a join/sort misalignment, or NaN→0.
*Why it matters*: target share is the headline usage metric; wrong values here
silently corrupt any role/efficiency analysis. We had to fall back to raw
`targets` and compute shares by hand again.
*Root cause / fix*: inspect the `target_share`/`wopr` computation in the
multi-row branch of `get_player_metrics` (`src/tools.ts` / metrics query); make
the denominator the team's total pass volume and ensure column alignment after
the sort.
*Effort*: small-to-medium.
*Status*: ❌ open (introduced/exposed by the serialization fix that made the
tool run at all).

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
*Status*: ⚠️ partial — the card now **flags** the staleness ("scored-ADP 30.6 ·
live consensus ADP 22.8 ⚠️, as of 2026-06-12") and a fresh `consensus` source
exists, but the Hit/Bust model is **still scored on the stale 30.6** (VOR,
driver percentile bands, and label unchanged). Re-score on the consensus ADP to
close this — Brown's true ~22.8 would lower his VOR/value.

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
