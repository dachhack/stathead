import { useEffect, useState } from 'react';
import type { DevyPlayer, Fmt } from './DevyView';
import { hitText } from '../lib/devyFormat';

// A devy player's card: his StatHead numbers from the board, his college
// season lines and the current season's game log
// (public/data/devy-cards/<shard>.json, scripts/build_devy_cards.py).

/** Must match SHARDS in scripts/build_devy_cards.py. */
const CARD_SHARDS = 64;

type Line = Partial<Record<StatKey, number>>;
interface SeasonLine extends Line { season: number; team: string | null; conf: string | null; throughWeek?: number; games?: number }
interface GameLine extends Line { week: number; date: string | null; team: string; opp: string | null; site: 'home' | 'away' | 'neutral'; result: string | null }
interface CardDoc { season: number; throughWeek: number | null; gameLogs: boolean; players: Record<string, { seasons: SeasonLine[]; games: GameLine[] }> }

type StatKey = 'pass_cmp' | 'pass_att' | 'pass_yds' | 'pass_td' | 'pass_int' | 'rush_car' | 'rush_yds' | 'rush_td'
  | 'rush_long' | 'rec' | 'rec_yds' | 'rec_td' | 'rec_long' | 'fum_lost';

// Columns by position, in reading order. Cmp/Att is drawn from two keys.
const PASS: [string, StatKey | 'cmpatt'][] = [['Cmp/Att', 'cmpatt'], ['Pass yds', 'pass_yds'], ['Pass TD', 'pass_td'], ['INT', 'pass_int']];
const RUSH: [string, StatKey][] = [['Car', 'rush_car'], ['Rush yds', 'rush_yds'], ['Rush TD', 'rush_td']];
const RECV: [string, StatKey][] = [['Rec', 'rec'], ['Rec yds', 'rec_yds'], ['Rec TD', 'rec_td']];
const COLS: Record<string, [string, StatKey | 'cmpatt'][]> = {
  QB: [...PASS, ...RUSH],
  RB: [...RUSH, ...RECV, ['Long', 'rush_long']],
  WR: [...RECV, ['Long', 'rec_long'], ...RUSH],
  TE: [...RECV, ['Long', 'rec_long']],
};

