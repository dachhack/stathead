#!/usr/bin/env python3
"""
Backtest team volume projections: simple blend vs delta Ridge vs LightGBM.

Reads team-level features from the feature store (coaching, environment,
competition, team-features-backfill) and actual team totals from nflverse
player_stats CSVs. Uses LOSO (leave-one-season-out) cross-validation.

Usage:
    python3 scripts/backtest_team_projections.py
"""

import json
import os
import subprocess
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.linear_model import Ridge
from sklearn.metrics import r2_score, mean_absolute_error

warnings.filterwarnings('ignore')

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / 'public' / 'data'
FS_DIR = DATA_DIR / 'feature-store'
NFLVERSE = 'https://github.com/nflverse/nflverse-data/releases/download'

# Seasons to backtest (predict each of these using prior-season data)
TEST_SEASONS = [2020, 2021, 2022, 2023, 2024, 2025]

# Stats we're projecting at team level
STAT_KEYS = ['passAtt', 'rushAtt', 'targets', 'passTD', 'rushTD',
             'passYds', 'rushYds', 'recYds']


# ═══════════════════════════════════════════════════════════════════
# Data loading
# ═══════════════════════════════════════════════════════════════════

def download_if_missing(filename: str, url: str):
    path = DATA_DIR / filename
    if path.exists():
        return
    print(f'  Downloading {filename}...')
    try:
        subprocess.run(['curl', '-sfL', url, '-o', str(path)],
                       capture_output=True, check=True)
    except Exception:
        print(f'  Warning: could not download {filename}')


def load_player_stats_csv(season: int) -> pd.DataFrame:
    """Load nflverse player_stats CSV for a season."""
    filename = f'player_stats_{season}.csv'
    url = (f'{NFLVERSE}/stats_player/stats_player_week_{season}.csv'
           if season >= 2025
           else f'{NFLVERSE}/player_stats/player_stats_{season}.csv')
    download_if_missing(filename, url)
    path = DATA_DIR / filename
    if not path.exists():
        return pd.DataFrame()
    df = pd.read_csv(path, low_memory=False)
    df = df[df['season_type'] == 'REG'].copy()
    # Normalize team column (2025+ uses 'team' instead of 'recent_team')
    if 'recent_team' not in df.columns and 'team' in df.columns:
        df['recent_team'] = df['team']
    return df


def aggregate_team_totals(df: pd.DataFrame) -> dict[str, dict]:
    """Aggregate weekly player stats to team-season totals."""
    if df.empty:
        return {}
    teams = {}
    for _, row in df.iterrows():
        team = row.get('recent_team', '')
        if not team or pd.isna(team):
            continue
        pos = row.get('position', '')
        if pos not in ('QB', 'RB', 'WR', 'TE'):
            continue
        if team not in teams:
            teams[team] = {k: 0 for k in STAT_KEYS}
        t = teams[team]
        t['passAtt'] += int(row.get('attempts', 0) or 0)
        t['rushAtt'] += int(row.get('carries', 0) or 0)
        t['targets'] += int(row.get('targets', 0) or 0)
        t['passTD'] += int(row.get('passing_tds', 0) or 0)
        t['rushTD'] += int(row.get('rushing_tds', 0) or 0)
        t['passYds'] += int(row.get('passing_yards', 0) or 0)
        t['rushYds'] += int(row.get('rushing_yards', 0) or 0)
        t['recYds'] += int(row.get('receiving_yards', 0) or 0)
    return teams


def load_feature_store() -> dict:
    """Load all feature store shards into a unified dict keyed by 'name::season'."""
    shards = {}
    for name in ['coaching', 'environment', 'competition', 'priorStats', 'profile',
                 'projection', 'vegas']:
        path = FS_DIR / f'{name}.json'
        if path.exists():
            with open(path) as f:
                shards[name] = json.load(f)
        else:
            print(f'  Warning: {name}.json not found in feature store')
            shards[name] = {}
    # Team-level features (keyed by team, not player)
    tf_path = DATA_DIR / 'team-features-backfill.json'
    if tf_path.exists():
        with open(tf_path) as f:
            shards['teamFeatures'] = json.load(f)
    else:
        shards['teamFeatures'] = {}
    return shards


