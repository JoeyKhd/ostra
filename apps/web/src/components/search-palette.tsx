"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppWindowIcon, ArrowRightIcon, BoxIcon, Building2Icon, CheckIcon, ChevronRightIcon, CircleStopIcon, CornerDownLeftIcon, CpuIcon, FolderIcon, FolderPlusIcon, GitPullRequestIcon, HandIcon, HouseIcon, KeyboardIcon, ListChecksIcon, Maximize2Icon, MessageSquareIcon, MessageSquareReplyIcon, MoonIcon, PanelLeftIcon, PlusIcon, RotateCcwIcon, SearchIcon, ServerIcon, SlidersHorizontalIcon, SquarePenIcon, SunIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { Dialog } from "radix-ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { clientMessageIdSchema } from "@ostra/protocol";

import { KbdSequence, isMac } from "@/components/shell/actions/kbd-sequence";
import { paletteRows } from "@/components/shell/actions/palette-actions";
import type { ActionRow } from "@/components/shell/actions/palette-actions";
import { StepRow, stepChip, stepEmpty, stepPlaceholder, stepRun, waitingOf } from "@/components/shell/actions/palette-step";
import type { PaletteStep, StepOption, StepTask } from "@/components/shell/actions/palette-step";
import type { PaletteActionId, PaletteContext } from "@/components/shell/actions/registry";
import type { ActionScope } from "@/components/shell/actions/use-scope";
import { destinations, matchDestinations } from "@/components/shell/destinations";
import type { Destination, DestinationIcon } from "@/components/shell/destinations";
import { projectColour } from "@/components/shell/project-colour";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { Highlight, resultHref, SnippetLine } from "./search/highlight";
import { joinQuery, pendingKey, pendingValue, splitQuery, statusValues, tokenKeys } from "./search/search-query";
import type { Token } from "./search/search-query";

type Result = RouterOutputs["search"]["suggest"]["results"][number];

const icons: Record<Exclude<DestinationIcon, "project">, ReactNode> = {
  home: <HouseIcon />,
  "new-task": <SquarePenIcon />,
  tasks: <ListChecksIcon />,
  environment: <BoxIcon />,
  "new-project": <PlusIcon />,
  runners: <ServerIcon />,
  models: <CpuIcon />,
  github: <GitPullRequestIcon />,
  "agent-profiles": <SlidersHorizontalIcon />,
};

/** Each action's Lucide icon (command-palette.md, "Icons"). */
const actionIcon = (id: PaletteActionId, shownTheme: "dark" | "light"): ReactNode => {
  switch (id) {
    case "go-needs-you":
      return <HandIcon />;
    case "go-home":
      return <HouseIcon />;
    case "go-tasks":
      return <ListChecksIcon />;
    case "go-projects":
      return <FolderIcon />;
    case "go-organization":
      return <Building2Icon />;
    case "toggle-sidebar":
      return <PanelLeftIcon />;
    case "search":
      return <SearchIcon />;
    case "shortcut-sheet":
      return <KeyboardIcon />;
    case "new-task":
      return <PlusIcon />;
    case "new-project":
      return <FolderPlusIcon />;
    case "toggle-theme":
      return shownTheme === "dark" ? <SunIcon /> : <MoonIcon />;
    case "approve":
      return <CheckIcon />;
    case "deny":
      return <XIcon />;
    case "answer":
      return <MessageSquareReplyIcon />;
    case "take-over":
      return <HandIcon />;
    case "reopen":
      return <RotateCcwIcon />;
    case "stop":
      return <CircleStopIcon />;
    case "steer":
      return <MessageSquareIcon />;
    case "toggle-side-pane":
      return <AppWindowIcon />;
    case "expand-preview":
      return <Maximize2Icon />;
    default:
      return id satisfies never;
  }
};

/** The destinations an action row already covers: they aren't listed twice. */
const coveredByActions: ReadonlySet<DestinationIcon> = new Set(["home", "new-task", "new-project"]);

const DestinationMark = ({ destination }: { readonly destination: Destination }) =>
  destination.icon === "project" ? (
    <span aria-hidden className="mx-[3.5px] size-2 shrink-0 rounded-[2px]" style={{ background: destination.colour }} />
  ) : (
    icons[destination.icon]
  );

/** The 150 ms the palette waits after a key before it asks (search-palette.md, "Typing"). */
const DEBOUNCE_MS = 150;

const useDebounced = (value: string, ms: number): string => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => { setDebounced(value); }, ms);
    return () => { clearTimeout(timer); };
  }, [value, ms]);
  return debounced;
};

