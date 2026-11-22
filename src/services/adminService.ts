import {
  collection,
  doc,
  addDoc,
  getDocs,
  getDoc,
  deleteDoc,
  runTransaction,
  query,
  orderBy,
  limit,
  startAfter,
  documentId,
  onSnapshot,
  serverTimestamp,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import {
  browserLocalPersistence,
  browserSessionPersistence,
  GoogleAuthProvider,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  User,
} from 'firebase/auth';
import { ref as createStorageRef, deleteObject } from 'firebase/storage';
import {
  auth,
  db,
  storage,
  isFirebaseConfigured,
  uploadResolutionImageToStorage,
} from '../lib/firebase';
import {
  CivicCategory,
  CivicIssueReport,
  ReportStatus,
  VALID_REPORT_STATUSES,
  normalizeReportStatus,
  normalizeCivicCategory,
  EXPANDED_CIVIC_CATEGORIES,
  ExpandedCivicCategory,
  AdminRole,
  VALID_ADMIN_ROLES,
  normalizeAdminRole,
  ADMIN_ROLE_CAPABILITIES,
  AdminUser,
  AdminStats,
  CitizenSummary,
  TimelineEvent,
  StatusHistoryEntry,
  AuditLogEntry,
  resolveReportDepartment,
} from '../types/civic';
import {
  MAX_FIRESTORE_DOC_BYTES,
  normalizeOptionalReportTimestamp,
  parseReportTimestamp,
  sanitizeForFirestore,
  sortReportsNewestFirst,
} from './reportStorage';
import { estimateFirestoreDocumentSize } from './imageOptimizer';
import { isValidCoordinate } from '../utils/reportLocations';
import {
  generateSafeCitizenCode,
  sanitizeCitizenDisplayName,
  validateMeaningfulCivicText,
  validateOfficerName,
} from '../utils/inputValidation';
import {
  isFirebasePermissionError,
  toUserFriendlyErrorMessage,
} from '../utils/userFriendlyErrors';

export { VALID_REPORT_STATUSES, normalizeReportStatus };

export const VALID_STATUS_TRANSITIONS: Record<ReportStatus, readonly ReportStatus[]> = {
  Submitted: ['Under Review', 'Assigned', 'In Progress', 'Resolved', 'Rejected'],
  'Under Review': ['Assigned', 'In Progress', 'Resolved', 'Rejected'],
  Assigned: ['Under Review', 'In Progress', 'Resolved', 'Rejected'],
  'In Progress': ['Assigned', 'Resolved', 'Rejected'],
  Resolved: ['In Progress', 'Under Review'],
  Rejected: ['Under Review'],
  Withdrawn: [],
};

export function isValidStatusTransition(from: ReportStatus, to: ReportStatus): boolean {
  if (from === to) return true;
  const allowed = VALID_STATUS_TRANSITIONS[from] || [];
  return allowed.includes(to);
}

export interface AdminModalFormValues {
  status: ReportStatus;
  assignedDepartment: string;
  assignedOfficer: string;
  adminRemarks: string;
  resolutionDetails: string;
  resolutionPhotoUrl: string;
  duplicateOf: string;
}

export interface AdminModalReconcileResult {
  nextForm: AdminModalFormValues;
  conflictMessage: string | null;
}

export function extractAdminModalFormValues(report: CivicIssueReport): AdminModalFormValues {
  return {
    status: normalizeReportStatus(report.status),
    assignedDepartment: resolveReportDepartment(report),
    assignedOfficer: report.assignedOfficer || '',
    adminRemarks: report.adminRemarks || '',
    resolutionDetails: report.resolutionDetails || '',
    resolutionPhotoUrl: report.resolutionPhotoUrl || '',
    duplicateOf: report.duplicateOf || '',
  };
}

/**
 * Returns `true` when at least one editable control in the Update Status & Assignment
 * section differs from the currently persisted baseline report state.
 */
export function hasAdminModalFormChanges(
  currentForm: AdminModalFormValues,
  baselineReport: CivicIssueReport
): boolean {
  const baseline = extractAdminModalFormValues(baselineReport);
  if (normalizeReportStatus(currentForm.status) !== normalizeReportStatus(baseline.status)) {
    return true;
  }
  if (currentForm.assignedDepartment.trim() !== baseline.assignedDepartment.trim()) {
    return true;
  }
  if (currentForm.assignedOfficer.trim() !== baseline.assignedOfficer.trim()) {
    return true;
  }
  if (currentForm.adminRemarks.trim() !== baseline.adminRemarks.trim()) {
    return true;
  }
  if (currentForm.resolutionDetails.trim() !== baseline.resolutionDetails.trim()) {
    return true;
  }
  if ((currentForm.resolutionPhotoUrl || '') !== (baseline.resolutionPhotoUrl || '')) {
    return true;
  }
  if (currentForm.duplicateOf.trim() !== baseline.duplicateOf.trim()) {
    return true;
  }
  return false;
}

/**
 * Reconciles live incoming report updates into an open AdminReportDetailsModal
 * without overwriting unsaved administrator input, while detecting concurrent
 * status or field collisions that require deliberate admin review/refresh.
 */
export function reconcileAdminModalFormState(
  currentForm: AdminModalFormValues,
  baselineReport: CivicIssueReport,
  incomingReport: CivicIssueReport
): AdminModalReconcileResult {
  const baseline = extractAdminModalFormValues(baselineReport);
  const incoming = extractAdminModalFormValues(incomingReport);

  const fields: (keyof AdminModalFormValues)[] = [
    'status',
    'assignedDepartment',
    'assignedOfficer',
    'adminRemarks',
    'resolutionDetails',
    'resolutionPhotoUrl',
    'duplicateOf',
  ];

  const nextForm: AdminModalFormValues = { ...currentForm };
  const dirtyFields: (keyof AdminModalFormValues)[] = [];
  const collidingFields: (keyof AdminModalFormValues)[] = [];

  for (const field of fields) {
    const isDirty = currentForm[field] !== baseline[field];
    const changedRemotely = incoming[field] !== baseline[field];
    if (isDirty) {
      dirtyFields.push(field);
      nextForm[field] = currentForm[field] as never;
      if (changedRemotely && currentForm[field] !== incoming[field]) {
        collidingFields.push(field);
      }
    } else {
      nextForm[field] = incoming[field] as never;
    }
  }

  // Only consider dirty fields that diverge from the incoming snapshot so an admin's
  // own just-committed update echoing back from onSnapshot never triggers a false conflict.
  const hasDivergentDirtyEdits = dirtyFields.some(
    (field) => currentForm[field] !== incoming[field]
  );

  let conflictMessage: string | null = null;
  if (incomingReport.archived && !baselineReport.archived) {
    conflictMessage =
      'This complaint was archived by another administrator while the details window was open. Saving is disabled.';
  } else if (incoming.status === 'Withdrawn' && baseline.status !== 'Withdrawn') {
    conflictMessage =
      'This complaint was withdrawn by the citizen while the details window was open. Unsaved edits were preserved on screen, and saving is disabled.';
  } else if (
    incoming.status !== baseline.status &&
    (!isValidStatusTransition(incoming.status, currentForm.status) ||
      (currentForm.status !== baseline.status && currentForm.status !== incoming.status))
  ) {
    conflictMessage = `Another update was saved: complaint status changed from "${baseline.status}" to "${incoming.status}", which conflicts with your selection ("${currentForm.status}"). Review the latest details and click "Refresh Form" before saving.`;
  } else if (collidingFields.length > 0) {
    conflictMessage =
      'Another update was saved to fields you also modified. Your unsaved edits were preserved—review the latest details and click "Refresh Form" before saving.';
  } else if (incoming.status !== baseline.status && hasDivergentDirtyEdits) {
    conflictMessage = `Another update was saved: complaint status changed from "${baseline.status}" to "${incoming.status}" while you have unsaved edits. Review the latest details and click "Refresh Form" before saving.`;
  }

  return {
    nextForm,
    conflictMessage,
  };
}

enum FirestoreOperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: FirestoreOperationType;
  path: string | null;
  authInfo: {
    isAuthenticated: boolean;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
  };
}

function logFirestorePermissionError(
  error: unknown,
  operationType: FirestoreOperationType,
  path: string | null
): FirestoreErrorInfo {
  const currentUser = auth?.currentUser;
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path,
    authInfo: {
      isAuthenticated: Boolean(currentUser),
      emailVerified: currentUser?.emailVerified ?? null,
      isAnonymous: currentUser?.isAnonymous ?? null,
    },
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  return errInfo;
}

export interface VerifyAdminPrivilegesDeps {
  getAdminDocFn?: (uid: string) => Promise<{ exists: boolean; data: Record<string, any> | undefined }>;
  fetchFn?: typeof fetch;
}

/**
 * Zero-Trust Administrative Privilege Verification:
 * Grants administrative clearance ONLY via:
 * 1. Cryptographically verified Firebase ID token custom claim (`admin === true`), OR
 * 2. Explicit `/admins/{uid}` document in Cloud Firestore (`active !== false`), AND
 * 3. Server-side Firebase Admin token verification via `/api/admin/verify` in browser sessions.
 *
 * Security & Limitations:
 * - Preserves all 4 canonical roles: superadmin, department_head, ward_admin, staff.
 * - Explicitly denies accounts marked `active === false` when `/admins/{uid}` or claims are readable.
 * - Limitation: If the server endpoint is unreachable AND Firestore `/admins/{uid}` cannot be read
 *   (e.g., offline or missing server credentials), `active === false` cannot be verified from Firestore
 *   in that degraded state; token revocation/claims remain the active gate and email-only auth is never trusted.
 */
