import { LinearClient } from "@linear/sdk";
import { z } from "zod";
import { classifyFailure } from "./linear-api.ts";
import type { AgentSessionId } from "./ids.ts";

// A follow-up, automated. A person's follow-up in Linear is a reply in the agent session's thread, and Linear turns
// it into an `AgentSessionEvent` with action `prompted`. This posts that reply through the API, as the owner of a
// personal API key (the test workspace's admin), by looking up the comment the session hangs from and replying to it.
//
// A stop cannot be sent this way: `agentActivityCreate` with a personal key is refused (403 FORBIDDEN, "Using an
// unexpected authentication method (apiKey) for an operation"), for a prompt and for `signal: stop` alike.

const THREAD_DOCUMENT = `query OstraSessionThread($id: String!) { agentSession(id: $id) { id comment { id } issue { id identifier } } }`;

const REPLY_DOCUMENT = `mutation OstraThreadReply($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }`;

// Vendor-owned format: unknown fields are tolerated. `comment` is null for a session that no comment started.
const threadSchema = z.object({
  agentSession: z.object({
    id: z.string().min(1),
    comment: z.object({ id: z.string().min(1) }).nullable(),
    issue: z.object({ id: z.string().min(1), identifier: z.string().min(1) }).nullable(),
  }),
});

const replySchema = z.object({ commentCreate: z.object({ success: z.boolean(), comment: z.object({ id: z.string().min(1) }).nullable() }) });

export type ReplyInput = {
  readonly apiUrl: string;
  /** A personal API key. The reply is posted as its owner. */
  readonly apiKey: string;
  readonly sessionId: AgentSessionId;
  readonly body: string;
};

export type ReplyResult =
  | { readonly ok: true; readonly commentId: string }
  | { readonly ok: false; readonly reason: "no-thread" | "refused" | "failed" };

/** Looks up the session's comment and issue, then posts `body` as a reply in that thread. Never throws for a Linear error. */
export const postThreadReply = async (input: ReplyInput): Promise<ReplyResult> => {
  const client = new LinearClient({ apiKey: input.apiKey, apiUrl: input.apiUrl });
  try {
    const thread = threadSchema.parse(await client.client.request(THREAD_DOCUMENT, { id: input.sessionId })).agentSession;
    if (thread.comment === null || thread.issue === null) return { ok: false, reason: "no-thread" };
    const reply = replySchema.parse(await client.client.request(REPLY_DOCUMENT, { input: { issueId: thread.issue.id, body: input.body, parentId: thread.comment.id } }));
    return reply.commentCreate.success && reply.commentCreate.comment !== null ? { ok: true, commentId: reply.commentCreate.comment.id } : { ok: false, reason: "refused" };
  } catch (error: unknown) {
    // Which request failed is not needed here, only whether trying again could help; the caller falls back to a person.
    return { ok: false, reason: classifyFailure(error).kind === "permanent" ? "refused" : "failed" };
  }
};
