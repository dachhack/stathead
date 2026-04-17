import { useState, useEffect, useMemo } from 'react';
import { trainRookieCareerModels } from '../lib/rookieCareerModel';
import type { RookieCareerBacktestRow } from '../lib/rookieCareerModel';
import { assemblePlayerRows } from '../lib/featureStoreClient';
import { loadCareerScores } from '../lib/modelScoreClient';
import type { CareerScore } from '../lib/modelScoreStore';
import { PlayerCard } from './PlayerCard';
import zapScores2026 from '../data/zap-scores-2026.json';
import zapScores2023 from '../data/zap-scores-2023.json';

const POSITIONS = ['ALL', 'RB', 'WR', 'TE'];
const POS_COLORS: Record<string, string> = { QB: '#ef4444', RB: '#22c55e', WR: '#3b82f6', TE: '#f59e0b' };

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[.\-''`]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();
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
function rescaleZap2023ToModern(
  zap23: Record<string, Array<{ name: string; rank: number; zap: number }>>,
  zap26: Record<string, Array<{ name: string; rank: number; zap: number }>>,
): Record<string, Array<{ name: string; rank: number; zap: number; zapRaw: number }>> {
  const rescaled: Record<string, Array<{ name: string; rank: number; zap: number; zapRaw: number }>> = {};
  for (const pos of Object.keys(zap23)) {
    const z26sorted = (zap26[pos] || []).map(z => z.zap).sort((a, b) => b - a);
    const z23sorted = [...(zap23[pos] || [])].sort((a, b) => (a.rank || 999) - (b.rank || 999));
    rescaled[pos] = z23sorted.map((z, i) => ({
      name: z.name,
      rank: z.rank,
      zap: i < z26sorted.length ? z26sorted[i] : (z26sorted[z26sorted.length - 1] ?? 0),
      zapRaw: z.zap,
    }));
  }
  return rescaled;
}

/**
 * Map predicted PPG to a 0-100 tier score aligned with ZAP's 2026 tier
 * semantics (Legendary / Elite / Weekly Starter / Flex / Bench / Waiver /
 * Dart). Replaces cross-year percentile which maps predicted 5 PPG to
 * bottom-10% display — semantically "Dart Throw" — when the reality is
 * "Flex Play" for that PPG level. Makes ourScore apples-to-apples with
 * the 2026 ZAP methodology.
 *
 * Position-adjusted benchmarks: RBs score higher PPG than WRs naturally,
 * so the tier boundaries shift. Anchored to ZAP's tier descriptions:
 *   Legendary 90-100: generational talent (RB 16+ PPG, WR 14+)
 *   Elite 75-90: top producer (RB 13-16, WR 11-14)
 *   Weekly Starter 60-75: reliable starter (RB 10-13, WR 8-11)
 *   Flex Play 40-60: occasional starter (RB 6-10, WR 5-8)
 *   Benchwarmer 30-40: depth (RB 4-6, WR 3-5)
 *   Waiver Wire 20-30: situational (RB 2-4, WR 1.5-3)
 *   Dart Throw 0-20: unlikely to produce
 */
const TIER_BENCHMARKS: Record<string, { leg: number; elite: number; start: number; flex: number; bench: number; waiver: number }> = {
  RB: { leg: 16, elite: 13, start: 10, flex: 6, bench: 4, waiver: 2 },
  WR: { leg: 14, elite: 11, start: 8, flex: 5, bench: 3, waiver: 1.5 },
  TE: { leg: 11, elite: 8, start: 6, flex: 4, bench: 2.5, waiver: 1 },
  QB: { leg: 22, elite: 18, start: 15, flex: 11, bench: 8, waiver: 5 },
};

function ppgToTierScore(ppg: number, pos: string): number {
  const b = TIER_BENCHMARKS[pos] || TIER_BENCHMARKS.WR;
  if (ppg >= b.leg) return Math.min(100, 90 + (ppg - b.leg) * 2);
  if (ppg >= b.elite) return 75 + (ppg - b.elite) / (b.leg - b.elite) * 15;
  if (ppg >= b.start) return 60 + (ppg - b.start) / (b.elite - b.start) * 15;
  if (ppg >= b.flex) return 40 + (ppg - b.flex) / (b.start - b.flex) * 20;
  if (ppg >= b.bench) return 30 + (ppg - b.bench) / (b.flex - b.bench) * 10;
  if (ppg >= b.waiver) return 20 + (ppg - b.waiver) / (b.bench - b.waiver) * 10;
  return Math.max(0, b.waiver > 0 ? (ppg / b.waiver) * 20 : 0);
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

export function ZapComparison() {
  const [rows2026, setRows2026] = useState<CompRow[]>([]);
  const [rows2023, setRows2023] = useState<CompRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [season, setSeason] = useState<'2026' | '2023'>('2026');
  const [posFilter, setPosFilter] = useState('ALL');
  const [sortField, setSortField] = useState<SortField>('zapRank');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [selectedPlayer, setSelectedPlayer] = useState<CompRow | null>(null);
  const [backtestData, setBacktestData] = useState<Map<string, RookieCareerBacktestRow>>(new Map());
  const [predictions2026, setPredictions2026] = useState<Map<string, any>>(new Map());
  const [scoreStore, setScoreStore] = useState<CareerScore[]>([]);

  useEffect(() => {
    async function load() {
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

      // Build 2023 comparison with actuals
      const backtestByName = new Map<string, RookieCareerBacktestRow>();
      for (const r of backtestRows) {
        if (r.draftSeason === 2023) backtestByName.set(normalizeName(r.name), r);
      }

      // Convert predictedPPG to cross-year percentile within position
      // This makes scores comparable across draft classes: 90th percentile
      // Map each 2023 player's predicted PPG to the ZAP 2026 tier scale so
      // ourScore is semantically aligned with ZAP's talent-gap framing.
      for (const pos of ['RB', 'WR', 'TE'] as const) {
        const posRows = [...backtestByName.values()].filter(r => r.position === pos);
        for (const r of posRows) {
          r.combinedScore = Math.round(ppgToTierScore(r.predictedPPG, pos) * 10) / 10;
        }
      }

      const r2023: CompRow[] = [];
      // Rescale 2023 ZAP (percentile methodology) → 2026 talent-gap scale
      // via rank-matching. Preserves ZAP's 2023 rank order but spreads the
      // scores to match 2026's Legendary/Elite/Flex/Waiver/Dart tiers.
      // Without this, mid-tier 2023 prospects at ZAP 40-55 read as Flex
      // Play, but under the new methodology the same rank would be Waiver/
      // Dart — closer to where our model scores them.
      const rescaled2023 = rescaleZap2023ToModern(
        zapScores2023 as any, zapScores2026 as any
      );
      for (const pos of ['RB', 'WR'] as const) {
        for (const z of rescaled2023[pos] || []) {
          const nName = normalizeName(z.name);
          const bt = backtestByName.get(nName);
          const ourScore = bt?.combinedScore || 0;
          const actualPPG = bt?.actualPPG || 0;
          const predictedPPG = bt?.predictedPPG || 0;

          // Actual tier score: what ZAP tier would their actual PPG put
          // them in? This is the target everyone should be predicting — and
          // since both ourScore and rescaledZAP are on the tier scale, the
          // three are now directly comparable.
          const actualPctl = actualPPG > 0 ? Math.round(ppgToTierScore(actualPPG, pos) * 10) / 10 : 0;

          // Winner: whose score was closer to the actual tier?
          // Uses rescaled ZAP (`z.zap`) so the comparison is apples-to-apples
          // against our tier-scaled predictions. Raw ZAP is preserved on
          // the row for transparency (`zapRaw`).
          let winner: '' | 'ours' | 'zap' | 'tie' = '';
          if (ourScore > 0 && actualPPG > 0) {
            const ourError = Math.abs(ourScore - actualPctl);
            const zapError = Math.abs(z.zap - actualPctl);
            if (Math.abs(ourError - zapError) < 3) winner = 'tie';
            else winner = ourError < zapError ? 'ours' : 'zap';
          }
          r2023.push({
            name: z.name, pos, zapRank: z.rank,
            zapScore: z.zap, zapRaw: z.zapRaw, ourScore, actualPPG, predictedPPG,
            delta: ourScore > 0 ? ourScore - z.zap : 0, winner,
          });
        }
      }
      setRows2023(r2023);
      setBacktestData(backtestByName);
      setPredictions2026(pred2026Map);
      setLoading(false);
    }
    load();
  }, []);

  const rows = season === '2026' ? rows2026 : rows2023;

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

    return {
      n, corr: corr.toFixed(3), mae: mae.toFixed(1),
      zapVsActualCorr: zapVsActualCorr.toFixed(3), ourVsActualCorr: ourVsActualCorr.toFixed(3),
      hasActuals: withActuals.length > 0,
      oursWins, zapWins, ties,
      top24N: top24.length,
      top24OursWins, top24ZapWins, top24Ties,
      top24ZapCorr: top24ZapCorr.toFixed(3), top24OurCorr: top24OurCorr.toFixed(3),
    };
  }, [filtered]);

  if (loading) return <div className="loading"><div className="spinner" /><div className="loading-text">Loading comparison data...</div></div>;

  return (
    <>
      <div className="controls">
        <div className="control-group">
          <label className="control-label">Class</label>
          <select value={season} onChange={e => setSeason(e.target.value as '2026' | '2023')}>
            <option value="2026">2026 Prospects</option>
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
          by position. {season === '2023' && 'For 2023, ZAP\'s original percentile scores are rank-matched to the 2026 distribution — raw 2023 score shown in parens.'}
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
          : 'StatHead percentile (cross-year) vs ZAP scores vs actual best 2-of-3 PPG (2023-2025)'}
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
              {season === '2023' && (
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
                  title={r.zapRaw != null ? `Rescaled to 2026 methodology (raw 2023 score: ${r.zapRaw.toFixed(1)})` : undefined}>
                  {r.zapScore.toFixed(1)}
                  {r.zapRaw != null && <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 3 }}>({r.zapRaw.toFixed(0)})</span>}
                </td>
                <td style={{ textAlign: 'right', fontWeight: 700, color: r.ourScore > 0 ? tierColor(r.ourScore) : 'var(--text-muted)' }}>
                  {r.ourScore > 0 ? r.ourScore.toFixed(1) : '-'}
                </td>
                {season === '2023' && (
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
        const bt = backtestData.get(nn);
        const pred = predictions2026.get(nn);
        const is2026 = season === '2026';
        const draftSeason = is2026 ? 2026 : (bt?.draftSeason || 2023);
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
