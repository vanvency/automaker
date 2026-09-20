import type { Feature, TaskArchiveRequest } from '@automaker/types';
import { TASK_ARCHIVE_REASONS } from '@automaker/types';
import type { FeatureLoader } from './feature-loader.js';
import { getHerdrTaskService } from './herdr-task-service.js';

export function validateArchiveRequest(value: unknown): TaskArchiveRequest {
  const input = value as TaskArchiveRequest;
  if (!input || !Object.hasOwn(TASK_ARCHIVE_REASONS, input.reason))
    throw new Error('Select an archive reason');
  if (
    typeof input.description !== 'string' ||
    input.description.trim().length < 5 ||
    input.description.length > 8000
  ) {
    throw new Error('Provide a detailed archive description (5–8000 characters)');
  }
  if (
    input.reason === 'duplicate' &&
    (typeof input.duplicateOf !== 'string' || !/^[\w-]+$/.test(input.duplicateOf))
  ) {
    throw new Error('Select the task this duplicates');
  }
  return {
    reason: input.reason,
    description: input.description.trim(),
    ...(input.reason === 'duplicate' ? { duplicateOf: input.duplicateOf } : {}),
  };
}

export class TaskArchiveService {
  private locks = new Set<string>();
  constructor(
    private loader: FeatureLoader,
    private running: (project: string) => Promise<string[]>,
    private conversationBusy = async (project: string, features: Feature[]) => {
      const service = getHerdrTaskService(project);
      if (!(await service.isAvailable())) return false;
      const agents = await service.getClient().listAgents();
      return agents.some(
        (agent) =>
          !['idle', 'done'].includes(agent.agent_status) &&
          features.some(
            (f) =>
              f.herdrWorkspaceId === agent.workspace_id &&
              (!f.herdrTabId || f.herdrTabId === agent.tab_id)
          )
      );
    }
  ) {}
  async archive(project: string, ids: string[], value: unknown) {
    const request = validateArchiveRequest(value);
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 200 ||
      ids.some((id) => typeof id !== 'string' || !/^[\w-]+$/.test(id))
    ) {
      throw new Error('Select 1–200 valid tasks');
    }
    if (this.locks.has(project)) throw new Error('An archive operation is already running');
    this.locks.add(project);
    try {
      const features = await Promise.all(
        [...new Set(ids)].map((id) => this.loader.get(project, id))
      );
      if (features.some((f) => !f)) throw new Error('Task not found');
      const tasks = features as Feature[];
      const duplicate = request.duplicateOf
        ? await this.loader.get(project, request.duplicateOf)
        : null;
      if (
        request.reason === 'duplicate' &&
        (!duplicate ||
          ids.includes(duplicate.id) ||
          duplicate.archive ||
          duplicate.supersededBy ||
          duplicate.consolidationPlanId)
      ) {
        throw new Error('Duplicate target must be another active task outside this selection');
      }
      const running = await this.running(project);
      if (
        tasks.some(
          (f) =>
            running.includes(f.id) ||
            f.status === 'in_progress' ||
            f.status?.startsWith('pipeline_')
        ) ||
        (await this.conversationBusy(project, tasks))
      )
        throw new Error('Stop the running task or conversation before archiving');
      if (tasks.some((f) => f.consolidationPlanId || f.supersededBy))
        throw new Error(
          'A task is being consolidated or already covered; use Similar Works to inspect it'
        );
      const results = [];
      for (const task of tasks) {
        if (task.archive) {
          results.push(task);
          continue;
        }
        const archive = {
          ...request,
          previousStatus: task.status || 'backlog',
          archivedAt: new Date().toISOString(),
          ...(duplicate
            ? { duplicateTitle: duplicate.title, duplicateJiraKey: duplicate.jiraKey }
            : {}),
        };
        results.push(
          await this.loader.update(project, task.id, {
            status: 'completed',
            archive,
            archiveHistory: [...(task.archiveHistory ?? []), archive],
          })
        );
      }
      return results;
    } finally {
      this.locks.delete(project);
    }
  }
  async restore(project: string, id: string) {
    if (this.locks.has(project)) throw new Error('An archive operation is already running');
    this.locks.add(project);
    try {
      const task = await this.loader.get(project, id);
      if (!task?.archive) throw new Error('Task has no archive record');
      if (task.supersededBy || task.consolidationPlanId)
        throw new Error('Resolve task consolidation first');
      const archive = task.archive;
      const status =
        ['completed', 'in_progress', 'interrupted'].includes(archive.previousStatus) ||
        archive.previousStatus.startsWith('pipeline_')
          ? 'waiting_approval'
          : archive.previousStatus;
      return await this.loader.update(project, id, {
        status,
        archive: undefined,
        archiveHistory: (task.archiveHistory ?? []).map((record) =>
          record.archivedAt === archive.archivedAt
            ? { ...record, restoredAt: new Date().toISOString() }
            : record
        ),
      });
    } finally {
      this.locks.delete(project);
    }
  }
}
