"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CopyIcon, FileIcon, InfoIcon, KeyRoundIcon, LoaderCircleIcon, LockIcon, ShieldIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { Dialog } from "radix-ui";
import { useRef, useState } from "react";
import type { ReactNode, SubmitEvent } from "react";

import { projectColour } from "@/components/shell/project-colour";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SheetContent } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { UnderlineTabs } from "@/components/ui/underline-tabs";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { firstJoinPath, joinCommand, joinExecutor, joinPaths } from "./join-commands";
import type { JoinPath } from "./join-commands";
import { JoinTokenList } from "./join-token-list";
import { longDate } from "./runner-words";

// F-091 (ticket 30): the pool sheet, 450px from the right with a pinned footer (pool-new.md,
// pool-join.md). One sheet holds four steps: New pool, Edit {pool}, New join token, and the token
// shown once with the three ways to start a runner. The token lives only in this component's state:
// closing the sheet drops it, and nothing fetches it again.

/** What the panel's server knows that the commands need. */
export type FleetSettings = {
  /** Core's address as a runner reaches it. */
  readonly serverUrl: string;
  /** The server's version: the runner pins itself to it. */
  readonly serverVersion: string;
  /** `OSTRA_JOIN_TOKEN_DAYS`: a token's lifetime when a pool names none; 0 is none. */
  readonly joinTokenDays: number;
};

/** The pool the sheet works on, as both the Runners page and the pool page know it. */
export type SheetPool = {
  readonly id: string;
  readonly name: string;
  readonly requiresApproval: boolean;
  readonly maxBoxes: number | null;
  readonly joinTokenDays: number | null;
  readonly executors: readonly string[];
};

export type PoolSheetStep =
  | { readonly kind: "new-pool" }
  | { readonly kind: "edit"; readonly pool: SheetPool }
  | { readonly kind: "new-token"; readonly pool: SheetPool };

type Shown = {
  readonly title: string;
  readonly pool: SheetPool;
  readonly joinTokenId: string;
  readonly token: string;
  readonly expiresAt: number | null;
};

const Header = ({ title, children }: { readonly title: string; readonly children: ReactNode }) => (
  <div className="pr-8">
    <h2 className="font-display text-[19px] font-bold leading-tight tracking-[-0.01em] text-text">{title}</h2>
    <p className="mt-1.5 text-[14px] text-muted">{children}</p>
  </div>
);

const Body = ({ children }: { readonly children: ReactNode }) => <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-6 pt-6">{children}</div>;

const Footer = ({ children }: { readonly children: ReactNode }) => (
  <div className="shrink-0 border-t border-line px-7 pb-[max(24px,env(safe-area-inset-bottom))] pt-4">{children}</div>
);

const FieldLabel = ({ htmlFor, children }: { readonly htmlFor?: string; readonly children: ReactNode }) =>
  htmlFor === undefined ? (
    <h3 className="mb-2 text-sm font-medium text-muted">{children}</h3>
  ) : (
    <Label className="mb-2 block text-sm font-medium text-muted" htmlFor={htmlFor}>{children}</Label>
  );

const FieldError = ({ id, children }: { readonly id: string; readonly children: string | null }) =>
  children === null ? null : <p id={id} role="alert" className="mt-1.5 text-sm text-red">{children}</p>;

/** How long a pool's tokens last, as the three radio rows choose it. */
type Lifetime = { readonly kind: "default" } | { readonly kind: "days"; readonly days: string } | { readonly kind: "none" };

const lifetimeOf = (joinTokenDays: number | null): Lifetime =>
  joinTokenDays === null ? { kind: "default" } : joinTokenDays === 0 ? { kind: "none" } : { kind: "days", days: String(joinTokenDays) };

/** The lifetime's value for `pools.create`/`update` (`null` the setting's, `0` none), or `"invalid"`. */
export const poolLifetimeValue = (lifetime: Lifetime): number | null | "invalid" => {
  switch (lifetime.kind) {
    case "default":
      return null;
    case "none":
      return 0;
    case "days": {
      const days = Number.parseInt(lifetime.days, 10);
      return /^\d+$/.test(lifetime.days) && days >= 1 && days <= 3650 ? days : "invalid";
    }
    default:
      return lifetime satisfies never;
  }
};

