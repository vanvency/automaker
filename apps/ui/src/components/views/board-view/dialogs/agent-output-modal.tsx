import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  List,
  FileText,
  History,
  Zap,
  Flag,
  RefreshCw,
  GitBranch,
  ClipboardList,
  ChevronLeft,
  ChevronRight,
  Bot,
  MessageSquare,
} from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { getElectronAPI, isElectron } from '@/lib/electron';
import { LogViewer } from '@/components/ui/log-viewer';
import { GitDiffPanel } from '@/components/ui/git-diff-panel';
import { TaskProgressPanel } from '@/components/ui/task-progress-panel';
import { Markdown } from '@/components/ui/markdown';
import { useAppStore } from '@/store/app-store';
import {
  extractSummary,
  parseAllPhaseSummaries,
  isAccumulatedSummary,
  type PhaseSummaryEntry,
} from '@/lib/log-parser';
import { getFirstNonEmptySummary } from '@/lib/summary-selection';
import { withPageAuthParams } from '@/lib/api-fetch';
import { useAgentOutput, useFeature } from '@/hooks/queries';
import { cn } from '@/lib/utils';
import { MODAL_CONSTANTS } from '@/components/views/board-view/dialogs/agent-output-modal.constants';
import type { AutoModeEvent } from '@/types/electron';
import type { BacklogPlanEvent } from '@automaker/types';
import { toast } from 'sonner';

interface AgentOutputModalProps {
  open: boolean;
  onClose: () => void;
  featureId: string;
  /** The status of the feature - used to determine if spinner should be shown */
  featureStatus?: string;
  /** Called when a number key (0-9) is pressed while the modal is open */
  onNumberKeyPress?: (key: string) => void;
  /** Project path - if not provided, falls back to window.__currentProject for backward compatibility */
  projectPath?: string;
  /** Branch name for the feature worktree - used when viewing changes */
  branchName?: string;
  /** Open the follow-up dialog so the user can answer a waiting agent */
  onReply?: () => void;
}

type ViewMode = (typeof MODAL_CONSTANTS.VIEW_MODES)[keyof typeof MODAL_CONSTANTS.VIEW_MODES];

interface FeatureTimelineEntry {
  id: string;
  kind: 'session' | 'one-shot' | 'lifecycle' | 'jira';
  at: string;
  endedAt?: string | null;
  title: string;
  detail?: string;
  model?: string;
  turns?: number;
  status?: 'ok' | 'error';
}

function formatTimelineTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Renders a single phase entry card with header and content.
 */
function PhaseEntryCard({
  entry,
  index,
  totalPhases,
  hasMultiplePhases,
  isActive,
  onClick,
}: {
  entry: PhaseSummaryEntry;
  index: number;
  totalPhases: number;
  hasMultiplePhases: boolean;
  isActive?: boolean;
  onClick?: () => void;
}) {
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (onClick && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      onClick();
    }
  };

  return (
    <div
      className={cn(
        'p-4 bg-card rounded-lg border border-border/50 transition-all',
        isActive && 'ring-2 ring-primary/50 border-primary/50',
        onClick && 'cursor-pointer'
      )}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <div className="flex items-center gap-2 mb-3 pb-2 border-b border-border/30">
        <span className="text-sm font-semibold text-primary">{entry.phaseName}</span>
        {hasMultiplePhases && (
          <span className="text-xs text-muted-foreground">
            Step {index + 1} of {totalPhases}
          </span>
        )}
      </div>
      <Markdown>{entry.content || 'No summary available'}</Markdown>
    </div>
  );
}

/**
 * Step navigator component for multi-phase summaries
 */
