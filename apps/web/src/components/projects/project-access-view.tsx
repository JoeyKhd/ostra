"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightIcon, CheckIcon, LoaderCircleIcon, LockIcon, MailIcon, ShieldIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { PageFrame, PageHeading, PropGroup, PropRow } from "@/components/shell/page-frame";
import { initials } from "@/components/shell/user-menu";
import { AlertDialog, AlertDialogContent } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";
import type { ProjectId } from "@ostra/protocol";
import { z } from "zod";

import { lastActiveText, shortDate } from "@/components/members/member-words";

import { ProjectSettingsTabs } from "./settings-tabs";

type Access = RouterOutputs["projects"]["access"];
type Listed = Access["members"][number];
type Role = Listed["role"];
type AuditEntry = RouterOutputs["audit"]["list"]["entries"][number];

/** The audit actions that change who can open a project, the panel's `Last change`. */
const accessActions: ReadonlySet<string> = new Set(["project.access-changed", "project.member-set", "project.member-removed"]);
const accessData = z.object({ access: z.enum(["open", "restricted"]) });
const memberData = z.object({ memberId: z.string(), role: z.enum(["admin", "member"]).optional() });

/**
 * The panel's `Last change` as a sentence (project-access.md): `Alex Kim restricted vault`,
 * `Alex Kim made Sam Rivera an admin`, `Priya Nair removed Jun Ota`. `null` when the entry can't
 * be told that way (an actor or a member whose name isn't known).
 */
export const accessChangeText = (entry: AuditEntry, project: string, nameOf: (memberId: string) => string | undefined): string | null => {
  const actor = entry.actor.name;
  if (actor === null) return null;
  if (entry.action === "project.access-changed") {
    const parsed = accessData.safeParse(entry.data);
    if (!parsed.success) return null;
    return parsed.data.access === "restricted" ? t("access.changeRestricted", { actor, project }) : t("access.changeOpened", { actor, project });
  }
  const parsed = memberData.safeParse(entry.data);
  const name = parsed.success ? nameOf(parsed.data.memberId) : undefined;
  if (!parsed.success || name === undefined) return null;
  if (entry.action === "project.member-removed") return t("access.changeRemoved", { actor, name });
  return parsed.data.role === "admin" ? t("access.changeMadeAdmin", { actor, name }) : t("access.changeMadeMember", { actor, name });
};

/** `Alex Kim`, `Alex Kim and Priya Nair`, `Alex Kim, Priya Nair and Dana Ortiz`. */
export const joinNames = (names: readonly string[]): string => {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")}${t("access.and")}${names[names.length - 1] ?? ""}`;
};

const Initials = ({ name, size = 24 }: { readonly name: string; readonly size?: 18 | 24 }) => (
  <span aria-hidden className={cn("inline-grid shrink-0 place-items-center rounded-full bg-line-2 font-semibold text-text", size === 24 ? "size-6 text-[10.5px]" : "size-[18px] text-[9px]")}>
    {initials(name)}
  </span>
);

const grid = "grid items-center gap-x-3 grid-cols-[minmax(0,1fr)_128px] sm:grid-cols-[minmax(0,1fr)_140px_150px_80px]";

type Confirm =
  | { readonly kind: "access"; readonly to: "open" | "restricted" }
  | { readonly kind: "remove"; readonly member: Listed };

/**
 * A project's Access tab (F-087, project-access.md): open or restricted, the people listed with
 * their project roles, and who always sees it. Read-only for a project member.
 */
