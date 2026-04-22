#!/usr/bin/env python3
"""
Scout-boost formula comparison: test whether scaling by absolute
scout_z improves MAE over the gap_z-only formula currently shipping.

Five candidate formulas applied to the 2022-2024 first-round
scout-override cohort:

  A. gap_z only       (current)   boost = min(max(0, g - t)*c, cap)
  B. scout_z only                  boost = min(max(0, s - t)*c, cap)
  C. sum               (weighted)  boost = min((max(0,s-ts)*cs + max(0,g-tg)*cg), cap)
  D. scout-scaled gap              boost = min(max(0,g-tg) * min(s/2, 1.5), cap)
  E. min of the two                boost = min(min(max(0,s-ts), max(0,g-tg)) * c, cap)

    python3 scripts/sweep_scout_boost_formulas.py
"""

import json, statistics, itertools

POSITIONS = ['QB','RB','WR','TE']
ALPHA_Z = {'QB':2.2,'RB':2.0,'WR':2.4,'TE':1.6}

with open('public/data/model-cache-career-v72.json') as f:
    MODELS = json.load(f)['rookieCareerModels']

def scout(f):
    pdf = float(f.get('pdfRankOverallMean') or 0)
    hr = float(f.get('pdfHasRank') or 0)
    pdf_s = max(0.0, 1 - pdf/100.0) if hr else 0.0
    return (0.35*pdf_s + 0.20*float(f.get('recruitRating') or 0)
          + 0.20*(float(f.get('rspDotDraft') or 0)/100)
          + 0.15*(float(f.get('rspTierOrdinal') or 0)/10)
          + 0.10*(float(f.get('rspBreadthDraft') or 0)/100))

def prod(f):
    return 0.6*float(f.get('collegeUsageOverall') or 0) + 0.4*(float(f.get('collegeDominatorRating') or 0)/100)

def cohort():
    out = []
    for pos in POSITIONS:
        rows = MODELS[pos].get('backtestRows', [])
        s_vals = [scout(r.get('features') or {}) for r in rows]
        p_vals = [prod(r.get('features') or {}) for r in rows]
        sm, ss = statistics.mean(s_vals), statistics.stdev(s_vals) or 1
        pm, ps = statistics.mean(p_vals), statistics.stdev(p_vals) or 1
        for r in rows:
            if r['draftSeason'] < 2022 or r['draftSeason'] > 2024: continue
            if r['actualPPG'] <= 0: continue
            f = r.get('features') or {}
            pk = f.get('nflDraftPick') or 0; rd = f.get('nflDraftRound') or 0
            if not ((0 < rd <= 1) or (0 < pk <= 32)): continue
            sz = (scout(f)-sm)/ss; pz = (prod(f)-pm)/ps; gz = sz - pz
            if sz < ALPHA_Z[pos] or gz < 1.0 or pz < -1.5: continue
            out.append({'name':r['name'],'pos':pos,'season':r['draftSeason'],
                        'pred':r['predictedPPG'] - 0,  # revert boost IF already applied; using rebased pred below
                        'actual':r['actualPPG'],'sz':sz,'pz':pz,'gz':gz})
    return out

# CRITICAL: the current trainer applies the gap_z boost to predictedPPG. For a
# clean formula comparison we need the UN-BOOSTED pred. Recompute it.
def unboosted(row):
    boost = min(max(0, row['gz'] - 0.5) * 1.0, 2.0)
    return row['pred'] - boost

coh = cohort()
for r in coh:
    r['pred_base'] = round(unboosted(r), 2)

def metrics(rows):
    if not rows: return (0,0,0)
    d = [r['actual'] - r['pred_adj'] for r in rows]
    mae = sum(abs(x) for x in d)/len(d)
    bias = sum(d)/len(d)
    mean_a = sum(r['actual'] for r in rows)/len(rows)
    ss_tot = sum((r['actual']-mean_a)**2 for r in rows) or 1
    ss_res = sum(x**2 for x in d)
    return mae, bias, 1-ss_res/ss_tot

# Baseline (no boost at all)
for r in coh: r['pred_adj'] = r['pred_base']
m0, b0, r0 = metrics(coh)
print(f'Baseline (no boost):  MAE={m0:.3f}  bias={b0:+.2f}  R²={r0:+.3f}')
print()

def search(name, boost_fn, grid):
    best = (float('inf'), None, None, None)
    for params in grid:
        for r in coh:
            b = boost_fn(r, *params)
            r['pred_adj'] = r['pred_base'] + b
        m, bi, r2 = metrics(coh)
        if m < best[0]: best = (m, bi, r2, params)
    m, bi, r2, p = best
    print(f'  {name:<30}  best params={p}  MAE={m:.3f} (Δ{m-m0:+.3f})  bias={bi:+.2f}  R²={r2:+.3f}')
    return best

# A: gap_z only (current) — retest for sanity
search('A  gap_z only (current)',
       lambda r, t, c, cap: min(max(0, r['gz']-t)*c, cap),
       list(itertools.product([0.3,0.5,0.8,1.0], [0.5,0.8,1.0,1.2], [1.5,2.0,2.5,3.0])))

# B: scout_z only
search('B  scout_z only',
       lambda r, t, c, cap: min(max(0, r['sz']-t)*c, cap),
       list(itertools.product([1.0,1.3,1.5,1.8,2.0], [0.3,0.5,0.8,1.0], [1.5,2.0,2.5,3.0])))

# C: weighted sum of scout and gap
search('C  sum (scout + gap)',
       lambda r, ts, cs, tg, cg, cap: min(max(0, r['sz']-ts)*cs + max(0, r['gz']-tg)*cg, cap),
       list(itertools.product([1.3,1.5,1.8], [0.3,0.5], [0.3,0.5,0.8], [0.3,0.5,0.8], [2.0,3.0])))

# D: scout-scaled gap
search('D  scout-scaled gap',
       lambda r, tg, cap, cscale: min(max(0, r['gz']-tg) * min(r['sz']*cscale, 2.0), cap),
       list(itertools.product([0.3,0.5,0.8,1.0], [1.5,2.0,2.5,3.0], [0.3,0.5,0.7])))

# E: min of gap and scout contributions
search('E  min (gap, scout)',
       lambda r, ts, tg, c, cap: min(min(max(0, r['sz']-ts), max(0, r['gz']-tg)) * c, cap),
       list(itertools.product([1.0,1.3,1.5,1.8], [0.3,0.5,0.8,1.0], [0.5,0.8,1.0,1.2], [1.5,2.0,2.5,3.0])))

# Detailed view of the best formula against the current one: show what each
# WR receives per formula so we can see where the orderings differ.
print('\n=== WR cohort, boost by formula (best-tuned params) ===')
print(f'  {"name":<22} pred  actual  sz    gz    A_gap  B_scout  C_sum')
for r in [x for x in coh if x['pos']=='WR']:
    a = min(max(0, r['gz']-0.5)*1.0, 2.0)
    b = min(max(0, r['sz']-1.5)*1.0, 2.0)  # typical scout-only tune
    c = min(max(0, r['sz']-1.5)*0.5 + max(0, r['gz']-0.5)*0.5, 2.0)
    print(f'  {r["name"]:<22} {r["pred_base"]:>5.1f}  {r["actual"]:>5.1f}  {r["sz"]:>4.2f}  {r["gz"]:>4.2f}  {a:>+4.1f}  {b:>+4.1f}  {c:>+4.1f}')
