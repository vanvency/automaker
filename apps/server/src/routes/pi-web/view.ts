/**
 * Self-contained HTML page for the Pi conversation viewer.
 *
 * Pi has no built-in web UI, so Automaker serves this page and talks to the
 * local API endpoints (`/api/pi-web/session`, `/api/pi-web/send`). All runtime
 * values arrive through the query string, which keeps this file free of
 * server-side interpolation.
 */

export function renderPiWebView(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pi conversation</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #0f1115;
        --panel: #171a21;
        --panel-2: #1f232c;
        --text: #e6e8ec;
        --muted: #9aa3b2;
        --accent: #7c9ef5;
        --user: #2b3a55;
        --error: #b3423a;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        background: var(--bg);
        color: var(--text);
        display: flex;
        flex-direction: column;
        height: 100vh;
      }
      header {
        padding: 12px 18px;
        border-bottom: 1px solid #262b35;
        display: flex;
        align-items: center;
        gap: 12px;
        background: var(--panel);
      }
      header h1 { font-size: 15px; margin: 0; font-weight: 600; }
      header .meta { color: var(--muted); font-size: 12px; margin-left: auto; text-align: right; }
      main { flex: 1; overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 14px; }
      .msg { max-width: 900px; width: 100%; margin: 0 auto; }
      .bubble {
        border-radius: 10px;
        padding: 10px 14px;
        background: var(--panel);
        border: 1px solid #262b35;
        white-space: pre-wrap;
        word-wrap: break-word;
      }
      .msg.user .bubble { background: var(--user); border-color: #34456b; }
      .msg.assistant .bubble { background: var(--panel); }
      .msg.tool .bubble { background: var(--panel-2); border-style: dashed; color: var(--muted); }
      .role { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: 6px; }
      details { margin-top: 8px; }
      details summary { cursor: pointer; color: var(--muted); font-size: 12px; }
      details pre {
        margin: 8px 0 0;
        padding: 8px 10px;
        border-radius: 8px;
        background: #10131a;
        overflow-x: auto;
        font-size: 12px;
      }
      .error .bubble { border-color: var(--error); color: #ffd7d3; }
      .empty { color: var(--muted); text-align: center; margin-top: 40px; }
      footer {
        border-top: 1px solid #262b35;
        background: var(--panel);
        padding: 12px 18px;
      }
      form { max-width: 900px; margin: 0 auto; display: flex; gap: 10px; align-items: flex-end; }
      textarea {
        flex: 1;
        resize: vertical;
        min-height: 44px;
        max-height: 200px;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid #2c333f;
        background: #10131a;
        color: var(--text);
        font: inherit;
      }
      button {
        padding: 10px 18px;
        border-radius: 10px;
        border: none;
        background: var(--accent);
        color: #0b1220;
        font-weight: 600;
        cursor: pointer;
      }
      button:disabled { opacity: .5; cursor: progress; }
      .status { max-width: 900px; margin: 8px auto 0; color: var(--muted); font-size: 12px; min-height: 16px; }
      .status.error { color: #ffa39c; }
    </style>
  </head>
  <body>
    <header>
      <h1 id="title">Pi conversation</h1>
      <div class="meta" id="meta"></div>
    </header>
    <main id="messages"><div class="empty">Loading conversation…</div></main>
    <footer>
      <form id="composer">
        <textarea id="input" placeholder="Send a follow-up message to this Pi session…" required></textarea>
        <button id="send" type="submit">Send</button>
      </form>
      <div class="status" id="status"></div>
    </footer>
    <script>
      const params = new URLSearchParams(window.location.search);
      const apiKey = params.get('apiKey') || '';
      // Web/external-server mode authenticates with a session token instead of
      // an API key; the tab that opened this page carries it in the URL.
      const sessionToken = params.get('token') || '';
      const workDir = params.get('workDir') || '';
      const sessionId = params.get('sessionId') || '';
      const featureTitle = params.get('title') || '';
      const projectPath = params.get('projectPath') || '';
      const modelParam = params.get('model') || '';

      const messagesEl = document.getElementById('messages');
      const statusEl = document.getElementById('status');
      const inputEl = document.getElementById('input');
      const sendEl = document.getElementById('send');
      const metaEl = document.getElementById('meta');

      if (featureTitle) document.getElementById('title').textContent = featureTitle;

      function api(path, options = {}) {
        const url = new URL(path, window.location.origin);
        if (apiKey) url.searchParams.set('apiKey', apiKey);
        if (sessionToken) url.searchParams.set('token', sessionToken);
        return fetch(url.toString(), {
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          ...options,
        });
      }

      function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
      }

      function renderMessage(message) {
        const kind = message.role === 'toolResult' ? 'tool' : message.role;
        const wrapper = el('div', 'msg ' + kind + (message.isError ? ' error' : ''));
        wrapper.appendChild(
          el('div', 'role', message.role === 'toolResult' ? 'tool result' : message.role)
        );
        const bubble = el('div', 'bubble');
        bubble.textContent = message.text || (message.toolCalls && message.toolCalls.length ? '' : '(empty)');
        wrapper.appendChild(bubble);

        if (message.thinking) {
          const details = document.createElement('details');
          details.appendChild(el('summary', null, 'Reasoning'));
          details.appendChild(el('pre', null, message.thinking));
          wrapper.appendChild(details);
        }
        if (message.toolCalls && message.toolCalls.length) {
          const details = document.createElement('details');
          details.appendChild(el('summary', null, 'Tool calls (' + message.toolCalls.length + ')'));
          details.appendChild(el('pre', null, JSON.stringify(message.toolCalls, null, 2)));
          wrapper.appendChild(details);
        }
        if (message.errorMessage) {
          wrapper.appendChild(el('div', 'role', message.errorMessage));
        }
        return wrapper;
      }

      async function loadSession() {
        const url = '/api/pi-web/session?workDir=' + encodeURIComponent(workDir) +
          (sessionId ? '&sessionId=' + encodeURIComponent(sessionId) : '');
        const response = await api(url);
        const data = await response.json();
        if (!data.success) throw new Error(data.error || 'Failed to load the Pi session');

        messagesEl.innerHTML = '';
        if (!data.session || data.session.messages.length === 0) {
          messagesEl.appendChild(el('div', 'empty', 'No messages in this session yet.'));
        } else {
          for (const message of data.session.messages) {
            messagesEl.appendChild(renderMessage(message));
          }
        }

        const model = data.session.modelProvider && data.session.modelId
          ? data.session.modelProvider + '/' + data.session.modelId
          : 'unknown model';
        metaEl.textContent = model + ' · ' + data.session.userTurnCount + ' turn(s)';
        window.scrollTo(0, document.body.scrollHeight);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return data.session;
      }

      async function sendMessage(text) {
        const response = await api('/api/pi-web/send', {
          method: 'POST',
          body: JSON.stringify({
            workDir,
            projectPath,
            sessionId,
            model: modelParam,
            message: text,
          }),
        });
        const data = await response.json();
        if (!data.success) throw new Error(data.error || 'Pi run failed');
        return data;
      }

      document.getElementById('composer').addEventListener('submit', async (event) => {
        event.preventDefault();
        const text = inputEl.value.trim();
        if (!text) return;

        inputEl.value = '';
        sendEl.disabled = true;
        statusEl.className = 'status';
        statusEl.textContent = 'Pi is working…';

        messagesEl.appendChild(renderMessage({ role: 'user', text }));
        messagesEl.scrollTop = messagesEl.scrollHeight;

        try {
          const result = await sendMessage(text);
          if (result.sessionId) {
            const url = new URL(window.location.href);
            url.searchParams.set('sessionId', result.sessionId);
            window.history.replaceState({}, '', url.toString());
          }
          await loadSession();
          statusEl.textContent = '';
        } catch (error) {
          statusEl.className = 'status error';
          statusEl.textContent = error instanceof Error ? error.message : String(error);
          messagesEl.appendChild(renderMessage({ role: 'assistant', text: '', isError: true, errorMessage: statusEl.textContent }));
        } finally {
          sendEl.disabled = false;
          inputEl.focus();
        }
      });

      inputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          document.getElementById('composer').requestSubmit();
        }
      });

      loadSession().catch((error) => {
        statusEl.className = 'status error';
        statusEl.textContent = error instanceof Error ? error.message : String(error);
      });
    </script>
  </body>
</html>
`;
}
