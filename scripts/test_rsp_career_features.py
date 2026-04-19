#!/usr/bin/env python3
"""
Test whether newly-available RSP (Rookie Scouting Portfolio) fields lift the
rookie career (best-2-of-3 PPG) and boom/bust models above the current
PDF-aware baseline.

What's new since test_pdf_career_features.py:
  - RSP tier strings now embed Matt Waldman's DOT (Depth of Talent) score
    in a "Starter (87.4)" format. DOT is a numeric scout grade, much
    finer-grained than a round projection.
  - `public/data/rsp-historical-rankings.json` exposes each prospect's DOT
    and breadth across every RSP that ranked them. Re-ranked prospects in
    subsequent guides reveal Waldman's updated assessment — a boom/bust
    leading indicator if the direction disagrees with NFL outcomes.
  - RSP tier *class* ("Franchise" / "Legendary" / "Starter" / "Contributor"
    / "Reserve" / "Benchwarmer" / "Street") is ordinal and much richer than
    the binary "top tier" flag used today.

This script piggy-backs on test_pdf_career_features.py: loads career rows,
attaches the existing PDF features + disagreement features, layers the RSP
features on top, then runs the same LOSO protocol (regression + boom/bust).
"""

import json
import math
import re
import sys
from pathlib import Path
from collections import defaultdict

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from train_career_models import (  # noqa: E402
    load_career_rows, PRE_DRAFT_FEATURES, POST_DRAFT_FEATURES, CACHE_PATH,
)
from test_pdf_career_features import (  # noqa: E402
    PDF_PATH, build_pdf_index, lookup_pdf,
    attach_pdf_features, attach_disagreement_features,
    loso_eval, loso_boom_bust_eval, norm_name,
)

HR_PATH = Path('public/data/rsp-historical-rankings.json')

# Ordinal mapping of RSP tier classes. Scored so that the gap between
# neighbouring tiers approximates Waldman's implied DOT gap between class
# boundaries. Not a calibrated log-odds — just a monotonic ranking.
RSP_TIER_ORDINAL = {
    'Franchise': 10,
    'Legendary Performer': 9,
    'Elite Producer': 9,
    'Weekly Starter': 8,
    'Starter': 8,
    'Rotational Starter': 7,
    'Rotational Starter Tier': 7,
    'Flex Play': 6,
    'Contributor': 6,
    'Reserve': 5,
    'Cusp of Contributor and Reserve': 5,
    'Developmental': 4,
    'Developmental on Cusp of Reserve': 4,
    'Benchwarmer': 3,
    'Priority Free Agent': 3,
    'Waiver Wire Add': 2,
    'Dart Throw': 2,
    'Street': 1,
}

_DOT_RE = re.compile(r'\(([0-9]+(?:\.[0-9]+)?)\)')
_PAREN_RE = re.compile(r'\s*\([^)]*\)\s*')
_ROUND_TIER_RE = re.compile(r'round', re.I)


def _strip_paren(s: str) -> str:
    return _PAREN_RE.sub('', s).strip()


def _parse_tier_dot(tiers):
    """Return (dot_max, tier_ordinal, tier_label) from the merged 'tiers' list.

    Takes the max when the prospect appears in multiple PDFs — best-case
    scout projection matches the optimistic tail we want for boom signal.
    """
    if not tiers:
        return None, 0, None
    best_dot = None
    best_ord = 0
    best_label = None
    for t in tiers:
        m = _DOT_RE.search(t)
        dot = float(m.group(1)) if m else None
        label = _strip_paren(t)
        if _ROUND_TIER_RE.search(label):
            # "1st Round" etc. are beast-style, already handled via projected_round_mean.
            continue
        ordinal = RSP_TIER_ORDINAL.get(label, 0)
        if dot is not None and (best_dot is None or dot > best_dot):
            best_dot = dot
            best_label = label
        if ordinal > best_ord:
            best_ord = ordinal
            if best_label is None:
                best_label = label
    return best_dot, best_ord, best_label


