import React, { useState, useRef, useEffect } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  MapPin,
  Crosshair,
  Camera,
  Trash2,
  AlertTriangle,
  Droplet,
  CloudRain,
  Lightbulb,
  HelpCircle,
  CheckCircle2,
  AlertCircle,
  X,
  Cloud,
  HardDrive,
  Sparkles,
  RefreshCw,
  UploadCloud,
  Loader2,
  Info,
  Check,
  ShieldAlert,
  Eye,
  ClipboardCheck,
  FileText,
  Edit3,
} from 'lucide-react';
import {
  AnyCivicCategory,
  CivicIssueReport,
  CitizenUser,
  AiAnalysisResult,
  CivicImageVerificationResult,
  EXPANDED_CIVIC_CATEGORIES,
  ExpandedCivicCategory,
  normalizeCivicCategory,
  getDepartmentForCategory,
} from '../../types/civic';
import { getFirebaseAuthHeaders } from '../../lib/firebase';
import { getApiUrl } from '../../lib/api';
import {
  submitCivicReportToFirestore,
  retryReportUpload,
  createSubmissionIdentity,
  awaitSubmissionWithTimeoutNotice,
  PendingSubmissionIdentity,
} from '../../services/reportStorage';
import { useLanguage } from '../../context/LanguageContext';
import { LocationPickerModal } from '../LocationPickerModal';
import { toUserFriendlyErrorMessage } from '../../utils/userFriendlyErrors';
import {
  optimizeBase64Image,
  validateCivicImageUpload,
  downscaleBase64ForService,
  checkDuplicatePhoto,
  computeImageFingerprint,
  DuplicatePhotoCheckResult,
} from '../../services/imageOptimizer';
import {
  FRIENDLY_IMAGE_VERIFY_FALLBACK_MESSAGE,
  INSPECT_CIVIC_IMAGE_TIMEOUT_MS,
  VALIDATE_CIVIC_IMAGE_TIMEOUT_MS,
  inspectCivicPhotoQuality,
  validateCivicIssueImage,
} from '../../services/civicImageService';
import { CivicAwarenessInfoCard } from '../CivicAwarenessInfoCard';
import { validateMeaningfulCivicText } from '../../utils/inputValidation';

interface ReportIssueScreenProps {
  user: CitizenUser;
  existingReports?: CivicIssueReport[];
  onReportCreated: (newReport: CivicIssueReport) => void;
  onCancel: () => void;
  onNavigateToMyReports: () => void;
}

type WizardStep = 1 | 2 | 3;
type ReportMode = 'photo' | 'manual';

interface AnalyzedAiContext {
  photoKey: string;
  category: ExpandedCivicCategory | '';
  description: string;
}

interface UnifiedAiSuggestion {
  source: 'image' | 'text';
  isFallback: boolean;
  isUnrelatedImage: boolean;
  detectedIssueType: string;
  suggestedCategory: ExpandedCivicCategory | null;
  suggestedSeverity: 'Low' | 'Medium' | 'High';
  severityReason: string;
  shortExplanation: string;
  confidenceLabel: string;
  suggestedTitle: string;
  suggestedDescription: string;
  visibleObservations: string[];
  aiAssumptions: string[];
  categoryMatch: boolean;
  requiresHumanReview: boolean;
}

interface EditedFieldsState {
  category: boolean;
  severity: boolean;
  title: boolean;
  description: boolean;
}

interface ImageQualityState {
  valid: boolean;
  warnings: string[];
  quality?: {
    quality_rating?: string;
    blur_score?: number;
    is_blurry?: boolean;
    brightness?: number;
    is_dark?: boolean;
    is_overexposed?: boolean;
    contrast_std?: number;
    is_low_contrast?: boolean;
    is_poor_visibility?: boolean;
    is_low_resolution?: boolean;
  };
}

function getFriendlyIssueNoun(
  detectedIssueType?: string | null,
  suggestedCategory?: ExpandedCivicCategory | null
): string {
  const raw = (detectedIssueType || '').trim();
  const lower = raw.toLowerCase();

  if (lower.includes('pothole')) return 'pothole';
  if (lower.includes('dustbin') || lower.includes('overflowing bin')) return 'overflowing dustbin';
  if (lower.includes('garbage') || lower.includes('waste') || lower.includes('trash') || lower.includes('litter')) {
    return 'garbage pile';
  }
  if (lower.includes('road') || lower.includes('pavement') || lower.includes('asphalt')) return 'damaged road';
  if (lower.includes('drain') || lower.includes('sewer') || lower.includes('waterlog')) return 'blocked drain';
  if (lower.includes('leak') || lower.includes('pipe') || lower.includes('water')) return 'water leak';
  if (lower.includes('streetlight') || lower.includes('street light') || lower.includes('lamp')) {
    return 'broken streetlight';
  }

  if (raw && !lower.includes('unknown') && !lower.includes('unclear') && raw.length <= 48) {
    return raw.toLowerCase();
  }

  switch (suggestedCategory) {
    case 'Garbage accumulation':
      return 'garbage pile';
    case 'Overflowing dustbins':
      return 'overflowing dustbin';
    case 'Potholes':
      return 'pothole';
    case 'Damaged roads':
      return 'damaged road';
    case 'Drainage problems':
      return 'drainage problem';
    case 'Water leakage':
      return 'water leak';
    case 'Streetlight problems':
      return 'streetlight problem';
    default:
      return 'civic issue';
  }
}

function getFriendlyFindingHeadline(
  suggestion: UnifiedAiSuggestion | null,
  verification: CivicImageVerificationResult | null
): string {
  if (!suggestion || suggestion.isFallback) {
    return 'We could not check this photo automatically.';
  }
  if (suggestion.isUnrelatedImage) {
    return 'This photo does not seem to show a local civic issue.';
  }
  if (
    verification?.decision === 'UNCLEAR_IMAGE' ||
    verification?.decision === 'POSSIBLE_CIVIC_ISSUE_NEEDS_REVIEW' ||
    !suggestion.suggestedCategory
  ) {
    return 'We see a possible problem, but we are not completely sure of the category. Please check or pick a category below.';
  }
  const noun = getFriendlyIssueNoun(suggestion.detectedIssueType, suggestion.suggestedCategory);
  const article = /^[aeiou]/i.test(noun) ? 'an' : 'a';
  return `We found ${article} possible ${noun}.`;
}

function getFriendlyPhotoTips(
  qualityResult: ImageQualityState | null,
  verification: CivicImageVerificationResult | null
): string[] {
  const tips: string[] = [];
  const q = qualityResult?.quality;

  if (q?.is_blurry) {
    tips.push('The photo looks blurry. Hold your phone steady and tap the screen to focus before taking it.');
  }
  if (q?.is_dark) {
    tips.push('The photo is a bit dark. Step into brighter light or use your camera flash if it is safe.');
  }
  if (q?.is_overexposed) {
    tips.push('Bright glare is hiding details. Angle your phone slightly away from direct sunlight or headlights.');
  }
  if (q?.is_low_contrast || q?.is_poor_visibility) {
    tips.push('Details are hard to see clearly. Move slightly closer so the problem fills more of the frame.');
  }
  if (q?.is_low_resolution) {
    tips.push('The image resolution is low. Try uploading the original photo instead of a compressed screenshot.');
  }

  if (tips.length === 0 && verification?.decision === 'UNCLEAR_IMAGE') {
    tips.push('Try stepping closer so the problem is centered, with steady hands and good lighting.');
  }
  if (tips.length === 0 && qualityResult && qualityResult.warnings.length > 0) {
    tips.push('The photo may be slightly unclear. If details look hard to spot, retaking in steady lighting can help.');
  }

  return tips;
}

function extractReadableLocationSnippet(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) return '';
  if (/^(Detected GPS|Selected Location):\s*-?\d/i.test(trimmed)) {
    return '';
  }
  const firstSegment = trimmed.split(',')[0].trim();
  const clean = firstSegment.length >= 3 ? firstSegment : trimmed;
  return clean.length > 42 ? `${clean.slice(0, 39).trim()}...` : clean;
}

function buildLocationAwareTitle(
  detectedIssueType?: string | null,
  category?: ExpandedCivicCategory | '',
  locationAddress?: string,
  aiSuggestedTitle?: string
): string {
  const snippet = extractReadableLocationSnippet(locationAddress || '');
  const baseIssue = (() => {
    const noun = getFriendlyIssueNoun(detectedIssueType, category || null);
    if (noun && noun !== 'civic issue') {
      return noun.charAt(0).toUpperCase() + noun.slice(1);
    }
    if (aiSuggestedTitle?.trim()) {
      return aiSuggestedTitle.trim();
    }
    if (category) {
      return category;
    }
    return 'Civic issue';
  })();

  if (snippet) {
    return `${baseIssue} near ${snippet}`.slice(0, 120);
  }
  if (aiSuggestedTitle?.trim()) {
    return aiSuggestedTitle.trim().slice(0, 120);
  }
  return baseIssue.slice(0, 120);
}

