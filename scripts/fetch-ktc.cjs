#!/usr/bin/env node
/**
 * Fetch KTC dynasty rankings and history, save as JSON.
 * Usage: node scripts/fetch-ktc.js public/data
 */

const fs = require('fs');
const path = require('path');

const OUT = process.argv[2] || 'public/data';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchKTCRankings(formatName, formatParam) {
  const outfile = path.join(OUT, `ktc_rankings_${formatName}.json`);
  if (fs.existsSync(outfile)) {
    console.log(`  [skip] ${outfile} already exists`);
    return;
  }

  console.log(`  Fetching KTC rankings (${formatName})...`);
  const allPlayers = [];
  const seen = new Set(); // deduplicate playerIDs across pages

  for (let page = 0; page < 10; page++) {
    const url = `https://keeptradecut.com/dynasty-rankings?page=${page}&filters=QB|WR|RB|TE|RDP&format=${formatParam}`;
    let html;
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': UA, 'Referer': 'https://keeptradecut.com/' },
      });
      if (!resp.ok) {
        if (page === 0) throw new Error(`KTC returned ${resp.status}`);
        break;
      }
      html = await resp.text();
    } catch (err) {
      if (page === 0) throw err;
      break;
    }

    const match = html.match(/var\s+playersArray\s*=\s*(\[[\s\S]*?\]);/);
    if (!match) {
      if (page === 0) throw new Error('Could not find playersArray in KTC page');
      break;
    }

    const players = JSON.parse(match[1]);
    let added = 0;
    for (const p of players) {
      const id = Number(p.playerID) || 0;
      if (seen.has(id)) continue; // deduplicate across pages
      seen.add(id);
      // KTC moved values into nested objects in 2025:
      // oneQBValues.value / superflexValues.value / oneQBValues.positionalRank
      // Fall back to old flat fields so the script stays resilient.
      const oneQB = p.oneQBValues || {};
      const sf    = p.superflexValues || {};
      allPlayers.push({
        playerID: id,
        playerName: String(p.playerName || ''),
        position: String(p.position || ''),
        positionRank: Number(oneQB.positionalRank ?? p.positionRank) || 0,
        team: String(p.team || ''),
        age: Number(p.age) || 0,
        value: Number(oneQB.value ?? p.value) || 0,
        superflexValue: Number(sf.value ?? p.superflexValue) || 0,
        isRookie: Boolean(p.isRookie ?? p.rookie),
        slug: String(p.slug || ''),
      });
      added++;
    }
    console.log(`    Page ${page}: ${players.length} players (${added} new)`);
    if (added === 0) break; // no new players on this page — stop early
  }

  fs.writeFileSync(outfile, JSON.stringify(allPlayers));
  console.log(`  Saved ${outfile} (${allPlayers.length} unique players)`);
}

function parsePackedHistory(arr) {
  return (arr || []).map(item => {
    if (typeof item === 'object') return item;
    const s = String(item);
    return {
      d: `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}`,
      v: Number(s.slice(6)),
    };
  });
}

