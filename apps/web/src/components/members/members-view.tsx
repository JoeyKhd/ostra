"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronRightIcon, EllipsisIcon, LockIcon, MailIcon, PlusIcon, UserMinusIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { ReactNode } from "react";

import { PageFrame, PageHeading, PropGroup, PropRow, Section } from "@/components/shell/page-frame";
import { projectColour } from "@/components/shell/project-colour";
import { initials } from "@/components/shell/user-menu";
import { AlertDialog, AlertDialogContent } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { InviteSheet } from "./invite-sheet";
import { adminLede, expiryText, lastActiveText, removalLines, removedText, shortDate } from "./member-words";

type Member = RouterOutputs["members"]["list"][number];
type Invitation = RouterOutputs["members"]["invitations"][number];
type Role = Member["role"];

/** The one column grid of members, invitations and removed rows (members.md, "the same column grid"). */
const grid = "grid items-center gap-x-3 md:grid-cols-[minmax(0,290px)_86px_minmax(0,1fr)_120px_40px]";

const roleWord = (role: Role): string => (role === "admin" ? t("members.admin") : t("members.member"));

const MemberAvatar = ({ name, size = 26, dim = false }: { readonly name: string; readonly size?: 26 | 36; readonly dim?: boolean }) => (
  <span
    aria-hidden
    className={cn(
      "inline-grid shrink-0 place-items-center rounded-full bg-raise font-semibold text-text",
      size === 26 ? "size-[26px] text-[11px]" : "size-9 text-[12.5px]",
      dim && "opacity-50",
    )}
  >
    {initials(name)}
  </span>
);

const Square = ({ id }: { readonly id: string }) => (
  <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(id) }} />
);

/** Projects: admins open all; a member's projects by name, then `+N`, the full list in a tooltip. */
const ProjectsCell = ({ member }: { readonly member: Member }) => {
  if (member.role === "admin") return <span className="text-muted">{t("members.allProjects")}</span>;
  if (member.projects.length === 0) return <span className="text-muted">{t("members.openProjects")}</span>;
  const names = member.projects.map((project) => project.name);
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  return (
    <Tooltip content={names.join(", ")}>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="hidden min-w-0 truncate text-muted min-[900px]:inline">{shown.join(", ")}</span>
        {rest > 0 ? <span className="hidden shrink-0 text-faint min-[900px]:inline">+{rest}</span> : null}
        <span className="text-muted min-[900px]:hidden">{plural(names.length, "members.projectCountOne", "members.projectCountOther")}</span>
      </span>
    </Tooltip>
  );
};

type RowMenuProps = {
  readonly member: Member;
  readonly organization: string;
  readonly self: boolean;
  readonly onlyAdmin: boolean;
  readonly onRole: (role: Role) => void;
  readonly onRemove: () => void;
};

