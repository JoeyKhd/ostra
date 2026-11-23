import { describe, expect, it } from "vitest";

import { connectionIdSchema } from "@ostra/protocol";

import {
  expiryWarning,
  jiraDefaultName,
  jiraSiteHost,
  jiraSiteName,
  jiraSteps,
  plainText,
  readbackFailure,
  readbackLines,
  siteRefusal,
  tokenAction,
  tokenDoneWords,
} from "./jira-words";
import type { JiraChecks, JiraDetail } from "./jira-words";

// F-008 (Jira's connect steps), F-152/c2 (one connection per site) and F-008/c8 (the token's date),
// in words: what step 1 makes of a pasted URL, how step 2's read-back reads and when it may save,
// step 1's refusal with the holder, and the done line's warning. Pure, so every state is read here
// and the browser spec (`e2e/29-jira-connect.spec.ts`) proves the same through the panel.

const project = (id: string, key: string, name: string) => ({ id, key, name });

const checks = (over: Partial<JiraChecks> = {}): JiraChecks => ({
  kind: "checked",
  account: { outcome: "ok", accountId: "app:ostra-bot", name: "ostra-bot", accountType: "app" },
  projects: { outcome: "ok", projects: [project("10001", "PROJ", "Calculator")] },
  permissions: { outcome: "ok", projects: [{ ...project("10001", "PROJ", "Calculator"), missing: [] }] },
  workflows: { outcome: "ok", readable: true, unreadable: [] },
  scopes: [
    { scope: "read:jira-work", state: "confirmed" },
    { scope: "write:jira-work", state: "unchecked" },
    { scope: "read:jira-user", state: "confirmed" },
    { scope: "read:workflow:jira", state: "confirmed" },
  ],
  ...over,
});

const detail = (over: { readonly signsInAs?: string | null; readonly tokenExpiresAt?: number | null; readonly tokenExpiry?: JiraDetail["tokenExpiry"]; readonly projects?: readonly { readonly id: string; readonly key: string; readonly name: string }[] }): Pick<JiraDetail, "signsInAs" | "tokenExpiresAt" | "tokenExpiry"> & { readonly jira: Pick<JiraDetail["jira"], "reach"> } => ({
  signsInAs: over.signsInAs === undefined ? "ostra-bot" : over.signsInAs,
  tokenExpiresAt: over.tokenExpiresAt === undefined ? Date.UTC(2027, 8, 14) : over.tokenExpiresAt,
  tokenExpiry: over.tokenExpiry === undefined ? { state: "healthy" } : over.tokenExpiry,
  jira: {
    reach: {
      projects: (over.projects ?? [project("10001", "PROJ", "Calculator"), project("10002", "SHOP", "Shop")]).map(
        (one): NonNullable<JiraDetail["jira"]["reach"]>["projects"][number] => ({ ...one, permissions: ["BROWSE_PROJECTS"], missing: [] }),
      ),
      checkedAt: Date.UTC(2026, 10, 23, 14, 2),
    },
  },
});

describe("step 1: the site", () => {
  it("F-008/c1: a pasted URL is trimmed to the site's name, a Cloud host stays a host, and the name is prefilled from it", () => {
    expect(jiraSiteName("  Globex ")).toBe("globex");
    expect(jiraSiteName("https://globex.atlassian.net/jira/software/projects/PROJ/boards")).toBe("globex");
    expect(jiraSiteName("globex.atlassian.net")).toBe("globex");
    expect(jiraSiteName("jira.initech.example")).toBe("jira.initech.example");
    expect(jiraSiteHost("globex")).toBe("globex.atlassian.net");
    expect(jiraSiteHost("jira.initech.example")).toBe("jira.initech.example");
    expect(jiraDefaultName("globex")).toBe("Globex Jira");
    expect(jiraDefaultName("acme-corp")).toBe("Acme Corp Jira");
  });

  it("F-152/c2: a site another connection holds is refused, naming it, with the holder for Open it →", () => {
    const holder = { id: connectionIdSchema.parse("01900000-0000-7000-8000-0000000000c7"), name: "Globex Jira" };
    const refused = siteRefusal({ ok: false, error: "site-taken", message: "taken", holder }, "globex", "Globex Jira");
    expect(refused.text).toBe("globex.atlassian.net is already connected, as Globex Jira.");
    expect(refused.holder).toEqual(holder);
    expect(siteRefusal({ ok: false, error: "data-center", message: "dc" }, "jira.initech.example", "Jira").text).toBe("That's a Jira Data Center address. ostra connects to Jira Cloud only.");
    expect(siteRefusal({ ok: false, error: "not-found", message: "nf" }, "globex-shop", "Jira")).toEqual({
      text: "No Jira Cloud site answers at globex-shop.atlassian.net. Check the name in the browser's address bar when you're in Jira.",
      holder: null,
    });
  });

  it("F-008/c1: the steps open at 1 until the site and the token are found, and a reopened step is open again", () => {
    const pending = { name: "Jira", jira: { cloudId: null, email: null }, tokenExpiresAt: null };
    expect(jiraSteps(pending)).toEqual({ site: false, token: false, current: 1, done: 0 });
    const site = { name: "Globex Jira", jira: { cloudId: "cloud-1", email: null }, tokenExpiresAt: null };
    expect(jiraSteps(site)).toEqual({ site: true, token: false, current: 2, done: 1 });
    const token = { name: "Globex Jira", jira: { cloudId: "cloud-1", email: "ostra-bot@serviceaccount.atlassian.com" }, tokenExpiresAt: Date.UTC(2027, 8, 14) };
    expect(jiraSteps(token)).toEqual({ site: true, token: true, current: 3, done: 2 });
    expect(jiraSteps(token, 2)).toEqual({ site: true, token: false, current: 2, done: 1 });
    expect(jiraSteps(token, 1)).toEqual({ site: false, token: false, current: 1, done: 0 });
  });
});

