#!/usr/bin/env python3
"""Project 2026 kicker seasons AS COMPONENTS — field goals by distance band and
extra points — rather than as a single fantasy-point scalar.

Why components: a league's scoring catalog prices FGs by distance (and XPs
separately), so a consumer re-scoring under its own rules cannot recover its
total from a points number. Kickers and team defenses are the two positions
whose scoring varies most between leagues and the two we published as bare
scalars. This closes the kicker half.

    python3 scripts/build-kicker-projections.py [season]

Writes public/data/kicker-projections-<season>.json.

WHAT THE DATA SUPPORTS, measured over pbp-slim 2016-2025 (10,731 attempts)
rather than assumed — the model is deliberately shaped around these:

  * Band make rates are stable EXCEPT 50+, which has drifted from 58.6% (2016)
    to ~69% (recent). So rates are recency-weighted (HALF_LIFE below) instead
    of flat-averaged, which would understate long attempts by ~3pp.
  * Team FG attempt volume is close to UNPREDICTABLE: year-over-year r = +0.08
    (range -0.30..+0.33), and within-season it barely tracks offense quality
    (r = +0.16 vs points scored, +0.18 vs red-zone trips). Good offenses get
    more scoring chances but convert more of them to touchdowns, and the two
    effects nearly cancel. So team FG attempts are shrunk hard to the league
    mean (TEAM_FGA_KEEP).
  * Kicker accuracy skill is real but small: splitting each kicker's career in
    half, makes-over-expected per attempt correlates r = +0.18 across halves
    (n=55 with 60+ attempts, sd 0.049). So a kicker's observed O/E is kept at
    only KICKER_OE_KEEP of face value.
  * Extra-point volume IS projectable (yoy r = +0.41) because it tracks
    offensive touchdowns — which we already project. That is where essentially
    all the real per-team differentiation in kicker scoring lives.

The honest summary: FG attempts are league-average for almost everyone, make
rates are league-average for almost everyone, and what separates kickers is
how many touchdowns their offense scores. The components are the point of this
file; the ranking it implies is barely better than sorting by team offense.
"""
from __future__ import annotations

import gzip
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'public/data'
GEN = ROOT / 'src/generated'

SEASON = int(sys.argv[1]) if len(sys.argv) > 1 else 2026
HISTORY = list(range(SEASON - 10, SEASON))       # pbp-slim seasons to learn from
HALF_LIFE = 3.0                                  # seasons; weights recent rates up
TEAM_FGA_KEEP = 0.15                             # yoy r = 0.08 -> keep little
KICKER_OE_KEEP = 0.18                            # split-half r = 0.18
MIN_KICKER_ATT = 25                              # below this, no personal adjustment
# Level calibration. The component build alone backtests at RMSE 1.31 / r 0.29
# against 2023-25 team kicker pts/gm; carrying the team's own prior two seasons
# (shrunk 0.5) gets RMSE 1.30 / r 0.22. Blending them 50/50 is the best of the
# grid at RMSE 1.29 / r 0.29. For scale: a flat league mean scores 1.33, so the
# whole modelling exercise buys about 3% on RMSE. Kicker ranking is close to
# unforecastable; the components, not the ordering, are the deliverable.
CARRY_WEIGHT = 0.50                              # weight on the prior-seasons carry
CARRY_SHRINK = 0.50                              # shrink of that carry toward league
DEF_SHRINK = 0.50                                # matches build-weekly-projections' def-vs-pos shrink
WEEKS = 17                                       # games per team

BANDS = ('0-29', '30-39', '40-49', '50+')
# The scoring build-weekly-projections.py already uses, so the roll-up here is
# directly comparable to the scalar it replaces.
BAND_PTS = {'0-29': 3, '30-39': 3, '40-49': 4, '50+': 5}
XP_PTS = 1


def band_of(dist: float) -> str:
    if dist < 30:
        return '0-29'
    if dist < 40:
        return '30-39'
    if dist < 50:
        return '40-49'
    return '50+'


def load_pbp(season: int):
    path = DATA / f'pbp-slim-{season}.json.gz'
    if not path.exists():
        return []
    return json.loads(gzip.open(path).read())


def load_json(path: Path, fallback):
    try:
        return json.loads(path.read_text())
    except Exception:
        return fallback


def iter_csv(name: str):
    """Read public/data/<name>.csv, falling back to the committed .csv.gz."""
    import csv
    raw = DATA / f'{name}.csv'
    if raw.exists():
        with raw.open(newline='') as fh:
            yield from csv.DictReader(fh)
        return
    gz = DATA / f'{name}.csv.gz'
    if gz.exists():
        with gzip.open(gz, mode='rt', newline='') as fh:
            yield from csv.DictReader(fh)


