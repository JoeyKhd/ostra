import { attachmentSkippedWords } from "@ostra/protocol";
import type { EffortLevel, MemberId, OstraToolKind, TaskKind } from "@ostra/protocol";
import type {
  AppProcessData,
  CheckCounts,
  DriverChangeData,
  EffortChangeData,
  LiveDoing,
  LiveStep,
  QuestionData,
  RunCount,
  RunItem,
  RunStep,
  SystemEvent,
  TaskMessageMeta,
  TurnFailure,
  TurnNotice,
  TurnResult,
} from "@ostra/task-view";

import { formatClock, formatTokens } from "@/lib/format";
import type { MessageKey, MessageParams } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";
import { formatSize } from "@/task/marker-words";

// Milestone 10 (F-151, spec section 5.4, ticket 04): every word of the compact thread, picked by
// pure functions over ticket 03's items, so the parts (tickets 09 to 16) render words and never
// build a sentence or edit `en.json`. Each function takes the translator (`t` from
// `@/lib/messages`, or a test's), and words a colour must mark come back as segments: the part
// colours `failed` and `denied` red, a subject mono, and nothing else. ostra's checks run in the
// box and count as checks; the code host's CI runs on the PR and counts in jobs (parts.md part 13).

/** The panel's translator: `t` from `@/lib/messages`. */
export type Translate = (key: MessageKey, params?: MessageParams) => string;

/** A member's name, as the page knows it (`Sam Rivera`). */
export type NameOf = (member: MemberId) => string;

/**
 * A segment's colour, as parts.md names its tokens: `inherit` takes the part's own colour (a run's
 * line is `--faint`), `text` is `--text`, `subject` `--text-2`, and the rest their token.
 */
export type Tone = "inherit" | "text" | "subject" | "muted" | "faint" | "red" | "green" | "teal" | "amber";

/** A run of words in one colour, mono or not. */
export type Segment = { readonly text: string; readonly tone: Tone; readonly mono: boolean };

/** The words of segments, as one string (an accessible name, a title, a test's expectation). */
export const segmentsText = (segments: readonly Segment[]): string => segments.map((segment) => segment.text).join("");

const seg = (text: string, tone: Tone = "inherit", mono = false): Segment => ({ text, tone, mono });
const code = (text: string, tone: Tone = "subject"): Segment => seg(text, tone, true);

const pushSegment = (out: Segment[], next: Segment): void => {
  if (next.text === "") return;
  const last = out.at(-1);
  if (last?.tone === next.tone && last.mono === next.mono) out[out.length - 1] = { ...last, text: `${last.text}${next.text}` };
  else out.push(next);
};

type Fill = Readonly<Record<string, string | number | readonly Segment[]>>;

/**
 * A message's segments: its own words in `tone`, each `{name}` replaced by its text or its
 * segments (`{n} {failed}, then passed` with `failed` red). A placeholder with no value stays.
 */
const fill = (template: string, params: Fill, tone: Tone = "inherit"): Segment[] => {
  const out: Segment[] = [];
  for (const piece of template.split(/(\{\w+\})/g)) {
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    const value = name === undefined ? undefined : params[name];
    if (value === undefined) pushSegment(out, seg(piece, tone));
    else if (typeof value === "string" || typeof value === "number") pushSegment(out, seg(String(value), tone));
    else for (const part of value) pushSegment(out, part);
  }
  return out;
};

const join = (groups: readonly (readonly Segment[])[], separator: string): Segment[] => {
  const out: Segment[] = [];
  groups.forEach((group, index) => {
    if (index > 0) pushSegment(out, seg(separator));
    for (const part of group) pushSegment(out, part);
  });
  return out;
};

/** Inline code in a plan entry or a message (`Add \`src/keys/shortcuts.ts\``) as mono segments. */
const inlineCode = (text: string, tone: Tone): Segment[] => {
  const out: Segment[] = [];
  text.split(/`([^`]+)`/g).forEach((piece, index) => {
    pushSegment(out, index % 2 === 1 ? code(piece, tone) : seg(piece, tone));
  });
  return out;
};

const capitalized = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** `one` for 1, `other` for the rest, with `{n}`. */
const counted = (tr: Translate, n: number, one: MessageKey, other: MessageKey, params: MessageParams = {}): string => tr(n === 1 ? one : other, { ...params, n });

/** As `counted`, with `two` for 2 (`searched the code twice`). */
const countedTwice = (tr: Translate, n: number, one: MessageKey, two: MessageKey, other: MessageKey): string => tr(n === 1 ? one : n === 2 ? two : other, { n });

/**
 * A step's duration: `0.3 s`, `4.1 s`, `38 s`, `2 min 5 s`, `3 min`, `1 h 4 min`. It rounds before
 * it picks the unit, so 9.95 s reads `10 s` and 59.6 s `1 min`, never `10.0 s` or `60 s`.
 */
export const stepDuration = (ms: number, tr: Translate): string => {
  const tenths = Math.round(ms / 100);
  if (tenths < 100) return tr("units.secondsSpaced", { n: (tenths / 10).toFixed(1) });
  const total = Math.round(ms / 1000);
  if (total < 60) return tr("units.secondsSpaced", { n: total });
  const minutes = Math.floor(total / 60);
  if (minutes >= 60) return tr("units.hoursMinutes", { h: Math.floor(minutes / 60), m: minutes % 60 });
  const seconds = total % 60;
  return seconds === 0 ? tr("units.minutes", { n: minutes }) : tr("units.minutesSecondsSpaced", { m: minutes, s: seconds });
};

/** The live step's clock, `m:ss` (`h:mm:ss` past an hour), from the turn's start. */
export const elapsedClock = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${String(hours)}:${String(minutes).padStart(2, "0")}:${seconds}` : `${String(minutes)}:${seconds}`;
};

/** `$0.62`, `<$0.01` for a spend under a cent. */
const usd = (microUsd: number): string => (microUsd > 0 && microUsd < 10_000 ? "<$0.01" : `$${(microUsd / 1_000_000).toFixed(2)}`);

const effortWord = (level: EffortLevel, tr: Translate): string => tr(`effort.levels.${level}`);

/** The first line of an error, 160 characters at most: what happened, never the whole output. */
const firstLine = (text: string): string => {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return line.length <= 160 ? line : `${line.slice(0, 159).trimEnd()}…`;
};

// ---- a run's line (parts.md part 4) ---------------------------------------------------------

/** Reads and edits share a noun when both say `file` or both `files`: `Read 2 files, edited 2`. */
const sharesNoun = (previous: RunCount | undefined, count: RunCount): boolean =>
  previous !== undefined && (previous.kind === "read" || previous.kind === "edit") && (count.kind === "read" || count.kind === "edit") && (previous.n === 1) === (count.n === 1);

const countWords = (count: RunCount, previous: RunCount | undefined, run: RunItem, tr: Translate): string => {
  const { n } = count;
  const shared = sharesNoun(previous, count);
  switch (count.kind) {
    case "read":
      return shared ? tr("task.run.readShort", { n }) : counted(tr, n, "task.run.read.one", "task.run.read.other");
    case "edit":
      return shared ? tr("task.run.editShort", { n }) : counted(tr, n, "task.run.edit.one", "task.run.edit.other");
    case "command":
      return counted(tr, n, "task.run.command.one", "task.run.command.other");
    case "search":
      return countedTwice(tr, n, "task.run.search.one", "task.run.search.two", "task.run.search.other");
    case "web-search":
      return countedTwice(tr, n, "task.run.webSearch.one", "task.run.webSearch.two", "task.run.webSearch.other");
    case "fetch":
      return counted(tr, n, "task.run.fetch.one", "task.run.fetch.other");
    case "screenshot":
      return counted(tr, n, "task.run.screenshot.one", "task.run.screenshot.other");
    case "recording":
      return counted(tr, n, "task.run.recording.one", "task.run.recording.other");
    case "subagent":
      return counted(tr, n, "task.run.subagent.one", "task.run.subagent.other");
    case "setup": {
      const setup = run.steps.find((step) => step.kind === "setup");
      const ms = setup?.kind === "setup" ? setup.ms : null;
      return ms === null ? tr("task.run.setupUntimed") : tr("task.run.setup", { duration: stepDuration(ms, tr) });
    }
    case "compaction":
      return counted(tr, n, "task.run.compaction.one", "task.run.compaction.other");
    case "tool":
      return counted(tr, n, "task.run.tool.one", "task.run.tool.other");
    default:
      return count.kind satisfies never;
  }
};

/** Each member once, in the order they first answered, with how many they answered. */
const byMember = <T extends { readonly by: MemberId },>(answers: readonly T[]): { readonly by: MemberId; readonly answers: readonly T[] }[] => {
  const groups = new Map<MemberId, T[]>();
  for (const answer of answers) groups.set(answer.by, [...(groups.get(answer.by) ?? []), answer]);
  return [...groups].map(([by, list]) => ({ by, answers: list }));
};

