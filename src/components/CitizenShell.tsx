import React from 'react';
import {
  Home,
  PlusCircle,
  FileText,
  Bot,
  User,
} from 'lucide-react';
import { CivifixLogo } from './CivifixLogo';
import { useLanguage } from '../context/LanguageContext';

export type ActiveTab = 'home' | 'report' | 'reports' | 'civic_ai' | 'profile';

interface CitizenShellProps {
  activeTab: ActiveTab;
  onChangeTab: (tab: ActiveTab) => void;
  pendingReportsCount: number;
  showNav?: boolean;
  children: React.ReactNode;
}

export const CitizenShell: React.FC<CitizenShellProps> = ({
  activeTab,
  onChangeTab,
  pendingReportsCount,
  showNav = true,
  children,
}) => {
  const { t } = useLanguage();

  return (
    <div className="min-h-screen w-full flex flex-col bg-[#FAFBF9] dark:bg-[#0c1322] text-slate-900 dark:text-slate-100 font-sans selection:bg-emerald-600 selection:text-white transition-colors">
      {/* Responsive Top Navigation Header (shown for authenticated citizen session) */}
      {showNav && (
        <header className="sticky top-0 z-30 w-full bg-white/95 dark:bg-slate-950/95 backdrop-blur-md border-b border-slate-200/80 dark:border-slate-800/80 shrink-0 transition-colors">
          <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-3 sm:gap-6">
            {/* Brand Zone */}
            <button
              type="button"
              onClick={() => onChangeTab('home')}
              className="flex items-center gap-2.5 shrink-0 cursor-pointer rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
            >
              <CivifixLogo className="w-9 h-9 shrink-0" />
              <span className="text-lg font-extrabold tracking-tight text-[#064E3B] dark:text-emerald-400 whitespace-nowrap">
                CiviFix AI
              </span>
            </button>

            {/* Desktop & Tablet Primary Navigation */}
            <nav
              aria-label="Primary navigation"
              className="hidden md:flex items-center gap-5 lg:gap-7 h-full"
            >
              <button
                type="button"
                onClick={() => onChangeTab('home')}
                className={`h-full px-1 inline-flex items-center gap-1.5 text-sm whitespace-nowrap shrink-0 border-b-2 transition-colors cursor-pointer ${
                  activeTab === 'home'
                    ? 'border-[#059669] text-[#064E3B] dark:text-emerald-400 font-semibold'
                    : 'border-transparent text-slate-600 dark:text-slate-300 hover:text-[#064E3B] dark:hover:text-emerald-300 font-medium'
                }`}
              >
                <Home className="w-4 h-4 shrink-0" />
                <span>{t('nav.home')}</span>
              </button>

              <button
                type="button"
                onClick={() => onChangeTab('reports')}
                className={`h-full px-1 inline-flex items-center gap-1.5 text-sm whitespace-nowrap shrink-0 border-b-2 transition-colors cursor-pointer ${
                  activeTab === 'reports'
                    ? 'border-[#059669] text-[#064E3B] dark:text-emerald-400 font-semibold'
                    : 'border-transparent text-slate-600 dark:text-slate-300 hover:text-[#064E3B] dark:hover:text-emerald-300 font-medium'
                }`}
              >
                <FileText className="w-4 h-4 shrink-0" />
                <span>{t('nav.myReports')}</span>
                {pendingReportsCount > 0 && (
                  <span className="ml-0.5 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-emerald-600 text-white text-[11px] font-bold tabular-nums">
                    {pendingReportsCount}
                  </span>
                )}
              </button>

              <button
                type="button"
                onClick={() => onChangeTab('civic_ai')}
                className={`h-full px-1 inline-flex items-center gap-1.5 text-sm whitespace-nowrap shrink-0 border-b-2 transition-colors cursor-pointer ${
                  activeTab === 'civic_ai'
                    ? 'border-[#059669] text-[#064E3B] dark:text-emerald-400 font-semibold'
                    : 'border-transparent text-slate-600 dark:text-slate-300 hover:text-[#064E3B] dark:hover:text-emerald-300 font-medium'
                }`}
              >
                <Bot className="w-4 h-4 shrink-0" />
                <span>{t('nav.civicAi')}</span>
              </button>

              <button
                type="button"
                onClick={() => onChangeTab('profile')}
                className={`h-full px-1 inline-flex items-center gap-1.5 text-sm whitespace-nowrap shrink-0 border-b-2 transition-colors cursor-pointer ${
                  activeTab === 'profile'
                    ? 'border-[#059669] text-[#064E3B] dark:text-emerald-400 font-semibold'
                    : 'border-transparent text-slate-600 dark:text-slate-300 hover:text-[#064E3B] dark:hover:text-emerald-300 font-medium'
                }`}
              >
                <User className="w-4 h-4 shrink-0" />
                <span>{t('nav.profile')}</span>
              </button>
            </nav>

            {/* Right Action: Report CTA */}
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => onChangeTab('report')}
                className={`h-10 px-3.5 sm:px-4 rounded-xl text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                  activeTab === 'report'
                    ? 'bg-[#064E3B] text-white ring-2 ring-emerald-500/40'
                    : 'bg-[#059669] hover:bg-[#047857] text-white shadow-xs'
                }`}
              >
                <PlusCircle className="w-4 h-4 shrink-0" />
                <span>{t('nav.report')}</span>
              </button>
            </div>
          </div>
        </header>
      )}

      {/* Full-Viewport Main Content Area */}
      <main
        className={`flex-1 w-full flex flex-col min-w-0 ${
          showNav ? 'pb-16 md:pb-0' : ''
        }`}
      >
        {children}
      </main>

      {/* Mobile Bottom Navigation Bar (hidden on tablet/desktop where top nav is displayed) */}
      {showNav && (
        <nav
          aria-label="Mobile navigation"
          className="md:hidden fixed bottom-0 inset-x-0 h-16 bg-white/95 dark:bg-slate-950/95 backdrop-blur-md border-t border-slate-200/90 dark:border-slate-800/90 grid grid-cols-5 items-center px-1 z-30 select-none transition-colors"
        >
          <button
            type="button"
            onClick={() => onChangeTab('home')}
            className={`flex flex-col items-center justify-center py-1 transition-colors cursor-pointer ${
              activeTab === 'home'
                ? 'text-emerald-700 dark:text-emerald-400 font-bold'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            <Home className={`w-5 h-5 ${activeTab === 'home' ? 'stroke-[2.5]' : ''}`} />
            <span className="text-[10px] mt-0.5 tracking-tight truncate max-w-full px-0.5">
              {t('nav.home')}
            </span>
          </button>

          <button
            type="button"
            onClick={() => onChangeTab('report')}
            className={`flex flex-col items-center justify-center py-1 transition-colors cursor-pointer ${
              activeTab === 'report'
                ? 'text-emerald-700 dark:text-emerald-400 font-bold'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            <PlusCircle className={`w-5 h-5 ${activeTab === 'report' ? 'stroke-[2.5] text-emerald-600 dark:text-emerald-400' : ''}`} />
            <span className="text-[10px] mt-0.5 tracking-tight truncate max-w-full px-0.5">
              {t('nav.report')}
            </span>
          </button>

          <button
            type="button"
            onClick={() => onChangeTab('reports')}
            className={`flex flex-col items-center justify-center py-1 relative transition-colors cursor-pointer ${
              activeTab === 'reports'
                ? 'text-emerald-700 dark:text-emerald-400 font-bold'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            <FileText className={`w-5 h-5 ${activeTab === 'reports' ? 'stroke-[2.5]' : ''}`} />
            <span className="text-[10px] mt-0.5 tracking-tight truncate max-w-full px-0.5">
              {t('nav.myReports')}
            </span>
            {pendingReportsCount > 0 && (
              <span className="absolute top-1 right-4 w-4 h-4 rounded-full bg-emerald-600 text-white text-[9px] font-bold flex items-center justify-center tabular-nums">
                {pendingReportsCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => onChangeTab('civic_ai')}
            className={`flex flex-col items-center justify-center py-1 transition-colors cursor-pointer ${
              activeTab === 'civic_ai'
                ? 'text-emerald-700 dark:text-emerald-400 font-bold'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            <Bot className={`w-5 h-5 ${activeTab === 'civic_ai' ? 'stroke-[2.5] text-emerald-600 dark:text-emerald-400' : ''}`} />
            <span className="text-[10px] mt-0.5 tracking-tight truncate max-w-full px-0.5">
              {t('nav.civicAi')}
            </span>
          </button>

          <button
            type="button"
            onClick={() => onChangeTab('profile')}
            className={`flex flex-col items-center justify-center py-1 transition-colors cursor-pointer ${
              activeTab === 'profile'
                ? 'text-emerald-700 dark:text-emerald-400 font-bold'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            <User className={`w-5 h-5 ${activeTab === 'profile' ? 'stroke-[2.5]' : ''}`} />
            <span className="text-[10px] mt-0.5 tracking-tight truncate max-w-full px-0.5">
              {t('nav.profile')}
            </span>
          </button>
        </nav>
      )}
    </div>
  );
};
