// The images and links in a piece of markdown (a follow-up's text, F-149's `filesInText`), in
// order: `![alt](url)`, `[text](url)` and `<url>`. The text is untrusted, so this only reads it:
// the patterns are linear in the input (no nested quantifiers), and nothing it finds is fetched
// here. The adapter keeps only the site's own attachments.

const IMAGE = /!\[([^\]\n]{0,500})\]\(\s{0,10}<?([^\s)<>]{1,2048})>?(?:\s{1,10}"[^"\n]{0,500}")?\s{0,10}\)/g;
const LINK = /(?<!!)\[([^\]\n]{0,500})\]\(\s{0,10}<?([^\s)<>]{1,2048})>?(?:\s{1,10}"[^"\n]{0,500}")?\s{0,10}\)/g;
const AUTOLINK = /<(https?:\/\/[^\s<>]{1,2048})>/g;

export type MarkdownLink = { readonly url: string; readonly text: string; readonly image: boolean };

/** Every image and link, in order, each URL once: the first place it's shown names it. */
export const markdownLinks = (markdown: string): readonly MarkdownLink[] => {
  const found: { readonly index: number; readonly link: MarkdownLink }[] = [];
  for (const [pattern, image] of [
    [IMAGE, true],
    [LINK, false],
    [AUTOLINK, false],
  ] as const) {
    for (const match of markdown.matchAll(pattern)) {
      const url = pattern === AUTOLINK ? match[1] : match[2];
      if (url !== undefined) {
        found.push({ index: match.index, link: { url, text: pattern === AUTOLINK ? "" : (match[1] ?? "").trim(), image } });
      }
    }
  }
  const seen = new Set<string>();
  return found
    .sort((a, b) => a.index - b.index)
    .flatMap(({ link }) => {
      if (seen.has(link.url)) return [];
      seen.add(link.url);
      return [link];
    });
};
