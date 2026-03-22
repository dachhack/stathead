import { useState, useEffect, useMemo, useRef } from 'react';
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

// ── Scenario types ──

interface ScenarioSettings {
  // Team-level multipliers: team → multiplier (1.0 = baseline, 1.10 = +10%)
  teamPassAdj: Record<string, number>;   // multiplier on team pass attempts
  teamRushAdj: Record<string, number>;   // multiplier on team rush attempts
  // Player-level overrides: normalized name → overrides
  playerAdj: Record<string, { games?: number; targets?: number; carries?: number }>;
}

function defaultScenario(): ScenarioSettings {
  return { teamPassAdj: {}, teamRushAdj: {}, playerAdj: {} };
}

// Raw data loaded once from APIs, stored in ref
interface LoadedData {
  adpData: FfcADPPlayer[];
  priorTotals: SeasonTotals[];
  priorByName: Map<string, SeasonTotals>;
  rosterTeam: Map<string, string>;
  rosters: Roster[];
  draftByName: Map<string, DraftPick>;
  gamesData: Game[];
  priorTeamTotals: Map<string, TeamStats>;
  leagueAvg: TeamStats;
  allTeams: Set<string>;
  coachChangedTeams: Set<string>;
  coachOriginTeam: Map<string, string>;
}

interface TeamStats {
  passAtt: number; passComp: number; passYds: number; passTD: number; int: number;
  rushAtt: number; rushYds: number; rushTD: number;
  targets: number; receptions: number; recYds: number; recTD: number;
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
  const [, setOddsSource] = useState<'live' | 'historical' | ''>('');
  // Scenario scaffolding (wired up in next iteration)
  const [_scenario, _setScenario] = useState<ScenarioSettings>(defaultScenario);
  const [_scenarioOpen, _setScenarioOpen] = useState(false);
  const _loadedRef = useRef<LoadedData | null>(null);
  const [_loadedVersion, _setLoadedVersion] = useState(0);
  void _scenario; void _setScenario; void _scenarioOpen; void _setScenarioOpen;
  void _loadedRef; void _loadedVersion; void _setLoadedVersion;

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

        // ── Step 1: Prior season player totals ──
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

        // Vegas implied totals (kept for future sweeps that may re-enable it)
        const oddsTeamImplied = oddsLines.length > 0 ? aggregateOddsToTeamImplied(oddsLines) : [];
        const usingLiveOdds = oddsTeamImplied.length > 0;

        // Draft data for age/experience
        const draftByName = new Map<string, DraftPick>();
        for (const d of draftData) draftByName.set(normalizeName(d.pfr_player_name), d);

        // Age-based regression factor
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

        // Projected games: regress toward 16
        function projectGames(prior: SeasonTotals | undefined): number {
          if (!prior) return 14;
          return Math.min(17, Math.round((prior.games * 0.6 + 16 * 0.4) * 10) / 10);
        }

        // ── Step 2: Aggregate prior-season TEAM totals ──
        interface TeamStats {
          passAtt: number; passComp: number; passYds: number; passTD: number; int: number;
          rushAtt: number; rushYds: number; rushTD: number;
          targets: number; receptions: number; recYds: number; recTD: number;
        }
        const priorTeamTotals = new Map<string, TeamStats>();
        for (const p of priorTotals) {
          if (!p.recent_team || !['QB', 'RB', 'WR', 'TE'].includes(p.position)) continue;
          if (!priorTeamTotals.has(p.recent_team)) {
            priorTeamTotals.set(p.recent_team, {
              passAtt: 0, passComp: 0, passYds: 0, passTD: 0, int: 0,
              rushAtt: 0, rushYds: 0, rushTD: 0,
              targets: 0, receptions: 0, recYds: 0, recTD: 0,
            });
          }
          const t = priorTeamTotals.get(p.recent_team)!;
          t.passAtt += p.attempts || 0;
          t.passComp += p.completions || 0;
          t.passYds += p.passing_yards || 0;
          t.passTD += p.passing_tds || 0;
          t.int += p.interceptions || 0;
          t.rushAtt += p.carries || 0;
          t.rushYds += p.rushing_yards || 0;
          t.rushTD += p.rushing_tds || 0;
          t.targets += p.targets || 0;
          t.receptions += p.receptions || 0;
          t.recYds += p.receiving_yards || 0;
          t.recTD += p.receiving_tds || 0;
        }