/** The row menu (members.md): the role as a radio group, then `Remove from …`. The last admin keeps both. */
const RowMenu = ({ member, organization, self, onlyAdmin, onRole, onRemove }: RowMenuProps) => {
  const lastAdmin = onlyAdmin && member.role === "admin";
  const pending = member.state === "pending_verification";
  const removeItem = (
    <DropdownMenuItem disabled={lastAdmin} onSelect={onRemove} className="text-red [&_svg]:text-red">
      <UserMinusIcon /> {t("members.removeFrom", { organization })}
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("members.actionsFor", { name: member.name })}
        onClick={(event) => { event.stopPropagation(); }}
        className="grid size-7 place-items-center rounded-md border border-transparent text-faint hover:bg-surface data-[state=open]:border-line-2 data-[state=open]:bg-surface"
      >
        <EllipsisIcon aria-hidden className="size-[15px] stroke-[1.75]" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[220px] bg-surface" onClick={(event) => { event.stopPropagation(); }}>
        {pending ? null : (
          <>
            <DropdownMenuLabel>{t("members.roleLabel")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={member.role}
              onValueChange={(value) => {
                if ((value === "admin" || value === "member") && value !== member.role) onRole(value);
              }}
            >
              <DropdownMenuRadioItem value="admin">{t("members.admin")}</DropdownMenuRadioItem>
              {lastAdmin ? (
                <Tooltip content={t("members.lastAdmin", { organization })}>
                  <div>
                    <DropdownMenuRadioItem value="member" disabled>{t("members.member")}</DropdownMenuRadioItem>
                  </div>
                </Tooltip>
              ) : (
                <DropdownMenuRadioItem value="member">{t("members.member")}</DropdownMenuRadioItem>
              )}
            </DropdownMenuRadioGroup>
          </>
        )}
        {self ? null : (
          <>
            {pending ? null : <DropdownMenuSeparator />}
            {lastAdmin ? (
              <Tooltip content={t("members.lastAdmin", { organization })}>
                <div>{removeItem}</div>
              </Tooltip>
            ) : (
              removeItem
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** The selected member (members.md, "Properties panel"): organization, projects, what removal ends. */
export const MemberProperties = ({ member, now }: { readonly member: Member; readonly now: number }) => (
  <div>
    <div className="mb-4 border-b border-line pb-4">
      <div className="text-xs font-medium text-faint">{t("members.panelEyebrow")}</div>
      <div className="mt-2 flex items-center gap-3">
        <MemberAvatar name={member.name} size={36} />
        <div className="min-w-0">
          <div className="truncate text-[17px] font-semibold text-text">{member.name}</div>
          {member.email === null ? null : <div className="truncate font-mono text-[13px] text-muted">{member.email}</div>}
        </div>
      </div>
    </div>
    <PropGroup title={t("members.panelOrganization")}>
      <PropRow label={t("members.panelRole")} labelWidth={96}>{roleWord(member.role)}</PropRow>
      <PropRow label={t("members.panelJoined")} labelWidth={96}>{shortDate(member.joinedAt)}</PropRow>
      <PropRow label={t("members.panelInvitedBy")} labelWidth={96}><span data-testid="invited-by">{member.invitedBy ?? "—"}</span></PropRow>
      <PropRow label={t("members.panelLastActive")} labelWidth={96}>
        <span className="font-mono">{member.lastActiveAt === null ? "—" : lastActiveText(member.lastActiveAt, now)}</span>
      </PropRow>
      {member.state === "pending_verification" ? (
        <PropRow label={t("members.panelAddress")} labelWidth={96}><span className="text-faint">{t("members.panelNotChecked")}</span></PropRow>
      ) : null}
    </PropGroup>
    <div className="mb-3.5 border-b border-line pb-3.5">
      <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-faint">
        {t("members.panelProjects")}
        {member.role === "admin" ? null : <span className="font-mono">{member.projects.length}</span>}
      </h3>
      {member.role === "admin" ? (
        <p className="text-ui text-muted">{t("members.panelAdmins")}</p>
      ) : (
        <>
          <ul>
            {member.projects.map((project) => (
              <li key={project.projectId} className="flex h-[30px] items-center gap-2 border-b border-line text-ui last:border-b-0">
                <Square id={project.projectId} />
                <span className="min-w-0 truncate text-text">{project.name}</span>
                <LockIcon aria-label={t("members.restricted")} className="size-3 shrink-0 stroke-[1.75] text-faint" />
                <span className="ml-auto shrink-0 text-muted">{project.role === "admin" ? t("members.projectAdmin") : t("members.projectMember")}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-faint">{t("members.panelProjectsNote")}</p>
        </>
      )}
    </div>
    {member.onBehalf === null ? null : (
      <PropGroup title={t("members.panelOnBehalf")}>
        <PropRow label={t("members.panelRunners")} labelWidth={132}><span className="font-mono" data-testid="on-behalf-runners">{member.onBehalf.personalRunners}</span></PropRow>
        <PropRow label={t("members.panelCliSessions")} labelWidth={132}><span className="font-mono" data-testid="on-behalf-cli">{member.onBehalf.cliSessions}</span></PropRow>
        <PropRow label={t("members.panelDriving")} labelWidth={132}><span className="font-mono" data-testid="on-behalf-driving">{member.onBehalf.drivingTasks}</span></PropRow>
      </PropGroup>
    )}
  </div>
);

const MembersSkeleton = () => (
  <div aria-busy>
    {Array.from({ length: 5 }, (_, i) => (
      <div key={i} className={cn(grid, "h-11 border-b border-line")}>
        <span className="flex items-center gap-2.5"><Skeleton className="size-[26px] rounded-full" /><Skeleton className="w-[140px]" /></span>
        <Skeleton className="hidden w-[50px] md:block" />
        <Skeleton className="hidden w-[160px] md:block" />
        <Skeleton className="hidden w-[60px] md:block" />
      </div>
    ))}
  </div>
);

const HeadRow = () => (
  <div className={cn(grid, "hidden h-[30px] border-b border-line text-[12.5px] font-medium text-faint md:grid")}>
    <span className="pl-2">{t("members.colMember")}</span>
    <span>{t("members.colRole")}</span>
    <span>{t("members.colProjects")}</span>
    <span>{t("members.colLastActive")}</span>
    <span />
  </div>
);

/** Copy link for an invitation made in this tab: `Copied` for 1.5s. */
const CopyInvitationLink = ({ link }: { readonly link: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="shrink-0 text-ui text-teal hover:underline"
      onClick={() => {
        void navigator.clipboard.writeText(link).then(() => {
          setCopied(true);
          setTimeout(() => { setCopied(false); }, 1500);
        });
      }}
    >
      {copied ? t("members.copied") : t("members.copyLink")}
    </button>
  );
};

const pastText = (invitation: Invitation): string => {
  switch (invitation.state) {
    case "accepted":
      return invitation.acceptedBy === null
        ? t("members.accepted", { date: shortDate(invitation.acceptedAt ?? invitation.createdAt) })
        : t("members.acceptedBy", { date: shortDate(invitation.acceptedAt ?? invitation.createdAt), name: invitation.acceptedBy });
    case "revoked":
      return t("members.revoked", { date: shortDate(invitation.revokedAt ?? invitation.createdAt) });
    case "expired":
      return t("members.expired", { date: shortDate(invitation.expiresAt) });
    case "pending":
      return "";
    default:
      return invitation.state satisfies never;
  }
};

const invitationProjects = (invitation: Invitation): string =>
  invitation.role === "admin"
    ? t("members.allProjects")
    : invitation.projects.length === 0
      ? t("members.openProjects")
      : invitation.projects.map((project) => project.name).join(", ");

type InvitationRowProps = {
  readonly invitation: Invitation;
  readonly now: number;
  readonly link: string | undefined;
  readonly past?: boolean;
  readonly onRevoke?: () => void;
};

const InvitationRow = ({ invitation, now, link, past = false, onRevoke }: InvitationRowProps) => (
  <li className={cn(grid, "min-h-11 border-b border-line py-1.5 text-ui md:py-0", past && "text-muted")} data-testid="invitation-row">
    <span className="flex min-w-0 items-center gap-2.5 pl-2">
      <MailIcon aria-hidden className="mx-[5.5px] size-[15px] shrink-0 stroke-[1.75] text-faint" />
      <span className={cn("min-w-0 truncate font-mono text-[13px]", past ? "text-muted" : "text-text")}>{invitation.email}</span>
    </span>
    <span className="hidden md:inline">{roleWord(invitation.role)}</span>
    <span className={cn("hidden min-w-0 truncate md:inline", invitation.projects.length === 0 && "text-muted")}>{invitationProjects(invitation)}</span>
    <span className="col-span-full pl-[43px] text-sm text-faint md:col-span-1 md:pl-0">{past ? pastText(invitation) : expiryText(invitation.expiresAt, now)}</span>
    {past ? (
      <span className="hidden md:block" />
    ) : (
      <span className="col-span-full flex items-center justify-end gap-4 md:col-span-1 md:-ml-[110px] md:w-[150px]">
        {link === undefined ? null : <CopyInvitationLink link={link} />}
        <Button variant="ghost" size="sm" className="text-muted" onClick={onRevoke}>{t("members.revoke")}</Button>
      </span>
    )}
  </li>
);

/**
 * Organization › Members (F-002, F-003; members.md): the active members with their roles and
 * projects, the invitations waiting and the people removed. Admins act through each row's menu
 * and the invite sheet; a member sees the list without addresses or actions.
 */
export const MembersView = ({ admin, emailOn, invitationDays }: { readonly admin: boolean; readonly emailOn: boolean; readonly invitationDays: number }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const me = useQuery(trpc.me.get.queryOptions());
  const members = useQuery(trpc.members.list.queryOptions({ includeRemoved: admin }));
  const invitations = useQuery({ ...trpc.members.invitations.queryOptions(), enabled: admin });
  const projects = useQuery({ ...trpc.projects.list.queryOptions(), enabled: admin });

  /** The links of invitations made in this tab: `members.invite` returns each once (ADR 0053). */
  const [links, setLinks] = useState<ReadonlyMap<string, string>>(new Map());
  const [pastOpen, setPastOpen] = useState(false);
  const [removedOpen, setRemovedOpen] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const now = Date.now();

  const organization = me.data?.organization?.name ?? "";
  const inviting = admin && search.get("invite") === "1";
  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(search.toString());
    if (value === null) next.delete(key);
    else next.set(key, value);
    const query = next.toString();
    router.replace(query === "" ? pathname : `${pathname}?${query}`, { scroll: false });
  };

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.members.list.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.members.invitations.queryKey() }),
    ]);
  };

  const setRole = useMutation(
    trpc.members.setRole.mutationOptions({
      onMutate: () => { setRoleError(null); },
      onError: (error) => { setRoleError(error.data?.code === "CONFLICT" ? t("members.lastAdmin", { organization }) : errorText(error)); },
      onSettled: () => refresh(),
    }),
  );
  const remove = useMutation(
    trpc.members.remove.mutationOptions({
      onSuccess: async () => {
        setRemoving(null);
        setParam("member", null);
        await refresh();
      },
    }),
  );
  const revoke = useMutation(
    trpc.members.revokeInvitation.mutationOptions({
      onSettled: async () => {
        setRevoking(null);
        await refresh();
      },
    }),
  );

  const removed = (members.data ?? []).filter((member) => member.state === "removed");
  const list = [...(members.data ?? [])].filter((member) => member.state !== "removed").sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === "admin" ? -1 : 1));
  const admins = list.filter((member) => member.role === "admin" && member.state === "active").length;
  const pending = (invitations.data ?? []).filter((invitation) => invitation.state === "pending");
  const past = (invitations.data ?? []).filter((invitation) => invitation.state !== "pending");
  const selfId = me.data?.memberId ?? null;
  const selected = list.find((member) => member.memberId === search.get("member")) ?? list.find((member) => member.memberId === selfId) ?? list[0];

  const lede =
    me.data === undefined || members.data === undefined || (admin && invitations.data === undefined)
      ? undefined
      : admin
        ? adminLede(organization, list.length, admins, pending.length)
        : t("members.ledeMember", { organization });

  const roleOf = (member: Member): Role => (setRole.isPending && setRole.variables.memberId === member.memberId ? setRole.variables.role : member.role);

  const memberRow = (member: Member): ReactNode => {
    const self = member.memberId === selfId;
    const picked = admin && selected?.memberId === member.memberId;
    const changing = setRole.isPending && setRole.variables.memberId === member.memberId;
    return (
      <li
        key={member.memberId}
        data-testid="member-row"
        {...(admin
          ? {
              role: "button",
              tabIndex: 0,
              "aria-pressed": picked,
              onClick: () => { setParam("member", member.memberId); },
              onKeyDown: (event: React.KeyboardEvent) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setParam("member", member.memberId);
                }
              },
            }
          : {})}
        className={cn(grid, "grid-cols-[minmax(0,1fr)_auto] border-b border-line py-2 text-ui md:h-11 md:py-0", admin && "cursor-default hover:bg-hover", picked && "bg-sel hover:bg-sel")}
      >
        <span className="flex min-w-0 items-center gap-2.5 pl-2">
          <MemberAvatar name={member.name} />
          <span className="min-w-0">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-text">{member.name}</span>
              {self ? <span className="inline-flex h-[22px] shrink-0 items-center rounded-md border border-line-2 px-1.5 text-xs text-muted">{t("members.you")}</span> : null}
              {member.email === null ? null : <span className="ml-1 hidden min-w-0 truncate font-mono text-[13px] text-faint min-[900px]:inline">{member.email}</span>}
            </span>
            <span className="block truncate text-sm text-faint md:hidden">
              {roleWord(member.role)} · {member.state === "pending_verification" ? t("members.waitingCheck") : member.lastActiveAt === null ? "—" : lastActiveText(member.lastActiveAt, now)}
            </span>
            {member.email === null ? null : <span className="hidden truncate font-mono text-[13px] text-faint md:max-[899px]:block">{member.email}</span>}
          </span>
        </span>
        <span className={cn("hidden text-text md:inline", changing && "opacity-60")}>{roleWord(roleOf(member))}</span>
        <span className="hidden min-w-0 md:block"><ProjectsCell member={member} /></span>
        <span className="hidden md:inline">
          {member.state === "pending_verification" ? (
            <span className="block truncate text-sm text-faint" title={t("members.waitingCheck")}>{t("members.waitingCheck")}</span>
          ) : (
            <span className="font-mono text-[13px] text-faint">{member.lastActiveAt === null ? "—" : lastActiveText(member.lastActiveAt, now)}</span>
          )}
        </span>
        <span className="flex justify-end pr-1">
          {admin ? (
            <RowMenu
              member={member}
              organization={organization}
              self={self}
              onlyAdmin={admins <= 1}
              onRole={(role) => { setRole.mutate({ memberId: member.memberId, role }); }}
              onRemove={() => { remove.reset(); setRemoving(member); }}
            />
          ) : null}
        </span>
      </li>
    );
  };

  const removedRow = (person: Member) => (
    <li key={person.memberId} className={cn(grid, "min-h-11 border-b border-line py-1.5 text-ui md:py-0")}>
      <span className="flex min-w-0 items-center gap-2.5 pl-2">
        <MemberAvatar name={person.name} dim />
        <span className="truncate text-muted">{person.name}</span>
        {person.email === null ? null : <span className="hidden min-w-0 truncate font-mono text-[13px] text-faint min-[900px]:inline">{person.email}</span>}
      </span>
      <span className="hidden md:block" />
      <span className="hidden md:block" />
      <span className="col-span-full pl-[43px] text-sm text-faint md:col-span-2 md:pl-0">
        {removedText(person.removedAt ?? person.joinedAt, person.removedBy)}
      </span>
    </li>
  );

  return (
    <Sheet open={inviting} onOpenChange={(open) => { setParam("invite", open ? "1" : null); }}>
      <PageFrame
        crumbs={[{ label: organization === "" ? t("shell.organization") : organization }, { label: t("members.title") }]}
        {...(admin
          ? {
              actions: (
                <Button variant="primary" onClick={() => { setParam("invite", "1"); }} aria-label={t("members.invite")}>
                  <PlusIcon className="stroke-[1.75]" /> <span className="hidden sm:inline">{t("members.invite")}</span>
                </Button>
              ),
              properties: selected === undefined ? (members.isPending ? null : undefined) : <MemberProperties member={selected} now={now} />,
            }
          : {})}
      >
        <PageHeading title={t("members.title")} {...(lede === undefined ? {} : { lede })} />
        {lede === undefined ? <div className="h-5" aria-hidden /> : null}
        {members.isError ? (
          <p role="alert" className="mt-4 text-sm text-red">{errorText(members.error)}</p>
        ) : (
          <>
            <Section title={t("members.section")} {...(members.data === undefined ? {} : { count: list.length })}>
              {roleError === null ? null : <p role="alert" className="mb-1 text-sm text-red">{roleError}</p>}
              <HeadRow />
              {members.data === undefined ? <MembersSkeleton /> : <ul aria-label={t("members.section")}>{list.map(memberRow)}</ul>}
            </Section>

            {admin && invitations.data !== undefined ? (
              <Section title={t("members.invitations")} count={pending.length}>
                {pending.length === 0 && past.length === 0 ? (
                  <p className="text-ui text-faint">
                    {t("members.noInvitation")}
                    <button type="button" className="text-teal hover:underline" onClick={() => { setParam("invite", "1"); }}>{t("members.noInvitationLink")}</button>.
                  </p>
                ) : (
                  <ul aria-label={t("members.invitations")}>
                    {pending.map((invitation) => (
                      <InvitationRow key={invitation.handle} invitation={invitation} now={now} link={links.get(invitation.handle)} onRevoke={() => { setRevoking(invitation); }} />
                    ))}
                  </ul>
                )}
                {past.length === 0 ? null : (
                  <>
                    <button
                      type="button"
                      aria-expanded={pastOpen}
                      onClick={() => { setPastOpen((open) => !open); }}
                      className="mt-2 flex h-6 items-center gap-1.5 rounded-sm px-1 text-sm text-muted hover:text-text"
                    >
                      {pastOpen ? <ChevronDownIcon aria-hidden className="size-[15px] stroke-[1.75]" /> : <ChevronRightIcon aria-hidden className="size-[15px] stroke-[1.75]" />}
                      {pastOpen ? t("members.hidePast") : plural(past.length, "members.showPastOne", "members.showPastOther")}
                    </button>
                    {pastOpen ? (
                      <ul aria-label={t("members.hidePast")}>
                        {past.map((invitation) => <InvitationRow key={invitation.handle} invitation={invitation} now={now} link={undefined} past />)}
                      </ul>
                    ) : null}
                  </>
                )}
              </Section>
            ) : null}

            {admin && removed.length > 0 ? (
              <section className="mt-[26px]">
                <button
                  type="button"
                  aria-expanded={removedOpen}
                  onClick={() => { setRemovedOpen((open) => !open); }}
                  className="flex h-[30px] w-full items-center gap-2 text-left"
                >
                  {removedOpen ? <ChevronDownIcon aria-hidden className="size-[15px] stroke-[1.75] text-faint" /> : <ChevronRightIcon aria-hidden className="size-[15px] stroke-[1.75] text-faint" />}
                  <h2 className="text-body font-semibold text-muted">{t("members.removed")}</h2>
                  <span className="font-mono text-[12.5px] text-faint">{removed.length}</span>
                </button>
                {removedOpen ? <ul aria-label={t("members.removed")}>{removed.map(removedRow)}</ul> : null}
              </section>
            ) : null}
          </>
        )}
      </PageFrame>

      {admin && me.data !== undefined ? (
        <InviteSheet
          organization={organization}
          inviterName={me.data.name}
          emailOn={emailOn}
          days={invitationDays}
          projects={projects.data ?? []}
          onCreated={(handle, link) => {
            setLinks((previous) => new Map(previous).set(handle, link));
            void refresh();
          }}
          onClose={() => { setParam("invite", null); }}
        />
      ) : null}

      <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open && !remove.isPending) setRemoving(null); }}>
        {removing === null ? null : (
          <AlertDialogContent
            title={t("members.removeTitle", { name: removing.name, organization })}
            body={
              <>
                <p>{t("members.removeBody")}</p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {removalLines(organization, removing.onBehalf).map((line) => <li key={line}>{line}</li>)}
                </ul>
              </>
            }
            cancel={t("common.cancel")}
            action={t("members.removeConfirm", { name: removing.name })}
            pending={{ busy: remove.isPending, label: t("members.removing"), error: remove.isError ? errorText(remove.error) : null }}
            onAction={() => { remove.mutate({ memberId: removing.memberId }); }}
          />
        )}
      </AlertDialog>

      <AlertDialog open={revoking !== null} onOpenChange={(open) => { if (!open) setRevoking(null); }}>
        {revoking === null ? null : (
          <AlertDialogContent
            title={t("members.revokeTitle", { address: revoking.email })}
            body={t("members.revokeBody")}
            cancel={t("common.cancel")}
            action={t("members.revoke")}
            onAction={() => { revoke.mutate({ handle: revoking.handle }); }}
          />
        )}
      </AlertDialog>
    </Sheet>
  );
};
