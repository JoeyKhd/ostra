// The charts' values in the configuration reference (`docs/configuration.md`, "The Helm charts"):
// one `### <chart>` table each, `| Value | Default | What it does |`, a row per value path.

/** The value paths each chart's table lists, from the reference's text. */
export const referencedValues = (markdown: string): Readonly<Record<string, readonly { readonly path: string; readonly defaultValue: string }[]>> => {
  const text = markdown.replace(/\r\n/g, "\n");
  const section = text.split("\n## The Helm charts\n")[1]?.split("\n## ")[0] ?? "";
  const out: Record<string, { path: string; defaultValue: string }[]> = {};
  let chart: string | null = null;
  for (const line of section.split("\n")) {
    const heading = /^### `?([a-z-]+)`?$/.exec(line.trim());
    if (heading?.[1] !== undefined) {
      chart = heading[1];
      out[chart] = [];
      continue;
    }
    const row = /^\| `([A-Za-z][A-Za-z0-9.]*)` \| (.+?) \| .+ \|$/.exec(line.trim());
    if (chart !== null && row?.[1] !== undefined && row[2] !== undefined) {
      out[chart]?.push({ path: row[1], defaultValue: row[2] });
    }
  }
  return out;
};
