"""Raw feature matrix + manual feature overrides used by the pipeline."""
from __future__ import annotations

from typing import Any

from ._fetch import fetch_json
from ._renames import rename_features_in_tree


def load_feature_matrix() -> dict[str, Any]:
    """Return the full ``feature-matrix.json`` as a dict.

    The file contains many sub-structures (``careerPredictions2026``,
    ``predRows``, ``vorNorm``, schema-per-position, etc.). Most users want
    :func:`~stathead.load_career_predictions_2026` instead — this is an
    escape hatch for advanced introspection.
    """
    return rename_features_in_tree(fetch_json("public/data/feature-matrix.json"))


def load_manual_overrides() -> dict[str, Any]:
    """Manual CFBD usage overrides keyed by ``"Name|POS"``.

    Contains per-season carries / receptions / team totals for players
    missing from CFBD's player-usage file (Odell Beckham Jr., Duke Johnson,
    Todd Gurley, etc.). See ``scripts/backfill_cfbd_variants.py``.
    """
    return fetch_json("public/data/manual-cfbd-overrides.json")
