import Link from "next/link";

import { repoUrl, versionLabel } from "@/lib/site";

/** The footer (docs-home.md): the license line and three links. No analytics, no newsletter. */
export const SiteFooter = () => (
  <footer className="site-footer">
    <div className="site-footer-inner">
      <p>ostra is source-available under the Sustainable Use License. These docs are Apache-2.0.</p>
      <p className="site-footer-links">
        <a href={repoUrl}>GitHub</a>
        <span aria-hidden="true">·</span>
        <Link href="/docs/security/reporting">Security</Link>
        <span aria-hidden="true">·</span>
        <span>{versionLabel}</span>
      </p>
    </div>
  </footer>
);
