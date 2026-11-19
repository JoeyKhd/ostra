import { TRPCError } from "@trpc/server";

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
          verificationFailed={typeof query["error"] === "string"}
        />
      ) : (
        <UnusableInvitation preview={preview} />
      )}
    </AuthFrame>
  );
};

export default InvitePage;
