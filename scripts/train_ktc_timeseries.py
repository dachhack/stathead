#!/usr/bin/env python3
"""KTC time-series baseline trainer — Commit A of the KTC reframe.

Every player's KTC dynasty value is a time series. For each (player, t)
where v(t+H) is observable, build a training sample whose target is the
H-day log-return

    y(t) = log(v(t+H)) - log(v(t))

and whose features are:

  fast (from KTC history alone, backward-looking from t):
    logValue, return_{1,7,14,30}d,
    zscore_30d, vol_30d, drawdown_30d,
    days_since_max_30d, days_since_min_30d,
    posRankPct (percentile within position at time t),
    posRankPctDelta_7d

  slow (from training-rows-cache-v42.json, joined by normalized name + pos):
    age (current, from ktc_rankings), yearsInLeague, draft capital,
    physical / combine, prior production, role, team context, projection.

Per-position models, per-horizon models (one per (position, horizon) pair).
Horizons: H ∈ {7, 30, 60, 90, 120} days. The hard ceiling for any training
sample given a 179-day data window and 30-day warmup is H ≤ 148; practical
sample-size floor puts the ceiling at ~130. A 6-month (180-day) forecast
is impossible from this data envelope.

CV is scheme-dependent on the horizon:

  walk-forward (H ≤ 30): expanding-window cutoffs with 14-day test blocks.
      Measures temporal extrapolation: "given data up to T, predict the
      next window." Requires train + test + target-observable-gap to all
      fit inside the usable t-range, which breaks for H ≥ 60.

  player-grouped (all H, but primary for H ≥ 60): K-fold with players as
      the grouping unit. Train on 4/5 of players, test on the held-out 1/5.
      Measures cross-player generalization: "given most players' H-day
      trajectories, predict the held-out cohort's H-day trajectories."

Both metrics are honest out-of-sample. They measure *different*
generalization claims (temporal vs cross-player), so the JSON emits both
where feasible and a primary_scheme field that says which to quote. For
short horizons, agreement between the two is a sanity signal.

Full-data models are trained on every feasible sample and serialized via
lgb_to_js_gbm (init=0, lr=1 invariant from f22f844).

Output: public/data/model-cache-ktc-v2.json  (v2 — v1 was the dead-end
valueDeltaPct port that motivated this reframe).

Usage:
    source /tmp/lgb-verify/bin/activate
    python3 scripts/train_ktc_timeseries.py
"""
import json
import re
import sys
import time
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import lightgbm as lgb
from sklearn.metrics import r2_score, mean_absolute_error

# Project helpers — use the canonical serializer with the init=0/lr=1 invariant
sys.path.insert(0, str(Path(__file__).parent))
from train_projection_models import lgb_to_js_gbm, train_lgb_model, sf  # noqa: E402


DATA_DIR = Path('public/data')
KTC_HISTORY_PATH = DATA_DIR / 'ktc_history.json'
KTC_RANKINGS_PATH = DATA_DIR / 'ktc_rankings_1qb.json'
TRAINING_CACHE_PATH = DATA_DIR / 'training-rows-cache-v42.json'
NFLVERSE_WEEKLY_PATH = DATA_DIR / 'nflverse_weekly_2025.json'
OUTPUT_PATH = DATA_DIR / 'model-cache-ktc-v2.json'

POSITIONS = ('QB', 'RB', 'WR', 'TE')

# Horizons for forecasting (in days). The data envelope is 2025-10-14 →
# 2026-04-11 = 179 days total, 149 days after the 30-day warmup. Hard
# ceiling for *any* training sample is H ≤ 148; practical ceiling for
# ≥20 samples/player is H ≤ 129. A 6-month (180d) forecast is impossible
# from this dataset because no player has observed v(t) and v(t+180)
# inside a 180-day window.
#
# Chosen set spans short (7, 30) and dynasty-relevant long horizons
# (60, 90, 120). 120 days ≈ 4 months is the longest horizon where
# samples/player stay ≥ 25.
HORIZONS = (7, 30, 60, 90, 120)

WARMUP_DAYS = 30  # days of history required before fast features become valid

# CV config.
# For each (position, horizon) pair we run the CV scheme that is honest
# given the data envelope:
#
#   H ≤ 30: walk-forward is primary. Expanding-window cutoffs with a
#           14-day test window. Measures temporal extrapolation: "given
#           data up to T, predict what happens in the next window."
#           Player-grouped CV is *also* reported at H ≤ 30 so we can
#           cross-check the two schemes on the same data.
#
#   H ≥ 60: walk-forward is infeasible (usable t-range shrinks below the
#           horizon + gap). Player-grouped is primary. Measures
#           cross-player generalization: "given most players' H-day
#           trajectories in the observed period, predict the held-out
#           players' H-day trajectories over the same period."
#
# These measure *different* generalization claims. Both are honest
# out-of-sample metrics — nothing about either is an in-sample artifact.
CV_FOLDS = 5                  # walk-forward cutoffs
CV_TEST_WINDOW_DAYS = 14      # width of each walk-forward fold's test window
PLAYER_CV_FOLDS = 5           # player-grouped K
MIN_FOLD_TRAIN_ROWS = 500     # skip a fold if training set is smaller than this
WALK_FORWARD_MAX_H = 30       # above this, skip walk-forward entirely


# ── Name normalization ──────────────────────────────────────────────────

def normalize_name(name):
    if not name:
        return ''
    s = str(name).lower()
    s = re.sub(r'[^a-z ]', '', s)
    s = re.sub(r'\s+', ' ', s).strip()
    s = re.sub(r' (jr|sr|ii|iii|iv|v)$', '', s)
    return s


# ── Slow feature definitions ────────────────────────────────────────────
# Selected from the TSX component's feature lists (src/components/
# KTCPredictiveModel.tsx:69-184) plus a few static fields available in the
# training cache that the TSX assembles inline from nflverse data. All of
# these are player-level attributes that do not change day-to-day.
#
# Commit B will add weekly nflverse state features (snap %, target volume,
# depth chart delta) as a *fast* layer. This list is intentionally frozen
# for Commit A so ablation has a clean baseline to work against.

SLOW_COMMON = [
    'age', 'yearsInLeague',
    'nflDraftRound', 'nflDraftPick', 'invDraftPick', 'logDraftPick',
    'draftPickPctOverall', 'draftClassDepth',
    'weight', 'bmi', 'forty', 'speedScore', 'vertical',
    'priorPPG', 'priorPPG2yr', 'priorGames', 'priorSnapPct',
    'priorFantasyPPR',
    'depthChartRank', 'teamSamePosCount',
    'priorTargetShare',
    'qbOwnPPG', 'teamElitePassCatchers', 'teamPassCatcherPPR',
    'priorWOPR', 'priorBoomRate', 'priorBustGameRate',
    'projPlayerPPR', 'projTargetShare', 'projPlayerVsExpected',
    'priorInjuryWeeks', 'ppgTrend',
]

