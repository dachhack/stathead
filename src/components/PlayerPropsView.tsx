import { useEffect, useMemo, useState } from 'react';
import { bust } from '../lib/buildHash';
import { teamLogoUrl } from '../lib/teamLogo';
import { PlayerName } from './PlayerName';
import {
  priceProp, weekLine, restOfGame, zeroProbForYards, anytimeTdProb,
  type PlayerPropsDoc, type QuarterSplitsDoc, type PropPlayer, type Prop,
} from '../lib/playerProps';

const POS_FILTERS = ['ALL', 'QB', 'RB', 'WR', 'TE'] as const;
const QUARTERS = [0, 1, 2, 3] as const;
const QUARTER_LABEL: Record<number, string> = {
  0: 'Pre-kickoff', 1: 'After Q1', 2: 'Halftime', 3: 'After Q3',
};
const STAT_LABEL: Record<string, string> = {
  passAtt: 'Pass att', passComp: 'Completions', passYds: 'Pass yds', passTD: 'Pass TD',
  int: 'INT', rushAtt: 'Carries', rushYds: 'Rush yds', rushTD: 'Rush TD',
  tgt: 'Targets', rec: 'Receptions', recYds: 'Rec yds', recTD: 'Rec TD',
  pprPts: 'PPR points',
};
/** The stat a position's board leads with. */
const HEADLINE: Record<string, string> = { QB: 'passYds', RB: 'rushYds', WR: 'recYds', TE: 'recYds' };

/** Matchup color: high grade = tough defense (red), low = soft (green). */
function gradeColor(g: number | null | undefined): string {
  if (g == null) return 'var(--text-muted)';
  if (g >= 70) return '#ef4444';
  if (g >= 55) return '#f59e0b';
  if (g > 45) return 'var(--text-muted)';
  if (g > 30) return '#a3e635';
  return '#22c55e';
}

/** Over% color: a prop the model likes to clear reads green. */
function overColor(p: number): string {
  if (p >= 0.6) return '#22c55e';
  if (p <= 0.4) return '#ef4444';
  return 'var(--text-muted)';
}

const fmt = (v: number | null | undefined, d = 1) =>
  v == null ? '—' : v.toFixed(d);
const pct = (v: number | null | undefined) =>
  v == null ? '—' : `${(v * 100).toFixed(0)}%`;

function PropTable({ props: rows, anytimeTd }: { props: Prop[]; anytimeTd: number | null }) {
  return (
    <div className="table-container">
      <table>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Stat</th>
            <th>Projected</th>
            <th>Line</th>
            <th title="Probability of clearing the line, if he plays">Over</th>
            <th>Under</th>
            <th title="10th–90th percentile outcome range">Range</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.stat}>
              <td style={{ textAlign: 'left' }}>{STAT_LABEL[p.stat] ?? p.stat}</td>
              <td style={{ fontWeight: 700 }}>{fmt(p.mean, p.mean < 10 ? 2 : 1)}</td>
              <td>{p.line.toFixed(1)}</td>
              <td style={{ fontWeight: 600, color: overColor(p.over) }}>{pct(p.over)}</td>
              <td style={{ color: 'var(--text-muted)' }}>{pct(p.under)}</td>
              <td style={{ color: 'var(--text-muted)' }}>{fmt(p.p10, 0)}–{fmt(p.p90, 0)}</td>
            </tr>
          ))}
          {anytimeTd != null && (
            <tr>
              <td style={{ textAlign: 'left' }}>Anytime TD</td>
              <td colSpan={2} style={{ color: 'var(--text-muted)' }}>—</td>
              <td style={{ fontWeight: 600, color: overColor(anytimeTd) }}>{pct(anytimeTd)}</td>
              <td style={{ color: 'var(--text-muted)' }}>{pct(1 - anytimeTd)}</td>
              <td />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Rest-of-game panel: pick a quarter and a score, get what's still to come. */
function RestOfGame({
  doc, splits, player, week,
}: { doc: PlayerPropsDoc; splits: QuarterSplitsDoc; player: PropPlayer; week: number }) {
  const [quarter, setQuarter] = useState<0 | 1 | 2 | 3>(2);
  const [scoreDiff, setScoreDiff] = useState<string>('');
  const [useScore, setUseScore] = useState(false);

  const rog = useMemo(() => restOfGame(doc, splits, player, week, {
    quarter,
    scoreDiff: useScore && scoreDiff !== '' ? Number(scoreDiff) : undefined,
  }), [doc, splits, player, week, quarter, scoreDiff, useScore]);

  if (!rog) return null;
  const headline = HEADLINE[player.pos] ?? 'pprPts';
  const remaining = rog.remaining[headline];

  return (
    <div style={{ marginTop: 16 }}>
      <h4 style={{ margin: '0 0 6px', fontSize: 14 }}>Rest of game</h4>
      <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '0 0 8px', maxWidth: 720 }}>
        What&apos;s still to come from this point, measured off {splits.seasons.join(' + ')} play-by-play:
        each quarter&apos;s share of a full game (Q2 and Q4 carry more, on two-minute drills),
        scaled for game script when you give it a score. Lines are priced off that window&apos;s own
        variance, not a scaled full-game number.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <select className="scenario-select" value={quarter}
          onChange={(e) => setQuarter(Number(e.target.value) as 0 | 1 | 2 | 3)}>
          {QUARTERS.map((q) => <option key={q} value={q}>{QUARTER_LABEL[q]}</option>)}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <input type="checkbox" checked={useScore} onChange={(e) => setUseScore(e.target.checked)} />
          Adjust for score
        </label>
        {useScore && (
          <input
            className="scenario-select"
            type="number"
            placeholder="his team − opponent"
            value={scoreDiff}
            onChange={(e) => setScoreDiff(e.target.value)}
            style={{ width: 170 }}
          />
        )}
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {rog.bucket ? `Game script: ${rog.bucket}` : 'No game-script adjustment'}
          {remaining != null && ` · ${pct(remaining)} of the game left`}
        </span>
      </div>
      <PropTable props={rog.props} anytimeTd={rog.anytimeTd} />
    </div>
  );
}

