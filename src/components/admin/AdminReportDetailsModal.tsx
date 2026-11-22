import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  X,
  Clock,
  MapPin,
  Tag,
  AlertTriangle,
  CheckCircle2,
  Calendar,
  Building,
  User,
  Upload,
  Camera,
  Loader2,
  FileText,
  History,
  Sparkles,
  ExternalLink,
  RotateCcw,
  Link2,
  Archive,
} from 'lucide-react';
import {
  ADMIN_ROLE_CAPABILITIES,
  AdminRole,
  CANONICAL_MUNICIPAL_DEPARTMENTS,
  CivicIssueReport,
  ReportStatus,
  StatusHistoryEntry,
  buildDepartmentSelectOptions,
  normalizeCivicCategory,
  normalizeReportStatus,
  resolveDepartmentUpdateArg,
  resolveDuplicateOfUpdateArg,
  resolveOptionalStringUpdateArg,
  resolveReportDepartment,
  resolveTimelineActor,
} from '../../types/civic';
import {
  updateReportStatusByAdmin,
  reopenWithdrawnReportByAdmin,
  VALID_STATUS_TRANSITIONS,
  fetchReportStatusHistory,
  reconcileAdminModalFormState,
  hasAdminModalFormChanges,
} from '../../services/adminService';
import {
  formatImageReviewStatusLabel,
  toUserFriendlyErrorMessage,
} from '../../utils/userFriendlyErrors';
import {
  MAX_FIRESTORE_DOC_BYTES,
  parseReportTimestamp,
  sanitizeForFirestore,
} from '../../services/reportStorage';
import {
  estimateFirestoreDocumentSize,
  optimizeResolutionPhotoDataUrl,
} from '../../services/imageOptimizer';
import { findDuplicateCandidates, isValidCoordinate } from '../../utils/reportLocations';
import {
  assessReportDataQuality,
  generateSafeCitizenCode,
  sanitizeCitizenDisplayName,
  validateMeaningfulCivicText,
  validateOfficerName,
} from '../../utils/inputValidation';
import { CivicStatusBadge } from '../CivicStatusBadge';

interface AdminReportDetailsModalProps {
  report: CivicIssueReport;
  allReports?: CivicIssueReport[];
  adminRole?: AdminRole;
  onClose: () => void;
  onReportUpdated: (updatedReport: CivicIssueReport) => void;
}

