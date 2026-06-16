import { useState, useEffect, useMemo, useCallback } from 'react';
import type { CombineResult, FantasyRanking, DynastyPlayer, SortDirection } from '../types';
import { fetchCombine, fetchFantasyRankings, fetchDynastyRankingsForDisplay } from '../data';
import { loadCareerScores } from '../lib/modelScoreClient';
import type { CareerScore } from '../lib/modelScoreStore';
import { PlayerCard } from './PlayerCard';
import { PlayerName } from './PlayerName';
import { ModelCardButton } from './ModelCardButton';
import prospectGrades from '../data/prospect-grades-2026.json';
import { canonicalizePlayerName } from '../lib/combineNameAliases';
import { normalizeNameUnicode as normalizeName } from '../lib/nameMatch';
import { DocsLink } from './DocsLink';

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

interface ProspectRow {
  name: string;
  pos: string;
  school: string;
  // Prospect grade (big board)
  grade: number;
  projRound: number;
  projPick: number;
  tier: string;
  // Actual NFL draft results (post-draft). Empty/0 for UDFAs.
  team: string;
  actualRound: number;
  actualPick: number;
  // Combine measurables
  ht: string;
  wt: number;
  forty: number;
  bench: number;
  vertical: number;
  broadJump: number;
  cone: number;
  shuttle: number;
  // FantasyPros rookie ranking
  rookieEcr: number;
  rookieBest: number;
  rookieWorst: number;
  owned: number;
  // Dynasty
  dynastyValue: number;
  superflexValue: number;
  // Career model prediction
  predictedCareerPPG: number;
  // Threshold probabilities: P(best 2-of-3 PPG >= threshold)
  thresholdProbs: Record<number, number>;
  // Combined score, percentile, and tier
  combinedScore: number;
  percentile: number;
  modelTier: number;
  boomProb: number;
  bustProb: number;
  boomZ?: number;
  bustZ?: number;
  careerFeatures?: Record<string, number>;
}

type SortField = keyof ProspectRow;

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'];
const FANTASY_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);
const DRAFT_YEAR = 2026;


/**
 * TE Premium adjustment to predicted PPG. Returns the bonus to add on top
 * of standard PPR PPG. Non-TE positions get zero.
 *
 * Derivation: in 2025, NFL TEs with ≥8 games + receptions averaged 0.38
 * receptions per PPR PPG in the 10–14 PPG band (where most fantasy-
 * relevant rookie TEs project). TEP +0.5 adds 0.5 × rec_per_game per
 * game, TEP +1.0 adds 1.0. The bonus thus equals
 * predictedPPG × 0.38 × bonusPerRec.
 */
const TE_REC_PER_PPG = 0.38;
function tepBonus(pos: string, ppg: number, mode: 'std' | 'half' | 'full'): number {
  if (mode === 'std' || pos !== 'TE' || !ppg || ppg <= 0) return 0;
  const bonusPerRec = mode === 'half' ? 0.5 : 1.0;
  return ppg * TE_REC_PER_PPG * bonusPerRec;
}

/**
 * TEP-equivalent PPG threshold for a given position. A TE who hit ≥8 PPR
 * PPG also hit ≥8 × (1 + 0.38 × bonusPerRec) in TEP scoring because the
 * bonus scales proportionally with their PPR PPG. So `thresholdProbs[8]`
 * answers the same question, just with a higher displayed cutoff. Only
 * TE thresholds shift; RB/WR/QB are unchanged.
 */
function effectiveThreshold(pos: string, t: number, mode: 'std' | 'half' | 'full'): number {
  if (mode === 'std' || pos !== 'TE') return t;
  const bonusPerRec = mode === 'half' ? 0.5 : 1.0;
  return t * (1 + TE_REC_PER_PPG * bonusPerRec);
}

function fmtThreshold(t: number): string {
  return Number.isInteger(t) ? String(t) : t.toFixed(1);
}

function valueColor(value: number): string {
  if (value >= 7000) return '#22c55e';
  if (value >= 5000) return '#4ade80';
  if (value >= 3000) return '#a3e635';
  if (value >= 1500) return '#facc15';
  if (value >= 500) return '#fb923c';
  return 'var(--text-muted)';
}

function ecrTierColor(ecr: number): string {
  if (ecr <= 5) return '#22c55e';
  if (ecr <= 12) return '#4ade80';
  if (ecr <= 24) return '#a3e635';
  if (ecr <= 48) return '#facc15';
  if (ecr <= 80) return '#fb923c';
  return 'var(--text-muted)';
}

function fmtMeasurable(v: number | null | undefined): string {
  return v != null && !isNaN(v) && v > 0 ? v.toFixed(2) : '-';
}

function inchesToHt(inches: number | undefined | null): string {
  if (!inches || inches <= 0) return '';
  const ft = Math.floor(inches / 12);
  const inn = Math.round(inches - ft * 12);
  return `${ft}-${inn}`;
}

/**
 * Returns the careerFeatures-derived value for `key` only when the model
 * stamped a real-data flag (hasPhysicalData / hasCombineData). Without the
 * flag, the feature might be a position-mean default and surfacing it would
 * mislead users into thinking the prospect was tested when they weren't.
 */
