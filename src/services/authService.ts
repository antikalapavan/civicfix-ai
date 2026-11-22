/**
 * CiviFix AI - Firebase Authentication Service
 *
 * Project: civifix-ai-214ec
 * Handles real Firebase Email/Password Authentication, registration with
 * displayName profile update, session tracking via onAuthStateChanged,
 * and secure sign out.
 */

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithCredential,
  GoogleAuthProvider,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  updateProfile,
  sendEmailVerification,
  sendPasswordResetEmail as firebaseSendPasswordResetEmail,
  User as FirebaseUser,
} from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import { CitizenUser } from '../types/civic';
import { SocialLogin } from '@capgo/capacitor-social-login';
import { Capacitor } from '@capacitor/core';

const PROFILE_STORAGE_PREFIX = 'civifix_citizen_profile_';

/**
 * Maps a Firebase User and cached ward/phone metadata to CitizenUser
 */
export function mapFirebaseUserToCitizenUser(
  fbUser: FirebaseUser,
  fallbackMetadata?: Partial<CitizenUser>
): CitizenUser {
  let cachedData: Partial<CitizenUser> = {};
  try {
    const raw = localStorage.getItem(`${PROFILE_STORAGE_PREFIX}${fbUser.uid}`);
    if (raw) {
      cachedData = JSON.parse(raw);
    }
  } catch (e) {
    // ignore parsing errors
  }

  const displayName =
    fbUser.displayName ||
    fallbackMetadata?.fullName ||
    cachedData.fullName ||
    (fbUser.email ? fbUser.email.split('@')[0] : 'Citizen');

  return {
    id: fbUser.uid,
    fullName: displayName,
    email: fbUser.email || '',
    emailVerified: Boolean(fbUser.emailVerified),
    authProvider: fbUser.providerData?.[0]?.providerId || 'password',
    phone:
      fbUser.phoneNumber ||
      (fallbackMetadata?.phone !== undefined ? fallbackMetadata.phone : cachedData.phone) ||
      '',
    ward: fallbackMetadata?.ward || cachedData.ward || 'Unassigned Ward',
    city: fallbackMetadata?.city || cachedData.city || 'Metropolitan Civic District',
    reportsCount: fallbackMetadata?.reportsCount ?? cachedData.reportsCount ?? 0,
    resolvedCount: fallbackMetadata?.resolvedCount ?? cachedData.resolvedCount ?? 0,
    notificationPreferences: fallbackMetadata?.notificationPreferences ||
      cachedData.notificationPreferences || {
        smsAlerts: true,
        pushNotifications: true,
        emailUpdates: true,
      },
    avatarUrl:
      fallbackMetadata && 'avatarUrl' in fallbackMetadata
        ? fallbackMetadata.avatarUrl || undefined
        : fbUser.photoURL || cachedData.avatarUrl,
    avatarColor: fallbackMetadata?.avatarColor || cachedData.avatarColor || 'emerald',
    preferredLanguage: fallbackMetadata?.preferredLanguage || cachedData.preferredLanguage || 'English',
  };
}

/**
 * Cache citizen profile preferences locally (does NOT store passwords)
 */
export function cacheCitizenProfile(user: CitizenUser): void {
  try {
    localStorage.setItem(
      `${PROFILE_STORAGE_PREFIX}${user.id}`,
      JSON.stringify({
        fullName: user.fullName,
        phone: user.phone,
        ward: user.ward,
        city: user.city,
        reportsCount: user.reportsCount,
        resolvedCount: user.resolvedCount,
        notificationPreferences: user.notificationPreferences,
        avatarUrl: user.avatarUrl,
        avatarColor: user.avatarColor,
        preferredLanguage: user.preferredLanguage,
      })
    );
  } catch (e) {
    console.error('Failed to cache citizen profile:', e);
  }
}

export interface SaveUserProfileOptions {
  throwOnError?: boolean;
}

export interface SaveUserProfileDeps {
  dbInstance?: any;
  currentAuthUid?: string | null;
  docFn?: (...args: any[]) => any;
  setDocFn?: (ref: any, data: any, options?: any) => Promise<void>;
  updateAuthProfileFn?: (profile: { displayName?: string; photoURL?: string }) => Promise<void>;
}

