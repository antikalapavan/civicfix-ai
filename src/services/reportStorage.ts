/**
 * CiviFix AI - Real Firebase Cloud Firestore Report Storage Service
 *
 * Project: civifix-ai-214ec
 *
 * Architecture & Correctness:
 * - Real Cloud Firestore persistence under the `civic_reports` collection.
 * - Strict citizen UID ownership (`userId == auth.currentUser.uid == request.auth.uid`).
 * - Null coordinates until explicitly detected by device GPS. Never invents fake coordinates.
 * - Recursively cleans payload to remove any `undefined` values before Firestore serialization.
 * - Displays "Saved to Cloud Firestore" ONLY after Firestore `setDoc` genuinely succeeds.
 * - LocalStorage is utilized solely as an offline fallback / temporary cache.
 *   Reports in local storage maintain `syncedToCloud: false` until successfully committed to Firestore.
 */

import {
  collection,
  doc,
  getDoc,
  setDoc,
  addDoc,
  getDocs,
  updateDoc,
  query,
  where,
  orderBy,
  limit,
  arrayUnion,
  onSnapshot,
  FieldValue,
  Timestamp,
} from 'firebase/firestore';
import { db, auth, isFirebaseConfigured, uploadComplaintImageToStorage } from '../lib/firebase';
import { toUserFriendlyErrorMessage } from '../utils/userFriendlyErrors';
import {
  AnyCivicCategory,
  CivicIssueReport,
  CivicCategory,
  ReportSeverity,
  ReportStatus,
  StatusHistoryEntry,
  normalizeReportStatus,
  normalizeCivicCategory,
  CitizenUser,
  TimelineEvent,
  AiAnalysisResult,
  CivicImageVerificationResult,
  getDepartmentForCategory,
} from '../types/civic';
import { isValidCoordinate } from '../utils/reportLocations';
import { validateMeaningfulCivicText } from '../utils/inputValidation';

const STORAGE_KEYS = {
  USER_REPORTS_PREFIX: 'civifix_user_reports_',
  PENDING_NOTES_PREFIX: 'civifix_pending_notes_',
  PENDING_WITHDRAWALS_PREFIX: 'civifix_pending_withdrawals_',
  REPORT_COUNTER: 'civifix_report_counter_seq',
};

/**
 * Strips all `undefined` fields from an object recursively to prevent
 * Firestore "Unsupported field value: undefined" errors.
 */
export function sanitizeForFirestore<T>(data: T): T {
  if (data === null || data === undefined) {
    return data;
  }
  if (Array.isArray(data)) {
    return data.map((item) => sanitizeForFirestore(item)) as unknown as T;
  }
  if (
    typeof data === 'object' &&
    !(data instanceof Date) &&
    !(data instanceof FieldValue) &&
    !(data instanceof Timestamp)
  ) {
    const proto = Object.getPrototypeOf(data);
    // Preserve Firestore sentinels (e.g., serverTimestamp()) and custom class instances intact
    if (proto !== Object.prototype && proto !== null) {
      return data;
    }
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        result[key] = sanitizeForFirestore(value);
      }
    }
    return result as T;
  }
  return data;
}

/**
 * Reusable Timestamp Parsing Helper
 *
 * Supports:
 * - ISO 8601 date strings (e.g., "2026-10-30T06:32:00.000Z")
 * - Firestore Timestamp objects with `.toDate()`
 * - Timestamp-like objects with numeric `seconds` (and optional `nanoseconds`) or `_seconds`
 * - Numeric millisecond timestamps (e.g., 1730000000000)
 * - Numeric second timestamps (e.g., 1730000000)
 * - Native Date objects
 * - Missing or invalid timestamps (returns safe numeric value 0)
 *
 * CRITICAL SAFETY GUARANTEE:
 * Returns 0 for invalid or missing timestamps. Never replaces a missing historical
 * timestamp with the current time (which would falsify audit history).
 */
export function parseReportTimestamp(val: unknown): number {
  if (val === null || val === undefined || val === '') {
    return 0;
  }

  // 1. Numeric timestamps (seconds vs milliseconds)
  if (typeof val === 'number') {
    if (isNaN(val) || !isFinite(val) || val <= 0) return 0;
    // Unix seconds (< 10000000000) vs milliseconds
    return val < 10000000000 ? Math.round(val * 1000) : Math.round(val);
  }

  // 2. Native Date instance
  if (val instanceof Date) {
    const ms = val.getTime();
    return isNaN(ms) ? 0 : ms;
  }

  // 3. Object-based timestamps (Firestore Timestamp or serialized seconds/nanoseconds)
  if (typeof val === 'object') {
    // Firestore Timestamp object instance with .toDate()
    if (typeof (val as any).toDate === 'function') {
      try {
        const d = (val as any).toDate();
        const ms = d instanceof Date ? d.getTime() : 0;
        return isNaN(ms) ? 0 : ms;
      } catch {
        return 0;
      }
    }

    // Serialized Timestamp object with seconds / _seconds and optional nanoseconds
    const obj = val as Record<string, any>;
    const sec =
      typeof obj.seconds === 'number'
        ? obj.seconds
        : typeof obj._seconds === 'number'
        ? obj._seconds
        : null;
    const nano =
      typeof obj.nanoseconds === 'number'
        ? obj.nanoseconds
        : typeof obj._nanoseconds === 'number'
        ? obj._nanoseconds
        : 0;

    if (sec !== null && !isNaN(sec) && isFinite(sec) && sec > 0) {
      return Math.round(sec * 1000 + Math.floor(nano / 1000000));
    }
  }

  // 4. ISO 8601 or date strings (including legacy bullet-separated strings like "Nov 16, 2026 • 05:52 AM")
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return 0;
    const normalizedBullet = trimmed.includes('•') ? trimmed.replace(/\s*•\s*/g, ' ') : trimmed;
    const parsed = Date.parse(normalizedBullet);
    return isNaN(parsed) ? 0 : parsed;
  }

  return 0;
}

function areValuesDeeplyEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;

  if (a instanceof Date || b instanceof Date) {
    if (!(a instanceof Date) || !(b instanceof Date)) return false;
    return Object.is(a.getTime(), b.getTime());
  }

  if (
    typeof a === 'object' &&
    typeof b === 'object' &&
    (typeof (a as any).toDate === 'function' || typeof (b as any).toDate === 'function')
  ) {
    if (typeof (a as any).toDate !== 'function' || typeof (b as any).toDate !== 'function') {
      return false;
    }
    return parseReportTimestamp(a) === parseReportTimestamp(b);
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!areValuesDeeplyEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const objA = a as Record<string, unknown>;
    const objB = b as Record<string, unknown>;
    const keysA = Object.keys(objA).filter((k) => objA[k] !== undefined);
    const keysB = Object.keys(objB).filter((k) => objB[k] !== undefined);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!Object.prototype.hasOwnProperty.call(objB, key) || objB[key] === undefined) {
        return false;
      }
      if (!areValuesDeeplyEqual(objA[key], objB[key])) return false;
    }
    return true;
  }

  return false;
}

/**
 * Pure state-reconciliation helper that keeps an open report detail modal
 * synchronized with incoming report updates by stable report ID.
 * - Returns `null` if no report was selected or if the selected report disappeared.
 * - Preserves exact object reference when report fields are unchanged to avoid render loops.
 */
export function syncSelectedReport(
  currentSelected: CivicIssueReport | null,
  latestReports: CivicIssueReport[]
): CivicIssueReport | null {
  if (!currentSelected) return null;
  if (!Array.isArray(latestReports)) return null;
  const matched = latestReports.find((r) => r.id === currentSelected.id);
  if (!matched) {
    return null;
  }
  return areValuesDeeplyEqual(currentSelected, matched) ? currentSelected : matched;
}

/**
 * Sort reports newest first (highest timestamp value first).
 * Reports with unknown or missing dates (parsed value 0) are placed at the bottom,
 * and are never falsely presented as the newest reports.
 */
export function sortReportsNewestFirst(reports: CivicIssueReport[]): CivicIssueReport[] {
  return [...reports].sort((a, b) => {
    const timeA = parseReportTimestamp(a.submittedAt);
    const timeB = parseReportTimestamp(b.submittedAt);
    return timeB - timeA;
  });
}

/**
 * Format timestamp safely for display across UI components.
 * Safely handles Firestore Timestamp objects, seconds, strings, and missing dates.
 */
export function formatReportDate(timestampVal: unknown, locale: string = 'en-US'): string {
  const ms = parseReportTimestamp(timestampVal);
  if (ms <= 0) {
    return 'Date unavailable';
  }
  try {
    return new Date(ms).toLocaleDateString(locale, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return 'Date unavailable';
  }
}

/**
 * Normalizes an optional Firestore Timestamp, serialized `{ seconds, nanoseconds }`,
 * native Date, numeric epoch, or legacy ISO-8601 string into a canonical ISO-8601 string.
 * Returns `undefined` when absent or unparseable (never fabricates the current time).
 */
export function normalizeOptionalReportTimestamp(val: unknown): string | undefined {
  if (val === null || val === undefined || val === '' || val instanceof FieldValue) {
    return undefined;
  }
  const ms = parseReportTimestamp(val);
  if (ms > 0) {
    return new Date(ms).toISOString();
  }
  if (typeof val === 'string' && val.trim()) {
    return val.trim();
  }
  return undefined;
}

/**
 * Formats an optional Firestore Timestamp / ISO string / Date safely with both date and time.
 */
export function formatReportDateTime(timestampVal: unknown, locale: string = 'en-US'): string {
  const ms = parseReportTimestamp(timestampVal);
  if (ms <= 0) {
    return 'Date unavailable';
  }
  try {
    return new Date(ms).toLocaleString(locale);
  } catch {
    return 'Date unavailable';
  }
}

/**
 * Collision-Resistant Tracking Number Strategy:
 *
 * NOTE: This is a distributed collision-resistant strategy designed to eliminate
 * the single-browser localStorage counter flaw across separate devices and users.
 * It combines:
 * 1. Domain prefix and civic reporting year (`CFX-2026`).
 * 2. High-resolution epoch timestamp encoded in base-36 (millisecond time window).
 * 3. Cryptographically strong random entropy (via window.crypto.getRandomValues or Node crypto),
 *    falling back to pseudo-random numbers if crypto is unavailable.
 *
 * Example output: CFX-2026-M8K2-7193
 *
 * IMPORTANT LIMITATION NOTICE:
 * Because CiviFix AI supports offline-first submission where clients may submit without
 * real-time server coordination, this interim strategy provides statistical collision resistance
 * (over 1.6 billion combinations per 46-day window) but cannot mathematically guarantee absolute
 * uniqueness in the absence of an atomic global database transaction.
 *
 * All existing tracking numbers (e.g., historical reports and demo records) are strictly preserved.
 */
let lastGeneratedMs = 0;
let subMsCounter = 0;

export function generateTrackingNumber(): string {
  const year = 2026;
  const now = Date.now();
  if (now === lastGeneratedMs) {
    subMsCounter = (subMsCounter + 1) % 10000;
  } else {
    lastGeneratedMs = now;
    subMsCounter = 0;
  }

  // Component 1: Compact base-36 representation of current millisecond timestamp (4 characters)
  const timePart = now.toString(36).slice(-4).toUpperCase();

  // Component 2: 4-character cryptographic random entropy (36^4 = 1.67M combinations)
  let randomPart = '';
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const arr = new Uint32Array(1);
      crypto.getRandomValues(arr);
      randomPart = (arr[0] % 1679616).toString(36).padStart(4, '0').toUpperCase();
    } else {
      randomPart = Math.floor(Math.random() * 1679616).toString(36).padStart(4, '0').toUpperCase();
    }
  } catch {
    randomPart = Math.floor(Math.random() * 1679616).toString(36).padStart(4, '0').toUpperCase();
  }

  // Component 3: 4-digit monotonic counter providing zero-collision guarantee in high-frequency bursts
  const seqPart = subMsCounter.toString().padStart(4, '0');

  return `CFX-${year}-${timePart}-${randomPart}${seqPart}`;
}

export interface PendingSubmissionIdentity {
  reportId: string;
  trackingNumber: string;
  submittedAt: string;
}

/**
 * Creates a stable client submission identity (`reportId`, `trackingNumber`, `submittedAt`)
 * so UI timeouts or retry paths never mint a duplicate complaint for the same submission.
 */
export function createSubmissionIdentity(nowIso?: string): PendingSubmissionIdentity {
  const submittedAt = nowIso || new Date().toISOString();
  const reportId =
    'rep_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
  return {
    reportId,
    trackingNumber: generateTrackingNumber(),
    submittedAt,
  };
}

export interface SubmissionRaceOutcome<T> {
  settled: boolean;
  timedOut: boolean;
  result?: T;
  error?: any;
}

