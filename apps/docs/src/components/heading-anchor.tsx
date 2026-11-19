"use client";

import { Link as LinkIcon } from "lucide-react";
import { useEffect, useState } from "react";

/** Copies a URL with its anchor, and says so for `ms` milliseconds. */
export const useCopyLink = (ms: number) => {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setCopied(false);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [copied, ms]);
  const copy = (id: string) => {
    const url = new URL(window.location.href);
    url.hash = id;
    void navigator.clipboard.writeText(url.toString()).then(() => {
      setCopied(true);
    });
  };
  return { copied, copy };
};

/** The link after a heading, shown on hover or focus: a click copies the heading's URL. */
export const HeadingAnchor = ({ id, label }: { readonly id: string; readonly label: string }) => {
  const { copied, copy } = useCopyLink(1500);
  return (
    <button
      type="button"
      className="heading-anchor needs-js"
      aria-label={`Copy link to ${label}`}
      onClick={() => {
        copy(id);
      }}
    >
      <LinkIcon size={14} strokeWidth={1.75} aria-hidden="true" />
      <span className={copied ? "tooltip is-shown" : "tooltip"} aria-live="polite">
        {copied ? "Link copied" : ""}
      </span>
    </button>
  );
};
