#!/bin/bash
# Download external API data at build time so the site works without
# runtime API dependencies. Saves JSON files into public/data/.
# Sleeper is excluded (reliable CORS, large payload, frequently changing).

set -e

OUT="public/data"
mkdir -p "$OUT"

echo "Fetching external API data..."

# ── KTC (rankings + history via Node script to avoid shell size limits) ──
node scripts/fetch-ktc.cjs "$OUT"

# ── FantasyCalc ──
for variant in "true&numQbs=1:fantasycalc_dynasty_1qb" "true&numQbs=2:fantasycalc_dynasty_sf" "false&numQbs=1:fantasycalc_redraft_1qb"; do
  IFS=':' read -r params name <<< "$variant"
  outfile="$OUT/${name}.json"
  if [ -f "$outfile" ]; then
    echo "  [skip] $outfile already exists"
  else
    echo "  Fetching FantasyCalc ($name)..."
    curl -sL "https://api.fantasycalc.com/values/current?isDynasty=${params}&numTeams=12&ppr=1" \
      -o "$outfile" || echo "[]" > "$outfile"
    echo "  Saved $outfile"
  fi
done

# ── ESPN ADP ──
for season in 2025; do
  outfile="$OUT/espn_adp_${season}.json"
  if [ -f "$outfile" ]; then
    echo "  [skip] $outfile already exists"
  else
    echo "  Fetching ESPN ADP ($season)..."
    filter='{"players":{"limit":500,"sortDraftRanks":{"sortPriority":100,"sortAsc":true,"value":"PPR"}}}'
    curl -sL "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/players?scoringPeriodId=0&view=players_wl" \
      -H "x-fantasy-filter: $filter" \
      -o "$outfile" || echo "[]" > "$outfile"
    echo "  Saved $outfile"
  fi
done

# ── FFC ADP (all seasons needed for Hit/Bust Factors analysis) ──
for season in 2026 2025 2024 2023 2022 2021; do
  outfile="$OUT/ffc_adp_ppr_${season}.json"
  if [ -f "$outfile" ]; then
    echo "  [skip] $outfile already exists"
  else
    echo "  Fetching FFC ADP ($season)..."
    curl -sL "https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=12&year=${season}" \
      -o "$outfile" || echo '{"players":[]}' > "$outfile"
    echo "  Saved $outfile"
  fi
done

echo "Done! API data saved to $OUT/"
