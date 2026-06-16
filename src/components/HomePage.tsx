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
        blurb: '2026 schedule with strength of schedule, opponent defense grades and sub-unit strength (D-line / linebackers / secondary), and per-game projected scores + win probability.',
      },
      {
        label: 'My Rankings',
        tab: 'my-rankings',
        blurb: 'Hand-edit rankings layered on the projections engine, with projection-scenario presets, league scoring (PPR/Half/Standard), and current ADP; persists in your browser. Export the board to Excel — and import the same file to share it or move it between devices, with edited projections coming back as a scenario.',
      },
      {
        label: 'Draft Optimizer',
        tab: 'draft-optimizer',
        blurb:
          'The full redraft kit as a four-step workflow: ① VBD cheat sheet with tiers and scarcity, ② model-vs-ADP edges (targets, fades, rookie/vet mispricings), ③ a full-draft simulator from your seat, and ④ live draft-day sync — connect your Sleeper draft (auto-configures your league) or track any platform manually for need-aware best-available picks. Includes a one-page, BeerSheets-style Draft Day Sheet you can print or save as a PDF.',
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
        blurb: 'Current 1QB and superflex values (with optional TE-premium), value history, and factor model for why a player is valued the way they are.',
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
        label: 'Taxi Squad',
        tab: 'taxi-squad',
        blurb: 'Rookies and year-2 players ranked on when they’ll be startable: Roster (startable this season), Taxi (next-year starter odds, no value yet), or Drop (probably never) — from current-season projections, career-model startable odds, and rookie-year production.',
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
        label: 'Expert Tracker',
        tab: 'expert-tracker',
        blurb: 'Aggregate a private list of expert managers — what they roster at the highest rates (by dynasty/redraft, SF/1QB), their recent adds and trades with letter grades, an expert trade-grade leaderboard you can rank yourself against, and a social graph of who shares leagues.',
      },
      {
        label: 'Sleeper Waiver Wire',
        tab: 'sleeper-waivers',
        blurb: 'Valuable players on waivers across all your leagues, ranked by projected points or add trend, with which of your leagues each is open in.',
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

// Lines kept ≤ 42 chars so the block fits a 390px phone without
// horizontal scrolling (see .py-quickstart in index.css for the
// mobile font-size + soft-wrap fallback).
const PY_QUICKSTART = `import stathead as sh

# 2026 rookie class predictions
preds = sh.load_career_predictions_2026()
preds.nlargest(10, "percentile")[
    ["name", "position",
     "predictedCareerPPG", "modelTier"]]

# Redraft projections + weekly stats
proj = sh.load_redraft_projections()
weekly = sh.load_player_stats(2024)

# Dynasty values (1QB + SF) + past ADP
dynasty = sh.load_dynasty_values()
adp = sh.load_adp_historical()
`;

const LOADERS: { fn: string; desc: string }[] = [
  { fn: 'load_career_predictions_2026()', desc: '2026 rookie predictions (~77 × ~80 cols)' },
  { fn: 'load_career_backtest()', desc: 'Historical rookies with pred + actual PPG (~1087 × ~100)' },
  { fn: 'load_career_2027()', desc: '2027 draft-class early board (~200 × ~30)' },
  { fn: 'load_redraft_projections()', desc: 'Seasonal redraft PPG + rec/game (~250 × 7)' },
  { fn: 'load_ppg_projections()', desc: 'Model-predicted PPG, established players (~250)' },
  { fn: 'load_adp_value_model()', desc: 'VOR vs ADP, hit prob, conf. interval (~153 × 10)' },
  { fn: 'load_volume_projections()', desc: 'Team pass/rush/target volumes w/ bands (~153)' },
  { fn: 'load_share_projections()', desc: 'Predicted target + rush share (~153)' },
  { fn: 'load_taxi_predictions()', desc: 'Taxi-squad roster/drop probabilities (~96)' },
  { fn: 'load_player_stats(season=None)', desc: 'Per-week NFL box scores 2010-present (~400k)' },
  { fn: 'load_dynasty_values()', desc: 'In-house blended dynasty value, 1QB + SF (~500)' },
  { fn: 'load_dynasty_value_history()', desc: 'Blended daily dynasty value history' },
  { fn: 'load_adp_historical()', desc: 'Model-training ADP 2010-2025 (~4507 × 10)' },
  { fn: 'load_adp_ffc(season=None)', desc: 'Raw community PPR ADP (per season)' },
  { fn: 'load_prospect_grades(year=2026)', desc: 'Scouting-report grades (~200 × 7)' },
  { fn: 'load_player_crosswalk()', desc: 'Canonical cross-source player IDs (~10k)' },
  { fn: 'load_feature_matrix()', desc: 'Raw feature-matrix.json' },
  { fn: 'load_manual_overrides()', desc: 'Manual CFBD usage overrides' },
];

const MCP_CONFIG = `{
  "mcpServers": {
    "stathead": {
      "command": "npx",
      "args": ["-y", "stathead-mcp"]
    }
  }
}`;

// Remote (Streamable HTTP) endpoint for clients that take a URL — claude.ai
// web, the Claude mobile apps, and Claude Desktop's custom connectors.
const MCP_CONNECTOR_URL = 'https://stathead-mcp.dachhack.workers.dev';

const MCP_LINKS: { href: string; label: string; icon: string; title: string }[] = [
  { href: 'https://www.npmjs.com/package/stathead-mcp', label: 'npm', icon: '\u{1F4E6}', title: 'stathead-mcp on npm' },
  { href: 'https://registry.modelcontextprotocol.io/v0/servers?search=stathead', label: 'MCP Registry', icon: '\u{1F50C}', title: 'io.github.dachhack/stathead-mcp in the official MCP Registry' },
  { href: 'https://github.com/dachhack/stathead/tree/main/mcp', label: 'Source', icon: '\u{1F5C2}', title: 'MCP server source on GitHub' },
];

const MCP_TOOLS: { fn: string; desc: string }[] = [
  { fn: 'get_player_metrics', desc: 'Advanced per-player metrics: NGS, snaps, EPA, routes' },
  { fn: 'get_prospect_outcomes', desc: 'Calibrated rookie boom/bust probabilities + grades' },
  { fn: 'get_projections', desc: 'Season PPG projections + scenario presets (Vegas, Consensus…)' },
  { fn: 'get_dynasty_values', desc: 'In-house blended dynasty trade values (1QB + SF)' },
  { fn: 'get_rookie_snap_share', desc: 'Weekly rookie snap-share ramp tracker' },
  { fn: 'get_play_by_play', desc: 'Filterable play-by-play (player, red zone, down…)' },
  { fn: 'get_sleeper_league', desc: 'Open a Sleeper league: format, standings, rosters' },
  { fn: 'get_sleeper_user_snooper', desc: 'Scout a manager’s cross-league player exposure' },
  { fn: 'export_excel', desc: 'Export projections/rankings to Excel — edit & re-import your own' },
  { fn: 'get_metadata', desc: 'Capabilities, coverage, and analytic caveats' },
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
          className="py-quickstart"
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
            <div key={l.fn} className="py-loader">
              <code style={{ color: '#6366f1', fontWeight: 600 }}>{l.fn}</code>
              <span style={{ color: 'var(--text-secondary)' }}>{l.desc}</span>
            </div>
          ))}
        </div>

        <div className="py-note" style={{ marginTop: 14, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55 }}>
          Prefer SQL? <code>pip install &quot;stathead[duckdb]&quot;</code> and{' '}
          <code>sh.query(&quot;SELECT … FROM career_2026 JOIN dynasty_values USING (player_key)&quot;)</code>{' '}
          runs the same tables as the Data Query tab, in Python.
          <br />
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

      <div
        style={{
          marginTop: 20,
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '20px 22px',
        }}
      >
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0, marginBottom: 4 }}>
          MCP server{' '}
          <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)' }}>— for Claude &amp; AI assistants</span>
        </h2>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, marginBottom: 14, lineHeight: 1.55 }}>
          A full set of fantasy football data-analysis tools, queryable straight from Claude (or any{' '}
          <a href="https://modelcontextprotocol.io" target="_blank" rel="noreferrer" style={{ color: '#6366f1' }}>MCP</a>{' '}
          client) — player stats, play-by-play, Next Gen Stats, snap counts, dynasty values, calibrated prospect
          outcomes, season projections with scenario presets, Sleeper league analysis (leagues, rosters, matchups,
          waivers, drafts), and an Excel round-trip so you can edit projections/rankings and feed your own numbers
          back into analysis. Published to npm as{' '}
          <code style={{ background: 'var(--bg-tertiary)', padding: '1px 6px', borderRadius: 3 }}>stathead-mcp</code>{' '}
          — no clone, no API key.
        </p>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          {MCP_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              target="_blank"
              rel="noreferrer"
              title={l.title}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--text-secondary)',
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--border)',
                borderRadius: 999,
                padding: '4px 12px',
                textDecoration: 'none',
              }}
            >
              <span style={{ color: '#6366f1' }}>{l.icon}</span>
              {l.label}
            </a>
          ))}
        </div>

        <h3 style={{ fontSize: 13, fontWeight: 700, margin: 0, marginBottom: 8, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Add to Claude Desktop / Code
        </h3>
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
          <code>{MCP_CONFIG}</code>
        </pre>

        <h3 style={{ fontSize: 13, fontWeight: 700, margin: 0, marginBottom: 8, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Add to claude.ai, mobile &amp; Desktop (connector)
        </h3>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, marginBottom: 8, lineHeight: 1.55 }}>
          No install — these clients take a URL. Go to{' '}
          <strong>Settings → Connectors → Add custom connector</strong>, paste the URL below, and save:
        </p>
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '10px 14px', marginBottom: 8,
          }}
        >
          <code style={{ fontSize: 13, fontWeight: 600, color: '#6366f1', wordBreak: 'break-all' }}>{MCP_CONNECTOR_URL}</code>
          <button
            type="button"
            onClick={() => { void navigator.clipboard?.writeText(MCP_CONNECTOR_URL); }}
            style={{
              marginLeft: 'auto', fontSize: 11, fontWeight: 600, cursor: 'pointer',
              color: 'var(--text-secondary)', background: 'var(--bg-secondary)',
              border: '1px solid var(--border)', borderRadius: 5, padding: '4px 10px',
            }}
          >
            Copy
          </button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, marginBottom: 16, lineHeight: 1.55 }}>
          Hosted over MCP&rsquo;s Streamable HTTP transport (Cloudflare Worker) — same {' '}
          tools as the npm package, no API key. The <code>npx</code> config above stays the path for Claude Code &amp; Cursor.
        </p>

        <h3 style={{ fontSize: 13, fontWeight: 700, margin: 0, marginBottom: 8, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Sample tools
        </h3>
        <div style={{ display: 'grid', gap: 6, fontSize: 12 }}>
          {MCP_TOOLS.map((t) => (
            <div key={t.fn} className="py-loader">
              <code style={{ color: '#6366f1', fontWeight: 600 }}>{t.fn}</code>
              <span style={{ color: 'var(--text-secondary)' }}>{t.desc}</span>
            </div>
          ))}
        </div>

        <div className="py-note" style={{ marginTop: 14, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55 }}>
          Or just run it: <code>npx -y stathead-mcp</code>. ~40 tools total, calibrated and documented (call{' '}
          <code>get_metadata</code> first to scope a question). On{' '}
          <a href="https://www.npmjs.com/package/stathead-mcp" target="_blank" rel="noreferrer" style={{ color: '#6366f1' }}>npm</a>{' '}
          · source in{' '}
          <a href="https://github.com/dachhack/stathead/tree/main/mcp" target="_blank" rel="noreferrer" style={{ color: '#6366f1' }}>mcp/</a>.
        </div>
      </div>

      <div
        style={{
          marginTop: 28,
          paddingTop: 18,
          borderTop: '1px solid var(--border)',
          fontSize: 13,
          color: 'var(--text-secondary)',
          lineHeight: 1.6,
        }}
      >
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 6px' }}>Source &amp; license</h2>
        <p style={{ margin: '0 0 6px' }}>
          StatHead is open source. The full app, modeling pipeline, and data live in the{' '}
          <a href="https://github.com/dachhack/stathead" target="_blank" rel="noreferrer" style={{ color: '#6366f1', fontWeight: 600 }}>
            github.com/dachhack/stathead
          </a>{' '}
          repository — clone it to run locally, browse the data-extraction scripts, or open an issue.
        </p>
        <p style={{ margin: 0, color: 'var(--text-muted)' }}>
          Released under the{' '}
          <a href="https://github.com/dachhack/stathead/blob/main/LICENSE" target="_blank" rel="noreferrer" style={{ color: '#6366f1' }}>
            MIT License
          </a>
          {' '}— free to use, modify, and distribute with attribution; provided &ldquo;as is&rdquo; without warranty.
        </p>
      </div>
    </div>
  );
}
