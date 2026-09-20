// @ts-nocheck - optional callback prop typing with feature status narrowing
import { memo } from 'react';
import { Feature } from '@/store/app-store';
import { Button } from '@/components/ui/button';
import { isNeedsAttentionStatus } from '../../constants';
import {
  PlayCircle,
  RotateCcw,
  StopCircle,
  CheckCircle2,
  FileText,
  Eye,
  Wand2,
  Archive,
  Bot,
  MessageSquareReply,
} from 'lucide-react';

interface CardActionsProps {
  feature: Feature;
  isCurrentAutoTask: boolean;
  /** Whether this feature is tracked as a running task (may be true even before status updates to in_progress) */
  isRunningTask?: boolean;
  hasContext?: boolean;
  shortcutKey?: string;
  isSelectionMode?: boolean;
  onViewOutput?: () => void;
  onVerify?: () => void;
  onResume?: () => void;
  onForceStop?: () => void;
  onManualVerify?: () => void;
  onFollowUp?: () => void;
  /** Reopen a finished card so the user can send feedback and the agent continues */
  onRequestChanges?: () => void;
  onImplement?: () => void;
  onComplete?: () => void;
  onViewPlan?: () => void;
  onApprovePlan?: () => void;
  onOpenHerdr?: () => void;
  /** Approval lane: open the acceptance result (验收结果) for human verification */
  onViewAcceptance?: () => void;
}

