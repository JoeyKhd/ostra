import type { Db, Tx } from "@ostra/db";
import type { MemberId, OrganizationId, ProjectId, RepoId, TaskEvent, TaskId } from "@ostra/protocol";
import { memberIdSchema, projectIdSchema, repoIdSchema, taskEventSchema, taskIdSchema } from "@ostra/protocol";

import type { SearchEntryInput, WriteSearchEntries } from "../use-cases/m4-signatures.ts";

// Search entries (F-080, ADR 0054; milestone 4, ticket 11): one row per searchable piece of a task,
// written in the transaction that stores the piece, so a result is never ahead of or behind the
// thread. The title, prompt and ticket at the task's creation; each member message, agent message
// and tool call's title and input (the command and its folder, the paths, the URL); a PR's title.
// Never a thought, a tool's output or partial text. Text is cut at `OSTRA_SEARCH_ENTRY_MAX_KIB`
// (8 KiB, the column's own limit), with the cut marked. No entry's text is ever logged.

/** The column's limit (`search_entry.text`, 8192 characters), and the setting's default. */
export const SEARCH_ENTRY_MAX_BYTES = 8 * 1024;

/** What ends a cut text: the reader sees that more was there. */
export const SEARCH_CUT_MARK = " […]";

/**
 * The text, at most `maxBytes` bytes of UTF-8 and as many characters, cut at a character boundary
 * and marked when it was cut.
 */
export const cutSearchText = (text: string, maxBytes: number = SEARCH_ENTRY_MAX_BYTES): string => {
  const limit = Math.min(maxBytes, SEARCH_ENTRY_MAX_BYTES);
  if (Buffer.byteLength(text, "utf8") <= limit && text.length <= limit) {
    return text;
  }
  const room = limit - Buffer.byteLength(SEARCH_CUT_MARK, "utf8");
  let kept = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > room) {
      break;
    }
    kept += character;
    bytes += size;
  }
  return `${kept}${SEARCH_CUT_MARK}`;
};

/** The keys of a tool call's input that say what it ran or touched: commands, folders, paths, URLs, patterns. */
const inputKeys = new Set([
  "command",
  "cmd",
  "args",
  "argv",
  "cwd",
  "workdir",
  "workingDirectory",
  "directory",
  "dir",
  "path",
  "paths",
  "filePath",
  "file_path",
  "filepath",
  "file",
  "files",
  "filename",
  "url",
  "uri",
  "pattern",
  "glob",
  "include",
  "query",
]);

const stringsIn = (value: unknown, out: string[]): void => {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      stringsIn(item, out);
    }
  }
};

const walk = (value: unknown, out: string[], depth: number): void => {
  if (depth > 4 || value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, out, depth + 1);
    }
    return;
  }
  for (const [key, inner] of Object.entries(value)) {
    if (inputKeys.has(key)) {
      const found: string[] = [];
      stringsIn(inner, found);
      out.push(found.join(" "));
    } else {
      walk(inner, out, depth + 1);
    }
  }
};

/**
 * A tool call as text: its title, then what its input ran or touched (the command and its folder,
 * the paths, the URL). A file's content, an edit's old and new text, never: only the named keys.
 */
export const toolInputText = (title: string, input: unknown): string => {
  const parts: string[] = [];
  walk(input, parts, 0);
  const kept = parts.filter((part) => part.trim() !== "");
  const words = pathWords(kept.join(" "));
  return [title, ...kept, ...(words === "" ? [] : [words])].join("\n");
};

/**
 * The parts of each path in a text, as words: Postgres reads `packages/db/schema.prisma` as one
 * token, so "schema.prisma" or "prisma" alone wouldn't find it. Each segment, and each segment's
 * dotted parts, become words of their own on a line of the entry. A URL is left to Postgres, which
 * reads its host and path itself.
 */
export const pathWords = (text: string): string => {
  const words = new Set<string>();
  for (const token of text.split(/\s+/)) {
    if (!/[\\/]/.test(token) || /^[a-z][a-z0-9+.-]*:\/\//i.test(token)) {
      continue;
    }
    for (const segment of token.split(/[\\/]+/)) {
      const clean = segment.replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, "");
      if (clean === "") {
        continue;
      }
      words.add(clean);
      for (const part of clean.split(".")) {
        if (part !== "" && part !== clean) {
          words.add(part);
        }
      }
    }
  }
  return [...words].join(" ");
};