SLOW_POS = {
    'QB': ['priorPassYards', 'priorPassTDs', 'priorINTs', 'priorAttempts',
           'priorTimeToThrow', 'collegeQBR'],
    'RB': ['priorRushYards', 'priorRushTDs', 'priorCarries', 'priorYPC',
           'priorRecEPA', 'priorRushEPA'],
    'WR': ['priorTargets', 'priorReceptions', 'priorRecYards', 'priorRecTDs',
           'priorYACAboveExp', 'priorAirYardsShare'],
    'TE': ['priorTargets', 'priorReceptions', 'priorRecYards', 'priorRecTDs',
           'priorYACperRec', 'priorAirYardsShare'],
}


def slow_feature_names(pos):
    """Returns the ordered slow feature names for a position.
    `isRookie` is injected first so the GBM can split on it cheaply."""
    return ['isRookie'] + SLOW_COMMON + SLOW_POS[pos]


# Fast features are computed identically for every position.
#
# Season-phase features (`daysSinceSeasonStart`, `phaseRegSeason`,
# `phasePlayoffs`, `phaseOffseason`) are critical for the 2025-26 data:
# the 6-month window contains exactly one regime transition (regular
# season → playoffs → offseason). Without an explicit phase signal, a
# walk-forward fold trained on regular-season momentum will extrapolate
# badly across the shift. These features don't fix single-shot CV
# (a fold that trains ONLY on in-season still can't *learn* the offseason
# distribution) but they let the full-data deployed model condition on
# phase correctly.
FAST_FEATURE_NAMES = [
    'logValue',
    'return_1d', 'return_7d', 'return_14d', 'return_30d',
    'zscore_30d', 'vol_30d', 'drawdown_30d',
    'days_since_max_30d', 'days_since_min_30d',
    'posRankPct', 'posRankPctDelta_7d',
    'daysSinceSeasonStart', 'phaseRegSeason', 'phasePlayoffs', 'phaseOffseason',
]

# NFL 2025-26 calendar anchors (for season-phase features).
# Source: https://www.nfl.com/schedules/ — Week 1 Sep 4 2025, Week 18 Jan 4 2026,
# Super Bowl Feb 8 2026.
SEASON_START = date(2025, 9, 4)
REG_SEASON_END = date(2026, 1, 4)
PLAYOFFS_END = date(2026, 2, 8)


# Weekly features (Commit B addition). These are the "fast state" layer
# that the long-horizon WR/RB models were missing — in-season trajectory
# signals from nflverse weekly data that the daily KTC price history
# cannot capture.
#
# All features are backward-looking from sample date t: we only use
# weekly data where WEEK_COMPLETE_DATES[w] ≤ t, i.e. every game in that
# week had already been played at t. No forward leakage by construction.
#
# Rationale tied to the weak spots at Commit A.1 pgR²:
#   WR H=60  pgR²=0.053    WR H=90  pgR²=0.004    WR H=120 pgR²=0.016
#   RB H=90  pgR²=0.064    RB H=120 pgR²=0.014
# The target for each of these is "3-4 month log return" — a horizon
# where short-term daily returns wash out and what moves the market is
# current-season workload (snap %, target volume, carries) and its
# trajectory. These features are engineered specifically to expose
# those dynamics to the GBM.
WEEKLY_FEATURE_NAMES = [
    'hasWeekly',             # 1 if any weekly data available at t, else 0
    # Snap rate trajectory (the single strongest workload signal in
    # nflverse — captures coach trust and health)
    'snapPctLast4',
    'snapPctSeason',
    'snapPctTrend',          # last4 - season
    # Target volume trajectory (WR / TE / pass-catching RB signal)
    'targetsLast4',
    'targetsSeason',
    'targetsTrend',
    # Carry volume trajectory (RB-primary, QB rushing also)
    'carriesLast4',
    'carriesSeason',
    'carriesTrend',
    # Efficiency + air yards (hidden workload)
    'rushRecYardsLast4',
    'recEpaLast4',
    'rushEpaLast4',
    # Availability
    'gamesPlayedSeason',
    'weeksSinceLastPlayed',  # 0 = played last scheduled week; capped at 10
    'injuryOut2wk',          # count of weeks in last 2 with Out/IR/Doubtful
    # Depth chart (coaching decisions, captures promotions/demotions)
    'depthRankLatest',
    'depthRankDelta14d',     # (rank at t - 14d) - (rank at t); >0 = moved up
]


def feature_names_for(pos):
    return FAST_FEATURE_NAMES + slow_feature_names(pos) + WEEKLY_FEATURE_NAMES


# ── Feature pruning (Commit C.2a) ───────────────────────────────────────
# Derived from scripts/ablate_ktc_features.py run on the Commit B model
# cache; see public/data/ktc-feature-ablation.json for per-(pos, horizon)
# ΔpgR² values.
#
# DROP_GLOBAL: features whose ablation Δ is ≤ 0 at essentially every
# (pos, horizon) pair (18+ of 20), i.e. never pulls weight anywhere.
# Removing these is a free win — shrinks the feature vector without
# costing any model's signal.
#
# DROP_PER_POS: features that are strictly negative at all 5 horizons
# of a position, i.e. position-level dead weight. These features may be
# useful for OTHER positions — they're kept in their respective position's
# feature list and dropped only from the one that clearly doesn't need them.
#
# Rule we followed for per-position drops:
#   - sumΔ across the 5 horizons < -0.003
#   - AND every horizon has Δ ≤ +0.001 (no standout positive use case)
#   - AND the net-negative magnitude is ≥10x any positive blip
#
# We intentionally did NOT drop features that are mixed across the
# horizons of a given position (e.g. most slow features for RB are
# negative at H=7/30/60 and strongly positive at H=120). Those need
# per-(pos, horizon) feature lists to prune, which is scoped for a
# later commit after hyperparam tuning settles the models.
DROP_GLOBAL = {
    # Always 0 — key doesn't exist in training-rows-cache-v42.json. The
    # TSX component computes priorFantasyPPR inline from nflverse season
    # totals but the cache we join to only carries priorPPG / priorPPG2yr.
    # This was a copy-paste holdover from the TSX feature list in Commit A.
    'priorFantasyPPR',
    # Always 0 — we zero-fill unmatched KTC players' slow features and all
    # the matched players are veterans (rookies fail the name-join), so
    # isRookie is constant across the training set.
    'isRookie',
    # Net-negative or 0 at 19/20 pairs. The "did this player have any
    # weekly data at all?" signal is 1 for everyone matched and 0 for
    # rookies — and rookies' isRookie flag would carry the same signal
    # if it weren't dead. Redundant indicator.
    'hasWeekly',
    # Net-negative or 0 at 17/20 pairs. The 14-day window rarely spans an
    # actual depth-chart change in a 6-month rolling dataset, so the
    # column is mostly zeros with occasional noise. No signal.
    'depthRankDelta14d',
}

