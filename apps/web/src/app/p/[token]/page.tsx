// From next/types, not "next": the root module also loads Next's globals (tsconfig.next.json).
import type { Metadata } from "next/types";
import { cache } from "react";

import { ViewerPage } from "@/components/previews/viewer-page";
import { t } from "@/lib/messages";

import { loadPreviewViewer } from "./viewer-data";

// A preview link's viewer page (milestone 8, F-142; preview-viewer.md): `/p/<token>`, outside the
// panel's group, so it loads none of its shell and needs no session. Its server side resolves the
// link and opens a view for it once per request (`loadPreviewViewer`, ticket 20); the page is the
// stream alone, the label, the organization's name, the mode and the expiry. `next.config.ts` sends
// it with `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`.

export const dynamic = "force-dynamic";

type Props = { readonly params: Promise<{ readonly token: string }> };

/** One open per request: the title and the page read the same answer. */
const load = cache(loadPreviewViewer);

export const generateMetadata = async ({ params }: Props): Promise<Metadata> => {
  const data = await load((await params).token);
  const robots = { index: false, follow: false };
  switch (data.state) {
    case "live":
    case "native":
    case "not-running":
      return {
        title: { absolute: t("previewViewer.title", { label: data.port === null ? data.label : `${data.label} :${String(data.port)}`, organization: data.organizationName }) },
        robots,
      };
    case "expired":
    case "revoked":
    case "not-allowed":
    case "runner-too-old":
    case "unknown":
    case "too-many-tries":
      return { title: { absolute: t("previewViewer.endedTitle") }, robots };
    default:
      return data satisfies never;
  }
};

const PreviewViewerRoute = async ({ params }: Props) => {
  const { token } = await params;
  return <ViewerPage source={{ kind: "link", token }} initial={await load(token)} />;
};

export default PreviewViewerRoute;
