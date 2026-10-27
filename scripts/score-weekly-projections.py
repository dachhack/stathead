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


# ── Stat lines ───────────────────────────────────────────────────────────
# stat key: (pool key, nflverse column, benchmark key)
STAT_COLS = {
    'passAtt': ('passAtt', 'attempts', 'pass_att'), 'passComp': ('passComp', 'completions', 'pass_cmp'),
    'passYds': ('passYds', 'passing_yards', 'pass_yd'), 'passTD': ('passTD', 'passing_tds', 'pass_td'),
    'int': ('int', 'passing_interceptions', 'pass_int'),
    'rushAtt': ('rushAtt', 'carries', 'rush_att'), 'rushYds': ('rushYds', 'rushing_yards', 'rush_yd'),
    'rushTD': ('rushTD', 'rushing_tds', 'rush_td'),
    'tgt': ('tgt', 'targets', 'rec_tgt'), 'rec': ('rec', 'receptions', 'rec'),
    'recYds': ('recYds', 'receiving_yards', 'rec_yd'), 'recTD': ('recTD', 'receiving_tds', 'rec_td'),
}
POS_STATS = {'QB': ['passAtt', 'passComp', 'passYds', 'passTD', 'int', 'rushAtt', 'rushYds', 'rushTD'],
             'RB': ['rushAtt', 'rushYds', 'rushTD', 'tgt', 'rec', 'recYds', 'recTD'],
             'WR': ['tgt', 'rec', 'recYds', 'recTD'],
             'TE': ['tgt', 'rec', 'recYds', 'recTD']}
STAT_CLASS = {k: ('volume' if k in ('passAtt', 'passComp', 'int', 'rushAtt', 'tgt') else
                  'rec' if k == 'rec' else 'yards' if k.endswith('Yds') else 'td')
              for k in STAT_COLS}


def norm_name(s):
    s = (s or '').lower().replace('.', '').replace("'", '')
    for suf in (' jr', ' sr', ' iii', ' ii', ' iv', ' v'):
        if s.endswith(suf):
            s = s[:-len(suf)]
    return ' '.join(s.split())


def pool_lines_before(season, when):
    """{(norm name, pos): per-game stat line} from the season pool committed
    last before `when` — for snapshots built before the feed carried
    statsPG. None when there is no such commit."""
    path = f'public/data/projection-base-{season}.json'
    commit, _ = snapshot_before(path, when)
    if not commit:
        return None
    pool = json.loads(git('show', f'{commit}:{path}'))
    out = {}
    for grp, pos in (('qbs', 'QB'), ('rbs', 'RB'), ('wrs', 'WR'), ('tes', 'TE')):
        for p in pool.get(grp, []):
            g = p.get('games') or 0
            if g > 0:
                out[(norm_name(p['name']), pos)] = {k: max(0.0, (p.get(STAT_COLS[k][0]) or 0)) / g
                                                    for k in POS_STATS[pos]}
    return out


def split_line(flat, split, m):
    """The feed's rule (scripts/build-weekly-projections.py::stat_split): volume
    flat, rec × m, yards 1 + ky (m-1), TDs 1 + kt (m-1); proportional without
    split factors."""
    out = {}
    for k, v in flat.items():
        c = STAT_CLASS.get(k)
        f = (m if not split else 1.0 if c == 'volume' else m if c == 'rec'
             else 1 + split['ky'] * (m - 1) if c == 'yards' else 1 + split['kt'] * (m - 1))
        out[k] = max(0.0, v * f)
    return out


def load_actual_stats(season):
    path = os.path.join(DATA, f'player_stats_{season}.csv.gz')
    out = {}
    if not os.path.exists(path):
        return out
    with gzip.open(path, 'rt') as f:
        for r in csv.DictReader(f):
            if r.get('season_type', 'REG') != 'REG' or r.get('position') not in POS:
                continue
            try:
                out[(r['player_id'], int(r['week']))] = {k: float(r.get(col) or 0) for k, (_, col, _) in STAT_COLS.items()}
            except ValueError:
                continue
    return out


def benchmark_stats(season, week):
    cache = os.path.join(CACHE, f'benchmark-proj-{season}-{week}.json')
    if not os.path.exists(cache):
        return None
    out = {}
    for e in json.load(open(cache)):
        st = e.get('stats') or {}
        if st.get('pts_ppr') is not None and e.get('player_id'):
            out[str(e['player_id'])] = {k: float(st.get(sk) or 0) for k, (_, _, sk) in STAT_COLS.items()}
    return out


