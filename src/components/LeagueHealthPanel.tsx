// League health, retrospectively: who checked out last season, and are they back.
//
// Deliberately descriptive. For a completed season the outcome is observed —
// we can see exactly who stopped transacting and when — so no model runs here.
// It also makes no claim about what last season's disengagement means for next
// year: on the crawled population only 25 of 1,628 managers had an observable
// dark season, and their same-league return rate was 88.0% against 90.5% for
// everyone else. No separation, so no prediction is offered.
//
// Framing: this is for deciding who needs a check-in or a replacement before
// the draft. It is not a list of opponents to take advantage of.
import { useState } from 'react';
import { computeLeagueRetrospective, type LeagueRetrospective, type RetrospectiveManager } from '../lib/leagueHealth';
import type { LeagueImport } from '../lib/sleeper';

function statusOf(m: RetrospectiveManager): { label: string; color: string } {
  if (m.transactions === 0) return { label: 'Never active', color: '#b91c1c' };
  if (m.wentDark && m.returned === false) return { label: 'Checked out · gone', color: '#b91c1c' };
  if (m.wentDark) return { label: 'Checked out', color: '#c2410c' };
  if (m.returned === false) return { label: 'Left', color: '#a16207' };
  return { label: 'Engaged', color: '#15803d' };
}

function Row({ m, observedWeek }: { m: RetrospectiveManager; observedWeek: number }) {
  const s = statusOf(m);
  return (
    <tr>
      <td style={{ padding: '6px 8px' }}>
        <div style={{ fontWeight: 700 }}>{m.teamName}</div>
        <div style={{ fontSize: 11, opacity: 0.7 }}>{m.owner}</div>
      </td>
      <td style={{ padding: '6px 8px', textAlign: 'center' }}>
        <span style={{
          background: s.color, color: '#fff', borderRadius: 4,
          padding: '2px 6px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
        }}>{s.label}</span>
      </td>
      <td style={{ padding: '6px 8px', textAlign: 'right' }}>{m.transactions}</td>
      <td style={{ padding: '6px 8px', textAlign: 'right' }}>
        {m.lastActiveWeek === null ? '—' : `wk ${m.lastActiveWeek}`}
      </td>
      <td style={{ padding: '6px 8px', textAlign: 'right' }}>
        {m.lastActiveWeek === null ? '—' : `${m.weeksSilentAtEnd} of ${observedWeek}`}
      </td>
      <td style={{ padding: '6px 8px', textAlign: 'center' }}>
        {m.returned === null ? '—' : m.returned ? 'yes' : 'no'}
      </td>
    </tr>
  );
}

export function LeagueHealthPanel({ data }: { data: LeagueImport }) {
  const [expanded, setExpanded] = useState(false);
  const [result, setResult] = useState<LeagueRetrospective | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Loading is kicked off by the click, not by an effect. Opening the panel is a
  // user action, not React synchronising with an external system, and a fetch
  // driven from an effect body means a cascading render on every open.
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (!next || result || loading) return;
    setLoading(true);
    computeLeagueRetrospective(data)
      .then(setResult)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load last season.'))
      .finally(() => setLoading(false));
  };

  return (
    <div style={{ marginTop: 16 }}>
      <button
        className="format-tab"
        onClick={toggle}
        style={{ padding: '6px 12px', fontSize: 12, fontWeight: 700 }}
      >
        {expanded ? '▾' : '▸'} League health — last season
      </button>

      {expanded && (
        <div style={{ marginTop: 10 }}>
          {loading && <div style={{ fontSize: 12, opacity: 0.7 }}>Reading last season's transactions…</div>}
          {error && <div style={{ fontSize: 12, color: '#b91c1c' }}>{error}</div>}

          {result?.notApplicable && (
            <div style={{ fontSize: 12, opacity: 0.8, maxWidth: 640 }}>{result.notApplicable}</div>
          )}

          {result && !result.notApplicable && (
            <>
              <div style={{ fontSize: 12, marginBottom: 8 }}>
                <strong>{result.season}</strong> · {result.managers.length} teams ·{' '}
                <strong>{result.wentDarkCount}</strong> checked out before the season ended
                {result.darkAndGone > 0 && <>, <strong>{result.darkAndGone}</strong> of them no longer in the league</>}.
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', fontSize: 12, minWidth: 560 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', opacity: 0.7 }}>
                      <th style={{ padding: '4px 8px' }}>Team</th>
                      <th style={{ padding: '4px 8px', textAlign: 'center' }}>Status</th>
                      <th style={{ padding: '4px 8px', textAlign: 'right' }}>Moves</th>
                      <th style={{ padding: '4px 8px', textAlign: 'right' }}>Last move</th>
                      <th style={{ padding: '4px 8px', textAlign: 'right' }}>Quiet weeks</th>
                      <th style={{ padding: '4px 8px', textAlign: 'center' }}>Back this year</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.managers.map((m) => (
                      <Row key={m.rosterId} m={m} observedWeek={result.observedWeek} />
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{ fontSize: 11, opacity: 0.65, marginTop: 10, maxWidth: 640, lineHeight: 1.5 }}>
                <p style={{ margin: '0 0 6px' }}>
                  "Checked out" means no adds, drops, waiver claims or trades for the last 5+ weeks
                  of the season — {result.observedWeek} weeks of activity were recorded. Observed
                  from the transaction log, not predicted.
                </p>
                <p style={{ margin: 0 }}>
                  It does <strong>not</strong> predict whether someone will return. On our sample only
                  25 of 1,628 managers had an observable checked-out season, and their return rate to
                  the same league was 88% against 90% for everyone else — too close, and too few, to
                  call. Use this to decide who is worth a message before the draft.
                </p>
              </div>
              {result.weeksFailed > 0 && (
                <div style={{ fontSize: 11, color: '#a16207', marginTop: 6 }}>
                  {result.weeksFailed} week(s) of transactions could not be loaded, so counts may be low.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