/** `Max boxes`: empty for no limit, digits of 1 or more, or `"invalid"`. */
export const maxBoxesValue = (text: string): number | null | "invalid" => {
  if (text.trim() === "") return null;
  const n = Number.parseInt(text, 10);
  return /^\d+$/.test(text.trim()) && n >= 1 && n <= 100_000 ? n : "invalid";
};

const LifetimeRows = ({ lifetime, onChange, defaultDays, disabled, error, idPrefix }: {
  readonly lifetime: Lifetime;
  readonly onChange: (lifetime: Lifetime) => void;
  readonly defaultDays: number;
  readonly disabled: boolean;
  readonly error: string | null;
  readonly idPrefix: string;
}) => {
  const daysRef = useRef<HTMLInputElement>(null);
  const radioClass = "size-4 data-[state=checked]:border-primary data-[state=checked]:bg-primary [&>span]:bg-on-primary";
  return (
    <>
      <RadioGroup
        value={lifetime.kind}
        disabled={disabled}
        onValueChange={(value) => {
          if (value === "default" || value === "none") onChange({ kind: value });
          if (value === "days") {
            onChange({ kind: "days", days: lifetime.kind === "days" ? lifetime.days : "" });
            setTimeout(() => daysRef.current?.focus(), 0);
          }
        }}
        className="divide-y divide-line border-y border-line"
        aria-label={t("runners.poolForm.lifetime")}
      >
        <label htmlFor={`${idPrefix}-default`} className="flex h-10 cursor-pointer items-center gap-3">
          <RadioGroupItem id={`${idPrefix}-default`} value="default" className={radioClass} />
          <span className="text-ui text-text">{defaultDays === 0 ? t("runners.poolForm.noExpiry") : t("runners.poolForm.days", { n: defaultDays })}</span>
          <span className="text-ui text-faint">{t("runners.poolForm.theDefault")}</span>
        </label>
        <div className="flex h-10 items-center gap-3">
          <RadioGroupItem id={`${idPrefix}-days`} value="days" className={radioClass} />
          <label htmlFor={`${idPrefix}-days`} className="cursor-pointer text-ui text-text">{t("runners.poolForm.another")}</label>
          <Input
            ref={daysRef}
            aria-label={t("runners.poolForm.daysLabel")}
            inputMode="numeric"
            placeholder={t("runners.poolForm.daysPlaceholder")}
            disabled={disabled || lifetime.kind !== "days"}
            className="h-[30px] w-[70px] font-mono"
            value={lifetime.kind === "days" ? lifetime.days : ""}
            onChange={(event) => { onChange({ kind: "days", days: event.target.value.replace(/\D/g, "") }); }}
          />
        </div>
        <label htmlFor={`${idPrefix}-none`} className="flex h-10 cursor-pointer items-center gap-3">
          <RadioGroupItem id={`${idPrefix}-none`} value="none" className={radioClass} />
          <span className="text-ui text-text">{t("runners.poolForm.noExpiry")}</span>
          <span className="text-ui text-faint">{t("runners.poolForm.untilRevoked")}</span>
        </label>
      </RadioGroup>
      <FieldError id={`${idPrefix}-error`}>{error}</FieldError>
    </>
  );
};

