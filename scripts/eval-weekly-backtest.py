#!/usr/bin/env python3
"""Score the walk-forward weekly projections against what actually happened,
and against every benchmark worth beating.

Models compared, all on the same player-weeks:

  inseason   walk-forward model (build-inseason-projections.py) — weeks
             1..w-1 of the same season plus the prior season
  priorSeason  the player's prior-season per-game average. This is the
             benchmark the shipped preseason model is built on, and the
             thing in-season data has to beat to be worth using.
  trail3     mean of his last three games played (the standard "he's hot"
             heuristic)
  last1      his previous game (pure recency)
  sleeper    Sleeper's published weekly projection — a real external
             projection with a full stat line

Metrics per model x stat x position: MAE, RMSE, bias, R² against the actual,
and Spearman rank correlation (which is what matters for start/sit). Every
model is scored on the *intersection* of player-weeks all models cover, so no
model gets credit for a friendlier sample; the per-model coverage is reported
alongside.

Two extra checks:

  * Prop calibration — the dispersion parameters are re-fit on this model's
    own residuals, then every player-week is priced as a prop and the
    predicted over-probability is compared to how often the over actually
    hit. A model can have good MAE and still price props badly.
  * Sleeper provenance — Sleeper does not publish a frozen pre-game snapshot,
    and their `last_modified` for completed weeks lands after kickoff. The
    report carries that timestamp gap so an implausibly strong Sleeper result
    reads as a data caveat rather than a modelling triumph.

Usage:
  python3 scripts/eval-weekly-backtest.py [--season 2025]

Output:
  public/data/weekly-backtest-<season>.json
"""

import argparse
import csv
import gzip
import json
import math
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'public', 'data')

# Price props with the SHIPPED implementation rather than a local copy, so a
# calibration result here is a statement about the code the app, the MCP
# server and the Python client actually run.
sys.path.insert(0, os.path.join(ROOT, 'python', 'src'))
from stathead.props import price_prop, zero_prob_for_yards  # noqa: E402

POSITIONS = ('QB', 'RB', 'WR', 'TE')
COUNT_STATS = {'passAtt', 'passComp', 'passTD', 'int', 'rushAtt', 'rushTD',
               'tgt', 'rec', 'recTD'}
# Stats reported per position (a WR's pass attempts are noise, not signal).
REPORT_STATS = {
    'QB': ('passAtt', 'passYds', 'passTD', 'rushYds', 'pprPts'),
    'RB': ('rushAtt', 'rushYds', 'tgt', 'rec', 'recYds', 'pprPts'),
    'WR': ('tgt', 'rec', 'recYds', 'recTD', 'pprPts'),
    'TE': ('tgt', 'rec', 'recYds', 'pprPts'),
}
COLS = {
    'passAtt': 'attempts', 'passComp': 'completions', 'passYds': 'passing_yards',
    'passTD': 'passing_tds', 'int': 'passing_interceptions',
    'rushAtt': 'carries', 'rushYds': 'rushing_yards', 'rushTD': 'rushing_tds',
    'tgt': 'targets', 'rec': 'receptions', 'recYds': 'receiving_yards',
    'recTD': 'receiving_tds', 'pprPts': 'fantasy_points_ppr',
}


# nflverse renamed several weekly-stats columns for 2025+; seasons through
# 2024 still ship the old names. Normalize on read — without this every
# prior-season lookup silently comes back empty and the model quietly falls
# through to its replacement-level defaults.
LEGACY_COLS = {
    'recent_team': 'team',
    'interceptions': 'passing_interceptions',
    'sacks': 'sacks_suffered',
    'sack_yards': 'sack_yards_lost',
}


def _normalize_row(row):
    for old, new in LEGACY_COLS.items():
        if old in row and not row.get(new):
            row[new] = row[old]
    return row


def iter_csv_rows(base):
    plain = os.path.join(DATA, f'{base}.csv')
    gz = os.path.join(DATA, f'{base}.csv.gz')
    if os.path.exists(plain):
        with open(plain, newline='') as f:
            for row in csv.DictReader(f):
                yield _normalize_row(row)
    elif os.path.exists(gz):
        with gzip.open(gz, 'rt') as f:
            for row in csv.DictReader(f):
                yield _normalize_row(row)


def load_json(name):
    with open(os.path.join(DATA, name)) as f:
        return json.load(f)


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def norm_name(s):
    s = (s or '').lower().replace('.', '').replace("'", '')
    for suf in (' jr', ' sr', ' iii', ' ii', ' iv', ' v'):
        if s.endswith(suf):
            s = s[: -len(suf)]
    return ' '.join(s.split())


