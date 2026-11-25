import type { ExecuteOptions, Feature, ProviderMessage } from '@automaker/types';
import { PiProvider } from './pi-provider.js';
import { getHerdrTaskService, type HerdrTaskService } from '../services/herdr-task-service.js';
import type { PiSessionMessage } from '../services/pi-session-store.js';
import { readPiSessionFile } from '../services/pi-session-store.js';
import { bootstrapHerdr } from '../services/herdr-bootstrap.js';
import { resolveLitellmApiKey } from './pi-litellm.js';
import { PI_LITELLM_API_KEY_ENV } from '@automaker/types';
import { isShuttingDown } from '../lib/shutdown-state.js';
import path from 'node:path';

interface FeatureConversation {
  projectPath: string;
  feature: Feature;
  persist: (fields: Partial<Feature>) => Promise<void>;
  reattach?: boolean;
  execution?: Pick<
    NonNullable<Feature['herdrExecution']>,
    'status' | 'planningMode' | 'requirePlanApproval' | 'previousContent'
  >;
  /** The wrapper's planning prompt; nested implementation turns must not regenerate a plan. */
  initialPrompt?: string;
  load?: () => Promise<Feature | null>;
}

/** Pi's interactive editor trims submissions and normalizes pasted line endings. */
export function normalizePiSubmission(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

/** A feature has one interactive Pi process: Reply, logs and Conversation use it. */
export class HerdrFeaturePiProvider extends PiProvider {
  constructor(
    private conversation: FeatureConversation,
    private service: HerdrTaskService = getHerdrTaskService(conversation.projectPath)
  ) {
    super();
  }

  async *executeQuery(options: ExecuteOptions): AsyncGenerator<ProviderMessage> {
    const signal = options.abortController?.signal;
    signal?.throwIfAborted();
    const { feature, projectPath, persist } = this.conversation;
    const checkpoint = this.conversation.reattach ? feature.herdrExecution : undefined;
    // A reconnect never starts/replaces a pane or sends a new prompt.
    this.conversation.reattach = false;
    const client = this.service.getClient();
    let target: {
      paneId: string | null;
      workspaceId: string;
      tabId: string;
      sessionId?: string | null;
    };
    if (checkpoint) {
      if (
        path.resolve(checkpoint.workDir) !== path.resolve(options.cwd) ||
        checkpoint.executionRunId !== feature.executionRunId
      )
        throw new Error('Saved Herdr execution no longer matches this task run');
      target = checkpoint;
    } else {
      const bootstrap = await bootstrapHerdr({
        projectPath: this.conversation.projectPath,
        installMissingIntegration: true,
      });
      if (!bootstrap.available || !bootstrap.piIntegrationReady) {
        throw new Error(`Task conversation unavailable: ${bootstrap.problems.join('; ')}`);
      }
      await this.refreshModels();
      const cliArgs = this.buildCliArgs({ ...options, sdkSessionId: undefined });
      // Keep model, thinking, tool and trust configuration while switching transport.
      const args = cliArgs.slice(3); // --print --mode json
      if (typeof options.systemPrompt === 'string' && options.systemPrompt) {
        args.push('--append-system-prompt', options.systemPrompt);
      }
      const apiKey = resolveLitellmApiKey();
      target = await this.service.restoreConversation({
        taskName: feature.title || feature.id,
        workDir: options.cwd,
        projectPath,
        taskKeys: [feature.id, feature.jiraKey].filter((key): key is string => !!key),
        workspaceId: feature.herdrWorkspaceId,
        tabId: feature.herdrTabId,
        providerSessionId: options.sdkSessionId || feature.providerSessionId,
        executionArgs: args,
        env: apiKey ? { [PI_LITELLM_API_KEY_ENV]: apiKey } : undefined,
      });
    }
    if (!target.paneId) throw new Error('Pi did not start in the task conversation');
    let agent = await client.getAgent(target.paneId);
    if (agent.agent !== 'pi') throw new Error('The recorded pane is no longer a Pi agent');
    if (
      checkpoint &&
      ((agent.workspace_id && agent.workspace_id !== checkpoint.workspaceId) ||
        (agent.tab_id && agent.tab_id !== checkpoint.tabId) ||
        (agent.cwd && path.resolve(agent.cwd) !== path.resolve(checkpoint.workDir)))
    )
      throw new Error('The recorded Herdr pane no longer belongs to this task');
    if (!checkpoint && !['idle', 'done'].includes(agent.agent_status)) {
      throw new Error('The task conversation is busy; Reply was not submitted');
    }
    let sessionFile = checkpoint?.sessionFile || agent.agent_session?.value;
    if (
      checkpoint?.sessionFile &&
      agent.agent_session?.value &&
      checkpoint.sessionFile !== agent.agent_session.value
    )
      throw new Error('The task conversation changed sessions while the API was offline');
    let session = sessionFile ? readPiSessionFile(sessionFile) : null;
    if (checkpoint?.sessionId && session && session.id !== checkpoint.sessionId)
      throw new Error('The saved Pi session identity does not match');
    await persist({
      herdrWorkspaceId: target.workspaceId,
      herdrTabId: target.tabId,
      providerSessionId: session?.id ?? target.sessionId ?? undefined,
    });
    let sessionId = session?.id ?? target.sessionId ?? undefined;
    let cursor = checkpoint?.startCursor ?? session?.messages.length ?? 0;
    let sawUser = false;
    let sawAnswer = false;
    let sent = false;
    let finished = false;
    const prompt =
      typeof options.prompt === 'string'
        ? options.prompt
        : options.prompt
            .filter((block) => block.type === 'text')
            .map((block) => block.text ?? '')
            .join('\n');
    if (!prompt.trim()) throw new Error('Cannot send an empty task reply');
    // Preserve attachment context supplied by the executor (Pi reads local images itself).
    const userPrompt =
      checkpoint?.prompt ?? normalizePiSubmission(`**Feature ID:** ${feature.id}\n\n${prompt}`);
    const current = checkpoint ? feature : await this.conversation.load?.();
    const turn: NonNullable<Feature['herdrExecution']> = checkpoint ?? {
      paneId: target.paneId,
      workspaceId: target.workspaceId,
      tabId: target.tabId,
      workDir: options.cwd,
      sessionFile,
      sessionId,
      startCursor: cursor,
      prompt: userPrompt,
      startedAt: new Date().toISOString(),
      executionRunId: feature.executionRunId,
      status: this.conversation.execution?.status || feature.status || 'in_progress',
      planningMode:
        this.conversation.initialPrompt &&
        normalizePiSubmission(prompt) !== normalizePiSubmission(this.conversation.initialPrompt)
          ? 'skip'
          : this.conversation.execution?.planningMode,
      requirePlanApproval: this.conversation.execution?.requirePlanApproval,
      previousContent: this.conversation.execution?.previousContent,
      taskId: current?.planSpec?.currentTaskId,
    };
    // Save before submission: after an uncertain send, inspect; never submit twice.
    if (!checkpoint) await persist({ herdrExecution: turn });
    let interruption: Promise<unknown> | undefined;
    const interrupted = () =>
      (interruption ??= client.request('agent.send_keys', {
        target: target.paneId,
        keys: ['esc'],
      }));
    const onAbort = () => {
      if (sent && !finished && !isShuttingDown()) void interrupted().catch(() => {});
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      signal?.throwIfAborted();
      if (!checkpoint) await this.service.prompt(target.paneId, userPrompt);
      sent = true;
      const deadline = Date.parse(turn.startedAt) + 24 * 60 * 60_000;
      const acceptedDeadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        agent = await client.getAgent(target.paneId);
        if (agent.agent !== 'pi') throw new Error('The task conversation exited before replying');
        if (agent.agent_session?.value && agent.agent_session.value !== sessionFile) {
          // Only accept the first file materialized by a fresh conversation.
          if (sessionFile)
            throw new Error('The task conversation changed sessions during execution');
          sessionFile = agent.agent_session.value;
          cursor = 0;
          turn.sessionFile = sessionFile;
          turn.startCursor = 0;
          await persist({ herdrExecution: turn });
        }
        session = sessionFile ? readPiSessionFile(sessionFile) : null;
        if (checkpoint?.sessionId && session && session.id !== checkpoint.sessionId)
          throw new Error('The saved Pi session identity changed during recovery');
        if (session && session.id !== sessionId) {
          sessionId = session.id;
          turn.sessionId = sessionId;
          await persist({ providerSessionId: sessionId, herdrExecution: turn });
        }
        for (const message of session?.messages.slice(cursor) ?? []) {
          if (message.role === 'user') {
            if (sawUser)
              throw new Error('Another reply was submitted before this turn was collected');
            if (normalizePiSubmission(message.text) === userPrompt) sawUser = true;
            continue;
          }
          if (!sawUser || message.role !== 'assistant') continue;
          if (message.isError) throw new Error(message.errorMessage || 'Pi task execution failed');
          const event = piMessageToProviderMessage(message, sessionId);
          if (event) yield event;
          if (message.text.trim()) sawAnswer = true;
        }
        cursor = session?.messages.length ?? cursor;
        const lastMessage = session?.messages.at(-1);
        if (
          sawUser &&
          sawAnswer &&
          lastMessage?.role === 'assistant' &&
          !lastMessage.toolCalls?.length &&
          ['idle', 'done'].includes(agent.agent_status)
        ) {
          finished = true;
          yield { type: 'result', subtype: 'success', session_id: sessionId };
          return;
        }
        // A blocked pane is still an active conversation, not a successful turn.
        if (!sawUser && Date.now() > acceptedDeadline) {
          throw new Error('Reply was not recorded by the task conversation');
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error('Task conversation timed out');
    } finally {
      signal?.removeEventListener('abort', onAbort);
      // API shutdown detaches the observer; only an explicit Stop cancels a resumed turn.
      if (sent && !finished && !isShuttingDown() && (!checkpoint || signal?.aborted)) {
        await interrupted().catch(() => {});
        await persist({ herdrExecution: undefined });
      }
    }
  }
}

export function piMessageToProviderMessage(
  message: PiSessionMessage,
  sessionId?: string
): ProviderMessage | null {
  const content: NonNullable<ProviderMessage['message']>['content'] = [];
  if (message.text) content.push({ type: 'text', text: message.text });
  for (const tool of message.toolCalls ?? []) {
    content.push({
      type: 'tool_use',
      name: tool.name,
      input: tool.arguments as Record<string, unknown>,
    });
  }
  return content.length
    ? {
        type: 'assistant',
        session_id: sessionId,
        message: { role: 'assistant', content },
      }
    : null;
}
