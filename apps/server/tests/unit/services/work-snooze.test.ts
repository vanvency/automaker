import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Request, Response } from 'express';
import { FeatureLoader } from '../../../src/services/feature-loader.js';
import { createSnoozeHandler } from '../../../src/routes/worktree/routes/snooze.js';
import {
  assertWorkNotSnoozed,
  readWorkSnoozes,
  changingWorkSnoozes,
} from '../../../src/services/work-snooze.js';
import type { AutoModeServiceCompat } from '../../../src/services/auto-mode/index.js';

const mocks = vi.hoisted(() => ({
  trees: vi.fn(),
  agents: vi.fn(),
  running: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('../../../src/services/worktree-resolver.js', () => ({
  WorktreeResolver: class {
    listWorktrees = mocks.trees;
  },
}));
vi.mock('../../../src/services/herdr-task-service.js', () => ({
  getHerdrTaskService: () => ({
    isAvailable: async () => true,
    getClient: () => ({ listAgents: mocks.agents }),
  }),
}));
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it('snoozes a whole branch, blocks new tasks and busy agents, and restores without changing task state', async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'work-snooze-'));
  directories.push(project);
  const tree = { branch: 'task/a', path: path.join(project, '.worktrees/a'), isMain: false };
  mocks.trees.mockResolvedValue([tree, { branch: 'main', path: project, isMain: true }]);
  mocks.running.mockResolvedValue([]);
  mocks.agents.mockResolvedValue([]);
  changingWorkSnoozes.add(project);
  await expect(assertWorkNotSnoozed(project, 'task/a')).rejects.toThrow('snoozed');
  changingWorkSnoozes.delete(project);
  const loader = new FeatureLoader();
  await loader.create(project, {
    id: 'a',
    title: 'A',
    description: 'A',
    branchName: 'task/a',
    status: 'backlog',
  });
  await loader.create(project, {
    id: 'b',
    title: 'B',
    description: 'B',
    branchName: 'task/b',
    status: 'waiting_approval',
  });
  const original = await readFile(path.join(project, '.automaker/features/a/feature.json'), 'utf8');
  const handler = createSnoozeHandler(loader, {
    getRunningAgents: mocks.running,
    createFacade: () => ({ stopAutoLoop: mocks.stop }),
  } as unknown as AutoModeServiceCompat);
  const call = async (body: Record<string, unknown>) => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(
      { body: { projectPath: project, branchName: 'task/a', snoozed: true, ...body } } as Request,
      res as unknown as Response
    );
    return res;
  };
  mocks.agents.mockResolvedValue([{ agent_status: 'working', cwd: tree.path }]);
  expect((await call({})).status).toHaveBeenCalledWith(409);
  expect(await readWorkSnoozes(project)).toEqual({});
  mocks.agents.mockResolvedValue([]);
  mocks.running.mockResolvedValue([{ projectPath: project, branchName: 'task/a', featureId: 'a' }]);
  expect((await call({})).status).toHaveBeenCalledWith(409);
  mocks.running.mockResolvedValue([]);
  expect((await call({ reason: 'Later' })).json).toHaveBeenCalledWith(
    expect.objectContaining({ success: true })
  );
  expect(mocks.stop).toHaveBeenCalledWith('task/a');
  expect((await loader.get(project, 'a'))?.worktreeSnooze?.reason).toBe('Later');
  expect((await loader.get(project, 'b'))?.worktreeSnooze).toBeUndefined();
  await expect(assertWorkNotSnoozed(project, 'task/a')).rejects.toThrow('Resume it in Work Board');
  await loader.create(project, {
    id: 'new',
    title: 'New',
    description: 'New',
    branchName: 'task/a',
    status: 'backlog',
  });
  expect((await loader.getAll(project)).find((f) => f.id === 'new')?.worktreeSnooze).toBeDefined();
  expect(await readFile(path.join(project, '.automaker/features/a/feature.json'), 'utf8')).toBe(
    original
  );
  expect((await call({ snoozed: false })).json).toHaveBeenCalledWith(
    expect.objectContaining({ success: true })
  );
  await expect(assertWorkNotSnoozed(project, 'task/a')).resolves.toBeUndefined();
  expect((await loader.get(project, 'a'))?.status).toBe('backlog');
  expect((await loader.get(project, 'new'))?.worktreeSnooze).toBeUndefined();
  expect((await call({ branchName: 'main' })).status).toHaveBeenCalledWith(400);
  expect((await call({ reason: 12 })).status).toHaveBeenCalledWith(400);
  await writeFile(path.join(project, '.automaker/work-snoozes.json'), 'broken');
  await expect(assertWorkNotSnoozed(project, 'task/a')).rejects.toThrow();
});
