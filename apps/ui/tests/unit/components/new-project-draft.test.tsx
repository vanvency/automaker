import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

let projectPath = '/demo';
vi.mock('@/store/app-store', () => ({
  useAppStore: (selector: (state: { currentProject: { path: string } }) => unknown) =>
    selector({ currentProject: { path: projectPath } }),
}));
vi.mock('@/contexts/file-browser-context', () => ({
  useFileBrowser: () => ({ openFileBrowser: vi.fn() }),
}));
vi.mock('@/lib/workspace-config', () => ({
  getDefaultWorkspaceDirectory: async () => '/workspace',
  saveLastProjectDirectory: vi.fn(),
}));

import { NewProjectModal } from '@/components/dialogs/new-project-modal';

function Harness() {
  const [open, setOpen] = useState(true);
  const [, rerender] = useState(0);
  return (
    <>
      <button onClick={() => setOpen(true)}>Reopen</button>
      <button
        onClick={() => {
          projectPath = '/created';
          rerender((value) => value + 1);
        }}
      >
        Switch project
      </button>
      <NewProjectModal
        open={open}
        onOpenChange={setOpen}
        onCreateBlankProject={vi.fn()}
        onCreateFromTemplate={vi.fn()}
        onCreateFromCustomUrl={vi.fn()}
        isCreating={false}
      />
    </>
  );
}

describe('NewProjectModal draft', () => {
  it('restores the name after dismissal and clears it when a new project becomes current', async () => {
    projectPath = '/demo';
    render(<Harness />);
    await waitFor(() => expect(screen.queryByText('Loading workspace...')).not.toBeInTheDocument());
    fireEvent.change(screen.getByTestId('project-name-input'), {
      target: { value: 'unfinished-project' },
    });
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(screen.getByText('Reopen'));
    expect(screen.getByTestId('project-name-input')).toHaveValue('unfinished-project');
    await waitFor(() => expect(screen.queryByText('Loading workspace...')).not.toBeInTheDocument());

    fireEvent.click(screen.getByText('Switch project'));
    expect(screen.getByTestId('project-name-input')).toHaveValue('');
  });
});
