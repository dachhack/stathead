import type { Tab } from '../types';

interface HomePageProps {
  onNavigate: (tab: Tab) => void;
}

interface Section {
  title: string;
  description: string;
  items: { label: string; tab: Tab; blurb: string }[];
}

const SECTIONS: Section[] = [
  {
    title: 'Projections',
    description:
      'Pre-draft planning tools: season-long fantasy projections, editable rankings, and draft-day optimizers.',
    items: [
      {
        label: 'Projections',
        tab: 'projections',
        blurb:
          'Full player projections with scenario builder — adjust team volume, pass rates, movements, and free-agent signings.',
      },
      {
        label: 'Scenario Builder',
        tab: 'scenario-builder',
        blurb: 'Full-page team workspace: per-player target/carry adjustments, team levers, PPR deltas, and Excel export.',
      },
      {
        label: 'Schedule & SOS',
        tab: 'schedule',
        blurb: '2026 schedule with strength of schedule, opponent defense grades, and per-game projected scores + win probability.',
      },
      {
        label: 'My Rankings',
        tab: 'my-rankings',
        blurb: 'Hand-edit rankings layered on top of the projections engine; persists in your browser.',
      },
      {
        label: 'Draft Optimizer',
        tab: 'draft-optimizer',
        blurb:
          'Find the pick that maximizes expected value given your league settings, roster slots, and positional scarcity.',
      },
    ],
  },
  {
    title: 'Dynasty',
    description:
      'Long-term value, trade evaluation, and rookie evaluation. Combines dynasty market values with our forecast and prospect models.',
    items: [
      {
        label: 'Dynasty Values',
        tab: 'ktc',
        blurb: 'Current 1QB and superflex values, value history, and factor model for why a player is valued the way they are.',
      },
      {
        label: 'Trade Calculator',
        tab: 'trade-calc',
        blurb: 'Evaluate proposed trades using dynasty market values with projected 30/60/90-day deltas.',
      },
      {
        label: 'Value Forecast',
        tab: 'dynasty-forecast',
        blurb: 'Project dynasty value forward using career trajectory, age curve, and model percentile.',
      },
      {
        label: 'Prospects',
        tab: 'prospects',
        blurb:
          'Pre-draft rookie grades with predicted career PPG, boom/bust z-scores, and threshold probabilities.',
      },
      {
        label: 'My Prospect Rankings',
        tab: 'my-prospects',
        blurb: 'Hand-edit prospect rankings that stack on top of the career model.',
      },
      {
        label: 'Career Backtest',
        tab: 'career-backtest',
        blurb: 'How the rookie career model has performed historically (2010-2025) vs actual PPG outcomes.',
      },
    ],
  },
  {
    title: 'Research',
    description: 'Sleeper league analysis, opponent scouting, raw data access, and model documentation.',
    items: [
      {
        label: 'Sleeper Leagues',
        tab: 'sleeper-league',
        blurb: 'Enter your username to browse your leagues. Load any league for standings, rosters, power rankings, waivers, and trade ideas — dynasty leagues add win-now/rebuild scoring, redraft leagues rank on projected season points.',
      },
      {
        label: 'Sleeper User Snooper',
        tab: 'sleeper-snooper',
        blurb: 'Look up any Sleeper user — leagues, combined record, most-owned players, multi-season career history, and trade grades.',
      },
      {
        label: 'Data Query (SQL)',
        tab: 'data-query',
        blurb: 'Run SQL against the full dataset in-browser (DuckDB WASM) — projections, backtest, ADP, dynasty values, prospect grades.',
      },
      {
        label: 'Model Docs',
        tab: 'model-docs',
        blurb: 'How each model is trained: features, targets, sample sizes, calibration, pipeline diagrams.',
      },
    ],
  },
];

const PY_QUICKSTART = `import stathead as sh

# 2026 rookie class predictions (77 players × ~80 columns)
rookies = sh.load_career_predictions_2026()
rookies.nlargest(10, "percentile")[["name", "position", "predictedCareerPPG", "modelTier"]]

# Historical backtest — predicted vs actual PPG for every drafted rookie 2010-2025
backtest = sh.load_career_backtest()

# Historical ADP (2010-2025) joined to scouting-report grades
adp = sh.load_adp_historical()
grades = sh.load_prospect_grades(year=2026)
`;

