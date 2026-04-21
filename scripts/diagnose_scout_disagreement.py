#!/usr/bin/env python3
"""
Scout-disagreement diagnostic for the rookie career tier.

For each rookie, computes:
  scout_z       = normalized scout-consensus composite (pdf rank, recruit
                  rating, RSP DOT/tier/breadth) z-scored vs same-position cohort
  production_z  = normalized college-production composite
                  (collegeUsageOverall, collegeDominatorRating) z-scored
  gap_z         = scout_z − production_z
  base_tier     = tier from the model's predictedPPG (current system)
  scout_tier    = tier implied by the scout composite if it were the signal
  override_tier = min(base_tier, scout_tier)  (Alpha=1, Dart=6)

Players with gap_z >= 1.0 AND scout_tier < base_tier get upgraded.

Also simulates the rspTierOrdinal fix (maps Tier I-VII to ordinals, which
the current cache still has at 0 for most modern rookies).

    python3 scripts/diagnose_scout_disagreement.py
"""

import json
import re
import statistics
from collections import defaultdict
from pathlib import Path

POSITIONS = ['RB', 'WR', 'TE']
TIER_NAMES = {1:'Alpha', 2:'BlueChip', 3:'Starter', 4:'Flex', 5:'Waiver', 6:'Dart'}
TIER_SYM   = {1:'★', 2:'◆', 3:'●', 4:'○', 5:'·', 6:' '}

# PPG tier thresholds (from earlier analysis, same for RB/WR/TE)
PPG_THRESH = {
    'RB': [(1,14.0),(2,12.7),(3,10.0),(4,8.0),(5,6.0),(6,0)],
    'WR': [(1,13.5),(2,12.5),(3,10.5),(4,8.5),(5,6.5),(6,0)],
    'TE': [(1, 9.0),(2, 7.0),(3, 5.5),(4,4.5),(5,3.5),(6,0)],
}
def ppg_tier(pos, ppg):
    for tier, floor in PPG_THRESH[pos]:
        if ppg >= floor: return tier
    return 6

# Simulate the rspTierOrdinal fix — derive ordinal from raw PDF tiers
_RSP_TIER_ORDINAL = {
    'Franchise':10,'Legendary Performer':9,'Elite Producer':9,'Tier I':9,
    'Tier II':8,'Weekly Starter':8,'Starter':8,
    'Rotational Starter':7,'Rotational Starter Tier':7,'Tier III':7,
    'Flex Play':6,'Contributor':6,
    'Tier IV':5,'Reserve':5,'Cusp of Contributor and Reserve':5,
    'Tier V':4,'Developmental':4,'Developmental on Cusp of Reserve':4,
    'Benchwarmer':3,'Priority Free Agent':3,
    'Tier VI':2,'Waiver Wire Add':2,'Dart Throw':2,
    'Tier VII':1,'Street':1,
}
_RSP_PAREN_RE = re.compile(r'\s*\([^)]*\)\s*')
_RSP_ROUND_RE = re.compile(r'round', re.I)
def parse_rsp_tier_ord(tiers):
    best = 0
    for t in (tiers or []):
        label = _RSP_PAREN_RE.sub('', t).strip()
        if _RSP_ROUND_RE.search(label): continue
        best = max(best, _RSP_TIER_ORDINAL.get(label, 0))
    return best

def norm_pdf_name(n):
    n = n.lower().strip().replace('.', '').replace("'", "").replace('-', ' ')
    n = re.sub(r'\s+(sr|jr|iii|ii|iv)$', '', n).replace('  ', ' ')
    return n.strip()

# Load data
with open('public/data/pdf-prospect-features-merged.json') as f:
    pdf_list = json.load(f)
pdf_idx = {f"{norm_pdf_name(p['player_name'])}::{p['position']}": p for p in pdf_list}

with open('public/data/model-cache-career-v72.json') as f:
    pre = json.load(f)['rookieCareerModels']
with open('public/data/feature-matrix.json') as f:
    fm = json.load(f)

