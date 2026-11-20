import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fakeMarker, FAKE_AGENT_REPO_CONFIG } from "@ostra/adapter-sdk/testing";
import { approvalRuleIdSchema, blobIdSchema, repoIdSchema, taskCredentialsSchema } from "@ostra/protocol";
import type { ApprovalRule, TaskSpec, TaskSpecMcpServer } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, Shared } from "../testing/task-host-harness.ts";
import { commandOnLocalPath } from "./stdio-command.ts";

// Ticket 29 (F-021, ADR 0049, ADR 0030): a task starts with its profile. On both scripted fake
// agents: the profile's skills come down the bulk path into the task's agent folder and reach the
// agent (`rich` reads them as a folder, `plain` from its instructions); its MCP servers reach the
// agent's config at the sidecar's proxy, with no credential; a stdio server whose command isn't
// in the box is refused before the agent starts; and the repo's own agent config is hidden from
// an agent that would obey it (`plain`), and back in the tree before the commit.

let shared: Shared;
let harness: Harness | undefined;

beforeAll(async () => {
  shared = await startShared("profile-launch");
  await shared.upstream.createRepo("ostra-test/cfg", {
    "README.md": "# cfg\n",
    "notes.txt": "notes\n",
    [FAKE_AGENT_REPO_CONFIG]: `${JSON.stringify({ permission: "allow" })}\n`,
  });
}, 60_000);

afterAll(async () => {
  await shared.close();
}, 60_000);

afterEach(async () => {
  await harness?.close();
  harness = undefined;
}, 60_000);

const start = async (): Promise<Harness> => {
  harness = await startHarness(shared);
  return harness;
};

const messages = (h: Harness, spec: TaskSpec): string => h.ofKind(spec, "agent.message").map((event) => event.text).join(" ");

const MCP_TOKEN = "profile-mcp-header-token-77aa";

/** Every file under `dir`, read as text. */
const filesUnder = async (dir: string): Promise<readonly { readonly file: string; readonly text: string }[]> => {
  const out: { file: string; text: string }[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push({ file: full, text: await readFile(full, "utf8").catch(() => "") });
      }
    }
  };
  await walk(dir);
  return out;
};

describe.each(["rich", "plain"] as const)("the profile at launch on the %s fake agent (F-021)", (profile) => {
  it("F-021/c4: a skill reaches the agent from the task's agent folder, never from the repo", async () => {
    const h = await start();
    const made = h.taskFor(fakeMarker("skills"), { agent: { ...taskSpecFixture.agent, adapter: `fake-acp-agent-${profile}`, apiFormat: "anthropic-messages" } });
    const skillBlob = h.server.putBlob(made.spec.taskId, Buffer.from("# The review skill\nRead the diff twice.\n"), "text/markdown");
    const extraBlob = h.server.putBlob(made.spec.taskId, Buffer.from("- tests pass\n"), "text/markdown");
    const spec: TaskSpec = {
      ...made.spec,
      agent: { ...made.spec.agent, skills: [{ name: "review", blobId: blobIdSchema.parse(skillBlob), files: [{ path: "checklists/done.md", blobId: blobIdSchema.parse(extraBlob) }] }] },
    };
    h.server.tasks.set(spec.taskId, { spec, credentials: made.credentials });
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved");
    if (profile === "rich") {
      expect(messages(h, spec)).toContain("skills: review (# The review skill)");
    } else {
      expect(messages(h, spec)).toContain("skills from instructions: review");
    }
    // Written into the agent folder, beside SKILL.md, and nowhere in the branch.
    const launched = h.launches.at(-1);
    const agentDir = launched?.env["FAKE_AGENT_DATA"] === undefined ? undefined : path.dirname(launched.env["FAKE_AGENT_DATA"]);
    expect(agentDir).toBeDefined();
    const written = await filesUnder(path.join(agentDir ?? "", "skills"));
    expect(written.map((entry) => path.relative(agentDir ?? "", entry.file).split(path.sep).join("/")).sort()).toEqual(["skills/review/SKILL.md", "skills/review/checklists/done.md"]);
    // The repo is untouched: nothing to push.
    expect(h.ofKind(spec, "session.saved")[0]?.repos.map((repo) => repo.ahead)).toEqual([false]);
  }, 120_000);
});

