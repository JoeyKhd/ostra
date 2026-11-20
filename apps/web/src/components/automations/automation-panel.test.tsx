import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { agentProfileIdSchema, taskIdSchema } from "@ostra/protocol";

import { SkipReason } from "./automation-history";
import { madeLine, ProfileValue } from "./automations-view";

// Milestone 6's review follow-ups (ticket 41, F-011, F-106): the automations panel's footer and
// profile, and the history's skip reasons, as `automations.md` and `automation-history.md` give them.

const limits = { startsPerHour: 20, bulkStartMax: 50 };
const blocking = { id: taskIdSchema.parse("01900000-0000-7000-9000-0000000a17be"), shortId: "000a17be", state: "in_review" };

describe("the automations panel and history (automations.md, automation-history.md)", () => {
  it("F-011/c1: Created names who made it and who edited it, and the profile is a link for organization admins only", () => {
    const made = { createdAt: 0, updatedAt: 30_000, createdByName: "Alex Kim", updatedByName: null };
    expect(madeLine(made, "18 Nov", "2 h")).toBe("Created 18 Nov by Alex Kim");
    expect(madeLine({ ...made, updatedAt: 3_600_000, updatedByName: "Priya Nair" }, "18 Nov", "2 h")).toBe("Created 18 Nov by Alex Kim · edited 2 h ago by Priya Nair");
    expect(madeLine({ ...made, createdByName: null }, "18 Nov", "2 h")).toBe("Created 18 Nov");
    const profile = { id: agentProfileIdSchema.parse("01900000-0000-7000-8000-0000000000c1"), name: "Careful" };
    expect(renderToStaticMarkup(<ProfileValue profile={profile} organizationAdmin />)).toContain(`href="/organization/agent-profiles/${profile.id}"`);
    expect(renderToStaticMarkup(<ProfileValue profile={profile} organizationAdmin={false} />)).not.toContain("href=");
  });

  it("F-011/c1: a skip's reason links the task it was about", () => {
    const hasTask = renderToStaticMarkup(<SkipReason run={{ skipReason: "has_task", blockedBy: blocking }} limits={limits} />);
    expect(hasTask).toContain("It already has a task,");
    expect(hasTask).toContain(`href="/tasks/${blocking.id}"`);
    const open = renderToStaticMarkup(<SkipReason run={{ skipReason: "last_open", blockedBy: blocking }} limits={limits} />);
    expect(open).toContain("Waited for");
    expect(open).toContain(">000a17be</a>, still in review");
    expect(renderToStaticMarkup(<SkipReason run={{ skipReason: "budget", blockedBy: null }} limits={limits} />)).toContain("The project&#x27;s budget is spent");
  });
});
