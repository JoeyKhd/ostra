"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightIcon, CheckIcon, CircleAlertIcon, CircleCheckIcon, CircleXIcon, CopyIcon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { shortDate } from "@/components/members/member-words";
import { PageFrame, PageHeading, PropGroup, PropRow } from "@/components/shell/page-frame";
import { AlertDialog, AlertDialogContent } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Status } from "@/components/ui/status";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatAge } from "@/lib/format";
import { tNodes } from "@/lib/message-nodes";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { checkLine, checkStatus, imageNameOf, parseAddress, parsePrefix, prefixShown, shortDigest } from "./registry-words";

type Auth = "basic" | "node";
type Credential = { readonly username: string; readonly secret: string };

const field = "h-7 rounded-[7px] border border-line-2 bg-surface px-2.5 font-mono text-ui text-text placeholder:text-faint focus-visible:border-faint focus-visible:outline-none aria-invalid:border-red";
const row = "grid min-h-10 items-center gap-x-3 border-t border-line py-1.5 grid-cols-[140px_minmax(0,1fr)] sm:grid-cols-[180px_minmax(0,1fr)_auto]";

const Mono = ({ children }: { readonly children: ReactNode }) => <span className="font-mono">{children}</span>;

const ExecutorBadge = ({ executor }: { readonly executor: string }) => (
  <span className="inline-flex h-5 shrink-0 items-center rounded-md border border-line-2 px-1.5 font-mono text-[11px] text-faint">{executor}</span>
);

/** A credential row's form, opened in place by Replace or Add: never filled from the server. */
const CredentialForm = ({ kind, value, onChange, onCancel }: { readonly kind: "push" | "pull"; readonly value: Credential; readonly onChange: (next: Credential) => void; readonly onCancel: () => void }) => (
  <div className="col-span-full flex flex-wrap items-center gap-2 pb-1.5 sm:col-start-2">
    <input
      aria-label={`${t(kind === "push" ? "registryPage.push" : "registryPage.pull")}: ${t("registryPage.username")}`}
      placeholder={t("registryPage.username")}
      autoComplete="off"
      value={value.username}
      onChange={(event) => { onChange({ ...value, username: event.target.value }); }}
      className={cn(field, "w-[240px] font-sans")}
    />
    <input
      type="password"
      aria-label={`${t(kind === "push" ? "registryPage.push" : "registryPage.pull")}: ${t("registryPage.secret")}`}
      placeholder={t("registryPage.secret")}
      autoComplete="off"
      value={value.secret}
      onChange={(event) => { onChange({ ...value, secret: event.target.value }); }}
      className={cn(field, "w-[240px]")}
    />
    <Button variant="ghost" size="sm" className="h-7 text-muted" onClick={onCancel}>{t("registryPage.cancel")}</Button>
  </div>
);

/**
 * Organization › Registry (F-120, registry.md): where snapshots are pushed and pulled, the push and
 * pull credentials as set or not (their values never reach the page), the check, the pools that need
 * it and the snapshots it holds. Organization admins only.
 */
