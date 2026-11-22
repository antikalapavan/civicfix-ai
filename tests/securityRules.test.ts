import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_ROLE_CAPABILITIES } from '../src/types/civic';

console.log('--- RUNNING CIVIFIX AI FIREBASE SECURITY RULES TEST SUITE ---');

const rootDir = process.cwd();
const firestoreRules = fs.readFileSync(path.resolve(rootDir, 'firestore.rules'), 'utf8');
const storageRules = fs.readFileSync(path.resolve(rootDir, 'storage.rules'), 'utf8');
const blueprintRaw = fs.readFileSync(path.resolve(rootDir, 'firebase-blueprint.json'), 'utf8');
const firebaseJsonRaw = fs.readFileSync(path.resolve(rootDir, 'firebase.json'), 'utf8');
const firebasercRaw = fs.readFileSync(path.resolve(rootDir, '.firebaserc'), 'utf8');

function assertBalancedBraces(source: string, filename: string) {
  let depth = 0;
  let inSingleQuote = false;
  let inLineComment = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (!inSingleQuote && ch === '/' && next === '/') {
      inLineComment = true;
      continue;
    }
    if (ch === "'" && source[i - 1] !== '\\') {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (inSingleQuote) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      assert(depth >= 0, `${filename} has unmatched closing brace at index ${i}`);
    }
  }
  assert.strictEqual(depth, 0, `${filename} must have balanced curly braces`);
}

interface MockAuthContext {
  uid: string;
  token?: Record<string, unknown>;
}

interface MockDbState {
  admins: Record<string, Record<string, unknown>>;
  civic_reports: Record<string, Record<string, unknown>>;
}

const ARCHIVE_ALLOWED_ROLES = new Set(['superadmin', 'department_head']);
const SAFE_DOC_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const SERVER_REQUEST_TIME = Symbol('firestore.request.time');

// Faithful rule evaluator mirroring firestore.rules & storage.rules logic
function isAuthenticated(auth: MockAuthContext | null): boolean {
  return auth !== null && typeof auth.uid === 'string' && auth.uid.length > 0;
}

function isAdmin(auth: MockAuthContext | null, db: MockDbState): boolean {
  if (!isAuthenticated(auth) || !auth) return false;
  const adminDoc = db.admins[auth.uid];
  if (adminDoc !== undefined) {
    return 'active' in adminDoc && adminDoc.active === true;
  }
  const token = auth.token || {};
  return token.admin === true && (!('active' in token) || token.active === true);
}

function canManageAdmins(auth: MockAuthContext | null, db: MockDbState): boolean {
  if (!isAdmin(auth, db) || !auth) return false;
  const adminDoc = db.admins[auth.uid];
  if (adminDoc !== undefined) {
    return adminDoc.active === true && adminDoc.role === 'superadmin';
  }
  const token = auth.token || {};
  if (token.admin !== true) return false;
  if ('active' in token && token.active !== true) return false;
  return token.role === 'superadmin';
}

function canArchiveReports(auth: MockAuthContext | null, db: MockDbState): boolean {
  if (!isAdmin(auth, db) || !auth) return false;
  const adminDoc = db.admins[auth.uid];
  if (adminDoc !== undefined) {
    return typeof adminDoc.role === 'string' && ARCHIVE_ALLOWED_ROLES.has(adminDoc.role);
  }
  const token = auth.token || {};
  if (token.admin !== true) return false;
  if ('active' in token && token.active !== true) return false;
  // Explicit authorized role required even for claim-only admins (no implicit superadmin default)
  return typeof token.role === 'string' && ARCHIVE_ALLOWED_ROLES.has(token.role);
}

function isValidArchiveAuditLog(
  auth: MockAuthContext | null,
  db: MockDbState,
  data: Record<string, any>,
  afterDb: MockDbState = db
): boolean {
  if (!auth || !canArchiveReports(auth, db)) return false;
  if (data.actorUid !== auth.uid) return false;
  if (data.actorRole !== 'admin') return false;
  if (data.targetType !== 'civic_report') return false;
  if (
    typeof data.targetId !== 'string' ||
    data.targetId.length === 0 ||
    data.targetId.length > 128 ||
    !SAFE_DOC_ID_REGEX.test(data.targetId)
  ) {
    return false;
  }
  if (typeof data.summary !== 'string' || data.summary.length === 0 || data.summary.length > 1200) {
    return false;
  }
  // Mirrors existsAfter() + getAfter() on /civic_reports/$(targetId)
  const reportAfter = afterDb.civic_reports[data.targetId];
  if (!reportAfter) return false;
  if (!('archived' in reportAfter) || reportAfter.archived !== true) return false;
  if (!('archivedBy' in reportAfter) || reportAfter.archivedBy !== auth.uid) return false;
  return true;
}

function isReportOwnerById(auth: MockAuthContext | null, db: MockDbState, reportId: string): boolean {
  if (!isAuthenticated(auth) || !auth) return false;
  const report = db.civic_reports[reportId];
  return report !== undefined && report.userId === auth.uid;
}

function canReadReport(auth: MockAuthContext | null, db: MockDbState, reportId: string): boolean {
  if (!isAuthenticated(auth) || !auth) return false;
  const report = db.civic_reports[reportId];
  if (!report) return false;
  return report.userId === auth.uid || isAdmin(auth, db);
}

const FORBIDDEN_CREATE_REPORT_FIELDS = new Set([
  'assignedDepartment',
  'assignedOfficer',
  'adminRemarks',
  'resolutionDetails',
  'resolutionPhotoUrl',
  'resolvedAt',
  'updatedBy',
  'duplicateOf',
  'withdrawnAt',
  'withdrawnBy',
  'withdrawalReason',
  'archived',
  'archivedAt',
  'archivedBy',
  'archiveReason',
]);

const VALID_CATEGORIES = new Set([
  'Garbage accumulation',
  'Overflowing dustbins',
  'Potholes',
  'Damaged roads',
  'Drainage problems',
  'Water leakage',
  'Streetlight problems',
  'Other civic issues',
  'Garbage',
  'Pothole',
  'Water Leakage',
  'Drainage',
  'Broken Streetlight',
  'Other',
]);

const VALID_SEVERITIES = new Set(['Low', 'Medium', 'Moderate', 'High', 'Hazard', 'Minor']);

function canCreateReport(
  auth: MockAuthContext | null,
  reportId: string,
  data: Record<string, any>
): boolean {
  if (!isAuthenticated(auth) || !auth) return false;
  if (data.userId !== auth.uid || data.id !== reportId) return false;
  if (typeof data.trackingNumber !== 'string' || data.trackingNumber.length < 5 || data.trackingNumber.length > 40)
    return false;
  if (!VALID_CATEGORIES.has(data.category)) return false;
  if (!VALID_SEVERITIES.has(data.severity)) return false;
  if (data.status !== 'Submitted' && data.status !== 'Under Review') return false;
  if (typeof data.description !== 'string' || data.description.length === 0 || data.description.length > 4000)
    return false;
  const loc = data.location;
  if (!loc || typeof loc !== 'object' || typeof loc.address !== 'string' || loc.address.length === 0 || loc.address.length > 500)
    return false;
  if (loc.latitude !== null && typeof loc.latitude !== 'number') return false;
  if (loc.longitude !== null && typeof loc.longitude !== 'number') return false;
  if (!Array.isArray(data.citizenNotes) || data.citizenNotes.length > 20) return false;
  if (typeof data.submittedAt !== 'string' || data.submittedAt.length < 10) return false;
  if (typeof data.updatedAt !== 'string' || data.updatedAt.length < 10) return false;
  if ('isDemo' in data && data.isDemo !== false) return false;
  for (const key of Object.keys(data)) {
    if (FORBIDDEN_CREATE_REPORT_FIELDS.has(key)) return false;
  }
  return true;
}

function areRuleValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a === 'symbol' || typeof b === 'symbol') return a === b;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, idx) => areRuleValuesEqual(item, b[idx]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(b, k) &&
        areRuleValuesEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    );
  }
  return false;
}

function getAffectedKeys(before: Record<string, any>, after: Record<string, any>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const k of keys) {
    const inBefore = k in before;
    const inAfter = k in after;
    if (inBefore !== inAfter || !areRuleValuesEqual(before[k], after[k])) {
      changed.push(k);
    }
  }
  return changed;
}

function canUpdateReport(
  auth: MockAuthContext | null,
  db: MockDbState,
  before: Record<string, any>,
  after: Record<string, any>
): boolean {
  if (!isAuthenticated(auth) || !auth) return false;
  const affected = getAffectedKeys(before, after);

  // Citizen branch 1: citizenNotes + updatedAt only (non-archived reports only)
  const citizenNoteBranch = (() => {
    if (!('userId' in before) || before.userId !== auth.uid) return false;
    if ('archived' in before && before.archived === true) return false;
    if (!affected.every((k) => k === 'citizenNotes' || k === 'updatedAt')) return false;
    if (!Array.isArray(after.citizenNotes) || after.citizenNotes.length > 50) return false;
    if (!('citizenNotes' in before)) {
      if (after.citizenNotes.length > 1) return false;
    } else {
      if (!Array.isArray(before.citizenNotes)) return false;
      const hasAll = before.citizenNotes.every((n: any) => after.citizenNotes.includes(n));
      if (!hasAll) return false;
      if (after.citizenNotes.length < before.citizenNotes.length) return false;
      if (after.citizenNotes.length > before.citizenNotes.length + 1) return false;
    }
    return typeof after.updatedAt === 'string' && after.updatedAt.length >= 10;
  })();

  // Citizen branch 2: withdrawal (non-archived reports only)
  const citizenWithdrawAllowed = new Set([
    'status',
    'withdrawnAt',
    'withdrawnBy',
    'withdrawalReason',
    'timeline',
    'updatedAt',
  ]);
  const citizenWithdrawBranch = (() => {
    if (!('userId' in before) || before.userId !== auth.uid) return false;
    if ('archived' in before && before.archived === true) return false;
    if (before.status !== 'Submitted' && before.status !== 'Under Review') return false;
    if (after.status !== 'Withdrawn') return false;
    if (after.userId !== before.userId) return false;
    if ('id' in before && after.id !== before.id) return false;
    if ('trackingNumber' in before && after.trackingNumber !== before.trackingNumber) return false;
    if (!affected.every((k) => citizenWithdrawAllowed.has(k))) return false;
    if (after.withdrawnBy !== auth.uid) return false;
    if (typeof after.withdrawnAt !== 'string' || after.withdrawnAt.length < 10) return false;
    if (
      'withdrawalReason' in after &&
      (typeof after.withdrawalReason !== 'string' || after.withdrawalReason.length > 1000)
    )
      return false;
    if (!Array.isArray(after.timeline)) return false;
    return typeof after.updatedAt === 'string' && after.updatedAt.length >= 10;
  })();

  // Admin branch 1: workflow & resolution fields (non-archived reports only)
  const adminAllowed = new Set([
    'status',
    'department',
    'assignedDepartment',
    'assignedOfficer',
    'adminRemarks',
    'resolutionDetails',
    'resolutionPhotoUrl',
    'resolvedAt',
    'timeline',
    'updatedAt',
    'updatedBy',
    'duplicateOf',
  ]);
  const adminStatuses = new Set(['Submitted', 'Under Review', 'Assigned', 'In Progress', 'Resolved', 'Rejected']);
  const adminBranch = (() => {
    if (!isAdmin(auth, db)) return false;
    if ('userId' in before && after.userId !== before.userId) return false;
    if ('trackingNumber' in before && after.trackingNumber !== before.trackingNumber) return false;
    if ('id' in before && after.id !== before.id) return false;
    if ('archived' in before && before.archived === true) return false;
    if (!affected.every((k) => adminAllowed.has(k))) return false;
    if (!adminStatuses.has(after.status)) return false;
    if (after.status === 'Resolved' && (typeof after.resolutionDetails !== 'string' || after.resolutionDetails.length === 0))
      return false;
    return typeof after.updatedAt === 'string' && after.updatedAt.length >= 10;
  })();

  // Admin branch 2: authorized archive (soft-delete) preserving status & requiring request.time
  const adminArchiveAllowed = new Set([
    'archived',
    'archivedAt',
    'archivedBy',
    'archiveReason',
    'timeline',
    'updatedAt',
    'updatedBy',
  ]);
  const adminArchiveBranch = (() => {
    if (!canArchiveReports(auth, db)) return false;
    if ('userId' in before && after.userId !== before.userId) return false;
    if ('trackingNumber' in before && after.trackingNumber !== before.trackingNumber) return false;
    if ('id' in before && after.id !== before.id) return false;
    if ('status' in before && after.status !== before.status) return false;
    if ('archived' in before && before.archived === true) return false;
    if (!affected.every((k) => adminArchiveAllowed.has(k))) return false;
    if (after.archived !== true) return false;
    if (after.archivedAt !== SERVER_REQUEST_TIME) return false;
    if (after.archivedBy !== auth.uid) return false;
    if (
      'archiveReason' in after &&
      (typeof after.archiveReason !== 'string' || after.archiveReason.length > 1000)
    ) {
      return false;
    }
    if ('timeline' in after && !Array.isArray(after.timeline)) return false;
    if (typeof after.updatedAt !== 'string' || after.updatedAt.length < 10) return false;
    if (after.updatedBy !== auth.uid) return false;
    return true;
  })();

  return citizenNoteBranch || citizenWithdrawBranch || adminBranch || adminArchiveBranch;
}

