import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// F-080 (ticket 35): a snippet is text with ranges to mark, never HTML from the server. Each part is a
// React text node, and a matched part a `mark`.

export type Snippet = RouterOutputs["search"]["suggest"]["results"][number]["snippets"][number];

/**
 * The parts with the text before the first match cut to its last `lead` characters, so the match shows
 * on a one-line snippet (`…` where it was cut).
 */
export const leadTo = (parts: Snippet["parts"], lead: number): Snippet["parts"] => {
  const first = parts[0];
  if (first === undefined || first.match || first.text.length <= lead || !parts.some((part) => part.match)) return parts;
  return [{ text: `…${first.text.slice(-lead).trimStart()}`, match: false }, ...parts.slice(1)];
};

export const Highlight = ({ parts, className, lead }: { readonly parts: Snippet["parts"]; readonly className?: string; readonly lead?: number }) => (
  <span className={className}>
    {(lead === undefined ? parts : leadTo(parts, lead)).map((part, index) =>
      part.match ? (
        <mark key={index} className="rounded-[3px] bg-line-2 px-0.5 font-medium text-text">
          {part.text}
        </mark>
      ) : (
        <span key={index}>{part.text}</span>
      ),
    )}
  </span>
);

/** What a snippet matched, as its label: `Agent message`, `Command`, `Prompt`, … */
export const snippetLabel = (snippet: Snippet): string => t(`search.kind.${snippet.kind}`);

/** Whether a snippet reads as code: a tool call's input (a command, a path, a URL). */
export const isCodeSnippet = (snippet: Snippet): boolean => snippet.kind === "tool_input";

export const SnippetLine = ({ snippet, className }: { readonly snippet: Snippet; readonly className?: string }) => (
  <span className={cn("flex min-w-0 items-baseline gap-2", className)} data-testid="search-snippet" data-kind={snippet.kind}>
    <span className="w-[104px] shrink-0 truncate text-xs text-faint">{snippetLabel(snippet)}</span>
    <Highlight parts={snippet.parts} lead={24} className={cn("min-w-0 truncate text-[13px] text-muted", isCodeSnippet(snippet) && "font-mono text-[12.5px]")} />
  </span>
);

/** Where a result opens: the task, at the matched event when the snippet has one. */
export const resultHref = (taskId: string, snippets: readonly Snippet[]): string => {
  const seq = snippets.find((snippet) => snippet.eventSeq !== null)?.eventSeq;
  return seq === undefined || seq === null ? `/tasks/${taskId}` : `/tasks/${taskId}?event=${String(seq)}`;
};

/**
 * The whole title with the words its title snippet matched in weight 600 (search.md, line 1): the
 * snippet may be cut, the title never is.
 */
export const titleParts = (title: string, parts: Snippet["parts"]): Snippet["parts"] => {
  const words = [...new Set(parts.filter((part) => part.match).map((part) => part.text.trim().toLowerCase()).filter((word) => word !== ""))];
  if (words.length === 0) return [{ text: title, match: false }];
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return title
    .split(new RegExp(`(${escaped.join("|")})`, "i"))
    .filter((text) => text !== "")
    .map((text) => ({ text, match: words.includes(text.toLowerCase()) }));
};

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

/** A block's age, mono and short (search.md, line 1): `5m`, `2h`, `3d`, `2w`. */
export const shortAge = (at: number, now: number): string => {
  const since = Math.max(0, now - at);
  if (since < hour) return `${String(Math.max(1, Math.floor(since / minute)))}m`;
  if (since < day) return `${String(Math.floor(since / hour))}h`;
  if (since < 14 * day) return `${String(Math.floor(since / day))}d`;
  return `${String(Math.floor(since / (7 * day)))}w`;
};
