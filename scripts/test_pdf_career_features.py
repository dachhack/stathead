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
            'pdfRankOverallMax': 0,
            'pdfRankSpread': 0,
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
    rank_max = p.get('rank_overall_max')
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
    sentiment_net = n_strengths - n_weak - 2 * n_red

    # Scout-internal disagreement spread. Mean is across multiple
    # source PDFs (The Beast, RSP, Late-Round Guide); a wide min/max
    # band indicates the analysts didn't agree on the player. Zero
    # when only one source ranked them.
    rank_spread = (float(rank_max) - float(rank_min)) \
        if rank_max is not None and rank_min is not None else 0.0

    return {
        'pdfHasData': 1,
        'pdfNSources': int(p.get('n_sources', 0) or 0),
        'pdfRankOverallMean': float(rank_mean) if rank_mean is not None else 0.0,
        'pdfRankOverallMin': float(rank_min) if rank_min is not None else 0.0,
        'pdfRankOverallMax': float(rank_max) if rank_max is not None else 0.0,
        'pdfRankSpread': rank_spread,
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


# Candidate PDF extras for the boom/bust models. Boom responds to scout
# sentiment (gap between what The Beast saw and what draft capital implies),
# bust responds to injury / red-flag signals. Gap has a natural
# "talent_vs_pick" shape (value / log(pick)) — mirror it for PDF rank and
# sentiment in the builder below.
BOOM_GAP_PDF_EXTRAS = {
    'rank': ['pdfRankOverallMean', 'pdfHasRank'],
    'sentiment': ['pdfNStrengths', 'pdfNWeaknesses', 'pdfSentimentNet'],
    'redflags': ['pdfNRedFlags', 'pdfInjuryRedFlags'],
    # Disagreement candidates: features where the boom signal is "two
    # sources don't agree", which is itself a useful nonlinear feature
    # (a heavy projection-uncertainty band shifts the prior toward
    # variance/outlier outcomes).
    'disagree_scout': ['pdfRankSpread', 'pdfRankXPick', 'pdfRoundXActual'],
    'disagree_talent': ['recruitProductionGap', 'athleticProductionGap'],
    'disagree_age': ['ageProductionGap'],
    'disagree_all': ['pdfRankSpread', 'pdfRankXPick', 'pdfRoundXActual',
                     'recruitProductionGap', 'athleticProductionGap',
                     'ageProductionGap', 'sentimentProductionGap'],
    'all': ['pdfRankOverallMean', 'pdfHasRank', 'pdfNStrengths',
            'pdfNWeaknesses', 'pdfSentimentNet', 'pdfNRedFlags',
            'pdfInjuryRedFlags', 'pdfTierElite', 'pdfHasData'],
    'all_plus_disagree': [
        'pdfRankOverallMean', 'pdfHasRank', 'pdfNStrengths', 'pdfNWeaknesses',
        'pdfSentimentNet', 'pdfNRedFlags', 'pdfInjuryRedFlags',
        'pdfRankSpread', 'pdfRankXPick', 'pdfRoundXActual',
        'recruitProductionGap', 'athleticProductionGap',
        'ageProductionGap', 'sentimentProductionGap'],
}
BUST_PDF_EXTRAS = {
    'redflags': ['pdfNRedFlags', 'pdfInjuryRedFlags', 'pdfCharacterRedFlags'],
    'rank': ['pdfRankOverallMean', 'pdfHasRank'],
    'weakness': ['pdfNWeaknesses', 'pdfSentimentNet'],
    'disagree_scout': ['pdfRankSpread', 'pdfRankXPick', 'pdfRoundXActual'],
    'disagree_talent': ['recruitProductionGap', 'athleticProductionGap'],
    'disagree_overdraft': ['pdfRankXPick', 'pdfRoundXActual'],
    'disagree_all': ['pdfRankSpread', 'pdfRankXPick', 'pdfRoundXActual',
                     'recruitProductionGap', 'athleticProductionGap',
                     'ageProductionGap', 'sentimentProductionGap'],
    'all': ['pdfRankOverallMean', 'pdfHasRank', 'pdfNRedFlags',
            'pdfInjuryRedFlags', 'pdfCharacterRedFlags', 'pdfNWeaknesses',
            'pdfSentimentNet', 'pdfHasData'],
    'all_plus_disagree': [
        'pdfRankOverallMean', 'pdfHasRank', 'pdfNRedFlags',
        'pdfInjuryRedFlags', 'pdfCharacterRedFlags', 'pdfNWeaknesses',
        'pdfSentimentNet', 'pdfRankSpread', 'pdfRankXPick',
        'pdfRoundXActual', 'recruitProductionGap', 'athleticProductionGap',
        'ageProductionGap'],
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


# ── Boom/Bust ablation ─────────────────────────────────────────────────
#
# The career pipeline's boom model predicts outperformance (actual rank
# - predicted rank) with LGB on gap-style features. The bust model is a
# binary classifier on (actual - pred) < -mae * 0.75 with its own feature
# set. We reuse the same LOSO-by-season protocol from train_position()
# and report Spearman(outperf_pred, outperf_actual) for boom and AUC for
# bust. Adding PDF features shifts the feature matrices only — the
# targets come from an UNMODIFIED baseline career model so Δ isolates
# the boom/bust model's lift, not a changed target distribution.

def _base_career_preds(pos_rows: list, feature_keys: list[str],
                       pos: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """LOSO predictions from the baseline career regression.

    Returns (preds, actuals, held_seasons). Mirrors train_position minus
    the threshold classifiers — we only need regression output here.
    """
    hyper = POS_HYPERPARAMS.get(pos, POS_HYPERPARAMS['WR'])
    recency_scheme = POS_RECENCY_SCHEMES.get(pos)
    seasons = sorted(set(r['draft_season'] for r in pos_rows))
    max_season = max(seasons)

    def expand(rows):
        if recency_scheme is None:
            return rows
        out = []
        for r in rows:
            out.extend([r] * recency_weight(r['draft_season'], max_season, recency_scheme))
        return out

    preds, actuals, held = [], [], []
    per_row = {}
    for held_s in seasons:
        train_raw = [r for r in pos_rows if r['draft_season'] != held_s]
        test = [r for r in pos_rows if r['draft_season'] == held_s]
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
            bag = []
            for bi in range(5):
                params = {
                    'objective': 'regression', 'metric': 'mae',
                    'learning_rate': hyper['lr'], 'max_depth': hyper['max_depth'],
                    'min_child_samples': hyper['min_child'],
                    'subsample': 0.8, 'colsample_bytree': 0.8,
                    'bagging_fraction': 0.8, 'bagging_freq': 1,
                    'extra_trees': True, 'verbose': -1,
                    'seed': 42 + bi, 'n_jobs': 1,
                }
                dtr = lgb.Dataset(X_tr, y_tr, feature_name=feature_keys, free_raw_data=False)
                m = lgb.train(params, dtr, num_boost_round=hyper['n_estimators'])
                bag.append(m.predict(X_te))
            lgb_p = np.mean(bag, axis=0)
            final = np.clip((ridge_p + lgb_p) / 2, 0, None)
        else:
            final = np.clip(ridge_p, 0, None)
        for p, r in zip(final, test):
            per_row[(r['name'], r['draft_season'])] = float(p)
            preds.append(float(p))
            actuals.append(r['best2of3'])
            held.append(held_s)
    return np.array(preds), np.array(actuals), np.array(held), per_row


def loso_boom_bust_eval(pos_rows: list, feature_keys: list[str], pos: str,
                         gap_extra_keys: list[str], bust_extra_keys: list[str],
                         recent_only: bool = False) -> dict:
    """LOSO ablation for boom (gap model) and bust (binary classifier).

    - Baseline career predictions come from `feature_keys` (untouched).
    - Gap model features = static GAP_BASE (mirroring train_position's
      _build_gap_features) + any extras in gap_extra_keys.
    - Bust model features = BUST_BASE + bust_extra_keys.
    """
    preds, actuals, held, _ = _base_career_preds(pos_rows, feature_keys, pos)
    n = len(preds)
    if n < 20:
        return {'boom_rho': None, 'bust_auc': None, 'n': n}

    # Outperformance target (unchanged from train_position)
    pred_ranks = np.argsort(np.argsort(preds)) / n
    actual_ranks = np.argsort(np.argsort(actuals)) / n
    outperf_true = actual_ranks - pred_ranks

    mae = float(np.mean(np.abs(actuals - preds)))
    boom_thresh = mae * 0.75
    y_bust = np.array([1 if (a - p) < -boom_thresh else 0
                       for a, p in zip(actuals, preds)])

    # Build augmented gap/bust feature matrices. We reuse _build_gap_features
    # semantics but re-attach the PDF feature values via direct lookup on
    # the row's all_features dict (which is the pos_rows feature dict).
    # Find each row's original feature dict keyed by (name, draft_season).
    feat_map = {(r['name'], r['draft_season']): r['features'] for r in pos_rows}

    # Match pos_rows order used for preds (which came from LOSO season order)
    rows_aligned = []
    for r in pos_rows:
        rows_aligned.append(r)
    # Align by (name, season)
    pos_idx = {(r['name'], r['draft_season']): r for r in pos_rows}

    # We need the same ordering as preds[], so re-walk seasons.
    order = []
    seasons = sorted(set(r['draft_season'] for r in pos_rows))
    for s in seasons:
        train_raw = [r for r in pos_rows if r['draft_season'] != s]
        test = [r for r in pos_rows if r['draft_season'] == s]
        if len(train_raw) < 10 or not test:
            continue
        for r in test:
            order.append(r)
    assert len(order) == n

    # Static base gap features: reuse GAP_FEAT_NAMES ordering from train_career_models
    # We rebuild via a lightweight inline function here to avoid importing the
    # inner function — list of raw feature names from the career-features dict.
    GAP_BASE_KEYS = [
        'relativeAthleticScore', 'speedScore', 'heightAdjSpeedScore', 'forty',
        'weight', 'cone', 'shuttle',
        'collegeBestRecYds', 'collegeDominatorRating', 'collegeBreakoutScore',
        'collegeMarketShare', 'collegeTotalTDs',
        'age', 'collegeEarlyDeclare', 'collegeExperiencePerAge', 'collegeSeasons',
        'recruitRating', 'collegeUsageOverall', 'collegeTeamTalent',
        'collegeQBR2yr', 'collegeYdsPerPassAtt', 'collegeQbContextScore',
    ]
    BUST_BASE_KEYS = [
        'speedScore', 'relativeAthleticScore', 'heightAdjSpeedScore',
        'forty', 'weight', 'age',
        'collegeDominatorRating', 'collegeBestRecYds', 'collegeBreakoutScore',
        'collegeMarketShare', 'collegeTotalTDs', 'collegeReceptionShare',
        'collegeExperiencePerAge', 'collegeSeasons', 'collegeEarlyDeclare',
        'nflDraftPick', 'recruitRating', 'collegeUsageOverall',
        'collegeTeamTalent', 'collegeQBR2yr', 'collegeQbContextScore',
    ]

    def build_gap_feats(r):
        base = [_cell(r['features'].get(k, 0)) for k in GAP_BASE_KEYS]
        extra = [_cell(r['features'].get(k, 0)) for k in gap_extra_keys]
        return base + extra

    def build_bust_feats(r, pred):
        base = [_cell(r['features'].get(k, 0)) for k in BUST_BASE_KEYS]
        base.append(pred)
        extra = [_cell(r['features'].get(k, 0)) for k in bust_extra_keys]
        return base + extra

    X_gap = np.nan_to_num(np.array([build_gap_feats(r) for r in order], dtype=np.float64))
    X_bust = np.nan_to_num(np.array([build_bust_feats(r, preds[i]) for i, r in enumerate(order)], dtype=np.float64))

    outperf_pred = np.zeros(n)
    bust_pred = np.full(n, float(y_bust.mean()))

    # LOSO on the gap + bust models
    for s in seasons:
        tr_idx = [i for i, r in enumerate(order) if r['draft_season'] != s]
        te_idx = [i for i, r in enumerate(order) if r['draft_season'] == s]
        if len(tr_idx) < 20 or not te_idx:
            continue
        gap_params = {
            'objective': 'regression', 'metric': 'mae', 'learning_rate': 0.03,
            'max_depth': 2, 'min_child_samples': max(5, len(tr_idx) // 8),
            'subsample': 0.7, 'colsample_bytree': 0.6, 'verbose': -1, 'seed': 42,
            'n_jobs': 1, 'extra_trees': True,
        }
        dt = lgb.Dataset(X_gap[tr_idx], outperf_true[tr_idx],
                         feature_name=GAP_BASE_KEYS + gap_extra_keys, free_raw_data=False)
        gm = lgb.train(gap_params, dt, num_boost_round=60)
        outperf_pred[te_idx] = gm.predict(X_gap[te_idx])

        if sum(y_bust[tr_idx]) >= 3:
            bust_params = {
                'objective': 'binary', 'metric': 'auc', 'learning_rate': 0.03,
                'max_depth': 2, 'min_child_samples': max(3, len(tr_idx) // 10),
                'subsample': 0.7, 'colsample_bytree': 0.6, 'verbose': -1,
                'seed': 42, 'n_jobs': 1, 'is_unbalance': True, 'extra_trees': True,
            }
            dtb = lgb.Dataset(X_bust[tr_idx], y_bust[tr_idx],
                              feature_name=BUST_BASE_KEYS + ['predictedPPG'] + bust_extra_keys,
                              free_raw_data=False)
            bm = lgb.train(bust_params, dtb, num_boost_round=60)
            bust_pred[te_idx] = bm.predict(X_bust[te_idx])

    # Metrics
    held_seasons = np.array([r['draft_season'] for r in order])
    mask = held_seasons >= 2022 if recent_only else np.ones(n, dtype=bool)
    if mask.sum() < 5:
        return {'boom_rho': None, 'bust_auc': None, 'n': int(mask.sum())}

    rho, _ = spearmanr(outperf_pred[mask], outperf_true[mask])
    yb = y_bust[mask]
    bp = bust_pred[mask]
    # AUC from rank sums; fallback to mean if degenerate
    if yb.sum() == 0 or yb.sum() == len(yb):
        auc = None
    else:
        from sklearn.metrics import roc_auc_score
        auc = float(roc_auc_score(yb, bp))

    return {
        'boom_rho': round(float(rho), 4),
        'bust_auc': round(auc, 4) if auc is not None else None,
        'n': int(mask.sum()),
    }


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


# ── Disagreement features ─────────────────────────────────────────────
#
# "Disagreement" = signal in two features that should agree but don't:
#   pdfRankXPick      = log(scout-rank) - log(NFL-pick). Big positive
#                       means scouts ranked the player worse than the
#                       team that drafted them — overdraft / reach.
#                       Big negative means the team picked early what
#                       scouts agreed was a top prospect (consensus).
#   pdfRoundXActual   = projected_round_mean - actual_draft_round.
#                       Same shape, but in round-units (more rounded but
#                       robust on tail picks).
#   pdfRankSpread     = rank_overall_max - rank_overall_min from the
#                       PDF index. Bigger = analysts disagreed; we
#                       expect a fatter outcome distribution → variance
#                       is signal for boom/bust even if the mean isn't.
#   recruitProductionGap = z(recruitRating) - z(collegeMarketShare).
#                       High = recruit hype that didn't produce (bust).
#                       Low = late bloomer who out-produced their stars
#                       (boom).
#   athleticProductionGap = z(speedScore) - z(collegeDominatorRating).
#                       High = combine warrior, low college film. Bust
#                       risk especially when paired with high pick.
#   ageProductionGap = collegeDominatorRating / max(1, age - 19).
#                       Younger producers score higher; older players
#                       with the same dominator look less impressive.
#   sentimentProductionGap = pdfSentimentNet - z(collegeMarketShare).
#                       Disagreement between qualitative scout sentiment
#                       and quantitative production.

def _zscore_per_pos(rows: list, key: str) -> dict:
    """Per-position (mean, std) for z-scoring."""
    by_pos: dict = defaultdict(list)
    for r in rows:
        v = r['features'].get(key, 0)
        try:
            v = float(v) if v not in (None, '', 'NA', 'NaN') else 0.0
        except (TypeError, ValueError):
            v = 0.0
        if v != 0:  # skip missing values from the moments
            by_pos[r['position']].append(v)
    moments = {}
    for pos, vals in by_pos.items():
        if len(vals) < 5:
            moments[pos] = (0.0, 1.0)
        else:
            m = float(np.mean(vals))
            s = float(np.std(vals)) or 1.0
            moments[pos] = (m, s)
    return moments


def _safe_log(v: float) -> float:
    if v is None or v <= 0:
        return 0.0
    return float(math.log(v))


def attach_disagreement_features(career_rows: list):
    """Compute and attach disagreement-style features.

    z-scoring is per-position so a CFBD recruitRating of 0.92 reads as
    "elite for a TE" but only "good for a WR" — the disagreement gap is
    against position-mates, not the global pool.
    """
    # Per-position moments for the inputs we z-score
    recruit_m = _zscore_per_pos(career_rows, 'recruitRating')
    market_m = _zscore_per_pos(career_rows, 'collegeMarketShare')
    speed_m = _zscore_per_pos(career_rows, 'speedScore')
    dom_m = _zscore_per_pos(career_rows, 'collegeDominatorRating')

    def _z(val: float, pos: str, moments: dict) -> float:
        if val == 0:
            return 0.0  # treat missing as 0σ — matches the GBM's missing-as-zero handling elsewhere
        m, s = moments.get(pos, (0.0, 1.0))
        return (val - m) / s

    for r in career_rows:
        f = r['features']
        pos = r['position']

        try:
            pick = float(f.get('nflDraftPick', 300) or 300)
            draft_round = float(f.get('nflDraftRound', 7) or 7)
        except (TypeError, ValueError):
            pick, draft_round = 300.0, 7.0
        pdf_rank = float(f.get('pdfRankOverallMean', 0) or 0)
        proj_round = float(f.get('pdfProjectedRound', 0) or 0)

        # Scout-vs-NFL disagreement. Only computed when both sides have
        # signal — zero otherwise so the GBM pairs well with pdfHasRank
        # and pdfHasRound for missing-data handling.
        f['pdfRankXPick'] = (_safe_log(pdf_rank) - _safe_log(pick)) if pdf_rank > 0 else 0.0
        f['pdfRoundXActual'] = (proj_round - draft_round) if proj_round > 0 else 0.0

        recruit = float(f.get('recruitRating', 0) or 0)
        market = float(f.get('collegeMarketShare', 0) or 0)
        speed = float(f.get('speedScore', 0) or 0)
        dom = float(f.get('collegeDominatorRating', 0) or 0)
        age = float(f.get('age', 0) or 0)
        sentiment = float(f.get('pdfSentimentNet', 0) or 0)
        has_pdf = float(f.get('pdfHasData', 0) or 0)

        f['recruitProductionGap'] = _z(recruit, pos, recruit_m) - _z(market, pos, market_m) \
            if recruit > 0 and market > 0 else 0.0
        f['athleticProductionGap'] = _z(speed, pos, speed_m) - _z(dom, pos, dom_m) \
            if speed > 0 and dom > 0 else 0.0
        f['ageProductionGap'] = (dom / max(1.0, age - 19.0)) if age > 19 and dom > 0 else 0.0
        f['sentimentProductionGap'] = (sentiment - _z(market, pos, market_m)) \
            if has_pdf and market > 0 else 0.0


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

    # Attach PDF-derived features to every row (zero-filled when absent),
    # then disagreement features that depend on both PDF and existing
    # baseline features (z-scored per-position).
    attach_pdf_features(career_rows, pdf_idx)
    attach_disagreement_features(career_rows)

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

        # Test each PDF feature set additively. Dedupe: the shipped
        # PRE_DRAFT_FEATURES already include pdfRankOverallMean for RB
        # and the sentiment family for WR, so a naive concat would crash
        # LightGBM with "Feature appears more than one time".
        seen_baseline = set(baseline)
        for vname, vkeys in PDF_FEATURE_SETS.items():
            combo = baseline + [k for k in vkeys if k not in seen_baseline]
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

        # ── Boom/Bust ablation (gap model + bust classifier) ──────────
        print(f"  -- boom/bust ablation --")
        bb_base = loso_boom_bust_eval(pos_rows, baseline, pos,
                                      gap_extra_keys=[], bust_extra_keys=[])
        bb_base_recent = loso_boom_bust_eval(pos_rows, baseline, pos,
                                             gap_extra_keys=[], bust_extra_keys=[],
                                             recent_only=True)
        print(f"  boom/bust base (all yrs)   : ρ_boom={bb_base['boom_rho']}, "
              f"AUC_bust={bb_base['bust_auc']}, n={bb_base['n']}")
        print(f"  boom/bust base (score≥22)  : ρ_boom={bb_base_recent['boom_rho']}, "
              f"AUC_bust={bb_base_recent['bust_auc']}, n={bb_base_recent['n']}")

        bb_variants = {}
        for vname, vkeys in BOOM_GAP_PDF_EXTRAS.items():
            bb = loso_boom_bust_eval(pos_rows, baseline, pos,
                                     gap_extra_keys=vkeys, bust_extra_keys=[])
            bb_r = loso_boom_bust_eval(pos_rows, baseline, pos,
                                       gap_extra_keys=vkeys, bust_extra_keys=[],
                                       recent_only=True)
            d = round(bb['boom_rho'] - bb_base['boom_rho'], 4) if bb['boom_rho'] is not None else None
            d_r = round(bb_r['boom_rho'] - bb_base_recent['boom_rho'], 4) \
                  if bb_r['boom_rho'] is not None else None
            print(f"  boom+{vname:<10} (all/recent): ρ={bb['boom_rho']} (Δ={d}), "
                  f"ρ_recent={bb_r['boom_rho']} (Δ={d_r})")
            bb_variants[f'boom_{vname}'] = {
                'keys': vkeys, 'all': bb, 'recent': bb_r,
                'delta_all_rho': d, 'delta_recent_rho': d_r,
            }

        for vname, vkeys in BUST_PDF_EXTRAS.items():
            bb = loso_boom_bust_eval(pos_rows, baseline, pos,
                                     gap_extra_keys=[], bust_extra_keys=vkeys)
            bb_r = loso_boom_bust_eval(pos_rows, baseline, pos,
                                       gap_extra_keys=[], bust_extra_keys=vkeys,
                                       recent_only=True)
            d = round(bb['bust_auc'] - bb_base['bust_auc'], 4) \
                if bb['bust_auc'] is not None and bb_base['bust_auc'] is not None else None
            d_r = round(bb_r['bust_auc'] - bb_base_recent['bust_auc'], 4) \
                  if bb_r['bust_auc'] is not None and bb_base_recent['bust_auc'] is not None else None
            print(f"  bust+{vname:<10} (all/recent): AUC={bb['bust_auc']} (Δ={d}), "
                  f"AUC_recent={bb_r['bust_auc']} (Δ={d_r})")
            bb_variants[f'bust_{vname}'] = {
                'keys': vkeys, 'all': bb, 'recent': bb_r,
                'delta_all_auc': d, 'delta_recent_auc': d_r,
            }
        pos_results['boom_bust_baseline'] = {'all': bb_base, 'recent': bb_base_recent}
        pos_results['boom_bust_variants'] = bb_variants

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
