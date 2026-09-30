#!/usr/bin/env python3
"""Devy rankings and values: KTC's devy market blended with our college-
profile model, priced on the dynasty scale.

1. Market: KTC devy values (public/data/ktc_rankings_devy.json, fetched daily
   by scripts/fetch-ktc.cjs), superflex and 1QB, on KTC's 0-9999 devy scale.
2. Model: scripts/train_devy_model.py's score for the player's draft year:
   the expected mean of his best two NFL PPR PPG seasons in his first four,
   from his college profile as of the end of the last college season
   (public/data/devy-model-scores.json). Validated by leaving each draft
   class out: it beats recruit rating and last-season production two or more
   years out, ties production in the final year, and trails it at QB.
3. Blend, per format: z(log KTC value) over the devy list, plus MODEL_W of
   z(model score) within the position (so the model reorders players inside a
   position and never overrides the market's QB-vs-WR pricing). A player KTC
   does not list enters with the market floor for his class (the lowest listed
   value there, less one market SD): the model alone can pull him into the
   list, not to the top of it. Players are then sorted by the blend and handed
   KTC's own sorted values, so the market's value curve is kept and only the
   order is ours.
4. Dynasty scale: within each draft class, a player's blended rank is his
   expected rookie-draft slot (12 teams: 1-4 Early 1st, 5-8 Mid, 9-12 Late,
   ...), priced by KTC's own future pick values for that year and format,
   interpolated between tiers. So a 2028 devy WR reads directly against NFL
   players and picks on the dynasty board (get_dynasty_values).

Output: public/data/devy-rankings.json. Usage:
python3 scripts/build-devy-rankings.py [data_dir]
"""
from __future__ import annotations

import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from devy_names import norm_name  # noqa: E402

# The first draft class still in college: next year's until this year's NFL
# draft (late April) is done, then the one after.
_TODAY = datetime.now(timezone.utc)
FIRST_CLASS = _TODAY.year + (1 if _TODAY.month >= 5 else 0)
# Model weight in the blend: two or more years out the model's edge over the
# simple signals is largest; at QB it trails last-season production, so less.
# Its cross-validated Spearman is ~0.3-0.45, so it nudges the market's order
# rather than rewriting it.
MODEL_W = {'QB': 0.15, 'RB': 0.25, 'WR': 0.25, 'TE': 0.25}
# Model-only players shown per class (KTC lists ~100; the model scores
# every college skill player, most of whom are not devy assets).
MODEL_ONLY_PER_CLASS = 15
TIERS = ('Early', 'Mid', 'Late')
TIER_SLOT = {'Early': 2.5, 'Mid': 6.5, 'Late': 10.5}
ROUND_WORD = {1: '1st', 2: '2nd', 3: '3rd', 4: '4th'}


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
    """Interpolate a pick curve at a 1-based slot; flat before the first tier
    centre, decaying past the last one."""
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
    return f'{year} {tier} {ROUND_WORD.get(rnd, f"{rnd}th")}' if rnd <= 4 else f'{year} undrafted'


def zscores(xs):
    xs = [x for x in xs if x is not None]
    if len(xs) < 2:
        return 0.0, 1.0
    m = sum(xs) / len(xs)
    sd = (sum((x - m) ** 2 for x in xs) / (len(xs) - 1)) ** 0.5 or 1.0
    return m, sd