function StepNavigator({
  phaseEntries,
  activeIndex,
  onIndexChange,
}: {
  phaseEntries: PhaseSummaryEntry[];
  activeIndex: number;
  onIndexChange: (index: number) => void;
}) {
  if (phaseEntries.length <= 1) return null;

  return (
    <div className="flex items-center gap-2 p-2 bg-muted/50 rounded-lg shrink-0">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        onClick={() => onIndexChange(Math.max(0, activeIndex - 1))}
        disabled={activeIndex === 0}
      >
        <ChevronLeft className="w-4 h-4" />
      </Button>

      <div className="flex items-center gap-1 overflow-x-auto">
        {phaseEntries.map((entry, index) => (
          <button
            key={`step-nav-${index}`}
            onClick={() => onIndexChange(index)}
            className={cn(
              'px-2.5 py-1 rounded-md text-xs font-medium transition-all whitespace-nowrap',
              index === activeIndex
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            )}
          >
            {entry.phaseName}
          </button>
        ))}
      </div>

      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        onClick={() => onIndexChange(Math.min(phaseEntries.length - 1, activeIndex + 1))}
        disabled={activeIndex === phaseEntries.length - 1}
      >
        <ChevronRight className="w-4 h-4" />
      </Button>
    </div>
  );
}

export function AgentOutputModal({
  open,
  onClose,
  featureId,
  featureStatus,
  onNumberKeyPress,
  projectPath: projectPathProp,
  branchName,
  onReply,
}: AgentOutputModalProps) {
  const isBacklogPlan = featureId.startsWith('backlog-plan:');

  // Resolve project path - prefer prop, fallback to window.__currentProject
  const resolvedProjectPath = projectPathProp || window.__currentProject?.path || undefined;

  // Track view mode state
  const [viewMode, setViewMode] = useState<ViewMode | null>(null);
  const [streamedContent, setStreamedContent] = useState<string>('');
  const [timeline, setTimeline] = useState<FeatureTimelineEntry[] | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);

  // Use React Query for initial output loading
  const {
    data: initialOutput = '',
    isLoading,
    refetch: refetchAgentOutput,
  } = useAgentOutput(resolvedProjectPath, featureId, {
    enabled: open && !!resolvedProjectPath,
  });

  // Fetch feature data to access the server-side accumulated summary.
  // Also used to show fresh description/status instead of potentially stale props
  // (e.g. when opening via deep link from a notification click).
  const { data: feature, refetch: refetchFeature } = useFeature(resolvedProjectPath, featureId, {
    enabled: open && !!resolvedProjectPath && !isBacklogPlan,
  });

  const resolvedStatus = feature?.status ?? featureStatus;
  const resolvedBranchName = feature?.branchName ?? branchName;

  // Reset streamed content when modal opens or featureId changes
  useEffect(() => {
    if (open) {
      setStreamedContent('');
      setViewMode(null);
      setTimeline(null);
    }
  }, [open, featureId]);

  // The timeline merges this card's resident pi sessions with the one-shot
  // calls that ran in the same worktree; it is only fetched when opened.
  const loadTimeline = useCallback(async () => {
    if (!resolvedProjectPath) return;
    const api = getElectronAPI();
    if (!api?.features?.timeline) return;
    setTimelineLoading(true);
    try {
      const result = await api.features.timeline(resolvedProjectPath, featureId);
      setTimeline(result.success ? (result.entries ?? []) : []);
    } catch {
      setTimeline([]);
    } finally {
      setTimelineLoading(false);
    }
  }, [resolvedProjectPath, featureId]);

  useEffect(() => {
    if (open && viewMode === MODAL_CONSTANTS.VIEW_MODES.TIMELINE && !timeline) {
      void loadTimeline();
    }
  }, [open, viewMode, timeline, loadTimeline]);

  // Combine initial output from query with streamed content from WebSocket
  const output = initialOutput + streamedContent;

  // Extract summary from output (client-side fallback)
  const extractedSummary = useMemo(() => extractSummary(output), [output]);

  // Prefer server-side accumulated summary (handles pipeline step accumulation),
  // fall back to client-side extraction from raw output.
  const summary = getFirstNonEmptySummary(feature?.summary, extractedSummary);

  // Normalize null to undefined for parser helpers that expect string | undefined
  const normalizedSummary = summary ?? undefined;

  // Parse summary into phases for multi-step navigation
  const phaseEntries = useMemo(
    () => parseAllPhaseSummaries(normalizedSummary),
    [normalizedSummary]
  );
  const hasMultiplePhases = useMemo(
    () => isAccumulatedSummary(normalizedSummary),
    [normalizedSummary]
  );
  const [activePhaseIndex, setActivePhaseIndex] = useState(0);

  // Reset active phase index when summary changes
  useEffect(() => {
    setActivePhaseIndex(0);
  }, [normalizedSummary]);

  // Determine the effective view mode - default to summary if available, otherwise parsed
  const effectiveViewMode =
    viewMode ?? (summary ? MODAL_CONSTANTS.VIEW_MODES.SUMMARY : MODAL_CONSTANTS.VIEW_MODES.PARSED);

  const handleOpenHerdr = useCallback(async () => {
    if (!resolvedProjectPath) return;
    // Pre-open the tab so the browser keeps the user gesture: the API call can
    // be slow while the server starts or reuses the attach PTY.
    const pendingTab = isElectron() ? null : window.open('', '_blank');
    try {
      const api = getElectronAPI();
      const getHerdrWeb = api.features?.getHerdrWeb;
      if (!getHerdrWeb) throw new Error('Herdr is not supported by this client');
      const result = await getHerdrWeb(resolvedProjectPath, featureId);
      if (!result?.success || !result.url) {
        throw new Error(result?.error || 'Could not open the herdr terminal');
      }
      const url = withPageAuthParams(new URL(result.url, window.location.origin));
      if (pendingTab) {
        pendingTab.location.replace(url.toString());
      } else {
        window.open(url.toString(), '_blank', 'noopener,noreferrer');
      }
    } catch (error) {
      pendingTab?.close();
      toast.error(error instanceof Error ? error.message : 'Open herdr terminal failed');
    }
  }, [resolvedProjectPath, featureId]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const useWorktrees = useAppStore((state) => state.useWorktrees);

  // Force a fresh fetch when opening to avoid showing stale cached summaries.
  useEffect(() => {
    if (!open || !resolvedProjectPath || !featureId) return;
    if (!isBacklogPlan) {
      void refetchFeature();
    }
    void refetchAgentOutput();
  }, [open, resolvedProjectPath, featureId, isBacklogPlan, refetchFeature, refetchAgentOutput]);

  // Auto-scroll to bottom when output changes
  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [output]);

  // Auto-scroll to bottom when summary changes (for pipeline step accumulation)
  const summaryScrollRef = useRef<HTMLDivElement>(null);
  const [summaryAutoScroll, setSummaryAutoScroll] = useState(true);

  // Auto-scroll summary panel to bottom when summary is updated
  useEffect(() => {
    if (summaryAutoScroll && summaryScrollRef.current && normalizedSummary) {
      summaryScrollRef.current.scrollTop = summaryScrollRef.current.scrollHeight;
    }
  }, [normalizedSummary, summaryAutoScroll]);

  // Handle scroll to detect if user scrolled up in summary panel
  const handleSummaryScroll = () => {
    if (!summaryScrollRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } = summaryScrollRef.current;
    const isAtBottom =
      scrollHeight - scrollTop - clientHeight < MODAL_CONSTANTS.AUTOSCROLL_THRESHOLD;
    setSummaryAutoScroll(isAtBottom);
  };

  // Scroll to active phase when it changes or when summary changes
  useEffect(() => {
    if (summaryScrollRef.current && hasMultiplePhases) {
      const phaseCards = summaryScrollRef.current.querySelectorAll('[data-phase-index]');
      // Ensure index is within bounds
      const safeIndex = Math.min(activePhaseIndex, phaseCards.length - 1);
      const targetCard = phaseCards[safeIndex];
      if (targetCard) {
        targetCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }, [activePhaseIndex, hasMultiplePhases, normalizedSummary]);

  // Listen to auto mode events and update output
  useEffect(() => {
    if (!open) return;

    const api = getElectronAPI();
    if (!api?.autoMode || isBacklogPlan) return;

    console.log('[AgentOutputModal] Subscribing to events for featureId:', featureId);

    const unsubscribe = api.autoMode.onEvent((event) => {
      console.log(
        '[AgentOutputModal] Received event:',
        event.type,
        'featureId:',
        'featureId' in event ? event.featureId : 'none',
        'modalFeatureId:',
        featureId
      );

      // Filter events for this specific feature only (skip events without featureId)
      if ('featureId' in event && event.featureId !== featureId) {
        console.log('[AgentOutputModal] Skipping event - featureId mismatch');
        return;
      }

      let newContent = '';

      switch (event.type) {
        case 'auto_mode_progress':
          newContent = event.content || '';
          break;
        case 'auto_mode_tool': {
          const toolName = event.tool || 'Unknown Tool';
          const toolInput = event.input ? JSON.stringify(event.input, null, 2) : '';
          newContent = `\n🔧 Tool: ${toolName}\n${toolInput ? `Input: ${toolInput}\n` : ''}`;
          break;
        }
        case 'auto_mode_phase': {
          const phaseEmoji =
            event.phase === 'planning' ? '📋' : event.phase === 'action' ? '⚡' : '✅';
          newContent = `\n${phaseEmoji} ${event.message}\n`;
          break;
        }
        case 'auto_mode_error':
          newContent = `\n❌ Error: ${event.error}\n`;
          break;
        case 'auto_mode_ultrathink_preparation': {
          // Format thinking level preparation information
          let prepContent = `\n🧠 Ultrathink Preparation\n`;

          if (event.warnings && event.warnings.length > 0) {
            prepContent += `\n⚠️ Warnings:\n`;
            event.warnings.forEach((warning: string) => {
              prepContent += `  • ${warning}\n`;
            });
          }

          if (event.recommendations && event.recommendations.length > 0) {
            prepContent += `\n💡 Recommendations:\n`;
            event.recommendations.forEach((rec: string) => {
              prepContent += `  • ${rec}\n`;
            });
          }

          if (event.estimatedCost !== undefined) {
            prepContent += `\n💰 Estimated Cost: ~$${event.estimatedCost.toFixed(
              2
            )} per execution\n`;
          }

          if (event.estimatedTime) {
            prepContent += `\n⏱️ Estimated Time: ${event.estimatedTime}\n`;
          }

          newContent = prepContent;
          break;
        }
        case 'planning_started': {
          // Show when planning mode begins
          if ('mode' in event && 'message' in event) {
            const modeLabel =
              event.mode === 'lite' ? 'Lite' : event.mode === 'spec' ? 'Spec' : 'Full';
            newContent = `\n📋 Planning Mode: ${modeLabel}\n${event.message}\n`;
          }
          break;
        }
        case 'plan_approval_required':
          // Show when plan requires approval
          if ('planningMode' in event) {
            newContent = `\n⏸️ Plan generated - waiting for your approval...\n`;
          }
          break;
        case 'plan_approved':
          // Show when plan is manually approved
          if ('hasEdits' in event) {
            newContent = event.hasEdits
              ? `\n✅ Plan approved (with edits) - continuing to implementation...\n`
              : `\n✅ Plan approved - continuing to implementation...\n`;
          }
          break;
        case 'plan_auto_approved':
          // Show when plan is auto-approved
          newContent = `\n✅ Plan auto-approved - continuing to implementation...\n`;
          break;
        case 'plan_revision_requested': {
          // Show when user requests plan revision
          if ('planVersion' in event) {
            const revisionEvent = event as Extract<
              AutoModeEvent,
              { type: 'plan_revision_requested' }
            >;
            newContent = `\n🔄 Revising plan based on your feedback (v${revisionEvent.planVersion})...\n`;
          }
          break;
        }
        case 'auto_mode_task_started': {
          // Show when a task starts
          if ('taskId' in event && 'taskDescription' in event) {
            const taskEvent = event as Extract<AutoModeEvent, { type: 'auto_mode_task_started' }>;
            newContent = `\n▶ Starting ${taskEvent.taskId}: ${taskEvent.taskDescription}\n`;
          }
          break;
        }
        case 'auto_mode_task_complete': {
          // Show task completion progress
          if ('taskId' in event && 'tasksCompleted' in event && 'tasksTotal' in event) {
            const taskEvent = event as Extract<AutoModeEvent, { type: 'auto_mode_task_complete' }>;
            newContent = `\n✓ ${taskEvent.taskId} completed (${taskEvent.tasksCompleted}/${taskEvent.tasksTotal})\n`;
          }
          break;
        }
        case 'auto_mode_phase_complete': {
          // Show phase completion for full mode
          if ('phaseNumber' in event) {
            const phaseEvent = event as Extract<
              AutoModeEvent,
              { type: 'auto_mode_phase_complete' }
            >;
            newContent = `\n🏁 Phase ${phaseEvent.phaseNumber} complete\n`;
          }
          break;
        }
        case 'auto_mode_feature_complete': {
          const emoji = event.passes ? '✅' : '⚠️';
          newContent = `\n${emoji} Task completed: ${event.message}\n`;

          // Close the modal when the feature is verified (passes = true)
          if (event.passes) {
            // Small delay to show the completion message before closing
            setTimeout(() => {
              onClose();
            }, 1500);
          }
          break;
        }
      }

      if (newContent) {
        // Append new content from WebSocket to streamed content
        setStreamedContent((prev) => prev + newContent);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [open, featureId, isBacklogPlan, onClose]);

  // Listen to backlog plan events and update output
  useEffect(() => {
    if (!open || !isBacklogPlan) return;

    const api = getElectronAPI();
    if (!api?.backlogPlan) return;

    const unsubscribe = api.backlogPlan.onEvent((data: unknown) => {
      const event = data as BacklogPlanEvent;
      if (!event?.type) return;

      let newContent = '';
      switch (event.type) {
        case 'backlog_plan_progress':
          newContent = `\n🧭 ${event.content || 'Backlog plan progress update'}\n`;
          break;
        case 'backlog_plan_error':
          newContent = `\n❌ Backlog plan error: ${event.error || 'Unknown error'}\n`;
          break;
        case 'backlog_plan_complete':
          newContent = `\n✅ Backlog plan completed\n`;
          break;
        default:
          newContent = `\nℹ️ ${event.type}\n`;
          break;
      }

      if (newContent) {
        setStreamedContent((prev) => prev + newContent);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [open, isBacklogPlan]);

  // Handle scroll to detect if user scrolled up
  const handleScroll = () => {
    if (!scrollRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const isAtBottom =
      scrollHeight - scrollTop - clientHeight < MODAL_CONSTANTS.AUTOSCROLL_THRESHOLD;
    autoScrollRef.current = isAtBottom;
  };

  // Handle number key presses while modal is open
  useEffect(() => {
    if (!open || !onNumberKeyPress) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // Check if a number key (0-9) was pressed without modifiers
      if (!event.ctrlKey && !event.altKey && !event.metaKey && /^[0-9]$/.test(event.key)) {
        event.preventDefault();
        onNumberKeyPress(event.key);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onNumberKeyPress]);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent
        className="w-full max-h-[85dvh] max-w-[calc(100%-2rem)] sm:w-[60vw] sm:max-w-[60vw] sm:max-h-[80vh] md:w-[90vw] md:max-w-[1200px] md:max-h-[85vh] rounded-xl flex flex-col"
        data-testid="agent-output-modal"
        aria-describedby={undefined}
      >
        <DialogHeader className="shrink-0">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pr-10">
            <DialogTitle className="flex items-center gap-2">
              {resolvedStatus !== 'verified' && resolvedStatus !== 'waiting_approval' && (
                <Spinner size="md" />
              )}
              Agent Output
            </DialogTitle>
            <div className="flex items-center gap-1 bg-muted rounded-lg p-1 overflow-x-auto">
              {summary && (
                <button
                  onClick={() => setViewMode('summary')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all whitespace-nowrap ${
                    effectiveViewMode === 'summary'
                      ? 'bg-primary/20 text-primary shadow-sm'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                  }`}
                  data-testid="view-mode-summary"
                >
                  <ClipboardList className="w-3.5 h-3.5" />
                  Summary
                </button>
              )}
              <button
                onClick={() => setViewMode('parsed')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all whitespace-nowrap ${
                  effectiveViewMode === 'parsed'
                    ? 'bg-primary/20 text-primary shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                }`}
                data-testid="view-mode-parsed"
              >
                <List className="w-3.5 h-3.5" />
                Logs
              </button>
              <button
                onClick={() => setViewMode('changes')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all whitespace-nowrap ${
                  effectiveViewMode === 'changes'
                    ? 'bg-primary/20 text-primary shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                }`}
                data-testid="view-mode-changes"
              >
                <GitBranch className="w-3.5 h-3.5" />
                Changes
              </button>
              <button
                onClick={() => setViewMode('timeline')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all whitespace-nowrap ${
                  effectiveViewMode === MODAL_CONSTANTS.VIEW_MODES.TIMELINE
                    ? 'bg-primary/20 text-primary shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                }`}
                data-testid="view-mode-timeline"
              >
                <History className="w-3.5 h-3.5" />
                Timeline
              </button>
              <button
                onClick={() => setViewMode('raw')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all whitespace-nowrap ${
                  effectiveViewMode === 'raw'
                    ? 'bg-primary/20 text-primary shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                }`}
                data-testid="view-mode-raw"
              >
                <FileText className="w-3.5 h-3.5" />
                Raw
              </button>
              <button
                onClick={handleOpenHerdr}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all whitespace-nowrap text-muted-foreground hover:text-foreground hover:bg-accent"
                data-testid="open-herdr-web"
              >
                <Bot className="w-3.5 h-3.5" />
                Agent
              </button>
              {onReply && featureStatus === 'waiting_approval' && (
                <button
                  onClick={onReply}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all whitespace-nowrap bg-primary text-primary-foreground hover:bg-primary/90"
                  data-testid="reply-to-agent"
                >
                  <MessageSquare className="w-3.5 h-3.5" />
                  Reply
                </button>
              )}
            </div>
          </div>
        </DialogHeader>

        {/* Task Progress Panel - shows when tasks are being executed */}
        {!isBacklogPlan && (
          <TaskProgressPanel
            featureId={featureId}
            projectPath={resolvedProjectPath}
            className="shrink-0 mx-3 my-2"
          />
        )}

        {effectiveViewMode === 'changes' ? (
          <div
            className={`flex-1 min-h-0 ${MODAL_CONSTANTS.COMPONENT_HEIGHTS.SMALL_MIN} ${MODAL_CONSTANTS.COMPONENT_HEIGHTS.SMALL_MAX} overflow-y-auto scrollbar-visible`}
          >
            {resolvedProjectPath ? (
              <GitDiffPanel
                projectPath={resolvedProjectPath}
                featureId={resolvedBranchName || featureId}
                compact={false}
                useWorktrees={useWorktrees}
                className="border-0 rounded-lg"
              />
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                <Spinner size="lg" className="mr-2" />
                Loading...
              </div>
            )}
          </div>
        ) : effectiveViewMode === 'summary' && summary ? (
          <>
            {/* Step navigator for multi-phase summaries */}
            {hasMultiplePhases && (
              <StepNavigator
                phaseEntries={phaseEntries}
                activeIndex={activePhaseIndex}
                onIndexChange={setActivePhaseIndex}
              />
            )}

            <div
              ref={summaryScrollRef}
              onScroll={handleSummaryScroll}
              className="flex-1 min-h-0 sm:min-h-[200px] sm:max-h-[60vh] overflow-y-auto scrollbar-visible space-y-4 p-1"
            >
              {hasMultiplePhases ? (
                // Multi-phase: render individual phase cards
                phaseEntries.map((entry, index) => (
                  <div key={`phase-${index}-${entry.phaseName}`} data-phase-index={index}>
                    <PhaseEntryCard
                      entry={entry}
                      index={index}
                      totalPhases={phaseEntries.length}
                      hasMultiplePhases={hasMultiplePhases}
                      isActive={index === activePhaseIndex}
                      onClick={() => setActivePhaseIndex(index)}
                    />
                  </div>
                ))
              ) : (
                // Single phase: render as markdown
                <div className="bg-card border border-border/50 rounded-lg p-4">
                  <Markdown>{summary}</Markdown>
                </div>
              )}
            </div>

            <div className="text-xs text-muted-foreground text-center shrink-0">
              {summaryAutoScroll
                ? 'Auto-scrolling enabled'
                : 'Scroll to bottom to enable auto-scroll'}
            </div>
          </>
        ) : effectiveViewMode === MODAL_CONSTANTS.VIEW_MODES.TIMELINE ? (
          <div
            className={`flex-1 min-h-0 ${MODAL_CONSTANTS.COMPONENT_HEIGHTS.SMALL_MIN} ${MODAL_CONSTANTS.COMPONENT_HEIGHTS.SMALL_MAX} overflow-y-auto scrollbar-visible space-y-2 p-1`}
            data-testid="feature-timeline"
          >
            {timelineLoading && !timeline ? (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                <Spinner size="lg" className="mr-2" />
                Loading timeline...
              </div>
            ) : !timeline || timeline.length === 0 ? (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                这张卡片还没有可展示的时间线。
              </div>
            ) : (
              timeline.map((entry) => (
                <div
                  key={entry.id}
                  className="rounded-lg border border-border/50 bg-card p-3"
                  data-testid={`timeline-entry-${entry.kind}`}
                >
                  <div className="flex items-center gap-2 text-xs">
                    {entry.kind === 'session' ? (
                      <MessageSquare className="w-3.5 h-3.5 shrink-0 text-brand-500" />
                    ) : entry.kind === 'one-shot' ? (
                      <Zap className="w-3.5 h-3.5 shrink-0 text-amber-500" />
                    ) : entry.kind === 'jira' ? (
                      <RefreshCw className="w-3.5 h-3.5 shrink-0 text-purple-500" />
                    ) : (
                      <Flag className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate font-medium">{entry.title}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                      {formatTimelineTime(entry.at)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                    {entry.model && (
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono">
                        {entry.model}
                      </span>
                    )}
                    {typeof entry.turns === 'number' && <span>{entry.turns} 轮</span>}
                    {entry.endedAt && <span>结束 {formatTimelineTime(entry.endedAt)}</span>}
                    {entry.status === 'error' && <span className="text-destructive">出错</span>}
                  </div>
                  {entry.detail && (
                    <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                      {entry.detail}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>
        ) : (
          <>
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className={`flex-1 min-h-0 ${MODAL_CONSTANTS.COMPONENT_HEIGHTS.SMALL_MIN} ${MODAL_CONSTANTS.COMPONENT_HEIGHTS.SMALL_MAX} overflow-y-auto bg-popover border border-border/50 rounded-lg p-4 font-mono text-xs scrollbar-visible`}
            >
              {isLoading && !output ? (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  <Spinner size="lg" className="mr-2" />
                  Loading output...
                </div>
              ) : !output ? (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  No output yet. The agent will stream output here as it works.
                </div>
              ) : effectiveViewMode === 'parsed' ? (
                <LogViewer output={output} />
              ) : (
                <div className="whitespace-pre-wrap wrap-break-word text-foreground/80">
                  {output}
                </div>
              )}
            </div>

            <div className="text-xs text-muted-foreground text-center shrink-0">
              {autoScrollRef.current
                ? 'Auto-scrolling enabled'
                : 'Scroll to bottom to enable auto-scroll'}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