def stat_metrics(srows):
    """Per position and stat: ours / flat / benchmark MAE, r, bias and the
    matchup-swing slope, plus a per-class summary the report card shows."""
    out = {}
    for pos in POS:
        out[pos] = {}
        for k in POS_STATS[pos]:
            sub = [r for r in srows if r['pos'] == pos and k in r['proj']]
            if len(sub) < 30:
                continue
            e = {}
            for mth in ('proj', 'flat', 'bench'):
                pairs = [(r['act'][k], r[mth][k]) for r in sub if r.get(mth) and k in r[mth]]
                e[{'proj': 'ours', 'flat': 'flat', 'bench': 'benchmark'}[mth]] = metrics(pairs)
            x = np.array([r['proj'][k] - r['flat'][k] for r in sub]); y = np.array([r['act'][k] - r['flat'][k] for r in sub])
            e['swingSlope'] = round(float(np.cov(x, y, ddof=1)[0, 1] / x.var(ddof=1)), 3) if x.std() > 0 else None
            e['actualMean'] = round(float(np.mean([r['act'][k] for r in sub])), 2)
            out[pos][k] = e
    return out


# ── Confidence bands ─────────────────────────────────────────────────────
# Empirical quantiles of actual / projected by position and projection
# tier, for players who played. Each position's quantiles are shrunk toward
# the pooled tier shape by n / (n + BAND_K), so a thin cell borrows the
# shape every position shares (RB 80% coverage went 70% → 80% with it on
# weeks 5-6 of 2026). Conditional on playing: availability is applied to
# the mean by the consumer, and the band scales with it.
BAND_TIERS = ((0.0, 3.0, '<3'), (3.0, 6.0, '3-6'), (6.0, 10.0, '6-10'), (10.0, 15.0, '10-15'), (15.0, None, '15+'))
BAND_QS = (10, 25, 50, 75, 90)
BAND_K = 40
BAND_MIN_N = 15


def band_tier(proj):
    for lo, hi, label in BAND_TIERS:
        if (proj >= lo or lo == BAND_TIERS[0][0]) and (hi is None or proj < hi):
            return label
    return BAND_TIERS[-1][2]


def fit_bands(rows):
    """{'pooled': {tier: {n, p10..p90}}, 'byPos': {pos: {tier: {...}}}} of
    actual / projected ratios."""
    def qs(vals):
        a = np.array(vals)
        return {'n': int(len(a)), **{f'p{q}': round(float(np.percentile(a, q)), 3) for q in BAND_QS}}
    pooled, by_pos = {}, {pos: {} for pos in POS}
    for _, _, label in BAND_TIERS:
        allv = [r['act'] / r['ours'] for r in rows if r['ours'] > 0 and band_tier(r['ours']) == label]
        if len(allv) < BAND_MIN_N:
            continue
        pooled[label] = qs(allv)
        for pos in POS:
            v = [r['act'] / r['ours'] for r in rows if r['pos'] == pos and r['ours'] > 0 and band_tier(r['ours']) == label]
            if len(v) < BAND_MIN_N:
                by_pos[pos][label] = {'n': len(v), 'shrunk': 1.0, **{k: pooled[label][k] for k in pooled[label] if k != 'n'}}
                continue
            raw = qs(v)
            w = len(v) / (len(v) + BAND_K)
            by_pos[pos][label] = {'n': len(v), 'shrunk': round(1 - w, 3),
                                  **{f'p{q}': round(w * raw[f'p{q}'] + (1 - w) * pooled[label][f'p{q}'], 3) for q in BAND_QS}}
    return {'pooled': pooled, 'byPos': by_pos}


def band_for(bands, pos, proj):
    tier = band_tier(proj)
    return (bands.get('byPos', {}).get(pos) or {}).get(tier) or bands.get('pooled', {}).get(tier)


def band_coverage(bands, rows):
    """Share of player-weeks whose actual fell inside the 80% and 50% bands."""
    in80, in50 = [], []
    for r in rows:
        b = band_for(bands, r['pos'], r['ours']) if r['ours'] > 0 else None
        if not b:
            continue
        in80.append(b['p10'] * r['ours'] <= r['act'] <= b['p90'] * r['ours'])
        in50.append(b['p25'] * r['ours'] <= r['act'] <= b['p75'] * r['ours'])
    return {'n': len(in80), 'band80': round(float(np.mean(in80)), 3) if in80 else None,
            'band50': round(float(np.mean(in50)), 3) if in50 else None}


