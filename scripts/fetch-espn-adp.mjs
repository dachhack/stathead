#!/usr/bin/env node
// Snapshots ESPN's live draft-room ADP into public/data/espn_adp_<season>.json,
// one of the sources src/lib/adpSources.ts blends into the consensus board.
//
// Why a script rather than the one-line curl this replaces: the ADP fields
// (`ownership.averageDraftPosition`, `draftRanksByRankType`) only come back
// under `view=kona_player_info`. The old snapshot used `view=players_wl`, which
// returns the same 11.6k players with those objects omitted — so every row
// parsed to adp=0 and loadEspn(), which filters on `adp > 0`, silently
// contributed nothing to the blend.
//
// kona_player_info is ~39 MB (the endpoint ignores the filter's `limit`), which
// is both wasteful to ship and over Cloudflare Pages' 25 MiB per-asset cap, so
// this keeps only players carrying a real ADP and only the fields
// parseEspnResponse() reads — ~750 KB. The output stays a bare array of raw
// ESPN player objects, the shape that parser already accepts.
//
// Non-fatal by design: on any failure an existing snapshot is left untouched
// (a stale ADP board beats no board), and the build continues.
//
//   node scripts/fetch-espn-adp.mjs <season> [outDir]
import fs from 'fs';
import path from 'path';

const SEASON = process.argv[2];
const OUT_DIR = process.argv[3] || 'public/data';

if (!/^\d{4}$/.test(SEASON || '')) {
  console.error('usage: node scripts/fetch-espn-adp.mjs <season> [outDir]');
  process.exit(2);
}

const OUT = path.join(OUT_DIR, `espn_adp_${SEASON}.json`);
const URL_ = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/players?scoringPeriodId=0&view=kona_player_info`;
const FILTER = {
  players: {
    limit: 5000,
    sortDraftRanks: { sortPriority: 100, sortAsc: true, value: 'PPR' },
  },
};

// Only the keys src/data.ts parseEspnResponse() reads, so the snapshot stays
// small without changing how it parses.
const slimRank = (r) => (r ? { rank: r.rank, auctionValue: r.auctionValue } : undefined);

function slim(player) {
  const own = player.ownership || {};
  const ranks = player.draftRanksByRankType || {};
  const out = {
    id: player.id,
    fullName: player.fullName,
    firstName: player.firstName,
    lastName: player.lastName,
    defaultPositionId: player.defaultPositionId,
    proTeamId: player.proTeamId,
    ownership: {
      averageDraftPosition: own.averageDraftPosition,
      percentOwned: own.percentOwned,
    },
    draftRanksByRankType: {},
  };
  for (const type of ['PPR', 'STANDARD']) {
    const r = slimRank(ranks[type]);
    if (r) out.draftRanksByRankType[type] = r;
  }
  return out;
}

async function main() {
  const resp = await fetch(URL_, {
    headers: { Accept: 'application/json', 'x-fantasy-filter': JSON.stringify(FILTER) },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const raw = await resp.json();
  const rows = Array.isArray(raw) ? raw : raw.players || [];

  const drafted = rows
    .map((entry) => entry.player || entry)
    .filter((p) => (p?.ownership?.averageDraftPosition ?? 0) > 0)
    .map(slim)
    .sort(
      (a, b) =>
        a.ownership.averageDraftPosition - b.ownership.averageDraftPosition,
    );

  // Never blank a good snapshot on an empty or malformed response — ESPN zeroes
  // ADP out between seasons, and that must not wipe the committed board.
  if (drafted.length === 0) {
    throw new Error(`no players with an ADP in ${rows.length} rows`);
  }

  fs.writeFileSync(OUT, JSON.stringify(drafted));
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(
    `  Saved ${OUT} — ${drafted.length} players with ADP (${kb} KB), ` +
      `top: ${drafted[0].fullName} @ ${drafted[0].ownership.averageDraftPosition}`,
  );
}

main().catch((err) => {
  console.log(`  WARNING: ESPN ADP ${SEASON} fetch failed (${err.message}) — keeping existing snapshot`);
});
