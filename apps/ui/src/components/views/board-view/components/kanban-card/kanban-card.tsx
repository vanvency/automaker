// @ts-nocheck - dnd-kit draggable/droppable ref combination type incompatibilities
import React, { memo, useLayoutEffect, useState, useCallback } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Feature, useAppStore } from '@/store/app-store';
import { useShallow } from 'zustand/react/shallow';
import { Copy, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { writeToClipboard } from '@/lib/clipboard-utils';
import { CardBadges, PriorityBadges } from './card-badges';
import { CardHeaderSection } from './card-header';
import { CardContentSections } from './card-content-sections';
import { CardDetailsDialog } from './card-details-dialog';
import { AcceptanceEvidenceDialog } from '../acceptance-evidence';
import { ChildTaskSummary } from './child-task-summary';
import { JiraTypeBadge } from '../jira-type-badge';
import { JiraReleaseBadges } from '../jira-release-badges';
import { AgentInfoPanel } from './agent-info-panel';
import { CardActions } from './card-actions';
import { HerdrStatusBadge } from './herdr-status-badge';
import { MrConflictNotice } from './mr-conflict-notice';

function getCardBorderStyle(enabled: boolean, opacity: number): React.CSSProperties {
  if (!enabled) {
    return { borderWidth: '0px', borderColor: 'transparent' };
  }
  if (opacity !== 100) {
    return {
      borderWidth: '1px',
      borderColor: `color-mix(in oklch, var(--border) ${opacity}%, transparent)`,
    };
  }
  return {};
}

function getCursorClass(
  isOverlay: boolean | undefined,
  isDraggable: boolean,
  isSelectionMode: boolean
): string {
  if (isSelectionMode) return 'cursor-pointer';
  if (isOverlay) return 'cursor-grabbing';
  // Drag cursor is now only on the drag handle, not the full card
  return 'cursor-default';
}

interface KanbanCardProps {
  feature: Feature;
  /**
   * Full, unfiltered feature list for the project. The board passes it down so
   * parent cards can list their (filtered-out) children; the store copy is only
   * a fallback because it is not always hydrated.
   */
  allFeatures?: Feature[];
  onEdit: () => void;
  onDelete: () => void;
  onViewOutput?: () => void;
  onOpenHerdr?: () => void;
  onLocateFeature?: (featureId: string) => void;
  onVerify?: () => void;
  onResume?: () => void;
  onForceStop?: () => void;
  onManualVerify?: () => void;
  onMoveBackToInProgress?: () => void;
  onFollowUp?: () => void;
  onRequestChanges?: () => void;
  onImplement?: () => void;
  onComplete?: () => void;
  onViewPlan?: () => void;
  onApprovePlan?: () => void;
  /** Current OpenCode session user-turn count, if resolved for this card. */
  onSpawnTask?: () => void;
  onDuplicate?: () => void;
  onDuplicateAsChild?: () => void;
  onDuplicateAsChildMultiple?: () => void;
  hasContext?: boolean;
  isCurrentAutoTask?: boolean;
  shortcutKey?: string;
  contextContent?: string;
  summary?: string;
  opacity?: number;
  glassmorphism?: boolean;
  cardBorderEnabled?: boolean;
  cardBorderOpacity?: number;
  isOverlay?: boolean;
  reduceEffects?: boolean;
  // Selection mode props
  isSelectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
  selectionTarget?: 'backlog' | 'waiting_approval' | null;
}

export const KanbanCard = memo(function KanbanCard({
  feature,
  allFeatures: allFeaturesProp,
  onEdit,
  onDelete,
  onViewOutput,
  onOpenHerdr,
  onLocateFeature,
  onVerify,
  onResume,
  onForceStop,
  onManualVerify,
  onMoveBackToInProgress: _onMoveBackToInProgress,
  onFollowUp,
  onRequestChanges,
  onImplement,
  onComplete,
  onViewPlan,
  onApprovePlan,
  onSpawnTask,
  onDuplicate,
  onDuplicateAsChild,
  onDuplicateAsChildMultiple,
  hasContext,
  isCurrentAutoTask,
  shortcutKey,
  contextContent,
  summary,
  opacity = 100,
  glassmorphism = true,
  cardBorderEnabled = true,
  cardBorderOpacity = 100,
  isOverlay,
  reduceEffects = false,
  isSelectionMode = false,
  isSelected = false,
  onToggleSelect,
  selectionTarget = null,
}: KanbanCardProps) {
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [isEvidenceOpen, setIsEvidenceOpen] = useState(false);
  const {
    useWorktrees,
    currentProject,
    features: storeFeatures,
  } = useAppStore(
    useShallow((state) => ({
      useWorktrees: state.useWorktrees,
      currentProject: state.currentProject,
      features: state.features,
    }))
  );

  // Prefer the board-provided list: the store copy is not always hydrated.
  const allFeatures = allFeaturesProp ?? storeFeatures;
  // A card should display as "actively running" if it's in the runningAutoTasks list
  // AND in an execution-compatible status. However, there's a race window where a feature
  // is tracked as running (in runningAutoTasks) but its disk/UI status hasn't caught up yet
  // (still 'backlog', 'ready', or 'interrupted'). In this case, we still want to show
  // running controls (Logs/Stop) and animated border, but not the full "actively running"
  // state that gates all UI behavior.
  const isInExecutionState =
    feature.status === 'in_progress' ||
    (typeof feature.status === 'string' && feature.status.startsWith('pipeline_'));
  const isActivelyRunning = !!isCurrentAutoTask && isInExecutionState;
  // isRunningWithStaleStatus: feature is tracked as running but status hasn't updated yet.
  // This happens during the timing gap between when the server starts a feature and when
  // the UI receives the status update. Show running UI to prevent "Make" button flash.
  const isRunningWithStaleStatus =
    !!isCurrentAutoTask &&
    !isInExecutionState &&
    (feature.status === 'backlog' ||
      feature.status === 'merge_conflict' ||
      feature.status === 'ready' ||
      feature.status === 'interrupted');
  // Show running visual treatment for both fully confirmed and stale-status running tasks
  const showRunningVisuals = isActivelyRunning || isRunningWithStaleStatus;
  const [isLifted, setIsLifted] = useState(false);

  useLayoutEffect(() => {
    if (isOverlay) {
      requestAnimationFrame(() => {
        setIsLifted(true);
      });
    }
  }, [isOverlay]);

  const isDraggable =
    !isSelectionMode &&
    !isRunningWithStaleStatus &&
    (feature.status === 'backlog' ||
      feature.status === 'merge_conflict' ||
      feature.status === 'interrupted' ||
      feature.status === 'ready' ||
      feature.status === 'waiting_approval' ||
      feature.status === 'verified' ||
      feature.status.startsWith('pipeline_') ||
      (feature.status === 'in_progress' && !isCurrentAutoTask));
  const {
    attributes,
    listeners,
    setNodeRef: setDraggableRef,
    isDragging,
  } = useDraggable({
    id: feature.id,
    disabled: !isDraggable || isOverlay || isSelectionMode,
  });

  // Make the card a drop target for creating dependency links
  // All non-completed cards can be link targets to allow flexible dependency creation
  // (completed features are excluded as they're already done)
  const isDroppable = !isOverlay && feature.status !== 'completed' && !isSelectionMode;
  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: `card-drop-${feature.id}`,
    disabled: !isDroppable,
    data: {
      type: 'card',
      featureId: feature.id,
    },
  });

  // Combine refs for both draggable and droppable
  const setNodeRef = useCallback(
    (node: HTMLElement | null) => {
      setDraggableRef(node);
      setDroppableRef(node);
    },
    [setDraggableRef, setDroppableRef]
  );

  const dndStyle = {
    opacity: isDragging ? 0.5 : undefined,
  };

  const cardStyle = getCardBorderStyle(cardBorderEnabled, cardBorderOpacity);

  // Only allow selection for features matching the selection target
  const isSelectable =
    isSelectionMode &&
    (feature.status === selectionTarget ||
      (selectionTarget === 'backlog' && feature.status === 'merge_conflict'));

  const wrapperClasses = cn(
    'relative select-none outline-none transition-transform duration-200 ease-out',
    getCursorClass(isOverlay, isDraggable, isSelectable),
    isOverlay && isLifted && 'scale-105 rotate-1 z-50',
    // Visual feedback when another card is being dragged over this one
    isOver && !isDragging && 'ring-2 ring-primary ring-offset-2 ring-offset-background scale-[1.02]'
  );

  const isInteractive = !isDragging && !isOverlay;
  const hasError = feature.error && !isCurrentAutoTask;

  // Jira metadata (type, release labels) is rendered in its own row.
  const hasJiraMetadata =
    (typeof feature.jiraType === 'string' && feature.jiraType.length > 0) ||
    (Array.isArray(feature.jiraLabels) &&
      feature.jiraLabels.some((label) => String(label).toLowerCase().startsWith('release-'))) ||
    // A Jira card without a release label still shows the 待定 priority badge.
    (typeof feature.jiraKey === 'string' && feature.jiraKey.length > 0);

  // Subtask cards exist for this parent: the child summary is the block to show.

  // Jira links come from the dispatched feature (jiraKey/jiraUrl); fall back to
  // the default Jira host when only the issue key is present.
  const jiraKey = typeof feature.jiraKey === 'string' ? feature.jiraKey : undefined;
  const jiraLabel = typeof feature.jiraKey === 'string' ? feature.jiraKey : feature.id;
  const jiraHref =
    (typeof feature.jiraUrl === 'string' && feature.jiraUrl) ||
    (jiraKey ? `https://jira.transwarp.io/browse/${jiraKey}` : undefined);

  const innerCardClasses = cn(
    'kanban-card-content h-full relative',
    reduceEffects ? 'shadow-none' : 'shadow-sm',
    'transition-all duration-200 ease-out',
    // Disable hover translate for running cards to prevent gap showing gradient
    isInteractive &&
      !reduceEffects &&
      !showRunningVisuals &&
      'hover:-translate-y-0.5 hover:shadow-md hover:shadow-black/10 bg-transparent',
    !glassmorphism && 'backdrop-blur-[0px]!',
    !showRunningVisuals &&
      cardBorderEnabled &&
      (cardBorderOpacity === 100 ? 'border-border/50' : 'border'),
    hasError && 'border-[var(--status-error)] border-2 shadow-[var(--status-error-bg)] shadow-lg',
    isSelected && isSelectable && 'ring-2 ring-brand-500 ring-offset-1 ring-offset-background'
  );

  const handleCardClick = (e: React.MouseEvent) => {
    // Portalled dialogs are React descendants but are not part of the card face.
    if (!e.currentTarget.contains(e.target as Node)) return;
    if (isSelectable && onToggleSelect) {
      e.preventDefault();
      e.stopPropagation();
      onToggleSelect();
      return;
    }
    // The card face is the task overview: a click opens details, the pencil in
    // the header is what opens the edit form.
    e.stopPropagation();
    setIsDetailsOpen(true);
  };

  const renderCardContent = () => (
    <Card
      style={showRunningVisuals ? undefined : cardStyle}
      className={innerCardClasses}
      onClick={handleCardClick}
    >
      {/* Background overlay with opacity */}
      {(!isDragging || isOverlay) && (
        <div
          className={cn(
            'absolute inset-0 rounded-xl bg-card -z-10',
            glassmorphism && 'backdrop-blur-sm'
          )}
          style={{ opacity: opacity / 100 }}
        />
      )}

      {/* Status icon and title share the top row */}
      <div className="px-3 pt-3 flex items-start gap-2">
        <CardBadges feature={feature} />
        {isSelectable && !isOverlay && (
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => onToggleSelect?.()}
            className="h-4 w-4 mt-0.5 border-2 data-[state=checked]:bg-brand-500 data-[state=checked]:border-brand-500 shrink-0"
            onClick={(e) => e.stopPropagation()}
          />
        )}
        <CardTitle className="flex-1 min-w-0 text-sm font-semibold text-foreground line-clamp-2">
          {feature.title || feature.description || feature.id}
        </CardTitle>
      </div>

      {/* Jira metadata row: type, release labels and the issue link. The
          category (`Jira AIP / dodo`) is dropped here: the type badge already
          says what kind of work it is, and the queue label lives in the board. */}
      <div className="px-3 pt-1.5 flex items-center gap-2 flex-wrap">
        {hasJiraMetadata && (
          <>
            <JiraTypeBadge
              type={typeof feature.jiraType === 'string' ? feature.jiraType : undefined}
              data-testid={`jira-type-${feature.id}`}
            />
            <JiraReleaseBadges
              labels={Array.isArray(feature.jiraLabels) ? feature.jiraLabels : undefined}
              data-testid={`jira-releases-${feature.id}`}
            />
          </>
        )}
        {jiraHref && (
          <>
            <a
              href={jiraHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-500 hover:underline"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              data-testid={`jira-link-${feature.id}`}
              title={`Open ${jiraLabel} in Jira`}
            >
              {jiraLabel}
              <ExternalLink className="w-3 h-3" />
            </a>
            <button
              type="button"
              className="inline-flex items-center justify-center h-4 w-4 rounded text-muted-foreground/60 hover:text-foreground hover:bg-muted"
              onClick={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const copied = await writeToClipboard(jiraKey || jiraLabel);
                if (copied) {
                  toast.success(`${jiraKey || jiraLabel} copied`);
                } else {
                  toast.error('Failed to copy Jira ID');
                }
              }}
              onPointerDown={(e) => e.stopPropagation()}
              data-testid={`jira-copy-${feature.id}`}
              title={`Copy ${jiraLabel} to clipboard`}
              aria-label={`Copy ${jiraLabel} to clipboard`}
            >
              <Copy className="w-3 h-3" aria-hidden="true" />
            </button>
          </>
        )}
      </div>

      {/* Priority and Manual Verification badges */}
      <PriorityBadges feature={feature} projectPath={currentProject?.path} />

      {/* Live leader/worker state when this feature runs in the shared herdr session */}
      {currentProject?.path && (
        <div className="absolute top-2 right-2 z-10">
          <HerdrStatusBadge projectPath={currentProject.path} featureId={feature.id} />
        </div>
      )}

      {/* Card Header */}
      <CardHeaderSection
        feature={feature}
        isDraggable={isDraggable}
        isCurrentAutoTask={isActivelyRunning}
        isSelectionMode={isSelectionMode}
        hasContext={hasContext}
        onEdit={onEdit}
        onDelete={onDelete}
        onViewOutput={onViewOutput}
        onSpawnTask={onSpawnTask}
        onDuplicate={onDuplicate}
        onDuplicateAsChild={onDuplicateAsChild}
        onDuplicateAsChildMultiple={onDuplicateAsChildMultiple}
        onOpenDetails={() => setIsDetailsOpen(true)}
        dragHandleListeners={isDraggable ? listeners : undefined}
        dragHandleAttributes={isDraggable ? attributes : undefined}
      />

      <CardContent className="px-3 pt-0 pb-0">
        {/* Done lane: a verified card whose delivery merge requests conflict cannot
            be completed until an agent resolves them, so the fix is offered here. */}
        {feature.status === 'verified' && currentProject?.path && (
          <MrConflictNotice projectPath={currentProject.path} featureId={feature.id} />
        )}

        {/* Content Sections. Long material (full description, every goal, the
            Jira records, changed projects and evidence) lives in the details
            dialog so one verbose card cannot stretch the whole column. */}
        <CardContentSections feature={feature} onOpenDetails={() => setIsDetailsOpen(true)} />

        {/* Parent task child execution summary: this is live progress, so it
            stays on the card face. */}
        <ChildTaskSummary
          feature={feature}
          allFeatures={allFeatures}
          onLocateChild={onLocateFeature}
        />

        {/* Agent Info Panel */}
        <AgentInfoPanel
          feature={feature}
          projectPath={currentProject?.path ?? ''}
          contextContent={contextContent}
          summary={summary}
          isActivelyRunning={isActivelyRunning}
        />

        {/* Actions */}
        <CardActions
          feature={feature}
          isCurrentAutoTask={isActivelyRunning}
          isRunningTask={!!isCurrentAutoTask}
          hasContext={hasContext}
          shortcutKey={shortcutKey}
          isSelectionMode={isSelectionMode}
          onViewOutput={onViewOutput}
          onOpenHerdr={onOpenHerdr}
          onVerify={onVerify}
          onResume={onResume}
          onForceStop={onForceStop}
          onManualVerify={onManualVerify}
          onFollowUp={onFollowUp}
          onRequestChanges={onRequestChanges}
          onImplement={onImplement}
          onComplete={onComplete}
          onViewPlan={onViewPlan}
          onApprovePlan={onApprovePlan}
          onViewAcceptance={() => setIsEvidenceOpen(true)}
        />
      </CardContent>

      <AcceptanceEvidenceDialog
        evidence={feature.acceptanceEvidence}
        projectPath={currentProject?.path ?? ''}
        open={isEvidenceOpen}
        onOpenChange={setIsEvidenceOpen}
        onConfirm={
          ['waiting_approval', 'verified'].includes(feature.status) && !isActivelyRunning
            ? onManualVerify
            : undefined
        }
      />

      {/* One place for everything that is too long for the card face. */}
      <CardDetailsDialog
        feature={feature}
        isOpen={isDetailsOpen}
        onOpenChange={setIsDetailsOpen}
        projectPath={currentProject?.path}
        allFeatures={allFeatures ?? []}
        onLocateChild={onLocateFeature}
      />
    </Card>
  );

  return (
    <div
      ref={setNodeRef}
      style={dndStyle}
      className={wrapperClasses}
      data-testid={`kanban-card-${feature.id}`}
    >
      {showRunningVisuals ? (
        <div className="animated-border-wrapper">{renderCardContent()}</div>
      ) : (
        renderCardContent()
      )}
    </div>
  );
});
