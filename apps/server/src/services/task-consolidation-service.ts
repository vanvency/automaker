import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from '../lib/secure-fs.js';
import type { ConsolidationPlan, Feature } from '@automaker/types';
import { getChildFeaturesForParent } from '@automaker/types';
import type { FeatureLoader } from './feature-loader.js';
import type { SettingsService } from './settings-service.js';
import { findSimilarTasks, independentTaskRoots, taskSummary } from './similar-tasks.js';
import { buildFeatureMergePlan } from './feature-merge-plan.js';
import {
  parseMergeRequestUrl,
  resolveGitLabToken,
  GitLabMergeService,
} from './gitlab-merge-service.js';
import { getHerdrTaskService } from './herdr-task-service.js';

const worker = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../scripts/task-consolidation-jira.py'
);
const mrUrls = (feature: Feature) => buildFeatureMergePlan(feature).map((mr) => mr.mrUrl);
const mrKey = (url: string) => {
  const mr = parseMergeRequestUrl(url);
  return mr ? `${new URL(mr.host).host}/${mr.project}/${mr.iid}` : url;
};
const stamp = (feature: Feature) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        ...feature,
        updatedAt: undefined,
        justFinishedAt: undefined,
      })
    )
    .digest('hex');
const pairStamp = (keep: Feature, retire: Feature) => `${stamp(keep)}:${stamp(retire)}`;
const projectId = (project: string) =>
  createHash('sha256').update(path.resolve(project)).digest('hex').slice(0, 24);

export interface ConsolidationExternal {
  jira(input: Record<string, string>): Promise<NonNullable<ConsolidationPlan['jira']>>;
  mr(url: string): ReturnType<GitLabMergeService['getMergeRequest']>;
  closeMr(url: string): Promise<void>;
  busyConversations?(project: string, features: Feature[]): Promise<boolean>;
}
export const consolidationExternal: ConsolidationExternal = {
  busyConversations: async (project, features) => {
    const service = getHerdrTaskService(project);
    if (!(await service.isAvailable())) return false;
    const agents = await service.getClient().listAgents();
    return agents.some(
      (agent) =>
        features.some(
          (feature) =>
            feature.herdrWorkspaceId === agent.workspace_id &&
            (!feature.herdrTabId || feature.herdrTabId === agent.tab_id)
        ) && !['idle', 'done'].includes(agent.agent_status)
    );
  },
  jira: (input) =>
    new Promise((resolve, reject) => {
      const child = spawn('python3', [worker], { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
      child.stdout.on('data', (chunk) => {
        output = (output + chunk).slice(-100000);
      });
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(input));
      child.on('error', () => {
        clearTimeout(timer);
        reject(new Error('Could not start Jira worker'));
      });
      child.on('close', () => {
        clearTimeout(timer);
        try {
          const result = JSON.parse(output);
          if (!result.success) throw new Error(result.error);
          resolve(result.result);
        } catch (error) {
          reject(new Error(output ? (error as Error).message : 'Jira request timed out'));
        }
      });
    }),
  mr: async (url) => {
    const token = await resolveGitLabToken();
    if (!token) throw new Error('GitLab credentials unavailable');
    return new GitLabMergeService(token).getMergeRequest(url);
  },
  closeMr: async (url) => {
    const token = await resolveGitLabToken();
    const parsed = parseMergeRequestUrl(url);
    if (!token || !parsed) throw new Error('GitLab credentials or MR URL invalid');
    const result = await fetch(
      `${parsed.host}/api/v4/projects/${encodeURIComponent(parsed.project)}/merge_requests/${parsed.iid}`,
      {
        method: 'PUT',
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state_event: 'close' }),
      }
    );
    if (!result.ok) throw new Error(`GitLab close returned HTTP ${result.status}`);
  },
};

