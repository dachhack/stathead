/**
 * PlayerCard — expandable player detail card for model comparisons.
 * Shows basic stats, model feature scores, career/college stats, and photo.
 */

import { useState } from 'react';
import { PRE_DRAFT_ROOKIE_FEATURES, FEATURES, POS_COLORS, CATEGORY_COLORS } from '../lib/featureTypes';
import { ppgToTierScore, tierName, tierColor as tierScoreColor } from '../lib/tierScore';

interface PlayerCardProps {
  player: {
    name: string;
    position: string;
    draftSeason?: number;
    zapScore?: number;
    ourScore?: number;
    predictedPPG?: number;
    actualPPG?: number;
    headshotUrl?: string;
    thresholdProbs?: Record<number, number>;
    features?: Record<string, number>;
    featurePercentiles?: Record<string, number>;
    boomZ?: number;
    bustZ?: number;
  };
  onClose: () => void;
}

function pctlColor(pctl: number): string {
  if (pctl >= 90) return '#22c55e';
  if (pctl >= 75) return '#4ade80';
  if (pctl >= 60) return '#a3e635';
  if (pctl >= 40) return '#facc15';
  if (pctl >= 20) return '#fb923c';
  return '#ef4444';
}

const FEATURE_LABELS: Record<string, string> = {};
for (const f of FEATURES) { FEATURE_LABELS[f.key] = f.label; }

// Features where a value of exactly 0 means "no data captured" rather than
// a real zero. Combine / college-production / CFBD features all fall here
// because the upstream pipeline writes 0 when a lookup whiffs. Binary flags
// (earlyDeclare, hasX), interaction terms (dominatorXLateRound is legitimately
// 0 for top-55 picks), and derived draft-pick features stay out of this set.
const ZERO_MEANS_MISSING = new Set<string>([
  // Athletic / combine
  'relativeAthleticScore', 'speedScore', 'heightAdjSpeedScore',
  'forty', 'weight', 'bmi', 'cone', 'shuttle', 'bench', 'vertical', 'broadJump',
  // College production
  'collegeDominatorRating', 'collegeBestRecYds', 'collegeBestRushYds',
  'collegeBreakoutScore', 'collegeBreakoutAge', 'collegeMarketShare',
  'collegeReceptionShare', 'collegeTotalTDs', 'collegeRushYPC',
  'collegeYdsPerRec', 'collegeRecPerGame', 'collegeRecTDs',
  'collegeRecYds', 'collegeRushYds', 'collegePassTDs',
  'collegeSeasons', 'collegeGames', 'collegeExperiencePerAge',
  'collegeTeammateScore', 'collegeRushProductionWR',
  // CFBD-sourced
  'recruitRating', 'recruitStars',
  'collegeUsageOverall', 'collegeUsagePass', 'collegeUsageRush',
  'collegeTeamTalent',
  'collegeQBR', 'collegeQBR2yr', 'collegeYdsPerPassAtt', 'collegeQbContextScore',
  // QB career derivations — 0 means the upstream aggregate (rush yards,
  // passing attempts, or school-season SOS lookup) was unavailable.
  'collegeRushYpgPerAge', 'collegeSosFinalYr',
  // Context
  'age', 'nflDraftPick', 'nflDraftRound',
]);

function isMissing(key: string, val: number | undefined | null): boolean {
  if (val == null) return true;
  return ZERO_MEANS_MISSING.has(key) && val === 0;
}

