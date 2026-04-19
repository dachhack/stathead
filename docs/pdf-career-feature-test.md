# PDF Scouting Features — Career-Model A/B Test

Experiment that measures whether fields from
`public/data/pdf-prospect-features-merged.json` (The Beast / RSP / Late-Round
Guide scouting extracts) carry signal for the rookie best-2-of-3-PPG career
models trained by `scripts/train_career_models.py`.

Runner: `scripts/test_pdf_career_features.py`
Raw results: `public/data/pdf-career-ablation-{pre,post}draft.json`

## Setup

- **Baselines**: `PRE_DRAFT_FEATURES` / `POST_DRAFT_FEATURES` per position
  from `train_career_models.py`.
- **Protocol**: LOSO-by-draft-season, Ridge + bagged LightGBM blend, exactly
  mirroring `train_position()` for fair Δ comparisons.
- **Evaluation regimes** (n shown is the scored-rookie count):
  - `all yrs` — train on 2009-2025, score on every LOSO fold.
  - `score≥22` — train on all years, score only 2022-25 folds (the PDF era).
  - `train≥22` — train AND score on 2022-25 only (honest within-PDF-era test).
- **PDF coverage**: 90-100 % of 2022-25 rookies match a PDF entry (44 QB,
  76 RB, 108 WR, 52 TE across four drafts). 0 % for 2009-2021.

## Candidate feature groups

| Group | Keys |
|-------|------|
| `rank_only` | `pdfRankOverallMean`, `pdfHasRank` |
| `round_only` | `pdfProjectedRound`, `pdfHasRound` |
| `sentiment` | `pdfNStrengths`, `pdfNWeaknesses`, `pdfNRedFlags`, `pdfSentimentNet` |
| `injury` | `pdfInjuryRedFlags` |
| `consensus` | `pdfNSources`, `pdfHasData` |
| `tier_elite` | `pdfTierElite` |
| `all_numeric` | union of the above |

`pdfSentimentNet = #strengths − #weaknesses − 2 × #red_flags`.
`pdfTierElite = 1` if any tier label matches `1st round / tier I / elite /
no. 1 / top-10 / day 1`.

## Findings — Pre-Draft

ΔR² signs are additive on top of the existing per-position baseline.

### RB (baseline R²: 0.377 all yrs, 0.311 score≥22, 0.217 train≥22, n=314)

| Variant | ΔR² all yrs | ΔR² score≥22 | ΔR² train≥22 | Verdict |
|---|---:|---:|---:|---|
| `rank_only` | **+0.008** | **+0.028** | **+0.079** | **clear add** |
| `round_only` | -0.006 | -0.017 | -0.019 | drop — redundant w/ `logDraftPick` |
| `sentiment` | -0.027 | -0.096 | -0.077 | drop — noisy zero-fill |
| `injury` | -0.011 | -0.032 | -0.027 | drop |
| `consensus` | -0.008 | -0.021 | +0.011 | marginal |
| `all_numeric` | -0.014 | -0.039 | -0.044 | drop |

`pdfRankOverallMean` is the only RB winner, but it's a decisive one:
comparable in magnitude to the CFBD `collegeUsageOverall` add that was
already shipped (+0.029 R² when it was introduced).

### WR (baseline R²: 0.330 all yrs, 0.272 score≥22, 0.196 train≥22, n=455)

| Variant | ΔR² all yrs | ΔR² score≥22 | ΔR² train≥22 | Verdict |
|---|---:|---:|---:|---|
| `rank_only` | +0.000 | -0.005 | -0.009 | neutral — WR rank already well captured |
| `round_only` | -0.009 | -0.046 | -0.009 | drop |
| `sentiment` | **+0.006** | **+0.004** | **+0.021** | **consistent add** |
| `injury` | -0.007 | -0.027 | -0.015 | drop |
| `consensus` | -0.005 | -0.024 | -0.006 | drop |
| `all_numeric` | +0.003 | -0.010 | +0.010 | weaker than `sentiment` alone |

