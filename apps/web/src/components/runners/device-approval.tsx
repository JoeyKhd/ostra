"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRightIcon, CircleAlertIcon, CircleCheckIcon, CircleXIcon, KeyRoundIcon, ServerIcon, ShieldOffIcon, SquareTerminalIcon, UserIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ReactNode, SubmitEvent } from "react";

import { PageFrame, PageHeading, PropGroup, PropRow, Section } from "@/components/shell/page-frame";
import { initials } from "@/components/shell/user-menu";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NeedsYou } from "@/components/ui/needs-you";
import { Skeleton } from "@/components/ui/skeleton";
import { Status } from "@/components/ui/status";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { formatUserCode, normalizeUserCode } from "./device-code";

/** What the server said about the request: the runner's client and scope, when it returns them. */
type Request = { readonly code: string; readonly clientId: string | null; readonly scope: string | null };

type Step =
  | { readonly kind: "enter"; readonly error: "unknown" | "used" | null }
  | { readonly kind: "checking"; readonly code: string; readonly fromLink: boolean }
  | { readonly kind: "confirm"; readonly request: Request; readonly deciding: "approve" | "deny" | null; readonly failed: boolean }
  | { readonly kind: "approved"; readonly request: Request }
  | { readonly kind: "denied"; readonly request: Request };

const RUNNER_CLIENT_ID = "ostra-runner";

/**
 * What the code signs in (F-103, spec section 12's `m1/device`): a personal runner (`ostra runner`)
 * or a member's CLI session (`ostra login`) on the named machine. The page's words follow it.
 */
type Purpose = { readonly kind: "runner" } | { readonly kind: "cli"; readonly machine: string };

const field = (data: unknown, name: string): string | null => {
  const value: unknown = typeof data === "object" && data !== null ? Reflect.get(data, name) : undefined;
  return typeof value === "string" && value !== "" ? value : null;
};

/** Text with the command (`ostra runner`, or `ostra login`) set in Plex Mono, wherever the message puts it. */
const withCommand = (text: string, command: string = t("device.command")): ReactNode => {
  const [before = "", ...rest] = text.split(command);
  if (rest.length === 0) return text;
  return (
    <>
      {before}
      <code className="font-mono text-ui">{command}</code>
      {rest.join(command)}
    </>
  );
};

const Problem = ({ children }: { readonly children: ReactNode }) => (
  <p role="alert" className="mt-1.5 flex items-start gap-1.5 text-sm text-red">
    <CircleAlertIcon aria-hidden className="mt-[3px] size-[13px] shrink-0 stroke-[1.75]" />
    <span>{children}</span>
  </p>
);

/** The code as the runner printed it, 28px mono, in a 64px box (device.md). */
const CodeBox = ({ code }: { readonly code: string }) => (
  <div className="mt-[22px]">
    <div className="mb-1.5 text-sm font-medium text-muted">{t("device.code")}</div>
    <div className="flex h-16 items-center rounded-lg border border-line bg-surface px-5">
      <span className="select-text font-mono text-[31px] font-medium tracking-[0.18em] text-text" data-testid="device-code">
        {formatUserCode(code)}
      </span>
    </div>
  </div>
);

const Does = ({ organization, purpose }: { readonly organization: string; readonly purpose: Purpose }) => (
  <Section title={t("device.does")}>
    <ul className="rows [&_svg]:size-[15px] [&_svg]:shrink-0 [&_svg]:stroke-[1.75] [&_svg]:text-muted" data-purpose={purpose.kind}>
      {purpose.kind === "cli" ? (
        <>
          <li className="flex min-h-[38px] items-center gap-3 py-2">
            <SquareTerminalIcon aria-hidden />
            {t("device.cli.doesSignIn", { machine: purpose.machine })}
          </li>
          <li className="flex min-h-[38px] items-center gap-3 py-2">
            <UserIcon aria-hidden />
            {t("device.cli.doesActsAsYou")}
          </li>
          <li className="flex min-h-[38px] items-center gap-3 py-2">
            <KeyRoundIcon aria-hidden />
            {t("device.cli.doesRevoke")}
          </li>
        </>
      ) : (
        <>
          <li className="flex min-h-[38px] items-center gap-3 py-2">
            <ServerIcon aria-hidden />
            {t("device.doesPersonal", { organization })}
          </li>
          <li className="flex min-h-[38px] items-center gap-3 py-2">
            <UserIcon aria-hidden />
            {t("device.doesOwnTasks")}
          </li>
          <li className="flex min-h-[38px] items-center gap-3 py-2">
            <ShieldOffIcon aria-hidden />
            {t("device.notIsolated")}
          </li>
        </>
      )}
    </ul>
  </Section>
);

