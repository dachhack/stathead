# PDF-Only Rookie Career Models — Feature Reference

Per-position reference for the Beast-only rookie career models trained
by `scripts/test_pdf_only_career.py`. Covers:

1. What each PDF feature means and how it's computed.
2. Per-position model metrics vs. baselines.
3. Per-position feature importance with interpretation.

Source data: `public/data/pdf-prospect-features-merged.json`, extracted
from The Beast PDFs (2022-2025) by `scripts/extract_pdf_features.py` +
`scripts/merge_pdf_features.py`. Raw results from this doc live in
`public/data/pdf-only-career-test.json`.

---

## 1. Feature catalog

Each PDF feature below is derived in `train_career_models.py`'s
`_derive_pdf_features()` (Python path) and mirrored in
`scripts/precompute-features.ts` for 2026 prospect scoring.

### Rank features

| Feature | Definition | Lower-is-better? | Notes |
|---|---|---|---|
| `pdfRankOverallMean` | Mean of overall prospect rank across source PDFs | Yes | NaN if no PDF ranked the player — zero-filled with `pdfHasRank=0` |
| `pdfRankOverallMin` | Minimum (best) rank across sources | Yes | When only one source ranks, `Min=Max=Mean` |
| `pdfRankOverallMax` | Maximum (worst) rank across sources | Yes | Gap from Min indicates analyst disagreement |
| `pdfRankSpread` | `Max − Min` | n/a | 0 when only one source ranks; larger = more analyst disagreement |
| `pdfProjectedRound` | Mean projected draft round across sources | Yes | Before-the-fact estimate of where the NFL will pick the player |

### Missing-data indicators (paired with the continuous field above)

| Feature | Definition | Why it exists |
|---|---|---|
| `pdfHasData` | 1 if any PDF covers the player, else 0 | "Was this player even a scouting target?" Useful at positions where PDF coverage is thin (TE, late-round QB). |
| `pdfHasRank` | 1 if `pdfRankOverallMean` is populated, else 0 | A player can appear in The Beast without an overall rank (position-group writeup only). |
| `pdfHasRound` | 1 if `pdfProjectedRound` is populated, else 0 | Same idea for projected round. |

Tree models (LightGBM) need these paired with continuous fields so
they can distinguish a legitimate low rank (`Mean=3`) from a missing
value (`Mean=0`).

### Qualitative-text counts

These come from the bullet-list sections of each player's Beast writeup.

| Feature | Definition | Signal |
|---|---|---|
| `pdfNStrengths` | Count of bullets under "strengths" | Proxy for how much positive analysis the scout wrote. More = more to like. |
| `pdfNWeaknesses` | Count of bullets under "weaknesses" | More = more concerns. |
| `pdfNRedFlags` | Count of bullets under "red flags" (injuries, character, production gaps) | Red flags weighted heavier than weaknesses because the label itself is selective. |
| `pdfSentimentNet` | `#strengths − #weaknesses − 2 × #red_flags` | Single summary score; red flags weighted 2× (a flagged concern is stronger signal than a plain weakness bullet). |

Note: bullet counts aren't sentiment analysis of the text — just how
many items the analyst wrote in each category. A player with one
detailed strength paragraph and three terse weaknesses still reads as
"more weaknesses" here.

---

## 2. Per-position results

LOSO by draft season (2022-2025). Per-position hyperparameters match
`POS_HYPERPARAMS` in `train_career_models.py`. Comparisons:

