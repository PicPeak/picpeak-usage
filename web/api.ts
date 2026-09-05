export interface Summary {
  schema_version: string;
  installations: number;
  features: Record<string, { configured: number; used: number }>;
  versions: Record<string, number>;
  layouts: Record<string, number>;
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
export function download(value: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const featureNames: Record<string, string> = {
  crm: "Client management",
  crm_quotes: "Quotes",
  crm_invoices: "Invoices",
  crm_contracts: "Contracts",
  crm_projects: "Projects",
  crm_calendar: "Calendar",
  crm_hours: "Hours logging",
  customer_portal: "Customer portal",
  accounting: "Accounting",
  workflows: "Workflows",
  newsletters: "Newsletters",
  face_recognition: "Face recognition",
  custom_css: "Custom CSS",
  oauth: "OAuth / single sign-on",
  smtp: "Email delivery",
  whatsapp: "WhatsApp",
  backup: "Backups",
  s3_storage: "S3 storage",
  share_mounts: "Share mounts",
};
