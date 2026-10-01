import { useEffect, useMemo, useState } from 'react';
import type { Fmt } from './DevyView';

// High-school devy board (public/data/devy-hs-rankings.json,
// scripts/train_devy_hs_model.py): recruits not yet in college, ranked across
// positions by StatHead's projected NFL value. The model's input is the
// recruiting composite, which is never shown; within a position the order is
// the composite's, so there is deliberately no position rank or position filter
// (docs/third-party-data-policy.md).

interface HSPlayer {
  id: string;
  name: string;
  pos: 'QB' | 'RB' | 'WR' | 'TE' | 'ATH';
  hsSchool: string | null;
  city: string | null;
  state: string | null;
  committed: string | null;
  class: number;
  earliestDraft: number;
  height: number | null;
  weight: number | null;
  pDrafted: number;
  careerPPG: number;
  careerScore: Record<Fmt, number>;
  rank: Record<Fmt, number>;
  classRank: Record<Fmt, number>;
}

interface BoardMetric { spearman: number; top24Hits: number }
interface HSDoc {
  generatedAt: string;
  classes: number[];
  trainClasses: [number, number];
  replacementPPG: Record<Fmt, Record<string, number>>;
  metrics: { board: Record<Fmt, { model: BoardMetric; rating: BoardMetric }> };
  players: HSPlayer[];
}

const PAGE = 250;

const btn = (on: boolean): React.CSSProperties => ({
  padding: '6px 12px', background: on ? 'var(--bg-tertiary)' : 'transparent',
  color: on ? 'var(--text-primary)' : 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: 4,
  cursor: 'pointer', fontSize: 13, fontWeight: on ? 600 : 400,
});
const th: React.CSSProperties = {
  padding: '8px 6px', fontWeight: 600, fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase',
  letterSpacing: '0.05em', whiteSpace: 'nowrap', textAlign: 'left',
};
const td: React.CSSProperties = { padding: '6px', whiteSpace: 'nowrap' };
const num: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

const ht = (inches: number | null) => {
  if (!inches) return '';
  const t = Math.round(inches);
  return `${Math.floor(t / 12)}'${t % 12}"`;
};

