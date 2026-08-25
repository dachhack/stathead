// Dynasty retention — a 1-5 grade per current league member.
//
// 1 = most likely to stay, 5 = most likely to leave. Grades come from FIXED
// cutpoints in the training population, not from ranking the twelve managers in
// front of you: grading within a league would guarantee a flight risk in a
// perfectly stable league and an anchor in a collapsing one.
//
// Framing: this is for deciding who to talk to before the draft. It is not a
// list of people to squeeze in trades.
import { useState } from 'react';
import { fetchDepartureModel, scoreDynastyLeague, GRADE_LABEL, GRADE_COLOR, type LeagueDepartureReport } from '../lib/dynastyDeparture';
import { importLeague, type LeagueImport } from '../lib/sleeper';
import { parseDraftIdInput } from '../lib/sleeper';

// The standings table writes the league id here when you click a risk cell, so
// arriving from a league view lands on the right league already typed in.
const LS_LEAGUE = 'sleeper_retention_league';

export function DynastyRetentionView() {
  // Lazy initializer, not an effect: no state-set on mount, no extra render.
  const [input, setInput] = useState(() => {
    try { return localStorage.getItem(LS_LEAGUE) ?? ''; } catch { return ''; }
  });
  const [report, setReport] = useState<LeagueDepartureReport | null>(null);
  const [league, setLeague] = useState<LeagueImport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const [verify, setVerify] = useState(false);

  const run = async () => {
    const leagueId = parseDraftIdInput(input);
    if (!leagueId) { setError('Enter a Sleeper league ID.'); return; }
    setLoading(true); setError(null); setReport(null); setLeague(null);
    setProgress('Loading the model…');
    try {
      const model = await fetchDepartureModel(import.meta.env.BASE_URL, verify);
      const [scored, imported] = await Promise.all([
        scoreDynastyLeague(leagueId, model, { verify, onProgress: setProgress }),
        importLeague(leagueId).catch(() => null),
      ]);
      setReport(scored);
      setLeague(imported);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not score this league.');
    } finally {
      setLoading(false); setProgress('');
    }
  };

  // Owner id -> display name, when the league import succeeded.
  const nameOf = (ownerId: string) => {
    const team = league?.teams.find((t) => t.ownerId === ownerId);
    return team ? { team: team.teamName, owner: team.owner } : { team: ownerId, owner: '' };
  };

  const counts = report?.members.reduce((acc, m) => {
    acc[m.grade] = (acc[m.grade] ?? 0) + 1;
    return acc;
  }, {} as Record<number, number>) ?? {};

  return (
    <div style={{ padding: '12px 0' }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 20 }}>Dynasty retention grades</h2>
      <p style={{ margin: '0 0 12px', fontSize: 12, opacity: 0.75, maxWidth: 680, lineHeight: 1.5 }}>
        A 1–5 grade per current member for how likely they are to leave before next season.
        Dynasty only — redraft groups often recreate leagues from scratch, so Sleeper's season
        links say nothing about whether the same people came back. Grades use fixed thresholds
        from the training population, so a grade means the same thing in every league.
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void run(); }}
          placeholder="Sleeper league ID or URL"
          style={{ padding: '6px 10px', fontSize: 13, minWidth: 280 }}
        />
        <button className="format-tab active" onClick={() => void run()} disabled={loading}
          style={{ padding: '6px 14px', fontSize: 13, fontWeight: 700 }}>
          {loading ? 'Scoring…' : 'Score league'}
        </button>
        {progress && <span style={{ fontSize: 12, opacity: 0.7 }}>{progress}</span>}
      </div>

      <label style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12, marginBottom: 14, maxWidth: 680, cursor: 'pointer' }}>
        <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} style={{ marginTop: 2 }} />
        <span>
          <strong>Verify past exits</strong> — slower but more accurate.
          <span style={{ opacity: 0.7 }}>
            {' '}Off, a manager leaving a league and the league folding look identical, and they
            differ on ~58% of cases. Verifying costs a few hundred extra requests and takes up to a
            minute; it lifts AUC from 0.604 to 0.644 and the riskiest fifth from 23.5% to 27.2%.
            Results are cached, so a second league is quicker.
          </span>
        </span>
      </label>

      {error && <div style={{ fontSize: 13, color: '#b91c1c', marginBottom: 10 }}>{error}</div>}

      {report?.notApplicable && (
        <div style={{ fontSize: 13, maxWidth: 680, lineHeight: 1.5 }}>{report.notApplicable}</div>
      )}

      {report && !report.notApplicable && (
        <>
          <div style={{ fontSize: 12, marginBottom: 10 }}>
            <strong>{report.season}</strong> · {report.members.length} members · seasons walked{' '}
            {report.seasonsWalked.join(', ') || '—'} · {report.requests} Sleeper requests
            {(counts[4] || counts[5]) ? (
              <> · <strong>{(counts[4] ?? 0) + (counts[5] ?? 0)}</strong> graded 4 or 5</>
            ) : <> · nobody above grade 3</>}
          </div>

          <div style={{
            fontSize: 11, marginBottom: 10, padding: '6px 9px', borderRadius: 4, maxWidth: 680,
            background: report.verification.applied ? 'rgba(21,128,61,0.10)' : 'rgba(161,98,7,0.10)',
          }}>
            <strong>{report.verification.applied ? 'Past exits verified' : 'Past exits approximate'}</strong>
            {' — '}{report.verification.note}
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 12, minWidth: 620 }}>
              <thead>
                <tr style={{ textAlign: 'left', opacity: 0.7 }}>
                  <th style={{ padding: '4px 8px' }}>Grade</th>
                  <th style={{ padding: '4px 8px' }}>Member</th>
                  <th style={{ padding: '4px 8px', textAlign: 'right' }}>Leave prob.</th>
                  <th style={{ padding: '4px 8px', textAlign: 'right' }}>Years here</th>
                  <th style={{ padding: '4px 8px', textAlign: 'right' }}>Leagues</th>
                  <th style={{ padding: '4px 8px', textAlign: 'right' }}>Past exits</th>
                </tr>
              </thead>
              <tbody>
                {report.members.map((m) => {
                  const n = nameOf(m.ownerId);
                  return (
                    <tr key={m.ownerId}>
                      <td style={{ padding: '6px 8px' }}>
                        <span style={{
                          background: GRADE_COLOR[m.grade], color: '#fff', borderRadius: 4,
                          padding: '2px 7px', fontWeight: 800, fontSize: 12,
                        }}>{m.grade}</span>
                        <span style={{ marginLeft: 6, fontSize: 11, opacity: 0.75 }}>{GRADE_LABEL[m.grade]}</span>
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        <div style={{ fontWeight: 700 }}>{n.team}</div>
                        {n.owner && <div style={{ fontSize: 11, opacity: 0.7 }}>{n.owner}</div>}
                      </td>
                      <td style={{ padding: '6px 8px', textAlign: 'right' }}>{(100 * m.risk).toFixed(1)}%</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                        {m.tenureYears}{m.tenureCensored ? '+' : ''}
                      </td>
                      <td style={{ padding: '6px 8px', textAlign: 'right' }}>{m.portfolioSize}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                        {m.priorLeaveObserved === 0 ? '—' : `${(100 * m.priorLeaveRate).toFixed(0)}% of ${m.priorLeaveObserved}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 11, opacity: 0.65, marginTop: 12, maxWidth: 680, lineHeight: 1.55 }}>
            <p style={{ margin: '0 0 6px' }}>
              <strong>How good is this?</strong> Cross-validated by manager,{' '}
              {report.verification.applied
                ? 'with past exits verified: AUC 0.644, and the riskiest fifth of members left at 27.2% against 7.1% for the safest fifth.'
                : 'with past exits approximated: AUC 0.604, and the riskiest fifth of members left at 23.5% against 9.6% for the safest fifth.'}
              {' '}A real spread, but a modest ranking either way. Treat a grade as a prompt to check
              in, not a verdict.
            </p>
            <p style={{ margin: 0 }}>
              A "+" on years here means they were already in the league when our window starts, so
              their real tenure is longer than shown.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