/** New pool, or Edit {pool} (pool-new.md). */
const PoolForm = ({ edit, settings, onShown, onClose }: {
  readonly edit: SheetPool | null;
  readonly settings: FleetSettings;
  readonly onShown: (shown: Shown) => void;
  readonly onClose: () => void;
}) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const projects = useQuery({ ...trpc.projects.list.queryOptions(), enabled: edit === null });
  const [name, setName] = useState(edit?.name ?? "");
  const [requiresApproval, setRequiresApproval] = useState(edit?.requiresApproval ?? false);
  const [maxBoxes, setMaxBoxes] = useState(edit?.maxBoxes === null || edit === null ? "" : String(edit.maxBoxes));
  const [lifetime, setLifetime] = useState<Lifetime>(lifetimeOf(edit?.joinTokenDays ?? null));
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [problems, setProblems] = useState<{ readonly name: boolean; readonly max: boolean; readonly lifetime: boolean }>({ name: false, max: false, lifetime: false });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.pools.list.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.pools.get.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.joinTokens.list.queryKey() }),
    ]);
  const create = useMutation(trpc.pools.create.mutationOptions({ onSuccess: refresh }));
  const update = useMutation(trpc.pools.update.mutationOptions({ onSuccess: refresh }));
  const busy = create.isPending || update.isPending;
  const failure = create.error ?? update.error;
  const clash = failure?.data?.code === "CONFLICT";

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (busy) return;
    const cap = maxBoxesValue(maxBoxes);
    const days = poolLifetimeValue(lifetime);
    const found = { name: name.trim() === "", max: cap === "invalid", lifetime: days === "invalid" };
    setProblems(found);
    if (found.name || cap === "invalid" || days === "invalid") return;
    if (edit !== null) {
      update.mutate({ poolId: edit.id, name: name.trim(), requiresApproval, maxBoxes: cap, joinTokenDays: days }, { onSuccess: onClose });
      return;
    }
    create.mutate(
      { name: name.trim(), requiresApproval, maxBoxes: cap, joinTokenDays: days, projectIds: [...picked] },
      {
        onSuccess: (made) => {
          onShown({
            title: t("runners.join.poolCreated"),
            pool: { id: made.poolId, name: made.pool.name, requiresApproval: made.pool.requiresApproval, maxBoxes: made.pool.maxBoxes, joinTokenDays: made.pool.joinTokenDays, executors: [] },
            joinTokenId: made.joinToken.joinTokenId,
            token: made.joinToken.token,
            expiresAt: made.joinToken.expiresAt,
          });
        },
      },
    );
  };

  const nameError = problems.name ? t("runners.poolForm.nameEmpty") : clash ? t("runners.poolNameTaken") : null;
  const title = edit === null ? t("runners.newPoolTitle") : t("runners.poolForm.editTitle", { pool: edit.name });
  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
      <Body>
        <Header title={title}>{edit === null ? t("runners.poolForm.lede") : t("runners.poolForm.editLede")}</Header>
        <fieldset disabled={busy} className="mt-6 space-y-5">
          <div>
            <FieldLabel htmlFor="pool-name">{t("runners.poolName")}</FieldLabel>
            <Input
              id="pool-name"
              autoFocus
              required
              maxLength={64}
              autoComplete="off"
              aria-invalid={nameError !== null}
              aria-describedby={nameError === null ? undefined : "pool-name-error"}
              className={cn("font-mono text-body", nameError !== null && "border-red")}
              value={name}
              onChange={(event) => { setName(event.target.value); setProblems({ ...problems, name: false }); create.reset(); update.reset(); }}
            />
            <FieldError id="pool-name-error">{nameError}</FieldError>
          </div>
          <label htmlFor="pool-approval" className="flex min-h-[52px] cursor-pointer items-center gap-3 border-y border-line py-2">
            <span className="min-w-0 flex-1">
              <span className="block text-body text-text">{t("runners.poolRequiresApproval")}</span>
              <span className="block text-[12.5px] text-faint">{t("runners.poolForm.approvalHelp")}</span>
            </span>
            <Switch id="pool-approval" checked={requiresApproval} onCheckedChange={setRequiresApproval} />
          </label>
          <div>
            <FieldLabel htmlFor="pool-max">{t("runners.poolMaxBoxes")}</FieldLabel>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <Input
                id="pool-max"
                inputMode="numeric"
                className={cn("w-[120px] font-mono", problems.max && "border-red")}
                placeholder={t("runners.noLimit")}
                aria-invalid={problems.max}
                value={maxBoxes}
                onChange={(event) => { setMaxBoxes(event.target.value.replace(/[^\d]/g, "")); setProblems({ ...problems, max: false }); }}
              />
              <span className="text-[12.5px] text-faint">{t("runners.poolForm.maxHelp")}</span>
            </div>
            <FieldError id="pool-max-error">{problems.max ? t("runners.poolForm.maxInvalid") : null}</FieldError>
          </div>
          <div>
            <FieldLabel>{t("runners.poolForm.lifetime")}</FieldLabel>
            <LifetimeRows
              idPrefix="pool-life"
              lifetime={lifetime}
              onChange={(next) => { setLifetime(next); setProblems({ ...problems, lifetime: false }); }}
              defaultDays={settings.joinTokenDays}
              disabled={busy}
              error={problems.lifetime ? t("runners.poolForm.daysInvalid") : null}
            />
            {edit === null ? null : <p className="mt-2 text-[12.5px] text-faint">{t("runners.poolForm.keepExpiry")}</p>}
          </div>
          {edit === null ? (
            <div>
              <h3 className="text-body font-semibold text-text">
                {t("runners.poolForm.projects")} <span className="ml-1 text-[12.5px] font-normal text-faint">{t("runners.poolForm.optional")}</span>
              </h3>
              <p className="mt-1 text-sm text-muted">{t("runners.poolForm.projectsNote")}</p>
              {projects.data === undefined ? null : projects.data.length === 0 ? (
                <p className="mt-3 text-sm text-faint">{t("runners.poolForm.noProjects")}</p>
              ) : (
                <ul className="mt-3 max-h-[352px] overflow-y-auto border-y border-line" aria-label={t("runners.poolForm.projects")}>
                  {projects.data.map((project) => {
                    const checked = picked.has(project.id);
                    return (
                      <li key={project.id} className={cn("flex h-11 items-center gap-3 border-b border-line px-3 last:border-b-0", checked && "bg-sel")}>
                        <Checkbox
                          id={`pool-project-${project.id}`}
                          checked={checked}
                          onCheckedChange={(on) => {
                            const next = new Set(picked);
                            if (on === true) next.add(project.id);
                            else next.delete(project.id);
                            setPicked(next);
                          }}
                        />
                        <label htmlFor={`pool-project-${project.id}`} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-ui text-text">
                          <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(project.id) }} />
                          <span className="truncate">{project.name}</span>
                          {project.access === "restricted" ? <LockIcon aria-label={t("runners.poolForm.restricted")} className="size-[13px] shrink-0 stroke-[1.75] text-faint" /> : null}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ) : null}
        </fieldset>
      </Body>
      <Footer>
        {edit === null ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <KeyRoundIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75]" />
            {t("runners.poolForm.footer")}
          </p>
        ) : null}
        {failure === null || clash ? null : <p role="alert" className="mt-3 text-sm text-red">{errorText(failure)}</p>}
        <div className={cn("flex gap-3", edit === null && "mt-3.5")}>
          <Button type="submit" variant="primary" size="lg" disabled={busy}>
            {busy ? <LoaderCircleIcon aria-hidden className="motion-safe:animate-spin" /> : null}
            {edit !== null ? (busy ? t("runners.poolForm.saving") : t("common.save")) : busy ? t("runners.creatingPool") : t("runners.createPool")}
          </Button>
          <Button type="button" size="lg" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
        </div>
      </Footer>
    </form>
  );
};