type Item =
  | { readonly kind: "result"; readonly result: Result }
  | { readonly kind: "all" }
  | { readonly kind: "page"; readonly destination: Destination }
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "action"; readonly row: ActionRow };

const stateWord = (state: string): string => state.replaceAll("_", " ");

type Failure = { readonly message: string; readonly data?: { readonly code?: string } | null | undefined };

/** What the palette needs from the shell to run actions (F-081, ticket 13). */
export type PaletteActions = {
  readonly scope: ActionScope;
  readonly context: PaletteContext;
  readonly shownTheme: "dark" | "light";
  /** Runs an action that needs no second step (the palette closes first). */
  readonly run: (id: PaletteActionId) => void;
  /** The shell's toast and live region. */
  readonly announce: (text: string) => void;
  /** Opens the `?` sheet in the palette's place. */
  readonly openSheet: () => void;
};

/** Where the palette opens: its first list, or straight into a step (`o` on a stopped task). */
export type PaletteStart = { readonly step: PaletteStep | null };

const groupLabel = "flex h-7 items-center px-4 text-xs font-medium text-faint";
const rowClass = "relative mx-1.5 grid h-9 cursor-default grid-cols-[28px_minmax(0,1fr)_auto_20px] items-center rounded-lg px-2.5 text-ui text-text [&_svg]:size-[15px] [&_svg]:shrink-0 [&_svg]:stroke-[1.75] [&_svg]:text-muted";
/** The selected row: `--sel` and a 2px `--text` bar inside its left edge (the fill alone is 1.1:1). */
const selectedClass = "bg-sel before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-text";

/**
 * The command palette (F-080, F-081; search-palette.md, command-palette.md): Ctrl+K or ⌘K on every
 * panel page. With nothing typed it lists the actions for this page, the actions anywhere and `Go
 * to`; text filters them and adds the tasks `search.suggest` finds; a filter token makes it search
 * alone. An action ending in `…` picks its item in a second step inside the palette.
 */
