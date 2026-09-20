/**
 * Notification Bell - Bell icon with unread count and popover
 */

import { useCallback } from 'react';
import { Bell, Check, CheckCheck, Clock, Trash2 } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { useNotificationsStore } from '@/store/notifications-store';
import { useLoadNotifications, useNotificationEvents } from '@/hooks/use-notification-events';
import { getHttpApiClient } from '@/lib/http-api-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { Notification } from '@automaker/types';
import { cn, formatRelativeTime } from '@/lib/utils';
import { formatNotificationTimestamp, getNotificationMeta } from '@/lib/notification-meta';

interface NotificationBellProps {
  projectPath: string | null;
}

export function NotificationBell({ projectPath }: NotificationBellProps) {
  const navigate = useNavigate();
  const {
    notifications,
    unreadCount,
    isPopoverOpen,
    setPopoverOpen,
    markAsRead,
    markAllAsRead,
    dismissNotification,
  } = useNotificationsStore();

  // Load notifications and subscribe to events
  useLoadNotifications(projectPath);
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

  const handleMarkAllAsRead = useCallback(async () => {
    if (!projectPath || unreadCount === 0) return;

    // Optimistic update
    markAllAsRead();

    // Sync with server
    const api = getHttpApiClient();
    await api.notifications.markAsRead(projectPath);
  }, [projectPath, unreadCount, markAllAsRead]);

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

  const handleNotificationClick = useCallback(
    (notification: Notification) => {
      // Mark as read
      if (!notification.read) handleMarkAsRead(notification.id);
      setPopoverOpen(false);

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
    [handleMarkAsRead, setPopoverOpen, navigate]
  );

  const handleViewAll = useCallback(() => {
    setPopoverOpen(false);
    navigate({ to: '/notifications' });
  }, [setPopoverOpen, navigate]);

  // Show recent notifications in popover
  const recentNotifications = notifications.slice(0, 5);

  if (!projectPath) {
    return null;
  }

  return (
    <Popover open={isPopoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            'relative flex items-center justify-center w-8 h-8 rounded-md',
            'hover:bg-accent transition-colors',
            'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2'
          )}
          title="Notifications"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0" align="start" side="right">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold">Notifications</h4>
            {unreadCount > 0 && (
              <Badge variant="brand" size="sm">
                {unreadCount} new
              </Badge>
            )}
          </div>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={handleMarkAllAsRead}
            >
              <CheckCheck className="mr-1.5 h-3.5 w-3.5" />
              Mark all read
            </Button>
          )}
        </div>

        {recentNotifications.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-4 py-8">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
              <Bell className="h-5 w-5 text-muted-foreground/50" />
            </div>
            <p className="mt-3 text-sm font-medium">No notifications</p>
            <p className="mt-1 text-xs text-muted-foreground">Feature updates will appear here</p>
          </div>
        ) : (
          <div className="max-h-[340px] overflow-y-auto">
            {recentNotifications.map((notification) => {
              const meta = getNotificationMeta(notification.type);
              const Icon = meta.icon;
              const hasAction = Boolean(notification.featureId);
              return (
                <div
                  key={notification.id}
                  role={hasAction ? 'button' : undefined}
                  tabIndex={hasAction ? 0 : undefined}
                  className={cn(
                    'group/notification relative flex items-start gap-3 border-b border-border/50 px-4 py-3 last:border-b-0',
                    hasAction &&
                      'cursor-pointer hover:bg-accent/40 focus:bg-accent/40 focus:outline-none',
                    !notification.read && 'bg-primary/[0.04]'
                  )}
                  onClick={() => handleNotificationClick(notification)}
                  onKeyDown={
                    hasAction
                      ? (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            handleNotificationClick(notification);
                          }
                        }
                      : undefined
                  }
                >
                  {!notification.read && (
                    <span
                      className={cn('absolute inset-y-0 left-0 w-0.5', meta.accentClass)}
                      aria-hidden="true"
                    />
                  )}
                  <div
                    className={cn(
                      'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg',
                      meta.iconBgClass
                    )}
                  >
                    <Icon className={cn('h-4 w-4', meta.iconClass)} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p
                        className={cn(
                          'truncate text-sm leading-tight',
                          notification.read ? 'font-medium' : 'font-semibold'
                        )}
                      >
                        {notification.title}
                      </p>
                      {!notification.read && (
                        <span
                          className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary"
                          aria-hidden="true"
                        />
                      )}
                    </div>
                    <p className="mt-1 text-xs leading-snug text-muted-foreground line-clamp-2">
                      {notification.message}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Badge variant={meta.badgeVariant} size="sm">
                        {meta.label}
                      </Badge>
                      <span
                        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
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
                          className="inline-flex max-w-[140px] items-center rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/80"
                          title={`Feature ID: ${notification.featureId}`}
                        >
                          <span className="truncate">{notification.featureId}</span>
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-shrink-0 items-start gap-1 opacity-100 transition-opacity group-hover/notification:opacity-100">
                    {!notification.read && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleMarkAsRead(notification.id);
                        }}
                        title="Mark as read"
                        aria-label="Mark as read"
                      >
                        <Check className="h-3 w-3" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDismiss(notification.id);
                      }}
                      title="Dismiss"
                      aria-label="Dismiss"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="border-t px-4 py-2">
          <Button variant="ghost" size="sm" className="w-full text-xs" onClick={handleViewAll}>
            View all notifications
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
