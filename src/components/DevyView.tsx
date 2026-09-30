import { useEffect, useMemo, useState } from 'react';

// Devy rankings (public/data/devy-rankings.json, scripts/build-devy-rankings.py):
// the composite of the devy market (KTC, or the devy value model beyond its
// list) and our NFL career projection (scripts/train_devy_model.py), priced on
// the dynasty scale via KTC's future rookie-pick values.

type Fmt = 'sf' | 'oneQB';

interface DevyPlayer {
  name: string;
  pos: 'QB' | 'RB' | 'WR' | 'TE';
  school: string | null;
  draftYear: number;
  /** Market price, KTC 0-9999 devy scale: KTC's own where listed, else the devy value model. */
  devyValue: Record<Fmt, number>;
  valueSource: 'ktc' | 'model';
  ktc: { sf: number | null; oneQB: number | null; sfRank: number | null; oneQBRank: number | null };
  /** The value model's price (listed players: what it says KTC should pay, fit without his price). */
  modelValue: Record<Fmt, number> | null;
  pListed: number | null;
  /** NFL projection per format: expected mean of his best two NFL seasons in his first four, PPR points per game above replacement. */
  careerScore: Record<Fmt, number | null>;
  /** The raw projection (PPR PPG, not above replacement). */
  careerPPG: number | null;
  careerRank?: Record<Fmt, number>;
  careerPct?: Record<Fmt, number>;
  careerVsValue?: Record<Fmt, number>;
  /** Rank by devy value (the market) alone. */
  rank: Record<Fmt, number>;
  posRank: Record<Fmt, number>;
  /** Market and career blended in rank space, priced on the market's value curve. */
  compositeValue: Record<Fmt, number>;
  compositeRank: Record<Fmt, number>;
  compositePosRank: Record<Fmt, number>;
  /** The career projection's share of the composite. */
  compositeWeight: Record<Fmt, number>;
  /** Priced by composite class rank. */
  dynasty: Record<Fmt, { value: number; classRank: number; pickEquiv: string }>;
  dynastyMarket?: Record<Fmt, { value: number; classRank: number; pickEquiv: string }>;
  profile: {
    est_age: number; est_draft_age: number; breakout_age: number; best_dominator: number;
    last_usage: number; stars: number; sp_last: number;
  } | null;
}

interface DevyDoc {
  generatedAt: string;
  modelAsOfSeason: number;
  profilesThrough?: string;
  inSeason?: { season: number; throughWeek: number; careerInSeasonPositions: string[] } | null;
  classes: number[];
  valueModel?: { spearmanIfListed: Record<Fmt, number | null>; aucListed: number | null };
  replacementPPG?: Record<Fmt, Record<'QB' | 'RB' | 'WR' | 'TE', number>>;
  composite?: { careerWeights: Record<string, Record<string, number>>; rule: string };
  players: DevyPlayer[];
}

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'] as const;
type SortKey = 'comp' | 'rank' | 'dynasty' | 'career' | 'cvv';

const btn = (on: boolean): React.CSSProperties => ({
  padding: '6px 12px',
  background: on ? 'var(--bg-tertiary)' : 'transparent',
  color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: on ? 600 : 400,
});

const thStyle: React.CSSProperties = {
  padding: '8px 6px',
  fontWeight: 600,
  fontSize: 11,
  color: 'var(--text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  whiteSpace: 'nowrap',
  textAlign: 'left',
};

