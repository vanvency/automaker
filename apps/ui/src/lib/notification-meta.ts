/**
 * Notification presentation metadata.
 *
 * Maps a notification type to its human label, icon and theme colors so the
 * bell popover and the full-page view stay visually consistent. Colors use the
 * `--status-*` / `--brand-*` CSS variables so every theme is supported.
 */

import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, Bell, Bot, CheckCircle2, FileCheck2 } from 'lucide-react';
import type { Notification, NotificationType } from '@automaker/types';

export type NotificationBadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'success'
  | 'warning'
  | 'error'
  | 'info'
  | 'muted'
  | 'brand';

export interface NotificationMeta {
  /** Human readable label for this notification type */
  label: string;
  /** Icon rendered inside the tinted container */
  icon: LucideIcon;
  /** Foreground color for the icon */
  iconClass: string;
  /** Background tint for the icon container */
  iconBgClass: string;
  /** Solid accent used for the unread bar */
  accentClass: string;
  /** Badge variant for the type label */
  badgeVariant: NotificationBadgeVariant;
}

export const NOTIFICATION_META: Record<NotificationType, NotificationMeta> = {
  feature_waiting_approval: {
    label: 'Ready for Review',
    icon: Bell,
    iconClass: 'text-status-warning',
    iconBgClass: 'bg-status-warning-bg',
    accentClass: 'bg-status-warning',
    badgeVariant: 'warning',
  },
  feature_verified: {
    label: 'Verified',
    icon: CheckCircle2,
    iconClass: 'text-status-success',
    iconBgClass: 'bg-status-success-bg',
    accentClass: 'bg-status-success',
    badgeVariant: 'success',
  },
  spec_regeneration_complete: {
    label: 'Spec Updated',
    icon: FileCheck2,
    iconClass: 'text-status-info',
    iconBgClass: 'bg-status-info-bg',
    accentClass: 'bg-status-info',
    badgeVariant: 'info',
  },
  agent_complete: {
    label: 'Agent Finished',
    icon: Bot,
    iconClass: 'text-brand-500',
    iconBgClass: 'bg-brand-500/15',
    accentClass: 'bg-brand-500',
    badgeVariant: 'brand',
  },
  feature_error: {
    label: 'Feature Failed',
    icon: AlertTriangle,
    iconClass: 'text-status-error',
    iconBgClass: 'bg-status-error-bg',
    accentClass: 'bg-status-error',
    badgeVariant: 'error',
  },
  auto_mode_error: {
    label: 'Auto Mode Error',
    icon: AlertTriangle,
    iconClass: 'text-status-error',
    iconBgClass: 'bg-status-error-bg',
    accentClass: 'bg-status-error',
    badgeVariant: 'error',
  },
};

const FALLBACK_META: NotificationMeta = {
  label: 'Notification',
  icon: Bell,
  iconClass: 'text-muted-foreground',
  iconBgClass: 'bg-muted',
  accentClass: 'bg-muted-foreground',
  badgeVariant: 'muted',
};

/** Resolve presentation metadata for any notification type. */
export function getNotificationMeta(type: string): NotificationMeta {
  return NOTIFICATION_META[type as NotificationType] ?? FALLBACK_META;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Lightweight absolute timestamp, e.g. "Jun 14, 15:32".
 * Uses the user's locale for month/day ordering.
 */
export function formatNotificationTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const isToday = date.toDateString() === new Date().toDateString();
  return date.toLocaleString(undefined, {
    ...(isToday ? {} : { month: 'short', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  });
}

export type NotificationDateGroupLabel = 'Today' | 'Yesterday' | 'Earlier';

/** Bucket a notification timestamp into a coarse date group. */
export function getNotificationDateGroup(iso: string): NotificationDateGroupLabel {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return 'Earlier';

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (time >= startOfToday) return 'Today';
  if (time >= startOfToday - DAY_MS) return 'Yesterday';
  return 'Earlier';
}

export interface NotificationGroup {
  label: NotificationDateGroupLabel;
  items: Notification[];
}

/** Group a pre-sorted (newest first) list of notifications by day. */
export function groupNotificationsByDate(notifications: Notification[]): NotificationGroup[] {
  const groups: NotificationGroup[] = [];
  for (const notification of notifications) {
    const label = getNotificationDateGroup(notification.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) {
      last.items.push(notification);
    } else {
      groups.push({ label, items: [notification] });
    }
  }
  return groups;
}
