// Sleeper Draft Grader — a letter per team for any draft, by draft or league id.
//
// The panel says plainly what the grade is and is not, because the honest
// version of this feature is narrower than the usual one. See src/lib/
// draftGrade.ts for the backtest that forced the hedge.
import { useState } from 'react';
import {
  fetchDraft, fetchDraftPicks, importLeague, parseDraftIdInput,
  type SleeperDraftSummary, type LeagueImport,
} from '../lib/sleeper';
import { loadBlendedProjections, computePpr, computeCustomScore } from '../lib/waiverUtils';
import {
  gradeDraft, GRADE_COLOR, type DraftGradeReport, type DraftPickInput, type TeamDraftGrade,
} from '../lib/draftGrade';

// Slots a draft's settings can describe when there is no league to read.
const SLOT_KEYS: Array<[keyof NonNullable<SleeperDraftSummary['settings']>, string]> = [
  ['slots_qb', 'QB'], ['slots_rb', 'RB'], ['slots_wr', 'WR'], ['slots_te', 'TE'],
  ['slots_flex', 'FLEX'], ['slots_super_flex', 'SUPER_FLEX'],
];

function rosterPositionsFor(draft: SleeperDraftSummary, league: LeagueImport | null): string[] {
  if (league?.league.roster_positions?.length) return league.league.roster_positions;
  const out: string[] = [];
  for (const [key, pos] of SLOT_KEYS) {
    const n = Number(draft.settings?.[key] ?? 0);
    for (let i = 0; i < n; i++) out.push(pos);
  }
  // A mock with no slot settings still needs something legal to fill.
  return out.length ? out : ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
}

const LS_LEAGUE = 'sleeper_draft_grader_league';

