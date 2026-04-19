#!/usr/bin/env python3
"""
Evaluate whether scouting features extracted from pdf-prospect-features-merged.json
can improve the rookie career (best-2-of-3 PPG) model.

Data constraints:
  - PDF coverage exists only for draft classes 2022-2026. Older rookies have
    no PDF record. Any experiment must restrict evaluation to 2022-2025
    draft seasons OR treat PDF features as missing/optional (zero-fill).

Three variants are compared per position, all using the same LOSO protocol:
  1. baseline: current PRE_DRAFT_FEATURES for the position
  2. +pdf (zero-filled): baseline + PDF-derived features, zero-filled pre-2022
  3. +pdf (recent-only): baseline vs baseline+pdf evaluated ONLY on 2022-2025
     rookies, which is the honest test of marginal signal for the subset
     where PDF data actually exists.

Additionally, we test a gap-filling variant: the existing prospectOvlRank /
prospectGrade features have 0% coverage for 2025 and sparse coverage for
earlier years. We fill missing values with PDF-derived equivalents
(rank_overall_mean, projected_round_mean) and re-run the baseline.

Usage:
    python3 scripts/test_pdf_career_features.py
    python3 scripts/test_pdf_career_features.py --pos WR
    python3 scripts/test_pdf_career_features.py --post-draft
"""

import json
import math
import sys
import warnings
from pathlib import Path
from collections import defaultdict

import numpy as np
import lightgbm as lgb
from sklearn.linear_model import Ridge
from sklearn.metrics import r2_score, mean_absolute_error
from scipy.stats import spearmanr

warnings.filterwarnings('ignore')

sys.path.insert(0, str(Path(__file__).parent))
from train_career_models import (  # noqa: E402
    load_career_rows, PRE_DRAFT_FEATURES, POST_DRAFT_FEATURES,
    POS_HYPERPARAMS, POS_RECENCY_SCHEMES, recency_weight,
    CACHE_PATH,
)

PDF_PATH = Path('public/data/pdf-prospect-features-merged.json')


# ── Name matching ─────────────────────────────────────────────────────

_NAME_STRIPS = [' sr', ' jr', ' iii', ' ii', ' iv']


def norm_name(n: str) -> str:
    s = n.lower().strip()
    s = s.replace('.', '').replace("'", '').replace('-', ' ').replace('`', '')
    for suffix in _NAME_STRIPS:
        if s.endswith(suffix):
            s = s[:-len(suffix)].strip()
    return ' '.join(s.split())


def build_pdf_index(pdf_rows: list) -> dict:
    """Index PDF entries by (normalized_name, position).

    Also store a name-only fallback for ambiguous position matches
    (e.g. TE vs WR mismatches between scouting and fantasy position).
    """
    by_key = {}
    by_name = defaultdict(list)
    for p in pdf_rows:
        name = norm_name(p['player_name'])
        pos = p.get('position')
        by_key[(name, pos)] = p
        by_name[name].append(p)
    return {'by_key': by_key, 'by_name': by_name}


def lookup_pdf(idx: dict, name: str, position: str):
    nn = norm_name(name)
    entry = idx['by_key'].get((nn, position))
    if entry:
        return entry
    # Fallback: name match at any position (flex/scouting mismatch)
    candidates = idx['by_name'].get(nn, [])
    if len(candidates) == 1:
        return candidates[0]
    # Prefer a candidate matching FLEX ↔ scouting position maps
    POS_ALIASES = {
        'WR': {'WR'},
        'RB': {'RB'},
        'TE': {'TE', 'OL'},
        'QB': {'QB'},
    }
    for c in candidates:
        if c['position'] in POS_ALIASES.get(position, set()):
            return c
    return None


# ── PDF feature derivation ────────────────────────────────────────────

