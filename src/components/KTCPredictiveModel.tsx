import { useState, useEffect, useMemo, useRef } from 'react';
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Label, ReferenceLine,
  BarChart, Bar,
} from 'recharts';
import type { KTCPlayer, KTCPlayerHistory } from '../types';
import {
  fetchKTCRankings, fetchKTCHistory, fetchPlayerStats,
  fetchCombine, fetchDraftPicks, fetchInjuries, fetchGames,
  fetchSnapCounts, aggregateToSeasonTotals, fetchDepthCharts,
} from '../data';
import { trainRidgeRegression, predict, type TrainedModel, type PredictionResult } from '../lib/ridge';

// ── Types ──

type Position = 'QB' | 'RB' | 'WR' | 'TE';
type RookieFilter = 'all' | 'rookie' | 'veteran';

const POSITIONS: Position[] = ['QB', 'RB', 'WR', 'TE'];

interface ModelRow {
  name: string;
  team: string;
  season: number;
  playerID: number;
  yearsInLeague: number;
  // Target
  septValue: number;
  decValue: number;
  valueDelta: number;
  // Feature vector (keyed by feature name)
  features: Record<string, number>;
}

interface PlayerPrediction {
  name: string;
  team: string;
  playerID: number;
  septValue: number;
  actualDelta: number | null; // null for future predictions
  predictedDelta: number;
  predictedDecValue: number;
  topDrivers: PredictionResult['featureContributions'];
  allDrivers: PredictionResult['featureContributions'];
}

// ── Feature definitions ──

interface FeatureDef { key: string; label: string; category: string }

// Shared features across all positions
const COMMON_FEATURES: FeatureDef[] = [
  { key: 'septValue', label: 'Sept KTC Value', category: 'Dynasty' },
  { key: 'age', label: 'Age', category: 'Dynasty' },
  { key: 'draftRound', label: 'Draft Round', category: 'Draft' },
  { key: 'draftPick', label: 'Draft Pick', category: 'Draft' },
  { key: 'yearsInLeague', label: 'Years in League', category: 'Draft' },
  { key: 'weight', label: 'Weight', category: 'Physical' },
  { key: 'bmi', label: 'BMI', category: 'Physical' },
  { key: 'forty', label: '40-Yard Dash', category: 'Physical' },
  { key: 'speedScore', label: 'Speed Score', category: 'Physical' },
  { key: 'depthChartRank', label: 'Depth Chart Rank', category: 'Depth Chart' },
  { key: 'priorDepthChartRank', label: 'Prior DC Rank', category: 'Depth Chart' },
  { key: 'depthChartChange', label: 'DC Rank Change', category: 'Depth Chart' },
  { key: 'priorGames', label: 'Prior Games', category: 'Prior Season' },
  { key: 'priorFantasyPPR', label: 'Prior Fantasy PPR', category: 'Prior Season' },
  { key: 'priorPPG', label: 'Prior PPG', category: 'Prior Season' },
  { key: 'priorSnapPct', label: 'Prior Snap %', category: 'Prior Season' },
  { key: 'priorInjuryWeeks', label: 'Prior Injury Weeks', category: 'Injury' },
  { key: 'priorGamesOut', label: 'Prior Games Out', category: 'Injury' },
  { key: 'priorGamesMissed', label: 'Prior Games Missed', category: 'Injury' },
  { key: 'teamWins', label: 'Team Wins (Prior)', category: 'Team' },
  { key: 'teamPPG', label: 'Team PPG (Prior)', category: 'Team' },
];

const QB_FEATURES: FeatureDef[] = [
  { key: 'priorPassYards', label: 'Prior Pass Yards', category: 'Prior Season' },
  { key: 'priorPassTDs', label: 'Prior Pass TDs', category: 'Prior Season' },
  { key: 'priorINTs', label: 'Prior INTs', category: 'Prior Season' },
  { key: 'priorCompletions', label: 'Prior Completions', category: 'Prior Season' },
  { key: 'priorAttempts', label: 'Prior Attempts', category: 'Prior Season' },
  { key: 'priorRushYards', label: 'Prior Rush Yards', category: 'Prior Season' },
  { key: 'priorRushTDs', label: 'Prior Rush TDs', category: 'Prior Season' },
];

const RB_FEATURES: FeatureDef[] = [
  { key: 'priorRushYards', label: 'Prior Rush Yards', category: 'Prior Season' },
  { key: 'priorRushTDs', label: 'Prior Rush TDs', category: 'Prior Season' },
  { key: 'priorYPC', label: 'Prior YPC', category: 'Prior Season' },
  { key: 'priorTargets', label: 'Prior Targets', category: 'Prior Season' },
  { key: 'priorReceptions', label: 'Prior Receptions', category: 'Prior Season' },
  { key: 'priorRecYards', label: 'Prior Rec Yards', category: 'Prior Season' },
  { key: 'priorTotalTouches', label: 'Prior Total Touches', category: 'Prior Season' },
];

