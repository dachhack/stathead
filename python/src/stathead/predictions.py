"""Rookie career model predictions — 2026 class + historical backtest."""
from __future__ import annotations

import pandas as pd

from ._fetch import fetch_json
from ._renames import rename_feature_dict


def _flatten(row: dict) -> dict:
    """Lift ``features`` sub-dict into top-level columns."""
    features = row.pop("features", None) or {}
    return {**row, **rename_feature_dict(features)}


def load_career_predictions_2026() -> pd.DataFrame:
    """2026 draft-class career predictions, one row per scored prospect.

    Columns (non-exhaustive): ``name``, ``position``, ``adp``, ``team``,
    ``predictedCareerPPG``, ``percentile``, ``modelTier``, ``boomProb``,
    ``bustProb``, ``boomZ``, ``bustZ``, plus every feature in the model
    (``collegeDominatorRating``, ``collegeUsageOverall``, ``scoutGradeDraft``,
    ``guideRankMean``, ``recruitRating``, ``relativeAthleticScore``, …).
    """
    fm = fetch_json("public/data/feature-matrix.json")
    rows = [_flatten(dict(p)) for p in fm.get("careerPredictions2026") or []]
    return pd.DataFrame(rows)


def load_career_backtest() -> pd.DataFrame:
    """Historical rookie backtest rows (2010-2025) with predictedPPG + actualPPG.

    Used to evaluate the career model (both the precomputed tier system and
    the GBM + Ridge ensemble). One row per drafted prospect across QB/RB/WR/TE.

    Columns: ``name``, ``position``, ``draftSeason``, ``predictedPPG``,
    ``actualPPG``, ``percentile``, ``modelTier``, ``combinedScore``,
    plus every feature used in training.
    """
    cache = fetch_json("public/data/model-cache-career-v72.json")
    out: list[dict] = []
    for pos, model in (cache.get("rookieCareerModels") or {}).items():
        for r in model.get("backtestRows") or []:
            row = dict(r)
            row.setdefault("position", pos)
            out.append(_flatten(row))
    return pd.DataFrame(out)
