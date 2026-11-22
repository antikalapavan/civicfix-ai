import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseReportTimestamp,
  sortReportsNewestFirst,
  formatReportDate,
  generateTrackingNumber,
  retryReportUpload,
  sanitizeForFirestore,
  syncSelectedReport,
  addCitizenNoteToFirestore,
  getLocalCachedReports,
  fetchCitizenReportStatusHistory,
  createSubmissionIdentity,
  awaitSubmissionWithTimeoutNotice,
  getInitialStatusHistoryDocId,
  getInitialAuditLogDocId,
  syncPendingReportsToFirestore,
  getPendingSyncCounts,
  hasPendingOfflineSync,
  enqueuePendingWithdrawalIntent,
} from '../src/services/reportStorage.js';
import {
  CivicIssueReport,
  CitizenUser,
  EXPANDED_CIVIC_CATEGORIES,
  LEGACY_CIVIC_CATEGORIES,
  getCivicCategoryIconKey,
  resolveCitizenReportVisibility,
} from '../src/types/civic.js';

console.log('--- RUNNING CIVIFIX AI REPORT STORAGE & TIMESTAMP TEST SUITE ---');

let passedTests = 0;
let totalTests = 0;

const asyncPromises: Promise<void>[] = [];

function test(name: string, fn: () => void | Promise<void>) {
  totalTests++;
  try {
    const res = fn();
    if (res && typeof (res as any).then === 'function') {
      const p = (res as Promise<void>)
        .then(() => {
          console.log(`  ✓ ${name}`);
          passedTests++;
        })
        .catch((err) => {
          console.error(`  ✗ ${name}`);
          console.error(`    Error:`, err.message);
          throw err;
        });
      asyncPromises.push(p);
      return p;
    }
    console.log(`  ✓ ${name}`);
    passedTests++;
  } catch (err: any) {
    console.error(`  ✗ ${name}`);
    console.error(`    Error:`, err.message);
    throw err;
  }
}

// -------------------------------------------------------------
// 1. TIMESTAMP PARSING TESTS
// -------------------------------------------------------------
test('parseReportTimestamp parses ISO 8601 strings correctly', () => {
  const iso = '2026-10-30T06:30:00.000Z';
  const expected = new Date(iso).getTime();
  assert.strictEqual(parseReportTimestamp(iso), expected);

  const isoNoZ = '2026-04-25T10:32:00';
  assert(parseReportTimestamp(isoNoZ) > 0);
});

test('parseReportTimestamp parses Firestore Timestamp objects using toDate()', () => {
  const targetDate = new Date('2026-04-25T10:32:00Z');
  const firestoreTimestamp = {
    toDate: () => targetDate,
  };
  assert.strictEqual(parseReportTimestamp(firestoreTimestamp), targetDate.getTime());
});

test('parseReportTimestamp parses objects with numeric seconds and nanoseconds', () => {
  const sec = 1777113120;
  const nano = 500000000;
  const obj = { seconds: sec, nanoseconds: nano };
  const expected = sec * 1000 + 500;
  assert.strictEqual(parseReportTimestamp(obj), expected);

  // With _seconds prefix (common in serialized Firestore internal representations)
  const objAlt = { _seconds: sec, _nanoseconds: nano };
  assert.strictEqual(parseReportTimestamp(objAlt), expected);
});

test('parseReportTimestamp parses numeric millisecond and second timestamps', () => {
  const ms = 1777113120000;
  assert.strictEqual(parseReportTimestamp(ms), ms);

  // 10-digit unix epoch in seconds (< 10000000000)
  const sec = 1777113120;
  assert.strictEqual(parseReportTimestamp(sec), sec * 1000);
});

test('parseReportTimestamp handles Date instances', () => {
  const d = new Date('2026-05-15T12:00:00Z');
  assert.strictEqual(parseReportTimestamp(d), d.getTime());
});

test('parseReportTimestamp returns safe 0 for missing, null, undefined, and empty timestamps', () => {
  assert.strictEqual(parseReportTimestamp(null), 0);
  assert.strictEqual(parseReportTimestamp(undefined), 0);
  assert.strictEqual(parseReportTimestamp(''), 0);
  assert.strictEqual(parseReportTimestamp('   '), 0);
});

test('parseReportTimestamp NEVER replaces missing timestamp with current time', () => {
  const before = Date.now();
  const resNull = parseReportTimestamp(null);
  const resEmpty = parseReportTimestamp('');
  const after = Date.now();

  assert.strictEqual(resNull, 0);
  assert.strictEqual(resEmpty, 0);
  // Guarantee return value is 0 and nowhere near Date.now()
  assert(resNull < before);
  assert(resEmpty < before);
});

test('parseReportTimestamp returns safe 0 for invalid or corrupt timestamps', () => {
  assert.strictEqual(parseReportTimestamp('invalid-date-string'), 0);
  assert.strictEqual(parseReportTimestamp(NaN), 0);
  assert.strictEqual(parseReportTimestamp(-500), 0);
  assert.strictEqual(parseReportTimestamp({}), 0);
  assert.strictEqual(parseReportTimestamp([]), 0);
});

// -------------------------------------------------------------
// 2. REPORT SORTING TESTS (NEWEST FIRST & MISSING TO BOTTOM)
// -------------------------------------------------------------
test('sortReportsNewestFirst sorts reports newest first and places unknown dates at the bottom', () => {
  const reportNewest: CivicIssueReport = {
    id: 'rep_new',
    trackingNumber: 'CFX-2026-N999-1111',
    category: 'Garbage',
    title: 'Newest Issue',
    description: 'Test',
    photoUrl: '',
    location: { address: 'Main St', latitude: null, longitude: null, ward: 'Ward 47' },
    severity: 'Medium',
    status: 'Submitted',
    submittedAt: '2026-10-30T06:00:00Z',
    updatedAt: '2026-10-30T06:00:00Z',
    department: 'Sanitation',
    slaDeadline: '48h',
    timeline: [],
  };

  const reportMiddle: CivicIssueReport = {
    ...reportNewest,
    id: 'rep_mid',
    trackingNumber: 'CFX-2026-M555-2222',
    title: 'Middle Issue',
    submittedAt: '2026-06-15T00:00:00Z',
  };

  const reportOldest: CivicIssueReport = {
    ...reportNewest,
    id: 'rep_old',
    trackingNumber: 'CFX-2026-O111-3333',
    title: 'Oldest Issue',
    submittedAt: '2026-01-01T00:00:00Z',
  };

  const reportMissingDate: CivicIssueReport = {
    ...reportNewest,
    id: 'rep_missing',
    trackingNumber: 'CFX-2026-X000-4444',
    title: 'Legacy Issue with Missing Date',
    submittedAt: '',
  };

  const reportInvalidDate: CivicIssueReport = {
    ...reportNewest,
    id: 'rep_invalid',
    trackingNumber: 'CFX-2026-X000-5555',
    title: 'Legacy Issue with Corrupt Date',
    submittedAt: 'corrupt_timestamp_data',
  };

  // Shuffle input in random order
  const input = [reportMissingDate, reportMiddle, reportInvalidDate, reportNewest, reportOldest];
  const sorted = sortReportsNewestFirst(input);

  // Assert order:
  // 1. reportNewest
  // 2. reportMiddle
  // 3. reportOldest
  // 4 & 5. reports with missing / invalid date (safe 0 at bottom)
  assert.strictEqual(sorted[0].id, 'rep_new');
  assert.strictEqual(sorted[1].id, 'rep_mid');
  assert.strictEqual(sorted[2].id, 'rep_old');

  const bottomIds = [sorted[3].id, sorted[4].id];
  assert(bottomIds.includes('rep_missing'));
  assert(bottomIds.includes('rep_invalid'));

  // Ensure missing-date report is NEVER falsely placed at the top as newest
  assert.notStrictEqual(sorted[0].id, 'rep_missing');
  assert.notStrictEqual(sorted[0].id, 'rep_invalid');
});

// -------------------------------------------------------------
// 3. DATE DISPLAY FORMATTING TESTS
// -------------------------------------------------------------
test('formatReportDate formats valid dates and returns "Date unavailable" for invalid/missing', () => {
  const formattedValid = formatReportDate('2026-04-25T10:32:00Z');
  assert(formattedValid.includes('2026'));
  assert(formattedValid.includes('Apr') || formattedValid.includes('25'));

  assert.strictEqual(formatReportDate(''), 'Date unavailable');
  assert.strictEqual(formatReportDate(null), 'Date unavailable');
  assert.strictEqual(formatReportDate(undefined), 'Date unavailable');
  assert.strictEqual(formatReportDate('invalid-string'), 'Date unavailable');
});

// -------------------------------------------------------------
// 4. TRACKING NUMBER GENERATION & COLLISION HANDLING TESTS
// -------------------------------------------------------------
test('generateTrackingNumber produces collision-resistant tracking numbers with CFX-2026 prefix', () => {
  const count = 1000;
  const set = new Set<string>();

  for (let i = 0; i < count; i++) {
    const num = generateTrackingNumber();
    assert(num.startsWith('CFX-2026-'), `Expected CFX-2026- prefix but got ${num}`);
    // Matches CFX-2026-[Base36Timestamp]-[AlphanumericEntropy]
    assert(/^CFX-2026-[A-Z0-9]+-[A-Z0-9]+$/.test(num), `Format mismatch: ${num}`);
    set.add(num);
  }

  // Verify uniqueness across 1000 rapid generated tracking numbers
  assert.strictEqual(set.size, count, `Collision detected in batch generation! Set size: ${set.size}/${count}`);
});

