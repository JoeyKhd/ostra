import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { globToRegExp } from "@ostra/protocol";

// What an onboarding task's push may change (F-113, ADR 0038 as amended 2026-11-21, the
// maintainer's "all yes"): only the task's `commitPaths`, `AGENTS.md`. The git proxy holds such a
// push's pack on disk and asks this check before a byte goes upstream. Every commit the pack carries
// is compared with each of its parents (a root commit with the empty tree), and a ref the push moves
// to a commit the pack doesn't carry, one the code host already has, is compared the same way. One
// changed path outside `commitPaths` refuses the whole push.
//
// It runs git in a scratch repo of the proxy's own, never in the agent's checkout, whose config and
// hooks the agent writes: the pack is indexed there (`index-pack --fix-thin`, its thin bases read
// from the checkout's object folder as an alternate), and the commits and trees are read with
// `cat-file --batch`. Every object read is hashed again here, so an object the agent planted in its
// checkout under another object's ID is caught, and anything the check can't read refuses the push.
// It reads names and object IDs only, never a file's content, and none of it is logged.

export type PathCheckLimits = {
  /** The most commits one push may carry. */
  readonly commits: number;
  /** The most commit and tree objects read to check them. */
  readonly objects: number;
  /** How long the whole check may take. */
  readonly timeoutMs: number;
};

/** The working values: an onboarding push is one small commit per repo. */
export const PATH_CHECK_LIMITS: PathCheckLimits = { commits: 1000, objects: 100_000, timeoutMs: 120_000 };

export type PushPathCheckInput = {
  /** The pushed pack: the file and where its `PACK` header starts. `null` when the push carries none. */
  readonly pack: { readonly file: string; readonly start: number } | null;
  /** The commits the push moves its refs to (its creates and updates, never a ref left where it was). */
  readonly tips: readonly string[];
  /** The task's `commitPaths`: repo-relative paths or globs. */
  readonly commitPaths: readonly string[];
  /** The task's checkout's object folder, for thin bases and parents. `null`: the pack alone. */
  readonly objectsDir: string | null;
  /** An empty folder of the proxy's own, which the caller removes. */
  readonly scratchDir: string;
  readonly limits?: PathCheckLimits;
};

/** Why a push couldn't be checked: a code, never a path. */
export type UncheckedReason = "bad-pack" | "missing-object" | "bad-object" | "too-large" | "timed-out" | "git-failed";

export type PushPathVerdict =
  | { readonly kind: "allowed"; readonly commits: number }
  | { readonly kind: "refused"; readonly commits: number }
  | { readonly kind: "unchecked"; readonly reason: UncheckedReason };

type GitObjectType = "commit" | "tree" | "blob" | "tag";
type GitObject = { readonly type: GitObjectType; readonly content: Buffer };
type TreeEntry = { readonly mode: string; readonly name: string; readonly oid: string };
type Commit = { readonly tree: string; readonly parents: readonly string[] };
type Step = "ok" | "refused" | UncheckedReason;

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TREE_MODE = "40000";
/** The most output one git command may print here (`verify-pack -v` of a large pack). */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** The largest commit or tree read. */
const MAX_OBJECT_BYTES = 32 * 1024 * 1024;

const isObjectType = (value: string | undefined): value is GitObjectType => value === "commit" || value === "tree" || value === "blob" || value === "tag";

/** This process's environment without git's own variables, which would point git elsewhere. */
const withoutGitVariables = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.toUpperCase().startsWith("GIT_")) {
      env[name] = value;
    }
  }
  return env;
};

type GitResult = { readonly code: number | null; readonly stdout: Buffer };