export const CardActions = memo(function CardActions({
  feature,
  isCurrentAutoTask,
  isRunningTask = false,
  hasContext = false,
  shortcutKey,
  isSelectionMode = false,
  onViewOutput,
  onVerify,
  onResume,
  onForceStop,
  onManualVerify,
  onFollowUp,
  onRequestChanges,
  onImplement,
  onComplete,
  onViewPlan,
  onApprovePlan,
  onOpenHerdr,
  onViewAcceptance,
}: CardActionsProps) {
  const showBacklogLogsButton = hasContext && !!onViewOutput;
  // Every agent conversation is now served by the shared herdr session: the
  // board attaches to the same panes that run the work, whichever CLI is in
  // them. Provider-specific web pages are intentionally not offered anymore.
  const showConversation = !!onOpenHerdr;
  // Lane rule mirrors use-board-column-features: a card carrying a notice (or a
  // failure/conflict/interrupted status) waits for a human, so it offers Reply
  // and the agent conversation instead of Verify.
  const hasNotice = typeof feature.error === 'string' && feature.error.trim() !== '';
  const needsAttention = hasNotice || isNeedsAttentionStatus(feature.status);

  // Hide all actions when in selection mode
  if (isSelectionMode) {
    return null;
  }
  if (feature.archive || feature.supersededBy || feature.consolidationPlanId) {
    return (
      <div className="flex flex-wrap gap-1.5 pb-3 text-xs text-muted-foreground">
        <span>
          {feature.archive
            ? 'Archived'
            : feature.supersededBy
              ? 'Covered and archived'
              : 'Consolidation in progress'}
        </span>
        {onViewOutput && (
          <Button
            size="sm"
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              onViewOutput();
            }}
          >
            查看历史
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-1.5 -mx-3 -mb-3 px-3 pb-3">
      {isCurrentAutoTask && (
        <>
          {/* Approve Plan button - PRIORITY: shows even when agent is "running" (paused for approval) */}
          {feature.planSpec?.status === 'generated' && onApprovePlan && (
            <Button
              variant="default"
              size="sm"
              className="flex-1 min-w-0 h-7 text-[11px] bg-purple-600 hover:bg-purple-700 text-white animate-pulse"
              onClick={(e) => {
                e.stopPropagation();
                onApprovePlan();
              }}
              onPointerDown={(e) => e.stopPropagation()}
              data-testid={`approve-plan-running-${feature.id}`}
              title="Approve Plan"
              aria-label="Approve Plan"
            >
              <FileText className="w-3 h-3 mr-1 shrink-0" />
              <span className="truncate">Approve Plan</span>
            </Button>
          )}
          {onViewOutput && (
            <Button
              variant="secondary"
              size="sm"
              className="flex-1 h-7 text-[11px]"
              onClick={(e) => {
                e.stopPropagation();
                onViewOutput();
              }}
              onPointerDown={(e) => e.stopPropagation()}
              data-testid={`view-output-${feature.id}`}
              title="Logs"
              aria-label="Logs"
            >
              <FileText className="w-3 h-3 mr-1 shrink-0" />
              <span className="truncate">Logs</span>
              {shortcutKey && (
                <span
                  className="ml-1.5 px-1 py-0.5 text-[9px] font-mono rounded bg-foreground/10"
                  data-testid={`shortcut-key-${feature.id}`}
                >
                  {shortcutKey}
                </span>
              )}
            </Button>
          )}
          {onForceStop && (
            <Button
              variant="destructive"
              size="sm"
              className="h-7 text-[11px] px-2 shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                onForceStop();
              }}
              onPointerDown={(e) => e.stopPropagation()}
              data-testid={`force-stop-${feature.id}`}
              title="Stop"
              aria-label="Stop"
            >
              <StopCircle className="w-3 h-3" />
            </Button>
          )}
        </>
      )}
      {!isCurrentAutoTask &&
        (feature.status === 'in_progress' ||
          (typeof feature.status === 'string' && feature.status.startsWith('pipeline_'))) && (
          <>
            {/* When feature is in_progress with no error and onForceStop is available,
                it means the agent is starting/running but hasn't been added to runningAutoTasks yet.
                Show Stop button instead of Verify/Resume to avoid confusing UI during this race window. */}
            {!feature.error && onForceStop ? (
              <>
                {onViewOutput && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="flex-1 h-7 text-[11px]"
                    onClick={(e) => {
                      e.stopPropagation();
                      onViewOutput();
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    data-testid={`view-output-${feature.id}`}
                    title="Logs"
                    aria-label="Logs"
                  >
                    <FileText className="w-3 h-3 mr-1 shrink-0" />
                    <span className="truncate">Logs</span>
                    {shortcutKey && (
                      <span
                        className="ml-1.5 px-1 py-0.5 text-[9px] font-mono rounded bg-foreground/10"
                        data-testid={`shortcut-key-${feature.id}`}
                      >
                        {shortcutKey}
                      </span>
                    )}
                  </Button>
                )}
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-7 text-[11px] px-2 shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    onForceStop();
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  data-testid={`force-stop-${feature.id}`}
                  title="Stop"
                  aria-label="Stop"
                >
                  <StopCircle className="w-3 h-3" />
                </Button>
              </>
            ) : (
              <>
                {/* Approve Plan button - shows when plan is generated and waiting for approval */}
                {feature.planSpec?.status === 'generated' && onApprovePlan && (
                  <Button
                    variant="default"
                    size="sm"
                    className="flex-1 h-7 text-[11px] bg-purple-600 hover:bg-purple-700 text-white animate-pulse"
                    onClick={(e) => {
                      e.stopPropagation();
                      onApprovePlan();
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    data-testid={`approve-plan-${feature.id}`}
                    title="Approve Plan"
                    aria-label="Approve Plan"
                  >
                    <FileText className="w-3 h-3 mr-1" />
                    Approve Plan
                  </Button>
                )}
                {feature.skipTests && onManualVerify && !needsAttention ? (
                  <Button
                    variant="default"
                    size="sm"
                    className="flex-1 h-7 text-[11px]"
                    onClick={(e) => {
                      e.stopPropagation();
                      onManualVerify();
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    data-testid={`manual-verify-${feature.id}`}
                    title="Verify"
                    aria-label="Verify"
                  >
                    <CheckCircle2 className="w-3 h-3 mr-1" />
                    Verify
                  </Button>
                ) : onResume ? (
                  <Button
                    variant="default"
                    size="sm"
                    className="flex-1 h-7 text-[11px] bg-[var(--status-success)] hover:bg-[var(--status-success)]/90"
                    onClick={(e) => {
                      e.stopPropagation();
                      onResume();
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    data-testid={`resume-feature-${feature.id}`}
                    title="Resume"
                    aria-label="Resume"
                  >
                    <RotateCcw className="w-3 h-3 mr-1" />
                    Resume
                  </Button>
                ) : onVerify && !needsAttention ? (
                  <Button
                    variant="default"
                    size="sm"
                    className="flex-1 h-7 text-[11px] bg-[var(--status-success)] hover:bg-[var(--status-success)]/90"
                    onClick={(e) => {
                      e.stopPropagation();
                      onVerify();
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    data-testid={`verify-feature-${feature.id}`}
                    title="Verify"
                    aria-label="Verify"
                  >
                    <CheckCircle2 className="w-3 h-3 mr-1" />
                    Verify
                  </Button>
                ) : null}
                {onViewOutput && !feature.skipTests && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-7 text-[11px] px-2"
                    onClick={(e) => {
                      e.stopPropagation();
                      onViewOutput();
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    data-testid={`view-output-${feature.id}`}
                    title="Logs"
                    aria-label="Logs"
                  >
                    <FileText className="w-3 h-3" />
                  </Button>
                )}
              </>
            )}
          </>
        )}
      {!isCurrentAutoTask && feature.status === 'verified' && (
        <div className="flex w-full min-w-0 gap-1.5">
          {/* Complete button */}
          {onComplete && (
            <Button
              variant="default"
              size="sm"
              className="flex-1 basis-0 h-9 text-xs min-w-0 px-2 bg-brand-500 hover:bg-brand-600"
              onClick={(e) => {
                e.stopPropagation();
                if (feature.completionSource !== 'human' && onViewAcceptance) onViewAcceptance();
                else onComplete();
              }}
              onPointerDown={(e) => e.stopPropagation()}
              data-testid={`complete-${feature.id}`}
              title="Complete"
              aria-label="Complete"
            >
              <Archive className="w-3 h-3 mr-1 shrink-0" />
              <span className="truncate">Complete</span>
            </Button>
          )}
          {/* Feedback button - reopens a finished card when the task turned out to
              need more work (e.g. the Jira issue was re-split). */}
          {onRequestChanges && (
            <Button
              variant="secondary"
              size="sm"
              className="flex-1 basis-0 h-9 text-xs min-w-0 px-2"
              onClick={(e) => {
                e.stopPropagation();
                onRequestChanges();
              }}
              onPointerDown={(e) => e.stopPropagation()}
              data-testid={`request-changes-${feature.id}`}
              aria-label="Request Changes"
              title="Request Changes — Send feedback and reopen this task (moves back to Waiting Review)"
            >
              <MessageSquareReply className="w-3 h-3 shrink-0" />
              <span className="truncate">Request Changes</span>
            </Button>
          )}
        </div>
      )}
      {!isCurrentAutoTask &&
        !isRunningTask &&
        (feature.status === 'waiting_approval' ||
          (['backlog', 'ready', 'interrupted', 'merge_conflict'].includes(feature.status) &&
            (hasContext || feature.providerSessionId || feature.error))) && (
          <>
            {/* Verification comes first in this lane: the human reviews the
              acceptance result (screenshots + checks) before anything else. */}
            {feature.status === 'waiting_approval' && !needsAttention && onViewAcceptance && (
              <Button
                variant="default"
                size="sm"
                className="flex-1 basis-[80px] h-7 text-[11px] min-w-0 px-2 bg-[var(--status-success)] hover:bg-[var(--status-success)]/90"
                onClick={(e) => {
                  e.stopPropagation();
                  onViewAcceptance();
                }}
                onPointerDown={(e) => e.stopPropagation()}
                data-testid={`verify-acceptance-${feature.id}`}
                title="Verify"
                aria-label="Verify"
              >
                <CheckCircle2 className="w-3 h-3 mr-1 shrink-0" />
                <span className="truncate">Verify</span>
              </Button>
            )}
            {/* Waiting for approval means the user has to answer the agent (or
              confirm a plan), so the primary action opens the reply input. */}
            {onFollowUp && (
              <Button
                variant="default"
                size="sm"
                className="flex-1 basis-[80px] h-7 text-[11px] min-w-0 px-2"
                onClick={(e) => {
                  e.stopPropagation();
                  onFollowUp();
                }}
                onPointerDown={(e) => e.stopPropagation()}
                data-testid={`reply-${feature.id}`}
                title="Reply"
                aria-label="Reply"
              >
                <MessageSquareReply className="w-3 h-3 mr-1 shrink-0" />
                <span className="truncate">Reply</span>
                {shortcutKey && (
                  <span
                    className="ml-1.5 px-1 py-0.5 text-[9px] font-mono rounded bg-foreground/10"
                    data-testid={`shortcut-key-${feature.id}`}
                  >
                    {shortcutKey}
                  </span>
                )}
              </Button>
            )}
          </>
        )}
      {/* Running task with stale status: feature is tracked as running but status hasn't updated yet.
          Show Logs/Stop controls instead of Make to avoid confusing UI. */}
      {!isCurrentAutoTask &&
        isRunningTask &&
        (feature.status === 'backlog' ||
          feature.status === 'merge_conflict' ||
          feature.status === 'interrupted' ||
          feature.status === 'ready') && (
          <>
            {onViewOutput && (
              <Button
                variant="secondary"
                size="sm"
                className="flex-1 h-7 text-[11px]"
                onClick={(e) => {
                  e.stopPropagation();
                  onViewOutput();
                }}
                onPointerDown={(e) => e.stopPropagation()}
                data-testid={`view-output-${feature.id}`}
                title="Logs"
                aria-label="Logs"
              >
                <FileText className="w-3 h-3 mr-1 shrink-0" />
                <span className="truncate">Logs</span>
                {shortcutKey && (
                  <span
                    className="ml-1.5 px-1 py-0.5 text-[9px] font-mono rounded bg-foreground/10"
                    data-testid={`shortcut-key-${feature.id}`}
                  >
                    {shortcutKey}
                  </span>
                )}
              </Button>
            )}
            {onForceStop && (
              <Button
                variant="destructive"
                size="sm"
                className="h-7 text-[11px] px-2 shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  onForceStop();
                }}
                onPointerDown={(e) => e.stopPropagation()}
                data-testid={`force-stop-${feature.id}`}
                title="Stop"
                aria-label="Stop"
              >
                <StopCircle className="w-3 h-3" />
              </Button>
            )}
          </>
        )}
      {!isCurrentAutoTask &&
        !isRunningTask &&
        (feature.status === 'backlog' ||
          feature.status === 'merge_conflict' ||
          feature.status === 'interrupted' ||
          feature.status === 'ready') && (
          <>
            {showBacklogLogsButton && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs px-2"
                onClick={(e) => {
                  e.stopPropagation();
                  onViewOutput();
                }}
                onPointerDown={(e) => e.stopPropagation()}
                data-testid={`view-output-backlog-${feature.id}`}
                title="View Logs"
              >
                <FileText className="w-3 h-3" />
              </Button>
            )}
            {feature.planSpec?.content && onViewPlan && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs px-2"
                onClick={(e) => {
                  e.stopPropagation();
                  onViewPlan();
                }}
                onPointerDown={(e) => e.stopPropagation()}
                data-testid={`view-plan-${feature.id}`}
                title="View Plan"
              >
                <Eye className="w-3 h-3" />
              </Button>
            )}
            {onImplement && (
              <Button
                variant={feature.error ? 'destructive' : 'default'}
                size="sm"
                className="flex-1 h-7 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  onImplement();
                }}
                onPointerDown={(e) => e.stopPropagation()}
                data-testid={`make-${feature.id}`}
                title={
                  feature.error
                    ? `Retry — ${feature.error}`
                    : feature.status === 'merge_conflict'
                      ? 'Restart'
                      : 'Make'
                }
              >
                <RotateCcw className="w-3 h-3 mr-1" />
                {feature.error ? 'Retry' : feature.status === 'merge_conflict' ? 'Restart' : 'Make'}
              </Button>
            )}
          </>
        )}
      {/* Herdr runs the shared `automaker` session; every agent conversation
          that belongs to this worktree is attached from the same session. */}
      {showConversation && (
        <Button
          variant="secondary"
          size="sm"
          className={
            !isCurrentAutoTask && feature.status === 'verified'
              ? 'w-full basis-full min-w-0 h-9 text-xs px-2'
              : 'flex-1 basis-[80px] min-w-0 h-7 text-[11px] px-2'
          }
          onClick={(e) => {
            e.stopPropagation();
            onOpenHerdr();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          data-testid={`open-herdr-${feature.id}`}
          title="Agent — Open this task's agent conversation"
          aria-label="Agent"
        >
          <Bot className="w-3 h-3 mr-1 shrink-0" />
          <span className="truncate">Agent</span>
        </Button>
      )}
    </div>
  );
});
