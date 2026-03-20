import { useState, useRef, useEffect, useCallback } from 'react';
import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, ContentBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { NFL_TOOLS, executeTool } from '../tools';

// ── Display messages (what the user sees) ──

interface DisplayMessage {
  role: 'user' | 'assistant' | 'tool-status';
  content: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  systemPrompt: string;
}

const API_KEY_STORAGE = 'stathead_anthropic_key';
const MAX_TOOL_ROUNDS = 8; // safety limit

const SYSTEM_PROMPT = `You are StatHead, an expert NFL data analyst and fantasy football advisor.

You have access to tools that fetch real NFL data from nflverse, KeepTradeCut, Sleeper, ESPN, and FantasyPros.

IMPORTANT INSTRUCTIONS:
1. Always use tools to fetch data before answering. Never make up stats or rely on assumptions.
2. You can call multiple tools in sequence to cross-reference data from different sources.
3. When comparing players, fetch stats for all of them.
4. Cite specific numbers from the data in your responses.
5. For fantasy questions, consider both standard and PPR scoring unless the user specifies.
6. Be concise but thorough. Use markdown tables and bold for key findings.
7. If the user asks about a current/recent season and you're not sure which year, use the most recent season available.
8. For dynasty questions, use the get_dynasty_values tool to get current KTC values.
9. For waiver/trending analysis, use get_sleeper_trending.
10. Available seasons for stats: 2015-2025. Combine/draft go back further.
11. For Next Gen Stats (separation, CPOE, rush yards over expected), use get_next_gen_stats (2016+).
12. For salary/contract analysis, use get_contracts.
13. For depth chart / starter-backup info, use get_depth_charts.
14. For play-level charting (play-action, RPO, motion, drops, blitz), use get_ftn_charting (2022+).
15. For NFL trades (players + draft picks), use get_trades.
16. For player biographical info (height, weight, college, experience), use get_rosters.

When you cannot find data for what the user asked, explain what data is available and suggest a related query.`;

