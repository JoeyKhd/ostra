import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

// F-002 (Q118): an invitation's link is a bearer secret. The docs page an admin reads tells them to
// send it privately, and what email adds; the panel's invite sheet says the same. Read from the
// files a reader sees, so an edit that drops the warning fails here.

const repoRoot = path.resolve(import.meta.dirname, "..");

/** The paragraph of a Markdown file that starts with this bold lead. */
const paragraphLed = (markdown: string, lead: string): string => {
  const paragraph = markdown.split(/\r?\n\r?\n/).find((candidate) => candidate.startsWith(lead));
  if (paragraph === undefined) throw new Error(`no paragraph starts with ${lead}`);
  return paragraph;
};

const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, "utf8"));

describe("the members docs page", () => {
  it("F-002: the docs say to send an invitation's link privately, and that with email set up the address must match and be verified", async () => {
    const docs = path.join(repoRoot, "apps", "docs", "content", "using-ostra");
    const page = await readFile(path.join(docs, "members.mdx"), "utf8");

    const bearer = paragraphLed(page, "**The link is a bearer secret.**");
    expect(bearer).toContain("send it privately");
    expect(bearer).toContain("Without email set up, nothing proves");

    const mail = paragraphLed(page, "**With email set up,**");
    expect(mail).toContain("must then sign up with that same address");
    expect(mail).toContain("verification mail");
    expect(mail).toContain("A pasted link alone never activates it.");

    // The page is in the docs' navigation, so a reader finds it.
    const meta = await readJson(path.join(docs, "meta.json"));
    expect(z.object({ pages: z.array(z.string()) }).parse(meta).pages).toContain("members");

    // The panel's invite sheet says the same where the link is shown.
    const messages = await readJson(path.join(repoRoot, "apps", "web", "messages", "en.json"));
    expect(JSON.stringify(messages)).toContain("Send it privately: anyone with this link can join as this person.");
  });
});
