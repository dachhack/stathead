import { useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { usePlayerDetail } from '../hooks/usePlayerDetail';
import type { PlayerStats } from '../types';

interface Props {
  playerKey: string;
  onBack: () => void;
}

export function PlayerDetail({ playerKey, onBack }: Props) {
  const { data, loading, error } = usePlayerDetail(playerKey);

  if (loading) {
    return (
      <div style={{ padding: 24 }}>
        <BackLink onBack={onBack} />
        <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div style={{ padding: 24 }}>
        <BackLink onBack={onBack} />
        <p style={{ color: 'var(--text-muted)' }}>
          {error || 'Player not found.'}
        </p>
      </div>
    );
  }

  const { crosswalk: cw, career, ktcCurrent, ktcHistory, adpHistory, gameLog, gameLogSeason } = data;

  return (
    <div style={{ padding: '16px 24px', maxWidth: 1100, margin: '0 auto' }}>
      <BackLink onBack={onBack} />

      {/* Identity header */}
      <div style={{ marginTop: 12 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>{cw.display_name}</h1>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 6, fontSize: 13, color: 'var(--text-muted)' }}>
          <span className={`pos-badge pos-${cw.position}`}>{cw.position}</span>
          {ktcCurrent?.team && <span>{ktcCurrent.team}</span>}
          {cw.college && <span>{cw.college}</span>}
          {cw.birth_date && <span>DOB {cw.birth_date}</span>}
          {cw.earliest_season && cw.latest_season && (
            <span>{cw.earliest_season}–{cw.latest_season}</span>
          )}
          {cw.is_college_only && <span style={{ color: 'var(--accent)' }}>Pre-NFL</span>}
        </div>
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
          player_key <code>{cw.player_key}</code>
          {cw.alias_keys?.length ? (
            <> · alias_keys <code>{cw.alias_keys.join(', ')}</code></>
          ) : null}
        </div>
      </div>

      <Cards>
        {career && <CareerCard career={career} />}
        {ktcCurrent && <KtcCard current={ktcCurrent} history={ktcHistory} />}
        {adpHistory.length > 0 && <AdpCard rows={adpHistory} />}
        <IdsCard cw={cw} />
      </Cards>

      {gameLog.length > 0 && gameLogSeason && (
        <GameLogSection season={gameLogSeason} rows={gameLog} position={cw.position} />
      )}
    </div>
  );
}

function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <a
      href="#"
      onClick={(e) => { e.preventDefault(); onBack(); }}
      style={{ color: 'var(--text-muted)', textDecoration: 'none', fontSize: 13 }}
    >
      ← Back
    </a>
  );
}

function Cards({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, marginTop: 20 }}>
      {children}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 }}>
      <h3 style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {title}
      </h3>
      {children}
    </div>
  );
}

function CareerCard({ career }: { career: NonNullable<ReturnType<typeof usePlayerDetail>['data']>['career'] }) {
  if (!career) return null;
  const pct = career.percentile != null ? `${Math.round(career.percentile * 100)}` : '—';
  return (
    <Card title="Career Prediction">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13 }}>
        <Stat label="Predicted Career PPG" value={career.predictedCareerPPG?.toFixed(2)} />
        <Stat label="Model Tier" value={career.modelTier || '—'} />
        <Stat label="Percentile" value={pct} />
        <Stat label="Combined Score" value={career.combinedScore?.toFixed(2) ?? '—'} />
        {career.boomProb != null && <Stat label="Boom Prob" value={`${Math.round(career.boomProb * 100)}%`} />}
        {career.bustProb != null && <Stat label="Bust Prob" value={`${Math.round(career.bustProb * 100)}%`} />}
        {career.actualPPG != null && <Stat label="Actual PPG" value={career.actualPPG.toFixed(2)} />}
        {career.draftSeason != null && <Stat label="Draft Class" value={String(career.draftSeason)} />}
        {career.projRound != null && <Stat label="Proj Round" value={String(career.projRound)} />}
        {career.projPick != null && <Stat label="Proj Pick" value={String(career.projPick)} />}
      </div>
    </Card>
  );
}