DROP_PER_POS = {
    'QB': {
        # QBs don't catch passes — these pass-catcher-context features
        # are pure noise for QB (all 5 horizons ≤ 0, sumΔ ≈ -0.0007).
        'priorTargetShare', 'priorWOPR', 'projTargetShare',
        # priorAttempts is a slow_qb feature but empirically always 0
        # in the cache for 2025 rows (data not in the post-season rollup
        # that the cache uses), so it behaves like a dead constant.
        'priorAttempts',
        # QB-specific weekly dead weight: targetsTrend is always 0
        # (no QB targets), and QB models never split on it.
        'targetsTrend',
    },
    'RB': {
        # sumΔ = -0.0358 across all 5 horizons, strictly negative at
        # every one (-0.144 worst at H=120). Age is heavily correlated
        # with yearsInLeague + priorPPG2yr, and the GBM overfits age
        # splits that don't generalize across the player-grouped folds.
        'age',
        # Phase indicators are noise for RB specifically. The
        # daysSinceSeasonStart fast feature already encodes the same
        # time-of-season info continuously.
        'phaseRegSeason', 'phasePlayoffs', 'phaseOffseason',
    },
    'WR': set(),  # WR has no strict per-position drops beyond DROP_GLOBAL
    'TE': {
        # sumΔ = -0.0326 across H=30..120 (H=7 is +0.0008, basically zero).
        # TE dynasty value doesn't route through "who's throwing to this
        # player" — unlike WR where qbOwnPPG is the #1 feature at H=120.
        # TE value is driven by the player's own archetype (bmi dominates
        # all TE long horizons) and workload, not QB quality.
        'qbOwnPPG',
    },
}


def pruned_feature_names_for(pos):
    """Return the feature list for a position after applying global and
    per-position drops. This is what the trainer (and downstream analysis
    scripts) should use."""
    full = feature_names_for(pos)
    drops = DROP_GLOBAL | DROP_PER_POS.get(pos, set())
    return [f for f in full if f not in drops]


# ── Loaders ─────────────────────────────────────────────────────────────

def load_inputs():
    """Load ktc_history, ktc_rankings, training-rows-cache and return
    (players, slow_feats_by_pid, date_grid) where:
      players: list of dicts with pid, name, position, is_rookie, dates, vals
               (dates is a numpy array of datetime.date, vals is float64
                forward-filled to daily cadence covering the player's
                observed range)
      slow_feats_by_pid: pid -> {feature_name: value} (already position-matched)
      date_grid: sorted list of datetime.date covering the union of all
                 player histories, used for cross-sectional rank ops
    """
    with open(KTC_HISTORY_PATH) as f:
        history = json.load(f)
    with open(KTC_RANKINGS_PATH) as f:
        rankings = json.load(f)
    with open(TRAINING_CACHE_PATH) as f:
        cache = json.load(f)

    # Rankings lookup by pid
    rank_by_pid = {r['playerID']: r for r in rankings}

    # Latest training-cache row per (norm_name, position)
    latest_cache = {}
    for row in cache['rows']:
        key = (normalize_name(row.get('name')), row.get('position'))
        cur = latest_cache.get(key)
        if cur is None or row['season'] > cur['season']:
            latest_cache[key] = row

    players = []
    for h in history:
        pid = h['playerID']
        rank_entry = rank_by_pid.get(pid)
        if rank_entry is None:
            continue
        pos = rank_entry.get('position')
        if pos not in POSITIONS:
            continue  # skip RDP + anything else

        vh = h.get('oneQB', {}).get('valueHistory') or []
        if len(vh) < WARMUP_DAYS + 2:
            continue

        # Deduplicate same-day entries (data has dupes for 2026-04-11);
        # keep the LAST occurrence per date.
        by_d = {}
        for e in vh:
            try:
                d = date.fromisoformat(e['d'])
            except Exception:
                continue
            by_d[d] = sf(e.get('v'))
        if not by_d:
            continue

        start = min(by_d.keys())
        end = max(by_d.keys())
        dates, vals = [], []
        prev = by_d[start]
        d = start
        while d <= end:
            if d in by_d:
                prev = by_d[d]
            dates.append(d)
            vals.append(prev)
            d += timedelta(days=1)

        players.append({
            'pid': pid,
            'name': rank_entry.get('playerName'),
            'position': pos,
            'is_rookie': bool(rank_entry.get('isRookie')),
            'dates': np.array(dates, dtype=object),
            'vals': np.array(vals, dtype=np.float64),
            'rank_entry': rank_entry,
        })

    # Slow features per pid
    slow_by_pid = {}
    matched = {pos: 0 for pos in POSITIONS}
    total = {pos: 0 for pos in POSITIONS}
    for p in players:
        pos = p['position']
        total[pos] += 1
        key = (normalize_name(p['name']), pos)
        cache_row = latest_cache.get(key)
        rank_entry = p['rank_entry']
        feats = {}

        feats['isRookie'] = 1.0 if p['is_rookie'] else 0.0

        # Age: prefer current KTC rankings age (real-time), fall back to
        # training cache age shifted by years since the cache row's season.
        age = sf(rank_entry.get('age'))
        if age <= 0 and cache_row:
            age = sf(cache_row['features'].get('age', 0)) + (2025 - cache_row['season'])
        feats['age'] = age

        keys = SLOW_COMMON + SLOW_POS[pos]
        if cache_row:
            matched[pos] += 1
            cf = cache_row.get('features', {}) or {}
            for k in keys:
                if k == 'age':
                    continue
                feats[k] = sf(cf.get(k, 0))
        else:
            for k in keys:
                if k == 'age':
                    continue
                feats[k] = 0.0  # unmatched rookie → GBM will split on isRookie

        slow_by_pid[p['pid']] = feats

    print('Players by position (matched / total):')
    for pos in POSITIONS:
        print(f'  {pos}: {matched[pos]:3d} / {total[pos]:3d}')

    # Date grid (union of all dates any player is observed)
    all_dates = set()
    for p in players:
        for d in p['dates']:
            all_dates.add(d)
    date_grid = sorted(all_dates)
    print(f'Date grid: {len(date_grid)} days, '
          f'{date_grid[0].isoformat()} → {date_grid[-1].isoformat()}')

    return players, slow_by_pid, date_grid


# ── Fast-feature computation ────────────────────────────────────────────

