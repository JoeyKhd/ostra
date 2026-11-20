"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRightIcon,
  Building2Icon,
  CheckIcon,
  ClockIcon,
  InfoIcon,
  LoaderCircleIcon,
  LockIcon,
  PauseIcon,
  TriangleAlertIcon,
  UserIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode, SubmitEvent } from "react";

import { PropRow } from "@/components/shell/page-frame";
import { AlertDialog, AlertDialogContent } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Dot } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { GitHubMark } from "./github-mark";
import { orderPermissions } from "./permission-order";
import { appSettingsUrl, dayMonth, installUrl, orderInstallations, reposText } from "./github-orgs-words";

// Organization › GitHub with several GitHub organizations (F-136, app-targets/m4/github-organizations.md):
// each App with its installations, linked, waiting to be linked or removed. ostra acts only through
// an installation an organization admin linked; a stranger's installation is shown calmly.

export type GitHubApp = RouterOutputs["github"]["connections"][number];
export type AppInstallation = GitHubApp["installations"][number];
/** The organization's own App as milestone 1 reads it: its bot and permissions. */
export type OwnConnection = NonNullable<RouterOutputs["github"]["connection"]>;

const STATUS_FOR_MS = 4000;

const PanelLabel = ({ children }: { readonly children: ReactNode }) => <h3 className="mb-1.5 text-xs font-medium text-faint">{children}</h3>;
const Sep = () => <div className="my-3.5 h-px bg-line" />;

