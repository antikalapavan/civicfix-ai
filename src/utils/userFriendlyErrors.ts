/**
 * Centralized user-friendly error message helpers for Citizen & Admin portals.
 *
 * Ensures raw Firebase/Firestore/Storage/security-rule/stack terminology is kept
 * strictly in developer console logs while users see clear, plain-language guidance.
 */

export type FriendlyErrorAction =
  | 'archive_complaint'
  | 'delete_complaint'
  | 'update_complaint'
  | 'reopen_complaint'
  | 'load_complaints'
  | 'load_audit_logs'
  | 'upload_photo'
  | 'submit_complaint'
  | 'add_note'
  | 'withdraw_complaint'
  | 'sync_reports'
  | 'auth'
  | 'general';

const TECHNICAL_JARGON_PATTERN =
  /\b(firestore|cloud firestore|firebase|cloud storage|firebase storage|security rules|firestore\.rules|onsnapshot|custom claim|\/admins\/|permission-denied|document id|docid|collection|uid|id token|localstorage|quotaexceedederror|missing or insufficient permissions)\b/i;

export function containsTechnicalJargon(text?: string | null): boolean {
  if (!text || typeof text !== 'string') return false;
  return TECHNICAL_JARGON_PATTERN.test(text);
}

export function isFirebasePermissionError(err: unknown): boolean {
  const anyErr = err as { code?: string; message?: string } | null | undefined;
  const code = typeof anyErr?.code === 'string' ? anyErr.code.toLowerCase() : '';
  const msg = typeof anyErr?.message === 'string' ? anyErr.message.toLowerCase() : '';
  return (
    code === 'permission-denied' ||
    code === 'storage/unauthorized' ||
    msg.includes('missing or insufficient permissions') ||
    msg.includes('permission-denied') ||
    msg.includes('security rules')
  );
}

export function isFirebaseNotFoundError(err: unknown): boolean {
  const anyErr = err as { code?: string; message?: string } | null | undefined;
  const code = typeof anyErr?.code === 'string' ? anyErr.code.toLowerCase() : '';
  const msg = typeof anyErr?.message === 'string' ? anyErr.message.toLowerCase() : '';
  return (
    code === 'not-found' ||
    code === 'storage/object-not-found' ||
    msg.includes('no document to update') ||
    msg.includes('document not found')
  );
}

export function isFirebaseSessionExpiredError(err: unknown): boolean {
  const anyErr = err as { code?: string; message?: string } | null | undefined;
  const code = typeof anyErr?.code === 'string' ? anyErr.code.toLowerCase() : '';
  const msg = typeof anyErr?.message === 'string' ? anyErr.message.toLowerCase() : '';
  return (
    code === 'unauthenticated' ||
    code === 'auth/user-token-expired' ||
    code === 'auth/id-token-expired' ||
    msg.includes('session has expired') ||
    msg.includes('token expired')
  );
}

export function isFirebaseNetworkError(err: unknown): boolean {
  const anyErr = err as { code?: string; message?: string } | null | undefined;
  const code = typeof anyErr?.code === 'string' ? anyErr.code.toLowerCase() : '';
  const msg = typeof anyErr?.message === 'string' ? anyErr.message.toLowerCase() : '';
  return (
    code === 'unavailable' ||
    code === 'deadline-exceeded' ||
    code === 'auth/network-request-failed' ||
    msg.includes('network') ||
    msg.includes('offline') ||
    msg.includes('failed to fetch') ||
    msg.includes('unreachable')
  );
}

/**
 * Translates any Firebase, Firestore, Storage, or unexpected error into a clear,
 * non-technical message suitable for display in the Citizen or Admin UI.
 */
export function toUserFriendlyErrorMessage(
  err: unknown,
  action: FriendlyErrorAction = 'general'
): string {
  if (isFirebaseSessionExpiredError(err)) {
    return 'Your session has expired. Please log in again.';
  }

  if (isFirebaseNotFoundError(err)) {
    if (
      action === 'archive_complaint' ||
      action === 'delete_complaint' ||
      action === 'update_complaint' ||
      action === 'reopen_complaint' ||
      action === 'withdraw_complaint'
    ) {
      return 'This complaint could not be found.';
    }
    return 'The requested record could not be found.';
  }

  if (isFirebasePermissionError(err)) {
    switch (action) {
      case 'archive_complaint':
      case 'delete_complaint':
        return "You don't have permission to remove this complaint. Please contact the system administrator.";
      case 'update_complaint':
      case 'reopen_complaint':
        return 'You are not authorized to update this complaint. Please contact the system administrator.';
      case 'load_complaints':
      case 'load_audit_logs':
        return 'You are not authorized to view these records. Please contact the system administrator.';
      case 'upload_photo':
        return "Your photo couldn't be uploaded. Please try again.";
      case 'add_note':
        return 'You are not authorized to add notes to this complaint.';
      case 'withdraw_complaint':
        return 'This complaint can no longer be withdrawn because it is already being processed.';
      default:
        return 'You are not authorized to perform this action.';
    }
  }

  if (isFirebaseNetworkError(err)) {
    switch (action) {
      case 'load_complaints':
      case 'load_audit_logs':
        return 'Unable to refresh the latest information. Please check your internet connection and try again.';
      case 'upload_photo':
        return "Your photo couldn't be uploaded right now. Please check your internet connection and try again.";
      default:
        return "We couldn't connect right now. Please check your internet connection and try again.";
    }
  }

  if (action === 'upload_photo') {
    return "Your photo couldn't be uploaded. Please try again.";
  }

  if (action === 'load_complaints' || action === 'load_audit_logs') {
    return 'Unable to refresh the latest information.';
  }

  // If caller supplied a clean domain-validation error (with no technical jargon), preserve it
  const rawMessage =
    typeof err === 'string'
      ? err.trim()
      : err && typeof (err as any).message === 'string'
      ? (err as any).message.trim()
      : '';

  if (rawMessage && !containsTechnicalJargon(rawMessage) && !rawMessage.startsWith('Firebase:')) {
    return rawMessage;
  }

  return "We couldn't complete your request. Please try again.";
}

/**
 * Formats an AI image verification decision code into plain human-readable text.
 */
export function formatImageReviewStatusLabel(decision?: string | null): string {
  switch (decision) {
    case 'VALID_CIVIC_ISSUE':
      return 'Civic Issue Confirmed';
    case 'POSSIBLE_CIVIC_ISSUE_NEEDS_REVIEW':
      return 'Needs Manual Review';
    case 'UNCLEAR_IMAGE':
      return 'Photo Needs Closer Review';
    case 'UNRELATED_IMAGE':
      return 'May Not Show a Civic Issue';
    default:
      return 'Image Review Information';
  }
}
