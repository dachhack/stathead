#!/usr/bin/env python3
"""Who gets traded: trade volume by rank on StatHead value, by cohort.

Every player in a two-team dynasty or keeper trade without FAAB (the trades
scripts/fit-player-values.py fits) is placed by his rank on StatHead's as-of
value the week BEFORE the trade, so the trade itself never moves the rank it
is counted at. Each week has exactly one player at each rank, so the counts by
rank compare like with like: a rank that gets fewer trades is traded less, not
merely less populated.

Cohorts, each within a format (superflex / 1QB) and each on its own:
  all     every trade in the window
  season  the league's season
  period  time of year, by the trade's date (UTC):
            offseason      Feb-Apr  (after the Super Bowl, up to the NFL draft)
            rookieDrafts   May-Jun  (most rookie drafts)
            preseason      Jul-Aug
            earlySeason    Sep-Oct
            lateSeason     Nov-Jan  (trade deadlines and playoffs)
  tep     the league's TE premium: none, under 0.75 or 0.75+ bonus points
          per TE catch

Ranks are on the format's published value, which is for no TE premium: in a
TE-premium league a TE is worth more than his rank says (the factors are in
player-trade-values.json under scoring). Only players in the history file
(100+ trades in the window) are ranked, so ranks past ~300 run a little high
and thinner players count as unranked.

Output: counts and shares only, any cell under --min-cell suppressed (null).
No trade, league, manager or player is named (docs/third-party-data-policy.md).
The workflow puts it on the sleeper-trade-db release next to audit.json.

Usage: python3 scripts/study-trade-volume.py <dir with sleeper-trades.sqlite>
       [--values=public/data/player-trade-values.json]
       [--history=public/data/player-trade-values-history.json]
       [--out=trade-volume-study.json] [--min-cell=10]
"""
from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

WEEK_MS = 7 * 86400 * 1000
# The trades scripts/fit-player-values.py fits (its FILTER).
FILTER = "t.n_sides = 2 AND t.faab_total = 0 AND t.n_players + t.n_picks > 0 AND t.type IN ('dynasty', 'keeper')"
OFFENSE = ('QB', 'RB', 'WR', 'TE')
MAX_RANK, MAX_POS = 300, 60
PERIODS = {2: 'offseason', 3: 'offseason', 4: 'offseason', 5: 'rookieDrafts', 6: 'rookieDrafts',
           7: 'preseason', 8: 'preseason', 9: 'earlySeason', 10: 'earlySeason',
           11: 'lateSeason', 12: 'lateSeason', 1: 'lateSeason'}
PERIOD_NOTE = {'offseason': 'Feb-Apr', 'rookieDrafts': 'May-Jun', 'preseason': 'Jul-Aug',
               'earlySeason': 'Sep-Oct', 'lateSeason': 'Nov-Jan'}


def tep_code(tep) -> str:
    return 'none' if not tep or tep <= 0 else 'under0.75' if tep < 0.75 else '0.75plus'


def overall_buckets():
    """(label, first rank, last rank): 1-20 one by one, then 5s to 150, then wider."""
    b = [(str(r), r, r) for r in range(1, 21)]
    b += [(f'{r}-{r + 4}', r, r + 4) for r in range(21, 151, 5)]
    b += [('151-200', 151, 200), ('201-300', 201, 300)]
    return b


def pos_buckets():
    return [(f'{r}-{r + 4}', r, r + 4) for r in range(1, MAX_POS + 1, 5)]


def week_of(ms: int) -> int:
    return ms - ms % WEEK_MS


def rank_table(hist: dict, pos_of: dict) -> dict:
    """{(player, week start ms): (rank, position rank, position)} from the as-of
    history: each week's offense players ranked on that week's value."""
    by_week = {}
    for pid, h in hist.items():
        pos = pos_of.get(pid)
        if pos not in OFFENSE:
            continue
        w = int(datetime.fromisoformat(h['from']).replace(tzinfo=timezone.utc).timestamp() * 1000)
        w = week_of(w)
        for i, v in enumerate(h['v']):
            if v is None or v != v:
                continue
            by_week.setdefault(w + i * WEEK_MS, []).append((v, pid, pos))
    table = {}
    for w, rows in by_week.items():
        rows.sort(key=lambda r: -r[0])
        n = {}
        for i, (_, pid, pos) in enumerate(rows):
            n[pos] = n.get(pos, 0) + 1
            table[(pid, w)] = (i + 1, n[pos], pos)
    return table