        // League average team totals
        const leagueAvg: TeamStats = {
          passAtt: 0, passComp: 0, passYds: 0, passTD: 0, int: 0,
          rushAtt: 0, rushYds: 0, rushTD: 0,
          targets: 0, receptions: 0, recYds: 0, recTD: 0,
        };
        const nTeams = priorTeamTotals.size || 1;
        for (const t of priorTeamTotals.values()) {
          for (const k of Object.keys(leagueAvg) as (keyof TeamStats)[]) leagueAvg[k] += t[k];
        }
        for (const k of Object.keys(leagueAvg) as (keyof TeamStats)[]) leagueAvg[k] = Math.round(leagueAvg[k] / nTeams);

        // ── Step 3: Project team totals using sweep config ──
        const { teamWeight } = projectionConfig.winner;
        const leagueWeight = 1 - teamWeight;

        const projectedTeamTotals = new Map<string, TeamStats>();
        for (const [team, prior] of priorTeamTotals) {
          const proj: TeamStats = {} as TeamStats;
          for (const k of Object.keys(leagueAvg) as (keyof TeamStats)[]) {
            proj[k] = Math.round(prior[k] * teamWeight + leagueAvg[k] * leagueWeight);
          }
          projectedTeamTotals.set(team, proj);
        }

        // ── Step 3b: Compute per-team position pool shares from prior season ──
        // Instead of hardcoded "RBs get 88% of rush att", compute actual shares
        interface PosPoolShares {
          qbPassAtt: number; qbRushAtt: number; qbRushTD: number;
          rbRushAtt: number; rbRushTD: number; rbTgt: number; rbRecTD: number;
          wrTgt: number; wrRecTD: number; wrRushAtt: number; wrRushTD: number;
          teTgt: number; teRecTD: number;
        }

        // Compute actual shares from prior-season player stats grouped by team+position
        function computePoolShares(team: string): PosPoolShares {
          const teamPlayers = priorTotals.filter(
            (p) => p.recent_team === team && ['QB', 'RB', 'WR', 'TE'].includes(p.position)
          );
          const teamRushAtt = teamPlayers.reduce((s, p) => s + (p.carries || 0), 0) || 1;
          const teamRushTD = teamPlayers.reduce((s, p) => s + (p.rushing_tds || 0), 0) || 1;
          const teamTgt = teamPlayers.reduce((s, p) => s + (p.targets || 0), 0) || 1;
          const teamRecTD = teamPlayers.reduce((s, p) => s + (p.receiving_tds || 0), 0) || 1;
          const teamPassAtt = teamPlayers.reduce((s, p) => s + (p.attempts || 0), 0) || 1;

          const byPos = (pos: string) => teamPlayers.filter((p) => p.position === pos);

          const qbs = byPos('QB');
          const rbPlayers = byPos('RB');
          const wrPlayers = byPos('WR');
          const tePlayers = byPos('TE');

          return {
            qbPassAtt: qbs.reduce((s, p) => s + (p.attempts || 0), 0) / teamPassAtt,
            qbRushAtt: qbs.reduce((s, p) => s + (p.carries || 0), 0) / teamRushAtt,
            qbRushTD: qbs.reduce((s, p) => s + (p.rushing_tds || 0), 0) / teamRushTD,
            rbRushAtt: rbPlayers.reduce((s, p) => s + (p.carries || 0), 0) / teamRushAtt,
            rbRushTD: rbPlayers.reduce((s, p) => s + (p.rushing_tds || 0), 0) / teamRushTD,
            rbTgt: rbPlayers.reduce((s, p) => s + (p.targets || 0), 0) / teamTgt,
            rbRecTD: rbPlayers.reduce((s, p) => s + (p.receiving_tds || 0), 0) / teamRecTD,
            wrTgt: wrPlayers.reduce((s, p) => s + (p.targets || 0), 0) / teamTgt,
            wrRecTD: wrPlayers.reduce((s, p) => s + (p.receiving_tds || 0), 0) / teamRecTD,
            wrRushAtt: wrPlayers.reduce((s, p) => s + (p.carries || 0), 0) / teamRushAtt,
            wrRushTD: wrPlayers.reduce((s, p) => s + (p.rushing_tds || 0), 0) / teamRushTD,
            teTgt: tePlayers.reduce((s, p) => s + (p.targets || 0), 0) / teamTgt,
            teRecTD: tePlayers.reduce((s, p) => s + (p.receiving_tds || 0), 0) / teamRecTD,
          };
        }

