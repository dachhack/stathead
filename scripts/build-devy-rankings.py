#!/usr/bin/env python3
"""Devy rankings: two scores per college player, priced on the dynasty scale.

1. Devy value, the market's price: KTC's own devy value for the ~100 players it
   lists (public/data/ktc_rankings_devy.json, fetched daily); for everyone else,
   the devy value model (scripts/train_devy_value_model.py →
   devy-value-scores.json): P(KTC would list him) x the value KTC would put on a
   listed player with his profile (estimated age and draft age, breakout age,
   share of the offense, counting stats, program, competition level,
   recruiting). Same 0-9999 scale, superflex and 1QB.
2. Career score, our projection, PER FORMAT: scripts/train_devy_model.py →
   devy-model-scores.json, the expected mean of his best two NFL seasons in
   his first four in PPR points per game ABOVE REPLACEMENT for that format
   (12 teams; 1QB: QB13 / RB30 / WR42 / TE13; superflex / 2QB: QB25), so it
   compares across positions and a QB is worth more in superflex. careerPPG
   is the raw projection (not above replacement).

3. Composite, the headline rank: a blend of the two in rank space. Market z
   = z-score of log devy value over the board; career z = normal score of his
   career-score rank (raw PPG breaks ties); composite = (1-w) x market z +
   w x career z. w is the career model's own held-out skill at his position
   and distance from the draft (devy-model.json metrics): 0.75 x Spearman,
   halved where it does not beat last-season production, clamped 0.05-0.35.
   So the market leads everywhere, and most for QBs. The blended order is
   then priced with the market's own sorted value curve, so compositeValue
   stays on KTC's 0-9999 scale.

Both scores, and every rank, are per format: sf = superflex / 2QB, oneQB =
single QB. The board is ordered by composite rank. careerVsValue = overall
rank by devy value minus overall rank by career score in that format
(positive: our NFL projection likes him more than the market does).

Dynasty scale: within each draft class, a player's composite rank is his
expected rookie-draft slot (12 teams: 1-4 Early 1st, 5-8 Mid, 9-12 Late, ...),
priced from KTC's own future pick values for that year and format,
interpolated between tiers; the 1.01-1.02 extend the Early-to-Mid slope
(capped +25%). So a 2028 devy WR reads against NFL players and picks
(get_dynasty_values).

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


def slot_value(curve, slot: float) -> float:
    if not curve:
        return 0.0
    if slot <= curve[0][0]:
        # Above the Early-tier centre (the 1.01 and 1.02 are worth more than an
        # average Early 1st), extend the Early-to-Mid slope, capped at +25%.
        if len(curve) > 1:
            slope = (curve[0][1] - curve[1][1]) / (curve[1][0] - curve[0][0])
            return min(curve[0][1] * 1.25, curve[0][1] + slope * (curve[0][0] - slot))
        return curve[0][1]
    for (s0, v0), (s1, v1) in zip(curve, curve[1:]):
        if slot <= s1:
            return v0 + (v1 - v0) * (slot - s0) / (s1 - s0)
    s_last, v_last = curve[-1]
    return v_last * math.exp(-(slot - s_last) / 12)


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
        return {
            'name': name, 'pos': pos, 'school': school, 'draftYear': draft_year,
            'ktcId': (k or {}).get('playerID'), 'cfbdId': (v or {}).get('cfbdId'),
            # Devy value: KTC's own where it lists him, else the model's.
            'devyValue': {f: int(round(ktc_val[f])) if ktc_val[f] > 0 else int(round(((v or {}).get('value') or {}).get(f) or 0))
                          for f in FMTS},
            'valueSource': 'ktc' if k else 'model',
            'ktc': {'sf': ktc_val['sf'] or None, 'oneQB': ktc_val['oneQB'] or None,
                    'sfRank': (k or {}).get('superflexRank') or None, 'oneQBRank': (k or {}).get('oneQBRank') or None},
            # The value model's read, for listed players out of fold (without
            # having seen him), so it can be set against KTC's actual.
            'modelValue': ((v or {}).get('valueOOF') if k else (v or {}).get('value')) or None,
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
        order = sorted(players, key=lambda p: -p['devyValue'][f])
        for i, p in enumerate(order):
            p.setdefault('rank', {})[f] = i + 1
        for pos in POSITIONS:
            for j, p in enumerate([p for p in order if p['pos'] == pos]):
                p.setdefault('posRank', {})[f] = j + 1
        # Career value is above replacement in THIS format, so it compares
        # across positions: rank it over the whole board, percentile included,
        # and set it against the devy-value rank (a superflex QB can rank far
        # higher than the same QB in 1QB, on both scores).
        scored = [p for p in order if p['careerScore'][f] is not None]
        by_career = sorted(scored, key=lambda p: -p['careerScore'][f])
        for j, p in enumerate(by_career):
            p.setdefault('careerRank', {})[f] = j + 1
            p.setdefault('careerPct', {})[f] = round(100 * (1 - (j + 0.5) / len(by_career)))
            p.setdefault('careerVsValue', {})[f] = p['rank'][f] - (j + 1)
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
        logv = [math.log(max(1, p['devyValue'][f])) for p in players]
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
            mz = (math.log(max(1, p['devyValue'][f])) - mu) / sd
            p.setdefault('_comp', {})[f] = (1 - w) * mz + w * p.get('_cz', {}).get(f, 0.0)
            p.setdefault('compositeWeight', {})[f] = w
        comp_order = sorted(players, key=lambda p: -p['_comp'][f])
        curve_vals = sorted((p['devyValue'][f] for p in players), reverse=True)
        for i, p in enumerate(comp_order):
            p.setdefault('compositeValue', {})[f] = int(curve_vals[i])
            p.setdefault('compositeRank', {})[f] = i + 1
        for pos in POSITIONS:
            for j, p in enumerate([p for p in comp_order if p['pos'] == pos]):
                p.setdefault('compositePosRank', {})[f] = j + 1
        # Dynasty scale from the COMPOSITE class rank (the board's headline),
        # and from the market's class rank for reference.
        for dy in {p['draftYear'] for p in players}:
            curve = curves[f].get(dy) or (curves[f].get(max(curves[f])) if curves[f] else [])
            for key, ordr in (('dynasty', comp_order), ('dynastyMarket', order)):
                for j, p in enumerate([p for p in ordr if p['draftYear'] == dy]):
                    p.setdefault(key, {})[f] = {'value': int(round(slot_value(curve, j + 1))),
                                                'classRank': j + 1, 'pickEquiv': slot_label(dy, j + 1)}

    for p in players:
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
        'note': ('Two scores per college player, each PER FORMAT (sf = superflex / 2QB, oneQB = single QB). '
                 'devyValue = the market price on KTC\'s 0-9999 devy scale: KTC\'s own value where it lists him '
                 '(valueSource ktc), else the devy value model (valueSource model: P(KTC lists him) x the value '
                 'KTC would put on a listed player with his profile), trained separately on KTC\'s superflex and '
                 '1QB values. careerScore = our NFL projection in that format: expected mean of his best two NFL '
                 'seasons in his first four in PPR points per game above replacement (12 teams; 1QB QB13/RB30/'
                 'WR42/TE13, superflex QB25), comparable across positions; careerPPG = the raw projection. '
                 'careerRank / careerPct = over the whole board in that format. careerVsValue = overall devy-value '
                 'rank minus overall career rank (positive: the projection likes him more than the market). '
                 'compositeValue / compositeRank = the headline: market and career blended in rank space '
                 '(career weight compositeWeight = the career model\'s held-out skill at his position and '
                 'distance from the draft: 0.75 x Spearman, halved where it does not beat last-season production), '
                 'priced on the market\'s own value curve. '
                 'dynasty.value = priced as the rookie-draft slot his class rank by composite implies, from KTC '
                 'future pick values for that format (dynastyMarket: the same by devy value alone). Ages estimated from the high-school class. Profiles run '
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
    print(f'devy rankings: {len(players)} players ({sum(p["valueSource"] == "ktc" for p in players)} KTC-listed, '
          f'{sum(p["valueSource"] == "model" for p in players)} modelled), classes {doc["classes"]}')


if __name__ == '__main__':
    main()
