import type { CivicIssueReport } from '../types/civic';

export interface TextValidationOptions {
  fieldLabel?: string;
  minLength?: number;
  maxLength?: number;
  required?: boolean;
  allowShortConcise?: boolean;
}

export interface TextValidationResult {
  valid: boolean;
  trimmed: string;
  error?: string;
}

export interface TextQualityAssessment {
  isSuspicious: boolean;
  reasons: string[];
  safeDisplay: string;
}

export interface ReportDataQualityAssessment {
  isSuspicious: boolean;
  reasons: string[];
  titleSuspicious: boolean;
  descriptionSuspicious: boolean;
}

// Common keyboard rows and test placeholder tokens (all lowercase)
const KEYBOARD_RUNS = [
  'qwerty',
  'qwert',
  'wertyu',
  'ertyui',
  'rtyuio',
  'tyuiop',
  'qwertyui',
  'asdfgh',
  'asdfg',
  'sdfghj',
  'dfghjk',
  'fghjkl',
  'zxcvbn',
  'zxcvb',
  'xcvbnm',
  'qazwsx',
  'wsxedc',
  'poiuy',
  'lkjhg',
  'mnbvc',
  '123456',
  'abcdef',
];

const PLACEHOLDER_EXACT_TOKENS = new Set([
  'test',
  'testing',
  'test123',
  'asdf',
  'asdfgh',
  'qwerty',
  'qwertyui',
  'zxcvbn',
  'xyz',
  'abc',
  'abcd',
  'none',
  'na',
  'n/a',
  'nil',
  'null',
  'undefined',
  'dummy',
  'sample',
  'foo',
  'bar',
  'foobar',
  'blah',
  'lol',
  'hjkl',
  'check',
]);

/**
 * Checks whether an individual word looks like random keyboard mash or repetitive test junk.
 */
function isSuspiciousWordToken(rawToken: string): boolean {
  const token = rawToken.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!token) return false;

  if (PLACEHOLDER_EXACT_TOKENS.has(token)) {
    return true;
  }

  for (const run of KEYBOARD_RUNS) {
    if (token.includes(run)) {
      return true;
    }
  }

  // Same character repeated 4+ times inside a word (e.g., "aaaaaa", "xxxxxx")
  if (/(.)\1{3,}/.test(token)) {
    return true;
  }

  // Long unbroken alphabetic token (>= 8 letters) without normal English/Indic-romanized vowel rhythm
  if (/^[a-z]{8,}$/.test(token)) {
    const vowels = (token.match(/[aeiouy]/g) || []).length;
    const uniqueChars = new Set(token).size;
    if (vowels === 0 || (uniqueChars <= 3 && token.length >= 6)) {
      return true;
    }
    // High consonant cluster (>= 6 consonants in a row)
    if (/[bcdfghjklmnpqrstvwxz]{6,}/.test(token)) {
      return true;
    }
  }

  return false;
}

/**
 * Assesses whether a single piece of text (title, description, note, remark, etc.)
 * is suspicious test/gibberish data without modifying or deleting source records.
 */
export function assessTextEntryQuality(rawText: string | null | undefined): TextQualityAssessment {
  const trimmed = typeof rawText === 'string' ? rawText.trim() : '';
  if (!trimmed) {
    return {
      isSuspicious: false,
      reasons: [],
      safeDisplay: '',
    };
  }

  const reasons: string[] = [];
  const compact = trimmed.replace(/\s+/g, '');

  // Entire string made of symbols/digits only (without letters from any script)
  const hasLetters = /[\p{L}]/u.test(trimmed);
  if (!hasLetters) {
    reasons.push('Contains no descriptive words');
  }

  // Entire string has low unique character diversity relative to length
  if (compact.length >= 6 && new Set(compact.toLowerCase()).size <= 2) {
    reasons.push('Repeated single-character input');
  }

  const words = trimmed
    .split(/\s+/)
    .map((w) => w.replace(/^[^a-zA-Z0-9\p{L}]+|[^a-zA-Z0-9\p{L}]+$/gu, ''))
    .filter(Boolean);

  if (words.length > 0) {
    const suspiciousWords = words.filter((w) => isSuspiciousWordToken(w));
    const singleShortTest =
      words.length === 1 && PLACEHOLDER_EXACT_TOKENS.has(words[0].toLowerCase());

    if (singleShortTest) {
      reasons.push(`Placeholder test input ("${trimmed.slice(0, 24)}")`);
    } else if (suspiciousWords.length > 0 && suspiciousWords.length >= Math.ceil(words.length / 2)) {
      reasons.push('Keyboard-mash or test characters detected');
    }
  }

  return {
    isSuspicious: reasons.length > 0,
    reasons,
    safeDisplay:
      reasons.length > 0
        ? '[Flagged test/placeholder input — review record before action]'
        : trimmed,
  };
}

/**
 * Validates citizen or municipal input before submission/saving.
 * Blocks empty/gibberish/test inputs while allowing concise legitimate municipal phrases.
 */
