import { useState } from "react";
import { type Summary } from "./api";
import { LanguageSelect, messages, type Language } from "./historyLocale";

export function InventorySummary({ inventory }: Pick<Summary, "inventory">) {
  const [language, setLanguage] = useState<Language>("en");
  const t = messages[language];
  return <section className="panel section" aria-label={t.inventoryTitle}>
    <div className="section-heading">
      <h2>{t.inventoryTitle}</h2>
      <LanguageSelect language={language} setLanguage={setLanguage} />
    </div>
    <p className="caption">{t.inventorySummary}</p>
    <ul className="stats">
      {(["galleries", "photos"] as const).map(key => <li key={key}>
        <span className="label">{t[key]}</span>
        <strong>{inventory?.[key]?.reported ? inventory[key].total.toLocaleString(language) : t.unknown}</strong>
        <small>{t.inventoryReported}: {(inventory?.[key]?.reported || 0).toLocaleString(language)}</small>
      </li>)}
    </ul>
  </section>;
}
