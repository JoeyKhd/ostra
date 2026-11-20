import type { SearchResultItem } from "fumadocs-core/search/client";
import { describe, expect, it } from "vitest";

import { groupResults } from "./search-results";

/** A record as the client gives it; the dialog reads its `content`, not its parsed form. */
const record = (fields: Omit<Extract<SearchResultItem, { content: string }>, "hastContent">): SearchResultItem => ({
  ...fields,
  hastContent: { type: "root", children: [] },
});

// Results as the static index returns them for `connect runner`: the setup page, then a text record
// under its step `6. Connect a runner`, a heading the query's words don't start.
const results: SearchResultItem[] = [
  record({ id: "/docs/install/setup", type: "page", content: "Setup in the panel", breadcrumbs: ["Install"], url: "/docs/install/setup" }),
  record({
    id: "/docs/install/setup-30",
    type: "text",
    content: "Copy the command the panel shows to connect a runner to the pool, and run it on the machine.",
    url: "/docs/install/setup#connect-a-runner",
  }),
];

const headings = { "/docs/install/setup#connect-a-runner": "6. Connect a runner" };

describe("the search dialog's results", () => {
  it("F-058/c1: a text match's heading row shows its heading as written, a step's number and its case included", () => {
    const [group] = groupResults(results, "connect runner", headings);
    expect(group?.path).toBe("Install › Setup in the panel");
    expect(group?.rows.map((row) => [row.kind, row.title, row.url])).toEqual([
      ["heading", "6. Connect a runner", "/docs/install/setup#connect-a-runner"],
    ]);
    expect(group?.rows[0]?.snippet).toBe("Copy the command the panel shows to connect a runner to the pool, and run it on the machine.");
  });

  it("F-058: a setting's heading row is drawn in mono", () => {
    const [group] = groupResults(
      [
        record({ id: "/docs/reference/configuration", type: "page", content: "Configuration", breadcrumbs: ["Reference"], url: "/docs/reference/configuration" }),
        record({ id: "/docs/reference/configuration-9", type: "text", content: "The join token a runner presents.", url: "/docs/reference/configuration#OSTRA_JOIN_TOKEN" }),
      ],
      "runner presents",
      { "/docs/reference/configuration#OSTRA_JOIN_TOKEN": "OSTRA_JOIN_TOKEN" },
    );
    expect(group?.rows).toMatchObject([{ kind: "heading", title: "OSTRA_JOIN_TOKEN", mono: true }]);
  });
});