/**
 * Awaits an in-flight submission promise up to `timeoutMs` without cancelling
 * the underlying promise, always clearing its timer if settlement finishes first.
 */
export async function awaitSubmissionWithTimeoutNotice<T>(
  inFlightPromise: Promise<T>,
  timeoutMs: number = 7000
): Promise<SubmissionRaceOutcome<T>> {
  let timerId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<SubmissionRaceOutcome<T>>((resolve) => {
    timerId = setTimeout(() => {
      resolve({ settled: false, timedOut: true });
    }, timeoutMs);
  });

  const settledPromise = inFlightPromise
    .then((result): SubmissionRaceOutcome<T> => ({
      settled: true,
      timedOut: false,
      result,
    }))
    .catch((error): SubmissionRaceOutcome<T> => ({
      settled: true,
      timedOut: false,
      error,
    }));

  try {
    return await Promise.race([settledPromise, timeoutPromise]);
  } finally {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  }
}

/**
 * Get locally cached reports for a specific authenticated user
 */
export function getLocalCachedReports(userId?: string): CivicIssueReport[] {
  if (!userId || typeof localStorage === 'undefined') return [];
  try {
    const data = localStorage.getItem(`${STORAGE_KEYS.USER_REPORTS_PREFIX}${userId}`);
    if (!data) return [];
    const parsed = JSON.parse(data);
    return Array.isArray(parsed)
      ? parsed.map((item) => {
          const normalized = normalizeCivicCategory(item?.category);
          return {
            ...item,
            category: normalized as unknown as CivicCategory,
            normalizedCategory: normalized,
          };
        })
      : [];
  } catch (err) {
    console.warn('Failed to parse cached reports from localStorage:', err);
    return [];
  }
}

/**
 * Defensive ownership filter for citizen-facing report state.
 * Firestore rules and UID-scoped queries remain the primary enforcement; this
 * prevents a malformed cache or unexpected document from reaching My Reports.
 */
export function filterReportsForCitizen(
  reports: CivicIssueReport[],
  authenticatedUid: string
): CivicIssueReport[] {
  if (!authenticatedUid) return [];
  return reports.filter((report) => report.userId === authenticatedUid);
}

function getVerifiedCitizenUid(requestedUid: string): string | null {
  const authenticatedUid = auth?.currentUser?.uid || null;
  return authenticatedUid && authenticatedUid === requestedUid ? authenticatedUid : null;
}

import { estimateFirestoreDocumentSize } from './imageOptimizer';

export const MAX_FIRESTORE_DOC_BYTES = 800 * 1024; // 800 KiB safe threshold (Firestore limit is 1,048,576 bytes)

/**
 * Save user reports array to user-specific localStorage cache.
 * Explicitly catches QuotaExceededError and returns structured status
 * so the application never falsely claims a report was cached offline.
 */
export function saveLocalCachedReports(
  userId: string,
  reports: CivicIssueReport[]
): { success: boolean; error?: string } {
  if (typeof localStorage === 'undefined') {
    return { success: false, error: 'Device storage is not available in this browser.' };
  }
  try {
    localStorage.setItem(`${STORAGE_KEYS.USER_REPORTS_PREFIX}${userId}`, JSON.stringify(reports));
    return { success: true };
  } catch (err: any) {
    const isQuota =
      err?.name === 'QuotaExceededError' ||
      err?.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      err?.code === 22 ||
      err?.code === 1014;
    const errorMsg = isQuota
      ? 'Device storage is full. The complaint could not be saved offline.'
      : 'Could not save complaints on this device.';
    console.warn('Failed to cache reports to localStorage:', err);
    return { success: false, error: errorMsg };
  }
}

function getPendingNotesMap(userId?: string): Record<string, string[]> {
  if (!userId || typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(`${STORAGE_KEYS.PENDING_NOTES_PREFIX}${userId}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, string[]>;
  } catch {
    return {};
  }
}

function savePendingNotesMap(userId: string, map: Record<string, string[]>): void {
  if (!userId || typeof localStorage === 'undefined') return;
  try {
    const cleaned: Record<string, string[]> = {};
    for (const [repId, notes] of Object.entries(map)) {
      if (Array.isArray(notes) && notes.length > 0) {
        cleaned[repId] = notes;
      }
    }
    if (Object.keys(cleaned).length === 0) {
      localStorage.removeItem(`${STORAGE_KEYS.PENDING_NOTES_PREFIX}${userId}`);
    } else {
      localStorage.setItem(`${STORAGE_KEYS.PENDING_NOTES_PREFIX}${userId}`, JSON.stringify(cleaned));
    }
  } catch (err) {
    console.warn('Failed to update pending notes queue in localStorage:', err);
  }
}

function enqueuePendingNote(userId: string, reportId: string, formattedNote: string): void {
  if (!userId || !reportId || !formattedNote) return;
  const map = getPendingNotesMap(userId);
  const existing = Array.isArray(map[reportId]) ? map[reportId] : [];
  if (!existing.includes(formattedNote)) {
    map[reportId] = [...existing, formattedNote];
    savePendingNotesMap(userId, map);
  }
}

export interface PendingWithdrawalIntent {
  reportId: string;
  userId: string;
  requestedAt: string;
  reason?: string;
}

export function getPendingWithdrawals(userId?: string): PendingWithdrawalIntent[] {
  if (!userId || typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(`${STORAGE_KEYS.PENDING_WITHDRAWALS_PREFIX}${userId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is PendingWithdrawalIntent =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof item.reportId === 'string' &&
        item.reportId.trim().length > 0 &&
        typeof item.userId === 'string' &&
        item.userId === userId &&
        typeof item.requestedAt === 'string'
    );
  } catch {
    return [];
  }
}

export function savePendingWithdrawals(
  userId: string,
  intents: PendingWithdrawalIntent[]
): { success: boolean; error?: string } {
  if (!userId || typeof localStorage === 'undefined') {
    return { success: false, error: 'Device storage is not available in this browser.' };
  }
  const key = `${STORAGE_KEYS.PENDING_WITHDRAWALS_PREFIX}${userId}`;
  try {
    const valid = intents.filter(
      (item) =>
        item &&
        typeof item.reportId === 'string' &&
        item.reportId.trim().length > 0 &&
        item.userId === userId
    );
    if (valid.length === 0) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(valid));
    }
    return { success: true };
  } catch (err: any) {
    console.warn('Failed to persist pending withdrawals queue in localStorage:', err);
    return {
      success: false,
      error: 'Device storage is full or unavailable. Please reconnect to withdraw this complaint.',
    };
  }
}

export function enqueuePendingWithdrawalIntent(
  intent: PendingWithdrawalIntent
): { success: boolean; error?: string } {
  if (!intent.userId || !intent.reportId) {
    return { success: false, error: 'Invalid pending withdrawal intent.' };
  }
  const existing = getPendingWithdrawals(intent.userId);
  const filtered = existing.filter((item) => item.reportId !== intent.reportId);
  const cleanIntent: PendingWithdrawalIntent = {
    reportId: intent.reportId,
    userId: intent.userId,
    requestedAt: intent.requestedAt,
    ...(intent.reason?.trim() ? { reason: intent.reason.trim() } : {}),
  };
  return savePendingWithdrawals(intent.userId, [...filtered, cleanIntent]);
}

export function removePendingWithdrawalIntent(userId: string, reportId: string): void {
  if (!userId || !reportId) return;
  const existing = getPendingWithdrawals(userId);
  const remaining = existing.filter((item) => item.reportId !== reportId);
  if (remaining.length !== existing.length) {
    savePendingWithdrawals(userId, remaining);
  }
}

export function clearPendingWithdrawals(userId?: string): void {
  if (!userId || typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(`${STORAGE_KEYS.PENDING_WITHDRAWALS_PREFIX}${userId}`);
  } catch (err) {
    console.warn('Failed to clear pending withdrawals queue on sign-out:', err);
  }
}

export interface PendingSyncCounts {
  pendingReports: number;
  pendingNotes: number;
  pendingWithdrawals: number;
  total: number;
}

export function getPendingSyncCounts(
  userId?: string,
  reportsOverride?: CivicIssueReport[]
): PendingSyncCounts {
  if (!userId) {
    return {
      pendingReports: 0,
      pendingNotes: 0,
      pendingWithdrawals: 0,
      total: 0,
    };
  }

  const reportSource = Array.isArray(reportsOverride)
    ? reportsOverride
    : getLocalCachedReports(userId);
  const pendingReports = reportSource.filter((r) => r && !r.syncedToCloud).length;

  const notesMap = getPendingNotesMap(userId);
  const pendingNotes = Object.values(notesMap).reduce(
    (sum, list) => sum + (Array.isArray(list) ? list.length : 0),
    0
  );

  const pendingWithdrawals = getPendingWithdrawals(userId).length;
  return {
    pendingReports,
    pendingNotes,
    pendingWithdrawals,
    total: pendingReports + pendingNotes + pendingWithdrawals,
  };
}

export function hasPendingOfflineSync(
  userId?: string,
  reportsOverride?: CivicIssueReport[]
): boolean {
  return getPendingSyncCounts(userId, reportsOverride).total > 0;
}

function mergePendingNotesIntoCloudReports(
  userId: string,
  cloudReports: CivicIssueReport[]
): CivicIssueReport[] {
  const map = getPendingNotesMap(userId);
  if (Object.keys(map).length === 0) return cloudReports;

  let mapChanged = false;
  const merged = cloudReports.map((rep) => {
    const pending = map[rep.id];
    if (!Array.isArray(pending) || pending.length === 0) {
      return rep;
    }
    const cloudNotes = Array.isArray(rep.citizenNotes) ? rep.citizenNotes : [];
    const stillPending = pending.filter((note) => !cloudNotes.includes(note));
    if (stillPending.length !== pending.length) {
      mapChanged = true;
      if (stillPending.length === 0) {
        delete map[rep.id];
      } else {
        map[rep.id] = stillPending;
      }
    }
    if (stillPending.length === 0) {
      return rep;
    }
    return {
      ...rep,
      citizenNotes: [...cloudNotes, ...stillPending],
    };
  });

  if (mapChanged) {
    savePendingNotesMap(userId, map);
  }
  return merged;
}


export interface NewReportInput {
  reportId?: string;
  trackingNumber?: string;
  submittedAt?: string;
  category: AnyCivicCategory;
  title?: string;
  description: string;
  locationAddress: string;
  landmark?: string;
  photoUrl: string;
  severity: ReportSeverity;
  department?: string;
  latitude: number | null;
  longitude: number | null;
  ward?: string;
  aiAnalysis?: AiAnalysisResult;
  imageVerification?: CivicImageVerificationResult;
}

/**
 * Retrieve reports belonging ONLY to the currently signed-in user from Cloud Firestore.
 * If network or database is unreachable, safely falls back to local cache and flags the error.
 */
