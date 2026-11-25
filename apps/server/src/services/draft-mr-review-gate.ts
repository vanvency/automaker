import path from 'node:path';
import type { ChangedProject, Feature } from '@automaker/types';
import { getFeaturesDir, getProjectSettingsPath } from '@automaker/platform';
import { execGitCommand } from '@automaker/git-utils';
import * as secureFs from '../lib/secure-fs.js';
import {
  GitLabMergeService,
  parseMergeRequestUrl,
  resolveGitLabToken,
} from './gitlab-merge-service.js';
import { WorktreeResolver } from './worktree-resolver.js';

/** Only current receipts of downstream Stories may account for later shared-branch work. */
async function downstreamProjects(
  projectPath: string,
  feature: Feature,
  workDir: string
): Promise<ChangedProject[]> {
  if (feature.issueType !== 'Story' || !feature.epicJiraKey) return [];
  const directory = getFeaturesDir(projectPath);
  const entries = await secureFs.readdir(directory, { withFileTypes: true });
  const siblings: Feature[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === feature.id) continue;
    try {
      const sibling = JSON.parse(
        (await secureFs.readFile(
          path.join(directory, entry.name, 'feature.json'),
          'utf8'
        )) as string
      ) as Feature;
      if (
        sibling.id === entry.name &&
        sibling.issueType === 'Story' &&
        sibling.epicJiraKey === feature.epicJiraKey &&
        sibling.jiraInstanceUrl === feature.jiraInstanceUrl &&
        sibling.branchName === feature.branchName &&
        !sibling.archive &&
        !sibling.supersededBy &&
        !sibling.consolidationPlanId
      )
        siblings.push(sibling);
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error;
    }
  }
  const downstream = new Set([feature.id]);
  let count: number;
  do {
    count = downstream.size;
    for (const sibling of siblings) {
      if (sibling.dependencies?.some((id) => downstream.has(id))) downstream.add(sibling.id);
    }
  } while (downstream.size !== count);

  const projects: ChangedProject[] = [];
  for (const sibling of siblings) {
    if (
      !downstream.has(sibling.id) ||
      !sibling.executionRunId ||
      sibling.herdrExecution ||
      !['waiting_approval', 'verified', 'completed', 'failed'].includes(sibling.status ?? '') ||
      sibling.jiraDelivery?.issueKey !== sibling.jiraKey ||
      sibling.jiraDelivery?.worktree !== workDir ||
      sibling.jiraDelivery?.branch !== feature.branchName
    )
      continue;
    try {
      const receipt = JSON.parse(
        (await secureFs.readFile(
          path.join(workDir, '.automaker', 'jira', sibling.id, 'jira-result.json'),
          'utf8'
        )) as string
      );
      if (
        receipt.issueKey === sibling.jiraKey &&
        receipt.runId === sibling.executionRunId &&
        ['mr_created', 'development_complete'].includes(receipt.outcome) &&
        Array.isArray(receipt.changedProjects)
      )
        projects.push(...receipt.changedProjects);
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error;
    }
  }
  return projects;
}

/**
 * Shared by agent/pipeline status updates and manual feature updates. A Jira
 * New delivery requires a live Draft MR for review. A subproject MR already
 * merged into the exact checked-out revision can be included in that delivery.
 * Restoring a human-confirmed delivery may reuse all its merged MRs.
 * This check is read-only: creating MRs belongs to the agent's delivery contract.
 */
