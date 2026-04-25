#!/usr/bin/env python3
"""
Rookie career model training using LightGBM + scikit-learn.

Replaces the JavaScript training pipeline (rookieCareerModel.ts) with
a 50-100x faster Python implementation. Outputs the same JSON cache
format so the TypeScript site code doesn't change.

Usage:
    python3 scripts/train_career_models.py                    # both pre+post draft
    python3 scripts/train_career_models.py --pre-draft-only   # pre-draft only
    python3 scripts/train_career_models.py --post-draft-only  # post-draft only
"""

import json
import sys
import time
import math
import warnings
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.linear_model import Ridge
from sklearn.metrics import r2_score, mean_absolute_error
from scipy.stats import spearmanr

import sys as _sys
_sys.path.insert(0, str(Path(__file__).parent))
from train_projection_models import bagged_lgb_to_js_bag as _bagged_career_to_js  # noqa: E402

warnings.filterwarnings('ignore', category=UserWarning)

# ── Configuration ─────────────────────────────────────────────────────

CACHE_PATH = Path('public/data/training-rows-cache-v49.json')
OUTPUT_DIR = Path('public/data')
PRE_DRAFT_CACHE = OUTPUT_DIR / 'model-cache-career-v72.json'
POST_DRAFT_CACHE = OUTPUT_DIR / 'model-cache-career-postdraft-v4.json'

# PDF scouting features extracted from The Beast / RSP / Late-Round Guide
# via scripts/extract_pdf_features.py + scripts/merge_pdf_features.py.
# Covers only 2022-2026 draft classes — pre-2022 rookies get zero-filled
# PDF features and rely on the has-indicator for the model to handle them.
# Ablation: scripts/test_pdf_career_features.py (findings in
# docs/pdf-career-feature-test.md) — ships the winners per-position.
PDF_FEATURES_PATH = Path('pdfs/.cache/pdf-prospect-features-merged.json')
# Rookie Scouting Portfolio cross-year rankings (Matt Waldman's DOT +
# breadth per guide). 2026-04 ablation (scripts/test_rsp_career_features.py,
# see docs/pdf-career-feature-test.md) ships the winners: rspNComps
# for WR (+0.071 R²) and the draft_snapshot bundle for RB (+0.042 R²).
RSP_HISTORICAL_PATH = OUTPUT_DIR / 'rsp-historical-rankings.json'

PRE_DRAFT_FEATURES = {
    # QB adds draftClassDepth — QBs are scarce, so a #1 pick in a shallow
    # class is not the same talent signal as a #1 pick in a loaded one.
    # CFBD-feature ablation (2026-04): recruitStars/Rating + team talent +
    # usage all marginal-to-negative for QB; kept the lean 6-feature set.
    # PDF adds (scripts/test_qb_beast_features.py, forward-select): scout
    # consensus rank is the cleanest QB Beast signal — +0.001 R² all-yrs
    # and +0.077 R² in the 2022-25 era. pdfHasRank is the missing-data
    # indicator the GBM needs to distinguish "rank=0 means missing"
    # (pre-2022 rookies) from "rank=0 means elite".
    'QB': ['logDraftPick', 'draftClassDepth', 'collegeQBR2yr',
           'collegeRushYpgPerAge', 'collegeSosFinalYr', 'collegeQbContextScore',
           'pdfRankOverallMean', 'pdfHasRank'],
    # RB: CFBD ablation winners. collegeUsageOverall (PPA-based % of team
    # plays) lifted R² +0.029 alone; recruitRating (247 composite) adds
    # another +0.008 on top for a +0.037 gain over the v48 baseline. The
    # usage signal is the biggest non-draft-capital feature for RB —
    # directly captures "featured back" vs "committee back" out of college.
    # RB: CFBD additions above, plus 2026-04 PDF scouting A/B:
    # pdfRankOverallMean (consensus scout rank across The Beast, 2022-25)
    # lifted R² +0.008 all-yrs / +0.028 inside the PDF era over the CFBD
    # baseline — biggest non-draft-capital add since collegeUsageOverall.
    # pdfHasRank is the "missing-data" indicator so pre-2022 zero-fills
    # don't look like a #0-ranked (elite) prospect to the model.
    # 2026-04 RSP ablation (scripts/test_rsp_career_features.py):
    # draft_snapshot bundle (rspDotDraft + rspBreadthDraft + rspTierOrdinal
    # + rspNComps + rspHasData) lifted R² +0.042 in the PDF era on top of
    # the PDF-aware baseline. DOT is Matt Waldman's numeric grade parsed
    # from "Starter (87.4)"-style tier strings; breadth is his companion
    # "usefulness across roles" score; the tier ordinal collapses Franchise
    # / Legendary / Starter / Contributor / Reserve / Benchwarmer / Street
    # into a 1-10 class. rspNComps is the number of NFL-player comps the
    # scouts offered — a proxy for "how many archetypes this prospect fits".
    'RB': ['logDraftPick', 'collegeDominatorXLateRound',
           'collegeUsageOverall', 'recruitRating',
           'pdfRankOverallMean', 'pdfHasRank',
           'rspDotDraft', 'rspBreadthDraft', 'rspTierOrdinal',
           'rspNComps', 'rspHasData'],
    # WR: recruitStars (247 composite, 1-5) added +0.011 R². Other CFBD
    # features were either redundant with existing college production
    # features or hurt R² once recruitStars was in. 2026-04 PDF A/B:
    # rank features are already captured by draft capital + college
    # production (+0.000 ΔR²), but the qualitative sentiment family
    # (#strengths / #weaknesses / #red_flags and a weighted net score)
    # lifted R² +0.006 all-yrs / +0.021 PDF-era. Red flags are weighted
    # 2× in pdfSentimentNet — a scout-flagged concern is harder signal
    # than a plain "weakness" bullet.
    # 2026-04 RSP A/B on top of the existing PDF sentiment baseline: the
    # single strongest new signal was rspNComps (number of scout-supplied
    # NFL comps), which lifted R² +0.071 in the PDF era and +0.069 when
    # training only on 2022+ rookies. More comps from the scout = more
    # NFL archetypes the prospect resembles — mid-round hits often share
    # multiple comps, true busts share few or none.
    'WR': ['logDraftPick', 'draftPickPct', 'draftPickPctOverall', 'draftClassDepth', 'age',
           'collegeBreakoutScore', 'collegeRecYdsPerTeamPassAtt',
           'collegeBestRecYds',
           'weight', 'collegeTeammateScore',
           'relativeAthleticScore', 'recruitStars',
           'pdfNStrengths', 'pdfNWeaknesses', 'pdfNRedFlags', 'pdfSentimentNet',
           'rspNComps', 'rspHasData'],
    # TE: recruitStars also wins for TE (+0.015 R²). TEs are notoriously
    # hard to project — the 247 composite grabs high-upside athletes the
    # lean draft-capital feature set was missing.
    'TE': ['logDraftPick', 'draftPickPct', 'draftPickPctOverall', 'draftClassDepth',
           'age', 'recruitStars',
           # 2026-04 production ablation (scripts/ablate_te_features.py):
           # college production signals not tested in the original PDF A/B
           # (n=55) now lift R² at n=207. Top 2 wins stacked:
           #   +collegeBreakoutScore         +0.026 R²
           #   +collegeRecYdsPerTeamPassAtt  +0.024 R²
           # Combined ΔR² +0.029, ρ neutral. PDF/RSP scout signals remain a
           # wash for TE (see same ablation).
           'collegeBreakoutScore', 'collegeRecYdsPerTeamPassAtt'],
}

# contractAPY removed (0% coverage — rookie contracts are slot-determined,
# data not joined). Remaining post-draft additions selected via per-position
# forward-selection ablation (2026-04): each candidate single-added on top
# of the pre-draft baseline; only kept if ΔR² ≥ +0.001.
POST_DRAFT_FEATURES = {
    # QB: vegasImpliedTotal, teamPace, depthChartRank all hurt or flat.
    # Only teamSamePosCount earned its keep (+0.003). QBs are first-on-the-field
    # so most "team context" features barely matter for their projection.
    # PDF-disagreement adds (2026-04 forward-select): pdfRankXPick + pdfRoundXActual
    # capture scout-vs-NFL draft disagreement and lift R² +0.002 on
    # all-yrs when paired with the pre-draft PDF rank pair.
    'QB': PRE_DRAFT_FEATURES['QB'] + [
        'teamSamePosCount', 'pdfRankXPick', 'pdfRoundXActual'],
    # RB: dropped depthChartRank (-0.002) and teamPace (-0.006). qbOwnPPG was
    # the standout (+0.011) — RB scoring tracks how much the QB contributes
    # to team rushing volume (mobile QB → fewer carries for the RB).
    'RB': PRE_DRAFT_FEATURES['RB'] + [
        'teamSamePosCount', 'vegasImpliedTotal', 'teamPassRate', 'qbOwnPPG'],
    # WR: every post-draft feature added value, projTeamPassAtt biggest at
    # +0.027. WR career projection benefits most from team-context features
    # because target volume is so team-driven. Note: PDF sentiment features
    # are pre-draft-only for WR — post-draft A/B showed Δ-0.0003 all-yrs
    # and -0.009 score≥22 once team-context features were present. The
    # scouting sentiment was already being proxied by landing-spot context
    # post-draft, so it stopped adding marginal value. Drop explicitly.
    # rspNComps / rspHasData are pre-draft-only too — landing spot subsumes
    # the scout-archetype-count signal once draft capital is known.
    'WR': [f for f in PRE_DRAFT_FEATURES['WR']
           if f not in ('pdfNStrengths', 'pdfNWeaknesses',
                        'pdfNRedFlags', 'pdfSentimentNet',
                        'rspNComps', 'rspHasData')] + [
        'depthChartRank', 'teamSamePosCount',
        'vegasImpliedTotal', 'teamPassRate', 'qbOwnPPG', 'projTeamPassAtt'],
    # TE: kept depthChartRank (+0.008), vegasImpliedTotal (+0.008),
    # teamPassRate (+0.006), qbOwnPPG (+0.004). projTeamPassAtt hurt
    # (-0.002) — TE volume is more about red-zone usage than total
    # pass attempts.
    'TE': PRE_DRAFT_FEATURES['TE'] + [
        'depthChartRank', 'vegasImpliedTotal', 'teamPassRate', 'qbOwnPPG'],
}

PPG_THRESHOLDS = {
    'QB': [16, 18, 20, 22],
    'RB': [12, 14, 16, 18],
    'WR': [12, 14, 16, 18],
    'TE': [8, 9, 10, 11],
}

POS_HYPERPARAMS = {
    'QB': {'ridge_alpha': 15, 'n_estimators': 80, 'lr': 0.04, 'max_depth': 2, 'min_child': 15},
    'RB': {'ridge_alpha': 5,  'n_estimators': 100, 'lr': 0.04, 'max_depth': 3, 'min_child': 12},
    'WR': {'ridge_alpha': 8,  'n_estimators': 120, 'lr': 0.05, 'max_depth': 3, 'min_child': 10},
    'TE': {'ridge_alpha': 20, 'n_estimators': 80,  'lr': 0.04, 'max_depth': 2, 'min_child': 15},
}