def build_hr_index(hr):
    """(name, pos) -> list of {guide_year, rank, dot, breadth, tier}.

    Builds from both per-guide rankings and the multi_guide_players flat
    list — some players appear in one but not the other (extraction
    artifacts).
    """
    idx = defaultdict(list)
    for g in hr.get('guides', []):
        yr = g['guide_year']
        for pos, rows in (g.get('rankings') or {}).items():
            for r in rows:
                if r.get('dot') is None and r.get('breadth') is None:
                    continue
                idx[(norm_name(r['player_name']), pos)].append({
                    'guide_year': yr,
                    'rank': r.get('rank'),
                    'dot': r.get('dot'),
                    'breadth': r.get('breadth'),
                    'tier': r.get('tier'),
                })
    for entry in hr.get('multi_guide_players', []):
        key = (norm_name(entry['player_name']), entry['position'])
        # Skip — already captured via per-guide rankings above; the flat
        # list is a superset. Guarding against double-count.
        pass
    return idx


def _trajectory(appearances, draft_season):
    """Return (first_dot, last_dot, dot_delta, n_appearances).

    'First' = the guide in the player's draft year (when available).
    'Last' = the most recent guide. Delta is later-minus-earlier — positive
    means Waldman upgraded their grade in hindsight (late-boom signal).
    """
    if not appearances:
        return 0.0, 0.0, 0.0, 0
    ap = sorted(appearances, key=lambda e: e.get('guide_year', 0))
    first = next((a for a in ap if a.get('guide_year') == draft_season), ap[0])
    last = ap[-1]
    first_dot = float(first.get('dot') or 0)
    last_dot = float(last.get('dot') or 0)
    delta = last_dot - first_dot if (first_dot and last_dot) else 0.0
    return first_dot, last_dot, delta, len(ap)


def attach_rsp_features(career_rows, hr_idx, pdf_idx):
    """Mutate career rows to include rsp* features.

    - rspDot{Max,Tier,Draft,Latest,Delta}: numeric DOT from tier strings or
      historical rankings, with a trajectory delta across guides.
    - rspBreadth{Draft,Latest}: breadth score (companion to DOT; essentially
      a width-of-usefulness metric in Waldman's system).
    - rspTierOrdinal: 1-10 tier class ranking.
    - rspAppearances: count of RSP guides that ranked the player.
    - rspHasData: binary coverage flag.
    """
    filled = 0
    for r in career_rows:
        pos = r['position']
        pdf_entry = lookup_pdf(pdf_idx, r['name'], pos) if pdf_idx else None

        # Tier-derived DOT + ordinal (from merged features).
        tier_dot, tier_ord, _ = _parse_tier_dot(
            (pdf_entry or {}).get('tiers') or [])

        # Cross-year trajectory (from historical rankings file).
        hr_key = (norm_name(r['name']), pos)
        ap = hr_idx.get(hr_key, [])
        first_dot, last_dot, dot_delta, n_ap = _trajectory(ap, r['draft_season'])

        # If historical-rankings didn't cover the player, fall back to the
        # tier-embedded DOT.
        best_dot = max(
            tier_dot or 0.0,
            last_dot or 0.0,
            first_dot or 0.0,
        )
        has_data = 1 if (tier_dot or last_dot or tier_ord or n_ap) else 0
        if has_data:
            filled += 1

        # Breadth is only available through the historical rankings file.
        breadth_first = 0.0
        breadth_last = 0.0
        if ap:
            ap_sorted = sorted(ap, key=lambda e: e.get('guide_year', 0))
            first_ap = next(
                (a for a in ap_sorted
                 if a.get('guide_year') == r['draft_season']),
                ap_sorted[0])
            last_ap = ap_sorted[-1]
            breadth_first = float(first_ap.get('breadth') or 0)
            breadth_last = float(last_ap.get('breadth') or 0)

        # Number of comps — already in merged JSON but not currently a
        # feature for career. Test its marginal value alongside DOT.
        n_comps = len((pdf_entry or {}).get('comps') or [])

        r['features'].update({
            'rspHasData': has_data,
            'rspDotMax': best_dot,
            'rspDotDraft': first_dot,
            'rspDotLatest': last_dot,
            'rspDotDelta': dot_delta,
            'rspBreadthDraft': breadth_first,
            'rspBreadthLatest': breadth_last,
            'rspTierOrdinal': tier_ord,
            'rspAppearances': n_ap,
            'rspNComps': n_comps,
        })
    return filled


