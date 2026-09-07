import { historicalFeatures } from "./catalog";

export function linkedFeature(): string {
  const key = new URLSearchParams(location.search).get("feature") || "";
  return Object.hasOwn(historicalFeatures, key) ? key : "";
}

export function linkedFeedbackId(): string {
  const id = new URLSearchParams(location.search).get("feedback") || "";
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id) ? id : "";
}