/**
 * A run's line: its thought's time, its counts in the order each kind first happened, joined by
 * `, `, the first capitalized, a shared noun dropped (`Read 2 files, edited 2`), `twice` for two
 * searches, and `{n} steps:` first over 20 steps. Then its tail after ` · `: a failure the turn
 * recovered from (`1 failed, then passed`) and its approvals' answers (`1 approved by Sam Rivera`,
 * `1 denied by Alex Kim, with a reason`), `failed` and `denied` red. A failure the turn didn't
 * recover from isn't in the tail: it has its own line (`failureWords`).
 */
export const runLineWords = (run: RunItem, tr: Translate, nameOf: NameOf): Segment[] => {
  const facts: string[] = [];
  if (run.thought !== null) facts.push(run.thought.ms === null ? tr("task.run.thoughtUntimed") : tr("task.run.thought", { n: Math.max(1, Math.round(run.thought.ms / 1000)) }));
  run.counts.forEach((count, index) => {
    facts.push(countWords(count, run.counts[index - 1], run, tr));
  });
  const joined = facts.join(", ");
  const head = run.total > 20 ? tr("task.run.steps", { n: run.total, counts: joined }) : capitalized(joined);
  const tail: Segment[][] = [];
  if (run.failures.recovered > 0) tail.push(fill(tr("task.run.recovered"), { n: run.failures.recovered, failed: [seg(tr("task.run.failed"), "red")] }));
  for (const group of byMember(run.approvals.approved)) tail.push(fill(tr("task.run.approved"), { n: group.answers.length, name: nameOf(group.by) }));
  for (const group of byMember(run.approvals.denied)) {
    const reasons = group.answers.filter((answer) => answer.withReason).length;
    const denied = fill(tr("task.run.deniedBy"), { n: group.answers.length, name: nameOf(group.by), denied: [seg(tr("task.run.denied"), "red")] });
    tail.push(reasons === 0 ? denied : [...denied, seg(counted(tr, reasons, "task.run.withReason.one", "task.run.withReason.other"))]);
  }
  return head === "" ? join(tail, " · ") : join([[seg(head)], ...tail], " · ");
};

// ---- a step of an opened run (parts.md part 6) ----------------------------------------------

/** What a step's link opens: its output, its diff, the whole thought, its matches, its input, the setup's log, the PR's text, the subagents window, or a failure's details. */
export type StepLinkKind = "output" | "diff" | "thought" | "results" | "input" | "log" | "body" | "subagent" | "details";

/** A step's link: its label (`output`, `hide output`; the part draws the chevron) and the name a screen reader hears (`Show the output of pnpm test history`). */
export type StepLink = { readonly opens: StepLinkKind; readonly label: string; readonly name: string };

/** How a step reads on its row: its verb, its subject, its result, an answered approval's receipt words, and its link. */
export type StepWords = {
  /** `Read`, `Edited` (`Editing` while it runs), `Ran`, … `null` for milestone 8's info lines, whose words are the subject. */
  readonly verb: string | null;
  readonly subject: readonly Segment[];
  readonly result: readonly Segment[];
  /** `approved once by Sam Rivera`, `denied by Alex Kim`; `null` when no person answered an approval. */
  readonly receipt: string | null;
  readonly link: StepLink | null;
};

/** `open`: the step's output, diff or text is open under it, so its link reads `hide …`. `now`: a running command's time so far. */
export type StepWordsOptions = { readonly open: boolean; readonly now: number };

/** A step's link, by what it opens. `subject` names the step for a screen reader. */
export const stepLink = (opens: StepLinkKind, open: boolean, subject: string, tr: Translate): StepLink => {
  const link = (label: MessageKey, hide: MessageKey, name: MessageKey, hideName: MessageKey): StepLink => ({ opens, label: tr(open ? hide : label), name: tr(open ? hideName : name, { subject }) });
  switch (opens) {
    case "output":
      return link("task.step.link.output", "task.step.link.hideOutput", "task.step.linkName.output", "task.step.linkName.hideOutput");
    case "diff":
      return link("task.step.link.diff", "task.step.link.hideDiff", "task.step.linkName.diff", "task.step.linkName.hideDiff");
    case "thought":
      return link("task.step.link.show", "task.step.link.hide", "task.step.linkName.thought", "task.step.linkName.hideThought");
    case "results":
      return link("task.step.link.results", "task.step.link.hideResults", "task.step.linkName.results", "task.step.linkName.hideResults");
    case "input":
      return link("task.step.link.input", "task.step.link.hideInput", "task.step.linkName.input", "task.step.linkName.hideInput");
    case "log":
      return link("task.step.link.log", "task.step.link.hideLog", "task.step.linkName.log", "task.step.linkName.hideLog");
    case "body":
      return link("task.step.link.body", "task.step.link.hideBody", "task.step.linkName.body", "task.step.linkName.hideBody");
    case "subagent":
      return { opens, label: tr("task.step.link.open"), name: tr("task.step.linkName.subagent", { subject }) };
    case "details":
      return link("task.step.link.details", "task.step.link.hideDetails", "task.step.linkName.details", "task.step.linkName.hideDetails");
    default:
      return opens satisfies never;
  }
};

/** An answered approval's words on its row (milestone 3's receipts, lower case after the result). */
const approvalReceipt = (step: RunStep, tr: Translate, nameOf: NameOf): string | null => {
  const { approval } = step;
  if (approval?.state !== "answered") return null;
  switch (approval.decision) {
    case "allow_once":
      return tr("task.step.receipt.once", { name: nameOf(approval.by) });
    case "allow_task":
      return tr("task.step.receipt.task", { name: nameOf(approval.by) });
    case "deny":
      return tr("task.step.receipt.denied", { name: nameOf(approval.by) });
    default:
      return approval.decision satisfies never;
  }
};

/** A step that didn't come out: failed in red, denied in red, expired or cancelled in `--faint`. `null` for one that ran. */
const settledResult = (step: RunStep, tr: Translate): Segment | null => {
  if (step.state === "failed") return seg(tr("task.step.failed"), "red");
  if (step.state !== "cancelled") return null;
  const { approval } = step;
  if (approval?.state === "answered" && approval.decision === "deny") return seg(tr("task.step.denied"), "red");
  if (approval?.state === "closed" && approval.reason === "expired") return seg(tr("task.step.expired"), "faint");
  return seg(tr("task.step.cancelled"), "faint");
};

const running = (step: RunStep): boolean => step.state === "running";

/** A path's last name: `src/history/store.ts` → `store.ts`. */
const fileName = (path: string): string => path.split("/").filter((name) => name !== "").at(-1) ?? path;

/** `web :5173`, `:5173`, `web`: the preview a capture or a preview shows. */
const previewTarget = (preview: { readonly label: string | null; readonly port: number | null }, tr: Translate): string => {
  if (preview.label !== null && preview.port !== null) return tr("task.step.previewOn", { label: preview.label, port: preview.port });
  if (preview.port !== null) return tr("task.step.previewPort", { port: preview.port });
  return preview.label ?? tr("task.step.previewApp");
};

const ostraWords = (tool: OstraToolKind, inFlight: boolean, tr: Translate): string => (inFlight ? tr(`task.step.ostraRunning.${tool}`) : tr(`task.step.ostra.${tool}`));

/** A fetch's address as its row shows it: the host and the path, or the whole URL when it doesn't parse. */
const fetchSubject = (step: Extract<RunStep, { kind: "fetch" }>): string => (step.host === null ? step.url : `${step.host}${step.path ?? ""}`);

/** An app process's milestone 8 words: starting, ready on its port, exited, failed or stopped. */
const appProcessWords = (process: AppProcessData, tr: Translate): string => {
  switch (process.state) {
    case "starting":
      return tr("task.app.starting", { name: process.name, port: process.port });
    case "ready":
      return tr("task.app.ready", { name: process.name, port: process.port });
    case "exited":
    case "failed":
      if (process.reason === "ready-timeout") return tr("task.app.didntAnswer", { name: process.name });
      return process.exitCode === null ? tr("task.app.failed", { name: process.name }) : tr("task.app.exited", { name: process.name, code: process.exitCode });
    case "stopped":
      return tr("task.app.stopped", { name: process.name });
    default:
      return process.state satisfies never;
  }
};

/**
 * One step of an opened run (parts.md part 6): `Read` and every file the run read, `Edited` and
 * `+48 −6` (U+2212), `Ran` and `✓ exit 0 · 3.8 s` or `exit 1 · 4.1 s`, a thought's excerpt, a
 * search's matches, a fetch's status, a capture's route, a subagent's calls and state, ostra's own
 * tools in their own words, a tool by its name (its MCP server before it, never `other`), and the
 * link that opens what the step has, named for its step.
 */