export async function fetchUserReportsFromFirestore(
  userId: string
): Promise<{
  reports: CivicIssueReport[];
  fromCloud: boolean;
  hasPendingSync: boolean;
  pendingCount: number;
  error?: string;
}> {
  if (!userId) {
    return { reports: [], fromCloud: false, hasPendingSync: false, pendingCount: 0 };
  }

  const authenticatedUid = getVerifiedCitizenUid(userId);
  if (!authenticatedUid) {
    return {
      reports: [],
      fromCloud: false,
      hasPendingSync: false,
      pendingCount: 0,
      error: 'Your authenticated citizen session does not match this report account.',
    };
  }

  // If Firebase db is not configured, fall back to local cache
  if (!isFirebaseConfigured || !db) {
    const cached = filterReportsForCitizen(getLocalCachedReports(authenticatedUid), authenticatedUid);
    const pending = cached.filter((r) => !r.syncedToCloud);
    return {
      reports: cached,
      fromCloud: false,
      hasPendingSync: pending.length > 0,
      pendingCount: pending.length,
      error: 'Unable to refresh the latest information right now.',
    };
  }

  try {
    const reportsCol = collection(db, 'civic_reports');
    const userReportsQuery = query(reportsCol, where('userId', '==', userId));
    const snapshot = await getDocs(userReportsQuery);

    const cloudReports: CivicIssueReport[] = [];
    const cloudIds = new Set<string>();

    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      if (data.userId !== authenticatedUid) return;
      cloudIds.add(docSnap.id);
      const normalizedCat = normalizeCivicCategory(data.category);
      cloudReports.push({
        id: docSnap.id,
        trackingNumber: data.trackingNumber || `CFX-2026-${docSnap.id.slice(0, 4)}`,
        category: normalizedCat as unknown as CivicCategory,
        normalizedCategory: normalizedCat,
        title: data.title || `${data.category || 'Civic'} Issue`,
        description: data.description || '',
        photoUrl: data.photoUrl || '',
        afterPhotoUrl: data.afterPhotoUrl || undefined,
        location: {
          address: data.location?.address || 'Manual Address Recorded',
          landmark: data.location?.landmark || undefined,
          latitude: isValidCoordinate(data.location?.latitude, data.location?.longitude)
            ? Number(data.location.latitude)
            : null,
          longitude: isValidCoordinate(data.location?.latitude, data.location?.longitude)
            ? Number(data.location.longitude)
            : null,
          ward: data.location?.ward || 'Unspecified Ward',
        },
        severity: (data.severity as ReportSeverity) || 'Low',
        status: normalizeReportStatus(data.status),
        submittedAt: (() => {
          const parsedMs = parseReportTimestamp(data.submittedAt);
          return parsedMs > 0 ? new Date(parsedMs).toISOString() : (typeof data.submittedAt === 'string' ? data.submittedAt : '');
        })(),
        updatedAt: (() => {
          const parsedMs = parseReportTimestamp(data.updatedAt);
          return parsedMs > 0 ? new Date(parsedMs).toISOString() : (typeof data.updatedAt === 'string' ? data.updatedAt : '');
        })(),
        department: data.department || 'Public Works & Municipal Administration',
        slaDeadline: data.slaDeadline || '48 Hours SLA',
        timeline: Array.isArray(data.timeline) ? data.timeline : [],
        citizenNotes: Array.isArray(data.citizenNotes) ? data.citizenNotes : [],
        citizenName: data.citizenName || undefined,
        citizenEmail: data.citizenEmail || undefined,
        userId: data.userId || userId,
        isDemo: false,
        syncedToCloud: true,
        storageSource: 'firestore',
        aiAnalysis: data.aiAnalysis || undefined,
        imageVerification: data.imageVerification || undefined,
        adminRemarks: data.adminRemarks || '',
        assignedOfficer: data.assignedOfficer || '',
        assignedDepartment: data.assignedDepartment || data.department || '',
        resolutionDetails: data.resolutionDetails || '',
        resolutionPhotoUrl: data.resolutionPhotoUrl || '',
        resolvedAt: normalizeOptionalReportTimestamp(data.resolvedAt) || '',
        updatedBy: data.updatedBy || undefined,
        duplicateOf: data.duplicateOf || undefined,
        withdrawnAt: normalizeOptionalReportTimestamp(data.withdrawnAt),
        withdrawnBy: data.withdrawnBy || undefined,
        withdrawalReason: data.withdrawalReason || undefined,
        archived: Boolean(data.archived),
        archivedAt: normalizeOptionalReportTimestamp(data.archivedAt),
        archivedBy: data.archivedBy || undefined,
        archiveReason: data.archiveReason || undefined,
      });
    });

    const cloudWithPendingNotes = mergePendingNotesIntoCloudReports(authenticatedUid, cloudReports);

    // Check if there are any locally stored reports that haven't synced yet
    const localCached = filterReportsForCitizen(getLocalCachedReports(authenticatedUid), authenticatedUid);
    const pendingLocalReports = localCached.filter(
      (local) => !local.syncedToCloud && !cloudIds.has(local.id)
    );

    // Merge: cloud reports + any pending unsynced local reports
    const combinedReports = [...cloudWithPendingNotes, ...pendingLocalReports];

    // Sort client-side descending newest first (missing timestamps placed at bottom)
    const sortedReports = sortReportsNewestFirst(combinedReports);

    // Update local cache with combined state
    saveLocalCachedReports(userId, sortedReports);

    return {
      reports: sortedReports,
      fromCloud: true,
      hasPendingSync: pendingLocalReports.length > 0,
      pendingCount: pendingLocalReports.length,
    };
  } catch (err: any) {
    console.warn('Failed to retrieve reports from Cloud Firestore:', err);
    const cached = getLocalCachedReports(userId);
    const pending = cached.filter((r) => !r.syncedToCloud);
    return {
      reports: cached,
      fromCloud: false,
      hasPendingSync: pending.length > 0,
      pendingCount: pending.length,
      error: 'Unable to refresh the latest information. Showing previously saved reports.',
    };
  }
}

/**
 * Submit a new civic issue report directly to Cloud Firestore.
 * Saves report ID, category, description, location (null coordinates if unobtained),
 * severity, timestamp, status ('Submitted'), and citizen UID.
 *
 * Enforces:
 * 1. Sanitizes all data to remove undefined properties before calling setDoc.
 * 2. Uses verified auth.currentUser.uid matching firestore.rules.
 * 3. Sets syncedToCloud: true ONLY when Firestore write succeeds.
 * 4. On failure, saves safely to local storage fallback and returns clear error explanation.
 */
export function getInitialStatusHistoryDocId(reportId: string): string {
  return `initial_submitted_${reportId}`;
}

export function getInitialAuditLogDocId(reportId: string): string {
  return `report_created_${reportId}`;
}

interface InitialHistoryAndAuditOutcome {
  statusHistoryRecorded: boolean;
  auditLogRecorded: boolean;
  auditWarning?: string;
}

interface InitialHistoryAndAuditDeps {
  dbInstance: any;
  isMockDb?: boolean;
  docFn?: (...args: any[]) => any;
  setDocFn?: (ref: any, data: any) => Promise<void>;
  collectionFn?: (...args: any[]) => any;
  queryFn?: (...args: any[]) => any;
  whereFn?: (...args: any[]) => any;
  limitFn?: (...args: any[]) => any;
  getDocsFn?: (q: any) => Promise<any>;
  statusHistorySetDocFn?: (ref: any, data: any) => Promise<void>;
  auditLogSetDocFn?: (ref: any, data: any) => Promise<void>;
}

async function ensureInitialStatusHistoryAndAudit(
  params: {
    reportId: string;
    trackingNumber: string;
    category: string;
    uid: string;
    email?: string;
    submittedAt: string;
    sourceLabel: 'submission' | 'retry';
  },
  deps: InitialHistoryAndAuditDeps
): Promise<InitialHistoryAndAuditOutcome> {
  const { reportId, trackingNumber, category, uid, email, submittedAt, sourceLabel } = params;
  const warnings: string[] = [];
  let statusHistoryRecorded = false;
  let auditLogRecorded = false;

  const docFn = deps.docFn ?? doc;
  const collectionFn = deps.collectionFn ?? collection;
  const queryFn = deps.queryFn ?? query;
  const whereFn = deps.whereFn ?? where;
  const limitFn = deps.limitFn ?? limit;
  const getDocsFn = deps.getDocsFn ?? getDocs;
  const statusHistorySetFn = deps.statusHistorySetDocFn ?? deps.setDocFn ?? setDoc;
  const auditLogSetFn = deps.auditLogSetDocFn ?? deps.setDocFn ?? setDoc;

  // 1. Idempotent initial Submitted statusHistory creation (owners can read statusHistory per rules)
  try {
    let alreadyHasSubmittedHistory = false;
    if (!deps.isMockDb || deps.getDocsFn) {
      const historyCol = collectionFn(deps.dbInstance, 'civic_reports', reportId, 'statusHistory');
      const existingQuery = queryFn(historyCol, whereFn('toStatus', '==', 'Submitted'), limitFn(1));
      const existingSnap = await getDocsFn(existingQuery);
      if (existingSnap && typeof existingSnap.empty === 'boolean') {
        alreadyHasSubmittedHistory = !existingSnap.empty;
      } else if (existingSnap && typeof existingSnap.size === 'number') {
        alreadyHasSubmittedHistory = existingSnap.size > 0;
      } else if (Array.isArray(existingSnap)) {
        alreadyHasSubmittedHistory = existingSnap.length > 0;
      }
    }

    if (alreadyHasSubmittedHistory) {
      statusHistoryRecorded = true;
    } else if (!deps.isMockDb || deps.statusHistorySetDocFn) {
      const historyDocRef = docFn(
        deps.dbInstance,
        'civic_reports',
        reportId,
        'statusHistory',
        getInitialStatusHistoryDocId(reportId)
      );
      await statusHistorySetFn(
        historyDocRef,
        sanitizeForFirestore({
          reportId,
          fromStatus: null,
          toStatus: 'Submitted',
          changedByUid: uid,
          changedByEmail: email || undefined,
          changedByRole: 'citizen',
          note:
            sourceLabel === 'retry'
              ? 'Report registered by citizen via CiviFix AI (synced after offline save).'
              : 'Report registered by citizen via CiviFix AI.',
          timestamp: submittedAt,
        })
      );
      statusHistoryRecorded = true;
    }
  } catch (histErr: any) {
    statusHistoryRecorded = false;
    warnings.push(
      `Initial status history unavailable (${histErr?.message || histErr?.code || 'write skipped'}).`
    );
  }

  // 2. Best-effort deterministic-ID auditLogs creation
  // Note: firestore.rules denies citizen reads on auditLogs (`allow read: if isAdmin()`), so
  // deterministic ID (`report_created_${reportId}`) guarantees at most one new audit document
  // across online + retry paths, while failed writes are reported honestly without failing sync.
  try {
    if (!deps.isMockDb || deps.auditLogSetDocFn) {
      const auditDocRef = docFn(
        deps.dbInstance,
        'auditLogs',
        getInitialAuditLogDocId(reportId)
      );
      await auditLogSetFn(
        auditDocRef,
        sanitizeForFirestore({
          action: 'report_created',
          targetType: 'civic_report',
          targetId: reportId,
          actorUid: uid,
          actorRole: 'citizen',
          summary:
            sourceLabel === 'retry'
              ? `Citizen synced offline report ${trackingNumber} (${category}).`
              : `Citizen submitted report ${trackingNumber} (${category}).`,
          timestamp: submittedAt,
        })
      );
      auditLogRecorded = true;
    }
  } catch (auditErr: any) {
    auditLogRecorded = false;
    warnings.push(
      `Audit log entry not confirmed (${auditErr?.code || auditErr?.message || 'write rejected'}).`
    );
  }

  return {
    statusHistoryRecorded,
    auditLogRecorded,
    auditWarning: warnings.length > 0 ? warnings.join(' ') : undefined,
  };
}

