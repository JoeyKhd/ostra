import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { repoIdSchema } from "@ostra/protocol";

import { t } from "@/lib/messages";

import { ComposerRepoNotes } from "./repo-check-line";
import { BlockedNotice, RepoBlock, RepoProperties, ReposLede } from "./repo-checks";
import { checkLines, oldestCheck, repoVerdict, selectedRepo } from "./repo-checks-words";
import type { RepoDetail } from "./repo-checks-words";

// F-060, F-055: each combination of the two branch checks (repo-checks.md).

/** React escapes an apostrophe in text. */
const esc = (text: string): string => text.replaceAll("'", "&#x27;");

const now = Date.UTC(2026, 10, 19, 12);
const yes = { result: true } as const;
const no = { result: false } as const;
const unknown = (reason: string) => ({ result: "unknown", reason }) as const;

const repo = (n: number, protectedCheck: RepoDetail["defaultBranchProtected"], signed: RepoDetail["signedCommitsRequired"]): RepoDetail => ({
  repoId: repoIdSchema.parse(`01900000-0000-7000-8000-0000000000${String(n).padStart(2, "0")}`),
  fullName: `acme/repo-${String(n)}`,
  defaultBranch: "main",
  private: n % 2 === 0,
  checkedAt: now - 2 * 60_000,
  defaultBranchProtected: protectedCheck,
  signedCommitsRequired: signed,
  installation: { accountLogin: "acme", accountKind: "organization", state: "linked" },
});

const ready = repo(1, yes, no);
const warning = repo(2, no, no);
const unsupported = repo(3, yes, yes);
const forbidden = unknown("GitHub refused the read (403). ostra checks again when a task starts.");
const unchecked = repo(4, forbidden, forbidden);

const block = (detail: RepoDetail) => renderToStaticMarkup(<RepoBlock repo={detail} selected={false} onSelect={() => undefined} />);

describe("a repo's verdict", () => {
  it("is the worst of its two checks", () => {
    expect(repoVerdict(ready)).toBe("ready");
    expect(repoVerdict(warning)).toBe("warning");
    expect(repoVerdict(unsupported)).toBe("unsupported");
    expect(repoVerdict(repo(5, no, yes))).toBe("unsupported");
    expect(repoVerdict(unchecked)).toBe("unknown");
    expect(repoVerdict(repo(6, unknown("x"), no))).toBe("unknown");
    expect(repoVerdict(repo(7, no, unknown("x")))).toBe("warning");
  });

  it("selects the URL's repo, else the worst one, else the first", () => {
    const repos = [ready, unchecked, warning, unsupported];
    expect(selectedRepo(repos, warning.repoId)?.repoId).toBe(warning.repoId);
    expect(selectedRepo(repos, null)?.repoId).toBe(unsupported.repoId);
    expect(selectedRepo([ready, unchecked], null)?.repoId).toBe(unchecked.repoId);
    expect(selectedRepo([], null)).toBeUndefined();
  });

  it("collapses two unknowns with one reason into one line", () => {
    expect(checkLines(unchecked)).toEqual([{ kind: "unknown", reason: forbidden.reason }]);
    expect(checkLines(repo(8, unknown("a"), unknown("b"))).map((line) => line.kind)).toEqual(["protectedUnknown", "signedUnknown"]);
  });

  it("ages from the oldest check, and none when one was never read", () => {
    expect(oldestCheck([ready, { ...warning, checkedAt: now - 9 * 60_000 }])).toBe(now - 9 * 60_000);
    expect(oldestCheck([ready, { ...warning, checkedAt: null }])).toBeNull();
  });
});