export const RegistryView = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const me = useQuery(trpc.me.get.queryOptions());
  const view = useQuery(trpc.registry.get.queryOptions());
  const use = useQuery(trpc.registryUse.get.queryOptions());
  const lastChange = useQuery(trpc.audit.list.queryOptions({ action: "registry.", limit: 5 }));
  const [address, setAddress] = useState<string | null>(null);
  const [prefix, setPrefix] = useState<string | null>(null);
  const [auth, setAuth] = useState<Auth | null>(null);
  const [push, setPush] = useState<Credential | null>(null);
  const [pull, setPull] = useState<Credential | null>(null);
  const [saved, setSaved] = useState(false);
  const [removing, setRemoving] = useState(false);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.registry.get.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.registryUse.get.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.audit.list.pathKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.fleetUse.pathKey() }),
    ]);
  };
  const set = useMutation(
    trpc.registry.set.mutationOptions({
      onSuccess: async (next) => {
        queryClient.setQueryData(trpc.registry.get.queryKey(), next);
        // The typed values leave the page's state at once: the page never holds a stored credential.
        setPush(null);
        setPull(null);
        setAddress(null);
        setPrefix(null);
        setAuth(null);
        setSaved(true);
        await refresh();
      },
    }),
  );
  const check = useMutation(trpc.registry.check.mutationOptions({ onSuccess: () => refresh() }));
  const clear = useMutation(trpc.registry.clear.mutationOptions({ onSuccess: async () => { setRemoving(false); setSaved(false); await refresh(); } }));

  const registry = view.data?.registry ?? null;
  const shownAddress = address ?? registry?.url ?? "";
  const shownPrefix = prefix ?? (registry === null ? "" : prefixShown(registry.repositoryPrefix));
  const shownAuth: Auth = auth ?? registry?.auth ?? "basic";
  const url = parseAddress(shownAddress);
  const path = parsePrefix(shownPrefix);
  const addressBad = shownAddress.trim() !== "" && url === null;
  const prefixBad = shownPrefix.trim() !== "" && path === null;
  const filled = (credential: Credential | null): credential is Credential => credential !== null && credential.username.trim() !== "" && credential.secret !== "";
  const dirty =
    (address !== null && address.trim() !== (registry?.url ?? "")) ||
    (prefix !== null && parsePrefix(prefix) !== (registry?.repositoryPrefix ?? null)) ||
    (auth !== null && auth !== (registry?.auth ?? "basic")) ||
    filled(push) ||
    (shownAuth === "basic" && filled(pull));
  const canSave = dirty && url !== null && path !== null && !set.isPending && (push === null || filled(push)) && (shownAuth === "node" || pull === null || filled(pull));
  // A check is under way while the saved settings have none, or the button's own request is out.
  const checking = check.isPending || (registry !== null && registry.check === null && (saved || check.isSuccess));

  // Leaving with unsaved changes asks the browser's leave prompt.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => { window.removeEventListener("beforeunload", warn); };
  }, [dirty]);

  const save = () => {
    if (url === null || path === null) return;
    setSaved(false);
    set.mutate({
      url,
      repositoryPrefix: path,
      auth: shownAuth,
      ...(filled(push) ? { push: { username: push.username.trim(), token: push.secret } } : {}),
      ...(shownAuth === "basic" && filled(pull) ? { pull: { username: pull.username.trim(), token: pull.secret } } : {}),
    });
  };

  const kubernetesPools = view.data?.poolsNeedingIt ?? [];
  const dockerPools = (use.data?.dockerPools ?? []).filter((pool) => !kubernetesPools.some((other) => other.poolId === pool.poolId));
  const builtOn = new Map((use.data?.builtOn ?? []).map((entry) => [entry.snapshotId, entry] as const));
  const projectPoolsHref = (poolId: string) => `/organization/runners/pools/${poolId}`;
  const status = checkStatus(registry?.check ?? null, registry !== null);
  const newestChange = lastChange.data?.entries.find((entry) => entry.action === "registry.set" || entry.action === "registry.cleared");
  const loading = view.data === undefined || use.data === undefined;
  const lastChecked = registry?.check?.checkedAt ?? null;

  const credentialRow = (kind: "push" | "pull") => {
    const isSet = kind === "push" ? (registry?.pushSet ?? false) : (registry?.pullSet ?? false);
    const form = kind === "push" ? push : pull;
    const setForm = kind === "push" ? setPush : setPull;
    const by = kind === "push" ? use.data?.credentials.push : use.data?.credentials.pull;
    return (
      <div className={row} data-testid={`registry-${kind}`}>
        <span className="text-ui text-muted">{t(kind === "push" ? "registryPage.push" : "registryPage.pull")}</span>
        <span className="flex min-w-0 items-center gap-2 text-ui">
          {isSet ? (
            <>
              <CheckIcon aria-hidden className="size-[13px] stroke-[1.75] text-muted" />
              <span className="text-text">{t("registryPage.set")}</span>
              {by === null || by === undefined ? null : <span className="truncate text-[12.5px] text-faint">{t("registryPage.setBy", { name: by.name ?? "ostra", date: shortDate(by.at) })}</span>}
            </>
          ) : (
            <span className="text-muted">{t("registryPage.notSet")}</span>
          )}
        </span>
        <span className="col-span-full justify-self-start sm:col-span-1 sm:justify-self-end">
          {form === null ? (
            <Button variant="outline" size="sm" className="h-7" onClick={() => { setForm({ username: "", secret: "" }); }}>
              {isSet ? t("registryPage.replace") : t("registryPage.add")}
            </Button>
          ) : null}
        </span>
        {form === null ? null : <CredentialForm kind={kind} value={form} onChange={setForm} onCancel={() => { setForm(null); }} />}
      </div>
    );
  };

  const properties = loading ? (
    <div className="space-y-3" aria-busy>
      <Skeleton className="w-[140px]" />
      <Skeleton className="w-[200px]" />
      <Skeleton className="w-[160px]" />
    </div>
  ) : (
    <>
      <PropGroup title={t("registryPage.panelRegistry")}>
        <PropRow label={t("registryPage.status")} labelWidth={104}>
          <Status tone={status.tone} className={(registry?.check ?? null) === null ? "text-faint" : ""}><span data-testid="registry-status">{status.text}</span></Status>
        </PropRow>
        <PropRow label={t("registryPage.auth")} labelWidth={104}>{registry === null ? <span className="text-faint">–</span> : registry.auth === "node" ? t("registryPage.authNode") : t("registryPage.authBasic")}</PropRow>
        <PropRow label={t("registryPage.images")} labelWidth={104}><Mono>{view.data.snapshots.length}</Mono></PropRow>
        <PropRow label={t("registryPage.lastCheck")} labelWidth={104}>
          {lastChecked === null ? <span className="text-faint">{t("registryPage.never")}</span> : <Mono>{formatAge(lastChecked)}</Mono>}
        </PropRow>
      </PropGroup>
      <PropGroup title={t("registryPage.issued")}>
        <PropRow label={t("registryPage.pullsToday")} labelWidth={104}><Mono>{registry?.auth === "node" ? "–" : use.data.issuedToday.pull}</Mono></PropRow>
        <PropRow label={t("registryPage.pushesToday")} labelWidth={104}><Mono>{use.data.issuedToday.push}</Mono></PropRow>
      </PropGroup>
      <PropGroup title={t("registryPage.lastChange")}>
        {newestChange === undefined ? <p className="text-[12.5px] text-faint">–</p> : (
          <p className="flex items-baseline gap-2 text-[12.5px] text-muted">
            <span className="min-w-0 flex-1">{t(newestChange.action === "registry.cleared" ? "registryPage.cleared" : "registryPage.changed", { name: newestChange.actor.name ?? "ostra" })}</span>
            <span className="shrink-0 font-mono text-faint">{formatAge(newestChange.at)}</span>
          </p>
        )}
        <Link href="/organization/audit?action=registry." className="mt-1.5 inline-flex items-center gap-1 text-sm text-teal hover:underline">
          {t("registryPage.auditLog")} <ArrowRightIcon aria-hidden className="size-[13px] stroke-[1.75]" />
        </Link>
      </PropGroup>
    </>
  );

  const checkResult = (() => {
    if (registry === null) return <span className="text-ui text-faint">{t("registryPage.checkNoRegistry")}</span>;
    if (checking) return <span className="text-ui text-muted">{t("registryPage.checking")}</span>;
    if (registry.check === null) return <span className="text-ui text-faint">{t("registryPage.notChecked")}</span>;
    const line = checkLine(registry.check, registry.repositoryPrefix, registry.url);
    const Icon = registry.check.result === "push-and-pull" ? CircleCheckIcon : registry.check.result === "pull-only" ? CircleAlertIcon : CircleXIcon;
    const tone = registry.check.result === "push-and-pull" ? "text-green" : registry.check.result === "pull-only" ? "text-muted" : "text-red";
    return (
      <span className="flex min-w-0 items-center gap-2 text-ui">
        <Icon aria-hidden className={cn("size-[15px] shrink-0 stroke-[1.75]", tone)} />
        <span className={cn("min-w-0", registry.check.result === "refused" ? "text-red" : "text-text")} data-testid="registry-check-result">{line}</span>
        <span className="shrink-0 font-mono text-[12.5px] text-faint">{formatAge(registry.check.checkedAt)}</span>
      </span>
    );
  })();

  const checkButton = (
    <Button variant="outline" size="sm" className="h-7" disabled={registry === null || dirty || checking} onClick={() => { check.mutate(); }}>
      {checking ? <LoaderCircleIcon aria-hidden className="size-[13px] motion-safe:animate-spin" /> : <RefreshCwIcon aria-hidden className="size-[13px] stroke-[1.75]" />}
      {t("registryPage.check")}
    </Button>
  );

  return (
    <AlertDialog open={removing} onOpenChange={setRemoving}>
      <PageFrame
        crumbs={[{ label: me.data?.organization?.name ?? t("shell.organization") }, { label: t("registryPage.title") }]}
        actions={
          <Button variant="primary" disabled={!canSave} onClick={save} data-action="save-registry">
            {set.isPending ? t("registryPage.saving") : t("registryPage.save")}
          </Button>
        }
        properties={properties}
      >
        <div className="max-w-[720px]">
          <PageHeading title={t("registryPage.title")} lede={t("registryPage.lede")} />
          {view.error === null ? null : <p role="alert" className="mt-2 text-[12.5px] text-red">{errorText(view.error)}</p>}
          {set.error === null ? null : <p role="alert" className="mt-2 text-[12.5px] text-red">{errorText(set.error)}</p>}

          <section className="mt-7">
            <h2 className="mb-2 text-ui font-semibold">{t("registryPage.address")}</h2>
            {loading ? <Skeleton className="h-20 w-full" /> : (
              <div className="border-b border-line">
                <div className={row}>
                  <label htmlFor="registry-address" className="text-ui text-muted">{t("registryPage.registry")}</label>
                  <input
                    id="registry-address"
                    value={shownAddress}
                    placeholder={t("registryPage.registryPlaceholder")}
                    aria-invalid={addressBad}
                    onChange={(event) => { setAddress(event.target.value); setSaved(false); }}
                    className={cn(field, "w-full max-w-[320px]")}
                  />
                  {addressBad ? <p role="alert" className="col-span-full text-xs text-red sm:col-start-2">{t("registryPage.badAddress")}</p> : null}
                </div>
                <div className={row}>
                  <label htmlFor="registry-prefix" className="text-ui text-muted">{t("registryPage.prefix")}</label>
                  <input
                    id="registry-prefix"
                    value={shownPrefix}
                    placeholder={t("registryPage.prefixPlaceholder")}
                    aria-invalid={prefixBad}
                    onChange={(event) => { setPrefix(event.target.value); setSaved(false); }}
                    onBlur={() => { if (prefix !== null && parsePrefix(prefix) !== null) setPrefix(prefixShown(parsePrefix(prefix) ?? "")); }}
                    className={cn(field, "w-full max-w-[160px]")}
                  />
                  {prefixBad ? <p role="alert" className="col-span-full text-xs text-red sm:col-start-2">{t("registryPage.badPrefix")}</p> : null}
                </div>
              </div>
            )}
            <p className="mt-2.5 break-all text-[12.5px] text-faint">{tNodes("registryPage.help", { name: <span className="font-mono text-muted">{imageNameOf(shownAddress, shownPrefix)}</span> })}</p>
          </section>

          <section className="mt-7">
            <h2 className="mb-2 flex flex-wrap items-baseline gap-x-3 text-ui font-semibold">
              {t("registryPage.credentials")}
              <span className="text-[12.5px] font-normal text-muted">{t("registryPage.credentialsNote")}</span>
            </h2>
            {loading ? <Skeleton className="h-28 w-full" /> : (
              <div className="border-b border-line">
                {credentialRow("push")}
                <div className={row}>
                  <span className="text-ui text-muted">{t("registryPage.pullsWith")}</span>
                  <RadioGroup
                    aria-label={t("registryPage.pullsWith")}
                    value={shownAuth}
                    onValueChange={(value) => { if (value === "basic" || value === "node") { setAuth(value); setSaved(false); } }}
                    className="col-span-full flex flex-col gap-2 sm:col-span-2 sm:flex-row sm:items-center sm:gap-5"
                  >
                    <label htmlFor="pull-basic" className="flex cursor-pointer items-center gap-2 text-ui text-text">
                      <RadioGroupItem id="pull-basic" value="basic" className="size-4 data-[state=checked]:border-shell data-[state=checked]:bg-shell [&>span]:bg-ink" />
                      {t("registryPage.pullCredential")}
                    </label>
                    <label htmlFor="pull-node" className="flex cursor-pointer flex-wrap items-center gap-2 text-ui text-text">
                      <RadioGroupItem id="pull-node" value="node" className="size-4 data-[state=checked]:border-shell data-[state=checked]:bg-shell [&>span]:bg-ink" />
                      {t("registryPage.clusterIdentity")}
                      <span className="text-[12.5px] text-faint">{tNodes("registryPage.kubernetesOnly", { kubernetes: <span className="font-mono">kubernetes</span> })}</span>
                    </label>
                  </RadioGroup>
                </div>
                {shownAuth === "basic" ? credentialRow("pull") : null}
              </div>
            )}
            {shownAuth === "basic" && registry !== null && !registry.pullSet ? <p className="mt-2 text-xs text-faint">{t("registryPage.pullHelp")}</p> : null}
            {shownAuth === "node" ? <p className="mt-2 text-xs text-faint">{tNodes("registryPage.clusterHelp", {})}</p> : null}
            {saved ? (
              <p role="status" className="mt-2 flex items-center gap-1.5 text-[12.5px] text-muted"><CheckIcon aria-hidden className="size-[13px] stroke-[1.75]" />{t("registryPage.saved")}</p>
            ) : null}
            {registry === null ? null : (
              <Button variant="ghost" size="sm" className="mt-2 h-7 px-0 text-muted" onClick={() => { setRemoving(true); }}>{t("registryPage.remove")}</Button>
            )}
          </section>

          <section className="mt-7">
            <h2 className="mb-2 text-ui font-semibold">{t("registryPage.check")}</h2>
            <div className="flex min-h-8 flex-wrap items-center gap-3">
              {dirty && registry !== null ? <Tooltip content={t("registryPage.checkSaveFirst")}><span>{checkButton}</span></Tooltip> : checkButton}
              {loading ? <Skeleton className="w-[240px]" /> : checkResult}
            </div>
            {check.error === null ? null : <p role="alert" className="mt-1.5 text-[12.5px] text-red">{errorText(check.error)}</p>}
            <p className="mt-1.5 text-xs text-faint">{t("registryPage.checkHelp")}</p>
          </section>

          <section className="mt-7">
            <div className="mb-1 flex h-[30px] items-center gap-2">
              <h2 className="text-ui font-semibold">{t("registryPage.pools")}</h2>
              <span className="font-mono text-[11.5px] text-faint">{kubernetesPools.length + dockerPools.length}</span>
            </div>
            {kubernetesPools.length + dockerPools.length === 0 ? (
              <p className="flex min-h-10 items-center border-y border-line text-ui text-faint">{t("registryPage.poolsNone")}</p>
            ) : (
              <ul className="border-b border-line" aria-label={t("registryPage.pools")}>
                {[...kubernetesPools.map((pool) => ({ ...pool, executor: "kubernetes" as const })), ...dockerPools.map((pool) => ({ ...pool, executor: "docker" as const }))].map((pool) => (
                  <li key={pool.poolId} data-testid="registry-pool" className="grid min-h-10 items-center gap-x-3 border-t border-line py-1.5 sm:grid-cols-[220px_minmax(0,1fr)]">
                    <span className="flex min-w-0 items-center gap-2">
                      <Link href={projectPoolsHref(pool.poolId)} className="truncate text-ui font-medium text-text hover:underline">{pool.name}</Link>
                      <ExecutorBadge executor={pool.executor} />
                    </span>
                    <span className={cn("text-[12.5px]", pool.executor === "kubernetes" && registry === null ? "text-red" : "text-muted")}>
                      {pool.executor === "docker" ? t("registryPage.poolDocker") : registry === null ? t("registryPage.poolNeedsIt") : t("registryPage.poolKubernetes")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="mt-7">
            <div className="mb-1 flex h-[30px] items-center gap-2">
              <h2 className="text-ui font-semibold">{t("registryPage.snapshots")}</h2>
              <span className="font-mono text-[11.5px] text-faint">{view.data?.snapshots.length ?? 0}</span>
            </div>
            <div className="hidden h-[30px] grid-cols-[minmax(0,1fr)_130px_170px_160px_72px] items-center gap-x-3 border-b border-line text-[11.5px] font-medium text-faint sm:grid">
              <span>{t("registryPage.colProject")}</span>
              <span>{t("registryPage.colSnapshot")}</span>
              <span>{t("registryPage.colDigest")}</span>
              <span>{t("registryPage.colBuiltOn")}</span>
              <span className="text-right">{t("registryPage.colPushed")}</span>
            </div>
            {loading ? (
              <div aria-busy>{[0, 1, 2].map((i) => <div key={i} className="flex h-10 items-center border-b border-line"><Skeleton className="w-full" /></div>)}</div>
            ) : view.data.snapshots.length === 0 ? (
              <p className="flex min-h-10 items-center border-b border-line text-ui text-faint">{t("registryPage.snapshotsNone")}</p>
            ) : (
              <ul aria-label={t("registryPage.snapshots")}>
                {view.data.snapshots.slice(0, 20).map((snapshot) => {
                  const where = builtOn.get(snapshot.snapshotId);
                  return (
                    <li key={snapshot.snapshotId} data-testid="registry-snapshot" className="group grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-b border-line py-1.5 sm:grid-cols-[minmax(0,1fr)_130px_170px_160px_72px]">
                      <Link href={`/projects/${snapshot.projectId}/environment`} className="truncate text-ui text-text hover:underline">{snapshot.projectName}</Link>
                      <span className="hidden truncate font-mono text-[12.5px] text-text sm:block">{snapshot.snapshotId.slice(-8)}</span>
                      <span className="flex min-w-0 items-center gap-1 max-sm:col-span-full max-sm:row-start-2">
                        <Tooltip content={snapshot.digest}><span className="truncate font-mono text-[12.5px] text-faint">{shortDigest(snapshot.digest)}</span></Tooltip>
                        <button
                          type="button"
                          aria-label={t("registryPage.copyReference")}
                          onClick={() => { void navigator.clipboard.writeText(snapshot.ref); }}
                          className="grid size-5 shrink-0 place-items-center rounded-sm text-faint opacity-0 hover:text-text focus-visible:opacity-100 group-hover:opacity-100"
                        >
                          <CopyIcon aria-hidden className="size-[13px] stroke-[1.75]" />
                        </button>
                      </span>
                      <span className="truncate text-[12.5px] text-muted max-sm:col-span-full max-sm:row-start-3">
                        {where?.runnerName === null || where === undefined ? "–" : where.builder === null ? where.runnerName : t("registryPage.builtOn", { runner: where.runnerName, builder: where.builder === "buildkit" ? "BuildKit" : "docker" })}
                      </span>
                      <span className="text-right font-mono text-[12.5px] text-faint max-sm:col-start-2 max-sm:row-start-1">{formatAge(snapshot.pushedAt)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </PageFrame>
      {removing ? (
        <AlertDialogContent
          title={t("registryPage.removeTitle")}
          body={[
            kubernetesPools.length === 0 ? null : t("registryPage.removeBodyPools", { pools: kubernetesPools.map((pool) => pool.name).join(", ") }),
            t("registryPage.removeBody", { url: registry?.url ?? "" }),
          ].filter((line) => line !== null).join(" ")}
          cancel={t("common.cancel")}
          action={t("registryPage.remove")}
          onAction={() => { clear.mutate(); }}
        />
      ) : null}
    </AlertDialog>
  );
};
