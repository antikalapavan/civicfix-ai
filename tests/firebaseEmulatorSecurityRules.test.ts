import assert from 'node:assert';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  deleteDoc,
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import {
  deleteObject,
  getBytes,
  ref,
  uploadBytes,
  type FirebaseStorage,
} from 'firebase/storage';

const PROJECT_ID = 'demo-civifix-rules-test';
const ALLOWED_LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

function parseHostPort(envVal: string | undefined, defaultHost: string, defaultPort: number) {
  if (!envVal) {
    return { host: defaultHost, port: defaultPort };
  }
  const lastColon = envVal.lastIndexOf(':');
  if (lastColon === -1) {
    return { host: envVal, port: defaultPort };
  }
  const host = envVal.slice(0, lastColon).replace(/^\[|\]$/g, '');
  const port = Number(envVal.slice(lastColon + 1));
  return {
    host: host || defaultHost,
    port: Number.isFinite(port) && port > 0 ? port : defaultPort,
  };
}

function checkPortOpen(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function fsDb(ctx: RulesTestContext): Firestore {
  return ctx.firestore() as unknown as Firestore;
}

function stBucket(ctx: RulesTestContext): FirebaseStorage {
  return ctx.storage() as unknown as FirebaseStorage;
}

function makeReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const id = typeof overrides.id === 'string' ? overrides.id : 'rep-default';
  return {
    id,
    trackingNumber: 'CFX-2026-5001',
    userId: 'citizen-a',
    citizenName: 'Citizen A',
    citizenEmail: 'citizen.a@example.com',
    category: 'Potholes',
    title: 'Deep pothole near school gate',
    description: 'Large pothole causing traffic hazard near main entrance.',
    photoUrl: '',
    location: {
      address: 'School Road, Ward 3',
      latitude: 17.4,
      longitude: 78.5,
      ward: 'Ward 3',
    },
    severity: 'High',
    status: 'Submitted',
    submittedAt: '2026-11-18T00:00:00.000Z',
    updatedAt: '2026-11-18T00:00:00.000Z',
    department: 'Roads & Infrastructure Maintenance',
    slaDeadline: '24 Hours',
    timeline: [
      {
        status: 'Submitted',
        timestamp: '2026-11-18T00:00:00.000Z',
        note: 'Complaint submitted by citizen',
        officer: 'Citizen',
      },
    ],
    citizenNotes: [],
    isDemo: false,
    ...overrides,
  };
}

const SAMPLE_JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
const SAMPLE_PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

async function seedFixtureData(testEnv: RulesTestEnvironment): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = fsDb(ctx);
    const storage = stBucket(ctx);

    // Admin directory fixtures
    await setDoc(doc(db, 'admins', 'admin-super'), {
      uid: 'admin-super',
      email: 'super@civifix.gov',
      displayName: 'Primary Superadmin',
      role: 'superadmin',
      active: true,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    });
    await setDoc(doc(db, 'admins', 'admin-dept'), {
      uid: 'admin-dept',
      email: 'dept@civifix.gov',
      displayName: 'Department Head',
      role: 'department_head',
      department: 'Roads & Infrastructure Maintenance',
      active: true,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    });
    await setDoc(doc(db, 'admins', 'admin-ward'), {
      uid: 'admin-ward',
      email: 'ward@civifix.gov',
      displayName: 'Ward Administrator',
      role: 'ward_admin',
      ward: 'Ward 3',
      active: true,
    });
    await setDoc(doc(db, 'admins', 'admin-staff'), {
      uid: 'admin-staff',
      email: 'staff@civifix.gov',
      displayName: 'Field Staff',
      role: 'staff',
      active: true,
    });
    await setDoc(doc(db, 'admins', 'admin-deactivated'), {
      uid: 'admin-deactivated',
      email: 'inactive@civifix.gov',
      displayName: 'Deactivated Superadmin',
      role: 'superadmin',
      active: false,
    });
    await setDoc(doc(db, 'admins', 'admin-missing-role'), {
      uid: 'admin-missing-role',
      email: 'norole@civifix.gov',
      active: true,
    });

    // Civic reports fixtures
    await setDoc(
      doc(db, 'civic_reports', 'rep-citizen-a'),
      makeReport({ id: 'rep-citizen-a', trackingNumber: 'CFX-2026-5001', userId: 'citizen-a' })
    );
    await setDoc(
      doc(db, 'civic_reports', 'rep-citizen-b'),
      makeReport({ id: 'rep-citizen-b', trackingNumber: 'CFX-2026-5002', userId: 'citizen-b' })
    );
    await setDoc(
      doc(db, 'civic_reports', 'rep-archived-a'),
      makeReport({
        id: 'rep-archived-a',
        trackingNumber: 'CFX-2026-5003',
        userId: 'citizen-a',
        status: 'Submitted',
        archived: true,
        archivedAt: Timestamp.fromDate(new Date('2026-11-19T10:00:00.000Z')),
        archivedBy: 'admin-super',
        archiveReason: 'Duplicate submission',
      })
    );
    await setDoc(
      doc(db, 'civic_reports', 'rep-withdrawn-a'),
      makeReport({
        id: 'rep-withdrawn-a',
        trackingNumber: 'CFX-2026-5004',
        userId: 'citizen-a',
        status: 'Withdrawn',
        withdrawnAt: '2026-11-19T08:00:00.000Z',
        withdrawnBy: 'citizen-a',
        withdrawalReason: 'Resolved privately',
      })
    );
    await setDoc(
      doc(db, 'civic_reports', 'rep-for-dept-archive'),
      makeReport({ id: 'rep-for-dept-archive', trackingNumber: 'CFX-2026-5005', userId: 'citizen-b' })
    );
    await setDoc(
      doc(db, 'civic_reports', 'rep-for-claim-archive'),
      makeReport({ id: 'rep-for-claim-archive', trackingNumber: 'CFX-2026-5006', userId: 'citizen-b' })
    );
    await setDoc(
      doc(db, 'civic_reports', 'rep-for-delete'),
      makeReport({ id: 'rep-for-delete', trackingNumber: 'CFX-2026-5007', userId: 'citizen-b' })
    );

    // Status history & audit log fixtures
    await setDoc(doc(db, 'civic_reports', 'rep-citizen-b', 'statusHistory', 'hist-b-1'), {
      reportId: 'rep-citizen-b',
      fromStatus: null,
      toStatus: 'Submitted',
      changedByUid: 'citizen-b',
      changedByRole: 'citizen',
      timestamp: '2026-11-18T00:00:00.000Z',
    });
    await setDoc(doc(db, 'auditLogs', 'existing-log-1'), {
      action: 'report_created',
      targetType: 'civic_report',
      targetId: 'rep-citizen-b',
      actorUid: 'citizen-b',
      actorRole: 'citizen',
      summary: 'Initial report submitted.',
      timestamp: '2026-11-18T00:00:00.000Z',
    });

    // Seed Storage objects (bypassing rules) to verify read/delete authorization
    await uploadBytes(
      ref(storage, 'reports/citizen-b/rep-citizen-b/evidence.jpg'),
      SAMPLE_JPEG_BYTES,
      { contentType: 'image/jpeg' }
    );
    await uploadBytes(
      ref(storage, 'reports/rep-citizen-b/legacy.jpg'),
      SAMPLE_JPEG_BYTES,
      { contentType: 'image/jpeg' }
    );
    await uploadBytes(
      ref(storage, 'resolutions/rep-citizen-b/resolved.jpg'),
      SAMPLE_JPEG_BYTES,
      { contentType: 'image/jpeg' }
    );
  });
}

