#!/usr/bin/env python3
"""Extract per-player offensive projections from Mike Clay's 2026 NFL Projection
Guide PDF into public/data/clay-projections-2026.json.

The PDF is a manual drop (not committed — it's ESPN's, and we surface the numbers
only as an anonymized "Consensus" source, never as our own). Re-run whenever a
fresh guide is published:

    python3 scripts/extract_clay_projections.py <path-to-pdf> [season]

Parses the clean positional leaderboard pages (QB / RB / WR / TE / K) and joins
each player to our canonical player_key via the crosswalk (normalized name +
position). Provenance is kept in the file for our records; the UI labels it
"Consensus".

Requires PyMuPDF:  pip install pymupdf
"""
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import fitz  # PyMuPDF

# Clay's team codes → ours (nflverse). Unlisted codes pass through unchanged.
CLAY_TEAM_TO_OURS = {
    "BLT": "BAL", "HST": "HOU", "ARZ": "ARI", "CLV": "CLE", "LAR": "LA",
}
NFL_TEAMS = set(
    "ARI ATL BAL BUF CAR CHI CIN CLE DAL DEN DET GB HOU IND JAX KC LV LAC LA "
    "MIA MIN NE NO NYG NYJ PHI PIT SF SEA TB TEN WAS".split()
)
CLAY_TEAM_CODES = set(CLAY_TEAM_TO_OURS) | NFL_TEAMS

# Page ranges (1-indexed) and the numeric columns that follow "name, team".
# RB/WR/TE share one schema; QB and K differ.
OFF_COLS = ["pos_rk", "ff_pt", "games", "rush_att", "rush_yds", "rush_td",
            "targets", "rec", "rec_yds", "rec_td", "carry_pct", "target_pct"]
QB_COLS = ["pos_rk", "ff_pt", "games", "pass_att", "pass_comp", "pass_yds",
           "pass_td", "pass_int", "sacks", "rush_att", "rush_yds", "rush_td"]
K_COLS = ["ff_pt", "fgm", "fga", "fg_pct", "xpm", "xpa", "xp_pct"]

POSITION_PAGES = [
    ("QB", range(35, 36), QB_COLS),
    ("RB", range(36, 39), OFF_COLS),
    ("WR", range(39, 44), OFF_COLS),
    ("TE", range(44, 46), OFF_COLS),
    ("K", range(57, 58), K_COLS),
]

NUM_RE = re.compile(r"-?\d+(?:\.\d+)?%?$")


def to_num(tok):
    t = tok.rstrip("%")
    try:
        return int(t) if re.fullmatch(r"-?\d+", t) else float(t)
    except ValueError:
        return 0


def lines_of(page):
    return [l.strip() for l in page.get_text().split("\n") if l.strip()]


def parse_page(lines, ncols):
    """Walk lines; anchor on a team code, name is the line before it, the next
    ncols numeric lines are the stats. Returns list of (name, team, [nums])."""
    rows = []
    i = 0
    while i < len(lines):
        tok = lines[i]
        prev_is_code = i > 0 and lines[i - 1] in CLAY_TEAM_CODES
        if tok in CLAY_TEAM_CODES and i > 0 and not prev_is_code:
            nums = lines[i + 1:i + 1 + ncols]
            if len(nums) == ncols and all(NUM_RE.match(x) for x in nums):
                rows.append((lines[i - 1], tok, nums))
                i += 1 + ncols
                continue
        i += 1
    return rows


def normalize_name(name):
    n = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    n = n.lower()
    n = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", n)
    n = re.sub(r"[^a-z0-9 ]", "", n)
    return re.sub(r"\s+", " ", n).strip()


def load_crosswalk_index():
    path = Path("public/data/player-crosswalk.json")
    doc = json.loads(path.read_text())
    players = doc.get("players", doc if isinstance(doc, list) else [])
    by_name_pos = {}
    by_name = {}
    for rec in players:
        names = set(rec.get("all_names") or [])
        names.add(rec.get("display_name", ""))
        positions = set(rec.get("all_positions") or [])
        positions.add(rec.get("position", ""))
        for nm in names:
            n = normalize_name(nm)
            if not n:
                continue
            by_name.setdefault(n, set()).add(rec["player_key"])
            for p in positions:
                by_name_pos.setdefault((n, p), rec["player_key"])
    return by_name_pos, by_name


def resolve_key(name, pos, by_name_pos, by_name):
    n = normalize_name(name)
    # FantasyCalc/Clay positions map straight to ours for offense.
    if (n, pos) in by_name_pos:
        return by_name_pos[(n, pos)]
    keys = by_name.get(n)
    if keys and len(keys) == 1:
        return next(iter(keys))
    return None


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: extract_clay_projections.py <pdf> [season]")
    pdf_path = sys.argv[1]
    season = int(sys.argv[2]) if len(sys.argv) > 2 else 2026
    doc = fitz.open(pdf_path)
    by_name_pos, by_name = load_crosswalk_index()

    players = []
    seen = set()  # (name, team, pos) de-dupe across page splits
    matched = 0
    for pos, pages, cols in POSITION_PAGES:
        for pg in pages:
            if pg - 1 >= doc.page_count:
                continue
            for name, clay_team, nums in parse_page(lines_of(doc[pg - 1]), len(cols)):
                team = CLAY_TEAM_TO_OURS.get(clay_team, clay_team)
                key = (normalize_name(name), team, pos)
                if key in seen:
                    continue
                seen.add(key)
                stats = {c: to_num(v) for c, v in zip(cols, nums)}
                pkey = resolve_key(name, pos, by_name_pos, by_name)
                if pkey:
                    matched += 1
                players.append({
                    "name": name,
                    "team": team,
                    "position": pos,
                    "player_key": pkey,
                    **stats,
                })

    out = {
        "season": season,
        "label": "Consensus",
        "source": "Mike Clay 2026 NFL Projection Guide (ESPN)",
        "updated": datetime.now(timezone.utc).isoformat(),
        "note": "Surfaced as 'Consensus'. Numbers extracted from a manually-dropped PDF; the PDF is not committed.",
        "players": players,
    }
    out_path = Path(f"public/data/clay-projections-{season}.json")
    out_path.write_text(json.dumps(out, separators=(",", ":")))
    by_pos = {}
    for p in players:
        by_pos[p["position"]] = by_pos.get(p["position"], 0) + 1
    print(f"Wrote {out_path}: {len(players)} players {by_pos}")
    print(f"player_key matched: {matched}/{len(players)} "
          f"({100*matched//max(len(players),1)}%)")


if __name__ == "__main__":
    main()
