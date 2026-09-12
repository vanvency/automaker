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

export async function findOpenCodeSession(workDir: string, preferredTitle?: string) {
  const list = await runCaptured(
    'opencode',
    ['session', 'list', '--format', 'json'],
    workDir,
    20000
  );
  const sessions = JSON.parse(list) as Array<{
    id: string;
    directory?: string;
    title?: string;
    slug?: string;
  }>;
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return null;
  }
  const target = path.resolve(workDir);
  const inDirectory = sessions.filter(
    (item) => item.directory && path.resolve(item.directory) === target
  );
  const title = preferredTitle?.toUpperCase();
  const titled = title
    ? inDirectory.find((item) => (item.title ?? '').toUpperCase().includes(title))
    : undefined;
  return titled ?? inDirectory[0] ?? sessions[0];
}

export async function resolveFeatureWorkDir(
  featureLoader: FeatureLoader,
  projectPath: string,
  featureId: string
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
  }
  return { feature, workDir };
}
