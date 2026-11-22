import { CivicIssueReport, normalizeCivicCategory } from '../types/civic';

export interface LocationPartitionResult {
  activeReports: CivicIssueReport[];
  activePlottedReports: CivicIssueReport[];
  missingLocationActiveReports: CivicIssueReport[];
  excludedInactiveReports: CivicIssueReport[];
  allPlottedReports: CivicIssueReport[];
  counts: {
    total: number;
    active: number;
    plottedActive: number;
    missingCoordsActive: number;
    excludedInactive: number;
  };
}

export interface DuplicateCandidate {
  report: CivicIssueReport;
  distanceMeters: number | null;
  score: number;
  reasons: string[];
}

const INACTIVE_STATUSES = new Set(['Withdrawn', 'Rejected']);

/**
 * Validates geographic latitude/longitude pairs strictly without treating 0 as falsy
 * while rejecting null/NaN/Infinity, out-of-range coordinates, and exact (0,0) placeholders.
 */
export function isValidCoordinate(
  lat: number | null | undefined,
  lng: number | null | undefined
): boolean {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  if (lat === 0 && lng === 0) return false;
  return true;
}

/**
 * Reconciles a report list into active plotted reports, active reports missing GPS coordinates,
 * and inactive (Withdrawn / Rejected) reports so map totals always match list totals transparently.
 */
export function partitionReportsByLocation(reports: CivicIssueReport[]): LocationPartitionResult {
  const activeReports: CivicIssueReport[] = [];
  const activePlottedReports: CivicIssueReport[] = [];
  const missingLocationActiveReports: CivicIssueReport[] = [];
  const excludedInactiveReports: CivicIssueReport[] = [];
  const allPlottedReports: CivicIssueReport[] = [];

  for (const report of reports) {
    const hasValidCoords = isValidCoordinate(report.location?.latitude, report.location?.longitude);
    if (hasValidCoords) {
      allPlottedReports.push(report);
    }

    if (report.archived || INACTIVE_STATUSES.has(report.status)) {
      excludedInactiveReports.push(report);
    } else {
      activeReports.push(report);
      if (hasValidCoords) {
        activePlottedReports.push(report);
      } else {
        missingLocationActiveReports.push(report);
      }
    }
  }

  return {
    activeReports,
    activePlottedReports,
    missingLocationActiveReports,
    excludedInactiveReports,
    allPlottedReports,
    counts: {
      total: reports.length,
      active: activeReports.length,
      plottedActive: activePlottedReports.length,
      missingCoordsActive: missingLocationActiveReports.length,
      excludedInactive: excludedInactiveReports.length,
    },
  };
}

/**
 * Great-circle Haversine distance in meters between two GPS coordinates.
 */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

function tokenize(text: string): Set<string> {
  return new Set(
    (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3)
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Finds potential duplicate or overlapping civic reports for admin triage.
 * Never alters Firestore data; computes deterministic proximity + address/category similarity.
 */
export function findDuplicateCandidates(
  target: CivicIssueReport,
  allReports: CivicIssueReport[],
  radiusMeters: number = 150
): DuplicateCandidate[] {
  const targetHasCoords = isValidCoordinate(target.location?.latitude, target.location?.longitude);
  const targetAddressTokens = tokenize(target.location?.address || '');
  const targetDescTokens = tokenize(`${target.title || ''} ${target.description || ''}`);

  const candidates: DuplicateCandidate[] = [];

  for (const candidate of allReports) {
    if (!candidate || candidate.id === target.id) continue;
    if (candidate.archived || candidate.status === 'Withdrawn') continue;

    const reasons: string[] = [];
    let score = 0;
    let distanceMeters: number | null = null;

    const candidateHasCoords = isValidCoordinate(
      candidate.location?.latitude,
      candidate.location?.longitude
    );

    if (targetHasCoords && candidateHasCoords) {
      distanceMeters = haversineMeters(
        target.location.latitude as number,
        target.location.longitude as number,
        candidate.location.latitude as number,
        candidate.location.longitude as number
      );
      if (distanceMeters <= radiusMeters) {
        score += distanceMeters <= 40 ? 60 : 40;
        reasons.push(`Within ${distanceMeters}m of target GPS`);
      }
    }

    const targetCategory = normalizeCivicCategory(target.category);
    const candidateCategory = normalizeCivicCategory(candidate.category);
    const sameCategory = candidateCategory === targetCategory;
    if (sameCategory) {
      score += 20;
      reasons.push(`Same category (${candidateCategory})`);
    }

    const addressSim = jaccardSimilarity(
      targetAddressTokens,
      tokenize(candidate.location?.address || '')
    );
    if (addressSim >= 0.45) {
      score += 30;
      reasons.push('Matching street/landmark address');
    }

    const descSim = jaccardSimilarity(
      targetDescTokens,
      tokenize(`${candidate.title || ''} ${candidate.description || ''}`)
    );
    if (descSim >= 0.35) {
      score += 20;
      reasons.push('Similar issue description');
    }

    const isNearbyDuplicate = distanceMeters !== null && distanceMeters <= radiusMeters && (sameCategory || addressSim >= 0.25);
    const isTextualDuplicate = sameCategory && addressSim >= 0.45 && descSim >= 0.25;

    if (isNearbyDuplicate || isTextualDuplicate || score >= 60) {
      candidates.push({
        report: candidate,
        distanceMeters,
        score: Math.min(100, score),
        reasons,
      });
    }
  }

  return candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const distA = a.distanceMeters ?? Number.MAX_SAFE_INTEGER;
    const distB = b.distanceMeters ?? Number.MAX_SAFE_INTEGER;
    return distA - distB;
  });
}
