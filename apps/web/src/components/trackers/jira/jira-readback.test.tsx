import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Readback } from "./jira-readback";
import { TokenDone } from "./jira-steps";
import type { TokenDoneDetail } from "./jira-steps";
import type { JiraChecks } from "./jira-words";

// F-008/c1 and F-008/c8 drawn: the read-back is a list whose failed line is an alert, and step 2's
// done line carries the token's warning from 14 days before its date.

const checks: JiraChecks = {
  kind: "checked",
  account: { outcome: "ok", accountId: "app:ostra-bot", name: "ostra-bot", accountType: "app" },
  projects: { outcome: "ok", projects: [{ id: "10001", key: "PROJ", name: "calculator" }] },
  permissions: { outcome: "ok", projects: [{ id: "10001", key: "PROJ", name: "calculator", missing: [] }] },
  workflows: { outcome: "ok", readable: true, unreadable: [] },
  scopes: [
    { scope: "read:jira-work", state: "confirmed" },
    { scope: "write:jira-work", state: "unchecked" },
    { scope: "read:jira-user", state: "confirmed" },
    { scope: "read:workflow:jira", state: "confirmed" },
  ],
};

const done: TokenDoneDetail = {
  signsInAs: "ostra-bot",
  tokenExpiresAt: Date.UTC(2027, 8, 14),
  tokenExpiry: { state: "expires-soon", days: 9 },
  jira: { reach: { projects: [{ id: "10001", key: "PROJ", name: "calculator", permissions: ["BROWSE_PROJECTS"], missing: [] }], checkedAt: null } },
};

describe("the read-back", () => {
  it("F-008/c1: four lines in a list, each with its outcome's icon, and a refused token as one alert line", () => {
    const html = renderToStaticMarkup(<Readback readBack={checks} />);
    expect(html).toContain('role="list"');
    expect((html.match(/<li /g) ?? []).length).toBe(4);
    expect(html).toContain('data-outcome="ok"');
    expect(html).toContain("Signs in as");
    expect(html).toContain("Sees 1 project");
    expect(html).toContain("Reads their workflows");

    const refused = renderToStaticMarkup(<Readback readBack={{ kind: "refused", status: 401 }} />);
    expect(refused).toContain('role="alert"');
    expect(refused).toContain('data-outcome="fail"');
    expect(refused).toContain("401 Unauthorized");
    expect(refused).toContain("Jira refused the token");
  });
});

describe("step 2's done line", () => {
  it("F-008/c8: it says who the service account is and when the token expires, and warns from 14 days before", () => {
    const html = renderToStaticMarkup(<TokenDone detail={done} />);
    expect(html).toContain("ostra-bot");
    expect(html).toContain("sees 1 project");
    expect(html).toContain("expires on 14 Sep 2027");
    expect(html).toContain('data-testid="jira-token-expiry"');
    expect(html).toContain("Expires in 9 days, on 14 Sep 2027");
  });

  it("F-008/c8: a healthy token's done line has no warning", () => {
    const html = renderToStaticMarkup(<TokenDone detail={{ ...done, tokenExpiry: { state: "healthy" } }} />);
    expect(html).not.toContain('data-testid="jira-token-expiry"');
  });
});
