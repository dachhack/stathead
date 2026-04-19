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

## Recommendations

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
