/**
 * Functional Audit Regression Test Suite
 *
 * Verifies fixes from the comprehensive functional audit:
 * 1. Archived complaint lockout for citizen notes, withdrawals, and offline sync replay
 * 2. Sanitized localStorage/device error messages and tracking-number sync feedback
 * 3. Archived complaint exclusion from map plotting and duplicate detection
 * 4. Admin role capability enforcement (`staff` cannot reassign departments, supervisors can)
 * 5. Concurrent archival conflict detection in `reconcileAdminModalFormState`
 * 6. Citizen & Admin UI regression checks (archived lockouts, mobile Archive button,
 *    read-only email + preference rollbacks, and removal of technical/developer jargon)
 */

import fs from 'node:fs';
import path from 'node:path';
import { CivicIssueReport, CitizenUser } from '../src/types/civic';
import {
  addCitizenNoteToFirestore,
  enqueuePendingWithdrawalIntent,
  getLocalCachedReports,
  filterReportsForCitizen,
  getPendingSyncCounts,
  getPendingWithdrawals,
  saveLocalCachedReports,
  savePendingWithdrawals,
  syncPendingReportsToFirestore,
  withdrawReportInFirestore,
} from '../src/services/reportStorage';
import {
  reconcileAdminModalFormState,
  updateReportStatusByAdmin,
} from '../src/services/adminService';
import {
  findDuplicateCandidates,
  partitionReportsByLocation,
} from '../src/utils/reportLocations';
import { containsTechnicalJargon } from '../src/utils/userFriendlyErrors';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  public throwOnSet = false;
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    if (this.throwOnSet) {
      throw new Error('QuotaExceededError: localStorage full');
    }
    this.store.set(key, String(value));
  }
}

function makeReport(overrides: Partial<CivicIssueReport> = {}): CivicIssueReport {
  return {
    id: 'rep-audit-1',
    trackingNumber: 'CFX-2026-9101',
    userId: 'citizen-audit-1',
    citizenName: 'Meera Nair',
    title: 'Broken curb drain near Lake Road',
    category: 'Drainage',
    normalizedCategory: 'Drainage problems',
    photoUrl: '',
    description: 'Stormwater drain grate is broken and posing a hazard to pedestrians.',
    location: {
      address: '14 Lake Road, Ward 12',
      ward: 'Ward 12',
      latitude: 12.9716,
      longitude: 77.5946,
    },
    severity: 'High',
    status: 'Submitted',
    submittedAt: '2026-04-10T09:00:00.000Z',
    updatedAt: '2026-04-10T09:00:00.000Z',
    slaDeadline: '2026-04-17T09:00:00.000Z',
    assignedDepartment: 'Drainage & Sewerage',
    department: 'Drainage & Sewerage',
    timeline: [
      {
        status: 'Submitted',
        timestamp: '2026-04-10T09:00:00.000Z',
        note: 'Complaint submitted by citizen.',
        officer: 'Citizen',
      },
    ],
    syncedToCloud: true,
    ...overrides,
  };
}

const citizenUser: CitizenUser = {
  id: 'citizen-audit-1',
  fullName: 'Meera Nair',
  email: 'meera@example.com',
  phone: '+91 9876543210',
  ward: 'Ward 12',
  city: 'Metropolitan Civic District',
  reportsCount: 1,
  resolvedCount: 0,
  notificationPreferences: {
    smsAlerts: true,
    pushNotifications: true,
    emailUpdates: true,
  },
};