export async function verifyAdminPrivileges(
  user: User | null,
  deps?: VerifyAdminPrivilegesDeps
): Promise<{
  authorized: boolean;
  admin: AdminUser | null;
  isDeactivated?: boolean;
  reason?: 'unauthenticated' | 'unauthorized_citizen' | 'deactivated_admin' | 'verification_error';
  error?: string;
}> {
  if (!user || !user.email) {
    return {
      authorized: false,
      admin: null,
      reason: 'unauthenticated',
      error: 'Authentication required.',
    };
  }

  const normalizedEmail = user.email.trim().toLowerCase();
  let hasAdminClaim = false;
  let adminRole: AdminRole = 'department_head';
  let hasExplicitClaimRole = false;
  let isDeactivatedAdmin = false;
  let idToken = '';

  // 1. Inspect Firebase Auth Custom Claims & retrieve ID token
  try {
    if (typeof (user as any).getIdTokenResult === 'function') {
      const tokenResult = await (user as any).getIdTokenResult(true);
      if (tokenResult?.claims?.active === false) {
        isDeactivatedAdmin = true;
      }
      if (tokenResult?.claims?.admin === true && !isDeactivatedAdmin) {
        hasAdminClaim = true;
      }
      const rawClaimRole = tokenResult?.claims?.role;
      if (
        typeof rawClaimRole === 'string' &&
        (VALID_ADMIN_ROLES as readonly string[]).includes(
          rawClaimRole.trim().toLowerCase().replace(/[\s-]+/g, '_')
        )
      ) {
        adminRole = normalizeAdminRole(rawClaimRole, 'department_head');
        hasExplicitClaimRole = true;
      }
      if (typeof tokenResult?.token === 'string') {
        idToken = tokenResult.token;
      }
    }
    if (!idToken && typeof (user as any).getIdToken === 'function') {
      idToken = await (user as any).getIdToken();
    }
  } catch (claimErr) {
    console.warn('Unable to inspect Firebase Auth custom claims:', claimErr);
  }

  // 2. Check explicit /admins/{uid} document in Cloud Firestore
  let isFirestoreAdmin = false;
  let adminDepartment = 'Urban Infrastructure & Sanitation Services';
  let adminWard = 'Greater Municipal Jurisdiction (All Wards)';

  if (deps?.getAdminDocFn) {
    try {
      const docRes = await deps.getAdminDocFn(user.uid);
      if (docRes.exists) {
        const data = docRes.data || {};
        if (data.active !== true) {
          isDeactivatedAdmin = true;
          isFirestoreAdmin = false;
        } else {
          isFirestoreAdmin = true;
          if (typeof data.role === 'string' && data.role.trim()) {
            adminRole = normalizeAdminRole(data.role, hasExplicitClaimRole ? adminRole : 'staff');
          }
          if (typeof data.department === 'string' && data.department.trim()) {
            adminDepartment = data.department.trim();
          }
          if (typeof data.ward === 'string' && data.ward.trim()) {
            adminWard = data.ward.trim();
          }
        }
      }
    } catch {
      // Firestore admin document unavailable or denied by security rules
    }
  } else if (isFirebaseConfigured && db) {
    try {
      const adminDocRef = doc(db, 'admins', user.uid);
      const adminDocSnap = await getDoc(adminDocRef);
      if (adminDocSnap.exists()) {
        const data = adminDocSnap.data();
        if (data.active !== true) {
          isDeactivatedAdmin = true;
          isFirestoreAdmin = false;
        } else {
          isFirestoreAdmin = true;
          if (typeof data.role === 'string' && data.role.trim()) {
            adminRole = normalizeAdminRole(data.role, hasExplicitClaimRole ? adminRole : 'staff');
          }
          if (typeof data.department === 'string' && data.department.trim()) {
            adminDepartment = data.department.trim();
          }
          if (typeof data.ward === 'string' && data.ward.trim()) {
            adminWard = data.ward.trim();
          }
        }
      }
    } catch {
      // Firestore admin document unavailable or denied by security rules
    }
  }

  // Explicitly reject inactive administrator records even if a cached custom claim exists
  if (isDeactivatedAdmin) {
    return {
      authorized: false,
      admin: null,
      isDeactivated: true,
      reason: 'deactivated_admin',
      error: 'Access denied: This administrator account has been deactivated.',
    };
  }

  // 3. Verify with backend Firebase Admin SDK endpoint when in browser context
  const fetchFn = deps?.fetchFn ?? (typeof fetch === 'function' ? fetch : undefined);
  if ((typeof window !== 'undefined' || deps?.fetchFn) && fetchFn) {
    if (!idToken) {
      return {
        authorized: false,
        admin: null,
        reason: 'verification_error',
        error: 'Your session could not be verified. Please log in again.',
      };
    }

    try {
      const res = await fetchFn('/api/admin/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({}),
      });

      const data = await res.json().catch(() => ({}));
      if (res.ok && data.authorized === true) {
        // The browser uses direct Firestore reads/writes for the admin dashboard.
        // A server-only email allowlist is not sufficient; Firebase claims or an
        // active /admins/{uid} document must also authorize the client SDK.
        if (!hasAdminClaim && !isFirestoreAdmin) {
          return {
            authorized: false,
            admin: null,
            reason: 'unauthorized_citizen',
            error:
              'Administrator access is not provisioned for Firestore. Run the secure admin provisioning process, then sign in again.',
          };
        }
        return {
          authorized: true,
          admin: {
            uid: user.uid,
            email: normalizedEmail,
            displayName: user.displayName || 'Municipal Administrator',
            role: normalizeAdminRole(data.role, adminRole),
            department: data.department || adminDepartment,
            ward: adminWard,
            createdAt: user.metadata?.creationTime,
          },
        };
      }

      if (res.status === 401 || res.status === 403) {
        const deactivatedByServer = Boolean(data.inactive);
        return {
          authorized: false,
          admin: null,
          isDeactivated: deactivatedByServer,
          reason: deactivatedByServer ? 'deactivated_admin' : 'unauthorized_citizen',
          error:
            data.error ||
            'Access denied: This account does not have municipal administrator clearance.',
        };
      }
    } catch (err) {
      console.warn('Server-side admin verification endpoint unreachable:', err);
    }
  }

  // Allow ONLY if verified via Firebase custom claim or active Firestore /admins/{uid} document
  if (hasAdminClaim || isFirestoreAdmin) {
    return {
      authorized: true,
      admin: {
        uid: user.uid,
        email: normalizedEmail,
        displayName: user.displayName || 'Municipal Administrator',
        role: adminRole,
        department: adminDepartment,
        ward: adminWard,
        createdAt: user.metadata?.creationTime,
      },
    };
  }

  return {
    authorized: false,
    admin: null,
    isDeactivated: false,
    reason: 'unauthorized_citizen',
    error: 'Access denied: Citizen accounts do not have municipal administrator clearance.',
  };
}

export function getFriendlyAdminAuthErrorMessage(err: any): string {
  const code = err?.code || '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
      return 'Invalid administrator email or password. Please check your credentials and try again.';
    case 'auth/user-not-found':
      return 'No administrator account was found for this email address.';
    case 'auth/invalid-email':
      return 'Please enter a valid administrator email address.';
    case 'auth/user-disabled':
      return 'This administrator account has been disabled. Please contact system support.';
    case 'auth/missing-password':
      return 'Please enter your administrator password.';
    case 'auth/too-many-requests':
      return 'Too many failed sign-in attempts. Please wait a few minutes or reset your password.';
    case 'auth/network-request-failed':
      return 'Network connection error. Please check your internet connection and try again.';
    default:
      return 'Administrative login failed. Please verify your email and password.';
  }
}

export interface AdminSignInDeps {
  authInstance?: typeof auth;
  setPersistenceFn?: typeof setPersistence;
  signInFn?: typeof signInWithEmailAndPassword;
  verifyAdminFn?: typeof verifyAdminPrivileges;
  signOutFn?: typeof signOut;
}

/**
 * Authenticates an administrator using Firebase Email & Password,
 * configures Firebase Auth persistence based on "Remember me",
 * and strictly verifies their administrative authorization.
 */
export async function signInAdminWithCredentials(
  email: string,
  pass: string,
  rememberMe: boolean = true,
  deps?: AdminSignInDeps
): Promise<{ success: boolean; admin: AdminUser | null; error?: string }> {
  const trimmedEmail = (email || '').trim();
  if (!trimmedEmail) {
    return {
      success: false,
      admin: null,
      error: 'Please enter your administrator email address.',
    };
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(trimmedEmail)) {
    return {
      success: false,
      admin: null,
      error: 'Please enter a valid administrator email address.',
    };
  }
  if (!pass) {
    return {
      success: false,
      admin: null,
      error: 'Please enter your administrator password.',
    };
  }

  const authInstance = deps?.authInstance ?? auth;
  const setPersistenceFn = deps?.setPersistenceFn ?? setPersistence;
  const signInFn = deps?.signInFn ?? signInWithEmailAndPassword;
  const verifyAdminFn = deps?.verifyAdminFn ?? verifyAdminPrivileges;
  const signOutFn = deps?.signOutFn ?? signOut;

  try {
    if (authInstance && typeof setPersistenceFn === 'function') {
      await setPersistenceFn(
        authInstance,
        rememberMe ? browserLocalPersistence : browserSessionPersistence
      ).catch(() => {});
    }

    const credential = await signInFn(authInstance, trimmedEmail, pass);
    const verification = await verifyAdminFn(credential.user);

    if (!verification.authorized) {
      await signOutFn(authInstance).catch(() => {});
      return {
        success: false,
        admin: null,
        error:
          verification.error ||
          'Access Denied: This account is not authorized to access the municipal administrator dashboard.',
      };
    }

    return {
      success: true,
      admin: verification.admin,
    };
  } catch (err: any) {
    return {
      success: false,
      admin: null,
      error: getFriendlyAdminAuthErrorMessage(err),
    };
  }
}

export interface AdminPasswordResetDeps {
  authInstance?: typeof auth;
  sendResetFn?: typeof sendPasswordResetEmail;
}

/**
 * Sends a Firebase Password Reset link to an administrator email address.
 */
export async function sendAdminPasswordReset(
  email: string,
  deps?: AdminPasswordResetDeps
): Promise<{ success: boolean; message: string }> {
  const trimmedEmail = (email || '').trim();
  if (!trimmedEmail) {
    return {
      success: false,
      message: 'Please enter your administrator email address.',
    };
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(trimmedEmail)) {
    return {
      success: false,
      message: 'Please enter a valid email address format (e.g. admin@domain.com).',
    };
  }

  const authInstance = deps?.authInstance ?? auth;
  const sendResetFn = deps?.sendResetFn ?? sendPasswordResetEmail;

  if (!authInstance) {
    return {
      success: false,
      message: 'Password reset service is currently unavailable. Please try again later.',
    };
  }

  try {
    await sendResetFn(authInstance, trimmedEmail);
    return {
      success: true,
      message: `Password reset instructions have been sent to ${trimmedEmail}. Please check your inbox and spam folder.`,
    };
  } catch (err: any) {
    const code = err?.code || '';
    if (code === 'auth/user-not-found') {
      return {
        success: false,
        message: 'No account was found for this email address.',
      };
    }
    if (code === 'auth/invalid-email') {
      return {
        success: false,
        message: 'Please enter a valid administrator email address.',
      };
    }
    if (code === 'auth/too-many-requests') {
      return {
        success: false,
        message: 'Too many reset requests. Please wait a few moments before trying again.',
      };
    }
    if (code === 'auth/network-request-failed') {
      return {
        success: false,
        message: 'Network connection error. Please check your internet connection and try again.',
      };
    }
    return {
      success: false,
      message: 'Could not send password reset email right now. Please try again.',
    };
  }
}

/**
 * Authenticates an administrator using Google Sign-In (Firebase Auth popup)
 * and enforces strict zero-trust admin privilege verification.
 */
