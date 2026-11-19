// The images a ticket shows inline: Linear's markdown writes an uploaded image as
// `![name](https://uploads.linear.app/...)`. The text is untrusted, so this only reads it: the
// patterns are linear in the input (no nested quantifiers), and nothing it finds is run.

/** `![alt](url)` and `![alt](<url> "title")`. Alt text has no `]`; a URL has no space or `)`. */
const MARKDOWN_IMAGE = /!\[([^\]\n]{0,500})\]\(\s{0,10}<?([^\s)<>]{1,2048})>?(?:\s{1,10}"[^"\n]{0,500}")?\s{0,10}\)/g;

/** `<img src="url">`, which Linear's editor keeps for an image pasted as HTML. */
const HTML_IMAGE = /<img\b[^>]{0,500}?\bsrc\s{0,10}=\s{0,10}["']([^"'\s]{1,2048})["']/gi;

export type MarkdownImage = { readonly url: string; readonly alt: string };

/** The images in a piece of markdown, in order, each URL once. */
export const markdownImages = (markdown: string): readonly MarkdownImage[] => {
  const found: { readonly index: number; readonly image: MarkdownImage }[] = [];
  for (const match of markdown.matchAll(MARKDOWN_IMAGE)) {
    const url = match[2];
    if (url !== undefined) {
      found.push({ index: match.index, image: { url, alt: (match[1] ?? "").trim() } });
    }
  }
  for (const match of markdown.matchAll(HTML_IMAGE)) {
    const url = match[1];
    if (url !== undefined) {
      found.push({ index: match.index, image: { url, alt: "" } });
    }
  }
  const seen = new Set<string>();
  return found
    .sort((a, b) => a.index - b.index)
    .flatMap(({ image }) => {
      if (seen.has(image.url)) {
        return [];
      }
      seen.add(image.url);
      return [image];
    });
};

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic)$/i;

/** Whether a URL's path ends like an image file's: how an attachment is told to be an image. */
export const looksLikeImage = (url: URL): boolean => IMAGE_EXTENSION.test(url.pathname);

/**
 * A file name for an image: the alt text when it's a plain name with an extension, else the URL's
 * last path segment. Untrusted either way: core sanitizes it before it touches a disk.
 */
export const imageName = (url: URL, alt: string): string => {
  if (/^[\w .-]{1,200}\.[A-Za-z0-9]{1,8}$/.test(alt)) {
    return alt;
  }
  const last = url.pathname.split("/").filter((segment) => segment !== "").at(-1);
  if (last === undefined) {
    return "image";
  }
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};
