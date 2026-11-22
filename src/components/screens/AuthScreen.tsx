import React, { useState } from 'react';
import {
  ArrowLeft,
  Mail,
  Lock,
  User,
  MapPin,
  CheckCircle2,
  AlertCircle,
  Eye,
  EyeOff,
  Phone,
  X,
  ShieldCheck,
} from 'lucide-react';
import { CitizenUser } from '../../types/civic';
import {
  loginCitizen,
  loginWithGoogle,
  registerCitizen,
  getFriendlyAuthErrorMessage,
  sendCitizenPasswordReset,
} from '../../services/authService';
import { CivifixLogo, CitySkylineIllustration } from '../CivifixLogo';

interface AuthScreenProps {
  onBack?: () => void;
  onAuthSuccess: (user: CitizenUser) => void;
  initialMode?: 'login' | 'register';
  onOpenAdminPortal?: () => void;
}

export const AuthScreen: React.FC<AuthScreenProps> = ({
  onBack,
  onAuthSuccess,
  initialMode = 'login',
  onOpenAdminPortal,
}) => {
  const [isRegister, setIsRegister] = useState(initialMode === 'register');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [ward, setWard] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Forgot password modal state
  const [showForgotPasswordModal, setShowForgotPasswordModal] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [isSendingReset, setIsSendingReset] = useState(false);
  const [resetFeedback, setResetFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleToggleMode = (registerMode: boolean) => {
    setIsRegister(registerMode);
    setErrorMessage(null);
    setSuccessMessage(null);
    setShowForgotPasswordModal(false);
  };

  const validateInputs = (): string | null => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      return 'Please enter your email address.';
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmedEmail)) {
      return 'Please enter a valid email format (e.g. name@domain.com).';
    }

    if (!password) {
      return 'Please enter a password.';
    }

    if (password.length < 6) {
      return 'Password must be at least 6 characters long.';
    }

    if (isRegister) {
      if (!fullName.trim()) {
        return 'Please enter your full legal or citizen name.';
      }
      const cleanedPhone = phone.trim().replace(/[\s-]/g, '');
      if (!cleanedPhone) {
        return 'Please enter your mobile phone number.';
      }
      if (cleanedPhone.replace(/\D/g, '').length < 10) {
        return 'Please enter a valid 10-digit mobile phone number.';
      }
      if (!ward || ward.trim() === '') {
        return 'Please select your residential ward from the supported municipal wards list.';
      }
      if (password !== confirmPassword) {
        return 'Passwords do not match. Please verify your confirmation password.';
      }
    }

    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    const validationError = validateInputs();
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    setIsLoading(true);

    try {
      if (isRegister) {
        const newUser = await registerCitizen({
          email: email.trim(),
          password,
          fullName: fullName.trim(),
          phone: phone.trim() || undefined,
          ward: ward.trim() || undefined,
        });

        setSuccessMessage('Account registered successfully! Welcome to CiviFix AI.');
        setTimeout(() => {
          onAuthSuccess(newUser);
        }, 500);
      } else {
        const authenticatedUser = await loginCitizen({
          email: email.trim(),
          password,
        });

        setSuccessMessage('Signed in successfully! Loading your civic dashboard...');
        setTimeout(() => {
          onAuthSuccess(authenticatedUser);
        }, 400);
      }
    } catch (err: unknown) {
      const friendlyError = getFriendlyAuthErrorMessage(err);
      setErrorMessage(friendlyError);
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsLoading(true);
    try {
      const googleUser = await loginWithGoogle();
      setSuccessMessage('Signed in with Google! Loading your civic dashboard...');
      setTimeout(() => {
        onAuthSuccess(googleUser);
      }, 350);
    } catch (err: unknown) {
      setErrorMessage(getFriendlyAuthErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenForgotPassword = () => {
    setResetEmail(email.trim());
    setResetFeedback(null);
    setShowForgotPasswordModal(true);
  };

  const handleSendPasswordReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setResetFeedback(null);
    setIsSendingReset(true);

    try {
      const res = await sendCitizenPasswordReset(resetEmail);
      setResetFeedback({
        type: res.success ? 'success' : 'error',
        text: res.message,
      });
    } catch (err: any) {
      setResetFeedback({
        type: 'error',
        text: getFriendlyAuthErrorMessage(err),
      });
    } finally {
      setIsSendingReset(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex-1 flex flex-col justify-between bg-[#FAFBF9] dark:bg-[#0c1322] text-slate-900 dark:text-slate-100 select-none overflow-x-hidden transition-colors">
      {/* Top Navigation Bar: Optional Back + Admin Portal */}
      {(onBack || onOpenAdminPortal) && (
        <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 pt-4 flex items-center justify-between gap-3">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="w-9 h-9 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer"
              aria-label="Back"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          ) : (
            <div />
          )}

          {onOpenAdminPortal && (
            <button
              type="button"
              onClick={onOpenAdminPortal}
              aria-label="Go to Admin Portal"
              title="Go to Admin Portal"
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-xl border border-emerald-200 dark:border-emerald-800 bg-white dark:bg-slate-900 hover:bg-emerald-50 dark:hover:bg-emerald-950/60 text-[#064E3B] dark:text-emerald-300 text-xs sm:text-sm font-semibold shadow-2xs transition-colors cursor-pointer whitespace-nowrap"
            >
              <ShieldCheck className="w-4 h-4 text-[#059669] dark:text-emerald-400 shrink-0" />
              <span>Admin Portal</span>
            </button>
          )}
        </div>
      )}

      {/* Main Centered Auth Card */}
      <div className="px-4 sm:px-6 py-8 sm:py-12 flex-1 flex flex-col justify-center w-full">
        <div className="w-full max-w-md mx-auto sm:bg-white sm:dark:bg-slate-900/90 sm:border sm:border-slate-200/80 sm:dark:border-slate-800 sm:rounded-3xl sm:p-8 sm:shadow-sm">
          {/* Brand Header: Logo, Title, Subtitle, Tagline */}
          <div className="text-center mb-6">
            <div className="flex justify-center mb-2.5">
              <CivifixLogo className="w-16 h-16 drop-shadow-sm" />
            </div>
            <h1 className="text-2xl font-extrabold tracking-tight text-[#064E3B] dark:text-emerald-400">
              CiviFix AI
            </h1>
            <p className="text-xs font-semibold text-emerald-800 dark:text-emerald-300 tracking-wide mt-0.5">
              Civic Intelligence &amp; Awareness
            </p>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-2 font-medium">
              {isRegister ? 'Join our community for a cleaner city' : 'Better neighbourhoods start with us'}
            </p>
          </div>

        {/* Feedback Alerts */}
        {errorMessage && (
          <div className="mb-4 p-3 rounded-2xl bg-red-50 border border-red-200 text-red-800 text-xs flex items-start gap-2 animate-fadeIn">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <div className="flex-1">
              <span className="font-semibold block">Sign-In Issue</span>
              <p className="text-[11px] text-red-700 mt-0.5">{errorMessage}</p>
            </div>
          </div>
        )}

        {successMessage && (
          <div className="mb-4 p-3 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2 animate-fadeIn">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span className="font-semibold text-[11px]">{successMessage}</span>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-3.5">
          {/* Registration Mode: Full Legal Name */}
          {isRegister && (
            <div>
              <div className="relative">
                <User className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5 pointer-events-none" />
                <input
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Full Name"
                  disabled={isLoading}
                  className="w-full h-11 pl-10 pr-3 rounded-2xl bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600 shadow-sm"
                />
              </div>
            </div>
          )}

          {/* Email Address */}
          <div>
            <div className="relative">
              <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5 pointer-events-none" />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email address"
                disabled={isLoading}
                autoComplete="email"
                className="w-full h-11 pl-10 pr-3 rounded-2xl bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600 shadow-sm"
              />
            </div>
          </div>

          {/* Registration Mode: Mobile Phone & Ward */}
          {isRegister && (
            <>
              <div>
                <div className="relative">
                  <Phone className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5 pointer-events-none" />
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="Mobile Number (+91 ...)"
                    disabled={isLoading}
                    className="w-full h-11 pl-10 pr-3 rounded-2xl bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600 shadow-sm"
                  />
                </div>
              </div>

              <div>
                <div className="relative">
                  <MapPin className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5 pointer-events-none" />
                  <select
                    required
                    value={ward}
                    onChange={(e) => setWard(e.target.value)}
                    disabled={isLoading}
                    className="w-full h-11 pl-10 pr-3 rounded-2xl bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600 shadow-sm"
                  >
                    <option value="">Select your residential ward...</option>
                    <option value="Ward 111 - MG Road Central">Ward 111 - MG Road Central</option>
                    <option value="Ward 74 - Indiranagar East">Ward 74 - Indiranagar East</option>
                    <option value="Ward 151 - Koramangala South">Ward 151 - Koramangala South</option>
                    <option value="Ward 177 - JP Nagar 2nd Phase">Ward 177 - JP Nagar 2nd Phase</option>
                    <option value="Ward 47 - Metro Green Zone">Ward 47 - Metro Green Zone</option>
                  </select>
                </div>
              </div>
            </>
          )}

          {/* Password */}
          <div>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5 pointer-events-none" />
              <input
                type={showPassword ? 'text' : 'password'}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                disabled={isLoading}
                autoComplete={isRegister ? 'new-password' : 'current-password'}
                className="w-full h-11 pl-10 pr-10 rounded-2xl bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600 shadow-sm"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3.5 top-3 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer p-0.5"
                aria-label="Toggle password visibility"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Confirm Password (Registration Only) */}
          {isRegister && (
            <div>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5 pointer-events-none" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm Password"
                  disabled={isLoading}
                  autoComplete="new-password"
                  className="w-full h-11 pl-10 pr-3 rounded-2xl bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600 shadow-sm"
                />
              </div>
            </div>
          )}

          {/* Primary Action Button ("Sign In" or "Register Account") */}
          <button
            type="submit"
            disabled={isLoading}
            className="w-full h-12 rounded-2xl bg-[#059669] hover:bg-[#047857] active:bg-[#065F46] disabled:opacity-70 text-white font-bold text-sm flex items-center justify-center gap-2 shadow-md shadow-emerald-900/20 active:scale-[0.99] transition-all cursor-pointer mt-2"
          >
            {isLoading ? (
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <span>{isRegister ? 'Creating Account...' : 'Signing In...'}</span>
              </span>
            ) : (
              <span>{isRegister ? 'Create Citizen Account' : 'Sign In'}</span>
            )}
          </button>

          {/* Forgot Password Link (Login Mode) */}
          {!isRegister && (
            <div className="text-center pt-1">
              <button
                type="button"
                onClick={handleOpenForgotPassword}
                className="text-xs font-semibold text-emerald-800 dark:text-emerald-400 hover:text-emerald-950 dark:hover:text-emerald-300 transition-colors cursor-pointer"
              >
                Forgot Password?
              </button>
            </div>
          )}

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
                d="M23.745 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-8.97z"
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

          {/* Secondary Action: "Create Account" or "Back to Sign In" */}
          {!isRegister ? (
            <button
              type="button"
              onClick={() => handleToggleMode(true)}
              className="w-full h-11 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/70 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 font-bold text-xs flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <User className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
              <span>Create Account</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => handleToggleMode(false)}
              className="w-full h-11 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/70 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 font-bold text-xs flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <span>Already have an account? Sign In</span>
            </button>
          )}
        </form>
        </div>
      </div>

      {/* Forgot Password Modal Dialog */}
      {showForgotPasswordModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-xs animate-in fade-in">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 max-w-sm w-full shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-emerald-100 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-400 flex items-center justify-center">
                  <Mail className="w-4 h-4" />
                </div>
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">Reset Account Password</h3>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowForgotPasswordModal(false);
                  setResetFeedback(null);
                }}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Enter your registered citizen email address. We will send a secure password reset link to your email.
            </p>

            {resetFeedback && (
              <div
                className={`p-3 rounded-2xl border text-xs flex items-start gap-2 ${
                  resetFeedback.type === 'success'
                    ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
                    : 'bg-rose-50 dark:bg-rose-950/60 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-200'
                }`}
              >
                {resetFeedback.type === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
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
                  placeholder="name@domain.com"
                  disabled={isSendingReset}
                  className="w-full h-11 pl-10 pr-3 rounded-2xl bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600 shadow-sm"
                />
              </div>

              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setShowForgotPasswordModal(false);
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
                  className="flex-1 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:opacity-70 text-white font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer transition shadow-xs"
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

      {/* Stylized Green City Skyline at Bottom (As shown in Screen 1) */}
      <div className="w-full shrink-0 leading-none mt-auto select-none pointer-events-none">
        <CitySkylineIllustration className="w-full h-24 text-emerald-600" />
      </div>
    </div>
  );
};
