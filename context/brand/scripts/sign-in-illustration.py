"""Grade the sign-in illustration (B-017) and export its WebP files.

Input: the approved Higgsfield generation, 1792x2240 PNG (gpt_image_2_6, the
"Deep water" direction, generation 3). It isn't committed; pass its path.

    python context/brand/scripts/sign-in-illustration.py <generation.png> <out-dir>

Writes <out-dir>/sign-in-illustration.webp (1792x2240) and
sign-in-illustration-1200.webp (960x1200). Deterministic: grading only, no
new pixels are generated. The grade, in order:

1. Darken: every channel x 0.87, so the stone sits clearly below the panel's
   Shell button (the form is the brightest thing on the screen).
2. Left-edge fade toward --side #0A0B0C over the left 24% of the width,
   strength 0.85 at the edge, easing out (1 - t)^2, so the column meets the
   graphite chrome instead of reading as a teal panel.
3. Bottom fade toward --side, from y 1437 to y 2045 at (t^1.6) x 0.92, held
   at 0.92 below. These are the rows the 1200x800 sign-in target shows.
4. A fixed-seed dither of one level against banding in the dark water.
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image

SIDE = np.array([10, 11, 12], dtype=np.float64)
DARKEN = 0.87
LEFT_FRACTION = 0.24
LEFT_STRENGTH = 0.85
BOTTOM_START, BOTTOM_END, BOTTOM_STRENGTH = 1437, 2045, 0.92


def grade(img: Image.Image) -> Image.Image:
    a = np.asarray(img.convert("RGB"), dtype=np.float64)
    h, w, _ = a.shape
    if (w, h) != (1792, 2240):
        raise SystemExit(f"expected 1792x2240, got {w}x{h}")
    a = a * DARKEN

    x = np.arange(w, dtype=np.float64)
    fade_w = w * LEFT_FRACTION
    left = np.where(x < fade_w, LEFT_STRENGTH * (1 - x / fade_w) ** 2, 0.0)

    y = np.arange(h, dtype=np.float64)
    t = np.clip((y - BOTTOM_START) / (BOTTOM_END - BOTTOM_START), 0.0, 1.0)
    bottom = BOTTOM_STRENGTH * t**1.6

    # The two fades combine like two layers of the same graphite.
    m = 1 - (1 - left[None, :]) * (1 - bottom[:, None])
    a = a * (1 - m[..., None]) + SIDE * m[..., None]
    # A fixed-seed triangular dither of one level, so the near-black gradients
    # don't band when they're rounded to 8 bits and encoded.
    rng = np.random.default_rng(0)
    a = a + rng.random(a.shape) - rng.random(a.shape)
    return Image.fromarray(np.clip(np.rint(a), 0, 255).astype(np.uint8), "RGB")


def main() -> None:
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    g = grade(Image.open(src))
    g.save(out / "sign-in-illustration.webp", quality=90, method=6)
    g.resize((960, 1200), Image.LANCZOS).save(
        out / "sign-in-illustration-1200.webp", quality=90, method=6
    )


if __name__ == "__main__":
    main()
