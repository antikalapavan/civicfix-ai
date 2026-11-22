import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  calculateAdminStats,
  extractCitizenSummaries,
} from '../src/services/adminService';
import {
  CivicIssueReport,
  CANONICAL_MUNICIPAL_DEPARTMENTS,
  resolveReportCanonicalDepartment,
  resolveTimelineActor,
  resolveAuditLogActor,
  normalizeReportStatus,
  normalizeCivicCategory,
} from '../src/types/civic';
import {
  validateMeaningfulCivicText,
  validateOfficerName,
  assessTextEntryQuality,
  assessReportDataQuality,
  generateSafeCitizenCode,
  sanitizeCitizenDisplayName,
} from '../src/utils/inputValidation';
import {
  isValidCoordinate,
  partitionReportsByLocation,
} from '../src/utils/reportLocations';

console.log('--- RUNNING CIVIFIX AI QUALITY-FIX REGRESSION TEST SUITE ---');

function makeReport(overrides: Partial<CivicIssueReport> = {}): CivicIssueReport {
  return {
    id: 'rep-default',
    trackingNumber: 'CFX-2026-1001',
    userId: 'uid-citizen-alpha-123456',
    citizenName: 'Anita Sharma',
    citizenEmail: 'anita.sharma@example.com',
    category: 'Garbage',
    normalizedCategory: 'Garbage accumulation',
    department: 'Solid Waste Management',
    title: 'Garbage overflow near market entrance',
    description: 'Large pile of uncollected household garbage blocking the footpath.',
    photoUrl: '',
    location: {
      address: '14 Market Road',
      latitude: 17.385,
      longitude: 78.4867,
      ward: 'Ward 47 - Metro Green Zone',
    },
    severity: 'Medium',
    status: 'Submitted',
    submittedAt: '2026-04-01T08:00:00.000Z',
    updatedAt: '2026-04-01T08:00:00.000Z',
    slaDeadline: '2026-04-03T08:00:00.000Z',
    syncedToCloud: true,
    citizenNotes: [],
    timeline: [
      {
        status: 'Submitted',
        timestamp: '2026-04-01T08:00:00.000Z',
        note: 'Complaint submitted by citizen.',
        officer: 'Citizen',
      },
    ],
    ...overrides,
  };
}

// =========================================================================
// 1. DASHBOARD STATISTICS & WITHDRAWN EXCLUSION PARITY
// =========================================================================
{
  const dataset: CivicIssueReport[] = [
    makeReport({ id: 'r1', status: 'Submitted' }),
    makeReport({ id: 'r2', status: 'Under Review' }),
    makeReport({ id: 'r3', status: 'Assigned' }),
    makeReport({ id: 'r4', status: 'In Progress' }),
    makeReport({
      id: 'r5',
      status: 'Resolved',
      submittedAt: '2026-04-01T08:00:00.000Z',
      resolvedAt: '2026-04-01T14:00:00.000Z',
    }),
    makeReport({ id: 'r6', status: 'Rejected' }),
    makeReport({ id: 'r7', status: 'Withdrawn' }),
    // Legacy/malformed status normalization -> falls back cleanly to Submitted
    makeReport({ id: 'r8', status: 'unknown-legacy' as any }),
  ];

  const stats = calculateAdminStats(dataset);
  assert.strictEqual(stats.totalReports, 8);
  assert.strictEqual(stats.pendingReports, 3, 'Submitted (1+legacy) + Under Review = 3');
  assert.strictEqual(stats.inProgressReports, 2, 'Assigned + In Progress = 2');
  assert.strictEqual(stats.resolvedReports, 1);
  assert.strictEqual(stats.rejectedReports, 1);
  assert.strictEqual(stats.withdrawnReports, 1);

  const sumBuckets =
    stats.pendingReports +
    stats.inProgressReports +
    stats.resolvedReports +
    stats.rejectedReports +
    stats.withdrawnReports;
  assert.strictEqual(sumBuckets, stats.totalReports, 'Every report belongs to exactly one lifecycle bucket');

  const statusDistSum = Object.values(stats.statusDistribution).reduce((a, b) => a + b, 0);
  assert.strictEqual(statusDistSum, stats.totalReports);
  assert.strictEqual(stats.avgResolutionHours, 6, 'Avg resolution hours calculated strictly from valid Resolved timestamps');

  // When no valid Resolved timestamps exist, avgResolutionHours must be null (UI displays "Not available")
  const unresolvedStats = calculateAdminStats([
    makeReport({ id: 'u1', status: 'Submitted' }),
    makeReport({ id: 'u2', status: 'Resolved', submittedAt: 'invalid-date', resolvedAt: 'bad-date' }),
  ]);
  assert.strictEqual(unresolvedStats.avgResolutionHours, null);
  console.log('  ✓ Dashboard stats parity, Withdrawn isolation, and finite SLA checks pass');
}