def compute_fast_features_all(players):
    """For each player, compute a daily feature matrix.

    Returns a dict pid -> {
        'date_idx': { datetime.date -> row_index_in_feats },
        'feats': np.ndarray shape (n_valid, 12),  # FAST_FEATURE_NAMES order
        'valid_dates': list of datetime.date,
        'vals_by_date': {date: value}
    }

    posRankPct and posRankPctDelta_7d are set to 0 here; they are filled in
    with a second pass once the cross-sectional rank matrix is built.
    """
    out = {}
    for p in players:
        dates = p['dates']
        vals = p['vals']
        n = len(vals)
        if n < WARMUP_DAYS + 2:
            continue

        safe_vals = np.clip(vals, 1.0, None)
        log_vals = np.log(safe_vals)

        ret1 = np.zeros(n)
        ret1[1:] = vals[1:] / safe_vals[:-1] - 1.0

        def lag_ret(H):
            r = np.zeros(n)
            if H < n:
                r[H:] = vals[H:] / safe_vals[:-H] - 1.0
            return r

        ret7 = lag_ret(7)
        ret14 = lag_ret(14)
        ret30 = lag_ret(30)

        rows = []
        valid_dates = []
        for i in range(n):
            if i < WARMUP_DAYS:
                continue
            w = vals[i - 30:i + 1]          # 31-point window (including t)
            wr = ret1[i - 30:i + 1]          # matching returns window
            mean = float(w.mean())
            std = float(w.std())
            z = (vals[i] - mean) / std if std > 0 else 0.0
            vol = float(wr[1:].std()) if len(wr) > 1 else 0.0
            w_max = float(w.max())
            w_min = float(w.min())
            dd = (vals[i] - w_max) / w_max if w_max > 0 else 0.0
            # argmax / argmin within the 31-point window: 30 = today
            argmax = int(np.argmax(w))
            argmin = int(np.argmin(w))
            days_since_max = 30 - argmax
            days_since_min = 30 - argmin
            d_i = dates[i]
            days_since_season_start = (d_i - SEASON_START).days
            phase_reg = 1.0 if SEASON_START <= d_i <= REG_SEASON_END else 0.0
            phase_playoffs = 1.0 if REG_SEASON_END < d_i <= PLAYOFFS_END else 0.0
            phase_off = 1.0 if d_i > PLAYOFFS_END else 0.0
            rows.append([
                float(log_vals[i]),
                float(ret1[i]),
                float(ret7[i]),
                float(ret14[i]),
                float(ret30[i]),
                float(z),
                float(vol),
                float(dd),
                float(days_since_max),
                float(days_since_min),
                0.0,  # posRankPct: filled in pass 2
                0.0,  # posRankPctDelta_7d: filled in pass 2
                float(days_since_season_start),
                float(phase_reg),
                float(phase_playoffs),
                float(phase_off),
            ])
            valid_dates.append(dates[i])

        if not rows:
            continue
        feats = np.array(rows, dtype=np.float64)
        date_idx = {d: i for i, d in enumerate(valid_dates)}
        out[p['pid']] = {
            'position': p['position'],
            'date_idx': date_idx,
            'feats': feats,
            'valid_dates': valid_dates,
            'vals_by_date': {d: float(v) for d, v in zip(p['dates'], p['vals'])},
        }
    return out


def fill_rank_features(players, fast_by_pid, date_grid):
    """Populate posRankPct and posRankPctDelta_7d in-place on fast_by_pid.

    For each date d in the grid, for each position, rank players by v(d)
    descending. pct_rank = (rank / (n_pos - 1)) ∈ [0, 1] where 0 = top.
    """
    # Build (pos, date) -> dict pid -> pct_rank
    # Pre-group players by position for efficiency
    by_pos = {pos: [] for pos in POSITIONS}
    for p in players:
        if p['pid'] in fast_by_pid:
            by_pos[p['position']].append(p)

    # Precompute values at each date via binary search on each player's
    # sorted dates array (player['dates'] is daily, sorted).
    pct_rank_by_pid_by_date = {}  # (pid, date) -> pct_rank
    for pos in POSITIONS:
        plist = by_pos[pos]
        for d in date_grid:
            pairs = []
            for p in plist:
                # p['dates'] is a daily, sorted np.ndarray of date objects
                dates = p['dates']
                if len(dates) == 0 or d < dates[0] or d > dates[-1]:
                    continue
                # Since daily, index is (d - dates[0]).days
                idx = (d - dates[0]).days
                if 0 <= idx < len(dates):
                    v = float(p['vals'][idx])
                    pairs.append((p['pid'], v))
            if not pairs:
                continue
            pairs.sort(key=lambda kv: -kv[1])
            n = len(pairs)
            denom = max(1, n - 1)
            for rank_i, (pid, _) in enumerate(pairs):
                pct_rank_by_pid_by_date[(pid, d)] = rank_i / denom

    # Now write per-player rank and delta features into fast_by_pid
    feat_idx_rank = FAST_FEATURE_NAMES.index('posRankPct')
    feat_idx_delta = FAST_FEATURE_NAMES.index('posRankPctDelta_7d')
    for pid, pdat in fast_by_pid.items():
        valid_dates = pdat['valid_dates']
        feats = pdat['feats']
        for i, d in enumerate(valid_dates):
            cur = pct_rank_by_pid_by_date.get((pid, d))
            if cur is None:
                continue
            feats[i, feat_idx_rank] = cur
            d_lag = d - timedelta(days=7)
            prev = pct_rank_by_pid_by_date.get((pid, d_lag))
            if prev is not None:
                feats[i, feat_idx_delta] = cur - prev


# ── Weekly features (Commit B) ──────────────────────────────────────────

def load_weekly_cache():
    """Load the preprocessed nflverse weekly cache.

    Returns (weekly_by_key, week_complete_dates) where:
      weekly_by_key: dict "<norm_name>::<pos>" -> {
        'weeks': list of per-week dicts sorted by w,
        'depthHistory': list of {dt, rank} sorted by dt,
      }
      week_complete_dates: dict int week -> datetime.date when all games
        for that week were complete (data fully available the next day).
    """
    if not NFLVERSE_WEEKLY_PATH.exists():
        print(f'  WARNING: {NFLVERSE_WEEKLY_PATH} not found — weekly features '
              'will be all-zero. Run scripts/build_nflverse_weekly_cache.py first.')
        return {}, {}
    with open(NFLVERSE_WEEKLY_PATH) as f:
        d = json.load(f)
    wcd = {int(k): date.fromisoformat(v) for k, v in d['weekCompleteDates'].items()}
    return d['players'], wcd


def _latest_completed_week(t, wcd):
    """Return the highest NFL week N such that wcd[N] <= t, or 0 if none."""
    latest = 0
    for w, d in wcd.items():
        if d <= t and w > latest:
            latest = w
    return latest


def _safe_mean(xs):
    xs = [x for x in xs if x is not None]
    return float(sum(xs) / len(xs)) if xs else 0.0


