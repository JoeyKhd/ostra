import { changeSummary, withoutLeftoverNote } from "@ostra/adapter-sdk";
import type { CompareFile, CompareResult, FileChange } from "@ostra/adapter-sdk";
import type { DbOrTx } from "@ostra/db";
import { cleanPrTitle, repoIdSchema } from "@ostra/protocol";
import type { RepoId, TaskId, TicketKey } from "@ostra/protocol";
import { z } from "zod";

import { ticketPullRequestTitle } from "../tickets/contracts.ts";

// F-030/c2 (the maintainer's report, 2026-11-22: "why does the PR title not explain what the pr is
// about?"; a prompt task's PR was titled with its first message, "hiiiiiiiiiiiii"). A PR's title says
// what it changes, and the agent writes it through `set_pull_request_text`, in the repo's style for
// PR titles and commit subjects. A ticket task's PR has the ticket's key in front, from ostra, never
// from the agent. When the agent gave no title:
//
// - a ticket task's PR is `<KEY>: <ticket title>`, as before;
// - a prompt task's PR takes the subject of its branch's only commit (the agent's own, or ostra's
//   leftover commit, which names what it changed), without ostra's ending note. With several commits
//   it's the leftover rule over the files the PR changes (`changeSummary`): the newest commit may say
//   only its own last step, and the code host doesn't say which commits are ostra's. With no compare
//   (the host can't, or failed), `Update <repo>`. Never the task's first message.
//
// The title is untrusted agent output: read as one clean line (`cleanPrTitle`) at every boundary, and
// sent to the code host as data in a JSON body, never put in a shell command.

/** GitHub's limit on a PR title. */
export const PR_TITLE_MAX = 256;

/** A title as one line within the code host's limit. */
const withinLimit = (title: string): string => {
  const line = title.replace(/\s+/g, " ").trim();
  return line.length <= PR_TITLE_MAX ? line : `${line.slice(0, PR_TITLE_MAX - 3).trimEnd()}...`;
};

/** A ticket key the agent wrote at the start of its title, as `OST-314:`, `[OST-314]` or `OST-314 -`, taken off: the key is ostra's. */
export const withoutTicketKey = (title: string, key: TicketKey): string => {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const leading = new RegExp(`^\\s*[[(]?${escaped}(?![A-Za-z0-9])[\\])]?\\s*[:|\\-–—]?\\s*`, "i");
  return title.replace(leading, "").trim();
};

/** The ticket a ticket task's PR is titled with: its key and its title as last read. */
export type PullRequestTicket = { readonly key: TicketKey; readonly title: string };

/**
 * A PR's title: the agent's, with a ticket task's key in front; with none from the agent, a ticket
 * task's ticket title after its key, and a prompt task's `fallback` (`fallbackPullRequestTitle`).
 */
export const pullRequestTitle = (input: { readonly agentTitle: string | null; readonly ticket: PullRequestTicket | null; readonly fallback: string }): string => {
  const agent = input.agentTitle === null ? "" : cleanPrTitle(input.agentTitle);
  if (input.ticket !== null) {
    const own = withoutTicketKey(agent, input.ticket.key);
    return ticketPullRequestTitle(input.ticket.key, own === "" ? input.ticket.title : own);
  }
  return withinLimit(agent === "" ? input.fallback : agent);
};

/** A commit message's subject, as git reads it: its first paragraph on one line. */
const gitSubject = (message: string): string =>
  message
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .find((paragraph) => paragraph !== "") ?? "";

/** A compared file as the leftover rule reads it. */
const fileChangeOf = (file: CompareFile): readonly FileChange[] => {
  switch (file.status) {
    case "added":
    case "copied":
      return [{ kind: "add", path: file.path }];
    case "removed":
      return [{ kind: "delete", path: file.path }];
    case "renamed":
      return file.previousPath === null ? [{ kind: "update", path: file.path }] : [{ kind: "rename", path: file.path, from: file.previousPath }];
    case "modified":
    case "changed":
      return [{ kind: "update", path: file.path }];
    case "unchanged":
      return [];
    default:
      return file.status satisfies never;
  }
};

/**
 * A prompt task's PR title when the agent gave none: the subject of the branch's only commit
 * without ostra's ending note, else what the PR's files are (`changeSummary`), else `Update <repo>`.
 * `compared` is the code host's compare of the base and the branch's head, `null` without one.
 */
export const fallbackPullRequestTitle = (compared: CompareResult | null, repoFullName: string): string => {
  if (compared !== null) {
    if (compared.aheadBy === 1 && typeof compared.soleCommitMessage === "string") {
      const subject = cleanPrTitle(withoutLeftoverNote(gitSubject(compared.soleCommitMessage)));
      if (subject !== "") {
        return subject;
      }
    }
    const changes = compared.files.flatMap(fileChangeOf);
    if (changes.length > 0) {
      return changeSummary(changes);
    }
  }
  return `Update ${repoFullName.split("/").at(-1) ?? repoFullName}`;
};

const prTextSchema = z.looseObject({ repoId: repoIdSchema, title: z.string() });

/**
 * The repos whose PR title the agent changed in the turn this save or session end closes (F-030/c2):
 * its newest `pr.text_set` for the repo since the previous save, when its title isn't the one it set
 * before. A later turn's new title renames the open PR; the same title set again changes nothing, so
 * a person's rename on the host stays.
 */
export const retitledReposInTx = async (db: DbOrTx, taskId: TaskId, eventSeq: number): Promise<ReadonlyMap<RepoId, string>> => {
  const previous = await db.event.findFirst({
    where: { taskId, kind: { in: ["session.saved", "session.ended"] }, seq: { lt: eventSeq } },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  const since = previous?.seq ?? 0;
  const sets = await db.event.findMany({ where: { taskId, kind: "pr.text_set", seq: { lte: eventSeq } }, orderBy: { seq: "desc" }, select: { seq: true, payload: true } });
  const newest = new Map<RepoId, string>();
  const before = new Map<RepoId, string>();
  for (const row of sets) {
    const parsed = prTextSchema.safeParse(row.payload);
    if (!parsed.success) {
      continue;
    }
    const title = cleanPrTitle(parsed.data.title);
    const into = row.seq > since ? newest : before;
    if (title !== "" && !into.has(parsed.data.repoId)) {
      into.set(parsed.data.repoId, title);
    }
  }
  return new Map([...newest].filter(([repoId, title]) => before.get(repoId) !== title));
};