def build_team_feature_rows(
    shards: dict,
    actual_totals: dict[int, dict[str, dict]],   # season → team → stat totals
    prior_totals: dict[int, dict[str, dict]],     # season-1 totals (for blend baseline)
) -> pd.DataFrame:
    """Build one row per (team, season) with team-level features + actual targets.

    Strategy: for each team-season, find a representative player in the feature
    store and extract team-level features. All players on the same team share
    these features, so we just need one.
    """
    coaching = shards['coaching']
    environment = shards['environment']
    competition = shards['competition']
    vegas_fs = shards.get('vegas', {})
    tf = shards['teamFeatures']
    name_to_team = tf.get('nameToTeam', {})
    per_season_tf = tf.get('perSeason', {})

    # Build reverse index: (team, season) → list of player keys in feature store
    team_season_players: dict[tuple[str, int], list[str]] = {}
    for season_str, mapping in name_to_team.items():
        season = int(season_str)
        for player_name, team in mapping.items():
            key = (team, season)
            if key not in team_season_players:
                team_season_players[key] = []
            team_season_players[key].append(f'{player_name}::{season}')

    rows = []
    for season in sorted(actual_totals.keys()):
        actuals = actual_totals[season]
        priors = prior_totals.get(season)
        if not priors:
            continue

        # League averages from prior season
        league_avg = {k: 0 for k in STAT_KEYS}
        n_teams = len(priors)
        for t_stats in priors.values():
            for k in STAT_KEYS:
                league_avg[k] += t_stats.get(k, 0)
        if n_teams > 0:
            for k in STAT_KEYS:
                league_avg[k] /= n_teams

        for team, actual in actuals.items():
            prior = priors.get(team)
            if not prior:
                continue

            # Find representative player for this team-season in feature store
            player_keys = team_season_players.get((team, season), [])
            # Pick the first player that has coaching features
            fs_features = {}
            for pk in player_keys:
                if pk in coaching and coaching[pk].get('teamPassRate', 0) > 0:
                    fs_features = {
                        **coaching.get(pk, {}),
                        **environment.get(pk, {}),
                        **competition.get(pk, {}),
                        **vegas_fs.get(pk, {}),
                    }
                    break
            # Fallback: try any player key with non-zero features
            if not fs_features:
                for pk in player_keys:
                    if pk in coaching:
                        fs_features = {
                            **coaching.get(pk, {}),
                            **environment.get(pk, {}),
                            **competition.get(pk, {}),
                            **vegas_fs.get(pk, {}),
                        }
                        break

            # Team-level features from backfill (personnel rates)
            tf_team = per_season_tf.get(str(season), {}).get(team, {})
            # Prior season personnel (what we'd know before the season)
            tf_prior = per_season_tf.get(str(season - 1), {}).get(team, {})

            # Prior-season totals (2 years back for trend)
            prior2 = prior_totals.get(season - 1, {}).get(team, {})

            row = {
                'team': team,
                'season': season,
                # ── Prior season volumes (what we're regressing from) ──
                'priorPassAtt': prior.get('passAtt', 0),
                'priorRushAtt': prior.get('rushAtt', 0),
                'priorTargets': prior.get('targets', 0),
                'priorPassTD': prior.get('passTD', 0),
                'priorRushTD': prior.get('rushTD', 0),
                'priorPassYds': prior.get('passYds', 0),
                'priorRushYds': prior.get('rushYds', 0),
                'priorRecYds': prior.get('recYds', 0),
                # ── 2-year trends ──
                'passAttTrend': prior.get('passAtt', 0) - prior2.get('passAtt', 0) if prior2 else 0,
                'rushAttTrend': prior.get('rushAtt', 0) - prior2.get('rushAtt', 0) if prior2 else 0,
                'targetsTrend': prior.get('targets', 0) - prior2.get('targets', 0) if prior2 else 0,
                # ── Feature store: coaching / scheme ──
                'newHeadCoach': fs_features.get('newHeadCoach', 0),
                'teamPassRate': fs_features.get('teamPassRate', 0),
                'teamNeutralPassRate': fs_features.get('teamNeutralPassRate', 0),
                'teamPace': fs_features.get('teamPace', 0),
                'teamFirstDownRunRate': fs_features.get('teamFirstDownRunRate', 0),
                'teamShotgunRate': fs_features.get('teamShotgunRate', 0),
                'teamNoHuddleRate': fs_features.get('teamNoHuddleRate', 0),
                'coachPriorTeamPPR': fs_features.get('coachPriorTeamPPR', 0),
                # ── Feature store: environment ──
                'teamSackRate': fs_features.get('teamSackRate', 0),
                'teamRushYPC': fs_features.get('teamRushYPC', 0),
                'teamDomeGames': fs_features.get('teamDomeGames', 0),
                # ── Feature store: vegas ──
                'vegasImpliedTotal': fs_features.get('vegasImpliedTotal', 0),
                'vegasWinPct': fs_features.get('vegasWinPct', 0),
                'vegasImpliedSpread': fs_features.get('vegasImpliedSpread', 0),
                'vegasSeasonWinTotal': fs_features.get('vegasSeasonWinTotal', 0),
                'vegasGameTotal': fs_features.get('vegasGameTotal', 0),
                # ── Feature store: competition / roster ──
                'teamRosterTurnover': fs_features.get('teamRosterTurnover', 0),
                # ── Team-features-backfill: personnel (prior season) ──
                'team11Rate': tf_prior.get('team11Rate', 0),
                'team12Rate': tf_prior.get('team12Rate', 0),
                'teamRBTargetRate': tf_prior.get('teamRBTargetRate', 0),
                'teamTETargetRate': tf_prior.get('teamTETargetRate', 0),
                'teamWRTargetRate': tf_prior.get('teamWRTargetRate', 0),
                # ── League average (for blend model) ──
                **{f'leagueAvg_{k}': league_avg[k] for k in STAT_KEYS},
                # ── Actual targets ──
                **{f'actual_{k}': actual[k] for k in STAT_KEYS},
            }
            rows.append(row)

    return pd.DataFrame(rows)


