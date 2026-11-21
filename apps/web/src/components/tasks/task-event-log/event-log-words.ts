import type { StoredEvent } from "@ostra/protocol";

import { t } from "@/lib/messages";

// The task's event log (F-073, ADR 0054; task-event-log.md): the stored events as rows, apart from the
// view so each rule is tested without a browser. One row per event, with two folds: a tool call's
// completion or failure folds into its `tool.called` row, and progress, streaming content and thoughts
// aren't rows.

export const eventChips = ["all", "tool", "message", "approval", "turn", "session"] as const;
export type EventChip = (typeof eventChips)[number];

export type RowStatus = { readonly word: string; readonly tone: "ok" | "failed" | "running" };

/** A row's one-line text: a sans lead, then a mono part, then a sans tail, any of them empty. */
export type RowText = { readonly lead?: string; readonly mono?: string; readonly tail?: string; readonly strong?: string };

export type LogRow = {
  readonly seq: number;
  readonly at: number;
  readonly chip: Exclude<EventChip, "all">;
  /** The kind word (`read`, `execute`, `message`, …) and the icon's name. */
  readonly word: string;
  readonly icon: string;
  readonly text: RowText;
  readonly status: RowStatus | null;
  /** The call's time in ms, or `null` when the agent sent none. */
  readonly durationMs: number | null;
  /** What opens under the row: a tool call's input as stored, its error, a message's whole text. */
  readonly body: { readonly input?: string; readonly error?: string; readonly text?: string } | null;
  /** The `seq` of the event a tool call's completion or failure was recorded with. */
  readonly endSeq: number | null;
  readonly turn: number | null;
  /** A turn's start: who started it, the author of the message before it (`null`: an automatic turn). */
  readonly startedBy?: string | null;
};

type Names = ReadonlyMap<string, string>;

const nameOf = (names: Names, memberId: string | null | undefined): string => (memberId === null || memberId === undefined ? t("eventLog.nobody") : (names.get(memberId) ?? t("eventLog.someone")));

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (input: unknown, ...keys: readonly string[]): string | null => {
  if (!isRecord(input)) return null;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
};

const firstString = (input: unknown): string | null => {
  if (typeof input === "string") return input;
  if (!isRecord(input)) return null;
  for (const value of Object.values(input)) if (typeof value === "string" && value !== "") return value;
  return null;
};

const pathsOf = (input: unknown): readonly string[] => {
  if (!isRecord(input)) return [];
  const many = input["paths"];
  if (Array.isArray(many)) return many.filter((value): value is string => typeof value === "string");
  const files = input["files"];
  if (Array.isArray(files)) return files.flatMap((file: unknown) => (isRecord(file) && typeof file["path"] === "string" ? [file["path"]] : []));
  const one = stringField(input, "path", "from");
  return one === null ? [] : [one];
};

/** The command of an `execute` call's input: a string, or an argv joined by spaces. */
export const commandOf = (input: unknown): string | null => {
  if (!isRecord(input)) return typeof input === "string" ? input : null;
  const command = input["command"];
  if (typeof command === "string") return command;
  if (Array.isArray(command)) return command.filter((part): part is string => typeof part === "string").join(" ");
  return null;
};

const toolRowText = (toolKind: string, title: string, input: unknown): RowText => {
  switch (toolKind) {
    case "read": {
      const path = stringField(input, "path") ?? title;
      const line = isRecord(input) && typeof input["startLine"] === "number" ? `:${String(input["startLine"])}` : "";
      return { mono: `${path}${line}` };
    }
    case "edit":
    case "delete":
    case "move": {
      const paths = pathsOf(input);
      if (paths.length === 0) return { mono: title };
      const shown = paths.slice(0, 3).join(", ");
      return paths.length > 3 ? { mono: shown, tail: t("eventLog.more", { n: paths.length - 3 }) } : { mono: shown };
    }
    case "search": {
      const query = stringField(input, "query", "pattern") ?? title;
      const folder = stringField(input, "path", "cwd", "folder");
      return folder === null ? { mono: query } : { mono: query, tail: t("eventLog.inFolder", { folder }) };
    }
    case "execute":
      return { mono: commandOf(input) ?? title };
    case "fetch":
      return { mono: stringField(input, "url") ?? title };
    default:
      return firstString(input) === null ? { tail: t("eventLog.noInput") } : { mono: firstString(input) ?? "" };
  }
};

const toolIcon = (toolKind: string, failed: boolean): string => {
  switch (toolKind) {
    case "read":
      return failed ? "file-x" : "file-text";
    case "edit":
      return "pencil";
    case "delete":
      return "trash-2";
    case "move":
      return "move";
    case "search":
      return "search";
    case "execute":
      return "square-terminal";
    case "fetch":
      return "globe";
    default:
      return "wrench";
  }
};

