#!/usr/bin/env python3
"""In-season, walk-forward weekly projections.

The season-long builders (`build-player-props.py`) answer "what do we expect
in week 10, asked in August". This one answers the in-season question: **what
do we expect in week 10, knowing only weeks 1-9**. Every number for week *w*
is computed from weeks 1..w-1 of the same season plus the prior season — no
week-*w* information touches the prediction, which is what makes the backtest
in `eval-weekly-backtest.py` honest.

Method — usage x efficiency, not points

  Weekly fantasy points are volatile because efficiency is volatile; usage is
  not. So nothing is projected directly. Instead:

    volume      = player's share of his team's plays  x  team plays per game
                  x  opponent volume-allowed multiplier  x  home/away
    production  = volume  x  player's per-touch efficiency
                  x  opponent efficiency-allowed multiplier

  Each input is an empirical-Bayes blend of what the player has done this
  season (exponentially weighted, so recent games count more) and a prior:
  his prior-season rate, falling back to the positional replacement level for
  rookies and players with no history.

      x_hat = (w_obs * x_observed + k * x_prior) / (w_obs + k)

  `k` is the stabilization constant — how many games of evidence it takes
  before the player's own numbers outweigh the prior. Target share stabilizes
  fast (small k); touchdown rate barely stabilizes at all (large k), which is
  why TD projections stay close to the positional baseline all year. The
  constants live in PARAMS and are fit out of sample by
  `--fit` (see `scripts/fit-inseason-params.py`).

  Opponent adjustments are split so they can't double-count: the volume
  multiplier comes from plays/targets/carries a defense allows to the
  position, the efficiency multiplier from yards *per* target/carry allowed.
  Both are computed from weeks 1..w-1 only, blended with the prior season
  while the sample is thin, shrunk toward 1.0 and clamped.

Predictions are emitted for every player who actually appeared in that week,
conditional on playing — the same basis external projections are scored on.

Usage:
  python3 scripts/build-inseason-projections.py --season 2025            # backtest all weeks
  python3 scripts/build-inseason-projections.py --season 2026 --week 7   # live: project week 7

Output:
  public/data/inseason-projections-<season>.json
"""

import argparse
import csv
import gzip
import json
import math
import os
from collections import defaultdict
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'public', 'data')

POSITIONS = ('QB', 'RB', 'WR', 'TE')
WEEKS = 18

# Stabilization constants: games of evidence before a player's own rate
# outweighs his prior. Fit out of sample — see scripts/fit-inseason-params.py.
PARAMS = {
    # usage shares
    'k_tgt_share': 3.0,
    'k_rush_share': 3.0,
    'k_pass_share': 1.5,
    # efficiency
    'k_catch_rate': 6.0,
    'k_ypt': 8.0,
    'k_ypc': 10.0,
    'k_rec_td_rate': 14.0,
    'k_rush_td_rate': 14.0,
    'k_comp_pct': 6.0,
    'k_ypa': 8.0,
    'k_pass_td_rate': 12.0,
    'k_int_rate': 14.0,
    # team volume
    'k_team': 4.0,
    # exponential recency: weight of a game g games ago = 0.5 ** ((g-1)/half_life)
    'half_life': 5.0,
    # opponent adjustment
    'opp_shrink_vol': 0.35,
    'opp_shrink_eff': 0.25,
    'opp_blend_k': 4.0,
    'opp_clamp': 0.15,
    'home_mult': 1.02,
}