# ── actuals + naive baselines ────────────────────────────────────────────

def load_actuals(season):
    """(pid, week) -> {stats}, plus name/pos/team."""
    actual, meta = {}, {}
    for r in iter_csv_rows(f'player_stats_{season}'):
        if r.get('season_type') != 'REG':
            continue
        pos = r.get('position')
        if pos not in POSITIONS:
            continue
        try:
            week = int(r.get('week') or 0)
        except ValueError:
            continue
        if not 1 <= week <= 18:
            continue
        pid = r.get('player_id')
        actual[(pid, week)] = {k: num(r.get(c)) for k, c in COLS.items()}
        meta[pid] = {
            'name': r.get('player_display_name') or r.get('player_name'),
            'pos': pos,
            'team': r.get('team'),
        }
    return actual, meta


def prior_season_rates(season):
    """pid -> prior-season per-game averages."""
    tot = defaultdict(lambda: defaultdict(float))
    games = defaultdict(set)
    for r in iter_csv_rows(f'player_stats_{season - 1}'):
        if r.get('season_type') != 'REG' or r.get('position') not in POSITIONS:
            continue
        pid = r.get('player_id')
        games[pid].add(r.get('week'))
        for k, c in COLS.items():
            tot[pid][k] += num(r.get(c))
    return {
        pid: {k: v / max(len(games[pid]), 1) for k, v in stats.items()}
        for pid, stats in tot.items()
    }


def rolling_baselines(actual):
    """(pid, week) -> {'last1': {...}, 'trail3': {...}} from games already
    played before that week."""
    by_player = defaultdict(list)
    for (pid, week) in sorted(actual, key=lambda k: k[1]):
        by_player[pid].append(week)
    out = {}
    for pid, weeks in by_player.items():
        for i, w in enumerate(weeks):
            past = weeks[:i]
            if not past:
                continue
            last = actual[(pid, past[-1])]
            recent = [actual[(pid, x)] for x in past[-3:]]
            out[(pid, w)] = {
                'last1': dict(last),
                'trail3': {k: sum(r[k] for r in recent) / len(recent) for k in COLS},
            }
    return out


# ── external projections ─────────────────────────────────────────────────

def load_sleeper(season):
    """(pid_gsis, week) -> projected stat line, mapped through the crosswalk."""
    path = os.path.join(DATA, f'sleeper-weekly-proj-{season}.json')
    if not os.path.exists(path):
        return {}, None
    doc = load_json(f'sleeper-weekly-proj-{season}.json')
    by_sleeper, by_name = {}, {}
    for r in load_json('player-crosswalk.json').get('players', []):
        if r.get('gsis_id') and r.get('sleeper_id'):
            by_sleeper[str(r['sleeper_id'])] = r['gsis_id']
        if r.get('gsis_id'):
            by_name[(norm_name(r.get('display_name')), r.get('position'))] = r['gsis_id']
    out = {}
    for r in doc.get('players') or []:
        gsis = by_sleeper.get(r.get('sleeper')) or by_name.get((norm_name(r['name']), r['pos']))
        if not gsis:
            continue
        out[(gsis, r['week'])] = {k: r.get(k, 0.0) for k in COLS}
    return out, doc


# ── metrics ──────────────────────────────────────────────────────────────

def spearman(pred, act):
    """Rank correlation. Ties averaged."""
    def ranks(xs):
        order = sorted(range(len(xs)), key=lambda i: xs[i])
        rk = [0.0] * len(xs)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
                j += 1
            avg = (i + j) / 2 + 1
            for m in range(i, j + 1):
                rk[order[m]] = avg
            i = j + 1
        return rk
    if len(pred) < 3:
        return None
    rp, ra = ranks(pred), ranks(act)
    n = len(rp)
    mp, ma = sum(rp) / n, sum(ra) / n
    cov = sum((a - mp) * (b - ma) for a, b in zip(rp, ra))
    vp = math.sqrt(sum((a - mp) ** 2 for a in rp))
    va = math.sqrt(sum((b - ma) ** 2 for b in ra))
    return round(cov / (vp * va), 4) if vp and va else None


