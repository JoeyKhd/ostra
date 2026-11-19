import type { ReactNode } from "react";

import { t } from "@/lib/messages";

import webPackage from "../../../package.json";

/**
 * The frame of the pages before the panel (sign-in.md, change-password.md): the form column with the
 * lockup, the form and the version, and beside it the "Deep water" illustration with the tagline.
 * The form block's top sits on one guide, the top of a 300px box centred in the column's middle
 * row, so moving from sign-in to the forced password change changes the form and nothing else.
 * Under 960px the illustration column goes, and with it the tagline.
 */
export const AuthFrame = ({ children }: { readonly children: ReactNode }) => (
  <div className="grid h-dvh min-[960px]:grid-cols-[clamp(440px,41%,600px)_minmax(0,1fr)]">
    <div className="flex min-h-0 min-w-0 flex-col bg-bg min-[960px]:border-r min-[960px]:border-line">
      <header className="shrink-0 px-[16px] pt-[16px] min-[420px]:px-[32px] min-[420px]:pt-[32px]">
        <img src="/brand/lockup-horizontal-shell.svg" alt="ostra" className="block h-[22px] w-auto" />
      </header>
      {/* A size container: the form's guide is half of what's left of this row after the 300px box. */}
      <main className="min-h-0 flex-1 overflow-y-auto px-[16px] [container-type:size]">
        <div className="mx-auto w-full max-w-[360px] pt-[max(24px,calc((100cqh-300px)/2))] pb-[24px]">{children}</div>
      </main>
      <footer className="shrink-0 px-[16px] pb-[48px] font-mono text-[11.5px] leading-[20px] text-faint min-[420px]:px-[32px]">
        {t("signIn.version", { version: webPackage.version })}
      </footer>
    </div>
    <div className="relative hidden overflow-hidden bg-side min-[960px]:block">
      {/* Decorative, and graded in the file itself: no overlay, no caption, nothing to focus. */}
      <img
        src="/sign-in-illustration-1200.webp"
        srcSet="/sign-in-illustration-1200.webp 960w, /sign-in-illustration.webp 1792w"
        sizes="60vw"
        alt=""
        aria-hidden="true"
        loading="lazy"
        decoding="async"
        className="absolute inset-0 size-full object-cover object-[50%_8%]"
      />
      <p className="absolute bottom-[48px] left-[48px] z-[1] text-[13px] leading-[20px] text-shell/70">{t("signIn.tagline")}</p>
    </div>
  </div>
);
