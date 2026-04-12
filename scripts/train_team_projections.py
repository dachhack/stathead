#!/usr/bin/env python3
"""
Train team volume projection ensemble and generate 2026 team projections.

Trains a Ridge delta model + LightGBM ensemble using feature store data,
then predicts 2026 team volumes. Outputs:
  - src/generated/team-projections.json  (2026 predictions + model metadata)

Usage:
    python3 scripts/train_team_projections.py
"""

import json
import os
import subprocess
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
OUTPUT_PATH = ROOT / 'src' / 'generated' / 'team-projections.json'
NFLVERSE = 'https://github.com/nflverse/nflverse-data/releases/download'

# Train on these seasons, predict 2026
TRAIN_SEASONS = [2020, 2021, 2022, 2023, 2024, 2025]
PREDICT_SEASON = 2026

STAT_KEYS = ['passAtt', 'rushAtt', 'targets', 'passTD', 'rushTD',
             'passYds', 'rushYds', 'recYds', 'receptions']

# ── Model features ──

DELTA_FEATURES = [
    'priorPassAtt', 'priorRushAtt', 'priorTargets',
    'passAttTrend', 'rushAttTrend', 'targetsTrend',
    'newHeadCoach', 'coachPriorTeamPPR',
    'vegasImpliedTotal', 'vegasWinPct', 'vegasSeasonWinTotal',
    'teamPassRate', 'teamNeutralPassRate', 'teamPace',
    'teamRushYPC', 'teamSackRate',
]

GBM_FEATURES = [
    'priorPassAtt', 'priorRushAtt', 'priorTargets',
    'priorPassTD', 'priorRushTD', 'priorPassYds', 'priorRushYds', 'priorRecYds',
    'passAttTrend', 'rushAttTrend', 'targetsTrend',
    'newHeadCoach', 'coachPriorTeamPPR',
    'teamPassRate', 'teamNeutralPassRate', 'teamPace',
    'teamFirstDownRunRate', 'teamShotgunRate', 'teamNoHuddleRate',
    'teamSackRate', 'teamRushYPC', 'teamDomeGames',
    'vegasImpliedTotal', 'vegasWinPct', 'vegasImpliedSpread',
    'vegasSeasonWinTotal', 'vegasGameTotal',
    'teamRosterTurnover',
    'team11Rate', 'team12Rate',
    'teamRBTargetRate', 'teamTETargetRate', 'teamWRTargetRate',
]

LGB_PARAMS = {
    'objective': 'regression', 'metric': 'mae',
    'learning_rate': 0.05, 'max_depth': 3,
    'min_child_samples': 8, 'subsample': 0.8,
    'colsample_bytree': 0.85, 'seed': 42,
    'n_jobs': 1, 'verbosity': -1,
}
N_ROUNDS = 80
RIDGE_WEIGHT = 0.4  # 40% Ridge + 60% GBM


# ═══════════════════════════════════════════════════════════════════
# Data loading (same as backtest script)
# ═══════════════════════════════════════════════════════════════════

def download_if_missing(filename, url):
    path = DATA_DIR / filename
    if path.exists():
        return
    print(f'  Downloading {filename}...')
    try:
        subprocess.run(['curl', '-sfL', url, '-o', str(path)],
                       capture_output=True, check=True)
    except Exception:
        print(f'  Warning: could not download {filename}')


def load_player_stats_csv(season):
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


def aggregate_team_totals(df):
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
        t['receptions'] += int(row.get('receptions', 0) or 0)
    return teams


def load_feature_store():
    shards = {}
    for name in ['coaching', 'environment', 'competition', 'vegas']:
        path = FS_DIR / f'{name}.json'
        if path.exists():
            with open(path) as f:
                shards[name] = json.load(f)
        else:
            shards[name] = {}
    tf_path = DATA_DIR / 'team-features-backfill.json'
    if tf_path.exists():
        with open(tf_path) as f:
            shards['teamFeatures'] = json.load(f)
    else:
        shards['teamFeatures'] = {}
    return shards


