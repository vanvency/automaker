/**
 * Herdr yanks with OSC 52, which xterm.js drops, so the herdr page has to write
 * the payload into the browser clipboard itself.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHerdrWebView } from '../../../src/routes/herdr/view.js';

it('restores mouse reporting after truncated replay, without changing live terminal output', () => {
  const region = renderHerdrWebView()
    .split('// #region mouse-reporting')[1]
    ?.split('// #endregion mouse-reporting')[0];
  const write = vi.fn();
  const receive = new Function('terminal', `${region}\nreturn writeTerminalMessage;`)({ write });
  const enableMouse = '\x1b[?1003h\x1b[?1006h';

  receive({ type: 'connected' });
  expect(write).toHaveBeenLastCalledWith(enableMouse);
  // A long-running PTY has lost its startup modes from its bounded replay.
  const replay = 'x'.repeat(50000);
  receive({ type: 'scrollback', data: replay });
  expect(write).toHaveBeenLastCalledWith(replay + enableMouse);
  // Preserve deliberate mode changes in live output.
  receive({ type: 'data', data: '\x1b[?1003l' });
  expect(write).toHaveBeenLastCalledWith('\x1b[?1003l');
});

/** Pull the page's clipboard bridge out of the rendered HTML and run it. */
function loadApplyOsc52(): (payload: string, write: (text: string) => void) => boolean {
  const html = renderHerdrWebView();
  const region = html
    .split('// #region osc52-clipboard')[1]
    ?.split('// #endregion osc52-clipboard')[0];
  if (!region) throw new Error('the herdr page no longer ships the OSC 52 clipboard bridge');
  return new Function(`${region}\nreturn applyOsc52;`)();
}

describe('herdr page clipboard bridge', () => {
  it('writes the UTF-8 text of an OSC 52 payload to the clipboard', () => {
    const write = vi.fn();
    const encoded = Buffer.from('héllo 世界', 'utf8').toString('base64');

    expect(loadApplyOsc52()(`c;${encoded}`, write)).toBe(true);
    expect(write).toHaveBeenCalledWith('héllo 世界');
  });

  it('answers read requests and malformed payloads without touching the clipboard', () => {
    const write = vi.fn();
    const apply = loadApplyOsc52();

    expect(apply('c;?', write)).toBe(true);
    expect(apply('nonsense', write)).toBe(false);
    expect(apply('c;not-base64!!', write)).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('herdr page attachment recovery', () => {
  function loadRecovery(response: object, ok = true, status = 200) {
    const region = renderHerdrWebView()
      .split('// #region reattach')[1]
      ?.split('// #endregion reattach')[0];
    const fetch = vi.fn().mockResolvedValue({
      ok,
      status,
      json: async () => response,
    });
    const replaceState = vi.fn();
    const reset = vi.fn();
    const recover = new Function(
      'fetch',
      'window',
      'terminal',
      `
      let workDir = '/project/.worktrees/task';
      let projectPath = '';
      let terminalSessionId = 'expired-pty';
      let needsAttachment = true;
      const apiUrl = (url) => url;
      ${region}
      return async () => {
        await renewAttachment();
        return { terminalSessionId, projectPath, needsAttachment };
      };
    `
    )(
      fetch,
      {
        location: { href: 'http://localhost/api/herdr/view?session=expired-pty&token=keep-auth' },
        history: { replaceState },
      },
      { reset }
    );
    return { recover, fetch, replaceState, reset };
  }

  it('obtains a fresh PTY and updates the old URL while preserving authentication', async () => {
    const test = loadRecovery({
      success: true,
      terminalSessionId: 'new-pty',
      projectPath: '/project',
    });
    expect(await test.recover()).toEqual({
      terminalSessionId: 'new-pty',
      projectPath: '/project',
      needsAttachment: false,
    });
    const url = test.replaceState.mock.calls[0][2] as URL;
    expect(url.searchParams.get('session')).toBe('new-pty');
    expect(url.searchParams.get('token')).toBe('keep-auth');
    expect(test.reset).toHaveBeenCalledOnce();
  });

  it('keeps recovery pending when the backend is temporarily unavailable', async () => {
    const test = loadRecovery({ success: false, error: 'temporarily unavailable' }, false, 503);
    await expect(test.recover()).rejects.toThrow('temporarily unavailable');
    expect(test.replaceState).not.toHaveBeenCalled();
  });

  it('distinguishes expired login credentials from an expired terminal attachment', async () => {
    const test = loadRecovery({}, false, 401);
    await expect(test.recover()).rejects.toThrow('Authentication expired');
    expect(test.reset).not.toHaveBeenCalled();
  });
});
