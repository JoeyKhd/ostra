import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { GitHubAdapter } from "@ostra/adapter-github";
import { clientMessageIdSchema, gitShaSchema, leaseEpochSchema, repoFullNameSchema, sessionIdSchema, taskCredentialsSchema } from "@ostra/protocol";
import type { TaskEvent, TaskSpec } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { manualTimers, startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness } from "../testing/task-host-harness.ts";
import { defaultAgents } from "./agents.ts";

// The gated live runs of tickets 22 and 24, with `model.env`, `github.env` and `github-test.env`
// loaded: OpenCode on the development endpoint, the real git proxy in front of `ostra-test/test1`
// with a one-repo App token. Four real turns on one session, each followed by a hidden ref on
// GitHub and an archive in the blob store (the fake server's, standing in for core's: ticket 39
// runs core's). Then a second runner, from another data folder, restores the session from the last
// archive and hidden ref, and answers spike 2's five questions about the earlier turns, as pending
// messages. The score is printed, never a token. The test branch and hidden ref are deleted after.

const live = z
  .object({
    OSTRA_DEV_MODEL_BASE_URL: z.url(),
    OSTRA_DEV_MODEL_API_KEY: z.string().min(1),
    OSTRA_DEV_MODEL_ID: z.string().min(1),
    GITHUB_APP_ID: z.string().min(1),
    GITHUB_APP_PRIVATE_KEY_PATH: z.string().min(1),
    GITHUB_APP_INSTALLATION_ID: z.string().min(1),
    GITHUB_TEST_ORG: z.string().min(1),
    GITHUB_TEST_REPO: z.string().min(1),
  })
  .safeParse(process.env);

const FROM_MEMORY = "Answer from what you remember of this task, in a few words, without running any tool.";

/** The agent's text in each turn of a session, in order. */
const turnTexts = (events: readonly TaskEvent[]): readonly string[] => {
  const turns: string[] = [];
  for (const event of events) {
    if (event.kind === "turn.started") {
      turns.push("");
    } else if (event.kind === "agent.message" && turns.length > 0) {
      turns[turns.length - 1] = `${turns.at(-1) ?? ""}${event.text}`;
    }
  }
  return turns;
};