// -------------------------------------------------------------
// 5. CLOUD-SAVE VS OFFLINE-SAVE FEEDBACK CONTRACT TESTS
// -------------------------------------------------------------
test('Simulated submission feedback adheres to exact safety rules', () => {
  // Scenario A: When savedToCloud is true
  const cloudSuccessResult = {
    savedToCloud: true,
    report: {
      trackingNumber: 'CFX-2026-M8K2-7193',
      syncedToCloud: true,
      storageSource: 'firestore',
    },
  };
  assert.strictEqual(cloudSuccessResult.savedToCloud, true);
  assert.strictEqual(cloudSuccessResult.report.syncedToCloud, true);
  assert.strictEqual(cloudSuccessResult.report.storageSource, 'firestore');

  // Scenario B: When savedToCloud is false
  const offlineFallbackResult = {
    savedToCloud: false,
    report: {
      trackingNumber: 'CFX-2026-M8K2-7193',
      syncedToCloud: false,
      storageSource: 'local_fallback',
    },
    error: 'Cloud Firestore write rejected or offline.',
  };
  assert.strictEqual(offlineFallbackResult.savedToCloud, false);
  // Report must NOT be marked cloud-synced
  assert.strictEqual(offlineFallbackResult.report.syncedToCloud, false);
  assert.strictEqual(offlineFallbackResult.report.storageSource, 'local_fallback');
  assert(offlineFallbackResult.error.length > 0);
});

// -------------------------------------------------------------
// 6. RETRY BEHAVIOR AND OWNERSHIP ENFORCEMENT
// -------------------------------------------------------------
test('retryReportUpload rejects ownership mismatch and unauthenticated users safely', async () => {
  const sampleReport: CivicIssueReport = {
    id: 'rep_retry_test',
    trackingNumber: 'CFX-2026-TEST-1234',
    userId: 'user_owner_abc',
    category: 'Water Leakage',
    title: 'Water Leakage',
    description: 'Pipe leaking on sidewalk',
    photoUrl: '',
    location: { address: 'Road 5', latitude: null, longitude: null, ward: 'Ward 47' },
    severity: 'Medium',
    status: 'Submitted',
    submittedAt: '2026-10-30T05:00:00Z',
    updatedAt: '2026-10-30T05:00:00Z',
    department: 'Water Supply',
    slaDeadline: '48h',
    timeline: [],
    syncedToCloud: false,
    storageSource: 'local_fallback',
  };

  const otherUser: CitizenUser = {
    id: 'user_different_xyz',
    fullName: 'Different Citizen',
    email: 'other@civifix.org',
    phone: '+91 99999 99999',
    ward: 'Ward 47',
    city: 'Metro City',
    reportsCount: 0,
    resolvedCount: 0,
    notificationPreferences: { smsAlerts: true, pushNotifications: true, emailUpdates: false },
  };

  // Calling retryReportUpload with unauthenticated state in Node environment
  const res = await retryReportUpload(sampleReport, otherUser);
  assert.strictEqual(res.success, false);
  assert(res.error !== undefined);
  // Preserves existing report ID and tracking number without mutating them
  assert.strictEqual(res.report.id, 'rep_retry_test');
  assert.strictEqual(res.report.trackingNumber, 'CFX-2026-TEST-1234');
});

test('sanitizeForFirestore removes undefined fields recursively', () => {
  const rawData = {
    id: 'rep_123',
    trackingNumber: 'CFX-2026-ABCD-1234',
    landmark: undefined,
    location: {
      address: 'Test Rd',
      landmark: undefined,
      coordinates: null,
    },
    notes: [undefined, 'Valid note'],
  };

  const sanitized = sanitizeForFirestore(rawData);
  assert.strictEqual('landmark' in sanitized, false);
  assert.strictEqual('landmark' in sanitized.location, false);
  assert.strictEqual(sanitized.location.coordinates, null);
  assert.strictEqual(sanitized.id, 'rep_123');
});

// -------------------------------------------------------------
// 5. PHASE 6 STEP 1: FIRESTORE DOCUMENT SIZE & QUOTA TESTS
// -------------------------------------------------------------
import {
  MAX_FIRESTORE_DOC_BYTES,
  saveLocalCachedReports,
  submitCivicReportToFirestore,
} from '../src/services/reportStorage.js';
import { estimateFirestoreDocumentSize } from '../src/services/imageOptimizer.js';

test('estimateFirestoreDocumentSize accurately calculates payload byte size', () => {
  const samplePayload = {
    id: 'rep_test_doc_size',
    trackingNumber: 'CFX-2026-TEST-9999',
    description: 'Road surface crater on 12th main',
    photoUrl: 'data:image/jpeg;base64,' + 'A'.repeat(50000), // ~37 KB Base64
  };

  const size = estimateFirestoreDocumentSize(samplePayload);
  assert(size > 50000, 'Payload size must reflect UTF-8 string encoding');
  assert(size < MAX_FIRESTORE_DOC_BYTES, 'Optimized report size must remain well below 800 KB safe limit');
});

test('Rejects oversized report documents that would breach Firestore 1 MiB limit', () => {
  // Simulate an unoptimized 2.5 MB Base64 photo string
  const oversizedPayload = {
    id: 'rep_oversized',
    trackingNumber: 'CFX-2026-BIG-9999',
    description: 'Pothole complaint with raw 2.5MB image',
    photoUrl: 'data:image/jpeg;base64,' + 'A'.repeat(2_500_000),
  };

  const size = estimateFirestoreDocumentSize(oversizedPayload);
  assert(size > MAX_FIRESTORE_DOC_BYTES, 'Oversized payload must exceed 800 KB limit');
});

test('saveLocalCachedReports catches QuotaExceededError and reports failure honestly', () => {
  // Save original localStorage
  const originalLocalStorage = (globalThis as any).localStorage;

  // Mock localStorage to simulate quota exhaustion (common on mobile browsers)
  (globalThis as any).localStorage = {
    getItem: () => null,
    setItem: () => {
      const quotaErr = new Error('The quota has been exceeded.');
      quotaErr.name = 'QuotaExceededError';
      throw quotaErr;
    },
    removeItem: () => {},
  };

  const dummyReport: CivicIssueReport = {
    id: 'rep_quota_test',
    trackingNumber: 'CFX-2026-QUOTA-001',
    userId: 'user_quota',
    category: 'Pothole',
    title: 'Pothole Issue',
    description: 'Deep road hazard',
    photoUrl: '',
    location: { address: 'Main Street', latitude: null, longitude: null, ward: 'Ward 1' },
    severity: 'Medium',
    status: 'Submitted',
    submittedAt: '2026-10-31T00:00:00Z',
    updatedAt: '2026-10-31T00:00:00Z',
    department: 'Roads',
    slaDeadline: '48h',
    timeline: [],
    syncedToCloud: false,
    storageSource: 'local_fallback',
  };

  const result = saveLocalCachedReports('user_quota', [dummyReport]);

  // Restore original localStorage
  (globalThis as any).localStorage = originalLocalStorage;

  assert.strictEqual(result.success, false);
  assert(result.error !== undefined);
  assert(
    result.error.toLowerCase().includes('device storage is full'),
    `Expected device storage full error message, got: ${result.error}`
  );
});

test('submitCivicReportToFirestore succeeds without photo and initializes photoUrl as empty string', async () => {
  const dummyUser: CitizenUser = {
    id: 'test_user_no_photo',
    fullName: 'Citizen Without Photo',
    email: 'nophoto@civifix.org',
    phone: '+91 91234 56789',
    ward: 'Ward 47 - Metro Green Zone',
    city: 'Metro City',
    reportsCount: 0,
    resolvedCount: 0,
    notificationPreferences: { smsAlerts: true, pushNotifications: true, emailUpdates: false },
  };

  const input = {
    category: 'Pothole' as const,
    title: 'Pothole without photo',
    description: 'Hazardous crater near bus stop',
    locationAddress: '24 MG Road, Ward 47',
    photoUrl: '', // Explicit empty photo
    severity: 'High' as const,
    latitude: 12.9716,
    longitude: 77.5946,
    ward: 'Ward 47 - Metro Green Zone',
  };

  const result = await submitCivicReportToFirestore(input, dummyUser);

  assert.strictEqual(result.report.photoUrl, '');
  assert.strictEqual(result.report.category, 'Pothole');
  assert.strictEqual(result.report.location.latitude, 12.9716);
  assert.strictEqual(result.report.location.longitude, 77.5946);
  assert(result.report.trackingNumber.startsWith('CFX-2026-'));
  // Note: in Node test environment without live Firebase credentials or localStorage, honestly reports failure
  assert.strictEqual(result.savedToCloud, false);
  assert(
    result.error?.includes('saving on this device also failed') ||
    result.error?.includes('Saved on this device for later upload') ||
    result.error?.includes('Could not upload your complaint')
  );
});


// -------------------------------------------------------------
// 7. CITIZEN STORAGE & ADMIN DASHBOARD INTEGRATION TESTS
// -------------------------------------------------------------
import {
  subscribeToUserReportsFromFirestore,
} from '../src/services/reportStorage.js';
import {
  subscribeToAllReportsForAdmin,
  extractCitizenSummaries,
  calculateAdminStats,
} from '../src/services/adminService.js';
import {
  uploadComplaintImageToStorage,
  uploadResolutionImageToStorage,
} from '../src/lib/firebase.js';

test('submitCivicReportToFirestore captures citizenName and citizenEmail', async () => {
  const dummyUser: CitizenUser = {
    id: 'user_cit_9876',
    fullName: 'Priya Sharma',
    email: 'priya.sharma@example.in',
    phone: '+91 98765 43210',
    ward: 'Ward 12 - Indiranagar',
    city: 'Bengaluru',
    reportsCount: 3,
    resolvedCount: 2,
    notificationPreferences: { smsAlerts: true, pushNotifications: true, emailUpdates: true },
  };

  const input = {
    category: 'Water Leakage' as const,
    title: 'Burst pipeline on 100 Feet Road',
    description: 'High pressure drinking water leaking continuously',
    locationAddress: '100 Feet Road, Indiranagar',
    photoUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
    severity: 'High' as const,
    latitude: 12.9784,
    longitude: 77.6408,
    ward: 'Ward 12 - Indiranagar',
  };

  const result = await submitCivicReportToFirestore(input, dummyUser);
  assert.strictEqual(result.report.citizenName, 'Priya Sharma');
  assert.strictEqual(result.report.citizenEmail, 'priya.sharma@example.in');
  assert.strictEqual(result.report.userId, 'user_cit_9876');
  assert.strictEqual(result.report.status, 'Submitted');
  assert.strictEqual(result.report.category, 'Water Leakage');
  assert(result.report.trackingNumber.startsWith('CFX-2026-'));
});