class Cell:
    """Counts for one cohort: by overall rank (index 1..300, 301 = past 300,
    0 = unranked) and by position rank (1..60, 61 = past 60, 0 = unranked)."""

    def __init__(self):
        self.trades = 0
        self.overall = [0] * (MAX_RANK + 2)
        self.pos = {p: [0] * (MAX_POS + 2) for p in OFFENSE}
        self.other = 0   # players with no offense position (IDP, unknown)
        self.first = self.last = None

    def add(self, ranked, created):
        if ranked is None:
            self.overall[0] += 1
            self.other += 1
        else:
            r, pr, pos = ranked
            self.overall[min(r, MAX_RANK + 1)] += 1
            self.pos[pos][min(pr, MAX_POS + 1)] += 1
        self.first = created if self.first is None else min(self.first, created)
        self.last = created if self.last is None else max(self.last, created)

    def add_unranked(self, pos, created):
        if pos in OFFENSE:
            self.overall[0] += 1
            self.pos[pos][0] += 1
            self.first = created if self.first is None else min(self.first, created)
            self.last = created if self.last is None else max(self.last, created)
        else:
            self.add(None, created)

    def report(self, min_cell: int) -> dict:
        n = sum(self.overall)
        sup = lambda c: c if c >= min_cell else None
        share = lambda c, tot: round(100 * c / tot, 2) if tot and c >= min_cell else None
        ob = overall_buckets()
        overall = [{'ranks': lab, 'n': sup(sum(self.overall[a:b + 1])),
                    'share': share(sum(self.overall[a:b + 1]), n)} for lab, a, b in ob]
        overall += [{'ranks': '301+', 'n': sup(self.overall[MAX_RANK + 1]), 'share': share(self.overall[MAX_RANK + 1], n)},
                    {'ranks': 'unranked', 'n': sup(self.overall[0]), 'share': share(self.overall[0], n)}]
        positions = {}
        for p, arr in self.pos.items():
            tot = sum(arr)
            rows = [{'ranks': lab, 'n': sup(sum(arr[a:b + 1])), 'share': share(sum(arr[a:b + 1]), tot)}
                    for lab, a, b in pos_buckets()]
            rows += [{'ranks': f'{MAX_POS + 1}+', 'n': sup(arr[MAX_POS + 1]), 'share': share(arr[MAX_POS + 1], tot)},
                     {'ranks': 'unranked', 'n': sup(arr[0]), 'share': share(arr[0], tot)}]
            positions[p] = {'n': sup(tot), 'shareOfAll': share(tot, n), 'byPositionRank': rows,
                            'top6VsNext18': ratio(arr, 1, 6, 7, 24, min_cell)}
        # The busiest 5-rank group in the top 150, and the top 12 against
        # ranks 25-48, per rank slot.
        groups = [(r, sum(self.overall[r:r + 5])) for r in range(1, 151, 5)]
        peak = max(groups, key=lambda g: g[1]) if n else None
        return {
            'trades': sup(self.trades), 'appearances': sup(n),
            'from': iso(self.first), 'to': iso(self.last),
            'summary': {
                'top12VsRanks25to48': ratio(self.overall, 1, 12, 25, 48, min_cell),
                'top24VsRanks25to96': ratio(self.overall, 1, 24, 25, 96, min_cell),
                'peakGroup': f'{peak[0]}-{peak[0] + 4}' if peak and peak[1] >= min_cell else None,
                'shareTop150': share(sum(self.overall[1:151]), n),
            },
            'overall': overall, 'positions': positions,
            'otherPlayers': sup(self.other),
        }


def ratio(arr, a, b, c, d, min_cell):
    """Trades per rank slot in a..b over the same in c..d."""
    x, y = sum(arr[a:b + 1]), sum(arr[c:d + 1])
    if x < min_cell or y < min_cell:
        return None
    return round((x / (b - a + 1)) / (y / (d - c + 1)), 3)


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).date().isoformat() if ms else None


