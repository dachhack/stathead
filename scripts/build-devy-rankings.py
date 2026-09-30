#!/usr/bin/env python3
"""Devy rankings: one headline value per college player, priced on the dynasty scale.

RULE: third-party values and ranks (the KTC devy market, KTC future-pick
values) are INPUTS here, never outputs. Nothing written to devy-rankings.json
is a market number or a market rank.

Inputs:
1. The market price: KTC's devy value for the ~100 players it lists
   (ktc_rankings_devy.json); for everyone else the devy value model
   (scripts/train_devy_value_model.py -> devy-value-scores.json: P(listed) x
   the value a listed player with his profile gets).
2. Career score, our projection, PER FORMAT (scripts/train_devy_model.py ->
   devy-model-scores.json): expected mean of his best two NFL seasons in his
   first four, in PPR points per game above replacement for that format
   (12 teams; 1QB: QB13 / RB30 / WR42 / TE13; superflex / 2QB: QB25).

Composite, the headline: market z = z-score of log market price over the
board; career z = normal score of his career-score rank (raw PPG breaks ties);
composite = (1-w) x market z + w x career z. w = the career model's held-out
skill at his position and distance from the draft (0.75 x Spearman, halved
where it does not beat last-season production, 0.05-0.35), or the backtest's
adopted weight where it validated better (devy-backtest.json); never above
0.5. compositeValue = a smooth value-by-rank curve fitted to the market's
scale, at his composite rank.

Shown alongside: marketValue / marketRank = the devy value model's price for
everyone (ours, including for listed players); marketListed; career score,
rank and percentile; careerVsMarket = market rank minus career rank.

Dynasty scale: within each draft class the composite rank is his expected
rookie-draft slot (12 teams: 1-4 Early 1st, 5-8 Mid, ...), priced on a smooth
curve fitted to the future-pick values for that year and format, so a devy
player reads against NFL players and picks (get_dynasty_values).

Output: public/data/devy-rankings.json. Stdlib only. Usage:
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
# Unlisted players shown: modelled SF or 1QB value at least this (KTC's own
# list bottoms out near 20; its 10th percentile is ~500).
MIN_MODELLED = 40
MAX_PLAYERS = 400
# Composite: the career model's weight is its own held-out skill at that
# position and distance from the draft (devy-model.json metrics.ppg[pos][k]):
# CAREER_W_SCALE x Spearman, halved where it does not beat last-season
# production, clamped to [CAREER_W_MIN, CAREER_W_MAX]. The market takes the rest.
CAREER_W_SCALE = 0.75
CAREER_W_MIN, CAREER_W_MAX = 0.05, 0.35
CAREER_W_FALLBACK = 0.15
TIERS = ('Early', 'Mid', 'Late')
TIER_SLOT = {'Early': 2.5, 'Mid': 6.5, 'Late': 10.5}
ROUND_WORD = {1: '1st', 2: '2nd', 3: '3rd', 4: '4th'}
FMTS = ('sf', 'oneQB')


def career_weights(cmodel: dict) -> dict:
    """{pos: {k: weight}} from the career model's held-out metrics."""
    out = {}
    for pos, by_k in ((cmodel.get('metrics') or {}).get('ppg') or {}).items():
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


RANK_KNOTS = tuple(math.log(k) for k in (2, 4, 8, 16, 32, 64, 128))


