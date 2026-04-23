import { useState, useEffect, useRef, useCallback } from 'react';
import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { ASK_DATA_TOOLS, buildAskDataSystemPrompt, executeAskTool, toToolResult } from '../lib/askData';

// ChatDrawer uses this same storage key — sharing the key across surfaces is
// intentional so users only paste it once.
const API_KEY_STORAGE = 'stathead_anthropic_key';
const MODEL_STORAGE = 'stathead-ask-data-model';
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TURNS = 8;

type Msg =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string }
  | { role: 'tool'; label: string; sql?: string; resultPreview?: string; error?: string };

interface Props {
  /** When true, component is visible — used to know when to focus the input. */
  active: boolean;
  /** Optional callback: user clicks "Use in SQL" on a tool row. */
  onUseSql?: (sql: string) => void;
}

export function AskData({ active, onUseSql }: Props) {
  const [apiKey, setApiKey] = useState<string>(() => {
    try { return localStorage.getItem(API_KEY_STORAGE) || ''; } catch { return ''; }
  });
  const [keyInput, setKeyInput] = useState(apiKey);
  const [model, setModel] = useState<string>(() => {
    try { return localStorage.getItem(MODEL_STORAGE) || DEFAULT_MODEL; } catch { return DEFAULT_MODEL; }
  });
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Msg[]>([]);
  const apiHistoryRef = useRef<MessageParam[]>([]);
  const systemPromptRef = useRef<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (active && apiKey) inputRef.current?.focus();
  }, [active, apiKey]);

  useEffect(() => {
    try { localStorage.setItem(MODEL_STORAGE, model); } catch {}
  }, [model]);

  const saveKey = () => {
    try { localStorage.setItem(API_KEY_STORAGE, keyInput); } catch {}
    setApiKey(keyInput);
    setError(null);
  };
  const clearKey = () => {
    try { localStorage.removeItem(API_KEY_STORAGE); } catch {}
    setApiKey('');
    setKeyInput('');
  };
  const clearChat = () => {
    setMessages([]);
    apiHistoryRef.current = [];
    setError(null);
  };

  const send = useCallback(async () => {
    if (!input.trim() || streaming || !apiKey) return;
    const question = input.trim();
    setInput('');
    setStreaming(true);
    setError(null);
    setMessages((m) => [...m, { role: 'user', text: question }]);
    apiHistoryRef.current = [
      ...apiHistoryRef.current,
      { role: 'user', content: question },
    ];

    try {
      if (!systemPromptRef.current) {
        systemPromptRef.current = await buildAskDataSystemPrompt();
      }
      const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

      for (let turn = 0; turn < MAX_TURNS; turn++) {
        // Streaming assistant text — show as it arrives
        setMessages((m) => [...m, { role: 'assistant', text: '' }]);

        const stream = await client.messages.stream({
          model,
          max_tokens: 4096,
          system: systemPromptRef.current,
          messages: apiHistoryRef.current,
          tools: ASK_DATA_TOOLS,
        });

        let liveText = '';
        for await (const ev of stream) {
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            liveText += ev.delta.text;
            setMessages((m) => {
              const u = [...m];
              const last = u[u.length - 1];
              if (last?.role === 'assistant') u[u.length - 1] = { role: 'assistant', text: liveText };
              return u;
            });
          }
        }

        const final = await stream.finalMessage();
        // Remove the streaming bubble if no text came out (tool-only turn)
        if (!liveText) {
          setMessages((m) => {
            const u = [...m];
            if (u[u.length - 1]?.role === 'assistant' && !(u[u.length - 1] as { text: string }).text) u.pop();
            return u;
          });
        }

        apiHistoryRef.current = [
          ...apiHistoryRef.current,
          { role: 'assistant', content: final.content as ContentBlockParam[] },
        ];

        const toolUses = final.content.filter((b) => b.type === 'tool_use') as Array<{
          id: string; name: string; input: Record<string, unknown>;
        }>;
        if (final.stop_reason !== 'tool_use' || toolUses.length === 0) break;

        const toolResults: ContentBlockParam[] = [];
        for (const tu of toolUses) {
          const sql = tu.name === 'run_sql' ? String(tu.input?.sql ?? '') : undefined;
          setMessages((m) => [
            ...m,
            { role: 'tool', label: tu.name, sql, resultPreview: 'Running...' },
          ]);
          const result = await executeAskTool(tu.name, tu.input);
          toolResults.push(toToolResult(tu.id, result));
          setMessages((m) => {
            const u = [...m];
            const last = u[u.length - 1];
            if (last?.role === 'tool') {
              u[u.length - 1] = {
                role: 'tool',
                label: tu.name,
                sql,
                resultPreview: result.is_error ? undefined : summarizeResult(result.content),
                error: result.is_error ? result.content : undefined,
              };
            }
            return u;
          });
        }
        apiHistoryRef.current = [
          ...apiHistoryRef.current,
          { role: 'user', content: toolResults },
        ];
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStreaming(false);
    }
  }, [input, streaming, apiKey, model]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // ── Render ──

  if (!apiKey) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 10,
        padding: 16, background: 'var(--bg-secondary)',
        border: '1px solid var(--border)', borderRadius: 8, maxWidth: 520, margin: '24px auto',
      }}>
        <h3 style={{ fontSize: 15, margin: 0, color: 'var(--text-primary)' }}>Connect your Anthropic API key</h3>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
          The key is stored in your browser (localStorage) and sent directly from your browser to Anthropic's API.
          StatHead servers never see it. You'll be billed per query on your own Anthropic account. <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" style={{ color: '#6366f1' }}>Get a key →</a>
        </p>
        <input
          type="password"
          placeholder="sk-ant-..."
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          style={{
            padding: '8px 10px', fontSize: 12, fontFamily: 'ui-monospace, monospace',
            background: 'var(--bg-primary)', color: 'var(--text-primary)',
            border: '1px solid var(--border)', borderRadius: 4,
          }}
        />
        <button
          onClick={saveKey}
          disabled={!keyInput.trim()}
          style={{
            padding: '8px 14px', fontSize: 13, fontWeight: 700,
            background: keyInput.trim() ? '#6366f1' : 'var(--bg-tertiary)',
            color: '#fff', border: 'none', borderRadius: 4,
            cursor: keyInput.trim() ? 'pointer' : 'not-allowed',
          }}
        >
          Save key
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
      {/* Status bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, fontSize: 11,
        color: 'var(--text-muted)', flexWrap: 'wrap',
      }}>
        <span>Model:</span>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          style={{
            padding: '3px 6px', fontSize: 11, background: 'var(--bg-secondary)',
            color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 4,
          }}
        >
          <option value="claude-opus-4-7">Opus 4.7 (strongest)</option>
          <option value="claude-sonnet-4-6-20250514">Sonnet 4.6</option>
          <option value="claude-sonnet-4-5-20250929">Sonnet 4.5 (default)</option>
          <option value="claude-haiku-4-5-20251001">Haiku 4.5 (cheapest)</option>
        </select>
        <span>·</span>
        <button
          onClick={clearKey}
          style={{
            padding: '3px 8px', fontSize: 11, background: 'transparent',
            color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
          }}
        >
          Clear key
        </button>
        {messages.length > 0 && (
          <button
            onClick={clearChat}
            style={{
              padding: '3px 8px', fontSize: 11, background: 'transparent',
              color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
            }}
          >
            Clear chat
          </button>
        )}
      </div>

      {/* Messages */}
      <div style={{
        flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8,
        padding: 12, border: '1px solid var(--border)', borderRadius: 6,
        background: 'var(--bg-secondary)', minHeight: 280, maxHeight: '55vh',
      }}>
        {messages.length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontSize: 12, fontStyle: 'italic' }}>
            Ask a question about the data — "Which 2026 WRs have the best boom z-scores?", "How often do top-10 ADP RBs bust?", "Show me Puka Nacua's weekly PPR trend."
          </div>
        )}
        {messages.map((m, i) => (
          <MessageRow key={i} m={m} onUseSql={onUseSql} />
        ))}
        {error && (
          <div style={{
            background: 'rgba(239,68,68,0.1)', border: '1px solid #ef4444',
            color: '#ef4444', padding: 10, borderRadius: 6, fontSize: 12,
            fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre-wrap',
          }}>
            {error}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{ display: 'flex', gap: 8 }}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder="Ask a question about NFL data, ADP, prospects, dynasty values..."
          rows={2}
          disabled={streaming}
          style={{
            flex: 1, padding: 10, fontSize: 13, fontFamily: 'inherit',
            background: 'var(--bg-secondary)', color: 'var(--text-primary)',
            border: '1px solid var(--border)', borderRadius: 6, resize: 'vertical',
          }}
        />
        <button
          onClick={send}
          disabled={streaming || !input.trim()}
          style={{
            padding: '10px 16px', fontSize: 13, fontWeight: 700,
            background: streaming || !input.trim() ? 'var(--bg-tertiary)' : '#6366f1',
            color: '#fff', border: 'none', borderRadius: 6,
            cursor: streaming || !input.trim() ? 'not-allowed' : 'pointer',
            whiteSpace: 'nowrap', alignSelf: 'stretch',
          }}
        >
          {streaming ? 'Thinking…' : 'Send ↵'}
        </button>
      </div>
    </div>
  );
}

