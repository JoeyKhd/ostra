import { describe, expect, it } from "vitest";

import { t } from "@/lib/messages";

import { destinations, matchDestinations } from "./destinations";

const projects = [
  { id: "p1", name: "calculator", colour: "#6FB8AA" },
  { id: "p2", name: "billing-platform", colour: "#8C7CF0" },
];

describe("search ⌘K's destinations", () => {
  it("lists the sidebar's pages, with each project's Tasks and Environment", () => {
    const hrefs = destinations(projects, true).map((destination) => destination.href);
    expect(hrefs).toEqual([
      "/",
      "/tasks/new",
      "/projects/p1",
      "/projects/p1",
      "/projects/p1/environment",
      "/projects/p2",
      "/projects/p2",
      "/projects/p2/environment",
      "/projects/new",
      "/organization/runners",
      "/organization/models",
      "/organization/github",
    ]);
  });

  it("leaves the admin pages out for a member, as the sidebar does", () => {
    const hrefs = destinations(projects, false).map((destination) => destination.href);
    expect(hrefs).not.toContain("/projects/new");
    expect(hrefs).not.toContain("/organization/models");
    expect(hrefs).not.toContain("/organization/github");
    expect(hrefs).toContain("/organization/runners");
  });

  it("matches every word of the query against the label and the project", () => {
    const list = destinations(projects, true);
    const found = matchDestinations(list, "env calc");
    expect(found).toHaveLength(1);
    expect(found[0]?.href).toBe("/projects/p1/environment");
    expect(matchDestinations(list, "BILLING").map((destination) => destination.label)).toEqual([
      "billing-platform",
      t("shell.tasks"),
      t("shell.environment"),
    ]);
  });

  it("keeps everything for an empty query, and nothing for a query that matches nothing", () => {
    const list = destinations(projects, true);
    expect(matchDestinations(list, "   ")).toBe(list);
    expect(matchDestinations(list, "kubernetes")).toEqual([]);
  });
});
