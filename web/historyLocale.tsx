import en from "./locales/en.json";
import de from "./locales/de.json";
export type Language = "en" | "de";
export type Messages = typeof en;
// Both languages must supply every UI message.
const germanMessages: Messages = de;
export const messages = { en, de: germanMessages };
export function LanguageSelect({
  language,
  setLanguage,
}: {
  language: Language;
  setLanguage: (value: Language) => void;
}) {
  return (
    <label>
      <span>{messages[language].language}</span>
      <select
        aria-label={messages[language].language}
        value={language}
        onChange={(e) => setLanguage(e.target.value as Language)}
      >
        <option value="en">English</option>
        <option value="de">Deutsch</option>
      </select>
    </label>
  );
}
