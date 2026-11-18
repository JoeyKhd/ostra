import type { ReactNode } from "react";

/** The frame of the pages before the panel: the mark, a title and one form. */
export const AuthCard = ({ title, lede, children }: { readonly title: string; readonly lede: ReactNode; readonly children: ReactNode }) => (
  <main className="flex min-h-dvh items-start justify-center px-4 pt-[12vh] pb-10">
    <div className="w-full max-w-[400px]">
      <img src="/brand/ostra-mark.svg" alt="ostra" className="mb-6 size-7" />
      <h1 className="page-title mb-1.5">{title}</h1>
      <p className="mb-6 text-lede text-muted">{lede}</p>
      {children}
    </div>
  </main>
);