# Score each rookie
def rookie_rows(pos):
    rows = []
    for r in pre[pos].get('backtestRows', []):
        rows.append({
            'name': r['name'], 'position': pos, 'season': r['draftSeason'],
            'pred': r['predictedPPG'], 'actual': r['actualPPG'],
            'features': r.get('features', {}),
            'is_2026': False,
        })
    for p in fm.get('careerPredictions2026', []):
        if p.get('position') != pos: continue
        rows.append({
            'name': p['name'], 'position': pos, 'season': 2026,
            'pred': p.get('predictedCareerPPG', 0), 'actual': 0,
            'features': p.get('features', {}),
            'is_2026': True,
        })
    return rows

def scout_composite(r):
    """Scout-consensus score. Higher = more premium prospect."""
    f = r['features']
    # pdfRankOverallMean: lower is better (1 = top pick). Transform to 0-1 where 1 = top.
    pdf_rank = f.get('pdfRankOverallMean') or 0
    has_pdf = f.get('pdfHasRank') or 0
    pdf_score = max(0, 1 - pdf_rank/100) if has_pdf else 0
    # recruitRating: 0.7-1.0 scale, 5-star ~ 0.99
    recruit = (f.get('recruitRating') or 0)
    # RSP DOT: 0-100 scale
    rsp_dot = (f.get('rspDotDraft') or 0) / 100
    # RSP tier ordinal (fix applied): derive from PDF raw tiers if missing
    rsp_ord = f.get('rspTierOrdinal') or 0
    if rsp_ord == 0 and f.get('rspHasData'):
        nn = norm_pdf_name(r['name'])
        key = f'{nn}::{r["position"]}'
        entry = pdf_idx.get(key) or pdf_idx.get(nn)
        if entry:
            rsp_ord = parse_rsp_tier_ord(entry.get('tiers'))
    rsp_ord_score = rsp_ord / 10
    rsp_breadth = (f.get('rspBreadthDraft') or 0) / 100
    # Weighted scout composite. Weights match model importance ordering.
    return (0.35*pdf_score + 0.20*recruit + 0.20*rsp_dot +
            0.15*rsp_ord_score + 0.10*rsp_breadth)

def production_composite(r):
    """College-production score. Higher = more dominant college profile."""
    f = r['features']
    usage = (f.get('collegeUsageOverall') or 0)     # 0-1 scale
    dom = (f.get('collegeDominatorRating') or 0) / 100  # 0-1 scale
    return 0.6 * usage + 0.4 * dom

def zscore_list(vals):
    vals = [v for v in vals if v is not None]
    if len(vals) < 3: return 0, 1
    m = statistics.mean(vals)
    s = statistics.stdev(vals) or 1
    return m, s

