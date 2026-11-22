import React from 'react';
import {
  Bell,
  User,
  Plus,
  FileText,
  Clock,
  CheckCircle2,
  MapPin,
  ChevronRight,
  Info,
} from 'lucide-react';
import { CitizenUser, CivicIssueReport } from '../../types/civic';
import { CivicCategoryIcon } from '../CivicCategoryIcon';
import { useLanguage } from '../../context/LanguageContext';

interface HomeScreenProps {
  user: CitizenUser;
  isFirebaseUser?: boolean;
  userReports: CivicIssueReport[];
  onNavigateToReport: () => void;
  onNavigateToReports: () => void;
  onSelectReport: (report: CivicIssueReport) => void;
  onNavigateToProfile?: () => void;
}

export const HomeScreen: React.FC<HomeScreenProps> = ({
  user,
  userReports,
  onNavigateToReport,
  onNavigateToReports,
  onSelectReport,
  onNavigateToProfile,
}) => {
  const { t } = useLanguage();

  const activeUserReports = userReports.filter((r) => !r.archived);
  const submittedCount = activeUserReports.filter((r) => r.status === 'Submitted' || r.status === 'Under Review').length;
  const inProgressCount = activeUserReports.filter((r) => r.status === 'In Progress' || r.status === 'Assigned').length;
  const resolvedCount = activeUserReports.filter((r) => r.status === 'Resolved').length;

  const displayFeed = activeUserReports.slice(0, 3);

  return (
    <div className="bg-[#FAFBF9] dark:bg-[#0c1322] flex-1 w-full text-slate-900 dark:text-slate-100 select-none transition-colors">
      <div className="max-w-6xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-5 sm:py-7 space-y-6">
        {/* Greeting & Quick Profile/Updates Actions */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
              {t('home.greeting')}
            </h1>
            <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
              {t('home.subtitle')}
            </p>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={onNavigateToReports}
              className="w-10 h-10 rounded-full flex items-center justify-center bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 relative transition-colors cursor-pointer"
              aria-label="View complaint updates in My Reports"
            >
              <Bell className="w-5 h-5 text-slate-700 dark:text-slate-300" />
            </button>

            <button
              type="button"
              onClick={onNavigateToProfile}
              className="w-10 h-10 rounded-full bg-emerald-800 dark:bg-emerald-700 flex items-center justify-center text-white font-bold text-xs ring-2 ring-emerald-500/20 hover:ring-emerald-500/50 transition-all cursor-pointer shadow-sm"
              aria-label="Citizen Profile"
            >
              {user.fullName ? (
                <span>{user.fullName.charAt(0).toUpperCase()}</span>
              ) : (
                <User className="w-4 h-4 text-white" />
              )}
            </button>
          </div>
        </div>

        {/* 3 Metric Summary Cards Row */}
        <div className="grid grid-cols-3 gap-2.5 sm:gap-4">
          {/* Card 1: Reports Submitted */}
          <div
            onClick={onNavigateToReports}
            className="bg-emerald-50/90 dark:bg-emerald-950/40 border border-emerald-100/90 dark:border-emerald-900/60 rounded-2xl p-3 sm:p-4 flex flex-col items-center justify-center text-center cursor-pointer hover:bg-emerald-100/70 dark:hover:bg-emerald-900/50 transition-colors"
          >
            <div className="w-8 h-8 rounded-xl bg-emerald-100 dark:bg-emerald-900/60 flex items-center justify-center mb-1.5 text-emerald-700 dark:text-emerald-300">
              <FileText className="w-4 h-4" />
            </div>
            <span className="text-xl sm:text-2xl font-extrabold text-slate-900 dark:text-white leading-tight tabular-nums">
              {submittedCount}
            </span>
            <span className="text-[10px] sm:text-xs font-semibold text-slate-600 dark:text-slate-300 mt-0.5 leading-tight">
              {t('home.stats.reported')}
            </span>
          </div>

          {/* Card 2: In Progress */}
          <div
            onClick={onNavigateToReports}
            className="bg-sky-50/90 dark:bg-sky-950/40 border border-sky-100/90 dark:border-sky-900/60 rounded-2xl p-3 sm:p-4 flex flex-col items-center justify-center text-center cursor-pointer hover:bg-sky-100/70 dark:hover:bg-sky-900/50 transition-colors"
          >
            <div className="w-8 h-8 rounded-xl bg-sky-100 dark:bg-sky-900/60 flex items-center justify-center mb-1.5 text-sky-700 dark:text-sky-300">
              <Clock className="w-4 h-4" />
            </div>
            <span className="text-xl sm:text-2xl font-extrabold text-slate-900 dark:text-white leading-tight tabular-nums">
              {inProgressCount}
            </span>
            <span className="text-[10px] sm:text-xs font-semibold text-slate-600 dark:text-slate-300 mt-0.5 leading-tight">
              {t('home.stats.inProgress')}
            </span>
          </div>

          {/* Card 3: Resolved */}
          <div
            onClick={onNavigateToReports}
            className="bg-purple-50/90 dark:bg-purple-950/40 border border-purple-100/90 dark:border-purple-900/60 rounded-2xl p-3 sm:p-4 flex flex-col items-center justify-center text-center cursor-pointer hover:bg-purple-100/70 dark:hover:bg-purple-900/50 transition-colors"
          >
            <div className="w-8 h-8 rounded-xl bg-purple-100 dark:bg-purple-900/60 flex items-center justify-center mb-1.5 text-purple-700 dark:text-purple-300">
              <CheckCircle2 className="w-4 h-4" />
            </div>
            <span className="text-xl sm:text-2xl font-extrabold text-slate-900 dark:text-white leading-tight tabular-nums">
              {resolvedCount}
            </span>
            <span className="text-[10px] sm:text-xs font-semibold text-slate-600 dark:text-slate-300 mt-0.5 leading-tight">
              {t('home.stats.resolved')}
            </span>
          </div>
        </div>

        {/* Main Responsive Content Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Primary reporting action */}
          <div className="lg:col-span-5 space-y-5">
            {/* Primary Action Button */}
            <button
              onClick={onNavigateToReport}
              className="w-full h-12 rounded-2xl bg-[#059669] hover:bg-[#047857] active:bg-[#065F46] text-white font-bold text-sm flex items-center justify-center gap-2 shadow-md shadow-emerald-900/15 active:scale-[0.99] transition-all cursor-pointer"
            >
              <div className="w-5 h-5 rounded-full bg-white/20 flex items-center justify-center text-white">
                <Plus className="w-3.5 h-3.5 stroke-[3]" />
              </div>
              <span>{t('home.reportIssueCta')}</span>
            </button>

          </div>

          {/* Recent Activity Feed */}
          <div className="lg:col-span-7 bg-white dark:bg-slate-900/70 rounded-3xl border border-slate-200/80 dark:border-slate-800 p-4 sm:p-5 shadow-2xs">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold text-slate-800 dark:text-slate-200 tracking-tight">
                {t('home.recentReports')}
              </h2>
              <button
                onClick={onNavigateToReports}
                className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:underline flex items-center gap-0.5 cursor-pointer"
              >
                <span>{t('action.viewAll')}</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>

            {displayFeed.length === 0 ? (
              <div className="p-6 rounded-2xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-center">
                <p className="text-xs font-bold text-slate-700 dark:text-slate-200">
                  {t('home.noRecentReports')}
                </p>
                <button
                  onClick={onNavigateToReport}
                  className="mt-3 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs cursor-pointer"
                >
                  + {t('nav.report')}
                </button>
              </div>
            ) : (
              <div className="space-y-2.5">
                {displayFeed.map((report) => (
                  <div
                    key={report.id}
                    onClick={() => onSelectReport(report)}
                    className="p-3.5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-emerald-300 dark:hover:border-emerald-700 transition-colors cursor-pointer flex items-center justify-between gap-3 shadow-2xs"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-600 dark:text-slate-300 shrink-0">
                        <CivicCategoryIcon
                          category={report.normalizedCategory || report.category}
                          className="w-4 h-4"
                        />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[10px] font-bold text-slate-600 dark:text-slate-400">
                            {report.trackingNumber}
                          </span>
                          <span
                            className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                              report.status === 'Resolved'
                                ? 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300'
                                : report.status === 'In Progress' || report.status === 'Assigned'
                                ? 'bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                            }`}
                          >
                            {report.status}
                          </span>
                        </div>
                        <p className="text-xs sm:text-sm font-bold text-slate-900 dark:text-slate-100 truncate mt-0.5">
                          {report.title}
                        </p>
                        <div className="flex items-center gap-1 text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 truncate">
                          <MapPin className="w-3 h-3 text-slate-400 shrink-0" />
                          <span className="truncate">{report.location?.address || 'Manual Address Recorded'}</span>
                        </div>
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span className="flex items-center gap-1.5">
                <Info className="w-3.5 h-3.5 text-slate-400" />
                {t('home.viewMyReports')}
              </span>
              <button
                type="button"
                onClick={onNavigateToReports}
                className="text-emerald-700 dark:text-emerald-400 font-semibold hover:underline cursor-pointer"
              >
                {t('action.viewAll')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
