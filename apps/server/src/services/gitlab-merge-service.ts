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
  hasConflicts: boolean;
  mergeStatus?: string;
  webUrl?: string;
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
      hasConflicts: Boolean(data.has_conflicts),
      mergeStatus: typeof data.merge_status === 'string' ? data.merge_status : undefined,
      webUrl: typeof data.web_url === 'string' ? data.web_url : undefined,
    };
  }

  /** Drop the `Draft:`/`WIP:` prefix so GitLab will accept a merge. */
  async markReady(url: string, currentTitle: string): Promise<{ ok: boolean; error?: string }> {
    const mr = parseMergeRequestUrl(url);
    if (!mr) return { ok: false, error: `Unparseable MR URL: ${url}` };
    const title = currentTitle.replace(/^\s*(?:draft|wip)\s*:\s*/i, '').trim() || currentTitle;
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
