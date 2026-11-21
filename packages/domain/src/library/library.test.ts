import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { allowed, allowlistEntryFor, allowlistEntryFromRow } from "./allowed.ts";
import type { AllowlistEntry } from "./allowed.ts";
import { checkSkill, skillFrontMatter } from "./check-skill.ts";
import type { CheckedSkillFile } from "./check-skill.ts";
import { SKILL_DIFF_MAX_LINES, serverDiff, skillDiff } from "./diffs.ts";
import type { ServerSnapshot } from "./diffs.ts";
import { computedHash } from "./hash.ts";
import { profileItems } from "./profile-items.ts";
import type { ProfileLibraryItem } from "./profile-items.ts";
import { LIBRARY_SOURCES_WORDS, libraryReferenceSchema, librarySourceKindOf, librarySourceSchema, parseLibraryReference } from "./reference.ts";
import { parseRegistryList, parseSkillsSearch, parseWellKnownIndex, registryEntrySchema, registryStatusOf, WELL_KNOWN_SCHEMA_V2 } from "./vendor.ts";

// Milestone 8 (ticket 06, F-145, F-146): the library's pure rules.

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const file = (path: string, text: string, executable = false): CheckedSkillFile => ({ path, bytes: bytes(text), executable });
const sha = "0123456789abcdef0123456789abcdef01234567";

