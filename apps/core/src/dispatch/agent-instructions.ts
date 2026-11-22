import { renderReposForAgent } from "@ostra/domain";
import type { AgentRepo } from "@ostra/domain";

/** `taskSpecSchema`'s limit on `agent.instructions`. */
const INSTRUCTIONS_MAX = 65_536;

/**
 * What a code task's agent is told about its commits (F-078, ADR 0040): they follow each repo's own
 * style, which the agent reads from the repo's history and its contributing rules. ostra sets the
 * author (the App's bot) and adds the members' `Co-authored-by` trailers, so the agent adds neither.
 */
export const COMMITS_FOR_AGENT = [
  "## Commits",
  "",
  "Commit your work as you go, and before you finish, in each repository you change. Write every commit message in that repository's own style: first read its recent history (`git log -n 20 --format=%s`) and follow what it does, such as a prefix like `feat:` or an emoji, a ticket key, the tense and the length of the subject line, and any commit rules its contributing guide or `AGENTS.md` sets.",
  "",
  "ostra sets each commit's author and adds the `Co-authored-by` trailers of the members who asked for the work: don't set an author or add trailers yourself.",
].join("\n");

/**
 * The instructions the task spec hands the agent (F-025, F-065, F-078, F-098, F-110).
 *
 * The workspace holds one folder per repo. With one repo the runner starts the agent inside it, and
 * nothing is added for the repos. With several, the agent starts at the workspace root, so the
 * instructions name each repo's folder, its base branch and the task's branch (the domain's
 * `renderReposForAgent`): a file written at the root is outside every repo, and its work is lost.
 * A code task's (`commits`) say how to write its commits, in each repo's style (F-078). The
 * profile's own instructions follow. For a runner below minor 3, which has no `memory` section, the
 * memory block comes last (ticket 15). The profile's own text is what's cut when the whole doesn't fit.
 */
export const agentInstructions = (
  profileInstructions: string | null,
  repos: readonly AgentRepo[],
  branchName: string,
  memoryBlock: string | null = null,
  options: { readonly commits?: boolean } = {},
): string | null => {
  const notes = [renderReposForAgent(repos, branchName), options.commits === true ? COMMITS_FOR_AGENT : null].flatMap((note) => (note === null ? [] : [note]));
  if (notes.length === 0 && memoryBlock === null) {
    return profileInstructions;
  }
  const own = profileInstructions?.trim() ?? "";
  const head = notes.join("\n\n");
  const tail = memoryBlock ?? "";
  const room = Math.max(0, INSTRUCTIONS_MAX - head.length - tail.length - 4);
  const parts = [head, own.slice(0, room), tail].filter((part) => part !== "");
  return parts.join("\n\n").slice(0, INSTRUCTIONS_MAX);
};
