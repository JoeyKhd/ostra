import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const issuesDir = path.join(root, "context", "specs", "m5-the-fleet", "issues");
const targetsDir = path.join(root, "context", "brand", "app-targets", "m5");

const closedStatuses = ["done", "resolved"] as const;

/** The ticket's `Status:` line's value, or `undefined` when it has none. */
const ticketStatus = (text: string): string | undefined => /^Status:\s*(\S+)/mu.exec(text)?.[1];

/** The unticked boxes under the ticket's `## Done when` heading, as written. */
const untickedDoneWhen = (text: string): string[] => {
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^## Done when\s*$/u.test(line));
  if (start === -1) {
    return [];
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const section = end === -1 ? rest : rest.slice(0, end);
  return section.filter((line) => /^\s*- \[ \]/u.test(line)).map((line) => line.trim());
};

/**
 * A box that only the launch gate's one Proof run can tick, and says so with its dated note, may
 * stay unticked in a closed ticket (the maintainer, 2026-11-21: the Proof workflow runs only then).
 */
const waitsForTheGate = (box: string): boolean => /waits for the launch-gate proof run/iu.test(box);

describe("milestone 5 tickets", () => {
  it("reads the status and the unticked boxes of a ticket", () => {
    const ticket = [
      "# 99: A ticket",
      "",
      "Status: resolved",
      "",
      "## Done when",
      "",
      "- [x] One.",
      "- [ ] Two.",
      "- [ ] Three. *Waits for the launch-gate Proof run (the maintainer, 2026-11-21).*",
      "",
      "## Comments",
      "",
      "- [ ] not a done-when box",
    ].join("\n");
    expect(ticketStatus(ticket)).toBe("resolved");
    const unticked = untickedDoneWhen(ticket);
    expect(unticked).toHaveLength(2);
    expect(unticked.filter((box) => !waitsForTheGate(box))).toEqual(["- [ ] Two."]);
  });

  it("leaves no done or resolved ticket with an unticked done-when box, but for the gate's", async () => {
    const names = (await readdir(issuesDir)).filter((name) => name.endsWith(".md"));
    expect(names.length).toBeGreaterThan(0);
    const open: string[] = [];
    for (const name of names) {
      const text = await readFile(path.join(issuesDir, name), "utf8");
      const status = ticketStatus(text);
      if (closedStatuses.some((closed) => closed === status)) {
        for (const box of untickedDoneWhen(text).filter((unticked) => !waitsForTheGate(unticked))) {
          open.push(`${name} (${status ?? ""}): ${box}`);
        }
      }
    }
    expect(open).toEqual([]);
  });

  it("has ticket 29's eight screen targets, three files each, and the README", async () => {
    const screens = [
      "pool",
      "pool-new",
      "pool-join",
      "runner",
      "runner-approval",
      "box-sizes",
      "project-runners",
      "registry",
    ] as const;
    const expected = [
      "README.md",
      ...screens.flatMap((screen) => [`${screen}.webp`, `${screen}.md`, `${screen}.prompt.txt`]),
    ];
    const missing: string[] = [];
    for (const file of expected) {
      const info = await stat(path.join(targetsDir, file)).catch(() => undefined);
      if (info === undefined || !info.isFile() || info.size === 0) {
        missing.push(file);
      }
    }
    expect(missing).toEqual([]);
  });
});