def compute_weekly_features_for_player(weekly_entry, wcd):
    """Return a dict t_ordinal -> feature_vector for one player.

    weekly_entry: value from weekly_by_key (dict with 'weeks' and 'depthHistory')

    We compute feature rows for every date t in the union of:
      - KTC daily observation dates (handled by caller via explicit t)
    Actually we lazy-compute per t in the caller, because feature values
    change discretely at week_complete boundaries and there's no point
    storing ~150 rows when ~22 step transitions suffice. This function
    returns a CLOSURE over the player's data.
    """
    weeks = weekly_entry.get('weeks', []) if weekly_entry else []
    dh = weekly_entry.get('depthHistory', []) if weekly_entry else []
    # Sort weeks by w for safety
    weeks_sorted = sorted(weeks, key=lambda x: int(x.get('w', 0)))
    # Pre-parse depthHistory dates
    dh_parsed = []
    for e in dh:
        try:
            dh_parsed.append((date.fromisoformat(e['dt']), int(e['rank'])))
        except Exception:
            continue
    dh_parsed.sort()

    def compute(t):
        """Compute 18 weekly features at sample date t."""
        if not weeks_sorted and not dh_parsed:
            # No weekly data at all for this player
            return np.zeros(len(WEEKLY_FEATURE_NAMES), dtype=np.float64)

        max_week = _latest_completed_week(t, wcd)
        visible = [w for w in weeks_sorted if int(w.get('w', 0)) <= max_week]
        has_any = 1.0 if visible else 0.0

        if visible:
            # "Games played" = weeks with offSnaps > 0 OR any offensive touch
            played = [w for w in visible
                      if (w.get('offSnaps', 0) or 0) > 0
                      or (w.get('targets', 0) or 0) > 0
                      or (w.get('carries', 0) or 0) > 0]
            season = played  # use played games, not roster weeks
            last4 = played[-4:] if played else []

            def avg(key, lst):
                return _safe_mean([r.get(key, 0) for r in lst])

            snap_season = avg('offPct', season)
            snap_last4 = avg('offPct', last4)
            tgt_season = avg('targets', season)
            tgt_last4 = avg('targets', last4)
            car_season = avg('carries', season)
            car_last4 = avg('carries', last4)
            yd_last4 = _safe_mean([
                (r.get('rushYards', 0) or 0) + (r.get('recYards', 0) or 0)
                for r in last4])
            rec_epa_last4 = avg('recEpa', last4)
            rush_epa_last4 = avg('rushEpa', last4)
            games_played = float(len(played))

            weeks_since = 0.0
            if played:
                last_week = int(played[-1].get('w', 0))
                weeks_since = float(min(10, max(0, max_week - last_week)))
            else:
                weeks_since = 10.0

            # Injury count in last 2 weeks of data
            OUT = {'Out', 'IR', 'Doubtful', 'O'}
            inj_2w = sum(
                1 for r in visible[-2:]
                if str(r.get('injuryStatus', '')) in OUT
            )
        else:
            snap_season = snap_last4 = 0.0
            tgt_season = tgt_last4 = 0.0
            car_season = car_last4 = 0.0
            yd_last4 = rec_epa_last4 = rush_epa_last4 = 0.0
            games_played = 0.0
            weeks_since = 10.0
            inj_2w = 0

        # Depth rank at t (latest entry with dt <= t) and 14 days prior
        def rank_at(target_date):
            r = None
            for dt_e, rk in dh_parsed:
                if dt_e <= target_date:
                    r = rk
                else:
                    break
            return r

        rank_now = rank_at(t)
        rank_14d = rank_at(t - timedelta(days=14))
        depth_latest = float(rank_now) if rank_now is not None else 0.0
        # Positive delta = moved up on depth chart (lower rank number)
        depth_delta = float(rank_14d - rank_now) if (rank_now is not None and rank_14d is not None) else 0.0

        return np.array([
            has_any,
            snap_last4, snap_season, snap_last4 - snap_season,
            tgt_last4, tgt_season, tgt_last4 - tgt_season,
            car_last4, car_season, car_last4 - car_season,
            yd_last4,
            rec_epa_last4, rush_epa_last4,
            games_played, weeks_since, float(inj_2w),
            depth_latest, depth_delta,
        ], dtype=np.float64)

    return compute


# ── Using the shipped PPG/residual/ADP models as KTC features ───────────
#
# The predictors for the JSON model caches live in
# scripts/lib/external_model_predictors.py (Python GBM tree walker +
# Ridge standardize/predict, matching src/lib/gbm.ts and src/lib/ridge.ts).
# That module's docstring has the full null-result writeup from the
# attempt to pipe PPG / residual / ADP model outputs in as KTC features.
#
# TL;DR: shipping external model predictions as KTC features regressed
# pgR² on every tested configuration (net -0.043 for a 5-feature pass,
# net -0.074 for a minimal 2-feature "edge-only" pass). Root cause: the
# slow-feature layer already routes the same inputs the external models
# use (priorPPG, priorPPG2yr, ppgTrend, invDraftPick, etc.), and a
# KTC-trained GBM can re-derive the non-linear combinations the external
# models compute. Emitting the external scalar alongside just gives the
# model a redundant feature it overfits on.
#
# See scripts/lib/external_model_predictors.py for the predictors and
# the list of alternative approaches we'd try before shipping external
# model outputs as features.


# ── Dataset assembly ────────────────────────────────────────────────────

def build_dataset(position, horizon, players, fast_by_pid, slow_by_pid,
                   weekly_by_key, wcd):
    """Return X, y, t_ords, pids for one (position, horizon) pair.

    t_ords: np.ndarray of int (date.toordinal()) for each row — used for
    time-based CV.

    The full (fast + slow + weekly) feature vector is assembled per row,
    then columns in DROP_GLOBAL ∪ DROP_PER_POS[position] are sliced out
    before returning. This keeps the fast_by_pid / weekly compute paths
    unchanged — pruning only changes the output shape, not the upstream
    data plumbing.
    """
    slow_keys = slow_feature_names(position)
    fn_fast = FAST_FEATURE_NAMES
    fn_weekly = WEEKLY_FEATURE_NAMES
    fn_full = fn_fast + slow_keys + fn_weekly

    # Compute the keep-indices once per (pos, horizon). These are the
    # column positions in the full concatenated vector that survive
    # after global + per-position drops.
    drops = DROP_GLOBAL | DROP_PER_POS.get(position, set())
    keep_idx = [i for i, name in enumerate(fn_full) if name not in drops]
    fn_all = [fn_full[i] for i in keep_idx]

    rows_feats = []
    rows_y = []
    rows_t = []
    rows_pid = []

    for p in players:
        if p['position'] != position:
            continue
        pid = p['pid']
        if pid not in fast_by_pid:
            continue
        pdat = fast_by_pid[pid]
        valid_dates = pdat['valid_dates']
        feats_mat = pdat['feats']
        vals_by_date = pdat['vals_by_date']
        slow_dict = slow_by_pid.get(pid, {})
        slow_vec = np.array([sf(slow_dict.get(k, 0.0)) for k in slow_keys],
                            dtype=np.float64)

        # Weekly feature closure for this player — O(visible_weeks) per call,
        # not per (player, date) — fast enough for the ~150 daily calls.
        weekly_key = f'{normalize_name(p["name"])}::{position}'
        weekly_entry = weekly_by_key.get(weekly_key)
        weekly_compute = compute_weekly_features_for_player(weekly_entry, wcd)

        for i, d in enumerate(valid_dates):
            d_fwd = d + timedelta(days=horizon)
            v_fwd = vals_by_date.get(d_fwd)
            if v_fwd is None or v_fwd <= 0:
                continue
            v_now = vals_by_date.get(d)
            if v_now is None or v_now <= 0:
                continue
            y = float(np.log(v_fwd) - np.log(v_now))
            weekly_vec = weekly_compute(d)
            x = np.concatenate([feats_mat[i], slow_vec, weekly_vec])
            rows_feats.append(x)
            rows_y.append(y)
            rows_t.append(d.toordinal())
            rows_pid.append(pid)

    if not rows_feats:
        return (np.zeros((0, len(fn_all))), np.zeros(0),
                np.zeros(0, dtype=np.int64),
                np.zeros(0, dtype=np.int64), fn_all)
    # Assemble full matrix, then slice down to the kept columns.
    X_full = np.array(rows_feats, dtype=np.float64)
    X = X_full[:, keep_idx]
    y = np.array(rows_y, dtype=np.float64)
    t = np.array(rows_t, dtype=np.int64)
    pids_arr = np.array(rows_pid, dtype=np.int64)
    return X, y, t, pids_arr, fn_all


# ── Walk-forward CV ─────────────────────────────────────────────────────

