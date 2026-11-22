import React, { useState, useEffect, useCallback, useRef } from 'react';
import { MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  MapPin,
  Crosshair,
  Check,
  X,
  Loader2,
  Compass,
  Info,
} from 'lucide-react';

import { getFirebaseAuthHeaders } from '../lib/firebase';
import { isValidCoordinate } from '../utils/reportLocations';

interface LocationPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialCoords: { lat: number; lng: number } | null;
  initialAddress: string;
  onConfirmLocation: (coords: { lat: number; lng: number } | null, address?: string) => void;
}

const DEFAULT_CENTER = { lat: 12.9716, lng: 77.5946 };

interface PickerMapInnerProps {
  markerPos: { lat: number; lng: number };
  onPosChange: (pos: { lat: number; lng: number }) => void;
}

const PickerMapContents: React.FC<PickerMapInnerProps> = ({
  markerPos,
  onPosChange,
}) => {
  const map = useMap();
  const [tileLoadFailed, setTileLoadFailed] = useState(false);

  useMapEvents({
    click(event) {
      onPosChange({
        lat: parseFloat(event.latlng.lat.toFixed(5)),
        lng: parseFloat(event.latlng.lng.toFixed(5)),
      });
    },
  });

  useEffect(() => {
    if (map && isValidCoordinate(markerPos.lat, markerPos.lng)) {
      map.panTo(markerPos);
    }
  }, [map, markerPos.lat, markerPos.lng]);

  const handleRecenter = () => {
    if (map) {
      map.panTo(markerPos);
      map.setZoom(16);
    }
  };

  return (
    <>
      <TileLayer
        attribution="&copy; Stadia Maps, &copy; OpenMapTiles, &copy; OpenStreetMap contributors"
        url="https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png"
        maxZoom={19}
        eventHandlers={{
          tileerror: () => {
            setTileLoadFailed(true);
            console.warn('[LocationPickerModal] Map tile loading failed');
          },
        }}
      />
      <Marker
        position={[markerPos.lat, markerPos.lng]}
        draggable
        icon={L.divIcon({
          className: 'civifix-location-marker',
          html: '<div style="display:flex;flex-direction:column;align-items:center"><span style="background:#0f172a;color:#fff;padding:2px 6px;border-radius:6px;font-size:10px;font-weight:700;white-space:nowrap;margin-bottom:4px">Complaint Pin</span><span style="display:block;width:32px;height:32px;border-radius:50%;background:#059669;border:2px solid #fff;box-shadow:0 4px 10px #0005"></span></div>',
          iconSize: [100, 62],
          iconAnchor: [50, 58],
        })}
        eventHandlers={{
          dragend: (event) => {
            const position = event.target.getLatLng();
            onPosChange({ lat: parseFloat(position.lat.toFixed(5)), lng: parseFloat(position.lng.toFixed(5)) });
          },
        }}
        title="Drag pin to complaint location"
      />

      <button
        type="button"
        onClick={handleRecenter}
        className="absolute right-3 top-3 z-10 min-w-[44px] min-h-[44px] rounded-xl bg-white/95 text-slate-800 shadow-md border border-slate-200 flex items-center justify-center hover:bg-white active:scale-95 transition-all cursor-pointer"
        title="Center on pin"
        aria-label="Center map on selected pin"
      >
        <Compass className="w-4 h-4 text-emerald-600" />
      </button>
      {tileLoadFailed && (
        <div className="absolute left-3 right-3 bottom-3 z-10 rounded-xl bg-amber-50/95 border border-amber-200 px-3 py-2 text-[11px] text-amber-900 shadow-sm">
          Map tiles are temporarily unavailable. You can still enter an address manually.
        </div>
      )}
    </>
  );
};

const PickerMapInner: React.FC<PickerMapInnerProps> = (props) => (
  <MapContainer
    center={[props.markerPos.lat, props.markerPos.lng]}
    zoom={15}
    minZoom={3}
    maxZoom={19}
    className="w-full h-full"
    scrollWheelZoom
  >
    <PickerMapContents {...props} />
  </MapContainer>
);

function getFriendlyGpsError(error: GeolocationPositionError): string {
  switch (error.code) {
    case 1:
      return 'Location permission was denied. Allow location access in your browser or enter your address below.';
    case 2:
      return 'Could not detect your current position. Please try again or enter your address below.';
    case 3:
      return 'Getting your current location took too long. Please try again or enter your address below.';
    default:
      return 'Unable to get your current location right now. Please enter your address below.';
  }
}

