import type { IntakeFilter } from "@ostra/domain";
import { boardIdSchema, runnerLabelSchema } from "@ostra/protocol";
import type { AgentProfileId } from "@ostra/protocol";

import type { RouterInputs } from "@/lib/trpc";

import type { Automation } from "./automation-words";

// The rule and schedule editor's draft (automation-edit.md): what the form holds, and how it becomes
// the settings `automations.create` and `update` take. Pure, so the round trip is tested.

export type ConditionField = "labels" | "status" | "assignee" | "board" | "project";
export type LabelOp = "any" | "all" | "none";
export type StatusOp = "is" | "category";

export type Condition =
  | { readonly key: string; readonly field: "labels"; readonly op: LabelOp; readonly values: readonly string[] }
  | { readonly key: string; readonly field: "status"; readonly op: StatusOp; readonly values: readonly string[] }
  /** Values: `unassigned`, `app`, or `user:<id>`. */
  | { readonly key: string; readonly field: "assignee"; readonly values: readonly string[] }
  | { readonly key: string; readonly field: "board"; readonly values: readonly string[] }
  | { readonly key: string; readonly field: "project"; readonly values: readonly string[] };

export type Draft = {
  readonly name: string;
  readonly starts: "match" | "schedule";
  readonly cron: string;
  readonly timeZone: string;
  readonly does: "filter" | "prompt";
  readonly title: string;
  readonly prompt: string;
  readonly skipWhileOpen: boolean;
  readonly conditions: readonly Condition[];
  readonly taskKind: "code" | "refine";
  readonly agentProfileId: AgentProfileId | null;
  readonly poolLabels: readonly string[];
  readonly requireApproval: boolean;
};

export type Settings = RouterInputs["automations"]["create"]["settings"];
export type FilterInput = Extract<RouterInputs["automations"]["dryRun"], { readonly filter: unknown }>["filter"];

let keyCounter = 0;
export const conditionKey = (): string => {
  keyCounter += 1;
  return `c${String(keyCounter)}`;
};

export const emptyCondition = (field: ConditionField): Condition => {
  const key = conditionKey();
  switch (field) {
    case "labels":
      return { key, field, op: "any", values: [] };
    case "status":
      return { key, field, op: "is", values: [] };
    case "assignee":
    case "board":
    case "project":
      return { key, field, values: [] };
    default:
      return field satisfies never;
  }
};

export const PRESETS = {
  hourly: "0 * * * *",
  daily: "0 9 * * *",
  weekdays: "0 9 * * 1-5",
  monday: "0 9 * * 1",
} as const;
export type Preset = keyof typeof PRESETS | "custom";

/** The preset a cron is, or `custom`. */
export const presetOf = (cron: string): Preset => {
  const normal = cron.trim().split(/\s+/).join(" ");
  for (const [name, value] of Object.entries(PRESETS)) {
    if (value === normal && (name === "hourly" || name === "daily" || name === "weekdays" || name === "monday")) return name;
  }
  return "custom";
};

/** A preset's cron; a day preset keeps the time already in the field (`0 7 * * 1` → Weekdays → `0 7 * * 1-5`). */
export const applyPreset = (preset: Exclude<Preset, "custom">, current: string): string => {
  const base = PRESETS[preset];
  if (preset === "hourly") return base;
  const [minute, hour] = current.trim().split(/\s+/);
  const plain = (value: string | undefined): value is string => value !== undefined && /^\d{1,2}$/.test(value);
  if (!plain(minute) || !plain(hour)) return base;
  const [, , ...rest] = base.split(" ");
  return [minute, hour, ...rest].join(" ");
};

/** The form's conditions as a filter, or `null` while none holds a value (a filter names one at least). */
export const filterOf = (conditions: readonly Condition[]): FilterInput | null => {
  let labels: { mode: "any" | "all"; names: string[] } | null = null;
  const excludeLabels: string[] = [];
  let status: { by: "id"; ids: string[] } | { by: "category"; categories: ("open" | "started" | "done" | "cancelled")[] } | null = null;
  const assignees: ({ kind: "unassigned" } | { kind: "app" } | { kind: "user"; userId: string })[] = [];
  const boardIds: string[] = [];
  const trackerProjectIds: string[] = [];
  for (const condition of conditions) {
    if (condition.values.length === 0) continue;
    switch (condition.field) {
      case "labels":
        if (condition.op === "none") excludeLabels.push(...condition.values);
        else labels = { mode: condition.op, names: [...condition.values] };
        break;
      case "status":
        status =
          condition.op === "is"
            ? { by: "id", ids: [...condition.values] }
            : { by: "category", categories: condition.values.filter((value): value is "open" | "started" | "done" | "cancelled" => value === "open" || value === "started" || value === "done" || value === "cancelled") };
        break;
      case "assignee":
        for (const value of condition.values) {
          if (value === "unassigned") assignees.push({ kind: "unassigned" });
          else if (value === "app") assignees.push({ kind: "app" });
          else if (value.startsWith("user:")) assignees.push({ kind: "user", userId: value.slice("user:".length) });
        }
        break;
      case "board":
        boardIds.push(...condition.values);
        break;
      case "project":
        trackerProjectIds.push(...condition.values);
        break;
      default:
        condition satisfies never;
    }
  }
  if (labels === null && excludeLabels.length === 0 && status === null && assignees.length === 0 && boardIds.length === 0 && trackerProjectIds.length === 0) return null;
  const boards = boardIds.flatMap((id) => {
    const parsed = boardIdSchema.safeParse(id);
    return parsed.success ? [parsed.data] : [];
  });
  return { labels, excludeLabels, status, assignees, boardIds: boards, trackerProjectIds } satisfies Record<keyof IntakeFilter, unknown>;
};

