// The ticket icon set (inbox.md): Lucide has no priority glyphs like Linear's, which members know.
// Drawn once on Lucide's 24-unit grid, stroke 1.75, `currentColor`, always `--muted` and always
// beside their word, never coloured.

const svg = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** Three ascending bars (3 lit for High, 2 Medium, 1 Low), a square with `!` for Urgent, dots for none. */
export const PriorityIcon = ({ priority, className }: { readonly priority: number | null; readonly className?: string }) => {
  if (priority === 1)
    return (
      <svg {...svg} aria-hidden className={className}>
        <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" />
        <path d="M12 8v5M12 16.5v.01" />
      </svg>
    );
  if (priority === 2 || priority === 3 || priority === 4) {
    const lit = 5 - priority;
    return (
      <svg {...svg} aria-hidden className={className}>
        {[0, 1, 2].map((i) => (
          <path key={i} d={`M${String(6 + i * 6)} ${String(19)}V${String(14 - i * 4)}`} strokeWidth={2.5} stroke={i < lit ? "currentColor" : "var(--line-2)"} />
        ))}
      </svg>
    );
  }
  return (
    <svg {...svg} aria-hidden className={className}>
      <path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth={3} />
    </svg>
  );
};

/** A ticket status's mark by its category: an open circle, half filled, checked, crossed. */
export const TicketStatusIcon = ({ category, className }: { readonly category: "open" | "started" | "done" | "cancelled" | null; readonly className?: string }) => (
  <svg {...svg} aria-hidden className={className}>
    <circle cx="12" cy="12" r="8.5" strokeDasharray={category === null ? "2.5 3" : undefined} />
    {category === "started" ? <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none" /> : null}
    {category === "done" ? <path d="m8.5 12 2.5 2.5 4.5-5" /> : null}
    {category === "cancelled" ? <path d="m9.5 9.5 5 5m0-5-5 5" /> : null}
  </svg>
);