export const stepWords = (step: RunStep, tr: Translate, nameOf: NameOf, options: StepWordsOptions): StepWords => {
  const receipt = approvalReceipt(step, tr, nameOf);
  const settled = settledResult(step, tr);
  const words = (verb: string | null, subject: readonly Segment[], result: readonly Segment[], link: StepLinkKind | null): StepWords => ({
    verb,
    subject,
    result,
    receipt,
    link: link === null ? null : stepLink(link, options.open, segmentsText(subject), tr),
  });
  const orSettled = (result: readonly Segment[]): readonly Segment[] => (settled === null ? result : [settled]);
  switch (step.kind) {
    case "read":
      // Every read of the run on one row, by the files' names (parts.md part 6); the full paths are the row's `title`.
      return words(tr("task.step.read"), [code(step.paths.map(fileName).join(", "))], orSettled(running(step) ? [] : [seg(counted(tr, step.paths.length, "task.step.files.one", "task.step.files.other"), "faint")]), null);
    case "edit": {
      // The fold gives 0 and 0 when the agent sent no counts: that edit shows no size, never `+0`.
      const size: Segment[] = [];
      if (step.added > 0) pushSegment(size, code(tr("task.step.added", { n: step.added }), "green"));
      if (step.removed > 0) {
        if (size.length > 0) pushSegment(size, seg(" "));
        pushSegment(size, code(tr("task.step.removed", { n: step.removed }), "red"));
      }
      return words(running(step) ? tr("task.step.editing") : tr("task.step.edited"), [code(step.path)], orSettled(running(step) ? [] : size), step.files.some((file) => file.patch !== null) ? "diff" : null);
    }
    case "command": {
      const result: Segment[] = [];
      if (running(step)) {
        if (step.startedAt !== null) pushSegment(result, code(stepDuration(Math.max(0, options.now - step.startedAt), tr), "faint"));
      } else if (step.exit === 0) pushSegment(result, code(tr("task.step.exitOk"), "green"));
      else if (step.exit === "killed") pushSegment(result, code(tr("task.step.killed"), "red"));
      else if (step.exit !== null) pushSegment(result, code(tr("task.step.exit", { code: step.exit }), "red"));
      else if (settled !== null) pushSegment(result, settled);
      if (!running(step) && step.ms !== null && step.exit !== null) {
        pushSegment(result, seg(" · ", "faint"));
        pushSegment(result, code(stepDuration(step.ms, tr), "faint"));
      }
      return words(running(step) ? tr("task.step.running") : tr("task.step.ran"), [code(step.line)], result, step.output === null && !running(step) ? null : "output");
    }
    case "thought":
      return words(tr("task.step.thought"), [seg(step.excerpt, "faint")], [], step.text.length > step.excerpt.length ? "thought" : null);
    case "search":
      return words(
        tr("task.step.searched"),
        step.folder === null ? [code(step.query)] : fill(tr("task.step.searchIn"), { query: [code(step.query)], folder: step.folder }, "faint"),
        orSettled(step.matches === null ? [] : [seg(counted(tr, step.matches, "task.step.matches.one", "task.step.matches.other"), "faint")]),
        step.matches === null ? null : "results",
      );
    case "web-search":
      return words(tr("task.step.searched"), step.query === null ? [seg(tr("task.step.web"))] : fill(tr("task.step.webFor"), { query: [code(step.query)] }), orSettled([]), null);
    case "fetch": {
      const status = step.status === null ? null : step.status.text === null ? String(step.status.code) : tr("task.step.status", { code: step.status.code, text: step.status.text });
      const result = step.state === "failed" ? [seg(status ?? tr("task.step.failed"), "red")] : status === null ? orSettled([]) : [seg(status, "faint")];
      return words(running(step) ? tr("task.step.fetching") : tr("task.step.fetched"), [code(fetchSubject(step))], result, step.state === "failed" ? "details" : null);
    }
    case "capture": {
      const route = [code(step.route)];
      const subject =
        step.media === "recording"
          ? fill(tr("task.step.recordingOf"), { route })
          : step.count === 1
            ? fill(tr("task.step.shotOf"), { route })
            : fill(tr("task.step.shotsOf"), { n: step.count, route });
      return words(tr("task.step.captured"), subject, [seg(previewTarget(step.preview, tr), "faint")], null);
    }
    case "subagent": {
      const { node } = step;
      const subject = node.type === null ? [seg(node.description)] : [code(node.type), seg(tr("task.step.subagentAbout", { description: node.description }), "faint")];
      const ms = node.startedAt === null ? null : (node.endedAt ?? options.now) - node.startedAt;
      const calls = counted(tr, node.callCount, "task.step.calls.one", "task.step.calls.other");
      const result: Segment[] = [seg(ms === null ? calls : tr("task.step.callsFor", { calls, duration: stepDuration(Math.max(0, ms), tr) }), "faint"), seg(" ")];
      switch (node.state) {
        case "done":
          pushSegment(result, seg(tr("task.step.subagentState.done"), "green"));
          break;
        case "running":
          pushSegment(result, seg(tr("task.step.subagentState.running"), "teal"));
          break;
        case "needs-approval":
          pushSegment(result, seg(tr("task.step.subagentState.needsApproval"), "amber"));
          break;
        case "failed":
          pushSegment(result, seg(tr("task.step.subagentState.failed"), "red"));
          break;
        case "stopped":
          pushSegment(result, seg(tr("task.step.subagentState.stopped"), "faint"));
          break;
        default:
          return node.state satisfies never;
      }
      return words(tr("task.step.subagent"), subject, result, "subagent");
    }
    case "setup": {
      const result: Segment[] = [];
      if (step.state === "done") {
        pushSegment(result, seg(step.ms === null ? tr("task.step.setupDone") : tr("task.step.setupDoneIn", { duration: stepDuration(step.ms, tr) }), "green"));
        if (step.cache !== null) {
          pushSegment(result, seg(" · ", "faint"));
          pushSegment(result, seg(step.cache === "warm" ? tr("task.step.warmCache") : tr("task.step.coldCache"), "faint"));
        }
      } else if (step.state === "failed") pushSegment(result, seg(step.exitCode === null ? tr("task.step.failed") : tr("task.step.exit", { code: step.exitCode }), "red"));
      return words(running(step) ? tr("task.step.settingUp") : tr("task.step.setUp"), [seg(tr("task.step.theBox"))], result, step.output.length === 0 ? null : "log");
    }
    case "pr-text":
      return words(
        tr("task.step.wrote"),
        step.title === null ? [seg(tr("task.step.prText"))] : fill(tr("task.step.prTextTitled"), { title: [seg(step.title, "subject")] }),
        orSettled([]),
        step.body === null ? null : "body",
      );
    case "ostra":
      return words(ostraWords(step.tool, running(step), tr), [], orSettled(step.outcome === "already-in" ? [seg(tr("task.step.alreadyIn"), "faint")] : []), null);
    case "tool":
      return words(
        running(step) ? tr("task.step.using") : tr("task.step.used"),
        step.server === null ? [code(step.name)] : fill(tr("task.step.toolOn"), { server: [code(step.server, "faint")], tool: [code(step.name)] }),
        orSettled([]),
        step.input === null || step.input === undefined ? null : "input",
      );
    case "compaction":
      return words(running(step) ? tr("task.step.compacting") : tr("task.step.compacted"), [seg(tr("task.step.theContext"))], orSettled([]), null);
    case "info": {
      const { info } = step;
      switch (info.about) {
        case "app-process":
          return words(null, [seg(appProcessWords(info.appProcess, tr), info.appProcess.state === "exited" || info.appProcess.state === "failed" ? "red" : "muted")], [], null);
        case "capture-skipped":
          return words(null, [seg(attachmentSkippedWords(info.skipped), "muted")], [], null);
        case "no-browser":
          return words(null, [seg(tr("task.attachments.noBrowser"), "muted")], [], null);
        default:
          return info satisfies never;
      }
    }
    default:
      return step satisfies never;
  }
};

// ---- the live step (parts.md part 5) --------------------------------------------------------

/** The live step's words: what the agent does now, its progress, its clock, and what a screen reader hears. */
export type LiveStepWords = {
  /** `Running` + mono `pnpm test history`: the words `subject`, the subject mono `text`. */
  readonly doing: readonly Segment[];
  /** `Plan step 1 of 6: …`, `8 steps done, 1 failed`, ` · `-joined, `--faint` with `failed` red. */
  readonly progress: readonly Segment[];
  /** `3:52` since the turn started; `null` without its start. */
  readonly clock: string | null;
  /** The doing and the progress without the clock: the polite live region's words (a new step, never each tick). */
  readonly announcement: string;
  /** A step whose approval waits stands in the live step's place: `Wants to run …` and `needs approval` (amber). */
  readonly waiting: { readonly asks: readonly Segment[]; readonly needs: string } | null;
};

const doingWords = (doing: LiveDoing, tr: Translate): Segment[] => {
  const subject = (text: string): Segment[] => [code(text, "text")];
  switch (doing.kind) {
    case "thinking":
      return [seg(tr("task.doing.thinking"), "subject")];
    case "writing":
      return [seg(tr("task.doing.writing"), "subject")];
    case "reading":
      return doing.path === null ? [seg(tr("task.doing.readingFiles", { n: doing.count }), "subject")] : fill(tr("task.doing.reading"), { path: subject(doing.path) }, "subject");
    case "editing":
      return fill(tr("task.doing.editing"), { path: subject(doing.path) }, "subject");
    case "running":
      return fill(tr("task.doing.running"), { command: subject(doing.command) }, "subject");
    case "searching-code":
      return fill(tr("task.doing.searchingCode"), { query: subject(doing.query) }, "subject");
    case "searching-web":
      return [seg(tr("task.doing.searchingWeb"), "subject")];
    case "fetching":
      return doing.host === null ? [seg(tr("task.doing.fetchingPage"), "subject")] : fill(tr("task.doing.fetching"), { host: subject(doing.host) }, "subject");
    case "capturing":
      return doing.route === null ? [seg(tr("task.doing.capturingApp"), "subject")] : fill(tr("task.doing.capturing"), { route: subject(doing.route) }, "subject");
    case "subagent":
      return doing.type === null ? [seg(tr("task.doing.subagentUntyped"), "subject")] : fill(tr("task.doing.subagent"), { type: subject(doing.type) }, "subject");
    case "setting-up":
      return [seg(tr("task.doing.settingUp"), "subject")];
    case "compacting":
      return [seg(tr("task.doing.compacting"), "subject")];
    case "tool":
      return doing.server === null ? subject(doing.name) : fill(tr("task.step.toolOn"), { server: [code(doing.server, "faint")], tool: subject(doing.name) });
    default:
      return doing satisfies never;
  }
};

