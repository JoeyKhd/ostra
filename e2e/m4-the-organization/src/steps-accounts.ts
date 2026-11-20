import path from "node:path";

import { signIn } from "./context.ts";
import type { Demo } from "./context.ts";
import { accept, invite, mailTo } from "./steps-people.ts";

// Spec section 3, steps 12 and 14: a third member and the instance admin's accounts, removal and resets.

/** Step 12: Rae joins as a member; Instance, Accounts; Sam made an instance admin and back. */
export const third = async (d: Demo): Promise<void> => {
  const { demo, settings } = d;
  if ((await d.db.member.count({ where: { user: { username: settings.rae.username } } })) === 0) {
    const invitedAt = Date.now();
    const link = await invite(d, settings.rae, [], "step12-invite");
    const joined = await accept(d, settings.rae, d.passwords.rae, link, invitedAt, "step12-rae");
    await joined.context().close();
  }
  const rae = await d.page("rae");
  await rae.goto("/");
  await rae.waitForLoadState("networkidle");
  const nav = rae.getByRole("navigation", { name: "Navigation" });
  const sees = async (name: string) => (await nav.innerText()).split(/\r?\n/).some((line) => line.trim() === name);
  // The spec says Rae sees test1 and test2, but step 1 made test2 restricted, listing Sam only, and
  // Rae is invited with no restricted project: Rae sees test1, and neither test2 nor vault.
  d.check("step 12: Rae sees test1, and not the restricted test2 or vault", (await sees("test1")) && !(await sees("test2")) && !(await sees("vault")), "Rae's sidebar");
  await d.shot(rae, "step12-rae-sidebar");
  await demo.goto("/instance/accounts");
  await demo.getByRole("heading", { level: 1, name: "Accounts" }).waitFor();
  const search = demo.getByLabel("Search by username or address");
  let found = 0;
  for (const [query, name] of [[settings.adminUsername, settings.adminUsername], [settings.sam.username, settings.sam.username], [settings.rae.email, settings.rae.username]] as const) {
    await search.fill(query);
    await demo.waitForTimeout(1200);
    if ((await demo.getByRole("button", { name: new RegExp(name) }).count()) > 0) found += 1;
  }
  d.check("step 12: Accounts finds Demo, Sam and Rae by username or address", found === 3, `found ${String(found)} of 3`);
  await search.fill("");
  await demo.waitForTimeout(800);
  await d.shot(demo, "step12-accounts");
  const samUser = await d.db.user.findFirstOrThrow({ where: { username: settings.sam.username }, select: { id: true } });
  await search.fill(settings.sam.username);
  await demo.getByRole("button", { name: new RegExp(settings.sam.username) }).first().click();
  await demo.getByRole("button", { name: "Make instance admin" }).click();
  const confirm = demo.getByRole("alertdialog");
  if ((await confirm.count()) > 0) await confirm.getByRole("button").last().click();
  await demo.waitForTimeout(2000);
  const granted = await d.db.user.findUniqueOrThrow({ where: { id: samUser.id }, select: { role: true } });
  d.check("step 12: Demo makes Sam an instance admin", granted.role === "admin", granted.role ?? "no role");
  await d.shot(demo, "step12-sam-instance-admin");
  const revoked = await d.mutate(demo, "instance.revokeAdmin", { userId: samUser.id });
  d.check("step 12: then removes the role again", revoked.ok, revoked.ok ? "revoked" : revoked.code);
  await demo.goto("/instance/accounts");
  await demo.getByTestId("instance-admin-row").first().waitFor();
  const rows = await demo.getByTestId("instance-admin-row").count();
  const removable = await demo.getByTestId("instance-admin-row").getByRole("button", { name: "Remove" }).count();
  d.check("step 12: with Demo the only instance admin, Demo's own row has no Remove", rows === 1 && removable === 0, `${String(rows)} admin rows, ${String(removable)} Remove buttons`);
  await d.shot(demo, "step12-only-admin");
  const shell = await demo.getByRole("navigation", { name: "Navigation" }).innerText();
  const organizations = await d.db.organization.count();
  d.check("step 12: the sidebar's organization row reads Demo, the install's one organization", shell.includes(settings.organizationName) && organizations === 1, `${String(organizations)} organization`);
};

