import { useEffect, useMemo, useState } from 'react';
import { DevyPlayerCard } from './DevyPlayerCard';

// Devy rankings (public/data/devy-rankings.json, scripts/build-devy-rankings.py):
// StatHead's composite of the devy market and our NFL career projection
// (scripts/train_devy_model.py), on the dynasty scale. Third-party values and
// ranks are inputs only; nothing shown here is a third-party number or rank.

export type Fmt = 'sf' | 'oneQB';

export interface DevyPlayer {
  name: string;
  pos: 'QB' | 'RB' | 'WR' | 'TE';
  school: string | null;
  draftYear: number;
  /** CFBD player id: unique where names repeat (thousands of players deep). */
  cfbdId: string | null;
  /** The devy value model's price for his profile (ours, for every player). */
  marketValue: Record<Fmt, number>;
  marketRank: Record<Fmt, number>;
  marketPosRank: Record<Fmt, number>;
  /** On the market's devy list. */
  marketListed: boolean;
  pListed: number | null;
  /** NFL projection per format: expected mean of his best two NFL seasons in his first four, PPR points per game above replacement. */
  careerScore: Record<Fmt, number | null>;
  /** The raw projection (PPR PPG, not above replacement). */
  careerPPG: number | null;
  careerRank?: Record<Fmt, number>;
  careerPct?: Record<Fmt, number>;
  careerVsMarket?: Record<Fmt, number>;
  /** Market and career blended in rank space, on a smooth 0-9999 curve. */
  compositeValue: Record<Fmt, number>;
  compositeRank: Record<Fmt, number>;
  compositePosRank: Record<Fmt, number>;
  /** The career projection's share of the composite. */
  compositeWeight: Record<Fmt, number>;
  /** Priced by composite class rank. */
  dynasty: Record<Fmt, { value: number; classRank: number; pickEquiv: string }>;
  profile: {
    est_age: number; est_draft_age: number; breakout_age: number; best_dominator: number;
    last_usage: number; stars: number; sp_last: number;
    /** College seasons with stats, this one included (0 = recruit only). */
    n_seasons?: number;
  } | null;
}