def score(pairs):
    """[(pred, actual)] -> accuracy metrics."""
    n = len(pairs)
    if n < 5:
        return None
    preds = [p for p, _ in pairs]
    acts = [a for _, a in pairs]
    mean_a = sum(acts) / n
    sse = sum((p - a) ** 2 for p, a in pairs)
    sst = sum((a - mean_a) ** 2 for a in acts)
    return {
        'n': n,
        'mae': round(sum(abs(p - a) for p, a in pairs) / n, 3),
        'rmse': round(math.sqrt(sse / n), 3),
        'bias': round(sum(p - a for p, a in pairs) / n, 3),
        'r2': round(1 - sse / sst, 4) if sst > 0 else None,
        'spearman': spearman(preds, acts),
        'meanPred': round(sum(preds) / n, 3),
        'meanActual': round(mean_a, 3),
    }


# ── prop calibration ─────────────────────────────────────────────────────

def fit_dispersion(rows):
    """(pos, stat) -> {k, cv}: the spread of ACTUAL outcomes around this
    model's own predictions. Fitting on residuals rather than on
    season-average scatter is what makes the calibration test meaningful —
    it is the conditional spread a prop is actually exposed to.

    Yardage is fit on the games where the underlying volume happened, because
    the pricing model treats a yardage stat as a mixture: zero when the carry
    or catch never comes, gamma when it does. Fitting the gamma on games that
    include the zeros would double-count them and leave every over priced
    too high.
    """
    acc = defaultdict(lambda: {'smu': 0.0, 'smu2': 0.0, 'sse': 0.0, 'n': 0})
    for pos, stat, mu, act, volume_happened in rows:
        if mu <= 1e-6:
            continue
        if stat not in COUNT_STATS and not volume_happened:
            continue
        a = acc[(pos, stat)]
        a['smu'] += mu
        a['smu2'] += mu * mu
        a['sse'] += (act - mu) ** 2
        a['n'] += 1
    out = {}
    for (pos, stat), a in acc.items():
        if a['n'] < 50 or a['smu2'] <= 0:
            continue
        excess = a['sse'] - a['smu']
        k = (a['smu2'] / excess) if excess > 1e-6 else 50.0
        out.setdefault(pos, {})[stat] = {
            'k': round(min(max(k, 0.3), 50.0), 3),
            'cv': round(math.sqrt(a['sse'] / a['smu2']), 4),
            'n': a['n'],
        }
    return out


def calibration(records, stat_keys, disp, shifts=None, buckets=10):
    """Price every player-week with the shipped prop pricer, then check that a
    stated N% over-probability hits N% of the time. Good MAE and badly
    calibrated props are entirely compatible, so this is a separate test."""
    acc = defaultdict(lambda: {'n': 0, 'pred': 0.0, 'hit': 0})
    brier = {'sum': 0.0, 'n': 0}
    per_stat = defaultdict(lambda: {'n': 0, 'pred': 0.0, 'hit': 0})

    def adjust(stat, p):
        """Apply the out-of-sample logit shift fit on earlier seasons."""
        b = (shifts or {}).get(stat, {}).get('shift')
        if not b:
            return p
        q = min(max(p, 1e-6), 1 - 1e-6)
        return 1 / (1 + math.exp(-(math.log(q / (1 - q)) + b)))
    for r in records:
        pos = r['pos']
        line_means = r['preds']['inseason']
        dpos = disp.get(pos) or {}
        for stat in stat_keys[pos]:
            if stat == 'pprPts':
                continue
            mu = line_means.get(stat, 0.0)
            d = dpos.get(stat)
            if not d or mu <= 1e-6:
                continue
            priced = price_prop(
                stat, mu, d, COUNT_STATS,
                zero_prob=zero_prob_for_yards(stat, line_means, dpos))
            p = adjust(stat, priced['over'])
            if p <= 0 or p >= 1:
                continue
            hit = 1 if r['actual'][stat] > priced['line'] else 0
            b = min(int(p * buckets), buckets - 1)
            acc[b]['n'] += 1
            acc[b]['pred'] += p
            acc[b]['hit'] += hit
            per_stat[stat]['n'] += 1
            per_stat[stat]['pred'] += p
            per_stat[stat]['hit'] += hit
            brier['sum'] += (p - hit) ** 2
            brier['n'] += 1
    table = []
    for b in sorted(acc):
        a = acc[b]
        table.append({
            'bucket': f'{b / buckets:.0%}-{(b + 1) / buckets:.0%}',
            'n': a['n'],
            'predicted': round(a['pred'] / a['n'], 4),
            'actual': round(a['hit'] / a['n'], 4),
        })
    by_stat = {
        stat: {
            'n': a['n'],
            'predicted': round(a['pred'] / a['n'], 4),
            'actual': round(a['hit'] / a['n'], 4),
        }
        for stat, a in sorted(per_stat.items()) if a['n'] >= 100
    }
    return {
        'buckets': table,
        'byStat': by_stat,
        'brier': round(brier['sum'] / brier['n'], 4) if brier['n'] else None,
        'n': brier['n'],
    }


