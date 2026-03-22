import { useState, useEffect, useMemo } from 'react';
import {
  fetchFfcADP, fetchPlayerStats, aggregateToSeasonTotals,
  fetchDraftPicks, fetchRosters,
} from '../data';
import type { SeasonTotals, DraftPick, FfcADPPlayer, Roster } from '../types';

// ── Config ──

const PREDICT_SEASON = 2026;
const PROJECTED_GAMES = 17;
const POSITIONS = ['QB', 'RB', 'WR', 'TE'] as const;
type Position = typeof POSITIONS[number];

const POS_COLORS: Record<string, string> = {
  QB: '#6366f1', RB: '#10b981', WR: '#f59e0b', TE: '#ef4444',
};

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[.']/g, '').replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '').replace(/\s+/g, ' ').trim();
}

// ── Projection interfaces ──

interface QBProjection {
  name: string; team: string; adp: number; games: number;
  passAtt: number; passComp: number; passYds: number; passTD: number; int: number;
  rushAtt: number; rushYds: number; rushTD: number;
  pprPts: number;
}

interface RBProjection {
  name: string; team: string; adp: number; games: number;
  rushAtt: number; rushYds: number; rushTD: number;
  tgt: number; rec: number; recYds: number; recTD: number;
  pprPts: number;
}

interface WRProjection {
  name: string; team: string; adp: number; games: number;
  tgt: number; rec: number; recYds: number; recTD: number;
  rushAtt: number; rushYds: number; rushTD: number;
  pprPts: number;
}

interface TEProjection {
  name: string; team: string; adp: number; games: number;
  tgt: number; rec: number; recYds: number; recTD: number;
  pprPts: number;
}

// PPR scoring
function computePPR(p: {
  passYds?: number; passTD?: number; int?: number;
  rushYds?: number; rushTD?: number;
  rec?: number; recYds?: number; recTD?: number;
}): number {
  return (
    (p.passYds || 0) * 0.04 + (p.passTD || 0) * 4 + (p.int || 0) * -2 +
    (p.rushYds || 0) * 0.1 + (p.rushTD || 0) * 6 +
    (p.rec || 0) * 1 + (p.recYds || 0) * 0.1 + (p.recTD || 0) * 6
  );
}

// ── Component ──