describe("a skill that can't come down whole (F-021)", () => {
  it("F-021/c4: a skill whose file doesn't match its digest, or can't be fetched, is left out; the task starts without it", async () => {
    const h = await start();
    const made = h.taskFor(fakeMarker("skills"), { agent: { ...taskSpecFixture.agent, adapter: "fake-acp-agent-rich", apiFormat: "anthropic-messages" } });
    const good = h.server.putBlob(made.spec.taskId, Buffer.from("# Good skill\n"), "text/markdown");
    const corrupt = h.server.putBlob(made.spec.taskId, Buffer.from("# Corrupt skill\n"), "text/markdown");
    const gone = h.server.putBlob(made.spec.taskId, Buffer.from("- a file\n"), "text/markdown");
    const goneMain = h.server.putBlob(made.spec.taskId, Buffer.from("# Partial skill\n"), "text/markdown");
    h.server.bulkFaults.corruptDownloads.add(corrupt);
    h.server.bulkFaults.failDownloads.add(gone);
    const spec: TaskSpec = {
      ...made.spec,
      agent: {
        ...made.spec.agent,
        skills: [
          { name: "good", blobId: blobIdSchema.parse(good), files: [] },
          { name: "corrupt", blobId: blobIdSchema.parse(corrupt), files: [] },
          { name: "partial", blobId: blobIdSchema.parse(goneMain), files: [{ path: "more.md", blobId: blobIdSchema.parse(gone) }] },
        ],
      },
    };
    h.server.tasks.set(spec.taskId, { spec, credentials: made.credentials });
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved");
    expect(messages(h, spec)).toContain("skills: good (# Good skill)");
    expect(messages(h, spec)).not.toContain("corrupt");
    expect(messages(h, spec)).not.toContain("partial");
    expect(h.logs.filter((record) => record.message === "a skill was left out").map((record) => record.fields["skill"])).toEqual(["corrupt", "partial"]);
  }, 120_000);
});

describe("MCP servers at launch (F-021)", () => {
  const servers: TaskSpecMcpServer[] = [
    { name: "docs", transport: "http", proxyPath: "/mcp/docs", readOnly: true },
    { name: "local", transport: "stdio", command: process.execPath, args: ["-e", "0"], env: { LOCAL_MODE: "plain" }, readOnly: false },
  ];

  it("F-021/c4: the profile's MCP servers reach the agent at the sidecar's proxy, and no server credential is in its launch", async () => {
    const h = await start();
    const made = h.taskFor(fakeMarker("mcp"), { agent: { ...taskSpecFixture.agent, adapter: "fake-acp-agent-rich", apiFormat: "anthropic-messages", mcpServers: servers } });
    const credentials = taskCredentialsSchema.parse({
      ...made.credentials,
      mcpServers: [{ name: "docs", url: "https://mcp.example.test/v1/mcp", headers: { authorization: `Bearer ${MCP_TOKEN}` } }],
    });
    h.server.tasks.set(made.spec.taskId, { spec: made.spec, credentials });
    h.dispatch(made.spec);
    await h.waitForKind(made.spec, "session.saved");
    expect(messages(h, made.spec)).toContain("mcp: docs/http, local/stdio, ostra/session");
    const everything = JSON.stringify([h.launches, h.eventsOf(made.spec), h.logs]);
    expect(everything).not.toContain(MCP_TOKEN);
    expect(everything).not.toContain("mcp.example.test");
  }, 120_000);

  it("F-021/c4: a stdio server whose command isn't on the box's PATH is refused before the agent starts, naming the server", async () => {
    const h = await start();
    const missing: TaskSpecMcpServer = { name: "ghost", transport: "stdio", command: "ostra-no-such-mcp-server-9f3e", args: [], env: {}, readOnly: false };
    const { spec } = h.taskFor(fakeMarker("say"), { agent: { ...taskSpecFixture.agent, adapter: "fake-acp-agent-rich", apiFormat: "anthropic-messages", mcpServers: [missing] } });
    h.dispatch(spec);
    await h.waitForKind(spec, "session.crashed");
    expect(h.ofKind(spec, "session.crashed")[0]?.error).toContain('the MCP server "ghost" can\'t start: its command isn\'t on the box\'s PATH');
    expect(h.launches).toHaveLength(0);
    expect(h.kinds(spec)).not.toContain("turn.started");
  }, 120_000);

  it("F-021: finds a command on the launch's PATH, an absolute one, and refuses a relative path or a missing name", async () => {
    const env = { PATH: path.dirname(process.execPath) };
    const node = process.platform === "win32" ? "node" : path.basename(process.execPath);
    expect(await commandOnLocalPath(node, env)).toBe(true);
    expect(await commandOnLocalPath(process.execPath, {})).toBe(true);
    expect(await commandOnLocalPath(node, { PATH: "" })).toBe(false);
    expect(await commandOnLocalPath(`./${node}`, env)).toBe(false);
    expect(await commandOnLocalPath("ostra-no-such-command-1c2d", env)).toBe(false);
  });
});

