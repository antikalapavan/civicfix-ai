
import type { NextFunction, Request, Response } from 'express';
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { AdminRole, normalizeAdminRole, VALID_ADMIN_ROLES } from '../types/civic';

export interface AuthenticatedUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  providerId: string | null;
  claims: Record<string, unknown>;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      decodedToken?: DecodedIdToken;
    }
  }
}

let cachedAdminApp: App | null = null;
let cachedHasFirestoreCreds = false;

export function getFirebaseProjectId(): string {
  return (
    process.env.FIREBASE_PROJECT_ID ||
    process.env.VITE_FIREBASE_PROJECT_ID ||
    'civifix-ai-214ec'
  );
}

export function initializeFirebaseAdmin(): {
  app: App;
  hasFirestoreCreds: boolean;
} {
  if (cachedAdminApp) {
    return {
      app: cachedAdminApp,
      hasFirestoreCreds: cachedHasFirestoreCreds,
    };
  }

  const existing = getApps();

  if (existing.length > 0) {
    cachedAdminApp = existing[0];
    cachedHasFirestoreCreds = Boolean(
      (process.env.FIREBASE_SERVICE_ACCOUNT_JSON &&
        process.env.FIREBASE_SERVICE_ACCOUNT_JSON.trim().startsWith('{')) ||
        (process.env.GOOGLE_APPLICATION_CREDENTIALS &&
          process.env.GOOGLE_APPLICATION_CREDENTIALS.trim().length > 0)
    );

    return {
      app: cachedAdminApp,
      hasFirestoreCreds: cachedHasFirestoreCreds,
    };
  }

  const projectId = getFirebaseProjectId();
  const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (serviceAccountRaw && serviceAccountRaw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(serviceAccountRaw);

      cachedAdminApp = initializeApp({
        credential: cert(parsed),
        projectId: parsed.project_id || projectId,
      });

      cachedHasFirestoreCreds = true;

      return {
        app: cachedAdminApp,
        hasFirestoreCreds: true,
      };
    } catch (err: any) {
      console.warn(
        '[FirebaseAdmin] Invalid FIREBASE_SERVICE_ACCOUNT_JSON, falling back to projectId-only init:',
        err?.message
      );
    }
  }

  cachedAdminApp = initializeApp({ projectId });

  cachedHasFirestoreCreds = Boolean(
    process.env.GOOGLE_APPLICATION_CREDENTIALS &&
      process.env.GOOGLE_APPLICATION_CREDENTIALS.trim().length > 0
  );

  return {
    app: cachedAdminApp,
    hasFirestoreCreds: cachedHasFirestoreCreds,
  };
}

export function getAdminFirestoreSafe(): Firestore | null {
  const { app, hasFirestoreCreds } = initializeFirebaseAdmin();

  if (!hasFirestoreCreds) {
    return null;
  }

  try {
    return getFirestore(app);
  } catch {
    return null;
  }
}

export function extractBearerToken(
  authHeader?: string | string[]
): string | null {
  const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;

  if (!raw || typeof raw !== 'string') return null;

  const match = raw.match(/^Bearer\s+(.+)$/i);

  if (!match) return null;

  const token = match[1].trim();

  return token.length > 10 ? token : null;
}

// FIX: Enable revocation checking only when Firebase Admin credentials exist.
export async function verifyFirebaseIdToken(
  idToken: string
): Promise<DecodedIdToken> {
  const { app, hasFirestoreCreds } = initializeFirebaseAdmin();

  return getAuth(app).verifyIdToken(idToken, hasFirestoreCreds);
}

export function toAuthenticatedUser(
  decoded: DecodedIdToken
): AuthenticatedUser {
  return {
    uid: decoded.uid,
    email: decoded.email || null,
    emailVerified: Boolean(decoded.email_verified),
    name: typeof decoded.name === 'string' ? decoded.name : null,
    picture: typeof decoded.picture === 'string' ? decoded.picture : null,
    providerId: decoded.firebase?.sign_in_provider || null,
    claims: decoded as unknown as Record<string, unknown>,
  };
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractBearerToken(req.headers.authorization);

  if (!token) {
    res.status(401).json({
      success: false,
      error: 'Authentication required. Please sign in to continue.',
    });
    return;
  }

  try {
    const decoded = await verifyFirebaseIdToken(token);

    req.decodedToken = decoded;
    req.user = toAuthenticatedUser(decoded);

    next();
  } catch (err: any) {
    const code = err?.code || '';

    // Firebase Admin infrastructure failures are not client token failures.
    const infrastructureErrors = new Set([
      'auth/internal-error',
      'auth/invalid-credential',
      'app/invalid-credential',
    ]);

    if (infrastructureErrors.has(code)) {
      console.error(
        '[FirebaseAuth] Token verification infrastructure failure:',
        code
      );

      res.status(503).json({
        success: false,
        error:
          'Authentication service is temporarily unavailable. Please try again.',
      });
      return;
    }

    const expired =
      code === 'auth/id-token-expired' ||
      code === 'auth/id-token-revoked';

    res.status(401).json({
      success: false,
      error: expired
        ? 'Your session has expired. Please sign in again.'
        : 'Invalid authentication token.',
    });
  }
}

