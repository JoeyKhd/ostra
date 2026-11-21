import { previewAccessIdSchema } from "@ostra/protocol";
import { redirect } from "next/navigation";
// From next/types, not "next": the root module also loads Next's globals (tsconfig.next.json).
import type { Metadata } from "next/types";
import { cache } from "react";

import { ViewerPage } from "@/components/previews/viewer-page";
import { t } from "@/lib/messages";

import { loadSharedPreview } from "./shared-data";

// A preview's own page, for a member it names (milestone 8, F-142; `preview-viewer.md`, open point
// 2): the link's viewer layout, signed in, outside the panel's group, so it loads none of its shell:
// the stream alone, the preview's label, the organization's name and `Watch only`. The notice a
// person gets when they're named links here. Its access is read again on every open and heartbeat.

export const dynamic = "force-dynamic";

type Props = { readonly params: Promise<{ readonly "preview-id": string }> };

/** One open per request: the title and the page read the same answer. */
const load = cache(loadSharedPreview);

export const generateMetadata = async ({ params }: Props): Promise<Metadata> => {
  const data = await load((await params)["preview-id"]);
  const robots = { index: false, follow: false };
  switch (data.state) {
    case "live":
    case "not-running":
      return {
        title: { absolute: t("previewViewer.title", { label: data.port === null ? data.label : `${data.label} :${String(data.port)}`, organization: data.organizationName }) },
        robots,
      };
    case "runner-too-old":
    case "not-shared":
    case "signed-out":
    case "password-change":
      return { title: { absolute: t("previewViewer.sharedTitle") }, robots };
    default:
      return data satisfies never;
  }
};

const SharedPreviewRoute = async ({ params }: Props) => {
  const raw = (await params)["preview-id"];
  const data = await load(raw);
  const here = encodeURIComponent(`/previews/${raw}`);
  switch (data.state) {
    case "signed-out":
      redirect(`/sign-in?next=${here}`);
      break;
    case "password-change":
      redirect(`/change-password?next=${here}`);
      break;
    case "live":
    case "not-running":
    case "runner-too-old":
    case "not-shared": {
      const previewId = previewAccessIdSchema.safeParse(raw);
      // An ID that isn't one opens nothing, and the page never asks again.
      return <ViewerPage source={{ kind: "shared", previewId: previewId.success ? previewId.data : null }} initial={data} />;
    }
    default:
      return data satisfies never;
  }
};

export default SharedPreviewRoute;
