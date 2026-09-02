// Feature importance for one model: ranked magnitude, plus the measured SHAPE
// of each feature's relationship to the target.
//
// Two deliberate choices.
//
// One hue for the bars. Importance is a magnitude, so it is a sequential job,
// not a categorical one — a different colour per feature would imply the
// features are different kinds of thing and would need a legend nobody reads.
//
// Shape is a glyph plus words in muted ink, never a colour. Red/green would
// read as good/bad, and direction has no valence: "ADP round → weaker
// projection" is the expected, correct behaviour of a healthy model, not a
// warning. Encoding it as a status would be actively misleading.
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

export interface ImportanceRow {
  label: string;
  category?: string;
  importance: number;
  /** Pearson correlation with the target across the scored cohort. */
  direction?: number | null;
  /** Spearman, so a monotone-but-curved relationship still reads. */
  rankCorrelation?: number | null;
  shape: string;
  shapeText: string;
  /** Mean target per feature quintile — the evidence behind the shape. */
  quintileMeans?: number[];
  cohort?: number;
}

const BAR = '#6366f1';

// A glyph per shape, so identity never rests on colour.
const SHAPE_GLYPH: Record<string, string> = {
  increasing: '↑',
  decreasing: '↓',
  'mostly-increasing': '↗',
  'mostly-decreasing': '↘',
  'inverted-u': '∩',
  'u-shaped': '∪',
  'non-monotone': '≁',
  flat: '→',
  'not-in-cohort': '·',
  'cohort-too-small': '·',
};

const SHAPE_LABEL: Record<string, string> = {
  increasing: 'rises throughout',
  decreasing: 'falls throughout',
  'mostly-increasing': 'mostly rises',
  'mostly-decreasing': 'mostly falls',
  'inverted-u': 'peaks in the middle',
  'u-shaped': 'dips in the middle',
  'non-monotone': 'no clear direction',
  flat: 'little effect alone',
  'not-in-cohort': 'not measurable here',
  'cohort-too-small': 'cohort too small',
};

// A five-step sparkline of the quintile means: the evidence for the shape,
// so a reader can see the pattern rather than take the label on trust.
function QuintileSpark({ means }: { means: number[] }) {
  if (means.length < 2) return null;
  const lo = Math.min(...means), hi = Math.max(...means);
  const span = hi - lo || 1;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 2, height: 14, marginRight: 6 }}
      title={`Mean target by feature quintile: ${means.map((m) => m.toFixed(1)).join(' → ')}`}>
      {means.map((m, i) => (
        <span key={i} style={{
          width: 3, borderRadius: 1,
          height: `${Math.max(12, ((m - lo) / span) * 100)}%`,
          background: BAR, opacity: 0.55,
        }} />
      ))}
    </span>
  );
}

interface Props {
  rows: ImportanceRow[];
  /** What the importance number means for this model family. */
  importanceNote: string;
  /** Shown when the model has fitted importance but no measurable shapes. */
  caveat?: string;
}

export function FeatureImportancePanel({ rows, importanceNote, caveat }: Props) {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => b.importance - a.importance);
  const chart = sorted.map((r) => ({ name: r.label, importance: r.importance, shape: r.shape }));
  // Roughly 22px a row keeps the bars thin and the labels un-crowded.
  const height = Math.max(180, sorted.length * 24 + 30);

  return (
    <div style={{ margin: '10px 0 18px' }}>
      <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '0 0 8px', lineHeight: 1.5 }}>
        {importanceNote}
      </p>
      <div style={{ width: '100%', height, overflowX: 'auto' }}>
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={chart} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
            barCategoryGap={2}>
            <CartesianGrid horizontal={false} stroke="var(--border)" strokeOpacity={0.5} />
            <XAxis type="number" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey="name" width={168}
              tick={{ fontSize: 10, fill: 'var(--text-secondary)' }} axisLine={false} tickLine={false} />
            <Tooltip
              contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 11 }}
              formatter={(v) => [Number(v).toFixed(3), 'importance']}
              labelFormatter={(name) => {
                const r = sorted.find((x) => x.label === String(name));
                return r ? `${name} — ${SHAPE_LABEL[r.shape] ?? r.shape}` : String(name);
              }}
            />
            {/* 4px rounded data-end, anchored to the baseline. */}
            <Bar dataKey="importance" fill={BAR} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="table-container" style={{ maxHeight: 'none', marginTop: 8 }}>
        <table className="sched-table" style={{ fontSize: 11.5 }}>
          <thead>
            <tr>
              <th>Feature</th><th>Category</th><th style={{ textAlign: 'right' }}>Importance</th>
              <th title="Pearson (linear) and Spearman (rank) correlation with the model's own output">r / ρ</th>
              <th>Nature of the relationship</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.label}>
                <td><strong>{r.label}</strong></td>
                <td style={{ color: 'var(--text-muted)' }}>{r.category || '—'}</td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{r.importance.toFixed(3)}</td>
                <td style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                  {r.direction == null ? '—' : r.direction.toFixed(2)}
                  {r.rankCorrelation == null ? '' : ` / ${r.rankCorrelation.toFixed(2)}`}
                </td>
                <td style={{ lineHeight: 1.45 }}>
                  {r.quintileMeans && r.quintileMeans.length > 1 && <QuintileSpark means={r.quintileMeans} />}
                  <span style={{ color: 'var(--text-muted)', marginRight: 5 }} aria-hidden>
                    {SHAPE_GLYPH[r.shape] ?? '·'}
                  </span>
                  <span>{r.shapeText}</span>
                  {r.cohort != null && r.cohort > 0 && (
                    <span style={{ color: 'var(--text-muted)', fontSize: 10 }}> (n={r.cohort})</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {caveat && (
        <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '8px 0 0', lineHeight: 1.5, maxWidth: 720 }}>
          {caveat}
        </p>
      )}
    </div>
  );
}