function MessageRow({ m, onUseSql }: { m: Msg; onUseSql?: (sql: string) => void }) {
  if (m.role === 'user') {
    return (
      <div style={{ alignSelf: 'flex-end', maxWidth: '80%' }}>
        <div style={{
          background: '#6366f1', color: '#fff', padding: '8px 12px',
          borderRadius: 10, fontSize: 13, whiteSpace: 'pre-wrap',
        }}>
          {m.text}
        </div>
      </div>
    );
  }
  if (m.role === 'assistant') {
    return (
      <div style={{ alignSelf: 'flex-start', maxWidth: '92%' }}>
        <div style={{
          background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
          padding: '8px 12px', borderRadius: 10, fontSize: 13, whiteSpace: 'pre-wrap',
          lineHeight: 1.5,
        }}>
          {m.text || <em style={{ color: 'var(--text-muted)' }}>…</em>}
        </div>
      </div>
    );
  }
  // tool call
  return (
    <div style={{
      border: '1px dashed var(--border)', borderRadius: 6, padding: 8,
      fontSize: 11, background: 'var(--bg-tertiary)',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, marginBottom: m.sql ? 4 : 0,
        color: m.error ? '#ef4444' : 'var(--text-muted)',
      }}>
        <strong>{m.label}</strong>
        {m.resultPreview && !m.error && <span style={{ color: 'var(--text-muted)' }}>→ {m.resultPreview}</span>}
        {m.error && <span>→ error</span>}
        {m.sql && onUseSql && (
          <button
            onClick={() => onUseSql(m.sql!)}
            title="Load this SQL into the editor above"
            style={{
              marginLeft: 'auto', padding: '2px 6px', fontSize: 10,
              background: 'transparent', color: 'var(--text-secondary)',
              border: '1px solid var(--border)', borderRadius: 3, cursor: 'pointer',
            }}
          >
            Use in SQL
          </button>
        )}
      </div>
      {m.sql && (
        <pre style={{
          margin: 0, padding: '6px 8px', background: 'var(--bg-primary)',
          border: '1px solid var(--border)', borderRadius: 4,
          fontFamily: 'ui-monospace, monospace', fontSize: 11,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text-secondary)',
        }}>{m.sql}</pre>
      )}
      {m.error && (
        <div style={{ marginTop: 4, color: '#ef4444', fontFamily: 'ui-monospace, monospace' }}>
          {m.error}
        </div>
      )}
    </div>
  );
}

/** Turn the serialized tool_result content into a short status line:
 *  "columns: x, y, z · 42 rows · 12 ms". */
function summarizeResult(content: string): string {
  const cols = content.match(/^columns:\s*(.*)$/m)?.[1] ?? '';
  const rows = content.match(/^row_count:\s*(.*)$/m)?.[1] ?? '';
  const ms = content.match(/^elapsed_ms:\s*(.*)$/m)?.[1] ?? '';
  const colPreview = cols.length > 50 ? `${cols.slice(0, 47)}…` : cols;
  return `${rows} rows · [${colPreview}] · ${ms} ms`;
}