describe("the repo's own agent config (F-021, Q171)", () => {
  const NOTES_RULE: ApprovalRule = { ruleId: approvalRuleIdSchema.parse("rule-notes"), name: "Notes", tool: "edit", match: { kind: "path-glob", glob: "notes*.txt" } };

  const cfgTask = (h: Harness, profile: "rich" | "plain") => {
    const [base] = taskSpecFixture.repos;
    if (base === undefined) {
      throw new Error("the fixture has a repo");
    }
    return h.taskFor(fakeMarker("ask-path", "notes.txt"), {
      repos: [{ ...base, repoId: repoIdSchema.parse("0196f1a0-0000-7000-8000-0000000000cf"), fullName: "ostra-test/cfg", cloneUrl: "https://github.com/ostra-test/cfg.git", checkoutDir: "cfg" }],
      agent: { ...taskSpecFixture.agent, adapter: `fake-acp-agent-${profile}`, apiFormat: "anthropic-messages", approvalRules: [NOTES_RULE] },
    });
  };

  it("F-021/c5: an agent that obeys the repo's config doesn't see it: the rule still asks, and the file is back in the branch, unchanged", async () => {
    const h = await start();
    const { spec } = cfgTask(h, "plain");
    h.dispatch(spec);
    // The repo's config allows everything; hidden, it can't, so the profile's rule asks.
    await h.waitForKind(spec, "approval.requested");
    const [requested] = h.ofKind(spec, "approval.requested");
    expect(requested).toMatchObject({ rule: { ruleId: NOTES_RULE.ruleId }, subject: { kind: "path", value: "notes.txt" } });
    h.command("approval-answer", { sessionId: spec.sessionId, approvalId: requested?.approvalId, decision: "allow_once" });
    await h.waitForKind(spec, "session.saved");
    const ref = `refs/heads/${spec.branchName}`;
    expect(await shared.upstream.fileAt("ostra-test/cfg", ref, FAKE_AGENT_REPO_CONFIG)).toBe(`${JSON.stringify({ permission: "allow" })}\n`);
    expect(await shared.upstream.fileAt("ostra-test/cfg", ref, "notes.txt")).toContain("Written by the fake agent.");
    const tree = await shared.upstream.treeFiles("ostra-test/cfg", ref);
    expect(tree.some((file) => file.endsWith(".ostra-hidden"))).toBe(false);
  }, 120_000);

  it("F-021/c5: an agent whose own config wins keeps the repo's config where it is", async () => {
    const h = await start();
    const { spec } = cfgTask(h, "rich");
    h.dispatch(spec);
    await h.waitForKind(spec, "approval.requested");
    expect(h.logs.some((record) => record.message === "the repo's own agent config is hidden for the task")).toBe(false);
  }, 120_000);
});
