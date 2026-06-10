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
          projection disagrees. <strong>Roster</strong> — current-season projection within 1 of
          streamable (or within 2 with ≥30% model starter odds), or rookie-year PPG within 2.5:
          near-streamable yr-1 production is an <em>immediate</em>-value signal (35% streamable
          the next season vs 32% the one after), so it belongs active, not stashed.{' '}
          <strong>Drop</strong> — three falling-hazard patterns: (a) career model ≤5% to ever
          reach locked-starter PPG AND bottom-third profile AND no production signal anywhere;
          (b) round-5+ capital with a quiet rookie year and &lt;6% starter odds (hazard 9% → 7%);
          (c) round-3+ QBs with quiet rookie years (6% → 0%).{' '}
          <strong>Taxi</strong> — everything else, by construction the <em>ramp</em> profiles:
          high-capital players buried as rookies are the classic delayed breakout (R1–2 + quiet
          yr1 hit streamable 24% the next season but 31% the one after; R1–2 WRs 21% → 38%).
        </p>
      </div>

      {/* ── Ramp model ── */}
      <div style={card}>
        <h3 style={h3}>Taxi Ramp Model (year-2 verdicts)</h3>
        <p style={p13}>
          Year-2 verdicts come from a gradient-boosted model
          (<code>scripts/train_taxi_model.py</code> → <code>score-store/taxi.json</code>)
          trained <em>directly</em> on the streamable targets rather than hand rules. Three
          heads per player: <strong>p1</strong> = P(streamable this season), <strong>p2</strong> =
          P(next season), <strong>pEver</strong> = P(within 4 years). 43 features from the
          committed feature store at the decision season: rookie-year production (PPG/games/
          snap share/touches), year-2 market ADP (live FFC/FantasyCalc for the current class),
          situation shards where available (depth-chart rank, teammates drafted at the position,
          routes YPRR, injuries, new head coach, Vegas win totals — sparse coverage handled as
          informative missingness), and the draft-time career-model profile (capital, combine,
          percentile, threshold probs).
        </p>
        <table style={{ borderCollapse: 'collapse', marginBottom: 12 }}>
          <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
            <th style={{ ...th, textAlign: 'left' }}>Head</th><th style={th}>n</th>
            <th style={th}>LOSO AUC</th>
          </tr></thead>
          <tbody>
            {([['p1 — streamable this season', 979, '.854'], ['p2 — streamable next season', 910, '.815'], ['pEver — within 4 years', 839, '.828']] as const).map(([h, n, a]) => (
              <tr key={h} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={tdL}>{h}</td><td style={td}>{n}</td><td style={td}>{a}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={p13}>
          Validation is leave-one-class-out across 2010–2023 (no class ever predicts itself);
          the held-out 2023 class scored AUC .88 / .86 (p1 / p2). Top features by permutation
          importance: year-2 ADP, rookie-year PPG gap to the streamable bar, rookie-year games,
          career-model predicted PPG and boom odds, forty time and draft capital (both matter
          <em> more</em> for p2 — buried pedigree is the ramp profile), and team win total.
          Verdict thresholds: <strong>p1 ≥ 0.50 → Roster</strong>,{' '}
          <strong>pEver ≤ 0.12 → Drop</strong>, else Taxi — chosen on the LOSO predictions so
          the Taxi bucket is forward-loaded at low drop regret (table below). The model
          replaces the hand rules for scored year-2 players; rookies (no NFL data yet) and
          unscored players keep the rule tree. Retrain after a data refresh with{' '}
          <code>python3 scripts/train_taxi_model.py</code> and commit the output.
        </p>
        <table style={{ borderCollapse: 'collapse', marginBottom: 4 }}>
          <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
            <th style={{ ...th, textAlign: 'left' }}>Bucket (model, LOSO)</th><th style={th}>n</th>
            <th style={th}>Streamable next season</th><th style={th}>Season after</th>
            <th style={th}>Ever within 4 yrs</th>
          </tr></thead>
          <tbody>
            {([['Roster (p1 ≥ .50)', 297, '76%', '65%', '86%'], ['Taxi', 419, '20%', '23%', '37%'], ['Drop (pEver ≤ .12)', 123, '7%', '7%', '12%']] as const).map(([v, n, a, b, c]) => (
              <tr key={v} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={tdL}>{v}</td><td style={td}>{n}</td><td style={td}>{a}</td><td style={td}>{b}</td><td style={td}>{c}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ ...p13, margin: '12px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
          vs the hand-tuned rule tree it replaces (Roster 63% / Taxi 19→20% / Drop regret 14%):
          +13 points of Roster precision, a steeper Taxi ramp (20→23), lower drop regret (12%),
          and only 3 of 68 delayed-ramp players (not streamable next season → streamable the
          season after) labeled Drop.
        </p>
      </div>

      {/* ── Taxi rule-tree backtest (rookies + unscored fallback) ── */}
      <div style={card}>
        <h3 style={h3}>Taxi Rule Tree — Backtest (fallback for rookies / unscored)</h3>
        <p style={p13}>
          The year-2 decision (the fully replayable one: rookie-year production + model profile;
          historical preseason projections don&apos;t exist so the projection clause stays off)
          was replayed for every drafted skill player in the 2010–2022 classes, scored against
          full weekly-stats outcomes at the streamable bar (≥6 games at cutoff PPG). The design
          goal: the Taxi bucket should be <strong>forward-loaded</strong> — a higher streamable
          rate in the season <em>after</em> next than next season — because that is the
          population a taxi spot exists to hold:
        </p>
        <table style={{ borderCollapse: 'collapse', marginBottom: 12 }}>
          <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
            <th style={{ ...th, textAlign: 'left' }}>Verdict</th><th style={th}>n</th>
            <th style={th}>Streamable next season</th><th style={th}>Season after</th>
            <th style={th}>Ever within 4 yrs</th>
          </tr></thead>
          <tbody>
            {([['Roster', 405, '63%', '58%', '76%'], ['Taxi', 273, '19%', '20%', '36%'], ['Drop', 161, '6%', '5%', '14%']] as const).map(([v, n, a, b, c]) => (
              <tr key={v} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={tdL}>{v}</td><td style={td}>{n}</td><td style={td}>{a}</td><td style={td}>{b}</td><td style={td}>{c}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={p13}>
          Taxi is the only bucket whose hazard <em>rises</em> (19% → 20%) — Roster&apos;s falls
          (63% → 58%, value is now) and Drop&apos;s falls (6% → 5%, value never comes). Earlier
          tree versions had Taxi flat-to-declining (24% → 22%); the fix was moving
          near-streamable yr-1 producers to Roster and the late-capital/quiet-QB fade patterns
          to Drop. The expensive error — dropping a future starter — runs <strong>14%</strong>{' '}
          at this bar (was 13% before the fade patterns), and the regret names are journeyman
          streamers (Geoff Swaim, Braxton Berrios tier), not stars. Of the{' '}
          <strong>126 true year-2 breakouts</strong> (not streamable as rookies → streamable in
          year 2), the tree retained 116; the 10 mislabeled Drops are late-capital one-season
          streamers. At the stricter locked-starter bar the same tree showed 6% drop regret with
          the misses being the all-time late-bloomer tail (Antonio Brown, Julius Thomas).
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
