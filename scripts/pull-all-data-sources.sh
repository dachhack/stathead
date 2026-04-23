#!/bin/bash
# Pull all nflverse + upstream sources into public/data so the pipeline
# never needs to re-scrape. Commit the results to git for permanent,
# reproducible builds.
#
# Covers every season the pipeline spans (2010-2026). Skips play-by-play
# and participation (~50MB/season × 16 = too large without Git LFS). The
# training-rows-cache and model caches already have PBP-derived features
# baked in, so cold rebuilds from the CSVs will zero-fill the PBP stuff
# only — documented in the refresh section below.
#
# Usage:
#   bash scripts/pull-all-data-sources.sh        # only fetch missing
#   bash scripts/pull-all-data-sources.sh --force # refresh all (for weekly updates)

set -e

FORCE=0
if [ "$1" = "--force" ]; then
  FORCE=1
  echo "Force mode: re-downloading all files."
fi

NFLVERSE="https://github.com/nflverse/nflverse-data/releases/download"
DRAFTDATA="https://raw.githubusercontent.com/JackLich10/nfl-draft-data/main"
OUT="public/data"
mkdir -p "$OUT"

fetch() {
  # fetch <url> <dest>
  local url="$1" dest="$2"
  if [ $FORCE -eq 0 ] && [ -f "$dest" ] && [ -s "$dest" ]; then
    return 0
  fi
  if curl -sfL "$url" -o "$dest.tmp"; then
    mv "$dest.tmp" "$dest"
  else
    rm -f "$dest.tmp"
    echo "  MISS: $url"
  fi
}

echo "Pulling static cross-season files..."
fetch "$NFLVERSE/schedules/games.csv"                "$OUT/games.csv" &
fetch "$NFLVERSE/combine/combine.csv"                "$OUT/combine.csv" &
fetch "$NFLVERSE/draft_picks/draft_picks.csv"        "$OUT/draft_picks.csv" &
fetch "$NFLVERSE/contracts/historical_contracts.csv" "$OUT/historical_contracts.csv" &
fetch "$DRAFTDATA/college_statistics.csv"            "$OUT/college_statistics.csv" &
fetch "$DRAFTDATA/college_qbr.csv"                   "$OUT/college_qbr.csv" &
wait

echo "Pulling per-season files (2010-2026)..."
for s in 2010 2011 2012 2013 2014 2015 2016 2017 2018 2019 2020 2021 2022 2023 2024 2025 2026; do
  # Player stats — older seasons use player_stats/ release, 2025+ uses stats_player/
  if [ "$s" -ge 2025 ]; then
    fetch "$NFLVERSE/stats_player/stats_player_week_${s}.csv" "$OUT/player_stats_${s}.csv" &
  else
    fetch "$NFLVERSE/player_stats/player_stats_${s}.csv" "$OUT/player_stats_${s}.csv" &
  fi
  fetch "$NFLVERSE/rosters/roster_${s}.csv"            "$OUT/roster_${s}.csv" &
  fetch "$NFLVERSE/snap_counts/snap_counts_${s}.csv"   "$OUT/snap_counts_${s}.csv" &
  fetch "$NFLVERSE/injuries/injuries_${s}.csv"         "$OUT/injuries_${s}.csv" &
  fetch "$NFLVERSE/depth_charts/depth_charts_${s}.csv" "$OUT/depth_charts_${s}.csv" &
done
wait

echo "Pulling NGS (cross-season)..."
for stat in receiving rushing passing; do
  fetch "$NFLVERSE/nextgen_stats/ngs_${stat}.csv" "$OUT/ngs_${stat}.csv" &
done
wait

echo "Pulling ADP sources..."
for s in 2018 2019 2020 2021 2022 2023 2024 2025 2026; do
  # FFC doesn't use the nflverse release scheme — hit their public API.
  dest="$OUT/ffc_adp_ppr_${s}.json"
  if [ $FORCE -eq 1 ] || [ ! -s "$dest" ]; then
    curl -sL "https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=12&year=${s}" -o "$dest" || echo "  MISS: FFC $s"
  fi
done

echo ""
echo "Compressing .csv files to .csv.gz for git (5x smaller)..."
for csv in "$OUT"/*.csv; do
  [ -f "$csv" ] || continue
  # Skip if .gz is already newer (incremental-friendly for in-season refreshes).
  if [ -f "$csv.gz" ] && [ "$csv.gz" -nt "$csv" ]; then
    continue
  fi
  gzip -9 -f "$csv"
done

n=$(find "$OUT" -maxdepth 1 \( -name '*.csv' -o -name '*.csv.gz' -o -name '*.json' \) | wc -l)
size=$(du -sh "$OUT" 2>/dev/null | awk '{print $1}')
echo "Done. $n files, $size total in $OUT/"
echo ""
echo "Skipped (too large for git without LFS):"
echo "  - play-by-play (pbp/*.csv, ~50 MB/season)"
echo "  - participation charting"
echo ""
echo "Refresh weekly during the season:"
echo "  bash scripts/pull-all-data-sources.sh --force"
echo "  # then commit the updated CSVs"
