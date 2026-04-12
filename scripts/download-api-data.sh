#!/bin/bash
# Download external API data at build time.
# With actions/cache, static historical data persists between builds.
# Only current-season/dynamic data is force-refreshed.

set -e

OUT="public/data"
mkdir -p "$OUT"

echo "Fetching external API data..."

# ── KTC (always refresh — values change daily) ──
node scripts/fetch-ktc.cjs "$OUT"

# ── FantasyCalc (always refresh — values change daily) ──
for variant in "true&numQbs=1:fantasycalc_dynasty_1qb" "true&numQbs=2:fantasycalc_dynasty_sf" "false&numQbs=1:fantasycalc_redraft_1qb"; do
  IFS=':' read -r params name <<< "$variant"
  outfile="$OUT/${name}.json"
  echo "  Fetching FantasyCalc ($name)..."
  curl -sL "https://api.fantasycalc.com/values/current?isDynasty=${params}&numTeams=12&ppr=1" \
    -o "$outfile" || echo "[]" > "$outfile"
  echo "  Saved $outfile"
done

# ── ESPN ADP (refresh for current draft season) ──
for season in 2025; do
  outfile="$OUT/espn_adp_${season}.json"
  echo "  Fetching ESPN ADP ($season)..."
  filter='{"players":{"limit":500,"sortDraftRanks":{"sortPriority":100,"sortAsc":true,"value":"PPR"}}}'
  curl -sL "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/players?scoringPeriodId=0&view=players_wl" \
    -H "x-fantasy-filter: $filter" \
    -o "$outfile" || echo "[]" > "$outfile"
  echo "  Saved $outfile"
done

# ── FFC ADP ──
# Static historical seasons: skip if cached
for season in 2025 2024 2023 2022 2021 2020 2019 2018; do
  outfile="$OUT/ffc_adp_ppr_${season}.json"
  if [ -s "$outfile" ]; then
    echo "  [cached] $outfile"
  else
    echo "  Fetching FFC ADP ($season)..."
    curl -sL "https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=12&year=${season}" \
      -o "$outfile" || echo '{"players":[]}' > "$outfile"
    echo "  Saved $outfile"
  fi
done
# Dynamic current seasons: always refresh
for season in 2026; do
  outfile="$OUT/ffc_adp_ppr_${season}.json"
  echo "  Fetching FFC ADP ($season)..."
  curl -sL "https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=12&year=${season}" \
    -o "$outfile" || echo '{"players":[]}' > "$outfile"
  echo "  Saved $outfile"
done

# ── Reddit Sentiment ──
# Only scrape if no cached data OR force refresh of current window
if [ -f "$OUT/reddit_sentiment.json" ]; then
  echo "  [cached] Reddit sentiment data exists — skipping full scrape"
  echo "  (Delete public/data/reddit_sentiment.json to force re-scrape)"
else
  echo "  Fetching Reddit sentiment data (first time — will be cached)..."
  NODE_OPTIONS='--max-old-space-size=4096' npx tsx scripts/fetch-reddit-sentiment.ts || echo "Reddit sentiment fetch skipped"
fi

echo "Done! API data saved to $OUT/"