/** One git command, its stdin from a file when given. Never a shell; its stderr is dropped, as it can name paths. */
const runGit = (args: readonly string[], env: Readonly<Record<string, string>>, signal: AbortSignal, stdin?: { readonly file: string; readonly start: number }): Promise<GitResult> =>
  new Promise((resolve) => {
    let settled = false;
    const done = (result: GitResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const child = spawn("git", [...args], { env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, signal });
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", () => {
      done({ code: null, stdout: Buffer.alloc(0) });
    });
    child.on("close", (code) => {
      done({ code: bytes > MAX_OUTPUT_BYTES ? null : code, stdout: Buffer.concat(chunks) });
    });
    child.stdin.on("error", () => undefined);
    if (stdin === undefined) {
      child.stdin.end();
      return;
    }
    const source = createReadStream(stdin.file, { start: stdin.start });
    source.on("error", () => {
      child.kill();
    });
    source.pipe(child.stdin);
  });

/** The object count in a pack's header, or `null` when it isn't a pack. */
const packObjectCount = async (pack: { readonly file: string; readonly start: number }): Promise<number | null> => {
  const handle = await open(pack.file, "r");
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, 12, pack.start);
    if (bytesRead < 12 || header.toString("ascii", 0, 4) !== "PACK") {
      return null;
    }
    const version = header.readUInt32BE(4);
    return version === 2 || version === 3 ? header.readUInt32BE(8) : null;
  } finally {
    await handle.close();
  }
};

type ObjectReader = { readonly read: (oid: string) => Promise<GitObject | null | "failed">; readonly close: () => void };

/** `git cat-file --batch`, one object at a time. `null`: git has no such object. */
const startObjectReader = (env: Readonly<Record<string, string>>, signal: AbortSignal): ObjectReader => {
  const child = spawn("git", ["cat-file", "--batch"], { env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, signal });
  let buffer: Buffer = Buffer.alloc(0);
  let failed = false;
  const waiting: ((value: GitObject | null | "failed") => void)[] = [];
  const fail = (): void => {
    failed = true;
    for (const resolve of waiting.splice(0)) {
      resolve("failed");
    }
  };
  const pump = (): void => {
    for (;;) {
      const resolve = waiting[0];
      const newline = buffer.indexOf(0x0a);
      if (resolve === undefined || newline < 0) {
        return;
      }
      const parts = buffer.toString("utf8", 0, newline).split(" ");
      if (parts.length === 2 && (parts[1] === "missing" || parts[1] === "ambiguous")) {
        buffer = buffer.subarray(newline + 1);
        waiting.shift();
        resolve(null);
        continue;
      }
      const [, type, sizeText] = parts;
      const size = Number(sizeText);
      if (parts.length !== 3 || !isObjectType(type) || !Number.isSafeInteger(size) || size < 0 || size > MAX_OBJECT_BYTES) {
        fail();
        child.kill();
        return;
      }
      if (buffer.length < newline + 1 + size + 1) {
        return;
      }
      const content = Buffer.from(buffer.subarray(newline + 1, newline + 1 + size));
      buffer = buffer.subarray(newline + 1 + size + 1);
      waiting.shift();
      resolve({ type, content });
    }
  };
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    pump();
  });
  child.on("error", fail);
  child.on("close", fail);
  child.stdin.on("error", () => undefined);
  return {
    read: (oid) =>
      new Promise((resolve) => {
        if (failed) {
          resolve("failed");
          return;
        }
        waiting.push(resolve);
        child.stdin.write(`${oid}\n`);
      }),
    close: () => {
      child.stdin.end();
      child.kill();
    },
  };
};

/** A tree's entries, or `null` when it doesn't parse. */
const parseTree = (content: Buffer, oidBytes: number): readonly TreeEntry[] | null => {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < content.length) {
    const space = content.indexOf(0x20, at);
    const nul = space < 0 ? -1 : content.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 1 + oidBytes > content.length) {
      return null;
    }
    entries.push({ mode: content.toString("ascii", at, space), name: content.toString("utf8", space + 1, nul), oid: content.toString("hex", nul + 1, nul + 1 + oidBytes) });
    at = nul + 1 + oidBytes;
  }
  return entries;
};

