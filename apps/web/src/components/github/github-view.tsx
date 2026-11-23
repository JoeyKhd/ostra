"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon,
  ExternalLinkIcon,
  InfoIcon,
  LoaderCircleIcon,
  PlusIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import type { ReactNode, SubmitEvent } from "react";

import { PageFrame, PageHeading, Section } from "@/components/shell/page-frame";
import { usePhone } from "@/components/tasks/take-it-local";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { UnderlineTabs } from "@/components/ui/underline-tabs";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import { useLeaveGuard } from "@/lib/use-leave-guard";

import { EventsRow, LeaveDialog, MadeWithoutNote, ReplaceDialog, ShownOnceSheet, ShownOnceView } from "./github-events";
import type { ShownOnce } from "./github-events";
import {
  AddOrganizationGroup,
  AppPanel,
  AppSection,
  AppsSkeleton,
  ConnectAnotherForm,
  InstallationPanel,
  PanelSep,
  PrivateAppsGroup,
  StrangersLine,
  useStatusLine,
} from "./github-orgs";
import type { GitHubApp } from "./github-orgs";
import { appGeneralSettingsUrl, appVisibility, sectionState } from "./github-orgs-words";

/** While an App waits for its events, the page asks GitHub again this often (github-events.md, "Done"). */
const WAITING_REFETCH_MS = 15_000;


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
  <p role="alert" className={cn("flex items-start gap-2 text-ui text-red", className)}>
    <TriangleAlertIcon aria-hidden className="mt-0.5 size-[14px] shrink-0 stroke-[1.75]" />
    <span className="min-w-0 break-words">{children}</span>
  </p>
);

/** A properties-panel group label, with its count at the right end. */
const PanelLabel = ({ children, count }: { readonly children: ReactNode; readonly count?: number }) => (
  <h3 className="mb-1.5 flex items-center text-xs font-medium text-faint">
    {children}
    {count === undefined ? null : <span className="ml-auto font-mono text-xs">{count}</span>}
  </h3>
);

/** A permission and its level: name mono `--muted` left, level mono `--text` right, one left edge. */
const PermissionRow = ({ name, level, levelClass }: { readonly name: string; readonly level: string; readonly levelClass?: string }) => (
  <li className="flex h-[30px] items-center justify-between gap-3 font-mono text-ui">
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
  const [clientSecret, setClientSecret] = useState("");
  const connect = useMutation(
    trpc.github.connectExisting.mutationOptions({
      onSuccess: async () => {
        // Nothing secret stays in the page once it's saved.
        setPrivateKey("");
        setWebhookSecret("");
        setClientSecret("");
        await queryClient.invalidateQueries({ queryKey: trpc.github.pathKey() });
        await queryClient.invalidateQueries({ queryKey: trpc.setup.status.queryKey() });
      },
    }),
  );
  const readKeyFile = async (file: File | undefined) => {
    if (file !== undefined) setPrivateKey(await file.text());
  };
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    // Q295: the client secret is optional here, and members can't link until it's added.
    const client = clientSecret.trim();
    connect.mutate({ appId: appId.trim(), privateKey, webhookSecret, ...(client === "" ? {} : { clientSecret: client }) });
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
          className="min-h-24 font-mono text-ui"
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
      <Field id="client-secret" label={t("github.clientSecret")} help={t("github.clientSecretHelp")}>
        <Input id="client-secret" type="password" autoComplete="off" className="font-mono" disabled={busy} value={clientSecret} onChange={(e) => { setClientSecret(e.target.value); }} />
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
  const [visibility, setVisibility] = useState<"private" | "public">("private");
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
        <fieldset className="mb-4">
          <legend id="app-visibility" className="mb-1.5 block text-sm font-medium text-muted">{t("githubOrgs.setup.question")}</legend>
          <RadioGroup
            value={visibility}
            onValueChange={(value) => { if (value === "private" || value === "public") setVisibility(value); }}
            aria-labelledby="app-visibility"
            disabled={start.isPending}
          >
            <label className="flex h-8 cursor-pointer items-center gap-2.5 text-body">
              <RadioGroupItem value="private" />
              {t("githubOrgs.setup.private")}
            </label>
            <label className="flex h-8 cursor-pointer items-center gap-2.5 text-body">
              <RadioGroupItem value="public" />
              {t("githubOrgs.setup.public")}
            </label>
          </RadioGroup>
          <p className="mt-1 text-xs text-faint">{t("githubOrgs.setup.help")}</p>
        </fieldset>
      </div>
      {webhookPossible === false ? (
        <p className="mb-4 flex max-w-[560px] items-start gap-2.5 text-ui text-muted">
          <InfoIcon aria-hidden className="mt-px size-[15px] shrink-0 stroke-[1.75]" />
          <span>
            {before}
            <code className="font-mono text-sm">OSTRA_CORE_PUBLIC_URL</code>
            {after}
          </span>
        </p>
      ) : null}
      {start.error === null ? null : <ErrorLine className="mb-3">{errorText(start.error)}</ErrorLine>}
      <Button variant="primary" onClick={() => { start.mutate({ ownerLogin: owner === "" ? null : owner, public: visibility === "public" }); }} disabled={start.isPending}>
        {start.isPending ? <LoaderCircleIcon className="animate-spin" /> : <ExternalLinkIcon className="stroke-[1.75]" />}
        {start.isPending ? t("github.preparing") : t("github.create")}
      </Button>
      <p className="mt-2 text-sm text-faint">{t("github.createHelp")}</p>
    </div>
  );
};

