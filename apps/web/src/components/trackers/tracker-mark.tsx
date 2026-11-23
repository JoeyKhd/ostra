import { cn } from "@/lib/cn";

/*
 * Each tracker's mark (F-152, app-targets/m11-trackers/README.md "The marks"), drawn as inline SVG
 * the way `components/github/github-mark.tsx` draws GitHub's: four marks, fixed, so they're copied
 * from the targets' `html/logos/` files rather than installed or fetched. The marks are their
 * owners' trademarks. ostra uses each one only to name the integration (nominative use): unaltered,
 * in its owner's colours or its owner's one-colour version, never as ostra's mark and never implying
 * endorsement. Linear's and Atlassian's guidelines were read on 2026-11-23 (m11 ticket 11).
 */

/** The trackers with a mark: the two ostra connects, and the two the picker shows as Coming soon (F-152/c8). */
export const trackerMarkKinds = ["linear", "jira", "trello", "notion"] as const;
export type TrackerMarkKind = (typeof trackerMarkKinds)[number];

/** Each tracker's name as its owner writes it: the label of a mark that stands alone. */
export const trackerName = {
  linear: "Linear",
  jira: "Jira",
  trello: "Trello",
  notion: "Notion",
} as const satisfies Record<TrackerMarkKind, string>;

/** The sizes, in px, the targets draw a mark at (app-targets/m11-trackers/*.md). */
export type TrackerMarkSize = 12 | 13 | 14 | 15 | 16 | 18 | 20 | 22 | 28 | 30 | 32 | 36;

/**
 * Where a mark goes, at the size its target names, and in which treatment (choice 9): the brand
 * colour where it names a tracker once; one colour, `currentColor`, where it repeats down a list or
 * sits in running text, so the caller gives it the key's own `--faint` there.
 */
export const trackerMarkAt = {
  // Named once: the brand colour.
  trackersRow: { size: 20, mono: false },
  trackersPhoneRow: { size: 20, mono: false },
  trackerPanelHead: { size: 28, mono: false },
  picker: { size: 32, mono: false },
  pickerComingSoon: { size: 22, mono: false },
  connectionHeader: { size: 36, mono: false },
  connectionHeaderPhone: { size: 30, mono: false },
  boardRow: { size: 18, mono: false },
  boardPhoneRow: { size: 20, mono: false },
  attachGroup: { size: 14, mono: false },
  boardSelect: { size: 15, mono: false },
  property: { size: 16, mono: false },
  taskHeader: { size: 14, mono: false },
  newTask: { size: 15, mono: false },
  setupStep: { size: 14, mono: false },
  // Repeated, or in running text: one colour.
  inboxRow: { size: 14, mono: true },
  search: { size: 14, mono: true },
  threadMeta: { size: 13, mono: true },
  sidebar: { size: 12, mono: true },
} as const satisfies Record<string, { readonly size: TrackerMarkSize; readonly mono: boolean }>;

export type TrackerMarkPlace = keyof typeof trackerMarkAt;

/** The brand colours: Simple Icons' value for Linear, `@atlaskit/logo`'s tiles for Jira and Trello. */
export const trackerBrandColour = {
  linear: "#5E6AD2",
  jira: "#1868DB",
  trello: "#1558BC",
} as const;

// Linear: Simple Icons 16.30.0 (`simple-icons` on npm, CC0 data), which takes it from linear.app.
// The mark is Linear's trademark (linear.app/brand); used only to name the integration, unaltered.
const linearPath =
  "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z";

// Notion: Simple Icons 16.30.0 (CC0 data), from notion.so. The mark is Notion's trademark; used only
// to name the integration, unaltered.
const notionPath =
  "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z";

// Jira's and Trello's tile: `@atlaskit/logo` 23.3.3 (Apache-2.0 code), `jira/icon` and `trello/icon`.
const tilePath = "M0 6a6 6 0 0 1 6-6h12a6 6 0 0 1 6 6v12a6 6 0 0 1-6 6H6a6 6 0 0 1-6-6z";

// Jira: Atlassian's own, `@atlaskit/logo` 23.3.3 (Apache-2.0 code), `jira/icon`, the 2024 tile's
// glyph, and its "custom theme" one-colour cut-out. The mark is Atlassian's trademark
// (atlassian.design/foundations/logos/); used only to name the integration, unaltered.
const jiraGlyphPath =
  "M9.051 15.434H7.734c-1.988 0-3.413-1.218-3.413-3h7.085c.367 0 .605.26.605.63v7.13c-1.772 0-2.96-1.435-2.96-3.434zm3.5-3.543h-1.318c-1.987 0-3.413-1.196-3.413-2.978h7.085c.367 0 .627.239.627.608v7.13c-1.772 0-2.981-1.435-2.981-3.434zm3.52-3.522h-1.317c-1.987 0-3.413-1.217-3.413-3h7.085c.367 0 .605.262.605.61v7.129c-1.771 0-2.96-1.435-2.96-3.434z";
