#!/bin/bash
# Download external API data at build time.
# With actions/cache, static historical data persists between builds.
# Only current-season/dynamic data is force-refreshed.

set -e

OUT="public/data"
mkdir -p "$OUT"

# Browser-ish UA for hosts that reject bare curl (e.g. FFC ADP).
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

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

# ── ESPN NFL athlete ids (name -> espn_id from team rosters) ──
# Feeds build-player-crosswalk.py's espn_id backfill so player-detail pages get
# ESPN news + headshots, including current rookies that nflverse/Sleeper miss.
# Non-fatal: an ESPN hiccup must never break the build (the script leaves any
# existing file untouched on failure).
echo "  Fetching ESPN NFL athlete ids..."
node scripts/fetch-espn-nfl-ids.mjs "$OUT" || echo "  WARN: ESPN id fetch failed — keeping existing espn-nfl-ids.json"

# ── FFC ADP ──
# fantasyfootballcalculator.com 403s "Host not in allowlist" from many networks
# but serves GitHub runners fine. A bare `curl -sL` exits 0 even on a 403 (it
# just writes the error body), so use -f and a player-count check: only treat a
# file as good when it actually parses to a non-empty players array, and never
# overwrite a good file with an empty/error response.
ffc_player_count() {
  python3 -c "import json,sys
try: print(len(json.load(open(sys.argv[1])).get('players',[])))
except Exception: print(0)" "$1" 2>/dev/null || echo 0
}
fetch_ffc() {
  local season="$1" outfile="$OUT/ffc_adp_ppr_${season}.json" tmp
  tmp="$(mktemp)"
  echo "  Fetching FFC ADP ($season)..."
  if curl -fsSL -A "$UA" -H 'Accept: application/json' \
       "https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=12&year=${season}" \
       -o "$tmp" && [ "$(ffc_player_count "$tmp")" -gt 0 ]; then
    mv "$tmp" "$outfile"
    echo "  Saved $outfile ($(ffc_player_count "$outfile") players)"
  else
    rm -f "$tmp"
    if [ -s "$outfile" ]; then
      echo "  WARN: FFC $season fetch failed/empty — keeping existing $outfile"
    else
      echo '{"players":[]}' > "$outfile"
      echo "  WARN: FFC $season fetch failed/empty — wrote empty placeholder"
    fi
  fi
}
# Static historical seasons: skip only if a non-empty file is already cached
# (a stale empty/error file from a past 403 gets re-fetched).
for season in 2025 2024 2023 2022 2021 2020 2019 2018; do
  outfile="$OUT/ffc_adp_ppr_${season}.json"
  if [ -s "$outfile" ] && [ "$(ffc_player_count "$outfile")" -gt 0 ]; then
    echo "  [cached] $outfile ($(ffc_player_count "$outfile") players)"
  else
    fetch_ffc "$season"
  fi
done
# Dynamic current seasons: always refresh
for season in 2026; do
  fetch_ffc "$season"
done

# ── Reddit Sentiment ──
# Reddit's public search endpoint now returns 403 for unauthenticated
# clients, and the redditMention* / redditSentiment* / redditHype* /
# redditMentionVelocity features were never used by the current PPG model
# (zero coefficients in v56). The scrape is off by default — set
# ENABLE_REDDIT_SCRAPE=1 to re-enable once proper OAuth is wired up.
if [ "${ENABLE_REDDIT_SCRAPE:-0}" = "1" ]; then
  if [ -f "$OUT/reddit_sentiment.json" ]; then
    echo "  [cached] Reddit sentiment data exists — skipping full scrape"
    echo "  (Delete public/data/reddit_sentiment.json to force re-scrape)"
  else
    echo "  Fetching Reddit sentiment data..."
    NODE_OPTIONS='--max-old-space-size=4096' npx tsx scripts/fetch-reddit-sentiment.ts || echo "Reddit sentiment fetch skipped"
  fi
else
  echo "  [skipped] Reddit sentiment — needs OAuth; features zero-fill safely. Set ENABLE_REDDIT_SCRAPE=1 to opt in."
fi

echo "Done! API data saved to $OUT/"
