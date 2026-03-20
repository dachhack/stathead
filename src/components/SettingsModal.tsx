import { useState, useEffect } from 'react';
import { loadApiKeys, saveApiKeys } from '../lib/apiKeys';

interface Props {
  open: boolean;
  onClose: () => void;
  onKeysChanged: () => void;
}

export function SettingsModal({ open, onClose, onKeysChanged }: Props) {
  const [sdioKey, setSdioKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (open) {
      const keys = loadApiKeys();
      setSdioKey(keys.sportsDataIO || '');
      setShowKey(false);
      setSaved(false);
    }
  }, [open]);

  if (!open) return null;

  const handleSave = () => {
    saveApiKeys({ sportsDataIO: sdioKey.trim() || undefined });
    setSaved(true);
    onKeysChanged();
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="chat-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="settings-body">
          <div className="settings-section">
            <h3>API Keys</h3>
            <p className="settings-desc">
              Add your API keys to unlock premium data sources. Keys are stored
              locally in your browser and never sent to our servers.
            </p>

            <div className="settings-field">
              <label className="settings-label">
                SportsDataIO
                <span className="settings-badge">Projections, DFS, Odds, News</span>
              </label>
              <div className="settings-input-row">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={sdioKey}
                  onChange={(e) => setSdioKey(e.target.value)}
                  placeholder="Enter your Ocp-Apim-Subscription-Key"
                  className="settings-key-input"
                />
                <button
                  className="settings-toggle-btn"
                  onClick={() => setShowKey(!showKey)}
                  title={showKey ? 'Hide key' : 'Show key'}
                >
                  {showKey ? 'Hide' : 'Show'}
                </button>
              </div>
              <p className="settings-hint">
                Get a free trial key at{' '}
                <a
                  href="https://sportsdata.io/free-trial"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  sportsdata.io/free-trial
                </a>{' '}
                (no credit card required). Note: free trial data is scrambled.
                Real data requires a paid plan.
              </p>
            </div>
          </div>

          <div className="settings-actions">
            <button className="settings-save-btn" onClick={handleSave}>
              {saved ? 'Saved!' : 'Save'}
            </button>
            <button className="settings-cancel-btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
