#!/usr/bin/env python3
"""
Merge three 2027 NFL Draft prospect sources into src/data/prospect-grades-2027.json
matching the 2026 schema.

Sources (parsed from saved MHT snapshots):
  - NFL Mock Draft Database consensus board (rank, name, pos, school)
  - PFF Big Board ?season=2027 (rank, name, pos, school)
  - Tankathon 2027 Mock Draft (pick, name, pos, school, ht/wt)

Strategy:
  1. Parse each source.
  2. Normalize names + positions to the 2026 vocabulary.
  3. Union by normalized name; average rank across sources (missing = 999).
  4. Sort, assign projPick 1..N, derive projRound/tier/grade from the 2026 curve.
"""

import email
import email.policy
import json
import re
import sys
import unicodedata
from email import message_from_binary_file
from pathlib import Path

from bs4 import BeautifulSoup

UPLOADS = Path("/root/.claude/uploads/dae90015-4ed9-4825-8368-dde0c6c4a7f6")
OUT = Path("/home/user/stathead/src/data/prospect-grades-2027.json")

POS_MAP = {
    "QB": "QB", "RB": "RB", "HB": "RB", "FB": "RB", "WR": "WR", "TE": "TE",
    "EDGE": "EDGE", "ED": "EDGE",
    "OT": "OT", "T": "OT",
    "G": "G", "IOL": "G", "OG": "G", "OL": "G",
    "C": "C",
    "DT": "DT", "DI": "DT", "DL": "DT", "IDL": "DT", "NT": "DT",
    "LB": "LB", "ILB": "LB", "OLB": "LB",
    "CB": "CB",
    "SAF": "SAF", "S": "SAF", "FS": "SAF", "SS": "SAF",
}


def extract_html(mht_path: Path, host_hint: str) -> str:
    """Return the largest text/html part whose Content-Location matches host_hint."""
    with open(mht_path, "rb") as f:
        msg = message_from_binary_file(f, policy=email.policy.default)
    best = ""
    for part in msg.walk():
        if part.get_content_type() != "text/html":
            continue
        loc = part.get("Content-Location", "") or ""
        if host_hint not in loc:
            continue
        body = part.get_payload(decode=True)
        if isinstance(body, bytes):
            body = body.decode("utf-8", errors="replace")
        if len(body) > len(best):
            best = body
    return best


def normalize_name(name: str) -> str:
    n = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    n = n.lower()
    n = re.sub(r"[.'`]", "", n)
    n = re.sub(r"\s+(jr|sr|ii|iii|iv|v)\b", "", n)
    n = re.sub(r"[^a-z0-9 ]", " ", n)
    n = re.sub(r"\s+", " ", n).strip()
    return n


def normalize_pos(pos: str) -> str:
    p = pos.strip().upper()
    return POS_MAP.get(p, p)


def parse_consensus(html: str):
    """Parse the NFL Mock Draft Database consensus board.

    Row layout: optional trending badge, rank cell (font-black), team logo,
    name (anchor), position chip, school anchor, prev-rank chip.
    """
    soup = BeautifulSoup(html, "lxml")
    out = []
    seen = set()
    for a in soup.find_all("a", href=re.compile(r"/players/2027/")):
        href = a.get("href")
        if "/archive/" in href or href in seen:
            continue
        seen.add(href)
        # Walk up to the row container that holds rank + name + pos + school.
        row = a
        for _ in range(6):
            row = row.parent
            if row is None:
                break
            if row.select_one("span.font-black") and row.select_one("a[href*='/colleges/2027/']"):
                break
        if row is None:
            continue
        rank_el = row.select_one("span.font-black")
        try:
            rank = int(rank_el.get_text(strip=True))
        except (ValueError, AttributeError):
            continue
        pos_el = row.select_one("span.bg-blue-50") or row.select_one("span.text-blue-700")
        school_el = row.select_one("a[href*='/colleges/2027/']")
        school = school_el.get_text(strip=True) if school_el else ""
        if not school:
            # Fallback: pipe-split the row text, take element after pos.
            parts = [p.strip() for p in row.get_text("|", strip=True).split("|") if p.strip()]
            name_txt = a.get_text(strip=True)
            if name_txt in parts:
                i = parts.index(name_txt)
                if i + 2 < len(parts):
                    school = parts[i + 2]
        out.append({
            "rank": rank,
            "name": a.get_text(strip=True),
            "pos": pos_el.get_text(strip=True) if pos_el else "",
            "school": school,
        })
    return out


def parse_tankathon(html: str):
    soup = BeautifulSoup(html, "lxml")
    out = []
    for row in soup.select("div.mock-row"):
        pick = row.select_one(".mock-row-pick-number")
        name = row.select_one(".mock-row-name")
        sp = row.select_one(".mock-row-school-position")
        if not (pick and name and sp):
            continue
        try:
            pick_n = int(pick.get_text(strip=True))
        except ValueError:
            continue
        # school-position formatted as "<POS> | <SCHOOL>"
        # but .get_text gives them concatenated; use children
        pos_el = sp.find(class_=re.compile("position")) or sp
        school_el = sp.find(class_=re.compile("school"))
        text = sp.get_text("|", strip=True).split("|")
        if len(text) >= 2:
            pos_txt = text[0]
            school_txt = text[1]
        else:
            continue
        out.append({
            "rank": pick_n,
            "name": name.get_text(strip=True),
            "pos": pos_txt,
            "school": school_txt,
        })
    return out


