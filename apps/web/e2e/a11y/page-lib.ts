// F-081 (ticket 17): the code the keyboard walk and the contrast check run inside the page.
// `installA11y` is handed to `page.addInitScript`, which sends its source to the browser, so it
// reads nothing from this module's scope: every helper it uses is defined inside it.

/** One text node, placeholder or control edge under its threshold, or a disabled control's (listed, not failed). */
export type ContrastFinding = {
  readonly kind: "text" | "placeholder" | "boundary";
  readonly role: string;
  readonly text: string;
  readonly ratio: number;
  readonly required: number;
  readonly fg: string;
  readonly bg: string;
  readonly disabled: boolean;
  /** Drawn over a picture (an `<img>` behind it), where no colour can be computed: listed, not failed. */
  readonly overImage: boolean;
};

/** The element that has the focus, as the walk records it. */
export type FocusedElement = {
  /** Its place in document order among the tabbable elements `mark` counted, or -1 for one it didn't count. */
  readonly index: number;
  readonly role: string;
  readonly name: string;
  /** Inside the scope the walk runs in (the page, or an open dialog). */
  readonly inside: boolean;
  /** A keyboard-focusable scroll area (Chrome makes one focusable when nothing in it is). */
  readonly scroller: boolean;
  readonly indicator: { readonly kind: "outline" | "ring" | "none"; readonly width: number; readonly ratio: number };
};

export type A11yApi = {
  /** Numbers the visible tabbable elements in `scope` (a selector, or the whole page) in document order; returns how many. */
  readonly mark: (scope: string | null) => number;
  /** The `name` of each element `mark` numbered, in its order. */
  readonly marked: () => readonly string[];
  /** The focused element, or null when the focus is on the page itself. */
  readonly focused: (scope: string | null) => FocusedElement | null;
  /** Every visible text node, placeholder and control edge in `scope` whose contrast is under its threshold, and every disabled one. */
  readonly contrast: (scope: string | null) => readonly ContrastFinding[];
  /** The page's own `color-scheme`, which says which theme it's drawn in. */
  readonly scheme: () => string;
};

declare global {
  var __ostraA11y: A11yApi | undefined;
}