const LOADERS: { fn: string; desc: string }[] = [
  { fn: 'load_career_predictions_2026()', desc: '2026 rookie predictions (~77 × ~80 cols)' },
  { fn: 'load_career_backtest()', desc: 'Historical rookies with pred + actual PPG (~1087 × ~100)' },
  { fn: 'load_adp_historical()', desc: 'Model-training ADP 2010-2025 (~4507 × 10)' },
  { fn: 'load_adp_ffc(season=None)', desc: 'Raw community PPR ADP (per season)' },
  { fn: 'load_prospect_grades(year=2026)', desc: 'Scouting-report grades (~200 × 7)' },
  { fn: 'load_feature_matrix()', desc: 'Raw feature-matrix.json' },
  { fn: 'load_manual_overrides()', desc: 'Manual CFBD usage overrides' },
];

const linkStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#6366f1',
  fontWeight: 600,
  fontSize: 14,
  cursor: 'pointer',
  padding: 0,
  fontFamily: 'inherit',
  textAlign: 'left',
};

export function HomePage({ onNavigate }: HomePageProps) {
  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '24px 20px 48px' }}>
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0, marginBottom: 8 }}>
          StatHead
        </h1>
        <p style={{ fontSize: 15, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.55 }}>
          Fantasy football projections, dynasty values, and rookie evaluation — combining NFL
          stats, college football data, expert consensus rankings, ADP, dynasty market values, and
          scouting reports. Everything is open data and the underlying modeling pipeline lives in
          this repo.
        </p>
      </div>

      <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', marginBottom: 40 }}>
        {SECTIONS.map((section) => (
          <div
            key={section.title}
            style={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '16px 18px',
            }}
          >
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, marginBottom: 6 }}>{section.title}</h2>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, marginBottom: 12, lineHeight: 1.5 }}>
              {section.description}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {section.items.map((item) => (
                <div key={item.tab}>
                  <button style={linkStyle} onClick={() => onNavigate(item.tab)}>
                    {item.label} &rarr;
                  </button>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.45 }}>
                    {item.blurb}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '20px 22px',
        }}
      >
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0, marginBottom: 4 }}>
          Python library
        </h2>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, marginBottom: 14, lineHeight: 1.55 }}>
          Every table on this site is also available as pandas DataFrames via the{' '}
          <code style={{ background: 'var(--bg-tertiary)', padding: '1px 6px', borderRadius: 3 }}>stathead</code>{' '}
          Python package. Install with <code style={{ background: 'var(--bg-tertiary)', padding: '1px 6px', borderRadius: 3 }}>pip install stathead</code>.
        </p>

        <pre
          style={{
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '12px 14px',
            fontSize: 12,
            lineHeight: 1.55,
            overflow: 'auto',
            margin: 0,
            marginBottom: 16,
          }}
        >
          <code>{PY_QUICKSTART}</code>
        </pre>

        <h3 style={{ fontSize: 13, fontWeight: 700, margin: 0, marginBottom: 8, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Available loaders
        </h3>
        <div style={{ display: 'grid', gap: 6, fontSize: 12 }}>
          {LOADERS.map((l) => (
            <div key={l.fn} style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 12 }}>
              <code style={{ color: '#6366f1', fontWeight: 600 }}>{l.fn}</code>
              <span style={{ color: 'var(--text-secondary)' }}>{l.desc}</span>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 14, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55 }}>
          Pin a specific commit with <code>sh.pin_version(&quot;a6720e5&quot;)</code> for reproducibility.
          Data is cached at <code>~/.cache/stathead/</code> after first download; call{' '}
          <code>sh.clear_cache()</code> to refresh. Source:{' '}
          <a
            href="https://github.com/dachhack/stathead/tree/main/python"
            target="_blank"
            rel="noreferrer"
            style={{ color: '#6366f1' }}
          >
            python/
          </a>{' '}
          in the repo.
        </div>
      </div>
    </div>
  );
}