# ── Stat-line simulation bands ───────────────────────────────────────────
# A player's own outcome distribution from his projected stat line: volume
# (attempts / carries / targets) drawn gamma around its projection with a
# dispersion fitted per projected-volume tier, receptions binomial at his
# catch rate, yards = the sum over those opportunities of a gamma
# per-opportunity yardage (so a 10-target line is tighter and less skewed
# than a 3-target one), TDs Poisson at his rate per opportunity, INTs
# Poisson — then each draw is scored. The dispersions are fitted per
# position from the season's actual-vs-projected stat lines and re-fitted
# every week; coverage is checked walk-forward like the tier bands. A
# TD-dependent or low-volume line gets a wide, lumpy band, a high-volume
# low-TD line a narrower one — which is what the tier bands cannot say.
# Shape matters: with lognormal draws at the same dispersions the median
# sat too low (on 2026 weeks 4-6 only 42% of receivers' actual yards fell
# below the simulated median, and 18% below p25); gamma volume + summed
# gamma yards read 49% / 20%, with the 80% / 50% points coverage at 81% /
# 51%. Tiering the sigma alone did not move it — the shape did.
SIM_DRAWS = 600
# Projected-volume tier edges for the volume dispersion (a 20-carry back's
# carries vary far less, in log terms, than a 5-carry back's: σ 0.33 vs 0.73).
SIM_TIERS = {'passAtt': (30, 34), 'rushAtt': (7, 10.5, 13.5), 'tgt': (3.8, 5.4, 7.3)}
SIM_MIN_TIER_N = 20
SIM_SHAPE_RANGE = (0.5, 50.0)


def sim_tier(v, x):
    edges = SIM_TIERS.get(v, ())
    return sum(1 for e in edges if x >= e)


def sim_volume_sigma(params, v, mu):
    tiers = (params.get('volumeSigmaTier') or {}).get(v)
    if tiers:
        s = tiers['sigma'][sim_tier(v, mu)]
        if s:
            return s
    return params['volumeSigma'].get(v)
SIM_VOLUME = {'QB': ('passAtt', 'rushAtt'), 'RB': ('rushAtt', 'tgt'), 'WR': ('tgt', 'rushAtt'), 'TE': ('tgt',)}
# yards component -> the opportunity it rides on (receiving yards per
# reception, since receptions are drawn from targets)
SIM_YARDS = {'passYds': 'passAtt', 'rushYds': 'rushAtt', 'recYds': 'rec'}
SIM_TDS = {'passTD': 'passAtt', 'rushTD': 'rushAtt', 'recTD': 'tgt'}
SIM_MIN_PROJ = {'passAtt': 10, 'rushAtt': 4, 'tgt': 2, 'rec': 1.5}   # fit dispersions on real roles only
# A volume draw describes a player who plays his game. Fitting the
# dispersion on every row let games a starter left early (injury, blowout
# benching) and backups' relief stints in: for QB attempts that stretched the
# log sigma to 0.61 and pushed the passing-yards median 13% under the mean
# (a 246-yard projection set a 213.5 line). Rows below this share of the
# projected volume are left out of the fit; the availability layer prices
# the leaving-early case separately.
SIM_PLAYED_SHARE = {'passAtt': 0.5}
PPR_W = {'passYds': 0.04, 'passTD': 4, 'int': -2, 'rushYds': 0.1, 'rushTD': 6, 'rec': 1, 'recYds': 0.1, 'recTD': 6}


