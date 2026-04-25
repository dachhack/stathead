import { useState } from 'react';
import type { DraftPrepSettings } from '../lib/draftPrepSettings';
import { saveSettings } from '../lib/draftPrepSettings';

// Pinned settings header for the draft prep tool. Five inputs (numTeams,
// pickSlot, draftType, roster, scoring) drive every downstream
// computation. Persists to localStorage on every change.

interface Props {
  settings: DraftPrepSettings;
  onChange: (next: DraftPrepSettings) => void;
}

const TEAM_OPTIONS = [8, 10, 12, 14] as const;
const ROSTER_KEYS = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'SF'] as const;

export function DraftPrepSettings({ settings, onChange }: Props) {
  const [open, setOpen] = useState(false);

  const update = (next: DraftPrepSettings) => {
    saveSettings(next);
    onChange(next);
  };

  const setField = <K extends keyof DraftPrepSettings>(key: K, value: DraftPrepSettings[K]) => {
    update({ ...settings, [key]: value });
  };

  const setRoster = (key: keyof DraftPrepSettings['roster'], value: number) => {
    const clamped = Math.max(0, Math.min(8, Math.round(value)));
    update({ ...settings, roster: { ...settings.roster, [key]: clamped } });
  };

  const pillStyle: React.CSSProperties = {
    background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
    borderRadius: 6, padding: '3px 8px', fontSize: 11, fontWeight: 600,
  };
  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-secondary)', border: '1px solid var(--border)',
    borderRadius: 4, padding: '2px 4px', fontSize: 11,
    color: 'var(--text-primary)', fontFamily: 'inherit', width: 32, textAlign: 'center',
  };

  return (
    <div style={{
      background: 'var(--bg-secondary)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '8px 12px', marginBottom: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.5 }}>
          LEAGUE
        </span>

        <label style={pillStyle}>
          Teams{' '}
          <select
            value={settings.numTeams}
            onChange={(e) => setField('numTeams', Number(e.target.value))}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 11, fontWeight: 700 }}
          >
            {TEAM_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>

        <label style={pillStyle}>
          Pick{' '}
          <input
            type="number"
            min={1}
            max={settings.numTeams}
            value={settings.pickSlot}
            onChange={(e) => {
              const v = Math.max(1, Math.min(settings.numTeams, Number(e.target.value) || 1));
              setField('pickSlot', v);
            }}
            style={inputStyle}
          />
        </label>

        <label style={pillStyle}>
          <select
            value={settings.draftType}
            onChange={(e) => setField('draftType', e.target.value as DraftPrepSettings['draftType'])}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 11, fontWeight: 700 }}
          >
            <option value="snake">Snake</option>
            <option value="linear">Linear</option>
          </select>
        </label>

        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            ...pillStyle, cursor: 'pointer',
            background: open ? 'var(--bg-quaternary, #2a2a2a)' : 'var(--bg-tertiary)',
          }}
        >
          {open ? '▾' : '▸'} Roster
        </button>

        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
          {ROSTER_KEYS.map((k) => `${k}:${settings.roster[k]}`).join('  ')}
        </span>
      </div>

      {open && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, marginTop: 8,
          paddingTop: 8, borderTop: '1px solid var(--border)', flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Starters per team:</span>
          {ROSTER_KEYS.map((k) => (
            <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
              {k}
              <input
                type="number"
                min={0}
                max={8}
                value={settings.roster[k]}
                onChange={(e) => setRoster(k, Number(e.target.value))}
                style={inputStyle}
              />
            </label>
          ))}
          <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 'auto' }}>
            FLEX = RB/WR/TE • SF = QB/RB/WR/TE
          </span>
        </div>
      )}
    </div>
  );
}