def starting_kickers(season: int):
    """team -> {name, gsis} for the newest depth-chart PK1. Mirrors
    build-weekly-projections.starting_kickers so both agree on who kicks."""
    best = {}
    for r in iter_csv(f'depth_charts_{season}'):
        if r.get('pos_abb') != 'PK':
            continue
        team = r.get('team')
        dt = r.get('dt') or ''
        try:
            rank = int(r.get('pos_rank') or 99)
        except ValueError:
            rank = 99
        cur = best.get(team)
        if not cur or dt > cur[0] or (dt == cur[0] and rank < cur[1]):
            best[team] = (dt, rank, r.get('player_name'), r.get('gsis_id') or None)
    return {t: {'name': v[2], 'gsis': v[3]} for t, v in best.items()}


def team_k_points_pg(season: int):
    """Team kicker fantasy points per game for a completed season, straight from
    PBP under the same scoring the roll-up uses. This is the carry term: a team's
    own recent kicker output, which captures persistent offence/venue effects the
    component build misses."""
    pts = defaultdict(float)
    games = defaultdict(set)
    for r in load_pbp(season):
        team = r.get('posteam')
        if not team:
            continue
        if r.get('field_goal_result') and r.get('kick_distance'):
            games[team].add(r.get('game_id'))
            if r['field_goal_result'] == 'made':
                pts[team] += BAND_PTS[band_of(float(r['kick_distance']))]
        if r.get('extra_point_result'):
            games[team].add(r.get('game_id'))
            if r['extra_point_result'] == 'good':
                pts[team] += XP_PTS
    return {t: pts[t] / len(games[t]) for t in games if games[t]}


def opponent_kicker_strength(season: int):
    """defense -> kicker fantasy points it ALLOWS per game, as a ratio to the
    league, shrunk toward 1. Same quantity build-weekly-projections derives for
    its def-vs-pos K multiplier, computed here from pbp-slim so this builder
    stays self-contained (the weekly builder runs after it)."""
    pts = defaultdict(float)
    games = defaultdict(set)
    for r in load_pbp(season):
        d = r.get('defteam')
        if not d:
            continue
        if r.get('field_goal_result') and r.get('kick_distance'):
            games[d].add(r.get('game_id'))
            if r['field_goal_result'] == 'made':
                pts[d] += BAND_PTS[band_of(float(r['kick_distance']))]
        if r.get('extra_point_result'):
            games[d].add(r.get('game_id'))
            if r['extra_point_result'] == 'good':
                pts[d] += XP_PTS
    per_game = {t: pts[t] / len(games[t]) for t in games if games[t]}
    if not per_game:
        return {}
    league = sum(per_game.values()) / len(per_game)
    return {t: 1 + DEF_SHRINK * (v / league - 1) for t, v in per_game.items()} if league else {}


def schedule_factor(season: int, strength: dict):
    """team -> mean opponent strength over its actual schedule.

    build-weekly-projections applies matchup multipliers per week but NORMALIZES
    them to mean 1, so they redistribute points between weeks and can never move
    a season total. That is right for skill players, whose season line the
    projection pool owns — but K and DST season lines are produced here, so the
    schedule effect has to be applied at this level or it is lost entirely.
    Measured across 2026 it is worth ~3.3% of kicker points between the easiest
    and hardest schedule (~8% for defenses)."""
    games = load_json(DATA / f'schedule-{season}.json', {'games': []}).get('games', [])
    faced = defaultdict(list)
    for g in games:
        h, a = g.get('home'), g.get('away')
        if h and a:
            faced[h].append(strength.get(a, 1.0))
            faced[a].append(strength.get(h, 1.0))
    return {t: sum(v) / len(v) for t, v in faced.items() if v}


