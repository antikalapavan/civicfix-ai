import React, { useState, useEffect } from 'react';
import {
  User,
  Mail,
  Phone,
  MapPin,
  Bell,
  Shield,
  LogOut,
  Camera,
  Edit3,
  Globe,
  Sun,
  Moon,
  Laptop,
  Check,
  X,
  Loader2,
  AlertCircle,
  ChevronDown,
} from 'lucide-react';
import { CitizenUser, CivicIssueReport } from '../../types/civic';
import {
  sendCitizenEmailVerification,
  updateCitizenUserProfile,
} from '../../services/authService';
import { useLanguage } from '../../context/LanguageContext';
import { useTheme, ThemeMode } from '../../context/ThemeContext';
import { Language } from '../../locales/translations';
import { validateMeaningfulCivicText } from '../../utils/inputValidation';
import { toUserFriendlyErrorMessage } from '../../utils/userFriendlyErrors';

interface ProfileSettingsScreenProps {
  user: CitizenUser;
  userReports?: CivicIssueReport[];
  isFirebaseUser?: boolean;
  onUpdateUser: (updatedUser: CitizenUser) => void;
  onSignOut: () => void;
  onOpenSignIn?: () => void;
}

// Available civic residential wards
const RESIDENTIAL_WARDS = [
  'Ward 47 - Metro Green Zone',
  'Ward 23 - East Lakes',
  'Ward 12 - Old City Sector',
  'Ward 05 - North Industrial Corridor',
  'Ward 18 - Civic Central District',
  'Ward 31 - South Tech Hub',
];

// Avatar color preset options
const AVATAR_COLORS = [
  { id: 'emerald', label: 'Emerald', bg: 'bg-emerald-600', ring: 'ring-emerald-400' },
  { id: 'teal', label: 'Teal', bg: 'bg-teal-600', ring: 'ring-teal-400' },
  { id: 'blue', label: 'Ocean', bg: 'bg-sky-600', ring: 'ring-sky-400' },
  { id: 'indigo', label: 'Indigo', bg: 'bg-indigo-600', ring: 'ring-indigo-400' },
  { id: 'amber', label: 'Amber', bg: 'bg-amber-600', ring: 'ring-amber-400' },
  { id: 'slate', label: 'Slate', bg: 'bg-slate-700', ring: 'ring-slate-400' },
];

