import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_JIRA_SYNC_CONFIG } from '@automaker/types';
import {
  JiraSyncService,
  legacyJiraConfig,
  validateJiraSyncConfig,
} from '../../../src/services/jira-sync-service.js';
import type { SettingsService } from '../../../src/services/settings-service.js';

const mocks = vi.hoisted(() => ({ system: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = Object.assign(vi.fn(), { [promisify.custom]: mocks.system });
  return { ...actual, execFile };
});
const config = {
  ...DEFAULT_JIRA_SYNC_CONFIG,
  jiraUrl: 'https://jira.example',
  jiraProject: 'AIP',
  jql: 'project = AIP',
  gitlabHost: 'gitlab.example',
};

describe('managed Jira configuration and scheduling', () => {
  let directory: string;
  let project: string;
  let saved: any;
  let service: JiraSyncService;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'jira-sync-'));
    project = path.join(directory, 'project');
    await mkdir(project);
    saved = {};
    const settings = {
      getProjectSettings: vi.fn(async () => saved),
      updateProjectSettings: vi.fn(async (_p, updates) => {
        saved = { ...saved, ...updates };
        return saved;
      }),
    } as unknown as SettingsService;
    service = new JiraSyncService(settings, directory);
    mocks.system.mockResolvedValue({ stdout: 'inactive\n' });
  });
  afterEach(async () => {
    service.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it('rejects credentials in URLs, invalid rules and browser-supplied commands', () => {
    expect(() =>
      validateJiraSyncConfig({ ...config, jiraUrl: 'https://user:secret@jira.example' })
    ).toThrow();
    expect(() => validateJiraSyncConfig({ ...config, manualLabels: ['dodo'] })).toThrow();
    expect(() =>
      validateJiraSyncConfig({ ...config, targetBranch: '--upload-pack=evil' })
    ).toThrow();
    expect(validateJiraSyncConfig({ ...config, jiraCommand: '/tmp/arbitrary' })).not.toHaveProperty(
      'jiraCommand'
    );
  });

  it('persists pause without stopping task execution and records config changes', async () => {
    await service.save(project, { ...config, enabled: true });
    let status = await service.status(project);
    expect(status.nextRunAt).toBeDefined();
    await service.save(project, config);
    status = await service.status(project);
    expect(status.config?.enabled).toBe(false);
    expect(status.nextRunAt).toBeUndefined();
    expect(status.runs[0].message).toContain('enabled');
  });

  async function legacy() {
    await mkdir(path.join(directory, 'jira-monitor'));
    await writeFile(
      path.join(directory, 'jira-monitor/config.json'),
      JSON.stringify({
        projectPath: project,
        jiraUrl: config.jiraUrl,
        jiraProject: 'AIP',
        jql: 'project = AIP',
        jiraLabels: { autoStart: ['dodo'], manualStart: ['kaka'] },
        model: config.model,
        gitlabHost: 'gitlab.example',
        dispatchEnabled: true,
        jiraCommand: '/usr/local/bin/jira',
        gitlabTokenFile: '/secret/file',
      })
    );
    await writeFile(
      path.join(directory, 'jira-monitor/state.json'),
      JSON.stringify({
        jobs: {
          'AIP-1': { status: 'running', featureId: 'old-card', jiraProgressMarker: 'keep-marker' },
        },
        missingFeatures: { 'AIP-2': 'removed-card' },
      })
    );
  }

  it('migrates old job identities and writeback markers while disabling the timer', async () => {
    await legacy();
    const result = await service.migrate(project);
    expect(result.migrated).toBe(true);
    expect(result.jobCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain('/secret/file');
    expect(mocks.system).toHaveBeenCalledWith(
      'systemctl',
      ['disable', '--now', 'automaker-jira-monitor.timer'],
      expect.anything()
    );
    const dir = (service as any).dir(project);
    const state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
    expect(state.jobs['AIP-1'].featureId).toBe('old-card');
    expect(state.jobs['AIP-1'].jiraProgressMarker).toBe('keep-marker');
    expect(state.missingFeatures['AIP-2']).toBe('removed-card');
    await service.migrate(project);
    expect(mocks.system.mock.calls.filter((args) => args[1][0] === 'disable')).toHaveLength(1);
  });

  it('waits for the legacy tick to finish instead of copying a changing state file', async () => {
    await legacy();
    mocks.system.mockResolvedValue({ stdout: 'active\n' });
    await expect(service.migrate(project)).rejects.toThrow('finishing');
    expect((await service.status(project)).migrated).toBe(false);
  });

  it('serializes worker runs and publishes structured completion', async () => {
    await service.save(project, config);
    let release!: (value: unknown) => void;
    vi.spyOn(service as any, 'worker').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    await service.startRun(project, 'preview');
    await vi.waitFor(() => expect(release).toBeDefined());
    await expect(service.startRun(project, 'sync')).rejects.toThrow('already running');
    release({
      changes: [{ issueKey: 'AIP-1', action: 'skip', reason: 'unchanged' }],
      message: 'preview',
    });
    await vi.waitFor(async () => expect((await service.status(project)).running).toBe(false));
    expect((await service.status(project)).runs[0].status).toBe('success');
  });

  it('retains existing manual/auto label rules during legacy config conversion', () => {
    expect(
      legacyJiraConfig({
        jiraUrl: config.jiraUrl,
        jiraProject: 'AIP',
        jql: 'project = AIP',
        jiraLabels: { autoStart: ['dodo'], manualStart: ['kaka'] },
        dispatchEnabled: true,
        model: config.model,
      })
    ).toMatchObject({ autoLabels: ['dodo'], manualLabels: ['kaka'], autoStart: true });
  });

  it('marks an interrupted worker after restart without clearing its dispatch claims', async () => {
    await service.save(project, config);
    const runtime = await (service as any).runtime(project);
    runtime.runs.push({
      id: 'interrupted-run',
      mode: 'sync',
      status: 'running',
      startedAt: new Date().toISOString(),
      trigger: 'manual',
    });
    await (service as any).saveRuntime(runtime);
    await (service as any).write(path.join((service as any).dir(project), 'state.json'), {
      jobs: { 'AIP-1': { dispatchClaim: 'interrupted-run', status: 'dispatching' } },
    });
    await (service as any).poll();
    const status = await service.status(project);
    expect(status.runs[0].status).toBe('interrupted');
    const state = JSON.parse(
      await readFile(path.join((service as any).dir(project), 'state.json'), 'utf8')
    );
    expect(state.jobs['AIP-1'].dispatchClaim).toBe('interrupted-run');
  });

  it('schedules a due project once and respects a paused project', async () => {
    await service.save(project, { ...config, enabled: true });
    const runtime = await (service as any).runtime(project);
    runtime.nextRunAt = new Date(0).toISOString();
    await (service as any).saveRuntime(runtime);
    const worker = vi
      .spyOn(service as any, 'worker')
      .mockResolvedValue({ changes: [], message: 'scheduled' });
    await (service as any).poll();
    await vi.waitFor(async () => expect((await service.status(project)).running).toBe(false));
    expect((await service.status(project)).runs[0].trigger).toBe('schedule');
    await (service as any).poll();
    expect(worker).toHaveBeenCalledTimes(1);
    await service.save(project, config);
    await (service as any).poll();
    expect(worker).toHaveBeenCalledTimes(1);
  });
});
