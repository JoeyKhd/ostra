import { z } from "zod";

// Ported from spikes/linear-agent-mode/src/thread-reply.ts, for agent mode's harness (ticket 38):
// a person's follow-up, automated. A follow-up in Linear is a reply in the agent session's thread,
// which Linear turns into an `AgentSessionEvent` `prompted`. This posts that reply through the API
// as the owner of a personal API key (the test workspace's admin): it looks up the comment the
// session hangs from, and replies to it. Nothing in the product calls it.
//
// A stop can't be sent this way: `agentActivityCreate` with a personal key is refused (403, "Using
// an unexpected authentication method (apiKey) for an operation"), for a prompt and a stop alike.
// The key goes in one header and nowhere else; the reply's text is never logged.

const THREAD_DOCUMENT = "query OstraSessionThread($id: String!) { agentSession(id: $id) { id comment { id } issue { id } } }";
const REPLY_DOCUMENT =
  "mutation OstraThreadReply($issueId: String!, $body: String!, $parentId: String!) { commentCreate(input: { issueId: $issueId, body: $body, parentId: $parentId }) { success comment { id } } }";

// Linear owns these formats: unknown fields are tolerated. `comment` is null for a session no comment started.
const threadSchema = z.looseObject({
  data: z
    .looseObject({
      agentSession: z.looseObject({
        id: z.string().min(1),
        comment: z.looseObject({ id: z.string().min(1) }).nullish(),
        issue: z.looseObject({ id: z.string().min(1) }).nullish(),
      }),
    })
    .nullish(),
});
const replySchema = z.looseObject({
  data: z
    .looseObject({ commentCreate: z.looseObject({ success: z.boolean(), comment: z.looseObject({ id: z.string().min(1) }).nullish() }) })
    .nullish(),
});

export type ThreadReplyInput = {
  readonly apiUrl: string;
  /** A personal API key: the reply is posted as its owner. */
  readonly apiKey: string;
  readonly sessionId: string;
  readonly body: string;
  readonly timeoutMs?: number;
};

export type ThreadReplyResult =
  | { readonly ok: true; readonly commentId: string }
  /** `no-thread`: the session hangs from no comment. `refused`: Linear said no. `failed`: try again. */
  | { readonly ok: false; readonly reason: "no-thread" | "refused" | "failed" };

const post = async (input: ThreadReplyInput, query: string, variables: Readonly<Record<string, unknown>>): Promise<{ readonly status: number; readonly body: unknown } | null> => {
  try {
    const response = await fetch(input.apiUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "ostra-linear-adapter", authorization: input.apiKey },
      body: JSON.stringify({ query, variables }),
      redirect: "manual",
      signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  } catch {
    return null;
  }
};

const failure = (status: number | null): ThreadReplyResult => ({ ok: false, reason: status === null || status >= 500 || status === 429 ? "failed" : "refused" });

/** Looks up the session's comment and issue, then posts `body` as a reply in that thread. Never throws for a Linear error. */
export const postThreadReply = async (input: ThreadReplyInput): Promise<ThreadReplyResult> => {
  const thread = await post(input, THREAD_DOCUMENT, { id: input.sessionId });
  if (thread === null) return failure(null);
  const found = threadSchema.safeParse(thread.body);
  const session = found.success ? found.data.data?.agentSession : undefined;
  if (thread.status !== 200 || session === undefined) return failure(thread.status === 200 ? 400 : thread.status);
  if (session.comment === null || session.comment === undefined || session.issue === null || session.issue === undefined) {
    return { ok: false, reason: "no-thread" };
  }
  const reply = await post(input, REPLY_DOCUMENT, { issueId: session.issue.id, body: input.body, parentId: session.comment.id });
  if (reply === null) return failure(null);
  const made = replySchema.safeParse(reply.body);
  const created = made.success ? made.data.data?.commentCreate : undefined;
  if (reply.status !== 200 || created === undefined) return failure(reply.status === 200 ? 400 : reply.status);
  return created.success && created.comment !== null && created.comment !== undefined ? { ok: true, commentId: created.comment.id } : { ok: false, reason: "refused" };
};
