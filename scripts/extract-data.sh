#!/bin/bash
# Extract the committed .csv.gz source files to .csv in place.
# Python scripts (backfill_player_features.py, build_nflverse_weekly_cache.py,
# etc.) read raw .csv directly — run this once after cloning. TS-side code
# uses readLocalFile() which auto-decompresses, so npm run build:features
# does not need this.
#
# Usage:  bash scripts/extract-data.sh
set -e
OUT="public/data"
n=0
for gz in "$OUT"/*.csv.gz; do
  [ -f "$gz" ] || continue
  csv="${gz%.gz}"
  if [ ! -f "$csv" ] || [ "$gz" -nt "$csv" ]; then
    gunzip -k -f "$gz"
    n=$((n + 1))
  fi
done
echo "Extracted $n file(s) in $OUT/"