// Raw inputs fed into the boom (outperformance) and bust (underperformance)
// gap-feature models. Shown on the card so users can see what's driving the
// z-scores up top. QB gets the additional QB-specific signals.
const BOOM_BUST_INPUTS: Record<string, string[]> = {
  QB: [
    'relativeAthleticScore', 'speedScore', 'age',
    'collegeDominatorRating', 'collegeBreakoutScore',
    'collegeSeasons', 'collegeEarlyDeclare',
    'recruitRating', 'collegeUsageOverall', 'collegeTeamTalent',
    'collegeQBR2yr', 'collegeYdsPerPassAtt', 'collegeQbContextScore',
    'predictedPPG', 'nflDraftPick',
  ],
  RB: [
    'relativeAthleticScore', 'speedScore', 'heightAdjSpeedScore',
    'forty', 'weight', 'age',
    'collegeBestRushYds', 'collegeTotalTDs', 'collegeRushYPC',
    'collegeExperiencePerAge', 'collegeSeasons', 'collegeEarlyDeclare',
    'recruitRating', 'collegeUsageOverall', 'collegeUsageRush',
    'collegeTeamTalent',
    'predictedPPG', 'nflDraftPick',
  ],
  WR: [
    'relativeAthleticScore', 'speedScore', 'heightAdjSpeedScore',
    'forty', 'weight', 'age',
    'collegeBestRecYds', 'collegeDominatorRating', 'collegeBreakoutScore',
    'collegeMarketShare', 'collegeTotalTDs', 'collegeReceptionShare',
    'collegeExperiencePerAge', 'collegeSeasons', 'collegeEarlyDeclare',
    'recruitRating', 'collegeUsageOverall', 'collegeTeamTalent',
    'predictedPPG', 'nflDraftPick',
  ],
  TE: [
    'relativeAthleticScore', 'speedScore', 'heightAdjSpeedScore',
    'forty', 'weight', 'age',
    'collegeBestRecYds', 'collegeDominatorRating', 'collegeBreakoutScore',
    'collegeMarketShare', 'collegeTotalTDs',
    'collegeExperiencePerAge', 'collegeSeasons', 'collegeEarlyDeclare',
    'recruitRating', 'collegeUsageOverall', 'collegeTeamTalent',
    'predictedPPG', 'nflDraftPick',
  ],
};

