import type { Tx } from "@ostra/db";
import { taskEventSchema, typedToolSchemas } from "@ostra/protocol";
import type { TaskId } from "@ostra/protocol";

import type { RebuildInput } from "../tickets/rebuild-template.ts";

// The rebuild template's input, read from ostra's own tables (ticket 18, ADR 0039 step 3): the
// ticket and the PRs, every member message and every agent message oldest first, the interrupted
// turn's text, each branch's pushes and the files the agent's edits changed (paths and line counts,
// never a tool's output), and whether unfinished work is saved to restore. ostra makes no model
// call. The messages a reopen sends as pending messages are left out, so none is said twice.

/** The turn stop reasons that mean the turn didn't finish. */
const INTERRUPTED_STOPS: ReadonlySet<string> = new Set(["failed", "cancelled"]);

/** How many files a branch's line lists before it says how many more. */
const FILES_LISTED = 200;

export const rebuildInputInTx = async (
  tx: Tx,
  taskId: TaskId,
  options: { readonly leaveOut: ReadonlySet<string> },
): Promise<RebuildInput> => {
  const task = await tx.task.findUniqueOrThrow({ where: { id: taskId }, select: { ticketId: true, title: true, organizationId: true } });
  const ticket = task.ticketId === null ? null : await tx.ticket.findUnique({ where: { id: task.ticketId }, select: { key: true, title: true, description: true } });
  const repos = await tx.taskRepo.findMany({ where: { taskId }, include: { repo: { select: { fullName: true, checkoutDir: true } } }, orderBy: { createdAt: "asc" } });

  const events = await tx.event.findMany({
    where: { taskId, kind: { in: ["user.message", "agent.message", "tool.called", "tool.completed", "git.pushed"] } },
    orderBy: { seq: "asc" },
    select: { seq: true, payload: true, occurredAt: true },
  });
  // The last turn, when it didn't finish: its text is the interrupted turn's, not a finished message.
  const last = await tx.turn.findFirst({ where: { taskId }, orderBy: { startSeq: "desc" }, select: { startSeq: true, endedAt: true, stopReason: true } });
  const interruptedFrom = last !== null && (last.endedAt === null || (last.stopReason !== null && INTERRUPTED_STOPS.has(last.stopReason))) ? last.startSeq : null;

  const memberIds = new Set<string>();
  const members: { readonly at: number; readonly memberId: string; readonly text: string }[] = [];
  const agents: { readonly at: number; readonly text: string }[] = [];
  const partial: string[] = [];
  const editCalls = new Set<string>();
  const changed = new Map<string, { added: number; removed: number }>();
  const pushes = new Map<string, string[]>();
  const seenMessages = new Set<string>();
  for (const row of events) {
    const parsed = taskEventSchema.safeParse(row.payload);
    if (!parsed.success) {
      continue;
    }
    const event = parsed.data;
    const at = row.occurredAt.getTime();
    // The query reads only these five kinds.
    if (event.kind === "user.message") {
      if (!options.leaveOut.has(event.clientMessageId) && !seenMessages.has(event.clientMessageId)) {
        seenMessages.add(event.clientMessageId);
        memberIds.add(event.memberId);
        members.push({ at, memberId: event.memberId, text: event.text });
      }
    } else if (event.kind === "agent.message" && event.subagentId === undefined) {
      // F-138: a subagent's answer was the agent's input, not a message of its own to the member.
      if (interruptedFrom !== null && row.seq > interruptedFrom) {
        partial.push(event.text);
      } else {
        agents.push({ at, text: event.text });
      }
    } else if (event.kind === "tool.called") {
      if (event.toolKind === "edit") {
        editCalls.add(event.toolCallId);
      }
    } else if (event.kind === "tool.completed") {
      if (editCalls.has(event.toolCallId)) {
        // Only the paths and the line counts: the patch and any output stay out (ADR 0039).
        const output = typedToolSchemas.edit.output.safeParse(event.output);
        for (const file of output.success ? output.data.files : []) {
          const sum = changed.get(file.path) ?? { added: 0, removed: 0 };
          changed.set(file.path, { added: sum.added + file.added, removed: sum.removed + file.removed });
        }
      }
    } else if (event.kind === "git.pushed" && event.ref === `refs/heads/${event.branch}`) {
      pushes.set(event.repoId, [...(pushes.get(event.repoId) ?? []), event.headSha]);
    }
  }

  const names = new Map(
    (await tx.member.findMany({ where: { id: { in: [...memberIds] }, organizationId: task.organizationId }, select: { id: true, user: { select: { name: true } } } })).map(
      (member) => [member.id, member.user.name] as const,
    ),
  );
  const filesOf = (checkoutDir: string, only: boolean): string[] =>
    [...changed]
      .filter(([path]) => only || path === checkoutDir || path.startsWith(`${checkoutDir}/`) || path.includes(`/${checkoutDir}/`))
      .map(([path, sum]) => ` ${path} | +${String(sum.added)} -${String(sum.removed)}`);

  return {
    ticket: ticket === null ? null : { key: ticket.key, title: ticket.title, description: ticket.description },
    pullRequests: repos
      .filter((repo) => repo.prNumber !== null)
      .map((repo) => ({ repo: repo.repo.fullName, title: repo.prTitle ?? task.title, body: repo.prBody ?? "" })),
    memberMessages: members.map((message) => ({ at: message.at, author: names.get(message.memberId) ?? "A member", text: message.text })),
    agentMessages: agents,
    interruptedTurn: interruptedFrom === null ? null : { partialText: partial.join("\n\n") },
    branches: repos.map((repo) => {
      const heads = pushes.get(repo.repoId) ?? [];
      const files = filesOf(repo.repo.checkoutDir, repos.length === 1);
      const lines = [
        ...(heads.length === 0 ? [] : [`pushed: ${heads.join(", ")}`]),
        ...(files.length === 0 ? [] : ["files the agent changed:", ...files.slice(0, FILES_LISTED)]),
        ...(files.length > FILES_LISTED ? [`(and ${String(files.length - FILES_LISTED)} more files)`] : []),
      ];
      return { repo: repo.repo.fullName, branch: repo.branchName, log: lines.join("\n") };
    }),
    unfinishedWork: repos.some((repo) => repo.hiddenRefSha !== null && repo.hiddenRefBaseSha !== null) ? "restored" : "none",
  };
};