# Keywords hinting at an injury red flag (case-folded; substring match).
INJURY_KEYS = (
    'injury', 'injuries', 'surger', 'concussion', 'tore', 'torn', 'acl',
    'mcl', 'meniscus', 'hamstring', 'groin', 'shoulder', 'knee',
    'missed', 'missing', 'cut short', 'medical', 'fracture',
)

# Keywords hinting at a character/off-field red flag.
CHARACTER_KEYS = (
    'arrest', 'suspend', 'suspension', 'ejected', 'dismiss', 'marijuana',
    'dui', 'dwi', 'violation', 'off-field', 'off field', 'character',
    'discipline', 'benched',
)

# Tier labels that typically imply a high-end projection.
ELITE_TIER_MARKERS = (
    '1st round', 'first round', 'tier i', 'tier 1', 'elite', 'no. 1',
    'top-10', 'top 10', 'day 1',
)


def _count_injury_red_flags(red_flags):
    if not red_flags:
        return 0
    n = 0
    for rf in red_flags:
        rfl = rf.lower()
        if any(k in rfl for k in INJURY_KEYS):
            n += 1
    return n


def _count_character_red_flags(red_flags):
    if not red_flags:
        return 0
    n = 0
    for rf in red_flags:
        rfl = rf.lower()
        if any(k in rfl for k in CHARACTER_KEYS):
            n += 1
    return n


def _tier_top_flag(tiers):
    if not tiers:
        return 0
    joined = ' '.join(t.lower() for t in tiers)
    return 1 if any(m in joined for m in ELITE_TIER_MARKERS) else 0


def derive_pdf_features(p: dict) -> dict:
    """Extract numeric features from a PDF prospect record.

    Returns a dict with consistent keys (zero when unavailable) so the
    feature matrix shape matches across rows regardless of PDF coverage.
    """
    if p is None:
        return {
            'pdfHasData': 0,
            'pdfNSources': 0,
            'pdfRankOverallMean': 0,
            'pdfRankOverallMin': 0,
            'pdfProjectedRound': 0,
            'pdfNStrengths': 0,
            'pdfNWeaknesses': 0,
            'pdfNRedFlags': 0,
            'pdfInjuryRedFlags': 0,
            'pdfCharacterRedFlags': 0,
            'pdfNComps': 0,
            'pdfSentimentNet': 0,
            'pdfTierElite': 0,
            'pdfHasRank': 0,
            'pdfHasRound': 0,
        }
    rank_mean = p.get('rank_overall_mean')
    rank_min = p.get('rank_overall_min')
    proj_round = p.get('projected_round_mean')
    strengths = p.get('strengths') or []
    weaknesses = p.get('weaknesses') or []
    red_flags = p.get('red_flags') or []
    comps = p.get('comps') or []
    tiers = p.get('tiers') or []

    n_strengths = len(strengths)
    n_weak = len(weaknesses)
    n_red = len(red_flags)
    n_comps = len(comps)
    # Weight red flags more heavily than plain weaknesses in the net score —
    # a redundant 'weaknesses' bullet is softer than a flagged concern.
    sentiment_net = n_strengths - n_weak - 2 * n_red

    return {
        'pdfHasData': 1,
        'pdfNSources': int(p.get('n_sources', 0) or 0),
        'pdfRankOverallMean': float(rank_mean) if rank_mean is not None else 0.0,
        'pdfRankOverallMin': float(rank_min) if rank_min is not None else 0.0,
        'pdfProjectedRound': float(proj_round) if proj_round is not None else 0.0,
        'pdfNStrengths': n_strengths,
        'pdfNWeaknesses': n_weak,
        'pdfNRedFlags': n_red,
        'pdfInjuryRedFlags': _count_injury_red_flags(red_flags),
        'pdfCharacterRedFlags': _count_character_red_flags(red_flags),
        'pdfNComps': n_comps,
        'pdfSentimentNet': sentiment_net,
        'pdfTierElite': _tier_top_flag(tiers),
        'pdfHasRank': 1 if rank_mean is not None else 0,
        'pdfHasRound': 1 if proj_round is not None else 0,
    }