/** New join token for {pool}: a label and how long it lasts (pool-join.md, "Before it"). */
const TokenForm = ({ pool, settings, onShown, onClose }: { readonly pool: SheetPool; readonly settings: FleetSettings; readonly onShown: (shown: Shown) => void; readonly onClose: () => void }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [lifetime, setLifetime] = useState<Lifetime>({ kind: "default" });
  const [invalid, setInvalid] = useState(false);
  const create = useMutation(
    trpc.joinTokens.create.mutationOptions({
      onSuccess: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.joinTokens.list.queryKey({ poolId: pool.id }) }),
          queryClient.invalidateQueries({ queryKey: trpc.pools.list.queryKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.pools.get.queryKey({ poolId: pool.id }) }),
        ]),
    }),
  );
  const busy = create.isPending;
  // The pool's own lifetime is the default row here: `null` sends nothing and the pool's applies.
  const poolDays = pool.joinTokenDays ?? settings.joinTokenDays;
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (busy) return;
    const value = poolLifetimeValue(lifetime);
    if (value === "invalid") {
      setInvalid(true);
      return;
    }
    const days = lifetime.kind === "default" ? {} : { days: value === 0 ? null : value };
    create.mutate(
      { poolId: pool.id, label: label.trim() === "" ? null : label.trim(), ...days },
      { onSuccess: (made) => { onShown({ title: t("runners.join.tokenCreated"), pool, joinTokenId: made.joinTokenId, token: made.token, expiresAt: made.expiresAt }); } },
    );
  };
  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
      <Body>
        <Header title={t("runners.join.newTokenTitle", { pool: pool.name })}>{t("runners.join.newTokenLede")}</Header>
        <fieldset disabled={busy} className="mt-6 space-y-5">
          <div>
            <FieldLabel htmlFor="token-label">{t("runners.join.label")}</FieldLabel>
            <Input id="token-label" autoFocus maxLength={100} autoComplete="off" className="font-mono text-body" placeholder={t("runners.joinToken")} value={label} onChange={(event) => { setLabel(event.target.value); }} />
          </div>
          <div>
            <FieldLabel>{t("runners.join.lasts")}</FieldLabel>
            <LifetimeRows idPrefix="token-life" lifetime={lifetime} onChange={(next) => { setLifetime(next); setInvalid(false); }} defaultDays={poolDays} disabled={busy} error={invalid ? t("runners.poolForm.daysInvalid") : null} />
          </div>
        </fieldset>
      </Body>
      <Footer>
        {create.error === null ? null : <p role="alert" className="mb-3 text-sm text-red">{errorText(create.error)}</p>}
        <div className="flex gap-3">
          <Button type="submit" variant="primary" size="lg" disabled={busy}>
            {busy ? <LoaderCircleIcon aria-hidden className="motion-safe:animate-spin" /> : null}
            {busy ? t("runners.join.creatingToken") : t("runners.join.createToken")}
          </Button>
          <Button type="button" size="lg" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
        </div>
      </Footer>
    </form>
  );
};