async function fetchKTCHistory() {
  const rankingsFile = path.join(OUT, 'ktc_rankings_1qb.json');
  const outfile = path.join(OUT, 'ktc_history.json');

  if (fs.existsSync(outfile)) {
    console.log(`  [skip] ${outfile} already exists`);
    return;
  }

  if (!fs.existsSync(rankingsFile)) {
    console.log('  [skip] KTC history: no rankings file');
    return;
  }

  console.log('  Fetching KTC history...');
  const rankings = JSON.parse(fs.readFileSync(rankingsFile, 'utf8'));
  const playerIDs = rankings.filter(p => p.playerID > 0).map(p => p.playerID);

  const allHistory = [];
  const batchSize = 50;

  for (let i = 0; i < playerIDs.length; i += batchSize) {
    const batch = playerIDs.slice(i, i + batchSize);

    try {
      const resp = await fetch('https://keeptradecut.com/dynasty-rankings/histories', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': UA,
          'Referer': 'https://keeptradecut.com/',
          'Origin': 'https://keeptradecut.com',
        },
        body: JSON.stringify(batch),
      });

      if (!resp.ok) {
        console.log(`    Batch ${i}–${i + batch.length}: HTTP ${resp.status}, skipping`);
        continue;
      }

      const data = await resp.json();
      for (const entry of data) {
        allHistory.push({
          playerID: entry.playerID,
          oneQB: { valueHistory: parsePackedHistory(entry.oneQB?.valueHistory) },
          superflex: { valueHistory: parsePackedHistory(entry.superflex?.valueHistory) },
        });
      }
    } catch (err) {
      console.log(`    Batch ${i}–${i + batch.length}: error ${err.message}, skipping`);
    }

    console.log(`    Fetched ${Math.min(i + batchSize, playerIDs.length)} / ${playerIDs.length}`);

    // Be nice to KTC
    if (i + batchSize < playerIDs.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  fs.writeFileSync(outfile, JSON.stringify(allHistory));
  console.log(`  Saved ${outfile} (${allHistory.length} players)`);
}


// KTC also prices DEVY players (college prospects yet to be drafted) on the
// same site framework — the page embeds the identical playersArray blob.
// One file carries both formats' values (each page ships oneQBValues +
// superflexValues). Non-fatal by design: a devy layout change must never
// cost the daily NFL snapshot.
async function fetchKTCDevy() {
  const outfile = path.join(OUT, 'ktc_rankings_devy.json');
  if (fs.existsSync(outfile)) {
    console.log(`  [skip] ${outfile} already exists`);
    return;
  }
  console.log('  Fetching KTC devy rankings...');
  const allPlayers = [];
  const seen = new Set();
  for (let page = 0; page < 10; page++) {
    const url = `https://keeptradecut.com/devy-rankings?page=${page}&filters=QB|WR|RB|TE&format=1`;
    let html;
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': UA, 'Referer': 'https://keeptradecut.com/' },
      });
      if (!resp.ok) {
        if (page === 0) throw new Error(`KTC devy returned ${resp.status}`);
        break;
      }
      html = await resp.text();
    } catch (err) {
      if (page === 0) throw err;
      break;
    }
    const match = html.match(/var\s+playersArray\s*=\s*(\[[\s\S]*?\]);/);
    if (!match) {
      if (page === 0) throw new Error('Could not find playersArray in KTC devy page');
      break;
    }
    const players = JSON.parse(match[1]);
    let added = 0;
    for (const p of players) {
      const id = Number(p.playerID) || 0;
      if (seen.has(id)) continue;
      seen.add(id);
      const oneQB = p.oneQBValues || {};
      const sf = p.superflexValues || {};
      allPlayers.push({
        playerID: id,
        playerName: String(p.playerName || ''),
        position: String(p.position || ''),
        positionRank: Number(oneQB.positionalRank ?? p.positionRank) || 0,
        // On devy pages `team` is the college program.
        team: String(p.team || ''),
        age: Number(p.age) || 0,
        value: Number(oneQB.value ?? p.value) || 0,
        superflexValue: Number(sf.value ?? p.superflexValue) || 0,
        slug: String(p.slug || ''),
      });
      added++;
    }
    console.log(`    Devy page ${page}: ${players.length} players (${added} new)`);
    if (added === 0) break;
  }
  fs.writeFileSync(outfile, JSON.stringify(allPlayers));
  console.log(`  Saved ${outfile} (${allPlayers.length} unique devy players)`);
}

async function main() {
  await fetchKTCRankings('1qb', '1');
  await fetchKTCRankings('superflex', '0');
  await fetchKTCHistory();
  try {
    await fetchKTCDevy();
  } catch (err) {
    console.log(`  Devy fetch failed (non-fatal): ${err.message}`);
  }
}

main().catch(err => {
  console.error('KTC fetch failed:', err.message);
  // Non-fatal — the site will fall back to runtime fetching
  process.exit(0);
});