# ═══════════════════════════════════════════════════════════════════
# Model 1: Simple blend (current production)
# ═══════════════════════════════════════════════════════════════════

def predict_blend(df: pd.DataFrame, team_weight: float = 0.4) -> dict[str, np.ndarray]:
    """prior * weight + league_avg * (1 - weight)."""
    preds = {}
    lw = 1 - team_weight
    for stat in STAT_KEYS:
        prior_col = f'prior{stat[0].upper()}{stat[1:]}'
        league_col = f'leagueAvg_{stat}'
        preds[stat] = df[prior_col].values * team_weight + df[league_col].values * lw
    return preds


# ═══════════════════════════════════════════════════════════════════
# Model 2: Delta Ridge (predict YoY change, add to prior)
# ═══════════════════════════════════════════════════════════════════

DELTA_FEATURES = [
    'priorPassAtt', 'priorRushAtt', 'priorTargets',
    'passAttTrend', 'rushAttTrend', 'targetsTrend',
    'newHeadCoach', 'coachPriorTeamPPR',
    'vegasImpliedTotal', 'vegasWinPct', 'vegasSeasonWinTotal',
    'teamPassRate', 'teamNeutralPassRate', 'teamPace',
    'teamRushYPC', 'teamSackRate',
]


def predict_delta_loso(df: pd.DataFrame) -> dict[str, np.ndarray]:
    """LOSO Ridge on year-over-year deltas. projected = prior + predicted_delta."""
    seasons = sorted(df['season'].unique())
    preds = {stat: np.full(len(df), np.nan) for stat in STAT_KEYS}

    for held_season in seasons:
        train_mask = df['season'] != held_season
        test_mask = df['season'] == held_season
        train_df = df[train_mask]
        test_df = df[test_mask]
        if len(train_df) < 30 or len(test_df) == 0:
            continue

        X_train = train_df[DELTA_FEATURES].fillna(0).values
        X_test = test_df[DELTA_FEATURES].fillna(0).values

        for stat in STAT_KEYS:
            prior_col = f'prior{stat[0].upper()}{stat[1:]}'
            actual_col = f'actual_{stat}'
            # Delta = actual - prior
            y_delta = (train_df[actual_col] - train_df[prior_col]).values

            ridge = Ridge(alpha=8.0)
            ridge.fit(X_train, y_delta)
            pred_delta = ridge.predict(X_test)

            # projected = prior + predicted_delta
            prior_vals = test_df[prior_col].values
            preds[stat][test_mask] = prior_vals + pred_delta

    return preds


