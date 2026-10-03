// Devy model documentation: validation, feature importance and data checks for
// the devy board (docs/devy-rankings.md has the long form). Everything shown is
// read from the model files the pipeline writes, so it updates with each
// retrain:
//   devy-model.json        career model (scripts/train_devy_model.py)
//   devy-value-model.json  devy value model (scripts/train_devy_value_model.py)
//   devy-backtest.json     composite backtest (scripts/backtest_devy_value.py)
//   devy-hs-rankings.json  high-school model (scripts/train_devy_hs_model.py)
import { useEffect, useMemo, useState } from 'react';
import { FeatureImportancePanel, type ImportanceRow } from './FeatureImportancePanel';

const POSITIONS = ['QB', 'RB', 'WR', 'TE'] as const;
type Pos = (typeof POSITIONS)[number];
const KS = ['k0', 'k1', 'k2', 'k3'] as const;
const K_LABEL: Record<string, string> = {
  k0: 'Final season (k=0)', k1: '1 season out', k2: '2 seasons out', k3: '3 seasons out',
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

// Readable names for the model features; anything missing falls back to the key in words.
const FEATURE_LABELS: Record<string, string> = {
  k: 'Seasons to draft', n_seasons: 'College seasons played', yrs_since_hs: 'Years since high school',
  stars: 'Recruit stars', rating: 'Recruit rating', height: 'Height', weight: 'Weight', has_recruit: 'Has recruit record',
  recruit_rank_log: 'Recruit national rank (log)', talent_state: 'Talent-rich home state',
  best_rec_yds: 'Best receiving yards', best_dominator: 'Best dominator', best_rush_yds: 'Best rushing yards',
  best_rush_yds_sh: 'Best rushing share', best_scrim_yds: 'Best scrimmage yards', best_pass_yds: 'Best passing yards',
  best_pass_ypa: 'Best yards/attempt', best_pass_td_rate: 'Best TD-INT rate',
  last_rec_yds: 'Last-season receiving yards', last_dominator: 'Last-season dominator', last_rush_yds: 'Last-season rushing yards',
  last_scrim_yds: 'Last-season scrimmage yards', last_scrim_td: 'Last-season scrimmage TDs', last_pass_yds: 'Last-season passing yards',
  last_pass_ypa: 'Last-season yards/attempt', last_pass_cmp_pct: 'Last-season completion %', last_pass_td_rate: 'Last-season TD-INT rate',
  last_rush_car: 'Last-season carries', car_scrim_ypg: 'Career scrimmage yds/season', car_pass_ypg: 'Career passing yds/season',
  jump_scrim: 'Scrimmage-yard jump', jump_pass: 'Passing-yard jump', breakout_n: 'Seasons to breakout',
  talent_last: 'Team recruiting talent', fbs_last: 'FBS last season', fbs_share: 'Share of seasons at FBS', sp_last: 'Team SP+',
  sp_off_last: 'Team offensive SP+', p4_last: 'Power-conference team', est_age: 'Estimated age', est_draft_age: 'Estimated draft age',
  breakout_age: 'Breakout age', broke_out: 'Has broken out', teammate_best_dom: "Best teammate's dominator",
  best_usage: 'Best usage rate', last_usage: 'Last-season usage', last_pass_usage: 'Last-season passing-down usage',
  last_rush_usage: 'Last-season rushing-down usage', last_third_down_usage: 'Last-season third-down usage',
  team_elo_last: 'Team Elo', team_ppg_last: 'Team points/game', board_pick_log: 'Mock-draft pick (log)',
  board_consensus_log: 'Big-board rank (log)', on_board: 'On a draft big board', pos_QB: 'Is QB', pos_RB: 'Is RB',
  pos_WR: 'Is WR', pos_TE: 'Is TE',
  best_long: 'Longest play', car_pass_yds: 'Career passing yards', car_rec_yds: 'Career receiving yards',
  car_rush_yds: 'Career rushing yards', car_td: 'Career TDs', fum_lost_last: 'Last-season fumbles lost',
  last_pass_att: 'Last-season pass attempts', last_pass_int: 'Last-season INTs', last_pass_td: 'Last-season passing TDs',
  last_passing_downs_usage: 'Last-season passing-down usage', last_standard_downs_usage: 'Last-season standard-down usage',
  last_rec: 'Last-season receptions', last_rec_td: 'Last-season receiving TDs', last_rec_yds_sh: 'Last-season receiving share',
  last_rush_td: 'Last-season rushing TDs', last_rush_yds_sh: 'Last-season rushing share', last_ypc: 'Last-season yards/carry',
  last_ypr: 'Last-season yards/catch', n_teams: 'Schools played for', ret_yds_last: 'Last-season return yards',
  tm_pass_rate_last: 'Team pass rate', transferred: 'Transferred',
};

// Feature families, for the category column.
function category(k: string): string {
  if (/^(stars|rating|has_recruit|recruit_rank_log|talent_state|height|weight)$/.test(k)) return 'Recruiting';
  if (/age|yrs_since_hs|n_seasons|^k$|breakout|broke_out/.test(k)) return 'Age & timeline';
  if (/usage|_sh$|dominator|teammate/.test(k)) return 'Role & share';
  if (/talent_last|sp_|^sp_last|fbs|p4_|team_|tm_|elo/.test(k)) return 'Team & competition';
  if (/^board_|on_board/.test(k)) return 'Draft boards';
  if (/^pos_/.test(k)) return 'Position';
  if (/transfer|n_teams/.test(k)) return 'Transfers';
  return 'Production';
}
const label = (k: string) => FEATURE_LABELS[k] ?? k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

function shapeOf(d: number): { shape: string; text: string } {
  if (d >= 0.5) return { shape: 'increasing', text: 'higher value → higher output' };
  if (d >= 0.15) return { shape: 'mostly-increasing', text: 'mostly: higher value → higher output' };
  if (d <= -0.5) return { shape: 'decreasing', text: 'higher value → lower output' };
  if (d <= -0.15) return { shape: 'mostly-decreasing', text: 'mostly: higher value → lower output' };
  return { shape: 'non-monotone', text: 'no single direction (depends on the other features)' };
}

function shapRows(imp: Record<string, { meanAbsShap: number; direction: number }> | undefined, top = 15): ImportanceRow[] {
  if (!imp) return [];
  return Object.entries(imp).slice(0, top).map(([k, v]) => {
    const s = shapeOf(v.direction);
    return { label: label(k), category: category(k), importance: v.meanAbsShap, direction: v.direction, rankCorrelation: null,
      shape: s.shape, shapeText: s.text };
  });
}

function coefRows(imp: Record<string, { coef: number }> | undefined, top = 15): ImportanceRow[] {
  if (!imp) return [];
  return Object.entries(imp)
    .sort((a, b) => Math.abs(b[1].coef) - Math.abs(a[1].coef)).slice(0, top)
    .map(([k, v]) => ({
      label: label(k), category: category(k), importance: Math.abs(v.coef), direction: v.coef, rankCorrelation: null,
      shape: v.coef > 0 ? 'increasing' : 'decreasing',
      shapeText: v.coef > 0 ? 'higher value → higher price' : 'higher value → lower price',
    }));
}

const card: React.CSSProperties = {
  background: 'var(--bg-secondary)', borderRadius: 8, padding: 16, marginBottom: 20, border: '1px solid var(--border)',
};
const h3: React.CSSProperties = { margin: '0 0 8px', fontSize: 15 };
const note: React.CSSProperties = { fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '0 0 10px' };
const r: React.CSSProperties = { textAlign: 'right' };
const f3 = (x: number | null | undefined) => (x == null ? '—' : x.toFixed(3));
const f2 = (x: number | null | undefined) => (x == null ? '—' : x.toFixed(2));

function Pills<T extends string>({ value, options, onChange }: { value: T; options: readonly T[] | T[]; onChange: (v: T) => void }) {
  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
      {options.map((o) => (
        <button key={o} onClick={() => onChange(o)}
          style={{
            padding: '4px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
            border: `1px solid ${value === o ? '#a78bfa' : 'var(--border)'}`,
            background: value === o ? 'rgba(167,139,250,0.12)' : 'transparent',
            color: value === o ? '#a78bfa' : 'var(--text-secondary)',
          }}>{o}</button>
      ))}
    </div>
  );
}