export function DraftGraderView() {
  // Lazy initialiser rather than an effect: no state-set on mount.
  const [input, setInput] = useState(() => {
    try { return localStorage.getItem(LS_LEAGUE) ?? ''; } catch { return ''; }
  });
  const [report, setReport] = useState<DraftGradeReport | null>(null);
  const [draft, setDraft] = useState<SleeperDraftSummary | null>(null);
  const [names, setNames] = useState<Map<number, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    const id = parseDraftIdInput(input);
    if (!id) { setError('Enter a Sleeper draft ID, league ID, or URL.'); return; }
    setLoading(true); setError(null); setReport(null); setDraft(null);
    try {
      // A league id is far likelier to be pasted than a draft id, so try the
      // league first and fall back to treating the input as a draft.
      let draftId = id;
      let league: LeagueImport | null = null;
      try {
        league = await importLeague(id);
        if (league.league.draft_id) draftId = league.league.draft_id;
      } catch { /* not a league id — treat it as a draft id */ }

      const info = await fetchDraft(draftId);
      if (!league && info.league_id) league = await importLeague(info.league_id).catch(() => null);

      const [picks, projections] = await Promise.all([
        fetchDraftPicks(draftId),
        loadBlendedProjections(),
      ]);
      if (!picks.length) throw new Error('That draft has no picks yet.');

      const scoring = league?.league.scoring_settings ?? {};
      const custom = Object.keys(scoring).length > 0;
      const pool: Array<{ playerId: string; position: string; points: number }> = [];
      const projByPlayerId = new Map<string, number>();
      for (const p of projections) {
        if (!p.sleeperId) continue;
        const pts = custom ? computeCustomScore(p, scoring) : computePpr(p);
        projByPlayerId.set(p.sleeperId, pts);
        pool.push({ playerId: p.sleeperId, position: p.position, points: pts });
      }

      const graderPicks: DraftPickInput[] = picks.map((p) => ({
        pickNo: p.pick_no,
        round: p.round,
        // Mocks have no rosters; the draft slot still identifies a drafter.
        rosterId: p.roster_id ?? p.draft_slot ?? null,
        playerId: p.player_id,
        playerName: `${p.metadata?.first_name ?? ''} ${p.metadata?.last_name ?? ''}`.trim() || p.player_id,
        position: p.metadata?.position ?? '',
      }));

      const teamName = new Map<number, string>();
      for (const t of league?.teams ?? []) teamName.set(t.rosterId, t.owner || t.teamName);

      setReport(gradeDraft({
        picks: graderPicks, projByPlayerId, pool,
        rosterPositions: rosterPositionsFor(info, league),
        teams: info.settings?.teams ?? league?.teams.length ?? 12,
      }));
      setDraft(info);
      setNames(teamName);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not grade that draft.');
    } finally {
      setLoading(false);
    }
  };

  const label = (t: TeamDraftGrade) => names.get(t.rosterId) ?? `Slot ${t.rosterId}`;

  return (
    <div style={{ padding: '12px 0' }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 20 }}>Draft grader</h2>
      <p style={{ margin: '0 0 10px', fontSize: 12, opacity: 0.75, maxWidth: 720, lineHeight: 1.5 }}>
        A letter per team for any Sleeper draft. Graded on StatHead's projections and your
        league's own roster settings, on a curve — a draft is a competition against the other
        teams in the room, so someone gets the A and someone gets the F.
      </p>

      <div style={{
        maxWidth: 720, margin: '0 0 14px', padding: '8px 12px', fontSize: 11.5, lineHeight: 1.55,
        border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-secondary)', opacity: 0.9,
      }}>
        <strong>What this is not.</strong> It is not a prediction. Grading 3,310 real
        team-drafts against how those seasons actually finished, nothing derived from draft-day
        pricing predicted points scored once lookahead bias was removed — every correlation fell
        to roughly zero. So this measures how good your squad looks <em>on our numbers</em> and
        how much of the board you captured. That is a description with a stated yardstick, not a
        forecast.
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void run(); }}
          placeholder="Sleeper draft ID, league ID, or URL"
          style={{ padding: '6px 10px', fontSize: 13, minWidth: 300 }}
        />
        <button className="format-tab active" onClick={() => void run()} disabled={loading}
          style={{ padding: '6px 14px', fontSize: 13, fontWeight: 700 }}>
          {loading ? 'Grading…' : 'Grade draft'}
        </button>
      </div>

      {error && <div className="empty-state"><h3>Could not grade that draft</h3><p>{error}</p></div>}

      {report?.notApplicable && (
        <div className="empty-state">
          <h3>Seasonal projections don't describe this draft</h3>
          <p style={{ maxWidth: 620, margin: '0 auto', lineHeight: 1.55 }}>{report.notApplicable}</p>
        </div>
      )}

      {report && !report.notApplicable && draft && (
        <>
          <p style={{ fontSize: 11.5, opacity: 0.7, margin: '0 0 8px' }}>
            {draft.season} {draft.type} draft · {report.teams.length} teams · {report.gradedPicks} picks graded
            {report.unmatchedPicks > 0 && ` · ${report.unmatchedPicks} pick(s) had no projection and scored nothing`}
            {' · '}replacement level: {Object.entries(report.replacementRank)
              .map(([p, r]) => `${p}${r}`).join(' / ')}
          </p>
          <div className="table-container" style={{ maxHeight: 'none' }}>
            <table className="sched-table" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th>#</th><th>Grade</th><th>Team</th>
                  <th title="Projected points of the best legal starting lineup they drafted">Starters</th>
                  <th title="Share of the value on the board at their own picks that they took">Capture</th>
                  <th>Best pick</th><th title="The pick where the most value was still on the board, and who was there">Most passed up</th>
                </tr>
              </thead>
              <tbody>
                {report.teams.map((t) => (
                  <tr key={t.rosterId}>
                    <td className="rank-cell">{t.rank}</td>
                    <td>
                      <span style={{
                        display: 'inline-block', minWidth: 20, padding: '1px 5px', textAlign: 'center',
                        borderRadius: 4, background: GRADE_COLOR[t.grade], color: '#fff',
                        fontWeight: 700, fontSize: 11,
                      }}>{t.grade}</span>
                    </td>
                    <td><strong>{label(t)}</strong></td>
                    <td style={{ fontWeight: 600 }}>{t.starterPoints.toFixed(0)}</td>
                    <td>{(t.captureRate * 100).toFixed(0)}%</td>
                    <td style={{ fontSize: 11 }}>
                      {t.bestPick ? `${t.bestPick.playerName} (${t.bestPick.round}.${String(t.bestPick.pickNo).padStart(2, '0')})` : '—'}
                    </td>
                    <td style={{ fontSize: 11, opacity: 0.85 }}>
                      {t.worstPick && t.worstPick.leftOnBoard > 0
                        ? `${t.worstPick.playerName} over ${t.worstPick.bestAvailableName} (${t.worstPick.leftOnBoard.toFixed(0)})`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
