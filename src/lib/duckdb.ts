/**
 * Lazy-loaded DuckDB-WASM singleton for the Data Query tab.
 *
 * Tables registered at init (all in-memory, backed by our existing JSON/CSV
 * sources in public/data):
 *
 *   career_2026     — 2026 prospect career predictions (flattened features)
 *   backtest        — historical rookie backtest rows (2010-2025, all pos)
 *   prospects       — 2026 draft-prospect scouting grades
 *   player_stats    — per-player per-week NFL stats (2010-2026) including
 *                     fantasy_points / fantasy_points_ppr — from nflverse
 *   adp_ffc         — FFC PPR preseason ADP (per-season)
 *   ktc             — current KTC dynasty values (both 1qb + superflex)
 *   ktc_history     — daily KTC value history (flattened per player + date)
 *
 * Keep in lock-step with TABLE_DOCS below — the Data Query UI surfaces
 * that schema so users can discover columns.
 */
import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import prospectGrades from '../data/prospect-grades-2026.json';

let dbPromise: Promise<{ db: AsyncDuckDB; conn: AsyncDuckDBConnection }> | null = null;

const BASE = typeof document !== 'undefined' ? import.meta.env.BASE_URL : '';

interface CareerBacktestRow {
  name: string;
  position?: string;
  draftSeason?: number;
  predictedPPG?: number;
  actualPPG?: number;
  percentile?: number;
  modelTier?: number;
  combinedScore?: number;
  features?: Record<string, number>;
}

interface CareerPrediction2026 {
  name: string;
  position: string;
  team?: string;
  adp?: number;
  predictedCareerPPG?: number;
  percentile?: number;
  modelTier?: number;
  combinedScore?: number;
  boomProb?: number;
  bustProb?: number;
  boomZ?: number;
  bustZ?: number;
  features?: Record<string, number>;
}

interface ProspectGrade {
  name: string;
  pos: string;
  school: string;
  grade: number;
  projRound: number;
  projPick: number;
  tier: string;
}

/** Flatten a row by merging top-level scalars with features.*  into one row. */
function flattenFeatures<T extends { features?: Record<string, number> }>(
  row: T,
): Record<string, unknown> {
  const { features, ...rest } = row;
  return { ...rest, ...(features || {}) };
}

/** Fetch + gunzip a .csv.gz source file, return the raw CSV bytes ready to
 *  register with DuckDB. Uses the browser-native DecompressionStream so we
 *  don't pull in a JS gzip library. */