export async function gateDraftMrReview(
  projectPath: string,
  feature: Feature
): Promise<Partial<Feature>> {
  if (!feature.jiraKey || !['waiting_approval', 'verified'].includes(feature.status ?? '')) {
    return {};
  }

  try {
    const confirmedDelivery =
      feature.completionSource === 'human' &&
      feature.deliveryCompletion?.status === 'succeeded' &&
      ['preview', 'merge', 'jira'].every((id) =>
        feature.deliveryCompletion!.steps.some(
          (step) => step.id === id && ['succeeded', 'skipped'].includes(step.status)
        )
      );
    if (!feature.branchName) throw new Error('Task branch is missing.');
    const workDir = await new WorktreeResolver().findWorktreeForBranch(
      projectPath,
      feature.branchName
    );
    if (!workDir) throw new Error('Task Worktree is unavailable.');
    let delivery: Pick<Feature, 'changedProjects' | 'mergeRequests'> = feature;
    if (feature.executionRunId) {
      // Never accept an earlier run's delivery after a follow-up changed the code.
      const receipt = JSON.parse(
        (await secureFs.readFile(
          path.join(workDir, '.automaker', 'jira', feature.id, 'jira-result.json'),
          'utf8'
        )) as string
      );
      if (receipt.runId !== feature.executionRunId || receipt.issueKey !== feature.jiraKey) {
        throw new Error('A delivery receipt for the current execution is required.');
      }
      if (!['mr_created', 'development_complete'].includes(receipt.outcome)) {
        const summary =
          typeof receipt.summary === 'string' ? receipt.summary.trim().slice(0, 2000) : '';
        const blockers = Array.isArray(receipt.blockers)
          ? receipt.blockers
              .filter((item: unknown): item is string => typeof item === 'string' && !!item.trim())
              .slice(0, 10)
              .map((item: string) => `- ${item.trim().slice(0, 500)}`)
          : [];
        throw new Error(
          [summary, blockers.length ? `阻塞原因：\n${blockers.join('\n')}` : '']
            .filter(Boolean)
            .join('\n\n') ||
            'Development is not complete; resolve the delivery receipt blockers first.'
        );
      }
      if (Array.isArray(receipt.blockers) && receipt.blockers.length > 0) {
        throw new Error(
          `Resolve the delivery receipt blockers before requesting review: ${receipt.blockers.join('; ')}`
        );
      }
      delivery = receipt;
    }

    const projects = delivery.changedProjects;
    if (!Array.isArray(projects) || projects.length === 0) {
      throw new Error('Record every changed repository and its Draft MR in changedProjects.');
    }
    const config = JSON.parse(
      (await secureFs.readFile(getProjectSettingsPath(projectPath), 'utf8')) as string
    ).jiraSync;
    if (!config?.gitlabHost || !config?.targetBranch) {
      throw new Error('Configure the project GitLab host and target branch before review.');
    }

    // Resolve repository labels using the actual checkout, never arbitrary paths
    // supplied by an agent receipt.
    const repositories = [{ name: path.basename(projectPath), dir: workDir }];
    try {
      const modules = await execGitCommand(
        ['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'],
        workDir
      );
      for (const line of modules.trim().split('\n')) {
        const name = line.slice(line.indexOf(' ') + 1).trim();
        const dir = path.resolve(workDir, name);
        if (!name || !dir.startsWith(path.resolve(workDir) + path.sep)) {
          throw new Error('Invalid submodule path.');
        }
        repositories.push({ name, dir });
      }
    } catch (error) {
      // git config exits 1 when no submodule paths exist. Other failures are not
      // safe to ignore when the receipt claims subproject changes.
      if (projects.some((p) => p?.name !== path.basename(projectPath))) {
        throw new Error('Could not resolve changed repositories from .gitmodules.');
      }
    }

    const token = await resolveGitLabToken();
    if (!token) throw new Error('GitLab credentials unavailable; Draft MRs could not be verified.');
    const gitlab = new GitLabMergeService(token);
    const checked = new Set<string>();
    const checkedDirs = new Set<string>();
    let openDrafts = 0;
    const matchesRepository = (repo: { name: string; dir: string }, name: string) =>
      repo.name === name ||
      path.basename(repo.name) === path.basename(name) ||
      (repo.dir === workDir && (name === `${repo.name} (root)` || name === 'root'));
    const verifyProject = async (project: ChangedProject) => {
      if (!project || typeof project.name !== 'string' || typeof project.mrUrl !== 'string') {
        throw new Error(`Draft MR missing for ${project?.name || 'a changed repository'}.`);
      }
      const url = new URL(project.mrUrl);
      const mr = parseMergeRequestUrl(project.mrUrl);
      if (
        !mr ||
        !['http:', 'https:'].includes(url.protocol) ||
        url.host !== config.gitlabHost ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new Error(`Invalid or untrusted MR URL for ${project.name}.`);
      }
      const matches = repositories.filter((repo) => matchesRepository(repo, project.name));
      if (matches.length !== 1) throw new Error(`Ambiguous repository: ${project.name}.`);
      const repo = matches[0];
      const remote = (await execGitCommand(['remote', 'get-url', 'origin'], repo.dir)).trim();
      const remoteUrl = new URL(
        remote.includes('://') ? remote : remote.replace(/^([^:]+):/, 'ssh://$1/')
      );
      const remotePath = remoteUrl.pathname
        .replace(/^\//, '')
        .replace(/\.git\/?$/, '')
        .replace(/\/$/, '');
      if (
        remoteUrl.hostname !== url.hostname ||
        remotePath !== mr.project ||
        checked.has(mr.project)
      ) {
        throw new Error(`MR does not uniquely match repository ${project.name}.`);
      }
      const state = await gitlab.getMergeRequest(project.mrUrl);
      const head = (await execGitCommand(['rev-parse', 'HEAD'], repo.dir)).trim();
      const confirmedMerged =
        confirmedDelivery &&
        feature.mergeRequests?.includes(project.mrUrl) &&
        state?.state === 'merged';
      const mergedIntoCheckout =
        state?.state === 'merged' &&
        (state.sha === head || state.mergeCommitSha === head || state.squashCommitSha === head);
      const openDraft = state?.state === 'opened' && state.draft;
      if (!state || (!openDraft && !confirmedMerged && !mergedIntoCheckout)) {
        throw new Error(
          `An open Draft MR or a merged MR matching the checked-out revision is required for ${project.name}.`
        );
      }
      if (state.sourceBranch !== feature.branchName || state.targetBranch !== config.targetBranch) {
        throw new Error(`MR branches do not match the task for ${project.name}.`);
      }
      if (openDraft) openDrafts++;
      if (openDraft && (!state.sha || state.sha !== head)) {
        throw new Error(`Push the current ${project.name} revision before requesting review.`);
      }
      if (confirmedMerged && !mergedIntoCheckout && state.sha !== head) {
        throw new Error(
          `The merged ${project.name} MR no longer matches the checked-out revision.`
        );
      }
      checked.add(mr.project);
      checkedDirs.add(repo.dir);
    };
    for (const project of projects) await verifyProject(project);
    const storyOpenDrafts = openDrafts;
    let downstream: ChangedProject[] | undefined;
    // Every changed repository still needs a verified MR. A downstream Story
    // may account for later work without rewriting this Story's receipt.
    for (const repo of repositories.filter((candidate) => !checkedDirs.has(candidate.dir))) {
      let root: string;
      try {
        root = (await execGitCommand(['rev-parse', '--show-toplevel'], repo.dir)).trim();
      } catch {
        continue;
      }
      if (path.resolve(root) !== path.resolve(repo.dir)) continue;
      const branch = (await execGitCommand(['branch', '--show-current'], repo.dir)).trim();
      if (branch !== feature.branchName) continue;
      const changes = await execGitCommand(
        ['diff', '--name-only', `refs/remotes/origin/${config.targetBranch}...HEAD`, '--'],
        repo.dir
      );
      if (changes.trim()) {
        if (repo.dir === workDir) {
          throw new Error(`Draft MR missing for changed repository ${repo.name}.`);
        }
        downstream ??= await downstreamProjects(projectPath, feature, workDir);
        const deliveries = downstream.filter(
          (project) =>
            typeof project?.name === 'string' &&
            typeof project.mrUrl === 'string' &&
            matchesRepository(repo, project.name)
        );
        const urls = new Set(deliveries.map((project) => project.mrUrl));
        if (urls.size !== 1) {
          throw new Error(`Draft MR missing for changed repository ${repo.name}.`);
        }
        await verifyProject(deliveries[0]);
      }
    }
    if (
      !confirmedDelivery &&
      storyOpenDrafts === 0 &&
      !(
        feature.status === 'verified' &&
        feature.completionSource === 'human' &&
        !feature.deliveryCompletion
      )
    ) {
      throw new Error('At least one open Draft MR is required before review.');
    }
    return {
      changedProjects: projects,
      mergeRequests: projects.map((project) => project.mrUrl!),
      ...(feature.executionNotice?.source === 'delivery' && feature.executionNotice.kind === 'error'
        ? { error: undefined, executionNotice: undefined }
        : {}),
    };
  } catch (error) {
    const message = `Draft MR delivery required before review: ${error instanceof Error ? error.message : 'verification failed'}`;
    return {
      status: 'failed',
      error: message,
      executionNotice: {
        kind: 'error',
        source: 'delivery',
        message,
        occurredAt: new Date().toISOString(),
      },
    };
  }
}