def parse_pff(html: str):
    soup = BeautifulSoup(html, "lxml")
    out = []
    for row in soup.select(".m-player-row"):
        rank_el = row.select_one(".m-player-row__rank-value")
        name_el = row.select_one(".m-player-row__name")
        pos_el = row.select_one(".m-player-row__position")
        school_el = row.select_one(".m-player-row__college")
        if not (rank_el and name_el):
            continue
        try:
            rank = int(rank_el.get_text(strip=True))
        except ValueError:
            continue
        out.append({
            "rank": rank,
            "name": name_el.get_text(strip=True),
            "pos": pos_el.get_text(strip=True) if pos_el else "",
            "school": school_el.get_text(strip=True) if school_el else "",
        })
    return out


def derive_grade_tier_round(pick: int):
    """Match the 2026 curve."""
    if pick == 1:
        grade, tier, rnd = 97, "Generational", 1
    elif pick <= 8:
        grade, tier, rnd = 96 - (pick - 2) // 2, "Elite", 1
    elif pick <= 15:
        grade, tier, rnd = 93 - (pick - 9) // 2, "Elite", 1
    elif pick <= 32:
        grade, tier, rnd = max(86, 90 - (pick - 16) // 4), "Top Prospect", 1
    elif pick <= 64:
        rnd = 2
        grade = max(78, 85 - (pick - 33) // 4)
        tier = "1st-2nd Round" if pick <= 50 else "2nd-3rd Round"
    elif pick <= 100:
        rnd = 3
        grade = max(69, 77 - (pick - 65) // 5)
        tier = "2nd-3rd Round" if pick <= 80 else "Day 3"
    else:
        rnd = min(7, 4 + (pick - 101) // 35)
        grade = max(50, 69 - (pick - 100) // 10)
        tier = "Day 3"
    return grade, tier, rnd


def main():
    mhts = list(UPLOADS.glob("*.mht"))
    paths = {}
    for p in mhts:
        if "Tankathon" in p.name:
            paths["tankathon"] = p
        elif "Consensus" in p.name:
            paths["consensus"] = p
        elif "Big_Board" in p.name:
            paths["pff"] = p
    print(f"Sources: {list(paths.keys())}", file=sys.stderr)

    cons = parse_consensus(extract_html(paths["consensus"], "nflmockdraftdatabase.com"))
    pff = parse_pff(extract_html(paths["pff"], "pff.com"))
    tank = parse_tankathon(extract_html(paths["tankathon"], "tankathon.com"))
    print(f"  consensus: {len(cons)}  pff: {len(pff)}  tankathon: {len(tank)}", file=sys.stderr)

    # Union by normalized name
    union: dict[str, dict] = {}

    def add(src_name: str, rows: list, max_rank: int):
        for r in rows:
            key = normalize_name(r["name"])
            entry = union.setdefault(key, {
                "name": r["name"],
                "pos": normalize_pos(r["pos"]),
                "school": r["school"],
                "ranks": {},
                "sources": [],
            })
            entry["ranks"][src_name] = r["rank"]
            entry["sources"].append(src_name)
            # Prefer non-empty pos/school from any source if missing
            if not entry["pos"] and r["pos"]:
                entry["pos"] = normalize_pos(r["pos"])
            if not entry["school"] and r["school"]:
                entry["school"] = r["school"]

    add("consensus", cons, 100)
    add("pff", pff, 75)
    add("tankathon", tank, 64)

    # Average rank: missing sources penalized to that source's max + 25
    PEN = {"consensus": 100 + 25, "pff": 75 + 25, "tankathon": 64 + 40}

    scored = []
    for key, e in union.items():
        ranks = []
        for src, pen in PEN.items():
            ranks.append(e["ranks"].get(src, pen))
        e["avg"] = sum(ranks) / len(ranks)
        scored.append(e)

    scored.sort(key=lambda x: (x["avg"], -len(x["sources"])))

    # Emit
    out = []
    for i, e in enumerate(scored, 1):
        grade, tier, rnd = derive_grade_tier_round(i)
        out.append({
            "name": e["name"],
            "pos": e["pos"],
            "school": e["school"],
            "grade": grade,
            "projRound": rnd,
            "projPick": i,
            "tier": tier,
            "sources": sorted(e["sources"]),
            "consensusRank": e["ranks"].get("consensus"),
            "pffRank": e["ranks"].get("pff"),
            "tankathonPick": e["ranks"].get("tankathon"),
        })

    OUT.write_text(json.dumps(out, indent=2) + "\n")
    print(f"Wrote {len(out)} prospects → {OUT}", file=sys.stderr)
    # Show top 20
    for r in out[:20]:
        print(f"  #{r['projPick']:>3}  {r['name']:25} {r['pos']:5} {r['school']:20}  "
              f"grade={r['grade']} tier={r['tier']}  src={','.join(r['sources'])}",
              file=sys.stderr)


if __name__ == "__main__":
    main()