export const ReportIssueScreen: React.FC<ReportIssueScreenProps> = ({
  user,
  existingReports = [],
  onReportCreated,
  onCancel,
  onNavigateToMyReports,
}) => {
  const { t } = useLanguage();

  // Guided 3-step wizard state (1: Add Photo, 2: Confirm Issue, 3: Add Location)
  const [currentStep, setCurrentStep] = useState<WizardStep>(1);
  const [reportMode, setReportMode] = useState<ReportMode>('photo');

  // Complaint fields (preserved across forward/backward navigation)
  const [category, setCategory] = useState<ExpandedCivicCategory | ''>('');
  const [severity, setSeverity] = useState<'Low' | 'Medium' | 'High' | ''>('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [additionalDetails, setAdditionalDetails] = useState('');
  const [locationAddress, setLocationAddress] = useState('');
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);

  // Tracks explicit citizen edits so AI or location suggestions never silently overwrite user edits
  const [editedFields, setEditedFields] = useState<EditedFieldsState>({
    category: false,
    severity: false,
    title: false,
    description: false,
  });

  const [optimizedPhotoBase64, setOptimizedPhotoBase64] = useState<string | null>(null);
  const [isOptimizingPhoto, setIsOptimizingPhoto] = useState(false);
  const [photoOptimizationError, setPhotoOptimizationError] = useState<string | null>(null);

  // GPS Coordinates: starts strictly null until user obtains GPS or selects on map
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [isLocating, setIsLocating] = useState(false);
  const [locationWarning, setLocationWarning] = useState<string | null>(null);
  const [isMapPickerOpen, setIsMapPickerOpen] = useState(false);

  // Image Quality State (Non-blocking clarity advisory)
  const [isInspectingPhoto, setIsInspectingPhoto] = useState(false);
  const [imageQualityResult, setImageQualityResult] = useState<ImageQualityState | null>(null);
  const [duplicatePhotoCheck, setDuplicatePhotoCheck] = useState<DuplicatePhotoCheckResult | null>(null);

  // AI Civic Image Verification & Understanding State
  const [isVerifyingImage, setIsVerifyingImage] = useState(false);
  const [imageVerification, setImageVerification] = useState<CivicImageVerificationResult | null>(null);
  const [imageVerifyError, setImageVerifyError] = useState<string | null>(null);
  const [unrelatedOverrideConfirmed, setUnrelatedOverrideConfirmed] = useState(false);
  const [showAiDetails, setShowAiDetails] = useState(false);

  // AI Text + Photo Re-check State
  const [isAnalyzingAi, setIsAnalyzingAi] = useState(false);
  const [aiAnalysis, setAiAnalysis] = useState<AiAnalysisResult | null>(null);
  const [aiNotice, setAiNotice] = useState<{ type: 'info' | 'fallback' | 'error'; message: string } | null>(null);
  const [lastAiSource, setLastAiSource] = useState<'image' | 'text' | null>(null);
  const [lastAnalyzedContext, setLastAnalyzedContext] = useState<AnalyzedAiContext | null>(null);

  // Submission & Validation States
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submissionPendingNotice, setSubmissionPendingNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [createdReport, setCreatedReport] = useState<CivicIssueReport | null>(null);
  const [cloudSyncSuccess, setCloudSyncSuccess] = useState(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [isRetryingUpload, setIsRetryingUpload] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retrySuccessMessage, setRetrySuccessMessage] = useState<string | null>(null);

  const submissionLock = useRef(false);
  const pendingIdentityRef = useRef<PendingSubmissionIdentity | null>(null);
  const inFlightSubmissionRef = useRef<
    Promise<{ report: CivicIssueReport; savedToCloud: boolean; error?: string }> | null
  >(null);
  const isMountedRef = useRef(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const manualAddressInputRef = useRef<HTMLInputElement>(null);
  const optimizationPromiseRef = useRef<Promise<string | null> | null>(null);
  const downscaledPhotoRef = useRef<string | null>(null);
  const photoFingerprintRef = useRef<string>('no-photo');
  const activePhotoTokenRef = useRef(0);
  const inFlightFingerprintRef = useRef<string | null>(null);
  const activeInspectControllerRef = useRef<AbortController | null>(null);
  const activeVerifyControllerRef = useRef<AbortController | null>(null);

  const cancelActivePhotoRequests = () => {
    if (activeInspectControllerRef.current) {
      activeInspectControllerRef.current.abort();
      activeInspectControllerRef.current = null;
    }
    if (activeVerifyControllerRef.current) {
      activeVerifyControllerRef.current.abort();
      activeVerifyControllerRef.current = null;
    }
  };

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      activePhotoTokenRef.current += 1;
      cancelActivePhotoRequests();
    };
  }, []);

  const latestInputsRef = useRef({
    category,
    severity,
    title,
    description,
    locationAddress,
    editedFields,
  });
  latestInputsRef.current = {
    category,
    severity,
    title,
    description,
    locationAddress,
    editedFields,
  };

  const CATEGORY_LIST: { value: ExpandedCivicCategory; label: string; icon: React.ReactNode }[] = [
    { value: EXPANDED_CIVIC_CATEGORIES[0], label: t('category.garbageAccumulation'), icon: <Trash2 className="w-4 h-4 text-emerald-600" /> },
    { value: EXPANDED_CIVIC_CATEGORIES[1], label: t('category.overflowingDustbins'), icon: <Trash2 className="w-4 h-4 text-teal-600" /> },
    { value: EXPANDED_CIVIC_CATEGORIES[2], label: t('category.potholes'), icon: <AlertTriangle className="w-4 h-4 text-amber-600" /> },
    { value: EXPANDED_CIVIC_CATEGORIES[3], label: t('category.damagedRoads'), icon: <AlertTriangle className="w-4 h-4 text-orange-600" /> },
    { value: EXPANDED_CIVIC_CATEGORIES[4], label: t('category.drainageProblems'), icon: <CloudRain className="w-4 h-4 text-indigo-600" /> },
    { value: EXPANDED_CIVIC_CATEGORIES[5], label: t('category.waterLeakageExpanded'), icon: <Droplet className="w-4 h-4 text-sky-600" /> },
    { value: EXPANDED_CIVIC_CATEGORIES[6], label: t('category.streetlightProblems'), icon: <Lightbulb className="w-4 h-4 text-yellow-600" /> },
    { value: EXPANDED_CIVIC_CATEGORIES[7], label: t('category.otherCivicIssues'), icon: <HelpCircle className="w-4 h-4 text-slate-600" /> },
  ];

  // Safely update unedited title when location updates
  const syncLocationIntoTitleIfUnedited = (
    nextAddress: string,
    nextCategory?: ExpandedCivicCategory | '',
    detectedIssue?: string | null,
    aiSuggestedTitle?: string
  ) => {
    if (latestInputsRef.current.editedFields.title) return;
    const catToUse = nextCategory ?? latestInputsRef.current.category;
    const issueToUse = detectedIssue ?? imageVerification?.detectedIssueType ?? aiAnalysis?.detectedIssueType;
    const titleToUse = aiSuggestedTitle ?? imageVerification?.suggestedTitle ?? aiAnalysis?.suggestedTitle;
    if (!catToUse && !issueToUse && !titleToUse) return;

    const computed = buildLocationAwareTitle(issueToUse, catToUse, nextAddress, titleToUse);
    if (computed) {
      setTitle(computed);
    }
  };

  // Handle GPS detection with null fallback
  const handleUseGps = () => {
    setIsLocating(true);
    setLocationWarning(null);

    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setIsLocating(false);
          const lat = parseFloat(position.coords.latitude.toFixed(5));
          const lng = parseFloat(position.coords.longitude.toFixed(5));
          setCoords({ lat, lng });
          if (!locationAddress.trim()) {
            setLocationAddress(`Detected GPS: ${lat}, ${lng}`);
          }
        },
        (error) => {
          setIsLocating(false);
          setCoords(null);
          const reason =
            error.code === 1
              ? 'location access was not granted'
              : error.code === 3
              ? 'location request timed out'
              : 'your device location is currently unavailable';
          setLocationWarning(
            `Could not detect your location (${reason}). You can enter your street address below or pick it on the map.`
          );
        },
        { enableHighAccuracy: true, timeout: 8000 }
      );
    } else {
      setIsLocating(false);
      setLocationWarning('Location detection is not supported in this browser. Please enter your address below or pick on the map.');
    }
  };

  // Prefills only unedited fields on non-fallback, civic-issue AI responses
  const applyInitialSuggestionsSafely = (result: CivicImageVerificationResult) => {
    if (result.isFallback || result.decision === 'UNRELATED_IMAGE') {
      return;
    }

    const currentEdited = latestInputsRef.current.editedFields;
    const detectedCat =
      result.primaryCategory && result.primaryCategory !== 'Unrelated / Non-Civic'
        ? normalizeCivicCategory(result.primaryCategory)
        : null;

    if (!currentEdited.category && detectedCat) {
      setCategory(detectedCat);
    }
    if (!currentEdited.severity && result.suggestedSeverity) {
      setSeverity(result.suggestedSeverity);
    }
    if (!currentEdited.title) {
      const contextualTitle = buildLocationAwareTitle(
        result.detectedIssueType || result.visualSubType,
        detectedCat || latestInputsRef.current.category,
        latestInputsRef.current.locationAddress,
        result.suggestedTitle
      );
      if (contextualTitle) {
        setTitle(contextualTitle);
      }
    }
    if (!currentEdited.description && result.suggestedDescription?.trim()) {
      setDescription(result.suggestedDescription.trim().slice(0, 500));
    }
  };

  // Runs Groq Vision civic image verification (deduplicated & token-guarded)
  const runCivicImageVerification = async (
    imagePayload: string,
    qualitySummary?: Record<string, any> | null,
    forceRefresh: boolean = false,
    expectedToken?: number
  ) => {
    const token = expectedToken ?? activePhotoTokenRef.current;
    const currentEdited = latestInputsRef.current.editedFields;
    const selectedCategoryForAi =
      currentEdited.category && latestInputsRef.current.category
        ? latestInputsRef.current.category
        : undefined;
    const descriptionForAi = currentEdited.description
      ? latestInputsRef.current.description.trim()
      : '';

    const fingerprint =
      photoFingerprintRef.current !== 'no-photo'
        ? photoFingerprintRef.current
        : await computeImageFingerprint(imagePayload);
    if (token !== activePhotoTokenRef.current) return;
    photoFingerprintRef.current = fingerprint;

    if (!forceRefresh) {
      if (inFlightFingerprintRef.current === fingerprint) {
        return;
      }
      if (
        imageVerification &&
        !imageVerification.isFallback &&
        lastAnalyzedContext?.photoKey === fingerprint &&
        lastAnalyzedContext?.category === (selectedCategoryForAi || '') &&
        lastAnalyzedContext?.description === descriptionForAi
      ) {
        return;
      }
    }

    if (activeVerifyControllerRef.current) {
      activeVerifyControllerRef.current.abort();
    }
    const verifyController = new AbortController();
    activeVerifyControllerRef.current = verifyController;

    inFlightFingerprintRef.current = fingerprint;
    setIsVerifyingImage(true);
    setImageVerifyError(null);

    try {
      const result = await validateCivicIssueImage({
        photoBase64: imagePayload,
        description: descriptionForAi,
        selectedCategory: selectedCategoryForAi,
        qualitySummary: qualitySummary || imageQualityResult?.quality || null,
        forceRefresh,
        timeoutMs: VALIDATE_CIVIC_IMAGE_TIMEOUT_MS,
        signal: verifyController.signal,
      });
      if (token !== activePhotoTokenRef.current || verifyController.signal.aborted) return;

      setImageVerification(result);
      console.info('[CiviFix] Groq analysis displayed in report screen state', {
        decision: result.decision,
        category: result.primaryCategory,
        severity: result.suggestedSeverity,
        requiresHumanReview: result.requiresHumanReview,
        isFallback: result.isFallback,
      });
      setLastAiSource('image');
      setLastAnalyzedContext({
        photoKey: fingerprint,
        category: selectedCategoryForAi || '',
        description: descriptionForAi,
      });
      setAiNotice(null);

      if (!result.isFallback && result.decision !== 'UNRELATED_IMAGE') {
        applyInitialSuggestionsSafely(result);
      }
    } catch (err: any) {
      if (token !== activePhotoTokenRef.current || verifyController.signal.aborted) return;
      const msg = typeof err?.message === 'string' ? err.message : '';
      const isTechnical = /http\s*\d+|failed to fetch|networkerror|aborterror|syntaxerror|typeerror/i.test(msg);
      setImageVerifyError(
        msg && !isTechnical ? msg : FRIENDLY_IMAGE_VERIFY_FALLBACK_MESSAGE
      );
    } finally {
      if (activeVerifyControllerRef.current === verifyController) {
        activeVerifyControllerRef.current = null;
      }
      if (inFlightFingerprintRef.current === fingerprint) {
        inFlightFingerprintRef.current = null;
      }
      if (token === activePhotoTokenRef.current) {
        setIsVerifyingImage(false);
      }
    }
  };

  // Retry helper that always prepares a valid downscaled photo payload before calling Groq Vision
  const handleRetryPhotoAnalysis = async () => {
    if (!photoPreview || isVerifyingImage) return;
    const token = activePhotoTokenRef.current;
    try {
      let payload = downscaledPhotoRef.current || optimizedPhotoBase64;
      if (!payload) {
        payload = await downscaleBase64ForService(photoPreview, 1024, 0.82);
        if (token !== activePhotoTokenRef.current) return;
        downscaledPhotoRef.current = payload;
      }
      await runCivicImageVerification(
        payload,
        imageQualityResult?.quality || null,
        true,
        token
      );
    } catch {
      if (token === activePhotoTokenRef.current) {
        setIsVerifyingImage(false);
        setImageVerifyError(FRIENDLY_IMAGE_VERIFY_FALLBACK_MESSAGE);
      }
    }
  };

  // Handle Photo File Input: immediately renders preview, runs civic image analysis right away, checks clarity in parallel, and optimizes for storage
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const validation = validateCivicImageUpload(file);
    if (!validation.valid) {
      const msg = validation.error || 'Please choose a JPG, PNG, or WebP photograph.';
      setPhotoOptimizationError(msg);
      setErrorMessage(msg);
      return;
    }

    const uploadToken = ++activePhotoTokenRef.current;
    cancelActivePhotoRequests();
    inFlightFingerprintRef.current = null;

    const reader = new FileReader();
    reader.onerror = () => {
      if (uploadToken !== activePhotoTokenRef.current) return;
      setIsOptimizingPhoto(false);
      setIsInspectingPhoto(false);
      setIsVerifyingImage(false);
      setPhotoOptimizationError('Could not read the selected photo. Please try another image.');
    };
    reader.onloadend = () => {
      if (uploadToken !== activePhotoTokenRef.current) return;
      const rawBase64Data = reader.result as string;
      if (typeof rawBase64Data !== 'string' || !rawBase64Data) {
        setPhotoOptimizationError('Could not read the selected photo. Please try another image.');
        return;
      }

      // Immediate preview & reset per-photo AI results while preserving any manual form edits
      setReportMode('photo');
      setPhotoPreview(rawBase64Data);
      setOptimizedPhotoBase64(null);
      downscaledPhotoRef.current = null;
      photoFingerprintRef.current = 'no-photo';
      setErrorMessage(null);
      setPhotoOptimizationError(null);
      setImageQualityResult(null);
      setDuplicatePhotoCheck(null);
      setImageVerification(null);
      setImageVerifyError(null);
      setIsVerifyingImage(true);
      setUnrelatedOverrideConfirmed(false);
      setAiAnalysis(null);
      setAiNotice(null);
      setLastAiSource(null);
      setLastAnalyzedContext(null);

      checkDuplicatePhoto(rawBase64Data, existingReports)
        .then((dup) => {
          if (uploadToken === activePhotoTokenRef.current && dup.isDuplicate) {
            setDuplicatePhotoCheck(dup);
          }
        })
        .catch(() => {});

      setIsInspectingPhoto(true);
      downscaleBase64ForService(rawBase64Data, 1024, 0.82)
        .then(async (downscaled) => {
          if (uploadToken !== activePhotoTokenRef.current) return;
          downscaledPhotoRef.current = downscaled;
          const fp = await computeImageFingerprint(downscaled);
          if (uploadToken !== activePhotoTokenRef.current) return;
          photoFingerprintRef.current = fp;

          // Run optional photo-clarity inspection in parallel so OpenCV latency or unavailability NEVER delays civic image analysis
          const inspectController = new AbortController();
          activeInspectControllerRef.current = inspectController;
          const inspectTimer = setTimeout(() => {
            inspectController.abort();
          }, INSPECT_CIVIC_IMAGE_TIMEOUT_MS);

          void (async () => {
            try {
              const data = await inspectCivicPhotoQuality({
                photoBase64: downscaled,
                timeoutMs: INSPECT_CIVIC_IMAGE_TIMEOUT_MS,
                signal: inspectController.signal,
              });
              if (uploadToken !== activePhotoTokenRef.current) return;
              if (data && data.success && data.quality) {
                setImageQualityResult({
                  valid: data.valid ?? true,
                  warnings: data.warnings || [],
                  quality: data.quality,
                });
              } else if (data && data.warnings && data.warnings.length > 0) {
                setImageQualityResult({ valid: false, warnings: data.warnings });
              } else {
                setImageQualityResult(null);
              }
            } catch {
              if (uploadToken === activePhotoTokenRef.current) {
                setImageQualityResult(null);
              }
            } finally {
              clearTimeout(inspectTimer);
              if (activeInspectControllerRef.current === inspectController) {
                activeInspectControllerRef.current = null;
              }
              if (uploadToken === activePhotoTokenRef.current) {
                setIsInspectingPhoto(false);
              }
            }
          })();

          // Start Groq Vision analysis immediately after downscaling
          await runCivicImageVerification(downscaled, null, false, uploadToken);
        })
        .catch(() => {
          if (uploadToken === activePhotoTokenRef.current) {
            setIsInspectingPhoto(false);
            setIsVerifyingImage(false);
            setImageVerifyError('Unable to prepare image for AI analysis. You can choose another photo or enter details manually.');
          }
        });

      setIsOptimizingPhoto(true);
      const optPromise = optimizeBase64Image(rawBase64Data)
        .then((optResult) => {
          if (uploadToken !== activePhotoTokenRef.current) return null;
          if (optResult.success && optResult.dataUrl) {
            setOptimizedPhotoBase64(optResult.dataUrl);
            setPhotoOptimizationError(null);
            checkDuplicatePhoto(optResult.dataUrl, existingReports)
              .then((dup) => {
                if (uploadToken === activePhotoTokenRef.current && dup.isDuplicate) {
                  setDuplicatePhotoCheck(dup);
                }
              })
              .catch(() => {});
            return optResult.dataUrl;
          } else {
            activePhotoTokenRef.current += 1;
            cancelActivePhotoRequests();
            inFlightFingerprintRef.current = null;
            setIsInspectingPhoto(false);
            setIsVerifyingImage(false);
            setPhotoPreview(null);
            setOptimizedPhotoBase64(null);
            downscaledPhotoRef.current = null;
            photoFingerprintRef.current = 'no-photo';
            setPhotoOptimizationError(
              optResult.error || 'Could not prepare photo for storage. Please choose another image.'
            );
            return null;
          }
        })
        .catch((err: any) => {
          console.warn('Photo optimization failed:', err);
          if (uploadToken !== activePhotoTokenRef.current) return null;
          activePhotoTokenRef.current += 1;
          cancelActivePhotoRequests();
          inFlightFingerprintRef.current = null;
          setIsInspectingPhoto(false);
          setIsVerifyingImage(false);
          setPhotoPreview(null);
          setOptimizedPhotoBase64(null);
          downscaledPhotoRef.current = null;
          photoFingerprintRef.current = 'no-photo';
          setPhotoOptimizationError('We could not process this photo. Please try choosing another clear image.');
          return null;
        })
        .finally(() => {
          if (uploadToken === activePhotoTokenRef.current) {
            setIsOptimizingPhoto(false);
          }
        });

      optimizationPromiseRef.current = optPromise;
    };
    reader.readAsDataURL(file);
  };

  const handleRemovePhoto = () => {
    activePhotoTokenRef.current += 1;
    cancelActivePhotoRequests();
    inFlightFingerprintRef.current = null;
    setPhotoPreview(null);
    setOptimizedPhotoBase64(null);
    downscaledPhotoRef.current = null;
    photoFingerprintRef.current = 'no-photo';
    setPhotoOptimizationError(null);
    setImageQualityResult(null);
    setDuplicatePhotoCheck(null);
    setImageVerification(null);
    setImageVerifyError(null);
    setIsInspectingPhoto(false);
    setIsVerifyingImage(false);
    setIsOptimizingPhoto(false);
    setUnrelatedOverrideConfirmed(false);
    setAiAnalysis(null);
    setAiNotice(null);
    setLastAiSource(null);
    setLastAnalyzedContext(null);
    optimizationPromiseRef.current = null;
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    if (cameraInputRef.current) {
      cameraInputRef.current.value = '';
    }
  };

  const handleChooseManualReport = () => {
    handleRemovePhoto();
    setReportMode('manual');
    setErrorMessage(null);
    setCurrentStep(2);
  };

  // Unified AI Suggestion View Model
  const formatConfidenceLabel = (
    level?: 'Low' | 'Medium' | 'High' | null,
    legacyConfidence?: string | null
  ): string => {
    if (level && legacyConfidence) return `${level} (${legacyConfidence})`;
    if (level) return level;
    if (legacyConfidence) return legacyConfidence;
    return 'Not sure — please check';
  };

  const unifiedSuggestion: UnifiedAiSuggestion | null = (() => {
    if (
      lastAiSource === 'text' &&
      aiAnalysis &&
      (!aiAnalysis.isFallback || !imageVerification || imageVerification.isFallback)
    ) {
      const cat = normalizeCivicCategory(
        aiAnalysis.suggestedExpandedCategory || aiAnalysis.suggestedCategory
      );
      return {
        source: 'text',
        isFallback: Boolean(aiAnalysis.isFallback),
        isUnrelatedImage: false,
        detectedIssueType: aiAnalysis.detectedIssueType || cat,
        suggestedCategory: cat,
        suggestedSeverity: aiAnalysis.suggestedSeverity || aiAnalysis.severity || 'Medium',
        severityReason: aiAnalysis.severityReason || aiAnalysis.aiNotes || '',
        shortExplanation: aiAnalysis.shortExplanation || aiAnalysis.aiNotes || '',
        confidenceLabel: formatConfidenceLabel(aiAnalysis.confidenceLevel, aiAnalysis.confidence),
        suggestedTitle: aiAnalysis.suggestedTitle || '',
        suggestedDescription: aiAnalysis.suggestedDescription || '',
        visibleObservations: imageVerification?.visibleObservations || [],
        aiAssumptions: imageVerification?.aiAssumptions || [],
        categoryMatch: Boolean(aiAnalysis.categoryMatch) || (category !== '' && cat === category),
        requiresHumanReview: Boolean(aiAnalysis.isFallback),
      };
    }

    if (imageVerification) {
      const isUnrelated = imageVerification.decision === 'UNRELATED_IMAGE';
      const suggestedCat =
        imageVerification.primaryCategory === 'Unrelated / Non-Civic'
          ? null
          : normalizeCivicCategory(imageVerification.primaryCategory);
      return {
        source: 'image',
        isFallback: Boolean(imageVerification.isFallback),
        isUnrelatedImage: isUnrelated,
        detectedIssueType:
          imageVerification.detectedIssueType ||
          imageVerification.visualSubType ||
          imageVerification.issueDetected,
        suggestedCategory: suggestedCat,
        suggestedSeverity: imageVerification.suggestedSeverity || 'Medium',
        severityReason: imageVerification.severityReason || '',
        shortExplanation:
          imageVerification.shortExplanation || imageVerification.explanation || '',
        confidenceLabel: formatConfidenceLabel(
          imageVerification.confidenceLevel,
          imageVerification.confidence
        ),
        suggestedTitle: imageVerification.suggestedTitle || '',
        suggestedDescription: imageVerification.suggestedDescription || '',
        visibleObservations: imageVerification.visibleObservations || [],
        aiAssumptions: imageVerification.aiAssumptions || [],
        categoryMatch: suggestedCat !== null && category !== '' && suggestedCat === category,
        requiresHumanReview: Boolean(imageVerification.requiresHumanReview),
      };
    }

    if (aiAnalysis) {
      const cat = normalizeCivicCategory(
        aiAnalysis.suggestedExpandedCategory || aiAnalysis.suggestedCategory
      );
      return {
        source: 'text',
        isFallback: Boolean(aiAnalysis.isFallback),
        isUnrelatedImage: false,
        detectedIssueType: aiAnalysis.detectedIssueType || cat,
        suggestedCategory: cat,
        suggestedSeverity: aiAnalysis.suggestedSeverity || aiAnalysis.severity || 'Medium',
        severityReason: aiAnalysis.severityReason || aiAnalysis.aiNotes || '',
        shortExplanation: aiAnalysis.shortExplanation || aiAnalysis.aiNotes || '',
        confidenceLabel: formatConfidenceLabel(aiAnalysis.confidenceLevel, aiAnalysis.confidence),
        suggestedTitle: aiAnalysis.suggestedTitle || '',
        suggestedDescription: aiAnalysis.suggestedDescription || '',
        visibleObservations: [],
        aiAssumptions: [],
        categoryMatch: Boolean(aiAnalysis.categoryMatch) || (category !== '' && cat === category),
        requiresHumanReview: Boolean(aiAnalysis.isFallback),
      };
    }

    return null;
  })();

  const trimmedDescription = description.trim();
  const isAiSuggestionStale = Boolean(
    unifiedSuggestion &&
      !unifiedSuggestion.isFallback &&
      lastAnalyzedContext &&
      ((category !== '' &&
        category !== lastAnalyzedContext.category &&
        category !== unifiedSuggestion.suggestedCategory) ||
        (trimmedDescription !== lastAnalyzedContext.description &&
          trimmedDescription !== unifiedSuggestion.suggestedDescription.trim()))
  );

  // Text + photo AI re-check helper
  const handleAnalyzeWithAi = async (forceRefresh: boolean = false) => {
    const descAtCall = description.trim();
    if (!descAtCall && !photoPreview) {
      setErrorMessage(t('report.descriptionRequired'));
      return;
    }

    if (isAnalyzingAi || isVerifyingImage) return;

    setErrorMessage(null);
    const catAtCall = category;
    const tokenAtCall = activePhotoTokenRef.current;

    let photoPayload: string | null = null;
    let currentPhotoKey = 'no-photo';
    if (photoPreview) {
      photoPayload =
        downscaledPhotoRef.current ||
        optimizedPhotoBase64 ||
        (await downscaleBase64ForService(photoPreview, 1024, 0.82));
      if (tokenAtCall !== activePhotoTokenRef.current) return;
      downscaledPhotoRef.current = photoPayload;
      currentPhotoKey =
        photoFingerprintRef.current !== 'no-photo'
          ? photoFingerprintRef.current
          : await computeImageFingerprint(photoPayload);
      if (tokenAtCall !== activePhotoTokenRef.current) return;
      photoFingerprintRef.current = currentPhotoKey;
    }

    if (
      !forceRefresh &&
      unifiedSuggestion &&
      !unifiedSuggestion.isFallback &&
      lastAnalyzedContext &&
      lastAnalyzedContext.photoKey === currentPhotoKey &&
      !isAiSuggestionStale
    ) {
      setAiNotice({
        type: 'info',
        message: 'Suggestions already match your current details.',
      });
      return;
    }

    setIsAnalyzingAi(true);
    setAiNotice(null);

    const analyzeController = new AbortController();
    const analyzeTimer = setTimeout(() => {
      analyzeController.abort();
    }, VALIDATE_CIVIC_IMAGE_TIMEOUT_MS);

    try {
      const requestBody = JSON.stringify({
        description: descAtCall,
        selectedCategory: catAtCall || undefined,
        photoBase64: photoPayload,
        forceRefresh: Boolean(forceRefresh),
      });

      const authHeaders = await getFirebaseAuthHeaders(false);
      let res = await fetch(getApiUrl('/api/gemini/analyze-issue'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: requestBody,
        signal: analyzeController.signal,
      });

      if (res.status === 401) {
        const refreshedHeaders = await getFirebaseAuthHeaders(true);
        if (refreshedHeaders.Authorization) {
          res = await fetch(getApiUrl('/api/gemini/analyze-issue'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...refreshedHeaders },
            body: requestBody,
            signal: analyzeController.signal,
          });
        }
      }

      if (!res.ok) {
        if (tokenAtCall === activePhotoTokenRef.current) {
          setAiNotice({
            type: 'error',
            message: 'Could not update suggestions right now. Please try again or continue manually.',
          });
        }
        return;
      }

      const data = await res.json();
      if (tokenAtCall !== activePhotoTokenRef.current) return;

      if (data?.isFallback) {
        // Never save or display fabricated fallback AI analysis when the AI suggestion service is unavailable
        setAiNotice({
          type: 'fallback',
          message: 'Automatic suggestions are unavailable right now. You can try again or continue manually.',
        });
      } else if (data && (data.suggestedExpandedCategory || data.suggestedCategory)) {
        setAiAnalysis(data);
        setLastAiSource('text');
        setLastAnalyzedContext({
          photoKey: currentPhotoKey,
          category: catAtCall,
          description: descAtCall,
        });
        setAiNotice(null);
      } else {
        setAiNotice({
          type: 'error',
          message: 'Could not update suggestions right now. Your details were kept as entered.',
        });
      }
    } catch {
      if (tokenAtCall === activePhotoTokenRef.current) {
        setAiNotice({
          type: 'fallback',
          message: 'Automatic suggestions are temporarily unavailable. You can try again or continue manually.',
        });
      }
    } finally {
      clearTimeout(analyzeTimer);
      if (tokenAtCall === activePhotoTokenRef.current) {
        setIsAnalyzingAi(false);
      }
    }
  };

  // Explicit Apply Controls (never silently overwrite user edits)
  const handleApplyAiCategory = () => {
    if (!unifiedSuggestion?.suggestedCategory || unifiedSuggestion.isUnrelatedImage || unifiedSuggestion.isFallback) return;
    setCategory(unifiedSuggestion.suggestedCategory);
    setEditedFields((prev) => ({ ...prev, category: false }));
    setErrorMessage(null);
  };

  const handleApplyAiSeverity = () => {
    if (!unifiedSuggestion || unifiedSuggestion.isUnrelatedImage || unifiedSuggestion.isFallback) return;
    setSeverity(unifiedSuggestion.suggestedSeverity);
    setEditedFields((prev) => ({ ...prev, severity: false }));
    setErrorMessage(null);
  };

  const handleApplyAiTitle = () => {
    if (!unifiedSuggestion || unifiedSuggestion.isUnrelatedImage || unifiedSuggestion.isFallback) return;
    const computed = buildLocationAwareTitle(
      unifiedSuggestion.detectedIssueType,
      unifiedSuggestion.suggestedCategory || category,
      locationAddress,
      unifiedSuggestion.suggestedTitle
    );
    if (computed) {
      setTitle(computed);
      setEditedFields((prev) => ({ ...prev, title: false }));
    }
    setErrorMessage(null);
  };

  const handleApplyAiDescription = () => {
    if (!unifiedSuggestion?.suggestedDescription || unifiedSuggestion.isUnrelatedImage || unifiedSuggestion.isFallback) return;
    setDescription(unifiedSuggestion.suggestedDescription.slice(0, 500));
    setEditedFields((prev) => ({ ...prev, description: false }));
    setErrorMessage(null);
  };

  const handleApplyAllAiSuggestions = () => {
    if (!unifiedSuggestion || unifiedSuggestion.isUnrelatedImage || unifiedSuggestion.isFallback) return;
    const nextCat = unifiedSuggestion.suggestedCategory || category;
    if (unifiedSuggestion.suggestedCategory) {
      setCategory(unifiedSuggestion.suggestedCategory);
    }
    setSeverity(unifiedSuggestion.suggestedSeverity);
    const computedTitle = buildLocationAwareTitle(
      unifiedSuggestion.detectedIssueType,
      nextCat,
      locationAddress,
      unifiedSuggestion.suggestedTitle
    );
    if (computedTitle) {
      setTitle(computedTitle);
    }
    if (unifiedSuggestion.suggestedDescription) {
      setDescription(unifiedSuggestion.suggestedDescription.slice(0, 500));
    }
    setEditedFields({
      category: false,
      severity: false,
      title: false,
      description: false,
    });
    setErrorMessage(null);
  };

  const combinedDescription = (() => {
    const base = description.trim();
    const extra = additionalDetails.trim();
    if (!extra) return base;
    if (!base) return extra;
    return `${base}\n\nAdditional details: ${extra}`;
  })();

  const contextualSuggestedTitle = buildLocationAwareTitle(
    unifiedSuggestion?.detectedIssueType,
    category || unifiedSuggestion?.suggestedCategory || '',
    locationAddress,
    unifiedSuggestion?.suggestedTitle
  );

  // Step-by-step navigation helpers (preserve all entered data!)
  const canLeaveStep1 =
    reportMode === 'manual'
      ? true
      : Boolean(photoPreview) &&
        !(
          imageVerification &&
          !imageVerification.isFallback &&
          imageVerification.decision === 'UNRELATED_IMAGE' &&
          !unrelatedOverrideConfirmed
        );

  const isStep2Valid = Boolean(category && severity && combinedDescription.length >= 10);

  const handleGoToStep = (targetStep: WizardStep) => {
    setErrorMessage(null);

    if (targetStep === 1) {
      setCurrentStep(1);
      return;
    }

    if (targetStep === 2) {
      if (!photoPreview && reportMode !== 'manual') {
        setErrorMessage('Please upload a photo or choose "Continue without a photo" first.');
        return;
      }
      if (
        photoPreview &&
        imageVerification &&
        !imageVerification.isFallback &&
        imageVerification.decision === 'UNRELATED_IMAGE' &&
        !unrelatedOverrideConfirmed
      ) {
        setErrorMessage('Please upload a photo showing the civic issue, switch to manual entry without a photo, or confirm manual review.');
        return;
      }
      setCurrentStep(2);
      return;
    }

    if (targetStep === 3) {
      if (!photoPreview && reportMode !== 'manual') {
        setErrorMessage('Please upload a photo or choose "Continue without a photo" first.');
        setCurrentStep(1);
        return;
      }
      if (!category) {
        setErrorMessage(t('report.categoryRequired'));
        setCurrentStep(2);
        return;
      }
      if (!severity) {
        setErrorMessage('Please select how urgent the issue is (Low, Medium, or High).');
        setCurrentStep(2);
        return;
      }
      const descValidation = validateMeaningfulCivicText(description, {
        fieldLabel: 'Issue description',
        minLength: 10,
        maxLength: 500,
        required: true,
      });
      if (!descValidation.valid) {
        setErrorMessage(descValidation.error || t('report.descriptionRequired'));
        setCurrentStep(2);
        return;
      }
      if (title.trim()) {
        const titleValidation = validateMeaningfulCivicText(title, {
          fieldLabel: 'Complaint title',
          minLength: 4,
          maxLength: 120,
          required: false,
        });
        if (!titleValidation.valid) {
          setErrorMessage(titleValidation.error || 'Please enter a meaningful complaint title.');
          setCurrentStep(2);
          return;
        }
      }
      if (additionalDetails.trim()) {
        const extraValidation = validateMeaningfulCivicText(additionalDetails, {
          fieldLabel: 'Extra notes',
          minLength: 4,
          maxLength: 250,
          required: false,
        });
        if (!extraValidation.valid) {
          setErrorMessage(extraValidation.error || 'Please enter clear extra notes or leave the field empty.');
          setCurrentStep(2);
          return;
        }
      }
      setCurrentStep(3);
    }
  };

  // Full form validation before final submission
  const validateForm = () => {
    if (!photoPreview && reportMode !== 'manual') {
      setErrorMessage('Please upload a photo or choose manual entry without a photo.');
      setCurrentStep(1);
      return false;
    }
    if (!category) {
      setErrorMessage(t('report.categoryRequired'));
      setCurrentStep(2);
      return false;
    }
    if (!severity) {
      setErrorMessage('Please choose the severity level (Low, Medium, or High).');
      setCurrentStep(2);
      return false;
    }
    const descValidation = validateMeaningfulCivicText(description, {
      fieldLabel: 'Issue description',
      minLength: 10,
      maxLength: 500,
      required: true,
    });
    if (!descValidation.valid) {
      setErrorMessage(descValidation.error || t('report.descriptionRequired'));
      setCurrentStep(2);
      return false;
    }
    if (title.trim()) {
      const titleValidation = validateMeaningfulCivicText(title, {
        fieldLabel: 'Complaint title',
        minLength: 4,
        maxLength: 120,
        required: false,
      });
      if (!titleValidation.valid) {
        setErrorMessage(titleValidation.error || 'Please enter a meaningful complaint title.');
        setCurrentStep(2);
        return false;
      }
    }
    if (additionalDetails.trim()) {
      const extraValidation = validateMeaningfulCivicText(additionalDetails, {
        fieldLabel: 'Extra notes',
        minLength: 4,
        maxLength: 250,
        required: false,
      });
      if (!extraValidation.valid) {
        setErrorMessage(extraValidation.error || 'Please enter clear extra notes or leave the field empty.');
        setCurrentStep(2);
        return false;
      }
    }
    const locationValidation = validateMeaningfulCivicText(locationAddress, {
      fieldLabel: 'Incident location',
      minLength: 4,
      maxLength: 240,
      required: true,
    });
    if (!locationValidation.valid) {
      setErrorMessage(locationValidation.error || t('report.locationRequired'));
      setCurrentStep(3);
      return false;
    }
    return true;
  };

  // Handle Submit Report to Firestore (with double-tap lock, stable identity & non-cancelling timeout)
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (submissionLock.current || isSubmitting) return;

    // If this draft already produced a report (e.g., background submit completed), avoid creating a duplicate
    if (createdReport) {
      setSubmissionPendingNotice(null);
      setShowSuccessModal(true);
      return;
    }

    if (!validateForm()) return;

    let photoToUpload = optimizedPhotoBase64;
    if (photoPreview && isOptimizingPhoto && optimizationPromiseRef.current) {
      try {
        const optTimeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500));
        const res = await Promise.race([optimizationPromiseRef.current, optTimeout]);
        if (res) {
          photoToUpload = res;
        }
      } catch {
        // Continue
      }
    }

    if (photoPreview && !photoToUpload && isOptimizingPhoto) {
      setErrorMessage('Your photo is still getting ready. Please wait a moment and tap Submit again.');
      return;
    }

    if (photoPreview && photoOptimizationError) {
      setErrorMessage(photoOptimizationError);
      return;
    }

    if (
      photoPreview &&
      imageVerification?.decision === 'UNRELATED_IMAGE' &&
      !unrelatedOverrideConfirmed
    ) {
      setErrorMessage(
        'This photo does not appear to show a civic problem. Please choose a clear photo or remove it to submit manually.'
      );
      setCurrentStep(1);
      return;
    }

    submissionLock.current = true;
    setIsSubmitting(true);

    try {
      const SUBMISSION_TIMEOUT_MS = 7000;

      // Reuse existing identity across timeout/retry paths so we never create a second complaint
      if (!pendingIdentityRef.current) {
        pendingIdentityRef.current = createSubmissionIdentity();
      }
      const identity = pendingIdentityRef.current;

      // Reuse the already in-flight submission promise if a prior attempt passed the 7s UI wait
      let activePromise = inFlightSubmissionRef.current;
      if (!activePromise) {
        const confirmedCategory = category as ExpandedCivicCategory;
        const confirmedSeverity = severity as 'Low' | 'Medium' | 'High';
        const attachedAiAnalysis: AiAnalysisResult | undefined =
          aiAnalysis && !aiAnalysis.isFallback ? aiAnalysis : undefined;

        const finalImageVerification: CivicImageVerificationResult | undefined =
          imageVerification && !imageVerification.isFallback
            ? {
                ...imageVerification,
                duplicateMatchTrackingNumber: duplicatePhotoCheck?.matchingTrackingNumber || null,
                requiresHumanReview:
                  unrelatedOverrideConfirmed || imageVerification.requiresHumanReview,
              }
            : undefined;

        const finalDesc = combinedDescription.slice(0, 800);
        const computedFallbackTitle = buildLocationAwareTitle(
          unifiedSuggestion?.detectedIssueType,
          confirmedCategory,
          locationAddress,
          ''
        );
        const finalTitle =
          title.trim() ||
          computedFallbackTitle ||
          `${confirmedCategory}: ${finalDesc.slice(0, 40)}${finalDesc.length > 40 ? '...' : ''}`;

        const launchedPromise = submitCivicReportToFirestore(
          {
            reportId: identity.reportId,
            trackingNumber: identity.trackingNumber,
            submittedAt: identity.submittedAt,
            category: confirmedCategory,
            title: finalTitle,
            description: finalDesc,
            photoUrl: photoPreview ? (photoToUpload || '') : '',
            locationAddress: locationAddress.trim(),
            latitude: coords ? coords.lat : null,
            longitude: coords ? coords.lng : null,
            ward: user.ward || 'Unassigned Ward',
            severity: confirmedSeverity,
            department: getDepartmentForCategory(confirmedCategory),
            aiAnalysis: attachedAiAnalysis,
            imageVerification: finalImageVerification,
          },
          user
        );

        inFlightSubmissionRef.current = launchedPromise;
        activePromise = launchedPromise;

        // Keep background promise attached so completion updates UI & state honestly even after 7s notice
        launchedPromise
          .then((result) => {
            if (inFlightSubmissionRef.current === launchedPromise) {
              inFlightSubmissionRef.current = null;
            }
            onReportCreated(result.report);
            if (!isMountedRef.current) return;
            setSubmissionPendingNotice(null);
            setErrorMessage(null);
            setCreatedReport(result.report);
            setCloudSyncSuccess(result.savedToCloud);
            setSyncNotice(result.error || null);
            setRetryError(null);
            setRetrySuccessMessage(null);
            setShowSuccessModal(true);
          })
          .catch((err: any) => {
            if (inFlightSubmissionRef.current === launchedPromise) {
              inFlightSubmissionRef.current = null;
            }
            if (!isMountedRef.current) return;
            setSubmissionPendingNotice(null);
            setErrorMessage(toUserFriendlyErrorMessage(err, 'submit_complaint'));
          });
      }

      const outcome = await awaitSubmissionWithTimeoutNotice(activePromise, SUBMISSION_TIMEOUT_MS);
      if (outcome.timedOut) {
        if (isMountedRef.current) {
          setSubmissionPendingNotice(
            `Still submitting in the background (Complaint ID: ${identity.trackingNumber}). The upload has not been cancelled — please wait a moment or tap "Check Submission Status" below without creating a duplicate complaint.`
          );
        }
        return;
      }

      // Wait one tick for attached completion handler to finish updating state cleanly
      await activePromise.catch(() => {});
    } catch (err: any) {
      if (isMountedRef.current) {
        setErrorMessage(toUserFriendlyErrorMessage(err, 'submit_complaint'));
      }
    } finally {
      if (isMountedRef.current) {
        setIsSubmitting(false);
      }
      submissionLock.current = false;
    }
  };

  const handleRetryUpload = async () => {
    if (!createdReport || isRetryingUpload) return;
    setIsRetryingUpload(true);
    setRetryError(null);
    setRetrySuccessMessage(null);

    try {
      const res = await retryReportUpload(createdReport, user);
      if (res.success) {
        if (res.auditWarning) {
          console.warn('Non-blocking report retry audit notice:', res.auditWarning);
        }
        setCreatedReport(res.report);
        setCloudSyncSuccess(true);
        setSyncNotice(null);
        setRetrySuccessMessage(
          res.alreadyExistedInCloud
            ? 'Confirmed: your complaint is already recorded with municipal services.'
            : t('report.retrySuccess')
        );
        onReportCreated(res.report);
      } else {
        setRetryError(res.error || 'Could not send right now. Saved safely on this device.');
      }
    } catch (err: any) {
      setRetryError(toUserFriendlyErrorMessage(err, 'submit_complaint'));
    } finally {
      setIsRetryingUpload(false);
    }
  };

  const handleFinish = () => {
    setShowSuccessModal(false);
    onNavigateToMyReports();
  };

  const handleResetForNewReport = () => {
    handleRemovePhoto();
    pendingIdentityRef.current = null;
    inFlightSubmissionRef.current = null;
    setSubmissionPendingNotice(null);
    setReportMode('photo');
    setCategory('');
    setSeverity('');
    setTitle('');
    setDescription('');
    setAdditionalDetails('');
    setLocationAddress('');
    setCoords(null);
    setLocationWarning(null);
    setEditedFields({
      category: false,
      severity: false,
      title: false,
      description: false,
    });
    setCreatedReport(null);
    setShowSuccessModal(false);
    setErrorMessage(null);
    setCurrentStep(1);
  };

  const handleTopBack = () => {
    if (currentStep > 1) {
      setErrorMessage(null);
      setCurrentStep((prev) => (prev === 3 ? 2 : 1));
      return;
    }
    onCancel();
  };

  const friendlyPhotoTips = getFriendlyPhotoTips(imageQualityResult, imageVerification);
  const friendlyFindingHeadline = getFriendlyFindingHeadline(unifiedSuggestion, imageVerification);

  const STEPS: { id: WizardStep; label: string }[] = [
    { id: 1, label: 'Add Photo' },
    { id: 2, label: 'Confirm Issue' },
    { id: 3, label: 'Add Location' },
  ];

  const readableLocationSnippet = extractReadableLocationSnippet(locationAddress);
  const titleNeedsLocationSuggestion = Boolean(
    readableLocationSnippet &&
      contextualSuggestedTitle &&
      title.trim() !== contextualSuggestedTitle
  );

  return (
    <div className="bg-[#FAFBF9] dark:bg-[#0c1322] flex-1 w-full pb-12 text-slate-900 dark:text-slate-100 flex flex-col transition-colors">
      <div className="w-full max-w-3xl mx-auto px-0 sm:px-6 sm:pt-6 flex-1 flex flex-col">
        <div className="bg-white dark:bg-slate-900/90 sm:rounded-3xl sm:border sm:border-slate-200/80 sm:dark:border-slate-800 sm:shadow-xs flex-1 flex flex-col overflow-hidden">
          {/* Top Bar */}
          <div className="px-4 sm:px-6 pt-3.5 pb-3 flex items-center justify-between border-b border-slate-100 dark:border-slate-800">
            <button
              type="button"
              onClick={handleTopBack}
              className="min-w-[44px] min-h-[44px] -ml-2 flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
              aria-label={t('action.back')}
            >
              <ArrowLeft className="w-5 h-5" />
            </button>

            <div className="text-center">
              <span className="text-sm sm:text-base font-bold text-slate-900 dark:text-white tracking-tight block">
                {t('report.title')}
              </span>
              <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                Step {currentStep} of 3 · {STEPS[currentStep - 1].label}
              </span>
            </div>

            <div className="w-[44px]" />
          </div>

          {/* 3-Step Guided Progress Bar */}
          <nav aria-label="Complaint progress" className="px-4 sm:px-6 pt-3 pb-2 border-b border-slate-100 dark:border-slate-800/80 bg-slate-50/70 dark:bg-slate-900/40">
            <div className="grid grid-cols-3 gap-2">
          {STEPS.map((step) => {
            const isActive = currentStep === step.id;
            const isCompleted =
              (step.id === 1 && (Boolean(photoPreview) || reportMode === 'manual') && currentStep > 1) ||
              (step.id === 2 && isStep2Valid && currentStep > 2);
            const isReachable =
              step.id === 1 ||
              (step.id === 2 && (canLeaveStep1 || currentStep >= 2)) ||
              (step.id === 3 && ((canLeaveStep1 && isStep2Valid) || currentStep === 3));

            return (
              <button
                key={step.id}
                type="button"
                disabled={!isReachable}
                onClick={() => handleGoToStep(step.id)}
                className={`min-h-[44px] px-2 py-2 rounded-xl text-left transition-colors flex flex-col justify-center cursor-pointer disabled:cursor-not-allowed ${
                  isActive
                    ? 'bg-emerald-600 text-white shadow-2xs'
                    : isCompleted
                    ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-800/70'
                    : isReachable
                    ? 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800'
                    : 'bg-white/60 dark:bg-slate-900/40 text-slate-400 dark:text-slate-600 border border-slate-200/70 dark:border-slate-800/60'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={`w-4 h-4 rounded-full text-[10px] font-bold flex items-center justify-center shrink-0 ${
                      isActive
                        ? 'bg-white text-emerald-700'
                        : isCompleted
                        ? 'bg-emerald-600 text-white'
                        : 'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    {isCompleted ? <Check className="w-2.5 h-2.5" /> : step.id}
                  </span>
                  <span className="text-[11px] font-bold truncate">{step.label}</span>
                </div>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Hidden File & Camera Inputs for Issue Photo (JPG, PNG, WebP) */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/jpg,image/png,image/webp"
        onChange={handleFileChange}
        aria-label="Upload civic issue photo"
        className="sr-only"
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/jpeg,image/jpg,image/png,image/webp"
        capture="environment"
        onChange={handleFileChange}
        aria-label="Take civic issue photo"
        className="sr-only"
      />

      <form onSubmit={handleSubmit} className="p-4 sm:p-6 space-y-4 flex-1">
        {errorMessage && (
          <div
            role="alert"
            className="p-3 rounded-2xl bg-red-50 dark:bg-rose-950/40 border border-red-200 dark:border-rose-800 text-red-800 dark:text-rose-200 text-xs flex items-start gap-2"
          >
            <AlertCircle className="w-4 h-4 text-red-600 dark:text-rose-400 shrink-0 mt-0.5" />
            <span className="leading-relaxed">{errorMessage}</span>
          </div>
        )}
        {submissionPendingNotice && (
          <div
            role="status"
            className="p-3 rounded-2xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200 text-xs flex items-start gap-2"
          >
            <Loader2 className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5 animate-spin" />
            <span className="leading-relaxed">{submissionPendingNotice}</span>
          </div>
        )}

        {/* ================================================================ */}
        {/* STEP 1: SINGLE ISSUE PHOTO UPLOAD + MANUAL COMPLAINT OPTION      */}
        {/* ================================================================ */}
        {currentStep === 1 && (
          <div className="space-y-4">
            <div className="space-y-1">
              <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                Step 1 · Issue Photo
              </p>
              <h2 className="text-base font-bold text-slate-900 dark:text-white">
                Add a photo of the civic issue
              </h2>
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                Upload a clear photograph of the problem for automatic issue detection, or continue without a photo.
              </p>
            </div>

            {!photoPreview ? (
              <div className="rounded-3xl border border-slate-200 dark:border-slate-700 bg-emerald-50/35 dark:bg-emerald-950/15 p-5 sm:p-6 text-center space-y-4">
                <div className="w-12 h-12 rounded-2xl bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300 flex items-center justify-center mx-auto">
                  <Camera className="w-6 h-6" />
                </div>
                <div className="space-y-1 max-w-md mx-auto">
                  <p className="text-xs font-bold text-slate-900 dark:text-white">
                    Upload or capture issue photo
                  </p>
                  <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
                    Shows the problem as reported. Used for automatic category and severity suggestions.
                  </p>
                </div>

                <div className="flex flex-col sm:flex-row items-stretch justify-center gap-2.5 max-w-md mx-auto pt-1">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex-1 min-h-[44px] h-11 px-4 rounded-2xl bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white text-xs font-bold flex items-center justify-center gap-2 shadow-sm cursor-pointer transition-colors"
                  >
                    <UploadCloud className="w-4 h-4 shrink-0" />
                    <span>Upload Photo</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => cameraInputRef.current?.click()}
                    className="flex-1 min-h-[44px] h-11 px-4 rounded-2xl bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100 text-xs font-bold flex items-center justify-center gap-2 cursor-pointer transition-colors"
                  >
                    <Camera className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <span>Take Photo</span>
                  </button>
                </div>

                <p className="text-[10px] text-slate-500 dark:text-slate-400">
                  Accepts JPG, PNG, or WebP · Up to 5MB
                </p>

                {photoOptimizationError && (
                  <div
                    role="alert"
                    className="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-200 text-xs text-left flex items-start gap-2 max-w-md mx-auto"
                  >
                    <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                    <p className="text-[11px] leading-relaxed">{photoOptimizationError}</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-3xl border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 overflow-hidden flex flex-col justify-between">
                <div className="relative h-56 sm:h-64 w-full bg-slate-900/5 dark:bg-slate-950/40 flex items-center justify-center">
                  <img
                    src={photoPreview}
                    alt="Civic issue preview"
                    className="w-full h-full object-cover"
                  />
                  {isOptimizingPhoto && (
                    <div className="absolute top-2.5 left-2.5 px-2.5 py-1 rounded-lg bg-slate-900/85 text-white text-[11px] font-medium flex items-center gap-1.5">
                      <Loader2 className="w-3 h-3 animate-spin text-emerald-400" />
                      <span>Preparing photo...</span>
                    </div>
                  )}
                </div>

                {photoOptimizationError && (
                  <div
                    role="alert"
                    className="m-2.5 p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-200 text-[11px] flex items-start gap-2"
                  >
                    <AlertCircle className="w-3.5 h-3.5 text-rose-600 shrink-0 mt-0.5" />
                    <span>{photoOptimizationError}</span>
                  </div>
                )}

                <div className="p-2.5 bg-slate-50 dark:bg-slate-900/90 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="min-h-[44px] px-3 rounded-xl bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 text-xs font-bold text-slate-800 dark:text-slate-100 inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                    >
                      <UploadCloud className="w-3.5 h-3.5 text-emerald-600" />
                      <span>Replace</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => cameraInputRef.current?.click()}
                      className="min-h-[44px] px-3 rounded-xl bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 text-xs font-bold text-slate-800 dark:text-slate-100 inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                    >
                      <Camera className="w-3.5 h-3.5 text-emerald-600" />
                      <span>Retake</span>
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={handleRemovePhoto}
                    className="min-h-[44px] px-2.5 rounded-xl text-xs font-semibold text-rose-700 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 inline-flex items-center gap-1 cursor-pointer transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>{t('report.photoRemove')}</span>
                  </button>
                </div>
              </div>
            )}

            {photoPreview && (
              <div className="space-y-3.5">
                {/* Duplicate Photo Advisory */}
                {duplicatePhotoCheck?.isDuplicate && (
                  <div className="p-3 rounded-2xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-amber-950 dark:text-amber-200 text-xs flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    <p className="text-[11px] leading-relaxed">
                      This photo matches an earlier complaint (
                      <span className="font-mono font-semibold">
                        {duplicatePhotoCheck.matchingTrackingNumber || 'Previous Report'}
                      </span>
                      ). If this is a new problem, taking a fresh photo is best.
                    </p>
                  </div>
                )}

                {/* Friendly Loading State */}
                {isVerifyingImage && (
                  <div className="p-4 rounded-2xl bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/70 flex items-center gap-3">
                    <Loader2 className="w-5 h-5 animate-spin text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <div>
                      <p className="text-xs font-bold text-slate-900 dark:text-white">
                        Looking at your photo...
                      </p>
                      <p className="text-[11px] text-slate-600 dark:text-slate-300 mt-0.5">
                        Identifying what the issue is so you can review and edit it easily.
                      </p>
                    </div>
                  </div>
                )}

                {/* Friendly Photo Improvement Guidance when unclear */}
                {!isInspectingPhoto && friendlyPhotoTips.length > 0 && (
                  <div className="p-3.5 rounded-2xl bg-amber-50/90 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-amber-950 dark:text-amber-200 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <Info className="w-4 h-4 text-amber-600 shrink-0" />
                      <span className="text-xs font-bold">How to get a clearer photo</span>
                    </div>
                    <ul className="space-y-1 text-[11px] leading-relaxed pl-6 list-disc">
                      {friendlyPhotoTips.map((tip, idx) => (
                        <li key={idx}>{tip}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Error / Fallback State — Never blocks manual continuation */}
                {(imageVerifyError || unifiedSuggestion?.isFallback) &&
                  !isVerifyingImage && (
                    <div className="p-4 rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-950 dark:text-amber-200 space-y-3">
                      <div className="flex items-start gap-2.5">
                        <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                        <div className="text-xs space-y-1">
                          <p className="font-bold">We could not check your photo automatically</p>
                          <p className="text-[11px] leading-relaxed">
                            {imageVerifyError ||
                              'No problem — you can try checking again or choose the category and details yourself on the next step.'}
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={handleRetryPhotoAnalysis}
                          className="min-h-[44px] px-3.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold cursor-pointer inline-flex items-center gap-1.5"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          <span>Try Again</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleGoToStep(2)}
                          className="min-h-[44px] px-3.5 rounded-xl bg-white dark:bg-slate-800 border border-amber-300 dark:border-amber-700 text-amber-950 dark:text-amber-100 text-xs font-bold cursor-pointer inline-flex items-center gap-1.5"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                          <span>Choose Category Manually</span>
                        </button>
                      </div>
                    </div>
                  )}

                {/* Unrelated Image Friendly Guardrail */}
                {imageVerification &&
                  !imageVerification.isFallback &&
                  imageVerification.decision === 'UNRELATED_IMAGE' &&
                  !isVerifyingImage && (
                    <div className="p-4 rounded-2xl border border-rose-200 dark:border-rose-800 bg-rose-50/80 dark:bg-rose-950/35 text-rose-950 dark:text-rose-100 space-y-3 text-xs">
                      <div className="flex items-start gap-2.5">
                        <ShieldAlert className="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
                        <div className="space-y-1">
                          <p className="font-bold">
                            This photo does not appear to show a neighborhood issue.
                          </p>
                          <p className="text-[11px] leading-relaxed opacity-90">
                            Please upload a clearer photo of the problem, or switch to a manual complaint without this photo.
                          </p>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="min-h-[44px] px-3.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold cursor-pointer inline-flex items-center gap-1.5"
                        >
                          <UploadCloud className="w-3.5 h-3.5" />
                          <span>Choose Different Photo</span>
                        </button>
                        <button
                          type="button"
                          onClick={handleChooseManualReport}
                          className="min-h-[44px] px-3.5 rounded-xl bg-white dark:bg-slate-800 border border-rose-300 dark:border-rose-700 text-rose-900 dark:text-rose-200 text-xs font-bold cursor-pointer"
                        >
                          Submit Without Photo
                        </button>
                      </div>

                      <label className="flex items-start gap-2.5 text-[11px] text-rose-900 dark:text-rose-200 cursor-pointer pt-1">
                        <input
                          type="checkbox"
                          checked={unrelatedOverrideConfirmed}
                          onChange={(e) => setUnrelatedOverrideConfirmed(e.target.checked)}
                          className="mt-0.5 w-4 h-4 accent-rose-600"
                        />
                        <span>
                          This photo really shows a civic problem — let me continue and review it manually.
                        </span>
                      </label>
                    </div>
                  )}

                {/* Friendly Detection Result Card on Step 1 */}
                {unifiedSuggestion &&
                  !unifiedSuggestion.isFallback &&
                  !unifiedSuggestion.isUnrelatedImage &&
                  !isVerifyingImage && (
                    <div className="p-4 rounded-2xl border border-emerald-200 dark:border-emerald-800/70 bg-emerald-50/50 dark:bg-emerald-950/25 text-xs space-y-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-2">
                          <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                          <div className="space-y-1">
                            <p className="font-bold text-slate-900 dark:text-white leading-snug">
                              {friendlyFindingHeadline}
                            </p>
                            <p className="text-[11px] text-slate-600 dark:text-slate-300">
                              You can confirm or change any detail on the next step.
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
              </div>
            )}

            {photoPreview ? (
              <button
                type="button"
                onClick={() => handleGoToStep(2)}
                disabled={!canLeaveStep1}
                className="w-full min-h-[48px] h-12 rounded-2xl bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 disabled:opacity-50 text-white font-bold text-sm flex items-center justify-center gap-2 shadow-sm cursor-pointer disabled:cursor-not-allowed transition-colors"
              >
                <span>Next: Confirm Issue</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            ) : (
              /* Manual Complaint Option Without a Photo */
              <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 p-4 space-y-2.5">
                <div className="flex items-start gap-2.5">
                  <FileText className="w-4 h-4 text-slate-500 dark:text-slate-400 shrink-0 mt-0.5" />
                  <div className="space-y-0.5">
                    <p className="text-xs font-bold text-slate-900 dark:text-white">
                      No photo right now?
                    </p>
                    <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
                      You can still submit a complaint by choosing the category and describing what happened.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleChooseManualReport}
                  className="w-full min-h-[44px] h-11 px-4 rounded-xl bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100 text-xs font-bold flex items-center justify-center gap-2 cursor-pointer transition-colors"
                >
                  <span>Continue without a photo</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        )}

        {/* ================================================================ */}
        {/* STEP 2: CONFIRM ISSUE (CATEGORY, SEVERITY, TITLE, DESCRIPTION)   */}
        {/* ================================================================ */}
        {currentStep === 2 && (
          <div className="space-y-4">
            {/* Compact Context Banner */}
            {photoPreview && reportMode === 'photo' ? (
              <div className="p-3.5 rounded-2xl border border-emerald-200 dark:border-emerald-800/70 bg-emerald-50/40 dark:bg-emerald-950/25 space-y-2.5">
                <div className="flex items-center gap-3">
                  <img
                    src={photoPreview}
                    alt="Issue thumbnail"
                    className="w-12 h-12 rounded-xl object-cover border border-slate-200 dark:border-slate-700 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold text-slate-900 dark:text-white leading-snug flex items-center gap-1.5">
                      {isVerifyingImage && (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600 dark:text-emerald-400 shrink-0" />
                      )}
                      <span>
                        {isVerifyingImage
                          ? 'Looking at your photo...'
                          : unifiedSuggestion && !unifiedSuggestion.isFallback
                          ? friendlyFindingHeadline
                          : 'Choose the category and describe the issue below.'}
                      </span>
                    </p>
                    <p className="text-[11px] text-slate-600 dark:text-slate-300 mt-0.5">
                      {isVerifyingImage
                        ? 'Checking visible details — you can also edit any field while this finishes.'
                        : unifiedSuggestion && !unifiedSuggestion.isFallback
                        ? `Suggested category: ${unifiedSuggestion.suggestedCategory || 'Select manually'} · You have final say`
                        : 'Edit any field freely.'}
                    </p>
                  </div>
                </div>

                {/* Step 2 Photo Analysis Error / Retry Banner */}
                {(imageVerifyError || unifiedSuggestion?.isFallback) && !isVerifyingImage && (
                  <div className="pt-2 border-t border-amber-200/80 dark:border-amber-800/60 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[11px] text-amber-900 dark:text-amber-200 flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                      <span>
                        {imageVerifyError ||
                          'Automatic photo analysis could not finish. You can try again or fill in details manually.'}
                      </span>
                    </p>
                    <button
                      type="button"
                      onClick={handleRetryPhotoAnalysis}
                      className="min-h-[36px] px-3 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-bold cursor-pointer inline-flex items-center gap-1.5 shrink-0"
                    >
                      <RefreshCw className="w-3 h-3" />
                      <span>Try Again</span>
                    </button>
                  </div>
                )}

                {/* Optional expandable AI explanation / one-tap Apply controls (no nested boxes) */}
                {unifiedSuggestion && !unifiedSuggestion.isFallback && !unifiedSuggestion.isUnrelatedImage && (
                  <div className="pt-2 border-t border-emerald-200/70 dark:border-emerald-800/50 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => setShowAiDetails((prev) => !prev)}
                        className="text-[11px] font-semibold text-emerald-800 dark:text-emerald-300 hover:underline flex items-center gap-1 cursor-pointer py-1"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>{showAiDetails ? 'Hide photo notes' : 'See what we noticed in the photo'}</span>
                      </button>

                      {(unifiedSuggestion.suggestedCategory !== category ||
                        unifiedSuggestion.suggestedSeverity !== severity ||
                        (unifiedSuggestion.suggestedDescription &&
                          description.trim() !== unifiedSuggestion.suggestedDescription.trim())) && (
                        <button
                          type="button"
                          onClick={handleApplyAllAiSuggestions}
                          className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-bold cursor-pointer"
                        >
                          Use Suggested Details
                        </button>
                      )}
                    </div>

                    {showAiDetails && (
                      <div className="space-y-2 text-[11px] text-slate-700 dark:text-slate-300 pt-1">
                        {unifiedSuggestion.shortExplanation && (
                          <p className="leading-relaxed">{unifiedSuggestion.shortExplanation}</p>
                        )}
                        {unifiedSuggestion.severityReason && (
                          <p className="leading-relaxed">
                            <span className="font-semibold text-slate-900 dark:text-white">Urgency note: </span>
                            {unifiedSuggestion.severityReason}
                          </p>
                        )}
                        {unifiedSuggestion.visibleObservations.length > 0 && (
                          <ul className="list-disc list-inside space-y-0.5">
                            {unifiedSuggestion.visibleObservations.map((obs, idx) => (
                              <li key={idx}>{obs}</li>
                            ))}
                          </ul>
                        )}
                        <div className="flex flex-wrap gap-2 pt-1">
                          {unifiedSuggestion.suggestedCategory &&
                            unifiedSuggestion.suggestedCategory !== category && (
                              <button
                                type="button"
                                onClick={handleApplyAiCategory}
                                className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-[11px] font-semibold cursor-pointer"
                              >
                                Use Category: {unifiedSuggestion.suggestedCategory}
                              </button>
                            )}
                          {unifiedSuggestion.suggestedSeverity !== severity && (
                            <button
                              type="button"
                              onClick={handleApplyAiSeverity}
                              className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-[11px] font-semibold cursor-pointer"
                            >
                              Use Severity: {unifiedSuggestion.suggestedSeverity}
                            </button>
                          )}
                          {unifiedSuggestion.suggestedTitle &&
                            title.trim() !== unifiedSuggestion.suggestedTitle.trim() && (
                              <button
                                type="button"
                                onClick={handleApplyAiTitle}
                                className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-[11px] font-semibold cursor-pointer"
                              >
                                Use Suggested Title
                              </button>
                            )}
                          {unifiedSuggestion.suggestedDescription &&
                            description.trim() !== unifiedSuggestion.suggestedDescription.trim() && (
                              <button
                                type="button"
                                onClick={handleApplyAiDescription}
                                className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-[11px] font-semibold cursor-pointer"
                              >
                                Use Suggested Description
                              </button>
                            )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="p-3.5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 flex items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <p className="text-xs font-bold text-slate-900 dark:text-white">
                    Manual complaint (no photo)
                  </p>
                  <p className="text-[11px] text-slate-600 dark:text-slate-300">
                    Choose a category and describe the issue clearly.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleGoToStep(1)}
                  className="min-h-[40px] px-3 rounded-xl bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-[11px] font-bold text-emerald-700 dark:text-emerald-400 shrink-0 cursor-pointer"
                >
                  Add Photo
                </button>
              </div>
            )}

            {/* Stale Suggestion Banner */}
            {isAiSuggestionStale && (
              <div className="px-3 py-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200 text-[11px] flex flex-wrap items-center justify-between gap-2">
                <span>You changed the details since our last check.</span>
                <button
                  type="button"
                  onClick={() => handleAnalyzeWithAi(true)}
                  disabled={isAnalyzingAi}
                  className="font-bold underline cursor-pointer"
                >
                  {isAnalyzingAi ? 'Checking...' : 'Update suggestions'}
                </button>
              </div>
            )}

            {aiNotice && (
              <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-[11px] text-slate-700 dark:text-slate-200 flex items-start gap-2">
                <Info className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
                <span>{aiNotice.message}</span>
              </div>
            )}

            {/* Category (All 8 Canonical Categories — Always editable) */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                {t('report.selectCategory')} <span className="text-rose-600">*</span>
              </label>
              <select
                value={category}
                onChange={(e) => {
                  const val = e.target.value;
                  const nextCat = val ? normalizeCivicCategory(val) : '';
                  setCategory(nextCat);
                  setEditedFields((prev) => ({ ...prev, category: true }));
                  if (nextCat && !editedFields.title) {
                    syncLocationIntoTitleIfUnedited(locationAddress, nextCat);
                  }
                }}
                className="w-full h-11 px-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-xs font-semibold text-slate-900 dark:text-slate-100 focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600 cursor-pointer"
              >
                <option value="" disabled>
                  Choose an issue category...
                </option>
                {CATEGORY_LIST.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Severity */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                How urgent is it? <span className="text-rose-600">*</span>
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(['Low', 'Medium', 'High'] as const).map((level) => {
                  const isSelected = severity === level;
                  const activeClasses =
                    level === 'High'
                      ? 'border-rose-500 bg-rose-50 dark:bg-rose-950/50 text-rose-800 dark:text-rose-200 font-bold'
                      : level === 'Medium'
                      ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/50 text-amber-800 dark:text-amber-200 font-bold'
                      : 'border-emerald-600 bg-emerald-50 dark:bg-emerald-950/50 text-emerald-800 dark:text-emerald-200 font-bold';
                  const labelText =
                    level === 'Low'
                      ? t('report.severity.low')
                      : level === 'Medium'
                      ? t('report.severity.medium')
                      : t('report.severity.high');
                  return (
                    <button
                      key={level}
                      type="button"
                      onClick={() => {
                        setSeverity(level);
                        setEditedFields((prev) => ({ ...prev, severity: true }));
                      }}
                      className={`min-h-[44px] h-11 rounded-xl text-xs border transition-colors cursor-pointer ${
                        isSelected
                          ? activeClasses
                          : 'border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 font-semibold'
                      }`}
                    >
                      {labelText}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Complaint Title (Editable + Smart Location-Aware Suggestion) */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Complaint Title
                </label>
                <span className="text-[10px] text-slate-400 dark:text-slate-500">
                  {title.length}/120
                </span>
              </div>
              <input
                type="text"
                maxLength={120}
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setEditedFields((prev) => ({ ...prev, title: true }));
                }}
                placeholder={t('report.issueTitlePlaceholder')}
                className="w-full h-11 px-3.5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600"
              />
              {contextualSuggestedTitle && title.trim() !== contextualSuggestedTitle && (
                <button
                  type="button"
                  onClick={() => {
                    setTitle(contextualSuggestedTitle);
                    setEditedFields((prev) => ({ ...prev, title: false }));
                  }}
                  className="mt-1.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer text-left"
                >
                  Use suggested title: &ldquo;{contextualSuggestedTitle}&rdquo;
                </button>
              )}
            </div>

            {/* Description */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  What happened? <span className="text-rose-600">*</span>
                </label>
                <button
                  type="button"
                  onClick={() => handleAnalyzeWithAi(false)}
                  disabled={isAnalyzingAi || isVerifyingImage || (!description.trim() && !photoPreview)}
                  className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 hover:underline disabled:opacity-50 flex items-center gap-1 cursor-pointer"
                >
                  {isAnalyzingAi ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin text-emerald-600" />
                      <span>Checking...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-3 h-3 text-emerald-600" />
                      <span>Suggest from details</span>
                    </>
                  )}
                </button>
              </div>
              <textarea
                rows={3}
                maxLength={500}
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  setEditedFields((prev) => ({ ...prev, description: true }));
                }}
                placeholder={t('report.descriptionPlaceholder')}
                className="w-full p-3.5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600 resize-none"
              />
              <div className="flex items-center justify-between text-[10px] text-slate-400 pt-0.5 px-1">
                <span>Minimum 10 characters</span>
                <span>{description.length}/500</span>
              </div>
            </div>

            {/* Optional Extra Notes */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Extra Notes (Optional)
                </label>
                <span className="text-[10px] text-slate-400 dark:text-slate-500">
                  {additionalDetails.length}/250
                </span>
              </div>
              <textarea
                rows={2}
                maxLength={250}
                value={additionalDetails}
                onChange={(e) => setAdditionalDetails(e.target.value)}
                placeholder="Anything else officers should know (e.g., near a school gate, ongoing for 3 days)..."
                className="w-full p-3.5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600 resize-none"
              />
            </div>

            {/* Collapsed Optional Civic Tips */}
            {category && (
              <CivicAwarenessInfoCard
                category={category}
                subType={imageVerification?.visualSubType}
                defaultExpanded={false}
              />
            )}

            {/* Step 2 Navigation Footer */}
            <div className="flex items-center gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => handleGoToStep(1)}
                className="min-h-[48px] h-12 px-4 rounded-2xl bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100 text-xs font-bold cursor-pointer transition-colors"
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => handleGoToStep(3)}
                className="flex-1 min-h-[48px] h-12 px-5 rounded-2xl bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white text-sm font-bold flex items-center justify-center gap-2 shadow-sm cursor-pointer transition-colors"
              >
                <span>Next: Add Location</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* ================================================================ */}
        {/* STEP 3: ADD LOCATION & REVIEW BEFORE SUBMIT                      */}
        {/* ================================================================ */}
        {currentStep === 3 && (
          <div className="space-y-4">
            <div className="space-y-1">
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                Where is this problem located?
              </h2>
              <p className="text-xs text-slate-600 dark:text-slate-300">
                Choose your current location, pin it on the map, or type the address below.
              </p>
            </div>

            {/* 3 Clear Location Options */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <button
                type="button"
                onClick={handleUseGps}
                disabled={isLocating}
                className="min-h-[44px] h-11 px-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center justify-center gap-2 cursor-pointer transition-colors disabled:opacity-70"
              >
                {isLocating ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Crosshair className="w-4 h-4" />
                )}
                <span>{isLocating ? 'Locating...' : 'Use Current Location'}</span>
              </button>

              <button
                type="button"
                onClick={() => setIsMapPickerOpen(true)}
                className="min-h-[44px] h-11 px-3.5 rounded-xl bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100 text-xs font-bold flex items-center justify-center gap-2 cursor-pointer transition-colors"
              >
                <MapPin className="w-4 h-4 text-emerald-600" />
                <span>Pick on Map</span>
              </button>

              <button
                type="button"
                onClick={() => manualAddressInputRef.current?.focus()}
                className="min-h-[44px] h-11 px-3.5 rounded-xl bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100 text-xs font-bold flex items-center justify-center gap-2 cursor-pointer transition-colors"
              >
                <Edit3 className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                <span>Manual Address</span>
              </button>
            </div>

            {/* Address / Landmark Input */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Street Address or Nearby Landmark <span className="text-rose-600">*</span>
              </label>
              <div className="relative">
                <MapPin className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5 pointer-events-none" />
                <input
                  ref={manualAddressInputRef}
                  type="text"
                  required
                  value={locationAddress}
                  onChange={(e) => {
                    const nextAddr = e.target.value;
                    setLocationAddress(nextAddr);
                    syncLocationIntoTitleIfUnedited(nextAddr);
                  }}
                  placeholder={t('report.locationPlaceholder')}
                  className="w-full h-11 pl-10 pr-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600"
                />
              </div>

              {locationWarning && (
                <div className="mt-2 p-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200 text-[11px] flex items-start gap-1.5">
                  <Info className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
                  <span>{locationWarning}</span>
                </div>
              )}
            </div>

            {/* Selected Location Confirmation Box */}
            {(locationAddress.trim() || coords) && (
              <div className="p-3.5 rounded-2xl bg-emerald-50/60 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/70 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-emerald-900 dark:text-emerald-200 flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                    <span>Selected Location</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => manualAddressInputRef.current?.focus()}
                    className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer"
                  >
                    Edit Address
                  </button>
                </div>
                <p className="text-xs text-slate-800 dark:text-slate-100 leading-relaxed">
                  {locationAddress.trim() || 'Pin dropped on map'}
                </p>
                {coords && (
                  <p className="text-[11px] text-emerald-700 dark:text-emerald-400">
                    Device or map location attached
                  </p>
                )}
              </div>
            )}

            {/* Quick Title Update Helper if location adds useful context */}
            {titleNeedsLocationSuggestion && (
              <div className="p-3 rounded-2xl bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="text-[11px] text-slate-600 dark:text-slate-300">
                  Suggested title: <strong className="text-slate-900 dark:text-white">{contextualSuggestedTitle}</strong>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setTitle(contextualSuggestedTitle);
                    setEditedFields((prev) => ({ ...prev, title: true }));
                  }}
                  className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-bold cursor-pointer"
                >
                  Use Title
                </button>
              </div>
            )}

            {/* Compact Final Complaint Summary */}
            <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800 space-y-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                  <ClipboardCheck className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Complaint Summary</span>
                </span>
                <button
                  type="button"
                  onClick={() => handleGoToStep(2)}
                  className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer"
                >
                  Edit Details
                </button>
              </div>

              <div className="flex items-start gap-3">
                {photoPreview ? (
                  <img
                    src={photoPreview}
                    alt="Complaint evidence thumbnail"
                    className="w-14 h-14 rounded-xl object-cover border border-slate-200 dark:border-slate-700 shrink-0"
                  />
                ) : (
                  <div className="w-14 h-14 rounded-xl bg-slate-200/70 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 flex items-center justify-center text-slate-500 dark:text-slate-400 shrink-0">
                    <FileText className="w-5 h-5" />
                  </div>
                )}

                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-bold text-slate-900 dark:text-white leading-snug">
                    {title.trim() ||
                      contextualSuggestedTitle ||
                      `${category || 'Civic'} Issue`}
                  </p>
                  <p className="text-[11px] text-slate-600 dark:text-slate-300">
                    {category} · Severity:{' '}
                    <span
                      className={
                        severity === 'High'
                          ? 'text-rose-600 dark:text-rose-400 font-bold'
                          : severity === 'Medium'
                          ? 'text-amber-600 dark:text-amber-400 font-bold'
                          : 'text-emerald-600 dark:text-emerald-400 font-bold'
                      }
                    >
                      {severity}
                    </span>
                  </p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    Department: {getDepartmentForCategory(category)}
                  </p>
                </div>
              </div>

              <p className="text-[11px] text-slate-700 dark:text-slate-300 leading-relaxed pt-2 border-t border-slate-200 dark:border-slate-800">
                {combinedDescription}
              </p>
            </div>

            {/* Step 3 Footer: Back & Submit */}
            <div className="flex items-center gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => handleGoToStep(2)}
                className="min-h-[48px] h-12 px-4 rounded-2xl bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100 text-xs font-bold cursor-pointer transition-colors"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="flex-1 min-h-[48px] h-12 rounded-2xl bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 disabled:opacity-70 text-white font-bold text-sm flex items-center justify-center gap-2 shadow-md shadow-emerald-900/15 active:scale-[0.99] transition-all cursor-pointer disabled:cursor-not-allowed"
              >
                {isSubmitting ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>{t('action.submitting')}</span>
                  </span>
                ) : submissionPendingNotice ? (
                  <span>Check Submission Status</span>
                ) : (
                  <span>Submit Complaint</span>
                )}
              </button>
            </div>
          </div>
        )}
      </form>
        </div>
      </div>

      {/* Submission Success Screen */}
      {showSuccessModal && createdReport && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-3xl p-5 max-w-sm w-full text-center shadow-xl border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100">
            {cloudSyncSuccess ? (
              <div className="w-14 h-14 rounded-full bg-emerald-100 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mx-auto mb-3">
                <CheckCircle2 className="w-8 h-8" />
              </div>
            ) : syncNotice?.includes('saving on this device also failed') ? (
              <div className="w-14 h-14 rounded-full bg-rose-100 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 flex items-center justify-center mx-auto mb-3">
                <AlertCircle className="w-8 h-8" />
              </div>
            ) : (
              <div className="w-14 h-14 rounded-full bg-amber-100 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center mx-auto mb-3">
                <HardDrive className="w-8 h-8" />
              </div>
            )}

            <h2 className="text-base font-bold mb-1">
              {cloudSyncSuccess
                ? 'Complaint Submitted!'
                : syncNotice?.includes('saving on this device also failed')
                ? 'Storage Warning — Action Required'
                : 'Saved Offline — Pending Online Upload'}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
              {cloudSyncSuccess
                ? 'Your complaint has been sent to the municipal team. Save your complaint ID below:'
                : syncNotice?.includes('saving on this device also failed')
                ? 'Your complaint could not be saved on this device. Please free up space and try again:'
                : 'Your complaint is saved on this device and will upload automatically when you are back online:'}
            </p>

            <div
              className={`px-3 py-2.5 rounded-xl border mb-3 ${
                cloudSyncSuccess
                  ? 'bg-emerald-50 dark:bg-emerald-950/50 border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-300'
                  : syncNotice?.includes('saving on this device also failed')
                  ? 'bg-rose-50 dark:bg-rose-950/50 border-rose-200 dark:border-rose-800 text-rose-900 dark:text-rose-300'
                  : 'bg-amber-50 dark:bg-amber-950/50 border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-300'
              }`}
            >
              <span className="block text-[10px] uppercase tracking-wider font-semibold opacity-75">
                Complaint ID
              </span>
              <span className="font-mono font-bold text-sm">{createdReport.trackingNumber}</span>
            </div>

            {cloudSyncSuccess ? (
              <div className="mb-4 p-2.5 rounded-xl bg-emerald-50/80 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300 text-[11px] flex items-center gap-2 text-left">
                <Cloud className="w-4 h-4 text-emerald-600 shrink-0" />
                <div>
                  <span className="font-semibold block">Received by Municipality</span>
                  <span className="text-[10px] text-emerald-700 dark:text-emerald-400">
                    {retrySuccessMessage || 'Synced to your account for live status updates.'}
                  </span>
                </div>
              </div>
            ) : syncNotice?.includes('saving on this device also failed') ? (
              <div className="space-y-2 mb-4 text-left">
                <div className="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300 text-[11px] flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold block">Could not save offline</span>
                    <p className="text-[10px] text-rose-700 dark:text-rose-400 mt-0.5 leading-relaxed">
                      {syncNotice}
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-2 mb-4 text-left">
                <div className="p-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 text-[11px] flex items-start gap-2">
                  <HardDrive className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold block">Saved on This Device</span>
                    <p className="text-[10px] text-amber-700 dark:text-amber-400 mt-0.5">
                      {syncNotice || 'Will sync automatically when internet connection is restored.'}
                    </p>
                  </div>
                </div>

                {retryError && (
                  <div className="p-2 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300 text-[10px] flex items-start gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5 text-rose-600 shrink-0 mt-0.5" />
                    <span>{retryError}</span>
                  </div>
                )}
              </div>
            )}

            <div className="space-y-2">
              {!cloudSyncSuccess && (
                <button
                  type="button"
                  onClick={handleRetryUpload}
                  disabled={isRetryingUpload}
                  className="w-full min-h-[44px] h-11 rounded-xl bg-amber-600 hover:bg-amber-500 active:bg-amber-700 disabled:opacity-60 text-white font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer shadow-sm transition-all"
                >
                  {isRetryingUpload ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>{t('report.retryingUpload')}</span>
                    </>
                  ) : (
                    <>
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>{t('report.retryUpload')}</span>
                    </>
                  )}
                </button>
              )}

              <button
                type="button"
                onClick={handleFinish}
                className="w-full min-h-[44px] h-11 rounded-xl font-bold text-xs cursor-pointer shadow-sm transition-all bg-emerald-600 hover:bg-emerald-500 text-white"
              >
                View Complaint Status
              </button>

              <button
                type="button"
                onClick={handleResetForNewReport}
                className="w-full min-h-[44px] h-11 rounded-xl font-semibold text-xs cursor-pointer transition-colors bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200"
              >
                Submit Another Complaint
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Interactive OpenStreetMap + Leaflet Location Picker Modal */}
      <LocationPickerModal
        isOpen={isMapPickerOpen}
        onClose={() => setIsMapPickerOpen(false)}
        initialCoords={coords}
        initialAddress={locationAddress}
        onConfirmLocation={(newCoords, newAddress) => {
          setCoords(newCoords);
          const resolvedAddress =
            newAddress?.trim() ||
            (newCoords && (!locationAddress.trim() || locationAddress.startsWith('Detected GPS:'))
              ? 'Current device location (GPS)'
              : locationAddress);
          setLocationAddress(resolvedAddress);
          syncLocationIntoTitleIfUnedited(resolvedAddress);
          setLocationWarning(null);
        }}
      />
    </div>
  );
};