export function PlayerPropsView() {
  const [doc, setDoc] = useState<PlayerPropsDoc | null>(null);
  const [splits, setSplits] = useState<QuarterSplitsDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [week, setWeek] = useState(1);
  const [pos, setPos] = useState<(typeof POS_FILTERS)[number]>('ALL');
  const [stat, setStat] = useState('pprPts');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const get = <T,>(name: string) =>
      fetch(bust(`${import.meta.env.BASE_URL}data/${name}`))
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<T>; });
    Promise.all([
      get<PlayerPropsDoc>('player-props-2026.json'),
      get<QuarterSplitsDoc>('quarter-splits-2025.json'),
    ])
      .then(([p, q]) => { if (!cancelled) { setDoc(p); setSplits(q); } })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, []);

  // Stats offered in the ranking selector, for whichever positions are shown.
  const statOptions = useMemo(() => {
    if (!doc) return ['pprPts'];
    const keys = pos === 'ALL'
      ? Object.values(doc.statKeys).flat()
      : (doc.statKeys[pos] ?? []);
    return [...new Set(keys)];
  }, [doc, pos]);

  // Switching position can strip the selected stat out of the menu (a WR has
  // no pass attempts); fall back rather than syncing state in an effect.
  const activeStat = statOptions.includes(stat) ? stat : 'pprPts';

  const rows = useMemo(() => {
    if (!doc) return [];
    const q = search.trim().toLowerCase();
    return doc.players
      .filter((p) => (pos === 'ALL' || p.pos === pos) && (!q || p.name.toLowerCase().includes(q)))
      .map((p) => {
        const line = weekLine(doc, p, week);
        const game = (doc.teamWeeks[p.team] ?? []).find((g) => g.w === week) ?? null;
        const disp = doc.dispersion[p.pos] ?? {};
        const prop = line && activeStat in line
          ? priceProp(activeStat, line[activeStat], disp[activeStat], doc.countStats, undefined,
              zeroProbForYards(activeStat, line, disp))
          : null;
        const tds = line ? (line.rushTD ?? 0) + (line.recTD ?? 0) : 0;
        return {
          p,
          game,
          prop,
          td: tds > 0 ? anytimeTdProb(tds) : null,
          defGrade: game ? doc.defense[game.opp]?.pos?.[p.pos]?.grade ?? null : null,
          ovrGrade: game ? doc.defense[game.opp]?.overall?.grade ?? null : null,
        };
      })
      .sort((a, b) => (b.prop?.mean ?? -1) - (a.prop?.mean ?? -1));
  }, [doc, week, pos, activeStat, search]);

  const selectedRow = selected ? rows.find((r) => `${r.p.name}:${r.p.team}` === selected) : null;
  const selectedBoard = useMemo(() => {
    if (!doc || !selectedRow) return null;
    const line = weekLine(doc, selectedRow.p, week);
    if (!line) return null;
    const disp = doc.dispersion[selectedRow.p.pos] ?? {};
    const props = Object.keys(line).map((k) =>
      priceProp(k, line[k], disp[k], doc.countStats, undefined, zeroProbForYards(k, line, disp)));
    const tds = (line.rushTD ?? 0) + (line.recTD ?? 0);
    return { props, anytimeTd: tds > 0 ? anytimeTdProb(tds) : null };
  }, [doc, selectedRow, week]);

  if (error) return <div className="empty-state"><h3>Player props unavailable</h3><p>{error}</p></div>;
  if (!doc || !splits) return <div className="loading"><div className="spinner" /><div className="loading-text">Loading player props…</div></div>;

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{doc.season} Player Props</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '4px 0 0', maxWidth: 760 }}>
          The full projected stat line for every player-week — not just fantasy points — priced as a
          prop. Each stat carries its own opponent multiplier (a defense can be soft on carries and
          stingy on targets), normalized so the weeks sum back to the season projection. The line is
          the half point nearest a coin flip; over/under and the range come from {doc.priorSeason}&apos;s
          week-to-week spread — negative binomial for counting stats, gamma for yardage.
          Numbers assume the player suits up.
        </p>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <button className="se-cycle" onClick={() => setWeek((w) => Math.max(1, w - 1))} aria-label="previous week">◀</button>
        <select className="scenario-select" value={week} onChange={(e) => setWeek(Number(e.target.value))}>
          {Array.from({ length: doc.weeks }, (_, i) => i + 1).map((w) => <option key={w} value={w}>Week {w}</option>)}
        </select>
        <button className="se-cycle" onClick={() => setWeek((w) => Math.min(doc.weeks, w + 1))} aria-label="next week">▶</button>
        <select className="scenario-select" value={pos} onChange={(e) => setPos(e.target.value as typeof POS_FILTERS[number])}>
          {POS_FILTERS.map((f) => <option key={f} value={f}>{f === 'ALL' ? 'All positions' : f}</option>)}
        </select>
        <select className="scenario-select" value={activeStat} onChange={(e) => setStat(e.target.value)}>
          {statOptions.map((s) => <option key={s} value={s}>{STAT_LABEL[s] ?? s}</option>)}
        </select>
        <input
          className="scenario-select"
          type="search"
          placeholder="Search player…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 160 }}
        />
      </div>

      {selectedRow && selectedBoard && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 16 }}>
                {selectedRow.p.name} · {selectedRow.p.team} {selectedRow.p.pos} · Week {week}{' '}
                {selectedRow.game ? `${selectedRow.game.home ? 'vs' : '@'} ${selectedRow.game.opp}` : 'BYE'}
              </h3>
              <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '4px 0 0' }}>
                Availability {pct(selectedRow.p.avail)} over a projected {selectedRow.p.gp} games
                {selectedRow.p.injury?.status ? ` · ${selectedRow.p.injury.status}` : ''}
                {selectedRow.defGrade != null && ` · defense vs ${selectedRow.p.pos} grade ${selectedRow.defGrade}/100`}
                {selectedRow.ovrGrade != null && ` · overall defense ${selectedRow.ovrGrade}/100 (100 = toughest)`}
              </p>
            </div>
            <button className="se-cycle" onClick={() => setSelected(null)} aria-label="close">✕</button>
          </div>
          <div style={{ marginTop: 10 }}>
            <PropTable props={selectedBoard.props} anytimeTd={selectedBoard.anytimeTd} />
          </div>
          <RestOfGame doc={doc} splits={splits} player={selectedRow.p} week={week} />
        </div>
      )}

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th style={{ textAlign: 'left' }}>Player</th>
              <th>Pos</th>
              <th>Team</th>
              <th>Opp</th>
              <th title="Opponent's defense-vs-position grade, 0–100 where 100 = toughest">Matchup</th>
              <th>{STAT_LABEL[activeStat] ?? activeStat}</th>
              <th>Line</th>
              <th title="Probability of clearing the line, if he plays">Over</th>
              <th title="10th–90th percentile outcome range">Range</th>
              <th title="Probability of scoring at least one TD">Any TD</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 300).map((r, i) => (
              <tr
                key={`${r.p.name}:${r.p.team}`}
                onClick={() => setSelected(`${r.p.name}:${r.p.team}`)}
                style={{ cursor: 'pointer' }}
              >
                <td style={{ color: 'var(--text-muted)' }}>{r.prop == null ? '—' : i + 1}</td>
                <td style={{ textAlign: 'left', fontWeight: 600 }}>
                  <PlayerName name={r.p.name} position={r.p.pos} />
                </td>
                <td>{r.p.pos}</td>
                <td>
                  <img src={teamLogoUrl(r.p.team)} alt="" width={18} height={18} style={{ objectFit: 'contain', verticalAlign: 'middle', marginRight: 4 }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                  {r.p.team}
                </td>
                <td>{r.game ? `${r.game.home ? 'vs' : '@'} ${r.game.opp}` : <span style={{ color: 'var(--text-muted)' }}>BYE</span>}</td>
                <td style={{ fontWeight: 600, color: gradeColor(r.defGrade) }}>
                  {r.defGrade == null ? '' : r.defGrade.toFixed(0)}
                </td>
                <td style={{ fontWeight: 700 }}>
                  {r.prop == null ? '—' : fmt(r.prop.mean, r.prop.mean < 10 ? 2 : 1)}
                </td>
                <td>{r.prop == null ? '—' : r.prop.line.toFixed(1)}</td>
                <td style={{ fontWeight: 600, color: r.prop ? overColor(r.prop.over) : undefined }}>
                  {r.prop == null ? '—' : pct(r.prop.over)}
                </td>
                <td style={{ color: 'var(--text-muted)' }}>
                  {r.prop == null ? '—' : `${fmt(r.prop.p10, 0)}–${fmt(r.prop.p90, 0)}`}
                </td>
                <td style={{ color: 'var(--text-muted)' }}>{r.td == null ? '—' : pct(r.td)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 8 }}>
        {rows.length} players · click a row for the full prop board and rest-of-game projection ·
        props generated {doc.generatedAt.slice(0, 10)}, quarter splits {splits.generatedAt.slice(0, 10)} ·
        refreshed with the daily data pipeline.
      </p>
    </div>
  );
}
