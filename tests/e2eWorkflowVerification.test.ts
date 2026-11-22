/**
 * End-to-End Application Workflow Verification Regression Suite (Local / Mocked)
 *
 * NOTE: This suite runs locally with mocked Firestore/Auth/Storage dependencies to verify
 * real service wiring, state transitions, role enforcement, payload parity, and fixes
 * discovered during the E2E workflow audit. Real Firebase Emulator security rules tests
 * live in tests/firebaseEmulatorSecurityRules.test.ts and run via GitHub Actions.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  mapFirebaseUserToCitizenUser,
  saveUserProfileToFirestore,
  updateCitizenUserProfile,
  onCitizenAuthStateChanged,
  cacheCitizenProfile,
} from '../src/services/authService';
import { extractDataUrlImageMetadata } from '../src/lib/firebase';
import {
  retryReportUpload,
  withdrawReportInFirestore,
  normalizeOptionalReportTimestamp,
  saveLocalCachedReports,
} from '../src/services/reportStorage';
import {
  mapFirestoreDocToReport,
  updateReportStatusByAdmin,
  archiveReportByAdmin,
} from '../src/services/adminService';
import {
  ADMIN_ROLE_CAPABILITIES,
  AdminUser,
  CitizenUser,
  CivicIssueReport,
} from '../src/types/civic';

// Minimal in-memory localStorage mock for Node test execution
const storageMap = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => (storageMap.has(key) ? storageMap.get(key)! : null),
  setItem: (key: string, value: string) => storageMap.set(key, String(value)),
  removeItem: (key: string) => storageMap.delete(key),
  clear: () => storageMap.clear(),
};

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

async function runTests() {
  console.log('\n=== CIVIFIX AI END-TO-END WORKFLOW VERIFICATION REGRESSION SUITE ===\n');

  // ---------------------------------------------------------------------------
  // 1. Citizen Profile Persistence, Avatar Clearing & Firestore Error Propagation
  // ---------------------------------------------------------------------------
  console.log('1. Citizen Auth Profile Persistence & Error Propagation:');

  const baseCitizen: CitizenUser = {
    id: 'citizen_e2e_01',
    fullName: 'Asha Menon',
    email: 'asha.menon@example.com',
    emailVerified: true,
    authProvider: 'password',
    phone: '9876543210',
    ward: 'Ward 74 - Indiranagar East',
    city: 'Metropolitan Civic District',
    reportsCount: 0,
    resolvedCount: 0,
    notificationPreferences: {
      smsAlerts: true,
      pushNotifications: true,
      emailUpdates: true,
    },
    avatarUrl: 'https://example.com/old-avatar.jpg',
    avatarColor: 'emerald',
    preferredLanguage: 'English',
  };

  let writtenUserPayload: Record<string, any> | null = null as Record<string, any> | null;
  let authProfileSyncPayload: { displayName?: string; photoURL?: string } | null = null as {
    displayName?: string;
    photoURL?: string;
  } | null;

  const updatedWithNewAvatar = await updateCitizenUserProfile(
    baseCitizen,
    {
      fullName: 'Asha K. Menon',
      ward: 'Ward 111 - MG Road Central',
      avatarUrl: 'https://example.com/new-avatar.png',
    },
    {
      dbInstance: { __mock: true },
      currentAuthUid: baseCitizen.id,
      docFn: (_db: any, col: string, id: string) => ({ path: `${col}/${id}` }),
      setDocFn: async (_ref: any, data: any) => {
        writtenUserPayload = data;
      },
      updateAuthProfileFn: async (profile) => {
        authProfileSyncPayload = profile;
      },
    }
  );

  assert(
    writtenUserPayload !== null &&
      writtenUserPayload.avatarUrl === 'https://example.com/new-avatar.png' &&
      writtenUserPayload.ward === 'Ward 111 - MG Road Central',
    'updateCitizenUserProfile persists avatarUrl and ward to Firestore /users/{uid}'
  );
  assert(
    authProfileSyncPayload?.displayName === 'Asha K. Menon' &&
      authProfileSyncPayload?.photoURL === 'https://example.com/new-avatar.png',
    'updateCitizenUserProfile syncs displayName and photoURL to Firebase Auth profile'
  );
  assert(
    updatedWithNewAvatar.avatarUrl === 'https://example.com/new-avatar.png',
    'updateCitizenUserProfile returns updated CitizenUser with new avatarUrl'
  );

  // Clearing custom avatar URL must clear both Firestore (null) and Auth ('')
  writtenUserPayload = null as Record<string, any> | null;
  authProfileSyncPayload = null as { displayName?: string; photoURL?: string } | null;
  const clearedAvatarUser = await updateCitizenUserProfile(
    updatedWithNewAvatar,
    { avatarUrl: '' },
    {
      dbInstance: { __mock: true },
      currentAuthUid: baseCitizen.id,
      docFn: (_db: any, col: string, id: string) => ({ path: `${col}/${id}` }),
      setDocFn: async (_ref: any, data: any) => {
        writtenUserPayload = data;
      },
      updateAuthProfileFn: async (profile) => {
        authProfileSyncPayload = profile;
      },
    }
  );

  assert(
    clearedAvatarUser.avatarUrl === undefined &&
      writtenUserPayload?.avatarUrl === null &&
      authProfileSyncPayload?.photoURL === '',
    'Clearing avatarUrl writes null to Firestore and clears CitizenUser.avatarUrl'
  );

  // Hydrating cleared avatarUrl: null from Firestore must NOT resurrect stale cached/Google avatar
  cacheCitizenProfile({ ...baseCitizen, avatarUrl: 'https://stale.example.com/old.jpg' });
  const hydratedAfterClear = mapFirebaseUserToCitizenUser(
    {
      uid: baseCitizen.id,
      email: baseCitizen.email,
      displayName: baseCitizen.fullName,
      photoURL: 'https://stale-google.example.com/photo.jpg',
      emailVerified: true,
      providerData: [{ providerId: 'google.com' }],
    } as any,
    { avatarUrl: null as any, ward: 'Ward 111 - MG Road Central' }
  );
  assert(
    hydratedAfterClear.avatarUrl === undefined &&
      hydratedAfterClear.ward === 'Ward 111 - MG Road Central',
    'Firestore hydration respects explicit cleared avatarUrl (null) without reverting to stale URL'
  );

  // Firestore write failure during updateCitizenUserProfile MUST throw and avoid polluting cache
  storageMap.clear();
  cacheCitizenProfile(baseCitizen);
  let threwOnFirestoreFailure = false;
  try {
    await updateCitizenUserProfile(
      baseCitizen,
      { ward: 'Ward 99 - Should Not Cache' },
      {
        dbInstance: { __mock: true },
        currentAuthUid: baseCitizen.id,
        docFn: (_db: any, col: string, id: string) => ({ path: `${col}/${id}` }),
        setDocFn: async () => {
          throw new Error('permission-denied');
        },
      }
    );
  } catch (err: any) {
    threwOnFirestoreFailure = err?.message === 'permission-denied';
  }
  const cachedAfterFailedUpdate = JSON.parse(
    storageMap.get(`civifix_citizen_profile_${baseCitizen.id}`) || '{}'
  );
  assert(
    threwOnFirestoreFailure && cachedAfterFailedUpdate.ward === baseCitizen.ward,
    'updateCitizenUserProfile throws on Firestore failure and leaves localStorage cache unmodified'
  );

  // Best-effort saveUserProfileToFirestore still catches errors when throwOnError is not set
  let bestEffortThrew = false;
  try {
    await saveUserProfileToFirestore(baseCitizen, undefined, {
      dbInstance: { __mock: true },
      currentAuthUid: baseCitizen.id,
      docFn: (_db: any, col: string, id: string) => ({ path: `${col}/${id}` }),
      setDocFn: async () => {
        throw new Error('unavailable');
      },
    });
  } catch {
    bestEffortThrew = true;
  }
  assert(
    !bestEffortThrew,
    'Best-effort saveUserProfileToFirestore does not throw during login/registration when offline'
  );

  // Oversized avatarUrl (> 2000 chars per firestore.rules) is rejected cleanly
  let rejectedOversizedAvatar = false;
  try {
    await updateCitizenUserProfile(
      baseCitizen,
      { avatarUrl: `https://example.com/${'a'.repeat(2050)}` },
      {
        dbInstance: { __mock: true },
        currentAuthUid: baseCitizen.id,
        docFn: (_db: any, col: string, id: string) => ({ path: `${col}/${id}` }),
        setDocFn: async () => {},
      }
    );
  } catch (err: any) {
    rejectedOversizedAvatar = /too long/i.test(err?.message || '');
  }
  assert(
    rejectedOversizedAvatar,
    'Oversized avatarUrl (> 2000 chars) is rejected before hitting Firestore rules'
  );

  // Re-login / session hydration sequence via onCitizenAuthStateChanged
  let authListener: ((u: any) => void) | null = null;
  const authEvents: Array<CitizenUser | null> = [];
  const unsubAuth = onCitizenAuthStateChanged(
    (user) => authEvents.push(user),
    {
      subscribeAuthFn: (listener) => {
        authListener = listener;
        return () => {};
      },
      loadUserProfileFn: async () => ({
        ward: 'Ward 82 - Jayanagar',
        avatarUrl: 'https://example.com/synced-avatar.png',
      }),
      getCurrentAuthUidFn: () => baseCitizen.id,
    }
  );
  authListener!({
    uid: baseCitizen.id,
    email: baseCitizen.email,
    displayName: baseCitizen.fullName,
    emailVerified: true,
    providerData: [{ providerId: 'password' }],
  });
  await new Promise((r) => setTimeout(r, 20));
  unsubAuth();
  assert(
    authEvents.length === 2 &&
      authEvents[1]?.ward === 'Ward 82 - Jayanagar' &&
      authEvents[1]?.avatarUrl === 'https://example.com/synced-avatar.png',
    'Re-login / refresh hydrates ward and avatarUrl from Firestore /users/{uid}'
  );

  // ---------------------------------------------------------------------------
  // 2. Sign-Out Error Handling & Storage Metadata Invariants
  // ---------------------------------------------------------------------------
  console.log('\n2. Sign-Out Error Handling & Firebase Storage Metadata:');

  const appSrc = fs.readFileSync(path.resolve('src/App.tsx'), 'utf8');
  const signOutIdx = appSrc.indexOf('await signOutCitizen();');
  const clearWithdrawalsIdx = appSrc.indexOf('clearPendingWithdrawals(signingOutUid);');
  const handleSignOutBlock = appSrc.slice(
    appSrc.indexOf('const handleSignOut = async () => {'),
    appSrc.indexOf('// Report Creation Handler')
  );
  assert(
    signOutIdx > 0 &&
      clearWithdrawalsIdx > signOutIdx &&
      handleSignOutBlock.includes('throw err;'),
    'App.tsx handleSignOut awaits signOutCitizen() before clearing local queues and re-throws errors'
  );

  const jpegMeta = extractDataUrlImageMetadata('data:image/jpeg;base64,/9j/4AAQ');
  const pngMeta = extractDataUrlImageMetadata('data:image/png;base64,iVBORw0KGgo=');
  const webpMeta = extractDataUrlImageMetadata('data:image/webp;base64,UklGRh4=');
  const fallbackMeta = extractDataUrlImageMetadata('data:application/octet-stream;base64,AAAA');
  assert(
    jpegMeta.contentType === 'image/jpeg' &&
      jpegMeta.extension === 'jpg' &&
      pngMeta.contentType === 'image/png' &&
      pngMeta.extension === 'png' &&
      webpMeta.contentType === 'image/webp' &&
      webpMeta.extension === 'webp' &&
      fallbackMeta.contentType === 'image/jpeg' &&
      fallbackMeta.extension === 'jpg',
    'extractDataUrlImageMetadata derives storage.rules-compliant image/* contentType and file extensions'
  );

  const firebaseSrc = fs.readFileSync(path.resolve('src/lib/firebase.ts'), 'utf8');
  assert(
    firebaseSrc.includes("await uploadString(storageRef, dataUrlOrBase64, 'data_url', { contentType })") &&
      firebaseSrc.includes('`reports/${uid}/${reportId}/evidence_${Date.now()}.${extension}`') &&
      firebaseSrc.includes('`resolutions/${reportId}/resolution_${Date.now()}.${extension}`'),
    'firebase.ts passes explicit { contentType } metadata to Storage uploads under rules-matched paths'
  );

  // ---------------------------------------------------------------------------
  // 3. Full Complaint Lifecycle Chain (Submit -> Admin Map -> Assign -> Resolve -> Archive)
  // ---------------------------------------------------------------------------
  console.log('\n3. End-to-End Complaint Lifecycle (Mocked Firestore & Storage):');

  storageMap.clear();
  const mockCloudDb = new Map<string, Record<string, any>>();
  const mockStatusHistory: Array<Record<string, any>> = [];
  const mockAuditLogs: Array<Record<string, any>> = [];

  const pendingReport: CivicIssueReport = {
    id: 'rep_e2e_lifecycle_1',
    trackingNumber: 'CFX-2026-9901',
    category: 'Pothole',
    normalizedCategory: 'Potholes',
    title: 'Deep pothole near main bus stop',
    description: 'Large water-filled pothole creating hazard for two-wheelers on 100ft Road.',
    photoUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAA==',
    location: {
      address: '100 Feet Road, Indiranagar',
      landmark: 'Near Metro Pillar 42',
      latitude: 12.9784,
      longitude: 77.6408,
      ward: 'Ward 74 - Indiranagar East',
    },
    severity: 'High',
    status: 'Submitted',
    submittedAt: '2026-11-20T09:00:00.000Z',
    updatedAt: '2026-11-20T09:00:00.000Z',
    department: 'Public Works & Road Infrastructure',
    slaDeadline: '24 Hours SLA',
    timeline: [
      {
        status: 'Submitted',
        timestamp: '2026-11-20T09:00:00.000Z',
        note: 'Report registered by citizen.',
        officer: 'System',
      },
    ],
    citizenNotes: [],
    citizenName: baseCitizen.fullName,
    citizenEmail: baseCitizen.email,
    userId: baseCitizen.id,
    isDemo: false,
    syncedToCloud: false,
    storageSource: 'local_fallback',
  };
  saveLocalCachedReports(baseCitizen.id, [pendingReport]);

  // Step A: Sync report + upload evidence image to Storage -> Cloud Firestore
  const syncResult = await retryReportUpload(pendingReport, baseCitizen, {
    isConfigured: true,
    dbInstance: { __mock: true },
    currentUser: {
      uid: baseCitizen.id,
      email: baseCitizen.email,
      displayName: baseCitizen.fullName,
    },
    docFn: (_db: any, ...segs: string[]) => ({ path: segs.join('/'), id: segs[segs.length - 1] }),
    collectionFn: (_db: any, ...segs: string[]) => ({ path: segs.join('/') }),
    queryFn: (colRef: any) => colRef,
    whereFn: () => ({}),
    limitFn: () => ({}),
    getDocFn: async (ref: any) => ({
      exists: () => mockCloudDb.has(ref.path),
      data: () => mockCloudDb.get(ref.path),
    }),
    getDocsFn: async () => ({ empty: true, size: 0 }),
    uploadPhotoFn: async (reportId: string, _dataUrl: string, ownerUid?: string) => ({
      success: true,
      url: `https://firebasestorage.googleapis.com/v0/b/civifix-ai-214ec/o/reports%2F${ownerUid || 'unknown'}%2F${reportId}%2Fevidence.jpg`,
    }),
    setDocFn: async (ref: any, data: any) => {
      mockCloudDb.set(ref.path, { ...data });
    },
    statusHistorySetDocFn: async (_ref: any, data: any) => {
      mockStatusHistory.push(data);
    },
    auditLogSetDocFn: async (_ref: any, data: any) => {
      mockAuditLogs.push(data);
    },
  });

  const savedDoc = mockCloudDb.get(`civic_reports/${pendingReport.id}`);
  assert(
    syncResult.success &&
      savedDoc !== undefined &&
      savedDoc.photoUrl.startsWith('https://firebasestorage.googleapis.com/') &&
      savedDoc.location.latitude === 12.9784 &&
      mockStatusHistory.length === 1 &&
      mockAuditLogs.length === 1,
    'Citizen submission uploads photo to Storage and persists report + initial history/audit in Firestore'
  );

  // Step B: Admin dashboard maps the exact Firestore document
  const adminMappedReport = mapFirestoreDocToReport(pendingReport.id, savedDoc!);
  assert(
    adminMappedReport.id === pendingReport.id &&
      adminMappedReport.location.latitude === 12.9784 &&
      adminMappedReport.photoUrl === savedDoc!.photoUrl &&
      adminMappedReport.status === 'Submitted',
    'Admin mapFirestoreDocToReport faithfully maps submitted citizen report and GPS location'
  );

  // Step C: Role permissions — staff cannot assign departments or archive;
  // ward_admin can assign departments but cannot archive; department_head can do both
  const staffAdmin: AdminUser = {
    uid: 'staff_uid_01',
    email: 'staff@municipality.gov',
    displayName: 'Field Inspector Ravi',
    role: 'staff',
    department: 'Public Works & Road Infrastructure',
  };
  const wardAdmin: AdminUser = {
    uid: 'ward_admin_uid_01',
    email: 'wardadmin@municipality.gov',
    displayName: 'Ward Officer Priya',
    role: 'ward_admin',
    department: 'Public Works & Road Infrastructure',
  };
  const deptHeadAdmin: AdminUser = {
    uid: 'dept_head_uid_01',
    email: 'depthead@municipality.gov',
    displayName: 'Director Kavita',
    role: 'department_head',
    department: 'Public Works & Road Infrastructure',
  };

  assert(
    ADMIN_ROLE_CAPABILITIES[staffAdmin.role].canAssignDepartment === false &&
      ADMIN_ROLE_CAPABILITIES[staffAdmin.role].canArchiveReports === false &&
      ADMIN_ROLE_CAPABILITIES[wardAdmin.role].canAssignDepartment === true &&
      ADMIN_ROLE_CAPABILITIES[wardAdmin.role].canArchiveReports === false &&
      ADMIN_ROLE_CAPABILITIES[deptHeadAdmin.role].canAssignDepartment === true &&
      ADMIN_ROLE_CAPABILITIES[deptHeadAdmin.role].canArchiveReports === true,
    'Role capabilities enforce staff, ward_admin, and department_head assignment & archive permissions'
  );

  // Shared mocked Firestore/Storage deps for admin operations
  const makeAdminDeps = (actingAdmin: AdminUser) => ({
    isConfigured: true,
    dbInstance: { __mock: true } as any,
    currentUser: { uid: actingAdmin.uid, email: actingAdmin.email } as any,
    verifyAdminFn: async () => ({
      authorized: true,
      admin: actingAdmin,
    }),
    docFn: ((first: any, ...segs: string[]) => {
      if (segs.length === 0 && first && typeof first.path === 'string') {
        const autoId = `auto_${Date.now()}`;
        return { path: `${first.path}/${autoId}`, id: autoId };
      }
      return {
        path: segs.join('/'),
        id: segs[segs.length - 1],
      };
    }) as any,
    getDocFn: (async (ref: any) => ({
      exists: () => mockCloudDb.has(ref.path),
      data: () => mockCloudDb.get(ref.path),
    })) as any,
    collectionFn: ((_db: any, ...segs: string[]) => ({ path: segs.join('/') })) as any,
    runTransactionFn: (async (_db: any, fn: (tx: any) => Promise<any>) => {
      const tx = {
        get: async (ref: any) => ({
          exists: () => mockCloudDb.has(ref.path),
          data: () => mockCloudDb.get(ref.path),
        }),
        update: (ref: any, updates: Record<string, any>) => {
          const prev = mockCloudDb.get(ref.path) || {};
          mockCloudDb.set(ref.path, { ...prev, ...updates });
        },
        set: (ref: any, data: Record<string, any>) => {
          mockCloudDb.set(ref.path, { ...data });
          if (ref.path.startsWith('auditLogs/')) {
            mockAuditLogs.push(data);
          }
        },
      };
      return fn(tx);
    }) as any,
    addDocFn: (async (colRef: any, data: any) => {
      if (colRef.path.includes('statusHistory')) mockStatusHistory.push(data);
      if (colRef.path.includes('auditLogs')) mockAuditLogs.push(data);
      return { id: `auto_${Date.now()}` };
    }) as any,
    serverTimestampFn: (() => new Date().toISOString()) as any,
    uploadResolutionFn: async (reportId: string) => ({
      success: true,
      url: `https://firebasestorage.googleapis.com/v0/b/civifix-ai-214ec/o/resolutions%2F${reportId}%2Fresolution.jpg`,
    }),
  });

  const staffDeptAttempt = await updateReportStatusByAdmin(
    pendingReport.id,
    {
      status: 'Under Review',
      assignedDepartment: 'Water Supply & Drainage',
    },
    makeAdminDeps(staffAdmin)
  );
  assert(
    !staffDeptAttempt.success && /permission|department/i.test(staffDeptAttempt.error || ''),
    'Staff attempting department reassignment is blocked by adminService'
  );

  // Step D: Ward admin assigns department & officer, then staff resolves with photo + remarks
  const assignRes = await updateReportStatusByAdmin(
    pendingReport.id,
    {
      status: 'Under Review',
      assignedDepartment: 'Public Works & Road Infrastructure',
      assignedOfficer: 'Field Inspector Ravi',
      adminRemarks: 'Assigned for immediate pothole patching.',
    },
    makeAdminDeps(wardAdmin)
  );
  assert(
    assignRes.success &&
      mockCloudDb.get(`civic_reports/${pendingReport.id}`)?.assignedOfficer === 'Field Inspector Ravi' &&
      mockCloudDb.get(`civic_reports/${pendingReport.id}`)?.status === 'Under Review',
    'Ward admin moves report to Under Review with department, officer, and remarks'
  );

  // Staff progresses Under Review -> In Progress -> Resolved with resolution photo & details
  const inProgressRes = await updateReportStatusByAdmin(
    pendingReport.id,
    {
      status: 'In Progress',
      adminRemarks: 'Crew arrived on site with cold-mix asphalt.',
    },
    makeAdminDeps(staffAdmin)
  );
  const resolvedRes = await updateReportStatusByAdmin(
    pendingReport.id,
    {
      status: 'Resolved',
      adminRemarks: 'Pothole compacted and road reopened safely.',
      resolutionDetails: 'Filled 1.2m pothole with bitumen mix and levelled road surface.',
      resolutionPhotoUrl: 'data:image/jpeg;base64,/9j/RESOLVED_PHOTO',
    },
    makeAdminDeps(staffAdmin)
  );

  const resolvedCloudDoc = mockCloudDb.get(`civic_reports/${pendingReport.id}`)!;
  assert(
    inProgressRes.success &&
      resolvedRes.success &&
      resolvedCloudDoc.status === 'Resolved' &&
      resolvedCloudDoc.resolutionPhotoUrl.startsWith('https://firebasestorage.googleapis.com/') &&
      resolvedCloudDoc.resolutionDetails.includes('bitumen mix') &&
      Boolean(resolvedCloudDoc.resolvedAt),
    'Staff progresses report to Resolved with uploaded resolution photo, details, and resolvedAt timestamp'
  );

  // Step E: Citizen visibility of updated report + Timestamp normalization safety
  const normalizedTimestampFromFirestoreObj = normalizeOptionalReportTimestamp({
    seconds: 1795100000,
    nanoseconds: 0,
  });
  assert(
    typeof normalizedTimestampFromFirestoreObj === 'string' &&
      normalizedTimestampFromFirestoreObj.includes('T') &&
      normalizedTimestampFromFirestoreObj.endsWith('Z'),
    'normalizeOptionalReportTimestamp converts Firestore Timestamp objects to ISO strings safely'
  );

  // Step F: Staff & ward_admin cannot archive; department_head archives atomically; citizen cannot withdraw archived report
  const staffArchiveRes = await archiveReportByAdmin(
    pendingReport.id,
    'Duplicate test',
    makeAdminDeps(staffAdmin)
  );
  const wardArchiveRes = await archiveReportByAdmin(
    pendingReport.id,
    'Ward archive test',
    makeAdminDeps(wardAdmin)
  );
  assert(
    !staffArchiveRes.success && !wardArchiveRes.success,
    'Staff and ward_admin roles are denied from archiving complaints'
  );

  const deptHeadArchiveRes = await archiveReportByAdmin(
    pendingReport.id,
    'Completed and closed after verification.',
    makeAdminDeps(deptHeadAdmin)
  );
  const archivedDoc = mockCloudDb.get(`civic_reports/${pendingReport.id}`)!;
  assert(
    deptHeadArchiveRes.success &&
      archivedDoc.archived === true &&
      archivedDoc.archiveReason === 'Completed and closed after verification.' &&
      mockAuditLogs.some((log) => log.action === 'report_archived' && log.targetId === pendingReport.id),
    'Department head atomically archives complaint with archive metadata and audit log'
  );

  const withdrawArchivedRes = await withdrawReportInFirestore(
    pendingReport.id,
    baseCitizen,
    mapFirestoreDocToReport(pendingReport.id, archivedDoc),
    'Trying to withdraw archived report',
    {
      dbInstance: { __mock: true },
      currentUser: { uid: baseCitizen.id, email: baseCitizen.email },
      docFn: (_db: any, ...segs: string[]) => ({ path: segs.join('/'), id: segs[segs.length - 1] }),
    }
  );
  assert(
    !withdrawArchivedRes.success && /archived/i.test(withdrawArchivedRes.error || ''),
    'Citizen withdrawal is rejected when parent complaint is archived'
  );

  console.log(`\n=== SUMMARY: ${passedTests}/${totalTests} PASSED ===`);
  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Unhandled error in E2E workflow verification test suite:', err);
  process.exit(1);
});