# ═══════════════════════════════════════════════════════════════════
# Model 3: LightGBM (full feature set from feature store)
# ═══════════════════════════════════════════════════════════════════

GBM_FEATURES = [
    # Prior volumes
    'priorPassAtt', 'priorRushAtt', 'priorTargets',
    'priorPassTD', 'priorRushTD', 'priorPassYds', 'priorRushYds', 'priorRecYds',
    # Trends
    'passAttTrend', 'rushAttTrend', 'targetsTrend',
    # Coaching / scheme
    'newHeadCoach', 'coachPriorTeamPPR',
    'teamPassRate', 'teamNeutralPassRate', 'teamPace',
    'teamFirstDownRunRate', 'teamShotgunRate', 'teamNoHuddleRate',
    # Environment
    'teamSackRate', 'teamRushYPC', 'teamDomeGames',
    # Vegas
    'vegasImpliedTotal', 'vegasWinPct', 'vegasImpliedSpread',
    'vegasSeasonWinTotal', 'vegasGameTotal',
    # Roster
    'teamRosterTurnover',
    # Personnel
    'team11Rate', 'team12Rate',
    'teamRBTargetRate', 'teamTETargetRate', 'teamWRTargetRate',
]

LGB_PARAMS = {
    'objective': 'regression',
    'metric': 'mae',
    'learning_rate': 0.05,
    'max_depth': 3,
    'min_child_samples': 8,
    'subsample': 0.8,
    'colsample_bytree': 0.85,
    'seed': 42,
    'n_jobs': 1,
    'verbosity': -1,
}
N_ROUNDS = 80


def predict_gbm_loso(df: pd.DataFrame) -> dict[str, np.ndarray]:
    """LOSO LightGBM predicting absolute team totals."""
    seasons = sorted(df['season'].unique())
    preds = {stat: np.full(len(df), np.nan) for stat in STAT_KEYS}

    for held_season in seasons:
        train_mask = df['season'] != held_season
        test_mask = df['season'] == held_season
        train_df = df[train_mask]
        test_df = df[test_mask]
        if len(train_df) < 30 or len(test_df) == 0:
            continue

        X_train = train_df[GBM_FEATURES].fillna(0).values
        X_test = test_df[GBM_FEATURES].fillna(0).values

        for stat in STAT_KEYS:
            actual_col = f'actual_{stat}'
            y_train = train_df[actual_col].values

            ds_train = lgb.Dataset(X_train, label=y_train,
                                   feature_name=GBM_FEATURES, free_raw_data=False)
            model = lgb.train(LGB_PARAMS, ds_train, num_boost_round=N_ROUNDS)
            preds[stat][test_mask] = model.predict(X_test)

    return preds