/** A saved filter as the form's condition rows. */
export const conditionsOf = (filter: IntakeFilter | null): Condition[] => {
  if (filter === null) return [emptyCondition("labels")];
  const rows: Condition[] = [];
  if (filter.labels !== null) rows.push({ key: conditionKey(), field: "labels", op: filter.labels.mode, values: filter.labels.names });
  if (filter.excludeLabels.length > 0) rows.push({ key: conditionKey(), field: "labels", op: "none", values: filter.excludeLabels });
  if (filter.status !== null) {
    rows.push(filter.status.by === "id" ? { key: conditionKey(), field: "status", op: "is", values: filter.status.ids } : { key: conditionKey(), field: "status", op: "category", values: filter.status.categories });
  }
  if (filter.assignees.length > 0) {
    rows.push({ key: conditionKey(), field: "assignee", values: filter.assignees.map((one) => (one.kind === "user" ? `user:${one.userId}` : one.kind)) });
  }
  if (filter.boardIds.length > 0) rows.push({ key: conditionKey(), field: "board", values: filter.boardIds });
  if (filter.trackerProjectIds.length > 0) rows.push({ key: conditionKey(), field: "project", values: filter.trackerProjectIds });
  return rows.length === 0 ? [emptyCondition("labels")] : rows;
};

const viewerZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/** A new rule (`On a match`, one Labels row) or schedule (`Every Monday`, the viewer's zone). */
export const newDraft = (starts: "match" | "schedule", hasBoard: boolean): Draft => ({
  name: "",
  starts,
  cron: PRESETS.monday,
  timeZone: viewerZone(),
  does: starts === "schedule" && !hasBoard ? "prompt" : "filter",
  title: "",
  prompt: "",
  skipWhileOpen: true,
  conditions: [emptyCondition("labels")],
  taskKind: "code",
  agentProfileId: null,
  poolLabels: [],
  requireApproval: false,
});

/** A saved automation as the form's draft. */
export const draftOf = (automation: Automation): Draft => ({
  name: automation.name,
  starts: automation.schedule === null ? "match" : "schedule",
  cron: automation.schedule?.cron ?? PRESETS.monday,
  timeZone: automation.schedule?.timeZone ?? viewerZone(),
  does: automation.schedule?.does ?? "filter",
  title: automation.schedule?.title ?? "",
  prompt: automation.schedule?.prompt ?? "",
  skipWhileOpen: automation.schedule?.skipWhileOpen ?? true,
  conditions: conditionsOf(automation.filter),
  taskKind: automation.taskKind === "refine" ? "refine" : "code",
  agentProfileId: automation.agentProfile?.id ?? null,
  poolLabels: automation.poolLabels,
  requireApproval: automation.requireApproval,
});

/** What the form saves, or why it can't yet (the server checks it again). */
export const settingsOf = (draft: Draft): { readonly ok: true; readonly settings: Settings } | { readonly ok: false } => {
  const name = draft.name.trim();
  if (name === "" || name.length > 80) return { ok: false };
  const base = { name, taskKind: draft.taskKind, agentProfileId: draft.agentProfileId, poolLabels: [...draft.poolLabels], requireApproval: draft.requireApproval };
  const filter = filterOf(draft.conditions);
  if (draft.starts === "match") {
    return filter === null ? { ok: false } : { ok: true, settings: { kind: "intake_rule", ...base, filter } };
  }
  if (draft.does === "filter") {
    return filter === null
      ? { ok: false }
      : { ok: true, settings: { kind: "schedule", ...base, schedule: draft.cron.trim(), timeZone: draft.timeZone, skipWhileOpen: draft.skipWhileOpen, does: { kind: "filter", filter } } };
  }
  const title = draft.title.trim();
  if (title === "" || draft.prompt.trim() === "") return { ok: false };
  return { ok: true, settings: { kind: "schedule", ...base, schedule: draft.cron.trim(), timeZone: draft.timeZone, skipWhileOpen: draft.skipWhileOpen, does: { kind: "prompt", title, prompt: draft.prompt } } };
};

/** Two drafts that save the same (condition keys aside). */
export const sameDraft = (a: Draft, b: Draft): boolean => {
  const strip = (draft: Draft) => ({ ...draft, conditions: draft.conditions.map((condition) => ({ ...condition, key: "" })) });
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
};

/** A pool label as `runnerLabelSchema` takes it, checked before the server checks it again. */
export const poolLabelOk = (label: string): boolean => runnerLabelSchema.safeParse(label).success;