export async function submitCivicReportToFirestore(
  input: NewReportInput,
  user: CitizenUser
): Promise<{ report: CivicIssueReport; savedToCloud: boolean; error?: string }> {
  const trackingNumber = input.trackingNumber?.trim() || generateTrackingNumber();
  const submittedTimestamp = input.submittedAt?.trim() || new Date().toISOString();
  const now = new Date().toISOString();
  const reportDocId =
    input.reportId?.trim() ||
    'rep_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);

  // Authenticated UID verification
  const currentAuthUid = auth.currentUser?.uid || user.id;
  const citizenName = user.fullName || auth.currentUser?.displayName || 'Citizen';
  const citizenEmail = user.email || auth.currentUser?.email || '';

  const initialTimeline: TimelineEvent[] = [
    {
      status: 'Submitted',
      timestamp: submittedTimestamp,
      note: 'Report registered by citizen via CiviFix AI.',
      officer: 'Citizen',
    },
  ];

  // Base report data structure
  const normalizedInputCategory = normalizeCivicCategory(input.category);
  const resolvedSeverity: ReportSeverity = input.severity || 'Medium';
  const resolvedDepartment =
    input.department?.trim() || getDepartmentForCategory(input.category);
  const resolvedSlaDeadline =
    resolvedSeverity === 'Hazard'
      ? '12 Hours Emergency SLA'
      : resolvedSeverity === 'High'
        ? '24 Hours Rapid Redressal'
        : resolvedSeverity === 'Medium' || resolvedSeverity === 'Moderate'
          ? '48 Hours Standard SLA'
          : '72 Hours Standard SLA';
  const hasValidInputCoords = isValidCoordinate(input.latitude, input.longitude);

  const reportData: CivicIssueReport = {
    id: reportDocId,
    trackingNumber,
    userId: currentAuthUid,
    citizenName,
    citizenEmail,
    category: input.category as unknown as CivicCategory,
    normalizedCategory: normalizedInputCategory,
    title: input.title?.trim() || `${input.category} Issue`,
    description: input.description.trim(),
    photoUrl: input.photoUrl,
    location: {
      address: input.locationAddress.trim(),
      landmark: input.landmark?.trim() || undefined,
      latitude: hasValidInputCoords ? Number(input.latitude) : null, // null if GPS was not detected or invalid
      longitude: hasValidInputCoords ? Number(input.longitude) : null,
      ward: input.ward || user.ward || 'Unspecified Ward',
    },
    severity: resolvedSeverity,
    status: 'Submitted',
    submittedAt: submittedTimestamp,
    updatedAt: now,
    department: resolvedDepartment,
    slaDeadline: resolvedSlaDeadline,
    timeline: initialTimeline,
    citizenNotes: [],
    isDemo: false,
    syncedToCloud: false,
    storageSource: 'local_fallback',
    aiAnalysis: input.aiAnalysis,
    imageVerification: input.imageVerification || undefined,
  };

  if (input.imageVerification?.requiresHumanReview) {
    reportData.timeline.push({
      status: 'Submitted',
      timestamp: submittedTimestamp,
      note: `Image review information: Photo flagged for municipal staff review (${input.imageVerification.explanation || 'Verification needed'}).`,
      officer: 'System',
    });
  }

  // Attempt real-time write to Cloud Firestore
  try {
    if (!isFirebaseConfigured || !db) {
      throw new Error('The service is temporarily unavailable. Please try again shortly.');
    }

    if (!auth.currentUser) {
      throw new Error('Please sign in with your citizen account to submit a complaint.');
    }

    // Upload complaint image to Firebase Storage if data URL provided (with 10s timeout fallback)
    let storedPhotoUrl = input.photoUrl || '';

    if (storedPhotoUrl && storedPhotoUrl.startsWith('data:')) {
      let uploadTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        const uploadPromise = uploadComplaintImageToStorage(reportDocId, storedPhotoUrl, currentAuthUid);
        const timeoutPromise = new Promise<{ success?: boolean; url: string | null; error?: string }>((_, reject) => {
          uploadTimer = setTimeout(() => reject(new Error('Storage upload timed out')), 10000);
        });
        const uploadRes = await Promise.race([uploadPromise, timeoutPromise]);
        if (uploadRes && uploadRes.url && !uploadRes.url.startsWith('data:')) {
          storedPhotoUrl = uploadRes.url;
          reportData.photoUrl = storedPhotoUrl;
        }
      } catch (uploadErr) {
        console.warn('Firebase Storage upload error or timeout, falling back to optimized image:', uploadErr);
      } finally {
        if (uploadTimer !== null) {
          clearTimeout(uploadTimer);
        }
      }
    }

    // Build pristine Firestore document payload (explicitly sanitizing any undefined keys)
    const firestorePayload: Record<string, any> = {
      id: reportDocId,
      trackingNumber,
      userId: currentAuthUid,
      citizenName,
      citizenEmail,
      category: input.category,
      title: reportData.title,
      description: reportData.description,
      photoUrl: storedPhotoUrl,
      location: {
        address: reportData.location.address,
        latitude: typeof reportData.location.latitude === 'number' ? reportData.location.latitude : null,
        longitude: typeof reportData.location.longitude === 'number' ? reportData.location.longitude : null,
        ward: reportData.location.ward,
      },
      severity: reportData.severity,
      status: 'Submitted',
      submittedAt: submittedTimestamp,
      updatedAt: now,
      department: reportData.department,
      slaDeadline: reportData.slaDeadline,
      timeline: reportData.timeline,
      citizenNotes: [],
      isDemo: false,
      syncedToCloud: true,
      storageSource: 'firestore',
    };

    if (reportData.location.landmark) {
      firestorePayload.location.landmark = reportData.location.landmark;
    }

    if (reportData.aiAnalysis) {
      firestorePayload.aiAnalysis = {
        suggestedCategory: reportData.aiAnalysis.suggestedCategory,
        suggestedExpandedCategory: reportData.aiAnalysis.suggestedExpandedCategory,
        categoryMatch: Boolean(reportData.aiAnalysis.categoryMatch),
        severity: reportData.aiAnalysis.severity,
        suggestedSeverity: reportData.aiAnalysis.suggestedSeverity,
        severityReason: reportData.aiAnalysis.severityReason,
        detectedIssueType: reportData.aiAnalysis.detectedIssueType,
        shortExplanation: reportData.aiAnalysis.shortExplanation,
        suggestedTitle: reportData.aiAnalysis.suggestedTitle,
        suggestedDescription: reportData.aiAnalysis.suggestedDescription,
        confidence: reportData.aiAnalysis.confidence || null,
        confidenceLevel: reportData.aiAnalysis.confidenceLevel ?? null,
        aiNotes: reportData.aiAnalysis.aiNotes || '',
        isFallback: Boolean(reportData.aiAnalysis.isFallback),
      };
    }

    if (reportData.imageVerification) {
      firestorePayload.imageVerification = reportData.imageVerification;
    }

    const sanitizedPayload = sanitizeForFirestore(firestorePayload);

    // Enforce safe document size limit (< 800 KiB) below Firestore's 1 MiB limit
    const estimatedDocBytes = estimateFirestoreDocumentSize(sanitizedPayload);
    if (estimatedDocBytes > MAX_FIRESTORE_DOC_BYTES) {
      throw new Error(
        'This complaint and its photo are too large to submit. Please attach a smaller photo and try again.'
      );
    }

    const reportRef = doc(db, 'civic_reports', reportDocId);

    // Perform actual write to Firestore
    await setDoc(reportRef, sanitizedPayload);

    // Non-blocking deterministic audit & statusHistory trail entries
    const auditOutcome = await ensureInitialStatusHistoryAndAudit(
      {
        reportId: reportDocId,
        trackingNumber,
        category: String(input.category),
        uid: currentAuthUid,
        email: citizenEmail,
        submittedAt: submittedTimestamp,
        sourceLabel: 'submission',
      },
      { dbInstance: db }
    );
    if (auditOutcome.auditWarning) {
      console.warn('Non-blocking report creation audit trail notice:', auditOutcome.auditWarning);
    }

    // Once setDoc succeeds, we can honestly mark as cloud synced
    reportData.syncedToCloud = true;
    reportData.storageSource = 'firestore';

    // Update user local cache with confirmed cloud report
    const existing = getLocalCachedReports(currentAuthUid);
    saveLocalCachedReports(
      currentAuthUid,
      sortReportsNewestFirst([reportData, ...existing.filter((r) => r.id !== reportDocId)])
    );

    return {
      report: reportData,
      savedToCloud: true,
    };
  } catch (err: any) {
    console.error('Firestore submission error:', err);

    const friendlyError = toUserFriendlyErrorMessage(err, 'submit_complaint');

    // Save to user local cache as fallback so citizen does not lose their report
    reportData.syncedToCloud = false;
    reportData.storageSource = 'local_fallback';
    const existing = getLocalCachedReports(currentAuthUid);
    const cacheResult = saveLocalCachedReports(
      currentAuthUid,
      sortReportsNewestFirst([reportData, ...existing.filter((r) => r.id !== reportDocId)])
    );

    if (cacheResult.success) {
      return {
        report: reportData,
        savedToCloud: false,
        error: `Saved on this device for later upload: ${friendlyError}`,
      };
    } else {
      // Local cache failed (e.g. QuotaExceededError). Honestly report both failures!
      return {
        report: reportData,
        savedToCloud: false,
        error: `Could not upload your complaint (${friendlyError}) and saving on this device also failed (${cacheResult.error}). Please keep a copy of your complaint details.`,
      };
    }
  }
}


/**
 * Retry Upload Action for an individual pending or offline report.
 *
 * Enforces:
 * 1. Checks Firebase configuration and current authentication status.
 * 2. Verifies the authenticated Firebase UID strictly matches the report's owner (`userId`).
 *    If mismatched, safely halts and explains the security rules constraint.
 * 3. Preserves the exact document ID, tracking number, and original submission date.
 *    Does NOT create duplicate documents in Firestore.
 * 4. Updates local cache upon successful write.
 */
export interface RetryReportUploadResult {
  success: boolean;
  report: CivicIssueReport;
  error?: string;
  alreadyExistedInCloud?: boolean;
  photoUploadedToStorage?: boolean;
  statusHistoryRecorded?: boolean;
  auditLogRecorded?: boolean;
  auditWarning?: string;
}

export interface RetryReportUploadDeps {
  currentUser?: { uid: string; displayName?: string | null; email?: string | null } | null;
  dbInstance?: any;
  isConfigured?: boolean;
  setDocFn?: (ref: any, data: any) => Promise<void>;
  getDocFn?: (ref: any) => Promise<any>;
  docFn?: (db: any, ...pathSegments: string[]) => any;
  collectionFn?: (db: any, ...pathSegments: string[]) => any;
  queryFn?: (col: any, ...constraints: any[]) => any;
  whereFn?: (field: string, op: any, value: any) => any;
  limitFn?: (n: number) => any;
  getDocsFn?: (q: any) => Promise<any>;
  statusHistorySetDocFn?: (ref: any, data: any) => Promise<void>;
  auditLogSetDocFn?: (ref: any, data: any) => Promise<void>;
  uploadPhotoFn?: (
    reportId: string,
    dataUrl: string,
    ownerUid?: string
  ) => Promise<{ success: boolean; url: string; error?: string }>;
  uploadTimeoutMs?: number;
}

/**
 * Retry Upload Action for an individual pending or offline report.
 *
 * Enforces:
 * 1. Checks Firebase configuration, authentication, and strict UID ownership (`userId`).
 * 2. Detects already-synchronized owned reports in Firestore before writing to avoid unauthorized overwrite errors or duplicate uploads.
 * 3. Uploads pending `data:` URI complaint photos to Firebase Storage while skipping existing HTTPS Storage URLs and retaining bounded inline fallback if Storage fails.
 * 4. Preserves the exact document ID, tracking number, submittedAt, and citizen metadata.
 * 5. Enforces the 800 KiB Firestore payload size limit AFTER finalizing photo representation.
 * 6. Creates deterministic initial Submitted statusHistory and best-effort auditLogs entries without duplicating them across retries.
 */
