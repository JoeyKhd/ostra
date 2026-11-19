/** `taskSpecSchema`'s limit on `agent.instructions`. */
const INSTRUCTIONS_MAX = 65_536;

/**
 * The instructions the task spec hands the agent (F-025, F-065).
 *
 * The workspace holds one folder per repo. With one repo the runner starts the agent inside it, and
 * nothing is added. With several, the agent starts at the workspace root, so the instructions name
 * each repo's folder: a file written at the root is outside every repo, and its work is lost. The
 * profile's own instructions follow, cut to the limit if the two don't fit.
 */
export const agentInstructions = (
  profileInstructions: string | null,
  repos: readonly { readonly fullName: string; readonly checkoutDir: string }[],
): string | null => {
  if (repos.length < 2) {
    return profileInstructions;
  }
  const lines = repos.map((repo) => `- ${repo.checkoutDir}/ is ${repo.fullName}`);
  const note = [
    "Your working folder holds one folder per repository:",
    ...lines,
    "Do the work inside the folder of the repository it concerns, and give paths relative to it. Files outside these folders are not part of any repository and are lost when the task ends.",
  ].join("\n");
  const own = profileInstructions?.trim() ?? "";
  return own === "" ? note.slice(0, INSTRUCTIONS_MAX) : `${note}\n\n${own}`.slice(0, INSTRUCTIONS_MAX);
};