def main() -> None:
    data = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('public/data')
    ktc = load(data / 'ktc_rankings_devy.json', [])
    scores_doc = load(data / 'devy-model-scores.json', {}) or {}
    scores = scores_doc.get('players', [])
    career = {norm_name(r['name']): r for r in load(data / 'career-2027.json', []) or []}
    curves = {'sf': pick_curve(load(data / 'ktc_rankings_superflex.json', []), 'superflexValue'),
              'oneQB': pick_curve(load(data / 'ktc_rankings_1qb.json', []), 'value')}

    by_key = {}
    for s in scores:
        by_key.setdefault((s['nameKey'], s['pos']), []).append(s)

    def model_for(name, pos, team_long=''):
        cands = by_key.get((norm_name(name), pos), [])
        if len(cands) > 1 and team_long:
            hit = [c for c in cands if c.get('team') and team_long.lower().startswith(str(c['team']).lower())]
            cands = hit or cands
        return cands[0] if cands else None

    players, used = [], set()
    for k in ktc:
        dy = k.get('draftYear') or FIRST_CLASS
        if dy < FIRST_CLASS or k.get('position') not in MODEL_W:
            continue   # already draft eligible: on the NFL board now
        m = model_for(k['playerName'], k['position'], k.get('teamLongName', ''))
        if m:
            used.add(m['cfbdId'])
        players.append({
            'name': k['playerName'], 'pos': k['position'], 'school': k.get('teamLongName') or k.get('team'),
            'draftYear': dy, 'ktcId': k.get('playerID'),
            # A value of 0 or less (KTC lists a few players in one format only) is no price.
            'ktc': {'sf': k.get('superflexValue') if (k.get('superflexValue') or 0) > 0 else None,
                    'oneQB': k.get('value') if (k.get('value') or 0) > 0 else None,
                    'sfRank': k.get('superflexRank') or None, 'oneQBRank': k.get('oneQBRank') or None},
            'm': m,
        })
    # Model-only: the best-scoring college players KTC does not list, per class.
    for dy in range(FIRST_CLASS, FIRST_CLASS + 3):
        # A known high-school class is required: it is what dates his draft
        # eligibility (3-4 years out), and without it a transfer or a
        # player already gone (undrafted, so not in draft_picks) slips in.
        pool = [s for s in scores if s['cfbdId'] not in used and str(dy) in s['score']
                and s.get('recruitClass') and s['recruitClass'] + 3 <= dy <= s['recruitClass'] + 4]
        for s in sorted(pool, key=lambda s: -s['score'][str(dy)])[:MODEL_ONLY_PER_CLASS]:
            used.add(s['cfbdId'])
            players.append({'name': s['name'], 'pos': s['pos'], 'school': s.get('team'), 'draftYear': dy,
                            'ktcId': None, 'ktc': {'sf': None, 'oneQB': None, 'sfRank': None, 'oneQBRank': None},
                            'm': s})

    for p in players:
        m = p.pop('m')
        sc = (m or {}).get('score', {}).get(str(p['draftYear']))
        cr = career.get(norm_name(p['name']))
        p['model'] = {
            'score': sc,
            'cfbdId': (m or {}).get('cfbdId'),
            'stars': (m or {}).get('stars'), 'rating': (m or {}).get('rating'),
            'recruitClass': (m or {}).get('recruitClass'),
            # The pre-draft career model (draft-capital based, 2027 class only).
            'careerPPG': (cr or {}).get('model', {}).get('predictedCareerPPG') if cr else None,
            'careerTier': (cr or {}).get('model', {}).get('tierLabel') if cr else None,
            'projPick': (cr or {}).get('projPick') if cr else None,
        }

    # Model: a rank-based normal score within position (all classes), robust
    # to the model's long right tail; market: z of log value per format.
    from statistics import NormalDist
    nd = NormalDist()
    mscore = {}
    for pos in MODEL_W:
        grp = sorted((p for p in players if p['pos'] == pos and p['model']['score'] is not None),
                     key=lambda p: p['model']['score'])
        for i, p in enumerate(grp):
            mscore[id(p)] = nd.inv_cdf((i + 0.5) / len(grp))
    out_fmt = {}
    for fmt in ('sf', 'oneQB'):
        logv = [math.log(p['ktc'][fmt]) for p in players if p['ktc'][fmt]]
        mu, sd = zscores(logv)
        floor = {}
        for p in players:
            if p['ktc'][fmt]:
                key = (p['draftYear'], p['pos'])
                floor[key] = min(floor.get(key, 9e9), (math.log(p['ktc'][fmt]) - mu) / sd)
        allfloor = min(floor.values()) if floor else -2.0
        for p in players:
            v = p['ktc'][fmt]
            mz = (math.log(v) - mu) / sd if v else floor.get((p['draftYear'], p['pos']), allfloor) - 1.0
            sc = p['model']['score']
            w = MODEL_W[p['pos']] if sc is not None else 0.0
            sz = mscore.get(id(p), 0.0)
            p.setdefault('_blend', {})[fmt] = (1 - w) * mz + w * sz
        # Our order, the market's value curve; below the market's list, extend
        # the curve's tail geometrically.
        order = sorted(players, key=lambda p: -p['_blend'][fmt])
        vals = sorted((p['ktc'][fmt] for p in players if p['ktc'][fmt]), reverse=True)
        tail = vals[-1] if vals else 100
        for i, p in enumerate(order):
            val = vals[i] if i < len(vals) else tail * (0.97 ** (i - len(vals) + 1))
            p.setdefault('value', {})[fmt] = int(round(val))
            p.setdefault('rank', {})[fmt] = i + 1
        for pos in MODEL_W:
            for j, p in enumerate([q for q in order if q['pos'] == pos]):
                p.setdefault('posRank', {})[fmt] = j + 1
        # Dynasty scale: rank inside the class → rookie-draft slot → KTC pick value.
        for dy in {p['draftYear'] for p in players}:
            cls = [p for p in order if p['draftYear'] == dy]
            curve = curves[fmt].get(dy) or curves[fmt].get(max(curves[fmt])) if curves[fmt] else []
            for j, p in enumerate(cls):
                p.setdefault('dynasty', {})[fmt] = {'value': int(round(slot_value(curve, j + 1))),
                                                    'classRank': j + 1, 'pickEquiv': slot_label(dy, j + 1)}
        out_fmt[fmt] = len(order)

    for p in players:
        b = p.pop('_blend')
        p['blendZ'] = {k: round(v, 3) for k, v in b.items()}
        # Where we and the market disagree most: model rank vs market rank in
        # the position (positive = we like him more).
        p['source'] = 'ktc+model' if p['ktc']['sf'] and p['model']['score'] is not None else (
            'ktc' if p['ktc']['sf'] else 'model')
    for fmt in ('sf',):
        for pos in MODEL_W:
            grp = [p for p in players if p['pos'] == pos and p['ktc'][fmt] and p['model']['score'] is not None]
            mk = {id(p): i for i, p in enumerate(sorted(grp, key=lambda p: -p['ktc'][fmt]))}
            md = {id(p): i for i, p in enumerate(sorted(grp, key=lambda p: -p['model']['score']))}
            for p in grp:
                p['modelVsMarket'] = mk[id(p)] - md[id(p)]

    players.sort(key=lambda p: p['rank']['sf'])
    doc = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'modelAsOfSeason': scores_doc.get('asOfSeason'),
        'classes': sorted({p['draftYear'] for p in players}),
        'modelWeight': MODEL_W,
        'note': ('Devy rankings: KTC devy market blended with the StatHead college-profile model '
                 '(scripts/train_devy_model.py; score = expected mean of best two NFL PPR PPG seasons in '
                 'the first four). value = devy scale (KTC 0-9999) in our order; dynasty.value = the same '
                 'player priced as the rookie-draft slot his class rank implies, from KTC future pick '
                 'values, comparable to NFL players and picks. modelVsMarket = market position rank minus '
                 'model position rank (positive: the model likes him more). source: ktc+model, ktc (no '
                 'college profile matched), model (not on KTC\'s list; enters at the class market floor). '
                 'Model features stop at the ' + str(scores_doc.get('asOfSeason')) + ' season.'),
        'players': players,
    }
    with open(data / 'devy-rankings.json', 'w') as f:
        json.dump(doc, f, indent=1)
    n_src = {s: sum(p['source'] == s for p in players) for s in ('ktc+model', 'ktc', 'model')}
    print(f'devy rankings: {len(players)} players {n_src}, classes {doc["classes"]}')


if __name__ == '__main__':
    main()