# ── Per-position boom/bust feature lists ──────────────────────────────
# Boom (gap regression) and bust (binary classifier) used to share one
# global feature list across positions, which prevented shipping a
# disagreement signal that helped one position but hurt another at small
# sample. 2026-04 ablation (scripts/test_pdf_career_features.py) found:
#   - WR boom benefits from talent-disagreement features
#     (recruitProductionGap, athleticProductionGap), +0.007 ρ all-yrs.
#   - QB bust benefits from scout-disagreement features
#     (pdfRankSpread, pdfRankXPick, pdfRoundXActual), +0.021 AUC.
#   - RB bust benefits from PDF weakness counts AND talent-disagreement
#     (pdfNWeaknesses + pdfSentimentNet + recruitProductionGap +
#     athleticProductionGap), +0.019/+0.028 in pre-draft.
#   - TE: nothing consistent at n=55 PDF-era; left alone.
# Each base list mirrors the pre-2026-04 GAP_FEAT_NAMES / BUST_FEAT_NAMES.
_GAP_BASE = [
    'ras', 'speed', 'height_speed', 'forty', 'weight', 'cone', 'shuttle',
    'best_rec', 'dominator', 'breakout', 'market_share', 'total_tds',
    'age', 'early_declare', 'experience', 'seasons',
    'ras_vs_pick', 'speed_vs_pick', 'production_vs_pick',
    'best_season_vs_pick',
    'low_games', 'early_declare_late', 'games_per_season', 'recent_breakout',
    'recruit_rating', 'college_usage', 'team_talent', 'recruit_vs_pick',
    'qbr', 'ypa', 'qb_context',
    'qbr_vs_pick', 'ypa_vs_pick', 'qb_context_vs_pick',
]
BOOM_GAP_FEATURES_BY_POS = {
    # QB boom A/B (2026-04 round 3): pdfRankOverallMean + pdfHasRank +
    # athletic_production_gap lifted ρ_boom +0.045 all-yrs and +0.081
    # in the PDF era vs the bare base list.
    'QB': _GAP_BASE + ['pdfRankOverallMean', 'pdfHasRank', 'athletic_production_gap'],
    'RB': list(_GAP_BASE),
    'WR': _GAP_BASE + ['recruit_production_gap', 'athletic_production_gap'],
    'TE': list(_GAP_BASE),
}
_BUST_BASE = [
    'speedScore', 'relativeAthleticScore', 'heightAdjSpeedScore',
    'forty', 'weight', 'age',
    'collegeDominatorRating', 'collegeBestRecYds', 'collegeBreakoutScore',
    'collegeMarketShare', 'collegeTotalTDs', 'collegeReceptionShare',
    'collegeExperiencePerAge', 'collegeSeasons', 'collegeEarlyDeclare',
    'hasCombineData', 'hasCollegeStats',
    'predictedPPG', 'nflDraftPick',
    'speed_deficit', 'production_deficit', 'age_for_draft', 'missing_data_count',
    'recruitRating', 'collegeUsageOverall', 'collegeTeamTalent',
    'collegeQBR2yr', 'collegeQbContextScore',
]
BUST_FEATURES_BY_POS = {
    # QB bust: round 2 shipped the scout-disagreement trio (pdfRankSpread,
    # pdfRankXPick, pdfRoundXActual). Round 3 re-test found pdfRankSpread
    # contributed zero gain at n=134 (QBs are usually ranked by one source)
    # and the pair pdfRankOverallMean + pdfHasRank added +0.0003 AUC all-yrs
    # and +0.070 AUC in the 2022-25 era. Swapping in the simpler pair.
    'QB': _BUST_BASE + ['pdfRankXPick', 'pdfRoundXActual',
                        'pdfRankOverallMean', 'pdfHasRank'],
    'RB': _BUST_BASE + ['pdfNWeaknesses', 'pdfSentimentNet',
                        'recruit_production_gap', 'athletic_production_gap'],
    'WR': _BUST_BASE + ['recruit_production_gap', 'athletic_production_gap'],
    'TE': list(_BUST_BASE),
}

# ── PDF scouting features ─────────────────────────────────────────────

# Name suffixes stripped before matching (Jr./III/etc. in roster names
# don't appear consistently in scouting PDFs).
_PDF_NAME_SUFFIXES = (' sr', ' jr', ' iii', ' ii', ' iv')


def _norm_pdf_name(n: str) -> str:
    s = n.lower().strip()
    s = s.replace('.', '').replace("'", '').replace('-', ' ').replace('`', '')
    for suffix in _PDF_NAME_SUFFIXES:
        if s.endswith(suffix):
            s = s[:-len(suffix)].strip()
    return ' '.join(s.split())


# Mirror derive_pdf_features() in scripts/test_pdf_career_features.py.
# Values are zero when PDF record is missing; paired *Has* indicators let
# tree models separate "no PDF data" from a legitimate zero-valued field.
# pdfRankSpread (max - min across source PDFs) is the scout-internal
# disagreement signal used by the QB bust model.
_EMPTY_PDF_FEATURES = {
    'pdfHasData': 0,
    'pdfRankOverallMean': 0.0,
    'pdfRankOverallMin': 0.0,
    'pdfRankOverallMax': 0.0,
    'pdfRankSpread': 0.0,
    'pdfProjectedRound': 0.0,
    'pdfHasRank': 0,
    'pdfNStrengths': 0,
    'pdfNWeaknesses': 0,
    'pdfNRedFlags': 0,
    'pdfSentimentNet': 0,
}


# RSP-derived features. rspDotDraft/rspBreadthDraft are the scores from
# Waldman's guide in the player's draft year. rspDotLatest/rspBreadthLatest
# track the most recent re-ranking (cross-year signal) — currently shipped
# as pre-draft features for RB only because post-draft recalibration
# didn't show a consistent lift. rspTierOrdinal is an ordinal encoding of
# tier class ("Franchise"=10 … "Street"=1). rspNComps counts the number
# of NFL-player comparisons the scout wrote up.
_EMPTY_RSP_FEATURES = {
    'rspHasData': 0,
    'rspDotMax': 0.0,
    'rspDotDraft': 0.0,
    'rspDotLatest': 0.0,
    'rspDotDelta': 0.0,
    'rspBreadthDraft': 0.0,
    'rspBreadthLatest': 0.0,
    'rspTierOrdinal': 0,
    'rspAppearances': 0,
    'rspNComps': 0,
}

# Ordinal mapping of RSP tier classes. Scored so the gap between neighbours
# roughly approximates the DOT class boundaries in Waldman's writeups.
# Not calibrated to log-odds — just a monotonic ranking the GBM can split on.
_RSP_TIER_ORDINAL = {
    'Franchise': 10,
    'Legendary Performer': 9,
    'Elite Producer': 9,
    # Recent RSP guides label the top-of-class with Roman numerals ("Tier I"
    # through "Tier VII") instead of the older named tiers. 2022-2025 guides
    # mix both — without these entries ~45% of RSP-graded prospects had
    # rspTierOrdinal zero'd out (Bijan, Jeanty were both Tier I → 0).
    'Tier I': 9,
    'Tier II': 8,
    'Weekly Starter': 8,
    'Starter': 8,
    'Rotational Starter': 7,
    'Rotational Starter Tier': 7,
    'Tier III': 7,
    'Flex Play': 6,
    'Contributor': 6,
    'Tier IV': 5,
    'Reserve': 5,
    'Cusp of Contributor and Reserve': 5,
    'Tier V': 4,
    'Developmental': 4,
    'Developmental on Cusp of Reserve': 4,
    'Benchwarmer': 3,
    'Priority Free Agent': 3,
    'Tier VI': 2,
    'Waiver Wire Add': 2,
    'Dart Throw': 2,
    'Tier VII': 1,
    'Street': 1,
}

# Regex pre-compiled once — runs for every prospect on every training pass.
import re as _re  # local alias to avoid colliding with anything named `re`
_RSP_DOT_RE = _re.compile(r'\(([0-9]+(?:\.[0-9]+)?)\)')
_RSP_PAREN_RE = _re.compile(r'\s*\([^)]*\)\s*')
_RSP_ROUND_RE = _re.compile(r'round', _re.I)


def _parse_rsp_tier(tiers: list) -> tuple[float, int]:
    """Extract (best DOT score, max tier ordinal) from merged tier strings.

    Max is used rather than mean — best-case scout projection matches the
    optimistic tail we want the GBM to key on for RB.
    """
    if not tiers:
        return 0.0, 0
    best_dot = 0.0
    best_ord = 0
    for t in tiers:
        m = _RSP_DOT_RE.search(t)
        if m:
            try:
                d = float(m.group(1))
                if d > best_dot:
                    best_dot = d
            except ValueError:
                pass
        label = _RSP_PAREN_RE.sub('', t).strip()
        if _RSP_ROUND_RE.search(label):
            # "1st Round" tags are Beast-style — captured via pdfProjectedRound.
            continue
        best_ord = max(best_ord, _RSP_TIER_ORDINAL.get(label, 0))
    return best_dot, best_ord


def _derive_rsp_features(pdf_entry: dict | None,
                          hr_entries: list | None,
                          draft_season: int) -> dict:
    """Build the rsp* feature dict from merged PDF + historical rankings.

    pdf_entry holds tiers/comps (present for any prospect in any source PDF).
    hr_entries is a list of cross-year appearances from
    rsp-historical-rankings.json — used to compute trajectory/delta.
    """
    # Tier-embedded DOT + ordinal (merged across all PDFs that graded the
    # player). Zero when the player isn't in any scouting PDF.
    tier_dot, tier_ord = _parse_rsp_tier(
        (pdf_entry or {}).get('tiers') or [])

    # Cross-year DOT trajectory. "Draft" = the guide from the player's
    # draft year when available; "latest" = the most recent guide.
    first_dot = last_dot = dot_delta = 0.0
    breadth_first = breadth_last = 0.0
    n_ap = 0
    if hr_entries:
        ap = sorted(hr_entries, key=lambda e: e.get('guide_year', 0))
        draft_ap = next(
            (a for a in ap if a.get('guide_year') == draft_season),
            ap[0])
        latest = ap[-1]
        first_dot = float(draft_ap.get('dot') or 0)
        last_dot = float(latest.get('dot') or 0)
        if first_dot and last_dot:
            dot_delta = last_dot - first_dot
        breadth_first = float(draft_ap.get('breadth') or 0)
        breadth_last = float(latest.get('breadth') or 0)
        n_ap = len(ap)

    # Fallback: when the player is only in their draft-year RSP (most 2026
    # rookies), rsp-historical-rankings.json — which indexes cross-year
    # re-rankings — won't have them. Use the tier-embedded DOT from the
    # merged PDFs so rspDotDraft is populated for every scouted prospect,
    # not just ones Waldman re-ranked in a later guide. Without this the
    # GBM learns "rspDotDraft==0 → 2026 class" as an era indicator.
    if first_dot == 0 and tier_dot > 0:
        first_dot = tier_dot
    if last_dot == 0 and tier_dot > 0:
        last_dot = tier_dot

    best_dot = max(tier_dot, last_dot, first_dot)
    has_data = 1 if (tier_dot or last_dot or tier_ord or n_ap) else 0
    n_comps = len((pdf_entry or {}).get('comps') or [])

    return {
        'rspHasData': has_data,
        'rspDotMax': best_dot,
        'rspDotDraft': first_dot,
        'rspDotLatest': last_dot,
        'rspDotDelta': dot_delta,
        'rspBreadthDraft': breadth_first,
        'rspBreadthLatest': breadth_last,
        'rspTierOrdinal': tier_ord,
        'rspAppearances': n_ap,
        'rspNComps': n_comps,
    }


def _load_rsp_historical_index(path: Path) -> dict:
    """Return (normalized_name, position) → list of per-guide appearances.

    Each appearance dict: {guide_year, rank, dot, breadth, tier}. Missing
    file is non-fatal — prospects not in the historical rankings still
    get tier-based features from the merged PDF index.
    """
    if not path.exists():
        print(f"  [rsp] {path} not found — cross-year trajectory features will be zero-filled")
        return {}
    with open(path) as f:
        hr = json.load(f)
    idx: dict = {}
    for g in hr.get('guides', []):
        yr = g.get('guide_year')
        for pos, entries in (g.get('rankings') or {}).items():
            for r in entries:
                if r.get('dot') is None and r.get('breadth') is None:
                    continue
                key = (_norm_pdf_name(r['player_name']), pos)
                idx.setdefault(key, []).append({
                    'guide_year': yr,
                    'rank': r.get('rank'),
                    'dot': r.get('dot'),
                    'breadth': r.get('breadth'),
                    'tier': r.get('tier'),
                })
    total_appearances = sum(len(v) for v in idx.values())
    print(f"  [rsp] loaded {len(idx)} players / {total_appearances} cross-year entries from {path.name}")
    return idx


def _derive_pdf_features(p: dict | None) -> dict:
    if p is None:
        return dict(_EMPTY_PDF_FEATURES)
    strengths = p.get('strengths') or []
    weaknesses = p.get('weaknesses') or []
    red_flags = p.get('red_flags') or []
    rank_mean = p.get('rank_overall_mean')
    rank_min = p.get('rank_overall_min')
    rank_max = p.get('rank_overall_max')
    proj_round = p.get('projected_round_mean')
    rank_spread = (float(rank_max) - float(rank_min)) \
        if rank_max is not None and rank_min is not None else 0.0
    return {
        'pdfHasData': 1,
        'pdfRankOverallMean': float(rank_mean) if rank_mean is not None else 0.0,
        'pdfRankOverallMin': float(rank_min) if rank_min is not None else 0.0,
        'pdfRankOverallMax': float(rank_max) if rank_max is not None else 0.0,
        'pdfRankSpread': rank_spread,
        'pdfProjectedRound': float(proj_round) if proj_round is not None else 0.0,
        'pdfHasRank': 1 if rank_mean is not None else 0,
        'pdfNStrengths': len(strengths),
        'pdfNWeaknesses': len(weaknesses),
        'pdfNRedFlags': len(red_flags),
        # Red flags weighted 2× — a scout-called concern is harder signal
        # than a plain "weakness" bullet.
        'pdfSentimentNet': len(strengths) - len(weaknesses) - 2 * len(red_flags),
    }