describe("a library reference", () => {
  it("F-145/c1: reads every GitHub form the skills CLI takes and ostra does: shorthand, a skill, a folder, a tree URL, #ref and a pin", () => {
    const github = (owner: string, repo: string, rest: { path?: string; skill?: string; ref?: { kind: "ref"; name: string } | { kind: "commit"; sha: string } } = {}) => ({
      ok: true,
      value: { kind: "github", owner, repo, path: rest.path ?? null, skill: rest.skill ?? null, ref: rest.ref ?? null },
    });
    const cases: readonly (readonly [string, unknown])[] = [
      ["vercel-labs/agent-skills", github("vercel-labs", "agent-skills")],
      ["vercel-labs/agent-skills@web-design", github("vercel-labs", "agent-skills", { skill: "web-design" })],
      ["vercel-labs/agent-skills/skills/pdf", github("vercel-labs", "agent-skills", { path: "skills/pdf" })],
      ["vercel-labs/agent-skills/skills/pdf/", github("vercel-labs", "agent-skills", { path: "skills/pdf" })],
      ["github:vercel-labs/agent-skills", github("vercel-labs", "agent-skills")],
      ["vercel-labs/agent-skills#v2", github("vercel-labs", "agent-skills", { ref: { kind: "ref", name: "v2" } })],
      ["vercel-labs/agent-skills#main@web-design", github("vercel-labs", "agent-skills", { skill: "web-design", ref: { kind: "ref", name: "main" } })],
      ["vercel-labs/agent-skills@web-design#release/1", github("vercel-labs", "agent-skills", { skill: "web-design", ref: { kind: "ref", name: "release/1" } })],
      ["vercel-labs/agent-skills/skills#feature/x", github("vercel-labs", "agent-skills", { path: "skills", ref: { kind: "ref", name: "feature/x" } })],
      // `@` with a version or a SHA is a pin, as the CLI reads it.
      ["vercel-labs/agent-skills@v1.2.3", github("vercel-labs", "agent-skills", { ref: { kind: "ref", name: "v1.2.3" } })],
      [`vercel-labs/agent-skills@${sha}`, github("vercel-labs", "agent-skills", { ref: { kind: "commit", sha } })],
      [`vercel-labs/agent-skills#${sha}`, github("vercel-labs", "agent-skills", { ref: { kind: "commit", sha } })],
      ["https://github.com/vercel-labs/agent-skills", github("vercel-labs", "agent-skills")],
      ["https://github.com/vercel-labs/agent-skills.git", github("vercel-labs", "agent-skills")],
      ["https://www.github.com/vercel-labs/agent-skills#v2", github("vercel-labs", "agent-skills", { ref: { kind: "ref", name: "v2" } })],
      ["https://github.com/vercel-labs/agent-skills/tree/main/skills/pdf", github("vercel-labs", "agent-skills", { path: "skills/pdf", ref: { kind: "ref", name: "main" } })],
      [`https://github.com/vercel-labs/agent-skills/tree/${sha}`, github("vercel-labs", "agent-skills", { ref: { kind: "commit", sha } })],
      ["https://github.com/vercel-labs/agent-skills/tree/main/skills/pdf#ignored@web-design", github("vercel-labs", "agent-skills", { path: "skills/pdf", skill: "web-design", ref: { kind: "ref", name: "main" } })],
      ["  vercel-labs/agent-skills  ", github("vercel-labs", "agent-skills")],
    ];
    for (const [typed, expected] of cases) {
      expect(parseLibraryReference(typed), typed).toEqual(expected);
    }
  });

  it("F-145/c1: reads a well-known site, its index's own path included, and a registry's server with or without its registry", () => {
    expect(parseLibraryReference("https://skills.acme.dev")).toEqual({ ok: true, value: { kind: "well_known", url: "https://skills.acme.dev", host: "skills.acme.dev" } });
    expect(parseLibraryReference("https://Acme.dev/docs/")).toEqual({ ok: true, value: { kind: "well_known", url: "https://acme.dev/docs", host: "acme.dev" } });
    expect(parseLibraryReference("https://acme.dev/.well-known/agent-skills/index.json")).toEqual({ ok: true, value: { kind: "well_known", url: "https://acme.dev", host: "acme.dev" } });
    expect(parseLibraryReference("https://acme.dev/.well-known/skills/index.json")).toEqual({ ok: true, value: { kind: "well_known", url: "https://acme.dev", host: "acme.dev" } });
    expect(parseLibraryReference("registry:io.github.github/github-mcp-server")).toEqual({
      ok: true,
      value: { kind: "registry", name: "io.github.github/github-mcp-server", registryUrl: null },
    });
    expect(parseLibraryReference("registry:io.github.github/github-mcp-server@https://api.mcp.github.com/")).toEqual({
      ok: true,
      value: { kind: "registry", name: "io.github.github/github-mcp-server", registryUrl: "https://api.mcp.github.com" },
    });
    expect(libraryReferenceSchema.parse("acme/skills@review")).toEqual({ kind: "github", owner: "acme", repo: "skills", path: null, skill: "review", ref: null });
  });

  it("F-145/c1: refuses each form the CLI takes that ostra doesn't, in words that say which sources ostra takes", () => {
    const refusals: readonly (readonly [string, string])[] = [
      ["https://gitlab.com/acme/skills", "GitLab"],
      ["gitlab:acme/skills", "GitLab"],
      ["https://git.acme.dev/team/skills/-/tree/main/pdf", "GitLab"],
      ["./skills/pdf", "a local path"],
      ["../skills", "a local path"],
      ["/home/ada/skills", "a local path"],
      ["C:\\skills", "a local path"],
      ["~/skills", "a local path"],
      ["https://github.com/acme/skills/archive/refs/heads/main.zip", "an archive's or a file's URL"],
      ["https://raw.githubusercontent.com/acme/skills/main/pdf/SKILL.md", "an archive's or a file's URL"],
      ["https://codeload.github.com/acme/skills/tar.gz/main", "an archive's or a file's URL"],
      ["https://acme.dev/skills.tar.gz", "an archive's URL"],
      ["https://acme.dev/pdf.zip", "an archive's URL"],
      ["https://acme.dev/pdf/SKILL.md", "a file's URL"],
      ["git@github.com:acme/skills.git", "a git URL"],
      ["ssh://git@acme.dev/skills.git", "a git URL"],
      ["https://acme.dev/skills.git", "another git host"],
      ["https://dev.azure.com/acme/project/_git/skills", "another git host"],
      ["http://skills.acme.dev", "a site over plain http"],
    ];
    for (const [typed, form] of refusals) {
      const parsed = parseLibraryReference(typed);
      expect(parsed, typed).toEqual({ ok: false, error: `ostra doesn't install from ${form}: ${LIBRARY_SOURCES_WORDS}.` });
    }
    for (const typed of ["", "acme", "acme/", "-acme/skills", "acme/skills@Not_A_Skill", "acme/skills/../x", "acme/skills#bad..ref", "registry:no-slash", "registry:a/b@http://insecure.example", "https://github.com/acme/skills/blob/main/x.md", "https://user:pw@acme.dev", "https://acme.dev/?q=1"]) {
      const parsed = parseLibraryReference(typed);
      expect(parsed.ok, typed).toBe(false);
      expect(!parsed.ok && parsed.error, typed).toContain("ostra installs from a GitHub repo");
    }
    expect(libraryReferenceSchema.safeParse("https://gitlab.com/acme/skills").error?.issues[0]?.message).toContain("GitLab");
  });

  it("F-145/c1: an item's stored source is ostra's own format: strict, each kind with its fields", () => {
    expect(librarySourceSchema.parse({ kind: "github", owner: "acme", repo: "skills", path: "skills/pdf", ref: null })).toEqual({ kind: "github", owner: "acme", repo: "skills", path: "skills/pdf", ref: null });
    expect(librarySourceSchema.parse({ kind: "registry", registryUrl: "https://api.mcp.github.com", name: "io.github.github/github-mcp-server" }).kind).toBe("registry");
    expect(librarySourceSchema.safeParse({ kind: "github", owner: "acme", repo: "skills", path: "", ref: "main", extra: true }).success).toBe(false);
    expect(librarySourceSchema.safeParse({ kind: "github", owner: "acme", repo: "skills", path: "../x", ref: null }).success).toBe(false);
    expect(librarySourceSchema.safeParse({ kind: "well_known", url: "http://acme.dev", skill: "pdf" }).success).toBe(false);
    expect(librarySourceKindOf({ kind: "well_known", url: "https://acme.dev", skill: "pdf" })).toBe("well_known");
  });
});

