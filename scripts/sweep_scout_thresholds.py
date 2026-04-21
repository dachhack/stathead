#!/usr/bin/env python3
"""
Grid-search scout-override thresholds per position, with named detail.

For each candidate alpha_z threshold, apply the first-round scout
override to backtest rows (2022+ classes) and report:
  - number of Alphas flagged
  - historical hit rate at three PPG floors
  - which named players are included at that threshold

Floors per position (realistic fantasy "Alpha-year" bars):
  QB  16  — top-12 QB season
  RB  13  — RB1 territory
  WR  12  — WR1 territory
  TE  8   — TE1 territory

    python3 scripts/sweep_scout_thresholds.py
"""

import json
import statistics

POSITIONS = ['QB', 'RB', 'WR', 'TE']
ALPHA_FLOOR = {'QB': 16.0, 'RB': 13.0, 'WR': 12.0, 'TE': 8.0}

with open('public/data/model-cache-career-v72.json') as f:
    MODELS = json.load(f)['rookieCareerModels']

def scout_composite(feats):
    pdf_rank = float(feats.get('pdfRankOverallMean') or 0)
    has_pdf  = float(feats.get('pdfHasRank') or 0)
    pdf_score = max(0.0, 1 - pdf_rank/100.0) if has_pdf else 0.0
    return (0.35 * pdf_score
          + 0.20 * float(feats.get('recruitRating') or 0)
          + 0.20 * (float(feats.get('rspDotDraft') or 0) / 100.0)
          + 0.15 * (float(feats.get('rspTierOrdinal') or 0) / 10.0)
          + 0.10 * (float(feats.get('rspBreadthDraft') or 0) / 100.0))

def prod_composite(feats):
    return (0.6 * float(feats.get('collegeUsageOverall') or 0)
          + 0.4 * (float(feats.get('collegeDominatorRating') or 0) / 100.0))

def percentile_tier(pctl):
    if   pctl >= 95: return 1
    elif pctl >= 85: return 2
    elif pctl >= 70: return 3
    elif pctl >= 50: return 4
    elif pctl >= 25: return 5
    return 6

def score_rows(pos, alpha_z, bluechip_z=1.3, gap_z_min=1.0, prod_z_min=-1.5):
    """Return (final_alpha_rows, final_bluechip_rows) after override."""
    rows = MODELS[pos].get('backtestRows', [])
    s_vals = [scout_composite(r.get('features') or {}) for r in rows]
    p_vals = [prod_composite(r.get('features') or {})  for r in rows]
    s_m = statistics.mean(s_vals); s_s = statistics.stdev(s_vals) or 1
    p_m = statistics.mean(p_vals); p_s = statistics.stdev(p_vals) or 1
    alphas, bluechips = [], []
    for r in rows:
        if r['draftSeason'] < 2022: continue
        pctl_tier = percentile_tier(r.get('percentile', 0))
        # Base-percentile Alphas always count
        if pctl_tier == 1:
            alphas.append((r, 'pctl'))
            continue
        if pctl_tier == 2:
            bluechips.append((r, 'pctl'))
            # Might still get upgraded to Alpha via scout
        feats = r.get('features') or {}
        pick = int(feats.get('nflDraftPick') or 0)
        round_ = int(feats.get('nflDraftRound') or 0)
        if not ((0 < round_ <= 1) or (0 < pick <= 32)):
            continue
        sc_z = (scout_composite(feats) - s_m) / s_s
        pr_z = (prod_composite(feats) - p_m) / p_s
        if sc_z - pr_z < gap_z_min or pr_z < prod_z_min:
            continue
        if sc_z >= alpha_z and pctl_tier > 1:
            alphas.append((r, f'override sz={sc_z:.2f}'))
        elif sc_z >= bluechip_z and pctl_tier > 2:
            bluechips.append((r, f'override sz={sc_z:.2f}'))
    return alphas, bluechips

def hit_rate(rows, floor):
    scored = [(r, s) for (r, s) in rows if r['actualPPG'] > 0]
    if not scored: return 0, 0
    hits = sum(1 for (r, _) in scored if r['actualPPG'] >= floor)
    return hits, len(scored)

for pos in POSITIONS:
    print(f'\n{"="*78}\n  {pos}  (alpha_floor={ALPHA_FLOOR[pos]} PPG)\n{"="*78}')
    for az in [1.4, 1.8, 2.0, 2.2, 2.4, 2.6, 2.8]:
        alphas, bluechips = score_rows(pos, az)
        hits, scored = hit_rate(alphas, ALPHA_FLOOR[pos])
        pct = hits/scored*100 if scored else 0
        # Separate by source
        pctl_n = sum(1 for _, s in alphas if s == 'pctl')
        ovr_n  = len(alphas) - pctl_n
        print(f'\n  alpha_z={az} → {len(alphas)} Alphas ({pctl_n} via percentile, {ovr_n} via override)  |  '
              f'{hits}/{scored} beat {ALPHA_FLOOR[pos]}+  ({pct:.0f}%)')
        # List names with actuals, sorted by year then pred
        for (r, source) in sorted(alphas, key=lambda x: (x[0]['draftSeason'], -x[0]['predictedPPG'])):
            tag = '★' if r['actualPPG'] >= ALPHA_FLOOR[pos] else '✗' if r['actualPPG'] > 0 else '?'
            marker = '[pctl]' if source == 'pctl' else '[ovr]'
            actual = f'actual={r["actualPPG"]:.1f}' if r['actualPPG'] > 0 else 'actual=—'
            print(f'    {tag} {marker} {r["name"]:<26} {r["draftSeason"]}  pred={r["predictedPPG"]:>5.1f}  {actual}')
