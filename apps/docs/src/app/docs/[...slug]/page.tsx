import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight } from "lucide-react";

import { ConfigurationPage } from "@/components/configuration-page";
import { mdxComponents } from "@/components/mdx";
import { OnThisPage, OnThisPageRow } from "@/components/on-this-page";
import { referenceToc } from "@/lib/configuration-source";
import { flatPages } from "@/lib/navigation";
import { editUrl } from "@/lib/site";
import { repoPathOf, source } from "@/lib/source";

type Props = { readonly params: Promise<{ readonly slug: string[] }> };

export const dynamicParams = false;

export const generateStaticParams = (): { slug: string[] }[] => source.getPages().map((page) => ({ slug: page.slugs }));

export const generateMetadata = async ({ params }: Props): Promise<Metadata> => {
  const page = source.getPage((await params).slug);
  return page === undefined ? {} : { title: page.data.title, description: page.data.description ?? null };
};

/** Previous and next, in the navigation's order (docs-guide.md, item 7). */
const PreviousNext = ({ url }: { readonly url: string }) => {
  const pages = flatPages();
  const index = pages.findIndex((entry) => entry.page.url === url);
  const previous = index > 0 ? pages[index - 1]?.page : undefined;
  const next = index >= 0 ? pages[index + 1]?.page : undefined;
  return (
    <nav className="prev-next" aria-label="Previous and next">
      {previous === undefined ? <span /> : (
        <Link href={previous.url} className="prev-next-link">
          <span className="prev-next-label">Previous</span>
          <span className="prev-next-title">
            <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
            {previous.title}
          </span>
        </Link>
      )}
      {next === undefined ? <span /> : (
        <Link href={next.url} className="prev-next-link is-next">
          <span className="prev-next-label">Next</span>
          <span className="prev-next-title">
            {next.title}
            <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
        </Link>
      )}
    </nav>
  );
};

const DocsPageRoute = async ({ params }: Props) => {
  const page = source.getPage((await params).slug);
  if (page === undefined) {
    notFound();
  }
  const section = flatPages().find((entry) => entry.page.url === page.url)?.section;
  const sectionHref = section?.pages[0]?.url ?? "/docs/start/what-ostra-is";
  const edit = editUrl(repoPathOf(page));
  const isReference = page.slugs.join("/") === "reference/configuration";
  const data = page.data;
  if (!("body" in data)) {
    notFound();
  }
  const Body = data.body;
  const toc = isReference ? [] : data.toc;
  return (
    <>
      <main id="content" className={isReference ? "docs-main is-wide" : "docs-main"}>
        <nav aria-label="Breadcrumb" className="breadcrumb">
          <Link href={sectionHref}>{section?.title ?? "Docs"}</Link>
          <span aria-hidden="true">›</span>
          <span aria-current="page">{page.data.title}</span>
        </nav>
        {isReference ? (
          <ConfigurationPage />
        ) : (
          <article className="docs-article">
            <OnThisPageRow toc={toc} />
            <h1 className="docs-title">{page.data.title}</h1>
            {page.data.description === undefined ? null : <p className="docs-lede">{page.data.description}</p>}
            <div className="docs-body">
              <Body components={mdxComponents} />
            </div>
          </article>
        )}
        <PreviousNext url={page.url} />
      </main>
      {isReference ? <ConfigurationRail edit={edit} /> : <OnThisPage toc={toc} editUrl={edit} />}
    </>
  );
};

const ConfigurationRail = async ({ edit }: { readonly edit: string }) => <OnThisPage toc={await referenceToc()} editUrl={edit} />;

export default DocsPageRoute;