const OutLink = ({ href, children }: { readonly href: string; readonly children: ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-teal hover:underline">
    {children}
    <ArrowUpRightIcon aria-hidden className="size-[13px] stroke-[1.75]" />
  </a>
);

const WebhookState = ({ app }: { readonly app: GitHubApp }) => {
  switch (app.webhook.kind) {
    case "receiving":
      return (
        <span className="ml-auto flex shrink-0 items-center gap-2 text-sm text-muted">
          <Dot tone="green" /> {t("githubOrgs.webhook.receiving")}
        </span>
      );
    case "none":
      return (
        <span className="ml-auto flex shrink-0 items-center gap-2 text-sm text-muted">
          <Dot tone="grey" /> {t("githubOrgs.webhook.none")}
        </span>
      );
    case "failing":
      return (
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-sm text-text" title={app.webhook.lastError}>
          <TriangleAlertIcon aria-hidden className="size-[13px] stroke-[1.75]" /> {t("githubOrgs.webhook.failing")}
        </span>
      );
    default:
      return app.webhook satisfies never;
  }
};

/** One installation's state cell and its actions. */
const StateAndActions = ({ installation, busy, onLink, onUnlink, onRemove }: {
  readonly installation: AppInstallation;
  readonly busy: boolean;
  readonly onLink: () => void;
  readonly onUnlink: () => void;
  readonly onRemove: () => void;
}) => {
  const spinner = busy ? <LoaderCircleIcon aria-hidden className="size-3 animate-spin" /> : null;
  switch (installation.state) {
    case "linked":
      return (
        <>
          <span className="flex items-center gap-1.5 text-muted">
            <CheckIcon aria-hidden className="size-[14px] stroke-[1.75] text-green" /> {t("githubOrgs.state.linked")}
          </span>
          <span className="relative z-10 justify-self-end">
            {installation.isOwner ? (
              <span className="text-faint">{t("githubOrgs.state.owner")}</span>
            ) : (
              <button type="button" className="text-teal hover:underline disabled:opacity-50" disabled={busy} onClick={onUnlink}>
                {spinner}
                {t("githubOrgs.actions.unlink")}
              </button>
            )}
          </span>
        </>
      );
    case "waiting":
      return (
        <>
          <span className="flex items-center gap-1.5 font-medium text-text">
            <ClockIcon aria-hidden className="size-[14px] stroke-[1.75] text-muted" /> {t("githubOrgs.state.waiting")}
          </span>
          <span className="relative z-10 flex justify-end gap-2">
            <Button size="sm" disabled={busy} onClick={onLink}>{spinner}{t("githubOrgs.actions.link")}</Button>
            <Button size="sm" disabled={busy} onClick={onRemove}>{t("githubOrgs.actions.remove")}</Button>
          </span>
        </>
      );
    case "suspended":
      return (
        <>
          <span className="flex items-center gap-1.5 text-muted">
            <PauseIcon aria-hidden className="size-[14px] stroke-[1.75]" /> {t("githubOrgs.state.suspended")}
          </span>
          <span />
        </>
      );
    case "removed":
      return (
        <>
          <span className="text-faint">{installation.removedAt === null ? t("githubOrgs.state.removedNoDate") : t("githubOrgs.state.removed", { date: dayMonth(installation.removedAt) })}</span>
          <span />
        </>
      );
    default:
      return installation.state satisfies never;
  }
};

/** One App: its section line, then its installations in one grid. */
export const AppSection = ({ app, selected, onSelectApp, onSelectInstallation, onStatus }: {
  readonly app: GitHubApp;
  readonly selected: { readonly kind: "app"; readonly connectionId: string } | { readonly kind: "installation"; readonly installationId: string } | null;
  readonly onSelectApp: () => void;
  readonly onSelectInstallation: (installationId: string) => void;
  readonly onStatus: (text: string) => void;
}) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<{ readonly kind: "unlink" | "remove"; readonly installation: AppInstallation } | null>(null);
  const done = async () => { await queryClient.invalidateQueries({ queryKey: trpc.github.pathKey() }); };
  const link = useMutation(trpc.github.linkInstallation.mutationOptions({ onSettled: done }));
  const unlink = useMutation(trpc.github.unlinkInstallation.mutationOptions({ onSettled: done }));
  const remove = useMutation(trpc.github.removeInstallation.mutationOptions({ onSettled: done }));
  const pendingId = [link, unlink, remove].find((mutation) => mutation.isPending)?.variables.installationId ?? null;
  const error = [link, unlink, remove].map((mutation) => mutation.error).find((value) => value !== null) ?? null;
  const target = { connectionId: app.connectionId };
  const installations = orderInstallations(app.installations);

  return (
    <section className="mt-7" data-testid="github-app" data-slug={app.slug ?? app.appId}>
      <button
        type="button"
        onClick={onSelectApp}
        aria-pressed={selected?.kind === "app" && selected.connectionId === app.connectionId}
        className="flex h-10 w-full items-center gap-2.5 border-b border-line text-left"
      >
        <GitHubMark className="text-text" />
        <span className="truncate font-mono text-[15px] font-semibold text-text">{app.slug ?? app.appId}</span>
        <span className="hidden truncate text-sm text-muted sm:inline">
          {app.ownerLogin === null ? null : <>{t("githubOrgs.ownedBy")} <span className="font-mono">{app.ownerLogin}</span></>}
          {app.public === null ? null : <>{app.ownerLogin === null ? null : " · "}{app.public ? t("githubOrgs.public") : t("githubOrgs.private")}</>}
        </span>
        <WebhookState app={app} />
      </button>
      {error === null ? null : <p role="alert" className="mt-2 text-sm text-red">{errorText(error)}</p>}
      <ul>
        {installations.map((installation) => {
          const on = selected?.kind === "installation" && selected.installationId === installation.installationId;
          const removed = installation.state === "removed";
          return (
            <li
              key={installation.installationId}
              data-testid="installation"
              data-account={installation.accountLogin}
              data-state={installation.state}
              className={cn(
                "relative grid min-h-[42px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-b border-line px-2 py-1 sm:grid-cols-[200px_120px_minmax(0,1fr)_170px_auto]",
                "rounded-[6px] hover:bg-hover",
                on && "bg-sel hover:bg-sel",
                removed && "text-faint",
              )}
            >
              <button type="button" className="absolute inset-0" aria-label={installation.accountLogin} aria-pressed={on} onClick={() => { onSelectInstallation(installation.installationId); }} />
              <span className="flex min-w-0 items-center gap-2.5">
                {installation.accountKind === "organization" ? (
                  <Building2Icon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-faint" />
                ) : (
                  <UserIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-faint" />
                )}
                <span className={cn("truncate font-mono text-[14px]", removed ? "text-faint" : "text-text")}>{installation.accountLogin}</span>
              </span>
              <span className="hidden text-sm text-faint sm:inline">{installation.accountKind === "organization" ? t("githubOrgs.organization") : t("githubOrgs.user")}</span>
              <span className={cn("hidden truncate sm:inline", removed ? "text-faint" : "text-muted")}>{removed ? "–" : reposText(installation)}</span>
              <span className="col-span-2 flex items-center justify-between gap-3 sm:contents">
                <StateAndActions
                  installation={installation}
                  busy={pendingId === installation.installationId}
                  onLink={() => {
                    link.mutate(
                      { ...target, installationId: installation.installationId },
                      { onSuccess: () => { onStatus(t("githubOrgs.status.linked", { account: installation.accountLogin })); } },
                    );
                  }}
                  onUnlink={() => { setConfirm({ kind: "unlink", installation }); }}
                  onRemove={() => { setConfirm({ kind: "remove", installation }); }}
                />
              </span>
            </li>
          );
        })}
      </ul>
      <AlertDialog open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        {confirm === null ? null : confirm.kind === "unlink" ? (
          <AlertDialogContent
            title={t("githubOrgs.unlinkDialog.title", { account: confirm.installation.accountLogin })}
            body={t("githubOrgs.unlinkDialog.body", { repos: reposText(confirm.installation), projects: plural(confirm.installation.projects.length, "githubOrgs.projectsOne", "githubOrgs.projectsMany") })}
            cancel={t("common.cancel")}
            action={t("githubOrgs.actions.unlink")}
            onAction={() => {
              const installation = confirm.installation;
              unlink.mutate({ ...target, installationId: installation.installationId }, { onSuccess: () => { onStatus(t("githubOrgs.status.unlinked", { account: installation.accountLogin })); } });
            }}
          />
        ) : (
          <AlertDialogContent
            title={t("githubOrgs.removeDialog.title", { app: app.slug ?? app.appId, account: confirm.installation.accountLogin })}
            body={t("githubOrgs.removeDialog.body", { account: confirm.installation.accountLogin })}
            cancel={t("common.cancel")}
            action={t("githubOrgs.actions.remove")}
            onAction={() => {
              const installation = confirm.installation;
              remove.mutate({ ...target, installationId: installation.installationId }, { onSuccess: () => { onStatus(t("githubOrgs.status.removed", { account: installation.accountLogin })); } });
            }}
          />
        )}
      </AlertDialog>
    </section>
  );
};

