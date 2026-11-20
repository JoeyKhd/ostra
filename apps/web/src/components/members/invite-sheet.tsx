"use client";

import { useMutation } from "@tanstack/react-query";
import { CheckIcon, CircleCheckIcon, CopyIcon, InfoIcon, LoaderCircleIcon, LockIcon, MailIcon, ShieldIcon, XIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import { useState } from "react";
import type { ReactNode, SubmitEvent } from "react";

import { projectColour } from "@/components/shell/project-colour";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterInputs, RouterOutputs } from "@/lib/trpc";

import { addressProblem, shortDate } from "./member-words";

type Project = RouterOutputs["projects"]["list"][number];
type Role = RouterInputs["members"]["invite"]["role"];
type Grant = NonNullable<RouterInputs["members"]["invite"]["projectGrants"]>[number];
type Created = RouterOutputs["members"]["invite"] & { readonly email: string; readonly role: Role; readonly grants: readonly Grant[] };

export type InviteSheetProps = {
  readonly organization: string;
  readonly inviterName: string;
  readonly emailOn: boolean;
  readonly days: number;
  readonly projects: readonly Project[];
  readonly onCreated: (handle: string, link: string) => void;
  readonly onClose: () => void;
};

const Header = ({ title, children }: { readonly title: string; readonly children: ReactNode }) => (
  <div className="pr-8">
    <h2 className="font-display text-[19px] font-bold leading-tight tracking-[-0.01em] text-text">{title}</h2>
    <p className="mt-1.5 -mr-8 text-[14px] text-muted">{children}</p>
  </div>
);

const Footer = ({ children }: { readonly children: ReactNode }) => (
  <div className="shrink-0 border-t border-line px-7 pb-[max(24px,env(safe-area-inset-bottom))] pt-4">{children}</div>
);

const LinkCopy = ({ link }: { readonly link: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="mt-2 inline-flex items-center gap-1.5 text-body text-teal hover:underline [&_svg]:size-[14px] [&_svg]:stroke-[1.75]"
      onClick={() => {
        void navigator.clipboard.writeText(link).then(() => {
          setCopied(true);
          setTimeout(() => { setCopied(false); }, 1500);
        });
      }}
    >
      {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
      {copied ? t("members.copied") : t("members.copyLink")}
    </button>
  );
};

const SheetRow = ({ label, children }: { readonly label: string; readonly children: ReactNode }) => (
  <div className="grid min-h-[30px] grid-cols-[96px_minmax(0,1fr)] items-start gap-2 py-1 text-ui">
    <span className="text-muted">{label}</span>
    <span className="min-w-0 text-text">{children}</span>
  </div>
);

/** State 2: the link, shown once (member-invite.md). Nothing re-fetches it. */
export const CreatedBody = ({ created, organization, inviterName, emailOn, projects }: { readonly created: Created; readonly organization: string; readonly inviterName: string; readonly emailOn: boolean; readonly projects: readonly Project[] }) => {
  const nameOf = (id: string) => projects.find((project) => project.id === id)?.name ?? id;
  return (
    <>
      <Header title={t("members.sheet.createdTitle")}>
        <span className="font-mono text-text">{created.email}</span>{" "}
        {created.role === "admin" ? t("members.sheet.createdLedeAdmin", { organization }) : t("members.sheet.createdLedeMember", { organization })}
      </Header>
      <div className="mt-6">
        <Label className="mb-2 block text-sm font-medium text-muted" htmlFor="invitation-link">{t("members.sheet.link")}</Label>
        <div id="invitation-link" data-testid="invitation-link" className="select-all break-all rounded-lg border border-line-2 bg-surface px-3.5 py-2.5 font-mono text-[13px] text-text">
          {created.link}
        </div>
        <LinkCopy link={created.link} />
        <p className="mt-3.5 flex items-start gap-2 text-sm text-muted">
          <ShieldIcon aria-hidden className="mt-0.5 size-[14px] shrink-0 stroke-[1.75]" />
          {t("members.sheet.privately")}
        </p>
        <p className="mt-2 text-[12.5px] text-faint">{t("members.sheet.shownOnce", { date: shortDate(created.expiresAt) })}</p>
      </div>
      <div className="mt-5 flex items-center gap-2.5 border-y border-line py-3.5 text-ui">
        {emailOn && created.mailed ? (
          <>
            <CircleCheckIcon aria-hidden className="size-4 shrink-0 stroke-[1.75] text-green" />
            <span className="text-text">{t("members.sheet.mailedTo")}<span className="font-mono">{created.email}</span></span>
          </>
        ) : (
          <>
            <InfoIcon aria-hidden className="size-4 shrink-0 stroke-[1.75] text-faint" />
            <span className="text-muted">{t("members.sheet.mailOffAfter")}</span>
          </>
        )}
      </div>
      <div className="mt-3.5">
        <h3 className="mb-1 text-xs font-medium text-faint">{t("members.sheet.group")}</h3>
        <SheetRow label={t("members.panelRole")}>{created.role === "admin" ? t("members.admin") : t("members.member")}</SheetRow>
        <SheetRow label={t("members.sheet.projects")}>
          {created.role === "admin" ? (
            t("members.allProjects")
          ) : created.grants.length === 0 ? (
            t("members.openProjects")
          ) : (
            <ul>
              {created.grants.map((grant) => (
                <li key={grant.projectId} className="flex items-center gap-[7px]">
                  <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(grant.projectId) }} />
                  {nameOf(grant.projectId)}
                  <LockIcon aria-hidden className="size-3 stroke-[1.75] text-faint" />
                  <span className="text-muted">· {grant.role === "admin" ? t("members.projectAdmin") : t("members.projectMember")}</span>
                </li>
              ))}
            </ul>
          )}
        </SheetRow>
        <SheetRow label={t("members.sheet.expires")}>{shortDate(created.expiresAt)}</SheetRow>
        <SheetRow label={t("members.sheet.invitedBy")}>{inviterName}</SheetRow>
      </div>
    </>
  );
};

