// The words a task's branch is named from (spec section 11, item 10), pure so the panel can show the
// branch's slug while the member types the prompt (task-new.md, "What happens next"). The server
// adds the task ID's part (`branchNameFor`) once the task exists.

/** A URL-safe slug of a name, never empty. */
export const slugify = (name: string, fallback: string): string => {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug === "" ? fallback : slug;
};

/** The task's title when the member gave none: the prompt's first non-empty line, kept short. */
export const titleFromPrompt = (prompt: string): string => {
  const first = prompt.split(/\r?\n/).find((line) => line.trim() !== "") ?? prompt;
  const trimmed = first.trim().replace(/\s+/g, " ");
  return trimmed.length <= 120 ? trimmed : `${trimmed.slice(0, 117).trimEnd()}...`;
};

/** The branch name's words after the ID part: the title's slug, at most 40 characters. */
export const branchSlugFor = (title: string): string => {
  const slug = slugify(title, "task").slice(0, 40).replace(/-+$/g, "");
  return slug === "" ? "task" : slug;
};
