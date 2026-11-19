// The docs' checked commands (F-058, ADR 0063): every fenced `sh` block marked `run` in the docs
// site's pages (` ```sh run `) is a command a reader pastes, and this script runs them, in the
// navigation's order, in one shell, and stops at the first that fails.
//
// - The blocks are read from `apps/docs/content/`, section by section in `content/meta.json`'s order
//   and page by page in each section's `meta.json`, the order a newcomer follows them in. A `sh`
//   block without `run` (one that needs the reader's own values) and every other language are left
//   out. The site's code block shows the `run` chip from the same meta (`remarkCodeMeta`).
// - The blocks run in one `bash` process, so a `cd` in one block holds for the next, as it does in
//   the reader's terminal. Each starts with a marker line naming its page and line, so a failure
//   names the block it stopped in.
// - `--release-assets <url>` points the release's download links at a release candidate's assets
//   (a folder, as a `file://` URL), for the Linux proof job, which runs before the release exists.
//
// Run with `node scripts/check-docs-commands.ts [--list] [--cwd <dir>] [--release-assets <url>]`.
// It runs real commands (the install guide's `docker compose up`), so it belongs on a throwaway
// machine: the proof job in `.github/workflows/proof.yml`, never on a developer's own.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

/** A command block a reader copies and ostra runs before each release. */
export type RunBlock = {
  /** The page's file, relative to the content folder, with forward slashes. */
  readonly page: string;
  /** The line of the block's opening fence, from 1. */
  readonly line: number;
  /** The block's text, exactly as the page shows and its copy button copies it. */
  readonly code: string;
};

/** Where the install guide downloads the release's files from; `--release-assets` replaces it. */
export const releaseDownloadUrl = "https://github.com/JoeyKhd/ostra/releases/latest/download/";

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** A fenced `sh` block of a page, marked `run` or not. */
export type ShellBlock = RunBlock & { readonly run: boolean };

/**
 * The `sh` blocks of one page's Markdown, in the page's order, each with whether it's marked `run`.
 * A fence's info string is its language and then its meta words (` ```sh run `); a block ends at a
 * fence of the same character at least as long, so a longer fence can quote a block without it
 * counting.
 */
export const extractShellBlocks = (source: string, page: string): ShellBlock[] => {
  const lines = source.split(/\r?\n/);
  const blocks: ShellBlock[] = [];
  let open: {
    readonly fence: string;
    readonly line: number;
    readonly lang: string;
    readonly run: boolean;
    readonly body: string[];
  } | null = null;
  for (const [index, text] of lines.entries()) {
    if (open === null) {
      const match = FENCE.exec(text);
      const fence = match?.[1];
      if (fence === undefined) {
        continue;
      }
      const [lang = "", ...meta] = (match?.[2] ?? "").trim().split(/\s+/);
      open = { fence, line: index + 1, lang, run: meta.includes("run"), body: [] };
      continue;
    }
    const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(text)?.[1];
    if (
      closing !== undefined &&
      closing.startsWith(open.fence.charAt(0)) &&
      closing.length >= open.fence.length
    ) {
      if (open.lang === "sh") {
        blocks.push({ page, line: open.line, code: open.body.join("\n"), run: open.run });
      }
      open = null;
      continue;
    }
    open.body.push(text);
  }
  return blocks;
};

/** The `sh` blocks marked `run` in one page's Markdown: the commands ostra runs before a release. */
export const extractRunBlocks = (source: string, page: string): RunBlock[] =>
  extractShellBlocks(source, page).flatMap((block) =>
    block.run ? [{ page: block.page, line: block.line, code: block.code }] : [],
  );

// `meta.json` is the site's own format (Fumadocs' page tree): its `pages` list is all this reads.
const metaSchema = z.looseObject({ pages: z.array(z.string()) });