def get_team_features_from_fs(shards, team, season):
    """Extract team-level features from the feature store for a given team + season."""
    tf = shards['teamFeatures']
    name_to_team = tf.get('nameToTeam', {})
    coaching = shards['coaching']
    environment = shards['environment']
    competition = shards['competition']
    vegas_fs = shards.get('vegas', {})

    # Find a representative player for this team-season
    mapping = name_to_team.get(str(season), {})
    player_keys = [f'{name}::{season}' for name, t in mapping.items() if t == team]

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

    # Personnel from team-features-backfill (prior season)
    per_season = tf.get('perSeason', {})
    tf_prior = per_season.get(str(season - 1), {}).get(team, {})

    return {
        'newHeadCoach': fs_features.get('newHeadCoach', 0),
        'teamPassRate': fs_features.get('teamPassRate', 0),
        'teamNeutralPassRate': fs_features.get('teamNeutralPassRate', 0),
        'teamPace': fs_features.get('teamPace', 0),
        'teamFirstDownRunRate': fs_features.get('teamFirstDownRunRate', 0),
        'teamShotgunRate': fs_features.get('teamShotgunRate', 0),
        'teamNoHuddleRate': fs_features.get('teamNoHuddleRate', 0),
        'coachPriorTeamPPR': fs_features.get('coachPriorTeamPPR', 0),
        'teamSackRate': fs_features.get('teamSackRate', 0),
        'teamRushYPC': fs_features.get('teamRushYPC', 0),
        'teamDomeGames': fs_features.get('teamDomeGames', 0),
        'vegasImpliedTotal': fs_features.get('vegasImpliedTotal', 0),
        'vegasWinPct': fs_features.get('vegasWinPct', 0),
        'vegasImpliedSpread': fs_features.get('vegasImpliedSpread', 0),
        'vegasSeasonWinTotal': fs_features.get('vegasSeasonWinTotal', 0),
        'vegasGameTotal': fs_features.get('vegasGameTotal', 0),
        'teamRosterTurnover': fs_features.get('teamRosterTurnover', 0),
        'team11Rate': tf_prior.get('team11Rate', 0),
        'team12Rate': tf_prior.get('team12Rate', 0),
        'teamRBTargetRate': tf_prior.get('teamRBTargetRate', 0),
        'teamTETargetRate': tf_prior.get('teamTETargetRate', 0),
        'teamWRTargetRate': tf_prior.get('teamWRTargetRate', 0),
    }


def build_rows(shards, season_totals, seasons_with_actuals):
    """Build training rows: one per (team, season) with features + actual targets."""
    rows = []
    for season in seasons_with_actuals:
        actuals = season_totals.get(season)
        priors = season_totals.get(season - 1)
        prior2s = season_totals.get(season - 2)
        if not actuals or not priors:
            continue

        # League averages
        league_avg = {k: 0.0 for k in STAT_KEYS}
        n = len(priors)
        for t_stats in priors.values():
            for k in STAT_KEYS:
                league_avg[k] += t_stats.get(k, 0)
        if n > 0:
            for k in STAT_KEYS:
                league_avg[k] /= n

        for team, actual in actuals.items():
            prior = priors.get(team)
            if not prior:
                continue
            prior2 = (prior2s or {}).get(team, {})
            fs = get_team_features_from_fs(shards, team, season)

            row = {
                'team': team, 'season': season,
                'priorPassAtt': prior.get('passAtt', 0),
                'priorRushAtt': prior.get('rushAtt', 0),
                'priorTargets': prior.get('targets', 0),
                'priorPassTD': prior.get('passTD', 0),
                'priorRushTD': prior.get('rushTD', 0),
                'priorPassYds': prior.get('passYds', 0),
                'priorRushYds': prior.get('rushYds', 0),
                'priorRecYds': prior.get('recYds', 0),
                'priorReceptions': prior.get('receptions', 0),
                'passAttTrend': prior.get('passAtt', 0) - prior2.get('passAtt', 0) if prior2 else 0,
                'rushAttTrend': prior.get('rushAtt', 0) - prior2.get('rushAtt', 0) if prior2 else 0,
                'targetsTrend': prior.get('targets', 0) - prior2.get('targets', 0) if prior2 else 0,
                **fs,
                **{f'leagueAvg_{k}': league_avg[k] for k in STAT_KEYS},
                **{f'actual_{k}': actual.get(k, 0) for k in STAT_KEYS},
            }
            rows.append(row)

    return pd.DataFrame(rows)


def build_prediction_rows(shards, season_totals, predict_season):
    """Build prediction rows for a future season (no actuals needed)."""
    priors = season_totals.get(predict_season - 1)
    prior2s = season_totals.get(predict_season - 2)
    if not priors:
        return pd.DataFrame()

    league_avg = {k: 0.0 for k in STAT_KEYS}
    n = len(priors)
    for t_stats in priors.values():
        for k in STAT_KEYS:
            league_avg[k] += t_stats.get(k, 0)
    if n > 0:
        for k in STAT_KEYS:
            league_avg[k] /= n

    rows = []
    for team, prior in priors.items():
        prior2 = (prior2s or {}).get(team, {})
        fs = get_team_features_from_fs(shards, team, predict_season)

        row = {
            'team': team, 'season': predict_season,
            'priorPassAtt': prior.get('passAtt', 0),
            'priorRushAtt': prior.get('rushAtt', 0),
            'priorTargets': prior.get('targets', 0),
            'priorPassTD': prior.get('passTD', 0),
            'priorRushTD': prior.get('rushTD', 0),
            'priorPassYds': prior.get('passYds', 0),
            'priorRushYds': prior.get('rushYds', 0),
            'priorRecYds': prior.get('recYds', 0),
            'priorReceptions': prior.get('receptions', 0),
            'passAttTrend': prior.get('passAtt', 0) - prior2.get('passAtt', 0) if prior2 else 0,
            'rushAttTrend': prior.get('rushAtt', 0) - prior2.get('rushAtt', 0) if prior2 else 0,
            'targetsTrend': prior.get('targets', 0) - prior2.get('targets', 0) if prior2 else 0,
            **fs,
            **{f'leagueAvg_{k}': league_avg[k] for k in STAT_KEYS},
        }
        rows.append(row)

    return pd.DataFrame(rows)


