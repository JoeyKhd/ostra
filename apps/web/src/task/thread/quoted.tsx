import type { ReactNode } from "react";

// Owner: ticket 12 (milestone 10, F-151, parts.md part 2).
/**
 * A quoted item inside a bubble (a diff comment, a PR comment, a review's line comment, a block):
 * a 2px `--line-3` line on its left and 10px in, never a box. Its place mono 12.5px `--faint`, the
 * quoted line mono 12.5px `--muted` on one line, the words 14px `--text`.
 */
export const Quoted = ({ place, line, children, ...data }: {
  readonly place: string | null;
  readonly line?: string | null;
  readonly children?: ReactNode;
  readonly "data-item"?: string;
  readonly "data-diff-comment"?: string;
}) => (
  <div {...data} className="mt-[7px] border-l-2 border-line-3 pl-2.5 first:mt-0">
    {place === null ? null : <div className="font-mono text-[12.5px] text-faint [overflow-wrap:anywhere]">{place}</div>}
    {line === undefined || line === null ? null : <div className="truncate font-mono text-[12.5px] text-muted">{line}</div>}
    {children === undefined ? null : <div className="whitespace-pre-wrap text-ui text-text [overflow-wrap:anywhere]">{children}</div>}
  </div>
);
