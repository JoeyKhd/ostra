import { visibleProjects } from "@ostra/domain";
import type { MemberScope } from "@ostra/domain";
import type { DbOrTx } from "@ostra/db";
import { projectIdSchema } from "@ostra/protocol";
import type { ProjectId } from "@ostra/protocol";
import { z } from "zod";

// Spend and Insights per project (F-037, F-108, ADR 0055): an organization's figures cover every
// project, and a member who can't open a restricted project sees its share in one line, "Other
// projects", never its name or ID.

/** One line of a per-project breakdown: a project the member can open, or the folded rest. */
export const projectLineSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), projectId: projectIdSchema, name: z.string() }),
  z.object({ kind: z.literal("other") }),
]);
export type ProjectLine = z.infer<typeof projectLineSchema>;

export type ProjectFolding = {
  /** The line a project's figures go on for this member. */
  readonly lineOf: (projectId: string) => ProjectLine;
  /** The projects the member can open, by ID. */
  readonly visible: ReadonlyMap<ProjectId, string>;
};

export const loadProjectFolding = async (db: DbOrTx, scope: MemberScope): Promise<ProjectFolding> => {
  const rows = await db.project.findMany({
    where: { organizationId: scope.organizationId },
    select: { id: true, name: true, access: true },
    orderBy: { name: "asc" },
  });
  const projects = rows.map((row) => ({ id: projectIdSchema.parse(row.id), organizationId: scope.organizationId, access: row.access, name: row.name }));
  const visible = new Map(visibleProjects(scope, projects).map((project) => [project.id, project.name] as const));
  return {
    visible,
    lineOf: (projectId) => {
      const parsed = projectIdSchema.safeParse(projectId);
      const name = parsed.success ? visible.get(parsed.data) : undefined;
      return parsed.success && name !== undefined ? { kind: "project", projectId: parsed.data, name } : { kind: "other" };
    },
  };
};

/** The key a line is summed under. */
export const lineKey = (line: ProjectLine): string => (line.kind === "project" ? `project:${line.projectId}` : "other");

/** Sums figures into lines, with "Other projects" last. */
export const foldByLine = <T,>(
  rows: readonly { readonly line: ProjectLine; readonly value: T }[],
  add: (sum: T, value: T) => T,
): readonly { readonly line: ProjectLine; readonly value: T }[] => {
  const sums = new Map<string, { line: ProjectLine; value: T }>();
  for (const row of rows) {
    const key = lineKey(row.line);
    const seen = sums.get(key);
    sums.set(key, seen === undefined ? { line: row.line, value: row.value } : { line: seen.line, value: add(seen.value, row.value) });
  }
  return [...sums.values()].sort((x, y) => {
    if (x.line.kind !== y.line.kind) {
      return x.line.kind === "other" ? 1 : -1;
    }
    return x.line.kind === "project" && y.line.kind === "project" ? x.line.name.localeCompare(y.line.name) : 0;
  });
};
