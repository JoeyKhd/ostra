import { t } from "@/lib/messages";

// Pure pieces of the storage page (storage-settings.md, F-114, F-079): sizes in binary units, the
// retention draft and what saving it will do.

const KiB = 1024;
const MiB = KiB * 1024;
const GiB = MiB * 1024;

/** `0 B`, `812 MiB`, `2.31 GiB`: two decimals over 1 GiB, whole numbers under. */
export const formatBytes = (bytes: number): string => {
  if (bytes >= GiB) return `${(bytes / GiB).toFixed(2)} GiB`;
  if (bytes >= MiB) return `${String(Math.round(bytes / MiB))} MiB`;
  if (bytes >= KiB) return `${String(Math.round(bytes / KiB))} KiB`;
  return `${String(bytes)} B`;
};

/** The retention choice on the page: keep while the task exists, or delete after a typed number of days. */
export type RetentionDraft = { readonly mode: "keep" } | { readonly mode: "delete"; readonly days: string };

export const MAX_RETENTION_DAYS = 3650;

export const draftOf = (days: number | null): RetentionDraft => (days === null ? { mode: "keep" } : { mode: "delete", days: String(days) });

/** The days a draft saves: `null` keeps; `"invalid"` when the typed value isn't a whole number from 1 to 3650. */
export const draftDays = (draft: RetentionDraft): number | null | "invalid" => {
  if (draft.mode === "keep") return null;
  if (!/^\d{1,4}$/.test(draft.days.trim())) return "invalid";
  const days = Number(draft.days.trim());
  return days >= 1 && days <= MAX_RETENTION_DAYS ? days : "invalid";
};

/** Whether `Save retention` is enabled: a valid draft that differs from what's in effect. */
export const canSave = (draft: RetentionDraft, inEffect: number | null): boolean => {
  const days = draftDays(draft);
  return days !== "invalid" && days !== inEffect;
};

/** The confirmation's words: turning on or shortening says what goes; turning off says nothing more goes. */
export const confirmation = (days: number | null): { readonly title: string; readonly action: string; readonly turnsOff: boolean } =>
  days === null
    ? { title: t("storage.retention.confirmOffTitle"), action: t("storage.retention.confirmOffAction"), turnsOff: true }
    : { title: t("storage.retention.confirmOnTitle", { days }), action: t("storage.retention.confirmOnAction", { days }), turnsOff: false };

/** The three lines of what a sweep deletes, with the typed number of days. */
export const deletionLines = (days: string): readonly string[] => [
  t("storage.retention.willDelete1", { days: days.trim() === "" ? "…" : days.trim() }),
  t("storage.retention.willDelete2"),
  t("storage.retention.willDelete3"),
];