const readMeta = async (dir: string): Promise<string[]> =>
  metaSchema.parse(JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8"))).pages;

const readPage = async (file: string): Promise<string | null> => {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

/**
 * Every page's `sh` blocks, in the navigation's order. A page the navigation names but the folder
 * doesn't hold as `.mdx` or `.md` is one read from `docs/` (the site's `repoDocs`), which carries
 * no `run` block.
 */
export const loadShellBlocks = async (contentDir: string): Promise<ShellBlock[]> => {
  const blocks: ShellBlock[] = [];
  for (const section of await readMeta(contentDir)) {
    const sectionDir = path.join(contentDir, section);
    for (const page of await readMeta(sectionDir)) {
      for (const extension of [".mdx", ".md"]) {
        const source = await readPage(path.join(sectionDir, page + extension));
        if (source !== null) {
          blocks.push(...extractShellBlocks(source, `${section}/${page}${extension}`));
          break;
        }
      }
    }
  }
  return blocks;
};

/** Every page's `run` blocks, in the navigation's order. */
export const loadRunBlocks = async (contentDir: string): Promise<RunBlock[]> =>
  (await loadShellBlocks(contentDir)).flatMap((block) =>
    block.run ? [{ page: block.page, line: block.line, code: block.code }] : [],
  );

const MARKER = "::ostra-docs-block::";

const blockName = (block: RunBlock): string => `${block.page}:${String(block.line)}`;

/** One shell script: `set -e`, then each block after its marker line, in order. */
export const scriptOf = (blocks: readonly RunBlock[], releaseAssets?: string): string =>
  [
    "set -eo pipefail",
    ...blocks.flatMap((block) => [
      `printf '%s\\n' '${MARKER} ${blockName(block)}'`,
      releaseAssets === undefined
        ? block.code
        : block.code.replaceAll(releaseDownloadUrl, releaseAssets),
    ]),
    `printf '%s\\n' '${MARKER} done'`,
    "",
  ].join("\n");

export type RunResult =
  | { readonly kind: "passed"; readonly blocks: number }
  | { readonly kind: "failed"; readonly block: RunBlock; readonly exitCode: number };

/**
 * Runs the blocks in one `bash` in `cwd`, streaming its output, and says which block stopped it. The
 * script is a file, never a command line or the shell's stdin, so nothing is quoted into a command
 * and a command that reads stdin can't swallow the blocks after it.
 */
export const runBlocks = async (
  blocks: readonly RunBlock[],
  options: {
    readonly cwd: string;
    readonly releaseAssets?: string;
    readonly shell?: string;
    readonly echo?: boolean;
  },
): Promise<RunResult> => {
  const dir = await mkdtemp(path.join(tmpdir(), "ostra-docs-commands-"));
  const script = path.join(dir, "commands.sh");
  await writeFile(script, scriptOf(blocks, options.releaseAssets));
  const state: { started: string | null } = { started: null };
  try {
    const child = spawn(options.shell ?? "bash", [script], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let pending = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith(MARKER)) {
          state.started = line.slice(MARKER.length).trim();
          if (options.echo === true) {
            process.stdout.write(`\n$ # ${state.started}\n`);
          }
        } else if (options.echo === true) {
          process.stdout.write(`${line}\n`);
        }
      }
    });
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        resolve(code ?? 1);
      });
    });
    if (exitCode === 0 && state.started === "done") {
      return { kind: "passed", blocks: blocks.length };
    }
    const block = blocks.find((candidate) => blockName(candidate) === state.started) ?? blocks[0];
    if (block === undefined) {
      return { kind: "passed", blocks: 0 };
    }
    return { kind: "failed", block, exitCode: exitCode === 0 ? 1 : exitCode };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      list: { type: "boolean", default: false },
      cwd: { type: "string" },
      "release-assets": { type: "string" },
    },
  });
  const root = path.resolve(import.meta.dirname, "..");
  const blocks = await loadRunBlocks(path.join(root, "apps", "docs", "content"));
  if (values.list) {
    for (const block of blocks) {
      console.log(`# ${blockName(block)}\n${block.code}\n`);
    }
    console.log(`docs commands: ${String(blocks.length)} blocks marked run`);
    return;
  }
  if (blocks.length === 0) {
    console.error("docs commands: no block is marked run, so nothing was checked");
    process.exitCode = 1;
    return;
  }
  const cwd = path.resolve(values.cwd ?? process.cwd());
  await mkdir(cwd, { recursive: true });
  const releaseAssets = values["release-assets"];
  const result = await runBlocks(blocks, {
    cwd,
    echo: true,
    ...(releaseAssets === undefined ? {} : { releaseAssets }),
  });
  switch (result.kind) {
    case "passed":
      console.log(`docs commands: ${String(result.blocks)} blocks ran, every one passed`);
      return;
    case "failed":
      console.error(
        `docs commands: the block at ${blockName(result.block)} failed (exit ${String(result.exitCode)})`,
      );
      process.exitCode = 1;
      return;
    default:
      result satisfies never;
  }
};

if (import.meta.main) {
  await main();
}