/** The step that asks, where the live step was (parts.md part 5): `Wants to run {command}`, `Wants to edit {path}`, `Wants to reach {host}`, `Wants to call {tool}`. */
export const askingStepWords = (step: RunStep, tr: Translate): Segment[] => {
  const subject = (text: string): Segment[] => [code(text, "text")];
  switch (step.kind) {
    case "command":
      return fill(tr("task.doing.wantsRun"), { command: subject(step.line) }, "subject");
    case "edit":
      return fill(tr("task.doing.wantsEdit"), { path: subject(step.path) }, "subject");
    case "read":
      return fill(tr("task.doing.wantsRead"), { path: subject(step.paths.join(", ")) }, "subject");
    case "fetch":
      return fill(tr("task.doing.wantsReach"), { host: subject(step.host ?? step.url) }, "subject");
    case "tool":
      return fill(tr("task.doing.wantsCall"), { tool: subject(step.name) }, "subject");
    case "search":
    case "web-search":
    case "thought":
    case "capture":
    case "subagent":
    case "setup":
    case "pr-text":
    case "ostra":
    case "compaction":
    case "info":
      return fill(tr("task.doing.wantsCall"), { tool: subject(step.fullSubject) }, "subject");
    default:
      return step satisfies never;
  }
};

/**
 * The live step (parts.md part 5): what the agent does now (`Running pnpm test history`), then
 * the plan step in progress (`Plan step 1 of 6: Add src/keys/shortcuts.ts`), the turn's finished
 * steps and its failures not yet recovered (`8 steps done, 1 failed`), and the clock from the
 * turn's start. A step whose approval waits is `waiting`: `Wants to run pnpm db:migrate` and
 * `needs approval`.
 */
export const liveStepWords = (live: LiveStep, tr: Translate, now: number): LiveStepWords => {
  const doing = doingWords(live.doing, tr);
  const facts: Segment[][] = [];
  if (live.planStep !== null) facts.push(fill(tr("task.doing.planStep"), { i: live.planStep.index, n: live.planStep.of, entry: inlineCode(live.planStep.entry, "inherit") }));
  if (live.done > 0) {
    const done = counted(tr, live.done, "task.doing.stepsDone.one", "task.doing.stepsDone.other");
    facts.push(live.failed === 0 ? [seg(done)] : fill(tr("task.doing.withFailed"), { done, n: live.failed, failed: [seg(tr("task.doing.failed"), "red")] }));
  }
  const progress = join(facts, " · ");
  const words = segmentsText(doing);
  return {
    doing,
    progress,
    clock: live.startedAt === null ? null : elapsedClock(now - live.startedAt),
    announcement: progress.length === 0 ? words : `${words} · ${segmentsText(progress)}`,
    waiting: live.waiting === null ? null : { asks: askingStepWords(live.waiting, tr), needs: tr("task.doing.needsApproval") },
  };
};

// ---- a failure the turn didn't recover from (parts.md part 7) -------------------------------

/** A failure's own line: `Command failed`, its subject, what happened, and the link that opens it. */
export type FailureWords = {
  /** In `--red`: `Command failed`, `Fetch failed`, `get_pull_request failed`, `The turn failed`. */
  readonly title: string;
  /** Mono `--text-2`: the command, the path, the address; `null` for a turn, a crash, a lost box. */
  readonly subject: string | null;
  /** In `--muted` after ` · `: `exit 2 after 38 s`, `403 Forbidden, not retried`, the turn's error. */
  readonly detail: string | null;
  readonly link: StepLink | null;
};

/** `retried`: a later step of the same kind and subject ran and failed too (ticket 10 knows the run); a fetch's line says `not retried` otherwise. */
export type FailureContext = { readonly agent: string; readonly retried: boolean };

const stepFailure = (step: RunStep, tr: Translate, retried: boolean): FailureWords => {
  const error = step.error === null ? null : firstLine(step.error);
  const failed = (title: string, subject: string | null, detail: string | null = error, link: StepLinkKind | null = error === null ? null : "details"): FailureWords => ({
    title,
    subject,
    detail: detail === "" ? null : detail,
    link: link === null ? null : stepLink(link, false, subject ?? title, tr),
  });
  switch (step.kind) {
    case "command": {
      const after = step.ms === null ? null : stepDuration(step.ms, tr);
      const detail =
        step.exit === "killed"
          ? after === null ? tr("task.step.killed") : tr("task.failure.killedAfter", { duration: after })
          : step.exit !== null
            ? after === null ? tr("task.step.exit", { code: step.exit }) : tr("task.failure.exitAfter", { code: step.exit, duration: after })
            : error;
      return failed(tr("task.failure.command"), step.line, detail, "output");
    }
    case "edit":
      return failed(tr("task.failure.edit"), step.path);
    case "read":
      return failed(tr("task.failure.read"), step.paths.join(", "));
    case "fetch": {
      const status = step.status === null ? error : step.status.text === null ? String(step.status.code) : tr("task.step.status", { code: step.status.code, text: step.status.text });
      return failed(tr("task.failure.fetch"), fetchSubject(step), status === null || retried ? status : tr("task.failure.notRetried", { status }), "details");
    }
    case "search":
      return failed(tr("task.failure.search"), step.query);
    case "web-search":
      return failed(tr("task.failure.webSearch"), step.query);
    case "capture":
      return failed(tr("task.failure.capture"), step.route);
    case "subagent":
      return failed(tr("task.failure.subagent"), step.node.description, step.node.error === undefined ? error : firstLine(step.node.error));
    case "setup":
      return failed(tr("task.failure.setup"), null, step.exitCode === null ? error : tr("task.step.exit", { code: step.exitCode }), step.output.length === 0 ? null : "log");
    case "pr-text":
      return failed(tr("task.failure.prText"), step.title);
    case "ostra":
      return failed(tr("task.failure.doing", { doing: ostraWords(step.tool, true, tr) }), null);
    case "tool":
      return failed(tr("task.failure.tool", { tool: step.name }), step.server);
    case "compaction":
      return failed(tr("task.failure.compaction"), null);
    case "thought":
    case "info":
      return failed(tr("task.failure.step"), null);
    default:
      return step satisfies never;
  }
};

/**
 * A failure's own red line (parts.md part 7): a step the turn didn't recover from
 * (`Command failed pnpm build · exit 2 after 38 s · output`), a failed turn
 * (`The turn failed · {error}`), a crashed session, and a lost box
 * (`The box was lost before OpenCode answered.`).
 */
export const failureWords = (failure: TurnFailure, tr: Translate, context: FailureContext): FailureWords => {
  switch (failure.cause) {
    case "step":
      return stepFailure(failure.step, tr, context.retried);
    case "turn":
      return { title: tr("task.failure.turn"), subject: null, detail: failure.error.trim() === "" ? null : firstLine(failure.error), link: null };
    case "crashed":
      return { title: tr("task.failure.crashed"), subject: null, detail: failure.event.error.trim() === "" ? null : firstLine(failure.event.error), link: null };
    case "lost":
      return { title: tr("task.failure.lost", { agent: context.agent }), subject: null, detail: null, link: null };
    default:
      return failure satisfies never;
  }
};

// ---- a stop that isn't an error (parts.md part 7, `.notice`) --------------------------------

export type NoticeActionKind = "keep-working" | "raise-cap" | "open-spend" | "answer-anyway";

/** A notice's quiet line and its teal action. */
export type NoticeWords = { readonly text: string; readonly action: { readonly kind: NoticeActionKind; readonly label: string } | null };

/** `project`: the task's project, for a budget hold; `capMicroUsd`: the task's spend cap, when it has one. */
export type NoticeContext = { readonly project: string; readonly capMicroUsd: number | null };

const monthName = (at: number): string => new Intl.DateTimeFormat("en-GB", { month: "long" }).format(at);

/**
 * A stop that isn't an error (parts.md part 7): a session limit (`Stopped: no progress for 10
 * minutes.`, `Keep working`), the spend cap (`Raise the cap`), a budget hold (`Open spend`), and an
 * approval nobody answered in time (`Answer anyway`).
 */
