import { useEffect, useMemo, useState } from 'react';

// Devy rankings (public/data/devy-rankings.json, scripts/build-devy-rankings.py):
// KTC's devy market blended with the college-profile model
// (scripts/train_devy_model.py), priced on the dynasty scale via KTC's future
// rookie-pick values.

type Fmt = 'sf' | 'oneQB';

interface DevyPlayer {
  name: string;
  pos: 'QB' | 'RB' | 'WR' | 'TE';
  school: string | null;
  draftYear: number;
  ktc: { sf: number | null; oneQB: number | null; sfRank: number | null; oneQBRank: number | null };
  model: { score: number | null; stars: number | null; recruitClass: number | null; careerPPG: number | null; projPick: number | null };
  value: Record<Fmt, number>;
  rank: Record<Fmt, number>;
  posRank: Record<Fmt, number>;
  dynasty: Record<Fmt, { value: number; classRank: number; pickEquiv: string }>;
  modelVsMarket?: number;
  source: 'ktc+model' | 'ktc' | 'model';
}

interface DevyDoc {
  generatedAt: string;
  modelAsOfSeason: number;
  classes: number[];
  players: DevyPlayer[];
}

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'] as const;
type SortKey = 'rank' | 'dynasty' | 'model' | 'mvm';

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
  const [sort, setSort] = useState<SortKey>('rank');

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
      rank: (p) => p.rank[fmt],
      dynasty: (p) => -p.dynasty[fmt].value,
      model: (p) => -(p.model.score ?? -1e9),
      mvm: (p) => -(p.modelVsMarket ?? -1e9),
    };
    return doc.players
      .filter((p) => (pos === 'ALL' || p.pos === pos) && (cls === 'ALL' || p.draftYear === cls))
      .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.school ?? '').toLowerCase().includes(q))
      .sort((a, b) => key[sort](a) - key[sort](b));
  }, [doc, fmt, pos, cls, search, sort]);

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
        <div style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 900 }}>
          College players for dynasty leagues: KTC's devy market blended with the StatHead college-profile model,
          which nudges the order within each position (weight 0.25, QB 0.15). Dynasty value prices each player as
          the rookie-draft slot his class rank implies, from KTC's future pick values, so it reads directly against
          NFL players and picks. Model features run through the {doc.modelAsOfSeason} college season.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="text" placeholder="Search name / school" value={search} onChange={(e) => setSearch(e.target.value)}
          style={{ padding: '6px 10px', background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            color: 'var(--text-primary)', borderRadius: 4, fontSize: 13, minWidth: 200 }} />
        <div style={{ display: 'flex', gap: 4 }}>
          <button style={btn(fmt === 'sf')} onClick={() => setFmt('sf')}>Superflex</button>
          <button style={btn(fmt === 'oneQB')} onClick={() => setFmt('oneQB')}>1QB</button>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {POSITIONS.map((p) => <button key={p} style={btn(pos === p)} onClick={() => setPos(p)}>{p}</button>)}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button style={btn(cls === 'ALL')} onClick={() => setCls('ALL')}>All classes</button>
          {doc.classes.map((c) => <button key={c} style={btn(cls === c)} onClick={() => setCls(c)}>{c}</button>)}
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>{rows.length} players</div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {sortTh('rank', '#')}
              <th style={thStyle}>Player</th>
              <th style={thStyle}>Pos</th>
              <th style={thStyle}>School</th>
              <th style={thStyle}>Class</th>
              <th style={{ ...thStyle, textAlign: 'right' }} title="Devy-scale value (KTC 0-9999) in the blended order">Value</th>
              {sortTh('dynasty', 'Dynasty', 'Priced as the rookie-draft slot his class rank implies (KTC future pick values)')}
              <th style={thStyle}>Pick equiv.</th>
              <th style={{ ...thStyle, textAlign: 'right' }} title="KTC devy value and overall rank">KTC</th>
              {sortTh('model', 'Model', 'Expected mean of his best two NFL PPR PPG seasons in his first four')}
              {sortTh('mvm', '±', 'Market position rank minus model position rank: positive = the model likes him more')}
              <th style={{ ...thStyle, textAlign: 'center' }}>Stars</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const ktcV = p.ktc[fmt];
              const ktcR = fmt === 'sf' ? p.ktc.sfRank : p.ktc.oneQBRank;
              const mvm = p.modelVsMarket;
              return (
                <tr key={`${p.name}|${p.pos}|${p.draftYear}`} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={num}>{p.rank[fmt]}</td>
                  <td style={{ ...tdStyle, fontWeight: 600 }}>
                    {p.name}
                    {p.source === 'model' && (
                      <span title="Not on KTC's devy list: placed by the model, entering at the class's market floor"
                        style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-muted)', border: '1px solid var(--text-muted)', borderRadius: 4, padding: '0 4px' }}>
                        model
                      </span>
                    )}
                  </td>
                  <td style={tdStyle}>{p.pos}{p.posRank[fmt]}</td>
                  <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{p.school}</td>
                  <td style={tdStyle}>{p.draftYear}</td>
                  <td style={num}>{p.value[fmt].toLocaleString()}</td>
                  <td style={{ ...num, fontWeight: 600 }}>{p.dynasty[fmt].value.toLocaleString()}</td>
                  <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{p.dynasty[fmt].pickEquiv}</td>
                  <td style={num}>{ktcV ? `${ktcV.toLocaleString()} (#${ktcR})` : '—'}</td>
                  <td style={num}>{p.model.score != null ? p.model.score.toFixed(1) : '—'}</td>
                  <td style={{ ...num, color: mvm == null || mvm === 0 ? 'var(--text-muted)' : mvm > 0 ? '#22c55e' : '#ef4444' }}>
                    {mvm == null ? '' : mvm > 0 ? `+${mvm}` : mvm}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'center' }}>{p.model.stars ? '★'.repeat(p.model.stars) : ''}</td>
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