export async function signInAdminWithGoogle(): Promise<{
  success: boolean;
  admin: AdminUser | null;
  error?: string;
}> {
  if (!isFirebaseConfigured || !auth) {
    return {
      success: false,
      admin: null,
      error: 'Sign-in service is temporarily unavailable. Please try again later.',
    };
  }

  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const credential = await signInWithPopup(auth, provider);
    const verification = await verifyAdminPrivileges(credential.user);

    if (!verification.authorized) {
      await signOut(auth);
      return {
        success: false,
        admin: null,
        error:
          verification.error ||
          'Access Denied: Your Google account does not have municipal administrator clearance.',
      };
    }

    return {
      success: true,
      admin: verification.admin,
    };
  } catch (err: any) {
    console.error('Admin Google Sign-In error:', err);
    let message = 'Google Sign-In failed. Please try again.';
    if (err?.code === 'auth/popup-closed-by-user' || err?.code === 'auth/cancelled-popup-request') {
      message = 'Google Sign-In was cancelled before completion.';
    } else if (err?.code === 'auth/popup-blocked') {
      message = 'Popup was blocked by your browser. Please allow popups for this site and retry.';
    } else if (err?.code === 'auth/unauthorized-domain') {
      message = 'Google Sign-In is currently unavailable on this address. Please sign in with email and password.';
    }
    return { success: false, admin: null, error: message };
  }
}

/**
 * Signs out the administrator from Firebase Auth.
 */
export async function signOutAdmin(
  deps?: { authInstance?: typeof auth; signOutFn?: typeof signOut }
): Promise<void> {
  const authInstance = deps?.authInstance ?? auth;
  const signOutFn = deps?.signOutFn ?? signOut;
  await signOutFn(authInstance);
}

function formatNormalizedReportTimestamp(rawVal: unknown): string {
  const parsedMs = parseReportTimestamp(rawVal);
  if (parsedMs > 0) {
    return new Date(parsedMs).toISOString();
  }
  return typeof rawVal === 'string' ? rawVal : '';
}

/**
 * Normalizes a raw Firestore `civic_reports` document into a canonical `CivicIssueReport`.
 * Preserves mixed Firestore Timestamp / ISO-string dates and keeps missing dates empty
 * rather than fabricating `new Date().toISOString()`.
 */
export function mapFirestoreDocToReport(
  id: string,
  data: Record<string, any>
): CivicIssueReport {
  const normalizedCat = normalizeCivicCategory(data.category);
  const resolvedSubmittedAt = formatNormalizedReportTimestamp(
    data.submittedAt !== undefined && data.submittedAt !== null && data.submittedAt !== ''
      ? data.submittedAt
      : data.updatedAt
  );
  const resolvedUpdatedAt = formatNormalizedReportTimestamp(data.updatedAt);

  const hasValidCoords = isValidCoordinate(
    data.location?.latitude,
    data.location?.longitude
  );

  return {
    id,
    trackingNumber: data.trackingNumber || `CFX-2026-${id.slice(0, 4).toUpperCase()}`,
    category: normalizedCat as unknown as CivicCategory,
    normalizedCategory: normalizedCat,
    title: data.title || `${data.category || 'Civic'} Issue`,
    description: data.description || '',
    photoUrl: data.photoUrl || '',
    afterPhotoUrl: data.afterPhotoUrl || undefined,
    citizenName: data.citizenName || undefined,
    citizenEmail: data.citizenEmail || undefined,
    location: {
      address: data.location?.address || 'Location provided',
      landmark: data.location?.landmark || '',
      latitude: hasValidCoords ? Number(data.location.latitude) : null,
      longitude: hasValidCoords ? Number(data.location.longitude) : null,
      ward: data.location?.ward || 'Unspecified Ward',
    },
    severity: data.severity || 'Medium',
    status: normalizeReportStatus(data.status),
    submittedAt: resolvedSubmittedAt,
    updatedAt: resolvedUpdatedAt,
    department: data.department || data.assignedDepartment || 'General Municipal Administration',
    slaDeadline: data.slaDeadline || '72 Hours',
    timeline: Array.isArray(data.timeline) ? data.timeline : [],
    citizenNotes: Array.isArray(data.citizenNotes) ? data.citizenNotes : [],
    userId: data.userId || '',
    storageSource: 'firestore',
    adminRemarks: data.adminRemarks || '',
    assignedOfficer: data.assignedOfficer || '',
    assignedDepartment: data.assignedDepartment || data.department || '',
    resolutionDetails: data.resolutionDetails || '',
    resolutionPhotoUrl: data.resolutionPhotoUrl || '',
    resolvedAt: data.resolvedAt || '',
    updatedBy: data.updatedBy || undefined,
    duplicateOf: data.duplicateOf || undefined,
    withdrawnAt: data.withdrawnAt || undefined,
    withdrawnBy: data.withdrawnBy || undefined,
    withdrawalReason: data.withdrawalReason || undefined,
    archived: Boolean(data.archived),
    archivedAt: normalizeOptionalReportTimestamp(data.archivedAt),
    archivedBy: data.archivedBy || undefined,
    archiveReason: data.archiveReason || undefined,
    aiAnalysis: data.aiAnalysis,
    imageVerification: data.imageVerification || undefined,
  };
}

/**
 * Merges and deduplicates report batches by `report.id`, sorting newest first
 * using `parseReportTimestamp` (placing missing/invalid timestamps at the bottom).
 */
export function mergeAndDeduplicateReports(
  ...batches: CivicIssueReport[][]
): CivicIssueReport[] {
  const byId = new Map<string, CivicIssueReport>();
  for (const batch of batches) {
    for (const rep of batch) {
      if (rep && rep.id) {
        byId.set(rep.id, rep);
      }
    }
  }
  return sortReportsNewestFirst(Array.from(byId.values()));
}

export type AdminReportsPaginationMode = 'documentId' | 'submittedAt';

export interface AdminReportsPageResult {
  reports: CivicIssueReport[];
  fromCloud: boolean;
  mode: AdminReportsPaginationMode;
  hasMore: boolean;
  nextCursor: QueryDocumentSnapshot<DocumentData> | null;
  loadedCount: number;
  isComplete: boolean;
  retrievalNotice?: string;
  error?: string;
}

/**
 * Cursor-paginated bounded loader for Cloud Firestore `civic_reports`.
 *
 * Modes:
 * - `'documentId'` (default): Uses `orderBy(documentId())` so bounded batches can scan the
 *   ENTIRE `civic_reports` collection deterministically, including legacy records missing both
 *   `submittedAt` and `updatedAt` or containing mixed Timestamp / ISO-string types.
 * - `'submittedAt'`: Uses `orderBy('submittedAt', 'desc')` for recent ordered paging; note that
 *   Firestore excludes documents missing `submittedAt` and orders `string` separately from `Timestamp`.
 */
export async function fetchAdminReportsPage(options?: {
  pageSize?: number;
  cursor?: QueryDocumentSnapshot<DocumentData> | null;
  mode?: AdminReportsPaginationMode;
}): Promise<AdminReportsPageResult> {
  const mode: AdminReportsPaginationMode = options?.mode ?? 'documentId';
  const pageSize = Math.max(1, Math.min(options?.pageSize ?? 100, 500));

  if (!isFirebaseConfigured || !db) {
    return {
      reports: [],
      fromCloud: false,
      mode,
      hasMore: false,
      nextCursor: null,
      loadedCount: 0,
      isComplete: false,
      error: 'Unable to refresh the latest information.',
    };
  }

  try {
    const reportsRef = collection(db, 'civic_reports');
    const orderConstraint =
      mode === 'submittedAt' ? orderBy('submittedAt', 'desc') : orderBy(documentId());
    const constraints = options?.cursor
      ? [orderConstraint, startAfter(options.cursor), limit(pageSize)]
      : [orderConstraint, limit(pageSize)];

    const snapshot = await getDocs(query(reportsRef, ...constraints));
    const pageReports: CivicIssueReport[] = [];
    snapshot.forEach((docSnap) => {
      pageReports.push(mapFirestoreDocToReport(docSnap.id, docSnap.data()));
    });

    const hasMore = snapshot.docs.length === pageSize;
    const nextCursor = hasMore ? snapshot.docs[snapshot.docs.length - 1] : null;
    const isComplete = mode === 'documentId' && !options?.cursor && !hasMore;

    return {
      reports: sortReportsNewestFirst(pageReports),
      fromCloud: true,
      mode,
      hasMore,
      nextCursor,
      loadedCount: pageReports.length,
      isComplete,
      retrievalNotice: isComplete
        ? `Loaded all ${pageReports.length} complaints.`
        : `Loaded ${pageReports.length} additional complaints${hasMore ? '; more historical complaints may exist.' : '.'}`,
    };
  } catch (err: any) {
    const isPermissionDenied = isFirebasePermissionError(err);
    if (isPermissionDenied) {
      logFirestorePermissionError(err, FirestoreOperationType.LIST, 'civic_reports');
    } else {
      console.error('Failed to load paginated reports from Cloud Firestore:', err);
    }
    return {
      reports: [],
      fromCloud: false,
      mode,
      hasMore: false,
      nextCursor: null,
      loadedCount: 0,
      isComplete: false,
      error: toUserFriendlyErrorMessage(err, 'load_complaints'),
    };
  }
}

export interface FetchAdminReportsResult {
  reports: CivicIssueReport[];
  fromCloud: boolean;
  loadedCount?: number;
  hasMore?: boolean;
  nextCursor?: QueryDocumentSnapshot<DocumentData> | null;
  isComplete?: boolean;
  retrievalNotice?: string;
  error?: string;
}

/**
 * Retrieves a bounded, deduplicated window of citizen reports for authorized administrators.
 *
 * Retrieval Strategy & Limitations:
 * - Combines bounded `orderBy('submittedAt', 'desc')`, companion `orderBy('updatedAt', 'desc')`,
 *   and a bounded `orderBy(documentId())` pass so legacy documents (mixed Timestamp/ISO strings
 *   or missing both `submittedAt` and `updatedAt`) are surfaced and deduplicated cleanly.
 * - Never claims all complaints are loaded if any bounded pass reaches its limit; sets
 *   `isComplete: false` and `hasMore: true` with a `documentId()` `nextCursor` for full scanning.
 */
