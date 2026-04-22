#!/usr/bin/env python3
"""
Grid-search the scout-override prediction boost.

For each (threshold, coeff, cap) triple, applies
    boost = max(0, gap_z - threshold) * coeff, capped at `cap`
to every scout-override-triggered first-round rookie in the
2022-2024 backtest (classes with actuals) and measures:

  MAE   — mean absolute error (actual − predicted) before vs after
  R²    — 1 - SSres / SStot on the override cohort
  bias  — mean (actual − predicted) — positive means model is
          systematically under-predicting this cohort

Per-position grid plus a combined "all positions" view.

    python3 scripts/sweep_scout_prediction_boost.py
"""

import json
import statistics
import math

POSITIONS = ['QB', 'RB', 'WR', 'TE']
ALPHA_Z = {'QB': 2.2, 'RB': 2.0, 'WR': 2.4, 'TE': 1.6}

with open('public/data/model-cache-career-v72.json') as f:
    MODELS = json.load(f)['rookieCareerModels']

def scout(f):
    pdf_rank = float(f.get('pdfRankOverallMean') or 0)
    has_pdf = float(f.get('pdfHasRank') or 0)
    pdf_score = max(0.0, 1 - pdf_rank/100.0) if has_pdf else 0.0
    return (0.35 * pdf_score + 0.20 * float(f.get('recruitRating') or 0)
          + 0.20 * (float(f.get('rspDotDraft') or 0) / 100.0)
          + 0.15 * (float(f.get('rspTierOrdinal') or 0) / 10.0)
          + 0.10 * (float(f.get('rspBreadthDraft') or 0) / 100.0))

def prod(f):
    return (0.6 * float(f.get('collegeUsageOverall') or 0)
          + 0.4 * (float(f.get('collegeDominatorRating') or 0) / 100.0))

def override_cohort(pos):
    """All first-round 2022-2024 rookies in `pos` where the override fires + actuals exist."""
    rows = MODELS[pos].get('backtestRows', [])
    s_vals = [scout(r.get('features') or {}) for r in rows]
    p_vals = [prod(r.get('features') or {})  for r in rows]
    s_m, s_s = statistics.mean(s_vals), statistics.stdev(s_vals) or 1
    p_m, p_s = statistics.mean(p_vals), statistics.stdev(p_vals) or 1
    out = []
    for r in rows:
        if r['draftSeason'] < 2022 or r['draftSeason'] > 2024: continue
        if r['actualPPG'] <= 0: continue
        f = r.get('features') or {}
        pk = f.get('nflDraftPick') or 0
        round_ = f.get('nflDraftRound') or 0
        if not ((0 < round_ <= 1) or (0 < pk <= 32)): continue
        sz = (scout(f) - s_m) / s_s
        pz = (prod(f)  - p_m) / p_s
        gz = sz - pz
        if sz < ALPHA_Z[pos] or gz < 1.0 or pz < -1.5: continue
        out.append({
            'name': r['name'], 'pos': pos, 'season': r['draftSeason'],
            'pred': r['predictedPPG'], 'actual': r['actualPPG'],
            'scoutZ': sz, 'prodZ': pz, 'gapZ': gz,
        })
    return out

def metrics(rows):
    if not rows: return (None, None, None)
    diffs = [r['actual'] - r['pred'] for r in rows]
    mae = sum(abs(d) for d in diffs) / len(diffs)
    bias = sum(diffs) / len(diffs)
    mean_actual = sum(r['actual'] for r in rows) / len(rows)
    ss_tot = sum((r['actual'] - mean_actual) ** 2 for r in rows)
    ss_res = sum(d ** 2 for d in diffs)
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0
    return mae, bias, r2

# Collect cohorts
cohorts = {pos: override_cohort(pos) for pos in POSITIONS}
all_rows = [r for pos in POSITIONS for r in cohorts[pos]]
print(f'Scout-override first-round rookies 2022-2024 with actuals:')
for pos in POSITIONS:
    print(f'  {pos}: n={len(cohorts[pos])}')
print(f'  total: n={len(all_rows)}')
print()

# Show cohort details
for pos in POSITIONS:
    if not cohorts[pos]: continue
    print(f'=== {pos} cohort ===')
    for r in sorted(cohorts[pos], key=lambda r: -r['gapZ']):
        err = r['actual'] - r['pred']
        print(f'  {r["name"]:<22} {r["season"]}  pred={r["pred"]:>5.1f}  actual={r["actual"]:>5.1f}  err={err:>+5.1f}  gapZ={r["gapZ"]:>+4.2f}')
    m, b, r2 = metrics(cohorts[pos])
    print(f'  base: MAE={m:.2f}  bias={b:+.2f}  R²={r2:+.3f}')
    print()

# Grid sweep
print('\n=== Grid sweep (ALL positions combined) ===')
print(f'  {"thresh":>6} {"coeff":>5} {"cap":>4}  {"MAE":>5} {"ΔMAE":>6}  {"bias":>5} {"Δbias":>6}  {"R²":>6} {"ΔR²":>6}')
base_mae, base_bias, base_r2 = metrics(all_rows)
print(f'  {"baseline":<17}  {base_mae:>5.2f}         {base_bias:>+5.2f}          {base_r2:>+6.3f}')

best = (float('inf'), None)
results_all = []
for thresh in [0.5, 0.8, 1.0, 1.2, 1.5, 1.8, 2.0]:
    for coeff in [0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0]:
        for cap in [0.5, 1.0, 1.5, 2.0, 3.0]:
            adjusted = []
            for r in all_rows:
                boost = max(0, r['gapZ'] - thresh) * coeff
                boost = min(boost, cap)
                adjusted.append({**r, 'pred': r['pred'] + boost})
            m, b, r2 = metrics(adjusted)
            results_all.append((thresh, coeff, cap, m, b, r2))
            if m < best[0]: best = (m, (thresh, coeff, cap, m, b, r2))

# Top 10 by MAE
print('\nTop 10 configs (all positions combined) by lowest MAE:')
for cfg in sorted(results_all, key=lambda r: r[3])[:10]:
    t, c, cp, m, b, r2 = cfg
    print(f'  th={t:<4} coeff={c:<4} cap={cp:<4}  MAE={m:.3f} (Δ{m-base_mae:+.3f})  bias={b:+.2f}  R²={r2:+.3f}')

# Per-position best
print('\n=== Per-position best (by MAE improvement) ===')
for pos in POSITIONS:
    coh = cohorts[pos]
    if len(coh) < 2: continue
    base_m, base_b, base_r2 = metrics(coh)
    pos_results = []
    for thresh in [0.5, 0.8, 1.0, 1.2, 1.5, 1.8, 2.0]:
        for coeff in [0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0]:
            for cap in [0.5, 1.0, 1.5, 2.0, 3.0]:
                adjusted = []
                for r in coh:
                    boost = min(max(0, r['gapZ'] - thresh) * coeff, cap)
                    adjusted.append({**r, 'pred': r['pred'] + boost})
                m, b, r2 = metrics(adjusted)
                pos_results.append((thresh, coeff, cap, m, b, r2))
    pos_results.sort(key=lambda r: r[3])
    print(f'\n  {pos} (n={len(coh)}, baseline MAE={base_m:.2f}, bias={base_b:+.2f})')
    for cfg in pos_results[:3]:
        t, c, cp, m, b, r2 = cfg
        print(f'    th={t:<4} coeff={c:<4} cap={cp:<4}  MAE={m:.3f} (Δ{m-base_m:+.3f})  bias={b:+.2f}')
