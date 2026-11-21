import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createScenarioBrain, stubMarker } from "@ostra/adapter-sdk/testing";
import type { Scenario } from "@ostra/adapter-sdk/testing";
import { blobIdSchema, repoIdSchema, taskCredentialsSchema } from "@ostra/protocol";
import type { TaskCredentials, TaskSpec, TaskSpecRepo } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, Shared } from "../testing/task-host-harness.ts";
import { startTokenMcpServer } from "../testing/token-mcp-server.ts";
import type { TokenMcpServer } from "../testing/token-mcp-server.ts";
import { defaultAgents } from "./agents.ts";

// The library's items on the agent the runner ships (F-145, ADR 0069, "Delivery: unchanged"; ticket
// 28): the real, pinned OpenCode on the host executor, with a scripted stub model behind the real
// key proxy. Core hands a library item over as it hands a profile's own: a skill as the task's blobs
// (its `SKILL.md` and its files, a script among them), and a remote MCP server as a path on the
// sidecar's MCP proxy, its address and secret header in the credentials. OpenCode's config names
// the proxy's path with `oauth: false` and no header, and searched for the header's value holds
// none; the call through the proxy carries it. A library skill and a repo's own of its name follow
// the repo-skills rule (ADR 0049, amended 2026-11-21): the profile's, the library's included, wins.

const TOKEN = "library-mcp-token-3c4d5e6f7a8b";
/** A registry entry's fixed header: no secret, and long enough to be searched for if it were one. */
const PLAIN_HEADER = "acme-client-v1";
const LF = String.fromCharCode(10);

