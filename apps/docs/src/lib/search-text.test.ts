import { describe, expect, it } from "vitest";

import { headingTitlesOf, plainHeading, plainStructuredData, plainText } from "./search-text";

// Records as Fumadocs writes them: slices of the pages' Markdown (runners/pools.mdx, install/setup.mdx,
// agents-and-models/approval-rules.mdx, install/from-source.mdx).
const poolsToken =
  "Select the pool, then **New token** under **Join tokens**. The token is shown once and stored only as a hash, so copy it now.";

describe("the search index's text", () => {
  it("F-058: a snippet is the text a reader sees, with no Markdown: no emphasis marks, backticks, alert markers or table pipes", () => {
    expect(plainText(poolsToken)).toBe(
      "Select the pool, then New token under Join tokens. The token is shown once and stored only as a hash, so copy it now.",
    );
    expect(plainText("Set `OSTRA_JOIN_TOKEN` or pass `--token`, as in [Personal runners](/docs/runners/personal).")).toBe(
      "Set OSTRA_JOIN_TOKEN or pass --token, as in Personal runners.",
    );
    expect(plainText("> [!WARNING]\n> A rule keeps a person in the loop. It _doesn't_ contain the agent.")).toBe(
      "A rule keeps a person in the loop. It doesn't contain the agent.",
    );
    expect(plainText("| Tool            | Matches     |\n| --------------- | ----------- |\n| **Fetch a URL** | **Any URL** |")).toBe(
      "Tool Matches Fetch a URL Any URL",
    );
    expect(plainText("On Windows, keep the checkout's path short, such as `C:\\src\\ostra`.")).toBe(
      "On Windows, keep the checkout's path short, such as C:\\src\\ostra.",
    );
  });

  it("F-058: keeps a setting's name whole, underscores and all", () => {
    expect(plainText("`OSTRA_JOIN_TOKEN_FILE` reads the token from a file, as OSTRA_JOIN_TOKEN would.")).toBe(
      "OSTRA_JOIN_TOKEN_FILE reads the token from a file, as OSTRA_JOIN_TOKEN would.",
    );
  });

  it("F-058: a heading keeps its text as written, a step's number and its case included", () => {
    expect(plainHeading("6. Connect a runner")).toBe("6. Connect a runner");
    expect(plainHeading("Run `ostra runner` as a service")).toBe("Run ostra runner as a service");
    expect(headingTitlesOf("/docs/install/setup", { headings: [{ id: "connect-a-runner", content: "6. Connect a runner" }], contents: [] })).toEqual({
      "/docs/install/setup#connect-a-runner": "6. Connect a runner",
    });
  });

  it("F-058: a page's structured data is given to the index as plain text, and an empty record is dropped", () => {
    expect(
      plainStructuredData({
        headings: [{ id: "make-a-join-token", content: "Make a join token" }],
        contents: [
          { heading: "make-a-join-token", content: poolsToken },
          { heading: "make-a-join-token", content: "<!-- a comment -->" },
        ],
      }),
    ).toEqual({
      headings: [{ id: "make-a-join-token", content: "Make a join token" }],
      contents: [
        {
          heading: "make-a-join-token",
          content: "Select the pool, then New token under Join tokens. The token is shown once and stored only as a hash, so copy it now.",
        },
      ],
    });
  });
});
