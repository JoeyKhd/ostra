"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon, CheckIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { ReactNode } from "react";

import { PropRow, Section } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { Chip, Status } from "@/components/ui/status";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { PanelLabel } from "./linear-panel";
import { addressProblemText } from "./linear-status";

// "Connect Linear", grown (linear-agent-mode.md, F-012): agent mode's state and what it needs, each
// board's "Start from Linear", and the last session events. Organization admins only, as the page.

type LinearStatusData = RouterOutputs["linear"]["status"];
type Connection = Extract<LinearStatusData, { readonly state: "pending" | "active" | "failed" }>;
export type AgentMode = NonNullable<Connection["agentMode"]>;
type Board = AgentMode["boards"][number];
type SessionEvent = AgentMode["lastSessionEvents"][number];

const day = (at: number): string => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(at);
const clock = (at: number, now: number): string =>
  new Date(at).toDateString() === new Date(now).toDateString()
    ? new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at)
    : day(at);

const KeyRow = ({ label, children, testId }: { readonly label: string; readonly children: ReactNode; readonly testId?: string }) => (
  <li className="grid min-h-10 grid-cols-[160px_minmax(0,1fr)] items-center gap-x-3 border-b border-line py-1.5 text-ui" data-testid={testId}>
    <span className="text-muted">{label}</span>
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-text">{children}</span>
  </li>
);

const outcomeOf = (event: SessionEvent): string => {
  if (event.state === "awaiting_approval") return t("agentMode.outcome.waiting");
  if (event.taskId === null) return t("agentMode.outcome.ended");
  switch (event.taskState ?? "") {
    case "stopped":
      return t("agentMode.outcome.stopped");
    case "running":
    case "preparing":
      return t("agentMode.outcome.running");
    default:
      return t("agentMode.outcome.started");
  }
};

/** The board that already takes a team's delegations, when it's another one. */
const takenBy = (board: Board, boards: readonly Board[]): Board | undefined =>
  board.teamKey === null || board.startFromLinear ? undefined : boards.find((other) => other.boardId !== board.boardId && other.teamKey === board.teamKey && other.startFromLinear);

/**
 * Agent mode's State (linear-agent-mode.md): `On` with when and by whom, `On, not receiving` when
 * Linear can't reach the install's address, or `Off`.
 */
export const AgentModeState = ({ agent, justTurnedOn }: { readonly agent: AgentMode; readonly justTurnedOn: boolean }) =>
  agent.on ? (
    <>
      {agent.reachable ? <Status tone="green" className="text-green">{t("agentMode.on")}</Status> : <Status tone="red" className="text-text">{t("agentMode.onNotReceiving")}</Status>}
      <span className="text-muted">
        {agent.since === null ? "" : agent.turnedOnByName === null ? t("agentMode.onSince", { date: day(agent.since) }) : t("agentMode.onSinceBy", { date: day(agent.since), name: agent.turnedOnByName })}
      </span>
      {justTurnedOn ? (
        <span className="ml-auto flex items-center gap-1 text-faint">
          <CheckIcon aria-hidden className="size-[14px] stroke-[1.75] text-green" />
          {t("agentMode.justOn")}
        </span>
      ) : null}
    </>
  ) : (
    <Status tone="grey">{t("agentMode.off")}</Status>
  );

/** The Public address row: the address Linear's webhooks arrive at, or why Linear can't reach it. */
export const PublicAddress = ({ agent }: { readonly agent: AgentMode }) =>
  agent.reachable ? (
    <>
      <CheckIcon aria-hidden className="size-[14px] stroke-[1.75] text-green" />
      <span className="min-w-0 break-all font-mono text-text">{agent.publicAddress}</span>
      <span className="text-muted">{t("agentMode.reachable")}</span>
    </>
  ) : (
    <>
      <TriangleAlertIcon aria-hidden className="size-[14px] stroke-[1.75] text-red" />
      <span>{t("agentMode.unreachable")}</span>
      {agent.unreachableReason === null ? null : <span className="text-muted">· {addressProblemText(agent.unreachableReason)}</span>}
    </>
  );

