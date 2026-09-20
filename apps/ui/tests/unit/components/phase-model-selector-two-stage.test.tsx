/**
 * PhaseModelSelector - two-stage selection.
 *
 * The picker asks for the agent first and then only offers that agent's models,
 * because the model id determines which agent runs the task.
 */
import { beforeAll, describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PhaseModelSelector } from '../../../src/components/views/settings-view/model-defaults/phase-model-selector';

const AGENT_IDS = ['claude', 'cursor', 'codex', 'gemini', 'copilot', 'opencode', 'pi'] as const;

const mocks = vi.hoisted(() => ({
  store: {
    enabledCursorModels: [] as string[],
    enabledGeminiModels: [] as string[],
    enabledCopilotModels: [] as string[],
    enabledOpencodeModels: [] as string[],
    enabledPiModels: [] as string[],
    favoriteModels: [] as string[],
    toggleFavoriteModel: vi.fn(),
    codexModels: [] as Array<Record<string, unknown>>,
    codexModelsLoading: false,
    fetchCodexModels: vi.fn().mockResolvedValue([]),
    enabledDynamicModelIds: [] as string[],
    disabledProviders: [] as string[],
    claudeCompatibleProviders: [] as Array<Record<string, unknown>>,
    defaultThinkingLevel: 'none',
    defaultReasoningEffort: 'none',
  },
}));

vi.mock('@/store/app-store', () => ({
  useAppStore: (selector?: (state: unknown) => unknown) =>
    typeof selector === 'function' ? selector(mocks.store) : mocks.store,
}));

vi.mock('@/hooks/queries', () => ({
  useOpencodeModels: () => ({ data: [], isLoading: false }),
}));

vi.mock('@/hooks/use-media-query', () => ({
  useIsMobile: () => false,
}));

beforeAll(() => {
  // Radix popper needs a ResizeObserver instance; the global mock from
  // tests/setup.ts is wiped by the `mockReset` option.
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  // `mockReset: true` wipes the implementations set in the hoisted factory.
  mocks.store.fetchCodexModels = vi.fn().mockResolvedValue([]);
  mocks.store.toggleFavoriteModel = vi.fn();
  mocks.store.enabledCursorModels = [];
  mocks.store.enabledGeminiModels = [];
  mocks.store.enabledCopilotModels = [];
  mocks.store.enabledOpencodeModels = [];
  mocks.store.enabledPiModels = ['pi:litellm/auto', 'pi:litellm/worker'];
  mocks.store.favoriteModels = [];
  mocks.store.codexModels = [];
  mocks.store.enabledDynamicModelIds = [];
  mocks.store.disabledProviders = [];
  mocks.store.claudeCompatibleProviders = [];
});

function renderPicker() {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<PhaseModelSelector value={{ model: 'claude-sonnet' }} onChange={onChange} compact />);
  return { user, onChange };
}

function getAgentRail() {
  return screen.getByTestId('model-selector-agent-rail');
}

/** Click an agent in the desktop left rail (the tests render desktop mode). */
async function pickRailAgent(user: ReturnType<typeof userEvent.setup>, agentId: string) {
  await user.click(within(getAgentRail()).getByTestId(`model-selector-agent-${agentId}`));
}

async function openPicker() {
  const picker = renderPicker();
  await picker.user.click(screen.getByTestId('model-selector'));
  return picker;
}

describe('PhaseModelSelector two-stage selection', () => {
  it('lists the agents first and hides the models until one is picked', async () => {
    await openPicker();

    // Desktop: agents live in the left rail and the model stage shows a hint.
    expect(await screen.findByText('Select an agent on the left')).toBeInTheDocument();
    for (const agentId of AGENT_IDS) {
      expect(
        within(getAgentRail()).getByTestId(`model-selector-agent-${agentId}`)
      ).toBeInTheDocument();
    }

    // Models of the currently selected agent are not rendered on the agent stage.
    expect(screen.queryByText('Claude Sonnet')).not.toBeInTheDocument();
  });

  it('shows only the models of the selected agent', async () => {
    const { user } = await openPicker();

    await pickRailAgent(user, 'pi');

    expect(screen.getByText('Auto (LiteLLM)')).toBeInTheDocument();
    expect(screen.getByText('Worker (LiteLLM)')).toBeInTheDocument();
    // Claude models belong to another agent and must not be listed here.
    expect(screen.queryByText('Claude Sonnet')).not.toBeInTheDocument();
  });

  it('reports the picked model through onChange', async () => {
    const { user, onChange } = await openPicker();

    await pickRailAgent(user, 'pi');
    await user.click(screen.getByText('Worker (LiteLLM)'));

    expect(onChange).toHaveBeenCalledWith({ model: 'pi:litellm/worker' });
  });

  it('filters the agent page with the search box', async () => {
    const { user } = await openPicker();

    await user.type(screen.getByPlaceholderText('Search agents...'), 'opencode');

    expect(within(getAgentRail()).getByTestId('model-selector-agent-opencode')).toBeInTheDocument();
    // The rail is navigation, not a cmdk item list, so the search box only
    // filters the model list. The rail keeps showing every agent.
    expect(within(getAgentRail()).getByTestId('model-selector-agent-pi')).toBeInTheDocument();
  });

  it('goes back to the agent list from the model stage', async () => {
    const { user } = await openPicker();

    await pickRailAgent(user, 'claude');
    expect(screen.getByText('Claude Sonnet')).toBeInTheDocument();

    // On desktop the rail replaces the mobile back button; switching agents
    // happens directly in the rail.
    await pickRailAgent(user, 'pi');
    expect(screen.getByText('Auto (LiteLLM)')).toBeInTheDocument();
    expect(screen.queryByText('Claude Sonnet')).not.toBeInTheDocument();
  });

  it('disables agents that have no selectable model', async () => {
    const { user } = await openPicker();

    // No Gemini models are enabled in the store for this test.
    const geminiAgent = within(getAgentRail()).getByTestId('model-selector-agent-gemini');
    expect(geminiAgent).toBeDisabled();
    expect(geminiAgent).toHaveAttribute('title', 'No models enabled');

    await user.click(geminiAgent);
    expect(screen.queryByTestId('model-selector-back-to-agents')).not.toBeInTheDocument();
  });

  it('only offers the models enabled in settings', async () => {
    mocks.store.enabledPiModels = ['pi:litellm/worker'];
    const { user } = await openPicker();

    await pickRailAgent(user, 'pi');

    expect(screen.getByText('Worker (LiteLLM)')).toBeInTheDocument();
    expect(screen.queryByText('Auto (LiteLLM)')).not.toBeInTheDocument();
  });

  it('clears the agent search when entering an agent', async () => {
    const { user } = await openPicker();

    await user.type(screen.getByPlaceholderText('Search agents...'), 'litellm');
    await pickRailAgent(user, 'pi');

    const modelSearch = screen.getByPlaceholderText('Search Pi (LiteLLM) models...');
    expect(modelSearch).toHaveValue('');
    // Every enabled Pi model is listed, not just the ones matching the old query.
    expect(screen.getByText('Auto (LiteLLM)')).toBeInTheDocument();
    expect(screen.getByText('Worker (LiteLLM)')).toBeInTheDocument();
  });
});