def fit_rank_curve(values_desc):
    """rank -> value: log value as a linear spline in log rank (knots at ranks
    2, 4, 8, ... 128), fitted to the market's sorted values; monotone (never
    rises with rank), rounded (tens above 100), at most 9,990."""
    pts = [(math.log(i + 1), math.log(v)) for i, v in enumerate(values_desc) if v > 0]
    knots = [k for k in RANK_KNOTS if k < pts[-1][0]] if pts else []
    basis = lambda x: [1.0, x] + [max(0.0, x - k) for k in knots]  # noqa: E731
    coef = _lstsq([basis(x) for x, _ in pts], [y for _, y in pts]) if len(pts) > len(knots) + 2 else None
    cache = {}

    def f(rank: int) -> int:
        if rank not in cache:
            v = math.exp(sum(c * z for c, z in zip(coef, basis(math.log(rank))))) if coef else 0.0
            prev = f(rank - 1) if rank > 1 else 9990
            cache[rank] = min(prev, _round10(v))
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
            # Shown: the devy value model's price (our read of what the market
            # pays for his profile), for every player.
            'marketValue': {f: int(round(model_val[f], -1)) if model_val[f] >= 10 else int(round(model_val[f]))
                            for f in FMTS},
            'marketListed': bool(k),
            'pListed': (v or {}).get('pListed'),
            # NFL projection, per format: points per game above replacement in
            # 1QB or superflex / 2QB leagues (comparable across positions), and
            # the raw PPG it comes from.
            'careerScore': {f: ((cs or {}).get('vor', {}).get(f, {}) or {}).get(str(draft_year)) for f in FMTS},
            'careerPPG': (cs or {}).get('score', {}).get(str(draft_year)),
            'profile': (v or {}).get('profile'),
            '_asOf': (vdoc.get('inSeason') or {}).get('season') or vdoc.get('asOfSeason'),
            '_asOfComplete': vdoc.get('asOfSeason'),
            'careerModel2027': ({'ppg': c27['model']['predictedCareerPPG'], 'tier': c27['model']['tierLabel'],
                                 'projPick': c27.get('projPick')} if c27 and c27.get('model') else None),
        }

    players = [row(k['playerName'], k['position'], k.get('teamLongName') or k.get('team'),
                   k.get('draftYear') or FIRST_CLASS, by_ktc.get(k.get('playerID')), k) for k in ktc]
    unlisted = [v for v in vals if not v.get('ktcId') and v['draftYear'] >= FIRST_CLASS
                and max(v['value'].get('sf') or 0, v['value'].get('oneQB') or 0) >= MIN_MODELLED]
    unlisted.sort(key=lambda v: -max(v['value'].get('sf') or 0, v['value'].get('oneQB') or 0))
    for v in unlisted[:max(0, MAX_PLAYERS - len(players))]:
        players.append(row(v['name'], v['pos'], v.get('team'), v['draftYear'], v, None))

    for f in FMTS:
        # Market rank: by the value model's price (ours), not the market's own.
        order = sorted(players, key=lambda p: -p['marketValue'][f])
        for i, p in enumerate(order):
            p.setdefault('marketRank', {})[f] = i + 1
        for pos in POSITIONS:
            for j, p in enumerate([p for p in order if p['pos'] == pos]):
                p.setdefault('marketPosRank', {})[f] = j + 1
        # Career value is above replacement in THIS format, so it compares
        # across positions: rank it over the whole board, percentile included,
        # and set it against the devy-value rank (a superflex QB can rank far
        # higher than the same QB in 1QB, on both scores).
        scored = [p for p in order if p['careerScore'][f] is not None]
        by_career = sorted(scored, key=lambda p: -p['careerScore'][f])
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
        logv = [math.log(max(1, p['_mkt'][f])) for p in players]
        mu = sum(logv) / len(logv)
        sd = (sum((x - mu) ** 2 for x in logv) / (len(logv) - 1)) ** 0.5 or 1.0
        # Many players sit at exactly 0 above replacement; the raw PPG
        # projection orders them (a back projected at 6 PPG is not a walk-on),
        # instead of one tied block at the bottom.
        scored.sort(key=lambda p: (p['careerScore'][f], p.get('careerPPG') or 0.0))
        for i, q in enumerate(scored):
            q.setdefault('_cz', {})[f] = nd.inv_cdf((i + 0.5) / len(scored))
        for p in players:
            w = career_weight(p, cweights, adopted) if p.get('_cz', {}).get(f) is not None else 0.0
            mz = (math.log(max(1, p['_mkt'][f])) - mu) / sd
            p.setdefault('_comp', {})[f] = (1 - w) * mz + w * p.get('_cz', {}).get(f, 0.0)
            p.setdefault('compositeWeight', {})[f] = w
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
        p.pop('_cz', None)
        p.pop('_comp', None)
        p.pop('_asOf', None)
        p.pop('_asOfComplete', None)
    players.sort(key=lambda p: p['compositeRank']['sf'])
    met = vmodel.get('metrics', {})
    doc = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'modelAsOfSeason': vdoc.get('asOfSeason') or cdoc.get('asOfSeason'),
        # Season to date (scripts/fetch_cfbd_inseason.py): the value model's
        # profiles run through this week; the career model uses it at the
        # positions where replaying past seasons at the same week beat the
        # end-of-last-season snapshot (careerInSeasonPositions).
        'inSeason': ({**vdoc['inSeason'],
                      # {pos: [classes]} the career model scores from the season to date.
                      'careerInSeason': {pos: sorted(vdoc['inSeason']['season'] + 1 + int(kk[1:]) for kk, u in by_k.items() if u)
                                         for pos, by_k in ((cdoc.get('inSeason') or {}).get('usedFor') or {}).items()}}
                     if vdoc.get('inSeason') else None),
        'profilesThrough': (f"{vdoc['inSeason']['season']} week {vdoc['inSeason']['throughWeek']}" if vdoc.get('inSeason')
                            else f"{vdoc.get('asOfSeason')} season"),
        'classes': sorted({p['draftYear'] for p in players}),
        'valueModel': {'spearmanIfListed': {f: met.get(f, {}).get('ridge_spearmanIfListed') for f in FMTS},
                       'aucListed': met.get('pListed', {}).get('aucListedVsUnlistedFBS'),
                       'aucListedVsPlausible': met.get('pListed', {}).get('aucListedVsPlausible')},
        'note': ('Per college player, each PER FORMAT (sf = superflex / 2QB, oneQB = single QB). '
                 'compositeValue / compositeRank = the headline: the devy market and our NFL career projection '
                 'blended in rank space (career weight compositeWeight: the career model\'s held-out skill at his '
                 'position and distance from the draft, or a backtest-fitted weight where that validated better; '
                 'never above 0.5), priced on a smooth value-by-rank curve fitted to the market\'s 0-9999 scale. '
                 'marketValue / marketRank = our devy value model\'s price for his profile (what the market pays '
                 'for a player like him); marketListed = on the market\'s devy list. Third-party values and ranks are '
                 'inputs, never shown. careerScore = our NFL projection in that format: expected mean of his best two '
                 'NFL seasons in his first four in PPR points per game above replacement (12 teams; 1QB QB13/RB30/'
                 'WR42/TE13, superflex QB25); careerPPG = the raw projection; careerRank / careerPct over the whole '
                 'board. careerVsMarket = market rank minus career rank (positive: the projection likes him more). '
                 'dynasty.value = the composite class rank priced as a rookie-draft slot on a smooth curve fitted to '
                 'future-pick values for that format. Ages estimated from the high-school class. Profiles run '
                 'through ' + (f"{vdoc['inSeason']['season']} week {vdoc['inSeason']['throughWeek']} (season to date, "
                               'as a calibrated full-season estimate)' if vdoc.get('inSeason')
                               else f"the {vdoc.get('asOfSeason')} season") + '.'),
        'replacementPPG': cdoc.get('replacementPPG'),
        'composite': {'careerWeights': {pos: {f'k{k}': (adopted.get(pos) or {}).get(k, w) for k, w in sorted(by_k.items())}
                                        for pos, by_k in cweights.items()},
                      'backtestAdopted': {pos: {f'k{k}': w for k, w in sorted(by_k.items())} for pos, by_k in adopted.items()},
                      'rule': (f'{CAREER_W_SCALE} x the career model\'s held-out Spearman, halved where it does not '
                               f'beat last-season production, clamped {CAREER_W_MIN}-{CAREER_W_MAX}; except where the '
                               'backtest on 2010-2022 classes found a better weight on held-out classes (backtestAdopted: '
                               'three seasons from the draft, where the career model outranks the market)')},
        'players': players,
    }
    with open(data / 'devy-rankings.json', 'w') as f:
        json.dump(doc, f, indent=1)
    print(f'devy rankings: {len(players)} players ({sum(p["marketListed"] for p in players)} market-listed, '
          f'{sum(not p["marketListed"] for p in players)} modelled), classes {doc["classes"]}')


if __name__ == '__main__':
    main()
