#!/usr/bin/env python3
"""Offline test of the trade-analysis jobs on synthetic shards.

Builds a fake crawl (leagues, rosters, rookie drafts, pick-for-pick and player
trades, waiver claims) whose pick swaps are drawn from KNOWN pick values, then
runs scripts/build-sleeper-trade-db.py --lite, scripts/audit-trade-db.py and
scripts/fit-pick-values.py and checks that:
  - the lite build has no waivers and no raw JSON,
  - the audit holds counts only (no ids) and suppresses small cells,
  - the fit recovers the true values of well-populated pick classes.

Usage: python3 scripts/test-trade-analysis.py
"""
from __future__ import annotations

import gzip
import json
import random
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = {1: 100, 2: 35, 3: 15, 4: 7, 5: 4}
TIER = {'E': 1.3, 'M': 1.0, 'L': 0.8}
YEAR = 2025


def true_value(rnd, ahead, tier):
    t = TIER.get(tier, 1.0) ** (1 / (1 + ahead))   # standing matters less far out
    return BASE[min(rnd, 5)] * 0.85 ** ahead * t


def ms(y, m, d):
    import datetime
    return int(datetime.datetime(y, m, d, tzinfo=datetime.timezone.utc).timestamp() * 1000)


def main() -> None:
    rng = random.Random(1)
    tmp = Path(tempfile.mkdtemp())
    (tmp / 'shards').mkdir()
    leagues, trades, waivers, managers = [], [], [], []
    n_leagues, teams = 120, 12
    for li in range(n_leagues):
        sf = li % 3 != 0
        fmt = {'type': 'dynasty', 'teams': teams, 'sf': sf, 'tep': 0, 'ppr': 1, 'faabBudget': 100, 'bestBall': False}
        prev = f'L{li}-{YEAR - 1}'
        owners = [f'U{li}-{r}' for r in range(1, teams + 1)]
        for season, lg in ((YEAR - 1, prev), (YEAR, f'L{li}-{YEAR}')):
            ranks = list(range(1, teams + 1))
            rng.shuffle(ranks)
            rosters = [{'rid': r, 'owner': owners[r - 1], 'w': 13 - ranks[r - 1], 'l': ranks[r - 1] - 1, 't': 0,
                        'pf': 1500.0, 'pa': 1400.0, 'maxPf': 1700.0, 'rank': ranks[r - 1], 'faabUsed': 10,
                        'moves': 5, 'players': ['1', '2'], 'starters': ['1'], 'taxi': [], 'reserve': [], 'keepers': []}
                       for r in range(1, teams + 1)]
            draft = {'draft': f'D{lg}', 'type': 'linear', 'status': 'complete', 'season': str(season), 'startTime': ms(season, 5, 1),
                     'settings': {'rounds': 4, 'teams': teams, 'player_type': 1},
                     'slotToRoster': {str(s): s for s in range(1, teams + 1)},
                     'picks': [[(rd - 1) * teams + s, rd, s, s, str(1000 + s), 0, None] for rd in range(1, 5) for s in range(1, teams + 1)]}
            leagues.append({'lg': lg, 'prev': prev if season == YEAR else None, 'season': str(season), 'status': 'complete',
                            'throughLeg': 99, 'crawledAt': '2026-10-20T00:00:00Z', 'format': fmt, 'settings': {'x': 1},
                            'scoring': {'rec': 1}, 'rosterPositions': ['QB'], 'txnCounts': {}, 'champion': 1, 'runnerUp': 2,
                            'rosters': rosters, 'matchups': [[1, 2, 3]], 'drafts': [draft]})
        rank_now = {r['rid']: r['rank'] for r in leagues[-1]['rosters']}
        for k in range(40):
            a_rid, b_rid = rng.sample(range(1, teams + 1), 2)
            created = ms(YEAR, 10, 1 + k % 28)

            def pick(owner_rid, rnd, ahead):
                return {'season': str(YEAR + 1 + ahead), 'round': rnd, 'roster_id': owner_rid}
            # Side A sends one pick; side B answers with 1-3 picks worth about the same.
            ra, aa = rng.choice([1, 1, 2, 2, 3, 4]), rng.choice([0, 0, 1, 2])
            pa = pick(a_rid, ra, aa)
            tier = lambda rid: 'E' if (rank_now[rid] - 1) / (teams - 1) >= 2 / 3 else 'L' if (rank_now[rid] - 1) / (teams - 1) < 1 / 3 else 'M'
            target = true_value(ra, aa, tier(a_rid)) * rng.lognormvariate(0, 0.08)
            best = None
            for _ in range(300):
                cand = [pick(b_rid, rng.randint(1, 5), rng.choice([0, 0, 1, 2])) for _ in range(rng.randint(1, 3))]
                tot = sum(true_value(c['round'], int(c['season']) - YEAR - 1, tier(b_rid)) for c in cand)
                if best is None or abs(tot - target) < best[0]:
                    best = (abs(tot - target), cand)
            pb = best[1]
            dp = [{**pa, 'previous_owner_id': a_rid, 'owner_id': b_rid}] + [{**c, 'previous_owner_id': b_rid, 'owner_id': a_rid} for c in pb]
            side = lambda rid, gets, gives: {'rid': rid, 'owner': owners[rid - 1],
                                             'record': {'w': 13 - rank_now[rid], 'l': rank_now[rid] - 1, 't': 0, 'pf': 0, 'pa': 0, 'rank': rank_now[rid]},
                                             'gets': {'players': [], 'picks': gets, 'faab': 0}, 'gives': {'players': [], 'picks': gives, 'faab': 0},
                                             'cut': [], 'added': []}
            trades.append({'id': f'T{li}-{k}', 'lg': f'L{li}-{YEAR}', 'season': str(YEAR), 'leg': 5, 'created': created, 'completed': created,
                           'creatorRid': a_rid, 'nSides': 2, 'format': fmt,
                           'sides': [side(a_rid, pb, [pa]), side(b_rid, [pa], pb)],
                           'raw': {'adds': None, 'drops': None, 'draft_picks': dp, 'waiver_budget': None, 'roster_ids': [a_rid, b_rid]}})
        # A swap of this season's picks before its rookie draft: both resolve
        # through the draft to the player taken in the original owner's slot.
        dp = [{'season': str(YEAR), 'round': 1, 'roster_id': 3, 'previous_owner_id': 3, 'owner_id': 4},
              {'season': str(YEAR), 'round': 1, 'roster_id': 4, 'previous_owner_id': 4, 'owner_id': 3}]
        trades.append({'id': f'R{li}', 'lg': f'L{li}-{YEAR}', 'season': str(YEAR), 'leg': 1, 'created': ms(YEAR, 3, 1),
                       'completed': ms(YEAR, 3, 1), 'creatorRid': 3, 'nSides': 2, 'format': fmt,
                       'sides': [{'rid': 3, 'owner': owners[2], 'gets': {'players': [], 'picks': [dp[1]], 'faab': 0}, 'gives': {'players': [], 'picks': [dp[0]], 'faab': 0}, 'cut': [], 'added': []},
                                 {'rid': 4, 'owner': owners[3], 'gets': {'players': [], 'picks': [dp[0]], 'faab': 0}, 'gives': {'players': [], 'picks': [dp[1]], 'faab': 0}, 'cut': [], 'added': []}],
                       'raw': {'adds': None, 'drops': None, 'draft_picks': dp, 'waiver_budget': None, 'roster_ids': [3, 4]}})
        # Player-for-player trades over a skewed pool (a few players in most
        # trades), for the audit's player activity.
        for k in range(3):
            pa_, pb_ = str(100 + int(rng.paretovariate(1.2)) % 80), str(300 + rng.randint(0, 79))
            trades.append({'id': f'Q{li}-{k}', 'lg': f'L{li}-{YEAR}', 'season': str(YEAR), 'leg': 7,
                           'created': ms(YEAR + 1, 3, 2 + k), 'completed': ms(YEAR + 1, 3, 2 + k), 'creatorRid': 1, 'nSides': 2, 'format': fmt,
                           'sides': [{'rid': 1, 'owner': owners[0], 'gets': {'players': [pb_], 'picks': [], 'faab': 0}, 'gives': {'players': [pa_], 'picks': [], 'faab': 0}, 'cut': [], 'added': []},
                                     {'rid': 2, 'owner': owners[1], 'gets': {'players': [pa_], 'picks': [], 'faab': 0}, 'gives': {'players': [pb_], 'picks': [], 'faab': 0}, 'cut': [], 'added': []}],
                           'raw': {'adds': {pa_: 2, pb_: 1}, 'drops': {pa_: 1, pb_: 2}, 'draft_picks': [], 'waiver_budget': [], 'roster_ids': [1, 2]}})
        # A player-for-player trade and some waivers, for the audit.
        trades.append({'id': f'P{li}', 'lg': f'L{li}-{YEAR}', 'season': str(YEAR), 'leg': 6, 'created': ms(YEAR, 10, 9), 'completed': ms(YEAR, 10, 9),
                       'creatorRid': 1, 'nSides': 2, 'format': fmt,
                       'sides': [{'rid': 1, 'owner': owners[0], 'gets': {'players': ['10'], 'picks': [], 'faab': 0}, 'gives': {'players': ['11'], 'picks': [], 'faab': 0}, 'cut': [], 'added': []},
                                 {'rid': 2, 'owner': owners[1], 'gets': {'players': ['11'], 'picks': [], 'faab': 0}, 'gives': {'players': ['10'], 'picks': [], 'faab': 0}, 'cut': [], 'added': []}],
                       'raw': {'adds': {'10': 1, '11': 2}, 'drops': {'10': 2, '11': 1}, 'draft_picks': [], 'waiver_budget': [], 'roster_ids': [1, 2]}})
        for k in range(20):
            waivers.append({'id': f'W{li}-{k}', 'lg': f'L{li}-{YEAR}', 'season': str(YEAR), 'leg': 3, 'type': 'waiver',
                            'status': 'complete' if k % 2 else 'failed', 'created': ms(YEAR, 9, 20), 'rid': 1, 'owner': owners[0],
                            'adds': ['20'], 'drops': [], 'bid': k, 'faabBudget': 100, 'teams': teams, 'leagueType': 'dynasty', 'sf': sf})
        managers.append({'owner': owners[0], 'season': YEAR, 'leagues': 4, 'dynasty': 2, 'keeper': 0, 'redraft': 2,
                         'bestBall': 1, 'sf': 2, 'tradesOff': 0, 'teamsAvg': 12})
    for kind, rows in (('leagues', leagues), ('trades', trades), ('waivers', waivers), ('managers', managers)):
        with gzip.open(tmp / 'shards' / f'20261020T000000-{kind}.jsonl.gz', 'wt') as f:
            for r in rows:
                f.write(json.dumps(r) + '\n')
    # A later run that sees 15 new trades made 12 hours before it started,
    # and re-sees an old one (which must not count toward the lag).
    late = [{**trades[-1], 'id': f'N{k}', 'created': ms(2026, 10, 20) + 12 * 3600 * 1000} for k in range(15)] + [trades[0]]
    with gzip.open(tmp / 'shards' / '20261021T000000-trades.jsonl.gz', 'wt') as f:
        for r in late:
            f.write(json.dumps(r) + '\n')

    fails = []

    def check(ok, msg):
        print(('  ok   ' if ok else '  FAIL ') + msg)
        if not ok:
            fails.append(msg)

    run = lambda *a: subprocess.run([sys.executable, *a], cwd=ROOT, capture_output=True, text=True)
    r = run('scripts/build-sleeper-trade-db.py', str(tmp), '--lite')
    check(r.returncode == 0, f'lite build runs {r.stderr[-300:]}')
    db = sqlite3.connect(tmp / 'sleeper-trades.sqlite')
    check(db.execute('SELECT COUNT(*) FROM waivers').fetchone()[0] == 0, 'lite build has no waivers table rows')
    check(db.execute('SELECT COUNT(*) FROM trades WHERE raw IS NOT NULL').fetchone()[0] == 0, 'lite build drops raw JSON')
    check(db.execute('SELECT COUNT(*) FROM leagues WHERE settings IS NOT NULL').fetchone()[0] == 0, 'lite build drops league settings')
    check(db.execute("SELECT COUNT(*) FROM trade_assets WHERE kind = 'pick'").fetchone()[0] > 0, 'pick assets present')
    res = db.execute("SELECT pick_round, pick_orig_rid, pick_no, pick_player_id FROM trade_assets "
                     "WHERE kind = 'pick' AND pick_status = 'resolved'").fetchall()
    check(len(res) == 2 * n_leagues and all(pid == str(1000 + orig) and no == (rnd - 1) * teams + orig for rnd, orig, no, pid in res),
          f'pre-draft picks resolve to the player in the original owner slot ({len(res)} resolved)')

    r = run('scripts/audit-trade-db.py', str(tmp), f'--out={tmp}/audit.json')
    check(r.returncode == 0, f'audit runs {r.stderr[-300:]}')
    audit = json.loads((tmp / 'audit.json').read_text())
    text = json.dumps(audit)
    check(not any(s in text for s in ('"L1-', '"U1-', '"T1-', 'W1-')), 'audit carries no league / manager / trade ids')
    check(audit['waivers']['claims'] == n_leagues * 20, 'audit streams every waiver claim')
    check(audit['shapes']['pickOnly'] == n_leagues * 41, 'audit counts pick-only trades')
    check(audit['population']['bySeason'][str(YEAR)]['leagueShare']['redraft'] == 0.5, 'population share from managers')
    check(audit['formats']['tradesByFormat'].get('dynasty sf') is not None, 'format counts present')
    pa = audit['playerActivity']
    tiers = pa.get('byRankTier', {})
    check('1-50' in tiers and tiers['1-50']['weeksFor20Trades'] is not None, f'player activity by rank tier ({list(tiers)})')
    check(pa['playersTraded'] >= 100, f"players traded counted ({pa['playersTraded']})")
    lag = audit['crawlLag']
    check(lag.get('trades') == 15 and lag['lagHours']['p50'] == 12.0, f'crawl lag from first sighting ({lag})')

    r = run('scripts/fit-pick-values.py', str(tmp), f'--out={tmp}/pv.json', '--boot=3')
    check(r.returncode == 0, f'fit runs {r.stderr[-500:]}')
    pv = json.loads((tmp / 'pv.json').read_text())
    sfmt = pv['formats']['superflex']
    cells = {(c['round'], c['ahead'], c['tier']): c for c in sfmt['global']}
    ref = true_value(1, 0, 'M')
    worst = 0.0
    for key, c in cells.items():
        if c['value'] is None or c['n'] < 150 or key[2] == 'U':
            continue
        rel = c['value'] / (100 * true_value(*key) / ref)
        worst = max(worst, abs(rel - 1))
    check(worst < 0.2, f'fit recovers well-populated classes within 20% (worst {worst:.1%})')
    check(cells[(1, 0, 'E')]['value'] > cells[(1, 0, 'M')]['value'] > cells[(1, 0, 'L')]['value'],
          f"early > mid > late firsts ({cells[(1, 0, 'E')]['value']}, 100, {cells[(1, 0, 'L')]['value']})")
    check(all('lo' in c for c in sfmt['global'] if c['n']), 'bootstrap intervals on populated classes')
    check('holdout' in sfmt and sfmt['holdout']['medianAbsLogRatio'] < sfmt['holdout']['baselineCountOnly'],
          f"holdout beats counting picks ({sfmt.get('holdout')})")
    check(not any(k in json.dumps(pv) for k in ('"L1-', '"U1-', '"T1-')), 'pick values carry no ids')
    print(f'{len(fails)} failed' if fails else 'all passed')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
