#!/usr/bin/env python3
"""
Backfill `newHeadCoach` and `teamRosterTurnover` features into the
training-rows cache for seasons 2010–2024.

Why this exists: both features were added to buildFeatureMatrix.ts
later in the project's life, and the frozen training cache
(public/data/training-rows-cache-v49.json) wasn't rebuilt against the
new feature definitions. Result: 0 historical coverage, only 2025+ rows
have non-zero values. That blocks any regression-tuning that depends on
either feature being present in LOSO backtests.

This script:
  1. Loads `public/data/games.csv.gz` and builds (season, team) → coach
     using the latest non-empty coach name observed for that team in
     that season (handles mid-season coach firings — we want who
     finished the year, since training-row outcomes reflect that
     coach's offense).
  2. Loads `public/data/roster_{YYYY}.csv.gz` for each season and
     constructs (season, team, position) → set(player_name) following
     the same logic as buildFeatureMatrix.ts:1499–1532 (skill positions
     only, exclude Inactive status, normalize names).
  3. Computes per-(season, team):
       - newHeadCoach = 1 if coach[s] differs from coach[s-1]
       - teamRosterTurnover = max over positions of
             |new_players_at_pos| / |players_at_pos|
  4. Patches each training row in-place: looks up the row's team via
     the roster for its season, writes the two features.
  5. Writes the cache back atomically.

Idempotent — re-runs overwrite values cleanly. Reports per-season
coverage so regressions are obvious.

Usage:
    python3 scripts/backfill_coach_and_turnover.py
    python3 scripts/backfill_coach_and_turnover.py --dry-run
    python3 scripts/backfill_coach_and_turnover.py --seasons 2018,2019,2020
"""
from __future__ import annotations

import argparse
import csv
import gzip
import json
import sys
from collections import defaultdict
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / 'public' / 'data'
CACHE_PATH = DATA_DIR / 'training-rows-cache-v49.json'
GAMES_PATH = DATA_DIR / 'games.csv.gz'
SKILL_POSITIONS = {'QB', 'RB', 'WR', 'TE'}
DEFAULT_SEASONS = list(range(2010, 2026))


def normalize_name(s: str | None) -> str:
    """Match buildFeatureMatrix.ts normalizeName behavior for joining
    training-row names against roster full_name."""
    if not s:
        return ''
    s = s.lower().replace('.', '').replace("'", '').strip()
    for suffix in (' jr', ' sr', ' iii', ' iv', ' ii'):
        if s.endswith(suffix):
            s = s[: -len(suffix)].strip()
    return ' '.join(s.split())


def load_coach_by_season_team() -> dict[int, dict[str, str]]:
    """Returns {season: {team: coach_name}}.

    Uses the latest non-empty coach observed for each team in each
    season. This handles mid-season firings — we want the coach who
    closed out the year because the training-row outcomes (PPG, hit/bust
    flags) reflect that coach's offense.
    """
    out: dict[int, dict[str, str]] = defaultdict(dict)
    seen_week: dict[tuple[int, str], int] = {}
    with gzip.open(GAMES_PATH, 'rt') as f:
        reader = csv.DictReader(f)
        for r in reader:
            try:
                season = int(r['season'])
                week = int(r.get('week') or 0)
            except (KeyError, ValueError):
                continue
            for side in ('home', 'away'):
                team = r.get(f'{side}_team')
                coach = r.get(f'{side}_coach')
                if not team or not coach:
                    continue
                key = (season, team)
                if week >= seen_week.get(key, -1):
                    seen_week[key] = week
                    out[season][team] = coach
    return out


def load_player_team_map(season: int) -> dict[str, str]:
    """Returns {normalized_name: team} from the full roster (any status).

    Used to look up a training row's team — players on IR/CUT/etc. still
    had a team during the season and produced stats; the ACT-only filter
    used for turnover computation would miss them.
    """
    path = DATA_DIR / f'roster_{season}.csv.gz'
    if not path.exists():
        return {}
    out: dict[str, str] = {}
    with gzip.open(path, 'rt') as f:
        reader = csv.DictReader(f)
        for r in reader:
            if r.get('position') not in SKILL_POSITIONS:
                continue
            team = r.get('team') or ''
            name = normalize_name(r.get('full_name'))
            if name and team and name not in out:
                out[name] = team
    return out


