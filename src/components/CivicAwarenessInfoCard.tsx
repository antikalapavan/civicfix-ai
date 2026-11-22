import React, { useState } from 'react';
import {
  BookOpen,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  Users,
  Wrench,
  Lightbulb,
  HelpCircle,
} from 'lucide-react';
import { getEducationGuideForCategory } from '../data/civicIssueEducation';

interface CivicAwarenessInfoCardProps {
  category?: string | null;
  subType?: string | null;
  defaultExpanded?: boolean;
}

export const CivicAwarenessInfoCard: React.FC<CivicAwarenessInfoCardProps> = ({
  category,
  subType,
  defaultExpanded = false,
}) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const guide = getEducationGuideForCategory(category, subType);

  return (
    <div className="rounded-2xl border border-emerald-200/80 dark:border-emerald-800/60 bg-emerald-50/40 dark:bg-emerald-950/20 overflow-hidden text-xs">
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className="w-full px-3.5 py-2.5 flex items-center justify-between gap-2 text-left hover:bg-emerald-50/80 dark:hover:bg-emerald-950/40 transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2 min-w-0">
          <BookOpen className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0" />
          <div className="min-w-0">
            <span className="font-bold text-emerald-950 dark:text-emerald-200 block truncate">
              Civic Awareness: {guide.title}
            </span>
            <span className="text-[10px] text-emerald-700 dark:text-emerald-400 block truncate">
              Causes, community impact, prevention &amp; municipal response
            </span>
          </div>
        </div>
        {isExpanded ? (
          <ChevronUp className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0" />
        ) : (
          <ChevronDown className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0" />
        )}
      </button>

      {isExpanded && (
        <div className="px-3.5 pb-3.5 pt-2 border-t border-emerald-200/60 dark:border-emerald-800/50 space-y-3 text-[11px] text-slate-700 dark:text-slate-300 bg-white/70 dark:bg-slate-900/40">
          <div>
            <h5 className="font-bold text-slate-900 dark:text-white flex items-center gap-1 mb-0.5">
              <HelpCircle className="w-3.5 h-3.5 text-emerald-600" />
              <span>What This Problem Is</span>
            </h5>
            <p className="leading-relaxed">{guide.whatItIs}</p>
          </div>

          <div>
            <h5 className="font-bold text-slate-900 dark:text-white mb-0.5">
              Why It Commonly Happens
            </h5>
            <ul className="space-y-1 list-disc list-inside leading-relaxed">
              {guide.whyItHappens.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          </div>

          <div>
            <h5 className="font-bold text-slate-900 dark:text-white mb-0.5">
              Citizen &amp; Environmental Impact
            </h5>
            <ul className="space-y-1 list-disc list-inside leading-relaxed">
              {guide.publicAndEnvironmentalImpact.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          </div>

          <div className="p-2.5 rounded-xl bg-amber-50/80 dark:bg-amber-950/30 border border-amber-200/80 dark:border-amber-800/60">
            <h5 className="font-bold text-amber-900 dark:text-amber-200 flex items-center gap-1 mb-1">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
              <span>Possible Health, Safety &amp; Environmental Risks</span>
            </h5>
            <ul className="space-y-1 list-disc list-inside text-amber-900/90 dark:text-amber-200/90 leading-relaxed">
              {guide.potentialRisks.map((risk, idx) => (
                <li key={idx}>{risk}</li>
              ))}
            </ul>
            <p className="text-[10px] text-amber-700 dark:text-amber-300/80 italic mt-1">
              {guide.riskDisclaimer}
            </p>
          </div>

          <div>
            <h5 className="font-bold text-slate-900 dark:text-white flex items-center gap-1 mb-0.5">
              <Users className="w-3.5 h-3.5 text-emerald-600" />
              <span>How Citizens Can Help Prevent It</span>
            </h5>
            <ul className="space-y-1 list-disc list-inside leading-relaxed">
              {guide.howCitizensHelp.map((tip, idx) => (
                <li key={idx}>{tip}</li>
              ))}
            </ul>
          </div>

          <div>
            <h5 className="font-bold text-slate-900 dark:text-white flex items-center gap-1 mb-0.5">
              <Wrench className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
              <span>Appropriate Municipal Actions</span>
            </h5>
            <ul className="space-y-1 list-disc list-inside leading-relaxed">
              {guide.appropriateMunicipalActions.map((act, idx) => (
                <li key={idx}>{act}</li>
              ))}
            </ul>
          </div>

          {guide.practicalTips.length > 0 && (
            <div className="p-2 rounded-xl bg-slate-100/80 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700">
              <h5 className="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1 mb-0.5">
                <Lightbulb className="w-3.5 h-3.5 text-amber-500" />
                <span>Practical Reporting Tips</span>
              </h5>
              <ul className="space-y-0.5 list-disc list-inside leading-relaxed">
                {guide.practicalTips.map((tip, idx) => (
                  <li key={idx}>{tip}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