export async function fetchAllReportsForAdmin(options?: {
  batchLimit?: number;
  legacyScanLimit?: number;
}): Promise<FetchAdminReportsResult> {
  if (!isFirebaseConfigured || !db) {
    return {
      reports: [],
      fromCloud: false,
      loadedCount: 0,
      hasMore: false,
      nextCursor: null,
      isComplete: false,
      error: 'Unable to refresh the latest information.',
    };
  }

  const batchLimit = Math.max(1, Math.min(options?.batchLimit ?? 300, 500));
  const legacyLimit = Math.max(1, Math.min(options?.legacyScanLimit ?? 150, 500));

  try {
    const reportsRef = collection(db, 'civic_reports');

    let permissionDeniedError: any = null;
    const capturePermissionError = (err: any) => {
      if (isFirebasePermissionError(err)) {
        permissionDeniedError = permissionDeniedError || err;
      }
      return null;
    };

    const submittedPromise = getDocs(
      query(reportsRef, orderBy('submittedAt', 'desc'), limit(batchLimit))
    ).catch(capturePermissionError);
    const updatedPromise = getDocs(
      query(reportsRef, orderBy('updatedAt', 'desc'), limit(legacyLimit))
    ).catch(capturePermissionError);
    const docIdPromise = getDocs(
      query(reportsRef, orderBy(documentId()), limit(legacyLimit))
    ).catch(capturePermissionError);

    const [submittedSnap, updatedSnap, docIdSnap] = await Promise.all([
      submittedPromise,
      updatedPromise,
      docIdPromise,
    ]);

    if (!submittedSnap && !updatedSnap && !docIdSnap) {
      if (permissionDeniedError) {
        throw permissionDeniedError;
      }
      // Final bounded fallback if all ordered queries failed (e.g., index error)
      const fallbackSnap = await getDocs(query(reportsRef, limit(batchLimit)));
      const fallbackReports: CivicIssueReport[] = [];
      fallbackSnap.forEach((docSnap) => {
        fallbackReports.push(mapFirestoreDocToReport(docSnap.id, docSnap.data()));
      });
      const sortedFallback = mergeAndDeduplicateReports(fallbackReports);
      const hitLimit = fallbackSnap.docs.length === batchLimit;
      return {
        reports: sortedFallback,
        fromCloud: true,
        loadedCount: sortedFallback.length,
        hasMore: hitLimit,
        nextCursor: null,
        isComplete: !hitLimit,
        retrievalNotice: hitLimit
          ? `Showing ${sortedFallback.length} recent complaints; older records can be loaded below.`
          : `Loaded ${sortedFallback.length} complaints.`,
      };
    }

    const extractBatch = (snap: Awaited<typeof submittedPromise>): CivicIssueReport[] => {
      if (!snap) return [];
      const list: CivicIssueReport[] = [];
      snap.forEach((docSnap) => {
        list.push(mapFirestoreDocToReport(docSnap.id, docSnap.data()));
      });
      return list;
    };

    const merged = mergeAndDeduplicateReports(
      extractBatch(submittedSnap),
      extractBatch(updatedSnap),
      extractBatch(docIdSnap)
    );

    // Collection completeness is ONLY guaranteed if the documentId() scan from start finished below legacyLimit
    const docIdScanComplete = Boolean(docIdSnap && docIdSnap.docs.length < legacyLimit);
    const hasMore = !docIdScanComplete;
    const nextCursor =
      docIdSnap && docIdSnap.docs.length === legacyLimit
        ? docIdSnap.docs[docIdSnap.docs.length - 1]
        : null;

    return {
      reports: merged,
      fromCloud: true,
      loadedCount: merged.length,
      hasMore,
      nextCursor,
      isComplete: docIdScanComplete,
      retrievalNotice: docIdScanComplete
        ? `All ${merged.length} complaints loaded.`
        : `Showing ${merged.length} recent complaints; use "Load Older Records" to view earlier submissions.`,
    };
  } catch (err: any) {
    const isPermissionDenied = isFirebasePermissionError(err);
    if (isPermissionDenied) {
      logFirestorePermissionError(err, FirestoreOperationType.LIST, 'civic_reports');
    } else {
      console.error('Failed to load all reports from Cloud Firestore:', err);
    }
    return {
      reports: [],
      fromCloud: false,
      loadedCount: 0,
      hasMore: false,
      nextCursor: null,
      isComplete: false,
      error: toUserFriendlyErrorMessage(err, 'load_complaints'),
    };
  }
}

/**
 * Real-time bounded subscription to citizen reports from Cloud Firestore for authorized administrators.
 *
 * Strategy & Limitations:
 * - Listens to a primary `orderBy('submittedAt', 'desc')` window plus a companion
 *   `orderBy('updatedAt', 'desc')` window (merging and deduplicating by `doc.id` and sorting
 *   client-side via `parseReportTimestamp`) so updates across mixed Timestamp / ISO-string
 *   records appear in real time.
 * - Bounded by `limit()` for scalability; documents beyond the live window or missing both
 *   `submittedAt` and `updatedAt` require `fetchAdminReportsPage({ mode: 'documentId' })`.
 */
export function subscribeToAllReportsForAdmin(
  onUpdate: (reports: CivicIssueReport[]) => void,
  onError?: (err: Error) => void,
  options?: { realtimeLimit?: number }
): () => void {
  if (!isFirebaseConfigured || !db) {
    if (onError) onError(new Error('Unable to refresh the latest information.'));
    return () => {};
  }

  const realtimeLimit = Math.max(1, Math.min(options?.realtimeLimit ?? 300, 500));
  const legacyWindowLimit = Math.min(100, realtimeLimit);

  try {
    const reportsRef = collection(db, 'civic_reports');
    const primaryMap = new Map<string, CivicIssueReport>();
    const companionMap = new Map<string, CivicIssueReport>();

    const emitMerged = () => {
      const combined = mergeAndDeduplicateReports(
        Array.from(companionMap.values()),
        Array.from(primaryMap.values())
      );
      onUpdate(combined);
    };

    const primaryQuery = query(reportsRef, orderBy('submittedAt', 'desc'), limit(realtimeLimit));
    const companionQuery = query(reportsRef, orderBy('updatedAt', 'desc'), limit(legacyWindowLimit));

    const unsubPrimary = onSnapshot(
      primaryQuery,
      (snapshot) => {
        primaryMap.clear();
        snapshot.forEach((docSnap) => {
          primaryMap.set(docSnap.id, mapFirestoreDocToReport(docSnap.id, docSnap.data()));
        });
        emitMerged();
      },
      (err) => {
        console.warn('Real-time admin reports primary snapshot error:', err);
        if (onError) onError(err);
      }
    );

    const unsubCompanion = onSnapshot(
      companionQuery,
      (snapshot) => {
        companionMap.clear();
        snapshot.forEach((docSnap) => {
          companionMap.set(docSnap.id, mapFirestoreDocToReport(docSnap.id, docSnap.data()));
        });
        emitMerged();
      },
      (err) => {
        // Non-fatal if companion listener encounters an index or transient error
        console.warn('Real-time admin reports companion snapshot notice:', err);
      }
    );

    return () => {
      try {
        unsubPrimary();
      } catch {
        // ignore unsubscribe cleanup error
      }
      try {
        unsubCompanion();
      } catch {
        // ignore unsubscribe cleanup error
      }
    };
  } catch (err: any) {
    console.warn('Failed to subscribe to all reports for admin:', err);
    if (onError) onError(err);
    return () => {};
  }
}

export interface UpdateReportStatusDeps {
  currentUser?: { uid: string; email?: string | null } | null;
  dbInstance?: any;
  verifyAdminFn?: typeof verifyAdminPrivileges;
  uploadResolutionFn?: typeof uploadResolutionImageToStorage;
  cleanupUploadedResolutionFn?: (uploadedUrl: string) => Promise<void>;
  runTransactionFn?: typeof runTransaction;
  addDocFn?: typeof addDoc;
  docFn?: typeof doc;
  collectionFn?: typeof collection;
}

async function cleanupUploadedResolutionObject(
  uploadedUrl: string,
  reportId: string
): Promise<void> {
  if (
    !storage ||
    !uploadedUrl ||
    !uploadedUrl.startsWith('https://')
  ) {
    return;
  }

  // Strictly guard that we only ever attempt to delete an object under `resolutions/{reportId}/`.
  // Never touch citizen complaint photos under `reports/...`.
  let decodedPath = '';
  try {
    decodedPath = decodeURIComponent(uploadedUrl);
  } catch {
    decodedPath = uploadedUrl;
  }
  if (!decodedPath.includes(`resolutions/${reportId}/`)) {
    return;
  }

  try {
    const objRef = createStorageRef(storage, uploadedUrl);
    await deleteObject(objRef);
  } catch (cleanupErr) {
    // Best-effort cleanup: storage.rules or offline mode may disallow deleteObject
    console.warn('Best-effort cleanup of unused resolution upload notice:', cleanupErr);
  }
}

/**
 * Updates a report's status, remarks, assignment, duplicate link, and resolution photo in Cloud Firestore.
 *
 * Guarantees:
 * 1. Enforces status-transition validation against LIVE Firestore status inside `runTransaction`.
 * 2. Preserves concurrent `citizenNotes`, existing `photoUrl`, `aiAnalysis`, `imageVerification`,
 *    and appends onto the live `timeline` without overwriting concurrent citizen updates.
 * 3. Rejects writes whose complete final merged document exceeds conservative `MAX_FIRESTORE_DOC_BYTES`
 *    (800 KiB JSON UTF-8 estimate via `estimateFirestoreDocumentSize`) BEFORE writing to Firestore.
 * 4. Performs best-effort cleanup of any newly uploaded `resolutions/{reportId}/...` Storage object
 *    if the Firestore transaction fails, without ever touching citizen complaint photos.
 * 5. Preserves post-commit `statusHistory` and `auditLogs` side effects.
 */
export interface AdminUpdateReportPersistedFields {
  status: ReportStatus;
  updatedAt: string;
  updatedBy: string;
  resolvedAt?: string;
  adminRemarks?: string;
  assignedDepartment?: string;
  department?: string;
  assignedOfficer?: string;
  resolutionDetails?: string;
  resolutionPhotoUrl?: string;
  duplicateOf?: string;
  timeline: TimelineEvent[];
}