interface DevyDoc {
  generatedAt: string;
  modelAsOfSeason: number;
  profilesThrough?: string;
  inSeason?: { season: number; throughWeek: number; careerInSeason: Record<string, number[]> } | null;
  classes: number[];
  valueModel?: { spearmanIfListed: Record<Fmt, number | null>; aucListed: number | null };
  replacementPPG?: Record<Fmt, Record<'QB' | 'RB' | 'WR' | 'TE', number>>;
  composite?: { careerWeights: Record<string, Record<string, number>>; rule: string };
  players: DevyPlayer[];
}

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'] as const;
// The board runs to every scored college player (thousands): render a page at a time.
const PAGE = 250;
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
  const [src, setSrc] = useState<'all' | 'listed' | 'beyond'>('all');
  const [sort, setSort] = useState<SortKey>('comp');
  const [shown, setShown] = useState(PAGE);
  const [card, setCard] = useState<DevyPlayer | null>(null);

  useEffect(() => setShown(PAGE), [fmt, pos, cls, search, src, sort]);

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
      rank: (p) => p.marketRank[fmt],
      dynasty: (p) => -p.dynasty[fmt].value,
      career: (p) => -(p.careerScore[fmt] ?? -1e9),
      cvv: (p) => -(p.careerVsMarket?.[fmt] ?? -1e9),
    };
    return doc.players
      .filter((p) => (pos === 'ALL' || p.pos === pos) && (cls === 'ALL' || p.draftYear === cls))
      .filter((p) => src === 'all' || (src === 'listed') === p.marketListed)
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
          Ranked by StatHead's <b>composite</b>: the devy market and our NFL career projection blended by rank, on a smooth
          0–9999 value scale. The career model's share is its own held-out accuracy at the player's position and distance from
          the draft (about 11–17% for QBs, 17–25% for TEs, 26–35% for RBs and WRs), raised to 50% for RBs and WRs three seasons
          out where a backtest on past classes found that validates better; the market always leads. <b>Market</b> is our devy
          value model's price for his profile (the chance he's on the market's list × what the market pays a listed player like
          him — age, breakout age, share of the offense, production, program, competition; held-out rank correlation with the
          market {doc.valueModel?.spearmanIfListed?.[fmt] ?? '—'}). Third-party values and ranks are inputs, never shown.
          <b> Career</b> is our NFL projection: expected mean of his best two NFL seasons in his first four, in PPR points per
          game above replacement for a 12-team {fmt === 'sf' ? 'superflex / 2QB' : 'single-QB'} league
          {doc.replacementPPG?.[fmt] ? ` (replacement: QB ${doc.replacementPPG[fmt].QB}, RB ${doc.replacementPPG[fmt].RB}, WR ${doc.replacementPPG[fmt].WR}, TE ${doc.replacementPPG[fmt].TE} PPG)` : ''},
          so it compares across positions and a QB is worth more in superflex. The board runs as deep as the data: every
          current college QB, RB, WR and TE our models score. Deep down, values are small and flat and the rank carries the
          information; Yrs is how many college seasons with stats a ranking rests on (recruit = none yet). Every value and rank switches with the format.
          ± sets the market and career ranks against each other (green: the projection likes him more). Dynasty prices his
          composite class rank as a rookie pick on a smooth curve fitted to future-pick values. Ages are estimated from the high-school
          class; profiles run through {doc.inSeason
            ? <>{doc.inSeason.season} week {doc.inSeason.throughWeek} (season to date, as a full-season estimate calibrated on
              past seasons at the same week; the career model uses it where replaying past seasons at that week beat the
              end-of-last-season profile: {Object.entries(doc.inSeason.careerInSeason).filter(([, c]) => c.length)
                .map(([p, c]) => `${p} ${c.join('/')}`).join(', ') || 'no class yet'})</>
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
          <button style={btn(src === 'listed')} onClick={() => setSrc('listed')}>Market-listed</button>
          <button style={btn(src === 'beyond')} onClick={() => setSrc('beyond')}>Beyond the list</button>
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>{rows.length.toLocaleString()} players</div>
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
              <th style={{ ...thStyle, textAlign: 'right' }} title="College seasons with stats, this one included: how much evidence the ranking rests on">Yrs</th>
              {sortTh('comp', 'Composite', 'Market price and career projection blended by rank, priced on the market value scale (career weight in the tooltip)')}
              <th style={{ ...thStyle, textAlign: 'right' }} title="Our devy value model's price for his profile">Market</th>
              {sortTh('rank', 'Mkt #', 'Rank by our devy value model\'s price')}
              {sortTh('career', 'Career', 'PPR points per game above replacement in this format: expected mean of his best two NFL seasons in his first four (overall career rank)')}
              {sortTh('cvv', '±', 'Rank by devy value minus rank by career score, in this format: positive = the projection likes him more than the market')}
              <th style={{ ...thStyle, textAlign: 'right' }} title="The raw projection: PPR points per game, not above replacement">PPG</th>
              {sortTh('dynasty', 'Dynasty', 'Priced as the rookie-draft slot his composite class rank implies (smooth curve fitted to future-pick values)')}
              <th style={thStyle}>Pick equiv.</th>
              <th style={{ ...thStyle, textAlign: 'right' }} title="Estimated from the high-school class">Age*</th>
              <th style={{ ...thStyle, textAlign: 'right' }} title="Estimated age of his first season with a 20% dominator, 800 scrimmage or 2,000 passing yards">Breakout*</th>
              <th style={{ ...thStyle, textAlign: 'right' }} title="Best season share of team receiving yards + TDs">Dom</th>
              <th style={{ ...thStyle, textAlign: 'center' }}>Stars</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((p) => {
              const cvv = p.careerVsMarket?.[fmt];
              const pr = p.profile;
              return (
                <tr key={p.cfbdId ?? `${p.name}|${p.pos}|${p.draftYear}|${p.school}`} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={num}>{p.compositeRank[fmt]}</td>
                  <td style={{ ...tdStyle, fontWeight: 600 }}>
                    <button onClick={() => setCard(p)} title="Open card: season stats and game log"
                      style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', fontWeight: 600,
                        color: 'var(--text-primary)', cursor: 'pointer', textDecoration: 'underline dotted',
                        textUnderlineOffset: 3 }}>
                      {p.name}
                    </button>
                    {!p.marketListed && (
                      <span title={`Beyond the market's devy list (our model gives ${p.pListed != null ? Math.round(p.pListed * 100) + '%' : '—'} odds he'd be on it)`}
                        style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-muted)', border: '1px solid var(--text-muted)', borderRadius: 4, padding: '0 4px' }}>
                        model
                      </span>
                    )}
                  </td>
                  <td style={tdStyle}>{p.pos}{p.compositePosRank[fmt]}</td>
                  <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{p.school}</td>
                  <td style={tdStyle}>{p.draftYear}</td>
                  <td style={{ ...num, color: 'var(--text-secondary)' }}>
                    {pr?.n_seasons == null ? '' : pr.n_seasons === 0 ? 'recruit' : pr.n_seasons}
                  </td>
                  <td style={{ ...num, fontWeight: 600 }} title={`Career projection weight ${Math.round(p.compositeWeight[fmt] * 100)}%`}>
                    {p.compositeValue[fmt].toLocaleString()}
                  </td>
                  <td style={num}>{p.marketValue[fmt].toLocaleString()}</td>
                  <td style={{ ...num, color: 'var(--text-secondary)' }}>{p.marketRank[fmt]}</td>
                  <td style={num}>{p.careerScore[fmt] != null ? `${p.careerScore[fmt]!.toFixed(2)}${p.careerRank?.[fmt] ? ` (#${p.careerRank[fmt]})` : ''}` : '—'}</td>
                  <td style={{ ...num, color: cvv == null || cvv === 0 ? 'var(--text-muted)' : cvv > 0 ? '#22c55e' : '#ef4444' }}>
                    {cvv == null ? '' : cvv > 0 ? `+${cvv}` : cvv}
                  </td>
                  <td style={{ ...num, color: 'var(--text-secondary)' }}>{p.careerPPG != null ? p.careerPPG.toFixed(1) : ''}</td>
                  <td style={num}>{p.dynasty[fmt].value.toLocaleString()}</td>
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
      {rows.length > shown && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Showing {shown.toLocaleString()} of {rows.length.toLocaleString()}
          </span>
          <button style={btn(false)} onClick={() => setShown((n) => n + PAGE * 4)}>Show {Math.min(PAGE * 4, rows.length - shown).toLocaleString()} more</button>
          <button style={btn(false)} onClick={() => setShown(rows.length)}>Show all</button>
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>Built {doc.generatedAt}. Click a name for his card.</div>
      {card && <DevyPlayerCard player={card} fmt={fmt} onClose={() => setCard(null)} />}
    </div>
  );
}