/** A commit's tree and parents, from its header, or `null` when it doesn't parse. */
const parseCommit = (content: Buffer): Commit | null => {
  const end = content.indexOf("\n\n");
  const lines = content.toString("utf8", 0, end < 0 ? content.length : end).split("\n");
  const tree = lines[0]?.startsWith("tree ") === true ? lines[0].slice("tree ".length) : "";
  if (!OID.test(tree)) {
    return null;
  }
  const parents: string[] = [];
  for (const line of lines.slice(1)) {
    if (!line.startsWith("parent ")) {
      break;
    }
    const parent = line.slice("parent ".length);
    if (!OID.test(parent)) {
      return null;
    }
    parents.push(parent);
  }
  return { tree, parents };
};

/** The pack's own objects by type, in its order: the first `count` by offset, before what `--fix-thin` appended. */
const packObjects = (verifyOutput: string, count: number): readonly { readonly oid: string; readonly type: GitObjectType }[] => {
  const rows: { readonly oid: string; readonly type: GitObjectType; readonly offset: number }[] = [];
  for (const line of verifyOutput.split("\n")) {
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (commit|tree|blob|tag) +\d+ \d+ (\d+)/.exec(line);
    const [, oid, type, offset] = match ?? [];
    if (oid !== undefined && isObjectType(type) && offset !== undefined) {
      rows.push({ oid, type, offset: Number(offset) });
    }
  }
  return rows.sort((a, b) => a.offset - b.offset).slice(0, count);
};

