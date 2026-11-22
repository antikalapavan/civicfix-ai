import {
  calculateAdminStats,
} from '../src/services/adminService';
import {
  CivicIssueReport,
  CitizenUser,
  ReportStatus,
  normalizeReportStatus,
  ALL_REPORT_STATUSES,
  VALID_REPORT_STATUSES,
} from '../src/types/civic';
import { getStatusThemeClasses } from '../src/components/CivicStatusBadge';
import {
  withdrawReportInFirestore,
  getPendingWithdrawals,
  clearPendingWithdrawals,
  saveLocalCachedReports,
  getLocalCachedReports,
  syncPendingReportsToFirestore,
  getPendingSyncCounts,
} from '../src/services/reportStorage';

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

console.log('\n--- RUNNING CIVIFIX AI REPORT WITHDRAWAL TEST SUITE ---');

// Mock helper to build a report
function createSampleReport(overrides: Partial<CivicIssueReport> = {}): CivicIssueReport {
  return {
    id: 'report-test-101',
    trackingNumber: 'CF-2026-TEST-101',
    title: 'Accidental Garbage Report',
    category: 'Garbage',
    department: 'Solid Waste Management',
    description: 'Accidental garbage report submitted near market street.',
    location: {
      address: '123 Market St, Ward 4',
      latitude: 17.385,
      longitude: 78.4867,
      ward: 'Ward 4',
    },
    photoUrl: 'data:image/jpeg;base64,mockphotodata',
    status: 'Submitted',
    severity: 'Medium',
    slaDeadline: '48 Hours SLA',
    submittedAt: '2026-11-10T10:00:00.000Z',
    updatedAt: '2026-11-10T10:00:00.000Z',
    userId: 'citizen-user-abc-123',
    citizenName: 'Aditi Sharma',
    citizenEmail: 'aditi@example.com',
    timeline: [
      {
        status: 'Submitted',
        timestamp: '2026-11-10T10:00:00.000Z',
        note: 'Report submitted by citizen via mobile app.',
      },
    ],
    ...overrides,
  };
}

const mockCitizen: CitizenUser = {
  id: 'citizen-user-abc-123',
  fullName: 'Aditi Sharma',
  phone: '9876543210',
  email: 'aditi@example.com',
  ward: 'Ward 4',
  city: 'Hyderabad',
  reportsCount: 1,
  resolvedCount: 0,
  notificationPreferences: {
    smsAlerts: true,
    pushNotifications: true,
    emailUpdates: true,
  },
};

const otherCitizen: CitizenUser = {
  id: 'unauthorized-intruder-999',
  fullName: 'Intruder User',
  phone: '9876543211',
  email: 'intruder@example.com',
  ward: 'Ward 9',
  city: 'Hyderabad',
  reportsCount: 0,
  resolvedCount: 0,
  notificationPreferences: {
    smsAlerts: false,
    pushNotifications: false,
    emailUpdates: false,
  },
};

// 1. Report Status Enum & Normalization
console.log('\n1. Status Definitions & Normalization:');
assert(ALL_REPORT_STATUSES.includes('Withdrawn'), "ALL_REPORT_STATUSES includes 'Withdrawn'");
assert(!VALID_REPORT_STATUSES.includes('Withdrawn' as any), 'VALID_REPORT_STATUSES strictly retains 6 canonical municipal processing stages');
assert(normalizeReportStatus('Withdrawn') === 'Withdrawn', "normalizeReportStatus handles 'Withdrawn'");
assert(normalizeReportStatus('withdrawn') === 'Withdrawn', "normalizeReportStatus normalizes lowercase 'withdrawn' to 'Withdrawn'");

// 2. Badge & Theme Mapping
console.log('\n2. CivicStatusBadge Theme:');
const withdrawnTheme = getStatusThemeClasses('Withdrawn');
assert(withdrawnTheme.includes('slate'), "getStatusThemeClasses('Withdrawn') applies neutral slate theme");

// 3. Admin Statistics & Workload Invariants
console.log('\n3. Admin Statistics Invariants for Withdrawn Reports:');
const reportsWithWithdrawn: CivicIssueReport[] = [
  createSampleReport({ id: 'r1', status: 'Submitted' }),
  createSampleReport({ id: 'r2', status: 'Under Review' }),
  createSampleReport({ id: 'r3', status: 'In Progress' }),
  createSampleReport({ id: 'r4', status: 'Resolved' }),
  createSampleReport({ id: 'r5', status: 'Rejected' }),
  createSampleReport({
    id: 'r6',
    status: 'Withdrawn',
    withdrawnAt: '2026-11-10T11:00:00.000Z',
    withdrawnBy: 'citizen-user-abc-123',
  }),
];