# ═══════════════════════════════════════════════════════════════════
# Model 4: Ensemble (Ridge delta + GBM blend)
# ═══════════════════════════════════════════════════════════════════

def predict_ensemble_loso(df: pd.DataFrame,
                          ridge_weight: float = 0.4) -> dict[str, np.ndarray]:
    """LOSO ensemble: weighted average of Delta Ridge and GBM."""
    seasons = sorted(df['season'].unique())
    preds = {stat: np.full(len(df), np.nan) for stat in STAT_KEYS}

    for held_season in seasons:
        train_mask = df['season'] != held_season
        test_mask = df['season'] == held_season
        train_df = df[train_mask]
        test_df = df[test_mask]
        if len(train_df) < 30 or len(test_df) == 0:
            continue

        X_delta_train = train_df[DELTA_FEATURES].fillna(0).values
        X_delta_test = test_df[DELTA_FEATURES].fillna(0).values
        X_gbm_train = train_df[GBM_FEATURES].fillna(0).values
        X_gbm_test = test_df[GBM_FEATURES].fillna(0).values

        for stat in STAT_KEYS:
            prior_col = f'prior{stat[0].upper()}{stat[1:]}'
            actual_col = f'actual_{stat}'

            # Ridge delta
            y_delta = (train_df[actual_col] - train_df[prior_col]).values
            ridge = Ridge(alpha=8.0)
            ridge.fit(X_delta_train, y_delta)
            ridge_pred = test_df[prior_col].values + ridge.predict(X_delta_test)

            # GBM absolute
            y_train = train_df[actual_col].values
            ds_train = lgb.Dataset(X_gbm_train, label=y_train,
                                   feature_name=GBM_FEATURES, free_raw_data=False)
            gbm = lgb.train(LGB_PARAMS, ds_train, num_boost_round=N_ROUNDS)
            gbm_pred = gbm.predict(X_gbm_test)

            preds[stat][test_mask] = ridge_pred * ridge_weight + gbm_pred * (1 - ridge_weight)

    return preds


# ═══════════════════════════════════════════════════════════════════
# Evaluation
# ═══════════════════════════════════════════════════════════════════

def evaluate(df: pd.DataFrame, preds: dict[str, np.ndarray], label: str):
    """Compute MAE and % error per stat."""
    results = {}
    for stat in STAT_KEYS:
        actual = df[f'actual_{stat}'].values
        pred = preds[stat]
        valid = ~np.isnan(pred)
        if valid.sum() == 0:
            results[stat] = {'mae': 0, 'pctErr': 0, 'r2': 0}
            continue
        a, p = actual[valid], pred[valid]
        mae = float(mean_absolute_error(a, p))
        mean_actual = float(np.mean(a))
        pct_err = (mae / mean_actual * 100) if mean_actual > 0 else 0
        r2 = float(r2_score(a, p))
        results[stat] = {'mae': round(mae, 1), 'pctErr': round(pct_err, 1), 'r2': round(r2, 3)}

    avg_pct = np.mean([v['pctErr'] for v in results.values()])
    avg_r2 = np.mean([v['r2'] for v in results.values()])
    results['_avg'] = {'mae': 0, 'pctErr': round(avg_pct, 2), 'r2': round(avg_r2, 3)}
    return results


