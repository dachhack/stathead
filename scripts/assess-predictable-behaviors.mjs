// Feasibility screen for a suite of Sleeper user-behaviour models.
// Run: node scripts/assess-predictable-behaviors.mjs
//
// Before building any model, three things decide whether it is worth building:
//
//   1. OBSERVABILITY — can the label be constructed from the public API at all?
//   2. BASE RATE — is the event frequent enough to learn, and not so frequent
//      it is trivial?
//   3. SIGNAL — does anything available before the fact actually move it?
//
// A candidate that fails any of the three is a slide, not a model. Two of the
// seven candidates here fail (1), and two fail (3) on the feature family you
// would reach for first, which is the whole reason for screening.
//
// Reads the crawl caches in .cache/ (gitignored) plus sleeper-population.json.
import fs from 'fs';
import path from 'path';

const CRAWL = '.cache/sleeper-crawl';
const DRAFTS = '.cache/sleeper-drafts';

function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n, den = 1 + (z * z) / n, c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - m) / den, (c + m) / den];
}
function chi2x2(a, b, c, d) {
  const n = a + b + c + d;
  if (Math.min(a + b, c + d, a + c, b + d) === 0) return 0;
  return (n * (a * d - b * c) ** 2) / ((a + b) * (c + d) * (a + c) * (b + d));
}
const sig = (x) => (x > 6.63 ? 'p<0.01' : x > 3.84 ? 'p<0.05' : 'NOT significant');
const pct = (v) => `${(v * 100).toFixed(1)}%`;
function rateLine(label, k, n) {
  const [lo, hi] = wilson(k, n);
  return `${label.padEnd(26)} ${String(k).padStart(5)}/${String(n).padEnd(6)} ${pct(k / n).padStart(7)}  [${pct(lo)}, ${pct(hi)}]`;
}

// ── load ──
const leagues = {};
for (const f of fs.readdirSync(CRAWL)) {
  if (!f.startsWith('league_') || f.split('_').length !== 2) continue;
  leagues[f.slice(7, -5)] = JSON.parse(fs.readFileSync(path.join(CRAWL, f), 'utf8')).data ?? {};
}
const picksFor = (draftId) => {
  const f = path.join(DRAFTS, `picks_${draftId}.json`);
  if (!draftId || !fs.existsSync(f)) return null;
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  return Array.isArray(d) ? d : null;
};
const pop = JSON.parse(fs.readFileSync('sleeper-population.json', 'utf8'));
console.log(`crawled leagues ${Object.keys(leagues).length}, managers ${pop.length}\n`);

// ═══ 1. PLATFORM EXIT ═══
console.log('═══ 1. Leaving the platform — had >=1 league in N, zero in N+1 ═══');
const seasonsBy = new Map();
for (const m of pop) {
  const s = new Map();
  for (const e of m.portfolio ?? []) s.set(e.season, (s.get(e.season) ?? 0) + 1);
  seasonsBy.set(m.managerId, s);
}
let exK = 0, exN = 0;
const sizeBuckets = { '1': [0, 0], '2-3': [0, 0], '4-9': [0, 0], '10+': [0, 0] };
for (let N = 2021; N <= 2024; N++) {
  for (const s of seasonsBy.values()) {
    const held = s.get(String(N)) ?? 0;
    if (held < 1) continue;
    const left = (s.get(String(N + 1)) ?? 0) === 0;
    exN++; if (left) exK++;
    const b = held === 1 ? '1' : held <= 3 ? '2-3' : held <= 9 ? '4-9' : '10+';
    sizeBuckets[b][0]++; if (left) sizeBuckets[b][1]++;
  }
}
console.log(rateLine('  pooled 2021-2024', exK, exN));
console.log('  by leagues held that season — the retention lever:');
for (const b of ['1', '2-3', '4-9', '10+']) {
  const [n, k] = sizeBuckets[b];
  if (n) console.log(rateLine(`    ${b} leagues`, k, n));
}
const single = sizeBuckets['1'], heavy = sizeBuckets['10+'];
console.log(`  single-league users leave ${((single[1] / single[0]) / (heavy[1] / heavy[0])).toFixed(0)}x as often as 10+ league users\n`);

