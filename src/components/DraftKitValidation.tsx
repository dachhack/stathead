// Methodology + backtest validation for the Draft Kit (VBD engine,
// Edge Board, Team Builder) and the dynasty Taxi Squad Advisor.
//
// The backtests here were run offline against committed data (weekly
// player_stats 2010–2025 as ground truth, score-store career model
// predictions as the decision-time inputs) and the headline numbers are
// reproduced as static tables — they change only when the decision
// rules or the underlying model versions change, at which point this
// page should be re-run and updated. Derivations are described inline
// so the numbers are auditable.

const card: React.CSSProperties = {
  background: 'var(--bg-secondary)', borderRadius: 8, padding: '16px',
  marginBottom: 20, border: '1px solid var(--border)',
};
const h3: React.CSSProperties = { margin: '0 0 12px', fontSize: 15 };
const p13: React.CSSProperties = { fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '0 0 12px' };
const th: React.CSSProperties = { padding: '5px 10px', fontSize: 11, fontWeight: 700, textAlign: 'right', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '4px 10px', fontSize: 12, textAlign: 'right' };
const tdL: React.CSSProperties = { ...td, textAlign: 'left', fontWeight: 600 };

export function DraftKitValidation() {
  return (
    <>
      {/* ── Draft Kit (VBD engine) ── */}
      <div style={card}>
        <h3 style={h3}>Draft Kit — VBD Engine &amp; Edge Board</h3>
        <p style={p13}>
          The Value Board / Team Builder run on a <strong>value-based drafting</strong> engine
          (<code>src/lib/draftKit.ts</code>): the projection pool (base projections, all rookies
          included) is priced against a replacement level computed from the league&apos;s actual
          roster slots — dedicated starters come off the top of each position&apos;s PPG-sorted
          list, then FLEX/SF slots are filled greedily. Three baselines:{' '}
          <strong>VOLS</strong> (last starter), <strong>VORP</strong> (best waiver body:
          starters + a 6-per-team bench allocation distributed by starter share), and the
          default <strong>BEER</strong> (midpoint). VBD = (PPG − baseline) × 17.
        </p>
        <p style={p13}>
          The Edge Board&apos;s <strong>Pick Edge</strong> compares predicted PPG to a per-position
          √ADP curve fit on historical drafts (coefficients in{' '}
          <code>score-store/manifest.json</code>, recentered to the current pool). Guards worth
          knowing: the curve is only trusted to <strong>ADP ≤ 300</strong> (beyond its fitted
          domain the baseline collapses toward zero and any prediction reads as a huge edge — a
          phantom deep-ADP entry once cracked the top 20 this way); ADP-survival probabilities
          are Gaussian on FFC&apos;s per-player stdev (σ = 8 picks when unavailable); and the FFC
          season-fallback drops rows with no market signal (timesDrafted = 0 and stdev = 0).
        </p>
        <p style={p13}>
          The <strong>Team Builder</strong> drafts three rosters from the user&apos;s seat under
          identical availability (≥50% survival at each pick): <em>Optimal</em> (greedy weighted
          VBD — full weight while a player fills an open starting slot, ×0.45 as bench),{' '}
          <em>Chalk</em> (best available by market ADP, starters-first), and optionally{' '}
          <em>My board</em> (the user&apos;s saved order, starters-first, unranked players by
          VBD). The Optimal-vs-Chalk gap estimates what value drafting is worth from that slot;
          the My-board-vs-Optimal delta prices the user&apos;s rankings in projected lineup
          points. The sim is greedy and deterministic — a Monte Carlo upgrade is on the roadmap.
          A related, fully historical check lives under <em>Projection Validation → Draft
          Simulation</em>: model-guided picks vs pure-ADP picks replayed against actual season
          outcomes.
        </p>
      </div>

      {/* ── Taxi verdict tree ── */}
      <div style={card}>
        <h3 style={h3}>Taxi Squad Advisor — Verdict Tree</h3>
        <p style={p13}>
          The taxi call is a time-horizon split on <strong>streamable</strong> production — the
          bar an owner needs to start a player for a couple of weeks. The cutoffs are what the
          QB32 / RB60 / WR72 / TE36 season PPG lines actually scored across 2015–2025 weekly
          data (≥6-game seasons), and they are remarkably stable year to year:
        </p>
        <table style={{ borderCollapse: 'collapse', marginBottom: 12 }}>
          <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
            <th style={{ ...th, textAlign: 'left' }}>Position</th>
            <th style={th}>Rank line</th><th style={th}>Streamable PPR PPG</th>
            <th style={th}>Start % band (locked starter)</th>
          </tr></thead>
          <tbody>
            {([['QB', 'QB32', 11.5, 16], ['RB', 'RB60', 6.0, 12], ['WR', 'WR72', 7.5, 12], ['TE', 'TE36', 5.5, 9]] as const).map(([pos, line, cut, sb]) => (
              <tr key={pos} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={tdL}>{pos}</td><td style={td}>{line}</td><td style={td}>{cut.toFixed(1)}</td><td style={td}>≥ {sb} PPG</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={p13}>
          Decision rules, evaluated in order: <strong>DC1</strong> — listed #1 at his position on
          his NFL depth chart (nflverse snapshot) → automatic Roster, caveated when the
          projection disagrees. <strong>Roster</strong> — current-season projection or actual
          rookie-year PPG within 1 of streamable, or within 2 with ≥30% model starter odds.{' '}
          <strong>Drop</strong> — career model ≤5% to ever reach locked-starter PPG (the
          model&apos;s bottom ~20% tail) AND bottom-third profile AND no production signal
          anywhere (no projection ≥ cutoff−3; year-2s also need a rookie year below cutoff−4).{' '}
          <strong>Taxi</strong> — everything else: future starter odds without this-year value.
        </p>
      </div>

      {/* ── Taxi backtest ── */}
      <div style={card}>
        <h3 style={h3}>Taxi Verdicts — Backtest (2010–2022 classes)</h3>
        <p style={p13}>
          The year-2 decision (the fully replayable one: rookie-year production + model profile;
          historical preseason projections don&apos;t exist so the projection clause stays off)
          was replayed for every drafted skill player in the 2010–2022 classes, scored against
          full weekly-stats outcomes at the streamable bar (≥6 games at cutoff PPG):
        </p>
        <table style={{ borderCollapse: 'collapse', marginBottom: 12 }}>
          <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
            <th style={{ ...th, textAlign: 'left' }}>Verdict</th><th style={th}>n</th>
            <th style={th}>Streamable that season</th><th style={th}>Following season</th>
            <th style={th}>Ever within 4 yrs</th>
          </tr></thead>
          <tbody>
            {([['Roster', 322, '68%', '63%', '80%'], ['Taxi', 394, '24%', '22%', '39%'], ['Drop', 123, '5%', '5%', '13%']] as const).map(([v, n, a, b, c]) => (
              <tr key={v} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={tdL}>{v}</td><td style={td}>{n}</td><td style={td}>{a}</td><td style={td}>{b}</td><td style={td}>{c}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={p13}>
          The expensive error — dropping a future starter — runs <strong>13%</strong> at this
          bar, and the regret names are fringe streamers (Geoff Swaim, Braxton Berrios tier),
          not stars. Of the <strong>126 true year-2 breakouts</strong> (not streamable as
          rookies → streamable in year 2 — exactly the player the taxi spot exists for), the
          tree kept 120: 26 on Roster, 94 on Taxi, only <strong>6 mislabeled Drop</strong>.
          At the stricter locked-starter bar the same tree showed 6% drop regret with the misses
          being the all-time late-bloomer tail (Antonio Brown, Julius Thomas).
        </p>
        <p style={p13}>
          <strong>Start % calibration</strong> (rookie decision, model input only — realized =
          startable within 4 years): the ordering is excellent but the absolute probabilities
          run low, worst in the tail — which is why Drop requires three additional conditions
          beyond the probability:
        </p>
        <table style={{ borderCollapse: 'collapse', marginBottom: 4 }}>
          <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
            <th style={{ ...th, textAlign: 'left' }}>Start % band</th><th style={th}>n</th>
            <th style={th}>Mean predicted</th><th style={th}>Realized</th>
          </tr></thead>
          <tbody>
            {([['0–5', 215, '1.8%', '10%'], ['5–15', 260, '9.7%', '16%'], ['15–30', 161, '21.5%', '26%'], ['30–50', 111, '38.9%', '50%'], ['50–100', 92, '65.4%', '78%']] as const).map(([b, n, pr, re]) => (
              <tr key={b} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={tdL}>{b}</td><td style={td}>{n}</td><td style={td}>{pr}</td><td style={td}>{re}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ ...p13, margin: '12px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
          Caveats: career-model threshold probabilities are the model&apos;s backtest predictions
          (any train/test leakage there flatters these numbers by the same amount); ground truth
          covers players with weekly stats (absent = not startable); the 2021–22 classes have
          slightly truncated 4-year windows; DC1 and the projection clause could not be
          backtested (no historical preseason projections or depth-chart snapshots in repo).
        </p>
      </div>
    </>
  );
}
