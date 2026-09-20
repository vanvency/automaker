/**
 * Self-contained HTML page that renders a herdr session in the browser.
 *
 * The page is a thin xterm.js client: the server already created the PTY that
 * runs `herdr --session <name>`, so this file only wires the terminal emulator
 * to the existing `/api/terminal/ws` socket. All runtime values arrive through
 * the query string, which keeps this file free of server-side interpolation.
 */

export function renderHerdrWebView(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Herdr</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0f1115;
        --panel: #171a21;
        --border: #262b35;
        --text: #e6e8ec;
        --muted: #9aa3b2;
        --accent: #7c9ef5;
        --error: #ffa39c;
      }
      * { box-sizing: border-box; }
      html, body { height: 100%; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 14px;
        background: var(--panel);
        border-bottom: 1px solid var(--border);
        flex: none;
      }
      header .title { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      header .session {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        color: var(--muted);
        padding: 2px 6px;
        border: 1px solid var(--border);
        border-radius: 6px;
        white-space: nowrap;
      }
      header .spacer { flex: 1; }
      header button {
        background: transparent;
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 4px 8px;
        font: inherit;
        font-size: 11px;
        cursor: pointer;
      }
      header button:hover { border-color: var(--accent); color: var(--accent); }
      #status { font-size: 11px; color: var(--muted); white-space: nowrap; }
      #status.error { color: var(--error); }
      #terminal {
        flex: 1;
        min-height: 0;
        padding: 6px 4px 0 8px;
        background: var(--bg);
      }
      #terminal .xterm { height: 100%; }
      #login {
        position: fixed;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        background: rgba(15, 17, 21, 0.92);
        z-index: 10;
      }
      #login.open { display: flex; }
      #login form {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 18px;
        width: min(320px, 90vw);
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      #login h2 { margin: 0; font-size: 14px; }
      #login input {
        background: #10131a;
        border: 1px solid #2c333f;
        color: var(--text);
        border-radius: 8px;
        padding: 8px 10px;
        font: inherit;
      }
      #login button {
        background: var(--accent);
        color: #0b1220;
        border: none;
        border-radius: 8px;
        padding: 8px 12px;
        font-weight: 600;
        cursor: pointer;
      }
      #login .error { color: var(--error); font-size: 12px; min-height: 16px; }
    </style>
  </head>
  <body>
    <header>
      <span class="title" id="title">Herdr</span>
      <span class="session" id="session"></span>
      <span class="spacer"></span>
      <span id="status">Connecting…</span>
      <button id="font-smaller" type="button" title="Smaller font">A-</button>
      <button id="font-larger" type="button" title="Larger font">A+</button>
      <button id="reconnect" type="button" title="Reconnect">Reconnect</button>
    </header>
    <div id="terminal"></div>
    <div id="login">
      <form id="login-form">
        <h2>Terminal password</h2>
        <input id="login-password" type="password" placeholder="Password" autocomplete="current-password" required />
        <button type="submit">Unlock</button>
        <div class="error" id="login-error"></div>
      </form>
    </div>
    <script>
      (function () {
        const params = new URLSearchParams(window.location.search);
        let terminalSessionId = params.get('session') || '';
        let projectPath = params.get('projectPath') || '';
        const sessionName = params.get('name') || '';
        const title = params.get('title') || '';
        const workDir = params.get('dir') || '';
        const apiKey = params.get('apiKey') || '';
        // Web/external-server mode: the app authenticates with a session token
        // rather than an API key, and the browser tab has no cookies of its own.
        const sessionToken = params.get('token') || '';
        let terminalToken = params.get('terminalToken') || '';

        const statusEl = document.getElementById('status');
        const loginEl = document.getElementById('login');
        const loginErrorEl = document.getElementById('login-error');

        if (title) document.title = title + ' · Herdr';
        document.getElementById('title').textContent = title || 'Herdr';
        document.getElementById('session').textContent = sessionName;
        if (workDir) document.getElementById('session').title = workDir;

        function setStatus(text, isError) {
          statusEl.textContent = text;
          statusEl.className = isError ? 'error' : '';
        }

        /** Same-origin URL carrying the credentials that opened this page. */
        function apiUrl(url) {
          const resolved = new URL(url, window.location.origin);
          if (apiKey) resolved.searchParams.set('apiKey', apiKey);
          if (sessionToken) resolved.searchParams.set('token', sessionToken);
          return resolved.toString();
        }

        function loadAsset(url, isStylesheet) {
          return new Promise(function (resolve, reject) {
            const node = isStylesheet
              ? Object.assign(document.createElement('link'), { rel: 'stylesheet', href: url })
              : Object.assign(document.createElement('script'), { src: url, async: false });
            node.onload = resolve;
            node.onerror = function () { reject(new Error('Failed to load ' + url)); };
            document.head.appendChild(node);
          });
        }

        async function loadTerminalAssets() {
          await loadAsset(apiUrl('/api/herdr/assets/xterm.css'), true);
          await loadAsset(apiUrl('/api/herdr/assets/xterm.js'), false);
          await loadAsset(apiUrl('/api/herdr/assets/addon-fit.js'), false);
        }

        /**
         * WebSocket connections authenticate with a short-lived token, which is
         * what the in-app terminal panel does. Fall back to the credentials in
         * the URL when the token endpoint is unavailable.
         */
        async function fetchWsToken() {
          try {
            const response = await fetch(apiUrl('/api/auth/token'), {
              credentials: 'same-origin',
              cache: 'no-store',
            });
            if (!response.ok) return '';
            const data = await response.json();
            return (data && data.token) || '';
          } catch (error) {
            return '';
          }
        }

        function socketUrl(wsToken) {
          const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          const url = new URL('/api/terminal/ws', window.location.origin);
          url.protocol = scheme;
          url.searchParams.set('sessionId', terminalSessionId);
          if (wsToken) {
            url.searchParams.set('wsToken', wsToken);
          } else if (apiKey) {
            url.searchParams.set('apiKey', apiKey);
          } else if (sessionToken) {
            url.searchParams.set('token', sessionToken);
          }
          // The terminal password token shares the "token" name on this route.
          if (terminalToken) url.searchParams.set('token', terminalToken);
          return url.toString();
        }

        async function unlock(password) {
          const response = await fetch(apiUrl('/api/terminal/auth'), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: password }),
          });
          const data = await response.json().catch(function () { return {}; });
          if (!response.ok || !data.success) {
            throw new Error((data && data.error) || 'Invalid password');
          }
          return (data.data && data.data.token) || '';
        }

        document.getElementById('login-form').addEventListener('submit', async function (event) {
          event.preventDefault();
          const password = document.getElementById('login-password').value;
          loginErrorEl.textContent = '';
          try {
            terminalToken = await unlock(password);
            loginEl.classList.remove('open');
            connect();
          } catch (error) {
            loginErrorEl.textContent = error instanceof Error ? error.message : String(error);
          }
        });

        let terminal = null;
        let fitAddon = null;
        let socket = null;
        let reconnectTimer = null;
        let closedByUser = false;
        let connectionGeneration = 0;
        let needsAttachment = !terminalSessionId;

        // #region reattach
        async function renewAttachment() {
          if (!workDir) throw new Error('Missing worktree path; reopen Conversation from the board');
          const response = await fetch(apiUrl('/api/herdr/reattach'), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workDir: workDir, projectPath: projectPath || undefined }),
          });
          if (response.status === 401 || response.status === 403) {
            throw new Error('Authentication expired; sign in to Automaker and reopen Conversation');
          }
          const data = await response.json();
          if (!response.ok || !data.success || !data.terminalSessionId) {
            throw new Error(data.error || 'Could not reconnect to herdr');
          }
          terminalSessionId = data.terminalSessionId;
          projectPath = data.projectPath || projectPath;
          const current = new URL(window.location.href);
          current.searchParams.set('session', terminalSessionId);
          if (projectPath) current.searchParams.set('projectPath', projectPath);
          window.history.replaceState(null, '', current);
          if (terminal) terminal.reset();
          needsAttachment = false;
        }
        // #endregion reattach

        function scheduleReconnect() {
          if (closedByUser || reconnectTimer) return;
          reconnectTimer = setTimeout(function () {
            reconnectTimer = null;
            connect();
          }, 2000);
        }

        async function connect() {
          const generation = ++connectionGeneration;
          if (!terminalSessionId && !workDir) {
            setStatus('No herdr session was provided', true);
            return;
          }
          if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
          if (socket) {
            try { socket.close(); } catch (error) { /* ignore */ }
            socket = null;
          }
          setStatus('Connecting…');
          if (needsAttachment) {
            try { await renewAttachment(); }
            catch (error) {
              if (generation !== connectionGeneration || closedByUser) return;
              setStatus(error instanceof Error ? error.message : String(error), true);
              if (!(error instanceof Error && error.message.startsWith('Authentication expired'))) {
                scheduleReconnect();
              }
              return;
            }
          }
          const wsToken = await fetchWsToken();
          if (generation !== connectionGeneration || closedByUser) return;
          const ws = new WebSocket(socketUrl(wsToken));
          socket = ws;

          ws.onopen = function () {
            if (generation === connectionGeneration) setStatus('Connected');
          };

          ws.onmessage = function (event) {
            if (generation !== connectionGeneration) return;
            let message;
            try { message = JSON.parse(event.data); } catch (error) { return; }
            if (!message || typeof message.type !== 'string') return;
            if (message.type === 'data' || message.type === 'scrollback') {
              if (terminal && typeof message.data === 'string') terminal.write(message.data);
            } else if (message.type === 'connected') {
              setStatus('Connected');
              if (fitAddon && terminal) {
                try {
                  fitAddon.fit();
                  ws.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
                } catch (error) { /* ignore */ }
              }
              terminal && terminal.focus();
            } else if (message.type === 'exit') {
              needsAttachment = true;
              setStatus('Terminal connection ended; reattaching to the conversation…', true);
              scheduleReconnect();
            } else if (message.type === 'error') {
              setStatus(message.message || 'Terminal error', true);
            }
          };

          ws.onclose = function (event) {
            if (closedByUser || generation !== connectionGeneration) return;
            if (event.code === 4001) {
              setStatus('Terminal password required', true);
              loginEl.classList.add('open');
              document.getElementById('login-password').focus();
              return;
            }
            if (event.code === 4004) {
              needsAttachment = true;
              setStatus('Terminal connection expired; reattaching to the conversation…', true);
              scheduleReconnect();
              return;
            }
            setStatus(event.reason ? 'Disconnected: ' + event.reason : 'Disconnected, retrying…', true);
            scheduleReconnect();
          };

          ws.onerror = function () {
            if (generation === connectionGeneration) setStatus('Connection error', true);
          };
        }

        function sendResize() {
          if (!fitAddon || !terminal || !socket || socket.readyState !== WebSocket.OPEN) return;
          try {
            fitAddon.fit();
            socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
          } catch (error) { /* ignore */ }
        }

        function changeFontSize(delta) {
          if (!terminal) return;
          const next = Math.min(28, Math.max(9, (terminal.options.fontSize || 14) + delta));
          terminal.options.fontSize = next;
          sendResize();
        }

        document.getElementById('font-smaller').addEventListener('click', function () { changeFontSize(-1); });
        document.getElementById('font-larger').addEventListener('click', function () { changeFontSize(1); });
        document.getElementById('reconnect').addEventListener('click', function () {
          closedByUser = false;
          connect();
        });

        window.addEventListener('beforeunload', function () { closedByUser = true; });
        let resizeTimer = null;
        window.addEventListener('resize', function () {
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(sendResize, 120);
        });

        // #region osc52-clipboard
        /**
         * Herdr copies by writing OSC 52 to its host terminal, which xterm.js
         * drops, so the page has to put the text into the browser clipboard.
         * Payload shape (xterm.js strips the "52;"): "<selection>;<base64>".
         */
        function applyOsc52(payload, write) {
          const separator = payload.indexOf(';');
          if (separator === -1) return false;
          const encoded = payload.slice(separator + 1);
          // "?" is a clipboard read request - never answer it.
          if (!encoded || encoded === '?') return true;
          let text;
          try {
            const bytes = Uint8Array.from(atob(encoded), function (char) {
              return char.charCodeAt(0);
            });
            text = new TextDecoder().decode(bytes);
          } catch (error) {
            return false;
          }
          write(text);
          return true;
        }

        function copyViaTextarea(text) {
          // Fallback for non-secure origins, where navigator.clipboard is absent.
          const node = document.createElement('textarea');
          node.value = text;
          node.style.position = 'fixed';
          node.style.top = '-1000px';
          document.body.appendChild(node);
          node.select();
          try {
            document.execCommand('copy');
          } finally {
            node.remove();
          }
        }

        function writeClipboard(text) {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(function () { copyViaTextarea(text); });
            return;
          }
          copyViaTextarea(text);
        }
        // #endregion osc52-clipboard

        loadTerminalAssets().then(function () {
          const fitAddonCtor = window.FitAddon && window.FitAddon.FitAddon;
          terminal = new window.Terminal({
            cursorBlink: true,
            fontSize: 14,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, "DejaVu Sans Mono", monospace',
            scrollback: 10000,
            theme: {
              background: '#0f1115',
              foreground: '#e6e8ec',
              cursor: '#e6e8ec',
              selectionBackground: '#334155',
            },
          });
          fitAddon = fitAddonCtor ? new fitAddonCtor() : null;
          if (fitAddon) terminal.loadAddon(fitAddon);
          terminal.open(document.getElementById('terminal'));
          terminal.parser.registerOscHandler(52, function (payload) {
            return applyOsc52(payload, writeClipboard);
          });
          if (fitAddon) {
            try { fitAddon.fit(); } catch (error) { /* ignore */ }
          }
          terminal.onData(function (data) {
            if (socket && socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'input', data: data }));
            }
          });
          terminal.focus();
          connect();
        }).catch(function (error) {
          setStatus(error instanceof Error ? error.message : String(error), true);
        });
      })();
    </script>
  </body>
</html>
`;
}
