import { useState, useRef, useEffect, useCallback } from 'react';
import Anthropic from '@anthropic-ai/sdk';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  dataContext: string;
}

const API_KEY_STORAGE = 'stathead_anthropic_key';

export function ChatDrawer({ open, onClose, dataContext }: Props) {
  const [apiKey, setApiKey] = useState(
    () => localStorage.getItem(API_KEY_STORAGE) || ''
  );
  const [keyInput, setKeyInput] = useState(apiKey);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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

  const sendMessage = useCallback(async () => {
    if (!input.trim() || streaming) return;

    const userMsg: Message = { role: 'user', content: input.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setStreaming(true);
    setError(null);

    try {
      const client = new Anthropic({
        apiKey,
        dangerouslyAllowBrowser: true,
      });

      // Build conversation for API
      const apiMessages = newMessages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

      // Add assistant placeholder
      setMessages([...newMessages, { role: 'assistant', content: '' }]);

      const stream = await client.messages.stream({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: dataContext,
        messages: apiMessages,
      });

      let fullText = '';
      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          fullText += event.delta.text;
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              role: 'assistant',
              content: fullText,
            };
            return updated;
          });
        }
      }
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Failed to get response';
      setError(msg);
      // Remove empty assistant message on error
      setMessages(newMessages);
    } finally {
      setStreaming(false);
    }
  }, [input, messages, streaming, apiKey, dataContext]);

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
            Ask Claude
          </div>
          <button className="chat-close" onClick={onClose}>
            x
          </button>
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
              {messages.length === 0 && (
                <div className="chat-empty">
                  <p>
                    Ask questions about the data you're viewing. Claude can see
                    the current tab's data and help with analysis.
                  </p>
                  <div className="chat-suggestions">
                    <button
                      className="chat-suggestion"
                      onClick={() => {
                        setInput(
                          'Who are the top 5 value picks in fantasy this season and why?'
                        );
                      }}
                    >
                      Top fantasy value picks?
                    </button>
                    <button
                      className="chat-suggestion"
                      onClick={() => {
                        setInput(
                          'Which players had the biggest difference between standard and PPR scoring?'
                        );
                      }}
                    >
                      Standard vs PPR differences?
                    </button>
                    <button
                      className="chat-suggestion"
                      onClick={() => {
                        setInput(
                          'Analyze the top QBs by efficiency - who is overrated and underrated?'
                        );
                      }}
                    >
                      QB efficiency analysis?
                    </button>
                  </div>
                </div>
              )}
              {messages.map((msg, i) => (
                <div key={i} className={`chat-msg chat-msg-${msg.role}`}>
                  <div className="chat-msg-label">
                    {msg.role === 'user' ? 'You' : 'Claude'}
                  </div>
                  <div className="chat-msg-content">
                    {msg.role === 'assistant' ? (
                      <MarkdownContent content={msg.content} />
                    ) : (
                      msg.content
                    )}
                    {msg.role === 'assistant' &&
                      streaming &&
                      i === messages.length - 1 && (
                        <span className="chat-cursor" />
                      )}
                  </div>
                </div>
              ))}
              {error && <div className="chat-error">{error}</div>}
              <div ref={messagesEndRef} />
            </div>

            <div className="chat-input-area">
              <textarea
                ref={inputRef}
                className="chat-input"
                placeholder="Ask about the data..."
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

/** Simple markdown renderer for Claude responses */
function MarkdownContent({ content }: { content: string }) {
  if (!content) return null;

  // Very lightweight markdown: bold, headers, lists, code
  const html = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br/>');

  return (
    <div
      className="chat-markdown"
      dangerouslySetInnerHTML={{ __html: `<p>${html}</p>` }}
    />
  );
}