/**
 * Persists citizen profile preferences to Cloud Firestore /users/{uid}
 */
export async function saveUserProfileToFirestore(
  user: CitizenUser,
  options?: SaveUserProfileOptions,
  deps?: SaveUserProfileDeps
): Promise<void> {
  const dbInstance = deps?.dbInstance !== undefined ? deps.dbInstance : db;
  const activeUid =
    deps?.currentAuthUid !== undefined ? deps.currentAuthUid : auth?.currentUser?.uid ?? null;
  if (!dbInstance || !activeUid || activeUid !== user.id) return;

  const trimmedAvatarUrl =
    typeof user.avatarUrl === 'string' ? user.avatarUrl.trim() : '';
  if (trimmedAvatarUrl.length > 2000) {
    if (options?.throwOnError) {
      throw new Error('Profile photo link is too long. Please use a shorter web link.');
    }
  }
  const firestoreAvatarUrl =
    trimmedAvatarUrl.length > 0 && trimmedAvatarUrl.length <= 2000
      ? trimmedAvatarUrl
      : null;

  const docFn = deps?.docFn ?? doc;
  const setDocFn = deps?.setDocFn ?? setDoc;

  try {
    await setDocFn(
      docFn(dbInstance, 'users', user.id),
      {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone || '',
        ward: user.ward || 'Unassigned Ward',
        city: user.city || 'Metropolitan Civic District',
        preferredLanguage: user.preferredLanguage || 'English',
        avatarColor: user.avatarColor || 'emerald',
        avatarUrl: firestoreAvatarUrl,
        notificationPreferences: user.notificationPreferences,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  } catch (err: any) {
    console.warn('Could not persist user profile to Firestore:', err?.message || err);
    if (options?.throwOnError) {
      throw err;
    }
  }
}

/**
 * Loads saved citizen profile preferences from Cloud Firestore /users/{uid}
 */
export async function loadUserProfileFromFirestore(
  uid: string
): Promise<Partial<CitizenUser> | null> {
  if (!db || !auth?.currentUser || auth.currentUser.uid !== uid) return null;
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    if (!snap.exists()) return null;
    return snap.data() as Partial<CitizenUser>;
  } catch {
    return null;
  }
}

/**
 * Updates citizen profile in Cloud Firestore /users/{uid}, Firebase Auth (displayName, photoURL), and local cache.
 * Throws if Firestore rejects the write for an authenticated session so the UI can roll back and show feedback.
 */
export async function updateCitizenUserProfile(
  user: CitizenUser,
  updates: {
    fullName?: string;
    phone?: string;
    ward?: string;
    avatarUrl?: string | null;
    avatarColor?: string;
    preferredLanguage?: string;
    notificationPreferences?: CitizenUser['notificationPreferences'];
  },
  deps?: SaveUserProfileDeps
): Promise<CitizenUser> {
  const hasAvatarUpdate = Object.prototype.hasOwnProperty.call(updates, 'avatarUrl');
  const nextAvatarUrl = hasAvatarUpdate
    ? typeof updates.avatarUrl === 'string' && updates.avatarUrl.trim().length > 0
      ? updates.avatarUrl.trim()
      : undefined
    : user.avatarUrl;

  const updatedUser: CitizenUser = {
    ...user,
    fullName: updates.fullName?.trim() || user.fullName,
    phone: updates.phone !== undefined ? updates.phone.trim() : user.phone,
    ward: updates.ward || user.ward,
    avatarUrl: nextAvatarUrl,
    avatarColor: updates.avatarColor || user.avatarColor,
    preferredLanguage: updates.preferredLanguage || user.preferredLanguage,
    notificationPreferences: updates.notificationPreferences || user.notificationPreferences,
  };

  // Persist to Cloud Firestore first so failures abort before updating local cache
  await saveUserProfileToFirestore(updatedUser, { throwOnError: true }, deps);

  // Sync to Firebase Auth user profile if signed in (best-effort)
  const profileUpdates: { displayName?: string; photoURL?: string } = {};
  if (updates.fullName && updates.fullName.trim()) {
    profileUpdates.displayName = updates.fullName.trim();
  }
  if (hasAvatarUpdate) {
    profileUpdates.photoURL = nextAvatarUrl ?? '';
  }

  if (Object.keys(profileUpdates).length > 0) {
    if (deps?.updateAuthProfileFn) {
      try {
        await deps.updateAuthProfileFn(profileUpdates);
      } catch (err) {
        console.warn('Could not sync profile to Firebase Auth currentUser:', err);
      }
    } else if (auth?.currentUser) {
      try {
        await updateProfile(auth.currentUser, profileUpdates);
      } catch (err) {
        console.warn('Could not sync profile to Firebase Auth currentUser:', err);
      }
    }
  }

  cacheCitizenProfile(updatedUser);
  return updatedUser;
}

export interface RegisterCitizenParams {
  name?: string;
  fullName?: string;
  email: string;
  password: string;
  phone?: string;
  ward?: string;
}

/**
 * Register a new citizen account with Firebase Email/Password
 */
export async function registerCitizen({
  name,
  fullName,
  email,
  password,
  phone = '',
  ward = '',
}: RegisterCitizenParams): Promise<CitizenUser> {
  const trimmedEmail = email.trim();
  const trimmedName = (fullName || name || '').trim();

  // Create Firebase Auth user
  const userCredential = await createUserWithEmailAndPassword(auth, trimmedEmail, password);
  const fbUser = userCredential.user;

  // Set displayName via Firebase updateProfile
  if (trimmedName) {
    try {
      await updateProfile(fbUser, { displayName: trimmedName });
    } catch (profileErr) {
      console.warn('Could not update profile displayName:', profileErr);
    }
  }

  const citizenUser: CitizenUser = {
    id: fbUser.uid,
    fullName: trimmedName || (fbUser.email ? fbUser.email.split('@')[0] : 'Citizen'),
    email: fbUser.email || trimmedEmail,
    emailVerified: Boolean(fbUser.emailVerified),
    authProvider: 'password',
    phone,
    ward: ward || 'Unassigned Ward',
    city: 'Metropolitan Civic District',
    reportsCount: 0,
    resolvedCount: 0,
    notificationPreferences: {
      smsAlerts: true,
      pushNotifications: true,
      emailUpdates: true,
    },
  };

  cacheCitizenProfile(citizenUser);
  await saveUserProfileToFirestore(citizenUser);
  try {
    await sendEmailVerification(fbUser);
  } catch {
    // Best-effort verification email on registration
  }
  return citizenUser;
}

/**
 * Sign in an existing citizen account with Firebase Email/Password
 */
export async function loginCitizen(
  emailOrObj: string | { email: string; password: string },
  passwordParam?: string
): Promise<CitizenUser> {
  const email = typeof emailOrObj === 'string' ? emailOrObj : emailOrObj.email;
  const password = typeof emailOrObj === 'string' ? passwordParam || '' : emailOrObj.password;

  const trimmedEmail = email.trim();
  const userCredential = await signInWithEmailAndPassword(auth, trimmedEmail, password);
  const remoteMeta = await loadUserProfileFromFirestore(userCredential.user.uid);
  const citizenUser = mapFirebaseUserToCitizenUser(userCredential.user, remoteMeta || undefined);
  cacheCitizenProfile(citizenUser);
  return citizenUser;
}

/**
 * Sign in or register a citizen account using Google Sign-In (GoogleAuthProvider + signInWithPopup)
 */
export async function loginWithGoogle(): Promise<CitizenUser> {
  let userCredential;

  if (Capacitor.getPlatform() === 'android') {
    await SocialLogin.initialize({
      google: {
        webClientId: '93301193980-kgr0veocf497aatu6dilgvhg8nc2kp11.apps.googleusercontent.com',
        mode: 'online',
      },
    });
    const { result } = await SocialLogin.login({ provider: 'google', options: {} });
    if (result.responseType !== 'online' || !result.idToken) {
      throw new Error('Google Sign-In did not return an ID token.');
    }
    const credential = GoogleAuthProvider.credential(result.idToken);
    userCredential = await signInWithCredential(auth, credential);
  } else {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    userCredential = await signInWithPopup(auth, provider);
  }

  const remoteMeta = await loadUserProfileFromFirestore(userCredential.user.uid);
  const citizenUser = mapFirebaseUserToCitizenUser(userCredential.user, remoteMeta || undefined);
  cacheCitizenProfile(citizenUser);
  await saveUserProfileToFirestore(citizenUser);
  return citizenUser;
}

/**
 * Sends an email verification link to the currently signed-in citizen
 */
export async function sendCitizenEmailVerification(): Promise<{ success: boolean; message: string }> {
  const currentUser = auth?.currentUser;
  if (!currentUser) {
    return { success: false, message: 'Please sign in to send an email verification link.' };
  }
  if (currentUser.emailVerified) {
    return { success: true, message: 'Your email address is already verified.' };
  }
  try {
    await sendEmailVerification(currentUser);
    return {
      success: true,
      message: `Verification email sent to ${currentUser.email}. Check your inbox and spam folder.`,
    };
  } catch (err: any) {
    return {
      success: false,
      message: getFriendlyAuthErrorMessage(err),
    };
  }
}

/**
 * Sign out the current user via Firebase signOut
 */
export async function signOutCitizen(): Promise<void> {
  await firebaseSignOut(auth);
}

/**
 * Sends a password reset email using Firebase Auth.
 */
export async function sendCitizenPasswordReset(
  email: string
): Promise<{ success: boolean; message: string }> {
  const trimmedEmail = (email || '').trim();
  if (!trimmedEmail) {
    return {
      success: false,
      message: 'Please enter your registered email address to receive a password reset link.',
    };
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(trimmedEmail)) {
    return {
      success: false,
      message: 'Please provide a valid email address format (e.g. citizen@example.com).',
    };
  }

  if (!auth) {
    return {
      success: false,
      message: 'Password reset service is currently unavailable. Please contact municipal support.',
    };
  }

  try {
    await firebaseSendPasswordResetEmail(auth, trimmedEmail);
    return {
      success: true,
      message: `Password reset instructions have been sent to ${trimmedEmail}. Please check your inbox and spam folder.`,
    };
  } catch (err: any) {
    console.warn('Firebase sendPasswordResetEmail notice:', err?.code || err?.message);
    let friendlyMessage = 'Failed to send password reset email. Please try again.';
    if (err?.code === 'auth/user-not-found') {
      friendlyMessage = 'No registered citizen account found with this email address. Please register a new account.';
    } else if (err?.code === 'auth/invalid-email') {
      friendlyMessage = 'The provided email address is invalid.';
    } else if (err?.code === 'auth/too-many-requests') {
      friendlyMessage = 'Too many requests. Please wait a few moments before trying again.';
    } else if (err?.code === 'auth/network-request-failed') {
      friendlyMessage = 'Network connection issue. Please check your internet connectivity and try again.';
    } else if (err?.message) {
      friendlyMessage = getFriendlyAuthErrorMessage(err);
    }
    return {
      success: false,
      message: friendlyMessage,
    };
  }
}

export interface CitizenAuthStateDeps {
  subscribeAuthFn?: (
    listener: (fbUser: FirebaseUser | null) => void
  ) => () => void;
  loadUserProfileFn?: (uid: string) => Promise<Partial<CitizenUser> | null>;
  getCurrentAuthUidFn?: () => string | null;
}

/**
 * Subscribe to real-time Firebase Authentication state changes.
 * Immediately dispatches the mapped Firebase identity for responsiveness, then
 * asynchronously hydrates `/users/{uid}` from Cloud Firestore with strict
 * sequence/UID guards to prevent stale cross-user or post-sign-out overwrites.
 */
export function onCitizenAuthStateChanged(
  callback: (user: CitizenUser | null, fbUser: FirebaseUser | null) => void,
  deps?: CitizenAuthStateDeps
): () => void {
  const subscribeFn =
    deps?.subscribeAuthFn ??
    ((listener: (fbUser: FirebaseUser | null) => void) =>
      onAuthStateChanged(auth, listener));
  const loadProfileFn = deps?.loadUserProfileFn ?? loadUserProfileFromFirestore;
  const getCurrentAuthUid =
    deps?.getCurrentAuthUidFn ?? (() => auth?.currentUser?.uid ?? null);

  let cancelled = false;
  let authSequence = 0;
  let activeUid: string | null = null;
  let inFlightUid: string | null = null;
  let inFlightPromise: Promise<Partial<CitizenUser> | null> | null = null;
  const hydratedUids = new Set<string>();

  const unsubscribe = subscribeFn((fbUser) => {
    authSequence += 1;
    const seqAtEvent = authSequence;

    if (!fbUser) {
      activeUid = null;
      inFlightUid = null;
      inFlightPromise = null;
      hydratedUids.clear();
      callback(null, null);
      return;
    }

    activeUid = fbUser.uid;
    const immediateUser = mapFirebaseUserToCitizenUser(fbUser);
    callback(immediateUser, fbUser);

    if (hydratedUids.has(fbUser.uid)) {
      return;
    }

    let profilePromise: Promise<Partial<CitizenUser> | null>;
    if (inFlightUid === fbUser.uid && inFlightPromise) {
      profilePromise = inFlightPromise;
    } else {
      inFlightUid = fbUser.uid;
      profilePromise = Promise.resolve()
        .then(() => loadProfileFn(fbUser.uid))
        .catch(() => null);
      inFlightPromise = profilePromise;
    }

    profilePromise.then((remoteMeta) => {
      if (inFlightUid === fbUser.uid && inFlightPromise === profilePromise) {
        inFlightUid = null;
        inFlightPromise = null;
      }

      if (cancelled || seqAtEvent !== authSequence || activeUid !== fbUser.uid) {
        return;
      }

      const currentAuthUid = getCurrentAuthUid();
      if (currentAuthUid && currentAuthUid !== fbUser.uid) {
        return;
      }

      if (!remoteMeta) {
        return;
      }

      hydratedUids.add(fbUser.uid);

      // Preserve trusted Firebase Auth identity fields regardless of Firestore doc contents
      const safeRemoteMeta: Partial<CitizenUser> = {
        ...remoteMeta,
        id: fbUser.uid,
        email: fbUser.email || immediateUser.email,
        emailVerified: Boolean(fbUser.emailVerified),
        authProvider: immediateUser.authProvider,
      };

      const hydratedUser = mapFirebaseUserToCitizenUser(fbUser, safeRemoteMeta);
      cacheCitizenProfile(hydratedUser);
      callback(hydratedUser, fbUser);
    });
  });

  return () => {
    cancelled = true;
    activeUid = null;
    unsubscribe();
  };
}

/**
 * Map Firebase Auth error codes to user-friendly civic messages
 */
export function getFriendlyAuthErrorMessage(error: any): string {
  const code = error?.code || '';
  const message = error?.message || '';

  switch (code) {
    case 'auth/email-already-in-use':
      return 'An account with this email address is already registered. Please log in instead.';
    case 'auth/invalid-email':
      return 'Please enter a valid email address (e.g., citizen@example.com).';
    case 'auth/weak-password':
      return 'Password is too weak. Please choose a password with at least 6 characters.';
    case 'auth/operation-not-allowed':
      return 'Email and password sign-in is currently unavailable. Please contact municipal support.';
    case 'auth/user-disabled':
      return 'This citizen account has been disabled. Please contact municipal support.';
    case 'auth/user-not-found':
      return 'No citizen account found with this email. Please check your spelling or register a new account.';
    case 'auth/wrong-password':
      return 'Incorrect password. Please verify and try again.';
    case 'auth/invalid-credential':
      return 'Invalid email or password. Please double check your credentials and try again.';
    case 'auth/too-many-requests':
      return 'Access temporarily blocked due to repeated failed attempts. Please try again in a few minutes or reset your password.';
    case 'auth/network-request-failed':
      return 'Network connection issue. Please check your internet connectivity.';
    case 'auth/missing-password':
      return 'Please provide a password.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'Google Sign-In popup was closed before finishing. Please try again.';
    case 'auth/popup-blocked':
      return 'Your browser blocked the Google Sign-In popup. Please allow popups for this site and try again.';
    case 'auth/unauthorized-domain':
      return 'Google Sign-In is currently unavailable on this web address. Please sign in with your email and password.';
    case 'auth/account-exists-with-different-credential':
      return 'An account already exists with this email using another sign-in method. Sign in with your original method.';
    default:
      if (message && !/firebase|firestore|auth\//i.test(message)) {
        return message;
      }
      return 'Sign-in could not be completed. Please verify your details and try again.';
  }
}
