import { useState } from "react";
import { catalog, featureText, inventoryText } from "./catalog";
import { LanguageSelect, messages, type Language } from "./historyLocale";

export function FeatureCatalog() {
  const [lang, setLang] = useState<Language>("en");
  const [search, setSearch] = useState("");
  const t = messages[lang];
  const entries = Object.entries(catalog.features)
    .map(([key, value]) => ({ key, value, text: featureText(key, lang) }))
    .filter(({ key, text }) =>
      `${key} ${text.name}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="panel section" id="feature-catalog" lang={lang}>
    <h2>{t.catalogTitle}</h2>
    <div className="controls">
      <LanguageSelect language={lang} setLanguage={setLang} />
      <label>{t.catalogSearch}
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
    </div>
    <p>{t.catalogDisclosure}</p>
    <p>{t.catalogVersionDisclosure}</p>
    <p>{t.downloadSignals}</p>
    <p className="notice">{t.accessDisclosure}</p>
    <section className="section">
      <h3>{t.inventoryTitle}</h3>
      <p>{t.inventoryCatalog}</p>
      {Object.keys(catalog.inventory).map((key) => {
        const text = inventoryText(key, lang);
        return <p key={key}>
          <strong>{text.name}</strong> · <code>inventory.{key}</code>: {text.description}
        </p>;
      })}
    </section>
    {entries.map(({ key, value, text }) => <details className="catalog-entry" key={key}>
      <summary>{text.name} <small><code>{key}</code> · {value.since}</small></summary>
      <p><strong>{t.catalogConfigured}:</strong> {text.configured}</p>
      <p>{text.used
        ? <><strong>{t.catalogUsed}:</strong> {text.used}</>
        : t.catalogConfigurationOnly}</p>
    </details>)}
    {!entries.length && <p>{t.catalogEmpty}</p>}
    <p><a className="textlink ink" href="/schema/features.v5.json">JSON: features.v5</a></p>
  </section>;
}