/** Where an installation's settings are on GitHub: an org's, or a user's own. */
export const installationSettingsUrl = (installation: {
  readonly accountKind: "organization" | "user";
  readonly accountLogin: string;
  readonly installationId: string;
}): string =>
  installation.accountKind === "organization"
    ? `https://github.com/organizations/${installation.accountLogin}/settings/installations/${installation.installationId}`
    : `https://github.com/settings/installations/${installation.installationId}`;

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
        <code className="font-mono text-[12.5px]">.github/workflows/</code>
        {workflowsAfter}
      </p>
      <Sep />
      <PanelLabel>{t("github.events")}</PanelLabel>
      <div className="flex h-[30px] items-center justify-between gap-3 text-ui">
        <span className="text-muted">{t("github.webhook")}</span>
        <span className="text-text">{webhookPossible ? t("github.webhookOn") : t("github.webhookOff")}</span>
      </div>
    </div>
  );
};

/**
 * Q295: the own App's OAuth client secret, added or replaced in the properties panel. Members link
 * their GitHub accounts through it (F-119); nothing secret stays in the page once it's saved.
 */
const ClientSecretForm = ({ replacing, settingsUrl, onDone }: { readonly replacing: boolean; readonly settingsUrl: string | null; readonly onDone: (status: string) => void }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [secret, setSecret] = useState("");
  const save = useMutation(
    trpc.github.setClientSecret.mutationOptions({
      onSuccess: async (result) => {
        setSecret("");
        await queryClient.invalidateQueries({ queryKey: trpc.github.pathKey() });
        await queryClient.invalidateQueries({ queryKey: trpc.account.github.get.queryKey() });
        onDone(result.replaced ? t("github.clientSecretReplaced") : t("github.clientSecretSaved"));
      },
    }),
  );
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    save.mutate({ clientSecret: secret.trim() });
  };
  const title = replacing ? t("github.replaceClientSecret") : t("github.addClientSecret");
  return (
    <form onSubmit={submit} noValidate aria-label={title} data-testid="client-secret-form">
      <PanelLabel>{title}</PanelLabel>
      <p className="mb-3 text-sm text-muted">{t("github.clientSecretFormHelp")}</p>
      {settingsUrl === null ? null : (
        <a href={settingsUrl} target="_blank" rel="noreferrer" className="mb-3.5 inline-flex items-center gap-1 text-sm text-teal hover:underline">
          {t("github.openAppSettings")}
          <ExternalLinkIcon aria-hidden className="size-[13px] stroke-[1.75]" />
        </a>
      )}
      <Field id="set-client-secret" label={t("github.clientSecret")}>
        <Input id="set-client-secret" type="password" autoComplete="off" className="font-mono" disabled={save.isPending} value={secret} onChange={(e) => { setSecret(e.target.value); }} />
      </Field>
      {save.error === null ? null : <ErrorLine className="mb-3">{errorText(save.error)}</ErrorLine>}
      <Button type="submit" variant="primary" disabled={save.isPending || secret.trim() === ""}>
        {save.isPending ? t("github.savingClientSecret") : t("github.saveClientSecret")}
      </Button>
    </form>
  );
};