describe("the computed hash", () => {
  it("F-145/c2: matches the skills CLI's README vectors, written out in full", () => {
    // The README's "Lock File Content Hash" vectors (vercel-labs/skills, main, 2026-11-21).
    expect(computedHash([])).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(computedHash([{ path: "SKILL.md", bytes: bytes("# hi\n") }])).toBe("93c36952d8843b33e68ae970ebabcc03e1687c9bb0dd1ecaf357060318952f55");
    expect(computedHash([{ path: "docs/b.md", bytes: bytes("b\n") }, { path: "SKILL.md", bytes: bytes("a\n") }])).toBe("b22c4d22aa319d2924312fa18fcbfedc88fa89c74dbd8f298c683e1caf7b7f24");
  });

  it("F-145/c2: sorts by the paths' UTF-8 bytes, turns CRLF into LF only in text, and leaves out what the installer does", () => {
    const framed = (entries: readonly (readonly [string, string])[]): string => {
      const hash = createHash("sha256");
      for (const [path, content] of entries) hash.update(`${path}\0${String(Buffer.byteLength(content))}\0${content}`);
      return hash.digest("hex");
    };
    // U+FF21 (EF BC A1 in UTF-8) sorts after U+1F600 (F0 9F 98 80) by UTF-16 code units, and before it by UTF-8 bytes.
    const files = [{ path: "\u{1F600}.md", bytes: bytes("x") }, { path: "\uFF21.md", bytes: bytes("y") }];
    expect(computedHash(files)).toBe(framed([["\uFF21.md", "y"], ["\u{1F600}.md", "x"]]));
    expect(computedHash([{ path: "SKILL.md", bytes: bytes("a\r\nb\rc\r\n") }])).toBe(framed([["SKILL.md", "a\nb\rc\n"]]));
    const binary = new Uint8Array([0x00, 0x0d, 0x0a]);
    const binaryHash = createHash("sha256").update("x.bin\x003\x00").update(binary).digest("hex");
    expect(computedHash([{ path: "x.bin", bytes: binary }])).toBe(binaryHash);
    const base = [{ path: "SKILL.md", bytes: bytes("# hi\n") }];
    expect(
      computedHash([
        ...base,
        { path: "metadata.json", bytes: bytes("{}") },
        { path: "docs/metadata.json", bytes: bytes("{}") },
        { path: ".git/HEAD", bytes: bytes("ref") },
        { path: "scripts/__pycache__/a.pyc", bytes: bytes("x") },
        { path: "lib/__pypackages__/a.py", bytes: bytes("x") },
      ]),
    ).toBe(computedHash(base));
  });
});