# Candidate PDF feature groups — tested additively per-position.
PDF_FEATURE_SETS = {
    'rank_only': ['pdfRankOverallMean', 'pdfHasRank'],
    'round_only': ['pdfProjectedRound', 'pdfHasRound'],
    'sentiment': ['pdfNStrengths', 'pdfNWeaknesses', 'pdfNRedFlags', 'pdfSentimentNet'],
    'injury': ['pdfInjuryRedFlags'],
    'consensus': ['pdfNSources', 'pdfHasData'],
    'tier_elite': ['pdfTierElite'],
    'all_numeric': [
        'pdfHasData', 'pdfNSources',
        'pdfRankOverallMean', 'pdfHasRank',
        'pdfProjectedRound', 'pdfHasRound',
        'pdfNStrengths', 'pdfNWeaknesses', 'pdfNRedFlags',
        'pdfInjuryRedFlags', 'pdfSentimentNet',
        'pdfTierElite',
    ],
}


# ── Evaluation ────────────────────────────────────────────────────────

def _cell(v):
    if v is None or v == '' or v == 'NA' or v == 'NaN':
        return 0.0
    try:
        f = float(v)
        return f if math.isfinite(f) else 0.0
    except (TypeError, ValueError):
        return 0.0


def make_X(rows: list, keys: list[str]) -> np.ndarray:
    return np.array([[_cell(r['features'].get(k, 0)) for k in keys] for r in rows])


def make_y(rows: list) -> np.ndarray:
    return np.array([r['best2of3'] for r in rows])


def loso_eval(pos_rows: list, feature_keys: list[str], pos: str,
              recent_only: bool = False,
              restrict_train_to_recent: bool = False) -> dict:
    """LOSO CV mirroring train_career_models.train_position (regression only).

    recent_only=True → score only folds where held-out season ≥ 2022.
    restrict_train_to_recent=True → also drop pre-2022 rows from every
    training fold. This is the honest within-PDF-era test — both train and
    test operate on the PDF-covered subset, so feature adds aren't
    drowned out by 12 seasons of zero-filled history.
    """
    if restrict_train_to_recent:
        pos_rows = [r for r in pos_rows if r['draft_season'] >= 2022]

    hyper = POS_HYPERPARAMS.get(pos, POS_HYPERPARAMS['WR'])
    recency_scheme = POS_RECENCY_SCHEMES.get(pos)
    seasons = sorted(set(r['draft_season'] for r in pos_rows))
    if not seasons:
        return {'r2': None, 'mae': None, 'rho': None, 'n': 0}
    max_season = max(seasons)

    def expand(rows):
        if recency_scheme is None:
            return rows
        out = []
        for r in rows:
            out.extend([r] * recency_weight(r['draft_season'], max_season, recency_scheme))
        return out

    preds, actuals, held_seasons = [], [], []
    for held in seasons:
        train_raw = [r for r in pos_rows if r['draft_season'] != held]
        test = [r for r in pos_rows if r['draft_season'] == held]
        if len(train_raw) < 10 or not test:
            continue
        train = expand(train_raw)
        X_tr = make_X(train, feature_keys)
        y_tr = make_y(train)
        X_te = make_X(test, feature_keys)

        ridge = Ridge(alpha=hyper['ridge_alpha'])
        ridge.fit(X_tr, y_tr)
        ridge_p = ridge.predict(X_te)

        if len(train) >= 40:
            bag_preds = []
            for bag_i in range(5):
                params = {
                    'objective': 'regression', 'metric': 'mae',
                    'learning_rate': hyper['lr'], 'max_depth': hyper['max_depth'],
                    'min_child_samples': hyper['min_child'],
                    'subsample': 0.8, 'colsample_bytree': 0.8,
                    'bagging_fraction': 0.8, 'bagging_freq': 1,
                    'extra_trees': True,
                    'verbose': -1, 'seed': 42 + bag_i, 'n_jobs': 1,
                }
                dtr = lgb.Dataset(X_tr, y_tr, feature_name=feature_keys,
                                  free_raw_data=False)
                model = lgb.train(params, dtr, num_boost_round=hyper['n_estimators'])
                bag_preds.append(model.predict(X_te))
            lgb_p = np.mean(bag_preds, axis=0)
            final = np.clip((ridge_p + lgb_p) / 2, 0, None)
        else:
            final = np.clip(ridge_p, 0, None)

        for p, r in zip(final, test):
            preds.append(float(p))
            actuals.append(r['best2of3'])
            held_seasons.append(held)

    preds = np.array(preds)
    actuals = np.array(actuals)
    held_seasons = np.array(held_seasons)

    if recent_only:
        mask = held_seasons >= 2022
        if mask.sum() < 5:
            return {'r2': None, 'mae': None, 'rho': None, 'n': int(mask.sum())}
        preds, actuals = preds[mask], actuals[mask]

    if len(preds) < 5:
        return {'r2': None, 'mae': None, 'rho': None, 'n': len(preds)}

    r2 = float(r2_score(actuals, preds))
    mae = float(mean_absolute_error(actuals, preds))
    rho, _ = spearmanr(-preds, -actuals)
    return {
        'r2': round(r2, 4),
        'mae': round(mae, 3),
        'rho': round(float(rho), 4),
        'n': len(preds),
    }