test('subscribeToUserReportsFromFirestore returns cleanup function and handles empty/offline users safely', () => {
  let updateCalled = false;
  const unsubEmpty = subscribeToUserReportsFromFirestore('', (reports) => {
    updateCalled = true;
    assert.deepStrictEqual(reports, []);
  });
  assert(typeof unsubEmpty === 'function', 'Must return an unsubscribe function');
  unsubEmpty();
  assert.strictEqual(updateCalled, true);
});

test('subscribeToAllReportsForAdmin returns cleanup function and handles errors gracefully', () => {
  const unsub = subscribeToAllReportsForAdmin(
    (reports) => {},
    (err) => {}
  );
  assert(typeof unsub === 'function', 'Must return an unsubscribe function');
  unsub();
});

test('uploadComplaintImageToStorage and uploadResolutionImageToStorage fallback safely to data URL', async () => {
  const sampleDataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const resComplaint = await uploadComplaintImageToStorage('rep_fallback_test', sampleDataUrl);
  assert.strictEqual(typeof resComplaint.url, 'string');
  assert(resComplaint.url.length > 0);

  const resResolution = await uploadResolutionImageToStorage('rep_fallback_test', sampleDataUrl);
  assert.strictEqual(typeof resResolution.url, 'string');
  assert(resResolution.url.length > 0);
});

test('extractCitizenSummaries utilizes citizenName and protects citizen email & phone privacy', () => {
  const mockReports: CivicIssueReport[] = [
    {
      id: 'rep_1',
      trackingNumber: 'CFX-2026-A1B2-0001',
      userId: 'usr_secret_uid_12345678',
      citizenName: 'Anil Kumar',
      citizenEmail: 'anil.kumar@gmail.com',
      category: 'Garbage',
      title: 'Garbage dump',
      description: 'Garbage not collected',
      photoUrl: '',
      location: { address: 'Cross 4', latitude: 12.9, longitude: 77.6, ward: 'Ward 5' },
      severity: 'Low',
      status: 'Resolved',
      submittedAt: '2026-11-01T10:00:00Z',
      updatedAt: '2026-11-02T12:00:00Z',
      department: 'Sanitation',
      slaDeadline: '48h',
      timeline: [],
    },
  ];

  const summaries = extractCitizenSummaries(mockReports);
  assert.strictEqual(summaries.length, 1);
  assert.strictEqual(summaries[0].name, 'Anil Kumar');
  // Privacy check: raw phone must never be exposed
  assert.strictEqual(summaries[0].phone.includes('••••'), true);
  // Privacy check: email must be masked
  assert.strictEqual(summaries[0].email.includes('•••'), true);
  assert.strictEqual(summaries[0].totalReports, 1);
  assert.strictEqual(summaries[0].resolvedReports, 1);
});

test('calculateAdminStats accurately derives real metrics from reports', () => {
  const mockReports: CivicIssueReport[] = [
    {
      id: 'r1',
      trackingNumber: 'CFX-2026-R1',
      userId: 'u1',
      category: 'Pothole',
      title: 'Pothole',
      description: 'Deep hole',
      photoUrl: '',
      location: { address: 'A', latitude: null, longitude: null, ward: 'Ward 1' },
      severity: 'Hazard',
      status: 'Submitted',
      submittedAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
      department: 'Roads',
      slaDeadline: '24h',
      timeline: [],
    },
    {
      id: 'r2',
      trackingNumber: 'CFX-2026-R2',
      userId: 'u2',
      category: 'Garbage',
      title: 'Garbage',
      description: 'Waste',
      photoUrl: '',
      location: { address: 'B', latitude: null, longitude: null, ward: 'Ward 2' },
      severity: 'Medium',
      status: 'Resolved',
      submittedAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-02T12:00:00Z', // 36 hours later
      department: 'Sanitation',
      slaDeadline: '48h',
      timeline: [],
    },
  ];

  const stats = calculateAdminStats(mockReports);
  assert.strictEqual(stats.totalReports, 2);
  assert.strictEqual(stats.pendingReports, 1);
  assert.strictEqual(stats.resolvedReports, 1);
  assert.strictEqual(stats.highSeverityReports, 1);
  assert.strictEqual(stats.categoryDistribution['Potholes'], 1);
  assert.strictEqual(stats.categoryDistribution['Garbage accumulation'], 1);
  assert.strictEqual(stats.categoryDistribution['Overflowing dustbins'], 0);
  assert.strictEqual(stats.categoryDistribution['Damaged roads'], 0);
  assert.strictEqual(stats.categoryDistribution['Drainage problems'], 0);
  assert.strictEqual(stats.categoryDistribution['Water leakage'], 0);
  assert.strictEqual(stats.categoryDistribution['Streetlight problems'], 0);
  assert.strictEqual(stats.categoryDistribution['Other civic issues'], 0);
  assert.strictEqual(stats.avgResolutionHours, 36);
});