export const noticeWords = (notice: TurnNotice, tr: Translate, context: NoticeContext): NoticeWords => {
  const action = (kind: NoticeActionKind, label: MessageKey): NoticeWords["action"] => ({ kind, label: tr(label) });
  switch (notice.cause) {
    case "limit":
      switch (notice.limit.limit) {
        case "max-duration":
          return { text: tr("task.notice.maxDuration", { n: Math.round(notice.limit.observed) }), action: action("keep-working", "task.notice.keepWorking") };
        case "stall":
          return { text: tr("task.notice.stall", { n: Math.round(notice.limit.observed) }), action: action("keep-working", "task.notice.keepWorking") };
        case "spend-cap":
          return {
            text: context.capMicroUsd === null ? tr("task.notice.spendCap") : tr("task.notice.spendCapOf", { cap: usd(context.capMicroUsd) }),
            action: action("raise-cap", "task.notice.raiseCap"),
          };
        default:
          return notice.limit.limit satisfies never;
      }
    case "held":
      switch (notice.held.scope) {
        case "project":
          return { text: tr("task.notice.heldProject", { project: context.project, month: monthName(notice.held.at) }), action: action("open-spend", "task.notice.openSpend") };
        case "organization":
          return { text: tr("task.notice.heldOrganization", { month: monthName(notice.held.at) }), action: action("open-spend", "task.notice.openSpend") };
        default:
          return notice.held.scope satisfies never;
      }
    case "approval-expired": {
      const { startedAt, endedAt } = notice.step;
      const minutes = startedAt === null || endedAt === null ? null : Math.round((endedAt - startedAt) / 60_000);
      return {
        text: minutes === null || minutes < 1 ? tr("task.notice.expired") : counted(tr, minutes, "task.notice.expiredAfter.one", "task.notice.expiredAfter.other"),
        action: action("answer-anyway", "task.notice.answerAnyway"),
      };
    }
    default:
      return notice satisfies never;
  }
};

// ---- checks and CI: one vocabulary (parts.md part 13) ---------------------------------------

/** A head's CI as `tasks.get` gives it: running, passed, failed or none, in jobs, with every failing job. */
export type HeadCi = Pick<NonNullable<RouterOutputs["tasks"]["get"]["repos"][number]["ci"]>, "state" | "jobs" | "failingJobs">;

/** `2 of 4 jobs`: the code host's CI counted in jobs (the panel's CI row, Home's board). */
export const ciJobsWords = (jobs: HeadCi["jobs"], tr: Translate): string => counted(tr, jobs.total, "task.ci.jobsOf.one", "task.ci.jobsOf.other", { done: jobs.done, total: jobs.total });

/** `e2e`, `e2e and 2 more`. */
const failingJobsWords = (jobs: readonly string[], tr: Translate): string | null => {
  const [first] = jobs;
  if (first === undefined) return null;
  return jobs.length === 1 ? first : tr("task.ci.more", { job: first, n: jobs.length - 1 });
};

/**
 * The PR card's live CI line (parts.md part 10): `CI on GitHub: running, 2 of 4 jobs done`
 * (` · then the AI review` when the project's AI review is on), `CI on GitHub passed · 4 jobs`,
 * `CI on GitHub failed: e2e` with `failed` red, `No CI on GitHub`.
 */
export const ciLine = (ci: HeadCi, tr: Translate, options: { readonly aiReview: boolean }): Segment[] => {
  switch (ci.state) {
    case "running": {
      const line = [seg(ci.jobs.total === 0 ? tr("task.ci.runningNoJobs") : counted(tr, ci.jobs.total, "task.ci.running.one", "task.ci.running.other", { done: ci.jobs.done, total: ci.jobs.total }))];
      return options.aiReview ? [...line, seg(" · ", "faint"), seg(tr("task.ci.thenReview"), "faint")] : line;
    }
    case "passed":
      return [seg(ci.jobs.total === 0 ? tr("task.ci.passedNoJobs") : counted(tr, ci.jobs.total, "task.ci.passed.one", "task.ci.passed.other"))];
    case "failed": {
      const failed = [seg(tr("task.ci.failed"), "red")];
      const jobs = failingJobsWords(ci.failingJobs, tr);
      return jobs === null ? fill(tr("task.ci.failedNoJobs"), { failed }) : fill(tr("task.ci.failedJobs"), { failed, jobs: [code(jobs, "text")] });
    }
    case "none":
      return [seg(tr("task.ci.none"), "faint")];
    default:
      return ci.state satisfies never;
  }
};

/** The panel's CI row (parts.md part 15): its state word and, after ` · `, its jobs: `Running · 2 of 4 jobs`, `Passed · 4 jobs`, `Failed · e2e`, `No CI`. */
export const ciRow = (ci: HeadCi, tr: Translate): { readonly state: string; readonly detail: string | null } => {
  switch (ci.state) {
    case "running":
      return { state: tr("task.ci.row.running"), detail: ci.jobs.total === 0 ? null : ciJobsWords(ci.jobs, tr) };
    case "passed":
      return { state: tr("task.ci.row.passed"), detail: ci.jobs.total === 0 ? null : counted(tr, ci.jobs.total, "task.ci.jobs.one", "task.ci.jobs.other") };
    case "failed":
      return { state: tr("task.ci.row.failed"), detail: failingJobsWords(ci.failingJobs, tr) };
    case "none":
      return { state: tr("task.ci.row.none"), detail: null };
    default:
      return ci.state satisfies never;
  }
};

/** ostra's checks in the box, on a push's line (parts.md part 8): `3 checks passed in the box`, `1 of 3 checks failed in the box` with `failed` red. */
export const checksLine = (checks: CheckCounts, tr: Translate): Segment[] =>
  checks.failed === 0
    ? [seg(counted(tr, checks.total, "task.result.checks.passed.one", "task.result.checks.passed.other"))]
    : fill(tr(checks.total === 1 ? "task.result.checks.failed.one" : "task.result.checks.failed.other"), { k: checks.failed, n: checks.total, failed: [seg(tr("task.result.checks.failedWord"), "red")] });

/** The panel's Checks row (parts.md part 15): `3 of 3 passed` and, `--faint`, `in the box`. */
export const checksRow = (checks: CheckCounts, tr: Translate): { readonly value: string; readonly place: string } => ({
  value: checks.failed === 0 ? tr("task.result.checks.rowPassed", { passed: checks.passed, total: checks.total }) : tr("task.result.checks.rowFailed", { failed: checks.failed, total: checks.total }),
  place: tr("task.result.checks.inTheBox"),
});

// ---- what a turn made (parts.md part 8 and 10) ----------------------------------------------

export type ResultActionKind = "open-review" | "open-draft" | "show-preview" | "review-memory";

/** A result line's words (its subject `subject`, mono where it's code) and its teal action. */
export type ResultWords = { readonly words: readonly Segment[]; readonly action: { readonly kind: ResultActionKind; readonly label: string } | null };

/** A push's place: `later` when it pushed to a PR already open (one line, no card), with that head's CI once it says. */
export type PushContext = { readonly later: boolean; readonly ci: HeadCi["state"] | null };

const verdictWords = (blocking: number, nits: number, tr: Translate): string => {
  if (blocking === 0 && nits === 0) return tr("task.result.verdict.clean");
  const blockingWords = blocking === 0 ? tr("task.result.verdict.nothingBlocking") : tr("task.result.verdict.blocking", { n: blocking });
  const nitWords = nits === 0 ? tr("task.result.verdict.noNits") : counted(tr, nits, "task.result.verdict.nits.one", "task.result.verdict.nits.other");
  return tr("task.result.verdict.both", { blocking: blockingWords, nits: nitWords });
};

const pushWords = (push: Extract<TurnResult, { kind: "push" }>["push"], tr: Translate, context: PushContext): Segment[] => {
  const facts: Segment[][] = [];
  const checks = push.checks;
  if (context.later) {
    facts.push(fill(tr("task.result.pushedSha"), { sha: [code(push.headSha.slice(0, 7))] }));
    if (checks !== null && checks.failed > 0) facts.push(checksLine(checks, tr));
    switch (context.ci) {
      case "passed":
        facts.push([seg(tr("task.result.ciPassed"))]);
        break;
      case "failed":
        facts.push(fill(tr("task.result.ciFailed"), { failed: [seg(tr("task.ci.failed"), "red")] }));
        break;
      case "running":
        facts.push([seg(tr("task.result.ciRunning"))]);
        break;
      case "none":
      case null:
        break;
      default:
        return context.ci satisfies never;
    }
    return join(facts, " · ");
  }
  facts.push(fill(tr("task.result.pushed"), { branch: [code(push.branch)] }));
  if (checks !== null) facts.push(checks.failed === 0 ? checksLine(checks, tr) : fill(tr("task.result.checksDraft"), { checks: checksLine(checks, tr) }));
  return join(facts, " · ");
};

/** `web :5173` and the path, as a preview result names them. */
const previewWords = (preview: Extract<TurnResult, { kind: "preview" }>["preview"], tr: Translate): Segment[] => {
  const target = [code(previewTarget(preview, tr))];
  return preview.path === null ? fill(tr("task.result.preview"), { target }) : fill(tr("task.result.previewPath"), { target, path: [code(preview.path, "faint")] });
};

/**
 * What a turn made, one line each (parts.md part 8): a push (`Pushed {branch} · 3 checks passed in
 * the box`; a later one `Pushed {sha7} · CI passed`), the first PR's card (`#483` and its title),
 * a review posted or confirmed, a draft, the preview shown, a memory proposed.
 */