export async function retryReportUpload(
  report: CivicIssueReport,
  user?: CitizenUser,
  deps?: RetryReportUploadDeps
): Promise<RetryReportUploadResult> {
  const dbInstance = deps && 'dbInstance' in deps ? deps.dbInstance : db;
  const isMockDb = Boolean(deps && 'dbInstance' in deps && deps.dbInstance !== db);
  const firebaseReady =
    deps && 'isConfigured' in deps
      ? Boolean(deps.isConfigured && dbInstance)
      : deps && 'dbInstance' in deps
      ? Boolean(deps.dbInstance)
      : Boolean(isFirebaseConfigured && dbInstance);

  if (!firebaseReady || !dbInstance) {
    return {
      success: false,
      report,
      error: 'Unable to connect right now. Please try again later.',
    };
  }

  const currentUser =
    deps && 'currentUser' in deps ? deps.currentUser : auth.currentUser;
  if (!currentUser) {
    return {
      success: false,
      report,
      error: 'Please sign in with your citizen account to upload saved complaints.',
    };
  }

  // Security rule verification: only author whose UID matches the report can write to civic_reports
  const expectedUid = currentUser.uid;
  const reportOwnerUid = report.userId || user?.id;

  if (reportOwnerUid && reportOwnerUid !== expectedUid) {
    return {
      success: false,
      report,
      error: 'You are not authorized to upload a complaint belonging to another account.',
    };
  }

  const docFn = deps?.docFn ?? doc;
  const setDocFn = deps?.setDocFn ?? setDoc;
  const getDocFn = deps?.getDocFn ?? (!isMockDb ? getDoc : undefined);
  const reportRef = docFn(dbInstance, 'civic_reports', report.id);

  const auxDeps: InitialHistoryAndAuditDeps = {
    dbInstance,
    isMockDb,
    docFn: deps?.docFn,
    setDocFn: deps?.setDocFn,
    collectionFn: deps?.collectionFn,
    queryFn: deps?.queryFn,
    whereFn: deps?.whereFn,
    limitFn: deps?.limitFn,
    getDocsFn: deps?.getDocsFn,
    statusHistorySetDocFn: deps?.statusHistorySetDocFn,
    auditLogSetDocFn: deps?.auditLogSetDocFn,
  };

  try {
    const resolvedCitizenName =
      (typeof report.citizenName === 'string' && report.citizenName.trim()) ||
      (typeof user?.fullName === 'string' && user.fullName.trim()) ||
      (typeof currentUser.displayName === 'string' && currentUser.displayName.trim()) ||
      undefined;
    const resolvedCitizenEmail =
      (typeof report.citizenEmail === 'string' && report.citizenEmail.trim()) ||
      (typeof user?.email === 'string' && user.email.trim()) ||
      (typeof currentUser.email === 'string' && currentUser.email.trim()) ||
      undefined;

    const persistSyncedLocalCache = (syncedRep: CivicIssueReport) => {
      const cached = getLocalCachedReports(expectedUid);
      const updatedList = cached.some((r) => r.id === syncedRep.id)
        ? cached.map((r) => (r.id === syncedRep.id ? syncedRep : r))
        : [syncedRep, ...cached];
      saveLocalCachedReports(expectedUid, sortReportsNewestFirst(updatedList));
    };

    const reconcileAlreadySynced = async (cloudData: Record<string, any>) => {
      if (cloudData.userId && cloudData.userId !== expectedUid) {
        return {
          success: false,
          report,
          error: 'You are not authorized to access a complaint belonging to another account.',
        };
      }

      const normalizedCat = normalizeCivicCategory(cloudData.category || report.category);
      const alreadySyncedReport: CivicIssueReport = {
        ...report,
        id: report.id,
        trackingNumber: cloudData.trackingNumber || report.trackingNumber,
        userId: expectedUid,
        citizenName: cloudData.citizenName || resolvedCitizenName,
        citizenEmail: cloudData.citizenEmail || resolvedCitizenEmail,
        category: normalizedCat as unknown as CivicCategory,
        normalizedCategory: normalizedCat,
        photoUrl: cloudData.photoUrl || report.photoUrl || '',
        afterPhotoUrl: cloudData.afterPhotoUrl || report.afterPhotoUrl || undefined,
        status: normalizeReportStatus(cloudData.status || report.status),
        submittedAt: cloudData.submittedAt || report.submittedAt,
        updatedAt: cloudData.updatedAt || report.updatedAt,
        syncedToCloud: true,
        storageSource: 'firestore',
      };

      const auditOutcome = await ensureInitialStatusHistoryAndAudit(
        {
          reportId: alreadySyncedReport.id,
          trackingNumber: alreadySyncedReport.trackingNumber,
          category: String(alreadySyncedReport.category),
          uid: expectedUid,
          email: resolvedCitizenEmail,
          submittedAt: alreadySyncedReport.submittedAt || new Date().toISOString(),
          sourceLabel: 'retry',
        },
        auxDeps
      );

      persistSyncedLocalCache(alreadySyncedReport);

      return {
        success: true,
        report: alreadySyncedReport,
        alreadyExistedInCloud: true,
        photoUploadedToStorage: false,
        statusHistoryRecorded: auditOutcome.statusHistoryRecorded,
        auditLogRecorded: auditOutcome.auditLogRecorded,
        auditWarning: auditOutcome.auditWarning,
      };
    };

    // 1. Pre-check if report already exists in Cloud Firestore (owned by this citizen)
    if (getDocFn) {
      try {
        const existingSnap = await getDocFn(reportRef);
        const snapExists =
          typeof existingSnap?.exists === 'function' ? existingSnap.exists() : Boolean(existingSnap?.exists);
        if (snapExists) {
          const cloudData =
            typeof existingSnap.data === 'function' ? existingSnap.data() : existingSnap?.data || {};
          return await reconcileAlreadySynced(cloudData);
        }
      } catch (preCheckErr: any) {
        // Under firestore.rules, reading a non-existent doc evaluates resource.data == null and
        // yields permission-denied. Ignore that cleanly and proceed to create + Storage upload.
        const preMsg = typeof preCheckErr?.message === 'string' ? preCheckErr.message.toLowerCase() : '';
        if (preCheckErr?.code !== 'permission-denied' && !preMsg.includes('permission')) {
          console.warn('Pre-check read notice before retry upload:', preCheckErr);
        }
      }
    }

    // 2. Upload pending data-URI photo to Firebase Storage; skip if already an HTTPS URL
    let finalPhotoUrl = report.photoUrl || '';
    let photoUploadedToStorage = false;

    if (finalPhotoUrl.startsWith('data:')) {
      const uploadFn = deps?.uploadPhotoFn ?? uploadComplaintImageToStorage;
      const uploadTimeoutMs = deps?.uploadTimeoutMs ?? 10000;
      let uploadTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        const uploadPromise = uploadFn(report.id, finalPhotoUrl, expectedUid);
        const timeoutPromise = new Promise<{ success: boolean; url: string; error?: string }>((_, reject) => {
          uploadTimer = setTimeout(() => reject(new Error('Storage upload timed out')), uploadTimeoutMs);
        });
        const uploadRes = await Promise.race([uploadPromise, timeoutPromise]);
        if (uploadRes && uploadRes.success && uploadRes.url && !uploadRes.url.startsWith('data:')) {
          finalPhotoUrl = uploadRes.url;
          photoUploadedToStorage = true;
        }
      } catch (uploadErr) {
        console.warn('Retry Storage upload failed or timed out, retaining bounded inline fallback photo:', uploadErr);
      } finally {
        if (uploadTimer !== null) {
          clearTimeout(uploadTimer);
        }
      }
    }

    const now = new Date().toISOString();

    // Maintain original id, trackingNumber, submittedAt, and citizen metadata
    const updatedReport: CivicIssueReport = {
      ...report,
      userId: expectedUid,
      citizenName: resolvedCitizenName,
      citizenEmail: resolvedCitizenEmail,
      photoUrl: finalPhotoUrl,
      ...(report.afterPhotoUrl ? { afterPhotoUrl: report.afterPhotoUrl } : {}),
      syncedToCloud: true,
      storageSource: 'firestore',
      updatedAt: now,
    };

    // Sanitize before Firestore write
    const payload = sanitizeForFirestore({
      id: updatedReport.id,
      trackingNumber: updatedReport.trackingNumber,
      userId: updatedReport.userId,
      citizenName: resolvedCitizenName,
      citizenEmail: resolvedCitizenEmail,
      category: updatedReport.category,
      title: updatedReport.title,
      description: updatedReport.description,
      photoUrl: finalPhotoUrl,
      ...(report.afterPhotoUrl ? { afterPhotoUrl: report.afterPhotoUrl } : {}),
      location: {
        address: updatedReport.location?.address || 'Manual Address Recorded',
        landmark: updatedReport.location?.landmark || null,
        latitude: isValidCoordinate(
          updatedReport.location?.latitude,
          updatedReport.location?.longitude
        )
          ? Number(updatedReport.location.latitude)
          : null,
        longitude: isValidCoordinate(
          updatedReport.location?.latitude,
          updatedReport.location?.longitude
        )
          ? Number(updatedReport.location.longitude)
          : null,
        ward: updatedReport.location?.ward || 'Unspecified Ward',
      },
      severity: updatedReport.severity,
      status: updatedReport.status,
      submittedAt: updatedReport.submittedAt,
      updatedAt: now,
      department: updatedReport.department,
      slaDeadline: updatedReport.slaDeadline,
      timeline: updatedReport.timeline,
      citizenNotes: updatedReport.citizenNotes || [],
      isDemo: false,
      syncedToCloud: true,
      storageSource: 'firestore',
      aiAnalysis: updatedReport.aiAnalysis,
      imageVerification: updatedReport.imageVerification,
    });

    // Enforce 800 KiB limit AFTER finalizing photo representation (Storage URL vs bounded Data URI)
    const estimatedDocBytes = estimateFirestoreDocumentSize(payload);
    if (estimatedDocBytes > MAX_FIRESTORE_DOC_BYTES) {
      return {
        success: false,
        report,
        error: 'This complaint and its photo are too large to upload. Please choose a smaller photo before retrying.',
      };
    }

    // Write to Firestore with exact document ID (no duplicate documents)
    try {
      await setDocFn(reportRef, payload);
    } catch (writeErr: any) {
      const writeMsg = typeof writeErr?.message === 'string' ? writeErr.message.toLowerCase() : '';
      const isPerm = writeErr?.code === 'permission-denied' || writeMsg.includes('permission');
      // If setDoc hit permission-denied because the report already existed (e.g. background write
      // completed after UI timeout), verify via owner read rather than treating unauthorized errors as success.
      if (isPerm && getDocFn) {
        try {
          const confirmSnap = await getDocFn(reportRef);
          const confirmExists =
            typeof confirmSnap?.exists === 'function'
              ? confirmSnap.exists()
              : Boolean(confirmSnap?.exists);
          if (confirmExists) {
            const cloudData =
              typeof confirmSnap.data === 'function' ? confirmSnap.data() : confirmSnap?.data || {};
            if (cloudData.userId === expectedUid) {
              return await reconcileAlreadySynced(cloudData);
            }
          }
        } catch {
          // Genuine permission-denied or unreadable doc — fall through to outer error handler
        }
      }
      throw writeErr;
    }

    // Best-effort initial Submitted statusHistory & auditLogs creation
    const auditOutcome = await ensureInitialStatusHistoryAndAudit(
      {
        reportId: updatedReport.id,
        trackingNumber: updatedReport.trackingNumber,
        category: String(updatedReport.category),
        uid: expectedUid,
        email: resolvedCitizenEmail,
        submittedAt: updatedReport.submittedAt || now,
        sourceLabel: 'retry',
      },
      auxDeps
    );

    persistSyncedLocalCache(updatedReport);

    return {
      success: true,
      report: updatedReport,
      alreadyExistedInCloud: false,
      photoUploadedToStorage,
      statusHistoryRecorded: auditOutcome.statusHistoryRecorded,
      auditLogRecorded: auditOutcome.auditLogRecorded,
      auditWarning: auditOutcome.auditWarning,
    };
  } catch (err: any) {
    console.error('Retry report upload error:', err);
    return {
      success: false,
      report,
      error: toUserFriendlyErrorMessage(err, 'submit_complaint'),
    };
  }
}

export interface SyncPendingReportsResult {
  syncedCount: number;
  syncedReportsCount: number;
  syncedNotesCount: number;
  syncedWithdrawalsCount: number;
  failedReportsCount: number;
  failedNotesCount: number;
  failedWithdrawalsCount: number;
  totalPendingReports: number;
  totalPendingNotes: number;
  totalPendingWithdrawals: number;
  errors: string[];
  summaryMessage: string;
}

export interface SyncPendingReportsDeps {
  retryReportUploadFn?: (report: CivicIssueReport) => Promise<RetryReportUploadResult>;
  syncPendingNoteFn?: (reportId: string, note: string) => Promise<void>;
  getLatestReportFn?: (reportId: string) => Promise<CivicIssueReport | null>;
  withdrawReportFn?: (
    reportId: string,
    user: CitizenUser,
    currentReport?: CivicIssueReport,
    reason?: string
  ) => Promise<{
    success: boolean;
    report?: CivicIssueReport;
    isPendingSync?: boolean;
    isPermanentRejection?: boolean;
    error?: string;
  }>;
  currentAuthUid?: string | null;
  isConfigured?: boolean;
  hasDb?: boolean;
  hasAuthUser?: boolean;
}

const inFlightSyncByUser = new Map<string, Promise<SyncPendingReportsResult>>();

/**
 * Attempts to sync any offline / locally stored reports, pending follow-up notes,
 * and pending withdrawal requests to Cloud Firestore.
 * Deduplicates concurrent sync runs per userId and preserves transient failures
 * so partial syncs never lose offline data.
 */