RSP_FEATURE_SETS = {
    # Single-signal tests — which of the new RSP fields adds most?
    'dot_only': ['rspDotMax', 'rspHasData'],
    'dot_tier': ['rspDotMax', 'rspTierOrdinal', 'rspHasData'],
    'tier_only': ['rspTierOrdinal', 'rspHasData'],
    'breadth_only': ['rspBreadthDraft', 'rspHasData'],
    'trajectory': ['rspDotDraft', 'rspDotLatest', 'rspDotDelta',
                   'rspAppearances', 'rspHasData'],
    'comps_only': ['rspNComps', 'rspHasData'],
    # Kitchen sinks.
    'all_numeric': [
        'rspHasData', 'rspDotMax', 'rspDotDraft', 'rspDotLatest',
        'rspDotDelta', 'rspBreadthDraft', 'rspBreadthLatest',
        'rspTierOrdinal', 'rspAppearances', 'rspNComps',
    ],
    # Draft-year snapshot only (what scouts thought at the time — the
    # relevant pre-draft feature set).
    'draft_snapshot': [
        'rspHasData', 'rspDotDraft', 'rspBreadthDraft',
        'rspTierOrdinal', 'rspNComps',
    ],
}

BOOM_RSP_EXTRAS = {
    'dot_only': ['rspDotMax', 'rspHasData'],
    'tier_only': ['rspTierOrdinal', 'rspHasData'],
    'trajectory': ['rspDotDraft', 'rspDotLatest', 'rspDotDelta', 'rspHasData'],
    'all': ['rspDotMax', 'rspDotDelta', 'rspTierOrdinal', 'rspBreadthLatest',
            'rspNComps', 'rspHasData'],
}
BUST_RSP_EXTRAS = {
    'dot_only': ['rspDotMax', 'rspHasData'],
    'tier_only': ['rspTierOrdinal', 'rspHasData'],
    'trajectory': ['rspDotDraft', 'rspDotLatest', 'rspDotDelta', 'rspHasData'],
    'all': ['rspDotMax', 'rspDotDelta', 'rspTierOrdinal', 'rspBreadthDraft',
            'rspNComps', 'rspHasData'],
}


