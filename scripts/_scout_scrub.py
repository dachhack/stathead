"""Scrub vendor prose from scouting-derived JSON outputs.

Source PDFs (Matt Waldman's RSP, The Beast, PFF Draft Guide, etc.) carry
copyrighted prose. We aggregate them into numeric features for modeling
but cannot redistribute the verbatim strengths/weaknesses/summaries
themselves. These helpers take the raw extracted records and emit
derived/aggregated rows: counts, numeric ranks, anonymized guide IDs.

Used by both ``merge_pdf_features.py`` (forward path) and
``scrub_scout_data.py`` (one-off cleanup of files already on disk).
"""
from __future__ import annotations

import re
from typing import Any

# Sentiment weight matches scripts/precompute-features.ts and
# train_career_models.py — red flags count 2x, by convention.
_RED_FLAG_WEIGHT = 2

_YEAR_RE = re.compile(r"\b(20\d{2})\b")

_ROMAN_ORDINAL = {
    "I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6, "VII": 7,
    "VIII": 8, "IX": 9, "X": 10,
}


def roman_tier_ordinal(tier: str | None) -> int | None:
    """Convert a roman-numeral tier label (``"I"`` … ``"X"``) to an int.
    Returns ``None`` for anything else — keeps the call site simple even
    when upstream data carries freeform tier strings we don't preserve."""
    if isinstance(tier, str) and tier.upper() in _ROMAN_ORDINAL:
        return _ROMAN_ORDINAL[tier.upper()]
    return None


def parse_guide_year(source_file: str | None) -> int | None:
    if not source_file:
        return None
    m = _YEAR_RE.search(source_file)
    return int(m.group(1)) if m else None


def build_guide_id_map(source_files: list[str]) -> dict[str, int]:
    """Stable integer ID per source filename. Sorted alphabetically so
    re-runs produce the same mapping."""
    return {src: i + 1 for i, src in enumerate(sorted(set(source_files)))}


def _n(field: Any) -> int:
    return len(field) if isinstance(field, list) else 0


def _sentiment(strengths: Any, weaknesses: Any, red_flags: Any) -> int:
    return _n(strengths) - _n(weaknesses) - _RED_FLAG_WEIGHT * _n(red_flags)


def scrub_per_source_row(row: dict[str, Any], guide_id: int,
                         guide_year: int | None) -> dict[str, Any]:
    """Per-(player, source) record with prose stripped."""
    return {
        "player_name": row.get("player_name"),
        "position": row.get("position"),
        "college": row.get("college"),
        "guide_id": guide_id,
        "guide_year": guide_year,
        "rank_overall": row.get("rank_overall"),
        "rank_position": row.get("rank_position"),
        "projected_round": row.get("projected_round"),
        "n_strengths": _n(row.get("strengths")),
        "n_weaknesses": _n(row.get("weaknesses")),
        "n_red_flags": _n(row.get("red_flags")),
        "n_comps": _n(row.get("comps")),
        "has_summary": bool(row.get("summary")),
        "has_athletic_notes": bool(row.get("athletic_notes")),
        "confidence": row.get("confidence"),
        "sentiment_score": _sentiment(
            row.get("strengths"), row.get("weaknesses"), row.get("red_flags")
        ),
    }


def scrub_merged_row(row: dict[str, Any],
                     guide_id_map: dict[str, int]) -> dict[str, Any]:
    """Per-player aggregation across sources, prose stripped."""
    sources = row.get("sources") or []
    ranks = []
    for k in ("rank_overall_min", "rank_overall_max"):
        v = row.get(k)
        if isinstance(v, (int, float)):
            ranks.append(v)
    spread = (max(ranks) - min(ranks)) if len(ranks) == 2 else None
    return {
        "player_key": row.get("player_key"),
        "player_name": row.get("player_name"),
        "position": row.get("position"),
        "college": row.get("college"),
        "n_sources": row.get("n_sources") or len(sources),
        "guide_ids": sorted({guide_id_map[s] for s in sources if s in guide_id_map}),
        "rank_overall_min": row.get("rank_overall_min"),
        "rank_overall_mean": row.get("rank_overall_mean"),
        "rank_overall_max": row.get("rank_overall_max"),
        "rank_overall_spread": spread,
        "projected_round_mean": row.get("projected_round_mean"),
        "n_unique_strengths": _n(row.get("strengths")),
        "n_unique_weaknesses": _n(row.get("weaknesses")),
        "n_unique_red_flags": _n(row.get("red_flags")),
        "n_unique_comps": _n(row.get("comps")),
        "n_summaries": _n(row.get("summaries")),
        "sentiment_score": _sentiment(
            row.get("strengths"), row.get("weaknesses"), row.get("red_flags")
        ),
    }


def scrub_rsp_profile(rec: dict[str, Any]) -> dict[str, Any]:
    """RSP per-(player, guide-year) profile, prose stripped.

    Preserves the numeric ``cross_year_appearances`` block intact since it
    contains only ranks / DOT scores / breadth percentages.
    """
    return {
        "player_name": rec.get("player_name"),
        "position": rec.get("position"),
        "college": rec.get("college"),
        "draft_class_guide_year": rec.get("draft_class_guide_year"),
        "rank_overall": rec.get("rank_overall"),
        "rank_position": rec.get("rank_position"),
        "projected_round": rec.get("projected_round"),
        "n_strengths": _n(rec.get("strengths")),
        "n_weaknesses": _n(rec.get("weaknesses")),
        "n_red_flags": _n(rec.get("red_flags")),
        "n_comps": _n(rec.get("comps")),
        "has_summary": bool(rec.get("summary")),
        "has_athletic_notes": bool(rec.get("athletic_notes")),
        "confidence": rec.get("confidence"),
        "sentiment_score": _sentiment(
            rec.get("strengths"), rec.get("weaknesses"), rec.get("red_flags")
        ),
        "cross_year_appearances": rec.get("cross_year_appearances") or [],
    }