/** The 4s status line after a link, an unlink or a remove. */
export const useStatusLine = () => {
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    if (status === null) return;
    const timer = setTimeout(() => { setStatus(null); }, STATUS_FOR_MS);
    return () => { clearTimeout(timer); };
  }, [status]);
  return [status, setStatus] as const;
};

/** "Add a GitHub organization": the install link to send, for a public App. */
export const AddOrganizationGroup = ({ apps }: { readonly apps: readonly GitHubApp[] }) => {
  const id = useId();
  const publicApps = apps.filter((app) => app.public !== false && app.slug !== null);
  const [picked, setPicked] = useState<string | null>(null);
  const app = publicApps.find((candidate) => candidate.connectionId === picked) ?? publicApps[0];
  if (app?.slug === undefined || app.slug === null) return null;
  const url = installUrl(app.slug);
  return (
    <div data-testid="add-organization">
      <PanelLabel>{t("githubOrgs.addOrg.label")}</PanelLabel>
      <p className="mb-2.5 text-sm text-muted">{t("githubOrgs.addOrg.body")}</p>
      {publicApps.length > 1 ? (
        <Select value={app.connectionId} onValueChange={setPicked}>
          <SelectTrigger className="mb-2 h-8 w-full bg-surface" aria-label={t("githubOrgs.addOrg.pickApp")}><SelectValue /></SelectTrigger>
          <SelectContent>
            {publicApps.map((candidate) => <SelectItem key={candidate.connectionId} value={candidate.connectionId}>{candidate.slug}</SelectItem>)}
          </SelectContent>
        </Select>
      ) : null}
      <div className="flex items-center gap-2">
        <span id={`${id}-url`} className="flex h-8 min-w-0 flex-1 items-center truncate rounded-md border border-line-2 bg-surface px-2.5 font-mono text-xs text-text" data-testid="install-url">{url}</span>
        <CopyButton text={`https://${url}`} selectId={`${id}-url`} />
      </div>
    </div>
  );
};

