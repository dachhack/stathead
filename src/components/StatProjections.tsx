import { useState, useEffect, useMemo } from 'react';
import {
  fetchFfcADP, fetchPlayerStats, aggregateToSeasonTotals,
  fetchDraftPicks, fetchRosters, fetchGames,
  fetchOddsGameLines, aggregateOddsToTeamImplied,
} from '../data';
import type { SeasonTotals, DraftPick, FfcADPPlayer, Roster, Game } from '../types';

// ── Config ──

const PREDICT_SEASON = 2026;
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

type ViewMode = 'position' | 'team';

const TEAM_POS_LIMITS: Record<Position, number> = { QB: 2, RB: 4, WR: 5, TE: 3 };

interface TeamGroup {
  team: string;
  totalPPR: number;
  qbs: QBProjection[];
  rbs: RBProjection[];
  wrs: WRProjection[];
  tes: TEProjection[];
}

export function StatProjections() {
  const [loading, setLoading] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selectedPos, setSelectedPos] = useState<Position>('RB');
  const [viewMode, setViewMode] = useState<ViewMode>('position');

  const [qbProjections, setQBProjections] = useState<QBProjection[]>([]);
  const [rbProjections, setRBProjections] = useState<RBProjection[]>([]);
  const [wrProjections, setWRProjections] = useState<WRProjection[]>([]);
  const [teProjections, setTEProjections] = useState<TEProjection[]>([]);
  const [oddsSource, setOddsSource] = useState<'live' | 'historical' | ''>('');

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        setLoadingStatus('Loading ADP & prior-season data...');

        const [adpData, priorStats, draftData, rosters, gamesData, oddsLines] = await Promise.all([
          fetchFfcADP(PREDICT_SEASON, 'ppr', 12).catch(() => [] as FfcADPPlayer[]),
          fetchPlayerStats(PREDICT_SEASON - 1).catch(() => []),
          fetchDraftPicks().catch(() => [] as DraftPick[]),
          fetchRosters(PREDICT_SEASON).catch(() => [] as Roster[]),
          fetchGames().catch(() => [] as Game[]),
          fetchOddsGameLines().catch(() => []),
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

        // Vegas implied totals per team
        // Prefer live Odds API lines for the upcoming season; fall back to prior-season game data
        const oddsTeamImplied = oddsLines.length > 0 ? aggregateOddsToTeamImplied(oddsLines) : [];
        const teamImpliedTotals = new Map<string, { sum: number; count: number }>();

        if (oddsTeamImplied.length > 0) {
          // Use fresh Odds API data
          for (const t of oddsTeamImplied) {
            teamImpliedTotals.set(t.team, { sum: t.avgImplied * t.gameCount, count: t.gameCount });
          }
        } else {
          // Fall back to prior-season game lines
          const priorSeasonGames = gamesData.filter(
            (g) => g.season === PREDICT_SEASON - 1 && g.game_type === 'REG' && g.total_line > 0
          );
          for (const g of priorSeasonGames) {
            const homeImpl = (g.total_line - g.spread_line) / 2;
            const awayImpl = (g.total_line + g.spread_line) / 2;
            if (!teamImpliedTotals.has(g.home_team)) teamImpliedTotals.set(g.home_team, { sum: 0, count: 0 });
            if (!teamImpliedTotals.has(g.away_team)) teamImpliedTotals.set(g.away_team, { sum: 0, count: 0 });
            const h = teamImpliedTotals.get(g.home_team)!;
            h.sum += homeImpl; h.count += 1;
            const a = teamImpliedTotals.get(g.away_team)!;
            a.sum += awayImpl; a.count += 1;
          }
        }
        // League average implied total per game
        let leagueImpliedSum = 0; let leagueImpliedCount = 0;
        for (const [, v] of teamImpliedTotals) {
          leagueImpliedSum += v.sum; leagueImpliedCount += v.count;
        }
        const leagueAvgImplied = leagueImpliedCount > 0 ? leagueImpliedSum / leagueImpliedCount : 23;
        const usingLiveOdds = oddsTeamImplied.length > 0;

        // Vegas multiplier: team's implied total vs league average
        // A team at 27 vs league avg 23 → 27/23 = 1.17 → capped multiplier
        function vegasMultiplier(teamAbbr: string): number {
          const t = teamImpliedTotals.get(teamAbbr);
          if (!t || t.count === 0) return 1;
          const teamAvg = t.sum / t.count;
          // Dampen: blend 60% team-specific, 40% league average
          const blended = teamAvg * 0.6 + leagueAvgImplied * 0.4;
          return Math.max(0.85, Math.min(1.15, blended / leagueAvgImplied));
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
          const vm = vegasMultiplier(team);

          // If no prior stats, use ADP-implied baseline (scaled by Vegas)
          if (!prior || prior.games < 3) {
            if (adp.position === 'QB') {
              const basePts = Math.max(50, 320 - adp.adp * 1.5) * vm;
              qbs.push({
                name: adp.name, team, adp: adp.adp, games: 16,
                passAtt: Math.round(520 * vm), passComp: Math.round(340 * vm),
                passYds: Math.round(3800 * vm), passTD: Math.round(24 * vm), int: 12,
                rushAtt: Math.round(45 * vm), rushYds: Math.round(180 * vm), rushTD: 2,
                pprPts: Math.round(basePts),
              });
            } else if (adp.position === 'RB') {
              const basePts = Math.max(40, 280 - adp.adp * 1.2) * vm;
              rbs.push({
                name: adp.name, team, adp: adp.adp, games: 15,
                rushAtt: Math.round(180 * vm), rushYds: Math.round(750 * vm), rushTD: Math.round(5 * vm),
                tgt: Math.round(45 * vm), rec: Math.round(35 * vm), recYds: Math.round(280 * vm), recTD: 1,
                pprPts: Math.round(basePts),
              });
            } else if (adp.position === 'WR') {
              const basePts = Math.max(40, 260 - adp.adp * 1.1) * vm;
              wrs.push({
                name: adp.name, team, adp: adp.adp, games: 16,
                tgt: Math.round(100 * vm), rec: Math.round(60 * vm), recYds: Math.round(780 * vm), recTD: Math.round(5 * vm),
                rushAtt: 5, rushYds: 20, rushTD: 0,
                pprPts: Math.round(basePts),
              });
            } else {
              const basePts = Math.max(30, 200 - adp.adp * 1.0) * vm;
              tes.push({
                name: adp.name, team, adp: adp.adp, games: 16,
                tgt: Math.round(75 * vm), rec: Math.round(50 * vm), recYds: Math.round(550 * vm), recTD: Math.round(4 * vm),
                pprPts: Math.round(basePts),
              });
            }
            continue;
          }

          const pg = prior.games;

          if (adp.position === 'QB') {
            const passAtt = Math.round((prior.attempts || 0) / pg * games * af * vm);
            const compRate = (prior.attempts || 0) > 0 ? (prior.completions || 0) / prior.attempts : 0.63;
            const passComp = Math.round(passAtt * compRate);
            const ypa = (prior.attempts || 0) > 0 ? (prior.passing_yards || 0) / prior.attempts : 7.0;
            const passYds = Math.round(passAtt * ypa);
            const tdRate = (prior.attempts || 0) > 0 ? (prior.passing_tds || 0) / prior.attempts : 0.04;
            const passTD = Math.round(passAtt * tdRate);
            const intRate = (prior.attempts || 0) > 0 ? (prior.interceptions || 0) / prior.attempts : 0.025;
            const ints = Math.round(passAtt * intRate);
            const rushAtt = Math.round((prior.carries || 0) / pg * games * af * vm);
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
            const rushAtt = Math.round((prior.carries || 0) / pg * games * af * vm);
            const ypc = (prior.carries || 0) > 0 ? (prior.rushing_yards || 0) / prior.carries : 4.0;
            const rushYds = Math.round(rushAtt * ypc);
            const rushTDrate = (prior.carries || 0) > 0 ? (prior.rushing_tds || 0) / prior.carries : 0.035;
            const rushTD = Math.max(0, Math.round(rushAtt * rushTDrate));
            const tgt = Math.round((prior.targets || 0) / pg * games * af * vm);
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
            const tgt = Math.round((prior.targets || 0) / pg * games * af * vm);
            const catchRate = (prior.targets || 0) > 0 ? (prior.receptions || 0) / prior.targets : 0.65;
            const rec = Math.round(tgt * catchRate);
            const ypr = (prior.receptions || 0) > 0 ? (prior.receiving_yards || 0) / prior.receptions : 12.5;
            const recYds = Math.round(rec * ypr);
            const recTDrate = (prior.targets || 0) > 0 ? (prior.receiving_tds || 0) / prior.targets : 0.06;
            const recTD = Math.max(0, Math.round(tgt * recTDrate));
            const rushAtt = Math.round((prior.carries || 0) / pg * games * af * vm);
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
            const tgt = Math.round((prior.targets || 0) / pg * games * af * vm);
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

        // ── Fill roster gaps: ensure every team has enough players at each position ──
        // Track which players already have projections
        const projectedNames = new Set<string>();
        for (const p of qbs) projectedNames.add(normalizeName(p.name));
        for (const p of rbs) projectedNames.add(normalizeName(p.name));
        for (const p of wrs) projectedNames.add(normalizeName(p.name));
        for (const p of tes) projectedNames.add(normalizeName(p.name));

        // Count projected players per team+position
        const teamPosCounts = new Map<string, number>();
        function tpKey(team: string, pos: string) { return `${team}:${pos}`; }
        for (const p of qbs) teamPosCounts.set(tpKey(p.team, 'QB'), (teamPosCounts.get(tpKey(p.team, 'QB')) || 0) + 1);
        for (const p of rbs) teamPosCounts.set(tpKey(p.team, 'RB'), (teamPosCounts.get(tpKey(p.team, 'RB')) || 0) + 1);
        for (const p of wrs) teamPosCounts.set(tpKey(p.team, 'WR'), (teamPosCounts.get(tpKey(p.team, 'WR')) || 0) + 1);
        for (const p of tes) teamPosCounts.set(tpKey(p.team, 'TE'), (teamPosCounts.get(tpKey(p.team, 'TE')) || 0) + 1);

        // Build roster candidates grouped by team+pos, sorted by prior PPR (best first)
        const rosterCandidates = new Map<string, { name: string; fullName: string; team: string; pos: string; prior: SeasonTotals | undefined }[]>();
        for (const r of rosters) {
          if (!POSITIONS.includes(r.position as Position)) continue;
          const nn = normalizeName(r.full_name);
          if (projectedNames.has(nn)) continue;
          const key = tpKey(r.team, r.position);
          if (!rosterCandidates.has(key)) rosterCandidates.set(key, []);
          rosterCandidates.get(key)!.push({
            name: r.full_name, fullName: r.full_name, team: r.team, pos: r.position,
            prior: priorByName.get(nn),
          });
        }
        // Also add prior-season players as candidates (for teams whose roster file is thin)
        for (const p of priorTotals) {
          if (!POSITIONS.includes(p.position as Position)) continue;
          const nn = normalizeName(p.player_display_name);
          if (projectedNames.has(nn)) continue;
          const team = rosterTeam.get(nn) || p.recent_team || '';
          if (!team) continue;
          const key = tpKey(team, p.position);
          // Only add if not already a roster candidate
          const existing = rosterCandidates.get(key) || [];
          if (existing.some(c => normalizeName(c.name) === nn)) continue;
          if (!rosterCandidates.has(key)) rosterCandidates.set(key, []);
          rosterCandidates.get(key)!.push({
            name: p.player_display_name, fullName: p.player_display_name, team, pos: p.position,
            prior: p,
          });
        }

        // Sort candidates: those with prior stats first (by PPR desc), then by name
        for (const [, candidates] of rosterCandidates) {
          candidates.sort((a, b) => {
            const aPPR = a.prior ? (a.prior.fantasy_points_ppr || 0) : -1;
            const bPPR = b.prior ? (b.prior.fantasy_points_ppr || 0) : -1;
            return bPPR - aPPR;
          });
        }

        // All teams: from rosters + already-projected players
        const allTeams = new Set<string>();
        for (const r of rosters) {
          if (r.team && POSITIONS.includes(r.position as Position)) allTeams.add(r.team);
        }
        for (const p of qbs) { if (p.team) allTeams.add(p.team); }
        for (const p of rbs) { if (p.team) allTeams.add(p.team); }
        for (const p of wrs) { if (p.team) allTeams.add(p.team); }
        for (const p of tes) { if (p.team) allTeams.add(p.team); }

        for (const team of allTeams) {
          for (const pos of POSITIONS) {
            const currentCount = teamPosCounts.get(tpKey(team, pos)) || 0;
            const needed = TEAM_POS_LIMITS[pos] - currentCount;
            if (needed <= 0) continue;

            const candidates = rosterCandidates.get(tpKey(team, pos)) || [];
            const vm = vegasMultiplier(team);

            for (let ci = 0; ci < needed; ci++) {
              const cand = candidates[ci];
              const prior = cand?.prior;
              const playerName = cand?.name || `${team} ${pos}${currentCount + ci + 1}`;

              if (pos === 'QB') {
                if (prior && prior.games >= 3) {
                  const pg = prior.games;
                  const games = projectGames(prior);
                  const af = ageFactor(normalizeName(playerName), 'QB');
                  const passAtt = Math.round((prior.attempts || 0) / pg * games * af * vm);
                  const compRate = (prior.attempts || 0) > 0 ? (prior.completions || 0) / prior.attempts : 0.63;
                  const passComp = Math.round(passAtt * compRate);
                  const ypa = (prior.attempts || 0) > 0 ? (prior.passing_yards || 0) / prior.attempts : 7.0;
                  const passYds = Math.round(passAtt * ypa);
                  const tdRate = (prior.attempts || 0) > 0 ? (prior.passing_tds || 0) / prior.attempts : 0.04;
                  const passTD = Math.round(passAtt * tdRate);
                  const intRate = (prior.attempts || 0) > 0 ? (prior.interceptions || 0) / prior.attempts : 0.025;
                  const ints = Math.round(passAtt * intRate);
                  const rushAtt = Math.round((prior.carries || 0) / pg * games * af * vm);
                  const ypc = (prior.carries || 0) > 0 ? (prior.rushing_yards || 0) / prior.carries : 4.0;
                  const rushYds = Math.round(rushAtt * ypc);
                  const rushTDrate = (prior.carries || 0) > 0 ? (prior.rushing_tds || 0) / prior.carries : 0.04;
                  const rushTD = Math.round(rushAtt * rushTDrate);
                  const pts = computePPR({ passYds, passTD, int: ints, rushYds, rushTD });
                  qbs.push({ name: playerName, team, adp: 999, games: Math.round(games), passAtt, passComp, passYds, passTD, int: ints, rushAtt, rushYds, rushTD, pprPts: Math.round(pts) });
                } else {
                  // Backup QB baseline
                  const pts = computePPR({ passYds: 800, passTD: 5, int: 4, rushYds: 40, rushTD: 0 });
                  qbs.push({ name: playerName, team, adp: 999, games: 6, passAtt: 130, passComp: 80, passYds: 800, passTD: 5, int: 4, rushAtt: 12, rushYds: 40, rushTD: 0, pprPts: Math.round(pts) });
                }
              } else if (pos === 'RB') {
                if (prior && prior.games >= 3) {
                  const pg = prior.games;
                  const games = projectGames(prior);
                  const af = ageFactor(normalizeName(playerName), 'RB');
                  const rushAtt = Math.round((prior.carries || 0) / pg * games * af * vm);
                  const ypc = (prior.carries || 0) > 0 ? (prior.rushing_yards || 0) / prior.carries : 4.0;
                  const rushYds = Math.round(rushAtt * ypc);
                  const rushTDrate = (prior.carries || 0) > 0 ? (prior.rushing_tds || 0) / prior.carries : 0.035;
                  const rushTD = Math.max(0, Math.round(rushAtt * rushTDrate));
                  const tgt = Math.round((prior.targets || 0) / pg * games * af * vm);
                  const catchRate = (prior.targets || 0) > 0 ? (prior.receptions || 0) / prior.targets : 0.75;
                  const rec = Math.round(tgt * catchRate);
                  const ypr = (prior.receptions || 0) > 0 ? (prior.receiving_yards || 0) / prior.receptions : 7.5;
                  const recYds = Math.round(rec * ypr);
                  const recTDrate = (prior.targets || 0) > 0 ? (prior.receiving_tds || 0) / prior.targets : 0.02;
                  const recTD = Math.max(0, Math.round(tgt * recTDrate));
                  const pts = computePPR({ rushYds, rushTD, rec, recYds, recTD });
                  rbs.push({ name: playerName, team, adp: 999, games: Math.round(games), rushAtt, rushYds, rushTD, tgt, rec, recYds, recTD, pprPts: Math.round(pts) });
                } else {
                  const pts = computePPR({ rushYds: 150, rushTD: 1, rec: 8, recYds: 50, recTD: 0 });
                  rbs.push({ name: playerName, team, adp: 999, games: 12, rushAtt: 40, rushYds: 150, rushTD: 1, tgt: 12, rec: 8, recYds: 50, recTD: 0, pprPts: Math.round(pts) });
                }
              } else if (pos === 'WR') {
                if (prior && prior.games >= 3) {
                  const pg = prior.games;
                  const games = projectGames(prior);
                  const af = ageFactor(normalizeName(playerName), 'WR');
                  const tgt = Math.round((prior.targets || 0) / pg * games * af * vm);
                  const catchRate = (prior.targets || 0) > 0 ? (prior.receptions || 0) / prior.targets : 0.65;
                  const rec = Math.round(tgt * catchRate);
                  const ypr = (prior.receptions || 0) > 0 ? (prior.receiving_yards || 0) / prior.receptions : 12.5;
                  const recYds = Math.round(rec * ypr);
                  const recTDrate = (prior.targets || 0) > 0 ? (prior.receiving_tds || 0) / prior.targets : 0.06;
                  const recTD = Math.max(0, Math.round(tgt * recTDrate));
                  const rushAtt = Math.round((prior.carries || 0) / pg * games * af * vm);
                  const rushYpc = (prior.carries || 0) > 0 ? (prior.rushing_yards || 0) / prior.carries : 5.0;
                  const rushYds = Math.round(rushAtt * rushYpc);
                  const rushTDrate = (prior.carries || 0) > 0 ? (prior.rushing_tds || 0) / Math.max(prior.carries, 1) : 0;
                  const rushTD = Math.max(0, Math.round(rushAtt * rushTDrate));
                  const pts = computePPR({ rushYds, rushTD, rec, recYds, recTD });
                  wrs.push({ name: playerName, team, adp: 999, games: Math.round(games), tgt, rec, recYds, recTD, rushAtt, rushYds, rushTD, pprPts: Math.round(pts) });
                } else {
                  const pts = computePPR({ rec: 10, recYds: 120, recTD: 0, rushYds: 0, rushTD: 0 });
                  wrs.push({ name: playerName, team, adp: 999, games: 14, tgt: 18, rec: 10, recYds: 120, recTD: 0, rushAtt: 0, rushYds: 0, rushTD: 0, pprPts: Math.round(pts) });
                }
              } else {
                if (prior && prior.games >= 3) {
                  const pg = prior.games;
                  const games = projectGames(prior);
                  const af = ageFactor(normalizeName(playerName), 'TE');
                  const tgt = Math.round((prior.targets || 0) / pg * games * af * vm);
                  const catchRate = (prior.targets || 0) > 0 ? (prior.receptions || 0) / prior.targets : 0.68;
                  const rec = Math.round(tgt * catchRate);
                  const ypr = (prior.receptions || 0) > 0 ? (prior.receiving_yards || 0) / prior.receptions : 11.0;
                  const recYds = Math.round(rec * ypr);
                  const recTDrate = (prior.targets || 0) > 0 ? (prior.receiving_tds || 0) / prior.targets : 0.05;
                  const recTD = Math.max(0, Math.round(tgt * recTDrate));
                  const pts = computePPR({ rec, recYds, recTD });
                  tes.push({ name: playerName, team, adp: 999, games: Math.round(games), tgt, rec, recYds, recTD, pprPts: Math.round(pts) });
                } else {
                  const pts = computePPR({ rec: 8, recYds: 80, recTD: 0 });
                  tes.push({ name: playerName, team, adp: 999, games: 14, tgt: 14, rec: 8, recYds: 80, recTD: 0, pprPts: Math.round(pts) });
                }
              }
            }
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
          setOddsSource(usingLiveOdds ? 'live' : 'historical');
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

  const fmtADP = (adp: number) => adp >= 500 ? '—' : adp.toFixed(1);

  const currentData = useMemo(() => {
    if (selectedPos === 'QB') return qbProjections;
    if (selectedPos === 'RB') return rbProjections;
    if (selectedPos === 'WR') return wrProjections;
    return teProjections;
  }, [selectedPos, qbProjections, rbProjections, wrProjections, teProjections]);

  const teamGroups = useMemo(() => {
    const byTeam = new Map<string, TeamGroup>();
    function ensure(team: string): TeamGroup {
      if (!byTeam.has(team)) byTeam.set(team, { team, totalPPR: 0, qbs: [], rbs: [], wrs: [], tes: [] });
      return byTeam.get(team)!;
    }
    for (const p of qbProjections) { if (p.team) ensure(p.team).qbs.push(p); }
    for (const p of rbProjections) { if (p.team) ensure(p.team).rbs.push(p); }
    for (const p of wrProjections) { if (p.team) ensure(p.team).wrs.push(p); }
    for (const p of teProjections) { if (p.team) ensure(p.team).tes.push(p); }
    for (const g of byTeam.values()) {
      g.qbs = g.qbs.sort((a, b) => b.pprPts - a.pprPts).slice(0, TEAM_POS_LIMITS.QB);
      g.rbs = g.rbs.sort((a, b) => b.pprPts - a.pprPts).slice(0, TEAM_POS_LIMITS.RB);
      g.wrs = g.wrs.sort((a, b) => b.pprPts - a.pprPts).slice(0, TEAM_POS_LIMITS.WR);
      g.tes = g.tes.sort((a, b) => b.pprPts - a.pprPts).slice(0, TEAM_POS_LIMITS.TE);
      g.totalPPR = [...g.qbs, ...g.rbs, ...g.wrs, ...g.tes].reduce((s, p) => s + p.pprPts, 0);
    }
    return [...byTeam.values()].sort((a, b) => b.totalPPR - a.totalPPR);
  }, [qbProjections, rbProjections, wrProjections, teProjections]);

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
        {PREDICT_SEASON} season stat projections based on {PREDICT_SEASON - 1} per-game rates, projected games, age regression,
        and Vegas implied team totals{oddsSource === 'live' ? ' (live odds)' : ''}. Sorted by projected PPR fantasy points.
      </p>

      {/* View mode + Position tabs */}
      <div className="controls" style={{ marginBottom: 16, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div className="control-group">
          <label className="control-label">View</label>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              className={`pos-filter ${viewMode === 'position' ? 'active' : ''}`}
              onClick={() => setViewMode('position')}
              style={{ borderColor: 'var(--text-muted)' }}
            >
              By Position
            </button>
            <button
              className={`pos-filter ${viewMode === 'team' ? 'active' : ''}`}
              onClick={() => setViewMode('team')}
              style={{ borderColor: 'var(--text-muted)' }}
            >
              By Team
            </button>
          </div>
        </div>
        {viewMode === 'position' && (
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
        )}
      </div>

      {/* Team view */}
      {viewMode === 'team' && (
        <div style={{ marginBottom: 20 }}>
          <p style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 12 }}>
            Top {TEAM_POS_LIMITS.QB} QBs, {TEAM_POS_LIMITS.RB} RBs, {TEAM_POS_LIMITS.WR} WRs, {TEAM_POS_LIMITS.TE} TEs per team — sorted by combined PPR
          </p>
          {teamGroups.map((g, ti) => (
            <div key={g.team} style={{
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '12px 16px', marginBottom: 12,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 16, fontWeight: 700 }}>
                  <span style={{ color: 'var(--text-muted)', marginRight: 8 }}>#{ti + 1}</span>
                  {g.team}
                </span>
                <span style={{ fontSize: 14, fontWeight: 700, color: '#f59e0b' }}>
                  {g.totalPPR.toLocaleString()} PPR
                </span>
              </div>
              <div className="table-container" style={{ maxHeight: 'none' }}>
                <table style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={{ width: 40 }}>Pos</th>
                      <th>Player</th>
                      <th>ADP</th>
                      <th>Gm</th>
                      <th>Key Stats</th>
                      <th style={{ borderBottom: '2px solid #f59e0b' }}>PPR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.qbs.map((p) => (
                      <tr key={p.name}>
                        <td style={{ color: POS_COLORS.QB, fontWeight: 700 }}>QB</td>
                        <td><strong>{p.name}</strong></td>
                        <td>{fmtADP(p.adp)}</td>
                        <td>{p.games}</td>
                        <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                          {p.passYds.toLocaleString()} yds, {p.passTD} TD, {p.int} INT | {p.rushYds} rush
                        </td>
                        <td style={{ fontWeight: 700, color: POS_COLORS.QB }}>{p.pprPts}</td>
                      </tr>
                    ))}
                    {g.rbs.map((p) => (
                      <tr key={p.name}>
                        <td style={{ color: POS_COLORS.RB, fontWeight: 700 }}>RB</td>
                        <td><strong>{p.name}</strong></td>
                        <td>{fmtADP(p.adp)}</td>
                        <td>{p.games}</td>
                        <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                          {p.rushYds.toLocaleString()} rush, {p.rushTD} TD | {p.rec} rec, {p.recYds} yds
                        </td>
                        <td style={{ fontWeight: 700, color: POS_COLORS.RB }}>{p.pprPts}</td>
                      </tr>
                    ))}
                    {g.wrs.map((p) => (
                      <tr key={p.name}>
                        <td style={{ color: POS_COLORS.WR, fontWeight: 700 }}>WR</td>
                        <td><strong>{p.name}</strong></td>
                        <td>{fmtADP(p.adp)}</td>
                        <td>{p.games}</td>
                        <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                          {p.tgt} tgt, {p.rec} rec, {p.recYds.toLocaleString()} yds, {p.recTD} TD
                        </td>
                        <td style={{ fontWeight: 700, color: POS_COLORS.WR }}>{p.pprPts}</td>
                      </tr>
                    ))}
                    {g.tes.map((p) => (
                      <tr key={p.name}>
                        <td style={{ color: POS_COLORS.TE, fontWeight: 700 }}>TE</td>
                        <td><strong>{p.name}</strong></td>
                        <td>{fmtADP(p.adp)}</td>
                        <td>{p.games}</td>
                        <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                          {p.tgt} tgt, {p.rec} rec, {p.recYds.toLocaleString()} yds, {p.recTD} TD
                        </td>
                        <td style={{ fontWeight: 700, color: POS_COLORS.TE }}>{p.pprPts}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Summary cards */}
      {viewMode === 'position' && <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
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
      </div>}

      {/* Projection table */}
      {viewMode === 'position' && <>
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
                <td>{fmtADP(p.adp)}</td>
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
                <td>{fmtADP(p.adp)}</td>
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
                <td>{fmtADP(p.adp)}</td>
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
                <td>{fmtADP(p.adp)}</td>
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
      </>}
    </>
  );
}