/** Checks a push's commits against `commitPaths`, in a scratch repo of the caller's. */
export const checkPushPaths = async (input: PushPathCheckInput): Promise<PushPathVerdict> => {
  const limits = input.limits ?? PATH_CHECK_LIMITS;
  const signal = AbortSignal.timeout(limits.timeoutMs);
  const unchecked = (reason: UncheckedReason): PushPathVerdict => ({ kind: "unchecked", reason: signal.aborted ? "timed-out" : reason });
  const patterns = input.commitPaths.map(globToRegExp);
  const allowed = (file: string): boolean => patterns.some((pattern) => pattern.test(file));
  const sha256 = input.tips.some((tip) => tip.length === 64);
  const oidBytes = sha256 ? 32 : 20;

  // git with nothing of this machine's config, in the proxy's own repo.
  const emptyConfig = path.join(input.scratchDir, "empty.gitconfig");
  await writeFile(emptyConfig, "");
  const repoDir = path.join(input.scratchDir, "check.git");
  const base = { ...withoutGitVariables(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyConfig, GIT_TERMINAL_PROMPT: "0", HOME: input.scratchDir };
  const created = await runGit(["init", "--quiet", "--bare", "--template=", ...(sha256 ? ["--object-format=sha256"] : []), repoDir], base, signal);
  if (created.code !== 0) {
    return unchecked("git-failed");
  }
  const env = { ...base, GIT_DIR: repoDir, ...(input.objectsDir === null ? {} : { GIT_ALTERNATE_OBJECT_DIRECTORIES: input.objectsDir }) };

  // 1. The pack's own objects, by type.
  let carried: readonly { readonly oid: string; readonly type: GitObjectType }[] = [];
  if (input.pack !== null) {
    const count = await packObjectCount(input.pack);
    if (count === null) {
      return unchecked("bad-pack");
    }
    if (count > 0) {
      const indexed = await runGit(["index-pack", "--stdin", "--fix-thin"], env, signal, input.pack);
      if (indexed.code !== 0) {
        return unchecked("bad-pack");
      }
      const packDir = path.join(repoDir, "objects", "pack");
      const index = (await readdir(packDir)).find((name) => name.endsWith(".idx"));
      if (index === undefined) {
        return unchecked("git-failed");
      }
      // The types come from the pack itself, never from an object the checkout holds.
      const verified = await runGit(["verify-pack", "-v", path.join(packDir, index)], env, signal);
      if (verified.code !== 0) {
        return unchecked("bad-pack");
      }
      carried = packObjects(verified.stdout.toString("utf8"), count);
      if (carried.length !== count) {
        return unchecked("bad-pack");
      }
    }
  }
  const typeOf = new Map(carried.map((object) => [object.oid, object.type] as const));
  // A ref moves to a commit only: a tree or a tag the pack carries would hold paths no commit names.
  if (input.tips.some((tip) => (typeOf.get(tip) ?? "commit") !== "commit")) {
    return unchecked("bad-object");
  }
  const commits = [...new Set([...carried.filter((object) => object.type === "commit").map((object) => object.oid), ...input.tips.filter((tip) => !typeOf.has(tip))])];
  if (commits.length > limits.commits) {
    return unchecked("too-large");
  }

  // 2. Each commit against each parent, every object hashed again as it's read.
  const reader = startObjectReader(env, signal);
  let reads = 0;
  const readObject = async (oid: string, type: GitObjectType): Promise<Buffer | UncheckedReason> => {
    reads += 1;
    if (reads > limits.objects) {
      return "too-large";
    }
    const object = await reader.read(oid);
    if (object === "failed") {
      return "git-failed";
    }
    if (object === null) {
      return "missing-object";
    }
    const hash = createHash(sha256 ? "sha256" : "sha1").update(`${object.type} ${String(object.content.length)}\0`).update(object.content).digest("hex");
    return hash !== oid || object.type !== type ? "bad-object" : object.content;
  };
  const readCommit = async (oid: string): Promise<Commit | UncheckedReason> => {
    const content = await readObject(oid, "commit");
    return typeof content === "string" ? content : (parseCommit(content) ?? "bad-object");
  };
  const readTree = async (oid: string | null): Promise<readonly TreeEntry[] | UncheckedReason> => {
    if (oid === null) {
      return [];
    }
    const content = await readObject(oid, "tree");
    return typeof content === "string" ? content : (parseTree(content, oidBytes) ?? "bad-object");
  };
  /** The two trees' differing paths, each checked: the first one outside `commitPaths` stops it. */
  const compareTrees = async (from: string | null, to: string | null, prefix: string): Promise<Step> => {
    if (from === to) {
      return "ok";
    }
    const before = await readTree(from);
    if (typeof before === "string") return before;
    const after = await readTree(to);
    if (typeof after === "string") return after;
    const names = new Map<string, { before?: TreeEntry; after?: TreeEntry }>();
    for (const entry of before) names.set(entry.name, { before: entry });
    for (const entry of after) names.set(entry.name, { ...names.get(entry.name), after: entry });
    for (const [name, pair] of names) {
      if (pair.before !== undefined && pair.before.oid === pair.after?.oid && pair.before.mode === pair.after.mode) {
        continue;
      }
      const full = `${prefix}${name}`;
      const fromTree = pair.before?.mode === TREE_MODE ? pair.before.oid : null;
      const toTree = pair.after?.mode === TREE_MODE ? pair.after.oid : null;
      if (fromTree !== null || toTree !== null) {
        const step = await compareTrees(fromTree, toTree, `${full}/`);
        if (step !== "ok") return step;
      }
      const fileChanged = (pair.before !== undefined && pair.before.mode !== TREE_MODE) || (pair.after !== undefined && pair.after.mode !== TREE_MODE);
      if (fileChanged && !allowed(full)) {
        return "refused";
      }
    }
    return "ok";
  };
  const checkCommit = async (oid: string): Promise<Step> => {
    const commit = await readCommit(oid);
    if (typeof commit === "string") return commit;
    if (commit.parents.length === 0) {
      return compareTrees(null, commit.tree, "");
    }
    for (const parentId of commit.parents) {
      const parent = await readCommit(parentId);
      if (typeof parent === "string") return parent;
      const step = await compareTrees(parent.tree, commit.tree, "");
      if (step !== "ok") return step;
    }
    return "ok";
  };
  try {
    for (const oid of commits) {
      const step = await checkCommit(oid);
      if (step === "refused") {
        return { kind: "refused", commits: commits.length };
      }
      if (step !== "ok") {
        return unchecked(step);
      }
    }
    return { kind: "allowed", commits: commits.length };
  } finally {
    reader.close();
  }
};