async function fetchCsvGz(filename: string): Promise<Uint8Array | null> {
  try {
    const resp = await fetch(`${BASE}data/${filename}.gz`);
    if (!resp.ok || !resp.body) return null;
    const ds = new DecompressionStream('gzip');
    const stream = resp.body.pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** Fetch + parse a committed JSON file; returns null on failure so missing
 *  data (e.g. sandbox-unreachable FFC years) doesn't crash init. */
async function fetchJson<T>(filename: string): Promise<T | null> {
  try {
    const resp = await fetch(`${BASE}data/${filename}`);
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

/** Load NFL player_stats for every season 2010-2026 into a single
 *  `player_stats` table via UNION ALL BY NAME. Schema drifted between
 *  2024 and 2025 (recent_team → team, interceptions → passing_interceptions,
 *  sacks → sacks_suffered); UNION BY NAME handles that by keeping both
 *  column names side-by-side. Users coalesce as needed. */
async function registerPlayerStats(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
): Promise<void> {
  const seasons = [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018,
                   2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
  const loaded: string[] = [];
  await Promise.all(seasons.map(async (s) => {
    const buf = await fetchCsvGz(`player_stats_${s}.csv`);
    if (!buf || buf.byteLength === 0) return;
    const name = `player_stats_${s}.csv`;
    await db.registerFileBuffer(name, buf);
    loaded.push(`SELECT * FROM read_csv_auto('${name}', header=true, ignore_errors=true)`);
  }));
  if (loaded.length === 0) return;
  await conn.query(
    `CREATE OR REPLACE TABLE player_stats AS ${loaded.join(' UNION ALL BY NAME ')}`,
  );
}

interface KtcRow {
  playerID: number;
  playerName: string;
  position: string;
  positionRank: number;
  team: string;
  age: number;
  value: number;
  superflexValue: number;
  isRookie: boolean;
}

interface KtcHistoryRow {
  playerID: number;
  oneQB?: { valueHistory?: Array<{ d: string; v: number }> };
  superflex?: { valueHistory?: Array<{ d: string; v: number }> };
}

interface FfcPlayer {
  name: string; position: string; team: string;
  adp: number; high: number; low: number; stdev: number;
  timesDrafted: number; bye: number;
}

/** Build every row-shaped table as plain JS — loaded via registerFileBuffer
 *  + read_json_auto. player_stats is loaded separately (CSV path) inside
 *  registerPlayerStats. */
async function buildTables(): Promise<Record<string, Record<string, unknown>[]>> {
  const [fm, cache, ktc1qb, ktcHistory] = await Promise.all([
    fetchJson<{ careerPredictions2026?: CareerPrediction2026[] }>('feature-matrix.json'),
    fetchJson<{ rookieCareerModels?: Record<string, { backtestRows?: CareerBacktestRow[] }> }>('model-cache-career-v72.json'),
    fetchJson<KtcRow[]>('ktc_rankings_1qb.json'),
    fetchJson<KtcHistoryRow[]>('ktc_history.json'),
  ]);

  const career_2026: Record<string, unknown>[] =
    (fm?.careerPredictions2026 || []).map(flattenFeatures);

  const backtest: Record<string, unknown>[] = [];
  const rookieModels = cache?.rookieCareerModels || {};
  for (const [pos, model] of Object.entries(rookieModels)) {
    for (const r of model.backtestRows || []) {
      backtest.push(flattenFeatures({ ...r, position: r.position || pos }));
    }
  }

  const prospects: Record<string, unknown>[] = Array.isArray(prospectGrades)
    ? (prospectGrades as ProspectGrade[]).map((g) => ({ ...g }))
    : [];

  // KTC — current values. The 1qb file carries both `value` (1QB) and
  // `superflexValue`, so one load gives us everything.
  const ktc: Record<string, unknown>[] = (ktc1qb || []).map((r) => ({
    playerID: r.playerID,
    name: r.playerName,
    position: r.position,
    positionRank: r.positionRank,
    team: r.team,
    age: r.age,
    value_1qb: r.value,
    value_superflex: r.superflexValue,
    isRookie: r.isRookie,
  }));

  // KTC history — flatten {playerID, oneQB.valueHistory, superflex.valueHistory}
  // into one row per (playerID, date). Joining 1QB + Superflex on the
  // same date is a common query so we emit them side-by-side.
  const ktc_history: Record<string, unknown>[] = [];
  const ktcNameById = new Map<number, { name: string; position: string; team: string }>();
  for (const r of ktc1qb || []) {
    ktcNameById.set(r.playerID, { name: r.playerName, position: r.position, team: r.team });
  }
  for (const h of ktcHistory || []) {
    const info = ktcNameById.get(h.playerID);
    const sfMap = new Map((h.superflex?.valueHistory || []).map((p) => [p.d, p.v]));
    for (const p of h.oneQB?.valueHistory || []) {
      ktc_history.push({
        playerID: h.playerID,
        name: info?.name ?? null,
        position: info?.position ?? null,
        team: info?.team ?? null,
        date: p.d,
        value_1qb: p.v,
        value_superflex: sfMap.get(p.d) ?? null,
      });
    }
  }

  // ADP — FFC PPR. One row per (season, player). Load every ffc_adp_ppr_*
  // file we can find; committed coverage is currently thin (only 2025 in
  // the sandbox), but the table schema is future-proof for when more
  // years land via `bash scripts/pull-all-data-sources.sh`.
  const adp_ffc: Record<string, unknown>[] = [];
  await Promise.all(
    [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026].map(async (season) => {
      const d = await fetchJson<{ players?: FfcPlayer[] }>(`ffc_adp_ppr_${season}.json`);
      for (const p of d?.players || []) adp_ffc.push({ season, ...p });
    }),
  );

  return { career_2026, backtest, prospects, ktc, ktc_history, adp_ffc };
}

/** CREATE TABLE statements + INSERT via read_json. Loaded as JS arrays, so
 *  we pass them through registerFileText + read_json(..., auto_detect=true). */
async function registerTables(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  tables: Record<string, Record<string, unknown>[]>,
): Promise<void> {
  for (const [name, rows] of Object.entries(tables)) {
    if (!rows.length) continue;
    const json = JSON.stringify(rows);
    const blob = new TextEncoder().encode(json);
    await db.registerFileBuffer(`${name}.json`, blob);
    await conn.query(
      `CREATE OR REPLACE TABLE ${name} AS SELECT * FROM read_json_auto('${name}.json', maximum_object_size=67108864)`,
    );
  }
}

export async function getDuckDB(): Promise<{ db: AsyncDuckDB; conn: AsyncDuckDBConnection }> {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const duckdb = await import('@duckdb/duckdb-wasm');
    const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);
    const worker_url = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }),
    );
    const worker = new Worker(worker_url);
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(worker_url);
    const conn = await db.connect();
    const tables = await buildTables();
    await registerTables(db, conn, tables);
    // player_stats is loaded separately because it's CSV-sourced across
    // 16+ seasons (UNION ALL BY NAME). Run in parallel with other table
    // setup would be nice but registerFileBuffer is single-threaded.
    await registerPlayerStats(db, conn);
    return { db, conn };
  })();
  return dbPromise;
}

