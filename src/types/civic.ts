export type ExpandedCivicCategory =
  | 'Garbage accumulation'
  | 'Overflowing dustbins'
  | 'Potholes'
  | 'Damaged roads'
  | 'Drainage problems'
  | 'Water leakage'
  | 'Streetlight problems'
  | 'Other civic issues';

export type LegacyCivicCategory =
  | 'Garbage'
  | 'Pothole'
  | 'Water Leakage'
  | 'Drainage'
  | 'Broken Streetlight'
  | 'Other';

export type AnyCivicCategory = ExpandedCivicCategory | LegacyCivicCategory;

export const EXPANDED_CIVIC_CATEGORIES: readonly ExpandedCivicCategory[] = [
  'Garbage accumulation',
  'Overflowing dustbins',
  'Potholes',
  'Damaged roads',
  'Drainage problems',
  'Water leakage',
  'Streetlight problems',
  'Other civic issues',
] as const;

export const LEGACY_CIVIC_CATEGORIES: readonly LegacyCivicCategory[] = [
  'Garbage',
  'Pothole',
  'Water Leakage',
  'Drainage',
  'Broken Streetlight',
  'Other',
] as const;

/**
 * Temporary Phase 1 compatibility alias for unmodified Phase 2 UI screens
 * (e.g. CivicReportsMap CATEGORY_COLORS, ReportIssueScreen dropdown).
 * Backend, storage normalization, stats, and Firestore rules operate on ExpandedCivicCategory.
 */
export type CivicCategory = LegacyCivicCategory;

const LEGACY_TO_EXPANDED_CATEGORY_MAP: Record<LegacyCivicCategory, ExpandedCivicCategory> = {
  Garbage: 'Garbage accumulation',
  Pothole: 'Potholes',
  'Water Leakage': 'Water leakage',
  Drainage: 'Drainage problems',
  'Broken Streetlight': 'Streetlight problems',
  Other: 'Other civic issues',
};

const EXPANDED_TO_LEGACY_CATEGORY_MAP: Record<ExpandedCivicCategory, LegacyCivicCategory> = {
  'Garbage accumulation': 'Garbage',
  'Overflowing dustbins': 'Garbage',
  Potholes: 'Pothole',
  'Damaged roads': 'Pothole',
  'Drainage problems': 'Drainage',
  'Water leakage': 'Water Leakage',
  'Streetlight problems': 'Broken Streetlight',
  'Other civic issues': 'Other',
};

/**
 * Normalizes any raw, legacy (6-category), or expanded (8-category) civic category string
 * into one of the 8 canonical top-level civic categories.
 */
export function normalizeCivicCategory(rawCategory?: string | null): ExpandedCivicCategory {
  const val = typeof rawCategory === 'string' ? rawCategory.trim() : '';
  if (!val) return 'Other civic issues';

  const lower = val.toLowerCase();
  const exactExpanded = EXPANDED_CIVIC_CATEGORIES.find((cat) => cat.toLowerCase() === lower);
  if (exactExpanded) {
    return exactExpanded;
  }

  const exactLegacy = LEGACY_CIVIC_CATEGORIES.find((cat) => cat.toLowerCase() === lower);
  if (exactLegacy) {
    return LEGACY_TO_EXPANDED_CATEGORY_MAP[exactLegacy];
  }

  // Overflowing dustbins (check before general garbage)
  if (
    lower.includes('overflowing') ||
    lower.includes('full bin') ||
    lower.includes('dustbin') ||
    ((lower.includes('bin') || lower.includes('dumpster') || lower.includes('container')) &&
      (lower.includes('overflow') || lower.includes('full') || lower.includes('spill')))
  ) {
    return 'Overflowing dustbins';
  }

  // Garbage accumulation
  if (
    lower.includes('garbage') ||
    lower.includes('waste') ||
    lower.includes('trash') ||
    lower.includes('litter') ||
    lower.includes('rubbish') ||
    lower.includes('bin') ||
    lower.includes('dump')
  ) {
    return 'Garbage accumulation';
  }

  // Potholes (check before general road damage)
  if (lower.includes('pothole') || lower.includes('crater') || lower.includes('sinkhole')) {
    return 'Potholes';
  }

  // Damaged roads
  if (
    lower.includes('damaged road') ||
    lower.includes('road damage') ||
    lower.includes('road crack') ||
    lower.includes('cracked road') ||
    lower.includes('broken road') ||
    lower.includes('uneven road') ||
    lower.includes('asphalt') ||
    lower.includes('pavement crack') ||
    lower.includes('crack')
  ) {
    return 'Damaged roads';
  }

  // Drainage problems (check before water leakage)
  if (
    lower.includes('drain') ||
    lower.includes('sewage') ||
    lower.includes('sewer') ||
    lower.includes('waterlog') ||
    lower.includes('stagnant') ||
    lower.includes('clog') ||
    lower.includes('flood') ||
    lower.includes('gutter') ||
    lower.includes('manhole')
  ) {
    return 'Drainage problems';
  }

  // Water leakage
  if (
    lower.includes('water leak') ||
    lower.includes('pipe') ||
    lower.includes('burst') ||
    lower.includes('leakage') ||
    lower.includes('standpost') ||
    lower.includes('hydrant') ||
    lower.includes('tap leak')
  ) {
    return 'Water leakage';
  }

  // Streetlight problems
  if (
    lower.includes('streetlight') ||
    lower.includes('street light') ||
    lower.includes('light') ||
    lower.includes('lamp') ||
    lower.includes('pole')
  ) {
    return 'Streetlight problems';
  }

  return 'Other civic issues';
}

