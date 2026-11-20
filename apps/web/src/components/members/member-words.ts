import { plural, t } from "@/lib/messages";

// The Members page's words (members.md, Heading and States), apart from the view so each form is
// tested without a browser.

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** A day as the panel writes it: `12 Nov`. */
export const shortDate = (at: number): string => {
  const date = new Date(at);
  return `${String(date.getDate())} ${months[date.getMonth()] ?? ""}`;
};

/** Last active: `now` under 2 minutes, `14m ago`, `2h ago`, `3d ago`, then the date `12 Nov`. */
export const lastActiveText = (at: number, now: number): string => {
  const since = Math.max(0, now - at);
  if (since < 2 * minute) return t("members.now");
  if (since < hour) return t("members.ago", { age: t("units.minutesShort", { n: Math.floor(since / minute) }) });
  if (since < day) return t("members.ago", { age: t("units.hoursShort", { n: Math.floor(since / hour) }) });
  if (since < 7 * day) return t("members.ago", { age: t("units.daysShort", { n: Math.floor(since / day) }) });
  return shortDate(at);
};

/** A pending invitation's last column: `expires in 7 days`, `expires in 1 day`, `expires today`. */
export const expiryText = (expiresAt: number, now: number): string => {
  const days = Math.floor((expiresAt - now) / day);
  if (days <= 0) return t("members.expiresToday");
  if (days === 1) return t("members.expiresInOne");
  return t("members.expiresIn", { n: days });
};

/** The admin's lede: `Who belongs to Acme Corp. 5 members, 2 of them admins, and 2 invitations waiting.` */
export const adminLede = (organization: string, members: number, admins: number, pending: number): string =>
  t("members.ledeAdmin", {
    organization,
    members: plural(members, "members.membersOne", "members.membersOther"),
    admins: admins === 0 ? t("members.adminsNone") : plural(admins, "members.adminsOne", "members.adminsOther"),
    pending: pending === 0 ? "" : plural(pending, "members.pendingOne", "members.pendingOther"),
  });

/** What removal ends (ADR 0053's transaction), one line per effect, before it runs. */
export const removalLines = (organization: string): readonly string[] => [
  t("members.removeAccess", { organization }),
  t("members.removeRunners"),
  t("members.removeDriving"),
  t("members.removeDrafts"),
  t("members.removeInvitations"),
];

/** A loose check of an address before the server's: something, an `@`, something, a dot. */
export const addressProblem = (address: string): "empty" | "invalid" | null => {
  const value = address.trim();
  if (value === "") return "empty";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : "invalid";
};