export function StatProjections() {
  const [loading, setLoading] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selectedPos, setSelectedPos] = useState<Position>('RB');

  const [qbProjections, setQBProjections] = useState<QBProjection[]>([]);
  const [rbProjections, setRBProjections] = useState<RBProjection[]>([]);
  const [wrProjections, setWRProjections] = useState<WRProjection[]>([]);
  const [teProjections, setTEProjections] = useState<TEProjection[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        setLoadingStatus('Loading ADP & prior-season data...');

        const [adpData, priorStats, draftData, rosters] = await Promise.all([
          fetchFfcADP(PREDICT_SEASON, 'ppr', 12).catch(() => [] as FfcADPPlayer[]),
          fetchPlayerStats(PREDICT_SEASON - 1).catch(() => []),
          fetchDraftPicks().catch(() => [] as DraftPick[]),
          fetchRosters(PREDICT_SEASON).catch(() => [] as Roster[]),
        ]);
        if (cancelled) return;

        if (adpData.length === 0) {
          setError(`No ${PREDICT_SEASON} ADP data available yet`);
          return;
        }

        setLoadingStatus('Building projections...');

        // Prior season totals
        const priorTotals = aggregateToSeasonTotals(
          priorStats.filter((s) => s.season_type === 'REG')
        );
        const priorByName = new Map<string, SeasonTotals>();
        for (const p of priorTotals) {
          if (['QB', 'RB', 'WR', 'TE'].includes(p.position)) {
            priorByName.set(normalizeName(p.player_display_name), p);
          }
        }

        // Roster: player → current team
        const rosterTeam = new Map<string, string>();
        for (const r of rosters) {
          if (['QB', 'RB', 'WR', 'TE'].includes(r.position)) {
            rosterTeam.set(normalizeName(r.full_name), r.team);
          }
        }

        // Draft data for age/experience
        const draftByName = new Map<string, DraftPick>();
        for (const d of draftData) draftByName.set(normalizeName(d.pfr_player_name), d);

        // Position-specific prior-season per-game averages for league-wide median regression
        const posMedians: Record<string, { ppg: number[]; count: number }> = {
          QB: { ppg: [], count: 0 },
          RB: { ppg: [], count: 0 },
          WR: { ppg: [], count: 0 },
          TE: { ppg: [], count: 0 },
        };
        for (const p of priorTotals) {
          if (['QB', 'RB', 'WR', 'TE'].includes(p.position) && p.games >= 8) {
            posMedians[p.position].ppg.push((p.fantasy_points_ppr || 0) / p.games);
            posMedians[p.position].count += 1;
          }
        }

        // Projected games: use prior games played + small regression to full season
        function projectGames(prior: SeasonTotals | undefined): number {
          if (!prior) return 14; // replacement-level guess
          const priorGames = prior.games || 0;
          // Regress toward 16 games (not full 17 — account for some injury risk)
          return Math.min(17, Math.round((priorGames * 0.6 + 16 * 0.4) * 10) / 10);
        }

        // Age-based regression factor (older players produce slightly less)
        function ageFactor(name: string, pos: string): number {
          const draft = draftByName.get(name);
          if (!draft) return 1;
          const age = (draft.age || 0) + (PREDICT_SEASON - draft.season);
          if (pos === 'RB') {
            if (age >= 30) return 0.80;
            if (age >= 28) return 0.90;
            if (age >= 26) return 0.95;
          } else if (pos === 'WR') {
            if (age >= 32) return 0.85;
            if (age >= 30) return 0.92;
          } else if (pos === 'QB') {
            if (age >= 38) return 0.90;
            if (age >= 36) return 0.95;
          } else if (pos === 'TE') {
            if (age >= 32) return 0.88;
            if (age >= 30) return 0.94;
          }
          return 1;
        }

        const qbs: QBProjection[] = [];
        const rbs: RBProjection[] = [];
        const wrs: WRProjection[] = [];
        const tes: TEProjection[] = [];

        for (const adp of adpData) {
          if (!['QB', 'RB', 'WR', 'TE'].includes(adp.position)) continue;
          if (adp.adp > 250) continue;

          const normalName = normalizeName(adp.name);
          const prior = priorByName.get(normalName);
          const team = rosterTeam.get(normalName) || adp.team || '';
          const games = projectGames(prior);
          const af = ageFactor(normalName, adp.position);

          // If no prior stats, use ADP-implied baseline
          if (!prior || prior.games < 3) {
            // Rough ADP-implied baseline projections for players without prior stats (rookies, etc.)
            if (adp.position === 'QB') {
              const basePts = Math.max(50, 320 - adp.adp * 1.5);
              qbs.push({
                name: adp.name, team, adp: adp.adp, games: 16,
                passAtt: 520, passComp: 340, passYds: 3800, passTD: 24, int: 12,
                rushAtt: 45, rushYds: 180, rushTD: 2,
                pprPts: Math.round(basePts),
              });
            } else if (adp.position === 'RB') {
              const basePts = Math.max(40, 280 - adp.adp * 1.2);
              rbs.push({
                name: adp.name, team, adp: adp.adp, games: 15,
                rushAtt: 180, rushYds: 750, rushTD: 5,
                tgt: 45, rec: 35, recYds: 280, recTD: 1,
                pprPts: Math.round(basePts),
              });
            } else if (adp.position === 'WR') {
              const basePts = Math.max(40, 260 - adp.adp * 1.1);
              wrs.push({
                name: adp.name, team, adp: adp.adp, games: 16,
                tgt: 100, rec: 60, recYds: 780, recTD: 5,
                rushAtt: 5, rushYds: 20, rushTD: 0,
                pprPts: Math.round(basePts),
              });
            } else {
              const basePts = Math.max(30, 200 - adp.adp * 1.0);
              tes.push({
                name: adp.name, team, adp: adp.adp, games: 16,
                tgt: 75, rec: 50, recYds: 550, recTD: 4,
                pprPts: Math.round(basePts),
              });
            }
            continue;
          }

          const pg = prior.games;

          if (adp.position === 'QB') {
            const passAtt = Math.round((prior.attempts || 0) / pg * games * af);
            const compRate = (prior.attempts || 0) > 0 ? (prior.completions || 0) / prior.attempts : 0.63;
            const passComp = Math.round(passAtt * compRate);
            const ypa = (prior.attempts || 0) > 0 ? (prior.passing_yards || 0) / prior.attempts : 7.0;
            const passYds = Math.round(passAtt * ypa);
            const tdRate = (prior.attempts || 0) > 0 ? (prior.passing_tds || 0) / prior.attempts : 0.04;
            const passTD = Math.round(passAtt * tdRate);
            const intRate = (prior.attempts || 0) > 0 ? (prior.interceptions || 0) / prior.attempts : 0.025;
            const ints = Math.round(passAtt * intRate);
            const rushAtt = Math.round((prior.carries || 0) / pg * games * af);
            const ypc = (prior.carries || 0) > 0 ? (prior.rushing_yards || 0) / prior.carries : 4.0;
            const rushYds = Math.round(rushAtt * ypc);
            const rushTDrate = (prior.carries || 0) > 0 ? (prior.rushing_tds || 0) / prior.carries : 0.04;
            const rushTD = Math.round(rushAtt * rushTDrate);

            const pts = computePPR({ passYds, passTD, int: ints, rushYds, rushTD });
            qbs.push({
              name: adp.name, team, adp: adp.adp, games: Math.round(games),
              passAtt, passComp, passYds, passTD, int: ints,
              rushAtt, rushYds, rushTD,
              pprPts: Math.round(pts),
            });
          } else if (adp.position === 'RB') {
            const rushAtt = Math.round((prior.carries || 0) / pg * games * af);
            const ypc = (prior.carries || 0) > 0 ? (prior.rushing_yards || 0) / prior.carries : 4.0;
            const rushYds = Math.round(rushAtt * ypc);
            const rushTDrate = (prior.carries || 0) > 0 ? (prior.rushing_tds || 0) / prior.carries : 0.035;
            const rushTD = Math.max(0, Math.round(rushAtt * rushTDrate));
            const tgt = Math.round((prior.targets || 0) / pg * games * af);
            const catchRate = (prior.targets || 0) > 0 ? (prior.receptions || 0) / prior.targets : 0.75;
            const rec = Math.round(tgt * catchRate);
            const ypr = (prior.receptions || 0) > 0 ? (prior.receiving_yards || 0) / prior.receptions : 7.5;
            const recYds = Math.round(rec * ypr);
            const recTDrate = (prior.targets || 0) > 0 ? (prior.receiving_tds || 0) / prior.targets : 0.02;
            const recTD = Math.max(0, Math.round(tgt * recTDrate));

            const pts = computePPR({ rushYds, rushTD, rec, recYds, recTD });
            rbs.push({
              name: adp.name, team, adp: adp.adp, games: Math.round(games),
              rushAtt, rushYds, rushTD,
              tgt, rec, recYds, recTD,
              pprPts: Math.round(pts),
            });
          } else if (adp.position === 'WR') {
            const tgt = Math.round((prior.targets || 0) / pg * games * af);
            const catchRate = (prior.targets || 0) > 0 ? (prior.receptions || 0) / prior.targets : 0.65;
            const rec = Math.round(tgt * catchRate);
            const ypr = (prior.receptions || 0) > 0 ? (prior.receiving_yards || 0) / prior.receptions : 12.5;
            const recYds = Math.round(rec * ypr);
            const recTDrate = (prior.targets || 0) > 0 ? (prior.receiving_tds || 0) / prior.targets : 0.06;
            const recTD = Math.max(0, Math.round(tgt * recTDrate));
            const rushAtt = Math.round((prior.carries || 0) / pg * games * af);
            const rushYpc = (prior.carries || 0) > 0 ? (prior.rushing_yards || 0) / prior.carries : 5.0;
            const rushYds = Math.round(rushAtt * rushYpc);
            const rushTDrate = (prior.carries || 0) > 0 ? (prior.rushing_tds || 0) / Math.max(prior.carries, 1) : 0;
            const rushTD = Math.max(0, Math.round(rushAtt * rushTDrate));

            const pts = computePPR({ rushYds, rushTD, rec, recYds, recTD });
            wrs.push({
              name: adp.name, team, adp: adp.adp, games: Math.round(games),
              tgt, rec, recYds, recTD,
              rushAtt, rushYds, rushTD,
              pprPts: Math.round(pts),
            });
          } else if (adp.position === 'TE') {
            const tgt = Math.round((prior.targets || 0) / pg * games * af);
            const catchRate = (prior.targets || 0) > 0 ? (prior.receptions || 0) / prior.targets : 0.68;
            const rec = Math.round(tgt * catchRate);
            const ypr = (prior.receptions || 0) > 0 ? (prior.receiving_yards || 0) / prior.receptions : 11.0;
            const recYds = Math.round(rec * ypr);
            const recTDrate = (prior.targets || 0) > 0 ? (prior.receiving_tds || 0) / prior.targets : 0.05;
            const recTD = Math.max(0, Math.round(tgt * recTDrate));

            const pts = computePPR({ rec, recYds, recTD });
            tes.push({
              name: adp.name, team, adp: adp.adp, games: Math.round(games),
              tgt, rec, recYds, recTD,
              pprPts: Math.round(pts),
            });
          }
        }

        // Sort by PPR points descending
        qbs.sort((a, b) => b.pprPts - a.pprPts);
        rbs.sort((a, b) => b.pprPts - a.pprPts);
        wrs.sort((a, b) => b.pprPts - a.pprPts);
        tes.sort((a, b) => b.pprPts - a.pprPts);

        if (!cancelled) {
          setQBProjections(qbs);
          setRBProjections(rbs);
          setWRProjections(wrs);
          setTEProjections(tes);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to build projections');
      } finally {
        setLoading(false);
      }
    }

    run();
    return () => { cancelled = true; };
  }, []);

  const currentData = useMemo(() => {
    if (selectedPos === 'QB') return qbProjections;
    if (selectedPos === 'RB') return rbProjections;
    if (selectedPos === 'WR') return wrProjections;
    return teProjections;
  }, [selectedPos, qbProjections, rbProjections, wrProjections, teProjections]);

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">
          {loadingStatus}
          <br />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Building {PREDICT_SEASON} stat projections from prior-season rates
          </span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <h3>Error</h3>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <>
      <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 12 }}>
        {PREDICT_SEASON} season stat projections based on {PREDICT_SEASON - 1} per-game rates, projected games, and age regression.
        Sorted by projected PPR fantasy points.
      </p>

      {/* Position tabs */}
      <div className="controls" style={{ marginBottom: 16 }}>
        <div className="control-group">
          <label className="control-label">Position</label>
          <div style={{ display: 'flex', gap: 4 }}>
            {POSITIONS.map((pos) => (
              <button
                key={pos}
                className={`pos-filter ${selectedPos === pos ? 'active' : ''}`}
                onClick={() => setSelectedPos(pos)}
                style={{ borderColor: POS_COLORS[pos] }}
              >
                {pos}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        {POSITIONS.map((pos) => {
          const data = pos === 'QB' ? qbProjections : pos === 'RB' ? rbProjections : pos === 'WR' ? wrProjections : teProjections;
          const top = data[0];
          return (
            <div
              key={pos}
              onClick={() => setSelectedPos(pos)}
              style={{
                background: selectedPos === pos ? 'var(--bg-tertiary)' : 'var(--bg-secondary)',
                border: `2px solid ${selectedPos === pos ? POS_COLORS[pos] : 'var(--border)'}`,
                borderRadius: 8,
                padding: '12px 16px',
                cursor: 'pointer',
                minWidth: 140,
              }}
            >
              <div style={{ fontSize: 16, fontWeight: 700, color: POS_COLORS[pos], marginBottom: 4 }}>
                {pos}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                <div>{data.length} players projected</div>
                {top && <div>#{1}: <strong style={{ color: 'var(--text-primary)' }}>{top.name}</strong></div>}
                {top && <div>{top.pprPts} PPR pts</div>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Projection table */}
      <h4 style={{ marginBottom: 8 }}>
        <span style={{ color: POS_COLORS[selectedPos] }}>{selectedPos}</span> Projections — {PREDICT_SEASON}
        <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>
          {currentData.length} players
        </span>
      </h4>
      <div className="table-container" style={{ marginBottom: 20, maxHeight: 600, overflowY: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              <th>Team</th>
              <th>ADP</th>
              <th>Gm</th>
              {selectedPos === 'QB' && (
                <>
                  <th colSpan={5} style={{ textAlign: 'center', borderBottom: `2px solid ${POS_COLORS.QB}` }}>PASSING</th>
                  <th colSpan={3} style={{ textAlign: 'center', borderBottom: '2px solid #10b981' }}>RUSHING</th>
                </>
              )}
              {selectedPos === 'RB' && (
                <>
                  <th colSpan={3} style={{ textAlign: 'center', borderBottom: '2px solid #10b981' }}>RUSHING</th>
                  <th colSpan={4} style={{ textAlign: 'center', borderBottom: `2px solid ${POS_COLORS.WR}` }}>RECEIVING</th>
                </>
              )}
              {selectedPos === 'WR' && (
                <>
                  <th colSpan={4} style={{ textAlign: 'center', borderBottom: `2px solid ${POS_COLORS.WR}` }}>RECEIVING</th>
                  <th colSpan={3} style={{ textAlign: 'center', borderBottom: '2px solid #10b981' }}>RUSHING</th>
                </>
              )}
              {selectedPos === 'TE' && (
                <th colSpan={4} style={{ textAlign: 'center', borderBottom: `2px solid ${POS_COLORS.TE}` }}>RECEIVING</th>
              )}
              <th style={{ borderBottom: '2px solid #f59e0b' }}>PPR</th>
            </tr>
            <tr>
              <th></th>
              <th></th>
              <th></th>
              <th></th>
              <th></th>
              {selectedPos === 'QB' && (
                <>
                  <th>Att</th><th>Cmp</th><th>Yds</th><th>TD</th><th>INT</th>
                  <th>Att</th><th>Yds</th><th>TD</th>
                </>
              )}
              {selectedPos === 'RB' && (
                <>
                  <th>Att</th><th>Yds</th><th>TD</th>
                  <th>Tgt</th><th>Rec</th><th>Yds</th><th>TD</th>
                </>
              )}
              {selectedPos === 'WR' && (
                <>
                  <th>Tgt</th><th>Rec</th><th>Yds</th><th>TD</th>
                  <th>Att</th><th>Yds</th><th>TD</th>
                </>
              )}
              {selectedPos === 'TE' && (
                <>
                  <th>Tgt</th><th>Rec</th><th>Yds</th><th>TD</th>
                </>
              )}
              <th>Pts</th>
            </tr>
          </thead>
          <tbody>
            {selectedPos === 'QB' && qbProjections.map((p, i) => (
              <tr key={p.name}>
                <td className="rank-cell">{i + 1}</td>
                <td><strong>{p.name}</strong></td>
                <td style={{ color: 'var(--text-muted)' }}>{p.team}</td>
                <td>{p.adp.toFixed(1)}</td>
                <td>{p.games}</td>
                <td>{p.passAtt}</td>
                <td>{p.passComp}</td>
                <td>{p.passYds.toLocaleString()}</td>
                <td style={{ fontWeight: 700 }}>{p.passTD}</td>
                <td style={{ color: '#ef4444' }}>{p.int}</td>
                <td>{p.rushAtt}</td>
                <td>{p.rushYds}</td>
                <td style={{ fontWeight: 700 }}>{p.rushTD}</td>
                <td style={{ fontWeight: 700, color: POS_COLORS.QB }}>{p.pprPts}</td>
              </tr>
            ))}
            {selectedPos === 'RB' && rbProjections.map((p, i) => (
              <tr key={p.name}>
                <td className="rank-cell">{i + 1}</td>
                <td><strong>{p.name}</strong></td>
                <td style={{ color: 'var(--text-muted)' }}>{p.team}</td>
                <td>{p.adp.toFixed(1)}</td>
                <td>{p.games}</td>
                <td>{p.rushAtt}</td>
                <td>{p.rushYds.toLocaleString()}</td>
                <td style={{ fontWeight: 700 }}>{p.rushTD}</td>
                <td>{p.tgt}</td>
                <td>{p.rec}</td>
                <td>{p.recYds}</td>
                <td style={{ fontWeight: 700 }}>{p.recTD}</td>
                <td style={{ fontWeight: 700, color: POS_COLORS.RB }}>{p.pprPts}</td>
              </tr>
            ))}
            {selectedPos === 'WR' && wrProjections.map((p, i) => (
              <tr key={p.name}>
                <td className="rank-cell">{i + 1}</td>
                <td><strong>{p.name}</strong></td>
                <td style={{ color: 'var(--text-muted)' }}>{p.team}</td>
                <td>{p.adp.toFixed(1)}</td>
                <td>{p.games}</td>
                <td>{p.tgt}</td>
                <td>{p.rec}</td>
                <td>{p.recYds.toLocaleString()}</td>
                <td style={{ fontWeight: 700 }}>{p.recTD}</td>
                <td>{p.rushAtt}</td>
                <td>{p.rushYds}</td>
                <td style={{ fontWeight: 700 }}>{p.rushTD}</td>
                <td style={{ fontWeight: 700, color: POS_COLORS.WR }}>{p.pprPts}</td>
              </tr>
            ))}
            {selectedPos === 'TE' && teProjections.map((p, i) => (
              <tr key={p.name}>
                <td className="rank-cell">{i + 1}</td>
                <td><strong>{p.name}</strong></td>
                <td style={{ color: 'var(--text-muted)' }}>{p.team}</td>
                <td>{p.adp.toFixed(1)}</td>
                <td>{p.games}</td>
                <td>{p.tgt}</td>
                <td>{p.rec}</td>
                <td>{p.recYds.toLocaleString()}</td>
                <td style={{ fontWeight: 700 }}>{p.recTD}</td>
                <td style={{ fontWeight: 700, color: POS_COLORS.TE }}>{p.pprPts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