// ═══ 2-3. DRAFT BEHAVIOUR ═══
console.log('═══ 2. QB in rounds 1-2, and 3. TE in round 1 ═══');
const fmtOf = (lg) => {
  const rp = lg.roster_positions ?? [];
  const q = rp.filter((x) => x === 'QB').length;
  const sf = rp.filter((x) => x === 'SUPER_FLEX' || x === 'QB/WR/RB/TE').length;
  return q >= 2 ? '2QB' : sf >= 1 ? 'Superflex' : '1QB';
};
const byFormat = {}; const byTep = { tep: [0, 0], no: [0, 0] };
const habit = { qb: [0, 0, 0, 0], te: [0, 0, 0, 0] };  // aa, an, na, nn
const mgrSeason = new Map();                            // who -> season -> {qb,te}
let teamDrafts = 0;
for (const [lid, lg] of Object.entries(leagues)) {
  const picks = picksFor(lg.draft_id);
  if (!picks) continue;
  const fmt = fmtOf(lg);
  const isTep = Number(lg.scoring_settings?.bonus_rec_te ?? 0) > 0;
  const byRoster = new Map(), byWho = new Map();
  for (const p of picks) {
    if (p.roster_id != null) (byRoster.get(p.roster_id) ?? byRoster.set(p.roster_id, []).get(p.roster_id)).push(p);
    if (p.picked_by) (byWho.get(p.picked_by) ?? byWho.set(p.picked_by, []).get(p.picked_by)).push(p);
  }
  for (const ps of byRoster.values()) {
    teamDrafts++;
    const qb = ps.some((p) => p.round <= 2 && p.metadata?.position === 'QB');
    const te = ps.some((p) => p.round === 1 && p.metadata?.position === 'TE');
    (byFormat[fmt] ??= [0, 0])[0]++; if (qb) byFormat[fmt][1]++;
    const t = isTep ? byTep.tep : byTep.no;
    t[0]++; if (te) t[1]++;
  }
  for (const [who, ps] of byWho) {
    const s = mgrSeason.get(who) ?? mgrSeason.set(who, new Map()).get(who);
    // OR across every draft a manager did that season. Assigning instead of
    // merging kept only their last league and moved the repeat rate by 12
    // points — heavy users draft in many leagues a year.
    const prev = s.get(String(lg.season)) ?? { qb: false, te: false };
    s.set(String(lg.season), {
      qb: prev.qb || ps.some((p) => p.round <= 2 && p.metadata?.position === 'QB'),
      te: prev.te || ps.some((p) => p.round === 1 && p.metadata?.position === 'TE'),
    });
  }
}
console.log(`  team-drafts ${teamDrafts}`);
console.log('  QB early by league format — configuration, not personality:');
for (const f of ['1QB', 'Superflex', '2QB']) if (byFormat[f]) console.log(rateLine(`    ${f}`, byFormat[f][1], byFormat[f][0]));
console.log('  Round-1 TE by TE premium:');
console.log(rateLine('    TE premium', byTep.tep[1], byTep.tep[0]));
console.log(rateLine('    no premium', byTep.no[1], byTep.no[0]));
console.log(`    chi2 ${chi2x2(byTep.tep[1], byTep.tep[0] - byTep.tep[1], byTep.no[1], byTep.no[0] - byTep.no[1]).toFixed(1)}`
  + ` (${sig(chi2x2(byTep.tep[1], byTep.tep[0] - byTep.tep[1], byTep.no[1], byTep.no[0] - byTep.no[1]))})`);

// Does the MANAGER repeat the habit? This is the feature family you would reach
// for first, and for both draft labels it is nearly worthless.
for (const key of ['qb', 'te']) {
  const h = habit[key];
  for (const s of mgrSeason.values()) {
    for (let N = 2021; N <= 2025; N++) {
      const a = s.get(String(N)), b = s.get(String(N + 1));
      if (!a || !b) continue;
      if (a[key] && b[key]) h[0]++; else if (a[key]) h[1]++; else if (b[key]) h[2]++; else h[3]++;
    }
  }
  const [aa, an, na, nn] = h;
  const p1 = aa / Math.max(1, aa + an), p0 = na / Math.max(1, na + nn);
  const x2 = chi2x2(aa, an, na, nn);
  console.log(`  ${key === 'qb' ? 'QB-early' : 'Round-1 TE'} personal repeat: ${pct(p1)} after doing it vs ${pct(p0)} after not`
    + ` — lift ${(p1 / Math.max(1e-9, p0)).toFixed(1)}x, chi2 ${x2.toFixed(1)} (${sig(x2)})`);
}
console.log();

