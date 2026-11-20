"use client";

import { BookAIcon, GavelIcon, PinIcon, RulerIcon, TerminalIcon, ThumbsUpIcon, TriangleAlertIcon } from "lucide-react";
import { Fragment } from "react";
import type { ReactNode } from "react";

import type { MemoryKind } from "@ostra/protocol";

import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { kindWord } from "./memory-words";

// The small parts Memory's three pages share: a kind's icon, the Always chip, and a note's body as
// untrusted text with one markup (backticks become a code chip; no links, no HTML).

const KIND_ICONS = {
  convention: RulerIcon,
  command: TerminalIcon,
  gotcha: TriangleAlertIcon,
  decision: GavelIcon,
  preference: ThumbsUpIcon,
  term: BookAIcon,
} as const satisfies Record<MemoryKind, unknown>;

export const KindIcon = ({ kind, className }: { readonly kind: MemoryKind; readonly className?: string }) => {
  const Icon = KIND_ICONS[kind];
  return <Icon aria-label={kindWord(kind)} role="img" className={cn("size-4 shrink-0 stroke-[1.75] text-muted", className)} />;
};

export const AlwaysChip = () => (
  <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[6px] border border-line-2 px-2 text-sm text-muted" data-testid="always-chip">
    <PinIcon aria-hidden className="size-[13px] stroke-[1.75]" />
    {t("memory.always")}
  </span>
);

/** A note's body: text, with `backticks` as inline code chips. Line breaks kept. */
export const NoteBody = ({ body, className }: { readonly body: string; readonly className?: string }): ReactNode => (
  <div className={cn("whitespace-pre-wrap break-words text-[14.5px] leading-[1.6] text-text", className)} data-testid="note-body">
    {body.split(/(`[^`\n]+`)/).map((part, i) =>
      part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
        <code key={`${String(i)}-${part}`} className="rounded-[5px] border border-line bg-surface px-1.5 py-px font-mono text-[13px]">
          {part.slice(1, -1)}
        </code>
      ) : (
        <Fragment key={`${String(i)}-${part}`}>{part}</Fragment>
      ),
    )}
  </div>
);
