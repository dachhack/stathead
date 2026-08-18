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


def test_player_stats_weekly_box_scores():
    df = stathead.load_player_stats(2024)
    assert not df.empty
    assert {"player_key", "player_id", "season", "week",
            "fantasy_points_ppr"}.issubset(df.columns)
    assert (df.season == 2024).all()
    # player_key should resolve for the vast majority of rows (every NFL
    # player with a GSIS ID is in the crosswalk).
    assert df.player_key.notna().mean() > 0.9


def test_redraft_projections():
    df = stathead.load_redraft_projections()
    assert not df.empty
    assert {"player_key", "name", "position", "ppg", "recPG"}.issubset(df.columns)


def test_weekly_projections():
    df = stathead.load_weekly_projections()
    assert not df.empty
    assert {"player_key", "name", "position", "team", "week", "opp", "home",
            "matchup_mult", "proj_ppr", "ppg", "gp"}.issubset(df.columns)
    # 17 scheduled games per player (byes omitted), weeks within 1-18.
    assert (df.groupby("name")["week"].count() == 17).all()
    assert df["week"].between(1, 18).all()
    # Normalization: weekly points sum back to ppg * 17 for every player.
    sums = df.groupby("name").agg(total=("proj_ppr", "sum"), ppg=("ppg", "first"))
    assert ((sums["total"] - sums["ppg"] * 17).abs() < 1.0).all()
    assert isinstance(df.attrs.get("def_vs_pos"), dict)
    # K + DST: one per team, 32 each.
    assert (df[df["position"] == "K"]["team"].nunique()) == 32
    dst = df[df["position"] == "DST"]
    assert dst["team"].nunique() == 32
    assert (dst["sleeper_id"] == dst["team"]).all()


def test_player_props_weekly_stat_lines():
    df = stathead.load_player_props()
    assert not df.empty
    assert {"player_key", "name", "position", "team", "week", "opp", "home",
            "availability", "recYds", "rec", "pprPts"}.issubset(df.columns)
    # 17 scheduled games per player (byes omitted), weeks within 1-18.
    assert (df.groupby("name")["week"].count() == 17).all()
    assert df["week"].between(1, 18).all()
    assert df["availability"].between(0, 1).all()
    # Normalization: weekly stat lines sum back to the season line.
    sums = df.groupby("name")["pprPts"].sum()
    assert (sums > 0).all()
    # Strength of matchup: a 0-100 grade where 100 = toughest, and every team
    # graded on both scales.
    defense = df.attrs["defense"]
    assert len(defense) == 32
    grades = [d["overall"]["grade"] for d in defense.values()]
    assert min(grades) == 0 and max(grades) == 100
    # The toughest defense overall must also be the one ranked first.
    toughest = max(defense.items(), key=lambda kv: kv[1]["overall"]["grade"])
    assert toughest[1]["overall"]["rank"] == 1


def test_props_pricing_and_rest_of_game():
    board = stathead.price_props("Ja'Marr Chase", 1, position="WR")
    assert not board.empty
    assert {"stat", "mean", "line", "over", "under", "p10", "p90"}.issubset(board.columns)
    # Every quoted line is a half point, so a prop can never push, and the
    # model's own line always sits near a coin flip on high-volume stats.
    assert ((board["line"] * 2) % 2 == 1).all()
    assert board["over"].between(0, 1).all()
    assert (board["p10"] <= board["p90"]).all()
    rec = board.set_index("stat").loc["rec"]
    assert 0.35 < rec["over"] < 0.65

    # Rest of game shrinks toward zero as the game runs out, and trailing
    # offenses throw more than leading ones.
    prev = None
    for q in (0, 1, 2, 3):
        rog = stathead.rest_of_game("Ja'Marr Chase", 1, q, position="WR")
        cur = rog.set_index("stat").loc["recYds", "mean"]
        if prev is not None:
            assert cur < prev
        prev = cur
    trailing = stathead.rest_of_game("Ja'Marr Chase", 1, 2, score_diff=-17,
                                     position="WR").set_index("stat")
    leading = stathead.rest_of_game("Ja'Marr Chase", 1, 2, score_diff=17,
                                    position="WR").set_index("stat")
    assert trailing.loc["recYds", "mean"] > leading.loc["recYds", "mean"]


def test_quarter_splits_shares_sum_to_one():
    splits = stathead.load_quarter_splits()
    for pos, stats in splits["share"].items():
        for stat, share in stats.items():
            assert abs(sum(share) - 1) < 0.01, f"{pos}/{stat} shares sum to {sum(share)}"
            # remaining[0] is the whole game; remaining is strictly decreasing.
            rem = splits["remaining"][pos][stat]
            assert rem[0] == 1.0
            assert all(rem[i] > rem[i + 1] for i in range(len(rem) - 1))
    frame = stathead.quarter_share_frame(splits)
    assert {"position", "stat", "q1", "q4", "rest_after_q3"}.issubset(frame.columns)


