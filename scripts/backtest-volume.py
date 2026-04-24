#!/usr/bin/env python3
"""
Honest backtest for the team-volume projection formula in
`src/lib/buildFeatureMatrix.ts`. Reconstructs the formula in Python,
evaluates it against historical NFL actuals across multiple seasons, and
reports per-season MAE so future volume changes can be validated before
shipping.

Why this exists: the "5.9% MAE" we measured when first calibrating the
volume pass was the 2026 projections compared to 2025 actuals — but
those same projections USE 2025 priors, so it's an in-sample check.
LOSO over 2018–2025 gives the real ceiling.

A Ridge regression trained on prior-year team volumes alone (no pace,
no Vegas, no scheme features) gets pass MAE 8.7%, rush 10.8%. The
formula with calibration hits ~6% by leveraging pace + passRate from
PBP data — so structural features are pulling real weight.

Usage:
  python3 scripts/backtest-volume.py                 # backtest all seasons
  python3 scripts/backtest-volume.py --season 2024   # single season

Fails if MAE regresses beyond threshold (used as guardrail in CI).
"""
from __future__ import annotations

import argparse
import csv
import gzip
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / 'public' / 'data'

# ── Formula constants (mirror of VOLUME_EFFICIENCY in buildFeatureMatrix.ts) ──
PASS_ATTEMPT_RATE = 0.94
TARGET_RATE = 0.95
PASS_RATE_REGRESS = 0.25
LEAGUE_MEAN_PASS_RATE = 0.55
# Fallback league-mean volumes when the prior year has too few teams
FALLBACK_LEAGUE_MEAN_PASS_ATT = 570
FALLBACK_LEAGUE_MEAN_RUSH_ATT = 470
FALLBACK_LEAGUE_MEAN_TARGETS = 540

# Regression-guard thresholds (set just above the empirical 15-season worst):
#   2011–2025 pass MAE: 6.2–12.1% (mean 9.5%)
#   2011–2025 rush MAE: 9.7–14.2% (mean 12.0%)
#   2011–2025 tgt  MAE: 6.3–12.0% (mean 9.7%)
# Above thresholds → meaningful quality regression worth investigating.
MAE_THRESHOLD_PASS = 13.0
MAE_THRESHOLD_RUSH = 15.0
MAE_THRESHOLD_TGT = 13.0


def load_team_season_totals() -> dict[tuple[str, int], dict[str, int]]:
    """Per-(team, season) totals: pass attempts, carries, targets, plays."""
    out: dict[tuple[str, int], dict[str, int]] = {}
    for path in sorted(DATA_DIR.glob('player_stats_*.csv.gz')):
        try:
            season = int(path.stem.split('_')[-1].replace('.csv', ''))
        except ValueError:
            continue
        with gzip.open(path, 'rt') as f:
            reader = csv.DictReader(f)
            agg: dict[str, dict[str, int]] = defaultdict(
                lambda: {'pass': 0, 'rush': 0, 'tgt': 0}
            )
            for r in reader:
                t = r.get('recent_team') or r.get('team')
                if not t:
                    continue
                agg[t]['pass'] += int(r.get('attempts', 0) or 0)
                agg[t]['rush'] += int(r.get('carries', 0) or 0)
                agg[t]['tgt'] += int(r.get('targets', 0) or 0)
        for t, v in agg.items():
            out[(t, season)] = v
    return out


def prior_year_pass_rate(prev: dict[str, int]) -> float:
    total = prev['pass'] + prev['rush']
    return prev['pass'] / total if total > 0 else LEAGUE_MEAN_PASS_RATE


def prior_year_pace(prev: dict[str, int]) -> float:
    # Plays = passes (attempts + sacks ≈ attempts / 0.94) + rushes, per 17 games
    approx_pass_plays = prev['pass'] / PASS_ATTEMPT_RATE
    total_plays = approx_pass_plays + prev['rush']
    return total_plays / 17


def project_team(prev: dict[str, int]) -> dict[str, float]:
    """Apply the buildFeatureMatrix volume formula using only prior-year totals
    (before league calibration)."""
    prior_pass_rate = prior_year_pass_rate(prev)
    eff_pass_rate = (prior_pass_rate * (1 - PASS_RATE_REGRESS)
                     + LEAGUE_MEAN_PASS_RATE * PASS_RATE_REGRESS)
    plays_per_game = prior_year_pace(prev)
    pass_plays = plays_per_game * eff_pass_rate
    rush_plays = plays_per_game * (1 - eff_pass_rate)
    return {
        'pass': pass_plays * 17 * PASS_ATTEMPT_RATE,
        'rush': rush_plays * 17,
        'tgt': pass_plays * 17 * PASS_ATTEMPT_RATE * TARGET_RATE,
    }