// =========================================================================
// 2. DEPARTMENT AGGREGATION & CANONICAL NORMALIZATION
// =========================================================================
{
  const reports: CivicIssueReport[] = [
    makeReport({ id: 'd1', category: 'Garbage', department: 'Sanitation & Solid Waste', status: 'Submitted' }),
    makeReport({ id: 'd2', category: 'Pothole', normalizedCategory: undefined, department: '', status: 'In Progress' }),
    makeReport({ id: 'd3', category: 'Drainage', normalizedCategory: undefined, department: 'Stormwater & Drainage Wing', status: 'Withdrawn' }),
    makeReport({ id: 'd4', category: 'Water Leakage', normalizedCategory: undefined, department: '', status: 'Rejected' }),
    makeReport({
      id: 'd5',
      category: 'Broken Streetlight',
      normalizedCategory: undefined,
      department: '',
      status: 'Resolved',
      submittedAt: '2026-04-02T10:00:00.000Z',
      resolvedAt: '2026-04-02T13:00:00.000Z',
    }),
  ];

  assert.strictEqual(resolveReportCanonicalDepartment(reports[0]), 'Solid Waste Management');
  assert.strictEqual(resolveReportCanonicalDepartment(reports[1]), 'Roads & Infrastructure Maintenance');
  assert.strictEqual(resolveReportCanonicalDepartment(reports[2]), 'Stormwater Drainage & Flood Control');
  assert.strictEqual(resolveReportCanonicalDepartment(reports[3]), 'Water Supply & Sewerage Board');
  assert.strictEqual(resolveReportCanonicalDepartment(reports[4]), 'Electrical & Street Lighting Department');
  assert.strictEqual(resolveReportCanonicalDepartment({ department: 'Sanitation Dept' }), 'Public Health & Sanitation');

  // Verify department totals equal pending + active + resolved + rejected + withdrawn
  const deptCounts = new Map<string, { total: number; pending: number; active: number; resolved: number; rejWith: number }>();
  for (const d of CANONICAL_MUNICIPAL_DEPARTMENTS) {
    deptCounts.set(d, { total: 0, pending: 0, active: 0, resolved: 0, rejWith: 0 });
  }
  for (const r of reports) {
    const dept = resolveReportCanonicalDepartment(r);
    const entry = deptCounts.get(dept)!;
    const status = normalizeReportStatus(r.status);
    entry.total++;
    if (status === 'Submitted' || status === 'Under Review') entry.pending++;
    else if (status === 'Assigned' || status === 'In Progress') entry.active++;
    else if (status === 'Resolved') entry.resolved++;
    else entry.rejWith++;
  }

  for (const [deptName, agg] of deptCounts.entries()) {
    assert.strictEqual(
      agg.pending + agg.active + agg.resolved + agg.rejWith,
      agg.total,
      `Department "${deptName}" subcounts must sum exactly to total`
    );
  }
  console.log('  ✓ Department canonical normalization and ticket count reconciliation pass');
}

// =========================================================================
// 3. CITIZENS DIRECTORY PRIVACY & SANITIZATION
// =========================================================================
{
  const sensitiveReports: CivicIssueReport[] = [
    makeReport({
      id: 'p1',
      userId: '245124748053_secret_firebase_uid_xyz',
      citizenName: '245124748053@cbit.ac.in',
      citizenEmail: '245124748053@cbit.ac.in',
      status: 'Resolved',
    }),
    makeReport({
      id: 'p2',
      userId: 'firebase-uid-secret-99887766',
      citizenName: '245124748053',
      citizenEmail: 'citizen.real@gmail.com',
      status: 'Submitted',
    }),
    makeReport({
      id: 'p3',
      userId: 'firebase-uid-secret-55443322',
      citizenName: 'Meera Nair',
      citizenEmail: 'meera@gmail.com',
      status: 'Submitted',
    }),
  ];

  const summaries = extractCitizenSummaries(sensitiveReports);
  assert.strictEqual(summaries.length, 3);

  for (const s of summaries) {
    assert(!s.name.includes('@'), `Display name must never expose email domain: ${s.name}`);
    assert(!s.name.includes('245124748053'), `Display name must never expose student/roll ID: ${s.name}`);
    assert(!s.name.includes('firebase-uid'), `Display name must never expose raw UID: ${s.name}`);
    assert(!s.email.includes('@'), `Summary email must never expose real or fake domain: ${s.email}`);
    assert(!s.phone.includes('+91'), `Summary phone must never fabricate +91 numbers: ${s.phone}`);
    assert(s.phone.includes('••••'), 'Summary phone must display protected mask');
    assert(s.email.includes('•••'), 'Summary email must display protected mask');

    const code = generateSafeCitizenCode(s.id);
    assert(/^CIT-[0-9A-F]{6}$/.test(code), `Citizen ref code must be opaque CIT-XXXXXX, got ${code}`);
    assert(!code.includes('24512474'), 'Citizen ref code must never expose raw user ID prefix');
  }

  const meera = summaries.find((s) => s.id === 'firebase-uid-secret-55443322');
  assert.strictEqual(meera?.name, 'Meera Nair', 'Legitimate human names are preserved');
  assert.strictEqual(sanitizeCitizenDisplayName('qwertyui', 'uid-1'), 'Registered Citizen');
  console.log('  ✓ Citizen directory privacy protection (no email domains, student IDs, UIDs, or fake phones)');
}

