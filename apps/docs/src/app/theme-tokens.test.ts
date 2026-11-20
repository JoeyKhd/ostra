import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

// The docs wear the panel's graphite theme (the maintainer, 2026-11-20). The tokens are copied into
// globals.css, not imported (sharing them would need a package), so this test fails when the two
// drift apart, and checks every text colour against every background it's drawn on.

const repo = path.join(import.meta.dirname, "..", "..", "..", "..");
const docsCssPath = path.join(import.meta.dirname, "globals.css");
const panelCssPath = path.join(repo, "apps", "web", "src", "app", "globals.css");
// The panel's light theme is settled by this target's token table until the panel builds it (ticket 18).
const lightHomePath = path.join(repo, "context", "brand", "app-targets", "m7", "light-home.md");

type Tokens = ReadonlyMap<string, string>;

/** Tokens only the docs have: the panel has no 3:1 control border, scrim or dialog shadow token. */
const docsOnly = new Set(["--control", "--overlay", "--dialog-shadow", "--sans", "--mono", "--display"]);

/** Where the panel has no token of the docs' name yet, the one it uses in its place (dark only). */
const panelAlias: Readonly<Record<string, string>> = { "--primary": "--shell", "--on-primary": "--ink" };

/** The tokens every docs page is drawn with; the test fails if one of them stops being shared. */
const sharedTokens = ["--bg", "--surface", "--raise", "--sel", "--line", "--line-2", "--text", "--text-2", "--muted", "--faint", "--teal", "--green", "--red"];

/** The custom properties of the first rule whose selector list holds a selector `matches` accepts. */
const tokensOf = (css: string, matches: (selector: string) => boolean): Tokens | undefined => {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of code.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const selectors = (rule[1] ?? "").split(",").map((selector) => selector.trim());
    if (selectors.some(matches)) {
      const declarations = [...(rule[2] ?? "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)];
      return new Map(declarations.flatMap(([, name, value]) => (name === undefined || value === undefined ? [] : [[name, value.trim().toLowerCase()]])));
    }
  }
  return undefined;
};

const isRoot = (selector: string): boolean => selector === ":root";
const isLight = (selector: string): boolean => /^(:root|html)?\[data-theme="light"\]$/.test(selector);

/** light-home.md's token table: each row's light value, where it's a colour. */
const lightTableOf = (markdown: string): Tokens => {
  const section = markdown.replace(/\r\n/g, "\n").split("\n## The light tokens")[1]?.split("\n## ")[0] ?? "";
  const rows = section.split("\n").filter((line) => line.startsWith("| `--"));
  return new Map(
    rows.flatMap((row) => {
      const [names = "", , light = ""] = row.slice(1).split(" | ");
      // A row names one token (`--primary` (**new**)); the brand constants' row lists three and stays unchanged.
      const name = /^`(--[\w-]+)`(?!,)/.exec(names.trim())?.[1];
      const hex = /#[0-9a-f]{6}\b/i.exec(light)?.[0];
      return name === undefined || hex === undefined ? [] : [[name, hex.toLowerCase()]];
    }),
  );
};

const required = <T,>(value: T | undefined, what: string): T => {
  if (value === undefined) {
    throw new Error(`${what} not found`);
  }
  return value;
};

const read = async () => {
  const [docsCss, panelCss, lightHome] = await Promise.all([readFile(docsCssPath, "utf8"), readFile(panelCssPath, "utf8"), readFile(lightHomePath, "utf8")]);
  const panelLight = tokensOf(panelCss, isLight);
  return {
    docsDark: required(tokensOf(docsCss, isRoot), "the docs' :root tokens"),
    docsLight: required(tokensOf(docsCss, isLight), "the docs' light tokens"),
    panelDark: required(tokensOf(panelCss, isRoot), "the panel's :root tokens"),
    // The panel's own light block once ticket 18 adds it, the target's table until then.
    panelLight: panelLight ?? lightTableOf(lightHome),
  };
};

/** WCAG 2.2 relative luminance of a `#rrggbb` colour. */
const luminance = (hex: string): number => {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((at) => {
    const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
};

const expectShared = (docs: Tokens, panel: Tokens, aliases: Readonly<Record<string, string>>) => {
  for (const name of sharedTokens) {
    expect(docs.has(name), `the docs define ${name}`).toBe(true);
  }
  for (const [name, value] of docs) {
    if (docsOnly.has(name)) {
      continue;
    }
    const alias = aliases[name];
    const panelValue = panel.get(name) ?? (alias === undefined ? undefined : panel.get(alias));
    expect(panelValue, `${name} is the panel's (or listed as docs-only)`).toBe(value);
  }
};

describe("the docs site's theme", () => {
  it("F-058: dark is the panel's graphite: every token the docs share with apps/web has its value", async () => {
    const { docsDark, panelDark } = await read();
    expectShared(docsDark, panelDark, panelAlias);
  });

  it("F-058: light is the panel's light theme: every shared token has its value, and light redefines every colour dark sets", async () => {
    const { docsDark, docsLight, panelLight } = await read();
    expectShared(docsLight, panelLight, {});
    const fonts = new Set(["--sans", "--mono", "--display"]);
    expect([...docsLight.keys()].sort()).toEqual([...docsDark.keys()].filter((name) => !fonts.has(name)).sort());
  });

  it("F-058: every text colour passes WCAG AA (4.5:1) on every background, and control borders 3:1, in both themes", async () => {
    const { docsDark, docsLight } = await read();
    for (const [theme, tokens] of [
      ["dark", docsDark],
      ["light", docsLight],
    ] as const) {
      const colour = (name: string): string => required(tokens.get(name), `${theme} ${name}`);
      const pairs: [string, string, number][] = [
        ...["--text", "--text-2", "--muted", "--faint", "--teal", "--green", "--red"].flatMap((text) =>
          ["--bg", "--surface", "--raise", "--sel"].map((background): [string, string, number] => [text, background, 4.5]),
        ),
        // The search's match highlight, and the one primary button.
        ["--text", "--line-2", 4.5],
        ["--on-primary", "--primary", 4.5],
        // Field, button and chip borders (WCAG 1.4.11).
        ...["--bg", "--surface", "--raise"].map((background): [string, string, number] => ["--control", background, 3]),
      ];
      for (const [text, background, minimum] of pairs) {
        expect(contrast(colour(text), colour(background)), `${theme}: ${text} on ${background}`).toBeGreaterThanOrEqual(minimum);
      }
    }
  });
});
