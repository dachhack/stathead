#!/usr/bin/env python3
"""Refresh public/data/historical_contracts.csv.gz from nflverse's parquet.

Why this exists: nflverse's OverTheCap mirror publishes three copies of the
same table under the `contracts` release. `historical_contracts.csv.gz`
stopped being rebuilt in May 2022 (max year_signed 2022 — no Jaylen Warren
2025 extension, no Rico Dowdle 2026 Steelers deal, no Tyler Warren rookie
contract), while `historical_contracts.parquet` / `.rds` are refreshed daily
(nflverse_timestamp 2026-09-09 at the time of writing). Everything in this
repo reads CSV, so this script converts the fresh parquet into the LEGACY CSV
LAYOUT and commits it:

  * nested `season_history` / `contract_history` columns are dropped;
  * money columns (value, apy, guaranteed, inflated_*) are in $M in the
    parquet and in DOLLARS in the legacy CSV — scaled ×1e6 here so every
    consumer (`c.apy / 1_000_000` in the feature pipeline, the MCP
    get_contracts tool, the Python package) keeps its units;
  * `is_active` is written as TRUE/FALSE like the legacy file.

Output: public/data/historical_contracts.csv.gz (tracked; ~1.3 MB).
Reads it via readLocalFile / the hosted /data/ copy: src/data.ts
fetchContracts. Needs pyarrow (`python3 -m pip install pyarrow`).

Usage: python3 scripts/build-contracts-snapshot.py [--out PATH] [--source URL|FILE]
Exit status is non-zero on any failure so callers can keep the previous
snapshot (the refresh workflow treats it as non-fatal).
"""
from __future__ import annotations

import argparse
import csv
import gzip
import io
import os
import sys
import tempfile
import urllib.request

SOURCE_URL = (
    "https://github.com/nflverse/nflverse-data/releases/download/"
    "contracts/historical_contracts.parquet"
)
DEFAULT_OUT = os.path.join("public", "data", "historical_contracts.csv.gz")

# Legacy nflverse CSV column order (what src/types.ts `Contract` and every
# consumer were written against), followed by the useful flat extras the
# parquet carries. Nested columns are intentionally absent.
LEGACY_COLUMNS = [
    "player", "position", "team", "is_active", "year_signed", "years", "value",
    "apy", "guaranteed", "apy_cap_pct", "inflated_value", "inflated_apy",
    "inflated_guaranteed", "player_page", "otc_id",
]
EXTRA_COLUMNS = [
    "gsis_id", "date_of_birth", "height", "weight", "college", "draft_year",
    "draft_round", "draft_overall", "draft_team",
]
MONEY_COLUMNS = {"value", "apy", "guaranteed", "inflated_value", "inflated_apy", "inflated_guaranteed"}
NESTED_COLUMNS = {"season_history", "contract_history"}

# Sanity floor: the legacy file had ~31.9k rows and the parquet ~52.7k.
MIN_ROWS = 20_000


def load_table(source: str):
    try:
        import pyarrow.parquet as pq  # noqa: WPS433 (optional dependency)
    except ImportError:
        sys.exit("pyarrow is required: python3 -m pip install pyarrow")

    if source.startswith(("http://", "https://")):
        with tempfile.NamedTemporaryFile(suffix=".parquet", delete=False) as tmp:
            with urllib.request.urlopen(source, timeout=120) as resp:
                tmp.write(resp.read())
            path = tmp.name
        try:
            return pq.read_table(path)
        finally:
            os.unlink(path)
    return pq.read_table(source)


def fmt_money(v) -> str:
    """$M → whole dollars, as an integer string when exact (the legacy file)."""
    if v is None:
        return ""
    dollars = float(v) * 1_000_000
    rounded = round(dollars)
    return str(rounded) if abs(dollars - rounded) < 0.5 else f"{dollars:.2f}"


def fmt(v) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else repr(v)
    return str(v)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--source", default=SOURCE_URL, help="parquet URL or local path")
    args = ap.parse_args()

    table = load_table(args.source)
    meta = table.schema.metadata or {}
    stamp = meta.get(b"nflverse_timestamp", b"").decode("utf-8", "replace")

    present = set(table.column_names)
    missing = [c for c in LEGACY_COLUMNS if c not in present]
    if missing:
        sys.exit(f"parquet is missing legacy columns {missing}; refusing to write")
    columns = LEGACY_COLUMNS + [c for c in EXTRA_COLUMNS if c in present]
    keep = [c for c in columns if c not in NESTED_COLUMNS]
    rows = table.select(keep).to_pylist()
    if len(rows) < MIN_ROWS:
        sys.exit(f"only {len(rows)} rows (expected ≥ {MIN_ROWS}); refusing to write")

    max_signed = max((r.get("year_signed") or 0) for r in rows)
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(keep)
    for r in rows:
        w.writerow([fmt_money(r.get(c)) if c in MONEY_COLUMNS else fmt(r.get(c)) for c in keep])

    out_dir = os.path.dirname(args.out)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    tmp_out = args.out + ".tmp"
    with gzip.open(tmp_out, "wt", encoding="utf-8", compresslevel=9) as fh:
        fh.write(buf.getvalue())
    os.replace(tmp_out, args.out)
    print(f"wrote {args.out}: {len(rows)} contracts, max year_signed {max_signed}, "
          f"nflverse_timestamp {stamp or 'unknown'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
