"use client";

import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CircleAlertIcon, CircleArrowUpIcon, EllipsisIcon, FileTextIcon, FolderGit2Icon, LockIcon, PlugIcon, PlusIcon, RefreshCwIcon, SlidersHorizontalIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useState } from "react";

import type { LibraryItemId } from "@ostra/protocol";

import { useShellActions } from "@/components/shell/actions/shell-actions";
import { PageFrame, PropGroup, PropRow } from "@/components/shell/page-frame";
import { AlertDialog, AlertDialogContent } from "@/components/ui/alert-dialog";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Chip } from "@/components/ui/status";
import { Switch } from "@/components/ui/switch";
import { UnderlineTabs } from "@/components/ui/underline-tabs";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { diffCounts, ServerDiffView, SkillDiffView } from "./item-diff";
import { ageWords, dayText, frontMatterOf, itemTabOf, itemTabsOf, pinText, sizeText, sourceTitle, updateRefusalText, versionText } from "./library-model";
import type { ItemTab, LibraryItemDetail } from "./library-model";
import { HashText, InfoLine } from "./library-parts";
import { RemoveButton } from "@/components/agent-profiles/rules-section";

// One library item (F-145; app-targets/m8/library-update.md): exactly what's installed (its source,
// pin and hash, who installed it), who gets it (the profiles it's on, or every profile), and an
// update waiting: its diff, file by file, with one decision, accept it or keep the pin. Nothing
// reaches a profile until an admin accepts; running tasks get it at their next session.

const tabWord = (tab: ItemTab): string => {
  switch (tab) {
    case "skill":
      return t("library.item.tabSkill");
    case "files":
      return t("library.item.tabFiles");
    case "server":
      return t("library.item.tabServer");
    case "tools":
      return t("library.item.tabTools");
    case "used-by":
      return t("library.item.tabUsedBy");
    case "update":
      return t("library.item.tabUpdate");
    default:
      return tab satisfies never;
  }
};

/** How long "Check for updates" keeps asking for the item while core's check runs. */
const CHECK_WINDOW_MS = 30_000;

