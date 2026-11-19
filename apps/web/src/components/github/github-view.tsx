"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRightIcon,
  Building2Icon,
  CheckIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  GlobeIcon,
  InfoIcon,
  LoaderCircleIcon,
  LockIcon,
  TriangleAlertIcon,
  UserIcon,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Tooltip } from "radix-ui";
import { useRef, useState } from "react";
import type { ReactNode, SubmitEvent } from "react";

import { PageFrame, PageHeading, PropRow, Section } from "@/components/shell/page-frame";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { Status } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { orderPermissions } from "./permission-order";

type Connection = NonNullable<RouterOutputs["github"]["connection"]>;
type Installation = RouterOutputs["github"]["installations"][number];

/** Posts the App manifest to GitHub as a form, the way GitHub's manifest flow asks (F-006). */
const postManifest = (createUrl: string, state: string, manifest: Readonly<Record<string, unknown>>): void => {
  const url = new URL(createUrl);
  url.searchParams.set("state", state);
  const form = document.createElement("form");
  form.method = "post";
  form.action = url.toString();
  const field = document.createElement("input");
  field.type = "hidden";
  field.name = "manifest";
  field.value = JSON.stringify(manifest);
  form.append(field);
  document.body.append(form);
  form.submit();
};

/** An error in words with its `triangle-alert`: no box, `--red` (github.md, "Errors"). */
const ErrorLine = ({ children, className }: { readonly children: ReactNode; readonly className?: string }) => (
  <p role="alert" className={cn("flex items-start gap-2 text-[12.5px] text-red", className)}>
    <TriangleAlertIcon aria-hidden className="mt-0.5 size-[14px] shrink-0 stroke-[1.75]" />
    <span className="min-w-0 break-words">{children}</span>
  </p>
);

/** A teal link out to GitHub with its trailing arrow. */
const OutLink = ({ href, children }: { readonly href: string; readonly children: ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 whitespace-nowrap text-teal hover:underline">
    {children}
    <ArrowRightIcon aria-hidden className="size-[14px] stroke-[1.75]" />
  </a>
);

/** A properties-panel group label, with its count at the right end. */
const PanelLabel = ({ children, count }: { readonly children: ReactNode; readonly count?: number }) => (
  <h3 className="mb-1.5 flex items-center text-xs font-medium text-faint">
    {children}
    {count === undefined ? null : <span className="ml-auto font-mono text-[11px]">{count}</span>}
  </h3>
);

/** A permission and its level: name mono `--muted` left, level mono `--text` right, one left edge. */
const PermissionRow = ({ name, level, levelClass }: { readonly name: string; readonly level: string; readonly levelClass?: string }) => (
  <li className="flex h-[30px] items-center justify-between gap-3 font-mono text-[12.5px]">
    <span className="truncate text-muted">{name}</span>
    <span className={cn("shrink-0 text-text", levelClass)}>{level}</span>
  </li>
);

const Sep = () => <div className="my-3.5 h-px bg-line" />;

const ExistingAppForm = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [appId, setAppId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const connect = useMutation(
    trpc.github.connectExisting.mutationOptions({
      onSuccess: async () => {
        // Nothing secret stays in the page once it's saved.
        setPrivateKey("");
        setWebhookSecret("");
        await queryClient.invalidateQueries({ queryKey: trpc.github.connection.queryKey() });
        await queryClient.invalidateQueries({ queryKey: trpc.setup.status.queryKey() });
      },
    }),
  );
  const readKeyFile = async (file: File | undefined) => {
    if (file !== undefined) setPrivateKey(await file.text());
  };
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    connect.mutate({ appId: appId.trim(), privateKey, webhookSecret });
  };
  const busy = connect.isPending;
  return (
    <form onSubmit={submit} noValidate aria-label={t("github.existingTitle")} className="max-w-[460px]">
      <Field id="app-id" label={t("github.appId")}>
        <Input id="app-id" inputMode="numeric" className="font-mono" disabled={busy} value={appId} onChange={(e) => { setAppId(e.target.value.replace(/\D/g, "")); }} />
      </Field>
      <div className="mb-3.5">
        <label htmlFor="private-key" className="mb-1.5 block text-sm font-medium text-muted">{t("github.privateKey")}</label>
        <Textarea
          id="private-key"
          className="min-h-24 font-mono text-[12.5px]"
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
          value={privateKey}
          onChange={(e) => { setPrivateKey(e.target.value); }}
          placeholder="-----BEGIN RSA PRIVATE KEY-----"
        />
        <div className="mt-1.5 flex items-start gap-3">
          <p className="min-w-0 flex-1 text-sm text-faint">{t("github.privateKeyHelp")}</p>
          <Button type="button" size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>
            {t("github.chooseKeyFile")}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".pem,application/x-pem-file"
            aria-label={t("github.privateKeyFile")}
            className="hidden"
            onChange={(e) => void readKeyFile(e.target.files?.[0])}
          />
        </div>
      </div>
      <Field id="webhook-secret" label={t("github.webhookSecret")}>
        <Input id="webhook-secret" type="password" autoComplete="off" className="font-mono" disabled={busy} value={webhookSecret} onChange={(e) => { setWebhookSecret(e.target.value); }} />
      </Field>
      {connect.error === null ? null : <ErrorLine className="mb-3">{errorText(connect.error)}</ErrorLine>}
      <Button type="submit" variant="primary" disabled={busy || appId === "" || privateKey === "" || webhookSecret === ""}>
        {busy ? t("github.connecting") : t("github.connect")}
      </Button>
    </form>
  );
};

