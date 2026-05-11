interface SeasonStat {
  season: number;
  school: string | null;
  'Passing Yards': number;
  'Passing Touchdowns': number;
  Interceptions: number;
  Completions: number;
  'Passing Attempts': number;
  'Rushing Yards': number;
  'Rushing Touchdowns': number;
  'Receiving Yards': number;
  'Receiving Touchdowns': number;
  Receptions: number;
}

interface UsageSeason {
  season: number;
  team: string | null;
  position: string | null;
  overall: number | null;
  pass: number | null;
  rush: number | null;
}

export interface Prospect2027CardData {
  name: string;
  pos: string;
  school: string;
  grade: number;
  projPick: number;
  projRound: number;
  tier: string;
  sources: string[];
  consensusRank: number | null;
  pffRank: number | null;
  tankathonPick: number | null;
  careerSeasons: number;
  careerSeasonList: number[];
  careerPassYds: number;
  careerPassTDs: number;
  careerPassInt: number;
  careerPassCmp: number;
  careerPassAtt: number;
  careerRushYds: number;
  careerRushTDs: number;
  careerRecYds: number;
  careerRecTDs: number;
  careerReceptions: number;
  bestPassYds: number;
  bestRushYds: number;
  bestRecYds: number;
  recruitStars: number | null;
  recruitRating: number | null;
  recruitRank: number | null;
  recruitClassYear: number | null;
  recruitPosition: string | null;
  recruitCommittedTo: string | null;
  recruitHeight: number | null;
  recruitWeight: number | null;
  seasonStats: SeasonStat[];
  usageBySeason: UsageSeason[];
  usage2025: number | null;
  usage2024: number | null;
}

function inchesToHt(inches: number | null): string {
  if (!inches || inches <= 0) return '—';
  const ft = Math.floor(inches / 12);
  const inn = Math.round(inches - ft * 12);
  return `${ft}'${inn}"`;
}

