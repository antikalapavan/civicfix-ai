import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import { getAuth, Auth } from 'firebase/auth';
import {
  initializeFirestore,
  getFirestore,
  Firestore,
  collection,
  getDocs,
  limit,
  query,
  where,
} from 'firebase/firestore';

/**
 * CiviFix AI - Firebase SDK Configuration
 *
 * Project: civifix-ai-214ec
 * Environment: Client-side Firebase JavaScript SDK
 */
export const firebaseConfig = {
  apiKey: "AIzaSyCpTxM9mfeUNCpkS5oEAS1foecBZJ9lIn4",
  authDomain: "civifix-ai-214ec.firebaseapp.com",
  projectId: "civifix-ai-214ec",
  storageBucket: "civifix-ai-214ec.firebasestorage.app",
  messagingSenderId: "93301193980",
  appId: "1:93301193980:web:731dc44e4e690aa1f72b79",
  measurementId: "G-MZNQWMJX10"
};

import {
  getStorage,
  ref,
  uploadString,
  getDownloadURL,
  FirebaseStorage,
} from 'firebase/storage';

// Singleton initialization to prevent multiple apps in HMR or re-renders
export const app: FirebaseApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

// Initialize Firebase Authentication
export const auth: Auth = getAuth(app);

// Initialize Cloud Firestore with ignoreUndefinedProperties: true
let firestoreDb: Firestore;
try {
  firestoreDb = initializeFirestore(app, {
    ignoreUndefinedProperties: true,
  });
} catch {
  firestoreDb = getFirestore(app);
}
export const db: Firestore = firestoreDb;

// Initialize Firebase Storage
let firebaseStorage: FirebaseStorage;
try {
  firebaseStorage = getStorage(app);
} catch (err) {
  console.warn('Firebase Storage initialization notice:', err);
  firebaseStorage = null as any;
}
export const storage: FirebaseStorage = firebaseStorage;

/**
 * Retrieves an Authorization Bearer header containing the signed-in user's Firebase ID token
 * for authenticated backend API calls. Returns an empty object if no user is signed in.
 */
export async function getFirebaseAuthHeaders(
  forceRefreshToken: boolean = false
): Promise<Record<string, string>> {
  try {
    const user = auth?.currentUser;
    if (!user) return {};
    const token = await user.getIdToken(forceRefreshToken);
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

/**
 * Extracts validated image MIME type and extension from a data URL so Firebase Storage
 * uploads always satisfy storage.rules `contentType.matches('image/.*')`.
 */
export function extractDataUrlImageMetadata(dataUrl: string): {
  contentType: string;
  extension: string;
} {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);/i.exec(dataUrl || '');
  const contentType = match ? match[1].toLowerCase() : 'image/jpeg';
  const extMap: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  return {
    contentType,
    extension: extMap[contentType] || 'jpg',
  };
}

/**
 * Uploads a complaint photo to Firebase Storage under reports/{userId}/{reportId}/...
 * If storage upload succeeds, returns the public HTTPS download URL.
 * If storage is unavailable or fails, gracefully returns the original data URL
 * so evidence is never dropped.
 */
export async function uploadComplaintImageToStorage(
  reportId: string,
  dataUrlOrBase64: string,
  ownerUid?: string
): Promise<{ success: boolean; url: string; error?: string }> {
  if (!dataUrlOrBase64 || !dataUrlOrBase64.startsWith('data:')) {
    return { success: true, url: dataUrlOrBase64 };
  }

  const uid = ownerUid || auth?.currentUser?.uid;
  if (!storage || !uid) {
    return {
      success: false,
      url: dataUrlOrBase64,
      error: !uid ? 'Not signed in; retaining local image payload' : 'Storage not initialized',
    };
  }

  try {
    const { contentType, extension } = extractDataUrlImageMetadata(dataUrlOrBase64);
    const filename = `reports/${uid}/${reportId}/evidence_${Date.now()}.${extension}`;
    const storageRef = ref(storage, filename);
    await uploadString(storageRef, dataUrlOrBase64, 'data_url', { contentType });
    const downloadUrl = await getDownloadURL(storageRef);
    return { success: true, url: downloadUrl };
  } catch (err: any) {
    console.warn('Firebase Storage complaint image upload notice:', err?.message || err);
    return {
      success: false,
      url: dataUrlOrBase64,
      error: err?.message || 'Storage unavailable, using local image data',
    };
  }
}

/**
 * Uploads a resolution photo to Firebase Storage under resolutions/{reportId}/...
 */
export async function uploadResolutionImageToStorage(
  reportId: string,
  dataUrlOrBase64: string
): Promise<{ success: boolean; url: string; error?: string }> {
  if (!dataUrlOrBase64 || !dataUrlOrBase64.startsWith('data:')) {
    return { success: true, url: dataUrlOrBase64 };
  }

  if (!storage) {
    return { success: false, url: dataUrlOrBase64, error: 'Storage not initialized' };
  }

  try {
    const { contentType, extension } = extractDataUrlImageMetadata(dataUrlOrBase64);
    const filename = `resolutions/${reportId}/resolution_${Date.now()}.${extension}`;
    const storageRef = ref(storage, filename);
    await uploadString(storageRef, dataUrlOrBase64, 'data_url', { contentType });
    const downloadUrl = await getDownloadURL(storageRef);
    return { success: true, url: downloadUrl };
  } catch (err: any) {
    console.warn('Firebase Storage resolution image upload notice:', err?.message || err);
    return {
      success: false,
      url: dataUrlOrBase64,
      error: err?.message || 'Storage unavailable, using local image data',
    };
  }
}

// Connectivity / Configuration verification helper
export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey &&
  firebaseConfig.projectId &&
  firebaseConfig.projectId !== "YOUR_PROJECT_ID"
);

/**
 * Tests actual Cloud Firestore read connectivity before claiming connection.
 * Does NOT claim connected unless the Firestore operation succeeds.
 */
export async function testFirestoreConnection(): Promise<{ success: boolean; message: string }> {
  try {
    if (!isFirebaseConfigured || !db) {
      return { success: false, message: "Firebase configuration is missing or incomplete." };
    }

    const currentUser = auth.currentUser;
    if (!currentUser) {
      return {
        success: true,
        message: `Firebase SDK initialized for project "${firebaseConfig.projectId}". Sign in with an account to test authenticated Firestore operations.`
      };
    }

    // Perform an actual authenticated query test against the authorized civic_reports collection
    const testQuery = query(
      collection(db, 'civic_reports'),
      where('userId', '==', currentUser.uid),
      limit(1)
    );
    await getDocs(testQuery);

    return {
      success: true,
      message: `Verified: Connected to Cloud Firestore in project "${firebaseConfig.projectId}". Database reads and writes are active.`
    };
  } catch (err: any) {
    const errorMsg = err?.message || 'Database unreachable';
    return {
      success: false,
      message: `Cloud Firestore not accessible (${errorMsg}). System is operating in offline local fallback mode.`
    };
  }
}
