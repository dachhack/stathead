import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { getDuckDB, runQuery, TABLE_DOCS, EXAMPLE_QUERIES } from '../lib/duckdb';

type State =
  | { kind: 'idle' }
  | { kind: 'loading'; msg: string }
  | { kind: 'results'; columns: string[]; rows: Record<string, unknown>[]; rowCount: number; elapsedMs: number }
  | { kind: 'error'; message: string };

// Detailed-table card shown when a table name is clicked in the sidebar.
interface TableDetail {
  name: string;
  description: string;
  rowCount: number;
  columns: Array<{ name: string; type: string; nullable: boolean }>;
  sampleRows: Record<string, unknown>[];
}

const STORAGE_KEY = 'stathead-data-query-sql';
const DEDUPE_STORAGE_KEY = 'stathead-data-query-dedupe';

/** Drop exact duplicates — compares every column in every row via a JSON
 *  fingerprint. Applied to the result set BEFORE rendering, so the on-screen
 *  count reflects distinct rows. */
function dedupeRows(
  columns: string[],
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const key = columns.map((c) => {
      const v = r[c];
      return v === null || v === undefined ? '\0' : String(v);
    }).join('');
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

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
  const [dedupe, setDedupe] = useState<boolean>(() => {
    try { return localStorage.getItem(DEDUPE_STORAGE_KEY) === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(DEDUPE_STORAGE_KEY, dedupe ? '1' : '0'); } catch {}
  }, [dedupe]);
  const [detail, setDetail] = useState<
    | { kind: 'loading'; name: string }
    | { kind: 'ready'; data: TableDetail }
    | { kind: 'error'; name: string; message: string }
    | null
  >(null);
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

  // Close detail modal on Escape
  useEffect(() => {
    if (!detail) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDetail(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detail]);

  const openTableDetail = useCallback(async (name: string, description: string) => {
    setDetail({ kind: 'loading', name });
    try {
      // DESCRIBE gives column_name + column_type + null. COUNT + SELECT *
      // LIMIT 10 give row count + preview. Cheap queries — even on the
      // largest table (player_stats ~ 100k rows) these return in ~50 ms.
      const [describe, count, sample] = await Promise.all([
        runQuery(`DESCRIBE ${name}`),
        runQuery(`SELECT COUNT(*) AS n FROM ${name}`),
        runQuery(`SELECT * FROM ${name} LIMIT 10`),
      ]);
      const columns = describe.rows.map((r) => ({
        name: String(r.column_name ?? ''),
        type: String(r.column_type ?? ''),
        nullable: String(r.null ?? 'YES').toUpperCase() !== 'NO',
      }));
      const rowCount = Number(count.rows[0]?.n ?? 0);
      setDetail({
        kind: 'ready',
        data: {
          name, description, rowCount,
          columns,
          sampleRows: sample.rows,
        },
      });
    } catch (e) {
      setDetail({ kind: 'error', name, message: (e as Error).message || String(e) });
    }
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

  // Memoize the deduped row set so the status line + the result table use
  // the same array (and the dedupe cost runs exactly once per (result, toggle)).
  const displayRows = useMemo(() => {
    if (state.kind !== 'results') return null;
    return dedupe ? dedupeRows(state.columns, state.rows) : state.rows;
  }, [state, dedupe]);

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
            <label
              title="Drop exact duplicate rows (compares every selected column). Applied to the display; the underlying query is unchanged."
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                fontSize: 11, color: 'var(--text-secondary)', cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <input
                type="checkbox"
                checked={dedupe}
                onChange={(e) => setDedupe(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              Dedupe rows
            </label>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {state.kind === 'results' && displayRows && (
                dedupe && displayRows.length !== state.rowCount
                  ? `${displayRows.length.toLocaleString()} unique of ${state.rowCount.toLocaleString()} rows in ${state.elapsedMs.toFixed(0)} ms`
                  : `${state.rowCount.toLocaleString()} rows in ${state.elapsedMs.toFixed(0)} ms`
              )}
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
                <button
                  onClick={() => dbReady && openTableDetail(t.name, t.description)}
                  disabled={!dbReady}
                  title="Click for full schema + sample rows"
                  style={{
                    padding: 0, margin: 0, background: 'transparent', border: 'none',
                    color: '#6366f1', fontFamily: 'ui-monospace, monospace',
                    fontWeight: 700, fontSize: 11,
                    cursor: dbReady ? 'pointer' : 'not-allowed',
                    textDecoration: 'underline', textDecorationColor: 'transparent',
                    textUnderlineOffset: 2, transition: 'text-decoration-color 0.1s',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.textDecorationColor = '#6366f1'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.textDecorationColor = 'transparent'; }}
                >
                  {t.name}
                </button>
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

      {state.kind === 'results' && displayRows && (
        <ResultTable columns={state.columns} rows={displayRows} />
      )}

      {detail && (
        <TableDetailModal
          detail={detail}
          onClose={() => setDetail(null)}
          onUseInQuery={(name) => {
            setSql(`SELECT *\nFROM ${name}\nLIMIT 100;`);
            setDetail(null);
          }}
        />
      )}
    </div>
  );
}

function TableDetailModal({
  detail,
  onClose,
  onUseInQuery,
}: {
  detail:
    | { kind: 'loading'; name: string }
    | { kind: 'ready'; data: TableDetail }
    | { kind: 'error'; name: string; message: string };
  onClose: () => void;
  onUseInQuery: (name: string) => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-primary)', border: '1px solid var(--border)',
          borderRadius: 10, width: '100%', maxWidth: 960,
          maxHeight: '85vh', display: 'flex', flexDirection: 'column',
          boxShadow: '0 24px 48px rgba(0,0,0,0.3)',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '14px 18px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap',
        }}>
          <code style={{
            fontSize: 16, fontWeight: 700, color: '#6366f1',
            fontFamily: 'ui-monospace, monospace',
          }}>{detail.kind === 'ready' ? detail.data.name : detail.name}</code>
          {detail.kind === 'ready' && (
            <>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {detail.data.rowCount.toLocaleString()} rows · {detail.data.columns.length} columns
              </span>
              <button
                onClick={() => onUseInQuery(detail.data.name)}
                style={{
                  marginLeft: 'auto', padding: '4px 10px', fontSize: 11, fontWeight: 600,
                  background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
                  border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
                }}
              >
                Use in query
              </button>
            </>
          )}
          <button
            onClick={onClose}
            title="Close (Esc)"
            style={{
              marginLeft: detail.kind === 'ready' ? 4 : 'auto',
              padding: '4px 10px', fontSize: 14, fontWeight: 700,
              background: 'transparent', color: 'var(--text-muted)',
              border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 18, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {detail.kind === 'loading' && (
            <div style={{ color: 'var(--text-muted)', fontSize: 12, fontStyle: 'italic' }}>
              Loading schema + sample rows...
            </div>
          )}
          {detail.kind === 'error' && (
            <div style={{
              color: '#ef4444', fontSize: 12, fontFamily: 'ui-monospace, monospace',
              whiteSpace: 'pre-wrap',
            }}>
              {detail.message}
            </div>
          )}
          {detail.kind === 'ready' && (
            <>
              <div style={{ color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.5 }}>
                {detail.data.description}
              </div>

              {/* Column schema */}
              <div>
                <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--text-primary)', marginBottom: 6 }}>
                  Columns ({detail.data.columns.length})
                </div>
                <div style={{
                  border: '1px solid var(--border)', borderRadius: 6,
                  overflow: 'auto', maxHeight: 280, background: 'var(--bg-secondary)',
                }}>
                  <table style={{
                    width: '100%', borderCollapse: 'collapse', fontSize: 11,
                    fontFamily: 'ui-monospace, monospace',
                  }}>
                    <thead style={{
                      position: 'sticky', top: 0, background: 'var(--bg-tertiary)', zIndex: 1,
                    }}>
                      <tr>
                        <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 700, color: 'var(--text-primary)', borderBottom: '1px solid var(--border)' }}>column</th>
                        <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 700, color: 'var(--text-primary)', borderBottom: '1px solid var(--border)' }}>type</th>
                        <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 700, color: 'var(--text-primary)', borderBottom: '1px solid var(--border)' }}>null?</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.data.columns.map((c) => (
                        <tr key={c.name} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={{ padding: '4px 10px', color: 'var(--text-primary)' }}>{c.name}</td>
                          <td style={{ padding: '4px 10px', color: '#a3e635' }}>{c.type}</td>
                          <td style={{ padding: '4px 10px', color: c.nullable ? 'var(--text-muted)' : 'var(--text-secondary)' }}>
                            {c.nullable ? 'yes' : 'no'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Sample rows */}
              <div>
                <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--text-primary)', marginBottom: 6 }}>
                  Sample rows ({detail.data.sampleRows.length} of {detail.data.rowCount.toLocaleString()})
                </div>
                {detail.data.sampleRows.length === 0 ? (
                  <div style={{ color: 'var(--text-muted)', fontSize: 12, fontStyle: 'italic' }}>
                    Table is empty.
                  </div>
                ) : (
                  <div style={{
                    border: '1px solid var(--border)', borderRadius: 6,
                    overflow: 'auto', maxHeight: 260, background: 'var(--bg-secondary)',
                  }}>
                    <table style={{
                      borderCollapse: 'collapse', fontSize: 11,
                      fontFamily: 'ui-monospace, monospace',
                    }}>
                      <thead style={{
                        position: 'sticky', top: 0, background: 'var(--bg-tertiary)', zIndex: 1,
                      }}>
                        <tr>
                          {Object.keys(detail.data.sampleRows[0]).map((c) => (
                            <th key={c} style={{
                              padding: '6px 10px', textAlign: 'left', fontWeight: 700,
                              color: 'var(--text-primary)', borderBottom: '1px solid var(--border)',
                              whiteSpace: 'nowrap',
                            }}>{c}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {detail.data.sampleRows.map((r, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                            {Object.keys(detail.data.sampleRows[0]).map((c) => (
                              <td key={c} style={{
                                padding: '4px 10px', color: 'var(--text-secondary)',
                                whiteSpace: 'nowrap', maxWidth: 200,
                                overflow: 'hidden', textOverflow: 'ellipsis',
                              }} title={formatVal(r[c])}>
                                {formatVal(r[c])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
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