function fmt(n: number | null | undefined): string {
  if (n == null || n === 0) return '—';
  return n >= 1000 ? n.toLocaleString() : String(n);
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function classYearLabel(seasonsPlayed: number): string {
  // 2026 will be their senior year for most. Seasons played through 2025
  // tells us how many CFB years they have under their belt.
  if (seasonsPlayed === 0) return 'incoming';
  if (seasonsPlayed === 1) return 'sophomore';
  if (seasonsPlayed === 2) return 'junior';
  if (seasonsPlayed === 3) return 'senior';
  return `${ordinal(seasonsPlayed)}-year`;
}

function buildProfile(p: Prospect2027CardData): string {
  const parts: string[] = [];

  // Lead: who and what tier
  const cls = classYearLabel(p.careerSeasons);
  const stars = p.recruitStars ? `${p.recruitStars}-star` : '';
  const recruitClause = p.recruitClassYear
    ? ` (${p.recruitClassYear} ${stars} recruit${
        p.recruitRating ? `, .${String(p.recruitRating).slice(2, 6).padEnd(4, '0')} composite` : ''
      })`
    : stars
    ? ` (${stars} recruit)`
    : '';
  parts.push(
    `${p.name} is a ${cls} ${p.pos} at ${p.school}${recruitClause}, projected ${ordinal(
      p.projPick,
    )} overall (${p.tier}).`,
  );

  // Production
  if (p.pos === 'QB' && p.careerPassYds > 0) {
    const cmpPct = p.careerPassAtt > 0 ? Math.round((p.careerPassCmp / p.careerPassAtt) * 100) : null;
    parts.push(
      `Through ${p.careerSeasons} season${p.careerSeasons === 1 ? '' : 's'}, has ${fmt(
        p.careerPassYds,
      )} passing yards on ${fmt(p.careerPassCmp)}/${fmt(p.careerPassAtt)}${
        cmpPct ? ` (${cmpPct}%)` : ''
      } with ${p.careerPassTDs} TD and ${p.careerPassInt} INT.`,
    );
    if (p.careerRushYds > 0) {
      parts.push(`Adds ${fmt(p.careerRushYds)} rushing yards and ${p.careerRushTDs} rushing TD.`);
    }
  } else if (p.pos === 'RB' && (p.careerRushYds > 0 || p.careerReceptions > 0)) {
    parts.push(
      `Through ${p.careerSeasons} season${p.careerSeasons === 1 ? '' : 's'}, has ${fmt(
        p.careerRushYds,
      )} rushing yards and ${p.careerRushTDs} rushing TD${
        p.careerReceptions > 0
          ? `, plus ${p.careerReceptions} receptions for ${fmt(p.careerRecYds)} yards`
          : ''
      }.`,
    );
  } else if ((p.pos === 'WR' || p.pos === 'TE') && p.careerReceptions > 0) {
    parts.push(
      `Through ${p.careerSeasons} season${p.careerSeasons === 1 ? '' : 's'}, has ${
        p.careerReceptions
      } receptions for ${fmt(p.careerRecYds)} yards and ${p.careerRecTDs} TD.`,
    );
  }

  // Best season
  if (p.pos === 'QB' && p.bestPassYds > 0) {
    parts.push(`Best season: ${fmt(p.bestPassYds)} passing yards.`);
  } else if (p.pos === 'RB' && p.bestRushYds > 0) {
    parts.push(`Best season: ${fmt(p.bestRushYds)} rushing yards.`);
  } else if ((p.pos === 'WR' || p.pos === 'TE') && p.bestRecYds > 0) {
    parts.push(`Best season: ${fmt(p.bestRecYds)} receiving yards.`);
  }

  // Usage trend
  if (p.usage2025 != null && p.usage2024 != null) {
    const delta = p.usage2025 - p.usage2024;
    const arrow = delta > 0.01 ? '↑' : delta < -0.01 ? '↓' : '→';
    parts.push(
      `2025 snap-share ${(p.usage2025 * 100).toFixed(1)}% (${arrow} from ${
        (p.usage2024 * 100).toFixed(1)
      }% in 2024).`,
    );
  } else if (p.usage2025 != null) {
    parts.push(`2025 snap-share: ${(p.usage2025 * 100).toFixed(1)}%.`);
  }

  // Source consensus
  const srcRanks: string[] = [];
  if (p.consensusRank != null) srcRanks.push(`#${p.consensusRank} consensus`);
  if (p.pffRank != null) srcRanks.push(`#${p.pffRank} PFF`);
  if (p.tankathonPick != null) srcRanks.push(`#${p.tankathonPick} Tankathon`);
  if (srcRanks.length > 0) {
    parts.push(`Board ranks: ${srcRanks.join(' · ')}.`);
  }

  return parts.join(' ');
}

export function Prospect2027Card({
  prospect,
  onClose,
}: {
  prospect: Prospect2027CardData;
  onClose: () => void;
}) {
  const profile = buildProfile(prospect);
  const ht = inchesToHt(prospect.recruitHeight);
  const wt = prospect.recruitWeight ? `${prospect.recruitWeight} lb` : '—';
  const bmi =
    prospect.recruitHeight && prospect.recruitWeight && prospect.recruitHeight > 0
      ? Math.round(((prospect.recruitWeight * 703) / Math.pow(prospect.recruitHeight, 2)) * 10) / 10
      : null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-primary)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          maxWidth: 720,
          width: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
          padding: 24,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 22 }}>{prospect.name}</h2>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
              {prospect.pos} · {prospect.school} · 2027 NFL Draft
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              color: 'var(--text-secondary)',
              borderRadius: 4,
              padding: '4px 10px',
              cursor: 'pointer',
            }}
          >
            close
          </button>
        </div>

        {/* Headline metrics */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
            gap: 8,
            marginBottom: 16,
          }}
        >
          <Metric label="Proj Pick" value={`#${prospect.projPick}`} />
          <Metric label="Tier" value={prospect.tier} />
          <Metric label="Grade" value={String(prospect.grade)} />
          <Metric label="Recruit" value={prospect.recruitStars ? `${prospect.recruitStars}★` : '—'} />
          <Metric label="Height" value={ht} />
          <Metric label="Weight" value={wt} />
          <Metric label="BMI" value={bmi != null ? String(bmi) : '—'} />
        </div>

        {/* Text profile */}
        <div
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: 12,
            fontSize: 13,
            lineHeight: 1.55,
            marginBottom: 16,
            color: 'var(--text-primary)',
          }}
        >
          {profile}
        </div>

        {/* Recruit profile */}
        {prospect.recruitClassYear != null && (
          <Section title="Recruit Profile (247Sports composite)">
            <KV label="Class" value={String(prospect.recruitClassYear)} />
            <KV label="Position" value={prospect.recruitPosition || '—'} />
            <KV label="Stars" value={prospect.recruitStars ? `${prospect.recruitStars}★` : '—'} />
            <KV
              label="Composite"
              value={prospect.recruitRating != null ? prospect.recruitRating.toFixed(4) : '—'}
            />
            <KV label="Nat. Rank" value={prospect.recruitRank != null ? `#${prospect.recruitRank}` : '—'} />
            <KV label="Committed To" value={prospect.recruitCommittedTo || '—'} />
          </Section>
        )}

        {/* Per-season stats */}
        {prospect.seasonStats.length > 0 && (
          <Section title="College Production by Season">
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <th style={cellTh}>Season</th>
                    {prospect.pos === 'QB' && (
                      <>
                        <th style={cellTh}>Pass Yds</th>
                        <th style={cellTh}>TD</th>
                        <th style={cellTh}>INT</th>
                        <th style={cellTh}>Cmp/Att</th>
                      </>
                    )}
                    {(prospect.pos === 'RB' || prospect.pos === 'QB') && (
                      <>
                        <th style={cellTh}>Rush Yds</th>
                        <th style={cellTh}>Rush TD</th>
                      </>
                    )}
                    {(prospect.pos === 'WR' || prospect.pos === 'TE' || prospect.pos === 'RB') && (
                      <>
                        <th style={cellTh}>Rec</th>
                        <th style={cellTh}>Rec Yds</th>
                        <th style={cellTh}>Rec TD</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {prospect.seasonStats.map((s) => (
                    <tr key={s.season} style={{ borderBottom: '1px solid var(--border-subtle, #2a2a2a)' }}>
                      <td style={cellTd}>{s.season}</td>
                      {prospect.pos === 'QB' && (
                        <>
                          <td style={cellTd}>{fmt(s['Passing Yards'])}</td>
                          <td style={cellTd}>{s['Passing Touchdowns']}</td>
                          <td style={cellTd}>{s.Interceptions}</td>
                          <td style={cellTd}>
                            {s.Completions}/{s['Passing Attempts']}
                          </td>
                        </>
                      )}
                      {(prospect.pos === 'RB' || prospect.pos === 'QB') && (
                        <>
                          <td style={cellTd}>{fmt(s['Rushing Yards'])}</td>
                          <td style={cellTd}>{s['Rushing Touchdowns']}</td>
                        </>
                      )}
                      {(prospect.pos === 'WR' || prospect.pos === 'TE' || prospect.pos === 'RB') && (
                        <>
                          <td style={cellTd}>{s.Receptions}</td>
                          <td style={cellTd}>{fmt(s['Receiving Yards'])}</td>
                          <td style={cellTd}>{s['Receiving Touchdowns']}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        {/* Usage shares */}
        {prospect.usageBySeason.length > 0 && (
          <Section title="Snap-Share by Season">
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <th style={cellTh}>Season</th>
                    <th style={cellTh}>Team</th>
                    <th style={cellTh}>Overall</th>
                    <th style={cellTh}>Pass Plays</th>
                    <th style={cellTh}>Rush Plays</th>
                  </tr>
                </thead>
                <tbody>
                  {prospect.usageBySeason.map((u) => (
                    <tr key={u.season} style={{ borderBottom: '1px solid var(--border-subtle, #2a2a2a)' }}>
                      <td style={cellTd}>{u.season}</td>
                      <td style={cellTd}>{u.team || '—'}</td>
                      <td style={cellTd}>{fmtPct(u.overall)}</td>
                      <td style={cellTd}>{fmtPct(u.pass)}</td>
                      <td style={cellTd}>{fmtPct(u.rush)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        {/* Sources */}
        <Section title="Source Boards">
          <KV label="Consensus" value={prospect.consensusRank != null ? `#${prospect.consensusRank}` : '—'} />
          <KV label="PFF Big Board" value={prospect.pffRank != null ? `#${prospect.pffRank}` : '—'} />
          <KV
            label="Tankathon Mock"
            value={prospect.tankathonPick != null ? `pick ${prospect.tankathonPick}` : '—'}
          />
        </Section>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        padding: '8px 10px',
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: 'var(--text-muted)',
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 13 }}>{children}</div>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span style={{ color: 'var(--text-muted)', marginRight: 6 }}>{label}:</span>
      <span style={{ fontWeight: 500 }}>{value}</span>
    </div>
  );
}

const cellTh: React.CSSProperties = {
  padding: '6px 8px',
  textAlign: 'left',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  whiteSpace: 'nowrap',
};

const cellTd: React.CSSProperties = {
  padding: '6px 8px',
  whiteSpace: 'nowrap',
};