export async function syncPendingReportsToFirestore(
  userId: string,
  deps?: SyncPendingReportsDeps
): Promise<SyncPendingReportsResult> {
  if (!userId) {
    const errMsg = 'User session is required to synchronize pending items.';
    return {
      syncedCount: 0,
      syncedReportsCount: 0,
      syncedNotesCount: 0,
      syncedWithdrawalsCount: 0,
      failedReportsCount: 0,
      failedNotesCount: 0,
      failedWithdrawalsCount: 0,
      totalPendingReports: 0,
      totalPendingNotes: 0,
      totalPendingWithdrawals: 0,
      errors: [errMsg],
      summaryMessage: errMsg,
    };
  }

  const existingInFlight = inFlightSyncByUser.get(userId);
  if (existingInFlight) {
    return existingInFlight;
  }

  const runSync = async (): Promise<SyncPendingReportsResult> => {
    const configured =
      deps && 'isConfigured' in deps ? Boolean(deps.isConfigured) : isFirebaseConfigured;
    const hasDb = deps && 'hasDb' in deps ? Boolean(deps.hasDb) : Boolean(db);
    const resolvedAuthUid =
      deps && 'currentAuthUid' in deps
        ? deps.currentAuthUid
        : auth?.currentUser?.uid ?? null;
    const hasAuth =
      deps && 'hasAuthUser' in deps
        ? Boolean(deps.hasAuthUser)
        : Boolean(auth?.currentUser);

    if (!configured || !hasDb || !hasAuth) {
      const errMsg = 'Please sign in while online to sync pending updates.';
      return {
        syncedCount: 0,
        syncedReportsCount: 0,
        syncedNotesCount: 0,
        syncedWithdrawalsCount: 0,
        failedReportsCount: 0,
        failedNotesCount: 0,
        failedWithdrawalsCount: 0,
        totalPendingReports: 0,
        totalPendingNotes: 0,
        totalPendingWithdrawals: 0,
        errors: [errMsg],
        summaryMessage: errMsg,
      };
    }

    if (resolvedAuthUid && resolvedAuthUid !== userId) {
      const errMsg =
        'You are not authorized to sync items belonging to another account.';
      return {
        syncedCount: 0,
        syncedReportsCount: 0,
        syncedNotesCount: 0,
        syncedWithdrawalsCount: 0,
        failedReportsCount: 0,
        failedNotesCount: 0,
        failedWithdrawalsCount: 0,
        totalPendingReports: 0,
        totalPendingNotes: 0,
        totalPendingWithdrawals: 0,
        errors: [errMsg],
        summaryMessage: errMsg,
      };
    }

    const cached = getLocalCachedReports(userId);
    const pending = cached.filter((r) => !r.syncedToCloud);
    const pendingNotesMap = getPendingNotesMap(userId);
    const totalPendingNotes = Object.values(pendingNotesMap).reduce(
      (sum, notes) => sum + (Array.isArray(notes) ? notes.length : 0),
      0
    );
    const pendingWithdrawals = getPendingWithdrawals(userId);

    if (pending.length === 0 && totalPendingNotes === 0 && pendingWithdrawals.length === 0) {
      return {
        syncedCount: 0,
        syncedReportsCount: 0,
        syncedNotesCount: 0,
        syncedWithdrawalsCount: 0,
        failedReportsCount: 0,
        failedNotesCount: 0,
        failedWithdrawalsCount: 0,
        totalPendingReports: 0,
        totalPendingNotes: 0,
        totalPendingWithdrawals: 0,
        errors: [],
        summaryMessage: 'All reports, follow-up notes, and withdrawals are already synced.',
      };
    }

    let syncedReportsCount = 0;
    let syncedNotesCount = 0;
    let syncedWithdrawalsCount = 0;
    let failedReportsCount = 0;
    let failedNotesCount = 0;
    let failedWithdrawalsCount = 0;
    const errors: string[] = [];
    const updatedList = [...cached];

    const retryFn =
      deps?.retryReportUploadFn ?? ((rep: CivicIssueReport) => retryReportUpload(rep));

    for (const report of pending) {
      const res = await retryFn(report);
      if (res.success) {
        const idx = updatedList.findIndex((r) => r.id === report.id);
        if (idx !== -1) {
          updatedList[idx] = res.report;
        }
        syncedReportsCount++;
      } else {
        failedReportsCount++;
        errors.push(`Report ${report.trackingNumber}: ${res.error || 'Sync failed'}`);
      }
    }

    const syncNoteFn =
      deps?.syncPendingNoteFn ??
      (async (reportId: string, note: string) => {
        const noteTs = new Date().toISOString();
        await updateDoc(doc(db, 'civic_reports', reportId), {
          citizenNotes: arrayUnion(note),
          updatedAt: noteTs,
        });
      });

    for (const [reportId, pendingNotes] of Object.entries(pendingNotesMap)) {
      if (!Array.isArray(pendingNotes) || pendingNotes.length === 0) continue;
      const cachedNoteTarget = updatedList.find((r) => r.id === reportId);
      const noteReportLabel = cachedNoteTarget?.trackingNumber || reportId;
      if (cachedNoteTarget?.archived) {
        failedNotesCount += pendingNotes.length;
        errors.push(
          `Pending notes on report ${noteReportLabel}: This complaint has been archived and can no longer receive follow-up notes.`
        );
        delete pendingNotesMap[reportId];
        continue;
      }
      const remaining: string[] = [];
      for (let i = 0; i < pendingNotes.length; i++) {
        const note = pendingNotes[i];
        try {
          await syncNoteFn(reportId, note);
          syncedNotesCount++;
        } catch (err: any) {
          const unsyncedSlice = pendingNotes.slice(i);
          const errMsg = typeof err?.message === 'string' ? err.message : '';
          const isPermissionDenied =
            err?.code === 'permission-denied' ||
            errMsg.toLowerCase().includes('permission');
          if (!isPermissionDenied) {
            remaining.push(...unsyncedSlice);
          }
          failedNotesCount += unsyncedSlice.length;
          errors.push(`Pending note on report ${noteReportLabel}: ${toUserFriendlyErrorMessage(err, 'add_note')}`);
          break;
        }
      }
      if (remaining.length > 0) {
        pendingNotesMap[reportId] = remaining;
      } else {
        delete pendingNotesMap[reportId];
      }
    }
    savePendingNotesMap(userId, pendingNotesMap);

    // Replay pending withdrawal intents after report uploads complete
    if (pendingWithdrawals.length > 0) {
      const getLatestReportFn =
        deps?.getLatestReportFn ??
        (async (reportId: string): Promise<CivicIssueReport | null> => {
          if (!db) return null;
          try {
            const snap = await getDoc(doc(db, 'civic_reports', reportId));
            if (!snap.exists()) return null;
            const data = snap.data();
            const normalizedCat = normalizeCivicCategory(data.category);
            return {
              ...(updatedList.find((r) => r.id === reportId) || ({} as CivicIssueReport)),
              id: snap.id,
              trackingNumber: data.trackingNumber || `CFX-2026-${snap.id.slice(0, 4)}`,
              category: normalizedCat as unknown as CivicCategory,
              normalizedCategory: normalizedCat,
              status: normalizeReportStatus(data.status),
              archived: Boolean(data.archived),
              userId: data.userId || '',
              timeline: Array.isArray(data.timeline) ? data.timeline : [],
              updatedAt: data.updatedAt || '',
            } as CivicIssueReport;
          } catch {
            return null;
          }
        });

      const withdrawReplayFn =
        deps?.withdrawReportFn ??
        ((
          reportId: string,
          user: CitizenUser,
          currentReport?: CivicIssueReport,
          reason?: string
        ) => withdrawReportInFirestore(reportId, user, currentReport, reason));

      const replayUser: CitizenUser = {
        id: userId,
        fullName: auth?.currentUser?.displayName || 'Citizen',
        email: auth?.currentUser?.email || '',
        phone: '',
        ward: 'Unassigned Ward',
        city: 'Metropolitan Civic District',
        reportsCount: updatedList.length,
        resolvedCount: 0,
        notificationPreferences: {
          smsAlerts: true,
          pushNotifications: true,
          emailUpdates: true,
        },
      };

      const retainedWithdrawals: PendingWithdrawalIntent[] = [];
      for (const intent of pendingWithdrawals) {
        if (intent.userId !== userId) {
          continue;
        }

        const cachedCandidate = updatedList.find((r) => r.id === intent.reportId);
        const reportLabel = cachedCandidate?.trackingNumber || intent.reportId;
        let latestReport = await getLatestReportFn(intent.reportId);
        if (!latestReport) {
          latestReport = cachedCandidate || null;
        }

        if (!latestReport) {
          // If report failed initial upload in this pass or is offline, keep intent cleanly
          if (cachedCandidate && !cachedCandidate.syncedToCloud) {
            retainedWithdrawals.push(intent);
            failedWithdrawalsCount++;
            errors.push(
              `Withdrawal for ${reportLabel} waiting for initial report upload.`
            );
          } else {
            // Permanent: target report missing in cloud & local
            failedWithdrawalsCount++;
            errors.push(
              `Withdrawal for ${reportLabel} could not be completed because the report was not found.`
            );
          }
          continue;
        }

        if (latestReport.userId && latestReport.userId !== userId) {
          failedWithdrawalsCount++;
          errors.push(
            `Withdrawal rejected for ${latestReport.trackingNumber || reportLabel}: ownership mismatch.`
          );
          continue;
        }

        if (latestReport.archived) {
          // Archived complaints cannot be withdrawn by citizens; drop stale intent cleanly
          failedWithdrawalsCount++;
          errors.push(
            `Report ${latestReport.trackingNumber || reportLabel}: Withdrawal could not be completed because this complaint has been archived.`
          );
          continue;
        }

        const liveStatus = normalizeReportStatus(latestReport.status);
        if (liveStatus === 'Withdrawn') {
          // Already withdrawn in Firestore: resolve stale intent silently without duplicate failure
          const idx = updatedList.findIndex((r) => r.id === intent.reportId);
          if (idx !== -1) {
            updatedList[idx] = { ...updatedList[idx], ...latestReport, syncedToCloud: true };
          }
          continue;
        }

        if (liveStatus !== 'Submitted' && liveStatus !== 'Under Review') {
          // Municipal officer already moved the report forward; remove stale intent & explain
          failedWithdrawalsCount++;
          errors.push(
            `Report ${latestReport.trackingNumber || intent.reportId}: Withdrawal could not be completed because municipal status changed to "${liveStatus}".`
          );
          continue;
        }

        const withdrawRes = await withdrawReplayFn(
          intent.reportId,
          replayUser,
          latestReport,
          intent.reason
        );

        if (withdrawRes.success && withdrawRes.report) {
          syncedWithdrawalsCount++;
          const idx = updatedList.findIndex((r) => r.id === intent.reportId);
          if (idx !== -1) {
            updatedList[idx] = withdrawRes.report;
          } else {
            updatedList.unshift(withdrawRes.report);
          }
        } else if (withdrawRes.isPendingSync && !withdrawRes.isPermanentRejection) {
          // Transient offline/network error: preserve intent for next retry
          retainedWithdrawals.push(intent);
          failedWithdrawalsCount++;
          errors.push(
            `Withdrawal for ${latestReport.trackingNumber || intent.reportId}: ${withdrawRes.error || 'Network unavailable.'}`
          );
        } else {
          // Permanent rejection (rules/status transition/ownership): drop stale intent
          failedWithdrawalsCount++;
          errors.push(
            `Withdrawal for ${latestReport.trackingNumber || intent.reportId}: ${withdrawRes.error || 'Rejected by municipal records.'}`
          );
        }
      }

      savePendingWithdrawals(userId, retainedWithdrawals);
    }

    saveLocalCachedReports(userId, sortReportsNewestFirst(updatedList));

    const syncedCount = syncedReportsCount + syncedNotesCount + syncedWithdrawalsCount;
    const failedTotal = failedReportsCount + failedNotesCount + failedWithdrawalsCount;
    const remainingAfter = getPendingSyncCounts(userId, updatedList);

    const syncedParts: string[] = [];
    if (syncedReportsCount > 0) {
      syncedParts.push(`${syncedReportsCount} report(s)`);
    }
    if (syncedNotesCount > 0) {
      syncedParts.push(`${syncedNotesCount} pending note(s)`);
    }
    if (syncedWithdrawalsCount > 0) {
      syncedParts.push(`${syncedWithdrawalsCount} withdrawal(s)`);
    }

    let summaryMessage = 'All pending items synced cleanly.';
    if (failedTotal > 0 && syncedCount > 0) {
      summaryMessage = `Synced ${syncedCount} item(s) (${syncedParts.join(', ')}), while ${failedTotal} item(s) remain saved on this device due to errors.`;
    } else if (failedTotal > 0) {
      summaryMessage = `Unable to sync ${failedTotal} pending item(s). Remaining offline items are safely stored on this device.`;
    } else if (remainingAfter.total > 0) {
      summaryMessage = `Synced ${syncedCount} item(s), with ${remainingAfter.total} item(s) still pending synchronization.`;
    } else if (syncedCount > 0) {
      summaryMessage = `Synced ${syncedParts.join(' and ')} successfully.`;
    }

    return {
      syncedCount,
      syncedReportsCount,
      syncedNotesCount,
      syncedWithdrawalsCount,
      failedReportsCount,
      failedNotesCount,
      failedWithdrawalsCount,
      totalPendingReports: pending.length,
      totalPendingNotes,
      totalPendingWithdrawals: pendingWithdrawals.length,
      errors,
      summaryMessage,
    };
  };

  const syncPromise = runSync().finally(() => {
    if (inFlightSyncByUser.get(userId) === syncPromise) {
      inFlightSyncByUser.delete(userId);
    }
  });
  inFlightSyncByUser.set(userId, syncPromise);
  return syncPromise;
}

export interface AddCitizenNoteResult {
  success: boolean;
  formattedNote?: string;
  isPendingSync?: boolean;
  updatedAt?: string;
  error?: string;
}

export interface AddCitizenNoteDeps {
  currentUser?: { uid: string; email?: string | null } | null;
  dbInstance?: any;
  docFn?: (db: any, col: string, id: string) => any;
  updateDocFn?: (ref: any, data: any) => Promise<void>;
  arrayUnionFn?: (...elements: any[]) => any;
  isOnline?: boolean;
}

function appendNoteToLocalCache(
  userId: string,
  reportId: string,
  formattedNote: string,
  updatedAt: string
): void {
  const cached = getLocalCachedReports(userId);
  const updated = cached.map((r) => {
    if (r.id === reportId) {
      const existingNotes = Array.isArray(r.citizenNotes) ? r.citizenNotes : [];
      const nextNotes = existingNotes.includes(formattedNote)
        ? existingNotes
        : [...existingNotes, formattedNote];
      return {
        ...r,
        citizenNotes: nextNotes,
        updatedAt,
      };
    }
    return r;
  });
  saveLocalCachedReports(userId, updated);
}

/**
 * Add a follow-up citizen note to a report in Cloud Firestore.
 * Checks actual Firestore write confirmation before returning success,
 * preserves ownership checks and existing notes, and keeps offline-pending
 * state distinct from Firestore write failure.
 */