export async function updateReportStatusByAdmin(
  reportId: string,
  updates: {
    status: ReportStatus;
    previousStatus?: ReportStatus;
    adminRemarks?: string;
    assignedDepartment?: string;
    assignedOfficer?: string;
    resolutionDetails?: string;
    resolutionPhotoUrl?: string;
    duplicateOf?: string;
    currentTimeline?: TimelineEvent[];
  },
  deps?: UpdateReportStatusDeps
): Promise<{
  success: boolean;
  error?: string;
  updatedFields?: AdminUpdateReportPersistedFields;
}> {
  const dbInstance = deps && 'dbInstance' in deps ? deps.dbInstance : db;
  const configured = deps && 'isConfigured' in deps ? Boolean(deps.isConfigured) : isFirebaseConfigured;
  if (!configured || !dbInstance) {
    return { success: false, error: 'Database is not configured.' };
  }

  if (updates.previousStatus && !isValidStatusTransition(updates.previousStatus, updates.status)) {
    return {
      success: false,
      error: `Invalid workflow transition: cannot move report directly from "${updates.previousStatus}" to "${updates.status}".`,
    };
  }

  if (
    updates.status === 'Resolved' &&
    ((updates.resolutionDetails !== undefined && !updates.resolutionDetails.trim()) ||
      (updates.resolutionDetails === undefined &&
        updates.previousStatus !== undefined &&
        updates.previousStatus !== 'Resolved'))
  ) {
    return {
      success: false,
      error: 'Resolution details are required before marking a report as Resolved.',
    };
  }

  if (updates.adminRemarks?.trim()) {
    const remarksValidation = validateMeaningfulCivicText(updates.adminRemarks, {
      fieldLabel: 'Official remarks',
      minLength: 2,
      required: false,
      allowShortConcise: true,
    });
    if (!remarksValidation.valid) {
      return {
        success: false,
        error: remarksValidation.error,
      };
    }
  }

  if (updates.resolutionDetails?.trim()) {
    const resValidation = validateMeaningfulCivicText(updates.resolutionDetails, {
      fieldLabel: 'Resolution summary',
      minLength: 2,
      required: updates.status === 'Resolved',
      allowShortConcise: true,
    });
    if (!resValidation.valid) {
      return {
        success: false,
        error: resValidation.error,
      };
    }
  }

  if (updates.assignedOfficer?.trim()) {
    const officerValidation = validateOfficerName(updates.assignedOfficer);
    if (!officerValidation.valid) {
      return {
        success: false,
        error: officerValidation.error,
      };
    }
  }

  const currentUser =
    deps && 'currentUser' in deps ? deps.currentUser : auth?.currentUser;
  if (!currentUser) {
    logFirestorePermissionError(
      new Error('Missing authenticated Firebase administrator session.'),
      FirestoreOperationType.UPDATE,
      `civic_reports/${reportId}`
    );
    return {
      success: false,
      error: 'Your session has expired. Please log in again.',
    };
  }

  const verifyAdminFn = deps?.verifyAdminFn ?? verifyAdminPrivileges;
  const adminVerification = await verifyAdminFn(currentUser as User);
  if (!adminVerification.authorized) {
    logFirestorePermissionError(
      new Error(adminVerification.error || 'Account lacks municipal administrator privileges.'),
      FirestoreOperationType.UPDATE,
      `civic_reports/${reportId}`
    );
    return {
      success: false,
      error:
        adminVerification.error ||
        'Access denied: You are not authorized to perform this action.',
    };
  }

  const uploadResolutionFn = deps?.uploadResolutionFn ?? uploadResolutionImageToStorage;
  const cleanupFn =
    deps?.cleanupUploadedResolutionFn ??
    ((url: string) => cleanupUploadedResolutionObject(url, reportId));

  let newlyUploadedResolutionUrl: string | null = null;

  try {
    const docFn = deps?.docFn ?? doc;
    const collectionFn = deps?.collectionFn ?? collection;
    const runTransactionFn = deps?.runTransactionFn ?? runTransaction;
    const addDocFn = deps?.addDocFn ?? addDoc;

    const reportRef = docFn(dbInstance, 'civic_reports', reportId);
    const nowIso = new Date().toISOString();

    // Upload resolution photo to Firebase Storage BEFORE transaction so Storage uploads never
    // re-run inside Firestore optimistic transaction retries.
    let photoUrlToStore = updates.resolutionPhotoUrl;
    if (photoUrlToStore && photoUrlToStore.startsWith('data:')) {
      try {
        const uploadRes = await uploadResolutionFn(reportId, photoUrlToStore);
        if (uploadRes?.url) {
          if (
            uploadRes.success === true &&
            uploadRes.url.startsWith('https://') &&
            uploadRes.url !== photoUrlToStore
          ) {
            newlyUploadedResolutionUrl = uploadRes.url;
          }
          photoUrlToStore = uploadRes.url;
        }
      } catch (uploadErr) {
        console.warn('Firebase Storage upload error for resolution photo:', uploadErr);
      }
    }

    const txOutcome = await runTransactionFn(dbInstance, async (transaction) => {
      const liveSnap = await transaction.get(reportRef);
      if (!liveSnap.exists()) {
        const notFoundErr: any = new Error('This complaint could not be found.');
        notFoundErr.isDomainValidation = true;
        throw notFoundErr;
      }

      const liveData = (liveSnap.data() || {}) as Record<string, any>;
      if (liveData.archived === true) {
        const archivedErr: any = new Error(
          'This complaint has been archived and can no longer be modified.'
        );
        archivedErr.isDomainValidation = true;
        throw archivedErr;
      }

      const liveStatus = normalizeReportStatus(liveData.status);

      if (liveStatus === 'Withdrawn') {
        const withdrawnErr: any = new Error(
          'This complaint was withdrawn by the citizen and cannot be updated directly. Use "Reopen Complaint" if municipal review is required.'
        );
        withdrawnErr.isDomainValidation = true;
        throw withdrawnErr;
      }

      if (!isValidStatusTransition(liveStatus, updates.status)) {
        const transitionErr: any = new Error(
          `Invalid workflow transition: cannot move report from "${liveStatus}" to "${updates.status}".`
        );
        transitionErr.isDomainValidation = true;
        throw transitionErr;
      }

      if (updates.status === 'Resolved') {
        const effectiveResolutionDetails =
          updates.resolutionDetails !== undefined
            ? updates.resolutionDetails.trim()
            : typeof liveData.resolutionDetails === 'string'
            ? liveData.resolutionDetails.trim()
            : '';
        if (!effectiveResolutionDetails) {
          const resErr: any = new Error(
            'Resolution details are required before marking a report as Resolved.'
          );
          resErr.isDomainValidation = true;
          throw resErr;
        }
      }

      const isTransition = liveStatus !== updates.status;
      const trimmedDept =
        updates.assignedDepartment !== undefined
          ? updates.assignedDepartment.trim()
          : undefined;
      const trimmedOfficer =
        updates.assignedOfficer !== undefined ? updates.assignedOfficer.trim() : undefined;
      const trimmedRemarks =
        updates.adminRemarks !== undefined ? updates.adminRemarks.trim() : undefined;
      const trimmedResolutionDetails =
        updates.resolutionDetails !== undefined
          ? updates.resolutionDetails.trim()
          : undefined;
      const trimmedDuplicateOf =
        updates.duplicateOf !== undefined ? updates.duplicateOf.trim() : undefined;

      const summaryParts: string[] = [];
      if (isTransition) {
        summaryParts.push(`Status changed from "${liveStatus}" to "${updates.status}".`);
      }

      const liveDept = resolveReportDepartment({
        assignedDepartment: liveData.assignedDepartment,
        department: liveData.department,
      });
      if (trimmedDept !== undefined && trimmedDept !== liveDept) {
        const adminRole = adminVerification.admin?.role;
        const canAssignDepartment = Boolean(
          adminRole && ADMIN_ROLE_CAPABILITIES[adminRole]?.canAssignDepartment
        );
        if (!canAssignDepartment) {
          const roleErr: any = new Error(
            'Your role does not have permission to reassign departments. Please contact a supervisor.'
          );
          roleErr.isDomainValidation = true;
          throw roleErr;
        }
        summaryParts.push(
          trimmedDept
            ? `Assigned department set to "${trimmedDept}".`
            : 'Assigned department cleared.'
        );
      }

      const liveOfficer =
        typeof liveData.assignedOfficer === 'string' ? liveData.assignedOfficer.trim() : '';
      if (trimmedOfficer !== undefined && trimmedOfficer !== liveOfficer) {
        summaryParts.push(
          trimmedOfficer
            ? `Assigned officer set to "${trimmedOfficer}".`
            : 'Assigned officer cleared.'
        );
      }

      const liveDup =
        typeof liveData.duplicateOf === 'string' ? liveData.duplicateOf.trim() : '';
      if (trimmedDuplicateOf !== undefined && trimmedDuplicateOf !== liveDup) {
        summaryParts.push(
          trimmedDuplicateOf
            ? `Linked as duplicate of ${trimmedDuplicateOf}.`
            : 'Duplicate link removed.'
        );
      }

      if (trimmedRemarks) {
        summaryParts.push(`Remarks: ${trimmedRemarks}`);
      } else if (trimmedResolutionDetails && isTransition) {
        summaryParts.push(trimmedResolutionDetails);
      } else if (trimmedResolutionDetails && !summaryParts.length) {
        summaryParts.push(`Resolution summary updated: ${trimmedResolutionDetails}`);
      }

      if (summaryParts.length === 0) {
        if (photoUrlToStore !== undefined && photoUrlToStore !== (liveData.resolutionPhotoUrl || '')) {
          summaryParts.push(
            photoUrlToStore ? 'Resolution evidence photo updated.' : 'Resolution evidence photo removed.'
          );
        } else {
          summaryParts.push(`Report details updated (${updates.status}).`);
        }
      }

      const timelineNote = summaryParts.join(' ');
      const effectiveOfficerForTimeline =
        trimmedOfficer !== undefined
          ? trimmedOfficer || 'Municipal Administrator'
          : liveOfficer || 'Municipal Administrator';

      const newTimelineEvent: TimelineEvent = {
        status: updates.status,
        timestamp: nowIso,
        note: timelineNote,
        officer: effectiveOfficerForTimeline,
      };

      const liveTimeline = Array.isArray(liveData.timeline)
        ? liveData.timeline
        : updates.currentTimeline || [];
      const lastEntry = liveTimeline[liveTimeline.length - 1];
      const isDuplicateConsecutiveEvent =
        lastEntry &&
        lastEntry.status === newTimelineEvent.status &&
        (lastEntry.note || '').trim() === newTimelineEvent.note.trim() &&
        (lastEntry.officer || '').trim() === (newTimelineEvent.officer || '').trim();
      const updatedTimeline = isDuplicateConsecutiveEvent
        ? liveTimeline
        : [...liveTimeline, newTimelineEvent];

      const payload: Record<string, any> = {
        status: updates.status,
        updatedAt: nowIso,
        updatedBy: currentUser.uid,
        timeline: updatedTimeline,
      };

      if (updates.status === 'Resolved' && liveStatus !== 'Resolved') {
        payload.resolvedAt = nowIso;
      } else if (updates.status === 'Resolved' && !liveData.resolvedAt) {
        payload.resolvedAt = nowIso;
      }
      if (trimmedRemarks !== undefined) {
        payload.adminRemarks = trimmedRemarks;
      }
      if (trimmedDept !== undefined) {
        payload.assignedDepartment = trimmedDept;
        payload.department = trimmedDept;
      }
      if (trimmedOfficer !== undefined) {
        payload.assignedOfficer = trimmedOfficer;
      }
      if (trimmedResolutionDetails !== undefined) {
        payload.resolutionDetails = trimmedResolutionDetails;
      }
      if (photoUrlToStore !== undefined) {
        payload.resolutionPhotoUrl = photoUrlToStore;
      }
      if (trimmedDuplicateOf !== undefined) {
        payload.duplicateOf = trimmedDuplicateOf;
      }

      const sanitizedPayload = sanitizeForFirestore(payload);
      // Merge live document state (existing citizen photo, timeline, citizenNotes, AI fields)
      // with our update payload and verify conservative 800 KiB JSON size ceiling before writing.
      const mergedFinalDoc = sanitizeForFirestore({
        ...liveData,
        ...sanitizedPayload,
      });
      const estimatedBytes = estimateFirestoreDocumentSize(mergedFinalDoc);

      if (estimatedBytes > MAX_FIRESTORE_DOC_BYTES) {
        const sizeErr: any = new Error(
          'This update with the attached photo is too large to save. Please choose a smaller photo or save without a resolution photo.'
        );
        sizeErr.isDomainValidation = true;
        throw sizeErr;
      }

      transaction.update(reportRef, sanitizedPayload);

      const resolvedDeptFinal = resolveReportDepartment({
        assignedDepartment: mergedFinalDoc.assignedDepartment,
        department: mergedFinalDoc.department,
      });

      return {
        livePrev: liveStatus,
        isTransition,
        timelineNote,
        resolvedDeptFinal,
        effectiveOfficer:
          typeof mergedFinalDoc.assignedOfficer === 'string'
            ? mergedFinalDoc.assignedOfficer
            : '',
        updatedFields: {
          status: updates.status,
          updatedAt: nowIso,
          updatedBy: currentUser.uid,
          resolvedAt:
            typeof mergedFinalDoc.resolvedAt === 'string'
              ? mergedFinalDoc.resolvedAt
              : undefined,
          adminRemarks:
            typeof mergedFinalDoc.adminRemarks === 'string'
              ? mergedFinalDoc.adminRemarks
              : '',
          assignedDepartment: resolvedDeptFinal,
          department:
            typeof mergedFinalDoc.department === 'string' && mergedFinalDoc.department
              ? mergedFinalDoc.department
              : resolvedDeptFinal,
          assignedOfficer:
            typeof mergedFinalDoc.assignedOfficer === 'string'
              ? mergedFinalDoc.assignedOfficer
              : '',
          resolutionDetails:
            typeof mergedFinalDoc.resolutionDetails === 'string'
              ? mergedFinalDoc.resolutionDetails
              : '',
          resolutionPhotoUrl:
            typeof mergedFinalDoc.resolutionPhotoUrl === 'string'
              ? mergedFinalDoc.resolutionPhotoUrl
              : '',
          duplicateOf:
            typeof mergedFinalDoc.duplicateOf === 'string' && mergedFinalDoc.duplicateOf
              ? mergedFinalDoc.duplicateOf
              : undefined,
          timeline: updatedTimeline,
        } satisfies AdminUpdateReportPersistedFields,
      };
    });

    // Non-blocking immutable statusHistory (when status transitions) & auditLogs entry
    try {
      if (txOutcome.isTransition) {
        await addDocFn(
          collectionFn(dbInstance, 'civic_reports', reportId, 'statusHistory'),
          sanitizeForFirestore({
            reportId,
            fromStatus: txOutcome.livePrev || null,
            toStatus: updates.status,
            changedByUid: currentUser.uid,
            changedByEmail: currentUser.email || undefined,
            changedByRole: 'admin',
            note: txOutcome.timelineNote,
            timestamp: nowIso,
          })
        );
      }
      await addDocFn(
        collectionFn(dbInstance, 'auditLogs'),
        sanitizeForFirestore({
          action:
            updates.duplicateOf !== undefined
              ? updates.duplicateOf
                ? 'duplicate_linked'
                : 'duplicate_unlinked'
              : txOutcome.isTransition
              ? 'admin_status_change'
              : 'admin_note_update',
          targetType: 'civic_report',
          targetId: reportId,
          actorUid: currentUser.uid,
          actorRole: 'admin',
          summary: txOutcome.timelineNote,
          timestamp: nowIso,
          metadata: {
            fromStatus: txOutcome.livePrev || null,
            toStatus: updates.status,
            assignedDepartment: txOutcome.resolvedDeptFinal || null,
            assignedOfficer: txOutcome.effectiveOfficer || null,
            remarksUpdated: updates.adminRemarks !== undefined,
            duplicateOf: updates.duplicateOf || null,
          },
        })
      );
    } catch (auditErr) {
      console.warn('Non-blocking admin statusHistory/auditLogs notice:', auditErr);
    }

    return { success: true, updatedFields: txOutcome.updatedFields };
  } catch (err: any) {
    if (newlyUploadedResolutionUrl) {
      await cleanupFn(newlyUploadedResolutionUrl);
    }

    const isPermDenied = isFirebasePermissionError(err);

    if (isPermDenied) {
      logFirestorePermissionError(err, FirestoreOperationType.UPDATE, `civic_reports/${reportId}`);
      return {
        success: false,
        error: toUserFriendlyErrorMessage(err, 'update_complaint'),
      };
    }

    if (!err?.isDomainValidation) {
      console.error(`Failed to update report ${reportId}:`, err);
    }
    return {
      success: false,
      error: err?.isDomainValidation
        ? err.message
        : toUserFriendlyErrorMessage(err, 'update_complaint'),
    };
  }
}