# ── Coverage audit ────────────────────────────────────────────────────

def audit_coverage(career_rows: list, pdf_idx: dict):
    """Report how many career rows in each draft_season match a PDF entry."""
    print("\n=== PDF Coverage Audit (match rate by position × draft_season) ===")
    cov = defaultdict(lambda: [0, 0])
    missing_examples = defaultdict(list)
    for r in career_rows:
        if r['position'] not in ('QB', 'RB', 'WR', 'TE'):
            continue
        ds = r['draft_season']
        cov[(r['position'], ds)][0] += 1
        p = lookup_pdf(pdf_idx, r['name'], r['position'])
        if p is not None:
            cov[(r['position'], ds)][1] += 1
        elif 2022 <= ds <= 2025:
            missing_examples[(r['position'], ds)].append(r['name'])

    for pos in ('QB', 'RB', 'WR', 'TE'):
        print(f"  {pos}:")
        for (pp, ds), (total, hit) in sorted(cov.items()):
            if pp != pos:
                continue
            pct = hit / max(1, total) * 100
            marker = '  ← PDF era' if 2022 <= ds <= 2025 else ''
            print(f"    {ds}: {hit:3d}/{total:3d} ({pct:5.1f}%){marker}")
    print()
    print("Sample unmatched within 2022-2025 (likely name-normalization issues):")
    for (pos, ds), names in sorted(missing_examples.items()):
        if names:
            print(f"  {pos} {ds}: {names[:5]}")


# ── Main experiment ───────────────────────────────────────────────────

def attach_pdf_features(career_rows: list, pdf_idx: dict):
    """Mutate each career row's feature dict to include PDF-derived features."""
    for r in career_rows:
        p = lookup_pdf(pdf_idx, r['name'], r['position']) if pdf_idx else None
        pdf_f = derive_pdf_features(p)
        r['features'].update(pdf_f)