const WR_FEATURES: FeatureDef[] = [
  { key: 'priorTargets', label: 'Prior Targets', category: 'Prior Season' },
  { key: 'priorReceptions', label: 'Prior Receptions', category: 'Prior Season' },
  { key: 'priorRecYards', label: 'Prior Rec Yards', category: 'Prior Season' },
  { key: 'priorRecTDs', label: 'Prior Rec TDs', category: 'Prior Season' },
  { key: 'priorRushYards', label: 'Prior Rush Yards', category: 'Prior Season' },
];

const TE_FEATURES: FeatureDef[] = [
  { key: 'priorTargets', label: 'Prior Targets', category: 'Prior Season' },
  { key: 'priorReceptions', label: 'Prior Receptions', category: 'Prior Season' },
  { key: 'priorRecYards', label: 'Prior Rec Yards', category: 'Prior Season' },
  { key: 'priorRecTDs', label: 'Prior Rec TDs', category: 'Prior Season' },
];

function getFeatureDefsForPosition(pos: Position): FeatureDef[] {
  const posFeatures = pos === 'QB' ? QB_FEATURES
    : pos === 'RB' ? RB_FEATURES
    : pos === 'WR' ? WR_FEATURES
    : TE_FEATURES;
  return [...COMMON_FEATURES, ...posFeatures];
}

const CATEGORY_COLORS: Record<string, string> = {
  Dynasty: '#6366f1',
  Draft: '#8b5cf6',
  Physical: '#ec4899',
  'Depth Chart': '#06b6d4',
  'Prior Season': '#f59e0b',
  Injury: '#ef4444',
  Team: '#10b981',
};

// ── Helpers ──

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

function getValueNearMonth(
  history: { d: string; v: number }[],
  year: number,
  month: number
): number | null {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const inMonth = history.filter((h) => h.d.startsWith(prefix));
  if (inMonth.length > 0) return inMonth[inMonth.length - 1].v;
  const target = new Date(year, month - 1, 15).getTime();
  let closest = history[0];
  let minDiff = Infinity;
  for (const h of history) {
    const diff = Math.abs(new Date(h.d).getTime() - target);
    if (diff < minDiff) { minDiff = diff; closest = h; }
  }
  return minDiff < 45 * 24 * 60 * 60 * 1000 ? closest.v : null;
}

function parseHeight(ht: string): number {
  const parts = ht.split('-');
  return parts.length === 2 ? Number(parts[0]) * 12 + Number(parts[1]) : 0;
}

// ── Seasons ──
const TRAIN_SEASONS = [2025];

// ── Component ──

interface KTCPredictiveModelProps {
  initialPlayer?: string | null;
}

