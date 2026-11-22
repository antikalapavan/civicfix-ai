import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type * as LeafletNamespace from 'leaflet';
import {
  MapPin,
  ChevronRight,
  X,
  Compass,
  Info,
  ShieldCheck,
  Plus,
  Minus,
  Search,
  LocateFixed,
  Loader2,
  AlertTriangle,
  Droplets,
  Lightbulb,
  Trash2,
} from 'lucide-react';
import {
  CivicIssueReport,
  ExpandedCivicCategory,
  normalizeCivicCategory,
} from '../types/civic';
import { partitionReportsByLocation, isValidCoordinate } from '../utils/reportLocations';
import { resolveAppRouteFromLocation } from '../utils/portalRouting';
import { CivicCategoryIcon } from './CivicCategoryIcon';

export function hasUsableReportPhoto(photoUrl?: string | null): boolean {
  if (typeof photoUrl !== 'string') return false;
  const trimmed = photoUrl.trim();
  if (!trimmed) return false;
  return (
    trimmed.startsWith('data:image/') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('blob:')
  );
}

interface CivicReportsMapProps {
  reports: CivicIssueReport[];
  selectedReport: CivicIssueReport | null;
  onSelectReport: (report: CivicIssueReport) => void;
  onOpenReportDetails: (report: CivicIssueReport) => void;
  onInspect?: (report: CivicIssueReport) => void;
}

export const CATEGORY_COLORS: Record<
  ExpandedCivicCategory,
  { hex: string; bg: string; text: string }
> = {
  'Garbage accumulation': { hex: '#10B981', bg: 'bg-emerald-500', text: 'text-emerald-500' },
  'Overflowing dustbins': { hex: '#14B8A6', bg: 'bg-teal-500', text: 'text-teal-500' },
  Potholes: { hex: '#F59E0B', bg: 'bg-amber-500', text: 'text-amber-500' },
  'Damaged roads': { hex: '#F97316', bg: 'bg-orange-500', text: 'text-orange-500' },
  'Drainage problems': { hex: '#6366F1', bg: 'bg-indigo-500', text: 'text-indigo-500' },
  'Water leakage': { hex: '#06B6D4', bg: 'bg-cyan-500', text: 'text-cyan-500' },
  'Streetlight problems': { hex: '#EAB308', bg: 'bg-yellow-500', text: 'text-yellow-500' },
  'Other civic issues': { hex: '#64748B', bg: 'bg-slate-500', text: 'text-slate-500' },
};

export function getCivicCategoryColor(rawCategory?: string | null) {
  const canonical = normalizeCivicCategory(rawCategory);
  return CATEGORY_COLORS[canonical] || CATEGORY_COLORS['Other civic issues'];
}

export const MAP_UNAVAILABLE_MESSAGE =
  'Map is currently unavailable. Use List View to manage complaints.';

type MapChipCategory = 'All' | 'Potholes' | 'Water' | 'Lighting' | 'Sanitation';

const MAP_CHIP_GROUPS: ReadonlyArray<{
  key: MapChipCategory;
  label: string;
  categories: ReadonlyArray<ExpandedCivicCategory> | null;
}> = [
  { key: 'All', label: 'All', categories: null },
  { key: 'Potholes', label: 'Potholes', categories: ['Potholes', 'Damaged roads'] },
  { key: 'Water', label: 'Water', categories: ['Water leakage', 'Drainage problems'] },
  { key: 'Lighting', label: 'Lighting', categories: ['Streetlight problems'] },
  {
    key: 'Sanitation',
    label: 'Sanitation',
    categories: ['Garbage accumulation', 'Overflowing dustbins'],
  },
];

function matchesChipCategory(report: CivicIssueReport, chip: MapChipCategory): boolean {
  if (chip === 'All') return true;
  const canonical = normalizeCivicCategory(report.normalizedCategory || report.category);
  const group = MAP_CHIP_GROUPS.find((g) => g.key === chip);
  return group?.categories ? group.categories.includes(canonical) : true;
}

