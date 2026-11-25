/**
 * GitLab merge-request client used by the "Complete" flow.
 *
 * MRs are created by pushing with merge_request.* options, but merging one
 * requires the REST API. GitLab refuses to merge a draft, so the order is:
 * resolve conflicts -> mark ready (drop 'Draft: ' from the title) -> merge.
 */

import { promises as fs } from 'fs';
import { createLogger } from '@automaker/utils';

const logger = createLogger('GitLabMergeService');

export interface ParsedMergeRequest {
  /** URL-encoded project path, e.g. `llm/llmops/product/vibe-llmops`. */
  project: string;
  iid: number;
  host: string;
}

export interface MergeRequestState {
  iid: number;
  project: string;
  state: string;
  title: string;
  draft: boolean;
  sourceBranch: string;
  targetBranch: string;
  sha?: string;
  mergeCommitSha?: string;
  squashCommitSha?: string;
  hasConflicts: boolean;
  mergeStatus?: string;
  detailedMergeStatus?: string;
  pipelineStatus?: string;
  blockingDiscussionsResolved?: boolean;
  webUrl?: string;
}

export interface MergeRequestFeedback {
  id: number;
  body: string;
  author: string;
  updatedAt: string;
  url: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Parse `https://host/group/project/-/merge_requests/123` into its parts. */
export function parseMergeRequestUrl(url: string): ParsedMergeRequest | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const match = /^(?<project>.+)\/-\/merge_requests\/(?<iid>\d+)\/?$/.exec(parsed.pathname);
  if (!match?.groups) return null;
  return {
    project: match.groups.project.replace(/^\//, ''),
    iid: Number(match.groups.iid),
    host: `${parsed.protocol}//${parsed.host}`,
  };
}

/**
 * Resolve the API token from `GITLAB_TOKEN`, then `GITLAB_TOKEN_FILE`
 * (default `/root/gitlab-token`, the file the monitor scripts already use).
 */
export async function resolveGitLabToken(): Promise<string | null> {
  const fromEnv = process.env.GITLAB_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const tokenFile = process.env.GITLAB_TOKEN_FILE?.trim() || '/root/gitlab-token';
  try {
    const fromFile = (await fs.readFile(tokenFile, 'utf8')).trim();
    return fromFile || null;
  } catch {
    return null;
  }
}

export class GitLabMergeService {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  private async request<T>(
    mr: ParsedMergeRequest,
    path: string,
    init: RequestInit = {}
  ): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
    const url = `${mr.host}/api/v4/projects/${encodeURIComponent(mr.project)}/merge_requests/${mr.iid}${path}`;
    const response = await this.fetchImpl(url, {
      ...init,
      redirect: 'error',
      headers: {
        'PRIVATE-TOKEN': this.token,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
      signal: init.signal ?? AbortSignal.timeout(30000),
    });
    if (response.status === 204) return { ok: response.ok, status: response.status, data: null };
    const text = await response.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      const message = (data as { message?: unknown } | null)?.message ?? text.slice(0, 300) ?? '';
      return {
        ok: false,
        status: response.status,
        data: data as T | null,
        error: typeof message === 'string' ? message : JSON.stringify(message),
      };
    }
    return { ok: true, status: response.status, data: data as T };
  }

  async getMergeRequest(url: string): Promise<MergeRequestState | null> {
    const mr = parseMergeRequestUrl(url);
    if (!mr) return null;
    const result = await this.request<Record<string, unknown>>(mr, '');
    if (!result.ok || !result.data) return null;
    const data = result.data;
    return {
      iid: mr.iid,
      project: mr.project,
      state: String(data.state ?? 'unknown'),
      title: String(data.title ?? ''),
      draft: Boolean(data.draft ?? data.work_in_progress),
      sourceBranch: String(data.source_branch ?? ''),
      targetBranch: String(data.target_branch ?? ''),
      sha: typeof data.sha === 'string' ? data.sha : undefined,
      mergeCommitSha: typeof data.merge_commit_sha === 'string' ? data.merge_commit_sha : undefined,
      squashCommitSha:
        typeof data.squash_commit_sha === 'string' ? data.squash_commit_sha : undefined,
      hasConflicts: Boolean(data.has_conflicts),
      mergeStatus: typeof data.merge_status === 'string' ? data.merge_status : undefined,
      detailedMergeStatus:
        typeof data.detailed_merge_status === 'string' ? data.detailed_merge_status : undefined,
      pipelineStatus: (data.head_pipeline as { status?: string } | undefined)?.status,
      blockingDiscussionsResolved: data.blocking_discussions_resolved as boolean | undefined,
      webUrl: typeof data.web_url === 'string' ? data.web_url : undefined,
    };
  }