export const AgentModeSections = ({ status, now, justTurnedOn }: { readonly status: Connection; readonly now: number; readonly justTurnedOn: boolean }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [line, setLine] = useState<{ readonly kind: "status" | "alert"; readonly text: string } | null>(null);
  // Milestone 11 (F-152): on this connection, by its ID (`trackers.linear.*`).
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.trackers.pathKey() });
  const enable = useMutation(
    trpc.trackers.linear.enableAgentMode.mutationOptions({
      onSuccess: (result) => {
        if (result.kind === "consent") window.location.assign(result.authorizeUrl);
        else void refresh();
      },
    }),
  );
  const setBoard = useMutation(
    trpc.trackers.linear.setBoardAgentMode.mutationOptions({
      onSuccess: (result) => {
        const board = status.agentMode?.boards.find((one) => one.boardId === result.boardId);
        if (board !== undefined) setLine({ kind: "status", text: result.on ? t("agentMode.nowOn", { board: board.name, team: board.teamKey ?? board.name }) : t("agentMode.nowOff", { board: board.name }) });
        void refresh();
        void queryClient.invalidateQueries({ queryKey: trpc.boards.pathKey() });
      },
      onError: (error) => {
        setLine({ kind: "alert", text: errorText(error) ?? "" });
        void refresh();
      },
    }),
  );
  const agent = status.agentMode;
  if (agent === null) return null;
  const boards = [...agent.boards].sort((a, b) => Number(b.startFromLinear) - Number(a.startFromLinear) || a.projectName.localeCompare(b.projectName) || a.name.localeCompare(b.name));
  const onCount = boards.filter((board) => board.startFromLinear).length;
  const renewalHours = agent.nextRenewalAt === null ? null : Math.max(1, Math.round((agent.nextRenewalAt - now) / 3_600_000));

  return (
    <>
      <Section title={t("agentMode.title")}>
        <p className="mb-1 text-[12.5px] text-muted">{t("agentMode.lede")}</p>
        <ul className="border-t border-line" data-testid="agent-mode">
          <KeyRow label={t("agentMode.state")} testId="agent-mode-state">
            <AgentModeState agent={agent} justTurnedOn={justTurnedOn} />
          </KeyRow>
          <KeyRow label={t("agentMode.address")} testId="agent-mode-address">
            <PublicAddress agent={agent} />
          </KeyRow>
          <KeyRow label={t("agentMode.appUser")}>
            <span className="font-mono">{status.appUserName ?? "–"}</span>
            <span className="text-muted">{t("agentMode.appUserNote")}</span>
          </KeyRow>
          <KeyRow label={t("agentMode.scopes")} testId="agent-mode-scopes">
            {agent.grantedScopes.length === 0 ? <span className="text-muted">{t("agentMode.notGranted")}</span> : agent.grantedScopes.map((scope) => <Chip key={scope} className="font-mono text-xs text-text">{scope}</Chip>)}
          </KeyRow>
          <KeyRow label={t("agentMode.renewal")}>
            <span className="text-muted">{renewalHours === null ? t("agentMode.renewalNone") : t("agentMode.renewalIn", { h: renewalHours })}</span>
          </KeyRow>
        </ul>
        {agent.reachable ? null : <p className="mt-2 text-[12.5px] text-muted">{t("agentMode.unreachableNote")}</p>}
        {agent.on && agent.missingScopes.length > 0 ? <p role="alert" className="mt-2 text-[12.5px] text-red">{t("agentMode.missing", { scopes: agent.missingScopes.join(", ") })}</p> : null}
        {agent.on ? (
          justTurnedOn ? <p role="status" className="mt-2 text-[12.5px] text-muted">{t("agentMode.turnedOn")}</p> : null
        ) : (
          <div className="mt-3">
            <p className="text-[12.5px] text-muted">{t("agentMode.offNote")}</p>
            <Button variant="primary" className="mt-2.5" disabled={enable.isPending || enable.isSuccess || status.mode === "polling"} onClick={() => { enable.mutate({ connectionId: status.connectionId }); }} data-testid="turn-on-agent-mode">
              {enable.isPending || enable.isSuccess ? <LoaderCircleIcon className="animate-spin" /> : <ArrowUpRightIcon />}
              {enable.isPending || enable.isSuccess ? t("agentMode.opening") : t("agentMode.turnOn")}
            </Button>
            {enable.isError ? <p role="alert" className="mt-2 text-[12.5px] text-red">{errorText(enable.error)}</p> : null}
          </div>
        )}
      </Section>

      {agent.on ? (
        <>
          <Section title={t("agentMode.boardsTitle")} count={onCount}>
            <p className="mb-1 text-[12.5px] text-muted">{t("agentMode.boardsLede")}</p>
            {onCount === 0 ? <p className="mb-1 text-[12.5px] text-muted">{t("agentMode.noBoardOn")}</p> : null}
            <div className="grid h-7 grid-cols-[minmax(0,1fr)_80px_auto] items-center gap-x-3 border-b border-line text-[11.5px] font-medium text-faint sm:grid-cols-[minmax(0,1fr)_120px_200px_auto]">
              <span>{t("agentMode.col.board")}</span>
              <span>{t("agentMode.col.team")}</span>
              <span className="hidden sm:block">{t("agentMode.col.project")}</span>
              <span />
            </div>
            <ul data-testid="agent-boards">
              {boards.map((board) => {
                const other = takenBy(board, boards);
                return (
                  <li key={board.boardId} className="grid min-h-10 grid-cols-[minmax(0,1fr)_80px_auto] items-center gap-x-3 border-b border-line text-ui sm:grid-cols-[minmax(0,1fr)_120px_200px_auto]" data-board={board.name}>
                    <span className={cn("truncate", other === undefined ? "text-text" : "text-muted")}>{board.name}</span>
                    <span className="font-mono text-[12.5px] text-text">{board.teamKey ?? "–"}</span>
                    <Link href={`/projects/${board.projectId}/boards`} className="hidden truncate font-mono text-[12.5px] text-muted hover:underline sm:block">{board.projectName}</Link>
                    <span className="flex items-center justify-end gap-2">
                      {other === undefined ? null : (
                        <span className="hidden text-xs text-faint md:inline">
                          {other.projectId === board.projectId
                            ? t("agentMode.alreadyOn", { team: board.teamKey ?? "", board: other.name })
                            : t("agentMode.alreadyOnIn", { team: board.teamKey ?? "", board: other.name, project: other.projectName })}
                        </span>
                      )}
                      {setBoard.isPending && setBoard.variables.boardId === board.boardId ? <LoaderCircleIcon aria-hidden className="size-3 animate-spin text-faint" /> : null}
                      <Switch
                        checked={board.startFromLinear}
                        disabled={other !== undefined || setBoard.isPending}
                        aria-label={t("agentMode.boardSwitch", { board: board.name })}
                        onCheckedChange={(on) => { setLine(null); setBoard.mutate({ boardId: board.boardId, on }); }}
                      />
                    </span>
                  </li>
                );
              })}
            </ul>
            {line === null ? null : line.kind === "status" ? (
              <p role="status" className="mt-2 text-[12.5px] text-muted" data-testid="agent-board-line">{line.text}</p>
            ) : (
              <p role="alert" className="mt-2 text-[12.5px] text-red">{line.text}</p>
            )}
          </Section>

          <Section title={t("agentMode.eventsTitle")}>
            {agent.reachable ? null : <p className="mb-1 text-[12.5px] text-muted" data-testid="agent-events-unreachable">{t("agentMode.unreachableNote")}</p>}
            {agent.lastSessionEvents.length === 0 ? (
              <p className="h-9 text-[13px] text-faint">{t("agentMode.eventsNone")}</p>
            ) : (
              <ul className="border-t border-line" data-testid="agent-events">
                {agent.lastSessionEvents.map((event) => (
                  <li key={event.agentSessionId} className="grid min-h-9 grid-cols-[52px_90px_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-line text-ui sm:grid-cols-[52px_90px_80px_minmax(0,1fr)_auto]">
                    <span className="font-mono text-xs text-faint">{clock(event.at, now)}</span>
                    <span className="text-text">{t("agentMode.delegated")}</span>
                    <span className="hidden font-mono text-ui sm:block">
                      {event.taskId === null ? event.ticketKey ?? "–" : <Link href={`/tasks/${event.taskId}`} className="hover:underline">{event.ticketKey ?? "–"}</Link>}
                    </span>
                    <span className="truncate text-text">
                      {event.creatorName}
                      {event.matched ? null : <span className="text-faint">{t("agentMode.notMember")}</span>}
                    </span>
                    <span className="text-right text-[12.5px] text-muted">{outcomeOf(event)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      ) : null}
    </>
  );
};

/**
 * The properties panel's "Agent sessions" group, while agent mode is on: between the scopes and the
 * webhook events, labelled as the panel's other groups. Its key column fits `Awaiting approval`.
 */
export const AgentSessionsGroup = ({ agent }: { readonly agent: AgentMode | null }) =>
  agent?.on !== true ? null : (
    <div data-testid="agent-sessions">
      <PanelLabel>{t("agentMode.panel.sessions")}</PanelLabel>
      <PropRow label={t("agentMode.panel.open")} labelWidth={132}><span className="font-mono">{agent.sessions.open}</span></PropRow>
      <PropRow label={t("agentMode.panel.awaiting")} labelWidth={132}><span className="font-mono">{agent.sessions.awaitingApproval}</span></PropRow>
      <PropRow label={t("agentMode.panel.posted")} labelWidth={132}><span className="font-mono">{agent.sessions.postedToday}</span></PropRow>
    </div>
  );