def print_results(all_results: dict[str, dict]):
    """Print comparison table."""
    models = list(all_results.keys())
    header = f'{"Stat":<10}'
    for m in models:
        header += f'  {m:>20}'
    print(header)
    print('─' * len(header))

    for stat in STAT_KEYS + ['_avg']:
        label = stat if stat != '_avg' else 'AVERAGE'
        line = f'{label:<10}'
        best_pct = min(all_results[m][stat]['pctErr'] for m in models)
        for m in models:
            r = all_results[m][stat]
            marker = ' ✓' if r['pctErr'] == best_pct and stat != '_avg' else ''
            if stat == '_avg':
                line += f'  {"%.2f%%" % r["pctErr"]:>12} R²={r["r2"]:.3f}'
            else:
                line += f'  {"%.1f%%" % r["pctErr"]:>8} (MAE={r["mae"]:>5}){marker}'
        print(line)

    # Print winner
    print()
    avg_errors = {m: all_results[m]['_avg']['pctErr'] for m in models}
    winner = min(avg_errors, key=avg_errors.get)
    print(f'Winner: {winner} ({avg_errors[winner]:.2f}% avg error)')
    for m in models:
        if m != winner:
            diff = avg_errors[m] - avg_errors[winner]
            print(f'  vs {m}: {diff:+.2f} pp')


def print_per_season_results(df: pd.DataFrame, all_preds: dict[str, dict]):
    """Print per-season breakdown."""
    print('\n\nPer-Season Breakdown (avg % error across stats):')
    print('─' * 80)
    models = list(all_preds.keys())
    header = f'{"Season":<10}'
    for m in models:
        header += f'  {m:>15}'
    print(header)
    print('─' * 80)

    for season in sorted(df['season'].unique()):
        mask = df['season'] == season
        sub_df = df[mask]
        line = f'{season:<10}'
        season_errs = {}
        for m in models:
            errs = []
            for stat in STAT_KEYS:
                pred = all_preds[m][stat][mask]
                actual = sub_df[f'actual_{stat}'].values
                valid = ~np.isnan(pred)
                if valid.sum() == 0:
                    continue
                mae = mean_absolute_error(actual[valid], pred[valid])
                mean_a = np.mean(actual[valid])
                if mean_a > 0:
                    errs.append(mae / mean_a * 100)
            avg_err = np.mean(errs) if errs else 0
            season_errs[m] = avg_err
        best = min(season_errs.values())
        for m in models:
            marker = ' ✓' if season_errs[m] == best else ''
            line += f'  {season_errs[m]:>12.1f}%{marker}'
        print(line)


def print_feature_importance(df: pd.DataFrame):
    """Train full GBM on all data and print feature importance."""
    print('\n\nGBM Feature Importance (gain, top 15):')
    print('─' * 50)

    X = df[GBM_FEATURES].fillna(0).values
    # Average importance across all target stats
    importance = np.zeros(len(GBM_FEATURES))
    for stat in STAT_KEYS:
        y = df[f'actual_{stat}'].values
        ds = lgb.Dataset(X, label=y, feature_name=GBM_FEATURES, free_raw_data=False)
        model = lgb.train(LGB_PARAMS, ds, num_boost_round=N_ROUNDS)
        imp = model.feature_importance(importance_type='gain')
        if imp.sum() > 0:
            importance += imp / imp.sum()

    importance /= len(STAT_KEYS)
    ranked = sorted(zip(GBM_FEATURES, importance), key=lambda x: -x[1])
    for i, (feat, imp) in enumerate(ranked[:15]):
        bar = '█' * int(imp * 100)
        print(f'  {i+1:>2}. {feat:<28} {imp:.3f}  {bar}')


# ═══════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════

