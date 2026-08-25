// League lineages — collapsing Sleeper's per-season league ids into one stable
// identity per league.
//
// Sleeper mints a NEW league_id every season and links seasons through
// `previous_league_id`. So a naive set-diff of league ids across seasons reports
// 100% churn every year, which makes any retention/tenure label pure noise.
//
// Why union-find rather than following pointers back from each league:
// two managers who joined the same league in different years have different
// chain roots (each can only see the seasons they were in), so pointer-chasing
// gives them different keys for the same league. Union-find merges any two
// chains that share a single league id, so both land in the same component.
//
// ⚠️ Lineage ids are canonical only within one observation window. The
// representative is the earliest OBSERVED season's league id, so a crawl that
// reaches further back can pick a different representative for the same
// league. Persist the mapping; don't recompute it ad hoc and expect stability.
//
// See docs/sleeper-engagement-model.md.

export interface LeagueSeasonRef {
  leagueId: string;
  previousLeagueId?: string | null;
  season: string;
  name?: string;
}

export interface LeagueLineage {
  lineageId: string;
  name: string;                 // most recent observed name
  seasons: LeagueSeasonRef[];   // ascending by season
  firstSeason: string;
  lastSeason: string;
  tenureSeasons: number;        // distinct seasons observed in this window
}

export interface LineageIndex {
  byLeagueId: Map<string, string>;          // league_id → lineageId
  lineages: Map<string, LeagueLineage>;     // lineageId → lineage
}

// Sleeper writes an absent previous league as null, "" or "0" depending on age
// of the league. All three mean "no prior season".
function hasPrev(id: string | null | undefined): id is string {
  return !!id && id !== '0';
}

const seasonNum = (s: string) => Number(s) || 0;

class UnionFind {
  private parent = new Map<string, string>();

  find(x: string): string {
    let root = this.parent.get(x);
    if (root === undefined) { this.parent.set(x, x); return x; }
    while (root !== x) { x = root; root = this.parent.get(x)!; }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

// Group league-season observations into lineages.
//
// Unobserved `previousLeagueId` targets take part in the unioning (they glue
// two managers' partial chains together) but never become the representative
// and never appear in `seasons` — we know nothing about them beyond the id.
export function resolveLineages(refs: LeagueSeasonRef[]): LineageIndex {
  const uf = new UnionFind();
  for (const r of refs) {
    uf.find(r.leagueId);
    if (hasPrev(r.previousLeagueId)) uf.union(r.leagueId, r.previousLeagueId);
  }

  // Bucket observations by component root, de-duplicating repeated ids (the
  // same league-season shows up once per manager on a multi-user crawl).
  const byRoot = new Map<string, Map<string, LeagueSeasonRef>>();
  for (const r of refs) {
    const root = uf.find(r.leagueId);
    let bucket = byRoot.get(root);
    if (!bucket) { bucket = new Map(); byRoot.set(root, bucket); }
    const existing = bucket.get(r.leagueId);
    // Prefer the observation that carries a name / prior-season link.
    if (!existing || (!existing.name && r.name) || (!hasPrev(existing.previousLeagueId) && hasPrev(r.previousLeagueId))) {
      bucket.set(r.leagueId, r);
    }
  }

  const byLeagueId = new Map<string, string>();
  const lineages = new Map<string, LeagueLineage>();

  for (const bucket of byRoot.values()) {
    const seasons = [...bucket.values()].sort(
      (a, b) => seasonNum(a.season) - seasonNum(b.season) || a.leagueId.localeCompare(b.leagueId),
    );
    if (!seasons.length) continue;

    const lineageId = seasons[0].leagueId;
    const distinct = new Set(seasons.map((s) => s.season));
    const named = [...seasons].reverse().find((s) => s.name);

    for (const s of seasons) byLeagueId.set(s.leagueId, lineageId);
    lineages.set(lineageId, {
      lineageId,
      name: named?.name ?? '',
      seasons,
      firstSeason: seasons[0].season,
      lastSeason: seasons[seasons.length - 1].season,
      tenureSeasons: distinct.size,
    });
  }

  return { byLeagueId, lineages };
}

export function lineageIdFor(index: LineageIndex, leagueId: string): string | undefined {
  return index.byLeagueId.get(leagueId);
}

// ── Retention labels (target 2: league exit) ──

export interface RetentionEvent {
  lineageId: string;
  season: string;
  leagueId: string;
  // Did this manager field a team in the same lineage the following season?
  // null = right-censored: `season` is the newest in the observation window, so
  // the answer isn't knowable yet.
  returnedNextSeason: boolean | null;
  // True when NO observation of this lineage exists for season+1. On a
  // single-manager dataset this is identical to their own exit; only on a
  // multi-manager crawl does it separate "I quit" from "the league folded",
  // which is the confound the exit model has to exclude.
  lineageAbsentNextSeason: boolean;
}

// Per-season retention rows for one manager's league-seasons.
//
// `population` is every league-season observed across all managers, used only
// to tell a league death apart from an individual exit. Pass the manager's own
// refs when no wider crawl exists (and expect lineageAbsentNextSeason to be
// uninformative, per the note above).
export function retentionEvents(
  managerRefs: LeagueSeasonRef[],
  population: LeagueSeasonRef[] = managerRefs,
): RetentionEvent[] {
  const index = resolveLineages([...population, ...managerRefs]);

  const mineByLineage = new Map<string, Set<number>>();
  for (const r of managerRefs) {
    const lin = index.byLeagueId.get(r.leagueId);
    if (!lin) continue;
    if (!mineByLineage.has(lin)) mineByLineage.set(lin, new Set());
    mineByLineage.get(lin)!.add(seasonNum(r.season));
  }

  const anyByLineage = new Map<string, Set<number>>();
  for (const r of population) {
    const lin = index.byLeagueId.get(r.leagueId);
    if (!lin) continue;
    if (!anyByLineage.has(lin)) anyByLineage.set(lin, new Set());
    anyByLineage.get(lin)!.add(seasonNum(r.season));
  }

  // The newest season anywhere in the window bounds what we can label.
  const latest = Math.max(0, ...population.concat(managerRefs).map((r) => seasonNum(r.season)));

  const events: RetentionEvent[] = [];
  const seen = new Set<string>();
  for (const r of managerRefs) {
    const lineageId = index.byLeagueId.get(r.leagueId);
    if (!lineageId) continue;
    const key = `${lineageId}:${r.season}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const yr = seasonNum(r.season);
    const next = yr + 1;
    events.push({
      lineageId,
      season: r.season,
      leagueId: r.leagueId,
      returnedNextSeason: next > latest ? null : (mineByLineage.get(lineageId)?.has(next) ?? false),
      lineageAbsentNextSeason: !(anyByLineage.get(lineageId)?.has(next) ?? false),
    });
  }

  return events.sort((a, b) => seasonNum(a.season) - seasonNum(b.season) || a.lineageId.localeCompare(b.lineageId));
}
