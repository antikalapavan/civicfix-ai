import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  AlertTriangle,
  MapPin,
  Plus,
  Map,
  List,
  X,
  Send,
  CheckCircle2,
  ShieldCheck,
  RefreshCw,
  Cloud,
  HardDrive,
  AlertCircle,
  FileText,
  Loader2,
  Info,
  Sparkles,
  Undo2,
  Eye,
  Building2,
  UserCheck,
  MessageSquare,
  Link2,
  History,
  Archive,
} from 'lucide-react';
import {
  CivicIssueReport,
  ReportStatus,
  StatusHistoryEntry,
  normalizeCivicCategory,
  resolveCitizenReportVisibility,
} from '../../types/civic';
import {
  formatReportDate,
  parseReportTimestamp,
  AddCitizenNoteResult,
  fetchCitizenReportStatusHistory,
  getPendingSyncCounts,
  PendingSyncCounts,
} from '../../services/reportStorage';
import { CivicReportsMap } from '../CivicReportsMap';
import { CivicCategoryIcon } from '../CivicCategoryIcon';
import { CivicAwarenessInfoCard } from '../CivicAwarenessInfoCard';
import { useLanguage } from '../../context/LanguageContext';
import { validateMeaningfulCivicText } from '../../utils/inputValidation';
import { isValidCoordinate } from '../../utils/reportLocations';
import { toUserFriendlyErrorMessage } from '../../utils/userFriendlyErrors';

interface MyReportsScreenProps {
  userReports: CivicIssueReport[];
  selectedReport: CivicIssueReport | null;
  onSelectReport: (report: CivicIssueReport | null) => void;
  onNavigateToNewReport: () => void;
  onAddNote: (reportId: string, note: string) => Promise<AddCitizenNoteResult | void> | void;
  onWithdrawReport?: (reportId: string) => Promise<{ success: boolean; report?: CivicIssueReport; isPendingSync?: boolean; error?: string }>;
  isLoadingReports?: boolean;
  isFromCloud?: boolean;
  cloudError?: string | null;
  onRefreshReports?: () => void;
  onSyncPendingReports?: () => Promise<void> | void;
  isSyncingPending?: boolean;
  pendingSyncCounts?: PendingSyncCounts;
  syncFeedback?: { type: 'success' | 'partial' | 'error'; message: string } | null;
  onDismissSyncFeedback?: () => void;
  onBack?: () => void;
}

import { CivicStatusBadge } from '../CivicStatusBadge';

type FilterOption = 'All' | 'Submitted' | 'Under Review' | 'Assigned' | 'In Progress' | 'Resolved' | 'Rejected' | 'Withdrawn';

