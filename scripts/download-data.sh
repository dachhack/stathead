#!/bin/bash
# Download nflverse CSV data at build time.
# With actions/cache, static files persist between builds.
# Only dynamic (current season) files are force-refreshed.

set -e

NFLVERSE="https://github.com/nflverse/nflverse-data/releases/download"
OUT="public/data"
mkdir -p "$OUT"

# ── Configuration ──
# Completed seasons: data never changes, cached indefinitely
STATIC_SEASONS="2025 2024 2023 2022 2021 2020 2019 2018 2017 2016 2015 2014 2013 2012 2011 2010"
# Current/upcoming season: data changes regularly, always re-download
DYNAMIC_SEASON="2026"

echo "Downloading nflverse data (cached static + fresh dynamic)..."

# ── Static season files (skip if cached and non-empty) ──
for s in $STATIC_SEASONS; do
  # Player stats (check file exists AND is non-empty)
  if [ ! -s "$OUT/player_stats_${s}.csv" ]; then
    rm -f "$OUT/player_stats_${s}.csv"  # remove empty/corrupt file
    if [ "$s" -ge 2025 ]; then
      curl -sfL "$NFLVERSE/stats_player/stats_player_week_${s}.csv" -o "$OUT/player_stats_${s}.csv" &
    else
      curl -sfL "$NFLVERSE/player_stats/player_stats_${s}.csv" -o "$OUT/player_stats_${s}.csv" &
    fi
  fi
  [ -s "$OUT/snap_counts_${s}.csv" ] || curl -sfL "$NFLVERSE/snap_counts/snap_counts_${s}.csv" -o "$OUT/snap_counts_${s}.csv" &
  [ -s "$OUT/injuries_${s}.csv" ] || curl -sfL "$NFLVERSE/injuries/injuries_${s}.csv" -o "$OUT/injuries_${s}.csv" &
  [ -s "$OUT/roster_${s}.csv" ] || curl -sfL "$NFLVERSE/rosters/roster_${s}.csv" -o "$OUT/roster_${s}.csv" &
  [ -s "$OUT/depth_charts_${s}.csv" ] || curl -sfL "$NFLVERSE/depth_charts/depth_charts_${s}.csv" -o "$OUT/depth_charts_${s}.csv" &
done

# ── Dynamic season files (always re-download) ──
# Download to temp files first so failed downloads don't overwrite good cached data
for s in $DYNAMIC_SEASON; do
  (curl -sfL "$NFLVERSE/stats_player/stats_player_week_${s}.csv" -o "$OUT/player_stats_${s}.csv.tmp" \
    && [ -s "$OUT/player_stats_${s}.csv.tmp" ] \
    && mv "$OUT/player_stats_${s}.csv.tmp" "$OUT/player_stats_${s}.csv" \
    || echo "  WARNING: Failed to download player_stats_${s}.csv (keeping cached version)") &
  (curl -sfL "$NFLVERSE/snap_counts/snap_counts_${s}.csv" -o "$OUT/snap_counts_${s}.csv.tmp" \
    && [ -s "$OUT/snap_counts_${s}.csv.tmp" ] \
    && mv "$OUT/snap_counts_${s}.csv.tmp" "$OUT/snap_counts_${s}.csv" \
    || echo "  WARNING: Failed to download snap_counts_${s}.csv (keeping cached version)") &
  (curl -sfL "$NFLVERSE/injuries/injuries_${s}.csv" -o "$OUT/injuries_${s}.csv.tmp" \
    && [ -s "$OUT/injuries_${s}.csv.tmp" ] \
    && mv "$OUT/injuries_${s}.csv.tmp" "$OUT/injuries_${s}.csv" \
    || echo "  WARNING: Failed to download injuries_${s}.csv (keeping cached version)") &
  (curl -sfL "$NFLVERSE/rosters/roster_${s}.csv" -o "$OUT/roster_${s}.csv.tmp" \
    && [ -s "$OUT/roster_${s}.csv.tmp" ] \
    && mv "$OUT/roster_${s}.csv.tmp" "$OUT/roster_${s}.csv" \
    || echo "  WARNING: Failed to download roster_${s}.csv (keeping cached version)") &
  (curl -sfL "$NFLVERSE/depth_charts/depth_charts_${s}.csv" -o "$OUT/depth_charts_${s}.csv.tmp" \
    && [ -s "$OUT/depth_charts_${s}.csv.tmp" ] \
    && mv "$OUT/depth_charts_${s}.csv.tmp" "$OUT/depth_charts_${s}.csv" \
    || echo "  WARNING: Failed to download depth_charts_${s}.csv (keeping cached version)") &
done