describe("checking a skill", () => {
  const skillMd = (front: string): CheckedSkillFile => file("SKILL.md", `---\n${front}\n---\n# Body\n`);

  it("F-145/c3: takes a skill that keeps the spec's rules and ostra's limits, and points out what looks like a script", () => {
    const checked = checkSkill({
      folder: "pdf",
      files: [
        skillMd("name: pdf\ndescription: >\n  Reads and fills\n  PDF forms."),
        file("scripts/extract.py", "print(1)\n"),
        file("tool.sh", "#!/bin/sh\necho hi\n"),
        file("bin/run", "binary-ish", true),
        file("reference.md", "# Ref\n"),
        file("metadata.json", "{}"),
      ],
    });
    expect(checked).toEqual({
      ok: true,
      name: "pdf",
      description: "Reads and fills PDF forms.",
      scripts: [
        { path: "scripts/extract.py", reasons: ["scripts-folder"] },
        { path: "tool.sh", reasons: ["shebang"] },
        { path: "bin/run", reasons: ["executable"] },
      ],
    });
  });

  it("F-145/c3: reads the front matter's plain, quoted and block forms", () => {
    expect(skillFrontMatter("---\nname: 'pdf'\ndescription: \"Fills \\\"forms\\\"\"\n---\n")).toEqual({ name: "pdf", description: 'Fills "forms"' });
    expect(skillFrontMatter("---\nname: pdf # the folder\ndescription: |\n  Line one\n  Line two\nlicense: MIT\n---\n")).toEqual({ name: "pdf", description: "Line one\nLine two" });
    expect(skillFrontMatter("---\nname: pdf\ndescription: Starts here\n  and goes on\nmetadata:\n  name: other\n---\n")).toEqual({ name: "pdf", description: "Starts here and goes on" });
    expect(skillFrontMatter("# No front matter\n")).toBeNull();
  });

  it("F-145/c3: refuses each break of the spec and of ostra's limits, every one listed with its words", () => {
    const codes = (input: Parameters<typeof checkSkill>[0]): string[] => {
      const checked = checkSkill(input);
      return checked.ok ? [] : checked.problems.map((problem) => problem.code);
    };
    expect(codes({ folder: "pdf", files: [file("README.md", "x")] })).toEqual(["no-skill-md"]);
    expect(codes({ folder: "pdf", files: [skillMd("name: pdf\ndescription: d"), file("inner/SKILL.md", "x")] })).toEqual(["skill-md-twice"]);
    expect(codes({ folder: "pdf", files: [file("SKILL.md", "# no front matter")] })).toEqual(["no-front-matter"]);
    expect(codes({ folder: "pdf", files: [skillMd("description: d")] })).toEqual(["name-missing"]);
    expect(codes({ folder: "PDF", files: [skillMd("name: PDF\ndescription: d")] })).toEqual(["name-invalid"]);
    expect(codes({ folder: "a--b", files: [skillMd("name: a--b\ndescription: d")] })).toEqual(["name-invalid"]);
    expect(codes({ folder: "x".repeat(65), files: [skillMd(`name: ${"x".repeat(65)}\ndescription: d`)] })).toEqual(["name-invalid"]);
    expect(codes({ folder: "pdf-tools", files: [skillMd("name: pdf\ndescription: d")] })).toEqual(["name-not-folder"]);
    expect(codes({ folder: "pdf", files: [skillMd("name: pdf")] })).toEqual(["description-missing"]);
    expect(codes({ folder: "pdf", files: [skillMd(`name: pdf\ndescription: ${"d".repeat(1025)}`)] })).toEqual(["description-too-long"]);
    expect(codes({ folder: "pdf", files: [skillMd(`name: pdf\ndescription: ${"d".repeat(1024)}`)] })).toEqual([]);
    const many = Array.from({ length: 21 }, (_, index) => file(`ref/${String(index)}.md`, "x"));
    expect(codes({ folder: "pdf", files: [skillMd("name: pdf\ndescription: d"), ...many] })).toEqual(["too-many-files"]);
    expect(codes({ folder: "pdf", files: [skillMd("name: pdf\ndescription: d"), ...many.slice(1)] })).toEqual([]);
    const big: CheckedSkillFile = { path: "assets/big.bin", bytes: new Uint8Array(1024 * 1024 + 1), executable: false };
    expect(codes({ folder: "pdf", files: [skillMd("name: pdf\ndescription: d"), big] })).toEqual(["file-too-large"]);
    expect(codes({ folder: "pdf", files: [skillMd("name: pdf\ndescription: d"), file("../outside.md", "x"), file("/abs.md", "x")] })).toEqual(["path-outside", "path-outside"]);
    // Every problem at once, each with its words.
    const all = checkSkill({ folder: "other", files: [skillMd("name: pdf"), big] });
    expect(all.ok).toBe(false);
    expect(!all.ok && all.problems.map((problem) => problem.message)).toEqual([
      "assets/big.bin is over 1 MiB, the most a skill's file holds",
      "The skill is named pdf, and its folder other: the two must match",
      "SKILL.md's front matter has no description",
    ]);
  });
});

