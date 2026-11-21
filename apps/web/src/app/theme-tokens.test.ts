import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

// F-082 (ticket 18): the panel's light theme is light-home.md's token table, in both of its blocks
// (`[data-theme="light"]` and "match my system"'s media query), it redefines every colour the dark
// set has, and every text colour passes WCAG AA on every surface it's drawn on, in both themes.

const repo = path.join(import.meta.dirname, "..", "..", "..", "..");
const cssPath = path.join(import.meta.dirname, "globals.css");
const switchPath = path.join(import.meta.dirname, "..", "components", "ui", "switch.tsx");
const lightHomePath = path.join(repo, "context", "brand", "app-targets", "m7", "light-home.md");

type Tokens = ReadonlyMap<string, string>;

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

const declarationsOf = (body: string): Tokens =>
  new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].flatMap(([, name, value]) => (name === undefined || value === undefined ? [] : [[name, value.trim().toLowerCase()]])));

/** The custom properties of the first rule whose selector list is exactly `selector`. */
const ruleTokens = (css: string, selector: string): Tokens | undefined => {
  for (const rule of stripComments(css).matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const selectors = (rule[1] ?? "").split(",").map((part) => part.trim());
    if (selectors.join(",") === selector) return declarationsOf(rule[2] ?? "");
  }
  return undefined;
};

/** The custom properties of `:root:not([data-theme])` inside the `prefers-color-scheme: light` query. */
const systemLightTokens = (css: string): Tokens | undefined => {
  const code = stripComments(css);
  const at = code.indexOf("@media (prefers-color-scheme: light)");
  if (at === -1) return undefined;
  const body = /:root:not\(\[data-theme\]\)\s*\{([^{}]*)\}/.exec(code.slice(at));
  return body === null ? undefined : declarationsOf(body[1] ?? "");
};

/** light-home.md's table: each row's light value, where it's a hex colour. */
const tableOf = (markdown: string): Tokens => {
  const section = markdown.replace(/\r\n/g, "\n").split("\n## The light tokens")[1]?.split("\n## ")[0] ?? "";
  return new Map(
    section
      .split("\n")
      .filter((line) => line.startsWith("| `--"))
      .flatMap((row) => {
        const [names = "", , light = ""] = row.slice(1).split(" | ");
        const name = /^`(--[\w-]+)`(?!,)/.exec(names.trim())?.[1];
        const hex = /#[0-9a-f]{6}\b/i.exec(light)?.[0];
        return name === undefined || hex === undefined ? [] : [[name, hex.toLowerCase()]];
      }),
  );
};

/** The table's names the panel spells otherwise: a meter's track is the hairline it's drawn on. */
const tableAlias: Readonly<Record<string, string>> = { "--track": "--line" };

const required = <T,>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`${what} not found`);
  return value;
};

const read = async () => {
  const [css, lightHome] = await Promise.all([readFile(cssPath, "utf8"), readFile(lightHomePath, "utf8")]);
  return {
    dark: required(ruleTokens(css, ':root,[data-theme="dark"]'), "the dark tokens"),
    light: required(ruleTokens(css, '[data-theme="light"]'), "the light tokens"),
    system: required(systemLightTokens(css), "match my system's light tokens"),
    table: tableOf(lightHome),
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
  const [lighter = 0, darker = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
};

/** A colour over a background: `rgba(...)` composited, `#rrggbb` as it is. */
const solid = (colour: string, background: string): string => {
  const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(colour);
  if (rgba === null) return colour;
  const alpha = Number(rgba[4]);
  return `#${[1, 2, 3]
    .map((at, i) => {
      const under = Number.parseInt(background.slice(1 + i * 2, 3 + i * 2), 16);
      return Math.round(Number(rgba[at]) * alpha + under * (1 - alpha))
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
};

const texts = ["--text", "--text-2", "--muted", "--faint", "--teal", "--green", "--red", "--amber-text"];
const surfaces = ["--bg", "--side", "--surface", "--raise", "--sel"];
/** Brand colours by name and the type scale: the same in both themes. */
const unthemed = new Set(["--shell", "--ink", "--mist", "--fs-xs", "--fs-sm", "--fs-ui", "--fs-body", "--fs-lede", "--fs-title"]);

describe("the panel's light theme", () => {
  it("F-082/c2: the light tokens are light-home.md's table, the same in [data-theme=light] and in match my system's media query", async () => {
    const { light, system, table } = await read();
    expect(table.size).toBeGreaterThanOrEqual(20);
    for (const [name, value] of table) {
      expect(light.get(tableAlias[name] ?? name), `${name} in light`).toBe(value);
    }
    expect([...system.entries()].sort()).toEqual([...light.entries()].sort());
  });

  it("F-082: light redefines every colour the dark set has, so nothing dark shows through", async () => {
    const { dark, light } = await read();
    for (const name of dark.keys()) {
      if (unthemed.has(name)) continue;
      expect(light.has(name), `${name} has a light value`).toBe(true);
    }
  });

  it("F-082/c2: every text colour passes AA (4.5:1) on every surface, and fills carry their text, in both themes", async () => {
    const { dark, light } = await read();
    for (const [theme, tokens] of [
      ["dark", dark],
      ["light", light],
    ] as const) {
      const colour = (name: string): string => required(tokens.get(name), `${theme} ${name}`);
      const pairs: [string, string, number][] = [
        ...texts.flatMap((text) => surfaces.map((surface): [string, string, number] => [colour(text), colour(surface), 4.5])),
        [colour("--on-amber"), colour("--amber"), 4.5],
        [colour("--on-primary"), colour("--primary"), 4.5],
        // The diff: the code and its sign on the line fills (light-task.md).
        [colour("--text"), solid(colour("--diff-add"), colour("--surface")), 4.5],
        [colour("--text"), solid(colour("--diff-del"), colour("--surface")), 4.5],
        [colour("--green"), solid(colour("--diff-add"), colour("--surface")), 4.5],
        [colour("--red"), solid(colour("--diff-del"), colour("--surface")), 4.5],
        // Charts and meters are graphics: 3:1 (WCAG 1.4.11).
        [colour("--chart"), colour("--bg"), 3],
        [colour("--meter"), colour("--line"), 3],
      ];
      for (const [text, surface, minimum] of pairs) {
        expect(contrast(text, surface), `${theme}: ${text} on ${surface}`).toBeGreaterThanOrEqual(minimum);
      }
    }
  });

  it("F-082: a switch that is on is teal in both themes, its knob against its track and its track against every surface at 3:1 (app-design.md, 2026-11-21)", async () => {
    const { dark, light } = await read();
    const source = await readFile(switchPath, "utf8");
    // The on state's track, edge and knob, as the component draws them.
    expect(source).toContain("data-[state=checked]:border-teal data-[state=checked]:bg-teal");
    expect(source).toContain("data-[state=checked]:bg-on-primary");
    expect(source).not.toMatch(/data-\[state=checked\]:(?:bg|border)-(?:green|primary)/);
    for (const [theme, tokens] of [
      ["dark", dark],
      ["light", light],
    ] as const) {
      const colour = (name: string): string => required(tokens.get(name), `${theme} ${name}`);
      expect(contrast(colour("--on-primary"), colour("--teal")), `${theme}: the knob on the track`).toBeGreaterThanOrEqual(3);
      for (const surface of surfaces) {
        expect(contrast(colour("--teal"), colour(surface)), `${theme}: the track on ${surface}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
