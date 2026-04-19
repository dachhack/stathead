#!/usr/bin/env python3
"""QB-focused ablation using rsp-qb-features.json.

The standard RSP ablation (test_rsp_career_features.py) tests DOT, breadth,
tier ordinal, trajectory, comps, and a draft-snapshot bundle against the
rookie career model. For QBs only, rsp-qb-features.json exposes two extra
signals not available in the merged PDF file:

  - **non_adjusted DOT** — an alternate scoring metric that appears alongside
    the primary DOT in cross-year appearances; may carry signal the
    straight DOT doesn't (it's Waldman's version of DOT before the
    talent-vs-context adjustment).
  - **hand size** — parsed from athletic_notes strings like "H: 9.75" /
    "hand 9.75". QB-specific; the career model has never had it.

Plus QBs now have meaningful cross-year re-ranking coverage (35-58 per
guide) thanks to the rsp-qb-features.json extraction. Previously they
had 0 due to a fragmented multi-line PDF layout the regex parser couldn't
handle. Re-runs the same LOSO + boom/bust protocol for honest Δ R².
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
    _norm_pdf_name,
)
from test_pdf_career_features import (  # noqa: E402
    PDF_PATH, build_pdf_index, attach_pdf_features, attach_disagreement_features,
    loso_eval, loso_boom_bust_eval,
)
from test_rsp_career_features import (  # noqa: E402
    HR_PATH, build_hr_index, attach_rsp_features,
)

QB_FEATURES_PATH = Path('public/data/rsp-qb-features.json')


def build_qb_feature_index() -> dict:
    """(normalized_name, 'QB') → merged QB dict with cross-year appearances."""
    if not QB_FEATURES_PATH.exists():
        return {}
    with open(QB_FEATURES_PATH) as f:
        data = json.load(f)
    idx = {}
    for q in data.get('qbs_unified', []):
        key = (_norm_pdf_name(q['player_name']), 'QB')
        idx[key] = q
    return idx


# Athletic notes parsers. Accept both "H: 9.75" and "hand 9.75" formats
# and handle the occasional "DOT 69.825" / decimal weights.
_HAND_RE = re.compile(r'(?:H:\s*|hand\s+)([0-9]+(?:\.[0-9]+)?)', re.I)
_ATH_DOT_RE = re.compile(r'DOT\s+([0-9]+(?:\.[0-9]+)?)')


def parse_hand_size(athletic_notes: str | None) -> float:
    if not athletic_notes:
        return 0.0
    m = _HAND_RE.search(athletic_notes)
    return float(m.group(1)) if m else 0.0


def _nonadj_from_appearances(appearances: list, draft_season: int) -> tuple[float, float, float]:
    """Return (nonadj_draft, nonadj_latest, nonadj_delta) from cross-year list."""
    if not appearances:
        return 0.0, 0.0, 0.0
    have = [a for a in appearances if a.get('non_adjusted') is not None]
    if not have:
        return 0.0, 0.0, 0.0
    have.sort(key=lambda a: a.get('guide_year', 0))
    draft_a = next((a for a in have if a.get('guide_year') == draft_season), have[0])
    latest = have[-1]
    d = float(draft_a.get('non_adjusted') or 0)
    last = float(latest.get('non_adjusted') or 0)
    delta = last - d if (d and last) else 0.0
    return d, last, delta


def attach_qb_specific_features(career_rows, qb_idx):
    """Attach qbRsp* features to every QB row. Non-QB rows get zeros.

    Shape kept constant across positions so feature-matrix assembly stays
    uniform; the non-QB rows just don't use the keys in their feature list.
    """
    filled = 0
    for r in career_rows:
        if r['position'] != 'QB':
            # Zero-fill so downstream GBMs can still read the keys if
            # they ever appear in a shared feature list.
            r['features'].update({
                'qbRspHasData': 0,
                'qbRspHandSize': 0.0,
                'qbRspNonAdjustedDraft': 0.0,
                'qbRspNonAdjustedLatest': 0.0,
                'qbRspNonAdjustedDelta': 0.0,
                'qbRspRankPosition': 0,
            })
            continue
        key = (_norm_pdf_name(r['name']), 'QB')
        q = qb_idx.get(key)
        if q is None:
            r['features'].update({
                'qbRspHasData': 0,
                'qbRspHandSize': 0.0,
                'qbRspNonAdjustedDraft': 0.0,
                'qbRspNonAdjustedLatest': 0.0,
                'qbRspNonAdjustedDelta': 0.0,
                'qbRspRankPosition': 0,
            })
            continue
        filled += 1
        nonadj_d, nonadj_l, nonadj_delta = _nonadj_from_appearances(
            q.get('cross_year_appearances') or [], r['draft_season'])
        r['features'].update({
            'qbRspHasData': 1,
            'qbRspHandSize': parse_hand_size(q.get('athletic_notes')),
            'qbRspNonAdjustedDraft': nonadj_d,
            'qbRspNonAdjustedLatest': nonadj_l,
            'qbRspNonAdjustedDelta': nonadj_delta,
            'qbRspRankPosition': int(q.get('rank_position') or 0),
        })
    return filled


QB_FEATURE_SETS = {
    # Single-signal tests first.
    'hand_only': ['qbRspHandSize', 'qbRspHasData'],
    'nonadj_only': ['qbRspNonAdjustedDraft', 'qbRspHasData'],
    'nonadj_trajectory': ['qbRspNonAdjustedDraft', 'qbRspNonAdjustedLatest',
                           'qbRspNonAdjustedDelta', 'qbRspHasData'],
    'rank_pos': ['qbRspRankPosition', 'qbRspHasData'],
    # QB-specific combined with the generic RSP bundle that already ablated
    # positive in the train≥22 regime (see rsp-career-ablation-predraft.json).
    'qb_plus_snapshot': [
        'qbRspHandSize', 'qbRspNonAdjustedDraft', 'qbRspHasData',
        'rspDotDraft', 'rspBreadthDraft', 'rspTierOrdinal', 'rspNComps',
    ],
    'all_numeric': [
        'qbRspHasData', 'qbRspHandSize',
        'qbRspNonAdjustedDraft', 'qbRspNonAdjustedLatest', 'qbRspNonAdjustedDelta',
        'qbRspRankPosition',
        'rspDotDraft', 'rspBreadthDraft', 'rspTierOrdinal', 'rspNComps',
        'rspDotDelta',
    ],
}


def run(is_post_draft=False):
    print(f'Loading career rows from {CACHE_PATH}...')
    career_rows = load_career_rows(CACHE_PATH)
    print(f'  {len(career_rows)} rows')

    with open(PDF_PATH) as f:
        pdf_idx = build_pdf_index(json.load(f))
    with open(HR_PATH) as f:
        hr_idx = build_hr_index(json.load(f))
    qb_idx = build_qb_feature_index()
    print(f'  rsp-qb-features: {len(qb_idx)} QBs')

    attach_pdf_features(career_rows, pdf_idx)
    attach_disagreement_features(career_rows)
    attach_rsp_features(career_rows, hr_idx, pdf_idx)
    filled = attach_qb_specific_features(career_rows, qb_idx)
    print(f'  QB-specific features attached to {filled} QB rows')

    baseline = (POST_DRAFT_FEATURES if is_post_draft else PRE_DRAFT_FEATURES)['QB']
    qb_rows = [r for r in career_rows if r['position'] == 'QB']
    print(f'\n── QB (n={len(qb_rows)}) ──')

    base_all = loso_eval(qb_rows, baseline, 'QB', recent_only=False)
    base_rec = loso_eval(qb_rows, baseline, 'QB', recent_only=True)
    base_rtrain = loso_eval(qb_rows, baseline, 'QB',
                             restrict_train_to_recent=True)
    print(f'  baseline           (all yrs)  : R²={base_all["r2"]}, '
          f'MAE={base_all["mae"]}, ρ={base_all["rho"]}, n={base_all["n"]}')
    print(f'  baseline           (score≥22) : R²={base_rec["r2"]}, '
          f'MAE={base_rec["mae"]}, ρ={base_rec["rho"]}, n={base_rec["n"]}')
    print(f'  baseline           (train≥22) : R²={base_rtrain["r2"]}, '
          f'MAE={base_rtrain["mae"]}, ρ={base_rtrain["rho"]}, n={base_rtrain["n"]}')

    def delta(a, b, k):
        if a.get(k) is None or b.get(k) is None:
            return None
        return round(a[k] - b[k], 4)

    results = {'baseline_all': base_all, 'baseline_recent': base_rec,
               'baseline_rtrain': base_rtrain, 'variants': {}}
    seen = set(baseline)
    for vname, vkeys in QB_FEATURE_SETS.items():
        combo = baseline + [k for k in vkeys if k not in seen]
        r_all = loso_eval(qb_rows, combo, 'QB', recent_only=False)
        r_rec = loso_eval(qb_rows, combo, 'QB', recent_only=True)
        r_rtrain = loso_eval(qb_rows, combo, 'QB',
                              restrict_train_to_recent=True)
        d_all = delta(r_all, base_all, 'r2')
        d_rec = delta(r_rec, base_rec, 'r2')
        d_rtrain = delta(r_rtrain, base_rtrain, 'r2')
        print(f'  +{vname:<18} (all yrs)  : R²={r_all["r2"]} (Δ={d_all:+.4f})')
        print(f'  +{vname:<18} (score≥22) : R²={r_rec["r2"]} (Δ={d_rec:+.4f})')
        print(f'  +{vname:<18} (train≥22) : R²={r_rtrain["r2"]} (Δ={d_rtrain:+.4f})')
        results['variants'][vname] = {
            'features': vkeys, 'all_yrs': r_all, 'recent': r_rec, 'rtrain': r_rtrain,
            'delta_all_r2': d_all, 'delta_recent_r2': d_rec,
            'delta_rtrain_r2': d_rtrain,
        }

    # Boom/Bust.
    print('  -- boom/bust ablation --')
    bb_base = loso_boom_bust_eval(qb_rows, baseline, 'QB',
                                   gap_extra_keys=[], bust_extra_keys=[])
    bb_base_rec = loso_boom_bust_eval(qb_rows, baseline, 'QB',
                                       gap_extra_keys=[], bust_extra_keys=[],
                                       recent_only=True)
    print(f'  boom/bust base     (all yrs)  : ρ_boom={bb_base["boom_rho"]}, '
          f'AUC_bust={bb_base["bust_auc"]}, n={bb_base["n"]}')
    print(f'  boom/bust base     (score≥22) : ρ_boom={bb_base_rec["boom_rho"]}, '
          f'AUC_bust={bb_base_rec["bust_auc"]}, n={bb_base_rec["n"]}')

    bb_variants = {}
    for vname, vkeys in QB_FEATURE_SETS.items():
        bb_boom = loso_boom_bust_eval(qb_rows, baseline, 'QB',
                                       gap_extra_keys=vkeys, bust_extra_keys=[])
        bb_boom_r = loso_boom_bust_eval(qb_rows, baseline, 'QB',
                                         gap_extra_keys=vkeys, bust_extra_keys=[],
                                         recent_only=True)
        d = round(bb_boom['boom_rho'] - bb_base['boom_rho'], 4) \
            if bb_boom['boom_rho'] is not None else None
        d_r = round(bb_boom_r['boom_rho'] - bb_base_rec['boom_rho'], 4) \
            if bb_boom_r['boom_rho'] is not None else None
        print(f'  boom+{vname:<14} (all/rec) : ρ={bb_boom["boom_rho"]} (Δ={d}), '
              f'ρ_rec={bb_boom_r["boom_rho"]} (Δ={d_r})')

        bb_bust = loso_boom_bust_eval(qb_rows, baseline, 'QB',
                                       gap_extra_keys=[], bust_extra_keys=vkeys)
        bb_bust_r = loso_boom_bust_eval(qb_rows, baseline, 'QB',
                                         gap_extra_keys=[], bust_extra_keys=vkeys,
                                         recent_only=True)
        db = round(bb_bust['bust_auc'] - bb_base['bust_auc'], 4) \
            if bb_bust['bust_auc'] is not None and bb_base['bust_auc'] is not None else None
        db_r = round(bb_bust_r['bust_auc'] - bb_base_rec['bust_auc'], 4) \
            if bb_bust_r['bust_auc'] is not None and bb_base_rec['bust_auc'] is not None else None
        print(f'  bust+{vname:<14} (all/rec) : AUC={bb_bust["bust_auc"]} (Δ={db}), '
              f'AUC_rec={bb_bust_r["bust_auc"]} (Δ={db_r})')
        bb_variants[vname] = {
            'keys': vkeys,
            'boom_all': bb_boom, 'boom_recent': bb_boom_r,
            'bust_all': bb_bust, 'bust_recent': bb_bust_r,
            'delta_boom_all_rho': d, 'delta_boom_recent_rho': d_r,
            'delta_bust_all_auc': db, 'delta_bust_recent_auc': db_r,
        }
    results['boom_bust_baseline'] = {'all': bb_base, 'recent': bb_base_rec}
    results['boom_bust_variants'] = bb_variants

    suffix = 'postdraft' if is_post_draft else 'predraft'
    out = Path(f'public/data/qb-rsp-ablation-{suffix}.json')
    with open(out, 'w') as f:
        json.dump({'is_post_draft': is_post_draft, 'results': results}, f, indent=2)
    print(f'\nSaved to {out}')


def main():
    is_post = '--post-draft' in sys.argv
    run(is_post_draft=is_post)


if __name__ == '__main__':
    main()
