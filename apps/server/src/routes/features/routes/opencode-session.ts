/**
 * OpenCode session helpers shared by the feature routes.
 *
 * OpenCode keeps its sessions in a local store; these helpers map a feature
 * (and its worktree) to the session that belongs to it.
 */

import { spawn } from 'child_process';
import { closeSync, openSync, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { FeatureLoader } from '../../../services/feature-loader.js';
import { WorktreeResolver } from '../../../services/worktree-resolver.js';
import { WorktreeRetentionService } from '../../../services/worktree-retention-service.js';

/**
 * Run a command and capture stdout through a file. opencode output can exceed
 * the pipe buffer and execFile has been observed truncating it mid-JSON.
 */
export async function runCaptured(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'automaker-opencode-'));
  const stdoutPath = path.join(tempDir, 'stdout.json');
  const stderrPath = path.join(tempDir, 'stderr.txt');
  const stdoutFd = openSync(stdoutPath, 'w');
  const stderrFd = openSync(stderrPath, 'w');
  const child = spawn(command, args, { cwd, stdio: ['ignore', stdoutFd, stderrFd] });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  closeSync(stdoutFd);
  closeSync(stderrFd);
  const output = await fs.readFile(stdoutPath, 'utf8');
  const errors = await fs.readFile(stderrPath, 'utf8');
  await fs.rm(tempDir, { recursive: true, force: true });
  if (exitCode !== 0) {
    throw new Error(errors.trim() || `${command} exited with code ${exitCode}`);
  }
  return output;
}

export interface OpenCodeSessionInfo {
  id: string;
  directory?: string;
  title?: string;
  slug?: string;
  created?: number;
  updated?: number;
}

/**
 * Shared worktrees run several Automaker features concurrently or sequentially.
 * All sessions list the same directory, so directory matching alone can select
 * an older sibling session (for example the parent decomposition conversation).
 * Prefer exact feature-title matching, then directory match, then any session.
 *
 * Matching never crosses the project boundary: a feature whose worktree has no
 * session must report "no session" instead of linking to an unrelated
 * conversation (which used to happen when the caller fell back to the newest
 * session in the whole list).
 */
export async function findOpenCodeSession(
  workDir: string,
  preferredTitle?: string,
  _featureId?: string,
  featureStartTime?: string | number,
  projectRoot?: string
): Promise<OpenCodeSessionInfo | null> {
  const list = await runCaptured(
    'opencode',
    ['session', 'list', '--format', 'json'],
    workDir,
    20000
  );
  const sessions = JSON.parse(list) as OpenCodeSessionInfo[];
  return selectOpenCodeSession(sessions, {
    workDir,
    preferredTitle,
    featureStartTime,
    projectRoot,
  });
}

export interface SelectOpenCodeSessionOptions {
  workDir: string;
  preferredTitle?: string;
  featureStartTime?: string | number;
  /** Repository root; sessions outside it are never considered */
  projectRoot?: string;
}

/**
 * Pick the session that belongs to a feature.
 *
 * Pure matching logic (no CLI access) so it can be unit tested:
 * exact worktree + title tokens > same project + title tokens > worktree time
 * window > project time window > newest session in the worktree. Never returns
 * a session from another project.
 */
