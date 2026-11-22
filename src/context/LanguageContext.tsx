import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { Language, SUPPORTED_LANGUAGES, translations, TranslationKey } from '../locales/translations';

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: TranslationKey, fallback?: string) => string;
  supportedLanguages: typeof SUPPORTED_LANGUAGES;
}

const STORAGE_KEY = 'civifix_language';

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY) as Language | null;
      if (saved && (saved === 'en' || saved === 'hi' || saved === 'te' || saved === 'ta' || saved === 'kn')) {
        return saved;
      }
    } catch {
      // ignore
    }
    return 'en';
  });

  const setLanguage = useCallback((lang: Language) => {
    setLanguageState(lang);
    try {
      localStorage.setItem(STORAGE_KEY, lang);
      document.documentElement.lang = lang;
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const t = useCallback(
    (key: TranslationKey, fallback?: string): string => {
      const langDict = translations[language] as Record<string, string> | undefined;
      if (langDict && langDict[key]) {
        return langDict[key];
      }
      // Fallback to English
      const enDict = translations.en as Record<string, string>;
      if (enDict[key]) {
        return enDict[key];
      }
      return fallback || key;
    },
    [language]
  );

  return (
    <LanguageContext.Provider
      value={{
        language,
        setLanguage,
        t,
        supportedLanguages: SUPPORTED_LANGUAGES,
      }}
    >
      {children}
    </LanguageContext.Provider>
  );
};

export function useLanguage(): LanguageContextType {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
}
