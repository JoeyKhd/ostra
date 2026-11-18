"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, ExternalLinkIcon, GitPullRequestIcon, TriangleAlertIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import type { SubmitEvent } from "react";

import { PageFrame, PageHeading, PropGroup, PropRow, Section } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Chip, Status } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

type Connection = NonNullable<RouterOutputs["github"]["connection"]>;

/** The permissions ostra needs beyond the basics, shown first (F-006). */
const highlighted = ["checks", "actions", "contents", "pull_requests"] as const;

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

const Permissions = ({ permissions }: { readonly permissions: Readonly<Record<string, string>> }) => {
  const names = Object.keys(permissions).sort((a, b) => {
    const ia = highlighted.findIndex((name) => name === a);
    const ib = highlighted.findIndex((name) => name === b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={t("github.permissions")}>
      {names.map((name) => (
        <li key={name}>
          <Chip className="font-mono">
            {name}: {permissions[name]}
          </Chip>
        </li>
      ))}
    </ul>
  );
};

const ExistingAppForm = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
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
  return (
    <form onSubmit={submit} noValidate aria-label={t("github.existingTitle")}>
      <Field id="app-id" label={t("github.appId")}>
        <Input id="app-id" inputMode="numeric" className="font-mono" value={appId} onChange={(e) => { setAppId(e.target.value.replace(/\D/g, "")); }} />
      </Field>
      <Field id="private-key" label={t("github.privateKey")} help={t("github.privateKeyHelp")}>
        <Textarea
          id="private-key"
          className="min-h-24 font-mono text-sm"
          spellCheck={false}
          autoComplete="off"
          value={privateKey}
          onChange={(e) => { setPrivateKey(e.target.value); }}
          placeholder="-----BEGIN RSA PRIVATE KEY-----"
        />
        <input
          type="file"
          accept=".pem,application/x-pem-file"
          aria-label={t("github.privateKeyFile")}
          className="mt-1.5 block text-sm text-muted file:mr-2 file:rounded-sm file:border file:border-line-2 file:bg-surface file:px-2 file:py-0.5 file:text-text"
          onChange={(e) => void readKeyFile(e.target.files?.[0])}
        />
      </Field>
      <Field id="webhook-secret" label={t("github.webhookSecret")}>
        <Input id="webhook-secret" type="password" autoComplete="off" className="font-mono" value={webhookSecret} onChange={(e) => { setWebhookSecret(e.target.value); }} />
      </Field>
      {connect.error === null ? null : (
        <p role="alert" className="mb-3 flex items-start gap-2 text-sm text-red">
          <TriangleAlertIcon className="mt-0.5 size-[14px] shrink-0" />
          {errorText(connect.error)}
        </p>
      )}
      <Button type="submit" variant="primary" disabled={connect.isPending || appId === "" || privateKey === "" || webhookSecret === ""}>
        {connect.isPending ? t("github.connecting") : t("github.connect")}
      </Button>
    </form>
  );
};

const NewAppForm = () => {
  const trpc = useTRPC();
  const [owner, setOwner] = useState("");
  const start = useMutation(
    trpc.github.startManifest.mutationOptions({
      onSuccess: (result) => {
        postManifest(result.createUrl, result.state, result.manifest);
      },
    }),
  );
  return (
    <div>
      <Field id="owner" label={t("github.owner")} help={t("github.ownerHelp")}>
        <Input id="owner" className="font-mono" value={owner} onChange={(e) => { setOwner(e.target.value.trim()); }} placeholder="ostra-test" />
      </Field>
      {start.data?.note === undefined || start.data.note === null ? null : <p className="mb-3 text-sm text-amber">{start.data.note}</p>}
      {start.error === null ? null : <p role="alert" className="mb-3 text-sm text-red">{errorText(start.error)}</p>}
      <Button onClick={() => { start.mutate({ ownerLogin: owner === "" ? null : owner }); }} disabled={start.isPending}>
        <ExternalLinkIcon /> {start.isPending ? t("github.preparing") : t("github.create")}
      </Button>
      <p className="mt-2 text-sm text-faint">{t("github.createHelp")}</p>
    </div>
  );
};

const Installations = () => {
  const trpc = useTRPC();
  const installations = useQuery(trpc.github.installations.queryOptions());
  return (
    <Section title={t("github.installations")} count={installations.data?.length ?? 0}>
      {installations.error === null ? null : <p role="alert" className="text-sm text-red">{errorText(installations.error)}</p>}
      {installations.data?.length === 0 ? <p className="border-t border-line py-3 text-muted">{t("github.noInstallations")}</p> : null}
      <ul className="rows">
        {installations.data?.map((installation) => (
          <li key={installation.installationId} className="flex min-h-10 items-center gap-3">
            <GitPullRequestIcon className="size-[15px] text-muted" />
            <span className="font-medium">{installation.accountLogin}</span>
            <span className="text-faint">{installation.accountKind === "organization" ? t("github.organization") : t("github.user")}</span>
            <span className="ml-auto text-muted">
              {installation.repositorySelection === "all" ? t("github.allRepos") : t("github.selectedRepos")}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
};

const ConnectionProperties = ({ connection }: { readonly connection: Connection }) => (
  <div data-testid="github-connection">
    <PropGroup title={t("github.app")}>
      <PropRow label={t("github.slug")}><span className="font-mono">{connection.slug ?? "–"}</span></PropRow>
      <PropRow label={t("github.appId")}><span className="font-mono">{connection.appId}</span></PropRow>
      <PropRow label={t("github.bot")}><span className="truncate font-mono text-sm">{connection.botName ?? "–"}</span></PropRow>
      <PropRow label={t("github.secrets")}><span className="text-faint">{t("github.secretsStored")}</span></PropRow>
    </PropGroup>
    <PropGroup title={t("github.permissions")}>
      <Permissions permissions={connection.permissions} />
    </PropGroup>
  </div>
);

/**
 * Organization › GitHub (F-006): "Use an existing App" or "Create a new App" (the manifest flow),
 * then the App's slug, permissions and installations. No secret is ever shown back.
 */
export const GitHubView = () => {
  const trpc = useTRPC();
  const params = useSearchParams();
  const connection = useQuery(trpc.github.connection.queryOptions());
  const [path, setPath] = useState<"existing" | "new">("existing");
  const callbackError = params.get("error");
  const connected = connection.data ?? null;

  return (
    <PageFrame
      crumbs={[{ label: t("shell.organization") }, { label: t("shell.github") }]}
      properties={connected === null ? undefined : <ConnectionProperties connection={connected} />}
    >
      <PageHeading title={t("github.title")} lede={t("github.lede")} />
      {callbackError === null ? null : (
        <p role="alert" className="mt-4 text-sm text-red">{callbackError.slice(0, 300)}</p>
      )}
      {connected !== null ? (
        <>
          <Section title={t("github.connection")}>
            <div className="flex min-h-10 items-center gap-3 border-t border-b border-line">
              <Status tone="green">{t("github.connected")}</Status>
              <span className="font-mono">{connected.slug}</span>
              {params.get("connected") === null ? null : <CheckIcon className="size-[14px] text-green" />}
            </div>
          </Section>
          <Installations />
        </>
      ) : connection.isPending ? null : (
        <Section title={t("github.connectTitle")}>
          <div role="tablist" className="mb-5 flex gap-[18px] border-b border-line">
            {(["existing", "new"] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={path === id}
                onClick={() => { setPath(id); }}
                className={cn("pb-2.5 font-medium text-muted", path === id && "text-text shadow-[inset_0_-2px_0_var(--text)]")}
              >
                {id === "existing" ? t("github.existingTitle") : t("github.newTitle")}
              </button>
            ))}
          </div>
          <div className="max-w-[460px]">{path === "existing" ? <ExistingAppForm /> : <NewAppForm />}</div>
        </Section>
      )}
    </PageFrame>
  );
};
