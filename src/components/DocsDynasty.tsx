export function DocsDynasty() {
  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '24px 16px' }}>
      <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 4 }}>Dynasty Value Model</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 32 }}>
        How StatHead predicts dynasty trade value changes from September to December.
      </p>

      {/* ── Overview ── */}
      <section style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, borderBottom: '2px solid var(--border)', paddingBottom: 8, marginBottom: 16 }}>
          1. Overview
        </h2>
        <p style={{ lineHeight: 1.7, marginBottom: 12 }}>
          Predicts how <strong>market</strong> or <strong>FantasyCalc</strong> dynasty values will change
          from September to December. Trained on 2024&#8211;2025 historical value snapshots with
          Leave-One-Season-Out cross-validation.
        </p>
        <p style={{ lineHeight: 1.7, marginBottom: 12 }}>
          The model helps dynasty managers identify players whose values are likely to rise
          (buy-low candidates) or fall (sell-high candidates) over the course of the NFL season.
        </p>
      </section>

      {/* ── Architecture ── */}
      <section style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, borderBottom: '2px solid var(--border)', paddingBottom: 8, marginBottom: 16 }}>
          2. Model Architecture
        </h2>
        <p style={{ lineHeight: 1.7, marginBottom: 12 }}>
          Two model architectures are trained in parallel and compared via cross-validation:
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 20 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--border)' }}>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>Component</th>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>Ridge Regression</th>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>Gradient Boosting (GBM)</th>
            </tr>
          </thead>
          <tbody>
            {([
              ['Algorithm', 'L2-regularized OLS (\u03b2 = (X\'X + \u03bbI)\u207b\u00b9X\'y)', 'Sequential decision-stump ensemble'],
              ['Regularization', '\u03bb = 1.0 (standardized features)', 'Learning rate 0.1, subsampling 0.8'],
              ['Trees / Depth', 'N/A', '100 estimators, max depth 3, min 5 leaf'],
              ['Confidence Intervals', 'N/A', '80% CI via quantile regression (q=0.1, 0.9)'],
              ['Cross-Validation', 'LOSO (Leave-One-Season-Out)', 'LOSO (Leave-One-Season-Out)'],
              ['Metrics', 'R\u00b2, Adj. R\u00b2, MAE, RMSE', 'R\u00b2, Adj. R\u00b2, MAE, RMSE'],
            ] as [string, string, string][]).map(([comp, ridge, gbm]) => (
              <tr key={comp} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '6px 12px', fontWeight: 600 }}>{comp}</td>
                <td style={{ padding: '6px 12px' }}>{ridge}</td>
                <td style={{ padding: '6px 12px' }}>{gbm}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* ── Feature Groups ── */}
      <section style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, borderBottom: '2px solid var(--border)', paddingBottom: 8, marginBottom: 16 }}>
          3. Feature Groups (per position)
        </h2>
        <p style={{ lineHeight: 1.7, marginBottom: 12 }}>
          Each position (QB, RB, WR, TE) has a shared set of common features plus position-specific features.
          The model uses both categories to capture general dynasty value drivers and position-specific nuances.
        </p>

        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>Common Features</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginBottom: 24 }}>
          {[
            { cat: 'Dynasty', features: ['Sept Dynasty Value', 'Age'], color: '#6366f1' },
            { cat: 'Draft', features: ['Draft Round', 'Draft Pick', 'Years in League'], color: '#8b5cf6' },
            { cat: 'Physical', features: ['Weight', 'BMI', '40-Yard Dash', 'Speed Score'], color: '#ec4899' },
            { cat: 'Depth Chart', features: ['Current Rank', 'Prior Rank', 'Rank Change'], color: '#06b6d4' },
            { cat: 'Prior Season', features: ['Games', 'Fantasy PPR', 'PPG', 'Snap %', 'Position-specific stats'], color: '#f59e0b' },
            { cat: 'Injury', features: ['Injury Weeks', 'Games Out', 'Games Missed'], color: '#ef4444' },
            { cat: 'Team', features: ['Wins', 'Points Per Game'], color: '#10b981' },
            { cat: 'Projection', features: ['Proj Team Pass Att', 'Proj Vol Change', 'Proj Player PPR', 'Proj vs Expected', 'Target Share'], color: '#f97316' },
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

        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>Position-Specific Features</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginBottom: 16 }}>
          {[
            {
              pos: 'QB', color: '#6366f1',
              features: ['Pass Yards', 'Pass TDs', 'INTs', 'Rushing Yards', 'Rushing TDs', 'Passer Rating', 'EPA/play'],
            },
            {
              pos: 'RB', color: '#ec4899',
              features: ['Rush Yards', 'Rush TDs', 'Receptions', 'Rec Yards', 'Targets', 'Yards/Carry', 'Snap Share'],
            },
            {
              pos: 'WR', color: '#f59e0b',
              features: ['Rec Yards', 'Rec TDs', 'Targets', 'Target Share', 'Yards/Route'],
            },
            {
              pos: 'TE', color: '#10b981',
              features: ['Rec Yards', 'Rec TDs', 'Targets', 'Target Share'],
            },
          ].map((g) => (
            <div key={g.pos} style={{
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: 8, padding: 12, borderLeft: `4px solid ${g.color}`,
            }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>{g.pos}</div>
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, lineHeight: 1.8, color: 'var(--text-secondary)' }}>
                {g.features.map((f) => <li key={f}>{f}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* ── Confidence Intervals ── */}
      <section style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, borderBottom: '2px solid var(--border)', paddingBottom: 8, marginBottom: 16 }}>
          4. Confidence Intervals
        </h2>
        <p style={{ lineHeight: 1.7, marginBottom: 12 }}>
          The GBM model produces <strong>80% confidence intervals</strong> via quantile regression
          at the 10th and 90th percentiles. This tells you not just the expected value change,
          but the range of plausible outcomes:
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
          <div style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            borderRadius: 8, padding: 16, borderLeft: '4px solid #22c55e',
          }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>Narrow CI + Positive Prediction</div>
            <p style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--text-secondary)', margin: 0 }}>
              High-confidence buy-low candidate. The model is fairly certain the player's
              value will increase. Strong signal for trade targets.
            </p>
          </div>
          <div style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            borderRadius: 8, padding: 16, borderLeft: '4px solid #ef4444',
          }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>Wide CI + Any Prediction</div>
            <p style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--text-secondary)', margin: 0 }}>
              High uncertainty. The player could swing either direction significantly.
              Proceed with caution and consider the downside risk.
            </p>
          </div>
        </div>
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
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10 }}>Dynasty Value Predictive Model</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 2, color: 'var(--text-secondary)' }}>
            <li>Models: Ridge Regression + GBM with quantile CI</li>
            <li>Cross-validation: Leave-One-Season-Out (LOSO)</li>
            <li>Confidence: 80% quantile regression (q=0.10, 0.90)</li>
            <li>Metrics: R&sup2;, Adj. R&sup2;, MAE, RMSE</li>
            <li>Position-specific feature sets (QB, RB, WR, TE)</li>
            <li>Training data: 2024–2025 historical value snapshots</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
