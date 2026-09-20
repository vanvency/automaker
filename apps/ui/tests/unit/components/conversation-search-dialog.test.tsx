/**
 * Conversation search dialog.
 *
 * The board filter only sees loaded cards; this dialog searches the Pi
 * transcripts on the server, so these tests pin the request it makes and what it
 * offers when a card is found.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  searchConversations: vi.fn(),
  getHerdrWeb: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/electron', () => ({
  getElectronAPI: () => ({
    features: {
      searchConversations: mocks.searchConversations,
      getHerdrWeb: mocks.getHerdrWeb,
    },
  }),
  isElectron: () => true,
}));

vi.mock('@/lib/api-fetch', () => ({
  withPageAuthParams: (url: URL) => url,
}));

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));

import { ConversationSearchDialog } from '@/components/views/board-view/dialogs/conversation-search-dialog';

function searchResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      matches: [
        {
          featureId: 'card-1',
          sessionId: 'session-1',
          filePath: '/home/.pi/agent/sessions/--demo--/one.jsonl',
          cwd: '/workspace/demo',
          role: 'toolResult',
          at: '2026-09-19T10:00:00.000Z',
          hitCount: 3,
          snippet: 'ERROR: token expired',
        },
      ],
      scannedSessions: 12,
      truncated: false,
      ...overrides,
    },
  };
}

describe('ConversationSearchDialog', () => {
  beforeEach(() => {
    mocks.searchConversations.mockReset();
    mocks.getHerdrWeb.mockReset();
    mocks.toastError.mockReset();
  });

  it('searches the project transcripts and opens the matched card', async () => {
    mocks.searchConversations.mockResolvedValue(searchResult());
    mocks.getHerdrWeb.mockResolvedValue({ success: true, url: '/api/herdr/view?session=term-1' });

    render(<ConversationSearchDialog open onOpenChange={() => {}} projectPath="/workspace/demo" />);
    fireEvent.change(screen.getByTestId('conversation-search-input'), {
      target: { value: 'token expired' },
    });

    await waitFor(() =>
      expect(mocks.searchConversations).toHaveBeenCalledWith('/workspace/demo', 'token expired')
    );
    expect(await screen.findByTestId('conversation-search-result')).toBeInTheDocument();
    expect(screen.getByText('card-1')).toBeInTheDocument();
    expect(screen.getByText('ERROR: token expired')).toBeInTheDocument();
    expect(screen.getByText(/Scanned 12 sessions/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('conversation-search-open-card-1'));
    await waitFor(() =>
      expect(mocks.getHerdrWeb).toHaveBeenCalledWith('/workspace/demo', 'card-1')
    );
  });

  it('waits for a useful query instead of scanning on the first character', async () => {
    render(<ConversationSearchDialog open onOpenChange={() => {}} projectPath="/workspace/demo" />);
    fireEvent.change(screen.getByTestId('conversation-search-input'), {
      target: { value: 'a' },
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mocks.searchConversations).not.toHaveBeenCalled();
    expect(screen.getByText(/Type at least 2 characters/)).toBeInTheDocument();
  });

  it('reports failures instead of showing an empty list', async () => {
    mocks.searchConversations.mockResolvedValue({ success: false, error: 'boom' });

    render(<ConversationSearchDialog open onOpenChange={() => {}} projectPath="/workspace/demo" />);
    fireEvent.change(screen.getByTestId('conversation-search-input'), {
      target: { value: 'boom' },
    });

    expect(await screen.findByText('boom')).toBeInTheDocument();
  });
});
