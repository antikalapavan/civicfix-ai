import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ShieldCheck,
  LogOut,
  RefreshCw,
  Search,
  BarChart3,
  MapPin,
  FileText,
  Users,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ChevronRight,
  Layers,
  Building2,
  Activity,
  Sun,
  Moon,
  Monitor,
  Map as MapIcon,
  Loader2,
  Info,
  X,
  ArrowRight,
  Filter,
} from 'lucide-react';
import type { DocumentData, QueryDocumentSnapshot } from 'firebase/firestore';
import {
  CivicIssueReport,
  AdminUser,
  ReportStatus,
  ExpandedCivicCategory,
  EXPANDED_CIVIC_CATEGORIES,
  ADMIN_ROLE_CAPABILITIES,
  AuditLogEntry,
  CitizenSummary,
  CANONICAL_MUNICIPAL_DEPARTMENTS,
  normalizeCivicCategory,
  normalizeReportStatus,
  resolveReportCanonicalDepartment,
  resolveTimelineActor,
  resolveAuditLogActor,
  getSeverityPriorityScore,
} from '../../types/civic';
import {
  fetchAllReportsForAdmin,
  fetchAdminReportsPage,
  subscribeToAllReportsForAdmin,
  mergeAndDeduplicateReports,
  calculateAdminStats,
  extractCitizenSummaries,
  fetchRecentAuditLogs,
  signOutAdmin,
  archiveReportByAdmin,
} from '../../services/adminService';
import { toUserFriendlyErrorMessage } from '../../utils/userFriendlyErrors';
import {
  formatReportDate,
  parseReportTimestamp,
  syncSelectedReport,
} from '../../services/reportStorage';
import { partitionReportsByLocation } from '../../utils/reportLocations';
import {
  assessReportDataQuality,
  assessTextEntryQuality,
  generateSafeCitizenCode,
  sanitizeCitizenDisplayName,
} from '../../utils/inputValidation';
import { useTheme } from '../../context/ThemeContext';
import { CivifixLogo } from '../CivifixLogo';
import { AdminReportDetailsModal } from './AdminReportDetailsModal';
import { CivicReportsMap } from '../CivicReportsMap';
import { CivicStatusBadge } from '../CivicStatusBadge';

interface AdminDashboardProps {
  admin: AdminUser;
  onLogout: () => void;
}

type AdminSection = 'overview' | 'complaints' | 'map' | 'departments' | 'citizens' | 'activity';

interface DocIdPaginationState {
  cursor: QueryDocumentSnapshot<DocumentData> | null;
  paginatedReports: CivicIssueReport[];
  hasMore: boolean;
  docIdComplete: boolean;
  pagesLoaded: number;
  isLoadingMore: boolean;
  notice: string | null;
  error: string | null;
}

interface DepartmentAggregate {
  name: string;
  total: number;
  pending: number;
  inProgress: number;
  resolved: number;
  rejected: number;
  withdrawn: number;
  officers: string[];
  avgResolutionHours: number | null;
}

const CANONICAL_DEPARTMENTS: readonly string[] = [
  'Solid Waste Management',
  'Roads & Infrastructure Maintenance',
  'Water Supply & Sewerage Board',
  'Electrical & Street Lighting Department',
  'Stormwater Drainage & Flood Control',
  'Public Health & Sanitation',
  'General Municipal Administration',
];

