import { useState, useEffect, useMemo, useRef } from 'react';
import { PlayerName } from './PlayerName';
import {
  parseCheatsheetText, resolvePositions, normalizeCheatsheetName,
  saveCheatsheet, loadStoredCheatsheet, clearStoredCheatsheet,
  type CheatsheetDoc, type CheatsheetPlayer,
} from '../lib/sfbCheatsheet';
import { computeSFBPoints, SFB_LABEL } from '../lib/sfbScoring';

/**
 * SFB16 Cheatsheet — research tab over the Footballguys Scott Fish Bowl
 * draft cheatsheet, cross-referenced with this app's own SFB-scored
 * projections. The sheet is a paid product: its JSON lives only in
 * public/data/sfb16-cheatsheet.json (gitignored, local dev) or in
 * localStorage via the import box below — it never ships with the repo.
 */

const BASE = import.meta.env.BASE_URL;
const POS_COLORS: Record<string, string> = { QB: '#6366f1', RB: '#10b981', WR: '#f59e0b', TE: '#ef4444' };

interface OurEntry { pts: number; rank: number } // rank within QB or flex pool

export function SFBCheatsheet() {
  const [doc, setDoc] = useState<CheatsheetDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [listMode, setListMode] = useState<'FLEX' | 'QB'>('FLEX');
  const [posFilter, setPosFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  // Our SFB-scored projection pool: normalized name → points + pool rank.
  const [ourFlex, setOurFlex] = useState<Map<string, OurEntry>>(new Map());
  const [ourQbs, setOurQbs] = useState<Map<string, OurEntry>>(new Map());
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Local file first (dev machine with the parsed sheet), then the
      // in-browser import cache.
      try {
        const r = await fetch(`${BASE}data/sfb16-cheatsheet.json`);
        if (r.ok) {
          const d = (await r.json()) as CheatsheetDoc;
          if (!cancelled && Array.isArray(d.flex) && d.flex.length) { setDoc(d); return; }
        }
      } catch { /* not present — fall through */ }
      if (!cancelled) setDoc(loadStoredCheatsheet());
    })().finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${BASE}data/projection-base-2026.json`);
        if (!r.ok) return;
        const base = await r.json();
        interface Line { name: string; games: number; passAtt?: number; passYds?: number; passTD?: number; rushAtt?: number; rushYds?: number; rushTD?: number; rec?: number; recYds?: number; recTD?: number }
        const score = (p: Line, position: string) => computeSFBPoints({
          position, games: p.games,
          passAtt: p.passAtt, passYds: p.passYds, passTD: p.passTD,
          rushAtt: p.rushAtt, rushYds: p.rushYds, rushTD: p.rushTD,
          rec: p.rec, recYds: p.recYds, recTD: p.recTD,
        });
        const rankInto = (rows: { name: string; pts: number }[]) => {
          const m = new Map<string, OurEntry>();
          rows.sort((a, b) => b.pts - a.pts).forEach((row, i) => m.set(normalizeCheatsheetName(row.name), { pts: row.pts, rank: i + 1 }));
          return m;
        };
        const flexRows = [
          ...(base.rbs ?? []).map((p: Line) => ({ name: p.name, pts: score(p, 'RB') })),
          ...(base.wrs ?? []).map((p: Line) => ({ name: p.name, pts: score(p, 'WR') })),
          ...(base.tes ?? []).map((p: Line) => ({ name: p.name, pts: score(p, 'TE') })),
        ];
        const qbRows = (base.qbs ?? []).map((p: Line) => ({ name: p.name, pts: score(p, 'QB') }));
        if (!cancelled) { setOurFlex(rankInto(flexRows)); setOurQbs(rankInto(qbRows)); }
      } catch { /* pool unavailable — comparison columns stay empty */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleImport = async (file: File) => {
    setImportStatus('Importing…');
    try {
      const text = await file.text();
      let parsed: CheatsheetDoc;
      if (file.name.endsWith('.json') || text.trimStart().startsWith('{')) {
        parsed = JSON.parse(text) as CheatsheetDoc;
        if (!Array.isArray(parsed.flex) || !Array.isArray(parsed.qbs)) throw new Error('Not a cheatsheet JSON (missing qbs/flex lists).');
      } else {
        // pdftotext -layout output; resolve flex positions from the
        // committed sleeper players lookup.
        parsed = parseCheatsheetText(text);
        if (!parsed.flex.length) throw new Error('No players found — export the PDF with `pdftotext -layout`.');
        try {
          const r = await fetch(`${BASE}data/sleeper-players.json`);
          if (r.ok) {
            const sleeper = await r.json();
            const posByName = new Map<string, string>();
            for (const p of sleeper.players ?? []) {
              const key = normalizeCheatsheetName(String(p.name ?? ''));
              if (key && p.position && !posByName.has(key)) posByName.set(key, String(p.position));
            }
            resolvePositions(parsed, posByName);
          }
        } catch { /* positions stay blank for unmatched players */ }
      }
      saveCheatsheet(parsed);
      setDoc(parsed);
      setImportStatus(`Imported ${parsed.flex.length + parsed.qbs.length} players (sheet generated ${parsed.generatedAt || 'unknown'}).`);
    } catch (e) {
      setImportStatus(`Import failed: ${e instanceof Error ? e.message : 'unreadable file'}`);
    }
  };

  const rows = useMemo(() => {
    if (!doc) return [] as CheatsheetPlayer[];
    let data = listMode === 'QB' ? doc.qbs : doc.flex;
    if (listMode === 'FLEX' && posFilter !== 'ALL') data = data.filter((p) => p.position === posFilter);
    if (search) {
      const q = search.toLowerCase();
      data = data.filter((p) => p.name.toLowerCase().includes(q) || p.team.toLowerCase().includes(q));
    }
    return data;
  }, [doc, listMode, posFilter, search]);

  const ourMap = listMode === 'QB' ? ourQbs : ourFlex;

  if (loading) {
    return <div className="loading"><div className="spinner" /><div className="loading-text">Loading cheatsheet…</div></div>;
  }

  if (!doc) {
    return (
      <div style={{ maxWidth: 640, margin: '40px auto', textAlign: 'center' }}>
        <h3>SFB16 Cheatsheet</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.6 }}>
          No cheatsheet loaded. The Footballguys SFB cheatsheet is a paid product, so its data never
          ships with the app — import your own copy here (stored only in this browser), or drop the
          parsed JSON at <code>public/data/sfb16-cheatsheet.json</code> for local dev.
          Accepted files: the parsed JSON, or raw <code>pdftotext -layout</code> text of the PDF.
        </p>
        <button className="scenario-action-btn" onClick={() => fileRef.current?.click()}>Import cheatsheet…</button>
        <input ref={fileRef} type="file" accept=".json,.txt" style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleImport(f); e.target.value = ''; }} />
        {importStatus && <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>{importStatus}</p>}
      </div>
    );
  }

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>SFB16 Cheatsheet</h3>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {doc.source} · generated {doc.generatedAt || 'unknown'} · local-only data
        </span>
        <button className="scenario-action-btn" style={{ fontSize: 11 }} onClick={() => fileRef.current?.click()}>Re-import</button>
        <button className="scenario-action-btn" style={{ fontSize: 11 }}
          onClick={() => { clearStoredCheatsheet(); setDoc(null); setImportStatus(null); }}>Clear</button>
        <input ref={fileRef} type="file" accept=".json,.txt" style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleImport(f); e.target.value = ''; }} />
        {importStatus && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{importStatus}</span>}
      </div>

      <div className="controls">
        <div className="position-filters">
          {(['FLEX', 'QB'] as const).map((m) => (
            <button key={m} className={`pos-filter ${listMode === m ? 'active' : ''}`} onClick={() => setListMode(m)}>
              {m === 'FLEX' ? 'RB / WR / TE' : 'QB'}
            </button>
          ))}
        </div>
        {listMode === 'FLEX' && (
          <div className="position-filters">
            {['ALL', 'RB', 'WR', 'TE'].map((pos) => (
              <button key={pos} className={`pos-filter ${posFilter === pos ? 'active' : ''}`} onClick={() => setPosFilter(pos)}>
                {pos}
              </button>
            ))}
          </div>
        )}
        <div className="control-group">
          <input type="text" placeholder="Search players…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      <div className="table-container" style={{ maxHeight: 640, overflowY: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th title="Rank within this cheatsheet list">#</th>
              <th title="Rank in the sheet's overall top 60 (QBs and flex together)">Ovr</th>
              <th>Player</th>
              <th>Pos</th>
              <th>Team</th>
              <th>Bye</th>
              <th title="Footballguys ADP+ (round.pick in the 12-team SFB format)">ADP+</th>
              <th title="Footballguys value score — projected points above a replacement-level pick">Value</th>
              <th title={`Our projection pool scored with ${SFB_LABEL} scoring (bonuses estimated)`}>Our {SFB_LABEL}</th>
              <th title="Our rank within the same pool (QB or RB/WR/TE)">Our Rk</th>
              <th title="Sheet rank minus our rank. Positive (green) = our model is higher on the player than the sheet.">Δ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const ours = ourMap.get(normalizeCheatsheetName(p.name));
              const delta = ours ? p.rank - ours.rank : 0;
              const deltaColor = !ours || Math.abs(delta) < 8 ? 'var(--text-muted)' : delta > 0 ? '#22c55e' : '#ef4444';
              return (
                <tr key={`${p.rank}-${p.name}`}>
                  <td className="rank-cell">{p.rank}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{p.overallRank ?? ''}</td>
                  <td>
                    <strong><PlayerName name={p.name} /></strong>
                    {p.rookie && <span title="Rookie" style={{ marginLeft: 6, fontSize: 10, color: '#a78bfa', fontWeight: 700 }}>R</span>}
                    {p.upside && <span title="Footballguys high-upside flag" style={{ marginLeft: 4, fontSize: 10 }}>⚡</span>}
                  </td>
                  <td><span className={`pos-badge pos-${p.position}`} style={{ color: POS_COLORS[p.position] }}>{p.position || '—'}</span></td>
                  <td>{p.team || 'FA'}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{p.bye || '—'}</td>
                  <td>{p.adp || '—'}</td>
                  <td style={{ fontWeight: 700, color: p.value > 0 ? '#22c55e' : 'var(--text-muted)' }}>{p.value}</td>
                  <td style={{ fontWeight: 700 }}>{ours ? Math.round(ours.pts) : '—'}</td>
                  <td>{ours ? ours.rank : '—'}</td>
                  <td style={{ fontWeight: 700, color: deltaColor }}>{ours ? (delta > 0 ? `+${delta}` : delta) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
