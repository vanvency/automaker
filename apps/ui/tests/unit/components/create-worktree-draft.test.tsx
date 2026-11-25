import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CreateWorktreeDialog } from '@/components/views/board-view/dialogs/create-worktree-dialog';

function Harness() {
  const [open, setOpen] = useState(true);
  const [projectPath, setProjectPath] = useState('/first');
  return (
    <>
      <button onClick={() => setOpen(true)}>Reopen</button>
      <button onClick={() => setProjectPath('/second')}>Switch project</button>
      <CreateWorktreeDialog
        open={open}
        onOpenChange={setOpen}
        projectPath={projectPath}
        onCreated={vi.fn()}
      />
    </>
  );
}

describe('CreateWorktreeDialog draft', () => {
  it('retains an unfinished branch name until the project changes', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Branch Name'), {
      target: { value: 'feature/unfinished' },
    });
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(screen.getByText('Reopen'));
    expect(screen.getByLabelText('Branch Name')).toHaveValue('feature/unfinished');

    fireEvent.click(screen.getByText('Switch project'));
    expect(screen.getByLabelText('Branch Name')).toHaveValue('');
  });
});