export const MyReportsScreen: React.FC<MyReportsScreenProps> = ({
  userReports,
  selectedReport,
  onSelectReport,
  onNavigateToNewReport,
  onAddNote,
  onWithdrawReport,
  isLoadingReports = false,
  isFromCloud = false,
  cloudError = null,
  onRefreshReports,
  onSyncPendingReports,
  isSyncingPending = false,
  pendingSyncCounts,
  syncFeedback = null,
  onDismissSyncFeedback,
  onBack,
}) => {
  const { t } = useLanguage();
  const [filterStatus, setFilterStatus] = useState<FilterOption>('All');
  const [layoutMode, setLayoutMode] = useState<'list' | 'map'>('list');
  const [citizenNoteInput, setCitizenNoteInput] = useState('');
  const [isAddingNote, setIsAddingNote] = useState(false);
  const [noteFeedback, setNoteFeedback] = useState<{
    type: 'success' | 'pending' | 'error';
    message: string;
  } | null>(null);

  // Withdrawal state & confirmation dialog
  const [reportToWithdraw, setReportToWithdraw] = useState<CivicIssueReport | null>(null);
  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const [withdrawSuccessNotice, setWithdrawSuccessNotice] = useState<string | null>(null);
  const [withdrawPendingNotice, setWithdrawPendingNotice] = useState<string | null>(null);
  const [withdrawErrorNotice, setWithdrawErrorNotice] = useState<string | null>(null);

  // Subcollection statusHistory (loaded only when permitted by security rules)
  const [statusHistoryEntries, setStatusHistoryEntries] = useState<StatusHistoryEntry[]>([]);
  const [statusHistoryAvailable, setStatusHistoryAvailable] = useState(false);

  useEffect(() => {
    setNoteFeedback(null);
  }, [selectedReport?.id]);

  useEffect(() => {
    let active = true;
    if (!selectedReport?.id || selectedReport.syncedToCloud === false) {
      setStatusHistoryEntries([]);
      setStatusHistoryAvailable(false);
      return;
    }

    fetchCitizenReportStatusHistory(selectedReport.id, selectedReport.userId)
      .then((res) => {
        if (!active) return;
        if (res.available) {
          setStatusHistoryEntries(res.entries);
          setStatusHistoryAvailable(true);
        } else {
          setStatusHistoryEntries([]);
          setStatusHistoryAvailable(false);
        }
      })
      .catch(() => {
        if (!active) return;
        setStatusHistoryEntries([]);
        setStatusHistoryAvailable(false);
      });

    return () => {
      active = false;
    };
  }, [selectedReport?.id, selectedReport?.updatedAt, selectedReport?.syncedToCloud, selectedReport?.userId]);

  // Filtered reports directly from authenticated citizen's dataset
  const filteredReports = userReports.filter((rep) => {
    if (filterStatus === 'All') return true;
    return rep.status === filterStatus;
  });

  const canWithdrawStatus = (status: ReportStatus) =>
    status === 'Submitted' || status === 'Under Review';

  const canWithdrawReport = (report: CivicIssueReport) =>
    !report.archived && canWithdrawStatus(report.status);

  const handleOpenWithdrawDialog = (report: CivicIssueReport, e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
    }
    if (!canWithdrawReport(report)) return;
    setReportToWithdraw(report);
    setWithdrawErrorNotice(null);
  };

  const handleConfirmWithdraw = async () => {
    if (!reportToWithdraw || isWithdrawing) return;
    setIsWithdrawing(true);
    setWithdrawErrorNotice(null);

    try {
      if (onWithdrawReport) {
        const res = await onWithdrawReport(reportToWithdraw.id);
        if (res.success) {
          setWithdrawSuccessNotice(t('myReports.withdrawSuccess', 'Your report has been withdrawn successfully.'));
          if (selectedReport && selectedReport.id === reportToWithdraw.id && res.report) {
            onSelectReport(res.report);
          }
          setReportToWithdraw(null);
          setTimeout(() => setWithdrawSuccessNotice(null), 5000);
        } else if (res.isPendingSync) {
          setWithdrawPendingNotice(
            res.error || 'Withdrawal request saved on this device. It will synchronize with municipal records when you are back online.'
          );
          if (selectedReport && selectedReport.id === reportToWithdraw.id && res.report) {
            onSelectReport(res.report);
          }
          setReportToWithdraw(null);
          setTimeout(() => setWithdrawPendingNotice(null), 6000);
        } else {
          setWithdrawErrorNotice(res.error || 'Failed to withdraw report. Please try again.');
        }
      } else {
        setWithdrawErrorNotice('Report withdrawal service is currently unavailable.');
      }
    } catch (err: any) {
      setWithdrawErrorNotice(toUserFriendlyErrorMessage(err, 'withdraw_complaint'));
    } finally {
      setIsWithdrawing(false);
    }
  };

  const getCategoryIcon = (category: string) => {
    return <CivicCategoryIcon category={category} className="w-4 h-4" />;
  };

  const getStatusBadge = (status: ReportStatus) => {
    return <CivicStatusBadge status={status} size="xs" themeMode="auto" />;
  };

  const handleAddCitizenNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedReport || !citizenNoteInput.trim() || isAddingNote) return;
    if (selectedReport.archived || selectedReport.status === 'Withdrawn') return;

    const noteValidation = validateMeaningfulCivicText(citizenNoteInput, {
      fieldLabel: 'Follow-up note',
      minLength: 3,
      maxLength: 500,
      required: true,
      allowShortConcise: true,
    });
    if (!noteValidation.valid) {
      setNoteFeedback({
        type: 'error',
        message: noteValidation.error || 'Please enter a valid follow-up note.',
      });
      return;
    }

    setIsAddingNote(true);
    setNoteFeedback(null);
    try {
      const res = await onAddNote(selectedReport.id, noteValidation.trimmed);
      if (res && typeof res === 'object' && 'success' in res) {
        if (res.success) {
          setCitizenNoteInput('');
          setNoteFeedback({
            type: 'success',
            message: 'Follow-up note added to report history.',
          });
          setTimeout(() => setNoteFeedback(null), 3500);
        } else if (res.isPendingSync) {
          setCitizenNoteInput('');
          setNoteFeedback({
            type: 'pending',
            message: res.error || 'Saved on this device. Your note will be sent automatically when you are back online.',
          });
          setTimeout(() => setNoteFeedback(null), 5000);
        } else {
          setNoteFeedback({
            type: 'error',
            message: res.error || 'Failed to save follow-up note. Please try again.',
          });
        }
      } else {
        setCitizenNoteInput('');
        setNoteFeedback({
          type: 'success',
          message: 'Follow-up note added to report history.',
        });
        setTimeout(() => setNoteFeedback(null), 3500);
      }
    } catch (err: any) {
      setNoteFeedback({
        type: 'error',
        message: toUserFriendlyErrorMessage(err, 'add_note'),
      });
    } finally {
      setIsAddingNote(false);
    }
  };

  return (
    <div className="bg-[#FAFBF9] dark:bg-[#0c1322] flex-1 w-full pb-10 flex flex-col text-slate-900 dark:text-slate-100 select-none transition-colors">
      {/* Top Subheader */}
      <div className="sticky top-16 z-20 bg-white/95 dark:bg-slate-950/95 backdrop-blur-md border-b border-slate-200/80 dark:border-slate-800/80 shrink-0">
        <div className="max-w-6xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-3">
          <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-2">
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="p-1 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200"
                aria-label="Back"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
            )}
            <h1 className="text-base font-bold text-slate-900 dark:text-white">{t('myReports.title')}</h1>
          </div>

          <div className="flex items-center gap-2">
            {/* View Mode Toggle: List vs Map */}
            <div className="flex items-center bg-slate-100 dark:bg-slate-900 p-0.5 rounded-xl border border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setLayoutMode('list')}
                className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                  layoutMode === 'list'
                    ? 'bg-white dark:bg-slate-800 shadow-xs text-slate-900 dark:text-white'
                    : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                }`}
                title="List View"
              >
                <List className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setLayoutMode('map')}
                className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                  layoutMode === 'map'
                    ? 'bg-white dark:bg-slate-800 shadow-xs text-slate-900 dark:text-white'
                    : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                }`}
                title="Map View"
              >
                <Map className="w-4 h-4" />
              </button>
            </div>

            {/* Refresh Button */}
            {onRefreshReports && (
              <button
                type="button"
                onClick={onRefreshReports}
                disabled={isLoadingReports}
                className="p-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:text-emerald-700 dark:hover:text-emerald-400 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                title="Refresh reports"
              >
                <RefreshCw className={`w-4 h-4 ${isLoadingReports ? 'animate-spin text-emerald-600' : ''}`} />
              </button>
            )}

            {/* New Report Button */}
            <button
              type="button"
              onClick={onNavigateToNewReport}
              className="h-8 px-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs flex items-center gap-1 shadow-xs cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t('nav.report')}</span>
            </button>
          </div>
        </div>

        {/* Cloud Sync Diagnostic Indicator */}
        {(() => {
          const inferredUid = userReports.find((r) => r.userId)?.userId;
          const counts =
            pendingSyncCounts ?? getPendingSyncCounts(inferredUid, userReports);
          const pendingParts: string[] = [];
          if (counts.pendingReports > 0) {
            pendingParts.push(
              `${counts.pendingReports} report${counts.pendingReports === 1 ? '' : 's'}`
            );
          }
          if (counts.pendingNotes > 0) {
            pendingParts.push(
              `${counts.pendingNotes} note${counts.pendingNotes === 1 ? '' : 's'}`
            );
          }
          if (counts.pendingWithdrawals > 0) {
            pendingParts.push(
              `${counts.pendingWithdrawals} withdrawal${counts.pendingWithdrawals === 1 ? '' : 's'}`
            );
          }

          return (
            <div className="flex items-center justify-between text-[11px] pt-0.5">
              {isLoadingReports ? (
                <span className="flex items-center gap-1 text-slate-500">
                  <Loader2 className="w-3 h-3 animate-spin text-emerald-600" />
                  Loading your reports...
                </span>
              ) : counts.total > 0 ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="flex items-center gap-1 text-amber-700 dark:text-amber-300 font-semibold">
                    <HardDrive className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
                    {counts.total} Saved on device ({pendingParts.join(', ')} waiting to send)
                  </span>
                  {onSyncPendingReports && (
                    <button
                      type="button"
                      onClick={onSyncPendingReports}
                      disabled={isSyncingPending}
                      className="px-2 py-0.5 rounded-md bg-amber-100 hover:bg-amber-200 dark:bg-amber-900/60 dark:hover:bg-amber-900 text-amber-900 dark:text-amber-100 font-bold text-[10px] flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-60"
                    >
                      {isSyncingPending ? (
                        <Loader2 className="w-2.5 h-2.5 animate-spin" />
                      ) : (
                        <RefreshCw className="w-2.5 h-2.5" />
                      )}
                      <span>{isSyncingPending ? 'Sending...' : 'Send Now'}</span>
                    </button>
                  )}
                </div>
              ) : isFromCloud ? (
                <span className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-medium">
                  <Cloud className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  Up to date with municipal records
                </span>
              ) : (
                <span className="flex items-center gap-1 text-amber-700 dark:text-amber-300 font-medium">
                  <HardDrive className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                  Saved on this device (waiting to send)
                </span>
              )}

              {cloudError && (
                <span className="text-[10px] text-red-600 max-w-[180px] truncate" title={cloudError}>
                  {cloudError}
                </span>
              )}
            </div>
          );
        })()}
        </div>
      </div>

      {/* Withdrawal Success Feedback Banner */}
      {withdrawSuccessNotice && (
        <div className="max-w-6xl mx-auto w-full px-4 sm:px-6 lg:px-8 mt-3">
          <div className="p-3 rounded-2xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200 text-xs flex items-center justify-between gap-2 shadow-xs animate-in fade-in">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span className="font-medium">{withdrawSuccessNotice}</span>
          </div>
          <button
            type="button"
            onClick={() => setWithdrawSuccessNotice(null)}
            className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
          </div>
        </div>
      )}

      {/* Offline Sync Result Banner (Full Success, Partial Sync, or Failure) */}
      {syncFeedback && (
        <div className="max-w-6xl mx-auto w-full px-4 sm:px-6 lg:px-8 mt-3">
          <div
            role={syncFeedback.type === 'error' ? 'alert' : 'status'}
            className={`p-3 rounded-2xl border text-xs flex items-center justify-between gap-2 shadow-xs animate-in fade-in ${
              syncFeedback.type === 'success'
                ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200'
                : syncFeedback.type === 'partial'
                ? 'bg-amber-50 dark:bg-amber-950/60 border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200'
                : 'bg-rose-50 dark:bg-rose-950/60 border-rose-200 dark:border-rose-800 text-rose-900 dark:text-rose-200'
            }`}
          >
            <div className="flex items-center gap-2">
              {syncFeedback.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              ) : syncFeedback.type === 'partial' ? (
                <HardDrive className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
              )}
              <span className="font-medium leading-relaxed">{syncFeedback.message}</span>
            </div>
            {onDismissSyncFeedback && (
              <button
                type="button"
                onClick={onDismissSyncFeedback}
                className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer shrink-0"
                aria-label="Dismiss sync notice"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Withdrawal Pending Offline Feedback Banner */}
      {withdrawPendingNotice && (
        <div className="max-w-6xl mx-auto w-full px-4 sm:px-6 lg:px-8 mt-3">
          <div className="p-3 rounded-2xl bg-amber-50 dark:bg-amber-950/60 border border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200 text-xs flex items-center justify-between gap-2 shadow-xs animate-in fade-in">
            <div className="flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <span className="font-medium">{withdrawPendingNotice}</span>
            </div>
            <button
              type="button"
              onClick={() => setWithdrawPendingNotice(null)}
              className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Status Filter Chips */}
      <div className="shrink-0 border-b border-slate-200/60 dark:border-slate-800 bg-white dark:bg-slate-950">
        <div className="max-w-6xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-2.5 flex items-center gap-1.5 overflow-x-auto no-scrollbar">
        {([
          'All',
          'Submitted',
          'Under Review',
          'Assigned',
          'In Progress',
          'Resolved',
          'Rejected',
          'Withdrawn',
        ] as FilterOption[]).map((tab) => {
          const tabLabel =
            tab === 'All'
              ? t('status.all')
              : tab === 'Submitted'
              ? t('status.submitted')
              : tab === 'Under Review'
              ? t('status.underReview')
              : tab === 'Assigned'
              ? t('status.assigned')
              : tab === 'In Progress'
              ? t('status.inProgress')
              : tab === 'Resolved'
              ? t('status.resolved')
              : tab === 'Rejected'
              ? t('status.rejected')
              : t('status.withdrawn', 'Withdrawn');

          return (
            <button
              key={tab}
              type="button"
              onClick={() => setFilterStatus(tab)}
              className={`px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                filterStatus === tab
                  ? 'bg-emerald-800 dark:bg-emerald-600 text-white shadow-xs'
                  : 'bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:bg-slate-200/70 dark:hover:bg-slate-800'
              }`}
            >
              {tabLabel}
            </button>
          );
        })}
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 max-w-6xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-4">
        {layoutMode === 'map' ? (
          <div className="h-[480px] lg:h-[600px] rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
            <CivicReportsMap
              reports={filteredReports}
              selectedReport={selectedReport}
              onSelectReport={onSelectReport}
              onOpenReportDetails={(rep) => onSelectReport(rep)}
            />
          </div>
        ) : (
          <div>
            {filteredReports.length === 0 ? (
              <div className="text-center py-12 px-4 bg-white dark:bg-slate-900 rounded-3xl border border-slate-200/80 dark:border-slate-800 shadow-xs">
                <div className="w-12 h-12 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto mb-3 text-slate-400">
                  <FileText className="w-6 h-6" />
                </div>
                <h2 className="text-sm font-bold text-slate-800 dark:text-slate-200 mb-1">
                  {t('myReports.noReports')}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 max-w-xs mx-auto mb-4 leading-relaxed">
                  {filterStatus === 'All'
                    ? t('myReports.noReportsDesc')
                    : `No reports currently under status "${filterStatus}".`}
                </p>
                <button
                  type="button"
                  onClick={onNavigateToNewReport}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold shadow-xs cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>{t('report.title')}</span>
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {filteredReports.map((report) => (
                <div
                  key={report.id}
                  onClick={() => onSelectReport(report)}
                  className="bg-white dark:bg-slate-900 p-3.5 rounded-2xl border border-slate-200/90 dark:border-slate-800 hover:border-emerald-500/80 shadow-2xs hover:shadow-xs transition-all cursor-pointer flex gap-3"
                >
                  {/* Photo or Category Icon */}
                  <div className="w-16 h-16 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 overflow-hidden shrink-0 flex items-center justify-center">
                    {report.photoUrl || report.afterPhotoUrl ? (
                      <img
                        src={report.photoUrl || report.afterPhotoUrl}
                        alt={report.title}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          (e.target as HTMLElement).style.display = 'none';
                        }}
                      />
                    ) : (
                      getCategoryIcon(report.normalizedCategory || report.category)
                    )}
                  </div>

                  {/* Information Details */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <span className="font-mono text-[10px] text-slate-400 dark:text-slate-500 font-semibold truncate">
                        {report.trackingNumber}
                      </span>
                      <div className="flex items-center gap-1 shrink-0">
                        {report.archived && (
                          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-[9px] font-bold">
                            <Archive className="w-2.5 h-2.5" />
                            Archived
                          </span>
                        )}
                        {getStatusBadge(report.status)}
                      </div>
                    </div>

                    <h2 className="text-xs font-bold text-slate-900 dark:text-white truncate mb-1">
                      {report.title || `${normalizeCivicCategory(report.normalizedCategory || report.category)} Issue`}
                    </h2>

                    <div className="flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400 truncate mb-1">
                      <MapPin className="w-3 h-3 text-slate-400 shrink-0" />
                      <span className="truncate">{report.location?.address || 'Manual Address Recorded'}</span>
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-slate-400 dark:text-slate-500 pt-1 border-t border-slate-100 dark:border-slate-800">
                      <span>{formatReportDate(report.submittedAt)}</span>
                      <div className="flex items-center gap-2">
                        {canWithdrawReport(report) && (
                          <button
                            type="button"
                            onClick={(e) => handleOpenWithdrawDialog(report, e)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-rose-50 dark:bg-rose-950/50 hover:bg-rose-100 dark:hover:bg-rose-900/60 border border-rose-200 dark:border-rose-800/80 text-rose-700 dark:text-rose-300 font-semibold text-[10px] transition-colors cursor-pointer"
                            title="Withdraw accidentally submitted report"
                          >
                            <Undo2 className="w-2.5 h-2.5" />
                            <span>{t('myReports.withdrawReport', 'Withdraw Report')}</span>
                          </button>
                        )}
                        <span className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-medium">
                          {report.syncedToCloud ? (
                            <span className="flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                              <Cloud className="w-3 h-3" /> Submitted
                            </span>
                          ) : (
                            <span className="flex items-center gap-0.5 text-amber-600 dark:text-amber-400">
                              <HardDrive className="w-3 h-3" /> Saved on Device
                            </span>
                          )}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ))
              }
              </div>
            )}
          </div>
        )}
      </div>

      {/* Report Detail Modal */}
      {selectedReport && (() => {
        const visibility = resolveCitizenReportVisibility(selectedReport, userReports);
        const displayCategory = normalizeCivicCategory(
          selectedReport.normalizedCategory || selectedReport.category
        );
        const safeTimeline = Array.isArray(selectedReport.timeline)
          ? selectedReport.timeline
          : [];

        return (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-3xl max-w-lg sm:max-w-xl w-full max-h-[88vh] overflow-y-auto p-5 sm:p-6 shadow-2xl border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 animate-in fade-in zoom-in-95">
            <div className="flex items-start justify-between mb-3">
              <div>
                <span className="text-[10px] font-mono text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950 px-2 py-0.5 rounded-full border border-emerald-200 dark:border-emerald-800">
                  {selectedReport.trackingNumber}
                </span>
                <h2 className="text-base font-bold text-slate-900 dark:text-white mt-1">
                  {selectedReport.title || `${displayCategory} Issue`}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => onSelectReport(null)}
                className="p-1 rounded-full text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {(selectedReport.photoUrl || selectedReport.afterPhotoUrl) && (
              <div className="rounded-2xl overflow-hidden mb-4 border border-slate-200 dark:border-slate-700 max-h-44 bg-slate-100 dark:bg-slate-800">
                <img
                  src={selectedReport.photoUrl || selectedReport.afterPhotoUrl}
                  alt={selectedReport.title}
                  className="w-full h-full max-h-44 object-cover"
                />
              </div>
            )}

            <div className="space-y-3.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-slate-500 dark:text-slate-400 font-medium">Status</span>
                {getStatusBadge(selectedReport.status)}
              </div>

              <div className="flex items-center justify-between">
                <span className="text-slate-500 dark:text-slate-400 font-medium">Category</span>
                <span className="inline-flex items-center gap-1.5 font-semibold text-slate-800 dark:text-slate-200">
                  <CivicCategoryIcon category={displayCategory} className="w-3.5 h-3.5" />
                  <span>{displayCategory}</span>
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-slate-500 dark:text-slate-400 font-medium">Submitted</span>
                <span className="font-semibold text-slate-800 dark:text-slate-200">
                  {formatReportDate(selectedReport.submittedAt)}
                </span>
              </div>

              {!selectedReport.syncedToCloud && (
                <div className="p-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 text-[11px] flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <HardDrive className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                    <span>Saved on Device · Waiting to Send</span>
                  </div>
                  {onSyncPendingReports && (
                    <button
                      type="button"
                      onClick={onSyncPendingReports}
                      disabled={isSyncingPending}
                      className="px-2 py-0.5 rounded-md bg-amber-600 hover:bg-amber-700 text-white font-bold text-[10px] flex items-center gap-1 transition-colors cursor-pointer shrink-0"
                    >
                      {isSyncingPending ? (
                        <Loader2 className="w-2.5 h-2.5 animate-spin" />
                      ) : (
                        <RefreshCw className="w-2.5 h-2.5" />
                      )}
                      <span>Send</span>
                    </button>
                  )}
                </div>
              )}

              {/* Municipal Department & Officer Assignment (shown only when values exist) */}
              {visibility.hasMunicipalAssignment && (
                <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700 space-y-1.5 text-[11px]">
                  {visibility.assignedDepartment && (
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-slate-500 dark:text-slate-400 font-medium inline-flex items-center gap-1 shrink-0">
                        <Building2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                        <span>Department</span>
                      </span>
                      <span className="font-semibold text-slate-800 dark:text-slate-100 text-right">
                        {visibility.assignedDepartment}
                      </span>
                    </div>
                  )}
                  {visibility.assignedOfficer && (
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-slate-500 dark:text-slate-400 font-medium inline-flex items-center gap-1 shrink-0">
                        <UserCheck className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
                        <span>Assigned Officer</span>
                      </span>
                      <span className="font-semibold text-slate-800 dark:text-slate-100 text-right">
                        {visibility.assignedOfficer}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Official Administrator Remarks (strictly distinct from citizen notes) */}
              {visibility.adminRemarks && (
                <div className="p-2.5 rounded-xl bg-sky-50/80 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-800 text-[11px] space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-sky-900 dark:text-sky-200 flex items-center gap-1">
                      <MessageSquare className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400 shrink-0" />
                      <span>Official Administrator Remarks</span>
                    </span>
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-sky-100 dark:bg-sky-900 text-sky-800 dark:text-sky-200">
                      Municipality
                    </span>
                  </div>
                  <p className="text-sky-950 dark:text-sky-100 leading-relaxed">
                    {visibility.adminRemarks}
                  </p>
                </div>
              )}

              {/* Duplicate Complaint Reference Notice (only when duplicateOf is set) */}
              {visibility.duplicateOf && (
                <div className="p-2.5 rounded-xl bg-amber-50/80 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-[11px] space-y-1">
                  <div className="flex items-center gap-1.5 font-bold text-amber-900 dark:text-amber-200">
                    <Link2 className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
                    <span>Linked Duplicate Complaint</span>
                  </div>
                  <p className="text-amber-900 dark:text-amber-200 leading-relaxed">
                    {visibility.linkedDuplicateReport ? (
                      <>
                        This complaint is linked to your existing report{' '}
                        <span className="font-mono font-bold">
                          {visibility.linkedDuplicateReport.trackingNumber}
                        </span>{' '}
                        ({visibility.linkedDuplicateReport.title}).
                      </>
                    ) : (
                      <>
                        Linked to related municipal complaint reference{' '}
                        <span className="font-mono font-bold">{visibility.duplicateOf}</span>.
                      </>
                    )}
                  </p>
                </div>
              )}

              <div>
                <span className="text-slate-500 dark:text-slate-400 block mb-0.5 font-medium">Location</span>
                <p className="font-semibold text-slate-800 dark:text-slate-200">
                  {selectedReport.location?.address || 'Manual Address Recorded'}
                </p>
                {isValidCoordinate(selectedReport.location?.latitude, selectedReport.location?.longitude) ? (
                  <span className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">
                    GPS: {selectedReport.location!.latitude!.toFixed(5)}, {selectedReport.location!.longitude!.toFixed(5)}
                  </span>
                ) : (
                  <span className="text-[10px] text-slate-400 dark:text-slate-500 italic">
                    Manual address recorded (no GPS)
                  </span>
                )}
              </div>

              <div>
                <span className="text-slate-500 dark:text-slate-400 block mb-0.5 font-medium">Description</span>
                <p className="font-medium text-slate-800 dark:text-slate-200 leading-relaxed bg-slate-50 dark:bg-slate-800/60 p-2.5 rounded-xl border border-slate-100 dark:border-slate-700">
                  {selectedReport.description}
                </p>
              </div>

              {/* AI Classification Info (if present) */}
              {selectedReport.aiAnalysis && (
                <div className="p-2.5 rounded-xl bg-emerald-50/60 dark:bg-emerald-950/40 border border-emerald-200/80 dark:border-emerald-800/80 text-[11px] text-emerald-950 dark:text-emerald-200">
                  <div className="flex items-center gap-1 font-bold mb-1">
                    <Sparkles className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                    <span>AI Issue Understanding</span>
                  </div>
                  <p className="text-[10px] text-emerald-800 dark:text-emerald-300">
                    Category Match: {selectedReport.aiAnalysis.categoryMatch ? 'Agreement' : 'Suggested Alternative'}
                  </p>
                  {selectedReport.aiAnalysis.confidence && (
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
                      Confidence: {selectedReport.aiAnalysis.confidence}
                    </p>
                  )}
                </div>
              )}

              {/* Saved AI Image Verification Findings (if recorded at submission) */}
              {selectedReport.imageVerification && (
                <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-[11px] space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1">
                      <Eye className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                      <span>Photo Assessment ({selectedReport.imageVerification.visualSubType || displayCategory})</span>
                    </span>
                    {selectedReport.imageVerification.requiresHumanReview && (
                      <span className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 text-[9px] font-bold">
                        Needs Officer Review
                      </span>
                    )}
                  </div>
                  {selectedReport.imageVerification.visibleObservations &&
                    selectedReport.imageVerification.visibleObservations.length > 0 && (
                      <ul className="list-disc list-inside text-[10px] text-slate-600 dark:text-slate-300 space-y-0.5">
                        {selectedReport.imageVerification.visibleObservations.slice(0, 3).map((obs, idx) => (
                          <li key={idx}>{obs}</li>
                        ))}
                      </ul>
                    )}
                </div>
              )}

              {/* Official Municipal Resolution Evidence (Strictly Separate from AI Previews) */}
              {visibility.hasResolutionEvidence && (
                <div className="p-3 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-800 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-emerald-900 dark:text-emerald-200 text-xs flex items-center gap-1.5">
                      <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                      <span>Official Municipal Resolution Evidence</span>
                    </span>
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-200/80 dark:bg-emerald-900 text-emerald-900 dark:text-emerald-200">
                      Staff Verified
                    </span>
                  </div>
                  {selectedReport.resolvedAt && (
                    <p className="text-[10px] text-emerald-700 dark:text-emerald-400 font-mono">
                      Resolved on {formatReportDate(selectedReport.resolvedAt)}
                    </p>
                  )}
                  {selectedReport.resolutionDetails && (
                    <p className="text-[11px] text-emerald-900 dark:text-emerald-100 leading-relaxed">
                      {selectedReport.resolutionDetails}
                    </p>
                  )}
                  {selectedReport.resolutionPhotoUrl && (
                    <div className="rounded-xl overflow-hidden border border-emerald-200 dark:border-emerald-700 bg-slate-950 max-h-44">
                      <img
                        src={selectedReport.resolutionPhotoUrl}
                        alt="Official municipal post-resolution completion evidence"
                        className="w-full h-full object-cover"
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Category-Specific Civic Awareness & Prevention Guide */}
              <CivicAwarenessInfoCard
                category={displayCategory}
                subType={selectedReport.imageVerification?.visualSubType}
              />

              {/* Timeline History */}
              <div>
                <span className="text-slate-500 dark:text-slate-400 block mb-1 font-medium">{t('myReports.timeline')}</span>
                {safeTimeline.length > 0 ? (
                  <div className="space-y-2 border-l-2 border-emerald-500 pl-3 ml-1">
                    {safeTimeline.map((event, idx) => {
                      const parsedMs = parseReportTimestamp(event.timestamp);
                      const formattedTs =
                        parsedMs > 0
                          ? new Date(parsedMs).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : event.timestamp?.trim() || 'Date unavailable';
                      return (
                        <div key={idx} className="text-[11px]">
                          <span className="font-bold text-slate-800 dark:text-slate-200">{event.status}</span>
                          <span className="text-[10px] text-slate-400 dark:text-slate-500 ml-1.5">{formattedTs}</span>
                          <p className="text-slate-600 dark:text-slate-400 text-[10px]">{event.note}</p>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-[11px] text-slate-400 dark:text-slate-500 italic">
                    Submitted on {formatReportDate(selectedReport.submittedAt)}
                  </p>
                )}
              </div>

              {/* Verified Municipal Status Audit Subcollection (displayed ONLY when permitted Firestore read succeeds) */}
              {statusHistoryAvailable && statusHistoryEntries.length > 0 && (
                <div>
                  <span className="text-slate-500 dark:text-slate-400 mb-1 font-medium flex items-center gap-1">
                    <History className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                    <span>Verified Municipal Status Log</span>
                  </span>
                  <div className="space-y-1.5 border-l-2 border-sky-400 pl-3 ml-1">
                    {statusHistoryEntries.map((entry) => {
                      const parsedMs = parseReportTimestamp(entry.timestamp);
                      const formattedTs =
                        parsedMs > 0
                          ? new Date(parsedMs).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : entry.timestamp?.trim() || 'Date unavailable';
                      return (
                        <div key={entry.id} className="text-[11px]">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-bold text-slate-800 dark:text-slate-200">
                              {entry.fromStatus ? `${entry.fromStatus} → ${entry.toStatus}` : entry.toStatus}
                            </span>
                            <span className="text-[9px] font-semibold px-1.5 py-0.2 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                              {entry.changedByRole === 'admin' ? 'Municipality' : 'Citizen'}
                            </span>
                            <span className="text-[10px] text-slate-400 dark:text-slate-500">{formattedTs}</span>
                          </div>
                          {entry.note && (
                            <p className="text-slate-600 dark:text-slate-400 text-[10px]">{entry.note}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Citizen Follow-up Notes Section */}
              {selectedReport.citizenNotes && selectedReport.citizenNotes.length > 0 && (
                <div>
                  <span className="text-slate-500 dark:text-slate-400 block mb-1 font-medium">Citizen Follow-up Notes</span>
                  <div className="space-y-1.5">
                    {selectedReport.citizenNotes.map((note, idx) => (
                      <div key={idx} className="p-2 rounded-xl bg-slate-50 dark:bg-slate-800/70 border border-slate-200/70 dark:border-slate-700 text-[11px] text-slate-700 dark:text-slate-300">
                        {note}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Archived Notice (read-only) */}
              {selectedReport.archived && (
                <div className="p-3 rounded-xl bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 text-[11px] text-slate-600 dark:text-slate-300 flex items-start gap-2">
                  <Archive className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold block text-slate-800 dark:text-slate-200">Complaint Archived</span>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                      This complaint has been archived by the municipality and is now read-only. Follow-up notes and withdrawals are disabled.
                    </p>
                  </div>
                </div>
              )}

              {/* Add Follow-up Note Form (disabled/hidden for archived or withdrawn reports) */}
              {!selectedReport.archived && selectedReport.status !== 'Withdrawn' && (
                <form onSubmit={handleAddCitizenNote} className="pt-2 border-t border-slate-100 dark:border-slate-800">
                  <label className="block text-[11px] font-bold text-slate-700 dark:text-slate-300 mb-1">
                    {t('myReports.addNote')}
                  </label>
                  {noteFeedback && (
                    <div
                      className={`text-[10px] mb-1.5 font-medium flex items-start gap-1.5 p-2 rounded-lg border ${
                        noteFeedback.type === 'success'
                          ? 'text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800'
                          : noteFeedback.type === 'pending'
                          ? 'text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800'
                          : 'text-rose-800 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800'
                      }`}
                    >
                      {noteFeedback.type === 'success' ? (
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400" />
                      ) : noteFeedback.type === 'pending' ? (
                        <HardDrive className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
                      ) : (
                        <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-rose-600 dark:text-rose-400" />
                      )}
                      <span>{noteFeedback.message}</span>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={citizenNoteInput}
                      onChange={(e) => {
                        setCitizenNoteInput(e.target.value);
                        if (noteFeedback?.type === 'error') setNoteFeedback(null);
                      }}
                      placeholder={t('myReports.notePlaceholder')}
                      className="flex-1 h-9 px-3 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:border-emerald-600"
                    />
                    <button
                      type="submit"
                      disabled={isAddingNote || !citizenNoteInput.trim()}
                      className="h-9 px-3 rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white font-bold text-xs flex items-center gap-1 cursor-pointer"
                    >
                      {isAddingNote ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                    </button>
                  </div>
                </form>
              )}

              {/* Withdraw Report Action for non-archived Submitted or Under Review reports */}
              {canWithdrawReport(selectedReport) && (
                <div className="pt-3 border-t border-slate-100 dark:border-slate-800">
                  <button
                    type="button"
                    onClick={() => handleOpenWithdrawDialog(selectedReport)}
                    className="w-full py-2.5 px-3 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-900/60 font-bold text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <Undo2 className="w-3.5 h-3.5" />
                    <span>{t('myReports.withdrawReport', 'Withdraw Report')}</span>
                  </button>
                </div>
              )}

              {/* Informational notice when report is Withdrawn */}
              {selectedReport.status === 'Withdrawn' && (
                <div className="p-3 rounded-xl bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 text-[11px] text-slate-600 dark:text-slate-300 flex items-start gap-2">
                  <Info className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold block text-slate-800 dark:text-slate-200">Report Withdrawn</span>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                      This report was withdrawn by you. Preserved in municipal records for reference; no further municipal action will be taken.
                      {selectedReport.withdrawnAt && (
                        <span className="block mt-1 font-mono text-[9px] text-slate-400">
                          Withdrawn on {formatReportDate(selectedReport.withdrawnAt)}
                        </span>
                      )}
                    </p>
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => onSelectReport(null)}
              className="w-full mt-5 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold text-xs cursor-pointer transition-colors"
            >
              {t('action.close')}
            </button>
          </div>
        </div>
        );
      })()}

      {/* Confirmation Dialog for Withdrawing a Report */}
      {reportToWithdraw && (
        <div className="fixed inset-0 z-60 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in">
          <div className="bg-white dark:bg-slate-900 rounded-3xl max-w-sm w-full p-5 shadow-2xl border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100">
            <div className="w-12 h-12 rounded-full bg-rose-100 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 flex items-center justify-center mx-auto mb-3">
              <AlertTriangle className="w-6 h-6" />
            </div>

            <h3 className="text-base font-bold text-center text-slate-900 dark:text-white mb-2">
              {t('myReports.withdrawConfirmTitle', 'Withdraw Report')}
            </h3>

            <p className="text-xs text-slate-600 dark:text-slate-300 text-center leading-relaxed mb-4">
              {t(
                'myReports.withdrawConfirmPrompt',
                'Are you sure you want to withdraw this report? This action cannot be undone by you.'
              )}
            </p>

            <div className="bg-slate-50 dark:bg-slate-800/60 rounded-xl p-2.5 border border-slate-200/80 dark:border-slate-700 mb-4 text-[11px]">
              <div className="flex items-center justify-between font-mono text-[10px] text-slate-500 dark:text-slate-400 mb-1">
                <span>{reportToWithdraw.trackingNumber}</span>
                <span className="font-sans font-semibold text-blue-600 dark:text-blue-400">
                  {reportToWithdraw.status}
                </span>
              </div>
              <p className="font-semibold text-slate-800 dark:text-slate-200 truncate">
                {reportToWithdraw.title}
              </p>
              <p className="text-slate-500 dark:text-slate-400 truncate text-[10px] mt-0.5">
                {reportToWithdraw.location?.address || 'Manual Address Recorded'}
              </p>
            </div>

            {withdrawErrorNotice && (
              <div className="p-2.5 mb-3 rounded-xl bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 text-[11px] flex items-start gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{withdrawErrorNotice}</span>
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setReportToWithdraw(null);
                  setWithdrawErrorNotice(null);
                }}
                disabled={isWithdrawing}
                className="flex-1 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold text-xs cursor-pointer transition-colors"
              >
                {t('myReports.withdrawCancel', 'Cancel')}
              </button>
              <button
                type="button"
                onClick={handleConfirmWithdraw}
                disabled={isWithdrawing}
                className="flex-1 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer transition-colors shadow-sm shadow-rose-900/20"
              >
                {isWithdrawing ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Undo2 className="w-3.5 h-3.5" />
                )}
                <span>{t('myReports.withdrawConfirm', 'Confirm Withdrawal')}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