def load_roster_by_team_pos(season: int) -> dict[str, dict[str, set[str]]]:
    """Returns {team: {position: set(normalized_name)}}.

    Filter: skill positions only, status = 'ACT'. ACT is the consistent
    code across 2010–2026 (2010-era files used 'ACT', so does 2026).
    The legacy `status === 'Inactive'` check in buildFeatureMatrix.ts
    matches nothing in the data (real codes are INA, RES, CUT, DEV, UFA,
    RFA, RET, …) so historical rosters end up "deep" (53-man + IR + PS)
    and produce per-position counts of 13–19 with high turnover, while
    2026 reads as the leaner ACT-only roster (6–9 per group). Filtering
    to ACT here gives a consistent denominator.
    """
    path = DATA_DIR / f'roster_{season}.csv.gz'
    if not path.exists():
        return {}
    out: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    with gzip.open(path, 'rt') as f:
        reader = csv.DictReader(f)
        for r in reader:
            pos = r.get('position') or ''
            if pos not in SKILL_POSITIONS:
                continue
            if (r.get('status') or '').strip() != 'ACT':
                continue
            team = r.get('team') or ''
            if not team:
                continue
            name = normalize_name(r.get('full_name'))
            if name:
                out[team][pos].add(name)
    return out


def compute_team_pos_turnover(
    current: dict[str, dict[str, set[str]]],
    prior: dict[str, dict[str, set[str]]],
) -> dict[tuple[str, str], float]:
    """Returns {(team, position): turnover}.

    Matches the PREDICTION-side formula at buildFeatureMatrix.ts:4515–4521 —
    per-(team, position) fraction of current names who weren't on prior-year
    roster at that position. This intentionally diverges from the original
    training-side formula at buildFeatureMatrix.ts:1791–1799, which took
    max-across-positions per team and produced a much higher (and
    inconsistent) signal. Aligning to the prediction-side formula means the
    model learns and predicts on the same scale.
    """
    out: dict[tuple[str, str], float] = {}
    for team, pos_map in current.items():
        for pos, names in pos_map.items():
            prior_names = prior.get(team, {}).get(pos, set())
            if not prior_names or not names:
                continue
            new_count = len(names - prior_names)
            out[(team, pos)] = round(new_count / len(names), 3)
    return out


