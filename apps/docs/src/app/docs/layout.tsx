import type { ReactNode } from "react";

import { DocsDrawer, DocsNav } from "@/components/docs-nav";
import { SiteHeader } from "@/components/site-header";
import { navigation } from "@/lib/navigation";

const DocsLayout = ({ children }: { readonly children: ReactNode }) => {
  const sections = navigation();
  return (
    <>
      <SiteHeader withMenu />
      <DocsDrawer sections={sections} />
      <div className="docs-frame">
        <DocsNav sections={sections} />
        {children}
      </div>
    </>
  );
};

export default DocsLayout;