def walk_forward_cv(X, y, t, horizon, feature_names, lgb_params, n_rounds,
                     verbose_tag=None):
    """Expanding-window walk-forward CV with multi-day test windows.

    Choose CV_FOLDS cutoffs spaced evenly through the t range. At each
    cutoff T:
      Train: samples with (t + H ≤ T)  — every training target was already
             observable at T (no forward leakage from train into test).
      Test:  samples with (T ≤ t < T + CV_TEST_WINDOW_DAYS)  — multi-day
             block pooled into a single fold so fold-level R² is based on
             n_players × CV_TEST_WINDOW_DAYS predictions, not just n_players.

    All folds' predictions concatenate into one out-of-sample vector, from
    which the reported cv_r2 / cv_mae are computed.

    Returns (cv_r2, cv_mae, n_preds, n_valid_folds).
    """
    if len(X) < MIN_FOLD_TRAIN_ROWS * 2:
        return float('nan'), float('nan'), 0, 0

    t_min = int(t.min())
    t_max = int(t.max())
    span = t_max - t_min
    if span < horizon * 2:
        return float('nan'), float('nan'), 0, 0

    # Cutoffs: evenly spaced, starting at t_min + span/(K+1)
    cutoffs = [t_min + int(round(span * (k + 1) / (CV_FOLDS + 1)))
               for k in range(CV_FOLDS)]

    all_preds = []
    all_actuals = []
    valid_folds = 0

    for T in cutoffs:
        train_mask = (t + horizon) <= T
        test_mask = (t >= T) & (t < T + CV_TEST_WINDOW_DAYS)

        if train_mask.sum() < MIN_FOLD_TRAIN_ROWS or test_mask.sum() < 10:
            continue

        X_tr = X[train_mask]
        y_tr = y[train_mask]
        X_te = X[test_mask]
        y_te = y[test_mask]

        booster = train_lgb_model(X_tr, y_tr, feature_names, lgb_params, n_rounds)
        preds = booster.predict(X_te)
        all_preds.extend(preds.tolist())
        all_actuals.extend(y_te.tolist())
        valid_folds += 1

        if verbose_tag:
            fold_r2 = r2_score(y_te, preds)
            fold_mae = mean_absolute_error(y_te, preds)
            T_date = date.fromordinal(T).isoformat()
            print(f'      [{verbose_tag}] T={T_date} '
                  f'n_tr={train_mask.sum():5d} n_te={test_mask.sum():4d} '
                  f'foldR²={fold_r2:+.4f} foldMAE={fold_mae:.5f} '
                  f'yTrMean={y_tr.mean():+.4f} yTeMean={y_te.mean():+.4f}')

    if len(all_preds) < 10:
        return float('nan'), float('nan'), len(all_preds), valid_folds

    all_preds = np.array(all_preds)
    all_actuals = np.array(all_actuals)
    r2 = float(r2_score(all_actuals, all_preds))
    mae = float(mean_absolute_error(all_actuals, all_preds))
    return r2, mae, len(all_preds), valid_folds


# ── Player-grouped CV ──────────────────────────────────────────────────

def player_grouped_cv(X, y, pids, feature_names, lgb_params, n_rounds,
                       verbose_tag=None):
    """K-fold cross-validation with players as the grouping unit.

    Deterministically partition the unique players into PLAYER_CV_FOLDS
    cohorts. For each fold, train on (4/K) of the players' full (t, y)
    samples and predict on the held-out player cohort. Pool predictions
    across all K folds into one out-of-sample vector.

    This is the correct generalization metric for long horizons where the
    usable t-range is too short for walk-forward (see module docstring).
    It measures: "given many players' H-day trajectories in the observed
    period, how well does the model predict a new player's trajectory in
    the same period?" — a different claim than walk-forward's temporal
    extrapolation, but equally honest: no held-out player's rows appear
    anywhere in its own fold's training set.

    Returns (cv_r2, cv_mae, n_preds, n_valid_folds).
    """
    if len(X) < MIN_FOLD_TRAIN_ROWS * 2:
        return float('nan'), float('nan'), 0, 0

    unique_pids = np.unique(pids)
    if len(unique_pids) < PLAYER_CV_FOLDS * 2:
        return float('nan'), float('nan'), 0, 0

    # Deterministic shuffle + modulo assignment → each fold gets ~same
    # number of players regardless of pid distribution.
    rng = np.random.default_rng(42)
    shuffled = rng.permutation(unique_pids)
    fold_of_pid = {pid: i % PLAYER_CV_FOLDS for i, pid in enumerate(shuffled)}
    fold_assign = np.array([fold_of_pid[p] for p in pids], dtype=np.int64)

    all_preds = []
    all_actuals = []
    valid_folds = 0

    for k in range(PLAYER_CV_FOLDS):
        train_mask = fold_assign != k
        test_mask = fold_assign == k

        if train_mask.sum() < MIN_FOLD_TRAIN_ROWS or test_mask.sum() < 10:
            continue

        X_tr = X[train_mask]
        y_tr = y[train_mask]
        X_te = X[test_mask]
        y_te = y[test_mask]

        booster = train_lgb_model(X_tr, y_tr, feature_names, lgb_params, n_rounds)
        preds = booster.predict(X_te)
        all_preds.extend(preds.tolist())
        all_actuals.extend(y_te.tolist())
        valid_folds += 1

        if verbose_tag:
            fold_r2 = r2_score(y_te, preds)
            fold_mae = mean_absolute_error(y_te, preds)
            n_test_players = len(np.unique(pids[test_mask]))
            print(f'      [{verbose_tag}/pCV] k={k} '
                  f'n_tr={train_mask.sum():5d} n_te={test_mask.sum():4d} '
                  f'players_te={n_test_players:3d} '
                  f'foldR²={fold_r2:+.4f} foldMAE={fold_mae:.5f}')

    if len(all_preds) < 10:
        return float('nan'), float('nan'), len(all_preds), valid_folds

    all_preds = np.array(all_preds)
    all_actuals = np.array(all_actuals)
    r2 = float(r2_score(all_actuals, all_preds))
    mae = float(mean_absolute_error(all_actuals, all_preds))
    return r2, mae, len(all_preds), valid_folds


# ── Main training loop ──────────────────────────────────────────────────

# Starting hyperparams. These are intentionally heavily regularized for
# the baseline — time-series log-returns on 20k+ rows of highly correlated
# (same-player) training data will overfit a low-min-leaf shallow LGB
# brutally, as the first pass showed (in-sample R² 0.79 vs CV R² -2.7 on
# RB H=30). Commit C will sweep per (position, horizon) — for now these
# conservative defaults give every position a chance at a positive cvR².
BASE_LGB_PARAMS = {
    'objective': 'regression', 'metric': 'mae',
    'learning_rate': 0.03, 'max_depth': 2,
    'min_child_samples': 500,   # heavy — models pool rows across many players
    'subsample': 0.7, 'bagging_freq': 1,
    'colsample_bytree': 0.5,
    'lambda_l2': 5.0,
    'seed': 42, 'n_jobs': 1,
}
BASE_N_ROUNDS = 60