const firstLine = (text: string): string => text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";

/** A pretty-printed input, as stored. */
const pretty = (input: unknown): string => JSON.stringify(input, null, 2);

/** The exit code an `execute` call's output reports, if it reports one. */
const exitCodeOf = (output: unknown): number | null => {
  if (!isRecord(output)) return null;
  const code = output["exitCode"] ?? output["exit_code"];
  return typeof code === "number" ? code : null;
};

/** Every stored event as the log's rows, oldest first. */
export const buildRows = (events: readonly StoredEvent[], names: Names): readonly LogRow[] => {
  const rows: LogRow[] = [];
  const callRow = new Map<string, number>();
  let turn = 0;
  let inTurn: number | null = null;
  /** The author of the last member message since the last turn started: who starts the next one. */
  let lastAuthor: string | null = null;
  for (const stored of events) {
    const event = stored.event;
    const base = { seq: stored.seq, at: stored.at, status: null, durationMs: null, body: null, endSeq: null, turn: inTurn };
    if (event.kind === "agent.content" || event.kind === "agent.thought" || event.kind === "tool.progress") continue;
    if (event.kind === "tool.called") {
      callRow.set(event.toolCallId, rows.length);
      rows.push({
        ...base,
        chip: "tool",
        word: event.toolKind === "other" || event.toolKind === "switch_mode" || event.toolKind === "think" ? event.title.split(/\s+/)[0] ?? event.toolKind : event.toolKind,
        icon: toolIcon(event.toolKind, false),
        text: toolRowText(event.toolKind, event.title, event.input),
        status: { word: t("eventLog.running"), tone: "running" },
        body: { input: pretty(event.input) },
      });
      continue;
    }
    if (event.kind === "tool.completed" || event.kind === "tool.failed") {
      const at = callRow.get(event.toolCallId);
      const row = at === undefined ? undefined : rows[at];
      if (at === undefined || row === undefined) continue;
      const durationMs = Math.max(0, stored.at - row.at);
      if (event.kind === "tool.completed") {
        const code = row.word === "execute" ? exitCodeOf(event.output) : null;
        rows[at] = {
          ...row,
          durationMs,
          endSeq: stored.seq,
          status: code !== null && code !== 0 ? { word: t("eventLog.failedExit", { code }), tone: "failed" } : { word: t("eventLog.ok"), tone: "ok" },
        };
      } else {
        const refused = /refus|declin|denied|not allowed/i.test(event.error);
        rows[at] = {
          ...row,
          durationMs: refused ? null : durationMs,
          endSeq: stored.seq,
          icon: row.word === "read" ? "file-x" : row.icon,
          status: { word: refused ? t("eventLog.refused") : t("eventLog.failed"), tone: "failed" },
          body: { ...row.body, error: event.error },
        };
      }
      continue;
    }
    if (event.kind === "turn.started") {
      turn += 1;
      inTurn = turn;
      rows.push({ ...base, turn, chip: "turn", word: "turn", icon: "play", text: { lead: t("eventLog.turnStarted", { n: turn }) }, startedBy: lastAuthor });
      lastAuthor = null;
      continue;
    }
    if (event.kind === "turn.ended" || event.kind === "turn.failed") {
      const started = [...rows].reverse().find((row) => row.chip === "turn" && row.turn === inTurn && row.icon === "play");
      rows.push({
        ...base,
        chip: "turn",
        word: "turn",
        icon: event.kind === "turn.ended" ? "square" : "circle-x",
        text: { lead: event.kind === "turn.ended" ? t("eventLog.turnEnded", { n: inTurn ?? turn }) : t("eventLog.turnFailed", { n: inTurn ?? turn, reason: firstLine(event.error) }) },
        durationMs: started === undefined ? null : stored.at - started.at,
        ...(event.kind === "turn.failed" ? { status: { word: t("eventLog.failed"), tone: "failed" as const } } : {}),
      });
      inTurn = null;
      continue;
    }
    if (event.kind === "user.message") {
      const text = event.text;
      lastAuthor = nameOf(names, event.memberId);
      rows.push({ ...base, chip: "message", word: "message", icon: "user", text: { strong: `${nameOf(names, event.memberId)}:`, lead: firstLine(text) }, body: text.includes("\n") || text.length > 160 ? { text } : null });
      continue;
    }
    if (event.kind === "agent.message") {
      rows.push({ ...base, chip: "message", word: "agent", icon: "message-square", text: { lead: firstLine(event.text) }, body: event.text.includes("\n") || event.text.length > 160 ? { text: event.text } : null });
      continue;
    }
    if (event.kind === "question.asked") {
      rows.push({ ...base, chip: "message", word: "question", icon: "message-circle-question", text: { lead: t("eventLog.asked", { text: firstLine(event.message) }) } });
      continue;
    }
    if (event.kind === "question.answered" || event.kind === "question.closed") {
      rows.push({ ...base, chip: "message", word: "question", icon: "message-circle-question", text: { lead: event.kind === "question.answered" ? t("eventLog.answered") : t("eventLog.closed") } });
      continue;
    }
    if (event.kind === "approval.requested") {
      const call = callRow.get(event.toolCallId);
      const called = call === undefined ? undefined : rows[call];
      const command = called?.text.mono ?? "";
      rows.push({ ...base, chip: "approval", word: "approval", icon: "shield-question", text: { lead: t("eventLog.askedToRun"), mono: command } });
      continue;
    }
    if (event.kind === "approval.answered") {
      const who = nameOf(names, event.memberId);
      const lead = event.decision === "deny" ? t("eventLog.declinedBy", { name: who }) : event.decision === "allow_task" ? t("eventLog.approvedTaskBy", { name: who }) : t("eventLog.approvedOnceBy", { name: who });
      rows.push({ ...base, chip: "approval", word: "approval", icon: event.decision === "deny" ? "shield-x" : "shield-check", text: { lead } });
      continue;
    }
    if (event.kind === "approval.auto_answered" || event.kind === "approval.closed") {
      rows.push({ ...base, chip: "approval", word: "approval", icon: "shield", text: { lead: event.kind === "approval.closed" ? t("eventLog.approvalClosed") : t("eventLog.approvalAuto") } });
      continue;
    }
    if (event.kind === "plan.proposed" || event.kind === "plan.answered" || event.kind === "plan.updated") {
      rows.push({ ...base, chip: "approval", word: "plan", icon: "list-checks", text: { lead: event.kind === "plan.answered" ? t("eventLog.planAnswered") : t("eventLog.planProposed") } });
      continue;
    }
    if (event.kind === "runner.connected" || event.kind === "runner.lost") {
      rows.push({ ...base, chip: "session", word: "runner", icon: event.kind === "runner.connected" ? "plug" : "unplug", text: { lead: event.kind === "runner.connected" ? t("eventLog.runnerConnected") : t("eventLog.runnerLost") } });
      continue;
    }
    if (event.kind === "driver.changed") {
      rows.push({ ...base, chip: "session", word: "driver", icon: "user-round-cog", text: { lead: t("eventLog.driverChanged", { name: nameOf(names, event.memberId) }) } });
      continue;
    }
    if (event.kind === "git.pushed") {
      rows.push({ ...base, chip: "session", word: "git", icon: "git-commit-horizontal", text: { lead: t("eventLog.pushed"), mono: `${event.headSha.slice(0, 7)} → ${event.branch}` } });
      continue;
    }
    if (event.kind === "pr.opened") {
      rows.push({ ...base, chip: "session", word: "pr", icon: "git-pull-request", text: { lead: t("eventLog.prOpened"), mono: `#${String(event.number)}` } });
      continue;
    }
    if (event.kind === "unsupported" || event.kind === "agent.unknown") {
      const type = event.kind === "unsupported" ? event.rawKind : event.acpKind;
      rows.push({ ...base, chip: "session", word: "event", icon: "circle-dashed", text: { mono: type }, body: { input: event.kind === "agent.unknown" ? event.raw : type } });
      continue;
    }
    // Every other kind the server keeps: a session's life, usage, checks, the environment.
    const session = event.kind.startsWith("session.") || event.kind === "compaction.updated";
    rows.push({ ...base, chip: "session", word: session ? "session" : event.kind.split(".")[0] ?? event.kind, icon: session ? "circle-stop" : "circle-dot", text: { mono: event.kind } });
  }
  return rows;
};

export const chipOf = (row: LogRow, chip: EventChip): boolean => chip === "all" || row.chip === chip;

export const isFailed = (row: LogRow): boolean => row.status?.tone === "failed";

/** `0.1 s`, `12 s`, `2 min 5 s`, `3 min`; `–` for none. */
export const durationText = (ms: number | null): string => {
  if (ms === null) return "–";
  if (ms < 60_000) return t("units.secondsSpaced", { n: (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) });
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds === 0 ? t("units.minutes", { n: minutes }) : t("units.minutesSecondsSpaced", { m: minutes, s: seconds });
};

const pad = (n: number): string => String(n).padStart(2, "0");

/** `09:41:07` in the viewer's zone. */
export const clockText = (at: number): string => {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

/** Inputs longer than this many lines show their start and `Show all`. */
export const INPUT_LINES = 40;