/**
 * Maps any expanded or legacy category string back to a legacy 6-category value
 * when interfacing with unmodified Phase 1 UI selectors.
 */
export function mapExpandedToLegacyCategory(rawCategory?: string | null): LegacyCivicCategory {
  const expanded = normalizeCivicCategory(rawCategory);
  return EXPANDED_TO_LEGACY_CATEGORY_MAP[expanded];
}

export const CANONICAL_MUNICIPAL_DEPARTMENTS = [
  'Solid Waste Management',
  'Roads & Infrastructure Maintenance',
  'Water Supply & Sewerage Board',
  'Electrical & Street Lighting Department',
  'Stormwater Drainage & Flood Control',
  'Public Health & Sanitation',
  'General Municipal Administration',
] as const;

export type CanonicalMunicipalDepartment = (typeof CANONICAL_MUNICIPAL_DEPARTMENTS)[number];

/**
 * Maps any canonical (8-category) or legacy (6-category) civic category string
 * to its corresponding canonical municipal department used by the Admin interface.
 */
export function getDepartmentForCategory(
  rawCategory?: AnyCivicCategory | string | null
): CanonicalMunicipalDepartment {
  switch (normalizeCivicCategory(rawCategory)) {
    case 'Garbage accumulation':
    case 'Overflowing dustbins':
      return 'Solid Waste Management';
    case 'Potholes':
    case 'Damaged roads':
      return 'Roads & Infrastructure Maintenance';
    case 'Water leakage':
      return 'Water Supply & Sewerage Board';
    case 'Drainage problems':
      return 'Stormwater Drainage & Flood Control';
    case 'Streetlight problems':
      return 'Electrical & Street Lighting Department';
    case 'Other civic issues':
    default:
      return 'General Municipal Administration';
  }
}

/**
 * Reads an existing report's department (`assignedDepartment` first, then `department`).
 * Returns empty string when neither is set rather than silently substituting an unrelated department.
 */
export function resolveReportDepartment(
  report: { assignedDepartment?: string | null; department?: string | null }
): string {
  const assigned =
    typeof report.assignedDepartment === 'string' ? report.assignedDepartment.trim() : '';
  if (assigned) return assigned;
  const base = typeof report.department === 'string' ? report.department.trim() : '';
  return base;
}

const DEPARTMENT_LEGACY_ALIASES: Record<string, CanonicalMunicipalDepartment> = {
  'solid waste management': 'Solid Waste Management',
  'sanitation': 'Solid Waste Management',
  'sanitation & solid waste': 'Solid Waste Management',
  'swm': 'Solid Waste Management',
  'garbage': 'Solid Waste Management',
  'roads & infrastructure maintenance': 'Roads & Infrastructure Maintenance',
  'roads & infrastructure': 'Roads & Infrastructure Maintenance',
  'roads': 'Roads & Infrastructure Maintenance',
  'water supply & sewerage board': 'Water Supply & Sewerage Board',
  'water supply': 'Water Supply & Sewerage Board',
  'water': 'Water Supply & Sewerage Board',
  'electrical & street lighting department': 'Electrical & Street Lighting Department',
  'electrical department': 'Electrical & Street Lighting Department',
  'electrical works': 'Electrical & Street Lighting Department',
  'electrical': 'Electrical & Street Lighting Department',
  'stormwater drainage & flood control': 'Stormwater Drainage & Flood Control',
  'stormwater drainage': 'Stormwater Drainage & Flood Control',
  'drainage': 'Stormwater Drainage & Flood Control',
  'public health & sanitation': 'Public Health & Sanitation',
  'public health': 'Public Health & Sanitation',
  'general municipal administration': 'General Municipal Administration',
  'public grievances cell': 'General Municipal Administration',
  'public works & municipal administration': 'General Municipal Administration',
  'municipal operations': 'General Municipal Administration',
};