export interface ArchiveReportDeps {
  currentUser?: { uid: string; email?: string | null } | null;
  dbInstance?: any;
  isConfigured?: boolean;
  verifyAdminFn?: typeof verifyAdminPrivileges;
  runTransactionFn?: typeof runTransaction;
  getDocFn?: typeof getDoc;
  docFn?: typeof doc;
  collectionFn?: typeof collection;
  serverTimestampFn?: typeof serverTimestamp;
}

export interface ArchiveReportResult {
  success: boolean;
  archivedAt?: string;
  archivedBy?: string;
  archiveReason?: string;
  updatedAt?: string;
  timeline?: TimelineEvent[];
  error?: string;
}

/**
 * Secure admin-only soft-delete / archive operation for a civic complaint.
 *
 * Guarantees:
 * 1. Verifies active authenticated admin session and archive capability before writing.
 * 2. Preserves the complaint document, citizen details, photo evidence, and statusHistory
 *    subcollection intact instead of permanently destroying records.
 * 3. Marks `archived: true`, records `archivedAt`, `archivedBy`, and optional `archiveReason`,
 *    appends an audit timeline event, and writes an immutable `/auditLogs` entry (`report_archived`).
 * 4. Keeps detailed technical diagnostics in developer console logs while returning
 *    plain-language messages to the UI.
 */
export async function archiveReportByAdmin(
  reportId: string,
  reason?: string,
  deps?: ArchiveReportDeps
): Promise<ArchiveReportResult> {
  if (!reportId || !reportId.trim()) {
    return { success: false, error: 'This complaint could not be found.' };
  }

  const configured = deps && 'isConfigured' in deps ? Boolean(deps.isConfigured) : isFirebaseConfigured;
  const dbInstance = deps && 'dbInstance' in deps ? deps.dbInstance : db;
  if (!configured || !dbInstance) {
    console.error('archiveReportByAdmin: Firestore client is not configured or unavailable.');
    return { success: false, error: "We couldn't complete your request. Please try again." };
  }

  const currentUser =
    deps && 'currentUser' in deps ? deps.currentUser : auth?.currentUser ?? null;
  if (!currentUser) {
    logFirestorePermissionError(
      new Error('Missing authenticated Firebase administrator session for archive.'),
      FirestoreOperationType.UPDATE,
      `civic_reports/${reportId}`
    );
    return {
      success: false,
      error: 'Your session has expired. Please log in again.',
    };
  }

  const verifyAdminFn = deps?.verifyAdminFn ?? verifyAdminPrivileges;
  const adminVerification = await verifyAdminFn(currentUser as User);
  const role = adminVerification.admin?.role;
  const canArchive = Boolean(
    adminVerification.authorized &&
      role &&
      ADMIN_ROLE_CAPABILITIES[role]?.canArchiveReports
  );

  if (!canArchive) {
    logFirestorePermissionError(
      new Error(
        adminVerification.error ||
          `Account role "${role || 'citizen'}" is not authorized to archive complaints.`
      ),
      FirestoreOperationType.UPDATE,
      `civic_reports/${reportId}`
    );
    return {
      success: false,
      error:
        "You don't have permission to remove this complaint. Please contact the system administrator.",
    };
  }

  const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
  if (trimmedReason) {
    const reasonValidation = validateMeaningfulCivicText(trimmedReason, {
      fieldLabel: 'Archive reason',
      minLength: 2,
      required: false,
      allowShortConcise: true,
    });
    if (!reasonValidation.valid) {
      return { success: false, error: reasonValidation.error };
    }
  }

  try {
    const docFn = deps?.docFn ?? doc;
    const collectionFn = deps?.collectionFn ?? collection;
    const runTransactionFn = deps?.runTransactionFn ?? runTransaction;
    const getDocFn = deps?.getDocFn ?? getDoc;
    const serverTimestampFn = deps?.serverTimestampFn ?? serverTimestamp;

    const reportRef = docFn(dbInstance, 'civic_reports', reportId);
    // Allocate a single deterministic auditLog doc ref before the transaction so
    // retries on transaction contention never produce duplicate audit entries.
    const auditLogRef = (docFn as any)(collectionFn(dbInstance, 'auditLogs'));
    // Keep updatedAt, timeline, and auditLogs.timestamp as ISO strings to match existing Firestore queries
    const nowIso = new Date().toISOString();

    const txOutcome = await runTransactionFn(dbInstance, async (transaction) => {
      const liveSnap = await transaction.get(reportRef);
      if (!liveSnap.exists()) {
        const notFoundErr: any = new Error('This complaint could not be found.');
        notFoundErr.isDomainValidation = true;
        throw notFoundErr;
      }

      const liveData = (liveSnap.data() || {}) as Record<string, any>;
      if (liveData.archived === true) {
        const alreadyErr: any = new Error('This complaint has already been archived.');
        alreadyErr.isDomainValidation = true;
        throw alreadyErr;
      }

      const liveStatus = normalizeReportStatus(liveData.status);
      const trackingNumber =
        typeof liveData.trackingNumber === 'string' && liveData.trackingNumber
          ? liveData.trackingNumber
          : reportId;
      const archiveNote = trimmedReason
        ? `Complaint archived by administrator: ${trimmedReason}`
        : 'Complaint archived by administrator and removed from the active list.';

      const liveTimeline = Array.isArray(liveData.timeline) ? liveData.timeline : [];
      const archiveEvent: TimelineEvent = {
        status: liveStatus,
        timestamp: nowIso,
        note: archiveNote,
        officer: 'Municipal Administrator',
      };
      const updatedTimeline = [...liveTimeline, archiveEvent];

      const reportArchivePayload: Record<string, any> = {
        archived: true,
        // Server-verified Firestore Timestamp matching firestore.rules (archivedAt == request.time)
        archivedAt: serverTimestampFn(),
        archivedBy: currentUser.uid,
        updatedAt: nowIso,
        updatedBy: currentUser.uid,
        timeline: updatedTimeline,
      };
      if (trimmedReason) {
        reportArchivePayload.archiveReason = trimmedReason;
      }

      const rawAuditSummary = trimmedReason
        ? `Archived complaint ${trackingNumber} (Reason: ${trimmedReason}).`
        : `Archived complaint ${trackingNumber} from active complaints list.`;
      const boundedAuditSummary =
        rawAuditSummary.length > 1200
          ? `${rawAuditSummary.slice(0, 1197)}...`
          : rawAuditSummary;

      const auditLogPayload = {
        action: 'report_archived',
        targetType: 'civic_report',
        targetId: reportId,
        actorUid: currentUser.uid,
        actorRole: 'admin',
        summary: boundedAuditSummary,
        timestamp: nowIso,
        metadata: {
          previousStatus: liveStatus,
          trackingNumber,
          archiveReason: trimmedReason || null,
        },
      };

      // Atomic commit: both the complaint archive update and its audit log succeed or fail together.
      // Satisfies firestore.rules existsAfter()/getAfter() verification on /civic_reports/{reportId}.
      transaction.update(reportRef, sanitizeForFirestore(reportArchivePayload));
      transaction.set(auditLogRef, sanitizeForFirestore(auditLogPayload));

      return {
        liveStatus,
        trackingNumber,
        archiveNote,
        updatedTimeline,
      };
    });

    // Refetch the committed document to obtain the server-resolved archivedAt timestamp
    // without ever placing a Firestore FieldValue sentinel into local UI state.
    let resolvedArchivedAt: string | undefined;
    try {
      const savedSnap = await getDocFn(reportRef);
      if (savedSnap?.exists?.()) {
        const savedData = (savedSnap.data?.() || {}) as Record<string, any>;
        resolvedArchivedAt = normalizeOptionalReportTimestamp(savedData.archivedAt);
      }
    } catch (refetchErr) {
      console.warn('Non-blocking post-archive refetch notice:', refetchErr);
    }

    return {
      success: true,
      archivedAt: resolvedArchivedAt,
      archivedBy: currentUser.uid,
      archiveReason: trimmedReason || undefined,
      updatedAt: nowIso,
      timeline: txOutcome.updatedTimeline,
    };
  } catch (err: any) {
    if (isFirebasePermissionError(err)) {
      logFirestorePermissionError(err, FirestoreOperationType.UPDATE, `civic_reports/${reportId}`);
      return {
        success: false,
        error: toUserFriendlyErrorMessage(err, 'archive_complaint'),
      };
    }

    if (!err?.isDomainValidation) {
      console.error(`Failed to archive report ${reportId}:`, err);
    }
    return {
      success: false,
      error: err?.isDomainValidation
        ? err.message
        : toUserFriendlyErrorMessage(err, 'archive_complaint'),
    };
  }
}

