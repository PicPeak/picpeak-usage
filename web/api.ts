export interface Summary {
  schema_version: string;
  schema_versions: Record<string, number>;
  installations: number;
  inventory: Record<"galleries" | "photos", { total: number; reported: number }>;
  features: Record<string, { configured: number; used: number; reported: number; used_reported: number }>;
  versions: Record<string, number>;
  layouts: Record<string, number>;
  versions_reported: number;
  layouts_reported: number;
  history: { date: string; reports: number }[];
}
export interface Feedback {
  id: string;
  kind?: string;
  title: string;
  body: string;
  name: string;
  status: string;
  votes: number;
  voted: boolean;
  created_at: string;
  allow_public?: boolean;
  allow_marketing?: boolean;
  published?: boolean;
}
export async function api<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    signal?: AbortSignal;
    onPage?: (next: string | null) => void;
  } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: options.method || "GET",
    signal: options.signal,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "REQUEST_FAILED");
  options.signal?.throwIfAborted();
  options.onPage?.(response.headers.get("X-Next-Cursor"));
  return value;
}
/** UTC date (YYYY-MM-DD) and timestamp (YYYY-MM-DD HH:MM UTC): the portal
 *  speaks in UTC days, so dates are shown the same way everywhere. */
export const day = (iso: string) => iso.slice(0, 10);
export function stamp(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const s = d.toISOString();
  return `${s.slice(0, 10)} ${s.slice(11, 16)} UTC`;
}
/** Authenticated file download: fetch with the bearer credential, then save. */
export async function downloadWith(
  path: string,
  token: string,
  name: string,
  signal?: AbortSignal,
  body?: unknown,
) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok) throw new Error("REQUEST_FAILED");
  const blob = await response.blob();
  signal?.throwIfAborted();
  saveBlob(blob, name);
}
function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function download(value: unknown, name: string) {
  saveBlob(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
    name,
  );
}
export const featureNames: Record<string, string> = Object.fromEntries(
  Object.entries(catalog.features).map(([key, value]) => [key, value.name.en]),
);
import catalog from "../protocol/features.v3.json";