for pos in POSITIONS:
    rows = rookie_rows(pos)
    # Per-position cohort moments (only include players with any scout data)
    scout_vals = [scout_composite(r) for r in rows]
    prod_vals  = [production_composite(r) for r in rows]
    s_m, s_s = zscore_list(scout_vals)
    p_m, p_s = zscore_list(prod_vals)
    for r in rows:
        sc = scout_composite(r)
        pr = production_composite(r)
        r['scout']   = sc
        r['prod']    = pr
        r['scout_z'] = (sc - s_m) / s_s
        r['prod_z']  = (pr - p_m) / p_s
        r['gap_z']   = r['scout_z'] - r['prod_z']
        r['base_tier']  = ppg_tier(pos, r['pred'])
        # Scout implied tier: map scout_z to a tier (z >= 1.5 = Alpha, etc.)
        if   r['scout_z'] >= 1.4: r['scout_tier'] = 1
        elif r['scout_z'] >= 0.9: r['scout_tier'] = 2
        elif r['scout_z'] >= 0.3: r['scout_tier'] = 3
        elif r['scout_z'] >= -0.3: r['scout_tier'] = 4
        elif r['scout_z'] >= -1.0: r['scout_tier'] = 5
        else: r['scout_tier'] = 6
        # Override only applies to first-round prospects — scout consensus
        # is most actionable when the NFL team also put premium capital on
        # the player. Late-round scout-darlings miss too often (Jalin Hyatt,
        # Keon Coleman) for the override to be trustworthy on them.
        pick  = r['features'].get('nflDraftPick') or 0
        round_ = r['features'].get('nflDraftRound') or 0
        is_r1 = (0 < round_ <= 1) or (pick and pick <= 32)
        if r['is_2026']:
            # 2026 prospects don't have nflDraftPick yet — fall back to
            # projected pick / projected round from the prospect grade.
            proj_pick = r['features'].get('projPick') or 999
            proj_round = r['features'].get('projRound') or 7
            is_r1 = (0 < proj_round <= 1) or (proj_pick and proj_pick <= 32)
        r['is_r1'] = is_r1
        r['override'] = r['base_tier']
        if (is_r1 and r['scout_tier'] < r['base_tier']
                and r['gap_z'] >= 1.0 and r['prod_z'] >= -1.5):
            r['override'] = r['scout_tier']

    print(f'\n================ {pos} — scout disagreement (top 25 gap_z) ================')
    print(f'  {"name":<26} {"yr":<4} {"pred":>5} {"actual":>6}   {"scoutZ":>6} {"prodZ":>6} {"gapZ":>6}   base → override')
    for r in sorted(rows, key=lambda x: -x['gap_z'])[:25]:
        arrow = f'{TIER_NAMES[r["base_tier"]]:<10} → {TIER_NAMES[r["override"]]}' if r['override'] != r['base_tier'] else f'{TIER_NAMES[r["base_tier"]]}'
        flag = ' ⬆' if r['override'] < r['base_tier'] else ''
        print(f'  {r["name"]:<26} {r["season"]:<4} {r["pred"]:>5.1f} {r["actual"]:>6.1f}   '
              f'{r["scout_z"]:>+6.2f} {r["prod_z"]:>+6.2f} {r["gap_z"]:>+6.2f}   {arrow}{flag}')

    # Aggregate upgrade stats
    upgrades = [r for r in rows if r['override'] != r['base_tier']]
    print(f'\n  Total upgrades: {len(upgrades)} / {len(rows)}')
    if upgrades:
        # Check historical: did they beat prediction?
        hist = [r for r in upgrades if r['actual'] > 0]
        if hist:
            mae_base = sum(abs(r['actual']-r['pred']) for r in hist)/len(hist)
            # "upgrade" implies model was too low, so we hope beat rate is high
            beat = sum(1 for r in hist if r['actual'] > r['pred'])
            print(f'  Historical upgrades (n={len(hist)}): beat_rate={beat/len(hist)*100:.0f}%  mean_actual={sum(r["actual"] for r in hist)/len(hist):.1f} vs mean_pred={sum(r["pred"] for r in hist)/len(hist):.1f}')

    # Specifically show Bijan / Jeanty / Love
    print()
    spotlight = ['Bijan Robinson','Jahmyr Gibbs','Ashton Jeanty','Jeremiyah Love',
                 'Ja\'Marr Chase','Marvin Harrison Jr.','Malik Nabers','Brock Bowers',
                 'Puka Nacua','Rashee Rice','Cooper Kupp','Justin Jefferson',
                 'Breece Hall','Saquon Barkley','Kyle Pitts Sr.']
    for name in spotlight:
        r = next((r for r in rows if r['name']==name), None)
        if r:
            arrow = f'{TIER_NAMES[r["base_tier"]]:<10} → {TIER_NAMES[r["override"]]}' if r['override'] != r['base_tier'] else f'{TIER_NAMES[r["base_tier"]]}'
            flag = ' ⬆' if r['override'] < r['base_tier'] else ''
            print(f'  SPOT {r["name"]:<26} {r["season"]:<4} pred={r["pred"]:>5.1f} act={r["actual"]:>5.1f}  '
                  f'scoutZ={r["scout_z"]:+5.2f} prodZ={r["prod_z"]:+5.2f}  {arrow}{flag}')
