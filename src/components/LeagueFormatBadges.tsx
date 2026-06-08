import type { LeagueFormatInfo } from '../lib/sleeper';

const TYPE_COLOR: Record<LeagueFormatInfo['type'], string> = {
  Dynasty: '#22c55e',
  Keeper: '#f59e0b',
  Redraft: 'var(--text-muted)',
};

const chip: React.CSSProperties = {
  padding: '0 5px', borderRadius: 4, border: '1px solid var(--border)',
  background: 'var(--bg-tertiary)', whiteSpace: 'nowrap',
};

// Compact format summary for a league row: type · QB format, plus Best Ball
// and IDP chips when applicable.
export function LeagueFormatBadges({ info }: { info: LeagueFormatInfo }) {
  return (
    <span style={{ display: 'inline-flex', gap: 5, flexWrap: 'wrap', alignItems: 'center', fontSize: 10 }}>
      <span style={{ color: TYPE_COLOR[info.type], fontWeight: 700 }}>{info.type}</span>
      <span style={{ color: 'var(--text-muted)' }}>{info.qb}</span>
      {info.bestBall && <span style={{ ...chip, color: '#a78bfa' }}>Best Ball</span>}
      {info.idp && <span style={{ ...chip, color: '#60a5fa' }}>IDP</span>}
    </span>
  );
}