/** Q295: while the own App has no client secret, the page says member linking is off, and offers to add it. */
const LinkingOffLine = ({ onAdd }: { readonly onAdd: () => void }) => (
  <p className="mt-4 flex max-w-[720px] flex-wrap items-center gap-x-2.5 gap-y-1 text-ui text-muted" data-testid="member-linking-off">
    <InfoIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75]" />
    <span className="min-w-0">{t("github.linkingOff")}</span>
    <button type="button" className="font-medium text-teal hover:underline" onClick={onAdd}>
      {t("github.addClientSecret")}
    </button>
  </p>
);

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
      <UnderlineTabs tabs={tabs} selected={path} onSelect={setPath} label={t("github.createSection")} idPrefix="github-app" className="mb-6 mt-1" />
      <div role="tabpanel" id={`github-app-panel-${path}`} aria-labelledby={`github-app-tab-${path}`}>
        {path === "existing" ? <ExistingAppForm /> : <NewAppForm webhookPossible={request.data?.webhookPossible} />}
      </div>
    </Section>
  );
};

type Panel =
  | { readonly kind: "app"; readonly connectionId: string }
  | { readonly kind: "installation"; readonly installationId: string }
  | { readonly kind: "add-org" }
  | { readonly kind: "add-app" }
  | { readonly kind: "client-secret" }
  /** F-006/c4: Turn on's result in the App's panel, never in the URL. */
  | { readonly kind: "once"; readonly shown: ShownOnce };

/** What a leave the result asked about does once `Leave` is chosen. */
type Leaving = { readonly run: () => void };

/**
 * Organization › GitHub (F-006, F-136): "Use an existing App" or "Create a new App" (the manifest
 * flow) until one is connected; then each App with its installations, linked, waiting to be
 * linked or removed. No secret is ever shown back, except a generated webhook secret, once.
 */