def run(positions, is_post_draft=False, restrict_pos=None):
    print(f'Loading career rows from {CACHE_PATH}...')
    career_rows = load_career_rows(CACHE_PATH)
    print(f'  {len(career_rows)} career rows')

    with open(PDF_PATH) as f:
        pdf_rows = json.load(f)
    pdf_idx = build_pdf_index(pdf_rows)
    print(f'  {len(pdf_rows)} PDF merged rows')

    with open(HR_PATH) as f:
        hr = json.load(f)
    hr_idx = build_hr_index(hr)
    print(f'  {len(hr_idx)} (name,pos) keys in historical rankings')

    # Attach the existing PDF + disagreement baseline, then layer RSP on top.
    attach_pdf_features(career_rows, pdf_idx)
    attach_disagreement_features(career_rows)
    n_filled = attach_rsp_features(career_rows, hr_idx, pdf_idx)
    print(f'  RSP-tagged {n_filled}/{len(career_rows)} career rows')

    # Coverage by draft year for the PDF era.
    by_pos_year = defaultdict(lambda: [0, 0])
    for r in career_rows:
        key = (r['position'], r['draft_season'])
        by_pos_year[key][0] += 1
        if r['features'].get('rspHasData'):
            by_pos_year[key][1] += 1

    print('\nRSP coverage (pos × draft year):')
    for pos in ('QB', 'RB', 'WR', 'TE'):
        print(f'  {pos}:')
        for (pp, yr), (n, hit) in sorted(by_pos_year.items()):
            if pp != pos or yr < 2021:
                continue
            pct = hit / max(1, n) * 100
            print(f'    {yr}: {hit:3d}/{n:3d} ({pct:5.1f}%)')

    feat_src = POST_DRAFT_FEATURES if is_post_draft else PRE_DRAFT_FEATURES
    label = 'POST-DRAFT' if is_post_draft else 'PRE-DRAFT'
    print(f'\n=== {label} career model: RSP feature ablation ===\n')

    results = {}
    for pos in positions:
        if restrict_pos and pos != restrict_pos:
            continue
        baseline = feat_src[pos]
        pos_rows = [r for r in career_rows if r['position'] == pos]
        if len(pos_rows) < 20:
            continue

        print(f'── {pos} (n={len(pos_rows)}) ──')

        base_all = loso_eval(pos_rows, baseline, pos, recent_only=False)
        base_rec = loso_eval(pos_rows, baseline, pos, recent_only=True)
        base_rtrain = loso_eval(pos_rows, baseline, pos,
                                 restrict_train_to_recent=True)
        print(f'  baseline        (all yrs)  : R²={base_all["r2"]}, '
              f'MAE={base_all["mae"]}, ρ={base_all["rho"]}, n={base_all["n"]}')
        print(f'  baseline        (score≥22) : R²={base_rec["r2"]}, '
              f'MAE={base_rec["mae"]}, ρ={base_rec["rho"]}, n={base_rec["n"]}')
        print(f'  baseline        (train≥22) : R²={base_rtrain["r2"]}, '
              f'MAE={base_rtrain["mae"]}, ρ={base_rtrain["rho"]}, n={base_rtrain["n"]}')

        pos_res = {
            'baseline_all': base_all,
            'baseline_recent': base_rec,
            'baseline_rtrain': base_rtrain,
            'variants': {},
        }

        def delta(a, b, k):
            if a.get(k) is None or b.get(k) is None:
                return None
            return round(a[k] - b[k], 4)

        seen = set(baseline)
        for vname, vkeys in RSP_FEATURE_SETS.items():
            combo = baseline + [k for k in vkeys if k not in seen]
            r_all = loso_eval(pos_rows, combo, pos, recent_only=False)
            r_rec = loso_eval(pos_rows, combo, pos, recent_only=True)
            r_rtrain = loso_eval(pos_rows, combo, pos,
                                  restrict_train_to_recent=True)
            d_all = delta(r_all, base_all, 'r2')
            d_rec = delta(r_rec, base_rec, 'r2')
            d_rtrain = delta(r_rtrain, base_rtrain, 'r2')
            d_rtrain_mae = delta(r_rtrain, base_rtrain, 'mae')
            print(f'  +{vname:<16} (all yrs)  : R²={r_all["r2"]} '
                  f'(Δ={d_all:+.4f})')
            print(f'  +{vname:<16} (score≥22) : R²={r_rec["r2"]} '
                  f'(Δ={d_rec:+.4f})')
            print(f'  +{vname:<16} (train≥22) : R²={r_rtrain["r2"]} '
                  f'(Δ={d_rtrain:+.4f}), MAE={r_rtrain["mae"]} '
                  f'(Δ={d_rtrain_mae:+.3f})')
            pos_res['variants'][vname] = {
                'features': vkeys,
                'all_yrs': r_all,
                'recent': r_rec,
                'rtrain': r_rtrain,
                'delta_all_r2': d_all,
                'delta_recent_r2': d_rec,
                'delta_rtrain_r2': d_rtrain,
                'delta_rtrain_mae': d_rtrain_mae,
            }

        # Boom/Bust ablation.
        print('  -- boom/bust ablation --')
        bb_base = loso_boom_bust_eval(pos_rows, baseline, pos,
                                      gap_extra_keys=[], bust_extra_keys=[])
        bb_base_rec = loso_boom_bust_eval(pos_rows, baseline, pos,
                                           gap_extra_keys=[], bust_extra_keys=[],
                                           recent_only=True)
        print(f'  boom/bust base  (all yrs)  : ρ_boom={bb_base["boom_rho"]}, '
              f'AUC_bust={bb_base["bust_auc"]}, n={bb_base["n"]}')
        print(f'  boom/bust base  (score≥22) : ρ_boom={bb_base_rec["boom_rho"]}, '
              f'AUC_bust={bb_base_rec["bust_auc"]}, n={bb_base_rec["n"]}')
        pos_res['boom_bust_baseline'] = {'all': bb_base, 'recent': bb_base_rec}
        pos_res['boom_bust_variants'] = {}

        for vname, vkeys in BOOM_RSP_EXTRAS.items():
            bb = loso_boom_bust_eval(pos_rows, baseline, pos,
                                      gap_extra_keys=vkeys, bust_extra_keys=[])
            bb_r = loso_boom_bust_eval(pos_rows, baseline, pos,
                                        gap_extra_keys=vkeys, bust_extra_keys=[],
                                        recent_only=True)
            d = round(bb['boom_rho'] - bb_base['boom_rho'], 4) \
                if bb['boom_rho'] is not None else None
            d_r = round(bb_r['boom_rho'] - bb_base_rec['boom_rho'], 4) \
                if bb_r['boom_rho'] is not None else None
            print(f'  boom+{vname:<12} (all/rec)  : ρ={bb["boom_rho"]} (Δ={d}), '
                  f'ρ_recent={bb_r["boom_rho"]} (Δ={d_r})')
            pos_res['boom_bust_variants'][f'boom_{vname}'] = {
                'keys': vkeys, 'all': bb, 'recent': bb_r,
                'delta_all_rho': d, 'delta_recent_rho': d_r,
            }
        for vname, vkeys in BUST_RSP_EXTRAS.items():
            bb = loso_boom_bust_eval(pos_rows, baseline, pos,
                                      gap_extra_keys=[], bust_extra_keys=vkeys)
            bb_r = loso_boom_bust_eval(pos_rows, baseline, pos,
                                        gap_extra_keys=[], bust_extra_keys=vkeys,
                                        recent_only=True)
            d = round(bb['bust_auc'] - bb_base['bust_auc'], 4) \
                if bb['bust_auc'] is not None and bb_base['bust_auc'] is not None else None
            d_r = round(bb_r['bust_auc'] - bb_base_rec['bust_auc'], 4) \
                if bb_r['bust_auc'] is not None and bb_base_rec['bust_auc'] is not None else None
            print(f'  bust+{vname:<12} (all/rec)  : AUC={bb["bust_auc"]} (Δ={d}), '
                  f'AUC_recent={bb_r["bust_auc"]} (Δ={d_r})')
            pos_res['boom_bust_variants'][f'bust_{vname}'] = {
                'keys': vkeys, 'all': bb, 'recent': bb_r,
                'delta_all_auc': d, 'delta_recent_auc': d_r,
            }
        print()
        results[pos] = pos_res

    suffix = 'postdraft' if is_post_draft else 'predraft'
    out = Path(f'public/data/rsp-career-ablation-{suffix}.json')
    with open(out, 'w') as f:
        json.dump({'is_post_draft': is_post_draft, 'results': results},
                  f, indent=2)
    print(f'Summary saved to {out}')
    return results


def main():
    args = set(sys.argv[1:])
    is_post = '--post-draft' in args
    pos = None
    for a in list(args):
        if a.startswith('--pos='):
            pos = a.split('=', 1)[1]
        elif a == '--pos':
            i = sys.argv.index('--pos')
            if i + 1 < len(sys.argv):
                pos = sys.argv[i + 1]

    run(['QB', 'RB', 'WR', 'TE'], is_post_draft=is_post, restrict_pos=pos)


if __name__ == '__main__':
    main()
