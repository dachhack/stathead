#!/usr/bin/env python3
"""Devy rankings: one headline value per college player, priced on the dynasty scale.

RULE: third-party values and ranks (the KTC devy market, KTC future-pick
values) are INPUTS here, never outputs. Nothing written to devy-rankings.json
is a market number or a market rank.

Inputs:
1. The market price: KTC's devy value for the ~100 players it lists
   (ktc_rankings_devy.json; in 1QB, his superflex value through a smooth
   per-position line, one_qb_map); for everyone else the devy value model
   (scripts/train_devy_value_model.py -> devy-value-scores.json: P(listed) x
   the value a listed player with his profile gets).
2. Hit probability, our career model, PER FORMAT (scripts/train_devy_model.py
   -> devy-model-scores.json): the chance of at least one fantasy-starter
   season in his first four NFL seasons (above replacement PPR PPG for that
   format: 12 teams; 1QB: QB13 / RB30 / WR42 / TE13; superflex / 2QB: QB25);
   and his draft-day outlook (Day 1 / Day 2 / Day 3 / undrafted).

Composite, the headline: market z = z-score of log market price over the
board; career z = normal score of his rank by hit probability x the value of a
hit at his position (hitValue);
composite = (1-w) x market z + w x career z. w = the career model's held-out
skill at his position and distance from the draft (0.75 x Spearman, halved
where it does not beat last-season production, 0.05-0.35), or the backtest's
adopted weight where it validated better (devy-backtest.json); never above
0.5. compositeValue = a smooth value-by-rank curve fitted to the market's
scale, at his composite rank.

Shown alongside: marketValue / marketRank = the devy value model's price for
everyone (ours, including for listed players); marketListed; hitProb, its
rank and percentile; careerVsMarket = market rank minus career rank;
draftOutlook.

Dynasty scale: within each draft class the composite rank is his expected
rookie-draft slot (12 teams: 1-4 Early 1st, 5-8 Mid, ...), priced on a smooth
curve fitted to the future-pick values for that year and format, so a devy
player reads against NFL players and picks (get_dynasty_values).

Depth: every current college skill player the value model scores (thousands),
no cutoff. Market z and career z are standardized over that whole pool, as in
the backtest (each class's whole population). Deep values are small and flat
(one decimal below 10); the rank carries the information there.

Output: public/data/devy-rankings.json (compact). Stdlib only. Usage:
python3 scripts/build-devy-rankings.py [data_dir]
"""
from __future__ import annotations

import json
import math
import re
import sys
from statistics import NormalDist
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from devy_names import norm_name  # noqa: E402

# The first draft class still in college: next year's until this year's NFL
# draft (late April) is done, then the one after.
_TODAY = datetime.now(timezone.utc)
FIRST_CLASS = _TODAY.year + (1 if _TODAY.month >= 5 else 0)
POSITIONS = ('QB', 'RB', 'WR', 'TE')
# No depth cutoff: every current college skill player the value model scores
# is on the board (thousands), ranked; deep values are small and flat, the
# rank carries the information there.
# Composite: the career model's weight is its own held-out skill at that
# position and distance from the draft (devy-model.json metrics.ppg[pos][k]):
# CAREER_W_SCALE x Spearman, halved where it does not beat last-season
# production, clamped to [CAREER_W_MIN, CAREER_W_MAX]. The market takes the rest.
CAREER_W_SCALE = 0.75
CAREER_W_MIN, CAREER_W_MAX = 0.05, 0.35
CAREER_W_FALLBACK = 0.15
# Profile fields carried on the board (the value model writes more).
# n_seasons = college seasons with stats, this one included (0 = recruit only):
# how much evidence a deep ranking rests on.
PROFILE_SHOWN = ('est_age', 'est_draft_age', 'breakout_age', 'best_dominator', 'last_usage', 'sp_last',
                 'stars', 'n_seasons')
TIERS = ('Early', 'Mid', 'Late')
TIER_SLOT = {'Early': 2.5, 'Mid': 6.5, 'Late': 10.5}
ROUND_WORD = {1: '1st', 2: '2nd', 3: '3rd', 4: '4th'}
FMTS = ('sf', 'oneQB')