function canDeleteReport(auth: MockAuthContext | null, db: MockDbState): boolean {
  return canManageAdmins(auth, db);
}

function canWriteUserProfile(
  auth: MockAuthContext | null,
  userId: string,
  before: Record<string, any> | null,
  after: Record<string, any>
): boolean {
  if (!isAuthenticated(auth) || !auth || auth.uid !== userId) return false;
  const allowedKeys = new Set([
    'id',
    'fullName',
    'email',
    'phone',
    'ward',
    'city',
    'preferredLanguage',
    'avatarColor',
    'avatarUrl',
    'notificationPreferences',
    'updatedAt',
  ]);
  const privilegedKeys = ['role', 'isAdmin', 'admin', 'active', 'permissions', 'customClaims', 'superadmin', 'department'];
  if (privilegedKeys.some((k) => k in after)) return false;
  const checkedKeys = before ? getAffectedKeys(before, after) : Object.keys(after);
  if (!checkedKeys.every((k) => allowedKeys.has(k))) return false;
  if (before && 'id' in before && after.id !== before.id) return false;
  if (after.id !== userId) return false;
  if (typeof after.fullName !== 'string' || after.fullName.length === 0 || after.fullName.length > 150) return false;
  if (typeof after.email !== 'string' || after.email.length > 254) return false;
  if ('phone' in after && (typeof after.phone !== 'string' || after.phone.length > 40)) return false;
  if ('ward' in after && (typeof after.ward !== 'string' || after.ward.length > 120)) return false;
  if ('city' in after && (typeof after.city !== 'string' || after.city.length > 120)) return false;
  if ('preferredLanguage' in after && (typeof after.preferredLanguage !== 'string' || after.preferredLanguage.length > 60))
    return false;
  if ('avatarColor' in after && (typeof after.avatarColor !== 'string' || after.avatarColor.length > 40)) return false;
  if (
    'avatarUrl' in after &&
    after.avatarUrl !== null &&
    (typeof after.avatarUrl !== 'string' || after.avatarUrl.length > 2000)
  )
    return false;
  if (
    'notificationPreferences' in after &&
    (typeof after.notificationPreferences !== 'object' ||
      after.notificationPreferences === null ||
      Array.isArray(after.notificationPreferences))
  )
    return false;
  if ('updatedAt' in after && (typeof after.updatedAt !== 'string' || after.updatedAt.length < 10)) return false;
  return true;
}

function isNonArchivedReportById(db: MockDbState, reportId: string): boolean {
  const report = db.civic_reports[reportId];
  return report !== undefined && (!('archived' in report) || report.archived !== true);
}

function canCreateStatusHistory(
  auth: MockAuthContext | null,
  db: MockDbState,
  reportId: string,
  data: Record<string, any>
): boolean {
  if (!isAuthenticated(auth) || !auth) return false;
  if (data.reportId !== reportId || data.changedByUid !== auth.uid) return false;
  if (typeof data.timestamp !== 'string' || data.timestamp.length < 10) return false;
  if (isAdmin(auth, db) && data.changedByRole === 'admin') {
    return ['Submitted', 'Under Review', 'Assigned', 'In Progress', 'Resolved', 'Rejected'].includes(data.toStatus);
  }
  if (
    isReportOwnerById(auth, db, reportId) &&
    isNonArchivedReportById(db, reportId) &&
    data.changedByRole === 'citizen'
  ) {
    if (data.toStatus === 'Submitted' && (!('fromStatus' in data) || data.fromStatus === null)) return true;
    if (data.toStatus === 'Withdrawn' && ['Submitted', 'Under Review'].includes(data.fromStatus)) return true;
  }
  return false;
}

function canCreateAuditLog(
  auth: MockAuthContext | null,
  db: MockDbState,
  data: Record<string, any>,
  afterDb: MockDbState = db
): boolean {
  if (!isAuthenticated(auth) || !auth) return false;
  if (data.actorUid !== auth.uid) return false;
  if (typeof data.targetId !== 'string' || data.targetId.length === 0) return false;
  if (typeof data.action !== 'string' || data.action.length === 0) return false;
  if (typeof data.timestamp !== 'string' || data.timestamp.length < 10) return false;
  if (isAdmin(auth, db) && data.actorRole === 'admin') {
    return data.action !== 'report_archived' || isValidArchiveAuditLog(auth, db, data, afterDb);
  }
  const citizenKeys = new Set(['action', 'targetType', 'targetId', 'actorUid', 'actorRole', 'summary', 'timestamp']);
  return (
    data.actorRole === 'citizen' &&
    ['report_created', 'report_withdrawn'].includes(data.action) &&
    data.targetType === 'civic_report' &&
    data.targetId.length <= 128 &&
    SAFE_DOC_ID_REGEX.test(data.targetId) &&
    isReportOwnerById(auth, db, data.targetId) &&
    isNonArchivedReportById(db, data.targetId) &&
    Object.keys(data).every((k) => citizenKeys.has(k)) &&
    typeof data.summary === 'string' &&
    data.summary.length > 0 &&
    data.summary.length <= 500
  );
}

function canReadStorageReportImage(
  auth: MockAuthContext | null,
  db: MockDbState,
  pathInfo: { scopedUserId?: string; reportId: string }
): boolean {
  if (!isAuthenticated(auth) || !auth) return false;
  if (pathInfo.scopedUserId !== undefined) {
    return auth.uid === pathInfo.scopedUserId || isAdmin(auth, db);
  }
  return isReportOwnerById(auth, db, pathInfo.reportId) || isAdmin(auth, db);
}

function canWriteStorageResolution(
  auth: MockAuthContext | null,
  db: MockDbState,
  resource: { size: number; contentType: string } | null,
  operation: 'create' | 'update' | 'delete'
): boolean {
  if (!isAdmin(auth, db)) return false;
  if (operation === 'delete') return true;
  return (
    resource !== null &&
    resource.size < 5 * 1024 * 1024 &&
    resource.contentType.startsWith('image/')
  );
}

// Shared test fixtures
const citizenA: MockAuthContext = { uid: 'citizen-a', token: {} };
const citizenB: MockAuthContext = { uid: 'citizen-b', token: {} };
const deactivatedAdminWithStaleClaim: MockAuthContext = {
  uid: 'admin-deactivated',
  token: { admin: true },
};
const activeAdmin: MockAuthContext = {
  uid: 'admin-active',
  token: {},
};
const claimOnlyAdmin: MockAuthContext = {
  uid: 'admin-claim-only',
  token: { admin: true },
};
const missingActiveFlagAdmin: MockAuthContext = {
  uid: 'admin-missing-flag',
  token: { admin: true },
};

const sampleDb: MockDbState = {
  admins: {
    'admin-deactivated': { uid: 'admin-deactivated', email: 'old@civifix.gov', role: 'superadmin', active: false },
    'admin-active': { uid: 'admin-active', email: 'active@civifix.gov', role: 'superadmin', active: true },
    'admin-missing-flag': { uid: 'admin-missing-flag', email: 'legacy@civifix.gov', role: 'staff' },
  },
  civic_reports: {
    'rep-b-001': {
      id: 'rep-b-001',
      trackingNumber: 'CFX-2026-2001',
      userId: 'citizen-b',
      category: 'Potholes',
      severity: 'High',
      status: 'Submitted',
      description: 'Deep pothole near school gate.',
      location: { address: 'School Road, Ward 3', latitude: 17.4, longitude: 78.5 },
      citizenNotes: [],
      timeline: [{ status: 'Submitted', timestamp: '2026-11-18T00:00:00.000Z', note: 'Submitted' }],
      submittedAt: '2026-11-18T00:00:00.000Z',
      updatedAt: '2026-11-18T00:00:00.000Z',
    },
    'rep-a-in-progress': {
      id: 'rep-a-in-progress',
      trackingNumber: 'CFX-2026-2002',
      userId: 'citizen-a',
      category: 'Garbage',
      severity: 'Medium',
      status: 'In Progress',
      description: 'Overflowing bin near bus stop.',
      location: { address: 'Main Bus Stop', latitude: null, longitude: null },
      citizenNotes: [],
      timeline: [{ status: 'Submitted', timestamp: '2026-11-18T00:00:00.000Z', note: 'Submitted' }],
      submittedAt: '2026-11-18T00:00:00.000Z',
      updatedAt: '2026-11-18T00:00:00.000Z',
    },
    'rep-a-eligible': {
      id: 'rep-a-eligible',
      trackingNumber: 'CFX-2026-2003',
      userId: 'citizen-a',
      category: 'Drainage',
      severity: 'Moderate',
      status: 'Submitted',
      description: 'Blocked stormwater drain.',
      location: { address: 'Market Lane', latitude: 17.41, longitude: 78.49 },
      citizenNotes: [],
      timeline: [{ status: 'Submitted', timestamp: '2026-11-18T00:00:00.000Z', note: 'Submitted' }],
      submittedAt: '2026-11-18T00:00:00.000Z',
      updatedAt: '2026-11-18T00:00:00.000Z',
    },
  },
};

// =========================================================================
// 0. RULES SYNTAX SANITY & DEPLOYMENT CONFIGURATION
// =========================================================================
{
  assert(firestoreRules.startsWith("rules_version = '2';"), 'firestore.rules declares rules_version 2');
  assert(storageRules.startsWith("rules_version = '2';"), 'storage.rules declares rules_version 2');
  assertBalancedBraces(firestoreRules, 'firestore.rules');
  assertBalancedBraces(storageRules, 'storage.rules');

  const blueprint = JSON.parse(blueprintRaw);
  assert(blueprint?.entities?.AdminProfile, 'firebase-blueprint.json defines AdminProfile');
  assert(
    blueprint.entities.AdminProfile.properties.role.enum.includes('staff'),
    'AdminProfile role enum aligns with staff/superadmin/ward_admin/department_head'
  );

  const firebaseJson = JSON.parse(firebaseJsonRaw);
  assert.strictEqual(firebaseJson?.firestore?.rules, 'firestore.rules');
  assert.strictEqual(firebaseJson?.storage?.rules, 'storage.rules');

  const firebaserc = JSON.parse(firebasercRaw);
  assert.strictEqual(firebaserc?.projects?.default, 'civifix-ai-214ec');
  console.log('  ✓ Rules syntax balance, firebase.json, .firebaserc (civifix-ai-214ec), and blueprint schema verified');
}

// =========================================================================
// 1. CITIZEN CANNOT ACCESS ANOTHER CITIZEN'S PRIVATE REPORT
// =========================================================================
{
  assert(
    firestoreRules.includes('isAdmin() || resource.data.userId == request.auth.uid'),
    'firestore.rules restricts report read to owner or admin'
  );
  assert.strictEqual(canReadReport(citizenA, sampleDb, 'rep-b-001'), false);
  assert.strictEqual(canReadReport(null, sampleDb, 'rep-b-001'), false);
  assert.strictEqual(canReadReport(citizenB, sampleDb, 'rep-b-001'), true);
  console.log("  ✓ 1. Citizen cannot access another citizen's private report");
}

// =========================================================================
// 2. CITIZEN CANNOT MODIFY ADMINISTRATIVE REPORT FIELDS (OR PRIVILEGED USER FIELDS)
// =========================================================================
{
  assert(
    firestoreRules.includes('!request.resource.data.keys().hasAny([') &&
      firestoreRules.includes("'resolutionDetails'") &&
      firestoreRules.includes("'assignedOfficer'") &&
      firestoreRules.includes('hasNoPrivilegedUserFields'),
    'firestore.rules forbids administrative report fields on create and privileged profile fields'
  );
  const baseEligible = sampleDb.civic_reports['rep-a-eligible'];
  assert.strictEqual(
    canUpdateReport(citizenA, sampleDb, baseEligible, {
      ...baseEligible,
      assignedOfficer: 'Officer Hijack',
      updatedAt: '2026-11-18T01:00:00.000Z',
    }),
    false
  );
  assert.strictEqual(
    canUpdateReport(citizenA, sampleDb, baseEligible, {
      ...baseEligible,
      status: 'Resolved',
      resolutionDetails: 'Spoofed resolution',
      updatedAt: '2026-11-18T01:00:00.000Z',
    }),
    false
  );
  assert.strictEqual(
    canCreateReport(citizenA, 'rep-spoof', {
      ...baseEligible,
      id: 'rep-spoof',
      userId: 'citizen-a',
      assignedOfficer: 'Fake Officer',
    }),
    false
  );
  assert.strictEqual(
    canWriteUserProfile(citizenA, 'citizen-a', null, {
      id: 'citizen-a',
      fullName: 'Citizen A',
      email: 'a@example.com',
      role: 'superadmin',
      isAdmin: true,
    }),
    false
  );
  console.log('  ✓ 2. Citizen cannot modify administrative report fields or privileged user fields');
}

