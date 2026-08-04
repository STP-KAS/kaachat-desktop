#!/usr/bin/env python3
"""Generate PWA icons for KaChat from the app's two-bubble brand mark
(see .brand-bubble/.brand-bubble-left/.brand-bubble-right in ui/styles.css),
using Pillow instead of an SVG source since no SVG rasterizer is available.
Run: python3 tools/generate-pwa-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICONS_DIR = ROOT / "public" / "icons"
ICONS_DIR.mkdir(parents=True, exist_ok=True)

BUBBLE_COLOR = (121, 207, 194, 255)  # #79cfc2
BG_COLOR = (7, 10, 13, 255)  # --bg: #070a0d


def draw_bubbles(draw: ImageDraw.ImageDraw, scale: float, ox: float = 0, oy: float = 0):
    """Draw the two-bubble KaChat mark. Coordinates are in a 512x512 design
    space, then scaled/offset onto the actual canvas."""

    def s(x, y):
        return (ox + x * scale, oy + y * scale)

    # Left bubble body + downward tail.
    draw.rounded_rectangle([s(50, 70), s(310, 270)], radius=60 * scale, fill=BUBBLE_COLOR)
    draw.polygon([s(110, 265), s(170, 265), s(120, 330)], fill=BUBBLE_COLOR)

    # Right bubble body + downward tail (overlapping, lower-right).
    draw.rounded_rectangle([s(200, 220), s(462, 380)], radius=60 * scale, fill=BUBBLE_COLOR)
    draw.polygon([s(260, 375), s(320, 375), s(270, 440)], fill=BUBBLE_COLOR)


def make_icon(size: int, background=None, safe_zone: bool = False) -> Image.Image:
    img = Image.new("RGBA", (size, size), background or (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    if safe_zone:
        # Keep all artwork within the central ~80% "safe zone" per the
        # maskable-icon spec: scale + center the 512-space design into an
        # inner region with generous margin on every edge.
        inner = size * 0.62
        scale = inner / 512
        offset = (size - 512 * scale) / 2
        draw_bubbles(draw, scale, offset, offset)
    else:
        scale = size / 512
        draw_bubbles(draw, scale, 0, 0)
    return img


def main():
    make_icon(192).save(ICONS_DIR / "icon-192.png")
    make_icon(512).save(ICONS_DIR / "icon-512.png")
    make_icon(512, background=BG_COLOR, safe_zone=True).save(ICONS_DIR / "icon-512-maskable.png")
    make_icon(180, background=BG_COLOR).save(ICONS_DIR / "apple-touch-icon-180.png")

    favicon_master = make_icon(64, background=BG_COLOR)
    favicon_master.save(
        ROOT / "public" / "favicon.ico",
        sizes=[(16, 16), (32, 32), (48, 48)],
    )

    print("Generated PWA icons in", ICONS_DIR)


if __name__ == "__main__":
    main()
