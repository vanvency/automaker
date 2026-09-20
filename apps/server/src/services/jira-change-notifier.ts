/**
 * Forward Jira requirement edits to the agent that is working on the card.
 *
 * The Jira monitor records every unacknowledged edit on the card
 * (`feature.jiraChanges`). When a description/requirements change lands on an
 * in-progress card that herdr is driving, the change points are summarised and
 * delivered to the agent's pane, so a running task can adapt without a human
 * relaying the diff.
 */

import { createLogger } from '@automaker/utils';
import { DEFAULT_PHASE_MODELS, type Feature } from '@automaker/types';
import { resolvePhaseModel } from '@automaker/model-resolver';
import { streamingQuery } from '../providers/simple-query-service.js';
import { getHerdrTaskService } from './herdr-task-service.js';
import type { SettingsService } from './settings-service.js';

const logger = createLogger('JiraChangeNotify');

/** Upper bound for the summarisation call; the raw diff is the fallback. */
const SUMMARY_TIMEOUT_MS = 60_000;

export interface JiraChangeLike {
  field?: string;
  before?: string;
  after?: string;
  detectedAt?: string;
}

/** Fields that change the task's requirements rather than its metadata. */
const REQUIREMENT_FIELDS = new Set(['description', 'requirements']);

const EXCERPT_CHARS = 400;

function excerpt(value: string | undefined): string | undefined {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…` : text;
}

function fieldLabel(field: string | undefined): string {
  const normalized = String(field ?? '').toLowerCase();
  if (normalized === 'description') return '描述';
  if (normalized === 'requirements') return '需求正文';
  return normalized || '字段';
}

/** Only the edits that change what the agent has to build. */
export function requirementChanges(changes: JiraChangeLike[] | undefined): JiraChangeLike[] {
  return (changes ?? []).filter((change) =>
    REQUIREMENT_FIELDS.has(String(change.field ?? '').toLowerCase())
  );
}

/** Compact "what changed" message handed to the agent. */
export function summarizeRequirementChanges(
  feature: Pick<Feature, 'id' | 'jiraKey' | 'title'>,
  changes: JiraChangeLike[]
): string {
  const key = feature.jiraKey ?? feature.id;
  const lines = changes.map((change) => {
    const before = excerpt(change.before);
    const after = excerpt(change.after);
    if (before && after) return `- ${fieldLabel(change.field)}：${before} → ${after}`;
    if (after) return `- ${fieldLabel(change.field)}（新增）：${after}`;
    return `- ${fieldLabel(change.field)}（移除）：${before ?? ''}`;
  });
  return [
    `Jira ${key} 的需求在本任务执行期间被更新。请按下面的变更点继续实现；与旧描述冲突时以 Jira 最新描述为准。`,
    ...lines,
  ].join('\n');
}

export interface NotifyJiraChangeResult {
  sent: boolean;
  reason?: string;
}

/**
 * Ask the configured phase model for a short list of change points.
 *
 * Returns null when no settings service is available or the call fails/times
 * out, so the caller can fall back to the raw before/after text.
 */
async function summarizeWithModel(params: {
  feature: Pick<Feature, 'id' | 'jiraKey' | 'title'>;
  changes: JiraChangeLike[];
  projectPath: string;
  settingsService?: SettingsService;
}): Promise<string | null> {
  const { feature, changes, projectPath, settingsService } = params;
  if (!settingsService) return null;

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), SUMMARY_TIMEOUT_MS);
  try {
    const settings = await settingsService.getGlobalSettings();
    const entry =
      settings?.phaseModels?.jiraChangeSummaryModel ?? DEFAULT_PHASE_MODELS.jiraChangeSummaryModel;
    const resolved = resolvePhaseModel(entry);
    const result = await streamingQuery({
      prompt: [
        `任务 ${feature.jiraKey ?? feature.id}：${feature.title ?? ''}`,
        '本任务执行期间，Jira 上的需求被修改。下面是每条变更的原文：',
        ...changes.map((change) => {
          const before = excerpt(change.before);
          const after = excerpt(change.after);
          if (before && after) return `- ${fieldLabel(change.field)}：${before} → ${after}`;
          if (after) return `- ${fieldLabel(change.field)}（新增）：${after}`;
          return `- ${fieldLabel(change.field)}（移除）：${before ?? ''}`;
        }),
      ].join('\n'),
      systemPrompt:
        '你是交付助手。只输出 3-5 条要点，每行以 "- " 开头，用中文说明这次需求变更对正在执行任务的影响（新增/取消/调整了什么、需要怎么改）。不要复述原文，不要寒暄，不要输出其它段落。',
      model: resolved.model,
      thinkingLevel: resolved.thinkingLevel,
      reasoningEffort: typeof entry === 'string' ? undefined : entry.reasoningEffort,
      cwd: projectPath,
      maxTurns: 1,
      allowedTools: [],
      abortController,
    });
    const text = result?.text?.trim();
    return text ? text : null;
  } catch (error) {
    logger.warn(
      `Jira change summarisation failed, using the raw diff instead: ${(error as Error).message}`
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deliver the change summary to the card's running agent.
 *
 * Only herdr-driven tasks can receive an out-of-band message (the agent runs in
 * a pane we can prompt). Auto-Mode CLI runs have no inbound channel mid-turn, so
 * they keep the change on the card and pick it up on the next follow-up.
 */
export async function notifyRunningAgentOfJiraChanges(params: {
  projectPath: string;
  feature: Feature;
  changes?: JiraChangeLike[];
  settingsService?: SettingsService;
}): Promise<NotifyJiraChangeResult> {
  const relevant = requirementChanges(params.changes);
  if (relevant.length === 0) return { sent: false, reason: 'no requirement change' };
  if (params.feature.status !== 'in_progress')
    return { sent: false, reason: 'task is not running' };

  const { herdrWorkspaceId, herdrTabId } = params.feature;
  if (!herdrWorkspaceId || !herdrTabId) {
    return { sent: false, reason: 'task has no herdr pane' };
  }

  const service = getHerdrTaskService(params.projectPath);
  const agents = await service.listTaskAgents(herdrWorkspaceId, herdrTabId);
  const target =
    agents.find((agent) => agent.agent === 'pi' && /-leader$/.test(agent.name ?? '')) ??
    agents.find((agent) => agent.agent === 'pi');
  if (!target) return { sent: false, reason: 'no pi agent in the task pane' };

  const summary =
    (await summarizeWithModel({
      feature: params.feature,
      changes: relevant,
      projectPath: params.projectPath,
      settingsService: params.settingsService,
    })) ?? summarizeRequirementChanges(params.feature, relevant);
  await service.prompt(target.pane_id, summary);
  logger.info(
    `Sent ${relevant.length} Jira requirement change(s) to ${target.pane_id} for ${params.feature.id}`
  );
  return { sent: true };
}
