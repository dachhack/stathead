import { useEffect, useMemo, useState } from 'react';
import { DevyPlayerCard } from './DevyPlayerCard';
import { type DraftOutlook, draftLine, draftTitle, hitText } from '../lib/devyFormat';

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
  /** Career model, per format: chance (percent) of at least one fantasy-starter season in his first four NFL seasons. */
  hitProb: Record<Fmt, number | null>;
  /** Chance (percent) he is drafted on Day 1 (R1), Day 2 (R2-3), Day 3 (R4-7) or not at all. */
  draftOutlook: DraftOutlook | null;
  /** Rank / percentile of hitProb over the whole board. */
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
  inSeason?: {
    season: number; throughWeek: number; careerInSeason: Record<string, number[]>;
    /** Share of the career projection from the season-to-date profile, by position and class. */
    careerInSeasonWeight?: Record<string, Record<string, number>>;
  } | null;
  classes: number[];
  valueModel?: { spearmanIfListed: Record<Fmt, number | null>; aucListed: number | null };
  replacementPPG?: Record<Fmt, Record<'QB' | 'RB' | 'WR' | 'TE', number>>;
  /** What a hit looks like: best-two-season PPR PPG of past hits, by format and position. */
  hitPPG?: Record<Fmt, Record<string, { p25: number; median: number; p75: number }>>;
  hitRate?: Record<Fmt, Record<string, number>>;
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

