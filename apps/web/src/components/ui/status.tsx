import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export type Tone = "green" | "amber" | "red" | "grey" | "teal";

const dotTone: Record<Tone, string> = {
  green: "bg-green shadow-[0_0_0_3px_rgba(79,178,134,0.15)]",
  amber: "bg-amber shadow-[0_0_0_3px_rgba(255,178,36,0.15)]",
  red: "bg-red",
  grey: "bg-faint",
  teal: "bg-teal",
};

/**
 * The 7px dot alone (graphite.css `.dot`), for a place whose words are beside it already: a group
 * band, a section title. Amber and green carry their 3px ring. It's decoration: the words say it.
 */
export const Dot = ({ tone, className }: { readonly tone: Tone; readonly className?: string }) => (
  <span aria-hidden className={cn("inline-block size-[7px] shrink-0 rounded-full", dotTone[tone], className)} />
);

/** A status dot, always with its label: colour never carries meaning alone (app-design.md, rule 4). */
export const Status = ({ tone, children, className }: { readonly tone: Tone; readonly children: ReactNode; readonly className?: string }) => (
  <span className={cn("inline-flex items-center gap-[7px]", className)}>
    <Dot tone={tone} />
    {children}
  </span>
);

export const Chip = ({ children, className }: { readonly children: ReactNode; readonly className?: string }) => (
  <span
    className={cn(
      "inline-flex h-[22px] items-center gap-[5px] whitespace-nowrap rounded-sm border border-line-2 px-2 text-sm text-muted [&_svg]:size-3",
      className,
    )}
  >
    {children}
  </span>
);

/** A block of code or command output: plain text, never HTML. */
export const Code = ({ children, className }: { readonly children: ReactNode; readonly className?: string }) => (
  <pre
    className={cn(
      "overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface px-3.5 py-2.5 font-mono text-ui leading-[1.75] text-text",
      className,
    )}
  >
    {children}
  </pre>
);