/** Return array-of-objects results for SQL display. Closes the statement. */
export async function runQuery(sql: string): Promise<{
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  elapsedMs: number;
}> {
  const { conn } = await getDuckDB();
  const t0 = performance.now();
  const result = await conn.query(sql);
  const elapsedMs = performance.now() - t0;
  const columns = result.schema.fields.map((f) => f.name);
  const rows = result.toArray().map((r) => {
    const obj: Record<string, unknown> = {};
    for (const c of columns) {
      const v = r[c];
      // Convert BigInt + Arrow-specific types to JSON-friendly values.
      obj[c] = typeof v === 'bigint' ? Number(v) : v;
    }
    return obj;
  });
  return { columns, rows, rowCount: rows.length, elapsedMs };
}

/** Schema used by the Data Query UI sidebar. */
export const TABLE_DOCS: Array<{
  name: string;
  description: string;
  exampleColumns: string[];
}> = [
  {
    name: 'career_2026',
    description:
      '2026 draft-class career predictions (flattened features). One row per scored prospect.',
    exampleColumns: [
      'name', 'position', 'adp', 'predictedCareerPPG', 'percentile', 'modelTier',
      'boomProb', 'bustProb', 'boomZ', 'bustZ',
      'nflDraftPick', 'projRound', 'recruitRating', 'collegeUsageOverall',
      'collegeDominatorRating', 'collegeBreakoutScore', 'rspDotDraft', 'pdfRankOverallMean',
      'relativeAthleticScore', 'speedScore', 'forty', 'weight',
    ],
  },
  {
    name: 'backtest',
    description:
      'Historical rookie backtest rows (2010-2025) with predicted PPG and actual outcomes. Use for model evaluation / sweep analysis.',
    exampleColumns: [
      'name', 'position', 'draftSeason', 'predictedPPG', 'actualPPG',
      'percentile', 'modelTier', 'combinedScore',
      'nflDraftPick', 'nflDraftRound', 'recruitRating',
      'collegeUsageOverall', 'collegeTeamTalent', 'collegeDominatorRating',
    ],
  },
  {
    name: 'prospects',
    description:
      '2026 draft-prospect scouting grades (NFL.com / PFN composite). Use to join scouting grades onto career_2026 via name.',
    exampleColumns: ['name', 'pos', 'school', 'grade', 'projRound', 'projPick', 'tier'],
  },
  {
    name: 'player_stats',
    description:
      'Per-player per-week NFL stats from nflverse (2010-2026). Includes fantasy_points + fantasy_points_ppr. Schema drifted in 2025 — use COALESCE(recent_team, team), COALESCE(interceptions, passing_interceptions), COALESCE(sacks, sacks_suffered) to normalize across years.',
    exampleColumns: [
      'player_id', 'player_name', 'position', 'recent_team', 'team', 'season', 'week',
      'season_type', 'opponent_team',
      'passing_yards', 'passing_tds', 'passing_epa',
      'rushing_yards', 'rushing_tds', 'carries',
      'receptions', 'targets', 'receiving_yards', 'receiving_tds',
      'fantasy_points', 'fantasy_points_ppr',
    ],
  },
  {
    name: 'adp_ffc',
    description:
      'FFC PPR preseason ADP by season. One row per (season, player). Coverage depends on what has been fetched — run scripts/pull-all-data-sources.sh to refresh.',
    exampleColumns: ['season', 'name', 'position', 'team', 'adp', 'high', 'low', 'stdev', 'timesDrafted', 'bye'],
  },
  {
    name: 'ktc',
    description:
      'Current KeepTradeCut dynasty values (1QB + Superflex both). value_1qb, value_superflex on 0-10000 scale. isRookie flags rookies.',
    exampleColumns: ['playerID', 'name', 'position', 'positionRank', 'team', 'age', 'value_1qb', 'value_superflex', 'isRookie'],
  },
  {
    name: 'ktc_history',
    description:
      'Daily KTC value history. One row per (playerID, date) with both 1QB and Superflex values. ~200 days × ~500 players ≈ 100k rows. Use for trend / momentum analysis.',
    exampleColumns: ['playerID', 'name', 'position', 'team', 'date', 'value_1qb', 'value_superflex'],
  },
];