export function selectOpenCodeSession(
  sessions: OpenCodeSessionInfo[],
  options: SelectOpenCodeSessionOptions
): OpenCodeSessionInfo | null {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return null;
  }

  const { workDir, preferredTitle, featureStartTime, projectRoot } = options;
  const target = path.resolve(workDir);
  const inDirectory = sessions.filter(
    (item) => item.directory && path.resolve(item.directory) === target
  );

  // Sessions created for sibling worktrees of the same repository. A worktree
  // can be recreated (fresh checkout after a merge) while its conversation
  // still lives under the previous path, so matching by project keeps those
  // links working without ever leaving the project.
  const root = projectRoot ? path.resolve(projectRoot) : null;
  const inProject = root
    ? sessions.filter((item) => {
        if (!item.directory) return false;
        const sessionDir = path.resolve(item.directory);
        return sessionDir === root || sessionDir.startsWith(`${root}${path.sep}`);
      })
    : [];

  const normalize = (value: string | undefined) => (value ?? '').trim().toLowerCase();
  const preferred = normalize(preferredTitle);

  // Split on ASCII and CJK punctuation so titles like
  // "AIP-114829: 【知识库审计】知识库操作审计日志支持导出" produce usable tokens.
  // Issue-key prefixes are reduced to the bare number ("aip-114829" -> "114829").
  const titleNeedles = preferred
    ? [
        ...new Set(
          preferred
            .split(/[\s()（）[\]【】「」『』{}<>:：/、,，+·—|-]+/)
            .map((token) =>
              token
                .trim()
                .replace(/^#/, '')
                .replace(/^aip[-_]?/i, '')
            )
            .filter((token) => token.length >= 4 && token !== 'child')
        ),
      ]
    : [];

  const matchByTitle = (candidates: OpenCodeSessionInfo[]): OpenCodeSessionInfo | null => {
    if (titleNeedles.length === 0) return null;
    // A long token (usually a CJK phrase or a distinctive English word) is
    // enough on its own; short tokens must agree with at least half of them.
    const half = Math.max(1, Math.ceil(titleNeedles.length / 2));
    const ranked = candidates
      .map((item) => {
        const title = normalize(item.title);
        const matchedNeedles = titleNeedles.filter((needle) => title.includes(needle));
        return {
          item,
          matches: matchedNeedles.length,
          hasLongMatch: matchedNeedles.some((n) => n.length >= 6),
        };
      })
      .filter((entry) => entry.hasLongMatch || entry.matches >= half)
      .sort((a, b) => b.matches - a.matches);
    return ranked[0]?.item ?? null;
  };

  const newest = (candidates: OpenCodeSessionInfo[]): OpenCodeSessionInfo | null => {
    if (candidates.length === 0) return null;
    const [latest] = [...candidates].sort(
      (a, b) => Number(b.updated ?? b.created ?? 0) - Number(a.updated ?? a.created ?? 0)
    );
    return latest ?? null;
  };

  const afterStart = (candidates: OpenCodeSessionInfo[]): OpenCodeSessionInfo | null => {
    const featureStart = Number(featureStartTime ?? 0);
    if (featureStart <= 0) return null;
    return newest(
      candidates.filter((item) => Number(item.updated ?? item.created ?? 0) >= featureStart)
    );
  };

  // OpenCode often abbreviates the feature title. Require the most distinctive
  // long tokens, then rank by the number of matched tokens.
  return (
    matchByTitle(inDirectory) ??
    matchByTitle(inProject) ??
    afterStart(inDirectory) ??
    afterStart(inProject) ??
    newest(inDirectory) ??
    null
  );
}

export async function resolveFeatureWorkDir(
  featureLoader: FeatureLoader,
  projectPath: string,
  featureId: string,
  options: { rebuild?: boolean } = {}
) {
  const feature = await featureLoader.get(projectPath, featureId);
  if (!feature) return null;
  let workDir = projectPath;
  if (feature.branchName) {
    const resolved = await new WorktreeResolver().findWorktreeForBranch(
      projectPath,
      feature.branchName
    );
    if (resolved) workDir = resolved;
    else if (feature.worktreeRelease) {
      // The checkout was released after the card stayed in Done. Reading history
      // only needs the path (pi keys sessions by working directory), but callers
      // that run an agent need a real tree and ask for the rebuild.
      const released = feature.worktreeRelease.path;
      if (!options.rebuild) workDir = released;
      else {
        try {
          workDir =
            (await new WorktreeRetentionService(featureLoader).ensureWorktree(
              projectPath,
              feature
            )) ?? released;
        } catch (error) {
          throw new Error(
            `worktree 已释放，无法从 ${feature.branchName} 重建：${(error as Error).message}`
          );
        }
      }
    }
  }
  return { feature, workDir };
}