export const resultWords = (result: TurnResult, tr: Translate, push: PushContext = { later: false, ci: null }): ResultWords => {
  switch (result.kind) {
    case "push":
      return { words: pushWords(result.push, tr, push), action: null };
    case "pr":
      return {
        words: [code(tr("task.result.prNumber", { n: result.pr.number }), "teal"), seg(" "), seg(result.pr.title ?? tr("task.result.prUntitled"), "text")],
        action: null,
      };
    case "review": {
      const { review } = result;
      const [post] = review.posted;
      const pr = post === undefined ? null : [seg(tr("task.result.pr", { n: post.prNumber }), "teal")];
      const verdict = verdictWords(review.blocking, review.nits, tr);
      if (pr === null) return { words: fill(tr("task.result.reviewHandedIn"), { verdict }), action: null };
      return {
        words: review.repeat ? fill(tr("task.result.reviewConfirmed"), { pr }) : fill(tr("task.result.reviewPosted"), { pr, verdict }),
        action: { kind: "open-review", label: tr("task.result.openReview") },
      };
    }
    case "draft": {
      const { draft } = result;
      const counts =
        draft.acceptanceCriteria === null || draft.subTickets === null
          ? null
          : tr("task.result.draftCounts", {
              criteria: counted(tr, draft.acceptanceCriteria, "task.result.criteria.one", "task.result.criteria.other"),
              subTickets: counted(tr, draft.subTickets, "task.result.subTickets.one", "task.result.subTickets.other"),
            });
      return {
        words: [seg(counts === null ? tr("task.result.draft", { n: draft.version }) : tr("task.result.draftWith", { n: draft.version, counts }))],
        action: { kind: "open-draft", label: tr("task.result.openDraft") },
      };
    }
    case "preview":
      return { words: previewWords(result.preview, tr), action: { kind: "show-preview", label: tr("task.result.show") } };
    case "memory":
      return { words: fill(tr("task.result.memory"), { title: [seg(result.memory.title, "subject")] }), action: { kind: "review-memory", label: tr("task.result.reviewMemory") } };
    default:
      return result satisfies never;
  }
};

/** A row of a push opened in place, on the opened run's grid: its verb, its subject, its result and its link. */
export type PushRowWords = {
  readonly verb: string;
  readonly subject: readonly Segment[];
  readonly result: readonly Segment[];
  readonly link: { readonly label: string; readonly name: string } | null;
};

/**
 * A push opened in place (ticket 14, parts.md part 8): its commit row, `Pushed 9c1e2f0 · 4 commits
 * ahead of main` with `changes ›` to the Changes tab once the code host's compare of that head is
 * in (`diff.get`), the commit alone before.
 */
export const pushCommitWords = (headSha: string, compare: { readonly aheadBy: number; readonly base: string } | null, tr: Translate): PushRowWords => {
  const sha = headSha.slice(0, 7);
  return {
    verb: tr("task.result.open.pushed"),
    subject: [code(sha)],
    result: compare === null ? [] : [seg(counted(tr, compare.aheadBy, "task.result.open.ahead.one", "task.result.open.ahead.other", { base: compare.base }), "faint")],
    link: compare === null ? null : { label: tr("task.result.open.changes"), name: tr("task.result.open.changesName", { sha }) },
  };
};

/** One of the push's checks in the box, as the Checks tab keeps it (`tasks.checks`). */
export type PushCheck = {
  readonly name: string;
  readonly status: "waiting" | "running" | "passed" | "failed" | "timed-out" | "error";
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly timeoutMs: number;
};

/**
 * A check of the push's turn under its commit (ostra's, in the box): `Checked Tests ✓ passed ·
 * 12.8 s`; a failing one red, with `output ›` to its output in the Checks tab.
 */
export const pushCheckWords = (check: PushCheck, tr: Translate): PushRowWords => {
  const result: Segment[] = [];
  switch (check.status) {
    case "passed":
      pushSegment(result, seg(`✓ ${tr("checks.status.passed")}`, "green"));
      break;
    case "failed":
      pushSegment(result, seg(check.exitCode === null ? tr("checks.status.failedNoCode") : tr("checks.status.failed", { code: check.exitCode }), "red"));
      break;
    case "timed-out":
      pushSegment(result, seg(tr("checks.status.timedOut", { limit: stepDuration(check.timeoutMs, tr) }), "red"));
      break;
    case "error":
      pushSegment(result, seg(tr("checks.status.error"), "red"));
      break;
    case "waiting":
      pushSegment(result, seg(tr("checks.status.waiting"), "faint"));
      break;
    case "running":
      pushSegment(result, seg(tr("checks.status.running"), "faint"));
      break;
    default:
      return check.status satisfies never;
  }
  if ((check.status === "passed" || check.status === "failed") && check.durationMs !== null) {
    pushSegment(result, seg(" · ", "faint"));
    pushSegment(result, seg(stepDuration(check.durationMs, tr), "faint"));
  }
  const failing = check.status === "failed" || check.status === "timed-out" || check.status === "error";
  return {
    verb: tr("task.result.open.checked"),
    subject: [code(check.name)],
    result,
    link: failing ? { label: tr("task.step.link.output"), name: tr("task.result.open.checkOutputName", { name: check.name }) } : null,
  };
};

/** The PR card's size, summed from the Changes tab's files: `+214` green, `−18` red (U+2212). */
export const prSizeWords = (size: { readonly added: number; readonly removed: number }): readonly Segment[] => [
  code(`+${String(size.added)}`, "green"),
  seg(" "),
  code(`−${String(size.removed)}`, "red"),
];

// ---- a member's message and ostra's (parts.md part 2, ticket 12) ----------------------------

/** `{login} on GitHub`: a PR comment's or a review's author; `GitHub` when its login isn't in view. */
export const githubAuthorWords = (login: string | null, tr: Translate): string => (login === null ? tr("task.bubble.github") : tr("task.bubble.onGitHub", { login }));

/** An AI review's head: `AI review of PR #483` (its 600 part) and `, round 2 of 3`. */
export const aiReviewHeadWords = (prs: readonly number[], round: { readonly number: number; readonly of: number }, tr: Translate): { readonly title: string; readonly round: string } => {
  const [only] = prs;
  return {
    title: prs.length === 1 && only !== undefined ? tr("task.bubble.aiReview.one", { n: only }) : tr("task.bubble.aiReview.many", { n: prs.length }),
    round: tr("task.bubble.aiReview.round", { n: round.number, of: round.of }),
  };
};

/** What an AI review reads: `3 files, +203 −6 · the PR's commits, CALC-192 and its criteria`, its counts mono. */
export const aiReviewReadsWords = (
  input: { readonly files: number; readonly added: number; readonly removed: number; readonly prs: number; readonly ticketKey: string | null; readonly criteria: boolean },
  tr: Translate,
): Segment[] => {
  const size = fill(tr(input.files === 1 ? "task.bubble.aiReview.files.one" : "task.bubble.aiReview.files.other"), {
    files: [code(String(input.files), "inherit")],
    lines: [code(`+${String(input.added)} −${String(input.removed)}`, "inherit")],
  });
  const reads =
    input.prs > 1
      ? tr("task.bubble.aiReview.readsMany")
      : input.ticketKey === null || input.ticketKey === ""
        ? tr("task.bubble.aiReview.reads")
        : tr(input.criteria ? "task.bubble.aiReview.readsCriteria" : "task.bubble.aiReview.readsTicket", { key: input.ticketKey });
  return [...size, seg(` · ${reads}`)];
};

/** `automatic turn 1 of 4`: the turns ostra started by itself since a person last acted, of the limit. */
export const automaticTurnWords = (k: number, limit: number, tr: Translate): string => tr("task.bubble.automaticTurn", { k, limit });

/**
 * A findings round's line (parts.md part 2): `Sent 1 blocking finding: The store keeps 51 results.
 * 1 nit listed, not required.`, the titles `--text` (milestone 6's words, three titles at most).
 */
export const findingsSentSegments = (findings: readonly { readonly severity: "blocking" | "nit"; readonly title: string }[], tr: Translate): Segment[] => {
  const blocking = findings.filter((finding) => finding.severity === "blocking");
  const nits = findings.length - blocking.length;
  const more = blocking.length > 3 ? tr("review.round.andMore", { n: blocking.length - 3 }) : "";
  const titles = [seg(`${blocking.slice(0, 3).map((finding) => finding.title).join(", ")}${more}`, "text")];
  const sent = blocking.length === 0 ? [seg(tr("review.round.sentNone"))] : fill(tr(blocking.length === 1 ? "review.round.sent.one" : "review.round.sent.other", { n: blocking.length }), { titles });
  return nits === 0 ? sent : [...sent, seg(` ${counted(tr, nits, "review.round.nits.one", "review.round.nits.other")}`)];
};

/** How a late answer's prompt marks a member's own words (`Something else…`) after its field's label. */
const OWN_WORDS = " (in their own words)";

/**
 * A late answer's words, from the answers its prompt carried (`Label: value` a line, a member's
 * own words marked): each value, own words quoted, `, `-joined.
 */
