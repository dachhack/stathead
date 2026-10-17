#!/usr/bin/env python3
"""Offline test for scripts/crawl-yahoo-trades.py.

Fakes the Yahoo Fantasy API (responses in Yahoo's list-of-fragments JSON),
runs the crawler end to end into a temp dir, builds the SQLite database with
scripts/build-sleeper-trade-db.py and checks the rows.

Run: python3 scripts/test-yahoo-trade-crawler.py
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('cyt', HERE / 'crawl-yahoo-trades.py')
cyt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cyt)

passed, failures = 0, []


def check(name, cond, detail=None):
    global passed
    if cond:
        passed += 1
    else:
        failures.append(f'{name} — got {detail!r}' if detail is not None else name)


def fc(league):  # wrap like Yahoo
    return {'fantasy_content': {'league': league}}


def team(n, gk, lid, guid, rank, w, l, pf):
    return {'team': [
        [{'team_key': f'{gk}.l.{lid}.t.{n}'}, {'team_id': str(n)}, {'name': f'Team Name {n}'},
         {'faab_balance': str(100 - n * 5)}, {'number_of_moves': 9}, {'number_of_trades': 1},
         {'managers': [{'manager': {'manager_id': str(n), 'nickname': f'Nick{n}', 'guid': guid}}]}],
        {'team_standings': {'rank': str(rank), 'outcome_totals': {'wins': w, 'losses': l, 'ties': 0},
                            'points_for': str(pf), 'points_against': '1000'}},
    ]}


def league_doc(gk, lid, renew=None, keeper=False, rounds=15):
    meta = [{'league_key': f'{gk}.l.{lid}'}, {'league_id': str(lid)}, {'name': 'Secret Yahoo League'},
            {'num_teams': 2}, {'season': {'470': '2026', '461': '2025'}[gk]}, {'is_finished': 1 if gk == '461' else 0},
            {'current_week': 7}, {'scoring_type': 'head'}, {'league_type': 'public'}]
    if renew:
        meta.append({'renew': renew})
    settings = [{'draft_type': 'live'}, {'uses_faab': '1'}, {'can_trade_draft_picks': '1'},
                {'num_playoff_teams': '2'}, {'playoff_start_week': '15'}, {'trade_end_date': '2026-11-21'},
                {'roster_positions': [{'roster_position': {'position': p, 'count': c}} for p, c in
                                      [('QB', 1), ('WR', 2), ('RB', 2), ('TE', 1), ('W/R/T', 1), ('Q/W/R/T', 1), ('BN', 7), ('IR', 1)]]},
                {'stat_modifiers': {'stats': [{'stat': {'stat_id': 11, 'value': '0.5'}}, {'stat': {'stat_id': 5, 'value': '6'}}]}}]
    picks = {str(i): {'draft_result': {'pick': i + 1, 'round': i // 2 + 1, 'team_key': f'{gk}.l.{lid}.t.{i % 2 + 1}',
                                        'player_key': f'{gk}.p.{30000 + i}', 'is_keeper': 1 if keeper else 0}}
             for i in range(rounds * 2)}
    picks['count'] = rounds * 2
    return fc([meta, {'settings': settings},
               {'standings': [{'teams': {'0': team(1, gk, lid, 'GUID-A', 1, 5, 1, 900), '1': team(2, gk, lid, 'GUID-B', 2, 1, 5, 700), 'count': 2}}]},
               {'draft_results': picks}])


def player(pid, name, typ, src=None, dst=None):
    td = {'type': typ}
    if src:
        td['source_team_key'] = src
    if dst:
        td['destination_team_key'] = dst
    return {'player': [[{'player_key': f'470.p.{pid}'}, {'player_id': str(pid)}, {'name': {'full': name}},
                        {'display_position': 'WR'}], {'transaction_data': [td]}]}


def tx_doc(gk, lid):
    t = lambda n: f'{gk}.l.{lid}.t.{n}'
    trade = {'transaction': [
        {'transaction_key': f'{gk}.l.{lid}.tr.1', 'type': 'trade', 'status': 'successful', 'timestamp': '1790000000',
         'trader_team_key': t(1), 'tradee_team_key': t(2),
         'picks': [{'pick': {'source_team_key': t(1), 'destination_team_key': t(2), 'original_team_key': t(1), 'round': '3'}}]},
        {'players': {'0': player(100, 'Known Player', 'trade', t(1), t(2)),
                     '1': player(200, 'Unmapped Guy', 'trade', t(2), t(1)), 'count': 2}},
    ]}
    faab = {'transaction': [
        {'transaction_key': f'{gk}.l.{lid}.tr.2', 'type': 'add/drop', 'status': 'successful', 'timestamp': '1790000500', 'faab_bid': '17'},
        {'players': {'0': player(300, 'Waiver Pickup', 'add', None, t(1)), '1': player(301, 'Cut Guy', 'drop', t(1), None), 'count': 2}},
    ]}
    vetoed = {'transaction': [{'transaction_key': f'{gk}.l.{lid}.tr.3', 'type': 'trade', 'status': 'vetoed'}, {'players': {'count': 0}}]}
    return fc([[{'league_key': f'{gk}.l.{lid}'}], {'transactions': {'0': trade, '1': faab, '2': vetoed, 'count': 3}}])


# 2026 leagues the app can read: 7 is renewed from 2025 league 55 and runs a
# 4-round draft on a 16-spot roster (dynasty); 9 is a plain redraft league.
PUBLIC = {('470', 7): dict(renew='461_55', rounds=4), ('470', 9): dict()}
HISTORY = {('461', 55): dict(rounds=15)}


THROTTLED: dict[int, int] = {}


def fake_get(self, path):
    self.requests += 1
    if path.startswith('/games'):
        return 200, {'fantasy_content': {'games': {'0': {'game': [{'game_key': '470', 'season': '2026'}]},
                                                   '1': {'game': [{'game_key': '461', 'season': '2025'}]}, 'count': 2}}}
    if path.startswith('/leagues;league_keys='):
        # Real Yahoo: one private league in the batch refuses the whole batch.
        return 401, 'You must be logged in to view this league.'
    if ';out=' in path:   # real Yahoo: the combined call 500s
        return 500, 'Internal Server Error'
    m = re.match(r'/league/(\d+)\.l\.(\d+)(?:/(settings|standings|draftresults))?$', path)
    if m:
        gk, lid, part = m.group(1), int(m.group(2)), m.group(3)
        cfg = PUBLIC.get((gk, lid), HISTORY.get((gk, lid)))
        if lid == 13:   # an id Yahoo answers with its 'temporary problem' 400 every time
            return 400, 'There was a temporary problem with the server. Please try again shortly.'
        if lid == 21:   # an id whose plain request 500s every time
            return 500, 'Internal Server Error'
        if cfg is None:
            return 401, 'You must be logged in to view this league.'
        full = league_doc(gk, lid, **cfg)['fantasy_content']['league']
        if part is None:
            return 200, fc([full[0]])
        key = {'settings': 'settings', 'standings': 'standings', 'draftresults': 'draft_results'}[part]
        return 200, fc([full[0]] + [x for x in full[1:] if key in x])
    m = re.match(r'/league/(\d+)\.l\.(\d+)/transactions;types=add,trade;start=(\d+)', path)
    if m:
        gk, lid, start = m.group(1), int(m.group(2)), int(m.group(3))
        THROTTLED[lid] = THROTTLED.get(lid, 0) + 1
        if lid == 9 and THROTTLED[lid] == 1:   # throttled once, then fine
            return 429, 'rate limited'
        return 200, tx_doc(gk, lid) if start == 0 else fc([[{}], {'transactions': {'count': 0}}])
    return 404, 'unexpected ' + path


def main():
    cyt.probe.Client.get = fake_get
    cyt.time.sleep = lambda s: None   # backoffs are instant here
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp) / 'y'
        os.environ.update(YAHOO_CLIENT_ID='x', YAHOO_CLIENT_SECRET='y', SLEEPER_CRAWL_SALT='s')
        sys.argv = ['crawl', f'--dir={d}', '--seasons=2026,2025', '--max-id=30', '--rpm=100000']
        cyt.main()
        st = cyt.load_state(d, 's')
        check('cursor walked to max-id', st['cursor'].get('2026') == 31, st['cursor'])
        check('history league crawled through renew', '461.l.55' in st['done'], list(st['done']))
        check('three league-seasons', len(st['done']) == 3, st['done'])
        check('batch refusal remembered', st['batchOk'] is False, st['batchOk'])
        check('throttled league retried in place, not lost', '470.l.9' in st['done'] and THROTTLED[9] == 2, THROTTLED)
        check('nothing left to retry', st['retry'] == {}, st['retry'])
        check('a request that always 500s is skipped, not waited on', '470.l.21' not in st['done'])

        out = subprocess.run([sys.executable, str(HERE / 'build-sleeper-trade-db.py'), str(d)], capture_output=True, text=True)
        check('builder ran', out.returncode == 0, out.stderr[-500:])
        db = sqlite3.connect(d / 'sleeper-trades.sqlite')
        q = lambda sql: db.execute(sql).fetchall()

        check('one successful trade per league; the vetoed one skipped', q('select count(*) from trades') == [(3,)], q('select count(*) from trades'))
        lg7 = q("select type, sf, ppr, pass_td, faab_budget, teams, superflex from leagues where season=2026 and prev is not null")
        check('renewed + short draft = dynasty; superflex, half PPR, 6pt TD, FAAB', lg7 == [('dynasty', 1, 0.5, 6.0, 100, 2, 1)], lg7)
        lg9 = q("select type from leagues where season=2026 and prev is null")
        check('no renew, full draft = redraft', lg9 == [('redraft',)], lg9)
        lineage = q("select count(distinct lineage) from leagues")
        check('2026 league joins its 2025 season in one lineage', lineage == [(2,)], lineage)

        assets = q("select kind, from_rid, to_rid, player_id, pick_round, pick_orig_rid, pick_status from trade_assets order by kind, player_id")
        check('pick asset: round 3, original team 1, 1 → 2', ('pick', 1, 2, None, 3, 1, 'yahoo_no_season') in assets, assets)
        check('unmapped Yahoo player kept with a y: id', any(a[3] == 'y:200' and a[1] == 2 and a[2] == 1 for a in assets), assets)
        names = dict(q("select player_id, name from players where player_id like 'y:%'"))
        check('unmapped player named from the players shard', names.get('y:200') == 'Unmapped Guy', names)

        sides = q("select rid, w, l, final_rank, prev_rank from trade_sides order by trade_id, rid")
        check('final rank and last season\'s rank on the sides', (1, None, None, 1, 1) in sides, sides)
        w = q("select bid, player_id, status, faab_budget from waivers")
        check('FAAB add with its bid', ('17' == str(w[0][0]) and w[0][1] == 'y:300') if w else False, w)

        import gzip as gz
        text = ''.join(gz.decompress(p.read_bytes()).decode() for p in (d / 'shards').glob('*.gz'))
        # Player names are public; league, team and manager names and ids are not.
        for secret in ('Secret Yahoo League', 'Team Name', 'Nick1', 'GUID-A', '470.l.7', '461.l.55'):
            check(f'shards never hold {secret}', secret not in text)

    print(f'\n{passed} passed, {len(failures)} failed')
    for f in failures:
        print(f'  ✗ {f}')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
