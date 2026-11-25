import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/components/views/settings-view/model-defaults/phase-model-selector', () => ({
  PhaseModelSelector: () => null,
}));
vi.mock('@/store/app-store', () => {
  const state = {
    defaultPlanningMode: 'skip',
    defaultRequirePlanApproval: false,
    useWorktrees: false,
    defaultFeatureModel: { model: 'claude-opus' },
    defaultThinkingLevel: 'none',
    phaseModels: {},
    currentProject: { path: '/demo' },
  };
  return { useAppStore: () => state };
});

import { AddFeatureDialog } from '@/components/views/board-view/dialogs/add-feature-dialog';
import { EditFeatureDialog } from '@/components/views/board-view/dialogs/edit-feature-dialog';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { Feature } from '@/store/app-store';

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
});

function Harness({ onAdd = vi.fn() }: { onAdd?: (data: unknown) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => setOpen(true)}>Reopen</button>
      <TooltipProvider>
        <QueryClientProvider client={new QueryClient()}>
          <AddFeatureDialog
            open={open}
            onOpenChange={setOpen}
            onAdd={onAdd}
            categorySuggestions={[]}
            branchSuggestions={[]}
            defaultSkipTests={false}
            isMaximized={false}
            projectPath="/demo"
          />
        </QueryClientProvider>
      </TooltipProvider>
    </>
  );
}

describe('AddFeatureDialog draft', () => {
  it('restores an unfinished description and starts fresh after adding', () => {
    const onAdd = vi.fn();
    render(<Harness onAdd={onAdd} />);
    const description = screen.getByTestId('feature-description-input');
    fireEvent.change(description, { target: { value: 'A task worth keeping' } });
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(screen.getByText('Reopen'));
    expect(screen.getByTestId('feature-description-input')).toHaveValue('A task worth keeping');

    fireEvent.click(screen.getByTestId('confirm-add-feature'));
    expect(onAdd).toHaveBeenCalled();
    fireEvent.click(screen.getByText('Reopen'));
    expect(screen.getByTestId('feature-description-input')).toHaveValue('');
  });
});

const firstFeature = { id: 'first', title: 'First', description: 'Original' } as Feature;
const secondFeature = { id: 'second', title: 'Second', description: 'Another task' } as Feature;

function EditHarness() {
  const [feature, setFeature] = useState<Feature | null>(firstFeature);
  return (
    <TooltipProvider>
      <QueryClientProvider client={new QueryClient()}>
        <button onClick={() => setFeature(firstFeature)}>Reopen first</button>
        <button onClick={() => setFeature(secondFeature)}>Open second</button>
        <EditFeatureDialog
          feature={feature}
          onClose={() => setFeature(null)}
          onUpdate={vi.fn()}
          categorySuggestions={[]}
          branchSuggestions={[]}
          isMaximized={false}
          allFeatures={[firstFeature, secondFeature]}
          projectPath="/demo"
        />
      </QueryClientProvider>
    </TooltipProvider>
  );
}

describe('EditFeatureDialog draft', () => {
  it('keeps an unfinished edit for the same task without carrying it to another', () => {
    render(<EditHarness />);
    fireEvent.change(screen.getByTestId('feature-description-input'), {
      target: { value: 'Unsubmitted edit' },
    });
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(screen.getByText('Reopen first'));
    expect(screen.getByTestId('feature-description-input')).toHaveValue('Unsubmitted edit');

    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(screen.getByText('Open second'));
    expect(screen.getByTestId('feature-description-input')).toHaveValue('Another task');
  });
});
