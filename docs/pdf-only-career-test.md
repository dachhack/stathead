# PDF-Only Rookie Career Model — How Much Is In The Beast Alone?

Runner: `scripts/test_pdf_only_career.py`
Raw results: `public/data/pdf-only-career-test.json`

Trains a best-2-of-3 rookie career PPG model per position using ONLY
features derivable from The Beast scouting PDFs — no draft pick, no
combine, no college stats, no CFBD recruit/usage data. Restricted to
the PDF era (2022-2025 draft classes), so sample sizes per position are
QB=36, RB=79, WR=116, TE=55. LOSO-by-season (3 train / 1 test each fold).

Features used (12 per position, trimmed to 10 for RB/TE where per-class
scout counts are low):

| Feature | Source |
|---|---|
| `pdfRankOverallMean` | Scout consensus overall rank |
| `pdfRankOverallMin` / `Max` | Best / worst rank across source PDFs |
| `pdfRankSpread` | Max − min (scout disagreement) |
| `pdfProjectedRound` | Scout's projected draft round |
| `pdfHasData` / `pdfHasRank` / `pdfHasRound` | Missing-data indicators |
| `pdfNStrengths` | Count of strengths bullets |
| `pdfNWeaknesses` | Count of weaknesses bullets |
| `pdfNRedFlags` | Count of red-flag bullets |
| `pdfSentimentNet` | strengths − weaknesses − 2 × red_flags |

## Comparisons

| Variant | Features |
|---|---|
| `draft_pick` | `logDraftPick` + `nflDraftPick` only — lower-bound baseline |
| `pdf_only` | PDF features only (no draft capital) |
| `pdf_plus_pick` | PDF features + `logDraftPick` |
| `shipped_full` | Current `PRE_DRAFT_FEATURES[pos]` — upper-bound reference |

## Results

### QB (n=36)

| Variant | R² | MAE | ρ |
|---|---:|---:|---:|
| draft_pick | -0.033 | 4.70 | 0.282 |
| **pdf_only** | **0.191** | **4.52** | **0.542** |
| pdf_plus_pick | 0.174 | 4.33 | 0.460 |
| shipped_full | -0.040 | 5.06 | 0.213 |

**The Beast alone beats every other variant for QB.** At n=36 the
shipped 6-feature QB model (logDraftPick + draftClassDepth +
collegeQBR2yr + …) is noise; PDF features have a stable signal.
Top importance: `pdfNStrengths` (39%), `pdfProjectedRound` (32%).
The number of scout-identified strengths is the single strongest
QB career-PPG predictor in this experiment.

Caveat: n=36 is small. The Spearman ρ of 0.54 is genuinely informative
(this ranking held across four holdout seasons), but R² confidence
intervals are wide. The result doesn't mean PDF-only ships as the QB
model — it means the current QB feature list is underperforming its
potential on the recent sample and PDF features deserve a place in it.

### RB (n=79)

| Variant | R² | MAE | ρ |
|---|---:|---:|---:|
| **draft_pick** | **0.228** | **3.86** | **0.417** |
| pdf_only | -0.015 | 4.53 | 0.190 |
| pdf_plus_pick | 0.209 | 4.04 | 0.379 |
| shipped_full | 0.222 | 3.98 | 0.407 |

Draft capital already captures most of the RB signal. The Beast alone
is worse than no model (R² < 0), and adding Beast to pick makes it
slightly worse (over-featured for n=79). `pdfProjectedRound` is the
dominant PDF feature (49% importance) because it's mostly a proxy for
where the NFL will pick — which is already in `logDraftPick`.

### WR (n=116)

| Variant | R² | MAE | ρ |
|---|---:|---:|---:|
| draft_pick | 0.241 | 2.96 | 0.416 |
| pdf_only | 0.165 | 3.13 | 0.376 |
| **pdf_plus_pick** | **0.244** | **2.95** | **0.436** |
| shipped_full | 0.217 | 2.96 | 0.428 |

WR is the one position where PDF + pick slightly edges out the shipped
full model on the recent sample (R² +0.027 vs shipped, +0.003 vs pure
draft pick). This suggests some of the CFBD / college-production
features in the shipped model are overfit on historical rows and don't
generalize perfectly to 2022-25 — scout consensus is a cleaner signal
for the modern WR class.

Top PDF importance: `pdfHasRank` (25%), `pdfRankOverallMean` (15%),
`pdfRankOverallMin/Max` (12% each). The rank-triple carries most of
the signal; sentiment and red-flag counts are secondary (8% each).

### TE (n=55)

| Variant | R² | MAE | ρ |
|---|---:|---:|---:|
| **draft_pick** | **0.318** | **2.18** | **0.570** |
| pdf_only | 0.138 | 2.38 | 0.310 |
| pdf_plus_pick | 0.233 | 2.24 | 0.439 |
| shipped_full | 0.195 | 2.55 | 0.440 |

Draft pick alone is a better TE model than anything else — and is
better than the shipped 6-feature TE model on the recent sample.
`pdfHasRank` dominates PDF importance (65%) because many TE prospects
don't get an overall rank in The Beast at all; the indicator of "was
this player on anyone's board?" itself is most of the signal.

## Takeaways

1. **The Beast has real QB signal that the current model isn't using.**
   `pdf_only` R²=0.191 vs `shipped_full` R²=-0.040 on the same n=36
   sample is too large a gap to ignore. The QB feature list in
   `train_career_models.py` was intentionally kept PDF-free earlier
   because n=36 felt too small to trust an A/B — this direct
   PDF-only bake-off shows the signal is there even at small n.
   Worth a follow-up: add `pdfNStrengths` + `pdfProjectedRound` to the
   QB pre-draft feature list (or test other PDF features explicitly)
   and verify the full-history R² doesn't regress.

2. **For RB/TE, draft capital dominates the Beast.** Scouts and NFL
   teams largely agree on RB/TE value; the marginal info in the PDF
   is mostly already priced into the draft pick. This matches the
   original per-position A/B — PDF features helped WR (via sentiment)
   and RB (via rank + disagreement-for-bust), but neither QB nor TE
   showed a clean positive signal in the shipped-model context. TE
   especially is tiny (n=55 recent) so the conclusion is
   sample-limited.

3. **WR's shipped model may be slightly over-featured on modern rookies.**
   `pdf_plus_pick` (13 features) edges out `shipped_full` (16 features)
   on the 2022-25 subset. A focused feature-count trim sweep on the
   WR pre-draft feature list against the recent-era subset would be a
   reasonable next step.

4. **`pdfProjectedRound` is mostly a draft-pick proxy** — it shows up as
   a dominant feature in every PDF-only model but loses most of its
   importance when `logDraftPick` is added. Still useful because it's
   available **before** the draft, making it a sensible pre-draft
   feature if we wanted an ADP-blind version of the model.

## Reproducing

```bash
python3 scripts/test_pdf_only_career.py            # all positions
python3 scripts/test_pdf_only_career.py --pos QB   # single position
```

Output JSON: `public/data/pdf-only-career-test.json`.