const stats = calculateAdminStats(reportsWithWithdrawn);
assert(stats.totalReports === 6, 'Total reports count includes historical withdrawn reports (6)');
assert(stats.pendingReports === 2, 'Pending reports count (2) includes ONLY Submitted (1) and Under Review (1), strictly excluding Withdrawn');
assert(stats.inProgressReports === 1, 'In-progress count (1) excludes Withdrawn reports');
assert(stats.resolvedReports === 1, 'Resolved count (1) excludes Withdrawn reports');
assert(stats.rejectedReports === 1, 'Rejected count (1) excludes Withdrawn reports');
assert(stats.withdrawnReports === 1, 'Admin stats accurately tracks withdrawnReports === 1');
assert(stats.statusDistribution.Withdrawn === 1, 'statusDistribution.Withdrawn accurately reflects 1 withdrawn report');

// 4. Withdrawal Logic & Ownership Validation
console.log('\n4. Withdrawal Authorization & Validation Logic:');

// Test 4A: Offline/unauthenticated 'Submitted' and 'Under Review' withdrawal does NOT falsely claim cloud success
async function testWithdrawableStatusesRequireCloudConfirmation() {
  for (const status of ['Submitted', 'Under Review'] as ReportStatus[]) {
    const initialReport = createSampleReport({ status });
    const res = await withdrawReportInFirestore(
      initialReport.id,
      mockCitizen,
      initialReport,
      'Submitted duplicate report accidentally'
    );

    assert(
      res.success === false,
      `Withdrawal for "${status}" does not claim cloud success when unauthenticated/offline`
    );
    assert(
      res.isPendingSync === true,
      `Withdrawal for "${status}" marks isPendingSync: true when offline`
    );
    assert(
      res.report?.status === status,
      `Official report status remains "${status}" until committed to Cloud Firestore`
    );
  }
}

// Test 4B: Rejection when non-owner attempts withdrawal
async function testUnauthorizedWithdrawal() {
  const initialReport = createSampleReport({ status: 'Submitted' });
  const res = await withdrawReportInFirestore(
    initialReport.id,
    otherCitizen, // Different user
    initialReport
  );
  assert(res.success === false, 'Unauthorized citizen attempt returned success: false');
  assert(
    Boolean(res.error && res.error.toLowerCase().includes('not authorized')),
    `Non-owner cannot withdraw report: ${res.error}`
  );
}

// Test 4C: Rejection when report is beyond Submitted / Under Review processing stages
async function testNonWithdrawableStatuses() {
  const nonPermittedStatuses: ReportStatus[] = [
    'Assigned',
    'In Progress',
    'Resolved',
    'Rejected',
  ];

  for (const st of nonPermittedStatuses) {
    const report = createSampleReport({ status: st });
    const res = await withdrawReportInFirestore(report.id, mockCitizen, report);
    assert(res.success === false, `Withdrawal correctly rejected for status "${st}"`);
    assert(
      Boolean(
        res.error &&
          res.error.includes('Only reports with status "Submitted" or "Under Review" can be withdrawn')
      ),
      `Error specifies only Submitted or Under Review can be withdrawn: ${res.error}`
    );
  }
}

// Test 4D: Duplicate withdrawal prevention
async function testDuplicateWithdrawal() {
  const alreadyWithdrawnReport = createSampleReport({
    status: 'Withdrawn',
    withdrawnAt: '2026-11-10T10:30:00.000Z',
    withdrawnBy: mockCitizen.id,
  });

  const res = await withdrawReportInFirestore(alreadyWithdrawnReport.id, mockCitizen, alreadyWithdrawnReport);
  assert(res.success === false, 'Duplicate withdrawal request safely rejected');
  assert(
    Boolean(res.error && res.error.includes('already been withdrawn')),
    `Error explains report already withdrawn: ${res.error}`
  );
}

