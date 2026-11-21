import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  extractRunBlocks,
  extractShellBlocks,
  loadRunBlocks,
  loadShellBlocks,
  releaseDownloadUrl,
  runBlocks,
  scriptOf,
} from "./check-docs-commands.ts";

const fence = "```";

const page = [
  "# A page",
  "",
  `${fence}sh run`,
  "mkdir ostra && cd ostra",
  "echo one",
  fence,
  "",
  `${fence}sh`,
  "ostra runner --join-token <your token>",
  fence,
  "",
  `${fence}yaml run`,
  "not: a command",
  fence,
  "",
  `${fence}bash run`,
  "echo bash is not sh",
  fence,
  "",
  "````md",
  `${fence}sh run`,
  "echo quoted, not a block",
  fence,
  "````",
  "",
  `  ${fence}sh   run  `,
  "echo two",
  fence,
  "",
].join("\n");

describe("extractRunBlocks", () => {
  it("F-058/c1: finds the sh blocks marked run, and only those, with their page and line", () => {
    expect(extractRunBlocks(page, "install/a.mdx")).toEqual([
      { page: "install/a.mdx", line: 3, code: "mkdir ostra && cd ostra\necho one" },
      { page: "install/a.mdx", line: 26, code: "echo two" },
    ]);
  });

  it("F-058: keeps the sh blocks without run too, marked as such, for the static checks", () => {
    expect(
      extractShellBlocks(page, "install/a.mdx").map((block) => [block.line, block.run]),
    ).toEqual([
      [3, true],
      [8, false],
      [26, true],
    ]);
  });

  it("F-058: reads a page with Windows line ends the same", () => {
    expect(
      extractRunBlocks(page.replaceAll("\n", "\r\n"), "install/a.mdx").map((block) => block.code),
    ).toEqual(["mkdir ostra && cd ostra\necho one", "echo two"]);
  });
});