function featureLabel(key: string): string {
  return FEATURE_LABELS[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
}

function fmtVal(v: number): string {
  if (v === 0) return '0';
  if (Number.isInteger(v)) return String(v);
  if (Math.abs(v) < 0.1) return v.toFixed(3);
  if (Math.abs(v) < 1) return v.toFixed(2);
  return v.toFixed(1);
}


export function PlayerCard({ player, onClose }: PlayerCardProps) {
  const [tab, setTab] = useState<'features' | 'stats'>('features');
  const pos = player.position;
  const features = player.features || {};

  // Get the model features for this position
  const modelFeatureKeys = PRE_DRAFT_ROOKIE_FEATURES[pos] || [];

  // Group all features by category
  const featuresByCategory = new Map<string, Array<{ key: string; value: number }>>();
  for (const f of FEATURES) {
    if (!f.positions.includes(pos)) continue;
    const val = features[f.key];
    if (val === undefined) continue;
    if (!featuresByCategory.has(f.category)) featuresByCategory.set(f.category, []);
    featuresByCategory.get(f.category)!.push({ key: f.key, value: val });
  }

  // Career stats (NFL)
  const hasNFLStats = (features.priorPPG || 0) > 0 || (player.actualPPG || 0) > 0;

  // College stats
  const hasCollegeStats = (features.hasCollegeStats || 0) > 0 || (features.collegeRecYds || 0) > 0 || (features.collegeRushYds || 0) > 0;

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.85)', zIndex: 1000,
      display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
      padding: '16px 12px', overflowY: 'auto',
    }} onClick={onClose}>
      <div style={{
        background: 'var(--bg-primary)', borderRadius: 12,
        border: '1px solid var(--border)', maxWidth: 340, width: '100%',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        maxHeight: 'calc(100vh - 32px)', overflowY: 'auto',
      }} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{
          padding: '12px 14px', borderBottom: '1px solid var(--border)',
          display: 'flex', gap: 10, alignItems: 'center',
        }}>
          {player.headshotUrl && (
            <img src={player.headshotUrl} alt={player.name}
              style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover', border: '2px solid var(--border)' }}
              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          )}
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{player.name}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ color: POS_COLORS[pos], fontWeight: 600 }}>{pos}</span>
              {player.draftSeason && <span>Class of {player.draftSeason}</span>}
            </div>
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: 'var(--text-muted)',
            fontSize: 18, cursor: 'pointer', padding: 4,
          }}>x</button>
        </div>

        {/* Score summary */}
        <div style={{ padding: '8px 14px', display: 'flex', gap: 6, flexWrap: 'wrap', borderBottom: '1px solid var(--border)' }}>
          {(() => {
            // "Our Score" = predictedPPG → ZAP 2026 tier scale when PPG is
            // available (primary path for prospect + backtest cards). Falls
            // back to the passed-in ourScore for any caller that already
            // computed a custom score. Displays the tier name as a sub-label.
            const ts = player.predictedPPG != null && player.predictedPPG > 0
              ? ppgToTierScore(player.predictedPPG, player.position)
              : (player.ourScore ?? 0);
            if (ts <= 0) return null;
            return (
              <div style={{ background: 'var(--bg-secondary)', borderRadius: 6, padding: '4px 8px', textAlign: 'center', minWidth: 72 }}
                title="Our Score: predicted PPG mapped to ZAP's 2026 tier scale (Legendary / Elite / Weekly Starter / Flex / Bench / Waiver / Dart).">
                <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>Our Score</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: tierScoreColor(ts) }}>{ts.toFixed(1)}</div>
                <div style={{ fontSize: 8, color: tierScoreColor(ts), marginTop: -2 }}>{tierName(ts)}</div>
              </div>
            );
          })()}
          {player.zapScore != null && player.zapScore > 0 && (
            <div style={{ background: 'var(--bg-secondary)', borderRadius: 6, padding: '4px 8px', textAlign: 'center' }}>
              <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>ZAP Score</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#3b82f6' }}>{player.zapScore.toFixed(1)}</div>
            </div>
          )}
          {player.predictedPPG != null && player.predictedPPG > 0 && (
            <div style={{ background: 'var(--bg-secondary)', borderRadius: 6, padding: '4px 8px', textAlign: 'center' }}>
              <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>Pred PPG</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#f59e0b' }}>{player.predictedPPG.toFixed(1)}</div>
            </div>
          )}
          {player.actualPPG != null && player.actualPPG > 0 && (
            <div style={{ background: 'var(--bg-secondary)', borderRadius: 6, padding: '4px 8px', textAlign: 'center' }}>
              <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>Actual PPG</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#22c55e' }}>{player.actualPPG.toFixed(1)}</div>
            </div>
          )}
          {player.boomZ != null && (
            <div style={{ background: 'var(--bg-secondary)', borderRadius: 6, padding: '4px 8px', textAlign: 'center' }}
              title="Boom z-score: prospect's outperformance score standardized vs the historical NFL rookie distribution at this position. +1σ = unusually high upside vs typical rookie at this draft slot.">
              <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>Boom z</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: player.boomZ >= 1 ? '#22c55e' : player.boomZ >= 0.3 ? '#a3e635' : player.boomZ <= -0.5 ? '#fb923c' : 'var(--text-muted)' }}>
                {player.boomZ >= 0 ? `+${player.boomZ.toFixed(2)}` : player.boomZ.toFixed(2)}
              </div>
            </div>
          )}
          {player.bustZ != null && (
            <div style={{ background: 'var(--bg-secondary)', borderRadius: 6, padding: '4px 8px', textAlign: 'center' }}
              title="Bust z-score: prospect's bust-event score standardized vs the historical NFL rookie distribution. +1σ = unusually high bust risk; -1σ = unusually safe.">
              <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>Bust z</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: player.bustZ >= 1 ? '#ef4444' : player.bustZ >= 0.3 ? '#fb923c' : player.bustZ <= -0.5 ? '#22c55e' : 'var(--text-muted)' }}>
                {player.bustZ >= 0 ? `+${player.bustZ.toFixed(2)}` : player.bustZ.toFixed(2)}
              </div>
            </div>
          )}
          {/* Threshold probabilities */}
          {player.thresholdProbs && Object.keys(player.thresholdProbs).length > 0 && (
            <div style={{ width: '100%', display: 'flex', gap: 4, marginTop: 4 }}>
              {Object.entries(player.thresholdProbs).sort(([a], [b]) => Number(a) - Number(b)).map(([thresh, prob]) => (
                <div key={thresh} style={{
                  flex: 1, background: 'var(--bg-secondary)', borderRadius: 4, padding: '3px 4px', textAlign: 'center',
                }}>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>P(≥{thresh})</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: prob >= 50 ? '#22c55e' : prob >= 25 ? '#facc15' : '#ef4444' }}>
                    {prob.toFixed(0)}%
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)' }}>
          <button onClick={() => setTab('features')} style={{
            flex: 1, padding: '8px', border: 'none', cursor: 'pointer',
            background: tab === 'features' ? 'var(--bg-secondary)' : 'transparent',
            color: tab === 'features' ? 'var(--text-primary)' : 'var(--text-muted)',
            fontWeight: tab === 'features' ? 600 : 400, fontSize: 13,
          }}>Model Features</button>
          <button onClick={() => setTab('stats')} style={{
            flex: 1, padding: '8px', border: 'none', cursor: 'pointer',
            background: tab === 'stats' ? 'var(--bg-secondary)' : 'transparent',
            color: tab === 'stats' ? 'var(--text-primary)' : 'var(--text-muted)',
            fontWeight: tab === 'stats' ? 600 : 400, fontSize: 13,
          }}>{hasNFLStats ? 'Career Stats' : 'College Stats'}</button>
        </div>

        {/* Content */}
        <div style={{ padding: '10px 14px' }}>
          {tab === 'features' && (
            <>
              {/* Quick stats summary */}
              {(() => {
                // Weight may come from real combine OR team-listed roster
                // (hasPhysicalData). 40 / Speed Score require an actual combine
                // run; otherwise they're positional averages.
                const hasPhysical = features.hasPhysicalData != null
                  ? features.hasPhysicalData > 0
                  : features.weight > 0;
                const hasCombine = features.hasCombineData != null
                  ? features.hasCombineData > 0
                  : (features.weight > 0 && features.forty > 0);
                return (features.nflDraftPick || features.age || (hasPhysical && features.weight)) && (
                  <div style={{ marginBottom: 10, display: 'flex', flexWrap: 'wrap', gap: 4, fontSize: 11 }}>
                    {features.nflDraftPick > 0 && features.nflDraftPick < 300 && (
                      <span style={{ background: 'var(--bg-secondary)', padding: '2px 6px', borderRadius: 4 }}>Pick #{features.nflDraftPick}</span>
                    )}
                    {features.age > 0 && (
                      <span style={{ background: 'var(--bg-secondary)', padding: '2px 6px', borderRadius: 4 }}>Age {features.age}</span>
                    )}
                    {hasPhysical && features.weight > 0 && (
                      <span style={{ background: 'var(--bg-secondary)', padding: '2px 6px', borderRadius: 4 }}>{features.weight} lbs</span>
                    )}
                    {hasCombine && features.forty > 0 && (
                      <span style={{ background: 'var(--bg-secondary)', padding: '2px 6px', borderRadius: 4 }}>{features.forty.toFixed(2)}s 40</span>
                    )}
                    {hasCombine && features.speedScore > 0 && (
                      <span style={{ background: 'var(--bg-secondary)', padding: '2px 6px', borderRadius: 4 }}>SS: {fmtVal(features.speedScore)}</span>
                    )}
                    {!hasCombine && (
                      <span style={{ background: 'var(--bg-secondary)', padding: '2px 6px', borderRadius: 4, color: 'var(--text-muted)' }}>No combine</span>
                    )}
                  </div>
                );
              })()}

              {/* Model-specific features */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#8b5cf6', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>
                  Career Model Inputs ({pos})
                </div>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 6 }}>
                  Bars show percentile vs all rookies at position
                </div>
                {modelFeatureKeys.filter(key => {
                  // Hide combine-derived rows when the player skipped the
                  // combine — those values are positional-average imputations.
                  // Weight is exempt: roster fallback gives a real value.
                  if (features.hasCombineData === 0) {
                    if (key === 'forty' || key === 'bench' ||
                        key === 'vertical' || key === 'broadJump' || key === 'cone' ||
                        key === 'shuttle' || key === 'speedScore' ||
                        key.startsWith('speedScore')) return false;
                    if ((key === 'weight' || key === 'bmi') && !features.hasPhysicalData) return false;
                  }
                  return true;
                }).map(key => {
                  const rawVal = features[key];
                  const missing = isMissing(key, rawVal);
                  const val = rawVal ?? 0;
                  const pctl = missing ? undefined : player.featurePercentiles?.[key];
                  const usePctl = pctl !== undefined;
                  const barPct = missing ? 0 : (usePctl ? pctl : (() => {
                    const maxVal = key.includes('log') ? 6 : key.includes('inv') ? 0.5 :
                      key === 'age' ? 24 : key === 'weight' ? 250 :
                      key.includes('Score') ? 120 : key.includes('Yds') ? 2000 :
                      key.includes('TDs') ? 40 : key.includes('Rating') ? 50 : 1;
                    return Math.min(100, (Math.abs(val) / maxVal) * 100);
                  })());
                  const color = missing ? 'var(--bg-tertiary)' : (usePctl ? pctlColor(pctl) : '#8b5cf6');
                  return (
                    <div key={key} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 28px 32px', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <span style={{ fontSize: 10, color: missing ? 'var(--text-muted)' : 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {featureLabel(key)}
                      </span>
                      <div style={{ height: 5, background: 'var(--bg-tertiary)', borderRadius: 3, overflow: 'hidden' }}>
                        {!missing && <div style={{ width: `${barPct}%`, height: '100%', background: color, borderRadius: 3 }} />}
                      </div>
                      <span style={{ fontSize: 9, color: 'var(--text-muted)', textAlign: 'right', fontStyle: missing ? 'italic' : 'normal' }}>
                        {missing ? 'missing' : (usePctl ? `${pctl}` : fmtVal(val))}
                      </span>
                      <span style={{ fontSize: 9, color: missing ? 'var(--text-muted)' : 'var(--text-secondary)', textAlign: 'right', fontStyle: missing ? 'italic' : 'normal' }}>
                        {missing ? '—' : fmtVal(val)}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Boom/Bust model inputs — what drives the z-scores at top */}
              {(() => {
                const boomBustKeys = BOOM_BUST_INPUTS[pos] || [];
                const visible = boomBustKeys.filter(key => {
                  if (features.hasCombineData === 0) {
                    if (key === 'forty' || key === 'cone' || key === 'shuttle' ||
                        key === 'speedScore' || key === 'heightAdjSpeedScore' ||
                        key === 'relativeAthleticScore') return false;
                    if (key === 'weight' && !features.hasPhysicalData) return false;
                  }
                  return true;
                });
                if (visible.length === 0) return null;
                return (
                  <div style={{ marginTop: 10, marginBottom: 12 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: '#f59e0b', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>
                      Boom / Bust Inputs ({pos})
                    </div>
                    <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 6 }}>
                      Raw features fed into the outperformance + bust-event models
                    </div>
                    {visible.map(key => {
                      const rawVal = features[key] ?? (key === 'predictedPPG' ? (player.predictedPPG ?? undefined) : undefined);
                      // predictedPPG is always known from the model — never "missing"
                      const missing = key === 'predictedPPG' ? false : isMissing(key, rawVal);
                      const val = rawVal ?? 0;
                      const pctl = missing ? undefined : player.featurePercentiles?.[key];
                      const usePctl = pctl !== undefined;
                      const barPct = missing ? 0 : (usePctl ? pctl : (() => {
                        const maxVal = key === 'age' ? 24 : key === 'weight' ? 250 :
                          key === 'nflDraftPick' ? 260 : key === 'predictedPPG' ? 20 :
                          key === 'collegeQBR2yr' ? 90 : key === 'collegeTeamTalent' ? 1000 :
                          key === 'collegeUsageOverall' || key === 'collegeUsageRush' ? 0.6 :
                          key === 'recruitRating' ? 1 :
                          key.includes('Score') ? 120 : key.includes('Yds') ? 2000 :
                          key.includes('TDs') ? 40 : key.includes('Rating') ? 50 : 1;
                        return Math.min(100, (Math.abs(val) / maxVal) * 100);
                      })());
                      const color = missing ? 'var(--bg-tertiary)' : (usePctl ? pctlColor(pctl) : '#f59e0b');
                      return (
                        <div key={key} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 28px 32px', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                          <span style={{ fontSize: 10, color: missing ? 'var(--text-muted)' : 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {featureLabel(key)}
                          </span>
                          <div style={{ height: 5, background: 'var(--bg-tertiary)', borderRadius: 3, overflow: 'hidden' }}>
                            {!missing && <div style={{ width: `${barPct}%`, height: '100%', background: color, borderRadius: 3 }} />}
                          </div>
                          <span style={{ fontSize: 9, color: 'var(--text-muted)', textAlign: 'right', fontStyle: missing ? 'italic' : 'normal' }}>
                            {missing ? 'missing' : (usePctl ? `${pctl}` : fmtVal(val))}
                          </span>
                          <span style={{ fontSize: 9, color: missing ? 'var(--text-muted)' : 'var(--text-secondary)', textAlign: 'right', fontStyle: missing ? 'italic' : 'normal' }}>
                            {missing ? '—' : fmtVal(val)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

              {/* All features by category — collapsed by default */}
              <details style={{ marginTop: 8 }}>
                <summary style={{
                  fontSize: 11, fontWeight: 600, cursor: 'pointer',
                  color: 'var(--text-secondary)', textTransform: 'uppercase',
                  letterSpacing: 1, marginBottom: 6, padding: '4px 0',
                }}>
                  All Features ({[...featuresByCategory.values()].reduce((s, f) => s + f.filter(x => x.value !== 0).length, 0)})
                </summary>
                <div style={{ paddingLeft: 8 }}>
                  {[...featuresByCategory.entries()].map(([category, feats]) => {
                    const nonZero = feats.filter(f => f.value !== 0);
                    if (nonZero.length === 0) return null;
                    return (
                      <details key={category} style={{ marginBottom: 6 }}>
                        <summary style={{
                          fontSize: 10, fontWeight: 600, cursor: 'pointer',
                          color: CATEGORY_COLORS[category] || 'var(--text-secondary)',
                          textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4,
                        }}>{category} ({nonZero.length}/{feats.length})</summary>
                        <div style={{ paddingLeft: 8 }}>
                          {nonZero.map(({ key, value }) => {
                            const pctl = player.featurePercentiles?.[key];
                            return (
                              <div key={key} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 28px 32px', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                                <span style={{ fontSize: 9, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {featureLabel(key)}
                                </span>
                                <div style={{ height: 4, background: 'var(--bg-tertiary)', borderRadius: 2, overflow: 'hidden' }}>
                                  <div style={{
                                    width: `${pctl !== undefined ? pctl : 0}%`,
                                    height: '100%',
                                    background: pctl !== undefined ? pctlColor(pctl) : 'var(--bg-tertiary)',
                                    borderRadius: 2,
                                  }} />
                                </div>
                                <span style={{ fontSize: 9, color: 'var(--text-muted)', textAlign: 'right' }}>
                                  {pctl !== undefined ? pctl : ''}
                                </span>
                                <span style={{ fontSize: 9, color: 'var(--text-secondary)', textAlign: 'right' }}>
                                  {fmtVal(value)}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </details>
                    );
                  })}
                </div>
              </details>
            </>
          )}

          {tab === 'stats' && (
            <>
              {hasNFLStats && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>NFL Career</div>
                  <table style={{ width: '100%', fontSize: 12 }}>
                    <tbody>
                      {player.actualPPG ? <tr><td style={{ color: 'var(--text-muted)' }}>Best 2-of-3 PPG</td><td style={{ textAlign: 'right', fontWeight: 600 }}>{player.actualPPG.toFixed(1)}</td></tr> : null}
                      {features.priorPPG ? <tr><td style={{ color: 'var(--text-muted)' }}>Prior PPG</td><td style={{ textAlign: 'right' }}>{features.priorPPG.toFixed(1)}</td></tr> : null}
                      {features.priorGames ? <tr><td style={{ color: 'var(--text-muted)' }}>Prior Games</td><td style={{ textAlign: 'right' }}>{features.priorGames}</td></tr> : null}
                      {features.priorRecYards ? <tr><td style={{ color: 'var(--text-muted)' }}>Rec Yards</td><td style={{ textAlign: 'right' }}>{features.priorRecYards}</td></tr> : null}
                      {features.priorRecTDs ? <tr><td style={{ color: 'var(--text-muted)' }}>Rec TDs</td><td style={{ textAlign: 'right' }}>{features.priorRecTDs}</td></tr> : null}
                      {features.priorRushYards ? <tr><td style={{ color: 'var(--text-muted)' }}>Rush Yards</td><td style={{ textAlign: 'right' }}>{features.priorRushYards}</td></tr> : null}
                      {features.priorTargets ? <tr><td style={{ color: 'var(--text-muted)' }}>Targets</td><td style={{ textAlign: 'right' }}>{features.priorTargets}</td></tr> : null}
                      {features.priorReceptions ? <tr><td style={{ color: 'var(--text-muted)' }}>Receptions</td><td style={{ textAlign: 'right' }}>{features.priorReceptions}</td></tr> : null}
                      {features.priorPassYards ? <tr><td style={{ color: 'var(--text-muted)' }}>Pass Yards</td><td style={{ textAlign: 'right' }}>{features.priorPassYards}</td></tr> : null}
                      {features.priorPassTDs ? <tr><td style={{ color: 'var(--text-muted)' }}>Pass TDs</td><td style={{ textAlign: 'right' }}>{features.priorPassTDs}</td></tr> : null}
                    </tbody>
                  </table>
                </div>
              )}

              {hasCollegeStats && (
                <div style={{ marginTop: hasNFLStats ? 16 : 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>College</div>
                  <table style={{ width: '100%', fontSize: 12 }}>
                    <tbody>
                      {features.collegeSeasons ? <tr><td style={{ color: 'var(--text-muted)' }}>Seasons</td><td style={{ textAlign: 'right' }}>{features.collegeSeasons}</td></tr> : null}
                      {features.collegeRecYds ? <tr><td style={{ color: 'var(--text-muted)' }}>Career Rec Yards</td><td style={{ textAlign: 'right' }}>{features.collegeRecYds}</td></tr> : null}
                      {features.collegeRecTDs ? <tr><td style={{ color: 'var(--text-muted)' }}>Career Rec TDs</td><td style={{ textAlign: 'right' }}>{features.collegeRecTDs}</td></tr> : null}
                      {features.collegeRushYds ? <tr><td style={{ color: 'var(--text-muted)' }}>Career Rush Yards</td><td style={{ textAlign: 'right' }}>{features.collegeRushYds}</td></tr> : null}
                      {features.collegeTotalTDs ? <tr><td style={{ color: 'var(--text-muted)' }}>Career Total TDs</td><td style={{ textAlign: 'right' }}>{features.collegeTotalTDs}</td></tr> : null}
                      {features.collegeBestRecYds ? <tr><td style={{ color: 'var(--text-muted)' }}>Best Season Rec Yds</td><td style={{ textAlign: 'right' }}>{features.collegeBestRecYds}</td></tr> : null}
                      {features.collegeDominatorRating ? <tr><td style={{ color: 'var(--text-muted)' }}>Dominator Rating</td><td style={{ textAlign: 'right' }}>{features.collegeDominatorRating.toFixed(1)}%</td></tr> : null}
                      {features.collegeBreakoutScore ? <tr><td style={{ color: 'var(--text-muted)' }}>Breakout Score</td><td style={{ textAlign: 'right' }}>{features.collegeBreakoutScore.toFixed(3)}</td></tr> : null}
                      {features.collegeRecYdsPerTeamPassAtt ? <tr><td style={{ color: 'var(--text-muted)' }}>Rec Yds/Team Pass Att</td><td style={{ textAlign: 'right' }}>{features.collegeRecYdsPerTeamPassAtt.toFixed(3)}</td></tr> : null}
                      {features.collegeTeammateScore ? <tr><td style={{ color: 'var(--text-muted)' }}>Teammate Score</td><td style={{ textAlign: 'right' }}>{features.collegeTeammateScore.toFixed(3)}</td></tr> : null}
                      {features.hasCombineData > 0 && features.speedScore ? <tr><td style={{ color: 'var(--text-muted)' }}>Speed Score</td><td style={{ textAlign: 'right' }}>{features.speedScore.toFixed(1)}</td></tr> : null}
                      {features.hasPhysicalData > 0 && features.weight ? <tr><td style={{ color: 'var(--text-muted)' }}>Weight</td><td style={{ textAlign: 'right' }}>{features.weight} lbs</td></tr> : null}
                      {features.hasCombineData > 0 && features.forty ? <tr><td style={{ color: 'var(--text-muted)' }}>40-Yard Dash</td><td style={{ textAlign: 'right' }}>{features.forty.toFixed(2)}s</td></tr> : null}
                    </tbody>
                  </table>
                </div>
              )}

              {!hasNFLStats && !hasCollegeStats && (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 20 }}>
                  No stats available for this player
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