export const SearchPalette = ({
  open,
  onOpenChange,
  admin,
  actions,
  start,
  onCloseAutoFocus,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly admin: boolean;
  readonly actions: PaletteActions;
  readonly start: PaletteStart;
  /** Gives the focus back to what had it before the palette opened (ticket 16). */
  readonly onCloseAutoFocus?: (event: Event) => void;
}) => {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const message = useRef<HTMLTextAreaElement>(null);
  const projects = useQuery(trpc.projects.list.queryOptions());
  const members = useQuery({ ...trpc.members.list.queryOptions(), enabled: open });
  const [tokens, setTokens] = useState<readonly Token[]>([]);
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const [steps, setSteps] = useState<readonly PaletteStep[]>([]);
  const [direct, setDirect] = useState(false);
  const [reopenText, setReopenText] = useState("");
  const [stepError, setStepError] = useState<string | null>(null);
  const step = steps.at(-1) ?? null;

  // Each opening starts afresh: the first list, or the step the shell asked for.
  useEffect(() => {
    if (!open) return;
    setTokens([]);
    setText("");
    setActive(0);
    setStepError(null);
    setReopenText("");
    setSteps(start.step === null ? [] : [start.step]);
    setDirect(start.step !== null);
  }, [open, start]);

  const notifications = useQuery({ ...trpc.notifications.list.queryOptions({ tab: "open" }), enabled: open });
  const waiting = useMemo(() => waitingOf(notifications.data?.rows ?? []), [notifications.data]);
  const picking = open && step?.kind === "reopen-pick";
  const stopped = useQuery({ ...trpc.search.suggest.queryOptions({ query: "status:stopped" }), enabled: picking });
  const done = useQuery({ ...trpc.search.suggest.queryOptions({ query: "status:done" }), enabled: picking });

  const settle = () => queryClient.invalidateQueries();
  const answerApproval = useMutation(trpc.approvals.answer.mutationOptions({ onSettled: settle }));
  const answerQuestion = useMutation(trpc.questions.answer.mutationOptions({ onSettled: settle }));
  const reopen = useMutation(trpc.tasks.reopen.mutationOptions({ onSettled: settle }));
  const busy = answerApproval.isPending || answerQuestion.isPending || reopen.isPending;

  const query = joinQuery(tokens, text);
  const asked = useDebounced(query, DEBOUNCE_MS);
  const pending = pendingKey(text);
  const suggest = useQuery({
    ...trpc.search.suggest.queryOptions({ query: asked }),
    enabled: open && step === null && asked.trim() !== "" && pending === null,
    placeholderData: keepPreviousData,
  });

  const all = useMemo(
    () => destinations((projects.data ?? []).map((project) => ({ id: project.id, name: project.name, colour: projectColour(project.id) })), admin),
    [projects.data, admin],
  );
  const actionMode = step === null && tokens.length === 0 && pending === null;
  const groups = actionMode
    ? paletteRows({
        role: actions.context.role,
        scope: actions.scope,
        shownTheme: actions.shownTheme,
        waiting: notifications.data === undefined ? null : { approvals: waiting.approvals.length, questions: waiting.questions.length },
        query: text,
      })
    : { page: [], actions: [], goTo: [] };
  const pages = actionMode && text.trim() !== "" ? matchDestinations(all.filter((destination) => !coveredByActions.has(destination.icon)), text).slice(0, 3) : [];

  // A key with no value yet lists the values it takes.
  const values = useMemo((): readonly string[] => {
    if (pending === null) return [];
    const typed = pendingValue(text).toLowerCase();
    const candidates = (() => {
      switch (pending) {
        case "status":
          return [...statusValues];
        case "project":
          return (projects.data ?? []).map((project) => project.slug);
        case "by":
          return ["me", ...(members.data ?? []).flatMap((member) => (member.username === null ? [] : [member.username]))];
        case "after":
        case "before":
          return [new Date().toISOString().slice(0, 10)];
        case "repo":
        case "ticket":
          return [];
        default:
          return pending satisfies never;
      }
    })();
    return candidates.filter((value) => value.toLowerCase().startsWith(typed)).slice(0, 8);
  }, [pending, text, projects.data, members.data]);

  const showTasks = step === null && pending === null && query.trim() !== "";
  const results = showTasks ? (suggest.data?.results ?? []) : [];
  const total = suggest.data?.total ?? 0;
  const reopenable = useMemo(() => {
    const seen = new Set<string>();
    const list: Result[] = [];
    for (const one of [...(stopped.data?.results ?? []), ...(done.data?.results ?? [])]) {
      if (seen.has(one.taskId)) continue;
      seen.add(one.taskId);
      list.push(one);
    }
    return list;
  }, [stopped.data, done.data]);

  // The step's list, filtered by what's typed.
  const stepOptions = useMemo((): readonly StepOption[] => {
    if (step === null) return [];
    const typed = text.trim().toLowerCase();
    const keep = (option: StepOption) => typed === "" || `${option.key ?? ""} ${option.primary} ${option.secondary ?? ""}`.toLowerCase().includes(typed);
    switch (step.kind) {
      case "approve-pick":
      case "deny-pick":
        return waiting.approvals.map((one) => ({ id: one.approvalId, key: one.key, primary: one.title, secondary: one.subject === "" ? null : one.subject, next: step.kind === "deny-pick" })).filter(keep);
      case "answer-pick":
        return waiting.questions.map((one) => ({ id: one.questionId, key: one.key, primary: one.title, secondary: one.message.split("\n")[0] ?? "", next: true })).filter(keep);
      case "answer-choice":
        return step.options.map((option) => ({ id: option, key: null, primary: option, secondary: null, next: false })).filter(keep);
      case "reopen-pick":
        return reopenable.map((one) => ({ id: one.taskId, key: one.ticketKey ?? one.taskId.slice(0, 8), primary: one.title, secondary: one.projectName, next: true })).filter(keep);
      case "deny-reason":
      case "answer-text":
      case "reopen-message":
        return [];
      default:
        return step satisfies never;
    }
  }, [step, text, waiting, reopenable]);

  const items: readonly Item[] =
    step !== null
      ? []
      : pending !== null
        ? values.map((value) => ({ kind: "value" as const, value }))
        : [
            ...[...groups.page, ...groups.actions, ...groups.goTo].map((row) => ({ kind: "action" as const, row })),
            ...results.map((result) => ({ kind: "result" as const, result })),
            ...(showTasks ? [{ kind: "all" as const }] : []),
            ...pages.map((destination) => ({ kind: "page" as const, destination })),
          ];
  const count = step === null ? items.length : stepOptions.length;

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, [open, onOpenChange]);

  // The input keeps the focus across steps; the reopen message takes it in its own step.
  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() => {
      if (step?.kind === "reopen-message") message.current?.focus();
      else input.current?.focus();
    });
    return () => { cancelAnimationFrame(frame); };
  }, [open, step]);

  const close = () => { onOpenChange(false); };
  const push = (next: PaletteStep) => {
    setSteps((now) => [...now, next]);
    setText("");
    setActive(0);
    setStepError(null);
  };
  const back = () => {
    setStepError(null);
    setText("");
    setActive(0);
    if (steps.length <= 1 && direct) {
      close();
      return;
    }
    setSteps((now) => now.slice(0, -1));
  };
  const fail = (cause: Failure) => {
    setStepError(cause.data?.code === "CONFLICT" ? t("palette.step.answeredFirst") : (errorText(cause) ?? t("errors.unknown")));
  };
  const finish = (words: string) => {
    actions.announce(words);
    close();
  };

  const seeAll = () => {
    close();
    router.push(`/search?q=${encodeURIComponent(query)}`);
  };

  /** An action row: a second step, or the shell runs it. */
  const runRow = (row: ActionRow) => {
    const task = actions.scope.task;
    if (row.step && row.id === "reopen") {
      push(task === null ? { kind: "reopen-pick" } : { kind: "reopen-message", task: { taskId: task.taskId, key: task.key, title: task.title } });
    } else if (row.step && row.id === "approve") {
      push({ kind: "approve-pick" });
    } else if (row.step && row.id === "deny") {
      push({ kind: "deny-pick" });
    } else if (row.step && row.id === "answer") {
      push({ kind: "answer-pick" });
    } else {
      close();
      actions.run(row.id);
    }
  };

  const choose = (item: Item) => {
    switch (item.kind) {
      case "result":
        close();
        router.push(resultHref(item.result.taskId, item.result.snippets));
        return;
      case "all":
        seeAll();
        return;
      case "page":
        close();
        router.push(item.destination.href);
        return;
      case "value":
        complete(item.value);
        return;
      case "action":
        runRow(item.row);
        return;
      default:
        item satisfies never;
    }
  };

  const sendReopen = (task: StepTask) => {
    const words = reopenText.trim();
    if (words === "" || busy) return;
    reopen.mutate(
      { taskId: task.taskId, clientMessageId: clientMessageIdSchema.parse(crypto.randomUUID()), text: words },
      { onSuccess: () => { finish(t("palette.toast.reopened", { key: task.key })); }, onError: fail },
    );
  };

  /** Enter in a step: on its selected row, or on what's typed. */
  const runStep = (current: PaletteStep, index: number) => {
    if (busy) return;
    const option = stepOptions[index];
    switch (current.kind) {
      case "approve-pick": {
        const approval = waiting.approvals.find((one) => one.approvalId === option?.id);
        if (approval === undefined) return;
        answerApproval.mutate({ approvalId: approval.approvalId, decision: "allow_once" }, { onSuccess: () => { finish(t("palette.toast.approved", { key: approval.key })); }, onError: fail });
        return;
      }
      case "deny-pick": {
        const approval = waiting.approvals.find((one) => one.approvalId === option?.id);
        if (approval !== undefined) push({ kind: "deny-reason", approval });
        return;
      }
      case "deny-reason": {
        const reason = text.trim();
        answerApproval.mutate(
          { approvalId: current.approval.approvalId, decision: "deny", ...(reason === "" ? {} : { reason }) },
          { onSuccess: () => { finish(t("palette.toast.denied", { key: current.approval.key })); }, onError: fail },
        );
        return;
      }
      case "answer-pick": {
        const question = waiting.questions.find((one) => one.questionId === option?.id);
        if (question === undefined) return;
        const [field, ...others] = question.fields;
        if (field !== undefined && others.length === 0 && field.type === "select" && field.options !== undefined && field.options.length > 0) {
          push({ kind: "answer-choice", question, fieldId: field.id, options: field.options });
        } else if (field !== undefined && others.length === 0) {
          push({ kind: "answer-text", question, fieldId: field.id });
        } else {
          close();
          router.push(`/tasks/${question.taskId}`);
        }
        return;
      }
      case "answer-choice":
      case "answer-text": {
        const value = current.kind === "answer-choice" ? option?.id : text.trim();
        if (value === undefined || value === "") return;
        answerQuestion.mutate(
          { taskId: current.question.taskId, questionId: current.question.questionId, answers: { [current.fieldId]: value } },
          { onSuccess: () => { finish(t("palette.toast.answered", { key: current.question.key })); }, onError: fail },
        );
        return;
      }
      case "reopen-pick": {
        const found = reopenable.find((one) => one.taskId === option?.id);
        if (found !== undefined) push({ kind: "reopen-message", task: { taskId: found.taskId, key: found.ticketKey ?? found.taskId.slice(0, 8), title: found.title } });
        return;
      }
      case "reopen-message":
        sendReopen(current.task);
        return;
      default:
        current satisfies never;
    }
  };

  /** The typed text, with its finished tokens moved into chips. */
  const takeText = (next: string) => {
    if (step !== null) {
      setText(next);
      setActive(0);
      return;
    }
    const split = splitQuery(next);
    if (split.tokens.length > 0) setTokens((previous) => [...previous, ...split.tokens]);
    setText(split.tokens.length > 0 ? split.text.trimStart() : next);
    setActive(0);
  };
  const complete = (value: string) => {
    const words = text.split(/(\s+)/);
    const last = words.pop() ?? "";
    const key = last.slice(0, last.indexOf(":"));
    takeText(`${words.join("")}${key}:${value} `);
    input.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const atStart = event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (count === 0 ? 0 : (index + 1) % count));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (count === 0 ? 0 : (index - 1 + count) % count));
    } else if (step !== null) {
      if (event.key === "Enter") {
        event.preventDefault();
        runStep(step, active);
      } else if (event.key === "ArrowRight" && stepOptions[active]?.next === true && text === "") {
        event.preventDefault();
        runStep(step, active);
      } else if ((event.key === "ArrowLeft" || event.key === "Backspace") && text === "") {
        event.preventDefault();
        back();
      }
    } else if (event.key === "?" && text === "" && tokens.length === 0) {
      event.preventDefault();
      close();
      actions.openSheet();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (query.trim() !== "") seeAll();
    } else if (event.key === "ArrowRight" && text === "" && tokens.length === 0) {
      const item = items[active];
      if (item?.kind === "action" && item.row.step) {
        event.preventDefault();
        runRow(item.row);
      }
    } else if (event.key === "Enter" || (event.key === "Tab" && pending !== null)) {
      const item = items[active];
      if (item !== undefined) {
        event.preventDefault();
        choose(item);
      }
    } else if (event.key === "Backspace" && atStart && tokens.length > 0) {
      event.preventDefault();
      const last = tokens.at(-1);
      if (last === undefined) return;
      setTokens(tokens.slice(0, -1));
      setText(`${last.key}:${last.value}${text === "" ? "" : ` ${text}`}`);
    } else if (event.key === "Escape" && pending !== null) {
      event.preventDefault();
      setText(text.replace(/\S+$/, ""));
    }
  };

  const activeId = count === 0 || active >= count ? undefined : `${listId}-${String(active)}`;
  const mac = isMac();
  const loadingSearch = suggest.isFetching && showTasks;
  const selected = (index: number) => index === active;

  const actionRowView = (row: ActionRow, index: number) => (
    <div
      key={`${row.id}-${String(index)}`}
      id={`${listId}-${String(index)}`}
      role="option"
      aria-selected={selected(index)}
      aria-haspopup={row.step ? "true" : undefined}
      data-testid="palette-action"
      data-action={row.id}
      onMouseMove={() => { setActive(index); }}
      onClick={() => { runRow(row); }}
      className={cn(rowClass, selected(index) && selectedClass)}
    >
      <span aria-hidden className="flex">{actionIcon(row.id, actions.shownTheme)}</span>
      <span className="flex min-w-0 items-baseline gap-3">
        <span className="truncate">{row.label}</span>
        {row.hint === null ? null : <span className="shrink-0 text-[13px] text-faint">{row.hint}</span>}
      </span>
      <span className="hidden justify-end sm:flex">{row.shortcut === null ? null : <KbdSequence keys={row.shortcut} />}</span>
      <span className="flex justify-end">{row.step ? <ChevronRightIcon aria-hidden className="!size-3.5 !text-faint" /> : null}</span>
    </div>
  );

  // The flat index of each group's first row, for `aria-activedescendant` and the arrows.
  const actionsStart = groups.page.length;
  const goToStart = actionsStart + groups.actions.length;
  const resultsStart = goToStart + groups.goTo.length;
  const pagesStart = resultsStart + (showTasks ? results.length + 1 : 0);
  const pageName = actions.scope.task?.key ?? null;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setActive(0);
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-(--scrim)" />
        <Dialog.Content
          aria-describedby={undefined}
          data-testid="search-palette"
          data-step={step?.kind ?? "root"}
          {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}
          onEscapeKeyDown={(event) => {
            if (step !== null) {
              event.preventDefault();
              back();
            } else if (pending !== null) {
              event.preventDefault();
            }
          }}
          className="fixed left-1/2 top-[14vh] z-50 flex max-h-[min(560px,70vh)] w-[min(680px,calc(100vw-32px))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-line-2 bg-raise shadow-(--shadow-palette) focus:outline-none max-sm:top-[58px]"
        >
          <Dialog.Title className="sr-only">{t("palette.title")}</Dialog.Title>
          <div className="relative flex min-h-[52px] shrink-0 flex-wrap items-center gap-2 border-b border-control-line px-4 py-2">
            <SearchIcon aria-hidden className="mr-1 size-4 shrink-0 stroke-[1.75] text-muted" />
            {step === null ? null : (
              <span data-testid="palette-step-chip" className="inline-flex h-6 shrink-0 items-center rounded-[5px] border border-line-2 bg-bg px-2 text-[12.5px] text-text">{stepChip(step)}</span>
            )}
            {tokens.map((token, index) => (
              <span key={`${token.key}-${String(index)}`} data-testid="search-chip" className="inline-flex h-6 shrink-0 items-center rounded-[5px] border border-line-2 bg-bg px-2 font-mono text-[12.5px]">
                <span className="text-faint">{token.key}:</span>
                <span className="text-text">{token.value}</span>
              </span>
            ))}
            <input
              ref={input}
              autoFocus
              value={text}
              readOnly={busy}
              hidden={step?.kind === "reopen-message"}
              onChange={(event) => { takeText(event.target.value); }}
              onKeyDown={onKeyDown}
              placeholder={step !== null ? t(stepPlaceholder(step)) : tokens.length === 0 ? t("palette.placeholder") : ""}
              role="combobox"
              aria-label={step === null ? t("palette.title") : `${stepChip(step)}: ${t(stepPlaceholder(step))}`}
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={activeId}
              className="min-w-[120px] flex-1 bg-transparent text-[15px] text-text placeholder:text-faint focus-visible:outline-offset-2"
            />
            <Kbd className="ml-auto shrink-0">esc</Kbd>
            {loadingSearch ? <span aria-hidden className="absolute bottom-0 left-0 h-0.5 w-1/3 animate-pulse bg-line-2" /> : null}
          </div>
          {stepError === null ? null : <p role="alert" className="border-b border-line px-4 py-2 text-[13px] text-red">{stepError}</p>}

          <div id={listId} role="listbox" aria-label={step === null ? t("palette.title") : stepChip(step)} className="min-h-0 flex-1 overflow-y-auto py-1">
            {step === null ? null : step.kind === "reopen-message" ? (
              <div className="px-4 py-3" data-testid="palette-reopen">
                <p className="font-mono text-[12.5px] text-faint">{step.task.key}</p>
                <p className="mt-0.5 text-base font-semibold text-text">{step.task.title}</p>
                <label className="mt-3 block text-xs text-muted" htmlFor={`${listId}-message`}>{t("palette.step.message")}</label>
                <textarea
                  id={`${listId}-message`}
                  ref={message}
                  rows={3}
                  value={reopenText}
                  readOnly={busy}
                  onChange={(event) => { setReopenText(event.target.value); }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      sendReopen(step.task);
                    }
                  }}
                  className="mt-1 block max-h-48 min-h-[76px] w-full resize-y rounded-lg border border-control-line bg-bg px-3 py-2 text-ui text-text placeholder:text-faint"
                />
                <p className="mt-2 text-[12.5px] text-faint">{t("palette.step.resumes")}</p>
              </div>
            ) : step.kind === "deny-reason" || step.kind === "answer-text" ? (
              <p className="px-4 py-3 text-[13px] text-muted">{step.kind === "deny-reason" ? t("palette.step.denyHint", { key: step.approval.key }) : step.question.message}</p>
            ) : stepOptions.length === 0 ? (
              <p className="px-4 py-7 text-center text-ui text-muted">{(step.kind === "reopen-pick" ? stopped.data === undefined : notifications.data === undefined) ? t("palette.step.loading") : t(stepEmpty(step))}</p>
            ) : (
              <>
                {step.kind === "answer-choice" ? <p className="px-4 pb-1 pt-2 text-[13px] text-muted">{step.question.message}</p> : null}
                {stepOptions.map((option, index) => (
                  <StepRow key={option.id} option={option} id={`${listId}-${String(index)}`} selected={selected(index)} busy={busy} onSelect={() => { setActive(index); }} onRun={() => { setActive(index); runStep(step, index); }} />
                ))}
              </>
            )}

            {step === null && pending !== null ? (
              values.length === 0 ? (
                <p className="px-4 py-3 text-[13px] text-faint">{t("search.palette.typeValue", { key: pending })}</p>
              ) : (
                values.map((value, index) => (
                  <div
                    key={value}
                    id={`${listId}-${String(index)}`}
                    role="option"
                    aria-selected={selected(index)}
                    onMouseMove={() => { setActive(index); }}
                    onClick={() => { complete(value); }}
                    className={cn("relative mx-1.5 flex h-8 cursor-default items-center rounded-lg px-2.5 font-mono text-[13px] text-text", selected(index) && selectedClass)}
                  >
                    <span className="text-faint">{pending}:</span>
                    {value}
                  </div>
                ))
              )
            ) : null}

            {groups.page.length > 0 ? (
              <div role="group" aria-labelledby={`${listId}-page`} data-group="page">
                <div id={`${listId}-page`} className={groupLabel}>
                  {t("palette.groups.page")}
                  {pageName === null ? null : <span className="ml-auto font-normal">{pageName}</span>}
                </div>
                {groups.page.map((row, offset) => actionRowView(row, offset))}
              </div>
            ) : null}
            {groups.actions.length > 0 ? (
              <div role="group" aria-labelledby={`${listId}-actions`} data-group="actions" className={cn(actionsStart > 0 && "border-t border-line")}>
                <div id={`${listId}-actions`} className={groupLabel}>{t("palette.groups.actions")}</div>
                {groups.actions.map((row, offset) => actionRowView(row, actionsStart + offset))}
              </div>
            ) : null}
            {groups.goTo.length > 0 ? (
              <div role="group" aria-labelledby={`${listId}-goto`} data-group="go-to" className={cn(goToStart > 0 && "border-t border-line")}>
                <div id={`${listId}-goto`} className={groupLabel}>{t("search.palette.goTo")}</div>
                {groups.goTo.map((row, offset) => actionRowView(row, goToStart + offset))}
              </div>
            ) : null}

            {showTasks ? (
              <div role="group" aria-labelledby={`${listId}-tasks`} className={cn(resultsStart > 0 && "border-t border-line")}>
                <div id={`${listId}-tasks`} className="flex h-[30px] items-center px-4 text-xs font-medium text-faint">
                  {t("search.palette.tasks")}
                  {suggest.data === undefined ? null : <span className="ml-auto font-mono" data-testid="search-palette-total">{plural(total, "search.palette.matchOne", "search.palette.matchOther")}</span>}
                </div>
                {suggest.isError ? (
                  <p className="px-4 py-3 text-[13px] text-red">
                    {t("search.palette.failed", { error: errorText(suggest.error) ?? "" })}{" "}
                    <button type="button" className="text-teal hover:underline" onClick={() => { void suggest.refetch(); }}>{t("search.palette.tryAgain")}</button>
                  </p>
                ) : suggest.data === undefined ? (
                  <div className="space-y-2 px-4 py-2" aria-busy>{[0, 1, 2].map((i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
                ) : results.length === 0 ? (
                  <div className="px-4 py-7 text-center">
                    <p className="text-ui text-muted">{t("search.palette.none")}</p>
                    <p className="mt-1 text-[13px] text-faint">{t("search.palette.noneHint")}</p>
                  </div>
                ) : (
                  results.map((result, offset) => {
                    const index = resultsStart + offset;
                    const titleSnippet = result.snippets.find((snippet) => snippet.kind === "title");
                    const lines = result.snippets.filter((snippet) => snippet.kind !== "title").slice(0, 2);
                    return (
                      <div
                        key={result.taskId}
                        id={`${listId}-${String(index)}`}
                        role="option"
                        aria-selected={selected(index)}
                        data-testid="search-palette-result"
                        data-task={result.taskId}
                        onMouseMove={() => { setActive(index); }}
                        onClick={() => { choose({ kind: "result", result }); }}
                        className={cn(
                          "relative mx-1.5 grid cursor-default grid-cols-[minmax(0,1fr)_40px] gap-x-3 rounded-lg border-b border-line px-2.5 py-2.5 last:border-b-0 sm:grid-cols-[88px_minmax(0,1fr)_130px_104px_40px]",
                          selected(index) && selectedClass,
                        )}
                      >
                        <span className="hidden truncate pt-0.5 font-mono text-[12.5px] text-faint sm:inline">{result.ticketKey ?? result.taskId.slice(0, 8)}</span>
                        <span className="min-w-0">
                          <span className="block truncate text-ui text-text">{titleSnippet === undefined ? result.title : <Highlight parts={titleSnippet.parts} />}</span>
                          {lines.map((snippet, line) => <SnippetLine key={line} snippet={snippet} className="mt-0.5" />)}
                        </span>
                        <span className="hidden min-w-0 items-start gap-2 pt-1 sm:flex">
                          <span aria-hidden className="mt-1 size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(result.projectId) }} />
                          <span className="truncate text-[13px] text-muted">{result.projectName}</span>
                        </span>
                        <span className="hidden truncate pt-0.5 text-[13px] text-muted sm:inline">{stateWord(result.state)}</span>
                        <span className="flex justify-end pt-0.5">{selected(index) ? <Kbd><CornerDownLeftIcon aria-hidden className="size-3" /></Kbd> : null}</span>
                      </div>
                    );
                  })
                )}
                <div
                  id={`${listId}-${String(resultsStart + results.length)}`}
                  role="option"
                  aria-selected={selected(resultsStart + results.length)}
                  data-testid="search-palette-all"
                  onMouseMove={() => { setActive(resultsStart + results.length); }}
                  onClick={seeAll}
                  className={cn("relative mx-1.5 mt-1 flex h-11 cursor-default items-center gap-2.5 rounded-lg border-t border-line px-2.5", selected(resultsStart + results.length) && selectedClass)}
                >
                  <ArrowRightIcon aria-hidden className="size-[15px] stroke-[1.75] text-muted" />
                  <span className="text-ui font-medium text-text">
                    {results.length === 0 ? t("search.palette.openPage") : plural(total, "search.palette.seeAllOne", "search.palette.seeAllOther")}
                  </span>
                  <span className="ml-auto flex gap-1"><Kbd>{mac ? "⌘" : "Ctrl"}</Kbd><Kbd>↵</Kbd></span>
                </div>
              </div>
            ) : null}

            {pages.length > 0 ? (
              <div role="group" aria-labelledby={`${listId}-pages`} className="border-t border-line">
                <div id={`${listId}-pages`} className={groupLabel}>{t("palette.groups.pages")}</div>
                {pages.map((destination, offset) => {
                  const index = pagesStart + offset;
                  return (
                    <div
                      key={`${destination.href}-${destination.icon}-${destination.context ?? ""}`}
                      id={`${listId}-${String(index)}`}
                      role="option"
                      aria-selected={selected(index)}
                      onMouseMove={() => { setActive(index); }}
                      onClick={() => { choose({ kind: "page", destination }); }}
                      className={cn(
                        "relative mx-1.5 flex h-8 cursor-default items-center gap-[9px] rounded-lg px-2.5 text-text [&_svg]:size-[15px] [&_svg]:shrink-0 [&_svg]:stroke-[1.75] [&_svg]:text-muted",
                        selected(index) && selectedClass,
                      )}
                    >
                      <DestinationMark destination={destination} />
                      <span className="min-w-0 truncate">{destination.label}</span>
                      {destination.context === undefined ? null : <span className="min-w-0 truncate text-faint">{destination.context}</span>}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>

          <div className="flex h-9 shrink-0 items-center gap-3.5 whitespace-nowrap border-t border-line px-4 text-xs text-faint">
            <span className="hidden shrink-0 items-center gap-1.5 sm:flex"><Kbd>↑</Kbd><Kbd>↓</Kbd>{t("search.palette.move")}</span>
            {step === null ? (
              <>
                <span className="hidden shrink-0 items-center gap-1.5 sm:flex"><Kbd>↵</Kbd>{t("palette.footer.run")}</span>
                {tokens.length === 0 ? (
                  <>
                    <span className="hidden shrink-0 items-center gap-1.5 md:flex"><Kbd>→</Kbd>{t("palette.footer.next")}</span>
                    <span className="hidden shrink-0 items-center gap-1.5 md:flex"><Kbd>?</Kbd>{t("palette.footer.shortcuts")}</span>
                  </>
                ) : (
                  <span className="hidden shrink-0 items-center gap-1.5 md:flex"><Kbd>{mac ? "⌘" : "Ctrl"}</Kbd><Kbd>↵</Kbd>{t("search.palette.seeAll")}</span>
                )}
                <span className="hidden shrink-0 items-center gap-1.5 sm:flex"><Kbd>esc</Kbd>{t("search.palette.close")}</span>
              </>
            ) : (
              <>
                <span className="hidden shrink-0 items-center gap-1.5 sm:flex">
                  {step.kind === "reopen-message" ? <><Kbd>{mac ? "⌘" : "Ctrl"}</Kbd><Kbd>↵</Kbd></> : <Kbd>↵</Kbd>}
                  {t(stepRun(step))}
                </span>
                <span className="hidden shrink-0 items-center gap-1.5 sm:flex"><Kbd>esc</Kbd>{t("palette.footer.back")}</span>
              </>
            )}
            {step === null ? (
              <span className="ml-auto flex min-w-0 items-center gap-1 overflow-hidden">
                {t("search.palette.filters")}
                {tokenKeys.map((key) => (
                  <button
                    key={key}
                    type="button"
                    className="font-mono hover:text-text"
                    onClick={() => {
                      takeText(`${text}${text === "" || text.endsWith(" ") ? "" : " "}${key}:`);
                      input.current?.focus();
                    }}
                  >
                    {key}:
                  </button>
                ))}
              </span>
            ) : step.kind === "reopen-message" ? (
              <button type="button" className="ml-auto text-teal hover:underline disabled:opacity-50" disabled={busy || reopenText.trim() === ""} onClick={() => { sendReopen(step.task); }} data-action="palette-reopen">
                {t("palette.step.runReopen")}
              </button>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