describe("the allowlist", () => {
  const list: AllowlistEntry[] = [
    { kind: "github_owner", value: "acme" },
    { kind: "github_repo", value: "vercel-labs/agent-skills" },
    { kind: "well_known_host", value: "skills.acme.dev" },
    { kind: "registry", value: "https://api.mcp.github.com", namespace: "io.github.github/*" },
    { kind: "registry", value: "https://registry.acme.dev/", namespace: null },
  ];

  it("F-145/c6: allows by owner, repo, host and registry with its namespace, each by its entry", () => {
    expect(allowed({ kind: "github", owner: "acme", repo: "anything" }, list)).toEqual({ allowed: true, entry: list[0] });
    expect(allowed({ kind: "github", owner: "ACME", repo: "Anything" }, list)).toEqual({ allowed: true, entry: list[0] });
    expect(allowed({ kind: "github", owner: "vercel-labs", repo: "agent-skills" }, list)).toEqual({ allowed: true, entry: list[1] });
    expect(allowed({ kind: "well_known", url: "https://skills.acme.dev/team" }, list)).toEqual({ allowed: true, entry: list[2] });
    expect(allowed({ kind: "registry", registryUrl: "https://api.mcp.github.com/", name: "io.github.github/github-mcp-server" }, list)).toEqual({ allowed: true, entry: list[3] });
    expect(allowed({ kind: "registry", registryUrl: "https://registry.acme.dev", name: "dev.acme/tools" }, list)).toEqual({ allowed: true, entry: list[4] });
  });

  it("F-145/c6: refuses every near miss: an owner with the same prefix, another repo of a listed repo's owner, a subdomain, a namespace's sibling", () => {
    expect(allowed({ kind: "github", owner: "acme-tools", repo: "skills" }, list).allowed).toBe(false);
    expect(allowed({ kind: "github", owner: "acm", repo: "skills" }, list).allowed).toBe(false);
    expect(allowed({ kind: "github", owner: "vercel-labs", repo: "agent-skills-fork" }, list).allowed).toBe(false);
    expect(allowed({ kind: "github", owner: "vercel-labs", repo: "other" }, list).allowed).toBe(false);
    expect(allowed({ kind: "well_known", url: "https://evil.skills.acme.dev" }, list).allowed).toBe(false);
    expect(allowed({ kind: "well_known", url: "https://acme.dev" }, list).allowed).toBe(false);
    expect(allowed({ kind: "well_known", url: "https://skills.acme.dev.evil.example" }, list).allowed).toBe(false);
    expect(allowed({ kind: "registry", registryUrl: "https://api.mcp.github.com", name: "io.github.githubx/github-mcp-server" }, list).allowed).toBe(false);
    expect(allowed({ kind: "registry", registryUrl: "https://api.mcp.github.com", name: "io.github/github-mcp-server" }, list).allowed).toBe(false);
    expect(allowed({ kind: "registry", registryUrl: "https://api.mcp.github.com.evil.example", name: "io.github.github/github-mcp-server" }, list).allowed).toBe(false);
  });

  it("F-145/c6: a name that matches never allows a source that doesn't: the allowlist is by source", () => {
    // The same server's name, from a registry that isn't listed.
    expect(allowed({ kind: "registry", registryUrl: "https://registry.evil.example", name: "io.github.github/github-mcp-server" }, list).allowed).toBe(false);
    // The same repo's name under another owner.
    expect(allowed({ kind: "github", owner: "evil", repo: "agent-skills" }, list).allowed).toBe(false);
    // A GitHub owner's name as a host, and a host's name as an owner.
    expect(allowed({ kind: "well_known", url: "https://acme" }, list).allowed).toBe(false);
    expect(allowed({ kind: "github", owner: "skills-acme-dev", repo: "x" }, [{ kind: "well_known_host", value: "skills-acme-dev" }]).allowed).toBe(false);
  });

  it("F-145/c6: reads the list from its rows, a registry's namespace kept", () => {
    expect(allowlistEntryFromRow({ kind: "github_owner", value: "acme", namespace: null })).toEqual({ kind: "github_owner", value: "acme" });
    expect(allowlistEntryFromRow({ kind: "registry", value: "https://api.mcp.github.com", namespace: "io.github.github" })).toEqual({ kind: "registry", value: "https://api.mcp.github.com", namespace: "io.github.github" });
    expect(allowed({ kind: "registry", registryUrl: "https://api.mcp.github.com", name: "io.github.github/x" }, [allowlistEntryFromRow({ kind: "registry", value: "https://api.mcp.github.com", namespace: "io.github.github" })]).allowed).toBe(true);
  });

  it("F-145/c6: the entry an admin adds for a source not on the list allows exactly it", () => {
    for (const subject of [
      { kind: "github", owner: "zed", repo: "skills" },
      { kind: "well_known", url: "https://docs.zed.dev/skills" },
      { kind: "registry", registryUrl: "https://registry.zed.dev", name: "dev.zed/editor" },
    ] as const) {
      const entry = allowlistEntryFor(subject);
      expect(allowed(subject, [entry]).allowed).toBe(true);
    }
    expect(allowed({ kind: "github", owner: "zed", repo: "other" }, [allowlistEntryFor({ kind: "github", owner: "zed", repo: "skills" })]).allowed).toBe(false);
  });
});