async function runEmulatorSecurityRulesSuite(): Promise<void> {
  console.log('--- RUNNING CIVIFIX AI REAL FIREBASE EMULATOR SECURITY RULES SUITE ---');

  assert(
    PROJECT_ID.startsWith('demo-'),
    'Safety guard: Emulator test projectId MUST use a demo-* namespace to prevent any live Firebase connection.'
  );

  const firestoreEndpoint = parseHostPort(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1', 8088);
  const storageEndpoint = parseHostPort(process.env.FIREBASE_STORAGE_EMULATOR_HOST, '127.0.0.1', 9199);

  assert(
    ALLOWED_LOCAL_HOSTS.has(firestoreEndpoint.host) && ALLOWED_LOCAL_HOSTS.has(storageEndpoint.host),
    `Safety guard: Emulators must bind strictly to localhost/127.0.0.1 (got firestore=${firestoreEndpoint.host}, storage=${storageEndpoint.host}).`
  );

  const [firestoreReachable, storageReachable] = await Promise.all([
    checkPortOpen(firestoreEndpoint.host, firestoreEndpoint.port),
    checkPortOpen(storageEndpoint.host, storageEndpoint.port),
  ]);

  if (!firestoreReachable || !storageReachable) {
    console.error(
      `Firebase Emulators are not reachable (firestore ${firestoreEndpoint.host}:${firestoreEndpoint.port}=${firestoreReachable}, storage ${storageEndpoint.host}:${storageEndpoint.port}=${storageReachable}).`
    );
    console.error(
      'Run this suite inside the Firebase Emulator Suite (requires Java 11+ and firebase-tools):\n  npm run test:rules:emulator'
    );
    process.exit(1);
  }

  const rootDir = process.cwd();
  const firestoreRules = fs.readFileSync(path.resolve(rootDir, 'firestore.rules'), 'utf8');
  const storageRules = fs.readFileSync(path.resolve(rootDir, 'storage.rules'), 'utf8');

  const testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: firestoreEndpoint.host,
      port: firestoreEndpoint.port,
      rules: firestoreRules,
    },
    storage: {
      host: storageEndpoint.host,
      port: storageEndpoint.port,
      rules: storageRules,
    },
  });

  try {
    await testEnv.clearFirestore();
    await testEnv.clearStorage();
    await seedFixtureData(testEnv);

    // Reusable auth contexts
    const unauthed = testEnv.unauthenticatedContext();
    const citizenA = testEnv.authenticatedContext('citizen-a', { email: 'citizen.a@example.com' });
    const citizenB = testEnv.authenticatedContext('citizen-b', { email: 'citizen.b@example.com' });
    const emailSpoofCitizen = testEnv.authenticatedContext('citizen-spoof', {
      email: 'super@civifix.gov',
      email_verified: true,
      role: 'superadmin',
    });

    const superAdmin = testEnv.authenticatedContext('admin-super', { email: 'super@civifix.gov' });
    const deptHead = testEnv.authenticatedContext('admin-dept', {
      email: 'dept@civifix.gov',
      admin: true,
      role: 'superadmin', // Stale claim must NOT override /admins/admin-dept role
    });
    const wardAdmin = testEnv.authenticatedContext('admin-ward', {
      email: 'ward@civifix.gov',
      admin: true,
      role: 'superadmin', // Stale claim must NOT override /admins/admin-ward role
    });
    const staffAdmin = testEnv.authenticatedContext('admin-staff', {
      email: 'staff@civifix.gov',
      admin: true,
      role: 'superadmin', // Stale claim must NOT override /admins/admin-staff role
    });
    const deactivatedSuper = testEnv.authenticatedContext('admin-deactivated', {
      email: 'inactive@civifix.gov',
      admin: true,
      active: true,
      role: 'superadmin',
    });
    const missingRoleAdmin = testEnv.authenticatedContext('admin-missing-role', {
      email: 'norole@civifix.gov',
      admin: true,
      role: 'superadmin',
    });
    const claimOnlySuper = testEnv.authenticatedContext('claim-super-1', {
      admin: true,
      role: 'superadmin',
    });
    const claimOnlyDeptHead = testEnv.authenticatedContext('claim-dept-1', {
      admin: true,
      role: 'department_head',
    });
    const claimOnlyBareAdmin = testEnv.authenticatedContext('claim-bare-1', {
      admin: true,
    });
    const claimOnlyDeactivated = testEnv.authenticatedContext('claim-inactive-1', {
      admin: true,
      active: false,
      role: 'superadmin',
    });

    // =========================================================================
    // 1. CITIZEN CANNOT ACCESS ANOTHER CITIZEN'S COMPLAINT
    // =========================================================================
    await assertFails(getDoc(doc(fsDb(unauthed), 'civic_reports', 'rep-citizen-b')));
    await assertFails(getDoc(doc(fsDb(citizenA), 'civic_reports', 'rep-citizen-b')));
    await assertFails(
      getDoc(doc(fsDb(citizenA), 'civic_reports', 'rep-citizen-b', 'statusHistory', 'hist-b-1'))
    );
    await assertFails(getDoc(doc(fsDb(deactivatedSuper), 'civic_reports', 'rep-citizen-b')));
    await assertFails(getDoc(doc(fsDb(claimOnlyDeactivated), 'civic_reports', 'rep-citizen-b')));
    await assertSucceeds(getDoc(doc(fsDb(citizenB), 'civic_reports', 'rep-citizen-b')));
    await assertSucceeds(
      getDoc(doc(fsDb(citizenB), 'civic_reports', 'rep-citizen-b', 'statusHistory', 'hist-b-1'))
    );
    await assertSucceeds(getDoc(doc(fsDb(staffAdmin), 'civic_reports', 'rep-citizen-b')));
    console.log("  ✓ 1. Citizen cannot access another citizen's complaint (owner & active admin reads allowed)");

    // =========================================================================
    // 2. CITIZEN CANNOT MODIFY ARCHIVED COMPLAINTS (NOTES, WITHDRAWAL, HISTORY, AUDIT)
    // =========================================================================
    await assertFails(
      updateDoc(doc(fsDb(citizenA), 'civic_reports', 'rep-archived-a'), {
        citizenNotes: ['Attempting follow-up note on archived complaint'],
        updatedAt: '2026-11-20T09:00:00.000Z',
      })
    );
    await assertFails(
      updateDoc(doc(fsDb(citizenA), 'civic_reports', 'rep-archived-a'), {
        status: 'Withdrawn',
        withdrawnBy: 'citizen-a',
        withdrawnAt: '2026-11-20T09:00:00.000Z',
        withdrawalReason: 'Trying to withdraw archived complaint',
        timeline: [
          {
            status: 'Withdrawn',
            timestamp: '2026-11-20T09:00:00.000Z',
            note: 'Withdrawn by citizen',
          },
        ],
        updatedAt: '2026-11-20T09:00:00.000Z',
      })
    );
    await assertFails(
      setDoc(doc(fsDb(citizenA), 'civic_reports', 'rep-archived-a', 'statusHistory', 'hist-archived-deny'), {
        reportId: 'rep-archived-a',
        fromStatus: 'Submitted',
        toStatus: 'Withdrawn',
        changedByUid: 'citizen-a',
        changedByRole: 'citizen',
        timestamp: '2026-11-20T09:00:00.000Z',
      })
    );
    await assertFails(
      setDoc(doc(fsDb(citizenA), 'auditLogs', 'citizen-archived-log-deny'), {
        action: 'report_withdrawn',
        targetType: 'civic_report',
        targetId: 'rep-archived-a',
        actorUid: 'citizen-a',
        actorRole: 'citizen',
        summary: 'Forged withdrawal log on archived complaint.',
        timestamp: '2026-11-20T09:00:00.000Z',
      })
    );

    // Non-archived citizen operations still succeed
    await assertSucceeds(
      updateDoc(doc(fsDb(citizenA), 'civic_reports', 'rep-citizen-a'), {
        citizenNotes: ['Valid follow-up note on non-archived complaint'],
        updatedAt: '2026-11-20T09:05:00.000Z',
      })
    );
    await assertSucceeds(
      updateDoc(doc(fsDb(citizenA), 'civic_reports', 'rep-citizen-a'), {
        status: 'Withdrawn',
        withdrawnBy: 'citizen-a',
        withdrawnAt: '2026-11-20T09:06:00.000Z',
        withdrawalReason: 'Issue resolved privately.',
        timeline: [
          {
            status: 'Submitted',
            timestamp: '2026-11-18T00:00:00.000Z',
            note: 'Complaint submitted by citizen',
            officer: 'Citizen',
          },
          {
            status: 'Withdrawn',
            timestamp: '2026-11-20T09:06:00.000Z',
            note: 'Withdrawn by citizen',
          },
        ],
        updatedAt: '2026-11-20T09:06:00.000Z',
      })
    );
    await assertSucceeds(
      setDoc(doc(fsDb(citizenA), 'civic_reports', 'rep-citizen-a', 'statusHistory', 'hist-withdraw-ok'), {
        reportId: 'rep-citizen-a',
        fromStatus: 'Submitted',
        toStatus: 'Withdrawn',
        changedByUid: 'citizen-a',
        changedByRole: 'citizen',
        timestamp: '2026-11-20T09:06:00.000Z',
      })
    );
    await assertSucceeds(
      setDoc(doc(fsDb(citizenA), 'auditLogs', 'citizen-withdraw-log-ok'), {
        action: 'report_withdrawn',
        targetType: 'civic_report',
        targetId: 'rep-citizen-a',
        actorUid: 'citizen-a',
        actorRole: 'citizen',
        summary: 'Citizen withdrew complaint CFX-2026-5001.',
        timestamp: '2026-11-20T09:06:00.000Z',
      })
    );
    console.log('  ✓ 2. Citizen cannot modify archived complaints (non-archived citizen writes preserved)');

    // =========================================================================
    // 3. ACTIVE STAFF CAN UPDATE COMPLAINT STATUS (AND RESOLUTION RULES ENFORCED)
    // =========================================================================
    await assertSucceeds(
      updateDoc(doc(fsDb(staffAdmin), 'civic_reports', 'rep-citizen-b'), {
        status: 'In Progress',
        assignedOfficer: 'K. Rao',
        updatedBy: 'admin-staff',
        updatedAt: '2026-11-20T09:10:00.000Z',
      })
    );
    await assertSucceeds(
      setDoc(doc(fsDb(staffAdmin), 'civic_reports', 'rep-citizen-b', 'statusHistory', 'hist-staff-1'), {
        reportId: 'rep-citizen-b',
        fromStatus: 'Submitted',
        toStatus: 'In Progress',
        changedByUid: 'admin-staff',
        changedByRole: 'admin',
        timestamp: '2026-11-20T09:10:00.000Z',
      })
    );
    // Resolved without resolutionDetails must fail
    await assertFails(
      updateDoc(doc(fsDb(staffAdmin), 'civic_reports', 'rep-citizen-b'), {
        status: 'Resolved',
        updatedBy: 'admin-staff',
        updatedAt: '2026-11-20T09:11:00.000Z',
      })
    );
    // Resolved WITH resolutionDetails succeeds
    await assertSucceeds(
      updateDoc(doc(fsDb(staffAdmin), 'civic_reports', 'rep-citizen-b'), {
        status: 'Resolved',
        resolutionDetails: 'Pothole patched and compacted with fresh asphalt.',
        resolvedAt: '2026-11-20T09:12:00.000Z',
        updatedBy: 'admin-staff',
        updatedAt: '2026-11-20T09:12:00.000Z',
      })
    );
    // Active staff cannot mutate an already-archived complaint
    await assertFails(
      updateDoc(doc(fsDb(staffAdmin), 'civic_reports', 'rep-archived-a'), {
        status: 'In Progress',
        updatedBy: 'admin-staff',
        updatedAt: '2026-11-20T09:13:00.000Z',
      })
    );
    // Citizen cannot update official status
    await assertFails(
      updateDoc(doc(fsDb(citizenB), 'civic_reports', 'rep-citizen-b'), {
        status: 'In Progress',
        updatedAt: '2026-11-20T09:14:00.000Z',
      })
    );
    console.log('  ✓ 3. Active staff can update complaint status (with resolution validation and archive protection)');

    // =========================================================================
    // 4. ONLY AUTHORIZED ROLES CAN ARCHIVE COMPLAINTS (ATOMIC + request.time + getAfter())
    // =========================================================================
    const buildAtomicArchiveBatch = (
      ctx: RulesTestContext,
      actorUid: string,
      reportId: string,
      auditDocId: string,
      overrides?: { archivedAt?: unknown; status?: string }
    ) => {
      const db = fsDb(ctx);
      const batch = writeBatch(db);
      const archivePayload: Record<string, unknown> = {
        archived: true,
        archivedAt: overrides?.archivedAt !== undefined ? overrides.archivedAt : serverTimestamp(),
        archivedBy: actorUid,
        archiveReason: 'Duplicate report verified',
        updatedAt: '2026-11-20T09:20:00.000Z',
        updatedBy: actorUid,
      };
      if (overrides?.status !== undefined) {
        archivePayload.status = overrides.status;
      }
      batch.update(doc(db, 'civic_reports', reportId), archivePayload);
      batch.set(doc(db, 'auditLogs', auditDocId), {
        action: 'report_archived',
        targetType: 'civic_report',
        targetId: reportId,
        actorUid,
        actorRole: 'admin',
        summary: `Archived complaint ${reportId}.`,
        timestamp: '2026-11-20T09:20:00.000Z',
      });
      return batch;
    };

    // Denied archive roles: ward_admin, staff, missing-role doc, bare admin claim, deactivated superadmin, citizen
    await assertFails(
      buildAtomicArchiveBatch(wardAdmin, 'admin-ward', 'rep-citizen-b', 'log-ward-deny').commit()
    );
    await assertFails(
      buildAtomicArchiveBatch(staffAdmin, 'admin-staff', 'rep-citizen-b', 'log-staff-deny').commit()
    );
    await assertFails(
      buildAtomicArchiveBatch(missingRoleAdmin, 'admin-missing-role', 'rep-citizen-b', 'log-norole-deny').commit()
    );
    await assertFails(
      buildAtomicArchiveBatch(claimOnlyBareAdmin, 'claim-bare-1', 'rep-citizen-b', 'log-bare-deny').commit()
    );
    await assertFails(
      buildAtomicArchiveBatch(deactivatedSuper, 'admin-deactivated', 'rep-citizen-b', 'log-inactive-deny').commit()
    );
    await assertFails(
      buildAtomicArchiveBatch(claimOnlyDeactivated, 'claim-inactive-1', 'rep-citizen-b', 'log-claim-inactive-deny').commit()
    );
    await assertFails(
      updateDoc(doc(fsDb(citizenB), 'civic_reports', 'rep-citizen-b'), {
        archived: true,
        archivedAt: serverTimestamp(),
        archivedBy: 'citizen-b',
        updatedAt: '2026-11-20T09:20:00.000Z',
        updatedBy: 'citizen-b',
      })
    );
    // Citizen cannot create report with archive fields
    await assertFails(
      setDoc(doc(fsDb(citizenA), 'civic_reports', 'rep-forged-create'), {
        ...makeReport({ id: 'rep-forged-create', userId: 'citizen-a' }),
        archived: true,
      })
    );
    // Client-supplied ISO string or client Timestamp for archivedAt must fail (requires server request.time)
    await assertFails(
      buildAtomicArchiveBatch(superAdmin, 'admin-super', 'rep-citizen-b', 'log-iso-deny', {
        archivedAt: '2026-11-20T09:20:00.000Z',
      }).commit()
    );
    await assertFails(
      buildAtomicArchiveBatch(superAdmin, 'admin-super', 'rep-citizen-b', 'log-ts-deny', {
        archivedAt: Timestamp.fromDate(new Date('2026-11-19T00:00:00.000Z')),
      }).commit()
    );
    // Status change during archive must fail
    await assertFails(
      buildAtomicArchiveBatch(superAdmin, 'admin-super', 'rep-citizen-b', 'log-status-deny', {
        status: 'Withdrawn',
      }).commit()
    );

    // Authorized atomic archive via runTransaction (superadmin on Withdrawn report preserving status)
    const superDb = fsDb(superAdmin);
    await assertSucceeds(
      runTransaction(superDb, async (tx) => {
        const reportRef = doc(superDb, 'civic_reports', 'rep-withdrawn-a');
        const auditRef = doc(superDb, 'auditLogs', 'log-super-archive-ok');
        const snap = await tx.get(reportRef);
        assert(snap.exists(), 'rep-withdrawn-a exists');
        tx.update(reportRef, {
          archived: true,
          archivedAt: serverTimestamp(),
          archivedBy: 'admin-super',
          archiveReason: 'Archived withdrawn record',
          updatedAt: '2026-11-20T09:21:00.000Z',
          updatedBy: 'admin-super',
        });
        tx.set(auditRef, {
          action: 'report_archived',
          targetType: 'civic_report',
          targetId: 'rep-withdrawn-a',
          actorUid: 'admin-super',
          actorRole: 'admin',
          summary: 'Archived withdrawn complaint CFX-2026-5004.',
          timestamp: '2026-11-20T09:21:00.000Z',
        });
      })
    );
    // Authorized atomic archive by department_head
    await assertSucceeds(
      buildAtomicArchiveBatch(deptHead, 'admin-dept', 'rep-for-dept-archive', 'log-dept-archive-ok').commit()
    );
    // Authorized atomic archive by explicit claim-only department_head (no /admins doc)
    await assertSucceeds(
      buildAtomicArchiveBatch(
        claimOnlyDeptHead,
        'claim-dept-1',
        'rep-for-claim-archive',
        'log-claim-dept-archive-ok'
      ).commit()
    );
    // Re-archiving an already-archived report must fail
    await assertFails(
      buildAtomicArchiveBatch(superAdmin, 'admin-super', 'rep-withdrawn-a', 'log-rearchive-deny').commit()
    );
    // Hard delete on civic_reports strictly requires active superadmin (canManageAdmins)
    await assertFails(deleteDoc(doc(fsDb(deptHead), 'civic_reports', 'rep-for-delete')));
    await assertFails(deleteDoc(doc(fsDb(wardAdmin), 'civic_reports', 'rep-for-delete')));
    await assertFails(deleteDoc(doc(fsDb(staffAdmin), 'civic_reports', 'rep-for-delete')));
    await assertFails(deleteDoc(doc(fsDb(missingRoleAdmin), 'civic_reports', 'rep-for-delete')));
    await assertFails(deleteDoc(doc(fsDb(claimOnlyBareAdmin), 'civic_reports', 'rep-for-delete')));
    await assertFails(deleteDoc(doc(fsDb(deactivatedSuper), 'civic_reports', 'rep-for-delete')));
    await assertFails(deleteDoc(doc(fsDb(citizenB), 'civic_reports', 'rep-for-delete')));
    await assertSucceeds(deleteDoc(doc(fsDb(superAdmin), 'civic_reports', 'rep-for-delete')));
    console.log('  ✓ 4. Only authorized roles can archive complaints (atomic request.time + getAfter() verified)');

    // =========================================================================
    // 5. ONLY ACTIVE SUPERADMINS CAN MANAGE ADMIN ACCOUNTS
    // =========================================================================
    const validNewAdmin = {
      uid: 'admin-created-1',
      email: 'new.officer@civifix.gov',
      displayName: 'New Ward Officer',
      role: 'ward_admin',
      department: 'Roads & Infrastructure Maintenance',
      ward: 'Ward 9',
      active: true,
      createdAt: '2026-11-20T09:30:00.000Z',
      updatedAt: '2026-11-20T09:30:00.000Z',
    };

    // Active admins retain /admins read access; citizens & deactivated admins denied
    await assertSucceeds(getDoc(doc(fsDb(staffAdmin), 'admins', 'admin-super')));
    await assertSucceeds(getDoc(doc(fsDb(deptHead), 'admins', 'admin-super')));
    await assertFails(getDoc(doc(fsDb(citizenA), 'admins', 'admin-super')));
    await assertFails(getDoc(doc(fsDb(emailSpoofCitizen), 'admins', 'admin-super')));
    await assertFails(getDoc(doc(fsDb(deactivatedSuper), 'admins', 'admin-super')));

    // Non-superadmin & inactive actors cannot create/update/delete admin accounts
    for (const nonManager of [
      unauthed,
      citizenA,
      emailSpoofCitizen,
      staffAdmin,
      wardAdmin,
      deptHead,
      deactivatedSuper,
      claimOnlyBareAdmin,
      claimOnlyDeptHead,
      claimOnlyDeactivated,
    ]) {
      await assertFails(setDoc(doc(fsDb(nonManager), 'admins', 'admin-created-1'), validNewAdmin));
      await assertFails(
        updateDoc(doc(fsDb(nonManager), 'admins', 'admin-staff'), {
          role: 'superadmin',
          updatedAt: '2026-11-20T09:31:00.000Z',
        })
      );
      await assertFails(deleteDoc(doc(fsDb(nonManager), 'admins', 'admin-ward')));
    }

    // Active doc-backed superadmin can create, update, and delete another admin account
    await assertSucceeds(setDoc(doc(fsDb(superAdmin), 'admins', 'admin-created-1'), validNewAdmin));
    await assertSucceeds(
      updateDoc(doc(fsDb(superAdmin), 'admins', 'admin-created-1'), {
        role: 'department_head',
        updatedAt: '2026-11-20T09:32:00.000Z',
      })
    );
    await assertSucceeds(deleteDoc(doc(fsDb(superAdmin), 'admins', 'admin-created-1')));

    // Explicit claim-only superadmin (no /admins doc) can also manage other admin accounts
    await assertSucceeds(setDoc(doc(fsDb(claimOnlySuper), 'admins', 'admin-created-2'), {
      ...validNewAdmin,
      uid: 'admin-created-2',
    }));
    await assertSucceeds(deleteDoc(doc(fsDb(claimOnlySuper), 'admins', 'admin-created-2')));
    console.log('  ✓ 5. Only active superadmins can manage admin accounts');

    // =========================================================================
    // 6. SUPERADMINS CANNOT MODIFY OR DELETE THEIR OWN ADMIN DOCUMENTS
    // =========================================================================
    await assertFails(
      updateDoc(doc(fsDb(superAdmin), 'admins', 'admin-super'), {
        displayName: 'Self Modified Superadmin',
        updatedAt: '2026-11-20T09:35:00.000Z',
      })
    );
    await assertFails(
      updateDoc(doc(fsDb(superAdmin), 'admins', 'admin-super'), {
        active: false,
      })
    );
    await assertFails(deleteDoc(doc(fsDb(superAdmin), 'admins', 'admin-super')));
    console.log('  ✓ 6. Superadmins cannot modify or delete their own admin documents');

    // =========================================================================
    // 7. CITIZENS CANNOT FORGE ARCHIVE AUDIT LOGS (AND AUDIT INTEGRITY ENFORCED)
    // =========================================================================
    await assertFails(
      setDoc(doc(fsDb(citizenA), 'auditLogs', 'forged-citizen-archive-1'), {
        action: 'report_archived',
        targetType: 'civic_report',
        targetId: 'rep-archived-a',
        actorUid: 'citizen-a',
        actorRole: 'citizen',
        summary: 'Citizen attempting to forge archive audit log.',
        timestamp: '2026-11-20T09:40:00.000Z',
      })
    );
    await assertFails(
      setDoc(doc(fsDb(citizenA), 'auditLogs', 'forged-citizen-archive-2'), {
        action: 'report_archived',
        targetType: 'civic_report',
        targetId: 'rep-archived-a',
        actorUid: 'citizen-a',
        actorRole: 'admin',
        summary: 'Citizen spoofing admin actorRole for archive log.',
        timestamp: '2026-11-20T09:40:00.000Z',
      })
    );
    // Unauthorized admin role cannot forge report_archived audit log
    await assertFails(
      setDoc(doc(fsDb(wardAdmin), 'auditLogs', 'forged-ward-archive-log'), {
        action: 'report_archived',
        targetType: 'civic_report',
        targetId: 'rep-archived-a',
        actorUid: 'admin-ward',
        actorRole: 'admin',
        summary: 'Ward admin attempting to forge archive log.',
        timestamp: '2026-11-20T09:40:00.000Z',
      })
    );
    // Superadmin cannot log report_archived for an unarchived report
    await assertFails(
      setDoc(doc(fsDb(superAdmin), 'auditLogs', 'bogus-unarchived-log'), {
        action: 'report_archived',
        targetType: 'civic_report',
        targetId: 'rep-citizen-b',
        actorUid: 'admin-super',
        actorRole: 'admin',
        summary: 'Bogus log for active unarchived report.',
        timestamp: '2026-11-20T09:40:00.000Z',
      })
    );
    // Superadmin cannot log report_archived for a report archived by a different administrator
    await assertFails(
      setDoc(doc(fsDb(superAdmin), 'auditLogs', 'wrong-actor-archive-log'), {
        action: 'report_archived',
        targetType: 'civic_report',
        targetId: 'rep-for-dept-archive',
        actorUid: 'admin-super',
        actorRole: 'admin',
        summary: 'Superadmin attempting to claim archive performed by deptHead.',
        timestamp: '2026-11-20T09:40:00.000Z',
      })
    );
    // Audit logs are strictly immutable (no updates or deletes)
    await assertFails(
      updateDoc(doc(fsDb(superAdmin), 'auditLogs', 'existing-log-1'), {
        summary: 'Tampered audit log',
      })
    );
    await assertFails(deleteDoc(doc(fsDb(superAdmin), 'auditLogs', 'existing-log-1')));
    console.log('  ✓ 7. Citizens cannot forge archive audit logs (audit integrity & immutability verified)');

    // =========================================================================
    // 8. INVALID ADMIN FIELDS AND UID CHANGES ARE REJECTED
    // =========================================================================
    await assertFails(
      setDoc(doc(fsDb(superAdmin), 'admins', 'admin-bad-uid'), {
        ...validNewAdmin,
        uid: 'different-uid',
      })
    );
    await assertFails(
      setDoc(doc(fsDb(superAdmin), 'admins', 'admin-bad-role'), {
        ...validNewAdmin,
        uid: 'admin-bad-role',
        role: 'root_god_mode',
      })
    );
    await assertFails(
      setDoc(doc(fsDb(superAdmin), 'admins', 'admin-bad-active'), {
        ...validNewAdmin,
        uid: 'admin-bad-active',
        active: 'true',
      })
    );
    await assertFails(
      setDoc(doc(fsDb(superAdmin), 'admins', 'admin-extra-field'), {
        ...validNewAdmin,
        uid: 'admin-extra-field',
        extraPrivilege: true,
      })
    );
    await assertFails(
      setDoc(doc(fsDb(superAdmin), 'admins', 'admin-long-name'), {
        ...validNewAdmin,
        uid: 'admin-long-name',
        displayName: 'A'.repeat(151),
      })
    );
    await assertFails(
      setDoc(doc(fsDb(superAdmin), 'admins', 'admin-bad-dept'), {
        ...validNewAdmin,
        uid: 'admin-bad-dept',
        department: 42,
      })
    );
    // Existing admin UID cannot be altered on update
    await assertFails(
      updateDoc(doc(fsDb(superAdmin), 'admins', 'admin-staff'), {
        uid: 'hijacked-uid',
      })
    );
    // Unapproved fields rejected on update
    await assertFails(
      updateDoc(doc(fsDb(superAdmin), 'admins', 'admin-staff'), {
        secretBackdoor: true,
      })
    );
    console.log('  ✓ 8. Invalid admin fields and UID changes are rejected');

    // =========================================================================
    // 9. UNAUTHORIZED STORAGE UPLOADS AND DELETIONS ARE REJECTED
    // =========================================================================
    // Unauthenticated upload rejected
    await assertFails(
      uploadBytes(ref(stBucket(unauthed), 'reports/citizen-a/rep-citizen-a/unauth.jpg'), SAMPLE_JPEG_BYTES, {
        contentType: 'image/jpeg',
      })
    );
    // Citizen A cannot upload under Citizen B's scoped path
    await assertFails(
      uploadBytes(ref(stBucket(citizenA), 'reports/citizen-b/rep-citizen-b/hijack.jpg'), SAMPLE_JPEG_BYTES, {
        contentType: 'image/jpeg',
      })
    );
    // Citizen A cannot upload non-image MIME type
    await assertFails(
      uploadBytes(ref(stBucket(citizenA), 'reports/citizen-a/rep-citizen-a/doc.pdf'), SAMPLE_PDF_BYTES, {
        contentType: 'application/pdf',
      })
    );
    // Citizen A cannot upload image >= 5 MiB
    const oversizedBytes = new Uint8Array(5 * 1024 * 1024 + 1);
    await assertFails(
      uploadBytes(ref(stBucket(citizenA), 'reports/citizen-a/rep-citizen-a/huge.jpg'), oversizedBytes, {
        contentType: 'image/jpeg',
      })
    );
    // Citizen A cannot write to legacy un-scoped report path
    await assertFails(
      uploadBytes(ref(stBucket(citizenA), 'reports/rep-citizen-a/legacy-write.jpg'), SAMPLE_JPEG_BYTES, {
        contentType: 'image/jpeg',
      })
    );
    // Citizen A cannot upload or delete resolution evidence
    await assertFails(
      uploadBytes(ref(stBucket(citizenA), 'resolutions/rep-citizen-a/fake.jpg'), SAMPLE_JPEG_BYTES, {
        contentType: 'image/jpeg',
      })
    );
    await assertFails(deleteObject(ref(stBucket(citizenA), 'resolutions/rep-citizen-b/resolved.jpg')));
    // Deactivated admins (doc-backed or claim-only) cannot upload or delete resolution evidence
    await assertFails(
      uploadBytes(ref(stBucket(deactivatedSuper), 'resolutions/rep-citizen-b/stale.jpg'), SAMPLE_JPEG_BYTES, {
        contentType: 'image/jpeg',
      })
    );
    await assertFails(deleteObject(ref(stBucket(deactivatedSuper), 'resolutions/rep-citizen-b/resolved.jpg')));
    await assertFails(
      uploadBytes(ref(stBucket(claimOnlyDeactivated), 'resolutions/rep-citizen-b/stale2.jpg'), SAMPLE_JPEG_BYTES, {
        contentType: 'image/jpeg',
      })
    );
    // Active admin cannot upload non-image MIME type to resolutions
    await assertFails(
      uploadBytes(ref(stBucket(staffAdmin), 'resolutions/rep-citizen-b/not-image.pdf'), SAMPLE_PDF_BYTES, {
        contentType: 'application/pdf',
      })
    );
    // Citizen A cannot read Citizen B's scoped, legacy, or resolution images
    await assertFails(getBytes(ref(stBucket(citizenA), 'reports/citizen-b/rep-citizen-b/evidence.jpg')));
    await assertFails(getBytes(ref(stBucket(citizenA), 'reports/rep-citizen-b/legacy.jpg')));
    await assertFails(getBytes(ref(stBucket(citizenA), 'resolutions/rep-citizen-b/resolved.jpg')));
    await assertFails(getBytes(ref(stBucket(unauthed), 'reports/citizen-b/rep-citizen-b/evidence.jpg')));
    // Citizen cannot delete even their own complaint image (allow delete: if false)
    await assertFails(deleteObject(ref(stBucket(citizenB), 'reports/citizen-b/rep-citizen-b/evidence.jpg')));
    // Default deny catch-all path rejected
    await assertFails(
      uploadBytes(ref(stBucket(superAdmin), 'unknown-folder/file.jpg'), SAMPLE_JPEG_BYTES, {
        contentType: 'image/jpeg',
      })
    );
    console.log('  ✓ 9. Unauthorized Storage uploads, reads, and deletions are rejected');

    // =========================================================================
    // 10. AUTHORIZED COMPLAINT AND RESOLUTION IMAGE ACCESS WORKS
    // =========================================================================
    // Citizen A can upload & read their own scoped complaint photo
    await assertSucceeds(
      uploadBytes(ref(stBucket(citizenA), 'reports/citizen-a/rep-citizen-a/evidence.jpg'), SAMPLE_JPEG_BYTES, {
        contentType: 'image/jpeg',
      })
    );
    await assertSucceeds(getBytes(ref(stBucket(citizenA), 'reports/citizen-a/rep-citizen-a/evidence.jpg')));
    // Citizen B can read their own scoped, legacy, and resolution images (cross-service firestore.get)
    await assertSucceeds(getBytes(ref(stBucket(citizenB), 'reports/citizen-b/rep-citizen-b/evidence.jpg')));
    await assertSucceeds(getBytes(ref(stBucket(citizenB), 'reports/rep-citizen-b/legacy.jpg')));
    await assertSucceeds(getBytes(ref(stBucket(citizenB), 'resolutions/rep-citizen-b/resolved.jpg')));
    // Active admin can read scoped, legacy, and resolution images
    await assertSucceeds(getBytes(ref(stBucket(staffAdmin), 'reports/citizen-b/rep-citizen-b/evidence.jpg')));
    await assertSucceeds(getBytes(ref(stBucket(staffAdmin), 'reports/rep-citizen-b/legacy.jpg')));
    await assertSucceeds(getBytes(ref(stBucket(staffAdmin), 'resolutions/rep-citizen-b/resolved.jpg')));
    // Active admin can upload and delete resolution image
    await assertSucceeds(
      uploadBytes(ref(stBucket(staffAdmin), 'resolutions/rep-citizen-b/after-repair.jpg'), SAMPLE_JPEG_BYTES, {
        contentType: 'image/jpeg',
      })
    );
    await assertSucceeds(deleteObject(ref(stBucket(staffAdmin), 'resolutions/rep-citizen-b/after-repair.jpg')));
    console.log('  ✓ 10. Authorized complaint and resolution image access works (including cross-service Storage→Firestore checks)');

    console.log('--- ALL 10 REAL FIREBASE EMULATOR SECURITY RULES SCENARIOS PASSED ---');
  } finally {
    await testEnv.cleanup();
  }
}

runEmulatorSecurityRulesSuite().catch((err) => {
  console.error('Firebase Emulator Security Rules Test Suite FAILED:', err);
  process.exit(1);
});
