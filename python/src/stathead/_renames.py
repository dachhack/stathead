"""Source-agnostic rename of vendor-named features.

Underlying training data keeps original names so the model pipeline
keeps working; the python client renames on read so consumers see
columns that don't identify a specific scouting source.

- ``rsp*`` (single-source scout grade family) → ``scout*``
- ``pdf*`` (multi-source draft-guide aggregation) → ``guide*``
"""
from __future__ import annotations

from typing import Any

FEATURE_RENAME: dict[str, str] = {
    # Single-scout grade family
    "rspAppearances": "scoutAppearances",
    "rspBreadthDraft": "scoutBreadthDraft",
    "rspBreadthLatest": "scoutBreadthLatest",
    "rspDotDelta": "scoutGradeDelta",
    "rspDotDraft": "scoutGradeDraft",
    "rspDotLatest": "scoutGradeLatest",
    "rspDotMax": "scoutGradeMax",
    "rspHasData": "hasScoutGrade",
    "rspNComps": "scoutNComps",
    "rspTierOrdinal": "scoutTierOrdinal",
    # Multi-source draft-guide aggregation
    "pdfHasData": "hasGuideData",
    "pdfHasRank": "hasGuideRank",
    "pdfHasRound": "hasGuideRound",
    "pdfNRedFlags": "guideNRedFlags",
    "pdfNStrengths": "guideNStrengths",
    "pdfNWeaknesses": "guideNWeaknesses",
    "pdfProjectedRound": "guideProjectedRound",
    "pdfRankOverallMax": "guideRankMax",
    "pdfRankOverallMean": "guideRankMean",
    "pdfRankOverallMin": "guideRankMin",
    "pdfRankSpread": "guideRankSpread",
    "pdfRankXPick": "guideRankXPick",
    "pdfRoundXActual": "guideRoundXActual",
    "pdfSentimentNet": "guideSentimentNet",
}


def rename_feature_dict(d: dict[str, Any]) -> dict[str, Any]:
    """Return a new dict with vendor-named feature keys remapped."""
    return {FEATURE_RENAME.get(k, k): v for k, v in d.items()}


def rename_features_in_tree(node: Any) -> Any:
    """Recursively rename matching dict keys anywhere in a JSON-like tree.

    Mutates ``node`` in place and returns it. Safe because every loader
    re-parses its source file fresh; nothing else holds a reference.
    """
    if isinstance(node, dict):
        for old in [k for k in node if k in FEATURE_RENAME]:
            node[FEATURE_RENAME[old]] = node.pop(old)
        for v in node.values():
            rename_features_in_tree(v)
    elif isinstance(node, list):
        for v in node:
            rename_features_in_tree(v)
    return node