# ── Per-(position, horizon) swept hyperparams (Commit C.2b) ───────────
# Winners from the 48-config sweep in public/data/ktc-hyperparam-sweep.json.
# Each entry overrides BASE_LGB_PARAMS + BASE_N_ROUNDS for that pair.
# Keys that match the baseline (QB_H90, TE_H120) are omitted — they use
# BASE_LGB_PARAMS / BASE_N_ROUNDS as-is.
#
# Net effect: +1.17 pgR² across 20 models, 14 wins 0 losses, 6 ties.
# RB long horizons jumped 4× (e.g. RB_H90: 0.079 → 0.348).
SWEPT_PARAMS = {
    'QB_H7':   {'max_depth': 3, 'min_child_samples': 150, 'colsample_bytree': 0.8, 'lambda_l2': 3.0, 'learning_rate': 0.05, '_n_rounds': 100},
    'QB_H30':  {'learning_rate': 0.05, 'lambda_l2': 3.0, '_n_rounds': 100},
    'QB_H60':  {'colsample_bytree': 0.8, 'lambda_l2': 3.0},
    # QB_H90: baseline is winner
    'QB_H120': {'learning_rate': 0.05, 'colsample_bytree': 0.8, 'lambda_l2': 5.0, '_n_rounds': 100},
    'RB_H7':   {'max_depth': 3, 'min_child_samples': 150, 'colsample_bytree': 0.8, 'lambda_l2': 3.0, 'learning_rate': 0.05, '_n_rounds': 100},
    'RB_H30':  {'max_depth': 3, 'min_child_samples': 150, 'colsample_bytree': 0.8, 'lambda_l2': 3.0, 'learning_rate': 0.05, '_n_rounds': 100},
    'RB_H60':  {'max_depth': 3, 'min_child_samples': 150, 'colsample_bytree': 0.8, 'lambda_l2': 3.0, 'learning_rate': 0.05, '_n_rounds': 100},
    'RB_H90':  {'max_depth': 3, 'min_child_samples': 150, 'colsample_bytree': 0.8, 'lambda_l2': 3.0, 'learning_rate': 0.05, '_n_rounds': 100},
    'RB_H120': {'max_depth': 2, 'min_child_samples': 150, 'colsample_bytree': 0.8, 'lambda_l2': 5.0, 'learning_rate': 0.05, '_n_rounds': 100},
    'WR_H7':   {'max_depth': 3, 'min_child_samples': 150, 'colsample_bytree': 0.8, 'lambda_l2': 3.0, 'learning_rate': 0.05, '_n_rounds': 100},
    'WR_H30':  {'max_depth': 3, 'min_child_samples': 150, 'colsample_bytree': 0.5, 'lambda_l2': 3.0, 'learning_rate': 0.05, '_n_rounds': 100},
    'WR_H60':  {'min_child_samples': 150, 'lambda_l2': 3.0},
    'WR_H90':  {'min_child_samples': 150, 'lambda_l2': 3.0},
    'WR_H120': {'max_depth': 3},
    'TE_H7':   {'min_child_samples': 150, 'learning_rate': 0.05, 'lambda_l2': 3.0, '_n_rounds': 100},
    'TE_H30':  {'learning_rate': 0.05, 'lambda_l2': 5.0, '_n_rounds': 100},
    'TE_H60':  {'max_depth': 3, 'colsample_bytree': 0.8},
    'TE_H90':  {'colsample_bytree': 0.8, 'lambda_l2': 3.0, 'learning_rate': 0.05, '_n_rounds': 100},
    # TE_H120: baseline is winner
}


def get_params_for_pair(pos, horizon):
    """Return (lgb_params, n_rounds) for a (position, horizon) pair,
    merging any swept overrides into the base config."""
    key = f'{pos}_H{horizon}'
    overrides = dict(SWEPT_PARAMS.get(key, {}))
    n_rounds = overrides.pop('_n_rounds', BASE_N_ROUNDS)
    params = {**BASE_LGB_PARAMS, **overrides}
    return params, n_rounds


# A relaxed config (depth=3, mcs=300, lambda=3, n=80) was tried in Commit B
# and regressed hard on both walk-forward H=30 (RB -0.099 → -0.526) and
# player-grouped long horizons (WR H=90 -0.001 → -0.059, TE H=90 0.114 →
# 0.048) while lifting in-sample R² to 0.4-0.6. Capacity ≠ generalization
# at this sample size; the depth-2 shrinkage that rescued RB H=30 in
# Commit A also caps the interaction-discovery the weekly features allow.
# Commit C's per-(position, horizon) sweep is the right place to unlock
# any remaining capacity; universal hyperparam bumps don't work here.


def _compute_cv_residual_std(X, y, pids, feature_names, lgb_params, n_rounds):
    """Compute std of CV residuals via player-grouped K-fold.

    This gives the out-of-sample prediction error distribution width,
    used for confidence interval bands on the dynasty forecast page.
    Returns None if too few data for CV.
    """
    unique_pids = np.unique(pids)
    if len(unique_pids) < PLAYER_CV_FOLDS * 2 or len(X) < MIN_FOLD_TRAIN_ROWS * 2:
        return None

    rng = np.random.default_rng(42)
    shuffled = rng.permutation(unique_pids)
    fold_of_pid = {pid: i % PLAYER_CV_FOLDS for i, pid in enumerate(shuffled)}
    fold_assign = np.array([fold_of_pid[p] for p in pids], dtype=np.int64)

    all_residuals = []
    for k in range(PLAYER_CV_FOLDS):
        train_mask = fold_assign != k
        test_mask = fold_assign == k
        if train_mask.sum() < MIN_FOLD_TRAIN_ROWS or test_mask.sum() < 10:
            continue
        booster = train_lgb_model(X[train_mask], y[train_mask],
                                   feature_names, lgb_params, n_rounds)
        preds = booster.predict(X[test_mask])
        residuals = y[test_mask] - preds
        all_residuals.extend(residuals.tolist())

    if len(all_residuals) < 20:
        return None
    return float(np.std(all_residuals))