/**
 * Normalizes any raw/legacy/missing department name into one of the 7 canonical municipal
 * departments for consistent Department dashboard aggregation and filtering.
 */
export function normalizeToCanonicalDepartment(
  rawDepartment?: string | null,
  categoryHint?: AnyCivicCategory | string | null
): CanonicalMunicipalDepartment {
  const trimmed = typeof rawDepartment === 'string' ? rawDepartment.trim() : '';
  if (trimmed) {
    if ((CANONICAL_MUNICIPAL_DEPARTMENTS as readonly string[]).includes(trimmed)) {
      return trimmed as CanonicalMunicipalDepartment;
    }
    const lower = trimmed.toLowerCase();
    if (DEPARTMENT_LEGACY_ALIASES[lower]) {
      return DEPARTMENT_LEGACY_ALIASES[lower];
    }
    if (lower.includes('waste') || lower.includes('garbage') || lower.includes('dustbin')) {
      return 'Solid Waste Management';
    }
    if (lower.includes('road') || lower.includes('pothole') || lower.includes('infrastructure')) {
      return 'Roads & Infrastructure Maintenance';
    }
    if (lower.includes('drain') || lower.includes('flood') || lower.includes('stormwater')) {
      return 'Stormwater Drainage & Flood Control';
    }
    if (lower.includes('water') || lower.includes('sewer')) {
      return 'Water Supply & Sewerage Board';
    }
    if (lower.includes('electric') || lower.includes('light') || lower.includes('lamp')) {
      return 'Electrical & Street Lighting Department';
    }
    if (lower.includes('health') || lower.includes('sanitation')) {
      return 'Public Health & Sanitation';
    }
  }

  if (categoryHint) {
    return getDepartmentForCategory(categoryHint);
  }
  return 'General Municipal Administration';
}

/**
 * Resolves a report's canonical municipal department from `assignedDepartment`,
 * `department`, or its normalized civic category.
 */
export function resolveReportCanonicalDepartment(
  report: {
    assignedDepartment?: string | null;
    department?: string | null;
    normalizedCategory?: string | null;
    category?: string | null;
  }
): CanonicalMunicipalDepartment {
  const rawDept = resolveReportDepartment(report);
  const categoryHint = report.normalizedCategory || report.category || null;
  return normalizeToCanonicalDepartment(rawDept, categoryHint);
}

export type ActivityActorRole = 'citizen' | 'admin' | 'officer' | 'system' | 'unknown';

export interface ResolvedActivityActor {
  role: ActivityActorRole;
  label: string;
}

/**
 * Determines the accurate actor label (`Citizen`, `Municipal Administrator`,
 * `Municipal Officer`, `System`, or `Unknown actor`) for a complaint timeline event.
 * Never mislabels citizen submissions/withdrawals as `Municipal Officer` and never invents an actor.
 */