/** What a stored event gives search, if anything. The caller adds the task and its sequence. */
export const searchEntryOfEvent = (event: TaskEvent): { readonly kind: SearchEntryInput["kind"]; readonly text: string; readonly authorMemberId: MemberId | null; readonly repoId: RepoId | null } | null => {
  // Three kinds of the many: an `if` per kind, so every other kind (thoughts, tool output, partial
  // text and the rest) gives nothing.
  if (event.kind === "user.message") {
    return { kind: "member_message", text: event.text, authorMemberId: event.memberId, repoId: null };
  }
  if (event.kind === "agent.message") {
    return { kind: "agent_message", text: event.text, authorMemberId: null, repoId: null };
  }
  if (event.kind === "tool.called") {
    return { kind: "tool_input", text: toolInputText(event.title, event.input), authorMemberId: null, repoId: null };
  }
  return null;
};

/**
 * Writes entries in the caller's transaction. Idempotent: an entry already there for its
 * `(taskId, eventSeq, kind)` (or, with no event, its `(taskId, kind)`) is left as it is.
 */
export const writeSearchEntries: WriteSearchEntries = async (tx, organizationId, entries) => {
  const rows = entries.filter((entry) => entry.text.trim() !== "");
  if (rows.length === 0) {
    return { written: 0 };
  }
  const written = await tx.searchEntry.createMany({
    data: rows.map((entry) => ({
      organizationId,
      projectId: entry.projectId,
      taskId: entry.taskId,
      repoId: entry.repoId,
      eventSeq: entry.eventSeq,
      kind: entry.kind,
      authorMemberId: entry.authorMemberId,
      text: cutSearchText(entry.text),
    })),
    skipDuplicates: true,
  });
  return { written: written.count };
};

/** The entries of stored events, for the events' own transaction (ingest, a server event). */
export const writeEventSearchEntries = async (
  tx: Tx,
  task: { readonly organizationId: OrganizationId; readonly projectId: ProjectId; readonly taskId: TaskId },
  events: readonly { readonly seq: number; readonly event: TaskEvent }[],
): Promise<{ readonly written: number }> => {
  const entries: SearchEntryInput[] = [];
  for (const { seq, event } of events) {
    const entry = searchEntryOfEvent(event);
    if (entry !== null) {
      entries.push({ taskId: task.taskId, projectId: task.projectId, eventSeq: seq, ...entry });
    }
  }
  return writeSearchEntries(tx, task.organizationId, entries);
};

/** The ticket's entry text: its key and its title. */
export const ticketEntryText = (ticketKey: string, ticketTitle: string | null): string => (ticketTitle === null ? ticketKey : `${ticketKey} ${ticketTitle}`);

/**
 * A new task's entries: its title, its prompt, and its ticket's key and title. Written in the
 * task's creation transaction; the author is the member who made it, when a member did.
 */
export const writeTaskSearchEntries = (
  tx: Tx,
  task: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    readonly taskId: TaskId;
    readonly title: string;
    readonly prompt: string | null;
    readonly ticket: { readonly key: string; readonly title: string | null } | null;
    readonly creatorMemberId: MemberId | null;
  },
): Promise<{ readonly written: number }> => {
  const base = { taskId: task.taskId, projectId: task.projectId, repoId: null, eventSeq: null, authorMemberId: task.creatorMemberId };
  const entries: SearchEntryInput[] = [{ ...base, kind: "title", text: task.title }];
  if (task.prompt !== null) {
    entries.push({ ...base, kind: "prompt", text: task.prompt });
  }
  if (task.ticket !== null) {
    entries.push({ ...base, kind: "ticket", text: ticketEntryText(task.ticket.key, task.ticket.title) });
  }
  return writeSearchEntries(tx, task.organizationId, entries);
};

/** A PR's entry: its title, on its repo, at its `pr.opened` event. */
export const writePullRequestSearchEntry = (
  tx: Tx,
  pr: { readonly organizationId: OrganizationId; readonly projectId: ProjectId; readonly taskId: TaskId; readonly repoId: RepoId; readonly eventSeq: number; readonly title: string },
): Promise<{ readonly written: number }> =>
  writeSearchEntries(tx, pr.organizationId, [{ taskId: pr.taskId, projectId: pr.projectId, repoId: pr.repoId, eventSeq: pr.eventSeq, kind: "pr", authorMemberId: null, text: pr.title }]);

/**
 * A ticket's new title (the ticket cache's sync): every task of that ticket gets its entry's new
 * text, in the sync's transaction. The ticket's own text stays in the ticket cache.
 */
