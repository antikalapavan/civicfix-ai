import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { CitizenShell, ActiveTab } from './components/CitizenShell';
import { CivifixLogo } from './components/CivifixLogo';
import { HomeScreen } from './components/screens/HomeScreen';
import { ReportIssueScreen } from './components/screens/ReportIssueScreen';
import { MyReportsScreen } from './components/screens/MyReportsScreen';
import { CivicAiScreen } from './components/screens/CivicAiScreen';
import { ProfileSettingsScreen } from './components/screens/ProfileSettingsScreen';
import { AuthScreen } from './components/screens/AuthScreen';
import { CitizenUser, CivicIssueReport, AdminUser } from './types/civic';
import {
  fetchUserReportsFromFirestore,
  subscribeToUserReportsFromFirestore,
  addCitizenNoteToFirestore,
  withdrawReportInFirestore,
  syncPendingReportsToFirestore,
  sortReportsNewestFirst,
  syncSelectedReport,
  filterReportsForCitizen,
  clearPendingWithdrawals,
  getPendingSyncCounts,
  hasPendingOfflineSync,
  PendingSyncCounts,
} from './services/reportStorage';
import { onCitizenAuthStateChanged, signOutCitizen } from './services/authService';
import { signOutAdmin, verifyAdminPrivileges } from './services/adminService';
import { auth } from './lib/firebase';
import { AdminLoginScreen } from './components/admin/AdminLoginScreen';
import { AdminDashboard } from './components/admin/AdminDashboard';
import {
  AppRoute,
  evaluateAdminRouteAccess,
  getPathForRoute,
  resolveAppRouteFromLocation,
} from './utils/portalRouting';
import { toUserFriendlyErrorMessage } from './utils/userFriendlyErrors';

import { ThemeProvider } from './context/ThemeContext';
import { LanguageProvider } from './context/LanguageContext';

const getInitialRoute = (): AppRoute => {
  if (typeof window === 'undefined') return 'citizen';
  return resolveAppRouteFromLocation(window.location.pathname, window.location.hash);
};

