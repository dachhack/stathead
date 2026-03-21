#!/bin/bash
# Download external API data at build time so the site works without
# runtime API dependencies. Saves JSON files into public/data/.
# Sleeper is excluded (reliable CORS, large payload, frequently changing).

set -e

OUT="public/data"
mkdir -p "$OUT"

echo "Fetching external API data..."

# ── KTC Dynasty Rankings (scrape playersArray from HTML) ──
fetch_ktc_rankings() {
  local format_name="$1"  # "1qb" or "superflex"
  local format_param="$2" # "1" or "0"
  local outfile="$OUT/ktc_rankings_${format_name}.json"

  if [ -f "$outfile" ]; then
    echo "  [skip] $outfile already exists"
    return
  fi

  echo "  Fetching KTC rankings ($format_name)..."
  local all_players="[]"

  for page in $(seq 0 9); do
    local html
    html=$(curl -sL "https://keeptradecut.com/dynasty-rankings?page=${page}&filters=QB|WR|RB|TE|RDP&format=${format_param}" \
      -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" \
      -H "Referer: https://keeptradecut.com/" || echo "")

    if [ -z "$html" ]; then
      [ "$page" -eq 0 ] && echo "    ERROR: Failed to fetch KTC page 0" && return 1
      break
    fi

    # Extract playersArray JSON from embedded script
    local players
    players=$(echo "$html" | grep -oP 'var\s+playersArray\s*=\s*\K\[.*?\];' | sed 's/;$//' || echo "")

    if [ -z "$players" ]; then
      [ "$page" -eq 0 ] && echo "    ERROR: Could not parse KTC page 0" && return 1
      break
    fi

    # Merge arrays using node
    all_players=$(node -e "
      const existing = $all_players;
      const newPlayers = $players;
      const merged = existing.concat(newPlayers.map(p => ({
        playerID: Number(p.playerID) || 0,
        playerName: String(p.playerName || ''),
        position: String(p.position || ''),
        positionRank: Number(p.positionRank) || 0,
        team: String(p.team || ''),
        age: Number(p.age) || 0,
        value: Number(p.value) || 0,
        superflexValue: Number(p.superflexValue) || 0,
        isRookie: Boolean(p.isRookie),
        slug: String(p.slug || ''),
      })));
      console.log(JSON.stringify(merged));
    ")

    echo "    Page $page: OK"
  done

  echo "$all_players" > "$outfile"
  echo "  Saved $outfile ($(echo "$all_players" | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).length))") players)"
}

# ── KTC History (POST endpoint) ──
fetch_ktc_history() {
  local rankings_file="$OUT/ktc_rankings_1qb.json"
  local outfile="$OUT/ktc_history.json"

  if [ -f "$outfile" ]; then
    echo "  [skip] $outfile already exists"
    return
  fi

  if [ ! -f "$rankings_file" ]; then
    echo "  [skip] KTC history: no rankings file to get player IDs from"
    return
  fi

  echo "  Fetching KTC history..."

  # Get all player IDs from rankings
  local player_ids
  player_ids=$(node -e "
    const data = JSON.parse(require('fs').readFileSync('$rankings_file', 'utf8'));
    const ids = data.filter(p => p.playerID > 0).map(p => p.playerID);
    console.log(JSON.stringify(ids));
  ")

  # Fetch in batches of 50
  local all_history="[]"
  local total
  total=$(node -e "console.log(JSON.parse('$player_ids').length)")
  local batch_size=50
  local offset=0

  while [ "$offset" -lt "$total" ]; do
    local batch
    batch=$(node -e "
      const ids = $player_ids;
      console.log(JSON.stringify(ids.slice($offset, $offset + $batch_size)));
    ")

    local response
    response=$(curl -sL "https://keeptradecut.com/dynasty-rankings/histories" \
      -X POST \
      -H "Content-Type: application/json" \
      -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" \
      -H "Referer: https://keeptradecut.com/" \
      -H "Origin: https://keeptradecut.com" \
      -d "$batch" || echo "[]")

    all_history=$(node -e "
      const existing = $all_history;
      const batch = $response;
      // Parse packed history strings into {d, v} objects
      function parseHistory(arr) {
        return (arr || []).map(item => {
          if (typeof item === 'object') return item;
          const s = String(item);
          const yy = s.slice(0, 2);
          const mm = s.slice(2, 4);
          const dd = s.slice(4, 6);
          const v = Number(s.slice(6));
          return { d: '20' + yy + '-' + mm + '-' + dd, v };
        });
      }
      const parsed = batch.map(entry => ({
        playerID: entry.playerID,
        oneQB: { valueHistory: parseHistory(entry.oneQB?.valueHistory) },
        superflex: { valueHistory: parseHistory(entry.superflex?.valueHistory) },
      }));
      console.log(JSON.stringify(existing.concat(parsed)));
    ")

    offset=$((offset + batch_size))
    echo "    Fetched $offset / $total"
    sleep 1  # Be nice to KTC
  done

  echo "$all_history" > "$outfile"
  echo "  Saved $outfile"
}

# ── FantasyCalc ──
fetch_fantasycalc() {
  local outfile="$OUT/fantasycalc_dynasty_1qb.json"
  if [ -f "$outfile" ]; then
    echo "  [skip] $outfile already exists"
    return
  fi

  echo "  Fetching FantasyCalc values..."
  curl -sL "https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=1&numTeams=12&ppr=1" \
    -o "$outfile" || echo "[]" > "$outfile"
  echo "  Saved $outfile"

  # Also fetch superflex and redraft variants
  for variant in "true-2-12-1:fantasycalc_dynasty_sf" "false-1-12-1:fantasycalc_redraft_1qb"; do
    IFS=':' read -r params name <<< "$variant"
    IFS='-' read -r isDyn nqb nt ppr <<< "$params"
    local vfile="$OUT/${name}.json"
    if [ ! -f "$vfile" ]; then
      curl -sL "https://api.fantasycalc.com/values/current?isDynasty=${isDyn}&numQbs=${nqb}&numTeams=${nt}&ppr=${ppr}" \
        -o "$vfile" || echo "[]" > "$vfile"
      echo "  Saved $vfile"
    fi
  done
}

# ── ESPN ADP ──
fetch_espn_adp() {
  local season="${1:-2025}"
  local outfile="$OUT/espn_adp_${season}.json"
  if [ -f "$outfile" ]; then
    echo "  [skip] $outfile already exists"
    return
  fi

  echo "  Fetching ESPN ADP ($season)..."
  local filter='{"players":{"limit":500,"sortDraftRanks":{"sortPriority":100,"sortAsc":true,"value":"PPR"}}}'
  curl -sL "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/players?scoringPeriodId=0&view=players_wl" \
    -H "x-fantasy-filter: $filter" \
    -o "$outfile" || echo "[]" > "$outfile"
  echo "  Saved $outfile"
}

# ── FFC ADP ──
fetch_ffc_adp() {
  local season="${1:-2025}"
  local outfile="$OUT/ffc_adp_ppr_${season}.json"
  if [ -f "$outfile" ]; then
    echo "  [skip] $outfile already exists"
    return
  fi

  echo "  Fetching FFC ADP ($season)..."
  curl -sL "https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=12&year=${season}" \
    -o "$outfile" || echo '{"players":[]}' > "$outfile"
  echo "  Saved $outfile"
}

# ── Run all fetches ──
fetch_ktc_rankings "1qb" "1"
fetch_ktc_rankings "superflex" "0"
fetch_ktc_history
fetch_fantasycalc
fetch_espn_adp 2025
fetch_ffc_adp 2025

echo "Done! API data saved to $OUT/"
