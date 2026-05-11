#!/usr/bin/env python3
"""
Build public/data/career-2027.json — joins 2027 prospect grades with the
through-2025 college statline + recruiting + per-season usage already cached
in public/data/cfbd-*.json.

This is the v0 "scored prospects" file: no GBM inference yet (the trained
career model expects a senior-season production line we don't have for 2027
prospects), but the consensus grade plus their college stats is enough to
power a useful pre-pre-draft tab.
"""

import json
import re
import unicodedata
from collections import defaultdict
from pathlib import Path

ROOT = Path("/home/user/stathead")
GRADES = ROOT / "src/data/prospect-grades-2027.json"
CFBD_STATS = ROOT / "public/data/cfbd-college-stats.json"
CFBD_RECRUIT = ROOT / "public/data/cfbd-recruiting.json"
CFBD_USAGE = ROOT / "public/data/cfbd-player-usage.json"
OUT = ROOT / "public/data/career-2027.json"

FANTASY_POS = {"QB", "RB", "WR", "TE"}


def cfbd_key(name: str) -> str:
    """Mirror the cfbdKey used in src/lib/featureTypes.ts: lowercase, strip non-alphanumeric."""
    n = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", n.lower())


def name_variants(name: str):
    """Cheap variant set: original, no-suffix, no-middle-initial."""
    base = name.strip()
    variants = {base}
    # strip suffix (Jr., Sr., II, III, IV)
    bare = re.sub(r"\s+(jr|sr|ii|iii|iv|v)\.?$", "", base, flags=re.I)
    if bare != base:
        variants.add(bare)
    # collapse middle initial: "A.J. Smith" -> "Smith"? skip; instead try first+last
    parts = bare.split()
    if len(parts) >= 3:
        # drop middle pieces, try first+last
        variants.add(f"{parts[0]} {parts[-1]}")
    # punctuation-free
    no_punct = re.sub(r"[.'`]", "", base)
    variants.add(no_punct)
    return [v for v in variants if v]