export const AdminReportDetailsModal: React.FC<AdminReportDetailsModalProps> = ({
  report,
  allReports = [],
  adminRole,
  onClose,
  onReportUpdated,
}) => {
  const [baselineReport, setBaselineReport] = useState<CivicIssueReport>(report);
  const initialDepartment = resolveReportDepartment(baselineReport);
  const baselineStatus = normalizeReportStatus(baselineReport.status);
  const isWithdrawn =
    baselineStatus === 'Withdrawn' || normalizeReportStatus(report.status) === 'Withdrawn';
  const isArchived = Boolean(baselineReport.archived || report.archived);
  const isReadOnly = isWithdrawn || isArchived;
  const canAssignDepartmentUi = adminRole
    ? ADMIN_ROLE_CAPABILITIES[adminRole].canAssignDepartment
    : true;
  const canReopenWithdrawnUi = adminRole
    ? ADMIN_ROLE_CAPABILITIES[adminRole].canReopenWithdrawn
    : true;

  const [currentStatus, setCurrentStatus] = useState<ReportStatus>(
    normalizeReportStatus(report.status)
  );
  const [assignedDepartment, setAssignedDepartment] = useState<string>(
    resolveReportDepartment(report)
  );
  const [assignedOfficer, setAssignedOfficer] = useState<string>(
    report.assignedOfficer || ''
  );
  const [adminRemarks, setAdminRemarks] = useState<string>(
    report.adminRemarks || ''
  );
  const [resolutionDetails, setResolutionDetails] = useState<string>(
    report.resolutionDetails || ''
  );
  const [resolutionPhotoUrl, setResolutionPhotoUrl] = useState<string>(
    report.resolutionPhotoUrl || ''
  );
  const [duplicateOf, setDuplicateOf] = useState<string>(
    report.duplicateOf || ''
  );

  const [statusHistory, setStatusHistory] = useState<StatusHistoryEntry[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitLockRef = useRef(false);
  const [showReopenForm, setShowReopenForm] = useState(false);
  const [reopenReason, setReopenReason] = useState('');
  const [isReopening, setIsReopening] = useState(false);
  const [concurrentConflict, setConcurrentConflict] = useState<string | null>(null);
  const [feedbackMessage, setFeedbackMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const baselineReportRef = useRef(baselineReport);
  baselineReportRef.current = baselineReport;

  const latestFormRef = useRef({
    status: currentStatus,
    assignedDepartment,
    assignedOfficer,
    adminRemarks,
    resolutionDetails,
    resolutionPhotoUrl,
    duplicateOf,
  });
  latestFormRef.current = {
    status: currentStatus,
    assignedDepartment,
    assignedOfficer,
    adminRemarks,
    resolutionDetails,
    resolutionPhotoUrl,
    duplicateOf,
  };

  const applyFreshReportToForm = (target: CivicIssueReport) => {
    setBaselineReport(target);
    baselineReportRef.current = target;
    setCurrentStatus(normalizeReportStatus(target.status));
    setAssignedDepartment(resolveReportDepartment(target));
    setAssignedOfficer(target.assignedOfficer || '');
    setAdminRemarks(target.adminRemarks || '');
    setResolutionDetails(target.resolutionDetails || '');
    setResolutionPhotoUrl(target.resolutionPhotoUrl || '');
    setDuplicateOf(target.duplicateOf || '');
    setConcurrentConflict(null);
  };

  // Hard-reset form & state only when inspecting a different report ID
  useEffect(() => {
    applyFreshReportToForm(report);
    setFeedbackMessage(null);
    setShowReopenForm(false);
    setReopenReason('');
  }, [report.id]);

  // Reconcile incoming live updates for the SAME open report without clobbering unsaved edits
  useEffect(() => {
    const activeBaseline = baselineReportRef.current;
    if (report.id !== activeBaseline.id) return;
    if (report === activeBaseline) return;
    if (submitLockRef.current) return;

    const { nextForm, conflictMessage } = reconcileAdminModalFormState(
      latestFormRef.current,
      activeBaseline,
      report
    );

    setCurrentStatus(nextForm.status);
    setAssignedDepartment(nextForm.assignedDepartment);
    setAssignedOfficer(nextForm.assignedOfficer);
    setAdminRemarks(nextForm.adminRemarks);
    setResolutionDetails(nextForm.resolutionDetails);
    setResolutionPhotoUrl(nextForm.resolutionPhotoUrl);
    setDuplicateOf(nextForm.duplicateOf);
    setBaselineReport(report);
    baselineReportRef.current = report;

    if (conflictMessage) {
      setConcurrentConflict(conflictMessage);
    }
  }, [report]);

  // Refresh immutable statusHistory whenever report.id, updatedAt, or status changes
  useEffect(() => {
    let active = true;
    setIsLoadingHistory(true);
    fetchReportStatusHistory(report.id)
      .then((entries) => {
        if (active) setStatusHistory(entries);
      })
      .catch(() => {
        if (active) setStatusHistory([]);
      })
      .finally(() => {
        if (active) setIsLoadingHistory(false);
      });

    return () => {
      active = false;
    };
  }, [report.id, report.updatedAt, report.status]);

  // Restrict status dropdown to current live status + allowed workflow transitions
  const statusOptions: ReportStatus[] = useMemo(() => {
    const allowed = VALID_STATUS_TRANSITIONS[baselineStatus] || [];
    return Array.from(new Set<ReportStatus>([baselineStatus, ...allowed, currentStatus]));
  }, [baselineStatus, currentStatus]);

  // Nearby / similar duplicate candidates for admin triage
  const duplicateCandidates = useMemo(
    () => findDuplicateCandidates(report, allReports, 150).slice(0, 5),
    [report, allReports]
  );

  // Municipal departments: preserve existing legacy/custom department alongside canonical options
  const departmentOptions = useMemo(
    () => buildDepartmentSelectOptions(initialDepartment),
    [initialDepartment]
  );

  // Handle local resolution image upload with progressive byte-budgeted compression
  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setFeedbackMessage({ type: 'error', text: 'Please select a valid image file.' });
      e.target.value = '';
      return;
    }

    setFeedbackMessage(null);
    const reader = new FileReader();
    reader.onload = async (event) => {
      const rawDataUrl = event.target?.result;
      if (typeof rawDataUrl !== 'string' || !rawDataUrl) {
        setFeedbackMessage({ type: 'error', text: 'Could not read the selected image file.' });
        return;
      }

      const optimized = await optimizeResolutionPhotoDataUrl(rawDataUrl);
      if (!optimized.success || !optimized.dataUrl) {
        setFeedbackMessage({
          type: 'error',
          text:
            optimized.error ||
            'Could not compress resolution photo within safe limits. Please select a smaller image.',
        });
        return;
      }

      setResolutionPhotoUrl(optimized.dataUrl);

      // Advisory pre-flight estimate against the currently loaded report snapshot;
      // authoritative live document size enforcement runs inside the Firestore transaction on save.
      const advisoryDocBytes = estimateFirestoreDocumentSize(
        sanitizeForFirestore({
          ...report,
          status: currentStatus,
          adminRemarks,
          resolutionDetails,
          resolutionPhotoUrl: optimized.dataUrl,
        })
      );
      if (advisoryDocBytes > MAX_FIRESTORE_DOC_BYTES) {
        setFeedbackMessage({
          type: 'error',
          text: 'This photo is quite large and may not save properly. Please choose a smaller image if saving fails.',
        });
      }
    };
    reader.onerror = () => {
      setFeedbackMessage({ type: 'error', text: 'Failed to read the selected image file.' });
    };
    reader.readAsDataURL(file);
  };

  // Submit Administrative Updates to Firestore
  const handleSaveUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting || submitLockRef.current) return;

    if (concurrentConflict) {
      setFeedbackMessage({
        type: 'error',
        text: 'Please review the live updates and click "Refresh Form" above before saving.',
      });
      return;
    }

    if (isArchived) {
      setFeedbackMessage({
        type: 'error',
        text: 'This complaint has been archived and can no longer be edited.',
      });
      return;
    }

    if (isWithdrawn) {
      setFeedbackMessage({
        type: 'error',
        text: 'This complaint was withdrawn by the citizen. Use "Reopen Complaint" above before making changes.',
      });
      return;
    }

    const currentFormSnapshot = {
      status: currentStatus,
      assignedDepartment,
      assignedOfficer,
      adminRemarks,
      resolutionDetails,
      resolutionPhotoUrl,
      duplicateOf,
    };

    if (!hasAdminModalFormChanges(currentFormSnapshot, baselineReport)) {
      setFeedbackMessage({
        type: 'error',
        text: 'No changes detected. Update status, department, officer, remarks, duplicate link, or resolution details before saving.',
      });
      return;
    }

    if (currentStatus === 'Resolved' && !resolutionDetails.trim()) {
      setFeedbackMessage({
        type: 'error',
        text: 'Please provide Citizen Resolution Summary details before marking this report as Resolved.',
      });
      return;
    }

    if (assignedOfficer.trim()) {
      const officerCheck = validateOfficerName(assignedOfficer);
      if (!officerCheck.valid) {
        setFeedbackMessage({
          type: 'error',
          text: officerCheck.error || 'Please enter a valid officer name.',
        });
        return;
      }
    }

    if (adminRemarks.trim()) {
      const remarksCheck = validateMeaningfulCivicText(adminRemarks, {
        fieldLabel: 'Official remarks',
        minLength: 2,
        required: false,
        allowShortConcise: true,
      });
      if (!remarksCheck.valid) {
        setFeedbackMessage({
          type: 'error',
          text: remarksCheck.error || 'Please enter meaningful official remarks.',
        });
        return;
      }
    }

    if (resolutionDetails.trim()) {
      const resCheck = validateMeaningfulCivicText(resolutionDetails, {
        fieldLabel: 'Citizen resolution summary',
        minLength: 2,
        required: currentStatus === 'Resolved',
        allowShortConcise: true,
      });
      if (!resCheck.valid) {
        setFeedbackMessage({
          type: 'error',
          text: resCheck.error || 'Please enter a meaningful resolution summary.',
        });
        return;
      }
    }

    submitLockRef.current = true;
    setIsSubmitting(true);
    setFeedbackMessage(null);

    try {
      const isTransition = baselineStatus !== currentStatus;

      const departmentUpdateArg = canAssignDepartmentUi
        ? resolveDepartmentUpdateArg(initialDepartment, assignedDepartment)
        : undefined;
      const officerUpdateArg = resolveOptionalStringUpdateArg(
        baselineReport.assignedOfficer,
        assignedOfficer
      );
      const remarksUpdateArg = resolveOptionalStringUpdateArg(
        baselineReport.adminRemarks,
        adminRemarks
      );
      const resolutionDetailsUpdateArg = resolveOptionalStringUpdateArg(
        baselineReport.resolutionDetails,
        resolutionDetails
      );
      const resolutionPhotoUpdateArg =
        resolutionPhotoUrl !== (baselineReport.resolutionPhotoUrl || '')
          ? resolutionPhotoUrl
          : undefined;
      const duplicateUpdateArg = resolveDuplicateOfUpdateArg(
        baselineReport.duplicateOf,
        duplicateOf
      );

      const res = await updateReportStatusByAdmin(report.id, {
        status: currentStatus,
        previousStatus: baselineStatus,
        adminRemarks: remarksUpdateArg,
        assignedDepartment: departmentUpdateArg,
        assignedOfficer: officerUpdateArg,
        resolutionDetails: resolutionDetailsUpdateArg,
        resolutionPhotoUrl: resolutionPhotoUpdateArg,
        duplicateOf: duplicateUpdateArg,
        currentTimeline: baselineReport.timeline || report.timeline,
      });

      if (res.success) {
        const persisted = res.updatedFields;
        const nowIso = persisted?.updatedAt || new Date().toISOString();
        const updated: CivicIssueReport = {
          ...baselineReport,
          status: persisted?.status ?? currentStatus,
          adminRemarks:
            persisted?.adminRemarks !== undefined
              ? persisted.adminRemarks
              : remarksUpdateArg !== undefined
              ? remarksUpdateArg
              : baselineReport.adminRemarks,
          assignedDepartment:
            persisted?.assignedDepartment !== undefined
              ? persisted.assignedDepartment
              : departmentUpdateArg !== undefined
              ? departmentUpdateArg
              : baselineReport.assignedDepartment,
          department:
            persisted?.department !== undefined
              ? persisted.department
              : departmentUpdateArg !== undefined
              ? departmentUpdateArg
              : baselineReport.department,
          assignedOfficer:
            persisted?.assignedOfficer !== undefined
              ? persisted.assignedOfficer
              : officerUpdateArg !== undefined
              ? officerUpdateArg
              : baselineReport.assignedOfficer,
          resolutionDetails:
            persisted?.resolutionDetails !== undefined
              ? persisted.resolutionDetails
              : resolutionDetailsUpdateArg !== undefined
              ? resolutionDetailsUpdateArg
              : baselineReport.resolutionDetails,
          resolutionPhotoUrl:
            persisted?.resolutionPhotoUrl !== undefined
              ? persisted.resolutionPhotoUrl
              : resolutionPhotoUpdateArg !== undefined
              ? resolutionPhotoUpdateArg
              : baselineReport.resolutionPhotoUrl,
          resolvedAt:
            persisted?.resolvedAt !== undefined
              ? persisted.resolvedAt
              : currentStatus === 'Resolved'
              ? nowIso
              : baselineReport.resolvedAt,
          duplicateOf:
            persisted !== undefined
              ? persisted.duplicateOf
              : duplicateUpdateArg !== undefined
              ? duplicateUpdateArg || undefined
              : baselineReport.duplicateOf,
          updatedBy: persisted?.updatedBy ?? baselineReport.updatedBy,
          updatedAt: nowIso,
          timeline: persisted?.timeline ?? baselineReport.timeline ?? report.timeline ?? [],
        };

        applyFreshReportToForm(updated);

        fetchReportStatusHistory(report.id)
          .then((entries) => setStatusHistory(entries))
          .catch(() => {});

        setFeedbackMessage({
          type: 'success',
          text: isTransition
            ? `Report ${report.trackingNumber} status updated to "${currentStatus}".`
            : `Updates for ${report.trackingNumber} saved successfully.`,
        });
        onReportUpdated(updated);
      } else {
        setFeedbackMessage({
          type: 'error',
          text: res.error || "We couldn't save your changes. Please try again.",
        });
      }
    } catch (err: any) {
      console.error('Unexpected error updating report:', err);
      setFeedbackMessage({
        type: 'error',
        text: toUserFriendlyErrorMessage(err, 'update_complaint'),
      });
    } finally {
      submitLockRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleConfirmReopenReport = async () => {
    if (isReopening || isSubmitting || submitLockRef.current) return;
    if (isArchived) {
      setFeedbackMessage({
        type: 'error',
        text: 'This complaint has been archived and cannot be reopened.',
      });
      return;
    }
    const trimmedReason = reopenReason.trim();
    if (trimmedReason.length < 3) {
      setFeedbackMessage({
        type: 'error',
        text: 'Please provide a brief reason before reopening this complaint.',
      });
      return;
    }

    submitLockRef.current = true;
    setIsReopening(true);
    setFeedbackMessage(null);
    try {
      const res = await reopenWithdrawnReportByAdmin(report.id, trimmedReason);
      if (res.success) {
        const persisted = res.updatedFields;
        const nowIso = persisted?.updatedAt || new Date().toISOString();
        const updated: CivicIssueReport = {
          ...baselineReport,
          status: persisted?.status ?? 'Under Review',
          adminRemarks: persisted?.adminRemarks ?? baselineReport.adminRemarks,
          updatedBy: persisted?.updatedBy ?? baselineReport.updatedBy,
          updatedAt: nowIso,
          timeline: persisted?.timeline ?? baselineReport.timeline ?? report.timeline ?? [],
        };

        applyFreshReportToForm(updated);
        setShowReopenForm(false);
        setReopenReason('');

        fetchReportStatusHistory(report.id)
          .then((entries) => setStatusHistory(entries))
          .catch(() => {});

        setFeedbackMessage({
          type: 'success',
          text: `Complaint ${report.trackingNumber} has been reopened and moved to "Under Review".`,
        });
        onReportUpdated(updated);
      } else {
        setFeedbackMessage({
          type: 'error',
          text: res.error || "We couldn't reopen this complaint. Please try again.",
        });
      }
    } catch (err: any) {
      console.error('Unexpected error reopening withdrawn complaint:', err);
      setFeedbackMessage({
        type: 'error',
        text: toUserFriendlyErrorMessage(err, 'reopen_complaint'),
      });
    } finally {
      submitLockRef.current = false;
      setIsReopening(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/65 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl w-full max-w-4xl max-h-[92vh] flex flex-col shadow-2xl text-slate-900 dark:text-slate-100 overflow-hidden my-auto">
        {/* Header */}
        <div className="px-4 sm:px-6 py-3.5 sm:py-4 border-b border-slate-200/80 dark:border-slate-800 flex items-center justify-between bg-[#FAFBF9] dark:bg-slate-950/60 shrink-0 gap-3">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3 min-w-0">
            <span className="font-mono text-xs sm:text-sm px-2.5 py-1 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 font-bold">
              {report.trackingNumber}
            </span>
            <CivicStatusBadge status={report.status} size="sm" themeMode="auto" />
            {isArchived && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-[11px] font-bold">
                <Archive className="w-3 h-3" />
                Archived
              </span>
            )}
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Ward: <strong className="text-slate-800 dark:text-slate-200">{report.location.ward}</strong>
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close report details"
            className="p-2 rounded-xl text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-4 sm:p-6 overflow-y-auto space-y-5 flex-1 text-sm">
          {/* Feedback banner */}
          {feedbackMessage && (
            <div
              role="alert"
              className={`p-3.5 rounded-2xl border flex items-center gap-2.5 text-xs ${
                feedbackMessage.type === 'success'
                  ? 'bg-emerald-50 dark:bg-emerald-950/50 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
                  : 'bg-rose-50 dark:bg-rose-950/50 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-200'
              }`}
            >
              {feedbackMessage.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              ) : (
                <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
              )}
              <span className="font-medium leading-relaxed">{feedbackMessage.text}</span>
            </div>
          )}

          {/* Concurrent live-update conflict alert */}
          {concurrentConflict && (
            <div
              role="alert"
              className="p-3.5 rounded-2xl border bg-amber-50 dark:bg-amber-950/50 border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
            >
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <span className="font-medium leading-relaxed">{concurrentConflict}</span>
              </div>
              <button
                type="button"
                onClick={() => applyFreshReportToForm(report)}
                className="px-3 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-[11px] shrink-0 cursor-pointer transition"
              >
                Refresh Form
              </button>
            </div>
          )}

          {/* Archived Read-Only Notice */}
          {isArchived && (
            <div className="bg-slate-100 dark:bg-slate-800/70 border border-slate-300 dark:border-slate-700 p-4 rounded-2xl flex items-start gap-3 text-xs">
              <Archive className="w-5 h-5 text-slate-600 dark:text-slate-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="font-bold text-slate-900 dark:text-slate-100">
                  Complaint Archived (Read-Only)
                </div>
                <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                  This complaint was archived
                  {parseReportTimestamp(report.archivedAt) > 0
                    ? ` on ${new Date(parseReportTimestamp(report.archivedAt)).toLocaleString()}`
                    : ''}{' '}
                  and is preserved for municipal audit records. Status updates, reassignments, and reopening are disabled.
                </p>
                {report.archiveReason && (
                  <p className="text-slate-700 dark:text-slate-300 italic">
                    Archive Reason: &ldquo;{report.archiveReason}&rdquo;
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Withdrawn Notice + Explicit Reopen Action */}
          {isWithdrawn && (
            <div className="bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <RotateCcw className="w-5 h-5 text-slate-500 dark:text-slate-400 shrink-0 mt-0.5" />
                  <div className="space-y-1 text-xs">
                    <div className="font-bold text-slate-800 dark:text-slate-200">
                      Report Withdrawn by Citizen
                    </div>
                    <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                      This complaint was voluntarily withdrawn by the submitting citizen
                      {report.withdrawnAt ? ` on ${new Date(report.withdrawnAt).toLocaleString()}` : ''}.
                      Ordinary status edits are locked to protect citizen intent, unless an administrator explicitly reopens it for municipal review.
                    </p>
                    {report.withdrawalReason && (
                      <p className="text-slate-700 dark:text-slate-300 italic">
                        Reason: &ldquo;{report.withdrawalReason}&rdquo;
                      </p>
                    )}
                  </div>
                </div>
                {canReopenWithdrawnUi && !isArchived && !showReopenForm && (
                  <button
                    type="button"
                    disabled={isReopening || isSubmitting}
                    onClick={() => {
                      setFeedbackMessage(null);
                      setShowReopenForm(true);
                    }}
                    className="px-3.5 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold shrink-0 cursor-pointer transition disabled:opacity-50"
                  >
                    Reopen Complaint
                  </button>
                )}
              </div>

              {canReopenWithdrawnUi && !isArchived && showReopenForm && (
                <div className="pt-3 border-t border-slate-200 dark:border-slate-700 space-y-2.5 text-xs">
                  <p className="text-slate-700 dark:text-slate-300 font-medium">
                    Reopening moves this complaint back to <strong>Under Review</strong> and records your reason in the status history and audit log.
                  </p>
                  <input
                    type="text"
                    aria-label="Reason for reopening complaint"
                    value={reopenReason}
                    onChange={(e) => {
                      setReopenReason(e.target.value);
                      setFeedbackMessage(null);
                    }}
                    disabled={isReopening}
                    placeholder="Enter reason for reopening (e.g. Public safety hazard requires inspection)..."
                    className="w-full h-9 px-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 text-xs text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:border-emerald-600"
                  />
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      disabled={isReopening}
                      onClick={() => {
                        setShowReopenForm(false);
                        setReopenReason('');
                      }}
                      className="px-3 py-1.5 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-700/60 cursor-pointer transition disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={isReopening}
                      onClick={handleConfirmReopenReport}
                      className="px-3.5 py-1.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer transition disabled:opacity-50"
                    >
                      {isReopening && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      <span>{isReopening ? 'Reopening...' : 'Confirm Reopen'}</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Non-destructive Data Quality Advisory */}
          {(() => {
            const qualityAudit = assessReportDataQuality(report);
            if (!qualityAudit.isSuspicious) return null;
            return (
              <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/70 p-3.5 rounded-2xl flex items-start gap-2.5 text-xs text-amber-900 dark:text-amber-200">
                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold block">Data Quality Review Advisory</span>
                  <span className="text-[11px] opacity-90">
                    This historical record contains flagged test or incomplete text ({qualityAudit.reasons.join('; ')}). Preserved for audit traceability.
                  </span>
                </div>
              </div>
            );
          })()}

          {/* Top grid: Description & Photos */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 sm:gap-6">
            {/* Left Column: Complaint Details */}
            <div className="space-y-4">
              {/* Citizen info with strict privacy protection (no email domains or raw UIDs) */}
              {(() => {
                const safeCode = generateSafeCitizenCode(report.userId || 'anonymous-citizen');
                const safeName = sanitizeCitizenDisplayName(report.citizenName, safeCode);
                return (
                  <div className="bg-[#FAFBF9] dark:bg-slate-800/60 p-3.5 rounded-2xl border border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-9 h-9 rounded-xl bg-emerald-100 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 flex items-center justify-center font-bold shrink-0">
                        <User className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <span className="font-bold text-slate-900 dark:text-white block truncate">
                          {safeName}
                        </span>
                        <span className="text-[11px] text-slate-500 dark:text-slate-400 font-mono block truncate">
                          {safeCode} · Contact details protected
                        </span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <span className="text-[10px] text-slate-500 dark:text-slate-400 block uppercase tracking-wider font-semibold">
                        Category
                      </span>
                      <span className="text-xs font-semibold text-emerald-800 dark:text-emerald-300">
                        {normalizeCivicCategory(report.normalizedCategory || report.category)}
                      </span>
                    </div>
                  </div>
                );
              })()}

              <div>
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                  Complaint Title
                </h3>
                <p className="text-base font-bold text-slate-900 dark:text-white">{report.title}</p>
              </div>

              <div>
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                  Description
                </h3>
                <p className="text-xs sm:text-sm text-slate-700 dark:text-slate-300 bg-[#FAFBF9] dark:bg-slate-800/60 p-3.5 rounded-2xl border border-slate-200 dark:border-slate-800 leading-relaxed whitespace-pre-line">
                  {report.description}
                </p>
              </div>

              {/* Location details */}
              <div className="bg-[#FAFBF9] dark:bg-slate-800/60 p-3.5 rounded-2xl border border-slate-200 dark:border-slate-800 space-y-1.5">
                <div className="flex items-start gap-2.5 text-slate-700 dark:text-slate-300 text-xs">
                  <MapPin className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold text-slate-900 dark:text-white block">
                      {report.location.address}
                    </span>
                    {report.location.landmark && (
                      <span className="text-xs text-slate-500 dark:text-slate-400 block mt-0.5">
                        Landmark: {report.location.landmark}
                      </span>
                    )}
                    {isValidCoordinate(report.location.latitude, report.location.longitude) ? (
                      <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400 block mt-0.5">
                        {(report.location.latitude as number).toFixed(5)}, {(report.location.longitude as number).toFixed(5)}
                      </span>
                    ) : (
                      <span className="text-[11px] text-slate-500 dark:text-slate-400 block mt-0.5">
                        Manual address recorded (no GPS coordinates)
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* AI Classification Insights */}
              {report.aiAnalysis && (
                <div className="bg-emerald-50/70 dark:bg-emerald-950/25 border border-emerald-200/80 dark:border-emerald-900/50 p-3.5 rounded-2xl space-y-1.5">
                  <div className="flex items-center gap-1.5 text-emerald-800 dark:text-emerald-400 text-xs font-bold">
                    <Sparkles className="w-3.5 h-3.5" />
                    AI Issue Assessment
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-700 dark:text-slate-300">
                    <span>
                      Suggested Category:{' '}
                      <strong className="text-slate-900 dark:text-white">
                        {report.aiAnalysis.suggestedCategory}
                      </strong>
                    </span>
                    <span>
                      Severity:{' '}
                      <strong className="text-amber-700 dark:text-amber-300">
                        {report.aiAnalysis.severity}
                      </strong>
                    </span>
                  </div>
                  {report.aiAnalysis.aiNotes && (
                    <p className="text-xs text-slate-600 dark:text-slate-400 italic mt-1">
                      &ldquo;{report.aiAnalysis.aiNotes}&rdquo;
                    </p>
                  )}
                </div>
              )}

              {/* AI Image Verification & Review Flags */}
              {report.imageVerification && (
                <div className="bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 p-3.5 rounded-2xl space-y-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-slate-800 dark:text-slate-200">
                      Image review information: {report.imageVerification.visualSubType || report.category}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                        report.imageVerification.decision === 'UNRELATED_IMAGE'
                          ? 'bg-rose-100 dark:bg-rose-500/20 text-rose-800 dark:text-rose-300 border-rose-200 dark:border-rose-500/40'
                          : report.imageVerification.requiresHumanReview
                          ? 'bg-amber-100 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-500/40'
                          : 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/40'
                      }`}
                    >
                      {formatImageReviewStatusLabel(report.imageVerification.decision)}
                    </span>
                  </div>

                  {report.imageVerification.duplicateMatchTrackingNumber && (
                    <p className="text-[11px] text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/50 px-2.5 py-1.5 rounded-xl">
                      Possible duplicate photograph matching report{' '}
                      <strong>{report.imageVerification.duplicateMatchTrackingNumber}</strong>.
                    </p>
                  )}

                  {report.imageVerification.visibleObservations &&
                    report.imageVerification.visibleObservations.length > 0 && (
                      <div>
                        <span className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-bold block mb-0.5">
                          Visible Observations
                        </span>
                        <ul className="list-disc list-inside text-[11px] text-slate-700 dark:text-slate-300 space-y-0.5">
                          {report.imageVerification.visibleObservations.map((obs, idx) => (
                            <li key={idx}>{obs}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                  {report.imageVerification.aiAssumptions &&
                    report.imageVerification.aiAssumptions.length > 0 && (
                      <div>
                        <span className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-bold block mb-0.5">
                          Possible Causes (Verify On-Site)
                        </span>
                        <ul className="list-disc list-inside text-[11px] text-slate-600 dark:text-slate-400 space-y-0.5">
                          {report.imageVerification.aiAssumptions.map((assumption, idx) => (
                            <li key={idx}>{assumption}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                </div>
              )}
            </div>

            {/* Right Column: Visual Evidence (Citizen photo vs Resolution photo) */}
            <div className="space-y-4">
              <div>
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5 flex items-center justify-between">
                  <span>{report.afterPhotoUrl ? 'Citizen Before Photo (Issue)' : 'Citizen Photo'}</span>
                  {report.photoUrl && (
                    <span className="text-[10px] text-emerald-700 dark:text-emerald-400 font-semibold normal-case">
                      Submitted Evidence
                    </span>
                  )}
                </h3>
                {report.photoUrl ? (
                  <div className="relative rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-950 h-52 flex items-center justify-center">
                    <img
                      src={report.photoUrl}
                      alt="Citizen issue evidence"
                      className="w-full h-full object-contain"
                    />
                  </div>
                ) : !report.afterPhotoUrl ? (
                  <div className="h-44 rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 flex flex-col items-center justify-center text-slate-500 text-xs p-4 text-center">
                    <FileText className="w-8 h-8 text-slate-400 dark:text-slate-600 mb-2" />
                    <span>No photograph attached with this complaint.</span>
                  </div>
                ) : (
                  <div className="h-28 rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 flex flex-col items-center justify-center text-slate-500 text-xs p-3 text-center">
                    <span>No initial Before photo attached.</span>
                  </div>
                )}
              </div>

              {report.afterPhotoUrl && (
                <div>
                  <h3 className="text-[11px] font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-400 mb-1.5 flex items-center justify-between">
                    <span>Citizen After Photo (Resolved Condition)</span>
                    <span className="text-[10px] text-emerald-700 dark:text-emerald-400 font-semibold normal-case">
                      Citizen Provided
                    </span>
                  </h3>
                  <div className="relative rounded-2xl overflow-hidden border border-emerald-200 dark:border-emerald-800/70 bg-slate-100 dark:bg-slate-950 h-44 flex items-center justify-center">
                    <img
                      src={report.afterPhotoUrl}
                      alt="Citizen resolved condition evidence"
                      className="w-full h-full object-contain"
                    />
                  </div>
                </div>
              )}

              {/* Resolution Photo if available or preview */}
              <div>
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-400 mb-1.5 flex items-center justify-between">
                  <span>Resolution Evidence Photo</span>
                  {resolutionPhotoUrl && (
                    <span className="text-[10px] text-emerald-700 dark:text-emerald-400 font-semibold normal-case">
                      Proof of Work
                    </span>
                  )}
                </h3>
                {resolutionPhotoUrl ? (
                  <div className="relative rounded-2xl overflow-hidden border border-emerald-300 dark:border-emerald-700/60 bg-slate-100 dark:bg-slate-950 h-52 flex items-center justify-center">
                    <img
                      src={resolutionPhotoUrl}
                      alt="Resolution evidence"
                      className="w-full h-full object-contain"
                    />
                    <button
                      type="button"
                      disabled={isReadOnly}
                      onClick={() => {
                        setResolutionPhotoUrl('');
                        setFeedbackMessage(null);
                      }}
                      className="absolute top-2 right-2 bg-white/90 dark:bg-slate-900/90 hover:bg-rose-50 dark:hover:bg-rose-950 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-800 px-2.5 py-1 rounded-xl text-xs font-semibold cursor-pointer shadow-xs disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <label
                    className={`h-32 rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 flex flex-col items-center justify-center text-slate-600 dark:text-slate-300 transition p-4 text-center ${
                      isReadOnly
                        ? 'opacity-50 cursor-not-allowed'
                        : 'hover:border-emerald-500 hover:bg-emerald-50/40 dark:hover:bg-slate-800/70 cursor-pointer'
                    }`}
                  >
                    <Camera className="w-6 h-6 text-emerald-600 dark:text-emerald-400 mb-1.5" />
                    <span className="text-xs font-semibold">Attach Resolution Photo</span>
                    <span className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
                      JPG / PNG compressed automatically
                    </span>
                    <input
                      type="file"
                      accept="image/*"
                      disabled={isReadOnly}
                      onChange={handlePhotoUpload}
                      className="hidden"
                    />
                  </label>
                )}
              </div>
            </div>
          </div>

          {/* Citizen Notes Section */}
          {report.citizenNotes && report.citizenNotes.length > 0 && (
            <div className="bg-[#FAFBF9] dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700/60 p-4 rounded-2xl space-y-2">
              <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Citizen Follow-up Notes ({report.citizenNotes.length})
              </h4>
              <div className="space-y-1.5">
                {report.citizenNotes.map((note, idx) => (
                  <div
                    key={idx}
                    className="text-xs text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900/60 p-2.5 rounded-xl border border-slate-200/80 dark:border-slate-800"
                  >
                    • {note}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Possible Duplicate / Related Reports Suggestions */}
          {(duplicateCandidates.length > 0 || duplicateOf) && (
            <div className="bg-amber-50/70 dark:bg-amber-950/25 border border-amber-200 dark:border-amber-700/40 p-4 rounded-2xl space-y-2.5">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <h4 className="text-[11px] font-bold uppercase tracking-wider text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
                  <Link2 className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                  Possible Overlapping Reports ({duplicateCandidates.length})
                </h4>
                {duplicateOf && (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-mono px-2 py-0.5 rounded-lg bg-amber-100 dark:bg-amber-500/20 text-amber-900 dark:text-amber-200 border border-amber-300 dark:border-amber-500/30 font-semibold">
                      Linked Primary: {duplicateOf}
                    </span>
                    <button
                      type="button"
                      disabled={isReadOnly}
                      onClick={() => {
                        setDuplicateOf('');
                        setFeedbackMessage(null);
                      }}
                      className="text-[11px] text-rose-600 dark:text-rose-300 hover:underline font-semibold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Unlink
                    </button>
                  </div>
                )}
              </div>

              {duplicateCandidates.length > 0 && (
                <div className="space-y-2">
                  {duplicateCandidates.map((cand) => {
                    const isLinked =
                      duplicateOf === cand.report.trackingNumber || duplicateOf === cand.report.id;
                    return (
                      <div
                        key={cand.report.id}
                        className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-white dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5 text-xs"
                      >
                        <div className="min-w-0 space-y-0.5">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono font-bold text-emerald-700 dark:text-emerald-400">
                              {cand.report.trackingNumber}
                            </span>
                            <CivicStatusBadge status={cand.report.status} size="xs" themeMode="auto" />
                            <span className="text-[10px] font-mono text-amber-700 dark:text-amber-300 font-semibold">
                              Match: {cand.score}%
                              {cand.distanceMeters !== null ? ` · ${cand.distanceMeters}m away` : ''}
                            </span>
                          </div>
                          <p className="text-slate-700 dark:text-slate-300 truncate">
                            {cand.report.location.address}
                          </p>
                          <p className="text-[10px] text-slate-500 dark:text-slate-400">
                            {cand.reasons.join(' · ')}
                          </p>
                        </div>
                        <button
                          type="button"
                          disabled={isReadOnly}
                          onClick={() => {
                            setDuplicateOf(
                              isLinked ? '' : cand.report.trackingNumber || cand.report.id
                            );
                            setFeedbackMessage(null);
                          }}
                          className={`px-3 py-1.5 rounded-xl text-[11px] font-semibold shrink-0 cursor-pointer transition disabled:opacity-50 disabled:cursor-not-allowed ${
                            isLinked
                              ? 'bg-amber-600 text-white'
                              : 'bg-amber-100 dark:bg-slate-800 hover:bg-amber-200 dark:hover:bg-slate-700 text-amber-900 dark:text-amber-300 border border-amber-300 dark:border-amber-500/30'
                          }`}
                        >
                          {isLinked ? 'Linked Duplicate' : 'Link as Duplicate'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Timeline History & Immutable Status Audit Trail */}
          <div className="bg-[#FAFBF9] dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700/60 p-4 rounded-2xl space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                <History className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                Status Timeline &amp; History
              </h4>
              {isLoadingHistory && (
                <span className="text-[10px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin text-emerald-600" /> Syncing...
                </span>
              )}
            </div>

            {statusHistory.length > 0 && (
              <div className="space-y-1.5 pb-2.5 border-b border-slate-200 dark:border-slate-700/50">
                <span className="text-[10px] uppercase tracking-wider text-emerald-700 dark:text-emerald-400 font-bold block">
                  Recorded Status History ({statusHistory.length})
                </span>
                <div className="space-y-1.5 max-h-36 overflow-y-auto pr-2">
                  {statusHistory.map((entry) => {
                    const ms = parseReportTimestamp(entry.timestamp);
                    const label =
                      ms > 0
                        ? new Date(ms).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : entry.timestamp || 'Date unavailable';
                    return (
                      <div
                        key={entry.id}
                        className="flex items-start gap-3 text-xs border-l-2 border-emerald-500/60 pl-3 py-1"
                      >
                        <div className="shrink-0 w-28 text-slate-500 dark:text-slate-400 font-mono text-[10px]">
                          {label}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            {entry.fromStatus && (
                              <span className="text-[10px] text-slate-500 dark:text-slate-400">
                                {entry.fromStatus} →
                              </span>
                            )}
                            <CivicStatusBadge status={entry.toStatus} size="xs" themeMode="auto" />
                            <span className="text-slate-700 dark:text-slate-300 text-[11px]">
                              {entry.note}
                            </span>
                          </div>
                          <span className="text-[10px] text-slate-500 block mt-0.5">
                            Updated by: {entry.changedByRole === 'admin' ? 'Municipal Administrator' : 'Citizen'}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="space-y-2.5 max-h-48 overflow-y-auto pr-2">
              {(report.timeline || []).map((event, idx) => {
                const parsedMs = parseReportTimestamp(event.timestamp);
                const formattedTs =
                  parsedMs > 0
                    ? new Date(parsedMs).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : 'Date unavailable';
                const actor = resolveTimelineActor(event, report);
                return (
                  <div
                    key={idx}
                    className="flex items-start gap-3 text-xs border-l-2 border-emerald-400/50 pl-3 py-1"
                  >
                    <div className="shrink-0 w-28 text-slate-500 dark:text-slate-400 font-mono text-[11px]">
                      {formattedTs}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <CivicStatusBadge status={event.status} size="xs" themeMode="auto" />
                        <span className="text-slate-700 dark:text-slate-300">{event.note}</span>
                      </div>
                      <span className="text-[11px] text-slate-500 dark:text-slate-400 block mt-0.5">
                        By: {actor.label}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Administrative Action Form */}
          <form
            onSubmit={handleSaveUpdate}
            className="bg-emerald-50/50 dark:bg-slate-800/80 border border-emerald-200 dark:border-emerald-800/60 rounded-2xl p-4 sm:p-5 space-y-4 shadow-2xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Building className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
                Update Status &amp; Assignment
              </h4>
              {!canAssignDepartmentUi && (
                <span className="text-[11px] text-amber-700 dark:text-amber-300 font-medium">
                  Department reassignment is typically managed by supervisors.
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label
                  htmlFor="admin-complaint-status"
                  className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5"
                >
                  Complaint Status
                </label>
                <select
                  id="admin-complaint-status"
                  value={currentStatus}
                  onChange={(e) => {
                    setCurrentStatus(e.target.value as ReportStatus);
                    setFeedbackMessage(null);
                  }}
                  disabled={isReadOnly || isSubmitting}
                  className="w-full h-10 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl px-3 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600 disabled:opacity-60"
                >
                  {statusOptions.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="admin-assigned-department"
                  className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5"
                >
                  Assigned Department
                </label>
                <select
                  id="admin-assigned-department"
                  value={assignedDepartment}
                  onChange={(e) => {
                    setAssignedDepartment(e.target.value);
                    setFeedbackMessage(null);
                  }}
                  disabled={isReadOnly || isSubmitting || !canAssignDepartmentUi}
                  className="w-full h-10 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl px-3 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600 disabled:opacity-60"
                >
                  {!initialDepartment && (
                    <option value="">Unassigned (Keep Unchanged)</option>
                  )}
                  {departmentOptions.map((dept) => {
                    const isCanonical = (
                      CANONICAL_MUNICIPAL_DEPARTMENTS as readonly string[]
                    ).includes(dept);
                    return (
                      <option key={dept} value={dept}>
                        {isCanonical ? dept : `${dept} (Existing)`}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div>
                <label
                  htmlFor="admin-assigned-officer"
                  className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5"
                >
                  Assigned Officer
                </label>
                <input
                  id="admin-assigned-officer"
                  type="text"
                  value={assignedOfficer}
                  onChange={(e) => {
                    setAssignedOfficer(e.target.value);
                    setFeedbackMessage(null);
                  }}
                  disabled={isReadOnly || isSubmitting}
                  placeholder="e.g. Insp. R. Sharma (Ward 14)"
                  className="w-full h-10 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl px-3 text-xs text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600 disabled:opacity-60"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="admin-official-remarks"
                className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5"
              >
                Official Remarks &amp; Action Notes
              </label>
              <textarea
                id="admin-official-remarks"
                rows={2}
                value={adminRemarks}
                onChange={(e) => {
                  setAdminRemarks(e.target.value);
                  setFeedbackMessage(null);
                }}
                disabled={isReadOnly || isSubmitting}
                placeholder="Enter inspection notes, field team instructions, or action taken..."
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl p-3 text-xs text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600 disabled:opacity-60"
              />
            </div>

            {currentStatus === 'Resolved' && (
              <div>
                <label
                  htmlFor="admin-resolution-summary"
                  className="block text-xs font-bold text-emerald-800 dark:text-emerald-400 mb-1.5"
                >
                  Citizen Resolution Summary (Required &amp; Visible to Citizen)
                </label>
                <textarea
                  id="admin-resolution-summary"
                  rows={2}
                  required
                  value={resolutionDetails}
                  onChange={(e) => {
                    setResolutionDetails(e.target.value);
                    setFeedbackMessage(null);
                  }}
                  disabled={isReadOnly || isSubmitting}
                  placeholder="Explain how the issue was fixed (e.g. road resurfaced, bin cleared, leak repaired)..."
                  className="w-full bg-white dark:bg-slate-900 border border-emerald-400 dark:border-emerald-600/60 rounded-xl p-3 text-xs text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600 disabled:opacity-60"
                />
              </div>
            )}

            {feedbackMessage && (
              <div
                role="status"
                aria-live="polite"
                className={`p-3 rounded-xl border flex items-start gap-2 text-xs ${
                  feedbackMessage.type === 'success'
                    ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
                    : 'bg-rose-50 dark:bg-rose-950/60 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-200'
                }`}
              >
                {feedbackMessage.type === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
                )}
                <span className="font-medium leading-relaxed">{feedbackMessage.text}</span>
              </div>
            )}

            {isArchived ? (
              <p className="text-xs text-slate-600 dark:text-slate-400">
                This complaint has been archived and is read-only.
              </p>
            ) : isWithdrawn ? (
              <p className="text-xs text-slate-600 dark:text-slate-400">
                This complaint was withdrawn by the citizen. Reopen it above if municipal review is required.
              </p>
            ) : null}

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-700/60 transition cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting || isReadOnly || Boolean(concurrentConflict)}
                className="px-5 py-2.5 rounded-2xl bg-[#059669] hover:bg-[#047857] active:bg-[#065F46] text-white text-xs font-bold shadow-md shadow-emerald-900/15 flex items-center gap-2 cursor-pointer disabled:opacity-50 transition"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Saving Update...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Save Update
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