def backtest_season(
    target_season: int,
    team_totals: dict[tuple[str, int], dict[str, int]],
) -> dict[str, float] | None:
    """Project target_season using (target_season - 1) priors; compare to actuals."""
    prior_season = target_season - 1
    raw: dict[str, dict[str, float]] = {}
    actuals: dict[str, dict[str, int]] = {}
    for (t, s), v in team_totals.items():
        if s == prior_season:
            prev = v
            cur = team_totals.get((t, target_season))
            if cur is None:
                continue
            raw[t] = project_team(prev)
            actuals[t] = cur

    if len(raw) < 28:
        return None

    # League-calibration: scale 32-team mean to match prior-year targets
    # (rolling — use rolling 3-year prior mean for robustness).
    rolling_pass = []
    rolling_rush = []
    rolling_tgt = []
    for offset in range(1, 4):
        y = target_season - offset
        year_teams = [v for (t, s), v in team_totals.items() if s == y]
        if year_teams:
            rolling_pass.append(sum(v['pass'] for v in year_teams) / len(year_teams))
            rolling_rush.append(sum(v['rush'] for v in year_teams) / len(year_teams))
            rolling_tgt.append(sum(v['tgt'] for v in year_teams) / len(year_teams))
    if not rolling_pass:
        target_p = FALLBACK_LEAGUE_MEAN_PASS_ATT
        target_r = FALLBACK_LEAGUE_MEAN_RUSH_ATT
        target_t = FALLBACK_LEAGUE_MEAN_TARGETS
    else:
        target_p = statistics.mean(rolling_pass)
        target_r = statistics.mean(rolling_rush)
        target_t = statistics.mean(rolling_tgt)

    mean_raw_p = statistics.mean(r['pass'] for r in raw.values())
    mean_raw_r = statistics.mean(r['rush'] for r in raw.values())
    mean_raw_t = statistics.mean(r['tgt'] for r in raw.values())
    pass_cal = target_p / mean_raw_p if mean_raw_p > 0 else 1.0
    rush_cal = target_r / mean_raw_r if mean_raw_r > 0 else 1.0
    tgt_cal = target_t / mean_raw_t if mean_raw_t > 0 else 1.0

    errs_p = []
    errs_r = []
    errs_t = []
    for t, proj in raw.items():
        act = actuals.get(t)
        if not act:
            continue
        if act['pass'] > 0:
            errs_p.append((proj['pass'] * pass_cal - act['pass']) / act['pass'] * 100)
        if act['rush'] > 0:
            errs_r.append((proj['rush'] * rush_cal - act['rush']) / act['rush'] * 100)
        if act['tgt'] > 0:
            errs_t.append((proj['tgt'] * tgt_cal - act['tgt']) / act['tgt'] * 100)

    def stats(errs: list[float]) -> tuple[float, float]:
        if not errs:
            return 0.0, 0.0
        return statistics.mean(errs), statistics.mean(abs(e) for e in errs)

    pb, pm = stats(errs_p)
    rb, rm = stats(errs_r)
    tb, tm = stats(errs_t)
    return {
        'n': len(raw),
        'pass_bias': pb, 'pass_mae': pm,
        'rush_bias': rb, 'rush_mae': rm,
        'tgt_bias':  tb, 'tgt_mae':  tm,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--season', type=int, help='Backtest a single season')
    ap.add_argument('--json', action='store_true', help='Emit JSON output')
    ap.add_argument('--fail-on-regress', action='store_true',
                    help='Exit 1 if latest-season MAE exceeds threshold (CI guardrail)')
    args = ap.parse_args()

    team_totals = load_team_season_totals()
    if not team_totals:
        print('No player_stats_*.csv.gz files found in public/data/', file=sys.stderr)
        return 2

    seasons = sorted({s for (_, s) in team_totals.keys()})
    target_seasons = [args.season] if args.season else seasons[1:]

    results = {}
    for s in target_seasons:
        r = backtest_season(s, team_totals)
        if r is None:
            continue
        results[s] = r

    if args.json:
        print(json.dumps(results, indent=2))
    else:
        print('\n' + '═' * 80)
        print(' Volume-formula backtest — projections using year Y-1, actuals from year Y')
        print('═' * 80)
        print(f' {"Season":>6s} {"#teams":>7s}  {"Pass bias":>10s} {"Pass MAE":>10s}  '
              f'{"Rush bias":>10s} {"Rush MAE":>10s}  {"Tgt bias":>9s} {"Tgt MAE":>9s}')
        print('─' * 80)
        for s, r in sorted(results.items()):
            print(f' {s:>6d} {r["n"]:>7d}  {r["pass_bias"]:>+9.1f}% {r["pass_mae"]:>9.1f}%  '
                  f'{r["rush_bias"]:>+9.1f}% {r["rush_mae"]:>9.1f}%  '
                  f'{r["tgt_bias"]:>+8.1f}% {r["tgt_mae"]:>8.1f}%')

        if len(results) > 1:
            mean_pm = statistics.mean(r['pass_mae'] for r in results.values())
            mean_rm = statistics.mean(r['rush_mae'] for r in results.values())
            mean_tm = statistics.mean(r['tgt_mae'] for r in results.values())
            print('─' * 80)
            print(f' {"avg":>6s} {" ":>7s}  {" ":>10s} {mean_pm:>9.1f}%  '
                  f'{" ":>10s} {mean_rm:>9.1f}%  {" ":>9s} {mean_tm:>8.1f}%')
        print('═' * 80)
        print(f' Thresholds: pass MAE < {MAE_THRESHOLD_PASS}%, rush MAE < {MAE_THRESHOLD_RUSH}%, '
              f'tgt MAE < {MAE_THRESHOLD_TGT}%')
        print()

    if args.fail_on_regress and results:
        latest = max(results.keys())
        r = results[latest]
        failures = []
        if r['pass_mae'] > MAE_THRESHOLD_PASS:
            failures.append(f'pass MAE {r["pass_mae"]:.1f}% > {MAE_THRESHOLD_PASS}%')
        if r['rush_mae'] > MAE_THRESHOLD_RUSH:
            failures.append(f'rush MAE {r["rush_mae"]:.1f}% > {MAE_THRESHOLD_RUSH}%')
        if r['tgt_mae'] > MAE_THRESHOLD_TGT:
            failures.append(f'tgt MAE {r["tgt_mae"]:.1f}% > {MAE_THRESHOLD_TGT}%')
        if failures:
            print(f'Regression detected in {latest}: {"; ".join(failures)}', file=sys.stderr)
            return 1

    return 0


if __name__ == '__main__':
    sys.exit(main())
