import { useMemo } from 'react';
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';
import type { EdgeBoardRow } from '../lib/edgeBoardRow';
import { VERDICT_STYLE, fmtEdge, fmtPct } from '../lib/edgeBoardRow';
import type { DraftPrepSettings } from '../lib/draftPrepSettings';
import { MethodNote } from './MethodNote';
import { DocsLink } from './DocsLink';

// Tier Map section. Per-position scatter — X=ADP, Y=Pred PPG, color =
// Verdict — with horizontal cliff lines at the tier boundaries within
// position. Lets the user see at a glance "Tier 1 RBs end at ADP X
// (PPG Y); after that there's a 2-PPG drop until ADP Z."
//
// Tiers are by **Pred PPG within position** (production tiers), not by
// PickEdge. Production tiers answer the "where do the cliffs sit?"
// question; PickEdge tiers would just duplicate the verdict column on
// the Edge Board. Color overlays the verdict so the user can spot
// underpriced players (green) below the cliff lines and overpriced
// players (red) above them.
//
// Cuts: top 5 per position = Tier 1 (Elite), next 7 = Tier 2 (High-end),
// next 12 = Tier 3 (Solid), rest = Streamer.

const TIER_CUTS = [5, 12, 24] as const; // cumulative tier-end ranks
const TIER_LABELS = ['Elite', 'High-end', 'Solid', 'Streamer'] as const;
const POSITIONS = ['QB', 'RB', 'WR', 'TE'] as const;
type Pos = typeof POSITIONS[number];

interface Props {
  rows: EdgeBoardRow[];
  settings: DraftPrepSettings;
}

interface ScatterPoint {
  name: string;
  adp: number;
  predictedPPG: number;
  pickEdge: number;
  pBeat: number;
  verdict: EdgeBoardRow['verdict'];
  tier: number;
  isRookie: boolean;
}

interface PosBlock {
  pos: Pos;
  points: ScatterPoint[];
  tierBoundaries: number[]; // PPG values where tier N ends (lowest PPG in tier N)
  cliffSizes: number[];      // PPG drop from tier N's last to tier N+1's first
}

