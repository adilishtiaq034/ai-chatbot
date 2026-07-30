import { useState, useRef, useEffect, useCallback } from 'react';
import './App.css';

const SpeechRecognitionAPI =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

// Ordered fallback chain of verified-free OpenRouter models. "openrouter/free"
// is NOT a real model id — it let OpenRouter auto-route to whatever free
// model was available, which sometimes landed on a reasoning model that put
// its internal chain-of-thought directly into `message.content`. Pinning to
// specific ids avoids that, and trying several in sequence means one model
// being rate-limited or temporarily down doesn't take the whole app down.
const CHAT_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'google/gemma-4-31b-it:free',
  'openai/gpt-oss-20b:free',
];

// Calls OpenRouter, trying each model in CHAT_MODELS in turn until one
// succeeds. Stops immediately (no point trying other models) if the key
// itself is rejected — that's an account-level problem, not a model-level
// one, and switching models can't fix it.
async function callOpenRouter(messages, maxTokens) {
  let lastError = null;

  for (const model of CHAT_MODELS) {
    try {
      const response = await fetch(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${import.meta.env.VITE_OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : 'http://localhost',
            'X-Title': 'Chat Adil',
          },
          body: JSON.stringify({ model, max_tokens: maxTokens, messages }),
        }
      );

      if (response.status === 401 || response.status === 403) {
        // Auth-level failure: the API key is missing, invalid, or expired.
        // No fallback model will fix this, so fail fast with a clear message.
        console.error(
          `OpenRouter auth error (${response.status}). Check that VITE_OPENROUTER_API_KEY is set and valid — this is not a model availability issue.`
        );
        throw new Error('auth');
      }

      if (!response.ok) {
        // Likely rate-limited (429), model temporarily unavailable (404/503),
        // etc. Log it and move on to the next model in the chain.
        console.warn(`Model ${model} failed with status ${response.status}, trying next fallback...`);
        lastError = new Error(`Request failed with status ${response.status}`);
        continue;
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        console.warn(`Model ${model} returned no content, trying next fallback...`);
        lastError = new Error('No AI response');
        continue;
      }

      return content;
    } catch (err) {
      if (err.message === 'auth') throw err;
      console.warn(`Model ${model} threw an error, trying next fallback...`, err);
      lastError = err;
    }
  }

  throw lastError || new Error('All models failed');
}

function createThread() {
  return {
    id: crypto.randomUUID(),
    title: 'Untitled chat',
    messages: [],
    createdAt: Date.now(),
  };
}

function loadInitialThreads() {
  try {
    const saved = localStorage.getItem('chatThreads');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
    const legacy = localStorage.getItem('messages');
    if (legacy) {
      const legacyMessages = JSON.parse(legacy);
      if (Array.isArray(legacyMessages) && legacyMessages.length > 0) {
        const thread = createThread();
        thread.messages = legacyMessages;
        thread.title = legacyMessages.find((m) => m.sender === 'User')?.text.slice(0, 32) || 'Untitled chat';
        return [thread];
      }
    }
  } catch {
    // fall through to default
  }
  return [createThread()];
}