export function ChatDrawer({ open, onClose, systemPrompt }: Props) {
  const [apiKey, setApiKey] = useState(
    () => localStorage.getItem(API_KEY_STORAGE) || ''
  );
  const [keyInput, setKeyInput] = useState(apiKey);
  // Display messages (simplified for rendering)
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([]);
  // Full API message history (includes tool_use and tool_result blocks)
  const apiMessagesRef = useRef<MessageParam[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [displayMessages]);

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  const saveKey = () => {
    localStorage.setItem(API_KEY_STORAGE, keyInput);
    setApiKey(keyInput);
    setError(null);
  };

  const clearKey = () => {
    localStorage.removeItem(API_KEY_STORAGE);
    setApiKey('');
    setKeyInput('');
  };

  const clearChat = () => {
    setDisplayMessages([]);
    apiMessagesRef.current = [];
    setError(null);
  };

  const sendMessage = useCallback(async () => {
    if (!input.trim() || streaming) return;

    const userText = input.trim();
    setInput('');
    setStreaming(true);
    setError(null);

    // Add user message to both display and API history
    setDisplayMessages((prev) => [...prev, { role: 'user', content: userText }]);
    apiMessagesRef.current = [
      ...apiMessagesRef.current,
      { role: 'user', content: userText },
    ];

    try {
      const client = new Anthropic({
        apiKey,
        dangerouslyAllowBrowser: true,
      });

      // Agentic tool-use loop
      let rounds = 0;
      while (rounds < MAX_TOOL_ROUNDS) {
        rounds++;

        // Add assistant placeholder
        setDisplayMessages((prev) => [
          ...prev,
          { role: 'assistant', content: '' },
        ]);

        // Stream the response
        const stream = await client.messages.stream({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: `${SYSTEM_PROMPT}\n\n${systemPrompt}`,
          messages: apiMessagesRef.current,
          tools: NFL_TOOLS,
        });

        let fullText = '';
        const toolUses: { id: string; name: string; input: Record<string, unknown> }[] = [];

        for await (const event of stream) {
          if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta'
          ) {
            fullText += event.delta.text;
            const currentText = fullText;
            setDisplayMessages((prev) => {
              const updated = [...prev];
              const lastIdx = updated.length - 1;
              if (updated[lastIdx]?.role === 'assistant') {
                updated[lastIdx] = { role: 'assistant', content: currentText };
              }
              return updated;
            });
          }
        }

        // Collect tool uses from the final message
        const finalMessage = await stream.finalMessage();
        for (const block of finalMessage.content) {
          if (block.type === 'tool_use') {
            toolUses.push({
              id: block.id,
              name: block.name,
              input: block.input as Record<string, unknown>,
            });
          }
        }

        // Update display with final text (remove empty assistant if no text)
        if (!fullText && toolUses.length > 0) {
          setDisplayMessages((prev) => {
            const updated = [...prev];
            if (updated[updated.length - 1]?.role === 'assistant' && !updated[updated.length - 1].content) {
              updated.pop();
            }
            return updated;
          });
        }

        // Add the full assistant response to API history
        apiMessagesRef.current = [
          ...apiMessagesRef.current,
          { role: 'assistant', content: finalMessage.content as ContentBlockParam[] },
        ];

        // If no tool uses, we're done
        if (finalMessage.stop_reason !== 'tool_use' || toolUses.length === 0) {
          break;
        }

        // Execute tools and send results back
        const toolResults: ContentBlockParam[] = [];

        for (const tool of toolUses) {
          // Show tool status
          const toolLabel = formatToolLabel(tool.name, tool.input);
          setDisplayMessages((prev) => [
            ...prev,
            { role: 'tool-status', content: toolLabel },
          ]);

          const result = await executeTool(tool.name, tool.input);
          result.tool_use_id = tool.id;
          toolResults.push(result as ContentBlockParam);

          // Update status to done
          setDisplayMessages((prev) => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            if (updated[lastIdx]?.role === 'tool-status') {
              updated[lastIdx] = { role: 'tool-status', content: `${toolLabel} Done` };
            }
            return updated;
          });
        }

        // Add tool results to API history
        apiMessagesRef.current = [
          ...apiMessagesRef.current,
          { role: 'user', content: toolResults },
        ];
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to get response';
      setError(msg);
    } finally {
      setStreaming(false);
    }
  }, [input, streaming, apiKey, systemPrompt]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  if (!open) return null;

  return (
    <div className="chat-overlay" onClick={onClose}>
      <div className="chat-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="chat-header">
          <div className="chat-title">
            <span className="chat-icon">C</span>
            StatHead AI
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {displayMessages.length > 0 && (
              <button
                className="chat-close"
                onClick={clearChat}
                title="Clear chat"
                style={{ fontSize: 14 }}
              >
                Clear
              </button>
            )}
            <button className="chat-close" onClick={onClose}>
              x
            </button>
          </div>
        </div>

        {!apiKey ? (
          <div className="chat-key-setup">
            <h3>Connect your Anthropic API key</h3>
            <p>
              Your key is stored locally in your browser and sent directly to
              Anthropic's API. It never touches any other server.
            </p>
            <input
              type="password"
              placeholder="sk-ant-..."
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveKey()}
              style={{ width: '100%' }}
            />
            <button className="format-tab active" onClick={saveKey}>
              Save Key
            </button>
          </div>
        ) : (
          <>
            <div className="chat-messages">
              {displayMessages.length === 0 && (
                <div className="chat-empty">
                  <p>
                    Ask any question about NFL data and fantasy football. I'll
                    pull real data from nflverse, KeepTradeCut, Sleeper, ESPN,
                    and FantasyPros to answer.
                  </p>
                  <div className="chat-suggestions">
                    <button
                      className="chat-suggestion"
                      onClick={() => setInput('Who were the top 10 PPR running backs in 2024?')}
                    >
                      Top PPR RBs in 2024?
                    </button>
                    <button
                      className="chat-suggestion"
                      onClick={() => setInput('Compare Ja\'Marr Chase and CeeDee Lamb\'s 2024 seasons')}
                    >
                      Chase vs Lamb 2024?
                    </button>
                    <button
                      className="chat-suggestion"
                      onClick={() => setInput('Which rookie RBs from the last 3 drafts have the best dynasty value right now?')}
                    >
                      Best rookie RB dynasty values?
                    </button>
                    <button
                      className="chat-suggestion"
                      onClick={() => setInput('Who are the most added players on Sleeper right now?')}
                    >
                      Sleeper trending adds?
                    </button>
                  </div>
                </div>
              )}
              {displayMessages.map((msg, i) => {
                if (msg.role === 'tool-status') {
                  return (
                    <div key={i} className="chat-tool-status">
                      <span className="chat-tool-icon">
                        {msg.content.endsWith('Done') ? '\u2714' : '\u21BB'}
                      </span>
                      {msg.content}
                    </div>
                  );
                }
                return (
                  <div key={i} className={`chat-msg chat-msg-${msg.role}`}>
                    <div className="chat-msg-label">
                      {msg.role === 'user' ? 'You' : 'StatHead'}
                    </div>
                    <div className="chat-msg-content">
                      {msg.role === 'assistant' ? (
                        <MarkdownContent content={msg.content} />
                      ) : (
                        msg.content
                      )}
                      {msg.role === 'assistant' &&
                        streaming &&
                        i === displayMessages.length - 1 && (
                          <span className="chat-cursor" />
                        )}
                    </div>
                  </div>
                );
              })}
              {error && <div className="chat-error">{error}</div>}
              <div ref={messagesEndRef} />
            </div>

            <div className="chat-input-area">
              <textarea
                ref={inputRef}
                className="chat-input"
                placeholder="Ask about NFL data, fantasy rankings, player stats..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={2}
                disabled={streaming}
              />
              <button
                className="chat-send"
                onClick={sendMessage}
                disabled={!input.trim() || streaming}
              >
                {streaming ? '...' : '\u2191'}
              </button>
            </div>
            <button className="chat-key-change" onClick={clearKey}>
              Change API key
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Helpers ──

function formatToolLabel(name: string, input: Record<string, unknown>): string {
  const labels: Record<string, string> = {
    get_player_season_stats: 'Fetching player stats',
    get_player_weekly_stats: 'Fetching weekly game log',
    get_games: 'Fetching game results',
    get_snap_counts: 'Fetching snap counts',
    get_combine_results: 'Fetching combine data',
    get_draft_picks: 'Fetching draft picks',
    get_injuries: 'Fetching injury reports',
    get_advanced_stats: 'Fetching advanced stats',
    get_play_by_play: 'Fetching play-by-play',
    get_fantasy_rankings: 'Fetching fantasy rankings',
    get_adp: 'Fetching ADP data',
    get_sleeper_trending: 'Fetching Sleeper trending',
    get_sleeper_projections: 'Fetching Sleeper projections',
    get_dynasty_values: 'Fetching dynasty values',
    get_next_gen_stats: 'Fetching Next Gen Stats',
    get_rosters: 'Fetching roster data',
    get_contracts: 'Fetching contract data',
    get_depth_charts: 'Fetching depth charts',
    get_ftn_charting: 'Fetching FTN charting data',
    get_trades: 'Fetching trade history',
  };

  let label = labels[name] || `Running ${name}`;

  // Add relevant context
  if (input.season) label += ` (${input.season})`;
  if (input.player_name) label += ` for ${input.player_name}`;
  if (input.position && input.position !== 'ALL') label += ` [${input.position}]`;
  if (input.team) label += ` [${input.team}]`;

  return label + '...';
}

/** Simple markdown renderer for Claude responses */
function MarkdownContent({ content }: { content: string }) {
  if (!content) return null;

  // Lightweight markdown: bold, headers, lists, code, tables
  const html = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Headers
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    // Bold and italic
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Lists
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>')
    // Tables — detect markdown table blocks and convert
    .replace(
      /(?:^|\n)((?:\|[^\n]+\|\n)+)/g,
      (_match: string, tableBlock: string) => {
        const rows = tableBlock.trim().split('\n');
        if (rows.length < 2) return tableBlock;

        // Skip separator row (|---|---|)
        const dataRows = rows.filter((r: string) => !r.match(/^\|[\s-:|]+\|$/));
        const htmlRows = dataRows.map((row: string, idx: number) => {
          const cells = row.split('|').filter((c: string) => c.trim() !== '');
          const tag = idx === 0 ? 'th' : 'td';
          const cellsHtml = cells.map((c: string) => `<${tag}>${c.trim()}</${tag}>`).join('');
          return `<tr>${cellsHtml}</tr>`;
        }).join('');

        return `<div class="chat-table-wrap"><table>${htmlRows}</table></div>`;
      }
    )
    // Paragraphs
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br/>');

  return (
    <div
      className="chat-markdown"
      dangerouslySetInnerHTML={{ __html: `<p>${html}</p>` }}
    />
  );
}