function Table({ head, rows }: { head: (string | [string, string])[]; rows: (React.ReactNode)[][] }) {
  return (
    <div className="table-container" style={{ maxHeight: 'none' }}>
      <table className="sched-table" style={{ fontSize: 12 }}>
        <thead>
          <tr>{head.map((h, i) => {
            const [t, tip] = Array.isArray(h) ? h : [h, undefined];
            return <th key={i} title={tip} style={i ? r : undefined}>{t}</th>;
          })}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>{row.map((c, j) => <td key={j} style={j ? r : undefined}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const BAND_LABEL: Record<string, string> = {
  nonFBS: 'Below FBS', 'SP<-5': 'Weak FBS (SP+ below −5)', 'SP-5..5': 'Average (−5 to 5)', 'SP5..15': 'Good (5 to 15)', 'SP15+': 'Elite (15+)',
};

const TARGETS = { 'PPG': 'ppg', 'Value over replacement (superflex)': 'vor_sf', 'Value over replacement (1QB)': 'vor_oneQB' } as const;
type TargetLabel = keyof typeof TARGETS;

export function DevyValidation() {
  const [career, setCareer] = useState<Json>(null);
  const [value, setValue] = useState<Json>(null);
  const [bt, setBt] = useState<Json>(null);
  const [hs, setHs] = useState<Json>(null);
  const [failed, setFailed] = useState(false);
  const [target, setTarget] = useState<TargetLabel>('PPG');
  const [impPos, setImpPos] = useState<Pos>('WR');
  const [valImp, setValImp] = useState<'On the list' | 'Price (superflex)' | 'Price (1QB)'>('On the list');
  const [btFmt, setBtFmt] = useState<'Superflex' | '1QB'>('Superflex');

  useEffect(() => {
    const base = import.meta.env.BASE_URL;
    const get = (f: string) => fetch(`${base}data/${f}`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
    Promise.all([get('devy-model.json'), get('devy-value-model.json'), get('devy-backtest.json'), get('devy-hs-rankings.json')])
      .then(([c, v, b, h]) => {
        setCareer(c); setValue(v); setBt(b); setHs(h);
        if (!c && !v) setFailed(true);
      });
  }, []);

  const careerImp = useMemo(() => shapRows(career?.importance?.[TARGETS[target]]?.[impPos]), [career, target, impPos]);
  const valueImp = useMemo(() => {
    if (!value?.importance) return [];
    if (valImp === 'On the list') return shapRows(value.importance.pListed);
    return coefRows(value.importance[valImp === 'Price (1QB)' ? 'oneQB' : 'sf']);
  }, [value, valImp]);

  if (failed) return <div style={card}>Could not load the devy model files.</div>;
  if (!career) return <div style={card}>Loading devy model files…</div>;

  const tKey = TARGETS[target];
  const met = career.metrics?.[tKey] ?? {};
  const cal = career.calibration;
  const ins = career.inSeason;
  const cw = bt?.compositeWeights;
  const btKey = btFmt === 'Superflex' ? 'sf|top|y_vor_sf|board|fitted' : 'oneQB|top|y_vor_oneQB|board|fitted';
  const btRes = bt?.results?.[btKey];

  return (
    <div>
      {/* ── Overview ── */}
      <div style={card}>
        <h3 style={h3}>Devy pipeline overview</h3>
        <p style={note}>
          The devy board ranks every current college QB, RB, WR and TE on a <strong>composite</strong>. It blends two
          StatHead models by rank: a <strong>devy value model</strong>, which prices a player's college profile the way
          the devy market prices profiles like it, and a <strong>career model</strong>, which projects his NFL fantasy
          production. Third-party prices are inputs only, and nothing on the board is a third-party number.
        </p>
        <ol style={{ ...note, paddingLeft: 18 }}>
          <li><strong>Career model</strong> (LightGBM, one per position): trained on {career.nSnapshots?.toLocaleString()} college snapshots from the {career.classes?.[0]}–{career.classes?.[1]} draft classes. Target: {career.target}</li>
          <li><strong>Devy value model</strong>: P(on the market's devy list) × the price a listed player with that profile gets (ridge on log price), trained on today's market cross-section.</li>
          <li><strong>Composite</strong>: (1 − w) × market z + w × career z. The career weight w comes from the career model's held-out skill at that position and distance from the draft (0.05–0.35), or from the backtest where it validated better (never above 0.5). Within a position the order is the same in both formats.</li>
          <li><strong>In season</strong>: profiles run through the last completed week (a full-season estimate); rescored weekly on Sundays.</li>
        </ol>
        <p style={{ ...note, margin: 0, color: 'var(--text-muted)' }}>
          Career model built {career.generatedAt?.slice(0, 10)}
          {ins?.season ? ` · profiles through ${ins.season} week ${ins.throughWeek}` : ''}. All metrics below are held out: each draft class is scored by a model trained without it.
        </p>
      </div>

      {/* ── Career model accuracy ── */}
      <div style={card}>
        <h3 style={h3}>Career model: held-out accuracy</h3>
        <p style={note}>
          Spearman rank correlation between the projection and the NFL outcome, per draft class (left out one class at a
          time), averaged across classes, by position and seasons before the draft. Two baselines: last-season college
          production, and the recruiting rating alone. Top-12 hits counts how many of each class's 12 best NFL outcomes the
          model ranks in its own top 12.
        </p>
        <Pills value={target} options={Object.keys(TARGETS) as TargetLabel[]} onChange={setTarget} />
        <Table
          head={['Position / when', 'n', ['Model ρ', 'Spearman, held out'], ['Production ρ', 'Last-season production baseline'],
            ['Rating ρ', 'Recruit rating baseline'], ['Top-12 hits', 'Model'], ['Top-12 (prod.)', 'Production baseline']]}
          rows={POSITIONS.flatMap((pos) => KS.filter((k) => met[pos]?.[k]).map((k) => {
            const m = met[pos][k];
            const win = m.pred.spearman >= (m.base_prod?.spearman ?? -1);
            return [
              <span key="l"><strong>{pos}</strong> · {K_LABEL[k]}</span>, m.n?.toLocaleString(),
              <strong key="m" style={{ color: win ? 'var(--text-primary)' : 'var(--text-muted)' }}>{f3(m.pred.spearman)}</strong>,
              f3(m.base_prod?.spearman), f3(m.base_rating?.spearman), f2(m.pred.top12Hits), f2(m.base_prod?.top12Hits),
            ];
          }))}
        />
        <p style={{ ...note, marginTop: 10 }}>
          Close to the draft, last-season production is a strong baseline and the model roughly matches it. The model's
          edge grows with distance from the draft, where production is thin and the model's age, recruiting and program
          features carry more. That's why the composite gives the career model more weight further out.
        </p>
      </div>

      {/* ── Calibration ── */}
      {cal?.heldOut && (
        <div style={card}>
          <h3 style={h3}>Career model: competition calibration</h3>
          <p style={note}>
            Raw projections overstated players on weak teams. The model is fitted on production, and production is
            easier against weaker schedules. A multiplier per position and team-strength band (SP+), shrunk toward 1
            (prior {cal.prior}) and fitted on out-of-fold predictions, corrects it. Shown here, validated nested by
            class: actual NFL outcome ÷ projection, raw and calibrated (1.00 = unbiased).
          </p>
          <Table
            head={['Team strength (SP+)', ...POSITIONS.filter((p) => cal.heldOut[p]).map((p) => [`${p}: raw → cal.`, 'actual ÷ projection, raw → calibrated'] as [string, string])]}
            rows={cal.bands.map((b: string) => [
              <strong key="b">{BAND_LABEL[b] ?? b}</strong>,
              ...POSITIONS.filter((p) => cal.heldOut[p]).map((p) => {
                const x = cal.heldOut[p].byBand?.[b];
                return <span key={p}><span style={{ color: 'var(--text-muted)' }}>{f2(x?.actualOverRaw)} → </span><strong>{f2(x?.actualOverCalibrated)}</strong></span>;
              }),
            ])}
          />
        </div>
      )}

      {/* ── In-season blend ── */}
      {ins?.replay && (
        <div style={card}>
          <h3 style={h3}>In season: how much to trust this season so far</h3>
          <p style={note}>
            Each week the career model blends last season's profile with this season's (projected to a full season). The
            weight is chosen by replaying past seasons at the same week ({ins.season} week {ins.throughWeek}): held-out
            Spearman for last season only, this season only, and the best blend.
          </p>
          <Table
            head={['Position / when', ['Last season', 'Profile through last season'], ['This season', 'Season to date, projected'],
              ['Blend', 'Best blend, held out'], ['Weight on this season', 'Used in this week\'s scores']]}
            rows={POSITIONS.flatMap((pos) => Object.keys(ins.replay[pos] ?? {}).filter((k) => /^k\d$/.test(k)).sort().map((k) => {
              const x = ins.replay[pos][k];
              const used = ins.usedFor?.[pos]?.[k];
              return [<span key="l"><strong>{pos}</strong> · {K_LABEL[k] ?? k}</span>, f3(x.prev), f3(x.inseason), f3(x.blend),
                <strong key="w">{used == null ? '—' : `${Math.round(used * 100)}%`}</strong>];
            }))}
          />
        </div>
      )}

      {/* ── Career importance ── */}
      <div style={card}>
        <h3 style={h3}>Career model: what drives the projection</h3>
        <Pills value={impPos} options={POSITIONS} onChange={setImpPos} />
        <FeatureImportancePanel
          rows={careerImp}
          importanceNote={`Mean |SHAP| contribution to the ${target === 'PPG' ? 'PPG' : 'value-over-replacement'} projection, top 15 of ${Object.keys(career.importance?.[tKey]?.[impPos] ?? {}).length} features (${impPos}). The r column is the rank correlation between a feature's value and its SHAP contribution: positive = more of it raises the projection.`}
        />
      </div>

      {/* ── Value model ── */}
      {value?.metrics && (
        <div style={card}>
          <h3 style={h3}>Devy value model: held-out accuracy</h3>
          <p style={note}>
            Two parts, each scored on players held out of training. <strong>Listing</strong>: does the model pick the
            players the devy market lists (about 100) out of every college skill player? <strong>Price</strong>: among
            listed players, does it reproduce the market's order? Baseline: the recruiting rating alone.
          </p>
          <Table
            head={['Part', 'Model', 'Recruit rating']}
            rows={[
              ['Listing AUC, vs all FBS players', f3(value.metrics.pListed.aucListedVsUnlistedFBS), f3(value.metrics.pListed.recruitRating?.aucFBS)],
              ['Listing AUC, vs plausible players', f3(value.metrics.pListed.aucListedVsPlausible), f3(value.metrics.pListed.recruitRating?.aucPlausible)],
              ['Listing precision at K', f3(value.metrics.pListed.precisionAtK), f3(value.metrics.pListed.recruitRating?.precisionAtK)],
              ...(['sf', 'oneQB'] as const).filter((f) => value.metrics[f]).map((f) => {
                const m = value.metrics[f];
                return [`Price rank ρ, ${f === 'sf' ? 'superflex' : '1QB'} (${m.regressor}, n=${m.nListed})`,
                  f3(m[`${m.regressor}_spearmanIfListed`]), f3(m.spearmanRecruitRating)];
              }),
            ]}
          />
          <p style={{ ...note, marginTop: 10 }}>
            "Plausible" players are FBS players who were 4-star recruits or had 700+ scrimmage, 2,000+ passing yards or
            a 20%+ usage rate: the hard negatives. In 1QB the board's market input for a listed player is his superflex
            price through a smooth per-position line, so this 1QB price model matters only for unlisted players.
          </p>
          <h3 style={{ ...h3, marginTop: 16 }}>Devy value model: what the market pays for</h3>
          <Pills value={valImp} options={['On the list', 'Price (superflex)', 'Price (1QB)'] as const} onChange={setValImp} />
          <FeatureImportancePanel
            rows={valueImp}
            importanceNote={valImp === 'On the list'
              ? 'Mean |SHAP| contribution to the log-odds of being on the market\'s devy list, top 15. r: rank correlation of the feature with its contribution; positive = more of it raises the odds.'
              : 'Absolute standardized ridge coefficient on log price, top 15; the r column is the signed coefficient.'}
          />
        </div>
      )}

      {/* ── Composite backtest ── */}
      {bt && (
        <div style={card}>
          <h3 style={h3}>Composite backtest</h3>
          <p style={note}>
            The value model and composite scored on past classes ({bt.classes?.[0]}–{bt.classes?.[1]};{' '}
            {bt.nPlayers?.toLocaleString()} players, {bt.nSnapshots?.toLocaleString()} snapshots), ranked against NFL
            value over replacement across the whole board (each class's top 100 by value). Shipped = the composite as
            built. Fitted = a career weight chosen on the other classes. Value only = the value model alone. Top-24 hits:
            the class's 24 best NFL outcomes found in the top 24.
          </p>
          <Pills value={btFmt} options={['Superflex', '1QB'] as const} onChange={setBtFmt} />
          {btRes && (
            <Table
              head={['When', ['Shipped ρ', 'Composite as built'], ['Fitted ρ', 'Weight chosen leave-one-class-out'],
                ['Value only ρ', 'Value model alone'], 'Shipped top-24', 'Value top-24']}
              rows={KS.filter((k) => btRes[k]).map((k) => [K_LABEL[k], <strong key="s">{f3(btRes[k].shipped?.spearman)}</strong>,
                f3(btRes[k].fitted_heldout?.spearman), f3(btRes[k].value?.spearman), f2(btRes[k].shipped?.top24Hits), f2(btRes[k].value?.top24Hits)])}
            />
          )}
          {cw?.leaveOneClassOut && (
            <>
              <p style={{ ...note, marginTop: 12 }}>
                <strong>Adopted career weights.</strong> A fitted weight replaces the skill-based rule only where, held
                out, it beats the rule within position by {cw.adoptGain}+ <em>and</em> lifts the whole board by{' '}
                {cw.boardGain}+ in both formats.
              </p>
              <Table
                head={['Position', ...KS.map((k) => [K_LABEL[k], 'rule weight → fitted weight; held-out ρ fitted vs rule'] as [string, string])]}
                rows={POSITIONS.map((pos) => [<strong key="p">{pos}</strong>, ...KS.map((k) => {
                  const x = cw.leaveOneClassOut?.[pos]?.[k];
                  const adopted = cw.adopt?.[pos]?.[k];
                  if (!x) return '—';
                  return (
                    <span key={k} style={{ color: adopted != null ? '#a78bfa' : undefined }}>
                      {adopted != null ? `adopted ${adopted}` : `rule ${f2(x.shippedWeight)}`}
                      <span style={{ color: 'var(--text-muted)' }}> ({f3(x.heldOut)} vs {f3(x.shipped)})</span>
                    </span>
                  );
                })])}
              />
            </>
          )}
        </div>
      )}

      {/* ── High school ── */}
      {hs?.metrics?.byPosition && (
        <div style={card}>
          <h3 style={h3}>High-school board</h3>
          <p style={note}>
            High-school recruits are scored from the recruiting composite alone: a Tweedie model of career fantasy
            production and a logistic model of being drafted, trained on the {hs.trainClasses?.[0]}–{hs.trainClasses?.[1]}{' '}
            classes (busts included). Held out one class at a time, nothing beat the rating itself at ordering a position,
            so the model's value is putting positions on one scale.
          </p>
          <Table
            head={['Position', 'Recruits', 'Drafted', ['Model ρ', 'Spearman with career production'], ['Rating ρ', 'Rating alone'],
              ['Model AUC (drafted)', 'Held out'], ['Rating AUC', 'Rating alone']]}
            rows={POSITIONS.filter((p) => hs.metrics.byPosition[p]).map((p) => {
              const x = hs.metrics.byPosition[p];
              return [<strong key="p">{p}</strong>, x.n?.toLocaleString(), x.drafted, f3(x.model?.spearman), f3(x.rating?.spearman),
                f3(x.model?.aucDrafted), f3(x.rating?.aucDrafted)];
            })}
          />
        </div>
      )}

      {/* ── Data checks ── */}
      <div style={card}>
        <h3 style={h3}>Data checks and fixes</h3>
        <p style={note}>Validation found these problems in the inputs; each fix is tested before adoption.</p>
        <ul style={{ ...note, paddingLeft: 18 }}>
          <li><strong>Recruit links.</strong> CFBD leaves the player id off about half its recruiting records, so
            those players had no stars or rating. They're now linked by name, school and timing (97.6% right where
            CFBD does link). Superflex QB value skill rose from 0.160 to 0.200 held out.</li>
          <li><strong>Wrong recruit ids.</strong> A CFBD id that names a different player (Roydell Williams carried
            Hykeem Williams's 5-star record) is re-linked by name. Neutral on accuracy.</li>
          <li><strong>Ages without a recruit record.</strong> College entry for walk-ons and JUCO or lower-division
            transfers comes from ESPN's stat log and class year, so earlier years count (Trinidad Chambliss 19.9 → 21.9).</li>
          <li><strong>Off-roster players.</strong> In season, a player on no FBS/FCS roster with no stats this
            season at an FBS/FCS school is not ranked (about 800 players).</li>
          <li><strong>Schedule.</strong> A key-format bug left the 2026 schedule unread, so season-to-date lines were
            not projected to a full season. Fixed on Oct 2.</li>
          <li><strong>Format consistency.</strong> The 1QB market input is the superflex price through a smooth
            per-position line, and the order within a position is the same in both formats.</li>
          <li><strong>Tested and rejected</strong> (no held-out gain): strength of schedule, conference level and
            teammate competition as features; QB conference; opponent-adjusted season-to-date stats.</li>
        </ul>
        <p style={{ ...note, margin: 0, color: 'var(--text-muted)' }}>Full write-up: docs/devy-rankings.md in the repository.</p>
      </div>
    </div>
  );
}