def main() -> None:
    # ── Learn from history ────────────────────────────────────────────────
    band_att = defaultdict(float)      # band -> weighted attempts
    band_made = defaultdict(float)
    mix_att = defaultdict(float)       # band -> weighted attempts (for the mix)
    team_fga = defaultdict(float)      # team -> weighted attempts
    team_games = defaultdict(float)
    league_fga = league_xpa = league_games = 0.0
    team_tds = defaultdict(float)
    kicker_att = defaultdict(int)      # gsis -> attempts (recent seasons only)
    kicker_made = defaultdict(int)
    kicker_exp = defaultdict(float)

    raw_band = defaultdict(lambda: [0, 0])   # unweighted, for the report

    for season in HISTORY:
        rows = load_pbp(season)
        if not rows:
            continue
        w = 0.5 ** ((HISTORY[-1] - season) / HALF_LIFE)
        seen_games = defaultdict(set)
        for r in rows:
            team = r.get('posteam')
            fg = r.get('field_goal_result')
            if fg and r.get('kick_distance'):
                b = band_of(float(r['kick_distance']))
                made = 1 if fg == 'made' else 0
                band_att[b] += w
                band_made[b] += w * made
                mix_att[b] += w
                raw_band[b][0] += 1
                raw_band[b][1] += made
                if team:
                    team_fga[team] += w
                    league_fga += w
                    seen_games[team].add(r.get('game_id'))
                kid = r.get('kicker_player_id')
                # Personal accuracy from recent seasons only — a 2016 sample
                # says little about a 2026 leg.
                if kid and season >= HISTORY[-1] - 2:
                    kicker_att[kid] += 1
                    kicker_made[kid] += made
            if r.get('extra_point_result') and team:
                league_xpa += w
                seen_games[team].add(r.get('game_id'))
            if r.get('touchdown') and r.get('td_team'):
                team_tds[r['td_team']] += w
        for team, games in seen_games.items():
            team_games[team] += w * len(games)
            league_games += w * len(games)

    if not band_att:
        raise SystemExit('no pbp-slim seasons found — run build-pbp-slim first')

    league_rate = {b: band_made[b] / band_att[b] for b in BANDS if band_att[b]}
    total_mix = sum(mix_att[b] for b in BANDS)
    league_mix = {b: mix_att[b] / total_mix for b in BANDS}
    league_fga_pg = league_fga / league_games
    league_xpa_pg = league_xpa / league_games

    # Expected makes for each kicker under league rates, to size their O/E.
    for season in HISTORY[-3:]:
        for r in load_pbp(season):
            if r.get('field_goal_result') and r.get('kick_distance'):
                kid = r.get('kicker_player_id')
                if kid:
                    kicker_exp[kid] += league_rate[band_of(float(r['kick_distance']))]

    # ── Project ───────────────────────────────────────────────────────────
    team_proj = load_json(GEN / 'team-projections.json', {'teams': {}}).get('teams', {})
    proj_td = {t: (float(v.get('passTD') or 0) + float(v.get('rushTD') or 0))
               for t, v in team_proj.items()}
    avg_td = (sum(proj_td.values()) / len(proj_td)) if proj_td else 0.0

    kickers = starting_kickers(SEASON)
    id_map = {}
    for p in load_json(DATA / 'player-id-map.json', {}).get('players', []):
        if p.get('name') and p.get('pos') == 'K':
            id_map[p['name']] = p

    # Carry term: the team's own last two completed seasons, shrunk toward the
    # league. Blended with the component level below — see CARRY_WEIGHT.
    # Opponent strength over the actual 2026 schedule (see schedule_factor).
    opp_strength = opponent_kicker_strength(SEASON - 1)
    sched = schedule_factor(SEASON, opp_strength)

    carry1 = team_k_points_pg(SEASON - 1)
    carry2 = team_k_points_pg(SEASON - 2)
    league_carry = (sum(carry1.values()) / len(carry1)) if carry1 else 0.0

    out_rows = []
    for team in sorted(kickers):
        k = kickers[team]
        name = k.get('name') or f'{team} K'

        # FG attempts: mostly league mean (yoy r = 0.08).
        team_pg = (team_fga[team] / team_games[team]) if team_games.get(team) else league_fga_pg
        fga_pg = league_fga_pg + TEAM_FGA_KEEP * (team_pg - league_fga_pg)
        fga = fga_pg * WEEKS

        # XP attempts: scaled by this team's projected touchdowns vs league.
        # This is the one component with real per-team signal (yoy r = 0.41).
        td_ratio = (proj_td.get(team, avg_td) / avg_td) if avg_td else 1.0
        xpa = league_xpa_pg * WEEKS * td_ratio

        # Personal accuracy, shrunk to KICKER_OE_KEEP of face value.
        gsis = k.get('gsis')
        oe = 0.0
        att = kicker_att.get(gsis, 0)
        if gsis and att >= MIN_KICKER_ATT and kicker_exp.get(gsis):
            oe = KICKER_OE_KEEP * ((kicker_made[gsis] - kicker_exp[gsis]) / att)

        rate_for = {b: min(0.995, max(0.05, league_rate[b] + oe)) for b in BANDS}
        xp_rate = 0.945            # league XP conversion; flat, it barely varies

        # Level before calibration, from the components alone.
        raw_pg = (sum(BAND_PTS[b] * fga * league_mix[b] * rate_for[b] for b in BANDS)
                  + XP_PTS * xpa * xp_rate) / WEEKS
        # Blend with the carry, then scale every count by one factor so the
        # components keep their shape AND still reconcile to the published ppg.
        if team in carry1:
            base = (2 * carry1[team] + carry2.get(team, carry1[team])) / 3
            carry_pg = league_carry + CARRY_SHRINK * (base - league_carry)
            target_pg = (1 - CARRY_WEIGHT) * raw_pg + CARRY_WEIGHT * carry_pg
        else:
            target_pg = raw_pg
        # Schedule: a kicker facing defenses that concede more kicker points
        # gets more of them. Applied to the season level, which the weekly
        # normalization would otherwise erase.
        target_pg *= sched.get(team, 1.0)
        cal = (target_pg / raw_pg) if raw_pg > 0 else 1.0
        fga *= cal
        xpa *= cal

        row = {'name': name, 'team': team, 'gsis': gsis,
               'sleeper': (id_map.get(name) or {}).get('sleeper'),
               'games': WEEKS, 'fg_att_sample': att, 'calibration': round(cal, 3),
               'scheduleStrength': round(sched.get(team, 1.0), 3)}
        fgm_total = 0.0
        for b in BANDS:
            a = fga * league_mix[b]
            m = a * rate_for[b]
            fgm_total += m
            row[f'fga_{b}'] = round(a, 1)
            row[f'fgm_{b}'] = round(m, 1)
        xpm = xpa * xp_rate
        row['fga'] = round(fga, 1)
        row['fgm'] = round(fgm_total, 1)
        row['xpa'] = round(xpa, 1)
        row['xpm'] = round(xpm, 1)
        pts = sum(BAND_PTS[b] * fga * league_mix[b] * rate_for[b] for b in BANDS) + XP_PTS * xpm
        row['projPts'] = round(pts, 1)
        row['ppg'] = round(pts / WEEKS, 2)
        out_rows.append(row)

    out_rows.sort(key=lambda r: -r['ppg'])
    doc = {
        'season': SEASON,
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
        'note': (
            'Projected kicker seasons as components: field-goal attempts and makes by '
            'distance band plus extra points, so a league can re-score under its own '
            'catalog instead of inheriting standard scoring. ppg/projPts roll these up at '
            'FG 0-39=3, 40-49=4, 50+=5, XP=1. Measured limits: team FG attempt volume is '
            'near-unpredictable year over year (r=+0.08) so it is shrunk to the league mean; '
            'kicker accuracy skill is small (split-half r=+0.18) so personal adjustments are '
            'kept at 18% of face value; extra points carry essentially all the real per-team '
            'signal, scaled by projected offensive touchdowns.'
        ),
        'method': {
            'history': [HISTORY[0], HISTORY[-1]],
            'halfLifeSeasons': HALF_LIFE,
            'teamFgaKeep': TEAM_FGA_KEEP,
            'kickerOeKeep': KICKER_OE_KEEP,
            'carryWeight': CARRY_WEIGHT,
            'carryShrink': CARRY_SHRINK,
            'backtest': {'seasons': [2023, 2024, 2025], 'metric': 'team K pts/gm',
                         'rmse': 1.29, 'r': 0.29, 'flatLeagueMeanRmse': 1.33},
            'leagueBandRate': {b: round(league_rate[b], 4) for b in BANDS},
            'leagueBandMix': {b: round(league_mix[b], 4) for b in BANDS},
            'leagueFgaPerGame': round(league_fga_pg, 3),
            'leagueXpaPerGame': round(league_xpa_pg, 3),
            'scheduleAdjusted': bool(sched), 'defShrink': DEF_SHRINK,
        },
        'kickers': out_rows,
    }
    out_path = DATA / f'kicker-projections-{SEASON}.json'
    out_path.write_text(json.dumps(doc, separators=(',', ':')) + '\n')

    print(f'Wrote {out_path} — {len(out_rows)} kickers')
    print(f'  recency-weighted league rates: ' +
          ', '.join(f'{b} {league_rate[b]*100:.1f}%' for b in BANDS))
    print(f'  (unweighted 10yr for contrast:  ' +
          ', '.join(f'{b} {raw_band[b][1]/raw_band[b][0]*100:.1f}%' for b in BANDS) + ')')
    print(f'  league FGA/gm {league_fga_pg:.2f}, XPA/gm {league_xpa_pg:.2f}')
    print(f'  band mix: ' + ', '.join(f'{b} {league_mix[b]*100:.0f}%' for b in BANDS))


if __name__ == '__main__':
    main()