// ═══ 4. AUTODRAFT ═══
console.log('═══ 4. Autodrafting ═══');
let allPicks = 0, emptyBy = 0, hasTs = 0;
for (const lg of Object.values(leagues)) {
  const picks = picksFor(lg.draft_id);
  if (!picks) continue;
  for (const p of picks) {
    allPicks++;
    if (!p.picked_by) emptyBy++;
    if (p.created ?? p.ts ?? p.timestamp) hasTs++;
  }
}
console.log(`  picks ${allPicks}; empty picked_by ${emptyBy} (${pct(emptyBy / allPicks)}); with a timestamp ${hasTs}`);
console.log('  BLOCKED: no per-pick timestamp, and an empty picked_by is equally a');
console.log('  commissioner-executed pick. No clean label from the public API.\n');

// ═══ 5. MID-SEASON JOIN ═══
console.log('═══ 5. Joining a league mid-season ═══');
let same = 0, changed = 0;
for (const [lid, lg] of Object.entries(leagues)) {
  const picks = picksFor(lg.draft_id);
  const rf = path.join(CRAWL, `league_${lid}_rosters.json`);
  if (!picks || !fs.existsSync(rf)) continue;
  const rosters = JSON.parse(fs.readFileSync(rf, 'utf8')).data ?? [];
  const owner = new Map(rosters.map((r) => [r.roster_id, r.owner_id]));
  const drafter = new Map();
  for (const p of picks) {
    if (p.roster_id == null || !p.picked_by) continue;
    const c = drafter.get(p.roster_id) ?? drafter.set(p.roster_id, new Map()).get(p.roster_id);
    c.set(p.picked_by, (c.get(p.picked_by) ?? 0) + 1);
  }
  for (const [rid, c] of drafter) {
    const who = [...c.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const cur = owner.get(rid);
    if (cur == null) continue;
    if (cur === who) same++; else changed++;
  }
}
console.log(`  rosters joinable to a drafter and a current owner: ${same + changed}`);
console.log(`  changed hands after the draft: ${changed} (${pct(changed / (same + changed))})`);
console.log('  BLOCKED: exactly zero across the whole sample is not a behavioural');
console.log('  finding, it is picked_by being rewritten to the current owner.\n');

// ═══ 6-7. TRADING AND WAIVERS ═══
console.log('═══ 6. Trading and 7. Waiver activity — persistence is the ceiling ═══');
const agg = new Map();
for (const m of pop) {
  for (const r of m.rows ?? []) {
    const s = agg.get(m.managerId) ?? agg.set(m.managerId, new Map()).get(m.managerId);
    const a = s.get(r.season) ?? s.set(r.season, { tr: 0, w: 0, txn: 0, lg: 0 }).get(r.season);
    a.tr += r.tradeCount ?? 0; a.w += r.waiverCount ?? 0; a.txn += r.txnCount ?? 0; a.lg++;
  }
}
function corr(xs, ys) {
  const n = xs.length; if (n < 3) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return dx && dy ? num / Math.sqrt(dx * dy) : NaN;
}
for (const [name, key] of [['trades per league', 'tr'], ['waiver claims per league', 'w'], ['all transactions per league', 'txn']]) {
  const xs = [], ys = [];
  for (const s of agg.values()) {
    for (let N = 2021; N <= 2025; N++) {
      const a = s.get(String(N)), b = s.get(String(N + 1));
      if (!a || !b || !a.lg || !b.lg) continue;
      xs.push(a[key] / a.lg); ys.push(b[key] / b.lg);
    }
  }
  console.log(`  ${name.padEnd(30)} year-over-year r = ${corr(xs, ys).toFixed(3)}  (n=${xs.length})`);
}
const tm = [0, 0, 0, 0];
for (const s of agg.values()) {
  for (let N = 2021; N <= 2025; N++) {
    const a = s.get(String(N)), b = s.get(String(N + 1));
    if (!a || !b) continue;
    const pa = a.tr > 0, pb = b.tr > 0;
    if (pa && pb) tm[0]++; else if (pa) tm[1]++; else if (pb) tm[2]++; else tm[3]++;
  }
}
const p1 = tm[0] / Math.max(1, tm[0] + tm[1]), p0 = tm[2] / Math.max(1, tm[2] + tm[3]);
console.log(`  traded last year -> trades again ${pct(p1)}; did not -> ${pct(p0)}`
  + ` — lift ${(p1 / Math.max(1e-9, p0)).toFixed(1)}x, chi2 ${chi2x2(...tm).toFixed(1)} (${sig(chi2x2(...tm))})`);

console.log('\nSAMPLE CAVEAT: one seed portfolio\'s neighbourhood, so it skews to heavy');
console.log('users — 3,628 of 5,917 person-seasons hold 10+ leagues. Base rates for a');
console.log('representative Sleeper population will differ; the contrasts should survive.');
