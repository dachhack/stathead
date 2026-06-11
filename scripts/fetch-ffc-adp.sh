#!/bin/bash
# Fetch FantasyFootballCalculator PPR ADP for a range of seasons.
#
# FFC's public API (fantasyfootballcalculator.com) serves these requests fine
# from GitHub Actions runners, but 403s "Host not in allowlist" from most other
# environments (the dev sandbox, browsers behind some networks). So this is a
# CI-side fetcher — run it from .github/workflows/fetch-ffc-adp.yml, not locally
# in the restricted sandbox.
#
# Writes one file per season and scoring: public/data/ffc_adp_<scoring>_<year>.json
# (raw API shape, top-level { "meta": {...}, "players": [...] }). Scorings:
# ppr (1QB redraft) and 2qb (superflex — radically different QB pricing).
#
# Behaviour is intentionally non-destructive: a season's file is only
# overwritten when the fetch returns a non-empty players array. A failed fetch
# or an empty response leaves any existing committed file untouched, so a
# transient FFC hiccup can never blank out good data.
#
# Env:
#   FFC_SEASONS        space-separated years to fetch (default 2018..2026)
#   FFC_SCORINGS       space-separated scorings to fetch (default "ppr 2qb")
#   FFC_DYNAMIC_FROM   seasons >= this are always re-fetched; older seasons are
#                      skipped when a non-empty file already exists, since
#                      historical ADP is immutable (default 2026)
#   FFC_FORCE=1        re-fetch every season even if a good file already exists
#
# Usage: bash scripts/fetch-ffc-adp.sh [OUT_DIR]
set -euo pipefail

OUT="${1:-public/data}"
mkdir -p "$OUT"

SEASONS="${FFC_SEASONS:-2018 2019 2020 2021 2022 2023 2024 2025 2026}"
SCORINGS="${FFC_SCORINGS:-ppr 2qb}"
DYNAMIC_FROM="${FFC_DYNAMIC_FROM:-2026}"
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

# Count players in a JSON file (0 on missing/parse error/empty).
player_count() {
  python3 -c "import json,sys
try: print(len(json.load(open(sys.argv[1])).get('players',[])))
except Exception: print(0)" "$1" 2>/dev/null || echo 0
}

echo "Fetching FFC ADP for: $SEASONS (scorings: $SCORINGS)"
fetched=0 kept=0 failed=0
for sc in $SCORINGS; do
for s in $SEASONS; do
  dest="$OUT/ffc_adp_${sc}_${s}.json"
  # Skip immutable historical seasons that already have good data.
  if [ "${FFC_FORCE:-0}" != "1" ] && [ "$s" -lt "$DYNAMIC_FROM" ] && [ -s "$dest" ] \
     && [ "$(player_count "$dest")" -gt 0 ]; then
    echo "  [skip] $sc $s — already have $(player_count "$dest") players"
    kept=$((kept + 1))
    continue
  fi

  url="https://fantasyfootballcalculator.com/api/v1/adp/${sc}?teams=12&year=${s}"
  tmp="$(mktemp)"
  if curl -fsSL -A "$UA" -H 'Accept: application/json' "$url" -o "$tmp"; then
    n="$(player_count "$tmp")"
    if [ "$n" -gt 0 ]; then
      mv "$tmp" "$dest"
      echo "  [ok]   $sc $s — saved $n players"
      fetched=$((fetched + 1))
    else
      echo "  [warn] $sc $s — response had 0 players; keeping existing file"
      rm -f "$tmp"
      failed=$((failed + 1))
    fi
  else
    echo "  [warn] $sc $s — fetch failed; keeping existing file"
    rm -f "$tmp"
    failed=$((failed + 1))
  fi
done
done

echo "Done. fetched=$fetched kept=$kept failed=$failed"
