import type { Db } from "@ostra/db";

// The install's own email settings and the saved row (F-115, ADR 0050, ticket 21). Saving the
// form and the test mail are ticket 37's (`notification-settings.ts`); this keeps the row in step
// with `OSTRA_EMAIL_*` so every path that reads the row sees the lock.

/**
 * The install's settings decide the email (`OSTRA_EMAIL_*`): the row follows them and locks. When
 * they don't, the row is unlocked and keeps whatever an admin saved. Run at start-up and safe to
 * run twice. The secrets in the settings are never written here.
 */
export const syncEmailSettingsRow = async (
  db: Db,
  fromSettings:
    | { readonly source: "panel" }
    | { readonly source: "settings"; readonly provider: "off" }
    | { readonly source: "settings"; readonly provider: "resend"; readonly from: string; readonly fromName: string }
    | {
        readonly source: "settings";
        readonly provider: "smtp";
        readonly from: string;
        readonly fromName: string;
        readonly host: string;
        readonly port: number;
        readonly secure: "starttls" | "tls" | "none";
        readonly user: string | null;
      },
): Promise<void> => {
  switch (fromSettings.source) {
    case "panel":
      await db.emailSettings.upsert({ where: { id: "instance" }, create: { id: "instance" }, update: { lockedBySettings: false } });
      return;
    case "settings":
      break;
    default:
      return fromSettings satisfies never;
  }
  switch (fromSettings.provider) {
    case "off":
      await db.emailSettings.upsert({
        where: { id: "instance" },
        create: { id: "instance", provider: "off", lockedBySettings: true },
        update: { provider: "off", lockedBySettings: true },
      });
      return;
    case "resend": {
      const data = { provider: "resend", fromAddress: fromSettings.from, fromName: fromSettings.fromName, lockedBySettings: true } as const;
      await db.emailSettings.upsert({ where: { id: "instance" }, create: { id: "instance", ...data }, update: data });
      return;
    }
    case "smtp": {
      const data = {
        provider: "smtp",
        fromAddress: fromSettings.from,
        fromName: fromSettings.fromName,
        smtpHost: fromSettings.host,
        smtpPort: fromSettings.port,
        smtpSecure: fromSettings.secure,
        smtpUser: fromSettings.user,
        lockedBySettings: true,
      } as const;
      await db.emailSettings.upsert({ where: { id: "instance" }, create: { id: "instance", ...data }, update: data });
      return;
    }
    default:
      return fromSettings satisfies never;
  }
};