  /** Always fetch live discussions, including every page; omit resolved and outdated diff notes. */
  async getReviewFeedback(url: string, sha?: string): Promise<MergeRequestFeedback[]> {
    const mr = parseMergeRequestUrl(url);
    if (!mr) throw new Error(`Unparseable MR URL: ${url}`);
    const feedback: MergeRequestFeedback[] = [];
    for (let page = 1; ; page++) {
      const result = await this.request<
        Array<{
          notes: Array<{
            id: number;
            body: string;
            system?: boolean;
            resolved?: boolean;
            author?: { username?: string };
            updated_at?: string;
            position?: { head_sha?: string };
          }>;
        }>
      >(mr, `/discussions?per_page=100&page=${page}`);
      if (!result.ok || !Array.isArray(result.data))
        throw new Error(`Could not read MR review feedback: ${url}`);
      for (const discussion of result.data) {
        if (!Array.isArray(discussion.notes)) throw new Error('Invalid MR discussion response');
        const root = discussion.notes[0];
        if (root?.resolved || (sha && root?.position?.head_sha && root.position.head_sha !== sha))
          continue;
        for (const note of discussion.notes) {
          if (
            note.system ||
            note.resolved ||
            (sha && note.position?.head_sha && note.position.head_sha !== sha)
          )
            continue;
          feedback.push({
            id: note.id,
            body: note.body,
            author: note.author?.username ?? '',
            updatedAt: note.updated_at ?? '',
            url: `${url}#note_${note.id}`,
          });
        }
      }
      if (result.data.length < 100) break;
    }
    return feedback.sort((a, b) => a.id - b.id);
  }

  /** Read project policy as older GitLab versions omit detailed_merge_status. */
  async getMergeBlockers(url: string, state: MergeRequestState): Promise<string[]> {
    if (state.state === 'merged') return [];
    const mr = parseMergeRequestUrl(url);
    if (!mr) throw new Error(`Unparseable MR URL: ${url}`);
    const response = await this.fetchImpl(
      `${mr.host}/api/v4/projects/${encodeURIComponent(mr.project)}`,
      {
        headers: { 'PRIVATE-TOKEN': this.token },
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      }
    );
    if (!response.ok) throw new Error(`Could not read MR merge policy: ${url}`);
    const policy = (await response.json()) as {
      only_allow_merge_if_pipeline_succeeds?: boolean;
      only_allow_merge_if_all_discussions_are_resolved?: boolean;
      allow_merge_on_skipped_pipeline?: boolean;
    };
    const blockers: string[] = [];
    if (state.hasConflicts) blockers.push('MR 存在冲突');
    if (state.draft) blockers.push('MR 仍为 Draft，请先 Approve MR');
    if (
      policy.only_allow_merge_if_pipeline_succeeds &&
      state.pipelineStatus !== 'success' &&
      !(state.pipelineStatus === 'skipped' && policy.allow_merge_on_skipped_pipeline)
    )
      blockers.push(`CI 尚未成功（${state.pipelineStatus ?? '无流水线'}）`);
    if (
      policy.only_allow_merge_if_all_discussions_are_resolved &&
      state.blockingDiscussionsResolved === false
    )
      blockers.push('GitLab 要求先解决所有 review 讨论');
    if (state.detailedMergeStatus && !['mergeable', 'not_open'].includes(state.detailedMergeStatus))
      blockers.push(`GitLab 合并状态：${state.detailedMergeStatus}`);
    return blockers.map((message) => `${url}: ${message}`);
  }

  /** Drop the `Draft:`/`WIP:` prefix so GitLab will accept a merge. */
  async markReady(url: string, currentTitle: string): Promise<{ ok: boolean; error?: string }> {
    const mr = parseMergeRequestUrl(url);
    if (!mr) return { ok: false, error: `Unparseable MR URL: ${url}` };
    const title =
      currentTitle
        .replace(/^\s*(?:(?:draft|wip)\s*:|\[(?:draft|wip)\]|\((?:draft|wip)\))\s*/i, '')
        .trim() || currentTitle;
    if (title === currentTitle) return { ok: true };
    const result = await this.request(mr, '', {
      method: 'PUT',
      body: JSON.stringify({ title }),
    });
    if (!result.ok) {
      logger.warn(`Failed to mark MR ${url} ready: ${result.error}`);
      return { ok: false, error: result.error };
    }
    return { ok: true };
  }

  /** Merge the MR. `sha` guards against merging a branch that moved meanwhile. */
  async merge(
    url: string,
    options: { sha?: string; squash?: boolean } = {}
  ): Promise<{ ok: boolean; merged: boolean; error?: string }> {
    const mr = parseMergeRequestUrl(url);
    if (!mr) return { ok: false, merged: false, error: `Unparseable MR URL: ${url}` };
    const result = await this.request<Record<string, unknown>>(mr, '/merge', {
      method: 'PUT',
      body: JSON.stringify({
        ...(options.sha ? { sha: options.sha } : {}),
        should_remove_source_branch: false,
        ...(options.squash !== undefined ? { squash: options.squash } : {}),
      }),
    });
    if (!result.ok) {
      logger.warn(`Failed to merge MR ${url}: ${result.error}`);
      return { ok: false, merged: false, error: result.error };
    }
    return { ok: true, merged: result.data?.state === 'merged' };
  }
}
