import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { messages, type Language } from "./historyLocale";

const PREFERENCE_KEY = "picpeak-usage-language";
function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem(PREFERENCE_KEY);
    if (saved === "en" || saved === "de") return saved;
  } catch {
    /* Storage can be disabled; the page still works in memory. */
  }
  return navigator.language?.toLowerCase().startsWith("de") ? "de" : "en";
}
const LocaleContext = createContext<{
  language: Language;
  setLanguage: (language: Language) => void;
} | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [language, updateLanguage] = useState<Language>(initialLanguage);
  const setLanguage = (value: Language) => {
    updateLanguage(value);
    // Only the language preference is persisted. Credentials remain in page
    // memory, and changing language never recreates an authenticated session.
    try {
      localStorage.setItem(PREFERENCE_KEY, value);
    } catch {
      /* memory only */
    }
  };
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  return (
    <LocaleContext.Provider value={{ language, setLanguage }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  const locale = useContext(LocaleContext);
  if (!locale) throw new Error("LocaleProvider is required");
  return { ...locale, t: messages[locale.language] };
}