export async function addCitizenNoteToFirestore(
  reportId: string,
  noteText: string,
  userId: string,
  deps?: AddCitizenNoteDeps
): Promise<AddCitizenNoteResult> {
  const trimmed = typeof noteText === 'string' ? noteText.trim() : '';
  if (!reportId) {
    return { success: false, error: 'Invalid report ID.' };
  }
  if (!trimmed) {
    return { success: false, error: 'Note cannot be empty.' };
  }
  const noteValidation = validateMeaningfulCivicText(trimmed, {
    fieldLabel: 'Follow-up note',
    minLength: 3,
    required: true,
    allowShortConcise: true,
  });
  if (!noteValidation.valid) {
    return { success: false, error: noteValidation.error };
  }
  if (!userId) {
    return { success: false, error: 'User session is required to add follow-up notes.' };
  }

  const dbInstance = deps && 'dbInstance' in deps ? deps.dbInstance : db;
  const firebaseReady = deps && 'dbInstance' in deps ? Boolean(deps.dbInstance) : Boolean(isFirebaseConfigured && db);
  const currentUser =
    deps && 'currentUser' in deps ? deps.currentUser : auth?.currentUser ?? null;
  const isOnline =
    deps && typeof deps.isOnline === 'boolean'
      ? deps.isOnline
      : typeof navigator !== 'undefined'
      ? navigator.onLine
      : true;

  // Ownership check against authenticated user and local cached report owner
  if (currentUser && currentUser.uid && currentUser.uid !== userId) {
    return {
      success: false,
      error: 'You are not authorized to add follow-up notes to another citizen\'s report.',
    };
  }

  const cached = getLocalCachedReports(userId);
  const targetCached = cached.find((r) => r.id === reportId);
  const effectiveUid = currentUser?.uid || userId;
  if (targetCached?.userId && targetCached.userId !== effectiveUid) {
    return {
      success: false,
      error: 'You are not authorized to update a report belonging to another account.',
    };
  }
  if (targetCached?.archived) {
    return {
      success: false,
      error: 'This complaint has been archived and can no longer receive follow-up notes.',
    };
  }

  const now = new Date().toISOString();
  const formattedNote = `${new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })}: ${trimmed}`;

  // If the report itself is saved locally pending initial upload, keep the note with it locally
  if (targetCached && targetCached.syncedToCloud === false) {
    appendNoteToLocalCache(userId, reportId, formattedNote, now);
    return {
      success: false,
      formattedNote,
      isPendingSync: true,
      updatedAt: now,
      error: 'Report is pending cloud upload. Follow-up note saved locally and will sync together.',
    };
  }

  // If Firebase client is unconfigured (offline/unit environment) or browser reports offline
  if (!firebaseReady || !dbInstance) {
    appendNoteToLocalCache(userId, reportId, formattedNote, now);
    enqueuePendingNote(userId, reportId, formattedNote);
    return {
      success: false,
      formattedNote,
      isPendingSync: true,
      updatedAt: now,
      error: 'You appear to be offline. Your note was saved on this device and will sync when you reconnect.',
    };
  }

  if (!currentUser) {
    return {
      success: false,
      error: 'Please sign in with your citizen account to save follow-up notes.',
    };
  }

  if (isOnline === false && !deps?.updateDocFn) {
    appendNoteToLocalCache(userId, reportId, formattedNote, now);
    enqueuePendingNote(userId, reportId, formattedNote);
    return {
      success: false,
      formattedNote,
      isPendingSync: true,
      updatedAt: now,
      error: 'Network offline: Note saved on this device and will synchronize when back online.',
    };
  }

  try {
    const docFn = deps?.docFn ?? doc;
    const updateDocFn = deps?.updateDocFn ?? updateDoc;
    const arrayUnionFn = deps?.arrayUnionFn ?? arrayUnion;
    const reportRef = docFn(dbInstance, 'civic_reports', reportId);

    await updateDocFn(reportRef, {
      citizenNotes: arrayUnionFn(formattedNote),
      updatedAt: now,
    });

    // Update local cache only after confirmed Firestore write
    appendNoteToLocalCache(userId, reportId, formattedNote, now);

    return {
      success: true,
      formattedNote,
      updatedAt: now,
    };
  } catch (err: any) {
    console.warn('Failed to add citizen note to Firestore:', err);

    const errMsg = typeof err?.message === 'string' ? err.message : '';
    const isPermissionError =
      err?.code === 'permission-denied' || errMsg.toLowerCase().includes('permission');

    if (isPermissionError) {
      return {
        success: false,
        error: 'You are not authorized to add follow-up notes to this complaint.',
      };
    }

    const isOfflineErr =
      err?.code === 'unavailable' ||
      isOnline === false ||
      errMsg.toLowerCase().includes('offline') ||
      errMsg.toLowerCase().includes('network');

    if (isOfflineErr) {
      appendNoteToLocalCache(userId, reportId, formattedNote, now);
      enqueuePendingNote(userId, reportId, formattedNote);
      return {
        success: false,
        formattedNote,
        isPendingSync: true,
        updatedAt: now,
        error: 'Network offline: Note saved on this device and pending upload.',
      };
    }

    // Genuine Firestore write failure: never claim success or mutate local notes
    return {
      success: false,
      error: toUserFriendlyErrorMessage(err, 'add_note'),
    };
  }
}

/**
 * Withdraw an accidentally submitted civic report in Cloud Firestore.
 *
 * Requirements & Security Guarantees:
 * 1. Allowed ONLY when current report status is 'Submitted'.
 * 2. Rejects withdrawal if report is already 'Under Review', 'Assigned', 'In Progress', 'Resolved', 'Rejected', or 'Withdrawn'.
 * 3. Verifies citizen ownership (userId strictly matching current user).
 * 4. Preserves entire report history, tracking number, ID, description, coordinates, photos, and categories.
 * 5. Updates status to 'Withdrawn', records 'withdrawnAt' ISO timestamp and 'withdrawnBy' UID.
 * 6. Appends a withdrawal event to the report timeline audit trail.
 * 7. Synchronizes local storage cache and returns the updated report.
 * 8. Prevents duplicate withdrawal requests.
 */
export interface WithdrawReportDeps {
  isConfigured?: boolean;
  dbInstance?: any;
  currentUser?: { uid: string; email?: string | null } | null;
  docFn?: (...args: any[]) => any;
  collectionFn?: (...args: any[]) => any;
  updateDocFn?: (ref: any, data: any) => Promise<void>;
  addDocFn?: (colRef: any, data: any) => Promise<any>;
  arrayUnionFn?: (...elements: any[]) => any;
  isOnline?: boolean;
}

export async function withdrawReportInFirestore(
  reportId: string,
  user: CitizenUser,
  currentReport?: CivicIssueReport,
  reason?: string,
  deps?: WithdrawReportDeps
): Promise<{
  success: boolean;
  report?: CivicIssueReport;
  isPendingSync?: boolean;
  isPermanentRejection?: boolean;
  error?: string;
}> {
  const citizenId = user?.id || (user as any)?.uid;
  if (!reportId || !citizenId) {
    return {
      success: false,
      isPermanentRejection: true,
      error: 'Invalid report ID or user session. Unable to withdraw report.',
    };
  }

  const resolvedCurrentUser =
    deps && 'currentUser' in deps ? deps.currentUser : auth?.currentUser ?? null;
  const currentAuthUid = resolvedCurrentUser?.uid || citizenId;

  if (resolvedCurrentUser?.uid && resolvedCurrentUser.uid !== citizenId) {
    return {
      success: false,
      isPermanentRejection: true,
      error: 'You are not authorized to withdraw reports using another account.',
    };
  }

  // 1. Locate report in local cache or fallback parameter
  const cachedReports = getLocalCachedReports(citizenId);
  const targetReport = currentReport || cachedReports.find((r) => r.id === reportId);

  if (!targetReport) {
    return {
      success: false,
      isPermanentRejection: true,
      error: 'This complaint could not be found.',
    };
  }

  // 2. Report ownership verification
  if (targetReport.userId && targetReport.userId !== currentAuthUid && targetReport.userId !== citizenId) {
    return {
      success: false,
      isPermanentRejection: true,
      error: 'You are not authorized to withdraw a report submitted by another account.',
    };
  }

  // 2b. Archived complaint guard (matches Firestore security rules)
  if (targetReport.archived) {
    removePendingWithdrawalIntent(citizenId, reportId);
    return {
      success: false,
      isPermanentRejection: true,
      error: 'This complaint has been archived and can no longer be withdrawn.',
    };
  }

  // 3. Status verification - allowed ONLY when status is 'Submitted' or 'Under Review'
  const normalizedStatus = normalizeReportStatus(targetReport.status);

  if (normalizedStatus === 'Withdrawn') {
    removePendingWithdrawalIntent(citizenId, reportId);
    return {
      success: false,
      isPermanentRejection: true,
      error: 'This report has already been withdrawn.',
    };
  }

  if (normalizedStatus !== 'Submitted' && normalizedStatus !== 'Under Review') {
    removePendingWithdrawalIntent(citizenId, reportId);
    return {
      success: false,
      isPermanentRejection: true,
      error: `Only reports with status "Submitted" or "Under Review" can be withdrawn. This report is currently "${normalizedStatus}" and is being processed by the municipality.`,
    };
  }

  const now = new Date().toISOString();
  const withdrawalNote = reason?.trim()
    ? `Report withdrawn by citizen: ${reason.trim()}`
    : 'Report withdrawn by citizen (accidentally submitted).';

  const withdrawalEvent: TimelineEvent = {
    status: 'Withdrawn',
    timestamp: now,
    note: withdrawalNote,
    officer: 'Citizen',
  };

  const updatedTimeline = [...(targetReport.timeline || []), withdrawalEvent];

  const configured =
    deps && 'isConfigured' in deps ? Boolean(deps.isConfigured) : isFirebaseConfigured;
  const dbInstance = deps && 'dbInstance' in deps ? deps.dbInstance : db;
  const isOnline =
    deps && typeof deps.isOnline === 'boolean'
      ? deps.isOnline
      : typeof navigator !== 'undefined'
      ? navigator.onLine
      : true;

  // If Firebase is configured and the citizen is actively authenticated and online
  if (configured && dbInstance && resolvedCurrentUser && (isOnline || deps?.updateDocFn)) {
    try {
      const docFn = deps?.docFn ?? doc;
      const collectionFn = deps?.collectionFn ?? collection;
      const updateDocFn = deps?.updateDocFn ?? updateDoc;
      const addDocFn = deps?.addDocFn ?? addDoc;
      const arrayUnionFn = deps?.arrayUnionFn ?? arrayUnion;

      const reportRef = docFn(dbInstance, 'civic_reports', reportId);
      const updatePayload: Record<string, any> = {
        status: 'Withdrawn',
        withdrawnAt: now,
        withdrawnBy: currentAuthUid,
        timeline: arrayUnionFn(withdrawalEvent),
        updatedAt: now,
      };
      if (reason?.trim()) {
        updatePayload.withdrawalReason = reason.trim();
      }

      await updateDocFn(reportRef, updatePayload);

      // Clean up any queued offline withdrawal intent once confirmed in Cloud Firestore
      removePendingWithdrawalIntent(citizenId, reportId);

      // Non-blocking immutable status history & audit log entry
      try {
        await addDocFn(collectionFn(dbInstance, 'civic_reports', reportId, 'statusHistory'), {
          reportId,
          fromStatus: normalizedStatus,
          toStatus: 'Withdrawn',
          changedByUid: currentAuthUid,
          changedByEmail: resolvedCurrentUser.email || undefined,
          changedByRole: 'citizen',
          note: withdrawalNote,
          timestamp: now,
        });
        await addDocFn(collectionFn(dbInstance, 'auditLogs'), {
          action: 'report_withdrawn',
          targetType: 'civic_report',
          targetId: reportId,
          actorUid: currentAuthUid,
          actorRole: 'citizen',
          summary: `Citizen withdrew report ${targetReport.trackingNumber || reportId} from status "${normalizedStatus}".`,
          timestamp: now,
        });
      } catch (auditErr) {
        console.warn('Non-blocking withdrawal audit trail notice:', auditErr);
      }

      // Successfully committed to Cloud Firestore!
      const confirmedCloudReport: CivicIssueReport = {
        ...targetReport,
        status: 'Withdrawn',
        withdrawnAt: now,
        withdrawnBy: currentAuthUid,
        withdrawalReason: reason?.trim() || undefined,
        timeline: updatedTimeline,
        updatedAt: now,
        syncedToCloud: true,
      };

      const updatedList = cachedReports.map((r) => (r.id === reportId ? confirmedCloudReport : r));
      if (!cachedReports.some((r) => r.id === reportId)) {
        updatedList.unshift(confirmedCloudReport);
      }
      saveLocalCachedReports(citizenId, updatedList);

      return {
        success: true,
        report: confirmedCloudReport,
      };
    } catch (err: any) {
      console.warn('Failed to commit report withdrawal to Cloud Firestore:', err);

      // Check for security rule rejection (e.g. status transition violation or unauthorized user)
      if (
        err?.code === 'permission-denied' ||
        (typeof err?.message === 'string' && err.message.toLowerCase().includes('permission'))
      ) {
        removePendingWithdrawalIntent(citizenId, reportId);
        return {
          success: false,
          isPermanentRejection: true,
          error: 'This complaint can no longer be withdrawn. Its status may have already been updated by the municipal team.',
        };
      }

      // Check for offline / network unavailability
      const isOfflineErr =
        err?.code === 'unavailable' ||
        isOnline === false ||
        (typeof navigator !== 'undefined' && !navigator.onLine) ||
        (typeof err?.message === 'string' &&
          (err.message.toLowerCase().includes('offline') || err.message.toLowerCase().includes('network')));

      if (isOfflineErr) {
        // Persist withdrawal intent locally WITHOUT mutating official status to Withdrawn
        const hasDeviceStorage = typeof localStorage !== 'undefined';
        const persisted = hasDeviceStorage
          ? enqueuePendingWithdrawalIntent({
              reportId,
              userId: citizenId,
              requestedAt: now,
              reason: reason?.trim() || undefined,
            })
          : { success: false, error: 'Device storage is not available in this browser.' };

        if (hasDeviceStorage && !persisted.success) {
          return {
            success: false,
            isPendingSync: false,
            report: targetReport,
            error: `Network offline and could not save your withdrawal request on this device (${persisted.error || 'storage unavailable'}). Please retry once online.`,
          };
        }

        const safeReportPreserved: CivicIssueReport = {
          ...targetReport,
          status: normalizedStatus,
        };

        return {
          success: false,
          isPendingSync: true,
          report: safeReportPreserved,
          error: persisted.success
            ? 'Network offline: Your withdrawal request has been saved on this device. It will synchronize with municipal records once an internet connection is established.'
            : 'Network offline: Please reconnect to the internet to withdraw this report from municipal records.',
        };
      }

      // For any other Firestore write failure: never return success
      return {
        success: false,
        error: toUserFriendlyErrorMessage(err, 'withdraw_complaint'),
      };
    }
  }

  // Citizen is offline or not authenticated with Firebase Auth:
  // Persist the withdrawal intent to per-user localStorage queue BEFORE claiming it is saved.
  const hasDeviceStorage = typeof localStorage !== 'undefined';
  const persisted = hasDeviceStorage
    ? enqueuePendingWithdrawalIntent({
        reportId,
        userId: citizenId,
        requestedAt: now,
        reason: reason?.trim() || undefined,
      })
    : { success: false, error: 'Device storage is not available in this browser.' };

  if (hasDeviceStorage && !persisted.success) {
    return {
      success: false,
      isPendingSync: false,
      report: targetReport,
      error:
        'You are working offline and this device cannot persist a pending withdrawal queue. Please reconnect to the internet and sign in to withdraw this report.',
    };
  }

  return {
    success: false,
    isPendingSync: true,
    report: {
      ...targetReport,
      status: normalizedStatus,
    },
    error: persisted.success
      ? 'You are currently working offline. Your withdrawal request has been queued on this device and will synchronize when you reconnect and sign in.'
      : 'You are currently working offline. Please reconnect to the internet and sign in to withdraw this report from municipal records.',
  };
}

