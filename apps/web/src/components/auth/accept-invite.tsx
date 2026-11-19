"use client";

import { usernameSchema } from "@ostra/domain/accounts";
import { invitationIdSchema } from "@ostra/protocol";
import { useMutation } from "@tanstack/react-query";
import { CheckIcon, CircleAlertIcon, ClockIcon, Link2OffIcon, LoaderCircleIcon, LockIcon, MailIcon, UserCheckIcon, UserPlusIcon, UserXIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { ReactNode, SubmitEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { AuthMessage, StatusLine } from "./auth-message";
import { FormMessage } from "./form-message";
import { brokenRuleOf, ruleLineOf } from "./new-password";
import type { PasswordRule } from "./new-password";
import { PasswordInput } from "./password-input";
import { RuleLine } from "./rule-line";
import { signInFailureOf, signInFailureText } from "./sign-in-failure";
import type { SignInFailure } from "./sign-in-failure";
import { signUpByInvitation } from "./sign-up-by-invitation";

type Preview = RouterOutputs["invitations"]["preview"];
type Found = Exclude<Preview, { readonly state: "not-found" }>;

/** Who is signed in on this browser, if anyone: the address, and whether they already belong. */
export type InviteViewer = { readonly email: string; readonly member: boolean } | null;

const linkButton = "h-auto p-0 align-baseline text-[12px] leading-[18px] font-medium";

const Busy = ({ label }: { readonly label: string }) => (
  <>
    <LoaderCircleIcon strokeWidth={1.75} className="motion-safe:animate-spin" aria-hidden />
    {label}
  </>
);

const Strong = ({ children }: { readonly children: ReactNode }) => <span className="font-medium text-text">{children}</span>;

/** A link that can't be used (accept-invite.md, "A link that can't be used"): each one's message. */
export const UnusableInvitation = ({ preview }: { readonly preview: Preview | { readonly state: "too-many" | "failed" } }) => {
  const signIn = (
    <p>
      {t("acceptInvite.haveAccount")}
      <Link href="/sign-in" className="font-medium text-teal hover:underline">{t("acceptInvite.signIn")}</Link>
    </p>
  );
  switch (preview.state) {
    case "expired":
      return <AuthMessage icon={ClockIcon} title={t("acceptInvite.expiredTitle")} help={signIn}>{t("acceptInvite.expiredLede", { days: preview.days, inviter: preview.inviterName })}</AuthMessage>;
    case "revoked":
      return <AuthMessage icon={Link2OffIcon} title={t("acceptInvite.revokedTitle")} help={signIn}>{t("acceptInvite.revokedLede", { organization: preview.organizationName, inviter: preview.inviterName })}</AuthMessage>;
    case "accepted":
      return <AuthMessage icon={UserCheckIcon} title={t("acceptInvite.usedTitle")} help={signIn}>{t("acceptInvite.usedLede", { organization: preview.organizationName })}</AuthMessage>;
    case "not-found":
      return <AuthMessage icon={Link2OffIcon} title={t("acceptInvite.unknownTitle")} help={signIn}>{t("acceptInvite.unknownLede")}</AuthMessage>;
    case "too-many":
      return <AuthMessage icon={ClockIcon} title={t("acceptInvite.tooManyTitle")}>{t("acceptInvite.tooManyLede")}</AuthMessage>;
    case "failed":
      return <AuthMessage icon={CircleAlertIcon} title={t("acceptInvite.failedTitle")}>{t("acceptInvite.failedLede")}</AuthMessage>;
    case "pending":
      return null;
    default:
      return preview satisfies never;
  }
};

/** "Check your inbox": the membership waits on the address check (ADR 0053). */
const Inbox = ({ preview, expired }: { readonly preview: Found; readonly expired: boolean }) => {
  const [sending, setSending] = useState<"idle" | "sending" | "sent" | "wait">("idle");
  const send = async () => {
    setSending("sending");
    try {
      const result = await authClient.sendVerificationEmail({ email: preview.email, callbackURL: `${window.location.pathname}?verified=1` });
      setSending(result.error === null ? "sent" : result.error.status === 429 ? "wait" : "idle");
    } catch {
      setSending("idle");
    }
  };
  useEffect(() => {
    if (sending !== "sent") return;
    const timer = setTimeout(() => { setSending("idle"); }, 60_000);
    return () => { clearTimeout(timer); };
  }, [sending]);
  return (
    <AuthMessage
      icon={MailIcon}
      title={t("acceptInvite.inboxTitle")}
      help={
        <>
          {sending === "sent" ? (
            <StatusLine icon={<CheckIcon className="size-[13px]" strokeWidth={1.75} aria-hidden />}>{t("acceptInvite.sentAgain")}</StatusLine>
          ) : sending === "wait" ? (
            <StatusLine>{t("acceptInvite.waitMinute")}</StatusLine>
          ) : (
            <p>
              {t("acceptInvite.didntGet")}
              <Button type="button" variant="link" className={linkButton} disabled={sending === "sending"} onClick={() => void send()}>
                {sending === "sending" ? t("acceptInvite.sending") : t("acceptInvite.sendAgain")}
              </Button>
            </p>
          )}
          <p>{t("acceptInvite.wrongAddress", { inviter: preview.inviterName })}</p>
        </>
      }
    >
      {expired ? (
        t("acceptInvite.inboxExpired", { organization: preview.organizationName })
      ) : (
        <>
          {t("acceptInvite.inboxBefore")}
          <Strong>{preview.email}</Strong>
          {t("acceptInvite.inboxAfter", { organization: preview.organizationName })}
        </>
      )}
    </AuthMessage>
  );
};

type Mode = { readonly kind: "sign-up" } | { readonly kind: "sign-in"; readonly addressInUse: boolean } | { readonly kind: "inbox" } | { readonly kind: "mismatch"; readonly current: string };

/**
 * The page an invitation link opens (F-002, accept-invite.md): sign up with the invited address,
 * or sign in to accept; "Check your inbox" while the address waits on its check; and a message for
 * each link that can't be used.
 */
export const AcceptInvite = ({
  invitationId,
  preview,
  viewer,
  emailOn,
  verificationFailed,
}: {
  readonly invitationId: string;
  readonly preview: Found;
  readonly viewer: InviteViewer;
  readonly emailOn: boolean;
  readonly verificationFailed: boolean;
}) => {
  const router = useRouter();
  const trpc = useTRPC();
  const accept = useMutation(trpc.invitations.accept.mutationOptions());
  const [mode, setMode] = useState<Mode>(preview.verificationPending ? { kind: "inbox" } : { kind: "sign-up" });
  const [email, setEmail] = useState(preview.email);
  const [username, setUsername] = useState("");
  const [identifier, setIdentifier] = useState(preview.addressLocked ? preview.email : "");
  const [password, setPassword] = useState("");
  const [usernameError, setUsernameError] = useState<"rule" | "taken" | null>(null);
  const [flagged, setFlagged] = useState<PasswordRule | null>(null);
  const [failure, setFailure] = useState<{ readonly kind: "unknown" } | { readonly kind: "sign-in"; readonly failure: SignInFailure } | null>(null);
  const [busy, setBusy] = useState(false);
  const [unusable, setUnusable] = useState<Preview | null>(null);

  const organization = preview.organizationName;
  const lockedAddress = preview.addressLocked;
  const goHome = () => {
    router.replace("/");
    router.refresh();
  };

  if (unusable !== null) return <UnusableInvitation preview={unusable} />;
  if (mode.kind === "inbox") return <Inbox preview={preview} expired={verificationFailed} />;

  const signOut = async () => {
    await authClient.signOut();
    router.refresh();
    setMode({ kind: "sign-in", addressInUse: false });
  };

  if (mode.kind === "mismatch") {
    return (
      <AuthMessage
        icon={UserXIcon}
        title={t("acceptInvite.mismatchTitle", { address: preview.email })}
        action={<Button variant="primary" size="xl" className="w-full" onClick={() => void signOut()}>{t("acceptInvite.signOut")}</Button>}
      >
        {t("acceptInvite.mismatchLede", { current: mode.current })}
      </AuthMessage>
    );
  }

  /** Accepting as the signed-in account (an existing account joins without a second one). */
  const acceptAsViewer = async (address: string) => {
    if (emailOn && address.toLowerCase() !== preview.email.toLowerCase()) {
      setMode({ kind: "mismatch", current: address });
      return;
    }
    setBusy(true);
    try {
      await accept.mutateAsync({ invitationId: invitationIdSchema.parse(invitationId) });
      goHome();
    } catch {
      setBusy(false);
      setFailure({ kind: "unknown" });
    }
  };

  if (viewer !== null) {
    if (viewer.member) {
      return (
        <AuthMessage
          icon={CheckIcon}
          title={t("acceptInvite.alreadyTitle", { organization })}
          action={<Button variant="primary" size="xl" className="w-full" onClick={goHome}>{t("acceptInvite.open", { organization })}</Button>}
        >
          {null}
        </AuthMessage>
      );
    }
    if (emailOn && viewer.email.toLowerCase() !== preview.email.toLowerCase()) {
      return (
        <AuthMessage
          icon={UserXIcon}
          title={t("acceptInvite.mismatchTitle", { address: preview.email })}
          action={<Button variant="primary" size="xl" className="w-full" onClick={() => void signOut()}>{t("acceptInvite.signOut")}</Button>}
        >
          {t("acceptInvite.mismatchLede", { current: viewer.email })}
        </AuthMessage>
      );
    }
    return (
      <AuthMessage
        icon={UserPlusIcon}
        title={t("acceptInvite.title", { organization })}
        action={
          <>
            <Button variant="primary" size="xl" className="w-full" disabled={busy} onClick={() => void acceptAsViewer(viewer.email)}>
              {busy ? <Busy label={t("acceptInvite.joining")} /> : t("acceptInvite.join", { organization })}
            </Button>
            {failure === null ? null : <FormMessage id="accept-message">{t("errors.unknown")}</FormMessage>}
            <p className="mt-[16px] text-[12px] leading-[18px] text-faint">
              {t("acceptInvite.notYou")}
              <Button type="button" variant="link" className={linkButton} onClick={() => void signOut()}>{t("acceptInvite.signOut")}</Button>
            </p>
          </>
        }
      >
        {t("acceptInvite.signedInLede", { inviter: preview.inviterName, role: preview.role === "admin" ? t("acceptInvite.roleAdmin") : t("acceptInvite.roleMember"), address: viewer.email })}
      </AuthMessage>
    );
  }

  const usernameValid = usernameSchema.safeParse(username).success;
  const rule = ruleLineOf(password, flagged);
  const title = (
    <h1 className="page-title truncate text-text" title={t("acceptInvite.title", { organization })}>
      {t("acceptInvite.title", { organization })}
    </h1>
  );

  const signUp = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!usernameValid) {
      setUsernameError("rule");
      return;
    }
    const broken = brokenRuleOf(password);
    if (broken !== null) {
      setFlagged(broken);
      return;
    }
    setBusy(true);
    setFailure(null);
    const outcome = await signUpByInvitation({ invitationId, email: lockedAddress ? preview.email : email.trim(), username, password });
    setBusy(false);
    switch (outcome.kind) {
      case "joined":
        goHome();
        return;
      case "verify":
        setMode({ kind: "inbox" });
        return;
      case "username-taken":
        setUsernameError("taken");
        document.getElementById("invite-username")?.focus();
        return;
      case "address-in-use":
        setMode({ kind: "sign-in", addressInUse: true });
        setIdentifier(preview.email);
        setPassword("");
        return;
      case "password":
        setFlagged(outcome.rule);
        return;
      case "unusable":
        setUnusable(outcome.preview);
        return;
      case "unknown":
        setFailure({ kind: "unknown" });
        return;
      default:
        outcome satisfies never;
    }
  };

  const signInAndJoin = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy || identifier === "" || password === "") return;
    setBusy(true);
    setFailure(null);
    const name = identifier.trim();
    let status = 0;
    try {
      const result = name.includes("@")
        ? await authClient.signIn.email({ email: name, password })
        : await authClient.signIn.username({ username: name.toLowerCase(), password });
      status = result.error === null ? 200 : result.error.status;
      if (result.error === null) {
        const session = await authClient.getSession();
        await acceptAsViewer(session.data?.user.email ?? name);
        return;
      }
    } catch {
      status = 0;
    }
    setBusy(false);
    setFailure({ kind: "sign-in", failure: signInFailureOf(status) });
  };

  if (mode.kind === "sign-in") {
    const invalid = failure?.kind === "sign-in" && failure.failure === "credentials";
    return (
      <div>
        {title}
        {mode.addressInUse ? (
          <div className="mt-[6px]"><StatusLine>{t("acceptInvite.addressInUse", { address: preview.email })}</StatusLine></div>
        ) : (
          <p className="mt-[6px] text-lede text-muted">{t("acceptInvite.signInLede", { inviter: preview.inviterName, organization })}</p>
        )}
        <form onSubmit={(event) => void signInAndJoin(event)} noValidate className="mt-[28px]">
          <Label className="mb-[3px]" htmlFor="invite-identifier">{t("acceptInvite.identifier")}</Label>
          <Input id="invite-identifier" autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus readOnly={busy} aria-invalid={invalid} className="h-[36px] px-[10px]" value={identifier} onChange={(event) => { setIdentifier(event.target.value); setFailure(null); }} />
          <Label className="mb-[3px] mt-[14px]" htmlFor="invite-password">{t("acceptInvite.password")}</Label>
          <PasswordInput id="invite-password" autoComplete="current-password" readOnly={busy} aria-invalid={invalid} value={password} onChange={(event) => { setPassword(event.target.value); setFailure(null); }} />
          {failure === null ? null : <FormMessage id="invite-message">{failure.kind === "sign-in" ? signInFailureText(failure.failure) : t("errors.unknown")}</FormMessage>}
          <Button type="submit" variant="primary" size="xl" className="mt-[20px] w-full" disabled={busy || identifier === "" || password === ""}>
            {busy ? <Busy label={t("acceptInvite.signingIn")} /> : t("acceptInvite.signInJoin")}
          </Button>
          <p className="mt-[16px] text-[12px] leading-[18px] text-faint">
            {t("acceptInvite.newToOstra")}
            <Button type="button" variant="link" className={linkButton} onClick={() => { setMode({ kind: "sign-up" }); setPassword(""); setFailure(null); }}>{t("acceptInvite.createAccount")}</Button>
          </p>
          {emailOn ? (
            <p className="mt-[8px] text-[12px] leading-[18px]"><Link href="/reset" className="font-medium text-teal hover:underline">{t("signIn.forgot")}</Link></p>
          ) : null}
        </form>
      </div>
    );
  }

  return (
    <div>
      {title}
      <p className="mt-[6px] text-lede text-muted">
        {t("acceptInvite.ledeBefore", { inviter: preview.inviterName })}
        <Strong>{organization}</Strong>
        {preview.role === "admin" ? t("acceptInvite.ledeAdmin") : t("acceptInvite.ledeMember")}
      </p>
      <form onSubmit={(event) => void signUp(event)} noValidate className="mt-[28px]">
        <Label className="mb-[3px]" htmlFor="invite-email">{t("acceptInvite.email")}</Label>
        {lockedAddress ? (
          <div className="relative">
            <Input id="invite-email" readOnly aria-readonly autoComplete="email" value={preview.email} className="h-[36px] border-line bg-transparent pl-[10px] pr-[32px] text-muted focus-visible:border-line" />
            <LockIcon aria-hidden className="absolute right-[12px] top-1/2 size-[13px] -translate-y-1/2 text-faint" strokeWidth={1.75} />
          </div>
        ) : (
          <Input id="invite-email" type="email" autoComplete="email" readOnly={busy} value={email} className="h-[36px] px-[10px]" onChange={(event) => { setEmail(event.target.value); }} />
        )}
        <Label className="mb-[3px] mt-[14px]" htmlFor="invite-username">{t("acceptInvite.username")}</Label>
        <Input
          id="invite-username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          readOnly={busy}
          aria-invalid={usernameError !== null}
          aria-describedby={usernameError === null ? undefined : "invite-username-error"}
          className="h-[36px] px-[10px]"
          value={username}
          onChange={(event) => { setUsername(event.target.value.toLowerCase()); setUsernameError(null); }}
          onBlur={() => { if (username !== "" && !usernameSchema.safeParse(username).success) setUsernameError("rule"); }}
        />
        {usernameError === null ? null : (
          <FormMessage id="invite-username-error">{usernameError === "taken" ? t("acceptInvite.usernameTaken") : t("acceptInvite.usernameRule")}</FormMessage>
        )}
        <Label className="mb-[3px] mt-[14px]" htmlFor="invite-new-password">{t("acceptInvite.password")}</Label>
        <PasswordInput
          id="invite-new-password"
          autoComplete="new-password"
          readOnly={busy}
          aria-invalid={rule.tone === "error"}
          aria-describedby="invite-rule"
          value={password}
          onChange={(event) => { setPassword(event.target.value); setFlagged(null); }}
          onBlur={() => { if (password !== "" && brokenRuleOf(password) === "min") setFlagged("min"); }}
        />
        <RuleLine id="invite-rule" rule={rule} />
        {failure === null ? null : <FormMessage id="invite-message">{t("errors.unknown")}</FormMessage>}
        <Button type="submit" variant="primary" size="xl" className="mt-[20px] w-full" disabled={busy || !usernameValid || brokenRuleOf(password) !== null}>
          {busy ? <Busy label={t("acceptInvite.joining")} /> : t("acceptInvite.join", { organization })}
        </Button>
        <p className="mt-[16px] text-[12px] leading-[18px] text-faint">
          {t("acceptInvite.haveAccount")}
          <Button type="button" variant="link" className={linkButton} onClick={() => { setMode({ kind: "sign-in", addressInUse: false }); setPassword(""); setFailure(null); }}>{t("acceptInvite.signInToAccept")}</Button>
        </p>
      </form>
    </div>
  );
};