// Test 5: Phase 4 Step 5 Offline Withdrawal Persistence & Replay Queue
async function withMockBrowserStorage(
  fn: (store: Record<string, string>) => Promise<void> | void,
  options?: { failSetItem?: boolean }
) {
  const store: Record<string, string> = {};
  const prevStorage = (globalThis as any).localStorage;
  (globalThis as any).localStorage = {
    getItem: (key: string) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
    setItem: (key: string, val: string) => {
      if (options?.failSetItem) {
        throw new Error('QuotaExceededError: storage quota exceeded');
      }
      store[key] = String(val);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      Object.keys(store).forEach((k) => delete store[k]);
    },
  };
  try {
    await fn(store);
  } finally {
    if (prevStorage === undefined) {
      delete (globalThis as any).localStorage;
    } else {
      (globalThis as any).localStorage = prevStorage;
    }
  }
}

async function testOfflineWithdrawalPersistenceAndReplay() {
  console.log('\n5. Phase 4 Step 5 Offline Withdrawal Persistence & Replay:');

  // 5A. Quota/storage failure when localStorage fails -> honest isPendingSync: false
  await withMockBrowserStorage(async () => {
    const rep = createSampleReport({ id: 'rep-quota-fail', status: 'Submitted' });
    const res = await withdrawReportInFirestore(rep.id, mockCitizen, rep, 'Accident', {
      isOnline: false,
      currentUser: { uid: mockCitizen.id, email: mockCitizen.email },
    });
    assert(res.success === false, 'Storage failure withdrawal returns success: false');
    assert(res.isPendingSync === false, 'Storage failure withdrawal honestly returns isPendingSync: false');
    assert(
      Boolean(res.error && res.error.includes('cannot persist a pending withdrawal queue')),
      'Storage failure withdrawal gives honest reconnect error'
    );
  }, { failSetItem: true });

  // 5B. Persist minimal intent offline, survive reload, never set local status to Withdrawn, replay cleanly
  await withMockBrowserStorage(async (store) => {
    const rep = createSampleReport({
      id: 'rep-offline-queue-1',
      status: 'Under Review',
      syncedToCloud: true,
    });
    saveLocalCachedReports(mockCitizen.id, [rep]);

    const offlineRes = await withdrawReportInFirestore(rep.id, mockCitizen, rep, 'Duplicate filing');
    assert(offlineRes.success === false, 'Offline withdrawal returns success: false');
    assert(offlineRes.isPendingSync === true, 'Offline withdrawal persists queue and marks isPendingSync: true');
    assert(
      offlineRes.report?.status === 'Under Review',
      'Offline withdrawal does NOT prematurely mark report status as Withdrawn'
    );

    const queueKey = `civifix_pending_withdrawals_${mockCitizen.id}`;
    const rawSaved = store[queueKey];
    assert(Boolean(rawSaved), `Intent stored under ${queueKey}`);
    const parsedSaved = JSON.parse(rawSaved);
    assert(
      Array.isArray(parsedSaved) &&
        parsedSaved.length === 1 &&
        parsedSaved[0].reportId === rep.id &&
        parsedSaved[0].userId === mockCitizen.id &&
        parsedSaved[0].reason === 'Duplicate filing' &&
        !('photoUrl' in parsedSaved[0]),
      'Persisted intent stores only minimal withdrawal fields without report/photo bloat'
    );

    // Restoring queue on simulated reload
    const restored = getPendingWithdrawals(mockCitizen.id);
    assert(restored.length === 1 && restored[0].reportId === rep.id, 'Pending withdrawal survives simulated reload');

    // Ownership mismatch rejected cleanly
    const mismatchSync = await syncPendingReportsToFirestore(mockCitizen.id, {
      isConfigured: true,
      hasDb: true,
      hasAuthUser: true,
      currentAuthUid: otherCitizen.id,
    });
    assert(
      mismatchSync.errors[0].toLowerCase().includes('not authorized'),
      'Replay rejects mismatched authenticated UID'
    );
    assert(getPendingWithdrawals(mockCitizen.id).length === 1, 'Rejected mismatch leaves owner intent untouched');

    // Transient offline replay preserves intent
    const transientSync = await syncPendingReportsToFirestore(mockCitizen.id, {
      isConfigured: true,
      hasDb: true,
      hasAuthUser: true,
      currentAuthUid: mockCitizen.id,
      getLatestReportFn: async () => rep,
      withdrawReportFn: async () => ({
        success: false,
        isPendingSync: true,
        error: 'Network still unavailable',
      }),
    });
    assert(transientSync.failedWithdrawalsCount === 1, 'Transient offline replay increments failedWithdrawalsCount');
    assert(getPendingWithdrawals(mockCitizen.id).length === 1, 'Transient offline error keeps intent for next retry');

    // Successful online replay updates status to Withdrawn & clears intent
    const successSync = await syncPendingReportsToFirestore(mockCitizen.id, {
      isConfigured: true,
      hasDb: true,
      hasAuthUser: true,
      currentAuthUid: mockCitizen.id,
      getLatestReportFn: async () => rep,
      withdrawReportFn: async (id, _u, latest, reason) => ({
        success: true,
        report: {
          ...(latest || rep),
          id,
          status: 'Withdrawn',
          withdrawalReason: reason,
          syncedToCloud: true,
        },
      }),
    });
    assert(successSync.syncedWithdrawalsCount === 1, 'Successful replay increments syncedWithdrawalsCount');
    assert(getPendingWithdrawals(mockCitizen.id).length === 0, 'Successful replay clears pending withdrawal intent');
    assert(
      getLocalCachedReports(mockCitizen.id)[0]?.status === 'Withdrawn',
      'Local cache reflects confirmed Withdrawn status after replay'
    );
  });

  // 5C. Admin changed status before replay -> removes stale intent and explains clearly
  await withMockBrowserStorage(async () => {
    const rep = createSampleReport({
      id: 'rep-admin-advanced',
      status: 'Submitted',
      syncedToCloud: true,
    });
    saveLocalCachedReports(mockCitizen.id, [rep]);
    await withdrawReportInFirestore(rep.id, mockCitizen, rep, 'Withdrawing');
    assert(getPendingWithdrawals(mockCitizen.id).length === 1, 'Withdrawal enqueued before admin progression');

    const advancedSync = await syncPendingReportsToFirestore(mockCitizen.id, {
      isConfigured: true,
      hasDb: true,
      hasAuthUser: true,
      currentAuthUid: mockCitizen.id,
      getLatestReportFn: async () => ({ ...rep, status: 'In Progress' }),
    });
    assert(advancedSync.failedWithdrawalsCount === 1, 'Status transition rejection reported cleanly');
    assert(
      advancedSync.errors.some((e) => e.includes('municipal status changed to "In Progress"')),
      'Explains why stale withdrawal could not finish after municipal status change'
    );
    assert(
      getPendingWithdrawals(mockCitizen.id).length === 0,
      'Stale withdrawal intent removed after municipal progression'
    );
  });

  // 5D. Sign-out cleanup isolation + malformed localStorage resilience
  await withMockBrowserStorage(async (store) => {
    const repA = createSampleReport({ id: 'rep-a', userId: mockCitizen.id, status: 'Submitted' });
    const repB = createSampleReport({ id: 'rep-b', userId: otherCitizen.id, status: 'Submitted' });
    await withdrawReportInFirestore(repA.id, mockCitizen, repA);
    await withdrawReportInFirestore(repB.id, otherCitizen, repB);

    clearPendingWithdrawals(mockCitizen.id);
    assert(getPendingWithdrawals(mockCitizen.id).length === 0, 'clearPendingWithdrawals removes signed-out user queue');
    assert(getPendingWithdrawals(otherCitizen.id).length === 1, 'clearPendingWithdrawals preserves other users queues');

    store[`civifix_pending_withdrawals_${mockCitizen.id}`] = '{corrupt-json';
    assert(getPendingWithdrawals(mockCitizen.id).length === 0, 'Malformed withdrawal JSON handled safely without throwing');
    assert(getPendingSyncCounts(mockCitizen.id, []).pendingWithdrawals === 0, 'Pending sync counts ignore corrupt JSON cleanly');
  });
}

// Execute async test suite
(async () => {
  try {
    await testWithdrawableStatusesRequireCloudConfirmation();
    await testUnauthorizedWithdrawal();
    await testNonWithdrawableStatuses();
    await testDuplicateWithdrawal();
    await testOfflineWithdrawalPersistenceAndReplay();

    console.log(`\nAll ${passedTests} / ${totalTests} Report Withdrawal tests passed successfully!`);
  } catch (e) {
    console.error('Test suite failed:', e);
    process.exit(1);
  }
})();