export class TaskConsolidationService {
  private busy = new Set<string>();
  constructor(
    private loader: FeatureLoader,
    private settings: SettingsService,
    private dataDir: string,
    private running: (project: string) => Promise<string[]>,
    private external: ConsolidationExternal = consolidationExternal
  ) {}
  private directory(project: string) {
    return path.join(path.resolve(this.dataDir), 'task-consolidation', projectId(project));
  }
  private async save(plan: ConsolidationPlan) {
    const dir = this.directory(plan.projectPath);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${plan.id}.json`);
    const temp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(plan, null, 2), { mode: 0o600 });
    await fs.rename(temp, file);
  }
  private async load(project: string, id: string): Promise<ConsolidationPlan> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid plan ID');
    const plan = JSON.parse(
      (await fs.readFile(path.join(this.directory(project), `${id}.json`), 'utf8')) as string
    );
    if (plan.projectPath !== project) throw new Error('Plan belongs to another project');
    return plan;
  }
  async list(project: string) {
    const features = await this.loader.getAll(project);
    let files: string[] = [];
    try {
      files = (await fs.readdir(this.directory(project))) as string[];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const history = await Promise.all(
      files
        .filter((file) => /^[a-f0-9-]{36}\.json$/.test(file))
        .slice(-100)
        .map((file) => this.load(project, file.slice(0, -5)))
    );
    return {
      pairs: findSimilarTasks(features),
      tasks: independentTaskRoots(features).map(taskSummary),
      history: history.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  }
  private async pair(project: string, keepId: string, retireId: string) {
    if (
      typeof keepId !== 'string' ||
      typeof retireId !== 'string' ||
      keepId === retireId ||
      !/^[\w-]+$/.test(keepId) ||
      !/^[\w-]+$/.test(retireId)
    )
      throw new Error('Choose two distinct tasks');
    const [keep, retire] = await Promise.all([
      this.loader.get(project, keepId),
      this.loader.get(project, retireId),
    ]);
    if (!keep || !retire) throw new Error('Task not found');
    if (keep.archive || keep.supersededBy || keep.consolidationPlanId)
      throw new Error('The retained task is already covered or being consolidated');
    return { keep, retire };
  }
  private async blockers(project: string, keep: Feature, retire: Feature) {
    const active = await this.running(project);
    const blockers: string[] = [];
    if (active.includes(keep.id) || active.includes(retire.id))
      blockers.push('One of the tasks is running; stop or wait before consolidating');
    if (await this.external.busyConversations?.(project, [keep, retire])) {
      blockers.push(
        'A task has an active or waiting herdr conversation; finish it before consolidating'
      );
    }
    if (keep.jiraKey && keep.jiraKey === retire.jiraKey)
      blockers.push(
        'Both cards refer to the same Jira issue; closing Jira would also close the retained issue'
      );
    const features = await this.loader.getAll(project);
    if (getChildFeaturesForParent(retire, features).some((f) => !f.supersededBy)) {
      blockers.push('The retired task has active child cards; reconcile their scope first');
    }
    if (
      features.some(
        (f) => f.id !== retire.id && f.dependencies?.includes(retire.id) && !f.supersededBy
      )
    ) {
      blockers.push('Other tasks depend on the retired task; update their dependencies first');
    }
    return blockers;
  }
  private async allowedMr(project: string, url: string) {
    const config = (await this.settings.getProjectSettings(project)).jiraSync;
    const parsed = parseMergeRequestUrl(url);
    const u = new URL(url);
    if (
      !parsed ||
      !['http:', 'https:'].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !config?.gitlabHost ||
      u.host !== config.gitlabHost
    )
      throw new Error('MR host does not match the project GitLab configuration');
    return parsed;
  }
  private async shared(project: string, retire: Feature, url: string) {
    return (await this.loader.getAll(project))
      .filter(
        (f) =>
          f.id !== retire.id &&
          !f.supersededBy &&
          (mrUrls(f).some((other) => mrKey(other) === mrKey(url)) ||
            (retire.branchName && f.branchName === retire.branchName))
      )
      .map((f) => f.jiraKey || f.id);
  }
  async plan(project: string, keepId: string, retireId: string, reason: string) {
    if (typeof reason !== 'string' || reason.trim().length < 5 || reason.length > 4000)
      throw new Error('Describe why the retained task covers the other task');
    const { keep, retire } = await this.pair(project, keepId, retireId);
    const roots = new Set(
      independentTaskRoots(await this.loader.getAll(project)).map((task) => task.id)
    );
    if (!roots.has(keep.id) || !roots.has(retire.id)) {
      throw new Error(
        'Only independent parent tasks can be compared; choose the top-level task instead of its subtasks'
      );
    }
    if (retire.supersededBy || retire.consolidationPlanId)
      throw new Error('This task already has a consolidation; resume its existing plan');
    const plan: ConsolidationPlan = {
      id: randomUUID(),
      projectPath: project,
      keep: taskSummary(keep),
      retire: taskSummary(retire),
      reason: reason.trim(),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
      status: 'planned',
      fingerprint: pairStamp(keep, retire),
      blockers: await this.blockers(project, keep, retire),
      warnings: [
        'Similarity is not proof of coverage. Review both requirements and acceptance results.',
        'Closing an MR does not revert merged code. Worktrees, branches, conversations and acceptance screenshots are preserved.',
      ],
      mergeRequests: [],
      steps: [],
    };
    if (keep.status !== 'completed' && keep.status !== 'verified')
      plan.warnings.push(
        'The retained task has not passed acceptance. Coverage does not mean the feature has been delivered.'
      );
    for (const url of mrUrls(retire)) {
      try {
        await this.allowedMr(project, url);
        const shared = await this.shared(project, retire, url);
        const mr = await this.external.mr(url);
        if (!mr) throw new Error('Could not read MR');
        const owned = !!retire.branchName && mr.sourceBranch === retire.branchName;
        const close = owned && !shared.length && mr.state === 'opened';
        plan.mergeRequests.push({
          url,
          state: mr.state,
          sourceBranch: mr.sourceBranch,
          sha: mr.sha,
          action: close ? 'close' : 'preserve',
          reason: shared.length
            ? `Shared with ${shared.join(', ')}`
            : !owned
              ? 'Source branch differs from the task branch'
              : mr.state === 'merged'
                ? 'Already merged; preserve history'
                : mr.state === 'closed'
                  ? 'Already closed'
                  : 'Exclusive open MR of the retired task',
        });
      } catch (error) {
        plan.mergeRequests.push({
          url,
          state: 'unknown',
          action: 'preserve',
          reason: (error as Error).message,
        });
        plan.warnings.push(`MR could not be inspected: ${url}`);
      }
    }
    if (retire.jiraKey) {
      const config = (await this.settings.getProjectSettings(project)).jiraSync;
      try {
        if (!config?.jiraUrl)
          throw new Error('Configure the project Jira site before closing Jira');
        if (retire.jiraUrl && new URL(retire.jiraUrl).origin !== new URL(config.jiraUrl).origin)
          throw new Error('Task Jira site differs from project configuration');
        plan.jira = await this.external.jira({
          action: 'inspect',
          server: config.jiraUrl,
          key: retire.jiraKey,
        });
      } catch (error) {
        plan.jira = {
          key: retire.jiraKey,
          url: retire.jiraUrl || '',
          status: 'unknown',
          updated: '',
          done: false,
          transitions: [],
          error: (error as Error).message,
        };
      }
    }
    await this.save(plan);
    return plan;
  }
  async apply(
    project: string,
    id: string,
    selection: NonNullable<ConsolidationPlan['selection']>,
    confirmation: string
  ) {
    const lock = projectId(project);
    if (this.busy.has(lock)) throw new Error('A consolidation is running for this project');
    this.busy.add(lock);
    try {
      const plan = await this.load(project, id);
      if (confirmation !== (plan.retire.jiraKey || plan.retire.id))
        throw new Error('Type the exact retired issue key to confirm');
      if (plan.status === 'complete') return plan;
      if (plan.status === 'cancelled') throw new Error('Plan was cancelled');
      if (
        !selection ||
        !Array.isArray(selection.mrUrls) ||
        typeof selection.closeJira !== 'boolean'
      )
        throw new Error('Invalid cleanup selection');
      if (plan.selection && JSON.stringify(plan.selection) !== JSON.stringify(selection))
        throw new Error('Cleanup choices are locked after execution starts');
      if (!plan.selection && Date.parse(plan.expiresAt) < Date.now())
        throw new Error('Plan expired; generate a fresh preview');
      const { keep, retire } = await this.pair(project, plan.keep.id, plan.retire.id);
      const roots = new Set(
        independentTaskRoots(
          (await this.loader.getAll(project)).map((task) =>
            task.id === retire.id && task.consolidationPlanId === plan.id
              ? { ...task, consolidationPlanId: undefined }
              : task
          )
        ).map((task) => task.id)
      );
      if (!roots.has(keep.id) || !roots.has(retire.id)) {
        throw new Error(
          'Task hierarchy changed or this is a subtask; compare independent parent tasks only'
        );
      }
      if (retire.supersededBy && retire.supersededBy.planId !== plan.id)
        throw new Error('Task was superseded by another plan');
      if (retire.consolidationPlanId && retire.consolidationPlanId !== plan.id)
        throw new Error('Another plan owns this task');
      if (!plan.selection && pairStamp(keep, retire) !== plan.fingerprint)
        throw new Error('Task changed since preview; generate a fresh plan');
      const blockers = await this.blockers(project, keep, retire);
      if (blockers.length) throw new Error(blockers.join('; '));
      for (const url of selection.mrUrls) {
        const mr = plan.mergeRequests.find((entry) => entry.url === url);
        if (!mr || mr.action !== 'close')
          throw new Error('Cannot close an unapproved or shared MR');
      }
      if (
        selection.closeJira &&
        (!plan.jira ||
          plan.jira.error ||
          (!plan.jira.done && !plan.jira.transitions.some((t) => t.id === selection.transitionId)))
      ) {
        throw new Error('Select an available Jira terminal transition');
      }
      // Preflight every external action again before mutating any resource.
      for (const url of selection.mrUrls) {
        await this.allowedMr(project, url);
        if ((await this.shared(project, retire, url)).length)
          throw new Error('MR is now shared; cleanup refused');
        const current = await this.external.mr(url);
        const expected = plan.mergeRequests.find((mr) => mr.url === url)!;
        if (
          !current ||
          current.sourceBranch !== expected.sourceBranch ||
          current.sha !== expected.sha ||
          current.state === 'merged'
        ) {
          throw new Error('MR changed since preview; inspect before continuing');
        }
      }
      const config = (await this.settings.getProjectSettings(project)).jiraSync;
      if (selection.closeJira && plan.jira) {
        if (!config || new URL(plan.jira.url).origin !== new URL(config.jiraUrl).origin)
          throw new Error('Jira site changed since preview');
        const current = await this.external.jira({
          action: 'inspect',
          server: config.jiraUrl,
          key: plan.jira.key,
        });
        if (!current.done && current.updated !== plan.jira.updated)
          throw new Error('Jira changed since preview; generate a new plan');
      }
      plan.selection = selection;
      plan.status = 'running';
      await this.save(plan);
      // Claim locally before external writes so retries/restarts cannot dispatch this task.
      await this.loader.update(project, retire.id, { consolidationPlanId: plan.id });
      if (
        (await this.running(project)).some((featureId) => [keep.id, retire.id].includes(featureId))
      ) {
        // A run admitted between preflight and the durable claim must finish first.
        plan.status = 'partial';
        await this.save(plan);
        throw new Error(
          'Task started while cleanup was being claimed; wait for it to finish and resume this plan'
        );
      }
      const step = async (target: string, operation: () => Promise<void>) => {
        let record = plan.steps.find((entry) => entry.target === target);
        if (record?.status === 'done') return;
        if (!record) {
          record = { target, status: 'running' };
          plan.steps.push(record);
        }
        record.status = 'running';
        delete record.message;
        await this.save(plan);
        try {
          await operation();
          record.status = 'done';
        } catch (error) {
          record.status = 'failed';
          record.message = (error as Error).message;
          throw error;
        } finally {
          await this.save(plan);
        }
      };
      try {
        for (const url of selection.mrUrls) {
          await step(url, async () => {
            const current = await this.external.mr(url);
            if (current?.state === 'closed') return;
            if (current?.state !== 'opened') throw new Error('MR is no longer open');
            await this.external.closeMr(url);
            if ((await this.external.mr(url))?.state !== 'closed')
              throw new Error('MR closure could not be verified');
          });
        }
        if (selection.closeJira && plan.jira) {
          await step(`jira:${plan.jira.key}`, async () => {
            const result = await this.external.jira({
              action: 'close',
              server: config!.jiraUrl,
              key: plan.jira!.key,
              transitionId: selection.transitionId || '',
              expectedUpdated: plan.jira!.updated,
            });
            if (!result.done) throw new Error('Jira closure could not be verified');
            plan.jira = result;
          });
        }
        await step(`card:${retire.id}`, async () => {
          await this.loader.update(project, retire.id, {
            status: 'completed',
            error: undefined,
            executionNotice: undefined,
            consolidationPlanId: undefined,
            supersededBy: {
              featureId: keep.id,
              jiraKey: keep.jiraKey,
              reason: plan.reason,
              planId: plan.id,
              at: new Date().toISOString(),
            },
            ...(selection.closeJira && plan.jira ? { jiraStatus: plan.jira.status } : {}),
          });
        });
        plan.status = 'complete';
      } catch {
        plan.status = 'partial';
      }
      await this.save(plan);
      return plan;
    } finally {
      this.busy.delete(lock);
    }
  }

  /** Release a stale partial plan without undoing already-completed external actions. */
  async cancel(project: string, id: string, confirmation: string) {
    const lock = projectId(project);
    if (this.busy.has(lock)) throw new Error('Wait for the active cleanup request to finish');
    this.busy.add(lock);
    try {
      const plan = await this.load(project, id);
      if (confirmation !== (plan.retire.jiraKey || plan.retire.id))
        throw new Error('Type the retired issue key to cancel');
      if (plan.status === 'complete')
        throw new Error('Completed consolidation cannot be cancelled');
      plan.status = 'cancelled';
      plan.warnings.push(
        'Plan cancelled; completed MR/Jira actions remain as recorded. Remaining resources were preserved.'
      );
      await this.save(plan);
      const feature = await this.loader.get(project, plan.retire.id);
      if (feature?.consolidationPlanId === plan.id && !feature.supersededBy) {
        await this.loader.update(project, feature.id, { consolidationPlanId: undefined });
      }
      return plan;
    } finally {
      this.busy.delete(lock);
    }
  }
}
