#!/bin/bash
# Download nflverse CSV data at build time so we can serve it from GitHub Pages
# without CORS issues. Files go into public/data/ which Vite copies to dist/.

set -e

NFLVERSE="https://github.com/nflverse/nflverse-data/releases/download"
OUT="public/data"
mkdir -p "$OUT"

# Current + recent seasons
SEASONS="2024 2023 2022 2021 2020 2019 2018 2017 2016 2015"

echo "Downloading nflverse data..."

# Player stats (per season)
for s in $SEASONS; do
  [ -f "$OUT/player_stats_${s}.csv" ] || curl -sL "$NFLVERSE/player_stats/player_stats_${s}.csv" -o "$OUT/player_stats_${s}.csv" &
done

# Static/cross-season files
[ -f "$OUT/games.csv" ] || curl -sL "$NFLVERSE/schedules/games.csv" -o "$OUT/games.csv" &
[ -f "$OUT/combine.csv" ] || curl -sL "$NFLVERSE/combine/combine.csv" -o "$OUT/combine.csv" &
[ -f "$OUT/draft_picks.csv" ] || curl -sL "$NFLVERSE/draft_picks/draft_picks.csv" -o "$OUT/draft_picks.csv" &
[ -f "$OUT/historical_contracts.csv" ] || curl -sL "$NFLVERSE/contracts/historical_contracts.csv" -o "$OUT/historical_contracts.csv" &
[ -f "$OUT/trades.csv" ] || curl -sL "$NFLVERSE/trades/trades.csv" -o "$OUT/trades.csv" &
[ -f "$OUT/qbr_season_level.csv" ] || curl -sL "$NFLVERSE/espn_data/qbr_season_level.csv" -o "$OUT/qbr_season_level.csv" &
[ -f "$OUT/qbr_week_level.csv" ] || curl -sL "$NFLVERSE/espn_data/qbr_week_level.csv" -o "$OUT/qbr_week_level.csv" &

# Per-season files
for s in $SEASONS; do
  [ -f "$OUT/snap_counts_${s}.csv" ] || curl -sL "$NFLVERSE/snap_counts/snap_counts_${s}.csv" -o "$OUT/snap_counts_${s}.csv" &
  [ -f "$OUT/injuries_${s}.csv" ] || curl -sL "$NFLVERSE/injuries/injuries_${s}.csv" -o "$OUT/injuries_${s}.csv" &
  [ -f "$OUT/roster_${s}.csv" ] || curl -sL "$NFLVERSE/rosters/roster_${s}.csv" -o "$OUT/roster_${s}.csv" &
  [ -f "$OUT/depth_charts_${s}.csv" ] || curl -sL "$NFLVERSE/depth_charts/depth_charts_${s}.csv" -o "$OUT/depth_charts_${s}.csv" &
done

# Advanced stats (per type per season) - only recent seasons
for s in 2024 2023 2022 2021; do
  for type in pass rush rec def; do
    [ -f "$OUT/advstats_week_${type}_${s}.csv" ] || curl -sL "$NFLVERSE/pfr_advstats/advstats_week_${type}_${s}.csv" -o "$OUT/advstats_week_${type}_${s}.csv" &
  done
done

# Next Gen Stats (per type per season) - only recent seasons
for s in 2024 2023 2022 2021; do
  for type in passing rushing receiving; do
    [ -f "$OUT/ngs_${s}_${type}.csv" ] || curl -sL "$NFLVERSE/nextgen_stats/ngs_${s}_${type}.csv" -o "$OUT/ngs_${s}_${type}.csv" &
  done
done

# FTN Charting - only recent seasons
for s in 2024 2023 2022; do
  [ -f "$OUT/ftn_charting_${s}.csv" ] || curl -sL "$NFLVERSE/ftn_charting/ftn_charting_${s}.csv" -o "$OUT/ftn_charting_${s}.csv" &
done

# Play-by-play (large but needed)
for s in 2024 2023 2022 2021; do
  [ -f "$OUT/play_by_play_${s}.csv" ] || curl -sL "$NFLVERSE/pbp/play_by_play_${s}.csv" -o "$OUT/play_by_play_${s}.csv" &
done

# PBP participation
for s in 2024 2023 2022 2021; do
  [ -f "$OUT/pbp_participation_${s}.csv" ] || curl -sL "$NFLVERSE/pbp_participation/pbp_participation_${s}.csv" -o "$OUT/pbp_participation_${s}.csv" &
done

# DynastyProcess fantasy rankings
DYNASTYPROCESS="https://github.com/dynastyprocess/data/raw/master/files"
[ -f "$OUT/db_fpecr_latest.csv" ] || curl -sL "$DYNASTYPROCESS/db_fpecr_latest.csv" -o "$OUT/db_fpecr_latest.csv" &

wait
echo "Done! Data files in $OUT/"
ls -lh "$OUT/" | head -20