/**
 * The invite sheet (F-002, member-invite.md): an address, the organization role and restricted
 * projects with a role each; then the link, shown once, with what to do with it.
 */
export const InviteSheet = ({ organization, inviterName, emailOn, days, projects, onCreated, onClose }: InviteSheetProps) => {
  const trpc = useTRPC();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [grants, setGrants] = useState<ReadonlyMap<string, Grant>>(new Map());
  const [projectRoles, setProjectRoles] = useState<ReadonlyMap<string, Grant["role"]>>(new Map());
  const [problem, setProblem] = useState<"empty" | "invalid" | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const invite = useMutation(trpc.members.invite.mutationOptions());
  const restricted = projects.filter((project) => project.access === "restricted");
  const busy = invite.isPending;

  const fieldError = problem === "empty" ? t("members.sheet.emptyAddress") : problem === "invalid" ? t("members.sheet.badAddress") : null;
  const serverError = invite.isError ? errorText(invite.error) : null;
  /** The server's refusals about the address (already a member, already invited) sit under the field. */
  const addressRefusal = invite.isError && invite.error.data?.code === "CONFLICT" ? serverError : null;

  const reset = () => {
    setEmail("");
    setGrants(new Map());
    setProjectRoles(new Map());
    setProblem(null);
    setCreated(null);
    invite.reset();
  };

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (busy) return;
    const found = addressProblem(email);
    setProblem(found);
    if (found !== null) return;
    const projectGrants = role === "admin" ? [] : [...grants.values()];
    const address = email.trim();
    invite.mutate(
      { email: address, role, projectGrants },
      {
        onSuccess: (result) => {
          setCreated({ ...result, email: address, role, grants: projectGrants });
          onCreated(result.handle, result.link);
        },
      },
    );
  };

  const toggle = (project: Project, on: boolean) => {
    const next = new Map(grants);
    if (on) next.set(project.id, { projectId: project.id, role: projectRoles.get(project.id) ?? "member" });
    else next.delete(project.id);
    setGrants(next);
  };

  return (
    <SheetContent
      title={created === null ? t("members.sheet.title", { organization }) : t("members.sheet.createdTitle")}
      closeButton={false}
      className="w-full border-line-2 bg-bg sm:w-[450px]"
      onInteractOutside={(event) => { if (busy) event.preventDefault(); }}
      onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
      onCloseAutoFocus={() => { reset(); }}
    >
      <Dialog.Close className="absolute right-5 top-5 grid size-7 place-items-center rounded-md text-faint hover:bg-sel hover:text-text" aria-label={t("common.close")}>
        <XIcon className="size-4 stroke-[1.75]" />
      </Dialog.Close>
      {created !== null ? (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-6 pb-6">
            <CreatedBody created={created} organization={organization} inviterName={inviterName} emailOn={emailOn} projects={projects} />
          </div>
          <Footer>
            <div className="flex gap-3">
              <Button variant="primary" size="lg" className="min-w-[132px]" onClick={onClose}>{t("members.sheet.done")}</Button>
              <Button size="lg" onClick={() => { const keep = role; reset(); setRole(keep); }}>{t("members.sheet.another")}</Button>
            </div>
          </Footer>
        </>
      ) : (
        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-6 pb-6">
            <Header title={t("members.sheet.title", { organization })}>{t("members.sheet.lede", { days })}</Header>
            <div className="mt-6">
              <Label className="mb-2 block text-sm font-medium text-muted" htmlFor="invite-email">{t("members.sheet.address")}</Label>
              <Input
                id="invite-email"
                type="email"
                autoComplete="off"
                autoFocus
                required
                disabled={busy}
                aria-invalid={fieldError !== null || addressRefusal !== null}
                aria-describedby={fieldError !== null || addressRefusal !== null ? "invite-email-error" : undefined}
                className="font-mono text-body"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setProblem(null);
                  if (invite.isError) invite.reset();
                }}
              />
              {fieldError ?? addressRefusal ? (
                <p id="invite-email-error" role="alert" className="mt-1.5 text-sm text-red">{fieldError ?? addressRefusal}</p>
              ) : null}
            </div>
            <fieldset className="mt-5" disabled={busy}>
              <legend className="mb-2 text-sm font-medium text-muted">{t("members.sheet.role", { organization })}</legend>
              <RadioGroup value={role} onValueChange={(value) => { if (value === "admin" || value === "member") setRole(value); }} className="divide-y divide-line border-b border-line">
                {(["member", "admin"] as const).map((value) => (
                  <label key={value} htmlFor={`invite-role-${value}`} className="flex min-h-[52px] cursor-pointer items-start gap-3 py-2.5">
                    <RadioGroupItem id={`invite-role-${value}`} value={value} className="mt-1 size-4 data-[state=checked]:border-primary data-[state=checked]:bg-primary [&>span]:bg-on-primary" />
                    <span>
                      <span className="block text-ui text-text">{value === "admin" ? t("members.admin") : t("members.member")}</span>
                      <span className="block text-[12.5px] text-faint">{value === "admin" ? t("members.sheet.adminHint") : t("members.sheet.memberHint")}</span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
            </fieldset>
            <div className="mt-6">
              <h3 className="text-ui font-semibold text-text">
                {t("members.sheet.restricted")} <span className="ml-1 text-[12.5px] font-normal text-faint">{t("members.sheet.optional")}</span>
              </h3>
              {role === "admin" ? (
                <p className="mt-1 text-sm text-muted">{t("members.sheet.adminsAll")}</p>
              ) : (
                <>
                  <p className="mt-1 text-sm text-muted">{t("members.sheet.restrictedNote")}</p>
                  {restricted.length === 0 ? (
                    <p className="mt-3 text-sm text-faint">{t("members.sheet.noRestricted", { organization })}</p>
                  ) : (
                    <ul className="mt-3 max-h-[352px] overflow-y-auto border-y border-line" aria-label={t("members.sheet.restricted")}>
                      {restricted.map((project) => {
                        const checked = grants.has(project.id);
                        const projectRole = projectRoles.get(project.id) ?? "member";
                        return (
                          <li key={project.id} className={cn("flex h-11 items-center gap-3 border-b border-line px-3 last:border-b-0", checked && "bg-sel")}>
                            <Checkbox id={`grant-${project.id}`} checked={checked} disabled={busy} onCheckedChange={(on) => { toggle(project, on === true); }} />
                            <label htmlFor={`grant-${project.id}`} className="flex min-w-0 flex-1 items-center gap-2.5 text-ui text-text">
                              <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(project.id) }} />
                              <span className="truncate">{project.name}</span>
                              <LockIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75] text-faint" />
                            </label>
                            <Select
                              value={projectRole}
                              disabled={!checked || busy}
                              onValueChange={(value) => {
                                if (value !== "admin" && value !== "member") return;
                                setProjectRoles(new Map(projectRoles).set(project.id, value));
                                if (checked) setGrants(new Map(grants).set(project.id, { projectId: project.id, role: value }));
                              }}
                            >
                              <SelectTrigger aria-label={t("members.sheet.projects")} className="w-[140px] bg-surface">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="member">{t("members.projectMember")}</SelectItem>
                                <SelectItem value="admin">{t("members.projectAdmin")}</SelectItem>
                              </SelectContent>
                            </Select>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </>
              )}
            </div>
          </div>
          <Footer>
            <p className="flex items-center gap-2 text-sm text-muted">
              <MailIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75]" />
              {emailOn ? t("members.sheet.mailOn") : t("members.sheet.mailOff")}
            </p>
            {serverError !== null && addressRefusal === null ? <p role="alert" className="mt-3 text-sm text-red">{serverError}</p> : null}
            <div className="mt-3.5 flex gap-3">
              <Button type="submit" variant="primary" size="lg" disabled={busy}>
                {busy ? <LoaderCircleIcon aria-hidden className="motion-safe:animate-spin" /> : null}
                {busy ? t("members.sheet.creating") : t("members.sheet.create")}
              </Button>
              <Button type="button" size="lg" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
            </div>
          </Footer>
        </form>
      )}
    </SheetContent>
  );
};