// =========================================================================
// 3. DEACTIVATED ADMIN IS DENIED EVEN WITH A STALE CUSTOM CLAIM
// =========================================================================
{
  const isAdminMatch = firestoreRules.match(/function isAdmin\(\)\s*\{[\s\S]*?\n\s{4}\}/);
  assert(isAdminMatch, 'firestore.rules defines isAdmin()');
  const isAdminBody = isAdminMatch![0];
  const existsIdx = isAdminBody.indexOf('exists(/databases/$(database)/documents/admins/$(request.auth.uid))');
  const tokenIdx = isAdminBody.indexOf('request.auth.token.admin == true');
  assert(existsIdx !== -1 && tokenIdx !== -1 && existsIdx < tokenIdx, 'isAdmin() evaluates /admins/{uid} before token claim');
  assert(
    isAdminBody.includes("(!('active' in request.auth.token) || request.auth.token.active == true)"),
    'firestore.rules isAdmin() denies claim-only tokens with active != true'
  );

  const storageIsAdminMatch = storageRules.match(/function isAdmin\(\)\s*\{[\s\S]*?\n\s{4}\}/);
  assert(storageIsAdminMatch, 'storage.rules defines isAdmin()');
  assert(
    storageIsAdminMatch![0].includes("(!('active' in request.auth.token) || request.auth.token.active == true)"),
    'storage.rules isAdmin() denies claim-only tokens with active != true'
  );

  const deactivatedClaimOnlyAdmin: MockAuthContext = {
    uid: 'admin-claim-only-inactive',
    token: { admin: true, active: false, role: 'superadmin' },
  };
  assert.strictEqual(isAdmin(deactivatedAdminWithStaleClaim, sampleDb), false);
  assert.strictEqual(isAdmin(missingActiveFlagAdmin, sampleDb), false);
  assert.strictEqual(isAdmin(deactivatedClaimOnlyAdmin, sampleDb), false);
  assert.strictEqual(canReadReport(deactivatedAdminWithStaleClaim, sampleDb, 'rep-b-001'), false);
  assert.strictEqual(canReadReport(deactivatedClaimOnlyAdmin, sampleDb, 'rep-b-001'), false);
  assert.strictEqual(
    canWriteStorageResolution(deactivatedAdminWithStaleClaim, sampleDb, { size: 1024, contentType: 'image/jpeg' }, 'create'),
    false
  );
  assert.strictEqual(
    canWriteStorageResolution(deactivatedClaimOnlyAdmin, sampleDb, { size: 1024, contentType: 'image/jpeg' }, 'create'),
    false
  );
  console.log('  ✓ 3. Deactivated admin (doc or claim-only) and missing active flag are denied even with stale custom claim');
}

// =========================================================================
// 4. ADMIN WITH active == true IS AUTHORIZED (AND FALLBACK WHEN NO DOC EXISTS)
// =========================================================================
{
  const adminsSection = firestoreRules.match(/match \/admins\/\{adminId\}[\s\S]*?\n\s{4}\}/)?.[0] || '';
  assert(
    adminsSection.includes('allow read: if isAdmin();') &&
      !adminsSection.includes('request.auth.uid == adminId') &&
      adminsSection.includes('allow create: if canManageAdmins()') &&
      adminsSection.includes('allow update: if canManageAdmins()') &&
      adminsSection.includes('allow delete: if canManageAdmins()'),
    '/admins/{adminId} restricts reads to isAdmin() and writes/deletes to canManageAdmins()'
  );
  assert.strictEqual(isAdmin(activeAdmin, sampleDb), true);
  assert.strictEqual(isAdmin(claimOnlyAdmin, sampleDb), true);
  assert.strictEqual(isAdmin(citizenA, sampleDb), false);
  console.log('  ✓ 4. Admin with active == true (and claim-only fallback when doc absent) is authorized');
}

// =========================================================================
// 5. CITIZEN CANNOT READ ANOTHER USER'S REPORT IMAGES
// =========================================================================
{
  assert(
    !storageRules.includes('allow read: if isAuthenticated();'),
    'storage.rules contains NO broad allow read: if isAuthenticated() rules'
  );
  assert.strictEqual(
    canReadStorageReportImage(citizenA, sampleDb, { scopedUserId: 'citizen-b', reportId: 'rep-b-001' }),
    false
  );
  assert.strictEqual(canReadStorageReportImage(citizenA, sampleDb, { reportId: 'rep-b-001' }), false);
  assert.strictEqual(
    canReadStorageReportImage(citizenB, sampleDb, { scopedUserId: 'citizen-b', reportId: 'rep-b-001' }),
    true
  );
  assert.strictEqual(canReadStorageReportImage(citizenB, sampleDb, { reportId: 'rep-b-001' }), true);
  assert.strictEqual(canReadStorageReportImage(activeAdmin, sampleDb, { reportId: 'rep-b-001' }), true);
  assert.strictEqual(canReadStorageReportImage(deactivatedAdminWithStaleClaim, sampleDb, { reportId: 'rep-b-001' }), false);
  console.log("  ✓ 5. Citizen cannot read another user's report or resolution images");
}

// =========================================================================
// 6. CITIZEN CANNOT UPLOAD OR DELETE RESOLUTION EVIDENCE
// =========================================================================
{
  const resolutionMatch = storageRules.match(/match \/resolutions\/\{reportId\}\/\{fileName\}[\s\S]*?\n\s{4}\}/)?.[0] || '';
  assert(
    resolutionMatch.includes('allow create, update: if isAdmin()') &&
      resolutionMatch.includes('request.resource.size < 5 * 1024 * 1024') &&
      resolutionMatch.includes("request.resource.contentType.matches('image/.*')") &&
      resolutionMatch.includes('allow delete: if isAdmin();'),
    'resolutions/{reportId}/{fileName} restricts create/update/delete to active admins and enforces <5MB image/*'
  );
  assert.strictEqual(
    canWriteStorageResolution(citizenA, sampleDb, { size: 50000, contentType: 'image/jpeg' }, 'create'),
    false
  );
  assert.strictEqual(canWriteStorageResolution(citizenA, sampleDb, null, 'delete'), false);
  assert.strictEqual(
    canWriteStorageResolution(activeAdmin, sampleDb, { size: 50000, contentType: 'application/pdf' }, 'create'),
    false,
    'Non-image MIME types rejected even for admins'
  );
  assert.strictEqual(
    canWriteStorageResolution(activeAdmin, sampleDb, { size: 6 * 1024 * 1024, contentType: 'image/png' }, 'create'),
    false,
    'Files >= 5 MiB rejected'
  );
  assert.strictEqual(
    canWriteStorageResolution(activeAdmin, sampleDb, { size: 500000, contentType: 'image/jpeg' }, 'create'),
    true
  );
  console.log('  ✓ 6. Citizen cannot upload or delete resolution evidence');
}

// =========================================================================
// 7. CITIZEN CANNOT CREATE ADMINISTRATIVE AUDIT ENTRIES
// =========================================================================
{
  const auditSection = firestoreRules.match(/match \/auditLogs\/\{logId\}[\s\S]*?\n\s{4}\}/)?.[0] || '';
  assert(
    auditSection.includes('allow read: if isAdmin();') &&
      auditSection.includes("request.resource.data.actorRole == 'admin'") &&
      auditSection.includes("request.resource.data.action in ['report_created', 'report_withdrawn']"),
    '/auditLogs restricts reads and administrative audit creation to isAdmin()'
  );
  assert.strictEqual(
    canCreateAuditLog(citizenA, sampleDb, {
      action: 'admin_status_change',
      targetType: 'civic_report',
      targetId: 'rep-a-eligible',
      actorUid: 'citizen-a',
      actorRole: 'admin',
      summary: 'Spoofed admin action',
      timestamp: '2026-11-18T01:00:00.000Z',
    }),
    false
  );
  assert.strictEqual(
    canCreateAuditLog(citizenA, sampleDb, {
      action: 'admin_status_change',
      targetType: 'civic_report',
      targetId: 'rep-a-eligible',
      actorUid: 'citizen-a',
      actorRole: 'citizen',
      summary: 'Spoofed action under citizen role',
      timestamp: '2026-11-18T01:00:00.000Z',
    }),
    false
  );
  assert.strictEqual(
    canCreateAuditLog(citizenA, sampleDb, {
      action: 'report_created',
      targetType: 'civic_report',
      targetId: 'rep-b-001',
      actorUid: 'citizen-a',
      actorRole: 'citizen',
      summary: 'Cross-owner audit attempt',
      timestamp: '2026-11-18T01:00:00.000Z',
    }),
    false
  );
  assert.strictEqual(
    canCreateAuditLog(citizenA, sampleDb, {
      action: 'report_created',
      targetType: 'civic_report',
      targetId: 'rep-a-eligible',
      actorUid: 'citizen-a',
      actorRole: 'citizen',
      summary: 'Citizen submitted report CFX-2026-2003.',
      timestamp: '2026-11-18T01:00:00.000Z',
    }),
    true
  );
  console.log('  ✓ 7. Citizen cannot create administrative audit entries (citizen lifecycle logs remain valid)');
}

// =========================================================================
// 8. CITIZEN CAN SUBMIT A VALID COMPLAINT (INCLUDING LEGACY PAYLOAD COMPATIBILITY)
// =========================================================================
{
  const validNewReport = {
    id: 'rep-new-001',
    trackingNumber: 'CFX-2026-3001',
    userId: 'citizen-a',
    citizenName: 'Citizen A',
    citizenEmail: 'a@example.com',
    category: 'Garbage accumulation',
    title: 'Garbage pile near park gate',
    description: 'Uncollected garbage bags blocking pedestrian walkway.',
    photoUrl: 'https://firebasestorage.googleapis.com/v0/b/civifix-ai-214ec.firebasestorage.app/o/reports%2Fcitizen-a%2Frep-new-001%2Fevidence.jpg',
    location: { address: 'Park Avenue, Ward 2', latitude: 17.39, longitude: 78.48, ward: 'Ward 2' },
    severity: 'High',
    status: 'Submitted',
    submittedAt: '2026-11-18T01:30:00.000Z',
    updatedAt: '2026-11-18T01:30:00.000Z',
    department: 'Solid Waste Management',
    slaDeadline: '24 Hours Rapid Redressal',
    timeline: [{ status: 'Submitted', timestamp: '2026-11-18T01:30:00.000Z', note: 'Submitted', officer: 'Citizen' }],
    citizenNotes: [],
    isDemo: false,
    syncedToCloud: true,
    storageSource: 'firestore',
  };
  assert.strictEqual(canCreateReport(citizenA, 'rep-new-001', validNewReport), true);

  // Legacy queued offline report carrying historical afterPhotoUrl & legacy category
  const legacyQueuedReport = {
    ...validNewReport,
    id: 'rep-legacy-002',
    category: 'Garbage',
    afterPhotoUrl: 'data:image/jpeg;base64,/9j/legacy',
  };
  assert.strictEqual(canCreateReport(citizenA, 'rep-legacy-002', legacyQueuedReport), true);
  console.log('  ✓ 8. Citizen can submit a valid complaint (and legacy queued records remain compatible)');
}

// =========================================================================
// 9. CITIZEN CAN WITHDRAW AN ELIGIBLE COMPLAINT
// =========================================================================
{
  const eligible = sampleDb.civic_reports['rep-a-eligible'];
  const inProgress = sampleDb.civic_reports['rep-a-in-progress'];
  assert.strictEqual(
    canUpdateReport(citizenA, sampleDb, eligible, {
      ...eligible,
      status: 'Withdrawn',
      withdrawnBy: 'citizen-a',
      withdrawnAt: '2026-11-18T02:00:00.000Z',
      withdrawalReason: 'Duplicate submission by mistake.',
      timeline: [
        ...(eligible.timeline as any[]),
        { status: 'Withdrawn', timestamp: '2026-11-18T02:00:00.000Z', note: 'Withdrawn by citizen' },
      ],
      updatedAt: '2026-11-18T02:00:00.000Z',
    }),
    true
  );
  assert.strictEqual(
    canUpdateReport(citizenA, sampleDb, inProgress, {
      ...inProgress,
      status: 'Withdrawn',
      withdrawnBy: 'citizen-a',
      withdrawnAt: '2026-11-18T02:00:00.000Z',
      timeline: inProgress.timeline,
      updatedAt: '2026-11-18T02:00:00.000Z',
    }),
    false,
    'Citizen cannot withdraw a report already In Progress'
  );
  console.log('  ✓ 9. Citizen can withdraw an eligible complaint (Submitted/Under Review only)');
}

// =========================================================================
// 10. ACTIVE ADMIN CAN UPDATE COMPLAINT STATUS AND RESOLUTION DETAILS
// =========================================================================
{
  const target = sampleDb.civic_reports['rep-b-001'];
  assert.strictEqual(
    canUpdateReport(activeAdmin, sampleDb, target, {
      ...target,
      status: 'In Progress',
      assignedDepartment: 'Roads & Infrastructure Maintenance',
      assignedOfficer: 'R. Verma',
      updatedBy: 'admin-active',
      updatedAt: '2026-11-18T02:10:00.000Z',
    }),
    true
  );
  assert.strictEqual(
    canUpdateReport(activeAdmin, sampleDb, target, {
      ...target,
      status: 'Resolved',
      updatedBy: 'admin-active',
      updatedAt: '2026-11-18T02:15:00.000Z',
    }),
    false,
    'Transitioning to Resolved without resolutionDetails is rejected'
  );
  assert.strictEqual(
    canUpdateReport(activeAdmin, sampleDb, target, {
      ...target,
      status: 'Resolved',
      resolutionDetails: 'Pothole patched and compacted with asphalt.',
      resolutionPhotoUrl: 'https://firebasestorage.googleapis.com/v0/b/civifix-ai-214ec.firebasestorage.app/o/resolutions%2Frep-b-001%2Fres.jpg',
      resolvedAt: '2026-11-18T02:20:00.000Z',
      updatedBy: 'admin-active',
      updatedAt: '2026-11-18T02:20:00.000Z',
    }),
    true
  );
  console.log('  ✓ 10. Active admin can update complaint status and required resolution details');
}

