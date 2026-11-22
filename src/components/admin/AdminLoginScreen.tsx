import React, { useState, useEffect } from 'react';
import {
  Lock,
  Mail,
  ArrowLeft,
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  X,
} from 'lucide-react';
import {
  signInAdminWithCredentials,
  signInAdminWithGoogle,
  sendAdminPasswordReset,
} from '../../services/adminService';
import { AdminUser } from '../../types/civic';
import { CivifixLogo, CitySkylineIllustration } from '../CivifixLogo';

const REMEMBER_ADMIN_EMAIL_KEY = 'civifix_admin_remember_email';

interface AdminLoginScreenProps {
  onLoginSuccess: (admin: AdminUser) => void;
  onReturnToCitizen: () => void;
  sessionNotice?: string | null;
}

export const AdminLoginScreen: React.FC<AdminLoginScreenProps> = ({
  onLoginSuccess,
  onReturnToCitizen,
  sessionNotice = null,
}) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Forgot Password modal state
  const [showForgotModal, setShowForgotModal] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [isSendingReset, setIsSendingReset] = useState(false);
  const [resetFeedback, setResetFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Restore remembered administrator email (never passwords) if opted in
  useEffect(() => {
    try {
      const savedEmail = window.localStorage.getItem(REMEMBER_ADMIN_EMAIL_KEY);
      if (savedEmail) {
        setEmail(savedEmail);
        setRememberMe(true);
      }
    } catch {
      // Ignore storage access errors in restricted environments
    }
  }, []);

  const persistRememberedEmail = (trimmedEmail: string, shouldRemember: boolean) => {
    try {
      if (shouldRemember && trimmedEmail) {
        window.localStorage.setItem(REMEMBER_ADMIN_EMAIL_KEY, trimmedEmail);
      } else {
        window.localStorage.removeItem(REMEMBER_ADMIN_EMAIL_KEY);
      }
    } catch {
      // Ignore storage errors
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim();

    if (!trimmedEmail || !password) {
      setErrorMessage('Please enter both your administrator email and password.');
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      const res = await signInAdminWithCredentials(trimmedEmail, password, rememberMe);
      if (res.success && res.admin) {
        persistRememberedEmail(trimmedEmail, rememberMe);
        onLoginSuccess(res.admin);
      } else {
        setErrorMessage(
          res.error ||
            'Access Denied: This account is not authorized as a municipal administrator.'
        );
      }
    } catch {
      setErrorMessage('Authentication error. Please check your credentials and try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const res = await signInAdminWithGoogle();
      if (res.success && res.admin) {
        onLoginSuccess(res.admin);
      } else {
        setErrorMessage(
          res.error ||
            'Access Denied: Your Google account does not have municipal administrator clearance.'
        );
      }
    } catch {
      setErrorMessage('Google Sign-In failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenForgotPassword = () => {
    setResetEmail(email.trim());
    setResetFeedback(null);
    setShowForgotModal(true);
  };

  const handleSendPasswordReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setResetFeedback(null);
    setIsSendingReset(true);

    try {
      const res = await sendAdminPasswordReset(resetEmail);
      setResetFeedback({
        type: res.success ? 'success' : 'error',
        text: res.message,
      });
    } catch {
      setResetFeedback({
        type: 'error',
        text: 'Could not send password reset email right now. Please try again.',
      });
    } finally {
      setIsSendingReset(false);
    }
  };

  const activeAlert = errorMessage || sessionNotice;

  return (
    <div className="min-h-screen w-full flex flex-col justify-between bg-white dark:bg-[#0c1322] text-slate-900 dark:text-slate-100 select-none overflow-y-auto transition-colors">
      {/* Top Utility Ribbon */}
      <header className="w-full max-w-5xl mx-auto px-5 pt-3 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onReturnToCitizen}
          disabled={isLoading}
          aria-label="Return to Citizen Portal"
          title="Return to Citizen Portal"
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-xl bg-white dark:bg-slate-900 hover:bg-emerald-50 dark:hover:bg-emerald-950/50 text-[#064E3B] dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 text-xs font-semibold transition-colors cursor-pointer disabled:opacity-60 whitespace-nowrap"
        >
          <ArrowLeft className="w-3.5 h-3.5 text-[#059669] dark:text-emerald-400 shrink-0" />
          <span>Citizen Portal</span>
        </button>

        <span className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950 px-2 py-0.5 rounded-md border border-emerald-200 dark:border-emerald-800">
          Municipal Operations
        </span>
      </header>

      {/* Main Container */}
      <main className="px-6 py-4 flex-1 flex flex-col justify-center max-w-sm mx-auto w-full">
        {/* Brand Header: Logo, Title, Subtitle, Tagline */}
        <div className="text-center mb-6">
          <div className="flex justify-center mb-2">
            <CivifixLogo className="w-16 h-16 drop-shadow-sm" />
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight text-[#064E3B] dark:text-emerald-400">
            CiviFix AI
          </h1>
          <h2 className="text-xs font-semibold text-emerald-800 dark:text-emerald-300 tracking-wide mt-0.5">
            Administrator Login
          </h2>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-2 font-medium">
            Authorized Municipal Portal Access
          </p>
        </div>

        {/* Error / Session Notice Alert */}
        {activeAlert && (
          <div
            role="alert"
            className="mb-4 p-3 rounded-2xl bg-red-50 dark:bg-rose-950/60 border border-red-200 dark:border-rose-800 text-red-800 dark:text-rose-200 text-xs flex items-start gap-2"
          >
            <AlertCircle className="w-4 h-4 text-red-600 dark:text-rose-400 shrink-0 mt-0.5" />
            <div className="flex-1">
              <span className="font-semibold block">
                {errorMessage ? 'Sign-In Issue' : 'Administrator Access Required'}
              </span>
              <p className="text-[11px] text-red-700 dark:text-rose-200/90 mt-0.5 leading-relaxed">
                {activeAlert}
              </p>
            </div>
          </div>
        )}

        {/* Email & Password Form */}
        <form onSubmit={handleSubmit} className="space-y-3.5" noValidate>
          {/* Email Address */}
          <div>
            <div className="relative">
              <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5 pointer-events-none" />
              <input
                id="admin-email"
                type="email"
                required
                autoComplete="email"
                aria-label="Administrator email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isLoading}
                placeholder="Email address"
                className="w-full h-11 pl-10 pr-3 rounded-2xl bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600 shadow-sm disabled:opacity-60 transition-colors"
              />
            </div>
          </div>

          {/* Password */}
          <div>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5 pointer-events-none" />
              <input
                id="admin-password"
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete="current-password"
                aria-label="Administrator password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isLoading}
                placeholder="Password"
                className="w-full h-11 pl-10 pr-10 rounded-2xl bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600 shadow-sm disabled:opacity-60 transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                disabled={isLoading}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-3.5 top-3 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer p-0.5 disabled:opacity-60"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Remember me & Forgot Password */}
          <div className="flex items-center justify-between gap-3 px-0.5">
            <label className="inline-flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                disabled={isLoading}
                className="w-3.5 h-3.5 rounded border-slate-300 dark:border-slate-700 accent-[#059669] focus:ring-emerald-600 cursor-pointer"
              />
              <span>Remember me</span>
            </label>

            <button
              type="button"
              onClick={handleOpenForgotPassword}
              disabled={isLoading}
              className="text-xs font-semibold text-emerald-800 dark:text-emerald-400 hover:text-emerald-950 dark:hover:text-emerald-300 transition-colors cursor-pointer disabled:opacity-60"
            >
              Forgot Password?
            </button>
          </div>

          {/* Primary Sign In Button */}
          <button
            type="submit"
            disabled={isLoading}
            className="w-full h-12 rounded-2xl bg-[#059669] hover:bg-[#047857] active:bg-[#065F46] disabled:opacity-70 text-white font-bold text-sm flex items-center justify-center gap-2 shadow-md shadow-emerald-900/20 active:scale-[0.99] transition-all cursor-pointer mt-2"
          >
            {isLoading ? (
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <span>Signing In...</span>
              </span>
            ) : (
              <span>Sign In</span>
            )}
          </button>

          {/* "or" divider */}
          <div className="flex items-center gap-3 my-2 text-slate-400 text-xs">
            <div className="flex-1 h-px bg-slate-200 dark:bg-slate-800" />
            <span className="text-[11px] font-medium text-slate-400">or</span>
            <div className="flex-1 h-px bg-slate-200 dark:bg-slate-800" />
          </div>

          {/* Google Sign-In */}
          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={isLoading}
            className="w-full h-11 rounded-2xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-100 font-semibold text-xs flex items-center justify-center gap-2.5 transition-colors cursor-pointer shadow-xs disabled:opacity-60"
          >
            <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M23.745 12.27c0-.79-.06-1.54-.19-2.27H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-8.97z"
              />
              <path
                fill="#34A853"
                d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24z"
              />
              <path
                fill="#FBBC05"
                d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14z"
              />
              <path
                fill="#EA4335"
                d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96z"
              />
            </svg>
            <span>Continue with Google</span>
          </button>
        </form>
      </main>

      {/* Forgot Password Modal Dialog */}
      {showForgotModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="admin-reset-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-xs"
        >
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 max-w-sm w-full shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-emerald-100 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-400 flex items-center justify-center">
                  <Mail className="w-4 h-4" />
                </div>
                <h3
                  id="admin-reset-title"
                  className="text-sm font-bold text-slate-900 dark:text-white"
                >
                  Reset Administrator Password
                </h3>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowForgotModal(false);
                  setResetFeedback(null);
                }}
                disabled={isSendingReset}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                aria-label="Close password reset dialog"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Enter your registered administrator email address. We will send a secure password reset link to your email.
            </p>

            {resetFeedback && (
              <div
                role="alert"
                className={`p-3 rounded-2xl border text-xs flex items-start gap-2 ${
                  resetFeedback.type === 'success'
                    ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
                    : 'bg-rose-50 dark:bg-rose-950/60 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-200'
                }`}
              >
                {resetFeedback.type === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
                )}
                <span className="text-[11px] leading-relaxed">{resetFeedback.text}</span>
              </div>
            )}

            <form onSubmit={handleSendPasswordReset} className="space-y-3">
              <div className="relative">
                <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5 pointer-events-none" />
                <input
                  type="email"
                  required
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  placeholder="admin@municipality.gov"
                  disabled={isSendingReset}
                  className="w-full h-11 pl-10 pr-3 rounded-2xl bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600 shadow-sm"
                />
              </div>

              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setShowForgotModal(false);
                    setResetFeedback(null);
                  }}
                  disabled={isSendingReset}
                  className="flex-1 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-bold text-xs cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSendingReset}
                  className="flex-1 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:opacity-70 text-white font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer transition shadow-xs whitespace-nowrap"
                >
                  {isSendingReset ? (
                    <span className="flex items-center gap-1.5">
                      <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      <span>Sending...</span>
                    </span>
                  ) : (
                    <span>Send Reset Link</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Stylized Green City Skyline at Bottom */}
      <div className="w-full shrink-0 leading-none mt-auto select-none pointer-events-none">
        <CitySkylineIllustration className="w-full h-24 text-emerald-600" />
      </div>
    </div>
  );
};