def _safe_num(v) -> float:
    if v is None or v == '' or v == 'NA' or v == 'NaN':
        return 0.0
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def fill_prospect_gaps(career_rows: list, pdf_idx: dict):
    """Use PDF rank/round to fill zero/missing prospectOvlRank & prospectGrade.

    Existing `prospectOvlRank` (lower = better) and `prospectGrade` are only
    ~40% covered and zero for 2025. For rows where both are zero, use the
    PDF rank / (10 - projected_round) as proxies. Returns number filled.
    """
    n_filled = 0
    for r in career_rows:
        ovl = _safe_num(r['features'].get('prospectOvlRank', 0))
        grade = _safe_num(r['features'].get('prospectGrade', 0))
        if ovl > 0 and grade > 0:
            continue
        p = lookup_pdf(pdf_idx, r['name'], r['position'])
        if p is None:
            continue
        rank_mean = p.get('rank_overall_mean')
        proj_round = p.get('projected_round_mean')
        filled = False
        if ovl == 0 and rank_mean is not None:
            r['features']['prospectOvlRank'] = float(rank_mean)
            filled = True
        if grade == 0 and proj_round is not None:
            # Convert projected round to a grade-ish scale:
            # round 1 → 9, round 2 → 8, round 7 → 3. Matches the rough 2-9
            # range observed in existing prospectGrade values.
            r['features']['prospectGrade'] = max(1.0, 10.0 - float(proj_round))
            filled = True
        if filled:
            r['features']['hasProspectGrade'] = 1
            n_filled += 1
    return n_filled