export const lateAnswersWords = (answers: string, tr: Translate): string =>
  answers
    .split("\n")
    .flatMap((line) => {
      const colon = line.indexOf(": ");
      if (colon === -1) return line.trim() === "" ? [] : [line.trim()];
      const value = line.slice(colon + 2);
      return [line.slice(0, colon).endsWith(OWN_WORDS) ? tr("task.receipt.quoted", { words: value }) : value];
    })
    .join(", ");

// ---- receipts and dividers (parts.md part 12) -----------------------------------------------

/** A settled need, in its block's place. */
export type ReceiptInput =
  | { readonly kind: "question"; readonly question: QuestionData }
  /** A late answer whose question isn't in view: who answered, and the answers its message carried. */
  | { readonly kind: "answered"; readonly by: MemberId; readonly answers: string }
  /** A late approval's answer (sent as a reopen): milestone 3's receipt words, and what it asked. */
  | { readonly kind: "approval"; readonly by: MemberId; readonly decision: "allow_once" | "allow_task" | "deny"; readonly request: string | null; readonly reason: string | null }
  | { readonly kind: "plan-approved"; readonly by: MemberId; readonly edited: boolean }
  | { readonly kind: "plan-changes"; readonly by: MemberId }
  | { readonly kind: "plan-unanswered" }
  | { readonly kind: "keep-working"; readonly by: MemberId }
  | { readonly kind: "without-saved-work"; readonly by: MemberId };

/** A receipt's words (the chosen value `subject`), whether it shows the `check` (a decision was made), and its teal link. */
export type ReceiptWords = { readonly words: readonly Segment[]; readonly settled: boolean; readonly action: string | null };

/** An answer as its receipt shows it: a choice as it is, words a member typed (`Something else…`) quoted. */
const answerWords = (question: QuestionData, answers: Readonly<Record<string, string>>, tr: Translate): string =>
  question.fields
    .flatMap((field) => {
      const value = answers[field.id];
      if (value === undefined) return [];
      const ownWords = field.type === "select" && !(field.options ?? []).includes(value);
      return [ownWords ? tr("task.receipt.quoted", { words: value }) : value];
    })
    .join(", ");

/**
 * A receipt (parts.md part 12): `Sam Rivera answered Replace the display`, `Demo answered “…”` for
 * words of their own, `Plan approved by Alex Kim, with edits` and `Show the plan`, `Changes asked
 * by …`, `… pressed Keep working`, `… carried on without the saved work`. `null` for a question
 * that's still open: its block stands.
 */
export const receiptWords = (receipt: ReceiptInput, tr: Translate, nameOf: NameOf): ReceiptWords | null => {
  switch (receipt.kind) {
    case "question": {
      const { status } = receipt.question;
      switch (status.state) {
        case "open":
          return null;
        case "answered":
          return { words: fill(tr("task.receipt.answered"), { name: nameOf(status.answeredBy), choice: [seg(answerWords(receipt.question, status.answers, tr), "subject")] }), settled: true, action: null };
        case "closed":
          return { words: [seg(tr(`task.receipt.questionClosed.${status.closedReason}`))], settled: false, action: null };
        default:
          return status satisfies never;
      }
    }
    case "answered":
      return { words: fill(tr("task.receipt.answered"), { name: nameOf(receipt.by), choice: [seg(lateAnswersWords(receipt.answers, tr), "subject")] }), settled: true, action: null };
    case "approval": {
      const name = nameOf(receipt.by);
      const head =
        receipt.decision === "allow_once"
          ? tr("taskAnswers.receipt.once", { name })
          : receipt.decision === "allow_task"
            ? tr("taskAnswers.receipt.task", { name })
            : receipt.reason === null || receipt.reason === ""
              ? tr("taskAnswers.receipt.denied", { name })
              : tr("taskAnswers.receipt.deniedWhy", { name, reason: receipt.reason });
      return { words: [seg(head), ...(receipt.request === null ? [] : [seg(" · "), code(receipt.request)])], settled: true, action: null };
    }
    case "plan-approved":
      return { words: [seg(tr(receipt.edited ? "task.receipt.planApprovedEdited" : "task.receipt.planApproved", { name: nameOf(receipt.by) }))], settled: true, action: tr("task.receipt.showPlan") };
    case "plan-changes":
      return { words: [seg(tr("task.receipt.planChanges", { name: nameOf(receipt.by) }))], settled: true, action: null };
    case "plan-unanswered":
      return { words: [seg(tr("task.receipt.planUnanswered"))], settled: false, action: null };
    case "keep-working":
      return { words: [seg(tr("task.receipt.keepWorking", { name: nameOf(receipt.by) }))], settled: true, action: null };
    case "without-saved-work":
      return { words: [seg(tr("task.receipt.withoutSavedWork", { name: nameOf(receipt.by) }))], settled: true, action: null };
    default:
      return receipt satisfies never;
  }
};

type Restored = Extract<SystemEvent, { readonly kind: "session.restored" }>;

/** A change a reader needs between turns. */
export type DividerInput =
  | { readonly kind: "day"; readonly at: number }
  | { readonly kind: "restored"; readonly event: Restored; readonly runner: string | null }
  | { readonly kind: "plan-turn" }
  | { readonly kind: "build-turn" }
  | { readonly kind: "plan-again"; readonly by: MemberId }
  | { readonly kind: "driver"; readonly change: DriverChangeData }
  | { readonly kind: "effort"; readonly change: EffortChangeData }
  | { readonly kind: "stopped"; readonly by: MemberId; readonly at: number };

/** A divider's words and, for a member's change, its time (`14:11`). */
export type DividerWords = { readonly text: string; readonly time: string | null };

/** `agent`: the task's agent (`OpenCode`); `now`: today, for the day's divider. */
export type DividerContext = { readonly nameOf: NameOf; readonly agent: string; readonly now: number };

const startOfDay = (at: number): number => {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};

