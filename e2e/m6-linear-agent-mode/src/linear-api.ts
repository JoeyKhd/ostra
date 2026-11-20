import { postThreadReply } from "@ostra/adapter-linear";
import { z } from "zod";

// The harness's side of Linear (ticket 38): what a person or the admin's key does there, and what
// the harness reads back. The same GraphQL calls go to real Linear and to the fake Linear server
// (ticket 02), which answers them as Linear does. The personal key creates and archives the
// tickets, reads who the admin is, and posts the follow-up as a thread reply; the app's token reads
// each session's status. Neither token reaches a log line, a message or an error.

const LINEAR_API_URL = "https://api.linear.app/graphql";

export type LinearAccess = {
  readonly apiUrl: string;
  /** The admin's personal API key (`LINEAR_API_KEY`). */
  readonly apiKey: string;
  /** The app's own access token, from the refresh. */
  readonly appToken: string;
  readonly teamId: string;
};

export const linearApiUrl = (env: Readonly<Record<string, string | undefined>>): string => env["OSTRA_HARNESS_LINEAR_API_URL"] ?? LINEAR_API_URL;

const answerSchema = z.looseObject({ data: z.unknown().optional(), errors: z.array(z.unknown()).nullish() });

/** One GraphQL call. A personal key goes bare in `authorization`, an OAuth token as `Bearer`. */
const call = async <T,>(access: LinearAccess, as: "key" | "app", query: string, variables: Readonly<Record<string, unknown>>, schema: z.ZodType<T>): Promise<T> => {
  const response = await fetch(access.apiUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "ostra-agent-mode-harness", authorization: as === "key" ? access.apiKey : `Bearer ${access.appToken}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = answerSchema.safeParse(await response.json().catch(() => null));
  if (!response.ok || !body.success || (body.data.errors?.length ?? 0) > 0) {
    // The status only: an answer may quote the request.
    throw new Error(`Linear answered ${String(response.status)}${body.success && (body.data.errors?.length ?? 0) > 0 ? " with errors" : ""}`);
  }
  return schema.parse(body.data.data);
};

export type AdminUser = { readonly id: string; readonly email: string; readonly name: string };

export const readAdmin = (access: LinearAccess): Promise<AdminUser> =>
  call(access, "key", "query OstraHarnessAdmin { viewer { id email name } }", {}, z.looseObject({ viewer: z.looseObject({ id: z.string(), email: z.string(), name: z.string() }) })).then((data) => data.viewer);

export type DelegatedIssue = { readonly issueId: string; readonly identifier: string; readonly answeredAt: number };

/** Creates a ticket, delegated to the app unless `delegateId` is null, as the key's user; `answeredAt` is when the call answered, on this machine's clock. */
export const createDelegatedIssue = async (access: LinearAccess, input: { readonly title: string; readonly description: string; readonly delegateId: string | null }): Promise<DelegatedIssue> => {
  const data = await call(
    access,
    "key",
    "mutation OstraHarnessDelegate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }",
    { input: { teamId: access.teamId, title: input.title, description: input.description, ...(input.delegateId === null ? {} : { delegateId: input.delegateId }) } },
    z.looseObject({ issueCreate: z.looseObject({ success: z.boolean(), issue: z.looseObject({ id: z.string(), identifier: z.string() }).nullish() }) }),
  );
  const answeredAt = Date.now();
  if (!data.issueCreate.success || data.issueCreate.issue === null || data.issueCreate.issue === undefined) {
    throw new Error("Linear didn't create the ticket");
  }
  return { issueId: data.issueCreate.issue.id, identifier: data.issueCreate.issue.identifier, answeredAt };
};

/** The session's status as Linear shows it (`active`, `pending`, `stale`, `error`, `complete`...), read with the app's token. */
export const readSessionStatus = async (access: LinearAccess, sessionId: string): Promise<string> => {
  try {
    const data = await call(access, "app", "query OstraHarnessSession($id: String!) { agentSession(id: $id) { id status } }", { id: sessionId }, z.looseObject({ agentSession: z.looseObject({ status: z.string() }) }));
    return data.agentSession.status;
  } catch {
    return "unreadable";
  }
};

/** A follow-up as a person writes one: a reply in the session's thread, by the key's user. */
export const replyInThread = async (access: LinearAccess, sessionId: string, body: string): Promise<boolean> =>
  (await postThreadReply({ apiUrl: access.apiUrl, apiKey: access.apiKey, sessionId, body })).ok;

/** Archives the tickets the run made. */
export const archiveIssues = async (access: LinearAccess, issueIds: readonly string[]): Promise<number> => {
  let archived = 0;
  for (const id of issueIds) {
    const done = await call(access, "key", "mutation OstraHarnessArchive($id: String!) { issueArchive(id: $id) { success } }", { id }, z.looseObject({ issueArchive: z.looseObject({ success: z.boolean() }) })).then(
      (data) => data.issueArchive.success,
      () => false,
    );
    if (done) archived += 1;
  }
  return archived;
};

export type TeamRead = { readonly id: string; readonly key: string; readonly name: string; readonly states: readonly { readonly id: string; readonly name: string; readonly type: string }[] };

/** The test team and its workflow states, for the board's status map. */
export const readTeam = async (access: LinearAccess): Promise<TeamRead> => {
  const data = await call(
    access,
    "key",
    "query OstraHarnessTeam($id: String!) { team(id: $id) { id key name states { nodes { id name type } } } }",
    { id: access.teamId },
    z.looseObject({ team: z.looseObject({ id: z.string(), key: z.string(), name: z.string(), states: z.looseObject({ nodes: z.array(z.looseObject({ id: z.string(), name: z.string(), type: z.string() })) }) }) }),
  );
  return { id: data.team.id, key: data.team.key, name: data.team.name, states: data.team.states.nodes };
};

/**
 * A mention of the app in a comment on the ticket, by the key's user: Linear starts a session that
 * hangs from that comment, so a reply in its thread is a follow-up. A delegation's session hangs from
 * no comment, and has no thread to reply in.
 */
export const mentionApp = async (access: LinearAccess, issueId: string, appUserId: string): Promise<void> => {
  const user = await call(access, "key", "query OstraHarnessAppUser($id: String!) { user(id: $id) { id name url } }", { id: appUserId }, z.looseObject({ user: z.looseObject({ name: z.string(), url: z.string() }) }));
  await call(
    access,
    "key",
    "mutation OstraHarnessMention($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
    { input: { issueId, body: `[@${user.user.name}](${user.user.url}) please take this one. (ostra agent-mode harness)` } },
    z.looseObject({ commentCreate: z.looseObject({ success: z.boolean() }) }),
  );
};