STAT_KEYS = {
    'QB': ('passAtt', 'passComp', 'passYds', 'passTD', 'int',
           'rushAtt', 'rushYds', 'rushTD', 'pprPts'),
    'RB': ('rushAtt', 'rushYds', 'rushTD', 'tgt', 'rec', 'recYds', 'recTD', 'pprPts'),
    'WR': ('rushAtt', 'rushYds', 'rushTD', 'tgt', 'rec', 'recYds', 'recTD', 'pprPts'),
    'TE': ('tgt', 'rec', 'recYds', 'recTD', 'rushAtt', 'rushYds', 'rushTD', 'pprPts'),
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


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def load_weekly(season):
    """[{player, pos, team, opp, week, stats{}}] for a season's REG weeks."""
    rows = []
    for r in iter_csv_rows(f'player_stats_{season}'):
        if r.get('season_type') != 'REG':
            continue
        pos = r.get('position')
        if pos not in POSITIONS or not r.get('team'):
            continue
        try:
            week = int(r.get('week') or 0)
        except ValueError:
            continue
        if not 1 <= week <= WEEKS:
            continue
        rows.append({
            'pid': r.get('player_id'),
            'name': r.get('player_display_name') or r.get('player_name'),
            'pos': pos,
            'team': r.get('team'),
            'opp': r.get('opponent_team'),
            'week': week,
            'stats': {k: num(r.get(c)) for k, c in COLS.items()},
        })
    return rows


def home_teams(season):
    """(team, week) -> True when that team was at home."""
    out = {}
    for g in iter_csv_rows('games'):
        if g.get('season') != str(season) or g.get('game_type') != 'REG':
            continue
        w = g.get('week')
        out[(g['home_team'], w)] = True
        out[(g['away_team'], w)] = False
    return {(t, int(w)): v for (t, w), v in out.items() if str(w).isdigit()}


def ewma(values, half_life):
    """Exponentially weighted mean, most recent value first.
    Returns (weighted_mean, total_weight)."""
    if not values:
        return 0.0, 0.0
    num_ = den = 0.0
    for i, v in enumerate(values):
        w = 0.5 ** (i / half_life)
        num_ += w * v
        den += w
    return (num_ / den if den else 0.0), den


def ewma_ratio(pairs, half_life):
    """Exponentially weighted rate: sum(w*numer) / sum(w*denom), plus the
    weighted denominator (the amount of evidence behind it). Rates must be
    pooled this way, not averaged per game — a 1-target game should not
    count as much as a 12-target game."""
    n = d = ev = 0.0
    for i, (a, b) in enumerate(pairs):
        w = 0.5 ** (i / half_life)
        n += w * a
        d += w * b
        ev += w * b
    return (n / d if d > 0 else 0.0), ev


def blend(observed, evidence, prior, k):
    """Empirical-Bayes blend of an observed rate with its prior."""
    if evidence <= 0:
        return prior
    return (evidence * observed + k * prior) / (evidence + k)


def clamped(ratio, shrink, cap):
    m = 1 + shrink * (ratio - 1)
    return max(1 - cap, min(1 + cap, m))


# ── team + league aggregates, always as-of a week ─────────────────────────

def team_week_totals(rows):
    """(team, week) -> {passAtt, rushAtt, ...} team totals."""
    tot = defaultdict(lambda: defaultdict(float))
    for r in rows:
        t = tot[(r['team'], r['week'])]
        for k, v in r['stats'].items():
            t[k] += v
    return tot


def defense_week_totals(rows):
    """(defense, week, pos) -> allowed stat totals."""
    tot = defaultdict(lambda: defaultdict(float))
    for r in rows:
        if not r['opp']:
            continue
        t = tot[(r['opp'], r['week'], r['pos'])]
        for k, v in r['stats'].items():
            t[k] += v
    return tot


class SeasonState:
    """Everything a walk-forward prediction needs, indexed so any week can be
    answered using only earlier weeks."""

    def __init__(self, season, params):
        self.season = season
        self.p = params
        self.rows = load_weekly(season)
        self.prior_rows = load_weekly(season - 1)
        self.home = home_teams(season)
        self.by_week = defaultdict(list)
        for r in self.rows:
            self.by_week[r['week']].append(r)
        self.team_tot = team_week_totals(self.rows)
        self.def_tot = defense_week_totals(self.rows)
        self.prior_team_tot = team_week_totals(self.prior_rows)
        self.prior_def_tot = defense_week_totals(self.prior_rows)
        self.prior_player = self._prior_player_rates()
        self.prior_def = self._def_rates(self.prior_rows, self.prior_team_tot, None)
        self.prior_team_pg = self._team_per_game(self.prior_rows)
        self.prior_league = self._league_rates(self.prior_rows)

    # ---- priors from the prior season -----------------------------------

    def _team_per_game(self, rows):
        """team -> {passAtt, rushAtt} per game."""
        tot = defaultdict(lambda: defaultdict(float))
        games = defaultdict(set)
        for r in rows:
            games[r['team']].add(r['week'])
            for k in ('passAtt', 'rushAtt'):
                tot[r['team']][k] += r['stats'][k]
        return {
            t: {k: v / max(len(games[t]), 1) for k, v in stats.items()}
            for t, stats in tot.items()
        }

    def _league_rates(self, rows):
        """pos -> league-average efficiency rates + median usage shares, the
        fallback prior for a player with no history."""
        agg = defaultdict(lambda: defaultdict(float))
        team_pg = self._team_per_game(rows)
        shares = defaultdict(list)
        by_player = defaultdict(lambda: defaultdict(float))
        player_team = {}
        player_games = defaultdict(set)
        for r in rows:
            a = agg[r['pos']]
            for k, v in r['stats'].items():
                a[k] += v
            bp = by_player[(r['pid'], r['pos'])]
            for k, v in r['stats'].items():
                bp[k] += v
            player_team[(r['pid'], r['pos'])] = r['team']
            player_games[(r['pid'], r['pos'])].add(r['week'])

        out = {}
        for pos, a in agg.items():
            out[pos] = {
                'catch_rate': a['rec'] / a['tgt'] if a['tgt'] else 0.62,
                'ypt': a['recYds'] / a['tgt'] if a['tgt'] else 7.5,
                'rec_td_rate': a['recTD'] / a['tgt'] if a['tgt'] else 0.05,
                'ypc': a['rushYds'] / a['rushAtt'] if a['rushAtt'] else 4.2,
                'rush_td_rate': a['rushTD'] / a['rushAtt'] if a['rushAtt'] else 0.03,
                'comp_pct': a['passComp'] / a['passAtt'] if a['passAtt'] else 0.64,
                'ypa': a['passYds'] / a['passAtt'] if a['passAtt'] else 7.0,
                'pass_td_rate': a['passTD'] / a['passAtt'] if a['passAtt'] else 0.045,
                'int_rate': a['int'] / a['passAtt'] if a['passAtt'] else 0.025,
            }
        # Replacement-level usage share: the median among players with >= 4
        # games, so a rookie's prior is "a real but marginal role", not zero.
        for (pid, pos), tot in by_player.items():
            if len(player_games[(pid, pos)]) < 4:
                continue
            tm = team_pg.get(player_team[(pid, pos)]) or {}
            g = len(player_games[(pid, pos)])
            if tm.get('passAtt'):
                shares[(pos, 'tgt')].append(tot['tgt'] / g / tm['passAtt'])
            if tm.get('rushAtt'):
                shares[(pos, 'rush')].append(tot['rushAtt'] / g / tm['rushAtt'])
                shares[(pos, 'pass')].append(tot['passAtt'] / g / max(tm['passAtt'], 1e-9))
        for (pos, kind), vals in shares.items():
            vals.sort()
            out.setdefault(pos, {})[f'{kind}_share'] = vals[len(vals) // 2] if vals else 0.05
        return out

    def _prior_player_rates(self):
        """(pid, pos) -> prior-season usage shares + efficiency rates."""
        tot = defaultdict(lambda: defaultdict(float))
        games = defaultdict(set)
        team = {}
        for r in self.prior_rows:
            key = (r['pid'], r['pos'])
            for k, v in r['stats'].items():
                tot[key][k] += v
            games[key].add(r['week'])
            team[key] = r['team']
        team_pg = self._team_per_game(self.prior_rows)
        out = {}
        for key, a in tot.items():
            g = max(len(games[key]), 1)
            tm = team_pg.get(team[key]) or {}
            out[key] = {
                'games': g,
                'tgt_share': (a['tgt'] / g / tm['passAtt']) if tm.get('passAtt') else None,
                'rush_share': (a['rushAtt'] / g / tm['rushAtt']) if tm.get('rushAtt') else None,
                'pass_share': (a['passAtt'] / g / tm['passAtt']) if tm.get('passAtt') else None,
                'catch_rate': (a['rec'] / a['tgt']) if a['tgt'] >= 15 else None,
                'ypt': (a['recYds'] / a['tgt']) if a['tgt'] >= 15 else None,
                'rec_td_rate': (a['recTD'] / a['tgt']) if a['tgt'] >= 25 else None,
                'ypc': (a['rushYds'] / a['rushAtt']) if a['rushAtt'] >= 20 else None,
                'rush_td_rate': (a['rushTD'] / a['rushAtt']) if a['rushAtt'] >= 30 else None,
                'comp_pct': (a['passComp'] / a['passAtt']) if a['passAtt'] >= 60 else None,
                'ypa': (a['passYds'] / a['passAtt']) if a['passAtt'] >= 60 else None,
                'pass_td_rate': (a['passTD'] / a['passAtt']) if a['passAtt'] >= 100 else None,
                'int_rate': (a['int'] / a['passAtt']) if a['passAtt'] >= 100 else None,
            }
        return out

    # ---- as-of-week aggregates ------------------------------------------

    def _def_rates(self, rows, team_tot, before_week):
        """(defense, pos) -> volume + efficiency allowed per game / per touch,
        using only weeks strictly before `before_week` (None = all)."""
        tot = defaultdict(lambda: defaultdict(float))
        games = defaultdict(set)
        for r in rows:
            if before_week is not None and r['week'] >= before_week:
                continue
            if not r['opp']:
                continue
            key = (r['opp'], r['pos'])
            for k, v in r['stats'].items():
                tot[key][k] += v
            games[r['opp']].add(r['week'])
        out = {}
        for (d, pos), a in tot.items():
            g = max(len(games[d]), 1)
            out[(d, pos)] = {
                'tgt_pg': a['tgt'] / g,
                'rushAtt_pg': a['rushAtt'] / g,
                'passAtt_pg': a['passAtt'] / g,
                'ypt': a['recYds'] / a['tgt'] if a['tgt'] > 0 else None,
                'ypc': a['rushYds'] / a['rushAtt'] if a['rushAtt'] > 0 else None,
                'ypa': a['passYds'] / a['passAtt'] if a['passAtt'] > 0 else None,
                'n_games': g,
            }
        return out

    def opponent_multipliers(self, week):
        """(defense, pos) -> {vol_tgt, vol_rush, vol_pass, eff_ypt, eff_ypc,
        eff_ypa}, from this season's completed weeks blended over the prior
        season's, shrunk and clamped."""
        cur = self._def_rates(self.rows, self.team_tot, week)
        n_weeks = max((v['n_games'] for v in cur.values()), default=0)
        w_cur = n_weeks / (n_weeks + self.p['opp_blend_k']) if n_weeks else 0.0
        keys = set(cur) | set(self.prior_def)

        # league averages for each field, per position
        def league(table, pos, field):
            vals = [v[field] for (d, p), v in table.items()
                    if p == pos and v.get(field)]
            return sum(vals) / len(vals) if vals else None

        out = {}
        for (d, pos) in keys:
            row = {}
            for field, key, shrink in (
                ('tgt_pg', 'vol_tgt', self.p['opp_shrink_vol']),
                ('rushAtt_pg', 'vol_rush', self.p['opp_shrink_vol']),
                ('passAtt_pg', 'vol_pass', self.p['opp_shrink_vol']),
                ('ypt', 'eff_ypt', self.p['opp_shrink_eff']),
                ('ypc', 'eff_ypc', self.p['opp_shrink_eff']),
                ('ypa', 'eff_ypa', self.p['opp_shrink_eff']),
            ):
                ratios = []
                weights = []
                for table, wt in ((self.prior_def, 1 - w_cur), (cur, w_cur)):
                    if wt <= 0:
                        continue
                    avg = league(table, pos, field)
                    v = (table.get((d, pos)) or {}).get(field)
                    if avg and v:
                        ratios.append(v / avg)
                        weights.append(wt)
                if not ratios:
                    row[key] = 1.0
                    continue
                ratio = sum(r * w for r, w in zip(ratios, weights)) / sum(weights)
                row[key] = round(clamped(ratio, shrink, self.p['opp_clamp']), 4)
            out[(d, pos)] = row
        return out

    def team_volume(self, week):
        """team -> projected {passAtt, rushAtt} per game for `week`, from this
        season's completed weeks blended over the prior season's."""
        tot = defaultdict(lambda: defaultdict(float))
        games = defaultdict(set)
        for (t, w), stats in self.team_tot.items():
            if w >= week:
                continue
            games[t].add(w)
            for k in ('passAtt', 'rushAtt'):
                tot[t][k] += stats[k]
        league_prior = {}
        for k in ('passAtt', 'rushAtt'):
            vals = [v[k] for v in self.prior_team_pg.values() if v.get(k)]
            league_prior[k] = sum(vals) / len(vals) if vals else (33.0 if k == 'passAtt' else 26.0)
        out = {}
        teams = set(tot) | set(self.prior_team_pg)
        for t in teams:
            n = len(games.get(t, ()))
            row = {}
            for k in ('passAtt', 'rushAtt'):
                obs = (tot[t][k] / n) if n else 0.0
                prior = (self.prior_team_pg.get(t) or {}).get(k) or league_prior[k]
                row[k] = blend(obs, float(n), prior, self.p['k_team'])
            out[t] = row
        return out

    def player_history(self, week):
        """(pid, pos) -> per-game history before `week`, newest first."""
        hist = defaultdict(list)
        for w in range(week - 1, 0, -1):
            for r in self.by_week.get(w, ()):
                hist[(r['pid'], r['pos'])].append(r)
        return hist


# ── the projection itself ────────────────────────────────────────────────

def project_week(state, week, targets=None):
    """Project every player who played in `week` (or, in live mode, the roster
    passed in via `targets`), using only weeks 1..week-1."""
    p = state.p
    hl = p['half_life']
    opp_mult = state.opponent_multipliers(week)
    team_vol = state.team_volume(week)
    hist = state.player_history(week)
    league = state.prior_league

    rows = targets if targets is not None else state.by_week.get(week, [])
    out = []
    for r in rows:
        pos, pid, team, opp = r['pos'], r['pid'], r['team'], r['opp']
        h = hist.get((pid, pos), [])
        prior = state.prior_player.get((pid, pos)) or {}
        lg = league.get(pos, {})
        om = opp_mult.get((opp, pos), {}) if opp else {}
        home = state.home.get((team, week))
        hm = p['home_mult'] if home else (2 - p['home_mult'] if home is False else 1.0)
        tv = team_vol.get(team) or {'passAtt': 33.0, 'rushAtt': 26.0}

        def rate(numer, denom, k, prior_key, default):
            """Blend an exponentially-weighted in-season rate with the player's
            prior-season rate (falling back to the positional average)."""
            obs, ev = ewma_ratio(
                [(g['stats'][numer], g['stats'][denom]) for g in h], hl)
            pr = prior.get(prior_key)
            if pr is None:
                pr = lg.get(prior_key, default)
            return blend(obs, ev, pr, k), ev

        def share(stat, team_stat, k, prior_key, default_key):
            """Usage share: the player's stat as a fraction of his team's, per
            game, blended with his prior-season share."""
            pairs = []
            for g in h:
                tt = state.team_tot.get((g['team'], g['week']), {})
                denom = tt.get(team_stat, 0.0)
                if denom > 0:
                    pairs.append((g['stats'][stat], denom))
            obs, ev = ewma_ratio(pairs, hl)
            pr = prior.get(prior_key)
            if pr is None:
                pr = lg.get(default_key, 0.05)
            return blend(obs, ev / max(tv[team_stat], 1e-9), pr, k)

        n_games = len(h)
        line = {}
        if pos == 'QB':
            pass_share = share('passAtt', 'passAtt', p['k_pass_share'],
                               'pass_share', 'pass_share')
            att = pass_share * tv['passAtt'] * om.get('vol_pass', 1.0) * hm
            comp_pct, _ = rate('passComp', 'passAtt', p['k_comp_pct'], 'comp_pct', 0.64)
            ypa, _ = rate('passYds', 'passAtt', p['k_ypa'], 'ypa', 7.0)
            td_rate, _ = rate('passTD', 'passAtt', p['k_pass_td_rate'], 'pass_td_rate', 0.045)
            int_rate, _ = rate('int', 'passAtt', p['k_int_rate'], 'int_rate', 0.025)
            line['passAtt'] = att
            line['passComp'] = att * comp_pct
            line['passYds'] = att * ypa * om.get('eff_ypa', 1.0)
            line['passTD'] = att * td_rate
            line['int'] = att * int_rate

        if pos in ('RB', 'WR', 'TE', 'QB'):
            rush_share = share('rushAtt', 'rushAtt', p['k_rush_share'],
                               'rush_share', 'rush_share')
            carries = rush_share * tv['rushAtt'] * om.get('vol_rush', 1.0) * hm
            ypc, _ = rate('rushYds', 'rushAtt', p['k_ypc'], 'ypc', 4.2)
            rtd, _ = rate('rushTD', 'rushAtt', p['k_rush_td_rate'], 'rush_td_rate', 0.03)
            line['rushAtt'] = carries
            line['rushYds'] = carries * ypc * om.get('eff_ypc', 1.0)
            line['rushTD'] = carries * rtd

        if pos in ('RB', 'WR', 'TE'):
            tgt_share = share('tgt', 'passAtt', p['k_tgt_share'], 'tgt_share', 'tgt_share')
            tgts = tgt_share * tv['passAtt'] * om.get('vol_tgt', 1.0) * hm
            catch, _ = rate('rec', 'tgt', p['k_catch_rate'], 'catch_rate', 0.65)
            ypt, _ = rate('recYds', 'tgt', p['k_ypt'], 'ypt', 7.5)
            rtd_rate, _ = rate('recTD', 'tgt', p['k_rec_td_rate'], 'rec_td_rate', 0.05)
            line['tgt'] = tgts
            line['rec'] = tgts * catch
            line['recYds'] = tgts * ypt * om.get('eff_ypt', 1.0)
            line['recTD'] = tgts * rtd_rate

        line['pprPts'] = (
            line.get('passYds', 0) * 0.04 + line.get('passTD', 0) * 4
            - line.get('int', 0) * 2
            + line.get('rushYds', 0) * 0.1 + line.get('rushTD', 0) * 6
            + line.get('recYds', 0) * 0.1 + line.get('recTD', 0) * 6
            + line.get('rec', 0)
        )

        keys = STAT_KEYS[pos]
        out.append({
            'pid': pid,
            'name': r['name'],
            'pos': pos,
            'team': team,
            'opp': opp,
            'week': week,
            'home': home,
            'nGames': n_games,
            'proj': [round(line.get(k, 0.0), 3) for k in keys],
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--season', type=int, default=2025)
    ap.add_argument('--week', type=int, help='project one week only (live mode)')
    ap.add_argument('--from-week', type=int, default=1)
    ap.add_argument('--params', help='JSON of fitted PARAMS overrides '
                    '(default: public/data/inseason-params.json when present)')
    ap.add_argument('--out', help='output path override')
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args()

    params = dict(PARAMS)
    params_meta = None
    path_params = args.params
    if path_params is None:
        default = os.path.join(DATA, 'inseason-params.json')
        path_params = default if os.path.exists(default) else None
    if path_params:
        with open(path_params) as f:
            doc = json.load(f)
        params.update(doc.get('params') or doc)
        params_meta = {
            'source': os.path.basename(path_params),
            'fitSeasons': doc.get('fitSeasons'),
            'objective': doc.get('objective'),
        }
        if params_meta['fitSeasons'] and args.season in params_meta['fitSeasons']:
            print(f'  ⚠ season {args.season} is in the fitted params\' fitSeasons '
                  f'{params_meta["fitSeasons"]} — results will be in-sample.')

    state = SeasonState(args.season, params)
    weeks = [args.week] if args.week else range(args.from_week, WEEKS + 1)
    preds = []
    for w in weeks:
        got = project_week(state, w)
        preds.extend(got)
        if not args.quiet:
            print(f'  week {w}: {len(got)} players projected '
                  f'({sum(1 for g in got if g["nGames"] == 0)} with no in-season history)')

    out = {
        'season': args.season,
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'weeks': sorted({p['week'] for p in preds}),
        'note': (
            'Walk-forward in-season projections: every week is built from that '
            "season's earlier weeks plus the prior season, never from the week "
            'being projected. Usage (share of team plays) and efficiency (per '
            'touch) are projected separately and multiplied, each an '
            'empirical-Bayes blend of an exponentially-weighted in-season rate '
            f'(half-life {params["half_life"]} games) with the prior-season '
            'rate, falling back to the positional replacement level. Opponent '
            'adjustments are split into volume-allowed and efficiency-allowed '
            'so they cannot double-count, computed from completed weeks only '
            'and blended with the prior season while the sample is thin. '
            'Projections are conditional on the player appearing — the basis '
            'external projections are scored on. Scored in '
            f'weekly-backtest-{args.season}.json.'
        ),
        'params': params,
        'paramsMeta': params_meta,
        'statKeys': {k: list(v) for k, v in STAT_KEYS.items()},
        'players': preds,
    }
    path = args.out or os.path.join(DATA, f'inseason-projections-{args.season}.json')
    with open(path, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    if not args.quiet:
        kb = os.path.getsize(path) / 1024
        print(f'Wrote {path} ({kb:.0f} KB): {len(preds)} player-weeks')


if __name__ == '__main__':
    main()
