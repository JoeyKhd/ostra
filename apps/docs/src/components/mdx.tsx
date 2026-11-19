import { Info, ShieldOff, TriangleAlert } from "lucide-react";
import type { MDXComponents } from "mdx/types";
import Link from "next/link";
import { Children, isValidElement } from "react";
import type { ComponentProps, ReactNode } from "react";

import type { CalloutKind } from "../../markdown/remark-plugins";

import { CodeBlock } from "./code-block";
import { HeadingAnchor } from "./heading-anchor";

const calloutTitles = { note: "Note", warning: "Warning", "not-isolated": "Not isolated" } as const satisfies Record<CalloutKind, string>;

const CalloutIcon = ({ kind }: { readonly kind: CalloutKind }) => {
  switch (kind) {
    case "note":
      return <Info size={16} strokeWidth={1.75} aria-hidden="true" />;
    case "warning":
      return <TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" />;
    case "not-isolated":
      return <ShieldOff size={16} strokeWidth={1.75} aria-hidden="true" />;
    default:
      return kind satisfies never;
  }
};

const calloutKindOf = (value: unknown): CalloutKind | null =>
  value === "note" || value === "warning" || value === "not-isolated" ? value : null;

/**
 * A callout (docs-guide.md, "Callouts"): Note, Warning, and Not isolated, its own kind, so every
 * page that mentions the `host` executor says it the same way.
 */
export const Callout = ({ kind, children }: { readonly kind: CalloutKind; readonly children: ReactNode }) => (
  <aside role="note" className="callout" data-kind={kind}>
    <p className="callout-title">
      <CalloutIcon kind={kind} />
      {calloutTitles[kind]}
    </p>
    <div className="callout-body">{children}</div>
  </aside>
);

const Blockquote = ({ children, ...props }: ComponentProps<"blockquote">) => {
  const kind = calloutKindOf(Object.entries(props).find(([name]) => name === "data-callout")?.[1]);
  return kind === null ? <blockquote>{children}</blockquote> : <Callout kind={kind}>{children}</Callout>;
};

/** A code element's text: without a highlighter it is a string, or strings in an array. */
const stringOf = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  return Array.isArray(value) ? value.map((part: unknown) => stringOf(part)).join("") : "";
};

const Pre = ({ children }: ComponentProps<"pre">) => {
  const code = Children.toArray(children).find((child) => isValidElement<Record<string, unknown>>(child));
  if (!isValidElement<Record<string, unknown>>(code)) {
    return <pre>{children}</pre>;
  }
  const text = stringOf(code.props["children"]);
  const lang = typeof code.props["data-lang"] === "string" ? code.props["data-lang"] : "text";
  return <CodeBlock code={text} lang={lang} run={code.props["data-run"] === "true"} />;
};

const textOf = (node: ReactNode): string =>
  Children.toArray(node)
    .map((part) => {
      if (typeof part === "string" || typeof part === "number") {
        return String(part);
      }
      return isValidElement<{ children?: ReactNode }>(part) ? textOf(part.props.children) : "";
    })
    .join("");

const heading =
  (Tag: "h2" | "h3") =>
  ({ id, children, ...props }: ComponentProps<"h2">) => (
    <Tag id={id} {...props}>
      {children}
      {id === undefined ? null : <HeadingAnchor id={id} label={textOf(children)} />}
    </Tag>
  );

const Anchor = ({ href, children }: ComponentProps<"a">) =>
  href?.startsWith("/") === true ? <Link href={href}>{children}</Link> : <a href={href}>{children}</a>;

export const mdxComponents: MDXComponents = {
  blockquote: Blockquote,
  pre: Pre,
  h2: heading("h2"),
  h3: heading("h3"),
  a: Anchor,
};