/** `Today`, `Yesterday`, `Mon 17 Nov`, `17 Nov 2025` in another year. */
const dayWords = (at: number, now: number, tr: Translate): string => {
  const day = startOfDay(at);
  const today = startOfDay(now);
  if (day === today) return tr("task.divider.today");
  if (day === startOfDay(today - 12 * 3_600_000)) return tr("task.divider.yesterday");
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat("en-GB", sameYear ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" }).format(at);
};

const restoredWords = (event: Restored, runner: string | null, tr: Translate): string => {
  const head = (() => {
    switch (event.origin) {
      case "restored":
        return runner === null ? tr("task.divider.restoredHere") : tr("task.divider.restored", { runner });
      case "resumed":
        return tr("task.divider.resumed");
      case "rebuilt":
        // Minor 2's `fallbackReason`: why the restore fell back, in the runner's words (never content).
        return event.fallbackReason === undefined ? tr("task.divider.rebuilt") : tr("task.divider.rebuiltBecause", { reason: event.fallbackReason });
      case undefined:
        return tr("task.divider.restoredHere");
      default:
        return event.origin satisfies never;
    }
  })();
  switch (event.hiddenRef) {
    case "applied":
      return `${head} · ${tr("task.divider.workRestored")}`;
    case "conflict":
      return `${head} · ${tr("task.divider.workConflict")}`;
    case "none":
    case undefined:
      return head;
    default:
      return event.hiddenRef satisfies never;
  }
};

/**
 * A divider (parts.md part 12): the day, how a session came back (`Restored from the session
 * archive on alex-desktop · unfinished work restored`), the plan and build turns' markers, a new
 * driver, a level change and a stop with their times. Bookkeeping is never one.
 */
export const dividerWords = (divider: DividerInput, tr: Translate, context: DividerContext): DividerWords => {
  const { nameOf, agent } = context;
  switch (divider.kind) {
    case "day":
      return { text: dayWords(divider.at, context.now, tr), time: null };
    case "restored":
      return { text: restoredWords(divider.event, divider.runner, tr), time: null };
    case "plan-turn":
      return { text: tr("task.divider.planTurn", { agent }), time: null };
    case "build-turn":
      return { text: tr("task.divider.buildTurn", { agent }), time: null };
    case "plan-again":
      return { text: tr("task.divider.planAgain", { agent, name: nameOf(divider.by) }), time: null };
    case "driver": {
      const { memberId, byMemberId } = divider.change;
      if (memberId === null) return { text: tr("task.divider.driverDropped", { by: nameOf(byMemberId) }), time: null };
      return { text: memberId === byMemberId ? tr("task.divider.tookOver", { name: nameOf(memberId) }) : tr("task.divider.driver", { name: nameOf(memberId), by: nameOf(byMemberId) }), time: null };
    }
    case "effort": {
      const { change } = divider;
      return { text: tr(change.duringTurn ? "task.divider.effortNextTurn" : "task.divider.effort", { name: nameOf(change.memberId), level: effortWord(change.to, tr) }), time: formatClock(change.at) };
    }
    case "stopped":
      return { text: tr("task.divider.stopped", { name: nameOf(divider.by) }), time: formatClock(divider.at) };
    default:
      return divider satisfies never;
  }
};

// ---- a turn's numbers: the footer and the time's tooltip (parts.md parts 6 and 9) -----------

/** What the footer and the tooltip read of a turn's message. */
export type TurnNumbers = Pick<TaskMessageMeta, "ordinal" | "at" | "endedAt" | "turnState" | "effort" | "adjustedFrom" | "usage" | "spend" | "saved" | "ended">;

/** One fact of the footer, and its tooltip (the clamp's sentence). */
export type FooterFact = { readonly text: string; readonly tip: string | null };

/** A review or refine task changes no code, so it has no saved work to speak of (the README's choice 10). */
const keepsWork = (kind: TaskKind): boolean => {
  switch (kind) {
    case "code":
      return true;
    case "review":
    case "refine":
      return false;
    default:
      return kind satisfies never;
  }
};

/** The level it ran at (`High`; nothing at `Default`), or the clamp (`Max, asked Extra high`) with its sentence. */
const levelFact = (turn: TurnNumbers, tr: Translate): FooterFact | null => {
  const ran = turn.effort ?? "default";
  if (turn.adjustedFrom !== undefined) {
    const level = effortWord(ran, tr);
    const asked = effortWord(turn.adjustedFrom, tr);
    return { text: tr("task.footer.clamped", { level, asked }), tip: ran === "default" ? tr("tasks.effort.ranAtDefault") : tr("tasks.effort.ranAt", { level, asked }) };
  }
  return ran === "default" ? null : { text: effortWord(ran, tr), tip: null };
};

const estimated = (value: string, estimate: boolean, tr: Translate): string => (estimate ? tr("task.footer.estimate", { value }) : value);

const open = (turn: TurnNumbers): boolean => turn.turnState === "running";

/** The spend, `≈` before an estimate, ` so far` while the turn is open. */
const spendWords = (turn: TurnNumbers, tr: Translate): string | null => {
  if (turn.spend === undefined) return null;
  const spend = estimated(usd(turn.spend.microUsd), turn.spend.estimated, tr);
  return open(turn) ? tr("task.footer.soFar", { spend }) : spend;
};

/** What was kept after the turn: `saved, archive 193 kB`, `not saved yet` while it's open, `unfinished work not saved`, `no archive (the upload failed)`, `ended without changes`. */
const savedFacts = (turn: TurnNumbers, tr: Translate): string[] => {
  const facts: string[] = [];
  if (turn.saved !== undefined) {
    facts.push(turn.saved.archiveBytes === null ? tr("task.footer.noArchive") : tr("task.footer.saved", { size: formatSize(turn.saved.archiveBytes) }));
    if (turn.saved.unsaved > 0) facts.push(tr("task.footer.unsaved"));
  } else if (open(turn)) facts.push(tr("task.footer.notSavedYet"));
  if (turn.ended?.outcome === "without-changes") facts.push(tr("task.footer.endedWithoutChanges"));
  return facts;
};

/**
 * The opened run's footer (parts.md part 6), in its order: `Turn 4`, the level (`High`; the clamp
 * `Max, asked Extra high` with its sentence as the tip), `41.2k in`, `6.3k out`, `2.1k reasoning`
 * (left out when none), the spend (`≈` before an estimate, ` so far` while the turn is open), and
 * what was kept. A review or refine task shows none of the saved facts.
 */
export const footerFacts = (turn: TurnNumbers, kind: TaskKind, tr: Translate): FooterFact[] => {
  const facts: FooterFact[] = [];
  const plain = (text: string): FooterFact => ({ text, tip: null });
  if (turn.ordinal !== undefined) facts.push(plain(tr("task.footer.turn", { n: turn.ordinal })));
  const level = levelFact(turn, tr);
  if (level !== null) facts.push(level);
  const usage = turn.usage;
  if (usage !== undefined && usage.inputTokens + usage.outputTokens > 0) {
    facts.push(plain(estimated(tr("task.footer.in", { n: formatTokens(usage.inputTokens) }), usage.estimated, tr)));
    facts.push(plain(tr("task.footer.out", { n: formatTokens(usage.outputTokens) })));
    if (usage.reasoningTokens !== undefined && usage.reasoningTokens > 0) facts.push(plain(tr("task.footer.reasoning", { n: formatTokens(usage.reasoningTokens) })));
  }
  const spend = spendWords(turn, tr);
  if (spend !== null) facts.push(plain(spend));
  if (keepsWork(kind)) for (const fact of savedFacts(turn, tr)) facts.push(plain(fact));
  return facts;
};

/** The footer's link to the turn's first event. */
export const eventLogLinkWords = (tr: Translate): string => tr("task.footer.eventLog");

/** One row of the time's tooltip: its key (`--faint`) and its value. */
export type TooltipRow = { readonly key: string; readonly value: string };

/** The time's tooltip: its head and its rows. */
export type TooltipWords = { readonly head: string; readonly rows: readonly TooltipRow[] };

/**
 * The tooltip on a turn's time (parts.md part 9): `Turn 4 · 14:44 to 14:47` (`to now` while it's
 * open), then `Effort`, `Tokens`, `Reasoning`, `Spend` and `Saved`, the same numbers as the
 * footer. A review or refine task has no `Saved` row.
 */
export const tooltipRows = (turn: TurnNumbers, kind: TaskKind, tr: Translate): TooltipWords => {
  const start = turn.at === undefined ? null : formatClock(turn.at);
  const end = open(turn) ? tr("task.tooltip.now") : turn.endedAt === undefined ? null : formatClock(turn.endedAt);
  const span = start === null ? null : end === null ? start : tr("task.tooltip.span", { start, end });
  const head =
    turn.ordinal === undefined
      ? (span ?? "")
      : span === null
        ? tr("task.footer.turn", { n: turn.ordinal })
        : tr("task.tooltip.head", { n: turn.ordinal, span });
  const rows: TooltipRow[] = [];
  const level = levelFact(turn, tr);
  if (level !== null) rows.push({ key: tr("task.tooltip.effort"), value: level.text });
  const usage = turn.usage;
  if (usage !== undefined && usage.inputTokens + usage.outputTokens > 0) {
    rows.push({ key: tr("task.tooltip.tokens"), value: estimated(tr("task.tooltip.tokensValue", { in: formatTokens(usage.inputTokens), out: formatTokens(usage.outputTokens) }), usage.estimated, tr) });
    if (usage.reasoningTokens !== undefined && usage.reasoningTokens > 0) rows.push({ key: tr("task.tooltip.reasoning"), value: formatTokens(usage.reasoningTokens) });
  }
  const spend = spendWords(turn, tr);
  if (spend !== null) rows.push({ key: tr("task.tooltip.spend"), value: spend });
  if (keepsWork(kind)) {
    const saved =
      turn.saved === undefined
        ? open(turn) ? [tr("task.tooltip.notYet")] : []
        : [turn.saved.archiveBytes === null ? tr("task.footer.noArchive") : tr("task.tooltip.archive", { size: formatSize(turn.saved.archiveBytes) }), ...(turn.saved.unsaved > 0 ? [tr("task.footer.unsaved")] : [])];
    if (saved.length > 0) rows.push({ key: tr("task.tooltip.saved"), value: saved.join(", ") });
  }
  return { head, rows };
};

// ---- the status line's box (parts.md part 15) -----------------------------------------------

/** The box as `tasks.get` gives it. */
export type BoxStatus = Pick<NonNullable<RouterOutputs["tasks"]["get"]["box"]>, "state" | "idleStopDueAt">;

/**
 * The status line's box when no turn runs (the README's choice 15): `box idle, stops in 11 min`
 * (the minutes rounded up), `box stopped`, `box released`. `null` while it starts, runs or failed:
 * the status line then says what the turn does.
 */
export const boxStatusWords = (box: BoxStatus, now: number, tr: Translate): string | null => {
  switch (box.state) {
    case "idle":
      return box.idleStopDueAt === null ? tr("task.status.box.idle") : tr("task.status.box.idleStops", { n: Math.max(1, Math.ceil((box.idleStopDueAt - now) / 60_000)) });
    case "stopped":
      return tr("task.status.box.stopped");
    case "released":
      return tr("task.status.box.released");
    case "starting":
    case "running":
    case "failed":
      return null;
    default:
      return box.state satisfies never;
  }
};

// ---- what waits on a member (parts.md part 11) ----------------------------------------------

/** What an open block asks for, as the pill names it. */
export type PillNeed = { readonly kind: "question" } | { readonly kind: "plan" } | { readonly kind: "approval"; readonly count: number } | { readonly kind: "reply" } | { readonly kind: "other" };

/** The pill on its band (parts.md part 11): `Needs you · question`, `· plan`, `· approval` (`· 2 approvals`), `· reply`, or `Needs you`. The arrow is the part's icon. */
export const pillWords = (need: PillNeed, tr: Translate): string => {
  switch (need.kind) {
    case "question":
      return tr("task.needs.pill.question");
    case "plan":
      return tr("task.needs.pill.plan");
    case "approval":
      return counted(tr, need.count, "task.needs.pill.approval.one", "task.needs.pill.approval.other");
    case "reply":
      return tr("task.needs.pill.reply");
    case "other":
      return tr("task.needs.pill.other");
    default:
      return need satisfies never;
  }
};

/** `Something else…`, the last choice of every enum question an agent takes words for, and its field's accessible name. */
export const somethingElseWords = (tr: Translate): { readonly choice: string; readonly field: string } => ({
  choice: tr("task.needs.somethingElse"),
  field: tr("task.needs.somethingElseField"),
});
