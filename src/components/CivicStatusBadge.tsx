import React from 'react';
import {
  Clock,
  Eye,
  UserCheck,
  Activity,
  CheckCircle2,
  XCircle,
  RotateCcw,
} from 'lucide-react';
import { ReportStatus, normalizeReportStatus } from '../types/civic';

export interface CivicStatusBadgeProps {
  status: ReportStatus | string;
  size?: 'xs' | 'sm' | 'md';
  showIcon?: boolean;
  className?: string;
  themeMode?: 'dark' | 'light' | 'auto';
}

/**
 * Returns Tailwind classes for the official CiviFix AI report statuses:
 * - Submitted: Blue
 * - Under Review: Orange
 * - Assigned: Purple
 * - In Progress: Cyan
 * - Resolved: Green
 * - Rejected: Red
 * - Withdrawn: Slate/Zinc neutral
 */
export function getStatusThemeClasses(
  rawStatus: ReportStatus | string,
  mode: 'dark' | 'light' | 'auto' = 'auto'
): string {
  const status = normalizeReportStatus(rawStatus);
  switch (status) {
    case 'Submitted':
      if (mode === 'light') {
        return 'bg-blue-100 text-blue-800 border-blue-300';
      }
      if (mode === 'dark') {
        return 'bg-blue-500/15 text-blue-300 border-blue-500/40';
      }
      return 'bg-blue-100 dark:bg-blue-500/15 text-blue-800 dark:text-blue-300 border-blue-200 dark:border-blue-500/40';

    case 'Under Review':
      if (mode === 'light') {
        return 'bg-orange-100 text-orange-800 border-orange-300';
      }
      if (mode === 'dark') {
        return 'bg-orange-500/15 text-orange-300 border-orange-500/40';
      }
      return 'bg-orange-100 dark:bg-orange-500/15 text-orange-800 dark:text-orange-300 border-orange-200 dark:border-orange-500/40';

    case 'Assigned':
      if (mode === 'light') {
        return 'bg-purple-100 text-purple-800 border-purple-300';
      }
      if (mode === 'dark') {
        return 'bg-purple-500/15 text-purple-300 border-purple-500/40';
      }
      return 'bg-purple-100 dark:bg-purple-500/15 text-purple-800 dark:text-purple-300 border-purple-200 dark:border-purple-500/40';

    case 'In Progress':
      if (mode === 'light') {
        return 'bg-cyan-100 text-cyan-800 border-cyan-300';
      }
      if (mode === 'dark') {
        return 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40';
      }
      return 'bg-cyan-100 dark:bg-cyan-500/15 text-cyan-800 dark:text-cyan-300 border-cyan-200 dark:border-cyan-500/40';

    case 'Resolved':
      if (mode === 'light') {
        return 'bg-emerald-100 text-emerald-800 border-emerald-300';
      }
      if (mode === 'dark') {
        return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40';
      }
      return 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/40';

    case 'Rejected':
      if (mode === 'light') {
        return 'bg-rose-100 text-rose-800 border-rose-300';
      }
      if (mode === 'dark') {
        return 'bg-rose-500/15 text-rose-300 border-rose-500/40';
      }
      return 'bg-rose-100 dark:bg-rose-500/15 text-rose-800 dark:text-rose-300 border-rose-200 dark:border-rose-500/40';

    case 'Withdrawn':
      if (mode === 'light') {
        return 'bg-slate-100 text-slate-700 border-slate-300';
      }
      if (mode === 'dark') {
        return 'bg-slate-500/15 text-slate-400 border-slate-500/40';
      }
      return 'bg-slate-100 dark:bg-slate-800/80 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700';

    default:
      return 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700';
  }
}

export function getStatusIcon(rawStatus: ReportStatus | string, iconClass = 'w-3 h-3') {
  const status = normalizeReportStatus(rawStatus);
  switch (status) {
    case 'Submitted':
      return <Clock className={iconClass} />;
    case 'Under Review':
      return <Eye className={iconClass} />;
    case 'Assigned':
      return <UserCheck className={iconClass} />;
    case 'In Progress':
      return <Activity className={iconClass} />;
    case 'Resolved':
      return <CheckCircle2 className={iconClass} />;
    case 'Rejected':
      return <XCircle className={iconClass} />;
    case 'Withdrawn':
      return <RotateCcw className={iconClass} />;
    default:
      return <Clock className={iconClass} />;
  }
}

export const CivicStatusBadge: React.FC<CivicStatusBadgeProps> = ({
  status: rawStatus,
  size = 'xs',
  showIcon = true,
  className = '',
  themeMode = 'auto',
}) => {
  const status = normalizeReportStatus(rawStatus);
  const sizeClasses =
    size === 'xs'
      ? 'px-2 py-0.5 text-[10px]'
      : size === 'sm'
      ? 'px-2.5 py-1 text-xs'
      : 'px-3 py-1.5 text-sm';

  const iconSizeClass = size === 'xs' ? 'w-3 h-3' : size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4';
  const colorClasses = getStatusThemeClasses(status, themeMode);

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-semibold border ${sizeClasses} ${colorClasses} ${className}`}
    >
      {showIcon && getStatusIcon(status, `${iconSizeClass} shrink-0`)}
      <span>{status}</span>
    </span>
  );
};
