#!/usr/bin/env python3
"""Project 2026 punter seasons AS COMPONENTS — punts, punt yards, net yards and
punts inside the 20 — with NO fantasy-points number.

The omission is deliberate and was the consumer's own request. There is no
standard punter scoring anywhere in fantasy: per punt, per punt yard and the
whole punt-average ladder default to zero in every catalog we know of, so a
commissioner either prices them or the punter scores nothing. A projected-points
scalar would therefore be meaningless — priced under a catalog nobody uses.
Components are the entire deliverable.

    python3 scripts/build-punter-projections.py [season]

Writes public/data/punter-projections-<season>.json.

WHAT THE DATA SUPPORTS, measured over nflverse 2016-2025 (238 punter-seasons
with 8+ games and 20+ punts in consecutive years):

  * Punt VOLUME is mostly team, not punter: 4.01 a game on average, yoy
    r = +0.46, and it has been falling for a decade (4.53 per team-game in
    2016, 3.53 in 2025) as offenses go for it more. Volume is also inverted
    against offensive quality — a good offense punts less — so a punter on a
    contender is worth fewer counting stats, not more.
  * Gross average is the one real skill: yoy r = +0.47, league mean 46.5 yards,
    and it has drifted up about two yards a decade.
  * Net average is weaker (r = +0.34) because it includes the coverage team,
    and the inside-20 rate is close to noise (r = +0.19) — kept at a fifth of
    face value, which is nearly the league rate for everyone.

Each keep below is the RMSE-minimising value on that measurement.

If you want a points number, price these components under your own catalog. We
are not going to invent a scoring system to hand you a total.
"""
from __future__ import annotations

import csv
import gzip
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'public/data'

SEASON = int(sys.argv[1]) if len(sys.argv) > 1 else 2026
HISTORY = list(range(SEASON - 5, SEASON))
HALF_LIFE = 2.0
MIN_HIST_PUNTS = 20
WEEKS = 17

# Fitted: weight on the punter's own rate, remainder to the league mean.
KEEP_VOLUME = 0.45     # yoy r = +0.46, and volume is the offense's doing
KEEP_GROSS = 0.50      # yoy r = +0.47 — the one real leg skill
KEEP_NET = 0.35        # yoy r = +0.34, drags in the coverage unit
KEEP_IN20 = 0.20       # yoy r = +0.19 — barely distinguishable from the league
IN_SEASON_K = 6.0      # between the kicker's 9.5 and a skill position's; volume is team-driven
AVAILABILITY_PSEUDO_COUNT = 5.5

SRC = {'att': 'pt_att', 'yds': 'pt_yards', 'net': 'pt_net_yards',
       'in20': 'pt_inside_20', 'tb': 'pt_touchback', 'long': 'pt_long'}


# nflverse's roster files say AZ where its schedule says ARI — the same
# franchise under two codes in one feed. Left alone it is not cosmetic: the
# weekly builder keys matchups on the SCHEDULE's code, so every Arizona player
# sourced from the roster got an all-null weekly strip (34 defenders, silently
# projecting nothing every week). Normalize on the way in.
TEAM_ALIASES = {'AZ': 'ARI', 'LAR': 'LA', 'OAK': 'LV', 'SD': 'LAC', 'STL': 'LA'}


def norm_team(team: str) -> str:
    return TEAM_ALIASES.get((team or '').upper(), (team or '').upper()) or None


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


def num(row, key) -> float:
    try:
        return float(row.get(key) or 0)
    except (TypeError, ValueError):
        return 0.0


def load_json(path: Path, fallback):
    try:
        return json.loads(path.read_text())
    except Exception:
        return fallback


def season_punting(season: int):
    agg = defaultdict(lambda: defaultdict(float))
    weeks = defaultdict(set)
    elapsed = 0
    for r in iter_csv(f'player_stats_{season}'):
        if r.get('season_type') != 'REG' or r.get('position') != 'P':
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
        for key, src in SRC.items():
            if key == 'long':
                agg[pid][key] = max(agg[pid][key], num(r, src))
            else:
                agg[pid][key] += num(r, src)
    out = {}
    for pid, wk in weeks.items():
        out[pid] = {'games': len(wk), **{k: agg[pid][k] for k in SRC}}
    return out, elapsed