function formatRoleLabel(role: AdminUser['role']): string {
  switch (role) {
    case 'superadmin':
      return 'Super Admin';
    case 'department_head':
      return 'Department Head';
    case 'ward_admin':
      return 'Ward Admin';
    case 'staff':
    default:
      return 'Municipal Staff';
  }
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  admin,
  onLogout,
}) => {
  const { theme, setTheme } = useTheme();
  const capabilities = ADMIN_ROLE_CAPABILITIES[admin.role] || ADMIN_ROLE_CAPABILITIES.staff;

  const [activeSection, setActiveSection] = useState<AdminSection>('overview');

  // Three isolated report sources merged cleanly to prevent live snapshots or Refresh
  // from overwriting or corrupting dedicated documentId() pagination state.
  const [realtimeReports, setRealtimeReports] = useState<CivicIssueReport[]>([]);
  const [fetchedReports, setFetchedReports] = useState<CivicIssueReport[]>([]);
  const [initialWindowMeta, setInitialWindowMeta] = useState<{
    isComplete: boolean;
    retrievalNotice: string | null;
  }>({
    isComplete: false,
    retrievalNotice: null,
  });

  const [docIdPagination, setDocIdPagination] = useState<DocIdPaginationState>({
    cursor: null,
    paginatedReports: [],
    hasMore: true,
    docIdComplete: false,
    pagesLoaded: 0,
    isLoadingMore: false,
    notice: null,
    error: null,
  });

  const [isLoading, setIsLoading] = useState(true);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [selectedReport, setSelectedReport] = useState<CivicIssueReport | null>(null);
  const [mapPreviewReport, setMapPreviewReport] = useState<CivicIssueReport | null>(null);
  const [pendingArchiveReport, setPendingArchiveReport] = useState<CivicIssueReport | null>(null);
  const [archiveReason, setArchiveReason] = useState('');
  const [isArchivingReport, setIsArchivingReport] = useState(false);

  // Complaints filters & sort
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [wardFilter, setWardFilter] = useState<string>('all');
  const [departmentFilter, setDepartmentFilter] = useState<string>('all');
  const [qualityFilter, setQualityFilter] = useState<'all' | 'flagged'>('all');
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest' | 'severity'>('newest');

  // Citizens drill-down selection
  const [selectedCitizenId, setSelectedCitizenId] = useState<string | null>(null);

  // Activity section state (/auditLogs separated from fallback timeline events)
  const [auditLogsState, setAuditLogsState] = useState<{
    logs: AuditLogEntry[];
    fromCloud: boolean;
    isPartial: boolean;
    isLoading: boolean;
    hasFetched: boolean;
    error: string | null;
  }>({
    logs: [],
    fromCloud: false,
    isPartial: true,
    isLoading: false,
    hasFetched: false,
    error: null,
  });

  // Deduplicated view of all currently loaded reports (realtime overrides older snapshots)
  const reports = useMemo(
    () =>
      mergeAndDeduplicateReports(
        docIdPagination.paginatedReports,
        fetchedReports,
        realtimeReports
      ),
    [docIdPagination.paginatedReports, fetchedReports, realtimeReports]
  );

  // Active (non-archived) complaints shown in normal lists, KPIs, departments, citizens, and map
  const activeReports = useMemo(
    () => reports.filter((r) => !r.archived),
    [reports]
  );

  // Keep open modal and map preview synchronized with incoming live/fetched updates
  useEffect(() => {
    setSelectedReport((prev) => syncSelectedReport(prev, reports));
    setMapPreviewReport((prev) => syncSelectedReport(prev, activeReports));
  }, [reports, activeReports]);

  // Refresh bounded window from municipal database WITHOUT resetting or corrupting pagination state
  const loadReports = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetchAllReportsForAdmin();
      if (res.fromCloud) {
        setFetchedReports(res.reports);
        setInitialWindowMeta({
          isComplete: Boolean(res.isComplete),
          retrievalNotice: res.retrievalNotice || null,
        });
      }
      if (res.error) {
        setErrorMessage(res.error);
      }
    } catch (err: any) {
      console.error('Admin dashboard refresh failed:', err);
      setErrorMessage(toUserFriendlyErrorMessage(err, 'load_complaints'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Load next page using the dedicated cursor ONLY (never derived from merged list)
  const handleLoadMoreReports = useCallback(async () => {
    if (docIdPagination.isLoadingMore || docIdPagination.docIdComplete) return;
    setDocIdPagination((prev) => ({
      ...prev,
      isLoadingMore: true,
      error: null,
    }));

    try {
      const page = await fetchAdminReportsPage({
        mode: 'documentId',
        pageSize: 100,
        cursor: docIdPagination.cursor,
      });

      if (!page.fromCloud || page.error) {
        setDocIdPagination((prev) => ({
          ...prev,
          isLoadingMore: false,
          error: page.error || 'Unable to load additional records from municipal records.',
        }));
        return;
      }

      setDocIdPagination((prev) => {
        const nextPaginated = mergeAndDeduplicateReports(prev.paginatedReports, page.reports);
        const reachedEnd = !page.hasMore;
        return {
          cursor: page.nextCursor,
          paginatedReports: nextPaginated,
          hasMore: page.hasMore,
          docIdComplete: reachedEnd,
          pagesLoaded: prev.pagesLoaded + 1,
          isLoadingMore: false,
          notice: reachedEnd
            ? `All older records loaded (${nextPaginated.length} historical records combined with recent complaints).`
            : `Loaded page ${prev.pagesLoaded + 1} of older records; additional complaints may exist.`,
          error: null,
        };
      });
    } catch (err: any) {
      console.error('Failed to load next batch of complaints:', err);
      setDocIdPagination((prev) => ({
        ...prev,
        isLoadingMore: false,
        error: toUserFriendlyErrorMessage(err, 'load_complaints'),
      }));
    }
  }, [docIdPagination.cursor, docIdPagination.docIdComplete, docIdPagination.isLoadingMore]);

  // Real-time bounded subscription + initial bounded fetch
  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setErrorMessage(null);

    fetchAllReportsForAdmin()
      .then((res) => {
        if (!active) return;
        if (res.fromCloud) {
          setFetchedReports(res.reports);
          setInitialWindowMeta({
            isComplete: Boolean(res.isComplete),
            retrievalNotice: res.retrievalNotice || null,
          });
        }
        if (res.error) {
          setErrorMessage(res.error);
        }
      })
      .catch(() => {
        // Handled by real-time listener notice if offline
      });

    const unsubscribe = subscribeToAllReportsForAdmin(
      (liveList) => {
        if (!active) return;
        setRealtimeReports(liveList);
        setIsLoading(false);
      },
      (err) => {
        if (!active) return;
        console.warn('Real-time admin reports sync notice:', err);
        setErrorMessage('Unable to refresh the latest information. Use the refresh button to try again.');
        setIsLoading(false);
      }
    );

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  // Load bounded /auditLogs when Activity tab opens (for roles whose UI capability permits audit log viewing)
  const loadAuditLogs = useCallback(async () => {
    if (!capabilities.canViewAuditLogs) return;
    setAuditLogsState((prev) => ({ ...prev, isLoading: true, error: null }));
    const res = await fetchRecentAuditLogs(50);
    setAuditLogsState({
      logs: res.logs,
      fromCloud: res.fromCloud,
      isPartial: res.isPartial,
      isLoading: false,
      hasFetched: true,
      error: res.error || null,
    });
  }, [capabilities.canViewAuditLogs]);

  useEffect(() => {
    if (activeSection === 'activity' && capabilities.canViewAuditLogs && !auditLogsState.hasFetched) {
      loadAuditLogs();
    }
  }, [activeSection, capabilities.canViewAuditLogs, auditLogsState.hasFetched, loadAuditLogs]);

  // Derived analytics & summaries (exclude archived complaints from active operational counts)
  const stats = useMemo(() => calculateAdminStats(activeReports), [activeReports]);
  const locationSummary = useMemo(() => partitionReportsByLocation(activeReports), [activeReports]);
  const citizenSummaries = useMemo(() => extractCitizenSummaries(activeReports), [activeReports]);

  const dataQualityByReportId = useMemo(() => {
    const map = new Map<string, ReturnType<typeof assessReportDataQuality>>();
    activeReports.forEach((r) => {
      const res = assessReportDataQuality(r);
      if (res.isSuspicious) {
        map.set(r.id, res);
      }
    });
    return map;
  }, [activeReports]);

  const isCollectionConfirmedComplete =
    docIdPagination.docIdComplete || initialWindowMeta.isComplete;

  const retrievalStatusText = useMemo(() => {
    if (docIdPagination.docIdComplete) {
      return `All ${activeReports.length} active civic complaints synchronized`;
    }
    if (initialWindowMeta.isComplete && docIdPagination.pagesLoaded === 0) {
      return `All ${activeReports.length} active civic complaints loaded`;
    }
    return `Showing ${activeReports.length} active loaded complaints`;
  }, [docIdPagination.docIdComplete, docIdPagination.pagesLoaded, initialWindowMeta.isComplete, activeReports.length]);

  const availableWards = useMemo(() => {
    const set = new Set<string>();
    activeReports.forEach((r) => {
      if (r.location?.ward) set.add(r.location.ward);
    });
    return Array.from(set).sort();
  }, [activeReports]);

  const departmentAggregates = useMemo<DepartmentAggregate[]>(() => {
    const map = new Map<
      string,
      {
        total: number;
        pending: number;
        inProgress: number;
        resolved: number;
        rejected: number;
        withdrawn: number;
        officers: Set<string>;
        resHoursSum: number;
        resCount: number;
      }
    >();

    for (const deptName of CANONICAL_DEPARTMENTS) {
      map.set(deptName, {
        total: 0,
        pending: 0,
        inProgress: 0,
        resolved: 0,
        rejected: 0,
        withdrawn: 0,
        officers: new Set<string>(),
        resHoursSum: 0,
        resCount: 0,
      });
    }

    for (const r of activeReports) {
      const deptName = resolveReportCanonicalDepartment(r);
      const entry = map.get(deptName)!;
      const status = normalizeReportStatus(r.status);

      entry.total += 1;
      if (status === 'Submitted' || status === 'Under Review') entry.pending += 1;
      else if (status === 'Assigned' || status === 'In Progress') entry.inProgress += 1;
      else if (status === 'Resolved') entry.resolved += 1;
      else if (status === 'Rejected') entry.rejected += 1;
      else if (status === 'Withdrawn') entry.withdrawn += 1;

      if (r.assignedOfficer?.trim()) {
        entry.officers.add(r.assignedOfficer.trim());
      }

      if (status === 'Resolved' && r.submittedAt) {
        const end = r.resolvedAt || r.updatedAt;
        const startMs = parseReportTimestamp(r.submittedAt);
        const endMs = parseReportTimestamp(end);
        if (startMs > 0 && endMs > startMs && Number.isFinite(endMs - startMs)) {
          entry.resHoursSum += (endMs - startMs) / (3600 * 1000);
          entry.resCount += 1;
        }
      }
    }

    return Array.from(map.entries())
      .map(([name, entry]) => ({
        name,
        total: entry.total,
        pending: entry.pending,
        inProgress: entry.inProgress,
        resolved: entry.resolved,
        rejected: entry.rejected,
        withdrawn: entry.withdrawn,
        officers: Array.from(entry.officers).sort(),
        avgResolutionHours:
          entry.resCount > 0 && Number.isFinite(entry.resHoursSum)
            ? Math.round((entry.resHoursSum / entry.resCount) * 10) / 10
            : null,
      }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  }, [activeReports]);

  // Filtered & sorted complaints list
  const filteredReports = useMemo(() => {
    return activeReports
      .filter((r) => {
        const status = normalizeReportStatus(r.status);
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase().trim();
          const safeCode = generateSafeCitizenCode(r.userId || 'anonymous-citizen');
          const safeCitizen = sanitizeCitizenDisplayName(r.citizenName, safeCode);
          const matchTrack = r.trackingNumber?.toLowerCase().includes(q);
          const matchTitle = r.title?.toLowerCase().includes(q);
          const matchDesc = r.description?.toLowerCase().includes(q);
          const matchAddr = r.location?.address?.toLowerCase().includes(q);
          const matchWard = r.location?.ward?.toLowerCase().includes(q);
          const matchDept = resolveReportCanonicalDepartment(r).toLowerCase().includes(q);
          const matchCitizen =
            safeCitizen.toLowerCase().includes(q) || safeCode.toLowerCase().includes(q);
          if (
            !matchTrack &&
            !matchTitle &&
            !matchDesc &&
            !matchAddr &&
            !matchWard &&
            !matchDept &&
            !matchCitizen
          ) {
            return false;
          }
        }
        if (
          categoryFilter !== 'all' &&
          normalizeCivicCategory(r.normalizedCategory || r.category) !==
            normalizeCivicCategory(categoryFilter)
        ) {
          return false;
        }
        if (statusFilter === 'Pending_Group') {
          if (status !== 'Submitted' && status !== 'Under Review') return false;
        } else if (statusFilter === 'Active_Group') {
          if (status !== 'Assigned' && status !== 'In Progress') return false;
        } else if (statusFilter !== 'all' && status !== statusFilter) {
          return false;
        }
        if (severityFilter !== 'all' && r.severity !== severityFilter) return false;
        if (wardFilter !== 'all' && r.location?.ward !== wardFilter) return false;
        if (
          departmentFilter !== 'all' &&
          resolveReportCanonicalDepartment(r) !== departmentFilter
        ) {
          return false;
        }
        if (qualityFilter === 'flagged' && !dataQualityByReportId.has(r.id)) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sortOrder === 'oldest') {
          return parseReportTimestamp(a.submittedAt) - parseReportTimestamp(b.submittedAt);
        }
        if (sortOrder === 'severity') {
          return getSeverityPriorityScore(b.severity) - getSeverityPriorityScore(a.severity);
        }
        return parseReportTimestamp(b.submittedAt) - parseReportTimestamp(a.submittedAt);
      });
  }, [
    activeReports,
    searchQuery,
    categoryFilter,
    statusFilter,
    severityFilter,
    wardFilter,
    departmentFilter,
    qualityFilter,
    dataQualityByReportId,
    sortOrder,
  ]);

  const hasActiveFilters =
    statusFilter !== 'all' ||
    categoryFilter !== 'all' ||
    severityFilter !== 'all' ||
    wardFilter !== 'all' ||
    departmentFilter !== 'all' ||
    qualityFilter !== 'all' ||
    Boolean(searchQuery.trim());

  const resetAllFilters = () => {
    setStatusFilter('all');
    setCategoryFilter('all');
    setSeverityFilter('all');
    setWardFilter('all');
    setDepartmentFilter('all');
    setQualityFilter('all');
    setSearchQuery('');
  };

  // Selected citizen profile + their loaded complaint history
  const selectedCitizen = useMemo<CitizenSummary | null>(
    () => citizenSummaries.find((c) => c.id === selectedCitizenId) || null,
    [citizenSummaries, selectedCitizenId]
  );

  const selectedCitizenReports = useMemo(() => {
    if (!selectedCitizenId) return [];
    return activeReports.filter((r) => (r.userId || 'anonymous-citizen') === selectedCitizenId);
  }, [activeReports, selectedCitizenId]);

  // Report map by ID for quick navigation from administrative audit trail
  const reportById = useMemo(() => {
    const map = new Map<string, CivicIssueReport>();
    reports.forEach((r) => map.set(r.id, r));
    return map;
  }, [reports]);

  // Deduplicated, actor-attributed complaint lifecycle timeline events
  const complaintTimelineEvents = useMemo(() => {
    const events: {
      key: string;
      report: CivicIssueReport;
      status: ReportStatus;
      note: string;
      actorLabel: string;
      actorRole: string;
      timestamp: string;
      ms: number;
      isSuspicious: boolean;
      suspiciousReason?: string;
    }[] = [];
    const seenDedupeKeys = new Set<string>();

    for (const r of reports) {
      if (!Array.isArray(r.timeline)) continue;
      r.timeline.forEach((ev, idx) => {
        const ts = ev.timestamp || r.updatedAt || r.submittedAt || '';
        const ms = parseReportTimestamp(ts);
        const noteText = (ev.note || `Status set to ${ev.status}`).trim();
        const resolvedActor = resolveTimelineActor(ev, r);
        const dedupeKey = `${r.id}|${ev.status}|${noteText}|${resolvedActor.label}|${ms > 0 ? Math.floor(ms / 60000) : ts}`;
        if (seenDedupeKeys.has(dedupeKey)) {
          return;
        }
        seenDedupeKeys.add(dedupeKey);

        const noteQuality = assessTextEntryQuality(noteText);
        events.push({
          key: `${r.id}-${idx}-${ts}`,
          report: r,
          status: normalizeReportStatus(ev.status),
          note: noteText,
          actorLabel: resolvedActor.label,
          actorRole: resolvedActor.role,
          timestamp: ts,
          ms,
          isSuspicious: noteQuality.isSuspicious,
          suspiciousReason: noteQuality.reasons.join('; '),
        });
      });
    }

    return events.sort((a, b) => b.ms - a.ms).slice(0, 40);
  }, [reports]);

  // Propagate manual updates across all three report pools cleanly
  const handleReportUpdated = (updatedReport: CivicIssueReport) => {
    const replaceInList = (list: CivicIssueReport[]) =>
      list.some((r) => r.id === updatedReport.id)
        ? list.map((r) => (r.id === updatedReport.id ? updatedReport : r))
        : [updatedReport, ...list];

    setRealtimeReports((prev) => replaceInList(prev));
    setFetchedReports((prev) =>
      prev.map((r) => (r.id === updatedReport.id ? updatedReport : r))
    );
    setDocIdPagination((prev) => ({
      ...prev,
      paginatedReports: prev.paginatedReports.map((r) =>
        r.id === updatedReport.id ? updatedReport : r
      ),
    }));
    setSelectedReport(updatedReport);

    if (capabilities.canViewAuditLogs) {
      if (activeSection === 'activity') {
        loadAuditLogs();
      } else {
        setAuditLogsState((prev) => ({ ...prev, hasFetched: false }));
      }
    }
  };

  const handleConfirmArchiveReport = async () => {
    if (!pendingArchiveReport || isArchivingReport || !capabilities.canArchiveReports) return;
    const target = pendingArchiveReport;
    const targetId = target.id;
    const trimmedReason = archiveReason.trim() || undefined;
    setIsArchivingReport(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const res = await archiveReportByAdmin(targetId, trimmedReason);
      if (res.success) {
        const markArchived = (list: CivicIssueReport[]) =>
          list.map((r) =>
            r.id === targetId
              ? {
                  ...r,
                  archived: true,
                  archivedAt: typeof res.archivedAt === 'string' ? res.archivedAt : undefined,
                  archivedBy: res.archivedBy,
                  archiveReason: res.archiveReason ?? trimmedReason,
                  updatedAt: res.updatedAt ?? r.updatedAt,
                  timeline: res.timeline ?? r.timeline,
                }
              : r
          );

        setRealtimeReports((prev) => markArchived(prev));
        setFetchedReports((prev) => markArchived(prev));
        setDocIdPagination((prev) => ({
          ...prev,
          paginatedReports: markArchived(prev.paginatedReports),
        }));
        setSelectedReport((prev) => (prev?.id === targetId ? null : prev));
        setMapPreviewReport((prev) => (prev?.id === targetId ? null : prev));

        if (capabilities.canViewAuditLogs) {
          if (activeSection === 'activity') {
            loadAuditLogs();
          } else {
            setAuditLogsState((prev) => ({ ...prev, hasFetched: false }));
          }
        }

        setSuccessMessage(
          `Complaint ${target.trackingNumber} has been archived and removed from the active list.`
        );
      } else {
        setErrorMessage(
          res.error ||
            "You don't have permission to remove this complaint. Please contact the system administrator."
        );
      }
    } finally {
      setIsArchivingReport(false);
      setPendingArchiveReport(null);
      setArchiveReason('');
    }
  };

  const handleSignOut = async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      await signOutAdmin();
    } finally {
      setIsSigningOut(false);
      onLogout();
    }
  };

  const cycleTheme = () => {
    if (theme === 'light') setTheme('dark');
    else if (theme === 'dark') setTheme('system');
    else setTheme('light');
  };

  const navItems: {
    id: AdminSection;
    label: string;
    shortLabel: string;
    icon: React.ReactNode;
    badge?: number;
  }[] = [
    {
      id: 'overview',
      label: 'Overview',
      shortLabel: 'Overview',
      icon: <BarChart3 className="w-4 h-4" />,
    },
    {
      id: 'complaints',
      label: 'Complaints',
      shortLabel: 'Complaints',
      icon: <FileText className="w-4 h-4" />,
      badge: activeReports.length,
    },
    {
      id: 'map',
      label: 'Map',
      shortLabel: 'Map',
      icon: <MapIcon className="w-4 h-4" />,
    },
    {
      id: 'departments',
      label: 'Departments',
      shortLabel: 'Depts',
      icon: <Building2 className="w-4 h-4" />,
    },
    {
      id: 'citizens',
      label: 'Citizens',
      shortLabel: 'Citizens',
      icon: <Users className="w-4 h-4" />,
      badge: citizenSummaries.length,
    },
    {
      id: 'activity',
      label: 'Activity',
      shortLabel: 'Activity',
      icon: <Activity className="w-4 h-4" />,
    },
  ];

  return (
    <div className="min-h-screen bg-[#FAFBF9] dark:bg-[#0c1322] text-slate-900 dark:text-slate-100 flex flex-col font-sans transition-colors">
      {/* Shared CiviFix navigation language used by the Citizen Dashboard */}
      <header className="sticky top-0 z-30 w-full bg-white/95 dark:bg-slate-950/95 backdrop-blur-md border-b border-slate-200/80 dark:border-slate-800/80 shrink-0 transition-colors">
        <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 h-16 min-h-16 flex items-center gap-3 sm:gap-5">
          <div className="flex items-center gap-2.5 min-w-0 shrink-0">
          <CivifixLogo className="w-9 h-9 shrink-0" />
          <div className="min-w-0 hidden sm:block">
            <span className="font-extrabold text-lg text-[#064E3B] dark:text-emerald-400 tracking-tight whitespace-nowrap">
              CiviFix AI
            </span>
            <p className="text-[10px] text-slate-500 dark:text-slate-400 truncate">
              Administrator workspace
            </p>
          </div>
        </div>

        <nav aria-label="Administrator navigation" className="hidden md:flex flex-1 min-w-0 justify-center items-center gap-3 lg:gap-5 h-full overflow-x-auto no-scrollbar">
          {navItems.map((item) => {
            const active = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveSection(item.id)}
                className={`h-full px-1 inline-flex items-center gap-1.5 text-sm whitespace-nowrap border-b-2 transition-colors cursor-pointer ${
                  active
                    ? 'border-[#059669] text-[#064E3B] dark:text-emerald-400 font-semibold'
                    : 'border-transparent text-slate-600 dark:text-slate-300 hover:text-[#064E3B] dark:hover:text-emerald-300 font-medium'
                }`}
              >
                {item.icon}
                <span className="hidden lg:inline">{item.label}</span>
                {item.badge !== undefined && item.badge > 0 && (
                  <span className="ml-0.5 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-emerald-600 text-white text-[11px] font-bold tabular-nums">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Right Controls: Identity + Theme + Refresh + Logout */}
        <div className="flex flex-nowrap items-center gap-2 sm:gap-2.5 shrink-0 min-w-0">
          <div className="hidden lg:flex items-center gap-2.5 text-right mr-0.5 min-w-0 w-[170px]">
            <div className="w-8 h-8 rounded-full bg-emerald-800 dark:bg-emerald-700 flex items-center justify-center text-white text-[11px] font-bold ring-2 ring-emerald-500/15 shrink-0">
              {(admin.email || 'A').charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
            <span className="block text-xs font-semibold text-slate-800 dark:text-slate-200 truncate" title={admin.email}>
              {admin.email}
            </span>
            <span className="block text-[11px] text-slate-500 dark:text-slate-400 truncate">
              Role:{' '}
              <strong className="text-emerald-700 dark:text-emerald-400 font-semibold">
                {formatRoleLabel(admin.role)}
              </strong>
            </span>
            </div>
          </div>

          <button
            type="button"
            onClick={cycleTheme}
            title={`Theme: ${theme} (click to switch)`}
            className="w-9 h-9 p-0 inline-flex items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-800 transition cursor-pointer shrink-0"
            aria-label="Toggle Light or Dark Theme"
          >
            {theme === 'light' ? (
              <Sun className="w-4 h-4 text-amber-500" />
            ) : theme === 'dark' ? (
              <Moon className="w-4 h-4 text-emerald-400" />
            ) : (
              <Monitor className="w-4 h-4 text-slate-500 dark:text-slate-400" />
            )}
          </button>

          <button
            type="button"
            onClick={loadReports}
            disabled={isLoading || isSigningOut}
            title="Refresh complaints"
            className="w-9 h-9 p-0 inline-flex items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-800 transition cursor-pointer disabled:opacity-60 shrink-0"
            aria-label="Refresh reports"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-emerald-600' : ''}`} />
          </button>

          <button
            type="button"
            onClick={handleSignOut}
            disabled={isSigningOut}
            className="h-9 flex items-center gap-1.5 px-3 rounded-xl bg-rose-50 dark:bg-rose-950/50 hover:bg-rose-100 dark:hover:bg-rose-900/60 disabled:opacity-60 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800/70 text-xs font-semibold transition cursor-pointer whitespace-nowrap shrink-0"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>{isSigningOut ? 'Signing Out...' : 'Logout'}</span>
          </button>
        </div>
        </div>
      </header>

      {/* Main Content Layout: Desktop Left Sidebar + Workspace */}
      <div className="flex-1 flex flex-col md:flex-row">
        {/* Desktop Sidebar */}
        <aside className="hidden">
          <div className="space-y-1.5">
            <p className="px-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
              Admin Workspace
            </p>
            {navItems.map((item) => {
              const active = activeSection === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveSection(item.id)}
                  className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
                    active
                      ? 'bg-emerald-700 dark:bg-emerald-600 text-white shadow-sm shadow-emerald-900/15'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-900'
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    {item.icon}
                    {item.label}
                  </span>
                  {item.badge !== undefined && (
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        active
                          ? 'bg-white/20 text-white'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="pt-4 mt-6 border-t border-slate-200 dark:border-slate-800 space-y-2.5 px-2">
            <div className="flex items-center gap-1.5 text-[11px] font-bold text-emerald-700 dark:text-emerald-400">
              <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
              <span>Account security</span>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
              Signed in as <span className="font-semibold text-slate-700 dark:text-slate-300">{admin.email}</span>
            </p>
            <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-relaxed">
              Administrator access is protected for this account.
            </p>
          </div>
        </aside>

        {/* Scrollable Workspace */}
        <main className="flex-1 px-4 sm:px-6 lg:px-8 py-5 sm:py-7 pb-24 md:pb-8 overflow-y-auto max-w-6xl w-full mx-auto space-y-6">
          {/* Mobile Identity Strip */}
          <div className="sm:hidden flex items-center justify-between px-3.5 py-2.5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs">
            <span className="font-semibold text-slate-800 dark:text-slate-200 truncate">
              {admin.email}
            </span>
            <span className="px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 text-[10px] font-bold shrink-0">
              {formatRoleLabel(admin.role)}
            </span>
          </div>

          {/* Non-blocking Success Banner */}
          {successMessage && (
            <div className="p-3.5 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/70 text-emerald-800 dark:text-emerald-200 text-xs flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <span>{successMessage}</span>
              </div>
              <button
                type="button"
                onClick={() => setSuccessMessage(null)}
                className="p-1 text-emerald-700 dark:text-emerald-300 hover:opacity-75 cursor-pointer"
                aria-label="Dismiss notification"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Non-blocking Error Banner */}
          {errorMessage && (
            <div className="p-3.5 rounded-2xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/70 text-amber-800 dark:text-amber-200 text-xs flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                <span>{errorMessage}</span>
              </div>
              <button
                type="button"
                onClick={() => setErrorMessage(null)}
                className="p-1 text-amber-700 dark:text-amber-300 hover:opacity-75 cursor-pointer"
                aria-label="Dismiss error"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* ================================================================
              SECTION 1: OVERVIEW
             ================================================================ */}
          {activeSection === 'overview' && (
            <div className="space-y-6">
              <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                <div>
                  <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
                    Dashboard Overview
                  </h1>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    {retrievalStatusText}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <div className="px-3 py-1.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-300 flex items-center gap-1.5 shadow-2xs">
                      <Clock className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                      <span>Average Resolution Time:</span>
                      <strong className="text-slate-900 dark:text-white font-mono">
                        {stats.avgResolutionHours !== null ? `${stats.avgResolutionHours}h` : 'Not available'}
                      </strong>
                    </div>

                    <div className="px-3 py-1.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-300 flex items-center gap-1.5 shadow-2xs">
                      <MapPin className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
                      <span>Locations on Map:</span>
                      <strong className="text-slate-900 dark:text-white font-mono">
                        {locationSummary.counts.plottedActive}/{locationSummary.counts.active}
                      </strong>
                    </div>

                    {!isCollectionConfirmedComplete && (
                      <button
                        type="button"
                        onClick={() => {
                          setActiveSection('complaints');
                          handleLoadMoreReports();
                        }}
                        className="px-3 py-1.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 hover:bg-emerald-100 dark:hover:bg-emerald-900/60 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
                      >
                        <Layers className="w-3.5 h-3.5" />
                        <span>Load Older Records</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Non-destructive Flagged Test/Incomplete Data Banner */}
                {dataQualityByReportId.size > 0 && (
                  <div className="p-3.5 rounded-2xl bg-amber-50/90 dark:bg-amber-950/35 border border-amber-200 dark:border-amber-800/70 text-amber-900 dark:text-amber-200 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                    <div className="flex items-start gap-2.5">
                      <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                      <span>
                        <strong>{dataQualityByReportId.size}</strong> complaint{dataQualityByReportId.size === 1 ? '' : 's'} need{dataQualityByReportId.size === 1 ? 's' : ''} a quick review because the submitted details look incomplete or unusual. The records remain available for review.
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        resetAllFilters();
                        setQualityFilter('flagged');
                        setActiveSection('complaints');
                      }}
                      className="px-3 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-[11px] shrink-0 cursor-pointer transition"
                    >
                      Inspect Flagged ({dataQualityByReportId.size})
                    </button>
                  </div>
                )}

                {/* 4 Core KPI Metric Cards */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
                  <button
                    type="button"
                    onClick={() => {
                      resetAllFilters();
                      setActiveSection('complaints');
                    }}
                    className="text-left min-h-[148px] bg-white dark:bg-slate-900 border border-emerald-200/80 dark:border-emerald-900/60 rounded-2xl p-4 hover:bg-emerald-50/60 dark:hover:bg-emerald-950/30 transition cursor-pointer shadow-2xs"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-300">
                        Total Complaints
                      </span>
                      <div className="w-8 h-8 rounded-xl bg-emerald-100 dark:bg-emerald-900/60 flex items-center justify-center text-emerald-700 dark:text-emerald-300">
                        <FileText className="w-4 h-4" />
                      </div>
                    </div>
                    <div className="text-2xl sm:text-3xl font-extrabold text-slate-900 dark:text-white">
                      {stats.totalReports}
                    </div>
                    <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-1">
                      {stats.highSeverityReports} High / Hazard priority
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      resetAllFilters();
                      setStatusFilter('Pending_Group');
                      setActiveSection('complaints');
                    }}
                    className="text-left min-h-[148px] bg-white dark:bg-slate-900 border border-amber-200/80 dark:border-amber-900/60 rounded-2xl p-4 hover:bg-amber-50/60 dark:hover:bg-amber-950/30 transition cursor-pointer shadow-2xs"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-amber-800 dark:text-amber-300">
                        Pending Complaints
                      </span>
                      <div className="w-8 h-8 rounded-xl bg-amber-100 dark:bg-amber-900/60 flex items-center justify-center text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="w-4 h-4" />
                      </div>
                    </div>
                    <div className="text-2xl sm:text-3xl font-extrabold text-slate-900 dark:text-white">
                      {stats.pendingReports}
                    </div>
                    <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-1">
                      {stats.statusDistribution.Submitted} Submitted •{' '}
                      {stats.statusDistribution['Under Review']} Under Review
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      resetAllFilters();
                      setStatusFilter('Active_Group');
                      setActiveSection('complaints');
                    }}
                    className="text-left min-h-[148px] bg-white dark:bg-slate-900 border border-sky-200/80 dark:border-sky-900/60 rounded-2xl p-4 hover:bg-sky-50/60 dark:hover:bg-sky-950/30 transition cursor-pointer shadow-2xs"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-sky-800 dark:text-sky-300">
                        In Progress
                      </span>
                      <div className="w-8 h-8 rounded-xl bg-sky-100 dark:bg-sky-900/60 flex items-center justify-center text-sky-700 dark:text-sky-300">
                        <Clock className="w-4 h-4" />
                      </div>
                    </div>
                    <div className="text-2xl sm:text-3xl font-extrabold text-slate-900 dark:text-white">
                      {stats.inProgressReports}
                    </div>
                    <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-1">
                      {stats.statusDistribution.Assigned} Assigned •{' '}
                      {stats.statusDistribution['In Progress']} Active Field
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      resetAllFilters();
                      setStatusFilter('Resolved');
                      setActiveSection('complaints');
                    }}
                    className="text-left min-h-[148px] bg-white dark:bg-slate-900 border border-purple-200/80 dark:border-purple-900/60 rounded-2xl p-4 hover:bg-purple-50/60 dark:hover:bg-purple-950/30 transition cursor-pointer shadow-2xs"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-purple-800 dark:text-purple-300">
                        Resolved
                      </span>
                      <div className="w-8 h-8 rounded-xl bg-purple-100 dark:bg-purple-900/60 flex items-center justify-center text-purple-700 dark:text-purple-300">
                        <CheckCircle2 className="w-4 h-4" />
                      </div>
                    </div>
                    <div className="text-2xl sm:text-3xl font-extrabold text-slate-900 dark:text-white">
                      {stats.resolvedReports}
                    </div>
                    <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-1">
                      {stats.rejectedReports} Rejected • {stats.withdrawnReports} Withdrawn
                    </p>
                  </button>
                </div>

              {/* Compact Lifecycle Breakdown Strip (every canonical status clickable) */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-4 sm:p-5 shadow-2xs">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-bold text-slate-900 dark:text-white tracking-tight">
                    Complaint Status
                  </h2>
                  <span className="hidden sm:inline text-[11px] text-slate-500 dark:text-slate-400">
                    Select a status to filter complaints
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
                  {(
                    [
                      'Submitted',
                      'Under Review',
                      'Assigned',
                      'In Progress',
                      'Resolved',
                      'Rejected',
                      'Withdrawn',
                    ] as ReportStatus[]
                  ).map((st) => (
                    <button
                      key={st}
                      type="button"
                      onClick={() => {
                        resetAllFilters();
                        setStatusFilter(st);
                        setActiveSection('complaints');
                      }}
                      className="inline-flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 border border-slate-200 dark:border-slate-800 transition cursor-pointer"
                    >
                      <CivicStatusBadge status={st} size="xs" themeMode="auto" />
                      <span className="text-xs font-bold font-mono text-slate-800 dark:text-slate-200">
                        {stats.statusDistribution[st] || 0}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Recent Complaints + Integrated Category & Ward Analytics */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Recent Citizen Complaints (2 cols) */}
                <div className="lg:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-5 shadow-2xs space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                        Recent Complaints
                      </h2>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Latest submissions
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setActiveSection('complaints')}
                      className="text-xs text-emerald-700 dark:text-emerald-400 hover:underline font-semibold flex items-center gap-1 cursor-pointer"
                    >
                      <span>View All</span>
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <div className="divide-y divide-slate-100 dark:divide-slate-800">
                    {activeReports.slice(0, 6).map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => setSelectedReport(r)}
                        className="w-full text-left py-3.5 px-2 -mx-2 rounded-xl flex items-center justify-between gap-4 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition cursor-pointer"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          {r.photoUrl ? (
                            <img
                              src={r.photoUrl}
                              alt=""
                              className="w-11 h-11 rounded-xl object-cover shrink-0 bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-700"
                            />
                          ) : (
                            <div className="w-11 h-11 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-400 shrink-0">
                              <FileText className="w-5 h-5" />
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono text-xs font-bold text-emerald-700 dark:text-emerald-400">
                                {r.trackingNumber}
                              </span>
                              <span className="text-xs font-semibold text-slate-900 dark:text-white truncate max-w-[220px] sm:max-w-xs">
                                {r.title}
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
                              {r.location.address} • Ward: {r.location.ward}
                            </p>
                          </div>
                        </div>

                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <CivicStatusBadge status={r.status} size="xs" themeMode="auto" />
                          <span className="text-[10px] text-slate-400 dark:text-slate-500">
                            {formatReportDate(r.submittedAt)}
                          </span>
                        </div>
                      </button>
                    ))}
                    {activeReports.length === 0 && !isLoading && (
                      <div className="py-10 text-center text-xs text-slate-500 dark:text-slate-400">
                        No citizen complaints currently loaded.
                      </div>
                    )}
                    {isLoading && activeReports.length === 0 && (
                      <div className="py-10 flex items-center justify-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                        <Loader2 className="w-4 h-4 animate-spin text-emerald-600" />
                        <span>Loading civic complaints...</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Integrated 8-Category & Top Wards Breakdown (1 col) */}
                <div className="space-y-6">
                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-5 shadow-2xs space-y-3.5">
                    <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                      Complaints by Category
                    </h2>
                    <div className="space-y-2.5">
                      {(Object.keys(stats.categoryDistribution) as ExpandedCivicCategory[]).map(
                        (cat) => {
                          const count = stats.categoryDistribution[cat] || 0;
                          const pct =
                            stats.totalReports > 0
                              ? Math.round((count / stats.totalReports) * 100)
                              : 0;
                          return (
                            <button
                              key={cat}
                              type="button"
                              onClick={() => {
                                resetAllFilters();
                                setCategoryFilter(cat);
                                setActiveSection('complaints');
                              }}
                              className="w-full text-left space-y-1 group cursor-pointer"
                            >
                              <div className="flex justify-between text-xs">
                                <span className="text-slate-700 dark:text-slate-300 font-medium group-hover:text-emerald-700 dark:group-hover:text-emerald-400 transition">
                                  {cat}
                                </span>
                                <span className="text-slate-500 dark:text-slate-400 font-mono">
                                  {count} ({pct}%)
                                </span>
                              </div>
                              <div className="w-full bg-slate-100 dark:bg-slate-800 rounded-full h-1.5 overflow-hidden">
                                <div
                                  className="bg-emerald-600 dark:bg-emerald-500 h-1.5 rounded-full transition-all"
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                            </button>
                          );
                        }
                      )}
                    </div>
                  </div>

                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-2xs space-y-3">
                    <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                      Top Ward Hotspots
                    </h2>
                    <div className="space-y-2">
                      {Object.entries(stats.wardDistribution)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 6)
                        .map(([ward, count]) => (
                          <button
                            key={ward}
                            type="button"
                            onClick={() => {
                              resetAllFilters();
                              setWardFilter(ward);
                              setActiveSection('complaints');
                            }}
                            className="w-full flex items-center justify-between px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 border border-slate-200/80 dark:border-slate-800 text-xs transition cursor-pointer"
                          >
                            <span className="font-medium text-slate-800 dark:text-slate-200 truncate">
                              {ward}
                            </span>
                            <span className="font-mono font-bold text-emerald-700 dark:text-emerald-400 shrink-0 ml-2">
                              {count}
                            </span>
                          </button>
                        ))}
                      {Object.keys(stats.wardDistribution).length === 0 && (
                        <p className="text-xs text-slate-400">No ward records loaded yet.</p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ================================================================
              SECTION 2: COMPLAINTS (LIST + EMBEDDED MAP + DOCUMENT-ID PAGING)
             ================================================================ */}
          {activeSection === 'complaints' && (
            <div className="space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
                    Complaints Management
                  </h1>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    Filter, triage on map or list, assign departments, and resolve citizen issues.
                  </p>
                </div>
              </div>

              {/* Filter Toolbar */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 shadow-2xs grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8 gap-2.5">
                <div className="sm:col-span-2 relative">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5 pointer-events-none" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search tracking ID, address, ward, title..."
                    className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:border-emerald-600"
                  />
                </div>

                <select
                  aria-label="Filter by category"
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl px-2.5 py-2 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-emerald-600"
                >
                  <option value="all">All Categories</option>
                  {EXPANDED_CIVIC_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>

                <select
                  aria-label="Filter by department"
                  value={departmentFilter}
                  onChange={(e) => setDepartmentFilter(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl px-2.5 py-2 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-emerald-600"
                >
                  <option value="all">All Departments</option>
                  {CANONICAL_DEPARTMENTS.map((dept) => (
                    <option key={dept} value={dept}>
                      {dept}
                    </option>
                  ))}
                </select>

                <select
                  aria-label="Filter by status"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl px-2.5 py-2 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-emerald-600"
                >
                  <option value="all">All Statuses</option>
                  <option value="Pending_Group">Pending Complaints (All)</option>
                  <option value="Active_Group">In Progress (All)</option>
                  <option value="Submitted">Submitted</option>
                  <option value="Under Review">Under Review</option>
                  <option value="Assigned">Assigned</option>
                  <option value="In Progress">In Progress</option>
                  <option value="Resolved">Resolved</option>
                  <option value="Rejected">Rejected</option>
                  <option value="Withdrawn">Withdrawn</option>
                </select>

                <select
                  aria-label="Filter by severity"
                  value={severityFilter}
                  onChange={(e) => setSeverityFilter(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl px-2.5 py-2 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-emerald-600"
                >
                  <option value="all">All Severities</option>
                  <option value="Hazard">Hazard</option>
                  <option value="High">High</option>
                  <option value="Medium">Medium</option>
                  <option value="Moderate">Moderate</option>
                  <option value="Low">Low</option>
                  <option value="Minor">Minor</option>
                </select>

                <select
                  aria-label="Filter by ward"
                  value={wardFilter}
                  onChange={(e) => setWardFilter(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl px-2.5 py-2 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-emerald-600"
                >
                  <option value="all">All Wards</option>
                  {availableWards.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>

                <div className="flex gap-1.5">
                  <select
                    aria-label="Filter by data quality"
                    value={qualityFilter}
                    onChange={(e) => setQualityFilter(e.target.value as 'all' | 'flagged')}
                    className="flex-1 min-w-0 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl px-2 py-2 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-emerald-600"
                  >
                    <option value="all">All Quality</option>
                    <option value="flagged">Flagged Text</option>
                  </select>
                  <select
                    aria-label="Sort complaints"
                    value={sortOrder}
                    onChange={(e) => setSortOrder(e.target.value as 'newest' | 'oldest' | 'severity')}
                    className="flex-1 min-w-0 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl px-2 py-2 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-emerald-600"
                  >
                    <option value="newest">Newest</option>
                    <option value="oldest">Oldest</option>
                    <option value="severity">Severity</option>
                  </select>
                </div>
              </div>

              {/* Active Filters Strip */}
              <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                    <Filter className="w-3.5 h-3.5 text-emerald-600" />
                    Showing <strong className="text-slate-900 dark:text-white font-mono">{filteredReports.length}</strong> of{' '}
                    <strong className="text-slate-900 dark:text-white font-mono">{activeReports.length}</strong> loaded
                  </span>

                  {departmentFilter !== 'all' && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950/70 border border-emerald-200 dark:border-emerald-800 text-[11px] text-emerald-800 dark:text-emerald-300 font-medium">
                      Dept: {departmentFilter}
                      <button
                        type="button"
                        onClick={() => setDepartmentFilter('all')}
                        className="font-bold hover:opacity-75 cursor-pointer"
                      >
                        ×
                      </button>
                    </span>
                  )}

                  {statusFilter !== 'all' && (
                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-[11px]">
                      {statusFilter === 'Pending_Group' ? (
                        <span className="font-semibold text-amber-800 dark:text-amber-300 px-1">
                          Pending Complaints (Submitted + Under Review)
                        </span>
                      ) : statusFilter === 'Active_Group' ? (
                        <span className="font-semibold text-sky-800 dark:text-sky-300 px-1">
                          In Progress (Assigned + In Progress)
                        </span>
                      ) : (
                        <CivicStatusBadge status={statusFilter as ReportStatus} size="xs" themeMode="auto" />
                      )}
                      <button
                        type="button"
                        onClick={() => setStatusFilter('all')}
                        className="font-bold text-slate-500 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                      >
                        ×
                      </button>
                    </span>
                  )}

                  {severityFilter !== 'all' && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-[11px] text-slate-700 dark:text-slate-200">
                      Severity: {severityFilter}
                      <button
                        type="button"
                        onClick={() => setSeverityFilter('all')}
                        className="font-bold hover:opacity-75 cursor-pointer"
                      >
                        ×
                      </button>
                    </span>
                  )}

                  {categoryFilter !== 'all' && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-[11px] text-slate-700 dark:text-slate-200">
                      Category: {categoryFilter}
                      <button
                        type="button"
                        onClick={() => setCategoryFilter('all')}
                        className="font-bold hover:opacity-75 cursor-pointer"
                      >
                        ×
                      </button>
                    </span>
                  )}

                  {wardFilter !== 'all' && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-[11px] text-slate-700 dark:text-slate-200">
                      Ward: {wardFilter}
                      <button
                        type="button"
                        onClick={() => setWardFilter('all')}
                        className="font-bold hover:opacity-75 cursor-pointer"
                      >
                        ×
                      </button>
                    </span>
                  )}

                  {qualityFilter === 'flagged' && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-950/70 border border-amber-300 dark:border-amber-800 text-[11px] text-amber-900 dark:text-amber-200 font-semibold">
                      Flagged Test / Placeholder Text
                      <button
                        type="button"
                        onClick={() => setQualityFilter('all')}
                        className="font-bold hover:opacity-75 cursor-pointer"
                      >
                        ×
                      </button>
                    </span>
                  )}
                </div>

                {hasActiveFilters && (
                  <button
                    type="button"
                    onClick={resetAllFilters}
                    className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer"
                  >
                    Reset all filters
                  </button>
                )}
              </div>

              {/* Mobile & Tablet Card List (xl:hidden) */}
                  <div className="xl:hidden space-y-3">
                    {filteredReports.map((r) => {
                      const isFlagged = dataQualityByReportId.has(r.id);
                      const safeCode = generateSafeCitizenCode(r.userId || 'anonymous-citizen');
                      const safeCitizen = sanitizeCitizenDisplayName(r.citizenName, safeCode);
                      return (
                        <div
                          key={r.id}
                          onClick={() => setSelectedReport(r)}
                          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 shadow-2xs space-y-3 cursor-pointer active:scale-[0.99] transition"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-center gap-3 min-w-0">
                              {r.photoUrl ? (
                                <img
                                  src={r.photoUrl}
                                  alt=""
                                  className="w-12 h-12 rounded-xl object-cover shrink-0 border border-slate-200 dark:border-slate-700"
                                />
                              ) : (
                                <div className="w-12 h-12 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 shrink-0">
                                  <FileText className="w-5 h-5" />
                                </div>
                              )}
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="font-mono text-xs font-bold text-emerald-700 dark:text-emerald-400">
                                    {r.trackingNumber}
                                  </span>
                                  {isFlagged && (
                                    <span className="px-1.5 py-0.2 rounded bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 text-[9px] font-bold border border-amber-200 dark:border-amber-800">
                                      Flagged Text
                                    </span>
                                  )}
                                </div>
                                <h3 className="text-sm font-bold text-slate-900 dark:text-white truncate">
                                  {r.title}
                                </h3>
                                <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                                  {safeCitizen} • {r.location.ward} • {normalizeCivicCategory(r.normalizedCategory || r.category)}
                                </p>
                              </div>
                            </div>
                            <CivicStatusBadge status={r.status} size="xs" themeMode="auto" />
                          </div>

                          <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400">
                            <span>Severity: <strong className="text-slate-800 dark:text-slate-200">{r.severity}</strong></span>
                            <div className="flex items-center gap-2">
                              <span>{formatReportDate(r.submittedAt)}</span>
                              {capabilities.canArchiveReports && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setArchiveReason('');
                                    setPendingArchiveReport(r);
                                  }}
                                  className="px-2 py-1 rounded-lg bg-rose-50 dark:bg-rose-950/50 hover:bg-rose-100 dark:hover:bg-rose-900/60 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800/70 font-semibold text-[11px] transition cursor-pointer"
                                >
                                  Archive
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {filteredReports.length === 0 && (
                      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-8 text-center text-xs text-slate-500 dark:text-slate-400">
                        No citizen complaints match the current filters.
                      </div>
                    )}
                  </div>

                  {/* Desktop Table (hidden xl:block) — Constrained widths prevent overflow or clipped Inspect buttons */}
                  <div className="hidden xl:block bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-2xs">
                    <table className="w-full table-fixed text-left text-xs">
                      <thead className="bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400 font-bold uppercase tracking-wider border-b border-slate-200 dark:border-slate-800 text-[11px]">
                        <tr>
                          <th className="py-3 px-3 w-[112px]">Tracking ID</th>
                          <th className="py-3 px-2 w-[56px]">Photo</th>
                          <th className="py-3 px-3 w-[230px]">Issue &amp; Location</th>
                          <th className="py-3 px-3 w-[135px]">Citizen</th>
                          <th className="py-3 px-3 w-[150px]">Category</th>
                          <th className="py-3 px-3 w-[135px]">Status &amp; Severity</th>
                          <th className="py-3 px-3 w-[110px]">Submitted</th>
                          <th className="py-3 px-3 w-[165px] text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-700 dark:text-slate-300">
                        {filteredReports.map((r) => {
                          const isFlagged = dataQualityByReportId.has(r.id);
                          const safeCode = generateSafeCitizenCode(r.userId || 'anonymous-citizen');
                          const safeCitizen = sanitizeCitizenDisplayName(r.citizenName, safeCode);
                          return (
                            <tr
                              key={r.id}
                              onClick={() => setSelectedReport(r)}
                              className="hover:bg-emerald-50/40 dark:hover:bg-slate-800/50 transition cursor-pointer"
                            >
                              <td className="py-3 px-3 font-mono font-bold text-emerald-700 dark:text-emerald-400 truncate">
                                <span className="block truncate">{r.trackingNumber}</span>
                                {isFlagged && (
                                  <span className="inline-block mt-0.5 px-1.5 py-0.2 rounded bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 text-[9px] font-sans font-bold border border-amber-200 dark:border-amber-800">
                                    Flagged
                                  </span>
                                )}
                              </td>
                              <td className="py-3 px-2">
                                {r.photoUrl ? (
                                  <img
                                    src={r.photoUrl}
                                    alt=""
                                    className="w-9 h-9 rounded-lg object-cover border border-slate-200 dark:border-slate-700"
                                  />
                                ) : (
                                  <div className="w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400">
                                    <FileText className="w-4 h-4" />
                                  </div>
                                )}
                              </td>
                              <td className="py-3 px-3 min-w-0">
                                <span className="font-semibold text-slate-900 dark:text-white block truncate">
                                  {r.title}
                                </span>
                                <span className="text-[11px] text-slate-500 dark:text-slate-400 truncate block">
                                  {r.location.address} ({r.location.ward})
                                </span>
                              </td>
                              <td className="py-3 px-3 min-w-0">
                                <span className="font-medium text-slate-800 dark:text-slate-200 block truncate">
                                  {safeCitizen}
                                </span>
                                <span className="text-[10px] text-slate-400 font-mono block truncate">
                                  {safeCode}
                                </span>
                              </td>
                              <td className="py-3 px-3 font-medium text-slate-800 dark:text-slate-200 truncate">
                                {normalizeCivicCategory(r.normalizedCategory || r.category)}
                              </td>
                              <td className="py-3 px-3">
                                <div className="flex flex-col items-start gap-1">
                                  <CivicStatusBadge status={r.status} size="xs" themeMode="auto" />
                                  <span
                                    className={`px-2 py-0.2 rounded-full text-[9px] font-bold border ${
                                      r.severity === 'Hazard'
                                        ? 'bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800'
                                        : r.severity === 'High'
                                        ? 'bg-orange-50 dark:bg-orange-950/50 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-800'
                                        : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700'
                                    }`}
                                  >
                                    {r.severity}
                                  </span>
                                </div>
                              </td>
                              <td className="py-3 px-3 text-slate-500 dark:text-slate-400 text-[11px] truncate">
                                {formatReportDate(r.submittedAt)}
                              </td>
                              <td className="py-3 px-3 text-right">
                                <div className="inline-flex items-center justify-end gap-1.5">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setSelectedReport(r);
                                    }}
                                    className="px-2.5 py-1.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 hover:bg-emerald-700 dark:hover:bg-emerald-600 text-emerald-800 dark:text-emerald-300 hover:text-white border border-emerald-200 dark:border-emerald-800 text-xs font-semibold transition cursor-pointer"
                                  >
                                    Inspect
                                  </button>
                                  {capabilities.canArchiveReports && (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setArchiveReason('');
                                        setPendingArchiveReport(r);
                                      }}
                                      className="px-2.5 py-1.5 rounded-xl bg-transparent hover:bg-amber-600 text-amber-700 dark:text-amber-400 hover:text-white border border-amber-300 dark:border-amber-700 text-xs font-semibold transition cursor-pointer"
                                    >
                                      Archive
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                        {filteredReports.length === 0 && (
                          <tr>
                            <td colSpan={8} className="py-10 text-center text-slate-500 dark:text-slate-400">
                              No citizen complaints match the current filters.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

              {/* Pagination Footer */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs shadow-2xs">
                <div className="space-y-0.5">
                  <p className="font-semibold text-slate-800 dark:text-slate-200">
                    {retrievalStatusText}
                  </p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    {docIdPagination.notice ||
                      initialWindowMeta.retrievalNotice ||
                      'Live updates cover recent complaints; load older records to view earlier submissions.'}
                  </p>
                  {docIdPagination.error && (
                    <p className="text-[11px] text-rose-600 dark:text-rose-400 font-medium">
                      {docIdPagination.error}
                    </p>
                  )}
                </div>

                {!docIdPagination.docIdComplete ? (
                  <button
                    type="button"
                    onClick={handleLoadMoreReports}
                    disabled={docIdPagination.isLoadingMore}
                    className="px-4 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-600 disabled:opacity-60 text-white font-semibold text-xs flex items-center justify-center gap-2 transition cursor-pointer shrink-0"
                  >
                    {docIdPagination.isLoadingMore && (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    )}
                    <span>
                      {docIdPagination.pagesLoaded === 0
                        ? 'Load Older Records'
                        : 'Load Next 100 Records'}
                    </span>
                  </button>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 font-semibold shrink-0">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    All Records Synchronized
                  </span>
                )}
              </div>
            </div>
          )}

          {activeSection === 'map' && (
            <div className="space-y-3">
              <div className="p-3 rounded-xl bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-200/80 dark:border-emerald-900/60 text-xs text-emerald-900 dark:text-emerald-200 flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  Plotting filtered complaints with verified GPS coordinates. Select any marker to preview details.
                </span>
                <span className="font-mono font-semibold shrink-0">
                  {filteredReports.length} filtered
                </span>
              </div>
              <div className="h-[68vh] min-h-[460px] rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-800 shadow-sm bg-white dark:bg-slate-900 relative">
                <CivicReportsMap
                  reports={filteredReports}
                  selectedReport={mapPreviewReport}
                  onSelectReport={(r) => setMapPreviewReport(r)}
                  onOpenReportDetails={(r) => setSelectedReport(r)}
                />
              </div>
            </div>
          )}

          {/* ================================================================
              SECTION 3: DEPARTMENTS (REPORT-DERIVED AGGREGATION)
             ================================================================ */}
          {activeSection === 'departments' && (
            <div className="space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
                    Municipal Departments
                  </h1>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    Department workload, assigned officers, and resolution performance aggregated from loaded municipal complaints.
                  </p>
                </div>
                <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
                  {departmentAggregates.length} municipal units
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {departmentAggregates.map((dept) => {
                  const closedOrWithdrawn = dept.rejected + dept.withdrawn;
                  return (
                    <div
                      key={dept.name}
                      className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-2xs flex flex-col justify-between gap-4"
                    >
                      <div className="space-y-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div className="w-9 h-9 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 flex items-center justify-center text-emerald-700 dark:text-emerald-400 shrink-0">
                              <Building2 className="w-4 h-4" />
                            </div>
                            <div className="min-w-0">
                              <h2 className="text-sm font-bold text-slate-900 dark:text-white truncate">
                                {dept.name}
                              </h2>
                              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                                Average Resolution Time:{' '}
                                <strong className="font-mono text-slate-800 dark:text-slate-200">
                                  {dept.avgResolutionHours !== null
                                    ? `${dept.avgResolutionHours}h`
                                    : 'Not available'}
                                </strong>
                              </p>
                            </div>
                          </div>
                          <span className="px-2.5 py-1 rounded-xl bg-slate-100 dark:bg-slate-800 font-mono text-xs font-bold text-slate-900 dark:text-white shrink-0">
                            {dept.total} {dept.total === 1 ? 'ticket' : 'tickets'}
                          </span>
                        </div>

                        <div className="grid grid-cols-4 gap-2 text-center">
                          <div className="p-2 rounded-xl bg-amber-50/70 dark:bg-amber-950/30 border border-amber-100 dark:border-amber-900/50">
                            <span className="text-base font-extrabold text-amber-800 dark:text-amber-300 block">
                              {dept.pending}
                            </span>
                            <span className="text-[10px] font-semibold text-slate-600 dark:text-slate-400">
                              Pending
                            </span>
                          </div>
                          <div className="p-2 rounded-xl bg-sky-50/70 dark:bg-sky-950/30 border border-sky-100 dark:border-sky-900/50">
                            <span className="text-base font-extrabold text-sky-800 dark:text-sky-300 block">
                              {dept.inProgress}
                            </span>
                            <span className="text-[10px] font-semibold text-slate-600 dark:text-slate-400">
                              Active
                            </span>
                          </div>
                          <div className="p-2 rounded-xl bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-100 dark:border-emerald-900/50">
                            <span className="text-base font-extrabold text-emerald-800 dark:text-emerald-300 block">
                              {dept.resolved}
                            </span>
                            <span className="text-[10px] font-semibold text-slate-600 dark:text-slate-400">
                              Resolved
                            </span>
                          </div>
                          <div className="p-2 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700">
                            <span className="text-base font-extrabold text-slate-700 dark:text-slate-200 block">
                              {closedOrWithdrawn}
                            </span>
                            <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">
                              Rejected / Withdrawn
                            </span>
                          </div>
                        </div>

                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          <span className="font-semibold text-slate-700 dark:text-slate-300">
                            Assigned officers:{' '}
                          </span>
                          {dept.officers.length > 0
                            ? dept.officers.slice(0, 4).join(', ') +
                              (dept.officers.length > 4
                                ? ` +${dept.officers.length - 4} more`
                                : '')
                            : 'Unassigned'}
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          resetAllFilters();
                          setDepartmentFilter(dept.name);
                          setActiveSection('complaints');
                        }}
                        className="w-full py-2 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 border border-slate-200 dark:border-slate-800 text-xs font-semibold text-emerald-700 dark:text-emerald-400 flex items-center justify-center gap-1.5 transition cursor-pointer"
                      >
                        <span>View Department Complaints</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ================================================================
              SECTION 4: CITIZENS DIRECTORY + SUBMITTED COMPLAINT DRILL-DOWN
             ================================================================ */}
          {activeSection === 'citizens' && (
            <div className="space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
                    Citizens Directory
                  </h1>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    Contributor profiles aggregated from loaded complaints. Select a citizen to view their complaint history.
                  </p>
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                  Contributors: <strong className="text-slate-900 dark:text-white">{citizenSummaries.length}</strong>
                </div>
              </div>

              <div className="p-3.5 rounded-2xl bg-emerald-50/80 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/60 text-emerald-900 dark:text-emerald-200 text-xs flex items-center gap-2.5">
                <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <span>
                  Resident Privacy Active: Email addresses, phone numbers, and internal account identifiers are hidden while preserving full complaint traceability.
                </span>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                {/* Directory Table / Cards */}
                <div className={`${selectedCitizen ? 'lg:col-span-2' : 'lg:col-span-3'} bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-2xs`}>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400 font-bold uppercase tracking-wider border-b border-slate-200 dark:border-slate-800 text-[11px]">
                        <tr>
                          <th className="py-3 px-4">Citizen</th>
                          <th className="py-3 px-4">Ward</th>
                          <th className="py-3 px-4">Submitted</th>
                          <th className="py-3 px-4">Resolved</th>
                          <th className="py-3 px-4">Latest Activity</th>
                          <th className="py-3 px-4 text-right">History</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-700 dark:text-slate-300">
                        {citizenSummaries.map((c) => {
                          const isSelected = c.id === selectedCitizenId;
                          const safeCode = generateSafeCitizenCode(c.id);
                          const ratio =
                            c.totalReports > 0
                              ? Math.round((c.resolvedReports / c.totalReports) * 100)
                              : 0;
                          return (
                            <tr
                              key={c.id}
                              onClick={() =>
                                setSelectedCitizenId((prev) => (prev === c.id ? null : c.id))
                              }
                              className={`transition cursor-pointer ${
                                isSelected
                                  ? 'bg-emerald-50 dark:bg-emerald-950/50'
                                  : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                              }`}
                            >
                              <td className="py-3 px-4">
                                <div className="flex items-center gap-2.5">
                                  <div className="w-8 h-8 rounded-full bg-emerald-100 dark:bg-emerald-900/60 border border-emerald-200 dark:border-emerald-800 flex items-center justify-center text-emerald-800 dark:text-emerald-300 font-bold text-xs shrink-0">
                                    {c.name.charAt(0).toUpperCase()}
                                  </div>
                                  <div className="min-w-0">
                                    <span className="font-semibold text-slate-900 dark:text-white block truncate max-w-[180px]">
                                      {c.name}
                                    </span>
                                    <span className="text-[10px] text-slate-400 font-mono block">
                                      {safeCode}
                                    </span>
                                  </div>
                                </div>
                              </td>
                              <td className="py-3 px-4">{c.ward}</td>
                              <td className="py-3 px-4 font-mono font-bold text-emerald-700 dark:text-emerald-400">
                                {c.totalReports}
                              </td>
                              <td className="py-3 px-4">
                                <span className="font-mono font-semibold text-slate-800 dark:text-slate-200">
                                  {c.resolvedReports}
                                </span>{' '}
                                <span className="text-[10px] text-slate-400">({ratio}%)</span>
                              </td>
                              <td className="py-3 px-4 text-[11px] text-slate-500 dark:text-slate-400">
                                {c.latestReportDate
                                  ? formatReportDate(c.latestReportDate)
                                  : 'Date unavailable'}
                              </td>
                              <td className="py-3 px-4 text-right">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedCitizenId((prev) => (prev === c.id ? null : c.id));
                                  }}
                                  className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer"
                                >
                                  {isSelected ? 'Close' : 'View History'}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                        {citizenSummaries.length === 0 && (
                          <tr>
                            <td colSpan={6} className="py-10 text-center text-slate-500 dark:text-slate-400">
                              No citizen profiles found in loaded reports.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Inline Citizen Complaint History Drill-Down */}
                {selectedCitizen && (
                  <div className="bg-white dark:bg-slate-900 border border-emerald-200 dark:border-emerald-800/80 rounded-2xl p-4 shadow-2xs space-y-4 self-start">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                          Submitted Complaint History
                        </span>
                        <h2 className="text-sm font-bold text-slate-900 dark:text-white mt-0.5">
                          {selectedCitizen.name}
                        </h2>
                        <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                          {generateSafeCitizenCode(selectedCitizen.id)} · {selectedCitizen.ward}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelectedCitizenId(null)}
                        className="p-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                        aria-label="Close citizen drill-down"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="space-y-2.5 max-h-[420px] overflow-y-auto pr-1">
                      {selectedCitizenReports.map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => setSelectedReport(r)}
                          className="w-full text-left p-3 rounded-xl bg-slate-50 dark:bg-slate-950 hover:bg-emerald-50/70 dark:hover:bg-emerald-950/40 border border-slate-200 dark:border-slate-800 space-y-1.5 transition cursor-pointer"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-[11px] font-bold text-emerald-700 dark:text-emerald-400">
                              {r.trackingNumber}
                            </span>
                            <CivicStatusBadge status={r.status} size="xs" themeMode="auto" />
                          </div>
                          <p className="text-xs font-semibold text-slate-900 dark:text-white line-clamp-1">
                            {r.title}
                          </p>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                            {r.location.address} • {formatReportDate(r.submittedAt)}
                          </p>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ================================================================
              SECTION 5: ACTIVITY & AUDIT TRAIL
             ================================================================ */}
          {activeSection === 'activity' && (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
                    Activity &amp; Audit Trail
                  </h1>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    Tracks system audit transactions separately from individual complaint lifecycle status updates.
                  </p>
                </div>
                {capabilities.canViewAuditLogs && (
                  <button
                    type="button"
                    onClick={loadAuditLogs}
                    disabled={auditLogsState.isLoading}
                    className="px-3.5 py-2 rounded-xl bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-2 transition cursor-pointer self-start"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${
                        auditLogsState.isLoading ? 'animate-spin text-emerald-600' : ''
                      }`}
                    />
                    <span>Refresh Audit Trail</span>
                  </button>
                )}
              </div>

              {/* Panel A: System Audit Trail */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-2xs space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                        System Audit Log
                      </h2>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 dark:bg-emerald-950/70 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                        Official Transactions
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      Latest 50 recorded administrative and citizen audit transactions.
                    </p>
                  </div>

                  {capabilities.canViewAuditLogs && auditLogsState.fromCloud && (
                    <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                      {auditLogsState.logs.length} entries
                      {auditLogsState.isPartial ? ' (recent window)' : ''}
                    </span>
                  )}
                </div>

                {!capabilities.canViewAuditLogs ? (
                  <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/70 text-amber-900 dark:text-amber-200 text-xs space-y-1">
                    <p className="font-semibold">
                      System Audit Feed Restricted for {formatRoleLabel(admin.role)}
                    </p>
                    <p className="text-[11px] opacity-90">
                      Global system audit log viewing is enabled for supervisor and department head roles. You can inspect complaint lifecycle updates below.
                    </p>
                  </div>
                ) : auditLogsState.isLoading ? (
                  <div className="py-8 flex items-center justify-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                    <Loader2 className="w-4 h-4 animate-spin text-emerald-600" />
                    <span>Loading audit trail...</span>
                  </div>
                ) : !auditLogsState.fromCloud ? (
                  <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/70 text-amber-800 dark:text-amber-200 text-xs">
                    {auditLogsState.error ||
                      'System audit logs could not be loaded right now. Check connection or permissions.'}
                  </div>
                ) : auditLogsState.logs.length === 0 ? (
                  <div className="py-8 text-center text-xs text-slate-500 dark:text-slate-400">
                    No system audit log entries recorded yet.
                  </div>
                ) : (
                  <div className="divide-y divide-slate-100 dark:divide-slate-800">
                    {auditLogsState.logs.map((log) => {
                      const linkedReport = reportById.get(log.targetId);
                      const resolvedActor = resolveAuditLogActor(log);
                      const summaryQuality = assessTextEntryQuality(log.summary);
                      const parsedMs = parseReportTimestamp(log.timestamp);
                      return (
                        <div
                          key={log.id}
                          className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                        >
                          <div className="space-y-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-emerald-50 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                                {log.action.replace(/_/g, ' ')}
                              </span>
                              <span className="text-[11px] font-medium text-slate-600 dark:text-slate-300">
                                Actor: <strong>{resolvedActor.label}</strong>
                              </span>
                              {summaryQuality.isSuspicious && (
                                <span
                                  title={summaryQuality.reasons.join('; ')}
                                  className="px-1.5 py-0.2 rounded bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 text-[9px] font-bold border border-amber-200 dark:border-amber-800"
                                >
                                  Flagged Test Text
                                </span>
                              )}
                              {linkedReport && (
                                <button
                                  type="button"
                                  onClick={() => setSelectedReport(linkedReport)}
                                  className="text-[11px] font-mono font-bold text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer"
                                >
                                  {linkedReport.trackingNumber}
                                </button>
                              )}
                            </div>
                            <p className="text-xs text-slate-800 dark:text-slate-200">
                              {log.summary || 'Action recorded'}
                            </p>
                          </div>
                          <span className="text-[11px] text-slate-400 dark:text-slate-500 whitespace-nowrap shrink-0">
                            {parsedMs > 0 ? formatReportDate(log.timestamp) : 'Date unavailable'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Panel B: Complaint Lifecycle Updates */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-2xs space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                        Complaint Lifecycle Timeline
                      </h2>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                        Status History
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      Latest 40 status transitions and officer or citizen updates across loaded complaints.
                    </p>
                  </div>
                </div>

                {complaintTimelineEvents.length === 0 ? (
                  <div className="py-8 text-center text-xs text-slate-500 dark:text-slate-400">
                    No complaint timeline events present on currently loaded records.
                  </div>
                ) : (
                  <div className="divide-y divide-slate-100 dark:divide-slate-800">
                    {complaintTimelineEvents.map((ev) => (
                      <button
                        key={ev.key}
                        type="button"
                        onClick={() => setSelectedReport(ev.report)}
                        className="w-full text-left py-3 px-2 -mx-2 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800/50 flex flex-col sm:flex-row sm:items-center justify-between gap-2 transition cursor-pointer"
                      >
                        <div className="space-y-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-xs font-bold text-emerald-700 dark:text-emerald-400">
                              {ev.report.trackingNumber}
                            </span>
                            <CivicStatusBadge status={ev.status} size="xs" themeMode="auto" />
                            <span className="text-[11px] text-slate-600 dark:text-slate-300 font-medium">
                              by {ev.actorLabel}
                            </span>
                            {ev.isSuspicious && (
                              <span
                                title={ev.suspiciousReason}
                                className="px-1.5 py-0.2 rounded bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 text-[9px] font-bold border border-amber-200 dark:border-amber-800"
                              >
                                Flagged Test Text
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-700 dark:text-slate-300 line-clamp-2">
                            {ev.note}
                          </p>
                        </div>
                        <span className="text-[11px] text-slate-400 dark:text-slate-500 whitespace-nowrap shrink-0">
                          {ev.ms > 0 ? formatReportDate(ev.timestamp) : 'Date unavailable'}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Mobile Bottom 5-Tab Sticky Navigation Bar (md:hidden) */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-30 bg-white/95 dark:bg-slate-950/95 backdrop-blur-md border-t border-slate-200 dark:border-slate-800 px-2 py-1.5 flex items-center justify-around">
        {navItems.map((item) => {
          const active = activeSection === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveSection(item.id)}
              className={`flex flex-col items-center justify-center py-1 px-2.5 rounded-xl text-[10px] font-semibold transition cursor-pointer ${
                active
                  ? 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/60'
                  : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              {item.icon}
              <span className="mt-0.5">{item.shortLabel}</span>
            </button>
          );
        })}
      </nav>

      {/* Report Inspection & Status Workflow Modal */}
      {selectedReport && (
        <AdminReportDetailsModal
          report={selectedReport}
          allReports={activeReports}
          adminRole={admin.role}
          onClose={() => setSelectedReport(null)}
          onReportUpdated={handleReportUpdated}
        />
      )}

      {pendingArchiveReport && capabilities.canArchiveReports && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="archive-complaint-title"
          className="fixed inset-0 z-50 bg-slate-950/65 backdrop-blur-xs flex items-center justify-center p-4"
        >
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 max-w-md w-full shadow-2xl space-y-4">
            <div className="space-y-1.5">
              <h3
                id="archive-complaint-title"
                className="text-sm font-bold text-slate-900 dark:text-white"
              >
                Archive Complaint {pendingArchiveReport.trackingNumber}?
              </h3>
              <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                This complaint will be archived and removed from the active complaints list. Its status history, audit log, and attached photos will be preserved for municipal records.
              </p>
            </div>
            <div>
              <label
                htmlFor="archive-complaint-reason"
                className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-1"
              >
                Reason (optional)
              </label>
              <input
                id="archive-complaint-reason"
                type="text"
                value={archiveReason}
                onChange={(e) => setArchiveReason(e.target.value)}
                disabled={isArchivingReport}
                placeholder="e.g. Duplicate submission or closed record"
                className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-xs text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:border-emerald-600"
              />
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={isArchivingReport}
                onClick={() => {
                  setPendingArchiveReport(null);
                  setArchiveReason('');
                }}
                className="px-3 py-1.5 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isArchivingReport}
                onClick={handleConfirmArchiveReport}
                className="px-3.5 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold transition cursor-pointer disabled:opacity-50"
              >
                {isArchivingReport ? 'Archiving...' : 'Archive Complaint'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
