"use client";

import { useState } from "react";

import { t } from "@/lib/messages";

/** A teal `Copy` text button that reads `Copied` for 1.5s (runners.md). */
export const CopyLink = ({ text }: { readonly text: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="shrink-0 text-body text-teal hover:underline"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => { setCopied(false); }, 1500);
        });
      }}
    >
      {copied ? t("common.copied") : t("common.copy")}
    </button>
  );
};
