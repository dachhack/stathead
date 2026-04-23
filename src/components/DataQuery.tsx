import { useState, useCallback, useEffect, useRef } from 'react';
import { getDuckDB, runQuery, TABLE_DOCS, EXAMPLE_QUERIES } from '../lib/duckdb';

type State =
  | { kind: 'idle' }
  | { kind: 'loading'; msg: string }
  | { kind: 'results'; columns: string[]; rows: Record<string, unknown>[]; rowCount: number; elapsedMs: number }
  | { kind: 'error'; message: string };

const STORAGE_KEY = 'stathead-data-query-sql';

const DEFAULT_SQL = `-- Query the underlying model data with SQL.
-- Tables: career_2026, backtest, prospects.
-- Ctrl/Cmd + Enter to run.
SELECT name, position, adp, predictedCareerPPG, percentile, modelTier
FROM career_2026
WHERE percentile >= 85
ORDER BY percentile DESC, predictedCareerPPG DESC;`;

export function DataQuery() {
  const [sql, setSql] = useState<string>(() => {
    try { return localStorage.getItem(STORAGE_KEY) || DEFAULT_SQL; } catch { return DEFAULT_SQL; }
  });
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [dbReady, setDbReady] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Warm the duckdb singleton on first mount (lazy-loads the ~10 MB wasm).
  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading', msg: 'Loading DuckDB-WASM engine (~10 MB, one-time)...' });
    getDuckDB()
      .then(() => { if (!cancelled) { setDbReady(true); setState({ kind: 'idle' }); } })
      .catch((e) => { if (!cancelled) setState({ kind: 'error', message: String(e) }); });
    return () => { cancelled = true; };
  }, []);

  const run = useCallback(async () => {
    if (!sql.trim()) return;
    try { localStorage.setItem(STORAGE_KEY, sql); } catch {}
    setState({ kind: 'loading', msg: 'Running query...' });
    try {
      const out = await runQuery(sql);
      setState({ kind: 'results', ...out });
    } catch (e) {
      setState({ kind: 'error', message: (e as Error).message || String(e) });
    }
  }, [sql]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      run();
    }
  };

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
      <div>
        <h2 style={{ fontSize: 18, margin: '0 0 4px', color: 'var(--text-primary)' }}>Data Query</h2>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
          Full SQL over the model data — joins, aggregates, window functions, CTEs. Runs entirely in your browser via DuckDB-WASM.
        </p>
      </div>

      {/* Editor + sidebar */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 280px', gap: 12, minHeight: 220 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea
            ref={taRef}
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            style={{
              width: '100%', minHeight: 180, padding: 12,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 12, lineHeight: 1.5,
              background: 'var(--bg-secondary)', color: 'var(--text-primary)',
              border: '1px solid var(--border)', borderRadius: 6, resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={run}
              disabled={!dbReady || state.kind === 'loading'}
              style={{
                padding: '6px 14px', fontSize: 13, fontWeight: 700,
                background: !dbReady || state.kind === 'loading' ? 'var(--bg-tertiary)' : '#6366f1',
                color: '#fff', border: 'none', borderRadius: 6,
                cursor: !dbReady || state.kind === 'loading' ? 'not-allowed' : 'pointer',
              }}
            >
              {state.kind === 'loading' ? 'Running…' : dbReady ? 'Run (⌘↵)' : 'Loading engine…'}
            </button>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {state.kind === 'results' && `${state.rowCount.toLocaleString()} rows in ${state.elapsedMs.toFixed(0)} ms`}
              {state.kind === 'loading' && state.msg}
            </span>
          </div>
        </div>

        {/* Sidebar: schema + examples */}
        <div style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          borderRadius: 6, padding: 10, fontSize: 11, overflowY: 'auto', maxHeight: 320,
        }}>
          <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6, fontSize: 12 }}>
            Tables
          </div>
          {TABLE_DOCS.map((t) => (
            <div key={t.name} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <strong style={{ color: '#6366f1', fontFamily: 'ui-monospace, monospace' }}>{t.name}</strong>
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 10, marginTop: 2, lineHeight: 1.4 }}>
                {t.description}
              </div>
              <div style={{ color: 'var(--text-secondary)', fontSize: 10, marginTop: 3, fontFamily: 'ui-monospace, monospace' }}>
                {t.exampleColumns.slice(0, 8).join(', ')}
                {t.exampleColumns.length > 8 ? ', …' : ''}
              </div>
            </div>
          ))}

          <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginTop: 14, marginBottom: 6, fontSize: 12 }}>
            Example queries
          </div>
          {EXAMPLE_QUERIES.map((q) => (
            <button
              key={q.label}
              onClick={() => setSql(q.sql)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '4px 6px', marginBottom: 3, fontSize: 11,
                background: 'transparent', color: 'var(--text-secondary)',
                border: '1px dashed var(--border)', borderRadius: 4, cursor: 'pointer',
              }}
              onMouseEnter={(e) => { (e.target as HTMLElement).style.background = 'var(--bg-tertiary)'; }}
              onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'transparent'; }}
            >
              {q.label}
            </button>
          ))}

          <div style={{ marginTop: 12, fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.4 }}>
            Tip: columns with 0 for scout/PDF/RSP features indicate the player
            wasn't in that source. NULL is genuinely unknown.
          </div>
        </div>
      </div>

      {/* Results */}
      {state.kind === 'error' && (
        <div style={{
          background: 'rgba(239,68,68,0.1)', border: '1px solid #ef4444',
          color: '#ef4444', padding: 10, borderRadius: 6, fontSize: 12,
          fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre-wrap',
        }}>
          {state.message}
        </div>
      )}

      {state.kind === 'results' && <ResultTable columns={state.columns} rows={state.rows} />}
    </div>
  );
}

function ResultTable({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
  if (!rows.length) {
    return (
      <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 12, fontStyle: 'italic' }}>
        Query returned 0 rows.
      </div>
    );
  }
  const displayRows = rows.slice(0, 500);
  return (
    <div style={{
      overflow: 'auto', maxHeight: '60vh',
      border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)',
    }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>
        <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-tertiary)', zIndex: 1 }}>
          <tr>
            {columns.map((c) => (
              <th
                key={c}
                style={{
                  padding: '6px 10px', textAlign: 'left', fontWeight: 700,
                  color: 'var(--text-primary)', borderBottom: '1px solid var(--border)',
                  whiteSpace: 'nowrap',
                }}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {displayRows.map((r, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
              {columns.map((c) => (
                <td
                  key={c}
                  style={{
                    padding: '4px 10px', color: 'var(--text-secondary)',
                    whiteSpace: 'nowrap', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis',
                  }}
                  title={formatVal(r[c])}
                >
                  {formatVal(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 500 && (
        <div style={{ padding: 8, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
          Showing first 500 of {rows.length.toLocaleString()} rows. Add a tighter WHERE / LIMIT to narrow.
        </div>
      )}
    </div>
  );
}

function formatVal(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v);
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(Math.abs(v) >= 100 ? 1 : 3);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}