describe("a profile's items", () => {
  const item = (kind: "skill" | "mcp_server", name: string, itemId = `${kind}-${name}`): ProfileLibraryItem<number> => ({ itemId, kind, name, pinned: 1 });
  const profile = (skills: number, servers: number) => ({
    name: "Backend",
    skills: Array.from({ length: skills }, (_, index) => ({ name: `own-${String(index)}` })),
    servers: Array.from({ length: servers }, (_, index) => ({ name: `own-server-${String(index)}` })),
  });

  it("F-145/c7: lists own, attached and every-profile items at their pins, an item on both lists once", () => {
    const listed = profileItems(profile(1, 1), [item("skill", "pdf"), item("mcp_server", "github")], [item("skill", "pdf"), item("skill", "style")]);
    expect(listed).toEqual({
      ok: true,
      skills: [
        { kind: "skill", name: "own-0", source: "own" },
        { kind: "skill", name: "pdf", source: "attached", itemId: "skill-pdf", pinned: 1 },
        { kind: "skill", name: "style", source: "every_profile", itemId: "skill-style", pinned: 1 },
      ],
      servers: [
        { kind: "mcp_server", name: "own-server-0", source: "own" },
        { kind: "mcp_server", name: "github", source: "attached", itemId: "mcp_server-github", pinned: 1 },
      ],
    });
  });

  it("F-145/c7: takes the 50th skill and the 20th server, and refuses the 51st and the 21st, naming the profile", () => {
    expect(profileItems(profile(49, 19), [item("skill", "pdf"), item("mcp_server", "github")], []).ok).toBe(true);
    expect(profileItems(profile(49, 0), [item("skill", "pdf")], [item("skill", "style")])).toEqual({
      ok: false,
      refusal: { code: "too-many-skills", itemId: "skill-style", message: "The profile Backend would have more than 50 skills, the most a profile hands a task" },
    });
    expect(profileItems(profile(0, 20), [], [item("mcp_server", "github")])).toEqual({
      ok: false,
      refusal: { code: "too-many-servers", itemId: "mcp_server-github", message: "The profile Backend would have more than 20 MCP servers, the most a profile hands a task" },
    });
  });

  it("F-145/c8: refuses a library item whose name the profile already uses, naming the profile; a skill and a server may share one", () => {
    expect(profileItems(profile(1, 0), [item("skill", "own-0")], [])).toEqual({
      ok: false,
      refusal: { code: "name-taken", itemId: "skill-own-0", message: "The profile Backend already has its own skill named own-0" },
    });
    expect(profileItems(profile(0, 1), [], [item("mcp_server", "own-server-0")])).toMatchObject({ ok: false, refusal: { code: "name-taken", message: "The profile Backend already has its own MCP server named own-server-0" } });
    expect(profileItems(profile(1, 0), [item("mcp_server", "own-0")], []).ok).toBe(true);
  });
});