def _load_pdf_index(path: Path) -> dict:
    """Return (name, position) → PDF record, with a name-only fallback list.

    Missing file is non-fatal — callers still get zero-filled features.
    """
    if not path.exists():
        print(f"  [pdf] {path} not found — PDF features will be zero-filled")
        return {'by_key': {}, 'by_name': {}}
    with open(path) as f:
        entries = json.load(f)
    by_key = {}
    by_name: dict[str, list] = {}
    for p in entries:
        name = _norm_pdf_name(p['player_name'])
        pos = p.get('position')
        by_key[(name, pos)] = p
        by_name.setdefault(name, []).append(p)
    print(f"  [pdf] loaded {len(entries)} prospects from {path.name}")
    return {'by_key': by_key, 'by_name': by_name}


def _lookup_pdf(idx: dict, name: str, position: str):
    nn = _norm_pdf_name(name)
    entry = idx['by_key'].get((nn, position))
    if entry is not None:
        return entry
    # Name-only fallback for scouting/fantasy position mismatches.
    cands = idx['by_name'].get(nn, [])
    return cands[0] if len(cands) == 1 else None


# ── Disagreement features ─────────────────────────────────────────────
# Two-feature disagreement signals — when two channels that should agree
# don't, that gap is itself signal. Computed once at load_career_rows
# time so per-position z-scoring uses the full-cohort statistics. Used
# in BUST_FEATURES_BY_POS (RB, WR) and BOOM_GAP_FEATURES_BY_POS (WR).
#
# Coverage notes:
#  - pdfRankXPick / pdfRoundXActual: nonzero only for 2022-2025 rookies
#    (PDF era). Pre-2022 rows zero-fill; the GBM treats this as a
#    distinct missing-data band.
#  - recruit_production_gap: nonzero only when both recruitRating and
#    collegeMarketShare are present (~40-50% of historical rows).
#  - athletic_production_gap: nonzero when both speedScore and
#    collegeDominatorRating exist (~60% of historical rows).
def _safe_num(v) -> float:
    if v is None or v == '' or v == 'NA' or v == 'NaN':
        return 0.0
    try:
        n = float(v)
        return n if math.isfinite(n) else 0.0
    except (TypeError, ValueError):
        return 0.0


def _safe_log(v: float) -> float:
    return float(math.log(v)) if v and v > 0 else 0.0


def _zscore_per_pos(rows: list, key: str) -> dict:
    """Per-position (mean, std) using nonzero values only."""
    by_pos: dict = {}
    for r in rows:
        v = _safe_num(r['features'].get(key, 0))
        if v != 0:
            by_pos.setdefault(r['position'], []).append(v)
    moments = {}
    for pos, vals in by_pos.items():
        if len(vals) < 5:
            moments[pos] = (0.0, 1.0)
        else:
            m = float(np.mean(vals))
            s = float(np.std(vals)) or 1.0
            moments[pos] = (m, s)
    return moments


def _attach_disagreement_features(career_rows: list) -> None:
    """Compute and attach scout-vs-NFL and recruit-vs-production gaps.

    Per-position z-scoring so a 0.92 recruit composite reads "elite TE"
    vs "good WR" — the disagreement is against position-mates, not the
    global pool.
    """
    recruit_m = _zscore_per_pos(career_rows, 'recruitRating')
    market_m = _zscore_per_pos(career_rows, 'collegeMarketShare')
    speed_m = _zscore_per_pos(career_rows, 'speedScore')
    dom_m = _zscore_per_pos(career_rows, 'collegeDominatorRating')

    def _z(val: float, pos: str, moments: dict) -> float:
        if val == 0:
            return 0.0
        m, s = moments.get(pos, (0.0, 1.0))
        return (val - m) / s

    for r in career_rows:
        f = r['features']
        pos = r['position']
        pick = max(1.0, _safe_num(f.get('nflDraftPick', 300)))
        draft_round = _safe_num(f.get('nflDraftRound', 7)) or 7.0
        pdf_rank = _safe_num(f.get('pdfRankOverallMean', 0))
        proj_round = _safe_num(f.get('pdfProjectedRound', 0))

        # Scout-vs-NFL disagreement. Big positive pdfRankXPick = scouts
        # ranked the player worse than the NFL pick implies (overdraft).
        f['pdfRankXPick'] = (_safe_log(pdf_rank) - _safe_log(pick)) if pdf_rank > 0 else 0.0
        f['pdfRoundXActual'] = (proj_round - draft_round) if proj_round > 0 else 0.0

        # Talent-vs-production disagreement.
        recruit = _safe_num(f.get('recruitRating', 0))
        market = _safe_num(f.get('collegeMarketShare', 0))
        speed = _safe_num(f.get('speedScore', 0))
        dom = _safe_num(f.get('collegeDominatorRating', 0))
        f['recruit_production_gap'] = (
            _z(recruit, pos, recruit_m) - _z(market, pos, market_m)
            if recruit > 0 and market > 0 else 0.0
        )
        f['athletic_production_gap'] = (
            _z(speed, pos, speed_m) - _z(dom, pos, dom_m)
            if speed > 0 and dom > 0 else 0.0
        )


# ── Boom (gap) signal computation ─────────────────────────────────────
# Returns a dict of all candidate gap signals; per-position lists in
# BOOM_GAP_FEATURES_BY_POS pick from this dict. Same computation
# regardless of position — selection happens at training-time only.
def _compute_gap_signals(f: dict) -> dict:
    sf = _safe_num
    pick = max(1.0, sf(f.get('nflDraftPick', 300)))
    log_pick = math.log(pick)

    ras = sf(f.get('relativeAthleticScore', 0))
    speed = sf(f.get('speedScore', 0))
    height_speed = sf(f.get('heightAdjSpeedScore', 0))
    best_rec = sf(f.get('collegeBestRecYds', 0))
    dominator = sf(f.get('collegeDominatorRating', 0))
    breakout = sf(f.get('collegeBreakoutScore', 0))
    market_share = sf(f.get('collegeMarketShare', 0))
    total_tds = sf(f.get('collegeTotalTDs', 0))
    age = sf(f.get('age', 0))
    early_declare = sf(f.get('collegeEarlyDeclare', 0))
    experience = sf(f.get('collegeExperiencePerAge', 0))
    seasons = sf(f.get('collegeSeasons', 0))
    forty = sf(f.get('forty', 0))
    wt = sf(f.get('weight', 0))
    cone = sf(f.get('cone', 0))
    shuttle = sf(f.get('shuttle', 0))
    college_games = sf(f.get('collegeGames', 0))
    breakout_age = sf(f.get('collegeBreakoutAge', 0))
    recruit_rating = sf(f.get('recruitRating', 0))
    college_usage = sf(f.get('collegeUsageOverall', 0))
    team_talent = sf(f.get('collegeTeamTalent', 0))
    qbr = sf(f.get('collegeQBR2yr', 0))
    ypa = sf(f.get('collegeYdsPerPassAtt', 0))
    qb_context = sf(f.get('collegeQbContextScore', 0))

    games_per_season = (college_games / max(1, seasons)) if seasons > 0 else 0
    return {
        'ras': ras, 'speed': speed, 'height_speed': height_speed,
        'forty': forty, 'weight': wt, 'cone': cone, 'shuttle': shuttle,
        'best_rec': best_rec, 'dominator': dominator, 'breakout': breakout,
        'market_share': market_share, 'total_tds': total_tds,
        'age': age, 'early_declare': early_declare,
        'experience': experience, 'seasons': seasons,
        'ras_vs_pick': (ras - (10 - log_pick)) if ras > 0 else 0,
        'speed_vs_pick': (speed - (120 - pick * 0.3)) if speed > 0 else 0,
        'production_vs_pick': (dominator / max(1, log_pick)) if dominator > 0 else 0,
        'best_season_vs_pick': (best_rec / max(1, pick)) if best_rec > 0 else 0,
        'low_games': 1 if 0 < games_per_season < 10 else 0,
        'early_declare_late': early_declare * log_pick,
        'games_per_season': games_per_season,
        'recent_breakout': 1 if breakout_age > 0 and age > 0 and (age - breakout_age) <= 1 else 0,
        'recruit_rating': recruit_rating, 'college_usage': college_usage,
        'team_talent': team_talent,
        'recruit_vs_pick': (recruit_rating / max(1, log_pick)) if recruit_rating > 0 else 0,
        'qbr': qbr, 'ypa': ypa, 'qb_context': qb_context,
        'qbr_vs_pick': (qbr / max(1, log_pick)) if qbr > 0 else 0,
        'ypa_vs_pick': (ypa - (8 - log_pick * 0.5)) if ypa > 0 else 0,
        'qb_context_vs_pick': (qb_context / max(1, log_pick * 1000)) if qb_context > 0 else 0,
        # Disagreement features — populated in _attach_disagreement_features
        # at load time. Read from the stored feature dict so backtest +
        # standalone scoring share the same values.
        'recruit_production_gap': sf(f.get('recruit_production_gap', 0)),
        'athletic_production_gap': sf(f.get('athletic_production_gap', 0)),
        # Raw PDF signals used by the QB boom/bust gap lists. Pass-through
        # from the features dict (populated by _derive_pdf_features during
        # load_career_rows); zero for pre-2022 rookies.
        'pdfRankOverallMean': sf(f.get('pdfRankOverallMean', 0)),
        'pdfHasRank': sf(f.get('pdfHasRank', 0)),
    }


# ── Bust signal computation ───────────────────────────────────────────
# Same dict-of-signals shape. predicted_ppg and the per-fold avg_speed_hit
# / avg_dom_hit are passed in because they're computed inside train_position
# from the LOSO fold's hits (not stable across re-runs of standalone scoring).
def _compute_bust_signals(f: dict, predicted_ppg: float,
                           avg_speed_hit: float = 100.0,
                           avg_dom_hit: float = 30.0) -> dict:
    sf = _safe_num
    speed = sf(f.get('speedScore', 0))
    ras = sf(f.get('relativeAthleticScore', 0))
    hspeed = sf(f.get('heightAdjSpeedScore', 0))
    forty = sf(f.get('forty', 0))
    wt = sf(f.get('weight', 0))
    age = sf(f.get('age', 0))
    dom = sf(f.get('collegeDominatorRating', 0))
    best_rec = sf(f.get('collegeBestRecYds', 0))
    breakout = sf(f.get('collegeBreakoutScore', 0))
    mkt = sf(f.get('collegeMarketShare', 0))
    tds = sf(f.get('collegeTotalTDs', 0))
    rec_share = sf(f.get('collegeReceptionShare', 0))
    exp = sf(f.get('collegeExperiencePerAge', 0))
    seasons = sf(f.get('collegeSeasons', 0))
    early = sf(f.get('collegeEarlyDeclare', 0))
    pick = sf(f.get('nflDraftPick', 300))

    return {
        'speedScore': speed, 'relativeAthleticScore': ras,
        'heightAdjSpeedScore': hspeed, 'forty': forty, 'weight': wt, 'age': age,
        'collegeDominatorRating': dom, 'collegeBestRecYds': best_rec,
        'collegeBreakoutScore': breakout, 'collegeMarketShare': mkt,
        'collegeTotalTDs': tds, 'collegeReceptionShare': rec_share,
        'collegeExperiencePerAge': exp, 'collegeSeasons': seasons,
        'collegeEarlyDeclare': early,
        'hasCombineData': 1 if speed > 0 or forty > 0 else 0,
        'hasCollegeStats': 1 if dom > 0 or best_rec > 0 else 0,
        'predictedPPG': predicted_ppg, 'nflDraftPick': pick,
        'speed_deficit': (speed - avg_speed_hit) if speed > 0 else -20,
        'production_deficit': (dom - avg_dom_hit) if dom > 0 else -15,
        'age_for_draft': age - 21 if age > 0 else 0,
        'missing_data_count': (1 if speed == 0 else 0) + (1 if dom == 0 else 0) + (1 if ras == 0 else 0),
        'recruitRating': sf(f.get('recruitRating', 0)),
        'collegeUsageOverall': sf(f.get('collegeUsageOverall', 0)),
        'collegeTeamTalent': sf(f.get('collegeTeamTalent', 0)),
        'collegeQBR2yr': sf(f.get('collegeQBR2yr', 0)),
        'collegeQbContextScore': sf(f.get('collegeQbContextScore', 0)),
        # PDF + disagreement signals (populated for 2022-25 rookies; zero
        # otherwise). Picked up by per-position BUST_FEATURES_BY_POS.
        'pdfNWeaknesses': sf(f.get('pdfNWeaknesses', 0)),
        'pdfSentimentNet': sf(f.get('pdfSentimentNet', 0)),
        'pdfRankSpread': sf(f.get('pdfRankSpread', 0)),
        'pdfRankXPick': sf(f.get('pdfRankXPick', 0)),
        'pdfRoundXActual': sf(f.get('pdfRoundXActual', 0)),
        'pdfRankOverallMean': sf(f.get('pdfRankOverallMean', 0)),
        'pdfHasRank': sf(f.get('pdfHasRank', 0)),
        'recruit_production_gap': sf(f.get('recruit_production_gap', 0)),
        'athletic_production_gap': sf(f.get('athletic_production_gap', 0)),
    }


