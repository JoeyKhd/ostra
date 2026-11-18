// The pass bar's fallback: "If it fails: try OpenCode's HTTP API for the
// capability that failed." On plain ACP, T5's `plan` and T7's `reject and
// continue` fail. This case tries both on `opencode serve`, with the same
// stub scripts, the same task config and the same fake key.
//   T7-http: once, then reject (bare, and with a message) through
//            `POST /api/session/{id}/permission/{requestID}/reply`.
//   T5-http: does the API have a plan or todo surface at all (its own
//            OpenAPI spec), and where does a todo list show up.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { stubMarker } from "../lib/stub-models/scenario.ts";
import type { PermissionRule } from "../lib/opencode.ts";
import { errorMessage, stubCallsFor, withTask, type CaseContext, type Task } from "../harness/fixture.ts";
import { createServeSession, isSessionActive, startServe, until, type Serve } from "../harness/opencode-serve.ts";
import { check, fail, type Check, type Criterion } from "../harness/report.ts";

const ASK_EDITS: readonly PermissionRule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "ask" },
];

const permissionList = z.looseObject({ data: z.array(z.looseObject({ id: z.string().regex(/^per_[A-Za-z0-9]+$/) })) });

const sessionInfo = z.looseObject({ data: z.looseObject({ outcome: z.string().optional() }) });

const pendingIds = async (serve: Serve, sessionId: string): Promise<string[]> => {
  const response = await serve.call("GET", `/api/session/${encodeURIComponent(sessionId)}/permission`);
  const parsed = permissionList.safeParse(response.body);
  return parsed.success ? parsed.data.data.map((p) => p.id) : [];
};

type RejectRun = { readonly continued: boolean; readonly notesUnchanged: boolean; readonly replies: readonly string[]; readonly outcome: string; readonly requests: number };

