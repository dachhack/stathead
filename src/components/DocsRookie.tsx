export function DocsRookie() {
  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '24px 16px' }}>
      <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 4 }}>Rookie Career Projections</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 32 }}>
        How StatHead projects rookie fantasy value using pre-draft profiles, combine data, and draft capital.
      </p>

      {/* ── Rookie Pipeline Overview ── */}
      <section style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, borderBottom: '2px solid var(--border)', paddingBottom: 8, marginBottom: 16 }}>
          1. Rookie Projection Pipeline
        </h2>
        <p style={{ lineHeight: 1.7, marginBottom: 12 }}>
          Rookies have no NFL production history, so the model relies entirely on <strong>pre-draft signals</strong>.
          The pipeline trains a <strong>separate model</strong> from the veteran model to avoid overfitting
          on features that don't exist for first-year players.
        </p>
        <ol style={{ lineHeight: 2, paddingLeft: 24, marginBottom: 16 }}>
          <li><strong>Draft capital</strong> &mdash; NFL draft round and pick number establish a prior for expected opportunity.</li>
          <li><strong>Combine / pro day</strong> &mdash; Athletic testing (40-yard dash, speed score, BMI) quantifies physical upside.</li>
          <li><strong>Depth chart</strong> &mdash; Current roster depth at position determines projected share of team volume.</li>
          <li><strong>Team context</strong> &mdash; Coaching changes, Vegas win totals, and team projected volume shape opportunity.</li>
          <li><strong>Competition</strong> &mdash; Incumbent starters and other rookies competing for the same role.</li>
        </ol>
      </section>

      {/* ── Rookie Model Architecture ── */}
      <section style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, borderBottom: '2px solid var(--border)', paddingBottom: 8, marginBottom: 16 }}>
          2. Rookie Model Architecture
        </h2>
        <p style={{ lineHeight: 1.7, marginBottom: 12 }}>
          The rookie model is a <strong>Gradient Boosting Machine (GBM)</strong> tuned shallower than the
          veteran model to prevent overfitting on the smaller feature set:
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 20 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--border)' }}>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>Parameter</th>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>Rookie Model</th>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>Veteran Model (for comparison)</th>
            </tr>
          </thead>
          <tbody>
            {([
              ['Estimators', '60 trees', '100 trees'],
              ['Max Depth', '2', '3'],
              ['Learning Rate', '0.1', '0.1'],
              ['Subsampling', '0.8', '0.8'],
              ['Min Leaf Samples', '5', '5'],
              ['Feature Set', '~15 features/position', '50+ features/position'],
              ['Confidence Intervals', '80% CI (quantile q=0.10, 0.90)', '80% CI (quantile q=0.10, 0.90)'],
              ['Cross-Validation', 'LOSO', 'LOSO'],
            ] as [string, string, string][]).map(([param, rookie, vet]) => (
              <tr key={param} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '6px 12px', fontWeight: 600 }}>{param}</td>
                <td style={{ padding: '6px 12px' }}>{rookie}</td>
                <td style={{ padding: '6px 12px', color: 'var(--text-muted)' }}>{vet}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Prediction Target</h3>
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
      </section>

      {/* ── Rookie Feature Set ── */}
      <section style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, borderBottom: '2px solid var(--border)', paddingBottom: 8, marginBottom: 16 }}>
          3. Rookie Feature Categories
        </h2>
        <p style={{ lineHeight: 1.7, marginBottom: 12 }}>
          Rookies use only <strong>pre-draft features</strong>. Categories that require NFL game data
          (Prior Stats, Advanced, NGS, Route, Prior Fantasy, Workload) are excluded entirely.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginBottom: 16 }}>
          {[
            {
              cat: 'Draft', color: '#6366f1',
              features: ['Draft Round', 'Draft Pick (overall)', 'Draft Reach (pick vs consensus)', 'Years in League (always 0)'],
            },
            {
              cat: 'Profile', color: '#8b5cf6',
              features: ['Age at draft', 'Position', 'College conference'],
            },
            {
              cat: 'Physical / Combine', color: '#ec4899',
              features: ['Weight', 'BMI', '40-Yard Dash', 'Speed Score', 'Broad Jump', 'Vertical', 'Bench Press', '3-Cone', 'Shuttle'],
            },
            {
              cat: 'Competition', color: '#14b8a6',
              features: ['Depth chart rank', 'Incumbent starter snaps', 'Other rookies at position'],
            },
            {
              cat: 'Coaching', color: '#64748b',
              features: ['New head coach flag', 'New OC flag', 'Coach tenure'],
            },
            {
              cat: 'Personnel / Team', color: '#10b981',
              features: ['Team projected pass volume', 'Team projected rush volume', 'Vegas win total', 'Points per game'],
            },
            {
              cat: 'Vegas / Projection', color: '#eab308',
              features: ['Team implied total', 'Projected volume change', 'Projected target share'],
            },
            {
              // Scouting features extracted from The Beast, RSP, and Late-Round Guide
              // via scripts/extract_pdf_features.py + merge_pdf_features.py. RSP adds
              // (2026-04) surface Matt Waldman's DOT numeric grade, tier class, cross-year
              // trajectory, and comps count — shipped in the RB + WR pre-draft lists.
              cat: 'Scouting (Beast / RSP / Late-Round)', color: '#f97316',
              features: [
                'Consensus scout rank (The Beast)',
                'Projected round (PDF consensus)',
                '# strengths / weaknesses / red flags (sentiment)',
                'RSP DOT score (Matt Waldman, draft year)',
                'RSP DOT trajectory (draft year → latest)',
                'RSP breadth score',
                'RSP tier class (Franchise → Street)',
                'RSP # NFL comps',
                'Scout-vs-pick disagreement (rank vs pick, round vs round)',
              ],
            },
          ].map((g) => (
            <div key={g.cat} style={{
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: 8, padding: 12, borderLeft: `4px solid ${g.color}`,
            }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>{g.cat}</div>
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, lineHeight: 1.8, color: 'var(--text-secondary)' }}>
                {g.features.map((f) => <li key={f}>{f}</li>)}
              </ul>
            </div>
          ))}
        </div>

        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Missing-Data Indicators</h3>
        <p style={{ lineHeight: 1.7 }}>
          Binary flags (<code>hasCombine</code>) distinguish &ldquo;no combine data available&rdquo; from
          &ldquo;zero value&rdquo;. Players who skip the combine but have pro day numbers still get
          athletic measurements; players with no testing at all get flagged so the model
          can learn that missing combine data has a distinct signal.
        </p>
      </section>

      {/* ── Quantile / P(Over) ── */}
      <section style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, borderBottom: '2px solid var(--border)', paddingBottom: 8, marginBottom: 16 }}>
          4. Confidence Intervals &amp; P(Over)
        </h2>
        <p style={{ lineHeight: 1.7, marginBottom: 12 }}>
          Alongside the median prediction, two <strong>quantile regression</strong> GBM models are trained
          at the 10th and 90th percentiles, producing an 80% confidence interval for each rookie.
          This is especially important for rookies where uncertainty is inherently higher.
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
        <p style={{ lineHeight: 1.7 }}>
          A wide confidence interval for a rookie signals high variance &mdash; common for Day 2 picks
          entering crowded backfields. A narrow interval with high P(Over) signals a confident projection
          above market expectations.
        </p>
      </section>

      {/* ── Evaluation ── */}
      <section style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, borderBottom: '2px solid var(--border)', paddingBottom: 8, marginBottom: 16 }}>
          Evaluation Summary
        </h2>
        <div style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          borderRadius: 10, padding: 20,
        }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10 }}>Rookie Career Projection Model</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 2, color: 'var(--text-secondary)' }}>
            <li>Training: 2021–2025 (5 seasons)</li>
            <li>Target: PPG (fantasy points per game, PPR scoring)</li>
            <li>Features: ~15 pre-draft features per position</li>
            <li>Architecture: GBM with 60 trees, depth 2</li>
            <li>Confidence: 80% quantile regression (q=0.10, 0.90)</li>
            <li>Cross-validation: Leave-One-Season-Out (LOSO)</li>
            <li>Separate models per position (QB, RB, WR, TE)</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
