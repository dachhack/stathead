import { useState, useEffect, useMemo } from 'react';
import {
  loadForecastFeatures, loadForecastModels, loadFundamentals, applyScenario, runScenario,
  scenarioValue, impliedValue, featureLabel, SCENARIO_METRICS,
  type ForecastFeatureFile, type ForecastModelFile, type FundamentalsFile, type ScenarioMetric,
} from '../lib/forecastScenario';

/**
 * "What if?" panel for one player on the Dynasty Value Forecast page: move an
 * in-season metric (snap share, targets, carries, availability, depth chart)
 * and rerun the forecast models in the browser. Values are the displayed
 * StatHead scale; the models' log-returns are scale-free.
 */
export function ForecastScenarioExplorer({ playerID, position, currentValue, color }: {
  playerID: number;
  position: string;
  /** Displayed (StatHead-scale) current value; scenario values are this × exp(return). */
  currentValue: number;
  color: string;
}) {
  const [open, setOpen] = useState(false);
  const [features, setFeatures] = useState<ForecastFeatureFile | null>(null);
  const [models, setModels] = useState<ForecastModelFile | null>(null);
  const [fundamentals, setFundamentals] = useState<FundamentalsFile | null>(null);
  const [failed, setFailed] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [focusHorizon, setFocusHorizon] = useState(90);

  // The model caches are a few MB: fetch them the first time the panel opens.
  // The fundamentals model is optional — without it only the forecast
  // path is shown.
  useEffect(() => {
    if (!open || models) return;
    let cancelled = false;
    Promise.all([loadForecastFeatures(), loadForecastModels(), loadFundamentals()]).then(([f, m, fund]) => {
      if (cancelled) return;
      if (!f || !m) { setFailed(true); return; }
      setFeatures(f);
      setModels(m);
      setFundamentals(fund);
    });
    return () => { cancelled = true; };
  }, [open, models]);

  // (The caller keys this component by playerID, so a new player starts from
  // his own numbers with no overrides carried over.)
  const base = features?.players[String(playerID)] ?? null;
  const horizons = useMemo(() => features?.horizons ?? [7, 30, 60, 90, 120], [features]);

  const baseline = useMemo(() => (
    base && models ? runScenario(models, position, base.features, horizons) : []
  ), [base, models, position, horizons]);

  const scenario = useMemo(() => (
    base && models ? runScenario(models, position, applyScenario(base.features, overrides), horizons) : []
  ), [base, models, position, overrides, horizons]);

  const metrics = useMemo(() => {
    if (!models || !base) return [] as ScenarioMetric[];
    // Only metrics at least one of this position's models actually reads.
    const used = new Set<string>();
    for (const h of horizons) {
      const m = models.models[`${position}_H${h}`];
      for (const name of m?.featureNames ?? []) used.add(name);
    }
    return SCENARIO_METRICS.filter(sm =>
      used.has(sm.key) || Object.keys(DERIVED_OF).some(t => used.has(t) && DERIVED_OF[t].includes(sm.key)));
  }, [models, base, position, horizons]);

  const changed = Object.keys(overrides).length > 0;

  // What the market pays for the scenario's stat line, relative to today.
  const fundModel = fundamentals?.models[position] ?? null;
  const implied = useMemo(() => (
    base && fundamentals && fundModel
      ? impliedValue(fundamentals, position, currentValue, base.features, applyScenario(base.features, overrides))
      : null
  ), [base, fundamentals, fundModel, position, currentValue, overrides]);

  return (
    <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6,
        }}
      >
        <span style={{ fontSize: 10 }}>{open ? '▼' : '▶'}</span>
        Scenario explorer
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>
          — change an in-season metric and rerun the forecast
        </span>
      </button>

      {open && failed && (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '8px 0 0' }}>
          Scenario data is unavailable (the forecast feature file or model cache did not load).
        </p>
      )}
      {open && !failed && (!models || !features) && (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '8px 0 0' }}>Loading the forecast models…</p>
      )}
      {open && models && features && !base && (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '8px 0 0' }}>
          No feature vector for this player in the latest forecast run.
        </p>
      )}

      {open && base && models && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 1fr) minmax(260px, 1fr)', gap: 16, marginTop: 10 }}>
          {/* Sliders */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>
                In-season metrics (as of {base.asOf})
              </span>
              {changed && (
                <button
                  onClick={() => setOverrides({})}
                  style={{ fontSize: 11, background: 'none', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', color: 'var(--text-secondary)' }}
                >
                  Reset
                </button>
              )}
            </div>
            {metrics.map(m => {
              const baseV = base.features[m.key] ?? 0;
              const v = overrides[m.key] ?? baseV;
              const isChanged = m.key in overrides && overrides[m.key] !== baseV;
              return (
                <div key={m.key} style={{ marginBottom: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <span title={m.hint} style={{ color: 'var(--text-secondary)' }}>{m.label}</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: isChanged ? 700 : 400, color: isChanged ? color : 'var(--text-primary)' }}>
                      {m.format(v)}
                      {isChanged && <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6 }}>was {m.format(baseV)}</span>}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={m.min} max={m.max} step={m.step}
                    value={Math.min(m.max, Math.max(m.min, v))}
                    onChange={e => {
                      const nv = Number(e.target.value);
                      setOverrides(prev => {
                        const next = { ...prev };
                        if (nv === baseV) delete next[m.key]; else next[m.key] = nv;
                        return next;
                      });
                    }}
                    style={{ width: '100%', accentColor: color }}
                  />
                </div>
              );
            })}
          </div>

          {/* Results */}
          <div>
            {fundamentals && fundModel && implied != null && (
              <div style={{ marginBottom: 14, padding: '10px 12px', background: 'var(--bg-tertiary)', borderRadius: 6 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600, marginBottom: 4 }}>
                  What the market pays for this stat line
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 22, fontWeight: 700, color: changed ? color : 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                    {implied.toLocaleString()}
                  </span>
                  {changed ? (
                    <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: implied > currentValue ? '#22c55e' : implied < currentValue ? '#ef4444' : 'var(--text-muted)' }}>
                      {implied - currentValue >= 0 ? '+' : ''}{(implied - currentValue).toLocaleString()}
                      {' '}({((implied / currentValue - 1) * 100).toFixed(1)}%) vs today&apos;s {currentValue.toLocaleString()}
                    </span>
                  ) : (
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>= today&apos;s value; move a slider</span>
                  )}
                </div>
                {changed && base && (
                  <ChangeAttribution
                    title="Effect of each change on what the market pays"
                    base={base.features}
                    overrides={overrides}
                    evaluate={f => impliedValue(fundamentals, position, currentValue, base.features, f) ?? currentValue}
                    baselineValue={currentValue}
                  />
                )}
                <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '8px 0 0', lineHeight: 1.5 }}>
                  A model of value level from profile and usage alone (no price inputs), applied as a ratio
                  to today&apos;s value. It explains {Math.round(fundModel.cvR2PlayerGrouped * 100)}% of the
                  spread in {position} values for players it was not trained on.
                </p>
              </div>
            )}

            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600, marginBottom: 6 }}>
              Forecast path {changed ? 'with this scenario' : '(move a slider)'}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                  <th style={th}>Horizon</th>
                  <th style={thR}>Baseline</th>
                  <th style={thR}>Scenario</th>
                  <th style={thR}>Δ</th>
                  <th style={thR}>95% band</th>
                </tr>
              </thead>
              <tbody>
                {scenario.map((s, i) => {
                  const b = baseline[i];
                  const sv = scenarioValue(currentValue, s);
                  const bv = scenarioValue(currentValue, b);
                  const delta = sv.value - bv.value;
                  const focused = s.horizon === focusHorizon;
                  return (
                    <tr
                      key={s.horizon}
                      onClick={() => setFocusHorizon(s.horizon)}
                      style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer', background: focused ? 'var(--bg-tertiary)' : 'transparent' }}
                    >
                      <td style={td}>+{s.horizon}d</td>
                      <td style={tdR}>{bv.value.toLocaleString()}</td>
                      <td style={{ ...tdR, fontWeight: 600 }}>{sv.value.toLocaleString()}</td>
                      <td style={{ ...tdR, color: delta > 0 ? '#22c55e' : delta < 0 ? '#ef4444' : 'var(--text-muted)' }}>
                        {delta === 0 ? '—' : `${delta > 0 ? '+' : ''}${delta.toLocaleString()}`}
                      </td>
                      <td style={{ ...tdR, color: 'var(--text-muted)' }}>
                        {sv.ciLow.toLocaleString()}–{sv.ciHigh.toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {changed && base && models && baseline.some(b => b.horizon === focusHorizon) && (
              <ChangeAttribution
                title={`Effect of each change on the +${focusHorizon}d forecast`}
                base={base.features}
                overrides={overrides}
                evaluate={f => {
                  const one = runScenario(models, position, f, [focusHorizon])[0];
                  return one ? scenarioValue(currentValue, one).value : currentValue;
                }}
                baselineValue={scenarioValue(currentValue, baseline.find(b => b.horizon === focusHorizon)!).value}
              />
            )}

            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '10px 0 0', lineHeight: 1.5 }}>
              Each horizon is its own model; the published shrinkage (
              {scenario.find(s => s.horizon === focusHorizon)?.dampen.toFixed(2) ?? '—'}× at +{focusHorizon}d, from how
              much better the model fits training data than held-out players) is applied here too. Trend metrics
              (last 4 vs season) update with the sliders. Scenarios are illustrative: the models have seen one
              in-season stretch of these stats, so moves far outside a player&apos;s own range are extrapolation.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

const DERIVED_OF: Record<string, string[]> = {
  snapPctTrend: ['snapPctLast4', 'snapPctSeason'],
  targetsTrend: ['targetsLast4', 'targetsSeason'],
  carriesTrend: ['carriesLast4', 'carriesSeason'],
};

/**
 * What each of the user's changes does on its own: `evaluate` run on the
 * base features with only that metric changed, minus the baseline value.
 * The one-at-a-time deltas need not add up to the combined scenario (trees
 * interact), so the combined figure is shown alongside.
 */
function ChangeAttribution({ title, base, overrides, evaluate, baselineValue }: {
  title: string;
  base: Record<string, number>;
  overrides: Record<string, number>;
  evaluate: (features: Record<string, number>) => number;
  baselineValue: number;
}) {
  const rows = useMemo(() => {
    const out: { key: string; label: string; delta: number }[] = [];
    for (const key of Object.keys(overrides)) {
      out.push({ key, label: featureLabel(key), delta: evaluate(applyScenario(base, { [key]: overrides[key] })) - baselineValue });
    }
    const combined = evaluate(applyScenario(base, overrides)) - baselineValue;
    return [...out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)), { key: '__all', label: 'All changes together', delta: combined }];
  }, [base, overrides, evaluate, baselineValue]);

  if (rows.length === 0) return null;
  const maxAbs = Math.max(...rows.map(r => Math.abs(r.delta)), 1);
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600, marginBottom: 4 }}>
        {title}
      </div>
      {rows.map(r => {
        const w = Math.abs(r.delta) / maxAbs * 100;
        const isAll = r.key === '__all';
        return (
          <div key={r.key} style={{ display: 'grid', gridTemplateColumns: '1fr 90px 56px', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 3, fontWeight: isAll ? 600 : 400, borderTop: isAll ? '1px solid var(--border)' : 'none', paddingTop: isAll ? 3 : 0 }}>
            <span style={{ color: isAll ? 'var(--text-primary)' : 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {r.label}
            </span>
            <div style={{ height: 6, background: 'var(--bg-tertiary)', borderRadius: 3, position: 'relative' }}>
              <div style={{
                position: 'absolute', top: 0, bottom: 0,
                left: r.delta >= 0 ? '50%' : `${50 - w / 2}%`,
                width: `${w / 2}%`,
                background: r.delta >= 0 ? '#22c55e' : '#ef4444',
                borderRadius: 3,
                opacity: 0.85,
              }} />
            </div>
            <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: r.delta > 0 ? '#22c55e' : r.delta < 0 ? '#ef4444' : 'var(--text-muted)' }}>
              {r.delta === 0 ? '—' : `${r.delta > 0 ? '+' : ''}${r.delta.toLocaleString()}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const th: React.CSSProperties = { padding: '4px 6px', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' };
const thR: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '5px 6px' };
const tdR: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
