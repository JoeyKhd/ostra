"use client";

import type { ProsePart } from "@ostra/task-view";

import { t } from "@/lib/messages";

import { AgentMarkdown, SafeLink } from "../renderers";

// Owner: ticket 09 (milestone 10, F-151: the agent's prose, parts.md part 3). The page itself: full
// width, 14.5px/1.6 `--text`, `.agent-md` as before (no raw HTML, safe links, no remote image),
// with no avatar, no name, no time and no status word. The run's line carries the time and the
// header the state.

export const Prose = ({ part }: { readonly part: ProsePart }) => {
  switch (part.type) {
    case "text":
      return <AgentMarkdown text={part.text} className="thread-prose" data-part="prose" streaming={part.state === "streaming"} />;
    case "file":
      // An image the agent made is shown only when it's inline data: never a remote request.
      return part.url.startsWith("data:image/") ? (
        <img data-part="prose-image" src={part.url} alt="" className="mb-1.5 mt-1 max-h-80 rounded-lg border border-line" />
      ) : (
        <p data-part="prose-image" className="mb-1.5 mt-1 text-sm text-faint">{t("task.imageRemote")}</p>
      );
    case "source-url":
      return (
        <p data-part="prose-source" className="mb-1.5 mt-1 text-sm">
          <SafeLink href={part.url}>{part.title ?? part.url}</SafeLink>
        </p>
      );
    default:
      return part satisfies never;
  }
};
