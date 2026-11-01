#!/usr/bin/env python3
"""Track Sleeper Picks' NFL lines through the week, and keep our recorded
picks current.

Each run reads the slate (the same endpoint scripts/price-lines.py uses) and
appends one observation per line to a history file under
.cache/sleeper-lines/ (a third-party input: kept out of the repo; in CI it
lives in the Actions cache for the week). A line's path is what the book
did with information after we priced it, so the history feeds two things:

  movement on our picks   every pending pick in data/pick-log.json gains
                          lineNow / multNow / lineMove (the line against
                          the one we recorded, signed toward (+) or away
                          (-) from our lean) and a compact lineHistory;
                          the grading reports hit rate by movement.
  a flag for the pricer   price-lines.py reads the history and flags a
                          line that has moved away from our lean since it
                          was first seen (the book reacted to something).

--inactives is the post-inactives pass: pending picks whose player's
game-day call is inactive (or who is now Out / Doubtful) are voided
(void = the reason), so they grade as no bet; a position-mate going out
adds a flag. The pass runs after each slate's inactive lists post.

Usage: python3 scripts/track-lines.py [--inactives] [--slate FILE] [--season 2026]
Prints a short summary; exits 0 even when the slate is empty (off-season,
or between slates), so the hourly job never fails on a quiet hour.
"""
from __future__ import annotations

import argparse
import gzip
import importlib.util
import json
import os
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'public', 'data')
CACHE = os.path.join(ROOT, '.cache', 'sleeper-lines')
_pl = importlib.util.spec_from_file_location('pricer', os.path.join(ROOT, 'scripts', 'price-lines.py'))
pl = importlib.util.module_from_spec(_pl)
_pl.loader.exec_module(pl)
sc = pl.sc

MAX_HISTORY = 400   # observations kept per line (hourly for a week is < 200)
VOID_STATUS = ('Out', 'Doubtful', 'IR', 'PUP', 'Sus', 'inactive')


def history_path(season, week):
    return os.path.join(CACHE, f'history-{season}-w{week:02d}.json.gz')


def load_history(path):
    if os.path.exists(path):
        with gzip.open(path, 'rt') as f:
            return json.load(f)
    return {'note': 'Sleeper Picks line observations (third-party input, not committed): per line key, '
                    '[utc, line, multOver, multUnder, publicOver, picks].', 'lines': {}}


def save_history(path, hist):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with gzip.open(path, 'wt') as f:
        json.dump(hist, f)


def line_key(sleeper_id, week, stat):
    return f'{sleeper_id}|{week}|{stat}'


def observe(hist, specs, now):
    """Append this run's observation for every line in the slate; returns
    the number of lines whose number or payout changed since last seen."""
    ts = now.strftime('%Y-%m-%dT%H:%M')
    changed = 0
    for s in specs:
        k = line_key(s['sleeper'], s.get('week'), s['stat'])
        obs = [ts, s['line'], s['multOver'], s['multUnder'], s.get('publicOver'), s.get('picks')]
        seq = hist['lines'].setdefault(k, [])
        if seq and seq[-1][1:4] == obs[1:4]:
            seq[-1][4:6] = obs[4:6]       # same line and payouts: refresh the popularity only
            seq[-1][0] = seq[-1][0] if len(seq[-1]) > 6 else seq[-1][0]
            continue
        if seq:
            changed += 1
        seq.append(obs)
        del seq[:-MAX_HISTORY]
    return changed


