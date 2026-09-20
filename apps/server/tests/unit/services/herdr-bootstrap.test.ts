import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

const execFileMock = vi.fn();
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: (...args: unknown[]) => execFileMock(...args),
  };
});

const ensureSessionMock = vi.fn();
const getSocketPathMock = vi.fn(() => '/root/.config/herdr/sessions/vibe-llmops/herdr.sock');

vi.mock('../../../src/services/herdr-task-service.js', () => ({
  getHerdrTaskService: () => ({
    getClient: () => ({
      ensureSession: ensureSessionMock,
      getSocketPath: getSocketPathMock,
      dispose: () => undefined,
    }),
  }),
}));

import {
  bootstrapHerdr,
  getCachedHerdrStatus,
  readHerdrVersion,
  resetHerdrBootstrapCache,
} from '../../../src/services/herdr-bootstrap.js';

describe('herdr-bootstrap', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    resetHerdrBootstrapCache();
    home = mkdtempSync(path.join(tmpdir(), 'herdr-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = home;
    vi.clearAllMocks();
    execFileMock.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, { stdout: 'herdr 0.8.2\n', stderr: '' });
      }
    );
    ensureSessionMock.mockResolvedValue({
      started: false,
      socketPath: '/root/.config/herdr/sessions/vibe-llmops/herdr.sock',
    });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function installPiHook() {
    const dir = path.join(home, '.pi', 'agent', 'extensions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'herdr-agent-state.ts'), '// hook\n');
  }

  it('reads the version from herdr --version output', async () => {
    expect(await readHerdrVersion('/usr/local/bin/herdr')).toBe('0.8.2');
  });

  it('reports a fully ready bootstrap when everything is present', async () => {
    installPiHook();
    const status = await bootstrapHerdr();
    expect(status).toMatchObject({
      available: true,
      piIntegrationReady: true,
      version: '0.8.2',
      problems: [],
    });
    // Without a project there is no session to inspect.
    expect(status.sessionRunning).toBe(false);
    expect(status.sessionName).toBe('automaker');
  });

  it('starts and reports the project session when a project is given', async () => {
    installPiHook();
    const status = await bootstrapHerdr({ projectPath: '/workspace/vibe-llmops' });
    expect(ensureSessionMock).toHaveBeenCalled();
    expect(status).toMatchObject({
      sessionName: 'vibe-llmops',
      sessionRunning: true,
      socketPath: '/root/.config/herdr/sessions/vibe-llmops/herdr.sock',
      available: true,
    });
  });

  it('flags a missing pi integration without installing it by default', async () => {
    const status = await bootstrapHerdr();
    expect(status.piIntegrationReady).toBe(false);
    expect(status.available).toBe(false);
    expect(status.problems.join(' ')).toMatch(/integration/i);
    // Only `herdr --version` ran; nothing was installed.
    expect(execFileMock.mock.calls.every((call) => (call[1] as string[])[0] === '--version')).toBe(
      true
    );
  });

  it('installs the pi integration through the CLI when asked to', async () => {
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: Function) => {
        if (args[0] === 'integration') installPiHook();
        cb(null, { stdout: 'herdr 0.8.2\n', stderr: '' });
      }
    );
    const status = await bootstrapHerdr({ installMissingIntegration: true });
    expect(execFileMock.mock.calls.some((call) => (call[1] as string[])[1] === 'install')).toBe(
      true
    );
    expect(status.piIntegrationReady).toBe(true);
    expect(status.problems).toEqual([]);
  });

  it('reports a session start failure as a problem', async () => {
    installPiHook();
    ensureSessionMock.mockRejectedValue(new Error('boom'));
    const status = await bootstrapHerdr({ projectPath: '/workspace/vibe-llmops' });
    expect(status.sessionRunning).toBe(false);
    expect(status.problems.join(' ')).toMatch(/Could not start the herdr session/);
  });

  it('caches the last status per project', async () => {
    installPiHook();
    const status = await bootstrapHerdr({ projectPath: '/workspace/vibe-llmops' });
    expect(getCachedHerdrStatus('/workspace/vibe-llmops')).toEqual(status);
    expect(getCachedHerdrStatus('/workspace/other')).toBeNull();
  });
});