// =========================================================================
// 4. ACTIVITY & AUDIT TRAIL ACTOR ATTRIBUTION
// =========================================================================
{
  const submittedLegacy = resolveTimelineActor(
    {
      status: 'Submitted',
      timestamp: '2026-04-01T08:00:00.000Z',
      note: 'Report submitted via CiviFix AI Citizen Portal.',
    },
    makeReport()
  );
  assert.strictEqual(submittedLegacy.role, 'citizen');
  assert.strictEqual(submittedLegacy.label, 'Citizen', 'Citizen submission must never be labeled Municipal Officer');

  const withdrawnLegacy = resolveTimelineActor({
    status: 'Withdrawn',
    timestamp: '2026-04-01T09:00:00.000Z',
    note: 'Report withdrawn.',
  });
  assert.strictEqual(withdrawnLegacy.role, 'citizen');
  assert.strictEqual(withdrawnLegacy.label, 'Citizen');

  const namedOfficer = resolveTimelineActor({
    status: 'Assigned',
    timestamp: '2026-04-01T10:00:00.000Z',
    note: 'Assigned to field inspector',
    officer: 'Rakesh Verma',
  });
  assert.strictEqual(namedOfficer.role, 'officer');
  assert.strictEqual(namedOfficer.label, 'Municipal Officer (Rakesh Verma)', 'Named officer must remain readable and unmasked');

  const adminActor = resolveTimelineActor({
    status: 'In Progress',
    timestamp: '2026-04-01T11:00:00.000Z',
    note: 'Crew dispatched.',
    officer: 'superadmin@municipality.gov',
  });
  assert.strictEqual(adminActor.role, 'admin');
  assert(!adminActor.label.includes('@'), 'Email actor must never appear in resolved activity label');

  const auditCitizen = resolveAuditLogActor({
    action: 'report_created',
    actorRole: 'citizen',
    actorUid: 'secret-uid-123',
  });
  assert.strictEqual(auditCitizen.label, 'Citizen');

  const auditAdmin = resolveAuditLogActor({
    action: 'admin_status_change',
    actorRole: 'admin',
    metadata: { assignedOfficer: 'S. Reddy' },
  });
  assert.strictEqual(auditAdmin.label, 'Municipal Administrator · Officer: S. Reddy');
  console.log('  ✓ Activity & Audit actor attribution accurately separates Citizen, Admin, Officer, and System');
}

// =========================================================================
// 5. MAP COORDINATES & NON-TECHNICAL UNAVAILABLE FALLBACK COPY
// =========================================================================
{
  assert.strictEqual(isValidCoordinate(17.385, 78.4867), true);
  assert.strictEqual(isValidCoordinate(0, 0), false, 'Null-island (0,0) must be rejected');
  assert.strictEqual(isValidCoordinate(null, null), false);
  assert.strictEqual(isValidCoordinate(NaN, 78.4), false);
  assert.strictEqual(isValidCoordinate(95, 78.4), false);

  const part = partitionReportsByLocation([
    makeReport({ id: 'm1', status: 'Submitted', location: { address: 'Addr 1', latitude: 17.4, longitude: 78.5, ward: 'Ward 1' } }),
    makeReport({ id: 'm2', status: 'Withdrawn', location: { address: 'Addr 2', latitude: 17.41, longitude: 78.51, ward: 'Ward 1' } }),
    makeReport({ id: 'm3', status: 'Submitted', location: { address: 'Addr 3', latitude: 0, longitude: 0, ward: 'Ward 1' } }),
  ]);
  assert.strictEqual(part.activePlottedReports.length, 1);
  assert.strictEqual(part.activePlottedReports[0].id, 'm1');
  assert.strictEqual(part.counts.missingCoordsActive, 1);
  assert.strictEqual(part.counts.excludedInactive, 1);

  const mapSource = fs.readFileSync(path.resolve('src/components/CivicReportsMap.tsx'), 'utf8');
  assert(
    mapSource.includes('Map is currently unavailable. Use List View to manage complaints.'),
    'CivicReportsMap must use exact clean unavailable fallback message'
  );
  assert(
    !mapSource.includes('Google Maps API Key Not Configured') &&
      !mapSource.includes('KeyRound'),
    'CivicReportsMap must not show developer API key instructions'
  );
  assert(
    !mapSource.includes("lat: 12.9716, lng: 77.5946"),
    'CivicReportsMap must not fall back to hardcoded Bengaluru coordinates'
  );
  console.log('  ✓ Map coordinate validation, filtering, and non-technical fallback copy verified');
}