/**
 * Real-time subscription to citizen reports from Cloud Firestore for a specific user.
 * Invokes onUpdate callback whenever reports are created or updated by admins/citizens in Firestore.
 * Automatically synchronizes with local storage cache.
 * Returns an unsubscribe function to be called on component unmount.
 */
export function subscribeToUserReportsFromFirestore(
  userId: string,
  onUpdate: (reports: CivicIssueReport[]) => void,
  onError?: (err: Error) => void
): () => void {
  if (!userId) {
    onUpdate([]);
    return () => {};
  }

  const authenticatedUid = getVerifiedCitizenUid(userId);
  if (!authenticatedUid) {
    onUpdate([]);
    onError?.(new Error('Your authenticated citizen session does not match this report account.'));
    return () => {};
  }

  if (!isFirebaseConfigured || !db) {
    const cached = getLocalCachedReports(userId);
    onUpdate(cached);
    return () => {};
  }

  try {
    const reportsCol = collection(db, 'civic_reports');
    const userReportsQuery = query(reportsCol, where('userId', '==', userId));

    const unsubscribe = onSnapshot(
      userReportsQuery,
      (snapshot) => {
        const cloudReports: CivicIssueReport[] = [];
        const cloudIds = new Set<string>();

        snapshot.forEach((docSnap) => {
          const data = docSnap.data();
          if (data.userId !== authenticatedUid) return;
          cloudIds.add(docSnap.id);
          const normalizedCat = normalizeCivicCategory(data.category);
          cloudReports.push({
            id: docSnap.id,
            trackingNumber: data.trackingNumber || `CFX-2026-${docSnap.id.slice(0, 4)}`,
            category: normalizedCat as unknown as CivicCategory,
            normalizedCategory: normalizedCat,
            title: data.title || `${data.category || 'Civic'} Issue`,
            description: data.description || '',
            photoUrl: data.photoUrl || '',
            afterPhotoUrl: data.afterPhotoUrl || undefined,
            citizenName: data.citizenName || undefined,
            citizenEmail: data.citizenEmail || undefined,
            location: {
              address: data.location?.address || 'Manual Address Recorded',
              landmark: data.location?.landmark || undefined,
              latitude: isValidCoordinate(data.location?.latitude, data.location?.longitude)
                ? Number(data.location.latitude)
                : null,
              longitude: isValidCoordinate(data.location?.latitude, data.location?.longitude)
                ? Number(data.location.longitude)
                : null,
              ward: data.location?.ward || 'Unspecified Ward',
            },
            severity: (data.severity as ReportSeverity) || 'Low',
            status: normalizeReportStatus(data.status),
            submittedAt: (() => {
              const parsedMs = parseReportTimestamp(data.submittedAt);
              return parsedMs > 0 ? new Date(parsedMs).toISOString() : (typeof data.submittedAt === 'string' ? data.submittedAt : '');
            })(),
            updatedAt: (() => {
              const parsedMs = parseReportTimestamp(data.updatedAt);
              return parsedMs > 0 ? new Date(parsedMs).toISOString() : (typeof data.updatedAt === 'string' ? data.updatedAt : '');
            })(),
            department: data.department || data.assignedDepartment || 'Public Works & Municipal Administration',
            slaDeadline: data.slaDeadline || '48 Hours SLA',
            timeline: Array.isArray(data.timeline) ? data.timeline : [],
            citizenNotes: Array.isArray(data.citizenNotes) ? data.citizenNotes : [],
            userId: data.userId || userId,
            isDemo: false,
            syncedToCloud: true,
            storageSource: 'firestore',
            aiAnalysis: data.aiAnalysis || undefined,
            imageVerification: data.imageVerification || undefined,
            adminRemarks: data.adminRemarks || '',
            assignedOfficer: data.assignedOfficer || '',
            assignedDepartment: data.assignedDepartment || data.department || '',
            resolutionDetails: data.resolutionDetails || '',
            resolutionPhotoUrl: data.resolutionPhotoUrl || '',
            resolvedAt: normalizeOptionalReportTimestamp(data.resolvedAt) || '',
            updatedBy: data.updatedBy || undefined,
            duplicateOf: data.duplicateOf || undefined,
            withdrawnAt: normalizeOptionalReportTimestamp(data.withdrawnAt),
            withdrawnBy: data.withdrawnBy || undefined,
            withdrawalReason: data.withdrawalReason || undefined,
            archived: Boolean(data.archived),
            archivedAt: normalizeOptionalReportTimestamp(data.archivedAt),
            archivedBy: data.archivedBy || undefined,
            archiveReason: data.archiveReason || undefined,
          });
        });

        const cloudWithPendingNotes = mergePendingNotesIntoCloudReports(authenticatedUid, cloudReports);

        // Merge with unsynced local reports
        const localCached = filterReportsForCitizen(getLocalCachedReports(authenticatedUid), authenticatedUid);
        const pendingLocalReports = localCached.filter(
          (local) => !local.syncedToCloud && !cloudIds.has(local.id)
        );

        const combinedReports = [...cloudWithPendingNotes, ...pendingLocalReports];
        const sortedReports = sortReportsNewestFirst(combinedReports);

        saveLocalCachedReports(userId, sortedReports);
        onUpdate(sortedReports);
      },
      (err) => {
        console.warn('Real-time citizen reports snapshot error:', err);
        if (onError) onError(err);
      }
    );

    return unsubscribe;
  } catch (err: any) {
    console.warn('Failed to initialize real-time Firestore listener for citizen reports:', err);
    if (onError) onError(err);
    const cached = getLocalCachedReports(userId);
    onUpdate(cached);
    return () => {};
  }
}

export interface FetchCitizenStatusHistoryResult {
  entries: StatusHistoryEntry[];
  available: boolean;
  permissionDenied?: boolean;
  error?: string;
}

export interface FetchCitizenStatusHistoryDeps {
  currentUser?: { uid: string } | null;
  dbInstance?: any;
  isConfigured?: boolean;
  collectionFn?: (...args: any[]) => any;
  queryFn?: (...args: any[]) => any;
  orderByFn?: (...args: any[]) => any;
  limitFn?: (...args: any[]) => any;
  getDocsFn?: (q: any) => Promise<any>;
}

/**
 * Fetches `civic_reports/{reportId}/statusHistory` entries for a citizen-owned report.
 * Respects existing `firestore.rules` without modification:
 * - Never claims `statusHistory` is available unless a permitted read actually succeeds.
 * - Gracefully handles permission-denied / unauthenticated / offline failures so callers fall back to `report.timeline`.
 */
export async function fetchCitizenReportStatusHistory(
  reportId: string,
  expectedOwnerUid?: string,
  deps?: FetchCitizenStatusHistoryDeps
): Promise<FetchCitizenStatusHistoryResult> {
  if (!reportId) {
    return { entries: [], available: false, error: 'Invalid report ID.' };
  }

  const dbInstance = deps && 'dbInstance' in deps ? deps.dbInstance : db;
  const firebaseReady =
    deps && 'isConfigured' in deps
      ? Boolean(deps.isConfigured && dbInstance)
      : deps && 'dbInstance' in deps
      ? Boolean(deps.dbInstance)
      : Boolean(isFirebaseConfigured && db);
  const currentUser =
    deps && 'currentUser' in deps ? deps.currentUser : auth?.currentUser ?? null;

  if (!firebaseReady || !dbInstance) {
    return {
      entries: [],
      available: false,
      error: 'Cloud status history is unavailable offline.',
    };
  }

  if (!currentUser?.uid) {
    return {
      entries: [],
      available: false,
      permissionDenied: true,
      error: 'Authentication required to read municipal status history.',
    };
  }

  if (expectedOwnerUid && expectedOwnerUid !== currentUser.uid) {
    return {
      entries: [],
      available: false,
      permissionDenied: true,
      error: 'You are not authorized to view status history for another citizen\'s report.',
    };
  }

  try {
    const collectionFn = deps?.collectionFn ?? collection;
    const queryFn = deps?.queryFn ?? query;
    const orderByFn = deps?.orderByFn ?? orderBy;
    const limitFn = deps?.limitFn ?? limit;
    const getDocsFn = deps?.getDocsFn ?? getDocs;

    const historyCol = collectionFn(dbInstance, 'civic_reports', reportId, 'statusHistory');
    const q = queryFn(historyCol, orderByFn('timestamp', 'desc'), limitFn(50));
    const snapshot = await getDocsFn(q);

    const entries: StatusHistoryEntry[] = [];
    snapshot.forEach((docSnap: any) => {
      const data = typeof docSnap.data === 'function' ? docSnap.data() : {};
      entries.push({
        id: docSnap.id,
        reportId: data.reportId || reportId,
        fromStatus: data.fromStatus ? normalizeReportStatus(data.fromStatus) : null,
        toStatus: normalizeReportStatus(data.toStatus),
        changedByUid: data.changedByUid || '',
        changedByRole: data.changedByRole === 'admin' ? 'admin' : 'citizen',
        note: typeof data.note === 'string' ? data.note : '',
        timestamp: typeof data.timestamp === 'string' ? data.timestamp : '',
      });
    });

    return {
      entries,
      available: true,
    };
  } catch (err: any) {
    const msg = typeof err?.message === 'string' ? err.message : '';
    const isPerm =
      err?.code === 'permission-denied' || msg.toLowerCase().includes('permission');
    return {
      entries: [],
      available: false,
      permissionDenied: isPerm,
      error: isPerm
        ? 'Status history is currently unavailable for this complaint.'
        : toUserFriendlyErrorMessage(err, 'load_complaints'),
    };
  }
}
