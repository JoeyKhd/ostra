import type { PreviewViewerPage } from "@ostra/api";
import { TRPCError } from "@trpc/server";

import { getServerApi } from "@/server/api";

// The viewer page's server side (milestone 8, ticket 20, F-142, ADR 0068): `/p/<token>`, which a
// signed-out person opens from a link. It resolves the link by its token's hash, checks its expiry,
// its revoke and the organization's switch, writes its first use once, and opens a view for it,
// through `previews.link.open`, the one procedure the page's server side calls. The page (ticket 21)
// gets the preview's label and port, the organization's name, the expiry and whether input is
// allowed, and nothing else of the task. The token never goes in a log line.

/** What the page renders: the link's state, or that this address tried too many tokens. */
export type PreviewViewerData = PreviewViewerPage | { readonly state: "too-many-tries" };

export const loadPreviewViewer = async (token: string): Promise<PreviewViewerData> => {
  const { caller } = await getServerApi();
  try {
    return await caller.previews.link.open({ token, viewport: null });
  } catch (error) {
    if (error instanceof TRPCError && error.code === "TOO_MANY_REQUESTS") {
      return { state: "too-many-tries" };
    }
    // A token too long to be one is the same as an unknown one.
    if (error instanceof TRPCError && error.code === "BAD_REQUEST") {
      return { state: "unknown" };
    }
    throw error;
  }
};