// =========================================================================
// 6. INPUT VALIDATION & NON-DESTRUCTIVE TEST/JUNK DATA DETECTION
// =========================================================================
{
  for (const junk of ['qwertyui', 'asdfghjk', '123456', 'aaaaaaa', 'test', '   ']) {
    const res = validateMeaningfulCivicText(junk, {
      fieldLabel: 'Issue description',
      minLength: 10,
      required: true,
    });
    assert.strictEqual(res.valid, false, `Junk input "${junk}" must be rejected`);
  }

  const validCivic = validateMeaningfulCivicText('Overflowing garbage bin blocking sidewalk near Sector 4 market.', {
    fieldLabel: 'Issue description',
    minLength: 10,
    required: true,
  });
  assert.strictEqual(validCivic.valid, true);

  const validConciseResolution = validateMeaningfulCivicText('Fixed', {
    fieldLabel: 'Resolution summary',
    minLength: 2,
    required: false,
    allowShortConcise: true,
  });
  assert.strictEqual(validConciseResolution.valid, true, 'Concise real municipal text like "Fixed" remains accepted');

  const junkConciseResolution = validateMeaningfulCivicText('qwertyui', {
    fieldLabel: 'Resolution summary',
    minLength: 2,
    required: false,
    allowShortConcise: true,
  });
  assert.strictEqual(junkConciseResolution.valid, false, 'Keyboard mash like "qwertyui" must still fail even with allowShortConcise');

  assert.strictEqual(validateOfficerName('Ramesh Kumar').valid, true);
  assert.strictEqual(validateOfficerName('qwerty').valid, false);
  assert.strictEqual(validateOfficerName('123456').valid, false);

  const suspiciousReport = makeReport({
    title: 'qwertyui',
    description: 'asdfghjkl',
  });
  const quality = assessReportDataQuality(suspiciousReport);
  assert.strictEqual(quality.isSuspicious, true);
  assert.strictEqual(quality.titleSuspicious, true);
  assert.strictEqual(quality.descriptionSuspicious, true);
  assert.strictEqual(assessTextEntryQuality('qwertyui').isSuspicious, true);
  assert.strictEqual(assessTextEntryQuality('Broken streetlight near Ward 12').isSuspicious, false);
  console.log('  ✓ Junk/test input validation and non-destructive data quality detection verified');
}

// =========================================================================
// 7. USER-FACING JARGON & BEFORE/AFTER REMOVAL AUDIT
// =========================================================================
{
  const homeSource = fs.readFileSync(path.resolve('src/components/screens/HomeScreen.tsx'), 'utf8');
  assert(!homeSource.includes('Before/After') && !homeSource.includes('Before & After'), 'HomeScreen must not reference Before/After');

  const myReportsSource = fs.readFileSync(path.resolve('src/components/screens/MyReportsScreen.tsx'), 'utf8');
  assert(!myReportsSource.includes('Local Storage'), 'MyReportsScreen must not show raw Local Storage wording');

  const translationsSource = fs.readFileSync(path.resolve('src/locales/translations.ts'), 'utf8');
  assert(!translationsSource.includes('Simulated in Prototype'), 'translations.ts must not contain Simulated in Prototype');
  assert(!translationsSource.includes('Cloud Firestore'), 'translations.ts must not contain Cloud Firestore');

  const adminDashSource = fs.readFileSync(path.resolve('src/components/admin/AdminDashboard.tsx'), 'utf8');
  assert(!adminDashSource.includes('Ref: {report.userId'), 'AdminDashboard must never render UID slices');
  assert(!adminDashSource.includes('via fallback'), 'AdminDashboard must not expose fallback jargon in Activity UI');
  assert(!adminDashSource.includes('/departments'), 'AdminDashboard must not expose collection path /departments');

  console.log('  ✓ User-facing copy & Before/After removal audit passed');
}

// Sanity check category normalization
assert.strictEqual(normalizeCivicCategory('Garbage'), 'Garbage accumulation');
console.log('--- ALL QUALITY-FIX REGRESSION TESTS PASSED ---');