export const ProjectAccessView = ({ projectId }: { readonly projectId: ProjectId }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const me = useQuery(trpc.me.get.queryOptions());
  const project = useQuery(trpc.projects.get.queryOptions({ projectId }));
  const access = useQuery(trpc.projects.access.queryOptions({ projectId }));
  const members = useQuery(trpc.members.list.queryOptions());
  const orgAdmin = me.data?.organization?.role === "admin";
  const pendingInvitations = useQuery({ ...trpc.members.invitations.queryOptions(), enabled: orgAdmin });
  // The newest access change among the project's latest entries (repos and the rest share `project.`).
  const lastChange = useQuery({
    ...trpc.audit.list.queryOptions({ projectId, action: "project.", limit: 50 }),
    enabled: access.data?.role === "admin",
  });
  const created = useQuery({
    ...trpc.audit.list.queryOptions({ projectId, action: "project.created", limit: 1 }),
    enabled: access.data?.role === "admin",
  });
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [addPick, setAddPick] = useState<string>("");
  const [addRole, setAddRole] = useState<Role | null>(null);

  useEffect(() => {
    if (status === null) return;
    const timer = setTimeout(() => { setStatus(null); }, 4000);
    return () => { clearTimeout(timer); };
  }, [status]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.projects.access.queryKey({ projectId }) }),
      queryClient.invalidateQueries({ queryKey: trpc.projects.pathKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.audit.list.pathKey() }),
    ]);
  };
  const setAccess = useMutation(trpc.projects.setAccess.mutationOptions({ onSettled: () => refresh() }));
  const setMember = useMutation(trpc.projects.setMember.mutationOptions({ onSettled: () => refresh() }));
  const removeMember = useMutation(trpc.projects.removeMember.mutationOptions({ onSettled: () => refresh() }));

  const name = project.data?.name ?? "";
  const organization = me.data?.organization?.name ?? "";
  const canEdit = access.data?.role === "admin";
  const mode = setAccess.isPending ? setAccess.variables.access : access.data?.access;
  const listed = [...(access.data?.members ?? [])].sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === "admin" ? -1 : 1));
  const invitations = (pendingInvitations.data ?? []).filter((invitation) => invitation.state === "pending" && invitation.projects.some((grant) => grant.projectId === projectId));
  const active = (members.data ?? []).filter((member) => member.state === "active");
  const emails = new Map(active.map((member) => [member.memberId, member.email] as const));
  const listedIds = new Set(listed.map((member) => member.memberId));
  const candidates = active.filter((member) => member.role !== "admin" && !listedIds.has(member.memberId));
  const roleForAdd: Role = addRole ?? (mode === "open" ? "admin" : "member");
  const adminNames = active.filter((member) => member.role === "admin").map((member) => member.name).sort((a, b) => a.localeCompare(b));
  const error = setAccess.error ?? setMember.error ?? removeMember.error;
  const unlisted = Math.max(0, active.length - adminNames.length - listed.length);
  const canOpen = mode === "open" ? null : new Set([...listed.map((member) => member.name), ...adminNames]).size;
  const change = lastChange.data?.entries.find((entry) => accessActions.has(entry.action));
  const memberNames = new Map<string, string>((members.data ?? []).map((member) => [member.memberId, member.name] as const));
  const creator = created.data?.entries[0]?.actor.name ?? null;

  const confirmDialog = (() => {
    if (confirm === null) return null;
    if (confirm.kind === "access") {
      return confirm.to === "restricted" ? (
        <AlertDialogContent
          title={t("access.restrictTitle", { project: name })}
          body={plural(unlisted, "access.restrictBodyOne", "access.restrictBodyOther")}
          cancel={t("common.cancel")}
          action={t("access.restrict")}
          onAction={() => {
            setAccess.mutate({ projectId, access: "restricted" }, { onSuccess: () => { setStatus(t("access.savedRestricted", { project: name })); } });
          }}
        />
      ) : (
        <AlertDialogContent
          title={t("access.openTitle", { project: name })}
          body={t("access.openBody", { organization })}
          cancel={t("common.cancel")}
          action={t("access.openIt")}
          onAction={() => {
            setAccess.mutate({ projectId, access: "open" }, { onSuccess: () => { setStatus(t("access.savedOpen", { project: name })); } });
          }}
        />
      );
    }
    const person = confirm.member;
    return (
      <AlertDialogContent
        title={t("access.removeTitle", { name: person.name, project: name })}
        body={mode === "open" ? t("access.removeOpen", { project: name }) : t("access.removeRestricted", { project: name })}
        cancel={t("common.cancel")}
        action={t("access.remove")}
        onAction={() => {
          removeMember.mutate({ projectId, memberId: person.memberId }, { onSuccess: () => { setStatus(t("access.savedRemoved", { name: person.name })); } });
        }}
      />
    );
  })();

  const properties =
    project.data === undefined || access.data === undefined ? (
      <div className="space-y-3" aria-busy>
        <Skeleton className="w-[120px]" />
        <Skeleton className="w-[200px]" />
        <Skeleton className="w-[160px]" />
      </div>
    ) : (
      <>
        <PropGroup title={name}>
          <PropRow label={t("access.panelAccess")} labelWidth={104}>
            {mode === "restricted" ? (<><LockIcon aria-hidden />{t("access.restricted")}</>) : t("access.open")}
          </PropRow>
          <PropRow label={t("access.panelCanOpen")} labelWidth={104}>
            {canOpen === null ? t("access.panelEveryone", { n: active.length }) : plural(canOpen, "access.panelPeopleOne", "access.panelPeopleOther")}
          </PropRow>
          <PropRow label={t("access.panelProjectAdmins")} labelWidth={104}>
            <span className="truncate">{listed.filter((member) => member.role === "admin").map((member) => member.name).join(", ") || "–"}</span>
          </PropRow>
          <PropRow label={t("access.panelCreated")} labelWidth={104}>
            <span className="font-mono">{shortDate(project.data.createdAt)}</span>
            {creator === null ? null : <span className="truncate">{t("access.panelCreatedBy", { name: creator })}</span>}
          </PropRow>
        </PropGroup>
        <div className="mb-3.5 border-b border-line pb-3.5">
          <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-faint">{t("access.panelOrgAdmins")}<span className="font-mono">{adminNames.length}</span></h3>
          <ul>
            {adminNames.map((admin) => (
              <li key={admin} className="flex h-7 items-center gap-2.5 text-ui text-text"><Initials name={admin} size={18} />{admin}</li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs text-faint">{t("access.panelOrgAdminsNote")}</p>
        </div>
        {canEdit && change !== undefined ? (
          <div>
            <h3 className="mb-2 text-xs font-medium text-faint">{t("audit.lastChange")}</h3>
            <p className="flex items-baseline gap-2 text-[12.5px] text-muted">
              <span className="min-w-0 flex-1">
                {accessChangeText(change, name, (memberId) => memberNames.get(memberId)) ?? (
                  <>{change.actor.name} · <span className="font-mono">{change.action}</span></>
                )}
              </span>
              <span className="shrink-0 font-mono text-faint">{lastActiveText(change.at, Date.now())}</span>
            </p>
            <Link href={`/projects/${projectId}/settings/audit?action=project.`} className="mt-1.5 inline-flex items-center gap-1 text-sm text-teal hover:underline">
              {t("audit.title")} <ArrowRightIcon aria-hidden className="size-[13px] stroke-[1.75]" />
            </Link>
          </div>
        ) : null}
      </>
    );

  const roleCell = (member: Listed) =>
    canEdit ? (
      <Select
        value={setMember.isPending && setMember.variables.memberId === member.memberId ? setMember.variables.role : member.role}
        disabled={setMember.isPending}
        onValueChange={(value) => {
          if (value !== "admin" && value !== "member") return;
          setMember.mutate({ projectId, memberId: member.memberId, role: value }, { onSuccess: () => { setStatus(value === "admin" ? t("access.savedAdmin", { name: member.name }) : t("access.savedMember", { name: member.name })); } });
        }}
      >
        <SelectTrigger aria-label={t("access.colRole")} className="h-7 w-[120px] bg-surface">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="admin">{t("access.admin")}</SelectItem>
          <SelectItem value="member">{t("access.member")}</SelectItem>
        </SelectContent>
      </Select>
    ) : (
      <span className="text-muted">{member.role === "admin" ? t("access.admin") : t("access.member")}</span>
    );

  return (
    <AlertDialog open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
      <PageFrame crumbs={[{ label: name, href: `/projects/${projectId}` }, { label: t("projectSettings.settings") }, { label: t("access.title") }]} properties={properties}>
        <div className="max-w-[760px]">
          <ProjectSettingsTabs projectId={projectId} admin={canEdit} />
          <PageHeading title={t("access.title")} lede={t("access.lede", { project: name })} />
          {project.data !== undefined && !canEdit ? <p className="text-xs text-faint">{t("access.readOnly", { project: name })}</p> : null}

          <section className="mt-[26px]">
            <h2 className="mb-2 text-ui font-semibold">{t("access.who")}</h2>
            {access.data === undefined ? (
              <div className="space-y-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
            ) : canEdit ? (
              <RadioGroup
                aria-label={t("access.who")}
                value={mode ?? "open"}
                onValueChange={(value) => { if ((value === "open" || value === "restricted") && value !== mode) setConfirm({ kind: "access", to: value }); }}
                className="border-y border-line"
              >
                {(["open", "restricted"] as const).map((value) => (
                  <label key={value} htmlFor={`access-${value}`} className={cn("flex min-h-12 cursor-pointer flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md px-2.5 py-2", mode === value && "bg-sel")}>
                    <RadioGroupItem id={`access-${value}`} value={value} disabled={setAccess.isPending} className="size-4 data-[state=checked]:border-primary data-[state=checked]:bg-primary [&>span]:bg-on-primary" />
                    <span className="flex items-center gap-1.5 text-ui font-medium text-text">
                      {value === "restricted" ? <LockIcon aria-hidden className="size-[13px] stroke-[1.75]" /> : null}
                      {value === "open" ? t("access.open") : t("access.restricted")}
                      {setAccess.isPending && setAccess.variables.access === value ? <LoaderCircleIcon aria-hidden className="size-3 motion-safe:animate-spin" /> : null}
                    </span>
                    <span className="basis-full pl-7 text-[12.5px] text-muted sm:basis-auto sm:pl-0">
                      {value === "open" ? t("access.openHint", { organization }) : t("access.restrictedHint")}
                    </span>
                  </label>
                ))}
              </RadioGroup>
            ) : (
              <p className="flex flex-wrap items-center gap-x-3 border-y border-line px-2.5 py-3 text-ui">
                <span className="flex items-center gap-1.5 font-medium text-text">
                  {mode === "restricted" ? <LockIcon aria-hidden className="size-[13px] stroke-[1.75]" /> : null}
                  {mode === "restricted" ? t("access.restricted") : t("access.open")}
                </span>
                <span className="text-[12.5px] text-muted">{mode === "restricted" ? t("access.restrictedHint") : t("access.openHint", { organization })}</span>
              </p>
            )}
          </section>

          <section className="mt-7">
            <div className="mb-1 flex h-[30px] items-center gap-2">
              <h2 className="text-ui font-semibold">{t("access.members")}</h2>
              {access.data === undefined ? null : <span className="font-mono text-[11.5px] text-faint">{listed.length + invitations.length}</span>}
            </div>
            {mode === "open" ? <p className="mb-2 text-[12.5px] text-muted">{t("access.openNote", { organization })}</p> : null}
            {status === null ? null : (
              <p role="status" className="mb-2 flex items-center gap-1.5 text-[12.5px] text-muted"><CheckIcon aria-hidden className="size-[13px] stroke-[1.75]" />{status}</p>
            )}
            {error === null ? null : <p role="alert" className="mb-2 text-[12.5px] text-red">{errorText(error)}</p>}
            <div className={cn(grid, "h-[30px] border-b border-line text-[11.5px] font-medium text-faint")}>
              <span>{t("access.colMember")}</span>
              <span>{t("access.colRole")}</span>
              <span className="hidden sm:block">{t("access.colAdded")}</span>
              <span className="hidden sm:block" />
            </div>
            {access.data === undefined ? (
              <div aria-busy>{[0, 1].map((i) => <div key={i} className="flex h-11 items-center border-b border-line"><Skeleton className="w-[220px]" /></div>)}</div>
            ) : listed.length === 0 && invitations.length === 0 ? (
              <p className="flex h-11 items-center border-b border-line text-ui text-faint">{t("access.nobody", { project: name })}</p>
            ) : (
              <ul aria-label={t("access.members")}>
                {listed.map((member) => (
                  <li key={member.memberId} data-testid="access-row" className={cn(grid, "min-h-11 border-b border-line py-1.5 text-ui")}>
                    <span className="flex min-w-0 items-center gap-2.5">
                      <Initials name={member.name} />
                      <span className="truncate text-text">{member.name}</span>
                      {orgAdmin ? <span className="hidden min-w-0 truncate font-mono text-[12.5px] text-faint md:inline">{emails.get(member.memberId) ?? ""}</span> : null}
                    </span>
                    <span>{roleCell(member)}</span>
                    <span className="hidden font-mono text-[12.5px] text-faint sm:block">{shortDate(member.addedAt)}</span>
                    <span className="col-span-full flex justify-end sm:col-span-1">
                      {canEdit ? <Button variant="ghost" size="sm" onClick={() => { setConfirm({ kind: "remove", member }); }}>{t("access.remove")}</Button> : null}
                    </span>
                  </li>
                ))}
                {invitations.map((invitation) => (
                  <li key={invitation.handle} className={cn(grid, "min-h-11 border-b border-line py-1.5 text-ui")}>
                    <span className="flex min-w-0 items-center gap-2.5">
                      <MailIcon aria-hidden className="mx-[4.5px] size-[15px] shrink-0 stroke-[1.75] text-faint" />
                      <span className="truncate font-mono text-[13px] text-text">{invitation.email}</span>
                      <span className="inline-flex h-5 shrink-0 items-center rounded-md border border-line-2 px-1.5 font-mono text-[11px] text-faint">{t("access.invited")}</span>
                    </span>
                    <span className="text-muted">{invitation.role === "admin" ? t("access.admin") : t("access.member")}</span>
                    <span className="col-span-full pl-[34px] text-[12.5px] text-faint sm:col-span-2 sm:pl-0">{t("access.joinsOnAccepting")}</span>
                  </li>
                ))}
              </ul>
            )}
            {canEdit && access.data !== undefined ? (
              <div className="mt-3 flex flex-wrap items-center gap-2.5">
                <span className="text-[12.5px] text-muted">{t("access.addMember")}</span>
                <Select value={addPick} onValueChange={setAddPick} disabled={candidates.length === 0}>
                  <SelectTrigger aria-label={t("access.addMember")} className="h-7 w-[240px] bg-surface">
                    <SelectValue placeholder={candidates.length === 0 ? t("access.everyoneListed") : t("access.pickMember")} />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.map((member) => (
                      <SelectItem key={member.memberId} value={member.memberId}>
                        <span className="flex items-center gap-2"><Initials name={member.name} size={18} />{member.name}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={roleForAdd} onValueChange={(value) => { if (value === "admin" || value === "member") setAddRole(value); }}>
                  <SelectTrigger aria-label={t("access.colRole")} className="h-7 w-[120px] bg-surface"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">{t("access.member")}</SelectItem>
                    <SelectItem value="admin">{t("access.admin")}</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  className="h-7"
                  disabled={addPick === "" || setMember.isPending}
                  onClick={() => {
                    const picked = candidates.find((member) => member.memberId === addPick);
                    if (picked === undefined) return;
                    setMember.mutate({ projectId, memberId: picked.memberId, role: roleForAdd }, { onSuccess: () => { setAddPick(""); setStatus(t("access.savedListed", { name: picked.name })); } });
                  }}
                >
                  {t("access.add")}
                </Button>
              </div>
            ) : null}
            {access.data === undefined || adminNames.length === 0 ? null : (
              <p className="mt-[22px] flex items-start gap-2 text-[12.5px] text-muted">
                <ShieldIcon aria-hidden className="mt-0.5 size-[13px] shrink-0 stroke-[1.75] text-faint" />
                {mode === "open" ? t("access.adminsLineOpen", { names: joinNames(adminNames), project: name }) : t("access.adminsLine", { names: joinNames(adminNames), project: name })}
              </p>
            )}
            <p className="mt-2.5 text-xs text-faint">{t("access.rolesLine")}</p>
          </section>
        </div>
      </PageFrame>
      {confirmDialog}
    </AlertDialog>
  );
};
