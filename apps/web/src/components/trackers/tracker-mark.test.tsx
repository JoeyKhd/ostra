import { readFile } from "node:fs/promises";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  TrackerMark,
  trackerBrandColour,
  trackerMarkAt,
  trackerMarkKinds,
  trackerName,
} from "./tracker-mark";
import type { TrackerMarkKind, TrackerMarkSize } from "./tracker-mark";

// F-152/c4 and c8 (m11 ticket 11, app-targets/m11-trackers/README.md "The marks"): every place a
// tracker shows carries its mark, in the vendor's colours where it names the tracker once and in one
// colour where it repeats (choice 9), in both themes, labelled when it stands alone and hidden beside
// a word that names it. Trello's and Notion's marks exist for the picker's Coming soon row.

const repo = path.join(import.meta.dirname, "..", "..", "..", "..", "..");
const logos = path.join(repo, "context", "brand", "app-targets", "m11-trackers", "html", "logos");
const cssPath = path.join(import.meta.dirname, "..", "..", "app", "globals.css");

const themes = ["dark", "light"] as const;
/** The surfaces a mark is drawn on (the page, the sidebar, panels, raised rows, a selected row). */
const surfaces = ["--bg", "--side", "--surface", "--raise", "--sel"];

/** The `d` of every path in one of the targets' logo files, in order: the vendor's drawing. */
const logoPaths = async (file: string): Promise<string[]> =>
  [...(await readFile(path.join(logos, file), "utf8")).matchAll(/<path[^>]*\sd="([^"]+)"/g)].map(
    (match) => match[1] ?? "",
  );

/** The targets' file for each kind and treatment. */
const logoFile = (kind: TrackerMarkKind, mono: boolean): string =>
  mono && (kind === "jira" || kind === "trello") ? `${kind}-mono.svg` : `${kind}.svg`;

type Painted = {
  readonly d: string;
  readonly fill: string | undefined;
  readonly className: string | undefined;
};

const svgOf = (html: string): string => /<svg[^>]*>/.exec(html)?.[0] ?? "";
const attr = (tag: string, name: string): string | undefined =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const pathsOf = (html: string): Painted[] =>
  [...html.matchAll(/<path[^>]*>/g)].map(([tag]) => ({
    d: attr(tag, "d") ?? "",
    fill: attr(tag, "fill"),
    className: attr(tag, "class"),
  }));

/** One mark, as the panel draws it inside a page of one theme. */
const render = (
  theme: (typeof themes)[number],
  props: { kind: TrackerMarkKind; size: TrackerMarkSize; mono?: boolean; label?: boolean },
) =>
  renderToStaticMarkup(
    <div data-theme={theme}>
      <TrackerMark {...props} />
    </div>,
  );

/** The theme's custom properties from globals.css: the dark block, or `[data-theme="light"]`. */
const themeTokens = async (): Promise<
  Record<(typeof themes)[number], ReadonlyMap<string, string>>