const Outcome = ({ approved, purpose }: { readonly approved: boolean; readonly purpose: Purpose }) => {
  const cli = purpose.kind === "cli";
  const said = cli ? (approved ? t("device.cli.approved") : t("device.cli.denied")) : approved ? t("device.approved") : t("device.denied");
  const next = cli ? (approved ? t("device.cli.openAccount") : t("device.cli.backToAccount")) : approved ? t("device.openRunners") : t("device.backToRunners");
  return (
    <div className="mt-6" role="status">
      <p className="flex items-center gap-2.5">
        {approved ? <CircleCheckIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-green" /> : <CircleXIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-muted" />}
        <span>{said}</span>
      </p>
      <Link href={cli ? "/account" : "/organization/runners"} className={cn(buttonVariants({ variant: "link" }), "mt-2.5 ml-[25px] text-sm")}>
        {next}
        {approved ? <ArrowRightIcon aria-hidden className="size-3" /> : null}
      </Link>
    </div>
  );
};

/**
 * The device approval page (`/device`, F-014, ADR 0029, device.md): the member enters or confirms
 * the code `ostra runner` printed, sees what approving does, and decides. The runner then trades
 * the device session for its own key pair, and core registers it as the member's personal runner
 * in their active organization. A personal runner always runs the agent as a process (`host`).
 */
