import { t } from "@/lib/messages";

// The words of Organization › Models as keys (app-targets/m4/models-keys.md, F-135). Pure.

/** The four vendors whose host names a key's logo (open point 4); any other host is `server`. */
const vendorLogos: Readonly<Record<string, string>> = {
  "api.anthropic.com": "anthropic",
  "api.openai.com": "openai",
  "openrouter.ai": "openrouter",
  "generativelanguage.googleapis.com": "google",
};

/** The logo ostra serves for a key's host (models.dev's, through `/model-logos/`), or null for `server`. */
export const keyLogoPath = (host: string): string | null => {
  const vendor = vendorLogos[host.toLowerCase()];
  return vendor === undefined ? null : `/model-logos/${vendor}.svg`;
};

/** `Followed by 3 projects: a, b, c`; past four names, the first three and `and {n} more`. */
export const followedBy = (names: readonly string[]): { readonly lead: string; readonly names: readonly string[]; readonly more: string | null } => {
  if (names.length === 0) return { lead: t("models.keys.followedByNone"), names: [], more: null };
  const lead = names.length === 1 ? t("models.keys.followedByOne") : t("models.keys.followedByMany", { n: names.length });
  if (names.length <= 4) return { lead, names, more: null };
  return { lead, names: names.slice(0, 3), more: t("models.keys.andMore", { n: names.length - 3 }) };
};

/** A key's host, from its base URL: where the key is used, never the key. */
export const hostOf = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
};

/** A month's spend, `$1,204.30`. */
export const formatSpend = (usd: number): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(usd);