def main() -> None:
    args = dict(a.lstrip('-').split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
    d = Path(next(a for a in sys.argv[1:] if not a.startswith('--')))
    values = json.loads(Path(args.get('values', 'public/data/player-trade-values.json')).read_text())
    hist = json.loads(Path(args.get('history', 'public/data/player-trade-values-history.json')).read_text())
    out_path = Path(args.get('out', 'trade-volume-study.json'))
    min_cell = int(args.get('min-cell', 10))
    db = sqlite3.connect(d / 'sleeper-trades.sqlite')
    out = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'source': 'two-team dynasty and keeper trades without FAAB in public Sleeper leagues, players placed by '
                  'rank on StatHead trade value the week before each trade',
        'minCell': min_cell,
        'note': ('Counts and shares of player appearances in trades, never a trade, league, manager or player. '
                 'Each week has one player per rank, so shares by rank compare like with like. Ranks are on the '
                 'format\'s value for no TE premium; only players in 100+ trades in the window are ranked. '
                 f'Cells under {min_cell} are null. top12VsRanks25to48: trades per rank slot in the top 12 over '
                 'the same in ranks 25-48 (under 1: the top 12 trade less). top6VsNext18: the same within a '
                 'position, top 6 against ranks 7-24.'),
        'periods': PERIOD_NOTE,
        'formats': {},
    }
    for key, sf in (('superflex', 1), ('1qb', 0)):
        fmt_vals = (values.get('formats') or {}).get(key)
        fmt_hist = (hist.get('formats') or {}).get(key)
        if not fmt_vals or not fmt_hist:
            continue
        pos_of = {p['sleeper_id']: p.get('pos') for p in fmt_vals['players'] if not p.get('idp')}
        table = rank_table(fmt_hist, pos_of)
        if not table:
            continue
        start = min(w for _, w in table) + WEEK_MS   # the first week with a week-before rank
        cells = {}

        def cohorts(season, created, tep):
            month = datetime.fromtimestamp(created / 1000, timezone.utc).month
            return (('all', 'all'), ('season', str(season)), ('period', PERIODS[month]), ('tep', tep_code(tep)))

        def cell(k):
            c = cells.get(k)
            if c is None:
                c = cells[k] = Cell()
            return c
        where = f'{FILTER} AND t.sf = ? AND t.created >= ?'
        for season, created, tep in db.execute(f'SELECT t.season, t.created, t.tep FROM trades t WHERE {where}',
                                               (sf, start)):
            for k in cohorts(season, created, tep):
                cell(k).trades += 1
        n_rows = 0
        for season, created, tep, pid in db.execute(
                f"SELECT t.season, t.created, t.tep, a.player_id FROM trade_assets a JOIN trades t ON t.id = a.trade_id "
                f"WHERE a.kind = 'player' AND {where}", (sf, start)):
            n_rows += 1
            ranked = table.get((pid, week_of(created) - WEEK_MS))
            for k in cohorts(season, created, tep):
                if ranked is None:
                    cell(k).add_unranked(pos_of.get(pid), created)
                else:
                    cell(k).add(ranked, created)
        res = {'window': {'from': iso(start), 'to': fmt_vals.get('to')}, 'cohorts': {}}
        for (dim, name), c in sorted(cells.items(), key=lambda kv: (kv[0][0], kv[0][1])):
            res['cohorts'].setdefault(dim, {})[name] = c.report(min_cell)
        out['formats'][key] = res
        print(f'  {key}: {n_rows:,} player appearances from {iso(start)}')
        for dim, by in res['cohorts'].items():
            for name, r in by.items():
                s = r['summary']
                pos = {p: r['positions'][p]['shareOfAll'] for p in OFFENSE}
                print(f"    {dim:7s} {name:12s} trades {r['trades'] or '<min':>9} | top12 vs 25-48 "
                      f"{s['top12VsRanks25to48']} | peak {s['peakGroup']} | share by position {pos} | "
                      f"TE top6 vs 7-24 {r['positions']['TE']['top6VsNext18']}")
    out_path.write_text(json.dumps(out, indent=1) + '\n')
    print(f'-> {out_path}')


if __name__ == '__main__':
    main()