def train_all(players, fast_by_pid, slow_by_pid, weekly_by_key, wcd, verbose=False):
    results = {'models': {}, 'metadata': {
        'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'schemaVersion': 6,   # 6: per-(pos, H) swept hyperparams + cvResidualStd (C.2b)
        'horizons': list(HORIZONS),
        'positions': list(POSITIONS),
        'warmupDays': WARMUP_DAYS,
        'walkForwardFolds': CV_FOLDS,
        'walkForwardTestWindowDays': CV_TEST_WINDOW_DAYS,
        'walkForwardMaxHorizon': WALK_FORWARD_MAX_H,
        'playerGroupedFolds': PLAYER_CV_FOLDS,
        'baseLgbParams': {k: v for k, v in BASE_LGB_PARAMS.items()},
        'baseNRounds': BASE_N_ROUNDS,
        'sweptParams': {k: v for k, v in SWEPT_PARAMS.items()},
        'fastFeatures': FAST_FEATURE_NAMES,
        'slowFeaturesCommon': SLOW_COMMON,
        'slowFeaturesByPos': SLOW_POS,
        'weeklyFeatures': WEEKLY_FEATURE_NAMES,
        'droppedGlobal': sorted(DROP_GLOBAL),
        'droppedPerPos': {p: sorted(fs) for p, fs in DROP_PER_POS.items()},
    }}

    summary_rows = []
    for pos in POSITIONS:
        for horizon in HORIZONS:
            X, y, t, pids, fn_all = build_dataset(
                pos, horizon, players, fast_by_pid, slow_by_pid,
                weekly_by_key, wcd)
            n = len(y)
            if n < 100:
                print(f'  {pos} H={horizon}: n={n} — SKIPPED (too few rows)')
                continue

            # Per-pair hyperparams from the sweep (C.2b)
            lgb_params, n_rounds = get_params_for_pair(pos, horizon)

            # Walk-forward is only honest for short horizons (see module
            # docstring). Skip entirely above WALK_FORWARD_MAX_H — reporting
            # walk-forward NaN would be misleading because it's a data-
            # envelope limitation, not a model failure.
            if horizon <= WALK_FORWARD_MAX_H:
                wf_r2, wf_mae, wf_n, wf_folds = walk_forward_cv(
                    X, y, t, horizon, fn_all, lgb_params, n_rounds,
                    verbose_tag=f'{pos}/H{horizon}' if verbose else None)
            else:
                wf_r2, wf_mae, wf_n, wf_folds = float('nan'), float('nan'), 0, 0

            # Player-grouped CV runs for every horizon: this is the primary
            # metric for long horizons, and a useful cross-check for short ones.
            pg_r2, pg_mae, pg_n, pg_folds = player_grouped_cv(
                X, y, pids, fn_all, lgb_params, n_rounds,
                verbose_tag=f'{pos}/H{horizon}' if verbose else None)

            # Primary cvR² = walk-forward if available (temporal is the
            # stronger claim), player-grouped otherwise.
            primary_r2 = wf_r2 if horizon <= WALK_FORWARD_MAX_H and not np.isnan(wf_r2) else pg_r2
            primary_mae = wf_mae if horizon <= WALK_FORWARD_MAX_H and not np.isnan(wf_mae) else pg_mae
            primary_scheme = 'walk_forward' if (horizon <= WALK_FORWARD_MAX_H and not np.isnan(wf_r2)) else 'player_grouped'

            # Full-data model for deployment
            booster = train_lgb_model(X, y, fn_all, lgb_params, n_rounds)
            gbm_js = lgb_to_js_gbm(booster, X, y, fn_all)

            # Compute CV residual std for confidence interval bands.
            # Uses player-grouped CV residuals (available for all horizons)
            # to estimate the std of (y_actual - y_predicted) out-of-sample.
            cv_resid_std = _compute_cv_residual_std(
                X, y, pids, fn_all, lgb_params, n_rounds)

            key = f'{pos}_H{horizon}'
            results['models'][key] = {
                'position': pos,
                'horizon': horizon,
                'gbmModel': gbm_js,
                'featureNames': fn_all,
                'lgbParams': {k: v for k, v in lgb_params.items()},
                'nRounds': n_rounds,
                'n': int(n),
                'yMean': float(y.mean()),
                'yStd': float(y.std()),
                'yMin': float(y.min()),
                'yMax': float(y.max()),
                'cvResidualStd': round(cv_resid_std, 6) if cv_resid_std is not None else None,
                # Primary metrics (the one you should quote)
                'cvR2': round(primary_r2, 4) if not np.isnan(primary_r2) else None,
                'cvMae': round(primary_mae, 5) if not np.isnan(primary_mae) else None,
                'cvScheme': primary_scheme,
                # Walk-forward breakdown (null if infeasible)
                'cvR2WalkForward': round(wf_r2, 4) if not np.isnan(wf_r2) else None,
                'cvMaeWalkForward': round(wf_mae, 5) if not np.isnan(wf_mae) else None,
                'cvNPredsWalkForward': int(wf_n),
                'cvValidFoldsWalkForward': int(wf_folds),
                # Player-grouped breakdown (null if infeasible)
                'cvR2PlayerGrouped': round(pg_r2, 4) if not np.isnan(pg_r2) else None,
                'cvMaePlayerGrouped': round(pg_mae, 5) if not np.isnan(pg_mae) else None,
                'cvNPredsPlayerGrouped': int(pg_n),
                'cvValidFoldsPlayerGrouped': int(pg_folds),
                'inSampleR2': gbm_js['rSquared'],
            }
            summary_rows.append((pos, horizon, n, wf_r2, pg_r2, primary_scheme,
                                 gbm_js['rSquared']))
            wf_s = f'{wf_r2:+.4f}' if not np.isnan(wf_r2) else '   N/A'
            pg_s = f'{pg_r2:+.4f}' if not np.isnan(pg_r2) else '   N/A'
            print(f'  {pos} H={horizon:3d}: n={n:6d}  '
                  f'wfR²={wf_s} pgR²={pg_s}  '
                  f'in-sample R²={gbm_js["rSquared"]:+.4f}  '
                  f'primary={primary_scheme}')

    print()
    print('Summary (honest out-of-sample CV):')
    print('  walkForward = temporal expanding-window; playerGrouped = '
          'cross-player K-fold')
    print(f'  {"pos":>4} {"H":>4} {"n":>7} {"wfR²":>8} {"pgR²":>8} '
          f'{"primary":>14} {"inSampR²":>9}')
    for row in summary_rows:
        pos, h, n, wfr2, pgr2, scheme, in_r2 = row
        wf_s = f'{wfr2:+.4f}' if not np.isnan(wfr2) else '   N/A'
        pg_s = f'{pgr2:+.4f}' if not np.isnan(pgr2) else '   N/A'
        print(f'  {pos:>4} {h:>4} {n:>7} {wf_s:>8} {pg_s:>8} '
              f'{scheme:>14} {in_r2:>+9.4f}')

    return results


def main():
    verbose = '--verbose' in sys.argv or '-v' in sys.argv
    print(f'Loading {KTC_HISTORY_PATH}, {KTC_RANKINGS_PATH}, {TRAINING_CACHE_PATH}...')
    t0 = time.time()
    players, slow_by_pid, date_grid = load_inputs()
    print(f'Loaded {len(players)} players in {time.time() - t0:.1f}s')

    print('Computing fast features per player...')
    t0 = time.time()
    fast_by_pid = compute_fast_features_all(players)
    print(f'  {len(fast_by_pid)} players with ≥{WARMUP_DAYS}-day history '
          f'({time.time() - t0:.1f}s)')

    print('Filling cross-sectional rank features...')
    t0 = time.time()
    fill_rank_features(players, fast_by_pid, date_grid)
    print(f'  done ({time.time() - t0:.1f}s)')

    print()
    print('Training per (position, horizon):')
    print('Loading nflverse weekly cache...')
    weekly_by_key, wcd = load_weekly_cache()
    print(f'  {len(weekly_by_key)} (name, pos) entries, '
          f'{len(wcd)} week boundaries')

    results = train_all(players, fast_by_pid, slow_by_pid, weekly_by_key, wcd,
                         verbose=verbose)

    print()
    print(f'Writing {OUTPUT_PATH}...')
    with open(OUTPUT_PATH, 'w') as f:
        json.dump(results, f)
    size_mb = OUTPUT_PATH.stat().st_size / 1024 / 1024
    print(f'  {size_mb:.2f} MB')


if __name__ == '__main__':
    main()