function realFeature(
  features: Record<string, number> | undefined,
  key: string,
  flag: 'hasPhysicalData' | 'hasCombineData',
): number {
  if (!features) return 0;
  return features[flag] === 1 ? (features[key] || 0) : 0;
}


export function RookieProspectsView({ onDataLoaded }: { onDataLoaded?: (data: unknown[]) => void }) {
  const [rows, setRows] = useState<ProspectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [posFilter, setPosFilter] = useState('ALL');
  // TE Premium (TEP) scoring toggle. Adds a bonus per TE reception:
  //   "std"    → 0 (default PPR)
  //   "half"   → +0.5 per TE reception
  //   "full"   → +1.0 per TE reception
  // The model predicts standard PPR PPG; we approximate the TEP bonus as
  // predictedPPG × 0.38 × bonusPerRec, where 0.38 is the empirical
  // receptions-per-PPR-PPG ratio for 2025 NFL TEs in the 10–14 PPG band.
  // Persist across sessions so the user's league setting sticks.
  const [tepMode, setTepMode] = useState<'std' | 'half' | 'full'>(
    () => (typeof localStorage !== 'undefined'
      ? ((localStorage.getItem('tepMode') as 'std' | 'half' | 'full') || 'std')
      : 'std'),
  );
  useEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem('tepMode', tepMode);
  }, [tepMode]);
  const [sortField, setSortField] = useState<SortField>('percentile');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');
  const [view, setView] = useState<'graded' | 'all'>('graded');
  const [posThresholds, setPosThresholds] = useState<Record<string, number[]>>({});
  const [selectedPlayer, setSelectedPlayer] = useState<ProspectRow | null>(null);
  const [scoreStore, setScoreStore] = useState<CareerScore[]>([]);

  useEffect(() => {
    loadCareerScores().then(setScoreStore).catch(() => {});
  }, []);

  useEffect(() => {
    Promise.all([
      fetchCombine(),
      fetchFantasyRankings(),
      fetchDynastyRankingsForDisplay('1qb'),
      fetch(`${import.meta.env.BASE_URL}data/feature-matrix.json`)
        .then(r => r.ok ? r.json() : null)
        .catch(() => null),
    ])
      .then(([combine, fpRankings, dynastyPlayers, featureData]) => {
        // Career predictions from model
        const careerMap = new Map<string, { ppg: number; thresholdProbs: Record<number, number>; combinedScore: number; percentile: number; modelTier: number; boomProb: number; bustProb: number; boomZ?: number; bustZ?: number; features?: Record<string, number> }>();
        if (featureData?.careerPredictions2026) {
          for (const p of featureData.careerPredictions2026) {
            careerMap.set(normalizeName(p.name), {
              ppg: p.predictedCareerPPG,
              thresholdProbs: p.thresholdProbs || {},
              combinedScore: p.combinedScore || 0,
              percentile: p.percentile || 0,
              modelTier: p.modelTier || 0,
              boomProb: p.boomProb || 0,
              bustProb: p.bustProb || 0,
              boomZ: p.boomZ,
              bustZ: p.bustZ,
              features: p.features,
            });
          }
        }
        // Position-specific thresholds from career models
        const posThresholds: Record<string, number[]> = {};
        if (featureData?.rookieCareerModels) {
          for (const [pos, m] of Object.entries(featureData.rookieCareerModels as Record<string, any>)) {
            if (m?.thresholds) posThresholds[pos] = m.thresholds;
          }
        }
        // Build prospect grade lookup. All map keys flow through
        // canonicalizePlayerName so spelling variants across sources
        // (PFR's hyphenated middle, FantasyPros' Nick-vs-Nicholas) collapse
        // to a single key before normalization.
        const gradeMap = new Map<string, ProspectGrade>();
        for (const g of prospectGrades as ProspectGrade[]) {
          gradeMap.set(normalizeName(canonicalizePlayerName(g.name)), g);
        }

        // Filter to 2026 combine prospects
        const prospects2026 = combine.filter((c: CombineResult) => c.season === DRAFT_YEAR);

        // FantasyPros rookie rankings
        const rookieRanks = fpRankings.filter((r: FantasyRanking) => r.ecr_type === 'drk');
        const fpMap = new Map<string, FantasyRanking>();
        for (const r of rookieRanks) {
          fpMap.set(normalizeName(canonicalizePlayerName(r.player)), r);
        }

        // Dynasty rookies
        const dynastyRookies = dynastyPlayers.filter((p: DynastyPlayer) => p.isRookie);
        const dynastyMap = new Map<string, DynastyPlayer>();
        for (const p of dynastyRookies) {
          dynastyMap.set(normalizeName(canonicalizePlayerName(p.playerName)), p);
        }

        // Build merged rows from combine as base. `seenNames` tracks every
        // normalized name we've added so the later graded/FP loops can't
        // re-emit a row when source name spellings drift (e.g. combine
        // "De'Zhaun Stribling" vs graded "DeZhaun Stribling" vs FP
        // "De'zhaun Stribling" — all map through `normalizeName` but
        // upstream data sometimes has character variants our regex misses).
        const seenNames = new Set<string>();
        const allRows: ProspectRow[] = prospects2026.map((c: CombineResult) => {
          const canonicalName = canonicalizePlayerName(c.player_name);
          const nName = normalizeName(canonicalName);
          seenNames.add(nName);
          const pg = gradeMap.get(nName);
          const fp = fpMap.get(nName);
          const dynasty = dynastyMap.get(nName);
          if (fp) fpMap.delete(nName);
          if (dynasty) dynastyMap.delete(nName);
          if (pg) gradeMap.delete(nName);
          const career = careerMap.get(nName);
          return {
            name: canonicalName,
            pos: pg?.pos || c.pos || '',
            school: c.school || pg?.school || '',
            grade: pg?.grade || 0,
            projRound: pg?.projRound || 0,
            projPick: pg?.projPick || 0,
            tier: pg?.tier || '',
            team: pg?.team || '',
            actualRound: pg?.actualRound || 0,
            actualPick: pg?.actualPick || 0,
            // Combine-feed values win; otherwise fall back to careerFeatures
            // for ht/wt/forty only — those are the three fields the prospect
            // store carries (height ~93%, weight ~92%, forty ~82% coverage).
            // bench/vertical/broadJump/cone/shuttle are NEVER in the store,
            // so any non-zero value in careerFeatures for those is a
            // position-mean default the model injected during prediction.
            // Surfacing those would mislead users (Caleb Douglas attended
            // the combine but skipped the bench, cone, and shuttle tests —
            // his features carry the WR mean, but that's not real data).
            ht: c.ht || inchesToHt(realFeature(career?.features, 'height', 'hasPhysicalData')),
            wt: c.wt || realFeature(career?.features, 'weight', 'hasPhysicalData'),
            forty: c.forty || realFeature(career?.features, 'forty', 'hasCombineData'),
            bench: c.bench || 0,
            vertical: c.vertical || 0,
            broadJump: c.broad_jump || 0,
            cone: c.cone || 0,
            shuttle: c.shuttle || 0,
            rookieEcr: fp ? fp.ecr : 999,
            rookieBest: fp ? fp.best : 0,
            rookieWorst: fp ? fp.worst : 0,
            owned: fp ? (fp.player_owned_avg || 0) : 0,
            dynastyValue: dynasty?.value || 0,
            superflexValue: dynasty?.superflexValue || 0,
            predictedCareerPPG: career?.ppg || 0,
            thresholdProbs: career?.thresholdProbs || {},
            combinedScore: career?.combinedScore || 0,
            percentile: career?.percentile || 0,
            modelTier: career?.modelTier || 0,
            boomProb: career?.boomProb || 0,
            bustProb: career?.bustProb || 0,
            boomZ: career?.boomZ,
            bustZ: career?.bustZ,
            careerFeatures: career?.features,
          };
        });

        // Add graded prospects not in combine
        for (const [, pg] of gradeMap) {
          const nName = normalizeName(canonicalizePlayerName(pg.name));
          if (seenNames.has(nName)) continue;
          seenNames.add(nName);
          const fp = fpMap.get(nName);
          const dynasty = dynastyMap.get(nName);
          if (fp) fpMap.delete(nName);
          if (dynasty) dynastyMap.delete(nName);
          const career = careerMap.get(nName);
          allRows.push({
            name: pg.name,
            pos: pg.pos,
            school: pg.school,
            grade: pg.grade,
            projRound: pg.projRound,
            projPick: pg.projPick,
            tier: pg.tier,
            team: pg.team || '',
            actualRound: pg.actualRound || 0,
            actualPick: pg.actualPick || 0,
            // No combine row for this prospect — pull ht/wt/forty from
            // careerFeatures (the three fields the prospect store covers).
            // bench/vert/broad/cone/shuttle stay blank; the careerFeatures
            // values for those are model-injected position averages, not
            // real measurements (see combine-path comment above).
            ht: inchesToHt(realFeature(career?.features, 'height', 'hasPhysicalData')),
            wt: realFeature(career?.features, 'weight', 'hasPhysicalData'),
            forty: realFeature(career?.features, 'forty', 'hasCombineData'),
            bench: 0, vertical: 0, broadJump: 0, cone: 0, shuttle: 0,
            rookieEcr: fp ? fp.ecr : 999,
            rookieBest: fp ? fp.best : 0,
            rookieWorst: fp ? fp.worst : 0,
            owned: fp ? (fp.player_owned_avg || 0) : 0,
            dynastyValue: dynasty?.value || 0,
            superflexValue: dynasty?.superflexValue || 0,
            predictedCareerPPG: career?.ppg || 0,
            thresholdProbs: career?.thresholdProbs || {},
            combinedScore: career?.combinedScore || 0,
            percentile: career?.percentile || 0,
            modelTier: career?.modelTier || 0,
            boomProb: career?.boomProb || 0,
            bustProb: career?.bustProb || 0,
            boomZ: career?.boomZ,
            bustZ: career?.bustZ,
            careerFeatures: career?.features,
          });
        }

        // Add FantasyPros rookies not yet matched
        for (const [, fp] of fpMap) {
          const canonicalName = canonicalizePlayerName(fp.player);
          const nName = normalizeName(canonicalName);
          if (seenNames.has(nName)) continue;
          seenNames.add(nName);
          const dynasty = dynastyMap.get(nName);
          if (dynasty) dynastyMap.delete(nName);
          const career = careerMap.get(nName);
          allRows.push({
            name: canonicalName,
            pos: fp.pos || '',
            school: '',
            grade: 0,
            projRound: 0, projPick: 0, tier: '',
            team: '', actualRound: 0, actualPick: 0,
            // Same careerFeatures fallback as the gradeMap path above —
            // ht/wt/forty only.
            ht: inchesToHt(realFeature(career?.features, 'height', 'hasPhysicalData')),
            wt: realFeature(career?.features, 'weight', 'hasPhysicalData'),
            forty: realFeature(career?.features, 'forty', 'hasCombineData'),
            bench: 0, vertical: 0, broadJump: 0, cone: 0, shuttle: 0,
            rookieEcr: fp.ecr,
            rookieBest: fp.best,
            rookieWorst: fp.worst,
            owned: fp.player_owned_avg || 0,
            dynastyValue: dynasty?.value || 0,
            superflexValue: dynasty?.superflexValue || 0,
            predictedCareerPPG: career?.ppg || 0,
            thresholdProbs: career?.thresholdProbs || {},
            combinedScore: career?.combinedScore || 0,
            percentile: career?.percentile || 0,
            modelTier: career?.modelTier || 0,
            boomProb: career?.boomProb || 0,
            bustProb: career?.bustProb || 0,
            boomZ: career?.boomZ,
            bustZ: career?.bustZ,
            careerFeatures: career?.features,
          });
        }

        setRows(allRows);
        setPosThresholds(posThresholds);
        onDataLoaded?.(allRows);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [onDataLoaded]);

  const handleSort = (field: SortField) => {
    if (field === sortField) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortField(field);
      const descFields: SortField[] = ['grade', 'dynastyValue', 'superflexValue', 'wt', 'bench', 'vertical', 'broadJump', 'owned', 'predictedCareerPPG', 'combinedScore', 'percentile'];
      // actualPick / actualRound: lower is better, so default ascending — best
      // pick (#1 overall) at the top.
      setSortDir(descFields.includes(field) ? 'desc' : 'asc');
    }
  };

  const filtered = useMemo(() => {
    let d = [...rows];
    if (view === 'graded') d = d.filter((r) => r.grade > 0);
    // The fantasy prospects board only shows skill-position rookies.
    d = d.filter((r) => FANTASY_POSITIONS.has(r.pos.toUpperCase()));
    if (posFilter !== 'ALL') {
      d = d.filter((r) => r.pos.toUpperCase() === posFilter);
    }
    if (search) {
      const q = search.toLowerCase();
      d = d.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.school.toLowerCase().includes(q) ||
          r.tier.toLowerCase().includes(q)
      );
    }
    d.sort((a, b) => {
      let aVal = a[sortField];
      let bVal = b[sortField];
      // PPG sort respects the TEP bonus so TEs rank in their league-adjusted
      // order when the user enables TE Premium.
      if (sortField === 'predictedCareerPPG') {
        aVal = a.predictedCareerPPG + tepBonus(a.pos, a.predictedCareerPPG, tepMode);
        bVal = b.predictedCareerPPG + tepBonus(b.pos, b.predictedCareerPPG, tepMode);
      }
      // Push zeros/999 to bottom
      if (sortField === 'rookieEcr') {
        if ((aVal as number) >= 999) aVal = sortDir === 'asc' ? Infinity : -Infinity;
        if ((bVal as number) >= 999) bVal = sortDir === 'asc' ? Infinity : -Infinity;
      }
      if (sortField === 'modelTier') {
        if ((aVal as number) === 0) aVal = sortDir === 'asc' ? Infinity : -Infinity;
        if ((bVal as number) === 0) bVal = sortDir === 'asc' ? Infinity : -Infinity;
      }
      if (sortField === 'grade' || sortField === 'dynastyValue' || sortField === 'projPick' || sortField === 'percentile') {
        if ((aVal as number) === 0) aVal = sortDir === 'desc' ? -Infinity : Infinity;
        if ((bVal as number) === 0) bVal = sortDir === 'desc' ? -Infinity : Infinity;
      }
      // Undrafted players sort to the bottom regardless of asc/desc on actual pick.
      if (sortField === 'actualPick' || sortField === 'actualRound') {
        if ((aVal as number) === 0) aVal = Infinity;
        if ((bVal as number) === 0) bVal = Infinity;
      }
      if (typeof aVal === 'string')
        return sortDir === 'asc'
          ? (aVal as string).localeCompare(bVal as string)
          : (bVal as string).localeCompare(aVal as string);
      return sortDir === 'asc'
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });
    return d.slice(0, 400);
  }, [rows, view, posFilter, search, sortField, sortDir, tepMode]);

  const sortArrow = (field: SortField) =>
    field === sortField ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';

  // Tier-index columns (T1..T4). Each model uses 4 thresholds, but the PPG
  // values differ by position: TE [8,9,10,11], RB/WR [12,14,16,18], QB
  // [16,18,20,22]. Indexing by tier index instead of literal PPG value lets
  // a TE row show all 4 hit-rates against the TE thresholds rather than
  // pulling RB/WR-keyed values that don't exist on the TE record.
  const N_TIERS = 4;
  const tierIndices = useMemo(() => Array.from({ length: N_TIERS }, (_, i) => i), []);
  const filteredPosThresholds: number[] | null = useMemo(() => {
    if (posFilter !== 'ALL' && posThresholds[posFilter]) return posThresholds[posFilter];
    return null;
  }, [posFilter, posThresholds]);
  const probForTier = useCallback(
    (r: ProspectRow, tierIdx: number): number | undefined => {
      const t = posThresholds[r.pos]?.[tierIdx];
      if (t == null) return undefined;
      return r.thresholdProbs?.[t];
    },
    [posThresholds],
  );

  // CSV export — flattens the currently-filtered rows (respects search, view,
  // position filter, sort) into a downloadable file. Includes the same
  // per-position PPG-threshold columns shown in the table so what users see
  // is what they get.
  const downloadCsv = useCallback(() => {
    const headers = [
      '#', 'name', 'pos', 'school',
      'grade', 'tier', 'projRound', 'projPick',
      'team', 'actualRound', 'actualPick',
      'rookieEcr', 'rookieBest', 'rookieWorst',
      'dynastyValue', 'superflexValue',
      tepMode === 'std' ? 'predictedCareerPPG' : `predictedCareerPPG_tep${tepMode === 'half' ? '0.5' : '1.0'}`,
      'modelTier', 'percentile', 'combinedScore',
      'boomProb', 'bustProb', 'boomZ', 'bustZ',
      ...tierIndices.map((i) =>
        filteredPosThresholds
          ? `p_ge_${fmtThreshold(effectiveThreshold(posFilter, filteredPosThresholds[i], tepMode))}ppg`
          : `p_tier${i + 1}`,
      ),
      'ht', 'wt', 'forty', 'bench', 'vertical', 'broadJump', 'cone', 'shuttle',
      'owned',
    ];
    const escape = (v: unknown): string => {
      if (v == null || v === '') return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines: string[] = [headers.join(',')];
    filtered.forEach((r, i) => {
      const row = [
        i + 1, r.name, r.pos, r.school,
        r.grade || '', r.tier || '', r.projRound || '', r.projPick || '',
        r.team || '', r.actualRound || '', r.actualPick || '',
        r.rookieEcr || '', r.rookieBest || '', r.rookieWorst || '',
        r.dynastyValue || '', r.superflexValue || '',
        r.predictedCareerPPG > 0
          ? Math.round((r.predictedCareerPPG + tepBonus(r.pos, r.predictedCareerPPG, tepMode)) * 10) / 10
          : '',
        r.modelTier || '', r.percentile || '', r.combinedScore || '',
        r.boomProb ?? '', r.bustProb ?? '', r.boomZ ?? '', r.bustZ ?? '',
        ...tierIndices.map((i) => probForTier(r, i) ?? ''),
        r.ht || '', r.wt || '', r.forty || '', r.bench || '', r.vertical || '', r.broadJump || '', r.cone || '', r.shuttle || '',
        r.owned || '',
      ];
      lines.push(row.map(escape).join(','));
    });
    const suffix = posFilter === 'ALL' ? '' : `-${posFilter.toLowerCase()}`;
    const viewLabel = view === 'graded' ? 'big-board' : 'all';
    const filename = `rookie-prospects-${DRAFT_YEAR}-${viewLabel}${suffix}.csv`;
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }, [filtered, tierIndices, filteredPosThresholds, probForTier, posFilter, view, tepMode]);

  if (loading)
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading 2026 prospect data...</div>
      </div>
    );
  if (error)
    return (
      <div className="empty-state">
        <h3>Failed to load prospect data</h3>
        <p>{error}</p>
      </div>
    );

  const gradedCount = rows.filter((r) => r.grade > 0).length;

  // Heat color for probability cells
  const probColor = (pct: number): string => {
    if (pct >= 70) return '#22c55e';
    if (pct >= 50) return '#4ade80';
    if (pct >= 30) return '#a3e635';
    if (pct >= 15) return '#facc15';
    if (pct >= 5) return '#fb923c';
    return '#ef4444';
  };
  const probBg = (pct: number): string => {
    if (pct >= 70) return 'rgba(34,197,94,0.25)';
    if (pct >= 50) return 'rgba(34,197,94,0.15)';
    if (pct >= 30) return 'rgba(163,230,53,0.12)';
    if (pct >= 15) return 'rgba(250,204,21,0.10)';
    if (pct >= 5) return 'rgba(251,146,60,0.10)';
    return 'rgba(239,68,68,0.12)';
  };

  return (
    <>
      <div className="controls">
        <DocsLink section="rookie" title="Rookie career model validation — Model Docs" />
        <input
          type="text"
          placeholder="Search players, schools, or tiers..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="control-group">
          <label className="control-label">View</label>
          <select value={view} onChange={(e) => setView(e.target.value as 'graded' | 'all')}>
            <option value="graded">Big Board ({gradedCount})</option>
            <option value="all">All Prospects ({rows.length})</option>
          </select>
        </div>
        <div className="position-filters">
          {POSITIONS.map((pos) => (
            <button
              key={pos}
              className={`pos-filter ${posFilter === pos ? 'active' : ''}`}
              onClick={() => setPosFilter(pos)}
            >
              {pos}
            </button>
          ))}
        </div>
        <div
          className="position-filters"
          title="TE Premium scoring. Adds 0.5 or 1.0 PPR per TE reception. Approximates the bonus as predictedPPG × 0.38 × bonusPerRec (empirical rec/PPG ratio for 2025 NFL TEs in the 10–14 PPG band). Tier hit-rates are unchanged."
        >
          <label className="control-label" style={{ marginRight: 4 }}>TEP</label>
          {([
            { value: 'std', label: 'Std' },
            { value: 'half', label: '+0.5' },
            { value: 'full', label: '+1.0' },
          ] as const).map((opt) => (
            <button
              key={opt.value}
              className={`pos-filter ${tepMode === opt.value ? 'active' : ''}`}
              onClick={() => setTepMode(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <button
          onClick={downloadCsv}
          title={`Download current view (${filtered.length} rows) as CSV`}
          style={{
            marginLeft: 'auto', padding: '6px 12px', fontSize: 12, fontWeight: 600,
            background: 'var(--bg-secondary)', color: 'var(--text-primary)',
            border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
          onMouseEnter={(e) => { (e.target as HTMLElement).style.background = 'var(--bg-tertiary)'; }}
          onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'var(--bg-secondary)'; }}
        >
          Download CSV
        </button>
      </div>

      <div style={{ padding: '0 16px 8px', fontSize: 12, color: 'var(--text-muted)' }}>
        {filtered.length} prospects &middot; Prospect grades, draft projections, combine measurables, and expert consensus rankings
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th style={{ width: 36 }}>#</th>
              <th onClick={() => handleSort('name')} style={{ cursor: 'pointer' }}>
                Player{sortArrow('name')}
              </th>
              <th>Pos</th>
              <th onClick={() => handleSort('school')} style={{ cursor: 'pointer' }}>
                School{sortArrow('school')}
              </th>
              <th
                onClick={() => handleSort('percentile')}
                style={{ cursor: 'pointer' }}
                title="Career percentile vs all historical rookies at this position"
              >
                Pctl{sortArrow('percentile')}
              </th>
              <th
                onClick={() => handleSort('actualPick')}
                style={{ cursor: 'pointer' }}
                title="Actual NFL draft slot (team and overall pick). Falls back to the projected slot if a player went undrafted on the public big board."
              >
                NFL Draft{sortArrow('actualPick')}
              </th>
              <th onClick={() => handleSort('rookieEcr')} style={{ cursor: 'pointer' }}>
                Rookie ECR{sortArrow('rookieEcr')}
              </th>
              <th onClick={() => handleSort('dynastyValue')} style={{ cursor: 'pointer' }}>
                Dynasty Val{sortArrow('dynastyValue')}
              </th>
              <th onClick={() => handleSort('predictedCareerPPG')} style={{ cursor: 'pointer' }}>
                Model PPG{sortArrow('predictedCareerPPG')}
              </th>
              <th onClick={() => handleSort('modelTier')} style={{ cursor: 'pointer' }}>
                Tier{sortArrow('modelTier')}
              </th>
              <th style={{ textAlign: 'center', fontSize: 11, color: '#22c55e' }} title="Boom z-score: prospect's outperformance score standardized vs the historical NFL rookie distribution. +1σ = strong upside vs typical rookie at this draft slot.">Boom z</th>
              <th style={{ textAlign: 'center', fontSize: 11, color: '#ef4444' }} title="Bust z-score: prospect's bust-event score standardized vs the historical NFL rookie distribution. +1σ = unusually high bust risk; -1σ = unusually safe.">Bust z</th>
              {tierIndices.map((i) => {
                // When a single position is filtered, show the literal PPG
                // threshold for that tier; otherwise show "T1..T4" because
                // QB/RB/WR/TE have different per-tier PPG values. TE
                // thresholds scale up with TEP; other positions don't.
                let label: string;
                let tooltip: string;
                if (filteredPosThresholds) {
                  const raw = filteredPosThresholds[i];
                  const eff = effectiveThreshold(posFilter, raw, tepMode);
                  label = `>${fmtThreshold(eff)}`;
                  tooltip =
                    eff === raw
                      ? `P(best 2-of-3 PPG ≥ ${raw}) — modeled probability the rookie’s best 2 of 3 first-3-year PPG clears ${raw} PPR points/game.`
                      : `P(best 2-of-3 PPG ≥ ${fmtThreshold(eff)}) in TEP ${tepMode === 'half' ? '+0.5' : '+1.0'} — equivalent to ≥${raw} standard PPR. Hit-rate unchanged; cutoff displayed in league units.`;
                } else {
                  label = `T${i + 1}`;
                  const teRaw = posThresholds['TE']?.[i];
                  const teEff = teRaw != null ? effectiveThreshold('TE', teRaw, tepMode) : undefined;
                  const tePart =
                    teRaw == null
                      ? '?'
                      : teEff !== teRaw
                      ? `${fmtThreshold(teEff!)} (${teRaw} std)`
                      : `${teRaw}`;
                  tooltip = `Tier ${i + 1} hit-rate: P(best 2-of-3 PPG ≥ pos-specific PPG threshold). QB ${posThresholds['QB']?.[i] ?? '?'}, RB ${posThresholds['RB']?.[i] ?? '?'}, WR ${posThresholds['WR']?.[i] ?? '?'}, TE ${tePart} PPG.`;
                }
                return (
                  <th
                    key={i}
                    style={{ textAlign: 'center', fontSize: 11, padding: '6px 4px', minWidth: 48 }}
                    title={tooltip}
                  >
                    {label}
                  </th>
                );
              })}
              <th onClick={() => handleSort('ht')} style={{ cursor: 'pointer' }}>
                Ht{sortArrow('ht')}
              </th>
              <th onClick={() => handleSort('wt')} style={{ cursor: 'pointer' }}>
                Wt{sortArrow('wt')}
              </th>
              <th onClick={() => handleSort('forty')} style={{ cursor: 'pointer' }}>
                40-Yd{sortArrow('forty')}
              </th>
              <th onClick={() => handleSort('vertical')} style={{ cursor: 'pointer' }}>
                Vert{sortArrow('vertical')}
              </th>
              <th onClick={() => handleSort('broadJump')} style={{ cursor: 'pointer' }}>
                Broad{sortArrow('broadJump')}
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={`${r.name}-${i}`}>
                <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>{i + 1}</td>
                <td>
                  <PlayerName name={r.name} position={r.pos} style={{ fontWeight: 700 }} />
                  <ModelCardButton onClick={() => setSelectedPlayer(r)} />
                </td>
                <td>
                  <span className={`pos-badge pos-${r.pos}`}>{r.pos}</span>
                </td>
                <td>{r.school || '-'}</td>
                <td>
                  {r.percentile > 0 ? (
                    <strong style={{
                      color: r.percentile >= 95 ? '#22c55e'
                        : r.percentile >= 85 ? '#4ade80'
                        : r.percentile >= 70 ? '#a3e635'
                        : r.percentile >= 50 ? '#facc15'
                        : r.percentile >= 25 ? '#fb923c'
                        : '#ef4444',
                    }}>
                      {r.percentile}
                    </strong>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>-</span>
                  )}
                </td>
                <td>
                  {r.actualPick > 0 ? (
                    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, whiteSpace: 'nowrap' }}>
                      <strong style={{ fontSize: 12 }}>{r.team}</strong>
                      <span
                        style={{
                          fontWeight: r.actualRound <= 2 ? 700 : 400,
                          color: r.actualRound === 1 ? '#22c55e' : r.actualRound === 2 ? '#a3e635' : r.actualRound === 3 ? '#facc15' : 'inherit',
                          fontSize: 11,
                        }}
                      >
                        Rd {r.actualRound} #{r.actualPick}
                      </span>
                    </span>
                  ) : r.projRound > 0 ? (
                    <span
                      title="No NFL pick recorded — projected draft slot shown."
                      style={{
                        fontWeight: r.projRound <= 2 ? 700 : 400,
                        color: 'var(--text-muted)',
                        fontStyle: 'italic',
                      }}
                    >
                      proj Rd {r.projRound}
                      {r.projPick > 0 ? <span style={{ marginLeft: 4 }}>#{r.projPick}</span> : ''}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>-</span>
                  )}
                </td>
                <td>
                  {r.rookieEcr < 999 ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <span
                        style={{
                          display: 'inline-block',
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: ecrTierColor(r.rookieEcr),
                        }}
                      />
                      <strong style={{ color: ecrTierColor(r.rookieEcr), fontSize: 13 }}>
                        {Number(r.rookieEcr).toFixed(1)}
                      </strong>
                      {r.rookieBest > 0 && r.rookieWorst > 0 && (
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                          ({r.rookieBest}-{r.rookieWorst})
                        </span>
                      )}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>-</span>
                  )}
                </td>
                <td>
                  {r.dynastyValue > 0 ? (
                    <span style={{ color: valueColor(r.dynastyValue), fontWeight: 600 }}>
                      {r.dynastyValue.toLocaleString()}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>-</span>
                  )}
                </td>
                <td>
                  {r.predictedCareerPPG > 0 ? (() => {
                    const bonus = tepBonus(r.pos, r.predictedCareerPPG, tepMode);
                    const ppg = r.predictedCareerPPG + bonus;
                    return (
                      <strong
                        title={
                          bonus > 0
                            ? `Standard PPR: ${r.predictedCareerPPG.toFixed(1)} + TEP ${tepMode === 'half' ? '+0.5' : '+1.0'} bonus ${bonus.toFixed(1)} = ${ppg.toFixed(1)}`
                            : undefined
                        }
                        style={{
                          color: ppg >= 15 ? '#22c55e'
                            : ppg >= 10 ? '#a3e635'
                            : ppg >= 6 ? '#facc15'
                            : '#fb923c',
                        }}
                      >
                        {ppg.toFixed(1)}
                        {bonus > 0 && (
                          <span style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 2 }}>+</span>
                        )}
                      </strong>
                    );
                  })() : (
                    <span style={{ color: 'var(--text-muted)' }}>-</span>
                  )}
                </td>
                <td>
                  {(() => {
                    const tierMap: Record<number, { label: string; color: string }> = {
                      1: { label: 'Alpha',       color: '#22c55e' },
                      2: { label: 'Blue Chip',   color: '#4ade80' },
                      3: { label: 'Starter',     color: '#a3e635' },
                      4: { label: 'Contributor', color: '#facc15' },
                      5: { label: 'Depth',       color: '#fb923c' },
                      6: { label: 'Longshot',    color: '#ef4444' },
                    };
                    const def = tierMap[r.modelTier];
                    if (!def || !r.modelTier) return <span style={{ color: 'var(--text-muted)' }}>-</span>;
                    return (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                        title="Rookie career model tier — percentile vs all historical rookies, with first-round scout-consensus override.">
                        <strong style={{ color: def.color, fontSize: 12, whiteSpace: 'nowrap' }}>
                          {def.label}
                        </strong>
                      </span>
                    );
                  })()}
                </td>
                <td style={{ textAlign: 'center', fontSize: 11, fontWeight: 600, color: r.boomZ != null && r.boomZ >= 1 ? '#22c55e' : r.boomZ != null && r.boomZ >= 0.3 ? '#a3e635' : r.boomZ != null && r.boomZ <= -0.5 ? '#fb923c' : 'var(--text-muted)' }}>
                  {r.boomZ != null ? (r.boomZ >= 0 ? `+${r.boomZ.toFixed(2)}` : r.boomZ.toFixed(2)) : (r.boomProb > 0 ? `${r.boomProb.toFixed(0)}%` : '-')}
                </td>
                <td style={{ textAlign: 'center', fontSize: 11, fontWeight: 600, color: r.bustZ != null && r.bustZ >= 1 ? '#ef4444' : r.bustZ != null && r.bustZ >= 0.3 ? '#fb923c' : r.bustZ != null && r.bustZ <= -0.5 ? '#22c55e' : 'var(--text-muted)' }}>
                  {r.bustZ != null ? (r.bustZ >= 0 ? `+${r.bustZ.toFixed(2)}` : r.bustZ.toFixed(2)) : (r.bustProb > 0 ? `${r.bustProb.toFixed(0)}%` : '-')}
                </td>
                {tierIndices.map((i) => {
                  const prob = probForTier(r, i);
                  const hasProb = prob != null && prob > 0 && r.predictedCareerPPG > 0;
                  const tVal = posThresholds[r.pos]?.[i];
                  const tEff = tVal != null ? effectiveThreshold(r.pos, tVal, tepMode) : undefined;
                  const title =
                    tVal == null
                      ? undefined
                      : tEff === tVal
                      ? `${r.pos} tier ${i + 1}: P(best 2-of-3 PPG ≥ ${tVal})`
                      : `${r.pos} tier ${i + 1}: P(best 2-of-3 PPG ≥ ${fmtThreshold(tEff!)} in TEP ${tepMode === 'half' ? '+0.5' : '+1.0'}, equivalent to ≥${tVal} standard PPR)`;
                  return (
                    <td
                      key={i}
                      title={title}
                      style={{
                        textAlign: 'center', fontSize: 12, fontWeight: 600, padding: '4px 3px',
                        background: hasProb ? probBg(prob) : undefined,
                        color: hasProb ? probColor(prob) : 'var(--text-muted)',
                      }}
                    >
                      {hasProb ? `${prob.toFixed(0)}%` : '-'}
                    </td>
                  );
                })}
                <td>{r.ht || '-'}</td>
                <td>{r.wt || '-'}</td>
                <td className={r.forty ? '' : 'text-muted'}>
                  {fmtMeasurable(r.forty)}
                </td>
                <td>{r.vertical ? fmtMeasurable(r.vertical) : '-'}</td>
                <td>{r.broadJump || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedPlayer && (() => {
        const nn = normalizeName(selectedPlayer.name);
        const ss = scoreStore.find(s =>
          normalizeName(s.name) === nn &&
          s.position === selectedPlayer.pos &&
          s.draftSeason === DRAFT_YEAR
        );
        return (
          <PlayerCard
            player={{
              name: selectedPlayer.name,
              position: selectedPlayer.pos,
              draftSeason: DRAFT_YEAR,
              ourScore: selectedPlayer.combinedScore,
              predictedPPG:
                selectedPlayer.predictedCareerPPG > 0
                  ? selectedPlayer.predictedCareerPPG +
                    tepBonus(selectedPlayer.pos, selectedPlayer.predictedCareerPPG, tepMode)
                  : selectedPlayer.predictedCareerPPG,
              thresholdProbs: selectedPlayer.thresholdProbs,
              features: {
                ...(ss?.features || selectedPlayer.careerFeatures || {}),
                // Always prefer the list-row values for the prospect-card
                // identity fields. The score-store / careerFeatures snapshots
                // can be stale or assembled from a different source than the
                // table row, so the row is the source of truth here.
                ...(selectedPlayer.wt ? { weight: selectedPlayer.wt } : {}),
                ...(selectedPlayer.forty ? { forty: selectedPlayer.forty } : {}),
                // Actual draft slot wins over projected when the player was
                // drafted; pre-draft model features are computed from projPick
                // upstream, but the PlayerCard popover should reflect reality.
                ...(selectedPlayer.actualPick
                  ? { nflDraftPick: selectedPlayer.actualPick }
                  : selectedPlayer.projPick ? { nflDraftPick: selectedPlayer.projPick } : {}),
                ...(selectedPlayer.actualRound
                  ? { nflDraftRound: selectedPlayer.actualRound }
                  : selectedPlayer.projRound ? { nflDraftRound: selectedPlayer.projRound } : {}),
                ...(selectedPlayer.grade ? { prospectGrade: selectedPlayer.grade } : {}),
              },
              featurePercentiles: ss?.featurePercentiles,
              boomZ: selectedPlayer.boomZ,
              bustZ: selectedPlayer.bustZ,
            }}
            onClose={() => setSelectedPlayer(null)}
          />
        );
      })()}
    </>
  );
}
