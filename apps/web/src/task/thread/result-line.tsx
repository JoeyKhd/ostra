"use client";

import { AppWindowIcon, FilePenLineIcon, GitCommitHorizontalIcon, LightbulbIcon, MessageSquareTextIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import type { TurnResult } from "@ostra/task-view";

import { t } from "@/lib/messages";

import { SafeLink } from "../renderers";
import { Segments } from "./segments";
import { resultWords } from "./words";
import type { PushContext } from "./words";

// Owner: ticket 14 (milestone 10, F-151: a result line, parts.md part 8). Ticket 09's stub, with its
// final props: what a turn made, after its prose, a 14px icon, one 14px `--faint` line with its
// subject `--text-2`. Ticket 14 opens a push in place and wires every action; the stub keeps
// milestone 8's `Show` for a preview and the review's own link.

type LineResult = Exclude<TurnResult, { kind: "pr" }>;

const iconOf = (result: LineResult): ReactNode => {
  switch (result.kind) {
    case "push":
      return <GitCommitHorizontalIcon />;
    case "review":
      return <MessageSquareTextIcon />;
    case "draft":
      return <FilePenLineIcon />;
    case "preview":
      return <AppWindowIcon />;
    case "memory":
      return <LightbulbIcon />;
    default:
      return result satisfies never;
  }
};

/** The action a stub can take without ticket 14: the preview's `Show`, the posted review's page. */
const actionOf = (result: LineResult, label: string): ReactNode => {
  switch (result.kind) {
    case "preview": {
      const { preview } = result;
      if (preview.port === null) return null;
      const query = new URLSearchParams({ pane: "preview", preview: `port-${String(preview.port)}`, ...(preview.path === null ? {} : { path: preview.path }) });
      return <Link href={`?${query.toString()}`} className="shrink-0 text-teal hover:underline" data-action="show-preview">{label}</Link>;
    }
    case "review": {
      const [post] = result.review.posted;
      return post === undefined ? null : <span className="shrink-0"><SafeLink href={post.url}>{label}</SafeLink></span>;
    }
    case "push":
    case "draft":
    case "memory":
      return null;
    default:
      return result satisfies never;
  }
};

export const ResultLine = ({ result, push }: { readonly result: LineResult; readonly push?: PushContext }) => {
  const words = resultWords(result, t, push);
  return (
    <div data-part="result" data-result={result.kind} className="my-1.5 flex min-h-7 items-center gap-2 whitespace-nowrap text-ui text-faint [&>svg]:size-[14px] [&>svg]:shrink-0 [&>svg]:stroke-[1.75]">
      {iconOf(result)}
      <span className="min-w-0 truncate"><Segments segments={words.words} mono="font-mono text-[13px]" /></span>
      {words.action === null ? null : actionOf(result, words.action.label)}
    </div>
  );
};