const jiraMonoPath =
  "M18 0a6 6 0 0 1 6 6v12a6 6 0 0 1-6 6H6a6 6 0 0 1-6-6V6a6 6 0 0 1 6-6zM4.321 12.434c0 1.782 1.425 3 3.412 3h1.319v1.326c0 2 1.188 3.433 2.959 3.433v-7.129c0-.369-.238-.63-.605-.63zm3.5-3.52c0 1.781 1.425 2.977 3.412 2.977h1.318v1.326c0 2 1.21 3.433 2.98 3.433V9.521c0-.369-.259-.608-.626-.608zm3.52-3.544c0 1.782 1.426 3 3.413 3h1.317v1.304c0 2 1.188 3.433 2.96 3.433V5.98c0-.348-.238-.609-.605-.609z";

// Trello: Atlassian's own, `@atlaskit/logo` 23.3.3 (Apache-2.0 code), `trello/icon`: the tile's
// glyph and the one-colour cut-out. The mark is Atlassian's trademark; used only to name the
// integration, unaltered.
const trelloGlyphPath =
  "M9.39 18.23a.95.95 0 0 0 .95-.95V5.38a.95.95 0 0 0-.95-.95H5.38a.95.95 0 0 0-.95.95v11.91c0 .52.42.95.95.95zm9.23-5.46a.95.95 0 0 0 .95-.95V5.38a.95.95 0 0 0-.95-.95h-4.01a.95.95 0 0 0-.95.95v6.44c0 .52.42.95.95.95z";
const trelloMonoPath =
  "M18 0a6 6 0 0 1 6 6v12a6 6 0 0 1-6 6H6a6 6 0 0 1-6-6V6a6 6 0 0 1 6-6zM5.379 4.43a.95.95 0 0 0-.948.949v11.907c0 .523.424.948.948.948H9.39a.95.95 0 0 0 .947-.948V5.38a.95.95 0 0 0-.947-.948zm9.23 0a.95.95 0 0 0-.947.949v6.44c0 .523.423.948.947.949h4.012a.95.95 0 0 0 .948-.949V5.38a.95.95 0 0 0-.948-.948z";

/** The paths of one mark in one treatment. */
const MarkPaths = ({ kind, mono }: { readonly kind: TrackerMarkKind; readonly mono: boolean }) => {
  switch (kind) {
    case "linear":
      return <path fill={mono ? "currentColor" : trackerBrandColour.linear} d={linearPath} />;
    case "notion":
      // Black on light in Notion's own files, so the page's text colour in either theme.
      return mono ? (
        <path fill="currentColor" d={notionPath} />
      ) : (
        <path className="fill-text" d={notionPath} />
      );
    case "jira":
      return mono ? (
        <path fill="currentColor" d={jiraMonoPath} />
      ) : (
        <>
          <path fill={trackerBrandColour.jira} d={tilePath} />
          <path fill="#FFFFFF" d={jiraGlyphPath} />
        </>
      );
    case "trello":
      return mono ? (
        <path fill="currentColor" d={trelloMonoPath} />
      ) : (
        <>
          <path fill={trackerBrandColour.trello} d={tilePath} />
          <path fill="#FFFFFF" d={trelloGlyphPath} />
        </>
      );
    default:
      return kind satisfies never;
  }
};

export type TrackerMarkProps = {
  readonly kind: TrackerMarkKind;
  readonly size: TrackerMarkSize;
  /** The one-colour version, in `currentColor`: where the mark repeats or sits in running text. */
  readonly mono?: boolean;
  /** `false` beside a word that already names the tracker: the mark is then hidden from readers. */
  readonly label?: boolean;
  readonly className?: string;
};

/**
 * A tracker's mark at one of the targets' sizes: an image labelled with the tracker's name when it
 * stands alone, hidden when `label` is `false`.
 */
export const TrackerMark = ({
  kind,
  size,
  mono = false,
  label = true,
  className,
}: TrackerMarkProps) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    data-tracker-mark={kind}
    data-treatment={mono ? "mono" : "brand"}
    className={cn("inline-block shrink-0 align-middle", className)}
    {...(label ? { role: "img", "aria-label": trackerName[kind] } : { "aria-hidden": true })}
  >
    <MarkPaths kind={kind} mono={mono} />
  </svg>
);