const NewAppForm = ({ webhookPossible }: { readonly webhookPossible: boolean | undefined }) => {
  const trpc = useTRPC();
  const [owner, setOwner] = useState("");
  const start = useMutation(
    trpc.github.startManifest.mutationOptions({
      onSuccess: (result) => {
        postManifest(result.createUrl, result.state, result.manifest);
      },
    }),
  );
  const [before = "", after = ""] = t("github.noPublicAddress").split("{setting}");
  return (
    <div>
      <div className="max-w-[460px]">
        <Field id="owner" label={t("github.owner")} help={t("github.ownerHelp")}>
          <Input id="owner" className="font-mono" disabled={start.isPending} value={owner} onChange={(e) => { setOwner(e.target.value.trim()); }} placeholder="ostra-test" />
        </Field>
      </div>
      {webhookPossible === false ? (
        <p className="mb-4 flex max-w-[560px] items-start gap-2.5 text-[12.5px] text-muted">
          <InfoIcon aria-hidden className="mt-px size-[15px] shrink-0 stroke-[1.75]" />
          <span>
            {before}
            <code className="font-mono text-[12px]">OSTRA_CORE_PUBLIC_URL</code>
            {after}
          </span>
        </p>
      ) : null}
      {start.error === null ? null : <ErrorLine className="mb-3">{errorText(start.error)}</ErrorLine>}
      <Button variant="primary" onClick={() => { start.mutate({ ownerLogin: owner === "" ? null : owner }); }} disabled={start.isPending}>
        {start.isPending ? <LoaderCircleIcon className="animate-spin" /> : <ExternalLinkIcon className="stroke-[1.75]" />}
        {start.isPending ? t("github.preparing") : t("github.create")}
      </Button>
      <p className="mt-2 text-sm text-faint">{t("github.createHelp")}</p>
    </div>
  );
};

/** Where an installation's settings are on GitHub: an org's, or a user's own. */
export const installationSettingsUrl = (installation: Installation): string =>
  installation.accountKind === "organization"
    ? `https://github.com/organizations/${installation.accountLogin}/settings/installations/${installation.installationId}`
    : `https://github.com/settings/installations/${installation.installationId}`;

