import type { DbEnum } from "@ostra/db";
import {
  appLabelSchema,
  appPathSchema,
  appPortSchema,
  appProcessNameSchema,
  appProcessRuleIssues,
  appProcessRuleWords,
  appReadyCheckSchema,
  fixedReservedPorts,
  repoIdSchema,
  repoRelativePathSchema,
  runnerLimits,
  screenshotWidthSchema,
} from "@ostra/protocol";
import type { AppReadyCheck, RepoId, TaskSpecAppProcess, TaskSpecScreenshots } from "@ostra/protocol";
import { z } from "zod";

// An environment's app processes (milestone 8, F-140, ADR 0068): the form a project admin saves and
// an onboarding proposal's list, with the rules, the after-turn screenshots' settings and a
// service's preview label, and the rows they're kept in. The wire shape is the protocol's
// (`taskSpecAppProcessSchema`); this is the same shape with the environment's own rules on top. A
// process's command is never logged.

/**
 * Ports a box keeps for itself at a fixed number, refused for an app process when it's saved: the
 * sidecar's control API (the bridge) on `docker` and `kubernetes`. The protocol's, beside
 * `mayReach` (`task/previews.ts`).
 */
export { fixedReservedPorts } from "@ostra/protocol";

/** A folder inside its repo: repo-relative, never `..`, `.` for the root; `./web` reads as `web`. */
export const appFolderSchema = repoRelativePathSchema
  .transform((folder) => folder.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "") || ".")
  .pipe(repoRelativePathSchema);

/** One app process as a project admin writes it, or as a proposal carries it. Its command is never logged. */
export const appProcessSchema = z
  .strictObject({
    name: appProcessNameSchema,
    repoId: repoIdSchema,
    folder: appFolderSchema.default("."),
    command: z.string().trim().min(1).max(8192),
    port: appPortSchema,
    ready: appReadyCheckSchema,
    label: appLabelSchema,
    primary: z.boolean().default(false),
    hostRewrite: z.boolean().default(true),
  })
  .describe("An app process. Its command is never logged.");
export type AppProcessForm = z.input<typeof appProcessSchema>;
export type AppProcess = z.infer<typeof appProcessSchema>;

/** A rule an environment's list breaks: the protocol's three, a port the box keeps, or a repo the project lacks. */
export type AppProcessListIssue =
  | ReturnType<typeof appProcessRuleIssues>[number]
  | { readonly rule: "reserved-port"; readonly port: number; readonly name: string }
  | { readonly rule: "unknown-repo"; readonly name: string };

/**
 * Every rule over an environment's list (ADR 0068): at most one primary, names and ports once, no
 * port the box keeps, and each process in one of the project's repos. A port below 1024 is the
 * port's own refusal, in `appProcessSchema`.
 */
export const appProcessListIssues = (
  processes: readonly Pick<AppProcess, "name" | "port" | "primary" | "repoId">[],
  repoIds: readonly RepoId[] | null = null,
): readonly AppProcessListIssue[] => {
  const issues: AppProcessListIssue[] = [...appProcessRuleIssues(processes)];
  for (const process of processes) {
    const reserved = fixedReservedPorts.find((fixed) => fixed.port === process.port);
    if (reserved !== undefined) {
      issues.push({ rule: "reserved-port", port: process.port, name: reserved.name });
    }
    if (repoIds !== null && !repoIds.includes(process.repoId)) {
      issues.push({ rule: "unknown-repo", name: process.name });
    }
  }
  return issues;
};

/** The words of a rule's refusal, for the form. Names and ports only. */
export const appProcessListWords = (issue: AppProcessListIssue): string => {
  switch (issue.rule) {
    case "one-primary":
    case "unique-name":
    case "unique-port":
      return appProcessRuleWords(issue);
    case "reserved-port":
      return `Port ${String(issue.port)} is kept by the box itself: pick another for the app.`;
    case "unknown-repo":
      return `The app process ${issue.name} names a repo this project doesn't have.`;
    default:
      return issue satisfies never;
  }
};