# ── Data Loading ──────────────────────────────────────────────────────

def load_career_rows(cache_path: Path) -> pd.DataFrame:
    """Load training rows and build career target (best 2-of-3 PPG)."""
    with open(cache_path) as f:
        data = json.load(f)
    rows = data['rows']
    pdf_idx = _load_pdf_index(PDF_FEATURES_PATH)
    rsp_hr_idx = _load_rsp_historical_index(RSP_HISTORICAL_PATH)

    # Build games lookup from priorGames
    career_games = {}
    for r in rows:
        prior_season = r['season'] - 1
        key = f"{r['name']}::{r['position']}::{prior_season}"
        pg = r['features'].get('priorGames', 0)
        if pg > 0:
            career_games[key] = pg

    # Group rows by player → career. Name normalization strips generational
    # suffixes (III/II/IV/Jr/Sr) so nflverse-source inconsistencies don't
    # split one career into two entries — e.g. Kenneth Walker's 2022 rookie
    # row arrived without "III" but the 2023 row has it, which previously
    # produced two backtest entries with partial season_ppgs each.
    def _career_key(name: str, pos: str) -> str:
        nk = name.lower().strip()
        nk = _re.sub(r'\s+(sr|jr|iii|ii|iv|v)\.?$', '', nk)
        nk = _re.sub(r'[^a-z0-9 ]+', '', nk).strip()
        return f'{nk}::{pos}'
    career_map: dict[str, dict] = {}
    for r in rows:
        key = _career_key(r['name'], r['position'])
        if key not in career_map:
            career_map[key] = {
                'name': r['name'], 'position': r['position'],
                'draft_season': 0, 'features': {},
                'season_ppgs': [],
            }
        entry = career_map[key]
        games_key = f"{r['name']}::{r['position']}::{r['season']}"
        games = career_games.get(games_key, 17 if r['rawPPG'] > 0 else 0)
        entry['season_ppgs'].append({'season': r['season'], 'ppg': r['rawPPG'], 'games': games})
        yil = r['features'].get('yearsInLeague', 99)
        if yil <= 1:
            derived = r['season'] - yil
            if entry['draft_season'] == 0 or derived < entry['draft_season']:
                entry['draft_season'] = derived
                entry['features'] = dict(r['features'])
                # Prefer the rookie-year name variant for display — it's
                # what the Beast/RSP scouting PDFs match against, and
                # feature-matrix lookups use the same format.
                entry['name'] = r['name']

    # Fix false rookies
    for entry in career_map.values():
        if entry['draft_season'] == 0:
            continue
        seasons = sorted(s['season'] for s in entry['season_ppgs'])
        if seasons and seasons[0] < entry['draft_season']:
            entry['draft_season'] = seasons[0]

    # Compute best-2-of-3 target
    career_rows = []
    for entry in career_map.values():
        if entry['draft_season'] == 0:
            continue
        first3 = sorted(
            [s for s in entry['season_ppgs']
             if entry['draft_season'] <= s['season'] < entry['draft_season'] + 3],
            key=lambda s: -s['ppg']
        )
        qualifying = [s for s in first3 if s['games'] >= 4]
        if not qualifying:
            continue
        best2 = qualifying[:2]
        best2of3 = round(sum(s['ppg'] for s in best2) / len(best2), 2)

        f = dict(entry['features'])
        yil = f.get('yearsInLeague', 99)
        if yil > 1:
            continue
        all_seasons = sorted(s['season'] for s in entry['season_ppgs'])
        if any(s < entry['draft_season'] for s in all_seasons):
            continue
        pick = f.get('nflDraftPick', 300) or 300
        age = f.get('age', 0) or 0
        if pick >= 300 and age == 0:
            continue

        # Derived features. log(pick+1) so the #1 overall pick is 0.693
        # (distinct non-zero signal) instead of log(1) = 0 — previously
        # indistinguishable from a missing-data value on player cards.
        f['logDraftPick'] = math.log(pick + 1)
        f['invDraftPick'] = 1.0 / pick
        f['collegeEarlyDeclare'] = f.get('collegeEarlyDeclare', 0)
        f['draftPickXEarlyDeclare'] = f['collegeEarlyDeclare'] * f['invDraftPick']
        f['collegeDominatorXLateRound'] = (f.get('collegeDominatorRating', 0) or 0) * max(0, math.log(pick + 1) - 4.0)
        if f.get('draftPickPct') is None:
            f['draftPickPct'] = 1.0

        # QB accuracy features from raw aggregates. Older cache versions
        # leaked 'NA' strings from JackLich10's CSV into these fields;
        # coerce defensively so a malformed cache doesn't nuke training.
        def _num(x):
            try:
                n = float(x)
                return n if math.isfinite(n) else 0.0
            except (TypeError, ValueError):
                return 0.0
        raw_pa = _num(f.get('_rawCareerPassAtt', 0))
        raw_pc = _num(f.get('_rawCareerPassCompletions', 0))
        raw_py = _num(f.get('_rawCareerPassYds', 0))
        raw_tpa = _num(f.get('_rawTeamPassAtt', 0))
        raw_tpc = _num(f.get('_rawTeamPassCompletions', 0))
        f['collegeCompletionPct'] = round(raw_pc / raw_pa, 3) if raw_pa > 0 else 0
        team_comp = raw_tpc / raw_tpa if raw_tpa > 0 else 0
        f['collegeCompletionPctOverTeam'] = round(f['collegeCompletionPct'] - team_comp, 3) if f['collegeCompletionPct'] > 0 and team_comp > 0 else 0
        f['collegeYdsPerCompletion'] = round(raw_py / raw_pc, 2) if raw_pc > 0 else 0

        # PDF scouting features — The Beast / RSP / Late-Round Guide
        # consensus. Zero-filled for pre-2022 classes; pdfHasData /
        # pdfHasRank let the GBM distinguish "no data" from the zero
        # endpoint of each continuous field.
        pdf_entry = _lookup_pdf(pdf_idx, entry['name'], entry['position'])
        f.update(_derive_pdf_features(pdf_entry))

        # RSP-specific features layered on top of the PDF baseline: tier-
        # embedded DOT score, tier-class ordinal, cross-year DOT trajectory,
        # and number of NFL comps. Zero-filled for prospects not in any RSP.
        hr_key = (_norm_pdf_name(entry['name']), entry['position'])
        f.update(_derive_rsp_features(
            pdf_entry, rsp_hr_idx.get(hr_key), entry['draft_season']
        ))


        career_rows.append({
            'name': entry['name'],
            'position': entry['position'],
            'draft_season': entry['draft_season'],
            'best2of3': best2of3,
            'features': f,
        })

    # Disagreement features depend on per-position z-scoring across the
    # full cohort, so they're a second pass after every row is built.
    _attach_disagreement_features(career_rows)

    return career_rows


def recency_weight(season: int, max_season: int, scheme) -> int:
    """Per-row training weight as a function of how recent the draft class is.

    `scheme` is either None (no weighting; every row gets weight 1) or a
    (recent, mid, old) tuple applied to gaps of ≤3, 4–7, ≥8 years from
    `max_season`. Centralising the policy in one dict (POS_RECENCY_SCHEMES)
    makes per-position tuning a single-line change.
    """
    if scheme is None:
        return 1
    r, m, o = scheme
    gap = max_season - season
    if gap <= 3:
        return r
    if gap <= 7:
        return m
    return o


# Per-position recency-weighting schemes for pre-draft training. Validated by
# a LOSO sweep over (1,1,1)/(2,1,1)/(2,2,1)/(3,2,1)/(4,2,1)/(3,1,1)/(5,3,1):
#   QB (n=133): no weighting wins (R² 0.336 → 0.344). The previous (3,2,1)
#       was over-amplifying recent classes on a tiny sample, inflating
#       modern #1 picks above their historical comps.
#   RB (n=315): (3,1,1) wins (R² 0.340 → 0.347). Earlier policy excluded RB
#       on the assumption recency hurts; that turned out to be stale once
#       feature set + hyperparams were retuned.
#   WR (n=456): flat within noise across all schemes; dropping for symmetry.
#   TE (n=207): (3,1,1) wins (R² 0.324 → 0.340). Sharp recency helps the
#       smaller sample without overfitting.
POS_RECENCY_SCHEMES: dict = {
    'QB': None,
    'RB': (3, 1, 1),
    'WR': None,
    'TE': (3, 1, 1),
}


# ── Training ──────────────────────────────────────────────────────────

