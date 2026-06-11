import { useState } from 'react';
import type { DraftPrepSettings } from '../lib/draftPrepSettings';
import { saveSettings } from '../lib/draftPrepSettings';
import type { ScenarioConfig } from '../types';

// Pinned settings header for the draft prep tool. Five inputs (numTeams,
// pickSlot, draftType, roster, scoring) drive every downstream
// computation. Persists to localStorage on every change.
//
// Optional scenario dropdown lets users swap in a saved projection
// scenario from `scenarioEngine` (defined in StatProjections /
// MyRankings / ScenarioBuilder). When active, scenario-projected PPG
// flows through PickEdge / Beat % / Verdict so the user can see how
// alternative projection assumptions change every recommendation.
//
// Visual language: uniform pill controls (see .league-pill in index.css)
// with the roster summary folded into the Roster toggle itself, and an
// accent ring on the Scenario pill when one is active.

interface Props {
  settings: DraftPrepSettings;
  onChange: (next: DraftPrepSettings) => void;
  scenarios?: ScenarioConfig[];
  /** Built-in projection presets (scenarioPresets.ts), offered alongside
   *  the user's saved scenarios. */
  presets?: Array<{ id: string; name: string; description: string }>;
  selectedScenarioId?: string;
  onScenarioChange?: (id: string) => void;
}

const TEAM_OPTIONS = [8, 10, 12, 14] as const;
const ROSTER_KEYS = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'SF'] as const;
// Compact labels for the summary chips inside the Roster pill.
const ROSTER_SHORT: Record<(typeof ROSTER_KEYS)[number], string> = {
  QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', FLEX: 'FLX', SF: 'SF',
};

export function DraftPrepSettings({ settings, onChange, scenarios, presets, selectedScenarioId, onScenarioChange }: Props) {
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

  const scenarioActive = !!selectedScenarioId;
  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-secondary)', border: '1px solid var(--border)',
    borderRadius: 4, padding: '2px 4px', fontSize: 11,
    color: 'var(--text-primary)', fontFamily: 'inherit', width: 32, textAlign: 'center',
  };

  return (
    <div className="league-bar">
      <div className="league-bar-row">
        <span className="league-label">LEAGUE</span>

        <label className="league-pill" title="League size">
          Teams
          <select
            value={settings.numTeams}
            onChange={(e) => setField('numTeams', Number(e.target.value))}
          >
            {TEAM_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <span className="chev">▼</span>
        </label>

        <label className="league-pill" title="Your draft slot">
          Pick
          <input
            type="number"
            min={1}
            max={settings.numTeams}
            value={settings.pickSlot}
            onChange={(e) => {
              const v = Math.max(1, Math.min(settings.numTeams, Number(e.target.value) || 1));
              setField('pickSlot', v);
            }}
          />
        </label>

        <label className="league-pill" title="Draft order format">
          <select
            value={settings.draftType}
            onChange={(e) => setField('draftType', e.target.value as DraftPrepSettings['draftType'])}
          >
            <option value="snake">Snake</option>
            <option value="linear">Linear</option>
          </select>
          <span className="chev">▼</span>
        </label>

        <button
          className={`league-pill ${open ? 'active' : ''}`}
          onClick={() => setOpen((v) => !v)}
          title="Starting lineup slots — click to edit"
        >
          Roster
          {ROSTER_KEYS.filter((k) => settings.roster[k] > 0).map((k) => (
            <span key={k} className="roster-chip"><b>{ROSTER_SHORT[k]}</b>{settings.roster[k]}</span>
          ))}
          <span className="chev">{open ? '▲' : '▼'}</span>
        </button>

        {scenarios !== undefined && onScenarioChange && (
          <label className={`league-pill ${scenarioActive ? 'active' : ''}`}>
            Scenario
            <select
              value={selectedScenarioId ?? ''}
              onChange={(e) => onScenarioChange(e.target.value)}
              style={{ maxWidth: 150, textOverflow: 'ellipsis' }}
              title={
                (presets?.find((p) => p.id === selectedScenarioId)?.description)
                ?? (scenarios.length === 0 && !presets?.length
                  ? 'No saved scenarios yet — create one from the Projections tab, or pick a preset'
                  : 'Apply a projection preset or a saved scenario; every number on the page recomputes against its PPG')
              }
            >
              <option value="">Base</option>
              {!!presets?.length && (
                <optgroup label="Presets">
                  {presets.map((p) => (
                    <option key={p.id} value={p.id} title={p.description}>{p.name}</option>
                  ))}
                </optgroup>
              )}
              {scenarios.length > 0 && (
                <optgroup label="My scenarios">
                  {scenarios.map((s) => (
                    <option key={s.id} value={s.id}>{s.name || 'Untitled'}</option>
                  ))}
                </optgroup>
              )}
            </select>
            <span className="chev">▼</span>
          </label>
        )}
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
