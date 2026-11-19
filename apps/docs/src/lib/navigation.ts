import { source } from "./source";

/** A page in the navigation. */
export type NavPage = { readonly title: string; readonly url: string };

/** A section: a folder of `content/`, in `content/meta.json`'s order (ADR 0063's eight). */
export type NavSection = {
  readonly title: string;
  readonly description: string;
  readonly icon: string;
  readonly pages: readonly NavPage[];
};

const textOf = (node: unknown): string => (typeof node === "string" ? node : "");

const metaText = (data: unknown, key: "description" | "icon"): string => {
  if (typeof data !== "object" || data === null || !(key in data)) {
    return "";
  }
  const value: unknown = Object.entries(data).find(([name]) => name === key)?.[1];
  return typeof value === "string" ? value : "";
};

/** The navigation's tree, the one list the sidebar, the home's grid and previous/next read. */
export const navigation = (): NavSection[] =>
  source.pageTree.children.flatMap((node): NavSection[] => {
    if (node.type !== "folder") {
      return [];
    }
    const meta = source.getNodeMeta(node);
    return [
      {
        title: textOf(node.name),
        description: metaText(meta?.data, "description"),
        icon: metaText(meta?.data, "icon"),
        pages: node.children.flatMap((child) => (child.type === "page" ? [{ title: textOf(child.name), url: child.url }] : [])),
      },
    ];
  });

/** Every page in the navigation's order, with its section. */
export const flatPages = (): { readonly page: NavPage; readonly section: NavSection }[] =>
  navigation().flatMap((section) => section.pages.map((page) => ({ page, section })));

/** The section a URL belongs to. */
export const sectionOf = (url: string): NavSection | undefined => flatPages().find((entry) => entry.page.url === url)?.section;
