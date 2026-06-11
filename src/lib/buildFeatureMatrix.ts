// Build-time precomputable feature matrix.
// Extracted from ADPFactorAnalysis.tsx useEffect pipeline.
// Works in both browser and Node.js (Node 18+ with native fetch).

import {
  fetchFfcADP, fetchPlayerStats, aggregateToSeasonTotals, fetchEspnADP,
  fetchCombine, fetchDraftPicks, fetchSnapCounts, fetchInjuries,
  fetchNextGenStats, fetchPlayByPlay, fetchPbpParticipation,
  fetchRosters, fetchDepthCharts, fetchGames,
  fetchContracts, fetchCollegeStats, fetchCollegeQBR, fetchDraftProspects,
  fetchCfbdCollegeStats, fetchCfbdSpRatings, fetchCfbdRecruiting,
  fetchCfbdGames, fetchCfbdTeamTalent, fetchCfbdPlayerUsage,
  readLocalJson,
} from '../data';
import { blendPicks, recencyWeight, sampleWeight } from './adpBlend';
import type { CfbdSpRating, CfbdRecruit, CfbdPlayerUsage } from '../data';
import type { SeasonTotals, CombineResult, DraftPick, PlayerStats, NextGenStats, PlayByPlay, PbpParticipation, Roster, DepthChart, Contract, CollegeStats, CollegeQBR, DraftProspect, FfcADPPlayer } from '../types';
import { computePlayerProjectionFeatures } from './playerProjection';
// Volume projection module available for future ML team-level models
// import { trainTeamVolumeModel, buildTeamVolumeTrainingData, projectPlayerPPG } from './volumeProjection';
import {
  POSITIONS,
  normalizeName, parseHeight,
  type PlayerRow, type PredictionRow, type FeatureMatrixConfig, type FeatureMatrixResult,
} from './featureTypes';
import ncaaTeamData from '../data/ncaa-team-data.json';

