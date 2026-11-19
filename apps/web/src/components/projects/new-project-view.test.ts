import { describe, expect, it } from "vitest";

import { filterRepos, slugOf } from "./new-project-view";

describe("Create a project", () => {
  it("makes a slug of lowercase letters, digits and inner hyphens", () => {
    expect(slugOf("Payments API")).toBe("payments-api");
    expect(slugOf("--Café 2--")).toBe("cafe-2");
    expect(slugOf("")).toBe("");
  });

  it("filters the listed repos by name, ignoring case, and lists them all for an empty filter", () => {
    const repos = [{ fullName: "acme/payments-api" }, { fullName: "acme/calculator-web" }, { fullName: "acme/docs" }];
    expect(filterRepos(repos, "CALC").map((repo) => repo.fullName)).toEqual(["acme/calculator-web"]);
    expect(filterRepos(repos, "  ")).toBe(repos);
    expect(filterRepos(repos, "zzz")).toEqual([]);
  });
});