def test_ppg_and_adp_value_model():
    ppg = stathead.load_ppg_projections()
    adp = stathead.load_adp_value_model()
    assert {"name", "position", "predictedPPG"}.issubset(ppg.columns)
    assert {"name", "position", "adp", "predictedVor", "hitProb"}.issubset(adp.columns)
    # headshot URLs are stripped from the public surface.
    assert "headshotUrl" not in adp.columns


def test_volume_and_share_projections():
    vol = stathead.load_volume_projections()
    shr = stathead.load_share_projections()
    assert {"name", "teamPassAtt", "teamTargets", "projPlayerPPG"}.issubset(vol.columns)
    assert {"name", "predTargetShare", "predRushShare"}.issubset(shr.columns)


def test_taxi_predictions_carry_meta():
    df = stathead.load_taxi_predictions()
    assert {"name", "position", "p1", "p2", "pEver"}.issubset(df.columns)
    assert isinstance(df.attrs.get("meta"), dict)
    assert "thresholds" in df.attrs["meta"]


def test_career_2027_class():
    df = stathead.load_career_2027()
    assert not df.empty
    assert {"name", "pos", "grade"}.issubset(df.columns)


def test_dynasty_values_match_app_blend():
    df = stathead.load_dynasty_values()
    assert not df.empty
    assert {"name", "position", "value_1qb", "value_superflex",
            "positionRank", "isRookie"}.issubset(df.columns)
    # Sorted by 1QB value, descending.
    top = df.value_1qb.dropna().tolist()
    assert top == sorted(top, reverse=True)
    # Values are rescaled onto FantasyCalc's scale, so the top asset no
    # longer sits at KTC's hard 9999 ceiling (it maps up into FC's range).
    assert df.value_1qb.max() != 9999
    assert df.value_1qb.min() >= 0


def test_dynasty_value_history_rescaled():
    df = stathead.load_dynasty_value_history()
    assert not df.empty
    assert {"name", "position", "date", "value_1qb",
            "value_superflex"}.issubset(df.columns)


def test_query_runs_a_join():
    df = stathead.query("""
        SELECT c.name, c.predictedCareerPPG, d.value_1qb
        FROM career_2026 c
        JOIN dynasty_values d USING (player_key)
        WHERE c.percentile >= 80
        ORDER BY d.value_1qb DESC
        LIMIT 10
    """)
    assert not df.empty
    assert list(df.columns) == ["name", "predictedCareerPPG", "value_1qb"]
    # value_1qb is sorted descending.
    vals = df.value_1qb.dropna().tolist()
    assert vals == sorted(vals, reverse=True)


def test_list_tables_covers_core_loaders():
    names = set(stathead.list_tables())
    assert {"career_2026", "backtest", "player_stats", "dynasty_values",
            "adp_historical", "prospects"}.issubset(names)


def test_register_user_table_and_join():
    import pandas as pd
    # Pick a real 2026-class name so the join is guaranteed to resolve.
    rookie = stathead.load_career_predictions_2026().iloc[0]["name"]
    roster = pd.DataFrame({"name": [rookie], "slot": ["pick"]})
    stathead.register("my_roster", roster)
    assert "my_roster" in stathead.list_tables()
    df = stathead.query("""
        SELECT c.name, r.slot, c.percentile
        FROM career_2026 c JOIN my_roster r USING (name)
    """)
    assert (df.name == rookie).any()


def test_query_only_loads_referenced_tables():
    from stathead import sql
    # A query that names only career_2026 must not materialize player_stats.
    sql._connection()
    sql._registered.discard("player_stats")
    stathead.query("SELECT COUNT(*) AS n FROM career_2026")
    assert "player_stats" not in sql._registered


def test_query_without_duckdb_gives_install_hint(monkeypatch):
    import builtins
    from stathead import sql
    real_import = builtins.__import__

    def _no_duckdb(name, *args, **kwargs):
        if name == "duckdb":
            raise ImportError("No module named 'duckdb'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _no_duckdb)
    with pytest.raises(ImportError, match=r"stathead\[duckdb\]"):
        sql._duckdb()


def test_to_polars_roundtrip():
    pl = pytest.importorskip("polars")
    df = stathead.load_dynasty_values()
    pdf = stathead.to_polars(df)
    assert isinstance(pdf, pl.DataFrame)
    assert pdf.height == len(df)
    assert list(pdf.columns) == list(df.columns)


def test_load_polars_calls_loader():
    pl = pytest.importorskip("polars")
    pdf = stathead.load_polars(stathead.load_redraft_projections)
    assert isinstance(pdf, pl.DataFrame)
    assert "name" in pdf.columns


def test_to_polars_without_polars_gives_install_hint(monkeypatch):
    import builtins
    from stathead import polars as polars_mod
    real_import = builtins.__import__

    def _no_polars(name, *args, **kwargs):
        if name == "polars":
            raise ImportError("No module named 'polars'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _no_polars)
    with pytest.raises(ImportError, match=r"stathead\[polars\]"):
        polars_mod._polars()


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