function App() {
  const [message, setMessage] = useState('');
  const [threads, setThreads] = useState(loadInitialThreads);
  const [activeThreadId, setActiveThreadId] = useState(() => threads[0]?.id);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [speakingId, setSpeakingId] = useState(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const recognitionRef = useRef(null);

  const activeThread = threads.find((t) => t.id === activeThreadId) || threads[0];
  const activeMessages = activeThread?.messages ?? [];

  function updateActiveThreadMessages(updater) {
    setThreads((prev) =>
      prev.map((t) =>
        t.id === activeThreadId ? { ...t, messages: updater(t.messages) } : t
      )
    );
  }

  function updateThreadMessages(threadId, updater) {
    setThreads((prev) =>
      prev.map((t) =>
        t.id === threadId ? { ...t, messages: updater(t.messages) } : t
      )
    );
  }

  function setThreadTitle(threadId, title) {
    setThreads((prev) =>
      prev.map((t) => (t.id === threadId ? { ...t, title } : t))
    );
  }

  // Only auto-close the sidebar on mobile widths — on desktop it stays open
  // until the user explicitly toggles it via the hamburger button.
  function closeSidebarOnMobile() {
    if (typeof window !== 'undefined' && window.innerWidth <= 600) {
      setSidebarOpen(false);
    }
  }

  function handleNewChat() {
    // If we're already sitting on a fresh, empty thread, don't spawn another
    // one — just reset the composer and make sure we're on it.
    const isActiveEmpty =
      activeThread && activeThread.title === 'Untitled chat' && activeThread.messages.length === 0;

    if (isActiveEmpty) {
      setMessage('');
      stopSpeaking();
      closeSidebarOnMobile();
      return;
    }

    const thread = createThread();
    setThreads((prev) => [thread, ...prev]);
    setActiveThreadId(thread.id);
    setMessage('');
    stopSpeaking();
    closeSidebarOnMobile();
  }

  function handleSwitchThread(id) {
    setActiveThreadId(id);
    closeSidebarOnMobile();
    stopSpeaking();
  }

  function handleDeleteThread(id, e) {
    e.stopPropagation();
    setThreads((prev) => {
      const remaining = prev.filter((t) => t.id !== id);
      if (remaining.length === 0) {
        const fresh = createThread();
        setActiveThreadId(fresh.id);
        return [fresh];
      }
      if (id === activeThreadId) {
        setActiveThreadId(remaining[0].id);
      }
      return remaining;
    });
  }

  function handleSendMessage(overrideText) {
    const textToSend = (overrideText ?? message).trim();
    if (textToSend === '') return;

    const threadId = activeThreadId;
    const isFirstMessage = activeMessages.length === 0;

    updateActiveThreadMessages((msgs) => [
      ...msgs,
      { id: crypto.randomUUID(), text: textToSend, sender: 'User' },
    ]);

    setMessage('');
    getAIResponse(textToSend, threadId, isFirstMessage);
  }

  // Strips markdown AND any leaked reasoning/"thinking" blocks that some
  // reasoning models emit inline in `content` (e.g. <think>...</think>,
  // or a stray "reasoning" JSON field echoed as text). This is a defensive
  // safety net in case OpenRouter ever substitutes a reasoning model.
  function stripMarkdown(text) {
    return text
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
      .replace(/\[\d+\]/g, '')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/^\s*[*-]\s+/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function speakText(text, id) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.onstart = () => setSpeakingId(id);
    utterance.onend = () => setSpeakingId(null);
    utterance.onerror = () => setSpeakingId(null);
    window.speechSynthesis.speak(utterance);
  }

  function stopSpeaking() {
    window.speechSynthesis?.cancel();
    setSpeakingId(null);
  }

  const GREETING_WORDS = ['hi', 'hii', 'hiii', 'hey', 'heyy', 'hello', 'yo', 'sup', 'howdy', 'hola', 'salam'];
  const THANKS_WORDS = ['thanks', 'thank you', 'thx', 'ty', 'tysm'];
  const FAREWELL_WORDS = ['bye', 'goodbye', 'see ya', 'see you', 'later', 'gtg'];

  // Common topics get a clean, canonical label instead of a truncated
  // snippet of whatever the user happened to type first.
  const TOPIC_KEYWORDS = {
    react: 'React',
    reactjs: 'React',
    'react.js': 'React',
    javascript: 'JavaScript',
    js: 'JavaScript',
    typescript: 'TypeScript',
    ts: 'TypeScript',
    python: 'Python',
    docker: 'Docker',
    kubernetes: 'Kubernetes',
    k8s: 'Kubernetes',
    css: 'CSS',
    html: 'HTML',
    node: 'Node.js',
    nodejs: 'Node.js',
    'node.js': 'Node.js',
    git: 'Git',
    github: 'GitHub',
    sql: 'SQL',
    api: 'APIs',
    resume: 'Resume help',
    cv: 'Resume help',
    interview: 'Interview prep',
    recipe: 'Recipe',
    workout: 'Workout plan',
    travel: 'Travel planning',
    trip: 'Travel planning',
  };

  // Local, network-free titling so a thread never ends up named after a raw
  // keyboard-mash or a wall of literal text — used whenever the AI title
  // call fails, is empty, or just echoes the message back.
  function fallbackTitle(text) {
    const trimmed = text.trim();
    const normalized = trimmed.toLowerCase().replace(/[!?.]+$/g, '');

    if (GREETING_WORDS.includes(normalized)) return 'Greeting';
    if (THANKS_WORDS.includes(normalized)) return 'Thanks';
    if (FAREWELL_WORDS.includes(normalized)) return 'Farewell';

    // Repeated-character keyboard mash, e.g. "3ddddddddddddddddddd"
    if (/(.)\1{4,}/.test(normalized)) return 'Test message';

    // Try to catch a known topic anywhere in the message so titles read as
    // "React" rather than "Can you help me with react hooks and…".
    const rawWords = normalized.split(/\s+/);
    for (const w of rawWords) {
      const stripped = w.replace(/[^a-z0-9.]/g, '');
      if (TOPIC_KEYWORDS[stripped]) return TOPIC_KEYWORDS[stripped];
    }

    const words = trimmed.split(/\s+/);
    const snippet = words.slice(0, 5).join(' ');
    const capitalized = snippet.charAt(0).toUpperCase() + snippet.slice(1);
    return words.length > 5 ? `${capitalized}…` : capitalized;
  }

  // Real chat apps title a conversation after its topic ("React", "Trip to
  // Lahore"), not a summary of the exchange or the literal first message.
  // Falls back to a plain, keyword-aware snippet if the title call fails.
  async function generateThreadTitle(userMessage, aiReply) {
    try {
      const raw = await callOpenRouter(
        [
          {
            role: 'system',
            content:
              'Generate a short chat title for this conversation. Rules: ' +
              '1) If the conversation is about a specific, identifiable topic, technology, tool, place, or subject, use just that name as the title, e.g. "React", "Paris trip", "Docker setup", "Resume feedback". ' +
              '2) Only use a broader 2-4 word phrase if there is no single clear topic, e.g. "Greeting", "Career advice". ' +
              '3) Never repeat the user message verbatim. ' +
              '4) Plain text, sentence case or Proper Case for names, no quotes, no punctuation, no markdown, no reasoning, output only the title itself.',
          },
          {
            role: 'user',
            content: `User: ${userMessage}\nAssistant: ${aiReply}`,
          },
        ],
        20
      );

      const cleanedRaw = raw
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
      const title = cleanedRaw.replace(/["'.]/g, '').replace(/\s+/g, ' ').trim();
      return title ? title.slice(0, 32) : null;
    } catch {
      return null;
    }
  }

  async function getAIResponse(userMessage, threadId, isFirstMessage) {
    setLoading(true);
    try {
      const aiReply = await callOpenRouter(
        [
          {
            role: 'system',
            content:
              'Reply in plain conversational text only. Do not use markdown formatting: no asterisks, no bullet points, no numbered lists, no citation brackets like [1]. Do not show your reasoning, planning, or internal thoughts — output only the final reply. Write in normal sentences and short paragraphs, the way you would text a friend.',
          },
          { role: 'user', content: userMessage },
        ],
        500
      );

      const cleanReply = stripMarkdown(aiReply);
      const newId = crypto.randomUUID();

      updateThreadMessages(threadId, (msgs) => [
        ...msgs,
        { id: newId, text: cleanReply, sender: 'AI' },
      ]);

      if (isFirstMessage) {
        const generatedTitle = await generateThreadTitle(userMessage, cleanReply);
        const isEcho =
          generatedTitle &&
          generatedTitle.toLowerCase() === userMessage.trim().toLowerCase();
        setThreadTitle(
          threadId,
          generatedTitle && !isEcho ? generatedTitle : fallbackTitle(userMessage)
        );
      }

      if (autoSpeak && threadId === activeThreadId) {
        speakText(cleanReply, newId);
      }
    } catch (error) {
      console.error('getAIResponse failed:', error);
      // A distinct message for auth failures vs. every model in the fallback
      // chain being unavailable — makes the real cause visible in the UI
      // instead of a generic catch-all.
      const isAuthError = error?.message === 'auth';
      updateThreadMessages(threadId, (msgs) => [
        ...msgs,
        {
          id: crypto.randomUUID(),
          text: isAuthError
            ? 'The API key looks invalid or expired, so I can\u2019t reach any model right now. Please check VITE_OPENROUTER_API_KEY.'
            : 'Sorry, something went wrong. Please try again.',
          sender: 'AI',
        },
      ]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  function handleClearChat() {
    updateActiveThreadMessages(() => []);
    stopSpeaking();
  }

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setIsListening(false);
  }, []);

  function handleMicClick() {
    if (!SpeechRecognitionAPI) {
      alert('Voice input is not supported in this browser. Try Chrome or Edge.');
      return;
    }

    if (isListening) {
      stopListening();
      return;
    }

    const recognition = new SpeechRecognitionAPI();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0].transcript)
        .join('');
      setMessage(transcript);
    };

    recognition.onend = () => setIsListening(false);
    recognition.onerror = () => setIsListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeMessages, loading]);

  useEffect(() => {
    localStorage.setItem('chatThreads', JSON.stringify(threads));
  }, [threads]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      window.speechSynthesis?.cancel();
    };
  }, []);

  return (
    <div className="app-shell">
      {sidebarOpen && (
        <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
      )}

      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <button className="new-chat-btn" onClick={handleNewChat}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New chat
        </button>

        <div className="thread-list">
          {threads.map((t) => (
            <div
              key={t.id}
              className={`thread-item ${t.id === activeThreadId ? 'active' : ''} ${
                t.title === 'Untitled chat' ? 'untitled' : ''
              }`}
              onClick={() => handleSwitchThread(t.id)}
            >
              <span className="thread-title">{t.title}</span>
              <button
                className="thread-delete"
                onClick={(e) => handleDeleteThread(t.id, e)}
                title="Delete chat"
                aria-label="Delete chat"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6" />
                  <path d="M14 11v6" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      </aside>

      <div className="chat-app">
        <header className="chat-header">
          <button
            className="hamburger-btn"
            onClick={() => setSidebarOpen((v) => !v)}
            title="Toggle chats"
            aria-label="Toggle chat list"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>

          <div className="brand-logo" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
              <rect x="9" y="9" width="22" height="15" rx="6" fill="none" stroke="currentColor" strokeWidth="2.3" />
              <polygon points="13,23 13,29.5 19.5,23" fill="currentColor" />
              <circle cx="15" cy="16.5" r="1.5" fill="currentColor" />
              <circle cx="20" cy="16.5" r="1.5" fill="currentColor" />
              <circle cx="25" cy="16.5" r="1.5" fill="currentColor" />
              <path d="M31 12 L35 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <circle cx="36.5" cy="6.5" r="2" fill="currentColor" />
            </svg>
          </div>
          <div className="header-info">
            <h2>Chat Adil</h2>
            <span className="status">Online</span>
          </div>
          <button
            className={`icon-toggle ${autoSpeak ? 'active' : ''}`}
            onClick={() => {
              const next = !autoSpeak;
              setAutoSpeak(next);
              if (!next) stopSpeaking();
            }}
            title={autoSpeak ? 'Voice replies on' : 'Voice replies off'}
          >
            {autoSpeak ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="23" y1="9" x2="17" y2="15" />
                <line x1="17" y1="9" x2="23" y2="15" />
              </svg>
            )}
          </button>
          <button
            className="clear-btn"
            onClick={handleClearChat}
            disabled={activeMessages.length === 0}
            title="Clear chat"
          >
          Clear chat
          </button>
        </header>

        <main className="messages-container">
          {activeMessages.length === 0 && !loading && (
            <div className="empty-state">
              <p>Say hello to start the conversation 👋</p>
            </div>
          )}

          {activeMessages.map((msg) => (
            <div
              key={msg.id}
              className={`message ${msg.sender === 'User' ? 'user' : 'ai'}`}
            >
              {msg.sender === 'AI' && (
                <img src="/ai-language-model.png" alt="AI" className="avatar" />
              )}

              <div className="bubble-wrap">
                <div className="bubble">{msg.text}</div>
                {msg.sender === 'AI' && (
                  <button
                    className={`speak-btn ${speakingId === msg.id ? 'speaking' : ''}`}
                    onClick={() =>
                      speakingId === msg.id
                        ? stopSpeaking()
                        : speakText(msg.text, msg.id)
                    }
                    title={speakingId === msg.id ? 'Stop' : 'Read aloud'}
                    aria-label={speakingId === msg.id ? 'Stop reading' : 'Read message aloud'}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="message ai">
              <img src="/ai-language-model.png" alt="AI" className="avatar" />
              <div className="bubble typing-bubble">
                <span className="dot" />
                <span className="dot" />
                <span className="dot" />
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </main>

        <footer className="chat-input-bar">
          <button
            className={`mic-btn ${isListening ? 'listening' : ''}`}
            onClick={handleMicClick}
            disabled={loading}
            title={isListening ? 'Stop listening' : 'Speak your message'}
            aria-label={isListening ? 'Stop voice input' : 'Start voice input'}
          >
            <span className="mic-emoji" role="img" aria-label="Microphone">🎤</span>
          </button>
          <input
            ref={inputRef}
            value={message}
            type="text"
            placeholder={isListening ? 'Listening...' : 'Type your message here...'}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSendMessage();
            }}
          />
          <button
            onClick={() => handleSendMessage()}
            disabled={loading || message.trim() === ''}
          >
            {loading ? '...' : 'Send'}
          </button>
        </footer>
      </div>
    </div>
  );
}

export default App;