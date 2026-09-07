import { useLocale } from "./Locale";
import { type Summary } from "./api";

export function InventorySummary({ inventory }: Pick<Summary, "inventory">) {
  const { language, t } = useLocale();
  return <section className="panel section" aria-label={t.inventoryTitle}>
    <div className="section-heading">
      <h2>{t.inventoryTitle}</h2>
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
