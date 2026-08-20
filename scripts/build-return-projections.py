#!/usr/bin/env python3
"""Project 2026 punt- and kickoff-return components — returns, return yards and
return touchdowns — for every player with a return role.

Leagues price return yardage separately (commonly 1 point per 25 return yards,
or per-return bonuses), and none of it is recoverable from a rushing/receiving
stat line. These are components, not points.

    python3 scripts/build-return-projections.py [season]

Writes public/data/return-projections-<season>.json.

WHAT THE DATA SUPPORTS, measured over nflverse 2018-2025:

  * KICKOFF RETURN VOLUME HAS BEEN REWRITTEN BY RULE, twice, in three years.
    Returns per team-game: 1.86 (2022), 1.08 (2023), 1.69 (2024), 3.82 (2025)
    — the dynamic-kickoff and touchback changes. Any multi-year average is
    wrong by a factor of two or more, so the role rates below are taken from
    the MOST RECENT completed season only. Punt returns are stable by
    comparison (1.5-1.8 per team-game across the whole window).
  * Role beats history. Only 47% of players with 8+ returns repeat 8+ the next
    season, so who holds the job on the current depth chart matters more than
    who held it last year. Depth-chart PR1s take 79% of their team's punt
    returns (about 1.2 a game); KR1s only 47% of kick returns (about 1.8 a
    game in 2025) because kick return duty is split far more often.
  * Given a role, per-game volume does carry: punt returns yoy r = +0.65
    (fitted keep 0.62, 23% better than the returner-population mean), kick
    returns r = +0.49 (keep 0.52, 12% better).
  * Return AVERAGE is mostly noise for punts (yards per return yoy r = +0.17,
    keep 0.18) and only moderate for kicks (r = +0.40, keep 0.34). So a
    returner's own average is kept at a fraction of face value and the rest
    comes from the league rate — which itself has moved with the rules (punt
    8.5 yds/ret in 2018 to 10.2 in 2025; kick 22.9 to 25.9).
  * Return touchdowns carry no usable player signal (yoy r = +0.25 on counts
    that are almost always zero). Everyone gets the league rate per return.

Per-game rates are the primary output. Season totals here use this file's own
games estimate; a consumer holding a better one (the season projection pool's
`games`, say) should multiply the rates by that instead, which is what the MCP
does when it merges these onto a projection row.
"""
from __future__ import annotations

import csv
import gzip
import json
import math
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'public/data'

SEASON = int(sys.argv[1]) if len(sys.argv) > 1 else 2026
HISTORY = list(range(SEASON - 4, SEASON))   # short on purpose: the rules moved
HALF_LIFE = 1.5

KEEP_PR = 0.62      # fitted: punt returns per game
KEEP_KR = 0.52      # fitted: kick returns per game
KEEP_YPR_PUNT = 0.18
KEEP_YPR_KICK = 0.34
BACKUP_SHARE = 0.25  # a returner NOT holding the current job, as a share of the role rate
# In-season blend. Fitted the same way as every other surface (3,254 cutoffs,
# 2017-2025): K = 3.5, blend RMSE 0.898 against rest-of-season return volume
# versus 1.094 prior-only and 1.085 current-only. Fast, because who is actually
# fielding kicks this year settles the question a depth chart only hints at.
IN_SEASON_K = 3.5
MIN_HIST_RETURNS = 5

SRC = {'pr': 'punt_returns', 'pr_yd': 'punt_return_yards',
       'kr': 'kickoff_returns', 'kr_yd': 'kickoff_return_yards',
       'ret_td': 'special_teams_tds'}


def iter_csv(name: str):
    raw = DATA / f'{name}.csv'
    if raw.exists():
        with raw.open(newline='') as fh:
            yield from csv.DictReader(fh)
        return
    gz = DATA / f'{name}.csv.gz'
    if gz.exists():
        with gzip.open(gz, mode='rt', newline='') as fh:
            yield from csv.DictReader(fh)


def load_json(path: Path, fallback):
    try:
        return json.loads(path.read_text())
    except Exception:
        return fallback


def num(row, key) -> float:
    try:
        return float(row.get(key) or 0)
    except (TypeError, ValueError):
        return 0.0


