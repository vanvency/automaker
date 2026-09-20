import { describe, expect, it } from 'vitest';
import { cardPreviewText } from '@/components/views/board-view/components/kanban-card/card-preview-text';

describe('cardPreviewText', () => {
  it('drops the repository/worktree preamble of Jira-imported descriptions', () => {
    const text = cardPreviewText({
      id: 'f1',
      title: 'AIP-114859: 审计日志导出',
      description:
        'Implement Jira AIP-114859: https://jira.transwarp.io/browse/AIP-114859.\n' +
        'Repository: /workspace/vibe-llmops; isolated worktree: /workspace/vibe-llmops/.worktrees/aip-114859-dodo; branch: jira/aip-114859-dodo.\n' +
        'Use the configured Pi agent to implement the export.',
    });

    expect(text).toBe('Use the configured Pi agent to implement the export.');
    expect(text).not.toMatch(/worktree|Repository|jira\/aip-/);
  });

  it('keeps ordinary descriptions untouched', () => {
    const text = cardPreviewText({
      id: 'f2',
      title: 'Fix the toolbar',
      description: 'The toolbar overlaps the filter bar on 1280px screens.',
    });

    expect(text).toBe('The toolbar overlaps the filter bar on 1280px screens.');
  });

  it('falls back to the title when the description is only the preamble', () => {
    const text = cardPreviewText({
      id: 'f3',
      title: 'AIP-1: something',
      description:
        'Implement Jira AIP-1: https://jira.transwarp.io/browse/AIP-1.\nRepository: /p; worktree: /p/wt.',
    });

    expect(text).toBe('AIP-1: something');
  });
});