function AppContent() {
  // Application Route State (Citizen Mobile vs Municipal Admin)
  const [appRoute, setAppRoute] = useState<AppRoute>(getInitialRoute);
  const [adminUser, setAdminUser] = useState<AdminUser | null>(null);
  const [isAdminVerifying, setIsAdminVerifying] = useState<boolean>(false);
  const [adminAccessNotice, setAdminAccessNotice] = useState<string | null>(null);

  // Navigation State
  const [activeTab, setActiveTab] = useState<ActiveTab>('home');
  const [selectedReport, setSelectedReport] = useState<CivicIssueReport | null>(null);

  // Authentication State: strictly depends on Firebase Authentication
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [firebaseUser, setFirebaseUser] = useState<CitizenUser | null>(null);
  const [isAuthChecking, setIsAuthChecking] = useState<boolean>(true);

  // Cloud Firestore User Reports State (belonging strictly to authenticated citizen UID)
  const [userReports, setUserReports] = useState<CivicIssueReport[]>([]);
  const [isLoadingReports, setIsLoadingReports] = useState<boolean>(false);
  const [isReportsFromCloud, setIsReportsFromCloud] = useState<boolean>(false);
  const [reportsError, setReportsError] = useState<string | null>(null);
  const [isSyncingPending, setIsSyncingPending] = useState<boolean>(false);
  const [syncFeedback, setSyncFeedback] = useState<{
    type: 'success' | 'partial' | 'error';
    message: string;
  } | null>(null);
  const [pendingSyncCounts, setPendingSyncCounts] = useState<PendingSyncCounts>({
    pendingReports: 0,
    pendingNotes: 0,
    pendingWithdrawals: 0,
    total: 0,
  });
  const syncInFlightRef = useRef<boolean>(false);

  const refreshPendingCounts = useCallback(
    (userId?: string | null, reportsOverride?: CivicIssueReport[]) => {
      if (!userId) {
        setPendingSyncCounts({
          pendingReports: 0,
          pendingNotes: 0,
          pendingWithdrawals: 0,
          total: 0,
        });
        return;
      }
      setPendingSyncCounts(getPendingSyncCounts(userId, reportsOverride));
    },
    []
  );

  const navigateToRoute = useCallback(
    (route: AppRoute, options?: { replace?: boolean }) => {
      setAppRoute(route);
      const targetPath = getPathForRoute(route);
      try {
        if (window.location.pathname !== targetPath || window.location.hash) {
          if (options?.replace) {
            window.history.replaceState({}, '', targetPath);
          } else {
            window.history.pushState({}, '', targetPath);
          }
        }
      } catch {
        window.location.hash = targetPath;
      }
    },
    []
  );

  // Listen to browser navigation changes
  useEffect(() => {
    const handleLocationChange = () => {
      setAppRoute(getInitialRoute());
    };
    window.addEventListener('popstate', handleLocationChange);
    window.addEventListener('hashchange', handleLocationChange);
    return () => {
      window.removeEventListener('popstate', handleLocationChange);
      window.removeEventListener('hashchange', handleLocationChange);
    };
  }, []);

  // Enforce strict Role-Based Access Control on /admin and /admin/* routes
  useEffect(() => {
    const hasSession = Boolean(auth.currentUser);
    const decision = evaluateAdminRouteAccess({
      route: appRoute,
      isAuthChecking,
      hasAuthenticatedSession: hasSession,
      hasVerifiedAdmin: Boolean(adminUser),
    });

    if (decision.action === 'loading' || decision.action === 'allow') {
      return;
    }

    if (decision.action === 'redirect' && decision.redirectTo) {
      if (decision.redirectTo === 'admin_login' && !hasSession) {
        // Keep existing notice (e.g., deactivation error) or show clear prompt when accessing /admin unauthenticated
        setAdminAccessNotice((prev) =>
          prev || 'Please sign in with an authorized administrator account to access the Admin Portal.'
        );
      }
      navigateToRoute(decision.redirectTo, { replace: true });
      return;
    }

    if (decision.action !== 'verify' || !auth.currentUser) {
      return;
    }

    let cancelled = false;
    const checkAdmin = async () => {
      setIsAdminVerifying(true);
      try {
        const ver = await verifyAdminPrivileges(auth.currentUser);
        if (cancelled) return;
        const postDecision = evaluateAdminRouteAccess({
          route: appRoute,
          isAuthChecking: false,
          hasAuthenticatedSession: Boolean(auth.currentUser),
          hasVerifiedAdmin: false,
          verificationResult: ver,
        });

        if (postDecision.action === 'allow' && ver.authorized && ver.admin) {
          setAdminUser(ver.admin);
          setAdminAccessNotice(null);
          if (window.location.pathname !== '/admin') {
            navigateToRoute('admin_dashboard', { replace: true });
          }
        } else {
          setAdminUser(null);
          if (postDecision.shouldSignOut) {
            await signOutAdmin().catch(() => {});
          }
          if (postDecision.notice !== undefined) {
            setAdminAccessNotice(postDecision.notice ?? null);
          }
          if (postDecision.redirectTo) {
            navigateToRoute(postDecision.redirectTo, { replace: true });
          }
        }
      } catch {
        if (!cancelled && appRoute === 'admin_dashboard') {
          setAdminUser(null);
          setAdminAccessNotice(
            'Unable to verify administrator privileges. Please sign in with an authorized administrator account.'
          );
          navigateToRoute('admin_login', { replace: true });
        }
      } finally {
        if (!cancelled) {
          setIsAdminVerifying(false);
        }
      }
    };

    checkAdmin();
    return () => {
      cancelled = true;
    };
    // Intentionally omit firebaseUser?.id so onAuthStateChanged during active AdminLoginScreen
    // submission does not fire duplicate verifyAdminPrivileges() calls or race with error display.
  }, [appRoute, adminUser, isAuthChecking, navigateToRoute]);

  // Load reports for the currently signed-in user from Cloud Firestore
  const loadReportsForUser = useCallback(async (userId: string) => {
    setIsLoadingReports(true);
    setReportsError(null);
    try {
      const res = await fetchUserReportsFromFirestore(userId);
      const ownedReports = filterReportsForCitizen(res.reports, userId);
      setUserReports(ownedReports);
      setSelectedReport((prev) => syncSelectedReport(prev, ownedReports));
      setIsReportsFromCloud(res.fromCloud);
      refreshPendingCounts(userId, ownedReports);
      if (res.error) {
        setReportsError(res.error);
      }
    } catch (err: any) {
      setReportsError(toUserFriendlyErrorMessage(err, 'load_complaints'));
    } finally {
      setIsLoadingReports(false);
    }
  }, [refreshPendingCounts]);

  // Subscribe to Firebase Authentication state changes (persists across browser refreshes)
  useEffect(() => {
    const fallbackTimer = setTimeout(() => {
      setIsAuthChecking(false);
    }, 2000);

    const unsubscribe = onCitizenAuthStateChanged((citizenUser) => {
      clearTimeout(fallbackTimer);
      if (citizenUser) {
        setFirebaseUser(citizenUser);
      } else {
        setFirebaseUser(null);
        setAdminUser(null);
        setUserReports([]);
        setSelectedReport(null);
        setIsReportsFromCloud(false);
        setReportsError(null);
        setSyncFeedback(null);
      }
      setIsAuthChecking(false);
    });

    return () => {
      clearTimeout(fallbackTimer);
      unsubscribe();
    };
  }, []);

  // Real-time synchronization: subscribe to citizen reports from Cloud Firestore
  useEffect(() => {
    if (!firebaseUser?.id) {
      setUserReports([]);
      setIsReportsFromCloud(false);
      refreshPendingCounts(null);
      return;
    }

    setIsLoadingReports(true);
    setReportsError(null);
    refreshPendingCounts(firebaseUser.id);

    const unsubscribe = subscribeToUserReportsFromFirestore(
      firebaseUser.id,
      (reports) => {
        const ownedReports = filterReportsForCitizen(reports, firebaseUser.id);
        setUserReports(ownedReports);
        setSelectedReport((prev) => syncSelectedReport(prev, ownedReports));
        setIsReportsFromCloud(true);
        setIsLoadingReports(false);
        refreshPendingCounts(firebaseUser.id, ownedReports);
      },
      (err) => {
        console.warn('Real-time citizen reports sync notice:', err);
        setReportsError(toUserFriendlyErrorMessage(err, 'load_complaints'));
        setIsLoadingReports(false);
        refreshPendingCounts(firebaseUser.id);
      }
    );

    return () => {
      unsubscribe();
    };
  }, [firebaseUser?.id, refreshPendingCounts]);

  // Auth Handlers
  const handleAuthSuccess = (citizen: CitizenUser) => {
    setFirebaseUser(citizen);
    setActiveTab('home');
  };

  const handleSignOut = async () => {
    const signingOutUid = firebaseUser?.id;
    try {
      await signOutCitizen();
      if (signingOutUid) {
        clearPendingWithdrawals(signingOutUid);
      }
      setFirebaseUser(null);
      setUserReports([]);
      setSelectedReport(null);
      setReportsError(null);
      setSyncFeedback(null);
      refreshPendingCounts(null);
      setActiveTab('home');
      setAuthMode('login');
    } catch (err) {
      console.error('Sign out error:', err);
      throw err;
    }
  };

  // Report Creation Handler: updates state without closing the feedback modal prematurely
  const handleCreateReport = (newReport: CivicIssueReport) => {
    if (!firebaseUser?.id || newReport.userId !== firebaseUser.id) {
      console.warn('Rejected citizen report state update with mismatched ownership.');
      return;
    }
    setUserReports((prev) => {
      const filtered = prev.filter((r) => r.id !== newReport.id);
      const nextList = sortReportsNewestFirst([newReport, ...filtered]);
      refreshPendingCounts(firebaseUser?.id, nextList);
      return nextList;
    });
    setSelectedReport(newReport);
  };

  // Callback when citizen adds follow-up note to their own report
  const handleAddReportNote = async (reportId: string, noteText: string) => {
    if (!firebaseUser?.id) {
      return { success: false, error: 'You must be signed in to add follow-up notes.' };
    }
    const res = await addCitizenNoteToFirestore(reportId, noteText, firebaseUser.id);
    if ((res.success || res.isPendingSync) && res.formattedNote) {
      const noteToAppend = res.formattedNote;
      const updatedTimestamp = res.updatedAt || new Date().toISOString();
      setUserReports((prev) => {
        const nextList = prev.map((r) => {
          if (r.id !== reportId) return r;
          const existingNotes = Array.isArray(r.citizenNotes) ? r.citizenNotes : [];
          const nextNotes = existingNotes.includes(noteToAppend)
            ? existingNotes
            : [...existingNotes, noteToAppend];
          return {
            ...r,
            citizenNotes: nextNotes,
            updatedAt: updatedTimestamp,
          };
        });
        refreshPendingCounts(firebaseUser.id, nextList);
        return nextList;
      });
      setSelectedReport((prev) => {
        if (!prev || prev.id !== reportId) return prev;
        const existingNotes = Array.isArray(prev.citizenNotes) ? prev.citizenNotes : [];
        const nextNotes = existingNotes.includes(noteToAppend)
          ? existingNotes
          : [...existingNotes, noteToAppend];
        return {
          ...prev,
          citizenNotes: nextNotes,
          updatedAt: updatedTimestamp,
        };
      });
    } else {
      refreshPendingCounts(firebaseUser.id);
    }
    return res;
  };

  // Callback when citizen withdraws an accidentally submitted report
  const handleWithdrawReport = async (reportId: string) => {
    if (!firebaseUser) {
      return { success: false, error: 'User must be signed in to withdraw reports.' };
    }
    const currentRep =
      userReports.find((r) => r.id === reportId) ||
      (selectedReport?.id === reportId ? selectedReport : undefined);

    const res = await withdrawReportInFirestore(reportId, firebaseUser, currentRep);
    if (res.success && res.report) {
      const updated = res.report;
      setUserReports((prev) => {
        const nextList = prev.map((r) => (r.id === reportId ? updated : r));
        refreshPendingCounts(firebaseUser.id, nextList);
        return nextList;
      });
      if (selectedReport && selectedReport.id === reportId) {
        setSelectedReport(updated);
      }
    } else {
      refreshPendingCounts(firebaseUser.id);
    }
    return res;
  };

  const handleSyncPendingReports = useCallback(async () => {
    const uid = firebaseUser?.id;
    if (!uid || syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    setIsSyncingPending(true);
    setSyncFeedback(null);
    try {
      const syncRes = await syncPendingReportsToFirestore(uid);
      await loadReportsForUser(uid);

      const remaining = getPendingSyncCounts(uid);
      setPendingSyncCounts(remaining);

      const failedTotal =
        syncRes.failedReportsCount +
        syncRes.failedNotesCount +
        syncRes.failedWithdrawalsCount;

      if (failedTotal > 0 && syncRes.syncedCount > 0) {
        setSyncFeedback({
          type: 'partial',
          message: syncRes.summaryMessage,
        });
      } else if (failedTotal > 0 || (syncRes.syncedCount === 0 && syncRes.errors.length > 0)) {
        setSyncFeedback({
          type: 'error',
          message: syncRes.summaryMessage || syncRes.errors[0],
        });
      } else if (remaining.total > 0) {
        setSyncFeedback({
          type: 'partial',
          message: syncRes.summaryMessage,
        });
      } else if (syncRes.syncedCount > 0) {
        setSyncFeedback({
          type: 'success',
          message: syncRes.summaryMessage,
        });
      }
    } catch (err: any) {
      console.warn('Sync pending failed:', err);
      refreshPendingCounts(uid);
      setSyncFeedback({
        type: 'error',
        message: toUserFriendlyErrorMessage(err, 'sync_reports'),
      });
    } finally {
      syncInFlightRef.current = false;
      setIsSyncingPending(false);
    }
  }, [firebaseUser?.id, loadReportsForUser, refreshPendingCounts]);

  // Lightweight browser online listener to auto-sync pending reports, notes, and withdrawals
  useEffect(() => {
    const uid = firebaseUser?.id;
    if (!uid || typeof window === 'undefined') return;

    const handleOnline = () => {
      if (hasPendingOfflineSync(uid)) {
        handleSyncPendingReports();
      }
    };

    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('online', handleOnline);
    };
  }, [firebaseUser?.id, handleSyncPendingReports]);

  const handleUpdateUser = (updatedUser: CitizenUser) => {
    setFirebaseUser(updatedUser);
  };

  // Determine whether to show the main application shell with bottom navigation
  const isAuthenticated = Boolean(firebaseUser && firebaseUser.id);

  // 1. ADMIN LOGIN ROUTE (/admin/login)
  if (appRoute === 'admin_login') {
    if (isAuthChecking) {
      return (
        <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center text-slate-300">
          <Loader2 className="w-8 h-8 text-emerald-500 animate-spin mb-3" />
          <p className="text-xs font-medium">Checking Administrator Session...</p>
        </div>
      );
    }

    return (
      <AdminLoginScreen
        sessionNotice={adminAccessNotice}
        onLoginSuccess={(admin) => {
          setAdminAccessNotice(null);
          setAdminUser(admin);
          navigateToRoute('admin_dashboard', { replace: true });
        }}
        onReturnToCitizen={() => {
          setAdminAccessNotice(null);
          navigateToRoute('citizen');
        }}
      />
    );
  }

  // 2. ADMIN DASHBOARD ROUTE (/admin and /admin/*)
  if (appRoute === 'admin_dashboard') {
    if (isAuthChecking || isAdminVerifying || !adminUser) {
      return (
        <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center text-slate-300">
          <Loader2 className="w-8 h-8 text-emerald-500 animate-spin mb-3" />
          <p className="text-xs font-medium">Verifying Municipal Administrator Privileges...</p>
        </div>
      );
    }

    return (
      <AdminDashboard
        admin={adminUser}
        onLogout={() => {
          setAdminAccessNotice(null);
          setAdminUser(null);
          navigateToRoute('admin_login', { replace: true });
        }}
      />
    );
  }

  // 3. CITIZEN WEB APPLICATION ROUTE (/)
  return (
    <CitizenShell
      activeTab={activeTab}
      onChangeTab={setActiveTab}
      pendingReportsCount={userReports.filter((r) => !r.archived && (r.status === 'Submitted' || r.status === 'Under Review')).length}
      showNav={isAuthenticated}
    >
      {/* 1. INITIAL AUTH CHECK LOADING STATE */}
      {isAuthChecking ? (
        <div className="min-h-screen w-full flex flex-col items-center justify-center p-6 bg-[#FAFBF9] dark:bg-[#0c1322] text-center">
          <div className="w-16 h-16 rounded-2xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 flex items-center justify-center mb-4 shadow-sm">
            <CivifixLogo className="w-10 h-10" />
          </div>
          <div className="flex items-center gap-2 text-slate-800 dark:text-slate-100">
            <Loader2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 animate-spin" />
            <h2 className="text-base font-bold">Restoring Your Session</h2>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 max-w-xs leading-relaxed">
            Restoring your verified citizen credentials...
          </p>
        </div>
      ) : !isAuthenticated ? (
        /* 2. SIGNED-OUT: SHOW AUTH SCREEN (NO BOTTOM NAVIGATION) */
        <AuthScreen
          initialMode={authMode}
          onAuthSuccess={handleAuthSuccess}
          onOpenAdminPortal={() => navigateToRoute('admin_login')}
        />
      ) : (
        /* 3. AUTHENTICATED CITIZEN APPLICATION (WITH BOTTOM NAVIGATION) */
        <>
          {/* SCREEN 1: HOME */}
          {activeTab === 'home' && (
            <HomeScreen
              user={firebaseUser!}
              isFirebaseUser={true}
              userReports={userReports}
              onNavigateToReport={() => setActiveTab('report')}
              onNavigateToReports={() => setActiveTab('reports')}
              onNavigateToProfile={() => setActiveTab('profile')}
              onSelectReport={(report) => {
                if (report.userId !== firebaseUser?.id) return;
                setSelectedReport(report);
                setActiveTab('reports');
              }}
            />
          )}

          {/* SCREEN 2: REPORT */}
          {activeTab === 'report' && (
            <ReportIssueScreen
              user={firebaseUser!}
              existingReports={userReports}
              onReportCreated={handleCreateReport}
              onCancel={() => setActiveTab('home')}
              onNavigateToMyReports={() => setActiveTab('reports')}
            />
          )}

          {/* SCREEN 3: MY REPORTS */}
          {activeTab === 'reports' && (
            <MyReportsScreen
              userReports={userReports}
              selectedReport={selectedReport}
              onSelectReport={(report) => {
                if (!report || report.userId === firebaseUser?.id) {
                  setSelectedReport(report);
                }
              }}
              onNavigateToNewReport={() => setActiveTab('report')}
              onAddNote={handleAddReportNote}
              onWithdrawReport={handleWithdrawReport}
              isLoadingReports={isLoadingReports}
              isFromCloud={isReportsFromCloud}
              cloudError={reportsError}
              onRefreshReports={() => firebaseUser?.id && loadReportsForUser(firebaseUser.id)}
              onSyncPendingReports={handleSyncPendingReports}
              isSyncingPending={isSyncingPending}
              pendingSyncCounts={pendingSyncCounts}
              syncFeedback={syncFeedback}
              onDismissSyncFeedback={() => setSyncFeedback(null)}
              onBack={() => setActiveTab('home')}
            />
          )}

          {/* SCREEN 4: CIVIC AI */}
          {activeTab === 'civic_ai' && (
            <CivicAiScreen
              onBack={() => setActiveTab('home')}
              onNavigateToReport={() => setActiveTab('report')}
              onNavigateToMyReports={() => setActiveTab('reports')}
            />
          )}

          {/* SCREEN 5: PROFILE */}
          {activeTab === 'profile' && (
            <ProfileSettingsScreen
              user={firebaseUser!}
              userReports={userReports}
              isFirebaseUser={true}
              onUpdateUser={handleUpdateUser}
              onSignOut={handleSignOut}
            />
          )}
        </>
      )}
    </CitizenShell>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <LanguageProvider>
        <AppContent />
      </LanguageProvider>
    </ThemeProvider>
  );
}