def load_season(season: int):
    agg = defaultdict(lambda: defaultdict(float))
    meta = {}
    team_games = defaultdict(set)
    seen = False
    for r in iter_csv(f'player_stats_{season}'):
        seen = True
        if r.get('season_type') != 'REG':
            continue
        pid = r.get('player_id')
        if not pid:
            continue
        agg[pid]['games'] += 1
        for key, src in SRC.items():
            agg[pid][key] += num(r, src)
        agg[pid]['_team'] = 0  # placeholder so defaultdict keeps shape
        meta[pid] = (r.get('player_display_name') or r.get('player_name'),
                     r.get('position'), r.get('team'))
        team_games[r.get('team')].add(r.get('week'))
    if not seen:
        return None
    return {'agg': agg, 'meta': meta, 'team_games': team_games}


def role_rates(season_doc) -> dict:
    """What the top punt/kick returner on a team actually gets per game, in the
    most recent completed season. Taken from one season on purpose — the
    kickoff rules moved twice in three years."""
    by_team = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0]))
    for pid, v in season_doc['agg'].items():
        team = season_doc['meta'][pid][2]
        by_team[team][pid][0] += v['pr']
        by_team[team][pid][1] += v['kr']
    pr_top, kr_top = [], []
    for team, players in by_team.items():
        games = len(season_doc['team_games'].get(team) or []) or 17
        prs = sorted((p[0] for p in players.values()), reverse=True)
        krs = sorted((p[1] for p in players.values()), reverse=True)
        if prs and prs[0] > 0:
            pr_top.append(prs[0] / games)
        if krs and krs[0] > 0:
            kr_top.append(krs[0] / games)
    return {
        'pr': sum(pr_top) / len(pr_top) if pr_top else 1.2,
        'kr': sum(kr_top) / len(kr_top) if kr_top else 1.8,
    }


def league_rates(seasons: dict, years: list[int]) -> dict:
    """Yards per return and TDs per return over the given seasons."""
    tot = defaultdict(float)
    for year in years:
        s = seasons.get(year)
        if not s:
            continue
        for v in s['agg'].values():
            for key in SRC:
                tot[key] += v[key]
    return {
        'ypr_punt': tot['pr_yd'] / tot['pr'] if tot['pr'] else 9.5,
        'ypr_kick': tot['kr_yd'] / tot['kr'] if tot['kr'] else 24.5,
        # Return TDs come out of the special_teams_tds column, which also picks
        # up the odd blocked-kick return. Spread over all returns, it is a rate
        # of roughly one per 250, and no player beats it reliably.
        'td_per_ret': tot['ret_td'] / (tot['pr'] + tot['kr']) if (tot['pr'] + tot['kr']) else 0.004,
    }


def history(seasons: dict, pid: str):
    """Recency-weighted per-game return rates and averages from a player's own
    recent seasons. Weighted by games so a two-week cameo cannot outvote a
    season."""
    num_, den = defaultdict(float), 0.0
    tot = defaultdict(float)
    for year in HISTORY:
        s = seasons.get(year)
        if not s:
            continue
        v = s['agg'].get(pid)
        if not v or v['games'] < 3:
            continue
        w = (0.5 ** ((max(HISTORY) - year) / HALF_LIFE)) * v['games']
        den += w
        for key in ('pr', 'pr_yd', 'kr', 'kr_yd', 'ret_td'):
            num_[key] += w * v[key] / v['games']
            tot[key] += v[key]
        tot['games'] += v['games']
    if not den:
        return None
    out = {key: num_[key] / den for key in ('pr', 'pr_yd', 'kr', 'kr_yd', 'ret_td')}
    out['_returns'] = tot['pr'] + tot['kr']
    out['_ypr_punt'] = tot['pr_yd'] / tot['pr'] if tot['pr'] >= 10 else None
    out['_ypr_kick'] = tot['kr_yd'] / tot['kr'] if tot['kr'] >= 10 else None
    out['_games'] = tot['games']
    return out


def current_returns(season: int):
    """gsis -> (games, punt returns/gm, kick returns/gm) for the season in
    progress, plus weeks elapsed. Empty preseason."""
    weeks = defaultdict(set)
    pr = defaultdict(float)
    kr = defaultdict(float)
    elapsed = 0
    for r in iter_csv(f'player_stats_{season}'):
        if r.get('season_type') != 'REG':
            continue
        pid = r.get('player_id')
        try:
            week = int(r['week'])
        except (ValueError, TypeError, KeyError):
            continue
        if not pid:
            continue
        elapsed = max(elapsed, week)
        weeks[pid].add(week)
        pr[pid] += num(r, 'punt_returns')
        kr[pid] += num(r, 'kickoff_returns')
    out = {p: (len(w), pr[p] / len(w), kr[p] / len(w)) for p, w in weeks.items() if w}
    return out, elapsed