// =========================================================================
// 11. STATUS HISTORY AND AUDIT LOGS CANNOT BE MODIFIED OR DELETED BY UNAUTHORIZED USERS
// =========================================================================
{
  const historySection = firestoreRules.match(/match \/statusHistory\/\{historyId\}[\s\S]*?\n\s{6}\}/)?.[0] || '';
  const auditSection = firestoreRules.match(/match \/auditLogs\/\{logId\}[\s\S]*?\n\s{4}\}/)?.[0] || '';

  assert(historySection.includes('allow update, delete: if false;'), 'statusHistory forbids all updates and deletes');
  assert(auditSection.includes('allow update, delete: if false;'), 'auditLogs forbids all updates and deletes');
  assert(
    firestoreRules.includes('match /{document=**}') && firestoreRules.includes('allow read, write: if false;'),
    'firestore.rules ends with catch-all default deny'
  );
  assert(
    storageRules.includes('match /{allPaths=**}') && storageRules.includes('allow read, write: if false;'),
    'storage.rules ends with catch-all default deny'
  );

  // Citizens cannot create official status transitions or spoof changedByRole: 'admin'
  assert.strictEqual(
    canCreateStatusHistory(citizenA, sampleDb, 'rep-a-eligible', {
      reportId: 'rep-a-eligible',
      fromStatus: 'Submitted',
      toStatus: 'In Progress',
      changedByUid: 'citizen-a',
      changedByRole: 'citizen',
      timestamp: '2026-11-18T02:25:00.000Z',
    }),
    false
  );
  assert.strictEqual(
    canCreateStatusHistory(citizenA, sampleDb, 'rep-a-eligible', {
      reportId: 'rep-a-eligible',
      fromStatus: null,
      toStatus: 'Submitted',
      changedByUid: 'citizen-a',
      changedByRole: 'admin',
      timestamp: '2026-11-18T02:25:00.000Z',
    }),
    false
  );
  assert.strictEqual(
    canCreateStatusHistory(activeAdmin, sampleDb, 'rep-a-eligible', {
      reportId: 'rep-a-eligible',
      fromStatus: 'Submitted',
      toStatus: 'In Progress',
      changedByUid: 'admin-active',
      changedByRole: 'admin',
      timestamp: '2026-11-18T02:25:00.000Z',
    }),
    true
  );
  console.log('  ✓ 11. Status history and audit logs are immutable (no updates/deletes) and protected against unauthorized creation');
}

