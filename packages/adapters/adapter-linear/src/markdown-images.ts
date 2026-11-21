// The images a ticket shows inline: Linear's markdown writes an uploaded image as
// `![name](https://uploads.linear.app/...)`. The text is untrusted, so this only reads it: the
// patterns are linear in the input (no nested quantifiers), and nothing it finds is run.

/** `![alt](url)` and `![alt](<url> "title")`. Alt text has no `]`; a URL has no space or `)`. */
const MARKDOWN_IMAGE = /!\[([^\]\n]{0,500})\]\(\s{0,10}<?([^\s)<>]{1,2048})>?(?:\s{1,10}"[^"\n]{0,500}")?\s{0,10}\)/g;

/** `<img src="url">`, which Linear's editor keeps for an image pasted as HTML. */
const HTML_IMAGE = /<img\b[^>]{0,500}?\bsrc\s{0,10}=\s{0,10}["']([^"'\s]{1,2048})["']/gi;

export type MarkdownImage = { readonly url: string; readonly alt: string };

/** Each image a piece of markdown shows, where it starts: in no order, and a URL as often as it's shown. */
const imageMatches = (markdown: string): { readonly index: number; readonly image: MarkdownImage }[] => {
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
  return found;
};

/** The images in a piece of markdown, in order, each URL once. */
export const markdownImages = (markdown: string): readonly MarkdownImage[] => {
  const found = imageMatches(markdown);
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

// Milestone 9 (F-149): any file a ticket shows. Linear's editor writes an uploaded file that isn't
// an image as a link, `[spec.docx](https://uploads.linear.app/...)`, and a pasted URL may stay an
// autolink, `<https://uploads.linear.app/...>`. The same rules: linear patterns, nothing run.

/** `[text](url)` and `[text](<url> "title")`, but not an image's `![…](…)`. */
const MARKDOWN_LINK = /(?<!!)\[([^\]\n]{0,500})\]\(\s{0,10}<?([^\s)<>]{1,2048})>?(?:\s{1,10}"[^"\n]{0,500}")?\s{0,10}\)/g;

/** `<https://…>`, markdown's autolink. */
const AUTOLINK = /<(https?:\/\/[^\s<>]{1,2048})>/g;

/** A file a piece of markdown shows: its URL, the text it's shown with, and whether as an image. */
export type MarkdownFile = { readonly url: string; readonly text: string; readonly image: boolean };

/**
 * Every image and link in a piece of markdown, in order, each URL once: the first place it's shown
 * names it, and it's an image when any place shows it as one. The caller keeps the file host's.
 */
export const markdownFiles = (markdown: string): readonly MarkdownFile[] => {
  const found: { readonly index: number; readonly file: MarkdownFile }[] = imageMatches(markdown).map(({ index, image }) => ({
    index,
    file: { url: image.url, text: image.alt, image: true },
  }));
  for (const match of markdown.matchAll(MARKDOWN_LINK)) {
    const url = match[2];
    if (url !== undefined) {
      found.push({ index: match.index, file: { url, text: (match[1] ?? "").trim(), image: false } });
    }
  }
  for (const match of markdown.matchAll(AUTOLINK)) {
    const url = match[1];
    if (url !== undefined) {
      found.push({ index: match.index, file: { url, text: "", image: false } });
    }
  }
  const images = new Set(found.filter(({ file }) => file.image).map(({ file }) => file.url));
  const seen = new Set<string>();
  return found
    .sort((a, b) => a.index - b.index)
    .flatMap(({ file }) => {
      if (seen.has(file.url)) {
        return [];
      }
      seen.add(file.url);
      return [{ ...file, image: images.has(file.url) }];
    });
};

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic)$/i;

/** Whether a URL's path ends like an image file's: how an attachment is told to be an image. */
export const looksLikeImage = (url: URL): boolean => IMAGE_EXTENSION.test(url.pathname);

/**
 * A file's name: the text it's shown with (an image's alt, a link's text, an attachment's title)
 * when that's a plain name with an extension, else the URL's last path segment. Untrusted either
 * way: core makes it safe before it touches a disk or a prompt.
 */
export const fileName = (url: URL, text: string, fallback = "file"): string => {
  if (/^[\w .-]{1,200}\.[A-Za-z0-9]{1,8}$/.test(text)) {
    return text;
  }
  const last = url.pathname.split("/").filter((segment) => segment !== "").at(-1);
  if (last === undefined) {
    return fallback;
  }
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

/** An image's name, as `fileName` makes it. */
export const imageName = (url: URL, alt: string): string => fileName(url, alt, "image");