# ═══════════════════════════════════════════════════════════════════
# Training + prediction
# ═══════════════════════════════════════════════════════════════════

def train_and_predict(train_df, pred_df):
    """Train ensemble and predict. Returns dict of team → projected stats."""
    X_delta_train = train_df[DELTA_FEATURES].fillna(0).values
    X_gbm_train = train_df[GBM_FEATURES].fillna(0).values
    X_delta_pred = pred_df[DELTA_FEATURES].fillna(0).values
    X_gbm_pred = pred_df[GBM_FEATURES].fillna(0).values

    predictions = {team: {} for team in pred_df['team'].values}
    model_info = {}

    for stat in STAT_KEYS:
        prior_col = f'prior{stat[0].upper()}{stat[1:]}'
        actual_col = f'actual_{stat}'

        # Ridge delta model
        y_delta = (train_df[actual_col] - train_df[prior_col]).values
        ridge = Ridge(alpha=8.0)
        ridge.fit(X_delta_train, y_delta)
        ridge_pred = pred_df[prior_col].values + ridge.predict(X_delta_pred)

        # GBM absolute model
        y_abs = train_df[actual_col].values
        ds = lgb.Dataset(X_gbm_train, label=y_abs,
                         feature_name=GBM_FEATURES, free_raw_data=False)
        gbm = lgb.train(LGB_PARAMS, ds, num_boost_round=N_ROUNDS)
        gbm_pred = gbm.predict(X_gbm_pred)

        # Ensemble
        ensemble = ridge_pred * RIDGE_WEIGHT + gbm_pred * (1 - RIDGE_WEIGHT)

        # Feature importance
        imp = gbm.feature_importance(importance_type='gain')
        top_feats = sorted(zip(GBM_FEATURES, imp.tolist()), key=lambda x: -x[1])[:5]

        model_info[stat] = {
            'ridgeCoefs': {DELTA_FEATURES[i]: round(float(ridge.coef_[i]), 4)
                           for i in range(len(DELTA_FEATURES))},
            'topGBMFeatures': [{'name': f, 'importance': round(v, 1)} for f, v in top_feats],
        }

        for i, team in enumerate(pred_df['team'].values):
            predictions[team][stat] = int(round(ensemble[i]))

    return predictions, model_info


def loso_cv(train_df):
    """Run LOSO CV and return per-stat metrics."""
    seasons = sorted(train_df['season'].unique())
    preds = {stat: np.full(len(train_df), np.nan) for stat in STAT_KEYS}

    for held in seasons:
        tr = train_df[train_df['season'] != held]
        te = train_df[train_df['season'] == held]
        if len(tr) < 30 or len(te) == 0:
            continue

        X_d_tr = tr[DELTA_FEATURES].fillna(0).values
        X_d_te = te[DELTA_FEATURES].fillna(0).values
        X_g_tr = tr[GBM_FEATURES].fillna(0).values
        X_g_te = te[GBM_FEATURES].fillna(0).values

        for stat in STAT_KEYS:
            prior_col = f'prior{stat[0].upper()}{stat[1:]}'
            actual_col = f'actual_{stat}'

            y_delta = (tr[actual_col] - tr[prior_col]).values
            ridge = Ridge(alpha=8.0)
            ridge.fit(X_d_tr, y_delta)
            r_pred = te[prior_col].values + ridge.predict(X_d_te)

            y_abs = tr[actual_col].values
            ds = lgb.Dataset(X_g_tr, label=y_abs, feature_name=GBM_FEATURES, free_raw_data=False)
            gbm = lgb.train(LGB_PARAMS, ds, num_boost_round=N_ROUNDS)
            g_pred = gbm.predict(X_g_te)

            mask = train_df['season'] == held
            preds[stat][mask.values] = r_pred * RIDGE_WEIGHT + g_pred * (1 - RIDGE_WEIGHT)

    metrics = {}
    for stat in STAT_KEYS:
        actual = train_df[f'actual_{stat}'].values
        pred = preds[stat]
        valid = ~np.isnan(pred)
        a, p = actual[valid], pred[valid]
        mae = float(mean_absolute_error(a, p))
        mean_a = float(np.mean(a))
        metrics[stat] = {
            'mae': round(mae, 1),
            'pctError': round(mae / mean_a * 100, 1) if mean_a > 0 else 0,
            'r2': round(float(r2_score(a, p)), 3),
            'meanActual': round(mean_a),
        }
    return metrics


