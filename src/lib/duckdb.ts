/**
 * Lazy-loaded DuckDB-WASM singleton for the Data Query tab.
 *
 * Tables registered at init (all in-memory, backed by our existing JSON/CSV
 * sources in public/data):
 *
 *   career_2026     — 2026 prospect career predictions (flattened features)
 *   backtest        — historical rookie backtest rows (2010-2025, all pos)
 *   prospects       — 2026 draft-prospect grades / scouting scores
 *
 * Keep in lock-step with tableSchemas() below — the Data Query UI surfaces
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

/** Build the three base tables as plain JS objects, ready to be loaded into
 *  DuckDB via insertJSONFromPath / registerFileBuffer + read_json. */
async function buildTables(): Promise<Record<string, Record<string, unknown>[]>> {
  const [fmResp, cacheResp] = await Promise.all([
    fetch(`${BASE}data/feature-matrix.json`),
    fetch(`${BASE}data/model-cache-career-v72.json`),
  ]);
  const fm = await fmResp.json();
  const cache = await cacheResp.json();

  const career_2026: Record<string, unknown>[] =
    (fm.careerPredictions2026 as CareerPrediction2026[] | undefined || []).map(flattenFeatures);

  const backtest: Record<string, unknown>[] = [];
  const rookieModels = (cache.rookieCareerModels || {}) as Record<string, { backtestRows?: CareerBacktestRow[] }>;
  for (const [pos, model] of Object.entries(rookieModels)) {
    for (const r of model.backtestRows || []) {
      backtest.push(flattenFeatures({ ...r, position: r.position || pos }));
    }
  }

  const prospects: Record<string, unknown>[] = Array.isArray(prospectGrades)
    ? (prospectGrades as ProspectGrade[]).map((g) => ({ ...g }))
    : [];

  return { career_2026, backtest, prospects };
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
    label: 'WR tier accuracy by draft round',
    sql: `SELECT nflDraftRound,
       COUNT(*) AS n,
       AVG(actualPPG) AS avg_actual_ppg,
       AVG(predictedPPG) AS avg_pred_ppg
FROM backtest
WHERE position = 'WR' AND nflDraftRound BETWEEN 1 AND 4
GROUP BY nflDraftRound
ORDER BY nflDraftRound;`,
  },
  {
    label: '2026 RBs with missing college usage',
    sql: `SELECT name, adp, predictedCareerPPG, percentile,
       collegeUsageOverall, collegeTeamTalent, recruitRating
FROM career_2026
WHERE position = 'RB' AND (collegeUsageOverall IS NULL OR collegeUsageOverall = 0)
ORDER BY predictedCareerPPG DESC;`,
  },
  {
    label: 'Alpha rate by RSP Tier I-III (backtest)',
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