def main() -> None:
    history = {}
    for year in HISTORY:
        rows, _ = season_punting(year)
        if rows:
            history[year] = rows
    if not history:
        raise SystemExit('no punting history found — cannot project')
    latest = max(history)

    pool = [v for v in history[latest].values() if v['att'] >= MIN_HIST_PUNTS]
    league = {
        'volume': sum(v['att'] / v['games'] for v in pool) / len(pool),
        'gross': sum(v['yds'] for v in pool) / sum(v['att'] for v in pool),
        'net': sum(v['net'] for v in pool) / sum(v['att'] for v in pool),
        'in20': sum(v['in20'] for v in pool) / sum(v['att'] for v in pool),
    }
    print(f'  league {latest}: {league["volume"]:.2f} punts/gm, {league["gross"]:.1f} gross, '
          f'{league["net"]:.1f} net, {100*league["in20"]:.0f}% inside the 20')

    live, weeks_elapsed = season_punting(SEASON)
    if live:
        print(f'  in-season: {weeks_elapsed} week(s) elapsed, {len(live)} punters with {SEASON} games')

    sleeper = {}
    for p in load_json(DATA / 'player-id-map.json', {}).get('players', []):
        if p.get('gsis'):
            sleeper[p['gsis']] = p.get('sleeper')

    rows = []
    for r in iter_csv(f'roster_{SEASON}'):
        if (r.get('position') or '').upper() != 'P':
            continue
        if (r.get('status') or 'ACT') not in ('ACT', 'RES'):
            continue
        gsis = r.get('gsis_id') or ''
        num_, den = defaultdict(float), 0.0
        punts_seen = 0.0
        for year, rowsy in history.items():
            v = rowsy.get(gsis)
            if not v or v['att'] < MIN_HIST_PUNTS:
                continue
            w = (0.5 ** ((latest - year) / HALF_LIFE)) * v['att']
            den += w
            punts_seen += v['att']
            num_['volume'] += w * (v['att'] / v['games'])
            num_['gross'] += w * (v['yds'] / v['att'])
            num_['net'] += w * (v['net'] / v['att'])
            num_['in20'] += w * (v['in20'] / v['att'])
        if den:
            own = {k: num_[k] / den for k in ('volume', 'gross', 'net', 'in20')}
            rates = {
                'volume': KEEP_VOLUME * own['volume'] + (1 - KEEP_VOLUME) * league['volume'],
                'gross': KEEP_GROSS * own['gross'] + (1 - KEEP_GROSS) * league['gross'],
                'net': KEEP_NET * own['net'] + (1 - KEEP_NET) * league['net'],
                'in20': KEEP_IN20 * own['in20'] + (1 - KEEP_IN20) * league['in20'],
            }
        else:
            rates = dict(league)     # no NFL record: the league punter
        games = float(WEEKS)

        n_live = 0
        if gsis in live and live[gsis]['att'] > 0:
            v = live[gsis]
            n_live = v['games']
            w_live = n_live / (n_live + IN_SEASON_K)
            rates['volume'] = (1 - w_live) * rates['volume'] + w_live * (v['att'] / v['games'])
            for key, src in (('gross', 'yds'), ('net', 'net'), ('in20', 'in20')):
                rates[key] = (1 - w_live) * rates[key] + w_live * (v[src] / v['att'])
            prior_rate = min(1.0, games / WEEKS)
            rate = ((n_live + AVAILABILITY_PSEUDO_COUNT * prior_rate)
                    / (weeks_elapsed + AVAILABILITY_PSEUDO_COUNT)) if weeks_elapsed else prior_rate
            games = min(float(WEEKS), n_live + max(0, WEEKS - weeks_elapsed) * rate)

        punts = rates['volume'] * games
        rows.append({
            'name': r.get('full_name'), 'team': norm_team(r.get('team')), 'pos': 'P',
            'gsis': gsis or None, 'sleeper': sleeper.get(gsis),
            'games': round(games, 1),
            'punts': round(punts, 1),
            'punt_yd': round(punts * rates['gross'], 0),
            'punt_net_yd': round(punts * rates['net'], 0),
            'punt_in20': round(punts * rates['in20'], 1),
            'punt_avg': round(rates['gross'], 1),
            'punt_net_avg': round(rates['net'], 1),
            'punts_pg': round(rates['volume'], 2),
            'career_punts_sample': int(punts_seen),
            'inSeasonGames': n_live,
            'inSeasonWeight': round(n_live / (n_live + IN_SEASON_K), 3) if n_live else 0,
        })

    rows.sort(key=lambda r: -r['punt_yd'])
    doc = {
        'season': SEASON,
        'generatedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'note': (
            'Projected punter seasons as components — punts, punt yards, net yards, punts '
            'inside the 20, and the gross and net averages behind them. There is deliberately '
            'NO fantasy-points number: no standard punter scoring exists (per punt, per punt '
            'yard and the punt-average ladder default to zero in every catalog we have seen), '
            'so a points total would be priced under rules nobody uses. Price these under your '
            'own. Measured limits: punt VOLUME is the offense\'s doing more than the punter\'s '
            '(yoy r=+0.46) and has fallen from 4.53 per team-game in 2016 to 3.53 in 2025, so a '
            'punter on a good offense is worth FEWER counting stats; gross average is the real '
            'leg skill (r=+0.47); net average is muddied by the coverage team (r=+0.34); and '
            'the inside-20 rate is near noise (r=+0.19), kept at a fifth of face value. For the '
            'punt-average ladder, remember a season average cannot be scored against a weekly '
            'threshold — integrate over the per-punt distribution.'
        ),
        'method': {
            'history': [min(history), latest],
            'keep': {'volume': KEEP_VOLUME, 'gross': KEEP_GROSS, 'net': KEEP_NET, 'in20': KEEP_IN20},
            'measuredYoyR': {'volume': 0.46, 'gross': 0.47, 'net': 0.34, 'in20': 0.19},
            'leagueRates': {k: round(v, 3) for k, v in league.items()},
            'halfLifeSeasons': HALF_LIFE,
            'inSeasonK': IN_SEASON_K,
            'availabilityPseudoCount': AVAILABILITY_PSEUDO_COUNT,
            'noPointsByDesign': True,
        },
        'players': rows,
    }
    out = DATA / f'punter-projections-{SEASON}.json'
    out.write_text(json.dumps(doc) + '\n')
    print(f'  Wrote {out} — {len(rows)} punters')
    for r in rows[:5]:
        print(f'    {r["name"]:22s} {r["team"]:3s} {r["punts"]:5.1f} punts, {r["punt_yd"]:5.0f} yds '
              f'({r["punt_avg"]} avg, {r["punt_net_avg"]} net), {r["punt_in20"]:4.1f} inside 20')


if __name__ == '__main__':
    main()
