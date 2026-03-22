import { useState, useEffect, useMemo } from 'react';
import {
  fetchFfcADP, fetchPlayerStats, aggregateToSeasonTotals,
  fetchDraftPicks, fetchRosters, fetchGames,
  fetchOddsGameLines, aggregateOddsToTeamImplied,
} from '../data';
import type { SeasonTotals, DraftPick, FfcADPPlayer, Roster, Game } from '../types';
import projectionConfig from '../generated/projection-config.json';

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

type ViewMode = 'position' | 'team' | 'teamTotals';

interface TeamTotalRow {
  team: string;
  games: number;
  passAtt: number; passComp: number; passYds: number; passTD: number; int: number;
  rushAtt: number; rushYds: number; rushTD: number;
  tgt: number; rec: number; recYds: number; recTD: number;
  pprPts: number;
}

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
        // Config from build-time sweep (may disable Vegas entirely if sweep found it unhelpful)
        const { useVegas, vegasBlend, vegasCap } = projectionConfig.winner;
        function vegasMultiplier(teamAbbr: string): number {
          if (!useVegas) return 1;
          const t = teamImpliedTotals.get(teamAbbr);
          if (!t || t.count === 0) return 1;
          const teamAvg = t.sum / t.count;
          const blended = teamAvg * vegasBlend + leagueAvgImplied * (1 - vegasBlend);
          return Math.max(1 - vegasCap, Math.min(1 + vegasCap, blended / leagueAvgImplied));
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

  const teamTotals = useMemo((): TeamTotalRow[] => {
    return teamGroups.map((g) => {
      const row: TeamTotalRow = { team: g.team, games: 0, passAtt: 0, passComp: 0, passYds: 0, passTD: 0, int: 0, rushAtt: 0, rushYds: 0, rushTD: 0, tgt: 0, rec: 0, recYds: 0, recTD: 0, pprPts: g.totalPPR };
      for (const p of g.qbs) { row.games += p.games; row.passAtt += p.passAtt; row.passComp += p.passComp; row.passYds += p.passYds; row.passTD += p.passTD; row.int += p.int; row.rushAtt += p.rushAtt; row.rushYds += p.rushYds; row.rushTD += p.rushTD; }
      for (const p of g.rbs) { row.games += p.games; row.rushAtt += p.rushAtt; row.rushYds += p.rushYds; row.rushTD += p.rushTD; row.tgt += p.tgt; row.rec += p.rec; row.recYds += p.recYds; row.recTD += p.recTD; }
      for (const p of g.wrs) { row.games += p.games; row.rushAtt += p.rushAtt; row.rushYds += p.rushYds; row.rushTD += p.rushTD; row.tgt += p.tgt; row.rec += p.rec; row.recYds += p.recYds; row.recTD += p.recTD; }
      for (const p of g.tes) { row.games += p.games; row.tgt += p.tgt; row.rec += p.rec; row.recYds += p.recYds; row.recTD += p.recTD; }
      return row;
    });
  }, [teamGroups]);

  const [teamSortCol, setTeamSortCol] = useState<keyof TeamTotalRow>('pprPts');
  const [teamSortAsc, setTeamSortAsc] = useState(false);

  const sortedTeamTotals = useMemo(() => {
    return [...teamTotals].sort((a, b) => {
      const av = a[teamSortCol]; const bv = b[teamSortCol];
      if (typeof av === 'string' && typeof bv === 'string') return teamSortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      return teamSortAsc ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
  }, [teamTotals, teamSortCol, teamSortAsc]);

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
            <button
              className={`pos-filter ${viewMode === 'teamTotals' ? 'active' : ''}`}
              onClick={() => setViewMode('teamTotals')}
              style={{ borderColor: 'var(--text-muted)' }}
            >
              Team Totals
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
          {teamGroups.map((g, ti) => {
            // Compute position subtotals and team total
            const sumQB = { games: 0, passAtt: 0, passComp: 0, passYds: 0, passTD: 0, int: 0, rushAtt: 0, rushYds: 0, rushTD: 0, tgt: 0, rec: 0, recYds: 0, recTD: 0, ppr: 0 };
            for (const p of g.qbs) { sumQB.games += p.games; sumQB.passAtt += p.passAtt; sumQB.passComp += p.passComp; sumQB.passYds += p.passYds; sumQB.passTD += p.passTD; sumQB.int += p.int; sumQB.rushAtt += p.rushAtt; sumQB.rushYds += p.rushYds; sumQB.rushTD += p.rushTD; sumQB.ppr += p.pprPts; }
            const sumRB = { games: 0, passAtt: 0, passComp: 0, passYds: 0, passTD: 0, int: 0, rushAtt: 0, rushYds: 0, rushTD: 0, tgt: 0, rec: 0, recYds: 0, recTD: 0, ppr: 0 };
            for (const p of g.rbs) { sumRB.games += p.games; sumRB.rushAtt += p.rushAtt; sumRB.rushYds += p.rushYds; sumRB.rushTD += p.rushTD; sumRB.tgt += p.tgt; sumRB.rec += p.rec; sumRB.recYds += p.recYds; sumRB.recTD += p.recTD; sumRB.ppr += p.pprPts; }
            const sumWR = { games: 0, passAtt: 0, passComp: 0, passYds: 0, passTD: 0, int: 0, rushAtt: 0, rushYds: 0, rushTD: 0, tgt: 0, rec: 0, recYds: 0, recTD: 0, ppr: 0 };
            for (const p of g.wrs) { sumWR.games += p.games; sumWR.tgt += p.tgt; sumWR.rec += p.rec; sumWR.recYds += p.recYds; sumWR.recTD += p.recTD; sumWR.rushAtt += p.rushAtt; sumWR.rushYds += p.rushYds; sumWR.rushTD += p.rushTD; sumWR.ppr += p.pprPts; }
            const sumTE = { games: 0, passAtt: 0, passComp: 0, passYds: 0, passTD: 0, int: 0, rushAtt: 0, rushYds: 0, rushTD: 0, tgt: 0, rec: 0, recYds: 0, recTD: 0, ppr: 0 };
            for (const p of g.tes) { sumTE.games += p.games; sumTE.tgt += p.tgt; sumTE.rec += p.rec; sumTE.recYds += p.recYds; sumTE.recTD += p.recTD; sumTE.ppr += p.pprPts; }
            const total = {
              games: sumQB.games + sumRB.games + sumWR.games + sumTE.games,
              passAtt: sumQB.passAtt, passComp: sumQB.passComp, passYds: sumQB.passYds, passTD: sumQB.passTD, int: sumQB.int,
              rushAtt: sumQB.rushAtt + sumRB.rushAtt + sumWR.rushAtt, rushYds: sumQB.rushYds + sumRB.rushYds + sumWR.rushYds, rushTD: sumQB.rushTD + sumRB.rushTD + sumWR.rushTD,
              tgt: sumRB.tgt + sumWR.tgt + sumTE.tgt, rec: sumRB.rec + sumWR.rec + sumTE.rec, recYds: sumRB.recYds + sumWR.recYds + sumTE.recYds, recTD: sumRB.recTD + sumWR.recTD + sumTE.recTD,
              ppr: g.totalPPR,
            };

            const thStyle = { fontSize: 10, padding: '4px 6px', whiteSpace: 'nowrap' as const };
            const tdStyle = { fontSize: 11, padding: '3px 6px' };
            const subtotalStyle = { ...tdStyle, fontWeight: 700 as const, background: 'var(--bg-tertiary)', borderTop: '1px solid var(--border)' };
            const totalStyle = { ...tdStyle, fontWeight: 700 as const, background: 'var(--bg-tertiary)', borderTop: '2px solid var(--text-muted)' };

            function playerRow(pos: string, name: string, gm: number, pAtt: number, pComp: number, pYds: number, pTD: number, pInt: number, rAtt: number, rYds: number, rTD: number, tgt: number, rec: number, recYds: number, recTD: number, ppr: number) {
              return (
                <tr key={name}>
                  <td style={{ ...tdStyle, color: POS_COLORS[pos], fontWeight: 700 }}>{pos}</td>
                  <td style={{ ...tdStyle, minWidth: 130 }}><strong>{name}</strong></td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{gm}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{pAtt || ''}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{pComp || ''}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{pYds ? pYds.toLocaleString() : ''}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: pTD ? 700 : 400 }}>{pTD || ''}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: pInt ? '#ef4444' : undefined }}>{pInt || ''}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{rAtt || ''}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{rYds ? rYds.toLocaleString() : ''}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: rTD ? 700 : 400 }}>{rTD || ''}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{tgt || ''}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{rec || ''}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{recYds ? recYds.toLocaleString() : ''}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: recTD ? 700 : 400 }}>{recTD || ''}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, color: POS_COLORS[pos] }}>{ppr}</td>
                </tr>
              );
            }

            function subtotalRow(label: string, color: string, s: typeof sumQB) {
              return (
                <tr key={label}>
                  <td colSpan={2} style={{ ...subtotalStyle, color }}>{label}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right' }}>{s.games}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right' }}>{s.passAtt || ''}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right' }}>{s.passComp || ''}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right' }}>{s.passYds ? s.passYds.toLocaleString() : ''}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right' }}>{s.passTD || ''}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right' }}>{s.int || ''}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right' }}>{s.rushAtt || ''}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right' }}>{s.rushYds ? s.rushYds.toLocaleString() : ''}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right' }}>{s.rushTD || ''}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right' }}>{s.tgt || ''}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right' }}>{s.rec || ''}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right' }}>{s.recYds ? s.recYds.toLocaleString() : ''}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right' }}>{s.recTD || ''}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right', color }}>{s.ppr}</td>
                </tr>
              );
            }

            return (
            <div key={g.team} style={{
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '12px 16px', marginBottom: 16,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 18, fontWeight: 700 }}>
                  <span style={{ color: 'var(--text-muted)', marginRight: 8 }}>#{ti + 1}</span>
                  {g.team}
                </span>
                <span style={{ fontSize: 14, fontWeight: 700, color: '#f59e0b' }}>
                  {g.totalPPR.toLocaleString()} PPR
                </span>
              </div>
              <div className="table-container" style={{ maxHeight: 'none', overflowX: 'auto' }}>
                <table style={{ fontSize: 11, borderCollapse: 'collapse', width: '100%' }}>
                  <thead>
                    <tr>
                      <th style={thStyle}>Pos</th>
                      <th style={thStyle}>Player</th>
                      <th style={thStyle}>Gm</th>
                      <th colSpan={5} style={{ ...thStyle, textAlign: 'center', borderBottom: `2px solid ${POS_COLORS.QB}` }}>PASSING</th>
                      <th colSpan={3} style={{ ...thStyle, textAlign: 'center', borderBottom: `2px solid ${POS_COLORS.RB}` }}>RUSHING</th>
                      <th colSpan={4} style={{ ...thStyle, textAlign: 'center', borderBottom: `2px solid ${POS_COLORS.WR}` }}>RECEIVING</th>
                      <th style={{ ...thStyle, borderBottom: '2px solid #f59e0b' }}>PPR</th>
                    </tr>
                    <tr>
                      <th style={thStyle}></th>
                      <th style={thStyle}></th>
                      <th style={thStyle}></th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Att</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Cmp</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Yds</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>TD</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>INT</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Att</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Yds</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>TD</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Tgt</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Rec</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Yds</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>TD</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Pts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.qbs.map((p) => playerRow('QB', p.name, p.games, p.passAtt, p.passComp, p.passYds, p.passTD, p.int, p.rushAtt, p.rushYds, p.rushTD, 0, 0, 0, 0, p.pprPts))}
                    {subtotalRow('QB Total', POS_COLORS.QB, sumQB)}
                    {g.rbs.map((p) => playerRow('RB', p.name, p.games, 0, 0, 0, 0, 0, p.rushAtt, p.rushYds, p.rushTD, p.tgt, p.rec, p.recYds, p.recTD, p.pprPts))}
                    {subtotalRow('RB Total', POS_COLORS.RB, sumRB)}
                    {g.wrs.map((p) => playerRow('WR', p.name, p.games, 0, 0, 0, 0, 0, p.rushAtt, p.rushYds, p.rushTD, p.tgt, p.rec, p.recYds, p.recTD, p.pprPts))}
                    {subtotalRow('WR Total', POS_COLORS.WR, sumWR)}
                    {g.tes.map((p) => playerRow('TE', p.name, p.games, 0, 0, 0, 0, 0, 0, 0, 0, p.tgt, p.rec, p.recYds, p.recTD, p.pprPts))}
                    {subtotalRow('TE Total', POS_COLORS.TE, sumTE)}
                    <tr>
                      <td colSpan={2} style={{ ...totalStyle, fontSize: 12 }}>Total</td>
                      <td style={{ ...totalStyle, textAlign: 'right' }}>{total.games}</td>
                      <td style={{ ...totalStyle, textAlign: 'right' }}>{total.passAtt}</td>
                      <td style={{ ...totalStyle, textAlign: 'right' }}>{total.passComp}</td>
                      <td style={{ ...totalStyle, textAlign: 'right' }}>{total.passYds.toLocaleString()}</td>
                      <td style={{ ...totalStyle, textAlign: 'right' }}>{total.passTD}</td>
                      <td style={{ ...totalStyle, textAlign: 'right' }}>{total.int}</td>
                      <td style={{ ...totalStyle, textAlign: 'right' }}>{total.rushAtt}</td>
                      <td style={{ ...totalStyle, textAlign: 'right' }}>{total.rushYds.toLocaleString()}</td>
                      <td style={{ ...totalStyle, textAlign: 'right' }}>{total.rushTD}</td>
                      <td style={{ ...totalStyle, textAlign: 'right' }}>{total.tgt}</td>
                      <td style={{ ...totalStyle, textAlign: 'right' }}>{total.rec}</td>
                      <td style={{ ...totalStyle, textAlign: 'right' }}>{total.recYds.toLocaleString()}</td>
                      <td style={{ ...totalStyle, textAlign: 'right' }}>{total.recTD}</td>
                      <td style={{ ...totalStyle, textAlign: 'right', color: '#f59e0b', fontSize: 12 }}>{total.ppr}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            );
          })}
        </div>
      )}

      {/* Team Totals view */}
      {viewMode === 'teamTotals' && (() => {
        const thS = { fontSize: 10, padding: '4px 8px', cursor: 'pointer' as const, whiteSpace: 'nowrap' as const, userSelect: 'none' as const };
        const tdS = { fontSize: 11, padding: '4px 8px', textAlign: 'right' as const };
        function sortHeader(label: string, col: keyof TeamTotalRow, align: 'left' | 'right' = 'right') {
          const active = teamSortCol === col;
          return (
            <th
              style={{ ...thS, textAlign: align, color: active ? 'var(--text-primary)' : undefined }}
              onClick={() => { if (teamSortCol === col) setTeamSortAsc(!teamSortAsc); else { setTeamSortCol(col); setTeamSortAsc(false); } }}
            >
              {label}{active ? (teamSortAsc ? ' ▲' : ' ▼') : ''}
            </th>
          );
        }
        // League averages for the footer
        const avg: Record<string, number> = {};
        const n = sortedTeamTotals.length || 1;
        for (const key of ['games','passAtt','passComp','passYds','passTD','int','rushAtt','rushYds','rushTD','tgt','rec','recYds','recTD','pprPts'] as (keyof TeamTotalRow)[]) {
          avg[key] = Math.round(sortedTeamTotals.reduce((s, r) => s + (r[key] as number), 0) / n);
        }
        return (
          <div style={{ marginBottom: 20 }}>
            <h4 style={{ marginBottom: 8 }}>
              Team Totals — {PREDICT_SEASON}
              <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>
                {sortedTeamTotals.length} teams · {TEAM_POS_LIMITS.QB} QB, {TEAM_POS_LIMITS.RB} RB, {TEAM_POS_LIMITS.WR} WR, {TEAM_POS_LIMITS.TE} TE per team · click headers to sort
              </span>
            </h4>
            <div className="table-container" style={{ maxHeight: 800, overflowY: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ ...thS, textAlign: 'center' }}>#</th>
                    {sortHeader('Team', 'team', 'left')}
                    {sortHeader('Gm', 'games')}
                    <th colSpan={5} style={{ ...thS, textAlign: 'center', borderBottom: `2px solid ${POS_COLORS.QB}` }}>PASSING</th>
                    <th colSpan={3} style={{ ...thS, textAlign: 'center', borderBottom: `2px solid ${POS_COLORS.RB}` }}>RUSHING</th>
                    <th colSpan={4} style={{ ...thS, textAlign: 'center', borderBottom: `2px solid ${POS_COLORS.WR}` }}>RECEIVING</th>
                    <th style={{ ...thS, borderBottom: '2px solid #f59e0b' }}>PPR</th>
                  </tr>
                  <tr>
                    <th style={thS}></th>
                    <th style={thS}></th>
                    <th style={thS}></th>
                    {sortHeader('Att', 'passAtt')}
                    {sortHeader('Cmp', 'passComp')}
                    {sortHeader('Yds', 'passYds')}
                    {sortHeader('TD', 'passTD')}
                    {sortHeader('INT', 'int')}
                    {sortHeader('Att', 'rushAtt')}
                    {sortHeader('Yds', 'rushYds')}
                    {sortHeader('TD', 'rushTD')}
                    {sortHeader('Tgt', 'tgt')}
                    {sortHeader('Rec', 'rec')}
                    {sortHeader('Yds', 'recYds')}
                    {sortHeader('TD', 'recTD')}
                    {sortHeader('Pts', 'pprPts')}
                  </tr>
                </thead>
                <tbody>
                  {sortedTeamTotals.map((r, i) => (
                    <tr key={r.team} onClick={() => { setViewMode('team'); }} style={{ cursor: 'pointer' }}>
                      <td style={{ ...tdS, textAlign: 'center', color: 'var(--text-muted)' }}>{i + 1}</td>
                      <td style={{ ...tdS, textAlign: 'left', fontWeight: 700 }}>{r.team}</td>
                      <td style={tdS}>{r.games}</td>
                      <td style={tdS}>{r.passAtt.toLocaleString()}</td>
                      <td style={tdS}>{r.passComp.toLocaleString()}</td>
                      <td style={tdS}>{r.passYds.toLocaleString()}</td>
                      <td style={{ ...tdS, fontWeight: 700 }}>{r.passTD}</td>
                      <td style={{ ...tdS, color: '#ef4444' }}>{r.int}</td>
                      <td style={tdS}>{r.rushAtt.toLocaleString()}</td>
                      <td style={tdS}>{r.rushYds.toLocaleString()}</td>
                      <td style={{ ...tdS, fontWeight: 700 }}>{r.rushTD}</td>
                      <td style={tdS}>{r.tgt.toLocaleString()}</td>
                      <td style={tdS}>{r.rec.toLocaleString()}</td>
                      <td style={tdS}>{r.recYds.toLocaleString()}</td>
                      <td style={{ ...tdS, fontWeight: 700 }}>{r.recTD}</td>
                      <td style={{ ...tdS, fontWeight: 700, color: '#f59e0b' }}>{r.pprPts.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: '2px solid var(--text-muted)' }}>
                    <td style={{ ...tdS, textAlign: 'center' }}></td>
                    <td style={{ ...tdS, textAlign: 'left', fontWeight: 700, color: 'var(--text-muted)' }}>Avg</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.games}</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.passAtt?.toLocaleString()}</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.passComp?.toLocaleString()}</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.passYds?.toLocaleString()}</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.passTD}</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.int}</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.rushAtt?.toLocaleString()}</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.rushYds?.toLocaleString()}</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.rushTD}</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.tgt?.toLocaleString()}</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.rec?.toLocaleString()}</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.recYds?.toLocaleString()}</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.recTD}</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.pprPts?.toLocaleString()}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        );
      })()}

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