def movement(hist, pick):
    """lineNow / multNow / lineMove for a recorded pick, from the history."""
    seq = hist['lines'].get(line_key(pick.get('sleeper'), pick.get('week'), pick.get('stat')))
    if not seq:
        return None
    ts, line, mo, mu, pub, picks = seq[-1][:6]
    sign = 1 if pick.get('lean') == 'under' else -1          # a line rising helps an under
    move = round(sign * (line - pick['line']), 1)
    mult_now = mu if pick.get('lean') == 'under' else mo
    first_seen = seq[0][1]
    return {'lineNow': line, 'multNow': mult_now, 'lineMove': move, 'lineSeenAt': ts, 'publicOverNow': pub,
            'lineFirstSeen': first_seen, 'lineHistory': [[o[0], o[1], o[2], o[3]] for o in seq[-24:]]}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--season', type=int, default=2026)
    ap.add_argument('--slate', help='a cached slate (JSON) instead of fetching')
    ap.add_argument('--inactives', action='store_true', help='post-inactives pass: void pending picks whose player is out')
    args = ap.parse_args()
    now = datetime.now(timezone.utc)
    try:
        specs, path = pl.sleeper_slate(args.season, args.slate)
    except Exception as e:  # noqa: BLE001
        print(f'slate not read ({e}); nothing tracked', file=sys.stderr)
        return
    weeks = sorted({s.get('week') for s in specs if s.get('week')})
    doc = json.load(open(os.path.join(DATA, f'weekly-projections-{args.season}.json')))
    by_sleeper = {str(p['sleeper']): p for p in doc['players'] if p.get('sleeper')}
    week_now = int(doc.get('currentWeek') or 0)
    hists = {}
    for w in weeks or [week_now]:
        hists[w] = load_history(history_path(args.season, w))
    changed = 0
    for w, h in hists.items():
        changed += observe(h, [s for s in specs if (s.get('week') or week_now) == w], now)
        save_history(history_path(args.season, w), h)
    print(f"{now.strftime('%Y-%m-%d %H:%M')} UTC: {len(specs)} NFL lines on the slate (weeks {weeks or '-'}), {changed} moved since last seen")

    # Our recorded picks: movement, and the post-inactives voiding.
    if not os.path.exists(sc.PICK_LOG):
        return
    log = json.load(open(sc.PICK_LOG))
    touched, voided, flagged = 0, 0, 0
    for p in log.get('picks', []):
        if p.get('void') or p.get('actual') is not None:
            continue
        h = hists.get(p.get('week'))
        if h:
            mv = movement(h, p)
            if mv:
                p.update(mv)
                touched += 1
        if args.inactives and p.get('sleeper') in by_sleeper:
            q = by_sleeper[p['sleeper']]
            gd = q.get('gd') if isinstance(q.get('gd'), dict) else None
            st = pl.status_for(q, p['week'])
            if (gd and gd.get('week') == p['week'] and gd.get('call') == 'inactive') or st in VOID_STATUS:
                p['void'] = f"inactive ({gd['call'] if gd and gd.get('call') else st})"
                p['voidedAt'] = now.isoformat(timespec='seconds')
                voided += 1
                continue
            mates = [m for m in doc['players'] if m.get('team') == q.get('team') and m.get('pos') == q.get('pos') and m is not q
                     and (m.get('ppg') or 0) >= 4]
            out = [f"{m['name']} {(m.get('gd') or {}).get('call') or pl.status_for(m, p['week'])}" for m in mates
                   if ((m.get('gd') or {}).get('week') == p['week'] and (m.get('gd') or {}).get('call') == 'inactive')
                   or pl.status_for(m, p['week']) in ('Out', 'Doubtful')]
            if out:
                f = 'mate-out:' + '; '.join(out)
                if f not in (p.get('flags') or []):
                    p.setdefault('flags', []).append(f)
                    flagged += 1
    json.dump(log, open(sc.PICK_LOG, 'w'), indent=1)
    moves = [p['lineMove'] for p in log.get('picks', []) if p.get('lineMove') is not None and not p.get('void')]
    toward = sum(1 for m in moves if m > 0)
    away = sum(1 for m in moves if m < 0)
    print(f"picks: {touched} pending with a current line ({toward} moved toward our lean, {away} away)"
          + (f"; post-inactives: {voided} voided, {flagged} flagged for a position-mate out" if args.inactives else ''))


if __name__ == '__main__':
    main()