export const LocationPickerModal: React.FC<LocationPickerModalProps> = ({
  isOpen,
  onClose,
  initialCoords,
  initialAddress,
  onConfirmLocation,
}) => {
  const [selectedCoords, setSelectedCoords] = useState<{ lat: number; lng: number } | null>(
    initialCoords && isValidCoordinate(initialCoords.lat, initialCoords.lng)
      ? initialCoords
      : null
  );
  const [mapCenter, setMapCenter] = useState<{ lat: number; lng: number }>(
    initialCoords && isValidCoordinate(initialCoords.lat, initialCoords.lng)
      ? initialCoords
      : DEFAULT_CENTER
  );
  const [addressInput, setAddressInput] = useState<string>(initialAddress || '');
  const [isGeocoding, setIsGeocoding] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<{
    type: 'info' | 'warning' | 'error';
    text: string;
  } | null>(null);
  const [isGpsLocating, setIsGpsLocating] = useState<boolean>(false);

  const addressFieldRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (isOpen) {
      const hasValidInitial = Boolean(
        initialCoords && isValidCoordinate(initialCoords.lat, initialCoords.lng)
      );
      setSelectedCoords(hasValidInitial && initialCoords ? initialCoords : null);
      setMapCenter(hasValidInitial && initialCoords ? initialCoords : DEFAULT_CENTER);
      const cleanedInitial =
        initialAddress && /^(Detected GPS|Selected Location):\s*-?\d/i.test(initialAddress.trim())
          ? ''
          : initialAddress || '';
      setAddressInput(cleanedInitial);
      setStatusMessage(null);
    }
  }, [isOpen, initialCoords, initialAddress]);

  const performReverseGeocode = useCallback(async (lat: number, lng: number) => {
    setIsGeocoding(true);
    setStatusMessage(null);
    try {
      const authHeaders = await getFirebaseAuthHeaders();
      const res = await fetch(`/api/maps/reverse-geocode?lat=${lat}&lng=${lng}`, {
        headers: authHeaders,
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.address) {
          setAddressInput(data.address);
          setStatusMessage({
            type: 'info',
            text: 'Address found for your selected location.',
          });
          return;
        }
        if (data.message) {
          console.debug('[LocationPickerModal] Reverse geocode unavailable:', data.message);
        }
      }
      setStatusMessage({
        type: 'info',
        text: 'Location captured. Please enter a street, area, or nearby landmark below if helpful.',
      });
    } catch (err) {
      console.debug('[LocationPickerModal] Reverse geocode request failed:', err);
      setStatusMessage({
        type: 'info',
        text: 'Location captured. You can type your street address or landmark below.',
      });
    } finally {
      setIsGeocoding(false);
    }
  }, []);

  const handleMapPositionChange = useCallback(
    (newPos: { lat: number; lng: number }) => {
      setSelectedCoords(newPos);
      setMapCenter(newPos);
      performReverseGeocode(newPos.lat, newPos.lng);
    },
    [performReverseGeocode]
  );

  const handleDeviceGps = () => {
    setIsGpsLocating(true);
    setStatusMessage(null);

    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setIsGpsLocating(false);
          const lat = parseFloat(pos.coords.latitude.toFixed(5));
          const lng = parseFloat(pos.coords.longitude.toFixed(5));
          const newPos = { lat, lng };
          setSelectedCoords(newPos);
          setMapCenter(newPos);
          performReverseGeocode(lat, lng);
        },
        (err) => {
          setIsGpsLocating(false);
          setStatusMessage({
            type: 'warning',
            text: getFriendlyGpsError(err),
          });
        },
        { enableHighAccuracy: true, timeout: 8000 }
      );
    } else {
      setIsGpsLocating(false);
      setStatusMessage({
        type: 'warning',
        text: 'Your device or browser does not support automatic location. Please enter your address below.',
      });
    }
  };

  const handleChangeLocation = () => {
    setSelectedCoords(null);
    setAddressInput('');
    setStatusMessage(null);
    addressFieldRef.current?.focus();
  };

  const handleConfirm = () => {
    const trimmedAddress = addressInput.trim();
    const hasValidCoords = Boolean(
      selectedCoords && isValidCoordinate(selectedCoords.lat, selectedCoords.lng)
    );

    if (!trimmedAddress && !hasValidCoords) {
      setStatusMessage({
        type: 'error',
        text: 'Please use your current location, choose a point on the map, or enter an address.',
      });
      addressFieldRef.current?.focus();
      return;
    }

    const finalAddress = trimmedAddress || 'Current device location (GPS)';
    onConfirmLocation(hasValidCoords ? selectedCoords : null, finalAddress);
    onClose();
  };

  if (!isOpen) return null;

  const hasSelection = Boolean(addressInput.trim() || selectedCoords);
  const selectedDisplayAddress =
    addressInput.trim() || (selectedCoords ? 'Current device location (GPS)' : '');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-slate-900/70 backdrop-blur-xs animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="location-picker-title"
    >
      <div className="bg-white dark:bg-slate-900 w-full max-w-lg rounded-3xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50 dark:bg-slate-900/50">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 flex items-center justify-center shrink-0">
              <MapPin className="w-4 h-4" />
            </div>
            <div>
              <h3 id="location-picker-title" className="text-sm font-bold text-slate-900 dark:text-slate-100">
                Select Complaint Location
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Use GPS, choose on the map, or enter an address
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close location picker"
            className="min-w-[44px] min-h-[44px] -mr-2 rounded-full text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-800 flex items-center justify-center cursor-pointer transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="p-4 space-y-4 overflow-y-auto flex-1">
          {/* Method A: Use My Current Location */}
          <div>
            <button
              type="button"
              onClick={handleDeviceGps}
              disabled={isGpsLocating}
              className="w-full min-h-[44px] h-11 px-4 rounded-2xl bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 disabled:opacity-70 text-white text-xs font-bold flex items-center justify-center gap-2 shadow-xs cursor-pointer transition-colors"
            >
              {isGpsLocating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Crosshair className="w-4 h-4" />
              )}
              <span>{isGpsLocating ? 'Getting your location...' : 'Use My Current Location'}</span>
            </button>
          </div>

          {/* Method B: Choose on Map */}
          <div className="space-y-1.5">
            <span className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              Choose on Map
            </span>
            <div className="relative w-full h-56 sm:h-64 rounded-2xl bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 overflow-hidden">
              <PickerMapInner
                markerPos={mapCenter}
                onPosChange={handleMapPositionChange}
              />
            </div>
          </div>

          {/* Method C: Enter Address Manually */}
          <div>
            <label
              htmlFor="citizen-manual-address"
              className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5"
            >
              Enter Address Manually
            </label>
            <div className="relative">
              <MapPin className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5 pointer-events-none" />
              <input
                id="citizen-manual-address"
                ref={addressFieldRef}
                type="text"
                value={addressInput}
                onChange={(e) => {
                  setAddressInput(e.target.value);
                  if (statusMessage?.type === 'error') {
                    setStatusMessage(null);
                  }
                }}
                placeholder="Enter street, area, ward or nearby landmark"
                className="w-full h-11 pl-10 pr-9 rounded-2xl bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600"
              />
              {isGeocoding && (
                <div className="absolute right-3 top-3">
                  <Loader2 className="w-4 h-4 text-emerald-600 animate-spin" />
                </div>
              )}
            </div>
          </div>

          {/* Friendly Status / Validation Message */}
          {statusMessage && (
            <div
              role={statusMessage.type === 'error' ? 'alert' : 'status'}
              className={`p-3 rounded-2xl border text-xs flex items-start gap-2 ${
                statusMessage.type === 'error'
                  ? 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-200'
                  : statusMessage.type === 'warning'
                  ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200'
                  : 'bg-emerald-50/70 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200'
              }`}
            >
              <Info className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="leading-relaxed">{statusMessage.text}</span>
            </div>
          )}

          {/* Selected Location Confirmation Preview */}
          {hasSelection && (
            <div className="p-3.5 rounded-2xl bg-emerald-50/60 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/70 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2 min-w-0">
                  <MapPin className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <span className="block text-[11px] font-bold text-emerald-900 dark:text-emerald-200">
                      Selected Location
                    </span>
                    <p className="text-xs text-slate-800 dark:text-slate-100 leading-relaxed break-words">
                      {selectedDisplayAddress}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleChangeLocation}
                  className="min-h-[36px] px-2.5 rounded-lg text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100/70 dark:hover:bg-emerald-900/40 shrink-0 cursor-pointer"
                >
                  Change Location
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer Action Buttons */}
        <div className="px-4 py-3.5 bg-slate-50 dark:bg-slate-900/80 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] h-11 px-4 rounded-xl text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800 cursor-pointer transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="min-h-[44px] h-11 px-5 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white text-xs font-bold flex items-center gap-1.5 shadow-sm cursor-pointer transition-colors"
          >
            <Check className="w-4 h-4" />
            <span>Confirm Location</span>
          </button>
        </div>
      </div>
    </div>
  );
};