export const GitHubView = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const params = useSearchParams();
  const phone = usePhone();
  const me = useQuery(trpc.me.get.queryOptions());
  // F-006/c4: while an App waits for GitHub to list its events, ask again every 15s.
  const connections = useQuery({
    ...trpc.github.connections.queryOptions(),
    refetchInterval: (query) => ((query.state.data ?? []).some((app) => sectionState(app) === "waiting") ? WAITING_REFETCH_MS : false),
  });
  // The organization's own App, as milestone 1 reads it: its bot and permissions for its panel.
  const own = useQuery(trpc.github.connection.queryOptions());
  // Whether GitHub can reach this server (F-006/c4), and the events ostra uses.
  const request = useQuery(trpc.github.appRequest.queryOptions());
  const ownOf = (app: { readonly own: boolean }) => (app.own ? (own.data ?? null) : null);
  const callbackError = params.get("error");
  const apps = connections.data ?? [];
  const connected = apps.length > 0;
  // The selection may come as `?app=<connectionId>` (github-events.md, "Route").
  const [panel, setPanel] = useState<Panel | null>(() => {
    const app = params.get("app");
    return app === null ? null : { kind: "app", connectionId: app };
  });
  const [status, setStatus] = useStatusLine();

  // ---- F-006/c4: Turn on, its result shown once, and leaving it ----
  const [refusedPublic, setRefusedPublic] = useState(false);
  const [replacing, setReplacing] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const turnOn = useMutation(
    trpc.github.turnOnWebhook.mutationOptions({
      onSuccess: (result) => {
        setPanel({ kind: "once", shown: { kind: "secret", connectionId: result.connectionId, replaced: result.replaced, webhookUrl: result.webhookUrl, webhookSecret: result.webhookSecret, events: result.events } });
        // Not awaited: Turn on is done once the result shows, while the App's state refetches.
        void queryClient.invalidateQueries({ queryKey: trpc.github.connections.queryKey() });
      },
      onError: (error) => {
        // The address stopped being public: the row goes back to `Off · no public address`.
        if (error.data?.code === "PRECONDITION_FAILED") {
          setRefusedPublic(true);
          void queryClient.invalidateQueries({ queryKey: trpc.github.appRequest.queryKey() });
        }
      },
    }),
  );
  const holdingSecret = panel?.kind === "once" && panel.shown.kind === "secret";
  /** Runs `next` at once, or, while the result holds a secret, once `Leave` is chosen. */
  const leaveThen = useCallback((next: () => void) => {
    if (holdingSecret) setLeaving({ run: next });
    else next();
  }, [holdingSecret]);
  const choosePanel = (next: Panel | null) => { leaveThen(() => { setPanel(next); }); };
  // Every other way out of the page (a link, the shell's keys and palette, Back) asks first too.
  useLeaveGuard(holdingSecret, useCallback((go: () => void) => { setLeaving({ run: go }); }, []));
  const webhookPossible = request.data === undefined ? undefined : request.data.webhookPossible && !refusedPublic;
  const startTurnOn = (connectionId: GitHubApp["connectionId"]) => {
    turnOn.reset();
    turnOn.mutate({ connectionId });
  };
  const eventsRowOf = (app: GitHubApp) => (
    <EventsRow
      app={app}
      webhookPossible={webhookPossible}
      eventCount={request.data?.events.length}
      turningOn={turnOn.isPending && turnOn.variables.connectionId === app.connectionId}
      error={turnOn.error !== null && turnOn.variables.connectionId === app.connectionId ? errorText(turnOn.error) : null}
      checking={connections.isFetching}
      onTurnOn={() => { startTurnOn(app.connectionId); }}
      onWhichOnes={() => { setPanel({ kind: "once", shown: { kind: "which-ones", connectionId: app.connectionId } }); }}
      onNewSecret={() => { setReplacing(app.connectionId); }}
      onCheckAgain={() => { void connections.refetch(); }}
    />
  );
  const shownApp = panel?.kind === "once" ? apps.find((app) => app.connectionId === panel.shown.connectionId) : undefined;
  /** Back to the App's panel: `Done`, or a leave that was asked about. */
  const backToApp = (connectionId: string) => {
    setPanel({ kind: "app", connectionId });
    void queryClient.invalidateQueries({ queryKey: trpc.github.connections.queryKey() });
  };
  const closeShown = () => {
    if (panel?.kind !== "once") return;
    const connectionId = panel.shown.connectionId;
    leaveThen(() => { backToApp(connectionId); });
  };
  const shownView =
    panel?.kind === "once" && shownApp !== undefined ? (
      <ShownOnceView
        key={panel.shown.kind === "secret" ? panel.shown.webhookSecret : panel.shown.kind}
        app={shownApp}
        shown={panel.shown}
        events={request.data?.events ?? []}
        phone={phone}
        onDone={() => { backToApp(shownApp.connectionId); }}
        onEscape={closeShown}
      />
    ) : null;

  const allInstallations = apps.flatMap((app) => app.installations.map((installation) => ({ app, installation })));
  const selectedInstallation = panel?.kind === "installation" ? allInstallations.find((row) => row.installation.installationId === panel.installationId) : undefined;
  const selectedApp = panel?.kind === "app" ? apps.find((app) => app.connectionId === panel.connectionId) : undefined;
  // F-136: an App is private by default; one whose owner isn't known yet is offered for installing
  // (`appVisibility`), so the panel never says one "stays on" an owner it doesn't know.
  const anyPrivate = apps.some((app) => appVisibility(app) === "private");
  const anyPublic = apps.some((app) => appVisibility(app) !== "private");
  const orgGroups = (
    <>
      {anyPublic ? <AddOrganizationGroup apps={apps} /> : null}
      {anyPublic && anyPrivate ? <PanelSep /> : null}
      {anyPrivate ? <PrivateAppsGroup apps={apps} /> : null}
    </>
  );

  const ownApp = apps.find((app) => app.own);
  const onClientSecret = () => { choosePanel({ kind: "client-secret" }); };
  const properties = !connected ? (
    connections.isPending ? undefined : <RequestProperties />
  ) : shownApp !== undefined ? (
    // On a phone the result is a bottom sheet over the page, and the App's panel stays under it.
    phone ? <AppPanel app={shownApp} own={ownOf(shownApp)} onClientSecret={onClientSecret} events={eventsRowOf(shownApp)} /> : shownView
  ) : panel?.kind === "add-app" ? (
    <ConnectAnotherForm onDone={() => { setPanel(null); }} />
  ) : panel?.kind === "client-secret" ? (
    <ClientSecretForm
      replacing={own.data?.clientSecretSet === true}
      settingsUrl={ownApp === undefined || ownApp.slug === null || ownApp.ownerLogin === null ? null : appGeneralSettingsUrl(ownApp.slug, { login: ownApp.ownerLogin, kind: ownApp.ownerKind ?? "organization" })}
      onDone={(text) => { setPanel(null); setStatus(text); }}
    />
  ) : panel?.kind === "add-org" ? (
    orgGroups
  ) : selectedApp !== undefined ? (
    <AppPanel app={selectedApp} own={ownOf(selectedApp)} onClientSecret={onClientSecret} events={eventsRowOf(selectedApp)} />
  ) : selectedInstallation !== undefined ? (
    <>
      <InstallationPanel app={selectedInstallation.app} installation={selectedInstallation.installation} />
      <PanelSep />
      {orgGroups}
    </>
  ) : apps.length === 1 && apps[0] !== undefined && apps[0].installations.length <= 1 ? (
    <AppPanel app={apps[0]} own={ownOf(apps[0])} onClientSecret={onClientSecret} events={eventsRowOf(apps[0])} />
  ) : (
    orgGroups
  );

  return (
    <PageFrame
      crumbs={[{ label: me.data?.organization?.name ?? t("shell.organization") }, { label: t("shell.github") }]}
      {...(connected
        ? {
            actions: (
              <>
                {/* At phone width the two buttons take short labels; their names stay the full ones. */}
                <Button aria-label={t("githubOrgs.connectAnother.title")} onClick={() => { choosePanel({ kind: "add-app" }); }}>
                  <span className="sm:hidden">{t("githubOrgs.connectAnother.short")}</span>
                  <span className="hidden sm:inline">{t("githubOrgs.connectAnother.title")}</span>
                </Button>
                <Button aria-label={t("githubOrgs.addOrg.label")} variant="primary" onClick={() => { choosePanel({ kind: "add-org" }); }}>
                  <PlusIcon /> <span className="sm:hidden">{t("githubOrgs.addOrg.short")}</span>
                  <span className="hidden sm:inline">{t("githubOrgs.addOrg.label")}</span>
                </Button>
              </>
            ),
          }
        : {})}
      {...(properties === undefined ? {} : { properties })}
      wideProperties={panel?.kind === "add-app" || panel?.kind === "client-secret" || (shownApp !== undefined && !phone)}
    >
      {phone && shownView !== null ? (
        <ShownOnceSheet title={t("githubOrgs.events.once.eyebrow")} onClose={closeShown}>{shownView}</ShownOnceSheet>
      ) : null}
      <PageHeading title={t("github.title")} lede={connected ? t("githubOrgs.lede") : t("github.lede")} />
      {callbackError === null ? null : <ErrorLine className="mt-2 max-w-[720px]">{callbackError.slice(0, 300)}</ErrorLine>}
      {status === null ? null : (
        <p role="status" className="mt-2 flex items-center gap-1.5 text-ui text-muted">
          <CheckIcon aria-hidden className="size-[14px] stroke-[1.75]" /> {status}
        </p>
      )}
      {connections.error === null ? null : <ErrorLine className="mt-3">{errorText(connections.error)}</ErrorLine>}
      {connections.isPending ? (
        <AppsSkeleton />
      ) : connected ? (
        <>
          {apps.map((app) => (
            <AppSection
              key={app.connectionId}
              app={app}
              selected={panel?.kind === "app" || panel?.kind === "installation" ? panel : panel?.kind === "once" ? { kind: "app", connectionId: panel.shown.connectionId } : null}
              onSelectApp={() => { choosePanel({ kind: "app", connectionId: app.connectionId }); }}
              onSelectInstallation={(installationId) => { choosePanel({ kind: "installation", installationId }); }}
              onStatus={setStatus}
              note={
                app.webhook.kind === "none" && webhookPossible !== undefined ? (
                  <MadeWithoutNote
                    webhookPossible={webhookPossible}
                    busy={turnOn.isPending && turnOn.variables.connectionId === app.connectionId}
                    onTurnOn={() => {
                      leaveThen(() => {
                        setPanel({ kind: "app", connectionId: app.connectionId });
                        startTurnOn(app.connectionId);
                      });
                    }}
                  />
                ) : null
              }
            />
          ))}
          {anyPublic ? <StrangersLine /> : null}
          {own.data === null || own.data === undefined || own.data.clientSecretSet ? null : <LinkingOffLine onAdd={onClientSecret} />}
          <LeaveDialog
            open={leaving !== null}
            onStay={() => { setLeaving(null); }}
            onLeave={() => {
              const next = leaving;
              setLeaving(null);
              // The result goes first, so a leave that selects nothing shows no secret again.
              setPanel(null);
              next?.run();
            }}
          />
          <ReplaceDialog
            app={apps.find((app) => app.connectionId === replacing) ?? null}
            open={replacing !== null}
            onCancel={() => { setReplacing(null); }}
            onReplace={() => {
              const connectionId = apps.find((app) => app.connectionId === replacing)?.connectionId;
              setReplacing(null);
              if (connectionId !== undefined) startTurnOn(connectionId);
            }}
          />
        </>
      ) : (
        <ConnectForm />
      )}
    </PageFrame>
  );
};