// =========================================================================
// 12. APPLIED ARCHIVE PERMISSION RULES (STATIC RULE-FILE CHECKS + LOCAL EVALUATOR)
//     Validates the actual firestore.rules file text AND simulates rule behavior locally.
//     Does NOT represent Firebase Emulator or live Firebase project verification.
// =========================================================================
{
  // Verify the rule role allowlist stays aligned with ADMIN_ROLE_CAPABILITIES
  assert.strictEqual(ADMIN_ROLE_CAPABILITIES.superadmin.canArchiveReports, true);
  assert.strictEqual(ADMIN_ROLE_CAPABILITIES.department_head.canArchiveReports, true);
  assert.strictEqual(ADMIN_ROLE_CAPABILITIES.ward_admin.canArchiveReports, false);
  assert.strictEqual(ADMIN_ROLE_CAPABILITIES.staff.canArchiveReports, false);

  // 12.0 Static rule-file checks directly against firestore.rules
  {
    const canArchiveMatch = firestoreRules.match(/function canArchiveReports\(\)\s*\{[\s\S]*?\n\s{4}\}/);
    assert(canArchiveMatch, 'firestore.rules defines canArchiveReports()');
    const canArchiveBody = canArchiveMatch![0];
    assert(canArchiveBody.includes('return isAdmin() &&'), 'canArchiveReports() requires isAdmin()');
    const docCheckIdx = canArchiveBody.indexOf(
      'exists(/databases/$(database)/documents/admins/$(request.auth.uid))'
    );
    const claimCheckIdx = canArchiveBody.indexOf("'admin' in request.auth.token");
    assert(
      docCheckIdx !== -1 && claimCheckIdx !== -1 && docCheckIdx < claimCheckIdx,
      'canArchiveReports() checks /admins/{uid} before custom-claim fallback'
    );
    assert(
      canArchiveBody.includes(
        "get(/databases/$(database)/documents/admins/$(request.auth.uid)).data.role in ['superadmin', 'department_head']"
      ),
      'canArchiveReports() restricts /admins/{uid} archiving to superadmin and department_head'
    );
    assert(
      canArchiveBody.includes("(!('active' in request.auth.token) || request.auth.token.active == true)") &&
        canArchiveBody.includes("'role' in request.auth.token") &&
        canArchiveBody.includes("request.auth.token.role in ['superadmin', 'department_head']"),
      'canArchiveReports() requires explicit authorized role claim and non-inactive token when no /admins/{uid} doc exists'
    );
    assert(
      !canArchiveBody.includes('request.auth.token.email'),
      'canArchiveReports() must never authorize archiving via an email allowlist'
    );

    const archiveAuditFnMatch = firestoreRules.match(/function isValidArchiveAuditLog\(\)\s*\{[\s\S]*?\n\s{4}\}/);
    assert(archiveAuditFnMatch, 'firestore.rules defines isValidArchiveAuditLog()');
    const archiveAuditBody = archiveAuditFnMatch![0];
    assert(
      archiveAuditBody.includes('return canArchiveReports()') &&
        archiveAuditBody.includes('d.actorUid == request.auth.uid') &&
        archiveAuditBody.includes("d.actorRole == 'admin'") &&
        archiveAuditBody.includes("d.targetType == 'civic_report'") &&
        archiveAuditBody.includes('d.targetId.size() <= 128') &&
        archiveAuditBody.includes("d.targetId.matches('^[a-zA-Z0-9_-]+$')") &&
        archiveAuditBody.includes('d.summary.size() <= 1200') &&
        archiveAuditBody.includes('existsAfter(/databases/$(database)/documents/civic_reports/$(d.targetId))') &&
        archiveAuditBody.includes(
          'getAfter(/databases/$(database)/documents/civic_reports/$(d.targetId)).data.archived == true'
        ) &&
        archiveAuditBody.includes(
          'getAfter(/databases/$(database)/documents/civic_reports/$(d.targetId)).data.archivedBy == request.auth.uid'
        ),
      'isValidArchiveAuditLog() enforces role, actorUid, targetType, safe targetId, summary bounds, and existsAfter()/getAfter() post-commit archive verification'
    );

    const reportsSection = firestoreRules.match(/match \/civic_reports\/\{reportId\}[\s\S]*?match \/statusHistory/)?.[0] || '';
    const createSection = reportsSection.match(/allow create:[\s\S]*?allow update:/)?.[0] || '';
    for (const field of ['archived', 'archivedAt', 'archivedBy', 'archiveReason']) {
      assert(
        createSection.includes(`'${field}'`),
        `/civic_reports allow create forbids client-supplied archive field '${field}'`
      );
    }

    const updateSection = reportsSection.match(/allow update:[\s\S]*?allow delete:/)?.[0] || '';
    const citizenBranch1 = updateSection.match(/\/\/ Citizen branch 1[\s\S]*?\/\/ Citizen branch 2/)?.[0] || '';
    const citizenBranch2 = updateSection.match(/\/\/ Citizen branch 2[\s\S]*?\/\/ Admin branch 1/)?.[0] || '';
    assert(
      citizenBranch1.includes("affectedKeys().hasOnly(['citizenNotes', 'updatedAt'])") &&
        citizenBranch1.includes("(!('archived' in resource.data) || resource.data.archived != true)"),
      'Citizen branch 1 (follow-up notes) blocks updates on archived complaints while preserving non-archived behavior'
    );
    assert(
      citizenBranch2.includes("resource.data.status in ['Submitted', 'Under Review']") &&
        citizenBranch2.includes("request.resource.data.status == 'Withdrawn'") &&
        citizenBranch2.includes("(!('archived' in resource.data) || resource.data.archived != true)"),
      'Citizen branch 2 (withdrawal) blocks updates on archived complaints while preserving non-archived behavior'
    );
    assert(
      updateSection.includes('canArchiveReports()') &&
        updateSection.includes("(!('status' in resource.data) || request.resource.data.status == resource.data.status)") &&
        updateSection.includes("(!('archived' in resource.data) || resource.data.archived != true)") &&
        updateSection.includes('request.resource.data.archived == true') &&
        updateSection.includes('request.resource.data.archivedAt == request.time') &&
        updateSection.includes('request.resource.data.archivedBy == request.auth.uid') &&
        updateSection.includes('request.resource.data.updatedBy == request.auth.uid') &&
        updateSection.includes('request.resource.data.archiveReason.size() <= 1000'),
      '/civic_reports allow update enforces strict archive branch with status preservation, server request.time, and UID alignment'
    );
    assert(
      reportsSection.includes('allow delete: if canManageAdmins();'),
      '/civic_reports allow delete requires strict active superadmin clearance via canManageAdmins()'
    );

    const nonArchivedHelperMatch = firestoreRules.match(/function isNonArchivedReportById\(reportId\)\s*\{[\s\S]*?\n\s{4}\}/);
    assert(nonArchivedHelperMatch, 'firestore.rules defines isNonArchivedReportById(reportId)');
    const nonArchivedHelperBody = nonArchivedHelperMatch![0];
    assert(
      nonArchivedHelperBody.includes('exists(/databases/$(database)/documents/civic_reports/$(reportId))') &&
        nonArchivedHelperBody.includes(
          "!('archived' in get(/databases/$(database)/documents/civic_reports/$(reportId)).data)"
        ) &&
        nonArchivedHelperBody.includes(
          'get(/databases/$(database)/documents/civic_reports/$(reportId)).data.archived != true'
        ),
      'isNonArchivedReportById(reportId) denies reports with archived == true while permitting legacy and archived == false reports'
    );

    const statusHistorySection = firestoreRules.match(/match \/statusHistory\/\{historyId\}[\s\S]*?\n\s{6}\}/)?.[0] || '';
    const citizenHistoryBranch = statusHistorySection.match(/isReportOwnerById\(reportId\)[\s\S]*?allow update, delete/)?.[0] || '';
    assert(
      statusHistorySection.includes('allow read: if isAuthenticated() && (\n          isReportOwnerById(reportId) || isAdmin()') &&
        citizenHistoryBranch.includes('isNonArchivedReportById(reportId)') &&
        citizenHistoryBranch.includes("request.resource.data.changedByRole == 'citizen'"),
      '/statusHistory citizen create requires non-archived parent complaint while preserving owner read and admin statusHistory creation'
    );

    const auditSection = firestoreRules.match(/match \/auditLogs\/\{logId\}[\s\S]*?\n\s{4}\}/)?.[0] || '';
    const citizenAuditBranch = auditSection.match(/actorRole == 'citizen'[\s\S]*?allow update, delete/)?.[0] || '';
    assert(
      auditSection.includes("request.resource.data.action != 'report_archived'") &&
        auditSection.includes('isValidArchiveAuditLog()') &&
        auditSection.includes('allow update, delete: if false;'),
      '/auditLogs allow create enforces isValidArchiveAuditLog() for report_archived while preserving immutability and other audit entries'
    );
    assert(
      citizenAuditBranch.includes('request.resource.data.targetId.size() <= 128') &&
        citizenAuditBranch.includes("request.resource.data.targetId.matches('^[a-zA-Z0-9_-]+$')") &&
        citizenAuditBranch.includes('isNonArchivedReportById(request.resource.data.targetId)'),
      '/auditLogs citizen create enforces safe single-segment targetId and blocks archived parent complaints'
    );
  }

  // Unified aliases referencing the single faithful top-level evaluator (no divergent duplicate logic)
  const canCreateReportProposed = canCreateReport;
  const canUpdateReportProposed = canUpdateReport;
  const canCreateAuditLogProposed = canCreateAuditLog;

  const archiveDb: MockDbState = {
    admins: {
      ...sampleDb.admins,
      'admin-dept-head': {
        uid: 'admin-dept-head',
        email: 'dept@civifix.gov',
        role: 'department_head',
        active: true,
      },
      'admin-ward': {
        uid: 'admin-ward',
        email: 'ward@civifix.gov',
        role: 'ward_admin',
        active: true,
      },
      'admin-staff': {
        uid: 'admin-staff',
        email: 'staff@civifix.gov',
        role: 'staff',
        active: true,
      },
      'admin-missing-role': {
        uid: 'admin-missing-role',
        email: 'norole@civifix.gov',
        active: true,
      },
      'admin-missing-active-super': {
        uid: 'admin-missing-active-super',
        email: 'missingactive@civifix.gov',
        role: 'superadmin',
      },
    },
    civic_reports: {
      ...sampleDb.civic_reports,
      'rep-withdrawn': {
        id: 'rep-withdrawn',
        trackingNumber: 'CFX-2026-2009',
        userId: 'citizen-a',
        category: 'Potholes',
        severity: 'Medium',
        status: 'Withdrawn',
        withdrawnAt: '2026-11-18T03:00:00.000Z',
        withdrawnBy: 'citizen-a',
        withdrawalReason: 'Resolved privately.',
        description: 'Small pothole at lane entrance.',
        location: { address: 'Oak Street', latitude: 17.42, longitude: 78.47 },
        citizenNotes: [],
        timeline: [{ status: 'Withdrawn', timestamp: '2026-11-18T03:00:00.000Z', note: 'Withdrawn' }],
        submittedAt: '2026-11-18T00:00:00.000Z',
        updatedAt: '2026-11-18T03:00:00.000Z',
      },
    },
  };

  const deptHeadAdmin: MockAuthContext = { uid: 'admin-dept-head', token: {} };
  const wardAdminWithStaleSuperClaim: MockAuthContext = {
    uid: 'admin-ward',
    token: { admin: true, role: 'superadmin' },
  };
  const staffAdminWithStaleSuperClaim: MockAuthContext = {
    uid: 'admin-staff',
    token: { admin: true, role: 'superadmin' },
  };
  const missingRoleAdminWithClaim: MockAuthContext = {
    uid: 'admin-missing-role',
    token: { admin: true, role: 'superadmin' },
  };
  const missingActiveSuperAdmin: MockAuthContext = {
    uid: 'admin-missing-active-super',
    token: { admin: true, role: 'superadmin' },
  };
  const claimOnlySuperAdmin: MockAuthContext = {
    uid: 'admin-claim-super',
    token: { admin: true, role: 'superadmin' },
  };
  const claimOnlyDeptHeadAdmin: MockAuthContext = {
    uid: 'admin-claim-dept',
    token: { admin: true, role: 'department_head' },
  };
  const claimOnlyStaffAdmin: MockAuthContext = {
    uid: 'admin-claim-staff',
    token: { admin: true, role: 'staff' },
  };
  const claimOnlyDeactivatedAdmin: MockAuthContext = {
    uid: 'admin-claim-deactivated',
    token: { admin: true, active: false, role: 'superadmin' },
  };
  const unverifiedRoleCitizen: MockAuthContext = {
    uid: 'citizen-unverified-role',
    token: { role: 'superadmin', email: 'superadmin@civifix.gov' },
  };

  const buildArchivePayload = (
    report: Record<string, any>,
    actorUid: string,
    reason = 'Duplicate entry',
    archivedAt: unknown = SERVER_REQUEST_TIME
  ) => ({
    ...report,
    archived: true,
    archivedAt,
    archivedBy: actorUid,
    archiveReason: reason,
    timeline: [
      ...(report.timeline as any[]),
      {
        status: report.status,
        timestamp: '2026-11-19T10:00:00.000Z',
        note: `Complaint archived by administrator: ${reason}`,
        officer: 'Municipal Administrator',
      },
    ],
    updatedAt: '2026-11-19T10:00:00.000Z',
    updatedBy: actorUid,
  });

  const targetActive = archiveDb.civic_reports['rep-b-001'];
  const targetWithdrawn = archiveDb.civic_reports['rep-withdrawn'];
  const targetEligible = archiveDb.civic_reports['rep-a-eligible'];

  // 12a. Active superadmin can archive ONLY with server-verified request.time (rejects client ISO strings)
  assert.strictEqual(
    canUpdateReportProposed(activeAdmin, archiveDb, targetActive, buildArchivePayload(targetActive, activeAdmin.uid)),
    true,
    'Active superadmin should be allowed to archive an active complaint with server-verified request.time'
  );
  assert.strictEqual(
    canUpdateReportProposed(
      activeAdmin,
      archiveDb,
      targetActive,
      buildArchivePayload(targetActive, activeAdmin.uid, 'Client ISO rejected', '2026-11-19T10:00:00.000Z')
    ),
    false,
    'Client-supplied ISO-8601 archivedAt string must be rejected when rules require request.time'
  );
  assert.strictEqual(
    canUpdateReportProposed(
      activeAdmin,
      archiveDb,
      targetActive,
      buildArchivePayload(targetActive, activeAdmin.uid, 'Bad date', 'not-an-iso-timestamp')
    ),
    false,
    'Malformed archivedAt string must be rejected'
  );
  assert.strictEqual(
    canUpdateReportProposed(
      activeAdmin,
      archiveDb,
      targetActive,
      buildArchivePayload(targetActive, activeAdmin.uid, 'Forged timestamp', { seconds: 1700000000, nanoseconds: 0 })
    ),
    false,
    'Forged Firestore Timestamp object that is not request.time must be rejected'
  );
  assert.strictEqual(
    canUpdateReportProposed(
      activeAdmin,
      archiveDb,
      targetActive,
      buildArchivePayload(targetActive, activeAdmin.uid, 'Client Date rejected', new Date('2026-11-19T10:00:00.000Z'))
    ),
    false,
    'Client-supplied Date object must be rejected when rules require request.time'
  );
  assert.strictEqual(
    canUpdateReportProposed(activeAdmin, archiveDb, targetWithdrawn, buildArchivePayload(targetWithdrawn, activeAdmin.uid)),
    true,
    'Active superadmin should be allowed to archive a Withdrawn complaint while preserving status'
  );
  assert.strictEqual(
    canUpdateReportProposed(activeAdmin, archiveDb, targetActive, {
      ...buildArchivePayload(targetActive, activeAdmin.uid),
      status: 'Withdrawn',
    }),
    false,
    'Archiving must reject any status change during archive update'
  );
  const alreadyArchived = buildArchivePayload(targetActive, activeAdmin.uid);
  assert.strictEqual(
    canUpdateReportProposed(activeAdmin, archiveDb, alreadyArchived, {
      ...alreadyArchived,
      archiveReason: 'Tampered reason',
      updatedAt: '2026-11-19T11:00:00.000Z',
    }),
    false,
    'Already-archived complaint cannot have archive metadata altered'
  );
  assert.strictEqual(
    canUpdateReportProposed(activeAdmin, archiveDb, alreadyArchived, {
      ...alreadyArchived,
      status: 'In Progress',
      updatedAt: '2026-11-19T11:00:00.000Z',
    }),
    false,
    'Already-archived complaint cannot be mutated via normal admin workflow branch'
  );

  // 12b. Active department_head can archive (matches ADMIN_ROLE_CAPABILITIES.department_head.canArchiveReports)
  const deptHeadArchivedReport = buildArchivePayload(targetActive, deptHeadAdmin.uid);
  assert.strictEqual(
    canUpdateReportProposed(deptHeadAdmin, archiveDb, targetActive, deptHeadArchivedReport),
    true,
    'Active department_head should be allowed to archive'
  );

  // 12c. Strict audit log integrity (actorUid, targetType, targetId, getAfter archived & archivedBy)
  const dbAfterDeptHeadArchive: MockDbState = {
    ...archiveDb,
    civic_reports: {
      ...archiveDb.civic_reports,
      [targetActive.id as string]: deptHeadArchivedReport,
    },
  };
  // Atomic transaction case: before DB is unarchived, after DB (getAfter) is archived by deptHeadAdmin
  assert.strictEqual(
    canCreateAuditLogProposed(
      deptHeadAdmin,
      archiveDb,
      {
        action: 'report_archived',
        targetType: 'civic_report',
        targetId: targetActive.id,
        actorUid: deptHeadAdmin.uid,
        actorRole: 'admin',
        summary: 'Archived duplicate complaint CFX-2026-2001.',
        timestamp: '2026-11-19T10:00:00.000Z',
      },
      dbAfterDeptHeadArchive
    ),
    true,
    'Atomic transaction/batch report_archived audit log passes via getAfter() when report is archived by actor'
  );
  // Sequential post-commit write case: DB already contains archived report
  assert.strictEqual(
    canCreateAuditLogProposed(deptHeadAdmin, dbAfterDeptHeadArchive, {
      action: 'report_archived',
      targetType: 'civic_report',
      targetId: targetActive.id,
      actorUid: deptHeadAdmin.uid,
      actorRole: 'admin',
      summary: 'Archived duplicate complaint CFX-2026-2001.',
      timestamp: '2026-11-19T10:00:00.000Z',
    }),
    true,
    'Post-commit report_archived audit log passes when referenced report is archived by actor'
  );
  // Reject report_archived log for an unarchived report
  assert.strictEqual(
    canCreateAuditLogProposed(deptHeadAdmin, archiveDb, {
      action: 'report_archived',
      targetType: 'civic_report',
      targetId: targetActive.id,
      actorUid: deptHeadAdmin.uid,
      actorRole: 'admin',
      summary: 'Bogus log for active report.',
      timestamp: '2026-11-19T10:00:00.000Z',
    }),
    false,
    'report_archived audit log must be rejected if referenced report is not archived'
  );
  // Reject report_archived log when report was archived by a different administrator
  assert.strictEqual(
    canCreateAuditLogProposed(activeAdmin, dbAfterDeptHeadArchive, {
      action: 'report_archived',
      targetType: 'civic_report',
      targetId: targetActive.id,
      actorUid: activeAdmin.uid,
      actorRole: 'admin',
      summary: 'Spoofed log for report archived by another admin.',
      timestamp: '2026-11-19T10:00:00.000Z',
    }),
    false,
    'report_archived audit log must be rejected when archivedBy does not match request.auth.uid'
  );
  // Reject report_archived log with wrong targetType or non-existent targetId or path traversal
  assert.strictEqual(
    canCreateAuditLogProposed(deptHeadAdmin, dbAfterDeptHeadArchive, {
      action: 'report_archived',
      targetType: 'user_profile',
      targetId: targetActive.id,
      actorUid: deptHeadAdmin.uid,
      actorRole: 'admin',
      summary: 'Wrong targetType.',
      timestamp: '2026-11-19T10:00:00.000Z',
    }),
    false,
    'report_archived audit log requires targetType == civic_report'
  );
  assert.strictEqual(
    canCreateAuditLogProposed(deptHeadAdmin, dbAfterDeptHeadArchive, {
      action: 'report_archived',
      targetType: 'civic_report',
      targetId: 'non-existent-report',
      actorUid: deptHeadAdmin.uid,
      actorRole: 'admin',
      summary: 'Missing target report.',
      timestamp: '2026-11-19T10:00:00.000Z',
    }),
    false,
    'report_archived audit log must fail if targetId does not exist'
  );
  assert.strictEqual(
    canCreateAuditLogProposed(deptHeadAdmin, dbAfterDeptHeadArchive, {
      action: 'report_archived',
      targetType: 'civic_report',
      targetId: '../admins/admin-dept-head',
      actorUid: deptHeadAdmin.uid,
      actorRole: 'admin',
      summary: 'Path traversal attempt.',
      timestamp: '2026-11-19T10:00:00.000Z',
    }),
    false,
    'report_archived audit log rejects path traversal characters in targetId'
  );
  // Existing audit log operations remain intact
  assert.strictEqual(
    canCreateAuditLogProposed(staffAdminWithStaleSuperClaim, archiveDb, {
      action: 'admin_status_change',
      targetType: 'civic_report',
      targetId: targetActive.id,
      actorUid: staffAdminWithStaleSuperClaim.uid,
      actorRole: 'admin',
      summary: 'Updated status to In Progress.',
      timestamp: '2026-11-19T10:00:00.000Z',
    }),
    true,
    'Existing admin_status_change audit logs remain allowed for active admins'
  );

  // 12d. Custom-claim fallback: requires explicit superadmin/department_head role when no /admins/{uid} doc exists
  assert.strictEqual(
    isAdmin(claimOnlyAdmin, archiveDb),
    true,
    'Legacy claim-only { admin: true } without role preserves isAdmin() read/workflow compatibility'
  );
  assert.strictEqual(
    canUpdateReportProposed(claimOnlyAdmin, archiveDb, targetActive, buildArchivePayload(targetActive, claimOnlyAdmin.uid)),
    false,
    'Claim-only { admin: true } WITHOUT an explicit superadmin/department_head role cannot archive'
  );
  assert.strictEqual(
    canUpdateReportProposed(
      claimOnlySuperAdmin,
      archiveDb,
      targetActive,
      buildArchivePayload(targetActive, claimOnlySuperAdmin.uid)
    ),
    true,
    'Claim-only admin with explicit { admin: true, role: superadmin } and no /admins/{uid} doc can archive'
  );
  assert.strictEqual(
    canUpdateReportProposed(
      claimOnlyDeptHeadAdmin,
      archiveDb,
      targetActive,
      buildArchivePayload(targetActive, claimOnlyDeptHeadAdmin.uid)
    ),
    true,
    'Claim-only admin with explicit { admin: true, role: department_head } and no /admins/{uid} doc can archive'
  );
  assert.strictEqual(
    canUpdateReportProposed(
      claimOnlyStaffAdmin,
      archiveDb,
      targetActive,
      buildArchivePayload(targetActive, claimOnlyStaffAdmin.uid)
    ),
    false,
    'Claim-only admin with role: staff cannot archive'
  );
  assert.strictEqual(
    canUpdateReportProposed(
      claimOnlyDeactivatedAdmin,
      archiveDb,
      targetActive,
      buildArchivePayload(targetActive, claimOnlyDeactivatedAdmin.uid)
    ),
    false,
    'Claim-only admin with token.active === false cannot archive'
  );

  // 12e. ward_admin, staff, and missing-role /admins/{uid} cannot archive (even with stale superadmin claim)
  assert.strictEqual(
    canUpdateReportProposed(
      wardAdminWithStaleSuperClaim,
      archiveDb,
      targetActive,
      buildArchivePayload(targetActive, wardAdminWithStaleSuperClaim.uid)
    ),
    false,
    'Active ward_admin cannot archive even with stale superadmin claim'
  );
  assert.strictEqual(
    canUpdateReportProposed(
      staffAdminWithStaleSuperClaim,
      archiveDb,
      targetActive,
      buildArchivePayload(targetActive, staffAdminWithStaleSuperClaim.uid)
    ),
    false,
    'Active staff cannot archive even with stale superadmin claim'
  );
  assert.strictEqual(
    canUpdateReportProposed(
      missingRoleAdminWithClaim,
      archiveDb,
      targetActive,
      buildArchivePayload(targetActive, missingRoleAdminWithClaim.uid)
    ),
    false,
    'Existing /admins/{uid} doc without an explicit authorized role cannot fall back to custom claim for archiving'
  );
  assert.strictEqual(
    canCreateAuditLogProposed(wardAdminWithStaleSuperClaim, dbAfterDeptHeadArchive, {
      action: 'report_archived',
      targetType: 'civic_report',
      targetId: targetActive.id,
      actorUid: wardAdminWithStaleSuperClaim.uid,
      actorRole: 'admin',
      summary: 'Unauthorized archive log attempt.',
      timestamp: '2026-11-19T10:00:00.000Z',
    }),
    false,
    'ward_admin cannot forge a report_archived audit log entry'
  );

  // 12f. Deactivated admin & missing active flag admin cannot archive
  assert.strictEqual(
    canUpdateReportProposed(
      deactivatedAdminWithStaleClaim,
      archiveDb,
      targetActive,
      buildArchivePayload(targetActive, deactivatedAdminWithStaleClaim.uid)
    ),
    false,
    'Deactivated admin cannot archive even with stale custom claim'
  );
  assert.strictEqual(
    canUpdateReportProposed(
      missingActiveSuperAdmin,
      archiveDb,
      targetActive,
      buildArchivePayload(targetActive, missingActiveSuperAdmin.uid)
    ),
    false,
    'Admin document missing active == true cannot archive even with role superadmin'
  );
  assert.strictEqual(
    canUpdateReportProposed(
      missingActiveFlagAdmin,
      archiveDb,
      targetActive,
      buildArchivePayload(targetActive, missingActiveFlagAdmin.uid)
    ),
    false,
    'Legacy admin document missing active flag cannot archive'
  );

  // 12g. Citizen (and unverified role / email-only token) cannot archive or forge archive metadata
  assert.strictEqual(
    canUpdateReportProposed(citizenA, archiveDb, targetEligible, buildArchivePayload(targetEligible, citizenA.uid)),
    false,
    'Citizen cannot archive their own report'
  );
  assert.strictEqual(
    canUpdateReportProposed(
      unverifiedRoleCitizen,
      archiveDb,
      targetActive,
      buildArchivePayload(targetActive, unverifiedRoleCitizen.uid)
    ),
    false,
    'User with unverified role claim or allowlisted email without admin == true cannot archive'
  );
  assert.strictEqual(
    canCreateReportProposed(citizenA, 'rep-forged-archive', {
      ...targetEligible,
      id: 'rep-forged-archive',
      userId: 'citizen-a',
      archived: true,
      archivedAt: '2026-11-19T10:00:00.000Z',
      archivedBy: 'citizen-a',
      archiveReason: 'Forged on create',
    }),
    false,
    'Citizen cannot forge archive metadata during complaint creation'
  );
  assert.strictEqual(
    canUpdateReportProposed(citizenA, archiveDb, targetEligible, {
      ...targetEligible,
      status: 'Withdrawn',
      withdrawnBy: 'citizen-a',
      withdrawnAt: '2026-11-19T10:00:00.000Z',
      archived: true,
      timeline: targetEligible.timeline,
      updatedAt: '2026-11-19T10:00:00.000Z',
    }),
    false,
    'Citizen cannot sneak archived flag into a withdrawal update'
  );

  // 12h. Citizen can still submit, add follow-up note, and withdraw valid complaints
  assert.strictEqual(
    canCreateReportProposed(citizenA, 'rep-valid-citizen', {
      ...targetEligible,
      id: 'rep-valid-citizen',
      userId: 'citizen-a',
    }),
    true,
    'Citizen can still submit valid complaints'
  );
  assert.strictEqual(
    canUpdateReportProposed(citizenA, archiveDb, targetEligible, {
      ...targetEligible,
      citizenNotes: ['Follow-up photo added'],
      updatedAt: '2026-11-19T10:05:00.000Z',
    }),
    true,
    'Citizen can still append a follow-up note on their own complaint'
  );
  assert.strictEqual(
    canUpdateReportProposed(citizenA, archiveDb, targetEligible, {
      ...targetEligible,
      status: 'Withdrawn',
      withdrawnBy: 'citizen-a',
      withdrawnAt: '2026-11-19T10:05:00.000Z',
      withdrawalReason: 'Duplicate report.',
      timeline: [
        ...(targetEligible.timeline as any[]),
        { status: 'Withdrawn', timestamp: '2026-11-19T10:05:00.000Z', note: 'Withdrawn' },
      ],
      updatedAt: '2026-11-19T10:05:00.000Z',
    }),
    true,
    'Citizen can still withdraw an eligible complaint'
  );
  assert.strictEqual(
    canUpdateReportProposed(citizenA, archiveDb, archiveDb.civic_reports['rep-a-in-progress'], {
      ...archiveDb.civic_reports['rep-a-in-progress'],
      status: 'Withdrawn',
      withdrawnBy: 'citizen-a',
      withdrawnAt: '2026-11-19T10:05:00.000Z',
      timeline: archiveDb.civic_reports['rep-a-in-progress'].timeline,
      updatedAt: '2026-11-19T10:05:00.000Z',
    }),
    false,
    'Citizen withdrawal permissions are not broadened to In Progress complaints'
  );

  // 12i. Existing authorized admin status updates and reopening continue working
  assert.strictEqual(
    canUpdateReportProposed(staffAdminWithStaleSuperClaim, archiveDb, targetActive, {
      ...targetActive,
      status: 'In Progress',
      assignedOfficer: 'K. Rao',
      updatedBy: staffAdminWithStaleSuperClaim.uid,
      updatedAt: '2026-11-19T10:10:00.000Z',
    }),
    true,
    'Active staff admin can still perform standard workflow status updates'
  );
  assert.strictEqual(
    canUpdateReportProposed(wardAdminWithStaleSuperClaim, archiveDb, targetWithdrawn, {
      ...targetWithdrawn,
      status: 'Under Review',
      adminRemarks: 'Reopened for verification after site inspection.',
      updatedBy: wardAdminWithStaleSuperClaim.uid,
      updatedAt: '2026-11-19T10:10:00.000Z',
      timeline: [
        ...(targetWithdrawn.timeline as any[]),
        { status: 'Under Review', timestamp: '2026-11-19T10:10:00.000Z', note: 'Reopened' },
      ],
    }),
    true,
    'Active authorized admin can still reopen a Withdrawn complaint back to Under Review'
  );
  assert.strictEqual(
    canUpdateReportProposed(activeAdmin, archiveDb, targetActive, {
      ...targetActive,
      status: 'Withdrawn',
      updatedBy: activeAdmin.uid,
      updatedAt: '2026-11-19T10:10:00.000Z',
    }),
    false,
    'Admins still cannot transition active complaints into citizen-only Withdrawn status'
  );

  // 12j. Archived parent complaint blocks citizen follow-up notes, withdrawal, and statusHistory creation
  {
    const archivedCitizenReport = buildArchivePayload(targetEligible, activeAdmin.uid);
    const explicitlyNonArchivedCitizenReport: Record<string, any> = {
      ...targetEligible,
      id: 'rep-a-explicit-false',
      archived: false,
    };
    const dbWithArchivedCitizenReport: MockDbState = {
      ...archiveDb,
      civic_reports: {
        ...archiveDb.civic_reports,
        [targetEligible.id as string]: archivedCitizenReport,
        'rep-a-explicit-false': explicitlyNonArchivedCitizenReport,
      },
    };

    // Denied on archived complaint: 1) follow-up note
    assert.strictEqual(
      canUpdateReportProposed(citizenA, dbWithArchivedCitizenReport, archivedCitizenReport, {
        ...archivedCitizenReport,
        citizenNotes: ['Attempting follow-up on archived complaint'],
        updatedAt: '2026-11-19T12:00:00.000Z',
      }),
      false,
      'Citizen follow-up note must be denied when parent complaint has archived == true'
    );

    // Denied on archived complaint: 2) withdrawal
    assert.strictEqual(
      canUpdateReportProposed(citizenA, dbWithArchivedCitizenReport, archivedCitizenReport, {
        ...archivedCitizenReport,
        status: 'Withdrawn',
        withdrawnBy: 'citizen-a',
        withdrawnAt: '2026-11-19T12:00:00.000Z',
        withdrawalReason: 'Attempting withdrawal on archived complaint',
        timeline: [
          ...(archivedCitizenReport.timeline as any[]),
          { status: 'Withdrawn', timestamp: '2026-11-19T12:00:00.000Z', note: 'Withdrawn' },
        ],
        updatedAt: '2026-11-19T12:00:00.000Z',
      }),
      false,
      'Citizen withdrawal must be denied when parent complaint has archived == true'
    );

    // Denied on archived complaint: 3) statusHistory creation (both Submitted and Withdrawn)
    assert.strictEqual(
      canCreateStatusHistory(citizenA, dbWithArchivedCitizenReport, targetEligible.id as string, {
        reportId: targetEligible.id,
        fromStatus: null,
        toStatus: 'Submitted',
        changedByUid: 'citizen-a',
        changedByRole: 'citizen',
        timestamp: '2026-11-19T12:00:00.000Z',
      }),
      false,
      'Citizen Submitted statusHistory creation must be denied when parent complaint has archived == true'
    );
    assert.strictEqual(
      canCreateStatusHistory(citizenA, dbWithArchivedCitizenReport, targetEligible.id as string, {
        reportId: targetEligible.id,
        fromStatus: 'Submitted',
        toStatus: 'Withdrawn',
        changedByUid: 'citizen-a',
        changedByRole: 'citizen',
        timestamp: '2026-11-19T12:00:00.000Z',
      }),
      false,
      'Citizen Withdrawn statusHistory creation must be denied when parent complaint has archived == true'
    );

    // Preserved on non-archived complaints (both legacy missing archived field and explicit archived: false)
    assert.strictEqual(
      canUpdateReportProposed(citizenA, dbWithArchivedCitizenReport, explicitlyNonArchivedCitizenReport, {
        ...explicitlyNonArchivedCitizenReport,
        citizenNotes: ['Valid follow-up note on non-archived complaint'],
        updatedAt: '2026-11-19T12:05:00.000Z',
      }),
      true,
      'Citizen follow-up note remains allowed when archived == false'
    );
    assert.strictEqual(
      canUpdateReportProposed(citizenA, dbWithArchivedCitizenReport, explicitlyNonArchivedCitizenReport, {
        ...explicitlyNonArchivedCitizenReport,
        status: 'Withdrawn',
        withdrawnBy: 'citizen-a',
        withdrawnAt: '2026-11-19T12:05:00.000Z',
        withdrawalReason: 'Valid withdrawal on non-archived complaint',
        timeline: [
          ...(explicitlyNonArchivedCitizenReport.timeline as any[]),
          { status: 'Withdrawn', timestamp: '2026-11-19T12:05:00.000Z', note: 'Withdrawn' },
        ],
        updatedAt: '2026-11-19T12:05:00.000Z',
      }),
      true,
      'Citizen withdrawal remains allowed when archived == false'
    );
    assert.strictEqual(
      canCreateStatusHistory(citizenA, archiveDb, targetEligible.id as string, {
        reportId: targetEligible.id,
        fromStatus: null,
        toStatus: 'Submitted',
        changedByUid: 'citizen-a',
        changedByRole: 'citizen',
        timestamp: '2026-11-19T12:05:00.000Z',
      }),
      true,
      'Citizen Submitted statusHistory creation remains allowed for non-archived report (no archived field)'
    );
    assert.strictEqual(
      canCreateStatusHistory(citizenA, dbWithArchivedCitizenReport, 'rep-a-explicit-false', {
        reportId: 'rep-a-explicit-false',
        fromStatus: 'Submitted',
        toStatus: 'Withdrawn',
        changedByUid: 'citizen-a',
        changedByRole: 'citizen',
        timestamp: '2026-11-19T12:05:00.000Z',
      }),
      true,
      'Citizen Withdrawn statusHistory creation remains allowed when archived == false'
    );
    assert.strictEqual(
      canCreateStatusHistory(wardAdminWithStaleSuperClaim, archiveDb, targetWithdrawn.id as string, {
        reportId: targetWithdrawn.id,
        fromStatus: 'Withdrawn',
        toStatus: 'Under Review',
        changedByUid: wardAdminWithStaleSuperClaim.uid,
        changedByRole: 'admin',
        timestamp: '2026-11-19T12:05:00.000Z',
      }),
      true,
      'Administrator reopen statusHistory creation remains allowed on non-archived Withdrawn complaints'
    );
    // Denied on archived complaint: 4) citizen auditLogs creation (report_created & report_withdrawn)
    assert.strictEqual(
      canCreateAuditLog(citizenA, dbWithArchivedCitizenReport, {
        action: 'report_withdrawn',
        targetType: 'civic_report',
        targetId: targetEligible.id,
        actorUid: 'citizen-a',
        actorRole: 'citizen',
        summary: 'Forged withdrawal log on archived complaint.',
        timestamp: '2026-11-19T12:00:00.000Z',
      }),
      false,
      'Citizen report_withdrawn audit log must be denied when parent complaint has archived == true'
    );
    assert.strictEqual(
      canCreateAuditLog(citizenA, dbWithArchivedCitizenReport, {
        action: 'report_created',
        targetType: 'civic_report',
        targetId: targetEligible.id,
        actorUid: 'citizen-a',
        actorRole: 'citizen',
        summary: 'Forged creation log on archived complaint.',
        timestamp: '2026-11-19T12:00:00.000Z',
      }),
      false,
      'Citizen report_created audit log must be denied when parent complaint has archived == true'
    );
    assert.strictEqual(
      canCreateAuditLog(citizenA, dbWithArchivedCitizenReport, {
        action: 'report_withdrawn',
        targetType: 'civic_report',
        targetId: '../admins/admin-active',
        actorUid: 'citizen-a',
        actorRole: 'citizen',
        summary: 'Path traversal attempt in citizen audit log.',
        timestamp: '2026-11-19T12:00:00.000Z',
      }),
      false,
      'Citizen audit log must reject path traversal characters in targetId'
    );
    assert.strictEqual(
      canCreateAuditLog(citizenA, dbWithArchivedCitizenReport, {
        action: 'report_withdrawn',
        targetType: 'civic_report',
        targetId: 'rep-a-explicit-false',
        actorUid: 'citizen-a',
        actorRole: 'citizen',
        summary: 'Valid citizen withdrawal audit log on non-archived complaint.',
        timestamp: '2026-11-19T12:05:00.000Z',
      }),
      true,
      'Citizen audit log creation remains allowed when archived == false'
    );

    // Evaluator-vs-rules consistency regressions:
    // 1) SERVER_REQUEST_TIME symbol sneaked into citizen or admin workflow update MUST be caught by getAffectedKeys
    assert.strictEqual(
      canUpdateReport(citizenA, archiveDb, targetEligible, {
        ...targetEligible,
        citizenNotes: ['Note with sneaked archivedAt'],
        archivedAt: SERVER_REQUEST_TIME,
        updatedAt: '2026-11-19T12:05:00.000Z',
      }),
      false,
      'Sneaking archivedAt (server timestamp) into a citizen note update must be rejected'
    );
    assert.strictEqual(
      canUpdateReport(activeAdmin, archiveDb, targetActive, {
        ...targetActive,
        status: 'In Progress',
        archivedAt: SERVER_REQUEST_TIME,
        updatedAt: '2026-11-19T12:05:00.000Z',
      }),
      false,
      'Sneaking archivedAt (server timestamp) into an admin workflow update must be rejected'
    );
    // 2) Existing non-array citizenNotes field fails resource.data.citizenNotes is list in firestore.rules
    const malformedNotesReport = {
      ...targetEligible,
      citizenNotes: null,
    };
    assert.strictEqual(
      canUpdateReport(citizenA, archiveDb, malformedNotesReport, {
        ...malformedNotesReport,
        citizenNotes: ['First note'],
        updatedAt: '2026-11-19T12:05:00.000Z',
      }),
      false,
      'Existing non-list citizenNotes must be denied on Citizen branch 1 (matches firestore.rules)'
    );
    // 3) Admin who owns a non-archived report can still take citizen branch (matches firestore.rules OR disjunction)
    const adminOwnedReport = {
      ...targetEligible,
      id: 'rep-admin-owned',
      userId: activeAdmin.uid,
    };
    assert.strictEqual(
      canUpdateReport(activeAdmin, archiveDb, adminOwnedReport, {
        ...adminOwnedReport,
        citizenNotes: ['Owner follow-up by admin'],
        updatedAt: '2026-11-19T12:05:00.000Z',
      }),
      true,
      'Admin who owns their own non-archived report can still append a citizen note via Citizen branch 1'
    );
    // 4) /civic_reports allow delete strictly requires canManageAdmins() (active superadmin only)
    assert.strictEqual(canDeleteReport(activeAdmin, archiveDb), true);
    assert.strictEqual(canDeleteReport(claimOnlySuperAdmin, archiveDb), true);
    assert.strictEqual(canDeleteReport(deptHeadAdmin, archiveDb), false);
    assert.strictEqual(canDeleteReport(wardAdminWithStaleSuperClaim, archiveDb), false);
    assert.strictEqual(canDeleteReport(staffAdminWithStaleSuperClaim, archiveDb), false);
    assert.strictEqual(canDeleteReport(missingRoleAdminWithClaim, archiveDb), false);
    assert.strictEqual(canDeleteReport(claimOnlyAdmin, archiveDb), false);
    assert.strictEqual(canDeleteReport(claimOnlyDeactivatedAdmin, archiveDb), false);
    assert.strictEqual(canDeleteReport(deactivatedAdminWithStaleClaim, archiveDb), false);
    assert.strictEqual(canDeleteReport(citizenA, archiveDb), false);
  }

  console.log(
    '  ✓ 12. Applied archive rules verified statically & locally (firestore.rules clauses, archived citizen-write/audit lockouts, explicit claim roles, getAfter() audit integrity, strict request.time archivedAt, active flag, Withdrawn preservation, superadmin-only delete, and evaluator parity)'
  );
}

