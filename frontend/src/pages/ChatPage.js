import React, { useRef, useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import { useAuth } from "../context/AuthContext";
import { useAppState } from "../context/AppStateContext";
import { sendChatMessage, saveMemory } from "../api";
import { MemoryBankSidebar } from "../components/MemoryBankSidebar";

const QUICK_PROMPTS = [
  "What can you remember?",
  "Tell me about yourself",
  "How does your memory work?",
];

/**
 * Chat — same surface as the workspace: a fixed left rail, a centred column for
 * the conversation, and the composer pinned at the bottom.
 */
export default function ChatPage() {
  const { token } = useAuth();
  const { state, setChatMessages, setChatInput } = useAppState();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const listRef = useRef(null);

  const messages = useMemo(() => state.chatMessages || [], [state.chatMessages]);
  const input = useMemo(() => state.chatInput || "", [state.chatInput]);

  // Auto-scroll to bottom when messages update
  useEffect(() => {
    if (listRef.current) {
      setTimeout(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
      }, 100);
    }
  }, [messages]);

  // Persist chat messages to backend whenever they change
  useEffect(() => {
    if (messages.length > 0 && token) {
      const userMessages = messages.filter((m) => m.role === "user").map((m) => m.content);
      if (userMessages.length > 0) {
        saveMemory(token, { conversations: userMessages }).catch((err) => {
          console.warn("Failed to save memory:", err);
        });
      }
    }
  }, [messages, token]);

  const send = async (text) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const userMsg = { role: "user", content: trimmed };
    const nextHistory = [...messages, userMsg];
    setChatMessages(nextHistory);
    setChatInput("");
    setLoading(true);

    try {
      const history = messages.map(({ role, content }) => ({ role, content }));
      const { reply } = await sendChatMessage(token, trimmed, history);
      setChatMessages([...nextHistory, { role: "assistant", content: reply }]);
    } catch (err) {
      setChatMessages([
        ...nextHistory,
        { role: "assistant", content: `Sorry — ${err.message || "something went wrong"}.` },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const hasChat = messages.length > 0;

  return (
    <div className="k-chat k-surface">
      <MemoryBankSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <aside className="k-side">
        <div className="k-side-top">
          <button
            type="button"
            className="k-side-back"
            onClick={() => setSidebarOpen(true)}
            title="Memory bank"
            aria-label="Open memory bank"
          >
            ☰
          </button>
          <span className="k-side-brand">Zen</span>
        </div>

        <div className="k-side-group">
          <div className="k-group-label">
            <span>Workspace</span>
          </div>
          <Link to="/graph" className="k-nav">
            <span className="k-nav-mark">◉</span>
            <span>Memory graph</span>
          </Link>
          <Link to="/workspace" className="k-nav">
            <span className="k-nav-mark">◫</span>
            <span>Debug workspace</span>
          </Link>
        </div>

        <div className="k-side-group k-side-files">
          <div className="k-group-label">
            <span>Chats</span>
          </div>
          <p className="k-side-note">Your current conversation.</p>
        </div>
      </aside>

      <div className="k-chat-main">
        <div className="k-chat-scroll" ref={listRef}>
          <div className="k-chat-inner">
            {!hasChat && (
              <div className="k-hero">
                <h1 className="k-hero-title">What can I help you with?</h1>
                <p className="k-hero-sub">
                  A self-learning assistant. I remember what matters across conversations.
                </p>
              </div>
            )}

            {hasChat && (
              <div className="k-msg-list">
                {messages.map((m, i) => (
                  <div key={i} className={`k-msg-row k-msg-row--${m.role}`}>
                    {m.role === "assistant" && (
                      <span className="k-avatar" aria-hidden="true">
                        Z
                      </span>
                    )}
                    <article className={`k-msg k-msg--${m.role}`}>
                      <div className="k-msg-body">
                        {m.role === "assistant" ? (
                          <ReactMarkdown>{m.content}</ReactMarkdown>
                        ) : (
                          <p>{m.content}</p>
                        )}
                      </div>
                    </article>
                  </div>
                ))}
                {loading && (
                  <div className="k-msg-row k-msg-row--assistant">
                    <span className="k-avatar" aria-hidden="true">
                      Z
                    </span>
                    <article className="k-msg k-msg--assistant">
                      <div className="k-typing">
                        <span />
                        <span />
                        <span />
                      </div>
                    </article>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="k-composer-wrap">
          <div className="k-composer-inner">
            <form
              className="k-composer"
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
            >
              <input
                type="text"
                placeholder="Message Zen…"
                value={input}
                onChange={(e) => setChatInput(e.target.value)}
                disabled={loading}
              />
              <button type="submit" disabled={loading || !input.trim()} aria-label="Send">
                ↑
              </button>
            </form>

            {!hasChat && (
              <div className="k-quick">
                {QUICK_PROMPTS.map((q) => (
                  <button key={q} type="button" onClick={() => send(q)}>
                    {q}
                  </button>
                ))}
              </div>
            )}

            <p className="k-composer-note">Zen learns from every conversation via mem0 memory</p>
          </div>
        </div>
      </div>
    </div>
  );
}
