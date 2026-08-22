/**
 * Lazy-loaded DuckDB-WASM singleton for the Data Query tab.
 *
 * Tables registered at init (all in-memory, backed by our existing JSON/CSV
 * sources in public/data):
 *
 *   career_2026     — 2026 prospect career predictions (flattened features)
 *   backtest        — historical rookie backtest rows (2010-2025, all pos)
 *   prospects       — 2026 draft-prospect composite scouting grades
 *   player_stats    — per-player per-week NFL stats (2010-2026) including
 *                     fantasy_points / fantasy_points_ppr
 *   adp_ffc                 — community PPR preseason ADP (per-season)
 *   adp_historical          — historical ADP used in training (2010-2025)
 *   dynasty_values          — current dynasty market values (1qb + superflex)
 *   dynasty_value_history   — daily dynasty value history (per player + date)
 *
 * Backwards-compat views `dynasty` and `ktc_history` mirror dynasty_values /
 * dynasty_value_history so user queries saved before the rename keep
 * working. Vendor-named feature columns (rsp*, pdf*) are renamed to
 * source-agnostic scout* / guide* aliases at registration time — see
 * FEATURE_RENAME below.
 *
 * Keep in lock-step with TABLE_DOCS below — the Data Query UI surfaces
 * that schema so users can discover columns.
 */
import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import prospectGrades from '../data/prospect-grades-2026.json';
import { normalizeName } from './featureTypes';
import { maybeGunzipStream } from '../data';

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
  team?: string;
  actualRound?: number;
  actualPick?: number;
}

/** Flatten a row by merging top-level scalars with features.*  into one row. */
function flattenFeatures<T extends { features?: Record<string, number> }>(
  row: T,
): Record<string, unknown> {
  const { features, ...rest } = row;
  return { ...rest, ...(features || {}) };
}

/** Vendor-named feature columns leak the upstream scouting source. The
 *  on-disk training files keep the original names (the model pipeline
 *  trains against them), but every public surface — python client, SQL
 *  tab, anywhere user-visible — renames them at read time so consumers
 *  see source-agnostic columns:
 *    rsp* (single-source scout grade)  -> scout*
 *    pdf* (multi-source draft guides)  -> guide*
 *  Mirrors python/src/stathead/_renames.py. Keep in sync. */
const FEATURE_RENAME: Record<string, string> = {
  // single-scout grade family
  rspAppearances: 'scoutAppearances',
  rspBreadthDraft: 'scoutBreadthDraft',
  rspBreadthLatest: 'scoutBreadthLatest',
  rspDotDelta: 'scoutGradeDelta',
  rspDotDraft: 'scoutGradeDraft',
  rspDotLatest: 'scoutGradeLatest',
  rspDotMax: 'scoutGradeMax',
  rspHasData: 'hasScoutGrade',
  rspNComps: 'scoutNComps',
  rspTierOrdinal: 'scoutTierOrdinal',
  // multi-source draft-guide aggregation
  pdfHasData: 'hasGuideData',
  pdfHasRank: 'hasGuideRank',
  pdfHasRound: 'hasGuideRound',
  pdfNRedFlags: 'guideNRedFlags',
  pdfNStrengths: 'guideNStrengths',
  pdfNWeaknesses: 'guideNWeaknesses',
  pdfProjectedRound: 'guideProjectedRound',
  pdfRankOverallMax: 'guideRankMax',
  pdfRankOverallMean: 'guideRankMean',
  pdfRankOverallMin: 'guideRankMin',
  pdfRankSpread: 'guideRankSpread',
  pdfRankXPick: 'guideRankXPick',
  pdfRoundXActual: 'guideRoundXActual',
  pdfSentimentNet: 'guideSentimentNet',
};

/** Derive scoutTierOrdinal from the DOT score when the tier ordinal is
 *  missing. The PDF-merged tier strings aren't always available in the
 *  training cache, so many rows have rspDotDraft populated but
 *  rspTierOrdinal stuck at 0. These DOT→tier boundaries mirror the
 *  _RSP_TIER_ORDINAL mapping in train_career_models.py. */
