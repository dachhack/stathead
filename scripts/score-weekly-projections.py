#!/usr/bin/env python3
"""Score the weekly projections out of sample, week by week, as the season
plays out.

For every completed week this reconstructs the weekly-projections-<season>.json
that was committed last before the week's first kickoff — what the site and
the MCP showed — and scores it against actual PPR points for the players who
played, next to two references on exactly the same player-weeks:

  flat       the season line alone (ppg): isolates the matchup layer
  benchmark  an external projection set for the same week (Sleeper's; an
             input only — never shown per player, only its error)

and two naive in-season baselines (season-to-date average, last week).
It also measures the matchup layer's calibration per position — the slope
of (actual − ppg) on (projection − ppg): 1 means the projected swing is the
right size, 0 that it carries no information — and turns it into the
implied POS_MATCHUP_SCALE for scripts/build-weekly-projections.py, and
counts starters projected to play who did not and whether the snapshot had
flagged them.

Needs the repository's git history (the daily report job checks out with
fetch-depth 0). Writes a JSON the daily report reads and a markdown report.

Usage:
  python3 scripts/score-weekly-projections.py [--season 2026]
      [--json public/data/weekly-projections-accuracy.json]
      [--out public/data/weekly-projections-accuracy.md] [--no-benchmark]
Exit code is 0 unless no week could be scored.
"""
import argparse
import csv
import gzip
import json
import os
import subprocess
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'public', 'data')
CACHE = os.path.join(ROOT, '.cache')
POS = ('QB', 'RB', 'WR', 'TE')
STARTER_MIN = 8.0   # a projection a lineup would start


def git(*args):
    return subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True, check=True).stdout


def kickoffs(season):
    sched = json.load(open(os.path.join(DATA, f'schedule-{season}.json')))['games']
    first = {}
    for g in sched:
        w, d = g.get('week'), g.get('date')
        if w and d and (w not in first or d < first[w]):
            first[w] = d
    return {w: datetime.fromisoformat(d).astimezone(timezone.utc) for w, d in first.items()}


def snapshot_before(path, when):
    """(commit, committed-at) of the last commit of `path` before `when`."""
    out = git('log', '-1', '--format=%H %cI', f'--before={when.isoformat()}', '--', path).split()
    if not out:
        return None, None
    return out[0], out[1]


def load_actuals(season):
    """{(gsis, week): PPR points} for regular-season games, from the committed
    nflverse player stats."""
    path = os.path.join(DATA, f'player_stats_{season}.csv.gz')
    act = {}
    if not os.path.exists(path):
        return act
    with gzip.open(path, 'rt') as f:
        for r in csv.DictReader(f):
            if r.get('season_type', 'REG') != 'REG' or r.get('position') not in POS:
                continue
            try:
                act[(r['player_id'], int(r['week']))] = float(r.get('fantasy_points_ppr') or 0)
            except ValueError:
                continue
    return act


def load_benchmark(season, week):
    """{sleeper_id: pts_ppr} for a week, cached under .cache/. None on failure."""
    os.makedirs(CACHE, exist_ok=True)
    cache = os.path.join(CACHE, f'benchmark-proj-{season}-{week}.json')
    if os.path.exists(cache):
        raw = json.load(open(cache))
    else:
        url = (f'https://api.sleeper.app/projections/nfl/{season}/{week}?season_type=regular'
               '&position[]=QB&position[]=RB&position[]=WR&position[]=TE&order_by=pts_ppr')
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = json.loads(r.read().decode())
        except Exception as e:  # noqa: BLE001 — the benchmark is optional
            print(f'  benchmark week {week}: unavailable ({str(e)[:60]})', file=sys.stderr)
            return None
        with open(cache, 'w') as f:
            json.dump(raw, f)
    out = {}
    for e in raw:
        p = (e.get('stats') or {}).get('pts_ppr')
        if p is not None and e.get('player_id'):
            out[str(e['player_id'])] = float(p)
    return out