/** "Private Apps": why a private App can't be installed elsewhere, and GitHub's setting. */
export const PrivateAppsGroup = ({ apps }: { readonly apps: readonly GitHubApp[] }) => {
  const privateApps = apps.filter((app) => app.public !== true && app.slug !== null);
  if (privateApps.length === 0) return null;
  return (
    <div data-testid="private-apps">
      <PanelLabel>{t("githubOrgs.privateApps.label")}</PanelLabel>
      {privateApps.map((app) => (
        <div key={app.connectionId} className="mb-2">
          <p className="mb-1.5 text-sm text-muted">
            {t("githubOrgs.privateApps.bodyBefore")}
            <span className="font-mono">{app.slug}</span>
            {t("githubOrgs.privateApps.bodyMiddle")}
            <span className="font-mono">{app.ownerLogin ?? "–"}</span>
            {t("githubOrgs.privateApps.bodyAfter")}
          </p>
          {app.slug === null || app.ownerLogin === null ? null : (
            <OutLink href={appSettingsUrl(app.slug, { login: app.ownerLogin, kind: app.ownerKind ?? "organization" })}>{t("githubOrgs.privateApps.settings")}</OutLink>
          )}
        </div>
      ))}
    </div>
  );
};

/** The selected installation's panel. */
export const InstallationPanel = ({ app, installation }: { readonly app: GitHubApp; readonly installation: AppInstallation }) => {
  const shown = installation.repos.slice(0, 5);
  return (
    <div data-testid="installation-panel">
      <PanelLabel>{t("githubOrgs.installation.label")}</PanelLabel>
      <p className="mb-2 truncate font-mono text-[15px] font-semibold">{installation.accountLogin}</p>
      <PropRow label={t("githubOrgs.installation.account")}>
        <span className="truncate">{installation.accountLogin}{installation.accountKind === null ? null : ` · ${installation.accountKind === "organization" ? t("githubOrgs.organization") : t("githubOrgs.user")}`}</span>
      </PropRow>
      <PropRow label={t("githubOrgs.installation.app")}><span className="truncate font-mono">{app.slug ?? app.appId}</span></PropRow>
      {installation.installedAt === null ? null : (
        <PropRow label={t("githubOrgs.installation.installed")}>
          <span className="truncate">
            <span className="font-mono">{dayMonth(installation.installedAt)}</span>
            {installation.installedBy === null ? null : ` ${t("githubOrgs.installation.by", { login: installation.installedBy.name })}`}
          </span>
        </PropRow>
      )}
      <PropRow label={t("githubOrgs.installation.repos")}>
        {installation.repoSelection === "all" || shown.length === 0 ? (
          reposText(installation)
        ) : (
          <span className="flex min-w-0 flex-col">
            {shown.map((repo) => <span key={repo.hostRepoId} className="truncate font-mono">{repo.fullName}</span>)}
            {installation.repos.length > shown.length ? <span className="text-faint">{t("githubOrgs.installation.andMore", { n: installation.repos.length - shown.length })}</span> : null}
          </span>
        )}
      </PropRow>
      <p className="mt-2.5 text-sm text-muted">
        {installation.state === "waiting" ? (
          <>
            {t("githubOrgs.installation.waitingBefore")}
            <span className="font-mono">{app.slug ?? app.appId}</span>
            {t("githubOrgs.installation.waitingAfter")}
          </>
        ) : installation.state === "removed" ? (
          // Unlinked, and GitHub still lists it: the App is still installed there.
          t(installation.repoSelection === null ? "githubOrgs.installation.removed" : "githubOrgs.installation.unlinked", { name: installation.removedBy?.name ?? t("taskPage.someone"), date: installation.removedAt === null ? "–" : dayMonth(installation.removedAt) })
        ) : installation.state === "suspended" ? (
          t("githubOrgs.state.suspended")
        ) : (
          t("githubOrgs.installation.linked")
        )}
      </p>
      {installation.state === "linked" && installation.projects.length > 0 ? (
        <PropRow label={t("githubOrgs.installation.usedBy")}>
          <span className="truncate font-mono">{installation.projects.map((project) => project.name).join(", ")}</span>
        </PropRow>
      ) : null}
    </div>
  );
};