describe.skipIf(!live.success)("sessions across turns and a restore, live on test1 with OpenCode", () => {
  it("saves the hidden ref and the archive after each real turn, and a second runner restores the session and answers about earlier turns", async () => {
    if (!live.success) {
      return;
    }
    const config = live.data;
    const fullName = repoFullNameSchema.parse(`${config.GITHUB_TEST_ORG}/${config.GITHUB_TEST_REPO}`);
    const github = new GitHubAdapter();
    const access = {
      app: { appId: config.GITHUB_APP_ID, privateKey: await readFile(config.GITHUB_APP_PRIVATE_KEY_PATH, "utf8") },
      installationId: config.GITHUB_APP_INSTALLATION_ID,
      repo: fullName,
    };
    const minted = await github.mintRepoToken(access, { contents: "write", metadata: "read" });
    if (!minted.ok) {
      throw new Error(`minting the repo token failed: ${minted.error.code}`);
    }
    const gitToken = minted.value.token;
    const api = (route: string, method = "GET"): Promise<Response> =>
      fetch(`https://api.github.com/repos/${fullName}/${route}`, {
        method,
        headers: { authorization: `Bearer ${gitToken}`, accept: "application/vnd.github+json", "user-agent": "ostra-live-test" },
      });
    const refOnGitHub = async (ref: string): Promise<string | null> => {
      const answer = await api(`git/ref/${ref}`);
      if (answer.status !== 200) {
        return null;
      }
      const body = z.object({ object: z.object({ sha: z.string() }) }).safeParse(await answer.json());
      return body.success ? body.data.object.sha : null;
    };

    const shared = await startShared("live-across-turns");
    const harnesses: Harness[] = [];
    const runner = async (): Promise<Harness> => {
      const harness = await startHarness(shared, { agents: defaultAgents(), host: { gitUpstreamUrl: (cloneUrl) => cloneUrl, timers: manualTimers() } });
      harnesses.push(harness);
      return harness;
    };
    const suffix = randomBytes(3).toString("hex");
    const facts = { codename: `osprey${suffix}`, doc: `docs/guide-${suffix}.md`, readmeWord: `howdy${suffix}`, printed: "", port: "" };
    const [baseRepo] = taskSpecFixture.repos;
    if (baseRepo === undefined) throw new Error("the fixture has a repo");
    let spec: TaskSpec | undefined;
    try {
      const first = await runner();
      const made = first.taskFor(`The codename for this task is ${facts.codename}. Please remember it. Create the file ${facts.doc} with one line: "# Guide". Then say done.`, {
        repos: [{ ...baseRepo, fullName, cloneUrl: `https://github.com/${fullName}.git` }],
        agent: { ...taskSpecFixture.agent, adapter: "opencode", apiFormat: "anthropic-messages", endpointModelId: config.OSTRA_DEV_MODEL_ID },
        limits: { turnMaxMinutes: 10, idleMinutes: 120 },
      });
      spec = made.spec;
      const credentials = (leaseEpoch: number): z.infer<typeof taskCredentialsSchema> =>
        taskCredentialsSchema.parse({
          ...made.credentials,
          leaseEpoch,
          model: { baseUrl: config.OSTRA_DEV_MODEL_BASE_URL, apiFormat: "anthropic-messages", authScheme: "x-api-key", token: config.OSTRA_DEV_MODEL_API_KEY },
          repos: made.spec.repos.map((repo) => ({ repoId: repo.repoId, gitToken, expiresAt: Date.now() + 50 * 60_000 })),
        });
      first.server.tasks.set(spec.taskId, { spec, credentials: credentials(spec.leaseEpoch) });
      first.dispatch(spec);
      const followUps = [
        `Run this command in a shell and tell me exactly what it printed: node -e "console.log('RESULT-'+(Date.now()%100000))"`,
        `Add a new last line to README.md that is just the word ${facts.readmeWord}.`,
        `We will need a dev server port. Pick one port between 4000 and 4999 and tell me your choice in the form "use port NNNN".`,
      ];
      const hiddenRef = `ostra/wip/${spec.taskId}`;
      for (let turn = 1; turn <= followUps.length + 1; turn += 1) {
        await first.gateway.waitFor(() => first.kinds(spec ?? made.spec).filter((kind) => kind === "session.saved").length >= turn || first.kinds(spec ?? made.spec).includes("session.crashed"), 600_000);
        expect(first.kinds(spec), "the session didn't crash").not.toContain("session.crashed");
        const saved = first.ofKind(spec, "session.saved")[turn - 1];
        // ticket 22: after each real turn, the hidden ref on GitHub and the archive in the blob store.
        expect(saved?.repos[0]?.hiddenRefSha, `turn ${String(turn)}'s hidden ref`).toMatch(/^[0-9a-f]{40}$/);
        expect(await refOnGitHub(hiddenRef)).toBe(saved?.repos[0]?.hiddenRefSha);
        const archive = saved?.archive ?? null;
        expect(archive, `turn ${String(turn)}'s archive`).not.toBeNull();
        expect(archive === null ? undefined : first.server.blobs.get(archive.blobId)?.sha256).toBe(archive?.sha256);
        const next = followUps[turn - 1];
        if (next !== undefined) {
          first.steer(spec, next);
        }
      }
      const texts = turnTexts(first.eventsOf(spec));
      facts.printed = /RESULT-(\d{1,6})\b/.exec(texts[1] ?? "")?.[1] ?? "";
      facts.port = /use port (4\d{3})/i.exec(texts[3] ?? "")?.[1] ?? "";
      const last = first.ofKind(spec, "session.saved").at(-1);
      const repo = last?.repos[0];
      if (last?.archive === null || last === undefined || repo?.hiddenRefSha === null || repo?.headSha === null || repo === undefined) {
        throw new Error("the last save has no archive or hidden ref");
      }
      console.info("live across turns:", JSON.stringify({ turns: texts.length, archiveBytes: last.archive.size, factsFound: { printed: facts.printed !== "", port: facts.port !== "" } }));

      // ticket 24: a second runner, from another data folder, restores the session on a fresh box.
      const second = await runner();
      const blob = first.server.blobs.get(last.archive.blobId);
      if (blob === undefined) throw new Error("no archive blob");
      second.server.putBlob(spec.taskId, blob.bytes, blob.contentType, last.archive.blobId);
      const questions = [
        { text: `What is the codename for this task that I told you at the start? ${FROM_MEMORY}`, expected: facts.codename },
        { text: `Which file did you create under docs/ earlier? Give its path. ${FROM_MEMORY}`, expected: facts.doc },
        { text: `Earlier you ran a node command that printed RESULT- followed by a number. What was the number? ${FROM_MEMORY}`, expected: facts.printed },
        { text: `Which word did I ask you to add to README.md? ${FROM_MEMORY}`, expected: facts.readmeWord },
        { text: `Which port did you pick for the dev server? ${FROM_MEMORY}`, expected: facts.port },
      ];
      const reopened: TaskSpec = {
        ...spec,
        sessionId: sessionIdSchema.parse(`${spec.sessionId}-restored`),
        leaseEpoch: leaseEpochSchema.parse(spec.leaseEpoch + 1),
        restore: {
          origin: "restored",
          archive: last.archive,
          hiddenRefs: [{ repoId: repo.repoId, sha: gitShaSchema.parse(repo.hiddenRefSha), baseSha: gitShaSchema.parse(repo.headSha) }],
          pendingMessages: questions.map((question, index) => ({ clientMessageId: clientMessageIdSchema.parse(`live-question-${String(index + 1)}`), text: question.text })),
        },
      };
      second.server.tasks.set(spec.taskId, { spec: reopened, credentials: credentials(reopened.leaseEpoch) });
      second.dispatch(reopened);
      await second.gateway.waitFor(
        () => second.kinds(reopened).filter((kind) => kind === "session.saved").length >= questions.length || second.kinds(reopened).includes("session.crashed"),
        1_200_000,
      );
      const [restored] = second.ofKind(reopened, "session.restored");
      expect(restored).toMatchObject({ origin: "restored", hiddenRef: "applied" });
      const answers = turnTexts(second.eventsOf(reopened));
      const score = questions.map((question, index) => question.expected !== "" && (answers[index] ?? "").toLowerCase().includes(question.expected.toLowerCase()));
      console.info("live restore score:", JSON.stringify({ correct: score.filter(Boolean).length, of: questions.length, each: score, replayedUpdates: restored?.replayedUpdates ?? null }));
      expect(score.filter(Boolean).length).toBeGreaterThanOrEqual(4);
      // Nothing secret in what the runners sent or logged.
      const everything = JSON.stringify([first.eventsOf(spec), second.eventsOf(reopened), first.logs, second.logs]);
      for (const secret of [gitToken, config.OSTRA_DEV_MODEL_API_KEY]) {
        expect(everything.includes(secret)).toBe(false);
      }
    } finally {
      for (const harness of harnesses) {
        await harness.close().catch(() => undefined);
      }
      if (spec !== undefined) {
        await api(`git/refs/heads/${spec.branchName}`, "DELETE").catch(() => undefined);
        await api(`git/refs/ostra/wip/${spec.taskId}`, "DELETE").catch(() => undefined);
      }
      await shared.close();
    }
  }, 2_400_000);
});