export const installA11y = (): void => {
  type Rgba = readonly [number, number, number, number];

  let context: CanvasRenderingContext2D | null = null;
  const parsed = new Map<string, Rgba>();

  /** Any CSS colour Chrome computes, in sRGB with alpha: `rgb()` directly, the rest through a 1px canvas. */
  const parse = (css: string): Rgba => {
    const known = parsed.get(css);
    if (known !== undefined) return known;
    let result: Rgba = [0, 0, 0, 0];
    const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(css);
    const srgb = /^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(css);
    const alpha = (raw: string | undefined): number => (raw === undefined ? 1 : raw.endsWith("%") ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw));
    if (rgb !== null) {
      result = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), alpha(rgb[4])];
    } else if (srgb !== null) {
      result = [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, alpha(srgb[4])];
    } else if (css !== "transparent" && css !== "") {
      if (context === null) {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        context = canvas.getContext("2d", { willReadFrequently: true });
      }
      if (context !== null) {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = "#000";
        context.fillStyle = css;
        context.fillRect(0, 0, 1, 1);
        const data = context.getImageData(0, 0, 1, 1).data;
        result = [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, (data[3] ?? 0) / 255];
      }
    }
    parsed.set(css, result);
    return result;
  };

  /** `top` drawn over `bottom` (which is opaque). */
  const over = (top: Rgba, bottom: Rgba): Rgba => {
    const a = top[3];
    return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
  };

  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (color: Rgba): number => 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2]);
  const ratio = (a: Rgba, b: Rgba): number => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
  };
  const hex = (color: Rgba): string =>
    `#${[color[0], color[1], color[2]].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;

  /** The opaque colour behind `element`: its own background and its ancestors', composited, starting from the page's. */
  const backgroundOf = (element: Element | null): Rgba => {
    const layers: Rgba[] = [];
    for (let node = element; node !== null; node = node.parentElement) {
      const color = parse(getComputedStyle(node).backgroundColor);
      if (color[3] > 0) layers.push(color);
      if (color[3] >= 1) break;
    }
    let base: Rgba = [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i -= 1) {
      const layer = layers[i];
      if (layer !== undefined) base = over(layer, base);
    }
    return base;
  };

  /** The product of `opacity` from the element up: a faded group fades its text too. */
  const opacityOf = (element: Element): number => {
    let product = 1;
    for (let node: Element | null = element; node !== null; node = node.parentElement) product *= Number.parseFloat(getComputedStyle(node).opacity);
    return product;
  };

  const scopeRoot = (scope: string | null): Element | null => (scope === null ? document.body : document.querySelector(scope));

  const visible = (element: Element): boolean => {
    if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const box = element.getBoundingClientRect();
    return box.width > 1 && box.height > 1;
  };

  const disabledControl = (element: Element): boolean =>
    element.closest(':disabled, [aria-disabled="true"], [data-disabled]:not([data-disabled="false"])') !== null;

  const implicitRole = (element: Element): string => {
    const explicit = element.getAttribute("role");
    if (explicit !== null) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return element.hasAttribute("href") ? "link" : "text";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = element.getAttribute("type") ?? "text";
      return type === "checkbox" || type === "radio" ? type : type === "submit" || type === "button" ? "button" : "textbox";
    }
    if (/^h[1-6]$/.test(tag)) return "heading";
    return tag;
  };

  /** The role a reader would name a text node by: the control it sits in, else its own element's. */
  const roleOf = (element: Element): string => {
    const control = element.closest("a[href], button, [role], input, select, textarea, label, h1, h2, h3, h4, h5, h6");
    return implicitRole(control ?? element);
  };

  const nameOf = (element: Element): string => {
    const label = element.getAttribute("aria-label") ?? element.getAttribute("placeholder") ?? element.getAttribute("title");
    const text = label ?? element.textContent;
    return text.replace(/\s+/g, " ").trim().slice(0, 60);
  };

  const tabbableSelector =
    'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable="true"], audio[controls], video[controls]';

  /** Visible, enabled and in the Tab order; of a native radio group, only the stop Chrome gives it. */
  const tabbables = (root: Element): HTMLElement[] => {
    const found: HTMLElement[] = [];
    const radioStops = new Map<string, HTMLInputElement>();
    for (const element of root.querySelectorAll<HTMLElement>(tabbableSelector)) {
      if (element.tabIndex < 0) continue;
      if (element.closest("[inert]") !== null) continue;
      if ((element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) && element.disabled) continue;
      if (element.closest("fieldset:disabled") !== null) continue;
      if (!element.checkVisibility({ visibilityProperty: true }) || element.getClientRects().length === 0) continue;
      if (element instanceof HTMLInputElement && element.type === "radio" && element.name !== "") {
        const stop = radioStops.get(element.name);
        if (stop === undefined || (!stop.checked && element.checked)) {
          if (stop !== undefined) found.splice(found.indexOf(stop), 1);
          radioStops.set(element.name, element);
          found.push(element);
        }
        continue;
      }
      found.push(element);
    }
    // A roving group's own stop (Radix gives the group `tabindex=0` and hands its focus to the
    // current item) is the item's when the item is in the Tab order too: one stop, not two.
    const roving = '[tabindex][role="radiogroup"], [tabindex][role="toolbar"], [tabindex][role="tablist"], [tabindex][role="group"], [tabindex][role="menubar"], [tabindex][data-orientation]:not(a, button, input, select, textarea)';
    return found.filter((element) => !(element.matches(roving) && found.some((other) => other !== element && element.contains(other))));
  };

  let numbered: HTMLElement[] = [];

  const mark = (scope: string | null): number => {
    for (const element of document.querySelectorAll("[data-a11y-i]")) element.removeAttribute("data-a11y-i");
    const root = scopeRoot(scope);
    numbered = root === null ? [] : tabbables(root);
    numbered.forEach((element, index) => {
      element.setAttribute("data-a11y-i", String(index));
    });
    return numbered.length;
  };

  /** A box-shadow's rings: a shadow with no offset and no blur whose spread is the width. */
  const rings = (shadow: string): { color: string; width: number }[] => {
    if (shadow === "none") return [];
    const found: { color: string; width: number }[] = [];
    for (const part of shadow.split(/,(?![^(]*\))/)) {
      const color = /(rgba?\([^)]*\)|color\([^)]*\)|oklab\([^)]*\)|oklch\([^)]*\)|#[0-9a-f]+)/i.exec(part)?.[1] ?? "";
      const lengths = part
        .replace(color, "")
        .replace("inset", "")
        .trim()
        .split(/\s+/)
        .map((length) => Number.parseFloat(length));
      const [x = 0, y = 0, blur = 0, spread = 0] = lengths;
      if (x === 0 && y === 0 && blur === 0 && spread > 0 && color !== "") found.push({ color, width: spread });
    }
    return found;
  };

  /**
   * The focus indicator: a 2px or wider outline, else a ring, and its contrast with what's behind
   * it. A field drawn inside a box (the composers) may show it on the box: the nearest of its three
   * ancestors that draws one.
   */
  const indicator = (element: Element): FocusedElement["indicator"] => {
    let found = ownIndicator(element);
    for (let box = element.parentElement, depth = 0; found.kind === "none" && box !== null && depth < 3; box = box.parentElement, depth += 1) {
      found = ownIndicator(box);
    }
    return found;
  };

  const ownIndicator = (element: Element): FocusedElement["indicator"] => {
    const style = getComputedStyle(element);
    const behind = backgroundOf(element.parentElement);
    const width = Number.parseFloat(style.outlineWidth);
    if (style.outlineStyle !== "none" && width > 0) {
      const color = parse(style.outlineColor);
      const against = Number.parseFloat(style.outlineOffset) < 0 ? backgroundOf(element) : behind;
      return { kind: "outline", width, ratio: color[3] === 0 ? 1 : ratio(over(color, against), against) };
    }
    const best = rings(style.boxShadow)
      .map((ring) => {
        const color = parse(ring.color);
        return { width: ring.width, ratio: color[3] === 0 ? 1 : ratio(over(color, behind), behind) };
      })
      .sort((a, b) => b.ratio - a.ratio)[0];
    if (best !== undefined) return { kind: "ring", width: best.width, ratio: best.ratio };
    return { kind: "none", width: 0, ratio: 1 };
  };

  const isScroller = (element: Element): boolean => {
    const style = getComputedStyle(element);
    const scrolls = (overflow: string) => overflow === "auto" || overflow === "scroll";
    return (scrolls(style.overflowY) && element.scrollHeight > element.clientHeight) || (scrolls(style.overflowX) && element.scrollWidth > element.clientWidth);
  };

  const focused = (scope: string | null): FocusedElement | null => {
    const active = document.activeElement;
    // A chart is an `<svg role="img" tabindex="0">`: an SVG element takes the focus too.
    if (!(active instanceof HTMLElement || active instanceof SVGElement) || active === document.body || active === document.documentElement) return null;
    const root = scopeRoot(scope);
    // A roving group (Radix's radio groups, toggle groups) is one stop: Tab lands on the group,
    // which hands the focus to its current item. That item reaches the group's stop.
    const stop = active.closest("[data-a11y-i]");
    const index = Number.parseInt(stop?.getAttribute("data-a11y-i") ?? "-1", 10);
    return {
      index,
      role: implicitRole(active),
      name: nameOf(active),
      inside: root?.contains(active) ?? false,
      scroller: index === -1 && isScroller(active),
      indicator: indicator(active),
    };
  };

  const isLarge = (style: CSSStyleDeclaration): boolean => {
    const size = Number.parseFloat(style.fontSize);
    const weight = Number.parseInt(style.fontWeight, 10);
    return size >= 24 || (size >= 18.66 && weight >= 700);
  };

  const fieldSelector = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="range"]), textarea, select, [role="combobox"], [role="checkbox"], [role="switch"], [role="radio"], input[type="checkbox"], input[type="radio"]';
  const buttonSelector = 'button:not([role]), [role="button"], [data-slot="button"]';

  /** A picture under the element's middle that isn't inside it: the text is drawn over an image. */
  const overPicture = (element: Element): boolean => {
    const box = element.getBoundingClientRect();
    const stack = document.elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return stack.some((under) => !under.contains(element) && !element.contains(under) && (under instanceof HTMLImageElement || under instanceof HTMLVideoElement || under instanceof HTMLCanvasElement));
  };

  const contrast = (scope: string | null): ContrastFinding[] => {
    const root = scopeRoot(scope);
    if (root === null) return [];
    const findings: ContrastFinding[] = [];
    const record = (finding: Omit<ContrastFinding, "overImage">, element: Element): void => {
      if (!finding.disabled && finding.ratio >= finding.required) return;
      findings.push({ ...finding, overImage: finding.ratio < finding.required && overPicture(element) });
    };

    // Every visible text node: its colour (an SVG text's fill), faded by any opacity above it, over what's behind it.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const seen = new Set<Element>();
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      const element = node.parentElement;
      if (text === "" || element === null || seen.has(element)) continue;
      if (element.closest("script, style, noscript, template, title") !== null) continue;
      if (!visible(element)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      if (![...range.getClientRects()].some((rect) => rect.width > 1 && rect.height > 1)) continue;
      seen.add(element);
      const style = getComputedStyle(element);
      const svgText = element instanceof SVGElement;
      const raw = parse(svgText ? style.fill : style.color);
      const faded: Rgba = [raw[0], raw[1], raw[2], raw[3] * opacityOf(element)];
      const bg = backgroundOf(element);
      const fg = over(faded, bg);
      record({
        kind: "text",
        role: roleOf(element),
        text: text.slice(0, 60),
        ratio: ratio(fg, bg),
        required: isLarge(style) ? 3 : 4.5,
        fg: hex(fg),
        bg: hex(bg),
        disabled: disabledControl(element),
      }, element);
    }

    // Placeholders, in an empty field.
    for (const field of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input[placeholder], textarea[placeholder]")) {
      if (field.value !== "" || field.placeholder.trim() === "" || !visible(field)) continue;
      const style = getComputedStyle(field, "::placeholder");
      const raw = parse(style.color);
      const bg = backgroundOf(field);
      const fg = over([raw[0], raw[1], raw[2], raw[3] * opacityOf(field)], bg);
      record({
        kind: "placeholder",
        role: implicitRole(field),
        text: field.placeholder.slice(0, 60),
        ratio: ratio(fg, bg),
        required: isLarge(getComputedStyle(field)) ? 3 : 4.5,
        fg: hex(fg),
        bg: hex(bg),
        disabled: disabledControl(field),
      }, field);
    }

    // The edges of fields and buttons: a field's border (or its fill) against what's around it,
    // 3:1. A button drawn with no border and no fill of its own is its text alone, and that text
    // is checked above. A borderless field inside a bordered box (the composers) is that box's.
    const boundary = (element: Element, box: boolean): { ratio: number; fg: Rgba; bg: Rgba } | null => {
      const style = getComputedStyle(element);
      // A button's edge is a box drawn all round; a row's hairline above or below isn't one.
      const sides = ["top", "right", "bottom", "left"].filter((side) => Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0 && parse(style.getPropertyValue(`border-${side}-color`))[3] > 0);
      // A button with no box of its own (a fill alone, a row's highlight) is identified by its words,
      // and so is a filled one whose border is its fill (primary, amber): there's no line to see.
      if (box && sides.length < 4) return null;
      if (box && style.borderTopColor === style.backgroundColor) return null;
      const outside = backgroundOf(element.parentElement);
      const fill = parse(style.backgroundColor);
      const fillRatio = fill[3] === 0 ? 1 : ratio(over(fill, outside), outside);
      let best: { ratio: number; fg: Rgba; bg: Rgba } | null = fill[3] === 0 ? null : { ratio: fillRatio, fg: over(fill, outside), bg: outside };
      for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
        const width = Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`));
        const color = parse(style.getPropertyValue(`border-${side.toLowerCase()}-color`));
        if (width <= 0 || color[3] === 0 || style.getPropertyValue(`border-${side.toLowerCase()}-style`) === "none") continue;
        const drawn = over(color, outside);
        const edge = ratio(drawn, outside);
        if (best === null || edge > best.ratio) best = { ratio: edge, fg: drawn, bg: outside };
      }
      return best;
    };

    for (const element of root.querySelectorAll(fieldSelector)) {
      if (!visible(element)) continue;
      // A field drawn by the box around it (a composer, a segmented control's group): the best edge
      // of the field and its three nearest ancestors.
      let edge = boundary(element, false);
      for (let box = element.parentElement, depth = 0; (edge === null || edge.ratio < 3) && box !== null && depth < 3; box = box.parentElement, depth += 1) {
        const outer = boundary(box, false);
        if (outer !== null && (edge === null || outer.ratio > edge.ratio)) edge = outer;
      }
      record({
        kind: "boundary",
        role: implicitRole(element),
        text: nameOf(element),
        ratio: edge?.ratio ?? 1,
        required: 3,
        fg: hex(edge?.fg ?? [0, 0, 0, 1]),
        bg: hex(edge?.bg ?? [0, 0, 0, 1]),
        disabled: disabledControl(element),
      }, element);
    }

    for (const element of root.querySelectorAll(buttonSelector)) {
      if (!visible(element) || element.matches(fieldSelector)) continue;
      const edge = boundary(element, true);
      // A text-only button (no edge of its own): its words are what identify it.
      if (edge === null) continue;
      if (edge.ratio < 1.05) continue;
      record({
        kind: "boundary",
        role: implicitRole(element),
        text: nameOf(element),
        ratio: edge.ratio,
        required: 3,
        fg: hex(edge.fg),
        bg: hex(edge.bg),
        disabled: disabledControl(element),
      }, element);
    }
    return findings;
  };

  globalThis.__ostraA11y = {
    mark,
    marked: () => numbered.map((element) => `${implicitRole(element)} "${nameOf(element)}"`),
    focused,
    contrast,
    scheme: () => getComputedStyle(document.documentElement).colorScheme,
  };
};