def career_weights(cmodel: dict) -> dict:
    """{pos: {k: weight}} from the career model's held-out metrics."""
    out = {}
    met = cmodel.get('metrics') or {}
    for pos, by_k in (met.get('hit_oneQB') or met.get('ppg') or {}).items():
        for kk, m in by_k.items():
            if not re.fullmatch(r'k\d+', kk):
                continue
            rho = (m.get('pred') or {}).get('spearman')
            if rho is None:
                continue
            base = (m.get('base_prod') or {}).get('spearman') or 0.0
            w = CAREER_W_SCALE * rho * (1.0 if rho > base else 0.5)
            out.setdefault(pos, {})[int(kk.lstrip('k'))] = round(min(CAREER_W_MAX, max(CAREER_W_MIN, w)), 3)
    return out


def backtest_weights(bt: dict) -> dict:
    """{pos: {k: weight}} the backtest (scripts/backtest_devy_value.py) adopts:
    cells where a weight fitted on past classes beat the skill rule on
    held-out classes."""
    out = {}
    for pos, by_k in ((bt.get('compositeWeights') or {}).get('adopt') or {}).items():
        for kk, w in by_k.items():
            if w is not None:
                out.setdefault(pos, {})[int(kk.lstrip('k'))] = float(w)
    return out


def career_weight(p, weights: dict, adopted: dict | None = None) -> float:
    # Seasons to the draft counted from the last COMPLETE college season: a
    # few games into a season, the profile is still mostly last year's.
    k = p['draftYear'] - 1 - (p.get('_asOfComplete') or p.get('_asOf') or FIRST_CLASS - 2)
    if adopted and k in (adopted.get(p['pos']) or {}):
        return adopted[p['pos']][k]
    by_k = weights.get(p['pos']) or {}
    if not by_k:
        return CAREER_W_FALLBACK
    return by_k.get(min(max(k, min(by_k)), max(by_k)), CAREER_W_FALLBACK)


def _pct(x):
    return None if x is None else round(100 * float(x), 1)


def _outlook(d):
    """[Day 1, Day 2, Day 3, undrafted] probabilities -> percents."""
    if not d:
        return None
    return {k: round(100 * float(v), 1) for k, v in zip(('day1', 'day2', 'day3', 'undrafted'), d)}


def load(p: Path, default=None):
    try:
        with open(p) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def pick_curve(ktc_rows, value_key) -> dict:
    """year -> sorted [(slot, value)] from KTC's '2027 Early 1st' rows."""
    out = {}
    for r in ktc_rows:
        m = re.match(r'^(\d{4}) (Early|Mid|Late) (\d)(?:st|nd|rd|th)$', r.get('playerName', ''))
        if not m:
            continue
        y, tier, rnd = int(m.group(1)), m.group(2), int(m.group(3))
        out.setdefault(y, []).append(((rnd - 1) * 12 + TIER_SLOT[tier], float(r.get(value_key) or 0)))
    return {y: sorted(v) for y, v in out.items()}


def _quad_fit(xs, ys):
    """Least-squares y = a + b x + c x^2 (stdlib)."""
    n = len(xs)
    if n < 3:
        a = sum(ys) / n if n else 0.0
        return (a, 0.0, 0.0)
    S = [sum(x ** k for x in xs) for k in range(5)]
    T = [sum(y * x ** k for x, y in zip(xs, ys)) for k in range(3)]
    M = [[S[0], S[1], S[2], T[0]], [S[1], S[2], S[3], T[1]], [S[2], S[3], S[4], T[2]]]
    for i in range(3):
        piv = M[i][i] or 1e-12
        for j in range(i + 1, 3):
            r = M[j][i] / piv
            M[j] = [a - r * b for a, b in zip(M[j], M[i])]
    c = M[2][3] / (M[2][2] or 1e-12)
    b = (M[1][3] - M[1][2] * c) / (M[1][1] or 1e-12)
    a = (M[0][3] - M[0][1] * b - M[0][2] * c) / (M[0][0] or 1e-12)
    return (a, b, c)


def _round10(v: float) -> int:
    """Our scale's display: tens above 100, units below; tops out at 9,990."""
    return int(min(9990, max(0, round(v, -1) if v >= 100 else round(v))))


def _shown(v: float) -> float:
    """_round10, plus one decimal below 10 (deep in the board)."""
    return _round10(v) if v >= 10 else round(max(0.0, v), 1)