function InfoChip({ doc, fmt }: { doc: HSDoc; fmt: Fmt }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  const m = doc.metrics?.board?.[fmt];
  const repl = doc.replacementPPG?.[fmt];
  const item = (label: string, body: React.ReactNode) => (
    <div style={{ marginBottom: 8 }}><span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{label}</span>{' '}{body}</div>
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
          <div role="dialog" aria-label="How the high-school board works"
            style={{ position: 'fixed', top: 'min(160px, 20vh)', left: '50%', transform: 'translateX(-50%)', zIndex: 1000,
              width: 'min(560px, calc(100vw - 32px))', maxHeight: '70vh', overflowY: 'auto', background: 'var(--bg-primary)',
              border: '1px solid var(--border)', borderRadius: 8, padding: 14, boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
              fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
            {item('Value.', <>Projected mean of his best two NFL seasons in his first four, in PPR points per game above
              replacement for a 12-team {fmt === 'sf' ? 'superflex / 2QB' : 'single-QB'} league
              {repl ? ` (QB ${repl.QB}, RB ${repl.RB}, WR ${repl.WR}, TE ${repl.TE} PPG)` : ''}, busts included, so the
              numbers are small. PPG is the same without replacement; Drafted is the chance he's drafted as a QB, RB, WR or TE.</>)}
            {item('How it\'s built.', <>Calibrated on every high-school QB, RB, WR, TE and athlete recruit in the
              {` ${doc.trainClasses[0]}–${doc.trainClasses[1]}`} classes against what they did in the NFL. The input is the
              recruiting composite rating; held out one class at a time, nothing we tried beat it (size, sub-position, the
              committed program), so the value is the rating translated, position by position, into expected fantasy value.</>)}
            {item('How good it is.', <>Across a whole class it orders NFL outcomes as well as the raw rating does, not better
              {m ? ` (rank correlation ${m.model.spearman} vs ${m.rating.spearman})` : ''}. What it adds is the cross-position
              scale: in superflex, QBs rise.</>)}
            {item('No position ranks.', <>Within a position the order is the recruiting services', so the board is ranked
              across positions only. Recruiting grades are inputs, never shown.</>)}
            <div style={{ fontSize: 11, color: 'var(--text-muted)', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
              Classes not yet in college: {doc.classes.join(', ')}. Earliest draft = class + 3.
            </div>
          </div>
        </>
      )}
    </span>
  );
}

export function HSProspectsView() {
  const [doc, setDoc] = useState<HSDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fmt, setFmt] = useState<Fmt>('sf');
  const [cls, setCls] = useState<number | 'ALL'>('ALL');
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/devy-hs-rankings.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setDoc)
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(() => setShown(PAGE), [fmt, cls, search]);

  const rows = useMemo(() => {
    if (!doc) return [];
    const q = search.trim().toLowerCase();
    return doc.players
      .filter((p) => cls === 'ALL' || p.class === cls)
      .filter((p) => !q || [p.name, p.hsSchool, p.committed, p.city, p.state].some((s) => (s ?? '').toLowerCase().includes(q)))
      .sort((a, b) => a.rank[fmt] - b.rank[fmt]);
  }, [doc, fmt, cls, search]);

  if (error) return <div style={{ padding: 16 }}>Could not load the high-school board: {error}</div>;
  if (!doc) return <div style={{ padding: 16 }}>Loading high-school board…</div>;

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>High School Prospects</h2>
        <InfoChip doc={doc} fmt={fmt} />
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {fmt === 'sf' ? 'Superflex / 2QB' : '1QB'} · classes {doc.classes.join(', ') || 'none yet'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="text" placeholder="Search name / school / commit / state" value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ padding: '6px 10px', background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            color: 'var(--text-primary)', borderRadius: 4, fontSize: 13, minWidth: 240 }} />
        <div style={{ display: 'flex', gap: 4 }}>
          <button style={btn(fmt === 'sf')} onClick={() => setFmt('sf')}>Superflex / 2QB</button>
          <button style={btn(fmt === 'oneQB')} onClick={() => setFmt('oneQB')}>1QB</button>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button style={btn(cls === 'ALL')} onClick={() => setCls('ALL')}>All classes</button>
          {doc.classes.map((c) => <button key={c} style={btn(cls === c)} onClick={() => setCls(c)}>{c}</button>)}
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>{rows.length.toLocaleString()} players</div>
      </div>

      {doc.players.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No high-school classes loaded yet; they arrive with the next weekly update.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ ...th, textAlign: 'right' }}>#</th>
                <th style={th}>Player</th>
                <th style={th}>Pos</th>
                <th style={th}>High school</th>
                <th style={th}>Hometown</th>
                <th style={th}>Committed</th>
                <th style={th}>Class</th>
                <th style={{ ...th, textAlign: 'right' }} title="Rank within his class, across positions">Class #</th>
                <th style={{ ...th, textAlign: 'right' }} title="Projected PPR points per game above replacement in this format (best two of first four NFL seasons, busts included)">Value</th>
                <th style={{ ...th, textAlign: 'right' }} title="The same projection, not above replacement">PPG</th>
                <th style={{ ...th, textAlign: 'right' }} title="Chance he's drafted as a QB, RB, WR or TE">Drafted</th>
                <th style={{ ...th, textAlign: 'right' }}>Ht</th>
                <th style={{ ...th, textAlign: 'right' }}>Wt</th>
                <th style={{ ...th, textAlign: 'right' }}>Draft</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((p) => (
                <tr key={p.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={num}>{p.rank[fmt]}</td>
                  <td style={{ ...td, fontWeight: 600 }}>{p.name}</td>
                  <td style={td}>{p.pos}</td>
                  <td style={{ ...td, color: 'var(--text-secondary)' }}>{p.hsSchool ?? ''}</td>
                  <td style={{ ...td, color: 'var(--text-secondary)' }}>{[p.city, p.state].filter(Boolean).join(', ')}</td>
                  <td style={td}>{p.committed ?? <span style={{ color: 'var(--text-muted)' }}>uncommitted</span>}</td>
                  <td style={td}>{p.class}</td>
                  <td style={{ ...num, color: 'var(--text-secondary)' }}>{p.classRank[fmt]}</td>
                  <td style={{ ...num, fontWeight: 600 }}>{p.careerScore[fmt].toFixed(2)}</td>
                  <td style={{ ...num, color: 'var(--text-secondary)' }}>{p.careerPPG.toFixed(1)}</td>
                  <td style={num}>{`${Math.round(p.pDrafted * 100)}%`}</td>
                  <td style={num}>{ht(p.height)}</td>
                  <td style={num}>{p.weight ?? ''}</td>
                  <td style={{ ...num, color: 'var(--text-secondary)' }}>{p.earliestDraft}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > shown && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Showing {shown.toLocaleString()} of {rows.length.toLocaleString()}</span>
          <button style={btn(false)} onClick={() => setShown((n) => n + PAGE * 4)}>Show more</button>
          <button style={btn(false)} onClick={() => setShown(rows.length)}>Show all</button>
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>Built {doc.generatedAt}. Recruit data: CollegeFootballData.com.</div>
    </div>
  );
}
