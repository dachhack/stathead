/**
 * PlayerCard — expandable player detail card for model comparisons.
 * Shows basic stats, model feature scores, career/college stats, and photo.
 */

import { useState } from 'react';
import { PRE_DRAFT_ROOKIE_FEATURES, FEATURES, POS_COLORS, CATEGORY_COLORS } from '../lib/featureTypes';

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
  };
  onClose: () => void;
}

const FEATURE_LABELS: Record<string, string> = {};
for (const f of FEATURES) { FEATURE_LABELS[f.key] = f.label; }

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

function featureBar(value: number, max: number, color: string) {
  const pct = max > 0 ? Math.min(100, (Math.abs(value) / max) * 100) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, width: '100%' }}>
      <div style={{ flex: 1, height: 5, background: 'var(--bg-tertiary)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: 10, color: 'var(--text-secondary)', minWidth: 36, textAlign: 'right' }}>
        {fmtVal(value)}
      </span>
    </div>
  );
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
          {player.ourScore != null && player.ourScore > 0 && (
            <div style={{ background: 'var(--bg-secondary)', borderRadius: 6, padding: '4px 8px', textAlign: 'center' }}>
              <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>Our Score</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#22c55e' }}>{player.ourScore.toFixed(1)}</div>
            </div>
          )}
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
              {/* Model-specific features first */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#8b5cf6', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>
                  Career Model Inputs ({pos})
                </div>
                {modelFeatureKeys.map(key => {
                  const val = features[key] ?? 0;
                  // Determine reasonable max for bar scaling
                  const maxVal = key.includes('log') ? 6 : key.includes('inv') ? 0.5 :
                    key === 'age' ? 24 : key === 'weight' ? 250 :
                    key.includes('Score') ? 120 : key.includes('Yds') ? 2000 :
                    key.includes('TDs') ? 40 : key.includes('Rating') ? 50 : 1;
                  return (
                    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 10, color: 'var(--text-secondary)', minWidth: 120, flexShrink: 0 }}>
                        {featureLabel(key)}
                      </span>
                      {featureBar(val, maxVal, '#8b5cf6')}
                    </div>
                  );
                })}
              </div>

              {/* All features by category */}
              {[...featuresByCategory.entries()].map(([category, feats]) => (
                <details key={category} style={{ marginBottom: 8 }}>
                  <summary style={{
                    fontSize: 11, fontWeight: 600, cursor: 'pointer',
                    color: CATEGORY_COLORS[category] || 'var(--text-secondary)',
                    textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4,
                  }}>{category} ({feats.filter(f => f.value !== 0).length}/{feats.length})</summary>
                  {feats.filter(f => f.value !== 0).map(({ key, value }) => (
                    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                      <span style={{ fontSize: 9, color: 'var(--text-muted)', minWidth: 110, flexShrink: 0 }}>
                        {featureLabel(key)}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                        {typeof value === 'number' ? (Number.isInteger(value) ? value : value.toFixed(2)) : value}
                      </span>
                    </div>
                  ))}
                </details>
              ))}
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
                      {features.speedScore ? <tr><td style={{ color: 'var(--text-muted)' }}>Speed Score</td><td style={{ textAlign: 'right' }}>{features.speedScore.toFixed(1)}</td></tr> : null}
                      {features.weight ? <tr><td style={{ color: 'var(--text-muted)' }}>Weight</td><td style={{ textAlign: 'right' }}>{features.weight} lbs</td></tr> : null}
                      {features.forty ? <tr><td style={{ color: 'var(--text-muted)' }}>40-Yard Dash</td><td style={{ textAlign: 'right' }}>{features.forty.toFixed(2)}s</td></tr> : null}
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