        // League-average position pool shares (fallback / regression target)
        const leaguePoolShares: PosPoolShares = {
          qbPassAtt: 0, qbRushAtt: 0, qbRushTD: 0,
          rbRushAtt: 0, rbRushTD: 0, rbTgt: 0, rbRecTD: 0,
          wrTgt: 0, wrRecTD: 0, wrRushAtt: 0, wrRushTD: 0,
          teTgt: 0, teRecTD: 0,
        };
        const teamsWithShares: PosPoolShares[] = [];
        for (const team of priorTeamTotals.keys()) {
          const shares = computePoolShares(team);
          teamsWithShares.push(shares);
        }
        if (teamsWithShares.length > 0) {
          for (const k of Object.keys(leaguePoolShares) as (keyof PosPoolShares)[]) {
            leaguePoolShares[k] = teamsWithShares.reduce((s, t) => s + t[k], 0) / teamsWithShares.length;
          }
        }

        // ── Step 3c: Detect coaching changes & carry over coach tendencies ──
        // Build team ↔ coach maps for prior and current seasons
        const priorSeasonGames = gamesData.filter(
          (g) => g.season === PREDICT_SEASON - 1 && g.game_type === 'REG'
        );
        const currentSeasonGames = gamesData.filter(
          (g) => g.season === PREDICT_SEASON && g.game_type === 'REG'
        );
        const priorCoach = new Map<string, string>(); // team → coach last season
        const coachPriorTeam = new Map<string, string>(); // coach → team last season
        for (const g of priorSeasonGames) {
          if (g.home_coach) {
            priorCoach.set(g.home_team, g.home_coach);
            coachPriorTeam.set(g.home_coach, g.home_team);
          }
          if (g.away_coach) {
            priorCoach.set(g.away_team, g.away_coach);
            coachPriorTeam.set(g.away_coach, g.away_team);
          }
        }
        const currentCoach = new Map<string, string>(); // team → coach this season
        for (const g of currentSeasonGames) {
          if (g.home_coach) currentCoach.set(g.home_team, g.home_coach);
          if (g.away_coach) currentCoach.set(g.away_team, g.away_coach);
        }

        // Identify coaching changes and where the new coach came from
        // coachOriginTeam: for teams with new HC, the team that coach ran last year
        const coachChangedTeams = new Set<string>();
        const coachOriginTeam = new Map<string, string>(); // new team → coach's old team
        for (const [team, coach] of currentCoach) {
          const prev = priorCoach.get(team);
          if (prev && prev !== coach) {
            coachChangedTeams.add(team);
            // Where did this coach come from?
            const origin = coachPriorTeam.get(coach);
            if (origin && origin !== team) {
              coachOriginTeam.set(team, origin);
            }
          }
        }

