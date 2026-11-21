import type { PreviewNoticeSubject } from "@ostra/adapter-sdk";
import { describe, expect, it } from "vitest";

import { previewNoticeHeading, renderPreviewNotice, sharedPreviewUrl } from "./preview-notices.ts";

// F-142 (milestone 8): the notice a person named on a preview gets renders in the panel and in both
// parts of a mail with the preview's label and port, who shared it, the organization and the
// preview's own page, and never anything of the task, which the person may not see.

/** A naming as core reads it when the notice is due, beside the task's own words. */
const named = {
  label: "web",
  port: 5173,
  sharedBy: "Alex Kim",
  organizationName: "Acme Corp",
  url: sharedPreviewUrl("https://ostra.example/", "01a1fe4c-208c-734b-a6d2-f6092da5f5c9"),
  taskTitle: "Add a history panel to the invoices page",
  ticketKey: "OST-212",
  projectName: "billing-web",
} as const;

// The row handed over as it is: the renderer must pick its fields.
const subject: PreviewNoticeSubject = named;

const render = (preview: PreviewNoticeSubject = subject) => renderPreviewNotice({ preview, publicUrl: "https://ostra.example/" });

describe("the preview notice (F-142)", () => {
  it("F-142/c3: names the preview, who shared it and the organization, and opens the preview's own page, in the panel and both parts of the mail", () => {
    const { panel, email } = render();
    expect(named.url).toBe("https://ostra.example/previews/01a1fe4c-208c-734b-a6d2-f6092da5f5c9");
    expect(panel).toEqual({ title: previewNoticeHeading, line: "Alex Kim shared web :5173 with you, to watch.", url: named.url });
    expect(email.subject).toBe(`${previewNoticeHeading} · web :5173`);
    for (const part of [email.text, email.html]) {
      expect(part).toContain("web :5173");
      expect(part).toContain("Alex Kim");
      expect(part).toContain("Acme Corp");
      expect(part).toContain(named.url);
    }
    expect(email.html).toContain(`href="${named.url}"`);
    expect(email.html).toContain("https://ostra.example/email/logo-abyss@2x.png");
  });

  it("F-142/c3: carries nothing of the task: its title, its ticket or its project", () => {
    const rendered = render();
    for (const part of [rendered.panel.title, rendered.panel.line, rendered.panel.url, rendered.email.subject, rendered.email.html, rendered.email.text]) {
      expect(part).not.toContain(named.taskTitle);
      expect(part).not.toContain(named.ticketKey);
      expect(part).not.toContain(named.projectName);
    }
  });

  it("F-142/c3: a label is text, never markup, and a sharer who's gone is a member", () => {
    const { panel, email } = render({ ...subject, label: "<img src=x onerror=alert(1)>", port: null, sharedBy: null });
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(panel.line).toBe("A member shared <img src=x onerror=alert(1)> with you, to watch.");
    expect(email.text).toContain("A member shared");
  });
});
