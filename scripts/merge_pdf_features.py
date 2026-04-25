#!/usr/bin/env python3
"""Merge per-PDF feature JSONs into the two public outputs.

Reads every pdfs/.cache/*.features.json (written by the
/extract-pdf-features Claude Code slash command) and produces:

    public/data/pdf-prospect-features.json           one row per (player, source)
    public/data/pdf-prospect-features-merged.json    one row per player, aggregated

Output rows are scrubbed of verbatim scout prose by ``_scout_scrub`` —
public files only carry counts, numeric ranks, and anonymized guide IDs.

Pure Python, no LLM calls. Safe to rerun any time.
"""

from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

from _scout_scrub import (
    build_guide_id_map,
    parse_guide_year,
    scrub_merged_row,
    scrub_per_source_row,
)

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "pdfs" / ".cache"
OUT_PER_SOURCE = ROOT / "public" / "data" / "pdf-prospect-features.json"
OUT_MERGED = ROOT / "public" / "data" / "pdf-prospect-features-merged.json"

NAME_PUNCT = re.compile(r"[^\w\s]")


def normalize_name(name: str) -> str:
    n = NAME_PUNCT.sub(" ", name.lower())
    n = re.sub(r"\b(jr|sr|ii|iii|iv)\b", "", n)
    return re.sub(r"\s+", " ", n).strip()


CONTEXT_HASH_OR_NONE = re.compile(r"\.(?:[0-9a-f]{8}|nocontext)$")


def base_stem(features_filename: str) -> str:
    """Recover the original PDF stem from a features cache filename.

    Examples:
      the_beast_2024.features.json            -> the_beast_2024
      the_beast_2024.a3f1b2c0.features.json   -> the_beast_2024
      the_beast_2024.nocontext.features.json  -> the_beast_2024
    """
    stem = features_filename[: -len(".features.json")]
    return CONTEXT_HASH_OR_NONE.sub("", stem)


def latest_per_pdf() -> list[Path]:
    """For each PDF stem, return the newest features.json file (by mtime).

    A stem may have multiple features files when the extraction context has
    been edited across runs (each context hash produces a distinct file).
    The most recent one wins; older ones are silently ignored.
    """
    by_stem: dict[str, Path] = {}
    for fp in CACHE_DIR.glob("*.features.json"):
        stem = base_stem(fp.name)
        prev = by_stem.get(stem)
        if prev is None or fp.stat().st_mtime > prev.stat().st_mtime:
            by_stem[stem] = fp
    return [by_stem[k] for k in sorted(by_stem)]


def load_per_source() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for fp in latest_per_pdf():
        try:
            data = json.loads(fp.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            print(f"  skip {fp.name}: {e}", file=sys.stderr)
            continue
        if not isinstance(data, list):
            print(f"  skip {fp.name}: expected a JSON array", file=sys.stderr)
            continue
        source_file = base_stem(fp.name) + ".pdf"
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

    # Build the guide-id map up front so per-source and merged outputs agree.
    id_map = build_guide_id_map([r.get("source_file", "") for r in rows])

    scrubbed_per_source = [
        scrub_per_source_row(r, id_map.get(r.get("source_file", ""), 0),
                             parse_guide_year(r.get("source_file")))
        for r in rows
    ]
    OUT_PER_SOURCE.parent.mkdir(parents=True, exist_ok=True)
    OUT_PER_SOURCE.write_text(json.dumps(scrubbed_per_source, indent=2), encoding="utf-8")
    print(f"wrote {len(scrubbed_per_source)} rows -> {OUT_PER_SOURCE.relative_to(ROOT)}")

    # merge_rows() still needs the prose-bearing rows to dedupe before counting.
    merged = [scrub_merged_row(m, id_map) for m in merge_rows(rows)]
    OUT_MERGED.write_text(json.dumps(merged, indent=2), encoding="utf-8")
    print(f"wrote {len(merged)} merged players -> {OUT_MERGED.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