function deriveTierFromDot(dot: number): number {
  if (dot >= 95) return 10;
  if (dot >= 90) return 9;
  if (dot >= 85) return 8;
  if (dot >= 80) return 7;
  if (dot >= 75) return 6;
  if (dot >= 70) return 5;
  if (dot >= 65) return 4;
  if (dot >= 60) return 3;
  if (dot >= 55) return 2;
  if (dot > 0) return 1;
  return 0;
}

function renameVendorKeys(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[FEATURE_RENAME[k] ?? k] = v;
  }
  // Back-fill scoutTierOrdinal from DOT when the tier is missing/zero.
  if (!out.scoutTierOrdinal && typeof out.scoutGradeDraft === 'number' && out.scoutGradeDraft > 0) {
    out.scoutTierOrdinal = deriveTierFromDot(out.scoutGradeDraft as number);
  }
  return out;
}

/** Fetch + gunzip a .csv.gz source file, return the raw CSV bytes ready to
 *  register with DuckDB. Uses the browser-native DecompressionStream so we
 *  don't pull in a JS gzip library — via maybeGunzipStream, which skips the
 *  inflate on hosts that already decoded the body (Content-Encoding: gzip). */
async function fetchCsvGz(filename: string): Promise<Uint8Array | null> {
  try {
    const resp = await fetch(`${BASE}data/${filename}.gz`);
    if (!resp.ok || !resp.body) return null;
    const stream = await maybeGunzipStream(resp.body);
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
  // LEFT JOIN against player_crosswalk on gsis_id stamps the canonical
  // player_key onto every weekly row, so Ask mode / SQL tab queries can
  // JOIN USING (player_key) without a two-hop through crosswalk.
  await conn.query(`
    CREATE OR REPLACE TABLE player_stats AS
    WITH raw AS (
      ${loaded.join(' UNION ALL BY NAME ')}
    )
    SELECT raw.*, cw.player_key
    FROM raw
    LEFT JOIN player_crosswalk cw ON raw.player_id = cw.gsis_id
  `);
}

interface DynastyRow {
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

interface DynastyHistoryRow {
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
interface CrosswalkRec {
  player_key: string;
  display_name: string;
  position: string;
  birth_date?: string;
  college?: string;
  gsis_id?: string;
  pfr_id?: string;
  sleeper_id?: string;
  espn_id?: string;
  pff_id?: string;
  yahoo_id?: string;
  sportradar_id?: string;
  rotowire_id?: string;
  fantasy_data_id?: string;
  ktc_id?: number;
  is_college_only?: boolean;
  draft_class?: number;
  earliest_season?: number;
  latest_season?: number;
  aliases?: Array<{ source: string; name: string; position?: string; year?: number; via?: string }>;
}

async function buildTables(): Promise<Record<string, Record<string, unknown>[]>> {
  const [fm, cache, dynasty1qb, dynastyHistory, crosswalk] = await Promise.all([
    fetchJson<{ careerPredictions2026?: CareerPrediction2026[] }>('feature-matrix.json'),
    fetchJson<{ rookieCareerModels?: Record<string, { backtestRows?: CareerBacktestRow[] }> }>('model-cache-career-v72.json'),
    fetchJson<DynastyRow[]>('ktc_rankings_1qb.json'),
    fetchJson<DynastyHistoryRow[]>('ktc_history.json'),
    fetchJson<{ players?: CrosswalkRec[] }>('player-crosswalk.json'),
  ]);

  // Build (norm_name|position) → player_key index. Used to stamp the
  // canonical ID onto backtest + adp_historical rows at load time so
  // every DuckDB table can be joined on `player_key`.
  const keyByNamePos = new Map<string, string>();
  for (const rec of crosswalk?.players || []) {
    const primary = `${normalizeName(rec.display_name)}|${rec.position}`;
    if (!keyByNamePos.has(primary)) keyByNamePos.set(primary, rec.player_key);
    for (const a of rec.aliases || []) {
      const pos = a.position || rec.position;
      const k = `${normalizeName(a.name)}|${pos}`;
      if (!keyByNamePos.has(k)) keyByNamePos.set(k, rec.player_key);
    }
  }
  const stampKey = (name: string, position: string): string | undefined =>
    keyByNamePos.get(`${normalizeName(name)}|${position}`);

  const career_2026: Record<string, unknown>[] =
    (fm?.careerPredictions2026 || []).map((p) => {
      const flat = renameVendorKeys(flattenFeatures(p) as Record<string, unknown>);
      // feature-matrix.json already stamps player_key via precompute, but
      // safety-net if the file was built pre-crosswalk.
      if (!flat.player_key && p.name && p.position) {
        const k = stampKey(p.name, p.position);
        if (k) flat.player_key = k;
      }
      return flat;
    });

  const backtest: Record<string, unknown>[] = [];
  const rookieModels = cache?.rookieCareerModels || {};
  for (const [pos, model] of Object.entries(rookieModels)) {
    for (const r of model.backtestRows || []) {
      const flat = renameVendorKeys(
        flattenFeatures({ ...r, position: r.position || pos }) as Record<string, unknown>,
      );
      const pk = stampKey(r.name, r.position || pos);
      if (pk) flat.player_key = pk;
      backtest.push(flat);
    }
  }

  const prospects: Record<string, unknown>[] = Array.isArray(prospectGrades)
    ? (prospectGrades as ProspectGrade[]).map((g) => ({ ...g }))
    : [];

  // Dynasty values — current. The 1qb file carries both `value` (1QB) and
  // `superflexValue`, so one load gives us everything.
  const dynasty_values: Record<string, unknown>[] = (dynasty1qb || []).map((r) => ({
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

  // Dynasty value history — flatten {playerID, oneQB.valueHistory,
  // superflex.valueHistory} into one row per (playerID, date). Joining
  // 1QB + Superflex on the same date is a common query so we emit them
  // side-by-side.
  const dynasty_value_history: Record<string, unknown>[] = [];
  const dynastyNameById = new Map<number, { name: string; position: string; team: string }>();
  for (const r of dynasty1qb || []) {
    dynastyNameById.set(r.playerID, { name: r.playerName, position: r.position, team: r.team });
  }
  for (const h of dynastyHistory || []) {
    const info = dynastyNameById.get(h.playerID);
    const sfMap = new Map((h.superflex?.valueHistory || []).map((p) => [p.d, p.v]));
    const seenDates = new Set<string>();
    for (const p of h.oneQB?.valueHistory || []) {
      if (seenDates.has(p.d)) continue;
      seenDates.add(p.d);
      dynasty_value_history.push({
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

  // Historical ADP — from the feature store's profile shard (4507 rows,
  // 2010-2025, every season fully populated). This is the ADP we actually
  // use in training, already resolved + normalized across sources. Join
  // with players.json for position + display name.
  const adp_historical: Record<string, unknown>[] = [];
  const [profile, players] = await Promise.all([
    fetchJson<Record<string, {
      adp?: number; adpRound?: number;
      nflDraftPick?: number; nflDraftRound?: number;
      age?: number; yearsInLeague?: number;
    }>>('feature-store/profile.json'),
    fetchJson<Record<string, { position?: string; displayName?: string }>>('feature-store/players.json'),
  ]);
  for (const [key, rec] of Object.entries(profile || {})) {
    const [nameNorm, seasonStr] = key.split('::');
    if (!nameNorm || !seasonStr) continue;
    const info = players?.[key];
    const name = info?.displayName ?? nameNorm;
    const position = info?.position ?? null;
    adp_historical.push({
      season: Number(seasonStr),
      name,
      name_norm: nameNorm,
      position,
      player_key: position ? stampKey(name, position) ?? null : null,
      adp: rec.adp ?? null,
      adpRound: rec.adpRound ?? null,
      nflDraftPick: rec.nflDraftPick ?? null,
      nflDraftRound: rec.nflDraftRound ?? null,
      age: rec.age ?? null,
      yearsInLeague: rec.yearsInLeague ?? null,
    });
  }

  // Flatten the crosswalk into rows for querying. The `aliases` array is
  // dropped — it's useful for the builder, noisy in SQL output.
  const player_crosswalk: Record<string, unknown>[] = (crosswalk?.players || []).map((r) => {
    const { aliases: _aliases, ...rest } = r;
    void _aliases;
    return rest as Record<string, unknown>;
  });

  return {
    career_2026, backtest, prospects,
    dynasty_values, dynasty_value_history,
    adp_ffc, adp_historical, player_crosswalk,
  };
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
    // Ceiling on working-set memory so an accidental cartesian join
    // errors cleanly instead of crashing the tab. The outer-LIMIT
    // wrap in runQuery handles streaming shapes; this catches the
    // aggregation shapes (COUNT/SUM over a huge join) where the
    // optimizer can't push a LIMIT through the hash table.
    await conn.query("SET memory_limit='2GB'");
    const tables = await buildTables();
    await registerTables(db, conn, tables);
    // player_stats is loaded separately because it's CSV-sourced across
    // 16+ seasons (UNION ALL BY NAME). Run in parallel with other table
    // setup would be nice but registerFileBuffer is single-threaded.
    await registerPlayerStats(db, conn);
    // Backwards-compat aliases — `dynasty` / `ktc_history` were the legacy
    // table names. Saved user queries from before the rename keep working.
    if (tables.dynasty_values?.length) {
      await conn.query('CREATE OR REPLACE VIEW dynasty AS SELECT * FROM dynasty_values');
    }
    if (tables.dynasty_value_history?.length) {
      await conn.query('CREATE OR REPLACE VIEW ktc_history AS SELECT * FROM dynasty_value_history');
    }
    return { db, conn };
  })();
  return dbPromise;
}

// ── SQL heuristics for the safety wrap ──

/** Strip leading whitespace, -- line comments, and slash-star block
 *  comments from the front of the SQL. Used to peek at the first
 *  real token for the read-query heuristic. */
function stripLeadingCommentsAndWs(sql: string): string {
  let s = sql;
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, '');
    s = s.replace(/^--[^\n]*\n?/, '');
    s = s.replace(/^\/\*[\s\S]*?\*\//, '');
    if (s === before) return s;
  }
}

/** The read shapes that compose cleanly inside SELECT * FROM (...) _q. */
function looksLikeReadQuery(trimmed: string): boolean {
  const head = trimmed.slice(0, 10).toUpperCase();
  return (
    head.startsWith('SELECT') ||
    head.startsWith('WITH') ||
    head.startsWith('VALUES') ||
    head.startsWith('TABLE ') ||
    head.startsWith('PIVOT ') ||
    head.startsWith('UNPIVOT ')
  );
}

/** Check for a semicolon outside of strings and comments — a
 *  multi-statement query (e.g. "SET x=1; SELECT …;") can't be wrapped
 *  inside a subquery. */
function hasStatementSeparator(trimmed: string): boolean {
  const stripped = trimmed
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:''|[^'])*'/g, '')
    .replace(/"(?:""|[^"])*"/g, '');
  return /;/.test(stripped);
}

/** Return array-of-objects results for SQL display. When maxRows is
 *  set, SELECT/WITH/etc. queries are wrapped in an outer LIMIT
 *  maxRows+1 subquery so runaway cartesian joins abort early instead
 *  of crashing the tab. The +1 lets callers detect the truncation. */
export async function runQuery(
  sql: string,
  opts?: { maxRows?: number },
): Promise<{
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  elapsedMs: number;
  truncated: boolean;
}> {
  const { conn } = await getDuckDB();
  const maxRows = opts?.maxRows ?? 0;

  const trimmed = stripLeadingCommentsAndWs(sql).replace(/;\s*$/, '').trim();
  const canWrap =
    maxRows > 0 && !!trimmed && looksLikeReadQuery(trimmed) && !hasStatementSeparator(trimmed);
  const effectiveSql = canWrap
    ? `SELECT * FROM (${trimmed}) _q_capped LIMIT ${maxRows + 1}`
    : sql;

  const t0 = performance.now();
  const result = await conn.query(effectiveSql);
  const elapsedMs = performance.now() - t0;
  const columns = result.schema.fields.map((f) => f.name);
  let rows = result.toArray().map((r) => {
    const obj: Record<string, unknown> = {};
    for (const c of columns) {
      const v = r[c];
      // Convert BigInt + Arrow-specific types to JSON-friendly values.
      obj[c] = typeof v === 'bigint' ? Number(v) : v;
    }
    return obj;
  });
  let truncated = false;
  if (canWrap && rows.length > maxRows) {
    rows = rows.slice(0, maxRows);
    truncated = true;
  }
  return { columns, rows, rowCount: rows.length, elapsedMs, truncated };
}

/** Schema used by the Data Query UI sidebar. */
export const TABLE_DOCS: Array<{
  name: string;
  description: string;
  exampleColumns: string[];
}> = [
  {
    name: 'player_crosswalk',
    description:
      'Canonical player identity — one row per player with the IDs we use to join across tables. Every other table carries a `player_key` column that joins here. College-only rows (`is_college_only = true`) are pre-draft prospects; they get upgraded to the NFL ID once drafted.',
    exampleColumns: [
      'player_key', 'display_name', 'position', 'birth_date', 'college',
      'draft_class', 'earliest_season', 'latest_season', 'is_college_only',
    ],
  },
  {
    name: 'career_2026',
    description:
      '2026 draft-class career predictions (flattened features). One row per scored prospect. Joins to player_crosswalk via player_key.',
    exampleColumns: [
      'player_key', 'name', 'position', 'adp', 'predictedCareerPPG', 'percentile', 'modelTier',
      'boomProb', 'bustProb', 'boomZ', 'bustZ',
      'nflDraftPick', 'projRound', 'recruitRating', 'collegeUsageOverall',
      'collegeDominatorRating', 'collegeBreakoutScore', 'scoutGradeDraft', 'guideRankMean',
      'relativeAthleticScore', 'speedScore', 'forty', 'weight',
    ],
  },
  {
    name: 'backtest',
    description:
      'Historical rookie backtest rows (2010-2025) with predicted PPG and actual outcomes. Use for model evaluation / sweep analysis. Joins to player_crosswalk via player_key.',
    exampleColumns: [
      'player_key', 'name', 'position', 'draftSeason', 'predictedPPG', 'actualPPG',
      'percentile', 'modelTier', 'combinedScore',
      'nflDraftPick', 'nflDraftRound', 'recruitRating',
      'collegeUsageOverall', 'collegeTeamTalent', 'collegeDominatorRating',
    ],
  },
  {
    name: 'prospects',
    description:
      '2026 draft-prospect composite scouting grades + actual draft results. Use to join scout grades and the team/round/pick a rookie was actually drafted at onto career_2026 via name. `team`, `actualRound`, `actualPick` are populated for drafted players; null for UDFAs.',
    exampleColumns: ['name', 'pos', 'school', 'grade', 'projRound', 'projPick', 'tier', 'team', 'actualRound', 'actualPick'],
  },
  {
    name: 'player_stats',
    description:
      'Per-player per-week NFL stats (2010-2026). Includes fantasy_points + fantasy_points_ppr, and a canonical player_key stamped via the crosswalk — use player_key for clean joins. Schema drifted in 2025: use COALESCE(recent_team, team), COALESCE(interceptions, passing_interceptions), COALESCE(sacks, sacks_suffered) to normalize across years.',
    exampleColumns: [
      'player_key', 'player_id', 'player_name', 'position',
      'recent_team', 'team', 'season', 'week', 'season_type', 'opponent_team',
      'passing_yards', 'passing_tds', 'passing_epa',
      'rushing_yards', 'rushing_tds', 'carries',
      'receptions', 'targets', 'receiving_yards', 'receiving_tds',
      'fantasy_points', 'fantasy_points_ppr',
    ],
  },
  {
    name: 'adp_ffc',
    description:
      'Community PPR preseason ADP by season. Coverage depends on what has been fetched into the local cache.',
    exampleColumns: ['season', 'name', 'position', 'team', 'adp', 'high', 'low', 'stdev', 'timesDrafted', 'bye'],
  },
  {
    name: 'adp_historical',
    description:
      'Historical ADP used in model training, 2010-2025, every season fully populated (~280 players/year, 4500 rows total). Normalized across sources and joined to position + display name. Use this for any cross-year ADP analysis. Joins to player_crosswalk via player_key.',
    exampleColumns: ['player_key', 'season', 'name', 'position', 'adp', 'adpRound', 'nflDraftPick', 'nflDraftRound', 'age', 'yearsInLeague'],
  },
  {
    name: 'dynasty_values',
    description:
      'Current dynasty market values (1QB + Superflex both). value_1qb, value_superflex on 0-10000 scale. isRookie flags rookies. Aliased as `dynasty` for backwards compat.',
    exampleColumns: ['playerID', 'name', 'position', 'positionRank', 'team', 'age', 'value_1qb', 'value_superflex', 'isRookie'],
  },
  {
    name: 'dynasty_value_history',
    description:
      'Daily dynasty value history. One row per (playerID, date) with both 1QB and Superflex values. ~200 days × ~500 players ≈ 100k rows. Use for trend / momentum analysis. Aliased as `ktc_history` for backwards compat.',
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
    label: 'ADP vs actual fantasy (2010-2025, adp_historical)',
    sql: `SELECT a.name, a.season, a.position, a.adp, a.adpRound,
       ROUND(SUM(s.fantasy_points_ppr), 1) AS total_ppr,
       COUNT(*) FILTER (WHERE s.week IS NOT NULL) AS games,
       ROUND(SUM(s.fantasy_points_ppr) / NULLIF(COUNT(*), 0), 2) AS ppg
FROM adp_historical a
LEFT JOIN player_stats s
  ON lower(s.player_display_name) = lower(a.name)
  AND s.season = a.season
  AND s.season_type = 'REG'
WHERE a.adp <= 60 AND a.season >= 2015
GROUP BY a.name, a.season, a.position, a.adp, a.adpRound
ORDER BY a.season DESC, a.adp ASC
LIMIT 50;`,
  },
  {
    label: 'Biggest ADP busts by position (2015+)',
    sql: `SELECT a.position, a.name, a.season, a.adp,
       SUM(s.fantasy_points_ppr) AS total_ppr,
       COUNT(*) FILTER (WHERE s.week IS NOT NULL) AS games
FROM adp_historical a
JOIN player_stats s
  ON lower(s.player_display_name) = lower(a.name)
  AND s.season = a.season
  AND s.season_type = 'REG'
WHERE a.adp <= 36 AND a.season BETWEEN 2015 AND 2024
GROUP BY a.position, a.name, a.season, a.adp
HAVING SUM(s.fantasy_points_ppr) < 100
ORDER BY a.adp ASC
LIMIT 25;`,
  },
  {
    label: 'Top 25 dynasty values (1QB)',
    sql: `SELECT name, position, team, age, value_1qb, value_superflex, isRookie
FROM dynasty_values
ORDER BY value_1qb DESC
LIMIT 25;`,
  },
  {
    label: 'Biggest dynasty movers — last 30 days',
    sql: `WITH today AS (
  SELECT MAX(date) AS d FROM dynasty_value_history
),
month_ago AS (
  SELECT MAX(date) AS d FROM dynasty_value_history WHERE date <= (SELECT d FROM today) - INTERVAL 30 DAY
)
SELECT v_now.name, v_now.position, v_now.team,
       v_prev.value_1qb AS value_1qb_30d_ago,
       v_now.value_1qb AS value_1qb_today,
       v_now.value_1qb - v_prev.value_1qb AS delta
FROM dynasty_value_history v_now
JOIN dynasty_value_history v_prev
  ON v_prev.playerID = v_now.playerID
WHERE v_now.date = (SELECT d FROM today)
  AND v_prev.date = (SELECT d FROM month_ago)
  AND v_now.value_1qb > 3000
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
    label: 'Alpha rate by scout tier (backtest)',
    sql: `SELECT scoutTierOrdinal AS tier,
       COUNT(*) AS n,
       AVG(CASE WHEN modelTier = 1 THEN 1.0 ELSE 0 END) AS alpha_rate,
       AVG(actualPPG) AS avg_actual_ppg
FROM backtest
WHERE scoutTierOrdinal >= 7
GROUP BY scoutTierOrdinal
ORDER BY scoutTierOrdinal DESC;`,
  },
];
