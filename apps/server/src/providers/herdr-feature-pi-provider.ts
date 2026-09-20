import type { ExecuteOptions, Feature, ProviderMessage } from '@automaker/types';
import { PiProvider } from './pi-provider.js';
import { getHerdrTaskService, type HerdrTaskService } from '../services/herdr-task-service.js';
import type { PiSessionMessage } from '../services/pi-session-store.js';
import { readPiSessionFile } from '../services/pi-session-store.js';
import { bootstrapHerdr } from '../services/herdr-bootstrap.js';
import { resolveLitellmApiKey } from './pi-litellm.js';
import { PI_LITELLM_API_KEY_ENV } from '@automaker/types';

interface FeatureConversation {
  projectPath: string;
  feature: Feature;
  persist: (fields: Partial<Feature>) => Promise<void>;
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
    const { feature, projectPath, persist } = this.conversation;
    const apiKey = resolveLitellmApiKey();
    const target = await this.service.restoreConversation({
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
    if (!target.paneId) throw new Error('Pi did not start in the task conversation');
    const client = this.service.getClient();
    let agent = await client.getAgent(target.paneId);
    if (!['idle', 'done'].includes(agent.agent_status)) {
      throw new Error('The task conversation is busy; Reply was not submitted');
    }
    let sessionFile = agent.agent_session?.value;
    let session = sessionFile ? readPiSessionFile(sessionFile) : null;
    await persist({
      herdrWorkspaceId: target.workspaceId,
      herdrTabId: target.tabId,
      providerSessionId: session?.id ?? target.sessionId ?? undefined,
    });
    let sessionId = session?.id ?? target.sessionId ?? undefined;
    let cursor = session?.messages.length ?? 0;
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
    const userPrompt = normalizePiSubmission(`**Feature ID:** ${feature.id}\n\n${prompt}`);
    let interruption: Promise<unknown> | undefined;
    const interrupted = () =>
      (interruption ??= client.request('agent.send_keys', {
        target: target.paneId,
        keys: ['esc'],
      }));
    const onAbort = () => {
      if (sent && !finished) void interrupted().catch(() => {});
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      signal?.throwIfAborted();
      await this.service.prompt(target.paneId, userPrompt);
      sent = true;
      const deadline = Date.now() + 24 * 60 * 60_000;
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
        }
        session = sessionFile ? readPiSessionFile(sessionFile) : null;
        if (session && session.id !== sessionId) {
          sessionId = session.id;
          await persist({ providerSessionId: sessionId });
        }
        for (const message of session?.messages.slice(cursor) ?? []) {
          if (message.role === 'user') {
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
      if (sent && !finished) await interrupted().catch(() => {});
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