For WR the qualitative-text derived signal beats the numeric rank. Intuition:
WR draft-capital and college production already capture pre-draft talent
well, but analyst sentiment picks up softer signals (route-tree criticisms,
drops, separation concerns) that don't live in any other feature.

### TE (baseline R²: 0.356 all yrs, 0.454 score≥22, 0.360 train≥22, n=209)

| Variant | ΔR² all yrs | ΔR² score≥22 | ΔR² train≥22 | Verdict |
|---|---:|---:|---:|---|
| `rank_only` | -0.006 | -0.001 | **+0.025** | within-era add only |
| others | all negative or flat | | | |

Small sample (n=55 in the PDF era) — the train≥22 signal is encouraging but
not stable enough across regimes to justify a ship. Re-test after 2026/2027.

### QB (baseline R²: 0.334 all yrs, 0.285 score≥22, -0.04 train≥22, n=134)

The within-era baseline collapses because only **n=36** QB rookies have PDF
coverage. Every variant's Δ is dominated by noise. Revisit after the 2026
class ships — nothing actionable from this run.

## Findings — Post-Draft

Same story as pre-draft, shifted ~0.01 lower on the baselines:

| Position | Winning variant | ΔR² all yrs | ΔR² score≥22 |
|---|---|---:|---:|
| RB | `rank_only` | **+0.010** | **+0.024** |
| WR | `sentiment` | 0.000 | -0.009 |
| WR | `all_numeric` | +0.003 | -0.022 |
| TE | `rank_only` | -0.004 | +0.007 |
| QB | none stable | — | — |

## Gap-fill test

The existing `prospectOvlRank` / `prospectGrade` features are only ~40 %
covered and 0 % in 2025. I filled missing rows with `rank_overall_mean` /
`(10 − projected_round_mean)` from the PDF data, which touched 259 career
rows. **Result: ΔR² = 0.000 everywhere.**

That's because `prospectOvlRank` and `prospectGrade` aren't in today's
`PRE_DRAFT_FEATURES` / `POST_DRAFT_FEATURES` at all — so filling them has
nothing to propagate into. A useful follow-up would be to first re-ablate
whether `prospectOvlRank` is worth including *with* the PDF gap-fill; the
feature could jump from 40 % to ~60 % coverage, potentially tipping its A/B.

## QB round 3 — PDF-only bake-off → granular ablation (2026-04)

Triggered by the `docs/pdf-only-career-test.md` QB finding (PDF-only
n=36 R²=0.191 vs shipped n=36 R²=-0.040). Earlier rounds tested PDF
feature *groups* for QB and saw group-level hits on the full-history
metric; this round does single-feature-at-a-time + forward-selection
via `scripts/test_qb_beast_features.py` and ships per-model winners.

Shipped adds (cache v71→v72 / v3→v4):

| QB Model | New features | ΔR² (all-yrs) | Δ (2022-25 era) |
|---|---|---:|---|
| Pre-draft regression | `pdfRankOverallMean`, `pdfHasRank` | flat | **ρ +0.039 (score≥22), R² +0.077 (train≥22)** |
| Post-draft regression | `pdfRankOverallMean`, `pdfHasRank`, `pdfRankXPick`, `pdfRoundXActual` | **+0.002** | ρ +0.042 (score≥22) |
| Boom (gap) | `pdfRankOverallMean`, `pdfHasRank`, `athletic_production_gap` | ρ **+0.045** | ρ **+0.081 (recent)** |
| Bust (binary) | `pdfRankOverallMean`, `pdfHasRank` | AUC +0.0003 | AUC **+0.070 (recent)** |

Rejected candidates:
- `pdfHasData` (1 for every 2022-25 QB, 0 for pre-2022): pure era
  proxy, adds no signal at inference. Forward-select grabbed it as
  first add because it's within tolerance, but the follow-up ablation
  confirmed the real signal came from pdfRankOverallMean.
- `pdfProjectedRound`: -0.020 ΔR² all-yrs on both pre- and post-draft.
  Mostly redundant with `logDraftPick` but less stable.
