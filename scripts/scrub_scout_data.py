#!/usr/bin/env python3
"""Strip verbatim scout prose from the public scouting JSONs in place.

Reads the three files under public/data/ that historically carried
copyrighted strengths / weaknesses / summaries / etc., transforms each
record into the derived/aggregated shape produced by ``_scout_scrub``,
and overwrites the file. Idempotent — safe to rerun.

Files touched:
    public/data/pdf-prospect-features.json
    public/data/pdf-prospect-features-merged.json
    public/data/rsp-qb-features.json
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from _scout_scrub import (
    build_guide_id_map,
    parse_guide_year,
    roman_tier_ordinal,
    scrub_merged_row,
    scrub_per_source_row,
    scrub_rsp_profile,
)


def _scrub_cross_year(rec: dict) -> dict:
    """cross_year_rankings is mostly numeric, but its ``tier`` is RSP's
    roman-numeral label — replace with an integer ordinal."""
    out = {k: v for k, v in rec.items() if k != "tier"}
    out["tier_ordinal"] = roman_tier_ordinal(rec.get("tier"))
    return out

ROOT = Path(__file__).resolve().parent.parent
PER_SOURCE = ROOT / "public" / "data" / "pdf-prospect-features.json"
MERGED = ROOT / "public" / "data" / "pdf-prospect-features-merged.json"
RSP_QB = ROOT / "public" / "data" / "rsp-qb-features.json"


def _write(path: Path, data) -> None:
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def scrub_pdf_files() -> dict[str, int]:
    """Returns the guide_id_map so other steps could reuse it."""
    rows = json.loads(PER_SOURCE.read_text(encoding="utf-8"))
    if rows and "guide_id" in rows[0]:
        print(f"  skip {PER_SOURCE.relative_to(ROOT)} (already scrubbed)")
        return {}
    sources = [r.get("source_file", "") for r in rows if r.get("source_file")]
    id_map = build_guide_id_map(sources)

    scrubbed_per_source = []
    for r in rows:
        src = r.get("source_file") or ""
        gid = id_map.get(src, 0)
        scrubbed_per_source.append(scrub_per_source_row(r, gid, parse_guide_year(src)))
    _write(PER_SOURCE, scrubbed_per_source)
    print(f"  wrote {len(scrubbed_per_source)} rows -> {PER_SOURCE.relative_to(ROOT)}")

    merged = json.loads(MERGED.read_text(encoding="utf-8"))
    scrubbed_merged = [scrub_merged_row(r, id_map) for r in merged]
    _write(MERGED, scrubbed_merged)
    print(f"  wrote {len(scrubbed_merged)} rows -> {MERGED.relative_to(ROOT)}")
    return id_map


def scrub_rsp_file() -> None:
    if not RSP_QB.exists():
        print(f"  skip {RSP_QB.relative_to(ROOT)} (missing)")
        return
    d = json.loads(RSP_QB.read_text(encoding="utf-8"))
    sample = (d.get("qbs_unified") or [{}])[0]
    if "n_strengths" in sample:
        print(f"  skip {RSP_QB.relative_to(ROOT)} (already scrubbed)")
        return
    out = {
        "version": d.get("version"),
        "guide_windows": d.get("guide_windows") or {},
        "qbs_by_guide": {},
        "qbs_unified": [scrub_rsp_profile(r) for r in d.get("qbs_unified") or []],
    }
    for year, payload in (d.get("qbs_by_guide") or {}).items():
        out["qbs_by_guide"][year] = {
            "window": payload.get("window"),
            # per_year_rankings carry the same prose fields as RSP profiles
            "per_year_rankings": [
                scrub_rsp_profile(r) for r in payload.get("per_year_rankings") or []
            ],
            "cross_year_rankings": [
                _scrub_cross_year(r) for r in payload.get("cross_year_rankings") or []
            ],
        }
    _write(RSP_QB, out)
    n_unified = len(out["qbs_unified"])
    n_by_guide = sum(len(v["per_year_rankings"]) for v in out["qbs_by_guide"].values())
    print(f"  wrote {n_unified} unified + {n_by_guide} per-guide -> {RSP_QB.relative_to(ROOT)}")


def main() -> int:
    print("Scrubbing scout prose from public/data/...")
    scrub_pdf_files()
    scrub_rsp_file()
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