/** The selected App's panel: milestone 1's App group, its owner, visibility and webhook address. */
export const AppPanel = ({ app, own }: { readonly app: GitHubApp; readonly own: OwnConnection | null }) => (
  <div data-testid="app-panel">
    <PanelLabel>{t("github.app")}</PanelLabel>
    <PropRow label={t("github.slug")}><span className="truncate font-mono">{app.slug ?? "–"}</span></PropRow>
    <PropRow label={t("github.appId")}><span className="font-mono">{app.appId}</span></PropRow>
    <PropRow label={t("githubOrgs.app.owner")}><span className="truncate font-mono">{app.ownerLogin ?? "–"}</span></PropRow>
    {app.public === null ? null : <PropRow label={t("githubOrgs.app.visibility")}>{app.public ? t("githubOrgs.public") : t("githubOrgs.private")}</PropRow>}
    {own === null ? null : <PropRow label={t("github.bot")}><span className="truncate font-mono">{own.botName ?? "–"}</span></PropRow>}
    <PropRow label={t("githubOrgs.app.webhook")}><span className="truncate font-mono text-xs" title={app.webhookUrl}>{app.webhookUrl}</span></PropRow>
    <PropRow label={t("github.secrets")}>
      <LockIcon aria-hidden className="stroke-[1.75]" />
      <span className="text-muted">{t("github.secretsStored")}</span>
    </PropRow>
    {own === null ? null : (
      <>
        <Sep />
        <h3 className="mb-1.5 flex items-center text-xs font-medium text-faint">
          {t("github.permissions")}
          <span className="ml-auto font-mono">{Object.keys(own.permissions).length}</span>
        </h3>
        <ul aria-label={t("github.permissions")}>
          {orderPermissions(own.permissions).map(([name, level]) => (
            <li key={name} className="flex h-[30px] items-center justify-between gap-3 font-mono text-ui">
              <span className="truncate text-muted">{name}</span>
              <span className="shrink-0 text-text">{level}</span>
            </li>
          ))}
        </ul>
      </>
    )}
    {app.slug === null ? null : (
      <div className="mt-2.5">
        <OutLink href={`https://github.com/apps/${app.slug}`}>{t("github.openOnGitHub")}</OutLink>
      </div>
    )}
  </div>
);

type Connected = RouterOutputs["github"]["connectExisting"];