export const EXAMPLE_QUERIES: Array<{ label: string; sql: string }> = [
  {
    label: 'Top 10 2026 WRs by percentile',
    sql: `SELECT name, adp, predictedCareerPPG, percentile, modelTier
FROM career_2026
WHERE position = 'WR'
ORDER BY percentile DESC, predictedCareerPPG DESC
LIMIT 10;`,
  },
  {
    label: 'Biggest backtest misses (model under-predicted)',
    sql: `SELECT name, position, draftSeason, nflDraftPick,
       predictedPPG, actualPPG,
       actualPPG - predictedPPG AS delta
FROM backtest
WHERE actualPPG > 0
ORDER BY delta DESC
LIMIT 15;`,
  },
  {
    label: 'Top WR fantasy seasons (PPR) since 2020',
    sql: `SELECT player_name, season, position,
       SUM(fantasy_points_ppr) AS total_ppr,
       COUNT(*) AS games,
       SUM(fantasy_points_ppr) / NULLIF(COUNT(*), 0) AS ppg
FROM player_stats
WHERE position = 'WR' AND season >= 2020 AND season_type = 'REG'
GROUP BY player_name, season, position
HAVING COUNT(*) >= 10
ORDER BY total_ppr DESC
LIMIT 20;`,
  },
  {
    label: "Weekly PPR for Ja'Marr Chase",
    sql: `SELECT season, week, opponent_team,
       receptions, targets, receiving_yards, receiving_tds,
       fantasy_points_ppr
FROM player_stats
WHERE player_display_name ILIKE '%chase%'
  AND position = 'WR'
  AND season_type = 'REG'
ORDER BY season DESC, week DESC
LIMIT 40;`,
  },
  {
    label: 'ADP vs actual fantasy — is ADP sharp?',
    sql: `SELECT a.name, a.season, a.position, a.adp,
       SUM(s.fantasy_points_ppr) AS total_ppr,
       COUNT(*) FILTER (WHERE s.week IS NOT NULL) AS games
FROM adp_ffc a
LEFT JOIN player_stats s
  ON lower(s.player_display_name) = lower(a.name)
  AND s.season = a.season
  AND s.season_type = 'REG'
WHERE a.adp <= 60 AND a.season >= 2020
GROUP BY a.name, a.season, a.position, a.adp
ORDER BY a.season DESC, a.adp ASC
LIMIT 50;`,
  },
  {
    label: 'Top 25 dynasty values (1QB)',
    sql: `SELECT name, position, team, age, value_1qb, value_superflex, isRookie
FROM ktc
ORDER BY value_1qb DESC
LIMIT 25;`,
  },
  {
    label: 'Biggest KTC movers — last 30 days',
    sql: `WITH today AS (
  SELECT MAX(date) AS d FROM ktc_history
),
month_ago AS (
  SELECT MAX(date) AS d FROM ktc_history WHERE date <= (SELECT d FROM today) - INTERVAL 30 DAY
)
SELECT k_now.name, k_now.position, k_now.team,
       k_prev.value_1qb AS value_1qb_30d_ago,
       k_now.value_1qb AS value_1qb_today,
       k_now.value_1qb - k_prev.value_1qb AS delta
FROM ktc_history k_now
JOIN ktc_history k_prev
  ON k_prev.playerID = k_now.playerID
WHERE k_now.date = (SELECT d FROM today)
  AND k_prev.date = (SELECT d FROM month_ago)
  AND k_now.value_1qb > 3000
ORDER BY delta DESC
LIMIT 20;`,
  },
  {
    label: 'Rookies in career_2026 joined to scout grades',
    sql: `SELECT c.name, c.position, c.adp,
       c.predictedCareerPPG, c.percentile, c.modelTier,
       p.grade AS scout_grade, p.school, p.projRound
FROM career_2026 c
LEFT JOIN prospects p ON lower(p.name) = lower(c.name) AND p.pos = c.position
WHERE c.percentile >= 80
ORDER BY c.percentile DESC;`,
  },
  {
    label: 'Alpha rate by RSP Tier (backtest)',
    sql: `SELECT rspTierOrdinal AS tier,
       COUNT(*) AS n,
       AVG(CASE WHEN modelTier = 1 THEN 1.0 ELSE 0 END) AS alpha_rate,
       AVG(actualPPG) AS avg_actual_ppg
FROM backtest
WHERE rspTierOrdinal >= 7
GROUP BY rspTierOrdinal
ORDER BY rspTierOrdinal DESC;`,
  },
];