export const DeviceApproval = () => {
  const trpc = useTRPC();
  const me = useQuery(trpc.me.get.queryOptions());
  const params = useSearchParams();
  const fromLink = normalizeUserCode(params.get("user_code") ?? "");
  const [code, setCode] = useState(fromLink);
  const [step, setStep] = useState<Step>(fromLink === "" ? { kind: "enter", error: null } : { kind: "checking", code: fromLink, fromLink: true });
  const input = useRef<HTMLInputElement>(null);
  const deny = useRef<HTMLButtonElement>(null);
  const organization = me.data?.organization?.name ?? "";

  const check = async (userCode: string) => {
    const result = await authClient.device({ query: { user_code: userCode } });
    if (result.error !== null) {
      setStep({ kind: "enter", error: "unknown" });
      return;
    }
    if (result.data.status !== "pending") {
      setStep({ kind: "enter", error: "used" });
      return;
    }
    setStep({ kind: "confirm", request: { code: userCode, clientId: field(result.data, "client_id"), scope: field(result.data, "scope") }, deciding: null, failed: false });
  };

  // A link with the code in it lands on Confirm without a click (device.md, state 2).
  useEffect(() => {
    // Once, for the code the page was opened with.
    if (fromLink !== "") void check(fromLink);
  }, []);

  // Each state change moves focus to its first action: the input, or Deny (never Approve, so a
  // stray Enter can't approve).
  const focusOn = step.kind === "enter" ? "input" : step.kind === "confirm" && step.deciding === null ? "deny" : null;
  useEffect(() => {
    if (focusOn === "input") input.current?.focus();
    if (focusOn === "deny") deny.current?.focus();
  }, [focusOn, step]);

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const userCode = normalizeUserCode(code);
    setStep({ kind: "checking", code: userCode, fromLink: false });
    void check(userCode);
  };

  const decide = async (request: Request, approve: boolean) => {
    setStep({ kind: "confirm", request, deciding: approve ? "approve" : "deny", failed: false });
    const result = approve ? await authClient.device.approve({ userCode: request.code }) : await authClient.device.deny({ userCode: request.code });
    if (result.error !== null) {
      setStep({ kind: "confirm", request, deciding: null, failed: true });
      return;
    }
    setStep({ kind: approve ? "approved" : "denied", request });
  };

  const request = step.kind === "confirm" || step.kind === "approved" || step.kind === "denied" ? step.request : null;
  const showCode = step.kind === "checking" && step.fromLink ? step.code : request?.code ?? null;
  // The verify step above claimed the code for this member, so the server tells its purpose now.
  const asked = useQuery({ ...trpc.account.deviceRequest.queryOptions({ userCode: request?.code ?? "----" }), enabled: request !== null, staleTime: Number.POSITIVE_INFINITY });
  const purpose: Purpose | null =
    request === null || asked.isPending ? null : asked.data?.purpose === "cli" ? { kind: "cli", machine: asked.data.machineName ?? t("device.cli.unnamed") } : { kind: "runner" };
  const cli = purpose?.kind === "cli";

  const status =
    step.kind === "approved" ? (
      <Status tone="green">{t("device.status.approved")}</Status>
    ) : step.kind === "denied" ? (
      <Status tone="grey">{t("device.status.denied")}</Status>
    ) : (
      <Status tone="amber">{t("device.status.waiting")}</Status>
    );

  const properties = (
    <>
      {request === null ? null : (
        <>
          <PropGroup title={t("device.props.request")}>
            <PropRow label={t("device.props.status")}>{status}</PropRow>
            <PropRow label={t("device.props.client")}>{cli ? t("device.cli.client") : request.clientId === RUNNER_CLIENT_ID || request.clientId === null ? t("device.runnerClient") : request.clientId}</PropRow>
            {request.scope === null ? null : (
              <PropRow label={t("device.props.scope")}>
                <span className="font-mono">{request.scope}</span>
              </PropRow>
            )}
          </PropGroup>
          <PropGroup title={t("device.props.machine")}>
            {purpose?.kind === "cli" ? (
              <PropRow label={t("device.cli.machineName")}>
                <span className="truncate font-mono">{purpose.machine}</span>
              </PropRow>
            ) : (
              <PropRow label={t("device.props.executor")}>
                <span className="font-mono">host</span>
              </PropRow>
            )}
          </PropGroup>
        </>
      )}
      <PropGroup title={t("device.props.signsInAs")}>
        <PropRow label={t("device.props.member")}>
          <span aria-hidden className="inline-grid size-[18px] shrink-0 place-items-center rounded-full bg-line-2 text-[10px] font-semibold text-text">
            {initials(me.data?.name ?? "")}
          </span>
          <span className="truncate">{me.data?.name ?? "–"}</span>
        </PropRow>
        <PropRow label={t("device.props.organization")}>{organization === "" ? "–" : organization}</PropRow>
      </PropGroup>
    </>
  );

  return (
    <PageFrame
      crumbs={
        cli
          ? [{ label: organization }, { label: t("device.cli.crumb"), href: "/account" }, { label: t("device.cli.title") }]
          : [{ label: organization }, { label: t("shell.runners"), href: "/organization/runners" }, { label: t("device.title") }]
      }
      properties={properties}
    >
      <div className="max-w-[640px]">
        <PageHeading
          eyebrow={cli ? t("device.cli.eyebrow") : t("device.eyebrow")}
          title={cli ? t("device.cli.title") : t("device.title")}
          lede={withCommand(showCode === null ? t("device.lede") : t("device.ledeConfirm"))}
        />
        {showCode === null ? (
          <form onSubmit={submit} noValidate className="mt-[22px] max-w-[320px]">
            <Label htmlFor="user-code">{t("device.code")}</Label>
            <Input
              id="user-code"
              ref={input}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              aria-invalid={step.kind === "enter" && step.error !== null}
              aria-describedby="user-code-help"
              className="h-10 font-mono text-[22px] uppercase tracking-[0.2em] placeholder:tracking-[0.2em]"
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
              }}
              placeholder="ABCD-EFGH"
            />
            {step.kind === "enter" && step.error !== null ? (
              <Problem>{withCommand(step.error === "unknown" ? t("device.unknownCode") : t("device.notPending"))}</Problem>
            ) : (
              <p id="user-code-help" className="mt-1.5 text-sm text-faint">
                {t("device.codeHelp")}
              </p>
            )}
            <Button type="submit" variant="primary" className="mt-4" disabled={step.kind === "checking" || normalizeUserCode(code) === ""}>
              {step.kind === "checking" ? t("device.checking") : t("device.continue")}
            </Button>
          </form>
        ) : (
          <div data-testid="device-confirm">
            <CodeBox code={showCode} />
            {step.kind === "confirm" ? (
              <Button
                variant="link"
                className="mt-2 text-sm"
                onClick={() => {
                  setCode("");
                  setStep({ kind: "enter", error: null });
                }}
              >
                {t("device.otherCode")}
              </Button>
            ) : null}
            {request === null || purpose === null ? (
              <div className="mt-[26px] space-y-2.5" aria-busy>
                <Skeleton className="h-3 w-[180px]" />
                <Skeleton className="h-3 w-[420px] max-w-full" />
              </div>
            ) : (
              <>
                <Does organization={organization} purpose={purpose} />
                {step.kind === "confirm" ? (
                  <NeedsYou
                    className="mt-6 pl-4"
                    title={t("device.needsYou")}
                    actions={
                      <>
                        <Button ref={deny} disabled={step.deciding !== null} onClick={() => void decide(step.request, false)}>
                          {step.deciding === "deny" ? t("device.denying") : t("device.deny")}
                        </Button>
                        <Button variant="amber" disabled={step.deciding !== null} onClick={() => void decide(step.request, true)}>
                          {step.deciding === "approve" ? t("device.approving") : cli ? t("device.cli.approve") : t("device.approve")}
                        </Button>
                      </>
                    }
                    {...(step.failed ? { footer: <Problem>{t("device.failed")}</Problem> } : {})}
                  >
                    {cli
                      ? withCommand(t("device.approveOnly", { command: t("device.cli.command") }), t("device.cli.command"))
                      : withCommand(t("device.approveOnly", { command: t("device.command") }))}
                  </NeedsYou>
                ) : (
                  <Outcome approved={step.kind === "approved"} purpose={purpose} />
                )}
              </>
            )}
          </div>
        )}
      </div>
    </PageFrame>
  );
};
