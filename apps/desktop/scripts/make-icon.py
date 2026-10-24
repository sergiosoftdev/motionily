"""Builds the desktop app icon in the macOS shape from the web icon.

Apple's grid: a 1024 px canvas, an 824 px rounded square (a superellipse, not a plain rounded rect)
centered with a 100 px margin, and a soft shadow under it. The mark sits inside with room to breathe.
Run: python3 apps/desktop/scripts/make-icon.py && pnpm --filter @motionily/desktop icons
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / "apps/web/public/icon-512.png"
OUT = ROOT / "apps/desktop/icon.png"

CANVAS = 1024
BODY = 824
MARGIN = (CANVAS - BODY) // 2
# Superellipse exponent close to Apple's icon shape.
EXPONENT = 5.0
# Share of the body the mark spans.
MARK_SHARE = 0.86
SUPERSAMPLE = 4


def squircle_mask(size: int) -> Image.Image:
    big = size * SUPERSAMPLE
    r = big / 2
    pts = []
    import math
    for i in range(720):
        a = 2 * math.pi * i / 720
        c, s = math.cos(a), math.sin(a)
        x = r + r * math.copysign(abs(c) ** (2 / EXPONENT), c)
        y = r + r * math.copysign(abs(s) ** (2 / EXPONENT), s)
        pts.append((x, y))
    m = Image.new("L", (big, big), 0)
    ImageDraw.Draw(m).polygon(pts, fill=255)
    return m.resize((size, size), Image.LANCZOS)


def body() -> Image.Image:
    # Near-black with a faint light from the top, like a lit surface rather than a flat hole.
    top, bottom = (34, 34, 38), (6, 6, 8)
    g = Image.new("RGB", (1, BODY))
    for y in range(BODY):
        k = y / (BODY - 1)
        g.putpixel((0, y), tuple(round(top[i] + (bottom[i] - top[i]) * k) for i in range(3)))
    return g.resize((BODY, BODY))


def mark() -> Image.Image:
    src = Image.open(SRC).convert("RGB")
    # The web icon is the mark on black: black becomes transparent so it sits on the gradient.
    rgba = src.convert("RGBA")
    px = rgba.load()
    for y in range(rgba.height):
        for x in range(rgba.width):
            r, g, b, _ = px[x, y]
            lum = max(r, g, b)
            if lum < 24:
                px[x, y] = (r, g, b, round(255 * lum / 24))
    side = round(BODY * MARK_SHARE)
    return rgba.resize((side, side), Image.LANCZOS)


def main() -> None:
    mask = squircle_mask(BODY)
    tile = body().convert("RGBA")
    m = mark()
    off = (BODY - m.width) // 2
    tile.alpha_composite(m, (off, off))
    # A thin highlight on the top edge, the way macOS icons catch light.
    rim = Image.new("RGBA", (BODY, BODY), (255, 255, 255, 0))
    inner = squircle_mask(BODY - 4).resize((BODY - 4, BODY - 4))
    edge = Image.new("L", (BODY, BODY), 0)
    edge.paste(mask)
    hole = Image.new("L", (BODY, BODY), 0)
    hole.paste(inner, (2, 3))
    edge = Image.eval(Image.merge("L", [edge]), lambda v: v)
    ring = Image.composite(Image.new("L", (BODY, BODY), 0), edge, hole)
    fade = Image.linear_gradient("L").resize((BODY, BODY)).transpose(Image.FLIP_TOP_BOTTOM)
    ring = Image.composite(ring, Image.new("L", (BODY, BODY), 0), fade)
    rim.putalpha(Image.eval(ring, lambda v: v * 40 // 255))
    tile.alpha_composite(rim)
    tile.putalpha(mask)

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    shadow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    sh = Image.new("RGBA", (BODY, BODY), (0, 0, 0, 110))
    sh.putalpha(Image.eval(mask, lambda v: v * 110 // 255))
    shadow.alpha_composite(sh, (MARGIN, MARGIN + 12))
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    canvas.alpha_composite(shadow)
    canvas.alpha_composite(tile, (MARGIN, MARGIN))
    canvas.save(OUT)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
