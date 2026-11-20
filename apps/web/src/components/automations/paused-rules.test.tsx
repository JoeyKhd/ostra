import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { automationIdSchema, projectIdSchema } from "@ostra/protocol";

import { PausedRuleRows } from "./paused-rules";

// Home's row for a rule its hourly limit paused (automations.md): the pause icon in the amber that
// reads on both themes (`--amber-text`), never the raw amber, which is 1.9:1 on the light page.

describe("a paused rule on Home", () => {
  it("draws its pause icon in the amber text colour, readable on the light theme", () => {
    const html = renderToStaticMarkup(
      <PausedRuleRows
        rules={[
          {
            id: automationIdSchema.parse("019a0000-0000-7000-8000-0000000000a1"),
            name: "Label ostra-auto",
            projectId: projectIdSchema.parse("019a0000-0000-7000-8000-0000000000b1"),
            projectName: "test2",
            pausedAt: Date.UTC(2026, 10, 20),
            startsPerHour: 20,
          },
        ]}
      />,
    );
    expect(html).toContain("text-amber-text");
    expect(html).not.toMatch(/text-amber(?!-text)/);
  });
});