/** An environment's list, at most `appProcessesMax`, with every rule but the repos' (which need the project). */
export const appProcessListSchema = z
  .array(appProcessSchema)
  .max(runnerLimits.appProcessesMax)
  .superRefine((processes, context) => {
    for (const issue of appProcessListIssues(processes)) {
      context.addIssue({ code: "custom", message: appProcessListWords(issue) });
    }
  });

/**
 * The after-turn screenshots' settings (F-121): on by default, acting only once the environment
 * declares a primary; at most 5 routes and the two widths.
 */
export const screenshotSettingsSchema = z.strictObject({
  afterTurn: z.boolean().default(true),
  routes: z
    .array(appPathSchema)
    .min(1)
    .max(runnerLimits.screenshotRoutesMax)
    .refine((routes) => new Set(routes).size === routes.length, "each route once")
    .default(["/"]),
  widths: z
    .array(screenshotWidthSchema)
    .min(1)
    .max(runnerLimits.screenshotWidthsMax)
    .refine((widths) => new Set(widths).size === widths.length, "each width once")
    .default(["desktop"]),
});
export type ScreenshotSettings = z.infer<typeof screenshotSettingsSchema>;

/** A service's preview label (F-140): a service with a web UI, such as Mailpit's, or `null` for none. */
export const servicePreviewLabelSchema = appLabelSchema.nullable();

/** The screenshots the spec carries: off without a primary, whatever the setting says. */
export const specScreenshots = (settings: ScreenshotSettings, processes: readonly Pick<AppProcess, "primary">[]): TaskSpecScreenshots => ({
  afterTurn: settings.afterTurn && processes.some((process) => process.primary),
  routes: [...settings.routes],
  widths: [...settings.widths],
});

// ---------- the rows ----------

/** An `AppProcess` row's fields this module reads and writes. */
export type AppProcessRow = {
  readonly name: string;
  readonly repoId: string;
  readonly folder: string;
  readonly command: string;
  readonly port: number;
  readonly readyKind: DbEnum.AppReadyKind;
  readonly readyValue: string | null;
  readonly label: string;
  readonly primary: boolean;
  readonly hostRewrite: boolean;
  readonly position: number;
};

/** A ready check as its two columns. */
export const readyCheckColumns = (ready: AppReadyCheck): { readonly readyKind: DbEnum.AppReadyKind; readonly readyValue: string | null } => {
  switch (ready.kind) {
    case "http":
      return { readyKind: "http", readyValue: ready.path };
    case "command":
      return { readyKind: "command", readyValue: ready.command };
    case "port":
      return { readyKind: "port", readyValue: null };
    default:
      return ready satisfies never;
  }
};

/** A row's ready check, or `null` when its columns don't make one (a hand-edited row). */
export const readyCheckFromColumns = (row: Pick<AppProcessRow, "readyKind" | "readyValue">): AppReadyCheck | null => {
  const parsed = appReadyCheckSchema.safeParse(
    row.readyKind === "http" ? { kind: "http", path: row.readyValue } : row.readyKind === "command" ? { kind: "command", command: row.readyValue } : { kind: "port" },
  );
  return parsed.success ? parsed.data : null;
};

/** A process as its row, at its place in the list. */
export const appProcessToRow = (process: AppProcess, position: number): AppProcessRow => ({
  name: process.name,
  repoId: process.repoId,
  folder: process.folder,
  command: process.command,
  port: process.port,
  ...readyCheckColumns(process.ready),
  label: process.label,
  primary: process.primary,
  hostRewrite: process.hostRewrite,
  position,
});

/** The rows as the spec's list, in their order, leaving out any row that no longer parses. */
export const specAppProcesses = (rows: readonly AppProcessRow[]): readonly TaskSpecAppProcess[] =>
  [...rows]
    .sort((a, b) => a.position - b.position)
    .flatMap((row) => {
      const ready = readyCheckFromColumns(row);
      const parsed = appProcessSchema.safeParse({
        name: row.name,
        repoId: row.repoId,
        folder: row.folder,
        command: row.command,
        port: row.port,
        ready,
        label: row.label,
        primary: row.primary,
        hostRewrite: row.hostRewrite,
      });
      return ready === null || !parsed.success ? [] : [parsed.data];
    });