def fit_sim_params(srows):
    """Per position: lognormal sigma of actual / projected for each volume
    component, lognormal sigma of per-opportunity yardage, and the Poisson
    overdispersion of TDs (variance / mean of actual TDs against their
    projected rate; > 1 widens the TD draw)."""
    out = {}
    for pos in POS:
        sub = [r for r in srows if r['pos'] == pos]
        if len(sub) < 60:
            continue
        p = {'shape': 'gamma', 'volumeSigma': {}, 'volumeSigmaTier': {}, 'yardsPerOppSigma': {}, 'yardsShape': {},
             'tdDispersion': {}}
        for v in SIM_VOLUME[pos]:
            pairs = [(r['proj'][v], np.log(r['act'][v] / r['proj'][v])) for r in sub
                     if r['proj'].get(v, 0) >= SIM_MIN_PROJ[v]
                     and r['act'].get(v, 0) >= max(1e-9, SIM_PLAYED_SHARE.get(v, 0.0) * r['proj'][v])]
            lr = [x for _, x in pairs]
            if len(lr) >= 30:
                p['volumeSigma'][v] = round(float(np.std(lr)), 3)
                edges = SIM_TIERS.get(v, ())
                sig = []
                for t in range(len(edges) + 1):
                    l = [x for mu, x in pairs if sim_tier(v, mu) == t]
                    sig.append(round(float(np.std(l)), 3) if len(l) >= SIM_MIN_TIER_N else None)
                p['volumeSigmaTier'][v] = {'edges': list(edges), 'sigma': sig}
        for y, v in SIM_YARDS.items():
            if (v if v != 'rec' else 'tgt') not in SIM_VOLUME[pos]:
                continue
            rows = [r for r in sub if r['proj'].get(v, 0) >= SIM_MIN_PROJ[v] and r['act'].get(v, 0) > 0
                    and r['act'].get(y, 0) > 0 and r['proj'].get(y, 0) > 0]
            lr = [np.log((r['act'][y] / r['act'][v]) / (r['proj'][y] / r['proj'][v])) for r in rows]
            if len(lr) >= 30:
                p['yardsPerOppSigma'][y] = round(float(np.std(lr)), 3)
                # Gamma shape k of the per-opportunity yardage: the mean of n
                # draws has CV² = 1 / (k n), so k matches the observed
                # log-ratio variance given each game's opportunity count.
                inv_n = float(np.mean([1.0 / r['act'][v] for r in rows]))
                k = inv_n / max(float(np.var(lr)), 1e-6)
                p['yardsShape'][y] = round(float(np.clip(k, *SIM_SHAPE_RANGE)), 3)
        for t, v in SIM_TDS.items():
            if v not in SIM_VOLUME[pos]:
                continue
            pairs = [(r['proj'][t], r['act'][t]) for r in sub if r['proj'].get(t, 0) > 0.02]
            if len(pairs) >= 60:
                mu = np.array([a for a, _ in pairs]); x = np.array([b for _, b in pairs])
                # Poisson would give var(x - mu) ≈ mean(mu); the ratio is the overdispersion.
                disp = float(np.var(x - mu) / mu.mean()) if mu.mean() > 0 else 1.0
                p['tdDispersion'][t] = round(max(1.0, disp), 3)
        if p['volumeSigma']:
            out[pos] = p
    return out


def simulate_stats(line, pos, params, rng, draws=SIM_DRAWS):
    """Per-stat draws for one projected stat line: {stat: array} for every
    component simulated (volume, rec, yards, TDs, int) plus 'pts' (PPR)."""
    n = draws
    out = {}
    gamma = params.get('shape') == 'gamma'
    vol = {}
    for v in SIM_VOLUME[pos]:
        mu = max(0.0, line.get(v, 0.0))
        sig = sim_volume_sigma(params, v, mu)
        if not (mu > 0 and sig):
            vol[v] = np.full(n, mu)
        elif gamma:
            k = 1.0 / (sig * sig)
            vol[v] = rng.gamma(k, mu / k, n)
        else:
            vol[v] = mu * np.exp(rng.normal(-0.5 * sig * sig, sig, n))
    out.update(vol)
    pts = np.zeros(n)
    rec = np.zeros(n)
    if 'tgt' in vol:
        tgt_mu = line.get('tgt', 0.0)
        rate = min(1.0, line.get('rec', 0.0) / tgt_mu) if tgt_mu > 0 else 0.0
        rec = rng.binomial(np.maximum(0, np.round(vol['tgt']).astype(int)), rate) if rate > 0 else np.zeros(n)
        out['rec'] = rec
        pts += PPR_W['rec'] * rec
    for y, v in SIM_YARDS.items():
        opp = rec if v == 'rec' else vol.get(v)
        if opp is None or line.get(y, 0.0) <= 0 or ('tgt' not in vol and v == 'rec'):
            continue
        base = line[v] if line.get(v, 0.0) > 0 else 1.0
        per_opp = line[y] / base
        k = params.get('yardsShape', {}).get(y) if gamma else None
        if k:
            # Sum of `opp` gamma(k) per-opportunity draws = gamma(k·opp).
            yards = rng.gamma(np.maximum(k * opp, 1e-9), per_opp / k) * (opp > 0)
        else:
            sig = params['yardsPerOppSigma'].get(y, 0.3)
            yards = opp * per_opp * np.exp(rng.normal(-0.5 * sig * sig, sig, n))
        out[y] = yards
        pts += PPR_W[y] * yards
    for t, v in SIM_TDS.items():
        if v not in vol or line.get(t, 0.0) <= 0:
            continue
        base = line[v] if line.get(v, 0.0) > 0 else 1.0
        lam = line[t] / base * vol[v]
        disp = params['tdDispersion'].get(t, 1.0)
        if disp > 1.05:
            # Negative binomial with the fitted overdispersion: gamma-mixed Poisson.
            shape = lam / (disp - 1)
            lam = rng.gamma(np.where(shape > 0, shape, 1e-9), disp - 1) * (lam > 0)
        tds = rng.poisson(lam)
        out[t] = tds
        pts += PPR_W[t] * tds
    if line.get('int', 0.0) > 0:
        ints = rng.poisson(line['int'], n)
        out['int'] = ints
        pts += PPR_W['int'] * ints
    out['pts'] = pts
    return out


