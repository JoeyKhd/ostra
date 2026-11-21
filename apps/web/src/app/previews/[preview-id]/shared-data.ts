import type { SharedPreviewPage } from "@ostra/api";
import { previewAccessIdSchema } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";

import { getServerApi } from "@/server/api";

// A preview's own page, for a member it names (milestone 8, F-142; `preview-viewer.md`, open point
// 2): `/previews/<the preview's level's ID>`, signed in. Its server side opens a view of that
// preview through `previews.shared.open`, which reads the member's access again (`previewAccess`),
// and gives the page only the preview's label and port, the organization's name and whether input
// is allowed: nothing else of the task. Anyone the preview doesn't name now, whatever the reason,
// gets the same `not-shared`.

/** What the page renders: the preview's state, or the way to sign in first. */
export type SharedPreviewData =
  | SharedPreviewPage
  | { readonly state: "signed-out" }
  /** An account with the seeded default password chooses a new one first (F-001). */
  | { readonly state: "password-change" };

export const loadSharedPreview = async (raw: string): Promise<SharedPreviewData> => {
  const { caller, signedIn } = await getServerApi();
  if (!signedIn) {
    return { state: "signed-out" };
  }
  const me = await caller.me.get();
  if (me.passwordChange === "required") {
    return { state: "password-change" };
  }
  const previewId = previewAccessIdSchema.safeParse(raw);
  if (!previewId.success) {
    return { state: "not-shared" };
  }
  try {
    return await caller.previews.shared.open({ previewId: previewId.data, viewport: null });
  } catch (error) {
    // An account with no membership here, or a session that ended meanwhile: nothing is shared with it.
    if (error instanceof TRPCError && (error.code === "FORBIDDEN" || error.code === "UNAUTHORIZED")) {
      return { state: "not-shared" };
    }
    throw error;
  }
};