export function resolveTimelineActor(
  event: Partial<TimelineEvent>,
  report?: { status?: string; withdrawnAt?: string; assignedOfficer?: string }
): ResolvedActivityActor {
  const rawOfficer = typeof event.officer === 'string' ? event.officer.trim() : '';
  const lowerOfficer = rawOfficer.toLowerCase();
  const note = typeof event.note === 'string' ? event.note.trim() : '';
  const lowerNote = note.toLowerCase();
  const status = typeof event.status === 'string' ? event.status.trim() : '';

  if (rawOfficer) {
    if (lowerOfficer === 'citizen' || lowerOfficer === 'citizen user' || lowerOfficer === 'reporter') {
      return { role: 'citizen', label: 'Citizen' };
    }
    if (lowerOfficer === 'system' || lowerOfficer.includes('ai ')) {
      return { role: 'system', label: 'System' };
    }
    if (
      lowerOfficer === 'municipal administrator' ||
      lowerOfficer === 'admin' ||
      lowerOfficer === 'administrator' ||
      lowerOfficer === 'superadmin'
    ) {
      return { role: 'admin', label: 'Municipal Administrator' };
    }
    if (lowerOfficer === 'municipal officer' || lowerOfficer === 'officer') {
      return { role: 'officer', label: 'Municipal Officer' };
    }
    // Never treat an email address or UID as an unmasked actor label
    if (rawOfficer.includes('@') || /^[a-zA-Z0-9_-]{20,}$/.test(rawOfficer)) {
      return { role: 'admin', label: 'Municipal Administrator' };
    }
    // Named field officer/inspector
    return { role: 'officer', label: `Municipal Officer (${rawOfficer})` };
  }

  // Legacy timeline entries without `officer`: infer strictly from verified event semantics
  if (
    lowerNote.includes('by citizen') ||
    lowerNote.includes('submitted by citizen') ||
    lowerNote.includes('registered by citizen') ||
    lowerNote.includes('withdrawn by citizen') ||
    lowerNote.includes('follow-up') ||
    status === 'Withdrawn'
  ) {
    return { role: 'citizen', label: 'Citizen' };
  }

  if (
    lowerNote.includes('ai photo verification') ||
    lowerNote.includes('photo quality assessment') ||
    lowerNote.includes('automatic') ||
    lowerNote.includes('system')
  ) {
    return { role: 'system', label: 'System' };
  }

  if (
    status === 'Submitted' &&
    (lowerNote.includes('via civifix') ||
      lowerNote.includes('via mobile') ||
      lowerNote.includes('saved offline') ||
      lowerNote.includes('complaint submitted'))
  ) {
    return { role: 'citizen', label: 'Citizen' };
  }

  if (
    lowerNote.includes('status updated from') ||
    lowerNote.includes('updated by administrator') ||
    lowerNote.includes('updated via municipal') ||
    lowerNote.includes('admin')
  ) {
    return { role: 'admin', label: 'Municipal Administrator' };
  }

  if (
    lowerNote.includes('assigned') ||
    lowerNote.includes('resolution') ||
    report?.assignedOfficer
  ) {
    if (status === 'Assigned' || status === 'In Progress' || status === 'Resolved' || status === 'Rejected' || status === 'Under Review') {
      return { role: 'admin', label: 'Municipal Administrator' };
    }
  }

  return { role: 'unknown', label: 'Unknown actor' };
}

/**
 * Maps an `/auditLogs` entry into a safe, human-readable actor label without leaking UIDs or emails.
 */
export function resolveAuditLogActor(log: Partial<AuditLogEntry>): ResolvedActivityActor {
  if (log.action === 'report_created' || log.action === 'report_withdrawn' || log.actorRole === 'citizen') {
    return { role: 'citizen', label: 'Citizen' };
  }
  if (
    log.action === 'admin_status_change' ||
    log.action === 'admin_note_update' ||
    log.action === 'duplicate_linked' ||
    log.action === 'duplicate_unlinked' ||
    log.action === 'report_archived' ||
    log.action === 'report_reopened' ||
    log.actorRole === 'admin'
  ) {
    const officerMeta =
      log.metadata && typeof log.metadata.assignedOfficer === 'string'
        ? log.metadata.assignedOfficer.trim()
        : '';
    if (officerMeta && !officerMeta.includes('@')) {
      return { role: 'admin', label: `Municipal Administrator · Officer: ${officerMeta}` };
    }
    return { role: 'admin', label: 'Municipal Administrator' };
  }
  return { role: 'unknown', label: 'Unknown actor' };
}

/**
 * Returns the selectable department options for the Admin UI, preserving any
 * non-canonical/legacy/custom existing department value without defaulting to Solid Waste Management.
 */
export function buildDepartmentSelectOptions(existingDepartment?: string | null): string[] {
  const trimmed = typeof existingDepartment === 'string' ? existingDepartment.trim() : '';
  if (
    trimmed &&
    !(CANONICAL_MUNICIPAL_DEPARTMENTS as readonly string[]).includes(trimmed)
  ) {
    return [trimmed, ...CANONICAL_MUNICIPAL_DEPARTMENTS];
  }
  return [...CANONICAL_MUNICIPAL_DEPARTMENTS];
}

/**
 * Returns `undefined` when the admin has not explicitly changed the department,
 * preventing unrelated edits (remarks, officer, status, resolution) from overwriting it.
 */
export function resolveDepartmentUpdateArg(
  initialDepartment: string,
  selectedDepartment: string
): string | undefined {
  const initialTrimmed = (initialDepartment || '').trim();
  const selectedTrimmed = (selectedDepartment || '').trim();
  if (selectedTrimmed === initialTrimmed) {
    return undefined;
  }
  return selectedTrimmed;
}

/**
 * Distinguishes an unchanged duplicate reference from an explicit link/unlink action.
 * Returns `undefined` when unchanged so unrelated updates preserve existing Firestore links,
 * returns `""` when explicitly unlinked, and returns the trimmed reference when linked.
 */
