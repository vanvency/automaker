/**
 * POST /conversation endpoint - Get the provider conversation for a feature.
 *
 * OpenCode keeps full sessions (user/assistant messages, reasoning and tool
 * activity) in its local store. Automaker's agent-output.md is a flattened log,
 * so this endpoint exports the real session for the feature's worktree.
 */

import type { Request, Response } from 'express';
import { spawn } from 'child_process';
import { closeSync, openSync, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { FeatureLoader } from '../../../services/feature-loader.js';
import { WorktreeResolver } from '../../../services/worktree-resolver.js';
import { getErrorMessage, logError } from '../common.js';

/**
 * Run a command and capture stdout through a file. opencode export can exceed
 * the pipe buffer and execFile has been observed truncating it mid-JSON.
 */
async function runCaptured(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'automaker-conversation-'));
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

type OpenCodePart = {
  type?: string;
  text?: string;
  tool?: string;
  name?: string;
  args?: unknown;
  state?: { input?: unknown; output?: unknown; status?: string };
};

type OpenCodeMessage = {
  info?: { role?: string };
  role?: string;
  parts?: OpenCodePart[];
};

function shapeMessages(messages: OpenCodeMessage[]): unknown[] {
  return messages.map((message) => ({
    role: message.info?.role ?? message.role ?? 'unknown',
    parts: (message.parts ?? []).map((part) => ({
      type: part.type,
      text: part.text,
      tool: part.tool ?? part.name,
      input: part.state?.input ?? part.args,
      output: part.state?.output,
      status: part.state?.status,
    })),
  }));
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

async function loadOpenCodeConversation(workDir: string, preferredTitle?: string) {
  const session = await findOpenCodeSession(workDir, preferredTitle);
  if (!session) {
    return { sessionId: null, messages: [] };
  }
  const exported = await runCaptured('opencode', ['export', session.id], workDir, 30000);
  const data = JSON.parse(exported) as { messages?: OpenCodeMessage[] };
  return { sessionId: session.id, messages: shapeMessages(data.messages ?? []) };
}

export function createConversationHandler(featureLoader: FeatureLoader) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath, featureId } = req.body as {
        projectPath: string;
        featureId: string;
      };
      if (!projectPath || !featureId) {
        res.status(400).json({
          success: false,
          error: 'projectPath and featureId are required',
        });
        return;
      }

      const feature = await featureLoader.get(projectPath, featureId);
      if (!feature) {
        res.status(404).json({ success: false, error: `Feature ${featureId} not found` });
        return;
      }

      let workDir = projectPath;
      if (feature.branchName) {
        const resolved = await new WorktreeResolver().findWorktreeForBranch(
          projectPath,
          feature.branchName
        );
        if (resolved) workDir = resolved;
      }

      try {
        const preferredTitle =
          ((feature as { jiraKey?: string }).jiraKey ?? featureId) || undefined;
        const conversation = await loadOpenCodeConversation(workDir, preferredTitle);
        res.json({
          success: true,
          provider: 'opencode',
          workDir,
          ...conversation,
        });
      } catch (error) {
        // Missing CLI or no session is not an API failure; the UI shows a hint.
        res.json({
          success: true,
          provider: 'opencode',
          workDir,
          sessionId: null,
          messages: [],
          message: getErrorMessage(error),
        });
      }
    } catch (error) {
      logError(error, 'Get feature conversation failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
