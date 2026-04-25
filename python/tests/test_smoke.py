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


def test_prospect_grades_2026():
    df = stathead.load_prospect_grades(2026)
    assert not df.empty
    assert {"name", "pos", "grade"}.issubset(df.columns)


def test_resolve_player_and_get_player(monkeypatch):
    # Pick a player guaranteed to be in the NFL spine + easy to disambiguate
    key = stathead.resolve_player("Ja'Marr Chase", position="WR")
    assert key.startswith("sh_"), key
    rec = stathead.get_player(key)
    assert rec["display_name"] == "Ja'Marr Chase"
    assert rec["position"] == "WR"
    assert "gsis_id" in rec


def test_resolve_player_suffix_disambiguation():
    # "Frank Gore" without suffix → veteran (1983). "Frank Gore Jr." →
    # the 2022 rookie (2002-born). Exact display-name match wins even
    # though both players are RB.
    sr_key = stathead.resolve_player("Frank Gore", position="RB")
    jr_key = stathead.resolve_player("Frank Gore Jr.", position="RB")
    assert sr_key != jr_key
    assert stathead.get_player(sr_key)["birth_date"].startswith("1983-")
    assert stathead.get_player(jr_key)["birth_date"].startswith("2002-")


def test_resolve_player_raises_on_no_match():
    import pytest
    with pytest.raises(ValueError):
        stathead.resolve_player("Definitely Not A Real Player XYZ")


def test_load_player_profile_merges_tables():
    key = stathead.resolve_player("Ja'Marr Chase", position="WR")
    prof = stathead.load_player_profile(key)
    assert set(prof.keys()) >= {"crosswalk", "backtest", "adp_historical",
                                "prospect_grades"}
    assert prof["crosswalk"]["display_name"] == "Ja'Marr Chase"


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


def test_no_vendor_named_columns_leak():
    """Source-agnostic feature naming — no rsp*/pdf* columns reach users."""
    pred = stathead.load_career_predictions_2026()
    back = stathead.load_career_backtest()
    for df, label in ((pred, "predictions_2026"), (back, "backtest")):
        leaked = [c for c in df.columns if c.startswith("rsp") or c.startswith("pdf")]
        assert not leaked, f"{label} leaked vendor-named columns: {leaked}"
    # And the renamed columns are actually present.
    assert "scoutGradeDraft" in pred.columns
    assert "guideRankMean" in pred.columns


def test_feature_matrix_renames_apply_recursively():
    """load_feature_matrix() should also strip vendor-named keys from the
    nested features dicts inside backtest rows + 2026 prediction rows."""
    fm = stathead.load_feature_matrix()
    sample_2026 = (fm.get("careerPredictions2026") or [{}])[0]
    sample_back = (
        ((fm.get("rookieCareerModels") or {}).get("WR") or {}).get("backtestRows") or [{}]
    )[0]
    for sample, label in ((sample_2026, "2026"), (sample_back, "backtest")):
        feats = sample.get("features") or {}
        leaked = [k for k in feats if k.startswith("rsp") or k.startswith("pdf")]
        assert not leaked, f"{label} features dict leaked: {leaked}"


def test_pin_version_changes_cache_root(tmp_path, monkeypatch):
    # With a custom cache root, the cache file should end up under <ref>/<path>.
    monkeypatch.setattr(_fetch, "_cache_root", lambda: tmp_path)
    _fetch.set_ref("abc123")
    p = _fetch._cache_path("foo/bar.json")
    assert p.parent.name == "foo"
    assert p.parent.parent.name == "abc123"
    _fetch.set_ref("main")  # reset