def main():
    grades = json.loads(GRADES.read_text())
    print(f"Loaded {len(grades)} prospect grades")

    fantasy_prospects = [g for g in grades if g["pos"] in FANTASY_POS]
    print(f"  fantasy-position prospects: {len(fantasy_prospects)}")

    print("Loading CFBD college stats...")
    cfbd_rows = json.loads(CFBD_STATS.read_text())
    # Index by normalized name → list[(season, stat, value, school, pos)]
    stats_by_name = defaultdict(list)
    for r in cfbd_rows:
        k = cfbd_key(r["player_name"])
        stats_by_name[k].append(r)
    print(f"  indexed {len(stats_by_name)} unique players")

    print("Loading recruiting...")
    recruit = json.loads(CFBD_RECRUIT.read_text())

    print("Loading usage...")
    usage = json.loads(CFBD_USAGE.read_text())

    rows = []
    matched_stats = 0
    matched_recruit = 0
    for p in fantasy_prospects:
        name = p["name"]
        variants = name_variants(name)
        keys = [cfbd_key(v) for v in variants]

        # Match stats
        rows_for_player = []
        matched_key = None
        for k in keys:
            if k in stats_by_name:
                rows_for_player = stats_by_name[k]
                matched_key = k
                break

        # Aggregate career through 2025 only (their senior 2026 hasn't happened)
        totals = defaultdict(float)
        seasons = set()
        best_season = defaultdict(lambda: defaultdict(float))  # season → stat → value
        school_seen = None
        for r in rows_for_player:
            if int(r["season"]) > 2025:
                continue
            stat = r["statistic"]
            val = float(r["value"])
            totals[stat] += val
            seasons.add(int(r["season"]))
            best_season[int(r["season"])][stat] += val
            school_seen = r.get("school")

        # Best-single-season values for headline stats
        def best(stat):
            return max((best_season[s].get(stat, 0) for s in best_season), default=0)

        if rows_for_player:
            matched_stats += 1

        # Match recruit
        recruit_info = None
        for k in keys:
            if k in recruit:
                recruit_info = recruit[k]
                break
        if recruit_info:
            matched_recruit += 1

        # Most recent usage (2024 + 2025 if available, latest preferred)
        usage_2025 = None
        usage_2024 = None
        for k in keys:
            if not usage_2025 and f"{k}:2025" in usage:
                usage_2025 = usage[f"{k}:2025"]
            if not usage_2024 and f"{k}:2024" in usage:
                usage_2024 = usage[f"{k}:2024"]
            if usage_2025 and usage_2024:
                break

        row = {
            "name": name,
            "pos": p["pos"],
            "school": p["school"],
            "grade": p["grade"],
            "projPick": p["projPick"],
            "projRound": p["projRound"],
            "tier": p["tier"],
            "sources": p.get("sources", []),
            "consensusRank": p.get("consensusRank"),
            "pffRank": p.get("pffRank"),
            "tankathonPick": p.get("tankathonPick"),
            # Career totals through 2025
            "careerSeasons": len(seasons),
            "careerSeasonList": sorted(seasons),
            "careerPassYds": round(totals.get("Passing Yards", 0)),
            "careerPassTDs": round(totals.get("Passing Touchdowns", 0)),
            "careerPassInt": round(totals.get("Interceptions", 0)),
            "careerPassCmp": round(totals.get("Completions", 0)),
            "careerPassAtt": round(totals.get("Passing Attempts", 0)),
            "careerRushYds": round(totals.get("Rushing Yards", 0)),
            "careerRushTDs": round(totals.get("Rushing Touchdowns", 0)),
            "careerRecYds": round(totals.get("Receiving Yards", 0)),
            "careerRecTDs": round(totals.get("Receiving Touchdowns", 0)),
            "careerReceptions": round(totals.get("Receptions", 0)),
            # Best single season
            "bestPassYds": round(best("Passing Yards")),
            "bestRushYds": round(best("Rushing Yards")),
            "bestRecYds": round(best("Receiving Yards")),
            # Recruit
            "recruitStars": recruit_info.get("stars") if recruit_info else None,
            "recruitRating": recruit_info.get("composite_rating") if recruit_info else None,
            "recruitClassYear": recruit_info.get("class_year") if recruit_info else None,
            "recruitPosition": recruit_info.get("position") if recruit_info else None,
            # Usage (overall snap-weighted, most recent)
            "usage2025": usage_2025.get("overall") if usage_2025 else None,
            "usage2024": usage_2024.get("overall") if usage_2024 else None,
            # Provenance
            "cfbdKey": matched_key,
            "cfbdSchool": school_seen,
        }
        rows.append(row)

    # Sort by projPick (ascending) — top board order
    rows.sort(key=lambda r: r["projPick"])

    print(f"\nMatch rates:")
    print(f"  CFBD stats:    {matched_stats}/{len(fantasy_prospects)}")
    print(f"  CFBD recruit:  {matched_recruit}/{len(fantasy_prospects)}")

    OUT.write_text(json.dumps(rows, indent=2) + "\n")
    print(f"\nWrote {len(rows)} rows → {OUT}")

    # Sample top 10
    print(f"\nTop 10:")
    for r in rows[:10]:
        production = ""
        if r["pos"] == "QB":
            production = f"pass {r['careerPassYds']}/{r['careerPassTDs']}TD"
        elif r["pos"] in ("WR", "TE"):
            production = f"{r['careerReceptions']} rec / {r['careerRecYds']} yds / {r['careerRecTDs']} TD"
        elif r["pos"] == "RB":
            production = f"{r['careerRushYds']} rush yds / {r['careerRushTDs']} TD"
        stars = f"{r['recruitStars']}★" if r["recruitStars"] else "—"
        print(f"  #{r['projPick']:>3} {r['name']:25} {r['pos']:3} {r['school']:18} "
              f"grade={r['grade']} seasons={r['careerSeasons']} {stars}  {production}")


if __name__ == "__main__":
    main()
