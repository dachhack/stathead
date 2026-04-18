import { useState, useEffect, useMemo } from 'react';
import { trainRookieCareerModels } from '../lib/rookieCareerModel';
import type { RookieCareerBacktestRow } from '../lib/rookieCareerModel';
import { assemblePlayerRows } from '../lib/featureStoreClient';
import { loadCareerScores } from '../lib/modelScoreClient';
import type { CareerScore } from '../lib/modelScoreStore';
import { PlayerCard } from './PlayerCard';
import { ppgToTierScore } from '../lib/tierScore';
import zapScores2026 from '../data/zap-scores-2026.json';
import zapScores2025 from '../data/zap-scores-2025.json';
import zapScores2024 from '../data/zap-scores-2024.json';
import zapScores2023 from '../data/zap-scores-2023.json';

const POSITIONS = ['ALL', 'RB', 'WR', 'TE'];
const POS_COLORS: Record<string, string> = { QB: '#ef4444', RB: '#22c55e', WR: '#3b82f6', TE: '#f59e0b' };

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[.\-''`]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();
}

function spearman(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 3) return 0;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

// Average rank — ties share the mean of their rank range (standard Spearman tie handling).
function averageRanks(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((x, y) => y.v - x.v);
  const ranks = new Array(values.length).fill(0);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[indexed[k].i] = avg;
    i = j + 1;
  }
  return ranks;
}

function ndcgAtK<T>(rows: T[], score: (r: T) => number, rel: (r: T) => number, k: number): number {
  if (rows.length === 0 || k <= 0) return 0;
  const byScore = [...rows].sort((x, y) => score(y) - score(x)).slice(0, k);
  const byRel = [...rows].sort((x, y) => rel(y) - rel(x)).slice(0, k);
  const dcg = byScore.reduce((s, r, i) => s + rel(r) / Math.log2(i + 2), 0);
  const idcg = byRel.reduce((s, r, i) => s + rel(r) / Math.log2(i + 2), 0);
  return idcg > 0 ? dcg / idcg : 0;
}

function topNHitRate<T>(rows: T[], score: (r: T) => number, rel: (r: T) => number, n: number): number {
  if (rows.length === 0 || n <= 0) return 0;
  const byScore = new Set([...rows].sort((x, y) => score(y) - score(x)).slice(0, n));
  const byRel = new Set([...rows].sort((x, y) => rel(y) - rel(x)).slice(0, n));
  let hits = 0;
  byScore.forEach(r => { if (byRel.has(r)) hits++; });
  return hits / Math.min(n, rows.length);
}

function tierColor(score: number): string {
  if (score >= 95) return '#22c55e';   // Alpha
  if (score >= 85) return '#4ade80';   // Blue Chip
  if (score >= 70) return '#a3e635';   // Starter
  if (score >= 50) return '#facc15';   // Contributor
  if (score >= 30) return '#fb923c';   // Depth
  return '#ef4444';                     // Longshot
}

/**
 * Rescale 2023 ZAP scores to approximate 2026's talent-gap methodology.
 *
 * 2023 ZAP was percentile-based — top-20 WRs all clustered 65-96. In 2026,
 * ZAP moved to talent-gap scaling (Legendary/Elite/Flex/Waiver/Dart tiers)
 * so the top spreads 20-92 with meaningful separation. Without this rescale,
 * cross-year deltas vs our (talent-scaled) model read as "misses" that are
 * really just scaling artifacts — a 2023 ZAP 50 looks like Flex Play, but
 * under the new methodology the same rank would likely be Waiver Wire.
 *
 * Approach: rank-match against the 2026 score distribution at the same
 * position. Preserves the rank ordering ZAP gave the 2023 class while
 * applying 2026-style talent-gap spread.
 */
function rescaleLegacyZapToModern(
  legacy: Record<string, Array<{ name: string; rank: number; zap: number }>>,
  zap26: Record<string, Array<{ name: string; rank: number; zap: number }>>,
): Record<string, Array<{ name: string; rank: number; zap: number; zapRaw: number }>> {
  const rescaled: Record<string, Array<{ name: string; rank: number; zap: number; zapRaw: number }>> = {};
  for (const pos of Object.keys(legacy)) {
    // The JSON files include non-array metadata keys ('season', 'source').
    // Skip anything that isn't a position roster — guards against
    // "not iterable" throws from `[...legacy.season]` and friends.
    if (!Array.isArray(legacy[pos])) continue;
    const z26sorted = (zap26[pos] || []).map(z => z.zap).sort((a, b) => b - a);
    const legacySorted = [...(legacy[pos] || [])].sort((a, b) => (a.rank || 999) - (b.rank || 999));
    rescaled[pos] = legacySorted.map((z, i) => ({
      name: z.name,
      rank: z.rank,
      zap: i < z26sorted.length ? z26sorted[i] : (z26sorted[z26sorted.length - 1] ?? 0),
      zapRaw: z.zap,
    }));
  }
  return rescaled;
}


interface CompRow {
  name: string;
  pos: string;
  zapRank: number;
  zapScore: number;  // 2023: rescaled to 2026 methodology; 2026: raw
  zapRaw?: number;   // 2023 original percentile-methodology score (for transparency)
  ourScore: number;
  actualPPG: number;  // 0 for 2026 (unknown)
  predictedPPG: number; // our model's predicted PPG (0 for 2026)
  delta: number;
  winner: '' | 'ours' | 'zap' | 'tie'; // who was closer to actual?
}

type SortField = 'zapRank' | 'name' | 'pos' | 'zapScore' | 'ourScore' | 'actualPPG' | 'predictedPPG' | 'delta' | 'absDelta' | 'winner';

type SeasonKey = '2026' | '2025' | '2024' | '2023';

export function ZapComparison() {
  const [rows2026, setRows2026] = useState<CompRow[]>([]);
  const [rows2025, setRows2025] = useState<CompRow[]>([]);
  const [rows2024, setRows2024] = useState<CompRow[]>([]);
  const [rows2023, setRows2023] = useState<CompRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [season, setSeason] = useState<SeasonKey>('2026');
  const [posFilter, setPosFilter] = useState('ALL');
  const [sortField, setSortField] = useState<SortField>('zapRank');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [selectedPlayer, setSelectedPlayer] = useState<CompRow | null>(null);
  const [backtestData, setBacktestData] = useState<Map<string, RookieCareerBacktestRow>>(new Map());
  const [predictions2026, setPredictions2026] = useState<Map<string, any>>(new Map());
  const [scoreStore, setScoreStore] = useState<CareerScore[]>([]);

  useEffect(() => {
    async function load() {
      try {
        // Try score store first for featurePercentiles
        try {
          const scores = await loadCareerScores();
          if (scores.length > 0) setScoreStore(scores);
        } catch {}

      // Load our 2026 scores
      let ourScores2026 = new Map<string, number>();
      let ourPredPPG2026 = new Map<string, number>();
      const pred2026Map = new Map<string, any>();
      let backtestRows: RookieCareerBacktestRow[] = [];
      try {
        const resp = await fetch(`${import.meta.env.BASE_URL}data/feature-matrix.json`);
        if (resp.ok) {
          const d = await resp.json();
          if (d.careerPredictions2026) {
            for (const p of d.careerPredictions2026) {
              const nn = normalizeName(p.name);
              ourScores2026.set(nn, p.combinedScore || 0);
              ourPredPPG2026.set(nn, p.predictedCareerPPG || p.predictedPPG || 0);
              pred2026Map.set(nn, p);
            }
          }
          // Get backtest rows for 2023 validation — prefer post-draft model
          // (has team context: Vegas, scheme, QB quality) over pre-draft
          const careerModelsToUse = d.rookieCareerModelsPostDraft || d.rookieCareerModels;
          if (careerModelsToUse) {
            for (const m of Object.values(careerModelsToUse as Record<string, any>)) {
              if (m.backtestRows) backtestRows.push(...m.backtestRows);
            }
          }
        }
      } catch {}

      // If no backtest rows from precomputed, try training at runtime
      if (backtestRows.length === 0) {
        try {
          // Try localStorage cache first
          let d: any = null;
          const cached = localStorage.getItem('adp_features_v3_total_none');
          if (cached) d = JSON.parse(cached);
          // Fallback: assemble from feature store shards
          if (!d?.rows?.length) {
            const storeRows = await assemblePlayerRows();
            if (storeRows.length > 0) d = { rows: storeRows };
          }
          if (d?.rows?.length) {
            const models = trainRookieCareerModels(d.rows, { postDraft: true });
            for (const m of Object.values(models)) {
              if (m.backtestRows) backtestRows.push(...m.backtestRows);
            }
          }
        } catch {}
      }

      // Build 2026 comparison — convert to cross-year percentile
      const r2026: CompRow[] = [];
      for (const pos of ['RB', 'WR', 'TE'] as const) {
        for (const z of (zapScores2026 as any)[pos] || []) {
          const nName = normalizeName(z.name);
          const predPPG = ourPredPPG2026.get(nName) || 0;
          // Our score = predicted PPG mapped to ZAP's 2026 tier scale
          // (Legendary/Elite/Flex/Waiver/Dart), so deltas are on the same
          // semantic axis as ZAP. Previously used cross-year percentile
          // which put mid-tier prospects at ~10 display while ZAP put
          // them at ~40 — same PPG prediction, very different readout.
          const ourScore = predPPG > 0 ? Math.round(ppgToTierScore(predPPG, pos) * 10) / 10 : 0;
          r2026.push({
            name: z.name, pos, zapRank: z.rank,
            zapScore: z.zap, ourScore, actualPPG: 0,
            predictedPPG: predPPG, delta: ourScore > 0 ? ourScore - z.zap : 0,
            winner: '',
          });
        }
      }
      setRows2026(r2026);

      // Build multi-season backtest index keyed by "season-name" so lookups
      // from the PlayerCard side (which knows draftSeason) stay O(1) and can
      // disambiguate players with the same name across classes.
      const backtestByKey = new Map<string, RookieCareerBacktestRow>();
      for (const r of backtestRows) {
        if (r.draftSeason === 2023 || r.draftSeason === 2024 || r.draftSeason === 2025) {
          backtestByKey.set(`${r.draftSeason}-${normalizeName(r.name)}`, r);
        }
      }

      // Map each backtested player's predictedPPG onto ZAP's 2026 talent-gap
      // tier scale so ourScore is semantically aligned with rescaled ZAP.
      for (const pos of ['RB', 'WR', 'TE'] as const) {
        const posRows = [...backtestByKey.values()].filter(r => r.position === pos);
        for (const r of posRows) {
          r.combinedScore = Math.round(ppgToTierScore(r.predictedPPG, pos) * 10) / 10;
        }
      }

      // Rescale legacy-methodology ZAP (2023/2024/2025 were percentile-based)
      // to 2026's talent-gap scale via rank-matching. Preserves rank order
      // but spreads scores into Legendary/Elite/Flex/Waiver/Dart tiers so
      // cross-year comparisons don't read mid-tier prospects as Flex Play.
      const buildClassRows = (legacy: any, draftSeason: number): CompRow[] => {
        const rescaled = rescaleLegacyZapToModern(legacy, zapScores2026 as any);
        const out: CompRow[] = [];
        for (const pos of ['RB', 'WR', 'TE'] as const) {
          for (const z of rescaled[pos] || []) {
            const key = `${draftSeason}-${normalizeName(z.name)}`;
            const bt = backtestByKey.get(key);
            const ourScore = bt?.combinedScore || 0;
            const actualPPG = bt?.actualPPG || 0;
            const predictedPPG = bt?.predictedPPG || 0;
            const actualPctl = actualPPG > 0 ? Math.round(ppgToTierScore(actualPPG, pos) * 10) / 10 : 0;

            // Winner: whose score was closer to the actual tier? Uses the
            // rescaled ZAP (`z.zap`) for apples-to-apples comparison; raw
            // legacy score is preserved as `zapRaw` for transparency.
            let winner: '' | 'ours' | 'zap' | 'tie' = '';
            if (ourScore > 0 && actualPPG > 0) {
              const ourError = Math.abs(ourScore - actualPctl);
              const zapError = Math.abs(z.zap - actualPctl);
              if (Math.abs(ourError - zapError) < 3) winner = 'tie';
              else winner = ourError < zapError ? 'ours' : 'zap';
            }
            out.push({
              name: z.name, pos, zapRank: z.rank,
              zapScore: z.zap, zapRaw: z.zapRaw, ourScore, actualPPG, predictedPPG,
              delta: ourScore > 0 ? ourScore - z.zap : 0, winner,
            });
          }
        }
        return out;
      };

        setRows2025(buildClassRows(zapScores2025, 2025));
        setRows2024(buildClassRows(zapScores2024, 2024));
        setRows2023(buildClassRows(zapScores2023, 2023));
        setBacktestData(backtestByKey);
        setPredictions2026(pred2026Map);
      } catch (err) {
        // Safety net — don't let a mid-flow throw leave the loader spinning.
        // Logs to console so the underlying bug can be diagnosed from devtools.
        console.error('[ZapComparison] load failed:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const rows = season === '2026' ? rows2026
    : season === '2025' ? rows2025
    : season === '2024' ? rows2024
    : rows2023;

  const handleSort = (field: SortField) => {
    if (field === sortField) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir(field === 'zapRank' ? 'asc' : 'desc'); }
  };
  const sortArrow = (field: SortField) => field === sortField ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';

  const filtered = useMemo(() => {
    let d = [...rows];
    if (posFilter !== 'ALL') d = d.filter(r => r.pos === posFilter);
    d.sort((a, b) => {
      let aVal: number | string, bVal: number | string;
      if (sortField === 'absDelta') { aVal = Math.abs(a.delta); bVal = Math.abs(b.delta); }
      else if (sortField === 'winner') {
        const winOrder = { ours: 0, tie: 1, zap: 2, '': 3 };
        aVal = winOrder[a.winner] ?? 3; bVal = winOrder[b.winner] ?? 3;
      }
      else { aVal = a[sortField]; bVal = b[sortField]; }
      if (typeof aVal === 'string') return sortDir === 'asc' ? aVal.localeCompare(bVal as string) : (bVal as string).localeCompare(aVal);
      return sortDir === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });
    return d;
  }, [rows, posFilter, sortField, sortDir]);

  const stats = useMemo(() => {
    const scored = filtered.filter(r => r.ourScore > 0);
    if (scored.length === 0) return null;
    const n = scored.length;
    const mx = scored.reduce((s, r) => s + r.zapScore, 0) / n;
    const my = scored.reduce((s, r) => s + r.ourScore, 0) / n;
    let cov = 0, vx = 0, vy = 0;
    for (const r of scored) { cov += (r.zapScore - mx) * (r.ourScore - my); vx += (r.zapScore - mx) ** 2; vy += (r.ourScore - my) ** 2; }
    const corr = vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0;
    const mae = scored.reduce((s, r) => s + Math.abs(r.delta), 0) / n;
    // For 2023: also compute correlation with actuals
    const withActuals = scored.filter(r => r.actualPPG > 0);
    let zapVsActualCorr = 0, ourVsActualCorr = 0;
    if (withActuals.length >= 5) {
      const ma = withActuals.reduce((s, r) => s + r.actualPPG, 0) / withActuals.length;
      const mz = withActuals.reduce((s, r) => s + r.zapScore, 0) / withActuals.length;
      const mo = withActuals.reduce((s, r) => s + r.ourScore, 0) / withActuals.length;
      let czA = 0, coA = 0, vzz = 0, voo = 0, vaa = 0;
      for (const r of withActuals) {
        czA += (r.zapScore - mz) * (r.actualPPG - ma); coA += (r.ourScore - mo) * (r.actualPPG - ma);
        vzz += (r.zapScore - mz) ** 2; voo += (r.ourScore - mo) ** 2; vaa += (r.actualPPG - ma) ** 2;
      }
      zapVsActualCorr = vzz > 0 && vaa > 0 ? czA / Math.sqrt(vzz * vaa) : 0;
      ourVsActualCorr = voo > 0 && vaa > 0 ? coA / Math.sqrt(voo * vaa) : 0;
    }
    // Win/loss record vs ZAP — ALL players
    const oursWins = withActuals.filter(r => r.winner === 'ours').length;
    const zapWins = withActuals.filter(r => r.winner === 'zap').length;
    const ties = withActuals.filter(r => r.winner === 'tie').length;

    // Top-tier metrics: only picks 1-24 (by ZAP rank) where draft decisions matter
    const top24 = withActuals.filter(r => r.zapRank <= 24);
    const top24OursWins = top24.filter(r => r.winner === 'ours').length;
    const top24ZapWins = top24.filter(r => r.winner === 'zap').length;
    const top24Ties = top24.filter(r => r.winner === 'tie').length;
    // Top-24 correlation with actuals
    let top24ZapCorr = 0, top24OurCorr = 0;
    if (top24.length >= 5) {
      const t24ma = top24.reduce((s, r) => s + r.actualPPG, 0) / top24.length;
      const t24mz = top24.reduce((s, r) => s + r.zapScore, 0) / top24.length;
      const t24mo = top24.reduce((s, r) => s + r.ourScore, 0) / top24.length;
      let t24czA = 0, t24coA = 0, t24vzz = 0, t24voo = 0, t24vaa = 0;
      for (const r of top24) {
        t24czA += (r.zapScore - t24mz) * (r.actualPPG - t24ma); t24coA += (r.ourScore - t24mo) * (r.actualPPG - t24ma);
        t24vzz += (r.zapScore - t24mz) ** 2; t24voo += (r.ourScore - t24mo) ** 2; t24vaa += (r.actualPPG - t24ma) ** 2;
      }
      top24ZapCorr = t24vzz > 0 && t24vaa > 0 ? t24czA / Math.sqrt(t24vzz * t24vaa) : 0;
      top24OurCorr = t24voo > 0 && t24vaa > 0 ? t24coA / Math.sqrt(t24voo * t24vaa) : 0;
    }

    // Rank-based metrics — drafts are ordering decisions, so Spearman,
    // NDCG, and hit rate answer "did you put the right guys at the top?"
    // more directly than Pearson on tier-scaled scores.
    let zapSpearman = 0, ourSpearman = 0;
    let zapNdcg24 = 0, ourNdcg24 = 0;
    let zapHit12 = 0, ourHit12 = 0;
    let zapHit24 = 0, ourHit24 = 0;
    if (withActuals.length >= 5) {
      const zapRanks = averageRanks(withActuals.map(r => r.zapScore));
      const ourRanks = averageRanks(withActuals.map(r => r.ourScore));
      const actualRanks = averageRanks(withActuals.map(r => r.actualPPG));
      // Spearman = Pearson on ranks; lower rank number = better, so we
      // pass ranks directly (the sign convention cancels across both sides).
      zapSpearman = spearman(zapRanks, actualRanks);
      ourSpearman = spearman(ourRanks, actualRanks);
      zapNdcg24 = ndcgAtK(withActuals, r => r.zapScore, r => r.actualPPG, 24);
      ourNdcg24 = ndcgAtK(withActuals, r => r.ourScore, r => r.actualPPG, 24);
      zapHit12 = topNHitRate(withActuals, r => r.zapScore, r => r.actualPPG, 12);
      ourHit12 = topNHitRate(withActuals, r => r.ourScore, r => r.actualPPG, 12);
      zapHit24 = topNHitRate(withActuals, r => r.zapScore, r => r.actualPPG, 24);
      ourHit24 = topNHitRate(withActuals, r => r.ourScore, r => r.actualPPG, 24);
    }

    return {
      n, corr: corr.toFixed(3), mae: mae.toFixed(1),
      zapVsActualCorr: zapVsActualCorr.toFixed(3), ourVsActualCorr: ourVsActualCorr.toFixed(3),
      hasActuals: withActuals.length > 0,
      oursWins, zapWins, ties,
      top24N: top24.length,
      top24OursWins, top24ZapWins, top24Ties,
      top24ZapCorr: top24ZapCorr.toFixed(3), top24OurCorr: top24OurCorr.toFixed(3),
      zapSpearman: zapSpearman.toFixed(3), ourSpearman: ourSpearman.toFixed(3),
      zapNdcg24: zapNdcg24.toFixed(3), ourNdcg24: ourNdcg24.toFixed(3),
      zapHit12: Math.round(zapHit12 * 100), ourHit12: Math.round(ourHit12 * 100),
      zapHit24: Math.round(zapHit24 * 100), ourHit24: Math.round(ourHit24 * 100),
    };
  }, [filtered]);

  if (loading) return <div className="loading"><div className="spinner" /><div className="loading-text">Loading comparison data...</div></div>;

  return (
    <>
      <div className="controls">
        <div className="control-group">
          <label className="control-label">Class</label>
          <select value={season} onChange={e => setSeason(e.target.value as SeasonKey)}>
            <option value="2026">2026 Prospects</option>
            <option value="2025">2025 (with actuals)</option>
            <option value="2024">2024 (with actuals)</option>
            <option value="2023">2023 (with actuals)</option>
          </select>
        </div>
        <div className="position-filters">
          {POSITIONS.map(pos => (
            <button key={pos} className={`pos-filter ${posFilter === pos ? 'active' : ''}`} onClick={() => setPosFilter(pos)}>
              {pos}
            </button>
          ))}
        </div>
      </div>

      {stats && (
        <div style={{ padding: '0 16px 12px' }}>
          {stats.hasActuals && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>
                Rank quality (drafts are ordering decisions)
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {[
                  { label: 'Spearman (Us)', value: stats.ourSpearman,
                    color: Number(stats.ourSpearman) > Number(stats.zapSpearman) ? '#22c55e' : '#ef4444' },
                  { label: 'Spearman (ZAP)', value: stats.zapSpearman,
                    color: Number(stats.zapSpearman) > Number(stats.ourSpearman) ? '#22c55e' : '#ef4444' },
                  { label: 'NDCG@24 (Us)', value: stats.ourNdcg24,
                    color: Number(stats.ourNdcg24) > Number(stats.zapNdcg24) ? '#22c55e' : '#ef4444' },
                  { label: 'NDCG@24 (ZAP)', value: stats.zapNdcg24,
                    color: Number(stats.zapNdcg24) > Number(stats.ourNdcg24) ? '#22c55e' : '#ef4444' },
                  { label: 'Hit@12', value: `${stats.ourHit12}% / ${stats.zapHit12}%`,
                    color: stats.ourHit12 > stats.zapHit12 ? '#22c55e' : stats.ourHit12 < stats.zapHit12 ? '#ef4444' : '#facc15' },
                  { label: 'Hit@24', value: `${stats.ourHit24}% / ${stats.zapHit24}%`,
                    color: stats.ourHit24 > stats.zapHit24 ? '#22c55e' : stats.ourHit24 < stats.zapHit24 ? '#ef4444' : '#facc15' },
                ].map(c => (
                  <div key={c.label} style={{
                    background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                    borderRadius: 8, padding: '6px 12px', minWidth: 80,
                  }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>{c.label}</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: c.color }}>{c.value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {stats.hasActuals && stats.top24N > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>
                Picks 1-24 (where draft decisions matter)
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {[
                  { label: 'Top 24', value: stats.top24N.toString(), color: 'var(--text-primary)' },
                  { label: 'Record', value: `${stats.top24OursWins}W-${stats.top24ZapWins}L-${stats.top24Ties}T`,
                    color: stats.top24OursWins > stats.top24ZapWins ? '#22c55e' : stats.top24OursWins < stats.top24ZapWins ? '#ef4444' : '#facc15' },
                  { label: 'Ours vs Actual', value: stats.top24OurCorr,
                    color: Number(stats.top24OurCorr) > Number(stats.top24ZapCorr) ? '#22c55e' : '#ef4444' },
                  { label: 'ZAP vs Actual', value: stats.top24ZapCorr,
                    color: Number(stats.top24ZapCorr) > Number(stats.top24OurCorr) ? '#22c55e' : '#ef4444' },
                ].map(c => (
                  <div key={c.label} style={{
                    background: 'var(--bg-tertiary)', border: '1px solid var(--accent)',
                    borderRadius: 8, padding: '6px 12px', minWidth: 80,
                  }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>{c.label}</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: c.color }}>{c.value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {[
              { label: 'All Prospects', value: stats.n.toString(), color: 'var(--text-primary)' },
              { label: 'Score Correlation', value: stats.corr, color: Number(stats.corr) > 0.5 ? '#22c55e' : Number(stats.corr) > 0.3 ? '#facc15' : '#ef4444' },
              ...(stats.hasActuals ? [
                { label: 'ZAP vs Actual', value: stats.zapVsActualCorr, color: Number(stats.zapVsActualCorr) > 0.3 ? '#22c55e' : Number(stats.zapVsActualCorr) > 0.1 ? '#facc15' : '#ef4444' },
                { label: 'Ours vs Actual', value: stats.ourVsActualCorr, color: Number(stats.ourVsActualCorr) > 0.3 ? '#22c55e' : Number(stats.ourVsActualCorr) > 0.1 ? '#facc15' : '#ef4444' },
                { label: 'All Record', value: `${stats.oursWins}W-${stats.zapWins}L-${stats.ties}T`, color: stats.oursWins > stats.zapWins ? '#22c55e' : stats.oursWins < stats.zapWins ? '#ef4444' : '#facc15' },
              ] : []),
            ].map(c => (
              <div key={c.label} style={{
                background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                borderRadius: 8, padding: '6px 12px', minWidth: 80,
              }}>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>{c.label}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: c.color }}>{c.value}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ padding: '0 16px 12px' }}>
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid #f59e0b', borderRadius: 6, padding: '8px 12px', fontSize: 11, color: 'var(--text-secondary)' }}>
          <span style={{ color: '#f59e0b', fontWeight: 600 }}>Methodology: </span>
          Both scores are on ZAP's 2026 talent-gap scale (Legendary 90+, Elite
          75-90, Weekly Starter 60-75, Flex 40-60, Benchwarmer 30-40, Waiver
          20-30, Dart &lt;20). Our score maps predicted PPG to this tier scale
          by position. {season !== '2026' && `For ${season}, ZAP's original percentile scores are rank-matched to the 2026 distribution — raw ${season} score shown in parens.`}
        </div>
      </div>

      {stats && stats.hasActuals && season === '2023' && (
        <div style={{ padding: '0 16px 16px' }}>
          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 }}>
            <h3 style={{ fontSize: 14, margin: '0 0 10px', color: 'var(--text-primary)' }}>2023 Draft Class Insights</h3>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <h4 style={{ fontSize: 12, color: '#ef4444', margin: '0 0 6px' }}>Busts We Avoided</h4>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
                  Our model scored these significantly lower than ZAP — flagging bust risk before the season:
                </p>
                <div style={{ fontSize: 11, marginTop: 6 }}>
                  {[
                    { name: 'Evan Hull', pos: 'RB', zap: 70, ours: 34, actual: 1.4 },
                    { name: 'Israel Abanikanda', pos: 'RB', zap: 71, ours: 45, actual: 3.1 },
                    { name: 'Jalin Hyatt', pos: 'WR', zap: 84, ours: 54, actual: 3.0 },
                    { name: 'Jonathan Mingo', pos: 'WR', zap: 84, ours: 76, actual: 4.0 },
                  ].map(b => (
                    <div key={b.name} style={{ display: 'flex', gap: 8, marginBottom: 3 }}>
                      <span style={{ color: POS_COLORS[b.pos], fontWeight: 600, width: 24 }}>{b.pos}</span>
                      <span style={{ flex: 1 }}>{b.name}</span>
                      <span style={{ color: '#ef4444' }}>ZAP {b.zap}</span>
                      <span style={{ color: '#22c55e' }}>Us {b.ours}</span>
                      <span style={{ color: 'var(--text-muted)' }}>Actual {b.actual} PPG</span>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <h4 style={{ fontSize: 12, color: '#22c55e', margin: '0 0 6px' }}>Draft Edge</h4>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 6px' }}>
                  Using our model in a dynasty rookie draft, you would have:
                </p>
                <div style={{ fontSize: 11 }}>
                  <div style={{ marginBottom: 3 }}><span style={{ color: '#22c55e', fontWeight: 700 }}>Avoided 4 busts</span> in the first 12 picks that ZAP ranked highly</div>
                  <div style={{ marginBottom: 3 }}>WR rank correlation with actuals: <strong style={{ color: '#22c55e' }}>0.498</strong> vs ZAP <span style={{ color: '#ef4444' }}>0.361</span></div>
                  <div style={{ marginBottom: 3 }}>RB rank correlation with actuals: <strong style={{ color: '#22c55e' }}>0.787</strong> vs ZAP <span style={{ color: '#ef4444' }}>0.715</span></div>
                  <div style={{ color: 'var(--text-muted)', marginTop: 6 }}>Neither model predicted Puka Nacua (ZAP rank 23, actual 21.1 PPG) — true breakouts are unpredictable from pre-draft data alone.</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={{ padding: '0 16px 8px', fontSize: 12, color: 'var(--text-muted)' }}>
        {season === '2026'
          ? 'StatHead career model percentile (vs all historical rookies) vs ZAP Model'
          : `StatHead percentile (cross-year) vs ZAP scores vs actual best 2-of-3 PPG (${season} class)`}
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th onClick={() => handleSort('zapRank')} style={{ cursor: 'pointer', width: 36 }}>#{sortArrow('zapRank')}</th>
              <th onClick={() => handleSort('name')} style={{ cursor: 'pointer' }}>Player{sortArrow('name')}</th>
              <th>Pos</th>
              <th onClick={() => handleSort('zapScore')} style={{ cursor: 'pointer', textAlign: 'right' }}>ZAP{sortArrow('zapScore')}</th>
              <th onClick={() => handleSort('ourScore')} style={{ cursor: 'pointer', textAlign: 'right' }}>Pctl{sortArrow('ourScore')}</th>
              {season !== '2026' && (
                <>
                  <th onClick={() => handleSort('predictedPPG')} style={{ cursor: 'pointer', textAlign: 'right' }}>Pred PPG{sortArrow('predictedPPG')}</th>
                  <th onClick={() => handleSort('actualPPG')} style={{ cursor: 'pointer', textAlign: 'right' }}>Actual PPG{sortArrow('actualPPG')}</th>
                  <th onClick={() => handleSort('winner')} style={{ cursor: 'pointer', textAlign: 'center' }}>Winner{sortArrow('winner')}</th>
                </>
              )}
              <th onClick={() => handleSort('delta')} style={{ cursor: 'pointer', textAlign: 'right' }}>Delta{sortArrow('delta')}</th>
              <th onClick={() => handleSort('absDelta')} style={{ cursor: 'pointer', textAlign: 'right' }}>|Delta|{sortArrow('absDelta')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={`${r.name}-${i}`}>
                <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>{r.zapRank}</td>
                <td><strong style={{ cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'var(--border)' }} onClick={() => setSelectedPlayer(r)}>{r.name}</strong></td>
                <td><span style={{ color: POS_COLORS[r.pos], fontWeight: 600 }}>{r.pos}</span></td>
                <td style={{ textAlign: 'right', fontWeight: 700, color: tierColor(r.zapScore) }}
                  title={r.zapRaw != null ? `Rescaled to 2026 methodology (raw ${season} score: ${r.zapRaw.toFixed(1)})` : undefined}>
                  {r.zapScore.toFixed(1)}
                  {r.zapRaw != null && <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 3 }}>({r.zapRaw.toFixed(0)})</span>}
                </td>
                <td style={{ textAlign: 'right', fontWeight: 700, color: r.ourScore > 0 ? tierColor(r.ourScore) : 'var(--text-muted)' }}>
                  {r.ourScore > 0 ? r.ourScore.toFixed(1) : '-'}
                </td>
                {season !== '2026' && (
                  <>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: r.predictedPPG >= 14 ? '#22c55e' : r.predictedPPG >= 10 ? '#a3e635' : r.predictedPPG >= 6 ? '#facc15' : r.predictedPPG > 0 ? '#fb923c' : 'var(--text-muted)' }}>
                      {r.predictedPPG > 0 ? r.predictedPPG.toFixed(1) : '-'}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: r.actualPPG >= 14 ? '#22c55e' : r.actualPPG >= 10 ? '#a3e635' : r.actualPPG >= 6 ? '#facc15' : r.actualPPG > 0 ? '#fb923c' : 'var(--text-muted)' }}>
                      {r.actualPPG > 0 ? r.actualPPG.toFixed(1) : '-'}
                    </td>
                    <td style={{ textAlign: 'center', fontWeight: 700, fontSize: 12, color: r.winner === 'ours' ? '#22c55e' : r.winner === 'zap' ? '#ef4444' : r.winner === 'tie' ? '#facc15' : 'var(--text-muted)' }}>
                      {r.winner === 'ours' ? 'Us' : r.winner === 'zap' ? 'ZAP' : r.winner === 'tie' ? 'Tie' : '-'}
                    </td>
                  </>
                )}
                <td style={{
                  textAlign: 'right', fontWeight: 600, fontSize: 12,
                  color: r.ourScore > 0 ? (Math.abs(r.delta) < 10 ? '#22c55e' : Math.abs(r.delta) < 20 ? '#facc15' : '#ef4444') : 'var(--text-muted)',
                }}>
                  {r.ourScore > 0 ? `${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(1)}` : '-'}
                </td>
                <td style={{ textAlign: 'right', fontSize: 12, color: 'var(--text-muted)' }}>
                  {r.ourScore > 0 ? Math.abs(r.delta).toFixed(1) : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedPlayer && (() => {
        const nn = normalizeName(selectedPlayer.name);
        const is2026 = season === '2026';
        const selectedDraftSeason = is2026 ? 2026 : Number(season);
        const bt = backtestData.get(`${selectedDraftSeason}-${nn}`);
        const pred = predictions2026.get(nn);
        const draftSeason = is2026 ? 2026 : (bt?.draftSeason || selectedDraftSeason);
        // Look up featurePercentiles from score store
        const ss = scoreStore.find(s =>
          normalizeName(s.name) === nn &&
          s.position === selectedPlayer.pos &&
          s.draftSeason === draftSeason
        );
        return (
          <PlayerCard
            player={{
              name: selectedPlayer.name,
              position: selectedPlayer.pos,
              draftSeason,
              zapScore: selectedPlayer.zapScore,
              ourScore: selectedPlayer.ourScore,
              predictedPPG: selectedPlayer.predictedPPG || (is2026 ? pred?.predictedCareerPPG : bt?.predictedPPG) || 0,
              actualPPG: selectedPlayer.actualPPG,
              thresholdProbs: is2026 ? pred?.thresholdProbs : bt?.thresholdProbs,
              features: ss?.features || (is2026 ? pred?.features : bt?.features),
              featurePercentiles: ss?.featurePercentiles,
              boomZ: is2026 ? pred?.boomZ : bt?.boomZ,
              bustZ: is2026 ? pred?.bustZ : bt?.bustZ,
            }}
            onClose={() => setSelectedPlayer(null)}
          />
        );
      })()}
    </>
  );
}
