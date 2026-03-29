// Build-time precomputable feature matrix.
// Extracted from ADPFactorAnalysis.tsx useEffect pipeline.
// Works in both browser and Node.js (Node 18+ with native fetch).

import {
  fetchFfcADP, fetchPlayerStats, aggregateToSeasonTotals,
  fetchCombine, fetchDraftPicks, fetchSnapCounts, fetchInjuries,
  fetchNextGenStats, fetchPlayByPlay, fetchPbpParticipation,
  fetchRosters, fetchDepthCharts, fetchGames,
  fetchContracts, fetchCollegeStats, fetchCollegeQBR,
} from '../data';
import type { SeasonTotals, CombineResult, DraftPick, PlayerStats, NextGenStats, PlayByPlay, PbpParticipation, Roster, DepthChart, Contract, CollegeStats, CollegeQBR } from '../types';
import { computePlayerProjectionFeatures } from './playerProjection';
import {
  POSITIONS,
  normalizeName, parseHeight,
  type PlayerRow, type PredictionRow, type FeatureMatrixConfig, type FeatureMatrixResult,
} from './featureTypes';

export async function buildFeatureMatrix(config: FeatureMatrixConfig): Promise<FeatureMatrixResult> {
  const { seasons, predictSeason, scenario, onStatus } = config;

        // Load Reddit sentiment data (precomputed by fetch-reddit-sentiment.ts)
        let redditBuzz = new Map<string, { mentions: number; upvotes: number; sentiment: number; hype: number }>();
        let redditWindowed = new Map<string, {
          mentions_1w: number; sentiment_1w: number; hype_1w: number;
          mentions_4w: number; sentiment_4w: number; hype_4w: number;
          mention_velocity: number; sentiment_velocity: number;
        }>();
        try {
          const IS_PROD = typeof window !== 'undefined' && window.location.hostname !== 'localhost';
          const baseUrl = IS_PROD ? (typeof import.meta !== 'undefined' ? import.meta.env?.BASE_URL || '/' : '/') : '/';
          const sentimentUrl = IS_PROD
            ? `${baseUrl}data/reddit_sentiment.json`
            : typeof window !== 'undefined'
            ? `${baseUrl}data/reddit_sentiment.json`
            : 'public/data/reddit_sentiment.json'; // Node.js build-time path

          // In Node, read from disk; in browser, fetch
          let sentimentData: any = null;
          if (typeof window === 'undefined') {
            // Node.js
            try {
              const fs = await import('fs');
              if (fs.existsSync('public/data/reddit_sentiment.json')) {
                sentimentData = JSON.parse(fs.readFileSync('public/data/reddit_sentiment.json', 'utf-8'));
              }
            } catch { /* no sentiment data available */ }
          } else {
            // Browser
            try {
              const resp = await fetch(sentimentUrl);
              if (resp.ok) sentimentData = await resp.json();
            } catch { /* no sentiment data available */ }
          }

          if (sentimentData) {
            // Build preseason buzz lookup: "player:season" -> buzz data
            for (const b of (sentimentData.preseasonBuzz || [])) {
              const key = `${normalizeName(b.player)}:${b.season}`;
              redditBuzz.set(key, b);
            }
            // Build windowed lookup: "player:season" -> latest week-4 window
            for (const w of (sentimentData.windowedSentiment || [])) {
              if (w.week <= 4) { // Use early-season data as preseason proxy
                const key = `${normalizeName(w.player)}:${w.season}`;
                const existing = redditWindowed.get(key);
                if (!existing || w.week > (existing as any)._week) {
                  redditWindowed.set(key, { ...w, _week: w.week } as any);
                }
              }
            }
            onStatus?.(`Loaded Reddit sentiment: ${redditBuzz.size} player-seasons`);
          }
        } catch { /* Reddit data not available — features will be 0 */ }

        // Load combine + draft + games + contracts + college once (static)
        onStatus?.('Loading combine, draft, games, contracts & college data...');
        const [combineData, draftData, gamesData, contractsData, collegeStatsData, collegeQBRData] = await Promise.all([
          fetchCombine(),
          fetchDraftPicks(),
          fetchGames(),
          fetchContracts().catch(() => [] as Contract[]),
          fetchCollegeStats().catch(() => [] as CollegeStats[]),
          fetchCollegeQBR().catch(() => [] as CollegeQBR[]),
        ]);

        // Build lookup maps
        const combineByName = new Map<string, CombineResult>();
        for (const c of combineData) combineByName.set(normalizeName(c.player_name), c);

        const draftByName = new Map<string, DraftPick>();

        // Contract lookup: player name → latest active contract
        const contractByName = new Map<string, Contract>();
        const sortedContracts = [...contractsData].sort((a, b) => b.year_signed - a.year_signed);
        for (const c of sortedContracts) {
          if (!['QB', 'RB', 'WR', 'TE'].includes(c.position)) continue;
          const name = normalizeName(c.player);
          if (!contractByName.has(name)) contractByName.set(name, c);
        }

        // College stats lookup: player name → final college season stats
        // CollegeStats has one row per player per statistic per season
        const collegeByName = new Map<string, Map<string, number>>(); // name → { statistic → value }
        for (const cs of collegeStatsData) {
          const name = normalizeName(cs.player_name);
          if (!collegeByName.has(name)) collegeByName.set(name, new Map());
          const existing = collegeByName.get(name)!;
          // Keep the latest season's stats (highest season number)
          const existingKey = `${cs.statistic}:latest`;
          const existingSeason = existing.get(existingKey) || 0;
          if (cs.season >= existingSeason) {
            existing.set(cs.statistic, cs.value || 0);
            existing.set(existingKey, cs.season);
          }
        }

        // College QBR lookup: player name → final season QBR
        const collegeQBRByName = new Map<string, number>();
        for (const q of collegeQBRData) {
          const name = normalizeName(q.player_name);
          const existing = collegeQBRByName.get(name) || 0;
          if (q.season >= existing || !collegeQBRByName.has(name)) {
            collegeQBRByName.set(name, q.total_qbr || 0);
          }
        }

        // Aging curve constants (position → { peakStart, peakEnd, declineStart })
        const AGING_CURVES: Record<string, { peakStart: number; peakEnd: number; declineStart: number }> = {
          QB: { peakStart: 27, peakEnd: 32, declineStart: 35 },
          RB: { peakStart: 23, peakEnd: 26, declineStart: 28 },
          WR: { peakStart: 25, peakEnd: 29, declineStart: 31 },
          TE: { peakStart: 25, peakEnd: 29, declineStart: 31 },
        };
        for (const d of draftData) draftByName.set(normalizeName(d.pfr_player_name), d);

        // Coach lookup: season → team → head coach name
        const coachBySeasonTeam = new Map<string, string>();
        for (const g of gamesData) {
          if (g.game_type !== 'REG') continue;
          if (g.home_coach) coachBySeasonTeam.set(`${g.season}:${g.home_team}`, g.home_coach);
          if (g.away_coach) coachBySeasonTeam.set(`${g.season}:${g.away_team}`, g.away_coach);
        }

        // Build Vegas implied totals per team-season from game lines
        interface VegasTeamAgg {
          impliedTotal: number; spread: number; gameTotal: number;
          actualPts: number; games: number; wins: number;
        }
        const vegasBySeasonTeam = new Map<string, VegasTeamAgg>();
        for (const g of gamesData) {
          if (g.game_type !== 'REG') continue;
          const tl = g.total_line || 0;
          const sl = g.spread_line || 0; // negative = home favored

          // Home team
          const homeKey = `${g.season}:${g.home_team}`;
          const homeAcc = vegasBySeasonTeam.get(homeKey) || {
            impliedTotal: 0, spread: 0, gameTotal: 0, actualPts: 0, games: 0, wins: 0,
          };
          if (tl > 0) {
            homeAcc.impliedTotal += (tl - sl) / 2; // home implied = (total - spread) / 2
            homeAcc.gameTotal += tl;
          }
          homeAcc.spread += sl;
          homeAcc.actualPts += g.home_score || 0;
          homeAcc.games += 1;
          if ((g.home_score || 0) > (g.away_score || 0)) homeAcc.wins += 1;
          vegasBySeasonTeam.set(homeKey, homeAcc);

          // Away team
          const awayKey = `${g.season}:${g.away_team}`;
          const awayAcc = vegasBySeasonTeam.get(awayKey) || {
            impliedTotal: 0, spread: 0, gameTotal: 0, actualPts: 0, games: 0, wins: 0,
          };
          if (tl > 0) {
            awayAcc.impliedTotal += (tl + sl) / 2; // away implied = (total + spread) / 2
            awayAcc.gameTotal += tl;
          }
          awayAcc.spread += -sl; // flip sign for away perspective
          awayAcc.actualPts += g.away_score || 0;
          awayAcc.games += 1;
          if ((g.away_score || 0) > (g.home_score || 0)) awayAcc.wins += 1;
          vegasBySeasonTeam.set(awayKey, awayAcc);
        }

        const rows: PlayerRow[] = [];

        // Track raw PPG per player for ADP-bin expected calculations
        // This is separate from vor (which gets z-scored in-place)
        const rawPPGHistory: Array<{ position: string; adp: number; ppg: number }> = [];

        // Cross-season player history for momentum features
        // Tracks prior season stats per player to compute 2-year trends
        interface PlayerHistory {
          season: number;
          ppg: number;
          targets: number;
          touches: number;
          snapPct: number;
          targetShare: number;
          adp: number;
        }
        const playerHistoryMap = new Map<string, PlayerHistory[]>(); // name → sorted history

        for (const season of seasons) {
          onStatus?.(`Building features for ${season}...`);

          // Fetch current + prior in parallel (including injuries, NGS, PBP)
          const [
            adpData, currentStats, priorStats, priorSnaps,
            priorInjuries, preseasonInjuries,
            priorNgsRec, priorNgsRush, priorNgsPass,
            priorPbp, priorParticipation,
            seasonRosters, priorRosters, seasonDepthCharts,
          ] = await Promise.all([
            fetchFfcADP(season, 'ppr', 12).catch(() => []),
            fetchPlayerStats(season).catch(() => []),
            fetchPlayerStats(season - 1).catch(() => []),
            fetchSnapCounts(season - 1).catch(() => []),
            fetchInjuries(season - 1).catch(() => []),
            fetchInjuries(season).catch(() => []),
            fetchNextGenStats(season - 1, 'receiving').catch(() => [] as NextGenStats[]),
            fetchNextGenStats(season - 1, 'rushing').catch(() => [] as NextGenStats[]),
            fetchNextGenStats(season - 1, 'passing').catch(() => [] as NextGenStats[]),
            fetchPlayByPlay(season - 1).catch(() => [] as PlayByPlay[]),
            fetchPbpParticipation(season - 1).catch(() => [] as PbpParticipation[]),
            fetchRosters(season).catch(() => [] as Roster[]),
            fetchRosters(season - 1).catch(() => [] as Roster[]),
            fetchDepthCharts(season).catch(() => [] as DepthChart[]),
          ]);
          

          if (adpData.length === 0 || currentStats.length === 0) continue;

          // Current season totals + ranks
          const currentTotals = aggregateToSeasonTotals(
            currentStats.filter((s) => s.season_type === 'REG')
          );

          // Active games map: weeks where player scored >1 PPR point
          const activeGamesMap = new Map<string, number>();
          for (const w of currentStats.filter((s) => s.season_type === 'REG')) {
            if ((w.fantasy_points_ppr || 0) > 1) {
              const name = normalizeName(w.player_display_name);
              activeGamesMap.set(name, (activeGamesMap.get(name) || 0) + 1);
            }
          }

          // Compute PPG (points per active game) for each player
          const getPPG = (p: SeasonTotals): number => {
            const ppr = p.fantasy_points_ppr || 0;
            const ag = activeGamesMap.get(normalizeName(p.player_display_name)) || p.games || 1;
            return ag > 0 ? ppr / ag : 0;
          };

          // Current stats lookup (needed for position verification)
          const currentByName = new Map<string, SeasonTotals>();
          for (const p of currentTotals) {
            if (POSITIONS.includes(p.position)) {
              currentByName.set(normalizeName(p.player_display_name), p);
            }
          }

          const leagueSize = 12; // for ADP bin calculation

          // Build ADP-bin expected PPG from PRIOR completed seasons (no leakage)
          // Uses accumulated historical data: "players drafted in round X at this
          // position historically average Y PPG." This is known before the season.
          // ADP bins: round 1 (1-12), round 2 (13-24), ..., round 10+ (109+)
          const getADPBin = (adp: number) => Math.min(10, Math.ceil(adp / leagueSize));
          // expectedPPGByBin is built from raw PPG history (never z-scored)
          const expectedPPGByBin = new Map<string, number>(); // "pos:bin" → avg PPG
          {
            const binAccum = new Map<string, { total: number; count: number }>();
            for (const h of rawPPGHistory) {
              const bin = getADPBin(h.adp);
              const key = `${h.position}:${bin}`;
              const acc = binAccum.get(key) || { total: 0, count: 0 };
              acc.total += h.ppg;
              acc.count += 1;
              binAccum.set(key, acc);
            }
            for (const [key, acc] of binAccum) {
              expectedPPGByBin.set(key, acc.count >= 3 ? acc.total / acc.count : 0);
            }
          }

          const allFantasy = currentTotals
            .filter((p) => POSITIONS.includes(p.position))
            .sort((a, b) => getPPG(b) - getPPG(a));
          const overallRankMap = new Map<string, number>();
          allFantasy.forEach((p, i) => overallRankMap.set(normalizeName(p.player_display_name), i + 1));

          // Prior season totals
          const priorTotals = aggregateToSeasonTotals(
            priorStats.filter((s) => s.season_type === 'REG')
          );
          const priorByName = new Map<string, SeasonTotals>();
          for (const p of priorTotals) {
            if (POSITIONS.includes(p.position)) {
              priorByName.set(normalizeName(p.player_display_name), p);
            }
          }

          // Build player history for momentum features
          // Track prior season's stats for each player (season - 1 data)
          for (const p of priorTotals) {
            if (!POSITIONS.includes(p.position)) continue;
            const name = normalizeName(p.player_display_name);
            if (!playerHistoryMap.has(name)) playerHistoryMap.set(name, []);
            const hist = playerHistoryMap.get(name)!;
            // Avoid duplicate entries for the same season
            if (!hist.some((h) => h.season === season - 1)) {
              const ag = activeGamesMap.get(name) || p.games || 1;
              hist.push({
                season: season - 1,
                ppg: ag > 0 ? (p.fantasy_points_ppr || 0) / ag : 0,
                targets: p.targets || 0,
                touches: (p.carries || 0) + (p.receptions || 0),
                snapPct: 0, // will be filled from snap data
                targetShare: 0, // will be filled from weekly data
                adp: 0, // filled from ADP data
              });
            }
          }

          // ── Projection features (team-projection methodology applied to prior stats) ──
          const projFeatures = computePlayerProjectionFeatures(priorStats);

          // Prior snap %
          const snapAccum = new Map<string, { total: number; count: number }>();
          for (const s of priorSnaps) {
            if (!POSITIONS.includes(s.position)) continue;
            const name = normalizeName(s.player);
            const acc = snapAccum.get(name) || { total: 0, count: 0 };
            acc.total += s.offense_pct || 0;
            acc.count += 1;
            snapAccum.set(name, acc);
          }

          // Advanced weekly stats aggregation (target share, WOPR, RACR, air yards, YAC, EPA)
          interface AdvAgg {
            targetShare: number; airYardsShare: number; wopr: number;
            racr: number; recAirYards: number; yac: number;
            receptions: number; targets: number;
            recEPA: number; rushEPA: number;
            weeks: number;
          }
          const advByName = new Map<string, AdvAgg>();
          const priorWeekly = priorStats.filter((s) => s.season_type === 'REG') as PlayerStats[];
          for (const w of priorWeekly) {
            if (!POSITIONS.includes(w.position)) continue;
            const name = normalizeName(w.player_display_name);
            const acc = advByName.get(name) || {
              targetShare: 0, airYardsShare: 0, wopr: 0, racr: 0,
              recAirYards: 0, yac: 0, receptions: 0, targets: 0,
              recEPA: 0, rushEPA: 0, weeks: 0,
            };
            // Sum accumulating stats, average rates later
            acc.targetShare += w.target_share || 0;
            acc.airYardsShare += w.air_yards_share || 0;
            acc.wopr += w.wopr || 0;
            acc.recAirYards += w.receiving_air_yards || 0;
            acc.yac += w.receiving_yards_after_catch || 0;
            acc.receptions += w.receptions || 0;
            acc.targets += w.targets || 0;
            acc.recEPA += w.receiving_epa || 0;
            acc.rushEPA += w.rushing_epa || 0;
            // racr is a ratio, accumulate for averaging
            if (w.racr && w.racr > 0) acc.racr += w.racr;
            acc.weeks += 1;
            advByName.set(name, acc);
          }

          // NGS season-level summaries (week 0 = full season)
          const ngsRecByName = new Map<string, NextGenStats>();
          for (const n of priorNgsRec) {
            if (n.week === 0 && n.season_type === 'REG') {
              ngsRecByName.set(normalizeName(n.player_display_name), n);
            }
          }
          const ngsRushByName = new Map<string, NextGenStats>();
          for (const n of priorNgsRush) {
            if (n.week === 0 && n.season_type === 'REG') {
              ngsRushByName.set(normalizeName(n.player_display_name), n);
            }
          }
          const ngsPassByName = new Map<string, NextGenStats>();
          for (const n of priorNgsPass) {
            if (n.week === 0 && n.season_type === 'REG') {
              ngsPassByName.set(normalizeName(n.player_display_name), n);
            }
          }

          // PBP-derived: aDOT, deep target %, red zone target share
          interface PbpAgg {
            totalAirYards: number; targets: number;
            deepTargets: number; rzTargets: number;
          }
          const pbpByReceiver = new Map<string, PbpAgg>();
          // Count total RZ targets per team for share calculation
          const teamRZTargets = new Map<string, number>();

          for (const play of priorPbp) {
            if (play.play_type !== 'pass' || !play.receiver_player_name) continue;
            const recName = normalizeName(play.receiver_player_name);
            const acc = pbpByReceiver.get(recName) || {
              totalAirYards: 0, targets: 0, deepTargets: 0, rzTargets: 0,
            };
            acc.targets += 1;
            if (typeof play.air_yards === 'number' && !isNaN(play.air_yards)) {
              acc.totalAirYards += play.air_yards;
              if (play.air_yards >= 15) acc.deepTargets += 1;
            }
            if (play.yardline_100 <= 20) {
              acc.rzTargets += 1;
              const team = play.posteam || '';
              teamRZTargets.set(team, (teamRZTargets.get(team) || 0) + 1);
            }
            pbpByReceiver.set(recName, acc);
          }

          // Build GSIS ID → normalized name map from weekly stats
          const gsisToName = new Map<string, string>();
          for (const w of priorWeekly) {
            if (w.player_id && w.player_display_name) {
              gsisToName.set(w.player_id, normalizeName(w.player_display_name));
            }
          }

          // Participation-derived: routes run, YPRR, personnel splits
          // Join participation with PBP pass plays to count routes per player
          interface RouteAgg {
            routesRun: number;
            snaps11: number; // 11 personnel (1 RB, 1 TE, 3 WR)
            snaps12: number; // 12 personnel (1 RB, 2 TE, 2 WR)
            totalSnaps: number;
          }
          const routesByName = new Map<string, RouteAgg>();

          // Build a set of pass play keys for quick lookup
          const passPlayKeys = new Set<string>();
          for (const play of priorPbp) {
            if (play.qb_dropback === 1 || play.play_type === 'pass') {
              passPlayKeys.add(`${play.game_id}:${play.play_id}`);
            }
          }

          // Parse personnel string to get grouping (e.g., "1 RB, 1 TE, 3 WR" → "11")
          function parsePersonnel(personnel: string): string {
            if (!personnel) return '';
            const rbMatch = personnel.match(/(\d+)\s*RB/i);
            const teMatch = personnel.match(/(\d+)\s*TE/i);
            const rb = rbMatch ? rbMatch[1] : '0';
            const te = teMatch ? teMatch[1] : '0';
            return `${rb}${te}`;
          }

          for (const part of priorParticipation) {
            if (!part.offense_players) continue;

            const gamePlayKey = `${part.nflverse_game_id}:${part.play_id}`;
            // Also check old_game_id format since PBP might use different ID
            const altKey = `${part.old_game_id}:${part.play_id}`;
            const isPassPlay = passPlayKeys.has(gamePlayKey) || passPlayKeys.has(altKey);

            const personnel = parsePersonnel(part.offense_personnel || '');
            const offenseIds = part.offense_players.split(';');

            for (const gsisId of offenseIds) {
              const id = gsisId.trim();
              const name = gsisToName.get(id);
              if (!name) continue;

              const acc = routesByName.get(name) || {
                routesRun: 0, snaps11: 0, snaps12: 0, totalSnaps: 0,
              };
              acc.totalSnaps += 1;
              if (isPassPlay) acc.routesRun += 1;
              if (personnel === '11') acc.snaps11 += 1;
              else if (personnel === '12') acc.snaps12 += 1;
              routesByName.set(name, acc);
            }
          }

          // Pass location distribution per receiver from PBP
          interface LocAgg { left: number; middle: number; right: number; total: number }
          const locByReceiver = new Map<string, LocAgg>();
          for (const play of priorPbp) {
            if (play.play_type !== 'pass' || !play.receiver_player_name || !play.pass_location) continue;
            const recName = normalizeName(play.receiver_player_name);
            const acc = locByReceiver.get(recName) || { left: 0, middle: 0, right: 0, total: 0 };
            acc.total += 1;
            if (play.pass_location === 'left') acc.left += 1;
            else if (play.pass_location === 'middle') acc.middle += 1;
            else if (play.pass_location === 'right') acc.right += 1;
            locByReceiver.set(recName, acc);
          }

          // ── Team scheme features from prior PBP ──
          interface SchemeAgg {
            passes: number; rushes: number; plays: number; games: number;
            neutralPasses: number; neutralPlays: number;
            firstDownRuns: number; firstDownPlays: number;
            shotgunPlays: number; noHuddlePlays: number;
            rbTargets: number; teTargets: number; wrTargets: number; totalTargets: number;
          }
          const schemeByTeam = new Map<string, SchemeAgg>();
          // Count games per team for pace calculation
          const priorGamesByTeam = new Map<string, Set<string>>();
          for (const play of priorPbp) {
            if (!play.posteam || play.play_type === 'no_play') continue;
            const team = play.posteam;
            if (!priorGamesByTeam.has(team)) priorGamesByTeam.set(team, new Set());
            priorGamesByTeam.get(team)!.add(play.game_id);

            if (play.play_type !== 'pass' && play.play_type !== 'run') continue;
            const acc = schemeByTeam.get(team) || {
              passes: 0, rushes: 0, plays: 0, games: 0,
              neutralPasses: 0, neutralPlays: 0,
              firstDownRuns: 0, firstDownPlays: 0,
              shotgunPlays: 0, noHuddlePlays: 0,
              rbTargets: 0, teTargets: 0, wrTargets: 0, totalTargets: 0,
            };
            acc.plays += 1;
            if (play.play_type === 'pass' || play.qb_dropback === 1) acc.passes += 1;
            else acc.rushes += 1;

            // Neutral game script: score diff within 7, 1st-3rd quarter
            const isNeutral = Math.abs(play.score_differential || 0) <= 7 && (play.qtr || 0) <= 3;
            if (isNeutral) {
              acc.neutralPlays += 1;
              if (play.play_type === 'pass' || play.qb_dropback === 1) acc.neutralPasses += 1;
            }

            // First down tendencies
            if (play.down === 1) {
              acc.firstDownPlays += 1;
              if (play.play_type === 'run' && play.qb_dropback !== 1) acc.firstDownRuns += 1;
            }

            if (play.shotgun === 1) acc.shotgunPlays += 1;
            if (play.no_huddle === 1) acc.noHuddlePlays += 1;

            // Positional target breakdown
            if (play.play_type === 'pass' && play.receiver_player_name) {
              acc.totalTargets += 1;
              const recName = normalizeName(play.receiver_player_name);
              const recPrior = priorByName.get(recName);
              if (recPrior?.position === 'RB') acc.rbTargets += 1;
              else if (recPrior?.position === 'TE') acc.teTargets += 1;
              else if (recPrior?.position === 'WR') acc.wrTargets += 1;
            }

            schemeByTeam.set(team, acc);
          }
          // Set games count
          for (const [team, gameSet] of priorGamesByTeam) {
            const acc = schemeByTeam.get(team);
            if (acc) acc.games = gameSet.size;
          }

          // ── Team personnel grouping rates from PBP ──
          // Parse offense_personnel from PBP plays (e.g. "1 RB, 1 TE, 3 WR")
          interface PersonnelAgg {
            p11: number; p12: number; p13: number; p21: number;
            p22: number; p10: number; total: number;
            wr3plus: number; te2plus: number;
          }
          const personnelByTeam = new Map<string, PersonnelAgg>();
          for (const play of priorPbp) {
            if (!play.posteam || !play.offense_personnel) continue;
            if (play.play_type !== 'pass' && play.play_type !== 'run') continue;
            const team = play.posteam;
            const acc = personnelByTeam.get(team) || {
              p11: 0, p12: 0, p13: 0, p21: 0, p22: 0, p10: 0, total: 0,
              wr3plus: 0, te2plus: 0,
            };
            acc.total += 1;

            const pers = play.offense_personnel;
            const rbMatch = pers.match(/(\d+)\s*RB/i);
            const teMatch = pers.match(/(\d+)\s*TE/i);
            const wrMatch = pers.match(/(\d+)\s*WR/i);
            const rb = rbMatch ? Number(rbMatch[1]) : 0;
            const te = teMatch ? Number(teMatch[1]) : 0;
            const wr = wrMatch ? Number(wrMatch[1]) : 0;

            const grouping = `${rb}${te}`;
            if (grouping === '11') acc.p11 += 1;
            else if (grouping === '12') acc.p12 += 1;
            else if (grouping === '13') acc.p13 += 1;
            else if (grouping === '21') acc.p21 += 1;
            else if (grouping === '22') acc.p22 += 1;
            else if (grouping === '10') acc.p10 += 1;

            if (wr >= 3) acc.wr3plus += 1;
            if (te >= 2) acc.te2plus += 1;

            personnelByTeam.set(team, acc);
          }

          // Coach change detection: compare prior season coach to current season coach
          const coachChangeTeams = new Set<string>();
          for (const [key, coach] of coachBySeasonTeam) {
            const [szn, team] = key.split(':');
            if (Number(szn) === season) {
              const priorCoach = coachBySeasonTeam.get(`${season - 1}:${team}`);
              if (priorCoach && priorCoach !== coach) coachChangeTeams.add(team);
            }
          }

          // Coach's prior-season total team PPR (how productive was the offense)
          const coachPriorTeamPPR = new Map<string, number>();
          for (const p of priorTotals) {
            if (!POSITIONS.includes(p.position)) continue;
            const team = p.recent_team || '';
            coachPriorTeamPPR.set(team, (coachPriorTeamPPR.get(team) || 0) + (p.fantasy_points_ppr || 0));
          }

          // Prior-season injury aggregation
          const SOFT_TISSUE = /hamstring|groin|calf|quad|hip|thigh|achilles|ankle|foot|toe/i;
          const KNEE = /knee|acl|mcl|pcl|meniscus/i;

          interface InjAgg { weeks: number; gamesOut: number; softTissue: boolean; knee: boolean }
          const priorInjByName = new Map<string, InjAgg>();
          for (const inj of priorInjuries) {
            if (!POSITIONS.includes(inj.position)) continue;
            const name = normalizeName(inj.full_name);
            const acc = priorInjByName.get(name) || { weeks: 0, gamesOut: 0, softTissue: false, knee: false };
            acc.weeks += 1;
            if (inj.report_status === 'Out' || inj.report_status === 'Doubtful') acc.gamesOut += 1;
            const allInjText = `${inj.report_primary_injury || ''} ${inj.report_secondary_injury || ''} ${inj.practice_primary_injury || ''} ${inj.practice_secondary_injury || ''}`;
            if (SOFT_TISSUE.test(allInjText)) acc.softTissue = true;
            if (KNEE.test(allInjText)) acc.knee = true;
            priorInjByName.set(name, acc);
          }

          // Preseason injury status (game_type PRE or first 4 weeks of current season before REG)
          const preseasonInjByName = new Map<string, { injured: boolean; weeks: number }>();
          for (const inj of preseasonInjuries) {
            if (!POSITIONS.includes(inj.position)) continue;
            // Preseason reports: game_type PRE, or week <= 0, or early weeks before regular season
            const isPre = inj.game_type === 'PRE' || inj.week <= 0;
            if (!isPre) continue;
            const name = normalizeName(inj.full_name);
            const acc = preseasonInjByName.get(name) || { injured: false, weeks: 0 };
            acc.weeks += 1;
            if (inj.report_status === 'Out' || inj.report_status === 'Doubtful' || inj.report_status === 'Questionable') {
              acc.injured = true;
            }
            preseasonInjByName.set(name, acc);
          }

          // currentByName already built above (before expected PPG curve)

          // ── Roster competition features ──

          // Current-season roster: players per team-position
          // Use latest week snapshot (highest week number)
          const rosterByTeamPos = new Map<string, Set<string>>();
          const playerTeamMap = new Map<string, string>(); // name → team
          for (const r of seasonRosters) {
            if (!POSITIONS.includes(r.position) || r.status === 'Inactive') continue;
            const key = `${r.team}:${r.position}`;
            if (!rosterByTeamPos.has(key)) rosterByTeamPos.set(key, new Set());
            const name = normalizeName(r.full_name);
            rosterByTeamPos.get(key)!.add(name);
            playerTeamMap.set(name, r.team);
          }

          // Prior-season roster for detecting new arrivals
          const priorRosterByTeamPos = new Map<string, Set<string>>();
          for (const r of priorRosters) {
            if (!POSITIONS.includes(r.position)) continue;
            const key = `${r.team}:${r.position}`;
            if (!priorRosterByTeamPos.has(key)) priorRosterByTeamPos.set(key, new Set());
            priorRosterByTeamPos.get(key)!.add(normalizeName(r.full_name));
          }

          // Depth chart rank (use latest available depth chart)
          const depthRankByName = new Map<string, number>();
          const dcLatest = new Map<string, DepthChart>(); // key: team:pos:name → latest entry
          for (const dc of seasonDepthCharts) {
            const name = normalizeName(dc.player_name);
            const key = `${dc.team}:${dc.pos_abb}:${name}`;
            const existing = dcLatest.get(key);
            if (!existing || dc.dt > existing.dt) dcLatest.set(key, dc);
          }
          for (const dc of dcLatest.values()) {
            depthRankByName.set(normalizeName(dc.player_name), dc.pos_rank || dc.pos_slot || 99);
          }

          // Prior team touch totals for share calculation
          const teamTotalCarries = new Map<string, number>();
          const teamTotalTargets = new Map<string, number>();
          for (const p of priorTotals) {
            if (!POSITIONS.includes(p.position)) continue;
            const team = p.recent_team || '';
            if (!team) continue;
            teamTotalCarries.set(team, (teamTotalCarries.get(team) || 0) + (p.carries || 0));
            teamTotalTargets.set(team, (teamTotalTargets.get(team) || 0) + (p.targets || 0));
          }

          // ── Team QB rushing impact on skill positions ──
          // Use the CURRENT season's starting QB (from rosters/depth charts),
          // but look up THAT QB's prior rushing stats regardless of which team
          // they played for. This handles QB trades correctly — if a mobile QB
          // joins a new team, the rushing tendency follows the QB, not the team.
          const teamQBStats = new Map<string, {
            rushAtt: number; rushYds: number; rushTDs: number;
            rushShare: number; scrambleRate: number; ppg: number;
          }>();
          {
            // Find current-season starting QB per team from depth charts or roster
            const currentQBByTeam = new Map<string, string>(); // team → QB name
            // Try depth charts first (most accurate)
            for (const dc of dcLatest.values()) {
              if (dc.pos_abb === 'QB' && (dc.pos_rank === 1 || dc.pos_slot === 1)) {
                currentQBByTeam.set(dc.team, normalizeName(dc.player_name));
              }
            }
            // Fall back to roster QBs with highest ADP if no depth chart
            if (currentQBByTeam.size < 20) {
              const adpByName2 = new Map<string, number>();
              for (const a of adpData) adpByName2.set(normalizeName(a.name), a.adp);
              for (const r of seasonRosters) {
                if (r.position !== 'QB' || r.status === 'Inactive') continue;
                const name = normalizeName(r.full_name);
                if (!currentQBByTeam.has(r.team)) {
                  currentQBByTeam.set(r.team, name);
                } else {
                  // Prefer the QB with better ADP
                  const existingAdp = adpByName2.get(currentQBByTeam.get(r.team)!) || 999;
                  const thisAdp = adpByName2.get(name) || 999;
                  if (thisAdp < existingAdp) currentQBByTeam.set(r.team, name);
                }
              }
            }

            // Look up each team's current QB's PRIOR rushing stats (from any team)
            for (const [team, qbName] of currentQBByTeam) {
              const qbPrior = priorByName.get(qbName);
              if (!qbPrior) continue;
              const qbGames = qbPrior.games || 1;
              // Use the QB's prior team's total carries for rush share
              const qbPriorTeam = qbPrior.recent_team || '';
              const priorTeamRushAtt = teamTotalCarries.get(qbPriorTeam) || 1;
              const scrambleRate = qbPrior.carries && qbPrior.attempts
                ? (qbPrior.carries) / (qbPrior.attempts + qbPrior.carries)
                : 0;
              teamQBStats.set(team, {
                rushAtt: qbPrior.carries || 0,
                rushYds: qbPrior.rushing_yards || 0,
                rushTDs: qbPrior.rushing_tds || 0,
                rushShare: (qbPrior.carries || 0) / priorTeamRushAtt,
                scrambleRate: Math.round(scrambleRate * 1000) / 1000,
                ppg: Math.round((qbPrior.fantasy_points_ppr || 0) / qbGames * 10) / 10,
              });
            }
          }

          // Team's prior QB stats (coaching tendency — stays with team regardless of QB change)
          const teamPriorQBStats = new Map<string, { rushAtt: number; rushShare: number; scrambleRate: number }>();
          {
            const priorQBByTeam = new Map<string, SeasonTotals>();
            for (const p of priorTotals) {
              if (p.position !== 'QB') continue;
              const team = p.recent_team || '';
              if (!team) continue;
              const existing = priorQBByTeam.get(team);
              if (!existing || (p.fantasy_points_ppr || 0) > (existing.fantasy_points_ppr || 0)) {
                priorQBByTeam.set(team, p);
              }
            }
            for (const [team, qb] of priorQBByTeam) {
              const tRushAtt = teamTotalCarries.get(team) || 1;
              const sch = schemeByTeam.get(team);
              const sr = sch && sch.passes > 0 ? (qb.carries || 0) / (sch.passes + (qb.carries || 0)) : 0;
              teamPriorQBStats.set(team, {
                rushAtt: qb.carries || 0,
                rushShare: (qb.carries || 0) / tRushAtt,
                scrambleRate: Math.round(sr * 1000) / 1000,
              });
            }
          }

          // ── Weekly consistency features ──
          const weeklyConsistency = new Map<string, { stdDev: number; boomRate: number; bustGameRate: number }>();
          {
            const playerWeeklyPts = new Map<string, number[]>();
            for (const w of priorWeekly) {
              if (!POSITIONS.includes(w.position)) continue;
              const name = normalizeName(w.player_display_name);
              if (!playerWeeklyPts.has(name)) playerWeeklyPts.set(name, []);
              playerWeeklyPts.get(name)!.push(w.fantasy_points_ppr || 0);
            }
            for (const [name, pts] of playerWeeklyPts) {
              if (pts.length < 3) continue;
              const mean = pts.reduce((a, b) => a + b, 0) / pts.length;
              const variance = pts.reduce((s, v) => s + (v - mean) ** 2, 0) / pts.length;
              const stdDev = Math.sqrt(variance);
              const boomRate = pts.filter((p) => p >= 20).length / pts.length;
              const bustGameRate = pts.filter((p) => p < 5).length / pts.length;
              weeklyConsistency.set(name, {
                stdDev: Math.round(stdDev * 10) / 10,
                boomRate: Math.round(boomRate * 1000) / 1000,
                bustGameRate: Math.round(bustGameRate * 1000) / 1000,
              });
            }
          }

          // ── Environment features: dome, bye week, O-line quality ──
          const teamDomeGames = new Map<string, number>();
          const teamByeWeek = new Map<string, number>();
          const teamSackRate = new Map<string, number>();
          const teamRushYPC = new Map<string, number>();
          {
            for (const g of gamesData) {
              if (g.game_type !== 'REG' || g.season !== season) continue;
              // Dome games (home team)
              if (g.roof === 'dome' || g.roof === 'closed') {
                teamDomeGames.set(g.home_team, (teamDomeGames.get(g.home_team) || 0) + 1);
              }
            }
            // Bye week from schedule gaps
            const teamWeeks = new Map<string, number[]>();
            for (const g of gamesData) {
              if (g.game_type !== 'REG' || g.season !== season) continue;
              for (const team of [g.home_team, g.away_team]) {
                if (!teamWeeks.has(team)) teamWeeks.set(team, []);
                teamWeeks.get(team)!.push(g.week);
              }
            }
            for (const [team, weeks] of teamWeeks) {
              const sorted = weeks.sort((a, b) => a - b);
              for (let i = 1; i < sorted.length; i++) {
                if (sorted[i] - sorted[i - 1] > 1) {
                  teamByeWeek.set(team, sorted[i - 1] + 1);
                  break;
                }
              }
            }
            // O-line: sack rate and rush YPC from prior PBP
            const teamSacks = new Map<string, { sacks: number; dropbacks: number }>();
            const teamRush = new Map<string, { yards: number; attempts: number }>();
            for (const play of priorPbp) {
              if (!play.posteam) continue;
              if (play.play_type === 'pass' || play.qb_dropback === 1) {
                const acc = teamSacks.get(play.posteam) || { sacks: 0, dropbacks: 0 };
                acc.dropbacks += 1;
                if (play.sack === 1) acc.sacks += 1;
                teamSacks.set(play.posteam, acc);
              }
              if (play.play_type === 'run' && play.rushing_yards != null) {
                const acc = teamRush.get(play.posteam) || { yards: 0, attempts: 0 };
                acc.yards += play.rushing_yards;
                acc.attempts += 1;
                teamRush.set(play.posteam, acc);
              }
            }
            for (const [team, s] of teamSacks) {
              teamSackRate.set(team, s.dropbacks > 0 ? Math.round((s.sacks / s.dropbacks) * 1000) / 1000 : 0);
            }
            for (const [team, r] of teamRush) {
              teamRushYPC.set(team, r.attempts > 0 ? Math.round((r.yards / r.attempts) * 10) / 10 : 0);
            }
          }

          // ── QB passer rating for WR/TE value ──
          const teamQBPassRating = new Map<string, number>();
          {
            for (const p of priorTotals) {
              if (p.position !== 'QB') continue;
              const team = p.recent_team || '';
              if (!team || !p.attempts || p.attempts < 100) continue;
              const existing = teamQBPassRating.get(team);
              if (!existing || (p.fantasy_points_ppr || 0) > (existing || 0)) {
                // Approximate passer rating from stats
                const compPct = p.completions / p.attempts;
                const ypa = p.passing_yards / p.attempts;
                const tdPct = p.passing_tds / p.attempts;
                const intPct = p.interceptions / p.attempts;
                const a = Math.min(2.375, Math.max(0, (compPct - 0.3) * 5));
                const b = Math.min(2.375, Math.max(0, (ypa - 3) * 0.25));
                const c = Math.min(2.375, Math.max(0, tdPct * 20));
                const d = Math.min(2.375, Math.max(0, 2.375 - intPct * 25));
                teamQBPassRating.set(team, Math.round(((a + b + c + d) / 6) * 100 * 10) / 10);
              }
            }
          }

          // ── Injury recurrence ──
          // Check if same injury type occurred in prior-prior season
          const injuryRecurrence = new Map<string, number>();
          // We only have current prior injuries — for recurrence we'd need 2-year history
          // Use soft tissue + knee flags from prior injuries as a proxy for recurrence risk
          for (const [name, inj] of priorInjByName) {
            let risk = 0;
            if (inj.softTissue) risk += 0.5;
            if (inj.knee) risk += 0.5;
            if (inj.gamesOut >= 4) risk += 0.5;
            injuryRecurrence.set(name, Math.min(1, risk));
          }

          // ── Team roster turnover ──
          const teamRosterTurnover = new Map<string, number>();
          for (const [key, currentNames] of rosterByTeamPos) {
            const [team] = key.split(':');
            const priorNames = priorRosterByTeamPos.get(key);
            if (!priorNames) continue;
            const newPlayers = [...currentNames].filter((n) => !priorNames.has(n)).length;
            const turnover = currentNames.size > 0 ? newPlayers / currentNames.size : 0;
            const existing = teamRosterTurnover.get(team) || 0;
            teamRosterTurnover.set(team, Math.max(existing, Math.round(turnover * 1000) / 1000));
          }

          // Prior season PPR by name + position (for quality-aware competition)
          const priorPPRByName = new Map<string, number>();
          const priorPosByName = new Map<string, string>();
          for (const p of priorTotals) {
            if (POSITIONS.includes(p.position)) {
              const name = normalizeName(p.player_display_name);
              priorPPRByName.set(name, p.fantasy_points_ppr || 0);
              priorPosByName.set(name, p.position);
            }
          }

          // Positional rankings from prior season (for top-12 detection)
          const posPriorRanks = new Map<string, Map<string, number>>(); // pos → name → rank
          for (const pos of POSITIONS) {
            const posPlayers = priorTotals
              .filter((p) => p.position === pos)
              .sort((a, b) => (b.fantasy_points_ppr || 0) - (a.fantasy_points_ppr || 0));
            const rankMap = new Map<string, number>();
            posPlayers.forEach((p, i) => rankMap.set(normalizeName(p.player_display_name), i + 1));
            posPriorRanks.set(pos, rankMap);
          }

          // Team-level PPR aggregations by position (from prior season, mapped to current team)
          // We need to know what each team's roster looks like NOW and how those players did LAST year
          interface TeamPosAgg {
            bestPPR: number;
            totalPPR: number;
            hasTop12: boolean;
            playerTargets: number[]; // for HHI calc
          }
          const teamPosAgg = new Map<string, TeamPosAgg>(); // "team:pos" → agg

          // Build team-pos aggregations using current roster + prior stats
          for (const [key, names] of rosterByTeamPos) {
            const [, pos] = key.split(':');
            const agg: TeamPosAgg = { bestPPR: 0, totalPPR: 0, hasTop12: false, playerTargets: [] };
            for (const name of names) {
              const ppr = priorPPRByName.get(name) || 0;
              if (ppr > agg.bestPPR) agg.bestPPR = ppr;
              agg.totalPPR += ppr;
              const rank = posPriorRanks.get(pos)?.get(name) || 999;
              if (rank <= 12) agg.hasTop12 = true;
              // Get targets for HHI
              const priorP = priorTotals.find((p) => normalizeName(p.player_display_name) === name && p.position === pos);
              if (priorP) agg.playerTargets.push(priorP.targets || 0);
            }
            teamPosAgg.set(key, agg);
          }

          // Team-level pass catcher aggregation (WR + TE combined PPR)
          const teamPassCatcherPPR = new Map<string, number>();
          const teamElitePassCatchers = new Map<string, number>(); // count of top-24 WR/TE
          for (const [key, names] of rosterByTeamPos) {
            const [pcTeam, pos] = key.split(':');
            if (pos !== 'WR' && pos !== 'TE') continue;
            for (const name of names) {
              const ppr = priorPPRByName.get(name) || 0;
              teamPassCatcherPPR.set(pcTeam, (teamPassCatcherPPR.get(pcTeam) || 0) + ppr);
              const rank = posPriorRanks.get(pos)?.get(name) || 999;
              if (rank <= 24) teamElitePassCatchers.set(pcTeam, (teamElitePassCatchers.get(pcTeam) || 0) + 1);
            }
          }

          // Target HHI (Herfindahl-Hirschman Index) per team — higher = more concentrated
          const teamTargetHHI = new Map<string, number>();
          for (const team of new Set([...teamTotalTargets.keys()])) {
            const totalTgts = teamTotalTargets.get(team) || 1;
            // Collect all player target shares on the team
            let hhi = 0;
            for (const p of priorTotals) {
              if ((p.recent_team || '') !== team || !POSITIONS.includes(p.position)) continue;
              const share = (p.targets || 0) / totalTgts;
              hhi += share * share;
            }
            teamTargetHHI.set(team, Math.round(hhi * 1000) / 1000);
          }

          // New arrival quality: for each team-pos, best PPR among new arrivals
          const newArrivalBestPPR = new Map<string, number>(); // "team:pos" → best PPR
          for (const [key, names] of rosterByTeamPos) {
            const priorNames = priorRosterByTeamPos.get(key);
            let best = 0;
            for (const name of names) {
              if (priorNames && priorNames.has(name)) continue; // not new
              const ppr = priorPPRByName.get(name) || 0;
              if (ppr > best) best = ppr;
            }
            newArrivalBestPPR.set(key, Math.round(best * 10) / 10);
          }

          // New arrival ADP: for each team-pos, best (lowest) ADP among new arrivals
          const adpByName = new Map<string, number>();
          for (const a of adpData) adpByName.set(normalizeName(a.name), a.adp);
          const newArrivalBestADP = new Map<string, number>(); // lower = better
          for (const [key, names] of rosterByTeamPos) {
            const priorNames = priorRosterByTeamPos.get(key);
            let bestAdp = 999;
            for (const name of names) {
              if (priorNames && priorNames.has(name)) continue;
              const adp2 = adpByName.get(name) || 999;
              if (adp2 < bestAdp) bestAdp = adp2;
            }
            newArrivalBestADP.set(key, bestAdp < 999 ? bestAdp : 0);
          }

          // Draft picks for this season (team drafted same position)
          const draftPicksBySeason = draftData.filter((d) => d.season === season);
          const teamDraftedPos = new Map<string, { count: number; bestPick: number }>();
          for (const d of draftPicksBySeason) {
            // Match draft position to fantasy positions
            const pos = d.position || '';
            if (!POSITIONS.includes(pos)) continue;
            const key = `${d.team}:${pos}`;
            const existing = teamDraftedPos.get(key) || { count: 0, bestPick: 300 };
            existing.count += 1;
            existing.bestPick = Math.min(existing.bestPick, d.pick || 300);
            teamDraftedPos.set(key, existing);
          }

          // ── Strength of Schedule ──
          // Compute opponent defensive quality from prior-season game data
          // For each team, average the defensive stats of their opponents
          const sosDefPPG = new Map<string, number>(); // team → avg fantasy pts allowed by opponents
          const sosAvgSpread = new Map<string, number>();
          {
            const teamOpponents = new Map<string, string[]>();
            for (const g of gamesData) {
              if (g.game_type !== 'REG' || g.season !== season) continue;
              if (!teamOpponents.has(g.home_team)) teamOpponents.set(g.home_team, []);
              if (!teamOpponents.has(g.away_team)) teamOpponents.set(g.away_team, []);
              teamOpponents.get(g.home_team)!.push(g.away_team);
              teamOpponents.get(g.away_team)!.push(g.home_team);
            }
            for (const [team, opps] of teamOpponents) {
              let totalPtsAllowed = 0, totalSpread = 0, count = 0;
              for (const opp of opps) {
                const v = vegasBySeasonTeam.get(`${season - 1}:${opp}`);
                if (v && v.games > 0) {
                  totalPtsAllowed += v.actualPts / v.games;
                  totalSpread += v.spread / v.games;
                  count++;
                }
              }
              if (count > 0) {
                sosDefPPG.set(team, Math.round((totalPtsAllowed / count) * 10) / 10);
                sosAvgSpread.set(team, Math.round((totalSpread / count) * 10) / 10);
              }
            }
          }

          // ── Coaching Scheme Clusters ──
          // Binary flags derived from existing scheme aggregations
          const schemeFlags = new Map<string, {
            passHeavy: number; runHeavy: number; uptempo: number;
            shotgunHeavy: number; rbReceiving: number; teHeavy: number;
          }>();
          for (const [team, scheme] of schemeByTeam) {
            if (scheme.plays === 0) continue;
            const passRate = scheme.passes / scheme.plays;
            const pace = scheme.plays / Math.max(1, scheme.games);
            const shotgunRate = scheme.shotgunPlays / scheme.plays;
            const rbTgtRate = scheme.totalTargets > 0 ? scheme.rbTargets / scheme.totalTargets : 0;
            const teTgtRate = scheme.totalTargets > 0 ? scheme.teTargets / scheme.totalTargets : 0;
            schemeFlags.set(team, {
              passHeavy: passRate > 0.58 ? 1 : 0,
              runHeavy: passRate < 0.48 ? 1 : 0,
              uptempo: pace > 67 ? 1 : 0,
              shotgunHeavy: shotgunRate > 0.70 ? 1 : 0,
              rbReceiving: rbTgtRate > 0.18 ? 1 : 0,
              teHeavy: teTgtRate > 0.22 ? 1 : 0,
            });
          }

          // ── Vegas Season-Level Props ──
          // Derived from game-level Vegas data: season win total and avg O/U
          const vegasSeasonProps = new Map<string, { winTotal: number; avgOU: number }>();
          for (const [key, v] of vegasBySeasonTeam) {
            const [szn, team] = key.split(':');
            if (Number(szn) !== season - 1 || v.games === 0) continue;
            vegasSeasonProps.set(team, {
              winTotal: Math.round(v.wins * 10) / 10,
              avgOU: v.gameTotal > 0 ? Math.round((v.gameTotal / v.games) * 10) / 10 : 0,
            });
          }

          // Join ADP with outcomes
          for (const adpPlayer of adpData) {
            if (!POSITIONS.includes(adpPlayer.position)) continue;
            if (adpPlayer.adp > 200) continue;

            const normalName = normalizeName(adpPlayer.name);
            const current = currentByName.get(normalName);
            if (!current || current.position !== adpPlayer.position) continue;

            // Target: PPG over expected-for-ADP-bin, z-scored per position later
            // Expected PPG comes from prior seasons' ADP-bin averages (no leakage)
            const playerPPG = getPPG(current);
            const adpBin = getADPBin(adpPlayer.adp);
            const expectedPPG = expectedPPGByBin.get(`${adpPlayer.position}:${adpBin}`) || 0;
            // For first training season (no prior data), use raw PPG
            const vor = expectedPPG > 0
              ? Math.round((playerPPG - expectedPPG) * 10) / 10
              : Math.round(playerPPG * 10) / 10;

            // Track raw PPG for future seasons' ADP-bin expectations
            rawPPGHistory.push({ position: adpPlayer.position, adp: adpPlayer.adp, ppg: playerPPG });

            const prior = priorByName.get(normalName);
            const combine = combineByName.get(normalName);
            const draft = draftByName.get(normalName);
            const snapAcc = snapAccum.get(normalName);
            const snapPct = snapAcc && snapAcc.count > 0 ? snapAcc.total / snapAcc.count : 0;

            const heightIn = combine?.ht ? parseHeight(combine.ht) : 0;
            const wt = combine?.wt || 0;
            const bmi = heightIn > 0 && wt > 0 ? (703 * wt) / (heightIn * heightIn) : 0;

            const priorGames = prior?.games || 0;
            const priorPPR = prior?.fantasy_points_ppr || 0;
            const priorAttempts = prior?.attempts || 0;
            const priorCarries = prior?.carries || 0;

            // Estimate age from draft data
            const draftAge = draft?.age || 0;
            const draftYear = draft?.season || 0;
            const age = draftAge > 0 && draftYear > 0 ? draftAge + (season - draftYear) : 0;

            // Advanced stats from weekly aggregation
            const adv = advByName.get(normalName);
            const advWeeks = adv?.weeks || 1;
            const avgTargetShare = adv ? adv.targetShare / advWeeks : 0;
            const avgAirYardsShare = adv ? adv.airYardsShare / advWeeks : 0;
            const avgWOPR = adv ? adv.wopr / advWeeks : 0;
            const avgRACR = adv && advWeeks > 0 ? adv.racr / advWeeks : 0;
            const yacPerRec = adv && adv.receptions > 0 ? adv.yac / adv.receptions : 0;
            const airYardsPerTarget = adv && adv.targets > 0 ? adv.recAirYards / adv.targets : 0;

            // PBP-derived
            const pbp = pbpByReceiver.get(normalName);
            const adot = pbp && pbp.targets > 0 ? pbp.totalAirYards / pbp.targets : 0;
            const deepPct = pbp && pbp.targets > 0 ? pbp.deepTargets / pbp.targets : 0;
            // RZ target share: player RZ targets / team RZ targets (need team lookup)
            const playerTeam = prior?.recent_team || '';
            const teamRZ = teamRZTargets.get(playerTeam) || 1;
            const rzTargetShare = pbp ? pbp.rzTargets / teamRZ : 0;

            // NGS lookups
            const ngsRec = ngsRecByName.get(normalName);
            const ngsRush = ngsRushByName.get(normalName);
            const ngsPass = ngsPassByName.get(normalName);

            const features: Record<string, number> = {
              adp: adpPlayer.adp,
              adpRound: Math.ceil(adpPlayer.adp / 12),
              age,
              yearsInLeague: draft ? season - draft.season : 0,
              nflDraftRound: draft?.round || 8,
              nflDraftPick: draft?.pick || 300,
              weight: wt,
              forty: combine?.forty || 0,
              bmi: Math.round(bmi * 10) / 10,
              priorPassYards: prior?.passing_yards || 0,
              priorPassTDs: prior?.passing_tds || 0,
              priorINTs: prior?.interceptions || 0,
              priorPassYPA: priorAttempts > 0 ? Math.round((prior?.passing_yards || 0) / priorAttempts * 10) / 10 : 0,
              priorQBRating: 0,
              priorRushYards: prior?.rushing_yards || 0,
              priorRushTDs: prior?.rushing_tds || 0,
              priorYPC: priorCarries > 0 ? Math.round((prior?.rushing_yards || 0) / priorCarries * 10) / 10 : 0,
              priorCarries: priorCarries,
              priorTargets: prior?.targets || 0,
              priorReceptions: prior?.receptions || 0,
              priorRecYards: prior?.receiving_yards || 0,
              priorRecTDs: prior?.receiving_tds || 0,
              priorYPR: (prior?.receptions || 0) > 0
                ? Math.round((prior?.receiving_yards || 0) / (prior?.receptions || 1) * 10) / 10
                : 0,

              // Advanced weekly stats
              priorTargetShare: Math.round(avgTargetShare * 1000) / 1000,
              priorAirYardsShare: Math.round(avgAirYardsShare * 1000) / 1000,
              priorWOPR: Math.round(avgWOPR * 1000) / 1000,
              priorRACR: Math.round(avgRACR * 100) / 100,
              priorYACperRec: Math.round(yacPerRec * 10) / 10,
              priorAirYardsPerTarget: Math.round(airYardsPerTarget * 10) / 10,
              priorRecEPA: Math.round((adv?.recEPA || 0) * 10) / 10,
              priorRushEPA: Math.round((adv?.rushEPA || 0) * 10) / 10,

              // PBP-derived
              priorADOT: Math.round(adot * 10) / 10,
              priorDeepTargetPct: Math.round(deepPct * 1000) / 1000,
              priorRZTargetShare: Math.round(rzTargetShare * 1000) / 1000,

              // Next Gen Stats — receiving
              priorSeparation: ngsRec?.avg_separation || 0,
              priorCushion: ngsRec?.avg_cushion || 0,
              priorYACAboveExp: ngsRec?.avg_yac_above_expectation || 0,
              priorCatchPct: ngsRec?.catch_percentage || 0,
              priorIntendedAirYardShare: ngsRec?.percent_share_of_intended_air_yards || 0,

              // Next Gen Stats — rushing
              priorRYOEperAtt: ngsRush?.rush_yards_over_expected_per_att || 0,
              priorRushEfficiency: ngsRush?.efficiency || 0,
              priorPctVs8Defenders: ngsRush?.percent_attempts_gte_eight_defenders || 0,

              // Next Gen Stats — passing
              priorCPOE: ngsPass?.completion_percentage_above_expectation || 0,
              priorTimeToThrow: ngsPass?.avg_time_to_throw || 0,
              priorAggressiveness: ngsPass?.aggressiveness || 0,

              // Participation-derived: YPRR, routes, personnel
              priorYPRR: (() => {
                const rt = routesByName.get(normalName);
                return rt && rt.routesRun > 0
                  ? Math.round(((prior?.receiving_yards || 0) / rt.routesRun) * 100) / 100
                  : 0;
              })(),
              priorRoutesRun: routesByName.get(normalName)?.routesRun || 0,
              priorTargetsPerRoute: (() => {
                const rt = routesByName.get(normalName);
                return rt && rt.routesRun > 0
                  ? Math.round(((prior?.targets || 0) / rt.routesRun) * 1000) / 1000
                  : 0;
              })(),
              priorPct11Personnel: (() => {
                const rt = routesByName.get(normalName);
                return rt && rt.totalSnaps > 0
                  ? Math.round((rt.snaps11 / rt.totalSnaps) * 1000) / 1000
                  : 0;
              })(),
              priorPct12Personnel: (() => {
                const rt = routesByName.get(normalName);
                return rt && rt.totalSnaps > 0
                  ? Math.round((rt.snaps12 / rt.totalSnaps) * 1000) / 1000
                  : 0;
              })(),
              priorPassLocationLeft: (() => {
                const loc = locByReceiver.get(normalName);
                return loc && loc.total > 0 ? Math.round((loc.left / loc.total) * 1000) / 1000 : 0;
              })(),
              priorPassLocationMiddle: (() => {
                const loc = locByReceiver.get(normalName);
                return loc && loc.total > 0 ? Math.round((loc.middle / loc.total) * 1000) / 1000 : 0;
              })(),

              // Fantasy totals
              priorPPR: Math.round(priorPPR * 10) / 10,
              priorPPG: priorGames > 0 ? Math.round(priorPPR / priorGames * 10) / 10 : 0,
              priorGames,
              priorGamesMissed: prior ? Math.max(0, 17 - priorGames) : 0,
              priorTotalTouches: priorCarries + (prior?.receptions || 0),
              priorSnapPct: Math.round(snapPct * 10) / 10,

              // Injury features
              priorInjuryWeeks: priorInjByName.get(normalName)?.weeks || 0,
              priorGamesOut: priorInjByName.get(normalName)?.gamesOut || 0,
              preseasonInjured: preseasonInjByName.get(normalName)?.injured ? 1 : 0,
              preseasonInjWeeks: preseasonInjByName.get(normalName)?.weeks || 0,
              priorSoftTissue: priorInjByName.get(normalName)?.softTissue ? 1 : 0,
              priorKneeInjury: priorInjByName.get(normalName)?.knee ? 1 : 0,

              // Roster competition features
              ...(() => {
                const playerTeam2 = playerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
                const posKey = `${playerTeam2}:${adpPlayer.position}`;
                const teammates = rosterByTeamPos.get(posKey);
                const samePosCount = teammates ? teammates.size - (teammates.has(normalName) ? 1 : 0) : 0;
                const priorTeammates = priorRosterByTeamPos.get(posKey);
                const newArrivals = teammates && priorTeammates
                  ? [...teammates].filter((n) => n !== normalName && !priorTeammates.has(n)).length
                  : 0;
                const draftedInfo = teamDraftedPos.get(posKey);
                const priorTeamCarries = teamTotalCarries.get(playerTeam2) || 1;
                const priorTeamTargets2 = teamTotalTargets.get(playerTeam2) || 1;
                const playerTouchShare = adpPlayer.position === 'RB'
                  ? (prior?.carries || 0) / priorTeamCarries
                  : (prior?.targets || 0) / priorTeamTargets2;
                const playerTargetShareTeam = (prior?.targets || 0) / priorTeamTargets2;

                // Best same-pos teammate PPR (excluding self)
                let bestTeammatePPR = 0;
                if (teammates) {
                  for (const tmName of teammates) {
                    if (tmName === normalName) continue;
                    const tmPPR = priorPPRByName.get(tmName) || 0;
                    if (tmPPR > bestTeammatePPR) bestTeammatePPR = tmPPR;
                  }
                }

                return {
                  teamSamePosCount: samePosCount,
                  depthChartRank: depthRankByName.get(normalName) || 99,
                  priorTeamTouchShare: Math.round(playerTouchShare * 1000) / 1000,
                  priorTeamTargetShare: Math.round(playerTargetShareTeam * 1000) / 1000,
                  newSamePosAdded: newArrivals,
                  teamDraftedSamePos: draftedInfo ? draftedInfo.count : 0,
                  draftCapitalSamePos: draftedInfo ? Math.max(0, 8 - Math.ceil(draftedInfo.bestPick / 32)) : 0,
                  teammatePriorPPR: Math.round(bestTeammatePPR * 10) / 10,

                  // Quality-aware cross-position competition
                  teamWRElitePPR: Math.round((teamPosAgg.get(`${playerTeam2}:WR`)?.bestPPR || 0) * 10) / 10,
                  teamWRTop12: (teamPosAgg.get(`${playerTeam2}:WR`)?.hasTop12 || false) ? 1 : 0,
                  teamWRTotalPPR: Math.round((teamPosAgg.get(`${playerTeam2}:WR`)?.totalPPR || 0) * 10) / 10,
                  teamTEElitePPR: Math.round((teamPosAgg.get(`${playerTeam2}:TE`)?.bestPPR || 0) * 10) / 10,
                  teamRBElitePPR: Math.round((teamPosAgg.get(`${playerTeam2}:RB`)?.bestPPR || 0) * 10) / 10,
                  teamRBTop12: (teamPosAgg.get(`${playerTeam2}:RB`)?.hasTop12 || false) ? 1 : 0,
                  teamPassCatcherPPR: Math.round((teamPassCatcherPPR.get(playerTeam2) || 0) * 10) / 10,
                  teamElitePassCatchers: teamElitePassCatchers.get(playerTeam2) || 0,
                  teamTargetHHI: teamTargetHHI.get(playerTeam2) || 0,
                  newArrivalBestPPR: newArrivalBestPPR.get(posKey) || 0,
                  newArrivalBestADP: newArrivalBestADP.get(posKey) || 0,
                };
              })(),

              // Coaching & scheme features
              ...(() => {
                const pTeam = playerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
                const scheme = schemeByTeam.get(pTeam);
                const totalPlays = scheme?.plays || 1;
                const totalGames = scheme?.games || 1;
                return {
                  newHeadCoach: coachChangeTeams.has(pTeam) ? 1 : 0,
                  coachPriorTeamPPR: Math.round((coachPriorTeamPPR.get(pTeam) || 0) * 10) / 10,
                  teamPassRate: scheme ? Math.round((scheme.passes / totalPlays) * 1000) / 1000 : 0,
                  teamNeutralPassRate: scheme && scheme.neutralPlays > 0
                    ? Math.round((scheme.neutralPasses / scheme.neutralPlays) * 1000) / 1000 : 0,
                  teamPace: scheme ? Math.round((totalPlays / totalGames) * 10) / 10 : 0,
                  teamFirstDownRunRate: scheme && scheme.firstDownPlays > 0
                    ? Math.round((scheme.firstDownRuns / scheme.firstDownPlays) * 1000) / 1000 : 0,
                  teamShotgunRate: scheme ? Math.round((scheme.shotgunPlays / totalPlays) * 1000) / 1000 : 0,
                  teamNoHuddleRate: scheme ? Math.round((scheme.noHuddlePlays / totalPlays) * 1000) / 1000 : 0,
                  teamRBTargetRate: scheme && scheme.totalTargets > 0
                    ? Math.round((scheme.rbTargets / scheme.totalTargets) * 1000) / 1000 : 0,
                };
              })(),

              // Personnel & positional usage features
              ...(() => {
                const pTeam2 = playerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
                const pers = personnelByTeam.get(pTeam2);
                const persTotal = pers?.total || 1;
                const sch = schemeByTeam.get(pTeam2);
                const schGames = sch?.games || 1;
                const schTotalTgts = sch?.totalTargets || 1;
                return {
                  team11Rate: pers ? Math.round((pers.p11 / persTotal) * 1000) / 1000 : 0,
                  team12Rate: pers ? Math.round((pers.p12 / persTotal) * 1000) / 1000 : 0,
                  team13Rate: pers ? Math.round((pers.p13 / persTotal) * 1000) / 1000 : 0,
                  team21Rate: pers ? Math.round((pers.p21 / persTotal) * 1000) / 1000 : 0,
                  team22Rate: pers ? Math.round((pers.p22 / persTotal) * 1000) / 1000 : 0,
                  team10Rate: pers ? Math.round((pers.p10 / persTotal) * 1000) / 1000 : 0,
                  teamTETargetRate: sch ? Math.round((sch.teTargets / schTotalTgts) * 1000) / 1000 : 0,
                  teamWRTargetRate: sch ? Math.round((sch.wrTargets / schTotalTgts) * 1000) / 1000 : 0,
                  teamTETargetsPerGame: sch ? Math.round((sch.teTargets / schGames) * 10) / 10 : 0,
                  teamRBTargetsPerGame: sch ? Math.round((sch.rbTargets / schGames) * 10) / 10 : 0,
                  teamWR3PlusOnField: pers ? Math.round((pers.wr3plus / persTotal) * 1000) / 1000 : 0,
                  team2PlusTEOnField: pers ? Math.round((pers.te2plus / persTotal) * 1000) / 1000 : 0,
                };
              })(),

              // Vegas / implied totals (use prior season lines for the team)
              ...(() => {
                const vTeam = playerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
                // Use prior season Vegas data (same as other "prior" features)
                const vKey = `${season - 1}:${vTeam}`;
                const v = vegasBySeasonTeam.get(vKey);
                const vGames = v?.games || 1;
                return {
                  vegasImpliedTotal: v ? Math.round((v.impliedTotal / vGames) * 10) / 10 : 0,
                  vegasImpliedSpread: v ? Math.round((v.spread / vGames) * 10) / 10 : 0,
                  vegasGameTotal: v ? Math.round((v.gameTotal / vGames) * 10) / 10 : 0,
                  vegasWinPct: v ? Math.round((v.wins / vGames) * 1000) / 1000 : 0,
                  vegasActualPtsPerGame: v ? Math.round((v.actualPts / vGames) * 10) / 10 : 0,
                };
              })(),

              // ── Projection model features ──
              ...(() => {
                const pf = projFeatures.get(normalName);
                return {
                  projTeamPassAtt:      pf?.projTeamPassAtt      ?? 0,
                  projTeamPassVolChg:   pf?.projTeamPassVolChg    ?? 0,
                  projPlayerPPR:        pf?.projPlayerPPR         ?? 0,
                  projPlayerVsExpected: pf?.projPlayerVsExpected  ?? 0,
                  projTargetShare:      pf?.projTargetShare        ?? 0,
                };
              })(),

              // Reddit sentiment features
              ...(() => {
                const rKey = `${normalName}:${season}`;
                const buzz = redditBuzz.get(rKey);
                const win = redditWindowed.get(rKey);
                return {
                  redditMentions1w: win?.mentions_1w || 0,
                  redditSentiment1w: win?.sentiment_1w || 0,
                  redditHype1w: win?.hype_1w || 0,
                  redditMentions4w: win?.mentions_4w || buzz?.mentions || 0,
                  redditSentiment4w: win?.sentiment_4w || buzz?.sentiment || 0,
                  redditMentionVelocity: win?.mention_velocity || 0,
                  redditSentimentVelocity: win?.sentiment_velocity || 0,
                };
              })(),

              // Strength of Schedule features
              ...(() => {
                const pTeam = playerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
                return {
                  sosDefPassYdg: sosDefPPG.get(pTeam) || 0, // reusing PPG as proxy for pass defense
                  sosDefRushYdg: 0, // would need rushing defense data
                  sosDefPPG: sosDefPPG.get(pTeam) || 0,
                  sosAvgSpread: sosAvgSpread.get(pTeam) || 0,
                };
              })(),

              // Coaching scheme cluster flags
              ...(() => {
                const pTeam = playerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
                const sf = schemeFlags.get(pTeam);
                return {
                  schemePassHeavy: sf?.passHeavy || 0,
                  schemeRunHeavy: sf?.runHeavy || 0,
                  schemeUptempo: sf?.uptempo || 0,
                  schemeShotgunHeavy: sf?.shotgunHeavy || 0,
                  schemeRBReceiving: sf?.rbReceiving || 0,
                  schemeTEHeavy: sf?.teHeavy || 0,
                };
              })(),

              // Vegas season-level props
              ...(() => {
                const pTeam = playerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
                const vp = vegasSeasonProps.get(pTeam);
                return {
                  vegasSeasonWinTotal: vp?.winTotal || 0,
                  vegasSeasonOverUnder: vp?.avgOU || 0,
                };
              })(),

              // College production (most impactful for rookies/young players)
              ...(() => {
                const cs = collegeByName.get(normalName);
                return {
                  collegePassYds: cs?.get('Passing Yards') || 0,
                  collegePassTDs: cs?.get('Passing Touchdowns') || 0,
                  collegeRushYds: cs?.get('Rushing Yards') || 0,
                  collegeRecYds: cs?.get('Receiving Yards') || 0,
                  collegeRecTDs: cs?.get('Receiving Touchdowns') || 0,
                  collegeTotalTDs: (cs?.get('Passing Touchdowns') || 0) + (cs?.get('Rushing Touchdowns') || 0) + (cs?.get('Receiving Touchdowns') || 0),
                  collegeQBR: collegeQBRByName.get(normalName) || 0,
                };
              })(),

              // Contract data
              ...(() => {
                const c = contractByName.get(normalName);
                const yearsRem = c ? Math.max(0, c.years - (season - c.year_signed)) : 0;
                return {
                  contractAPY: c ? Math.round(c.apy / 1_000_000 * 10) / 10 : 0,
                  contractGuaranteed: c ? Math.round(c.guaranteed / 1_000_000 * 10) / 10 : 0,
                  contractAPYCapPct: c ? Math.round(c.apy_cap_pct * 100) / 100 : 0,
                  contractYearsRemaining: yearsRem,
                };
              })(),

              // Aging curves
              ...(() => {
                const draftAge2 = draft?.age || 0;
                const draftYear2 = draft?.season || 0;
                const playerAge = draftAge2 > 0 && draftYear2 > 0 ? draftAge2 + (season - draftYear2) : 0;
                const curve = AGING_CURVES[adpPlayer.position];
                if (!curve || playerAge === 0) return { ageCurveDelta: 0, isPeakAge: 0, isDeclineAge: 0 };
                const isPeak = playerAge >= curve.peakStart && playerAge <= curve.peakEnd ? 1 : 0;
                const isDecline = playerAge >= curve.declineStart ? 1 : 0;
                // Simple linear aging delta: positive during peak, negative during decline
                const delta = isPeak ? 0.5 : isDecline ? -0.3 * (playerAge - curve.declineStart + 1) : 0;
                return {
                  ageCurveDelta: Math.round(delta * 100) / 100,
                  isPeakAge: isPeak,
                  isDeclineAge: isDecline,
                };
              })(),

              // Momentum features (2-year trends)
              ...(() => {
                const hist = playerHistoryMap.get(normalName) || [];
                const sorted = hist.sort((a, b) => b.season - a.season);
                const curr = sorted.find((h) => h.season === season - 1);
                const prev = sorted.find((h) => h.season === season - 2);
                if (!curr || !prev) return {
                  ppgTrend: 0, targetTrend: 0, touchTrend: 0,
                  adpTrend: 0, snapPctTrend: 0, targetShareTrend: 0,
                };
                return {
                  ppgTrend: Math.round((curr.ppg - prev.ppg) * 10) / 10,
                  targetTrend: curr.targets - prev.targets,
                  touchTrend: curr.touches - prev.touches,
                  adpTrend: prev.adp > 0 && curr.adp > 0 ? Math.round((prev.adp - curr.adp) * 10) / 10 : 0, // positive = rising
                  snapPctTrend: Math.round((curr.snapPct - prev.snapPct) * 10) / 10,
                  targetShareTrend: Math.round((curr.targetShare - prev.targetShare) * 1000) / 1000,
                };
              })(),

              // Interaction features
              ...(() => {
                const a = adpPlayer.adp;
                const draftAge = draft?.age || 0;
                const draftYear = draft?.season || 0;
                const playerAge = draftAge > 0 && draftYear > 0 ? draftAge + (season - draftYear) : 25;
                const yil = draft ? season - draft.season : 0;
                const pTeam = playerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
                const scheme = schemeByTeam.get(pTeam);
                const passRate = scheme && scheme.plays > 0 ? scheme.passes / scheme.plays : 0.5;
                const shotgunRate = scheme && scheme.plays > 0 ? scheme.shotgunPlays / scheme.plays : 0.5;
                const priorGames = prior?.games || 0;
                const priorPPGVal = priorGames > 0 ? (prior?.fantasy_points_ppr || 0) / priorGames : 0;
                const snapPctVal = snapAcc && snapAcc.count > 0 ? snapAcc.total / snapAcc.count : 0;
                const contract = contractByName.get(normalName);
                const cAPY = contract ? contract.apy / 1_000_000 : 0;
                const cYearsRem = contract ? Math.max(0, contract.years - (season - contract.year_signed)) : 0;
                const depthRank = depthRankByName.get(normalName) || 99;
                const adv = advByName.get(normalName);
                const advWeeks = adv?.weeks || 1;
                const avgTgtShare = adv ? adv.targetShare / advWeeks : 0;
                const curve = AGING_CURVES[adpPlayer.position];
                const isDecline2 = curve && playerAge >= curve.declineStart ? 1 : 0;

                return {
                  adpXage: Math.round(a * playerAge / 100) / 10,
                  adpXyearsInLeague: Math.round(a * yil) / 10,
                  contractXdepthRank: Math.round(cAPY * depthRank * 10) / 10,
                  priorPPGXage: Math.round(priorPPGVal * playerAge * 10) / 10,
                  adpXteamPassRate: Math.round(a * passRate * 10) / 10,
                  adpXschemeShotgun: Math.round(a * shotgunRate * 10) / 10,
                  priorPPGXsnapPct: Math.round(priorPPGVal * snapPctVal * 10) / 10,
                  ageXcontractYears: Math.round(playerAge * cYearsRem * 10) / 10,
                  targetShareXteamPassRate: Math.round(avgTgtShare * passRate * 1000) / 1000,
                  rushAttXageDecline: Math.round((prior?.carries || 0) * isDecline2),
                };
              })(),

              // QB Impact: current QB's own tendencies (follows player across teams)
              ...(() => {
                const pTeam = playerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
                const qbs = teamQBStats.get(pTeam);
                const tpq = teamPriorQBStats.get(pTeam);
                return {
                  qbOwnRushAtt: qbs?.rushAtt || 0,
                  qbOwnRushYds: qbs?.rushYds || 0,
                  qbOwnRushTDs: qbs?.rushTDs || 0,
                  qbOwnRushShare: Math.round((qbs?.rushShare || 0) * 1000) / 1000,
                  qbOwnScrambleRate: qbs?.scrambleRate || 0,
                  qbOwnPPG: qbs?.ppg || 0,
                  // Team's prior QB rushing tendency (coaching scheme signal)
                  teamPriorQBRushAtt: tpq?.rushAtt || 0,
                  teamPriorQBRushShare: Math.round((tpq?.rushShare || 0) * 1000) / 1000,
                  teamPriorQBScrambleRate: tpq?.scrambleRate || 0,
                };
              })(),

              // Consistency features
              ...(() => {
                const wc = weeklyConsistency.get(normalName);
                return {
                  priorPPGStdDev: wc?.stdDev || 0,
                  priorBoomRate: wc?.boomRate || 0,
                  priorBustGameRate: wc?.bustGameRate || 0,
                };
              })(),

              // Environment features
              ...(() => {
                const pTeam = playerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
                return {
                  teamDomeGames: teamDomeGames.get(pTeam) || 0,
                  byeWeek: teamByeWeek.get(pTeam) || 0,
                  teamSackRate: teamSackRate.get(pTeam) || 0,
                  teamRushYPC: teamRushYPC.get(pTeam) || 0,
                  teamQBPassRating: teamQBPassRating.get(pTeam) || 0,
                  injuryRecurrence: injuryRecurrence.get(normalName) || 0,
                  teamRosterTurnover: teamRosterTurnover.get(pTeam) || 0,
                };
              })(),
            };

            rows.push({
              name: adpPlayer.name,
              position: adpPlayer.position,
              season,
              adp: adpPlayer.adp,
              vor,
              isHit: vor >= 0,   // outscored ADP-bin expected PPG
              isBust: vor < -3,  // 3+ PPG below ADP-bin expected (significant bust)
              features,
            });
          }
        }

        // ── Standardize VOR per position (z-score) ───────────────────────────
        // Raw PPR-based VOR varies in scale across positions (QBs score far
        // more than TEs in absolute terms). Standardising to z-scores makes
        // the metric directly comparable across positions: +1.0 means 1 std
        // above the mean for *that* position, regardless of which position.
        const vorNorm = new Map<string, { mean: number; std: number }>();
        for (const pos of POSITIONS) {
          const vals = rows.filter((r) => r.position === pos).map((r) => r.vor);
          if (vals.length < 4) continue;
          const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
          const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
          const std = Math.sqrt(variance) || 1;
          vorNorm.set(pos, { mean, std });
          for (const row of rows) {
            if (row.position === pos) {
              row.vor = Math.round((row.vor - mean) / std * 100) / 100;
            }
          }
        }

        

        // ── Build 2026 prediction rows ──
        onStatus?.(`Building ${predictSeason} prediction features...`);
        const predRows: PredictionRow[] = [];
        {
          const predSeason = predictSeason;
          const priorSeason = predSeason - 1;

          const [
            predAdpData, predPriorStats, predPriorSnaps,
            predPriorInjuries, predPreseasonInjuries,
            predPriorNgsRec, predPriorNgsRush, predPriorNgsPass,
            predPriorPbp, predPriorParticipation,
            predSeasonRosters, predPriorRosters, predSeasonDepthCharts,
          ] = await Promise.all([
            fetchFfcADP(predSeason, 'ppr', 12).catch(() => []),
            fetchPlayerStats(priorSeason).catch(() => []),
            fetchSnapCounts(priorSeason).catch(() => []),
            fetchInjuries(priorSeason).catch(() => []),
            fetchInjuries(predSeason).catch(() => []),
            fetchNextGenStats(priorSeason, 'receiving').catch(() => [] as NextGenStats[]),
            fetchNextGenStats(priorSeason, 'rushing').catch(() => [] as NextGenStats[]),
            fetchNextGenStats(priorSeason, 'passing').catch(() => [] as NextGenStats[]),
            fetchPlayByPlay(priorSeason).catch(() => [] as PlayByPlay[]),
            fetchPbpParticipation(priorSeason).catch(() => [] as PbpParticipation[]),
            fetchRosters(predSeason).catch(() => [] as Roster[]),
            fetchRosters(priorSeason).catch(() => [] as Roster[]),
            fetchDepthCharts(predSeason).catch(() => [] as DepthChart[]),
          ]);
          

          if (predAdpData.length > 0) {
            // Prior season totals
            const predPriorTotals = aggregateToSeasonTotals(
              predPriorStats.filter((s) => s.season_type === 'REG')
            );
            const predPriorByName = new Map<string, SeasonTotals>();
            for (const p of predPriorTotals) {
              if (POSITIONS.includes(p.position)) {
                predPriorByName.set(normalizeName(p.player_display_name), p);
              }
            }

            // ── Projection features for prediction season (scenario adjustments applied here) ──
            const predProjFeatures = computePlayerProjectionFeatures(predPriorStats, scenario);

            // Snap %
            const predSnapAccum = new Map<string, { total: number; count: number }>();
            for (const s of predPriorSnaps) {
              if (!POSITIONS.includes(s.position)) continue;
              const name = normalizeName(s.player);
              const acc = predSnapAccum.get(name) || { total: 0, count: 0 };
              acc.total += s.offense_pct || 0;
              acc.count += 1;
              predSnapAccum.set(name, acc);
            }

            // Advanced weekly stats
            interface PredAdvAgg {
              targetShare: number; airYardsShare: number; wopr: number;
              racr: number; recAirYards: number; yac: number;
              receptions: number; targets: number;
              recEPA: number; rushEPA: number;
              weeks: number;
            }
            const predAdvByName = new Map<string, PredAdvAgg>();
            const predPriorWeekly = predPriorStats.filter((s) => s.season_type === 'REG') as PlayerStats[];
            for (const w of predPriorWeekly) {
              if (!POSITIONS.includes(w.position)) continue;
              const name = normalizeName(w.player_display_name);
              const acc = predAdvByName.get(name) || {
                targetShare: 0, airYardsShare: 0, wopr: 0, racr: 0,
                recAirYards: 0, yac: 0, receptions: 0, targets: 0,
                recEPA: 0, rushEPA: 0, weeks: 0,
              };
              acc.targetShare += w.target_share || 0;
              acc.airYardsShare += w.air_yards_share || 0;
              acc.wopr += w.wopr || 0;
              acc.recAirYards += w.receiving_air_yards || 0;
              acc.yac += w.receiving_yards_after_catch || 0;
              acc.receptions += w.receptions || 0;
              acc.targets += w.targets || 0;
              acc.recEPA += w.receiving_epa || 0;
              acc.rushEPA += w.rushing_epa || 0;
              if (w.racr && w.racr > 0) acc.racr += w.racr;
              acc.weeks += 1;
              predAdvByName.set(name, acc);
            }

            // NGS season-level
            const predNgsRecByName = new Map<string, NextGenStats>();
            for (const n of predPriorNgsRec) {
              if (n.week === 0 && n.season_type === 'REG') predNgsRecByName.set(normalizeName(n.player_display_name), n);
            }
            const predNgsRushByName = new Map<string, NextGenStats>();
            for (const n of predPriorNgsRush) {
              if (n.week === 0 && n.season_type === 'REG') predNgsRushByName.set(normalizeName(n.player_display_name), n);
            }
            const predNgsPassByName = new Map<string, NextGenStats>();
            for (const n of predPriorNgsPass) {
              if (n.week === 0 && n.season_type === 'REG') predNgsPassByName.set(normalizeName(n.player_display_name), n);
            }

            // PBP-derived
            interface PredPbpAgg {
              totalAirYards: number; targets: number; deepTargets: number; rzTargets: number;
            }
            const predPbpByReceiver = new Map<string, PredPbpAgg>();
            const predTeamRZTargets = new Map<string, number>();
            for (const play of predPriorPbp) {
              if (play.play_type !== 'pass' || !play.receiver_player_name) continue;
              const recName = normalizeName(play.receiver_player_name);
              const acc = predPbpByReceiver.get(recName) || { totalAirYards: 0, targets: 0, deepTargets: 0, rzTargets: 0 };
              acc.targets += 1;
              if (typeof play.air_yards === 'number' && !isNaN(play.air_yards)) {
                acc.totalAirYards += play.air_yards;
                if (play.air_yards >= 15) acc.deepTargets += 1;
              }
              if (play.yardline_100 <= 20) {
                acc.rzTargets += 1;
                const team = play.posteam || '';
                predTeamRZTargets.set(team, (predTeamRZTargets.get(team) || 0) + 1);
              }
              predPbpByReceiver.set(recName, acc);
            }

            // Participation-derived
            const predGsisToName = new Map<string, string>();
            for (const w of predPriorWeekly) {
              if (w.player_id && w.player_display_name) predGsisToName.set(w.player_id, normalizeName(w.player_display_name));
            }
            interface PredRouteAgg { routesRun: number; snaps11: number; snaps12: number; totalSnaps: number }
            const predRoutesByName = new Map<string, PredRouteAgg>();
            const predPassPlayKeys = new Set<string>();
            for (const play of predPriorPbp) {
              if (play.qb_dropback === 1 || play.play_type === 'pass') predPassPlayKeys.add(`${play.game_id}:${play.play_id}`);
            }
            for (const part of predPriorParticipation) {
              if (!part.offense_players) continue;
              const gamePlayKey = `${part.nflverse_game_id}:${part.play_id}`;
              const altKey = `${part.old_game_id}:${part.play_id}`;
              const isPassPlay = predPassPlayKeys.has(gamePlayKey) || predPassPlayKeys.has(altKey);
              const personnel = (() => {
                const p = part.offense_personnel || '';
                const rbMatch = p.match(/(\d+)\s*RB/i);
                const teMatch = p.match(/(\d+)\s*TE/i);
                return `${rbMatch ? rbMatch[1] : '0'}${teMatch ? teMatch[1] : '0'}`;
              })();
              const offenseIds = part.offense_players.split(';');
              for (const gsisId of offenseIds) {
                const id = gsisId.trim();
                const name = predGsisToName.get(id);
                if (!name) continue;
                const acc = predRoutesByName.get(name) || { routesRun: 0, snaps11: 0, snaps12: 0, totalSnaps: 0 };
                acc.totalSnaps += 1;
                if (isPassPlay) acc.routesRun += 1;
                if (personnel === '11') acc.snaps11 += 1;
                else if (personnel === '12') acc.snaps12 += 1;
                predRoutesByName.set(name, acc);
              }
            }

            // Pass location
            interface PredLocAgg { left: number; middle: number; right: number; total: number }
            const predLocByReceiver = new Map<string, PredLocAgg>();
            for (const play of predPriorPbp) {
              if (play.play_type !== 'pass' || !play.receiver_player_name || !play.pass_location) continue;
              const recName = normalizeName(play.receiver_player_name);
              const acc = predLocByReceiver.get(recName) || { left: 0, middle: 0, right: 0, total: 0 };
              acc.total += 1;
              if (play.pass_location === 'left') acc.left += 1;
              else if (play.pass_location === 'middle') acc.middle += 1;
              else if (play.pass_location === 'right') acc.right += 1;
              predLocByReceiver.set(recName, acc);
            }

            // Injury
            const SOFT_TISSUE_PRED = /hamstring|groin|calf|quad|hip|thigh|achilles|ankle|foot|toe/i;
            const KNEE_PRED = /knee|acl|mcl|pcl|meniscus/i;
            interface PredInjAgg { weeks: number; gamesOut: number; softTissue: boolean; knee: boolean }
            const predPriorInjByName = new Map<string, PredInjAgg>();
            for (const inj of predPriorInjuries) {
              if (!POSITIONS.includes(inj.position)) continue;
              const name = normalizeName(inj.full_name);
              const acc = predPriorInjByName.get(name) || { weeks: 0, gamesOut: 0, softTissue: false, knee: false };
              acc.weeks += 1;
              if (inj.report_status === 'Out' || inj.report_status === 'Doubtful') acc.gamesOut += 1;
              const allInjText = `${inj.report_primary_injury || ''} ${inj.report_secondary_injury || ''} ${inj.practice_primary_injury || ''} ${inj.practice_secondary_injury || ''}`;
              if (SOFT_TISSUE_PRED.test(allInjText)) acc.softTissue = true;
              if (KNEE_PRED.test(allInjText)) acc.knee = true;
              predPriorInjByName.set(name, acc);
            }
            const predPreseasonInjByName = new Map<string, { injured: boolean; weeks: number }>();
            for (const inj of predPreseasonInjuries) {
              if (!POSITIONS.includes(inj.position)) continue;
              const isPre = inj.game_type === 'PRE' || inj.week <= 0;
              if (!isPre) continue;
              const name = normalizeName(inj.full_name);
              const acc = predPreseasonInjByName.get(name) || { injured: false, weeks: 0 };
              acc.weeks += 1;
              if (inj.report_status === 'Out' || inj.report_status === 'Doubtful' || inj.report_status === 'Questionable') acc.injured = true;
              predPreseasonInjByName.set(name, acc);
            }

            // ── Roster competition for predictions ──
            const predRosterByTeamPos = new Map<string, Set<string>>();
            const predPlayerTeamMap = new Map<string, string>();
            const predHeadshotByName = new Map<string, string>(); // normalised name → headshot URL
            for (const r of predSeasonRosters) {
              if (!POSITIONS.includes(r.position) || r.status === 'Inactive') continue;
              const key = `${r.team}:${r.position}`;
              if (!predRosterByTeamPos.has(key)) predRosterByTeamPos.set(key, new Set());
              const name = normalizeName(r.full_name);
              predRosterByTeamPos.get(key)!.add(name);
              predPlayerTeamMap.set(name, r.team);
              if (r.headshot_url) predHeadshotByName.set(name, r.headshot_url);
            }
            const predPriorRosterByTeamPos = new Map<string, Set<string>>();
            for (const r of predPriorRosters) {
              if (!POSITIONS.includes(r.position)) continue;
              const key = `${r.team}:${r.position}`;
              if (!predPriorRosterByTeamPos.has(key)) predPriorRosterByTeamPos.set(key, new Set());
              predPriorRosterByTeamPos.get(key)!.add(normalizeName(r.full_name));
            }
            const predDepthRankByName = new Map<string, number>();
            const predDcLatest = new Map<string, DepthChart>();
            for (const dc of predSeasonDepthCharts) {
              const name = normalizeName(dc.player_name);
              const key = `${dc.team}:${dc.pos_abb}:${name}`;
              const existing = predDcLatest.get(key);
              if (!existing || dc.dt > existing.dt) predDcLatest.set(key, dc);
            }
            for (const dc of predDcLatest.values()) {
              predDepthRankByName.set(normalizeName(dc.player_name), dc.pos_rank || dc.pos_slot || 99);
            }
            const predTeamTotalCarries = new Map<string, number>();
            const predTeamTotalTargets = new Map<string, number>();
            const predPriorPPRByName = new Map<string, number>();
            for (const p of predPriorTotals) {
              if (!POSITIONS.includes(p.position)) continue;
              const team = p.recent_team || '';
              if (team) {
                predTeamTotalCarries.set(team, (predTeamTotalCarries.get(team) || 0) + (p.carries || 0));
                predTeamTotalTargets.set(team, (predTeamTotalTargets.get(team) || 0) + (p.targets || 0));
              }
              predPriorPPRByName.set(normalizeName(p.player_display_name), p.fantasy_points_ppr || 0);
            }
            const predDraftPicksBySeason = draftData.filter((d) => d.season === predSeason);
            const predTeamDraftedPos = new Map<string, { count: number; bestPick: number }>();
            for (const d of predDraftPicksBySeason) {
              const pos = d.position || '';
              if (!POSITIONS.includes(pos)) continue;
              const key = `${d.team}:${pos}`;
              const existing = predTeamDraftedPos.get(key) || { count: 0, bestPick: 300 };
              existing.count += 1;
              existing.bestPick = Math.min(existing.bestPick, d.pick || 300);
              predTeamDraftedPos.set(key, existing);
            }

            // Quality-aware competition aggregations for predictions
            const predPriorPosByName = new Map<string, string>();
            for (const p of predPriorTotals) {
              if (POSITIONS.includes(p.position)) predPriorPosByName.set(normalizeName(p.player_display_name), p.position);
            }
            const predPosPriorRanks = new Map<string, Map<string, number>>();
            for (const pos of POSITIONS) {
              const posPlayers = predPriorTotals
                .filter((p) => p.position === pos)
                .sort((a, b) => (b.fantasy_points_ppr || 0) - (a.fantasy_points_ppr || 0));
              const rankMap = new Map<string, number>();
              posPlayers.forEach((p, i) => rankMap.set(normalizeName(p.player_display_name), i + 1));
              predPosPriorRanks.set(pos, rankMap);
            }
            interface PredTeamPosAgg { bestPPR: number; totalPPR: number; hasTop12: boolean }
            const predTeamPosAgg = new Map<string, PredTeamPosAgg>();
            for (const [key, names] of predRosterByTeamPos) {
              const [, pos] = key.split(':');
              const agg: PredTeamPosAgg = { bestPPR: 0, totalPPR: 0, hasTop12: false };
              for (const name of names) {
                const ppr = predPriorPPRByName.get(name) || 0;
                if (ppr > agg.bestPPR) agg.bestPPR = ppr;
                agg.totalPPR += ppr;
                const rank = predPosPriorRanks.get(pos)?.get(name) || 999;
                if (rank <= 12) agg.hasTop12 = true;
              }
              predTeamPosAgg.set(key, agg);
            }
            const predTeamPassCatcherPPR2 = new Map<string, number>();
            const predTeamElitePassCatchers2 = new Map<string, number>();
            for (const [key, names] of predRosterByTeamPos) {
              const [pcTeam, pos] = key.split(':');
              if (pos !== 'WR' && pos !== 'TE') continue;
              for (const name of names) {
                const ppr = predPriorPPRByName.get(name) || 0;
                predTeamPassCatcherPPR2.set(pcTeam, (predTeamPassCatcherPPR2.get(pcTeam) || 0) + ppr);
                const rank = predPosPriorRanks.get(pos)?.get(name) || 999;
                if (rank <= 24) predTeamElitePassCatchers2.set(pcTeam, (predTeamElitePassCatchers2.get(pcTeam) || 0) + 1);
              }
            }
            const predTeamTargetHHI2 = new Map<string, number>();
            for (const team of new Set([...predTeamTotalTargets.keys()])) {
              const totalTgts = predTeamTotalTargets.get(team) || 1;
              let hhi = 0;
              for (const p of predPriorTotals) {
                if ((p.recent_team || '') !== team || !POSITIONS.includes(p.position)) continue;
                const share = (p.targets || 0) / totalTgts;
                hhi += share * share;
              }
              predTeamTargetHHI2.set(team, Math.round(hhi * 1000) / 1000);
            }
            const predNewArrivalBestPPR2 = new Map<string, number>();
            for (const [key, names] of predRosterByTeamPos) {
              const priorNames = predPriorRosterByTeamPos.get(key);
              let best = 0;
              for (const name of names) {
                if (priorNames && priorNames.has(name)) continue;
                const ppr = predPriorPPRByName.get(name) || 0;
                if (ppr > best) best = ppr;
              }
              predNewArrivalBestPPR2.set(key, Math.round(best * 10) / 10);
            }
            const predAdpByName = new Map<string, number>();
            for (const a of predAdpData) predAdpByName.set(normalizeName(a.name), a.adp);
            const predNewArrivalBestADP2 = new Map<string, number>();
            for (const [key, names] of predRosterByTeamPos) {
              const priorNames = predPriorRosterByTeamPos.get(key);
              let bestAdp = 999;
              for (const name of names) {
                if (priorNames && priorNames.has(name)) continue;
                const adp2 = predAdpByName.get(name) || 999;
                if (adp2 < bestAdp) bestAdp = adp2;
              }
              predNewArrivalBestADP2.set(key, bestAdp < 999 ? bestAdp : 0);
            }

            // ── Scheme features for predictions ──
            interface PredSchemeAgg {
              passes: number; rushes: number; plays: number; games: number;
              neutralPasses: number; neutralPlays: number;
              firstDownRuns: number; firstDownPlays: number;
              shotgunPlays: number; noHuddlePlays: number;
              rbTargets: number; teTargets: number; wrTargets: number; totalTargets: number;
            }
            const predSchemeByTeam = new Map<string, PredSchemeAgg>();
            const predPriorGamesByTeam = new Map<string, Set<string>>();
            // Personnel aggregation for predictions
            interface PredPersonnelAgg {
              p11: number; p12: number; p13: number; p21: number;
              p22: number; p10: number; total: number;
              wr3plus: number; te2plus: number;
            }
            const predPersonnelByTeam = new Map<string, PredPersonnelAgg>();

            for (const play of predPriorPbp) {
              if (!play.posteam || play.play_type === 'no_play') continue;
              const team = play.posteam;
              if (!predPriorGamesByTeam.has(team)) predPriorGamesByTeam.set(team, new Set());
              predPriorGamesByTeam.get(team)!.add(play.game_id);

              if (play.play_type !== 'pass' && play.play_type !== 'run') continue;
              const acc = predSchemeByTeam.get(team) || {
                passes: 0, rushes: 0, plays: 0, games: 0,
                neutralPasses: 0, neutralPlays: 0,
                firstDownRuns: 0, firstDownPlays: 0,
                shotgunPlays: 0, noHuddlePlays: 0,
                rbTargets: 0, teTargets: 0, wrTargets: 0, totalTargets: 0,
              };
              acc.plays += 1;
              if (play.play_type === 'pass' || play.qb_dropback === 1) acc.passes += 1;
              else acc.rushes += 1;
              const isNeutral = Math.abs(play.score_differential || 0) <= 7 && (play.qtr || 0) <= 3;
              if (isNeutral) {
                acc.neutralPlays += 1;
                if (play.play_type === 'pass' || play.qb_dropback === 1) acc.neutralPasses += 1;
              }
              if (play.down === 1) {
                acc.firstDownPlays += 1;
                if (play.play_type === 'run' && play.qb_dropback !== 1) acc.firstDownRuns += 1;
              }
              if (play.shotgun === 1) acc.shotgunPlays += 1;
              if (play.no_huddle === 1) acc.noHuddlePlays += 1;
              if (play.play_type === 'pass' && play.receiver_player_name) {
                acc.totalTargets += 1;
                const recName = normalizeName(play.receiver_player_name);
                const recPrior = predPriorByName.get(recName);
                if (recPrior?.position === 'RB') acc.rbTargets += 1;
                else if (recPrior?.position === 'TE') acc.teTargets += 1;
                else if (recPrior?.position === 'WR') acc.wrTargets += 1;
              }
              predSchemeByTeam.set(team, acc);

              // Personnel grouping
              if (play.offense_personnel) {
                const persAcc = predPersonnelByTeam.get(team) || {
                  p11: 0, p12: 0, p13: 0, p21: 0, p22: 0, p10: 0, total: 0,
                  wr3plus: 0, te2plus: 0,
                };
                persAcc.total += 1;
                const pers = play.offense_personnel;
                const rbM = pers.match(/(\d+)\s*RB/i);
                const teM = pers.match(/(\d+)\s*TE/i);
                const wrM = pers.match(/(\d+)\s*WR/i);
                const rb = rbM ? Number(rbM[1]) : 0;
                const te = teM ? Number(teM[1]) : 0;
                const wr = wrM ? Number(wrM[1]) : 0;
                const grouping = `${rb}${te}`;
                if (grouping === '11') persAcc.p11 += 1;
                else if (grouping === '12') persAcc.p12 += 1;
                else if (grouping === '13') persAcc.p13 += 1;
                else if (grouping === '21') persAcc.p21 += 1;
                else if (grouping === '22') persAcc.p22 += 1;
                else if (grouping === '10') persAcc.p10 += 1;
                if (wr >= 3) persAcc.wr3plus += 1;
                if (te >= 2) persAcc.te2plus += 1;
                predPersonnelByTeam.set(team, persAcc);
              }
            }
            for (const [team, gameSet] of predPriorGamesByTeam) {
              const acc = predSchemeByTeam.get(team);
              if (acc) acc.games = gameSet.size;
            }

            // Team QB rushing impact for predictions
            // Uses CURRENT roster QB's prior stats (follows the QB, not the team)
            const predTeamQBStats = new Map<string, {
              rushAtt: number; rushYds: number; rushTDs: number;
              rushShare: number; scrambleRate: number; ppg: number;
            }>();
            {
              // Find current-season starting QB from prediction rosters/depth charts
              const currentQBByTeam = new Map<string, string>();
              for (const dc of predDcLatest.values()) {
                if (dc.pos_abb === 'QB' && (dc.pos_rank === 1 || dc.pos_slot === 1)) {
                  currentQBByTeam.set(dc.team, normalizeName(dc.player_name));
                }
              }
              if (currentQBByTeam.size < 20) {
                const predAdpByName2 = new Map<string, number>();
                for (const a of predAdpData) predAdpByName2.set(normalizeName(a.name), a.adp);
                for (const r of predSeasonRosters) {
                  if (r.position !== 'QB' || r.status === 'Inactive') continue;
                  const name = normalizeName(r.full_name);
                  if (!currentQBByTeam.has(r.team)) {
                    currentQBByTeam.set(r.team, name);
                  } else {
                    const existingAdp = predAdpByName2.get(currentQBByTeam.get(r.team)!) || 999;
                    const thisAdp = predAdpByName2.get(name) || 999;
                    if (thisAdp < existingAdp) currentQBByTeam.set(r.team, name);
                  }
                }
              }

              for (const [team, qbName] of currentQBByTeam) {
                const qbPrior = predPriorByName.get(qbName);
                if (!qbPrior) continue;
                const qbGames = qbPrior.games || 1;
                const qbPriorTeam = qbPrior.recent_team || '';
                const priorTeamRushAtt = predTeamTotalCarries.get(qbPriorTeam) || 1;
                const scrambleRate = qbPrior.carries && qbPrior.attempts
                  ? (qbPrior.carries) / (qbPrior.attempts + qbPrior.carries)
                  : 0;
                predTeamQBStats.set(team, {
                  rushAtt: qbPrior.carries || 0,
                  rushYds: qbPrior.rushing_yards || 0,
                  rushTDs: qbPrior.rushing_tds || 0,
                  rushShare: (qbPrior.carries || 0) / priorTeamRushAtt,
                  scrambleRate: Math.round(scrambleRate * 1000) / 1000,
                  ppg: Math.round((qbPrior.fantasy_points_ppr || 0) / qbGames * 10) / 10,
                });
              }
            }

            // Team's prior QB stats for predictions (coaching tendency)
            const predTeamPriorQBStats = new Map<string, { rushAtt: number; rushShare: number; scrambleRate: number }>();
            {
              const priorQBByTeam2 = new Map<string, SeasonTotals>();
              for (const p of predPriorTotals) {
                if (p.position !== 'QB') continue;
                const team = p.recent_team || '';
                if (!team) continue;
                const existing = priorQBByTeam2.get(team);
                if (!existing || (p.fantasy_points_ppr || 0) > (existing.fantasy_points_ppr || 0)) {
                  priorQBByTeam2.set(team, p);
                }
              }
              for (const [team, qb] of priorQBByTeam2) {
                const tRushAtt = predTeamTotalCarries.get(team) || 1;
                const sch = predSchemeByTeam.get(team);
                const sr = sch && sch.passes > 0 ? (qb.carries || 0) / (sch.passes + (qb.carries || 0)) : 0;
                predTeamPriorQBStats.set(team, {
                  rushAtt: qb.carries || 0,
                  rushShare: (qb.carries || 0) / tRushAtt,
                  scrambleRate: Math.round(sr * 1000) / 1000,
                });
              }
            }

            // Coach change detection for prediction season
            const predCoachChangeTeams = new Set<string>();
            for (const [key, coach] of coachBySeasonTeam) {
              const [szn, team] = key.split(':');
              if (Number(szn) === predSeason) {
                const priorCoach = coachBySeasonTeam.get(`${priorSeason}:${team}`);
                if (priorCoach && priorCoach !== coach) predCoachChangeTeams.add(team);
              }
            }
            const predCoachPriorTeamPPR = new Map<string, number>();
            for (const p of predPriorTotals) {
              if (!POSITIONS.includes(p.position)) continue;
              const team = p.recent_team || '';
              predCoachPriorTeamPPR.set(team, (predCoachPriorTeamPPR.get(team) || 0) + (p.fantasy_points_ppr || 0));
            }

            // ── SOS for prediction season ──
            const predSosDefPPG = new Map<string, number>();
            const predSosAvgSpread = new Map<string, number>();
            {
              const teamOpponents = new Map<string, string[]>();
              for (const g of gamesData) {
                if (g.game_type !== 'REG' || g.season !== predSeason) continue;
                if (!teamOpponents.has(g.home_team)) teamOpponents.set(g.home_team, []);
                if (!teamOpponents.has(g.away_team)) teamOpponents.set(g.away_team, []);
                teamOpponents.get(g.home_team)!.push(g.away_team);
                teamOpponents.get(g.away_team)!.push(g.home_team);
              }
              for (const [team, opps] of teamOpponents) {
                let totalPts = 0, totalSpread = 0, count = 0;
                for (const opp of opps) {
                  const v = vegasBySeasonTeam.get(`${priorSeason}:${opp}`);
                  if (v && v.games > 0) {
                    totalPts += v.actualPts / v.games;
                    totalSpread += v.spread / v.games;
                    count++;
                  }
                }
                if (count > 0) {
                  predSosDefPPG.set(team, Math.round((totalPts / count) * 10) / 10);
                  predSosAvgSpread.set(team, Math.round((totalSpread / count) * 10) / 10);
                }
              }
            }

            // ── Scheme clusters for prediction season ──
            const predSchemeFlags = new Map<string, {
              passHeavy: number; runHeavy: number; uptempo: number;
              shotgunHeavy: number; rbReceiving: number; teHeavy: number;
            }>();
            for (const [team, scheme] of predSchemeByTeam) {
              if (scheme.plays === 0) continue;
              const passRate = scheme.passes / scheme.plays;
              const pace = scheme.plays / Math.max(1, scheme.games);
              const shotgunRate = scheme.shotgunPlays / scheme.plays;
              const rbTgtRate = scheme.totalTargets > 0 ? scheme.rbTargets / scheme.totalTargets : 0;
              const teTgtRate = scheme.totalTargets > 0 ? scheme.teTargets / scheme.totalTargets : 0;
              predSchemeFlags.set(team, {
                passHeavy: passRate > 0.58 ? 1 : 0,
                runHeavy: passRate < 0.48 ? 1 : 0,
                uptempo: pace > 67 ? 1 : 0,
                shotgunHeavy: shotgunRate > 0.70 ? 1 : 0,
                rbReceiving: rbTgtRate > 0.18 ? 1 : 0,
                teHeavy: teTgtRate > 0.22 ? 1 : 0,
              });
            }

            // ── Vegas season props for prediction ──
            const predVegasSeasonProps = new Map<string, { winTotal: number; avgOU: number }>();
            for (const [key, v] of vegasBySeasonTeam) {
              const [szn, team] = key.split(':');
              if (Number(szn) !== priorSeason || v.games === 0) continue;
              predVegasSeasonProps.set(team, {
                winTotal: Math.round(v.wins * 10) / 10,
                avgOU: v.gameTotal > 0 ? Math.round((v.gameTotal / v.games) * 10) / 10 : 0,
              });
            }

            // Build prediction features for each ADP player
            for (const adpPlayer of predAdpData) {
              if (!POSITIONS.includes(adpPlayer.position)) continue;
              if (adpPlayer.adp > 200) continue;

              const normalName = normalizeName(adpPlayer.name);
              const prior = predPriorByName.get(normalName);
              const combine = combineByName.get(normalName);
              const draft = draftByName.get(normalName);
              const snapAcc = predSnapAccum.get(normalName);
              const snapPct = snapAcc && snapAcc.count > 0 ? snapAcc.total / snapAcc.count : 0;

              const heightIn = combine?.ht ? parseHeight(combine.ht) : 0;
              const wt = combine?.wt || 0;
              const bmi = heightIn > 0 && wt > 0 ? (703 * wt) / (heightIn * heightIn) : 0;

              const priorGames = prior?.games || 0;
              const priorPPR = prior?.fantasy_points_ppr || 0;
              const priorAttempts = prior?.attempts || 0;
              const priorCarries = prior?.carries || 0;

              const draftAge = draft?.age || 0;
              const draftYear = draft?.season || 0;
              const age = draftAge > 0 && draftYear > 0 ? draftAge + (predSeason - draftYear) : 0;

              const adv = predAdvByName.get(normalName);
              const advWeeks = adv?.weeks || 1;
              const avgTargetShare = adv ? adv.targetShare / advWeeks : 0;
              const avgAirYardsShare = adv ? adv.airYardsShare / advWeeks : 0;
              const avgWOPR = adv ? adv.wopr / advWeeks : 0;
              const avgRACR = adv && advWeeks > 0 ? adv.racr / advWeeks : 0;
              const yacPerRec = adv && adv.receptions > 0 ? adv.yac / adv.receptions : 0;
              const airYardsPerTarget = adv && adv.targets > 0 ? adv.recAirYards / adv.targets : 0;

              const pbp = predPbpByReceiver.get(normalName);
              const adot = pbp && pbp.targets > 0 ? pbp.totalAirYards / pbp.targets : 0;
              const deepPct = pbp && pbp.targets > 0 ? pbp.deepTargets / pbp.targets : 0;
              const playerTeam = prior?.recent_team || '';
              const teamRZ = predTeamRZTargets.get(playerTeam) || 1;
              const rzTargetShare = pbp ? pbp.rzTargets / teamRZ : 0;

              const ngsRec = predNgsRecByName.get(normalName);
              const ngsRush = predNgsRushByName.get(normalName);
              const ngsPass = predNgsPassByName.get(normalName);

              const features: Record<string, number> = {
                adp: adpPlayer.adp,
                adpRound: Math.ceil(adpPlayer.adp / 12),
                age,
                yearsInLeague: draft ? predSeason - draft.season : 0,
                nflDraftRound: draft?.round || 8,
                nflDraftPick: draft?.pick || 300,
                weight: wt,
                forty: combine?.forty || 0,
                bmi: Math.round(bmi * 10) / 10,
                priorPassYards: prior?.passing_yards || 0,
                priorPassTDs: prior?.passing_tds || 0,
                priorINTs: prior?.interceptions || 0,
                priorPassYPA: priorAttempts > 0 ? Math.round((prior?.passing_yards || 0) / priorAttempts * 10) / 10 : 0,
                priorQBRating: 0,
                priorRushYards: prior?.rushing_yards || 0,
                priorRushTDs: prior?.rushing_tds || 0,
                priorYPC: priorCarries > 0 ? Math.round((prior?.rushing_yards || 0) / priorCarries * 10) / 10 : 0,
                priorCarries: priorCarries,
                priorTargets: prior?.targets || 0,
                priorReceptions: prior?.receptions || 0,
                priorRecYards: prior?.receiving_yards || 0,
                priorRecTDs: prior?.receiving_tds || 0,
                priorYPR: (prior?.receptions || 0) > 0
                  ? Math.round((prior?.receiving_yards || 0) / (prior?.receptions || 1) * 10) / 10 : 0,
                priorTargetShare: Math.round(avgTargetShare * 1000) / 1000,
                priorAirYardsShare: Math.round(avgAirYardsShare * 1000) / 1000,
                priorWOPR: Math.round(avgWOPR * 1000) / 1000,
                priorRACR: Math.round(avgRACR * 100) / 100,
                priorYACperRec: Math.round(yacPerRec * 10) / 10,
                priorAirYardsPerTarget: Math.round(airYardsPerTarget * 10) / 10,
                priorRecEPA: Math.round((adv?.recEPA || 0) * 10) / 10,
                priorRushEPA: Math.round((adv?.rushEPA || 0) * 10) / 10,
                priorADOT: Math.round(adot * 10) / 10,
                priorDeepTargetPct: Math.round(deepPct * 1000) / 1000,
                priorRZTargetShare: Math.round(rzTargetShare * 1000) / 1000,
                priorSeparation: ngsRec?.avg_separation || 0,
                priorCushion: ngsRec?.avg_cushion || 0,
                priorYACAboveExp: ngsRec?.avg_yac_above_expectation || 0,
                priorCatchPct: ngsRec?.catch_percentage || 0,
                priorIntendedAirYardShare: ngsRec?.percent_share_of_intended_air_yards || 0,
                priorRYOEperAtt: ngsRush?.rush_yards_over_expected_per_att || 0,
                priorRushEfficiency: ngsRush?.efficiency || 0,
                priorPctVs8Defenders: ngsRush?.percent_attempts_gte_eight_defenders || 0,
                priorCPOE: ngsPass?.completion_percentage_above_expectation || 0,
                priorTimeToThrow: ngsPass?.avg_time_to_throw || 0,
                priorAggressiveness: ngsPass?.aggressiveness || 0,
                priorYPRR: (() => {
                  const rt = predRoutesByName.get(normalName);
                  return rt && rt.routesRun > 0
                    ? Math.round(((prior?.receiving_yards || 0) / rt.routesRun) * 100) / 100 : 0;
                })(),
                priorRoutesRun: predRoutesByName.get(normalName)?.routesRun || 0,
                priorTargetsPerRoute: (() => {
                  const rt = predRoutesByName.get(normalName);
                  return rt && rt.routesRun > 0
                    ? Math.round(((prior?.targets || 0) / rt.routesRun) * 1000) / 1000 : 0;
                })(),
                priorPct11Personnel: (() => {
                  const rt = predRoutesByName.get(normalName);
                  return rt && rt.totalSnaps > 0
                    ? Math.round((rt.snaps11 / rt.totalSnaps) * 1000) / 1000 : 0;
                })(),
                priorPct12Personnel: (() => {
                  const rt = predRoutesByName.get(normalName);
                  return rt && rt.totalSnaps > 0
                    ? Math.round((rt.snaps12 / rt.totalSnaps) * 1000) / 1000 : 0;
                })(),
                priorPassLocationLeft: (() => {
                  const loc = predLocByReceiver.get(normalName);
                  return loc && loc.total > 0 ? Math.round((loc.left / loc.total) * 1000) / 1000 : 0;
                })(),
                priorPassLocationMiddle: (() => {
                  const loc = predLocByReceiver.get(normalName);
                  return loc && loc.total > 0 ? Math.round((loc.middle / loc.total) * 1000) / 1000 : 0;
                })(),
                priorPPR: Math.round(priorPPR * 10) / 10,
                priorPPG: priorGames > 0 ? Math.round(priorPPR / priorGames * 10) / 10 : 0,
                priorGames,
                priorGamesMissed: prior ? Math.max(0, 17 - priorGames) : 0,
                priorTotalTouches: priorCarries + (prior?.receptions || 0),
                priorSnapPct: Math.round(snapPct * 10) / 10,
                priorInjuryWeeks: predPriorInjByName.get(normalName)?.weeks || 0,
                priorGamesOut: predPriorInjByName.get(normalName)?.gamesOut || 0,
                preseasonInjured: predPreseasonInjByName.get(normalName)?.injured ? 1 : 0,
                preseasonInjWeeks: predPreseasonInjByName.get(normalName)?.weeks || 0,
                priorSoftTissue: predPriorInjByName.get(normalName)?.softTissue ? 1 : 0,
                priorKneeInjury: predPriorInjByName.get(normalName)?.knee ? 1 : 0,

                // Roster competition features
                ...(() => {
                  const playerTeam2 = predPlayerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
                  const posKey = `${playerTeam2}:${adpPlayer.position}`;
                  const teammates = predRosterByTeamPos.get(posKey);
                  const samePosCount = teammates ? teammates.size - (teammates.has(normalName) ? 1 : 0) : 0;
                  const priorTeammates2 = predPriorRosterByTeamPos.get(posKey);
                  const newArrivals = teammates && priorTeammates2
                    ? [...teammates].filter((n) => n !== normalName && !priorTeammates2.has(n)).length
                    : 0;
                  const draftedInfo = predTeamDraftedPos.get(posKey);
                  const priorTeamCarries = predTeamTotalCarries.get(playerTeam2) || 1;
                  const priorTeamTargets2 = predTeamTotalTargets.get(playerTeam2) || 1;
                  const playerTouchShare = adpPlayer.position === 'RB'
                    ? (prior?.carries || 0) / priorTeamCarries
                    : (prior?.targets || 0) / priorTeamTargets2;
                  const playerTargetShareTeam = (prior?.targets || 0) / priorTeamTargets2;

                  let bestTeammatePPR = 0;
                  if (teammates) {
                    for (const tmName of teammates) {
                      if (tmName === normalName) continue;
                      const tmPPR = predPriorPPRByName.get(tmName) || 0;
                      if (tmPPR > bestTeammatePPR) bestTeammatePPR = tmPPR;
                    }
                  }

                  return {
                    teamSamePosCount: samePosCount,
                    depthChartRank: predDepthRankByName.get(normalName) || 99,
                    priorTeamTouchShare: Math.round(playerTouchShare * 1000) / 1000,
                    priorTeamTargetShare: Math.round(playerTargetShareTeam * 1000) / 1000,
                    newSamePosAdded: newArrivals,
                    teamDraftedSamePos: draftedInfo ? draftedInfo.count : 0,
                    draftCapitalSamePos: draftedInfo ? Math.max(0, 8 - Math.ceil(draftedInfo.bestPick / 32)) : 0,
                    teammatePriorPPR: Math.round(bestTeammatePPR * 10) / 10,

                    // Quality-aware cross-position competition
                    teamWRElitePPR: Math.round((predTeamPosAgg.get(`${playerTeam2}:WR`)?.bestPPR || 0) * 10) / 10,
                    teamWRTop12: (predTeamPosAgg.get(`${playerTeam2}:WR`)?.hasTop12 || false) ? 1 : 0,
                    teamWRTotalPPR: Math.round((predTeamPosAgg.get(`${playerTeam2}:WR`)?.totalPPR || 0) * 10) / 10,
                    teamTEElitePPR: Math.round((predTeamPosAgg.get(`${playerTeam2}:TE`)?.bestPPR || 0) * 10) / 10,
                    teamRBElitePPR: Math.round((predTeamPosAgg.get(`${playerTeam2}:RB`)?.bestPPR || 0) * 10) / 10,
                    teamRBTop12: (predTeamPosAgg.get(`${playerTeam2}:RB`)?.hasTop12 || false) ? 1 : 0,
                    teamPassCatcherPPR: Math.round((predTeamPassCatcherPPR2.get(playerTeam2) || 0) * 10) / 10,
                    teamElitePassCatchers: predTeamElitePassCatchers2.get(playerTeam2) || 0,
                    teamTargetHHI: predTeamTargetHHI2.get(playerTeam2) || 0,
                    newArrivalBestPPR: predNewArrivalBestPPR2.get(posKey) || 0,
                    newArrivalBestADP: predNewArrivalBestADP2.get(posKey) || 0,
                  };
                })(),

                // Coaching & scheme features
                ...(() => {
                  const pTeam = predPlayerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
                  const scheme = predSchemeByTeam.get(pTeam);
                  const totalPlays = scheme?.plays || 1;
                  const totalGames = scheme?.games || 1;
                  return {
                    newHeadCoach: predCoachChangeTeams.has(pTeam) ? 1 : 0,
                    coachPriorTeamPPR: Math.round((predCoachPriorTeamPPR.get(pTeam) || 0) * 10) / 10,
                    teamPassRate: scheme ? Math.round((scheme.passes / totalPlays) * 1000) / 1000 : 0,
                    teamNeutralPassRate: scheme && scheme.neutralPlays > 0
                      ? Math.round((scheme.neutralPasses / scheme.neutralPlays) * 1000) / 1000 : 0,
                    teamPace: scheme ? Math.round((totalPlays / totalGames) * 10) / 10 : 0,
                    teamFirstDownRunRate: scheme && scheme.firstDownPlays > 0
                      ? Math.round((scheme.firstDownRuns / scheme.firstDownPlays) * 1000) / 1000 : 0,
                    teamShotgunRate: scheme ? Math.round((scheme.shotgunPlays / totalPlays) * 1000) / 1000 : 0,
                    teamNoHuddleRate: scheme ? Math.round((scheme.noHuddlePlays / totalPlays) * 1000) / 1000 : 0,
                    teamRBTargetRate: scheme && scheme.totalTargets > 0
                      ? Math.round((scheme.rbTargets / scheme.totalTargets) * 1000) / 1000 : 0,
                  };
                })(),

                // Personnel & positional usage features
                ...(() => {
                  const pTeam2 = predPlayerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
                  const pers = predPersonnelByTeam.get(pTeam2);
                  const persTotal = pers?.total || 1;
                  const sch = predSchemeByTeam.get(pTeam2);
                  const schGames = sch?.games || 1;
                  const schTotalTgts = sch?.totalTargets || 1;
                  return {
                    team11Rate: pers ? Math.round((pers.p11 / persTotal) * 1000) / 1000 : 0,
                    team12Rate: pers ? Math.round((pers.p12 / persTotal) * 1000) / 1000 : 0,
                    team13Rate: pers ? Math.round((pers.p13 / persTotal) * 1000) / 1000 : 0,
                    team21Rate: pers ? Math.round((pers.p21 / persTotal) * 1000) / 1000 : 0,
                    team22Rate: pers ? Math.round((pers.p22 / persTotal) * 1000) / 1000 : 0,
                    team10Rate: pers ? Math.round((pers.p10 / persTotal) * 1000) / 1000 : 0,
                    teamTETargetRate: sch ? Math.round((sch.teTargets / schTotalTgts) * 1000) / 1000 : 0,
                    teamWRTargetRate: sch ? Math.round((sch.wrTargets / schTotalTgts) * 1000) / 1000 : 0,
                    teamTETargetsPerGame: sch ? Math.round((sch.teTargets / schGames) * 10) / 10 : 0,
                    teamRBTargetsPerGame: sch ? Math.round((sch.rbTargets / schGames) * 10) / 10 : 0,
                    teamWR3PlusOnField: pers ? Math.round((pers.wr3plus / persTotal) * 1000) / 1000 : 0,
                    team2PlusTEOnField: pers ? Math.round((pers.te2plus / persTotal) * 1000) / 1000 : 0,
                  };
                })(),

                // Vegas / implied totals (use prior season = 2025 lines)
                ...(() => {
                  const vTeam = predPlayerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
                  const vKey = `${predSeason - 1}:${vTeam}`;
                  const v = vegasBySeasonTeam.get(vKey);
                  const vGames = v?.games || 1;
                  return {
                    vegasImpliedTotal: v ? Math.round((v.impliedTotal / vGames) * 10) / 10 : 0,
                    vegasImpliedSpread: v ? Math.round((v.spread / vGames) * 10) / 10 : 0,
                    vegasGameTotal: v ? Math.round((v.gameTotal / vGames) * 10) / 10 : 0,
                    vegasWinPct: v ? Math.round((v.wins / vGames) * 1000) / 1000 : 0,
                    vegasActualPtsPerGame: v ? Math.round((v.actualPts / vGames) * 10) / 10 : 0,
                  };
                })(),

                // ── Projection model features ──
                ...(() => {
                  const pf = predProjFeatures.get(normalName);
                  return {
                    projTeamPassAtt:      pf?.projTeamPassAtt      ?? 0,
                    projTeamPassVolChg:   pf?.projTeamPassVolChg    ?? 0,
                    projPlayerPPR:        pf?.projPlayerPPR         ?? 0,
                    projPlayerVsExpected: pf?.projPlayerVsExpected  ?? 0,
                    projTargetShare:      pf?.projTargetShare        ?? 0,
                  };
                })(),

                // Reddit sentiment features
                ...(() => {
                  const rKey = `${normalName}:${predSeason}`;
                  const buzz = redditBuzz.get(rKey);
                  const win = redditWindowed.get(rKey);
                  return {
                    redditMentions1w: win?.mentions_1w || 0,
                    redditSentiment1w: win?.sentiment_1w || 0,
                    redditHype1w: win?.hype_1w || 0,
                    redditMentions4w: win?.mentions_4w || buzz?.mentions || 0,
                    redditSentiment4w: win?.sentiment_4w || buzz?.sentiment || 0,
                    redditMentionVelocity: win?.mention_velocity || 0,
                    redditSentimentVelocity: win?.sentiment_velocity || 0,
                  };
                })(),

                // SOS
                ...(() => {
                  const pTeam = predPlayerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
                  return {
                    sosDefPassYdg: predSosDefPPG.get(pTeam) || 0,
                    sosDefRushYdg: 0,
                    sosDefPPG: predSosDefPPG.get(pTeam) || 0,
                    sosAvgSpread: predSosAvgSpread.get(pTeam) || 0,
                  };
                })(),

                // Scheme clusters
                ...(() => {
                  const pTeam = predPlayerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
                  const sf = predSchemeFlags.get(pTeam);
                  return {
                    schemePassHeavy: sf?.passHeavy || 0,
                    schemeRunHeavy: sf?.runHeavy || 0,
                    schemeUptempo: sf?.uptempo || 0,
                    schemeShotgunHeavy: sf?.shotgunHeavy || 0,
                    schemeRBReceiving: sf?.rbReceiving || 0,
                    schemeTEHeavy: sf?.teHeavy || 0,
                  };
                })(),

                // Vegas season props
                ...(() => {
                  const pTeam = predPlayerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
                  const vp = predVegasSeasonProps.get(pTeam);
                  return {
                    vegasSeasonWinTotal: vp?.winTotal || 0,
                    vegasSeasonOverUnder: vp?.avgOU || 0,
                  };
                })(),

                // College production
                ...(() => {
                  const cs = collegeByName.get(normalName);
                  return {
                    collegePassYds: cs?.get('Passing Yards') || 0,
                    collegePassTDs: cs?.get('Passing Touchdowns') || 0,
                    collegeRushYds: cs?.get('Rushing Yards') || 0,
                    collegeRecYds: cs?.get('Receiving Yards') || 0,
                    collegeRecTDs: cs?.get('Receiving Touchdowns') || 0,
                    collegeTotalTDs: (cs?.get('Passing Touchdowns') || 0) + (cs?.get('Rushing Touchdowns') || 0) + (cs?.get('Receiving Touchdowns') || 0),
                    collegeQBR: collegeQBRByName.get(normalName) || 0,
                  };
                })(),

                // Contract data
                ...(() => {
                  const c = contractByName.get(normalName);
                  const yearsRem = c ? Math.max(0, c.years - (predSeason - c.year_signed)) : 0;
                  return {
                    contractAPY: c ? Math.round(c.apy / 1_000_000 * 10) / 10 : 0,
                    contractGuaranteed: c ? Math.round(c.guaranteed / 1_000_000 * 10) / 10 : 0,
                    contractAPYCapPct: c ? Math.round(c.apy_cap_pct * 100) / 100 : 0,
                    contractYearsRemaining: yearsRem,
                  };
                })(),

                // Aging curves
                ...(() => {
                  const draftAge2 = draft?.age || 0;
                  const draftYear2 = draft?.season || 0;
                  const playerAge = draftAge2 > 0 && draftYear2 > 0 ? draftAge2 + (predSeason - draftYear2) : 0;
                  const curve = AGING_CURVES[adpPlayer.position];
                  if (!curve || playerAge === 0) return { ageCurveDelta: 0, isPeakAge: 0, isDeclineAge: 0 };
                  const isPeak = playerAge >= curve.peakStart && playerAge <= curve.peakEnd ? 1 : 0;
                  const isDecline = playerAge >= curve.declineStart ? 1 : 0;
                  const delta = isPeak ? 0.5 : isDecline ? -0.3 * (playerAge - curve.declineStart + 1) : 0;
                  return {
                    ageCurveDelta: Math.round(delta * 100) / 100,
                    isPeakAge: isPeak,
                    isDeclineAge: isDecline,
                  };
                })(),

                // Momentum features (from player history)
                ...(() => {
                  const hist = playerHistoryMap.get(normalName) || [];
                  const sorted = hist.sort((a, b) => b.season - a.season);
                  const curr = sorted.find((h) => h.season === predSeason - 1);
                  const prev = sorted.find((h) => h.season === predSeason - 2);
                  if (!curr || !prev) return {
                    ppgTrend: 0, targetTrend: 0, touchTrend: 0,
                    adpTrend: 0, snapPctTrend: 0, targetShareTrend: 0,
                  };
                  return {
                    ppgTrend: Math.round((curr.ppg - prev.ppg) * 10) / 10,
                    targetTrend: curr.targets - prev.targets,
                    touchTrend: curr.touches - prev.touches,
                    adpTrend: prev.adp > 0 && curr.adp > 0 ? Math.round((prev.adp - curr.adp) * 10) / 10 : 0,
                    snapPctTrend: Math.round((curr.snapPct - prev.snapPct) * 10) / 10,
                    targetShareTrend: Math.round((curr.targetShare - prev.targetShare) * 1000) / 1000,
                  };
                })(),

                // Interaction features
                ...(() => {
                  const a = adpPlayer.adp;
                  const draftAge3 = draft?.age || 0;
                  const draftYear3 = draft?.season || 0;
                  const playerAge2 = draftAge3 > 0 && draftYear3 > 0 ? draftAge3 + (predSeason - draftYear3) : 25;
                  const yil = draft ? predSeason - draft.season : 0;
                  const pTeam = predPlayerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
                  const scheme = predSchemeByTeam.get(pTeam);
                  const passRate = scheme && scheme.plays > 0 ? scheme.passes / scheme.plays : 0.5;
                  const shotgunRate = scheme && scheme.plays > 0 ? scheme.shotgunPlays / scheme.plays : 0.5;
                  const priorGames = prior?.games || 0;
                  const priorPPGVal = priorGames > 0 ? (prior?.fantasy_points_ppr || 0) / priorGames : 0;
                  const snapPctVal = predSnapAccum.get(normalName);
                  const snapVal = snapPctVal && snapPctVal.count > 0 ? snapPctVal.total / snapPctVal.count : 0;
                  const contract = contractByName.get(normalName);
                  const cAPY = contract ? contract.apy / 1_000_000 : 0;
                  const cYearsRem = contract ? Math.max(0, contract.years - (predSeason - contract.year_signed)) : 0;
                  const depthRank = predDepthRankByName.get(normalName) || 99;
                  const adv = predAdvByName.get(normalName);
                  const advWeeks = adv?.weeks || 1;
                  const avgTgtShare = adv ? adv.targetShare / advWeeks : 0;
                  const curve = AGING_CURVES[adpPlayer.position];
                  const isDecline3 = curve && playerAge2 >= curve.declineStart ? 1 : 0;

                  return {
                    adpXage: Math.round(a * playerAge2 / 100) / 10,
                    adpXyearsInLeague: Math.round(a * yil) / 10,
                    contractXdepthRank: Math.round(cAPY * depthRank * 10) / 10,
                    priorPPGXage: Math.round(priorPPGVal * playerAge2 * 10) / 10,
                    adpXteamPassRate: Math.round(a * passRate * 10) / 10,
                    adpXschemeShotgun: Math.round(a * shotgunRate * 10) / 10,
                    priorPPGXsnapPct: Math.round(priorPPGVal * snapVal * 10) / 10,
                    ageXcontractYears: Math.round(playerAge2 * cYearsRem * 10) / 10,
                    targetShareXteamPassRate: Math.round(avgTgtShare * passRate * 1000) / 1000,
                    rushAttXageDecline: Math.round((prior?.carries || 0) * isDecline3),
                  };
                })(),

                // QB Impact: current QB's own tendencies + team coaching tendency
                ...(() => {
                  const pTeam = predPlayerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
                  const qbs = predTeamQBStats.get(pTeam);
                  const tpq = predTeamPriorQBStats.get(pTeam);
                  return {
                    qbOwnRushAtt: qbs?.rushAtt || 0,
                    qbOwnRushYds: qbs?.rushYds || 0,
                    qbOwnRushTDs: qbs?.rushTDs || 0,
                    qbOwnRushShare: Math.round((qbs?.rushShare || 0) * 1000) / 1000,
                    qbOwnScrambleRate: qbs?.scrambleRate || 0,
                    qbOwnPPG: qbs?.ppg || 0,
                    teamPriorQBRushAtt: tpq?.rushAtt || 0,
                    teamPriorQBRushShare: Math.round((tpq?.rushShare || 0) * 1000) / 1000,
                    teamPriorQBScrambleRate: tpq?.scrambleRate || 0,
                  };
                })(),

                // Consistency (from prior weekly stats)
                ...(() => {
                  const pts: number[] = [];
                  for (const w of predPriorWeekly) {
                    if (normalizeName(w.player_display_name) === normalName) {
                      pts.push(w.fantasy_points_ppr || 0);
                    }
                  }
                  if (pts.length < 3) return { priorPPGStdDev: 0, priorBoomRate: 0, priorBustGameRate: 0 };
                  const mean = pts.reduce((a, b) => a + b, 0) / pts.length;
                  const stdDev = Math.sqrt(pts.reduce((s, v) => s + (v - mean) ** 2, 0) / pts.length);
                  return {
                    priorPPGStdDev: Math.round(stdDev * 10) / 10,
                    priorBoomRate: Math.round((pts.filter((p) => p >= 20).length / pts.length) * 1000) / 1000,
                    priorBustGameRate: Math.round((pts.filter((p) => p < 5).length / pts.length) * 1000) / 1000,
                  };
                })(),

                // Environment (from games + PBP)
                ...(() => {
                  const pTeam = predPlayerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
                  // Dome games for prediction season
                  let domeCount = 0;
                  let bye = 0;
                  const weeks: number[] = [];
                  for (const g of gamesData) {
                    if (g.game_type !== 'REG' || g.season !== predSeason) continue;
                    if (g.home_team === pTeam && (g.roof === 'dome' || g.roof === 'closed')) domeCount++;
                    if (g.home_team === pTeam || g.away_team === pTeam) weeks.push(g.week);
                  }
                  const sw = weeks.sort((a, b) => a - b);
                  for (let i = 1; i < sw.length; i++) {
                    if (sw[i] - sw[i - 1] > 1) { bye = sw[i - 1] + 1; break; }
                  }
                  // O-line from prior PBP
                  let sacks = 0, dropbacks = 0, rushYd = 0, rushAtt2 = 0;
                  for (const play of predPriorPbp) {
                    if (play.posteam !== pTeam) continue;
                    if (play.play_type === 'pass' || play.qb_dropback === 1) {
                      dropbacks++;
                      if (play.sack === 1) sacks++;
                    }
                    if (play.play_type === 'run' && play.rushing_yards != null) {
                      rushYd += play.rushing_yards;
                      rushAtt2++;
                    }
                  }
                  // QB passer rating
                  let qbPR = 0;
                  for (const p of predPriorTotals) {
                    if (p.position !== 'QB' || (p.recent_team || '') !== pTeam || !p.attempts || p.attempts < 100) continue;
                    const compPct = p.completions / p.attempts;
                    const ypa = p.passing_yards / p.attempts;
                    const tdPct = p.passing_tds / p.attempts;
                    const intPct = p.interceptions / p.attempts;
                    const a = Math.min(2.375, Math.max(0, (compPct - 0.3) * 5));
                    const b = Math.min(2.375, Math.max(0, (ypa - 3) * 0.25));
                    const c = Math.min(2.375, Math.max(0, tdPct * 20));
                    const d = Math.min(2.375, Math.max(0, 2.375 - intPct * 25));
                    qbPR = Math.round(((a + b + c + d) / 6) * 100 * 10) / 10;
                  }
                  // Injury recurrence
                  const inj = predPriorInjByName.get(normalName);
                  let injRisk = 0;
                  if (inj) {
                    if (inj.softTissue) injRisk += 0.5;
                    if (inj.knee) injRisk += 0.5;
                    if (inj.gamesOut >= 4) injRisk += 0.5;
                  }
                  // Roster turnover
                  let turnover = 0;
                  const curNames = predRosterByTeamPos.get(`${pTeam}:${adpPlayer.position}`);
                  const prvNames = predPriorRosterByTeamPos.get(`${pTeam}:${adpPlayer.position}`);
                  if (curNames && prvNames) {
                    const newP = [...curNames].filter((n) => !prvNames.has(n)).length;
                    turnover = curNames.size > 0 ? newP / curNames.size : 0;
                  }
                  return {
                    teamDomeGames: domeCount,
                    byeWeek: bye,
                    teamSackRate: dropbacks > 0 ? Math.round((sacks / dropbacks) * 1000) / 1000 : 0,
                    teamRushYPC: rushAtt2 > 0 ? Math.round((rushYd / rushAtt2) * 10) / 10 : 0,
                    teamQBPassRating: qbPR,
                    injuryRecurrence: Math.min(1, injRisk),
                    teamRosterTurnover: Math.round(turnover * 1000) / 1000,
                  };
                })(),
              };

              predRows.push({
                name: adpPlayer.name,
                position: adpPlayer.position,
                team: adpPlayer.team || '',
                adp: adpPlayer.adp,
                headshotUrl: predHeadshotByName.get(normalName) || predHeadshotByName.get(normalizeName(adpPlayer.name)) || undefined,
                features,
              });
            }
          }
        }

  // Convert vorNorm Map to plain object for JSON serialization
  const vorNormObj: Record<string, { mean: number; std: number }> = {};
  vorNorm.forEach((v, k) => { vorNormObj[k] = v; });

  return { rows, predRows, vorNorm: vorNormObj };
}