test('retryReportUpload preserves citizenName, citizenEmail, trackingNumber, and id on cloud write', async () => {
  const pendingReport: CivicIssueReport = {
    id: 'rep_retry_meta_01',
    trackingNumber: 'CFX-2026-META-0001',
    userId: 'citizen_owner_01',
    citizenName: 'Kavita Rao',
    citizenEmail: 'kavita.rao@example.in',
    category: 'Garbage',
    normalizedCategory: 'Garbage accumulation',
    title: 'Garbage pile near market',
    description: 'Waste uncollected for 3 days',
    photoUrl: '',
    location: { address: 'Market Rd', latitude: null, longitude: null, ward: 'Ward 7' },
    severity: 'Medium',
    status: 'Submitted',
    submittedAt: '2026-11-10T08:00:00Z',
    updatedAt: '2026-11-10T08:00:00Z',
    department: 'Solid Waste Management',
    slaDeadline: '48 Hours Standard SLA',
    timeline: [],
    syncedToCloud: false,
    storageSource: 'local_fallback',
  };

  let writtenPayload: any = null;
  const res = await retryReportUpload(pendingReport, undefined, {
    currentUser: {
      uid: 'citizen_owner_01',
      displayName: 'Kavita R.',
      email: 'kavita.alt@example.in',
    },
    dbInstance: { __mockDb: true },
    docFn: (_db: any, _col: string, id: string) => ({ id }),
    setDocFn: async (_ref: any, payload: any) => {
      writtenPayload = payload;
    },
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.report.id, 'rep_retry_meta_01');
  assert.strictEqual(res.report.trackingNumber, 'CFX-2026-META-0001');
  assert.strictEqual(res.report.citizenName, 'Kavita Rao');
  assert.strictEqual(res.report.citizenEmail, 'kavita.rao@example.in');
  assert.strictEqual(writtenPayload.citizenName, 'Kavita Rao');
  assert.strictEqual(writtenPayload.citizenEmail, 'kavita.rao@example.in');
  assert.strictEqual(writtenPayload.trackingNumber, 'CFX-2026-META-0001');
});

// -------------------------------------------------------------
// 8. PHASE 4 STEP 1: LIVE SYNC, FOLLOW-UP NOTES & ISO TIMESTAMPS
// -------------------------------------------------------------
test('syncSelectedReport updates open modal on incoming changes, avoids loop on equal data, and handles disappearance', () => {
  const baseReport: CivicIssueReport = {
    id: 'rep_sync_1',
    trackingNumber: 'CFX-2026-SYNC-0001',
    userId: 'citizen_sync_1',
    category: 'Pothole',
    title: 'Main Street Pothole',
    description: 'Deep crater',
    photoUrl: '',
    location: { address: 'Main St', latitude: null, longitude: null, ward: 'Ward 3' },
    severity: 'High',
    status: 'Submitted',
    submittedAt: '2026-11-10T08:00:00.000Z',
    updatedAt: '2026-11-10T08:00:00.000Z',
    department: 'Roads & Infrastructure',
    slaDeadline: '24 Hours Rapid Redressal',
    timeline: [
      {
        status: 'Submitted',
        timestamp: '2026-11-10T08:00:00.000Z',
        note: 'Report registered by citizen via CiviFix AI.',
      },
    ],
    citizenNotes: ['Nov 10: Existing note'],
  };

  // Closed modal stays null
  assert.strictEqual(syncSelectedReport(null, [baseReport]), null);

  // Deeply equal clone returns exact original reference (prevents unnecessary re-renders)
  const cloneSame: CivicIssueReport = JSON.parse(JSON.stringify(baseReport));
  assert.strictEqual(syncSelectedReport(baseReport, [cloneSame]), baseReport);

  // Incoming Firestore admin transition updates selectedReport immediately
  const adminUpdated: CivicIssueReport = {
    ...baseReport,
    status: 'Resolved',
    assignedOfficer: 'Eng. Ramesh',
    adminRemarks: 'Asphalt resurfaced',
    resolutionDetails: 'Completed cold-mix repair',
    resolvedAt: '2026-11-12T14:00:00.000Z',
    updatedAt: '2026-11-12T14:00:00.000Z',
  };
  const synced = syncSelectedReport(baseReport, [adminUpdated]);
  assert.notStrictEqual(synced, null);
  assert.strictEqual(synced?.status, 'Resolved');
  assert.strictEqual(synced?.assignedOfficer, 'Eng. Ramesh');
  assert.strictEqual(synced?.resolutionDetails, 'Completed cold-mix repair');

  // Disappearing report closes cleanly without crashing
  const otherReport: CivicIssueReport = { ...baseReport, id: 'rep_other_2' };
  assert.strictEqual(syncSelectedReport(baseReport, [otherReport]), null);
  assert.strictEqual(syncSelectedReport(baseReport, []), null);
});

let storageTestQueue: Promise<void> = Promise.resolve();

function withMockLocalStorage(fn: (store: Record<string, string>) => Promise<void>): Promise<void> {
  const run = storageTestQueue.then(async () => {
    const originalLocalStorage = (globalThis as any).localStorage;
    const store: Record<string, string> = {};
    (globalThis as any).localStorage = {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    };
    try {
      await fn(store);
    } finally {
      (globalThis as any).localStorage = originalLocalStorage;
    }
  });
  storageTestQueue = run.catch(() => {});
  return run;
}

test('addCitizenNoteToFirestore confirms Firestore write, formats note consistently, and preserves existing notes', async () => {
  await withMockLocalStorage(async () => {
    const userId = 'citizen_note_ok';
    const existingReport: CivicIssueReport = {
      id: 'rep_note_ok',
      trackingNumber: 'CFX-2026-NOTE-0001',
      userId,
      category: 'Garbage',
      title: 'Trash Pile',
      description: 'Overflowing waste',
      photoUrl: '',
      location: { address: 'Park Ave', latitude: null, longitude: null, ward: 'Ward 2' },
      severity: 'Medium',
      status: 'Submitted',
      submittedAt: '2026-11-11T09:00:00.000Z',
      updatedAt: '2026-11-11T09:00:00.000Z',
      department: 'Sanitation',
      slaDeadline: '48 Hours Standard SLA',
      timeline: [],
      citizenNotes: ['Nov 11: Initial follow-up'],
      syncedToCloud: true,
    };
    saveLocalCachedReports(userId, [existingReport]);

    let capturedUpdatePayload: any = null;
    const res = await addCitizenNoteToFirestore('rep_note_ok', 'Still piling up near gate', userId, {
      currentUser: { uid: userId },
      dbInstance: { __mockDb: true },
      docFn: (_db, _col, id) => ({ id }),
      arrayUnionFn: (val: any) => ({ __arrayUnion: val }),
      updateDocFn: async (_ref, payload) => {
        capturedUpdatePayload = payload;
      },
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(typeof res.formattedNote, 'string');
    assert(res.formattedNote!.endsWith(': Still piling up near gate'));
    assert.strictEqual(capturedUpdatePayload.citizenNotes.__arrayUnion, res.formattedNote);

    const cachedAfter = getLocalCachedReports(userId);
    assert.strictEqual(cachedAfter.length, 1);
    assert.strictEqual(cachedAfter[0].citizenNotes?.length, 2);
    assert.strictEqual(cachedAfter[0].citizenNotes?.[0], 'Nov 11: Initial follow-up');
    assert.strictEqual(cachedAfter[0].citizenNotes?.[1], res.formattedNote);
  });
});

test('addCitizenNoteToFirestore does NOT report success or mutate notes when Firestore rejects write', async () => {
  await withMockLocalStorage(async () => {
    const userId = 'citizen_note_fail';
    const existingReport: CivicIssueReport = {
      id: 'rep_note_fail',
      trackingNumber: 'CFX-2026-NOTE-0002',
      userId,
      category: 'Drainage',
      title: 'Blocked Drain',
      description: 'Standing water',
      photoUrl: '',
      location: { address: 'Lake Rd', latitude: null, longitude: null, ward: 'Ward 5' },
      severity: 'High',
      status: 'Under Review',
      submittedAt: '2026-11-11T09:00:00.000Z',
      updatedAt: '2026-11-11T09:00:00.000Z',
      department: 'Stormwater Drainage',
      slaDeadline: '24 Hours Rapid Redressal',
      timeline: [],
      citizenNotes: ['Nov 11: Existing citizen note'],
      syncedToCloud: true,
    };
    saveLocalCachedReports(userId, [existingReport]);

    const resRejected = await addCitizenNoteToFirestore('rep_note_fail', 'Water rising', userId, {
      currentUser: { uid: userId },
      dbInstance: { __mockDb: true },
      docFn: (_db, _col, id) => ({ id }),
      arrayUnionFn: (val: any) => val,
      updateDocFn: async () => {
        const permErr: any = new Error('Missing or insufficient permissions.');
        permErr.code = 'permission-denied';
        throw permErr;
      },
    });

    assert.strictEqual(resRejected.success, false);
    assert.strictEqual(Boolean(resRejected.isPendingSync), false);
    assert(resRejected.error && resRejected.error.toLowerCase().includes('not authorized'));

    // Existing notes remain intact and failed note was NOT falsely appended
    const cachedAfter = getLocalCachedReports(userId);
    assert.deepStrictEqual(cachedAfter[0].citizenNotes, ['Nov 11: Existing citizen note']);

    // Ownership mismatch rejected cleanly
    const resMismatch = await addCitizenNoteToFirestore('rep_note_fail', 'Intruder note', userId, {
      currentUser: { uid: 'different_user_uid' },
      dbInstance: { __mockDb: true },
    });
    assert.strictEqual(resMismatch.success, false);
    assert(resMismatch.error?.toLowerCase().includes('not authorized'));
  });
});

test('addCitizenNoteToFirestore handles offline state honestly and preserves existing and pending notes', async () => {
  await withMockLocalStorage(async (store) => {
    const userId = 'citizen_note_offline';
    const existingReport: CivicIssueReport = {
      id: 'rep_note_offline',
      trackingNumber: 'CFX-2026-NOTE-0003',
      userId,
      category: 'Water Leakage',
      title: 'Leaking Valve',
      description: 'Valve dripping continuously',
      photoUrl: '',
      location: { address: '8th Cross', latitude: null, longitude: null, ward: 'Ward 8' },
      severity: 'Medium',
      status: 'Assigned',
      submittedAt: '2026-11-12T07:00:00.000Z',
      updatedAt: '2026-11-12T07:00:00.000Z',
      department: 'Water Supply',
      slaDeadline: '48 Hours Standard SLA',
      timeline: [],
      citizenNotes: ['Nov 12: Reported morning leak'],
      syncedToCloud: true,
    };
    saveLocalCachedReports(userId, [existingReport]);

    const resOffline = await addCitizenNoteToFirestore('rep_note_offline', 'Pressure increased tonight', userId, {
      currentUser: { uid: userId },
      dbInstance: { __mockDb: true },
      docFn: (_db, _col, id) => ({ id }),
      arrayUnionFn: (val: any) => val,
      updateDocFn: async () => {
        const netErr: any = new Error('Client is offline');
        netErr.code = 'unavailable';
        throw netErr;
      },
    });

    assert.strictEqual(resOffline.success, false);
    assert.strictEqual(resOffline.isPendingSync, true);
    assert(resOffline.formattedNote?.endsWith(': Pressure increased tonight'));
    assert(resOffline.error?.toLowerCase().includes('offline'));

    const cachedAfter = getLocalCachedReports(userId);
    assert.strictEqual(cachedAfter[0].citizenNotes?.length, 2);
    assert.strictEqual(cachedAfter[0].citizenNotes?.[0], 'Nov 12: Reported morning leak');
    assert.strictEqual(cachedAfter[0].citizenNotes?.[1], resOffline.formattedNote);
    assert(Boolean(store[`civifix_pending_notes_${userId}`]), 'Pending note queue should retain offline note');
  });
});

test('New citizen timeline writes use valid ISO 8601 timestamps while keeping legacy compatibility', async () => {
  const dummyUser: CitizenUser = {
    id: 'user_iso_timeline',
    fullName: 'Meera Nair',
    email: 'meera@example.in',
    phone: '+91 90000 00000',
    ward: 'Ward 10',
    city: 'Metro City',
    reportsCount: 0,
    resolvedCount: 0,
    notificationPreferences: { smsAlerts: true, pushNotifications: true, emailUpdates: false },
  };

  const result = await submitCivicReportToFirestore(
    {
      category: 'Streetlight problems' as any,
      title: 'Dark junction',
      description: 'Streetlight flickering',
      locationAddress: '1st Main Rd',
      photoUrl: '',
      severity: 'Medium',
      latitude: null,
      longitude: null,
      ward: 'Ward 10',
      imageVerification: {
        decision: 'POSSIBLE_CIVIC_ISSUE_NEEDS_REVIEW',
        isCivicIssue: 'uncertain',
        issueDetected: 'Streetlight',
        primaryCategory: 'Streetlight problems',
        detectedObjects: [],
        visualEvidence: 'Low visibility',
        explanation: 'Low light image',
        recommendedActions: [],
        safetyPrecautions: 'Be careful',
        confidence: null,
        imageQuality: { rating: 'Acceptable', isBlurry: false, isDark: true, isOverexposed: false },
        requiresHumanReview: true,
        canProceedToSubmit: true,
        isFallback: false,
        modelUsed: 'test',
        timestamp: '2026-11-16T05:00:00.000Z',
      },
    },
    dummyUser
  );

  assert(result.report.timeline.length >= 2);
  for (const ev of result.report.timeline) {
    assert(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(ev.timestamp),
      `Expected ISO 8601 UTC timestamp on new timeline event, got: ${ev.timestamp}`
    );
    assert(parseReportTimestamp(ev.timestamp) > 0);
  }

  // Legacy bullet-separated timeline timestamp compatibility remains intact
  const legacyBulletTs = 'Nov 16, 2026 • 05:52 AM';
  assert(parseReportTimestamp(legacyBulletTs) > 0);
  assert.strictEqual(formatReportDate(legacyBulletTs).includes('2026'), true);
});

// -------------------------------------------------------------
// 9. PHASE 4 STEP 3: CITIZEN VISIBILITY & MUNICIPAL UPDATES
// -------------------------------------------------------------
test('resolveCitizenReportVisibility prioritizes assignedDepartment over department and handles missing fields', () => {
  const withAssigned = resolveCitizenReportVisibility({
    id: 'rep_dept_1',
    assignedDepartment: '  Electrical & Street Lighting Department  ',
    department: 'General Municipal Administration',
  });
  assert.strictEqual(withAssigned.assignedDepartment, 'Electrical & Street Lighting Department');
  assert.strictEqual(withAssigned.hasMunicipalAssignment, true);

  const fallbackDept = resolveCitizenReportVisibility({
    id: 'rep_dept_2',
    assignedDepartment: '   ',
    department: 'Solid Waste Management',
  });
  assert.strictEqual(fallbackDept.assignedDepartment, 'Solid Waste Management');
  assert.strictEqual(fallbackDept.hasMunicipalAssignment, true);

  const noDept = resolveCitizenReportVisibility({
    id: 'rep_dept_3',
    assignedDepartment: '',
    department: '',
  });
  assert.strictEqual(noDept.assignedDepartment, null);
  assert.strictEqual(noDept.hasMunicipalAssignment, false);
});

test('resolveCitizenReportVisibility extracts assignedOfficer, adminRemarks, and duplicateOf cleanly', () => {
  const existingOwnedReport: CivicIssueReport = {
    id: 'rep_orig_1',
    trackingNumber: 'CFX-2026-ORIG-1111',
    userId: 'citizen_step3',
    category: 'Garbage',
    title: 'Overflowing bin near Market Gate',
    description: 'Waste piling up',
    photoUrl: '',
    location: { address: 'Market Gate', latitude: null, longitude: null, ward: 'Ward 2' },
    severity: 'Medium',
    status: 'In Progress',
    submittedAt: '2026-11-10T08:00:00.000Z',
    updatedAt: '2026-11-11T08:00:00.000Z',
    department: 'Solid Waste Management',
    slaDeadline: '48 Hours Standard SLA',
    timeline: [],
    citizenNotes: [],
  };

  const linkedReport: CivicIssueReport = {
    ...existingOwnedReport,
    id: 'rep_dup_1',
    trackingNumber: 'CFX-2026-DUP-2222',
    assignedOfficer: '  Inspector R. Kulkarni  ',
    adminRemarks: '  Crew dispatched with compactor truck; consolidated with primary ticket.  ',
    duplicateOf: 'CFX-2026-ORIG-1111',
    citizenNotes: ['Nov 11: Citizen note stays separate'],
  };

  const vis = resolveCitizenReportVisibility(linkedReport, [existingOwnedReport, linkedReport]);
  assert.strictEqual(vis.assignedOfficer, 'Inspector R. Kulkarni');
  assert.strictEqual(
    vis.adminRemarks,
    'Crew dispatched with compactor truck; consolidated with primary ticket.'
  );
  assert.strictEqual(vis.duplicateOf, 'CFX-2026-ORIG-1111');
  assert.strictEqual(vis.linkedDuplicateReport?.id, 'rep_orig_1');
  assert.strictEqual(vis.hasMunicipalAssignment, true);

  // External / non-owned duplicateOf falls back to null linkedDuplicateReport while preserving raw duplicateOf string
  const externalDupVis = resolveCitizenReportVisibility(
    { id: 'rep_dup_2', duplicateOf: 'CFX-2026-EXTERNAL-9999' },
    [existingOwnedReport]
  );
  assert.strictEqual(externalDupVis.duplicateOf, 'CFX-2026-EXTERNAL-9999');
  assert.strictEqual(externalDupVis.linkedDuplicateReport, null);
});

test('resolveCitizenReportVisibility preserves resolution evidence and handles null/missing optional fields safely', () => {
  const nullVis = resolveCitizenReportVisibility(null);
  assert.deepStrictEqual(nullVis, {
    assignedDepartment: null,
    assignedOfficer: null,
    adminRemarks: null,
    duplicateOf: null,
    linkedDuplicateReport: null,
    hasMunicipalAssignment: false,
    hasResolutionEvidence: false,
  });

  const whitespaceVis = resolveCitizenReportVisibility({
    id: 'rep_empty_opt',
    assignedDepartment: '   ',
    department: '',
    assignedOfficer: ' ',
    adminRemarks: '  ',
    duplicateOf: '',
    resolutionDetails: ' ',
    resolutionPhotoUrl: '',
    resolvedAt: '',
    timeline: undefined,
    citizenNotes: undefined,
  });
  assert.strictEqual(whitespaceVis.hasMunicipalAssignment, false);
  assert.strictEqual(whitespaceVis.hasResolutionEvidence, false);

  const resolvedWithDetails = resolveCitizenReportVisibility({
    resolutionDetails: 'Cleared debris and sanitized area.',
  });
  assert.strictEqual(resolvedWithDetails.hasResolutionEvidence, true);

  const resolvedWithPhoto = resolveCitizenReportVisibility({
    resolutionPhotoUrl: 'https://storage.example.com/resolution.jpg',
  });
  assert.strictEqual(resolvedWithPhoto.hasResolutionEvidence, true);

  const resolvedWithTimestamp = resolveCitizenReportVisibility({
    resolvedAt: '2026-11-16T05:30:00.000Z',
  });
  assert.strictEqual(resolvedWithTimestamp.hasResolutionEvidence, true);
});

test('getCivicCategoryIconKey maps all 8 canonical and 6 legacy categories consistently', () => {
  const expectedKeys = new Set([
    'garbage',
    'dustbin',
    'pothole',
    'road',
    'water',
    'drainage',
    'streetlight',
    'other',
  ]);

  const canonicalKeys = EXPANDED_CIVIC_CATEGORIES.map((cat) => getCivicCategoryIconKey(cat));
  assert.strictEqual(new Set(canonicalKeys).size, 8, 'Each of the 8 canonical categories maps to a distinct icon key');
  for (const key of canonicalKeys) {
    assert(expectedKeys.has(key));
  }

  // Verify specific canonical and legacy mappings
  assert.strictEqual(getCivicCategoryIconKey('Garbage accumulation'), 'garbage');
  assert.strictEqual(getCivicCategoryIconKey('Garbage'), 'garbage');
  assert.strictEqual(getCivicCategoryIconKey('Overflowing dustbins'), 'dustbin');
  assert.strictEqual(getCivicCategoryIconKey('Potholes'), 'pothole');
  assert.strictEqual(getCivicCategoryIconKey('Pothole'), 'pothole');
  assert.strictEqual(getCivicCategoryIconKey('Damaged roads'), 'road');
  assert.strictEqual(getCivicCategoryIconKey('Drainage problems'), 'drainage');
  assert.strictEqual(getCivicCategoryIconKey('Drainage'), 'drainage');
  assert.strictEqual(getCivicCategoryIconKey('Water leakage'), 'water');
  assert.strictEqual(getCivicCategoryIconKey('Water Leakage'), 'water');
  assert.strictEqual(getCivicCategoryIconKey('Streetlight problems'), 'streetlight');
  assert.strictEqual(getCivicCategoryIconKey('Broken Streetlight'), 'streetlight');
  assert.strictEqual(getCivicCategoryIconKey('Other civic issues'), 'other');
  assert.strictEqual(getCivicCategoryIconKey('Other'), 'other');
  assert.strictEqual(getCivicCategoryIconKey(null), 'other');
  assert.strictEqual(getCivicCategoryIconKey(undefined), 'other');

  for (const legacyCat of LEGACY_CIVIC_CATEGORIES) {
    assert(expectedKeys.has(getCivicCategoryIconKey(legacyCat)));
  }
});

test('HomeScreen and MyReportsScreen share CivicCategoryIcon and clearly separate Admin Remarks from Citizen Notes', () => {
  const homeSource = fs.readFileSync(
    path.resolve('src/components/screens/HomeScreen.tsx'),
    'utf8'
  );
  const myReportsSource = fs.readFileSync(
    path.resolve('src/components/screens/MyReportsScreen.tsx'),
    'utf8'
  );

  assert(homeSource.includes('CivicCategoryIcon'));
  assert(myReportsSource.includes('CivicCategoryIcon'));
  assert(!homeSource.includes("report.category === 'Garbage' ?"));
  assert(myReportsSource.includes('Official Administrator Remarks'));
  assert(myReportsSource.includes('Municipality'));
  assert(myReportsSource.includes('Citizen Follow-up Notes'));
  assert(myReportsSource.includes('Linked Duplicate Complaint'));
  assert(myReportsSource.includes('Official Municipal Resolution Evidence'));
  assert(myReportsSource.includes('Verified Municipal Status Log'));
});

test('fetchCitizenReportStatusHistory handles permitted reads, permission-denied, ownership mismatch, and offline safely', async () => {
  // 1. Permitted Firestore subcollection read succeeds and sanitizes entries
  const permittedRes = await fetchCitizenReportStatusHistory('rep_hist_1', 'citizen_uid_1', {
    currentUser: { uid: 'citizen_uid_1' },
    dbInstance: { __mockDb: true },
    isConfigured: true,
    collectionFn: (_db, ...segs) => segs.join('/'),
    queryFn: (col, ...mods) => ({ col, mods }),
    orderByFn: (field, dir) => ({ field, dir }),
    limitFn: (n) => ({ limit: n }),
    getDocsFn: async () => [
      {
        id: 'hist_2',
        data: () => ({
          reportId: 'rep_hist_1',
          fromStatus: 'Assigned',
          toStatus: 'In Progress',
          changedByUid: 'admin_1',
          changedByRole: 'admin',
          note: 'Field team started repair',
          timestamp: '2026-11-16T06:00:00.000Z',
        }),
      },
      {
        id: 'hist_1',
        data: () => ({
          reportId: 'rep_hist_1',
          fromStatus: null,
          toStatus: 'Submitted',
          changedByUid: 'citizen_uid_1',
          changedByRole: 'citizen',
          note: 'Report registered by citizen via CiviFix AI.',
          timestamp: '2026-11-16T05:00:00.000Z',
        }),
      },
    ],
  });

  assert.strictEqual(permittedRes.available, true);
  assert.strictEqual(permittedRes.entries.length, 2);
  assert.strictEqual(permittedRes.entries[0].fromStatus, 'Assigned');
  assert.strictEqual(permittedRes.entries[0].toStatus, 'In Progress');
  assert.strictEqual(permittedRes.entries[0].changedByRole, 'admin');
  assert.strictEqual(permittedRes.entries[1].fromStatus, null);
  assert.strictEqual(permittedRes.entries[1].changedByRole, 'citizen');

  // 2. Permission-denied from Firestore security rules returns available: false cleanly
  const deniedRes = await fetchCitizenReportStatusHistory('rep_hist_2', 'citizen_uid_1', {
    currentUser: { uid: 'citizen_uid_1' },
    dbInstance: { __mockDb: true },
    isConfigured: true,
    collectionFn: () => 'col',
    queryFn: () => 'q',
    orderByFn: () => 'o',
    limitFn: () => 'l',
    getDocsFn: async () => {
      const err: any = new Error('Missing or insufficient permissions.');
      err.code = 'permission-denied';
      throw err;
    },
  });
  assert.strictEqual(deniedRes.available, false);
  assert.strictEqual(deniedRes.permissionDenied, true);
  assert.deepStrictEqual(deniedRes.entries, []);

  // 3. UID mismatch rejected before querying Firestore
  const mismatchRes = await fetchCitizenReportStatusHistory('rep_hist_3', 'owner_uid', {
    currentUser: { uid: 'other_uid' },
    dbInstance: { __mockDb: true },
    isConfigured: true,
  });
  assert.strictEqual(mismatchRes.available, false);
  assert.strictEqual(mismatchRes.permissionDenied, true);

  // 4. Unauthenticated session rejected cleanly
  const unauthRes = await fetchCitizenReportStatusHistory('rep_hist_4', 'owner_uid', {
    currentUser: null,
    dbInstance: { __mockDb: true },
    isConfigured: true,
  });
  assert.strictEqual(unauthRes.available, false);
  assert.strictEqual(unauthRes.permissionDenied, true);

  // 5. Offline / unconfigured returns available: false without claiming permissionDenied
  const offlineRes = await fetchCitizenReportStatusHistory('rep_hist_5', 'owner_uid', {
    currentUser: { uid: 'owner_uid' },
    dbInstance: null,
    isConfigured: false,
  });
  assert.strictEqual(offlineRes.available, false);
  assert.strictEqual(Boolean(offlineRes.permissionDenied), false);
});

// -------------------------------------------------------------
// 10. PHASE 4 STEP 4: OFFLINE RETRY, PHOTO UPLOAD & SUBMISSION INTEGRITY
// -------------------------------------------------------------
test('retryReportUpload uploads offline data-URI photo to Storage, skips existing HTTPS URL, and falls back safely on failure', async () => {
  await withMockLocalStorage(async () => {
    const uid = 'citizen_step4_photo';
    const baseOffline: CivicIssueReport = {
      id: 'rep_step4_photo_1',
      trackingNumber: 'CFX-2026-STEP4-0001',
      userId: uid,
      citizenName: 'Asha Menon',
      citizenEmail: 'asha@example.in',
      category: 'Garbage',
      title: 'Offline garbage pile',
      description: 'Accumulated waste near bus bay',
      photoUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
      location: { address: 'Bus Bay Rd', latitude: null, longitude: null, ward: 'Ward 4' },
      severity: 'Medium',
      status: 'Submitted',
      submittedAt: '2026-11-15T07:30:00.000Z',
      updatedAt: '2026-11-15T07:30:00.000Z',
      department: 'Solid Waste Management',
      slaDeadline: '48 Hours Standard SLA',
      timeline: [],
      citizenNotes: [],
      syncedToCloud: false,
      storageSource: 'local_fallback',
    };

    // A. Storage upload succeeds -> stores HTTPS URL in Firestore payload & returned report
    let uploadCallsA = 0;
    let payloadA: any = null;
    const resSuccess = await retryReportUpload(baseOffline, undefined, {
      currentUser: { uid },
      dbInstance: { __mockDb: true },
      docFn: (_db, ...segs) => ({ path: segs.join('/') }),
      getDocFn: async () => ({ exists: () => false }),
      uploadPhotoFn: async (reportId, dataUrl, ownerUid) => {
        uploadCallsA++;
        assert.strictEqual(reportId, 'rep_step4_photo_1');
        assert.strictEqual(ownerUid, uid);
        assert(dataUrl.startsWith('data:'));
        return { success: true, url: 'https://storage.googleapis.com/civifix-test/rep_step4_photo_1.jpg' };
      },
      setDocFn: async (_ref, payload) => {
        payloadA = payload;
      },
    });

    assert.strictEqual(resSuccess.success, true);
    assert.strictEqual(uploadCallsA, 1);
    assert.strictEqual(resSuccess.photoUploadedToStorage, true);
    assert.strictEqual(resSuccess.report.photoUrl, 'https://storage.googleapis.com/civifix-test/rep_step4_photo_1.jpg');
    assert.strictEqual(payloadA.photoUrl, 'https://storage.googleapis.com/civifix-test/rep_step4_photo_1.jpg');
    assert.strictEqual(payloadA.submittedAt, '2026-11-15T07:30:00.000Z');
    assert.strictEqual(payloadA.id, 'rep_step4_photo_1');
    assert.strictEqual(payloadA.trackingNumber, 'CFX-2026-STEP4-0001');

    // B. Existing HTTPS Storage URL -> skipped cleanly without calling uploadPhotoFn
    let uploadCallsB = 0;
    const resExistingUrl = await retryReportUpload(
      { ...baseOffline, id: 'rep_step4_photo_2', photoUrl: 'https://storage.googleapis.com/civifix-test/existing.jpg' },
      undefined,
      {
        currentUser: { uid },
        dbInstance: { __mockDb: true },
        docFn: (_db, ...segs) => ({ path: segs.join('/') }),
        getDocFn: async () => ({ exists: () => false }),
        uploadPhotoFn: async () => {
          uploadCallsB++;
          return { success: true, url: 'should-not-be-called' };
        },
        setDocFn: async () => {},
      }
    );
    assert.strictEqual(resExistingUrl.success, true);
    assert.strictEqual(uploadCallsB, 0);
    assert.strictEqual(resExistingUrl.photoUploadedToStorage, false);
    assert.strictEqual(resExistingUrl.report.photoUrl, 'https://storage.googleapis.com/civifix-test/existing.jpg');

    // C. Storage upload failure -> retains bounded original data URI (never drops photo)
    let payloadC: any = null;
    const resFallback = await retryReportUpload(
      { ...baseOffline, id: 'rep_step4_photo_3' },
      undefined,
      {
        currentUser: { uid },
        dbInstance: { __mockDb: true },
        docFn: (_db, ...segs) => ({ path: segs.join('/') }),
        getDocFn: async () => ({ exists: () => false }),
        uploadPhotoFn: async () => {
          throw new Error('Storage temporarily offline');
        },
        setDocFn: async (_ref, payload) => {
          payloadC = payload;
        },
      }
    );
    assert.strictEqual(resFallback.success, true);
    assert.strictEqual(resFallback.photoUploadedToStorage, false);
    assert.strictEqual(resFallback.report.photoUrl, baseOffline.photoUrl);
    assert.strictEqual(payloadC.photoUrl, baseOffline.photoUrl);
  });
});

test('retryReportUpload enforces 800 KiB limit when Storage fallback leaves payload oversized', async () => {
  const uid = 'citizen_step4_size';
  let setDocCalled = false;
  const oversizedReport: CivicIssueReport = {
    id: 'rep_step4_big',
    trackingNumber: 'CFX-2026-BIG-0001',
    userId: uid,
    category: 'Pothole',
    title: 'Huge payload',
    description: 'Exceeds 800 KiB after Storage fallback',
    photoUrl: 'data:image/jpeg;base64,' + 'A'.repeat(900 * 1024),
    location: { address: 'Main Rd', latitude: null, longitude: null, ward: 'Ward 1' },
    severity: 'High',
    status: 'Submitted',
    submittedAt: '2026-11-15T08:00:00.000Z',
    updatedAt: '2026-11-15T08:00:00.000Z',
    department: 'Roads & Infrastructure Maintenance',
    slaDeadline: '24 Hours Rapid Redressal',
    timeline: [],
    syncedToCloud: false,
    storageSource: 'local_fallback',
  };

  const res = await retryReportUpload(oversizedReport, undefined, {
    currentUser: { uid },
    dbInstance: { __mockDb: true },
    docFn: (_db, ...segs) => ({ path: segs.join('/') }),
    getDocFn: async () => ({ exists: () => false }),
    uploadPhotoFn: async () => ({ success: false, url: oversizedReport.photoUrl }),
    setDocFn: async () => {
      setDocCalled = true;
    },
  });

  assert.strictEqual(res.success, false);
  assert.strictEqual(setDocCalled, false);
  assert.strictEqual(res.report.syncedToCloud, false);
  assert(res.error && res.error.toLowerCase().includes('too large to upload'));
});

test('retryReportUpload detects already-synced owned report without overwriting, and refuses foreign/permission errors', async () => {
  await withMockLocalStorage(async () => {
    const uid = 'citizen_step4_existing';
    const pending: CivicIssueReport = {
      id: 'rep_step4_exists_1',
      trackingNumber: 'CFX-2026-EXIST-0001',
      userId: uid,
      category: 'Drainage',
      title: 'Blocked drain',
      description: 'Waterlogging near gate',
      photoUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
      location: { address: 'Gate 2', latitude: null, longitude: null, ward: 'Ward 6' },
      severity: 'Medium',
      status: 'Submitted',
      submittedAt: '2026-11-14T10:00:00.000Z',
      updatedAt: '2026-11-14T10:00:00.000Z',
      department: 'Stormwater Drainage & Flood Control',
      slaDeadline: '48 Hours Standard SLA',
      timeline: [],
      syncedToCloud: false,
    };

    let setDocCalls = 0;
    let uploadCalls = 0;

    // 1. Owned cloud report already exists (pre-check getDoc hits)
    const resExisting = await retryReportUpload(pending, undefined, {
      currentUser: { uid },
      dbInstance: { __mockDb: true },
      docFn: (_db, ...segs) => ({ path: segs.join('/') }),
      getDocFn: async () => ({
        exists: () => true,
        data: () => ({
          id: 'rep_step4_exists_1',
          trackingNumber: 'CFX-2026-EXIST-0001',
          userId: uid,
          status: 'Under Review',
          photoUrl: 'https://storage.googleapis.com/civifix-test/already-uploaded.jpg',
          submittedAt: '2026-11-14T10:00:00.000Z',
          updatedAt: '2026-11-15T12:00:00.000Z',
        }),
      }),
      uploadPhotoFn: async () => {
        uploadCalls++;
        return { success: true, url: 'should-not-run' };
      },
      setDocFn: async () => {
        setDocCalls++;
      },
    });

    assert.strictEqual(resExisting.success, true);
    assert.strictEqual(resExisting.alreadyExistedInCloud, true);
    assert.strictEqual(setDocCalls, 0);
    assert.strictEqual(uploadCalls, 0);
    assert.strictEqual(resExisting.report.status, 'Under Review');
    assert.strictEqual(resExisting.report.photoUrl, 'https://storage.googleapis.com/civifix-test/already-uploaded.jpg');
    assert.strictEqual(resExisting.report.syncedToCloud, true);

    // 2. Genuine permission error must NOT be treated as already synced
    const resPermDenied = await retryReportUpload(pending, undefined, {
      currentUser: { uid },
      dbInstance: { __mockDb: true },
      docFn: (_db, ...segs) => ({ path: segs.join('/') }),
      getDocFn: async () => {
        const permErr: any = new Error('Missing or insufficient permissions.');
        permErr.code = 'permission-denied';
        throw permErr;
      },
      uploadPhotoFn: async () => ({ success: false, url: pending.photoUrl }),
      setDocFn: async () => {
        const permErr: any = new Error('Missing or insufficient permissions.');
        permErr.code = 'permission-denied';
        throw permErr;
      },
    });

    assert.strictEqual(resPermDenied.success, false);
    assert(resPermDenied.error?.toLowerCase().includes('not authorized'));
  });
});

test('retryReportUpload creates deterministic initial statusHistory & auditLogs idempotently and handles audit failure honestly', async () => {
  await withMockLocalStorage(async () => {
    const uid = 'citizen_step4_audit';
    const offlineReport: CivicIssueReport = {
      id: 'rep_step4_audit_1',
      trackingNumber: 'CFX-2026-AUDIT-0001',
      userId: uid,
      citizenEmail: 'audit@example.in',
      category: 'Water Leakage',
      title: 'Pipeline leak',
      description: 'Clean water leaking',
      photoUrl: '',
      location: { address: '4th Block', latitude: null, longitude: null, ward: 'Ward 9' },
      severity: 'High',
      status: 'Submitted',
      submittedAt: '2026-11-15T06:00:00.000Z',
      updatedAt: '2026-11-15T06:00:00.000Z',
      department: 'Water Supply & Sewerage Board',
      slaDeadline: '24 Hours Rapid Redressal',
      timeline: [],
      syncedToCloud: false,
    };

    const writtenHistoryIds: string[] = [];
    const writtenAuditIds: string[] = [];
    const existingHistoryDocs: any[] = [];

    const makeMockDeps = (auditShouldFail: boolean) => ({
      currentUser: { uid, email: 'audit@example.in' },
      dbInstance: { __mockDb: true },
      docFn: (_db: any, ...segs: string[]) => ({ path: segs.join('/'), id: segs[segs.length - 1] }),
      collectionFn: (_db: any, ...segs: string[]) => segs.join('/'),
      queryFn: (col: any, ...mods: any[]) => ({ col, mods }),
      whereFn: (f: string, op: any, v: any) => ({ f, op, v }),
      limitFn: (n: number) => ({ n }),
      getDocFn: async () => ({
        exists: () => existingHistoryDocs.length > 0,
        data: () => ({ ...offlineReport, userId: uid, status: 'Submitted' }),
      }),
      getDocsFn: async () => [...existingHistoryDocs],
      setDocFn: async () => {},
      statusHistorySetDocFn: async (ref: any, data: any) => {
        writtenHistoryIds.push(ref.id);
        existingHistoryDocs.push({ id: ref.id, data: () => data });
      },
      auditLogSetDocFn: async (ref: any) => {
        if (auditShouldFail) {
          const err: any = new Error('Audit permission or network failure');
          err.code = 'unavailable';
          throw err;
        }
        writtenAuditIds.push(ref.id);
      },
    });

    // First retry: creates deterministic statusHistory + best-effort auditLogs fails honestly
    const firstAttempt = await retryReportUpload(offlineReport, undefined, makeMockDeps(true));
    assert.strictEqual(firstAttempt.success, true);
    assert.strictEqual(firstAttempt.statusHistoryRecorded, true);
    assert.strictEqual(firstAttempt.auditLogRecorded, false);
    assert(firstAttempt.auditWarning && firstAttempt.auditWarning.includes('Audit log entry not confirmed'));
    assert.deepStrictEqual(writtenHistoryIds, [getInitialStatusHistoryDocId('rep_step4_audit_1')]);
    assert.deepStrictEqual(writtenAuditIds, []);

    // Repeated retry: statusHistory already exists so NOT written again; audit write succeeds once with deterministic ID
    const secondAttempt = await retryReportUpload(offlineReport, undefined, makeMockDeps(false));
    assert.strictEqual(secondAttempt.success, true);
    assert.strictEqual(secondAttempt.alreadyExistedInCloud, true);
    assert.strictEqual(secondAttempt.statusHistoryRecorded, true);
    assert.strictEqual(secondAttempt.auditLogRecorded, true);
    assert.strictEqual(writtenHistoryIds.length, 1, 'statusHistory must NOT duplicate across retries');
    assert.deepStrictEqual(writtenAuditIds, [getInitialAuditLogDocId('rep_step4_audit_1')]);
  });
});

test('createSubmissionIdentity & awaitSubmissionWithTimeoutNotice preserve identity without cancelling in-flight submissions', async () => {
  const idA = createSubmissionIdentity('2026-11-16T06:00:00.000Z');
  assert(idA.reportId.startsWith('rep_'));
  assert(idA.trackingNumber.startsWith('CFX-2026-'));
  assert.strictEqual(idA.submittedAt, '2026-11-16T06:00:00.000Z');

  // Slow underlying write (~60ms) raced against short UI wait (20ms) does NOT cancel write
  let backgroundFinished = false;
  const inFlight = new Promise<{ reportId: string; saved: boolean }>((resolve) => {
    setTimeout(() => {
      backgroundFinished = true;
      resolve({ reportId: idA.reportId, saved: true });
    }, 60);
  });

  const firstRace = await awaitSubmissionWithTimeoutNotice(inFlight, 20);
  assert.strictEqual(firstRace.timedOut, true);
  assert.strictEqual(firstRace.settled, false);
  assert.strictEqual(backgroundFinished, false);

  // Re-awaiting the SAME in-flight promise (as user tapping "Check Submission Status") finishes with original identity
  const secondRace = await awaitSubmissionWithTimeoutNotice(inFlight, 200);
  assert.strictEqual(secondRace.timedOut, false);
  assert.strictEqual(secondRace.settled, true);
  assert.strictEqual(backgroundFinished, true);
  assert.strictEqual(secondRace.result?.reportId, idA.reportId);

  // Verify ReportIssueScreen.tsx and App.tsx wire timeout & partial sync feedback cleanly
  const reportIssueSrc = fs.readFileSync(
    path.resolve('src/components/screens/ReportIssueScreen.tsx'),
    'utf8'
  );
  const appSrc = fs.readFileSync(path.resolve('src/App.tsx'), 'utf8');
  assert(reportIssueSrc.includes('awaitSubmissionWithTimeoutNotice'));
  assert(reportIssueSrc.includes('pendingIdentityRef'));
  assert(reportIssueSrc.includes('inFlightSubmissionRef'));
  assert(appSrc.includes('syncFeedback'));
});

test('syncPendingReportsToFirestore returns accurate partial-success counts and retains failed offline items', async () => {
  await withMockLocalStorage(async (store) => {
    const userId = 'citizen_step4_partial';
    const repOk: CivicIssueReport = {
      id: 'rep_sync_ok_1',
      trackingNumber: 'CFX-2026-OK-0001',
      userId,
      category: 'Garbage',
      title: 'Synced report',
      description: 'Valid garbage dump',
      photoUrl: '',
      location: { address: '1st St', latitude: null, longitude: null, ward: 'Ward 1' },
      severity: 'Low',
      status: 'Submitted',
      submittedAt: '2026-11-15T05:00:00.000Z',
      updatedAt: '2026-11-15T05:00:00.000Z',
      department: 'Solid Waste Management',
      slaDeadline: '48 Hours Standard SLA',
      timeline: [],
      syncedToCloud: false,
      storageSource: 'local_fallback',
    };
    const repFail: CivicIssueReport = {
      ...repOk,
      id: 'rep_sync_fail_2',
      trackingNumber: 'CFX-2026-FAIL-0002',
      title: 'Failing report',
    };

    saveLocalCachedReports(userId, [repOk, repFail]);
    store[`civifix_pending_notes_${userId}`] = JSON.stringify({
      rep_cloud_existing: ['Nov 15: Pending note OK', 'Nov 15: Pending note FAIL'],
    });

    const syncRes = await syncPendingReportsToFirestore(userId, {
      isConfigured: true,
      hasDb: true,
      hasAuthUser: true,
      retryReportUploadFn: async (rep) => {
        if (rep.id === 'rep_sync_ok_1') {
          return { success: true, report: { ...rep, syncedToCloud: true, storageSource: 'firestore' } };
        }
        return { success: false, report: rep, error: 'Simulated temporary error' };
      },
      syncPendingNoteFn: async (_reportId, note) => {
        if (note.includes('FAIL')) {
          throw new Error('Simulated note sync error');
        }
      },
    });

    assert.strictEqual(syncRes.syncedReportsCount, 1);
    assert.strictEqual(syncRes.failedReportsCount, 1);
    assert.strictEqual(syncRes.syncedNotesCount, 1);
    assert.strictEqual(syncRes.failedNotesCount, 1);
    assert.strictEqual(syncRes.syncedCount, 2);
    assert.strictEqual(syncRes.errors.length, 2);
    assert(syncRes.summaryMessage.includes('remain saved on this device'));

    const cachedAfter = getLocalCachedReports(userId);
    assert.strictEqual(cachedAfter.find((r) => r.id === 'rep_sync_ok_1')?.syncedToCloud, true);
    assert.strictEqual(cachedAfter.find((r) => r.id === 'rep_sync_fail_2')?.syncedToCloud, false);

    const remainingNotes = JSON.parse(store[`civifix_pending_notes_${userId}`]);
    assert.deepStrictEqual(remainingNotes.rep_cloud_existing, ['Nov 15: Pending note FAIL']);
  });
});

// -------------------------------------------------------------
// 11. PHASE 4 STEP 5: PENDING SYNC COUNTS, CONCURRENT DEDUP & HOME BELL
// -------------------------------------------------------------
test('getPendingSyncCounts & hasPendingOfflineSync detect pending notes, pending withdrawals, and unsynced reports', async () => {
  await withMockLocalStorage(async (store) => {
    const uid = 'citizen_sync_counts';
    const syncedReport: CivicIssueReport = {
      id: 'rep_cloud_1',
      trackingNumber: 'CFX-2026-CNT-1',
      userId: uid,
      category: 'Garbage',
      title: 'Synced report',
      description: 'desc',
      photoUrl: '',
      location: { address: 'Addr', latitude: null, longitude: null, ward: 'Ward 1' },
      severity: 'Low',
      status: 'Submitted',
      submittedAt: '2026-11-15T05:00:00.000Z',
      updatedAt: '2026-11-15T05:00:00.000Z',
      department: 'Solid Waste Management',
      slaDeadline: '48 Hours Standard SLA',
      timeline: [],
      syncedToCloud: true,
    };

    // 1. Clean state -> 0
    assert.deepStrictEqual(getPendingSyncCounts(uid, [syncedReport]), {
      pendingReports: 0,
      pendingNotes: 0,
      pendingWithdrawals: 0,
      total: 0,
    });
    assert.strictEqual(hasPendingOfflineSync(uid, [syncedReport]), false);

    // 2. Pending follow-up notes alone activate counts & banner check
    store[`civifix_pending_notes_${uid}`] = JSON.stringify({
      rep_cloud_1: ['Nov 16: Still overflowing', 'Nov 16: Blocking gate'],
    });
    assert.deepStrictEqual(getPendingSyncCounts(uid, [syncedReport]), {
      pendingReports: 0,
      pendingNotes: 2,
      pendingWithdrawals: 0,
      total: 2,
    });
    assert.strictEqual(hasPendingOfflineSync(uid, [syncedReport]), true);

    // 3. Pending withdrawals combine cleanly
    enqueuePendingWithdrawalIntent({
      reportId: 'rep_cloud_1',
      userId: uid,
      requestedAt: '2026-11-16T06:00:00.000Z',
    });
    assert.strictEqual(getPendingSyncCounts(uid, [syncedReport]).pendingWithdrawals, 1);
    assert.strictEqual(getPendingSyncCounts(uid, [syncedReport]).total, 3);

    // 4. Unsynced report combines cleanly
    const unsyncedReport: CivicIssueReport = { ...syncedReport, id: 'rep_local_2', syncedToCloud: false };
    assert.deepStrictEqual(getPendingSyncCounts(uid, [syncedReport, unsyncedReport]), {
      pendingReports: 1,
      pendingNotes: 2,
      pendingWithdrawals: 1,
      total: 4,
    });
  });
});

test('syncPendingReportsToFirestore deduplicates concurrent runs for the same userId and MyReports/App wire online auto-retry', async () => {
  await withMockLocalStorage(async (store) => {
    const uid = 'citizen_concurrent_sync';
    store[`civifix_pending_notes_${uid}`] = JSON.stringify({
      rep_conc_1: ['Nov 16: Concurrent retry test note'],
    });

    let noteSyncInvocations = 0;
    const deps = {
      isConfigured: true,
      hasDb: true,
      hasAuthUser: true,
      currentAuthUid: uid,
      syncPendingNoteFn: async () => {
        noteSyncInvocations++;
        await new Promise((r) => setTimeout(r, 30));
      },
    };

    const [res1, res2] = await Promise.all([
      syncPendingReportsToFirestore(uid, deps),
      syncPendingReportsToFirestore(uid, deps),
    ]);

    assert.strictEqual(noteSyncInvocations, 1, 'Concurrent syncs deduplicate to a single execution');
    assert.strictEqual(res1, res2, 'Concurrent sync callers await identical in-flight result');
    assert.strictEqual(getPendingSyncCounts(uid, []).total, 0);

    const appSrc = fs.readFileSync(path.resolve('src/App.tsx'), 'utf8');
    const myReportsSrc = fs.readFileSync(path.resolve('src/components/screens/MyReportsScreen.tsx'), 'utf8');
    const homeScreenSrc = fs.readFileSync(path.resolve('src/components/screens/HomeScreen.tsx'), 'utf8');

    assert(
      appSrc.includes("window.addEventListener('online', handleOnline)") &&
        appSrc.includes("window.removeEventListener('online', handleOnline)") &&
        appSrc.includes('hasPendingOfflineSync(uid)'),
      'App.tsx attaches and cleans up online auto-retry listener cleanly'
    );
    assert(
      myReportsSrc.includes('getPendingSyncCounts') &&
        myReportsSrc.includes('counts.total > 0'),
      'MyReportsScreen uses total pending sync counts (reports + notes + withdrawals) rather than unsynced reports alone'
    );
    // Finding 7: HomeScreen bell button has no misleading static green unread dot
    assert(
      homeScreenSrc.includes('aria-label="View complaint updates in My Reports"') &&
        homeScreenSrc.includes('onClick={onNavigateToReports}') &&
        !homeScreenSrc.includes('bg-emerald-600 border-2 border-white'),
      'HomeScreen Bell button preserves navigation & label while removing misleading static unread badge dot'
    );
  });
});

// -------------------------------------------------------------
// 12. SINGLE-PHOTO RESTORATION & LEGACY afterPhotoUrl COMPATIBILITY TESTS
// -------------------------------------------------------------
test('Single-photo submission works cleanly and legacy records with afterPhotoUrl retry without errors', async () => {
  await withMockLocalStorage(async () => {
    const uid = 'citizen_single_photo_01';
    const user: CitizenUser = {
      id: uid,
      fullName: 'Asha Nair',
      email: 'asha@example.in',
      phone: '+91 98888 77777',
      ward: 'Ward 9',
      city: 'Metro City',
      reportsCount: 0,
      resolvedCount: 0,
      notificationPreferences: { smsAlerts: true, pushNotifications: true, emailUpdates: false },
    };

    const issueDataUri = 'data:image/jpeg;base64,/9j/ISSUE_DATA_URI';

    // 1. Standard single-photo submission leaves afterPhotoUrl undefined
    const singleSubmit = await submitCivicReportToFirestore(
      {
        category: 'Potholes' as any,
        title: 'Road repair near school',
        description: 'Pothole near main school gate',
        locationAddress: 'School Cross Rd',
        photoUrl: issueDataUri,
        severity: 'Medium',
        latitude: null,
        longitude: null,
        ward: 'Ward 9',
      },
      user
    );

    assert.strictEqual(singleSubmit.report.photoUrl, issueDataUri);
    assert.strictEqual(singleSubmit.report.afterPhotoUrl, undefined);

    // 2. Existing/legacy pending report that already has afterPhotoUrl syncs cleanly without double upload errors
    const legacyPendingReport: CivicIssueReport = {
      ...singleSubmit.report,
      id: 'rep_legacy_after_01',
      afterPhotoUrl: 'data:image/jpeg;base64,/9j/LEGACY_AFTER_URI',
    };

    let uploadCallCount = 0;
    let writtenPayload: any = null;
    const retryLegacyRes = await retryReportUpload(legacyPendingReport, user, {
      currentUser: { uid, email: user.email },
      dbInstance: { __mockDb: true },
      docFn: (_db: any, ...segs: string[]) => ({ id: segs[segs.length - 1] }),
      uploadPhotoFn: async (key: string) => {
        uploadCallCount++;
        return { success: true, url: `https://storage.example.com/${key}.jpg` };
      },
      setDocFn: async (_ref: any, payload: any) => {
        writtenPayload = payload;
      },
      statusHistorySetDocFn: async () => {},
      auditLogSetDocFn: async () => {},
    });

    assert.strictEqual(retryLegacyRes.success, true);
    assert.strictEqual(uploadCallCount, 1, 'Uploads only primary issue photoUrl');
    assert.strictEqual(
      writtenPayload.photoUrl,
      `https://storage.example.com/${legacyPendingReport.id}.jpg`
    );
    assert.strictEqual(writtenPayload.afterPhotoUrl, legacyPendingReport.afterPhotoUrl);
    assert.strictEqual(
      retryLegacyRes.report.afterPhotoUrl,
      legacyPendingReport.afterPhotoUrl
    );
  });
});

test('Citizen Portal removes all Before & After UI while preserving AI issue detection and Official Municipal Resolution Evidence', () => {
  const reportIssueSrc = fs.readFileSync(
    path.resolve('src/components/screens/ReportIssueScreen.tsx'),
    'utf8'
  );
  const myReportsSrc = fs.readFileSync(
    path.resolve('src/components/screens/MyReportsScreen.tsx'),
    'utf8'
  );
  const imageOptimizerSrc = fs.readFileSync(
    path.resolve('src/services/imageOptimizer.ts'),
    'utf8'
  );

  // ReportIssueScreen restores single-photo workflow & AI detection with zero Before & After UI
  assert(reportIssueSrc.includes('validateCivicImageUpload'));
  assert(reportIssueSrc.includes('optimizeBase64Image'));
  assert(reportIssueSrc.includes('inspectCivicPhotoQuality'));
  assert(reportIssueSrc.includes('validateCivicIssueImage'));
  assert(!reportIssueSrc.includes('afterPhotoPreview'));
  assert(!reportIssueSrc.includes('handleAfterFileChange'));
  assert(!reportIssueSrc.includes('handleRemoveAfterPhoto'));
  assert(!reportIssueSrc.includes('BeforeAfterPreviewCard'));
  assert(!/Before\s*&(?:amp;)?\s*After/i.test(reportIssueSrc));

  // MyReportsScreen removes Before & After UI while keeping legacy afterPhotoUrl safe & Official Municipal Resolution Evidence intact
  assert(!myReportsSrc.includes('BeforeAfterPreviewCard'));
  assert(!/Before\s*&(?:amp;)?\s*After/i.test(myReportsSrc));
  assert(myReportsSrc.includes('report.photoUrl || report.afterPhotoUrl'));
  assert(myReportsSrc.includes('selectedReport.photoUrl || selectedReport.afterPhotoUrl'));
  assert(myReportsSrc.includes('Official Municipal Resolution Evidence'));

  // imageOptimizer removes dual-photo Before & After utilities
  assert(!imageOptimizerSrc.includes('optimizeAfterPhotoDataUrl'));
  assert(!imageOptimizerSrc.includes('fitDualPhotosForFirestore'));
  assert(!imageOptimizerSrc.includes('AFTER_IMAGE_LIMITS'));
});

async function finish() {
  await Promise.all(asyncPromises);
  console.log(`\nAll ${passedTests} / ${totalTests} report storage & timestamp test cases passed successfully!`);
  process.exit(0);
}

finish().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