def _lstsq(rows, ys):
    """Least squares by the normal equations (stdlib)."""
    n = len(rows[0])
    A = [[sum(r[i] * r[j] for r in rows) for j in range(n)] + [sum(r[i] * y for r, y in zip(rows, ys))]
         for i in range(n)]
    for i in range(n):
        piv = max(range(i, n), key=lambda k: abs(A[k][i]))
        A[i], A[piv] = A[piv], A[i]
        d = A[i][i] or 1e-12
        A[i] = [x / d for x in A[i]]
        for k in range(n):
            if k != i and A[k][i]:
                f = A[k][i]
                A[k] = [x - f * y for x, y in zip(A[k], A[i])]
    return [A[i][n] for i in range(n)]


# 1QB market input from the superflex one. The market's own 1QB devy prices
# are noisy against its superflex prices, above all at QB (residual SD 0.59
# in log value, against 0.15-0.24 elsewhere): it reorders QBs by format
# (Chambliss over Mensah in 1QB, the reverse in superflex) where nothing in
# either player changes with the format. So for a listed player the 1QB input
# is his superflex price through a per-position line in log value, fitted
# over the listed players (OLS: the expected 1QB price at that superflex
# price). Within a position the 1QB order is the superflex order; the format
# moves positions against each other, and the career model (above
# replacement in 1QB) adds the rest. Unlisted players keep the value model's
# own 1QB price. ONEQB_MIN_ROWS: fewer listed at a position -> pooled fit.
ONEQB_MIN_ROWS = 5


def one_qb_map(ktc) -> dict:
    pairs = {}
    for k in ktc:
        sf, one = k.get('superflexValue') or 0, k.get('value') or 0
        if sf > 0 and one > 0:
            pairs.setdefault(k['position'], []).append((math.log(sf), math.log(one)))
    pooled = [xy for v in pairs.values() for xy in v]
    out = {}
    for pos in POSITIONS:
        rows = pairs.get(pos) or []
        rows = rows if len(rows) >= ONEQB_MIN_ROWS else pooled
        if len(rows) < 2:
            continue
        b, c = _lstsq([(x, 1.0) for x, _ in rows], [y for _, y in rows])
        out[pos] = (b, c)
    return out


RANK_KNOTS = tuple(math.log(k) for k in (2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048))


def fit_rank_curve(values_desc):
    """rank -> value: log value as a linear spline in log rank (knots at ranks
    2, 4, 8, ... 2048), fitted to the market's sorted values; rounded (tens
    above 100, one decimal below 10), at most 9,990.

    Every segment must slope down: where the unconstrained fit rises between
    two knots (the market's values bunch, as 1QB's do around ranks 32-64), the
    knot is dropped and the spline refit, so value strictly falls with rank
    instead of the old clamp's flat plateau (34 players at one 1QB value)."""
    pts = [(math.log(i + 1), math.log(v)) for i, v in enumerate(values_desc) if v > 0]
    knots = [k for k in RANK_KNOTS if k < pts[-1][0]] if pts else []
    coef = None
    while pts:
        basis = lambda x, kn=tuple(knots): [1.0, x] + [max(0.0, x - k) for k in kn]  # noqa: E731
        if len(pts) <= len(knots) + 2:
            knots = knots[:-1]
            continue
        coef = _lstsq([basis(x) for x, _ in pts], [y for _, y in pts])
        slopes = [sum(coef[1:2 + j]) for j in range(len(knots) + 1)]   # slope of segment j
        rising = [j for j, sl in enumerate(slopes) if sl > 0]
        if not rising or not knots:
            break
        # Drop the knot that opens the first rising segment (or closes it, for
        # the first segment) and refit.
        knots.pop(max(0, rising[0] - 1))
    cache = {}

    def f(rank: int) -> int:
        if rank not in cache:
            v = math.exp(sum(c * z for c, z in zip(coef, basis(math.log(rank))))) if coef else 0.0
            prev = f(rank - 1) if rank > 1 else 9990
            cache[rank] = min(prev, _shown(v))
        return cache[rank]
    return f


