#!/usr/bin/env python3
"""Build the week's 3-pick bundles from the recorded leans, and record them.

A bundle is three of the week's leans meant to be played together as one
all-or-nothing entry. The pick log (data/pick-log.json, written by
price-lines.py --record) holds the week's leans; this picks the bundles
with the highest expected return and appends them, as one set, to
data/pick-bundles.json (committed, not deployed: like the log, it keeps the
payouts the expected return was computed at).

What a leg may be:
  - this week's lean, recorded by price-lines.py (StatHead's own or a call)
  - no guardrail flag, not voided, its game not yet kicked off
  - edge of at least --min-edge on its own (default 0.02)
  - one line per player and stat: the newest recorded
  - the player still active and off the injury report now (the latest
    weekly projections file): a lean's flags are from when it was priced,
    and a player can land on IR between then and the bundle
  - still a lean NOW: every leg is re-priced at build time (reprice()) from
    the current projections and statuses, at the payouts it was recorded
    at; a leg whose lean flipped, that picked up a guardrail flag, or whose
    edge fell under --min-edge is dropped, and the rest carry the new
    probability. A lean priced Monday is stale by Thursday when a teammate
    is ruled out in between (the Ravens' QB1, week 9 of 2026, cut Zay
    Flowers' receiving line by 15% after his overs were logged).
A bundle's three legs come from three different games, so one game script
can't sink it (legs in one game move together; across games we take them
as independent). Bundles share no leg and no player, so a set spreads its
risk instead of riding one pick five times.

Expected return of a bundle = p1 m1 x p2 m2 x p3 m3 - 1, at each leg's
recorded payout (Sleeper's own entry payout for the three is set by Sleeper
and can differ). Bundles are taken greedily by expected return: the best of
all three-game combinations, then the best of what's left, up to --max
(default 5), stopping early when the next one's expected return is under
--min-ev (default 0).

Each set is frozen once recorded: later runs add a new set for the games
still to play. bundle_results() grades a set's bundles from the legs'
results (official grading, or the board's unofficial box-score results).

Usage:
  python3 scripts/build-pick-bundles.py [--season 2026] [--week N] [--record] [--json] [--no-reprice]
"""
from __future__ import annotations

import argparse
import itertools
import json
import os
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'public', 'data')
PICK_LOG = os.path.join(ROOT, 'data', 'pick-log.json')
BUNDLE_LOG = os.path.join(ROOT, 'data', 'pick-bundles.json')

LEGS = 3
MAX_BUNDLES = 5
MIN_EDGE = 0.02
MIN_EV = 0.0


def load(path, default=None):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def leg_key(p):
    """Identifies a recorded lean: player, stat, line, side."""
    return f"{p.get('gsis') or p.get('player')}|{p['stat']}|{p['line']}|{p['lean']}"


def games_by_team(season, week):
    """team -> (game key, kickoff ISO) for the week, from the schedule."""
    sched = load(os.path.join(DATA, f'schedule-{season}.json'), {}) or {}
    games = sched.get('games', sched) if isinstance(sched, dict) else sched
    out = {}
    for g in games or []:
        if g.get('week') == week:
            key = f"{g['away']}@{g['home']}"
            out[g['home']] = out[g['away']] = (key, g.get('date'))
    return out


# Injury-report and Sleeper statuses that keep a player out of a bundle.
OUT_STATUSES = ('Questionable', 'Doubtful', 'Out', 'IR', 'PUP', 'Sus', 'NA', 'DNR')


def unavailable(season):
    """gsis ids of players who are not active or are on the injury report
    now, from the latest weekly projections file."""
    doc = load(os.path.join(DATA, f'weekly-projections-{season}.json'), {}) or {}
    out = set()
    for p in doc.get('players') or []:
        inj, slp = (p.get('inj') or {}).get('status'), (p.get('slp') or {}).get('status')
        if p.get('gsis') and (p.get('status') not in (None, 'ACT') or inj in OUT_STATUSES or slp in OUT_STATUSES):
            out.add(p['gsis'])
    return out


def candidates(picks, week, games, now, min_edge=MIN_EDGE, out=frozenset()):
    """The week's leans that may go in a bundle (see the module doc). `out`:
    gsis ids unavailable now (unavailable())."""
    newest = {}
    for p in picks:
        if p.get('week') != week or p.get('flags') or p.get('void') or not p.get('mult') or p.get('pLean') is None:
            continue
        if p.get('gsis') in out:
            continue
        if (p.get('edge') or 0) < min_edge or p.get('lean') not in ('over', 'under'):
            continue
        game, kickoff = games.get(p.get('team'), (None, None))
        if not game or not kickoff or datetime.fromisoformat(kickoff) <= now:
            continue
        k = (p.get('gsis') or p['player'], p['stat'])
        if k not in newest or (p.get('recordedAt') or '') >= (newest[k].get('recordedAt') or ''):
            newest[k] = {**p, '_game': game}
    return list(newest.values())


