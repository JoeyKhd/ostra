import { TRPCError } from "@trpc/server";
import { redirect } from "next/navigation";

import { AcceptInvite, UnusableInvitation } from "@/components/auth/accept-invite";
import type { InviteViewer } from "@/components/auth/accept-invite";
import { AuthFrame } from "@/components/auth/auth-frame";
import { t } from "@/lib/messages";
import { getServerApi } from "@/server/api";

// The invitation's ID is the secret (ADR 0053): never indexed, never sent on as a Referer.
export const metadata = { title: t("acceptInvite.signInToAccept"), robots: { index: false, follow: false }, referrer: "no-referrer" };

type Props = {
  readonly params: Promise<{ readonly "invitation-id": string }>;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
};

/** `/invite/[invitation-id]` (F-002, accept-invite.md): outside the panel, in the sign-in frame. */
const InvitePage = async ({ params, searchParams }: Props) => {
  const { "invitation-id": invitationId } = await params;
  const query = await searchParams;
  const { caller, signedIn } = await getServerApi();
  // The verification mail's link (`?verify=<token>`, ADR 0053): the address is proven, and the
  // membership waiting on it is active. Signed in (the sign-up's browser), Home; otherwise sign in.
  const verifyToken = query["verify"];
  let verificationFailed = typeof query["error"] === "string";
  if (typeof verifyToken === "string" && verifyToken !== "") {
    const verified = await caller.invitations.verify({ invitationId, token: verifyToken }).catch(() => ({ state: "invalid" as const }));
    if (verified.state === "verified") redirect(signedIn ? "/" : "/sign-in");
    verificationFailed = true;
  }
  const [preview, email] = await Promise.all([
    caller.invitations.preview({ invitationId }).catch((error: unknown) =>
      error instanceof TRPCError && error.code === "TOO_MANY_REQUESTS" ? ({ state: "too-many" } as const) : ({ state: "failed" } as const),
    ),
    caller.email.on(),
  ]);
  let viewer: InviteViewer = null;
  if (signedIn) {
    const me = await caller.me.get();
    viewer = { email: me.email, member: me.organization !== null };
  }
  // A used invitation whose account still waits on its address check shows "Check your inbox".
  const usable = preview.state === "pending" || (preview.state === "accepted" && preview.verificationPending);
  return (
    <AuthFrame>
      {usable ? (
        <AcceptInvite
          invitationId={invitationId}
          preview={preview}
          viewer={viewer}
          emailOn={email.on}
          verificationFailed={verificationFailed}
        />
      ) : (
        <UnusableInvitation preview={preview} />
      )}
    </AuthFrame>
  );
};

export default InvitePage;