# ═══════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════

def main():
    print('Train Team Volume Projection Ensemble')
    print('=' * 60)

    # Load data
    print('\nLoading player stats CSVs...')
    all_needed = set()
    for s in TRAIN_SEASONS:
        all_needed.update([s, s - 1, s - 2])
    all_needed.add(PREDICT_SEASON - 1)
    all_needed.add(PREDICT_SEASON - 2)

    season_totals = {}
    for season in sorted(all_needed):
        df = load_player_stats_csv(season)
        if df.empty:
            print(f'  {season}: no data')
            continue
        totals = aggregate_team_totals(df)
        season_totals[season] = totals
        print(f'  {season}: {len(totals)} teams')

    print('\nLoading feature store...')
    shards = load_feature_store()

    # Build training data
    print('\nBuilding training data...')
    train_df = build_rows(shards, season_totals, TRAIN_SEASONS)
    print(f'  {len(train_df)} training rows across {sorted(train_df["season"].unique())}')

    # LOSO CV
    print('\nRunning LOSO cross-validation...')
    cv_metrics = loso_cv(train_df)
    avg_pct = np.mean([v['pctError'] for v in cv_metrics.values()])
    print(f'\n  {"Stat":<12} {"MAE":>6} {"% Err":>7} {"R²":>7}')
    print(f'  {"─"*34}')
    for stat in STAT_KEYS:
        m = cv_metrics[stat]
        print(f'  {stat:<12} {m["mae"]:>6.1f} {m["pctError"]:>6.1f}% {m["r2"]:>6.3f}')
    print(f'  {"─"*34}')
    print(f'  {"AVERAGE":<12} {"":>6} {avg_pct:>6.2f}%')

    # Build prediction rows for 2026
    print(f'\nBuilding {PREDICT_SEASON} prediction features...')
    pred_df = build_prediction_rows(shards, season_totals, PREDICT_SEASON)
    if pred_df.empty:
        print(f'  ERROR: No prior data available for {PREDICT_SEASON}')
        return
    print(f'  {len(pred_df)} teams')

    # Train on ALL data and predict 2026
    print(f'\nTraining ensemble on all data and predicting {PREDICT_SEASON}...')
    predictions, model_info = train_and_predict(train_df, pred_df)

    # Print predictions
    print(f'\n{PREDICT_SEASON} Team Projections:')
    print(f'  {"Team":<5} {"PassAtt":>8} {"RushAtt":>8} {"Targets":>8} {"PassTD":>7} {"RushTD":>7} {"PassYds":>8} {"RushYds":>8}')
    print(f'  {"─"*63}')
    for team in sorted(predictions.keys()):
        p = predictions[team]
        print(f'  {team:<5} {p["passAtt"]:>8} {p["rushAtt"]:>8} {p["targets"]:>8} {p["passTD"]:>7} {p["rushTD"]:>7} {p["passYds"]:>8} {p["rushYds"]:>8}')

    # Write output
    output = {
        'generatedAt': pd.Timestamp.now().isoformat(),
        'season': PREDICT_SEASON,
        'model': 'ensemble',
        'description': f'Ridge delta ({int(RIDGE_WEIGHT*100)}%) + LightGBM ({int((1-RIDGE_WEIGHT)*100)}%) ensemble',
        'ridgeWeight': RIDGE_WEIGHT,
        'gbmWeight': 1 - RIDGE_WEIGHT,
        'ridgeFeatures': DELTA_FEATURES,
        'gbmFeatures': GBM_FEATURES,
        'lgbParams': {k: v for k, v in LGB_PARAMS.items() if k != 'verbosity'},
        'nRounds': N_ROUNDS,
        'trainingSeasons': sorted(train_df['season'].unique().tolist()),
        'nTrainingRows': len(train_df),
        'cvMetrics': cv_metrics,
        'avgPctError': round(avg_pct, 2),
        'modelInfo': model_info,
        'teams': predictions,
    }

    os.makedirs(OUTPUT_PATH.parent, exist_ok=True)
    with open(OUTPUT_PATH, 'w') as f:
        json.dump(output, f, indent=2)
    print(f'\nWrote {OUTPUT_PATH}')


if __name__ == '__main__':
    main()