function DevyInfoChip({ doc, fmt }: { doc: DevyDoc; fmt: Fmt }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  const repl = doc.replacementPPG?.[fmt];
  const hr = doc.hitRate?.[fmt];
  const hitRates = hr ? (['QB', 'RB', 'WR', 'TE'] as const).filter((p) => hr[p] != null)
    .map((p) => `${p} ${(hr[p] * 100).toFixed(1)}%`).join(', ') : '';
  const hp = doc.hitPPG?.[fmt];
  const hitRange = hp ? (['QB', 'RB', 'WR', 'TE'] as const).filter((p) => hp[p])
    .map((p) => `${p} ${hp[p].p25}–${hp[p].p75}`).join(', ') : '';
  const careerIn = doc.inSeason?.careerInSeasonWeight
    ? Object.entries(doc.inSeason.careerInSeasonWeight)
      .map(([p, byCls]) => `${p} ${Object.entries(byCls).map(([c, w]) => `${c} ${Math.round(w * 100)}%`).join(', ')}`).join('; ')
    : doc.inSeason
      ? Object.entries(doc.inSeason.careerInSeason).filter(([, c]) => c.length).map(([p, c]) => `${p} ${c.join('/')}`).join(', ')
      : '';
  const item = (label: string, body: React.ReactNode) => (
    <div style={{ marginBottom: 8 }}>
      <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{label}</span>{' '}{body}
    </div>
  );
  return (
    <span>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px', fontSize: 12,
          background: open ? 'var(--bg-tertiary)' : 'var(--bg-secondary)', color: 'var(--text-secondary)',
          border: '1px solid var(--border)', borderRadius: 999, cursor: 'pointer' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 14, height: 14,
          borderRadius: '50%', border: '1px solid currentColor', fontSize: 9, fontWeight: 700 }}>i</span>
        How it works
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 999 }} />
          <div role="dialog" aria-label="How devy rankings work"
            style={{ position: 'fixed', top: 'min(160px, 20vh)', left: '50%', transform: 'translateX(-50%)', zIndex: 1000,
              width: 'min(560px, calc(100vw - 32px))', maxHeight: '70vh', overflowY: 'auto',
              background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 8, padding: 14,
              boxShadow: '0 6px 24px rgba(0,0,0,0.45)', fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
            {item('Composite (the rank).', <>Our devy market model and our NFL career projection, blended by rank and priced on
              a smooth 0–9,999 scale. The career share is the career model's held-out accuracy at the player's position and
              distance from the draft (about 11–17% QB, 17–25% TE, 26–35% RB/WR; 50% for RB/WR three seasons out). The market
              always leads.</>)}
            {item('Market.', <>Our value model's price for his profile: odds he's on the market's list × what the market pays a
              listed player like him (age, breakout, share of offense, production, program, competition). Held-out rank
              correlation with the market {doc.valueModel?.spearmanIfListed?.[fmt] ?? '—'}.</>)}
            {item('Hit %.', <>Our career model: his chance of at least one fantasy-starter season in his first four NFL
              seasons (6+ games above replacement in a 12-team {fmt === 'sf' ? 'superflex / 2QB' : 'single-QB'} league
              {repl ? `: QB ${repl.QB}, RB ${repl.RB}, WR ${repl.WR}, TE ${repl.TE} PPG` : ''}). Historically about
              {' '}{hitRates || '3–5%'} of college players at this level hit.
              {hitRange ? <> A hit typically averages {hitRange} PPR PPG over his best two seasons.</> : null}</>)}
            {item('Draft.', <>His chance of going in round 1 and in rounds 1–3. For the nearest class, a player our big board
              ranks gets the board's chances (tested on the 2026 draft, the board beat any blend with college stats). Otherwise
              it's his college profile, blended with an early mock draft where one projects him, or else with the pick his devy
              market price implies (a looser signal, weighted down). QBs with no pick source show none. Hover for
              rounds 4–7 and undrafted.</>)}
            {item('±', <>Market rank minus hit-chance rank. Green: the career model likes him more.</>)}
            {item('Dynasty.', <>His composite class rank priced as a rookie-draft pick, on a smooth curve fitted to future-pick
              values.</>)}
            {item('Depth.', <>Every current college QB, RB, WR and TE our models score. Deep down, values are small and flat and
              the rank carries the information; Yrs = college seasons with stats (recruit = none yet).</>)}
            {item('Freshness.', doc.inSeason
              ? <>Profiles run through {doc.inSeason.season} week {doc.inSeason.throughWeek}, as a full-season estimate calibrated
                on past seasons; rescored every Sunday in season. The career projection blends this season's profile with
                last season's, with the share for each position and class chosen by replaying past seasons at the same week
                ({careerIn || 'no class yet'}).</>
              : <>Profiles run through the {doc.modelAsOfSeason} season.</>)}
            <div style={{ fontSize: 11, color: 'var(--text-muted)', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
              Every value and rank switches with the format. Ages are estimated from the high-school class. Third-party values
              and ranks are inputs only, never shown. Click a player's name for his card.
            </div>
          </div>
        </>
      )}
    </span>
  );
}

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
      career: (p) => -(p.hitProb?.[fmt] ?? -1e9),
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Devy Rankings</h2>
        <DevyInfoChip doc={doc} fmt={fmt} />
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {fmt === 'sf' ? 'Superflex / 2QB' : '1QB'} · profiles through {doc.profilesThrough ?? `the ${doc.modelAsOfSeason} season`}
        </span>
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
              {sortTh('career', 'Hit %', 'Chance of at least one fantasy-starter season in his first four NFL seasons, in this format (overall rank)')}
              {sortTh('cvv', '±', 'Rank by devy value minus rank by hit chance, in this format: positive = the career model likes him more than the market')}
              <th style={thStyle} title="Chance he's drafted in round 1, and in rounds 1-3 (hover a row for all four)">Draft</th>
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
                  <td style={num} title={p.careerRank?.[fmt] ? `Rank #${p.careerRank[fmt]} on the board by hit chance` : undefined}>{hitText(p.hitProb?.[fmt])}</td>
                  <td style={{ ...num, color: cvv == null || cvv === 0 ? 'var(--text-muted)' : cvv > 0 ? '#22c55e' : '#ef4444' }}>
                    {cvv == null ? '' : cvv > 0 ? `+${cvv}` : cvv}
                  </td>
                  <td style={{ ...tdStyle, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }} title={draftTitle(p.draftOutlook)}>{draftLine(p.draftOutlook)}</td>
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
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>Built {doc.generatedAt}.</div>
      {card && <DevyPlayerCard player={card} fmt={fmt} onClose={() => setCard(null)} />}
    </div>
  );
}