describe("step 2: the read-back", () => {
  it("F-008/c1: four green lines when the token is a service account that reaches one project with every permission and reads its workflows", () => {
    const lines = readbackLines(checks());
    expect(lines.map((line) => line.id)).toEqual(["account", "projects", "permissions", "workflows"]);
    expect(lines.map((line) => line.outcome)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(lines[0]?.words.values["name"]).toEqual({ kind: "text", text: "ostra-bot", look: "mono" });
  });

  it("F-008/c1: a person's account, no project, a short permission and an unreadable workflow each say what to change", () => {
    const person = readbackLines(checks({ account: { outcome: "fail", accountId: "user:1", name: "Alex Kim", accountType: "atlassian" } }));
    expect(person[0]).toMatchObject({ id: "account", outcome: "fail" });
    expect(person[0]?.words.template).toContain("person's account");

    const none = readbackLines(checks({ projects: { outcome: "fail", projects: [] } }));
    expect(none.map((line) => line.id)).toEqual(["account", "projects"]);
    expect(none[1]?.words.template).toContain("sees no project");

    const short = readbackLines(
      checks({
        projects: { outcome: "ok", projects: [project("10001", "PROJ", "Calculator"), project("10002", "OPS", "Operations")] },
        permissions: { outcome: "warn", projects: [{ ...project("10001", "PROJ", "Calculator"), missing: [] }, { ...project("10002", "OPS", "Operations"), missing: ["TRANSITION_ISSUES", "ADD_COMMENTS"] }] },
      }),
    );
    expect(short.find((line) => line.id === "permissions-OPS")).toMatchObject({ outcome: "warn" });
    expect(short.find((line) => line.id === "permissions-OPS")?.words.template).toContain("Can't");

    const noScope = readbackLines(checks({ workflows: { outcome: "warn", readable: false, unreadable: [] } }));
    expect(noScope[3]).toMatchObject({ id: "workflows", outcome: "warn" });
    expect(plainText(noScope[3]?.words ?? { template: "", values: {} })).toContain("read:workflow:jira");
  });

  it("F-008/c1: a refused token is one red line with Jira's status, and only a pass or warnings may save", () => {
    expect(readbackFailure({ kind: "refused", status: 401 })).toMatchObject({ id: "refused", outcome: "fail" });
    expect(plainText(readbackFailure({ kind: "refused", status: 401 }).words)).toContain("401 Unauthorized");
    expect(plainText(readbackFailure({ kind: "refused", status: 403 }).words)).toContain("403 Forbidden");
    expect(readbackFailure({ kind: "unreachable", status: null }).outcome).toBe("fail");
    expect(tokenAction("pass")).toBe("save");
    expect(tokenAction("warnings")).toBe("save-anyway");
    expect(tokenAction("fail")).toBe("check");
    expect(tokenAction(null)).toBe("check");
  });
});

describe("step 2's done line, and the token's date", () => {
  it("F-008/c8: a token 14 days or less from its date warns on the done line, and a healthy one doesn't", () => {
    expect(expiryWarning(detail({ tokenExpiry: { state: "expires-soon", days: 13 } }))).toBe("Expires in 13 days, on 14 Sep 2027. Replace it before then: the connection fails on the day.");
    expect(expiryWarning(detail({ tokenExpiry: { state: "expires-soon", days: 1 } }))).toBe("Expires tomorrow, on 14 Sep 2027. Replace it before then: the connection fails on the day.");
    expect(expiryWarning(detail({ tokenExpiry: { state: "healthy" } }))).toBeNull();
    expect(expiryWarning(detail({ tokenExpiry: { state: "expired" } }))).toBeNull();
    expect(tokenDoneWords(detail({ tokenExpiry: { state: "expires-soon", days: 13 } })).template).toContain("expires on");
  });
});