/** One permission-pair turn over HTTP: approve the first edit, reject the second. */
const rejectOverHttp = async (ctx: CaseContext, task: Task, serve: Serve, rejectMessage: string | undefined): Promise<RejectRun> => {
  const sessionId = await createServeSession(serve, task);
  const from = Date.now();
  const notesBefore = await readFile(path.join(task.dirs.workspace, "notes.txt"), "utf8");
  await serve.call("POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, { text: `${stubMarker("permission-pair")} edit two files` });
  const replies: string[] = [];
  const answered = new Set<string>();
  const decisions = ["once", "reject"] as const;
  for (const decision of decisions) {
    let next: string | undefined;
    await until(`permission request for ${decision}`, 60_000, async () => {
      next = (await pendingIds(serve, sessionId)).find((id) => !answered.has(id));
      return next !== undefined;
    });
    if (next === undefined) break;
    answered.add(next);
    const body = decision === "reject" && rejectMessage !== undefined ? { decision, message: rejectMessage } : { decision };
    const reply = await serve.call("POST", `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(next)}/reply`, body);
    replies.push(`${decision}: ${String(reply.status)}`);
  }
  // Done when the session is no longer active.
  await until("the session to go idle", 60_000, async () => !(await isSessionActive(serve, sessionId)));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const info = sessionInfo.safeParse((await serve.call("GET", `/api/session/${encodeURIComponent(sessionId)}`)).body);
  const continued = stubCallsFor(ctx, task, "openai").some((c) => c.at >= from && (c.reply?.text ?? "").startsWith("continued after reject"));
  const notesAfter = await readFile(path.join(task.dirs.workspace, "notes.txt"), "utf8");
  return {
    continued,
    notesUnchanged: notesAfter === notesBefore,
    replies,
    outcome: info.success ? (info.data.data.outcome ?? "none") : "unknown",
    requests: answered.size,
  };
};

const describe = (run: RejectRun): string =>
  `${String(run.requests)} requests; replies ${run.replies.join(", ")}; notes.txt ${run.notesUnchanged ? "unchanged" : "EDITED"}; the model was called again after the reject: ${run.continued ? "yes" : "no"}; session outcome ${run.outcome}`;

const openApi = z.looseObject({ paths: z.record(z.string(), z.unknown()) });

export const httpFallback = async (ctx: CaseContext): Promise<Criterion[]> => {
  const t7: Check[] = [];
  const t7Recorded: Record<string, string> = {};
  const t5: Check[] = [];
  const t5Recorded: Record<string, string> = {};

  // T7 over HTTP: reject and continue.
  try {
    await withTask(ctx, { name: "t7-http", upstream: { kind: "stub", format: "openai" }, permissions: ASK_EDITS }, async (task) => {
      await task.driver.stop();
      const serve = await startServe(task);
      try {
        const bare = await rejectOverHttp(ctx, task, serve, undefined);
        t7Recorded["reject without a message"] = describe(bare);
        const withMessage = await rejectOverHttp(ctx, task, serve, "The member rejected this edit. Leave notes.txt alone and finish the rest.");
        t7Recorded["reject with a message"] = describe(withMessage);
        const ok = (run: RejectRun): boolean => run.requests === 2 && run.notesUnchanged && run.continued;
        t7.push(
          check(
            "over OpenCode's HTTP API, reject fails the tool and the agent continues",
            ok(bare) || ok(withMessage),
            ok(bare) ? `a bare reject continues: ${describe(bare)}` : ok(withMessage) ? `only a reject with a message continues: ${describe(withMessage)}` : `neither a bare reject nor one with a message continues the turn`,
          ),
        );
      } finally {
        await serve.close();
      }
    });
  } catch (error) {
    t7.push(fail("over OpenCode's HTTP API, reject fails the tool and the agent continues", errorMessage(error)));
  }

  // T5 over HTTP: is there a plan?
  try {
    await withTask(ctx, { name: "t5-http", upstream: { kind: "stub", format: "openai" }, experimental: { todo: true } }, async (task) => {
      await task.driver.stop();
      const serve = await startServe(task);
      try {
        const spec = await fetch(`${serve.base}/openapi.json`, { headers: serve.headers, signal: AbortSignal.timeout(15_000) });
        const specText = await spec.text();
        const raw: unknown = JSON.parse(specText);
        const paths = Object.keys(openApi.parse(raw).paths);
        const planRoutes = paths.filter((p) => /todo|plan/i.test(p));
        const planEvents = [...new Set(specText.match(/"[a-z-]+(\.[a-z-]+)*\.(todo|plan)[a-z.-]*"|"(todo|plan)\.[a-z.-]+"/g) ?? [])];
        t5Recorded["OpenAPI spec"] = `${String(paths.length)} paths; plan or todo routes: ${planRoutes.length === 0 ? "none" : planRoutes.join(", ")}; plan or todo event types: ${planEvents.length === 0 ? "none" : planEvents.join(", ")}`;

        const sessionId = await createServeSession(serve, task);
        await serve.call("POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, { text: `${stubMarker("todo")} plan the work` });
        await until("the todo turn's first model call", 60_000, () => ctx.modelSide.stubs.openai.calls.some((c) => c.at >= task.createdAt));
        await until("the session to go idle", 60_000, async () => !(await isSessionActive(serve, sessionId)));
        const messages = await serve.call("GET", `/api/session/${encodeURIComponent(sessionId)}/message`);
        const text = JSON.stringify(messages.body ?? null);
        const todoInMessages = text.includes("Read README.md") && text.includes("in_progress");
        t5Recorded["todo list in session.message.list"] = todoInMessages ? "yes, inside the todowrite tool call's input and output" : "no";
        t5.push(
          check(
            "over OpenCode's HTTP API, a plan arrives (a plan or todo route or event)",
            planRoutes.length > 0 || planEvents.length > 0,
            planRoutes.length > 0 || planEvents.length > 0
              ? `the spec has ${[...planRoutes, ...planEvents].join(", ")}`
              : `the API has no plan or todo route or event (${String(paths.length)} paths); the todo list ${todoInMessages ? "is readable only as the todowrite tool call in session.message.list, as over ACP" : "was not found in session.message.list either"}`,
          ),
        );
      } finally {
        await serve.close();
      }
    });
  } catch (error) {
    t5.push(fail("over OpenCode's HTTP API, a plan arrives", errorMessage(error)));
  }

  return [
    { id: "T7-HTTP", title: "Fallback for T7: reject and continue, over OpenCode's HTTP API.", checks: t7, recorded: t7Recorded },
    { id: "T5-HTTP", title: "Fallback for T5: a plan, over OpenCode's HTTP API.", checks: t5, recorded: t5Recorded },
  ];
};