- `pdfNWeaknesses` / `pdfNRedFlags` / `pdfSentimentNet` (text counts):
  all hurt the full-history R² by 0.01-0.02 for QB regression despite
  positive recent-era gains. Ship cost > ship benefit at n=134.
- `pdfRankSpread`: flat — most QBs have exactly one source-PDF rank,
  so max − min is constant 0.

Feature importance in the final model:
- Pre-draft: `pdfHasRank` is the 4th most important feature (8.0%
  gain), ahead of `draftClassDepth`. `pdfRankOverallMean` at 0.8%.
- Post-draft: `pdfRankXPick` is the 4th most important feature (7.9%),
  with the trio of scout-disagreement features (`pdfHasRank` 4.3%,
  `pdfRoundXActual` 4.0%) carrying combined ~16% of the model.
- Boom model: `athletic_production_gap` got zero gain in the final
  data pass, same phenomenon as the earlier QB bust features — LOSO-CV
  picks up the signal but the final-importance model can't split on
  a feature that's zero for 75% of the training sample. Noted here
  so maintainers don't drop it without re-checking CV.

Other positions (RB/WR/TE) verified unchanged through the v72/v4 bump.

## Shipped (2026-04)

Promoted to `scripts/train_career_models.py` via cache bump v69→v70
(pre-draft) and v1→v2 (post-draft). Attached in `load_career_rows` via
`_derive_pdf_features()` from `pdf-prospect-features-merged.json`.

| Position | Model | Added | Observed ΔR² (full training) |
|---|---|---|---|
| RB | pre-draft | `pdfRankOverallMean`, `pdfHasRank` | **+0.008** (0.377 → 0.385) |
| RB | post-draft | same (inherited) | **+0.010** |
| WR | pre-draft | `pdfNStrengths`, `pdfNWeaknesses`, `pdfNRedFlags`, `pdfSentimentNet` | **+0.005** (0.329 → 0.334) |
| WR | post-draft | (explicitly excluded — Δ-0.0003 all-yrs once team-context features dilute the sentiment signal) |  |
| QB / TE | both | none |  |

`pdfRankOverallMean` and `pdfHasRank` are treated as draft-capital-adjacent
inside the companion-model blend (WR/RB pre-draft) — the scout-rank pair
correlates with draft pick and, when included in the college-only
companion, pushed RB over the 4-feature activation threshold and
*reversed* the rank gain to -0.004. Excluding them from
`DRAFT_CAPITAL_KEYS` keeps the RB companion disabled (as intended) and
lets WR's companion stay pure college-production.

## Boom/Bust per-position refactor + disagreement features (2026-04 round 2)

Boom/bust feature lists used to be global across positions. The first
ablation round found per-position winners — RB post-draft `bust+weakness`
+0.051 AUC, but the same features hurt QB/TE at smaller samples. Round
2 splits the lists per-position (`BOOM_GAP_FEATURES_BY_POS` and
`BUST_FEATURES_BY_POS` in `train_career_models.py`) so each position
can ship the features that actually help it.

### Disagreement features

A new family of "two channels that should agree but don't" features.
Computed inside `_attach_disagreement_features()` after PDF features
land, with per-position z-scoring so a recruitRating reads relative to
position-mates, not the global pool:

| Feature | Definition | Story |
|---|---|---|
| `pdfRankXPick` | log(scout_rank) − log(NFL_pick) | NFL/scout disagreement; positive = scouts ranked worse than NFL pick (overdraft risk) |
| `pdfRoundXActual` | projected_round − actual_round | Same shape, round-units |
| `pdfRankSpread` | rank_max − rank_min across PDFs | Scout-internal disagreement (variance signal) |
| `recruit_production_gap` | z(recruitRating) − z(market_share) | High = recruit hype that didn't produce; low = late bloomer |
| `athletic_production_gap` | z(speedScore) − z(dominator_rating) | High = combine warrior with thin film (bust) |