export function resolveDuplicateOfUpdateArg(
  initialDuplicateOf?: string | null,
  selectedDuplicateOf?: string | null
): string | undefined {
  const initialTrimmed = (initialDuplicateOf || '').trim();
  const selectedTrimmed = (selectedDuplicateOf || '').trim();
  if (selectedTrimmed === initialTrimmed) {
    return undefined;
  }
  return selectedTrimmed;
}

/**
 * Returns `undefined` when an optional text field (officer, remarks, resolution details)
 * is unchanged relative to baseline, preventing unrelated edits from overwriting concurrent updates.
 * Returns the trimmed string (including `""` if explicitly cleared) when modified.
 */
export function resolveOptionalStringUpdateArg(
  initialValue?: string | null,
  currentValue?: string | null
): string | undefined {
  const initialTrimmed = (initialValue || '').trim();
  const currentTrimmed = (currentValue || '').trim();
  if (currentTrimmed === initialTrimmed) {
    return undefined;
  }
  return currentTrimmed;
}

export type CivicCategoryIconKey =
  | 'garbage'
  | 'dustbin'
  | 'pothole'
  | 'road'
  | 'water'
  | 'drainage'
  | 'streetlight'
  | 'other';

/**
 * Maps any raw, legacy (6-category), or canonical (8-category) string
 * to a consistent icon key using normalizeCivicCategory().
 */
export function getCivicCategoryIconKey(rawCategory?: string | null): CivicCategoryIconKey {
  switch (normalizeCivicCategory(rawCategory)) {
    case 'Garbage accumulation':
      return 'garbage';
    case 'Overflowing dustbins':
      return 'dustbin';
    case 'Potholes':
      return 'pothole';
    case 'Damaged roads':
      return 'road';
    case 'Water leakage':
      return 'water';
    case 'Drainage problems':
      return 'drainage';
    case 'Streetlight problems':
      return 'streetlight';
    case 'Other civic issues':
    default:
      return 'other';
  }
}

export interface CitizenReportVisibilityMeta {
  assignedDepartment: string | null;
  assignedOfficer: string | null;
  adminRemarks: string | null;
  duplicateOf: string | null;
  linkedDuplicateReport: CivicIssueReport | null;
  hasMunicipalAssignment: boolean;
  hasResolutionEvidence: boolean;
}

/**
 * Extracts citizen-visible municipal tracking metadata safely from a report.
 * Returns null for optional fields when empty/missing so the UI never renders empty placeholders.
 */
export function resolveCitizenReportVisibility(
  report?: Partial<CivicIssueReport> | null,
  allUserReports: CivicIssueReport[] = []
): CitizenReportVisibilityMeta {
  if (!report) {
    return {
      assignedDepartment: null,
      assignedOfficer: null,
      adminRemarks: null,
      duplicateOf: null,
      linkedDuplicateReport: null,
      hasMunicipalAssignment: false,
      hasResolutionEvidence: false,
    };
  }

  const resolvedDept = resolveReportDepartment({
    assignedDepartment: report.assignedDepartment,
    department: report.department,
  });
  const assignedDepartment = resolvedDept || null;
  const assignedOfficer =
    typeof report.assignedOfficer === 'string' && report.assignedOfficer.trim()
      ? report.assignedOfficer.trim()
      : null;
  const adminRemarks =
    typeof report.adminRemarks === 'string' && report.adminRemarks.trim()
      ? report.adminRemarks.trim()
      : null;
  const duplicateOf =
    typeof report.duplicateOf === 'string' && report.duplicateOf.trim()
      ? report.duplicateOf.trim()
      : null;

  const linkedDuplicateReport = duplicateOf
    ? allUserReports.find(
        (candidate) =>
          candidate &&
          candidate.id !== report.id &&
          (candidate.trackingNumber === duplicateOf || candidate.id === duplicateOf)
      ) || null
    : null;

  const hasResolutionEvidence = Boolean(
    (typeof report.resolutionDetails === 'string' && report.resolutionDetails.trim()) ||
      (typeof report.resolutionPhotoUrl === 'string' && report.resolutionPhotoUrl.trim()) ||
      (typeof report.resolvedAt === 'string' && report.resolvedAt.trim())
  );

  return {
    assignedDepartment,
    assignedOfficer,
    adminRemarks,
    duplicateOf,
    linkedDuplicateReport,
    hasMunicipalAssignment: Boolean(assignedDepartment || assignedOfficer),
    hasResolutionEvidence,
  };
}

export type ReportSeverity = 'Minor' | 'Moderate' | 'High' | 'Hazard' | 'Low' | 'Medium';

export type PriorityTier = 'Critical' | 'High' | 'Standard' | 'Low';

/**
 * Pure numeric severity ranking helper (higher = more urgent).
 * Safely supports both legacy ('Minor' | 'Moderate') and canonical severities.
 */