export function DraftTierMap({ rows, settings }: Props) {
  const blocks = useMemo<PosBlock[]>(() => {
    return POSITIONS.map((pos) => buildBlock(pos, rows));
  }, [rows]);

  if (rows.length === 0) return null;

  const myPickN = settings.pickSlot; // round-1 pick number for round-line annotation
  const N = settings.numTeams;

  return (
    <section style={{ marginTop: 32 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>Tier Map</h2>
        <DocsLink section="projection" title="PPG model validation — Model Docs" />
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Predicted PPG vs ADP, per position. Cliff lines at tier
          boundaries (Top 5 / Next 7 / Next 12 / rest).
        </span>
      </header>
      <MethodNote id="tier-map">
        Tiers ranked by predicted PPG within position. Dots colored by
        Verdict — green clusters below a cliff line are undervalued (the
        market thinks they're a tier lower than the model does). Red dots
        above a cliff line are overvalued. Vertical guides mark the end
        of rounds 1, 3, 6, and 10 in your league size.
      </MethodNote>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16,
      }}>
        {blocks.map((b) => (
          <TierBlock key={b.pos} block={b} numTeams={N} myPickRound1={myPickN} />
        ))}
      </div>
    </section>
  );
}

function buildBlock(pos: Pos, rows: EdgeBoardRow[]): PosBlock {
  const posRows = rows
    .filter((r) => r.position === pos && Number.isFinite(r.predictedPPG) && r.predictedPPG > 0 && r.adp > 0)
    .sort((a, b) => b.predictedPPG - a.predictedPPG);

  const points: ScatterPoint[] = posRows.map((r, idx) => {
    let tier = 4;
    if (idx < TIER_CUTS[0]) tier = 1;
    else if (idx < TIER_CUTS[1]) tier = 2;
    else if (idx < TIER_CUTS[2]) tier = 3;
    return {
      name: r.name,
      adp: r.adp,
      predictedPPG: r.predictedPPG,
      pickEdge: r.pickEdge,
      pBeat: r.pBeat,
      verdict: r.verdict,
      tier,
      isRookie: r.isRookie,
    };
  });

  // Tier boundary PPG = PPG of the lowest player in that tier.
  const tierBoundaries: number[] = [];
  const cliffSizes: number[] = [];
  for (let i = 0; i < TIER_CUTS.length; i++) {
    const cut = TIER_CUTS[i];
    if (posRows.length > cut) {
      const last = posRows[cut - 1].predictedPPG;
      const next = posRows[cut].predictedPPG;
      tierBoundaries.push(last);
      cliffSizes.push(last - next);
    }
  }

  return { pos, points, tierBoundaries, cliffSizes };
}

interface BlockProps {
  block: PosBlock;
  numTeams: number;
  myPickRound1: number;
}

function TierBlock({ block, numTeams, myPickRound1 }: BlockProps) {
  // X-axis range: cap at ADP 220 by default; if the position has fewer
  // deep players, tighten so dots aren't lost on the right edge.
  const maxAdp = Math.min(220, Math.ceil(Math.max(...block.points.map((p) => p.adp), 0) + 6));
  const minPPG = Math.max(0, Math.floor(Math.min(...block.points.map((p) => p.predictedPPG), 0) - 1));
  const maxPPG = Math.ceil(Math.max(...block.points.map((p) => p.predictedPPG), 1) + 1);

  // Round endings to mark on X-axis — end of round 1, 3, 6, 10 in user's league.
  const roundEnds = [1, 3, 6, 10].map((r) => r * numTeams).filter((x) => x <= maxAdp);

  return (
    <div style={{
      background: 'var(--bg-secondary)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '8px 12px',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <span className={`pos-badge pos-${block.pos}`} style={{ fontSize: 11 }}>{block.pos}</span>
        <span style={{ fontSize: 12, fontWeight: 700 }}>
          {block.points.length} players
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 'auto' }}>
          Cliffs: {block.cliffSizes.map((c, i) => `T${i + 1}→T${i + 2}: −${c.toFixed(1)} PPG`).join(' • ')}
        </span>
      </div>

      <div style={{ height: 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 12, bottom: 24, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.3} />
            <XAxis
              type="number" dataKey="adp" name="ADP"
              domain={[1, maxAdp]} reversed={false}
              tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
              tickLine={{ stroke: 'var(--border)' }}
              axisLine={{ stroke: 'var(--border)' }}
              label={{ value: 'ADP', position: 'insideBottom', offset: -8, fontSize: 10, fill: 'var(--text-muted)' }}
            />
            <YAxis
              type="number" dataKey="predictedPPG" name="Pred PPG"
              domain={[minPPG, maxPPG]}
              tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
              tickLine={{ stroke: 'var(--border)' }}
              axisLine={{ stroke: 'var(--border)' }}
              width={32}
            />
            <Tooltip cursor={{ strokeDasharray: '3 3', stroke: 'var(--text-muted)' }} content={<TierTooltip />} />

            {/* Tier-cliff horizontal lines */}
            {block.tierBoundaries.map((ppg, i) => (
              <ReferenceLine
                key={`tier-${i}`}
                y={ppg}
                stroke="var(--text-muted)"
                strokeDasharray="4 4"
                strokeOpacity={0.5}
                label={{
                  value: `End ${TIER_LABELS[i]} (${ppg.toFixed(1)})`,
                  position: 'insideTopRight',
                  fontSize: 9,
                  fill: 'var(--text-muted)',
                }}
              />
            ))}

            {/* Round-end vertical lines */}
            {roundEnds.map((x) => (
              <ReferenceLine
                key={`rd-${x}`}
                x={x}
                stroke="var(--border)"
                strokeOpacity={0.6}
                label={{
                  value: `R${x / numTeams}`,
                  position: 'top',
                  fontSize: 9,
                  fill: 'var(--text-muted)',
                }}
              />
            ))}

            {/* User's first pick — emphasized vertical line */}
            {myPickRound1 <= maxAdp && (
              <ReferenceLine
                x={myPickRound1}
                stroke="#6366f1"
                strokeOpacity={0.6}
                strokeWidth={1}
                label={{
                  value: `pick #${myPickRound1}`,
                  position: 'top',
                  fontSize: 9,
                  fill: '#6366f1',
                }}
              />
            )}

            <Scatter data={block.points} fillOpacity={0.85}>
              {block.points.map((p, idx) => (
                <Cell
                  key={idx}
                  fill={VERDICT_STYLE[p.verdict].fg}
                  // Tier 1/2 dots larger; tier 4 small so they don't dominate visually.
                  r={p.tier === 1 ? 7 : p.tier === 2 ? 5 : p.tier === 3 ? 4 : 3}
                />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

interface TooltipPayloadEntry { payload: ScatterPoint }
function TierTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayloadEntry[] }) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload;
  return (
    <div style={{
      background: 'var(--bg-primary)', border: '1px solid var(--border)',
      borderRadius: 6, padding: '8px 10px', fontSize: 11, lineHeight: 1.5,
      boxShadow: '0 4px 14px rgba(0,0,0,0.4)',
    }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>
        {p.name}
        {p.isRookie && <span style={{ fontSize: 9, color: '#6366f1', marginLeft: 4 }}>R</span>}
      </div>
      <div style={{ color: 'var(--text-muted)' }}>
        ADP <strong style={{ color: 'var(--text-primary)' }}>{p.adp.toFixed(1)}</strong>
        {' • '}Pred PPG <strong style={{ color: 'var(--text-primary)' }}>{p.predictedPPG.toFixed(1)}</strong>
      </div>
      <div style={{ color: 'var(--text-muted)' }}>
        Edge <strong style={{ color: 'var(--text-primary)' }}>{fmtEdge(p.pickEdge)}</strong>
        {' • '}Beat <strong style={{ color: 'var(--text-primary)' }}>{fmtPct(p.pBeat)}</strong>
        {' • '}Tier <strong style={{ color: 'var(--text-primary)' }}>{TIER_LABELS[p.tier - 1]}</strong>
      </div>
      <div style={{ marginTop: 4 }}>
        <span style={{
          display: 'inline-block', fontSize: 9, fontWeight: 700,
          padding: '1px 6px', borderRadius: 8,
          background: VERDICT_STYLE[p.verdict].bg,
          color: VERDICT_STYLE[p.verdict].fg,
          border: p.verdict === 'Fair' || p.verdict === 'Unknown' ? '1px solid var(--border)' : 'none',
        }}>
          {VERDICT_STYLE[p.verdict].label}
        </span>
      </div>
    </div>
  );
}