describe("the repo blocks", () => {
  it("F-060: ready: two green lines and Ready", () => {
    const html = block(ready);
    expect(html).toContain(t("repos.verdict.ready"));
    expect(html).toContain(t("repos.check.protected"));
    expect(html).toContain(t("repos.check.signedNotRequired"));
    expect(html).toContain("text-green");
  });

  it("F-060: not protected: a warning that says why it's allowed, no red, no amber", () => {
    const html = block(warning);
    expect(html).toContain(t("repos.verdict.warning"));
    expect(html).toContain(t("repos.check.notProtected"));
    expect(html).toContain("ostra pushes only the task");
    expect(html).not.toContain("text-red");
    expect(html).not.toContain("amber");
    expect(html).toContain(`aria-label="${t("repos.private")}"`);
  });

  it("F-055: signed commits: Not supported, in red", () => {
    const html = block(unsupported);
    expect(html).toContain(t("repos.verdict.unsupported"));
    expect(html).toContain(t("repos.check.notSupportedYet"));
    expect(html).toContain("text-red");
  });

  it("couldn't check: the reason, never Ready", () => {
    const html = block(unchecked);
    expect(html).toContain(esc(t("repos.check.unknown")));
    expect(html).toContain("GitHub refused the read (403)");
    expect(html).not.toContain(`>${esc(t("repos.verdict.ready"))}<`);
  });
});

describe("the blocking notice", () => {
  it("F-055: shows only while a repo requires signed commits", () => {
    expect(renderToStaticMarkup(<BlockedNotice repos={[ready, warning]} />)).toBe("");
    const one = renderToStaticMarkup(<BlockedNotice repos={[ready, unsupported]} />);
    expect(one).toContain('role="alert"');
    expect(one).toContain(esc(t("repos.blocked.title")));
    expect(one).toContain("acme/repo-3");
    expect(renderToStaticMarkup(<BlockedNotice repos={[unsupported, repo(9, no, yes)]} />)).toContain("2 repos require signed commits");
  });
});

describe("the lede", () => {
  it("names the account, the count and the age", () => {
    const html = renderToStaticMarkup(<ReposLede repos={[ready, warning]} now={now} />);
    expect(html).toContain("acme");
    expect(html).toContain("2 repos");
    expect(html).toContain("checked 2 min ago");
  });
});

describe("the panel", () => {
  it("why an unprotected branch is allowed, and how to protect it", () => {
    const html = renderToStaticMarkup(<RepoProperties repo={warning} now={now} />);
    expect(html).toContain(esc(t("repos.panel.whyAllowed")));
    expect(html).toContain("https://github.com/acme/repo-2/settings/rules");
    expect(html).toContain(esc(t("repos.panel.protectStep1")));
  });

  it("why signed commits block, and what to change", () => {
    const html = renderToStaticMarkup(<RepoProperties repo={unsupported} now={now} />);
    expect(html).toContain(esc(t("repos.panel.whyBlocked")));
    expect(html).toContain(t("repos.panel.required"));
    expect(html).toContain(t("repos.panel.toStart"));
  });

  it("couldn't check: the reason in full, and that a task isn't refused for it", () => {
    const html = renderToStaticMarkup(<RepoProperties repo={unchecked} now={now} />);
    expect(html).toContain(esc(t("repos.panel.whyUnknown")));
    expect(html).toContain("GitHub refused the read (403)");
    expect(html).toContain("A task isn&#x27;t refused");
  });

  it("ready: no explanation group", () => {
    expect(renderToStaticMarkup(<RepoProperties repo={ready} now={now} />)).not.toContain(esc(t("repos.panel.whyAllowed")));
  });
});

describe("where a task starts", () => {
  it("F-055: a signed-commit repo blocks Start, with the line Start points at", () => {
    const html = renderToStaticMarkup(<ComposerRepoNotes projectId="p1" repos={[unsupported]} />);
    expect(html).toContain('id="repo-block-p1"');
    expect(html).toContain("acme/repo-3");
    expect(html).toContain(t("repos.composer.seeRepos"));
  });

  it("F-060: an unprotected branch warns, and links to why", () => {
    const html = renderToStaticMarkup(<ComposerRepoNotes projectId="p1" repos={[warning]} />);
    expect(html).toContain("default branch isn&#x27;t protected");
    expect(html).toContain(`/projects/p1/repos?repo=${warning.repoId}`);
  });

  it("a check ostra couldn't make says nothing there, and ready repos neither", () => {
    expect(renderToStaticMarkup(<ComposerRepoNotes projectId="p1" repos={[ready, unchecked]} />)).toBe("");
  });
});
