"""Smoke tests — verifies every loader returns a non-empty DataFrame when
run against a local checkout (pointed at the current working tree via a
file:// fetch override).

These tests run offline by reading files directly out of the repo's
``public/data`` folder. This keeps CI fast and avoids hitting GitHub.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd
import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "python" / "src"))

import stathead  # noqa: E402
from stathead import _fetch  # noqa: E402


@pytest.fixture(autouse=True)
def local_fetch(monkeypatch):
    """Redirect the package fetcher at the current working tree."""
    def _read(path: str) -> bytes:
        full = REPO / path
        return full.read_bytes()

    monkeypatch.setattr(_fetch, "_fetch", _read)
    yield


def test_career_predictions_2026_has_rookies():
    df = stathead.load_career_predictions_2026()
    assert not df.empty
    assert {"name", "position", "predictedCareerPPG", "modelTier", "percentile"}.issubset(df.columns)


def test_career_backtest_has_history():
    df = stathead.load_career_backtest()
    assert len(df) > 800
    assert {"name", "position", "predictedPPG", "actualPPG", "modelTier"}.issubset(df.columns)
    assert df.position.isin(["QB", "RB", "WR", "TE"]).all()


def test_adp_historical_is_fully_populated():
    df = stathead.load_adp_historical()
    assert len(df) > 4000
    assert {"season", "name", "position", "adp"}.issubset(df.columns)
    # Every season from 2010-2025 should be present.
    assert set(range(2010, 2026)).issubset(set(df.season.unique()))


def test_ktc_current_values():
    df = stathead.load_ktc()
    assert not df.empty
    assert {"name", "value_1qb", "value_superflex", "isRookie"}.issubset(df.columns)


def test_ktc_history_is_long():
    df = stathead.load_ktc_history()
    assert not df.empty
    assert {"playerID", "date", "value_1qb"}.issubset(df.columns)
    assert pd.api.types.is_datetime64_any_dtype(df.date)


def test_prospect_grades_2026():
    df = stathead.load_prospect_grades(2026)
    assert not df.empty
    assert {"name", "pos", "grade"}.issubset(df.columns)


def test_player_crosswalk_is_populated():
    df = stathead.load_player_crosswalk()
    assert len(df) > 10000
    assert {"player_key", "display_name", "position", "gsis_id"}.issubset(df.columns)
    # Every canonical key should be formatted as sh_<hex>
    assert df.player_key.str.match(r"^sh_[0-9a-f]+$").all()


def test_feature_matrix_is_dict():
    m = stathead.load_feature_matrix()
    assert isinstance(m, dict)
    assert "careerPredictions2026" in m


def test_manual_overrides_keyed_by_name_pos():
    o = stathead.load_manual_overrides()
    assert isinstance(o, dict)
    keys = [k for k in o if not k.startswith("_")]
    assert any("|" in k for k in keys)


def test_pin_version_changes_cache_root(tmp_path, monkeypatch):
    # With a custom cache root, the cache file should end up under <ref>/<path>.
    monkeypatch.setattr(_fetch, "_cache_root", lambda: tmp_path)
    _fetch.set_ref("abc123")
    p = _fetch._cache_path("foo/bar.json")
    assert p.parent.name == "foo"
    assert p.parent.parent.name == "abc123"
    _fetch.set_ref("main")  # reset