export interface ReopenWithdrawnDeps {
  currentUser?: { uid: string; email?: string | null } | null;
  dbInstance?: any;
  isConfigured?: boolean;
  verifyAdminFn?: typeof verifyAdminPrivileges;
  runTransactionFn?: typeof runTransaction;
  addDocFn?: typeof addDoc;
  docFn?: typeof doc;
  collectionFn?: typeof collection;
}

/**
 * Explicit admin-only workflow to reopen a citizen-withdrawn complaint.
 *
 * Keeps ordinary status updates disabled for Withdrawn complaints while allowing
 * authorized administrators to deliberately reopen a withdrawn case back to
 * "Under Review" with full `statusHistory` and `auditLogs` traceability.
 * Compatible with existing `firestore.rules` without requiring rule changes.
 */
export async function reopenWithdrawnReportByAdmin(
  reportId: string,
  reason: string,
  deps?: ReopenWithdrawnDeps
): Promise<{
  success: boolean;
  error?: string;
  updatedFields?: AdminUpdateReportPersistedFields;
}> {
  if (!reportId || !reportId.trim()) {
    return { success: false, error: 'This complaint could not be found.' };
  }

  const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
  const reasonValidation = validateMeaningfulCivicText(trimmedReason, {
    fieldLabel: 'Reason for reopening',
    minLength: 4,
    required: true,
    allowShortConcise: true,
  });
  if (!reasonValidation.valid) {
    return { success: false, error: reasonValidation.error };
  }

  const configured = deps && 'isConfigured' in deps ? Boolean(deps.isConfigured) : isFirebaseConfigured;
  const dbInstance = deps && 'dbInstance' in deps ? deps.dbInstance : db;
  if (!configured || !dbInstance) {
    console.error('reopenWithdrawnReportByAdmin: Firestore client is not configured or unavailable.');
    return { success: false, error: "We couldn't complete your request. Please try again." };
  }

  const currentUser =
    deps && 'currentUser' in deps ? deps.currentUser : auth?.currentUser ?? null;
  if (!currentUser) {
    logFirestorePermissionError(
      new Error('Missing authenticated Firebase administrator session for reopen.'),
      FirestoreOperationType.UPDATE,
      `civic_reports/${reportId}`
    );
    return {
      success: false,
      error: 'Your session has expired. Please log in again.',
    };
  }

  const verifyAdminFn = deps?.verifyAdminFn ?? verifyAdminPrivileges;
  const adminVerification = await verifyAdminFn(currentUser as User);
  const role = adminVerification.admin?.role;
  const canReopen = Boolean(
    adminVerification.authorized &&
      role &&
      ADMIN_ROLE_CAPABILITIES[role]?.canReopenWithdrawn
  );

  if (!canReopen) {
    logFirestorePermissionError(
      new Error(
        adminVerification.error ||
          `Account role "${role || 'citizen'}" is not authorized to reopen withdrawn complaints.`
      ),
      FirestoreOperationType.UPDATE,
      `civic_reports/${reportId}`
    );
    return {
      success: false,
      error: 'You are not authorized to reopen this complaint. Please contact the system administrator.',
    };
  }

  try {
    const docFn = deps?.docFn ?? doc;
    const collectionFn = deps?.collectionFn ?? collection;
    const runTransactionFn = deps?.runTransactionFn ?? runTransaction;
    const addDocFn = deps?.addDocFn ?? addDoc;

    const reportRef = docFn(dbInstance, 'civic_reports', reportId);
    const nowIso = new Date().toISOString();

    const txOutcome = await runTransactionFn(dbInstance, async (transaction) => {
      const liveSnap = await transaction.get(reportRef);
      if (!liveSnap.exists()) {
        const notFoundErr: any = new Error('This complaint could not be found.');
        notFoundErr.isDomainValidation = true;
        throw notFoundErr;
      }

      const liveData = (liveSnap.data() || {}) as Record<string, any>;
      if (liveData.archived === true) {
        const archivedErr: any = new Error('Archived complaints cannot be reopened here.');
        archivedErr.isDomainValidation = true;
        throw archivedErr;
      }

      const liveStatus = normalizeReportStatus(liveData.status);
      if (liveStatus !== 'Withdrawn') {
        const notWithdrawnErr: any = new Error(
          'Only withdrawn complaints can be reopened using this action.'
        );
        notWithdrawnErr.isDomainValidation = true;
        throw notWithdrawnErr;
      }

      const reopenNote = `Complaint reopened by administrator (Withdrawn → Under Review): ${trimmedReason}`;
      const liveTimeline = Array.isArray(liveData.timeline) ? liveData.timeline : [];
      const reopenEvent: TimelineEvent = {
        status: 'Under Review',
        timestamp: nowIso,
        note: reopenNote,
        officer: 'Municipal Administrator',
      };
      const updatedTimeline = [...liveTimeline, reopenEvent];

      // Strictly uses fields already permitted by existing firestore.rules admin allow update
      const payload = sanitizeForFirestore({
        status: 'Under Review' as ReportStatus,
        updatedAt: nowIso,
        updatedBy: currentUser.uid,
        adminRemarks: trimmedReason,
        timeline: updatedTimeline,
      });

      transaction.update(reportRef, payload);

      const resolvedDeptFinal = resolveReportDepartment({
        assignedDepartment: liveData.assignedDepartment,
        department: liveData.department,
      });
      const effectiveOfficer =
        typeof liveData.assignedOfficer === 'string' ? liveData.assignedOfficer : '';

      return {
        reopenNote,
        trackingNumber:
          typeof liveData.trackingNumber === 'string' && liveData.trackingNumber
            ? liveData.trackingNumber
            : reportId,
        resolvedDeptFinal,
        effectiveOfficer,
        updatedFields: {
          status: 'Under Review' as ReportStatus,
          updatedAt: nowIso,
          updatedBy: currentUser.uid,
          adminRemarks: trimmedReason,
          assignedDepartment: resolvedDeptFinal,
          department:
            typeof liveData.department === 'string' && liveData.department
              ? liveData.department
              : resolvedDeptFinal,
          assignedOfficer: effectiveOfficer,
          resolutionDetails:
            typeof liveData.resolutionDetails === 'string' ? liveData.resolutionDetails : '',
          resolutionPhotoUrl:
            typeof liveData.resolutionPhotoUrl === 'string' ? liveData.resolutionPhotoUrl : '',
          duplicateOf:
            typeof liveData.duplicateOf === 'string' && liveData.duplicateOf
              ? liveData.duplicateOf
              : undefined,
          timeline: updatedTimeline,
        } satisfies AdminUpdateReportPersistedFields,
      };
    });

    // Record immutable statusHistory & auditLogs entries after confirmed reopen write
    try {
      await addDocFn(
        collectionFn(dbInstance, 'civic_reports', reportId, 'statusHistory'),
        sanitizeForFirestore({
          reportId,
          fromStatus: 'Withdrawn',
          toStatus: 'Under Review',
          changedByUid: currentUser.uid,
          changedByEmail: currentUser.email || undefined,
          changedByRole: 'admin',
          note: txOutcome.reopenNote,
          timestamp: nowIso,
        })
      );

      await addDocFn(
        collectionFn(dbInstance, 'auditLogs'),
        sanitizeForFirestore({
          action: 'report_reopened',
          targetType: 'civic_report',
          targetId: reportId,
          actorUid: currentUser.uid,
          actorRole: 'admin',
          summary: `Reopened withdrawn complaint ${txOutcome.trackingNumber}: ${trimmedReason}`,
          timestamp: nowIso,
          metadata: {
            fromStatus: 'Withdrawn',
            toStatus: 'Under Review',
            assignedDepartment: txOutcome.resolvedDeptFinal || null,
            assignedOfficer: txOutcome.effectiveOfficer || null,
            reopenReason: trimmedReason,
          },
        })
      );
    } catch (auditErr) {
      console.warn('Non-blocking reopen statusHistory/auditLogs notice:', auditErr);
    }

    return {
      success: true,
      updatedFields: txOutcome.updatedFields,
    };
  } catch (err: any) {
    if (isFirebasePermissionError(err)) {
      logFirestorePermissionError(err, FirestoreOperationType.UPDATE, `civic_reports/${reportId}`);
      return {
        success: false,
        error: toUserFriendlyErrorMessage(err, 'reopen_complaint'),
      };
    }

    if (!err?.isDomainValidation) {
      console.error(`Failed to reopen withdrawn report ${reportId}:`, err);
    }
    return {
      success: false,
      error: err?.isDomainValidation
        ? err.message
        : toUserFriendlyErrorMessage(err, 'reopen_complaint'),
    };
  }
}

