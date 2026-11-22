#!/usr/bin/env node
/**
 * CiviFix AI - Dedicated Administrator Account Provisioning & Claim Tool
 *
 * One-time / idempotent server-side CLI to:
 * 1. Locate an existing Firebase Authentication account using ADMIN_EMAIL (or --email).
 * 2. Grant the Firebase custom claim { admin: true, role, department }.
 * 3. Create or update the active /admins/{uid} record in Cloud Firestore.
 *
 * Security:
 * - Reads credentials strictly from server-side environment variables.
 * - Never prints passwords, tokens, or service account keys to logs.
 * - Does not grant admin privileges to ordinary registered citizen users.
 *
 * Usage:
 *   ADMIN_EMAIL="admin@domain.com" \
 *   FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}' \
 *     node scripts/grant-admin-claim.mjs
 *
 * Optional flags:
 *   --email <address>       Override ADMIN_EMAIL
 *   --uid <firebaseUid>     Target an existing user by Firebase UID
 *   --role <role>           superadmin (default) | department_head | ward_admin
 *   --department <name>     Department display name
 *   --sync-password         Unsupported; this tool never changes passwords
 *   --revoke                Unsupported; this tool never revokes or deletes data
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

export function getCliArg(flag, argv = process.argv) {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return null;
  return argv[idx + 1];
}

export function resolveProvisioningConfig(env = process.env, argv = process.argv) {
  const email = (getCliArg('--email', argv) || env.ADMIN_EMAIL || '').trim();
  const uidArg = (getCliArg('--uid', argv) || '').trim();
  const role = (getCliArg('--role', argv) || env.ADMIN_ROLE || 'superadmin').trim();
  const department = (
    getCliArg('--department', argv) ||
    env.ADMIN_DEPARTMENT ||
    'Municipal Administration'
  ).trim();
  const displayName = (
    getCliArg('--name', argv) ||
    env.ADMIN_DISPLAY_NAME ||
    'Municipal Administrator'
  ).trim();
  const revoke = argv.includes('--revoke');
  const syncPassword = argv.includes('--sync-password');

  return {
    email,
    uidArg,
    role,
    department,
    displayName,
    revoke,
    syncPassword,
  };
}

export async function provisionDedicatedAdmin({ auth, db, config, nowIso = () => new Date().toISOString() }) {
  const {
    email,
    uidArg,
    role,
    department,
    displayName,
    revoke,
    syncPassword,
    includeDepartmentInClaim = true,
  } = config;

  if (!email && !uidArg) {
    throw new Error('Provide ADMIN_EMAIL in environment variables or pass --email <address> / --uid <uid>.');
  }

  if (revoke || syncPassword) {
    throw new Error('This safe provisioning tool only provisions an existing user; --revoke and --sync-password are not supported.');
  }

  let userRecord = null;

  if (uidArg) {
    userRecord = await auth.getUser(uidArg);
    if (email && userRecord.email?.toLowerCase() !== email.toLowerCase()) {
      throw new Error('The supplied --uid does not belong to the configured administrator email.');
    }
  } else {
    try {
      userRecord = await auth.getUserByEmail(email);
    } catch (lookupErr) {
      if (lookupErr?.code === 'auth/user-not-found') {
        throw new Error(`No existing Firebase user found for administrator email "${email}".`);
      }
      throw lookupErr;
    }
  }

  const nextCustomClaims = includeDepartmentInClaim
    ? {
        admin: true,
        role,
        department,
      }
    : {
        admin: true,
        role,
      };

  await auth.setCustomUserClaims(userRecord.uid, nextCustomClaims);

  await db.collection('admins').doc(userRecord.uid).set(
    {
      uid: userRecord.uid,
      email: userRecord.email || email || '',
      displayName: userRecord.displayName || displayName,
      role,
      department,
      active: true,
      updatedAt: nowIso(),
    },
    { merge: true }
  );

  return {
    action: 'provisioned',
    uid: userRecord.uid,
    email: userRecord.email || email,
    role,
    department,
    createdAccount: false,
  };
}

async function main() {
  const config = resolveProvisioningConfig(process.env, process.argv);

  if (!config.email && !config.uidArg) {
    console.error('Error: Provide ADMIN_EMAIL in environment variables or pass --email <address> / --uid <firebaseUid>.');
    process.exit(1);
  }

  const saJsonRaw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (!saJsonRaw && !saPath) {
    console.error(
      'Error: Provide FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS pointing to a Firebase service account JSON.'
    );
    process.exit(1);
  }

  // Prefer the explicitly configured external credential file over any stale
  // FIREBASE_SERVICE_ACCOUNT_JSON value loaded from the project .env file.
  const serviceAccount = JSON.parse(saPath ? readFileSync(saPath, 'utf8') : saJsonRaw);
  const app =
    getApps().length > 0
      ? getApps()[0]
      : initializeApp({
          credential: cert(serviceAccount),
          projectId: serviceAccount.project_id || process.env.FIREBASE_PROJECT_ID || 'civifix-ai-214ec',
        });

  const auth = getAuth(app);
  const db = getFirestore(app);

  const result = await provisionDedicatedAdmin({ auth, db, config });

  console.log(
    `Granted admin custom claim (admin: true, role=${result.role}, department=${result.department}) and updated /admins/${result.uid} for ${result.email || result.uid}.`
  );
  console.log('The administrator can now sign in at /admin/login.');
}

const isDirectExecution =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main().catch((err) => {
    console.error('Failed to provision admin account:', err?.message || err);
    process.exit(1);
  });
}