/** Step 14: Rae removed; Sam resets by mail and the other browser signs out; a reset link with email off. */
export const removalAndResets = async (d: Demo): Promise<void> => {
  const { demo, settings } = d;
  const rae = await d.page("rae");
  const raeMember = await d.db.member.findFirstOrThrow({ where: { user: { username: settings.rae.username } }, select: { id: true, state: true } });
  if (raeMember.state !== "removed") {
    await demo.goto("/organization/members");
    // The row menu: the role, then "Remove from Demo".
    await demo.getByRole("button", { name: `Actions for ${settings.rae.username}` }).first().click();
    await demo.getByRole("menuitem", { name: /Remove from/ }).first().click();
    await d.shot(demo, "step14-remove-rae");
    await demo.getByRole("alertdialog").getByRole("button", { name: /Remove/ }).last().click();
    await demo.waitForTimeout(2500);
  }
  await rae.reload();
  await rae.waitForLoadState("networkidle");
  await rae.waitForTimeout(1500);
  const raeText = await rae.locator("body").innerText();
  d.check("step 14: Rae's open page says Rae is no longer a member of any organization", /no longer a member|not a member of any/i.test(raeText), raeText.replace(/\s+/g, " ").slice(0, 120));
  await d.shot(rae, "step14-rae-removed");
  await demo.goto(`/organization/audit?actor=${raeMember.id}&period=all`);
  await demo.getByTestId("audit-row").first().waitFor({ timeout: 30_000 }).catch(() => undefined);
  const raeEntries = await demo.locator("main").innerText();
  d.check("step 14: the audit log shows Rae (removed)", raeEntries.includes("(removed)"), raeEntries.includes("(removed)") ? "Rae (removed)" : "no (removed) mark");
  await d.shot(demo, "step14-audit-rae-removed");
  // Sam: Forgot your password?, the mail, a new password, and the other browser signed out.
  const other = await d.freshPage();
  await signIn(other, settings.sam.username, d.run.notes["password:sam"] === "samFinal" ? d.passwords.samFinal : d.passwords.sam);
  const forgot = await d.freshPage();
  await forgot.goto("/sign-in");
  await forgot.getByText("Forgot your password?").first().click();
  await forgot.getByLabel("Email").fill(settings.sam.email);
  const askedAt = Date.now();
  await forgot.getByRole("button", { name: "Send reset link" }).click();
  await forgot.getByText("Check your inbox").first().waitFor({ timeout: 30_000 });
  const mail = await mailTo(d, settings.sam.email, /reset|password/i, askedAt);
  const link = mail.links.find((one) => one.includes("/reset/new")) ?? mail.links[0] ?? "";
  d.check("step 14: Sam gets the reset mail", link !== "", `subject "${mail.subject}"`);
  d.secrets.push(link);
  const url = new URL(link);
  await forgot.goto(`${url.pathname}${url.search}`);
  await forgot.getByLabel("New password", { exact: true }).fill(d.passwords.samReset);
  await forgot.getByLabel("Confirm the new password").fill(d.passwords.samReset);
  await forgot.getByRole("button", { name: "Save new password" }).click();
  await forgot.getByText("Password changed").waitFor({ timeout: 30_000 });
  await d.shot(forgot, "step14-sam-password-changed");
  d.run.notes["password:sam"] = "samReset";
  await d.forget("sam");
  await other.reload();
  await other.waitForLoadState("networkidle");
  d.check("step 14: Sam's other browser is signed out", new URL(other.url()).pathname === "/sign-in", new URL(other.url()).pathname);
  // Email off; the instance admin's reset link for Sam, once.
  const off = await d.mutate(demo, "email.save", { provider: "off" });
  d.check("step 14: the instance admin switches email off", off.ok, off.ok ? "off" : off.code);
  await demo.goto("/instance/accounts");
  await demo.getByLabel("Search by username or address").fill(settings.sam.username);
  await demo.getByRole("button", { name: new RegExp(settings.sam.username) }).first().click();
  await demo.getByRole("button", { name: "Create reset link" }).click();
  const shown = demo.getByTestId("reset-link");
  await shown.waitFor({ timeout: 20_000 });
  const resetLink = (await shown.getAttribute("aria-label")) ?? "";
  d.secrets.push(resetLink);
  // The link is a bearer secret: masked in the committed screenshot.
  await demo.screenshot({ path: path.join(settings.screenshotDir, "step14-reset-link.png"), mask: [shown] });
  const holder = await d.freshPage();
  const resetUrl = new URL(resetLink);
  await holder.goto(`${resetUrl.pathname}${resetUrl.search}`);
  await holder.getByLabel("New password", { exact: true }).fill(d.passwords.samFinal);
  await holder.getByLabel("Confirm the new password").fill(d.passwords.samFinal);
  await holder.getByRole("button", { name: "Save new password" }).click();
  const worked = await holder.getByText("Password changed").waitFor({ timeout: 30_000 }).then(() => true, () => false);
  d.check("step 14: the reset link works", worked, worked ? "Password changed" : "no");
  if (worked) d.run.notes["password:sam"] = "samFinal";
  await d.save();
  const again = await d.freshPage();
  await again.goto(`${resetUrl.pathname}${resetUrl.search}`);
  const refused = await again.getByText("This reset link has been used").waitFor({ timeout: 20_000 }).then(() => true, () => false);
  d.check("step 14: its second use is refused", refused, refused ? "This reset link has been used" : "not refused");
  await d.shot(again, "step14-reset-used");
  for (const page of [other, forgot, holder, again]) await page.context().close().catch(() => undefined);
};
