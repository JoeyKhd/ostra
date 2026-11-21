import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fakeMarker } from "@ostra/adapter-sdk/testing";
import { blobIdSchema } from "@ostra/protocol";
import type { TaskSpec, TaskSpecSkill } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startLocalDockerBox } from "../testing/docker-box.ts";
import { startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, HarnessOptions, Shared } from "../testing/task-host-harness.ts";

// The library's skills on every executor (F-145, ADR 0069, "Delivery: unchanged"; ticket 28). Core
// copies a library skill into the task's blobs exactly as a profile's own (its SKILL.md as the
// skill's blob, each other file at its path, a script and a binary file among them), so the
// runner's one path takes both: each blob comes down the bulk path checked against the digest core
// sent, into the task's own agent folder, and nothing is fetched in the box. On `host`, and on
// `docker` as a box's sidecar drives it (`DockerExecutor` through the real bridge to a local init).

const LF = String.fromCharCode(10);

const modes: readonly { readonly name: "host" | "docker"; readonly makeExecutor?: HarnessOptions["makeExecutor"] }[] = [{ name: "host" }, { name: "docker", makeExecutor: startLocalDockerBox }];

let shared: Shared;
let harness: Harness | undefined;

beforeAll(async () => {
  shared = await startShared("library-skills");
}, 60_000);

afterAll(async () => {
  await shared.close();
}, 60_000);

afterEach(async () => {
  await harness?.close();
  harness = undefined;
}, 60_000);

/** Every file under `dir`, by its path relative to it. */
const filesUnder = async (dir: string): Promise<ReadonlyMap<string, Buffer>> => {
  const out = new Map<string, Buffer>();
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.set(path.relative(dir, full).split(path.sep).join("/"), await readFile(full));
      }
    }
  };
  await walk(dir);
  return out;
};

/** The folder holding the task's skills, wherever the executor put the agent's folder: found by the profile's skill. */
const skillsRoot = async (root: string): Promise<string | null> => {
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (entry.isFile() && entry.name === "SKILL.md" && path.basename(entry.parentPath) === "review" && path.basename(path.dirname(entry.parentPath)) === "skills") {
      return path.dirname(entry.parentPath);
    }
  }
  return null;
};

const LIBRARY_FILES: Readonly<Record<string, Buffer>> = {
  "SKILL.md": Buffer.from(["---", "name: pdf", "description: Reads and fills PDF forms.", "---", "# PDF", "", "See reference.md.", ""].join(LF)),
  "reference.md": Buffer.from("# Reference" + LF + "Fields are named by their labels." + LF),
  "scripts/extract.py": Buffer.from("#!/usr/bin/env python3" + LF + "print('fields')" + LF),
  "assets/sample.pdf": Buffer.alloc(4096, 0x25),
};

/** A task with the profile's own `review` skill and the library's `pdf`, as core's dispatch hands both over. */
const taskWithSkills = (h: Harness, corrupt: string | null = null): TaskSpec => {
  const made = h.taskFor(fakeMarker("skills"), { agent: { ...taskSpecFixture.agent, adapter: "fake-acp-agent-rich", apiFormat: "anthropic-messages" } });
  const put = (bytes: Buffer, type: string) => blobIdSchema.parse(h.server.putBlob(made.spec.taskId, bytes, type));
  const own: TaskSpecSkill = {
    name: "review",
    blobId: put(Buffer.from("# The review skill" + LF + "Read the diff twice." + LF), "text/markdown"),
    files: [{ path: "checklists/done.md", blobId: put(Buffer.from("- tests pass" + LF), "text/markdown") }],
  };
  const files = Object.entries(LIBRARY_FILES).filter(([file]) => file !== "SKILL.md").map(([file, bytes]) => {
    const blobId = put(bytes, file.endsWith(".md") ? "text/markdown" : "application/octet-stream");
    if (file === corrupt) h.server.bulkFaults.corruptDownloads.add(blobId);
    return { path: file, blobId };
  });
  const library: TaskSpecSkill = { name: "pdf", blobId: put(LIBRARY_FILES["SKILL.md"] ?? Buffer.alloc(0), "text/markdown"), files };
  const spec: TaskSpec = { ...made.spec, agent: { ...made.spec.agent, skills: [own, library] } };
  h.server.tasks.set(spec.taskId, { spec, credentials: made.credentials });
  return spec;
};

const messages = (h: Harness, spec: TaskSpec): string => h.ofKind(spec, "agent.message").map((event) => event.text).join(" ");

describe.each(modes)("library skills on $name (F-145)", (mode) => {
  it(`F-145/c12: on ${mode.name}, a library skill reaches the agent from the task's own folder as its blobs with their digests, each file at its path, the same way the profile's own skill does`, async () => {
    harness = await startHarness(shared, mode.makeExecutor === undefined ? {} : { makeExecutor: mode.makeExecutor });
    const h = harness;
    const spec = taskWithSkills(h);
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved", 1, 150_000);
    // The fake names each skill it reads with its SKILL.md's first line: the library's opens with its front matter.
    expect(messages(h, spec)).toContain("skills: review (# The review skill), pdf (---)");
    const root = await skillsRoot(h.dataDir);
    if (root === null) throw new Error("the task's skills folder");
    const written = await filesUnder(root);
    expect([...written.keys()].sort()).toEqual(["pdf/SKILL.md", "pdf/assets/sample.pdf", "pdf/reference.md", "pdf/scripts/extract.py", "review/SKILL.md", "review/checklists/done.md"]);
    for (const [file, bytes] of Object.entries(LIBRARY_FILES)) {
      expect(written.get(`pdf/${file}`), file).toEqual(bytes);
    }
    // Nothing was fetched but the task's own blobs, and nothing landed in the repo: nothing to push.
    expect(h.logs.filter((record) => record.message === "a skill was left out")).toEqual([]);
    expect(h.ofKind(spec, "session.saved")[0]?.repos.map((repo) => repo.ahead)).toEqual([false]);
  }, 240_000);

  it(`F-145/c12: on ${mode.name}, a library skill whose file doesn't match its digest is left out whole, as an own skill would be, and the task starts with the rest`, async () => {
    harness = await startHarness(shared, mode.makeExecutor === undefined ? {} : { makeExecutor: mode.makeExecutor });
    const h = harness;
    const spec = taskWithSkills(h, "scripts/extract.py");
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved", 1, 150_000);
    expect(messages(h, spec)).toContain("review (# The review skill)");
    expect(messages(h, spec)).not.toContain("pdf (");
    expect(h.logs.filter((record) => record.message === "a skill was left out").map((record) => record.fields["skill"])).toEqual(["pdf"]);
    const root = await skillsRoot(h.dataDir);
    expect([...(await filesUnder(path.join(root ?? "", "pdf"))).keys()]).toEqual([]);
  }, 240_000);
});
