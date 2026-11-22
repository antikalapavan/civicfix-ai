/**
 * CivicFix AI — Regression Test Suite for Admin Archiving, Status/Assignment Updates,
 * Withdrawn Complaint Policy (Explicit Reopen), Friendly UI Errors, and Console Logging.
 *
 * Covers all 11 required verification scenarios using mocked Firestore transactions
 * (no live Firebase writes or deployments are performed).
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { FieldValue, serverTimestamp, Timestamp } from 'firebase/firestore';
import {
  archiveReportByAdmin,
  calculateAdminStats,
  mapFirestoreDocToReport,
  reopenWithdrawnReportByAdmin,
  updateReportStatusByAdmin,
  verifyAdminPrivileges,
} from '../src/services/adminService';
import {
  formatReportDate,
  formatReportDateTime,
  normalizeOptionalReportTimestamp,
  parseReportTimestamp,
  sanitizeForFirestore,
  sortReportsNewestFirst,
  syncSelectedReport,
} from '../src/services/reportStorage';
import {
  containsTechnicalJargon,
  formatImageReviewStatusLabel,
  toUserFriendlyErrorMessage,
} from '../src/utils/userFriendlyErrors';
import { CivicIssueReport, ReportStatus } from '../src/types/civic';

let passed = 0;
let failed = 0;

async function runTest(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`        ${err?.message || err}`);
  }
}

function makeReport(overrides: Partial<CivicIssueReport> = {}): CivicIssueReport {
  return {
    id: overrides.id || 'rep-test-001',
    trackingNumber: overrides.trackingNumber || 'CFX-2026-TEST-001',
    userId: overrides.userId || 'citizen-uid-1',
    category: overrides.category || ('Road & Potholes' as any),
    title: overrides.title || 'Large pothole near civic center',
    description: overrides.description || 'Deep pothole causing traffic slowdown.',
    photoUrl: overrides.photoUrl ?? 'https://storage.googleapis.com/civifix-test/pothole.jpg',
    location: overrides.location || {
      address: '12 Main Street',
      ward: 'Ward 4',
      latitude: 12.9716,
      longitude: 77.5946,
    },
    severity: overrides.severity || 'High',
    status: overrides.status || 'Submitted',
    submittedAt: overrides.submittedAt || '2026-11-10T09:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-11-10T09:00:00.000Z',
    department: overrides.department || 'Roads & Infrastructure Maintenance',
    assignedDepartment: overrides.assignedDepartment || 'Roads & Infrastructure Maintenance',
    assignedOfficer: overrides.assignedOfficer || '',
    slaDeadline: overrides.slaDeadline || '48 Hours SLA',
    timeline: overrides.timeline || [
      {
        status: 'Submitted',
        timestamp: '2026-11-10T09:00:00.000Z',
        note: 'Complaint submitted by citizen.',
        officer: 'Citizen',
      },
    ],
    citizenNotes: overrides.citizenNotes || [],
    ...overrides,
  };
}

function createInMemoryFirestoreHarness(
  initialReports: Record<string, any>,
  options?: {
    simulatedServerTime?: Date;
    failOnWriteCollection?: 'civic_reports' | 'auditLogs';
  }
) {
  const reports: Record<string, any> = {};
  for (const [id, data] of Object.entries(initialReports)) {
    reports[id] = JSON.parse(JSON.stringify(data));
  }
  const statusHistory: Record<string, any[]> = {};
  const auditLogs: any[] = [];
  const rawStagedTransactions: {
    ops: { type: 'update' | 'set'; path: string; segments: string[]; data: Record<string, any> }[];
  }[] = [];
  let autoIdCounter = 1;
  const serverTime = options?.simulatedServerTime ?? new Date('2026-11-19T12:34:56.000Z');

  const resolveServerSentinels = (data: Record<string, any>): Record<string, any> => {
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      out[key] = value instanceof FieldValue ? Timestamp.fromDate(serverTime) : value;
    }
    return out;
  };

  const docFn = ((firstArg: any, ...segments: string[]) => {
    // Modular SDK overload: doc(collectionRef) -> auto-ID document in that collection
    if (firstArg && Array.isArray(firstArg.segments) && segments.length === 0) {
      const autoId = `auto-${autoIdCounter++}`;
      const fullSegments = [...firstArg.segments, autoId];
      return {
        path: fullSegments.join('/'),
        segments: fullSegments,
        id: autoId,
      };
    }
    return {
      path: segments.join('/'),
      segments,
      id: segments[segments.length - 1],
    };
  }) as any;

  const collectionFn = ((_db: any, ...segments: string[]) => ({
    path: segments.join('/'),
    segments,
  })) as any;

  const getDocFn = (async (ref: any) => {
    const id = ref.segments[1];
    const exists = Object.prototype.hasOwnProperty.call(reports, id);
    return {
      exists: () => exists,
      data: () => (exists ? { ...reports[id] } : undefined),
    };
  }) as any;

  const runTransactionFn = (async (_db: any, updateFunction: (tx: any) => Promise<any>) => {
    const stagedOps: {
      type: 'update' | 'set';
      ref: any;
      data: Record<string, any>;
    }[] = [];
    const tx = {
      get: async (ref: any) => {
        const id = ref.segments[1];
        const exists = Object.prototype.hasOwnProperty.call(reports, id);
        return {
          exists: () => exists,
          data: () => (exists ? JSON.parse(JSON.stringify(reports[id])) : undefined),
        };
      },
      update: (ref: any, data: Record<string, any>) => {
        stagedOps.push({ type: 'update', ref, data });
      },
      set: (ref: any, data: Record<string, any>) => {
        stagedOps.push({ type: 'set', ref, data });
      },
    };
    const txResult = await updateFunction(tx);
    rawStagedTransactions.push({
      ops: stagedOps.map((op) => ({
        type: op.type,
        path: op.ref.path,
        segments: op.ref.segments,
        data: op.data,
      })),
    });

    // Atomic validation before committing ANY staged operation (simulates Firestore rollback)
    if (options?.failOnWriteCollection) {
      const failingOp = stagedOps.find((op) => op.ref.segments[0] === options.failOnWriteCollection);
      if (failingOp) {
        const err: any = new Error(
          `Missing or insufficient permissions on ${failingOp.ref.path}.`
        );
        err.code = 'permission-denied';
        throw err;
      }
    }

    // Commit all staged ops together atomically
    for (const op of stagedOps) {
      const resolvedData = resolveServerSentinels(op.data);
      if (op.ref.segments[0] === 'civic_reports') {
        const id = op.ref.segments[1];
        reports[id] = {
          ...reports[id],
          ...resolvedData,
        };
      } else if (op.ref.segments[0] === 'auditLogs') {
        auditLogs.push({ id: op.ref.id, ...resolvedData });
      }
    }
    return txResult;
  }) as any;

  const addDocFn = (async (colRef: any, data: Record<string, any>) => {
    const newId = `auto-${autoIdCounter++}`;
    if (colRef.path === 'auditLogs') {
      auditLogs.push({ id: newId, ...data });
    } else if (colRef.segments[0] === 'civic_reports' && colRef.segments[2] === 'statusHistory') {
      const reportId = colRef.segments[1];
      statusHistory[reportId] = statusHistory[reportId] || [];
      statusHistory[reportId].push({ id: newId, ...data });
    }
    return { id: newId };
  }) as any;

  return {
    dbInstance: { __mockDb: true },
    reports,
    statusHistory,
    auditLogs,
    rawStagedTransactions,
    serverTime,
    docFn,
    collectionFn,
    getDocFn,
    runTransactionFn,
    addDocFn,
  };
}

async function main() {
  console.log('\n=== CivicFix AI: Admin Archive, Reopen, Status Updates & Friendly Copy Tests ===\n');

  // Scenario 1: Authorized admin can archive a complaint atomically with audit log & serverTimestamp
  await runTest('1. Authorized admin (superadmin & department_head) can archive a complaint atomically with audit log', async () => {
    const initial = makeReport({ id: 'rep-arch-1', trackingNumber: 'CFX-2026-ARCH-1' });
    const harness = createInMemoryFirestoreHarness({ 'rep-arch-1': initial });

    const res = await archiveReportByAdmin('rep-arch-1', 'Duplicate filing', {
      currentUser: { uid: 'super-uid-1', email: 'super@municipality.gov' },
      dbInstance: harness.dbInstance,
      verifyAdminFn: async () => ({
        authorized: true,
        admin: { uid: 'super-uid-1', email: 'super@municipality.gov', role: 'superadmin' },
      }),
      docFn: harness.docFn,
      collectionFn: harness.collectionFn,
      getDocFn: harness.getDocFn,
      runTransactionFn: harness.runTransactionFn,
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(harness.rawStagedTransactions.length, 1, 'Archive runs in a single atomic transaction');
    const [reportOp, auditOp] = harness.rawStagedTransactions[0].ops;
    assert.strictEqual(reportOp.type, 'update');
    assert.strictEqual(reportOp.path, 'civic_reports/rep-arch-1');
    assert.strictEqual(
      reportOp.data.archivedAt instanceof FieldValue,
      true,
      'Staged transaction write must pass Firestore serverTimestamp() FieldValue sentinel to archivedAt'
    );
    assert.strictEqual(
      typeof reportOp.data.updatedAt,
      'string',
      'updatedAt must remain an ISO-8601 string for existing Firestore queries'
    );
    assert(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(reportOp.data.updatedAt),
      'updatedAt must be a valid ISO-8601 string'
    );
    assert.strictEqual(auditOp.type, 'set');
    assert.strictEqual(auditOp.segments[0], 'auditLogs');
    assert.strictEqual(auditOp.data.action, 'report_archived');
    assert.strictEqual(auditOp.data.targetType, 'civic_report');
    assert.strictEqual(auditOp.data.targetId, 'rep-arch-1');
    assert.strictEqual(auditOp.data.actorUid, 'super-uid-1');

    // Committed report has server-resolved Firestore Timestamp, and result exposes normalized string (never FieldValue)
    assert.strictEqual(harness.reports['rep-arch-1'].archived, true);
    assert.strictEqual(harness.reports['rep-arch-1'].archivedAt instanceof Timestamp, true);
    assert.strictEqual(res.archivedAt, harness.serverTime.toISOString());
    assert.strictEqual(typeof res.archivedAt, 'string', 'Returned archivedAt is safe string, never FieldValue');
    assert.strictEqual(harness.reports['rep-arch-1'].archivedBy, 'super-uid-1');
    assert.strictEqual(harness.reports['rep-arch-1'].archiveReason, 'Duplicate filing');
    assert.strictEqual(
      harness.reports['rep-arch-1'].photoUrl,
      initial.photoUrl,
      'Evidence photo URL is preserved on archive'
    );
  });

  // Scenario 2: Citizen and unauthorized staff cannot archive complaints
  await runTest('2. Citizen and unauthorized staff role are blocked from archiving complaints', async () => {
    const initial = makeReport({ id: 'rep-arch-2' });
    const harness = createInMemoryFirestoreHarness({ 'rep-arch-2': initial });
    let txCalled = false;

    const citizenRes = await archiveReportByAdmin('rep-arch-2', 'Unauthorized attempt', {
      currentUser: { uid: 'citizen-uid-1', email: 'citizen@example.com' },
      dbInstance: harness.dbInstance,
      verifyAdminFn: async () => ({
        authorized: false,
        admin: null,
        error: 'Access denied.',
      }),
      docFn: harness.docFn,
      runTransactionFn: (async () => {
        txCalled = true;
      }) as any,
    });

    assert.strictEqual(citizenRes.success, false);
    assert.strictEqual(txCalled, false);
    assert.strictEqual(harness.reports['rep-arch-2'].archived, undefined);
    assert.strictEqual(containsTechnicalJargon(citizenRes.error || ''), false);

    const staffRes = await archiveReportByAdmin('rep-arch-2', 'Staff attempt', {
      currentUser: { uid: 'staff-uid-1', email: 'staff@municipality.gov' },
      dbInstance: harness.dbInstance,
      verifyAdminFn: async () => ({
        authorized: true,
        admin: { uid: 'staff-uid-1', email: 'staff@municipality.gov', role: 'staff' },
      }),
      docFn: harness.docFn,
      runTransactionFn: (async () => {
        txCalled = true;
      }) as any,
    });

    assert.strictEqual(staffRes.success, false);
    assert.strictEqual(txCalled, false);
    assert.strictEqual(containsTechnicalJargon(staffRes.error || ''), false);

    // Also verify missing boolean active: true on /admins/{uid} is rejected to match firestore.rules
    const incompleteAdminDocRes = await verifyAdminPrivileges(
      {
        uid: 'incomplete-admin-uid',
        email: 'incomplete@municipality.gov',
        getIdTokenResult: async () => ({ token: 'tok', claims: { admin: true, role: 'superadmin' } }),
      } as any,
      {
        getAdminDocFn: async () => ({ exists: true, data: { role: 'superadmin' } }), // missing active: true
      }
    );
    assert.strictEqual(
      incompleteAdminDocRes.authorized,
      false,
      'Admin doc missing boolean active: true is rejected to match firestore.rules'
    );
  });

  // Scenario 3: Archived complaints disappear from normal complaints list & stats
  await runTest('3. Archived complaints disappear from active complaints list and KPI stats', () => {
    const activeA = makeReport({ id: 'a1', status: 'Submitted' });
    const activeB = makeReport({ id: 'a2', status: 'Resolved' });
    const archivedC = makeReport({
      id: 'a3',
      status: 'Submitted',
      archived: true,
      archivedAt: '2026-11-12T10:00:00.000Z',
    });

    const allLoaded = [activeA, activeB, archivedC];
    const normalList = allLoaded.filter((r) => !r.archived);
    assert.strictEqual(normalList.length, 2);
    assert.strictEqual(normalList.some((r) => r.id === 'a3'), false);

    const stats = calculateAdminStats(allLoaded);
    assert.strictEqual(stats.totalReports, 2);
    assert.strictEqual(stats.pendingReports, 1);
    assert.strictEqual(stats.resolvedReports, 1);
  });

  // Scenario 4: Audit history is preserved on archive
  await runTest('4. Archiving preserves timeline & statusHistory and writes an immutable audit log entry', async () => {
    const initial = makeReport({ id: 'rep-audit-1', trackingNumber: 'CFX-2026-AUD-1' });
    const harness = createInMemoryFirestoreHarness({ 'rep-audit-1': initial });
    harness.statusHistory['rep-audit-1'] = [
      { id: 'sh-1', fromStatus: null, toStatus: 'Submitted', note: 'Initial submission' },
    ];

    const res = await archiveReportByAdmin('rep-audit-1', 'Duplicate report', {
      currentUser: { uid: 'dept-head-1', email: 'head@municipality.gov' },
      dbInstance: harness.dbInstance,
      verifyAdminFn: async () => ({
        authorized: true,
        admin: { uid: 'dept-head-1', email: 'head@municipality.gov', role: 'department_head' },
      }),
      docFn: harness.docFn,
      collectionFn: harness.collectionFn,
      getDocFn: harness.getDocFn,
      runTransactionFn: harness.runTransactionFn,
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(harness.statusHistory['rep-audit-1'].length, 1, 'Existing statusHistory preserved');
    assert.strictEqual(
      harness.reports['rep-audit-1'].timeline.length,
      2,
      'Timeline preserved and archival event appended'
    );
    assert.strictEqual(harness.auditLogs.length, 1);
    assert.strictEqual(harness.auditLogs[0].action, 'report_archived');
    assert.strictEqual(harness.auditLogs[0].targetType, 'civic_report');
    assert.strictEqual(harness.auditLogs[0].targetId, 'rep-audit-1');
    assert.strictEqual(harness.auditLogs[0].actorUid, 'dept-head-1');
  });

  // Scenario 5: Active complaints can have status updated
  await runTest('5. Active complaints (Submitted -> Under Review -> Assigned -> In Progress -> Resolved) update cleanly', async () => {
    const initial = makeReport({ id: 'rep-flow-1', status: 'Submitted' });
    const harness = createInMemoryFirestoreHarness({ 'rep-flow-1': initial });
    const adminDeps = {
      currentUser: { uid: 'admin-flow-1', email: 'ops@municipality.gov' },
      dbInstance: harness.dbInstance,
      verifyAdminFn: async () => ({
        authorized: true,
        admin: { uid: 'admin-flow-1', email: 'ops@municipality.gov', role: 'department_head' as const },
      }),
      docFn: harness.docFn,
      collectionFn: harness.collectionFn,
      runTransactionFn: harness.runTransactionFn,
      addDocFn: harness.addDocFn,
    };

    const transitions: [ReportStatus, ReportStatus][] = [
      ['Submitted', 'Under Review'],
      ['Under Review', 'Assigned'],
      ['Assigned', 'In Progress'],
      ['In Progress', 'Resolved'],
    ];

    for (const [from, to] of transitions) {
      const res = await updateReportStatusByAdmin(
        'rep-flow-1',
        {
          status: to,
          previousStatus: from,
          adminRemarks: `Moved to ${to}`,
          ...(to === 'Resolved' ? { resolutionDetails: 'Road patched and inspected.' } : {}),
        },
        adminDeps
      );
      assert.strictEqual(res.success, true, `Transition ${from} -> ${to} must succeed`);
      assert.strictEqual(harness.reports['rep-flow-1'].status, to);
    }
    assert.strictEqual(harness.statusHistory['rep-flow-1'].length, 4);
    assert.strictEqual(harness.auditLogs.length, 4);
  });

  // Scenarios 6 & 7: Department and officer assignments persist after reopening
  await runTest('6 & 7. Department and officer assignments persist after updating and reopening a complaint', async () => {
    const initial = makeReport({
      id: 'rep-persist-1',
      status: 'Assigned',
      department: 'Water Supply & Sewerage Board',
      assignedDepartment: 'Water Supply & Sewerage Board',
      assignedOfficer: 'Insp. Kavita Nair',
    });
    const harness = createInMemoryFirestoreHarness({ 'rep-persist-1': initial });
    const adminDeps = {
      currentUser: { uid: 'admin-p-1', email: 'supervisor@municipality.gov' },
      dbInstance: harness.dbInstance,
      verifyAdminFn: async () => ({
        authorized: true,
        admin: { uid: 'admin-p-1', email: 'supervisor@municipality.gov', role: 'superadmin' as const },
      }),
      docFn: harness.docFn,
      collectionFn: harness.collectionFn,
      runTransactionFn: harness.runTransactionFn,
      addDocFn: harness.addDocFn,
    };

    const updateRes = await updateReportStatusByAdmin(
      'rep-persist-1',
      {
        status: 'In Progress',
        previousStatus: 'Assigned',
        assignedDepartment: 'Stormwater Drainage & Flood Control',
        assignedOfficer: 'Eng. R. Deshmukh',
        adminRemarks: 'Assigned flood control crew.',
      },
      adminDeps
    );

    assert.strictEqual(updateRes.success, true);
    assert.strictEqual(harness.reports['rep-persist-1'].assignedDepartment, 'Stormwater Drainage & Flood Control');
    assert.strictEqual(harness.reports['rep-persist-1'].department, 'Stormwater Drainage & Flood Control');
    assert.strictEqual(harness.reports['rep-persist-1'].assignedOfficer, 'Eng. R. Deshmukh');

    // Simulate reopening modal by reading stored Firestore document directly
    const reopenedDoc = JSON.parse(JSON.stringify(harness.reports['rep-persist-1']));
    assert.strictEqual(reopenedDoc.assignedDepartment, 'Stormwater Drainage & Flood Control');
    assert.strictEqual(reopenedDoc.assignedOfficer, 'Eng. R. Deshmukh');
    assert.strictEqual(reopenedDoc.status, 'In Progress');
  });

  // Scenario 8: Withdrawn complaints enforce read-only protection & explicit reopen policy
  await runTest('8. Withdrawn complaints block ordinary updates and follow explicit reopen policy with audit trail', async () => {
    const withdrawn = makeReport({
      id: 'rep-wd-1',
      trackingNumber: 'CFX-2026-WD-001',
      status: 'Withdrawn',
      assignedDepartment: 'Electrical & Street Lighting Department',
      department: 'Electrical & Street Lighting Department',
      assignedOfficer: 'Tech. S. Rao',
      withdrawnAt: '2026-11-11T08:00:00.000Z',
      withdrawnBy: 'citizen-uid-1',
      withdrawalReason: 'Accidental duplicate',
    });
    const harness = createInMemoryFirestoreHarness({ 'rep-wd-1': withdrawn });
    const adminDeps = {
      currentUser: { uid: 'admin-wd-1', email: 'admin@municipality.gov' },
      dbInstance: harness.dbInstance,
      verifyAdminFn: async () => ({
        authorized: true,
        admin: { uid: 'admin-wd-1', email: 'admin@municipality.gov', role: 'department_head' as const },
      }),
      docFn: harness.docFn,
      collectionFn: harness.collectionFn,
      runTransactionFn: harness.runTransactionFn,
      addDocFn: harness.addDocFn,
    };

    // Ordinary status update MUST be rejected on Withdrawn
    const blockedRes = await updateReportStatusByAdmin(
      'rep-wd-1',
      { status: 'Under Review', previousStatus: 'Withdrawn' },
      adminDeps
    );
    assert.strictEqual(blockedRes.success, false);
    assert.strictEqual(harness.reports['rep-wd-1'].status, 'Withdrawn');
    assert.strictEqual(containsTechnicalJargon(blockedRes.error || ''), false);

    // Explicit reopen requires a reason
    const missingReasonRes = await reopenWithdrawnReportByAdmin('rep-wd-1', '  ', adminDeps);
    assert.strictEqual(missingReasonRes.success, false);

    // Explicit reopen succeeds, transitions to Under Review, preserves department & officer, writes statusHistory + auditLogs
    const reopenRes = await reopenWithdrawnReportByAdmin(
      'rep-wd-1',
      'Exposed live wiring still poses a public safety hazard',
      adminDeps
    );
    assert.strictEqual(reopenRes.success, true);
    assert.strictEqual(harness.reports['rep-wd-1'].status, 'Under Review');
    assert.strictEqual(
      harness.reports['rep-wd-1'].assignedDepartment,
      'Electrical & Street Lighting Department',
      'Department preserved across reopen'
    );
    assert.strictEqual(
      harness.reports['rep-wd-1'].assignedOfficer,
      'Tech. S. Rao',
      'Officer preserved across reopen'
    );
    assert.strictEqual(harness.statusHistory['rep-wd-1'].length, 1);
    assert.strictEqual(harness.statusHistory['rep-wd-1'][0].fromStatus, 'Withdrawn');
    assert.strictEqual(harness.statusHistory['rep-wd-1'][0].toStatus, 'Under Review');
    assert.strictEqual(harness.auditLogs.length, 1);
    assert.strictEqual(harness.auditLogs[0].action, 'report_reopened');

    // Once reopened, ordinary status updates work normally
    const followUpRes = await updateReportStatusByAdmin(
      'rep-wd-1',
      { status: 'Assigned', previousStatus: 'Under Review', assignedOfficer: 'Eng. P. Verma' },
      adminDeps
    );
    assert.strictEqual(followUpRes.success, true);
    assert.strictEqual(harness.reports['rep-wd-1'].status, 'Assigned');
    assert.strictEqual(harness.reports['rep-wd-1'].assignedOfficer, 'Eng. P. Verma');
  });

  // Scenarios 9 & 10: Friendly UI permission errors + detailed developer console logs
  await runTest('9 & 10. Permission errors show friendly UI messages while logging technical details to console.error', async () => {
    const capturedConsoleErrors: string[] = [];
    const origConsoleError = console.error;
    console.error = (...args: any[]) => {
      capturedConsoleErrors.push(args.map((a) => String(a)).join(' '));
    };

    try {
      const permErr: any = new Error('Missing or insufficient permissions.');
      permErr.code = 'permission-denied';

      const archivePermRes = await archiveReportByAdmin('rep-perm-1', 'Cleanup', {
        currentUser: { uid: 'admin-perm-1', email: 'admin@municipality.gov' },
        dbInstance: { __mockDb: true },
        verifyAdminFn: async () => ({
          authorized: true,
          admin: { uid: 'admin-perm-1', email: 'admin@municipality.gov', role: 'superadmin' },
        }),
        collectionFn: ((_db: any, ...segs: string[]) => ({ path: segs.join('/') })) as any,
        docFn: ((first: any, ...segs: string[]) =>
          segs.length === 0
            ? { path: `${first?.path || 'auditLogs'}/auto-perm-1`, id: 'auto-perm-1' }
            : { path: segs.join('/'), id: segs[segs.length - 1] }) as any,
        runTransactionFn: (async () => {
          throw permErr;
        }) as any,
      });

      assert.strictEqual(archivePermRes.success, false);
      assert.strictEqual(
        archivePermRes.error,
        "You don't have permission to remove this complaint. Please contact the system administrator."
      );
      assert.strictEqual(containsTechnicalJargon(archivePermRes.error || ''), false);
      assert.strictEqual(
        capturedConsoleErrors.some(
          (line) =>
            line.includes('Firestore Error:') &&
            line.includes('civic_reports/rep-perm-1') &&
            line.includes('Missing or insufficient permissions.')
        ),
        true,
        'Technical Firestore error details must remain logged in developer console'
      );

      // Verify helper translations across key actions
      const uploadErr = toUserFriendlyErrorMessage(permErr, 'upload_photo');
      assert.strictEqual(uploadErr, "Your photo couldn't be uploaded. Please try again.");
      assert.strictEqual(containsTechnicalJargon(uploadErr), false);

      const loadErr = toUserFriendlyErrorMessage(new Error('onSnapshot failed: Cloud Firestore unavailable'), 'load_complaints');
      assert.strictEqual(containsTechnicalJargon(loadErr), false);

      assert.strictEqual(formatImageReviewStatusLabel('VALID_CIVIC_ISSUE'), 'Civic Issue Confirmed');
      assert.strictEqual(formatImageReviewStatusLabel('POSSIBLE_CIVIC_ISSUE_NEEDS_REVIEW'), 'Needs Manual Review');
      assert.strictEqual(formatImageReviewStatusLabel('UNRELATED_IMAGE'), 'May Not Show a Civic Issue');
    } finally {
      console.error = origConsoleError;
    }
  });

  // Scenario 11: Citizen & Admin Portal UI source audit for jargon removal & feature wiring
  await runTest('11. Citizen & Admin portals contain no user-facing Firebase/Firestore jargon and wire Archive + Reopen cleanly', () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf-8');

    const adminDashboard = read('src/components/admin/AdminDashboard.tsx');
    const adminModal = read('src/components/admin/AdminReportDetailsModal.tsx');
    const adminLogin = read('src/components/admin/AdminLoginScreen.tsx');
    const citizenAuth = read('src/components/screens/AuthScreen.tsx');
    const appTsx = read('src/App.tsx');
    const authService = read('src/services/authService.ts');

    // UI wiring checks
    assert(adminDashboard.includes('archiveReportByAdmin'), 'AdminDashboard uses archiveReportByAdmin');
    assert(!adminDashboard.includes('deleteReportByAdmin'), 'AdminDashboard no longer calls destructive deleteReportByAdmin');
    assert(adminDashboard.includes('Archive Complaint'), 'AdminDashboard renders explicit Archive Complaint confirmation');
    assert(adminDashboard.includes('reports.filter((r) => !r.archived)'), 'AdminDashboard excludes archived reports from active list');

    assert(adminModal.includes('reopenWithdrawnReportByAdmin'), 'AdminReportDetailsModal wires reopenWithdrawnReportByAdmin');
    assert(adminModal.includes('Reopen Complaint'), 'AdminReportDetailsModal renders explicit Reopen Complaint button');
    assert(adminModal.includes('formatImageReviewStatusLabel'), 'AdminReportDetailsModal formats image review labels cleanly');

    // User-facing technical jargon regression checks
    const forbiddenUiPhrases = [
      'Checking Firebase Session',
      'via Firebase Authentication',
      'saved to Cloud Firestore',
      'Cloud Storage fallback',
      'Firebase Console',
      'Firestore rules enforce',
      'AI Evidence Advisory',
    ];

    for (const [label, source] of [
      ['AdminDashboard.tsx', adminDashboard],
      ['AdminReportDetailsModal.tsx', adminModal],
      ['AdminLoginScreen.tsx', adminLogin],
      ['AuthScreen.tsx', citizenAuth],
      ['App.tsx', appTsx],
      ['authService.ts', authService],
    ]) {
      for (const phrase of forbiddenUiPhrases) {
        assert.strictEqual(
          source.includes(phrase),
          false,
          `${label} must not contain technical UI phrase "${phrase}"`
        );
      }
    }
  });

  // Scenario 12: Server timestamp preservation & backward compatibility for archived records
  await runTest(
    '12. sanitizeForFirestore preserves serverTimestamp()/Timestamp and readers handle Firestore Timestamp + legacy ISO archivedAt',
    () => {
      const sentinel = serverTimestamp();
      const tsInstance = Timestamp.fromDate(new Date('2026-11-19T10:15:30.000Z'));

      const sanitized = sanitizeForFirestore({
        archived: true,
        archivedAt: sentinel,
        existingTs: tsInstance,
        optionalUndefined: undefined,
        nested: { keep: 'ok', drop: undefined },
      });

      assert.strictEqual(
        sanitized.archivedAt,
        sentinel,
        'sanitizeForFirestore must preserve FieldValue serverTimestamp() sentinel verbatim'
      );
      assert.strictEqual(
        sanitized.archivedAt instanceof FieldValue,
        true,
        'Preserved archivedAt sentinel remains a real Firestore FieldValue instance'
      );
      assert.strictEqual(
        sanitized.existingTs,
        tsInstance,
        'sanitizeForFirestore must preserve Firestore Timestamp instances verbatim'
      );
      assert.strictEqual('optionalUndefined' in sanitized, false);
      assert.strictEqual('drop' in sanitized.nested, false);
      assert.strictEqual(sanitized.nested.keep, 'ok');

      // Reader normalization across Firestore Timestamp, serialized seconds/nanoseconds, legacy ISO, Date, and missing
      const fromLiveTimestamp = mapFirestoreDocToReport('rep-ts-1', {
        status: 'Submitted',
        submittedAt: '2026-11-10T08:00:00.000Z',
        updatedAt: '2026-11-19T10:15:30.000Z',
        archived: true,
        archivedAt: tsInstance,
        archivedBy: 'admin-1',
      });
      assert.strictEqual(fromLiveTimestamp.archivedAt, '2026-11-19T10:15:30.000Z');
      assert.strictEqual(fromLiveTimestamp.updatedAt, '2026-11-19T10:15:30.000Z');

      const fromSerializedSeconds = mapFirestoreDocToReport('rep-ts-2', {
        status: 'Withdrawn',
        submittedAt: '2026-11-09T08:00:00.000Z',
        updatedAt: '2026-11-18T12:00:00.000Z',
        archived: true,
        archivedAt: { seconds: 1795083330, nanoseconds: 0 },
        archivedBy: 'admin-1',
      });
      assert.strictEqual(
        parseReportTimestamp(fromSerializedSeconds.archivedAt),
        1795083330 * 1000
      );

      const fromLegacyIso = mapFirestoreDocToReport('rep-ts-3', {
        status: 'Resolved',
        submittedAt: '2026-11-08T08:00:00.000Z',
        updatedAt: '2026-11-12T10:00:00.000Z',
        archived: true,
        archivedAt: '2026-11-12T10:00:00.000Z',
        archivedBy: 'admin-legacy',
      });
      assert.strictEqual(fromLegacyIso.archivedAt, '2026-11-12T10:00:00.000Z');

      const fromMissingArchiveDate = mapFirestoreDocToReport('rep-ts-4', {
        status: 'Submitted',
        submittedAt: '2026-11-07T08:00:00.000Z',
        updatedAt: '2026-11-07T08:00:00.000Z',
        archived: false,
      });
      assert.strictEqual(fromMissingArchiveDate.archivedAt, undefined);
      assert.strictEqual(normalizeOptionalReportTimestamp(null), undefined);
      assert.strictEqual(normalizeOptionalReportTimestamp(''), undefined);

      // Display formatting & sorting work seamlessly for both raw Firestore Timestamp and ISO strings
      assert.notStrictEqual(formatReportDate(tsInstance), 'Date unavailable');
      assert.notStrictEqual(formatReportDateTime(tsInstance), 'Date unavailable');
      assert.strictEqual(
        formatReportDate(tsInstance),
        formatReportDate('2026-11-19T10:15:30.000Z')
      );
      assert.strictEqual(formatReportDateTime(undefined), 'Date unavailable');

      const sorted = sortReportsNewestFirst([fromLegacyIso, fromLiveTimestamp, fromSerializedSeconds]);
      assert.deepStrictEqual(
        sorted.map((r) => r.id),
        ['rep-ts-1', 'rep-ts-2', 'rep-ts-3']
      );

      // syncSelectedReport compares Timestamp-valued archivedAt accurately
      const reportWithRawTsA = makeReport({ id: 'sync-1', archived: true, archivedAt: tsInstance });
      const reportWithRawTsB = makeReport({
        id: 'sync-1',
        archived: true,
        archivedAt: Timestamp.fromDate(new Date('2026-11-19T10:15:30.000Z')),
      });
      const reportWithDifferentTs = makeReport({
        id: 'sync-1',
        archived: true,
        archivedAt: Timestamp.fromDate(new Date('2026-11-19T11:00:00.000Z')),
      });
      assert.strictEqual(syncSelectedReport(reportWithRawTsA, [reportWithRawTsB]), reportWithRawTsA);
      assert.strictEqual(
        syncSelectedReport(reportWithRawTsA, [reportWithDifferentTs]),
        reportWithDifferentTs
      );
      assert.strictEqual(
        normalizeOptionalReportTimestamp(serverTimestamp()),
        undefined,
        'normalizeOptionalReportTimestamp must never leak a FieldValue sentinel'
      );
    }
  );

  // Scenario 13: Atomic rollback prevents partial archive or orphaned audit log on failure
  await runTest(
    '13. Failed atomic archive transaction leaves neither a partially archived complaint nor an orphaned audit log',
    async () => {
      const initialA = makeReport({ id: 'rep-atomic-1', trackingNumber: 'CFX-2026-ATM-1' });
      const harnessAuditFail = createInMemoryFirestoreHarness(
        { 'rep-atomic-1': initialA },
        { failOnWriteCollection: 'auditLogs' }
      );

      const originalConsoleError = console.error;
      console.error = () => {};
      try {
        const resAuditFail = await archiveReportByAdmin('rep-atomic-1', 'Test atomic rollback', {
          currentUser: { uid: 'super-uid-1', email: 'super@municipality.gov' },
          dbInstance: harnessAuditFail.dbInstance,
          verifyAdminFn: async () => ({
            authorized: true,
            admin: { uid: 'super-uid-1', email: 'super@municipality.gov', role: 'superadmin' },
          }),
          docFn: harnessAuditFail.docFn,
          collectionFn: harnessAuditFail.collectionFn,
          getDocFn: harnessAuditFail.getDocFn,
          runTransactionFn: harnessAuditFail.runTransactionFn,
        });

        assert.strictEqual(resAuditFail.success, false);
        assert.strictEqual(
          harnessAuditFail.reports['rep-atomic-1'].archived,
          undefined,
          'Complaint must NOT be partially archived when audit log write fails'
        );
        assert.strictEqual(
          harnessAuditFail.auditLogs.length,
          0,
          'No orphaned audit log may exist when atomic commit fails'
        );

        const initialB = makeReport({ id: 'rep-atomic-2', trackingNumber: 'CFX-2026-ATM-2' });
        const harnessReportFail = createInMemoryFirestoreHarness(
          { 'rep-atomic-2': initialB },
          { failOnWriteCollection: 'civic_reports' }
        );

        const resReportFail = await archiveReportByAdmin('rep-atomic-2', 'Test report failure rollback', {
          currentUser: { uid: 'super-uid-1', email: 'super@municipality.gov' },
          dbInstance: harnessReportFail.dbInstance,
          verifyAdminFn: async () => ({
            authorized: true,
            admin: { uid: 'super-uid-1', email: 'super@municipality.gov', role: 'superadmin' },
          }),
          docFn: harnessReportFail.docFn,
          collectionFn: harnessReportFail.collectionFn,
          getDocFn: harnessReportFail.getDocFn,
          runTransactionFn: harnessReportFail.runTransactionFn,
        });

        assert.strictEqual(resReportFail.success, false);
        assert.strictEqual(harnessReportFail.reports['rep-atomic-2'].archived, undefined);
        assert.strictEqual(
          harnessReportFail.auditLogs.length,
          0,
          'No orphaned audit log may be written when complaint update fails'
        );
      } finally {
        console.error = originalConsoleError;
      }

      // Also verify non-blocking refetch failure still returns success with archivedAt: undefined (never FieldValue)
      const initialC = makeReport({ id: 'rep-atomic-3', trackingNumber: 'CFX-2026-ATM-3' });
      const harnessRefetchFail = createInMemoryFirestoreHarness({ 'rep-atomic-3': initialC });
      const origWarn = console.warn;
      console.warn = () => {};
      try {
        const resRefetchFail = await archiveReportByAdmin('rep-atomic-3', 'Refetch transient error', {
          currentUser: { uid: 'super-uid-1', email: 'super@municipality.gov' },
          dbInstance: harnessRefetchFail.dbInstance,
          verifyAdminFn: async () => ({
            authorized: true,
            admin: { uid: 'super-uid-1', email: 'super@municipality.gov', role: 'superadmin' },
          }),
          docFn: harnessRefetchFail.docFn,
          collectionFn: harnessRefetchFail.collectionFn,
          getDocFn: (async () => {
            throw new Error('transient network timeout');
          }) as any,
          runTransactionFn: harnessRefetchFail.runTransactionFn,
        });

        assert.strictEqual(resRefetchFail.success, true);
        assert.strictEqual(resRefetchFail.archivedAt, undefined);
        assert.strictEqual(harnessRefetchFail.reports['rep-atomic-3'].archived, true);
        assert.strictEqual(harnessRefetchFail.auditLogs.length, 1);
      } finally {
        console.warn = origWarn;
      }
    }
  );

  console.log(`\nResults: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

main();