# ── Cross-season static files (skip if cached) ──
[ -f "$OUT/games.csv" ] || curl -sL "$NFLVERSE/schedules/games.csv" -o "$OUT/games.csv" &
# games.csv has 2026 schedule — force refresh
curl -sL "$NFLVERSE/schedules/games.csv" -o "$OUT/games.csv" &
[ -f "$OUT/combine.csv" ] || curl -sL "$NFLVERSE/combine/combine.csv" -o "$OUT/combine.csv" &
[ -f "$OUT/draft_picks.csv" ] || curl -sL "$NFLVERSE/draft_picks/draft_picks.csv" -o "$OUT/draft_picks.csv" &
[ -f "$OUT/historical_contracts.csv" ] || curl -sL "$NFLVERSE/contracts/historical_contracts.csv" -o "$OUT/historical_contracts.csv" &
[ -f "$OUT/trades.csv" ] || curl -sL "$NFLVERSE/trades/trades.csv" -o "$OUT/trades.csv" &
[ -f "$OUT/qbr_season_level.csv" ] || curl -sL "$NFLVERSE/espn_data/qbr_season_level.csv" -o "$OUT/qbr_season_level.csv" &
[ -f "$OUT/qbr_week_level.csv" ] || curl -sL "$NFLVERSE/espn_data/qbr_week_level.csv" -o "$OUT/qbr_week_level.csv" &

# ── Advanced stats (static, skip if cached) ──
for s in 2024 2023 2022 2021 2020 2019 2018 2017; do
  for type in pass rush rec def; do
    [ -f "$OUT/advstats_week_${type}_${s}.csv" ] || curl -sL "$NFLVERSE/pfr_advstats/advstats_week_${type}_${s}.csv" -o "$OUT/advstats_week_${type}_${s}.csv" &
  done
done

# ── Next Gen Stats (static except current season, skip if cached) ──
for s in 2024 2023 2022 2021 2020 2019 2018 2017; do
  for type in passing rushing receiving; do
    if [ ! -f "$OUT/ngs_${s}_${type}.csv" ]; then
      curl -sfL "$NFLVERSE/nextgen_stats/ngs_${s}_${type}.csv.gz" | gunzip > "$OUT/ngs_${s}_${type}.csv" &
    fi
  done
done
# Current season NGS: always refresh
for type in passing rushing receiving; do
  curl -sfL "$NFLVERSE/nextgen_stats/ngs_${type}.csv.gz" | gunzip > "$OUT/ngs_2025_${type}.csv" &
done

# ── FTN Charting (static, skip if cached) ──
for s in 2024 2023 2022; do
  [ -f "$OUT/ftn_charting_${s}.csv" ] || curl -sL "$NFLVERSE/ftn_charting/ftn_charting_${s}.csv" -o "$OUT/ftn_charting_${s}.csv" &
done

# ── Play-by-play (static, skip if cached — largest files) ──
for s in 2024 2023 2022 2021 2020 2019 2018 2017; do
  [ -f "$OUT/play_by_play_${s}.csv" ] || curl -sL "$NFLVERSE/pbp/play_by_play_${s}.csv" -o "$OUT/play_by_play_${s}.csv" &
done

# ── PBP participation (static, skip if cached) ──
for s in 2024 2023 2022 2021 2020 2019 2018 2017; do
  [ -f "$OUT/pbp_participation_${s}.csv" ] || curl -sL "$NFLVERSE/pbp_participation/pbp_participation_${s}.csv" -o "$OUT/pbp_participation_${s}.csv" &
done

# ── DynastyProcess fantasy rankings ──
[ -f "$OUT/db_fpecr_latest.csv" ] || curl -sL "https://github.com/dynastyprocess/data/raw/master/files/db_fpecr_latest.csv" -o "$OUT/db_fpecr_latest.csv" &

# ── College stats & QBR (static, skip if cached) ──
DRAFTDATA="https://raw.githubusercontent.com/JackLich10/nfl-draft-data/main"
[ -f "$OUT/college_statistics.csv" ] || curl -sfL "$DRAFTDATA/college_statistics.csv" -o "$OUT/college_statistics.csv" &
[ -f "$OUT/college_qbr.csv" ] || curl -sfL "$DRAFTDATA/college_qbr.csv" -o "$OUT/college_qbr.csv" &

wait

# Clean up any leftover .tmp files from failed downloads
rm -f "$OUT"/*.tmp

# ── Validate critical dynamic files ──
echo ""
echo "=== Dynamic file validation ==="
MISSING=0
for s in $DYNAMIC_SEASON; do
  for f in "roster_${s}.csv" "player_stats_${s}.csv"; do
    if [ ! -s "$OUT/$f" ]; then
      echo "  ERROR: $f is missing or empty!"
      MISSING=$((MISSING + 1))
    else
      LINES=$(wc -l < "$OUT/$f")
      SIZE=$(du -h "$OUT/$f" | cut -f1)
      echo "  OK: $f ($LINES lines, $SIZE)"
    fi
  done
done
if [ "$MISSING" -gt 0 ]; then
  echo "  WARNING: $MISSING critical dynamic files missing — predictions may use stale data"
fi

echo ""
echo "Done! Data files in $OUT/"
echo "Cached files: $(find $OUT -name '*.csv' -o -name '*.json' | wc -l)"
ls -lhS "$OUT/" | head -20
