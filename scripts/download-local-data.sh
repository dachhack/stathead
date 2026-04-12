#!/bin/bash
# Download minimal data needed for local model testing.
# Much smaller than the full CI download — skips PBP (huge),
# participation, FTN charting, and old seasons.
#
# Usage: bash scripts/download-local-data.sh

set -e

NFLVERSE="https://github.com/nflverse/nflverse-data/releases/download"
OUT="public/data"
mkdir -p "$OUT"

echo "Downloading minimal data for local model testing..."
echo "(Skipping PBP/participation — too large for local dev)"

# Player stats (only recent seasons needed for testing)
for s in 2024 2023 2022 2021 2020 2019 2018; do
  if [ ! -f "$OUT/player_stats_${s}.csv" ]; then
    echo "  player_stats_${s}.csv..."
    if [ "$s" -ge 2025 ]; then
      curl -sfL "$NFLVERSE/stats_player/stats_player_week_${s}.csv" -o "$OUT/player_stats_${s}.csv" &
    else
      curl -sfL "$NFLVERSE/player_stats/player_stats_${s}.csv" -o "$OUT/player_stats_${s}.csv" &
    fi
  fi
done

# Static cross-season files
[ -f "$OUT/games.csv" ] || (echo "  games.csv..." && curl -sL "$NFLVERSE/schedules/games.csv" -o "$OUT/games.csv") &
[ -f "$OUT/combine.csv" ] || (echo "  combine.csv..." && curl -sL "$NFLVERSE/combine/combine.csv" -o "$OUT/combine.csv") &
[ -f "$OUT/draft_picks.csv" ] || (echo "  draft_picks.csv..." && curl -sL "$NFLVERSE/draft_picks/draft_picks.csv" -o "$OUT/draft_picks.csv") &
[ -f "$OUT/historical_contracts.csv" ] || (echo "  contracts.csv..." && curl -sL "$NFLVERSE/contracts/historical_contracts.csv" -o "$OUT/historical_contracts.csv") &

# Per-season files
for s in 2024 2023 2022 2021 2020 2019 2018; do
  [ -f "$OUT/roster_${s}.csv" ] || curl -sfL "$NFLVERSE/rosters/roster_${s}.csv" -o "$OUT/roster_${s}.csv" &
  [ -f "$OUT/snap_counts_${s}.csv" ] || curl -sfL "$NFLVERSE/snap_counts/snap_counts_${s}.csv" -o "$OUT/snap_counts_${s}.csv" &
  [ -f "$OUT/injuries_${s}.csv" ] || curl -sfL "$NFLVERSE/injuries/injuries_${s}.csv" -o "$OUT/injuries_${s}.csv" &
  [ -f "$OUT/depth_charts_${s}.csv" ] || curl -sfL "$NFLVERSE/depth_charts/depth_charts_${s}.csv" -o "$OUT/depth_charts_${s}.csv" &
done

# 2025 + 2026 current season data
for s in 2025 2026; do
  [ -f "$OUT/player_stats_${s}.csv" ] || curl -sfL "$NFLVERSE/stats_player/stats_player_week_${s}.csv" -o "$OUT/player_stats_${s}.csv" &
  [ -f "$OUT/roster_${s}.csv" ] || curl -sfL "$NFLVERSE/rosters/roster_${s}.csv" -o "$OUT/roster_${s}.csv" &
  [ -f "$OUT/depth_charts_${s}.csv" ] || curl -sfL "$NFLVERSE/depth_charts/depth_charts_${s}.csv" -o "$OUT/depth_charts_${s}.csv" &
  [ -f "$OUT/injuries_${s}.csv" ] || curl -sfL "$NFLVERSE/injuries/injuries_${s}.csv" -o "$OUT/injuries_${s}.csv" &
  [ -f "$OUT/snap_counts_${s}.csv" ] || curl -sfL "$NFLVERSE/snap_counts/snap_counts_${s}.csv" -o "$OUT/snap_counts_${s}.csv" &
done

# FFC ADP
DRAFTDATA="https://raw.githubusercontent.com/JackLich10/nfl-draft-data/main"
for s in 2024 2023 2022 2021 2020 2019 2018; do
  [ -f "$OUT/ffc_adp_ppr_${s}.json" ] || curl -sL "https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=12&year=${s}" -o "$OUT/ffc_adp_ppr_${s}.json" &
done

# College data
[ -f "$OUT/college_statistics.csv" ] || curl -sfL "$DRAFTDATA/college_statistics.csv" -o "$OUT/college_statistics.csv" &
[ -f "$OUT/college_qbr.csv" ] || curl -sfL "$DRAFTDATA/college_qbr.csv" -o "$OUT/college_qbr.csv" &

wait
echo ""
echo "Done! $(find $OUT -name '*.csv' -o -name '*.json' | wc -l) files in $OUT/"
echo ""
echo "To test models locally, run:"
echo "  NODE_OPTIONS='--max-old-space-size=4096' npx tsx scripts/evaluate-features.ts"
echo "  NODE_OPTIONS='--max-old-space-size=4096' npx tsx scripts/test-team-projections.ts"
echo ""
echo "Note: PBP/participation/NGS data skipped (too large)."
echo "Features derived from PBP (scheme, routes, personnel) will be 0."
echo "This is fine for testing model structure — CI has the full data."