        // Blend pool shares:
        // Same coach:  75% team + 25% league
        // New coach (promoted/first-time): 35% team + 65% league
        // New coach from another team: 30% team + 40% coach's old team + 30% league
        function getTeamPools(team: string): PosPoolShares {
          const teamShares = computePoolShares(team);

          if (!coachChangedTeams.has(team)) {
            // Same coach — mostly preserve team tendencies
            const blended: PosPoolShares = {} as PosPoolShares;
            for (const k of Object.keys(leaguePoolShares) as (keyof PosPoolShares)[]) {
              blended[k] = teamShares[k] * 0.75 + leaguePoolShares[k] * 0.25;
            }
            return blended;
          }

          const origin = coachOriginTeam.get(team);
          if (origin) {
            // New coach from another team — blend in his old team's tendencies
            const coachShares = computePoolShares(origin);
            const blended: PosPoolShares = {} as PosPoolShares;
            for (const k of Object.keys(leaguePoolShares) as (keyof PosPoolShares)[]) {
              blended[k] = teamShares[k] * 0.30 + coachShares[k] * 0.40 + leaguePoolShares[k] * 0.30;
            }
            return blended;
          }

          // New coach but no prior HC record (promoted coordinator / first-time HC)
          const blended: PosPoolShares = {} as PosPoolShares;
          for (const k of Object.keys(leaguePoolShares) as (keyof PosPoolShares)[]) {
            blended[k] = teamShares[k] * 0.35 + leaguePoolShares[k] * 0.65;
          }
          return blended;
        }

        // ── Step 4: Build player roster for each team ──
        // Collect all players we'll project: ADP players + roster fill-ins
        interface PlayerCandidate {
          name: string; team: string; position: Position; adp: number;
          prior: SeasonTotals | undefined;
        }

        const candidatesByTeamPos = new Map<string, PlayerCandidate[]>();
        function tpKey(team: string, pos: string) { return `${team}:${pos}`; }
        function ensureList(key: string) {
          if (!candidatesByTeamPos.has(key)) candidatesByTeamPos.set(key, []);
          return candidatesByTeamPos.get(key)!;
        }

        const addedNames = new Set<string>();

        // First pass: ADP players (have draft capital / expected starters)
        for (const adp of adpData) {
          if (!POSITIONS.includes(adp.position as Position)) continue;
          if (adp.adp > 250) continue;
          const nn = normalizeName(adp.name);
          const team = rosterTeam.get(nn) || adp.team || '';
          if (!team) continue;
          const prior = priorByName.get(nn);
          ensureList(tpKey(team, adp.position)).push({
            name: adp.name, team, position: adp.position as Position,
            adp: adp.adp, prior,
          });
          addedNames.add(nn);
        }

        // Second pass: rostered players not in ADP
        for (const r of rosters) {
          if (!POSITIONS.includes(r.position as Position)) continue;
          const nn = normalizeName(r.full_name);
          if (addedNames.has(nn)) continue;
          const prior = priorByName.get(nn);
          ensureList(tpKey(r.team, r.position)).push({
            name: r.full_name, team: r.team, position: r.position as Position,
            adp: 999, prior,
          });
          addedNames.add(nn);
        }

        // Third pass: prior-season players not yet captured
        for (const p of priorTotals) {
          if (!POSITIONS.includes(p.position as Position)) continue;
          const nn = normalizeName(p.player_display_name);
          if (addedNames.has(nn)) continue;
          const team = rosterTeam.get(nn) || p.recent_team || '';
          if (!team) continue;
          ensureList(tpKey(team, p.position)).push({
            name: p.player_display_name, team, position: p.position as Position,
            adp: 999, prior: p,
          });
          addedNames.add(nn);
        }

