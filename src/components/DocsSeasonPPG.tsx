import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, LabelList,
} from 'recharts';
import projectionConfig from '../generated/projection-config.json';

const STAT_LABELS: Record<string, string> = {
  passAtt: 'Pass Att', passComp: 'Pass Comp', passYds: 'Pass Yards',
  passTD: 'Pass TDs', int: 'INTs', rushAtt: 'Rush Att',
  rushYds: 'Rush Yards', rushTD: 'Rush TDs', targets: 'Targets',
  receptions: 'Receptions', recYds: 'Rec Yards', recTD: 'Rec TDs',
};

function pctColor(pct: number): string {
  if (pct <= 10) return '#22c55e';
  if (pct <= 15) return '#eab308';
  if (pct <= 20) return '#f97316';
  return '#ef4444';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pctFormatter = (v: any) => v != null ? `${v}%` : '';

export function DocsSeasonPPG() {
  const cfg = projectionConfig;
  const detail = cfg.perStatDetail as Record<string, { mae: number; rmse: number; meanActual: number; pctError: number }>;

  const errorData = Object.entries(detail).map(([key, d]) => ({
    stat: STAT_LABELS[key] || key,
    pctError: d.pctError,
    mae: d.mae,
    rmse: d.rmse,
    meanActual: d.meanActual,
  }));

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '24px 16px' }}>
      <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 4 }}>Season Fantasy PPG Projections</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 32 }}>
        How StatHead projects season-long fantasy points per game for every player.
      </p>

      {/* ── Team Projection Model ── */}
      <section style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, borderBottom: '2px solid var(--border)', paddingBottom: 8, marginBottom: 16 }}>
          1. Team-Level Stat Projections
        </h2>
        <p style={{ lineHeight: 1.7, marginBottom: 12 }}>
          The foundation of StatHead's projections. For each of 12 counting stats we blend
          each team's prior-season total with the league average:
        </p>
        <pre style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          borderRadius: 8, padding: 16, fontSize: 13, overflowX: 'auto', marginBottom: 16,
        }}>
{`projected[stat] = prior[stat] × teamWeight + leagueAvg[stat] × leagueWeight

Optimal weights (grid search, ${cfg.configsTested} configs):
  teamWeight  = ${cfg.winner.teamWeight}
  leagueWeight = ${cfg.winner.leagueWeight}
  Vegas lines  = ${cfg.winner.useVegas ? 'enabled' : 'disabled'}

Average % error across all stats: ${cfg.avgPctError}%`}
        </pre>

        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>Per-Stat Accuracy (Team-Level)</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>
          Backtested over {cfg.testSeasons.length} seasons ({cfg.testSeasons[cfg.testSeasons.length - 1]}&#8211;{cfg.testSeasons[0]}), {cfg.configsTested} configurations tested.
        </p>
        <div style={{ width: '100%', height: 320, marginBottom: 16 }}>
          <ResponsiveContainer>
            <BarChart data={errorData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="stat" tick={{ fontSize: 11 }} interval={0} angle={-35} textAnchor="end" height={60} />
              <YAxis tick={{ fontSize: 11 }} domain={[0, 30]} unit="%" />
              <Tooltip
                contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                formatter={((value: number, name: string) => {
                  if (name === 'pctError') return [`${value}%`, '% Error'];
                  return [value, name];
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                }) as any}
              />
              <Bar dataKey="pctError" radius={[4, 4, 0, 0]}>
                {errorData.map((d, i) => (
                  <Cell key={i} fill={pctColor(d.pctError)} />
                ))}
                <LabelList dataKey="pctError" position="top" fontSize={10} formatter={pctFormatter} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 8 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--border)' }}>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>Stat</th>
              <th style={{ textAlign: 'right', padding: '8px 12px' }}>MAE</th>
              <th style={{ textAlign: 'right', padding: '8px 12px' }}>RMSE</th>
              <th style={{ textAlign: 'right', padding: '8px 12px' }}>Mean Actual</th>
              <th style={{ textAlign: 'right', padding: '8px 12px' }}>% Error</th>
            </tr>
          </thead>
          <tbody>
            {errorData.map((d) => (
              <tr key={d.stat} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '6px 12px', fontWeight: 600 }}>{d.stat}</td>
                <td style={{ textAlign: 'right', padding: '6px 12px' }}>{d.mae}</td>
                <td style={{ textAlign: 'right', padding: '6px 12px' }}>{d.rmse}</td>
                <td style={{ textAlign: 'right', padding: '6px 12px' }}>{d.meanActual.toLocaleString()}</td>
                <td style={{ textAlign: 'right', padding: '6px 12px', color: pctColor(d.pctError), fontWeight: 700 }}>{d.pctError}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* ── Player Projection Pipeline ── */}
      <section style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, borderBottom: '2px solid var(--border)', paddingBottom: 8, marginBottom: 16 }}>
          2. Player-Level Projections
        </h2>
        <p style={{ lineHeight: 1.7, marginBottom: 12 }}>
          Individual player projections layer on top of team totals. Each player's prior-season
          share of their team's volume is scaled into the projected team totals:
        </p>
        <ol style={{ lineHeight: 2, paddingLeft: 24, marginBottom: 16 }}>
          <li><strong>Team totals</strong> &mdash; project each team's aggregate stats for the coming season (model above).</li>
          <li><strong>Player share</strong> &mdash; compute each player's prior share of team targets, carries, pass attempts.</li>
          <li><strong>Scale</strong> &mdash; multiply share &times; projected team volume for raw stat projections.</li>
          <li><strong>PPR scoring</strong> &mdash; convert stat lines to PPR fantasy points (1pt/rec, 0.04/pass yd, 0.1/rush+rec yd, 4/pass TD, 6/rush+rec TD, &minus;2/INT).</li>
          <li><strong>Scenario adjustments</strong> &mdash; user-defined scenarios (trades, FA signings, injuries) re-distribute shares.</li>
        </ol>
        <p style={{ lineHeight: 1.7 }}>
          Positions supported: <strong>QB, RB, WR, TE</strong>. Rookies use depth chart rank + NFL draft capital as share priors.
        </p>
      </section>

      {/* ── ADP / Draft Strategy ── */}
      <section style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, borderBottom: '2px solid var(--border)', paddingBottom: 8, marginBottom: 16 }}>
          3. ADP Factor Analysis &amp; Draft Strategy
        </h2>
        <p style={{ lineHeight: 1.7, marginBottom: 12 }}>
          Predicts fantasy <strong>points per game (PPG)</strong> for each player, then compares
          that prediction to the <strong>ADP-expected PPG</strong> &mdash; the historical average PPG
          of players drafted in the same round at the same position. The difference is the player's
          <strong> edge</strong>: positive edge means the model sees value above what the market expects.
        </p>

        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Prediction Framework</h3>
        <pre style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          borderRadius: 8, padding: 16, fontSize: 13, overflowX: 'auto', marginBottom: 16,
        }}>
{`Target:     PPG  = fantasy points per game (PPR scoring)
Baseline:   ADP-Expected PPG = avg PPG for (position, ADP round) over 2021–2025
Edge:       Predicted PPG − ADP-Expected PPG
P(Over):    Probability player exceeds ADP expectation (quantile regression)

Hit:        actual PPG > ADP-Expected PPG
Bust:       actual PPG < 80% of ADP-Expected PPG`}
        </pre>

        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Veteran Model</h3>
        <p style={{ lineHeight: 1.7, marginBottom: 12 }}>
          Uses the full 50+ feature set including prior-season stats, advanced metrics, NGS, route data, workload, and fantasy history.
          GBM: 100 trees, max depth 3.
        </p>

        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Quantile Models &amp; P(Over)</h3>
        <p style={{ lineHeight: 1.7, marginBottom: 12 }}>
          Alongside the median GBM, two <strong>quantile regression</strong> models are trained at the
          10th and 90th percentiles, producing an 80% confidence interval for each prediction.
        </p>
        <pre style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          borderRadius: 8, padding: 16, fontSize: 13, overflowX: 'auto', marginBottom: 16,
        }}>
{`P(Over) = 1 − clamp((ExpectedPPG − LowerBound) / (UpperBound − LowerBound))

Where:
  LowerBound = GBM quantile model (q = 0.10)
  UpperBound = GBM quantile model (q = 0.90)
  ExpectedPPG = historical avg PPG for player's ADP round + position`}
        </pre>

        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Feature Categories (Veteran)</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
          {[
            { label: 'Draft', color: '#6366f1' },
            { label: 'Profile', color: '#8b5cf6' },
            { label: 'Physical', color: '#ec4899' },
            { label: 'Prior Stats', color: '#f59e0b' },
            { label: 'Advanced', color: '#06b6d4' },
            { label: 'NGS', color: '#10b981' },
            { label: 'Route', color: '#f97316' },
            { label: 'Prior Fantasy', color: '#ef4444' },
            { label: 'Workload', color: '#a855f7' },
            { label: 'Competition', color: '#14b8a6' },
            { label: 'Coaching', color: '#64748b' },
            { label: 'Vegas', color: '#eab308' },
          ].map((c) => (
            <span key={c.label} style={{
              background: c.color + '22', color: c.color, border: `1px solid ${c.color}44`,
              borderRadius: 6, padding: '4px 10px', fontSize: 12, fontWeight: 600,
            }}>
              {c.label}
            </span>
          ))}
        </div>

        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Missing-Data Indicators</h3>
        <p style={{ lineHeight: 1.7 }}>
          Binary flags (<code>hasPriorStats</code>, <code>hasCombine</code>, <code>hasNGS</code>) distinguish
          &ldquo;no data available&rdquo; from &ldquo;zero value&rdquo;, preventing the model from conflating
          missing information with poor performance.
        </p>
      </section>

      {/* ── Evaluation Summary ── */}
      <section style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, borderBottom: '2px solid var(--border)', paddingBottom: 8, marginBottom: 16 }}>
          Evaluation Summary
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
          {[
            {
              title: 'Team Projections',
              items: [
                `Avg % error: ${cfg.avgPctError}%`,
                `Best stat: Targets (${cfg.perStatErrors.targets}%)`,
                `Hardest stat: INTs (${cfg.perStatErrors.int}%)`,
                `Backtested: ${cfg.testSeasons.length} seasons (${cfg.testSeasons[cfg.testSeasons.length - 1]}–${cfg.testSeasons[0]})`,
              ],
            },
            {
              title: 'ADP / Draft Strategy Model',
              items: [
                'Training: 2021–2025 (5 seasons)',
                'Target: PPG (fantasy points per game)',
                'Edge: Predicted PPG vs ADP-expected PPG',
                'P(Over): quantile regression (10th/90th %ile)',
                'Cross-validation: LOSO',
              ],
            },
          ].map((card) => (
            <div key={card.title} style={{
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: 10, padding: 20,
            }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10 }}>{card.title}</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 2, color: 'var(--text-secondary)' }}>
                {card.items.map((item, i) => <li key={i}>{item}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