def run_experiment(positions: list, is_post_draft: bool = False,
                   restrict_pos: str | None = None):
    print(f"Loading career rows from {CACHE_PATH}...")
    career_rows = load_career_rows(CACHE_PATH)
    print(f"  {len(career_rows)} career rows loaded")

    print(f"Loading PDF features from {PDF_PATH}...")
    with open(PDF_PATH) as f:
        pdf_rows = json.load(f)
    print(f"  {len(pdf_rows)} PDF entries")
    pdf_idx = build_pdf_index(pdf_rows)

    audit_coverage(career_rows, pdf_idx)

    # Attach PDF-derived features to every row (zero-filled when absent)
    attach_pdf_features(career_rows, pdf_idx)

    feature_source = POST_DRAFT_FEATURES if is_post_draft else PRE_DRAFT_FEATURES
    label = 'POST-DRAFT' if is_post_draft else 'PRE-DRAFT'
    print(f"\n=== {label} career model experiments ===\n")

    results = {}
    for pos in positions:
        if restrict_pos and pos != restrict_pos:
            continue
        baseline = feature_source[pos]
        pos_rows = [r for r in career_rows if r['position'] == pos]
        if len(pos_rows) < 20:
            continue
        print(f"── {pos} (n={len(pos_rows)}) ──")

        # Baseline in three modes: all-years, score-recent (train all),
        # and recent-train (train+score only on 2022-25 rows).
        base_all = loso_eval(pos_rows, baseline, pos, recent_only=False)
        base_recent = loso_eval(pos_rows, baseline, pos, recent_only=True)
        base_rtrain = loso_eval(pos_rows, baseline, pos,
                                restrict_train_to_recent=True)
        print(f"  baseline       (all yrs)   : R²={base_all['r2']}, "
              f"MAE={base_all['mae']}, ρ={base_all['rho']}, n={base_all['n']}")
        print(f"  baseline       (score≥22)  : R²={base_recent['r2']}, "
              f"MAE={base_recent['mae']}, ρ={base_recent['rho']}, n={base_recent['n']}")
        print(f"  baseline       (train≥22)  : R²={base_rtrain['r2']}, "
              f"MAE={base_rtrain['mae']}, ρ={base_rtrain['rho']}, n={base_rtrain['n']}")

        pos_results = {
            'baseline_all': base_all,
            'baseline_recent': base_recent,
            'baseline_rtrain': base_rtrain,
            'variants': {},
        }

        def delta(a, b, key):
            if a.get(key) is None or b.get(key) is None:
                return None
            return round(a[key] - b[key], 4)

        # Test each PDF feature set additively
        for vname, vkeys in PDF_FEATURE_SETS.items():
            combo = baseline + vkeys
            r_all = loso_eval(pos_rows, combo, pos, recent_only=False)
            r_recent = loso_eval(pos_rows, combo, pos, recent_only=True)
            r_rtrain = loso_eval(pos_rows, combo, pos,
                                 restrict_train_to_recent=True)

            d_all_r2 = delta(r_all, base_all, 'r2')
            d_recent_r2 = delta(r_recent, base_recent, 'r2')
            d_rtrain_r2 = delta(r_rtrain, base_rtrain, 'r2')
            d_all_mae = delta(r_all, base_all, 'mae')
            d_rtrain_mae = delta(r_rtrain, base_rtrain, 'mae')

            print(f"  +{vname:<14} (all yrs)  : R²={r_all['r2']} "
                  f"(Δ={d_all_r2:+.4f}), MAE={r_all['mae']} (Δ={d_all_mae:+.3f})")
            print(f"  +{vname:<14} (score≥22) : R²={r_recent['r2']} "
                  f"(Δ={d_recent_r2:+.4f})")
            print(f"  +{vname:<14} (train≥22) : R²={r_rtrain['r2']} "
                  f"(Δ={d_rtrain_r2:+.4f}), MAE={r_rtrain['mae']} (Δ={d_rtrain_mae:+.3f})")

            pos_results['variants'][vname] = {
                'features': vkeys,
                'all_yrs': r_all,
                'recent': r_recent,
                'rtrain': r_rtrain,
                'delta_all_r2': d_all_r2,
                'delta_recent_r2': d_recent_r2,
                'delta_rtrain_r2': d_rtrain_r2,
                'delta_all_mae': d_all_mae,
                'delta_rtrain_mae': d_rtrain_mae,
            }

        # Gap-fill experiment: re-attach PDF, then fill prospectOvlRank / grade
        # with PDF-derived proxies and re-run the UNMODIFIED baseline.
        gap_rows = load_career_rows(CACHE_PATH)
        filled = fill_prospect_gaps(gap_rows, pdf_idx)
        gap_pos_rows = [r for r in gap_rows if r['position'] == pos]
        g_all = loso_eval(gap_pos_rows, baseline, pos, recent_only=False)
        g_recent = loso_eval(gap_pos_rows, baseline, pos, recent_only=True)
        print(f"  gap-fill       (all yrs)  : R²={g_all['r2']} "
              f"(Δ={round(g_all['r2'] - base_all['r2'], 4):+.4f}), MAE={g_all['mae']} "
              f"[filled {filled} across all positions]")
        print(f"  gap-fill       (2022-25)  : R²={g_recent['r2']} "
              f"(Δ={round(g_recent['r2'] - base_recent['r2'], 4):+.4f}), MAE={g_recent['mae']}")
        pos_results['gap_fill'] = {
            'all_yrs': g_all,
            'recent': g_recent,
            'delta_all_r2': round(g_all['r2'] - base_all['r2'], 4),
            'delta_recent_r2': round(g_recent['r2'] - base_recent['r2'], 4) if g_recent.get('r2') else None,
            'n_rows_filled_any_pos': filled,
        }

        print()
        results[pos] = pos_results

    return results


def main():
    args = set(sys.argv[1:])
    is_post = '--post-draft' in args
    pos = None
    for a in list(args):
        if a.startswith('--pos='):
            pos = a.split('=', 1)[1]
        elif a == '--pos':
            # next arg
            i = sys.argv.index('--pos')
            if i + 1 < len(sys.argv):
                pos = sys.argv[i + 1]

    positions = ['QB', 'RB', 'WR', 'TE']
    results = run_experiment(positions, is_post_draft=is_post, restrict_pos=pos)

    suffix = 'postdraft' if is_post else 'predraft'
    out = Path(f'public/data/pdf-career-ablation-{suffix}.json')
    with open(out, 'w') as f:
        json.dump({
            'is_post_draft': is_post,
            'results': results,
        }, f, indent=2)
    print(f"Summary saved to {out}")


if __name__ == '__main__':
    main()