export function getSeverityPriorityScore(severity?: ReportSeverity | string | null): number {
  switch (severity) {
    case 'Hazard':
      return 4;
    case 'High':
      return 3;
    case 'Medium':
    case 'Moderate':
      return 2;
    case 'Low':
    case 'Minor':
    default:
      return 1;
  }
}

/**
 * Derives a non-mutating operational priority tier from existing report severity.
 * Never silently alters the stored `severity` field.
 */
export function derivePriorityTier(severity?: ReportSeverity | string | null): PriorityTier {
  const score = getSeverityPriorityScore(severity);
  if (score >= 4) return 'Critical';
  if (score === 3) return 'High';
  if (score === 2) return 'Standard';
  return 'Low';
}

/**
 * Parses an existing SLA string (e.g., "24h", "48 Hours Standard SLA", "72 Hours")
 * into numeric hours, or returns null when no numeric hour target is present.
 * Does not invent arbitrary deadlines.
 */
export function parseSlaHours(slaDeadline?: string | null): number | null {
  if (!slaDeadline || typeof slaDeadline !== 'string') return null;
  const match = slaDeadline.trim().match(/^(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export type ReportStatus =
  | 'Submitted'
  | 'Under Review'
  | 'Assigned'
  | 'In Progress'
  | 'Resolved'
  | 'Rejected'
  | 'Withdrawn';

export const VALID_REPORT_STATUSES: readonly ReportStatus[] = [
  'Submitted',
  'Under Review',
  'Assigned',
  'In Progress',
  'Resolved',
  'Rejected',
] as const;

export const ALL_REPORT_STATUSES: readonly ReportStatus[] = [
  ...VALID_REPORT_STATUSES,
  'Withdrawn',
] as const;

/**
 * Normalizes raw report status to canonical statuses.
 * Safely preserves Withdrawn status and prevents older or missing statuses from being discarded.
 */
export function normalizeReportStatus(rawStatus: unknown): ReportStatus {
  if (typeof rawStatus === 'string') {
    const trimmed = rawStatus.trim();
    if (trimmed === 'Withdrawn' || trimmed.toLowerCase() === 'withdrawn') {
      return 'Withdrawn';
    }
    if ((VALID_REPORT_STATUSES as readonly string[]).includes(trimmed)) {
      return trimmed as ReportStatus;
    }
    const lower = trimmed.toLowerCase();
    if (lower === 'submitted' || lower === 'pending') return 'Submitted';
    if (lower === 'under review' || lower === 'under_review' || lower === 'review') return 'Under Review';
    if (lower === 'assigned') return 'Assigned';
    if (lower === 'in progress' || lower === 'in_progress' || lower === 'progress') return 'In Progress';
    if (lower === 'resolved' || lower === 'completed' || lower === 'closed') return 'Resolved';
    if (lower === 'rejected' || lower === 'declined' || lower === 'cancelled') return 'Rejected';
    if (lower === 'withdrawn') return 'Withdrawn';
  }
  return 'Submitted';
}

export interface TimelineEvent {
  status: ReportStatus;
  timestamp: string;
  note: string;
  officer?: string;
}

export interface AiAnalysisResult {
  suggestedCategory: CivicCategory;
  suggestedExpandedCategory?: ExpandedCivicCategory;
  categoryMatch: boolean;
  severity: 'Low' | 'Medium' | 'High';
  suggestedSeverity?: 'Low' | 'Medium' | 'High';
  severityReason?: string;
  detectedIssueType?: string;
  shortExplanation?: string;
  suggestedTitle?: string;
  suggestedDescription?: string;
  confidence: string | null; // null triggers "confidence not measured" in UI
  confidenceLevel?: 'Low' | 'Medium' | 'High' | null;
  aiNotes: string;
  isFallback: boolean;
}

export type VerificationDecision =
  | 'VALID_CIVIC_ISSUE'
  | 'UNRELATED_IMAGE'
  | 'UNCLEAR_IMAGE'
  | 'POSSIBLE_CIVIC_ISSUE_NEEDS_REVIEW';

export interface CivicIssueBoundingBox {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
  label?: string;
}

export interface DetectedWasteBox {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
  label?: string;
}

export interface CleanupVisualizationResult {
  identifiedIssues: string[];
  recommendedActions: string[];
  environmentalBenefit: string;
  visualizedImageUrl: string;
  disclaimer: string;
  timestamp: string;
  category?: string;
  issueSubType?: string;
  isCleanArea?: boolean;
  isRegionClear?: boolean;
  isUnavailable?: boolean;
  unavailableReason?: string;
  unclearReason?: string;
  detectedBoxes?: DetectedWasteBox[];
  maskCoveragePercent?: number;
  transformationMethod?: 'image-to-image-model' | 'grounded-inpainting' | 'scene-already-clean' | 'withheld-unclear-mask' | 'unavailable';
  canRetry?: boolean;
  error?: string;
  verification?: {
    passed: boolean;
    modelUsed: string;
    transformationMethod?: string;
    similarityScore: number;
    correlation: number;
    psnr: number;
    scenePreserved: boolean;
    wasteRemoved: boolean;
    wasteRegionDifference?: number;
    unaffectedRegionRetention?: number;
    artifactsDetected?: boolean;
    hallucinationsDetected?: boolean;
    verificationNotes: string;
  };
}

export type ConfidenceBand = 'High' | 'Moderate' | 'Uncertain';

export interface CivicImageVerificationResult {
  decision: VerificationDecision;
  isCivicIssue: boolean | 'uncertain';
  issueDetected: string;
  primaryCategory: AnyCivicCategory | 'Unrelated / Non-Civic';
  visualSubType?: string;
  secondaryCategories?: AnyCivicCategory[];
  detectedObjects: string[];
  detectedBoxes?: CivicIssueBoundingBox[];
  visualEvidence: string;
  visibleObservations?: string[];
  aiAssumptions?: string[];
  potentialPublicImpact?: string;
  explanation: string;
  shortExplanation?: string;
  detectedIssueType?: string;
  suggestedSeverity?: 'Low' | 'Medium' | 'High';
  severityReason?: string;
  suggestedTitle?: string;
  suggestedDescription?: string;
  citizenStatusMessage?: string;
  recommendedActions: string[];
  safetyPrecautions: string;
  confidence: string | null;
  confidenceLevel?: 'Low' | 'Medium' | 'High' | null;
  confidenceBand?: ConfidenceBand;
  imageQuality: {
    rating: 'Good' | 'Acceptable' | 'Needs Attention';
    isBlurry: boolean;
    isDark: boolean;
    isOverexposed: boolean;
    isPoorVisibility?: boolean;
    blurScore?: number;
    brightness?: number;
    contrastStd?: number;
  };
  duplicateMatchTrackingNumber?: string | null;
  beforeAfterEligible?: boolean;
  requiresHumanReview: boolean;
  rejectionReason?: string | null;
  canProceedToSubmit: boolean;
  isFallback: boolean;
  modelUsed: string;
  timestamp: string;
}

export type LocationSource = 'gps' | 'map_pin' | 'manual';

export type FirestoreTimestampLike =
  | string
  | Date
  | { toDate: () => Date; seconds?: number; nanoseconds?: number }
  | { seconds: number; nanoseconds?: number }
  | { _seconds: number; _nanoseconds?: number };

export interface CivicIssueReport {
  id: string;
  trackingNumber: string;
  /** Runtime stores normalized 8-category value; typed as CivicCategory temporarily until Phase 2 updates UI maps. */
  category: CivicCategory;
  normalizedCategory?: ExpandedCivicCategory;
  title: string;
  description: string;
  photoUrl: string;
  /** Legacy optional field retained solely for safe backward-compatible reading of older records */
  afterPhotoUrl?: string;
  location: {
    address: string;
    landmark?: string;
    latitude: number | null;
    longitude: number | null;
    ward: string;
    locationSource?: LocationSource;
  };
  severity: ReportSeverity;
  status: ReportStatus;
  submittedAt: string;
  updatedAt: string;
  department: string;
  slaDeadline: string;
  timeline: TimelineEvent[];
  citizenNotes?: string[];
  isDemo?: boolean;
  userId?: string;
  citizenName?: string;
  citizenEmail?: string;
  syncedToCloud?: boolean;
  storageSource?: 'firestore' | 'local_fallback';
  aiAnalysis?: AiAnalysisResult;
  imageVerification?: CivicImageVerificationResult;
  // Administrative fields
  adminRemarks?: string;
  assignedOfficer?: string;
  assignedDepartment?: string;
  resolutionDetails?: string;
  resolutionPhotoUrl?: string;
  resolvedAt?: string;
  updatedBy?: string;
  duplicateOf?: string;
  // Citizen withdrawal fields
  withdrawnAt?: string;
  withdrawnBy?: string;
  withdrawalReason?: string;
  // Administrative archive (soft-delete) fields
  archived?: boolean;
  archivedAt?: FirestoreTimestampLike;
  archivedBy?: string;
  archiveReason?: string;
}

export interface StatusHistoryEntry {
  id: string;
  reportId: string;
  fromStatus: ReportStatus | null;
  toStatus: ReportStatus;
  changedByUid: string;
  changedByEmail?: string;
  changedByRole: 'citizen' | 'admin';
  note: string;
  timestamp: string;
}

export interface AuditLogEntry {
  id: string;
  action:
    | 'report_created'
    | 'report_withdrawn'
    | 'admin_status_change'
    | 'admin_note_update'
    | 'duplicate_linked'
    | 'duplicate_unlinked'
    | 'report_archived'
    | 'report_reopened';
  targetType: 'civic_report';
  targetId: string;
  actorUid: string;
  actorRole: 'citizen' | 'admin';
  summary: string;
  timestamp: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export type AdminRole = 'superadmin' | 'department_head' | 'ward_admin' | 'staff';

export const VALID_ADMIN_ROLES: readonly AdminRole[] = [
  'superadmin',
  'department_head',
  'ward_admin',
  'staff',
] as const;

/**
 * Normalizes a raw admin role claim or `/admins/{uid}` role value into one of
 * the four canonical municipal roles. Never grants authorization by itself.
 */
export function normalizeAdminRole(
  rawRole: unknown,
  fallbackRole: AdminRole = 'staff'
): AdminRole {
  if (typeof rawRole === 'string') {
    const normalized = rawRole.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if ((VALID_ADMIN_ROLES as readonly string[]).includes(normalized)) {
      return normalized as AdminRole;
    }
  }
  return fallbackRole;
}

export interface AdminRoleCapabilities {
  canManageAdmins: boolean;
  canViewAllWards: boolean;
  canAssignDepartment: boolean;
  canUpdateReportStatus: boolean;
  canViewAuditLogs: boolean;
  canArchiveReports: boolean;
  canReopenWithdrawn: boolean;
}

/**
 * Application-layer capability matrix for all four administrative roles.
 * NOTE: `firestore.rules` enforces active verified `isAdmin()` access on the database.
 */
export const ADMIN_ROLE_CAPABILITIES: Record<AdminRole, AdminRoleCapabilities> = {
  superadmin: {
    canManageAdmins: true,
    canViewAllWards: true,
    canAssignDepartment: true,
    canUpdateReportStatus: true,
    canViewAuditLogs: true,
    canArchiveReports: true,
    canReopenWithdrawn: true,
  },
  department_head: {
    canManageAdmins: false,
    canViewAllWards: true,
    canAssignDepartment: true,
    canUpdateReportStatus: true,
    canViewAuditLogs: true,
    canArchiveReports: true,
    canReopenWithdrawn: true,
  },
  ward_admin: {
    canManageAdmins: false,
    canViewAllWards: false,
    canAssignDepartment: true,
    canUpdateReportStatus: true,
    canViewAuditLogs: false,
    canArchiveReports: false,
    canReopenWithdrawn: true,
  },
  staff: {
    canManageAdmins: false,
    canViewAllWards: false,
    canAssignDepartment: false,
    canUpdateReportStatus: true,
    canViewAuditLogs: false,
    canArchiveReports: false,
    canReopenWithdrawn: false,
  },
};

export interface AdminUser {
  uid: string;
  email: string;
  displayName?: string;
  role: AdminRole;
  department?: string;
  ward?: string;
  createdAt?: string;
}

export interface AdminStats {
  totalReports: number;
  pendingReports: number;
  inProgressReports: number;
  resolvedReports: number;
  rejectedReports: number;
  withdrawnReports: number;
  highSeverityReports: number;
  avgResolutionHours: number | null;
  categoryDistribution: Record<ExpandedCivicCategory, number> & Record<string, number>;
  wardDistribution: Record<string, number>;
  statusDistribution: Record<ReportStatus, number>;
}

export interface CitizenSummary {
  id: string;
  name: string;
  email: string;
  phone: string;
  ward: string;
  totalReports: number;
  resolvedReports: number;
  firstReportDate?: string;
  latestReportDate?: string;
}

export interface CitizenUser {
  id: string;
  fullName: string;
  phone: string;
  email: string;
  emailVerified?: boolean;
  authProvider?: string;
  ward: string;
  city: string;
  reportsCount: number;
  resolvedCount: number;
  notificationPreferences: {
    smsAlerts: boolean;
    pushNotifications: boolean;
    emailUpdates: boolean;
  };
  avatarUrl?: string;
  avatarColor?: string;
  preferredLanguage?: string;
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'assistant';
  text: string;
  timestamp: string;
  isPrototype?: boolean;
  isFallback?: boolean;
  fallbackTopic?: string;
  suggestedAction?: 'report' | 'my_reports' | null;
}