def status_of(x):
    return x.get('status') if isinstance(x, dict) else x


def metrics(pairs):
    if len(pairs) < 5:
        return None
    a = np.array([x for x, _ in pairs]); b = np.array([y for _, y in pairs])
    return {'n': int(len(a)), 'mae': round(float(np.mean(np.abs(a - b))), 3),
            'rmse': round(float(np.sqrt(np.mean((a - b) ** 2))), 3),
            'r': round(float(np.corrcoef(a, b)[0, 1]), 4) if a.std() > 0 and b.std() > 0 else None,
            'bias': round(float(np.mean(b - a)), 3)}


def by_method(rows, methods, pos=None, min_proj=0.0):
    """Metrics per method on the player-weeks every method covers."""
    sub = [r for r in rows if (pos is None or r['pos'] == pos) and r['ours'] >= min_proj
           and all(r.get(m) is not None for m in methods)]
    return {m: metrics([(r['act'], r[m]) for r in sub]) for m in methods}


def calibration(rows, pos=None):
    """Slope (and SE) of actual-minus-ppg on projection-minus-ppg, and the
    scale the snapshots carried, so implied = scale × slope."""
    sub = [r for r in rows if (pos is None or r['pos'] == pos) and r['flat']]
    if len(sub) < 30:
        return None
    x = np.array([r['ours'] - r['flat'] for r in sub]); y = np.array([r['act'] - r['flat'] for r in sub])
    if x.std() == 0:
        return None
    slope = float(np.cov(x, y, ddof=1)[0, 1] / x.var(ddof=1))
    resid = y - slope * x - (y.mean() - slope * x.mean())
    se = float(np.sqrt(resid.var(ddof=2) / (x.var(ddof=1) * (len(x) - 1))))
    scales = sorted({r['scale'] for r in sub})
    scale = float(np.mean([r['scale'] for r in sub]))
    return {'n': len(sub), 'slope': round(slope, 3), 'se': round(se, 3),
            'scaleInForce': round(scale, 3), 'scalesSeen': scales,
            'impliedScale': round(scale * slope, 3)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--season', type=int, default=2026)
    ap.add_argument('--json', default=None)
    ap.add_argument('--out', default=None)
    ap.add_argument('--no-benchmark', action='store_true')
    args = ap.parse_args()
    season = args.season
    path = f'public/data/weekly-projections-{season}.json'

    current = json.load(open(os.path.join(ROOT, path)))
    played_through = int(current.get('playedThrough') or 0)
    kick = kickoffs(season)
    act = load_actuals(season)
    if not act:
        # Fall back to the actuals the current file carries.
        for p in current['players']:
            if p.get('gsis') and p.get('act'):
                for i, a in enumerate(p['act']):
                    if a is not None:
                        act[(p['gsis'], i + 1)] = float(a)
    played = defaultdict(list)
    for (g, w), v in act.items():
        played[g].append((w, v))

    rows, weeks_out = [], {}
    for w in range(1, played_through + 1):
        if w not in kick:
            continue
        commit, when = snapshot_before(path, kick[w])
        if not commit:
            continue
        snap = json.loads(git('show', f'{commit}:{path}'))
        scales = snap.get('matchupScale') or {}
        bench = None if args.no_benchmark else load_benchmark(season, w)
        no_show = []
        week_rows = []
        for p in snap['players']:
            if p.get('pos') not in POS or not p.get('gsis') or not p.get('wk'):
                continue
            proj = p['wk'][w - 1]
            if proj is None:
                continue
            g = p['gsis']
            a = act.get((g, w))
            starter = (p.get('active', True) and not p.get('backup')
                       and not (p['pos'] == 'QB' and (p.get('depth') or 1) > 1))
            inj, slp, gd = status_of(p.get('inj')), status_of(p.get('slp')), status_of(p.get('gd'))
            if a is None:
                if starter and proj >= STARTER_MIN:
                    flagged = (inj in ('Out', 'Doubtful', 'IR') or slp in ('Out', 'IR', 'PUP', 'Sus', 'Doubtful')
                               or gd == 'inactive')
                    quest = inj == 'Questionable' or slp == 'Questionable'
                    no_show.append({'name': p['name'], 'pos': p['pos'], 'proj': round(proj, 1),
                                    'flag': 'out' if flagged else ('questionable' if quest else 'none')})
                continue
            prior = [v for (wk, v) in played[g] if wk < w]
            last = [v for (wk, v) in played[g] if wk == w - 1]
            week_rows.append({
                'w': w, 'pos': p['pos'], 'act': a, 'ours': float(proj), 'flat': p.get('ppg'),
                'scale': float(scales.get(p['pos'], 1.0)),
                'ytd': float(np.mean(prior)) if prior else None,
                'last': last[0] if last else None,
                'benchmark': (bench or {}).get(str(p.get('sleeper') or '')),
                'starter': starter,
            })
        rows.extend(week_rows)
        no_show.sort(key=lambda d: -d['proj'])
        weeks_out[str(w)] = {
            'commit': commit[:10], 'snapshotAt': when, 'kickoff': kick[w].isoformat(),
            'n': len(week_rows),
            'overall': by_method(week_rows, ['ours', 'flat', 'benchmark']),
            'byPos': {pos: by_method(week_rows, ['ours', 'flat', 'benchmark'], pos) for pos in POS},
            'starters': by_method(week_rows, ['ours', 'flat', 'benchmark'], min_proj=STARTER_MIN),
            'noShowStarters': {'count': len(no_show), 'points': round(sum(d['proj'] for d in no_show), 1),
                               'flaggedOut': sum(1 for d in no_show if d['flag'] == 'out'),
                               'questionable': sum(1 for d in no_show if d['flag'] == 'questionable'),
                               'unflagged': sum(1 for d in no_show if d['flag'] == 'none'),
                               'top': no_show[:6]},
        }

    if not rows:
        print('nothing to score (no completed week with a snapshot)', file=sys.stderr)
        return 1

    methods = ['ours', 'flat', 'benchmark']
    inseason = [r for r in rows if r['w'] >= 2 and r['ytd'] is not None]
    out = {
        'season': season,
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'scoredThrough': played_through,
        'weeksScored': sorted(int(k) for k in weeks_out),
        'playerWeeks': len(rows),
        'note': ('Out-of-sample: each week scored on the weekly-projections file committed last before its first '
                 'kickoff, against actual PPR for players who played. Methods are compared on the same player-weeks. '
                 'flat = season line only (no matchup layer); benchmark = an external projection set\'s error on '
                 'the same rows (its projections are an input and are not published). calibration.slope = how '
                 'much of the projected matchup swing showed up (1 = right size); impliedScale = the per-position '
                 'POS_MATCHUP_SCALE the data asks for. noShowStarters = players projected ≥ '
                 f'{STARTER_MIN:.0f} as active starters who did not play.'),
        'cumulative': {
            'overall': by_method(rows, methods),
            'byPos': {pos: by_method(rows, methods, pos) for pos in POS},
            'starters': by_method(rows, methods, min_proj=STARTER_MIN),
            'startersByPos': {pos: by_method(rows, methods, pos, min_proj=STARTER_MIN) for pos in POS},
            'inSeasonBaselines': by_method(inseason, ['ours', 'flat', 'ytd', 'last', 'benchmark']),
        },
        'calibration': {'overall': calibration(rows), **{pos: calibration(rows, pos) for pos in POS}},
        'weeks': weeks_out,
    }

    md = render_md(out)
    if args.json:
        with open(os.path.join(ROOT, args.json), 'w') as f:
            json.dump(out, f, indent=1)
    if args.out:
        with open(os.path.join(ROOT, args.out), 'w') as f:
            f.write(md)
    else:
        print(md)
    return 0


def _row(label, m):
    if not m:
        return f'| {label} | — | — | — | — | — |'
    return (f"| {label} | {m['n']} | {m['mae']:.2f} | {m['rmse']:.2f} | "
            f"{m['r'] if m['r'] is not None else '—'} | {m['bias']:+.2f} |")


def render_md(out):
    c = out['cumulative']
    L = [f"# Weekly projection accuracy — {out['season']}, weeks 1–{out['scoredThrough']}", '',
         f"_{out['playerWeeks']} player-weeks scored out of sample; generated {out['generatedAt'][:16]}_", '',
         '## All players who played', '', '| method | n | MAE | RMSE | r | bias |', '|---|---|---|---|---|---|']
    for m, label in (('ours', 'StatHead (published)'), ('flat', 'season line only'), ('benchmark', 'external benchmark')):
        L.append(_row(label, c['overall'].get(m)))
    L += ['', '## By position (MAE / r): StatHead vs season line vs benchmark', '',
          '| pos | n | StatHead | season line | benchmark |', '|---|---|---|---|---|']
    for pos in POS:
        b = c['byPos'][pos]
        f = lambda m: f"{m['mae']:.2f} / {m['r']}" if m else '—'
        n = (b.get('ours') or {}).get('n', 0)
        L.append(f"| {pos} | {n} | {f(b.get('ours'))} | {f(b.get('flat'))} | {f(b.get('benchmark'))} |")
    L += ['', f"## Starters (projected ≥ {STARTER_MIN:.0f})", '', '| method | n | MAE | RMSE | r | bias |', '|---|---|---|---|---|---|']
    for m, label in (('ours', 'StatHead'), ('flat', 'season line only'), ('benchmark', 'external benchmark')):
        L.append(_row(label, c['starters'].get(m)))
    ib = c['inSeasonBaselines']
    if ib.get('ytd'):
        L += ['', '## Against naive in-season baselines (weeks 2+, players with a prior game)', '',
              '| method | n | MAE | RMSE | r | bias |', '|---|---|---|---|---|---|']
        for m, label in (('ours', 'StatHead'), ('flat', 'season line only'), ('ytd', 'season-to-date average'),
                         ('last', 'last week'), ('benchmark', 'external benchmark')):
            L.append(_row(label, ib.get(m)))
    L += ['', '## Matchup layer calibration', '',
          'Slope of (actual − season line) on (projection − season line): 1 = the projected swing is the right '
          'size, 0 = no information. impliedScale = scale in force × slope — what POS_MATCHUP_SCALE should be.', '',
          '| pos | n | slope | ± se | scale in force | implied scale |', '|---|---|---|---|---|---|']
    for pos in ('overall',) + POS:
        k = out['calibration'].get(pos)
        if k:
            L.append(f"| {pos} | {k['n']} | {k['slope']:+.2f} | {k['se']:.2f} | {k['scaleInForce']:.2f} | {k['impliedScale']:.2f} |")
    L += ['', '## Week by week', '', '| week | snapshot | n | MAE | r | benchmark MAE | starters who did not play (flagged out / questionable / unflagged) |',
          '|---|---|---|---|---|---|---|']
    for w, e in out['weeks'].items():
        o, b, ns = e['overall'].get('ours') or {}, e['overall'].get('benchmark') or {}, e['noShowStarters']
        L.append(f"| {w} | {e['snapshotAt'][:16]} | {e['n']} | {o.get('mae', '—')} | {o.get('r', '—')} | "
                 f"{b.get('mae', '—')} | {ns['count']} ({ns['points']:.0f} pts): {ns['flaggedOut']} / "
                 f"{ns['questionable']} / {ns['unflagged']} |")
    last = out['weeks'][str(out['weeksScored'][-1])]['noShowStarters']['top']
    if last:
        L += ['', f"Latest week's biggest no-shows: " + ', '.join(f"{d['name']} ({d['pos']}, {d['proj']}, {d['flag']})" for d in last)]
    return '\n'.join(L) + '\n'


if __name__ == '__main__':
    sys.exit(main())