def simulate_points(line, pos, params, rng, draws=SIM_DRAWS):
    """Draws of PPR points and receptions for one projected stat line."""
    d = simulate_stats(line, pos, params, rng, draws)
    return d['pts'], d.get('rec', np.zeros(draws))


# ── Pick lines ───────────────────────────────────────────────────────────
# A pick line is a player, a stat (or a sum of stats), a number and a payout
# per leg. It is priced from the week's stat line and the simulation above:
# P(over) = the share of draws above the line. scripts/price-lines.py prices
# and records lines in data/pick-log.json; the scorer grades every
# recorded line once its week is final (actual, hit, return at the payout),
# so the log becomes a track record: hit rate and calibration by stat and by
# confidence, which is what decides whether the edge is real.
PICK_LOG = os.path.join(ROOT, 'data', 'pick-log.json')   # committed, not deployed: the lines are an input
PICK_STATS = {   # stat key -> the components it sums
    'recYds': ('recYds',), 'rushYds': ('rushYds',), 'passYds': ('passYds',), 'rec': ('rec',), 'tgt': ('tgt',),
    'rushAtt': ('rushAtt',), 'passTD': ('passTD',), 'rushRecYds': ('rushYds', 'recYds'), 'passRushYds': ('passYds', 'rushYds'),
    'anyTD': ('rushTD', 'recTD'),
}
PICK_BUCKETS = ((0.62, '62%+'), (0.58, '58-62%'), (0.54, '54-58%'), (0.5, '50-54%'))


def pick_actual(sa, stat):
    comps = PICK_STATS.get(stat)
    if not comps or not sa:
        return None
    return float(sum(sa.get(c, 0.0) for c in comps))


def grade_picks(act_stats, played_through):
    """Grade the recorded pick lines whose week is final. Returns the block
    written to the accuracy artifact: every graded pick, and hit rate /
    calibration / return by stat, by confidence bucket and by week."""
    if not os.path.exists(PICK_LOG):
        return None
    try:
        log = json.load(open(PICK_LOG))
    except (OSError, ValueError):
        return None
    picks = log.get('picks') if isinstance(log, dict) else log
    graded, pending, upcoming = [], 0, []
    for p in picks or []:
        w = p.get('week')
        if not w or w > played_through:
            pending += 1
            upcoming.append({k: p.get(k) for k in ('week', 'player', 'pos', 'team', 'stat', 'line', 'proj', 'median', 'lean', 'pLean',
                                                   'pRaw', 'mult', 'breakeven', 'edge', 'flags', 'source', 'tag', 'publicOver', 'recordedAt')})
            continue
        sa = act_stats.get((p.get('gsis'), w))
        actual = pick_actual(sa, p.get('stat'))
        if actual is None:
            graded.append({**p, 'actual': None, 'hit': None, 'push': False, 'ret': 0.0, 'note': 'did not play'})
            continue
        lean = p.get('lean')
        over = actual > p['line']
        push = actual == p['line']
        hit = None if push or lean not in ('over', 'under') else (over if lean == 'over' else not over)
        mult = float(p.get('mult') or 0)
        ret = 0.0 if hit is None else (mult - 1 if hit else -1.0)
        # Probability of the recorded lean, for calibration: the published
        # (calibrated) one, and the simulation's raw share alongside.
        p_lean = p.get('pLean') if p.get('pLean') is not None else (
            p.get('pOver') if lean == 'over' else (1 - p['pOver'] if p.get('pOver') is not None else None))
        p_raw = p.get('pRaw') if p.get('pRaw') is not None else p_lean
        graded.append({**p, 'actual': round(actual, 1), 'hit': hit, 'push': push, 'ret': round(ret, 3), 'pLean': p_lean, 'pRaw': p_raw})

    def summary(rows):
        rows = [r for r in rows if r.get('hit') is not None]
        if not rows:
            return None
        hits = sum(1 for r in rows if r['hit'])
        pl = [r['pLean'] for r in rows if r.get('pLean') is not None]
        pr = [r['pRaw'] for r in rows if r.get('pRaw') is not None]
        return {'n': len(rows), 'hits': hits, 'hitRate': round(hits / len(rows), 3),
                'expectedHitRate': round(float(np.mean(pl)), 3) if pl else None,
                'rawExpectedHitRate': round(float(np.mean(pr)), 3) if pr else None,
                'return': round(float(sum(r['ret'] for r in rows)), 2),
                'roi': round(float(sum(r['ret'] for r in rows)) / len(rows), 3)}

    by_stat = {st: summary([r for r in graded if r.get('stat') == st]) for st in sorted({r.get('stat') for r in graded})}
    by_bucket = {}
    for lo, label in PICK_BUCKETS:
        hi = next((l2 for l2, _ in PICK_BUCKETS if l2 > lo), 1.01)
        by_bucket[label] = summary([r for r in graded if r.get('pLean') is not None and lo <= r['pLean'] < hi])
    by_week = {str(w): summary([r for r in graded if r.get('week') == w]) for w in sorted({r.get('week') for r in graded})}
    flagged = summary([r for r in graded if r.get('flags')])
    clean = summary([r for r in graded if not r.get('flags')])
    by_tag = {t: summary([r for r in graded if (r.get('tag') or 'auto') == t]) for t in sorted({r.get('tag') or 'auto' for r in graded})}
    return {'graded': graded, 'pending': pending, 'upcoming': upcoming, 'overall': summary(graded), 'byStat': by_stat, 'byConfidence': by_bucket,
            'byWeek': by_week, 'byTag': by_tag, 'flagged': flagged, 'unflagged': clean,
            'note': ('Recorded pick lines (scripts/price-lines.py --record) graded once the week is final: hit = the '
                     'recorded lean was right (a push is void), ret = the return per 1 unit at the recorded payout '
                     '(mult - 1 on a hit, -1 on a miss), roi = return per pick. expectedHitRate = the mean calibrated probability '
                     'the model gave its leans (rawExpectedHitRate the simulation\'s raw share), so hitRate against '
                     'each is the calibration check that re-tunes the shrink. byTag: call = picks we actually made '
                     '(price-lines.py --tag call), auto = leans the scheduled run recorded. flagged = picks that '
                     'carried a guardrail flag when recorded.')}


