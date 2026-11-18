"""Build ostra's derived brand files from the approved logo, palette and fonts.

Every file in context/brand/files/ comes from this script. The approved mark is
placed, never redrawn: each file nests the untouched exports from
kit/logo/export/ and only scales and positions them. Text is outlined from the
OFL fonts in context/brand/fonts/, so no file needs a font installed.

Dark first (brief.md): Abyss is the default background, Shell the default ink.

Run from the repo root, with rsvg-convert and hb-shape (MSYS2 ucrt64) on PATH:

    PATH="/c/msys64/ucrt64/bin:$PATH" python context/brand/scripts/build-assets.py
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from PIL import Image

BRAND = Path(__file__).resolve().parents[1]
EXPORT = BRAND / "kit" / "logo" / "export"
FONTS = BRAND / "fonts"
OUT = BRAND / "files"

# The approved palette (brief.md, brandkit state revision 2).
PALETTE = {
    "abyss": "#0C1D21",
    "shell": "#F3F0E8",
    "kelp": "#2F4A47",
    "mist": "#CFD8D4",
    "buoy-amber": "#FFB224",
}
ABYSS, SHELL, KELP, MIST = (PALETTE[k] for k in ("abyss", "shell", "kelp", "mist"))

WORDMARK = "ostra"
HEADLINE = ("The source-available, self-hosted", "control plane for coding agents.")
SUBLINE = "Your agents. Your machines. Your tracker."

# Lockup proportions, in units of the wordmark's ascender height.
HORIZONTAL_GAP = 0.34
STACKED_MARK = 1.60
STACKED_GAP = 0.45


def tool(name: str) -> str:
    found = shutil.which(name)
    if not found:
        raise SystemExit(f"{name} not found on PATH (put MSYS2's ucrt64/bin on PATH)")
    return found


def svg_doc(view_box: tuple[float, float, float, float], body: str, size: tuple[int, int] | None = None) -> str:
    x, y, w, h = view_box
    dims = f' width="{size[0]}" height="{size[1]}"' if size else ""
    return f'<svg xmlns="http://www.w3.org/2000/svg"{dims} viewBox="{x:g} {y:g} {w:g} {h:g}">{body}</svg>\n'


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def rasterize(svg: Path, png: Path, width: int, height: int | None = None, opaque: bool = False) -> Path:
    png.parent.mkdir(parents=True, exist_ok=True)
    args = [tool("rsvg-convert"), "--format", "png", "--width", str(width)]
    if height:
        args += ["--height", str(height)]
    subprocess.run([*args, "--output", str(png), str(svg)], check=True)
    if opaque:
        Image.open(png).convert("RGB").save(png)
    return png


class Mark:
    """An exported mark variant, placed without changing its geometry."""

    def __init__(self, stem: str) -> None:
        source = (EXPORT / f"{stem}.svg").read_text(encoding="utf-8")
        self.source = re.sub(r"^<\?xml[^>]*>\s*", "", source).strip()
        alpha = Image.open(EXPORT / f"{stem}-2048.png").convert("RGBA").getchannel("A")
        bbox = alpha.getbbox()
        if bbox is None:
            raise SystemExit(f"{stem}-2048.png is empty")
        left, top, right, bottom = bbox
        self.box = (left, top, right - left, bottom - top)

    @property
    def aspect(self) -> float:
        return self.box[2] / self.box[3]

    def place(self, x: float, y: float, height: float) -> str:
        bx, by, bw, bh = self.box
        width = height * self.aspect
        return (
            f'<svg x="{x:g}" y="{y:g}" width="{width:g}" height="{height:g}" '
            f'viewBox="{bx} {by} {bw} {bh}">{self.source}</svg>'
        )


@dataclass(frozen=True)
class Outline:
    """Outlined text in pixels, baseline at y=0 unless shifted when drawn."""

    d: str
    bounds: tuple[float, float, float, float]
    advance: float

    @property
    def width(self) -> float:
        return self.bounds[2] - self.bounds[0]


class Face:
    """One OFL font at one design-space location."""

    def __init__(self, file: str, location: dict[str, float]) -> None:
        self.path = FONTS / file
        self.location = location
        self.font = TTFont(self.path)
        self.order = self.font.getGlyphOrder()
        self.upm = self.font["head"].unitsPerEm
        self.glyphs = self.font.getGlyphSet(location=location) if location else self.font.getGlyphSet()

    def ascender(self, size: float) -> float:
        """Height of a lowercase 'h' at this size: the line the mark aligns to."""
        pen = BoundsPen(self.glyphs)
        self.glyphs[self.font.getBestCmap()[ord("h")]].draw(pen)
        if pen.bounds is None:
            raise SystemExit(f"{self.path.name} has no 'h'")
        return pen.bounds[3] * size / self.upm

    def outline(self, text: str, size: float, x: float = 0, y: float = 0) -> Outline:
        args = [tool("hb-shape"), f"--font-file={self.path}", "--output-format=json", "--no-glyph-names"]
        if self.location:
            args.append("--variations=" + ",".join(f"{k}={v:g}" for k, v in self.location.items()))
        shaped = json.loads(subprocess.run([*args, text], check=True, capture_output=True, text=True).stdout)
        scale = size / self.upm
        path_pen, bounds_pen = SVGPathPen(self.glyphs), BoundsPen(self.glyphs)
        cursor = 0.0
        for item in shaped:
            name = self.order[item["g"]]
            offset = (scale, 0, 0, -scale, x + (cursor + item["dx"]) * scale, y - item["dy"] * scale)
            self.glyphs[name].draw(TransformPen(path_pen, offset))
            self.glyphs[name].draw(TransformPen(bounds_pen, offset))
            cursor += item["ax"]
        if bounds_pen.bounds is None:
            raise SystemExit(f"nothing to outline in {text!r}")
        return Outline(path_pen.getCommands(), bounds_pen.bounds, cursor * scale)


DISPLAY = Face("Manrope[wght].ttf", {"wght": 800})
BODY = Face("IBMPlexSans[wdth,wght].ttf", {"wght": 400, "wdth": 100})

# A theme: what sits on which background (dark first).
THEMES = {
    "shell": {"background": ABYSS, "ink": SHELL, "muted": MIST, "mark": "ostra-hinge-single-color"},
    "abyss": {"background": SHELL, "ink": ABYSS, "muted": KELP, "mark": "ostra-hinge"},
}


def lockup_horizontal(mark: Mark, ink: str, height: float, x: float = 0, y: float = 0) -> tuple[str, float]:
    """A horizontal lockup whose mark is `height` tall, top-left at (x, y). Returns (svg, width)."""
    size = height / DISPLAY.ascender(1)
    word = DISPLAY.outline(WORDMARK, size)
    mark_w = height * mark.aspect
    gap = HORIZONTAL_GAP * height
    shift = x + mark_w + gap - word.bounds[0]
    body = mark.place(x, y, height) + f'<path fill="{ink}" transform="translate({shift:g} {y + height:g})" d="{word.d}"/>'
    return body, mark_w + gap + word.width


def build_logo_files() -> None:
    for suffix, theme in THEMES.items():
        mark, ink = Mark(theme["mark"]), theme["ink"]
        word = DISPLAY.outline(WORDMARK, 100)
        ascender = DISPLAY.ascender(100)
        xmin, ymin, xmax, ymax = word.bounds
        path = f'<path fill="{ink}" d="{word.d}"/>'
        write(OUT / "logo" / f"wordmark-{suffix}.svg", svg_doc((xmin, ymin, xmax - xmin, ymax - ymin), path))

        body, width = lockup_horizontal(mark, ink, ascender, 0, -ascender)
        top = min(-ascender, ymin)
        h_svg = write(OUT / "logo" / f"lockup-horizontal-{suffix}.svg", svg_doc((0, top, width, max(ymax, 0) - top), body))

        stack_h = STACKED_MARK * ascender
        stack_w = stack_h * mark.aspect
        stack_top = -ascender - STACKED_GAP * ascender - stack_h
        stacked = mark.place(xmin + (xmax - xmin - stack_w) / 2, stack_top, stack_h) + path
        s_svg = write(OUT / "logo" / f"lockup-stacked-{suffix}.svg",
                      svg_doc((xmin, stack_top, xmax - xmin, ymax - stack_top), stacked))

        rasterize(h_svg, OUT / "logo" / f"lockup-horizontal-{suffix}-1600.png", 1600)
        rasterize(s_svg, OUT / "logo" / f"lockup-stacked-{suffix}-1200.png", 1200)
        if suffix == "abyss":
            # Emails are mostly read on light backgrounds.
            rasterize(h_svg, OUT / "web" / "email-logo@2x.png", 400)


def tile_svg(mark: Mark, size: int, mark_ratio: float, background: str | None, radius_ratio: float = 0.0) -> str:
    mark_h = size * mark_ratio / max(mark.aspect, 1)
    mark_w = mark_h * mark.aspect
    tile = (
        f'<rect width="{size}" height="{size}" rx="{size * radius_ratio:g}" fill="{background}"/>'
        if background else ""
    )
    return svg_doc((0, 0, size, size), tile + mark.place((size - mark_w) / 2, (size - mark_h) / 2, mark_h), (size, size))


def build_icons() -> None:
    abyss_mark, shell_mark = Mark("ostra-hinge"), Mark("ostra-hinge-single-color")
    web = OUT / "web"

    # favicon.svg follows the browser: the Abyss mark on light tabs, the Shell mark on dark ones.
    size, ratio = 64, 0.88
    mark_h = size * ratio
    place = lambda mark: mark.place((size - mark_h * mark.aspect) / 2, (size - mark_h) / 2, mark_h)  # noqa: E731
    style = "<style>.dark{display:none}@media (prefers-color-scheme:dark){.light{display:none}.dark{display:inline}}</style>"
    favicon = style + f'<g class="light">{place(abyss_mark)}</g><g class="dark">{place(shell_mark)}</g>'
    write(web / "favicon.svg", svg_doc((0, 0, size, size), favicon, (size, size)))

    # favicon.ico has no media queries: the Abyss mark, for the light tabs most fallbacks sit on.
    plain = write(web / ".favicon.svg", tile_svg(abyss_mark, 64, ratio, None))
    ico_sizes = (16, 32, 48)
    frames = [Image.open(rasterize(plain, web / f".favicon-{s}.png", s)) for s in ico_sizes]
    frames[-1].save(web / "favicon.ico", format="ICO", sizes=[(s, s) for s in ico_sizes], append_images=frames[:-1])

    # Square app-style icons: the Shell mark on Abyss.
    full_bleed = write(web / ".full-bleed.svg", tile_svg(shell_mark, 512, 0.58, ABYSS))
    rounded = write(web / ".rounded.svg", tile_svg(shell_mark, 512, 0.58, ABYSS, 0.22))
    maskable = write(web / ".maskable.svg", tile_svg(shell_mark, 512, 0.46, ABYSS))
    rasterize(full_bleed, web / "apple-touch-icon.png", 180, 180, opaque=True)
    rasterize(rounded, web / "icon-192.png", 192, 192)
    rasterize(rounded, web / "icon-512.png", 512, 512)
    rasterize(maskable, web / "icon-maskable-512.png", 512, 512, opaque=True)
    rasterize(full_bleed, OUT / "integrations" / "app-icon-512.png", 512, 512, opaque=True)
    rasterize(full_bleed, OUT / "github" / "avatar-500.png", 500, 500, opaque=True)
    rasterize(full_bleed, OUT / "registry" / "icon-512.png", 512, 512, opaque=True)

    for temp in (plain, full_bleed, rounded, maskable, *(web / f".favicon-{s}.png" for s in ico_sizes)):
        temp.unlink()

    manifest = {
        "name": "ostra",
        "short_name": "ostra",
        "theme_color": ABYSS,
        "background_color": ABYSS,
        "display": "standalone",
        "icons": [
            {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png"},
            {"src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
    }
    write(web / "site.webmanifest", json.dumps(manifest, indent=2) + "\n")


def banner(width: int, height: int, theme: dict[str, str]) -> str:
    """The lockup, the headline and the proof line on one background, sized to fit."""
    mark = Mark(theme["mark"])
    pad = round(width * 0.075)
    max_text = width - 2 * pad

    lockup, _ = lockup_horizontal(mark, theme["ink"], height * 0.085, pad, pad)

    headline_size = height * 0.095
    widest = max(DISPLAY.outline(line, headline_size).width for line in HEADLINE)
    if widest > max_text:
        headline_size *= max_text / widest
    line_gap = headline_size * 1.18
    sub_size = headline_size * 0.42
    block = line_gap * (len(HEADLINE) - 1) + sub_size * 2.4
    first_baseline = height - pad - block

    text = ""
    for index, line in enumerate(HEADLINE):
        outlined = DISPLAY.outline(line, headline_size, pad, first_baseline + index * line_gap)
        text += f'<path fill="{theme["ink"]}" d="{outlined.d}"/>'
    sub = BODY.outline(SUBLINE, sub_size, pad, first_baseline + line_gap * (len(HEADLINE) - 1) + sub_size * 2.4)
    text += f'<path fill="{theme["muted"]}" d="{sub.d}"/>'

    background = f'<rect width="{width}" height="{height}" fill="{theme["background"]}"/>'
    return svg_doc((0, 0, width, height), background + lockup + text, (width, height))


def build_banners() -> None:
    dark, light = THEMES["shell"], THEMES["abyss"]
    jobs = (
        (OUT / "web" / "og-image", 1200, 630, dark),
        (OUT / "github" / "social-preview", 1280, 640, dark),
        (OUT / "readme" / "header-dark", 1600, 560, dark),
        (OUT / "readme" / "header-light", 1600, 560, light),
    )
    for stem, width, height, theme in jobs:
        svg = write(stem.with_suffix(".svg"), banner(width, height, theme))
        rasterize(svg, stem.with_suffix(".png"), width, height, opaque=True)


def build_tokens() -> None:
    themes = {
        "dark": {
            "background": "abyss", "surface": "kelp", "text": "shell", "text-muted": "mist",
            "line": "kelp", "signal": "buoy-amber", "on-signal": "abyss",
        },
        "light": {
            "background": "shell", "surface": "mist", "text": "abyss", "text-muted": "kelp",
            "line": "mist", "signal": "buoy-amber", "on-signal": "abyss",
        },
    }
    fonts = {
        "display": {"family": "Manrope", "weight": 800},
        "body": {"family": "IBM Plex Sans", "weight": 400},
        "mono": {"family": "IBM Plex Mono", "weight": 400},
    }
    tokens = {"color": PALETTE, "theme": themes, "font": fonts, "default-theme": "dark"}
    write(OUT / "tokens" / "tokens.json", json.dumps(tokens, indent=2) + "\n")

    def theme_block(selector: str, name: str, scheme: str) -> str:
        roles = "\n".join(f"  --{role}: var(--color-{color});" for role, color in themes[name].items())
        return f"{selector} {{\n  color-scheme: {scheme};\n{roles}\n}}\n"

    palette = "\n".join(f"  --color-{name}: {value};" for name, value in PALETTE.items())
    fonts_css = (
        "  --font-display: 'Manrope', system-ui, sans-serif;\n"
        "  --font-body: 'IBM Plex Sans', system-ui, sans-serif;\n"
        "  --font-mono: 'IBM Plex Mono', ui-monospace, monospace;"
    )
    css = (
        "/* ostra brand tokens. Dark first: :root is dark, [data-theme=\"light\"] opts into light. */\n"
        f":root {{\n{palette}\n{fonts_css}\n}}\n\n"
        + theme_block(":root", "dark", "dark") + "\n"
        + theme_block(':root[data-theme="light"]', "light", "light")
    )
    write(OUT / "tokens" / "tokens.css", css)


def main() -> None:
    build_tokens()
    build_logo_files()
    build_icons()
    build_banners()
    for path in sorted(OUT.rglob("*")):
        if path.is_file():
            print(path.relative_to(BRAND).as_posix())


if __name__ == "__main__":
    main()
