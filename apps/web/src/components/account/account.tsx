"use client";

import { CheckIcon, GitPullRequestIcon as GithubIcon, ShieldIcon, TerminalIcon } from "lucide-react";
import Link from "next/link";
import { AlertDialog as Dialog } from "radix-ui";
import { useState } from "react";

import { CopyLink } from "@/components/runners/copy-link";
import { PropGroup, PropRow, Section } from "@/components/shell/page-frame";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Status } from "@/components/ui/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { plural, t } from "@/lib/messages";

import { expiresText, lastUsedText, linkReturnText, noReplyAddress, roleText } from "./account-words";
import type { CliSessionView, GitHubLinkView, LinkReturn } from "./account-words";
import { shortDate } from "./notification-words";

// Account (account.md, F-119, F-103): the member's GitHub link and CLI sessions, about themselves
// only. `AccountView` wires these to ticket 39's `account.github` and `account.cliSessions`.

/** The dialog's work: idle, running, or refused with words. */
export type DialogState = { readonly kind: "idle" } | { readonly kind: "busy" } | { readonly kind: "failed"; readonly message: string };

const Line = ({ tone, children, role }: { readonly tone: "green" | "red" | "muted"; readonly children: string; readonly role: "status" | "alert" }) => (
  <p role={role} className={cn("mt-2 flex items-center gap-1.5 text-[12.5px]", tone === "green" ? "text-green" : tone === "red" ? "text-red" : "text-muted")}>
    {role === "status" ? <CheckIcon aria-hidden className="size-[14px] stroke-[1.75]" /> : null}
    {children}
  </p>
);

/**
 * A destructive confirm (account.md, "Unlink", "Revoke"): `Cancel` and the red action. Unlike
 * `ui/alert-dialog`'s, it stays open while the action runs, and shows a refusal above its buttons.
 */
