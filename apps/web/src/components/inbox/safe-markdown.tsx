import type { ReactNode } from "react";

// A ticket's description is untrusted (AGENTS.md, Boundaries): it's shown as a small subset of
// markdown built into React elements, never as HTML. Paragraphs, list items, `code`, **bold** and
// [links](https://…) only; a link opens in a new tab with `rel="noopener noreferrer"`, and only an
// http(s) address becomes one. Images aren't shown inline (the panel counts them instead).

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\))/g;
const IMAGE = /!\[[^\]\n]*\]\([^)\s]*\)/g;

const safeHref = (raw: string): string | null => {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
};

const inline = (text: string, key: string): ReactNode[] =>
  text.split(INLINE).map((part, i) => {
    const id = `${key}-${String(i)}`;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) return <code key={id} className="rounded-sm bg-surface px-1 font-mono text-[0.95em] text-text">{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 3) return <b key={id} className="font-semibold text-text">{part.slice(2, -2)}</b>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link !== null) {
      const [, label = "", raw = ""] = link;
      const href = safeHref(raw);
      return href === null ? (
        <span key={id}>{label}</span>
      ) : (
        <a key={id} href={href} target="_blank" rel="noopener noreferrer" className="text-teal hover:underline">
          {label}
        </a>
      );
    }
    return <span key={id}>{part}</span>;
  });

/** The markdown's images, counted: the panel names how many there are instead of showing them. */
export const countImages = (markdown: string): number => markdown.match(IMAGE)?.length ?? 0;

/** Untrusted markdown as React elements: no raw HTML, no images, safe links only. */
export const SafeMarkdown = ({ markdown }: { readonly markdown: string }) => {
  const blocks = markdown.replace(IMAGE, "").replace(/\r\n/g, "\n").split(/\n{2,}/).map((block) => block.trim()).filter((block) => block !== "");
  return (
    <>
      {blocks.map((block, i) => {
        const key = `b${String(i)}`;
        const lines = block.split("\n");
        if (lines.every((line) => /^\s*[-*]\s+/.test(line)))
          return (
            <ul key={key} className="mb-2 list-disc pl-5 last:mb-0">
              {lines.map((line, j) => (
                <li key={`${key}-${String(j)}`}>{inline(line.replace(/^\s*[-*]\s+/, ""), `${key}-${String(j)}`)}</li>
              ))}
            </ul>
          );
        return (
          <p key={key} className="mb-2 last:mb-0">
            {lines.map((line, j) => (
              <span key={`${key}-${String(j)}`}>
                {j > 0 ? <br /> : null}
                {inline(line.replace(/^#{1,6}\s+/, ""), `${key}-${String(j)}`)}
              </span>
            ))}
          </p>
        );
      })}
    </>
  );
};
