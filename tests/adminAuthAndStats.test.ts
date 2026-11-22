import fs from 'node:fs';
import path from 'node:path';
import {
  browserLocalPersistence,
  browserSessionPersistence,
} from 'firebase/auth';
import {
  calculateAdminStats,
  extractCitizenSummaries,
  verifyAdminPrivileges,
  signInAdminWithCredentials,
  sendAdminPasswordReset,
  signOutAdmin,
  updateReportStatusByAdmin,
  mapFirestoreDocToReport,
  mergeAndDeduplicateReports,
  fetchAllReportsForAdmin,
  fetchAdminReportsPage,
  fetchRecentAuditLogs,
  VALID_STATUS_TRANSITIONS,
  isValidStatusTransition,
} from '../src/services/adminService';
import {
  resolveAppRouteFromLocation,
  evaluateAdminRouteAccess,
  getPathForRoute,
} from '../src/utils/portalRouting';
import { verifyAdminFromDecodedToken } from '../src/server/firebaseAuthMiddleware';
import {
  provisionDedicatedAdmin,
  resolveProvisioningConfig,
} from '../scripts/grant-admin-claim.mjs';
import {
  CivicIssueReport,
  ReportStatus,
  VALID_REPORT_STATUSES,
  normalizeReportStatus,
  EXPANDED_CIVIC_CATEGORIES,
  LEGACY_CIVIC_CATEGORIES,
  normalizeCivicCategory,
  CANONICAL_MUNICIPAL_DEPARTMENTS,
  getDepartmentForCategory,
  resolveReportDepartment,
  buildDepartmentSelectOptions,
  resolveDepartmentUpdateArg,
  resolveDuplicateOfUpdateArg,
  resolveOptionalStringUpdateArg,
  resolveCitizenReportVisibility,
  VALID_ADMIN_ROLES,
  normalizeAdminRole,
  ADMIN_ROLE_CAPABILITIES,
  getSeverityPriorityScore,
  derivePriorityTier,
  parseSlaHours,
} from '../src/types/civic';
import { MAX_FIRESTORE_DOC_BYTES, syncSelectedReport } from '../src/services/reportStorage';
import {
  reconcileAdminModalFormState,
  hasAdminModalFormChanges,
} from '../src/services/adminService';
import { getStatusThemeClasses } from '../src/components/CivicStatusBadge';

let totalTests = 0;
let passedTests = 0;

