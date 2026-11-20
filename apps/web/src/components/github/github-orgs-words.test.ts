import { describe, expect, it } from "vitest";

import { appSettingsUrl, installUrl, orderInstallations, reposText } from "./github-orgs-words";

// F-136 (ticket 54): the words of several GitHub organizations.

describe("GitHub organizations, in words", () => {
  it("F-136: installations are ordered linked (the owner's first), waiting, suspended, removed", () => {
    const row = (accountLogin: string, state: "linked" | "waiting" | "suspended" | "removed") => ({ accountLogin, state, isOwner: accountLogin === "acme", repoSelection: "selected" as const, repos: [] });
    const ordered = orderInstallations([row("initech", "removed"), row("dana-dev", "waiting"), row("globex", "linked"), row("acme", "linked")]);
    expect(ordered.map((installation) => installation.accountLogin)).toEqual(["acme", "globex", "dana-dev", "initech"]);
  });

  it("F-136: repos, the install link and GitHub's own setting for a private App", () => {
    expect(reposText({ repoSelection: "all", repos: [] })).toBe("All repositories");
    expect(reposText({ repoSelection: "selected", repos: ["a/b"] })).toBe("1 repository");
    expect(reposText({ repoSelection: "selected", repos: ["a/b", "a/c"] })).toBe("2 repositories");
    // A waiting installation's repos are listed nowhere, so its count isn't known.
    expect(reposText({ repoSelection: "selected", repos: [] })).toBe("Selected repositories");
    expect(reposText({ repoSelection: null, repos: [] })).toBe("–");
    expect(installUrl("ostra-acme")).toBe("github.com/apps/ostra-acme/installations/new");
    expect(appSettingsUrl("ostra-acme", { login: "acme", kind: "organization" })).toBe("https://github.com/organizations/acme/settings/apps/ostra-acme/advanced");
    expect(appSettingsUrl("dana-app", { login: "dana", kind: "user" })).toBe("https://github.com/settings/apps/dana-app/advanced");
  });
});