/** "Connect another App": its ID and key, then the webhook address and a generated secret, shown once. */
export const ConnectAnotherForm = ({ onDone }: { readonly onDone: () => void }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [appId, setAppId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [connected, setConnected] = useState<Connected | null>(null);
  const connect = useMutation(
    trpc.github.connectExisting.mutationOptions({
      onSuccess: async (result) => {
        setPrivateKey("");
        setConnected(result);
        await queryClient.invalidateQueries({ queryKey: trpc.github.pathKey() });
      },
    }),
  );
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    connect.mutate({ appId: appId.trim(), privateKey });
  };
  if (connected !== null) {
    return (
      <div data-testid="shown-once">
        <PanelLabel>{t("githubOrgs.connectAnother.setThese")}</PanelLabel>
        <p className="mb-1 mt-2 text-sm font-medium text-muted">{t("githubOrgs.connectAnother.webhookUrl")}</p>
        <div className="flex items-center gap-2">
          <span id={`${id}-url`} className="flex h-8 min-w-0 flex-1 items-center truncate rounded-md border border-line-2 bg-surface px-2.5 font-mono text-xs" data-testid="webhook-url">{connected.webhookUrl}</span>
          <CopyButton text={connected.webhookUrl} selectId={`${id}-url`} />
        </div>
        {connected.webhookSecret === null ? null : (
          <>
            <p className="mb-1 mt-3 text-sm font-medium text-muted">{t("githubOrgs.connectAnother.webhookSecret")}</p>
            <div className="flex items-center gap-2">
              <span id={`${id}-secret`} className="flex h-8 min-w-0 flex-1 items-center truncate rounded-md border border-line-2 bg-surface px-2.5 font-mono text-xs" data-testid="webhook-secret">{connected.webhookSecret}</span>
              <CopyButton text={connected.webhookSecret} selectId={`${id}-secret`} />
            </div>
          </>
        )}
        <p className="mt-2.5 flex items-start gap-1.5 text-[12.5px] text-muted">
          <LockIcon aria-hidden className="mt-0.5 size-[13px] shrink-0 stroke-[1.75]" />
          {t("githubOrgs.connectAnother.once")}
        </p>
        <Button className="mt-3" onClick={onDone}>{t("githubOrgs.connectAnother.done")}</Button>
      </div>
    );
  }
  return (
    <form onSubmit={submit} noValidate aria-label={t("githubOrgs.connectAnother.title")}>
      <PanelLabel>{t("githubOrgs.connectAnother.title")}</PanelLabel>
      <Field id={`${id}-app-id`} label={t("github.appId")}>
        <Input id={`${id}-app-id`} inputMode="numeric" className="font-mono" disabled={connect.isPending} value={appId} onChange={(event) => { setAppId(event.target.value.replace(/\D/g, "")); }} />
      </Field>
      <div className="mb-3.5">
        <label htmlFor={`${id}-key`} className="mb-1.5 block text-sm font-medium text-muted">{t("github.privateKey")}</label>
        <Textarea id={`${id}-key`} className="min-h-24 font-mono text-ui" spellCheck={false} autoComplete="off" disabled={connect.isPending} value={privateKey} onChange={(event) => { setPrivateKey(event.target.value); }} placeholder="-----BEGIN RSA PRIVATE KEY-----" />
        <div className="mt-1.5 flex justify-end">
          <Button type="button" size="sm" disabled={connect.isPending} onClick={() => fileInput.current?.click()}>{t("github.chooseKeyFile")}</Button>
          <input ref={fileInput} type="file" accept=".pem,application/x-pem-file" aria-label={t("github.privateKeyFile")} className="hidden" onChange={(event) => { void event.target.files?.[0]?.text().then(setPrivateKey); }} />
        </div>
      </div>
      {connect.error === null ? null : <p role="alert" className="mb-3 text-sm text-red">{errorText(connect.error)}</p>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={connect.isPending || appId === "" || privateKey === ""}>
          {connect.isPending ? <LoaderCircleIcon className="animate-spin" /> : null}
          {t("githubOrgs.connectAnother.connect")}
        </Button>
        <Button type="button" onClick={onDone}>{t("common.cancel")}</Button>
      </div>
    </form>
  );
};

export const AppsSkeleton = () => (
  <div aria-busy className="mt-7 space-y-2">
    <Skeleton className="h-10 w-full" />
    {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[42px] w-full" />)}
  </div>
);

/** The strangers line, shown when any App is public. */
export const StrangersLine = () => (
  <p className="mt-4 flex items-start gap-2 text-sm text-faint">
    <InfoIcon aria-hidden className="mt-0.5 size-[13px] shrink-0 stroke-[1.75]" />
    {t("githubOrgs.strangers")}
  </p>
);

export { Sep as PanelSep };
