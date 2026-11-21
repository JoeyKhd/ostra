import { readdir } from "node:fs/promises";
import path from "node:path";

// A repo's own skills (F-021, ADR 0049 amended 2026-11-21). A repo set up with `npx skills add`,
// Claude Code or OpenCode keeps its skills in one of three folders, each skill a folder holding a
// `SKILL.md` (the Agent Skills format) and named by that folder. The agent reads them from the
// task's own checkout, inside the box, so nothing is fetched. A project admin can keep them from
// the agent (`PrepareLaunchInput.repoSkills`). A profile's skill wins over a repo's of the same
// name, and the runner logs the repo's by its name only (`shadowedRepoSkills`).

/** The folders of a repo's own skills, as the tools write them: the shared ones first, OpenCode's own last. */
export const REPO_SKILL_FOLDERS: readonly string[] = [".agents/skills", ".claude/skills", ".opencode/skills"];

/**
 * Every folder the task's repos keep their skills in: the workspace root's, then each repo's, in
 * the task's order, each with `REPO_SKILL_FOLDERS` in their order. A folder that isn't there is fine.
 */
export const repoSkillFolders = (workspaceDir: string, repoDirs: readonly string[]): readonly string[] =>
  [workspaceDir, ...repoDirs.map((dir) => path.join(workspaceDir, dir))].flatMap((root) => REPO_SKILL_FOLDERS.map((folder) => path.join(root, ...folder.split("/"))));

/** How far below a skills folder a skill's folder may sit: OpenCode 2.3.2 looks 6 folders down. */
const SCAN_DEPTH = 6;

/** The most folders one scan reads, so a repo with a huge tree there can't hold a launch up. */
const SCAN_FOLDERS_MAX = 2_000;

/**
 * The names of the skills in `folders`: each folder holding a `SKILL.md`, by its own name, as an
 * agent names it (OpenCode 2.3.2 takes a skill's ID from its folder). Breadth-first, a skill's
 * folder isn't looked into, folders whose names start with `.` are passed over, and only names are
 * read: never a file's content.
 */
export const findRepoSkills = async (folders: readonly string[]): Promise<readonly string[]> => {
  const names = new Set<string>();
  let read = 0;
  for (const folder of folders) {
    const queue: { readonly dir: string; readonly depth: number }[] = [{ dir: folder, depth: 0 }];
    for (const { dir, depth } of queue) {
      if (read >= SCAN_FOLDERS_MAX) {
        return [...names].sort();
      }
      read += 1;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      if (entries.some((entry) => entry.name === "SKILL.md" && (entry.isFile() || entry.isSymbolicLink()))) {
        names.add(path.basename(dir));
        continue;
      }
      if (depth < SCAN_DEPTH) {
        for (const entry of entries) {
          if (!entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink())) {
            queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
          }
        }
      }
    }
  }
  return [...names].sort();
};

/**
 * The repos' own skills that a profile's skill of the same name shadows: the profile's is the one
 * the agent gets (ADR 0049, "the profile wins"). Names only, sorted.
 */
export const shadowedRepoSkills = async (input: {
  readonly workspaceDir: string;
  readonly repoDirs: readonly string[];
  /** The names of the profile's skills the agent was given. */
  readonly profileSkills: readonly string[];
}): Promise<readonly string[]> => {
  if (input.profileSkills.length === 0) {
    return [];
  }
  const profile = new Set(input.profileSkills);
  return (await findRepoSkills(repoSkillFolders(input.workspaceDir, input.repoDirs))).filter((name) => profile.has(name));
};