function matchesSearchQuery(report: CivicIssueReport, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  const canonical = normalizeCivicCategory(report.normalizedCategory || report.category);
  const haystack = [
    report.title,
    report.description,
    report.trackingNumber,
    report.location?.address,
    report.location?.ward,
    report.category,
    canonical,
    report.status,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

function getCategoryPinSvg(canonical: ExpandedCivicCategory): string {
  switch (canonical) {
    case 'Potholes':
    case 'Damaged roads':
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
    case 'Water leakage':
    case 'Drainage problems':
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>';
    case 'Streetlight problems':
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>';
    case 'Garbage accumulation':
    case 'Overflowing dustbins':
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';
    default:
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>';
  }
}

function getStatusBadgeClasses(status: CivicIssueReport['status']): string {
  switch (status) {
    case 'Resolved':
      return 'bg-emerald-950/80 text-emerald-300 border-emerald-700/80';
    case 'In Progress':
    case 'Assigned':
      return 'bg-sky-950/80 text-sky-300 border-sky-700/80';
    case 'Under Review':
    case 'Submitted':
      return 'bg-amber-950/80 text-amber-300 border-amber-700/80';
    case 'Rejected':
      return 'bg-rose-950/80 text-rose-300 border-rose-700/80';
    case 'Withdrawn':
    default:
      return 'bg-slate-800 text-slate-300 border-slate-700';
  }
}

export const CivicReportsMap: React.FC<CivicReportsMapProps> = ({
  reports,
  selectedReport,
  onSelectReport,
  onOpenReportDetails,
  onInspect,
}) => {
  const [activeReport, setActiveReport] = useState<CivicIssueReport | null>(selectedReport);
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState<MapChipCategory>('All');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [includeInactive, setIncludeInactive] = useState<boolean>(false);
  const [showMissingCoordsList, setShowMissingCoordsList] = useState<boolean>(false);
  const [failedPhotoReportId, setFailedPhotoReportId] = useState<string | null>(null);
  const [isLocating, setIsLocating] = useState<boolean>(false);
  const [locateNotice, setLocateNotice] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState<boolean>(false);
  const [mapCenterCoords, setMapCenterCoords] = useState<{ lat: number; lng: number } | null>(
    selectedReport &&
      isValidCoordinate(selectedReport.location?.latitude, selectedReport.location?.longitude)
      ? {
          lat: parseFloat((selectedReport.location.latitude as number).toFixed(4)),
          lng: parseFloat((selectedReport.location.longitude as number).toFixed(4)),
        }
      : null
  );

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const leafletRef = useRef<typeof LeafletNamespace | null>(null);
  const mapInstanceRef = useRef<LeafletNamespace.Map | null>(null);
  const markersLayerRef = useRef<LeafletNamespace.LayerGroup | null>(null);
  const userMarkerRef = useRef<LeafletNamespace.Marker | null>(null);
  const userAccuracyCircleRef = useRef<LeafletNamespace.Circle | null>(null);

  const isAdminPortalRoute = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return (
      resolveAppRouteFromLocation(window.location.pathname, window.location.hash) ===
      'admin_dashboard'
    );
  }, []);

  const effectiveOnInspect = onInspect ?? (isAdminPortalRoute ? onOpenReportDetails : undefined);

  useEffect(() => {
    setActiveReport(selectedReport);
  }, [selectedReport]);

  useEffect(() => {
    setFailedPhotoReportId(null);
  }, [activeReport?.id, activeReport?.photoUrl]);

  const partitioned = useMemo(() => partitionReportsByLocation(reports), [reports]);

  // Base pool after inactive toggle & search box (used to show accurate counts next to each category chip)
  const searchFilteredPool = useMemo(() => {
    const basePool = includeInactive
      ? partitioned.allPlottedReports
      : partitioned.activePlottedReports;
    return basePool.filter((r) => matchesSearchQuery(r, searchQuery));
  }, [partitioned, includeInactive, searchQuery]);

  const chipCounts = useMemo(() => {
    const counts: Record<MapChipCategory, number> = {
      All: searchFilteredPool.length,
      Potholes: 0,
      Water: 0,
      Lighting: 0,
      Sanitation: 0,
    };
    for (const report of searchFilteredPool) {
      if (matchesChipCategory(report, 'Potholes')) counts.Potholes += 1;
      else if (matchesChipCategory(report, 'Water')) counts.Water += 1;
      else if (matchesChipCategory(report, 'Lighting')) counts.Lighting += 1;
      else if (matchesChipCategory(report, 'Sanitation')) counts.Sanitation += 1;
    }
    return counts;
  }, [searchFilteredPool]);

  const plottableReports = useMemo(
    () => searchFilteredPool.filter((r) => matchesChipCategory(r, selectedCategoryFilter)),
    [searchFilteredPool, selectedCategoryFilter]
  );

  // Clear stale activeReport if excluded by current map filters or search
  useEffect(() => {
    if (activeReport && !plottableReports.some((r) => r.id === activeReport.id)) {
      setActiveReport(null);
    }
  }, [activeReport, plottableReports]);

  const firstPlottableCenter = useMemo(() => {
    const firstPlottable = plottableReports[0] || partitioned.allPlottedReports[0];
    if (
      firstPlottable &&
      isValidCoordinate(firstPlottable.location?.latitude, firstPlottable.location?.longitude)
    ) {
      return {
        lat: parseFloat((firstPlottable.location.latitude as number).toFixed(4)),
        lng: parseFloat((firstPlottable.location.longitude as number).toFixed(4)),
      };
    }
    return null;
  }, [plottableReports, partitioned.allPlottedReports]);

  const displayedHudCoords = useMemo(() => {
    if (
      activeReport &&
      isValidCoordinate(activeReport.location?.latitude, activeReport.location?.longitude)
    ) {
      return {
        lat: parseFloat((activeReport.location.latitude as number).toFixed(4)),
        lng: parseFloat((activeReport.location.longitude as number).toFixed(4)),
      };
    }
    return mapCenterCoords || firstPlottableCenter;
  }, [activeReport, mapCenterCoords, firstPlottableCenter]);

  const plottableSignature = useMemo(
    () =>
      plottableReports
        .map((r) => `${r.id}:${r.location?.latitude},${r.location?.longitude}`)
        .join('|'),
    [plottableReports]
  );

  // Initialize Leaflet map with dark-styled OpenStreetMap tiles (CSS imported only here)
  useEffect(() => {
    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;

    const initMap = async () => {
      if (!mapContainerRef.current || mapInstanceRef.current) return;
      await import('leaflet/dist/leaflet.css');
      const leafletMod = await import('leaflet');
      const L = (leafletMod.default ?? leafletMod) as typeof LeafletNamespace;
      if (cancelled || !mapContainerRef.current) return;

      leafletRef.current = L;

      // Neutral regional viewport anchor ONLY when mounting with zero plottable points
      const startCenter: [number, number] = firstPlottableCenter
        ? [firstPlottableCenter.lat, firstPlottableCenter.lng]
        : [20.5937, 78.9629];
      const startZoom = firstPlottableCenter ? 14 : 5;

      const map = L.map(mapContainerRef.current, {
        center: startCenter,
        zoom: startZoom,
        minZoom: 3,
        maxZoom: 17,
        zoomControl: false,
        attributionControl: true,
      });

      const tileLayer = L.tileLayer(
        'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png',
        {
          attribution:
            '&copy; Stadia Maps, &copy; OpenMapTiles, &copy; OpenStreetMap contributors',
          maxNativeZoom: 19,
          maxZoom: 19,
        }
      );
      tileLayer.on('tileerror', () => {
        setLocateNotice('Map tiles are temporarily unavailable. Complaint list and filters remain available.');
        console.warn('[CivicReportsMap] Map tile loading failed');
      });
      tileLayer.addTo(map);

      const markersLayer = L.layerGroup().addTo(map);

      map.on('moveend', () => {
        const c = map.getCenter();
        setMapCenterCoords({
          lat: parseFloat(c.lat.toFixed(4)),
          lng: parseFloat(c.lng.toFixed(4)),
        });
      });

      map.on('click', () => {
        setActiveReport(null);
      });

      mapInstanceRef.current = map;
      markersLayerRef.current = markersLayer;
      setMapReady(true);

      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => {
          map.invalidateSize();
        });
        resizeObserver.observe(mapContainerRef.current);
      }
      window.setTimeout(() => map.invalidateSize(), 150);
    };

    void initMap();

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
      markersLayerRef.current = null;
      userMarkerRef.current = null;
      userAccuracyCircleRef.current = null;
      setMapReady(false);
    };
  }, []);

  const fitMapToPlottedReports = useCallback(() => {
    const map = mapInstanceRef.current;
    const L = leafletRef.current;
    if (!map || !L || plottableReports.length === 0) return;

    if (plottableReports.length === 1) {
      const only = plottableReports[0];
      if (isValidCoordinate(only.location?.latitude, only.location?.longitude)) {
        const lat = only.location.latitude as number;
        const lng = only.location.longitude as number;
        map.setView([lat, lng], 15, { animate: true });
        setMapCenterCoords({
          lat: parseFloat(lat.toFixed(4)),
          lng: parseFloat(lng.toFixed(4)),
        });
      }
      return;
    }

    const latLngs: [number, number][] = [];
    for (const r of plottableReports) {
      if (isValidCoordinate(r.location?.latitude, r.location?.longitude)) {
        latLngs.push([r.location.latitude as number, r.location.longitude as number]);
      }
    }
    if (latLngs.length > 0) {
      const bounds = L.latLngBounds(latLngs);
      map.fitBounds(bounds, { padding: [56, 56], maxZoom: 16 });
    }
  }, [plottableReports]);

  // Refit bounds when filtered plottable reports change (and no specific pin is selected)
  useEffect(() => {
    if (!mapReady || activeReport || plottableReports.length === 0) return;
    fitMapToPlottedReports();
  }, [mapReady, activeReport, plottableSignature, fitMapToPlottedReports]);

  // Pan to selected report when activeReport changes
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (
      !mapReady ||
      !map ||
      !isValidCoordinate(activeReport?.location?.latitude, activeReport?.location?.longitude)
    ) {
      return;
    }
    map.panTo(
      [activeReport!.location.latitude as number, activeReport!.location.longitude as number],
      { animate: true }
    );
  }, [mapReady, activeReport?.id, activeReport?.location?.latitude, activeReport?.location?.longitude]);

  // Render custom colored divIcon markers per category + highlighted state when selected
  useEffect(() => {
    const L = leafletRef.current;
    const markersLayer = markersLayerRef.current;
    if (!mapReady || !L || !markersLayer) return;

    markersLayer.clearLayers();

    for (const report of plottableReports) {
      if (!isValidCoordinate(report.location?.latitude, report.location?.longitude)) continue;
      const lat = report.location.latitude as number;
      const lng = report.location.longitude as number;
      const displayCategory = normalizeCivicCategory(report.normalizedCategory || report.category);
      const catColor = getCivicCategoryColor(displayCategory);
      const isSelected = activeReport?.id === report.id;
      const isHazard = report.severity === 'Hazard';
      const svgIcon = getCategoryPinSvg(displayCategory);

      const pinSize = isSelected ? 40 : 32;
      const pinHtml = `
        <div style="position:relative;display:flex;flex-direction:column;align-items:center;transform:${isSelected ? 'scale(1.16) translateY(-4px)' : 'scale(1)'};transition:transform 0.2s cubic-bezier(0.34,1.56,0.64,1);">
          ${isHazard ? '<div style="position:absolute;top:-4px;width:40px;height:40px;border-radius:9999px;background:rgba(239,68,68,0.32);animation:ping 1.5s cubic-bezier(0,0,0.2,1) infinite;"></div>' : ''}
          ${isSelected ? `<div style="position:absolute;top:-5px;width:${pinSize + 10}px;height:${pinSize + 10}px;border-radius:9999px;border:2px solid #34d399;background:rgba(16,185,129,0.22);box-shadow:0 0 16px rgba(16,185,129,0.55);"></div>` : ''}
          <div style="position:relative;width:${pinSize}px;height:${pinSize}px;border-radius:9999px;background:${catColor.hex};border:${isSelected ? '3px' : '2px'} solid #ffffff;box-shadow:${isSelected ? '0 8px 20px rgba(0,0,0,0.65)' : '0 4px 12px rgba(0,0,0,0.5)'};display:flex;align-items:center;justify-content:center;">
            ${svgIcon}
          </div>
          <div style="width:0;height:0;margin-top:-2px;border-left:6px solid transparent;border-right:6px solid transparent;border-top:8px solid ${catColor.hex};filter:drop-shadow(0 2px 2px rgba(0,0,0,0.45));"></div>
        </div>
      `;

      const icon = L.divIcon({
        className: 'civifix-custom-pin',
        html: pinHtml,
        iconSize: [pinSize, pinSize + 8],
        iconAnchor: [pinSize / 2, pinSize + 6],
      });

      const marker = L.marker([lat, lng], {
        icon,
        title: `${displayCategory}: ${report.title}`,
        zIndexOffset: isSelected ? 1000 : isHazard ? 400 : 100,
      });

      marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        setActiveReport(report);
        onSelectReport(report);
      });

      marker.addTo(markersLayer);
    }
  }, [mapReady, plottableReports, activeReport?.id, onSelectReport]);

  const handleZoomIn = () => {
    const map = mapInstanceRef.current;
    if (map && map.getZoom() < map.getMaxZoom()) {
      map.zoomIn();
    }
  };

  const handleZoomOut = () => {
    const map = mapInstanceRef.current;
    if (map && map.getZoom() > map.getMinZoom()) {
      map.zoomOut();
    }
  };

  const handleLocateMe = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocateNotice('Geolocation is not supported in this browser.');
      return;
    }

    setIsLocating(true);
    setLocateNotice(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        const map = mapInstanceRef.current;
        const L = leafletRef.current;

        if (map && L && isValidCoordinate(latitude, longitude)) {
          const userIcon = L.divIcon({
            className: 'civifix-user-gps',
            html: `
              <div style="position:relative;width:20px;height:20px;display:flex;align-items:center;justify-content:center;">
                <div style="position:absolute;width:24px;height:24px;border-radius:9999px;background:rgba(56,189,248,0.35);"></div>
                <div style="width:12px;height:12px;border-radius:9999px;background:#0ea5e9;border:2.5px solid #ffffff;box-shadow:0 2px 8px rgba(0,0,0,0.45);"></div>
              </div>
            `,
            iconSize: [20, 20],
            iconAnchor: [10, 10],
          });

          if (!userMarkerRef.current) {
            userMarkerRef.current = L.marker([latitude, longitude], {
              icon: userIcon,
              zIndexOffset: 900,
              interactive: false,
            }).addTo(map);
          } else {
            userMarkerRef.current.setLatLng([latitude, longitude]);
          }

          const radius = Math.max(accuracy || 30, 15);
          if (!userAccuracyCircleRef.current) {
            userAccuracyCircleRef.current = L.circle([latitude, longitude], {
              radius,
              color: '#38bdf8',
              weight: 1.5,
              opacity: 0.6,
              fillColor: '#38bdf8',
              fillOpacity: 0.14,
              interactive: false,
            }).addTo(map);
          } else {
            userAccuracyCircleRef.current.setLatLng([latitude, longitude]);
            userAccuracyCircleRef.current.setRadius(radius);
          }

          map.flyTo([latitude, longitude], 16, { animate: true, duration: 1.0 });
          setMapCenterCoords({
            lat: parseFloat(latitude.toFixed(4)),
            lng: parseFloat(longitude.toFixed(4)),
          });
        }
        setIsLocating(false);
      },
      (error) => {
        const message =
          error.code === 1
            ? 'Location permission denied. Enable location access to use Locate Me.'
            : error.code === 3
            ? 'Location request timed out. Please try again.'
            : 'Unable to determine your current location.';
        setLocateNotice(message);
        setIsLocating(false);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  };

  const renderChipIcon = (chip: MapChipCategory) => {
    switch (chip) {
      case 'Potholes':
        return <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />;
      case 'Water':
        return <Droplets className="w-3.5 h-3.5 text-cyan-400" />;
      case 'Lighting':
        return <Lightbulb className="w-3.5 h-3.5 text-yellow-400" />;
      case 'Sanitation':
        return <Trash2 className="w-3.5 h-3.5 text-emerald-400" />;
      default:
        return null;
    }
  };

  return (
    <div className="relative w-full h-full min-h-[460px] bg-slate-950 rounded-2xl overflow-hidden border border-slate-800 shadow-sm flex flex-col">
      {/* Scoped dark styling for Leaflet attribution & custom divIcon markers */}
      <style>{`
        .civifix-custom-pin, .civifix-user-gps { background: transparent !important; border: none !important; }
        .leaflet-control-attribution {
          background: rgba(15, 23, 42, 0.85) !important;
          color: #cbd5e1 !important;
          font-size: 10px !important;
          padding: 2px 8px !important;
          border-top-left-radius: 8px;
        }
        .leaflet-control-attribution a { color: #34d399 !important; }
      `}</style>

      {/* Top Dark Filter & Search Toolbar Above Map */}
      <div className="z-20 bg-slate-900/95 border-b border-slate-800 px-3 py-2.5 flex flex-col gap-2 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* Search Input */}
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search pins by title, ID, address, ward..."
              aria-label="Search map markers"
              className="w-full pl-8 pr-7 py-1.5 rounded-xl bg-slate-950 border border-slate-700/80 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/40"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Clear map search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Coordinates & Reconciliation Badges */}
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="px-2.5 py-1 rounded-xl bg-slate-950 text-slate-200 text-[11px] font-mono border border-slate-800 flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  displayedHudCoords ? 'bg-emerald-400' : 'bg-slate-500'
                }`}
              />
              <span>
                {displayedHudCoords
                  ? `${displayedHudCoords.lat}, ${displayedHudCoords.lng}`
                  : 'No GPS plotted'}
              </span>
            </div>

            <div className="px-2.5 py-1 rounded-xl bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 text-[11px] font-semibold flex items-center gap-1">
              <MapPin className="w-3 h-3" />
              <span>{plottableReports.length} Plotted</span>
            </div>

            {partitioned.counts.missingCoordsActive > 0 && (
              <button
                type="button"
                onClick={() => setShowMissingCoordsList((prev) => !prev)}
                className="px-2.5 py-1 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-[11px] font-semibold cursor-pointer transition-colors"
                title="View active reports saved with manual street address only"
              >
                {partitioned.counts.missingCoordsActive} Missing Coords
              </button>
            )}

            {partitioned.counts.excludedInactive > 0 && (
              <button
                type="button"
                onClick={() => setIncludeInactive((prev) => !prev)}
                className={`px-2.5 py-1 rounded-xl text-[11px] font-semibold cursor-pointer transition-colors border ${
                  includeInactive
                    ? 'bg-emerald-950/70 text-emerald-300 border-emerald-500/50'
                    : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
                }`}
                title="Toggle Withdrawn & Rejected reports on map"
              >
                {includeInactive
                  ? `Showing All (+${partitioned.counts.excludedInactive} Withdrawn/Rejected)`
                  : `${partitioned.counts.excludedInactive} Withdrawn/Rejected Hidden`}
              </button>
            )}
          </div>
        </div>

        {/* Category Filter Chips */}
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
          {MAP_CHIP_GROUPS.map((chip) => {
            const isActive = selectedCategoryFilter === chip.key;
            return (
              <button
                key={chip.key}
                type="button"
                onClick={() => setSelectedCategoryFilter(chip.key)}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap border transition-all cursor-pointer ${
                  isActive
                    ? 'bg-emerald-600 text-white border-emerald-500 shadow-sm'
                    : 'bg-slate-800/90 text-slate-300 border-slate-700 hover:bg-slate-800 hover:text-white'
                }`}
              >
                {renderChipIcon(chip.key)}
                <span>{chip.label}</span>
                <span
                  className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono ${
                    isActive
                      ? 'bg-emerald-800/80 text-emerald-100'
                      : 'bg-slate-900 text-slate-400'
                  }`}
                >
                  {chipCounts[chip.key]}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Interactive Leaflet Map Area */}
      <div className="relative flex-1 min-h-[340px] w-full">
        <div ref={mapContainerRef} className="w-full h-full z-0" />

        {/* Right Side Floating Map Controls: Locate Me, Zoom In/Out, Recenter */}
        <div className="absolute right-3 top-3 z-[400] flex flex-col gap-2 pointer-events-auto">
          <button
            type="button"
            onClick={handleLocateMe}
            disabled={isLocating}
            className="w-9 h-9 rounded-xl bg-slate-900/95 hover:bg-slate-800 text-sky-400 shadow-lg border border-slate-700/90 flex items-center justify-center active:scale-95 transition-all cursor-pointer disabled:opacity-60"
            aria-label="Locate Me"
            title="Locate Me"
          >
            {isLocating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <LocateFixed className="w-4 h-4" />
            )}
          </button>

          <div className="flex flex-col bg-slate-900/95 rounded-xl shadow-lg border border-slate-700/90 overflow-hidden">
            <button
              type="button"
              onClick={handleZoomIn}
              className="w-9 h-9 flex items-center justify-center text-slate-100 hover:bg-slate-800 active:scale-95 transition-all cursor-pointer"
              aria-label="Zoom in"
              title="Zoom in"
            >
              <Plus className="w-4 h-4" />
            </button>
            <div className="w-full h-px bg-slate-800" />
            <button
              type="button"
              onClick={handleZoomOut}
              className="w-9 h-9 flex items-center justify-center text-slate-100 hover:bg-slate-800 active:scale-95 transition-all cursor-pointer"
              aria-label="Zoom out"
              title="Zoom out"
            >
              <Minus className="w-4 h-4" />
            </button>
          </div>

          <button
            type="button"
            onClick={fitMapToPlottedReports}
            disabled={plottableReports.length === 0}
            className="w-9 h-9 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white shadow-lg border border-emerald-500/60 flex items-center justify-center active:scale-95 transition-all cursor-pointer disabled:cursor-not-allowed"
            aria-label="Recenter Map"
            title="Fit all pins"
          >
            <Compass className="w-4 h-4" />
          </button>
        </div>

        {/* Geolocation Error Notice */}
        {locateNotice && (
          <div className="absolute top-3 left-3 right-14 sm:right-auto sm:max-w-sm z-[410] bg-slate-900/95 border border-rose-700/80 text-rose-200 rounded-xl px-3 py-2 text-xs shadow-xl flex items-center justify-between gap-2">
            <span>{locateNotice}</span>
            <button
              type="button"
              onClick={() => setLocateNotice(null)}
              className="text-rose-300 hover:text-white cursor-pointer shrink-0"
              aria-label="Dismiss location notice"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Expandable Drawer for Active Reports Missing Coordinates */}
        {showMissingCoordsList && partitioned.missingLocationActiveReports.length > 0 && (
          <div className="absolute top-3 left-3 right-14 sm:right-auto sm:w-80 z-[410] bg-slate-900 rounded-2xl border border-amber-700/80 shadow-2xl p-3 max-h-60 overflow-y-auto pointer-events-auto">
            <div className="flex items-center justify-between gap-2 pb-2 mb-2 border-b border-slate-800">
              <div>
                <h4 className="text-[11px] font-bold text-white">
                  Reports Without GPS Coordinates ({partitioned.missingLocationActiveReports.length})
                </h4>
                <p className="text-[10px] text-slate-400">
                  Manual address only — click any item to view details.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowMissingCoordsList(false)}
                className="p-1 rounded-full text-slate-400 hover:text-slate-200 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="space-y-1.5">
              {partitioned.missingLocationActiveReports.map((rep) => (
                <button
                  key={rep.id}
                  type="button"
                  onClick={() => {
                    setShowMissingCoordsList(false);
                    onOpenReportDetails(rep);
                  }}
                  className="w-full text-left p-2 rounded-xl bg-slate-800/80 hover:bg-slate-800 border border-slate-700 flex items-center justify-between gap-2 cursor-pointer"
                >
                  <div className="min-w-0">
                    <span className="text-[9px] font-mono text-slate-400 block">
                      {rep.trackingNumber} · {rep.status}
                    </span>
                    <span className="text-[11px] font-bold text-slate-100 truncate block">
                      {rep.title}
                    </span>
                    <span className="text-[10px] text-slate-400 truncate block">
                      {rep.location.address}
                    </span>
                  </div>
                  <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Empty State Banner if no coordinates match active map filter/search */}
        {plottableReports.length === 0 && (
          <div className="absolute inset-0 z-[350] bg-slate-950/55 backdrop-blur-[1px] flex items-center justify-center p-6 text-center pointer-events-none">
            <div className="bg-slate-900/95 rounded-2xl p-4 max-w-xs shadow-xl border border-slate-700 pointer-events-auto">
              <Info className="w-6 h-6 text-slate-400 mx-auto mb-2" />
              <h4 className="text-xs font-bold text-white mb-1">
                No Plottable Coordinates
              </h4>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                {partitioned.counts.missingCoordsActive > 0 && !searchQuery && selectedCategoryFilter === 'All'
                  ? `${partitioned.counts.missingCoordsActive} active report(s) were submitted with manual street addresses only and have no GPS coordinates.`
                  : 'No plotted complaints match the active map search or category filter.'}
              </p>
            </div>
          </div>
        )}

        {/* Floating Dark Detail Card for Selected Marker */}
        {activeReport && (
          <div className="absolute bottom-7 left-3 right-3 sm:left-3 sm:right-auto sm:w-96 z-[420] bg-slate-900/95 backdrop-blur-md rounded-2xl p-3.5 shadow-2xl border border-slate-700/90 text-slate-100 pointer-events-auto">
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] font-mono font-bold text-emerald-300 bg-emerald-950/70 border border-emerald-800/80 px-1.5 py-0.5 rounded">
                  {activeReport.trackingNumber}
                </span>
                <span
                  className={`text-[10px] font-bold px-2 py-0.5 rounded border uppercase tracking-wider ${getStatusBadgeClasses(
                    activeReport.status
                  )}`}
                >
                  {activeReport.status}
                </span>
                <span className="text-[10px] text-slate-400 flex items-center gap-0.5" title="Privacy Protected">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                </span>
              </div>
              <button
                type="button"
                onClick={() => setActiveReport(null)}
                aria-label="Close detail card"
                className="w-6 h-6 rounded-lg bg-slate-800 hover:bg-slate-700 flex items-center justify-center text-slate-400 hover:text-white cursor-pointer shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex items-start gap-3">
              <div className="w-16 h-16 rounded-xl bg-slate-800 overflow-hidden shrink-0 border border-slate-700 flex items-center justify-center">
                {hasUsableReportPhoto(activeReport.photoUrl) && failedPhotoReportId !== activeReport.id ? (
                  <img
                    src={activeReport.photoUrl}
                    alt={activeReport.title}
                    className="w-full h-full object-cover"
                    referrerPolicy="no-referrer"
                    onError={() => setFailedPhotoReportId(activeReport.id)}
                  />
                ) : (
                  <CivicCategoryIcon
                    category={activeReport.normalizedCategory || activeReport.category}
                    className="w-6 h-6"
                  />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <span
                  style={{
                    color: getCivicCategoryColor(activeReport.normalizedCategory || activeReport.category).hex,
                  }}
                  className="text-[10px] font-bold uppercase tracking-wider block"
                >
                  {normalizeCivicCategory(activeReport.normalizedCategory || activeReport.category)}
                </span>
                <h4 className="text-sm font-bold text-white truncate mt-0.5">
                  {activeReport.title}
                </h4>
                <div className="flex items-center gap-1 text-xs text-slate-400 truncate mt-1">
                  <MapPin className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span className="truncate">{activeReport.location.address}</span>
                </div>
                {isValidCoordinate(activeReport.location?.latitude, activeReport.location?.longitude) && (
                  <span className="text-[10px] font-mono text-slate-500 block mt-0.5">
                    {(activeReport.location.latitude as number).toFixed(4)}, {(activeReport.location.longitude as number).toFixed(4)}
                  </span>
                )}
              </div>
            </div>

            <div className="mt-3 pt-2.5 border-t border-slate-800 flex items-center justify-between gap-2">
              <span className="text-xs text-slate-400">
                Severity: <strong className="text-slate-200">{activeReport.severity}</strong>
              </span>
              {effectiveOnInspect ? (
                <button
                  type="button"
                  onClick={() => effectiveOnInspect(activeReport)}
                  className="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1 shadow-sm transition cursor-pointer"
                >
                  <span>Inspect</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onOpenReportDetails(activeReport)}
                  className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 flex items-center gap-0.5 cursor-pointer"
                >
                  <span>View Details</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