describe("the docs' own pages", () => {
  const repo = path.resolve(import.meta.dirname, "..");
  const content = path.join(repo, "apps", "docs", "content");

  it("F-058/c1: the commands that need the reader's own values name only settings, flags and scripts ostra has", async () => {
    const configuration = await readFile(path.join(repo, "docs", "configuration.md"), "utf8");
    const pkg: unknown = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8"));
    const scripts =
      typeof pkg === "object" &&
      pkg !== null &&
      "scripts" in pkg &&
      typeof pkg.scripts === "object" &&
      pkg.scripts !== null
        ? Object.keys(pkg.scripts)
        : [];
    expect(scripts).toContain("dev");
    const blocks = await loadShellBlocks(content);
    expect(blocks.some((block) => !block.run)).toBe(true);
    const unknown: string[] = [];
    for (const block of blocks) {
      const where = `${block.page}:${String(block.line)}`;
      for (const [setting] of block.code.matchAll(/\bOSTRA_[A-Z0-9_]+/g)) {
        if (!configuration.includes(`\`${setting}\``)) unknown.push(`${where} ${setting}`);
      }
      for (const [, flags = ""] of block.code.matchAll(/\bostra runner\b(.*)/g)) {
        for (const [flag] of flags.matchAll(/--[a-z][a-z-]*/g)) {
          if (!configuration.includes(`\`${flag}\``)) unknown.push(`${where} ${flag}`);
        }
      }
      for (const [, script = ""] of block.code.matchAll(/^pnpm ([a-z][a-z:-]*)/gm)) {
        if (script !== "install" && !scripts.includes(script))
          unknown.push(`${where} pnpm ${script}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it("F-058/c1: the install guide's commands come first, from compose file to a healthy stack", async () => {
    const blocks = await loadRunBlocks(content);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0]?.page).toBe("install/docker-compose.mdx");
    const all = blocks.map((block) => block.code).join("\n");
    expect(all).toContain(`curl -fsSLO ${releaseDownloadUrl}compose.yaml`);
    expect(all).toContain("docker compose up -d");
    expect(all).toContain("/healthz");
  });

  it("F-058: every block marked run is in a page the navigation lists", async () => {
    const blocks = await loadRunBlocks(content);
    for (const block of blocks) {
      const [section, file] = block.page.split("/");
      const meta: unknown = JSON.parse(
        await readFile(path.join(content, section ?? "", "meta.json"), "utf8"),
      );
      expect(JSON.stringify(meta)).toContain(
        `"${path.basename(file ?? "", path.extname(file ?? ""))}"`,
      );
    }
  });
});

describe("runBlocks", () => {
  let root: string;
  let content: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "ostra-docs-commands-test-"));
    content = path.join(root, "content");
    await mkdir(path.join(content, "install"), { recursive: true });
    await mkdir(path.join(root, "work"));
    await writeFile(path.join(content, "meta.json"), JSON.stringify({ pages: ["install"] }));
    await writeFile(
      path.join(content, "install", "meta.json"),
      JSON.stringify({ pages: ["first", "second"] }),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const writePages = async (first: string, second: string): Promise<void> => {
    await writeFile(
      path.join(content, "install", "first.mdx"),
      `${fence}sh run\n${first}\n${fence}\n`,
    );
    await writeFile(
      path.join(content, "install", "second.mdx"),
      `# Second\n\n${fence}sh run\n${second}\n${fence}\n`,
    );
  };

  it("F-058/c1: runs the blocks in the navigation's order in one shell, so a cd holds for the next block", async () => {
    await writePages("mkdir ostra && cd ostra", "pwd > where.txt");
    const blocks = await loadRunBlocks(content);
    expect(blocks.map((block) => block.page)).toEqual(["install/first.mdx", "install/second.mdx"]);
    expect(await runBlocks(blocks, { cwd: path.join(root, "work") })).toEqual({
      kind: "passed",
      blocks: 2,
    });
    expect((await readFile(path.join(root, "work", "ostra", "where.txt"), "utf8")).trim()).toMatch(
      /ostra$/,
    );
  });

  it("F-058/c1: a page's broken command fails the run, names its block, and stops the blocks after it", async () => {
    await writePages(
      "echo started > started.txt\nfalse\necho after > after.txt",
      "echo next > next.txt",
    );
    const result = await runBlocks(await loadRunBlocks(content), { cwd: path.join(root, "work") });
    expect(result).toMatchObject({ kind: "failed", block: { page: "install/first.mdx", line: 1 } });
    await expect(readFile(path.join(root, "work", "started.txt"), "utf8")).resolves.toContain(
      "started",
    );
    await expect(readFile(path.join(root, "work", "after.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(root, "work", "next.txt"), "utf8")).rejects.toThrow();
  });

  it("F-058/c1: a block whose last output doesn't end its line passes, as the guide's healthz curl does", async () => {
    await writePages(`printf '{"ok":true}'`, "printf 'no newline either'");
    expect(await runBlocks(await loadRunBlocks(content), { cwd: path.join(root, "work") })).toEqual({
      kind: "passed",
      blocks: 2,
    });
    // And a failure after such output still names its own block.
    await writePages(`printf '{"ok":true}'`, "false");
    expect(
      await runBlocks(await loadRunBlocks(content), { cwd: path.join(root, "work") }),
    ).toMatchObject({ kind: "failed", block: { page: "install/second.mdx", line: 3 } });
  });

  it("F-058: a failure inside a pipe fails the block too", async () => {
    await writePages("echo fine", "false | cat");
    expect(
      await runBlocks(await loadRunBlocks(content), { cwd: path.join(root, "work") }),
    ).toMatchObject({
      kind: "failed",
      block: { page: "install/second.mdx", line: 3 },
    });
  });

  it("F-058: points the release's download links at a release candidate's assets", () => {
    const script = scriptOf(
      [{ page: "install/a.mdx", line: 1, code: `curl -fsSLO ${releaseDownloadUrl}compose.yaml` }],
      "file:///rc/",
    );
    expect(script).toContain("curl -fsSLO file:///rc/compose.yaml");
    expect(script).not.toContain(releaseDownloadUrl);
  });
});
