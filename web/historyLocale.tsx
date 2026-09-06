import en from "./locales/en.json";
import de from "./locales/de.json";
export type Language = "en" | "de";
export const messages = { en, de };
export function LanguageSelect({
  language,
  setLanguage,
}: {
  language: Language;
  setLanguage: (value: Language) => void;
}) {
  return (
    <label>
      {messages[language].language}
      <select
        value={language}
        onChange={(e) => setLanguage(e.target.value as Language)}
      >
        <option value="en">English</option>
        <option value="de">Deutsch</option>
      </select>
    </label>
  );
}