def ev(legs):
    out = 1.0
    for p in legs:
        out *= p['pLean'] * p['mult']
    return out - 1


def optimize(cands, max_bundles=MAX_BUNDLES, min_ev=MIN_EV):
    """Greedy: the best three-game combination by expected return, then the
    best of the legs and players left, and so on."""
    pool = sorted(cands, key=lambda p: -p['pLean'] * p['mult'])
    bundles = []
    while len(bundles) < max_bundles:
        best, best_ev = None, None
        for combo in itertools.combinations(pool, LEGS):
            if len({p['_game'] for p in combo}) < LEGS or len({p.get('gsis') or p['player'] for p in combo}) < LEGS:
                continue
            e = ev(combo)
            if best_ev is None or e > best_ev:
                best, best_ev = combo, e
        if best is None or best_ev < min_ev:
            break
        bundles.append(best)
        used = {leg_key(p) for p in best}
        players = {p.get('gsis') or p['player'] for p in best}
        pool = [p for p in pool if leg_key(p) not in used and (p.get('gsis') or p['player']) not in players]
    return bundles


def bundle_row(legs):
    p_all = 1.0
    for p in legs:
        p_all *= p['pLean']
    return {
        'legs': [{'key': leg_key(p), 'player': p['player'], 'gsis': p.get('gsis'), 'pos': p.get('pos'), 'team': p.get('team'),
                  'stat': p['stat'], 'line': p['line'], 'lean': p['lean'], 'pLean': p['pLean'], 'edge': p.get('edge'),
                  'mult': p['mult'], 'game': p['_game'], 'tag': p.get('tag')} for p in legs],
        'pAll': round(p_all, 3),
        'ev': round(ev(legs), 3),
    }


def price_spec(c, week):
    """The Pricer spec for a recorded lean, at the payouts it was recorded at."""
    return {'sleeper': str(c['sleeper']) if c.get('sleeper') else None, 'name': c['player'],
            'stat': c['stat'], 'line': c['line'], 'week': week, 'source': c.get('source') or 'sleeper',
            'multOver': c.get('multOver') or c.get('mult'), 'multUnder': c.get('multUnder') or c.get('mult')}


def no_longer_holds(c, r, min_edge=MIN_EDGE):
    """Why a recorded lean `c` no longer holds on today's price `r`, or None:
    the feed no longer prices it, the lean flipped, a guardrail flag other
    than a line move, or the edge fell under the minimum."""
    flags = [f for f in r.get('flags', []) if f.split(':')[0] != 'moved']
    return (r.get('error') or ('lean flipped' if r.get('lean') != c['lean'] else None)
            or ('flag ' + '; '.join(flags) if flags else None)
            or (f"edge {r['edge']:+.1%} now" if r['edge'] < min_edge else None))


def load_pricer(season, week, now):
    """scripts/price-lines.py's Pricer. Imported here, not at the top: the
    pick board loads this module on a runner without numpy."""
    import importlib.util
    spec = importlib.util.spec_from_file_location('price_lines', os.path.join(ROOT, 'scripts', 'price-lines.py'))
    pl = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pl)
    return pl.Pricer(season, week, now)


def reprice(cands, season, week, now, min_edge=MIN_EDGE, pricer=None):
    """Re-price each candidate with scripts/price-lines.py's Pricer on the
    current feed, at the payouts it was recorded at. Returns (kept legs with
    the new pLean / edge / pRaw, [(leg, why) dropped]). Imported here, not at
    the top: the pick board loads this module on a runner without numpy."""
    if pricer is None:
        pricer = load_pricer(season, week, now)
    kept, dropped = [], []
    for c in cands:
        r = pricer.price(price_spec(c, week))
        why = no_longer_holds(c, r, min_edge)
        if why:
            dropped.append((c, why))
            continue
        kept.append({**c, 'pLean': r['pLean'], 'pRaw': r.get('pRaw'), 'edge': r['edge'], 'mult': r['mult'],
                     'pLeanRecorded': c['pLean'], **({'qbOut': r['qbOut']} if r.get('qbOut') else {})})
    return kept, dropped


