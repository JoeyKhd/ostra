import { SquareIcon } from "lucide-react";
import type { ReactNode } from "react";

import { SafeMarkdown } from "@/components/inbox/safe-markdown";
import { t } from "@/lib/messages";

import type { DraftView } from "./draft-words";

// `Preview` (refine-draft.md, "Preview"): the description as the tracker will show it, which is
// `drafts.get`'s `preview`, the text "Update ticket" writes (ticket 27). Untrusted text: a heading
// line is a heading, a list a list (criteria as a checklist), the rest milestone 2's safe markdown.
// No raw HTML, no image is fetched.

type Preview = NonNullable<DraftView["preview"]>;

/** The description in blocks: `## ` headings, the lists under them, the text between. */
const blocksOf = (text: string): readonly { readonly heading: string | null; readonly body: string }[] => {
  const blocks: { heading: string | null; body: string[] }[] = [{ heading: null, body: [] }];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading?.[1] !== undefined) blocks.push({ heading: heading[1], body: [] });
    else blocks.at(-1)?.body.push(line);
  }
  return blocks.map((block) => ({ heading: block.heading, body: block.body.join("\n").trim() })).filter((block) => block.heading !== null || block.body !== "");
};

const Checklist = ({ body }: { readonly body: string }): ReactNode => {
  const items = body.split("\n").filter((line) => /^\s*[-*]\s+/.test(line));
  if (items.length === 0 || items.length !== body.split("\n").length) return <SafeMarkdown markdown={body} />;
  return (
    <ul className="space-y-1">
      {items.map((line, index) => (
        <li key={`${String(index)}-${line}`} className="flex items-start gap-2">
          <SquareIcon aria-hidden className="mt-[4px] size-[13px] shrink-0 stroke-[1.75] text-faint" />
          <span>{line.replace(/^\s*[-*]\s+(\[[ x]\]\s+)?/, "")}</span>
        </li>
      ))}
    </ul>
  );
};

export const DraftPreview = ({ preview, criteriaInDescription, criteriaCount }: { readonly preview: Preview; readonly criteriaInDescription: boolean; readonly criteriaCount: number }) => (
  <div data-testid="draft-preview">
    <div className="rounded-lg border border-line bg-surface p-4 text-body text-text">
      {blocksOf(preview.description).map((block, index) => (
        <div key={`${String(index)}-${block.heading ?? ""}`} className="mb-3 last:mb-0">
          {block.heading === null ? null : <h3 className="mb-1.5 text-[14.5px] font-semibold text-text">{block.heading}</h3>}
          {block.body === "" ? null : block.heading === t("draft.criteria") ? <Checklist body={block.body} /> : <SafeMarkdown markdown={block.body} />}
        </div>
      ))}
      {preview.attachments.length === 0 ? null : (
        <ul className="mt-3 space-y-1 font-mono text-sm text-muted">
          {preview.attachments.map((name) => (
            <li key={name}>{t("draft.attachmentLine", { name })}</li>
          ))}
        </ul>
      )}
    </div>
    {criteriaInDescription && criteriaCount > 0 ? <p className="mt-2 text-sm text-faint">{t("draft.previewNote")}</p> : null}
    {preview.subTickets.length === 0 ? null : (
      <div className="mt-4">
        <h3 className="mb-2 text-sm text-faint">{t("draft.subIssues")}</h3>
        <ul className="space-y-3">
          {preview.subTickets.map((sub, index) => (
            <li key={`${String(index)}-${sub.title}`}>
              <p className="text-ui font-semibold text-text">{sub.title}</p>
              <p className="whitespace-pre-wrap text-ui text-muted">{sub.description}</p>
            </li>
          ))}
        </ul>
      </div>
    )}
  </div>
);
