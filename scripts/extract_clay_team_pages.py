#!/usr/bin/env python3
"""Extract per-team weekly score projections + season team projections from the
team pages (guide pp. 2-33) of Mike Clay's guide.

Each team page's right column carries a "Weekly Score Projections" table
(week, opponent, V/H, team pts, opp pts, win prob) plus season totals, projected
wins, SOS rank and Off/Def/Ovr ranks. The pages aren't labeled with a team name,
so each is identified by matching its opponent sequence against our committed
schedule (public/data/schedule-<season>.json).

Writes two committed files (surfaced as "Consensus"; the PDF is not committed):
  - public/data/clay-matchups-<season>.json     (per game: proj score + win prob)
  - public/data/clay-team-projections-<season>.json  (per team season summary)

    python3 scripts/extract_clay_team_pages.py <path-to-pdf> [season]

Requires PyMuPDF:  pip install pymupdf
"""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import fitz  # PyMuPDF

CLAY_TEAM_TO_OURS = {"BLT": "BAL", "HST": "HOU", "ARZ": "ARI", "CLV": "CLE", "LAR": "LA"}
fix_team = lambda c: CLAY_TEAM_TO_OURS.get(c, c)

PCT = re.compile(r"^\d+%$")
NUM = re.compile(r"^-?\d+(?:\.\d+)?$")


def block_rows(page):
    """Right-column tokens (the schedule/summary block), grouped into rows by y."""
    words = [w for w in page.get_text("words") if w[0] >= 630]
    rows = {}
    for w in words:
        rows.setdefault(round(w[1] / 3), []).append(w)
    return [[w[4] for w in sorted(rows[y], key=lambda w: w[0])] for y in sorted(rows)]


def parse_page(rows):
    """Pull weekly games + season summary out of one team page's block rows."""
    weekly = {}          # week -> (opp_ours, is_home, tm_pts, opp_pts, win_prob)
    summary = {}
    for toks in rows:
        # weekly game row: [wk, OPP, V/H, tmPts, oppPts, NN%]
        if len(toks) >= 6 and toks[0].isdigit() and toks[2] in ("V", "H") and PCT.match(toks[-1]):
            wk = int(toks[0])
            weekly[wk] = (
                fix_team(toks[1]),
                toks[2] == "H",
                float(toks[3]), float(toks[4]),
                int(toks[5].rstrip("%")),
            )
        elif toks[:1] == ["Total"] and len(toks) >= 3 and NUM.match(toks[1]):
            summary["points_for"] = int(toks[1])
            summary["points_against"] = int(toks[2])
        elif toks[:2] == ["PROJECTED", "WINS:"]:
            summary["proj_wins"] = float(toks[2])
            m = re.search(r"(\d+)", toks[-1])
            if m:
                summary["wins_rank"] = int(m.group(1))
        elif toks[:3] == ["Strength", "of", "Schedule"]:
            summary["sos_rank"] = int(toks[-1])
        elif toks[:2] in (["Off", "Rk"], ["Def", "Rk"], ["Ovr", "Rk"]) and NUM.match(toks[2]):
            summary[{"Off": "off_rk", "Def": "def_rk", "Ovr": "ovr_rk"}[toks[0]]] = int(toks[2])
    return weekly, summary


def load_schedule(season):
    doc = json.loads(Path(f"public/data/schedule-{season}.json").read_text())
    # team -> {week: (opp, is_home)}
    by_team = {}
    for g in doc["games"]:
        by_team.setdefault(g["home"], {})[g["week"]] = (g["away"], True)
        by_team.setdefault(g["away"], {})[g["week"]] = (g["home"], False)
    return by_team


def identify(weekly, sched_by_team):
    """Find the team whose committed schedule matches this page's opponents."""
    page_map = {wk: (opp, home) for wk, (opp, home, *_) in weekly.items()}
    best, best_score = None, -1
    for team, sched in sched_by_team.items():
        score = sum(1 for wk, val in page_map.items() if sched.get(wk) == val)
        if score > best_score:
            best, best_score = team, score
    # require a near-perfect match (allow tiny PDF noise)
    return best if best_score >= max(8, len(page_map) - 2) else None


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: extract_clay_team_pages.py <pdf> [season]")
    pdf_path = sys.argv[1]
    season = int(sys.argv[2]) if len(sys.argv) > 2 else 2026
    doc = fitz.open(pdf_path)
    sched_by_team = load_schedule(season)

    team_proj = {}
    games = {}  # (week, home, away) -> dict
    identified = 0
    for pg in range(2, 34):  # pages 2..33
        if pg - 1 >= doc.page_count:
            continue
        weekly, summary = parse_page(block_rows(doc[pg - 1]))
        if not weekly:
            continue
        team = identify(weekly, sched_by_team)
        if not team:
            continue
        identified += 1
        team_proj[team] = summary
        for wk, (opp, is_home, tm_pts, opp_pts, wp) in weekly.items():
            if opp == fix_team("0") or tm_pts == 0 and opp_pts == 0:
                continue  # bye
            home, away = (team, opp) if is_home else (opp, team)
            key = (wk, home, away)
            g = games.setdefault(key, {"week": wk, "home": home, "away": away})
            if is_home:
                g["home_pts"], g["away_pts"], g["home_win_prob"] = tm_pts, opp_pts, wp
            else:
                g["away_pts"], g["home_pts"], g["away_win_prob"] = tm_pts, opp_pts, wp

    # Finalize matchups: prefer the home-page win prob; else derive from away page.
    matchups = []
    for g in games.values():
        if "home_win_prob" not in g and "away_win_prob" in g:
            g["home_win_prob"] = 100 - g["away_win_prob"]
        g.pop("away_win_prob", None)
        if {"home_pts", "away_pts", "home_win_prob"} <= g.keys():
            matchups.append(g)
    matchups.sort(key=lambda g: (g["week"], g["home"]))

    meta = lambda extra: {
        "season": season, "label": "Consensus",
        "source": "Mike Clay 2026 NFL Projection Guide (ESPN), team pages",
        "updated": datetime.now(timezone.utc).isoformat(),
        "note": "Surfaced as 'Consensus'. Extracted from a manually-dropped PDF; the PDF is not committed.",
        **extra,
    }
    Path(f"public/data/clay-matchups-{season}.json").write_text(
        json.dumps(meta({"games": matchups}), separators=(",", ":")))
    Path(f"public/data/clay-team-projections-{season}.json").write_text(
        json.dumps(meta({"teams": team_proj}), separators=(",", ":")))
    print(f"Identified {identified}/32 team pages")
    print(f"Wrote clay-matchups-{season}.json: {len(matchups)} games")
    print(f"Wrote clay-team-projections-{season}.json: {len(team_proj)} teams")


if __name__ == "__main__":
    main()