def train_position(career_rows: list, pos: str, feature_keys: list[str],
                   is_post_draft: bool = False) -> dict:
    """Train rookie career model for one position. Returns JSON-serializable result."""
    t0 = time.time()
    pos_rows = [r for r in career_rows if r['position'] == pos]
    if len(pos_rows) < 10:
        return {}

    hyper = POS_HYPERPARAMS.get(pos, POS_HYPERPARAMS['WR'])
    thresholds = PPG_THRESHOLDS[pos]
    seasons = sorted(set(r['draft_season'] for r in pos_rows))
    max_season = max(seasons)
    recency_scheme = POS_RECENCY_SCHEMES.get(pos)
    use_recency = recency_scheme is not None

    # College-only companion model for WR/RB pre-draft (catches late-round breakouts)
    # pdfRankOverallMean / pdfHasRank are treated as draft-capital-adjacent
    # so the late-round-breakout companion model ignores them. Scout
    # consensus rank correlates strongly with pick and pulls the companion
    # away from the pure college-production signal it's meant to capture.
    # Also prevents RB companion from auto-activating (≥4 college-only
    # keys threshold) when we add the scout-rank pair.
    DRAFT_CAPITAL_KEYS = {'logDraftPick', 'invDraftPick',
                          'draftPickXEarlyDeclare', 'collegeDominatorXLateRound',
                          'pdfRankOverallMean', 'pdfHasRank'}
    college_only_keys = [k for k in feature_keys if k not in DRAFT_CAPITAL_KEYS]
    use_companion = not is_post_draft and len(college_only_keys) >= 4 and pos in ('WR', 'RB')
    N_BAGS = 5  # bagged LightGBM ensemble

    # Build feature matrix
    def make_X(rows, keys=None):
        keys = keys or feature_keys
        return np.array([[r['features'].get(k, 0) or 0 for k in keys] for r in rows])

    def make_y(rows):
        return np.array([r['best2of3'] for r in rows])

    def expand(rows):
        if not use_recency:
            return rows
        out = []
        for r in rows:
            w = recency_weight(r['draft_season'], max_season, recency_scheme)
            out.extend([r] * w)
        return out

    def train_lgb_bagged(X_tr, y_tr, X_te, feat_names, n_bags=N_BAGS):
        """Train bagged LightGBM ensemble, return averaged predictions."""
        bag_preds = []
        for bag_i in range(n_bags):
            params = {
                'objective': 'regression', 'metric': 'mae',
                'learning_rate': hyper['lr'], 'max_depth': hyper['max_depth'],
                'min_child_samples': hyper['min_child'],
                'subsample': 0.8, 'colsample_bytree': 0.8,
                'bagging_fraction': 0.8, 'bagging_freq': 1,
                'extra_trees': True,
                'verbose': -1, 'seed': 42 + bag_i, 'n_jobs': 1,
            }
            dtrain = lgb.Dataset(X_tr, y_tr, feature_name=feat_names, free_raw_data=False)
            model = lgb.train(params, dtrain, num_boost_round=hyper['n_estimators'])
            bag_preds.append(model.predict(X_te))
        return np.mean(bag_preds, axis=0)

    def train_lgb_bagged_binary(X_tr, y_tr, X_te, feat_names, n_bags=N_BAGS):
        """Train bagged LightGBM for binary classification."""
        bag_preds = []
        for bag_i in range(n_bags):
            params = {
                'objective': 'binary', 'metric': 'binary_logloss',
                'learning_rate': hyper['lr'], 'max_depth': hyper['max_depth'],
                'min_child_samples': max(hyper['min_child'], 5),
                'subsample': 0.8, 'colsample_bytree': 0.8,
                'bagging_fraction': 0.8, 'bagging_freq': 1,
                'extra_trees': True,
                'verbose': -1, 'seed': 42 + bag_i, 'n_jobs': 1,
            }
            dtrain = lgb.Dataset(X_tr, y_tr, feature_name=feat_names, free_raw_data=False)
            model = lgb.train(params, dtrain, num_boost_round=hyper['n_estimators'])
            bag_preds.append(model.predict(X_te))
        return np.mean(bag_preds, axis=0)

    # ── LOSO Cross-Validation ─────────────────────────────────────────
    loso_data = []

    for held_season in seasons:
        train_raw = [r for r in pos_rows if r['draft_season'] != held_season]
        test = [r for r in pos_rows if r['draft_season'] == held_season]
        if len(train_raw) < 10 or len(test) == 0:
            continue

        train = expand(train_raw)
        X_tr, y_tr = make_X(train), make_y(train)
        X_te = make_X(test)

        # Ridge regression
        ridge = Ridge(alpha=hyper['ridge_alpha'])
        ridge.fit(X_tr, y_tr)
        ridge_preds = ridge.predict(X_te)

        # Bagged LightGBM ensemble
        if len(train) >= 40:
            lgb_preds = train_lgb_bagged(X_tr, y_tr, X_te, feature_keys)
            main_preds = np.clip((ridge_preds + lgb_preds) / 2, 0, None)
        else:
            main_preds = np.clip(ridge_preds, 0, None)

        # College-only companion model (WR/RB pre-draft only)
        if use_companion and len(train) >= 40:
            X_tr_co = make_X(train, college_only_keys)
            X_te_co = make_X(test, college_only_keys)
            ridge_co = Ridge(alpha=hyper['ridge_alpha'])
            ridge_co.fit(X_tr_co, y_tr)
            lgb_co = train_lgb_bagged(X_tr_co, y_tr, X_te_co, college_only_keys)
            co_preds = np.clip((ridge_co.predict(X_te_co) + lgb_co) / 2, 0, None)
            reg_preds = main_preds * 0.7 + co_preds * 0.3
        else:
            reg_preds = main_preds

        # Per-threshold binary classifiers
        thresh_probs = [{} for _ in test]
        for thresh in thresholds:
            y_bin = (make_y(train) >= thresh).astype(float)
            pos_rate = y_bin.mean()
            if pos_rate < 0.05 or pos_rate > 0.95:
                for i in range(len(test)):
                    thresh_probs[i][thresh] = round(pos_rate * 100, 1)
                continue

            ridge_bin = Ridge(alpha=hyper['ridge_alpha'])
            ridge_bin.fit(X_tr, y_bin)
            ridge_bin_preds = ridge_bin.predict(X_te)

            if len(train) >= 40:
                lgb_bin_preds = train_lgb_bagged_binary(X_tr, y_bin, X_te, feature_keys)
                bin_preds = np.clip((ridge_bin_preds + lgb_bin_preds) / 2, 0, 1)
            else:
                bin_preds = np.clip(ridge_bin_preds, 0, 1)

            for i in range(len(test)):
                thresh_probs[i][thresh] = round(float(bin_preds[i]) * 100, 1)

        for i, r in enumerate(test):
            loso_data.append({
                'name': r['name'],
                'season': held_season,
                'actual': r['best2of3'],
                'pred': round(float(reg_preds[i]), 2),
                'thresh_probs': thresh_probs[i],
                'features': {k: float(r['features'].get(k, 0) or 0) for k in feature_keys},
                'all_features': r['features'],
            })

    if len(loso_data) < 5:
        return {}

    # ── Metrics ───────────────────────────────────────────────────────
    actuals = np.array([d['actual'] for d in loso_data])
    preds = np.array([d['pred'] for d in loso_data])
    residuals = actuals - preds

    r2 = round(float(r2_score(actuals, preds)), 3)
    mae = round(float(mean_absolute_error(actuals, preds)), 2)
    rho, _ = spearmanr(-preds, -actuals)
    rho = round(float(rho), 3)
    res_std = round(float(np.std(residuals)), 2)
    sorted_residuals = sorted(residuals.tolist())

    def quantile(q):
        if not sorted_residuals:
            return 0
        idx = max(0, min(len(sorted_residuals) - 1, round(q * (len(sorted_residuals) - 1))))
        return round(sorted_residuals[idx], 2)

    residual_quantiles = {
        'p10': quantile(0.10), 'p25': quantile(0.25), 'p50': quantile(0.50),
        'p75': quantile(0.75), 'p90': quantile(0.90),
    }

    # ── Conditional residuals (heteroscedastic boom/bust) ─────────────
    boom_thresh = mae * 0.75
    n_booms = sum(1 for r in residuals if r > boom_thresh)
    n_busts = sum(1 for r in residuals if r < -boom_thresh)
    boom_base_rate = n_booms / len(loso_data) if len(loso_data) > 0 else 0
    bust_base_rate = n_busts / len(loso_data) if len(loso_data) > 0 else 0

    def _safe_float(v):
        if v is None or v == '' or v == 'NA' or v == 'NaN':
            return 0.0
        try:
            return float(v)
        except (ValueError, TypeError):
            return 0.0

    sorted_by_pred = sorted(loso_data, key=lambda d: -d['pred'])
    n = len(sorted_by_pred)
    bin_defs = [
        ('high', 0, round(n * 0.2)),
        ('mid', round(n * 0.2), round(n * 0.8)),
        ('low', round(n * 0.8), n),
    ]
    cond_bins = []
    for label, start, end in bin_defs:
        bin_rows = sorted_by_pred[start:end]
        if not bin_rows:
            continue
        bin_res = [d['actual'] - d['pred'] for d in bin_rows]
        bin_mean = np.mean(bin_res)
        bin_std = round(float(np.std(bin_res)), 2)
        bin_booms = sum(1 for r in bin_res if r > boom_thresh)
        bin_busts = sum(1 for r in bin_res if r < -boom_thresh)
        cond_bins.append({
            'label': label,
            'predMin': round(bin_rows[-1]['pred'], 1),
            'predMax': round(bin_rows[0]['pred'], 1),
            'residuals': sorted([round(r, 2) for r in bin_res]),
            'std': bin_std,
            'boomRate': round(bin_booms / len(bin_rows) * 100, 1),
            'bustRate': round(bin_busts / len(bin_rows) * 100, 1),
        })

    # ── Per-player boom/bust via talent-vs-draft outperformance model ──
    # Predicts which players will outperform their predicted PPG rank using
    # features NOT in the regression model: athleticism, college production
    # gaps vs draft position, and adversity signals (injury/off-year proxies).
    #
    # Boom = predicted bottom 50%, actual top 20% (late pick, elite production)
    # Bust = predicted top 20%, actual bottom 50% (high pick, disappointing)

    # Compute outperformance target: actual rank - predicted rank
    pred_ranks = np.argsort(np.argsort([d['pred'] for d in loso_data])) / n
    actual_ranks = np.argsort(np.argsort([d['actual'] for d in loso_data])) / n
    outperformance = actual_ranks - pred_ranks

    GAP_FEAT_NAMES = BOOM_GAP_FEATURES_BY_POS.get(pos, _GAP_BASE)

    def _build_gap_features(d_item):
        """Wrap _compute_gap_signals() and select per-position keys."""
        sig = _compute_gap_signals(d_item.get('all_features', {}))
        return [sig[k] for k in GAP_FEAT_NAMES]

    X_gap = np.nan_to_num(np.array([_build_gap_features(d) for d in loso_data], dtype=np.float64))
    outperf_preds = np.zeros(n)

    for held_season in seasons:
        tr_idx = [i for i, d in enumerate(loso_data) if d['season'] != held_season]
        te_idx = [i for i, d in enumerate(loso_data) if d['season'] == held_season]
        if len(tr_idx) < 20 or not te_idx:
            continue
        gap_params = {
            'objective': 'regression', 'metric': 'mae', 'learning_rate': 0.03,
            'max_depth': 2, 'min_child_samples': max(5, len(tr_idx) // 8),
            'subsample': 0.7, 'colsample_bytree': 0.6, 'verbose': -1, 'seed': 42,
            'n_jobs': 1, 'extra_trees': True,
        }
        dt_gap = lgb.Dataset(X_gap[tr_idx], outperformance[tr_idx],
                             feature_name=GAP_FEAT_NAMES, free_raw_data=False)
        gap_model = lgb.train(gap_params, dt_gap, num_boost_round=60)
        outperf_preds[te_idx] = gap_model.predict(X_gap[te_idx])

    # Convert outperformance predictions to boom percentile.
    outperf_pctile = np.argsort(np.argsort(outperf_preds)) / n * 100

    # ── Bust classifier (binary, residual < -boom_thresh = real bust event) ──
    # Was: median-split target (50/50 by construction → model learned no signal,
    # all prospects clipped to 50% by min(50,...) cap). Now mirrors boom: real
    # underperformance event ~25-30% positive class, classifier has signal to find.
    y_bust_binary = np.array([1 if (d['actual'] - d['pred']) < -boom_thresh else 0 for d in loso_data])

    # Build bust-specific features (median_ppg used only for hits_in_top heuristic)
    median_ppg = sorted([d['actual'] for d in loso_data])[int(n * 0.5)]
    hits_in_top = [d for d in loso_data if d['pred'] >= np.percentile([d['pred'] for d in loso_data], 75) and d['actual'] > median_ppg]
    avg_speed_hit = float(np.mean([_safe_float(d['all_features'].get('speedScore', 0)) for d in hits_in_top if _safe_float(d['all_features'].get('speedScore', 0)) > 0])) if hits_in_top else 100
    avg_dom_hit = float(np.mean([_safe_float(d['all_features'].get('collegeDominatorRating', 0)) for d in hits_in_top if _safe_float(d['all_features'].get('collegeDominatorRating', 0)) > 0])) if hits_in_top else 30

    BUST_FEAT_NAMES = BUST_FEATURES_BY_POS.get(pos, _BUST_BASE)

    def _build_bust_features(d_item):
        sig = _compute_bust_signals(d_item.get('all_features', {}),
                                    d_item['pred'],
                                    avg_speed_hit, avg_dom_hit)
        return [sig[k] for k in BUST_FEAT_NAMES]

    X_bust = np.nan_to_num(np.array([_build_bust_features(d) for d in loso_data], dtype=np.float64))
    bust_scores = np.full(n, float(y_bust_binary.mean()))

    for held_season in seasons:
        tr_idx = [i for i, d in enumerate(loso_data) if d['season'] != held_season]
        te_idx = [i for i, d in enumerate(loso_data) if d['season'] == held_season]
        if len(tr_idx) < 20 or not te_idx or sum(y_bust_binary[tr_idx]) < 3:
            continue
        bust_params = {
            'objective': 'binary', 'metric': 'auc', 'learning_rate': 0.03,
            'max_depth': 2, 'min_child_samples': max(3, len(tr_idx) // 10),
            'subsample': 0.7, 'colsample_bytree': 0.6, 'verbose': -1,
            'seed': 42, 'n_jobs': 1, 'is_unbalance': True, 'extra_trees': True,
        }
        dt_bust = lgb.Dataset(X_bust[tr_idx], y_bust_binary[tr_idx],
                              feature_name=BUST_FEAT_NAMES, free_raw_data=False)
        bust_model = lgb.train(bust_params, dt_bust, num_boost_round=60)
        bust_scores[te_idx] = bust_model.predict(X_bust[te_idx])

    # ── Final boom/bust models on ALL data (for feature importance) ────
    # The LOSO models above are used for per-player scoring. Here we train
    # one more model per objective on the full dataset purely to extract
    # feature importance for the model docs. Direction is inferred from
    # each feature's Spearman correlation with the target (gain importance
    # has no natural sign).
    def _normalize_importance(gains: np.ndarray, names: list[str],
                               targets: np.ndarray, feats: np.ndarray) -> list[dict]:
        total = float(gains.sum())
        if total <= 0:
            return []
        entries = []
        for i, name in enumerate(names):
            imp = float(gains[i]) / total
            if imp <= 0:
                continue
            try:
                rho, _ = spearmanr(feats[:, i], targets)
                if math.isnan(rho):
                    rho = 0.0
            except Exception:
                rho = 0.0
            entries.append({
                'key': name,
                'importance': round(imp, 6),
                'direction': 'positive' if rho >= 0 else 'negative',
            })
        entries.sort(key=lambda e: -e['importance'])
        return entries

    boom_feature_importance: list[dict] = []
    if len(loso_data) >= 20:
        try:
            gap_final = lgb.train(
                {
                    'objective': 'regression', 'metric': 'mae', 'learning_rate': 0.03,
                    'max_depth': 2, 'min_child_samples': max(5, n // 8),
                    'subsample': 0.7, 'colsample_bytree': 0.6, 'verbose': -1,
                    'seed': 42, 'n_jobs': 1, 'extra_trees': True,
                },
                lgb.Dataset(X_gap, outperformance, feature_name=GAP_FEAT_NAMES,
                            free_raw_data=False),
                num_boost_round=60,
            )
            boom_feature_importance = _normalize_importance(
                gap_final.feature_importance(importance_type='gain'),
                GAP_FEAT_NAMES, outperformance, X_gap,
            )
        except Exception as e:
            print(f"    {pos}: boom feature importance skipped ({e})")

    bust_feature_importance: list[dict] = []
    if len(loso_data) >= 20 and sum(y_bust_binary) >= 5:
        try:
            bust_final = lgb.train(
                {
                    'objective': 'binary', 'metric': 'auc', 'learning_rate': 0.03,
                    'max_depth': 2, 'min_child_samples': max(3, n // 10),
                    'subsample': 0.7, 'colsample_bytree': 0.6, 'verbose': -1,
                    'seed': 42, 'n_jobs': 1, 'is_unbalance': True, 'extra_trees': True,
                },
                lgb.Dataset(X_bust, y_bust_binary, feature_name=BUST_FEAT_NAMES,
                            free_raw_data=False),
                num_boost_round=60,
            )
            bust_feature_importance = _normalize_importance(
                bust_final.feature_importance(importance_type='gain'),
                BUST_FEAT_NAMES, y_bust_binary.astype(np.float64), X_bust,
            )
        except Exception as e:
            print(f"    {pos}: bust feature importance skipped ({e})")

    # Assign boom (from outperformance model) and bust (from bust classifier).
    # Both use the same percentile-bridge pattern so a low-rank prospect gets
    # ~50% of base rate and a top-rank prospect gets ~150%, capped at 50%.
    # Also emit z-scores (raw classifier output standardized against the LOSO
    # cohort) — used by the prospects view in place of misleading %s.
    bust_pctile_arr = np.argsort(np.argsort(bust_scores)) / max(n, 1) * 100
    boom_mean, boom_std = float(np.mean(outperf_preds)), float(np.std(outperf_preds)) or 1.0
    bust_mean, bust_std = float(np.mean(bust_scores)), float(np.std(bust_scores)) or 1.0
    for i, d in enumerate(loso_data):
        pctile = outperf_pctile[i]
        d['boom_prob'] = round(min(50, boom_base_rate * 100 * (0.5 + pctile / 100)), 1)
        bp = float(bust_pctile_arr[i])
        d['bust_prob'] = round(min(50, bust_base_rate * 100 * (0.5 + bp / 100)), 1)
        d['boom_z'] = round((float(outperf_preds[i]) - boom_mean) / boom_std, 2)
        d['bust_z'] = round((float(bust_scores[i]) - bust_mean) / bust_std, 2)

    # ── Threshold metrics ─────────────────────────────────────────────
    threshold_metrics = []
    for thresh in thresholds:
        probs = [d['thresh_probs'].get(thresh, 0) / 100 for d in loso_data]
        labels = [1 if d['actual'] >= thresh else 0 for d in loso_data]
        base_rate = sum(labels) / len(labels) if labels else 0
        brier = sum((p - l) ** 2 for p, l in zip(probs, labels)) / len(probs) if probs else 0
        predicted = [1 if p >= 0.5 else 0 for p in probs]
        tp = sum(1 for p, l in zip(predicted, labels) if p == 1 and l == 1)
        fp = sum(1 for p, l in zip(predicted, labels) if p == 1 and l == 0)
        fn = sum(1 for p, l in zip(predicted, labels) if p == 0 and l == 1)
        correct = sum(1 for p, l in zip(predicted, labels) if p == l)
        threshold_metrics.append({
            'threshold': thresh,
            'accuracy': round(correct / len(labels) * 100, 1) if labels else 0,
            'precision': round(tp / (tp + fp) * 100, 1) if tp + fp > 0 else 0,
            'recall': round(tp / (tp + fn) * 100, 1) if tp + fn > 0 else 0,
            'brierScore': round(brier, 3),
            'baseRate': round(base_rate * 100, 1),
            'auc': 0,  # simplified — can add full AUC later
        })

    # ── Threshold hit-rate table (by model tier) ──────────────────────
    scored = sorted(loso_data, key=lambda d: -sum(d['thresh_probs'].get(t, 0) for t in thresholds))
    total = len(scored)
    tier_cuts = [
        ('Tier 1', 0, round(total * 0.10)),
        ('Tier 2', round(total * 0.10), round(total * 0.30)),
        ('Tier 3', round(total * 0.30), round(total * 0.70)),
        ('Tier 4', round(total * 0.70), round(total * 0.90)),
        ('Tier 5', round(total * 0.90), total),
    ]
    threshold_table = {'thresholds': thresholds, 'tiers': []}
    for label, start, end in tier_cuts:
        tier_rows = scored[start:end]
        if not tier_rows:
            continue
        avg_probs = [sum(d['thresh_probs'].get(t, 0) for t in thresholds) / len(thresholds) for d in tier_rows]
        hit_rates = [round(sum(1 for d in tier_rows if d['actual'] >= t) / len(tier_rows) * 100, 1) for t in thresholds]
        threshold_table['tiers'].append({
            'label': label, 'min': min(avg_probs), 'max': max(avg_probs),
            'n': len(tier_rows), 'hitRates': hit_rates,
        })

    # ── Backtest rows ─────────────────────────────────────────────────
    backtest_raw = []
    for d in loso_data:
        prob_values = [d['thresh_probs'].get(t, 0) for t in thresholds]
        mean_prob = sum(prob_values) / len(prob_values)
        backtest_raw.append({
            'name': d['name'], 'position': pos, 'draftSeason': d['season'],
            'actualPPG': round(d['actual'], 1),
            'predictedPPG': round(d['pred'], 1),
            'combinedScore': mean_prob,
            'percentile': 0,
            'modelTier': 0,
            'thresholdProbs': {str(k): v for k, v in d['thresh_probs'].items()},
            'boomProb': d.get('boom_prob', 0),
            'bustProb': d.get('bust_prob', 0),
            'boomZ': d.get('boom_z', 0),
            'bustZ': d.get('bust_z', 0),
            'features': d.get('all_features', {}),
        })

    # Rescale combined scores to 0-100
    raw_scores = [r['combinedScore'] for r in backtest_raw]
    min_s, max_s = min(raw_scores), max(raw_scores)
    range_s = max_s - min_s
    for r in backtest_raw:
        r['combinedScore'] = round(5 + ((r['combinedScore'] - min_s) / range_s) * 93, 1) if range_s > 0 else 50

    backtest_raw.sort(key=lambda r: -r['combinedScore'])
    for i, r in enumerate(backtest_raw):
        r['percentile'] = round((1 - i / len(backtest_raw)) * 100)
        pctl = r['percentile']
        if pctl >= 95: r['modelTier'] = 1
        elif pctl >= 85: r['modelTier'] = 2
        elif pctl >= 70: r['modelTier'] = 3
        elif pctl >= 50: r['modelTier'] = 4
        elif pctl >= 25: r['modelTier'] = 5
        else: r['modelTier'] = 6

    # WR Alpha requires first-round draft capital. Non-R1 WRs who hit
    # Alpha purely via the predicted-PPG percentile tend to be noise:
    # Tee Higgins (pk 33, hit) and James Washington (pk 60, miss) are
    # the only two, and the base rate on 2nd+ round WR Alpha hitters
    # is low enough that capping at BlueChip is honest. First-round
    # pedigree for WR is the strongest single signal for Alpha-level
    # outcomes — see backtest breakdowns. Applies only to WR; RB can
    # still hit Alpha from a late pick (Breece Hall pk 36).
    # Caps modelTier, percentile, AND predictedPPG so every downstream
    # reader (UI tabs, ZAP compare) shows consistent BlueChip values.
    if pos == 'WR':
        pred_sorted = sorted(r['predictedPPG'] for r in backtest_raw)
        bc_ceiling_ppg = (pred_sorted[min(len(pred_sorted) - 1,
                                          int(len(pred_sorted) * 0.94))]
                          if pred_sorted else 0.0)
        for r in backtest_raw:
            feats = r.get('features') or {}
            pk = feats.get('nflDraftPick') or 0
            rd = feats.get('nflDraftRound') or 0
            is_r1 = (0 < rd <= 1) or (0 < pk <= 32)
            if not is_r1 and r['modelTier'] == 1:
                r['modelTier'] = 2  # cap at BlueChip
                r['percentile'] = min(r['percentile'], 94)
                if bc_ceiling_ppg > 0 and r['predictedPPG'] > bc_ceiling_ppg:
                    r['predictedPPG'] = round(bc_ceiling_ppg, 1)

    # ── Scout-disagreement override (first-round prospects only) ──────
    # Model predicted PPG is conservative on scout-darlings with mid
    # college production (Bijan, Gibbs, JSN, Olave). Where scout
    # consensus and NFL draft capital agree — first-round pick + strong
    # PDF/RSP signal — upgrade the tier to scout consensus. First-round
    # gate filters out late-round scout-favorites that bust (Jalin Hyatt,
    # Keon Coleman, MarShawn Lloyd). Diagnostic: see
    # scripts/diagnose_scout_disagreement.py.
    def _scout_composite(feats):
        pdf_rank = float(feats.get('pdfRankOverallMean') or 0)
        has_pdf  = float(feats.get('pdfHasRank') or 0)
        pdf_score = max(0.0, 1 - pdf_rank/100.0) if has_pdf else 0.0
        return (0.35 * pdf_score
              + 0.20 * float(feats.get('recruitRating') or 0)
              + 0.20 * (float(feats.get('rspDotDraft') or 0) / 100.0)
              + 0.15 * (float(feats.get('rspTierOrdinal') or 0) / 10.0)
              + 0.10 * (float(feats.get('rspBreadthDraft') or 0) / 100.0))
    def _prod_composite(feats):
        return (0.6 * float(feats.get('collegeUsageOverall') or 0)
              + 0.4 * (float(feats.get('collegeDominatorRating') or 0) / 100.0))

    scout_vals = [_scout_composite(r.get('features') or {}) for r in backtest_raw]
    prod_vals  = [_prod_composite(r.get('features') or {})  for r in backtest_raw]
    if len(scout_vals) >= 3:
        s_m = sum(scout_vals) / len(scout_vals)
        s_s = (sum((v - s_m) ** 2 for v in scout_vals) / (len(scout_vals) - 1)) ** 0.5 or 1.0
        p_m = sum(prod_vals) / len(prod_vals)
        p_s = (sum((v - p_m) ** 2 for v in prod_vals) / (len(prod_vals) - 1)) ** 0.5 or 1.0
        for r in backtest_raw:
            feats = r.get('features') or {}
            pick = int(feats.get('nflDraftPick') or 0)
            round_ = int(feats.get('nflDraftRound') or 0)
            # First-round only — either by round=1 or pick <=32 (some
            # historical rows have round=0 but the pick populated).
            if not ((0 < round_ <= 1) or (0 < pick <= 32)):
                continue
            sc = _scout_composite(feats)
            pr = _prod_composite(feats)
            scout_z = (sc - s_m) / s_s
            prod_z  = (pr - p_m) / p_s
            gap_z   = scout_z - prod_z
            # Scout tier implied by scout_z alone. Thresholds tuned
            # per-position against the 2022-2025 validation sweep (see
            # scripts/sweep_scout_thresholds.py):
            #   QB  2.2σ — drops tbd cases, keeps Caleb/Maye/Stroud/Daniels
            #   RB  2.0σ — RB override never fires (percentile handles it)
            #   WR  2.4σ — drops Worthy/Pearsall/Legette without losing
            #              the Olave/London/G.Wilson/JSN/Nabers class
            #   TE  1.6σ — low bar so Kincaid stays upgraded; higher
            #              thresholds turn TE override into a no-op
            ALPHA_Z = {'QB': 2.2, 'RB': 2.0, 'WR': 2.4, 'TE': 1.6}.get(pos, 2.0)
            BLUE_Z  = {'QB': 1.3, 'RB': 1.3, 'WR': 1.4, 'TE': 1.0}.get(pos, 1.3)
            if   scout_z >= ALPHA_Z:  scout_tier = 1
            elif scout_z >= BLUE_Z:   scout_tier = 2
            elif scout_z >= 0.5:      scout_tier = 3
            elif scout_z >= -0.3:     scout_tier = 4
            elif scout_z >= -1.0:     scout_tier = 5
            else:                     scout_tier = 6
            # Upgrade only. Require scout consensus to be ≥1σ above
            # production, and production not catastrophically low.
            if (scout_tier < r['modelTier']
                    and gap_z >= 1.0 and prod_z >= -1.5):
                r['modelTier'] = scout_tier

            # Scout-consensus prediction boost. Formula E (min of gap and
            # scout) — best-performing of 5 candidates against 2022-2024
            # validation (scripts/sweep_scout_boost_formulas.py):
            #   MAE 2.83 → 1.88 (gap-only formula: 1.95)
            #   bias +2.02 → +0.22
            # Requires BOTH scout_z and gap_z to be elevated — hedges
            # against "high gap from low production alone" or "high scout
            # with no meaningful gap." Fires under the same Alpha-tier
            # override conditions.
            if (scout_z >= ALPHA_Z and gap_z >= 1.0 and prod_z >= -1.5):
                scout_contrib = max(0.0, scout_z - 1.3)
                gap_contrib   = max(0.0, gap_z   - 0.3)
                boost = min(min(scout_contrib, gap_contrib) * 1.2, 3.0)
                r['predictedPPG'] = round(r['predictedPPG'] + boost, 1)

    # ── Feature importance (from final Ridge on all data) ─────────────
    all_rows_expanded = expand(pos_rows)
    X_all = make_X(all_rows_expanded)
    y_all = make_y(all_rows_expanded)
    final_ridge = Ridge(alpha=hyper['ridge_alpha'])
    final_ridge.fit(X_all, y_all)

    # Companion (college-only) feature importance — Ridge coefficients on
    # the non-draft-capital feature set. Surfaces what's driving the
    # late-round breakout blend (WR/RB pre-draft only).
    companion_feature_importance: list[dict] = []
    if use_companion:
        try:
            X_all_co = make_X(all_rows_expanded, college_only_keys)
            ridge_co_final = Ridge(alpha=hyper['ridge_alpha'])
            ridge_co_final.fit(X_all_co, y_all)
            co_coeffs = ridge_co_final.coef_
            co_total = sum(abs(c) for c in co_coeffs)
            if co_total > 0:
                companion_feature_importance = sorted([
                    {
                        'key': college_only_keys[i],
                        'importance': round(abs(co_coeffs[i]) / co_total, 6),
                        'direction': 'positive' if co_coeffs[i] >= 0 else 'negative',
                    }
                    for i in range(len(college_only_keys))
                ], key=lambda f: -f['importance'])
        except Exception as e:
            print(f"    {pos}: companion feature importance skipped ({e})")

    # ── Final bagged LightGBM ensemble (shipped in cache as gbmModel) ──
    # Career models used to ship with gbmModel=None — LOSO CV used bagged
    # LGB internally for evaluation, but the final full-data model was
    # never serialized. Production rookieCareerModel.ts falls back to
    # Ridge-only when gbmModel is null, losing the GBM signal entirely.
    #
    # Now we train a matching bagged ensemble on the full (expanded) data
    # with the SAME hyperparameters used in LOSO, then serialize via
    # bagged_lgb_to_js_bag into the {models: [...]} shape that the TS
    # predictBaggedGBM consumes. This matches how ADP/PPG/residual models
    # already ship GBM trees — closing a gap the career path had.
    final_gbm_params = {
        'objective': 'regression', 'metric': 'mae',
        'learning_rate': hyper['lr'], 'max_depth': hyper['max_depth'],
        'min_child_samples': hyper['min_child'],
        'subsample': 0.8, 'colsample_bytree': 0.8,
        'bagging_fraction': 0.8, 'bagging_freq': 1,
        'extra_trees': True,
        'verbose': -1, 'seed': 42, 'n_jobs': 1,
    }
    final_gbm_boosters = []
    for bag_i in range(N_BAGS):
        p = dict(final_gbm_params)
        p['seed'] = 42 + bag_i
        p['bagging_seed'] = 42 + bag_i
        p['feature_fraction_seed'] = 42 + bag_i
        dt_final = lgb.Dataset(X_all, y_all, feature_name=feature_keys, free_raw_data=False)
        final_gbm_boosters.append(lgb.train(p, dt_final, num_boost_round=hyper['n_estimators']))
    gbm_model = _bagged_career_to_js(final_gbm_boosters, X_all, y_all, feature_keys)

    coeffs = final_ridge.coef_
    total_imp = sum(abs(c) for c in coeffs)
    feature_importance = sorted([
        {
            'key': feature_keys[i],
            'importance': round(abs(coeffs[i]) / total_imp, 6) if total_imp > 0 else 0,
            'direction': 'positive' if coeffs[i] >= 0 else 'negative',
        }
        for i in range(len(feature_keys))
    ], key=lambda f: -f['importance'])

    # ── Serialize Ridge model for JS predict() compatibility ──────────
    # JS ridge.ts expects z-score normalized features
    X_raw = make_X(pos_rows)
    means = X_raw.mean(axis=0).tolist()
    stds = X_raw.std(axis=0).tolist()
    stds = [s if s > 0 else 1.0 for s in stds]

    # Retrain on z-scored features to match JS predict() format
    X_z = (X_raw - np.array(means)) / np.array(stds)
    y_raw = make_y(pos_rows)
    y_mean = float(y_raw.mean())
    y_std = float(y_raw.std()) or 1.0
    y_z = (y_raw - y_mean) / y_std

    ridge_z = Ridge(alpha=hyper['ridge_alpha'])
    ridge_z.fit(X_z, y_z)

    # ── Scoring-time donor imputation for historical rows ───────────
    # Training coefficients stay untouched (so modern-era predictions
    # don't shift), but at inference time we substitute zero-filled
    # scout features with logDraftPick-regressed values for pre-2022
    # rookies. The ridge_z coefficients then treat historical players
    # like modern peers at the same draft slot — fixing McCluster et al.
    # without breaking anything else.
    IMPUTE_FEATS = [f for f in
                    ['pdfRankOverallMean', 'rspDotDraft', 'rspTierOrdinal',
                     'rspNComps', 'rspBreadthDraft']
                    if f in feature_keys]
    if IMPUTE_FEATS:
        DONOR = 'logDraftPick'
        # Fit donor regressions on backtest_raw MODERN subset (2022+
        # with both donor + target present).
        donor_params = {}
        for tgt in IMPUTE_FEATS:
            pairs = [
                (float(r['features'].get(DONOR, 0) or 0),
                 float(r['features'].get(tgt, 0) or 0))
                for r in backtest_raw
                if r['draftSeason'] >= 2022
                and r['features'].get(tgt, 0) not in (0, None)
                and r['features'].get(DONOR, 0) not in (0, None)
            ]
            if len(pairs) < 8: continue
            n = len(pairs)
            mx = sum(p[0] for p in pairs) / n
            my = sum(p[1] for p in pairs) / n
            sxx = sum((p[0] - mx) ** 2 for p in pairs)
            sxy = sum((p[0] - mx) * (p[1] - my) for p in pairs)
            if sxx == 0: continue
            b_coef = sxy / sxx
            donor_params[tgt] = (my - b_coef * mx, b_coef)

        means_arr = np.array(means)
        stds_arr = np.array(stds)
        overrode = 0
        for r in backtest_raw:
            # Only override historical (pre-2022) rows. Modern rows
            # might legitimately have zero scout values (e.g. scouts
            # offered no NFL comps), and overwriting those would
            # corrupt real information.
            if r['draftSeason'] >= 2022:
                continue
            feats = r['features'] or {}
            donor_val = float(feats.get(DONOR, 0) or 0)
            if donor_val == 0:
                continue
            imputed_any = False
            feats_for_x = dict(feats)
            for tgt in IMPUTE_FEATS:
                if feats.get(tgt, 0) in (0, None) and tgt in donor_params:
                    a_c, b_c = donor_params[tgt]
                    v = a_c + b_c * donor_val
                    if tgt == 'pdfRankOverallMean':
                        v = max(0.0, v)
                    elif tgt in ('rspNComps', 'rspTierOrdinal'):
                        v = max(0.0, v)
                    elif tgt in ('rspDotDraft', 'rspBreadthDraft'):
                        v = max(0.0, min(100.0, v))
                    feats_for_x[tgt] = v
                    imputed_any = True
            if not imputed_any:
                continue
            # Build z-scored feature vector for ridge_z
            x_raw = np.array([
                _safe_float_global(feats_for_x.get(k, 0) or 0)
                for k in feature_keys
            ])
            x_z = (x_raw - means_arr) / stds_arr
            pred_z = float(ridge_z.predict(x_z.reshape(1, -1))[0])
            pred_raw = pred_z * y_std + y_mean
            r['predictedPPG'] = round(max(0.0, pred_raw), 1)
            overrode += 1
        if overrode:
            print(f'    {pos}: donor-imputed predictedPPG for {overrode} historical rows')

    ridge_model = {
        'coefficients': [round(float(c), 8) for c in ridge_z.coef_],
        'intercept': round(float(ridge_z.intercept_), 8),
        'featureNames': feature_keys,
        'featureMeans': [round(m, 6) for m in means],
        'featureStds': [round(s, 6) for s in stds],
        'targetMean': round(y_mean, 6),
        'targetStd': round(y_std, 6),
        'rSquared': r2,
        'adjustedRSquared': r2,
        'mae': mae,
        'rmse': round(float(np.sqrt(np.mean(residuals ** 2))), 2),
        'n': len(pos_rows),
        'predictions': [],
    }

    elapsed = round(time.time() - t0, 1)
    print(f"    {pos}: n={len(pos_rows)}, R²={r2:.3f}, MAE={mae:.1f}, "
          f"\u03c1={rho:.3f}, \u03c3={res_std:.2f} ({elapsed}s)")

    return {
        'n': len(pos_rows),
        'cvR2': r2,
        'cvMAE': mae,
        'rankCorr': rho,
        'seasons': len(seasons),
        'featureKeys': feature_keys,
        'featureImportance': feature_importance,
        'residualStd': res_std,
        'losoResiduals': [round(r, 2) for r in sorted_residuals],
        'residualQuantiles': residual_quantiles,
        'thresholds': thresholds,
        'thresholdMetrics': threshold_metrics,
        'thresholdTable': threshold_table,
        'backtestRows': backtest_raw,
        'thresholdModels': {},  # JS scoring will use ridge_model directly
        'boomModel': None,
        'bustModel': None,
        'boomRate': round(n_booms / n * 100, 1),
        'bustRate': round(n_busts / n * 100, 1),
        'boomMetrics': None,
        'bustMetrics': None,
        'boomFeatureImportance': boom_feature_importance or None,
        'bustFeatureImportance': bust_feature_importance or None,
        'companionFeatureImportance': companion_feature_importance or None,
        'conditionalResiduals': {
            'bins': cond_bins,
            'boomThreshold': round(boom_thresh, 2),
        },
        'ridgeModel': ridge_model,
        'gbmModel': gbm_model,  # BaggedGBM ({models: [GBMModel, ...]}) emitted via bagged_lgb_to_js_bag
        'ridgeModelCompanion': None,
        'gbmModelCompanion': None,
        'companionFeatureKeys': None,
        'companionBlendWeight': 0,
        'topN': {},
    }


def _safe_float_global(v):
    if v is None or v == '' or v == 'NA' or v == 'NaN':
        return 0.0
    try:
        return float(v)
    except (ValueError, TypeError):
        return 0.0


def _build_gap_features_standalone(features: dict, predicted_ppg: float,
                                    pos: str) -> list[float]:
    """Per-position gap features for prospect scoring.

    Mirrors the in-train_position builder by deferring to
    _compute_gap_signals() and selecting the position's keys from
    BOOM_GAP_FEATURES_BY_POS. predicted_ppg is unused here (kept in the
    signature for symmetry with the bust builder) — the gap regression
    is on outperformance percentiles, not PPG levels.
    """
    sig = _compute_gap_signals(features)
    return [sig[k] for k in BOOM_GAP_FEATURES_BY_POS.get(pos, _GAP_BASE)]


def score_prospect_boom_bust(model_results: dict, career_rows: list,
                              prospects: list) -> list[dict]:
    """Score 2026 prospects using the talent-vs-draft gap model.

    Trains on full backtest data (no LOSO needed for final scoring),
    then predicts outperformance for each prospect.
    """
    # Pre-compute disagreement features on prospects so the standalone
    # scorers see the same fields the per-position BUST/BOOM lists
    # selected during training. Moments come from the historical career
    # cohort so a prospect's recruit/production gap is measured against
    # NFL rookie norms, not against the 2026 prospect class itself.
    recruit_m = _zscore_per_pos(career_rows, 'recruitRating')
    market_m = _zscore_per_pos(career_rows, 'collegeMarketShare')
    speed_m = _zscore_per_pos(career_rows, 'speedScore')
    dom_m = _zscore_per_pos(career_rows, 'collegeDominatorRating')

    def _z(val, pos, mom):
        if val == 0:
            return 0.0
        m, s = mom.get(pos, (0.0, 1.0))
        return (val - m) / s

    for p in prospects:
        f = p.get('features', {})
        if not isinstance(f, dict):
            continue
        pp = p.get('position')
        pick = max(1.0, _safe_num(f.get('nflDraftPick', 300)))
        draft_round = _safe_num(f.get('nflDraftRound', 7)) or 7.0
        pdf_rank = _safe_num(f.get('pdfRankOverallMean', 0))
        proj_round = _safe_num(f.get('pdfProjectedRound', 0))
        f['pdfRankXPick'] = (_safe_log(pdf_rank) - _safe_log(pick)) if pdf_rank > 0 else 0.0
        f['pdfRoundXActual'] = (proj_round - draft_round) if proj_round > 0 else 0.0
        recruit = _safe_num(f.get('recruitRating', 0))
        market = _safe_num(f.get('collegeMarketShare', 0))
        speed = _safe_num(f.get('speedScore', 0))
        dom = _safe_num(f.get('collegeDominatorRating', 0))
        f['recruit_production_gap'] = (
            _z(recruit, pp, recruit_m) - _z(market, pp, market_m)
            if recruit > 0 and market > 0 else 0.0
        )
        f['athletic_production_gap'] = (
            _z(speed, pp, speed_m) - _z(dom, pp, dom_m)
            if speed > 0 and dom > 0 else 0.0
        )

    results = []
    for pos in ['QB', 'RB', 'WR', 'TE']:
        mr = model_results.get(pos)
        if not mr or not mr.get('backtestRows'):
            continue
        bt = mr['backtestRows']
        n = len(bt)
        if n < 20:
            continue

        # Compute outperformance target on full backtest
        pred_ranks = np.argsort(np.argsort([r['predictedPPG'] for r in bt])) / n
        actual_ranks = np.argsort(np.argsort([r['actualPPG'] for r in bt])) / n
        outperf = actual_ranks - pred_ranks

        # Per-position feature names (BOOM/BUST_FEATURES_BY_POS)
        gap_feat_names = BOOM_GAP_FEATURES_BY_POS.get(pos, _GAP_BASE)
        bust_feat_names = BUST_FEATURES_BY_POS.get(pos, _BUST_BASE)

        # Build gap features for backtest
        X_train = []
        for r in bt:
            f = r.get('features', {})
            X_train.append(_build_gap_features_standalone(f, r['predictedPPG'], pos))
        X_train = np.nan_to_num(np.array(X_train, dtype=np.float64))

        # Train gap model on full data
        params = {
            'objective': 'regression', 'metric': 'mae', 'learning_rate': 0.03,
            'max_depth': 2, 'min_child_samples': max(5, n // 8),
            'subsample': 0.7, 'colsample_bytree': 0.6, 'verbose': -1,
            'seed': 42, 'n_jobs': 1, 'extra_trees': True,
        }
        dt = lgb.Dataset(X_train, outperf, feature_name=gap_feat_names,
                         free_raw_data=False)
        gap_model = lgb.train(params, dt, num_boost_round=60)

        # Boom/bust base rates
        mae = float(np.mean(np.abs([r['actualPPG'] - r['predictedPPG'] for r in bt])))
        boom_thresh = mae * 0.75
        residuals = [r['actualPPG'] - r['predictedPPG'] for r in bt]
        boom_base = sum(1 for r in residuals if r > boom_thresh) / n
        bust_base = sum(1 for r in residuals if r < -boom_thresh) / n

        # ── Bust classifier (mirror boom: residual < -boom_thresh) ──────
        # Was: median-split (degenerate 50/50 — model couldn't learn signal,
        # all prospects clipped to 50%). Now matches boom's real-event framing.
        y_bust_binary = np.array([1 if (r['actualPPG'] - r['predictedPPG']) < -boom_thresh else 0 for r in bt])

        # Compute avg stats for speed/production deficit
        median_ppg = sorted([r['actualPPG'] for r in bt])[int(n * 0.5)]
        hits_top = [r for r in bt if r['predictedPPG'] >= np.percentile([r['predictedPPG'] for r in bt], 75) and r['actualPPG'] > median_ppg]
        sf = _safe_float_global
        avg_speed = float(np.mean([sf(r['features'].get('speedScore', 0)) for r in hits_top if sf(r['features'].get('speedScore', 0)) > 0])) if hits_top else 100
        avg_dom = float(np.mean([sf(r['features'].get('collegeDominatorRating', 0)) for r in hits_top if sf(r['features'].get('collegeDominatorRating', 0)) > 0])) if hits_top else 30

        def _build_bust_feats(features, pred_ppg):
            sig = _compute_bust_signals(features, pred_ppg, avg_speed, avg_dom)
            return [sig[k] for k in bust_feat_names]

        X_bust_train = np.nan_to_num(np.array(
            [_build_bust_feats(r.get('features', {}), r['predictedPPG']) for r in bt],
            dtype=np.float64))

        bust_params = {
            'objective': 'binary', 'metric': 'auc', 'learning_rate': 0.03,
            'max_depth': 2, 'min_child_samples': max(3, n // 10),
            'subsample': 0.7, 'colsample_bytree': 0.6, 'verbose': -1,
            'seed': 42, 'n_jobs': 1, 'is_unbalance': True, 'extra_trees': True,
        }
        dt_bust = lgb.Dataset(X_bust_train, y_bust_binary,
                              feature_name=bust_feat_names, free_raw_data=False)
        bust_model = lgb.train(bust_params, dt_bust, num_boost_round=60)

        # ── Score prospects ───────────────────────────────────────────
        pos_prospects = [p for p in prospects if p.get('position') == pos]
        if not pos_prospects:
            continue

        # Boom scores from gap model
        X_prosp_gap = np.nan_to_num(np.array(
            [_build_gap_features_standalone(p.get('features', {}),
                                            p.get('predictedCareerPPG', 0), pos)
             for p in pos_prospects], dtype=np.float64))
        gap_scores = gap_model.predict(X_prosp_gap)
        bt_gap_scores = gap_model.predict(X_train)

        # Bust scores from bust classifier (with percentile bridge, mirroring boom)
        X_prosp_bust = np.nan_to_num(np.array(
            [_build_bust_feats(p.get('features', {}), p.get('predictedCareerPPG', 0))
             for p in pos_prospects], dtype=np.float64))
        prospect_bust_scores = bust_model.predict(X_prosp_bust)
        bt_bust_scores = bust_model.predict(X_bust_train)

        # Z-scores: prospect's raw classifier output standardized against the
        # historical NFL rookie distribution. +1.5σ bust = unusually high risk
        # for this position; −1.5σ = unusually safe. A class-level shift in
        # mean is signal, not noise — a genuinely strong class (top draft
        # capital + high predicted PPG) SHOULD read safer than typical, and
        # a weak class should read riskier. The backtest reference preserves
        # that cross-year/cross-class information.
        boom_mean, boom_std = float(np.mean(bt_gap_scores)), float(np.std(bt_gap_scores)) or 1.0
        bust_mean, bust_std = float(np.mean(bt_bust_scores)), float(np.std(bt_bust_scores)) or 1.0

        for i, p in enumerate(pos_prospects):
            pctile = float(np.mean(bt_gap_scores <= gap_scores[i]) * 100)
            boom_mult = 0.5 + (pctile / 100)
            bust_pctile = float(np.mean(bt_bust_scores <= prospect_bust_scores[i]) * 100)
            bust_mult = 0.5 + (bust_pctile / 100)
            results.append({
                'name': p['name'],
                'position': pos,
                'boomProb': round(min(50, boom_base * 100 * boom_mult), 1),
                'bustProb': round(min(50, bust_base * 100 * bust_mult), 1),
                'boomZ': round((float(gap_scores[i]) - boom_mean) / boom_std, 2),
                'bustZ': round((float(prospect_bust_scores[i]) - bust_mean) / bust_std, 2),
                'outperfPctile': round(pctile, 1),
            })

    return results


# ── Main ──────────────────────────────────────────────────────────────

def main():
    args = set(sys.argv[1:])
    do_pre = '--post-draft-only' not in args
    do_post = '--pre-draft-only' not in args

    print(f"Loading training rows from {CACHE_PATH}...")
    career_rows = load_career_rows(CACHE_PATH)
    print(f"  {len(career_rows)} career rows")

    if do_pre:
        print("\n  Training pre-draft career models (LightGBM + Ridge)...")
        pre_draft_results = {}
        for pos in ['QB', 'RB', 'WR', 'TE']:
            result = train_position(career_rows, pos, PRE_DRAFT_FEATURES[pos], is_post_draft=False)
            if result:
                pre_draft_results[pos] = result

        with open(PRE_DRAFT_CACHE, 'w') as f:
            json.dump({'rookieCareerModels': pre_draft_results}, f)
        print(f"  Pre-draft cache saved to {PRE_DRAFT_CACHE}")

        # Score 2026 prospects with the gap model for boom/bust
        print("\n  Scoring 2026 prospect boom/bust...")
        try:
            with open('public/data/feature-matrix.json') as f:
                fm = json.load(f)
            prospects = fm.get('careerPredictions2026', [])
            if prospects:
                prospect_scores = score_prospect_boom_bust(
                    pre_draft_results, career_rows, prospects)
                with open('public/data/prospect-boom-bust.json', 'w') as f:
                    json.dump(prospect_scores, f)
                print(f"  Scored {len(prospect_scores)} prospects → prospect-boom-bust.json")
        except Exception as e:
            print(f"  Prospect scoring skipped: {e}")

    if do_post:
        print("\n  Training post-draft career models (LightGBM + Ridge)...")
        post_draft_results = {}
        for pos in ['QB', 'RB', 'WR', 'TE']:
            result = train_position(career_rows, pos, POST_DRAFT_FEATURES[pos], is_post_draft=True)
            if result:
                post_draft_results[pos] = result

        with open(POST_DRAFT_CACHE, 'w') as f:
            json.dump({'rookieCareerModels': post_draft_results}, f)
        print(f"  Post-draft cache saved to {POST_DRAFT_CACHE}")

    print("\nDone.")


if __name__ == '__main__':
    main()