export const updateTicketSearchEntries = async (tx: Tx, ticket: { readonly organizationId: OrganizationId; readonly ticketId: string; readonly key: string; readonly title: string | null }): Promise<number> => {
  const tasks = await tx.task.findMany({ where: { organizationId: ticket.organizationId, ticketId: ticket.ticketId }, select: { id: true, projectId: true, creatorMemberId: true } });
  const text = cutSearchText(ticketEntryText(ticket.key, ticket.title));
  let changed = 0;
  for (const task of tasks) {
    const updated = await tx.searchEntry.updateMany({ where: { taskId: task.id, kind: "ticket", eventSeq: null, NOT: { text } }, data: { text } });
    if (updated.count === 0) {
      const made = await writeSearchEntries(tx, ticket.organizationId, [
        {
          taskId: taskIdSchema.parse(task.id),
          projectId: projectIdSchema.parse(task.projectId),
          repoId: null,
          eventSeq: null,
          kind: "ticket",
          authorMemberId: task.creatorMemberId === null ? null : memberIdSchema.parse(task.creatorMemberId),
          text,
        },
      ]);
      changed += made.written;
    } else {
      changed += updated.count;
    }
  }
  return changed;
};

/** How many events one backfill batch reads (ticket 11). */
export const SEARCH_BACKFILL_BATCH = 500;

/**
 * `search.backfill` for one task (ADR 0054): its title, prompt and ticket, then its events in
 * batches of 500 from `afterSeq`, each batch in its own transaction. Idempotent by
 * `(taskId, eventSeq, kind)`: a second run writes nothing. Reports its progress after each batch.
 */
export const backfillTaskSearchEntries = async (
  db: Db,
  input: { readonly organizationId: OrganizationId; readonly taskId: TaskId; readonly afterSeq?: number },
  onProgress?: (progress: { readonly upToSeq: number; readonly written: number }) => Promise<void> | void,
): Promise<{ readonly written: number; readonly upToSeq: number } | null> => {
  const task = await db.task.findFirst({
    where: { id: input.taskId, organizationId: input.organizationId },
    select: { id: true, projectId: true, title: true, prompt: true, ticketKey: true, creatorMemberId: true, ticket: { select: { title: true } } },
  });
  if (task === null) {
    return null;
  }
  const place = { organizationId: input.organizationId, projectId: projectIdSchema.parse(task.projectId), taskId: input.taskId };
  let written = (
    await db.$transaction((tx) =>
      writeTaskSearchEntries(tx, {
        ...place,
        title: task.title,
        prompt: task.prompt,
        ticket: task.ticketKey === null ? null : { key: task.ticketKey, title: task.ticket?.title ?? null },
        creatorMemberId: task.creatorMemberId === null ? null : memberIdSchema.parse(task.creatorMemberId),
      }),
    )
  ).written;
  let upToSeq = input.afterSeq ?? 0;
  for (;;) {
    const rows = await db.event.findMany({
      where: { taskId: input.taskId, organizationId: input.organizationId, seq: { gt: upToSeq }, kind: { in: ["user.message", "agent.message", "tool.called", "pr.opened"] } },
      orderBy: { seq: "asc" },
      take: SEARCH_BACKFILL_BATCH,
      select: { seq: true, payload: true },
    });
    if (rows.length === 0) {
      break;
    }
    const events: { seq: number; event: TaskEvent }[] = [];
    const prs: { seq: number; repoId: RepoId; number: number }[] = [];
    for (const row of rows) {
      const parsed = taskEventSchema.safeParse(row.payload);
      if (!parsed.success) {
        continue;
      }
      if (parsed.data.kind === "pr.opened") {
        prs.push({ seq: row.seq, repoId: parsed.data.repoId, number: parsed.data.number });
      } else {
        events.push({ seq: row.seq, event: parsed.data });
      }
    }
    written += await db.$transaction(async (tx) => {
      let count = (await writeEventSearchEntries(tx, place, events)).written;
      for (const pr of prs) {
        // The PR's title is the task's, as the opener made it; the event holds only its number.
        count += (await writePullRequestSearchEntry(tx, { ...place, repoId: repoIdSchema.parse(pr.repoId), eventSeq: pr.seq, title: `${task.title} #${String(pr.number)}` })).written;
      }
      return count;
    });
    upToSeq = rows[rows.length - 1]?.seq ?? upToSeq;
    await onProgress?.({ upToSeq, written });
    if (rows.length < SEARCH_BACKFILL_BATCH) {
      break;
    }
  }
  return { written, upToSeq };
};
