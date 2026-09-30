#!/usr/bin/env python3
"""Season-to-date college stats for the devy models (CollegeFootballData.com).

The devy models are trained on whole college seasons; during a season the
market (KTC) already prices what players are doing now. This pulls the
current season through the last completed regular-season week, plus the SAME
cutoff for every past season on disk, so the season-to-date row can be turned
into a full-season estimate calibrated on history (scripts/devy_features.py
inseason_seasons) and the models can be replayed at that cutoff.

Writes, under public/data/cfbd/inseason/ (committed, gzipped, compact):
  player-season-<Y>.json.gz   current season through week W: one row per player
                              with the devy stat columns (all positions, so team
                              totals and shares are complete); {"throughWeek", ...}
  history-wk<W>.json.gz       the same rows for every past season, through week W
                              (older history-wk files are removed)
  games-<Y>.json.gz           the current season's games (scores, weeks, Elo)
  player-usage-<Y>.json.gz    season-to-date usage rates
  team-talent-<Y>.json.gz     the current season's 247 team talent composite
and the current recruiting class to public/data/cfbd/recruiting-<Y>.json (the
class is final by February, so the full-season fetcher reuses it).

~25 calls on a new cutoff week, ~5 after. A no-op outside the season (or once
the complete season's player-season-<Y>.json exists). Usage:
  python3 scripts/fetch_cfbd_inseason.py [--season 2026] [--through-week 5] [--force]
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv('.env.local')
except ImportError:
    pass

sys.path.insert(0, str(Path(__file__).parent))
from devy_stats import STATS  # noqa: E402

RAW = Path('public/data/cfbd')
OUT = RAW / 'inseason'


def to_dict(obj) -> dict:
    for m in ('to_dict', 'dict'):
        if hasattr(obj, m):
            try:
                return getattr(obj, m)()
            except Exception:
                pass
    return {a: getattr(obj, a) for a in dir(obj) if not a.startswith('_') and not callable(getattr(obj, a))}


def g(d: dict, *keys):
    """A field under its snake_case or camelCase name."""
    for k in keys:
        if d.get(k) is not None:
            return d[k]
    return None


def compact(rows: list[dict]) -> list[dict]:
    """/stats/player/season rows -> one row per (player, season) with the devy stat columns."""
    out: dict[tuple, dict] = {}
    for r in rows:
        col = STATS.get((g(r, 'category'), g(r, 'stat_type', 'statType')))
        if not col:
            continue
        pid = str(g(r, 'player_id', 'playerId') or '')
        key = (pid, int(g(r, 'season')))
        row = out.get(key)
        if row is None:
            row = out[key] = {'player_id': pid, 'season': key[1], 'player': g(r, 'player'),
                              'position': g(r, 'position'), 'team': g(r, 'team'),
                              'conference': g(r, 'conference')}
        try:
            v = float(g(r, 'stat') or 0)
        except (TypeError, ValueError):
            v = 0.0
        row[col] = row.get(col, 0.0) + v
    return list(out.values())


def write_gz(path: Path, doc) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, 'wt') as f:
        json.dump(doc, f, default=str, separators=(',', ':'))
    print(f'  wrote {path} ({path.stat().st_size // 1024} KB)')


def current_season(now: datetime) -> int | None:
    if now.month >= 8:
        return now.year
    if now.month == 1:
        return now.year - 1
    return None


def last_complete_week(calendar: list[dict], now: datetime) -> int | None:
    """The last regular-season week whose final game kicked off 12+ hours ago."""
    done = []
    for w in calendar:
        if str(g(w, 'season_type', 'seasonType')).split('.')[-1].lower() != 'regular':
            continue
        end = g(w, 'last_game_start', 'lastGameStart', 'end_date', 'endDate')
        if end is None:
            continue
        end = end if isinstance(end, datetime) else datetime.fromisoformat(str(end).replace('Z', '+00:00'))
        if end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
        if end + timedelta(hours=12) <= now:
            done.append(int(g(w, 'week')))
    return max(done) if done else None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--season', type=int)
    ap.add_argument('--through-week', type=int)
    ap.add_argument('--force', action='store_true')
    args = ap.parse_args()

    now = datetime.now(timezone.utc)
    season = args.season or current_season(now)
    if season is None or (RAW / f'player-season-{season}.json').exists():
        print(f'no season in progress (season={season}); nothing to do')
        return

    key = os.environ.get('CFBD_API_KEY')
    if not key:
        sys.exit('ERROR: CFBD_API_KEY not set')
    import cfbd
    client = cfbd.ApiClient(cfbd.Configuration(access_token=key))
    stats_api, games_api = cfbd.StatsApi(client), cfbd.GamesApi(client)
    players_api, teams_api, rec_api = cfbd.PlayersApi(client), cfbd.TeamsApi(client), cfbd.RecruitingApi(client)

    week = args.through_week or last_complete_week([to_dict(w) for w in games_api.get_calendar(year=season)], now)
    if not week:
        print(f'{season}: no completed week yet')
        return
    print(f'{season} through week {week}')

    t0 = time.time()
    rows = compact([to_dict(r) for r in stats_api.get_player_season_stats(year=season, end_week=week)])
    write_gz(OUT / f'player-season-{season}.json.gz',
             {'season': season, 'throughWeek': week, 'fetchedAt': now.isoformat(timespec='seconds'), 'rows': rows})
    write_gz(OUT / f'games-{season}.json.gz', [to_dict(x) for x in games_api.get_games(year=season)])
    write_gz(OUT / f'player-usage-{season}.json.gz', [to_dict(x) for x in players_api.get_player_usage(year=season)])
    write_gz(OUT / f'team-talent-{season}.json.gz', [to_dict(x) for x in teams_api.get_talent(year=season)])
    rec_path = RAW / f'recruiting-{season}.json'
    if not rec_path.exists():
        rec_path.write_text(json.dumps([to_dict(x) for x in rec_api.get_recruits(year=season)], default=str))
        print(f'  wrote {rec_path}')

    # The same cutoff for every complete past season on disk (for calibration
    # and the historical replay). Kept for the current cutoff only.
    hist = OUT / f'history-wk{week}.json.gz'
    if hist.exists() and not args.force:
        print(f'  {hist} cached')
    else:
        years = sorted(int(p.stem.split('-')[-1]) for p in RAW.glob('player-season-*.json'))
        allrows = []
        for y in years:
            part = compact([to_dict(r) for r in stats_api.get_player_season_stats(year=y, end_week=week)])
            print(f'  {y} through week {week}: {len(part)} players')
            allrows += part
        write_gz(hist, {'throughWeek': week, 'years': years, 'rows': allrows})
    for old in OUT.glob('history-wk*.json.gz'):
        if old != hist:
            old.unlink()
            print(f'  removed {old}')
    print(f'done in {time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