def find_player_team(
    player_name: str,
    name_to_team: dict[str, str],
) -> str | None:
    """Find which team a player was on. Uses the all-status name→team map
    (load_player_team_map) so IR/CUT/practice-squad players still match —
    we only need their team-of-record, not whether they were ACT."""
    nn = normalize_name(player_name)
    if not nn:
        return None
    return name_to_team.get(nn)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true',
                    help='Compute + report coverage, do not write the cache')
    ap.add_argument('--seasons', type=str, default=None,
                    help='Comma-separated list of seasons (default: 2010-2025)')
    args = ap.parse_args()

    seasons = (
        [int(s) for s in args.seasons.split(',')]
        if args.seasons else DEFAULT_SEASONS
    )

    print(f'Loading {CACHE_PATH}…')
    cache = json.loads(CACHE_PATH.read_text())
    print(f'  {len(cache["rows"])} rows')

    print(f'Loading {GAMES_PATH} for coach data…')
    coach_by_st = load_coach_by_season_team()
    print(f'  {sum(len(v) for v in coach_by_st.values())} (season, team) coach entries '
          f'across {len(coach_by_st)} seasons')

    # Pre-load rosters for each season (and prior season for turnover)
    needed = set()
    for s in seasons:
        needed.add(s)
        needed.add(s - 1)
    rosters_by_season: dict[int, dict[str, dict[str, set[str]]]] = {}
    name_to_team_by_season: dict[int, dict[str, str]] = {}
    for s in sorted(needed):
        r = load_roster_by_team_pos(s)
        if r:
            rosters_by_season[s] = r
        nt = load_player_team_map(s)
        if nt:
            name_to_team_by_season[s] = nt
    print(f'  Loaded rosters for {len(rosters_by_season)} seasons: '
          f'{sorted(rosters_by_season.keys())}')

    # Compute per-(season, team) coach + per-(season, team, pos) turnover
    new_hc_by_st: dict[tuple[int, str], int] = {}
    turnover_by_stp: dict[tuple[int, str, str], float] = {}
    for s in seasons:
        coaches_now = coach_by_st.get(s, {})
        coaches_prev = coach_by_st.get(s - 1, {})
        for team, coach in coaches_now.items():
            prev = coaches_prev.get(team)
            new_hc_by_st[(s, team)] = 1 if (prev and prev != coach) else 0
        cur_roster = rosters_by_season.get(s, {})
        prev_roster = rosters_by_season.get(s - 1, {})
        if cur_roster and prev_roster:
            for (team, pos), t in compute_team_pos_turnover(cur_roster, prev_roster).items():
                turnover_by_stp[(s, team, pos)] = t

    # Sanity print: per-season HC change counts
    print('\nPer-season newHeadCoach + turnover coverage:')
    print(f'  {"Season":>6s} {"#teams w/coach":>16s} {"#new HC":>9s} {"#turn entries":>15s} {"med turn":>10s}')
    for s in seasons:
        n_coach = sum(1 for (ss, _) in new_hc_by_st if ss == s)
        n_new = sum(1 for (ss, _), v in new_hc_by_st.items() if ss == s and v == 1)
        n_turn = sum(1 for (ss, _, _) in turnover_by_stp if ss == s)
        turn_vals = sorted(v for (ss, _, _), v in turnover_by_stp.items() if ss == s)
        med = turn_vals[len(turn_vals) // 2] if turn_vals else 0
        print(f'  {s:>6d} {n_coach:>16d} {n_new:>9d} {n_turn:>15d} {med:>10.3f}')

    # Patch rows
    print('\nPatching training rows…')
    patched = 0
    no_team = 0
    no_coach = 0
    no_turn = 0
    by_season_patched: dict[int, int] = defaultdict(int)
    for row in cache['rows']:
        season = row.get('season')
        if season not in seasons:
            continue
        team = find_player_team(row.get('name', ''), name_to_team_by_season.get(season, {}))
        if not team:
            no_team += 1
            continue
        f = row.setdefault('features', {})
        new_hc = new_hc_by_st.get((season, team))
        # Per-player-position turnover (matches prediction-side formula)
        position = row.get('position', '')
        turn = turnover_by_stp.get((season, team, position))
        if new_hc is None:
            no_coach += 1
        else:
            f['newHeadCoach'] = int(new_hc)
        if turn is None:
            no_turn += 1
        else:
            f['teamRosterTurnover'] = float(turn)
        if new_hc is not None or turn is not None:
            patched += 1
            by_season_patched[season] += 1

    print(f'  Patched: {patched} rows')
    print(f'  No team match: {no_team} rows (likely retired or name mismatch)')
    print(f'  Coach unknown: {no_coach} rows')
    print(f'  Turnover unknown: {no_turn} rows')
    print('\n  Per-season patch counts:')
    for s in sorted(by_season_patched):
        print(f'    {s}: {by_season_patched[s]} rows')

    if args.dry_run:
        print('\nDry run — cache not written.')
        return 0

    # Write atomically: tmp file, then rename
    tmp = CACHE_PATH.with_suffix(CACHE_PATH.suffix + '.tmp')
    print(f'\nWriting back to {CACHE_PATH}…')
    with tmp.open('w') as f:
        json.dump(cache, f)
    tmp.replace(CACHE_PATH)
    size_mb = CACHE_PATH.stat().st_size / 1024 / 1024
    print(f'  Wrote {size_mb:.1f} MB')
    return 0


if __name__ == '__main__':
    sys.exit(main())