Coverage: PDF-derived features (top three) are nonzero only for 2022-25
rookies. Production-vs-talent gaps are nonzero whenever both inputs
exist (~50-60% of historical rows).

### Per-position boom/bust ablation results

LOSO Spearman(ρ) for boom, AUC for bust. Δ vs the previous global
feature list:

| Position | Boom winner | ΔρBoom (all/recent) | Bust winner | ΔAUC (all/recent) |
|---|---|---|---|---|
| QB | none stable | — | `disagree_scout` (rank spread + rank-vs-pick + round-vs-actual) | **+0.021 / 0.000** |
| RB | none stable | — | `weakness + disagree_talent` (PDF weakness counts + recruit/athletic gaps) | **+0.019 / +0.028** |
| WR | `disagree_talent` (recruit/athletic gaps) | +0.007 / +0.022 (post) | `disagree_talent` (same pair) | **+0.006 / +0.027** (post) |
| TE | none stable (n=55 in PDF era) | — | none stable | — |

Importance signals after retraining (post-draft cache):
- WR bust: `athletic_production_gap` jumped to **#2 feature at 17.1%
  importance** (positive direction = bust signal). This is the largest
  per-position lift in the round-2 refactor.
- RB bust: `athletic_production_gap` 2.7%, `recruit_production_gap`
  1.8% (negative = consistent with "low recruit + high production = safer
  than the model thought"), `pdfNWeaknesses` 1.5%.
- QB bust: PDF disagreement features have nonzero LOSO lift (+0.021 AUC)
  but show zero gain in the final-data importance model — small QB
  sample (n=134) with PDF coverage of ~30% of rows means LightGBM with
  `extra_trees=True` can't reliably pick those features in the
  gain-importance pass. The LOSO models that drive per-player scoring
  do learn from them; documented here so future maintainers don't drop
  the features as "zero importance" without re-checking CV.

### Shipped per-position feature lists

```python
BOOM_GAP_FEATURES_BY_POS = {
    'QB': _GAP_BASE,
    'RB': _GAP_BASE,
    'WR': _GAP_BASE + ['recruit_production_gap', 'athletic_production_gap'],
    'TE': _GAP_BASE,
}
BUST_FEATURES_BY_POS = {
    'QB': _BUST_BASE + ['pdfRankSpread', 'pdfRankXPick', 'pdfRoundXActual'],
    'RB': _BUST_BASE + ['pdfNWeaknesses', 'pdfSentimentNet',
                        'recruit_production_gap', 'athletic_production_gap'],
    'WR': _BUST_BASE + ['recruit_production_gap', 'athletic_production_gap'],
    'TE': _BUST_BASE,
}
```

Cache bumped: career v70 → v71, postdraft v2 → v3.

## Original recommendations (preserved for context)

1. **Ship for RB (pre + post-draft):** add
   `['pdfRankOverallMean', 'pdfHasRank']` to the per-position feature list.
   +0.008/+0.010 R² on the full historical set, with no downside regime.
2. **Ship for WR (pre-draft):** add
   `['pdfNStrengths', 'pdfNWeaknesses', 'pdfNRedFlags', 'pdfSentimentNet']`.
   +0.006 R² all-yrs, +0.021 train-era.
3. **Hold for QB / TE** — sample too small (n=36 / n=55). Re-run this
   script after the 2026 class finalizes and again after 2027.
4. **Skip `pdfProjectedRound`** — dominated by `logDraftPick` and the
   missing-as-zero encoding creates a bimodal distribution that hurts the
   linear component of the ensemble.
5. **Skip gap-fill of `prospectOvlRank`** until that base feature is
   itself reintroduced to the model — filling a non-feature has no effect.

## Reproducing

```bash
pip3 install numpy pandas scikit-learn lightgbm scipy  # one-off

python3 scripts/test_pdf_career_features.py                # pre-draft
python3 scripts/test_pdf_career_features.py --post-draft   # post-draft
python3 scripts/test_pdf_career_features.py --pos RB       # single position
```

Outputs land in `public/data/pdf-career-ablation-{pre,post}draft.json`.