const Repositories = ({ installation }: { readonly installation: Installation }) => {
  const trpc = useTRPC();
  const repos = useQuery(trpc.github.repos.queryOptions({ installationId: installation.installationId }));
  return (
    <Section
      title={t("github.repositories")}
      {...(repos.data === undefined ? {} : { count: repos.data.length })}
      end={<span className="font-mono text-[11.5px] text-faint">{t("github.fromAccount", { login: installation.accountLogin })}</span>}
    >
      {repos.isPending ? <SkeletonRows /> : null}
      {repos.error === null ? null : <ErrorLine className="border-t border-line py-3">{t("github.reposFailed")}</ErrorLine>}
      <ul className="rows" data-testid="github-repos">
        {repos.data?.map((repo) => (
          <li key={repo.hostRepoId} className="grid h-[38px] grid-cols-[minmax(0,58%)_minmax(0,1fr)_auto] items-center gap-3 px-2.5">
            <span className="flex min-w-0 items-center gap-3">
              {repo.private ? <LockIcon aria-hidden className="size-[15px] stroke-[1.75] text-muted" /> : <GlobeIcon aria-hidden className="size-[15px] stroke-[1.75] text-muted" />}
              <span className="truncate font-mono text-[12.5px] text-text">{repo.fullName}</span>
            </span>
            <span className="flex min-w-0 items-center gap-2 font-mono text-[12.5px] text-faint">
              <GitBranchIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75]" />
              <span className="truncate">{repo.defaultBranch}</span>
            </span>
            <span className="text-muted">{repo.private ? t("github.private") : t("github.public")}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
};

const Installations = ({ slug }: { readonly slug: string | null }) => {
  const trpc = useTRPC();
  const installations = useQuery(trpc.github.installations.queryOptions());
  const [picked, setPicked] = useState<string | null>(null);
  const list = installations.data ?? [];
  const several = list.length > 1;
  const selected = list.find((row) => row.installationId === picked) ?? list[0];
  const installUrl = slug === null ? null : `https://github.com/apps/${slug}/installations/new`;
  return (
    <>
      <Section
        title={t("github.installations")}
        {...(installations.data === undefined ? {} : { count: installations.data.length })}
        {...(installUrl === null || list.length === 0 ? {} : { end: <span className="text-body"><OutLink href={installUrl}>{t("github.installElsewhere")}</OutLink></span> })}
      >
        {installations.isPending ? <SkeletonRows rows={1} height="h-10" /> : null}
        {installations.error === null ? null : <ErrorLine className="border-t border-line py-3">{errorText(installations.error)}</ErrorLine>}
        {installations.data?.length === 0 ? (
          <p className="flex min-h-10 flex-wrap items-center gap-x-3 border-y border-line py-2 text-muted">
            {t("github.noInstallations")}
            {installUrl === null ? null : <OutLink href={installUrl}>{t("github.installOnGitHub")}</OutLink>}
          </p>
        ) : null}
        <ul className="rows">
          {list.map((installation) => {
            const isSelected = several && installation === selected;
            return (
              <li
                key={installation.installationId}
                aria-selected={several ? isSelected : undefined}
                className={cn("relative flex h-10 items-center gap-3 px-2.5", several && "hover:bg-raise", isSelected && "bg-sel hover:bg-sel")}
              >
                {several ? (
                  <button
                    type="button"
                    className="absolute inset-0"
                    aria-label={installation.accountLogin}
                    onClick={() => { setPicked(installation.installationId); }}
                  />
                ) : null}
                {installation.accountKind === "organization" ? (
                  <Building2Icon aria-hidden className="size-[15px] stroke-[1.75] text-muted" />
                ) : (
                  <UserIcon aria-hidden className="size-[15px] stroke-[1.75] text-muted" />
                )}
                <span className="truncate font-medium">{installation.accountLogin}</span>
                <span className="hidden font-mono text-[12.5px] text-faint sm:inline">{installation.accountKind === "organization" ? t("github.organization") : t("github.user")}</span>
                <span className="ml-auto whitespace-nowrap text-muted">{installation.repositorySelection === "all" ? t("github.allRepos") : t("github.selectedRepos")}</span>
                <span className="relative ml-6 sm:ml-[120px]">
                  <OutLink href={installationSettingsUrl(installation)}>{t("github.configure")}</OutLink>
                </span>
              </li>
            );
          })}
        </ul>
      </Section>
      {selected === undefined ? null : <Repositories key={selected.installationId} installation={selected} />}
    </>
  );
};

const BotName = ({ name, email }: { readonly name: string; readonly email: string | null }) =>
  email === null ? (
    <span className="truncate font-mono">{name}</span>
  ) : (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span tabIndex={0} className="truncate font-mono">{name}</span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content side="bottom" sideOffset={6} className="z-50 rounded-md border border-line-2 bg-surface px-2 py-1 font-mono text-[11.5px] text-text shadow-lg">
            {email}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );

const ConnectionProperties = ({ connection }: { readonly connection: Connection }) => {
  const permissions = orderPermissions(connection.permissions);
  return (
    <div data-testid="github-connection">
      <PanelLabel>{t("github.app")}</PanelLabel>
      <PropRow label={t("github.slug")}><span className="truncate font-mono">{connection.slug ?? "–"}</span></PropRow>
      <PropRow label={t("github.appId")}><span className="font-mono">{connection.appId}</span></PropRow>
      <PropRow label={t("github.bot")}><BotName name={connection.botName ?? "–"} email={connection.botEmail} /></PropRow>
      <PropRow label={t("github.secrets")}>
        <LockIcon aria-hidden className="stroke-[1.75]" />
        <span className="text-muted">{t("github.secretsStored")}</span>
      </PropRow>
      <Sep />
      <PanelLabel count={permissions.length}>{t("github.permissions")}</PanelLabel>
      <ul aria-label={t("github.permissions")}>
        {permissions.map(([name, level]) => <PermissionRow key={name} name={name} level={level} />)}
      </ul>
      <p className="mt-2 text-sm text-faint">{t("github.permissionsHelp")}</p>
    </div>
  );
};

/** What a new App asks for, before it exists: from the manifest, through the API. */
const RequestProperties = () => {
  const trpc = useTRPC();
  const request = useQuery(trpc.github.appRequest.queryOptions());
  if (request.data === undefined) {
    return (
      <div aria-busy className="space-y-3">
        <Skeleton className="w-[120px]" />
        {Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className="w-full" />)}
      </div>
    );
  }
  const { permissions, notAsked, webhookPossible } = request.data;
  const [workflowsBefore = "", workflowsAfter = ""] = t("github.workflowsHelp").split("{path}");
  return (
    <div data-testid="github-request">
      <PanelLabel count={permissions.length}>{t("github.asksFor")}</PanelLabel>
      <ul>
        {permissions.map((row) => <PermissionRow key={row.name} name={row.name} level={row.level} />)}
      </ul>
      <Sep />
      <PanelLabel>{t("github.notAskedFor")}</PanelLabel>
      <ul>
        {notAsked.map((name) => <PermissionRow key={name} name={name} level={t("github.off")} levelClass="text-faint" />)}
      </ul>
      <p className="mt-1 text-sm text-faint">
        {workflowsBefore}
        <code className="font-mono text-[11.5px]">.github/workflows/</code>
        {workflowsAfter}
      </p>
      <Sep />
      <PanelLabel>{t("github.events")}</PanelLabel>
      <div className="flex h-[30px] items-center justify-between gap-3 text-[12.5px]">
        <span className="text-muted">{t("github.webhook")}</span>
        <span className="text-text">{webhookPossible ? t("github.webhookOn") : t("github.webhookOff")}</span>
      </div>
    </div>
  );
};

type Path = "new" | "existing";

const ConnectForm = () => {
  const trpc = useTRPC();
  const request = useQuery(trpc.github.appRequest.queryOptions());
  // "Use an existing App" stays the default until ticket 40's browser run proves the manifest flow.
  const [path, setPath] = useState<Path>("existing");
  const tabs: readonly { readonly id: Path; readonly label: string }[] = [
    { id: "new", label: t("github.newTitle") },
    { id: "existing", label: t("github.existingTitle") },
  ];
  return (
    <Section title={t("github.createSection")}>
      <div role="tablist" className="mb-6 mt-1 flex gap-[18px] border-b border-line">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={path === tab.id}
            onClick={() => { setPath(tab.id); }}
            className={cn("-mb-px border-b-2 border-transparent pb-2.5 pt-1 font-medium text-muted hover:text-text", path === tab.id && "border-text text-text")}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {path === "existing" ? <ExistingAppForm /> : <NewAppForm webhookPossible={request.data?.webhookPossible} />}
      </div>
    </Section>
  );
};

/**
 * Organization › GitHub (F-006): "Use an existing App" or "Create a new App" (the manifest flow),
 * then the App, its installations and the repos ostra can reach. No secret is ever shown back.
 */
export const GitHubView = () => {
  const trpc = useTRPC();
  const params = useSearchParams();
  const me = useQuery(trpc.me.get.queryOptions());
  const connection = useQuery(trpc.github.connection.queryOptions());
  const callbackError = params.get("error");
  const connected = connection.data ?? null;
  const justConnected = params.get("connected") !== null;
  const slug = connected?.slug ?? null;

  return (
    <PageFrame
      crumbs={[{ label: me.data?.organization?.name ?? t("shell.organization") }, { label: t("shell.github") }]}
      {...(slug === null
        ? {}
        : {
            actions: (
              <a href={`https://github.com/apps/${slug}`} target="_blank" rel="noreferrer" className={buttonVariants()}>
                <ExternalLinkIcon className="stroke-[1.75]" /> {t("github.openOnGitHub")}
              </a>
            ),
          })}
      {...(connection.isPending ? {} : { properties: connected === null ? <RequestProperties /> : <ConnectionProperties connection={connected} /> })}
    >
      <PageHeading title={t("github.title")} lede={t("github.lede")} />
      {callbackError === null ? null : <ErrorLine className="mt-2 max-w-[720px]">{callbackError.slice(0, 300)}</ErrorLine>}
      {connection.isPending ? (
        <Section title={t("github.connection")}>
          <SkeletonRows rows={3} />
        </Section>
      ) : connected !== null ? (
        <>
          <Section title={t("github.connection")}>
            <div className="flex h-10 items-center gap-3 border-y border-line px-2.5">
              <Status tone="green" className="w-[140px] text-green">{t("github.connected")}</Status>
              <span className="font-mono text-[12.5px] text-text">{connected.slug ?? "–"}</span>
              {justConnected ? (
                <span className="ml-auto flex items-center gap-1.5 text-faint">
                  <CheckIcon aria-hidden className="size-[14px] stroke-[1.75] text-green" />
                  {t("github.justConnected")}
                </span>
              ) : null}
            </div>
          </Section>
          <Installations slug={connected.slug} />
        </>
      ) : (
        <ConnectForm />
      )}
    </PageFrame>
  );
};
