#!/usr/bin/env python3
"""Merge per-PDF feature JSONs into the two public outputs.

Reads every pdfs/.cache/*.features.json (written by the
/extract-pdf-features Claude Code slash command) and produces:

    public/data/pdf-prospect-features.json           one row per (player, source)
    public/data/pdf-prospect-features-merged.json    one row per player, aggregated

Pure Python, no LLM calls. Safe to rerun any time.
"""

from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "pdfs" / ".cache"
OUT_PER_SOURCE = ROOT / "public" / "data" / "pdf-prospect-features.json"
OUT_MERGED = ROOT / "public" / "data" / "pdf-prospect-features-merged.json"

NAME_PUNCT = re.compile(r"[^\w\s]")


def normalize_name(name: str) -> str:
    n = NAME_PUNCT.sub(" ", name.lower())
    n = re.sub(r"\b(jr|sr|ii|iii|iv)\b", "", n)
    return re.sub(r"\s+", " ", n).strip()


def load_per_source() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for fp in sorted(CACHE_DIR.glob("*.features.json")):
        try:
            data = json.loads(fp.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            print(f"  skip {fp.name}: {e}", file=sys.stderr)
            continue
        if not isinstance(data, list):
            print(f"  skip {fp.name}: expected a JSON array", file=sys.stderr)
            continue
        source_file = fp.name.replace(".features.json", ".pdf")
        for r in data:
            if not isinstance(r, dict) or not r.get("player_name"):
                continue
            r.setdefault("source_file", source_file)
            rows.append(r)
    return rows


def merge_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        grouped[normalize_name(r["player_name"])].append(r)

    merged: list[dict[str, Any]] = []
    for key, items in grouped.items():
        positions = [i.get("position") for i in items if i.get("position")]
        colleges = [i.get("college") for i in items if i.get("college")]
        ranks = [i["rank_overall"] for i in items if isinstance(i.get("rank_overall"), int)]
        prounds = [i["projected_round"] for i in items if isinstance(i.get("projected_round"), int)]

        def flat(field: str) -> list[str]:
            seen: set[str] = set()
            out: list[str] = []
            for i in items:
                for v in i.get(field) or []:
                    v = str(v).strip()
                    if v and v.lower() not in seen:
                        seen.add(v.lower())
                        out.append(v)
            return out

        merged.append({
            "player_key": key,
            "player_name": items[0]["player_name"],
            "position": max(set(positions), key=positions.count) if positions else None,
            "college": max(set(colleges), key=colleges.count) if colleges else None,
            "sources": sorted({i["source_file"] for i in items}),
            "n_sources": len({i["source_file"] for i in items}),
            "rank_overall_min": min(ranks) if ranks else None,
            "rank_overall_mean": round(sum(ranks) / len(ranks), 1) if ranks else None,
            "rank_overall_max": max(ranks) if ranks else None,
            "projected_round_mean": round(sum(prounds) / len(prounds), 2) if prounds else None,
            "tiers": [i["tier"] for i in items if i.get("tier")],
            "comps": flat("comps"),
            "strengths": flat("strengths"),
            "weaknesses": flat("weaknesses"),
            "red_flags": flat("red_flags"),
            "summaries": [i["summary"] for i in items if i.get("summary")],
        })

    merged.sort(key=lambda r: (r["rank_overall_mean"] is None, r["rank_overall_mean"] or 9999))
    return merged


def main() -> int:
    if not CACHE_DIR.exists():
        print(f"error: {CACHE_DIR} does not exist. Run extract_pdf_features.py + /extract-pdf-features first.", file=sys.stderr)
        return 1

    rows = load_per_source()
    if not rows:
        print("error: no *.features.json files found in pdfs/.cache/", file=sys.stderr)
        return 1

    OUT_PER_SOURCE.parent.mkdir(parents=True, exist_ok=True)
    OUT_PER_SOURCE.write_text(json.dumps(rows, indent=2), encoding="utf-8")
    print(f"wrote {len(rows)} rows -> {OUT_PER_SOURCE.relative_to(ROOT)}")

    merged = merge_rows(rows)
    OUT_MERGED.write_text(json.dumps(merged, indent=2), encoding="utf-8")
    print(f"wrote {len(merged)} merged players -> {OUT_MERGED.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