const Confirm = ({ open, onOpenChange, title, body, action, busyLabel, state, onConfirm }: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly title: string; readonly body: string; readonly action: string; readonly busyLabel: string; readonly state: DialogState; readonly onConfirm: () => void }) => (
  <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(400px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line-2 bg-raise p-5 shadow-[0_8px_24px_rgba(0,0,0,0.45)] focus:outline-none">
        <Dialog.Title className="text-[16.5px] font-semibold text-text">{title}</Dialog.Title>
        <Dialog.Description className="mt-1.5 text-body text-muted">{body}</Dialog.Description>
        {state.kind === "failed" ? (
          <p role="alert" className="mt-3 text-[12.5px] text-red">
            {state.message}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Dialog.Cancel className={buttonVariants()}>{t("common.cancel")}</Dialog.Cancel>
          <button type="button" className={buttonVariants({ variant: "danger" })} disabled={state.kind === "busy"} onClick={onConfirm}>
            {state.kind === "busy" ? busyLabel : action}
          </button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
);

export type GitHubSectionProps = {
  readonly github: GitHubLinkView | undefined;
  readonly admin: boolean;
  /** `?github=…` after the callback, once. */
  readonly back: LinkReturn | null;
  readonly unlinked: boolean;
  readonly unlink: DialogState;
  /** Resolves `true` once unlinked, which closes the dialog. */
  readonly onUnlink: () => Promise<boolean>;
  readonly onUnlinkReset: () => void;
};

/** GitHub: linked as `@login` with Unlink, or `Link GitHub account`, or not connected to the install. */
export const GitHubSection = ({ github, admin, back, unlinked, unlink, onUnlink, onUnlinkReset }: GitHubSectionProps) => {
  const [confirming, setConfirming] = useState(false);
  const link = github?.link ?? null;
  return (
    <Section title={t("account.github.title")} note={t("account.github.note")}>
      <div className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-1 border-y border-line py-2" data-github={link === null ? "not-linked" : "linked"}>
        {github === undefined ? (
          <>
            <Skeleton className="size-[15px]" />
            <Skeleton className="w-[120px]" />
            <Skeleton className="w-[80px]" />
          </>
        ) : !github.connected ? (
          <>
            <GithubIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-faint" />
            <span className="text-ui text-muted">{t("account.github.notConnected")}</span>
            {admin ? (
              <Link href="/organization/github" className="ml-auto text-ui text-teal hover:underline">
                {t("account.github.connect")}
              </Link>
            ) : null}
          </>
        ) : link === null ? (
          <>
            <GithubIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-faint" />
            <span className="text-ui text-muted">{t("account.github.notLinked")}</span>
            <a href="/api/github/link/start" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "ml-auto")} data-action="link-github">
              {t("account.github.link")}
            </a>
          </>
        ) : (
          <>
            <GithubIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-text" />
            <span className="w-[180px] truncate font-mono text-ui text-text">@{link.login}</span>
            <Status tone="green" className="text-ui text-muted">
              {t("account.github.linked")}
            </Status>
            <span className="font-mono text-[12.5px] text-faint">{t("account.github.idLine", { id: link.githubUserId, date: shortDate(link.linkedAt) })}</span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-6"
              onClick={() => {
                onUnlinkReset();
                setConfirming(true);
              }}
            >
              {t("account.github.unlink")}
            </Button>
            <Confirm
              open={confirming}
              onOpenChange={setConfirming}
              title={t("account.github.unlinkTitle", { login: link.login })}
              body={t("account.github.unlinkBody")}
              action={t("account.github.unlink")}
              busyLabel={t("account.github.unlinking")}
              state={unlink}
              onConfirm={() => {
                void onUnlink().then((done) => {
                  if (done) setConfirming(false);
                });
              }}
            />
          </>
        )}
      </div>
      {github === undefined ? null : !github.connected ? (
        admin ? null : <p className="mt-2.5 text-[12.5px] text-faint">{t("account.github.askAdmin")}</p>
      ) : link === null ? (
        <p className="mt-2.5 max-w-[720px] text-[12.5px] text-faint">{t("account.github.helpNotLinked")}</p>
      ) : (
        <div className="mt-2.5 max-w-[720px] text-[12.5px] text-faint">
          <p>{t("account.github.helpLinked")}</p>
          <p>
            {t("account.github.credits")}
            <span className="font-mono text-muted">{noReplyAddress(link.githubUserId, link.login)}</span>.
          </p>
        </div>
      )}
      {back === null ? null : (
        <Line role={back === "linked" ? "status" : "alert"} tone={back === "linked" ? "green" : "red"}>
          {linkReturnText(back, link?.login ?? null)}
        </Line>
      )}
      {unlinked ? (
        <Line role="status" tone="muted">
          {t("account.github.unlinked")}
        </Line>
      ) : null}
    </Section>
  );
};

export type CliSessionsSectionProps = {
  readonly sessions: readonly CliSessionView[] | undefined;
  readonly days: number;
  readonly loginLine: string;
  readonly now: number;
  readonly revoke: DialogState;
  readonly revoked: boolean;
  /** Resolves `true` once revoked, which closes the dialog. */
  readonly onRevoke: (sessionId: string) => Promise<boolean>;
  readonly onRevokeReset: () => void;
};

/** CLI sessions: machine, created, last used, expires and Revoke; then the login line to copy. */
export const CliSessionsSection = ({ sessions, days, loginLine, now, revoke, revoked, onRevoke, onRevokeReset }: CliSessionsSectionProps) => {
  const [confirming, setConfirming] = useState<CliSessionView | null>(null);
  const empty = sessions?.length === 0;
  return (
    <Section title={t("account.cli.title")} {...(sessions === undefined ? {} : { count: sessions.length })} note={plural(days, "account.cli.note.one", "account.cli.note.other")} className="mt-[30px]">
      {empty ? (
        <p className="flex h-10 items-center border-y border-line text-ui text-faint">{t("account.cli.none")}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-[11.5px]">{t("account.cli.machine")}</TableHead>
              <TableHead className="hidden w-[130px] text-[11.5px] sm:table-cell">{t("account.cli.created")}</TableHead>
              <TableHead className="w-[110px] text-[11.5px] sm:w-[130px]">{t("account.cli.lastUsed")}</TableHead>
              <TableHead className="hidden w-[130px] text-[11.5px] sm:table-cell">{t("account.cli.expires")}</TableHead>
              <TableHead className="w-[80px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions === undefined
              ? [0, 1].map((i) => (
                  <TableRow key={i}>
                    <TableCell className="h-10">
                      <Skeleton className="w-[120px]" />
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <Skeleton className="w-[80px]" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="w-[80px]" />
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <Skeleton className="w-[80px]" />
                    </TableCell>
                    <TableCell />
                  </TableRow>
                ))
              : sessions.map((session) => {
                  const expires = expiresText(session.expiresAt, now);
                  const used = lastUsedText(session.lastUsedAt, now);
                  return (
                    <TableRow key={session.id} data-session={session.id}>
                      <TableCell className="h-10">
                        <span className="flex min-w-0 items-center gap-2.5">
                          <TerminalIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-faint" />
                          {session.name === null ? (
                            <span className="truncate text-ui text-faint">{t("account.cli.unnamed")}</span>
                          ) : (
                            <span className="truncate font-mono text-ui text-text" title={session.name}>
                              {session.name}
                            </span>
                          )}
                        </span>
                        <span className="ml-[25px] block font-mono text-xs text-faint sm:hidden">
                          {shortDate(session.createdAt)} · {expires.text}
                        </span>
                      </TableCell>
                      <TableCell className="hidden font-mono text-[12.5px] text-muted sm:table-cell">{shortDate(session.createdAt)}</TableCell>
                      <TableCell className={cn("text-ui", used === null ? "text-faint" : "text-muted")}>{used ?? t("account.cli.never")}</TableCell>
                      <TableCell className={cn("hidden font-mono text-[12.5px] sm:table-cell", expires.soon ? "text-text" : "text-muted")}>{expires.text}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6"
                          onClick={() => {
                            onRevokeReset();
                            setConfirming(session);
                          }}
                        >
                          {t("account.cli.revoke")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
          </TableBody>
        </Table>
      )}
      {revoked ? (
        <Line role="status" tone="muted">
          {t("account.cli.revoked")}
        </Line>
      ) : null}
      <p className="mt-3 text-[12.5px] text-muted">{empty ? t("account.cli.first") : t("account.cli.another")}</p>
      <div className="mt-2 flex h-10 min-w-0 items-center gap-3 rounded-md border border-line-2 bg-surface px-4">
        <code className="min-w-0 flex-1 truncate font-mono text-ui text-text" title={loginLine}>
          {loginLine}
        </code>
        <CopyLink text={loginLine} />
      </div>
      <p className="mt-2.5 flex items-start gap-1.5 text-xs text-faint">
        <ShieldIcon aria-hidden className="mt-px size-[13px] shrink-0 stroke-[1.75]" />
        {t("account.cli.footnote")}
      </p>
      <Confirm
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={t("account.cli.revokeTitle", { machine: confirming?.name ?? t("account.cli.unnamed") })}
        body={t("account.cli.revokeBody")}
        action={t("account.cli.revoke")}
        busyLabel={t("account.cli.revoking")}
        state={revoke}
        onConfirm={() => {
          if (confirming === null) return;
          void onRevoke(confirming.id).then((done) => {
            if (done) setConfirming(null);
          });
        }}
      />
    </Section>
  );
};

export type AccountPanelProps = {
  readonly me: { readonly name: string; readonly email: string | null; readonly role: "admin" | "member"; readonly organization: string };
  readonly github: GitHubLinkView | undefined;
  readonly sessions: number | undefined;
  readonly days: number;
};

/** The properties panel: you, the GitHub link while linked, and the CLI sessions. */
export const AccountPanel = ({ me, github, sessions, days }: AccountPanelProps) => {
  const link = github?.link ?? null;
  return (
    <div className="text-[12.5px]">
      <PropGroup title={t("account.panel.you")}>
        <PropRow label={t("account.panel.name")} labelWidth={96}>
          <span className="truncate">{me.name}</span>
        </PropRow>
        <PropRow label={t("account.panel.email")} labelWidth={96}>
          <span className="truncate font-mono">{me.email ?? "–"}</span>
        </PropRow>
        <PropRow label={t("account.panel.role")} labelWidth={96}>
          <span className="truncate">{roleText(me.role, me.organization)}</span>
        </PropRow>
        <PropRow label={t("account.panel.password")} labelWidth={96}>
          <Link href="/change-password" className="text-teal">
            {t("account.panel.change")}
          </Link>
        </PropRow>
      </PropGroup>
      {link === null ? null : (
        <PropGroup title={t("account.panel.githubLink")}>
          <PropRow label={t("account.panel.login")} labelWidth={96}>
            <span className="truncate font-mono">@{link.login}</span>
          </PropRow>
          <PropRow label={t("account.panel.linkedOn")} labelWidth={96}>
            <span className="font-mono">{shortDate(link.linkedAt)}</span>
          </PropRow>
          <PropRow label={t("account.panel.token")} labelWidth={96}>
            {t("account.panel.tokenRevoked")}
          </PropRow>
        </PropGroup>
      )}
      <PropGroup title={t("account.panel.cli")}>
        <PropRow label={t("account.panel.active")} labelWidth={96}>
          {sessions === undefined ? <Skeleton className="w-[24px]" /> : <span className="font-mono">{sessions}</span>}
        </PropRow>
        <PropRow label={t("account.panel.validFor")} labelWidth={96}>
          {plural(days, "account.panel.days.one", "account.panel.days.other")}
        </PropRow>
        <PropRow label={t("account.panel.canRead")} labelWidth={96}>
          {t("account.panel.canReadValue")}
        </PropRow>
      </PropGroup>
    </div>
  );
};