// =========================================================================
// 13. ADMIN PRIVILEGE ESCALATION HARDENING (canManageAdmins & /admins/{adminId})
//     Static firestore.rules assertions + local evaluator regression tests.
//     Does NOT represent Firebase Emulator or live Firebase project verification.
// =========================================================================
{
  const APPROVED_ADMIN_FIELDS = new Set([
    'uid',
    'email',
    'displayName',
    'role',
    'department',
    'ward',
    'active',
    'createdAt',
    'updatedAt',
  ]);
  const VALID_ADMIN_ROLES_SET = new Set(['superadmin', 'ward_admin', 'department_head', 'staff']);

  // Verify alignment with ADMIN_ROLE_CAPABILITIES.canManageAdmins
  assert.strictEqual(ADMIN_ROLE_CAPABILITIES.superadmin.canManageAdmins, true);
  assert.strictEqual(ADMIN_ROLE_CAPABILITIES.department_head.canManageAdmins, false);
  assert.strictEqual(ADMIN_ROLE_CAPABILITIES.ward_admin.canManageAdmins, false);
  assert.strictEqual(ADMIN_ROLE_CAPABILITIES.staff.canManageAdmins, false);

  // 13.0 Static rule-file checks directly against firestore.rules
  {
    const canManageMatch = firestoreRules.match(/function canManageAdmins\(\)\s*\{[\s\S]*?\n\s{4}\}/);
    assert(canManageMatch, 'firestore.rules defines canManageAdmins()');
    const canManageBody = canManageMatch![0];
    assert(canManageBody.includes('return isAdmin() &&'), 'canManageAdmins() requires isAdmin()');
    const docCheckIdx = canManageBody.indexOf(
      'exists(/databases/$(database)/documents/admins/$(request.auth.uid))'
    );
    const claimCheckIdx = canManageBody.indexOf("'admin' in request.auth.token");
    assert(
      docCheckIdx !== -1 && claimCheckIdx !== -1 && docCheckIdx < claimCheckIdx,
      'canManageAdmins() evaluates /admins/{uid} before custom-claim fallback'
    );
    assert(
      canManageBody.includes(
        'get(/databases/$(database)/documents/admins/$(request.auth.uid)).data.active == true'
      ) &&
        canManageBody.includes(
          "get(/databases/$(database)/documents/admins/$(request.auth.uid)).data.role == 'superadmin'"
        ),
      'canManageAdmins() requires active == true and role == superadmin when /admins/{uid} exists'
    );
    assert(
      canManageBody.includes('request.auth.token.admin == true') &&
        canManageBody.includes("(!('active' in request.auth.token) || request.auth.token.active == true)") &&
        canManageBody.includes("'role' in request.auth.token") &&
        canManageBody.includes("request.auth.token.role == 'superadmin'"),
      'canManageAdmins() requires verified admin == true, active == true (or absent), and role == superadmin for claim fallback'
    );
    assert(
      !canManageBody.includes('request.auth.token.email'),
      'canManageAdmins() must never authorize using email alone'
    );

    const validateFnMatch = firestoreRules.match(/function isValidAdminDocWrite\(adminId\)\s*\{[\s\S]*?\n\s{4}\}/);
    assert(validateFnMatch, 'firestore.rules defines isValidAdminDocWrite(adminId)');
    const validateBody = validateFnMatch![0];
    assert(
      validateBody.includes('d.keys().hasOnly([') &&
        validateBody.includes("'uid' in d") &&
        validateBody.includes('d.uid == adminId') &&
        validateBody.includes("'email' in d") &&
        validateBody.includes("'role' in d") &&
        validateBody.includes("d.role in ['superadmin', 'ward_admin', 'department_head', 'staff']") &&
        validateBody.includes("(!('active' in d) || d.active is bool)") &&
        validateBody.includes("(!('displayName' in d) || (d.displayName is string && d.displayName.size() <= 150))") &&
        validateBody.includes("(!('department' in d) || (d.department is string && d.department.size() <= 120))") &&
        validateBody.includes("(!('ward' in d) || (d.ward is string && d.ward.size() <= 60))") &&
        validateBody.includes("(!('createdAt' in d) || d.createdAt is timestamp || (d.createdAt is string && d.createdAt.size() >= 10 && d.createdAt.size() <= 40))") &&
        validateBody.includes("(!('updatedAt' in d) || d.updatedAt is timestamp || (d.updatedAt is string && d.updatedAt.size() >= 10 && d.updatedAt.size() <= 40))"),
      'isValidAdminDocWrite(adminId) validates approved fields, uid == adminId, valid roles, boolean active flag, and optional field types/lengths'
    );

    const adminsSection = firestoreRules.match(/match \/admins\/\{adminId\}[\s\S]*?\n\s{4}\}/)?.[0] || '';
    const updateBlock = adminsSection.match(/allow update:[\s\S]*?allow delete:/)?.[0] || '';
    const deleteBlock = adminsSection.match(/allow delete:[\s\S]*?\}/)?.[0] || '';
    assert(adminsSection.includes('allow read: if isAdmin();'), '/admins preserves active-admin read permission');
    assert(
      adminsSection.includes('allow create: if canManageAdmins()') &&
        adminsSection.includes('isValidAdminDocWrite(adminId)'),
      '/admins create requires canManageAdmins() and isValidAdminDocWrite(adminId)'
    );
    assert(
      updateBlock.includes('canManageAdmins()') &&
        updateBlock.includes('request.auth.uid != adminId') &&
        updateBlock.includes("(!('uid' in resource.data) || request.resource.data.uid == resource.data.uid)") &&
        updateBlock.includes('isValidAdminDocWrite(adminId)'),
      '/admins update requires canManageAdmins(), blocks self-modification, and prevents changing existing uid'
    );
    assert(
      deleteBlock.includes('canManageAdmins()') && deleteBlock.includes('request.auth.uid != adminId'),
      '/admins delete requires canManageAdmins() and blocks self-deletion'
    );
  }

  // Local evaluator mirroring canManageAdmins() and /admins/{adminId} rules
  const canManageAdminsEval = canManageAdmins;

  function isValidTimestampOrIsoField(val: unknown): boolean {
    if (val === SERVER_REQUEST_TIME || val instanceof Date) return true;
    return typeof val === 'string' && val.length >= 10 && val.length <= 40;
  }

  function isValidAdminDocWriteEval(adminId: string, data: Record<string, any>): boolean {
    if (!Object.keys(data).every((k) => APPROVED_ADMIN_FIELDS.has(k))) return false;
    if (!('uid' in data) || typeof data.uid !== 'string' || data.uid !== adminId) return false;
    if (!('email' in data) || typeof data.email !== 'string' || data.email.length < 3 || data.email.length > 254)
      return false;
    if (!('role' in data) || typeof data.role !== 'string' || !VALID_ADMIN_ROLES_SET.has(data.role)) return false;
    if ('active' in data && typeof data.active !== 'boolean') return false;
    if ('displayName' in data && (typeof data.displayName !== 'string' || data.displayName.length > 150)) return false;
    if ('department' in data && (typeof data.department !== 'string' || data.department.length > 120)) return false;
    if ('ward' in data && (typeof data.ward !== 'string' || data.ward.length > 60)) return false;
    if ('createdAt' in data && !isValidTimestampOrIsoField(data.createdAt)) return false;
    if ('updatedAt' in data && !isValidTimestampOrIsoField(data.updatedAt)) return false;
    return true;
  }

  function canCreateAdminDoc(
    auth: MockAuthContext | null,
    db: MockDbState,
    adminId: string,
    data: Record<string, any>
  ): boolean {
    return canManageAdminsEval(auth, db) && isValidAdminDocWriteEval(adminId, data);
  }

  function canUpdateAdminDoc(
    auth: MockAuthContext | null,
    db: MockDbState,
    adminId: string,
    before: Record<string, any>,
    after: Record<string, any>
  ): boolean {
    if (!canManageAdminsEval(auth, db) || !auth) return false;
    if (auth.uid === adminId) return false;
    if ('uid' in before && after.uid !== before.uid) return false;
    const affected = getAffectedKeys(before, after);
    if (!affected.every((k) => APPROVED_ADMIN_FIELDS.has(k))) return false;
    return isValidAdminDocWriteEval(adminId, after);
  }

  function canDeleteAdminDoc(
    auth: MockAuthContext | null,
    db: MockDbState,
    adminId: string
  ): boolean {
    if (!canManageAdminsEval(auth, db) || !auth) return false;
    return auth.uid !== adminId;
  }

  const adminMgmtDb: MockDbState = {
    admins: {
      'super-active': {
        uid: 'super-active',
        email: 'super@civifix.gov',
        displayName: 'Primary Superadmin',
        role: 'superadmin',
        active: true,
      },
      'super-deactivated': {
        uid: 'super-deactivated',
        email: 'oldsuper@civifix.gov',
        role: 'superadmin',
        active: false,
      },
      'super-missing-active': {
        uid: 'super-missing-active',
        email: 'incomplete@civifix.gov',
        role: 'superadmin',
      },
      'dept-head-1': {
        uid: 'dept-head-1',
        email: 'dept@civifix.gov',
        role: 'department_head',
        active: true,
      },
      'ward-admin-1': {
        uid: 'ward-admin-1',
        email: 'ward@civifix.gov',
        role: 'ward_admin',
        active: true,
      },
      'staff-1': {
        uid: 'staff-1',
        email: 'staff@civifix.gov',
        role: 'staff',
        active: true,
      },
    },
    civic_reports: sampleDb.civic_reports,
  };

  const activeSuperAuth: MockAuthContext = { uid: 'super-active', token: {} };
  const deactivatedSuperWithStaleClaim: MockAuthContext = {
    uid: 'super-deactivated',
    token: { admin: true, active: true, role: 'superadmin' },
  };
  const missingActiveSuperWithStaleClaim: MockAuthContext = {
    uid: 'super-missing-active',
    token: { admin: true, active: true, role: 'superadmin' },
  };
  const deptHeadAuth: MockAuthContext = {
    uid: 'dept-head-1',
    token: { admin: true, role: 'superadmin' },
  };
  const wardAdminAuth: MockAuthContext = {
    uid: 'ward-admin-1',
    token: { admin: true, role: 'superadmin' },
  };
  const staffAuth: MockAuthContext = {
    uid: 'staff-1',
    token: { admin: true, role: 'superadmin' },
  };
  const claimOnlySuperNoActiveField: MockAuthContext = {
    uid: 'claim-super-1',
    token: { admin: true, role: 'superadmin' },
  };
  const claimOnlySuperActiveTrue: MockAuthContext = {
    uid: 'claim-super-2',
    token: { admin: true, active: true, role: 'superadmin' },
  };
  const claimOnlySuperActiveFalse: MockAuthContext = {
    uid: 'claim-super-3',
    token: { admin: true, active: false, role: 'superadmin' },
  };
  const claimOnlyBareAdmin: MockAuthContext = {
    uid: 'claim-bare-1',
    token: { admin: true },
  };
  const claimOnlyDeptHead: MockAuthContext = {
    uid: 'claim-dept-1',
    token: { admin: true, role: 'department_head' },
  };
  const emailOnlyCitizen: MockAuthContext = {
    uid: 'citizen-email-only',
    token: { email: 'super@civifix.gov', email_verified: true, role: 'superadmin' },
  };

  const validNewAdminDoc = {
    uid: 'new-ward-admin',
    email: 'new.ward@civifix.gov',
    displayName: 'New Ward Admin',
    role: 'ward_admin',
    department: 'Roads & Infrastructure Maintenance',
    ward: 'Ward 9',
    active: true,
    createdAt: '2026-11-20T08:00:00.000Z',
    updatedAt: '2026-11-20T08:00:00.000Z',
  };
  const existingStaffDoc = adminMgmtDb.admins['staff-1'];
  const promotedStaffDoc = {
    ...existingStaffDoc,
    role: 'ward_admin',
    updatedAt: '2026-11-20T08:10:00.000Z',
  };

  // 13a. Citizens (and email-only / unverified role claims) cannot create, update, or delete admin records
  for (const actor of [citizenA, emailOnlyCitizen, null]) {
    assert.strictEqual(canCreateAdminDoc(actor, adminMgmtDb, 'new-ward-admin', validNewAdminDoc), false);
    assert.strictEqual(canUpdateAdminDoc(actor, adminMgmtDb, 'staff-1', existingStaffDoc, promotedStaffDoc), false);
    assert.strictEqual(canDeleteAdminDoc(actor, adminMgmtDb, 'staff-1'), false);
  }

  // 13b. Staff and ward admins cannot create, update, or delete admin records (even with stale superadmin claim)
  for (const actor of [staffAuth, wardAdminAuth]) {
    assert.strictEqual(isAdmin(actor, adminMgmtDb), true, 'Active staff/ward_admin retain existing isAdmin() read access');
    assert.strictEqual(canCreateAdminDoc(actor, adminMgmtDb, 'new-ward-admin', validNewAdminDoc), false);
    assert.strictEqual(canUpdateAdminDoc(actor, adminMgmtDb, 'staff-1', existingStaffDoc, promotedStaffDoc), false);
    assert.strictEqual(
      canUpdateAdminDoc(actor, adminMgmtDb, 'dept-head-1', adminMgmtDb.admins['dept-head-1'], {
        ...adminMgmtDb.admins['dept-head-1'],
        role: 'superadmin',
      }),
      false
    );
    assert.strictEqual(canDeleteAdminDoc(actor, adminMgmtDb, 'dept-head-1'), false);
  }

  // 13c. Department heads cannot create, update, or delete admin records (even with stale superadmin claim or claim-only dept head)
  for (const actor of [deptHeadAuth, claimOnlyDeptHead]) {
    assert.strictEqual(isAdmin(actor, adminMgmtDb), true, 'Active department_head retains existing isAdmin() read access');
    assert.strictEqual(canCreateAdminDoc(actor, adminMgmtDb, 'new-ward-admin', validNewAdminDoc), false);
    assert.strictEqual(canUpdateAdminDoc(actor, adminMgmtDb, 'staff-1', existingStaffDoc, promotedStaffDoc), false);
    assert.strictEqual(canDeleteAdminDoc(actor, adminMgmtDb, 'staff-1'), false);
  }

  // 13d. Active superadmins (doc-backed and valid claim-only fallback) can manage OTHER admin records
  for (const superActor of [activeSuperAuth, claimOnlySuperNoActiveField, claimOnlySuperActiveTrue]) {
    assert.strictEqual(canCreateAdminDoc(superActor, adminMgmtDb, 'new-ward-admin', validNewAdminDoc), true);
    assert.strictEqual(canUpdateAdminDoc(superActor, adminMgmtDb, 'staff-1', existingStaffDoc, promotedStaffDoc), true);
    assert.strictEqual(canDeleteAdminDoc(superActor, adminMgmtDb, 'staff-1'), true);
  }

  // Claim-only fallback without explicit role == superadmin or with active == false is denied
  assert.strictEqual(canCreateAdminDoc(claimOnlyBareAdmin, adminMgmtDb, 'new-ward-admin', validNewAdminDoc), false);
  assert.strictEqual(canUpdateAdminDoc(claimOnlyBareAdmin, adminMgmtDb, 'staff-1', existingStaffDoc, promotedStaffDoc), false);
  assert.strictEqual(canDeleteAdminDoc(claimOnlyBareAdmin, adminMgmtDb, 'staff-1'), false);
  assert.strictEqual(canCreateAdminDoc(claimOnlySuperActiveFalse, adminMgmtDb, 'new-ward-admin', validNewAdminDoc), false);
  assert.strictEqual(canDeleteAdminDoc(claimOnlySuperActiveFalse, adminMgmtDb, 'staff-1'), false);

  // 13e. Deactivated (and missing active == true) superadmins cannot manage admin records even with stale claims
  for (const inactiveSuper of [deactivatedSuperWithStaleClaim, missingActiveSuperWithStaleClaim]) {
    assert.strictEqual(canCreateAdminDoc(inactiveSuper, adminMgmtDb, 'new-ward-admin', validNewAdminDoc), false);
    assert.strictEqual(canUpdateAdminDoc(inactiveSuper, adminMgmtDb, 'staff-1', existingStaffDoc, promotedStaffDoc), false);
    assert.strictEqual(canDeleteAdminDoc(inactiveSuper, adminMgmtDb, 'staff-1'), false);
  }

  // 13f. Admins (including active superadmins) cannot modify or delete their own admin document
  assert.strictEqual(
    canUpdateAdminDoc(activeSuperAuth, adminMgmtDb, 'super-active', adminMgmtDb.admins['super-active'], {
      ...adminMgmtDb.admins['super-active'],
      displayName: 'Self Modified',
    }),
    false,
    'Superadmin cannot update their own /admins/{uid} document'
  );
  assert.strictEqual(
    canDeleteAdminDoc(activeSuperAuth, adminMgmtDb, 'super-active'),
    false,
    'Superadmin cannot delete their own /admins/{uid} document'
  );

  // 13g. Document validation: approved fields, uid == adminId, uid immutability, valid roles, boolean active
  assert.strictEqual(
    canCreateAdminDoc(activeSuperAuth, adminMgmtDb, 'new-ward-admin', {
      ...validNewAdminDoc,
      uid: 'mismatched-uid',
    }),
    false,
    'uid must match adminId on create'
  );
  assert.strictEqual(
    canUpdateAdminDoc(activeSuperAuth, adminMgmtDb, 'staff-1', existingStaffDoc, {
      ...promotedStaffDoc,
      uid: 'hijacked-uid',
    }),
    false,
    'Cannot change uid of an existing admin document'
  );
  assert.strictEqual(
    canCreateAdminDoc(activeSuperAuth, adminMgmtDb, 'new-ward-admin', {
      ...validNewAdminDoc,
      role: 'root_god_mode',
    }),
    false,
    'Invalid admin role is rejected'
  );
  assert.strictEqual(
    canCreateAdminDoc(activeSuperAuth, adminMgmtDb, 'new-ward-admin', {
      ...validNewAdminDoc,
      active: 'true',
    }),
    false,
    'Non-boolean active field is rejected'
  );
  assert.strictEqual(
    canCreateAdminDoc(activeSuperAuth, adminMgmtDb, 'new-ward-admin', {
      ...validNewAdminDoc,
      extraPrivilege: true,
    }),
    false,
    'Unapproved fields on /admins/{adminId} are rejected'
  );
  assert.strictEqual(
    canCreateAdminDoc(activeSuperAuth, adminMgmtDb, 'new-ward-admin', {
      ...validNewAdminDoc,
      displayName: 'x'.repeat(151),
    }),
    false,
    'Overlong displayName on /admins/{adminId} is rejected'
  );
  assert.strictEqual(
    canCreateAdminDoc(activeSuperAuth, adminMgmtDb, 'new-ward-admin', {
      ...validNewAdminDoc,
      department: 12345,
    }),
    false,
    'Non-string department on /admins/{adminId} is rejected'
  );
  assert.strictEqual(
    canCreateAdminDoc(activeSuperAuth, adminMgmtDb, 'new-ward-admin', {
      ...validNewAdminDoc,
      ward: 'w'.repeat(61),
    }),
    false,
    'Overlong ward on /admins/{adminId} is rejected'
  );
  assert.strictEqual(
    canCreateAdminDoc(activeSuperAuth, adminMgmtDb, 'new-ward-admin', {
      ...validNewAdminDoc,
      createdAt: 'bad',
    }),
    false,
    'Invalid createdAt string on /admins/{adminId} is rejected'
  );
  assert.strictEqual(
    canCreateAdminDoc(activeSuperAuth, adminMgmtDb, 'new-ward-admin', {
      ...validNewAdminDoc,
      createdAt: SERVER_REQUEST_TIME,
      updatedAt: SERVER_REQUEST_TIME,
    }),
    true,
    'Firestore Timestamp values for createdAt/updatedAt on /admins/{adminId} are accepted'
  );

  console.log(
    '  ✓ 13. Admin privilege-escalation rules verified statically & locally (canManageAdmins(), superadmin-only CRUD, self-update/delete lockouts, UID immutability, field validation, and deactivated superadmin denial)'
  );
}

console.log('--- ALL 13+ FIREBASE SECURITY RULES TEST SCENARIOS PASSED ---');
