import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QuickAddDialog } from '@/components/views/board-view/dialogs/quick-add-dialog';

vi.mock('@/components/views/settings-view/model-defaults/phase-model-selector', () => ({
  PhaseModelSelector: () => null,
}));
vi.mock('@/store/app-store', () => {
  const state = {
    currentProject: { path: '/demo' },
    defaultFeatureModel: { model: 'claude-opus' },
  };
  return { useAppStore: (selector: (state: typeof state) => unknown) => selector(state) };
});

function Harness({ onAdd = vi.fn() }: { onAdd?: (description: string) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => setOpen(true)}>Reopen</button>
      <QuickAddDialog open={open} onOpenChange={setOpen} onAdd={onAdd} onAddAndStart={onAdd} />
    </>
  );
}

describe('QuickAddDialog draft', () => {
  it('keeps unsubmitted text after closing and clears it after submission', () => {
    const onAdd = vi.fn();
    render(<Harness onAdd={onAdd} />);

    fireEvent.change(screen.getByTestId('quick-add-description-input'), {
      target: { value: 'Unfinished task' },
    });
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(screen.getByText('Reopen'));
    expect(screen.getByTestId('quick-add-description-input')).toHaveValue('Unfinished task');

    fireEvent.click(screen.getByTestId('quick-add-button'));
    expect(onAdd).toHaveBeenCalledWith('Unfinished task', expect.anything());
    fireEvent.click(screen.getByText('Reopen'));
    expect(screen.getByTestId('quick-add-description-input')).toHaveValue('');
  });
});
