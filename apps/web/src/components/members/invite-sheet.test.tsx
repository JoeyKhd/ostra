import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { invitationIdSchema } from "@ostra/protocol";

import { CreatedBody } from "./invite-sheet";

// F-115, F-002 (ticket 32, member-invite.md): the invite sheet once the invitation is made. The link
// is shown once, to copy, with the line to send it privately; with mail off the sheet says so, and
// with mail on it names the address it was mailed to.

const created = {
  invitationId: invitationIdSchema.parse("01900000-0000-7000-8000-0000000000b1"),
  handle: "0123456789abcdef0123456789abcdef",
  link: "https://ostra.example/invite/01900000-0000-7000-8000-0000000000b1",
  expiresAt: Date.UTC(2026, 10, 27, 12),
  mailed: false,
  email: "sam@acme.dev",
  role: "member" as const,
  grants: [],
};

const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("the invite sheet's link (F-115, F-002)", () => {
  it("F-115/c3: with mail off, the sheet shows the invitation's link to copy and says mail is off; with mail on, it names the address mailed", () => {
    const off = text(renderToStaticMarkup(<CreatedBody created={created} organization="Acme" inviterName="Alex Kim" emailOn={false} projects={[]} />));
    expect(off).toContain(created.link);
    expect(off).toContain("Copy link");
    expect(off).toContain("Send it privately: anyone with this link can join as this person.");
    expect(off).toContain("Mail is off on this install. Send the link yourself.");
    expect(off).not.toContain("Mailed to");

    const on = text(renderToStaticMarkup(<CreatedBody created={{ ...created, mailed: true }} organization="Acme" inviterName="Alex Kim" emailOn projects={[]} />));
    expect(on).toContain(created.link);
    expect(on).toContain("Mailed to sam@acme.dev");
    expect(on).not.toContain("Mail is off on this install.");
  });
});
