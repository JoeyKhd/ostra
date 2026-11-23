import { cn } from "@/lib/cn";

import type { Segment, Tone } from "./words";

// Owner: ticket 09 (milestone 10, F-151). The words of `words.ts` come back as segments: each part
// draws them with this, so a colour a word carries (`failed` red, a subject `--text-2`) is the
// token parts.md names, and nothing else.

/** A segment's colour as the panel's token; `inherit` takes the part's own. */
export const toneClass = (tone: Tone): string | undefined => {
  switch (tone) {
    case "inherit":
      return undefined;
    case "text":
      return "text-text";
    case "subject":
      return "text-text-2";
    case "muted":
      return "text-muted";
    case "faint":
      return "text-faint";
    case "red":
      return "text-red";
    case "green":
      return "text-green";
    case "teal":
      return "text-teal";
    case "amber":
      return "text-amber-text";
    default:
      return tone satisfies never;
  }
};

/** Segments as spans, in their tones; `mono` is the part's mono size (`font-mono text-[13px]`). */
export const Segments = ({ segments, mono = "font-mono" }: { readonly segments: readonly Segment[]; readonly mono?: string }) => (
  <>
    {segments.map((segment, index) => (
      <span key={index} className={cn(toneClass(segment.tone), segment.mono && mono)}>
        {segment.text}
      </span>
    ))}
  </>
);
