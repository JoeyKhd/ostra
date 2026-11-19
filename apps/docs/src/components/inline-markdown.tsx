import type { ReactNode } from "react";

import { splitRow } from "@/lib/configuration-reference";

// The small Markdown the configuration reference's cells and paragraphs use: code spans, bold,
// italics and links, paragraphs and tables. The whole file is ostra's own and checked in, so this
// renders it as written; anything else stays text.

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g;

/** Renders inline Markdown. A code span naming a known setting links to its row. */
export const renderInline = (markdown: string, settingNames: ReadonlySet<string> = new Set()): ReactNode[] => {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of markdown.matchAll(INLINE)) {
    const [token] = match;
    const at = match.index;
    if (at > last) {
      nodes.push(markdown.slice(last, at));
    }
    const key = `${String(at)}-${token}`;
    if (token.startsWith("`")) {
      const code = token.slice(1, -1);
      nodes.push(
        settingNames.has(code) ? (
          <a key={key} href={`#${code}`} className="setting-link">
            <code>{code}</code>
          </a>
        ) : (
          <code key={key}>{code}</code>
        ),
      );
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{renderInline(token.slice(2, -2), settingNames)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), settingNames)}</em>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      nodes.push(
        <a key={key} href={link?.[2] ?? "#"}>
          {renderInline(link?.[1] ?? "", settingNames)}
        </a>,
      );
    }
    last = at + token.length;
  }
  if (last < markdown.length) {
    nodes.push(markdown.slice(last));
  }
  return nodes;
};

/** Renders one block: a paragraph, or a table (its header, the delimiter row, its rows). */
export const MarkdownBlock = ({ markdown, settingNames }: { readonly markdown: string; readonly settingNames?: ReadonlySet<string> }) => {
  const lines = markdown.split("\n");
  if (lines[0]?.trimStart().startsWith("|") === true) {
    const [head, , ...rows] = lines;
    return (
      <div className="prose-table">
        <table>
          <thead>
            <tr>
              {splitRow(head).map((cell) => (
                <th scope="col" key={cell}>
                  {renderInline(cell, settingNames)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row}>
                {splitRow(row).map((cell, index) => (
                  <td key={`${String(index)}-${cell}`}>{renderInline(cell, settingNames)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return <p>{renderInline(lines.join(" "), settingNames)}</p>;
};