| Variant | Features used |
|---|---|
| `draft_pick` | `logDraftPick + nflDraftPick` (NFL's verdict only) |
| `pdf_only` | Every PDF feature above (Beast's verdict only) |
| `pdf_plus_pick` | PDF features + `logDraftPick` |
| `shipped_full` | `PRE_DRAFT_FEATURES[pos]` from `train_career_models.py` |

---

### QB — n=36

| Variant | R² | MAE | ρ (Spearman) | #features |
|---|---:|---:|---:|---:|
| draft_pick | -0.033 | 4.70 | 0.282 | 2 |
| **pdf_only** | **0.191** | **4.52** | **0.542** | 12 |
| pdf_plus_pick | 0.174 | 4.33 | 0.460 | 13 |
| shipped_full | -0.040 | 5.06 | 0.213 | 6 |

`pdf_only` is the winner across R², MAE, and rank correlation. At
n=36 the shipped 6-feature QB list (logDraftPick, draftClassDepth,
collegeQBR2yr, etc.) is noise.

**Feature importance (pdf_only model):**

| Feature | Gain % | Dir. | Interpretation |
|---|---:|:---:|---|
| `pdfNStrengths` | 39.3% | ↑ | The single strongest QB predictor here. More scout-identified strengths → higher NFL PPG. The count proxies analyst depth-of-conviction. |
| `pdfProjectedRound` | 32.0% | ↓ | Lower round = earlier pick = higher PPG. Mostly a draft-pick proxy available pre-draft. |
| `pdfRankOverallMax` | 8.9% | ↑ | Combined with `Min`, lets the tree learn analyst disagreement bands. Direction flips around the has-rank boundary; treat as a splitting variable, not a monotone signal. |
| `pdfRankOverallMin` | 8.3% | ↑ | Same story as Max. |
| `pdfSentimentNet` | 6.2% | ↑ | Net qualitative score. Small contribution on top of the raw `pdfNStrengths` signal. |
| `pdfRankOverallMean` | 4.9% | ↑ | Direction appears positive at the full-sample level (many QBs have rank=0 via missing data), but the tree uses this as a threshold, not linearly. |
| `pdfNRedFlags` | 0.4% | ↓ | Minor. |
| others | 0% | — | `pdfRankSpread`, `pdfProjectedRound` missingness indicators, `pdfNWeaknesses`, etc. got no gain in the final-data model. |

The gain concentration on `pdfNStrengths` is surprising — it suggests
the scout's analytical effort (more strengths = more to write about)
is itself predictive of QB NFL translation.

---

### RB — n=79

| Variant | R² | MAE | ρ | #features |
|---|---:|---:|---:|---:|
| **draft_pick** | **0.228** | **3.86** | **0.417** | 2 |
| pdf_only | -0.015 | 4.53 | 0.190 | 10 |
| pdf_plus_pick | 0.209 | 4.04 | 0.379 | 11 |
| shipped_full | 0.222 | 3.98 | 0.407 | 6 |

The Beast alone is worse than no model. NFL draft position already
captures almost everything The Beast says about an RB.

**Feature importance (pdf_only model):**

| Feature | Gain % | Dir. | Interpretation |
|---|---:|:---:|---|
| `pdfProjectedRound` | 48.6% | ↓ | Scout's projected round dominates — it's mostly a draft-pick proxy. |
| `pdfHasRank` | 18.9% | ↑ | "Ranked vs unranked" matters for RB — unranked RBs tend to be camp bodies. |
| `pdfNRedFlags` | 14.6% | ↑ | Positive direction is likely noise at n=79 (more red flags → higher PPG is counterintuitive). The tree uses this as a threshold around 0. |
| `pdfRankOverallMean` | 12.4% | ↑ | Has some non-trivial signal once `HasRank=1` is true. |
| `pdfNStrengths` | 3.7% | ↓ | Negative direction is likely noise. |
| `pdfNWeaknesses` | 1.1% | ↑ | Minor. |
| `pdfSentimentNet` | 0.6% | ↓ | Basically unused. |
| others | 0% | — | |

Bottom line: the PDF-only RB model is essentially learning "was this
RB a Beast rankee at all, and if so how high?" — signal already
contained in the NFL draft pick.

---

### WR — n=116

| Variant | R² | MAE | ρ | #features |
|---|---:|---:|---:|---:|
| draft_pick | 0.241 | 2.96 | 0.416 | 2 |
| pdf_only | 0.165 | 3.13 | 0.376 | 12 |
| **pdf_plus_pick** | **0.244** | **2.95** | **0.436** | 13 |
| shipped_full | 0.217 | 2.96 | 0.428 | 16 |

`pdf_plus_pick` is the winner on the recent subset — slightly above
the shipped 16-feature WR model. PDF features carry real marginal WR
signal beyond what the draft pick captures.

**Feature importance (pdf_only model):**

| Feature | Gain % | Dir. | Interpretation |
|---|---:|:---:|---|
| `pdfHasRank` | 25.0% | ↑ | "Was this WR even on a Beast overall board?" — strong binary indicator of NFL-caliber WR. |
| `pdfRankOverallMean` | 15.3% | ↑ | Continuous rank signal among the ranked pool. |
| `pdfRankOverallMin` | 12.1% | ↑ | Best-case rank across PDFs. |
| `pdfRankOverallMax` | 11.9% | ↑ | Worst-case rank. Min + Max together let the tree learn analyst disagreement bands. |
| `pdfNStrengths` | 8.5% | ↑ | Count of scout-identified strengths. |
| `pdfNRedFlags` | 8.4% | ↑ | Positive direction likely represents "flagged but high-profile" players (the elite WRs get more detailed writeups of every concern). |
| `pdfProjectedRound` | 7.5% | ↓ | Scout's round estimate. |
| `pdfSentimentNet` | 6.1% | ↑ | Net qualitative sentiment. |
| `pdfNWeaknesses` | 5.2% | ↑ | Positive direction is probably "more words written → higher-profile player" artifact. |
| others | 0% | — | |

WR is the position where PDF features spread importance most evenly.
No single feature dominates — `pdfHasRank` leads at 25%, but the top
nine features all carry ≥5%. That's consistent with the larger sample
(n=116) letting the tree use more of the signal.

---

### TE — n=55

| Variant | R² | MAE | ρ | #features |
|---|---:|---:|---:|---:|
| **draft_pick** | **0.318** | **2.18** | **0.570** | 2 |
| pdf_only | 0.138 | 2.38 | 0.310 | 10 |
| pdf_plus_pick | 0.233 | 2.24 | 0.439 | 11 |
| shipped_full | 0.195 | 2.55 | 0.440 | 6 |

Draft pick dominates TE — every other variant is worse. But the
`pdf_plus_pick` / `shipped_full` gap (+0.038 R² for pdf_plus_pick) is
worth noting: the current 6-feature TE list underperforms a
PDF + single-pick model on recent data.

**Feature importance (pdf_only model):**

| Feature | Gain % | Dir. | Interpretation |
|---|---:|:---:|---|
| `pdfHasRank` | 65.0% | ↑ | Dominant. Many TE prospects aren't ranked overall in The Beast — the binary "ranked vs unranked" is almost all the model's signal. |
| `pdfRankOverallMean` | 13.1% | ↑ | Continuous rank among the ranked pool. |
| `pdfSentimentNet` | 8.5% | ↑ | Net qualitative score. |
| `pdfProjectedRound` | 7.3% | ↓ | Round proxy for pick. |
| `pdfNRedFlags` | 4.1% | ↑ | Same elite-writeup effect as WR. |
| `pdfNWeaknesses` | 1.9% | ↓ | Minor. |
| `pdfNStrengths` | 0.1% | ↑ | Effectively unused — TE strengths writeups too sparse to help at n=55. |
| others | 0% | — | |

TE has the most concentrated importance distribution. At n=55 with
~40% of players unranked in The Beast, the `pdfHasRank` binary is
overwhelming.

---

## 3. Cross-position summary

| Feature | QB | RB | WR | TE | Consistency |
|---|---:|---:|---:|---:|---|
| `pdfHasRank` | 0% | 19% | 25% | **65%** | Dominant at TE, strong at WR/RB, unused at QB (every QB is ranked). |
| `pdfRankOverallMean` | 5% | 12% | 15% | 13% | Consistent mid-importance across all four. |
| `pdfRankOverallMin` | 8% | 0% | 12% | 0% | Only useful when multiple sources exist (WR/QB). |
| `pdfRankOverallMax` | 9% | 0% | 12% | 0% | Same as Min — disagreement signal. |
| `pdfProjectedRound` | **32%** | **49%** | 7% | 7% | QB/RB use this as a pre-draft pick proxy; WR/TE get more pick signal elsewhere. |
| `pdfNStrengths` | **39%** | 4% | 9% | 0% | **QB-specific signal** — analyst effort correlates with QB translation uniquely. |
| `pdfNWeaknesses` | 0% | 1% | 5% | 2% | Consistently minor. |
| `pdfNRedFlags` | 0.4% | 15% | 8% | 4% | Useful for RB/WR/TE but direction is mixed — more a has-concerns splitter than a monotone signal. |
| `pdfSentimentNet` | 6% | 1% | 6% | 9% | Small but positive contribution where bullet counts aren't fully picked up individually. |
| `pdfHasData` | 0% | 0% | 0% | 0% | Every training row is from the PDF era; no variation. Kept for symmetry with the non-PDF-era training path. |
| `pdfHasRound` | 0% | 0% | 0% | 0% | Too redundant with `pdfProjectedRound` once that field is zero-filled. |
| `pdfRankSpread` | 0% | 0% | 0% | 0% | Min+Max already capture the spread; no marginal gain when both are in the feature set. |

Key patterns:

- **QB is unique**: `pdfNStrengths` and `pdfProjectedRound` together
  carry 72% of the importance. The qualitative-volume signal
  (`pdfNStrengths`) doesn't appear in any other position's top three.
- **TE is dominated by one binary** (`pdfHasRank`, 65%). Remove it
  and the model collapses — scouting coverage is too thin for the
  continuous features to find signal at n=55.
- **WR is the most balanced**. Large enough sample (n=116) that the
  tree uses most of the feature set.
- **RB signal is mostly a pick proxy** (`pdfProjectedRound` at 49%).
  The Beast doesn't add much for RBs beyond telling you where the NFL
  will pick them.

## 4. Caveats

1. **Sample sizes are small.** QB=36, TE=55, RB=79, WR=116. Feature
   importance numbers at this scale have wide confidence intervals —
   a re-run with different `lgb` seeds can swing top-feature gains
   by 5-10 points. Re-check after the 2026 class outcomes land.
2. **Gain-importance direction is a rough summary.** It's the Spearman
   of the feature against the target on the full sample. Tree models
   split at specific thresholds, so a feature can be "positive" in
   one band and "negative" in another. The direction column is a
   first-order interpretability aid, not a definitive sign.
3. **Zero-filled features distort the Spearman.** Many rank-family
   features are 0 for unranked players; the Spearman across the full
   sample mixes "missing vs ranked" with "rank=3 vs rank=30". The
   tree handles this fine (different splits for each regime), but
   the exported direction label can read counterintuitive.
4. **Importance sums to 100% only across the features the final
   LightGBM actually split on.** Features shown with 0% were in the
   candidate list but didn't get a single-split gain in the
   num_boost_round=60 training pass.

## 5. Reproducing

```bash
python3 scripts/test_pdf_only_career.py            # all four positions
python3 scripts/test_pdf_only_career.py --pos QB   # single position
```

Output: `public/data/pdf-only-career-test.json` — raw per-position
metrics + full feature importance lists.