const tdStyle: React.CSSProperties = { padding: '6px', whiteSpace: 'nowrap' };
const num: React.CSSProperties = { ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

export function DevyView() {
  const [doc, setDoc] = useState<DevyDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fmt, setFmt] = useState<Fmt>('sf');
  const [pos, setPos] = useState<(typeof POSITIONS)[number]>('ALL');
  const [cls, setCls] = useState<number | 'ALL'>('ALL');
  const [search, setSearch] = useState('');
  const [src, setSrc] = useState<'all' | 'ktc' | 'model'>('all');
  const [sort, setSort] = useState<SortKey>('comp');

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/devy-rankings.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setDoc)
      .catch((e) => setError(String(e)));
  }, []);

  const rows = useMemo(() => {
    if (!doc) return [];
    const q = search.trim().toLowerCase();
    const key: Record<SortKey, (p: DevyPlayer) => number> = {
      comp: (p) => p.compositeRank[fmt],
      rank: (p) => p.rank[fmt],
      dynasty: (p) => -p.dynasty[fmt].value,
      career: (p) => -(p.careerScore[fmt] ?? -1e9),
      cvv: (p) => -(p.careerVsValue?.[fmt] ?? -1e9),
    };
    return doc.players
      .filter((p) => (pos === 'ALL' || p.pos === pos) && (cls === 'ALL' || p.draftYear === cls))
      .filter((p) => src === 'all' || p.valueSource === src)
      .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.school ?? '').toLowerCase().includes(q))
      .sort((a, b) => key[sort](a) - key[sort](b));
  }, [doc, fmt, pos, cls, search, sort, src]);

  if (error) return <div style={{ padding: 16 }}>Could not load devy rankings: {error}</div>;
  if (!doc) return <div style={{ padding: 16 }}>Loading devy rankings…</div>;

  const sortTh = (k: SortKey, label: string, title?: string) => (
    <th onClick={() => setSort(k)} title={title}
      style={{ ...thStyle, textAlign: 'right', cursor: 'pointer', color: sort === k ? 'var(--text-primary)' : thStyle.color }}>
      {label}{sort === k ? ' ↓' : ''}
    </th>
  );

  return (
    <div style={{ padding: 16 }}>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ margin: '0 0 4px 0' }}>Devy Rankings</h2>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 950 }}>
          Ranked by the <b>composite</b>: the market price and our NFL career projection blended by rank, then priced on
          the market's own value scale. The career model's share is its own held-out accuracy at the player's position and
          distance from the draft (about 11–17% for QBs, 17–25% for TEs, 22–32% for RBs and WRs), so the market always
          leads and QBs move least. Underneath are two scores. <b>Devy value</b> is the market price on KTC's devy scale: KTC's own for the
          ~100 players it lists, and for everyone else our devy value model (the chance KTC would list him × what it pays
          for a listed player with his profile — age, breakout age, share of the offense, production, program,
          competition; held-out rank correlation with KTC {doc.valueModel?.spearmanIfListed?.[fmt] ?? '—'}).
          <b> Career</b> is our NFL projection: expected mean of his best two NFL seasons in his first four, in PPR points per
          game above replacement for a 12-team {fmt === 'sf' ? 'superflex / 2QB' : 'single-QB'} league
          {doc.replacementPPG?.[fmt] ? ` (replacement: QB ${doc.replacementPPG[fmt].QB}, RB ${doc.replacementPPG[fmt].RB}, WR ${doc.replacementPPG[fmt].WR}, TE ${doc.replacementPPG[fmt].TE} PPG)` : ''},
          so it compares across positions and a QB is worth more in superflex. Every score and rank switches with the
          format. Mkt # is the rank by devy value alone; ± sets the market and career ranks against each other (green: the
          projection likes him more than the market). Dynasty prices his composite class rank as a rookie pick, from KTC's future pick values. Ages are estimated from the high-school
          class; profiles run through {doc.inSeason
            ? <>{doc.inSeason.season} week {doc.inSeason.throughWeek} (season to date, as a full-season estimate calibrated on
              past seasons at the same week; the career model uses it for {doc.inSeason.careerInSeasonPositions.join('/') || 'no position yet'})</>
            : <>the {doc.modelAsOfSeason} season</>}.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="text" placeholder="Search name / school" value={search} onChange={(e) => setSearch(e.target.value)}
          style={{ padding: '6px 10px', background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            color: 'var(--text-primary)', borderRadius: 4, fontSize: 13, minWidth: 200 }} />
        <div style={{ display: 'flex', gap: 4 }}>
          <button style={btn(fmt === 'sf')} onClick={() => setFmt('sf')} title="Superflex / 2QB: a second QB can start">Superflex / 2QB</button>
          <button style={btn(fmt === 'oneQB')} onClick={() => setFmt('oneQB')} title="Single QB">1QB</button>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {POSITIONS.map((p) => <button key={p} style={btn(pos === p)} onClick={() => setPos(p)}>{p}</button>)}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button style={btn(cls === 'ALL')} onClick={() => setCls('ALL')}>All classes</button>
          {doc.classes.map((c) => <button key={c} style={btn(cls === c)} onClick={() => setCls(c)}>{c}</button>)}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button style={btn(src === 'all')} onClick={() => setSrc('all')}>All</button>
          <button style={btn(src === 'ktc')} onClick={() => setSrc('ktc')}>On KTC</button>
          <button style={btn(src === 'model')} onClick={() => setSrc('model')}>Beyond KTC</button>
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>{rows.length} players</div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {sortTh('comp', '#', 'Composite rank: market and career projection blended')}
              <th style={thStyle}>Player</th>
              <th style={thStyle}>Pos</th>
              <th style={thStyle}>School</th>
              <th style={thStyle}>Class</th>
              {sortTh('comp', 'Composite', 'Market price and career projection blended by rank, priced on the market value scale (career weight in the tooltip)')}
              {sortTh('rank', 'Mkt #', 'Rank by devy value (the market) alone')}
              <th style={{ ...thStyle, textAlign: 'right' }} title="Market price, KTC devy scale: KTC's own where listed, else the devy value model">Devy value</th>
              <th style={{ ...thStyle, textAlign: 'right' }} title="The value model's price. For a KTC-listed player: what it says KTC should pay, fit without seeing his price">Model</th>
              {sortTh('career', 'Career', 'PPR points per game above replacement in this format: expected mean of his best two NFL seasons in his first four (overall career rank)')}
              {sortTh('cvv', '±', 'Rank by devy value minus rank by career score, in this format: positive = the projection likes him more than the market')}
              <th style={{ ...thStyle, textAlign: 'right' }} title="The raw projection: PPR points per game, not above replacement">PPG</th>
              {sortTh('dynasty', 'Dynasty', 'Priced as the rookie-draft slot his composite class rank implies (KTC future pick values)')}
              <th style={thStyle}>Pick equiv.</th>
              <th style={{ ...thStyle, textAlign: 'right' }} title="Estimated from the high-school class">Age*</th>
              <th style={{ ...thStyle, textAlign: 'right' }} title="Estimated age of his first season with a 20% dominator, 800 scrimmage or 2,000 passing yards">Breakout*</th>
              <th style={{ ...thStyle, textAlign: 'right' }} title="Best season share of team receiving yards + TDs">Dom</th>
              <th style={{ ...thStyle, textAlign: 'center' }}>Stars</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const cvv = p.careerVsValue?.[fmt];
              const mv = p.modelValue?.[fmt];
              const pr = p.profile;
              return (
                <tr key={`${p.name}|${p.pos}|${p.draftYear}`} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={num}>{p.compositeRank[fmt]}</td>
                  <td style={{ ...tdStyle, fontWeight: 600 }}>
                    {p.name}
                    {p.valueSource === 'model' && (
                      <span title={`Not on KTC's devy list: priced by the devy value model (P(KTC lists him) ${p.pListed != null ? Math.round(p.pListed * 100) + '%' : '—'})`}
                        style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-muted)', border: '1px solid var(--text-muted)', borderRadius: 4, padding: '0 4px' }}>
                        model
                      </span>
                    )}
                  </td>
                  <td style={tdStyle}>{p.pos}{p.compositePosRank[fmt]}</td>
                  <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{p.school}</td>
                  <td style={tdStyle}>{p.draftYear}</td>
                  <td style={{ ...num, fontWeight: 600 }} title={`Career projection weight ${Math.round(p.compositeWeight[fmt] * 100)}%`}>
                    {p.compositeValue[fmt].toLocaleString()}
                  </td>
                  <td style={{ ...num, color: 'var(--text-secondary)' }}>{p.rank[fmt]}</td>
                  <td style={num}>{p.devyValue[fmt].toLocaleString()}</td>
                  <td style={{ ...num, color: 'var(--text-secondary)' }}>{p.valueSource === 'ktc' && mv != null ? Math.round(mv).toLocaleString() : ''}</td>
                  <td style={num}>{p.careerScore[fmt] != null ? `${p.careerScore[fmt]!.toFixed(2)}${p.careerRank?.[fmt] ? ` (#${p.careerRank[fmt]})` : ''}` : '—'}</td>
                  <td style={{ ...num, color: cvv == null || cvv === 0 ? 'var(--text-muted)' : cvv > 0 ? '#22c55e' : '#ef4444' }}>
                    {cvv == null ? '' : cvv > 0 ? `+${cvv}` : cvv}
                  </td>
                  <td style={{ ...num, color: 'var(--text-secondary)' }}>{p.careerPPG != null ? p.careerPPG.toFixed(1) : ''}</td>
                  <td style={num} title={p.dynastyMarket ? `By market rank alone: ${p.dynastyMarket[fmt].value.toLocaleString()} (${p.dynastyMarket[fmt].pickEquiv})` : undefined}>
                    {p.dynasty[fmt].value.toLocaleString()}
                  </td>
                  <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{p.dynasty[fmt].pickEquiv}</td>
                  <td style={num}>{pr ? pr.est_age.toFixed(1) : ''}</td>
                  <td style={num}>{pr && pr.breakout_age < 25 ? pr.breakout_age.toFixed(1) : pr ? '—' : ''}</td>
                  <td style={num}>{pr ? `${Math.round(pr.best_dominator * 100)}%` : ''}</td>
                  <td style={{ ...tdStyle, textAlign: 'center' }}>{pr?.stars ? '★'.repeat(pr.stars) : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>Built {doc.generatedAt}.</div>
    </div>
  );
}
