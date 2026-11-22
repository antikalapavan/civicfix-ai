export type AppRoute = 'citizen' | 'admin_login' | 'admin_dashboard';

export interface RouteVerificationResult {
  authorized: boolean;
  isDeactivated?: boolean;
  reason?: 'unauthenticated' | 'unauthorized_citizen' | 'deactivated_admin' | 'verification_error';
  error?: string;
}

export interface RouteAccessDecision {
  action: 'loading' | 'verify' | 'allow' | 'redirect';
  shouldRenderAdminContent: boolean;
  redirectTo: AppRoute | null;
  shouldSignOut?: boolean;
  notice?: string | null;
}

function normalizePath(rawPath: string): string {
  const withoutQueryOrHash = (rawPath || '/').split('?')[0].split('#')[0].trim().toLowerCase();
  const collapsed = withoutQueryOrHash.replace(/\/{2,}/g, '/');
  if (!collapsed || collapsed === '/') return '/';
  const withLeadingSlash = collapsed.startsWith('/') ? collapsed : `/${collapsed}`;
  return withLeadingSlash.replace(/\/+$/, '') || '/';
}

function extractHashPath(rawHash: string): string {
  const trimmed = (rawHash || '').trim().toLowerCase();
  if (!trimmed) return '';
  const withoutHash = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if (!withoutHash) return '';
  return normalizePath(withoutHash);
}

/**
 * Resolves any application URL path or hash to a canonical portal route.
 * Any `/admin` or `/admin/*` route (other than `/admin/login`) resolves to
 * `'admin_dashboard'` so RBAC verification guards every nested admin URL.
 */
export function resolveAppRouteFromLocation(pathname: string = '/', hash: string = ''): AppRoute {
  const cleanPath = normalizePath(pathname);
  if (cleanPath === '/admin/login' || cleanPath.startsWith('/admin/login/')) {
    return 'admin_login';
  }
  if (cleanPath === '/admin' || cleanPath.startsWith('/admin/')) {
    return 'admin_dashboard';
  }

  const cleanHashPath = extractHashPath(hash);
  if (cleanHashPath === '/admin/login' || cleanHashPath.startsWith('/admin/login/')) {
    return 'admin_login';
  }
  if (cleanHashPath === '/admin' || cleanHashPath.startsWith('/admin/')) {
    return 'admin_dashboard';
  }

  return 'citizen';
}

export function getPathForRoute(route: AppRoute): string {
  switch (route) {
    case 'admin_login':
      return '/admin/login';
    case 'admin_dashboard':
      return '/admin';
    case 'citizen':
    default:
      return '/';
  }
}

/**
 * Evaluates strict Role-Based Access Control decisions for portal routes.
 * Guarantees admin dashboard UI is NEVER authorized unless Firebase Auth
 * hydration is complete and administrator privileges are explicitly verified.
 */
export function evaluateAdminRouteAccess(params: {
  route: AppRoute;
  isAuthChecking: boolean;
  hasAuthenticatedSession: boolean;
  hasVerifiedAdmin: boolean;
  verificationResult?: RouteVerificationResult | null;
}): RouteAccessDecision {
  const {
    route,
    isAuthChecking,
    hasAuthenticatedSession,
    hasVerifiedAdmin,
    verificationResult,
  } = params;

  if (route === 'citizen') {
    return {
      action: 'allow',
      shouldRenderAdminContent: false,
      redirectTo: null,
    };
  }

  if (route === 'admin_login') {
    if (isAuthChecking) {
      return {
        action: 'loading',
        shouldRenderAdminContent: false,
        redirectTo: null,
      };
    }
    if (hasAuthenticatedSession && hasVerifiedAdmin) {
      return {
        action: 'redirect',
        shouldRenderAdminContent: false,
        redirectTo: 'admin_dashboard',
      };
    }
    return {
      action: 'allow',
      shouldRenderAdminContent: false,
      redirectTo: null,
    };
  }

  // Protected route: route === 'admin_dashboard' (/admin or /admin/*)
  if (isAuthChecking) {
    return {
      action: 'loading',
      shouldRenderAdminContent: false,
      redirectTo: null,
    };
  }

  if (!hasAuthenticatedSession) {
    return {
      action: 'redirect',
      shouldRenderAdminContent: false,
      redirectTo: 'admin_login',
      notice: null,
    };
  }

  if (hasVerifiedAdmin) {
    return {
      action: 'allow',
      shouldRenderAdminContent: true,
      redirectTo: null,
    };
  }

  if (!verificationResult) {
    return {
      action: 'verify',
      shouldRenderAdminContent: false,
      redirectTo: null,
    };
  }

  if (verificationResult.authorized) {
    return {
      action: 'allow',
      shouldRenderAdminContent: true,
      redirectTo: null,
    };
  }

  if (verificationResult.isDeactivated || verificationResult.reason === 'deactivated_admin') {
    return {
      action: 'redirect',
      shouldRenderAdminContent: false,
      redirectTo: 'admin_login',
      shouldSignOut: true,
      notice:
        verificationResult.error ||
        'Access denied: This administrator account has been deactivated.',
    };
  }

  if (verificationResult.reason === 'verification_error') {
    return {
      action: 'redirect',
      shouldRenderAdminContent: false,
      redirectTo: 'admin_login',
      notice:
        verificationResult.error ||
        'Unable to verify administrator privileges. Please sign in with an authorized administrator account.',
    };
  }

  // Authenticated ordinary citizen attempting to open an admin route:
  // deny immediately and redirect back to Citizen Portal without exposing admin content.
  return {
    action: 'redirect',
    shouldRenderAdminContent: false,
    redirectTo: 'citizen',
    notice: null,
  };
}