export const ProfileSettingsScreen: React.FC<ProfileSettingsScreenProps> = ({
  user,
  userReports = [],
  isFirebaseUser = false,
  onUpdateUser,
  onSignOut,
  onOpenSignIn,
}) => {
  const { language, setLanguage, t, supportedLanguages } = useLanguage();
  const { theme, setTheme } = useTheme();

  // Personal Information editing state
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [fullName, setFullName] = useState(user.fullName || '');
  const [email, setEmail] = useState(user.email || '');
  const [phone, setPhone] = useState(user.phone || '');
  const [fieldErrors, setFieldErrors] = useState<{ fullName?: string; email?: string; phone?: string }>({});
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [profileSuccessMsg, setProfileSuccessMsg] = useState<string | null>(null);
  const [profileErrorMsg, setProfileErrorMsg] = useState<string | null>(null);

  // Avatar customization state
  const [showAvatarModal, setShowAvatarModal] = useState(false);
  const [selectedAvatarColor, setSelectedAvatarColor] = useState(user.avatarColor || 'emerald');
  const [customAvatarUrl, setCustomAvatarUrl] = useState(user.avatarUrl || '');

  // Ward & Preferences state
  const [selectedWard, setSelectedWard] = useState(user.ward || '');
  const [inAppNotifs] = useState(true); // Always true & active in app
  const [pushNotifs, setPushNotifs] = useState(user.notificationPreferences?.pushNotifications ?? true);
  const [smsAlerts, setSmsAlerts] = useState(user.notificationPreferences?.smsAlerts ?? true);
  const [emailNotifs, setEmailNotifs] = useState(user.notificationPreferences?.emailUpdates ?? true);
  const [prefSaveNotice, setPrefSaveNotice] = useState<string | null>(null);

  // Sign out confirmation dialog
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [verificationMsg, setVerificationMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isSendingVerification, setIsSendingVerification] = useState(false);

  const handleResendVerification = async () => {
    setIsSendingVerification(true);
    setVerificationMsg(null);
    const res = await sendCitizenEmailVerification();
    setVerificationMsg({ type: res.success ? 'success' : 'error', text: res.message });
    setIsSendingVerification(false);
  };

  // Synchronize state when user prop updates
  useEffect(() => {
    setFullName(user.fullName || '');
    setEmail(user.email || '');
    setPhone(user.phone || '');
    setSelectedWard(user.ward || '');
    if (user.avatarColor) setSelectedAvatarColor(user.avatarColor);
    if (user.avatarUrl) setCustomAvatarUrl(user.avatarUrl);
  }, [user]);

  // Form Validation
  const validateForm = () => {
    const errors: { fullName?: string; email?: string; phone?: string } = {};

    const nameValidation = validateMeaningfulCivicText(fullName, {
      fieldLabel: 'Full name',
      minLength: 2,
      maxLength: 80,
      required: true,
      allowShortConcise: true,
    });
    if (!nameValidation.valid) {
      errors.fullName = nameValidation.error || 'Full name must be at least 2 meaningful characters.';
    }

    const digitsOnly = phone.replace(/\D/g, '');
    if (!phone.trim() || digitsOnly.length < 8) {
      errors.phone = 'Please provide a valid contact number (min 8 digits).';
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSavePersonalInfo = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setProfileErrorMsg(null);
    setProfileSuccessMsg(null);

    if (!validateForm()) {
      setProfileErrorMsg(t('profile.validationError'));
      return;
    }

    setIsSavingProfile(true);
    try {
      const updated = await updateCitizenUserProfile(user, {
        fullName: fullName.trim(),
        phone: phone.trim(),
        ward: selectedWard,
        avatarColor: selectedAvatarColor,
        avatarUrl: customAvatarUrl.trim(),
        preferredLanguage: language,
        notificationPreferences: {
          smsAlerts,
          pushNotifications: pushNotifs,
          emailUpdates: emailNotifs,
        },
      });

      onUpdateUser(updated);
      setIsEditingProfile(false);
      setProfileSuccessMsg(t('profile.saveSuccess'));
      setTimeout(() => setProfileSuccessMsg(null), 3500);
    } catch (err: any) {
      setProfileErrorMsg(toUserFriendlyErrorMessage(err, 'general'));
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleCancelEditing = () => {
    setFullName(user.fullName || '');
    setEmail(user.email || '');
    setPhone(user.phone || '');
    setFieldErrors({});
    setProfileErrorMsg(null);
    setIsEditingProfile(false);
  };

  // Avatar Save
  const handleSaveAvatar = async () => {
    try {
      const updated = await updateCitizenUserProfile(user, {
        avatarColor: selectedAvatarColor,
        avatarUrl: customAvatarUrl.trim(),
      });
      onUpdateUser(updated);
      setShowAvatarModal(false);
      setProfileSuccessMsg(t('profile.avatarSuccess'));
      setTimeout(() => setProfileSuccessMsg(null), 3000);
    } catch (err: any) {
      setProfileErrorMsg(toUserFriendlyErrorMessage(err, 'general'));
    }
  };

  // Residential Ward Change
  const handleWardChange = async (newWard: string) => {
    const previousWard = selectedWard;
    setSelectedWard(newWard);
    setProfileErrorMsg(null);
    try {
      const updated = await updateCitizenUserProfile(user, { ward: newWard });
      onUpdateUser(updated);
      showPrefNotice('Ward updated.');
    } catch (err: any) {
      setSelectedWard(previousWard);
      setProfileErrorMsg(toUserFriendlyErrorMessage(err, 'general'));
    }
  };

  // App-Wide Language Change
  const handleLanguageChange = async (langCode: Language) => {
    setLanguage(langCode);
    try {
      const updated = await updateCitizenUserProfile(user, { preferredLanguage: langCode });
      onUpdateUser(updated);
      showPrefNotice(`Language updated: ${langCode.toUpperCase()}`);
    } catch {
      // ignore
    }
  };

  // Theme Change
  const handleThemeChange = (newTheme: ThemeMode) => {
    setTheme(newTheme);
    showPrefNotice(`Theme: ${newTheme.toUpperCase()}`);
  };

  // Notification Toggles
  const handleNotificationToggle = async (
    type: 'push' | 'sms' | 'email',
    val: boolean
  ) => {
    const prevPush = pushNotifs;
    const prevSms = smsAlerts;
    const prevEmail = emailNotifs;

    const newPrefs = {
      smsAlerts: type === 'sms' ? val : smsAlerts,
      pushNotifications: type === 'push' ? val : pushNotifs,
      emailUpdates: type === 'email' ? val : emailNotifs,
    };

    if (type === 'push') setPushNotifs(val);
    if (type === 'sms') setSmsAlerts(val);
    if (type === 'email') setEmailNotifs(val);
    setProfileErrorMsg(null);

    try {
      const updated = await updateCitizenUserProfile(user, { notificationPreferences: newPrefs });
      onUpdateUser(updated);
      showPrefNotice('Notification preference saved.');
    } catch (err: any) {
      setPushNotifs(prevPush);
      setSmsAlerts(prevSms);
      setEmailNotifs(prevEmail);
      setProfileErrorMsg(toUserFriendlyErrorMessage(err, 'general'));
    }
  };

  const showPrefNotice = (msg: string) => {
    setPrefSaveNotice(msg);
    setTimeout(() => setPrefSaveNotice(null), 2500);
  };

  // Sign Out Handler
  const handleConfirmSignOut = async () => {
    setIsSigningOut(true);
    setSignOutError(null);
    try {
      await onSignOut();
      setShowSignOutConfirm(false);
    } catch (err: any) {
      setSignOutError(toUserFriendlyErrorMessage(err, 'auth'));
      setIsSigningOut(false);
    }
  };

  const currentColorConfig =
    AVATAR_COLORS.find((c) => c.id === selectedAvatarColor) || AVATAR_COLORS[0];

  return (
    <div className="bg-[#FAFBF9] dark:bg-[#0c1322] flex-1 w-full pb-12 text-slate-900 dark:text-slate-100 transition-colors">
      {/* 1. PROFILE HEADER */}
      <div className="bg-gradient-to-br from-[#064E3B] to-[#047857] dark:from-slate-950 dark:to-emerald-950/70 text-white px-4 sm:px-6 lg:px-8 py-6 sm:py-8 shadow-sm relative overflow-hidden">
        <div className="absolute top-0 right-0 w-56 h-56 bg-emerald-400/10 rounded-full blur-2xl pointer-events-none" />

        <div className="max-w-5xl mx-auto w-full flex flex-col sm:flex-row sm:items-center sm:justify-between gap-5 relative z-10">
          <div className="flex items-center gap-3.5 min-w-0">
            {/* Avatar with Edit Badge Button */}
            <div className="relative group shrink-0">
              {customAvatarUrl ? (
                <img
                  src={customAvatarUrl}
                  alt={fullName || 'Citizen Profile'}
                  className="w-16 h-16 rounded-2xl object-cover border-2 border-emerald-300/70 shadow-md ring-2 ring-emerald-500/20"
                  onError={() => setCustomAvatarUrl('')}
                />
              ) : (
                <div
                  className={`w-16 h-16 rounded-2xl ${currentColorConfig.bg} flex items-center justify-center font-bold text-white text-2xl shadow-md border-2 border-white/25 ring-2 ${currentColorConfig.ring}/40`}
                >
                  {fullName.charAt(0)?.toUpperCase() || 'C'}
                </div>
              )}

              <button
                type="button"
                onClick={() => setShowAvatarModal(true)}
                className="absolute -bottom-1 -right-1 w-6 h-6 rounded-lg bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white flex items-center justify-center shadow-md border border-white transition-transform hover:scale-110 cursor-pointer"
                title={t('profile.customizeAvatar')}
                aria-label={t('profile.customizeAvatar')}
              >
                <Camera className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Citizen Identity */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-lg sm:text-xl font-bold text-white truncate">
                  {fullName || 'Citizen'}
                </h1>
                {isFirebaseUser && (
                  <span className="text-[10px] font-semibold text-emerald-100 bg-white/15 px-2 py-0.5 rounded border border-white/20 flex items-center gap-1 shrink-0">
                    <Shield className="w-3 h-3" />
                    {t('action.verified')}
                  </span>
                )}
              </div>

              <p className="text-xs sm:text-sm text-emerald-100/90 truncate mt-0.5">{email || 'Email unavailable'}</p>

              <div className="flex items-center gap-1.5 text-xs text-emerald-200 mt-1 font-medium truncate">
                <MapPin className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{selectedWard || 'Residential ward not set'}</span>
              </div>
            </div>
          </div>

          {/* Civic Activity Metrics */}
          <div className="grid grid-cols-2 gap-3 sm:min-w-[260px]">
            <div className="bg-white/12 backdrop-blur-md rounded-2xl p-3 border border-white/15 text-center">
              <span className="text-[10px] text-emerald-100 uppercase tracking-wider block font-semibold">
                {t('home.stats.reported')}
              </span>
              <span className="text-xl font-bold text-white tracking-tight mt-0.5 block tabular-nums">
                {userReports.filter((r) => !r.archived).length}
              </span>
            </div>

            <div className="bg-white/12 backdrop-blur-md rounded-2xl p-3 border border-white/15 text-center">
              <span className="text-[10px] text-emerald-100 uppercase tracking-wider block font-semibold">
                {t('home.stats.resolved')}
              </span>
              <span className="text-xl font-bold text-emerald-200 tracking-tight mt-0.5 block tabular-nums">
                {userReports.filter((r) => !r.archived && r.status === 'Resolved').length}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Main Settings Layout */}
      <div className="max-w-5xl mx-auto w-full px-4 sm:px-6 lg:px-8 pt-6 space-y-5">
        {/* Success / Error Alerts */}
        {profileSuccessMsg && (
          <div className="p-3 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200 text-xs flex items-center gap-2 animate-fadeIn">
            <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span className="font-semibold">{profileSuccessMsg}</span>
          </div>
        )}

        {profileErrorMsg && (
          <div className="p-3 rounded-2xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-rose-900 dark:text-rose-200 text-xs flex items-center gap-2 animate-fadeIn">
            <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
            <span className="font-semibold">{profileErrorMsg}</span>
          </div>
        )}

        {prefSaveNotice && (
          <div className="p-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 text-[11px] flex items-center gap-1.5 animate-fadeIn">
            <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span>{prefSaveNotice}</span>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-5 space-y-5">
        {/* 2. PERSONAL INFORMATION SECTION */}
        <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200/90 dark:border-slate-800 p-5 shadow-2xs space-y-3 transition-colors">
          <div className="flex items-center justify-between pb-1 border-b border-slate-100 dark:border-slate-800">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-xl bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 flex items-center justify-center">
                <User className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-xs font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wide">
                  {t('profile.personalInfo')}
                </h2>
                <p className="text-[10px] text-slate-500 dark:text-slate-400">{t('profile.subtitle')}</p>
              </div>
            </div>

            {!isEditingProfile && (
              <button
                type="button"
                onClick={() => setIsEditingProfile(true)}
                className="py-1 px-2.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 hover:bg-emerald-100 dark:hover:bg-emerald-900 text-emerald-700 dark:text-emerald-300 font-semibold text-[11px] flex items-center gap-1 transition-colors cursor-pointer border border-emerald-200/60 dark:border-emerald-800"
              >
                <Edit3 className="w-3 h-3" />
                <span>{t('action.edit')}</span>
              </button>
            )}
          </div>

          {isEditingProfile ? (
            <form onSubmit={handleSavePersonalInfo} className="space-y-3 pt-1">
              {/* Full Name Input */}
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  {t('profile.fullName')} *
                </label>
                <div className="relative">
                  <User className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-3 pointer-events-none" />
                  <input
                    type="text"
                    value={fullName}
                    onChange={(e) => {
                      setFullName(e.target.value);
                      if (fieldErrors.fullName) setFieldErrors((prev) => ({ ...prev, fullName: undefined }));
                    }}
                    placeholder="e.g. Ramesh Kumar"
                    className={`w-full h-10 pl-9 pr-3 rounded-xl bg-slate-50 dark:bg-slate-950 border text-xs text-slate-900 dark:text-slate-100 focus:outline-none transition-colors ${
                      fieldErrors.fullName
                        ? 'border-rose-400 bg-rose-50/30'
                        : 'border-slate-300 dark:border-slate-700 focus:border-emerald-600 focus:bg-white dark:focus:bg-slate-900'
                    }`}
                  />
                </div>
                {fieldErrors.fullName && (
                  <p className="text-[10px] text-rose-600 dark:text-rose-400 mt-1 font-medium">
                    {fieldErrors.fullName}
                  </p>
                )}
              </div>

              {/* Account Email (Read-Only) */}
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  {t('profile.email')}
                </label>
                <div className="relative">
                  <Mail className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-3 pointer-events-none" />
                  <input
                    type="email"
                    value={email}
                    readOnly
                    disabled
                    aria-readonly="true"
                    className="w-full h-10 pl-9 pr-3 rounded-xl bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400 cursor-not-allowed"
                  />
                </div>
                <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">
                  Your account sign-in email cannot be changed here.
                </p>
              </div>

              {/* Phone Input */}
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  {t('profile.phone')} *
                </label>
                <div className="relative">
                  <Phone className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-3 pointer-events-none" />
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => {
                      setPhone(e.target.value);
                      if (fieldErrors.phone) setFieldErrors((prev) => ({ ...prev, phone: undefined }));
                    }}
                    placeholder="+91 98765 43210"
                    className={`w-full h-10 pl-9 pr-3 rounded-xl bg-slate-50 dark:bg-slate-950 border text-xs text-slate-900 dark:text-slate-100 focus:outline-none transition-colors ${
                      fieldErrors.phone
                        ? 'border-rose-400 bg-rose-50/30'
                        : 'border-slate-300 dark:border-slate-700 focus:border-emerald-600 focus:bg-white dark:focus:bg-slate-900'
                    }`}
                  />
                </div>
                {fieldErrors.phone && (
                  <p className="text-[10px] text-rose-600 dark:text-rose-400 mt-1 font-medium">
                    {fieldErrors.phone}
                  </p>
                )}
              </div>

              {/* Action Buttons */}
              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleCancelEditing}
                  disabled={isSavingProfile}
                  className="py-2.5 px-3 rounded-xl border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold text-xs transition-colors cursor-pointer text-center"
                >
                  {t('action.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={isSavingProfile}
                  className="py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 disabled:opacity-60 text-white font-semibold text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer shadow-2xs"
                >
                  {isSavingProfile ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>{t('action.saving')}</span>
                    </>
                  ) : (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      <span>{t('profile.saveChanges')}</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          ) : (
            <div className="space-y-2.5 pt-1 text-xs">
              <div className="p-2.5 rounded-2xl bg-slate-50/80 dark:bg-slate-800/50 border border-slate-200/60 dark:border-slate-700/60 flex items-center justify-between">
                <div className="flex items-center gap-2.5 min-w-0">
                  <User className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <div className="min-w-0">
                    <span className="text-[10px] font-semibold text-slate-400 block uppercase tracking-wider">
                      {t('profile.fullName')}
                    </span>
                    <span className="font-semibold text-slate-800 dark:text-slate-100 truncate block">
                      {fullName || 'Not specified'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="p-2.5 rounded-2xl bg-slate-50/80 dark:bg-slate-800/50 border border-slate-200/60 dark:border-slate-700/60 flex items-center justify-between">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Mail className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <div className="min-w-0">
                    <span className="text-[10px] font-semibold text-slate-400 block uppercase tracking-wider">
                      {t('profile.email')}
                    </span>
                    <span className="font-semibold text-slate-800 dark:text-slate-100 truncate block">
                      {email || 'Not specified'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="p-2.5 rounded-2xl bg-slate-50/80 dark:bg-slate-800/50 border border-slate-200/60 dark:border-slate-700/60 flex items-center justify-between">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Phone className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <div className="min-w-0">
                    <span className="text-[10px] font-semibold text-slate-400 block uppercase tracking-wider">
                      {t('profile.phone')}
                    </span>
                    <span className="font-semibold text-slate-800 dark:text-slate-100 truncate block">
                      {phone || 'Not specified'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
          </div>

          {/* 3. WARD & CIVIC PREFERENCES SECTION */}
          <div className="lg:col-span-7 bg-white dark:bg-slate-900 rounded-3xl border border-slate-200/90 dark:border-slate-800 p-5 shadow-2xs space-y-4 transition-colors">
          <div className="flex items-center gap-2 pb-1 border-b border-slate-100 dark:border-slate-800">
            <div className="w-7 h-7 rounded-xl bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 flex items-center justify-center">
              <MapPin className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-xs font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wide">
                {t('profile.wardAndPrefs')}
              </h2>
              <p className="text-[10px] text-slate-500 dark:text-slate-400">Jurisdiction, language, and display style</p>
            </div>
          </div>

          {/* Residential Ward Dropdown */}
          <div>
            <label className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-1">
              {t('profile.residentialWard')}
            </label>
            <div className="relative">
              <select
                value={selectedWard}
                onChange={(e) => handleWardChange(e.target.value)}
                className="w-full h-10 pl-3 pr-8 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:border-emerald-600 focus:bg-white dark:focus:bg-slate-900 appearance-none cursor-pointer"
              >
                <option value="">Select residential ward...</option>
                {RESIDENTIAL_WARDS.map((w) => (
                  <option key={w} value={w}>
                    {w}
                  </option>
                ))}
              </select>
              <ChevronDown className="w-4 h-4 text-slate-500 absolute right-3 top-3 pointer-events-none" />
            </div>
            <p className="text-[10px] text-slate-400 mt-1">
              {t('profile.wardHelp')}
            </p>
          </div>

          {/* REAL FUNCTIONAL APP-WIDE LANGUAGE SELECTOR */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                <span>{t('profile.language')}</span>
              </label>
              <span className="text-[10px] text-emerald-700 dark:text-emerald-400 font-semibold bg-emerald-50 dark:bg-emerald-950/60 px-2 py-0.5 rounded-full border border-emerald-200 dark:border-emerald-800">
                {language.toUpperCase()}
              </span>
            </div>
            <p className="text-[10px] text-slate-500 dark:text-slate-400 mb-2">
              {t('profile.languageDesc')}
            </p>
            <div className="grid grid-cols-3 gap-2">
              {supportedLanguages.map((lang) => (
                <button
                  key={lang.code}
                  type="button"
                  onClick={() => handleLanguageChange(lang.code)}
                  className={`py-2 px-2.5 text-xs font-semibold rounded-xl border transition-all cursor-pointer flex flex-col items-center justify-center text-center gap-0.5 ${
                    language === lang.code
                      ? 'bg-emerald-700 text-white border-emerald-700 shadow-2xs'
                      : 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700'
                  }`}
                >
                  <span className="leading-tight">{lang.nativeName}</span>
                  {lang.isRegional && (
                    <span className="text-[8px] opacity-80 uppercase tracking-wider">Regional</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* APPEARANCE / THEME SELECTOR (Light, Dark, System) */}
          <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                {theme === 'dark' ? (
                  <Moon className="w-3.5 h-3.5 text-emerald-500" />
                ) : theme === 'light' ? (
                  <Sun className="w-3.5 h-3.5 text-amber-500" />
                ) : (
                  <Laptop className="w-3.5 h-3.5 text-sky-500" />
                )}
                <span>{t('profile.appearance')}</span>
              </label>
              <span className="text-[10px] text-slate-500 dark:text-slate-400 capitalize">
                {theme}
              </span>
            </div>
            <p className="text-[10px] text-slate-500 dark:text-slate-400 mb-2">
              {t('profile.appearanceDesc')}
            </p>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => handleThemeChange('light')}
                className={`py-2 px-2.5 rounded-xl border text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                  theme === 'light'
                    ? 'bg-emerald-700 text-white border-emerald-700 shadow-2xs'
                    : 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700'
                }`}
              >
                <Sun className="w-3.5 h-3.5" />
                <span>{t('profile.themeLight')}</span>
              </button>

              <button
                type="button"
                onClick={() => handleThemeChange('dark')}
                className={`py-2 px-2.5 rounded-xl border text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                  theme === 'dark'
                    ? 'bg-emerald-700 text-white border-emerald-700 shadow-2xs'
                    : 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700'
                }`}
              >
                <Moon className="w-3.5 h-3.5" />
                <span>{t('profile.themeDark')}</span>
              </button>

              <button
                type="button"
                onClick={() => handleThemeChange('system')}
                className={`py-2 px-2.5 rounded-xl border text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                  theme === 'system'
                    ? 'bg-emerald-700 text-white border-emerald-700 shadow-2xs'
                    : 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700'
                }`}
              >
                <Laptop className="w-3.5 h-3.5" />
                <span>{t('profile.themeSystem')}</span>
              </button>
            </div>
          </div>

          {/* Notification Preferences with Implementation Status Badges */}
          <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wide flex items-center gap-1.5">
                <Bell className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                <span>{t('profile.notifications')}</span>
              </span>
            </div>

            {/* In-App Timeline Tracking */}
            <div className="p-2.5 rounded-2xl bg-emerald-50/50 dark:bg-emerald-950/30 border border-emerald-100 dark:border-emerald-900/60 flex items-start justify-between gap-3">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-slate-900 dark:text-slate-100">
                    {t('profile.notifTimeline')}
                  </span>
                  <span className="text-[9px] font-bold text-emerald-800 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-900/60 px-2 py-0.5 rounded-full border border-emerald-300 dark:border-emerald-700">
                    {t('profile.notifTimelineStatus')}
                  </span>
                </div>
                <p className="text-[10px] text-slate-600 dark:text-slate-400 mt-0.5 leading-relaxed">
                  {t('profile.notifTimelineDesc')}
                </p>
              </div>
              <input
                type="checkbox"
                checked={inAppNotifs}
                disabled
                className="w-4 h-4 rounded text-emerald-600 mt-1 cursor-not-allowed accent-emerald-600"
                title="Always active"
              />
            </div>

            {/* Browser Push */}
            <div className="p-2.5 rounded-2xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-700 flex items-start justify-between gap-3">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-slate-900 dark:text-slate-100">
                    {t('profile.notifPush')}
                  </span>
                  <span className="text-[9px] font-bold text-emerald-800 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-900/60 px-2 py-0.5 rounded-full border border-emerald-300 dark:border-emerald-700">
                    {t('profile.notifPushStatus')}
                  </span>
                </div>
                <p className="text-[10px] text-slate-600 dark:text-slate-400 mt-0.5 leading-relaxed">
                  {t('profile.notifPushDesc')}
                </p>
              </div>
              <input
                type="checkbox"
                checked={pushNotifs}
                onChange={(e) => handleNotificationToggle('push', e.target.checked)}
                className="w-4 h-4 rounded text-emerald-600 mt-1 cursor-pointer accent-emerald-600"
              />
            </div>

            {/* SMS Incident Alerts */}
            <div className="p-2.5 rounded-2xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-700 flex items-start justify-between gap-3">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-slate-900 dark:text-slate-100">
                    {t('profile.notifSms')}
                  </span>
                  <span className="text-[9px] font-semibold text-amber-800 dark:text-amber-300 bg-amber-100/80 dark:bg-amber-900/50 px-2 py-0.5 rounded-full border border-amber-300 dark:border-amber-700">
                    {t('profile.notifSmsStatus')}
                  </span>
                </div>
                <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                  {t('profile.notifSmsDesc')}
                </p>
              </div>
              <input
                type="checkbox"
                checked={smsAlerts}
                onChange={(e) => handleNotificationToggle('sms', e.target.checked)}
                className="w-4 h-4 rounded text-emerald-600 mt-1 cursor-pointer accent-emerald-600"
              />
            </div>

            {/* Email Updates */}
            <div className="p-2.5 rounded-2xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-700 flex items-start justify-between gap-3">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-slate-900 dark:text-slate-100">
                    {t('profile.notifEmail')}
                  </span>
                  <span className="text-[9px] font-semibold text-amber-800 dark:text-amber-300 bg-amber-100/80 dark:bg-amber-900/50 px-2 py-0.5 rounded-full border border-amber-300 dark:border-amber-700">
                    {t('profile.notifEmailStatus')}
                  </span>
                </div>
                <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                  {t('profile.notifEmailDesc')}
                </p>
              </div>
              <input
                type="checkbox"
                checked={emailNotifs}
                onChange={(e) => handleNotificationToggle('email', e.target.checked)}
                className="w-4 h-4 rounded text-emerald-600 mt-1 cursor-pointer accent-emerald-600"
              />
            </div>
          </div>
        </div>
        </div>

        {/* 4. ACCOUNT ACTIONS & SIGN OUT */}
        <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200/90 dark:border-slate-800 p-5 shadow-2xs space-y-3 transition-colors">
          <h2 className="text-xs font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wide flex items-center gap-1.5">
            <Shield className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
            <span>{t('profile.accountSecurity')}</span>
          </h2>

          {isFirebaseUser ? (
            <div className="space-y-2.5">
              <p className="text-[11px] text-slate-600 dark:text-slate-400 leading-relaxed">
                {t('profile.signedInAs')} <strong>{user.email}</strong>.
              </p>

              {user.emailVerified === false && (
                <div className="p-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 space-y-2">
                  <p className="text-[11px] text-amber-900 dark:text-amber-200">
                    Your email address is not yet verified.
                  </p>
                  <button
                    type="button"
                    onClick={handleResendVerification}
                    disabled={isSendingVerification}
                    className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-60 text-white text-[11px] font-semibold cursor-pointer"
                  >
                    {isSendingVerification ? 'Sending verification link...' : 'Send Verification Email'}
                  </button>
                </div>
              )}

              {verificationMsg && (
                <div
                  className={`p-2 rounded-xl text-[11px] border ${
                    verificationMsg.type === 'success'
                      ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
                      : 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-200'
                  }`}
                >
                  {verificationMsg.text}
                </div>
              )}

              <button
                type="button"
                onClick={() => setShowSignOutConfirm(true)}
                className="w-full py-2.5 px-4 rounded-xl border border-rose-200 dark:border-rose-900 hover:border-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-rose-700 dark:text-rose-400 font-semibold text-xs flex items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                <LogOut className="w-4 h-4" />
                <span>{t('profile.signOut')}</span>
              </button>
            </div>
          ) : (
            <div className="space-y-2.5">
              <p className="text-[11px] text-slate-600 dark:text-slate-400 leading-relaxed">
                You are currently in guest session mode. Sign in to sync and back up reports across devices.
              </p>
              {onOpenSignIn && (
                <button
                  type="button"
                  onClick={onOpenSignIn}
                  className="w-full py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs flex items-center justify-center gap-2 transition-colors cursor-pointer shadow-2xs"
                >
                  <User className="w-4 h-4" />
                  <span>Sign In with Email</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <p className="text-[10px] text-center text-slate-400 dark:text-slate-500 pt-2 pb-1">
          CiviFix AI · Citizen Issue Reporting & Municipal Intelligence
        </p>
      </div>

      {/* AVATAR CUSTOMIZATION MODAL */}
      {showAvatarModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 animate-fadeIn">
          <div className="w-full max-w-sm bg-white dark:bg-slate-900 rounded-3xl p-5 shadow-2xl border border-slate-200 dark:border-slate-800 space-y-4 text-slate-900 dark:text-slate-100">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <Camera className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <h3 className="text-sm font-bold">{t('profile.customizeAvatar')}</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowAvatarModal(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Avatar Preview */}
            <div className="flex flex-col items-center justify-center py-2">
              {customAvatarUrl ? (
                <img
                  src={customAvatarUrl}
                  alt="Avatar Preview"
                  className="w-20 h-20 rounded-3xl object-cover border-4 border-white dark:border-slate-800 shadow-lg ring-2 ring-emerald-500/30"
                  onError={() => setCustomAvatarUrl('')}
                />
              ) : (
                <div
                  className={`w-20 h-20 rounded-3xl ${
                    AVATAR_COLORS.find((c) => c.id === selectedAvatarColor)?.bg || 'bg-emerald-600'
                  } flex items-center justify-center text-white text-3xl font-bold border-4 border-white dark:border-slate-800 shadow-lg ring-2 ring-emerald-500/30`}
                >
                  {fullName.charAt(0)?.toUpperCase() || 'C'}
                </div>
              )}
              <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-300 mt-2">
                {fullName || 'Citizen'}
              </span>
            </div>

            {/* Color Swatches */}
            <div>
              <label className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-2">
                {t('profile.colorPreset')}
              </label>
              <div className="grid grid-cols-6 gap-2">
                {AVATAR_COLORS.map((color) => (
                  <button
                    key={color.id}
                    type="button"
                    onClick={() => {
                      setSelectedAvatarColor(color.id);
                      setCustomAvatarUrl('');
                    }}
                    className={`h-9 rounded-xl ${color.bg} transition-all cursor-pointer flex items-center justify-center ${
                      selectedAvatarColor === color.id && !customAvatarUrl
                        ? 'ring-3 ring-slate-900 dark:ring-white scale-105'
                        : 'opacity-80 hover:opacity-100'
                    }`}
                    title={color.label}
                  >
                    {selectedAvatarColor === color.id && !customAvatarUrl && (
                      <Check className="w-4 h-4 text-white" />
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* Image URL */}
            <div>
              <label className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-1">
                {t('profile.imageUrl')}
              </label>
              <input
                type="url"
                value={customAvatarUrl}
                onChange={(e) => setCustomAvatarUrl(e.target.value)}
                placeholder="https://example.com/avatar.jpg"
                className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:border-emerald-600 focus:bg-white dark:focus:bg-slate-900"
              />
            </div>

            <div className="grid grid-cols-2 gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowAvatarModal(false)}
                className="py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold text-xs cursor-pointer text-center"
              >
                {t('action.cancel')}
              </button>
              <button
                type="button"
                onClick={handleSaveAvatar}
                className="py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs cursor-pointer text-center shadow-2xs"
              >
                {t('profile.applyAvatar')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SIGN OUT CONFIRMATION MODAL */}
      {showSignOutConfirm && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 animate-fadeIn">
          <div className="w-full max-w-sm bg-white dark:bg-slate-900 rounded-3xl p-5 shadow-2xl border border-slate-200 dark:border-slate-800 space-y-4 text-slate-900 dark:text-slate-100">
            <div className="w-12 h-12 rounded-2xl bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800 text-rose-600 dark:text-rose-400 flex items-center justify-center mx-auto shadow-2xs">
              <LogOut className="w-6 h-6" />
            </div>

            <div className="text-center space-y-1">
              <h3 className="text-sm font-bold">{t('profile.signOutConfirmTitle')}</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                {t('profile.signOutConfirmDesc')}
              </p>
            </div>

            {signOutError && (
              <div className="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300 text-xs flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                <span>{signOutError}</span>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setShowSignOutConfirm(false);
                  setSignOutError(null);
                }}
                disabled={isSigningOut}
                className="py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold text-xs cursor-pointer text-center"
              >
                {t('profile.staySignedIn')}
              </button>
              <button
                type="button"
                onClick={handleConfirmSignOut}
                disabled={isSigningOut}
                className="py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 active:bg-rose-700 disabled:opacity-60 text-white font-semibold text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer shadow-2xs"
              >
                {isSigningOut ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>{t('action.signingOut')}</span>
                  </>
                ) : (
                  <span>{t('action.signOut')}</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
