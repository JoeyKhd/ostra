import { t } from "@/lib/messages";

// The words of "no key for this model" (F-135, app-targets/m4/no-key-for-model.md). Pure.

/** `Organization admins: Alex Kim, Priya Nair.`; three or more end with `and`. By name, never by address. */
export const adminNames = (names: readonly string[]): string => {
  const last = names.at(-1);
  const list = names.length <= 2 || last === undefined ? names.join(", ") : `${names.slice(0, -1).join(", ")} ${t("noKey.and")} ${last}`;
  return t("noKey.admins", { names: list });
};