def main():
    print('Team Volume Projection Backtest')
    print('=' * 60)
    print(f'Test seasons: {TEST_SEASONS}')
    print()

    # 1. Load player stats CSVs for actual team totals
    print('Loading player stats CSVs...')
    all_seasons_needed = set()
    for s in TEST_SEASONS:
        all_seasons_needed.add(s)
        all_seasons_needed.add(s - 1)
        all_seasons_needed.add(s - 2)  # for trends

    season_totals: dict[int, dict[str, dict]] = {}
    for season in sorted(all_seasons_needed):
        df_stats = load_player_stats_csv(season)
        if df_stats.empty:
            print(f'  {season}: no data')
            continue
        totals = aggregate_team_totals(df_stats)
        season_totals[season] = totals
        print(f'  {season}: {len(totals)} teams')

    # 2. Load feature store
    print('\nLoading feature store...')
    shards = load_feature_store()
    n_coaching = len(shards.get('coaching', {}))
    n_teams_tf = len(shards.get('teamFeatures', {}).get('perSeason', {}).get('2025', {}))
    print(f'  coaching.json: {n_coaching} entries')
    print(f'  team-features-backfill.json: {n_teams_tf} teams (2025)')

    # 3. Build actual and prior totals for test seasons
    actual_totals = {s: season_totals[s] for s in TEST_SEASONS if s in season_totals}
    prior_totals = {}
    for s in sorted(all_seasons_needed):
        if s in season_totals:
            # prior_totals[s+1] means "prior for predicting season s+1"
            prior_totals[s + 1] = season_totals[s]

    # 4. Build feature matrix
    print('\nBuilding feature matrix...')
    df = build_team_feature_rows(shards, actual_totals, prior_totals)
    print(f'  {len(df)} team-season rows')
    print(f'  Seasons: {sorted(df["season"].unique())}')
    print(f'  Teams per season: {df.groupby("season").size().to_dict()}')

    # Check feature coverage
    feature_coverage = {}
    for feat in GBM_FEATURES:
        if feat in df.columns:
            nonzero = (df[feat].fillna(0) != 0).sum()
            feature_coverage[feat] = nonzero
    low_coverage = {k: v for k, v in feature_coverage.items() if v < len(df) * 0.3}
    if low_coverage:
        print(f'\n  Low-coverage features (<30% non-zero):')
        for feat, n in sorted(low_coverage.items(), key=lambda x: x[1]):
            print(f'    {feat}: {n}/{len(df)} ({n/len(df)*100:.0f}%)')

    # 5. Run models
    print('\n' + '=' * 60)
    print('Running LOSO cross-validation...')
    print('=' * 60)

    print('\n  1/4 Simple blend (40/60)...')
    blend_preds = predict_blend(df)

    print('  2/4 Delta Ridge...')
    delta_preds = predict_delta_loso(df)

    print('  3/4 LightGBM...')
    gbm_preds = predict_gbm_loso(df)

    print('  4/4 Ensemble (40% Ridge + 60% GBM)...')
    ensemble_preds = predict_ensemble_loso(df)

    # 6. Evaluate
    print('\n' + '=' * 60)
    print('RESULTS')
    print('=' * 60 + '\n')

    all_results = {
        'Blend(40/60)': evaluate(df, blend_preds, 'Blend'),
        'DeltaRidge': evaluate(df, delta_preds, 'Delta'),
        'LightGBM': evaluate(df, gbm_preds, 'GBM'),
        'Ensemble': evaluate(df, ensemble_preds, 'Ensemble'),
    }
    print_results(all_results)
    print_per_season_results(df, {
        'Blend(40/60)': blend_preds,
        'DeltaRidge': delta_preds,
        'LightGBM': gbm_preds,
        'Ensemble': ensemble_preds,
    })
    print_feature_importance(df)

    # 7. Output JSON summary
    output = {
        'testSeasons': TEST_SEASONS,
        'nRows': len(df),
        'models': {},
    }
    for model_name, results in all_results.items():
        output['models'][model_name] = {
            'avgPctError': results['_avg']['pctErr'],
            'avgR2': results['_avg']['r2'],
            'perStat': {stat: results[stat] for stat in STAT_KEYS},
        }
    winner_name = min(output['models'], key=lambda m: output['models'][m]['avgPctError'])
    output['winner'] = winner_name
    output['winnerAvgPctError'] = output['models'][winner_name]['avgPctError']

    out_path = DATA_DIR / 'team-projection-backtest.json'
    with open(out_path, 'w') as f:
        json.dump(output, f, indent=2)
    print(f'\n\nWrote results to {out_path}')


if __name__ == '__main__':
    main()
