import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PiSettingsTab } from '@/components/views/settings-view/providers/pi-settings-tab';
import { GLOBAL_NAV_GROUPS } from '@/components/views/settings-view/config/navigation';
import { SettingsNavigation } from '@/components/views/settings-view/components/settings-navigation';

const mocks = vi.hoisted(() => ({
  getPiStatus: vi.fn(),
  togglePiModel: vi.fn(),
  setPiDefaultModel: vi.fn(),
  toggleProviderDisabled: vi.fn(),
}));

vi.mock('@/lib/electron', () => ({
  getElectronAPI: () => ({ setup: { getPiStatus: mocks.getPiStatus } }),
}));

vi.mock('@/store/app-store', () => {
  const state = {
    enabledPiModels: ['pi:litellm/worker'],
    piDefaultModel: 'pi:litellm/worker',
    disabledProviders: [],
    togglePiModel: mocks.togglePiModel,
    setPiDefaultModel: mocks.setPiDefaultModel,
    toggleProviderDisabled: mocks.toggleProviderDisabled,
  };
  return {
    useAppStore: (selector?: (value: typeof state) => unknown) =>
      selector ? selector(state) : state,
  };
});

function renderTab() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PiSettingsTab />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  mocks.getPiStatus.mockResolvedValue({
    success: true,
    installed: true,
    version: '1.0.0',
    path: '/usr/bin/pi',
    litellm: {
      baseUrl: 'http://localhost:4000/v1',
      hasApiKey: true,
      modelsConfigPath: '/home/test/.pi/agent/models.json',
    },
  });
});

describe('Pi provider settings', () => {
  it('allows navigating to Pi from AI Providers', async () => {
    const onNavigate = vi.fn();
    const navItems = GLOBAL_NAV_GROUPS.flatMap((group) => group.items);
    render(
      <SettingsNavigation
        navItems={navItems}
        activeSection="pi-provider"
        currentProject={null}
        onNavigate={onNavigate}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Pi', exact: true }));
    expect(onNavigate).toHaveBeenCalledWith('pi-provider');
  });

  it('loads CLI status and updates existing model and visibility settings', async () => {
    renderTab();
    expect(await screen.findByText('Pi CLI installed (1.0.0)')).toBeInTheDocument();
    expect(screen.getByText('LiteLLM gateway: http://localhost:4000/v1')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('switch', { name: 'Worker (LiteLLM)' }));
    expect(mocks.togglePiModel).toHaveBeenCalledWith('pi:litellm/worker', false);

    await userEvent.click(screen.getAllByRole('switch')[0]);
    expect(mocks.toggleProviderDisabled).toHaveBeenCalledWith('pi', true);

    await userEvent.click(screen.getByRole('button', { name: 'Refresh Pi CLI status' }));
    expect(mocks.getPiStatus).toHaveBeenCalledTimes(2);
  });

  it('shows installation instructions when Pi is missing', async () => {
    mocks.getPiStatus.mockResolvedValue({
      success: true,
      installed: false,
      installCommand: 'npm install -g @earendil-works/pi-coding-agent',
    });
    renderTab();
    expect(await screen.findByText('Pi CLI not installed')).toBeInTheDocument();
    expect(screen.getByText('npm install -g @earendil-works/pi-coding-agent')).toBeInTheDocument();
  });

  it('reports API failures while leaving model settings accessible', async () => {
    mocks.getPiStatus.mockResolvedValue({ success: false, error: 'Pi status unavailable' });
    renderTab();
    expect(await screen.findByRole('alert')).toHaveTextContent('Pi status unavailable');
    expect(screen.getByRole('switch', { name: 'Worker (LiteLLM)' })).toBeEnabled();
  });
});
