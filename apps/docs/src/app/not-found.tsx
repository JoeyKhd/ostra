import Link from "next/link";

import { SiteHeader } from "@/components/site-header";

const NotFound = () => (
  <>
    <SiteHeader />
    <main id="content" className="not-found">
      <h1>Page not found</h1>
      <p>
        <Link href="/docs/start/what-ostra-is" className="teal-link">
          Browse the sections →
        </Link>
      </p>
    </main>
  </>
);

export default NotFound;