describe("an update's diff", () => {
  const files = (entries: Readonly<Record<string, string>>) => Object.entries(entries).map(([path, text]) => ({ path, bytes: bytes(text) }));

  it("F-145/c10: lists a skill's files added, removed and changed, each text file's lines with three of context", () => {
    const before = files({ "SKILL.md": "a\nb\nc\nd\ne\nf\ng\nh\n", "old.md": "gone\n", "same.md": "same\n" });
    const after = files({ "SKILL.md": "a\nb\nc\nd\nE\nf\ng\nh\n", "new.md": "fresh\n", "same.md": "same\r\n" });
    const diff = skillDiff(before, after);
    expect(diff.truncated).toBe(false);
    expect(diff.files.map((change) => [change.path, change.change])).toEqual([
      ["SKILL.md", "changed"],
      ["new.md", "added"],
      ["old.md", "removed"],
    ]);
    expect(diff.files[0]?.lines).toEqual([
      { kind: "context", oldLine: 2, newLine: 2, text: "b" },
      { kind: "context", oldLine: 3, newLine: 3, text: "c" },
      { kind: "context", oldLine: 4, newLine: 4, text: "d" },
      { kind: "del", oldLine: 5, newLine: null, text: "e" },
      { kind: "add", oldLine: null, newLine: 5, text: "E" },
      { kind: "context", oldLine: 6, newLine: 6, text: "f" },
      { kind: "context", oldLine: 7, newLine: 7, text: "g" },
      { kind: "context", oldLine: 8, newLine: 8, text: "h" },
    ]);
    expect(diff.files[1]?.lines).toEqual([{ kind: "add", oldLine: null, newLine: 1, text: "fresh" }]);
    expect(diff.files[2]?.lines).toEqual([{ kind: "del", oldLine: 1, newLine: null, text: "gone" }]);
    // A binary file is listed, never diffed by line; files that didn't change aren't listed.
    expect(skillDiff([{ path: "a.bin", bytes: new Uint8Array([0, 1]) }], [{ path: "a.bin", bytes: new Uint8Array([0, 2]) }]).files).toEqual([
      { path: "a.bin", change: "changed", binary: true, lines: [], truncated: false },
    ]);
    expect(skillDiff(before, before)).toEqual({ files: [], truncated: false });
  });

  it("F-145/c10: caps a skill's diff at 2,000 lines in all, and a file past the cap says so", () => {
    const long = (prefix: string, length: number) => Array.from({ length }, (_, index) => `${prefix}${String(index)}`).join("\n");
    const diff = skillDiff(files({ "a.md": long("a", 1500), "b.md": "same\n" }), files({ "a.md": long("A", 1500), "b.md": "same\n", "c.md": long("c", 2500), "d.md": "late\n" }));
    expect(diff.truncated).toBe(true);
    expect(diff.files.map((change) => [change.path, change.change, change.lines.length, change.truncated])).toEqual([
      // 3,000 edits, more than the cap: none of them shown.
      ["a.md", "changed", 0, true],
      // An added file's lines up to the cap, and nothing after it.
      ["c.md", "added", SKILL_DIFF_MAX_LINES, true],
      ["d.md", "added", 0, true],
    ]);
  });

  it("F-145/c10: names a server's changed fields: its version, its remote's URL, the headers it asks for, its description and its tools", () => {
    const before: ServerSnapshot = {
      version: "2.2.0",
      description: "GitHub's server",
      remoteUrl: "https://api.githubcopilot.com/mcp/",
      headers: [{ name: "Authorization", isSecret: true }, { name: "X-Org", isSecret: false }],
      toolNames: ["create_issue", "get_file"],
    };
    expect(serverDiff(before, before).changed).toBe(false);
    const after: ServerSnapshot = {
      version: "2.3.0",
      description: "GitHub's MCP server",
      remoteUrl: "https://api.githubcopilot.com/mcp/v2",
      headers: [{ name: "authorization", isSecret: false }, { name: "X-Team", isSecret: false }],
      toolNames: ["get_file", "delete_repo"],
    };
    expect(serverDiff(before, after)).toEqual({
      version: { from: "2.2.0", to: "2.3.0" },
      description: { from: "GitHub's server", to: "GitHub's MCP server" },
      remoteUrl: { from: "https://api.githubcopilot.com/mcp/", to: "https://api.githubcopilot.com/mcp/v2" },
      headers: { added: ["X-Team"], removed: ["X-Org"], secretChanged: [{ name: "authorization", isSecret: false }] },
      tools: { added: ["delete_repo"], removed: ["create_issue"] },
      changed: true,
    });
    expect(serverDiff(before, { ...before, toolNames: ["get_file", "create_issue"] }).changed).toBe(false);
  });
});

