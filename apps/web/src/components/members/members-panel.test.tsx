import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { memberIdSchema, userIdSchema } from "@ostra/protocol";

import { removalLines, removedText } from "./member-words";
import { MemberProperties } from "./members-view";

// F-002 (ticket 32, members.md): what an admin sees of a member before removing them. The panel's
// "Invited by" and "On their behalf", the removal dialog's lines with their counts, and a removed
// row's remover, all from `members.list`'s admin fields.

const at = Date.UTC(2026, 10, 12, 12);
const sam = {
  memberId: memberIdSchema.parse("01900000-0000-7000-8000-0000000000a1"),
  userId: userIdSchema.parse("01900000-0000-7000-8000-0000000000a2"),
  name: "Sam Rivera",
  username: "sam",
  email: "sam@acme.dev",
  role: "member" as const,
  state: "active" as const,
  projects: [],
  joinedAt: at,
  lastActiveAt: at,
  removedAt: null,
  invitedBy: "Alex Kim",
  removedBy: null,
  onBehalf: { personalRunners: 1, cliSessions: 2, drivingTasks: 3, draftComments: 0, invitationsSent: 0 },
};

const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("the member panel and the removal dialog (F-002)", () => {
  it("F-002: the panel names who invited them and counts what removal ends", () => {
    const html = text(renderToStaticMarkup(<MemberProperties member={sam} now={at} />));
    expect(html).toContain("Invited by Alex Kim");
    expect(html).toContain("On their behalf Personal runners 1 CLI sessions 2 Tasks they drive 3");
    // The first admin joined without an invitation; a member's view has no counts.
    const first = text(renderToStaticMarkup(<MemberProperties member={{ ...sam, invitedBy: null, onBehalf: null }} now={at} />));
    expect(first).toContain("Invited by —");
    expect(first).not.toContain("On their behalf");
  });

  it("F-002: the removal dialog lists each effect with its count, and only the counts that aren't zero", () => {
    expect(removalLines("Acme Corp", sam.onBehalf)).toEqual([
      "They lose access to Acme Corp and its projects.",
      "1 personal runner revoked.",
      "2 CLI sessions signed out.",
      "They stop driving 3 tasks. Their needs-you items go to each project's members.",
    ]);
    expect(removalLines("Acme Corp", { personalRunners: 0, cliSessions: 1, drivingTasks: 1, draftComments: 4, invitationsSent: 2 })).toEqual([
      "They lose access to Acme Corp and its projects.",
      "1 CLI session signed out.",
      "They stop driving 1 task. Their needs-you items go to each project's members.",
      "Their draft diff comments are deleted.",
      "2 invitations they sent revoked.",
    ]);
  });

  it("F-002: a removed row names who removed them", () => {
    expect(removedText(Date.UTC(2026, 10, 14, 12), "Alex Kim")).toBe("removed 14 Nov by Alex Kim");
    expect(removedText(Date.UTC(2026, 10, 14, 12), null)).toBe("removed 14 Nov");
  });
});