export function KTCPredictiveModel({ initialPlayer }: KTCPredictiveModelProps) {
  const [position, setPosition] = useState<Position>('RB');
  const [rookieFilter, setRookieFilter] = useState<RookieFilter>('all');
  const [model, setModel] = useState<TrainedModel | null>(null);
  const [predictions, setPredictions] = useState<PlayerPrediction[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState('Initializing...');
  const [error, setError] = useState<string | null>(null);
  const [lambda, setLambda] = useState(5);
  const [sortBy, setSortBy] = useState<'predictedDelta' | 'septValue' | 'name'>('predictedDelta');
  const [showCategory, setShowCategory] = useState<string>('all');
  const [selectedPlayer, setSelectedPlayer] = useState<string | null>(initialPlayer || null);
  const detailRef = useRef<HTMLDivElement>(null);

  // Sync with external initialPlayer prop
  useEffect(() => {
    if (initialPlayer) setSelectedPlayer(initialPlayer);
  }, [initialPlayer]);

  // Scroll to detail panel when a player is selected
  useEffect(() => {
    if (selectedPlayer && detailRef.current) {
      detailRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [selectedPlayer]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        // ── 1. Fetch all base data ──
        setLoadingStatus('Loading KTC rankings...');
        const ktcPlayers = await fetchKTCRankings('1qb');
        const posPlayers = ktcPlayers.filter((p) => p.position === position && p.playerID > 0);
        if (cancelled) return;

        setLoadingStatus('Loading KTC history...');
        const histories = await fetchKTCHistory(posPlayers.map((r) => r.playerID));
        const historyMap = new Map<number, KTCPlayerHistory>();
        for (const h of histories) historyMap.set(h.playerID, h);
        if (cancelled) return;

        setLoadingStatus('Loading combine & draft data...');
        const [combineData, draftData] = await Promise.all([fetchCombine(), fetchDraftPicks()]);
        if (cancelled) return;

        // Build lookup maps (by normalized name)
        const ktcByName = new Map<string, KTCPlayer>();
        for (const p of posPlayers) ktcByName.set(normalizeName(p.playerName), p);

        // Map combine positions to our Position type
        const combinePos = position === 'RB' ? 'RB' : position === 'WR' ? 'WR' : position === 'TE' ? 'TE' : 'QB';
        const combineByName = new Map<string, typeof combineData[0]>();
        for (const c of combineData) {
          if (c.pos === combinePos) combineByName.set(normalizeName(c.player_name), c);
        }

        const draftByName = new Map<string, typeof draftData[0]>();
        for (const d of draftData) {
          if (d.position === position) draftByName.set(normalizeName(d.pfr_player_name), d);
        }

        // ── 2. Build training rows for each season ──
        const rows: ModelRow[] = [];

        for (const season of TRAIN_SEASONS) {
          setLoadingStatus(`Building features for ${season}...`);

          // Fetch all season data in parallel
          const [
            currentStats, priorStats, injuries, priorInjuries,
            games, snapCounts, depthCharts, priorDepthCharts,
          ] = await Promise.all([
            fetchPlayerStats(season).catch(() => []),
            fetchPlayerStats(season - 1).catch(() => []),
            fetchInjuries(season).catch(() => []),
            fetchInjuries(season - 1).catch(() => []),
            fetchGames(),
            fetchSnapCounts(season - 1).catch(() => []),
            fetchDepthCharts(season).catch(() => []),
            fetchDepthCharts(season - 1).catch(() => []),
          ]);
          if (cancelled) return;

          // Prior season totals (for prior-year features)
          const priorTotals = aggregateToSeasonTotals(
            priorStats.filter((s) => s.position === position && s.season_type === 'REG')
          );
          const priorByName = new Map<string, typeof priorTotals[0]>();
          for (const p of priorTotals) priorByName.set(normalizeName(p.player_display_name), p);

          // Prior season snap counts by player name → avg offense_pct
          const snapsByName = new Map<string, number>();
          const snapAccum = new Map<string, { total: number; count: number }>();
          for (const s of snapCounts) {
            if (s.position !== position) continue;
            const name = normalizeName(s.player);
            const acc = snapAccum.get(name) || { total: 0, count: 0 };
            acc.total += s.offense_pct || 0;
            acc.count += 1;
            snapAccum.set(name, acc);
          }
          for (const [name, acc] of snapAccum) {
            snapsByName.set(name, acc.count > 0 ? acc.total / acc.count : 0);
          }

          // Depth chart rank: most recent entry per player for this position
          const dcRankByName = new Map<string, number>();
          const dcEntries = depthCharts
            .filter((d) => d.pos_abb === position)
            .sort((a, b) => String(a.dt || '').localeCompare(String(b.dt || ''))); // earliest first, later overwrites
          for (const d of dcEntries) {
            dcRankByName.set(normalizeName(d.player_name), d.pos_rank);
          }

          // Prior season depth chart rank
          const priorDcRankByName = new Map<string, number>();
          const priorDcEntries = priorDepthCharts
            .filter((d) => d.pos_abb === position)
            .sort((a, b) => String(a.dt || '').localeCompare(String(b.dt || '')));
          for (const d of priorDcEntries) {
            priorDcRankByName.set(normalizeName(d.player_name), d.pos_rank);
          }

          // Prior injury counts by player name
          const injuryByName = new Map<string, { weeks: number; out: number }>();
          for (const inj of priorInjuries) {
            if (inj.position !== position) continue;
            const name = normalizeName(inj.full_name);
            const acc = injuryByName.get(name) || { weeks: 0, out: 0 };
            acc.weeks += 1;
            if (inj.report_status === 'Out' || inj.report_status === 'Doubtful') acc.out += 1;
            injuryByName.set(name, acc);
          }

          // Current-season injury weeks (preseason / early season)
          const currentInjByName = new Map<string, number>();
          for (const inj of injuries) {
            if (inj.position !== position) continue;
            if (inj.week > 4) continue; // only count early-season
            const name = normalizeName(inj.full_name);
            currentInjByName.set(name, (currentInjByName.get(name) || 0) + 1);
          }

          // Team context: prior season wins & PPG
          const priorGames = games.filter(
            (g) => g.season === season - 1 && g.game_type === 'REG'
          );
          const teamWins = new Map<string, number>();
          const teamPoints = new Map<string, { total: number; games: number }>();
          for (const g of priorGames) {
            // Home team
            const hw = (teamWins.get(g.home_team) || 0) + (g.home_score > g.away_score ? 1 : 0);
            teamWins.set(g.home_team, hw);
            const hp = teamPoints.get(g.home_team) || { total: 0, games: 0 };
            hp.total += g.home_score; hp.games += 1;
            teamPoints.set(g.home_team, hp);
            // Away team
            const aw = (teamWins.get(g.away_team) || 0) + (g.away_score > g.home_score ? 1 : 0);
            teamWins.set(g.away_team, aw);
            const ap = teamPoints.get(g.away_team) || { total: 0, games: 0 };
            ap.total += g.away_score; ap.games += 1;
            teamPoints.set(g.away_team, ap);
          }

          // Current season stats grouped by player for name→team mapping
          const currentPosStats = currentStats.filter(
            (s) => s.position === position && s.season_type === 'REG'
          );
          const currentTeamByName = new Map<string, string>();
          for (const s of currentPosStats) {
            currentTeamByName.set(normalizeName(s.player_display_name), s.recent_team);
          }

          // ── For each player with KTC data, build a feature row ──
          for (const [normalName, ktcPlayer] of ktcByName) {
            const history = historyMap.get(ktcPlayer.playerID);
            if (!history?.oneQB?.valueHistory?.length) continue;

            const septVal = getValueNearMonth(history.oneQB.valueHistory, season, 9);
            const decVal = getValueNearMonth(history.oneQB.valueHistory, season, 12);
            if (septVal == null || decVal == null) continue;

            const team = currentTeamByName.get(normalName) || ktcPlayer.team;
            const prior = priorByName.get(normalName);
            const combine = combineByName.get(normalName);
            const draft = draftByName.get(normalName);
            const injHist = injuryByName.get(normalName) || { weeks: 0, out: 0 };
            const snapPct = snapsByName.get(normalName) || 0;

            // Parse physical
            const heightIn = combine?.ht ? parseHeight(combine.ht) : 0;
            const wt = combine?.wt || 0;
            const bmi = heightIn > 0 && wt > 0 ? (703 * wt) / (heightIn * heightIn) : 0;
            const fortyTime = combine?.forty || 0;
            const speedScore = fortyTime > 0 && wt > 0
              ? (wt * 200) / Math.pow(fortyTime, 4) : 0;

            const priorGamesPlayed = prior?.games || 0;
            const priorPPR = prior?.fantasy_points_ppr || 0;
            const priorCarries = prior?.carries || 0;
            const priorRushYds = prior?.rushing_yards || 0;

            // Games missed = 17 - games played (if they had prior stats)
            const gamesMissed = prior ? Math.max(0, 17 - priorGamesPlayed) : 0;

            const tw = teamWins.get(team) || 0;
            const tp = teamPoints.get(team);
            const tppg = tp && tp.games > 0 ? tp.total / tp.games : 0;

            // Depth chart
            const dcRank = dcRankByName.get(normalName) || 0;
            const priorDcRank = priorDcRankByName.get(normalName) || 0;
            // Positive = moved up (e.g. 3→1 = +2), negative = moved down
            const dcChange = (priorDcRank > 0 && dcRank > 0) ? priorDcRank - dcRank : 0;

            const yrsInLeague = draft ? season - draft.season : 0;

            const features: Record<string, number> = {
              septValue: septVal,
              age: ktcPlayer.age || 0,
              draftRound: draft?.round || 8,
              draftPick: draft?.pick || 300,
              yearsInLeague: yrsInLeague,
              weight: wt,
              bmi: Math.round(bmi * 10) / 10,
              forty: fortyTime,
              speedScore: Math.round(speedScore * 10) / 10,
              depthChartRank: dcRank,
              priorDepthChartRank: priorDcRank,
              depthChartChange: dcChange,
              priorGames: priorGamesPlayed,
              priorRushYards: priorRushYds,
              priorRushTDs: prior?.rushing_tds || 0,
              priorYPC: priorCarries > 0 ? Math.round((priorRushYds / priorCarries) * 10) / 10 : 0,
              priorTargets: prior?.targets || 0,
              priorReceptions: prior?.receptions || 0,
              priorRecYards: prior?.receiving_yards || 0,
              priorRecTDs: prior?.receiving_tds || 0,
              priorPassYards: prior?.passing_yards || 0,
              priorPassTDs: prior?.passing_tds || 0,
              priorINTs: prior?.interceptions || 0,
              priorCompletions: prior?.completions || 0,
              priorAttempts: prior?.attempts || 0,
              priorFantasyPPR: Math.round(priorPPR * 10) / 10,
              priorPPG: priorGamesPlayed > 0 ? Math.round((priorPPR / priorGamesPlayed) * 10) / 10 : 0,
              priorTotalTouches: priorCarries + (prior?.receptions || 0),
              priorSnapPct: Math.round(snapPct * 10) / 10,
              priorInjuryWeeks: injHist.weeks,
              priorGamesOut: injHist.out,
              priorGamesMissed: gamesMissed,
              teamWins: tw,
              teamPPG: Math.round(tppg * 10) / 10,
            };

            rows.push({
              name: ktcPlayer.playerName,
              team,
              season,
              playerID: ktcPlayer.playerID,
              yearsInLeague: yrsInLeague,
              septValue: septVal,
              decValue: decVal,
              valueDelta: decVal - septVal,
              features,
            });
          }
        }

        if (cancelled) return;

        // ── 3. Filter to rows with enough data ──
        let validRows = rows.filter((r) => r.septValue > 0);

        // Apply rookie/veteran filter
        if (rookieFilter === 'rookie') {
          validRows = validRows.filter((r) => r.yearsInLeague <= 1);
        } else if (rookieFilter === 'veteran') {
          validRows = validRows.filter((r) => r.yearsInLeague > 1);
        }

        if (validRows.length < 10) {
          setError(`Only ${validRows.length} ${position}s match filters — need at least 10 to train`);
          setLoading(false);
          return;
        }

        // ── 4. Build feature matrix ──
        setLoadingStatus('Training model...');
        const activeDefs = getFeatureDefsForPosition(position);
        const featureNames = activeDefs.map((f) => f.key);
        const X = validRows.map((r) => featureNames.map((k) => r.features[k] || 0));
        const y = validRows.map((r) => r.valueDelta);

        // Train
        const trained = trainRidgeRegression(X, y, featureNames, lambda);
        setModel(trained);

        // ── 5. Generate predictions ──
        const preds: PlayerPrediction[] = validRows.map((row) => {
          const result = predict(trained, row.features);
          return {
            name: row.name,
            team: row.team,
            playerID: row.playerID,
            septValue: row.septValue,
            actualDelta: row.valueDelta,
            predictedDelta: Math.round(result.predicted),
            predictedDecValue: Math.round(row.septValue + result.predicted),
            topDrivers: result.featureContributions.slice(0, 5),
            allDrivers: result.featureContributions,
          };
        });

        setPredictions(preds);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Model training failed');
      } finally {
        setLoading(false);
      }
    }

    run();
    return () => { cancelled = true; };
  }, [lambda, position, rookieFilter]);

  const activeDefs = useMemo(() => getFeatureDefsForPosition(position), [position]);

  // Feature importance (sorted by absolute coefficient)
  const featureImportance = useMemo(() => {
    if (!model) return [];
    return model.featureNames
      .map((name, i) => {
        const def = activeDefs.find((f) => f.key === name);
        return {
          name,
          label: def?.label || name,
          category: def?.category || 'Other',
          coefficient: model.coefficients[i],
          absCoeff: Math.abs(model.coefficients[i]),
        };
      })
      .sort((a, b) => b.absCoeff - a.absCoeff);
  }, [model, activeDefs]);

  const filteredImportance = useMemo(() => {
    if (showCategory === 'all') return featureImportance;
    return featureImportance.filter((f) => f.category === showCategory);
  }, [featureImportance, showCategory]);

  // Sorted predictions
  const sortedPredictions = useMemo(() => {
    const sorted = [...predictions];
    if (sortBy === 'predictedDelta') sorted.sort((a, b) => b.predictedDelta - a.predictedDelta);
    else if (sortBy === 'septValue') sorted.sort((a, b) => b.septValue - a.septValue);
    else sorted.sort((a, b) => a.name.localeCompare(b.name));
    return sorted;
  }, [predictions, sortBy]);

  // Actual vs predicted scatter data
  const scatterData = useMemo(() => {
    return predictions
      .filter((p) => p.actualDelta !== null)
      .map((p) => ({
        name: p.name,
        actual: p.actualDelta!,
        predicted: p.predictedDelta,
        septValue: p.septValue,
      }));
  }, [predictions]);

  const selectedPrediction = useMemo(() => {
    if (!selectedPlayer) return null;
    return predictions.find((p) => p.name === selectedPlayer) || null;
  }, [predictions, selectedPlayer]);

  const categories = useMemo(() => {
    const cats = new Set(activeDefs.map((f) => f.category));
    return ['all', ...cats];
  }, [activeDefs]);

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">
          {loadingStatus}
          <br />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Joining KTC history + stats + combine + draft + injuries + games + snaps
          </span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <h3>Model Error</h3>
        <p>{error}</p>
      </div>
    );
  }

  if (!model) return null;

  return (
    <>
      {/* Position & filter controls */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="control-group">
          <label className="control-label">Position</label>
          <div style={{ display: 'flex', gap: 4 }}>
            {POSITIONS.map((pos) => (
              <button
                key={pos}
                className={`pos-filter ${position === pos ? 'active' : ''}`}
                onClick={() => setPosition(pos)}
                style={{ fontSize: 12, padding: '4px 10px' }}
              >
                {pos}
              </button>
            ))}
          </div>
        </div>
        <div className="control-group">
          <label className="control-label">Experience</label>
          <select value={rookieFilter} onChange={(e) => setRookieFilter(e.target.value as RookieFilter)}>
            <option value="all">All Players</option>
            <option value="rookie">Rookies (0-1 yrs)</option>
            <option value="veteran">Veterans (2+ yrs)</option>
          </select>
        </div>
      </div>

      <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 12 }}>
        Ridge regression model trained on {model.n} {position}-seasons ({TRAIN_SEASONS.join(', ')}).
        Uses {activeDefs.length} features across {categories.length - 1} categories to predict Sep→Dec KTC value change.
        {rookieFilter !== 'all' && ` Filtered to ${rookieFilter === 'rookie' ? 'rookies (≤1 yr)' : 'veterans (2+ yrs)'}.`}
      </p>

      {/* Model performance */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        {[
          { label: 'R²', value: model.rSquared.toFixed(3), color: model.rSquared > 0.3 ? '#10b981' : '#f59e0b' },
          { label: 'Adj R²', value: model.adjustedRSquared.toFixed(3), color: model.adjustedRSquared > 0.2 ? '#10b981' : '#f59e0b' },
          { label: 'MAE', value: Math.round(model.mae).toLocaleString(), color: '#6366f1' },
          { label: 'RMSE', value: Math.round(model.rmse).toLocaleString(), color: '#6366f1' },
          { label: 'Samples', value: String(model.n), color: 'var(--text-muted)' },
          { label: 'Features', value: String(activeDefs.length), color: 'var(--text-muted)' },
        ].map((m) => (
          <div
            key={m.label}
            style={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '10px 16px',
              textAlign: 'center',
              minWidth: 90,
            }}
          >
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{m.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: m.color, fontFamily: 'monospace' }}>
              {m.value}
            </div>
          </div>
        ))}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Lambda (λ):</label>
          <select value={lambda} onChange={(e) => setLambda(Number(e.target.value))}>
            <option value={0.1}>0.1 (low reg)</option>
            <option value={1}>1</option>
            <option value={5}>5 (default)</option>
            <option value={10}>10</option>
            <option value={25}>25 (high reg)</option>
          </select>
        </div>
      </div>

      {/* Feature importance bar chart */}
      <h4 style={{ marginBottom: 8 }}>Feature Importance (Standardized Coefficients)</h4>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {categories.map((cat) => (
          <button
            key={cat}
            className={`pos-filter ${showCategory === cat ? 'active' : ''}`}
            onClick={() => setShowCategory(cat)}
            style={{
              fontSize: 11,
              borderColor: cat !== 'all' ? CATEGORY_COLORS[cat] : undefined,
              color: showCategory === cat && cat !== 'all' ? CATEGORY_COLORS[cat] : undefined,
            }}
          >
            {cat === 'all' ? 'All' : cat}
          </button>
        ))}
      </div>

      <div style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '16px 12px 8px 0',
        marginBottom: 20,
      }}>
        <ResponsiveContainer width="100%" height={Math.max(280, filteredImportance.length * 28 + 40)}>
          <BarChart
            data={filteredImportance.map((f) => ({
              name: f.label,
              value: Math.round(f.coefficient * 1000) / 1000,
              fill: CATEGORY_COLORS[f.category] || '#6366f1',
            }))}
            layout="vertical"
            margin={{ top: 5, right: 20, bottom: 5, left: 140 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.3} />
            <XAxis type="number" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
              width={130}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--bg-card, #1e1e2e)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                fontSize: 12,
              }}
              formatter={(value) => [Number(value).toFixed(3), 'Coefficient']}
            />
            <ReferenceLine x={0} stroke="var(--text-muted)" />
            <Bar dataKey="value" radius={[0, 3, 3, 0]} maxBarSize={20}>
              {filteredImportance.map((f, idx) => (
                <rect key={idx} fill={CATEGORY_COLORS[f.category] || '#6366f1'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Actual vs Predicted scatter */}
      <h4 style={{ marginBottom: 8 }}>Actual vs Predicted (Training Fit)</h4>
      <div style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '20px 12px 12px 0',
        marginBottom: 20,
      }}>
        <ResponsiveContainer width="100%" height={380}>
          <ScatterChart margin={{ top: 10, right: 20, bottom: 40, left: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.5} />
            <XAxis type="number" dataKey="actual" tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}>
              <Label value="Actual Value Change" position="bottom" offset={20} style={{ fill: 'var(--text-secondary)', fontSize: 13 }} />
            </XAxis>
            <YAxis type="number" dataKey="predicted" tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}>
              <Label value="Predicted Value Change" angle={-90} position="insideLeft" offset={10} style={{ fill: 'var(--text-secondary)', fontSize: 13 }} />
            </YAxis>
            <ReferenceLine
              segment={[
                { x: Math.min(...scatterData.map((d) => d.actual)), y: Math.min(...scatterData.map((d) => d.actual)) },
                { x: Math.max(...scatterData.map((d) => d.actual)), y: Math.max(...scatterData.map((d) => d.actual)) },
              ]}
              stroke="#6366f1"
              strokeDasharray="5 5"
              opacity={0.5}
            />
            <Tooltip
              content={({ payload }) => {
                if (!payload?.length) return null;
                const d = payload[0].payload;
                return (
                  <div style={{
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)',
                    padding: '8px 12px',
                    fontSize: 12,
                  }}>
                    <strong>{d.name}</strong>
                    <br />Sept: {d.septValue.toLocaleString()}
                    <br />Actual: <span style={{ color: d.actual >= 0 ? '#10b981' : '#ef4444' }}>{d.actual >= 0 ? '+' : ''}{d.actual.toLocaleString()}</span>
                    <br />Predicted: <span style={{ color: d.predicted >= 0 ? '#10b981' : '#ef4444' }}>{d.predicted >= 0 ? '+' : ''}{d.predicted.toLocaleString()}</span>
                  </div>
                );
              }}
            />
            <Scatter data={scatterData} fill="#6366f1" fillOpacity={0.6} r={5} />
          </ScatterChart>
        </ResponsiveContainer>
      </div>

      {/* Predicted Value Change Chart */}
      <h4 style={{ marginBottom: 8 }}>Predicted Value Change (Current → Dec)</h4>
      <div className="controls" style={{ marginBottom: 12 }}>
        <div className="control-group">
          <label className="control-label">Sort by</label>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
            <option value="predictedDelta">Predicted Change</option>
            <option value="septValue">Current Value</option>
            <option value="name">Name</option>
          </select>
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          {predictions.length} {position}s — click a bar to see factor breakdown
        </span>
      </div>

      <div style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '16px 12px 8px 0',
        marginBottom: 20,
      }}>
        <ResponsiveContainer width="100%" height={Math.max(400, sortedPredictions.length * 26 + 40)}>
          <BarChart
            data={sortedPredictions.map((p) => ({
              name: `${p.name} (${p.team})`,
              playerName: p.name,
              value: p.predictedDelta,
              septValue: p.septValue,
              predictedDec: p.predictedDecValue,
              fill: p.predictedDelta >= 0 ? '#10b981' : '#ef4444',
            }))}
            layout="vertical"
            margin={{ top: 5, right: 30, bottom: 5, left: 150 }}
            onClick={(data: Record<string, unknown>) => {
              const ap = (data as { activePayload?: { payload?: { playerName?: string } }[] }).activePayload;
              if (ap?.[0]?.payload?.playerName) {
                const name = ap[0].payload.playerName;
                setSelectedPlayer(selectedPlayer === name ? null : name);
              }
            }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.3} />
            <XAxis
              type="number"
              tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
              tickFormatter={(v) => `${v >= 0 ? '+' : ''}${v}`}
            >
              <Label value="Predicted KTC Change" position="bottom" offset={-5} style={{ fill: 'var(--text-secondary)', fontSize: 12 }} />
            </XAxis>
            <YAxis
              type="category"
              dataKey="name"
              width={145}
              tick={(props: { x: number; y: number; payload: { value: string } }) => {
                const { x, y, payload } = props;
                // Extract player name from "Name (TEAM)" format
                const match = payload.value.match(/^(.+)\s\(/);
                const playerName = match ? match[1] : payload.value;
                const isSelected = selectedPlayer === playerName;
                return (
                  <text
                    x={x}
                    y={y}
                    dy={4}
                    textAnchor="end"
                    fontSize={11}
                    fill={isSelected ? '#6366f1' : 'var(--text-secondary)'}
                    fontWeight={isSelected ? 700 : 400}
                    cursor="pointer"
                    textDecoration="underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedPlayer(selectedPlayer === playerName ? null : playerName);
                    }}
                  >
                    {payload.value}
                  </text>
                );
              }}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--bg-card, #1e1e2e)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                fontSize: 12,
              }}
              formatter={(value) => [`${Number(value) >= 0 ? '+' : ''}${Number(value).toLocaleString()}`, 'Predicted Change']}
              labelFormatter={(label) => label}
            />
            <ReferenceLine x={0} stroke="var(--text-muted)" strokeWidth={1} />
            <Bar
              dataKey="value"
              radius={[0, 3, 3, 0]}
              maxBarSize={20}
              cursor="pointer"
              isAnimationActive={false}
            >
              {sortedPredictions.map((p, idx) => (
                <rect
                  key={idx}
                  fill={p.predictedDelta >= 0 ? '#10b981' : '#ef4444'}
                  opacity={selectedPlayer && selectedPlayer !== p.name ? 0.3 : 1}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Selected player detail panel */}
      {selectedPrediction && (
        <div ref={detailRef} style={{
          background: 'var(--bg-secondary)',
          border: '2px solid #6366f1',
          borderRadius: 'var(--radius)',
          padding: 20,
          marginBottom: 20,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div>
              <h4 style={{ margin: 0 }}>{selectedPrediction.name} ({selectedPrediction.team})</h4>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Current: {selectedPrediction.septValue.toLocaleString()} KTC
                {' → '}
                Predicted Dec: {selectedPrediction.predictedDecValue.toLocaleString()} KTC
                {' '}
                (<span style={{ color: selectedPrediction.predictedDelta >= 0 ? '#10b981' : '#ef4444', fontWeight: 700 }}>
                  {selectedPrediction.predictedDelta >= 0 ? '+' : ''}{selectedPrediction.predictedDelta.toLocaleString()}
                </span>)
              </span>
            </div>
            <button
              onClick={() => setSelectedPlayer(null)}
              style={{
                background: 'none',
                border: '1px solid var(--border)',
                borderRadius: 6,
                color: 'var(--text-muted)',
                cursor: 'pointer',
                padding: '4px 10px',
                fontSize: 12,
              }}
            >
              Close
            </button>
          </div>

          <h5 style={{ margin: '0 0 8px', color: 'var(--text-secondary)', fontSize: 13 }}>
            Factor Contributions to Prediction
          </h5>
          <ResponsiveContainer width="100%" height={Math.max(300, selectedPrediction.allDrivers.length * 24 + 40)}>
            <BarChart
              data={selectedPrediction.allDrivers.map((d) => {
                const def = activeDefs.find((f) => f.key === d.name);
                return {
                  name: def?.label || d.name,
                  category: def?.category || 'Other',
                  contribution: Math.round(d.contribution * 10) / 10,
                  value: d.value,
                  fill: d.contribution >= 0 ? '#10b981' : '#ef4444',
                };
              })}
              layout="vertical"
              margin={{ top: 5, right: 30, bottom: 5, left: 150 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.3} />
              <XAxis
                type="number"
                tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                tickFormatter={(v) => `${v >= 0 ? '+' : ''}${v}`}
              >
                <Label value="Contribution to Predicted Change" position="bottom" offset={-5} style={{ fill: 'var(--text-secondary)', fontSize: 12 }} />
              </XAxis>
              <YAxis
                type="category"
                dataKey="name"
                tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
                width={145}
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--bg-card, #1e1e2e)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  fontSize: 12,
                }}
                content={({ payload }) => {
                  if (!payload?.length) return null;
                  const d = payload[0].payload;
                  return (
                    <div style={{
                      background: 'var(--bg-tertiary)',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      padding: '8px 12px',
                      fontSize: 12,
                    }}>
                      <strong>{d.name}</strong>
                      <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>{d.category}</span>
                      <br />
                      Raw value: <strong>{d.value}</strong>
                      <br />
                      Contribution: <span style={{ color: d.contribution >= 0 ? '#10b981' : '#ef4444', fontWeight: 700 }}>
                        {d.contribution >= 0 ? '+' : ''}{d.contribution}
                      </span> KTC points
                    </div>
                  );
                }}
              />
              <ReferenceLine x={0} stroke="var(--text-muted)" strokeWidth={1} />
              <Bar
                dataKey="contribution"
                radius={[0, 3, 3, 0]}
                maxBarSize={18}
                isAnimationActive={false}
              >
                {selectedPrediction.allDrivers.map((d, idx) => {
                  const def = activeDefs.find((f) => f.key === d.name);
                  return (
                    <rect
                      key={idx}
                      fill={CATEGORY_COLORS[def?.category || 'Other'] || '#6366f1'}
                      opacity={d.contribution >= 0 ? 1 : 0.8}
                    />
                  );
                })}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Category breakdown */}
      <details style={{ marginTop: 20 }}>
        <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', fontSize: 13 }}>
          Full coefficient table ({activeDefs.length} features)
        </summary>
        <div className="table-container" style={{ marginTop: 8 }}>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Feature</th>
                <th>Category</th>
                <th>Coefficient</th>
                <th>Direction</th>
              </tr>
            </thead>
            <tbody>
              {featureImportance.map((f, i) => (
                <tr key={f.name}>
                  <td className="rank-cell">{i + 1}</td>
                  <td><strong>{f.label}</strong></td>
                  <td>
                    <span style={{ color: CATEGORY_COLORS[f.category], fontSize: 12 }}>
                      {f.category}
                    </span>
                  </td>
                  <td style={{ fontFamily: 'monospace', fontWeight: 700 }}>
                    <span style={{ color: f.coefficient >= 0 ? '#10b981' : '#ef4444' }}>
                      {f.coefficient >= 0 ? '+' : ''}{f.coefficient.toFixed(4)}
                    </span>
                  </td>
                  <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {f.coefficient > 0.01 ? 'Higher → value rises'
                      : f.coefficient < -0.01 ? 'Higher → value falls'
                      : 'Minimal impact'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