/** A teal copy button that reads `Copied` for 1.5s, or asks to copy by hand when the clipboard refuses. */
const CopyText = ({ text, label, onRefused, className }: { readonly text: string; readonly label: string; readonly onRefused: () => void; readonly className?: string }) => {
  const [state, setState] = useState<"idle" | "copied" | "refused">("idle");
  return (
    <button
      type="button"
      className={cn("inline-flex items-center gap-1.5 text-body hover:underline [&_svg]:size-[15px] [&_svg]:stroke-[1.75]", state === "refused" ? "text-muted" : "text-teal", className)}
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => {
            setState("copied");
            setTimeout(() => { setState("idle"); }, 1500);
          },
          () => {
            setState("refused");
            onRefused();
            setTimeout(() => { setState("idle"); }, 3000);
          },
        );
      }}
    >
      {state === "copied" ? <CheckIcon aria-hidden /> : state === "idle" ? <CopyIcon aria-hidden /> : null}
      {state === "copied" ? t("common.copied") : state === "refused" ? t("runners.join.copyYourself") : label}
    </button>
  );
};

const selectContents = (element: HTMLElement | null) => {
  if (element === null) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
};

/** The token, shown once, and the three ways to start a runner with it (pool-join.md). */
const ShownBody = ({ shown, settings, onClose, onOpenPool }: { readonly shown: Shown; readonly settings: FleetSettings; readonly onClose: () => void; readonly onOpenPool: (() => void) | null }) => {
  const [path, setPath] = useState<JoinPath>(firstJoinPath(shown.pool.executors));
  const [revoked, setRevoked] = useState(false);
  const tokenRef = useRef<HTMLDivElement>(null);
  const commandRef = useRef<HTMLPreElement>(null);
  const command = joinCommand(path, { serverUrl: settings.serverUrl, serverVersion: settings.serverVersion, executor: joinExecutor(shown.pool.executors) });
  const pathLabel = (id: JoinPath): string => {
    switch (id) {
      case "cli":
        return t("runners.join.tabCli");
      case "docker":
        return t("runners.join.tabDocker");
      case "helm":
        return t("runners.join.tabHelm");
      default:
        return id satisfies never;
    }
  };
  return (
    <>
      <Body>
        <Header title={shown.title}>
          {shown.pool.requiresApproval ? t("runners.join.ledeApprovalBefore") : t("runners.join.ledeOpenBefore")}
          <span className="font-mono text-text">{shown.pool.name}</span>
          {shown.pool.requiresApproval ? t("runners.join.ledeApprovalAfter") : t("runners.join.ledeOpenAfter")}
        </Header>
        <div className="mt-6">
          <FieldLabel>{t("runners.joinToken")}</FieldLabel>
          {revoked ? (
            <p className="rounded-lg border border-line-2 bg-surface px-3.5 py-2.5 text-ui text-faint">{t("runners.join.revokedJust")}</p>
          ) : (
            <>
              <div ref={tokenRef} data-testid="join-token" className="select-all break-all rounded-lg border border-line-2 bg-surface px-3.5 py-2.5 font-mono text-body text-text">
                {shown.token}
              </div>
              <CopyText className="mt-2" text={shown.token} label={t("runners.join.copyToken")} onRefused={() => { selectContents(tokenRef.current); }} />
            </>
          )}
          <p className="mt-3 flex items-start gap-2 text-sm text-muted">
            <ShieldIcon aria-hidden className="mt-0.5 size-[14px] shrink-0 stroke-[1.75]" />
            <span>{t("runners.join.anyone")}{shown.pool.requiresApproval ? "" : t("runners.join.turnOnApproval")}</span>
          </p>
          <p className="mt-2 text-[12.5px] text-faint">
            {shown.expiresAt === null ? t("runners.join.shownOnceNever") : t("runners.join.shownOnce", { date: longDate(shown.expiresAt) })}
          </p>
        </div>
        <div className="mt-5 border-t border-line pt-5">
          <FieldLabel>{t("runners.join.start")}</FieldLabel>
          <UnderlineTabs tabs={joinPaths.map((id) => ({ id, label: pathLabel(id) }))} selected={path} onSelect={setPath} label={t("runners.join.start")} idPrefix="join-path" />
          <div role="tabpanel" id={`join-path-panel-${path}`} aria-labelledby={`join-path-tab-${path}`} className="relative mt-4 rounded-lg border border-line-2 bg-surface">
            <pre ref={commandRef} data-testid="join-command" className="max-h-[260px] overflow-auto whitespace-pre py-2.5 pl-3.5 pr-[84px] font-mono text-ui leading-[1.6] text-text">{command}</pre>
            <CopyText className="absolute right-3 top-2.5" text={command} label={t("common.copy")} onRefused={() => { selectContents(commandRef.current); }} />
          </div>
          {path === "docker" ? (
            <p className="mt-2.5 flex items-start gap-2 text-[12.5px] text-faint">
              <InfoIcon aria-hidden className="mt-0.5 size-[14px] shrink-0 stroke-[1.75]" />
              {t("runners.join.dockerSocket")}
            </p>
          ) : null}
          <p className="mt-2.5 flex items-start gap-2 text-[12.5px] text-faint">
            <FileIcon aria-hidden className="mt-0.5 size-[14px] shrink-0 stroke-[1.75]" />
            <span>{path === "helm" ? t("runners.join.fileHelm") : t("runners.join.fileCommand")}</span>
          </p>
        </div>
        <div className="mt-5 border-t border-line pt-4">
          <JoinTokenList poolId={shown.pool.id} poolName={shown.pool.name} onRevoked={(joinTokenId) => { if (joinTokenId === shown.joinTokenId) setRevoked(true); }} />
        </div>
      </Body>
      <Footer>
        <div className="flex gap-3">
          <Button variant="primary" size="lg" className="min-w-[132px]" onClick={onClose}>{t("runners.join.done")}</Button>
          {onOpenPool === null ? null : <Button size="lg" onClick={onOpenPool}>{t("runners.join.openPool", { pool: shown.pool.name })}</Button>}
        </div>
      </Footer>
    </>
  );
};