def build(season, week=None, now=None, min_edge=MIN_EDGE, max_bundles=MAX_BUNDLES, min_ev=MIN_EV, reprice_legs=True):
    now = now or datetime.now(timezone.utc)
    log = load(PICK_LOG, {}) or {}
    picks = log.get('picks', []) if isinstance(log, dict) else log
    if week is None:
        weekly = load(os.path.join(DATA, f'weekly-projections-{season}.json'), {}) or {}
        week = int(weekly.get('currentWeek') or int(weekly.get('playedThrough') or 0) + 1)
    cands = candidates(picks, week, games_by_team(season, week), now, min_edge, unavailable(season))
    dropped = []
    if reprice_legs and cands:
        cands, dropped = reprice(cands, season, week, now, min_edge)
    bundles = [bundle_row(b) for b in optimize(cands, max_bundles, min_ev)]
    return {'week': week, 'builtAt': now.isoformat(timespec='seconds'), 'candidates': len(cands), 'bundles': bundles,
            **({'dropped': [{'player': c['player'], 'stat': c['stat'], 'line': c['line'], 'lean': c['lean'], 'why': w}
                            for c, w in dropped]} if dropped else {})}


def record(bset, path=BUNDLE_LOG):
    """Append the set, unless it holds the same bundles as the week's newest
    set (a re-run with nothing new)."""
    log = load(path, None) or {'note': ('3-pick bundles built from the recorded leans by scripts/build-pick-bundles.py: '
                                        'each set is frozen when recorded; mult is each leg\'s recorded payout (input, '
                                        'not deployed). Graded from the legs\' results.'), 'sets': []}
    if not bset['bundles']:
        return False
    same_week = [s for s in log['sets'] if s.get('week') == bset['week']]
    sig = lambda s: sorted(tuple(sorted(l['key'] for l in b['legs'])) for b in s['bundles'])
    if same_week and sig(same_week[-1]) == sig(bset):
        return False
    log['sets'].append(bset)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as fh:
        json.dump(log, fh, indent=1)
        fh.write('\n')
    return True


def bundle_results(bundle, result_of):
    """A bundle's status from its legs' results. result_of(leg key) returns
    a dict with hit / push / void / actual, or None while the leg is open.
    A void or pushed leg drops out (the entry plays on with the rest, as
    pick apps do); a miss loses the bundle; all the rest hit wins it."""
    legs, open_ = [], 0
    for leg in bundle['legs']:
        r = result_of(leg['key']) or {}
        settled = r.get('hit') is not None or r.get('push') or r.get('void') or r.get('note') == 'did not play'
        if not settled:
            open_ += 1
        legs.append({**leg, **{k: r[k] for k in ('hit', 'push', 'void', 'actual', 'note', 'provisional') if k in r}})
    if any(l.get('hit') is False for l in legs):
        status = 'lost'
    elif open_:
        status = 'open'
    elif any(l.get('hit') for l in legs):
        status = 'won'
    else:
        status = 'void'
    return legs, status


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--season', type=int, default=2026)
    ap.add_argument('--week', type=int, default=None)
    ap.add_argument('--min-edge', type=float, default=MIN_EDGE)
    ap.add_argument('--max', type=int, default=MAX_BUNDLES)
    ap.add_argument('--min-ev', type=float, default=MIN_EV)
    ap.add_argument('--record', action='store_true', help='append the set to data/pick-bundles.json')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--no-reprice', action='store_true', help='use the legs as recorded, without re-pricing them now')
    args = ap.parse_args()
    bset = build(args.season, args.week, min_edge=args.min_edge, max_bundles=args.max, min_ev=args.min_ev,
                 reprice_legs=not args.no_reprice)
    if args.json:
        print(json.dumps(bset, indent=1))
    else:
        print(f"Week {bset['week']}: {len(bset['bundles'])} bundle(s) from {bset['candidates']} eligible leans")
        for d in bset.get('dropped', []):
            print(f"  dropped on re-pricing: {d['player']} {d['stat']} {d['lean']} {d['line']} ({d['why']})")
        for i, b in enumerate(bset['bundles'], 1):
            print(f"\n  Bundle {i}: all 3 hit {b['pAll']:.0%} · expected return {b['ev']:+.0%}")
            for l in b['legs']:
                print(f"    {l['player']} ({l['team']}) {l['stat']} {l['lean']} {l['line']} · {l['pLean']:.0%} · {l['game']}")
    if args.record:
        added = record(bset)
        print(f"\n{'recorded' if added else 'nothing new to record'} → {os.path.relpath(BUNDLE_LOG, ROOT)}", file=sys.stderr)


if __name__ == '__main__':
    main()
