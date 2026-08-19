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
# Seasons for the heavier derived sources. nflverse publishes these weeks-to-
# months after a season ends and never for a season that hasn't kicked off, so
# they get their own lists — bump both once a year, alongside STATIC_SEASONS.
# DYNAMIC_SEASON is fetched on top of each and tolerates a 404 until Week 1.
DERIVED_SEASONS="2025 2024 2023 2022 2021 2020 2019 2018 2017"
FTN_SEASONS="2025 2024 2023 2022"

# Fetch a file that may legitimately not exist yet (a current-season asset
# before Week 1) or may have been dropped upstream. Downloads to a temp file
# so a 404 can never overwrite a good cached copy with an error page — the
# reason these use `curl -sfL` + mv rather than a bare `-o`.
fetch_optional() {
  # fetch_optional <release-subpath>
  local sub="$1" name
  name="${sub##*/}"
  if curl -sfL "$NFLVERSE/$sub" -o "$OUT/$name.tmp" && [ -s "$OUT/$name.tmp" ]; then
    mv "$OUT/$name.tmp" "$OUT/$name"
  else
    rm -f "$OUT/$name.tmp"
    echo "  (unavailable upstream: $name)"
  fi
}

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

# ── Advanced stats (PFR) ──
for s in $DERIVED_SEASONS; do
  for type in pass rush rec def; do
    [ -s "$OUT/advstats_week_${type}_${s}.csv" ] || fetch_optional "pfr_advstats/advstats_week_${type}_${s}.csv" &
  done
done
# Current season: re-fetch every run (404s until Week 1 is charted).
for type in pass rush rec def; do
  fetch_optional "pfr_advstats/advstats_week_${type}_${DYNAMIC_SEASON}.csv" &
done

# ── Next Gen Stats ──
# nflverse shards NGS per season only for seasons that have been closed out —
# as of 2026-08 ngs_<season>_<type>.csv.gz exists through 2024 and 404s for
# 2025 and 2026. What is always current is the un-suffixed
# nextgen_stats/ngs_<type>.csv.gz, one file per stat type holding every season
# from 2016 on. So download that once per type and split it on the `season`
# column into the per-season files the app reads (fetchNextGenStats ->
# data/ngs_<season>_<type>.csv). One download replaces ten, and the current
# season gets its file as soon as Week 1 is charted — no yearly bump here.
for type in passing rushing receiving; do
  (
    gz="$OUT/.ngs_${type}.csv.gz.tmp"
    tmp="$OUT/.ngs_${type}.csv.tmp"
    # Download, THEN inflate — piping curl straight into gunzip would let a
    # truncated transfer produce a short-but-valid-looking CSV and overwrite
    # every good per-season file with partial data.
    if curl -sfL "$NFLVERSE/nextgen_stats/ngs_${type}.csv.gz" -o "$gz" \
       && [ -s "$gz" ] && gunzip -c "$gz" > "$tmp" && [ -s "$tmp" ]; then
      # awk keeps each per-season file open, so `>` appends after the first
      # write; the header is emitted once per season file.
      seasons=$(awk -F, -v out="$OUT" -v type="$type" '
        NR == 1 { header = $0; next }
        $1 ~ /^[0-9][0-9][0-9][0-9]$/ {
          f = out "/ngs_" $1 "_" type ".csv"
          if (!($1 in seen)) { seen[$1] = 1; print header > f }
          print > f
        }
        END { n = ""; for (s in seen) n = n " " s; print n }
      ' "$tmp")
      echo "  ngs_${type}: split into seasons $(echo $seasons | tr ' ' '\n' | sort | tr '\n' ' ')"
    else
      echo "  WARNING: Failed to download ngs_${type}.csv.gz (keeping cached per-season files)"
    fi
    rm -f "$gz" "$tmp"
  ) &
done

# ── FTN Charting ──
for s in $FTN_SEASONS; do
  [ -s "$OUT/ftn_charting_${s}.csv" ] || fetch_optional "ftn_charting/ftn_charting_${s}.csv" &
done
fetch_optional "ftn_charting/ftn_charting_${DYNAMIC_SEASON}.csv" &

# ── Play-by-play (largest files) ──
for s in $DERIVED_SEASONS; do
  [ -s "$OUT/play_by_play_${s}.csv" ] || fetch_optional "pbp/play_by_play_${s}.csv" &
done
fetch_optional "pbp/play_by_play_${DYNAMIC_SEASON}.csv" &

# ── PBP participation ──
for s in $DERIVED_SEASONS; do
  [ -s "$OUT/pbp_participation_${s}.csv" ] || fetch_optional "pbp_participation/pbp_participation_${s}.csv" &
done
fetch_optional "pbp_participation/pbp_participation_${DYNAMIC_SEASON}.csv" &

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
# roster_<season> is published year-round, so a missing one is always an error.
# player_stats_<season> is not: nflverse only publishes it once the season's
# first games are played, so from March to September it legitimately 404s.
# Reporting that as ERROR every run for six months is a false alarm, and a
# standing false ERROR is how a real one gets ignored in week 1.
#
# Whether the season has started is read from the schedule downloaded above —
# any completed regular-season game for DYNAMIC_SEASON — rather than a kickoff
# date somebody has to remember to bump each year. If that can't be determined
# (no games.csv), fall back to treating the file as required, so an
# indeterminate check can never mask a genuine outage.
season_started() {
  # 0 = started, 1 = not started yet, 2 = can't tell
  [ -s "$OUT/games.csv" ] || return 2
  awk -F, -v season="$1" '
    NR == 1 { for (i = 1; i <= NF; i++) col[$i] = i; next }
    col["season"] && $(col["season"]) == season && $(col["game_type"]) == "REG" \
      && $(col["home_score"]) != "" { started = 1; exit }
    END { exit(started ? 0 : 1) }
  ' "$OUT/games.csv"
}

echo ""
echo "=== Dynamic file validation ==="
MISSING=0
for s in $DYNAMIC_SEASON; do
  if season_started "$s"; then started=0; else started=$?; fi
  case "$started" in
    0) echo "  ${s} regular season is underway — current-season stats expected." ;;
    1) echo "  ${s} regular season hasn't kicked off — in-season files are not published yet." ;;
    *) echo "  NOTE: can't tell whether ${s} has started (no games.csv) — treating all files as required." ;;
  esac
  for f in "roster_${s}.csv" "player_stats_${s}.csv"; do
    if [ -s "$OUT/$f" ]; then
      LINES=$(wc -l < "$OUT/$f")
      SIZE=$(du -h "$OUT/$f" | cut -f1)
      echo "  OK: $f ($LINES lines, $SIZE)"
    elif [ "$f" = "player_stats_${s}.csv" ] && [ "$started" = "1" ]; then
      echo "  pending: $f — expected, nflverse publishes it after week 1"
    else
      echo "  ERROR: $f is missing or empty!"
      MISSING=$((MISSING + 1))
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