const th: React.CSSProperties = {
  padding: '6px', fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase',
  letterSpacing: '0.04em', whiteSpace: 'nowrap', textAlign: 'right', borderBottom: '1px solid var(--border)',
};
const td: React.CSSProperties = { padding: '5px 6px', whiteSpace: 'nowrap', textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const left: React.CSSProperties = { textAlign: 'left' };

function cell(l: Line, k: StatKey | 'cmpatt'): string {
  if (k === 'cmpatt') return l.pass_att ? `${l.pass_cmp ?? 0}/${l.pass_att}` : '';
  const v = l[k];
  return v == null ? '' : v.toLocaleString();
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 600, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

export function DevyPlayerCard({ player: p, fmt, onClose }: { player: DevyPlayer; fmt: Fmt; onClose: () => void }) {
  const [doc, setDoc] = useState<CardDoc | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    setDoc(null);
    setError(null);
    if (!p.cfbdId) return;
    const n = Number(p.cfbdId);
    const shard = Number.isFinite(n) ? n % CARD_SHARDS : [...p.cfbdId].reduce((s, c) => s + c.charCodeAt(0), 0) % CARD_SHARDS;
    let live = true;
    fetch(`${import.meta.env.BASE_URL}data/devy-cards/${shard}.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: CardDoc) => { if (live) setDoc(d); })
      .catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [p.cfbdId]);

  const card = p.cfbdId ? doc?.players[p.cfbdId] : undefined;
  const cols = COLS[p.pos] ?? COLS.WR;
  const pr = p.profile;
  const fmtName = fmt === 'sf' ? 'superflex' : '1QB';

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
      <div role="dialog" aria-label={`${p.name} card`} onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 8, maxWidth: 820,
          width: '100%', maxHeight: '90vh', overflowY: 'auto', padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 22 }}>{p.name}</h2>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
              {p.pos} · {p.school ?? '—'} · {p.draftYear} class
              {pr?.n_seasons != null && ` · ${pr.n_seasons === 0 ? 'recruit, no college stats yet' : `${pr.n_seasons} college season${pr.n_seasons === 1 ? '' : 's'}`}`}
              {pr?.stars ? ` · ${'★'.repeat(pr.stars)}` : ''}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: '1px solid var(--border)',
            color: 'var(--text-secondary)', borderRadius: 4, padding: '4px 10px', cursor: 'pointer' }}>close</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, marginBottom: 6 }}>
          <Metric label="Composite" value={p.compositeValue[fmt].toLocaleString()}
            sub={`#${p.compositeRank[fmt]} · ${p.pos}${p.compositePosRank[fmt]}`} />
          <Metric label="Market model" value={p.marketValue[fmt].toLocaleString()} sub={`#${p.marketRank[fmt]}`} />
          <Metric label="Hit %" value={hitText(p.hitProb?.[fmt])}
            sub={p.careerRank?.[fmt] ? `#${p.careerRank[fmt]} on the board` : undefined} />
          <Metric label="Draft" value={p.draftOutlook ? `R1 ${Math.round(p.draftOutlook.day1)}%` : '—'} sub={p.draftOutlook
            ? `R2-3 ${Math.round(p.draftOutlook.day2)}% · R4-7 ${Math.round(p.draftOutlook.day3)}% · UDFA ${Math.round(p.draftOutlook.undrafted)}%${p.draftOutlook.source === 'board' ? ' · from big board' : p.draftOutlook.source === 'model+mock' ? ' · with early mock' : p.draftOutlook.source === 'model+market' ? ' · with market' : ''}`
            : undefined} />
          <Metric label="Dynasty" value={p.dynasty[fmt].value.toLocaleString()} sub={p.dynasty[fmt].pickEquiv} />
          <Metric label="Age*" value={pr ? pr.est_age.toFixed(1) : '—'}
            sub={pr && pr.breakout_age < 25 ? `breakout ${pr.breakout_age.toFixed(1)}` : 'no breakout yet'} />
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 16 }}>
          StatHead values, {fmtName}. Hit % = chance of at least one fantasy-starter season in his first four NFL seasons.
          Draft = chance by round (from the big board where it ranks him; else the college model blended with an early mock draft or the pick his market price implies). *Age estimated.
        </div>

        <h3 style={{ fontSize: 14, margin: '0 0 6px 0' }}>College seasons</h3>
        {error && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Could not load stats: {error}</div>}
        {!error && !doc && p.cfbdId && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading…</div>}
        {doc && !card?.seasons.length && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No college stats on record.</div>}
        {card && card.seasons.length > 0 && (
          <div style={{ overflowX: 'auto', marginBottom: 18 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead><tr>
                <th style={{ ...th, ...left }}>Season</th><th style={{ ...th, ...left }}>Team</th>
                {cols.map(([h]) => <th key={h} style={th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {card.seasons.map((s) => (
                  <tr key={`${s.season}|${s.team}`} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ ...td, ...left, fontWeight: 600 }}>
                      {s.season}
                      {s.throughWeek != null && <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> (thru wk {s.throughWeek}{s.games ? `, ${s.games} g` : ''})</span>}
                    </td>
                    <td style={{ ...td, ...left, color: 'var(--text-secondary)' }}>{s.team}</td>
                    {cols.map(([h, k]) => <td key={h} style={td}>{cell(s, k)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {doc && (
          <>
            <h3 style={{ fontSize: 14, margin: '0 0 6px 0' }}>{doc.season} game log</h3>
            {!doc.gameLogs && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Game logs arrive with the next weekly update.</div>}
            {doc.gameLogs && !card?.games.length && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No games with stats this season.</div>}
            {card && card.games.length > 0 && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead><tr>
                    <th style={{ ...th, ...left }}>Wk</th><th style={{ ...th, ...left }}>Date</th>
                    <th style={{ ...th, ...left }}>Opponent</th><th style={{ ...th, ...left }}>Result</th>
                    {cols.map(([h]) => <th key={h} style={th}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {card.games.map((g) => (
                      <tr key={g.week} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ ...td, ...left }}>{g.week}</td>
                        <td style={{ ...td, ...left, color: 'var(--text-secondary)' }}>{g.date?.slice(5) ?? ''}</td>
                        <td style={{ ...td, ...left }}>{g.site === 'away' ? '@ ' : g.site === 'neutral' ? 'vs ' : ''}{g.opp ?? '—'}</td>
                        <td style={{ ...td, ...left, color: g.result?.startsWith('W') ? '#22c55e' : g.result?.startsWith('L') ? '#ef4444' : undefined }}>
                          {g.result ?? ''}
                        </td>
                        {cols.map(([h, k]) => <td key={h} style={td}>{cell(g, k)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12 }}>
          College stats: CollegeFootballData.com{doc?.throughWeek ? `, ${doc.season} through week ${doc.throughWeek}` : ''}.
        </div>
      </div>
    </div>
  );
}
