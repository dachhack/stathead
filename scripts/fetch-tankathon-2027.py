#!/usr/bin/env python3
"""Refresh the Tankathon 2027 NFL mock draft snapshot.

Fetches tankathon.com's mock draft (round 1, plus later rounds where the
site serves them), writes public/data/tankathon-2027.json, and patches the
refreshed pick numbers onto public/data/career-2027.json rows
(`tankathonPick`) so the board's #TANK column matches what the model uses.

Run scripts/score-career-2027.ts afterwards — it prefers this snapshot's
pick as the model's projected draft capital.

Runs from .github/workflows/refresh-tankathon.yml on a GitHub runner:
tankathon.com is egress-blocked in the Claude sandbox (the same reason
Clay's guide has refresh-clay.yml).

    python3 scripts/fetch-tankathon-2027.py [--dry-run]

Fails loudly (nonzero exit) rather than committing a bad snapshot: the
page must parse to >= 28 picks and must look like the 2027 draft.
"""

import json
import re
import sys
import unicodedata
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from bs4 import BeautifulSoup

BASE = "https://www.tankathon.com/nfl/mock_draft"
OUT = Path("public/data/tankathon-2027.json")
CAREER = Path("public/data/career-2027.json")
DRAFT_YEAR = 2027
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


def fetch(url: str) -> str | None:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read().decode("utf-8", errors="replace")
    except Exception as e:
        print(f"  fetch failed for {url}: {e}", file=sys.stderr)
        return None


def parse_mock(html: str) -> list[dict]:
    """Same row structure build-prospect-grades-2027.py parsed from the
    saved page: div.mock-row → pick number, name, "POS | School"."""
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
        parts = sp.get_text("|", strip=True).split("|")
        if len(parts) < 2:
            continue
        out.append({
            "pick": pick_n,
            "name": name.get_text(strip=True),
            "pos": parts[0].strip(),
            "school": parts[1].strip(),
        })
    return out


def norm_name(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[.\-'`]", "", s)
    s = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", s)
    return re.sub(r"\s+", " ", s).strip()


def main() -> int:
    dry = "--dry-run" in sys.argv

    html = fetch(BASE)
    if not html:
        print("::error::could not fetch the Tankathon mock draft page")
        return 1

    # Guard: this page must be the 2027 mock. Tankathon's mock always shows
    # the upcoming draft, so a wrong year means the class rolled over and
    # this script (and career-2027) need their year bumped, not a commit.
    if str(DRAFT_YEAR) not in html:
        print(f"::error::page does not mention {DRAFT_YEAR} — draft year may have rolled over; refusing to write")
        return 1

    picks = parse_mock(html)
    # Later rounds live on /2, /3 … where served; stop at the first miss.
    for rnd in (2, 3):
        more = fetch(f"{BASE}/{rnd}")
        if not more:
            break
        extra = parse_mock(more)
        if not extra:
            break
        picks.extend(extra)

    # Dedupe by pick number (later fetches can repeat round 1).
    seen: dict[int, dict] = {}
    for p in picks:
        seen.setdefault(p["pick"], p)
    picks = [seen[k] for k in sorted(seen)]

    if len(picks) < 28:
        print(f"::error::parsed only {len(picks)} picks — page layout may have changed; refusing to write")
        return 1

    snapshot = {
        "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": BASE,
        "draftYear": DRAFT_YEAR,
        "picks": picks,
    }
    print(f"Parsed {len(picks)} picks (through pick {picks[-1]['pick']})")
    for p in picks[:10]:
        print(f"  #{p['pick']:>3}  {p['name']:24} {p['pos']:4} {p['school']}")

    # Patch tankathonPick onto the career file so the board's #TANK column
    # shows the same numbers the model scores with.
    career = json.loads(CAREER.read_text())
    by_name = {norm_name(p["name"]): p["pick"] for p in picks}
    matched, cleared = 0, 0
    for row in career:
        pick = by_name.get(norm_name(row["name"]))
        if pick:
            row["tankathonPick"] = pick
            matched += 1
        elif row.get("tankathonPick"):
            # In the previous snapshot but not this one — a real fall out of
            # the mock. Clear it so the model falls back to the consensus
            # board instead of scoring stale capital.
            row["tankathonPick"] = None
            cleared += 1
    print(f"career-2027.json: {matched} rows matched, {cleared} stale picks cleared")

    if dry:
        print("Dry run — nothing written.")
        return 0
    OUT.write_text(json.dumps(snapshot, indent=1) + "\n")
    CAREER.write_text(json.dumps(career, indent=1) + "\n")
    print(f"Wrote {OUT} and updated {CAREER}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