export function validateMeaningfulCivicText(
  value: string | null | undefined,
  options: TextValidationOptions = {}
): TextValidationResult {
  const {
    fieldLabel = 'Text',
    minLength = 5,
    maxLength = 1000,
    required = false,
    allowShortConcise = false,
  } = options;

  const trimmed = typeof value === 'string' ? value.trim() : '';

  if (!trimmed) {
    if (required) {
      return {
        valid: false,
        trimmed: '',
        error: `${fieldLabel} is required.`,
      };
    }
    return { valid: true, trimmed: '' };
  }

  if (trimmed.length < minLength) {
    return {
      valid: false,
      trimmed,
      error: `${fieldLabel} must be at least ${minLength} characters long.`,
    };
  }

  if (trimmed.length > maxLength) {
    return {
      valid: false,
      trimmed,
      error: `${fieldLabel} must not exceed ${maxLength} characters.`,
    };
  }

  // Must contain alphabetic characters (any Unicode script supported for multi-language users)
  if (!/[\p{L}]{2,}/u.test(trimmed)) {
    return {
      valid: false,
      trimmed,
      error: `Please enter meaningful words for ${fieldLabel.toLowerCase()}.`,
    };
  }

  const assessment = assessTextEntryQuality(trimmed);
  if (assessment.isSuspicious) {
    // Allow concise legitimate status/note words if allowShortConcise is enabled and not a keyboard run
    const lower = trimmed.toLowerCase();
    const isKeyboardRun = KEYBOARD_RUNS.some((run) => lower.includes(run));
    const isSingleJunk = PLACEHOLDER_EXACT_TOKENS.has(lower);
    if (!allowShortConcise || isKeyboardRun || isSingleJunk) {
      return {
        valid: false,
        trimmed,
        error: `${fieldLabel} appears to contain placeholder or random characters. Please enter clear details.`,
      };
    }
  }

  return { valid: true, trimmed };
}

/**
 * Validates municipal officer / inspector display names entered by admins.
 */
export function validateOfficerName(value: string | null | undefined): TextValidationResult {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    return { valid: true, trimmed: '' };
  }
  return validateMeaningfulCivicText(trimmed, {
    fieldLabel: 'Assigned Officer name',
    minLength: 2,
    maxLength: 100,
    required: false,
    allowShortConcise: true,
  });
}

/**
 * Non-destructively evaluates an existing complaint record for test/invalid content
 * so administrators can filter and review flagged complaints without deleting Firestore data.
 */
export function assessReportDataQuality(
  report: Pick<CivicIssueReport, 'title' | 'description' | 'adminRemarks' | 'resolutionDetails'>
): ReportDataQualityAssessment {
  const reasons: string[] = [];

  const titleTrimmed = (report.title || '').trim();
  const descTrimmed = (report.description || '').trim();

  const titleQuality = assessTextEntryQuality(titleTrimmed);
  const descQuality = assessTextEntryQuality(descTrimmed);

  const titleTooShort = titleTrimmed.length > 0 && titleTrimmed.length < 3;
  const descTooShort = descTrimmed.length > 0 && descTrimmed.length < 5;

  if (titleQuality.isSuspicious || titleTooShort) {
    reasons.push('Title contains test or incomplete text');
  }
  if (descQuality.isSuspicious || descTooShort || !descTrimmed) {
    reasons.push(
      !descTrimmed
        ? 'Description is missing'
        : descTooShort
        ? 'Description is too short'
        : 'Description contains test or keyboard-mash text'
    );
  }

  if (report.adminRemarks && assessTextEntryQuality(report.adminRemarks).isSuspicious) {
    reasons.push('Administrator remarks contain test/placeholder text');
  }
  if (report.resolutionDetails && assessTextEntryQuality(report.resolutionDetails).isSuspicious) {
    reasons.push('Resolution summary contains test/placeholder text');
  }

  return {
    isSuspicious: reasons.length > 0,
    reasons,
    titleSuspicious: titleQuality.isSuspicious || titleTooShort,
    descriptionSuspicious: descQuality.isSuspicious || descTooShort || !descTrimmed,
  };
}

/**
 * Generates an irreversible, privacy-preserving opaque Citizen Reference code (e.g., CIT-8F3A1C)
 * using FNV-1a hashing so raw Firebase UIDs or student IDs are never partially leaked.
 */
export function generateSafeCitizenCode(userId: string | null | undefined): string {
  const raw = typeof userId === 'string' ? userId.trim() : '';
  if (!raw || raw === 'anonymous' || raw === 'unknown') {
    return 'CIT-GUEST';
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const hex = (hash >>> 0).toString(16).toUpperCase().padStart(6, '0').slice(0, 6);
  return `CIT-${hex}`;
}

/**
 * Ensures citizen display names shown in the Admin Citizens Directory never expose
 * email addresses, student/roll ID numbers, or raw auth UIDs.
 */
export function sanitizeCitizenDisplayName(
  rawName: string | null | undefined,
  userId?: string | null
): string {
  const trimmed = typeof rawName === 'string' ? rawName.trim() : '';
  if (!trimmed) {
    return 'Registered Citizen';
  }

  // Never expose email addresses
  if (trimmed.includes('@')) {
    const local = trimmed.split('@')[0]?.replace(/[._-]+/g, ' ').trim();
    if (local && /[a-zA-Z]{2,}/.test(local) && !/^\d+$/.test(local) && !/\d{4,}/.test(local)) {
      const cleaned = local
        .split(/\s+/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
      return cleaned;
    }
    return 'Registered Citizen';
  }

  // Never expose numeric IDs / roll numbers / student IDs (e.g., 245124748053) or raw phone numbers
  const digits = trimmed.replace(/\D/g, '');
  if (/^\d{5,}$/.test(trimmed.replace(/[\s+-]/g, '')) || digits.length >= 6) {
    return 'Registered Citizen';
  }

  // Never expose the raw auth UID itself
  if (userId && (trimmed === userId || (userId.length >= 8 && trimmed.includes(userId)))) {
    return 'Registered Citizen';
  }

  // Reject keyboard-mash or single-character placeholder display names
  if (assessTextEntryQuality(trimmed).isSuspicious) {
    return 'Registered Citizen';
  }

  return trimmed;
}
