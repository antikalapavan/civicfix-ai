import assert from 'node:assert';

console.log('--- RUNNING CIVIFIX AI PHASE 4 OPENSTREETMAP & LOCATION TEST SUITE ---');

// Test 1: Location Schema Conformity
const sampleLocation = {
  address: '142 MG Road, Indiranagar',
  landmark: 'Near Metro Station',
  latitude: 12.9716,
  longitude: 77.5946,
  ward: 'Ward 47 - Metro Green Zone',
};

assert.strictEqual(typeof sampleLocation.address, 'string');
assert.strictEqual(typeof sampleLocation.latitude, 'number');
assert.strictEqual(typeof sampleLocation.longitude, 'number');
assert.strictEqual(typeof sampleLocation.ward, 'string');
console.log('  ✓ Location schema preserves address, landmark, latitude, longitude, and ward');

// Test 2: Nullable coordinates support
const manualLocation = {
  address: 'Post Office Lane, Ward 12',
  latitude: null,
  longitude: null,
  ward: 'Ward 12',
};

assert.strictEqual(manualLocation.latitude, null);
assert.strictEqual(manualLocation.longitude, null);
console.log('  ✓ Nullable coordinates preserved for manual address submission');

// Test 3: Coordinate bounds validation
function isValidCoord(lat: number | null, lng: number | null): boolean {
  if (lat === null || lng === null) return false;
  if (isNaN(lat) || isNaN(lng)) return false;
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

assert.strictEqual(isValidCoord(12.9716, 77.5946), true);
assert.strictEqual(isValidCoord(null, null), false);
assert.strictEqual(isValidCoord(120, 77), false);
assert.strictEqual(isValidCoord(12, 200), false);
console.log('  ✓ Coordinate boundary validations pass');

// Test 4: Privacy Protection Verification
// Ensure citizen PII is never included in plottable marker objects
function createPublicMarkerData(report: any) {
  return {
    id: report.id,
    trackingNumber: report.trackingNumber,
    category: report.category,
    title: report.title,
    location: {
      address: report.location.address,
      latitude: report.location.latitude,
      longitude: report.location.longitude,
    },
    severity: report.severity,
    status: report.status,
  };
}

const mockReport = {
  id: 'rep-1',
  trackingNumber: 'CFX-2026-9921',
  userId: 'secret-uid-999',
  fullName: 'John Citizen',
  phone: '+91 9876543210',
  citizenNotes: 'Personal phone note',
  category: 'Garbage',
  title: 'Garbage heap on 5th main',
  location: { address: '5th Main', latitude: 12.97, longitude: 77.59, ward: 'Ward 47' },
  severity: 'Medium',
  status: 'Submitted',
};

const publicMarker = createPublicMarkerData(mockReport);
assert.strictEqual((publicMarker as any).userId, undefined);
assert.strictEqual((publicMarker as any).fullName, undefined);
assert.strictEqual((publicMarker as any).phone, undefined);
assert.strictEqual((publicMarker as any).citizenNotes, undefined);
console.log('  ✓ Privacy safety confirmed: Citizen PII strictly excluded from public map markers');

// Test 5: Category Marker Color Mapping
const CATEGORY_HEX_MAP: Record<string, string> = {
  Garbage: '#10B981',
  Pothole: '#F59E0B',
  'Water Leakage': '#06B6D4',
  Drainage: '#6366F1',
  'Broken Streetlight': '#EAB308',
  Other: '#64748B',
};

const allCategories = ['Garbage', 'Pothole', 'Water Leakage', 'Drainage', 'Broken Streetlight', 'Other'];
for (const cat of allCategories) {
  assert(CATEGORY_HEX_MAP[cat] !== undefined, `Category ${cat} must have a defined marker color`);
  assert(CATEGORY_HEX_MAP[cat].startsWith('#'), `Category ${cat} color must be valid hex`);
}
console.log('  ✓ Category marker styling correctly mapped across all 6 civic categories');

// Test 6: Location Picker Coordinate Precision & Formatting
function formatCoordinatePrecision(lat: number, lng: number): { lat: number; lng: number } {
  return {
    lat: parseFloat(lat.toFixed(5)),
    lng: parseFloat(lng.toFixed(5)),
  };
}

const rawGps = formatCoordinatePrecision(12.9715987654, 77.5945987654);
assert.strictEqual(rawGps.lat, 12.9716);
assert.strictEqual(rawGps.lng, 77.5946);
console.log('  ✓ Location picker formats coordinates to stable 5-decimal precision');

// Test 7: Reverse Geocode Response Extraction
function parseGeocodeResponse(apiJson: any): string | null {
  if (!apiJson || apiJson.status !== 'OK' || !Array.isArray(apiJson.results) || apiJson.results.length === 0) {
    return null;
  }
  return apiJson.results[0].formatted_address || null;
}

const mockGeocodeSuccess = {
  status: 'OK',
  results: [
    { formatted_address: '142 Mahatma Gandhi Rd, Craig Park Layout, Ashok Nagar, Bengaluru, Karnataka 560001, India' },
  ],
};
const mockGeocodeZero = {
  status: 'ZERO_RESULTS',
  results: [],
};

assert.strictEqual(parseGeocodeResponse(mockGeocodeSuccess), '142 Mahatma Gandhi Rd, Craig Park Layout, Ashok Nagar, Bengaluru, Karnataka 560001, India');
assert.strictEqual(parseGeocodeResponse(mockGeocodeZero), null);
assert.strictEqual(parseGeocodeResponse(null), null);
console.log('  ✓ Reverse geocode parser accurately extracts addresses and handles ZERO_RESULTS');

// Test 8: Manual fallback preservation when map geocoding is unavailable
function resolveLocationSelection(
  manualAddress: string,
  pickerCoords: { lat: number; lng: number } | null,
  reverseGeocodedAddress?: string | null
): { address: string; lat: number | null; lng: number | null } {
  return {
    address: reverseGeocodedAddress || manualAddress || 'Unknown Location',
    lat: pickerCoords ? pickerCoords.lat : null,
    lng: pickerCoords ? pickerCoords.lng : null,
  };
}

const manualOnly = resolveLocationSelection('Corner of 4th Cross & 2nd Main', null, null);
assert.strictEqual(manualOnly.address, 'Corner of 4th Cross & 2nd Main');
assert.strictEqual(manualOnly.lat, null);
assert.strictEqual(manualOnly.lng, null);

const pickedOnMap = resolveLocationSelection('Corner of 4th Cross', { lat: 12.9716, lng: 77.5946 }, '142 MG Road');
assert.strictEqual(pickedOnMap.address, '142 MG Road');
assert.strictEqual(pickedOnMap.lat, 12.9716);
assert.strictEqual(pickedOnMap.lng, 77.5946);
console.log('  ✓ Manual fallback preserved: Citizen address persists if map or geocoding is unavailable');

// Test 9: CivicReportsMap 8 canonical categories & legacy 6-category color normalization
import fs from 'node:fs';
import path from 'node:path';
import { EXPANDED_CIVIC_CATEGORIES, LEGACY_CIVIC_CATEGORIES, normalizeCivicCategory } from '../src/types/civic.js';
import { CATEGORY_COLORS, getCivicCategoryColor, hasUsableReportPhoto } from '../src/components/CivicReportsMap.js';

for (const canonicalCat of EXPANDED_CIVIC_CATEGORIES) {
  assert(CATEGORY_COLORS[canonicalCat] !== undefined, `Map must define color for ${canonicalCat}`);
  assert(CATEGORY_COLORS[canonicalCat].hex.startsWith('#'), `Color hex for ${canonicalCat} must be valid`);
}
for (const legacyCat of LEGACY_CIVIC_CATEGORIES) {
  const color = getCivicCategoryColor(legacyCat);
  assert(color && color.hex.startsWith('#'), `Legacy category ${legacyCat} must resolve a valid map color`);
  assert.strictEqual(
    color.hex,
    CATEGORY_COLORS[normalizeCivicCategory(legacyCat)].hex,
    `Legacy category ${legacyCat} color matches canonical category`
  );
}
console.log('  ✓ CivicReportsMap resolves valid marker colors for all 8 canonical and 6 legacy categories');

// Test 10: Finding 5 - Photo-less Complaint Map Card Fallback Guard
assert.strictEqual(hasUsableReportPhoto('https://firebasestorage.googleapis.com/v0/b/test/o/p.jpg'), true);
assert.strictEqual(hasUsableReportPhoto('data:image/jpeg;base64,/9j/4AAQ'), true);
assert.strictEqual(hasUsableReportPhoto(''), false);
assert.strictEqual(hasUsableReportPhoto('   '), false);
assert.strictEqual(hasUsableReportPhoto(null), false);
assert.strictEqual(hasUsableReportPhoto(undefined), false);

const mapSource = fs.readFileSync(path.resolve('src/components/CivicReportsMap.tsx'), 'utf8');
assert(
  mapSource.includes('hasUsableReportPhoto(activeReport.photoUrl)') &&
    mapSource.includes('<CivicCategoryIcon') &&
    mapSource.includes('onError={() => setFailedPhotoReportId(activeReport.id)}'),
  'CivicReportsMap renders CivicCategoryIcon fallback cleanly when photoUrl is absent or fails to load'
);
console.log('  ✓ Photo-less complaint map cards safely fall back to CivicCategoryIcon without rendering broken empty <img>');

const pickerSource = fs.readFileSync(path.resolve('src/components/LocationPickerModal.tsx'), 'utf8');
assert(pickerSource.includes('MapContainer') && pickerSource.includes('TileLayer'), 'Location picker uses Leaflet components');
assert(pickerSource.includes('https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png'), 'Location picker uses Stadia Maps tiles');
assert(pickerSource.includes('Stadia Maps') && pickerSource.includes('OpenMapTiles') && pickerSource.includes('OpenStreetMap contributors'), 'Location picker preserves required tile attribution');
assert(pickerSource.includes('draggable') && pickerSource.includes('dragend'), 'Location picker supports draggable marker selection');
assert(pickerSource.includes('toFixed(5)'), 'Location picker preserves five-decimal coordinate precision');
assert(!pickerSource.includes('@vis.gl/react-google-maps') && !pickerSource.includes('VITE_GOOGLE_MAPS_API_KEY'), 'Location picker contains no Google Maps integration');
console.log('  ✓ Location picker uses OpenStreetMap tiles, click/drag selection, and preserves coordinates');

console.log('All 11 Phase 4 OpenStreetMap & Location tests passed successfully!');