const scenarios: Readonly<Record<string, Scenario>> = {
  /** Calls the tool the marker names (`<server>_<tool>`), then quotes what it answered. */
  "mcp-call": ({ step, args, lastToolResults }) => {
    if (step === 0) {
      return { toolCalls: [{ name: args, arguments: {} }] };
    }
    return step === 1 ? { text: `${args} answered: ${lastToolResults.map((result) => result.text).join(" | ")}` } : undefined;
  },
  /** Loads each skill OpenCode lists or its instructions name, and names each with its heading and its `Step:` line. */
  skills: ({ step, request, lastToolResults }) => {
    if (step === 0) {
      const listed = request.messages.map((message) => message.text).join(LF);
      const fromList = [...listed.matchAll(/<id>([^<]+)<\/id>/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1].trim()]));
      const fromInstructions = [...listed.matchAll(/`skill` tool, by its ID\): ([^\n]+)/g)].flatMap((match) =>
        [...(match[1] ?? "").matchAll(/`([^`]+)`/g)].flatMap((id) => (id[1] === undefined ? [] : [id[1]])),
      );
      const ids = [...new Set([...fromList, ...fromInstructions])];
      return ids.length === 0 ? { text: "no skills listed" } : { toolCalls: ids.map((id) => ({ name: "skill", arguments: { id } })) };
    }
    if (step === 1) {
      const loaded = lastToolResults.flatMap((result) => {
        const name = /<skill_content name="([^"]+)">/.exec(result.text)?.[1];
        const heading = result.text.split(LF).find((line) => line.startsWith("# ") && !line.startsWith("# Skill:"));
        const body = result.text.split(LF).find((line) => line.startsWith("Step: "));
        return name === undefined ? [] : [`${name} (${heading?.trim() ?? "no heading"}; ${body?.trim() ?? "no step"})`];
      });
      return { text: `skills: ${loaded.join(", ")}` };
    }
    return undefined;
  },
};

const skillFile = (name: string, heading: string, step: string): string => ["---", `name: ${name}`, `description: The ${name} skill`, "---", `# ${heading}`, "", `Step: ${step}`, ""].join(LF);

let shared: Shared;
let mcpServer: TokenMcpServer;
let harness: Harness | undefined;

beforeAll(async () => {
  shared = await startShared("library-items-opencode", { brain: createScenarioBrain(scenarios) });
  mcpServer = await startTokenMcpServer({ token: TOKEN, tool: "lookup" });
  // A repo set up with `npx skills add`, holding its own skill of the library skill's name.
  await shared.upstream.createRepo("ostra-test/library-skills", {
    "README.md": "# library skills" + LF,
    ".agents/skills/release-notes/SKILL.md": skillFile("release-notes", "The repo's release notes", "REPO-RELEASE-NOTES-MARKER"),
    ".agents/skills/repo-deploy/SKILL.md": skillFile("repo-deploy", "Repo deploy", "run the deploy script"),
  });
}, 60_000);

afterAll(async () => {
  await mcpServer.close();
  await shared.close();
}, 60_000);

afterEach(async () => {
  await harness?.close();
  harness = undefined;
}, 60_000);

const start = async (): Promise<Harness> => {
  harness = await startHarness(shared, { agents: defaultAgents() });
  return harness;
};

const messages = (h: Harness, spec: TaskSpec): string => h.ofKind(spec, "agent.message").map((event) => event.text).join(" ");

/** Every file under `dir`, as its path and text. */
const filesUnder = async (dir: string): Promise<readonly { readonly file: string; readonly text: string }[]> => {
  const out: { file: string; text: string }[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
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

const repo = (): TaskSpecRepo => {
  const [base] = taskSpecFixture.repos;
  if (base === undefined) {
    throw new Error("the fixture has a repo");
  }
  return { ...base, repoId: repoIdSchema.parse("0196f1a0-0000-7000-8000-0000000000af"), fullName: "ostra-test/library-skills", cloneUrl: "https://github.com/ostra-test/library-skills.git", checkoutDir: "library-skills" };
};

/** The credentials core sends for the library server: its fixed header named plain, and the secret one from the store. */
const acmeCredentials = (base: TaskCredentials): TaskCredentials =>
  taskCredentialsSchema.parse({
    ...base,
    mcpServers: [{ name: "acme-mcp", url: mcpServer.urlFor("acme-mcp"), headers: { "X-Acme-Client": PLAIN_HEADER, Authorization: `Bearer ${TOKEN}` }, plainHeaders: ["X-Acme-Client"] }],
  });

/** A task whose profile has the library server, with these variables in the repo's environment (each one set for the agent too). */
const serverTask = (h: Harness, variables: TaskSpec["environment"]["repos"][number]["variables"]): { readonly spec: TaskSpec } => {
  const made = h.taskFor(`${stubMarker("mcp-call", "acme-mcp_lookup")} Look it up.`, {
    agent: {
      ...taskSpecFixture.agent,
      adapter: "opencode",
      apiFormat: "anthropic-messages",
      endpointModelId: "stub-model",
      mcpServers: [{ name: "acme-mcp", transport: "http", proxyPath: "/mcp/acme-mcp", readOnly: false }],
    },
    environment: {
      ...taskSpecFixture.environment,
      setupScript: null,
      repos: taskSpecFixture.environment.repos.map((repo) => ({ ...repo, variables: [...repo.variables, ...variables] })),
    },
  });
  h.server.tasks.set(made.spec.taskId, { spec: made.spec, credentials: acmeCredentials(made.credentials) });
  return made;
};

const configSchema = z.looseObject({ mcp: z.looseObject({ servers: z.record(z.string(), z.looseObject({ type: z.string(), url: z.string(), oauth: z.unknown() })) }) });

describe("library items on OpenCode, with the stub models (F-145)", () => {
  it("F-145/c12: a library MCP server reaches OpenCode's config as a proxy path with oauth: false and no header, the config searched for the header's value, and its call through the proxy carries it", async () => {
    const h = await start();
    const made = h.taskFor(`${stubMarker("mcp-call", "acme-mcp_lookup")} Look it up.`, {
      agent: {
        ...taskSpecFixture.agent,
        adapter: "opencode",
        apiFormat: "anthropic-messages",
        endpointModelId: "stub-model",
        // As core's dispatch names a library server: a path on the proxy, not read-only until an admin marks it.
        mcpServers: [{ name: "acme-mcp", transport: "http", proxyPath: "/mcp/acme-mcp", readOnly: false }],
      },
      environment: { ...taskSpecFixture.environment, setupScript: null },
    });
    // As core's credentials carry it: the registry entry's fixed header, named plain, and the secret one from the store.
    const credentials = acmeCredentials(made.credentials);
    h.server.tasks.set(made.spec.taskId, { spec: made.spec, credentials });
    const before = mcpServer.requests.length;
    h.dispatch(made.spec);
    await h.waitForKind(made.spec, "session.saved", 1, 150_000);
    expect(messages(h, made.spec)).toContain("acme-mcp_lookup answered: acme-mcp ran lookup with its token");
    const reached = mcpServer.requests.slice(before);
    expect(reached.length).toBeGreaterThan(0);
    expect(reached.every((request) => request.path === "/mcp/acme-mcp" && request.authorized)).toBe(true);
    // OpenCode's own config: the proxy's path, no sign-in, no header.
    const launch = h.launches.at(-1);
    const config = launch?.files.find((file) => file.path.endsWith(path.join("opencode", "opencode.json")));
    if (config === undefined) throw new Error("OpenCode's config");
    const server = configSchema.parse(JSON.parse(config.content)).mcp.servers["acme-mcp"];
    expect(server).toEqual({ type: "remote", url: server?.url, oauth: false, codemode: false });
    // The sidecar's proxy on loopback, behind its per-task path, ending in the spec's proxy path.
    expect(server?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+\/mcp\/acme-mcp$/);
    expect(config.content).not.toContain(TOKEN);
    expect(config.content).not.toContain(mcpServer.urlFor("acme-mcp"));
    // Searched for the header's value: not in the launch, not anywhere under the agent's folder on disk, not in an event or a log line.
    expect(JSON.stringify(launch)).not.toContain(TOKEN);
    const agentDir = path.dirname(path.dirname(path.dirname(path.dirname(config.path))));
    expect((await filesUnder(agentDir)).filter((entry) => entry.text.includes(TOKEN)).map((entry) => entry.file)).toEqual([]);
    expect(JSON.stringify([h.eventsOf(made.spec), h.logs])).not.toContain(TOKEN);
  }, 300_000);

  it("F-145/c12: a library server's plain header whose value also sits in the agent's environment doesn't stop the session, and the call through the proxy still carries the secret one", async () => {
    const h = await start();
    const made = serverTask(h, [{ name: "ACME_CLIENT", value: PLAIN_HEADER, availableDuringSetup: false }]);
    h.dispatch(made.spec);
    await h.waitForKind(made.spec, "session.saved", 1, 150_000);
    expect(h.kinds(made.spec)).not.toContain("session.crashed");
    expect(h.launches.at(-1)?.env["ACME_CLIENT"]).toBe(PLAIN_HEADER);
    expect(messages(h, made.spec)).toContain("acme-mcp_lookup answered: acme-mcp ran lookup with its token");
    expect(JSON.stringify([h.launches, h.eventsOf(made.spec), h.logs])).not.toContain(TOKEN);
  }, 300_000);

  it("F-145/c12: a library server's secret header whose value would reach the agent's environment refuses the session before the agent starts, naming the variable and never the value", async () => {
    const h = await start();
    const made = serverTask(h, [
      { name: "ACME_CLIENT", value: PLAIN_HEADER, availableDuringSetup: false },
      { name: "ACME_AUTH", value: `Bearer ${TOKEN}`, availableDuringSetup: false },
    ]);
    h.dispatch(made.spec);
    await h.waitForKind(made.spec, "session.crashed", 1, 150_000);
    expect(h.ofKind(made.spec, "session.crashed")[0]?.error).toContain("the agent's environment held an MCP server's header (in ACME_AUTH): refused to start it");
    expect(h.launches).toHaveLength(0);
    expect(h.kinds(made.spec)).not.toContain("turn.started");
    expect(JSON.stringify([h.eventsOf(made.spec), h.logs])).not.toContain(TOKEN);
  }, 300_000);

  it("F-145/c12: a library skill reaches OpenCode from the task's agent folder, its files beside it, and wins over the repo's own skill of its name, which the runner logs by name only", async () => {
    const h = await start();
    const made = h.taskFor(`${stubMarker("skills")} List them.`, {
      repos: [repo()],
      agent: { ...taskSpecFixture.agent, adapter: "opencode", apiFormat: "anthropic-messages", endpointModelId: "stub-model" },
      environment: { ...taskSpecFixture.environment, setupScript: null },
    });
    // As core's dispatch copies a library skill: its SKILL.md and its files, each a blob of the task.
    const put = (text: string, type = "text/markdown") => blobIdSchema.parse(h.server.putBlob(made.spec.taskId, Buffer.from(text), type));
    const spec: TaskSpec = {
      ...made.spec,
      agent: {
        ...made.spec.agent,
        skills: [
          {
            name: "release-notes",
            blobId: put(skillFile("release-notes", "The library's release notes", "read reference.md, then run scripts/draft.sh")),
            files: [
              { path: "reference.md", blobId: put("# Reference" + LF + "Group the changes by area." + LF) },
              { path: "scripts/draft.sh", blobId: put("#!/bin/sh" + LF + "echo drafting" + LF, "application/octet-stream") },
            ],
          },
        ],
      },
    };
    h.server.tasks.set(spec.taskId, { spec, credentials: made.credentials });
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved", 1, 150_000);
    const said = messages(h, spec);
    expect(said).toContain("release-notes (# The library's release notes; Step: read reference.md, then run scripts/draft.sh)");
    expect(said).not.toContain("REPO-RELEASE-NOTES-MARKER");
    expect(said).toContain("repo-deploy (# Repo deploy; Step: run the deploy script)");
    expect(h.logs.filter((record) => record.message === "a repo's own skill is shadowed by the profile's").map((record) => record.fields["skill"])).toEqual(["release-notes"]);
    expect(JSON.stringify(h.logs)).not.toContain("REPO-RELEASE-NOTES-MARKER");
    // Its files sit beside its SKILL.md in the task's agent folder, never in the repo.
    const config = h.launches.at(-1)?.files.find((file) => file.path.endsWith(path.join("opencode", "opencode.json")));
    if (config === undefined) throw new Error("OpenCode's config");
    const agentDir = path.dirname(path.dirname(path.dirname(path.dirname(config.path))));
    const written = (await filesUnder(path.join(agentDir, "skills", "release-notes"))).map((entry) => path.relative(path.join(agentDir, "skills", "release-notes"), entry.file).split(path.sep).join("/"));
    expect(written.sort()).toEqual(["SKILL.md", "reference.md", "scripts/draft.sh"]);
    expect(h.ofKind(spec, "session.saved")[0]?.repos.map((saved) => saved.ahead)).toEqual([false]);
  }, 300_000);
});