def depth_returners(season: int):
    """team -> {'PR': [gsis...], 'KR': [gsis...]} from the newest depth chart,
    ordered by depth rank. Mirrors build-kicker-projections' PK1 lookup."""
    newest = defaultdict(lambda: defaultdict(dict))   # (team, slot) -> rank -> (dt, gsis, name)
    for r in iter_csv(f'depth_charts_{season}'):
        slot = r.get('pos_abb')
        if slot not in ('PR', 'KR'):
            continue
        team, dt = r.get('team'), r.get('dt') or ''
        try:
            rank = int(r.get('pos_rank') or 9)
        except ValueError:
            rank = 9
        cur = newest[team][slot].get(rank)
        if cur is None or dt >= cur[0]:
            newest[team][slot][rank] = (dt, r.get('gsis_id'), r.get('player_name'))
    out = {}
    for team, slots in newest.items():
        out[team] = {slot: [v[1] for _, v in sorted(ranks.items()) if v[1]]
                     for slot, ranks in slots.items()}
    return out


def main() -> None:
    seasons = {}
    for year in HISTORY:
        s = load_season(year)
        if s:
            seasons[year] = s
    if not seasons:
        raise SystemExit('no player_stats history found — cannot project returns')
    latest = max(seasons)
    roles = role_rates(seasons[latest])
    league = league_rates(seasons, [y for y in (latest - 1, latest) if y in seasons])
    print(f'  role rates from {latest}: PR1 {roles["pr"]:.2f}/gm, KR1 {roles["kr"]:.2f}/gm; '
          f'league {league["ypr_punt"]:.1f} yds/punt-ret, {league["ypr_kick"]:.1f} yds/kick-ret')

    chart = depth_returners(SEASON)
    pr_holder, kr_holder = {}, {}
    for team, slots in chart.items():
        for gsis in (slots.get('PR') or [])[:1]:
            pr_holder[gsis] = team
        for gsis in (slots.get('KR') or [])[:1]:
            kr_holder[gsis] = team

    sleeper_by_gsis, pos_by_gsis = {}, {}
    for p in load_json(DATA / 'player-id-map.json', {}).get('players', []):
        if p.get('gsis'):
            sleeper_by_gsis[p['gsis']] = p.get('sleeper')
            pos_by_gsis[p['gsis']] = p.get('pos')

    live, weeks_elapsed = current_returns(SEASON)
    if live:
        print(f'  in-season: {weeks_elapsed} week(s) elapsed, current season weighted '
              f'{weeks_elapsed / (weeks_elapsed + IN_SEASON_K):.0%} at full participation')

    rows = []
    for r in iter_csv(f'roster_{SEASON}'):
        if (r.get('status') or 'ACT') not in ('ACT', 'RES'):
            continue
        gsis = r.get('gsis_id') or ''
        if not gsis:
            continue
        hist = history(seasons, gsis)
        holds_pr, holds_kr = gsis in pr_holder, gsis in kr_holder
        experienced = hist is not None and hist['_returns'] >= MIN_HIST_RETURNS
        if not (holds_pr or holds_kr or experienced):
            continue

        # Volume: blend the player's own rate toward the rate for the job they
        # actually hold in 2026 — or a fraction of it if they don't hold it.
        pr_target = roles['pr'] if holds_pr else roles['pr'] * BACKUP_SHARE
        kr_target = roles['kr'] if holds_kr else roles['kr'] * BACKUP_SHARE
        if hist is None:
            pr_pg, kr_pg = pr_target, kr_target
        else:
            pr_pg = KEEP_PR * hist['pr'] + (1 - KEEP_PR) * pr_target
            kr_pg = KEEP_KR * hist['kr'] + (1 - KEEP_KR) * kr_target

        # In-season: what he is actually returning this year outranks both the
        # depth chart and last season. No-op preseason.
        n_live = 0
        if gsis in live:
            n_live, live_pr, live_kr = live[gsis]
            w_live = n_live / (n_live + IN_SEASON_K)
            pr_pg = (1 - w_live) * pr_pg + w_live * live_pr
            kr_pg = (1 - w_live) * kr_pg + w_live * live_kr

        ypr_punt = league['ypr_punt']
        if hist and hist['_ypr_punt'] is not None:
            ypr_punt = KEEP_YPR_PUNT * hist['_ypr_punt'] + (1 - KEEP_YPR_PUNT) * league['ypr_punt']
        ypr_kick = league['ypr_kick']
        if hist and hist['_ypr_kick'] is not None:
            ypr_kick = KEEP_YPR_KICK * hist['_ypr_kick'] + (1 - KEEP_YPR_KICK) * league['ypr_kick']

        games = min(17.0, max(1.0, hist['_games'] / max(1, len([y for y in HISTORY if seasons.get(y) and seasons[y]['agg'].get(gsis)])))) if hist else 14.0
        rows.append({
            'name': r.get('full_name') or r.get('football_name'),
            'team': r.get('team'),
            'pos': pos_by_gsis.get(gsis) or r.get('position'),
            'gsis': gsis, 'sleeper': sleeper_by_gsis.get(gsis),
            'pr_role': bool(holds_pr), 'kr_role': bool(holds_kr),
            'inSeasonGames': n_live,
            'inSeasonWeight': round(n_live / (n_live + IN_SEASON_K), 3) if n_live else 0,
            'games': round(games, 1),
            'pr_pg': round(pr_pg, 3), 'kr_pg': round(kr_pg, 3),
            'pr_yd_pg': round(pr_pg * ypr_punt, 2), 'kr_yd_pg': round(kr_pg * ypr_kick, 2),
            'ret_yd_pg': round(pr_pg * ypr_punt + kr_pg * ypr_kick, 2),
            'ret_td_pg': round((pr_pg + kr_pg) * league['td_per_ret'], 4),
            'ypr_punt': round(ypr_punt, 2), 'ypr_kick': round(ypr_kick, 2),
            'pr': round(pr_pg * games, 1), 'kr': round(kr_pg * games, 1),
            'pr_yd': round(pr_pg * ypr_punt * games, 1),
            'kr_yd': round(kr_pg * ypr_kick * games, 1),
            'ret_yd': round((pr_pg * ypr_punt + kr_pg * ypr_kick) * games, 1),
            'ret_td': round((pr_pg + kr_pg) * league['td_per_ret'] * games, 2),
        })

    rows.sort(key=lambda x: -x['ret_yd_pg'])
    doc = {
        'season': SEASON,
        'generatedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'note': (
            'Projected punt- and kickoff-return components: returns, return yards and return '
            'touchdowns, per game and per season. Per-game rates are the primary output — a '
            'consumer holding a better games estimate (the season projection pool publishes one) '
            'should multiply the rates by that rather than use the season totals here. Volume is '
            'anchored on the CURRENT depth chart (PR1/KR1) blended with the player\'s own recent '
            'rate, because only 47% of players with 8+ returns repeat the job the next year. '
            'Kickoff volume is taken from the most recent season only: the dynamic-kickoff and '
            'touchback rules moved returns per team-game from 1.08 (2023) to 1.69 (2024) to 3.82 '
            '(2025), so any multi-year average is wrong by a factor of two. Return averages are '
            'mostly league rate — a returner\'s own punt average carries r=0.17 year over year, '
            'kick average r=0.40. Return touchdowns are the league rate per return for everyone.'
        ),
        'method': {
            'history': [min(seasons), latest],
            'roleRatesFromSeason': latest,
            'roleRatesPerGame': {k: round(v, 3) for k, v in roles.items()},
            'leagueRates': {k: round(v, 4) for k, v in league.items()},
            'keep': {'pr': KEEP_PR, 'kr': KEEP_KR,
                     'yprPunt': KEEP_YPR_PUNT, 'yprKick': KEEP_YPR_KICK},
            'backupShare': BACKUP_SHARE,
            'inSeasonK': IN_SEASON_K,
            'halfLifeSeasons': HALF_LIFE,
            'measured': {
                'prYoyR': 0.65, 'krYoyR': 0.49,
                'yprPuntYoyR': 0.17, 'yprKickYoyR': 0.40,
                'roleRepeatRate': 0.47,
                'kickReturnsPerTeamGame': {'2022': 1.86, '2023': 1.08, '2024': 1.69, '2025': 3.82},
            },
        },
        'players': rows,
    }
    out = DATA / f'return-projections-{SEASON}.json'
    out.write_text(json.dumps(doc) + '\n')
    print(f'  Wrote {out} — {len(rows)} returners '
          f'({sum(1 for r in rows if r["pr_role"])} PR1s, {sum(1 for r in rows if r["kr_role"])} KR1s)')
    for r in rows[:5]:
        print(f'    {r["name"]:24s} {r["pos"] or "":3s} {r["team"]:3s} '
              f'PR {r["pr_pg"]:.2f}/gm {r["pr_yd_pg"]:5.1f} yd  KR {r["kr_pg"]:.2f}/gm {r["kr_yd_pg"]:5.1f} yd '
              f'-> {r["ret_yd"]:.0f} return yards')


if __name__ == '__main__':
    main()
