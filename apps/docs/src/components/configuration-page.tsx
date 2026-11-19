import { FileText } from "lucide-react";

import { loadConfigurationReference } from "@/lib/configuration-source";
import { blobUrl } from "@/lib/site";

import { renderInline } from "./inline-markdown";
import { SettingsReference } from "./settings-reference";

/** The configuration reference (docs-reference.md), rendered from `docs/configuration.md` at build time. */
export const ConfigurationPage = async () => {
  const reference = await loadConfigurationReference();
  return (
    <article className="docs-article reference-article">
      <h1 className="docs-title">Configuration reference</h1>
      <p className="docs-lede">{renderInline(reference.lede)}</p>
      <p className="source-line">
        <FileText size={15} strokeWidth={1.75} aria-hidden="true" />
        <span>
          Rendered from{" "}
          <a href={blobUrl("docs/configuration.md")}>
            <code>docs/configuration.md</code>
          </a>
          , which a test checks against the code.
        </span>
      </p>
      <SettingsReference groups={reference.groups} />
    </article>
  );
};