> => {
  const css = (await readFile(cssPath, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
  const block = (selector: string): ReadonlyMap<string, string> => {
    for (const rule of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
      const selectors = (rule[1] ?? "").split(",").map((part) => part.trim());
      if (selectors.join(",") === selector)
        return new Map(
          [...(rule[2] ?? "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(
            ([, name = "", value = ""]) => [name, value.trim().toLowerCase()],
          ),
        );
    }
    throw new Error(`${selector} not found in globals.css`);
  };
  return { dark: block(':root,[data-theme="dark"]'), light: block('[data-theme="light"]') };
};

/** WCAG 2.2 relative luminance and contrast of `#rrggbb` colours. */
const luminance = (hex: string): number => {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((at) => {
    const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [lighter = 0, darker = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
};

describe("a tracker's mark", () => {
  it("F-152/c4: each kind's mark renders in both treatments and both themes, the vendor's own drawing in its colours or its one-colour version", async () => {
    for (const kind of trackerMarkKinds) {
      for (const mono of [false, true]) {
        const vendor = await logoPaths(logoFile(kind, mono));
        const drawn = themes.map((theme) => render(theme, { kind, size: 16, mono }));
        // The theme is the page's: the mark's markup is the same in both, and follows it only by tokens.
        expect(
          drawn[0]?.replace('data-theme="dark"', ""),
          `${kind} ${mono ? "mono" : "brand"}`,
        ).toBe(drawn[1]?.replace('data-theme="light"', ""));
        for (const html of drawn) {
          const svg = svgOf(html);
          expect(attr(svg, "viewBox")).toBe("0 0 24 24");
          expect(attr(svg, "data-tracker-mark")).toBe(kind);
          expect(attr(svg, "data-treatment")).toBe(mono ? "mono" : "brand");
          const paths = pathsOf(html);
          // Unaltered: the targets' files' paths, in their order (html/logos/).
          expect(paths.map((p) => p.d)).toEqual(vendor);
          if (mono) {
            // One colour: the caller's (the key's `--faint`), and no colour of the mark's own.
            expect(paths).toEqual([{ d: vendor[0], fill: "currentColor", className: undefined }]);
            expect(html).not.toMatch(/#[0-9a-f]{6}/i);
            continue;
          }
          switch (kind) {
            case "linear":
              expect(paths).toEqual([{ d: vendor[0], fill: "#5E6AD2", className: undefined }]);
              break;
            case "notion":
              expect(paths).toEqual([{ d: vendor[0], fill: undefined, className: "fill-text" }]);
              break;
            case "jira":
            case "trello":
              expect(paths).toEqual([
                {
                  d: vendor[0],
                  fill: kind === "jira" ? "#1868DB" : "#1558BC",
                  className: undefined,
                },
                { d: vendor[1], fill: "#FFFFFF", className: undefined },
              ]);
              break;
            default:
              kind satisfies never;
          }
        }
      }
    }
  });

  it("F-152/c4: in both themes each mark stands out from every surface it's drawn on, at 3:1, or carries its glyph on its own tile", async () => {
    const tokens = await themeTokens();
    for (const theme of themes) {
      const colour = (name: string): string => {
        const value = tokens[theme].get(name);
        if (value === undefined) throw new Error(`${theme} ${name} not found`);
        return value;
      };
      for (const surface of surfaces) {
        // Graphics: WCAG 1.4.11's 3:1. Linear's disc sits on the page; Notion's is the page's text;
        // a one-colour mark takes the key's `--faint`.
        for (const [what, paint] of [
          ["Linear", trackerBrandColour.linear],
          ["Notion (--text)", colour("--text")],
          ["one colour (--faint)", colour("--faint")],
        ] as const) {
          expect(
            contrast(paint, colour(surface)),
            `${theme}: ${what} on ${surface}`,
          ).toBeGreaterThanOrEqual(3);
        }
      }
      for (const tile of [trackerBrandColour.jira, trackerBrandColour.trello]) {
        expect(contrast("#FFFFFF", tile), `${theme}: the glyph on ${tile}`).toBeGreaterThanOrEqual(
          3,
        );
      }
    }
  });

  it("F-152/c4: a mark that stands alone is an image labelled with its tracker's name, and beside a word that names it, it's hidden", () => {
    for (const kind of trackerMarkKinds) {
      for (const mono of [false, true]) {
        const alone = svgOf(render("dark", { kind, size: 14, mono }));
        expect(attr(alone, "role")).toBe("img");
        expect(attr(alone, "aria-label")).toBe(trackerName[kind]);
        expect(attr(alone, "aria-hidden")).toBeUndefined();
        const beside = svgOf(render("light", { kind, size: 14, mono, label: false }));
        expect(attr(beside, "aria-hidden")).toBe("true");
        expect(attr(beside, "role")).toBeUndefined();
        expect(attr(beside, "aria-label")).toBeUndefined();
      }
    }
    expect(trackerName).toEqual({
      linear: "Linear",
      jira: "Jira",
      trello: "Trello",
      notion: "Notion",
    });
  });

  it("F-152/c4: each place draws the targets' size, the brand colour where it names a tracker once and one colour where it repeats (choice 9)", () => {
    const repeats = Object.entries(trackerMarkAt).flatMap(([place, at]) =>
      at.mono ? [place] : [],
    );
    // README "Where each treatment goes": Inbox rows, the sidebar's live tasks, the thread's meta lines, search.
    expect(repeats.sort()).toEqual(["inboxRow", "search", "sidebar", "threadMeta"]);
    expect(trackerMarkAt).toMatchObject({
      trackersRow: { size: 20 },
      boardRow: { size: 18 },
      picker: { size: 32 },
      connectionHeader: { size: 36 },
      property: { size: 16 },
      taskHeader: { size: 14 },
      inboxRow: { size: 14 },
      threadMeta: { size: 13 },
      sidebar: { size: 12 },
    });
    for (const [place, at] of Object.entries(trackerMarkAt)) {
      const svg = svgOf(render("dark", { kind: "jira", ...at }));
      expect([attr(svg, "width"), attr(svg, "height")], place).toEqual([
        String(at.size),
        String(at.size),
      ]);
      expect(at.size, place).toBeGreaterThanOrEqual(12);
      expect(at.size, place).toBeLessThanOrEqual(36);
    }
  });

  it("F-152/c8: Trello's and Notion's marks exist for the picker's Coming soon row, labelled, in their own colours", async () => {
    expect(trackerMarkKinds).toEqual(expect.arrayContaining(["trello", "notion"]));
    for (const kind of ["trello", "notion"] as const) {
      for (const theme of themes) {
        const html = render(theme, { kind, ...trackerMarkAt.pickerComingSoon });
        const svg = svgOf(html);
        expect([
          attr(svg, "width"),
          attr(svg, "role"),
          attr(svg, "aria-label"),
          attr(svg, "data-treatment"),
        ]).toEqual(["22", "img", trackerName[kind], "brand"]);
        expect(pathsOf(html).map((p) => p.d)).toEqual(await logoPaths(`${kind}.svg`));
      }
    }
  });
});
