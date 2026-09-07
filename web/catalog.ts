import v2 from "../protocol/features.v2.json";
import v3 from "../protocol/features.v3.json";
import v4 from "../protocol/features.v4.json";
import de from "./locales/catalog.de.json";
import type { Language } from "./historyLocale";

export const catalog = v4;
// Keep retired questions available for historical comparisons under their
// original names. They are distinct measurements, never aliases.
export const historicalFeatures = { ...v2.features, ...v3.features, ...v4.features };

type FeatureText = { name: string; configured: string; used?: string };
type InventoryText = { name: string; description: string };
const englishFeatures: Record<string, FeatureText> = Object.fromEntries(
  Object.entries(historicalFeatures).map(([key, value]) => [key, {
    name: value.name.en,
    configured: value.configured.en,
    ...(value.used ? { used: value.used.en } : {}),
  }]),
);
const englishInventory: Record<string, InventoryText> = Object.fromEntries(
  Object.entries(catalog.inventory).map(([key, value]) => [key, {
    name: value.name.en,
    description: value.description.en,
  }]),
);
const germanFeatures: Record<string, FeatureText> = de.features;
const germanInventory: Record<string, InventoryText> = de.inventory;

// English stays canonical in the protocol catalogs. Translations also retain
// retired questions so historical charts never rename one signal to another.
export const featureText = (key: string, language: Language): FeatureText =>
  language === "de" ? germanFeatures[key] || englishFeatures[key] : englishFeatures[key];
export const inventoryText = (key: string, language: Language): InventoryText =>
  language === "de" ? germanInventory[key] || englishInventory[key] : englishInventory[key];
