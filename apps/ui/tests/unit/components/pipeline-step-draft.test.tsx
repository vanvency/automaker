import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AddEditPipelineStepDialog } from '@/components/views/board-view/dialogs/add-edit-pipeline-step-dialog';

function Harness({ onSave }: { onSave: (step: unknown) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => setOpen(true)}>Reopen</button>
      <AddEditPipelineStepDialog
        open={open}
        onClose={() => setOpen(false)}
        onSave={onSave}
        defaultOrder={0}
      />
    </>
  );
}

describe('pipeline step draft', () => {
  it('keeps the inputs after dismissal and clears them after save', () => {
    const onSave = vi.fn();
    render(<Harness onSave={onSave} />);
    fireEvent.change(screen.getByLabelText(/Step Name/), { target: { value: 'Review' } });
    fireEvent.change(screen.getByLabelText(/Agent Instructions/), {
      target: { value: 'Check the changes' },
    });
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(screen.getByText('Reopen'));
    expect(screen.getByLabelText(/Step Name/)).toHaveValue('Review');
    expect(screen.getByLabelText(/Agent Instructions/)).toHaveValue('Check the changes');

    fireEvent.click(screen.getByText('Add to Pipeline'));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: 'Review' }));
    fireEvent.click(screen.getByText('Reopen'));
    expect(screen.getByLabelText(/Step Name/)).toHaveValue('');
  });
});
