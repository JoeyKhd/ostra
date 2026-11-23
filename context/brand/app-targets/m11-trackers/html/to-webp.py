"""Writes ../<name>.webp at CSS scale (half the 2x render) for each ../<name>.png given, or every one."""
import sys
from pathlib import Path

from PIL import Image

here = Path(__file__).resolve().parent
targets = here.parent
names = sys.argv[1:] or [p.stem for p in sorted(targets.glob("*.png"))]
for name in names:
    png = targets / f"{name}.png"
    with Image.open(png) as im:
        small = im.convert("RGB").resize((im.width // 2, im.height // 2), Image.LANCZOS)
        small.save(targets / f"{name}.webp", "WEBP", quality=90, method=6)
        print(f"{name}.webp {small.width}x{small.height}")