def smooth_slot_curve(pick_curve_pts):
    """class slot -> dynasty value: log pick value quadratic in slot, fitted to
    the market's future-pick values for that year; the 1.01-1.02 capped at
    +25% over the fitted Early 1st; past the last fitted slot, decays by e per
    round. Monotone, rounded to 10."""
    pts = [(s, math.log(v)) for s, v in pick_curve_pts if v > 0]
    if not pts:
        return lambda slot: 0
    a, b, c = _quad_fit([s for s, _ in pts], [y for _, y in pts])
    s_first, s_last = pts[0][0], pts[-1][0]
    g = lambda s: math.exp(a + b * s + c * s * s)  # noqa: E731
    cache = {}

    def f(slot: int) -> int:
        if slot not in cache:
            if slot < s_first:
                v = min(g(s_first) * 1.25, g(slot))
            elif slot <= s_last:
                v = g(slot)
            else:
                v = g(s_last) * math.exp(-(slot - s_last) / 12)
            prev = f(slot - 1) if slot > 1 else 99999
            cache[slot] = min(prev, _round10(v))
        return cache[slot]
    return f


def slot_label(year: int, slot: int) -> str:
    rnd = (slot - 1) // 12 + 1
    tier = TIERS[min(2, ((slot - 1) % 12) // 4)]
    return f'{year} {tier} {ROUND_WORD[rnd]}' if rnd <= 4 else f'{year} beyond round 4'


def main() -> None:
    data = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('public/data')
    ktc = [k for k in load(data / 'ktc_rankings_devy.json', []) if (k.get('draftYear') or FIRST_CLASS) >= FIRST_CLASS
           and k.get('position') in POSITIONS]
    vdoc = load(data / 'devy-value-scores.json', {}) or {}
    cdoc = load(data / 'devy-model-scores.json', {}) or {}
    vmodel = load(data / 'devy-value-model.json', {}) or {}
    cweights = career_weights(load(data / 'devy-model.json', {}) or {})
    adopted = backtest_weights(load(data / 'devy-backtest.json', {}) or {})
    career_by_id = {c['cfbdId']: c for c in cdoc.get('players', [])}
    career_2027 = {norm_name(r['name']): r for r in load(data / 'career-2027.json', []) or []}
    curves = {'sf': pick_curve(load(data / 'ktc_rankings_superflex.json', []), 'superflexValue'),
              'oneQB': pick_curve(load(data / 'ktc_rankings_1qb.json', []), 'value')}

    vals = vdoc.get('players', [])
    by_ktc = {v['ktcId']: v for v in vals if v.get('ktcId')}

    # The draft outlook only where it validated: held-out log loss below the
    # base rate's for that position and distance from the draft (QB and TE
    # three seasons out did not).
    dmet = (load(data / 'devy-model.json', {}) or {}).get('draftMetrics') or {}
    as_of = int(cdoc.get('asOfSeason') or 0)

    def draft_ok(pos, draft_year) -> bool:
        m = (dmet.get(pos) or {}).get(f'k{int(draft_year) - 1 - as_of}')
        return bool(m) and m.get('logLoss', 9) < m.get('logLossBaseRate', 0)

    def row(name, pos, school, draft_year, v, k):
        cs = career_by_id.get((v or {}).get('cfbdId')) if v else None
        c27 = career_2027.get(norm_name(name))
        ktc_val = {'sf': (k or {}).get('superflexValue') or 0, 'oneQB': (k or {}).get('value') or 0}
        model_val = {f: float(((v or {}).get('value') or {}).get(f) or 0) for f in FMTS}
        return {
            'name': name, 'pos': pos, 'school': school, 'draftYear': draft_year,
            'cfbdId': (v or {}).get('cfbdId'),
            # INTERNAL ONLY (popped before writing): the market input to the
            # composite, KTC's own price where it lists him, else the value
            # model's. Third-party values and ranks are factors in ours, never
            # shown.
            '_mkt': {f: ktc_val[f] if ktc_val[f] > 0 else model_val[f] for f in FMTS},
            '_ktc_sf': ktc_val['sf'],
            # Shown: the devy value model's price (our read of what the market
            # pays for his profile), for every player.
            'marketValue': {f: _shown(model_val[f]) for f in FMTS},
            '_mv': model_val,
            '_hit': {f: ((cs or {}).get('hit', {}).get(f, {}) or {}).get(str(draft_year)) for f in FMTS},
            'marketListed': bool(k),
            'pListed': (v or {}).get('pListed'),
            # NFL projection, per format: points per game above replacement in
            # 1QB or superflex / 2QB leagues (comparable across positions), and
            # the raw PPG it comes from.
            # Chance of a fantasy-starter season in his first four NFL
            # seasons, in this format (percent), and his draft-day outlook.
            'hitProb': {f: _pct(((cs or {}).get('hit', {}).get(f, {}) or {}).get(str(draft_year))) for f in FMTS},
            'draftOutlook': (_outlook(((cs or {}).get('draft') or {}).get(str(draft_year)))
                             if draft_ok(pos, draft_year) else None),
            'profile': ({c: v['profile'].get(c) for c in PROFILE_SHOWN}
                        if v and v.get('profile') else None),
            '_asOf': (vdoc.get('inSeason') or {}).get('season') or vdoc.get('asOfSeason'),
            '_asOfComplete': vdoc.get('asOfSeason'),
            'careerModel2027': ({'ppg': c27['model']['predictedCareerPPG'], 'tier': c27['model']['tierLabel'],
                                 'projPick': c27.get('projPick')} if c27 and c27.get('model') else None),
        }

    # School: the college data's name where we have him (one spelling across the board).
    players = [row(k['playerName'], k['position'],
                   (by_ktc.get(k.get('playerID')) or {}).get('team') or k.get('teamLongName') or k.get('team'),
                   k.get('draftYear') or FIRST_CLASS, by_ktc.get(k.get('playerID')), k) for k in ktc]
    for v in vals:
        if not v.get('ktcId') and v['draftYear'] >= FIRST_CLASS:
            players.append(row(v['name'], v['pos'], v.get('team'), v['draftYear'], v, None))

    # 1QB market input for listed players: their superflex price through the
    # per-position line (one_qb_map), not the market's own 1QB price.
    oneqb = one_qb_map(ktc)
    for p in players:
        if p['_ktc_sf'] > 0 and p['pos'] in oneqb:
            b, c = oneqb[p['pos']]
            p['_mkt']['oneQB'] = math.exp(b * math.log(p['_ktc_sf']) + c)

    for f in FMTS:
        # Market rank: by the value model's price (ours), not the market's own.
        order = sorted(players, key=lambda p: -p['_mv'][f])
        for i, p in enumerate(order):
            p.setdefault('marketRank', {})[f] = i + 1
        for pos in POSITIONS:
            for j, p in enumerate([p for p in order if p['pos'] == pos]):
                p.setdefault('marketPosRank', {})[f] = j + 1
        # Career value is above replacement in THIS format, so it compares
        # across positions: rank it over the whole board, percentile included,
        # and set it against the devy-value rank (a superflex QB can rank far
        # higher than the same QB in 1QB, on both scores).
        # Career rank score: hit chance x what a hit is worth at his position
        # in this format (hitValue, devy-model.json), so positions share one
        # scale; within a position the order is the hit chance's.
        hv = (cdoc.get('hitValue') or {}).get(f) or {}
        scored = [p for p in order if p['hitProb'][f] is not None]
        for p in scored:
            p.setdefault('_rs', {})[f] = p['_hit'][f] * hv.get(p['pos'], 1.0)
        by_career = sorted(scored, key=lambda p: -p['_rs'][f])
        for j, p in enumerate(by_career):
            p.setdefault('careerRank', {})[f] = j + 1
            p.setdefault('careerPct', {})[f] = round(100 * (1 - (j + 0.5) / len(by_career)))
            p.setdefault('careerVsMarket', {})[f] = p['marketRank'][f] - (j + 1)
        # Composite: the market (devy value) and our NFL projection (career
        # score) on one standardized scale, blended with a weight set by the
        # career model's held-out skill (career_weight), then re-sorted and handed the
        # market's own sorted values. So a composite value is still on KTC's
        # scale and only the ORDER is ours, and one noisy model can move a
        # player but not zero him (Kewan Lacy is 0.0 above replacement).
        #   market z = z-score of log devy value over the board;
        #   career z = rank-based normal score of the career score over the
        #              board (raw PPG breaks ties).
        nd = NormalDist()
        logv = [math.log(max(1e-3, p['_mkt'][f])) for p in players]
        mu = sum(logv) / len(logv)
        sd = (sum((x - mu) ** 2 for x in logv) / (len(logv) - 1)) ** 0.5 or 1.0
        # Many players sit at exactly 0 above replacement; the raw PPG
        # projection orders them (a back projected at 6 PPG is not a walk-on),
        # instead of one tied block at the bottom.
        scored.sort(key=lambda p: p['_rs'][f])
        for i, q in enumerate(scored):
            q.setdefault('_cz', {})[f] = nd.inv_cdf((i + 0.5) / len(scored))
        for p in players:
            w = career_weight(p, cweights, adopted) if p.get('_cz', {}).get(f) is not None else 0.0
            mz = (math.log(max(1e-3, p['_mkt'][f])) - mu) / sd
            p.setdefault('_comp', {})[f] = (1 - w) * mz + w * p.get('_cz', {}).get(f, 0.0)
            p.setdefault('compositeWeight', {})[f] = w

    # Format moves positions, never players within one: a QB's worth against
    # other QBs does not depend on how many QBs start. The career half differs
    # by format (above QB13 vs QB25 replacement, standardized over the whole
    # board), so on its own it reorders players within a position (Demond
    # Williams Jr. QB14 in superflex, QB20 in 1QB). So the superflex blend sets
    # the order within each position, and each position keeps the 1QB blend's
    # own scores, handed out in that order: where a position sits against the
    # others still comes from the 1QB blend.
    for pos in POSITIONS:
        grp = [p for p in players if p['pos'] == pos]
        scores = sorted((p['_comp']['oneQB'] for p in grp), reverse=True)
        for p, v in zip(sorted(grp, key=lambda p: -p['_comp']['sf']), scores):
            p['_comp']['oneQB'] = v

    for f in FMTS:
        comp_order = sorted(players, key=lambda p: -p['_comp'][f])
        # Priced on a SMOOTH value-by-rank curve fitted to the market's scale
        # (log value, quadratic in log rank), so no shown value is a market
        # number.
        curve = fit_rank_curve(sorted((p['_mkt'][f] for p in players), reverse=True))
        for i, p in enumerate(comp_order):
            p.setdefault('compositeValue', {})[f] = curve(i + 1)
            p.setdefault('compositeRank', {})[f] = i + 1
        for pos in POSITIONS:
            for j, p in enumerate([p for p in comp_order if p['pos'] == pos]):
                p.setdefault('compositePosRank', {})[f] = j + 1
        # Dynasty scale from the composite class rank, on a smooth curve
        # fitted to the market's future-pick values (not the pick values
        # themselves).
        for dy in {p['draftYear'] for p in players}:
            pc = curves[f].get(dy) or (curves[f].get(max(curves[f])) if curves[f] else [])
            sv = smooth_slot_curve(pc)
            for j, p in enumerate([p for p in comp_order if p['draftYear'] == dy]):
                p.setdefault('dynasty', {})[f] = {'value': sv(j + 1), 'classRank': j + 1,
                                                  'pickEquiv': slot_label(dy, j + 1)}

    for p in players:
        p.pop('_mkt', None)
        p.pop('_ktc_sf', None)
        p.pop('_mv', None)
        p.pop('_hit', None)
        p.pop('_rs', None)
        p.pop('_cz', None)
        p.pop('_comp', None)
        p.pop('_asOf', None)
        p.pop('_asOfComplete', None)
        if p.get('careerModel2027') is None:
            p.pop('careerModel2027', None)
    players.sort(key=lambda p: p['compositeRank']['sf'])
    met = vmodel.get('metrics', {})
    doc = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'modelAsOfSeason': vdoc.get('asOfSeason') or cdoc.get('asOfSeason'),
        # Season to date (scripts/fetch_cfbd_inseason.py): the value model's
        # profiles run through this week; the career model weights it per
        # position and class (careerInSeasonWeight: the share of his career
        # projection that comes from the season-to-date profile, the rest from
        # last season's; chosen by replaying past seasons at the same week).
        'inSeason': ({**vdoc['inSeason'],
                      # {pos: [classes]} with any weight on the season to date.
                      'careerInSeason': {pos: sorted(vdoc['inSeason']['season'] + 1 + int(kk[1:]) for kk, u in by_k.items() if u)
                                         for pos, by_k in ((cdoc.get('inSeason') or {}).get('usedFor') or {}).items()},
                      # {pos: {class: weight}}.
                      'careerInSeasonWeight': {pos: {str(vdoc['inSeason']['season'] + 1 + int(kk[1:])): float(u)
                                                     for kk, u in sorted(by_k.items())}
                                               for pos, by_k in ((cdoc.get('inSeason') or {}).get('usedFor') or {}).items()}}
                     if vdoc.get('inSeason') else None),
        'profilesThrough': (f"{vdoc['inSeason']['season']} week {vdoc['inSeason']['throughWeek']}" if vdoc.get('inSeason')
                            else f"{vdoc.get('asOfSeason')} season"),
        'classes': sorted({p['draftYear'] for p in players}),
        'valueModel': {'spearmanIfListed': {f: met.get(f, {}).get('ridge_spearmanIfListed') for f in FMTS},
                       'aucListed': met.get('pListed', {}).get('aucListedVsUnlistedFBS'),
                       'aucListedVsPlausible': met.get('pListed', {}).get('aucListedVsPlausible')},
        'note': ('Every current college QB/RB/WR/TE the models score, ranked; deep in the board values are small and '
                 'flat (one decimal below 10) and the rank carries the information. profile.n_seasons = college seasons '
                 'with stats, this one included (0 = recruit only). '
                 'Per college player, each PER FORMAT (sf = superflex / 2QB, oneQB = single QB). '
                 'compositeValue / compositeRank = the headline: the devy market and our NFL career projection '
                 'blended in rank space (career weight compositeWeight: the career model\'s held-out skill at his '
                 'position and distance from the draft, or a backtest-fitted weight where that validated better; '
                 'never above 0.5), priced on a smooth value-by-rank curve fitted to the market\'s 0-9999 scale. '
                 'marketValue / marketRank = our devy value model\'s price for his profile (what the market pays '
                 'for a player like him); marketListed = on the market\'s devy list. Third-party values and ranks are '
                 'inputs, never shown. hitProb = our NFL career model in that format: the chance (percent) of at '
                 'least one fantasy-starter season in his first four NFL seasons (a 6+ game season above replacement '
                 'PPR PPG, 12 teams: 1QB QB13/RB30/WR42/TE13, superflex QB25); hitPPG (top level) = what a hit looks '
                 'like at each position. careerRank / careerPct = rank / percentile over the whole board by hitProb x '
                 'hitValue (what a hit is worth at his position in that format, so positions compare). '
                 'careerVsMarket = market rank minus career rank (positive: the career model likes him more). '
                 'draftOutlook = chance (percent) he is drafted on Day 1 (round 1), Day 2 (rounds 2-3), Day 3 '
                 '(rounds 4-7) or not at all, if he enters that draft. '
                 'dynasty.value = the composite class rank priced as a rookie-draft slot on a smooth curve fitted to '
                 'future-pick values for that format. Ages estimated from the high-school class. Profiles run '
                 'through ' + (f"{vdoc['inSeason']['season']} week {vdoc['inSeason']['throughWeek']} (season to date, "
                               'as a calibrated full-season estimate)' if vdoc.get('inSeason')
                               else f"the {vdoc.get('asOfSeason')} season") + '.'),
        'replacementPPG': cdoc.get('replacementPPG'),
        # What a hit looks like: best-two-season PPR PPG of past hits, by format
        # and position (p25 / median / p75), and the historical hit rate.
        'hitPPG': cdoc.get('hitPPG'),
        'hitRate': cdoc.get('hitRate'),
        'hitValue': cdoc.get('hitValue'),
        'composite': {'careerWeights': {pos: {f'k{k}': (adopted.get(pos) or {}).get(k, w) for k, w in sorted(by_k.items())}
                                        for pos, by_k in cweights.items()},
                      'backtestAdopted': {pos: {f'k{k}': w for k, w in sorted(by_k.items())} for pos, by_k in adopted.items()},
                      'rule': (f'{CAREER_W_SCALE} x the career model\'s held-out Spearman, halved where it does not '
                               f'beat last-season production, clamped {CAREER_W_MIN}-{CAREER_W_MAX}; except where the '
                               'backtest on 2010-2022 classes found a better weight on held-out classes (backtestAdopted: '
                               'three seasons from the draft, where the career model outranks the market)')},
        'players': players,
    }
    # Compact: the board runs to thousands of players.
    with open(data / 'devy-rankings.json', 'w') as f:
        json.dump(doc, f, separators=(',', ':'))
    print(f'devy rankings: {len(players)} players ({sum(p["marketListed"] for p in players)} market-listed, '
          f'{sum(not p["marketListed"] for p in players)} modelled), classes {doc["classes"]}')


if __name__ == '__main__':
    main()