export const ItemPage = ({ itemId }: { readonly itemId: LibraryItemId }) => {
  const id = useId();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const { announce } = useShellActions();
  const [checking, setChecking] = useState<number | null>(null);
  const [checked, setChecked] = useState<number | null>(null);
  const item = useQuery(trpc.library.get.queryOptions({ itemId }, { refetchInterval: checking === null ? false : 2_000 }));
  const data = item.data;
  const admin = data?.canManage === true;
  const skillFile = useQuery(trpc.library.file.queryOptions(admin && data.kind === "skill" && data.pin !== null ? { versionId: data.pin.versionId, path: "SKILL.md" } : skipToken));
  const [confirm, setConfirm] = useState<"remove" | "detach-all" | null>(null);
  const refresh = async (): Promise<void> => { await queryClient.invalidateQueries({ queryKey: trpc.library.pathKey() }); };
  const check = useMutation(trpc.library.checkUpdates.mutationOptions({ onSuccess: () => { setChecking(Date.now()); setChecked(null); } }));
  const accept = useMutation(trpc.library.acceptUpdate.mutationOptions({ onSuccess: refresh }));
  const keep = useMutation(trpc.library.dismissUpdate.mutationOptions({ onSuccess: refresh }));
  const remove = useMutation(trpc.library.remove.mutationOptions());
  const detach = useMutation(trpc.library.detach.mutationOptions());

  // The check runs in core: the page asks again every 2 s until an update shows, or the window ends.
  useEffect(() => {
    if (checking === null) return undefined;
    if (data?.update !== null && data?.update !== undefined) {
      setChecking(null);
      return undefined;
    }
    const timer = setTimeout(() => { setChecking(null); setChecked(Date.now()); }, Math.max(0, checking + CHECK_WINDOW_MS - Date.now()));
    return () => { clearTimeout(timer); };
  }, [checking, data?.update]);
  useEffect(() => {
    if (checked === null) return undefined;
    const timer = setTimeout(() => { setChecked(null); }, 5_000);
    return () => { clearTimeout(timer); };
  }, [checked]);

  const crumbs = [{ label: t("shell.organization") }, { label: t("shell.skills"), href: "/organization/skills" }, { label: data?.name ?? "" }];
  if (item.error !== null) {
    return (
      <PageFrame crumbs={crumbs.slice(0, 2)}>
        <div className="py-10" data-testid="item-not-found">
          <h1 className="page-title">{item.error.data?.code === "NOT_FOUND" ? t("library.item.notFound") : (errorText(item.error) ?? "")}</h1>
          <Link href="/organization/skills" className="mt-2 inline-block text-teal hover:underline">{t("library.item.allItems")}</Link>
        </div>
      </PageFrame>
    );
  }
  if (data === undefined) {
    return (
      <PageFrame crumbs={crumbs}>
        <div aria-busy className="space-y-3"><Skeleton className="h-4 w-[180px]" /><Skeleton className="h-7 w-[240px]" /><Skeleton className="h-4 w-[420px]" /></div>
      </PageFrame>
    );
  }

  const tab = itemTabOf(data, params.get("tab"));
  const tabs = itemTabsOf(data);
  const setTab = (next: ItemTab): void => { router.replace(`${path}?tab=${next}`, { scroll: false }); };
  const skill = data.kind === "skill";
  const front = skillFile.data?.text === null || skillFile.data?.text === undefined ? null : frontMatterOf(skillFile.data.text);
  const description = skill ? (front?.fields.find((field) => field.key === "description")?.value ?? null) : (data.server?.description ?? null);
  const source = data.source;
  const ref = source.kind === "github" ? (source.ref ?? t("library.item.defaultBranch")) : null;
  const update = data.update;
  const refusal = update === null ? null : updateRefusalText(update.refusal, sourceTitle(source));

  const actions = admin ? (
    <>
      <Button onClick={() => { check.mutate({ itemId }); }} disabled={check.isPending || checking !== null} data-action="check-updates">
        <RefreshCwIcon aria-hidden className={checking === null ? undefined : "animate-spin"} />
        <span className="hidden sm:inline">{checking === null ? t("library.item.checkUpdates") : t("library.item.checking")}</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={t("library.item.more")}><EllipsisIcon aria-hidden /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={data.profiles.length === 0} onSelect={() => { setConfirm("detach-all"); }}>{t("library.item.detachAll")}</DropdownMenuItem>
          <DropdownMenuItem className="text-red" onSelect={() => { setConfirm("remove"); }}>{t("library.item.remove")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  ) : undefined;

  return (
    <PageFrame crumbs={crumbs} actions={actions} properties={<ItemProperties item={data} onChanged={refresh} />}>
      <div data-testid="library-item" data-item={data.name}>
        <div className="font-mono text-sm text-faint">{t(skill ? "library.item.keySkill" : "library.item.keyServer", { date: dayText(data.installedAt) })}</div>
        <h1 className="page-title my-1.5 break-words">{data.name}</h1>
        {description === null || description === "" ? null : <p className="max-w-[760px] text-lede text-muted" data-testid="item-description">{description}</p>}
        <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-ui text-muted" data-testid="item-source">
          {skill ? <FolderGit2Icon aria-hidden className="size-[14px] shrink-0" /> : <PlugIcon aria-hidden className="size-[14px] shrink-0" />}
          {source.kind === "github" ? (
            <>
              <a href={`https://github.com/${source.owner}/${source.repo}`} target="_blank" rel="noreferrer" className="text-teal hover:underline">{`${source.owner}/${source.repo}`}</a>
              {source.path === "" ? null : <span className="font-mono text-sm text-text">{source.path}</span>}
            </>
          ) : source.kind === "well_known" ? (
            <a href={source.url} target="_blank" rel="noreferrer" className="text-teal hover:underline">{source.url}</a>
          ) : source.kind === "registry" ? (
            <span className="font-mono text-sm text-text">{source.name}</span>
          ) : (
            <span>{sourceTitle(source)}</span>
          )}
          <span className="text-faint">·</span>
          {skill ? <span>{t("library.item.pinnedAt")}</span> : null}
          <span className="font-mono text-sm text-text" data-testid="item-pin">{pinText(data.pin)}</span>
          {data.pin?.computedHash === null || data.pin?.computedHash === undefined ? null : (
            <>
              <span className="text-faint">·</span>
              <HashText hash={data.pin.computedHash} className="text-sm text-faint" />
            </>
          )}
          {!skill && data.server !== null ? <span className="text-faint">{`· ${t("library.row.remote")} ${URL.canParse(data.server.remoteUrl.replace(/\{[^}]*\}/g, "x")) ? new URL(data.server.remoteUrl.replace(/\{[^}]*\}/g, "x")).host : ""}`}</span> : null}
        </p>
        {data.sourceAllowed ? null : (
          <p className="mt-2 flex items-start gap-1.5 text-sm text-muted" data-testid="item-not-allowed"><LockIcon aria-hidden className="mt-[2px] size-[13px] shrink-0" />{t("library.item.notAllowed", { source: sourceTitle(source) })}</p>
        )}
        {check.error === null ? null : (
          <p role="alert" className="mt-2 flex items-center gap-1.5 text-sm text-red"><CircleAlertIcon aria-hidden className="size-[13px]" />{errorText(check.error)}</p>
        )}
        {checked === null || update !== null ? null : (
          <p role="status" className="mt-2 text-sm text-faint">{t("library.item.stillAt", { ref: ref ?? versionText(data.pin?.registryVersion ?? ""), pin: pinText(data.pin) })}</p>
        )}

        <UnderlineTabs
          className="mt-[18px]"
          label={t("library.item.tabsLabel")}
          idPrefix={id}
          selected={tab}
          onSelect={setTab}
          tabs={tabs.map((entry) => ({
            id: entry,
            label: tabWord(entry),
            extra:
              entry === "files" ? <span className="font-mono text-[12px] font-normal text-faint">{data.files.length}</span>
              : entry === "used-by" ? <span className="font-mono text-[12px] font-normal text-faint">{data.everyProfile ? "" : data.profiles.length}</span>
              : entry === "update" ? <span className="font-mono text-[12px] font-normal text-faint">1</span>
              : entry === "tools" ? <span className="font-mono text-[12px] font-normal text-faint">{data.server?.toolNames.length ?? 0}</span>
              : undefined,
          }))}
        />
        <div role="tabpanel" id={`${id}-panel-${tab}`} aria-labelledby={`${id}-tab-${tab}`} data-tab-panel={tab}>
          {tab === "update" && update !== null ? (
            <UpdateTab item={data} update={update} refusal={refusal} accepting={accept.isPending} keeping={keep.isPending}
              error={accept.error === null ? (keep.error === null ? null : errorText(keep.error)) : errorText(accept.error)}
              onAccept={() => {
                accept.mutate({ versionId: update.versionId }, { onSuccess: () => { announce(plural(data.profiles.length, "library.item.acceptedOne", "library.item.acceptedMany", { pin: pinText({ commitSha: update.commitSha, computedHash: null, registryVersion: update.registryVersion }) })); setTab(skill ? "skill" : "server"); } });
              }}
              onKeep={() => { keep.mutate({ versionId: update.versionId }, { onSuccess: () => { setTab(skill ? "skill" : "server"); } }); }}
            />
          ) : tab === "skill" ? (
            <SkillTab admin={admin} loading={skillFile.isPending && admin} front={front} files={data.files} error={skillFile.error === null ? null : errorText(skillFile.error)} />
          ) : tab === "files" ? (
            <FilesTab item={data} />
          ) : tab === "server" ? (
            <ServerTab item={data} />
          ) : tab === "tools" ? (
            <ToolsTab item={data} />
          ) : (
            <UsedByTab item={data} onChanged={refresh} />
          )}
        </div>
      </div>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        {confirm === null ? null : (
          <AlertDialogContent
            title={confirm === "remove" ? t("library.item.removeTitle", { name: data.name }) : t("library.item.detachAllTitle", { name: data.name })}
            body={confirm === "remove" ? t("library.item.removeBody") : plural(data.profiles.length, "library.item.detachAllBodyOne", "library.item.detachAllBodyMany")}
            cancel={t("common.cancel")}
            action={confirm === "remove" ? t("library.item.remove") : t("library.item.detachAll")}
            pending={{ busy: remove.isPending || detach.isPending, label: t("library.working"), error: remove.error === null ? (detach.error === null ? null : errorText(detach.error)) : errorText(remove.error) }}
            onAction={() => {
              if (confirm === "remove") {
                remove.mutate({ itemId }, { onSuccess: () => { void refresh().then(() => { router.push("/organization/skills"); }); } });
                return;
              }
              void (async () => {
                for (const profile of data.profiles) await detach.mutateAsync({ profileId: profile.profileId, itemId });
                await refresh();
                setConfirm(null);
              })();
            }}
          />
        )}
      </AlertDialog>
    </PageFrame>
  );
};

const UpdateTab = ({ item, update, refusal, accepting, keeping, error, onAccept, onKeep }: {
  readonly item: LibraryItemDetail;
  readonly update: NonNullable<LibraryItemDetail["update"]>;
  readonly refusal: string | null;
  readonly accepting: boolean;
  readonly keeping: boolean;
  readonly error: string | null;
  readonly onAccept: () => void;
  readonly onKeep: () => void;
}) => {
  const skill = item.kind === "skill";
  const from = pinText(item.pin);
  const to = pinText({ commitSha: update.commitSha, computedHash: null, registryVersion: update.registryVersion });
  const counts = update.diff?.kind === "skill" ? diffCounts(update.diff.diff) : null;
  const ref = item.source.kind === "github" ? (item.source.ref ?? "HEAD") : null;
  return (
    <div data-testid="update-tab">
      <div className="mt-[18px] border-l-2 border-line-3 py-3 pl-3.5">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2 text-ui">
          <CircleArrowUpIcon aria-hidden className="size-4 text-teal" />
          {skill ? (
            <>
              {ref === null ? null : <span className="font-mono text-text">{ref}</span>}
              <span className="text-text">{t("library.item.movedTo")}</span>
              <span className="font-mono text-text" data-testid="update-to">{to}</span>
            </>
          ) : (
            <span className="text-text">{t("library.item.newVersion", { version: to })}</span>
          )}
          <span className="text-faint">{`· ${ageWords(update.fetchedAt)} · ${plural(update.files.length, "library.row.filesOne", "library.row.filesMany")}`}</span>
          {counts === null ? null : (
            <>
              <span className="font-mono text-green">{`+${String(counts.added)}`}</span>
              <span className="font-mono text-red">{`−${String(counts.removed)}`}</span>
            </>
          )}
          {item.canManage ? (
            <span className="flex w-full gap-2 sm:ml-auto sm:w-auto">
              <Button className="h-[44px] flex-1 sm:h-7" onClick={onKeep} disabled={keeping || accepting} data-action="keep-pin">{t("library.item.keep", { pin: from })}</Button>
              <Button variant="primary" className="h-[44px] flex-1 sm:h-7" onClick={onAccept} disabled={accepting || keeping || refusal !== null} aria-disabled={refusal !== null} data-action="accept-update">
                <CheckIcon aria-hidden />
                {accepting ? t("library.item.accepting") : t("library.item.accept")}
              </Button>
            </span>
          ) : null}
        </div>
        <p className="mt-1.5 max-w-[560px] text-sm text-faint">
          {item.canManage ? plural(item.profiles.length, "library.item.acceptNoteOne", "library.item.acceptNoteMany", { pin: to }) : t("library.item.adminReviews")}
        </p>
        {refusal === null ? null : <p className="mt-1.5 flex items-center gap-1.5 text-sm text-muted" data-testid="update-refusal"><LockIcon aria-hidden className="size-[13px]" />{refusal}</p>}
        {error === null ? null : <p role="alert" className="mt-1.5 text-sm text-red">{error}</p>}
      </div>
      {update.diff === null ? null : update.diff.kind === "skill" ? <SkillDiffView diff={update.diff.diff} from={from} to={to} /> : <ServerDiffView diff={update.diff} />}
      {update.diff === null && !item.canManage ? (
        <ul className="mt-3 text-sm text-muted">{update.files.map((file) => <li key={file.path} className="font-mono">{file.path}</li>)}</ul>
      ) : null}
      <InfoLine className="mt-2.5">{skill ? t("library.item.diffNote") : t("library.item.serverDiffNote")}</InfoLine>
    </div>
  );
};

const SkillTab = ({ admin, loading, front, files, error }: { readonly admin: boolean; readonly loading: boolean; readonly front: ReturnType<typeof frontMatterOf> | null; readonly files: LibraryItemDetail["files"]; readonly error: string | null }) => {
  if (!admin) {
    return <p className="mt-5 text-ui text-muted">{t("library.item.adminReads", { n: files.length })}</p>;
  }
  if (error !== null) return <p role="alert" className="mt-5 text-sm text-red">{error}</p>;
  if (loading || front === null) return <div aria-busy className="mt-5 space-y-2"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-4 w-2/3" /></div>;
  return (
    <div className="mt-5" data-testid="skill-md">
      {front.fields.length === 0 ? null : (
        <dl className="mb-4 grid max-w-[720px] grid-cols-[120px_minmax(0,1fr)] gap-y-1.5 border-b border-line pb-3 text-sm">
          {front.fields.map((field) => (
            <div key={field.key} className="contents">
              <dt className="font-mono text-faint">{field.key}</dt>
              <dd className="text-text">{field.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <pre className="max-w-[760px] whitespace-pre-wrap break-words font-mono text-[13px] leading-[1.7] text-text-2">{front.body}</pre>
    </div>
  );
};

const FilesTab = ({ item }: { readonly item: LibraryItemDetail }) => {
  const trpc = useTRPC();
  const [viewing, setViewing] = useState<string | null>(null);
  const file = useQuery(trpc.library.file.queryOptions(viewing === null || item.pin === null ? skipToken : { versionId: item.pin.versionId, path: viewing }));
  return (
    <div className="mt-4" data-testid="files-tab">
      <ul className="border-t border-line">
        {item.files.map((entry) => (
          <li key={entry.path} className="flex h-10 items-center gap-3 border-b border-line text-ui" data-file={entry.path}>
            <FileTextIcon aria-hidden className="size-[14px] shrink-0 text-faint" />
            <span className="min-w-0 flex-1 truncate font-mono text-sm text-text">{entry.path}</span>
            {entry.executable ? <Chip className="h-5 px-1.5 text-[11.5px]">{t("library.install.scriptExecutable")}</Chip> : null}
            <span className="font-mono text-[12px] text-faint">{sizeText(entry.size)}</span>
            {item.canManage ? <button type="button" className="text-sm text-teal hover:underline" onClick={() => { setViewing(viewing === entry.path ? null : entry.path); }}>{viewing === entry.path ? t("library.item.hide") : t("library.item.view")}</button> : null}
          </li>
        ))}
      </ul>
      {viewing === null ? null : file.data === undefined ? (
        file.error === null ? <Skeleton className="mt-3 h-24 w-full" /> : <p role="alert" className="mt-3 text-sm text-red">{errorText(file.error)}</p>
      ) : (
        <pre className="mt-3 max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface p-3 font-mono text-[12.5px] leading-[1.6] text-text-2" data-testid="file-text">
          {file.data.binary ? t("library.install.binaryFile", { size: sizeText(file.data.size) }) : file.data.text}
        </pre>
      )}
      <p className="mt-3 text-[12.5px] text-faint">{t("library.item.limits")}</p>
    </div>
  );
};

const ServerTab = ({ item }: { readonly item: LibraryItemDetail }) => {
  const server = item.server;
  if (server === null) return <p className="mt-5 text-ui text-muted">{t("library.source.unreadable")}</p>;
  return (
    <dl className="mt-5 grid max-w-[720px] grid-cols-[120px_minmax(0,1fr)] gap-y-2 text-ui" data-testid="server-tab">
      <dt className="text-muted">{t("library.item.remoteUrl")}</dt>
      <dd className="break-all font-mono text-sm text-text">{server.remoteUrl}</dd>
      <dt className="text-muted">{t("library.item.transport")}</dt>
      <dd className="text-text">{t("library.install.streamableHttp")}</dd>
      {server.inputs.map((input) => (
        <div key={`${input.kind}:${input.name}`} className="contents" data-input={input.name}>
          <dt className="truncate font-mono text-sm text-text">{input.name}</dt>
          <dd className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-faint">{input.kind === "variable" ? t("library.install.inUrl") : t("library.install.header")}</span>
            {input.secret ? <Chip className="h-5 px-1.5 text-[11.5px]"><LockIcon aria-hidden />{t("library.install.secret")}</Chip> : null}
            {input.set ? <span className="text-muted" data-input-set>{input.secret ? t("library.item.inSecretStore") : t("library.item.set")}</span> : <span className="text-red">{t("library.item.notSet")}</span>}
          </dd>
        </div>
      ))}
      <dt className="text-muted">{t("library.item.readOnly")}</dt>
      <dd className="text-text">{item.readOnly ? t("common.yes") : t("library.item.no")}</dd>
    </dl>
  );
};

const ToolsTab = ({ item }: { readonly item: LibraryItemDetail }) => {
  const tools = item.server?.toolNames ?? [];
  return (
    <div className="mt-5" data-testid="tools-tab">
      {item.server?.needsOAuth === true ? <p className="text-ui text-muted">{t("library.refusal.oauthBody")}</p> : tools.length === 0 ? (
        <p className="text-ui text-faint">{t("library.item.noTools")}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">{tools.map((tool) => <span key={tool} className="rounded-sm border border-line-2 px-2 py-0.5 font-mono text-[12px] text-text-2" data-tool={tool}>{tool}</span>)}</div>
      )}
    </div>
  );
};

/** Attach to a profile: a list of the organization's profiles not on it yet. */
const AttachToProfile = ({ item, onChanged }: { readonly item: LibraryItemDetail; readonly onChanged: () => Promise<void> }) => {
  const trpc = useTRPC();
  const profiles = useQuery(trpc.agentProfiles.list.queryOptions({ includeArchived: false }));
  const attach = useMutation(trpc.library.attach.mutationOptions({ onSuccess: onChanged }));
  const [open, setOpen] = useState(false);
  const offered = (profiles.data ?? []).filter((profile) => !item.profiles.some((entry) => entry.profileId === profile.id));
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger className="mt-1 inline-flex h-8 items-center gap-1.5 text-ui text-teal hover:underline [&_svg]:size-[13px]" data-action="attach-to-profile">
          <PlusIcon aria-hidden /> {t("library.item.attachToProfile")}
        </PopoverTrigger>
        <PopoverContent className="w-[260px]">
          {offered.length === 0 ? <p className="px-2 py-2 text-ui text-faint">{t("library.item.noProfileLeft")}</p> : (
            <ul role="listbox" aria-label={t("library.item.attachToProfile")}>
              {offered.map((profile) => (
                <li key={profile.id}>
                  <button type="button" role="option" aria-selected={false} className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-ui hover:bg-sel focus-visible:bg-sel"
                    onClick={() => { attach.mutate({ profileId: profile.id, itemId: item.itemId }); setOpen(false); }}>
                    <SlidersHorizontalIcon aria-hidden className="size-[14px] text-faint" />
                    <span className="truncate">{profile.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </PopoverContent>
      </Popover>
      {attach.error === null ? null : <p role="alert" className="mt-1 text-sm text-red">{errorText(attach.error)}</p>}
    </>
  );
};

const UsedByTab = ({ item, onChanged }: { readonly item: LibraryItemDetail; readonly onChanged: () => Promise<void> }) => {
  const trpc = useTRPC();
  const detach = useMutation(trpc.library.detach.mutationOptions({ onSuccess: onChanged }));
  return (
    <div className="mt-4" data-testid="used-by-tab">
      {item.everyProfile ? <p className="text-ui text-muted">{t("library.item.onEveryProfile")}</p> : item.profiles.length === 0 ? (
        <p className="text-ui text-faint">{t("library.item.onNoProfile")}</p>
      ) : (
        <ul className="border-t border-line">
          {item.profiles.map((profile) => (
            <li key={profile.profileId} className="flex h-10 items-center gap-2.5 border-b border-line text-ui" data-profile={profile.name}>
              <SlidersHorizontalIcon aria-hidden className="size-[14px] text-faint" />
              <Link href={`/organization/agent-profiles/${profile.profileId}`} className="min-w-0 flex-1 truncate text-text hover:underline">{profile.name}</Link>
              {item.canManage ? <RemoveButton label={t("library.item.detachFrom", { profile: profile.name })} onClick={() => { detach.mutate({ profileId: profile.profileId, itemId: item.itemId }); }} /> : null}
            </li>
          ))}
        </ul>
      )}
      {item.canManage && !item.everyProfile ? <AttachToProfile item={item} onChanged={onChanged} /> : null}
      {detach.error === null ? null : <p role="alert" className="mt-1 text-sm text-red">{errorText(detach.error)}</p>}
    </div>
  );
};

/** The properties panel: the source and pin, then who uses it, with the every-profile switch. */
const ItemProperties = ({ item, onChanged }: { readonly item: LibraryItemDetail; readonly onChanged: () => Promise<void> }) => {
  const id = useId();
  const trpc = useTRPC();
  const every = useMutation(trpc.library.setEveryProfile.mutationOptions({ onSuccess: onChanged }));
  const source = item.source;
  const pin = item.pin;
  return (
    <div data-testid="item-properties">
      <PropGroup title={t("library.item.sourceGroup")}>
        {source.kind === "github" ? (
          <>
            <PropRow label={t("library.item.repo")}><span className="truncate font-mono">{`${source.owner}/${source.repo}`}</span></PropRow>
            <PropRow label={t("library.item.path")}><span className="truncate font-mono">{source.path === "" ? "/" : source.path}</span></PropRow>
            <PropRow label={t("library.item.ref")}>{source.ref === null ? <span className="truncate text-muted">{t("library.item.defaultBranch")}</span> : <span className="truncate font-mono">{source.ref}</span>}</PropRow>
            <PropRow label={t("library.item.commit")}><span className="font-mono" data-testid="prop-commit">{pin?.commitSha?.slice(0, 7) ?? "—"}</span></PropRow>
          </>
        ) : source.kind === "well_known" ? (
          <>
            <PropRow label={t("library.item.site")}><span className="truncate font-mono">{source.url}</span></PropRow>
            <PropRow label={t("library.item.skill")}><span className="truncate font-mono">{source.skill}</span></PropRow>
          </>
        ) : source.kind === "registry" ? (
          <>
            <PropRow label={t("library.item.registry")}><span className="truncate font-mono">{URL.canParse(source.registryUrl) ? new URL(source.registryUrl).host : source.registryUrl}</span></PropRow>
            <PropRow label={t("library.item.name")}><span className="truncate font-mono">{source.name}</span></PropRow>
            <PropRow label={t("library.item.version")}><span className="font-mono">{pin?.registryVersion === null || pin?.registryVersion === undefined ? "—" : versionText(pin.registryVersion)}</span></PropRow>
            <PropRow label={t("library.item.secrets")}>{plural(item.server?.inputs.filter((input) => input.secret && input.set).length ?? 0, "library.item.secretsOne", "library.item.secretsMany")}</PropRow>
            <PropRow label={t("library.item.tools")}>{item.server?.needsOAuth === true ? t("library.row.needsSignIn") : String(item.server?.toolNames.length ?? 0)}</PropRow>
          </>
        ) : null}
        {pin?.computedHash === null || pin?.computedHash === undefined ? null : <PropRow label={t("library.item.hash")}><HashText hash={pin.computedHash} /></PropRow>}
        <PropRow label={t("library.item.fetched")}>{source.kind === "github" ? t("library.item.fromGitHub") : source.kind === "well_known" ? t("library.item.fromHost", { host: URL.canParse(source.url) ? new URL(source.url).host : source.url }) : t("library.item.fromRegistry")}</PropRow>
        <PropRow label={t("library.item.installed")}>
          <Avatar name={item.installedBy.name ?? t("library.someone")} className="size-5 text-[10px]" />
          <span className="truncate">{item.installedBy.name ?? t("library.someone")}</span>
          <span className="shrink-0 text-faint">{`· ${dayText(item.installedAt)}`}</span>
        </PropRow>
      </PropGroup>
      <PropGroup title={t("library.item.usedByGroup")}>
        <div className="flex min-h-8 items-center gap-2 text-ui">
          <span id={`${id}-every`} className="text-muted">{t("library.row.everyProfile")}</span>
          <Switch className="ml-auto" aria-labelledby={`${id}-every`} checked={item.everyProfile} disabled={!item.canManage || every.isPending} onCheckedChange={(everyProfile) => { every.mutate({ itemId: item.itemId, everyProfile }); }} data-testid="every-profile-switch" />
          <span className="w-7 text-sm text-faint">{item.everyProfile ? t("library.item.on") : t("library.item.off")}</span>
        </div>
        {every.error === null ? null : <p role="alert" className="mt-1 text-sm text-red">{errorText(every.error)}</p>}
        {item.everyProfile ? null : item.profiles.map((profile) => (
          <div key={profile.profileId} className="flex h-8 items-center gap-2.5 text-ui">
            <SlidersHorizontalIcon aria-hidden className="size-[14px] text-faint" />
            <Link href={`/organization/agent-profiles/${profile.profileId}`} className="truncate hover:underline">{profile.name}</Link>
          </div>
        ))}
        {item.canManage && !item.everyProfile ? <AttachToProfile item={item} onChanged={onChanged} /> : null}
      </PropGroup>
    </div>
  );
};