def sim_quantiles(line, pos, params, seed=0):
    rng = np.random.default_rng(seed)
    pts, _ = simulate_points(line, pos, params, rng)
    q = np.percentile(pts, BAND_QS)
    return {f'p{k}': round(float(x), 2) for k, x in zip(BAND_QS, q)}


def sim_coverage(params, srows_week, tier_bands=None, seed=1):
    """Coverage of the simulation bands and, with tier_bands, of the blend
    (the average of the two quantile sets — what the feed publishes)."""
    out = {}
    for name in (('sim',) if tier_bands is None else ('sim', 'blend')):
        in80, in50 = [], []
        for r in srows_week:
            if r['pos'] not in params or r['pts'] < 3:
                continue
            q = sim_quantiles(r['proj'], r['pos'], params[r['pos']], seed)
            if name == 'blend':
                tb = band_for(tier_bands, r['pos'], r['pts'])
                if not tb:
                    continue
                q = {k: 0.5 * (q[k] + r['pts'] * tb[k]) for k in q}
            a = r['act_pts']
            in80.append(q['p10'] <= a <= q['p90']); in50.append(q['p25'] <= a <= q['p75'])
        out[name] = {'n': len(in80), 'band80': round(float(np.mean(in80)), 3) if in80 else None,
                     'band50': round(float(np.mean(in50)), 3) if in50 else None}
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
    ap.add_argument('--bands', default=None, help='write the confidence-band quantiles here (JSON)')
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

    act_stats = load_actual_stats(season)
    rows, srows, weeks_out = [], [], {}
    stat_rule = {}
    for w in range(1, played_through + 1):
        if w not in kick:
            continue
        commit, when = snapshot_before(path, kick[w])
        if not commit:
            continue
        snap = json.loads(git('show', f'{commit}:{path}'))
        scales = snap.get('matchupScale') or {}
        bench = None if args.no_benchmark else load_benchmark(season, w)
        bench_stats = None if args.no_benchmark else benchmark_stats(season, w)
        has_stats = any(p.get('statsPG') for p in snap['players'])
        pool_lines = None if has_stats else pool_lines_before(season, kick[w])
        stat_rule[str(w)] = ('split' if any(p.get('statSplit') for p in snap['players'])
                             else 'proportional' if (has_stats or pool_lines) else 'none')
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
            # Stat line for the week: the feed's own, or reconstructed from the
            # pool as it stood (proportional, the rule before statSplit).
            flat = p.get('statsPG') or (pool_lines or {}).get((norm_name(p['name']), p['pos']))
            sa = act_stats.get((g, w))
            if flat and sa and p.get('ppg') and a is not None:
                line = split_line(flat, p.get('statSplit'), proj / p['ppg'])
                bs = (bench_stats or {}).get(str(p.get('sleeper') or ''))
                srows.append({'w': w, 'pos': p['pos'], 'proj': line, 'flat': dict(flat), 'act': sa,
                              'bench': bs, 'starter': proj >= STARTER_MIN, 'pts': float(proj), 'act_pts': a})
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
        'statLines': {
            'note': ('Per-week stat lines scored on the same player-weeks: ours = the feed\'s split (statRule per '
                     'week: split = volume flat, yards / TDs carry the swing; proportional = every component × '
                     'the multiplier, reconstructed from the pool for weeks before the feed carried statsPG), '
                     'flat = the season per-game stat, benchmark = the external set\'s stat. swingSlope = slope '
                     'of (actual − flat) on (projection − flat) for that component: 1 = right size, 0 = the '
                     'matchup carries no information about it.'),
            'statRule': stat_rule,
            'playerWeeks': len(srows),
            'byPos': stat_metrics(srows),
        },
        'weeks': weeks_out,
    }

    # Confidence bands from every scored week, and how last week's would
    # have done had they been fitted on the weeks before it (walk-forward).
    last_w = out['weeksScored'][-1]
    bands = fit_bands(rows)
    prior = [r for r in rows if r['w'] < last_w]
    coverage = (band_coverage(fit_bands(prior), [r for r in rows if r['w'] == last_w])
                if len(prior) >= 200 else None)
    # Stat-line simulation: dispersions from every scored week, coverage of
    # last week from the dispersions fitted on the weeks before it.
    sim_params = fit_sim_params(srows)
    sim_prior = fit_sim_params([r for r in srows if r['w'] < last_w])
    sim_cov = (sim_coverage(sim_prior, [r for r in srows if r['w'] == last_w], fit_bands(prior))
               if sim_prior and len([r for r in srows if r['w'] < last_w]) >= 200 else None)
    out['picks'] = grade_picks(act_stats, played_through)
    out['bands'] = {
        'note': ('Two bands, both conditional on playing. tier: empirical quantiles of actual / projected (players who '
                 f'played) by position and projection tier, each position shrunk toward the pooled tier shape by n / (n + {BAND_K}); '
                 'a band is the projection × these ratios. simulation: the player\'s own outcome distribution from his '
                 'projected stat line — volume gamma around its projection with the log-dispersion of its projected-volume '
                 'tier (volumeSigmaTier, volumeSigma the fallback), receptions binomial at his catch rate, yards = the sum '
                 'over those opportunities of a gamma per-opportunity yardage (yardsShape = the gamma shape; '
                 'yardsPerOppSigma is the game-level log-dispersion it was fitted from), TDs Poisson at his rate per '
                 'opportunity (negative binomial where tdDispersion > 1), INTs Poisson — each draw scored; a TD-dependent '
                 'or low-volume line gets a wider band. Gamma rather than lognormal because the lognormal median sat too '
                 'low (walk-forward on 2026: 42% of receivers\' actual yards below the simulated median vs 49% with gamma). '
                 'Published band = the average of the two quantile sets (simulation.coverage.blend checks it). The '
                 'median sits below the projection because weeks are right-skewed. coverage = share of last week\'s '
                 'actuals inside the bands fitted on the weeks before it (80% band should read ~0.80, 50% band ~0.50).'),
        'fittedThrough': last_w, 'playerWeeks': len(rows),
        'tiers': [{'min': lo, 'max': hi, 'label': label} for lo, hi, label in BAND_TIERS],
        'quantiles': list(BAND_QS),
        **bands,
        'coverage': {'week': last_w, **coverage} if coverage else None,
        'simulation': {'draws': SIM_DRAWS, 'params': sim_params,
                       'coverage': {'week': last_w, **sim_cov['sim']} if sim_cov else None,
                       'blendCoverage': {'week': last_w, **sim_cov['blend']} if sim_cov else None},
    }
    if args.bands:
        with open(os.path.join(ROOT, args.bands), 'w') as f:
            json.dump({'season': season, 'generatedAt': out['generatedAt'], **out['bands']}, f, indent=1)

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
    pk = out.get('picks')
    if pk and pk.get('overall'):
        o = pk['overall']
        L += ['', '## Pick lines', '',
              f"{o['n']} graded picks ({pk.get('pending', 0)} pending): hit rate {o['hitRate']:.0%} (model expected "
              f"{o['expectedHitRate']:.0%}), return {o['return']:+.2f} units, ROI {o['roi']:+.1%} per pick.", '',
              '| cut | n | hits | hit rate | expected | return | ROI |', '|---|---|---|---|---|---|---|']
        for label, m in ([('all', o)] + [(f'{k} picks', v) for k, v in (pk.get('byTag') or {}).items()]
                         + [(f'stat {k}', v) for k, v in pk['byStat'].items()]
                         + [(f'confidence {k}', v) for k, v in pk['byConfidence'].items()]
                         + [('flagged', pk.get('flagged')), ('unflagged', pk.get('unflagged'))]):
            if m:
                L.append(f"| {label} | {m['n']} | {m['hits']} | {m['hitRate']:.0%} | "
                         f"{m['expectedHitRate']:.0%} | {m['return']:+.2f} | {m['roi']:+.1%} |")
        L += ['', '| week | player | stat | line | lean | P(lean) | actual | hit | ret |', '|---|---|---|---|---|---|---|---|---|']
        for r in pk['graded']:
            L.append(f"| {r.get('week')} | {r.get('player')}{' ★' if r.get('tag') == 'call' else ''} | {r.get('stat')} | {r.get('line')} | {r.get('lean')} | "
                     f"{(r.get('pLean') or 0):.0%} | {r.get('actual')} | {'push' if r.get('push') else r.get('hit')} | {r.get('ret'):+.2f} |")
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
    b = out.get('bands') or {}
    if b.get('byPos'):
        cov = b.get('coverage')
        L += ['', f"## Confidence bands (actual ÷ projected, players who played, fitted on weeks 1–{b['fittedThrough']})", '',
              'Projection × p10–p90 = the 80% band, × p25–p75 the 50% band; the median ratio is below 1 because '
              'weeks are right-skewed. Thin cells are shrunk toward the pooled tier shape (shrunk = weight on it).'
              + (f" Walk-forward check on week {cov['week']}: {cov['band80']:.0%} of actuals inside the 80% band, "
                 f"{cov['band50']:.0%} inside the 50% band (n={cov['n']})." if cov else ''), '',
              '| pos | tier | n | shrunk | p10 | p25 | median | p75 | p90 |', '|---|---|---|---|---|---|---|---|---|']
        for pos in POS:
            for _, _, label in BAND_TIERS:
                e = b['byPos'].get(pos, {}).get(label)
                if e:
                    L.append(f"| {pos} | {label} | {e['n']} | {e.get('shrunk', 0):.2f} | {e['p10']:.2f} | {e['p25']:.2f} | "
                             f"{e['p50']:.2f} | {e['p75']:.2f} | {e['p90']:.2f} |")
        sim = b.get('simulation') or {}
        if sim.get('params'):
            sc, bc = sim.get('coverage'), sim.get('blendCoverage')
            L += ['', '### Stat-line simulation', '',
                  'Per-player bands from the projected stat line (see the bands note). Fitted dispersions:'
                  + (f" Walk-forward check on week {sc['week']}: simulation {sc['band80']:.0%} of actuals inside the 80% band, "
                     f"{sc['band50']:.0%} inside the 50% band; the published blend with the tier bands {bc['band80']:.0%} / "
                     f"{bc['band50']:.0%} (n={sc['n']})." if sc and bc else ''), '',
                  '| pos | volume σ (log) by tier | yards/opportunity gamma shape | TD overdispersion |', '|---|---|---|---|']
            for pos in POS:
                p = sim['params'].get(pos)
                if p:
                    def _tier(k):
                        t = (p.get('volumeSigmaTier') or {}).get(k)
                        return f"{k} " + ('/'.join('–' if x is None else f'{x:.2f}' for x in t['sigma']) if t else f"{p['volumeSigma'][k]}")
                    L.append(f"| {pos} | {', '.join(_tier(k) for k in p['volumeSigma'])} | "
                             f"{', '.join(f'{k} {v}' for k, v in (p.get('yardsShape') or p['yardsPerOppSigma']).items())} | "
                             f"{', '.join(f'{k} {v}' for k, v in p['tdDispersion'].items())} |")
    sl = out.get('statLines') or {}
    if sl.get('byPos'):
        rules = ', '.join(f"wk {w} {r}" for w, r in sl['statRule'].items())
        L += ['', f"## Stat lines ({sl['playerWeeks']} player-weeks; rule per week: {rules})", '',
              'MAE / r per component — StatHead vs the flat per-game stat vs the external benchmark — and the '
              'matchup swing\'s calibration on that component (1 = right size, 0 = no information).', '',
              '| pos | stat | n | actual/g | StatHead | flat | benchmark | swing slope |', '|---|---|---|---|---|---|---|---|']
        for pos in POS:
            for k, e in sl['byPos'].get(pos, {}).items():
                f = lambda m: f"{m['mae']:.2f} / {m['r']}" if m else '—'
                L.append(f"| {pos} | {k} | {(e.get('ours') or {}).get('n', 0)} | {e['actualMean']} | {f(e.get('ours'))} | "
                         f"{f(e.get('flat'))} | {f(e.get('benchmark'))} | {e['swingSlope'] if e['swingSlope'] is not None else '—'} |")
    return '\n'.join(L) + '\n'


if __name__ == '__main__':
    sys.exit(main())