/**
 * The sheet's content for `step`. Mount it inside a `Sheet` that the caller opens; `onClose` closes it.
 * Keyed by the caller on each opening, so a closed sheet keeps no token.
 */
export const PoolSheet = ({ step, settings, onClose, poolHref }: {
  readonly step: PoolSheetStep;
  readonly settings: FleetSettings;
  readonly onClose: () => void;
  /** Where `Open {pool}` goes, or `null` on the pool's own page. */
  readonly poolHref: ((poolId: string) => string) | null;
}) => {
  const router = useRouter();
  const [shown, setShown] = useState<Shown | null>(null);
  const title = shown !== null ? shown.title : step.kind === "new-pool" ? t("runners.newPoolTitle") : step.kind === "edit" ? t("runners.poolForm.editTitle", { pool: step.pool.name }) : t("runners.join.newTokenTitle", { pool: step.pool.name });
  return (
    <SheetContent title={title} closeButton={false} className="w-full border-line-2 bg-bg sm:w-[450px]" data-testid="pool-sheet">
      <Dialog.Close className="absolute right-5 top-5 grid size-7 place-items-center rounded-md text-faint hover:bg-sel hover:text-text" aria-label={t("common.close")}>
        <XIcon className="size-4 stroke-[1.75]" />
      </Dialog.Close>
      {shown !== null ? (
        <ShownBody shown={shown} settings={settings} onClose={onClose} onOpenPool={poolHref === null ? null : () => { onClose(); router.push(poolHref(shown.pool.id)); }} />
      ) : step.kind === "new-token" ? (
        <TokenForm pool={step.pool} settings={settings} onShown={setShown} onClose={onClose} />
      ) : (
        <PoolForm edit={step.kind === "edit" ? step.pool : null} settings={settings} onShown={setShown} onClose={onClose} />
      )}
    </SheetContent>
  );
};