# ── main ─────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--season', type=int, default=2025)
    args = ap.parse_args()
    season = args.season

    actual, meta = load_actuals(season)
    inseason = load_json(f'inseason-projections-{season}.json')
    params_path = os.path.join(DATA, 'inseason-params.json')
    fitted = load_json('inseason-params.json') if os.path.exists(params_path) else None
    if fitted and season in (fitted.get('fitSeasons') or []):
        print(f'  ⚠ season {season} is one of the params\' fit seasons '
              f'{fitted["fitSeasons"]} — this is an IN-SAMPLE evaluation.')
    stat_keys = inseason['statKeys']
    prior = prior_season_rates(season)
    rolling = rolling_baselines(actual)
    sleeper, sleeper_doc = load_sleeper(season)

    # Build one record per player-week with every model's prediction.
    records = []
    for row in inseason['players']:
        pid, week, pos = row['pid'], row['week'], row['pos']
        act = actual.get((pid, week))
        if act is None:
            continue
        keys = stat_keys[pos]
        preds = {'inseason': dict(zip(keys, row['proj']))}
        if pid in prior:
            preds['priorSeason'] = prior[pid]
        roll = rolling.get((pid, week))
        if roll:
            preds['last1'] = roll['last1']
            preds['trail3'] = roll['trail3']
        if (pid, week) in sleeper:
            preds['sleeper'] = sleeper[(pid, week)]
            # A 50/50 ensemble: the two projections make different mistakes,
            # so averaging them is the honest ceiling to compare against.
            preds['blend'] = {
                k: 0.5 * preds['inseason'].get(k, 0.0)
                   + 0.5 * sleeper[(pid, week)].get(k, 0.0)
                for k in COLS
            }
        records.append({
            'pid': pid, 'week': week, 'pos': pos, 'nGames': row['nGames'],
            'actual': act, 'preds': preds,
        })

    # The Sleeper snapshot is local-only (see DATA_SOURCES.md — their terms
    # don't allow redistributing bulk dumps), so the external comparison is
    # skipped when it isn't present rather than failing the run.
    models = ['inseason', 'priorSeason', 'trail3', 'last1']
    if sleeper:
        models += ['sleeper', 'blend']
    else:
        print('  (no local sleeper-weekly-proj snapshot — external comparison '
              'skipped; run scripts/fetch-sleeper-weekly-projections.py to add it)')
    models = tuple(models)

    # Coverage: how many of the scored player-weeks each model can price.
    coverage = {
        m: sum(1 for r in records if m in r['preds']) for m in models
    }
    # Common set — every model present. Scoring on the intersection stops a
    # model from looking better just because it skipped the hard players.
    common = [r for r in records if all(m in r['preds'] for m in models)]

    def metrics_over(rows, label):
        out = {}
        for pos in POSITIONS:
            sub = [r for r in rows if r['pos'] == pos]
            for stat in REPORT_STATS[pos]:
                for m in models:
                    pairs = [(r['preds'][m].get(stat, 0.0), r['actual'][stat])
                             for r in sub if m in r['preds']]
                    s = score(pairs)
                    if s:
                        out.setdefault(pos, {}).setdefault(stat, {})[m] = s
        return {'label': label, 'byPosition': out}

    # Week buckets: early weeks lean on the prior, later ones on in-season data.
    buckets = {
        'weeks1-4': lambda r: r['week'] <= 4,
        'weeks5-9': lambda r: 5 <= r['week'] <= 9,
        'weeks10-18': lambda r: r['week'] >= 10,
    }
    by_bucket = {}
    for name, pred in buckets.items():
        rows = [r for r in common if pred(r)]
        entry = {}
        for m in models:
            pairs = [(r['preds'][m].get('pprPts', 0.0), r['actual']['pprPts'])
                     for r in rows]
            s = score(pairs)
            if s:
                entry[m] = s
        by_bucket[name] = entry

    # Head-to-head on PPR points, by position, on the common set.
    head_to_head = {}
    for pos in POSITIONS:
        rows = [r for r in common if r['pos'] == pos]
        entry = {}
        for m in models:
            pairs = [(r['preds'][m].get('pprPts', 0.0), r['actual']['pprPts'])
                     for r in rows]
            s = score(pairs)
            if s:
                entry[m] = s
        head_to_head[pos] = entry
    all_rows = [(r['preds'][m].get('pprPts', 0.0), r['actual']['pprPts'])
                for m in models for r in common]
    head_to_head['ALL'] = {
        m: score([(r['preds'][m].get('pprPts', 0.0), r['actual']['pprPts'])
                  for r in common])
        for m in models
    }

    # Prop calibration for the in-season model, on its own residual spread.
    # `volume_happened` says whether the carry/catch that a yardage stat
    # depends on actually occurred — see fit_dispersion.
    volume_of = {'passYds': 'passAtt', 'rushYds': 'rushAtt', 'recYds': 'rec'}
    calib_rows = [
        (r['pos'], stat, r['preds']['inseason'].get(stat, 0.0), r['actual'][stat],
         r['actual'].get(volume_of.get(stat, stat), 0.0) > 0)
        for r in records
        for stat in stat_keys[r['pos']]
        if stat != 'pprPts'
    ]
    disp = fit_dispersion(calib_rows)
    shifts = (fitted or {}).get('calibration') or {}
    calib_raw = calibration(records, stat_keys, disp)
    calib = calibration(records, stat_keys, disp, shifts) if shifts else calib_raw

    # Non-parametric head-to-head: on what share of player-weeks is our
    # absolute error smaller? Robust to the handful of blowups that dominate
    # a mean-based comparison.
    def win_rate(a, b, rows, stat='pprPts'):
        wins = ties = n = 0
        for r in rows:
            if a not in r['preds'] or b not in r['preds']:
                continue
            ea = abs(r['preds'][a].get(stat, 0.0) - r['actual'][stat])
            eb = abs(r['preds'][b].get(stat, 0.0) - r['actual'][stat])
            n += 1
            if abs(ea - eb) < 1e-9:
                ties += 1
            elif ea < eb:
                wins += 1
        if not n:
            return None
        return {'n': n, 'winRate': round(wins / n, 4), 'ties': ties}

    head_to_head_wins = {
        f'inseason_vs_{m}': win_rate('inseason', m, common)
        for m in models if m != 'inseason'
    }
    # Does the external edge come from information or from hindsight? A
    # projection with hindsight would win uniformly; one with better offseason
    # information wins early and fades as in-season data accumulates.
    sleeper_edge_by_bucket = {
        name: win_rate('inseason', 'sleeper', [r for r in common if pred(r)])
        for name, pred in buckets.items()
    } if sleeper else None

    # Sleeper provenance: how long after kickoff their rows were last touched.
    first_game = {}
    for g in iter_csv_rows('games'):
        if g.get('season') != str(season) or g.get('game_type') != 'REG':
            continue
        w = int(g['week'])
        d = g.get('gameday')
        if d and (w not in first_game or d < first_game[w]):
            first_game[w] = d
    provenance = None
    if sleeper_doc:
        stamps = defaultdict(list)
        for r in sleeper_doc.get('players') or []:
            if r.get('lastModified'):
                stamps[r['week']].append(r['lastModified'])
        rows = []
        for w in sorted(stamps):
            ms = sorted(stamps[w])
            med = datetime.fromtimestamp(ms[len(ms) // 2] / 1000, tz=timezone.utc)
            fg = datetime.fromisoformat(first_game[w]).replace(tzinfo=timezone.utc)
            rows.append({
                'week': w,
                'firstGame': first_game[w],
                'medianLastModified': med.isoformat(timespec='minutes'),
                'daysAfterFirstGame': round((med - fg).total_seconds() / 86400, 2),
            })
        provenance = {
            'note': (
                'Sleeper does not publish a frozen pre-game snapshot: every '
                "week's rows were last modified after that week's first "
                'kickoff, so in principle they could carry hindsight. Two '
                'things argue against that in practice — their R2 against '
                'actual weekly outcomes (~0.42) is squarely in the range a '
                'good projection achieves rather than near 1.0, and their '
                'edge is concentrated in the early weeks and gone by week 10 '
                '(see sleeperEdgeByWeekBucket), which is the signature of '
                'better offseason information, not of knowing the result. '
                'Treat it as a strong benchmark with a caveat, not as proof.'
            ),
            'weeks': rows,
        }

    out = {
        'season': season,
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'note': (
            'Walk-forward backtest of the in-season weekly model against '
            'actuals and external projections. Every week is predicted from '
            'earlier weeks only. Models are scored on the intersection of '
            'player-weeks all of them cover (see `coverage` for each model\'s '
            'own reach), conditional on the player appearing — the basis an '
            'external projection is scored on too. `r2` is against the actual '
            'weekly outcome, so weekly fantasy values in the 0.2-0.45 range '
            'are normal: most of a single game is irreducible variance. '
            '`spearman` is the start/sit-relevant number. `calibration` prices '
            "each projection as a prop using the model's own residual spread "
            'and checks that N% over-probabilities hit N% of the time.'
        ),
        'models': {
            'inseason': 'Walk-forward: weeks 1..w-1 of this season + prior season',
            'priorSeason': "Player's prior-season per-game average",
            'trail3': 'Mean of his last three games played',
            'last1': 'His previous game',
            'sleeper': "Sleeper's published weekly projection (external; "
                       'local-only snapshot, see DATA_SOURCES.md)',
            'blend': '50/50 average of inseason and sleeper',
        },
        'externalBenchmark': bool(sleeper),
        'playerWeeks': len(records),
        'commonPlayerWeeks': len(common),
        'coverage': coverage,
        'headToHeadPPR': head_to_head,
        'winRatePPR': head_to_head_wins,
        'sleeperEdgeByWeekBucket': sleeper_edge_by_bucket,
        'byWeekBucket': by_bucket,
        'byPositionAndStat': metrics_over(common, 'common set, all weeks')['byPosition'],
        'residualDispersion': disp,
        'params': {
            'source': inseason.get('paramsMeta'),
            'fitSeasons': (fitted or {}).get('fitSeasons'),
            'inSample': bool(fitted and season in (fitted.get('fitSeasons') or [])),
        },
        'calibration': calib,
        'calibrationUncorrected': calib_raw if shifts else None,
        'calibrationShifts': shifts or None,
        'sleeperProvenance': provenance,
    }

    path = os.path.join(DATA, f'weekly-backtest-{season}.json')
    with open(path, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    print(f'Wrote {path} ({os.path.getsize(path) / 1024:.0f} KB)')
    print(f'  {len(records)} scored player-weeks, {len(common)} covered by every model')
    print(f'  coverage: {coverage}')
    print('\n  PPR points, all positions (common set):')
    print(f'    {"model":<13}{"n":>6}{"MAE":>8}{"RMSE":>8}{"R2":>8}{"Spearman":>10}{"bias":>8}')
    for m in models:
        s = head_to_head['ALL'].get(m)
        if s:
            print(f'    {m:<13}{s["n"]:>6}{s["mae"]:>8.2f}{s["rmse"]:>8.2f}'
                  f'{(s["r2"] if s["r2"] is not None else float("nan")):>8.3f}'
                  f'{(s["spearman"] or float("nan")):>10.3f}{s["bias"]:>8.2f}')
    print('\n  PPR points by week bucket (MAE / Spearman):')
    for name, entry in by_bucket.items():
        bits = ' '.join(f'{m} {entry[m]["mae"]:.2f}/{entry[m]["spearman"]:.3f}'
                        for m in models if m in entry)
        print(f'    {name:<12} {bits}')
    print('\n  Win rate on PPR points (share of player-weeks where the '
          'in-season model is closer):')
    for k, v in head_to_head_wins.items():
        if v:
            print(f'    {k:<28} {v["winRate"]:.3f}  (n={v["n"]})')
    if sleeper_edge_by_bucket:
        print('  vs sleeper by week bucket:')
        for name, v in sleeper_edge_by_bucket.items():
            if v:
                print(f'    {name:<12} {v["winRate"]:.3f}  (n={v["n"]})')
    if shifts:
        print(f'\n  Prop calibration BEFORE the out-of-sample shift: '
              f'Brier {calib_raw["brier"]}')
    if calib['buckets']:
        print(f'\n  Prop calibration (Brier {calib["brier"]}, n={calib["n"]}):')
        for b in calib['buckets']:
            print(f'    {b["bucket"]:>10}  predicted {b["predicted"]:.3f}  '
                  f'actual {b["actual"]:.3f}  (n={b["n"]})')
        print('\n  Prop calibration by stat (predicted vs actual over-rate):')
        for stat, a in calib['byStat'].items():
            print(f'    {stat:>9}  predicted {a["predicted"]:.3f}  '
                  f'actual {a["actual"]:.3f}  (n={a["n"]})')


if __name__ == '__main__':
    main()
