import assert from 'node:assert/strict';
import {
  isValidCoordinate,
  partitionReportsByLocation,
  haversineMeters,
  findDuplicateCandidates,
} from '../src/utils/reportLocations';
import { CivicIssueReport } from '../src/types/civic';

let passed = 0;
let total = 0;

function test(name: string, fn: () => void) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    console.error(`  ✗ FAIL: ${name} -> ${err?.message || err}`);
    process.exitCode = 1;
  }
}

function makeReport(overrides: Partial<CivicIssueReport> = {}): CivicIssueReport {
  return {
    id: 'rep-base',
    trackingNumber: 'CFX-2026-0001',
    category: 'Pothole',
    title: 'Deep pothole near bus stop',
    description: 'Large road crater blocking left lane near Jubilee Hills bus stop',
    photoUrl: '',
    location: {
      address: 'Road No 36, Jubilee Hills, Hyderabad',
      latitude: 17.4319,
      longitude: 78.4071,
      ward: 'Ward 10',
    },
    severity: 'High',
    status: 'Submitted',
    submittedAt: '2026-11-10T09:00:00.000Z',
    updatedAt: '2026-11-10T09:00:00.000Z',
    department: 'Roads & Infrastructure',
    slaDeadline: '24h',
    timeline: [],
    userId: 'user-1',
    ...overrides,
  };
}

console.log('\n--- RUNNING CIVIFIX AI LOCATION RECONCILIATION & DUPLICATE DETECTION TESTS ---');

test('isValidCoordinate accepts valid finite GPS coordinates and rejects null, NaN, out-of-range, and (0,0)', () => {
  assert.equal(isValidCoordinate(17.385, 78.4867), true);
  assert.equal(isValidCoordinate(0, 78.4867), true);
  assert.equal(isValidCoordinate(0, 0), false);
  assert.equal(isValidCoordinate(null, 78.4867), false);
  assert.equal(isValidCoordinate(17.385, undefined), false);
  assert.equal(isValidCoordinate(Number.NaN, 78.4867), false);
  assert.equal(isValidCoordinate(95, 78.4867), false);
  assert.equal(isValidCoordinate(17.385, 181), false);
});

test('partitionReportsByLocation reconciles active plotted, missing-coords active, and excluded inactive reports', () => {
  const reports: CivicIssueReport[] = [
    makeReport({ id: 'r1', status: 'Submitted' }),
    makeReport({
      id: 'r2',
      status: 'In Progress',
      location: { address: 'Manual entry only', latitude: null, longitude: null, ward: 'Unassigned Ward' },
    }),
    makeReport({ id: 'r3', status: 'Withdrawn' }),
    makeReport({ id: 'r4', status: 'Rejected' }),
    makeReport({ id: 'r5', status: 'Resolved' }),
  ];

  const partitioned = partitionReportsByLocation(reports);

  assert.equal(partitioned.counts.total, 5);
  assert.equal(partitioned.counts.active, 3);
  assert.equal(partitioned.counts.plottedActive, 2);
  assert.equal(partitioned.counts.missingCoordsActive, 1);
  assert.equal(partitioned.counts.excludedInactive, 2);
  assert.equal(partitioned.counts.plottedActive + partitioned.counts.missingCoordsActive, partitioned.counts.active);
  assert.equal(partitioned.counts.active + partitioned.counts.excludedInactive, partitioned.counts.total);
  assert.deepEqual(
    partitioned.activePlottedReports.map((r) => r.id),
    ['r1', 'r5']
  );
  assert.deepEqual(
    partitioned.missingLocationActiveReports.map((r) => r.id),
    ['r2']
  );
});

test('haversineMeters computes zero for identical coordinates and accurate short distances', () => {
  assert.equal(haversineMeters(17.4319, 78.4071, 17.4319, 78.4071), 0);
  const meters = haversineMeters(17.4319, 78.4071, 17.4321, 78.4072);
  assert.ok(meters > 15 && meters < 40, `Expected ~24m, got ${meters}`);
});

test('findDuplicateCandidates flags nearby same-category report, ignores self and Withdrawn, and matches address/description', () => {
  const target = makeReport({ id: 'target-1', trackingNumber: 'CFX-100' });
  const nearSameCategory = makeReport({
    id: 'cand-near',
    trackingNumber: 'CFX-101',
    location: {
      address: 'Road No 36, Jubilee Hills, Hyderabad',
      latitude: 17.4320,
      longitude: 78.4072,
      ward: 'Ward 10',
    },
  });
  const withdrawnDup = makeReport({
    id: 'cand-withdrawn',
    trackingNumber: 'CFX-102',
    status: 'Withdrawn',
  });
  const farUnrelated = makeReport({
    id: 'cand-far',
    trackingNumber: 'CFX-103',
    category: 'Broken Streetlight',
    title: 'Dark park lamp',
    description: 'Lamp out inside park',
    location: {
      address: 'Banjara Hills Road 12',
      latitude: 17.412,
      longitude: 78.445,
      ward: 'Ward 2',
    },
  });
  const textualDup = makeReport({
    id: 'cand-text',
    trackingNumber: 'CFX-104',
    location: {
      address: 'Road No 36, Jubilee Hills, Hyderabad',
      latitude: null,
      longitude: null,
      ward: 'Ward 10',
    },
  });

  const candidates = findDuplicateCandidates(target, [
    target,
    nearSameCategory,
    withdrawnDup,
    farUnrelated,
    textualDup,
  ]);

  const ids = candidates.map((c) => c.report.id);
  assert.ok(ids.includes('cand-near'), 'Should detect nearby same-category duplicate');
  assert.ok(ids.includes('cand-text'), 'Should detect matching address + category + description without GPS');
  assert.ok(!ids.includes('target-1'), 'Must exclude target report itself');
  assert.ok(!ids.includes('cand-withdrawn'), 'Must ignore withdrawn reports');
  assert.ok(!ids.includes('cand-far'), 'Must exclude distant unrelated reports');
  assert.equal(candidates[0].report.id, 'cand-near', 'Closest nearby GPS duplicate should rank first');
});

console.log(`\nAll ${passed} / ${total} reportLocations tests passed!`);