export async function buildFeatureMatrix(config: FeatureMatrixConfig): Promise<FeatureMatrixResult> {
  const { seasons, predictSeason, scenario, vorBasis, onStatus } = config;

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
        const [combineData, draftData, gamesData, contractsData, collegeStatsBase, collegeQBRData, draftProspectData,
               cfbdStats, cfbdSp, cfbdRecruiting, cfbdGames, cfbdTeamTalent, cfbdPlayerUsage] = await Promise.all([
          fetchCombine(),
          fetchDraftPicks(),
          fetchGames(),
          fetchContracts().catch(() => [] as Contract[]),
          fetchCollegeStats().catch(() => [] as CollegeStats[]),
          fetchCollegeQBR().catch(() => [] as CollegeQBR[]),
          fetchDraftProspects().catch(() => [] as DraftProspect[]),
          fetchCfbdCollegeStats().catch(() => [] as CollegeStats[]),
          fetchCfbdSpRatings().catch(() => ({} as Record<string, CfbdSpRating>)),
          fetchCfbdRecruiting().catch(() => ({} as Record<string, CfbdRecruit>)),
          fetchCfbdGames().catch(() => ({} as Record<string, number>)),
          fetchCfbdTeamTalent().catch(() => ({} as Record<string, number>)),
          fetchCfbdPlayerUsage().catch(() => ({} as Record<string, CfbdPlayerUsage>)),
        ]);

        // Merge CFBD player stats with the JackLich10 source. Both share the
        // {player_name, pos_abbr, school, season, statistic, value} shape, so
        // downstream consumers (playerSeasonStats, collegeByName, school totals)
        // pick them up identically. CFBD's coverage is much wider for older
        // classes — backfills the ~80% of historical rookies the legacy
        // source is missing.
        const collegeStatsData: CollegeStats[] = [...collegeStatsBase, ...cfbdStats];
        if (cfbdStats.length > 0) {
          onStatus?.(`CFBD merged: ${cfbdStats.length} stat rows, ${Object.keys(cfbdSp).length} SP+ ratings, ${Object.keys(cfbdRecruiting).length} recruits, ${Object.keys(cfbdGames).length} game counts, ${Object.keys(cfbdTeamTalent).length} team-talent, ${Object.keys(cfbdPlayerUsage).length} player-usage`);
        }

        // Build lookup maps
        const combineByName = new Map<string, CombineResult>();
        for (const c of combineData) combineByName.set(normalizeName(c.player_name), c);

        // Compute position-average combine values for imputation (missing = 0 is misleading)
        const combineAvg = new Map<string, { forty: number; bench: number; vertical: number; broadJump: number; cone: number; shuttle: number; weight: number }>();
        // Compute per-position combine standard deviations too so we can
        // build a Relative Athletic Score (RAS) per player: z-score each
        // combine metric vs that position's distribution, then average.
        type CombineStats = { mean: number; std: number };
        const combineStats = new Map<string, Record<string, CombineStats>>();
        for (const pos of POSITIONS) {
          const posEntries = combineData.filter(c => c.pos === pos || c.pos === pos);
          const stat = (field: keyof CombineResult): CombineStats => {
            const vals = posEntries.map(c => Number(c[field]) || 0).filter(v => v > 0);
            if (vals.length === 0) return { mean: 0, std: 0 };
            const m = vals.reduce((a, b) => a + b, 0) / vals.length;
            const v = vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length;
            return { mean: Math.round(m * 100) / 100, std: Math.max(0.01, Math.sqrt(v)) };
          };
          const fortyS = stat('forty'), benchS = stat('bench'), vertS = stat('vertical');
          const broadS = stat('broad_jump'), coneS = stat('cone'), shuttleS = stat('shuttle');
          const wtS = stat('wt');
          combineAvg.set(pos, {
            forty: fortyS.mean, bench: benchS.mean, vertical: vertS.mean,
            broadJump: broadS.mean, cone: coneS.mean, shuttle: shuttleS.mean,
            weight: wtS.mean,
          });
          combineStats.set(pos, {
            forty: fortyS, bench: benchS, vertical: vertS,
            broad_jump: broadS, cone: coneS, shuttle: shuttleS, wt: wtS,
          });
        }
        // Compute RAS for a player from their raw combine record. Returns
        // a 0-10 composite where 5 is positional average, 10 is ~2.5 std
        // above on every metric. Forty/cone/shuttle are inverted (lower =
        // better). Only counts metrics the player actually has.
        function computeRAS(combine: CombineResult | undefined, pos: string): number {
          if (!combine) return 0;
          const stats = combineStats.get(pos);
          if (!stats) return 0;
          const metrics: Array<[keyof CombineResult, boolean]> = [
            ['wt', true], ['forty', false], ['bench', true], ['vertical', true],
            ['broad_jump', true], ['cone', false], ['shuttle', false],
          ];
          const zScores: number[] = [];
          for (const [field, higherBetter] of metrics) {
            const raw = Number(combine[field]) || 0;
            if (raw <= 0) continue;
            const s = stats[field as string];
            if (!s || s.std === 0) continue;
            const z = (raw - s.mean) / s.std;
            zScores.push(higherBetter ? z : -z);
          }
          if (zScores.length === 0) return 0;
          const avgZ = zScores.reduce((a, b) => a + b, 0) / zScores.length;
          // Clamp to [-2.5, 2.5] then map to [0, 10] linearly.
          const clamped = Math.max(-2.5, Math.min(2.5, avgZ));
          return Math.round((5 + clamped * 2) * 10) / 10;
        }

        const draftByName = new Map<string, DraftPick>();
        // Populate immediately — downstream loops (playerSeasonStats breakout
        // detection, teammate score, college averages) need draft age and
        // pick BEFORE their own maps are built. Previously this population
        // happened much later, leaving draftByName empty for those loops
        // and silently zeroing out collegeBreakoutAge + collegeTeammateScore.
        for (const d of draftData) draftByName.set(normalizeName(d.pfr_player_name), d);

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
            existing.set(cs.statistic, typeof cs.value === 'number' && isFinite(cs.value) ? cs.value : 0);
            existing.set(existingKey, cs.season);
          }
        }

        // College QBR lookup: player name → list of {season, qbr} so we can
        // compute final-year QBR AND a multi-year (last 2 seasons) average.
        const collegeQBRSeasonsByName = new Map<string, Array<{ season: number; qbr: number }>>();
        for (const q of collegeQBRData) {
          const name = normalizeName(q.player_name);
          if (!collegeQBRSeasonsByName.has(name)) collegeQBRSeasonsByName.set(name, []);
          collegeQBRSeasonsByName.get(name)!.push({ season: q.season, qbr: q.total_qbr || 0 });
        }
        // Sort each player's seasons descending so [0] is the most recent.
        for (const list of collegeQBRSeasonsByName.values()) {
          list.sort((a, b) => b.season - a.season);
        }
        // Final-year QBR (preserves the previous behavior for callers).
        const collegeQBRByName = new Map<string, number>();
        for (const [name, list] of collegeQBRSeasonsByName) {
          collegeQBRByName.set(name, list[0]?.qbr || 0);
        }
        // Average of the most recent 2 seasons (or just the latest if only 1).
        const collegeQBR2yrByName = new Map<string, number>();
        for (const [name, list] of collegeQBRSeasonsByName) {
          if (list.length === 0) continue;
          const lastTwo = list.slice(0, 2);
          const avg = lastTwo.reduce((s, x) => s + x.qbr, 0) / lastTwo.length;
          collegeQBR2yrByName.set(name, Math.round(avg * 10) / 10);
        }

        // Draft prospect rankings/grades
        const prospectByName = new Map<string, DraftProspect>();
        for (const p of draftProspectData) {
          const name = normalizeName(p.player_name);
          if (!prospectByName.has(name)) prospectByName.set(name, p);
        }

        // Projected draft position for incoming rookies (used as fallback before actual draft)
        const projDraftByName = new Map<string, { projRound: number; projPick: number }>();
        try {
          const prospectGrades2026: { name: string; projRound: number; projPick: number }[] =
            (await import('../data/prospect-grades-2026.json')).default;
          for (const p of prospectGrades2026) {
            projDraftByName.set(normalizeName(p.name), { projRound: p.projRound, projPick: p.projPick });
          }
        } catch { /* prospect grades not available */ }

        // Compute college per-game stats from the college stats data
        const collegePerGameByName = new Map<string, { games: number; recPerGame: number; ydsPerGame: number; tdsPerGame: number; rushYPC: number; ydsPerRec: number }>();

        // School-name normalizer aligning JackLich10's college_statistics.csv
        // names with CFBD's /games keys. JackLich10 has long forms ('appalachian
        // state', 'southern mississippi', 'umass'); CFBD uses short forms
        // ('app state', 'southern miss', 'massachusetts') and keeps diacritics
        // ('san josé state'). Without this alignment, ~80% of cfbdGames lookups
        // miss and players fall back to the 12-game default — wiping out the
        // accuracy boost from the games endpoint.
        const SCHOOL_ALIAS_FOR_CFBD: Record<string, string> = {
          'appalachian state': 'app state',
          'southern mississippi': 'southern miss',
          'ut san antonio': 'utsa',
          'umass': 'massachusetts',
          'florida intl': 'florida international',
          'middle tennessee': 'middle tennessee state',
          'louisiana-monroe': 'louisiana monroe',
          'louisiana-lafayette': 'louisiana',
          'cal poly slo': 'cal poly',
          'sam houston state': 'sam houston',
        };
        function normalizeSchoolForCfbd(s: string): string {
          if (!s) return '';
          let n = s.toLowerCase().trim()
            .normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
          return SCHOOL_ALIAS_FOR_CFBD[n] || n;
        }

        // Re-key cfbdGames by normalized school so lookups from any source
        // (JackLich10 long forms, CFBD short forms, diacritics-stripped) hit.
        const cfbdGamesNorm: Record<string, number> = {};
        for (const [k, v] of Object.entries(cfbdGames)) {
          const idx = k.lastIndexOf(':');
          if (idx < 0) continue;
          const school = normalizeSchoolForCfbd(k.slice(0, idx));
          cfbdGamesNorm[`${school}:${k.slice(idx + 1)}`] = v;
        }

        {
          // Track games per season separately to get true career total games.
          // Also track (school, season) pairs so we can back-fill games from
          // CFBD's team-level /games count when the tall stat feed doesn't
          // include a per-player 'games played' row (CFBD's /stats/player/season
          // doesn't expose one — only the legacy JackLich10 CSV does).
          const collegeTotals = new Map<string, {
            gamesBySeason: Map<number, number>;
            seasonSchools: Map<number, string>;
            receptions: number; recYds: number; rushYds: number;
            rushAtt: number; tds: number; passYds: number;
          }>();
          for (const cs of collegeStatsData) {
            const name = normalizeName(cs.player_name);
            if (!collegeTotals.has(name)) collegeTotals.set(name, { gamesBySeason: new Map(), seasonSchools: new Map(), receptions: 0, recYds: 0, rushYds: 0, rushAtt: 0, tds: 0, passYds: 0 });
            const t = collegeTotals.get(name)!;
            const school = normalizeSchoolForCfbd(cs.school || cs.school_abbr || '');
            if (school && !t.seasonSchools.has(cs.season)) {
              t.seasonSchools.set(cs.season, school);
            }
            const stat = (cs.statistic || '').toLowerCase();
            // Coerce 'NA' strings to 0 — same trap as playerSeasonStats above.
            const v = typeof cs.value === 'number' && isFinite(cs.value) ? cs.value : 0;
            if (stat.includes('game')) {
              const cur = t.gamesBySeason.get(cs.season) || 0;
              t.gamesBySeason.set(cs.season, Math.max(cur, v));
            }
            else if (stat.includes('reception') && !stat.includes('yard') && !stat.includes('td')) t.receptions += v;
            else if (stat.includes('receiving yard')) t.recYds += v;
            else if (stat.includes('rushing yard')) t.rushYds += v;
            else if (stat.includes('rushing attempt') || stat.includes('carries')) t.rushAtt += v;
            else if (stat.includes('touchdown')) t.tds += v;
            else if (stat.includes('passing yard')) t.passYds += v;
          }
          for (const [name, t] of collegeTotals) {
            // Sum games across all seasons for true career total, backfilling
            // per-season games from CFBD team totals when needed.
            let totalGames = 0;
            const allSeasons = new Set([
              ...t.gamesBySeason.keys(),
              ...t.seasonSchools.keys(),
            ]);
            for (const season of allSeasons) {
              const direct = t.gamesBySeason.get(season) || 0;
              if (direct > 0) { totalGames += direct; continue; }
              const school = t.seasonSchools.get(season) || '';
              const teamGames = (school && cfbdGamesNorm[`${school}:${season}`]) || 0;
              totalGames += teamGames > 0 ? teamGames : 12;  // 12-game fallback
            }
            const games = totalGames || 1;
            const totalYds = t.recYds + t.rushYds + t.passYds;
            collegePerGameByName.set(name, {
              games: totalGames,
              recPerGame: Math.round((t.receptions / games) * 10) / 10,
              ydsPerGame: Math.round((totalYds / games) * 10) / 10,
              tdsPerGame: Math.round((t.tds / games) * 10) / 10,
              rushYPC: t.rushAtt > 0 ? Math.round((t.rushYds / t.rushAtt) * 10) / 10 : 0,
              ydsPerRec: t.receptions > 0 ? Math.round((t.recYds / t.receptions) * 10) / 10 : 0,
            });
          }
        }

        // ── NCAA Team Data (TeamRankings SOS + team pass/rush attempts) ──
        // Real team-level data replaces incomplete aggregations from player-level stats
        const ncaaSOS = ncaaTeamData.sos as Record<string, number>;
        const ncaaPassAttPerGame = ncaaTeamData.teamPassAttPerGame as Record<string, number>;
        const ncaaRushAttPerGame = ncaaTeamData.teamRushAttPerGame as Record<string, number>;
        // TeamRankings predictive ranking (team rating, ~higher = better team).
        // Used as the "team competitiveness" measure for QB context features.
        const ncaaPredictiveRanking = (ncaaTeamData as Record<string, unknown>).predictiveRanking as Record<string, number> | undefined;

        // School name normalization: map college_statistics.csv school names to NCAA data names
        // NCAA data uses abbreviations like "c michigan", "e carolina", "fla atlantic"
        const schoolNameMap: Record<string, string> = {
          'central michigan': 'c michigan', 'eastern michigan': 'e michigan',
          'eastern carolina': 'e carolina', 'east carolina': 'e carolina',
          'western michigan': 'w michigan', 'western kentucky': 'w kentucky',
          'northern illinois': 'n illinois', 'middle tennessee': 'mid tennessee',
          'florida atlantic': 'fla atlantic', 'florida international': 'fla international',
          'florida state': 'florida st', 'ohio state': 'ohio st', 'michigan state': 'michigan st',
          'penn state': 'penn st', 'oklahoma state': 'oklahoma st', 'oregon state': 'oregon st',
          'washington state': 'washington st', 'iowa state': 'iowa st', 'kansas state': 'kansas st',
          'mississippi state': 'mississippi st', 'arizona state': 'arizona st',
          'colorado state': 'colorado st', 'fresno state': 'fresno st', 'boise state': 'boise st',
          'san diego state': 'san diego st', 'san jose state': 'san jose st',
          'arkansas state': 'arkansas st', 'ball state': 'ball st', 'kent state': 'kent st',
          'appalachian state': 'app state', 'coastal carolina': 'coastal car',
          'georgia state': 'georgia st', 'georgia southern': 'ga southern',
          'north carolina state': 'nc state', 'north carolina': 'n carolina',
          'south carolina': 's carolina', 'south florida': 's florida',
          'north texas': 'n texas', 'louisiana tech': 'la tech',
          'louisiana-lafayette': 'louisiana', 'louisiana-monroe': 'la monroe',
          'southern mississippi': 's mississippi', 'southern methodist': 'smu',
          'brigham young': 'byu', 'texas christian': 'tcu',
          'texas a&m': 'texas a&m', 'texas tech': 'texas tech',
          'virginia tech': 'virginia tech', 'georgia tech': 'georgia tech',
          'miami (fl)': 'miami', 'miami (oh)': 'miami oh',
          'uab': 'uab', 'ucf': 'ucf', 'utep': 'utep', 'utsa': 'utsa', 'unlv': 'unlv',
          'connecticut': 'uconn', 'massachusetts': 'umass',
          'southern california': 'usc',
        };
        function normalizeSchool(school: string): string {
          const s = school.toLowerCase().trim()
            .replace(/\buniversity\b/g, '').replace(/\bstate\b/g, 'st')
            .replace(/\bnorthern\b/g, 'n').replace(/\bsouthern\b/g, 's')
            .replace(/\beastern\b/g, 'e').replace(/\bwestern\b/g, 'w')
            .replace(/\bcentral\b/g, 'c').replace(/\bmiddle\b/g, 'mid')
            .replace(/\s+/g, ' ').trim();
          return schoolNameMap[s] || schoolNameMap[school.toLowerCase().trim()] || s;
        }

        // Build SOS lookup: school_lower:season → multiplier (higher = harder schedule)
        // Rating range is roughly -17 to +7, convert to multiplier centered on 1.0
        const collegeSOS = new Map<string, number>();
        for (const [key, rating] of Object.entries(ncaaSOS)) {
          // rating ~[-17, +7], mean ~0. Convert: 0 → 1.0, +7 → 1.35, -7 → 0.65
          collegeSOS.set(key, 1.0 + (rating / 20));
        }

        // TeamRankings predictive ranking: school_lower:season → team rating.
        // Roughly -40 to +40 (40 = best team in country, -40 = FCS-tier).
        // Used as the team-competitiveness measure for QB context features.
        const collegePredictiveRank = new Map<string, number>();
        if (ncaaPredictiveRanking) {
          for (const [key, rating] of Object.entries(ncaaPredictiveRanking)) {
            collegePredictiveRank.set(key, rating);
          }
        }

        // CFBD SP+ supplement: fills gaps in collegePredictiveRank + collegeSOS
        // for school:seasons the legacy NCAA source doesn't cover. SP+ rating
        // is on a comparable scale (~-30 to +35) so it can plug straight in.
        // SP+ SoS is normalized 0-1 (1 = average); convert to the same multiplier
        // shape as the legacy SOS (1.0 ± rating/20 → use ratio centered on 1.0).
        let spRatingFills = 0;
        let spSosFills = 0;
        for (const [key, sp] of Object.entries(cfbdSp)) {
          if (sp.rating != null && !collegePredictiveRank.has(key)) {
            collegePredictiveRank.set(key, sp.rating);
            spRatingFills++;
          }
          if (sp.sos != null && !collegeSOS.has(key)) {
            // SP+ SoS centers around 1.0 already; just use it directly,
            // clamped into a sane 0.5-1.5 multiplier band.
            collegeSOS.set(key, Math.max(0.5, Math.min(1.5, sp.sos)));
            spSosFills++;
          }
        }
        if (spRatingFills > 0 || spSosFills > 0) {
          onStatus?.(`SP+ filled ${spRatingFills} team ratings, ${spSosFills} SoS values`);
        }

        // Build team pass/rush attempts per season lookup
        const ncaaTeamPassAtt = new Map<string, number>(); // team:season → total season pass attempts
        const ncaaTeamRushAtt = new Map<string, number>();
        const ncaaTeamTotalPlays = new Map<string, number>();
        for (const [key, avgPerGame] of Object.entries(ncaaPassAttPerGame)) {
          ncaaTeamPassAtt.set(key, Math.round(avgPerGame * 13)); // ~13 games per season
        }
        for (const [key, avgPerGame] of Object.entries(ncaaRushAttPerGame)) {
          ncaaTeamRushAtt.set(key, Math.round(avgPerGame * 13));
        }
        for (const key of ncaaTeamPassAtt.keys()) {
          const pa = ncaaTeamPassAtt.get(key) || 0;
          const ra = ncaaTeamRushAtt.get(key) || 0;
          if (pa + ra > 0) ncaaTeamTotalPlays.set(key, pa + ra);
        }
        onStatus?.(`NCAA data loaded: ${collegeSOS.size} SOS, ${ncaaTeamPassAtt.size} team stats`);

        // ── Advanced college analytics: dominator rating, breakout age, market share ──
        // Step 1: Build per-player per-season stats AND per-school per-season team totals
        type PlayerSeasonStats = { recYds: number; recTDs: number; rushYds: number; rushTDs: number; receptions: number; rushAtt: number; passAtt: number; completions: number; games: number; school: string; pos: string };
        const playerSeasonStats = new Map<string, Map<number, PlayerSeasonStats>>(); // name → season → stats
        const schoolSeasonTotals = new Map<string, { recYds: number; recTDs: number; rushYds: number; rushTDs: number; receptions: number; rushAtt: number; passAtt: number; completions: number; totalPlays: number }>(); // "school:season" → totals
        for (const cs of collegeStatsData) {
          const name = normalizeName(cs.player_name);
          const season = cs.season;
          const school = (cs.school || cs.school_abbr || '').toLowerCase();
          const stat = (cs.statistic || '').toLowerCase();
          // JackLich10's CSV sometimes emits literal 'NA' strings for missing
          // values; those need to be coerced to 0 before any += or Math.max.
          // Without this, string concat poisons teamPassAtt etc. downstream
          // (e.g. _rawTeamPassAtt ended up as '9960NA40141' in v45).
          const v = typeof cs.value === 'number' && isFinite(cs.value) ? cs.value : 0;

          // Player per-season
          if (!playerSeasonStats.has(name)) playerSeasonStats.set(name, new Map());
          const seasons = playerSeasonStats.get(name)!;
          if (!seasons.has(season)) seasons.set(season, { recYds: 0, recTDs: 0, rushYds: 0, rushTDs: 0, receptions: 0, rushAtt: 0, passAtt: 0, completions: 0, games: 0, school, pos: cs.pos_abbr || '' });
          const ps = seasons.get(season)!;
          if (stat.includes('receiving yard')) ps.recYds += v;
          else if (stat.includes('receiving touchdown')) ps.recTDs += v;
          else if (stat.includes('rushing yard')) ps.rushYds += v;
          else if (stat.includes('rushing touchdown')) ps.rushTDs += v;
          else if (stat.includes('reception') && !stat.includes('yard') && !stat.includes('td')) ps.receptions += v;
          else if (stat.includes('rushing attempt') || stat.includes('carries')) ps.rushAtt += v;
          else if (stat.includes('passing attempt') || stat === 'pass attempts') ps.passAtt += v;
          else if (stat.includes('completion') && !stat.includes('pct')) ps.completions += v;
          else if (stat.includes('games played') || stat === 'games') ps.games = Math.max(ps.games, v);

          // School per-season totals (aggregate all players' stats)
          const schoolKey = `${school}:${season}`;
          if (!schoolSeasonTotals.has(schoolKey)) schoolSeasonTotals.set(schoolKey, { recYds: 0, recTDs: 0, rushYds: 0, rushTDs: 0, receptions: 0, rushAtt: 0, passAtt: 0, completions: 0, totalPlays: 0 });
          const st = schoolSeasonTotals.get(schoolKey)!;
          if (stat.includes('receiving yard')) st.recYds += v;
          else if (stat.includes('receiving touchdown')) st.recTDs += v;
          else if (stat.includes('rushing yard')) st.rushYds += v;
          else if (stat.includes('rushing touchdown')) st.rushTDs += v;
          else if (stat.includes('reception') && !stat.includes('yard') && !stat.includes('td')) st.receptions += v;
          else if (stat.includes('rushing attempt') || stat.includes('carries')) { st.rushAtt += v; st.totalPlays += v; }
          else if (stat.includes('passing attempt') || stat === 'pass attempts') { st.passAtt += v; st.totalPlays += v; }
          else if (stat.includes('completion') && !stat.includes('pct')) st.completions += v;
        }

        // Games-played: prefer CFBD's exact per-team-season count when
        // available, fall back to 12 (typical FBS regular season) for any
        // school+season the games endpoint missed. Replaces the previous
        // blanket 12-game default that was washing out variance.
        for (const [, seasons] of playerSeasonStats) {
          for (const [seasonYear, ps] of seasons) {
            if (ps.games > 0) continue;
            const teamGames = cfbdGames[`${ps.school}:${seasonYear}`];
            ps.games = (typeof teamGames === 'number' && teamGames > 0) ? teamGames : 12;
          }
        }

        // Step 2: Compute dominator rating, breakout age, and market share per player
        const collegeAdvancedByName = new Map<string, { dominatorRating: number; breakoutAge: number; marketShare: number }>();
        for (const [name, seasons] of playerSeasonStats) {
          let bestDominator = 0;
          let bestMarketShare = 0;
          let breakoutAge = 0;

          // Get draft age to compute per-season age
          const draft = draftByName.get(name);
          const draftAge = draft?.age || 0;
          const draftYear = draft?.season || 0;

          const sortedSeasons = [...seasons.entries()].sort((a, b) => a[0] - b[0]);
          for (const [seasonYear, ps] of sortedSeasons) {
            const schoolKey = `${ps.school}:${seasonYear}`;
            const team = schoolSeasonTotals.get(schoolKey);
            if (!team) continue;

            // Dominator Rating: % of team receiving yards + receiving TDs
            // For RBs: use rushing yards + rushing TDs share instead
            let dominator = 0;
            const pos = (ps.pos || '').toUpperCase();
            if (pos === 'RB') {
              const ydsShare = team.rushYds > 0 ? ps.rushYds / team.rushYds : 0;
              const tdShare = team.rushTDs > 0 ? ps.rushTDs / team.rushTDs : 0;
              dominator = ((ydsShare + tdShare) / 2) * 100;
            } else {
              // WR/TE: receiving dominator
              const ydsShare = team.recYds > 0 ? ps.recYds / team.recYds : 0;
              const tdShare = team.recTDs > 0 ? ps.recTDs / team.recTDs : 0;
              dominator = ((ydsShare + tdShare) / 2) * 100;
            }
            bestDominator = Math.max(bestDominator, dominator);

            // Market share: receptions/team receptions for WR/TE, rushAttempts/team for RB
            let mktShare = 0;
            if (pos === 'RB') {
              mktShare = team.rushAtt > 0 ? (ps.rushAtt / team.rushAtt) * 100 : 0;
            } else {
              mktShare = team.receptions > 0 ? (ps.receptions / team.receptions) * 100 : 0;
            }
            bestMarketShare = Math.max(bestMarketShare, mktShare);

            // Breakout age: first season with dominator rating > 20%
            if (breakoutAge === 0 && dominator > 20 && draftAge > 0 && draftYear > 0) {
              // Estimate age in that college season: draftAge - (draftYear - seasonYear)
              const ageInSeason = draftAge - (draftYear - seasonYear);
              if (ageInSeason > 17 && ageInSeason < 25) {
                breakoutAge = ageInSeason;
              }
            }
          }

          // If player never broke out (breakoutAge === 0), fall back to draft age
          // so they get the worst-case breakout age rather than a misleading 0
          if (breakoutAge === 0 && draftAge > 0) {
            breakoutAge = draftAge;
          }

          collegeAdvancedByName.set(name, {
            dominatorRating: Math.round(bestDominator * 10) / 10,
            breakoutAge: breakoutAge,
            marketShare: Math.round(bestMarketShare * 10) / 10,
          });
        }

        // Step 2b: Career-best single-season stats per player
        // Complements final-season stats: captures peak production regardless of which year
        const collegeBestSeasonByName = new Map<string, { bestRecYds: number; bestRecTDs: number; bestReceptions: number; bestRushYds: number; bestRushTDs: number; numSeasons: number }>();
        for (const [name, seasons] of playerSeasonStats) {
          let bestRecYds = 0, bestRecTDs = 0, bestReceptions = 0;
          let bestRushYds = 0, bestRushTDs = 0;
          for (const [, ps] of seasons) {
            bestRecYds = Math.max(bestRecYds, ps.recYds);
            bestRecTDs = Math.max(bestRecTDs, ps.recTDs);
            bestReceptions = Math.max(bestReceptions, ps.receptions);
            bestRushYds = Math.max(bestRushYds, ps.rushYds);
            bestRushTDs = Math.max(bestRushTDs, ps.rushTDs);
          }
          collegeBestSeasonByName.set(name, {
            bestRecYds, bestRecTDs, bestReceptions,
            bestRushYds, bestRushTDs,
            numSeasons: seasons.size,
          });
        }

        // Step 2c: ZAP-inspired features — per-team-normalized production, Breakout Score, etc.
        const collegeZapByName = new Map<string, {
          recYdsPerTeamPassAtt: number;   // best season rec yds / team pass att
          receptionShare: number;          // best season receptions / team completions
          ydsPerTeamPlay: number;          // best season total yds / team total plays
          breakoutScore: number;           // continuous age-adjusted rec yds per team pass att
          bestSeasonRecYdsPerTPA: number;  // raw best season value
          rushProductionWR: number;        // capped rush yds for WRs (versatility signal)
          earlyDeclare: number;            // 1 if left before senior year (<=3 seasons)
        }>();

        for (const [name, seasons] of playerSeasonStats) {
          const draft = draftByName.get(name);
          const draftAge = draft?.age || 0;
          const draftYear = draft?.season || 0;

          let bestRecYdsPerTPA = 0;
          let bestReceptionShare = 0;
          let bestYdsPerTeamPlay = 0;
          let breakoutScore = 0;
          let bestRushYdsSeason = 0;
          const pos = (draft?.position || '').toUpperCase();

          const sortedSeasons = [...seasons.entries()].sort((a, b) => a[0] - b[0]);
          for (const [seasonYear, ps] of sortedSeasons) {
            // ZAP: exclude seasons with <6 games
            // If games data is missing (common in college_statistics.csv), assume full season
            // if the player had meaningful production
            const gamesPlayed = ps.games > 0 ? ps.games : (ps.recYds > 0 || ps.rushYds > 0 || ps.passAtt > 0 ? 13 : 0);
            if (gamesPlayed < 6) continue;

            const schoolKey = `${ps.school}:${seasonYear}`;
            const team = schoolSeasonTotals.get(schoolKey);
            if (!team) continue;

            // Use REAL NCAA team data for denominators (not incomplete player aggregation)
            const ncaaKey = `${normalizeSchool(ps.school)}:${seasonYear}`;
            const sosMult = collegeSOS.get(ncaaKey) || 1.0;
            // Real team pass attempts from TeamRankings (falls back to player-aggregated)
            const realTeamPA = ncaaTeamPassAtt.get(ncaaKey) || (team.passAtt > 0 ? team.passAtt : 0);
            const realTeamPlays = ncaaTeamTotalPlays.get(ncaaKey) || (realTeamPA + (ncaaTeamRushAtt.get(ncaaKey) || team.rushAtt || 0));
            // Estimate team completions: ~63% completion rate × pass attempts
            const estTeamComp = realTeamPA > 0 ? Math.round(realTeamPA * 0.63) : (team.completions > 0 ? team.completions : 0);

            // Receiving yards per team pass attempt (SOS-adjusted)
            const recYdsPerTPA = realTeamPA > 0 ? (ps.recYds / realTeamPA) * sosMult : 0;
            bestRecYdsPerTPA = Math.max(bestRecYdsPerTPA, recYdsPerTPA);

            // Reception share (% of team completions)
            const recShare = estTeamComp > 0 ? ps.receptions / estTeamComp : 0;
            bestReceptionShare = Math.max(bestReceptionShare, recShare);

            // Total yards per team play (SOS-adjusted)
            const totalYds = ps.recYds + ps.rushYds;
            const ydsPerTP = realTeamPlays > 0 ? (totalYds / realTeamPlays) * sosMult : 0;
            bestYdsPerTeamPlay = Math.max(bestYdsPerTeamPlay, ydsPerTP);

            // Breakout Score: age- and SOS-adjusted rec yds per team pass att
            if (draftAge > 0 && draftYear > 0) {
              const ageInSeason = draftAge - (draftYear - seasonYear);
              if (ageInSeason > 17 && ageInSeason < 25) {
                const ageMult = 1.0 + (21 - ageInSeason) * 0.075;
                const adjRecPerTPA = recYdsPerTPA * ageMult;
                breakoutScore = Math.max(breakoutScore, adjRecPerTPA);
              }
            } else {
              breakoutScore = Math.max(breakoutScore, recYdsPerTPA);
            }

            // Rush production for WRs (capped at 500 yds — versatility signal)
            if (pos === 'WR') {
              bestRushYdsSeason = Math.max(bestRushYdsSeason, Math.min(ps.rushYds, 500));
            }
          }

          const numSeasons = seasons.size;
          const earlyDeclare = numSeasons <= 3 ? 1 : 0;

          collegeZapByName.set(name, {
            recYdsPerTeamPassAtt: Math.round(bestRecYdsPerTPA * 1000) / 1000,
            receptionShare: Math.round(bestReceptionShare * 1000) / 1000,
            ydsPerTeamPlay: Math.round(bestYdsPerTeamPlay * 1000) / 1000,
            breakoutScore: Math.round(breakoutScore * 1000) / 1000,
            bestSeasonRecYdsPerTPA: Math.round(bestRecYdsPerTPA * 1000) / 1000,
            rushProductionWR: Math.round(bestRushYdsSeason),
            earlyDeclare,
          });
        }

        // Step 2d: Teammate Score — sum of draft capital (1/pick) for schoolmates drafted in same class or recent years
        const teammateScoreByName = new Map<string, number>();
        {
          // Build school → list of drafted players with pick values
          const schoolDraftees = new Map<string, Array<{ name: string; season: number; pick: number }>>();
          for (const [name, draft] of draftByName) {
            const playerSeasons = playerSeasonStats.get(name);
            if (!playerSeasons) continue;
            // Get the player's school from their last college season
            let school = '';
            for (const [, ps] of playerSeasons) { school = ps.school; }
            if (!school || !draft.pick) continue;
            if (!schoolDraftees.has(school)) schoolDraftees.set(school, []);
            schoolDraftees.get(school)!.push({ name, season: draft.season || 0, pick: draft.pick });
          }
          // For each player, sum 1/pick for schoolmates drafted within ±2 years (excluding self)
          for (const [name, draft] of draftByName) {
            const playerSeasons = playerSeasonStats.get(name);
            if (!playerSeasons) continue;
            let school = '';
            for (const [, ps] of playerSeasons) { school = ps.school; }
            if (!school) continue;
            const mates = schoolDraftees.get(school) || [];
            const draftSeason = draft.season || 0;
            let score = 0;
            for (const m of mates) {
              if (m.name === name) continue;
              if (Math.abs(m.season - draftSeason) <= 2 && m.pick > 0) {
                score += 1 / m.pick; // higher picks = more draft capital = higher teammate score
              }
            }
            teammateScoreByName.set(name, Math.round(score * 1000) / 1000);
          }
        }

        // Step 3: Speed Score = (weight * 200) / (forty ^ 4)
        // Higher = better (heavier player running same 40 = more valuable)
        const speedScoreByName = new Map<string, number>();
        for (const [name, combine] of combineByName) {
          const wt = Number(combine.wt) || 0;
          const ft = Number(combine.forty) || 0;
          if (wt > 0 && ft > 0) {
            const ss = (wt * 200) / Math.pow(ft, 4);
            speedScoreByName.set(name, Math.round(ss * 10) / 10);
          }
        }

        // ── Position-average college stats for imputation (missing ≠ zero) ──
        // Compute averages across rookies who have data, per position
        const collegeAvgByPos = new Map<string, Record<string, number>>();
        {
          const collegeSums = new Map<string, Record<string, { sum: number; count: number }>>();
          const collegeFields = [
            'collegePassYds', 'collegePassTDs', 'collegeRushYds', 'collegeRecYds',
            'collegeRecTDs', 'collegeTotalTDs', 'collegeQBR', 'collegeRecPerGame',
            'collegeYdsPerGame', 'collegeTDsPerGame', 'collegeRushYPC',
            'collegeDominatorRating', 'collegeBreakoutAge', 'collegeMarketShare', 'collegeYdsPerRec',
            'collegeBestRecYds', 'collegeBestRecTDs', 'collegeBestReceptions', 'collegeBestRushYds',
          ];
          // Iterate all players with college data, accumulate per-position averages
          for (const [name, cs] of collegeByName) {
            // Try to determine position from draft data or prospect data
            const draft = draftByName.get(name);
            const prospect = prospectByName.get(name);
            const pos = draft?.position || prospect?.position || '';
            const normPos = pos.toUpperCase();
            if (!POSITIONS.includes(normPos)) continue;
            if (!collegeSums.has(normPos)) collegeSums.set(normPos, {});
            const sums = collegeSums.get(normPos)!;
            const pg = collegePerGameByName.get(name);
            const adv = collegeAdvancedByName.get(name);
            const best = collegeBestSeasonByName.get(name);
            const vals: Record<string, number> = {
              collegePassYds: cs?.get('Passing Yards') || 0,
              collegePassTDs: cs?.get('Passing Touchdowns') || 0,
              collegeRushYds: cs?.get('Rushing Yards') || 0,
              collegeRecYds: cs?.get('Receiving Yards') || 0,
              collegeRecTDs: cs?.get('Receiving Touchdowns') || 0,
              collegeTotalTDs: (cs?.get('Passing Touchdowns') || 0) + (cs?.get('Rushing Touchdowns') || 0) + (cs?.get('Receiving Touchdowns') || 0),
              collegeQBR: collegeQBRByName.get(name) || 0,
              collegeRecPerGame: pg?.recPerGame || 0,
              collegeYdsPerGame: pg?.ydsPerGame || 0,
              collegeTDsPerGame: pg?.tdsPerGame || 0,
              collegeRushYPC: pg?.rushYPC || 0,
              collegeYdsPerRec: pg?.ydsPerRec || 0,
              collegeDominatorRating: adv?.dominatorRating || 0,
              collegeBreakoutAge: adv?.breakoutAge || 0,
              collegeMarketShare: adv?.marketShare || 0,
              collegeBestRecYds: best?.bestRecYds || 0,
              collegeBestRecTDs: best?.bestRecTDs || 0,
              collegeBestReceptions: best?.bestReceptions || 0,
              collegeBestRushYds: best?.bestRushYds || 0,
            };
            for (const f of collegeFields) {
              if (vals[f] > 0) {
                if (!sums[f]) sums[f] = { sum: 0, count: 0 };
                sums[f].sum += vals[f];
                sums[f].count++;
              }
            }
          }
          for (const [pos, sums] of collegeSums) {
            const avgs: Record<string, number> = {};
            for (const [f, { sum, count }] of Object.entries(sums)) {
              avgs[f] = count > 0 ? Math.round((sum / count) * 10) / 10 : 0;
            }
            collegeAvgByPos.set(pos, avgs);
          }
        }

        // ── Data coverage audit ──
        {
          const draftNames = new Set(draftByName.keys());
          const collegeNames = new Set(collegeByName.keys());
          const combineNames = new Set(combineByName.keys());
          const prospectNames = new Set(prospectByName.keys());
          const speedNames = new Set(speedScoreByName.keys());
          const bestSeasonNames = new Set(collegeBestSeasonByName.keys());
          // Count drafted players with each data source
          let withCollege = 0, withCombine = 0, withProspect = 0, withSpeed = 0, withBest = 0;
          for (const name of draftNames) {
            if (collegeNames.has(name)) withCollege++;
            if (combineNames.has(name)) withCombine++;
            if (prospectNames.has(name)) withProspect++;
            if (speedNames.has(name)) withSpeed++;
            if (bestSeasonNames.has(name)) withBest++;
          }
          const total = draftNames.size;
          const pct = (n: number) => total > 0 ? `${Math.round(n / total * 100)}%` : 'N/A';
          onStatus?.(`📊 Data coverage (${total} drafted players): ` +
            `college=${pct(withCollege)} (${withCollege}), ` +
            `combine=${pct(withCombine)} (${withCombine}), ` +
            `prospect=${pct(withProspect)} (${withProspect}), ` +
            `speedScore=${pct(withSpeed)} (${withSpeed}), ` +
            `careerBest=${pct(withBest)} (${withBest})`);
          // Per-position breakdown for college data
          for (const pos of POSITIONS) {
            let posTotal = 0, posCollege = 0, posCombine = 0, posProspect = 0;
            for (const [name, draft] of draftByName) {
              if (draft.position?.toUpperCase() !== pos) continue;
              posTotal++;
              if (collegeNames.has(name)) posCollege++;
              if (combineNames.has(name)) posCombine++;
              if (prospectNames.has(name)) posProspect++;
            }
            const pp = (n: number) => posTotal > 0 ? `${Math.round(n / posTotal * 100)}%` : 'N/A';
            onStatus?.(`  ${pos}: ${posTotal} drafted → college=${pp(posCollege)}, combine=${pp(posCombine)}, prospect=${pp(posProspect)}`);
          }
        }

        // Aging curve constants (position → { peakStart, peakEnd, declineStart })
        const AGING_CURVES: Record<string, { peakStart: number; peakEnd: number; declineStart: number }> = {
          QB: { peakStart: 27, peakEnd: 32, declineStart: 35 },
          RB: { peakStart: 23, peakEnd: 26, declineStart: 28 },
          WR: { peakStart: 25, peakEnd: 29, declineStart: 31 },
          TE: { peakStart: 25, peakEnd: 29, declineStart: 31 },
        };
        // draftByName already populated above (line ~175) so it's ready
        // before the playerSeasonStats/teammateScore loops run.

        // Three draft-class context lookups from the FULL nflverse draft
        // picks dataset — NOT just rookies who made our training set, so
        // survivor bias is removed.
        //
        //   draftPickPct         — percentile within (season, position).
        //                          0 = earliest pick at position, 1 = latest.
        //   draftPickPctOverall  — percentile within the whole draft class
        //                          that season. A 1st-round WR is high at
        //                          position AND high overall; a 6th-round
        //                          RB is mid at position but bottom overall.
        //   draftClassDepth      — count of drafted players at (season,
        //                          position). Raw "how deep was this RB class".
        const draftPickPctByName = new Map<string, number>();
        const draftPickPctOverallByName = new Map<string, number>();
        const draftClassDepthByName = new Map<string, number>();
        {
          const byPosClass = new Map<string, DraftPick[]>();
          const bySeason = new Map<number, DraftPick[]>();
          for (const d of draftData) {
            if (!d.position) continue;
            const key = `${d.season}:${d.position}`;
            if (!byPosClass.has(key)) byPosClass.set(key, []);
            byPosClass.get(key)!.push(d);
            if (!bySeason.has(d.season)) bySeason.set(d.season, []);
            bySeason.get(d.season)!.push(d);
          }
          // Per-position percentile + class depth
          for (const list of byPosClass.values()) {
            list.sort((a, b) => (a.pick || 300) - (b.pick || 300));
            const n = list.length;
            for (let i = 0; i < n; i++) {
              const name = normalizeName(list[i].pfr_player_name);
              draftPickPctByName.set(name, n > 1 ? i / (n - 1) : 0);
              draftClassDepthByName.set(name, n);
            }
          }
          // Overall per-season percentile
          for (const list of bySeason.values()) {
            list.sort((a, b) => (a.pick || 300) - (b.pick || 300));
            const n = list.length;
            for (let i = 0; i < n; i++) {
              const name = normalizeName(list[i].pfr_player_name);
              draftPickPctOverallByName.set(name, n > 1 ? i / (n - 1) : 0);
            }
          }
        }

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
        // Season → (name → market ADP), saved as each training season's ADP
        // resolves so the NEXT season's history entries (and the prediction
        // season's) can fill PlayerHistory.adp — which feeds adpTrend. Only
        // real market ADP lands here, never the draft-pick proxy rows.
        const adpBySeasonHist = new Map<number, Map<string, number>>();

        for (const season of seasons) {
          onStatus?.(`Building features for ${season}...`);

          // Fetch current + prior in parallel (including injuries, NGS, PBP)
          const [
            ffcAdp, currentStats, priorStats, priorSnaps,
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
          

          // Use FFC ADP (committed snapshot); when FFC has dropped the
          // season from its year-keyed endpoint (year=2025 returns an
          // empty players array as of June 2026), fall back to the
          // committed Sleeper snapshot — deterministic, immutable, and
          // byte-identical to what the existing 2025 training caches
          // already carry. Live ESPN remains the last resort.
          let adpData = ffcAdp;
          if (adpData.length === 0) {
            const sl = await readLocalJson<{ players?: Array<{ name: string; position: string; team?: string; adp_ppr?: number }> }>(`sleeper-adp-${season}.json`);
            const slPlayers = (sl?.players ?? []).filter((p) => (p.adp_ppr ?? 0) > 0 && (p.adp_ppr ?? 999) < 999);
            if (slPlayers.length > 50) {
              adpData = slPlayers.map((p) => ({
                name: p.name, position: p.position, team: p.team || '',
                adp: p.adp_ppr as number, high: 0, low: 0, stdev: 0, timesDrafted: 0, bye: 0,
              }));
              onStatus?.(`FFC ADP empty for ${season} — using committed Sleeper snapshot (${adpData.length} players)`);
            }
          }
          if (adpData.length === 0) {
            onStatus?.(`FFC ADP empty for ${season}, trying ESPN ADP fallback...`);
            try {
              const espn = await fetchEspnADP(season);
              // Only use ESPN if it has real ADP values (not all zeros)
              const validAdp = espn.filter(e => e.adp > 0);
              if (validAdp.length > 50) {
                adpData = validAdp.map(e => ({
                  name: e.name, position: e.position, team: e.team,
                  adp: e.adp, high: 0, low: 0, stdev: 0, timesDrafted: 0, bye: 0,
                }));
                onStatus?.(`ESPN ADP fallback: ${adpData.length} players with valid ADP for ${season}`);
              } else {
                onStatus?.(`ESPN ADP has only ${validAdp.length} valid entries for ${season} — skipping`);
              }
            } catch { /* ESPN also failed */ }
          }
          // Validate ADP quality: at least 50 players with ADP > 0.
          // If ADP is stale/missing (e.g. offseason — FFC rolls to next
          // year's ADP mid-year, wiping the just-played season's 2025 data)
          // we can STILL emit rookie rows via the draft-based path below,
          // as long as NFL stats exist. Only hard-skip the season if
          // currentStats is empty — otherwise keep going with adpData=[]
          // (the ADP-based emission loop becomes a no-op and rookies still
          // get caught by the draftByName loop).
          const validAdpCount = adpData.filter(p => p.adp > 0).length;
          if (currentStats.length === 0) {
            onStatus?.(`⚠ Skipping season ${season}: no currentStats`);
            continue;
          }
          if (validAdpCount < 50) {
            onStatus?.(`⚠ ${season}: validADP=${validAdpCount}/${adpData.length} — emitting rookie rows via draft path only`);
            adpData = [];  // ADP loop below becomes a no-op; draft path still runs
          }

          // Save this season's market ADP for next season's history fill
          // (PlayerHistory.adp → adpTrend).
          adpBySeasonHist.set(season, new Map(
            adpData.filter((p) => p.adp > 0).map((p) => [normalizeName(p.name), p.adp]),
          ));

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

          // Compute player values for VOR
          const getPlayerValue = (p: SeasonTotals): number => {
            const total = p.fantasy_points_ppr || 0;
            if (vorBasis === 'ppg') {
              return p.games > 0 ? total / p.games : 0;
            }
            return total;
          };

          // Current stats lookup
          const currentByName = new Map<string, SeasonTotals>();
          for (const p of currentTotals) {
            if (POSITIONS.includes(p.position)) {
              currentByName.set(normalizeName(p.player_display_name), p);
            }
          }

          // Per-position replacement levels for VOR (flat threshold)
          const REPLACEMENT_RANKS: Record<string, number> = { QB: 12, RB: 24, WR: 24, TE: 12 };
          const vorReplacement: Record<string, number> = {};
          for (const pos of POSITIONS) {
            const sorted = currentTotals
              .filter((p) => p.position === pos)
              .sort((a, b) => getPlayerValue(b) - getPlayerValue(a));
            const idx = (REPLACEMENT_RANKS[pos] ?? 24) - 1;
            vorReplacement[pos] = Math.round((sorted[idx] ? getPlayerValue(sorted[idx]) : 0) * 10) / 10;
          }

          const allFantasy = currentTotals
            .filter((p) => POSITIONS.includes(p.position))
            .sort((a, b) => getPlayerValue(b) - getPlayerValue(a));
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
                // Season-(S-1) market ADP, captured during that season's
                // iteration (seasons ascend). 0 before ADP coverage starts,
                // which the adpTrend guard treats as "unknown".
                adp: adpBySeasonHist.get(season - 1)?.get(name) ?? 0,
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

          // Build GSIS ID → normalized name map FIRST so we can use it to
          // resolve receiver_player_id in the pbpByReceiver aggregation below.
          // Prior weekly stats have player_id (gsis_id) + player_display_name,
          // covering all receivers who played in the source season.
          const gsisToName = new Map<string, string>();
          for (const w of priorWeekly) {
            if (w.player_id && w.player_display_name) {
              gsisToName.set(w.player_id, normalizeName(w.player_display_name));
            }
          }

          // PBP-derived: aDOT, deep target %, red zone target share.
          // Resolve receivers via gsis_id (play.receiver_player_id) since
          // receiver_player_name uses abbreviated format ("Mi.Carter") that
          // doesn't match the full-name keys player rows use.
          interface PbpAgg {
            totalAirYards: number; targets: number;
            deepTargets: number; rzTargets: number;
          }
          const pbpByReceiver = new Map<string, PbpAgg>();
          const teamRZTargets = new Map<string, number>();

          for (const play of priorPbp) {
            if (play.play_type !== 'pass') continue;
            const recId: string | undefined = (play as any).receiver_player_id;
            const recName =
              (recId && gsisToName.get(recId)) ||
              (play.receiver_player_name ? normalizeName(play.receiver_player_name) : '');
            if (!recName) continue;
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
          // Build a name→position map from current + prior rosters. This is
          // broader than priorByName (which only has players who played the
          // prior season) — needed so receivers in PBP targets are classified
          // correctly when they're rookies or new-veteran acquisitions.
          // Previously caused teamRBTargetRate / teamWRTargetRate /
          // teamTETargetRate features to sit at 0% coverage across all rows.
          const playerPositionMap = new Map<string, string>();
          // gsis_id → position: preferred over name-based lookup for PBP joins
          // because PBP's receiver_player_name is abbreviated ("Mi.Carter"),
          // while receiver_player_id is the gsis_id. See backfill_team_features.py
          // for the Python mirror of this logic.
          const gsisToPositionMap = new Map<string, string>();
          for (const r of (seasonRosters || [])) {
            if (!POSITIONS.includes(r.position)) continue;
            const name = normalizeName(r.full_name || (r as any).player_name);
            playerPositionMap.set(name, r.position);
            if ((r as any).gsis_id) gsisToPositionMap.set((r as any).gsis_id, r.position);
          }
          for (const r of (priorRosters || [])) {
            if (!POSITIONS.includes(r.position)) continue;
            const name = normalizeName(r.full_name || (r as any).player_name);
            if (!playerPositionMap.has(name)) playerPositionMap.set(name, r.position);
            const gsis = (r as any).gsis_id;
            if (gsis && !gsisToPositionMap.has(gsis)) gsisToPositionMap.set(gsis, r.position);
          }

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

            // Positional target breakdown — gsis_id join is the primary lookup
            // (PBP's receiver_player_name uses abbreviated format like
            // "Mi.Carter" which doesn't match rosters' full_name). Fall back
            // to playerPositionMap then priorByName for edge cases.
            if (play.play_type === 'pass' && ((play as any).receiver_player_id || play.receiver_player_name)) {
              acc.totalTargets += 1;
              const recId: string | undefined = (play as any).receiver_player_id;
              const recName = play.receiver_player_name
                ? normalizeName(play.receiver_player_name)
                : '';
              const recPos =
                (recId && gsisToPositionMap.get(recId)) ||
                (recName && playerPositionMap.get(recName)) ||
                (recName && priorByName.get(recName)?.position);
              if (recPos === 'RB') acc.rbTargets += 1;
              else if (recPos === 'TE') acc.teTargets += 1;
              else if (recPos === 'WR') acc.wrTargets += 1;
            }

            schemeByTeam.set(team, acc);
          }
          // Set games count
          for (const [team, gameSet] of priorGamesByTeam) {
            const acc = schemeByTeam.get(team);
            if (acc) acc.games = gameSet.size;
          }

          // ── Team personnel grouping rates from participation ──
          // The PBP CSV's offense_personnel field is "not always populated" (per
          // the PlayByPlay type comment at src/types.ts:498) — using it here
          // previously resulted in 0% coverage for team11Rate / team12Rate /
          // team10Rate / etc. across the entire training cache. Participation
          // data has offense_personnel reliably populated for every offensive
          // play and is already fetched alongside PBP.
          interface PersonnelAgg {
            p11: number; p12: number; p13: number; p21: number;
            p22: number; p10: number; total: number;
            wr3plus: number; te2plus: number;
          }
          const personnelByTeam = new Map<string, PersonnelAgg>();
          for (const part of (priorParticipation || [])) {
            const team = (part as any).possession_team || '';
            const pers = (part as any).offense_personnel || '';
            if (!team || !pers) continue;
            const acc = personnelByTeam.get(team) || {
              p11: 0, p12: 0, p13: 0, p21: 0, p22: 0, p10: 0, total: 0,
              wr3plus: 0, te2plus: 0,
            };
            acc.total += 1;

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

          // Prior-season injury aggregation. All data from season S-1 — no
          // lookahead leakage. Also tracks a late-season subset (weeks 15-18
          // of S-1) as a proxy for "ended last year hurt, still dealing with
          // it entering S".
          const SOFT_TISSUE = /hamstring|groin|calf|quad|hip|thigh|achilles|ankle|foot|toe/i;
          const KNEE = /knee|acl|mcl|pcl|meniscus/i;

          interface InjAgg {
            weeks: number; gamesOut: number;
            softTissue: boolean; knee: boolean;
            lateSeasonInjured: boolean; lateSeasonInjWeeks: number;
          }
          const priorInjByName = new Map<string, InjAgg>();
          for (const inj of priorInjuries) {
            if (!POSITIONS.includes(inj.position)) continue;
            const name = normalizeName(inj.full_name);
            const acc = priorInjByName.get(name) || {
              weeks: 0, gamesOut: 0, softTissue: false, knee: false,
              lateSeasonInjured: false, lateSeasonInjWeeks: 0,
            };
            acc.weeks += 1;
            const status = (inj.report_status || '').trim();
            if (status === 'Out' || status === 'Doubtful') acc.gamesOut += 1;
            const allInjText = `${inj.report_primary_injury || ''} ${inj.report_secondary_injury || ''} ${inj.practice_primary_injury || ''} ${inj.practice_secondary_injury || ''}`;
            if (SOFT_TISSUE.test(allInjText)) acc.softTissue = true;
            if (KNEE.test(allInjText)) acc.knee = true;
            // Late-season subset from S-1 (no leakage — still prior season)
            const week = Number(inj.week || 0);
            if (week >= 15 && week <= 18 && (status === 'Out' || status === 'Doubtful' || status === 'Questionable')) {
              acc.lateSeasonInjured = true;
              acc.lateSeasonInjWeeks += 1;
            }
            priorInjByName.set(name, acc);
          }
          // Note: preseasonInjuries (current-season injuries file) was previously
          // used to build a preseasonInjByName map. That was dead in the original
          // form (filter matched nothing) and leaky in #120's fix (weeks 1-2 of
          // CURRENT season predicting CURRENT-season PPG). Removed entirely —
          // replaced by the priorInjByName late-season subset above.
          void preseasonInjuries;

          // currentByName already built above (before expected PPG curve)

          // ── Roster competition features ──

          // Current-season roster: players per team-position
          // Use latest week snapshot (highest week number)
          const rosterByTeamPos = new Map<string, Set<string>>();
          const playerTeamMap = new Map<string, string>(); // name → team
          // Team-listed physicals (height in inches, weight in lbs) — used as
          // a fallback when a player has no NFL Combine record.
          const rosterPhysicalsByName = new Map<string, { weight: number; heightIn: number }>();
          const parseRosterHeight = (h: unknown): number => {
            if (h == null) return 0;
            const s = String(h).trim();
            if (!s) return 0;
            const m = s.match(/^(\d+)\s*-\s*(\d+)$/);
            if (m) return Number(m[1]) * 12 + Number(m[2]);
            const n = Number(s);
            return isFinite(n) ? n : 0;
          };
          const captureRosterPhysicals = (r: any) => {
            const name = normalizeName(r.full_name);
            if (!name) return;
            const wt = Number(r.weight) || 0;
            const heightIn = parseRosterHeight(r.height);
            if ((wt > 0 || heightIn > 0) && !rosterPhysicalsByName.has(name)) {
              rosterPhysicalsByName.set(name, { weight: wt, heightIn });
            }
          };
          for (const r of seasonRosters) {
            // Filter to ACT-status only. Earlier code used `r.status === 'Inactive'`
            // which doesn't match nflverse status codes (real codes: ACT, INA, RES,
            // CUT, DEV, UFA, RFA, RET, ...) so historical rosters were "deep"
            // (53-man + IR + practice squad) producing huge per-position counts and
            // an inconsistent turnover signal vs the leaner 2026 roster. ACT is the
            // common code across 2010+ and gives a consistent denominator.
            if (!POSITIONS.includes(r.position) || r.status !== 'ACT') continue;
            const key = `${r.team}:${r.position}`;
            if (!rosterByTeamPos.has(key)) rosterByTeamPos.set(key, new Set());
            const name = normalizeName(r.full_name);
            rosterByTeamPos.get(key)!.add(name);
            playerTeamMap.set(name, r.team);
            captureRosterPhysicals(r);
          }

          // Prior-season roster for detecting new arrivals (ACT-only, matches
          // the current-season filter so the diff is consistent).
          const priorRosterByTeamPos = new Map<string, Set<string>>();
          for (const r of priorRosters) {
            if (!POSITIONS.includes(r.position) || r.status !== 'ACT') continue;
            const key = `${r.team}:${r.position}`;
            if (!priorRosterByTeamPos.has(key)) priorRosterByTeamPos.set(key, new Set());
            priorRosterByTeamPos.get(key)!.add(normalizeName(r.full_name));
            captureRosterPhysicals(r);
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

          // Current season team totals (for computing actual share targets in training)
          const curTeamTotalCarries = new Map<string, number>();
          const curTeamTotalTargets = new Map<string, number>();
          const curTeamTotalReceptions = new Map<string, number>();
          const curTeamTotalRushYds = new Map<string, number>();
          const curTeamTotalRecYds = new Map<string, number>();
          const curTeamTotalPassTD = new Map<string, number>();
          const curTeamTotalRushTD = new Map<string, number>();
          for (const p of currentTotals) {
            if (!POSITIONS.includes(p.position)) continue;
            const team = p.recent_team || '';
            if (!team) continue;
            curTeamTotalCarries.set(team, (curTeamTotalCarries.get(team) || 0) + (p.carries || 0));
            curTeamTotalTargets.set(team, (curTeamTotalTargets.get(team) || 0) + (p.targets || 0));
            curTeamTotalReceptions.set(team, (curTeamTotalReceptions.get(team) || 0) + (p.receptions || 0));
            curTeamTotalRushYds.set(team, (curTeamTotalRushYds.get(team) || 0) + (p.rushing_yards || 0));
            curTeamTotalRecYds.set(team, (curTeamTotalRecYds.get(team) || 0) + (p.receiving_yards || 0));
            curTeamTotalPassTD.set(team, (curTeamTotalPassTD.get(team) || 0) + (p.receiving_tds || 0));
            curTeamTotalRushTD.set(team, (curTeamTotalRushTD.get(team) || 0) + (p.rushing_tds || 0));
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
          // Keyed by `${team}:${position}` so it matches the prediction-side
          // formula (buildFeatureMatrix.ts:4515–4521 — turnover for the
          // player's own position, not max across positions). Previously this
          // map was per-team-max which produced training-time values 5×
          // larger than what the model sees at inference.
          const teamRosterTurnover = new Map<string, number>();
          for (const [key, currentNames] of rosterByTeamPos) {
            const priorNames = priorRosterByTeamPos.get(key);
            if (!priorNames) continue;
            const newPlayers = [...currentNames].filter((n) => !priorNames.has(n)).length;
            const turnover = currentNames.size > 0 ? newPlayers / currentNames.size : 0;
            teamRosterTurnover.set(key, Math.round(turnover * 1000) / 1000);
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
            if (adpPlayer.adp > 400) continue; // include deep fantasy leagues

            const normalName = normalizeName(adpPlayer.name);
            const current = currentByName.get(normalName);
            if (!current || current.position !== adpPlayer.position) continue;

            // Target: total season PPR minus replacement level
            // This is the original target that produced RB R² = 0.259
            const playerPPR = getPlayerValue(current);
            const repLevel = vorReplacement[adpPlayer.position] ?? 0;
            const vor = Math.round((playerPPR - repLevel) * 10) / 10;

            // Track for history
            rawPPGHistory.push({ position: adpPlayer.position, adp: adpPlayer.adp, ppg: current.games > 0 ? playerPPR / current.games : 0 });

            const prior = priorByName.get(normalName);
            const combine = combineByName.get(normalName);
            const rosterPhysical = rosterPhysicalsByName.get(normalName);
            const draft = draftByName.get(normalName);
            const snapAcc = snapAccum.get(normalName);
            const snapPct = snapAcc && snapAcc.count > 0 ? snapAcc.total / snapAcc.count : 0;

            const heightIn = (combine?.ht ? parseHeight(combine.ht) : 0) || rosterPhysical?.heightIn || 0;
            const wt = combine?.wt || rosterPhysical?.weight || 0;
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
              // log(pick+1) so pick #1 → 0.693 instead of 0 — avoids the
              // #1 overall looking identical to "missing data" on player
              // cards, and gives every pick a non-zero draft-capital signal.
              logDraftPick: Math.log((draft?.pick || 300) + 1),
              invDraftPick: 1 / (draft?.pick || 300),
              draftPickPct: draftPickPctByName.get(normalName) ?? 1,
              draftPickPctOverall: draftPickPctOverallByName.get(normalName) ?? 1,
              draftClassDepth: draftClassDepthByName.get(normalName) ?? 0,
              weight: wt || combineAvg.get(adpPlayer.position)?.weight || 0,
              forty: combine?.forty || combineAvg.get(adpPlayer.position)?.forty || 0,
              bench: combine?.bench || combineAvg.get(adpPlayer.position)?.bench || 0,
              vertical: combine?.vertical || combineAvg.get(adpPlayer.position)?.vertical || 0,
              broadJump: combine?.broad_jump || combineAvg.get(adpPlayer.position)?.broadJump || 0,
              cone: combine?.cone || combineAvg.get(adpPlayer.position)?.cone || 0,
              shuttle: combine?.shuttle || combineAvg.get(adpPlayer.position)?.shuttle || 0,
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

              // Injury features — all derived from season S-1 (no leakage)
              priorInjuryWeeks: priorInjByName.get(normalName)?.weeks || 0,
              priorGamesOut: priorInjByName.get(normalName)?.gamesOut || 0,
              priorLateSeasonInjured: priorInjByName.get(normalName)?.lateSeasonInjured ? 1 : 0,
              priorLateSeasonInjWeeks: priorInjByName.get(normalName)?.lateSeasonInjWeeks || 0,
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
                  // Clean "is the team's projected starter at this position"
                  // boolean. Replaces the bimodal-missing-data role
                  // teamSamePosCount was playing in the QB / RB PPG models —
                  // see scripts/eval_team_same_pos.py and the depth-chart
                  // ablation. Cleaner signal than counting roster mates.
                  isProjectedStarter: (depthRankByName.get(normalName) || 99) === 1 ? 1 : 0,
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
              // Uses position-average imputation for missing stats instead of zero-filling
              ...(() => {
                const cs = collegeByName.get(normalName);
                const pg = collegePerGameByName.get(normalName);
                const adv = collegeAdvancedByName.get(normalName);
                const best = collegeBestSeasonByName.get(normalName);
                const prospect = prospectByName.get(normalName);
                const posAvg = collegeAvgByPos.get(adpPlayer.position) || {};
                // Indicator features: 1 if data exists, 0 if imputed
                const _hasCollege = cs ? 1 : 0;
                const _hasProspect = prospect?.grade ? 1 : 0;
                const _hasCombine = combineByName.has(normalName) ? 1 : 0;
                // Helper: use raw value if available, otherwise position average
                const imp = (raw: number | undefined, field: string) => raw || posAvg[field] || 0;
                return {
                  collegePassYds: imp(cs?.get('Passing Yards'), 'collegePassYds'),
                  collegePassTDs: imp(cs?.get('Passing Touchdowns'), 'collegePassTDs'),
                  collegeRushYds: imp(cs?.get('Rushing Yards'), 'collegeRushYds'),
                  collegeRecYds: imp(cs?.get('Receiving Yards'), 'collegeRecYds'),
                  collegeRecTDs: imp(cs?.get('Receiving Touchdowns'), 'collegeRecTDs'),
                  collegeTotalTDs: cs
                    ? (cs.get('Passing Touchdowns') || 0) + (cs.get('Rushing Touchdowns') || 0) + (cs.get('Receiving Touchdowns') || 0)
                    : posAvg['collegeTotalTDs'] || 0,
                  collegeQBR: imp(collegeQBRByName.get(normalName), 'collegeQBR'),
                  // QB-specific career features. Previously only computed in
                  // the second-pass block (NFL-drafted players with no ADP),
                  // which left every ADP-ranked rookie (Mariota, Burrow,
                  // Lawrence, C. Williams, J. Daniels) with these fields
                  // undefined — the rookie career modal displayed every QB
                  // context feature as "missing". Share logic with the
                  // second-pass block and the prediction block (line ~4000).
                  ...(() => {
                    let careerPassAtt = 0, careerPassCompletions = 0;
                    let careerRushYds = 0, careerGames = 0;
                    let lastSchool = '', lastSeason = 0;
                    const ps = playerSeasonStats.get(normalName);
                    if (ps) {
                      for (const [sn, s] of ps) {
                        careerPassAtt += s.passAtt || 0;
                        careerPassCompletions += s.completions || 0;
                        careerRushYds += s.rushYds || 0;
                        careerGames += s.games || 0;
                        if (sn > lastSeason) {
                          lastSeason = sn;
                          lastSchool = s.school || lastSchool;
                        }
                      }
                    }
                    // Fallback for recent QBs not yet in nflverse college
                    // stats (Caleb Williams, Jayden Daniels, and 2025/2026
                    // classes generally). Scan CFBD usage keys for this
                    // player's max season + team.
                    if (lastSeason === 0) {
                      const cfbdK = normalName.replace(/[^a-z0-9]+/g, '');
                      const prefix = `${cfbdK}:`;
                      for (const key in cfbdPlayerUsage) {
                        if (!key.startsWith(prefix)) continue;
                        const yr = parseInt(key.split(':')[1]);
                        if (yr > lastSeason) {
                          lastSeason = yr;
                          lastSchool = (cfbdPlayerUsage[key]?.team || '').toLowerCase() || lastSchool;
                        }
                      }
                    }
                    const careerPassYds = cs?.get('Passing Yards') || 0;
                    const teamKey1 = lastSchool ? `${normalizeSchool(lastSchool)}:${lastSeason}` : '';
                    const teamKey2 = lastSchool ? `${lastSchool.toLowerCase().trim()}:${lastSeason}` : '';
                    const teamRating = (teamKey1 && collegePredictiveRank.get(teamKey1))
                      || (teamKey2 && collegePredictiveRank.get(teamKey2))
                      || 0;
                    const sosFinalYr = (teamKey1 && collegeSOS.get(teamKey1))
                      || (teamKey2 && collegeSOS.get(teamKey2))
                      || 1;
                    const careerPassYpg = careerGames > 0 ? careerPassYds / careerGames : 0;
                    const careerRushYpg = careerGames > 0 ? careerRushYds / careerGames : 0;
                    const qbContextScore = Math.round(
                      careerPassYpg * Math.max(0, teamRating + 40) * sosFinalYr
                    );
                    const qbr2yr = collegeQBR2yrByName.get(normalName) || collegeQBRByName.get(normalName);
                    return {
                      collegeQBR2yr: imp(qbr2yr, 'collegeQBR2yr'),
                      collegeRushYpgPerAge: (careerRushYpg > 0 && draftAge > 0)
                        ? Math.round((careerRushYpg / draftAge) * 100) / 100
                        : 0,
                      collegeYdsPerPassAtt: careerPassAtt > 0
                        ? Math.round((careerPassYds / careerPassAtt) * 100) / 100
                        : 0,
                      collegeSosFinalYr: Math.round(sosFinalYr * 100) / 100,
                      collegeSosXPassAtt: Math.round(teamRating * careerPassAtt),
                      collegeQbContextScore: qbContextScore,
                      collegePassAttPerRushYd: careerRushYds > 0
                        ? Math.round((careerPassAtt / careerRushYds) * 100) / 100
                        : 0,
                      // Stash raw aggregates so train_career_models.py can
                      // compute derived accuracy features (collegeCompletionPct
                      // etc.) without a full feature-matrix rebuild — matches
                      // the second-pass block at line ~2893.
                      _rawCareerPassAtt: careerPassAtt,
                      _rawCareerPassCompletions: careerPassCompletions,
                      _rawCareerPassYds: careerPassYds,
                    };
                  })(),
                  collegeGames: pg?.games || 0,
                  collegeRecPerGame: imp(pg?.recPerGame, 'collegeRecPerGame'),
                  collegeYdsPerGame: imp(pg?.ydsPerGame, 'collegeYdsPerGame'),
                  collegeTDsPerGame: imp(pg?.tdsPerGame, 'collegeTDsPerGame'),
                  collegeRushYPC: imp(pg?.rushYPC, 'collegeRushYPC'),
                  collegeYdsPerRec: imp(pg?.ydsPerRec, 'collegeYdsPerRec'),
                  // Career-best single-season stats (peak production)
                  collegeBestRecYds: imp(best?.bestRecYds, 'collegeBestRecYds'),
                  collegeBestRecTDs: imp(best?.bestRecTDs, 'collegeBestRecTDs'),
                  collegeBestReceptions: imp(best?.bestReceptions, 'collegeBestReceptions'),
                  collegeBestRushYds: imp(best?.bestRushYds, 'collegeBestRushYds'),
                  collegeSeasons: best?.numSeasons || 0,
                  prospectGrade: prospect?.grade || 0,
                  prospectPosRank: prospect?.pos_rk || 0,
                  prospectOvlRank: prospect?.ovr_rk || 0,
                  // 247 composite recruiting rank/stars from CFBD. Coverage
                  // is much higher than prospectGrade — fills in star ratings
                  // for players the legacy prospect source missed.
                  recruitStars: cfbdRecruiting[normalName.replace(/[^a-z0-9]+/g, '')]?.stars || 0,
                  recruitRating: cfbdRecruiting[normalName.replace(/[^a-z0-9]+/g, '')]?.composite_rating || 0,
                  // Aggregate 247 talent of the player's most recent college team.
                  // Look up by school:lastSeason from playerSeasonStats; when
                  // nflverse college stats haven't caught up (recent classes —
                  // 2025 RBs were entirely missing these), fall back to the
                  // max season present in cfbdPlayerUsage under this key.
                  // Mirrors the fallback in precompute-features.ts:1146.
                  ...(() => {
                    const cfbdK = normalName.replace(/[^a-z0-9]+/g, '');
                    let lastSeason = 0, lastSchool = '';
                    const ps = playerSeasonStats.get(normalName);
                    if (ps) {
                      lastSeason = Math.max(...ps.keys());
                      lastSchool = ps.get(lastSeason)?.school || '';
                    }
                    if (lastSeason === 0) {
                      const prefix = `${cfbdK}:`;
                      for (const key in cfbdPlayerUsage) {
                        if (!key.startsWith(prefix)) continue;
                        const yr = parseInt(key.split(':')[1]);
                        if (yr > lastSeason) {
                          lastSeason = yr;
                          lastSchool = (cfbdPlayerUsage[key]?.team || '').toLowerCase() || lastSchool;
                        }
                      }
                    }
                    const usageKey = lastSeason > 0 ? `${cfbdK}:${lastSeason}` : '';
                    const usage = usageKey ? cfbdPlayerUsage[usageKey] : undefined;
                    return {
                      collegeTeamTalent: (lastSchool && lastSeason)
                        ? (cfbdTeamTalent[`${lastSchool}:${lastSeason}`] || 0)
                        : 0,
                      collegeUsageOverall: usage?.overall || 0,
                      collegeUsagePass: usage?.pass || 0,
                      collegeUsageRush: usage?.rush || 0,
                    };
                  })(),
                  collegeDominatorRating: imp(adv?.dominatorRating, 'collegeDominatorRating'),
                  collegeBreakoutAge: imp(adv?.breakoutAge, 'collegeBreakoutAge'),
                  collegeBreakoutAgeDelta: adv?.breakoutAge && draftAge
                    ? Math.round((draftAge - adv.breakoutAge) * 10) / 10 : 0,
                  collegeMarketShare: imp(adv?.marketShare, 'collegeMarketShare'),
                  speedScore: speedScoreByName.get(normalName) || 0,
                  // ZAP-inspired per-team-normalized features
                  ...(() => {
                    const zap = collegeZapByName.get(normalName);
                    const draft = draftByName.get(normalName);
                    const ts = teammateScoreByName.get(normalName) || 0;
                    const ht = parseHeight(combineByName.get(normalName)?.ht || '') || 0;
                    const ss = speedScoreByName.get(normalName) || 0;
                    // Height-adjusted Speed Score for TEs: penalize short TEs
                    const htAdjSpeedScore = (ht > 0 && ss > 0) ? Math.round(ss * (ht / 76) * 10) / 10 : ss; // 76" = 6'4" baseline
                    // Draft capital × Speed Score interaction (for TEs)
                    const draftPick = draft?.pick || 0;
                    const draftCapXSpeed = (draftPick > 0 && ss > 0) ? Math.round((1 / draftPick) * ss * 1000) / 1000 : 0;
                    // RB career aggregates for dual-threat / elusiveness /
                    // goal-line features. Same computation as the historical
                    // draft loop — see the comments there for details.
                    let cRushYds = 0, cRushAtt = 0, cRushTDs = 0;
                    let cRecYds = 0, cRecTDs = 0, cGames = 0;
                    let tRushYds = 0, tRushAtt = 0, tRushTDs = 0, tRecTDs = 0;
                    const playerSeasonsADP = playerSeasonStats.get(normalName);
                    if (playerSeasonsADP) {
                      for (const [sn, pss] of playerSeasonsADP) {
                        cRushYds += pss.rushYds || 0;
                        cRushAtt += pss.rushAtt || 0;
                        cRushTDs += pss.rushTDs || 0;
                        cRecYds += pss.recYds || 0;
                        cRecTDs += pss.recTDs || 0;
                        cGames += pss.games || 0;
                        const tkey = `${pss.school}:${sn}`;
                        const team = schoolSeasonTotals.get(tkey);
                        if (team) {
                          tRushYds += team.rushYds || 0;
                          tRushAtt += team.rushAtt || 0;
                          tRushTDs += team.rushTDs || 0;
                          tRecTDs += team.recTDs || 0;
                        }
                      }
                    }
                    const rbRecYdsPerGame = cGames > 0 ? Math.round((cRecYds / cGames) * 10) / 10 : 0;
                    const rbPlayerYPC = cRushAtt > 0 ? cRushYds / cRushAtt : 0;
                    const rbTeamYPC = tRushAtt > 0 ? tRushYds / tRushAtt : 0;
                    const rbYpcOverTeam = (rbPlayerYPC > 0 && rbTeamYPC > 0)
                      ? Math.round((rbPlayerYPC - rbTeamYPC) * 100) / 100
                      : 0;
                    const rbTeamScrimmageTDs = tRushTDs + tRecTDs;
                    const rbGoalLineShare = rbTeamScrimmageTDs > 0
                      ? Math.round((cRushTDs / rbTeamScrimmageTDs) * 1000) / 1000
                      : 0;
                    return {
                      collegeRecYdsPerTeamPassAtt: zap?.recYdsPerTeamPassAtt || 0,
                      collegeReceptionShare: zap?.receptionShare || 0,
                      collegeYdsPerTeamPlay: zap?.ydsPerTeamPlay || 0,
                      collegeBreakoutScore: zap?.breakoutScore || 0,
                      collegeBestRecYdsPerTPA: zap?.bestSeasonRecYdsPerTPA || 0,
                      collegeRushProductionWR: zap?.rushProductionWR || 0,
                      collegeEarlyDeclare: zap?.earlyDeclare || 0,
                      draftPickXEarlyDeclare: (zap?.earlyDeclare || 0) * (1 / (draftPick || 300)),
                      // Dominator × late-round interaction: lifts high-producing
                      // late-round picks (Tyreek/Nacua/Diggs profile). Zero for
                      // round 1-2 (logDraftPick ≤ ln(55)≈4), positive for later
                      // picks scaled by college dominator rating.
                      collegeDominatorXLateRound: (adv?.dominatorRating || 0) *
                        Math.max(0, Math.log((draftPick || 300) + 1) - 4.0),
                      collegeExperiencePerAge: (best && draftAge > 0)
                        ? Math.round(((best.numSeasons || 0) * 13 / draftAge) * 100) / 100
                        : 0,
                      collegeTeammateScore: ts,
                      heightAdjSpeedScore: htAdjSpeedScore,
                      relativeAthleticScore: computeRAS(combine, adpPlayer.position),
                      draftCapXSpeed,
                      collegeRecYdsPerGame: rbRecYdsPerGame,
                      collegeRushYpcOverTeam: rbYpcOverTeam,
                      collegeGoalLineShare: rbGoalLineShare,
                    };
                  })(),
                  // Missing-data indicators
                  hasCollegeStats: _hasCollege,
                  hasProspectGrade: _hasProspect,
                  hasCombineData: _hasCombine,
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
                  // positive = rising. NB: at the 2024→2025 boundary the two
                  // years come from different markets (FFC vs the Sleeper
                  // snapshot), which differ by ~12-19 picks on average —
                  // tolerable noise inside a trend, but a known caveat.
                  adpTrend: prev.adp > 0 && curr.adp > 0 ? Math.round((prev.adp - curr.adp) * 10) / 10 : 0,
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
                  teamRosterTurnover: teamRosterTurnover.get(`${pTeam}:${adpPlayer.position}`) || 0,
                };
              })(),

              // ML volume projection features (populated for predictions, 0 for training)
              mlProjTeamPassAtt: 0,
              mlProjTeamRushAtt: 0,
              mlProjTeamTargets: 0,
              mlProjPlayerPPG: 0,
            };

            // Actual share targets for share prediction models (training data only)
            const curTeam = current.recent_team || '';
            const curTmTgt = curTeamTotalTargets.get(curTeam) || 1;
            const curTmCarr = curTeamTotalCarries.get(curTeam) || 1;
            const curTmRec = curTeamTotalReceptions.get(curTeam) || 1;
            const curTmRecYds = curTeamTotalRecYds.get(curTeam) || 1;
            const curTmRushYds = curTeamTotalRushYds.get(curTeam) || 1;
            const curTmPassTD = curTeamTotalPassTD.get(curTeam) || 1;
            const curTmRushTD = curTeamTotalRushTD.get(curTeam) || 1;
            features.actualTargetShare = Math.round((current.targets || 0) / curTmTgt * 1000) / 1000;
            features.actualRushShare = Math.round((current.carries || 0) / curTmCarr * 1000) / 1000;
            features.actualReceptionShare = Math.round((current.receptions || 0) / curTmRec * 1000) / 1000;
            features.actualRecYdsShare = Math.round((current.receiving_yards || 0) / curTmRecYds * 1000) / 1000;
            features.actualRushYdsShare = Math.round((current.rushing_yards || 0) / curTmRushYds * 1000) / 1000;
            features.actualPassTDShare = Math.round((current.receiving_tds || 0) / curTmPassTD * 1000) / 1000;
            features.actualRushTDShare = Math.round((current.rushing_tds || 0) / curTmRushTD * 1000) / 1000;

            // Compute raw PPG for the PPG prediction model.
            // playerPPR is PPG-valued when vorBasis='ppg' (set by
            // getPlayerValue), so in that path we skip the /games divide.
            // Previously this double-divided and produced values like 1.4
            // instead of 24 for top QBs — nuked every career-model training
            // run built against v43/v44/v45 caches.
            const playerGames = current.games || 1;
            const totalPPR = current.fantasy_points_ppr || 0;
            const rawPPG = Math.round((totalPPR / Math.max(1, playerGames)) * 10) / 10;

            rows.push({
              name: adpPlayer.name,
              position: adpPlayer.position,
              season,
              adp: adpPlayer.adp,
              vor,
              rawPPG,
              isHit: false,   // set in post-processing pass below
              isBust: false,  // set in post-processing pass below
              features,
            });
          }

          // ── Second pass: add ALL NFL-drafted players who had no fantasy ADP ──
          // Include players in their first 3 NFL seasons (draft year + 2) so the
          // career model has complete multi-year data for LOSO backtest.
          // Training rows are committed to repo so build time is a one-time cost
          {
            const existingNames = new Set(rows.filter(r => r.season === season).map(r => normalizeName(r.name)));
            for (const [draftName, draft] of draftByName) {
              if (!draft.pick) continue;
              // Include draft year and up to 2 subsequent seasons (for career model)
              const yearsFromDraft = season - (draft.season || season);
              if (yearsFromDraft < 0 || yearsFromDraft > 2) continue;
              if (!POSITIONS.includes(draft.position || '')) continue;
              if (existingNames.has(draftName)) continue;
              const current = currentByName.get(draftName);
              if (!current || current.position !== draft.position) continue;

              const playerPPR = getPlayerValue(current);
              const repLevel = vorReplacement[draft.position] ?? 0;
              const vor = Math.round((playerPPR - repLevel) * 10) / 10;
              const prior = priorByName.get(draftName);
              const combine = combineByName.get(draftName);
              const rosterPhysical = rosterPhysicalsByName.get(draftName);
              const snapAcc = snapAccum.get(draftName);
              const snapPct = snapAcc && snapAcc.count > 0 ? snapAcc.total / snapAcc.count : 0;
              const wt = combine?.wt || rosterPhysical?.weight || 0;
              const playerGames = current.games || 1;
              // Use total PPR (not playerPPR — which is PPG under ppg-basis)
              // to avoid double-dividing by games. Same bug as rookie path above.
              const totalPPR = current.fantasy_points_ppr || 0;
              const rawPPG = Math.round((totalPPR / Math.max(1, playerGames)) * 10) / 10;
              // ADP proxy: draft-year rookies have no fantasy board yet, so
              // the NFL pick is the documented stand-in. Year-2/3 players
              // who STILL have no market ADP are undrafted in fantasy
              // terms — re-using the NFL pick would claim e.g. a year-3
              // WR was a round-4 fantasy pick (this poisoned 64 rows of
              // season-2025 training data: Mingo "ADP 39" = his 2023 NFL
              // slot, real market ≈ undrafted). Deep sentinel instead.
              const UNDRAFTED_ADP = 300;
              const proxyAdp = yearsFromDraft === 0 ? draft.pick : UNDRAFTED_ADP;

              const features: Record<string, number> = {
                adp: proxyAdp,
                adpRound: Math.ceil(proxyAdp / 12),
                adpTrend: 0,
                nflDraftRound: draft.round || 8,
                nflDraftPick: draft.pick || 300,
                logDraftPick: Math.log((draft.pick || 300) + 1),
                invDraftPick: 1 / (draft.pick || 300),
                draftPickPct: draftPickPctByName.get(draftName) ?? 1,
                draftPickPctOverall: draftPickPctOverallByName.get(draftName) ?? 1,
                draftClassDepth: draftClassDepthByName.get(draftName) ?? 0,
                age: draft.age || 0,
                yearsInLeague: season - (draft.season || season),
                weight: wt || combineAvg.get(draft.position)?.weight || 0,
                forty: combine?.forty || combineAvg.get(draft.position)?.forty || 0,
                priorGames: prior?.games || 0,
                priorPPG: prior ? (prior.fantasy_points_ppr || 0) / Math.max(1, prior.games || 1) : 0,
                snapPct,
                ...(() => {
                  const cs = collegeByName.get(draftName);
                  const adv = collegeAdvancedByName.get(draftName);
                  const best = collegeBestSeasonByName.get(draftName);
                  const zap = collegeZapByName.get(draftName);
                  const ts = teammateScoreByName.get(draftName) || 0;
                  const ht = parseHeight(combine?.ht || '') || rosterPhysical?.heightIn || 0;
                  const ss = speedScoreByName.get(draftName) || 0;
                  // ── Career aggregates from per-season college stats ─
                  // These feed both QB context features AND the RB dual-
                  // threat / elusiveness / goal-line features. The raw
                  // numeric aggregates are ALSO stashed on the row (below)
                  // as `_raw*` fields so future derived features can be
                  // computed at model-training time without triggering a
                  // full feature-matrix rebuild (which is ~90 minutes).
                  let careerRushYds = 0, careerRushAtt = 0, careerRushTDs = 0;
                  let careerRecYds = 0, careerRecTDs = 0, careerReceptions = 0;
                  let careerPassAtt = 0, careerPassYds = 0, careerPassCompletions = 0;
                  let careerGames = 0;
                  let teamRushYds = 0, teamRushAtt = 0;
                  let teamRushTDs = 0, teamRecTDs = 0;
                  let teamPassAtt = 0, teamPassCompletions = 0, teamTotalPlays = 0;
                  let lastSchool = '';
                  let lastSeason = 0;
                  const playerSeasons = playerSeasonStats.get(draftName);
                  if (playerSeasons) {
                    for (const [sn, ps] of playerSeasons) {
                      careerRushYds += ps.rushYds || 0;
                      careerRushAtt += ps.rushAtt || 0;
                      careerRushTDs += ps.rushTDs || 0;
                      careerRecYds += ps.recYds || 0;
                      careerRecTDs += ps.recTDs || 0;
                      careerReceptions += ps.receptions || 0;
                      careerPassAtt += ps.passAtt || 0;
                      careerPassCompletions += ps.completions || 0;
                      careerGames += ps.games || 0;
                      if (sn > lastSeason) { lastSeason = sn; lastSchool = ps.school || lastSchool; }
                      // Accumulate the player's team totals for the seasons
                      // the player actually played, so rate features are
                      // apples-to-apples with the player's career window.
                      const tkey = `${ps.school}:${sn}`;
                      const team = schoolSeasonTotals.get(tkey);
                      if (team) {
                        teamRushYds += team.rushYds || 0;
                        teamRushAtt += team.rushAtt || 0;
                        teamRushTDs += team.rushTDs || 0;
                        teamRecTDs += team.recTDs || 0;
                        teamPassAtt += team.passAtt || 0;
                        teamPassCompletions += team.completions || 0;
                        teamTotalPlays += team.totalPlays || 0;
                      }
                    }
                  }
                  // CFBD fallback: recent rookies (2025 class was 100%
                  // missing) aren't in nflverse college stats yet, so
                  // lastSeason/lastSchool stay 0 and the CFBD lookups below
                  // yield 0 for recruit rating, usage, and team talent.
                  // Match the fallback precompute-features.ts:1146 uses.
                  if (lastSeason === 0) {
                    const cfbdK = draftName.replace(/[^a-z0-9]+/g, '');
                    const prefix = `${cfbdK}:`;
                    for (const key in cfbdPlayerUsage) {
                      if (!key.startsWith(prefix)) continue;
                      const yr = parseInt(key.split(':')[1]);
                      if (yr > lastSeason) {
                        lastSeason = yr;
                        lastSchool = (cfbdPlayerUsage[key]?.team || '').toLowerCase() || lastSchool;
                      }
                    }
                  }
                  // collegeByName has career-total passing yards from
                  // college_statistics.csv (final-year / all-years depending
                  // on the upstream aggregation) which is more reliable than
                  // playerSeasonStats.passYds for QBs. Store it here as a
                  // fallback source for QB derived features.
                  careerPassYds = cs?.get('Passing Yards') || 0;
                  // RB-specific rate features (zero for other positions
                  // since they're filtered out of the RB feature list).
                  const collegeRecYdsPerGame = careerGames > 0
                    ? Math.round((careerRecYds / careerGames) * 10) / 10
                    : 0;
                  const playerRushYPC = careerRushAtt > 0 ? careerRushYds / careerRushAtt : 0;
                  const teamRushYPC = teamRushAtt > 0 ? teamRushYds / teamRushAtt : 0;
                  const collegeRushYpcOverTeam = (playerRushYPC > 0 && teamRushYPC > 0)
                    ? Math.round((playerRushYPC - teamRushYPC) * 100) / 100
                    : 0;
                  const teamScrimmageTDs = teamRushTDs + teamRecTDs;
                  const collegeGoalLineShare = teamScrimmageTDs > 0
                    ? Math.round((careerRushTDs / teamScrimmageTDs) * 1000) / 1000
                    : 0;
                  const careerYdsPerPassAtt = careerPassAtt > 0
                    ? Math.round(((cs?.get('Passing Yards') || 0) / careerPassAtt) * 100) / 100
                    : 0;
                  const careerRushYpg = careerGames > 0 ? careerRushYds / careerGames : 0;
                  // Team competitiveness from TeamRankings predictive rating.
                  // Try the normalized school name first, then raw lowercase.
                  const teamKey1 = lastSchool ? `${normalizeSchool(lastSchool)}:${lastSeason}` : '';
                  const teamKey2 = lastSchool ? `${lastSchool.toLowerCase().trim()}:${lastSeason}` : '';
                  const teamRating = (teamKey1 && collegePredictiveRank.get(teamKey1))
                    || (teamKey2 && collegePredictiveRank.get(teamKey2))
                    || 0;
                  // Final-year SOS — kept on its own for QBs, also as a
                  // factor in the production × team × SOS composite.
                  const sosFinalYr = (teamKey1 && collegeSOS.get(teamKey1))
                    || (teamKey2 && collegeSOS.get(teamKey2))
                    || 1;
                  // QB production proxy: career passing yards per game.
                  // Uses final-year passing yards from collegeByName as a
                  // floor (we don't have multi-year passYds in playerSeasonStats).
                  const careerPassYpg = careerGames > 0
                    ? (cs?.get('Passing Yards') || 0) / careerGames
                    : 0;
                  // Composite: production × team × SOS. Shift teamRating by
                  // +40 so the multiplicand is always non-negative.
                  const qbContextScore = Math.round(
                    careerPassYpg * Math.max(0, teamRating + 40) * sosFinalYr
                  );
                  return {
                    collegeRecYds: cs?.get('Receiving Yards') || 0,
                    collegeRecTDs: cs?.get('Receiving Touchdowns') || 0,
                    collegeRushYds: cs?.get('Rushing Yards') || 0,
                    collegeTotalTDs: (cs?.get('Passing Touchdowns') || 0) + (cs?.get('Rushing Touchdowns') || 0) + (cs?.get('Receiving Touchdowns') || 0),
                    collegePassTDs: cs?.get('Passing Touchdowns') || 0,
                    collegeQBR: collegeQBRByName.get(draftName) || 0,
                    collegeQBR2yr: collegeQBR2yrByName.get(draftName) || collegeQBRByName.get(draftName) || 0,
                    collegeRushYpgPerAge: (careerRushYpg > 0 && draft.age && draft.age > 0)
                      ? Math.round((careerRushYpg / draft.age) * 100) / 100
                      : 0,
                    collegeYdsPerPassAtt: careerYdsPerPassAtt,
                    collegeSosFinalYr: Math.round(sosFinalYr * 100) / 100,
                    collegeSosXPassAtt: Math.round(teamRating * careerPassAtt),
                    collegeQbContextScore: qbContextScore,
                    collegePassAttPerRushYd: careerRushYds > 0
                      ? Math.round((careerPassAtt / careerRushYds) * 100) / 100
                      : 0,
                    collegeDominatorRating: adv?.dominatorRating || 0,
                    collegeBreakoutAge: adv?.breakoutAge || 0,
                    collegeMarketShare: adv?.marketShare || 0,
                    collegeBestRecYds: best?.bestRecYds || 0,
                    collegeSeasons: best?.numSeasons || 0,
                    collegeEarlyDeclare: (best?.numSeasons || 99) <= 3 ? 1 : 0,
                    draftPickXEarlyDeclare: ((best?.numSeasons || 99) <= 3 ? 1 : 0) * (1 / (draft.pick || 300)),
                    collegeDominatorXLateRound: (adv?.dominatorRating || 0) *
                      Math.max(0, Math.log((draft.pick || 300) + 1) - 4.0),
                    collegeExperiencePerAge: (best && draft.age && draft.age > 0)
                      ? Math.round(((best.numSeasons || 0) * 13 / draft.age) * 100) / 100
                      : 0,
                    speedScore: ss,
                    heightAdjSpeedScore: (ht > 0 && ss > 0) ? Math.round(ss * (ht / 76) * 10) / 10 : ss,
                    relativeAthleticScore: computeRAS(combine, draft.position),
                    collegeRecYdsPerTeamPassAtt: zap?.recYdsPerTeamPassAtt || 0,
                    collegeReceptionShare: zap?.receptionShare || 0,
                    collegeBreakoutScore: zap?.breakoutScore || 0,
                    collegeRushProductionWR: zap?.rushProductionWR || 0,
                    collegeTeammateScore: ts,
                    collegeRecYdsPerGame,
                    collegeRushYpcOverTeam,
                    collegeGoalLineShare,
                    // CFBD-sourced features. Previously only computed in the
                    // first-pass ADP block, leaving every NFL-drafted rookie
                    // without fantasy ADP with 0 for recruit stars / rating,
                    // team talent, and college usage. The RB model uses
                    // collegeUsageOverall + recruitRating, WR + TE use
                    // recruitStars — so 163 RBs / 313 WRs / 165 TEs were
                    // effectively zeroed on their most important non-draft
                    // signals. Share logic with the first-pass block at
                    // line ~2394.
                    recruitStars: cfbdRecruiting[draftName.replace(/[^a-z0-9]+/g, '')]?.stars || 0,
                    recruitRating: cfbdRecruiting[draftName.replace(/[^a-z0-9]+/g, '')]?.composite_rating || 0,
                    collegeTeamTalent: lastSchool
                      ? (cfbdTeamTalent[`${lastSchool}:${lastSeason}`] || 0)
                      : 0,
                    collegeUsageOverall: lastSeason > 0
                      ? (cfbdPlayerUsage[`${draftName.replace(/[^a-z0-9]+/g, '')}:${lastSeason}`]?.overall || 0)
                      : 0,
                    collegeUsagePass: lastSeason > 0
                      ? (cfbdPlayerUsage[`${draftName.replace(/[^a-z0-9]+/g, '')}:${lastSeason}`]?.pass || 0)
                      : 0,
                    collegeUsageRush: lastSeason > 0
                      ? (cfbdPlayerUsage[`${draftName.replace(/[^a-z0-9]+/g, '')}:${lastSeason}`]?.rush || 0)
                      : 0,
                    hasCollegeStats: cs ? 1 : 0,
                    // ── Raw career aggregates ────────────────────────
                    // Stashed so future derived features can be added in
                    // rookieCareerModel.ts without triggering a ~90-min
                    // buildFeatureMatrix rebuild. `_raw*` prefix keeps
                    // them out of the featureKeys lookup in Ridge/GBM —
                    // they're inputs, not model features themselves.
                    // Bump CACHE_PATH if you change the set of raws.
                    _rawCareerRushYds: careerRushYds,
                    _rawCareerRushAtt: careerRushAtt,
                    _rawCareerRushTDs: careerRushTDs,
                    _rawCareerRecYds: careerRecYds,
                    _rawCareerReceptions: careerReceptions,
                    _rawCareerRecTDs: careerRecTDs,
                    _rawCareerPassAtt: careerPassAtt,
                    _rawCareerPassYds: careerPassYds,
                    _rawCareerPassCompletions: careerPassCompletions,
                    _rawCareerGames: careerGames,
                    _rawTeamRushYds: teamRushYds,
                    _rawTeamRushAtt: teamRushAtt,
                    _rawTeamRushTDs: teamRushTDs,
                    _rawTeamRecTDs: teamRecTDs,
                    _rawTeamPassAtt: teamPassAtt,
                    _rawTeamPassCompletions: teamPassCompletions,
                    _rawTeamTotalPlays: teamTotalPlays,
                    _rawLastSeason: lastSeason,
                  };
                })(),
              };

              rows.push({
                name: current.player_display_name || draftName,
                position: draft.position,
                season,
                adp: proxyAdp,
                vor,
                rawPPG,
                isHit: false,
                isBust: false,
                features,
              });
            }
          }
        }

        // ── Hit/bust labels: actual PPR / expected PPR, then z-score ────────
        // Expected PPR = ADP→PPG sqrt fit per position. The functional form
        // is `PPG = intercept + slope * sqrt(ADP)` — sqrt was chosen
        // empirically (LOSO MAE) over linear/log/inverse/quadratic; it
        // captures the elite-tier dropoff cleanly without the edge
        // pathologies of log (blowup near ADP=0) or quadratic (non-monotone
        // extremes). Ratio = actual / expected. Z-score the ratio, then
        // threshold. This means a round-1 RB at 15 PPG can be a bust
        // (expected 18+), while a round-8 RB at 15 PPG is a hit (expected 8).
        for (const pos of POSITIONS) {
          const posRows = rows.filter((r) => r.position === pos);
          if (posRows.length < 10) continue;

          // Fit ADP→PPG sqrt curve for this position (across all seasons)
          const sqrtAdps = posRows.map((r) => Math.sqrt(r.adp));
          const ppgs = posRows.map((r) => r.rawPPG);
          const xMean = sqrtAdps.reduce((a, b) => a + b, 0) / sqrtAdps.length;
          const ppgMean = ppgs.reduce((a, b) => a + b, 0) / ppgs.length;
          let ssX = 0, ssXPpg = 0;
          for (let i = 0; i < sqrtAdps.length; i++) {
            ssX += (sqrtAdps[i] - xMean) ** 2;
            ssXPpg += (sqrtAdps[i] - xMean) * (ppgs[i] - ppgMean);
          }
          const slope = ssX > 0 ? ssXPpg / ssX : 0;
          const intercept = ppgMean - slope * xMean;

          // Compute ratio = actual PPG / expected PPG for each player
          const ratios: number[] = [];
          for (const r of posRows) {
            const expectedPPG = Math.max(1, intercept + slope * Math.sqrt(r.adp)); // floor at 1 to avoid division issues
            const ratio = r.rawPPG / expectedPPG;
            ratios.push(ratio);
          }

          // Z-score the ratios
          const ratioMean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
          const ratioVar = ratios.reduce((s, v) => s + (v - ratioMean) ** 2, 0) / ratios.length;
          const ratioStd = Math.sqrt(ratioVar) || 1;

          // Label using z-score thresholds
          const HIT_Z = 0.5;   // meaningfully above expectations
          const BUST_Z = -0.5; // meaningfully below expectations
          const zScores: number[] = [];
          for (let i = 0; i < posRows.length; i++) {
            const z = (ratios[i] - ratioMean) / ratioStd;
            zScores.push(z);
            posRows[i].isHit = z > HIT_Z;
            posRows[i].isBust = z < BUST_Z;
          }

          // Diagnostic: show distribution at various thresholds
          const n = posRows.length;
          const countAbove = (t: number) => zScores.filter(z => z > t).length;
          const countBelow = (t: number) => zScores.filter(z => z < t).length;
          onStatus?.(`  ${pos} hit/bust (n=${n}): ` +
            `ADP→PPG curve: PPG = ${intercept.toFixed(1)} + ${slope.toFixed(4)}*sqrt(ADP) | ` +
            `z>0.0: ${countAbove(0)} (${Math.round(countAbove(0)/n*100)}%), ` +
            `z>0.5: ${countAbove(0.5)} (${Math.round(countAbove(0.5)/n*100)}%), ` +
            `z>1.0: ${countAbove(1)} (${Math.round(countAbove(1)/n*100)}%) | ` +
            `z<0.0: ${countBelow(0)} (${Math.round(countBelow(0)/n*100)}%), ` +
            `z<-0.5: ${countBelow(-0.5)} (${Math.round(countBelow(-0.5)/n*100)}%), ` +
            `z<-1.0: ${countBelow(-1)} (${Math.round(countBelow(-1)/n*100)}%)`);
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
        // League-mean team volumes derived from the prior season (assigned
        // inside the predPriorTotals block below). Consumed by the volume
        // post-processing pass at the bottom of this function so our
        // league-calibration factor tracks the most recent season instead
        // of a hardcoded constant.
        let leagueVolumeTargets: { pass: number; rush: number; targets: number } | null = null;
        {
          const predSeason = predictSeason;
          const priorSeason = predSeason - 1;

          const [
            predFfcAdpData, predPriorStats, predPriorSnaps,
            predPriorInjuries, predPreseasonInjuries,
            predPriorNgsRec, predPriorNgsRush, predPriorNgsPass,
            predPriorPbp, predPriorParticipation,
            predSeasonRosters, predPriorRosters, predSeasonDepthCharts,
          ] = await Promise.all([
            fetchFfcADP(predSeason, 'ppr', 12).catch(() => [] as FfcADPPlayer[]),
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

          // ── Current-season market price = weighted blend of FFC and the
          // Sleeper draft-room snapshot (sample × recency weights, the same
          // regime the UI's adpSources.ts applies). FFC's offseason file can
          // be a thin, months-old window — the committed "2026" file once
          // carried only Sept-2025 mocks — so blending keeps the scoring
          // pool priced sanely when one market goes stale, and Sleeper-only
          // players (rookies, deep vets FFC hasn't priced) join the pool.
          const predAdpData = await (async () => {
            const [ffcRawDoc, sleeperDoc] = await Promise.all([
              readLocalJson<{ meta?: { end_date?: string }; players?: Array<{ name: string; times_drafted?: number }> }>(`ffc_adp_ppr_${predSeason}.json`),
              readLocalJson<{ fetchedAt?: string; players?: Array<{ name: string; position: string; team?: string; adp_ppr?: number }> }>(`sleeper-adp-${predSeason}.json`),
            ]);
            const ffcFileW = recencyWeight(ffcRawDoc?.meta?.end_date);
            const sleeperW = recencyWeight(sleeperDoc?.fetchedAt);
            const tdByName = new Map((ffcRawDoc?.players ?? []).map((p) => [normalizeName(p.name), p.times_drafted]));
            const slByName = new Map((sleeperDoc?.players ?? [])
              .filter((p) => (p.adp_ppr ?? 0) > 0 && (p.adp_ppr ?? 999) < 999)
              .map((p) => [normalizeName(p.name), p]));
            if (slByName.size === 0) return predFfcAdpData;

            const blended: FfcADPPlayer[] = [];
            const seen = new Set<string>();
            for (const p of predFfcAdpData) {
              const nn = normalizeName(p.name);
              seen.add(nn);
              const sl = slByName.get(nn);
              const adp = blendPicks(
                { adp: p.adp, weight: sampleWeight(tdByName.get(nn) ?? p.timesDrafted) * ffcFileW },
                sl ? { adp: sl.adp_ppr as number, weight: sleeperW } : undefined,
              ) ?? p.adp;
              blended.push({ ...p, adp });
            }
            for (const [nn, sl] of slByName) {
              if (seen.has(nn) || !POSITIONS.includes(sl.position)) continue;
              blended.push({
                name: sl.name, position: sl.position, team: sl.team || '',
                adp: sl.adp_ppr as number, high: 0, low: 0, stdev: 0, timesDrafted: 0, bye: 0,
              });
            }
            onStatus?.(`Blended ${predSeason} market ADP: ${predFfcAdpData.length} FFC + ${slByName.size} Sleeper → ${blended.length} players`);
            return blended;
          })();

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

            // Derive league-mean team volumes from the prior season so the
            // volume-pass calibration target tracks the most recent NFL data
            // instead of a hardcoded constant. Aggregate player stats by
            // team and average across all teams represented.
            {
              const passByTeam = new Map<string, number>();
              const rushByTeam = new Map<string, number>();
              const tgtByTeam = new Map<string, number>();
              for (const p of predPriorTotals) {
                const team = p.recent_team;
                if (!team) continue;
                passByTeam.set(team, (passByTeam.get(team) || 0) + (p.attempts || 0));
                rushByTeam.set(team, (rushByTeam.get(team) || 0) + (p.carries || 0));
                tgtByTeam.set(team, (tgtByTeam.get(team) || 0) + (p.targets || 0));
              }
              const teamCount = passByTeam.size;
              // Guard against thin prior-season data — require ≥ 28 teams
              // before overriding hardcoded defaults.
              if (teamCount >= 28) {
                leagueVolumeTargets = {
                  pass: [...passByTeam.values()].reduce((a, b) => a + b, 0) / teamCount,
                  rush: [...rushByTeam.values()].reduce((a, b) => a + b, 0) / teamCount,
                  targets: [...tgtByTeam.values()].reduce((a, b) => a + b, 0) / teamCount,
                };
              }
            }

            // ── Projection features for prediction season (scenario adjustments applied here) ──
            const predProjFeatures = computePlayerProjectionFeatures(predPriorStats, scenario);

            // Push the most-recent (predSeason-1) entry into the shared
            // `playerHistoryMap`. The training-row loop only pushes Y-1
            // entries for *training* seasons, so without this push the
            // map ends at predSeason-2 and momentum / multi-year prior
            // features (ppgTrend, priorPPG2yr, durabilityStreak) are
            // silently zero for every 2026 prediction. Confirmed bug
            // pre-fix: 100% of 2026 predRows had priorPPG2yr undefined,
            // ppgTrend = 0 — making the QB model regress every elite
            // vet to ~16 PPG because it couldn't see their priors.
            for (const p of predPriorTotals) {
              if (!POSITIONS.includes(p.position)) continue;
              const name = normalizeName(p.player_display_name);
              if (!playerHistoryMap.has(name)) playerHistoryMap.set(name, []);
              const hist = playerHistoryMap.get(name)!;
              if (!hist.some((h) => h.season === predSeason - 1)) {
                const games = p.games || 1;
                hist.push({
                  season: predSeason - 1,
                  ppg: games > 0 ? (p.fantasy_points_ppr || 0) / games : 0,
                  targets: p.targets || 0,
                  touches: (p.carries || 0) + (p.receptions || 0),
                  snapPct: 0,
                  targetShare: 0,
                  adp: adpBySeasonHist.get(predSeason - 1)?.get(name) ?? 0,
                });
              }
            }

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

            // Build GSIS ID → name map FIRST (needed for PBP receiver join
            // below since receiver_player_name is abbreviated "Mi.Carter"
            // which doesn't match full-name keys).
            const predGsisToName = new Map<string, string>();
            for (const w of predPriorWeekly) {
              if (w.player_id && w.player_display_name) predGsisToName.set(w.player_id, normalizeName(w.player_display_name));
            }

            // PBP-derived: resolve receivers via gsis_id with name fallback.
            interface PredPbpAgg {
              totalAirYards: number; targets: number; deepTargets: number; rzTargets: number;
            }
            const predPbpByReceiver = new Map<string, PredPbpAgg>();
            const predTeamRZTargets = new Map<string, number>();
            for (const play of predPriorPbp) {
              if (play.play_type !== 'pass') continue;
              const recId: string | undefined = (play as any).receiver_player_id;
              const recName =
                (recId && predGsisToName.get(recId)) ||
                (play.receiver_player_name ? normalizeName(play.receiver_player_name) : '');
              if (!recName) continue;
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

            // Participation-derived (gsisToName was built above)
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

            // Injury — all from prior season (predSeason - 1), no leakage.
            // Also tracks the late-prior-season subset (weeks 15-18 of S-1)
            // as a proxy for "ended last year hurt". See training-path
            // comment for why we don't touch current-season injury data.
            const SOFT_TISSUE_PRED = /hamstring|groin|calf|quad|hip|thigh|achilles|ankle|foot|toe/i;
            const KNEE_PRED = /knee|acl|mcl|pcl|meniscus/i;
            interface PredInjAgg {
              weeks: number; gamesOut: number;
              softTissue: boolean; knee: boolean;
              lateSeasonInjured: boolean; lateSeasonInjWeeks: number;
            }
            const predPriorInjByName = new Map<string, PredInjAgg>();
            for (const inj of predPriorInjuries) {
              if (!POSITIONS.includes(inj.position)) continue;
              const name = normalizeName(inj.full_name);
              const acc = predPriorInjByName.get(name) || {
                weeks: 0, gamesOut: 0, softTissue: false, knee: false,
                lateSeasonInjured: false, lateSeasonInjWeeks: 0,
              };
              acc.weeks += 1;
              const status = (inj.report_status || '').trim();
              if (status === 'Out' || status === 'Doubtful') acc.gamesOut += 1;
              const allInjText = `${inj.report_primary_injury || ''} ${inj.report_secondary_injury || ''} ${inj.practice_primary_injury || ''} ${inj.practice_secondary_injury || ''}`;
              if (SOFT_TISSUE_PRED.test(allInjText)) acc.softTissue = true;
              if (KNEE_PRED.test(allInjText)) acc.knee = true;
              const week = Number(inj.week || 0);
              if (week >= 15 && week <= 18 && (status === 'Out' || status === 'Doubtful' || status === 'Questionable')) {
                acc.lateSeasonInjured = true;
                acc.lateSeasonInjWeeks += 1;
              }
              predPriorInjByName.set(name, acc);
            }
            void predPreseasonInjuries; // no longer used — was dead or leaky

            // ── Roster competition for predictions ──
            const predRosterByTeamPos = new Map<string, Set<string>>();
            const predPlayerTeamMap = new Map<string, string>();
            const predHeadshotByName = new Map<string, string>(); // normalised name → headshot URL
            const predRosterPhysicalsByName = new Map<string, { weight: number; heightIn: number }>();
            const parsePredRosterHeight = (h: unknown): number => {
              if (h == null) return 0;
              const s = String(h).trim();
              if (!s) return 0;
              const m = s.match(/^(\d+)\s*-\s*(\d+)$/);
              if (m) return Number(m[1]) * 12 + Number(m[2]);
              const n = Number(s);
              return isFinite(n) ? n : 0;
            };
            const capturePredRosterPhysicals = (r: any) => {
              const name = normalizeName(r.full_name);
              if (!name) return;
              const wt = Number(r.weight) || 0;
              const heightIn = parsePredRosterHeight(r.height);
              if ((wt > 0 || heightIn > 0) && !predRosterPhysicalsByName.has(name)) {
                predRosterPhysicalsByName.set(name, { weight: wt, heightIn });
              }
            };
            for (const r of predSeasonRosters) {
              // ACT-status filter matches the training-side filter so the feature
              // has consistent semantics across both phases. See the comment at
              // the training-side roster loop for why.
              if (!POSITIONS.includes(r.position) || r.status !== 'ACT') continue;
              const key = `${r.team}:${r.position}`;
              if (!predRosterByTeamPos.has(key)) predRosterByTeamPos.set(key, new Set());
              const name = normalizeName(r.full_name);
              predRosterByTeamPos.get(key)!.add(name);
              predPlayerTeamMap.set(name, r.team);
              if (r.headshot_url) predHeadshotByName.set(name, r.headshot_url);
              capturePredRosterPhysicals(r);
            }
            // Name aliases: ADP sources sometimes use different names than nflverse rosters.
            // Map alternative names → same team so predPlayerTeamMap lookups succeed.
            const NAME_ALIASES: Record<string, string> = {
              'hollywood brown': 'marquise brown',
              'joshua palmer': 'josh palmer',
            };
            for (const [alias, canonical] of Object.entries(NAME_ALIASES)) {
              const team = predPlayerTeamMap.get(canonical);
              if (team && !predPlayerTeamMap.has(alias)) {
                predPlayerTeamMap.set(alias, team);
              }
            }
            const predPriorRosterByTeamPos = new Map<string, Set<string>>();
            for (const r of predPriorRosters) {
              // ACT-only — same rationale as the current-season filter above.
              if (!POSITIONS.includes(r.position) || r.status !== 'ACT') continue;
              const key = `${r.team}:${r.position}`;
              if (!predPriorRosterByTeamPos.has(key)) predPriorRosterByTeamPos.set(key, new Set());
              predPriorRosterByTeamPos.get(key)!.add(normalizeName(r.full_name));
              capturePredRosterPhysicals(r);
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
            // Name→position and gsis→position lookups (same pattern as the
            // training path above — see comment there).
            const predPlayerPositionMap = new Map<string, string>();
            const predGsisToPositionMap = new Map<string, string>();
            for (const r of (predSeasonRosters || [])) {
              if (!POSITIONS.includes(r.position)) continue;
              const name = normalizeName(r.full_name || (r as any).player_name);
              predPlayerPositionMap.set(name, r.position);
              if ((r as any).gsis_id) predGsisToPositionMap.set((r as any).gsis_id, r.position);
            }
            for (const r of (predPriorRosters || [])) {
              if (!POSITIONS.includes(r.position)) continue;
              const name = normalizeName(r.full_name || (r as any).player_name);
              if (!predPlayerPositionMap.has(name)) predPlayerPositionMap.set(name, r.position);
              const gsis = (r as any).gsis_id;
              if (gsis && !predGsisToPositionMap.has(gsis)) predGsisToPositionMap.set(gsis, r.position);
            }

            interface PredSchemeAgg {
              passes: number; rushes: number; plays: number; games: number;
              neutralPasses: number; neutralPlays: number;
              firstDownRuns: number; firstDownPlays: number;
              shotgunPlays: number; noHuddlePlays: number;
              rbTargets: number; teTargets: number; wrTargets: number; totalTargets: number;
            }
            const predSchemeByTeam = new Map<string, PredSchemeAgg>();
            const predPriorGamesByTeam = new Map<string, Set<string>>();
            // Personnel aggregation for predictions — fed from participation
            // below (see training path for the rationale: PBP's
            // offense_personnel field is "not always populated").
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
              if (play.play_type === 'pass' && ((play as any).receiver_player_id || play.receiver_player_name)) {
                acc.totalTargets += 1;
                const recId: string | undefined = (play as any).receiver_player_id;
                const recName = play.receiver_player_name
                  ? normalizeName(play.receiver_player_name)
                  : '';
                const recPos =
                  (recId && predGsisToPositionMap.get(recId)) ||
                  (recName && predPlayerPositionMap.get(recName)) ||
                  (recName && predPriorByName.get(recName)?.position);
                if (recPos === 'RB') acc.rbTargets += 1;
                else if (recPos === 'TE') acc.teTargets += 1;
                else if (recPos === 'WR') acc.wrTargets += 1;
              }
              predSchemeByTeam.set(team, acc);
            }
            for (const [team, gameSet] of predPriorGamesByTeam) {
              const acc = predSchemeByTeam.get(team);
              if (acc) acc.games = gameSet.size;
            }

            // Personnel aggregation from participation (reliable offense_personnel)
            for (const part of (predPriorParticipation || [])) {
              const team = (part as any).possession_team || '';
              const pers = (part as any).offense_personnel || '';
              if (!team || !pers) continue;
              const persAcc = predPersonnelByTeam.get(team) || {
                p11: 0, p12: 0, p13: 0, p21: 0, p22: 0, p10: 0, total: 0,
                wr3plus: 0, te2plus: 0,
              };
              persAcc.total += 1;
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
              if (adpPlayer.adp > 400) continue; // include deep fantasy leagues

              const normalName = normalizeName(adpPlayer.name);
              const prior = predPriorByName.get(normalName);
              const combine = combineByName.get(normalName);
              const rosterPhysical = predRosterPhysicalsByName.get(normalName);
              const draft = draftByName.get(normalName);
              const snapAcc = predSnapAccum.get(normalName);
              const snapPct = snapAcc && snapAcc.count > 0 ? snapAcc.total / snapAcc.count : 0;

              const heightIn = (combine?.ht ? parseHeight(combine.ht) : 0) || rosterPhysical?.heightIn || 0;
              const wt = combine?.wt || rosterPhysical?.weight || 0;
              const bmi = heightIn > 0 && wt > 0 ? (703 * wt) / (heightIn * heightIn) : 0;

              const priorGames = prior?.games || 0;
              const priorPPR = prior?.fantasy_points_ppr || 0;
              const priorAttempts = prior?.attempts || 0;
              const priorCarries = prior?.carries || 0;

              const draftAge = draft?.age || 0;
              const draftYear = draft?.season || 0;
              // Position-median draft age fallback for players missing a
              // birthdate on the nflverse draft row. 0 otherwise reads as
              // "implausibly young" through the WR model's negative `age`
              // coefficient and inflates UDFA / late-transfer predictions.
              const age = draftAge > 0 && draftYear > 0 ? draftAge + (predSeason - draftYear) : 22;

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
                nflDraftRound: draft?.round || projDraftByName.get(normalName)?.projRound || 8,
                nflDraftPick: draft?.pick || projDraftByName.get(normalName)?.projPick || 300,
                // log(pick+1) so pick #1 → 0.693 instead of 0 — same
                // rationale as the training-row build paths. The
                // prediction-row build was previously missing these
                // two derived encodings, leaving them undefined for
                // every 2026 player. Models that use invDraftPick as
                // a feature (QB / RB / WR / TE PPG ensembles) read
                // undefined as 0 → the GBM trees treat every player
                // like an undrafted UDFA, suppressing predictions.
                logDraftPick: Math.log((draft?.pick || projDraftByName.get(normalName)?.projPick || 300) + 1),
                invDraftPick: 1 / (draft?.pick || projDraftByName.get(normalName)?.projPick || 300),
                draftPickPct: draftPickPctByName.get(normalName) ?? 1,
                draftPickPctOverall: draftPickPctOverallByName.get(normalName) ?? 1,
                draftClassDepth: draftClassDepthByName.get(normalName) ?? 0,
                weight: wt || combineAvg.get(adpPlayer.position)?.weight || 0,
                forty: combine?.forty || combineAvg.get(adpPlayer.position)?.forty || 0,
                bench: combine?.bench || combineAvg.get(adpPlayer.position)?.bench || 0,
                vertical: combine?.vertical || combineAvg.get(adpPlayer.position)?.vertical || 0,
                broadJump: combine?.broad_jump || combineAvg.get(adpPlayer.position)?.broadJump || 0,
                cone: combine?.cone || combineAvg.get(adpPlayer.position)?.cone || 0,
                shuttle: combine?.shuttle || combineAvg.get(adpPlayer.position)?.shuttle || 0,
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
                priorLateSeasonInjured: predPriorInjByName.get(normalName)?.lateSeasonInjured ? 1 : 0,
                priorLateSeasonInjWeeks: predPriorInjByName.get(normalName)?.lateSeasonInjWeeks || 0,
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
                    isProjectedStarter: (predDepthRankByName.get(normalName) || 99) === 1 ? 1 : 0,
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

                // College production (with position-average imputation)
                ...(() => {
                  const cs = collegeByName.get(normalName);
                  const pg = collegePerGameByName.get(normalName);
                  const adv = collegeAdvancedByName.get(normalName);
                  const best = collegeBestSeasonByName.get(normalName);
                  const prospect = prospectByName.get(normalName);
                  const posAvg = collegeAvgByPos.get(adpPlayer.position) || {};
                  const _hasCollege = cs ? 1 : 0;
                  const _hasProspect = prospect?.grade ? 1 : 0;
                  const _hasCombine = combineByName.has(normalName) ? 1 : 0;
                  const imp = (raw: number | undefined, field: string) => raw || posAvg[field] || 0;
                  return {
                    collegePassYds: imp(cs?.get('Passing Yards'), 'collegePassYds'),
                    collegePassTDs: imp(cs?.get('Passing Touchdowns'), 'collegePassTDs'),
                    collegeRushYds: imp(cs?.get('Rushing Yards'), 'collegeRushYds'),
                    collegeRecYds: imp(cs?.get('Receiving Yards'), 'collegeRecYds'),
                    collegeRecTDs: imp(cs?.get('Receiving Touchdowns'), 'collegeRecTDs'),
                    collegeTotalTDs: cs
                      ? (cs.get('Passing Touchdowns') || 0) + (cs.get('Rushing Touchdowns') || 0) + (cs.get('Receiving Touchdowns') || 0)
                      : posAvg['collegeTotalTDs'] || 0,
                    collegeQBR: imp(collegeQBRByName.get(normalName), 'collegeQBR'),
                    collegeQBR2yr: imp(collegeQBR2yrByName.get(normalName) || collegeQBRByName.get(normalName), 'collegeQBR2yr'),
                    ...(() => {
                      // Career aggregates from per-season college stats —
                      // used for both QB context features and RB dual-
                      // threat / elusiveness / goal-line features.
                      let careerRushYds = 0, careerRushAtt = 0, careerRushTDs = 0;
                      let careerRecYds = 0, careerRecTDs = 0;
                      let careerPassAtt = 0, careerGames = 0;
                      let tRushYds = 0, tRushAtt = 0, tRushTDs = 0, tRecTDs = 0;
                      let lastSchool = '', lastSeason = 0;
                      const ps = playerSeasonStats.get(normalName);
                      if (ps) {
                        for (const [sn, s] of ps) {
                          careerRushYds += s.rushYds || 0;
                          careerRushAtt += s.rushAtt || 0;
                          careerRushTDs += s.rushTDs || 0;
                          careerRecYds += s.recYds || 0;
                          careerRecTDs += s.recTDs || 0;
                          careerPassAtt += s.passAtt || 0;
                          careerGames += s.games || 0;
                          if (sn > lastSeason) { lastSeason = sn; lastSchool = s.school || lastSchool; }
                          const tkey = `${s.school}:${sn}`;
                          const team = schoolSeasonTotals.get(tkey);
                          if (team) {
                            tRushYds += team.rushYds || 0;
                            tRushAtt += team.rushAtt || 0;
                            tRushTDs += team.rushTDs || 0;
                            tRecTDs += team.recTDs || 0;
                          }
                        }
                      }
                      // CFBD fallback for recent classes not yet in nflverse.
                      if (lastSeason === 0) {
                        const cfbdK = normalName.replace(/[^a-z0-9]+/g, '');
                        const prefix = `${cfbdK}:`;
                        for (const key in cfbdPlayerUsage) {
                          if (!key.startsWith(prefix)) continue;
                          const yr = parseInt(key.split(':')[1]);
                          if (yr > lastSeason) {
                            lastSeason = yr;
                            lastSchool = (cfbdPlayerUsage[key]?.team || '').toLowerCase() || lastSchool;
                          }
                        }
                      }
                      const careerRushYpg = careerGames > 0 ? careerRushYds / careerGames : 0;
                      const teamKey1 = lastSchool ? `${normalizeSchool(lastSchool)}:${lastSeason}` : '';
                      const teamKey2 = lastSchool ? `${lastSchool.toLowerCase().trim()}:${lastSeason}` : '';
                      const teamRating = (teamKey1 && collegePredictiveRank.get(teamKey1))
                        || (teamKey2 && collegePredictiveRank.get(teamKey2))
                        || 0;
                      const sosFinalYr = (teamKey1 && collegeSOS.get(teamKey1))
                        || (teamKey2 && collegeSOS.get(teamKey2))
                        || 1;
                      const careerPassYpg = careerGames > 0
                        ? (cs?.get('Passing Yards') || 0) / careerGames
                        : 0;
                      const qbContextScore = Math.round(
                        careerPassYpg * Math.max(0, teamRating + 40) * sosFinalYr
                      );
                      const playerAge = draftAge || 0;
                      return {
                        collegeRushYpgPerAge: (careerRushYpg > 0 && playerAge > 0)
                          ? Math.round((careerRushYpg / playerAge) * 100) / 100
                          : 0,
                        collegeYdsPerPassAtt: careerPassAtt > 0
                          ? Math.round(((cs?.get('Passing Yards') || 0) / careerPassAtt) * 100) / 100
                          : 0,
                        collegeSosFinalYr: Math.round(sosFinalYr * 100) / 100,
                        collegeSosXPassAtt: Math.round(teamRating * careerPassAtt),
                        collegeQbContextScore: qbContextScore,
                        collegePassAttPerRushYd: careerRushYds > 0
                          ? Math.round((careerPassAtt / careerRushYds) * 100) / 100
                          : 0,
                        collegeRecYdsPerGame: careerGames > 0
                          ? Math.round((careerRecYds / careerGames) * 10) / 10
                          : 0,
                        collegeRushYpcOverTeam: (() => {
                          const p = careerRushAtt > 0 ? careerRushYds / careerRushAtt : 0;
                          const t = tRushAtt > 0 ? tRushYds / tRushAtt : 0;
                          return (p > 0 && t > 0) ? Math.round((p - t) * 100) / 100 : 0;
                        })(),
                        collegeGoalLineShare: (() => {
                          const ts = tRushTDs + tRecTDs;
                          return ts > 0 ? Math.round((careerRushTDs / ts) * 1000) / 1000 : 0;
                        })(),
                      };
                    })(),
                    collegeGames: pg?.games || 0,
                    collegeRecPerGame: imp(pg?.recPerGame, 'collegeRecPerGame'),
                    collegeYdsPerGame: imp(pg?.ydsPerGame, 'collegeYdsPerGame'),
                    collegeTDsPerGame: imp(pg?.tdsPerGame, 'collegeTDsPerGame'),
                    collegeRushYPC: imp(pg?.rushYPC, 'collegeRushYPC'),
                    collegeYdsPerRec: imp(pg?.ydsPerRec, 'collegeYdsPerRec'),
                    // Career-best single-season stats (peak production)
                    collegeBestRecYds: imp(best?.bestRecYds, 'collegeBestRecYds'),
                    collegeBestRecTDs: imp(best?.bestRecTDs, 'collegeBestRecTDs'),
                    collegeBestReceptions: imp(best?.bestReceptions, 'collegeBestReceptions'),
                    collegeBestRushYds: imp(best?.bestRushYds, 'collegeBestRushYds'),
                    collegeSeasons: best?.numSeasons || 0,
                    prospectGrade: prospect?.grade || 0,
                    prospectPosRank: prospect?.pos_rk || 0,
                    prospectOvlRank: prospect?.ovr_rk || 0,
                    recruitStars: cfbdRecruiting[normalName.replace(/[^a-z0-9]+/g, '')]?.stars || 0,
                    recruitRating: cfbdRecruiting[normalName.replace(/[^a-z0-9]+/g, '')]?.composite_rating || 0,
                    // CFBD lookups fall back to the latest season present in
                    // cfbdPlayerUsage when nflverse playerSeasonStats doesn't
                    // have the player — same fix as the ADP-rookie block
                    // above, shared so 2025 + future classes populate.
                    ...(() => {
                      const cfbdK = normalName.replace(/[^a-z0-9]+/g, '');
                      let lastSeason = 0, lastSchool = '';
                      const ps = playerSeasonStats.get(normalName);
                      if (ps) {
                        lastSeason = Math.max(...ps.keys());
                        lastSchool = ps.get(lastSeason)?.school || '';
                      }
                      if (lastSeason === 0) {
                        const prefix = `${cfbdK}:`;
                        for (const key in cfbdPlayerUsage) {
                          if (!key.startsWith(prefix)) continue;
                          const yr = parseInt(key.split(':')[1]);
                          if (yr > lastSeason) {
                            lastSeason = yr;
                            lastSchool = (cfbdPlayerUsage[key]?.team || '').toLowerCase() || lastSchool;
                          }
                        }
                      }
                      const usageKey = lastSeason > 0 ? `${cfbdK}:${lastSeason}` : '';
                      const usage = usageKey ? cfbdPlayerUsage[usageKey] : undefined;
                      return {
                        collegeTeamTalent: (lastSchool && lastSeason)
                          ? (cfbdTeamTalent[`${lastSchool}:${lastSeason}`] || 0)
                          : 0,
                        collegeUsageOverall: usage?.overall || 0,
                        collegeUsagePass: usage?.pass || 0,
                        collegeUsageRush: usage?.rush || 0,
                      };
                    })(),
                    collegeDominatorRating: imp(adv?.dominatorRating, 'collegeDominatorRating'),
                    collegeDominatorXLateRound: (adv?.dominatorRating || 0) *
                      Math.max(0, Math.log((draft?.pick || 300) + 1) - 4.0),
                    collegeBreakoutAge: imp(adv?.breakoutAge, 'collegeBreakoutAge'),
                    collegeBreakoutAgeDelta: adv?.breakoutAge && draftAge
                      ? Math.round((draftAge - adv.breakoutAge) * 10) / 10 : 0,
                    collegeMarketShare: imp(adv?.marketShare, 'collegeMarketShare'),
                    speedScore: speedScoreByName.get(normalName) || 0,
                    // ZAP-inspired per-team-normalized features
                    ...(() => {
                      const zap = collegeZapByName.get(normalName);
                      const draft = draftByName.get(normalName);
                      const ts = teammateScoreByName.get(normalName) || 0;
                      const ht = parseHeight(combineByName.get(normalName)?.ht || '') || 0;
                      const ss = speedScoreByName.get(normalName) || 0;
                      const htAdjSpeedScore = (ht > 0 && ss > 0) ? Math.round(ss * (ht / 76) * 10) / 10 : ss;
                      const draftPick = draft?.pick || 0;
                      const draftCapXSpeed = (draftPick > 0 && ss > 0) ? Math.round((1 / draftPick) * ss * 1000) / 1000 : 0;
                      return {
                        collegeRecYdsPerTeamPassAtt: zap?.recYdsPerTeamPassAtt || 0,
                        collegeReceptionShare: zap?.receptionShare || 0,
                        collegeYdsPerTeamPlay: zap?.ydsPerTeamPlay || 0,
                        collegeBreakoutScore: zap?.breakoutScore || 0,
                        collegeBestRecYdsPerTPA: zap?.bestSeasonRecYdsPerTPA || 0,
                        collegeRushProductionWR: zap?.rushProductionWR || 0,
                        collegeEarlyDeclare: zap?.earlyDeclare || 0,
                        collegeExperiencePerAge: (best && draftAge > 0)
                          ? Math.round(((best.numSeasons || 0) * 13 / draftAge) * 100) / 100
                          : 0,
                        collegeTeammateScore: ts,
                        heightAdjSpeedScore: htAdjSpeedScore,
                        relativeAthleticScore: computeRAS(combine, adpPlayer.position),
                        draftCapXSpeed,
                      };
                    })(),
                    hasCollegeStats: _hasCollege,
                    hasProspectGrade: _hasProspect,
                    hasCombineData: _hasCombine,
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

                // Momentum + multi-year prior features (from player history).
                // Mirrors augment_derived_features() in
                // scripts/train_projection_models.py so training and
                // inference agree. The Y-1 entry was just pushed above
                // from predPriorTotals; Y-2 was pushed by the training
                // loop when it iterated predSeason-1.
                ...(() => {
                  const hist = playerHistoryMap.get(normalName) || [];
                  const sorted = [...hist].sort((a, b) => b.season - a.season);
                  const curr = sorted.find((h) => h.season === predSeason - 1);
                  const prev = sorted.find((h) => h.season === predSeason - 2);

                  // priorPPG2yr: weighted 2-year prior PPG (0.65*Y-1 +
                  // 0.35*Y-2). Falls back to Y-1 alone when Y-2 missing,
                  // 0 when both missing — matches the Python helper
                  // exactly so on-disk training rows and inference rows
                  // agree.
                  const y1 = curr?.ppg || 0;
                  const y2 = prev?.ppg || 0;
                  let priorPPG2yr = 0;
                  if (y1 > 0 && y2 > 0) priorPPG2yr = Math.round((0.65 * y1 + 0.35 * y2) * 100) / 100;
                  else if (y1 > 0) priorPPG2yr = Math.round(y1 * 100) / 100;

                  // durabilityStreak: consecutive prior seasons with ≥15
                  // games, counting back from Y-1.
                  let streak = 0;
                  for (const entry of sorted) {
                    // History entries don't carry games directly; use
                    // a touches/targets >0 proxy to confirm the player
                    // was active that season. The Python helper uses
                    // `priorGames` from features which is populated
                    // from priorTotals.games. We don't carry games on
                    // history entries here, so the proxy is whether
                    // the entry exists with non-zero PPG.
                    if (entry.ppg > 0) streak += 1;
                    else break;
                  }

                  if (!curr || !prev) return {
                    ppgTrend: 0, targetTrend: 0, touchTrend: 0,
                    adpTrend: 0, snapPctTrend: 0, targetShareTrend: 0,
                    priorPPG2yr, durabilityStreak: streak,
                  };
                  return {
                    ppgTrend: Math.round((curr.ppg - prev.ppg) * 10) / 10,
                    targetTrend: curr.targets - prev.targets,
                    touchTrend: curr.touches - prev.touches,
                    adpTrend: prev.adp > 0 && curr.adp > 0 ? Math.round((prev.adp - curr.adp) * 10) / 10 : 0,
                    snapPctTrend: Math.round((curr.snapPct - prev.snapPct) * 10) / 10,
                    targetShareTrend: Math.round((curr.targetShare - prev.targetShare) * 1000) / 1000,
                    priorPPG2yr,
                    durabilityStreak: streak,
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

                // ML volume projection features (populated in post-processing)
                mlProjTeamPassAtt: 0,
                mlProjTeamRushAtt: 0,
                mlProjTeamTargets: 0,
                mlProjPlayerPPG: 0,
              };

              predRows.push({
                name: adpPlayer.name,
                position: adpPlayer.position,
                team: predPlayerTeamMap.get(normalName) || adpPlayer.team || '',
                adp: adpPlayer.adp,
                headshotUrl: predHeadshotByName.get(normalName) || predHeadshotByName.get(normalizeName(adpPlayer.name)) || undefined,
                features,
              });
            }
          }
        }

  // ── Post-processing: populate ML volume projection features for prediction rows ──
  // Computes per-team volumes (pass/rush/target) × per-player share × efficiency
  // → volume-based PPG estimate. Output features are also mirrored into
  // `score-store/volumes.json` by precompute-features.ts for auditability.
  //
  // Efficiency constants live here (not yet learned from backtest data).
  // Tune in one place rather than scattered through the math below.
  //
  // Volume-quality improvements (vs 2025 actuals):
  //   - Drop Vegas multiplier from volume totals — Vegas reflects scoring
  //     efficiency, not plays-per-game. Kept on the scoring side (TD rates,
  //     YPA / YPR) where it belongs. Biggest single MAE win.
  //   - Apply `passAttemptRate` (sack-adjusted) to pass-attempt calc — pass
  //     plays overstate attempts by ~6% because sacks don't count as attempts.
  //   - Regress each team's `teamPassRate` 25% toward the league mean to
  //     damp single-year extremes (ARI's garbage-time 0.696 etc.).
  //   - After per-team math, apply a league-calibration scalar so 32-team
  //     totals match rolling NFL averages. Fixes systematic bias without
  //     touching relative team ranks.
  //
  //   Simulated backtest vs 2025 (32 teams):
  //     Pass MAE:  13.7% → 5.9%
  //     Rush MAE:  15.9% → 7.1%
  const VOLUME_EFFICIENCY = {
    // QB passing: yards per attempt, TD rate per pass play
    qbPassYdsPerAtt: 7.0,
    qbPassTDRate: 0.045,
    qbFallbackRushYPC: 4.5,
    // Non-QB receiving: catch rate when no prior receiving data, yards per
    // reception fallback (TE is lower than WR/RB)
    fallbackCatchRate: 0.65,
    fallbackYPR_TE: 10,
    fallbackYPR_WRRB: 12,
    // Non-QB rushing
    fallbackYPC: 4.0,
    // TD share fallback — % of targets/rush that turn into TDs when
    // `predPassTDShare`/`predRushTDShare` aren't available.
    fallbackTDShareMultiplier: 0.3,
    // Prior-PPG blend when player has legitimate snap history
    priorBlendModel: 0.6,
    priorBlendPrior: 0.4,
    priorBlendSnapPctThreshold: 30,
    // Vegas normalization — league-average implied total (scoring side only)
    vegasBaselineTotal: 23,
    // Pace fallback when teamPace is missing
    fallbackPlaysPerGame: 64,
    fallbackTeamPassRate: 0.55,
    // Pass plays → pass attempts — ~6% of pass plays become sacks
    passAttemptRate: 0.94,
    // Pass attempts → targets — ~5% of attempts are throw-aways / spikes / DPI
    targetRate: 0.95,
    // Year-over-year regression: shrink team's prior passRate toward league mean.
    // Base weight + extras for teams with high uncertainty (new head coach,
    // high roster turnover). Backtested on 2011–2025: V5 config (HC 0.10,
    // turnover 0.30) cut pass MAE 9.53% → 9.39% and rush 12.03% → 11.82%.
    passRateRegressionWeight: 0.25,
    newHCRegressionExtra: 0.10,         // extra weight if team has new head coach
    turnoverRegressionSlope: 0.30,      // extra weight = slope × team-avg turnover
    maxRegressionWeight: 0.60,          // cap so we don't over-regress extreme cases
    leagueMeanPassRate: 0.55,
    // League-total calibration targets (2023–2025 rolling NFL averages, per team)
    leagueMeanPassAtt: 570,
    leagueMeanRushAtt: 470,
    leagueMeanTargets: 540,
    // Per-team CI bounds — ±1σ residual stdev measured from 480 (team, season)
    // backtest pairs across 2011–2025. Applied uniformly (not per-team yet);
    // see scripts/backtest-volume.py for the measurement.
    passCIStdev: 0.124,
    rushCIStdev: 0.153,
    targetsCIStdev: 0.127,
  };

  // Note: no `rows.length > 0` gate — the volume pass only reads features
  // already attached to predRows, so it must run even when precompute-features
  // invokes buildFeatureMatrix with `seasons: []` (legacy-cache path).
  if (predRows.length > 0) {
    try {
      onStatus?.('Computing ML volume projections...');
      const E = VOLUME_EFFICIENCY;

      // Pre-pass: collect per-team uncertainty signals (newHeadCoach + average
      // turnover across positions). Used in Pass 1 to widen the regression
      // weight for teams with high YoY uncertainty.
      const teamNewHC = new Map<string, number>();
      const teamTurnoverSum = new Map<string, { sum: number; n: number }>();
      for (const pr of predRows) {
        const team = pr.team;
        if (!team) continue;
        const f = pr.features;
        if (!teamNewHC.has(team)) {
          teamNewHC.set(team, Number(f.newHeadCoach) || 0);
        }
        const turn = Number(f.teamRosterTurnover) || 0;
        if (turn > 0) {
          const acc = teamTurnoverSum.get(team) || { sum: 0, n: 0 };
          acc.sum += turn;
          acc.n += 1;
          teamTurnoverSum.set(team, acc);
        }
      }
      const teamTurnover = new Map<string, number>();
      for (const [team, acc] of teamTurnoverSum) {
        teamTurnover.set(team, acc.n > 0 ? acc.sum / acc.n : 0);
      }

      // Pass 1: compute raw per-team volumes (pre-calibration) so we can
      // compute league scalars. Keyed by team; identical for every player
      // on the same team.
      type RawVolume = { passAtt: number; rushAtt: number; targets: number };
      const rawByTeam = new Map<string, RawVolume>();
      for (const pr of predRows) {
        const team = pr.team;
        if (!team || rawByTeam.has(team)) continue;
        const f = pr.features;
        const priorPassRate = f.teamPassRate || E.fallbackTeamPassRate;
        const teamPace = f.teamPace || E.fallbackPlaysPerGame;
        // Regress toward league mean to damp YoY extremes; widen the regression
        // weight for teams with new HC or heavy roster turnover.
        const newHC = teamNewHC.get(team) || 0;
        const turnover = teamTurnover.get(team) || 0;
        const passRegressW = Math.min(
          E.maxRegressionWeight,
          E.passRateRegressionWeight
            + E.newHCRegressionExtra * newHC
            + E.turnoverRegressionSlope * turnover,
        );
        const passRate = priorPassRate * (1 - passRegressW)
                       + E.leagueMeanPassRate * passRegressW;
        const playsPerGame = teamPace > 0 ? teamPace : E.fallbackPlaysPerGame;
        const passPlays = playsPerGame * passRate;
        const rushPlays = playsPerGame * (1 - passRate);
        rawByTeam.set(team, {
          passAtt: passPlays * 17 * E.passAttemptRate,
          rushAtt: rushPlays * 17,
          targets: passPlays * 17 * E.passAttemptRate * E.targetRate,
        });
      }

      // Pass 2: compute league-calibration scalars. Scale so the 32-team mean
      // matches league targets. Preserves per-team ranking; kills systematic
      // bias. Targets are the prior-season league means when available
      // (tracks league evolution), falling back to the hardcoded constants.
      const targetPass = leagueVolumeTargets?.pass ?? E.leagueMeanPassAtt;
      const targetRush = leagueVolumeTargets?.rush ?? E.leagueMeanRushAtt;
      const targetTgt  = leagueVolumeTargets?.targets ?? E.leagueMeanTargets;
      let passCal = 1, rushCal = 1, tgtCal = 1;
      if (rawByTeam.size > 0) {
        const teams = [...rawByTeam.values()];
        const meanRawPass = teams.reduce((s, v) => s + v.passAtt, 0) / teams.length;
        const meanRawRush = teams.reduce((s, v) => s + v.rushAtt, 0) / teams.length;
        const meanRawTgt  = teams.reduce((s, v) => s + v.targets, 0) / teams.length;
        if (meanRawPass > 0) passCal = targetPass / meanRawPass;
        if (meanRawRush > 0) rushCal = targetRush / meanRawRush;
        if (meanRawTgt  > 0) tgtCal  = targetTgt / meanRawTgt;
      }

      // Pass 3: write per-player features + compute PPG. Scoring side
      // still uses Vegas (efficiency, not volume).
      for (const pr of predRows) {
        const f = pr.features;
        const priorPassRate = f.teamPassRate || E.fallbackTeamPassRate;
        const teamPace = f.teamPace || E.fallbackPlaysPerGame;
        const priorPPG = f.priorPPG || 0;
        const priorSnapPct = f.priorSnapPct || 0;
        const targetShare = f.predTargetShare || f.priorTeamTargetShare || 0;
        const rushShare = f.predRushShare || f.priorTeamTouchShare || 0;
        const vegasTotal = f.vegasImpliedTotal || E.vegasBaselineTotal;

        // Same regression weight as Pass 1 — newHC + turnover widen it.
        const newHC = pr.team ? (teamNewHC.get(pr.team) || 0) : 0;
        const turnover = pr.team ? (teamTurnover.get(pr.team) || 0) : 0;
        const passRegressW = Math.min(
          E.maxRegressionWeight,
          E.passRateRegressionWeight
            + E.newHCRegressionExtra * newHC
            + E.turnoverRegressionSlope * turnover,
        );
        const passRate = priorPassRate * (1 - passRegressW)
                       + E.leagueMeanPassRate * passRegressW;
        const playsPerGame = teamPace > 0 ? teamPace : E.fallbackPlaysPerGame;
        const passPlays = playsPerGame * passRate;
        const rushPlays = playsPerGame * (1 - passRate);

        // Vegas scoring-efficiency multiplier — kept on scoring, off of volume.
        const vegasMultiplier = vegasTotal > 0 ? vegasTotal / E.vegasBaselineTotal : 1;

        let estimatedPPG = 0;
        if (pr.position === 'QB') {
          const ppgPass = (passPlays * E.qbPassYdsPerAtt * 0.04 + passPlays * E.qbPassTDRate * 4) * vegasMultiplier;
          const ppgRush = (f.qbOwnRushAtt || 0) / 17 * (f.priorYPC || E.qbFallbackRushYPC) * 0.1;
          estimatedPPG = ppgPass + ppgRush;
        } else {
          const projTargets = passPlays * targetShare * 17 * vegasMultiplier;
          const catchRate = f.priorReceptions && f.priorTargets ? f.priorReceptions / f.priorTargets : E.fallbackCatchRate;
          const projRec = projTargets * catchRate / 17;
          const ypr = f.priorYPR || (pr.position === 'TE' ? E.fallbackYPR_TE : E.fallbackYPR_WRRB);
          const recPPG = projRec + projRec * ypr * 0.1;

          const projRushAtt = rushPlays * rushShare * vegasMultiplier;
          const ypc = f.priorYPC || E.fallbackYPC;
          const rushPPG = projRushAtt * ypc * 0.1;

          const passTDShare = f.predPassTDShare || targetShare * E.fallbackTDShareMultiplier;
          const rushTDShare = f.predRushTDShare || rushShare * E.fallbackTDShareMultiplier;
          const tdPPG = (passTDShare + rushTDShare) * vegasMultiplier * 6 / 17;

          estimatedPPG = recPPG + rushPPG + tdPPG;
        }

        // Blend with prior PPG when player has meaningful snap history
        if (priorPPG > 0 && priorSnapPct > E.priorBlendSnapPctThreshold) {
          estimatedPPG = estimatedPPG * E.priorBlendModel + priorPPG * E.priorBlendPrior;
        }

        f.mlProjPlayerPPG = Math.round(estimatedPPG * 10) / 10;
        // Apply league-calibrated volumes from raw-team map + ±1σ CI bounds
        // from historical residual stdev. CI is symmetric proportional, not
        // yet per-team adaptive.
        const raw = pr.team ? rawByTeam.get(pr.team) : undefined;
        if (raw) {
          const passProj = raw.passAtt * passCal;
          const rushProj = raw.rushAtt * rushCal;
          const tgtProj = raw.targets * tgtCal;
          f.mlProjTeamPassAtt = Math.round(passProj);
          f.mlProjTeamPassAttLow = Math.round(passProj * (1 - E.passCIStdev));
          f.mlProjTeamPassAttHigh = Math.round(passProj * (1 + E.passCIStdev));
          f.mlProjTeamRushAtt = Math.round(rushProj);
          f.mlProjTeamRushAttLow = Math.round(rushProj * (1 - E.rushCIStdev));
          f.mlProjTeamRushAttHigh = Math.round(rushProj * (1 + E.rushCIStdev));
          f.mlProjTeamTargets = Math.round(tgtProj);
          f.mlProjTeamTargetsLow = Math.round(tgtProj * (1 - E.targetsCIStdev));
          f.mlProjTeamTargetsHigh = Math.round(tgtProj * (1 + E.targetsCIStdev));
        } else {
          // Free agents / teamless players get league-average volumes (no CI)
          f.mlProjTeamPassAtt = E.leagueMeanPassAtt;
          f.mlProjTeamPassAttLow = Math.round(E.leagueMeanPassAtt * (1 - E.passCIStdev));
          f.mlProjTeamPassAttHigh = Math.round(E.leagueMeanPassAtt * (1 + E.passCIStdev));
          f.mlProjTeamRushAtt = E.leagueMeanRushAtt;
          f.mlProjTeamRushAttLow = Math.round(E.leagueMeanRushAtt * (1 - E.rushCIStdev));
          f.mlProjTeamRushAttHigh = Math.round(E.leagueMeanRushAtt * (1 + E.rushCIStdev));
          f.mlProjTeamTargets = E.leagueMeanTargets;
          f.mlProjTeamTargetsLow = Math.round(E.leagueMeanTargets * (1 - E.targetsCIStdev));
          f.mlProjTeamTargetsHigh = Math.round(E.leagueMeanTargets * (1 + E.targetsCIStdev));
        }
      }
    } catch (e) {
      onStatus?.(`Volume projection failed: ${(e as Error).message}`);
    }
  }

  // Convert vorNorm Map to plain object for JSON serialization
  const vorNormObj: Record<string, { mean: number; std: number }> = {};
  vorNorm.forEach((v, k) => { vorNormObj[k] = v; });

  return { rows, predRows, vorNorm: vorNormObj };
}
