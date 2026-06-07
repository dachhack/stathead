#!/usr/bin/env python3
"""Extract Mike Clay's per-team Unit Grades (guide page 63) into
public/data/clay-unit-grades-<season>.json.

Each team has 10 positional unit grades (QB RB WR TE OL DI ED LB CB S, 1-10)
plus Overall / Offense / Defense composite grades and ranks. Surfaced only as
an anonymized "Consensus" source (the PDF is a manual drop, not committed).

    python3 scripts/extract_clay_unit_grades.py <path-to-pdf> [season] [page]

Requires PyMuPDF:  pip install pymupdf
"""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import fitz  # PyMuPDF

# Full team name → our (nflverse) code.
TEAM_NAME_TO_CODE = {
    "Arizona Cardinals": "ARI", "Atlanta Falcons": "ATL", "Baltimore Ravens": "BAL",
    "Buffalo Bills": "BUF", "Carolina Panthers": "CAR", "Chicago Bears": "CHI",
    "Cincinnati Bengals": "CIN", "Cleveland Browns": "CLE", "Dallas Cowboys": "DAL",
    "Denver Broncos": "DEN", "Detroit Lions": "DET", "Green Bay Packers": "GB",
    "Houston Texans": "HOU", "Indianapolis Colts": "IND", "Jacksonville Jaguars": "JAX",
    "Kansas City Chiefs": "KC", "Las Vegas Raiders": "LV", "Los Angeles Chargers": "LAC",
    "Los Angeles Rams": "LA", "Miami Dolphins": "MIA", "Minnesota Vikings": "MIN",
    "New England Patriots": "NE", "New Orleans Saints": "NO", "New York Giants": "NYG",
    "New York Jets": "NYJ", "Philadelphia Eagles": "PHI", "Pittsburgh Steelers": "PIT",
    "San Francisco 49ers": "SF", "Seattle Seahawks": "SEA", "Tampa Bay Buccaneers": "TB",
    "Tennessee Titans": "TEN", "Washington Commanders": "WAS",
}

UNIT_COLS = ["QB", "RB", "WR", "TE", "OL", "DI", "ED", "LB", "CB", "S"]
NUM_RE = re.compile(r"-?\d+(?:\.\d+)?$")


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: extract_clay_unit_grades.py <pdf> [season] [page]")
    pdf_path = sys.argv[1]
    season = int(sys.argv[2]) if len(sys.argv) > 2 else 2026
    page = int(sys.argv[3]) if len(sys.argv) > 3 else 63
    doc = fitz.open(pdf_path)
    lines = [l.strip() for l in doc[page - 1].get_text().split("\n") if l.strip()]

    teams = {}
    i = 0
    while i < len(lines):
        name = lines[i]
        code = TEAM_NAME_TO_CODE.get(name)
        if code:
            nums = lines[i + 1:i + 17]  # 10 units + 3 (grade, rank) pairs
            if len(nums) == 16 and all(NUM_RE.match(x) for x in nums):
                vals = [float(x) if "." in x else int(x) for x in nums]
                units = dict(zip(UNIT_COLS, vals[:10]))
                teams[code] = {
                    "units": units,
                    "overall": vals[10], "overall_rk": int(vals[11]),
                    "offense": vals[12], "offense_rk": int(vals[13]),
                    "defense": vals[14], "defense_rk": int(vals[15]),
                }
                i += 17
                continue
        i += 1

    out = {
        "season": season,
        "label": "Consensus",
        "source": "Mike Clay 2026 NFL Projection Guide (ESPN), Unit Grades",
        "updated": datetime.now(timezone.utc).isoformat(),
        "note": "Surfaced as 'Consensus'. Extracted from a manually-dropped PDF; the PDF is not committed.",
        "teams": teams,
    }
    out_path = Path(f"public/data/clay-unit-grades-{season}.json")
    out_path.write_text(json.dumps(out, separators=(",", ":")))
    print(f"Wrote {out_path}: {len(teams)}/32 teams")
    if len(teams) != 32:
        missing = set(TEAM_NAME_TO_CODE.values()) - set(teams)
        print(f"  WARNING missing teams: {sorted(missing)}")


if __name__ == "__main__":
    main()