function assert(condition: boolean, testName: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✓ ${testName}`);
  } else {
    console.error(`  ✗ FAIL: ${testName}`);
    process.exitCode = 1;
  }
}

console.log('\n--- RUNNING CIVIFIX AI ADMIN AUTHORIZATION & STATS TEST SUITE ---');

// 1 & 2. Zero-Trust verifyAdminPrivileges Security Tests
async function testAdminVerificationSecurity() {
  // A. Null or unauthenticated user
  const nullResult = await verifyAdminPrivileges(null);
  assert(
    nullResult.authorized === false && nullResult.admin === null,
    'Unauthenticated null user is strictly denied access'
  );

  // B. Ordinary Citizen user with private Gmail (no custom claims or /admins/{uid})
  const mockCitizenUser: any = {
    uid: 'citizen-uid-12345',
    email: 'citizen_user@gmail.com',
    displayName: 'Public Citizen',
    metadata: { creationTime: '2026-01-01T00:00:00Z' },
  };
  const citizenResult = await verifyAdminPrivileges(mockCitizenUser);
  assert(
    citizenResult.authorized === false && citizenResult.admin === null,
    'Ordinary citizen account is strictly denied administrative clearance'
  );

  // C. Zero-Trust guarantee: email address alone (even @civifix.gov) WITHOUT claim or /admins/{uid} is denied
  const mockUnprivilegedGovEmail: any = {
    uid: 'unprivileged-uid-789',
    email: 'admin@civifix.gov',
    displayName: 'Unverified Email Only',
    metadata: { creationTime: '2026-01-01T00:00:00Z' },
    getIdTokenResult: async () => ({ token: 'mock-citizen-jwt', claims: {} }),
  };
  const emailOnlyResult = await verifyAdminPrivileges(mockUnprivilegedGovEmail);
  assert(
    emailOnlyResult.authorized === false && emailOnlyResult.admin === null,
    'Email-only account without Firebase admin claim or /admins/{uid} doc is denied under zero-trust'
  );

  const serverOnlyEmailResult = await verifyAdminPrivileges(
    {
      uid: 'server-only-admin-uid',
      email: 'admin@civifix.gov',
      displayName: 'Server Allowlist Only',
      getIdTokenResult: async () => ({ token: 'server-only-jwt', claims: {} }),
    } as any,
    {
      getAdminDocFn: async () => ({ exists: false, data: undefined }),
      fetchFn: async () =>
        new Response(JSON.stringify({ authorized: true, role: 'superadmin' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    }
  );
  assert(
    serverOnlyEmailResult.authorized === false &&
      /provisioned for Firestore/i.test(serverOnlyEmailResult.error || ''),
    'Server-only email authorization is denied when the browser lacks Firestore admin provisioning'
  );

  // D. Verified Municipal Admin with cryptographic custom claim admin === true
  const mockClaimAdmin: any = {
    uid: 'admin-uid-999',
    email: 'chief.officer@municipality.org',
    displayName: 'Municipal Chief Officer',
    metadata: { creationTime: '2026-01-01T00:00:00Z' },
    getIdTokenResult: async () => ({
      token: 'mock-admin-jwt',
      claims: { admin: true, role: 'superadmin' },
    }),
  };
  const claimResult = await verifyAdminPrivileges(mockClaimAdmin);
  assert(
    claimResult.authorized === true && claimResult.admin?.role === 'superadmin',
    'User with cryptographic Firebase custom claim (admin: true, role: superadmin) is granted clearance'
  );
}

// 3. calculateAdminStats Exact Aggregation Tests (Zero Dummy Data)
function testStatsCalculation() {
  // Empty dataset test
  const emptyStats = calculateAdminStats([]);
  assert(
    emptyStats.totalReports === 0 &&
      emptyStats.pendingReports === 0 &&
      emptyStats.resolvedReports === 0 &&
      emptyStats.rejectedReports === 0 &&
      emptyStats.avgResolutionHours === null,
    'calculateAdminStats returns honest zeroes and null avgResolutionHours when reports collection is empty'
  );

  // Populated dataset test
  const sampleReports: CivicIssueReport[] = [
    {
      id: 'rep-1',
      trackingNumber: 'CFX-2026-0001',
      category: 'Garbage',
      title: 'Overflowing bin',
      description: 'Garbage spilling onto sidewalk',
      photoUrl: 'data:image/jpeg;base64,abc',
      location: { address: 'Main Street', latitude: 12.9, longitude: 77.5, ward: 'Ward 4' },
      severity: 'High',
      status: 'Submitted',
      submittedAt: '2026-11-01T10:00:00Z',
      updatedAt: '2026-11-01T10:00:00Z',
      department: 'Solid Waste Management',
      slaDeadline: '48h',
      timeline: [],
      userId: 'citizen-A',
    },
    {
      id: 'rep-2',
      trackingNumber: 'CFX-2026-0002',
      category: 'Pothole',
      title: 'Deep road crater',
      description: 'Vehicle damage hazard',
      photoUrl: '',
      location: { address: 'Cross Road', latitude: 12.91, longitude: 77.51, ward: 'Ward 4' },
      severity: 'Hazard',
      status: 'In Progress',
      submittedAt: '2026-11-02T10:00:00Z',
      updatedAt: '2026-11-02T14:00:00Z',
      department: 'Roads & Infrastructure',
      slaDeadline: '24h',
      timeline: [],
      userId: 'citizen-A',
    },
    {
      id: 'rep-3',
      trackingNumber: 'CFX-2026-0003',
      category: 'Water Leakage',
      title: 'Burst pipe',
      description: 'Clean drinking water leaking on road',
      photoUrl: '',
      location: { address: 'Ring Road', latitude: 12.92, longitude: 77.52, ward: 'Ward 9' },
      severity: 'Moderate',
      status: 'Resolved',
      submittedAt: '2026-11-03T08:00:00Z',
      updatedAt: '2026-11-04T08:00:00Z', // 24 hours later
      department: 'Water Supply & Sewerage Board',
      slaDeadline: '24h',
      timeline: [],
      userId: 'citizen-B',
    },
    {
      id: 'rep-4',
      trackingNumber: 'CFX-2026-0004',
      category: 'Broken Streetlight',
      title: 'Dark intersection',
      description: 'Streetlight pole 44 dark at night',
      photoUrl: '',
      location: { address: 'Park Avenue', latitude: 12.93, longitude: 77.53, ward: 'Ward 9' },
      severity: 'Low',
      status: 'Rejected',
      submittedAt: '2026-11-04T12:00:00Z',
      updatedAt: '2026-11-04T13:00:00Z',
      department: 'Electrical Department',
      slaDeadline: '72h',
      timeline: [],
      userId: 'citizen-C',
    },
  ];

  const populatedStats = calculateAdminStats(sampleReports);

  assert(populatedStats.totalReports === 4, 'Correctly aggregates total reports (4)');
  assert(populatedStats.pendingReports === 1, 'Correctly aggregates pending reports (1 Submitted)');
  assert(populatedStats.inProgressReports === 1, 'Correctly aggregates in-progress reports (1 In Progress)');
  assert(populatedStats.resolvedReports === 1, 'Correctly aggregates resolved reports (1 Resolved)');
  assert(populatedStats.rejectedReports === 1, 'Correctly aggregates rejected reports (1 Rejected)');
  assert(populatedStats.highSeverityReports === 2, 'Correctly aggregates high severity reports (1 High + 1 Hazard = 2)');

  assert(
    populatedStats.categoryDistribution['Garbage accumulation'] === 1,
    'Category distribution normalizes legacy Garbage to Garbage accumulation (1)'
  );
  assert(
    populatedStats.categoryDistribution['Potholes'] === 1,
    'Category distribution normalizes legacy Pothole to Potholes (1)'
  );
  assert(
    populatedStats.categoryDistribution['Water leakage'] === 1,
    'Category distribution normalizes legacy Water Leakage to Water leakage (1)'
  );
  assert(
    populatedStats.categoryDistribution['Streetlight problems'] === 1,
    'Category distribution normalizes legacy Broken Streetlight to Streetlight problems (1)'
  );
  assert(
    populatedStats.categoryDistribution['Overflowing dustbins'] === 0 &&
      populatedStats.categoryDistribution['Damaged roads'] === 0 &&
      populatedStats.categoryDistribution['Drainage problems'] === 0 &&
      populatedStats.categoryDistribution['Other civic issues'] === 0,
    'Category distribution tracks zero for untracked categories across all 8 canonical buckets'
  );

  assert(populatedStats.wardDistribution['Ward 4'] === 2, 'Ward distribution accurately counts Ward 4 tickets (2)');
  assert(populatedStats.wardDistribution['Ward 9'] === 2, 'Ward distribution accurately counts Ward 9 tickets (2)');

  // 24 hours from 2026-11-03T08:00:00Z to 2026-11-04T08:00:00Z
  assert(populatedStats.avgResolutionHours === 24, 'Correctly calculates average resolution duration (24.0 hours)');
}

// 4. extractCitizenSummaries Privacy & Aggregation Tests
function testCitizenSummaries() {
  const reports: CivicIssueReport[] = [
    {
      id: 'rep-1',
      trackingNumber: 'CFX-2026-0001',
      category: 'Garbage',
      title: 'T1',
      description: 'D1',
      photoUrl: '',
      location: { address: 'A1', latitude: null, longitude: null, ward: 'Ward 1' },
      severity: 'Low',
      status: 'Resolved',
      submittedAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-02T00:00:00Z',
      department: 'SWM',
      slaDeadline: '48h',
      timeline: [],
      userId: 'secret-citizen-user-alpha-999',
    },
    {
      id: 'rep-2',
      trackingNumber: 'CFX-2026-0002',
      category: 'Pothole',
      title: 'T2',
      description: 'D2',
      photoUrl: '',
      location: { address: 'A2', latitude: null, longitude: null, ward: 'Ward 1' },
      severity: 'High',
      status: 'Submitted',
      submittedAt: '2026-11-02T00:00:00Z',
      updatedAt: '2026-11-02T00:00:00Z',
      department: 'Roads',
      slaDeadline: '48h',
      timeline: [],
      userId: 'secret-citizen-user-alpha-999',
    },
  ];

  const summaries = extractCitizenSummaries(reports);
  assert(summaries.length === 1, 'Deduplicates multiple reports from the same citizen UID');
  assert(summaries[0].totalReports === 2, 'Accurately sums total reports for citizen (2)');
  assert(summaries[0].resolvedReports === 1, 'Accurately counts resolved reports for citizen (1)');
  assert(!summaries[0].name.includes('secret-citizen-user-alpha-999'), 'Citizen private UID is masked in public display name');
}

// 5. Six Canonical Report Statuses & Normalization Tests
function testSixCanonicalStatuses() {
  console.log('\n  Checking 6 Canonical Report Statuses & Invariants:');

  // A. Check canonical status list
  const expectedStatuses: ReportStatus[] = [
    'Submitted',
    'Under Review',
    'Assigned',
    'In Progress',
    'Resolved',
    'Rejected',
  ];
  assert(
    VALID_REPORT_STATUSES.length === 6 &&
      expectedStatuses.every((s) => VALID_REPORT_STATUSES.includes(s)),
    'VALID_REPORT_STATUSES contains exactly all 6 canonical statuses'
  );

  // B. Normalization tests
  assert(normalizeReportStatus('Submitted') === 'Submitted', 'Normalizes exact "Submitted"');
  assert(normalizeReportStatus('Under Review') === 'Under Review', 'Normalizes exact "Under Review"');
  assert(normalizeReportStatus('Assigned') === 'Assigned', 'Normalizes exact "Assigned"');
  assert(normalizeReportStatus('In Progress') === 'In Progress', 'Normalizes exact "In Progress"');
  assert(normalizeReportStatus('Resolved') === 'Resolved', 'Normalizes exact "Resolved"');
  assert(normalizeReportStatus('Rejected') === 'Rejected', 'Normalizes exact "Rejected"');

  // Variations & legacy statuses
  assert(normalizeReportStatus('in_progress') === 'In Progress', 'Normalizes "in_progress" snake_case to "In Progress"');
  assert(normalizeReportStatus('under_review') === 'Under Review', 'Normalizes "under_review" snake_case to "Under Review"');
  assert(normalizeReportStatus('open') === 'Submitted', 'Safely defaults legacy "open" to "Submitted"');
  assert(normalizeReportStatus('closed') === 'Resolved', 'Safely normalizes legacy "closed" to "Resolved"');
  assert(normalizeReportStatus(undefined) === 'Submitted', 'Safely defaults undefined status to "Submitted"');
  assert(normalizeReportStatus(null) === 'Submitted', 'Safely defaults null status to "Submitted"');
  assert(normalizeReportStatus('corrupted_status_xyz') === 'Submitted', 'Safely defaults arbitrary unknown string to "Submitted"');

  // C. Theme color mapping tests
  const themeSubmitted = getStatusThemeClasses('Submitted');
  assert(themeSubmitted.includes('blue'), 'Submitted badge maps to blue theme');

  const themeUnderReview = getStatusThemeClasses('Under Review');
  assert(themeUnderReview.includes('amber') || themeUnderReview.includes('orange'), 'Under Review badge maps to orange/amber theme');

  const themeAssigned = getStatusThemeClasses('Assigned');
  assert(themeAssigned.includes('purple'), 'Assigned badge maps to purple theme');

  const themeInProgress = getStatusThemeClasses('In Progress');
  assert(themeInProgress.includes('cyan'), 'In Progress badge maps to cyan theme');

  const themeResolved = getStatusThemeClasses('Resolved');
  assert(themeResolved.includes('emerald') || themeResolved.includes('green'), 'Resolved badge maps to green/emerald theme');

  const themeRejected = getStatusThemeClasses('Rejected');
  assert(themeRejected.includes('rose') || themeRejected.includes('red'), 'Rejected badge maps to red/rose theme');

  // D. Sum of status counts strictly equals totalReports invariant
  const mixedReports: CivicIssueReport[] = [
    { id: '1', trackingNumber: 'C1', category: 'Garbage', title: '', description: '', photoUrl: '', location: { address: '', latitude: null, longitude: null, ward: 'W1' }, severity: 'Low', status: 'Submitted', submittedAt: '', updatedAt: '', department: '', slaDeadline: '', timeline: [], userId: 'u1' },
    { id: '2', trackingNumber: 'C2', category: 'Garbage', title: '', description: '', photoUrl: '', location: { address: '', latitude: null, longitude: null, ward: 'W1' }, severity: 'Low', status: 'Under Review', submittedAt: '', updatedAt: '', department: '', slaDeadline: '', timeline: [], userId: 'u1' },
    { id: '3', trackingNumber: 'C3', category: 'Garbage', title: '', description: '', photoUrl: '', location: { address: '', latitude: null, longitude: null, ward: 'W1' }, severity: 'Low', status: 'Assigned', submittedAt: '', updatedAt: '', department: '', slaDeadline: '', timeline: [], userId: 'u1' },
    { id: '4', trackingNumber: 'C4', category: 'Garbage', title: '', description: '', photoUrl: '', location: { address: '', latitude: null, longitude: null, ward: 'W1' }, severity: 'Low', status: 'In Progress', submittedAt: '', updatedAt: '', department: '', slaDeadline: '', timeline: [], userId: 'u1' },
    { id: '5', trackingNumber: 'C5', category: 'Garbage', title: '', description: '', photoUrl: '', location: { address: '', latitude: null, longitude: null, ward: 'W1' }, severity: 'Low', status: 'Resolved', submittedAt: '', updatedAt: '', department: '', slaDeadline: '', timeline: [], userId: 'u1' },
    { id: '6', trackingNumber: 'C6', category: 'Garbage', title: '', description: '', photoUrl: '', location: { address: '', latitude: null, longitude: null, ward: 'W1' }, severity: 'Low', status: 'Rejected', submittedAt: '', updatedAt: '', department: '', slaDeadline: '', timeline: [], userId: 'u1' },
    { id: '7', trackingNumber: 'C7', category: 'Garbage', title: '', description: '', photoUrl: '', location: { address: '', latitude: null, longitude: null, ward: 'W1' }, severity: 'Low', status: 'legacy_unknown' as any, submittedAt: '', updatedAt: '', department: '', slaDeadline: '', timeline: [], userId: 'u1' },
  ];

  const stats = calculateAdminStats(mixedReports);
  assert(stats.totalReports === 7, 'Total reports equals 7');
  assert(stats.statusDistribution.Submitted === 2, 'Submitted count is 2 (including legacy fallback)');
  assert(stats.statusDistribution['Under Review'] === 1, 'Under Review count is 1');
  assert(stats.statusDistribution.Assigned === 1, 'Assigned count is 1');
  assert(stats.statusDistribution['In Progress'] === 1, 'In Progress count is 1');
  assert(stats.statusDistribution.Resolved === 1, 'Resolved count is 1');
  assert(stats.statusDistribution.Rejected === 1, 'Rejected count is 1');

  const sumOfSix =
    stats.statusDistribution.Submitted +
    stats.statusDistribution['Under Review'] +
    stats.statusDistribution.Assigned +
    stats.statusDistribution['In Progress'] +
    stats.statusDistribution.Resolved +
    stats.statusDistribution.Rejected;

  assert(
    sumOfSix === stats.totalReports,
    'INVARIANT SATISFIED: Sum of 6 individual status counts strictly equals totalReports'
  );

  // E. Status Transition Rules Matrix
  assert(
    VALID_STATUS_TRANSITIONS.Submitted.includes('Under Review') &&
      isValidStatusTransition('Submitted', 'Under Review') === true &&
      isValidStatusTransition('Submitted', 'Assigned') === true &&
      isValidStatusTransition('Submitted', 'Submitted') === true &&
      isValidStatusTransition('Withdrawn', 'Resolved') === false &&
      isValidStatusTransition('Resolved', 'Assigned') === false,
    'VALID_STATUS_TRANSITIONS and isValidStatusTransition enforce valid workflow transitions'
  );
}

// 6. Admin Report Update Permission Pre-Check & Security Rules Alignment Tests
async function testAdminUpdateAndRulesGuards() {
  console.log('\n  Checking Admin Update Pre-Checks & Security Rules Alignment:');

  // A. Calling updateReportStatusByAdmin without an active Firebase session must fail safely
  const unauthRes = await updateReportStatusByAdmin('rep_test_1793198114908', {
    status: 'In Progress',
    previousStatus: 'Submitted',
  });
  assert(
    unauthRes.success === false &&
      typeof unauthRes.error === 'string' &&
      unauthRes.error.toLowerCase().includes('session'),
    'updateReportStatusByAdmin rejects unauthenticated callers cleanly before writing to Firestore'
  );

  // B. Verify firestore.rules enforces zero-trust custom claims & /admins/{uid} without hardcoded personal emails
  const firestoreRules = fs.readFileSync(path.resolve(process.cwd(), 'firestore.rules'), 'utf-8');
  assert(
    firestoreRules.includes('request.auth.token.admin == true') &&
      firestoreRules.includes('exists(/databases/$(database)/documents/admins/$(request.auth.uid))'),
    'firestore.rules enforces cryptographic admin claim or explicit /admins/{uid} membership'
  );
  assert(
    !firestoreRules.includes('245124748053@mvsrec.edu.in') &&
      !firestoreRules.includes('superadmin@civifix.org'),
    'firestore.rules contains no hardcoded email allowlists'
  );
  assert(
    firestoreRules.includes("!('userId' in resource.data)") &&
      firestoreRules.includes("!('trackingNumber' in resource.data)") &&
      firestoreRules.includes("!('id' in resource.data)"),
    'firestore.rules safely guards optional inline identity fields on partial report documents during admin updates'
  );
  assert(
    firestoreRules.includes('match /statusHistory/{historyId}') &&
      firestoreRules.includes('match /auditLogs/{logId}') &&
      firestoreRules.includes("request.resource.data.status != 'Resolved'"),
    'firestore.rules enforces immutable statusHistory, auditLogs, and resolutionDetails on Resolved'
  );

  // C. Verify storage.rules enforces zero-trust admin claim & user-scoped report uploads
  const storageRules = fs.readFileSync(path.resolve(process.cwd(), 'storage.rules'), 'utf-8');
  assert(
    storageRules.includes('request.auth.token.admin == true') &&
      storageRules.includes('match /reports/{userId}/{reportId}/{fileName}') &&
      storageRules.includes('request.auth.uid == userId'),
    'storage.rules enforces admin custom claim for resolutions and owner UID scoping for citizen photos'
  );
}

// 7. Admin Login, Incorrect Password, Password Reset, Ordinary User Denial, Logout & Provisioning Tests
async function testAdminLoginFlowsAndProvisioning() {
  console.log('\n  Checking Admin Login, Password Reset, Access Denial, Logout & Provisioning:');

  const mockAuthInstance: any = { currentUser: null };

  // A. Successful admin login with Remember Me enabled (local persistence)
  let persistenceUsed: any = null;
  const adminSignInRes = await signInAdminWithCredentials(
    'officer@municipality.gov',
    'StrongAdminPass#1',
    true,
    {
      authInstance: mockAuthInstance,
      setPersistenceFn: (async (_auth: any, persistence: any) => {
        persistenceUsed = persistence;
      }) as any,
      signInFn: (async (_auth: any, email: string) => ({
        user: {
          uid: 'admin-uid-001',
          email,
          displayName: 'Municipal Administrator',
          metadata: { creationTime: '2026-11-01T00:00:00Z' },
          getIdTokenResult: async () => ({
            token: 'verified-admin-jwt',
            claims: { admin: true, role: 'superadmin' },
          }),
        },
      })) as any,
      verifyAdminFn: async (u) => verifyAdminPrivileges(u),
      signOutFn: (async () => {}) as any,
    }
  );

  assert(
    adminSignInRes.success === true &&
      adminSignInRes.admin?.email === 'officer@municipality.gov' &&
      adminSignInRes.admin?.role === 'superadmin' &&
      persistenceUsed === browserLocalPersistence,
    'Successful admin login verifies claims, returns AdminUser, and applies local persistence when Remember Me is true'
  );

  // B. Remember Me disabled uses session persistence
  let sessionPersistenceUsed: any = null;
  await signInAdminWithCredentials('officer@municipality.gov', 'StrongAdminPass#1', false, {
    authInstance: mockAuthInstance,
    setPersistenceFn: (async (_auth: any, persistence: any) => {
      sessionPersistenceUsed = persistence;
    }) as any,
    signInFn: (async (_auth: any, email: string) => ({
      user: {
        uid: 'admin-uid-001',
        email,
        getIdTokenResult: async () => ({
          token: 'verified-admin-jwt',
          claims: { admin: true, role: 'superadmin' },
        }),
      },
    })) as any,
    verifyAdminFn: async (u) => verifyAdminPrivileges(u),
    signOutFn: (async () => {}) as any,
  });

  assert(
    sessionPersistenceUsed === browserSessionPersistence,
    'Admin login applies browserSessionPersistence when Remember Me is unchecked'
  );

  // C. Incorrect password returns friendly error without leaking raw Firebase error string
  const wrongPassRes = await signInAdminWithCredentials(
    'officer@municipality.gov',
    'WrongPassword!',
    true,
    {
      authInstance: mockAuthInstance,
      setPersistenceFn: (async () => {}) as any,
      signInFn: (async () => {
        const err: any = new Error('Firebase: Error (auth/invalid-credential).');
        err.code = 'auth/invalid-credential';
        throw err;
      }) as any,
      verifyAdminFn: async (u) => verifyAdminPrivileges(u),
      signOutFn: (async () => {}) as any,
    }
  );

  assert(
    wrongPassRes.success === false &&
      wrongPassRes.admin === null &&
      typeof wrongPassRes.error === 'string' &&
      wrongPassRes.error.includes('Invalid administrator email or password') &&
      !wrongPassRes.error.includes('Firebase: Error'),
    'Incorrect password returns friendly error message without raw Firebase SDK codes'
  );

  // D. Ordinary citizen account is denied admin access and immediately signed out
  let signOutCallCount = 0;
  const citizenDeniedRes = await signInAdminWithCredentials(
    'citizen@gmail.com',
    'CitizenPass123',
    true,
    {
      authInstance: mockAuthInstance,
      setPersistenceFn: (async () => {}) as any,
      signInFn: (async (_auth: any, email: string) => ({
        user: {
          uid: 'citizen-uid-444',
          email,
          getIdTokenResult: async () => ({
            token: 'citizen-jwt',
            claims: {},
          }),
        },
      })) as any,
      verifyAdminFn: async (u) => verifyAdminPrivileges(u),
      signOutFn: (async () => {
        signOutCallCount += 1;
      }) as any,
    }
  );

  assert(
    citizenDeniedRes.success === false &&
      citizenDeniedRes.admin === null &&
      signOutCallCount === 1,
    'Ordinary citizen login into Admin Portal is denied and signed out immediately'
  );

  // E. Password reset validation & Firebase sendPasswordResetEmail invocation
  const invalidReset = await sendAdminPasswordReset('not-an-email', {
    authInstance: mockAuthInstance,
    sendResetFn: (async () => {}) as any,
  });
  assert(
    invalidReset.success === false,
    'Admin password reset rejects invalid email formats before calling Firebase'
  );

  let resetSentTo = '';
  const validReset = await sendAdminPasswordReset('officer@municipality.gov', {
    authInstance: mockAuthInstance,
    sendResetFn: (async (_auth: any, targetEmail: string) => {
      resetSentTo = targetEmail;
    }) as any,
  });
  assert(
    validReset.success === true && resetSentTo === 'officer@municipality.gov',
    'Admin password reset calls Firebase sendPasswordResetEmail for valid email'
  );

  // F. Admin Logout cleanly calls Firebase signOut
  let adminSignOutCount = 0;
  await signOutAdmin({
    authInstance: mockAuthInstance,
    signOutFn: (async () => {
      adminSignOutCount += 1;
    }) as any,
  });
  assert(adminSignOutCount === 1, 'signOutAdmin invokes Firebase signOut cleanly');

  // G. Dedicated Admin Provisioning Script (existing Auth user only + claim + /admins/{uid})
  const envConfig = resolveProvisioningConfig(
    {
      ADMIN_EMAIL: 'admin.demo@civifix.local',
      ADMIN_ROLE: 'superadmin',
      ADMIN_DEPARTMENT: 'Municipal Operations',
    },
    ['node', 'scripts/grant-admin-claim.mjs']
  );
  assert(
      envConfig.email === 'admin.demo@civifix.local' &&
      envConfig.role === 'superadmin' &&
      envConfig.revoke === false &&
      envConfig.syncPassword === false,
    'grant-admin-claim.mjs resolves the target email and safe provisioning defaults'
  );

  let lookupEmail: string | null = null;
  let assignedClaims: any = null;
  let storedAdminDoc: any = null;

  const mockProvisionAuth = {
    getUserByEmail: async (email: string) => {
      lookupEmail = email;
      return {
        uid: 'existing-admin-uid-1',
        email,
        displayName: 'Existing Administrator',
        emailVerified: true,
      };
    },
    setCustomUserClaims: async (uid: string, claims: any) => {
      assignedClaims = { uid, claims };
    },
  };

  const mockProvisionDb = {
    collection: (name: string) => ({
      doc: (docId: string) => ({
        set: async (data: any) => {
          storedAdminDoc = { collection: name, docId, data };
        },
        delete: async () => {},
      }),
    }),
  };

  const provResult = await provisionDedicatedAdmin({
    auth: mockProvisionAuth,
    db: mockProvisionDb,
    config: envConfig,
    nowIso: () => '2026-11-15T00:00:00.000Z',
  });

  assert(
    provResult.action === 'provisioned' &&
      provResult.createdAccount === false &&
      lookupEmail === 'admin.demo@civifix.local' &&
      assignedClaims?.claims?.admin === true &&
      assignedClaims?.uid === 'existing-admin-uid-1' &&
      storedAdminDoc?.collection === 'admins' &&
      storedAdminDoc?.docId === 'existing-admin-uid-1' &&
      storedAdminDoc?.data?.active === true,
    'Dedicated admin provisioning targets an existing Firebase Auth user, grants admin: true claim, and activates /admins/{uid}'
  );

  let creationAttempted = false;
  const missingUserAuth = {
    getUserByEmail: async () => {
      const err: any = new Error('User not found');
      err.code = 'auth/user-not-found';
      throw err;
    },
    createUser: async () => {
      creationAttempted = true;
      throw new Error('createUser must not be called');
    },
  };
  let missingUserRejected = false;
  try {
    await provisionDedicatedAdmin({
      auth: missingUserAuth,
      db: mockProvisionDb,
      config: envConfig,
    });
  } catch (error: any) {
    missingUserRejected = /No existing Firebase user found/.test(error?.message || '');
  }
  assert(
    missingUserRejected && creationAttempted === false,
    'Dedicated admin provisioning rejects missing users without attempting account creation'
  );

  // H. Route, UI & Dashboard Contract Verification
  const appSource = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  const loginScreenSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/admin/AdminLoginScreen.tsx'),
    'utf-8'
  );
  const dashboardSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/admin/AdminDashboard.tsx'),
    'utf-8'
  );

  assert(
    appSource.includes("appRoute === 'admin_login'") &&
      appSource.includes("navigateToRoute('admin_dashboard'") &&
      appSource.includes("navigateToRoute('admin_login'") &&
      appSource.includes('setAdminUser(null)'),
    'App.tsx enforces admin route protection, dashboard redirection, and logout session clearing'
  );
  assert(
    loginScreenSource.includes('CivifixLogo') &&
      loginScreenSource.includes('Administrator Login') &&
      loginScreenSource.includes('Remember me') &&
      loginScreenSource.includes('Forgot Password?') &&
      loginScreenSource.includes('Show password') &&
      loginScreenSource.includes('sendAdminPasswordReset'),
    'AdminLoginScreen renders CivicFix AI logo, Administrator Login heading, show/hide password, Remember me, and Forgot Password reset'
  );
  assert(
    dashboardSource.includes('{admin.email}') &&
      dashboardSource.includes('handleSignOut') &&
      dashboardSource.includes('Logout'),
    'AdminDashboard displays authenticated administrator email and secure Logout action'
  );
}

// 8. Phase 1 Foundations: Categories, Priority Helpers, 4-Role + Inactive Auth, Mixed Timestamps & Transactional Size Safety
async function testPhase1FoundationsAndSafeguards() {
  console.log('\n  Checking Phase 1 Foundations & Safeguards:');

  // A. Category normalization across all 8 canonical & 6 legacy categories
  const allExpandedValid = EXPANDED_CIVIC_CATEGORIES.every(
    (cat) => normalizeCivicCategory(cat) === cat
  );
  const allLegacyMapped = LEGACY_CIVIC_CATEGORIES.every((legacy) =>
    EXPANDED_CIVIC_CATEGORIES.includes(normalizeCivicCategory(legacy))
  );
  assert(
    EXPANDED_CIVIC_CATEGORIES.length === 8 &&
      allExpandedValid &&
      allLegacyMapped &&
      normalizeCivicCategory('Overflowing dustbins') === 'Overflowing dustbins' &&
      normalizeCivicCategory('Damaged roads') === 'Damaged roads' &&
      normalizeCivicCategory('Garbage') === 'Garbage accumulation',
    'All 8 canonical categories and 6 legacy categories normalize consistently'
  );

  // B. Non-mutating severity priority & SLA parsing helpers
  assert(
    getSeverityPriorityScore('Hazard') === 4 &&
      getSeverityPriorityScore('High') === 3 &&
      getSeverityPriorityScore('Moderate') === 2 &&
      getSeverityPriorityScore('Medium') === 2 &&
      getSeverityPriorityScore('Minor') === 1 &&
      getSeverityPriorityScore('Low') === 1,
    'getSeverityPriorityScore ranks canonical and legacy severities consistently'
  );
  assert(
    derivePriorityTier('Hazard') === 'Critical' &&
      derivePriorityTier('High') === 'High' &&
      derivePriorityTier('Moderate') === 'Standard' &&
      derivePriorityTier('Minor') === 'Low',
    'derivePriorityTier maps severities cleanly without mutating stored severity'
  );
  assert(
    parseSlaHours('24 Hours Rapid Redressal') === 24 &&
      parseSlaHours('48h') === 48 &&
      parseSlaHours('72 Hours') === 72 &&
      parseSlaHours('Pending triage') === null,
    'parseSlaHours extracts existing hour targets and returns null instead of inventing deadlines'
  );

  // C. 4-Role RBAC Preservation & Inactive Admin Denial (Client + Server Middleware)
  assert(
    VALID_ADMIN_ROLES.length === 4 &&
      VALID_ADMIN_ROLES.includes('staff') &&
      VALID_ADMIN_ROLES.includes('ward_admin') &&
      VALID_ADMIN_ROLES.includes('department_head') &&
      VALID_ADMIN_ROLES.includes('superadmin') &&
      normalizeAdminRole('ward_admin') === 'ward_admin' &&
      normalizeAdminRole('staff') === 'staff' &&
      ADMIN_ROLE_CAPABILITIES.superadmin.canManageAdmins === true &&
      ADMIN_ROLE_CAPABILITIES.staff.canManageAdmins === false,
    'All 4 AdminRole values and capability metadata are preserved'
  );

  for (const role of VALID_ADMIN_ROLES) {
    const mockAdmin: any = {
      uid: `uid-${role}`,
      email: `${role}@municipality.gov`,
      displayName: `Admin ${role}`,
      metadata: { creationTime: '2026-11-01T00:00:00Z' },
      getIdTokenResult: async () => ({
        token: `jwt-${role}`,
        claims: { admin: true, role },
      }),
    };
    const clientRes = await verifyAdminPrivileges(mockAdmin);
    const serverRes = await verifyAdminFromDecodedToken(
      { uid: `uid-${role}`, email: `${role}@municipality.gov`, admin: true, role } as any,
      { adminDb: null }
    );
    assert(
      clientRes.authorized === true &&
        clientRes.admin?.role === role &&
        serverRes.authorized === true &&
        serverRes.role === role,
      `Role "${role}" is preserved end-to-end in verifyAdminPrivileges and verifyAdminFromDecodedToken`
    );
  }

  // Inactive /admins/{uid} overrides cached admin: true claim on BOTH client & server
  const mockDeactivatedClaimUser: any = {
    uid: 'deactivated-admin-1',
    email: 'former.admin@municipality.gov',
    displayName: 'Former Admin',
    getIdTokenResult: async () => ({
      token: 'stale-admin-jwt',
      claims: { admin: true, role: 'superadmin' },
    }),
  };
  const clientDeactivated = await verifyAdminPrivileges(mockDeactivatedClaimUser, {
    getAdminDocFn: async () => ({
      exists: true,
      data: { active: false, role: 'superadmin' },
    }),
  });
  const serverDeactivated = await verifyAdminFromDecodedToken(
    { uid: 'deactivated-admin-1', email: 'former.admin@municipality.gov', admin: true, role: 'superadmin' } as any,
    {
      adminDb: {
        collection: () => ({
          doc: () => ({
            get: async () => ({
              exists: true,
              data: () => ({ active: false, role: 'superadmin' }),
            }),
          }),
        }),
      },
    }
  );
  assert(
    clientDeactivated.authorized === false &&
      Boolean(clientDeactivated.error?.toLowerCase().includes('deactivated')) &&
      serverDeactivated.authorized === false &&
      serverDeactivated.inactive === true,
    'Inactive /admins/{uid} (active: false) explicitly rejects admin even with unrevoked custom claim'
  );

  // Degraded adminDb === null still rejects email-only citizen accounts
  const serverEmailOnly = await verifyAdminFromDecodedToken(
    { uid: 'citizen-uid', email: 'admin@civifix.gov', email_verified: true } as any,
    { adminDb: null }
  );
  assert(
    serverEmailOnly.authorized === false,
    'Email-only account remains denied when server Firestore credentials are unavailable'
  );

  // D. Mixed Timestamp Mapping, Deduplication & Missing Date Sorting
  const tsObjReport = mapFirestoreDocToReport('doc-ts', {
    category: 'Potholes',
    submittedAt: { toDate: () => new Date('2026-11-12T10:00:00Z') },
    updatedAt: '2026-11-12T10:00:00Z',
    location: { address: 'Ward Rd', latitude: 12.9, longitude: 77.6, ward: 'Ward 1' },
  });
  const isoNewerReport = mapFirestoreDocToReport('doc-iso', {
    category: 'Garbage',
    submittedAt: '2026-11-15T10:00:00Z',
    updatedAt: '2026-11-15T10:00:00Z',
    location: { address: 'Main Rd', latitude: null, longitude: null, ward: 'Ward 2' },
  });
  const missingDatesReport = mapFirestoreDocToReport('doc-missing', {
    category: 'Drainage',
    location: { address: 'Legacy Lane', latitude: null, longitude: null, ward: 'Ward 3' },
  });
  const duplicateIsoOlderCopy = { ...isoNewerReport, title: 'Older Copy' };
  const mergedReports = mergeAndDeduplicateReports(
    [missingDatesReport, duplicateIsoOlderCopy, tsObjReport],
    [isoNewerReport]
  );
  assert(
    mergedReports.length === 3 &&
      mergedReports[0].id === 'doc-iso' &&
      mergedReports[1].id === 'doc-ts' &&
      mergedReports[2].id === 'doc-missing' &&
      missingDatesReport.submittedAt === '',
    'mergeAndDeduplicateReports deduplicates by id, handles mixed Timestamp/ISO strings, and sorts missing timestamps to bottom without fabricating Date.now()'
  );

  // Offline/unconfigured check for pagination helpers returns honest isComplete: false
  const offlineAll = await fetchAllReportsForAdmin();
  const offlinePage = await fetchAdminReportsPage({ mode: 'documentId', pageSize: 50 });
  assert(
    offlineAll.isComplete === false &&
      offlinePage.isComplete === false &&
      offlinePage.mode === 'documentId',
    'Bounded retrieval and documentId pagination report honest isComplete: false when offline/unconfigured'
  );

  // E. Transactional updateReportStatusByAdmin: preserves citizenNotes & side effects, rejects oversized final doc, cleans up unused Storage upload
  const mockAdminCaller: any = {
    uid: 'admin-tx-uid',
    email: 'tx.admin@municipality.gov',
    getIdTokenResult: async () => ({
      token: 'tx-admin-jwt',
      claims: { admin: true, role: 'department_head' },
    }),
  };

  let capturedTxUpdatePayload: any = null;
  const capturedSideEffects: Array<{ col: string; data: any }> = [];
  const fakeDb: any = { __mockDb: true };

  const txSuccessRes = await updateReportStatusByAdmin(
    'rep-tx-ok',
    {
      status: 'Resolved',
      previousStatus: 'In Progress',
      resolutionDetails: 'Road resurfaced cleanly.',
      resolutionPhotoUrl: 'data:image/jpeg;base64,/9j/4AAQ',
      assignedDepartment: 'Roads & Infrastructure Maintenance',
    },
    {
      currentUser: mockAdminCaller,
      dbInstance: fakeDb,
      verifyAdminFn: async () => ({
        authorized: true,
        admin: { uid: 'admin-tx-uid', email: 'tx.admin@municipality.gov', role: 'department_head' },
      }),
      uploadResolutionFn: async () => ({
        success: true,
        url: 'https://firebasestorage.googleapis.com/v0/b/test/o/resolutions%2Frep-tx-ok%2Fres.jpg',
      }),
      docFn: ((_d: any, _c: string, id: string) => ({ id })) as any,
      collectionFn: ((_d: any, ...segs: string[]) => ({ path: segs.join('/') })) as any,
      runTransactionFn: (async (_d: any, fn: any) => {
        const fakeTx = {
          get: async () => ({
            exists: () => true,
            data: () => ({
              id: 'rep-tx-ok',
              trackingNumber: 'CFX-2026-TX01',
              userId: 'citizen-1',
              status: 'In Progress',
              photoUrl: 'data:image/jpeg;base64,' + 'B'.repeat(1000),
              citizenNotes: ['Concurrent citizen follow-up note'],
              timeline: [{ status: 'Submitted', timestamp: '2026-11-10T00:00:00Z', note: 'Submitted' }],
            }),
          }),
          update: (_ref: any, payload: any) => {
            capturedTxUpdatePayload = payload;
          },
        };
        return fn(fakeTx);
      }) as any,
      addDocFn: (async (colRef: any, data: any) => {
        capturedSideEffects.push({ col: colRef.path, data });
        return { id: 'audit-1' };
      }) as any,
    }
  );

  assert(
    txSuccessRes.success === true &&
      capturedTxUpdatePayload !== null &&
      !('citizenNotes' in capturedTxUpdatePayload) &&
      capturedTxUpdatePayload.timeline.length === 2 &&
      capturedSideEffects.some((s) => s.col.endsWith('/statusHistory')) &&
      capturedSideEffects.some((s) => s.col === 'auditLogs'),
    'Transactional updateReportStatusByAdmin preserves concurrent citizenNotes, live timeline, statusHistory, and auditLogs'
  );

  // Oversized live doc (citizen inline photo + Storage fallback resolution data URL > 800 KiB) must abort BEFORE tx.update
  let oversizedWriteAttempted = false;
  let cleanedUpUrl = '';
  const largeCitizenPhoto = 'data:image/jpeg;base64,' + 'C'.repeat(450 * 1024);
  const largeFallbackResolution = 'data:image/jpeg;base64,' + 'D'.repeat(450 * 1024);

  const txOversizedRes = await updateReportStatusByAdmin(
    'rep-tx-oversized',
    {
      status: 'Resolved',
      previousStatus: 'In Progress',
      resolutionDetails: 'Fixed',
      resolutionPhotoUrl: largeFallbackResolution,
    },
    {
      currentUser: mockAdminCaller,
      dbInstance: fakeDb,
      verifyAdminFn: async () => ({
        authorized: true,
        admin: { uid: 'admin-tx-uid', email: 'tx.admin@municipality.gov', role: 'department_head' },
      }),
      uploadResolutionFn: async () => ({
        success: false,
        url: largeFallbackResolution,
        error: 'Storage unavailable',
      }),
      cleanupUploadedResolutionFn: async (url: string) => {
        cleanedUpUrl = url;
      },
      docFn: ((_d: any, _c: string, id: string) => ({ id })) as any,
      collectionFn: ((_d: any, ...segs: string[]) => ({ path: segs.join('/') })) as any,
      runTransactionFn: (async (_d: any, fn: any) => {
        const fakeTx = {
          get: async () => ({
            exists: () => true,
            data: () => ({
              id: 'rep-tx-oversized',
              status: 'In Progress',
              photoUrl: largeCitizenPhoto,
              timeline: [],
            }),
          }),
          update: () => {
            oversizedWriteAttempted = true;
          },
        };
        return fn(fakeTx);
      }) as any,
    }
  );

  assert(
    txOversizedRes.success === false &&
      oversizedWriteAttempted === false &&
      cleanedUpUrl === '' &&
      Boolean(txOversizedRes.error?.toLowerCase().includes('smaller photo')),
    'Transactional size guard aborts write BEFORE tx.update when complete merged live document exceeds 800 KiB'
  );

  // If Storage upload succeeded BEFORE transaction, and transaction fails (e.g. concurrently withdrawn), cleanup is triggered ONLY for newly uploaded resolution URL
  let cleanupTargetUrl = '';
  const txWithdrawnRes = await updateReportStatusByAdmin(
    'rep-tx-withdrawn',
    {
      status: 'In Progress',
      previousStatus: 'Submitted',
      resolutionPhotoUrl: 'data:image/jpeg;base64,/9j/4AAQ',
    },
    {
      currentUser: mockAdminCaller,
      dbInstance: fakeDb,
      verifyAdminFn: async () => ({
        authorized: true,
        admin: { uid: 'admin-tx-uid', email: 'tx.admin@municipality.gov', role: 'department_head' },
      }),
      uploadResolutionFn: async () => ({
        success: true,
        url: 'https://firebasestorage.googleapis.com/v0/b/test/o/resolutions%2Frep-tx-withdrawn%2Fnew.jpg',
      }),
      cleanupUploadedResolutionFn: async (url: string) => {
        cleanupTargetUrl = url;
      },
      docFn: ((_d: any, _c: string, id: string) => ({ id })) as any,
      collectionFn: ((_d: any, ...segs: string[]) => ({ path: segs.join('/') })) as any,
      runTransactionFn: (async (_d: any, fn: any) => {
        const fakeTx = {
          get: async () => ({
            exists: () => true,
            data: () => ({
              id: 'rep-tx-withdrawn',
              status: 'Withdrawn',
              photoUrl: 'https://firebasestorage.googleapis.com/v0/b/test/o/reports%2Fcitizen%2Fexisting.jpg',
              timeline: [],
            }),
          }),
          update: () => {
            throw new Error('Should not update withdrawn doc');
          },
        };
        return fn(fakeTx);
      }) as any,
    }
  );

  assert(
    txWithdrawnRes.success === false &&
      cleanupTargetUrl.includes('resolutions%2Frep-tx-withdrawn%2Fnew.jpg') &&
      !cleanupTargetUrl.includes('reports%2Fcitizen'),
    'Failed transaction performs best-effort cleanup of newly uploaded resolution object only (never citizen photos)'
  );
}

// 9. Phase 3: Audit Logs Retrieval, Pagination-Safe Merge & Rebuilt Dashboard Contract Tests
async function testPhase3DashboardAndAuditLogs() {
  console.log('\n  Checking Phase 3 Audit Logs, Pagination Merge & Dashboard Rebuild:');

  // A. fetchRecentAuditLogs cloud success (non-truncated)
  const fakeDocs = [
    {
      id: 'log-1',
      data: () => ({
        action: 'admin_status_change',
        targetType: 'civic_report',
        targetId: 'rep-100',
        actorUid: 'admin-uid-1',
        actorRole: 'admin',
        summary: 'Status changed from "Submitted" to "Assigned".',
        timestamp: '2026-11-15T10:00:00.000Z',
        metadata: { fromStatus: 'Submitted', toStatus: 'Assigned' },
      }),
    },
  ];
  const cloudAuditRes = await fetchRecentAuditLogs(10, {
    isConfigured: true,
    dbInstance: {},
    collectionFn: ((_d: any, name: string) => ({ name })) as any,
    queryFn: ((col: any) => col) as any,
    orderByFn: (() => ({})) as any,
    limitFn: (() => ({})) as any,
    getDocsFn: (async () => ({
      forEach: (cb: (doc: any) => void) => fakeDocs.forEach(cb),
    })) as any,
  });

  assert(
    cloudAuditRes.fromCloud === true &&
      cloudAuditRes.isPartial === false &&
      cloudAuditRes.logs.length === 1 &&
      cloudAuditRes.logs[0].action === 'admin_status_change' &&
      cloudAuditRes.logs[0].targetId === 'rep-100',
    'fetchRecentAuditLogs returns normalized cloud entries with isPartial=false when below limit'
  );

  // B. fetchRecentAuditLogs marks bounded window as partial when limit is reached
  const twoDocs = [fakeDocs[0], { ...fakeDocs[0], id: 'log-2' }];
  const boundedAuditRes = await fetchRecentAuditLogs(2, {
    isConfigured: true,
    dbInstance: {},
    collectionFn: ((_d: any, name: string) => ({ name })) as any,
    queryFn: ((col: any) => col) as any,
    orderByFn: (() => ({})) as any,
    limitFn: (() => ({})) as any,
    getDocsFn: (async () => ({
      forEach: (cb: (doc: any) => void) => twoDocs.forEach(cb),
    })) as any,
  });

  assert(
    boundedAuditRes.fromCloud === true &&
      boundedAuditRes.isPartial === true &&
      boundedAuditRes.logs.length === 2,
    'fetchRecentAuditLogs marks bounded window as isPartial=true when result length reaches limit'
  );

  // C. fetchRecentAuditLogs honest offline state (never fabricates events)
  const offlineAuditRes = await fetchRecentAuditLogs(25, {
    isConfigured: false,
    dbInstance: null,
  });
  assert(
    offlineAuditRes.fromCloud === false &&
      offlineAuditRes.isPartial === true &&
      offlineAuditRes.logs.length === 0 &&
      Boolean(offlineAuditRes.error),
    'fetchRecentAuditLogs reports offline state honestly without fabricating events'
  );

  // D. fetchRecentAuditLogs permission-denied handling
  const deniedAuditRes = await fetchRecentAuditLogs(25, {
    isConfigured: true,
    dbInstance: {},
    collectionFn: ((_d: any, name: string) => ({ name })) as any,
    queryFn: ((col: any) => col) as any,
    orderByFn: (() => ({})) as any,
    limitFn: (() => ({})) as any,
    getDocsFn: (async () => {
      const err: any = new Error('Missing or insufficient permissions');
      err.code = 'permission-denied';
      throw err;
    }) as any,
  });
  assert(
    deniedAuditRes.fromCloud === false &&
      deniedAuditRes.isPartial === true &&
      deniedAuditRes.logs.length === 0 &&
      Boolean(deniedAuditRes.error?.toLowerCase().includes('not authorized')),
    'fetchRecentAuditLogs handles permission-denied safely with honest error'
  );

  // E. Three-pool merge (paginated + fetched refresh + realtime) avoids duplicates and preserves scanned records
  const legacyScanned = mapFirestoreDocToReport('legacy-doc-1', {
    trackingNumber: 'CFX-LEGACY-01',
    category: 'Garbage',
    status: 'Submitted',
    title: 'Legacy alley garbage',
  });
  const recentFetched = mapFirestoreDocToReport('recent-doc-2', {
    trackingNumber: 'CFX-2026-0002',
    category: 'Potholes',
    status: 'Submitted',
    title: 'Main Rd Pothole',
    submittedAt: '2026-11-14T08:00:00.000Z',
  });
  const liveUpdated = mapFirestoreDocToReport('recent-doc-2', {
    trackingNumber: 'CFX-2026-0002',
    category: 'Potholes',
    status: 'In Progress',
    title: 'Main Rd Pothole',
    submittedAt: '2026-11-14T08:00:00.000Z',
  });

  const mergedPools = mergeAndDeduplicateReports(
    [legacyScanned],
    [recentFetched],
    [liveUpdated]
  );
  assert(
    mergedPools.length === 2 &&
      mergedPools.some((r) => r.id === 'legacy-doc-1') &&
      mergedPools.find((r) => r.id === 'recent-doc-2')?.status === 'In Progress',
    'mergeAndDeduplicateReports preserves documentId-scanned legacy records across refreshes and applies realtime updates'
  );

  // F. Rebuilt AdminDashboard & AdminReportDetailsModal Phase 3 structural checks
  const dashboardSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/admin/AdminDashboard.tsx'),
    'utf-8'
  );
  const modalSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/admin/AdminReportDetailsModal.tsx'),
    'utf-8'
  );

  assert(
    dashboardSource.includes('CivifixLogo') &&
      dashboardSource.includes('Overview') &&
      dashboardSource.includes('Complaints') &&
      dashboardSource.includes('Departments') &&
      dashboardSource.includes('Citizens') &&
      dashboardSource.includes('Activity') &&
      dashboardSource.includes('fetchRecentAuditLogs') &&
      dashboardSource.includes('fetchAdminReportsPage') &&
      dashboardSource.includes('docIdPagination') &&
      dashboardSource.includes('severityFilter') &&
      dashboardSource.includes('ADMIN_ROLE_CAPABILITIES') &&
      modalSource.includes('ADMIN_ROLE_CAPABILITIES') &&
      modalSource.includes('themeMode="auto"'),
    'Phase 3 AdminDashboard & AdminReportDetailsModal include all 5 sections, Citizen visual branding, pagination state isolation, severity filter, and role capability UI checks'
  );
}

async function testPhase4Step2DepartmentAlignment() {
  console.log('\nChecking Phase 4 Step 2 Department Alignment & Assignment Consistency:');

  // 1 & 2. All 8 canonical categories (and 6 legacy categories) map to canonical Admin options with zero mismatch
  const expectedMapping: Record<string, string> = {
    'Garbage accumulation': 'Solid Waste Management',
    'Overflowing dustbins': 'Solid Waste Management',
    Potholes: 'Roads & Infrastructure Maintenance',
    'Damaged roads': 'Roads & Infrastructure Maintenance',
    'Water leakage': 'Water Supply & Sewerage Board',
    'Drainage problems': 'Stormwater Drainage & Flood Control',
    'Streetlight problems': 'Electrical & Street Lighting Department',
    'Other civic issues': 'General Municipal Administration',
  };

  for (const cat of EXPANDED_CIVIC_CATEGORIES) {
    const dept = getDepartmentForCategory(cat);
    assert(
      (CANONICAL_MUNICIPAL_DEPARTMENTS as readonly string[]).includes(dept) &&
        dept === expectedMapping[cat],
      `Category "${cat}" maps cleanly to canonical admin department "${dept}"`
    );
  }

  for (const legacyCat of LEGACY_CIVIC_CATEGORIES) {
    const dept = getDepartmentForCategory(legacyCat);
    assert(
      (CANONICAL_MUNICIPAL_DEPARTMENTS as readonly string[]).includes(dept),
      `Legacy category "${legacyCat}" resolves to canonical admin department "${dept}"`
    );
  }

  // Ensure ReportIssueScreen and AdminReportDetailsModal share the exact canonical helpers and never hardcode 'Solid Waste Management' fallback
  const reportScreenSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/screens/ReportIssueScreen.tsx'),
    'utf-8'
  );
  const modalSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/admin/AdminReportDetailsModal.tsx'),
    'utf-8'
  );
  const dashboardSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/admin/AdminDashboard.tsx'),
    'utf-8'
  );

  assert(
    reportScreenSource.includes('getDepartmentForCategory') &&
      !reportScreenSource.includes("'Public Grievances Cell'") &&
      !reportScreenSource.includes("'Electrical Works'") &&
      modalSource.includes('resolveReportDepartment') &&
      modalSource.includes('buildDepartmentSelectOptions') &&
      modalSource.includes('resolveDepartmentUpdateArg') &&
      !modalSource.includes("|| 'Solid Waste Management'"),
    'Citizen ReportIssueScreen uses shared canonical getDepartmentForCategory and Admin modal removes silent Solid Waste Management fallback'
  );

  for (const dept of CANONICAL_MUNICIPAL_DEPARTMENTS) {
    assert(
      dashboardSource.includes(`'${dept}'`),
      `AdminDashboard CANONICAL_DEPARTMENTS aligns verbatim with "${dept}"`
    );
  }

  // 3. Existing canonical department values remain selected (reads assignedDepartment first, then department)
  assert(
    resolveReportDepartment({
      assignedDepartment: 'Electrical & Street Lighting Department',
      department: 'Roads & Infrastructure Maintenance',
    }) === 'Electrical & Street Lighting Department',
    'resolveReportDepartment prioritizes assignedDepartment over department'
  );
  assert(
    resolveReportDepartment({
      assignedDepartment: '',
      department: 'Stormwater Drainage & Flood Control',
    }) === 'Stormwater Drainage & Flood Control',
    'resolveReportDepartment falls back to department when assignedDepartment is empty'
  );

  // 4 & 5. Legacy, custom, and unset departments remain preserved without defaulting to Solid Waste Management
  const legacyDept = 'Sanitation & Solid Waste';
  const legacyOptions = buildDepartmentSelectOptions(legacyDept);
  assert(
    legacyOptions[0] === legacyDept &&
      legacyOptions.length === CANONICAL_MUNICIPAL_DEPARTMENTS.length + 1,
    'Existing legacy department is preserved as an additional selectable option alongside canonical departments'
  );

  const customDept = 'Ward 14 Special Taskforce';
  const customOptions = buildDepartmentSelectOptions(customDept);
  assert(
    customOptions[0] === customDept &&
      resolveReportDepartment({ department: customDept }) === customDept,
    'Unknown/custom department value remains preserved and selectable'
  );

  const unsetResolved = resolveReportDepartment({ assignedDepartment: '', department: '' });
  assert(
    unsetResolved === '' &&
      resolveDepartmentUpdateArg('', '') === undefined,
    'Unset department stays empty instead of silently defaulting to Solid Waste Management'
  );

  // 6 & 7. Saving unrelated fields preserves existing department; explicit reassignment updates department transactionally
  assert(
    resolveDepartmentUpdateArg(customDept, customDept) === undefined &&
      resolveDepartmentUpdateArg(legacyDept, legacyDept) === undefined &&
      resolveDepartmentUpdateArg(customDept, 'Water Supply & Sewerage Board') ===
        'Water Supply & Sewerage Board',
    'resolveDepartmentUpdateArg omits department when unchanged and returns new value on explicit admin change'
  );

  const mockAdminCaller: any = {
    uid: 'admin-dept-uid',
    email: 'dept.admin@municipality.gov',
    getIdTokenResult: async () => ({
      token: 'dept-admin-jwt',
      claims: { admin: true, role: 'department_head' },
    }),
  };
  const fakeDb: any = { __mockDb: true };

  // Test 6: Unrelated update passes undefined assignedDepartment -> Firestore payload leaves custom department intact
  let payloadUnrelated: any = null;
  const unrelatedArg = resolveDepartmentUpdateArg(customDept, customDept);
  const resUnrelated = await updateReportStatusByAdmin(
    'rep-dept-preserve',
    {
      status: 'Under Review',
      previousStatus: 'Submitted',
      adminRemarks: 'Assigned inspector to review site.',
      assignedOfficer: 'Insp. Meenakshi',
      assignedDepartment: unrelatedArg,
    },
    {
      currentUser: mockAdminCaller,
      dbInstance: fakeDb,
      verifyAdminFn: async () => ({
        authorized: true,
        admin: { uid: 'admin-dept-uid', email: 'dept.admin@municipality.gov', role: 'department_head' },
      }),
      docFn: ((_d: any, _c: string, id: string) => ({ id })) as any,
      collectionFn: ((_d: any, ...segs: string[]) => ({ path: segs.join('/') })) as any,
      runTransactionFn: (async (_d: any, fn: any) => {
        const fakeTx = {
          get: async () => ({
            exists: () => true,
            data: () => ({
              id: 'rep-dept-preserve',
              status: 'Submitted',
              department: customDept,
              assignedDepartment: customDept,
              timeline: [],
            }),
          }),
          update: (_ref: any, payload: any) => {
            payloadUnrelated = payload;
          },
        };
        return fn(fakeTx);
      }) as any,
      addDocFn: (async () => ({ id: 'log-1' })) as any,
    }
  );

  assert(
    resUnrelated.success === true &&
      payloadUnrelated !== null &&
      !('assignedDepartment' in payloadUnrelated) &&
      !('department' in payloadUnrelated) &&
      payloadUnrelated.assignedOfficer === 'Insp. Meenakshi',
    'Saving unrelated report fields (remarks, officer, status) does NOT overwrite existing department in Firestore'
  );

  // Test 7: Explicit administrator reassignment updates both assignedDepartment and department
  let payloadReassign: any = null;
  const reassignArg = resolveDepartmentUpdateArg(
    customDept,
    'Public Health & Sanitation'
  );
  const resReassign = await updateReportStatusByAdmin(
    'rep-dept-reassign',
    {
      status: 'Assigned',
      previousStatus: 'Under Review',
      assignedDepartment: reassignArg,
      assignedOfficer: 'Dr. Anand Rao',
    },
    {
      currentUser: mockAdminCaller,
      dbInstance: fakeDb,
      verifyAdminFn: async () => ({
        authorized: true,
        admin: { uid: 'admin-dept-uid', email: 'dept.admin@municipality.gov', role: 'department_head' },
      }),
      docFn: ((_d: any, _c: string, id: string) => ({ id })) as any,
      collectionFn: ((_d: any, ...segs: string[]) => ({ path: segs.join('/') })) as any,
      runTransactionFn: (async (_d: any, fn: any) => {
        const fakeTx = {
          get: async () => ({
            exists: () => true,
            data: () => ({
              id: 'rep-dept-reassign',
              status: 'Under Review',
              department: customDept,
              assignedDepartment: customDept,
              timeline: [],
            }),
          }),
          update: (_ref: any, payload: any) => {
            payloadReassign = payload;
          },
        };
        return fn(fakeTx);
      }) as any,
      addDocFn: (async () => ({ id: 'log-2' })) as any,
    }
  );

  assert(
    resReassign.success === true &&
      payloadReassign !== null &&
      payloadReassign.assignedDepartment === 'Public Health & Sanitation' &&
      payloadReassign.department === 'Public Health & Sanitation' &&
      payloadReassign.assignedOfficer === 'Dr. Anand Rao',
    'Explicit administrator reassignment updates assignedDepartment and department transactionally'
  );
}

// 10. Phase 4 Step 5: Duplicate Unlinking & Admin Modal Live Synchronization Regression Tests
async function testPhase4Step5AdminFixes() {
  console.log('\nChecking Phase 4 Step 5 Finding 1 (Duplicate Unlinking) & Finding 2 (Admin Live Modal Sync):');

  // --- Finding 1: Duplicate Link / Unlink / Preserve ---
  assert(
    resolveDuplicateOfUpdateArg('', 'CFX-2026-PRIMARY') === 'CFX-2026-PRIMARY',
    'Linking duplicate returns trimmed primary tracking reference'
  );
  assert(
    resolveDuplicateOfUpdateArg('CFX-2026-PRIMARY', '') === '',
    'Explicitly unlinking duplicate returns empty string "" instead of undefined'
  );
  assert(
    resolveDuplicateOfUpdateArg('CFX-2026-PRIMARY', 'CFX-2026-PRIMARY') === undefined,
    'Unchanged duplicate reference returns undefined so unrelated edits preserve existing link'
  );

  const mockAdminCaller: any = {
    uid: 'admin-dup-uid',
    email: 'dup.admin@municipality.gov',
    getIdTokenResult: async () => ({
      token: 'dup-admin-jwt',
      claims: { admin: true, role: 'department_head' },
    }),
  };
  const fakeDb: any = { __mockDb: true };

  // Unlink existing duplicate in Firestore transaction and log 'duplicate_unlinked'
  let unlinkPayload: any = null;
  let unlinkAuditAction: string | null = null;
  const unlinkArg = resolveDuplicateOfUpdateArg('CFX-2026-PRIMARY', '');
  const resUnlink = await updateReportStatusByAdmin(
    'rep-dup-unlink',
    {
      status: 'Under Review',
      previousStatus: 'Submitted',
      duplicateOf: unlinkArg,
    },
    {
      currentUser: mockAdminCaller,
      dbInstance: fakeDb,
      verifyAdminFn: async () => ({
        authorized: true,
        admin: { uid: 'admin-dup-uid', email: 'dup.admin@municipality.gov', role: 'department_head' },
      }),
      docFn: ((_d: any, _c: string, id: string) => ({ id })) as any,
      collectionFn: ((_d: any, ...segs: string[]) => ({ path: segs.join('/') })) as any,
      runTransactionFn: (async (_d: any, fn: any) => {
        const fakeTx = {
          get: async () => ({
            exists: () => true,
            data: () => ({
              id: 'rep-dup-unlink',
              status: 'Submitted',
              duplicateOf: 'CFX-2026-PRIMARY',
              timeline: [],
            }),
          }),
          update: (_ref: any, payload: any) => {
            unlinkPayload = payload;
          },
        };
        return fn(fakeTx);
      }) as any,
      addDocFn: (async (colRef: any, data: any) => {
        if (colRef.path === 'auditLogs') unlinkAuditAction = data.action;
        return { id: 'log-unlink' };
      }) as any,
    }
  );

  const remappedAfterUnlink = mapFirestoreDocToReport('rep-dup-unlink', {
    trackingNumber: 'CFX-2026-UNLINK',
    category: 'Garbage',
    status: 'Under Review',
    duplicateOf: unlinkPayload?.duplicateOf,
  });
  const citizenViewAfterUnlink = resolveCitizenReportVisibility(remappedAfterUnlink);

  assert(
    resUnlink.success === true &&
      unlinkPayload !== null &&
      unlinkPayload.duplicateOf === '' &&
      unlinkAuditAction === 'duplicate_unlinked' &&
      remappedAfterUnlink.duplicateOf === undefined &&
      citizenViewAfterUnlink.duplicateOf === null,
    'Unlinking writes empty duplicateOf, logs duplicate_unlinked, and hides duplicate badge in admin & citizen views'
  );

  // Saving unrelated fields when duplicate is untouched must NOT include duplicateOf
  let preservePayload: any = null;
  const preserveArg = resolveDuplicateOfUpdateArg('CFX-2026-PRIMARY', 'CFX-2026-PRIMARY');
  const resPreserve = await updateReportStatusByAdmin(
    'rep-dup-preserve',
    {
      status: 'Under Review',
      previousStatus: 'Under Review',
      adminRemarks: 'Routine inspection scheduled.',
      duplicateOf: preserveArg,
    },
    {
      currentUser: mockAdminCaller,
      dbInstance: fakeDb,
      verifyAdminFn: async () => ({
        authorized: true,
        admin: { uid: 'admin-dup-uid', email: 'dup.admin@municipality.gov', role: 'department_head' },
      }),
      docFn: ((_d: any, _c: string, id: string) => ({ id })) as any,
      collectionFn: ((_d: any, ...segs: string[]) => ({ path: segs.join('/') })) as any,
      runTransactionFn: (async (_d: any, fn: any) => {
        const fakeTx = {
          get: async () => ({
            exists: () => true,
            data: () => ({
              id: 'rep-dup-preserve',
              status: 'Under Review',
              duplicateOf: 'CFX-2026-PRIMARY',
              timeline: [],
            }),
          }),
          update: (_ref: any, payload: any) => {
            preservePayload = payload;
          },
        };
        return fn(fakeTx);
      }) as any,
      addDocFn: (async () => ({ id: 'log-preserve' })) as any,
    }
  );

  assert(
    resPreserve.success === true &&
      preservePayload !== null &&
      !('duplicateOf' in preservePayload),
    'Unchanged duplicateOf is omitted from Firestore update payload during unrelated edits'
  );

  // --- Finding 2: Admin Selected Report Sync & Modal Dirty-Field Reconciliation ---
  const baseModalReport: CivicIssueReport = mapFirestoreDocToReport('rep-modal-sync', {
    trackingNumber: 'CFX-2026-MODAL',
    category: 'Potholes',
    status: 'Submitted',
    department: 'Roads & Infrastructure Maintenance',
    assignedDepartment: 'Roads & Infrastructure Maintenance',
    assignedOfficer: '',
    adminRemarks: '',
    resolutionDetails: '',
    resolutionPhotoUrl: '',
    updatedAt: '2026-11-15T10:00:00.000Z',
  });

  // Dashboard list update updates selectedReport when changed and keeps identity when identical
  const identicalCopy = { ...baseModalReport };
  assert(
    syncSelectedReport(baseModalReport, [identicalCopy]) === baseModalReport,
    'syncSelectedReport preserves exact object reference when report fields are unchanged'
  );
  const updatedLiveSameStatus: CivicIssueReport = {
    ...baseModalReport,
    assignedOfficer: 'Eng. Kavitha',
    updatedAt: '2026-11-15T11:00:00.000Z',
    citizenNotes: ['Follow-up citizen note added live'],
  };
  assert(
    syncSelectedReport(baseModalReport, [updatedLiveSameStatus]) === updatedLiveSameStatus,
    'syncSelectedReport delivers updated live report to open admin modal'
  );

  // Unsaved dirty edits stay intact while unedited fields update from live report
  const adminEditingRemarks = {
    status: 'Submitted' as ReportStatus,
    assignedDepartment: 'Roads & Infrastructure Maintenance',
    assignedOfficer: '',
    adminRemarks: 'Draft remarks still typing...',
    resolutionDetails: '',
    resolutionPhotoUrl: '',
    duplicateOf: '',
  };
  const reconciledNonConflicting = reconcileAdminModalFormState(
    adminEditingRemarks,
    baseModalReport,
    updatedLiveSameStatus
  );
  assert(
    reconciledNonConflicting.conflictMessage === null &&
      reconciledNonConflicting.nextForm.adminRemarks === 'Draft remarks still typing...' &&
      reconciledNonConflicting.nextForm.assignedOfficer === 'Eng. Kavitha',
    'reconcileAdminModalFormState updates unedited officer from live report while preserving unsaved adminRemarks'
  );

  // Concurrent citizen withdrawal disables saving and warns without wiping unsaved edits
  const withdrawnLiveReport: CivicIssueReport = {
    ...baseModalReport,
    status: 'Withdrawn',
    withdrawnAt: '2026-11-15T12:00:00.000Z',
  };
  const reconciledWithdrawn = reconcileAdminModalFormState(
    adminEditingRemarks,
    baseModalReport,
    withdrawnLiveReport
  );
  assert(
    Boolean(reconciledWithdrawn.conflictMessage?.includes('withdrawn by the citizen')) &&
      reconciledWithdrawn.nextForm.status === 'Withdrawn' &&
      reconciledWithdrawn.nextForm.adminRemarks === 'Draft remarks still typing...',
    'Concurrent citizen withdrawal triggers clear conflict alert while keeping unsaved draft text'
  );

  // Concurrent admin status shift flags conflict cleanly
  const movedToAssignedLive: CivicIssueReport = {
    ...baseModalReport,
    status: 'Assigned',
  };
  const adminSelectingInProgress = {
    ...adminEditingRemarks,
    status: 'In Progress' as ReportStatus,
  };
  const reconciledConflict = reconcileAdminModalFormState(
    adminSelectingInProgress,
    baseModalReport,
    movedToAssignedLive
  );
  assert(
    Boolean(reconciledConflict.conflictMessage?.includes('Another update was saved')) &&
      reconciledConflict.nextForm.status === 'In Progress' &&
      reconciledConflict.nextForm.adminRemarks === 'Draft remarks still typing...',
    'Concurrent status change surfaces conflict banner instead of silently overwriting unsaved selection'
  );

  const dashboardSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/admin/AdminDashboard.tsx'),
    'utf-8'
  );
  const modalSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/admin/AdminReportDetailsModal.tsx'),
    'utf-8'
  );
  assert(
    (dashboardSource.includes('syncSelectedReport(prev, activeReports)') ||
      dashboardSource.includes('syncSelectedReport(prev, reports)')) &&
      modalSource.includes('reconcileAdminModalFormState') &&
      modalSource.includes('resolveDuplicateOfUpdateArg') &&
      modalSource.includes('Refresh Form') &&
      modalSource.includes('[report.id, report.updatedAt, report.status]'),
    'AdminDashboard and AdminReportDetailsModal wire live sync, Refresh Form recovery, duplicate unlink arg, and statusHistory refresh'
  );
}

async function testSingleApprovedAdminEmailAllowlist() {
  console.log('\n  Checking Single-Approved ADMIN_EMAIL Server Verification:');

  const prevAdminEmail = process.env.ADMIN_EMAIL;
  const prevAdminEmails = process.env.ADMIN_EMAILS;

  try {
    // 1. Unconfigured ADMIN_EMAIL / ADMIN_EMAILS strictly denies ordinary accounts
    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_EMAILS;
    const unconfiguredDeny = await verifyAdminFromDecodedToken(
      {
        uid: 'citizen-uid-1',
        email: 'citizen@gmail.com',
        email_verified: true,
        firebase: { sign_in_provider: 'password' },
      } as any,
      { adminDb: null }
    );
    assert(
      unconfiguredDeny.authorized === false,
      'Rejects authenticated user when ADMIN_EMAIL and ADMIN_EMAILS are not configured on server'
    );

    // 2. Configured ADMIN_EMAIL is not an authorization substitute for claims/admin doc
    process.env.ADMIN_EMAIL = 'SingleAdmin@Municipality.gov';
    const approvedPasswordRes = await verifyAdminFromDecodedToken(
      {
        uid: 'single-admin-uid',
        email: 'singleadmin@municipality.gov',
        email_verified: false,
        firebase: { sign_in_provider: 'password' },
      } as any,
      { adminDb: null }
    );
    assert(
      approvedPasswordRes.authorized === false,
      'Rejects ADMIN_EMAIL-only Firebase password account until claims or /admins/{uid} provisioning exists'
    );

    // 3. Rejects non-matching citizen email even when ADMIN_EMAIL is configured
    const otherCitizenRes = await verifyAdminFromDecodedToken(
      {
        uid: 'other-citizen-uid',
        email: 'resident@gmail.com',
        email_verified: true,
        firebase: { sign_in_provider: 'password' },
      } as any,
      { adminDb: null }
    );
    assert(
      otherCitizenRes.authorized === false,
      'Strictly denies any other authenticated citizen account when ADMIN_EMAIL is configured'
    );

    // 4. Rejects unverified non-password provider account even if email matches
    const unverifiedOauthRes = await verifyAdminFromDecodedToken(
      {
        uid: 'spoof-oauth-uid',
        email: 'singleadmin@municipality.gov',
        email_verified: false,
        firebase: { sign_in_provider: 'custom' },
      } as any,
      { adminDb: null }
    );
    assert(
      unverifiedOauthRes.authorized === false,
      'Rejects unverified non-password identity even if email matches ADMIN_EMAIL'
    );
  } finally {
    if (prevAdminEmail === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = prevAdminEmail;
    if (prevAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = prevAdminEmails;
  }
}

async function testAdminUpdateStatusAndAssignmentRegression() {
  console.log('\n  Checking Admin Update Status & Assignment Functionality:');

  const baselineReport: CivicIssueReport = mapFirestoreDocToReport('rep-assign-1', {
    trackingNumber: 'CFX-2026-ASG1',
    category: 'Garbage accumulation',
    status: 'Submitted',
    department: 'Solid Waste Management',
    assignedDepartment: 'Solid Waste Management',
    assignedOfficer: 'Insp. Meera',
    adminRemarks: 'Initial triage note',
    photoUrl: 'https://firebasestorage.googleapis.com/v0/b/test/o/reports%2Fu1%2Frep-assign-1%2Fissue.jpg',
    citizenNotes: ['Follow up citizen note'],
    timeline: [
      {
        status: 'Submitted',
        timestamp: '2026-11-10T08:00:00.000Z',
        note: 'Complaint submitted by citizen.',
        officer: 'Citizen',
      },
    ],
  });

  // 1. No-change detection (ignores whitespace differences)
  assert(
    hasAdminModalFormChanges(
      {
        status: 'Submitted',
        assignedDepartment: 'Solid Waste Management ',
        assignedOfficer: ' Insp. Meera ',
        adminRemarks: ' Initial triage note ',
        resolutionDetails: '',
        resolutionPhotoUrl: '',
        duplicateOf: '',
      },
      baselineReport
    ) === false,
    'hasAdminModalFormChanges detects unchanged values cleanly (including whitespace)'
  );

  assert(
    hasAdminModalFormChanges(
      {
        status: 'Submitted',
        assignedDepartment: 'Public Health & Sanitation',
        assignedOfficer: 'Insp. Meera',
        adminRemarks: 'Initial triage note',
        resolutionDetails: '',
        resolutionPhotoUrl: '',
        duplicateOf: '',
      },
      baselineReport
    ) === true,
    'hasAdminModalFormChanges returns true when assignedDepartment changes'
  );

  assert(
    resolveOptionalStringUpdateArg(' Insp. Meera ', 'Insp. Meera') === undefined &&
      resolveOptionalStringUpdateArg('Insp. Meera', 'Insp. R. Sharma') === 'Insp. R. Sharma' &&
      resolveOptionalStringUpdateArg('Insp. Meera', '') === '',
    'resolveOptionalStringUpdateArg preserves untouched fields, trims updates, and allows clearing'
  );

  // 2. Self-echo from onSnapshot does not trigger false concurrent conflict
  const localEditedForm = {
    status: 'Assigned' as ReportStatus,
    assignedDepartment: 'Water Supply & Sewerage Board',
    assignedOfficer: 'Eng. Karthik',
    adminRemarks: 'Team assigned',
    resolutionDetails: '',
    resolutionPhotoUrl: '',
    duplicateOf: '',
  };
  const selfEchoIncoming: CivicIssueReport = {
    ...baselineReport,
    status: 'Assigned',
    department: 'Water Supply & Sewerage Board',
    assignedDepartment: 'Water Supply & Sewerage Board',
    assignedOfficer: 'Eng. Karthik',
    adminRemarks: 'Team assigned',
  };
  const echoReconcile = reconcileAdminModalFormState(
    localEditedForm,
    baselineReport,
    selfEchoIncoming
  );
  assert(
    echoReconcile.conflictMessage === null,
    'reconcileAdminModalFormState does not trigger false conflict on own saved echo from onSnapshot'
  );

  // 3. Assignment / Remarks-only update (same status): writes auditLogs, does NOT add statusHistory, preserves citizenNotes/photoUrl
  const mockAdminCaller: any = {
    uid: 'admin-asg-uid',
    email: undefined, // intentionally verify undefined email sanitization on statusHistory/auditLogs
    getIdTokenResult: async () => ({
      token: 'asg-admin-jwt',
      claims: { admin: true, role: 'department_head' },
    }),
  };
  const fakeDb: any = { __mockDb: true };
  let capturedAssignPayload: any = null;
  const assignSideEffects: Array<{ col: string; data: any }> = [];

  const deptOnlyRes = await updateReportStatusByAdmin(
    'rep-assign-1',
    {
      status: 'Submitted',
      previousStatus: 'Submitted',
      assignedDepartment: resolveDepartmentUpdateArg(
        'Solid Waste Management',
        'Public Health & Sanitation'
      ),
      assignedOfficer: resolveOptionalStringUpdateArg('Insp. Meera', 'Insp. R. Sharma (Ward 14)'),
      adminRemarks: resolveOptionalStringUpdateArg(
        'Initial triage note',
        'Dispatched sanitation crew to inspect overflow'
      ),
    },
    {
      currentUser: mockAdminCaller,
      dbInstance: fakeDb,
      verifyAdminFn: async () => ({
        authorized: true,
        admin: { uid: 'admin-asg-uid', email: 'admin@municipality.gov', role: 'department_head' },
      }),
      docFn: ((_d: any, _c: string, id: string) => ({ id })) as any,
      collectionFn: ((_d: any, ...segs: string[]) => ({ path: segs.join('/') })) as any,
      runTransactionFn: (async (_d: any, fn: any) => {
        const fakeTx = {
          get: async () => ({
            exists: () => true,
            data: () => ({
              id: 'rep-assign-1',
              status: 'Submitted',
              department: 'Solid Waste Management',
              assignedDepartment: 'Solid Waste Management',
              assignedOfficer: 'Insp. Meera',
              adminRemarks: 'Initial triage note',
              citizenNotes: ['Follow up citizen note'],
              photoUrl: 'https://firebasestorage.googleapis.com/v0/b/test/o/reports%2Fu1%2Frep-assign-1%2Fissue.jpg',
              timeline: baselineReport.timeline,
            }),
          }),
          update: (_ref: any, payload: any) => {
            capturedAssignPayload = payload;
          },
        };
        return fn(fakeTx);
      }) as any,
      addDocFn: (async (colRef: any, data: any) => {
        if (JSON.stringify(data).includes('undefined')) {
          throw new Error('Undefined field serialized into addDoc');
        }
        assignSideEffects.push({ col: colRef.path, data });
        return { id: 'side-1' };
      }) as any,
    }
  );

  const auditEntry = assignSideEffects.find((s) => s.col === 'auditLogs');
  assert(
    assignSideEffects.every((s) => !s.col.endsWith('/statusHistory')) &&
      deptOnlyRes.success === true &&
      capturedAssignPayload?.assignedDepartment === 'Public Health & Sanitation' &&
      capturedAssignPayload?.department === 'Public Health & Sanitation' &&
      capturedAssignPayload?.assignedOfficer === 'Insp. R. Sharma (Ward 14)' &&
      capturedAssignPayload?.adminRemarks === 'Dispatched sanitation crew to inspect overflow' &&
      !('citizenNotes' in capturedAssignPayload) &&
      !('photoUrl' in capturedAssignPayload) &&
      deptOnlyRes.updatedFields?.assignedDepartment === 'Public Health & Sanitation' &&
      Boolean(auditEntry && auditEntry.data.action === 'admin_note_update') &&
      Boolean(auditEntry?.data.metadata?.assignedDepartment === 'Public Health & Sanitation') &&
      Boolean(auditEntry?.data.metadata?.assignedOfficer === 'Insp. R. Sharma (Ward 14)') &&
      Boolean(
        auditEntry?.data.summary.includes('Public Health & Sanitation') &&
          auditEntry?.data.summary.includes('Insp. R. Sharma (Ward 14)')
      ),
    'Department, officer & remarks update persists cleanly, omits statusHistory when status unchanged, records descriptive timeline & auditLogs, and preserves unrelated fields'
  );

  // 4. Status transition creates statusHistory + auditLogs and updates reopened report state
  const statusSideEffects: Array<{ col: string; data: any }> = [];
  const statusRes = await updateReportStatusByAdmin(
    'rep-assign-1',
    {
      status: 'Assigned',
      previousStatus: 'Submitted',
    },
    {
      currentUser: mockAdminCaller,
      dbInstance: fakeDb,
      verifyAdminFn: async () => ({
        authorized: true,
        admin: { uid: 'admin-asg-uid', email: 'admin@municipality.gov', role: 'department_head' },
      }),
      docFn: ((_d: any, _c: string, id: string) => ({ id })) as any,
      collectionFn: ((_d: any, ...segs: string[]) => ({ path: segs.join('/') })) as any,
      runTransactionFn: (async (_d: any, fn: any) => {
        const fakeTx = {
          get: async () => ({
            exists: () => true,
            data: () => ({
              id: 'rep-assign-1',
              status: 'Submitted',
              department: 'Public Health & Sanitation',
              assignedDepartment: 'Public Health & Sanitation',
              assignedOfficer: 'Insp. R. Sharma (Ward 14)',
              timeline: [],
            }),
          }),
          update: () => {},
        };
        return fn(fakeTx);
      }) as any,
      addDocFn: (async (colRef: any, data: any) => {
        statusSideEffects.push({ col: colRef.path, data });
        return { id: 'side-2' };
      }) as any,
    }
  );
  assert(
    statusRes.success === true &&
      statusSideEffects.some((s) => s.col.endsWith('/statusHistory') && s.data.toStatus === 'Assigned') &&
      statusSideEffects.some((s) => s.col === 'auditLogs' && s.data.action === 'admin_status_change') &&
      statusRes.updatedFields?.status === 'Assigned' &&
      statusRes.updatedFields?.assignedDepartment === 'Public Health & Sanitation',
    'Status transition creates immutable statusHistory and admin_status_change auditLogs and returns synced updatedFields'
  );

  // 5. Ordinary citizen / non-admin caller is blocked cleanly
  const citizenCallerRes = await updateReportStatusByAdmin(
    'rep-assign-1',
    {
      status: 'In Progress',
      previousStatus: 'Assigned',
    },
    {
      currentUser: { uid: 'citizen-uid-99', email: 'resident@example.com' },
      dbInstance: fakeDb,
      verifyAdminFn: async () => ({
        authorized: false,
        admin: null,
        error: 'Access denied: Citizen accounts do not have municipal administrator clearance.',
      }),
    }
  );
  assert(
    citizenCallerRes.success === false &&
      Boolean(citizenCallerRes.error?.includes('Access denied')),
    'Unauthorized ordinary citizen is blocked from updating report status or assignment'
  );

  // 6. Firestore permission-denied / write failure returns clear error safely
  const permDeniedRes = await updateReportStatusByAdmin(
    'rep-assign-1',
    {
      status: 'In Progress',
      previousStatus: 'Assigned',
    },
    {
      currentUser: mockAdminCaller,
      dbInstance: fakeDb,
      verifyAdminFn: async () => ({
        authorized: true,
        admin: { uid: 'admin-asg-uid', email: 'admin@municipality.gov', role: 'department_head' },
      }),
      docFn: ((_d: any, _c: string, id: string) => ({ id })) as any,
      runTransactionFn: (async () => {
        const err: any = new Error('Missing or insufficient permissions.');
        err.code = 'permission-denied';
        throw err;
      }) as any,
    }
  );
  assert(
    permDeniedRes.success === false &&
      Boolean(permDeniedRes.error?.toLowerCase().includes('not authorized')) &&
      !permDeniedRes.error?.toLowerCase().includes('security rules') &&
      !permDeniedRes.error?.toLowerCase().includes('firestore'),
    'Failed Firestore write returns clear, user-friendly permission error without fake success or technical jargon'
  );

  // 7. Modal & Dashboard structural checks for Update Status & Assignment fixes
  const modalSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/admin/AdminReportDetailsModal.tsx'),
    'utf-8'
  );
  const dashboardSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/admin/AdminDashboard.tsx'),
    'utf-8'
  );
  assert(
    modalSource.includes('hasAdminModalFormChanges') &&
      modalSource.includes('resolveOptionalStringUpdateArg') &&
      modalSource.includes('submitLockRef') &&
      modalSource.includes('role="status"') &&
      dashboardSource.includes('hasFetched: false'),
    'AdminReportDetailsModal & AdminDashboard enforce no-change guard, duplicate-submit lock, inline form feedback, and audit log cache refresh'
  );
}

async function testPortalIsolationAndRbacRouting() {
  console.log('\n  Checking Portal Isolation & Role-Based Route Protection:');

  // 1. Canonical route resolution across /admin, /admin/*, /admin/login, hashes, and citizen paths
  assert(
    resolveAppRouteFromLocation('/') === 'citizen' &&
      resolveAppRouteFromLocation('/administration') === 'citizen' &&
      resolveAppRouteFromLocation('/admin/login') === 'admin_login' &&
      resolveAppRouteFromLocation('/admin/login/') === 'admin_login' &&
      resolveAppRouteFromLocation('/', '#/admin/login') === 'admin_login' &&
      resolveAppRouteFromLocation('/admin') === 'admin_dashboard' &&
      resolveAppRouteFromLocation('/admin/') === 'admin_dashboard' &&
      resolveAppRouteFromLocation('/admin/complaints') === 'admin_dashboard' &&
      resolveAppRouteFromLocation('/admin/users/123') === 'admin_dashboard' &&
      resolveAppRouteFromLocation('/', '#/admin/reports') === 'admin_dashboard' &&
      getPathForRoute('citizen') === '/' &&
      getPathForRoute('admin_login') === '/admin/login' &&
      getPathForRoute('admin_dashboard') === '/admin',
    'Route resolver maps all /admin and /admin/* paths/hashes to protected admin_dashboard route'
  );

  // 2. Unauthenticated user opening /admin or /admin/* is redirected to /admin/login without rendering admin content
  const unauthDecision = evaluateAdminRouteAccess({
    route: 'admin_dashboard',
    isAuthChecking: false,
    hasAuthenticatedSession: false,
    hasVerifiedAdmin: false,
  });
  assert(
    unauthDecision.action === 'redirect' &&
      unauthDecision.redirectTo === 'admin_login' &&
      unauthDecision.shouldRenderAdminContent === false,
    'Unauthenticated user visiting /admin is redirected to Admin Login without rendering admin UI'
  );

  // 3. Loading / auth hydration state on /admin NEVER renders admin content
  const loadingDecision = evaluateAdminRouteAccess({
    route: 'admin_dashboard',
    isAuthChecking: true,
    hasAuthenticatedSession: false,
    hasVerifiedAdmin: false,
  });
  const pendingVerifyDecision = evaluateAdminRouteAccess({
    route: 'admin_dashboard',
    isAuthChecking: false,
    hasAuthenticatedSession: true,
    hasVerifiedAdmin: false,
  });
  assert(
    loadingDecision.action === 'loading' &&
      loadingDecision.shouldRenderAdminContent === false &&
      pendingVerifyDecision.action === 'verify' &&
      pendingVerifyDecision.shouldRenderAdminContent === false,
    'Browser refresh / auth hydration on /admin requires fresh verification and never flashes admin UI'
  );

  // 4. Ordinary citizen account visiting /admin or /admin/* is denied and redirected to Citizen Portal
  const citizenVerifyRes = await verifyAdminPrivileges(
    {
      uid: 'citizen-route-test-uid',
      email: 'citizen@gmail.com',
      getIdTokenResult: async () => ({
        token: 'citizen-token',
        claims: {},
      }),
    } as any,
    {
      getAdminDocFn: async () => ({ exists: false, data: undefined }),
      fetchFn: async () =>
        new Response(JSON.stringify({ authorized: false }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
    }
  );
  const citizenRouteDecision = evaluateAdminRouteAccess({
    route: 'admin_dashboard',
    isAuthChecking: false,
    hasAuthenticatedSession: true,
    hasVerifiedAdmin: false,
    verificationResult: citizenVerifyRes,
  });
  assert(
    citizenVerifyRes.authorized === false &&
      citizenVerifyRes.reason === 'unauthorized_citizen' &&
      citizenRouteDecision.action === 'redirect' &&
      citizenRouteDecision.redirectTo === 'citizen' &&
      citizenRouteDecision.shouldRenderAdminContent === false,
    'Authenticated citizen opening /admin is denied and redirected cleanly to Citizen Portal'
  );

  // 5. Deactivated admin (/admins/{uid}.active === false) is denied, signed out, and redirected to Admin Login
  const deactivatedVerifyRes = await verifyAdminPrivileges(
    {
      uid: 'deactivated-route-admin-uid',
      email: 'former.officer@municipality.gov',
      getIdTokenResult: async () => ({
        token: 'stale-admin-token',
        claims: { admin: true, role: 'department_head' },
      }),
    } as any,
    {
      getAdminDocFn: async () => ({
        exists: true,
        data: { active: false, role: 'department_head' },
      }),
    }
  );
  const deactivatedDecision = evaluateAdminRouteAccess({
    route: 'admin_dashboard',
    isAuthChecking: false,
    hasAuthenticatedSession: true,
    hasVerifiedAdmin: false,
    verificationResult: deactivatedVerifyRes,
  });
  assert(
    deactivatedVerifyRes.authorized === false &&
      deactivatedVerifyRes.isDeactivated === true &&
      deactivatedDecision.action === 'redirect' &&
      deactivatedDecision.redirectTo === 'admin_login' &&
      deactivatedDecision.shouldSignOut === true &&
      deactivatedDecision.shouldRenderAdminContent === false,
    'Deactivated administrator on /admin is denied, signed out, and redirected to Admin Login'
  );

  // 6. Active verified admin is allowed on /admin and auto-redirected from /admin/login
  const activeAdminVerifyRes = await verifyAdminPrivileges(
    {
      uid: 'active-route-admin-uid',
      email: 'active.officer@municipality.gov',
      getIdTokenResult: async () => ({
        token: 'valid-admin-token',
        claims: { admin: true, role: 'superadmin' },
      }),
    } as any,
    {
      getAdminDocFn: async () => ({
        exists: true,
        data: { active: true, role: 'superadmin' },
      }),
      fetchFn: async () =>
        new Response(JSON.stringify({ authorized: true, role: 'superadmin' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    }
  );
  const activeAllowDecision = evaluateAdminRouteAccess({
    route: 'admin_dashboard',
    isAuthChecking: false,
    hasAuthenticatedSession: true,
    hasVerifiedAdmin: false,
    verificationResult: activeAdminVerifyRes,
  });
  const activeLoginRedirectDecision = evaluateAdminRouteAccess({
    route: 'admin_login',
    isAuthChecking: false,
    hasAuthenticatedSession: true,
    hasVerifiedAdmin: true,
  });
  assert(
    activeAllowDecision.action === 'allow' &&
      activeAllowDecision.shouldRenderAdminContent === true &&
      activeLoginRedirectDecision.action === 'redirect' &&
      activeLoginRedirectDecision.redirectTo === 'admin_dashboard',
    'Verified active administrator gains access to /admin and redirects cleanly from /admin/login'
  );

  // 7. Source-level portal UI isolation checks (Desktop, Tablet, Mobile)
  const appSource = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  const citizenShellSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/CitizenShell.tsx'),
    'utf-8'
  );
  const authScreenSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/screens/AuthScreen.tsx'),
    'utf-8'
  );
  const adminLoginSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/admin/AdminLoginScreen.tsx'),
    'utf-8'
  );
  const adminDashboardSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/admin/AdminDashboard.tsx'),
    'utf-8'
  );

  assert(
    authScreenSource.includes('onOpenAdminPortal') &&
      authScreenSource.includes('Admin Portal') &&
      appSource.includes("onOpenAdminPortal={() => navigateToRoute('admin_login')}"),
    'Citizen Login page retains Go to Admin Portal option navigating to Admin Login'
  );
  assert(
    adminLoginSource.includes('onReturnToCitizen') &&
      adminLoginSource.includes('Return to Citizen Portal') &&
      !adminLoginSource.includes('Back to Citizen App'),
    'Admin Login page retains single Return to Citizen Portal option without duplicate switch buttons'
  );
  assert(
    !citizenShellSource.includes('Admin Portal') &&
      !citizenShellSource.includes('onOpenAdmin') &&
      !appSource.includes('onOpenAdmin='),
    'Authenticated Citizen Portal removes Admin Portal buttons and mobile switch menus completely'
  );
  assert(
    !adminDashboardSource.includes('Citizen Portal') &&
      !adminDashboardSource.includes('onSwitchToCitizenApp') &&
      !appSource.includes('onSwitchToCitizenApp'),
    'Authenticated Admin Portal removes Citizen Portal switching button and prop completely'
  );
  assert(
    appSource.includes('if (isAuthChecking || isAdminVerifying || !adminUser)'),
    'App.tsx strictly gates AdminDashboard behind !isAuthChecking && !isAdminVerifying && adminUser'
  );
}

// Execute tests
async function run() {
  await testAdminVerificationSecurity();
  testStatsCalculation();
  testCitizenSummaries();
  testSixCanonicalStatuses();
  await testAdminUpdateAndRulesGuards();
  await testAdminLoginFlowsAndProvisioning();
  await testPhase1FoundationsAndSafeguards();
  await testPhase3DashboardAndAuditLogs();
  await testPhase4Step2DepartmentAlignment();
  await testPhase4Step5AdminFixes();
  await testSingleApprovedAdminEmailAllowlist();
  await testAdminUpdateStatusAndAssignmentRegression();
  await testPortalIsolationAndRbacRouting();

  if (passedTests !== totalTests) {
    console.error(`\n${totalTests - passedTests} / ${totalTests} Admin Authorization & Stats test cases FAILED!`);
    process.exit(1);
  }
  console.log(`\nAll ${passedTests} / ${totalTests} Admin Authorization & Stats test cases passed successfully!`);
  process.exit(0);
}

run().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