export async function deleteReportByAdmin(
  reportId: string
): Promise<{ success: boolean; error?: string }> {
  if (!isFirebaseConfigured || !db) {
    console.error('deleteReportByAdmin: Firestore client is not configured or unavailable.');
    return { success: false, error: "We couldn't complete your request. Please try again." };
  }

  const currentUser = auth?.currentUser;
  if (!currentUser) {
    return {
      success: false,
      error: 'Your session has expired. Please log in again.',
    };
  }

  const adminVerification = await verifyAdminPrivileges(currentUser);
  if (!adminVerification.authorized || adminVerification.admin?.role !== 'superadmin') {
    logFirestorePermissionError(
      new Error('Unauthorized attempt to permanently delete complaint.'),
      FirestoreOperationType.DELETE,
      `civic_reports/${reportId}`
    );
    return {
      success: false,
      error:
        "You don't have permission to remove this complaint. Please contact the system administrator.",
    };
  }

  try {
    await deleteDoc(doc(db, 'civic_reports', reportId));
    return { success: true };
  } catch (err: any) {
    if (isFirebasePermissionError(err)) {
      logFirestorePermissionError(err, FirestoreOperationType.DELETE, `civic_reports/${reportId}`);
    } else {
      console.error(`Failed to permanently delete report ${reportId}:`, err);
    }
    return {
      success: false,
      error: toUserFriendlyErrorMessage(err, 'delete_complaint'),
    };
  }
}

/**
 * Fetches immutable status history subcollection entries for a report.
 */
export async function fetchReportStatusHistory(reportId: string): Promise<StatusHistoryEntry[]> {
  if (!isFirebaseConfigured || !db || !reportId) {
    return [];
  }

  try {
    const historyCol = collection(db, 'civic_reports', reportId, 'statusHistory');
    const q = query(historyCol, orderBy('timestamp', 'desc'), limit(50));
    const snapshot = await getDocs(q);
    const entries: StatusHistoryEntry[] = [];
    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      entries.push({
        id: docSnap.id,
        reportId: data.reportId || reportId,
        fromStatus: (data.fromStatus as ReportStatus) || null,
        toStatus: normalizeReportStatus(data.toStatus),
        changedByUid: data.changedByUid || '',
        changedByEmail: data.changedByEmail || undefined,
        changedByRole: data.changedByRole === 'admin' ? 'admin' : 'citizen',
        note: data.note || '',
        timestamp: data.timestamp || '',
      });
    });
    return entries;
  } catch (err) {
    console.warn(`Unable to load status history for report ${reportId}:`, err);
    return [];
  }
}

export interface FetchAuditLogsResult {
  logs: AuditLogEntry[];
  fromCloud: boolean;
  isPartial: boolean;
  error?: string;
}

export interface FetchAuditLogsDeps {
  dbInstance?: any;
  isConfigured?: boolean;
  collectionFn?: typeof collection;
  queryFn?: typeof query;
  orderByFn?: typeof orderBy;
  limitFn?: typeof limit;
  getDocsFn?: typeof getDocs;
}

/**
 * Fetches a bounded window of recent immutable `/auditLogs` entries for authorized
 * administrators. Returns an explicit `fromCloud` / `isPartial` status and never
 * fabricates synthetic events when offline or permission-denied.
 */
export async function fetchRecentAuditLogs(
  limitCount: number = 50,
  deps?: FetchAuditLogsDeps
): Promise<FetchAuditLogsResult> {
  const configured = deps?.isConfigured ?? isFirebaseConfigured;
  const dbInstance = deps && 'dbInstance' in deps ? deps.dbInstance : db;
  const boundedLimit = Math.max(1, Math.min(limitCount, 100));

  if (!configured || !dbInstance) {
    return {
      logs: [],
      fromCloud: false,
      isPartial: true,
      error: 'Unable to refresh the latest information.',
    };
  }

  try {
    const collectionFn = deps?.collectionFn ?? collection;
    const queryFn = deps?.queryFn ?? query;
    const orderByFn = deps?.orderByFn ?? orderBy;
    const limitFn = deps?.limitFn ?? limit;
    const getDocsFn = deps?.getDocsFn ?? getDocs;

    const auditCol = collectionFn(dbInstance, 'auditLogs');
    const q = queryFn(auditCol, orderByFn('timestamp', 'desc'), limitFn(boundedLimit));
    const snapshot = await getDocsFn(q);
    const logs: AuditLogEntry[] = [];

    snapshot.forEach((docSnap) => {
      const data = (docSnap.data() || {}) as Record<string, any>;
      logs.push({
        id: docSnap.id,
        action: data.action || 'admin_note_update',
        targetType: 'civic_report',
        targetId: typeof data.targetId === 'string' ? data.targetId : '',
        actorUid: typeof data.actorUid === 'string' ? data.actorUid : '',
        actorRole: data.actorRole === 'admin' ? 'admin' : 'citizen',
        summary: typeof data.summary === 'string' ? data.summary : '',
        timestamp: formatNormalizedReportTimestamp(data.timestamp),
        metadata:
          data.metadata && typeof data.metadata === 'object' ? data.metadata : undefined,
      });
    });

    return {
      logs,
      fromCloud: true,
      isPartial: logs.length >= boundedLimit,
    };
  } catch (err: any) {
    if (isFirebasePermissionError(err)) {
      logFirestorePermissionError(err, FirestoreOperationType.LIST, 'auditLogs');
    } else {
      console.error('Failed to load audit logs from Cloud Firestore:', err);
    }
    return {
      logs: [],
      fromCloud: false,
      isPartial: true,
      error: toUserFriendlyErrorMessage(err, 'load_audit_logs'),
    };
  }
}

/**
 * Calculates live municipal analytics strictly from actual active (non-archived) citizen reports.
 * Zero dummy statistics.
 * Guarantees: Sum of the lifecycle status counts exactly equals totalReports.
 */
export function calculateAdminStats(reports: CivicIssueReport[]): AdminStats {
  const visibleReports = reports.filter((report) => !report.archived);

  const stats: AdminStats = {
    totalReports: visibleReports.length,
    pendingReports: 0,
    inProgressReports: 0,
    resolvedReports: 0,
    rejectedReports: 0,
    withdrawnReports: 0,
    highSeverityReports: 0,
    avgResolutionHours: 0,
    categoryDistribution: EXPANDED_CIVIC_CATEGORIES.reduce(
      (acc, cat) => {
        acc[cat] = 0;
        return acc;
      },
      {} as Record<ExpandedCivicCategory, number> & Record<string, number>
    ),
    wardDistribution: {},
    statusDistribution: {
      Submitted: 0,
      'Under Review': 0,
      Assigned: 0,
      'In Progress': 0,
      Resolved: 0,
      Rejected: 0,
      Withdrawn: 0,
    },
  };

  let totalResolutionTimeMs = 0;
  let resolvedCount = 0;

  for (const report of visibleReports) {
    // Normalizes status safely; older/missing statuses fall back to 'Submitted'
    const status = normalizeReportStatus(report.status);
    stats.statusDistribution[status]++;

    // High level groupings (Withdrawn reports are strictly excluded from active/pending counts)
    if (status === 'Submitted' || status === 'Under Review') {
      stats.pendingReports++;
    } else if (status === 'Assigned' || status === 'In Progress') {
      stats.inProgressReports++;
    } else if (status === 'Resolved') {
      stats.resolvedReports++;
    } else if (status === 'Rejected') {
      stats.rejectedReports++;
    } else if (status === 'Withdrawn') {
      stats.withdrawnReports++;
    }

    // Severity
    if (report.severity === 'High' || report.severity === 'Hazard') {
      stats.highSeverityReports++;
    }

    // Category distribution (normalizes legacy 6 categories into the 8 canonical categories)
    const normalizedCategory = normalizeCivicCategory(report.normalizedCategory || report.category);
    stats.categoryDistribution[normalizedCategory]++;

    // Ward distribution
    const wardName = report.location?.ward || 'Unspecified Ward';
    stats.wardDistribution[wardName] = (stats.wardDistribution[wardName] || 0) + 1;

    // SLA / Resolution time
    const resolutionEnd = report.resolvedAt || report.updatedAt;
    if (status === 'Resolved' && report.submittedAt && resolutionEnd) {
      const start = parseReportTimestamp(report.submittedAt);
      const end = parseReportTimestamp(resolutionEnd);
      if (start > 0 && end > start && Number.isFinite(end - start)) {
        totalResolutionTimeMs += end - start;
        resolvedCount++;
      }
    }
  }

  if (resolvedCount > 0 && Number.isFinite(totalResolutionTimeMs)) {
    stats.avgResolutionHours = Math.round((totalResolutionTimeMs / (resolvedCount * 3600 * 1000)) * 10) / 10;
  } else {
    stats.avgResolutionHours = null;
  }

  return stats;
}

/**
 * Aggregates citizen summaries from reports without exposing citizen private keys, UIDs, emails, or phone numbers.
 */
export function extractCitizenSummaries(reports: CivicIssueReport[]): CitizenSummary[] {
  const citizenMap = new Map<string, CitizenSummary>();

  for (const report of reports) {
    const rawId = report.userId || 'anonymous-citizen';
    const existing = citizenMap.get(rawId);

    const reportDate = report.submittedAt;
    const isResolved = normalizeReportStatus(report.status) === 'Resolved';
    const resolvedWard = report.location?.ward?.trim() || 'Unspecified Ward';

    if (existing) {
      existing.totalReports++;
      if (isResolved) existing.resolvedReports++;
      if (existing.ward === 'Unspecified Ward' && resolvedWard !== 'Unspecified Ward') {
        existing.ward = resolvedWard;
      }
      if (!existing.latestReportDate || parseReportTimestamp(reportDate) > parseReportTimestamp(existing.latestReportDate)) {
        existing.latestReportDate = reportDate;
      }
      if (!existing.firstReportDate || parseReportTimestamp(reportDate) < parseReportTimestamp(existing.firstReportDate)) {
        existing.firstReportDate = reportDate;
      }
    } else {
      const safeCode = generateSafeCitizenCode(rawId);
      const citizenDisplayName = sanitizeCitizenDisplayName(report.citizenName, safeCode);
      citizenMap.set(rawId, {
        id: rawId,
        name: citizenDisplayName,
        email: report.citizenEmail ? 'Protected (••••)' : 'Not provided (••••)',
        phone: 'Protected (••••)',
        ward: resolvedWard,
        totalReports: 1,
        resolvedReports: isResolved ? 1 : 0,
        firstReportDate: reportDate,
        latestReportDate: reportDate,
      });
    }
  }

  return Array.from(citizenMap.values()).sort((a, b) => b.totalReports - a.totalReports);
}