describe("the formats a vendor owns", () => {
  it("F-146/c2,c5: a skills.sh search with unknown fields reads, and a result missing its source is dropped and counted", () => {
    const search = parseSkillsSearch({
      searchType: "fuzzy",
      somethingNew: { nested: true },
      skills: [
        { id: "mattpocock/skills/code-review", source: "mattpocock/skills", skillId: "code-review", name: "code-review", installs: 915_365, badge: "new" },
        { id: "vercel-labs/agent-skills/web-design", source: "vercel-labs/agent-skills", name: "web-design", installs: 12 },
        { id: "orphan", name: "no-source", installs: 3 },
        { source: "", name: "empty-source" },
        { source: "acme/skills", name: "Not A Skill Name" },
        "not an object",
      ],
    });
    expect(search).toEqual({
      results: [
        { source: "mattpocock/skills", skillId: "code-review", name: "code-review", installs: 915_365, reference: "mattpocock/skills@code-review" },
        { source: "vercel-labs/agent-skills", skillId: "web-design", name: "web-design", installs: 12, reference: "vercel-labs/agent-skills@web-design" },
      ],
      dropped: 4,
    });
    for (const result of search?.results ?? []) {
      expect(parseLibraryReference(result.reference).ok).toBe(true);
    }
    // An answer that isn't a search's at all is unavailable, never an empty search.
    expect(parseSkillsSearch({ error: "rate limited" })).toBeNull();
    expect(parseSkillsSearch("<html>")).toBeNull();
  });

  it("F-145/c4: reads a registry's server.json subset, its official status, and a list that keeps its good entries", () => {
    const entry = {
      server: {
        $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
        name: "io.github.github/github-mcp-server",
        version: "2.2.0",
        description: "GitHub's official MCP server",
        repository: { url: "https://github.com/github/github-mcp-server", source: "github" },
        packages: [{ registryType: "oci", identifier: "ghcr.io/github/github-mcp-server:2.2.0", transport: { type: "stdio" } }],
        remotes: [{ type: "streamable-http", url: "https://api.githubcopilot.com/mcp/", headers: [{ name: "Authorization", isSecret: true, isRequired: true }] }],
      },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true, publishedAt: "2026-11-01T00:00:00Z", serverId: "x" } },
    };
    const parsed = registryEntrySchema.parse(entry);
    expect(parsed.server.remotes?.[0]?.headers?.[0]).toMatchObject({ name: "Authorization", isSecret: true });
    expect(parsed.server.packages?.[0]?.registryType).toBe("oci");
    expect(registryStatusOf(parsed)).toBe("active");
    expect(registryStatusOf(registryEntrySchema.parse({ ...entry, _meta: { "io.modelcontextprotocol.registry/official": { status: "deprecated", isLatest: true } } }))).toBe("deprecated");
    expect(registryStatusOf(registryEntrySchema.parse({ server: entry.server }))).toBe("unknown");
    expect(parseRegistryList({ servers: [entry, { server: { name: "no-slash", version: "1" } }], metadata: { nextCursor: "abc", count: 2 } })).toEqual({ entries: [parsed], dropped: 1, nextCursor: "abc" });
    expect(parseRegistryList({ items: [] })).toBeNull();
  });

  it("F-145/c1: reads a well-known index v0.2.0 with its digests, skips an entry that doesn't read, and refuses another schema", () => {
    const good = { name: "pdf", type: "skill-md", description: "Fills PDF forms", url: "pdf/SKILL.md", digest: `sha256:${"a".repeat(64)}`, extra: 1 };
    expect(parseWellKnownIndex({ $schema: WELL_KNOWN_SCHEMA_V2, skills: [good, { ...good, name: "bad", digest: "md5:x" }, { ...good, name: "-bad" }], future: true })).toEqual({ entries: [good], dropped: 2 });
    // The legacy index has no digest: ostra doesn't install from it.
    expect(parseWellKnownIndex({ skills: [{ name: "pdf", description: "x", files: ["SKILL.md"] }] })).toBeNull();
    expect(parseWellKnownIndex({ $schema: "https://schemas.agentskills.io/discovery/0.3.0/schema.json", skills: [good] })).toBeNull();
    expect(parseWellKnownIndex({ $schema: WELL_KNOWN_SCHEMA_V2, skills: [{ ...good, digest: "sha256:short" }] })).toBeNull();
  });
});
