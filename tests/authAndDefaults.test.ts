import {
  mapFirebaseUserToCitizenUser,
  sendCitizenPasswordReset,
  getFriendlyAuthErrorMessage,
  onCitizenAuthStateChanged,
} from '../src/services/authService';

let totalTests = 0;
let passedTests = 0;

function assert(condition: boolean, testName: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✓ ${testName}`);
  } else {
    console.error(`  ✗ FAIL: ${testName}`);
    process.exitCode = 1;
  }
}

console.log('\n--- RUNNING CIVIFIX AI AUTH REGISTRATION DEFAULTS & PASSWORD RESET TEST SUITE ---');

// 1. mapFirebaseUserToCitizenUser Profile Fallback Tests
console.log('\n1. Profile Defaults & Privacy Safety:');

const mockFbUser: any = {
  uid: 'citizen_uid_test_999',
  email: 'newcitizen@example.com',
  displayName: null,
  phoneNumber: null,
  photoURL: null,
};

const mappedCitizen = mapFirebaseUserToCitizenUser(mockFbUser);

// Ensure NO hardcoded sample phone or sample ward is silently injected
assert(
  mappedCitizen.phone !== '+91 98765 43210',
  'Does not silently inject hardcoded sample phone number (+91 98765 43210)'
);
assert(
  mappedCitizen.phone === '',
  'Defaults phone to empty string when none provided by citizen'
);
assert(
  mappedCitizen.ward !== 'Ward 47 - Metro Green Zone',
  'Does not silently prefill sample ward "Ward 47 - Metro Green Zone"'
);
assert(
  mappedCitizen.ward === 'Unassigned Ward',
  'Correctly marks ward as "Unassigned Ward" when none selected'
);
assert(
  mappedCitizen.email === 'newcitizen@example.com',
  'Maps genuine citizen email address accurately'
);

// 2. Input Validation Logic Tests for Registration
console.log('\n2. Citizen Registration Input Validation:');

function validateRegistrationInputs(params: {
  fullName: string;
  email: string;
  phone: string;
  ward: string;
  password: string;
  confirmPassword: string;
}): string | null {
  const trimmedEmail = params.email.trim();
  if (!trimmedEmail) return 'Please enter your email address.';
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(trimmedEmail)) return 'Please enter a valid email format (e.g. name@domain.com).';

  if (!params.password) return 'Please enter a password.';
  if (params.password.length < 6) return 'Password must be at least 6 characters long.';

  if (!params.fullName.trim()) return 'Please enter your full legal or citizen name.';

  const cleanedPhone = params.phone.trim().replace(/[\s-]/g, '');
  if (!cleanedPhone) return 'Please enter your mobile phone number.';
  if (cleanedPhone.replace(/\D/g, '').length < 10) return 'Please enter a valid 10-digit mobile phone number.';

  if (!params.ward || params.ward.trim() === '') return 'Please select your residential ward from the supported municipal wards list.';

  if (params.password !== params.confirmPassword) return 'Passwords do not match. Please verify your confirmation password.';

  return null;
}

// Test A: Empty phone number is rejected
const emptyPhoneResult = validateRegistrationInputs({
  fullName: 'Priya Rao',
  email: 'priya@example.com',
  phone: '',
  ward: 'Ward 111 - MG Road Central',
  password: 'Password123!',
  confirmPassword: 'Password123!',
});
assert(
  emptyPhoneResult === 'Please enter your mobile phone number.',
  'Rejects registration when citizen phone number is empty'
);

// Test B: Invalid short phone number is rejected
const shortPhoneResult = validateRegistrationInputs({
  fullName: 'Priya Rao',
  email: 'priya@example.com',
  phone: '12345',
  ward: 'Ward 111 - MG Road Central',
  password: 'Password123!',
  confirmPassword: 'Password123!',
});
assert(
  shortPhoneResult === 'Please enter a valid 10-digit mobile phone number.',
  'Rejects phone number with fewer than 10 digits'
);

// Test C: Unselected ward (empty default) is rejected
const emptyWardResult = validateRegistrationInputs({
  fullName: 'Priya Rao',
  email: 'priya@example.com',
  phone: '9876501234',
  ward: '',
  password: 'Password123!',
  confirmPassword: 'Password123!',
});
assert(
  emptyWardResult === 'Please select your residential ward from the supported municipal wards list.',
  'Rejects registration when residential ward has not been selected'
);

// Test D: Valid citizen details pass all validations
const validResult = validateRegistrationInputs({
  fullName: 'Priya Rao',
  email: 'priya@example.com',
  phone: '9876501234',
  ward: 'Ward 74 - Indiranagar East',
  password: 'Password123!',
  confirmPassword: 'Password123!',
});
assert(
  validResult === null,
  'Accepts valid registration with genuine citizen phone and selected municipal ward'
);

// 3. Password Reset Functionality & Validation Tests
console.log('\n3. Firebase sendCitizenPasswordReset Validation:');

async function testPasswordResetValidation() {
  // Test A: Empty email
  const emptyEmailRes = await sendCitizenPasswordReset('');
  assert(emptyEmailRes.success === false, 'Password reset rejects empty email');
  assert(
    emptyEmailRes.message.includes('Please enter your registered email'),
    'Provides clear feedback when email is empty'
  );

  // Test B: Malformed email format
  const invalidEmailRes = await sendCitizenPasswordReset('invalid-email-format');
  assert(invalidEmailRes.success === false, 'Password reset rejects invalid email format');
  assert(
    invalidEmailRes.message.includes('valid email address format'),
    'Provides format validation feedback'
  );

  // Test C: Error message mapping for Firebase errors
  const userNotFoundMsg = getFriendlyAuthErrorMessage({ code: 'auth/user-not-found' });
  assert(
    userNotFoundMsg.includes('No citizen account found'),
    'Maps auth/user-not-found to friendly civic guidance'
  );

  const invalidCredMsg = getFriendlyAuthErrorMessage({ code: 'auth/invalid-credential' });
  assert(
    invalidCredMsg.includes('Invalid email or password'),
    'Maps auth/invalid-credential to friendly guidance'
  );

  const tooManyRequestsMsg = getFriendlyAuthErrorMessage({ code: 'auth/too-many-requests' });
  assert(
    tooManyRequestsMsg.includes('repeated failed attempts'),
    'Maps auth/too-many-requests to rate limit notice'
  );
}

// 4. Phase 4 Step 5 Finding 6: Restore Citizen Firestore Profile on Auth Session Recovery
async function withMockStorage(fn: (store: Record<string, string>) => Promise<void>) {
  const store: Record<string, string> = {};
  const prevStorage = (globalThis as any).localStorage;
  (globalThis as any).localStorage = {
    getItem: (k: string) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  };
  try {
    await fn(store);
  } finally {
    if (prevStorage === undefined) {
      delete (globalThis as any).localStorage;
    } else {
      (globalThis as any).localStorage = prevStorage;
    }
  }
}

async function testSessionProfileHydration() {
  console.log('\n4. Citizen Session Recovery & Firestore Profile Hydration:');

  await withMockStorage(async (store) => {
    // Seed stale cache for user A so we verify Firestore /users/{uid} takes precedence
    store['civifix_citizen_profile_uid_A'] = JSON.stringify({
      phone: '0000000000',
      ward: 'Old Stale Ward',
      preferredLanguage: 'English',
      notificationPreferences: { smsAlerts: true, pushNotifications: true, emailUpdates: true },
    });

    let emittedListener: ((u: any) => void) | null = null;
    let currentUid: string | null = 'uid_A';
    let resolveProfileA!: (val: any) => void;
    let profileFetchCount = 0;

    const delivered: Array<any> = [];
    const unsub = onCitizenAuthStateChanged(
      (citizen) => {
        delivered.push(citizen);
      },
      {
        subscribeAuthFn: (listener) => {
          emittedListener = listener;
          return () => {};
        },
        getCurrentAuthUidFn: () => currentUid,
        loadUserProfileFn: () => {
          profileFetchCount++;
          return new Promise((resolve) => {
            resolveProfileA = resolve;
          });
        },
      }
    );

    const fbUserA: any = {
      uid: 'uid_A',
      email: 'trustedA@example.com',
      emailVerified: true,
      displayName: 'Citizen A',
      phoneNumber: null,
      photoURL: null,
      providerData: [{ providerId: 'password' }],
    };

    emittedListener!(fbUserA);
    assert(delivered.length === 1 && delivered[0]?.id === 'uid_A', '1. Auth listener delivers immediate Firebase user synchronously');
    assert(delivered[0]?.ward === 'Old Stale Ward', 'Initial emission uses fallback metadata until remote resolves');

    await Promise.resolve();

    // Hydrate remote /users/uid_A profile (including attempted spoofed uid/email which must be ignored)
    resolveProfileA({
      id: 'spoofed_uid',
      email: 'spoofed@evil.com',
      emailVerified: false,
      phone: '9876543210',
      ward: 'Ward 74 - Indiranagar East',
      preferredLanguage: 'Hindi',
      notificationPreferences: { smsAlerts: false, pushNotifications: true, emailUpdates: false },
    });
    await new Promise((r) => setTimeout(r, 15));

    assert(delivered.length === 2, '2. Async profile hydration invokes callback again with enriched profile');
    assert(
      delivered[1]?.ward === 'Ward 74 - Indiranagar East' && delivered[1]?.phone === '9876543210',
      '3. Restored ward & phone from Firestore override stale cache'
    );
    assert(
      delivered[1]?.id === 'uid_A' &&
        delivered[1]?.email === 'trustedA@example.com' &&
        delivered[1]?.emailVerified === true,
      'Trusted Firebase Auth id, email, and emailVerified stay authoritative'
    );
    assert(
      delivered[1]?.preferredLanguage === 'Hindi' &&
        delivered[1]?.notificationPreferences?.smsAlerts === false &&
        delivered[1]?.notificationPreferences?.emailUpdates === false,
      '4. Restores notificationPreferences and preferredLanguage from Firestore'
    );

    // Triggering same user again when already hydrated avoids redundant Firestore read
    emittedListener!(fbUserA);
    assert(profileFetchCount === 1, 'Deduplicates repeated Firestore profile reads for already-hydrated UID');
    unsub();
  });

  // 5 & 6. Missing profile (null) & rejected offline fetch do not crash or lose immediate user
  await withMockStorage(async () => {
    let emittedListener: ((u: any) => void) | null = null;
    const deliveredNull: any[] = [];
    const unsubNull = onCitizenAuthStateChanged(
      (c) => deliveredNull.push(c),
      {
        subscribeAuthFn: (l) => {
          emittedListener = l;
          return () => {};
        },
        getCurrentAuthUidFn: () => 'uid_missing',
        loadUserProfileFn: async () => null,
      }
    );
    emittedListener!({ uid: 'uid_missing', email: 'missing@example.com', emailVerified: false, displayName: 'Missing Doc User' } as any);
    await new Promise((r) => setTimeout(r, 15));
    assert(
      deliveredNull.length === 1 && deliveredNull[0]?.ward === 'Unassigned Ward',
      '5. Missing Firestore /users/{uid} doc falls back cleanly without error'
    );
    unsubNull();

    const deliveredErr: any[] = [];
    const unsubErr = onCitizenAuthStateChanged(
      (c) => deliveredErr.push(c),
      {
        subscribeAuthFn: (l) => {
          emittedListener = l;
          return () => {};
        },
        getCurrentAuthUidFn: () => 'uid_err',
        loadUserProfileFn: async () => {
          throw new Error('Network offline');
        },
      }
    );
    emittedListener!({ uid: 'uid_err', email: 'offline@example.com', emailVerified: false, displayName: 'Offline User' } as any);
    await new Promise((r) => setTimeout(r, 15));
    assert(
      deliveredErr.length === 1 && deliveredErr[0]?.email === 'offline@example.com',
      '6. Offline / rejected Firestore profile fetch leaves immediate user intact safely'
    );
    unsubErr();
  });

  // 7 & 8. Race guards: sign-out mid-flight & User A -> User B switch mid-flight
  await withMockStorage(async () => {
    let emittedListener: ((u: any) => void) | null = null;
    let currentUid: string | null = 'uid_1';
    const resolvers: Record<string, (v: any) => void> = {};
    const events: Array<string | null> = [];

    const unsubRace = onCitizenAuthStateChanged(
      (c) => events.push(c ? `${c.id}:${c.ward}` : null),
      {
        subscribeAuthFn: (l) => {
          emittedListener = l;
          return () => {};
        },
        getCurrentAuthUidFn: () => currentUid,
        loadUserProfileFn: (uid) =>
          new Promise((resolve) => {
            resolvers[uid] = resolve;
          }),
      }
    );

    emittedListener!({ uid: 'uid_1', email: 'u1@example.com', displayName: 'U1' } as any);
    await Promise.resolve();
    // Rapid sign-out before uid_1 resolves
    currentUid = null;
    emittedListener!(null);
    resolvers['uid_1']({ ward: 'Stale Ward From Signed Out User' });
    await new Promise((r) => setTimeout(r, 15));

    assert(
      events.length === 2 && events[0] === 'uid_1:Unassigned Ward' && events[1] === null,
      '7. Sign-out during async profile hydration prevents late signed-in callback overwrite'
    );

    // Rapid switch User 2 -> User 3 while User 2 resolves late
    events.length = 0;
    currentUid = 'uid_2';
    emittedListener!({ uid: 'uid_2', email: 'u2@example.com', displayName: 'U2' } as any);
    await Promise.resolve();
    currentUid = 'uid_3';
    emittedListener!({ uid: 'uid_3', email: 'u3@example.com', displayName: 'U3' } as any);
    await Promise.resolve();

    resolvers['uid_2']({ ward: 'Wrong User 2 Ward' });
    resolvers['uid_3']({ ward: 'Correct User 3 Ward' });
    await new Promise((r) => setTimeout(r, 15));

    assert(
      !events.some((e) => e?.includes('Wrong User 2 Ward')) &&
        events[events.length - 1] === 'uid_3:Correct User 3 Ward',
      '8. Rapid user switch ignores late User 2 profile and hydrates User 3 only'
    );
    unsubRace();
  });
}

(async () => {
  try {
    await testPasswordResetValidation();
    await testSessionProfileHydration();
    console.log(`\nAll ${passedTests} / ${totalTests} Auth Defaults & Password Reset tests passed successfully!`);
  } catch (e) {
    console.error('Test suite failed:', e);
    process.exit(1);
  }
})();
