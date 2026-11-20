import path from "node:path";

import { newestMailTo } from "@ostra/dev-tools/mail-box";
import type { SunkMail } from "@ostra/dev-tools/mail-box";
import type { Page } from "@playwright/test";
import { z } from "zod";

import { runnerCode, signIn } from "./context.ts";
import type { Demo } from "./context.ts";
import type { Person } from "./settings.ts";
import { waitFor } from "./state.ts";
import { startPromptTask } from "./tasks.ts";

// Spec section 3, steps 1, 2, 12 and 14: people arrive by invitation, roles and project access,
// a third member and the instance admin's accounts, removal and resets.

/** When the sink took a mail, from its file's name (`2026-11-20T02-21-59-406Z-0001-…eml`), or 0. */
const tookAt = (file: string): number => {
  const match = /(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z/.exec(path.basename(file));
  if (match === null) return 0;
  const [, day = "", hours = "", minutes = "", secs = "", millis = ""] = match;
  return Date.parse(`${day}T${hours}:${minutes}:${secs}.${millis}Z`);
};

/** The newest mail to `address` whose subject matches, once it's newer than `after`. */
export const mailTo = async (d: Demo, address: string, subject: RegExp, after: number, timeoutMs = 120_000): Promise<SunkMail> =>
  waitFor(`a mail to ${address} matching ${subject.source}`, timeoutMs, async () => {
    const mail = await newestMailTo(address, d.settings.mailDir);
    if (mail === null || !subject.test(mail.subject)) return null;
    return tookAt(mail.file) >= after - 2000 ? mail : null;
  }, 1500);

const auditActions = async (d: Demo, since: number): Promise<readonly string[]> =>
  (await d.db.auditEntry.findMany({ where: { createdAt: { gte: new Date(since) } }, select: { action: true }, orderBy: { createdAt: "asc" } })).map((row) => row.action);

/** The project's Access tab: restricted (or open). */
const setAccess = async (d: Demo, projectId: string, access: "restricted" | "open"): Promise<void> => {
  const { demo } = d;
  await demo.goto(`/projects/${projectId}/settings/access`);
  await demo.getByRole("heading", { level: 1, name: "Access" }).waitFor();
  const current = await d.db.project.findUniqueOrThrow({ where: { id: projectId }, select: { access: true } });
  if (current.access === access) return;
  await demo.getByRole("radio", { name: access === "restricted" ? /Restricted/ : /Open/ }).click();
  await demo.getByRole("alertdialog").getByRole("button", { name: access === "restricted" ? "Restrict" : "Open it" }).click();
  await demo.getByRole("status").filter({ hasText: access }).first().waitFor({ timeout: 30_000 });
};

/** Members, "Invite": the link the panel shows once. */
export const invite = async (d: Demo, person: Person, grants: readonly string[], shotName: string): Promise<string> => {
  const { demo } = d;
  await demo.goto("/organization/members");
  await demo.waitForLoadState("networkidle");
  // An earlier, stopped run's invitation to the same address: revoked, so this one starts clean.
  const waiting = demo.getByTestId("invitation-row").filter({ hasText: person.email });
  if ((await waiting.count()) > 0) {
    await waiting.first().getByRole("button", { name: "Revoke" }).click();
    await demo.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
    await waiting.first().waitFor({ state: "detached", timeout: 15_000 });
  }
  await demo.getByRole("button", { name: "Invite" }).click();
  await demo.getByLabel("Address").fill(person.email);
  for (const projectId of grants) await demo.locator(`#grant-${projectId}`).click();
  await d.shot(demo, `${shotName}-sheet`);
  await demo.getByRole("button", { name: "Create invitation" }).click();
  const link = demo.getByTestId("invitation-link");
  await link.waitFor({ timeout: 30_000 });
  // The link is a bearer secret: masked in the committed screenshot.
  await demo.screenshot({ path: `${d.settings.screenshotDir}/${shotName}-link.png`, mask: [link] });
  const text = (await link.textContent())?.trim() ?? "";
  d.secrets.push(text);
  const sheet = await demo.locator("[role=dialog]").innerText();
  d.check(`${person.username}'s invitation: the link is shown once, with Copy link and Send it privately`, sheet.includes("Copy link") && /privately/i.test(sheet), "the sheet's actions");
  await demo.getByRole("button", { name: "Done" }).click();
  return text;
};

/** The invitee's side: the link from the mail, "Join Demo on ostra", then the verification mail. */
export const accept = async (d: Demo, person: Person, password: string, link: string, invitedAt: number, shotName: string): Promise<Page> => {
  const { settings } = d;
  const page = await d.freshPage();
  let joinedAt = Date.now();
  const membership = await d.db.member.findFirst({ where: { user: { username: person.username } }, select: { state: true } });
  const signedUp = membership !== null;
  if (membership?.state === "active") {
    // Verified in an earlier, stopped run: signs in.
    await signIn(page, person.username, password);
  } else if (signedUp) {
    // An earlier, stopped run signed up already: the link shows "Check your inbox", and "Send it again" mails a new check.
    await page.goto(new URL(link).pathname);
    await page.getByText("Check your inbox").first().waitFor({ timeout: 30_000 });
    await d.shot(page, `${shotName}-check-inbox`);
    joinedAt = Date.now();
    await page.getByRole("button", { name: "Send it again" }).click();
  } else {
    const mail = await mailTo(d, person.email, /invit/i, invitedAt);
    const linkInMail = mail.links.find((one) => one.includes("/invite/")) ?? "";
    d.check(`${person.username}'s invitation mail names the organization and who invited, with the link`, mail.text.includes(settings.organizationName) && mail.text.includes(settings.adminUsername) && linkInMail === link, `subject "${mail.subject}"`);
    await page.goto(new URL(linkInMail).pathname);
    await page.getByRole("heading", { level: 1 }).filter({ hasText: `Join ${settings.organizationName} on ostra` }).waitFor({ timeout: 30_000 });
    const locked = await page.locator("#invite-email").getAttribute("readonly");
    d.check(`${person.username}'s invitation page: the address is locked`, locked !== null, locked !== null ? "read-only" : "editable");
    await page.locator("#invite-username").fill(person.username);
    await page.locator("#invite-new-password").fill(password);
    await d.shot(page, `${shotName}-join`);
    joinedAt = Date.now();
    await page.getByRole("button", { name: `Join ${settings.organizationName}` }).click();
    await page.getByText("Check your inbox").first().waitFor({ timeout: 30_000 }).catch(async (error: unknown) => {
      await page.screenshot({ path: path.join(d.settings.m4StateDir, `fail-${shotName}-inbox.png`) });
      throw error;
    });
    d.check(`${person.username} sees Check your inbox`, true, "after Join");
    await d.shot(page, `${shotName}-check-inbox`);
  }
  if (membership?.state !== "active") await verifyByMail(d, page, person, password, joinedAt);
  await d.shot(page, `${shotName}-home`);
  const shell = await page.locator("body").innerText();
  d.check(`${person.username} lands on Home in ${settings.organizationName}`, new URL(page.url()).pathname === "/" && shell.includes(settings.organizationName), new URL(page.url()).pathname);
  return page;
};

/** The verification mail's link, opened in the invitee's browser: Home, or sign-in first. */
const verifyByMail = async (d: Demo, page: Page, person: Person, password: string, joinedAt: number): Promise<void> => {
  const { settings } = d;
  const verify = await mailTo(d, person.email, /verif|confirm|address|finish|join/i, joinedAt);
  const verifyLink = verify.links.find((one) => one.startsWith(settings.panelUrl) || one.includes("/api/auth/")) ?? verify.links[0] ?? "";
  d.check(`${person.username}'s verification mail arrives with a link`, verifyLink !== "", `subject "${verify.subject}"`);
  d.secrets.push(verifyLink);
  const url = new URL(verifyLink);
  await page.goto(`${url.pathname}${url.search}`);
  await page.waitForURL((at) => at.pathname === "/" || at.pathname === "/sign-in", { timeout: 60_000 });
  await page.waitForLoadState("networkidle");
  if (new URL(page.url()).pathname === "/sign-in") await signIn(page, person.username, password);
};

/** Step 1: test2 restricted; Sam invited with test2; the mail, the sign-up and the verification. */
export const invitation = async (d: Demo): Promise<void> => {
  const { demo, settings } = d;
  const test2 = d.id("project:test2");
  await setAccess(d, test2, "restricted");
  const invitedAt = Date.now();
  const signedUp = (await d.db.user.count({ where: { username: settings.sam.username } })) > 0;
  const link = signedUp ? (d.secrets.filter((one) => one.includes("/invite/")).at(-1) ?? "") : await invite(d, settings.sam, [test2], "step01-invite");
  const sam = await accept(d, settings.sam, d.passwords.sam, link, invitedAt, "step01-sam");
  await sam.context().close();
  await demo.goto("/organization/members");
  const row = demo.getByTestId("member-row").filter({ hasText: settings.sam.username });
  await row.first().waitFor({ timeout: 30_000 });
  await d.shot(demo, "step01-members");
  const invitation = await d.db.invitation.findFirst({ where: { email: settings.sam.email }, select: { status: true }, orderBy: { createdAt: "desc" } });
  d.check("step 1: Members lists Sam, and the invitation as accepted", (await row.count()) > 0 && invitation?.status === "accepted", `invitation ${invitation?.status ?? "missing"}`);
  const actions = await auditActions(d, 0);
  d.check(
    "step 1: the audit log has the invitation's creation, its acceptance and the verification",
    ["invitation.created", "invitation.accepted", "member.verified"].every((action) => actions.includes(action)),
    actions.filter((action) => action.startsWith("invitation.") || action.startsWith("member.")).join(", "),
  );
};

/** Sam's own personal runner, approved by Sam (Sam starts tasks in steps 2 and 9). */
const approveSamRunner = async (d: Demo, sam: Page): Promise<void> => {
  if (d.run.ids["samRunnerApproved"] !== undefined) return;
  const code = await waitFor("Sam's runner's code", 120_000, () => runnerCode(d.settings, "runner-2"));
  await sam.goto("/device");
  await sam.locator("#user-code").fill(code);
  await sam.getByRole("button", { name: "Continue" }).click();
  await sam.getByTestId("device-confirm").waitFor();
  await sam.getByRole("button", { name: "Approve" }).click();
  await sam.getByText(/^Approved\./).waitFor();
  d.run.ids["samRunnerApproved"] = "yes";
  await d.save();
};

const environmentSchema = z.looseObject({ baseImage: z.string().nullable(), setupScript: z.string().nullable() });

/** Step 2: test2's Access, a restricted `vault`, what Sam can and can't do, and a project admin. */
export const roles = async (d: Demo): Promise<void> => {
  const { demo, settings } = d;
  const test2 = d.id("project:test2");
  const since = Date.now();
  await demo.goto(`/projects/${test2}/settings/access`);
  const samRow = demo.getByTestId("access-row").filter({ hasText: settings.sam.username });
  await samRow.first().waitFor({ timeout: 30_000 });
  d.check("step 2: test2's Access lists Sam as a project member", (await samRow.first().innerText()).includes("Member"), await samRow.first().innerText());
  await d.shot(demo, "step02-test2-access");
  // vault: repo test2, restricted, nobody listed.
  if (d.run.ids["project:vault"] === undefined) {
    const { createRepoProject, projectIdOf } = await import("./steps-setup.ts");
    d.run.ids["project:vault"] = projectIdOf(await createRepoProject(d, "vault", settings.githubOtherRepo));
    await d.save();
  }
  const vault = d.id("project:vault");
  await setAccess(d, vault, "restricted");
  const sam = await d.page("sam");
  await sam.goto("/");
  await sam.waitForLoadState("networkidle");
  const nav = sam.getByRole("navigation", { name: "Navigation" });
  const sees = async (name: string) => (await nav.innerText()).split(/\r?\n/).some((line) => line.trim() === name);
  d.check("step 2: Sam's sidebar shows test1 and test2 and not vault", (await sees("test1")) && (await sees("test2")) && !(await sees("vault")), "the sidebar's projects");
  await d.shot(sam, "step02-sam-sidebar");
  await sam.goto(`/projects/${vault}`);
  await sam.waitForLoadState("networkidle");
  await sam.getByText(/not found|doesn't exist|can't find|no such project/i).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
  const vaultText = await sam.locator("main").innerText();
  d.check("step 2: vault's URL shows not found to Sam", /not found|doesn't exist|can't find|no such project/i.test(vaultText), vaultText.slice(0, 80));
  await d.shot(sam, "step02-sam-vault-not-found");
  const get = await d.query(sam, "projects.get", { projectId: vault });
  d.check("step 2: projects.get for vault as Sam is NOT_FOUND", !get.ok && get.code === "NOT_FOUND", get.ok ? "answered" : get.code);
  await sam.goto("/organization/members");
  await sam.waitForLoadState("networkidle");
  const invite = await d.mutate(sam, "members.invite", { email: "nobody@demo.test", role: "member", projectGrants: [] });
  d.check("step 2: members.invite as Sam is FORBIDDEN", !invite.ok && invite.code === "FORBIDDEN", invite.ok ? "answered" : invite.code);
  const orgNav = await nav.innerText();
  d.check("step 2: Sam sees no admin page under Organization", !/Models|GitHub|Linear|Spend|Audit log|Email|Accounts|Storage|Registry/.test(orgNav.split("Organization")[1] ?? ""), (orgNav.split("Organization")[1] ?? "").replace(/\s+/g, " ").trim());
  // Sam's own runner, then a prompt task in test2.
  await approveSamRunner(d, sam);
  if (d.run.ids["task:step2"] === undefined) {
    d.run.ids["task:step2"] = await startPromptTask(sam, test2, "List the files in the repo and stop", d.settings.secondRunner.runnerName);
    await d.save();
  }
  await d.shot(sam, "step02-sam-task");
  // A rerun after Sam was made test2's admin: the role's half happened; its checks are the first run's.
  if ((await d.db.projectMember.count({ where: { projectId: test2, member: { user: { username: settings.sam.username } }, role: "admin" } })) > 0) return;
  const env = await d.query(demo, "environments.get", { projectId: test2 });
  const current = environmentSchema.safeParse(env.ok ? env.data : null);
  const environment = { baseImage: current.success ? current.data.baseImage : null, setupScript: current.success ? current.data.setupScript : null, entries: [] };
  const refused = await d.mutate(sam, "environments.save", { projectId: test2, environment });
  d.check("step 2: Sam's save of test2's environment is FORBIDDEN", !refused.ok && refused.code === "FORBIDDEN", refused.ok ? "saved" : refused.code);
  // Demo makes Sam a project admin of test2 in its Access tab.
  await demo.goto(`/projects/${test2}/settings/access`);
  const row = demo.getByTestId("access-row").filter({ hasText: settings.sam.username }).first();
  await row.getByRole("combobox", { name: "Project role" }).click();
  await demo.getByRole("option", { name: "Admin" }).click();
  await demo.getByRole("status").filter({ hasText: "admin here now" }).first().waitFor({ timeout: 30_000 });
  await d.shot(demo, "step02-sam-project-admin");
  const saved = await d.mutate(sam, "environments.save", { projectId: test2, environment });
  d.check("step 2: Sam's next save goes through", saved.ok, saved.ok ? "saved" : saved.code);
  const actions = await auditActions(d, since);
  d.check(
    "step 2: each change is an audit entry",
    ["project.created", "project.access-changed", "task.created", "project.member-set", "environment.saved"].every((action) => actions.includes(action)),
    actions.join(", "),
  );
};