export interface VerifiedAdminResult {
  authorized: boolean;
  role: AdminRole | null;
  department: string | null;
  source:
    | 'custom_claim'
    | 'admins_collection'
    | null;
  inactive?: boolean;
  reason?: string;
}

export interface VerifyAdminTokenDeps {
  adminDb?: {
    collection: (name: string) => {
      doc: (id: string) => {
        get: () => Promise<{ exists: boolean; data: () => Record<string, any> | undefined }>;
      };
    };
  } | null;
}

/**
 * Verifies administrative privileges from a decoded Firebase ID token.
 *
 * Security & Limitations:
 * - Preserves all 4 canonical roles: superadmin, department_head, ward_admin, staff.
 * - Rejects accounts explicitly marked active === false in claims or /admins/{uid} when
 *   Firestore Admin SDK access is available.
 * - If Firebase Admin Firestore credentials are unavailable or the admin document cannot
 *   be read, only cryptographic custom claims can authorize the account.
 * - Server email configuration is used by the provisioning CLI, never as an authorization
 *   substitute for Firebase claims or an active /admins/{uid} record.
 * - Phase 1 does not modify firestore.rules; database rules remain binary isAdmin().
 */
export async function verifyAdminFromDecodedToken(
  decoded: DecodedIdToken,
  deps?: VerifyAdminTokenDeps
): Promise<VerifiedAdminResult> {
  const claimsRecord = decoded as Record<string, unknown>;

  if (claimsRecord.active === false) {
    return {
      authorized: false,
      role: null,
      department: null,
      source: null,
      inactive: true,
      reason: 'This administrator account has been deactivated.',
    };
  }

  // Inspect /admins/{uid} first when Admin Firestore access is available so an explicit
  // active === false record overrides any unrevoked custom claim or env allowlist entry.
  const adminDb =
    deps && 'adminDb' in deps ? deps.adminDb : getAdminFirestoreSafe();

  let adminDocExists = false;
  let adminDocData: Record<string, any> | null = null;

  if (adminDb) {
    try {
      const snap = await adminDb.collection('admins').doc(decoded.uid).get();
      if (snap.exists) {
        adminDocExists = true;
        adminDocData = snap.data() || {};
        if (adminDocData.active === false) {
          return {
            authorized: false,
            role: null,
            department: null,
            source: null,
            inactive: true,
            reason:
              'This administrator account has been deactivated. Please contact a municipal superadmin.',
          };
        }
      }
    } catch (err: any) {
      console.warn(
        '[FirebaseAdmin] Failed to read admins collection:',
        err?.message
      );
    }
  }

  // 1. Cryptographic Firebase custom claim (primary mechanism)
  if (claimsRecord.admin === true) {
    const rawClaimRole = claimsRecord.role;
    const hasExplicitClaimRole =
      typeof rawClaimRole === 'string' &&
      (VALID_ADMIN_ROLES as readonly string[]).includes(
        rawClaimRole.trim().toLowerCase().replace(/[\s-]+/g, '_')
      );

    const resolvedRole: AdminRole = hasExplicitClaimRole
      ? normalizeAdminRole(rawClaimRole, 'superadmin')
      : adminDocExists && adminDocData?.role
      ? normalizeAdminRole(adminDocData.role, 'superadmin')
      : 'superadmin';

    const deptClaim = claimsRecord.department;
    const resolvedDept =
      typeof deptClaim === 'string' && deptClaim.trim()
        ? deptClaim
        : typeof adminDocData?.department === 'string' && adminDocData.department.trim()
        ? adminDocData.department
        : 'Municipal Administration';

    return {
      authorized: true,
      role: resolvedRole,
      department: resolvedDept,
      source: 'custom_claim',
    };
  }

  // 2. Server-side Admin SDK lookup in /admins/{uid} when active !== false
  if (adminDocExists && adminDocData && adminDocData.active !== false) {
    return {
      authorized: true,
      role: normalizeAdminRole(adminDocData.role, 'staff'),
      department:
        typeof adminDocData.department === 'string' && adminDocData.department.trim()
          ? adminDocData.department
          : 'Municipal Administration',
      source: 'admins_collection',
    };
  }

  // Server-only email configuration is intentionally not an authorization fallback.
  // It is consumed by the provisioning CLI; Firestore-backed application access
  // requires a custom claim or active /admins/{uid} record.
  return {
    authorized: false,
    role: null,
    department: null,
    source: null,
    reason: 'Account lacks verified administrative privileges.',
  };
}
