import React from 'react';
import {
  Trash2,
  AlertTriangle,
  Droplet,
  CloudRain,
  Lightbulb,
  FileText,
  Construction,
} from 'lucide-react';
import { getCivicCategoryIconKey } from '../types/civic';

interface CivicCategoryIconProps {
  category?: string | null;
  className?: string;
}

/**
 * Renders a consistent icon for all 8 canonical and 6 legacy civic categories
 * using shared normalizeCivicCategory() logic without duplication.
 */
export const CivicCategoryIcon: React.FC<CivicCategoryIconProps> = ({
  category,
  className = 'w-4 h-4',
}) => {
  const iconKey = getCivicCategoryIconKey(category);

  switch (iconKey) {
    case 'garbage':
      return <Trash2 className={`${className} text-emerald-600 dark:text-emerald-400`} />;
    case 'dustbin':
      return <Trash2 className={`${className} text-teal-600 dark:text-teal-400`} />;
    case 'pothole':
      return <AlertTriangle className={`${className} text-amber-600 dark:text-amber-400`} />;
    case 'road':
      return <Construction className={`${className} text-orange-600 dark:text-orange-400`} />;
    case 'water':
      return <Droplet className={`${className} text-cyan-600 dark:text-cyan-400`} />;
    case 'drainage':
      return <CloudRain className={`${className} text-indigo-600 dark:text-indigo-400`} />;
    case 'streetlight':
      return <Lightbulb className={`${className} text-yellow-600 dark:text-yellow-400`} />;
    case 'other':
    default:
      return <FileText className={`${className} text-slate-500 dark:text-slate-400`} />;
  }
};
