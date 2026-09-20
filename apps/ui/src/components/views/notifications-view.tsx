/**
 * Notifications View - Full page view for all notifications
 */

import { useCallback, useMemo, useState } from 'react';
import { useAppStore } from '@/store/app-store';
import { useNotificationsStore } from '@/store/notifications-store';
import { useLoadNotifications, useNotificationEvents } from '@/hooks/use-notification-events';
import { getHttpApiClient } from '@/lib/http-api-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { ArrowRight, Bell, Check, CheckCheck, Clock, Inbox, Trash2 } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import type { Notification } from '@automaker/types';
import { cn, formatRelativeTime } from '@/lib/utils';
import {
  formatNotificationTimestamp,
  getNotificationMeta,
  groupNotificationsByDate,
} from '@/lib/notification-meta';

type NotificationFilter = 'all' | 'unread';

export function NotificationsView() {
  const { currentProject } = useAppStore();
  const projectPath = currentProject?.path ?? null;
  const navigate = useNavigate();
  const [filter, setFilter] = useState<NotificationFilter>('all');

  const {
    notifications,
    unreadCount,
    isLoading,
    error,
    markAsRead,
    dismissNotification,
    markAllAsRead,
    dismissAll,
  } = useNotificationsStore();

  // Load notifications when project changes
  useLoadNotifications(projectPath);

  // Subscribe to real-time notification events
  useNotificationEvents(projectPath);

  const handleMarkAsRead = useCallback(
    async (notificationId: string) => {
      if (!projectPath) return;

      // Optimistic update
      markAsRead(notificationId);

      // Sync with server
      const api = getHttpApiClient();
      await api.notifications.markAsRead(projectPath, notificationId);
    },
    [projectPath, markAsRead]
  );

  const handleDismiss = useCallback(
    async (notificationId: string) => {
      if (!projectPath) return;

      // Optimistic update
      dismissNotification(notificationId);

      // Sync with server
      const api = getHttpApiClient();
      await api.notifications.dismiss(projectPath, notificationId);
    },
    [projectPath, dismissNotification]
  );

  const handleMarkAllAsRead = useCallback(async () => {
    if (!projectPath) return;

    // Optimistic update
    markAllAsRead();

    // Sync with server
    const api = getHttpApiClient();
    await api.notifications.markAsRead(projectPath);
  }, [projectPath, markAllAsRead]);

  const handleDismissAll = useCallback(async () => {
    if (!projectPath) return;

    // Optimistic update
    dismissAll();

    // Sync with server
    const api = getHttpApiClient();
    await api.notifications.dismiss(projectPath);
  }, [projectPath, dismissAll]);

  const handleNotificationClick = useCallback(
    (notification: Notification) => {
      // Mark as read
      if (!notification.read) handleMarkAsRead(notification.id);

      // Navigate to the relevant view based on notification type
      if (notification.featureId) {
        navigate({
          to: '/board',
          search: {
            featureId: notification.featureId,
            projectPath: notification.projectPath || undefined,
          },
        });
      }
    },
    [handleMarkAsRead, navigate]
  );

  const visibleNotifications = useMemo(
    () => (filter === 'unread' ? notifications.filter((n) => !n.read) : notifications),
    [filter, notifications]
  );

  const groups = useMemo(
    () => groupNotificationsByDate(visibleNotifications),
    [visibleNotifications]
  );

  if (!projectPath) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <Bell className="h-8 w-8 text-muted-foreground/60" />
        </div>
        <p className="mt-4 text-muted-foreground">Select a project to view notifications</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8">
        <Spinner size="xl" />
        <p className="text-muted-foreground mt-4">Loading notifications...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8">
        <p className="text-destructive">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-6">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Bell className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold leading-tight">Notifications</h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {unreadCount > 0
                  ? `${unreadCount} unread · ${notifications.length} total`
                  : notifications.length > 0
                    ? `All caught up · ${notifications.length} total`
                    : 'Feature updates and operation results appear here'}
              </p>
            </div>
          </div>
          {notifications.length > 0 && (
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleMarkAllAsRead}
                disabled={unreadCount === 0}
              >
                <CheckCheck className="h-4 w-4 mr-2" />
                Mark all read
              </Button>
              <Button variant="outline" size="sm" onClick={handleDismissAll}>
                <Trash2 className="h-4 w-4 mr-2" />
                Clear all
              </Button>
            </div>
          )}
        </div>

        {/* Filter */}
        {notifications.length > 0 && (
          <div className="mt-6 inline-flex items-center gap-1 rounded-lg bg-muted p-1">
            {(['all', 'unread'] as const).map((value) => {
              const active = filter === value;
              const count = value === 'all' ? notifications.length : unreadCount;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFilter(value)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                    active
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {value === 'all' ? 'All' : 'Unread'}
                  <span
                    className={cn(
                      'rounded-full px-1.5 text-[11px] tabular-nums',
                      active ? 'bg-muted' : 'bg-background/60'
                    )}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* List */}
        {visibleNotifications.length === 0 ? (
          <EmptyState filter={filter} />
        ) : (
          <div className="mt-4 space-y-6">
            {groups.map((group) => (
              <section key={group.label} className="space-y-2">
                <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </h2>
                <div className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm">
                  {group.items.map((notification, index) => (
                    <NotificationRow
                      key={notification.id}
                      notification={notification}
                      showDivider={index > 0}
                      onOpen={() => handleNotificationClick(notification)}
                      onMarkAsRead={() => handleMarkAsRead(notification.id)}
                      onDismiss={() => handleDismiss(notification.id)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ filter }: { filter: NotificationFilter }) {
  return (
    <div className="mt-4 flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 bg-card/50 px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
        {filter === 'unread' ? (
          <CheckCheck className="h-7 w-7 text-muted-foreground/60" />
        ) : (
          <Inbox className="h-7 w-7 text-muted-foreground/60" />
        )}
      </div>
      <p className="mt-4 text-base font-medium">
        {filter === 'unread' ? 'You are all caught up' : 'No notifications yet'}
      </p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {filter === 'unread'
          ? 'There are no unread notifications for this project.'
          : 'Notifications will appear here when features need review, finish, or encounter an error.'}
      </p>
    </div>
  );
}

interface NotificationRowProps {
  notification: Notification;
  showDivider: boolean;
  onOpen: () => void;
  onMarkAsRead: () => void;
  onDismiss: () => void;
}

function NotificationRow({
  notification,
  showDivider,
  onOpen,
  onMarkAsRead,
  onDismiss,
}: NotificationRowProps) {
  const meta = getNotificationMeta(notification.type);
  const Icon = meta.icon;
  const hasAction = Boolean(notification.featureId);

  return (
    <div
      role={hasAction ? 'button' : undefined}
      tabIndex={hasAction ? 0 : undefined}
      onClick={hasAction ? onOpen : undefined}
      onKeyDown={
        hasAction
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onOpen();
              }
            }
          : undefined
      }
      className={cn(
        'group/notification relative flex items-start gap-3 px-4 py-3.5 transition-colors',
        showDivider && 'border-t border-border/50',
        !notification.read && 'bg-primary/[0.04]',
        hasAction && 'cursor-pointer hover:bg-accent/40 focus:bg-accent/40 focus:outline-none'
      )}
    >
      {/* Unread accent bar */}
      {!notification.read && (
        <span
          className={cn('absolute inset-y-0 left-0 w-0.5', meta.accentClass)}
          aria-hidden="true"
        />
      )}

      {/* Icon */}
      <div
        className={cn(
          'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg',
          meta.iconBgClass
        )}
      >
        <Icon className={cn('h-[18px] w-[18px]', meta.iconClass)} />
      </div>

      {/* Body */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p
            className={cn(
              'truncate text-sm leading-tight',
              notification.read ? 'font-medium' : 'font-semibold'
            )}
          >
            {notification.title}
          </p>
          <Badge variant={meta.badgeVariant} size="sm" className="shrink-0">
            {meta.label}
          </Badge>
          {!notification.read && (
            <span
              className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary"
              aria-hidden="true"
            />
          )}
        </div>

        {notification.message && (
          <p className="mt-1 text-sm leading-snug text-muted-foreground">{notification.message}</p>
        )}

        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span
            className="inline-flex items-center gap-1"
            title={new Date(notification.createdAt).toLocaleString()}
          >
            <Clock className="h-3 w-3" />
            {formatRelativeTime(new Date(notification.createdAt))}
            <span className="text-muted-foreground/60">
              · {formatNotificationTimestamp(notification.createdAt)}
            </span>
          </span>
          {notification.featureId && (
            <span
              className="inline-flex max-w-[220px] items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80"
              title={`Feature ID: ${notification.featureId}`}
            >
              <span className="truncate">{notification.featureId}</span>
            </span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-shrink-0 items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover/notification:opacity-100 sm:group-focus-within/notification:opacity-100">
        {!notification.read && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={(e) => {
              e.stopPropagation();
              onMarkAsRead();
            }}
            title="Mark as read"
            aria-label="Mark as read"
          >
            <Check className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          title="Dismiss"
          aria-label="Dismiss"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
        {hasAction && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            title="Open feature"
            aria-label="Open feature"
          >
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}
