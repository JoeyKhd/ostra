import type { ReactNode } from "react";

/** A section of the profile editor: a title, an optional count and inline note, then its body 10px down. */
export const EditorSection = ({ title, count, note, children }: {
  readonly title: string;
  readonly count?: number;
  readonly note?: string;
  readonly children: ReactNode;
}) => (
  <section className="mt-[22px]" aria-label={title}>
    <div className="mb-2 flex min-h-[22px] flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <h2 className="flex items-baseline gap-2 text-body font-semibold">
        {title}
        {count === undefined ? null : <span className="font-mono text-[12.5px] font-normal text-faint">{count}</span>}
      </h2>
      {note === undefined ? null : <span className="text-ui text-muted">{note}</span>}
    </div>
    {children}
  </section>
);