        // Sort each team+pos group: by ADP (lower = better), then by prior PPR
        for (const [, list] of candidatesByTeamPos) {
          list.sort((a, b) => {
            if (a.adp !== b.adp) return a.adp - b.adp;
            const aPPR = a.prior ? (a.prior.fantasy_points_ppr || 0) : 0;
            const bPPR = b.prior ? (b.prior.fantasy_points_ppr || 0) : 0;
            return bPPR - aPPR;
          });
        }

        // ── Step 5: Compute shares & split the team pie ──
        const qbs: QBProjection[] = [];
        const rbs: RBProjection[] = [];
        const wrs: WRProjection[] = [];
        const tes: TEProjection[] = [];

        const allTeams = new Set<string>();
        for (const r of rosters) { if (r.team && POSITIONS.includes(r.position as Position)) allTeams.add(r.team); }
        for (const [team] of priorTeamTotals) allTeams.add(team);

        for (const team of allTeams) {
          const projTeam = projectedTeamTotals.get(team);
          if (!projTeam) continue;

          // Per-team position pool shares (computed from prior season + coach regression)
          const pools = getTeamPools(team);

          for (const pos of POSITIONS) {
            const players = (candidatesByTeamPos.get(tpKey(team, pos)) || []).slice(0, TEAM_POS_LIMITS[pos]);

            if (pos === 'QB') {
              const priorPassAttTotal = players.reduce((s, p) => s + (p.prior?.attempts || 0), 0);
              const priorRushAttTotal = players.reduce((s, p) => s + (p.prior?.carries || 0), 0);
              const qbPassPool = projTeam.passAtt * pools.qbPassAtt;
              const qbRushPool = projTeam.rushAtt * pools.qbRushAtt;
              const qbRushTDPool = projTeam.rushTD * pools.qbRushTD;

              for (const player of players) {
                const prior = player.prior;
                const games = projectGames(prior);
                const af = ageFactor(normalizeName(player.name), 'QB');

                let passAtt: number, passComp: number, passYds: number, passTD: number, ints: number;
                let rushAtt: number, rushYds: number, rushTD: number;

                if (prior && prior.games >= 3) {
                  const passShare = priorPassAttTotal > 0 ? (prior.attempts || 0) / priorPassAttTotal : 1 / players.length;
                  passAtt = Math.round(qbPassPool * passShare * af);
                  const compRate = (prior.attempts || 0) > 0 ? (prior.completions || 0) / prior.attempts : 0.63;
                  passComp = Math.round(passAtt * compRate);
                  const ypa = (prior.attempts || 0) > 0 ? (prior.passing_yards || 0) / prior.attempts : 7.0;
                  passYds = Math.round(passAtt * ypa);
                  const tdRate = (prior.attempts || 0) > 0 ? (prior.passing_tds || 0) / prior.attempts : 0.04;
                  passTD = Math.round(passAtt * tdRate);
                  const intRate = (prior.attempts || 0) > 0 ? (prior.interceptions || 0) / prior.attempts : 0.025;
                  ints = Math.round(passAtt * intRate);

                  const rushShare = priorRushAttTotal > 0 ? (prior.carries || 0) / priorRushAttTotal : 0.5 / players.length;
                  rushAtt = Math.round(qbRushPool * rushShare * af);
                  const ypc = (prior.carries || 0) > 0 ? (prior.rushing_yards || 0) / prior.carries : 4.0;
                  rushYds = Math.round(rushAtt * ypc);
                  rushTD = Math.round(qbRushTDPool * rushShare * af);
                } else {
                  const share = 1 / (players.length * 3);
                  passAtt = Math.round(qbPassPool * share);
                  passComp = Math.round(passAtt * 0.60);
                  passYds = Math.round(passAtt * 6.5);
                  passTD = Math.round(passAtt * 0.035);
                  ints = Math.round(passAtt * 0.03);
                  rushAtt = Math.round(qbRushPool * share * 0.3);
                  rushYds = Math.round(rushAtt * 3.5);
                  rushTD = 0;
                }

                const pts = computePPR({ passYds, passTD, int: ints, rushYds, rushTD });
                qbs.push({
                  name: player.name, team, adp: player.adp, games: Math.round(games),
                  passAtt, passComp, passYds, passTD, int: ints,
                  rushAtt, rushYds, rushTD, pprPts: Math.round(pts),
                });
              }
            } else if (pos === 'RB') {
              const priorRushTotal = players.reduce((s, p) => s + (p.prior?.carries || 0), 0);
              const priorTgtTotal = players.reduce((s, p) => s + (p.prior?.targets || 0), 0);
              const rbRushPool = projTeam.rushAtt * pools.rbRushAtt;
              const rbTgtPool = projTeam.targets * pools.rbTgt;
              const rbRushTDPool = projTeam.rushTD * pools.rbRushTD;
              const rbRecTDPool = projTeam.recTD * pools.rbRecTD;

              for (const player of players) {
                const prior = player.prior;
                const games = projectGames(prior);
                const af = ageFactor(normalizeName(player.name), 'RB');

                let rushAtt: number, rushYds: number, rushTD: number;
                let tgt: number, rec: number, recYds: number, recTD: number;

                if (prior && prior.games >= 3) {
                  const rushShare = priorRushTotal > 0 ? (prior.carries || 0) / priorRushTotal : 1 / players.length;
                  rushAtt = Math.round(rbRushPool * rushShare * af);
                  const ypc = (prior.carries || 0) > 0 ? (prior.rushing_yards || 0) / prior.carries : 4.0;
                  rushYds = Math.round(rushAtt * ypc);
                  rushTD = Math.max(0, Math.round(rbRushTDPool * rushShare * af));

                  const tgtShare = priorTgtTotal > 0 ? (prior.targets || 0) / priorTgtTotal : 1 / players.length;
                  tgt = Math.round(rbTgtPool * tgtShare * af);
                  const catchRate = (prior.targets || 0) > 0 ? (prior.receptions || 0) / prior.targets : 0.75;
                  rec = Math.round(tgt * catchRate);
                  const ypr = (prior.receptions || 0) > 0 ? (prior.receiving_yards || 0) / prior.receptions : 7.5;
                  recYds = Math.round(rec * ypr);
                  recTD = Math.max(0, Math.round(rbRecTDPool * tgtShare * af));
                } else {
                  const share = 1 / (players.length * 4);
                  rushAtt = Math.round(rbRushPool * share);
                  rushYds = Math.round(rushAtt * 3.8);
                  rushTD = Math.max(0, Math.round(rbRushTDPool * share));
                  tgt = Math.round(rbTgtPool * share);
                  rec = Math.round(tgt * 0.72);
                  recYds = Math.round(rec * 6.5);
                  recTD = 0;
                }

                const pts = computePPR({ rushYds, rushTD, rec, recYds, recTD });
                rbs.push({
                  name: player.name, team, adp: player.adp, games: Math.round(games),
                  rushAtt, rushYds, rushTD, tgt, rec, recYds, recTD, pprPts: Math.round(pts),
                });
              }
            } else if (pos === 'WR') {
              const priorTgtTotal = players.reduce((s, p) => s + (p.prior?.targets || 0), 0);
              const priorRushTotal = players.reduce((s, p) => s + (p.prior?.carries || 0), 0);
              const wrTgtPool = projTeam.targets * pools.wrTgt;
              const wrRushPool = projTeam.rushAtt * pools.wrRushAtt;
              const wrRecTDPool = projTeam.recTD * pools.wrRecTD;
              const wrRushTDPool = projTeam.rushTD * pools.wrRushTD;

              for (const player of players) {
                const prior = player.prior;
                const games = projectGames(prior);
                const af = ageFactor(normalizeName(player.name), 'WR');

                let tgt: number, rec: number, recYds: number, recTD: number;
                let rushAtt: number, rushYds: number, rushTD: number;

                if (prior && prior.games >= 3) {
                  const tgtShare = priorTgtTotal > 0 ? (prior.targets || 0) / priorTgtTotal : 1 / players.length;
                  tgt = Math.round(wrTgtPool * tgtShare * af);
                  const catchRate = (prior.targets || 0) > 0 ? (prior.receptions || 0) / prior.targets : 0.65;
                  rec = Math.round(tgt * catchRate);
                  const ypr = (prior.receptions || 0) > 0 ? (prior.receiving_yards || 0) / prior.receptions : 12.5;
                  recYds = Math.round(rec * ypr);
                  recTD = Math.max(0, Math.round(wrRecTDPool * tgtShare * af));

                  const rushShare = priorRushTotal > 0 ? (prior.carries || 0) / priorRushTotal : 0;
                  rushAtt = Math.round(wrRushPool * rushShare * af);
                  const ypc = (prior.carries || 0) > 0 ? (prior.rushing_yards || 0) / prior.carries : 5.0;
                  rushYds = Math.round(rushAtt * ypc);
                  rushTD = Math.max(0, Math.round(wrRushTDPool * rushShare * af));
                } else {
                  const share = 1 / (players.length * 4);
                  tgt = Math.round(wrTgtPool * share);
                  rec = Math.round(tgt * 0.62);
                  recYds = Math.round(rec * 11.0);
                  recTD = 0;
                  rushAtt = 0; rushYds = 0; rushTD = 0;
                }

                const pts = computePPR({ rushYds, rushTD, rec, recYds, recTD });
                wrs.push({
                  name: player.name, team, adp: player.adp, games: Math.round(games),
                  tgt, rec, recYds, recTD, rushAtt, rushYds, rushTD, pprPts: Math.round(pts),
                });
              }
            } else if (pos === 'TE') {
              const priorTgtTotal = players.reduce((s, p) => s + (p.prior?.targets || 0), 0);
              const teTgtPool = projTeam.targets * pools.teTgt;
              const teRecTDPool = projTeam.recTD * pools.teRecTD;

              for (const player of players) {
                const prior = player.prior;
                const games = projectGames(prior);
                const af = ageFactor(normalizeName(player.name), 'TE');

                let tgt: number, rec: number, recYds: number, recTD: number;

                if (prior && prior.games >= 3) {
                  const tgtShare = priorTgtTotal > 0 ? (prior.targets || 0) / priorTgtTotal : 1 / players.length;
                  tgt = Math.round(teTgtPool * tgtShare * af);
                  const catchRate = (prior.targets || 0) > 0 ? (prior.receptions || 0) / prior.targets : 0.68;
                  rec = Math.round(tgt * catchRate);
                  const ypr = (prior.receptions || 0) > 0 ? (prior.receiving_yards || 0) / prior.receptions : 11.0;
                  recYds = Math.round(rec * ypr);
                  recTD = Math.max(0, Math.round(teRecTDPool * tgtShare * af));
                } else {
                  const share = 1 / (players.length * 4);
                  tgt = Math.round(teTgtPool * share);
                  rec = Math.round(tgt * 0.65);
                  recYds = Math.round(rec * 9.5);
                  recTD = 0;
                }

                const pts = computePPR({ rec, recYds, recTD });
                tes.push({
                  name: player.name, team, adp: player.adp, games: Math.round(games),
                  tgt, rec, recYds, recTD, pprPts: Math.round(pts),
                });
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
        {PREDICT_SEASON} projections: team totals projected via {Math.round(projectionConfig.winner.teamWeight * 100)}/{Math.round((1 - projectionConfig.winner.teamWeight) * 100)} team/league blend,
        position pools computed from prior-season tendencies (regressed toward league avg for coaching changes),
        then split by each player's share of team volume. Individual efficiency rates preserved. Sorted by PPR.
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