function KtcCard({
  current,
  history,
}: {
  current: NonNullable<ReturnType<typeof usePlayerDetail>['data']>['ktcCurrent'];
  history: NonNullable<ReturnType<typeof usePlayerDetail>['data']>['ktcHistory'];
}) {
  if (!current) return null;
  const points = history?.oneQB?.valueHistory || [];
  // Show last 12 months
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  const recent = points.filter((p) => new Date(p.d) >= cutoff);
  return (
    <Card title="KTC Dynasty Value">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13 }}>
        <Stat label="1QB Value" value={String(current.value)} />
        <Stat label="SF Value" value={String(current.superflexValue)} />
        <Stat label="Pos Rank" value={`${current.position}${current.positionRank}`} />
        <Stat label="Age" value={current.age ? String(current.age) : '—'} />
      </div>
      {recent.length > 1 && (
        <div style={{ height: 120, marginTop: 12 }}>
          <ResponsiveContainer>
            <LineChart data={recent} margin={{ top: 5, right: 6, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                dataKey="d"
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                tickFormatter={(d: string) => {
                  const date = new Date(d);
                  return `${date.getMonth() + 1}/${String(date.getFullYear()).slice(2)}`;
                }}
                minTickGap={30}
              />
              <YAxis
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                domain={['auto', 'auto']}
                width={40}
              />
              <Tooltip
                contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
                labelFormatter={(d) => new Date(String(d)).toLocaleDateString()}
              />
              <Line type="monotone" dataKey="v" stroke="var(--accent)" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

function AdpCard({ rows }: { rows: NonNullable<ReturnType<typeof usePlayerDetail>['data']>['adpHistory'] }) {
  return (
    <Card title="ADP History">
      <div style={{ height: 140 }}>
        <ResponsiveContainer>
          <LineChart data={rows} margin={{ top: 5, right: 6, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              dataKey="season"
              tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
              type="number"
              domain={['dataMin', 'dataMax']}
              allowDecimals={false}
            />
            {/* ADP lower number = better → invert y-axis for intuition. */}
            <YAxis
              tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
              reversed
              width={40}
              domain={['auto', 'auto']}
            />
            <Tooltip
              contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
            />
            <Line type="monotone" dataKey="adp" stroke="var(--accent)" strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
        {rows.length} season{rows.length === 1 ? '' : 's'} of historical redraft ADP (lower = earlier pick).
      </div>
    </Card>
  );
}

function IdsCard({ cw }: { cw: NonNullable<ReturnType<typeof usePlayerDetail>['data']>['crosswalk'] }) {
  const ids: Array<[string, string | number | undefined]> = [
    ['gsis', cw.gsis_id],
    ['pfr', cw.pfr_id],
    ['sleeper', cw.sleeper_id],
    ['espn', cw.espn_id],
    ['pff', cw.pff_id],
    ['yahoo', cw.yahoo_id],
    ['sportradar', cw.sportradar_id],
    ['rotowire', cw.rotowire_id],
    ['fantasy_data', cw.fantasy_data_id],
    ['ktc', cw.ktc_id],
  ];
  const present = ids.filter(([, v]) => v);
  if (!present.length) return null;
  return (
    <Card title="External IDs">
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 12, fontFamily: 'monospace' }}>
        {present.map(([label, val]) => (
          <div key={label} style={{ display: 'contents' }}>
            <span style={{ color: 'var(--text-muted)' }}>{label}</span>
            <span>{String(val)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{value ?? '—'}</div>
    </div>
  );
}

function GameLogSection({ season, rows, position }: { season: number; rows: PlayerStats[]; position: string }) {
  const totals = useMemo(() => {
    const t = rows.reduce(
      (acc, r) => ({
        games: acc.games + 1,
        ppr: acc.ppr + (r.fantasy_points_ppr || 0),
        pass: acc.pass + (r.passing_yards || 0),
        passTd: acc.passTd + (r.passing_tds || 0),
        rush: acc.rush + (r.rushing_yards || 0),
        rushTd: acc.rushTd + (r.rushing_tds || 0),
        rec: acc.rec + (r.receptions || 0),
        recYd: acc.recYd + (r.receiving_yards || 0),
        recTd: acc.recTd + (r.receiving_tds || 0),
      }),
      { games: 0, ppr: 0, pass: 0, passTd: 0, rush: 0, rushTd: 0, rec: 0, recYd: 0, recTd: 0 },
    );
    return t;
  }, [rows]);

  const isSkill = position === 'WR' || position === 'RB' || position === 'TE' || position === 'FB';
  const isQb = position === 'QB';

  return (
    <div style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>Game Log — {season}</h2>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
        {totals.games} games · {totals.ppr.toFixed(1)} PPR
        {isQb && <> · {totals.pass} pass yd · {totals.passTd} TD</>}
        {isSkill && (
          <>
            {' · '}{totals.rec} rec / {totals.recYd} yd / {totals.recTd} TD
            {(totals.rush > 0 || totals.rushTd > 0) && <> · {totals.rush} rush yd / {totals.rushTd} TD</>}
          </>
        )}
      </div>
      <div style={{ overflowX: 'auto', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--bg-tertiary)' }}>
              <Th>Wk</Th>
              <Th>Team</Th>
              <Th>Opp</Th>
              <Th right>PPR</Th>
              {isQb && <><Th right>Pass Yd</Th><Th right>TD</Th><Th right>INT</Th></>}
              {isSkill && <><Th right>Rec</Th><Th right>Tgt</Th><Th right>Rec Yd</Th><Th right>Rec TD</Th></>}
              {(isSkill || isQb) && <><Th right>Rush Yd</Th><Th right>Rush TD</Th></>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.season}-${r.week}`} style={{ borderTop: '1px solid var(--border)' }}>
                <Td>{r.week}</Td>
                <Td>{r.recent_team}</Td>
                <Td>{r.opponent_team}</Td>
                <Td right>{(r.fantasy_points_ppr || 0).toFixed(1)}</Td>
                {isQb && <><Td right>{r.passing_yards || 0}</Td><Td right>{r.passing_tds || 0}</Td><Td right>{r.interceptions || 0}</Td></>}
                {isSkill && <><Td right>{r.receptions || 0}</Td><Td right>{r.targets || 0}</Td><Td right>{r.receiving_yards || 0}</Td><Td right>{r.receiving_tds || 0}</Td></>}
                {(isSkill || isQb) && <><Td right>{r.rushing_yards || 0}</Td><Td right>{r.rushing_tds || 0}</Td></>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th style={{
      padding: '6px 10px',
      textAlign: right ? 'right' : 'left',
      fontWeight: 600,
      color: 'var(--text-muted)',
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    }}>{children}</th>
  );
}

function Td({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <td style={{ padding: '6px 10px', textAlign: right ? 'right' : 'left' }}>{children}</td>
  );
}
