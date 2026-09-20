import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import {
  HERDR_CONTROL_ENV_KEYS,
  HerdrService,
  buildHerdrAttachArgs,
  buildHerdrSessionKey,
  buildHerdrSessionName,
  isHerdrAvailable,
  resetHerdrBinaryCache,
  resolveHerdrBinary,
} from '../../../src/services/herdr-service.js';
import type { TerminalService, TerminalSession } from '../../../src/services/terminal-service.js';

/**
 * Build a throwaway PATH entry that contains an executable `herdr` stub. The
 * binary is never executed by these tests - only resolved.
 */
function createFakeBinDir(createBinary: boolean): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'herdr-bin-'));
  if (createBinary) {
    const binary = path.join(dir, 'herdr');
    writeFileSync(binary, '#!/bin/sh\nexit 0\n');
    chmodSync(binary, 0o755);
  }
  return dir;
}

describe('herdr-service.ts', () => {
  let tempDirs: string[] = [];

  beforeEach(() => {
    tempDirs = [];
    resetHerdrBinaryCache();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
    resetHerdrBinaryCache();
  });

  function fakeBin(createBinary: boolean): string {
    const dir = createFakeBinDir(createBinary);
    tempDirs.push(dir);
    return dir;
  }

  it('coalesces simultaneous recovery requests into one PTY attachment', async () => {
    const dir = fakeBin(true);
    vi.stubEnv('HERDR_BIN', path.join(dir, 'herdr'));
    let finish!: (value: unknown) => void;
    const createSession = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const service = new HerdrService({
      getSessionByKey: vi.fn(() => undefined),
      createSession,
    } as unknown as TerminalService);
    const first = service.attachWorktreeSession({
      projectPath: '/project',
      workDir: '/project/wt',
    });
    const second = service.attachWorktreeSession({
      projectPath: '/project',
      workDir: '/project/wt',
    });
    finish({ id: 'single-pty' });
    expect(await first).toEqual(await second);
    expect(createSession).toHaveBeenCalledOnce();
  });

  describe('buildHerdrSessionName', () => {
    it('is the project directory name, whatever worktree the task runs in', () => {
      expect(buildHerdrSessionName('/workspace/vibe-llmops')).toBe('vibe-llmops');
      expect(buildHerdrSessionName('/workspace/vibe-llmops/')).toBe('vibe-llmops');
    });

    it('slugifies names herdr would not accept verbatim', () => {
      expect(buildHerdrSessionName('/workspace/My Project')).toBe('my-project');
    });

    it('caps the name length and never ends on a dash', () => {
      const name = buildHerdrSessionName(`/workspace/${'a'.repeat(80)}-tail`);
      expect(name.length).toBeLessThanOrEqual(48);
      expect(name.endsWith('-')).toBe(false);
    });

    it("never collides with herdr's reserved default session", () => {
      expect(buildHerdrSessionName('/workspace/default')).toBe('am-default');
    });
  });

  describe('attach arguments', () => {
    it('attaches (or creates) the named session', () => {
      expect(buildHerdrAttachArgs('vibe-llmops')).toEqual(['--session', 'vibe-llmops']);
    });

    it('keys the PTY by herdr session name', () => {
      expect(buildHerdrSessionKey('vibe-llmops')).toBe('herdr:vibe-llmops');
    });
  });

  describe('resolveHerdrBinary', () => {
    it('finds herdr on PATH', () => {
      const dir = fakeBin(true);
      vi.stubEnv('PATH', dir);
      vi.stubEnv('HERDR_BIN', '');
      vi.stubEnv('HERDR_BIN_PATH', '');

      expect(resolveHerdrBinary()).toBe(path.join(dir, 'herdr'));
      expect(isHerdrAvailable()).toBe(true);
    });

    it('prefers an explicit HERDR_BIN over PATH', () => {
      const configured = fakeBin(true);
      const onPath = fakeBin(true);
      vi.stubEnv('HERDR_BIN', path.join(configured, 'herdr'));
      vi.stubEnv('PATH', onPath);

      expect(resolveHerdrBinary()).toBe(path.join(configured, 'herdr'));
    });

    it('reports herdr as unavailable when no binary exists', () => {
      const empty = fakeBin(false);
      vi.stubEnv('PATH', empty);
      vi.stubEnv('HERDR_BIN', path.join(empty, 'missing'));
      vi.stubEnv('HERDR_BIN_PATH', '');

      expect(resolveHerdrBinary()).toBeNull();
      expect(isHerdrAvailable()).toBe(false);
    });
  });

  describe('attachWorktreeSession', () => {
    function createTerminalServiceMock() {
      const sessions = new Map<string, TerminalSession>();
      const createSession = vi.fn(async (options: { key?: string }) => {
        const session = {
          id: 'term-test-1',
          cwd: '/workspace/wt/feature-herdr',
          createdAt: new Date(),
          shell: 'herdr',
          key: options.key ?? null,
        } as unknown as TerminalSession;
        sessions.set(session.id, session);
        return session;
      });
      const service = {
        createSession,
        getSessionByKey: (key: string) => {
          for (const session of sessions.values()) {
            if (session.key === key) return session;
          }
          return undefined;
        },
        killSession: vi.fn(() => true),
      } as unknown as TerminalService;
      return { service, createSession };
    }

    it('spawns herdr in the worktree without inheriting herdr control variables', async () => {
      const binDir = fakeBin(true);
      vi.stubEnv('PATH', binDir);
      vi.stubEnv('HERDR_BIN', '');
      vi.stubEnv('HERDR_BIN_PATH', '');

      const { service, createSession } = createTerminalServiceMock();
      const result = await new HerdrService(service).attachWorktreeSession({
        projectPath: '/workspace/automaker',
        workDir: '/workspace/wt/feature-herdr',
      });

      expect(result).toEqual({
        sessionName: 'automaker',
        terminalSessionId: 'term-test-1',
        reused: false,
      });
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/workspace/wt/feature-herdr',
          command: path.join(binDir, 'herdr'),
          args: ['--session', 'automaker'],
          key: 'herdr:automaker',
          envExcludeKeys: expect.arrayContaining([...HERDR_CONTROL_ENV_KEYS]),
        })
      );
      // The nested-TUI guard and the caller's pane context must never leak in.
      expect(createSession.mock.calls[0][0].envExcludeKeys).toContain('HERDR_ENV');
      expect(createSession.mock.calls[0][0].envExcludeKeys).toContain('HERDR_SOCKET_PATH');
    });

    it('reuses the live attach client for the same worktree', async () => {
      const binDir = fakeBin(true);
      vi.stubEnv('PATH', binDir);

      const { service, createSession } = createTerminalServiceMock();
      const herdr = new HerdrService(service);
      const options = {
        projectPath: '/workspace/automaker',
        workDir: '/workspace/wt/feature-herdr',
      };

      await herdr.attachWorktreeSession(options);
      const second = await herdr.attachWorktreeSession(options);

      expect(second.reused).toBe(true);
      expect(createSession).toHaveBeenCalledTimes(1);
    });

    it('attaches to an explicit session when the caller knows it', async () => {
      const binDir = fakeBin(true);
      vi.stubEnv('PATH', binDir);

      const { service, createSession } = createTerminalServiceMock();
      const result = await new HerdrService(service).attachWorktreeSession({
        projectPath: '/workspace/automaker',
        workDir: '/workspace/wt/feature-herdr',
        sessionName: 'automaker',
      });

      expect(result.sessionName).toBe('automaker');
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          args: ['--session', 'automaker'],
          key: 'herdr:automaker',
        })
      );
    });

    it('fails with an actionable message when herdr is not installed', async () => {
      const empty = fakeBin(false);
      vi.stubEnv('PATH', empty);
      vi.stubEnv('HERDR_BIN', '');
      vi.stubEnv('HERDR_BIN_PATH', '');

      const { service, createSession } = createTerminalServiceMock();
      await expect(
        new HerdrService(service).attachWorktreeSession({
          projectPath: '/workspace/automaker',
          workDir: '/workspace/wt/feature-herdr',
        })
      ).rejects.toThrow(/herdr is not installed/);
      expect(createSession).not.toHaveBeenCalled();
    });
  });
});