async function run() {
  console.log('\n=== Functional Audit Regression Tests ===\n');

  const memStorage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    value: memStorage,
    configurable: true,
    writable: true,
  });

  // -------------------------------------------------------------------------
  // 1. Citizen actions blocked on archived complaints
  // -------------------------------------------------------------------------
  console.log('1. Citizen actions blocked on archived complaints');
  const archivedReport = makeReport({
    id: 'rep-archived-1',
    trackingNumber: 'CFX-2026-9102',
    status: 'Submitted',
    archived: true,
    archivedAt: '2026-04-12T10:00:00.000Z',
  });
  saveLocalCachedReports(citizenUser.id, [archivedReport]);

  let noteWriteCalled = false;
  const archivedNoteRes = await addCitizenNoteToFirestore(
    archivedReport.id,
    'Checking whether this drain is still open',
    citizenUser.id,
    {
      dbInstance: {} as any,
      currentUser: { uid: citizenUser.id },
      isOnline: true,
      updateDocFn: async () => {
        noteWriteCalled = true;
      },
    }
  );
  assert(
    archivedNoteRes.success === false &&
      archivedNoteRes.isPendingSync !== true &&
      !noteWriteCalled &&
      (archivedNoteRes.error || '').toLowerCase().includes('archived'),
    'addCitizenNoteToFirestore rejects archived complaints online without calling updateDoc'
  );

  const archivedNoteOfflineRes = await addCitizenNoteToFirestore(
    archivedReport.id,
    'Offline follow-up attempt on archived report',
    citizenUser.id,
    {
      dbInstance: null,
      currentUser: null,
      isOnline: false,
    }
  );
  const pendingCountsAfterArchivedNote = getPendingSyncCounts(citizenUser.id, [archivedReport]);
  const cachedAfterArchivedNote = getLocalCachedReports(citizenUser.id).find(
    (r) => r.id === archivedReport.id
  );
  assert(
    archivedNoteOfflineRes.success === false &&
      archivedNoteOfflineRes.isPendingSync !== true &&
      pendingCountsAfterArchivedNote.pendingNotes === 0 &&
      (!cachedAfterArchivedNote?.citizenNotes || cachedAfterArchivedNote.citizenNotes.length === 0),
    'addCitizenNoteToFirestore rejects archived complaints offline without mutating cache or queueing retry'
  );

  enqueuePendingWithdrawalIntent({
    reportId: archivedReport.id,
    userId: citizenUser.id,
    requestedAt: '2026-04-11T10:00:00.000Z',
  });
  let withdrawWriteCalled = false;
  const archivedWithdrawRes = await withdrawReportInFirestore(
    archivedReport.id,
    citizenUser,
    archivedReport,
    'Accidental submission',
    {
      isConfigured: true,
      dbInstance: {} as any,
      currentUser: { uid: citizenUser.id, email: citizenUser.email },
      isOnline: true,
      updateDocFn: async () => {
        withdrawWriteCalled = true;
      },
    }
  );
  assert(
    archivedWithdrawRes.success === false &&
      archivedWithdrawRes.isPermanentRejection === true &&
      !withdrawWriteCalled &&
      getPendingWithdrawals(citizenUser.id).length === 0 &&
      (archivedWithdrawRes.error || '').toLowerCase().includes('archived'),
    'withdrawReportInFirestore permanently rejects archived complaints and clears stale pending withdrawal intents'
  );

  // -------------------------------------------------------------------------
  // 2. Offline sync replay drops archived / permission-denied intents & sanitizes errors
  // -------------------------------------------------------------------------
  console.log('\n2. Offline sync replay & sanitized localStorage errors');
  memStorage.clear();
  const activeBeforeArchive = makeReport({
    id: 'rep-archived-1',
    trackingNumber: 'CFX-2026-9102',
    status: 'Submitted',
    archived: false,
  });
  const activeWithPermDenied = makeReport({
    id: 'rep-perm-1',
    trackingNumber: 'CFX-2026-9103',
    status: 'Submitted',
    archived: false,
  });
  saveLocalCachedReports(citizenUser.id, [activeBeforeArchive, activeWithPermDenied]);
  // Queue notes offline while reports were active, then simulate rep-archived-1 being archived before sync
  await addCitizenNoteToFirestore(
    activeBeforeArchive.id,
    'Stale note queued before archive',
    citizenUser.id,
    { dbInstance: null, currentUser: null, isOnline: false }
  );
  await addCitizenNoteToFirestore(
    activeWithPermDenied.id,
    'Note that will hit permission-denied',
    citizenUser.id,
    { dbInstance: null, currentUser: null, isOnline: false }
  );
  saveLocalCachedReports(citizenUser.id, [archivedReport, activeWithPermDenied]);
  enqueuePendingWithdrawalIntent({
    reportId: archivedReport.id,
    userId: citizenUser.id,
    requestedAt: '2026-04-12T08:00:00.000Z',
  });

  const syncRes = await syncPendingReportsToFirestore(citizenUser.id, {
    isConfigured: true,
    hasDb: true,
    hasAuthUser: true,
    currentAuthUid: citizenUser.id,
    syncPendingNoteFn: async () => {
      const err: any = new Error('Missing or insufficient permissions.');
      err.code = 'permission-denied';
      throw err;
    },
    getLatestReportFn: async (id) => (id === archivedReport.id ? archivedReport : activeWithPermDenied),
  });

  const countsAfterSync = getPendingSyncCounts(citizenUser.id, [archivedReport, activeWithPermDenied]);
  assert(
    countsAfterSync.pendingNotes === 0,
    'syncPendingReportsToFirestore drops pending notes for archived and permission-denied reports'
  );
  assert(
    getPendingWithdrawals(citizenUser.id).length === 0,
    'syncPendingReportsToFirestore drops stale pending withdrawal intents for archived reports'
  );
  assert(
    syncRes.errors.every((e) => !containsTechnicalJargon(e)) &&
      syncRes.errors.some((e) => e.includes('CFX-2026-9102')),
    'syncPendingReportsToFirestore uses tracking numbers and avoids technical jargon in user errors'
  );

  memStorage.throwOnSet = true;
  const quotaSaveRes = savePendingWithdrawals(citizenUser.id, [
    {
      reportId: 'rep-quota-1',
      userId: citizenUser.id,
      requestedAt: '2026-04-12T09:00:00.000Z',
    },
  ]);
  memStorage.throwOnSet = false;
  assert(
    quotaSaveRes.success === false && !containsTechnicalJargon(quotaSaveRes.error),
    'savePendingWithdrawals sanitizes QuotaExceededError / localStorage errors'
  );

  // -------------------------------------------------------------------------
  // 3. Map partition & duplicate detection exclude archived complaints
  // -------------------------------------------------------------------------
  console.log('\n3. Map partition & duplicate detection exclude archived complaints');
  const activeRoadReport = makeReport({
    id: 'rep-active-map',
    trackingNumber: 'CFX-2026-9110',
    status: 'Submitted',
    archived: false,
  });
  const archivedSameSpot = makeReport({
    id: 'rep-archived-map',
    trackingNumber: 'CFX-2026-9111',
    status: 'Submitted',
    archived: true,
  });
  const partitioned = partitionReportsByLocation([activeRoadReport, archivedSameSpot]);
  assert(
    partitioned.activeReports.length === 1 &&
      partitioned.activePlottedReports.length === 1 &&
      partitioned.excludedInactiveReports.length === 1 &&
      partitioned.excludedInactiveReports[0].id === archivedSameSpot.id,
    'partitionReportsByLocation excludes archived complaints from active map markers'
  );

  const dupCandidates = findDuplicateCandidates(activeRoadReport, [
    activeRoadReport,
    archivedSameSpot,
  ]);
  assert(
    dupCandidates.length === 0,
    'findDuplicateCandidates excludes archived complaints'
  );

  // -------------------------------------------------------------------------
  // 4. Admin role capability enforcement on department reassignment
  // -------------------------------------------------------------------------
  console.log('\n4. Admin role capability enforcement (`canAssignDepartment`)');
  let staffDeptTxWrites = 0;
  const staffDeptAttempt = await updateReportStatusByAdmin(
    activeRoadReport.id,
    {
      status: 'Under Review',
      assignedDepartment: 'Road Maintenance',
      adminRemarks: 'Trying to move department as staff',
    },
    {
      dbInstance: {} as any,
      currentUser: { uid: 'staff-uid', email: 'staff@municipality.gov' } as any,
      verifyAdminFn: async () => ({
        authorized: true,
        admin: {
          uid: 'staff-uid',
          email: 'staff@municipality.gov',
          role: 'staff',
          active: true,
        },
      }),
      docFn: ((_d: any, _c: string, id: string) => ({ id })) as any,
      collectionFn: ((_d: any, ...segs: string[]) => ({ path: segs.join('/') })) as any,
      runTransactionFn: (async (_d: any, fn: any) =>
        fn({
          get: async () => ({
            exists: () => true,
            data: () => ({ ...activeRoadReport }),
          }),
          update: () => {
            staffDeptTxWrites++;
          },
          set: () => {
            staffDeptTxWrites++;
          },
        })) as any,
      addDocFn: (async () => ({ id: 'audit-1' })) as any,
    }
  );
  assert(
    staffDeptAttempt.success === false &&
      staffDeptTxWrites === 0 &&
      (staffDeptAttempt.error || '').toLowerCase().includes('reassign departments'),
    'updateReportStatusByAdmin blocks staff role from reassigning departments'
  );

  let staffStatusTxWrites = 0;
  const staffStatusAttempt = await updateReportStatusByAdmin(
    activeRoadReport.id,
    {
      status: 'Under Review',
      assignedDepartment: 'Drainage & Sewerage', // unchanged
      assignedOfficer: 'Field Tech A. Rao',
      adminRemarks: 'Verified curb drain issue on site',
    },
    {
      dbInstance: {} as any,
      currentUser: { uid: 'staff-uid', email: 'staff@municipality.gov' } as any,
      verifyAdminFn: async () => ({
        authorized: true,
        admin: {
          uid: 'staff-uid',
          email: 'staff@municipality.gov',
          role: 'staff',
          active: true,
        },
      }),
      docFn: ((_d: any, _c: string, id: string) => ({ id })) as any,
      collectionFn: ((_d: any, ...segs: string[]) => ({ path: segs.join('/') })) as any,
      runTransactionFn: (async (_d: any, fn: any) =>
        fn({
          get: async () => ({
            exists: () => true,
            data: () => ({ ...activeRoadReport }),
          }),
          update: () => {
            staffStatusTxWrites++;
          },
          set: () => {
            staffStatusTxWrites++;
          },
        })) as any,
      addDocFn: (async () => ({ id: 'audit-2' })) as any,
    }
  );
  assert(
    staffStatusAttempt.success === true && staffStatusTxWrites >= 1,
    'updateReportStatusByAdmin still allows staff role to update status/officer/remarks without changing department'
  );

  let supervisorDeptUpdated = '';
  const supervisorDeptAttempt = await updateReportStatusByAdmin(
    activeRoadReport.id,
    {
      status: 'Assigned',
      assignedDepartment: 'Road Maintenance',
    },
    {
      dbInstance: {} as any,
      currentUser: { uid: 'ward-uid', email: 'ward@municipality.gov' } as any,
      verifyAdminFn: async () => ({
        authorized: true,
        admin: {
          uid: 'ward-uid',
          email: 'ward@municipality.gov',
          role: 'ward_admin',
          active: true,
        },
      }),
      docFn: ((_d: any, _c: string, id: string) => ({ id })) as any,
      collectionFn: ((_d: any, ...segs: string[]) => ({ path: segs.join('/') })) as any,
      runTransactionFn: (async (_d: any, fn: any) =>
        fn({
          get: async () => ({
            exists: () => true,
            data: () => ({ ...activeRoadReport }),
          }),
          update: (_ref: any, payload: any) => {
            supervisorDeptUpdated = payload.assignedDepartment;
          },
          set: () => {},
        })) as any,
      addDocFn: (async () => ({ id: 'audit-3' })) as any,
    }
  );
  assert(
    supervisorDeptAttempt.success === true && supervisorDeptUpdated === 'Road Maintenance',
    'updateReportStatusByAdmin allows ward_admin to reassign departments'
  );

  // -------------------------------------------------------------------------
  // 5. Concurrent archival reconciliation in AdminReportDetailsModal helper
  // -------------------------------------------------------------------------
  console.log('\n5. Concurrent archival conflict detection');
  const reconciled = reconcileAdminModalFormState(
    {
      status: 'Under Review',
      assignedDepartment: 'Drainage & Sewerage',
      assignedOfficer: '',
      adminRemarks: 'Drafting note',
      resolutionDetails: '',
      resolutionPhotoUrl: '',
      duplicateOf: '',
    },
    activeRoadReport,
    { ...activeRoadReport, archived: true, archivedAt: '2026-04-12T11:00:00.000Z' }
  );
  assert(
    Boolean(reconciled.conflictMessage) &&
      reconciled.conflictMessage!.toLowerCase().includes('archived'),
    'reconcileAdminModalFormState flags concurrent archival while modal is open'
  );

  // -------------------------------------------------------------------------
  // 6. UI source regression checks (archived lockouts, role controls, clean copy)
  // -------------------------------------------------------------------------
  console.log('\n6. Citizen & Admin UI regression checks');
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

  const myReportsSrc = read('src/components/screens/MyReportsScreen.tsx');
  assert(
    myReportsSrc.includes('canWithdrawReport') &&
      myReportsSrc.includes('!selectedReport.archived && selectedReport.status !== \'Withdrawn\'') &&
      myReportsSrc.includes('Complaint Archived') &&
      !myReportsSrc.includes('Cloud Synced') &&
      !myReportsSrc.includes('Sync Now') &&
      !myReportsSrc.includes('confidence not measured') &&
      !myReportsSrc.includes('pending cloud sync'),
    'MyReportsScreen locks archived/withdrawn actions and uses citizen-friendly terminology'
  );

  const adminModalSrc = read('src/components/admin/AdminReportDetailsModal.tsx');
  assert(
    adminModalSrc.includes('const isArchived =') &&
      adminModalSrc.includes('const isReadOnly = isWithdrawn || isArchived') &&
      adminModalSrc.includes('Complaint Archived (Read-Only)') &&
      adminModalSrc.includes('disabled={isReadOnly || isSubmitting || !canAssignDepartmentUi}') &&
      adminModalSrc.includes('canAssignDepartmentUi\n        ? resolveDepartmentUpdateArg'),
    'AdminReportDetailsModal locks archived reports as read-only and enforces canAssignDepartmentUi'
  );

  const adminDashSrc = read('src/components/admin/AdminDashboard.tsx');
  assert(
    adminDashSrc.includes('setSelectedReport((prev) => syncSelectedReport(prev, reports))') &&
      adminDashSrc.includes('setPendingArchiveReport(r)') &&
      adminDashSrc.includes('e.stopPropagation();'),
    'AdminDashboard keeps opened archived reports synced and provides mobile card Archive button'
  );

  const profileSrc = read('src/components/screens/ProfileSettingsScreen.tsx');
  assert(
    profileSrc.includes('readOnly') &&
      profileSrc.includes('Your account sign-in email cannot be changed here.') &&
      profileSrc.includes('setSelectedWard(previousWard)') &&
      profileSrc.includes('setPushNotifs(prevPush)'),
    'ProfileSettingsScreen marks email read-only and rolls back ward/notification updates on failure'
  );

  const reportIssueSrc = read('src/components/screens/ReportIssueScreen.tsx');
  assert(
    !reportIssueSrc.includes('${res.auditWarning}') &&
      reportIssueSrc.includes('toUserFriendlyErrorMessage(err, \'submit_complaint\')'),
    'ReportIssueScreen hides raw auditWarning and sanitizes citizen-facing submission errors'
  );

  const homeSrc = read('src/components/screens/HomeScreen.tsx');
  const authSrc = read('src/components/screens/AuthScreen.tsx');
  const chatSrc = read('src/components/CivicChatbot.tsx');
  assert(
    !homeSrc.includes('AI Vision Triage') &&
      !homeSrc.includes('Smart Photo Reporting') &&
      !homeSrc.includes('Quick Access Section') &&
      homeSrc.includes('userReports.filter((r) => !r.archived)') &&
      !authSrc.includes('Authentication Error') &&
      !chatSrc.includes('Gemini Civic AI') &&
      !chatSrc.includes('Multi-Turn Memory') &&
      chatSrc.includes('Civic Guide'),
    'HomeScreen, AuthScreen, and CivicChatbot exclude archived counts and remove developer/model jargon'
  );

  const citizenAReport = { id: 'owner-a-report', userId: 'citizen-a' } as CivicIssueReport;
  const citizenBReport = { id: 'owner-b-report', userId: 'citizen-b' } as CivicIssueReport;
  const citizenAView = filterReportsForCitizen([citizenAReport, citizenBReport], 'citizen-a');
  assert(
    citizenAView.length === 1 && citizenAView[0].id === 'owner-a-report',
    'Citizen report state filters two-account data by the authenticated Firebase UID'
  );

  const appSrc = read('src/App.tsx');
  assert(
    appSrc.includes('filterReportsForCitizen') &&
      appSrc.includes("if (report.userId !== firebaseUser?.id) return;") &&
      appSrc.includes("report.userId === firebaseUser?.id"),
    'App rejects cross-account citizen report selection and filters synchronized reports'
  );

  console.log(`\nSummary: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Unhandled test error:', err);
  process.exit(1);
});
