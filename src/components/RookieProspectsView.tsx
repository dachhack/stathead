import { useState, useEffect, useMemo } from 'react';
import type { CombineResult, FantasyRanking, KTCPlayer, SortDirection } from '../types';
import { fetchCombine, fetchFantasyRankings, fetchKTCRankings } from '../data';
import prospectGrades from '../data/prospect-grades-2026.json';
import zapScores from '../data/zap-scores-2026.json';

interface ProspectGrade {
  name: string;
  pos: string;
  school: string;
  grade: number;
  projRound: number;
  projPick: number;
  tier: string;
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
  // KTC dynasty
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
  zapScore: number;
}

type SortField = keyof ProspectRow;

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'EDGE', 'DT', 'LB', 'CB', 'SAF', 'OL'];
const DRAFT_YEAR = 2026;

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.\-''`]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function gradeColor(grade: number): string {
  if (grade >= 90) return '#22c55e';
  if (grade >= 85) return '#4ade80';
  if (grade >= 78) return '#a3e635';
  if (grade >= 70) return '#facc15';
  if (grade >= 64) return '#fb923c';
  return '#ef4444';
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

function tierColor(tier: number): string {
  if (tier === 1) return '#22c55e';
  if (tier === 2) return '#4ade80';
  if (tier === 3) return '#a3e635';
  if (tier === 4) return '#facc15';
  if (tier === 5) return '#fb923c';
  if (tier === 6) return '#ef4444';
  return '#991b1b';
}

function tierLabel(tier: number): string {
  if (tier === 1) return 'Legendary';
  if (tier === 2) return 'Elite';
  if (tier === 3) return 'Starter';
  if (tier === 4) return 'Flex';
  if (tier === 5) return 'Bench';
  if (tier === 6) return 'Waiver';
  return 'Dart Throw';
}

export function RookieProspectsView({ onDataLoaded }: { onDataLoaded?: (data: unknown[]) => void }) {
  const [rows, setRows] = useState<ProspectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [posFilter, setPosFilter] = useState('ALL');
  const [sortField, setSortField] = useState<SortField>('grade');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');
  const [view, setView] = useState<'graded' | 'all'>('graded');
  const [posThresholds, setPosThresholds] = useState<Record<string, number[]>>({});

  useEffect(() => {
    Promise.all([
      fetchCombine(),
      fetchFantasyRankings(),
      fetchKTCRankings('1qb'),
      fetch(`${import.meta.env.BASE_URL}data/feature-matrix.json`)
        .then(r => r.ok ? r.json() : null)
        .catch(() => null),
    ])
      .then(([combine, fpRankings, ktcPlayers, featureData]) => {
        // Career predictions from model
        const careerMap = new Map<string, { ppg: number; thresholdProbs: Record<number, number>; combinedScore: number; percentile: number; modelTier: number; boomProb: number; bustProb: number }>();
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
            });
          }
        }
        // ZAP score lookup
        const zapMap = new Map<string, number>();
        for (const pos of ['WR', 'RB', 'TE'] as const) {
          for (const z of (zapScores as any)[pos] || []) {
            zapMap.set(normalizeName(z.name), z.zap);
          }
        }

        // Position-specific thresholds from career models
        const posThresholds: Record<string, number[]> = {};
        if (featureData?.rookieCareerModels) {
          for (const [pos, m] of Object.entries(featureData.rookieCareerModels as Record<string, any>)) {
            if (m?.thresholds) posThresholds[pos] = m.thresholds;
          }
        }
        // Build prospect grade lookup
        const gradeMap = new Map<string, ProspectGrade>();
        for (const g of prospectGrades as ProspectGrade[]) {
          gradeMap.set(normalizeName(g.name), g);
        }

        // Filter to 2026 combine prospects
        const prospects2026 = combine.filter((c: CombineResult) => c.season === DRAFT_YEAR);

        // FantasyPros rookie rankings
        const rookieRanks = fpRankings.filter((r: FantasyRanking) => r.ecr_type === 'drk');
        const fpMap = new Map<string, FantasyRanking>();
        for (const r of rookieRanks) {
          fpMap.set(normalizeName(r.player), r);
        }

        // KTC rookies
        const ktcRookies = ktcPlayers.filter((p: KTCPlayer) => p.isRookie);
        const ktcMap = new Map<string, KTCPlayer>();
        for (const p of ktcRookies) {
          ktcMap.set(normalizeName(p.playerName), p);
        }

        // Build merged rows from combine as base
        const allRows: ProspectRow[] = prospects2026.map((c: CombineResult) => {
          const nName = normalizeName(c.player_name);
          const pg = gradeMap.get(nName);
          const fp = fpMap.get(nName);
          const ktc = ktcMap.get(nName);
          if (fp) fpMap.delete(nName);
          if (ktc) ktcMap.delete(nName);
          if (pg) gradeMap.delete(nName);
          const career = careerMap.get(nName);
          return {
            name: c.player_name,
            pos: pg?.pos || c.pos || '',
            school: c.school || pg?.school || '',
            grade: pg?.grade || 0,
            projRound: pg?.projRound || 0,
            projPick: pg?.projPick || 0,
            tier: pg?.tier || '',
            ht: c.ht || '',
            wt: c.wt || 0,
            forty: c.forty || 0,
            bench: c.bench || 0,
            vertical: c.vertical || 0,
            broadJump: c.broad_jump || 0,
            cone: c.cone || 0,
            shuttle: c.shuttle || 0,
            rookieEcr: fp ? fp.ecr : 999,
            rookieBest: fp ? fp.best : 0,
            rookieWorst: fp ? fp.worst : 0,
            owned: fp ? (fp.player_owned_avg || 0) : 0,
            dynastyValue: ktc?.value || 0,
            superflexValue: ktc?.superflexValue || 0,
            predictedCareerPPG: career?.ppg || 0,
            thresholdProbs: career?.thresholdProbs || {},
            combinedScore: career?.combinedScore || 0,
            percentile: career?.percentile || 0,
            modelTier: career?.modelTier || 0,
            boomProb: career?.boomProb || 0,
            bustProb: career?.bustProb || 0,
            zapScore: zapMap.get(nName) || 0,
          };
        });

        // Add graded prospects not in combine
        for (const [, pg] of gradeMap) {
          const nName = normalizeName(pg.name);
          const fp = fpMap.get(nName);
          const ktc = ktcMap.get(nName);
          if (fp) fpMap.delete(nName);
          if (ktc) ktcMap.delete(nName);
          const career = careerMap.get(nName);
          allRows.push({
            name: pg.name,
            pos: pg.pos,
            school: pg.school,
            grade: pg.grade,
            projRound: pg.projRound,
            projPick: pg.projPick,
            tier: pg.tier,
            ht: '', wt: 0, forty: 0, bench: 0, vertical: 0, broadJump: 0, cone: 0, shuttle: 0,
            rookieEcr: fp ? fp.ecr : 999,
            rookieBest: fp ? fp.best : 0,
            rookieWorst: fp ? fp.worst : 0,
            owned: fp ? (fp.player_owned_avg || 0) : 0,
            dynastyValue: ktc?.value || 0,
            superflexValue: ktc?.superflexValue || 0,
            predictedCareerPPG: career?.ppg || 0,
            thresholdProbs: career?.thresholdProbs || {},
            combinedScore: career?.combinedScore || 0,
            percentile: career?.percentile || 0,
            modelTier: career?.modelTier || 0,
            boomProb: career?.boomProb || 0,
            bustProb: career?.bustProb || 0,
            zapScore: zapMap.get(nName) || 0,
          });
        }

        // Add FantasyPros rookies not yet matched
        for (const [, fp] of fpMap) {
          const nName = normalizeName(fp.player);
          const ktc = ktcMap.get(nName);
          if (ktc) ktcMap.delete(nName);
          const career = careerMap.get(nName);
          allRows.push({
            name: fp.player,
            pos: fp.pos || '',
            school: '',
            grade: 0,
            projRound: 0, projPick: 0, tier: '',
            ht: '', wt: 0, forty: 0, bench: 0, vertical: 0, broadJump: 0, cone: 0, shuttle: 0,
            rookieEcr: fp.ecr,
            rookieBest: fp.best,
            rookieWorst: fp.worst,
            owned: fp.player_owned_avg || 0,
            dynastyValue: ktc?.value || 0,
            superflexValue: ktc?.superflexValue || 0,
            predictedCareerPPG: career?.ppg || 0,
            thresholdProbs: career?.thresholdProbs || {},
            combinedScore: career?.combinedScore || 0,
            percentile: career?.percentile || 0,
            modelTier: career?.modelTier || 0,
            boomProb: career?.boomProb || 0,
            bustProb: career?.bustProb || 0,
            zapScore: zapMap.get(nName) || 0,
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
      const descFields: SortField[] = ['grade', 'dynastyValue', 'superflexValue', 'wt', 'bench', 'vertical', 'broadJump', 'owned', 'predictedCareerPPG', 'combinedScore', 'percentile', 'zapScore'];
      setSortDir(descFields.includes(field) ? 'desc' : 'asc');
    }
  };

  const filtered = useMemo(() => {
    let d = [...rows];
    if (view === 'graded') d = d.filter((r) => r.grade > 0);
    if (posFilter !== 'ALL') {
      d = d.filter((r) => {
        const pos = r.pos.toUpperCase();
        if (posFilter === 'OL') return ['OT', 'OG', 'C', 'OL', 'IOL', 'G', 'T'].includes(pos);
        if (posFilter === 'DT') return ['DT', 'DL', 'NT', 'IDL'].includes(pos);
        if (posFilter === 'EDGE') return ['EDGE', 'OLB', 'DE'].includes(pos);
        if (posFilter === 'SAF') return ['SAF', 'S', 'FS', 'SS'].includes(pos);
        return pos === posFilter;
      });
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
      // Push zeros/999 to bottom
      if (sortField === 'rookieEcr') {
        if ((aVal as number) >= 999) aVal = sortDir === 'asc' ? Infinity : -Infinity;
        if ((bVal as number) >= 999) bVal = sortDir === 'asc' ? Infinity : -Infinity;
      }
      if (sortField === 'modelTier') {
        if ((aVal as number) === 0) aVal = sortDir === 'asc' ? Infinity : -Infinity;
        if ((bVal as number) === 0) bVal = sortDir === 'asc' ? Infinity : -Infinity;
      }
      if (sortField === 'grade' || sortField === 'dynastyValue' || sortField === 'projPick') {
        if ((aVal as number) === 0) aVal = sortDir === 'desc' ? -Infinity : Infinity;
        if ((bVal as number) === 0) bVal = sortDir === 'desc' ? -Infinity : Infinity;
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
  }, [rows, view, posFilter, search, sortField, sortDir]);

  const sortArrow = (field: SortField) =>
    field === sortField ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';

  // Get relevant thresholds for current position filter
  const activeThresholds = useMemo(() => {
    if (posFilter !== 'ALL' && posThresholds[posFilter]) return posThresholds[posFilter];
    // When ALL positions, show RB/WR thresholds (most common)
    return posThresholds['RB'] || posThresholds['WR'] || [];
  }, [posFilter, posThresholds]);

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
      </div>

      <div style={{ padding: '0 16px 8px', fontSize: 12, color: 'var(--text-muted)' }}>
        {filtered.length} prospects &middot; Prospect grades &amp; draft projections &middot; Combine measurables from NFLverse &middot; Fantasy rankings from FantasyPros
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
              <th onClick={() => handleSort('grade')} style={{ cursor: 'pointer' }}>
                Grade{sortArrow('grade')}
              </th>
              <th onClick={() => handleSort('projRound')} style={{ cursor: 'pointer' }}>
                Proj. Draft{sortArrow('projRound')}
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
              <th onClick={() => handleSort('percentile')} style={{ cursor: 'pointer' }}>
                Pctl{sortArrow('percentile')}
              </th>
              <th onClick={() => handleSort('zapScore')} style={{ cursor: 'pointer', fontSize: 11 }}>
                ZAP{sortArrow('zapScore')}
              </th>
              <th style={{ textAlign: 'center', fontSize: 11, color: '#22c55e' }}>Boom</th>
              <th style={{ textAlign: 'center', fontSize: 11, color: '#ef4444' }}>Bust</th>
              {activeThresholds.map(t => (
                <th key={t} style={{ textAlign: 'center', fontSize: 11, padding: '6px 4px', minWidth: 48 }}>
                  &gt;{t}
                </th>
              ))}
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
                  <strong>{r.name}</strong>
                </td>
                <td>
                  <span className={`pos-badge pos-${r.pos}`}>{r.pos}</span>
                </td>
                <td>{r.school || '-'}</td>
                <td>
                  {r.grade > 0 ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span
                        style={{
                          display: 'inline-block',
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: gradeColor(r.grade),
                        }}
                      />
                      <strong style={{ color: gradeColor(r.grade) }}>
                        {r.grade}
                      </strong>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                        {r.tier}
                      </span>
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>-</span>
                  )}
                </td>
                <td>
                  {r.projRound > 0 ? (
                    <span
                      style={{
                        fontWeight: r.projRound <= 2 ? 700 : 400,
                        color: r.projRound === 1 ? '#22c55e' : r.projRound === 2 ? '#a3e635' : r.projRound === 3 ? '#facc15' : 'inherit',
                      }}
                    >
                      Rd {r.projRound}
                      {r.projPick > 0 ? <span style={{ fontWeight: 400, color: 'var(--text-secondary)', marginLeft: 4 }}>#{r.projPick}</span> : ''}
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
                  {r.predictedCareerPPG > 0 ? (
                    <strong style={{
                      color: r.predictedCareerPPG >= 15 ? '#22c55e'
                        : r.predictedCareerPPG >= 10 ? '#a3e635'
                        : r.predictedCareerPPG >= 6 ? '#facc15'
                        : '#fb923c',
                    }}>
                      {r.predictedCareerPPG.toFixed(1)}
                    </strong>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>-</span>
                  )}
                </td>
                <td>
                  {r.modelTier > 0 ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <strong style={{ color: tierColor(r.modelTier), fontSize: 12, whiteSpace: 'nowrap' }}>
                        {tierLabel(r.modelTier)}
                      </strong>
                      {r.combinedScore > 0 && (
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                          {r.combinedScore.toFixed(0)}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>-</span>
                  )}
                </td>
                <td>
                  {r.percentile > 0 ? (
                    <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                      {r.percentile}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>-</span>
                  )}
                </td>
                <td style={{ fontSize: 12, fontWeight: 600, color: r.zapScore >= 75 ? '#22c55e' : r.zapScore >= 60 ? '#4ade80' : r.zapScore >= 40 ? '#facc15' : r.zapScore > 0 ? '#fb923c' : 'var(--text-muted)' }}>
                  {r.zapScore > 0 ? r.zapScore.toFixed(1) : '-'}
                </td>
                <td style={{ textAlign: 'center', fontSize: 11, fontWeight: 600, color: r.boomProb > 30 ? '#22c55e' : r.boomProb > 15 ? '#a3e635' : 'var(--text-muted)' }}>
                  {r.boomProb > 0 ? `${r.boomProb.toFixed(0)}%` : '-'}
                </td>
                <td style={{ textAlign: 'center', fontSize: 11, fontWeight: 600, color: r.bustProb > 30 ? '#ef4444' : r.bustProb > 15 ? '#fb923c' : 'var(--text-muted)' }}>
                  {r.bustProb > 0 ? `${r.bustProb.toFixed(0)}%` : '-'}
                </td>
                {activeThresholds.map(t => {
                  const prob = r.thresholdProbs?.[t];
                  const hasProb = prob != null && prob > 0 && r.predictedCareerPPG > 0;
                  return (
                    <td key={t} style={{
                      textAlign: 'center', fontSize: 12, fontWeight: 600, padding: '4px 3px',
                      background: hasProb ? probBg(prob) : undefined,
                      color: hasProb ? probColor(prob) : 'var(--text-muted)',
                    }}>
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
    </>
  );
}
