"""
Generates the site icons from one geometry definition.

Run by hand when the mark changes; the outputs are committed:

    python3 apps/web/scripts/make-favicon.py

    apps/web/public/favicon.svg        the icon browsers actually use
    apps/web/public/favicon.ico        16/32/48, for anything that asks for
                                       /favicon.ico without reading the HTML
    apps/web/public/apple-touch-icon.png   180, full-bleed (iOS rounds it itself)

WHY A SCRIPT AND NOT TWO HAND-DRAWN FILES

An SVG favicon and a rasterised .ico are the same mark in two formats, and
nothing checks that they match. Drawn separately they drift the first time the
logo is tweaked, and the drift shows up as a different icon in one browser than
another. So the coordinates live here once, in a 64-unit square, and both the
vector and the bitmaps are emitted from them.

THE MARK

The sidebar logo is a graduation cap on a gradient tile, so the favicon is the
same thing — but drawn with FILLS rather than the UI icon's 1.6px strokes. At
16x16 a stroked outline turns into grey mush; a solid silhouette survives. The
board is deliberately wide and the tassel deliberately thick for the same
reason: a favicon is read at the size of a word, not looked at.
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"

# Brand gradient, 135°, from styles/variables.css: --primary-400 → --primary-500.
START = (139, 92, 246)
END = (108, 71, 236)

# Everything below is in a 64x64 design square.
SIZE = 64
CORNER = 14

BOARD = [(32, 12.5), (56, 23.5), (32, 34.5), (8, 23.5)]

# The cap under the board: straight sides dropping from the board's widest
# points, closed by a shallow curve. Sampled rather than expressed as a Bézier
# so the SVG and the bitmap trace identical edges.
BODY_TOP_Y = 28.0
BODY_SIDE_Y = 38.0
BODY_X_LEFT = 19.0
BODY_X_RIGHT = 45.0
BODY_BOTTOM_Y = 46.5

TASSEL_X = 56.0
TASSEL_TOP_Y = 23.5
TASSEL_BOTTOM_Y = 37.0
TASSEL_WIDTH = 3.4
KNOT_R = 3.2


def body_points(steps: int = 24) -> list[tuple[float, float]]:
    """The cap body, walked clockwise from its top-left corner."""
    pts: list[tuple[float, float]] = [(BODY_X_LEFT, BODY_TOP_Y), (BODY_X_LEFT, BODY_SIDE_Y)]
    # Quadratic curve across the bottom, control point below the midpoint.
    p0 = (BODY_X_LEFT, BODY_SIDE_Y)
    p1 = (32.0, BODY_BOTTOM_Y + 4.0)
    p2 = (BODY_X_RIGHT, BODY_SIDE_Y)
    for i in range(1, steps + 1):
        t = i / steps
        u = 1 - t
        pts.append((
            u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
            u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
        ))
    pts.append((BODY_X_RIGHT, BODY_TOP_Y))
    # Back along the underside of the board, so the two shapes meet flush.
    pts.append((32.0, BODY_TOP_Y + 6.5))
    return pts


def path_d(points: list[tuple[float, float]]) -> str:
    head = f"M{points[0][0]:.2f} {points[0][1]:.2f}"
    rest = " ".join(f"L{x:.2f} {y:.2f}" for x, y in points[1:])
    return f"{head} {rest} Z"


def write_svg() -> None:
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}" role="img" aria-label="AI.Prof">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="rgb{START}"/>
      <stop offset="100%" stop-color="rgb{END}"/>
    </linearGradient>
  </defs>
  <rect width="{SIZE}" height="{SIZE}" rx="{CORNER}" fill="url(#g)"/>
  <path d="{path_d(BOARD)}" fill="#fff"/>
  <path d="{path_d(body_points())}" fill="#fff" fill-opacity="0.92"/>
  <path d="M{TASSEL_X} {TASSEL_TOP_Y} V{TASSEL_BOTTOM_Y}" stroke="#fff" stroke-width="{TASSEL_WIDTH}" stroke-linecap="round" fill="none"/>
  <circle cx="{TASSEL_X}" cy="{TASSEL_BOTTOM_Y + 1.6:.1f}" r="{KNOT_R}" fill="#fff"/>
</svg>
"""
    (PUBLIC / "favicon.svg").write_text(svg)


def render(px: int, rounded: bool) -> Image.Image:
    """Draws the mark at `px`, supersampled 8x so the diagonals stay clean."""
    scale = 8
    n = px * scale
    k = n / SIZE

    # 135° linear gradient: constant along x + y.
    grad = Image.new("RGB", (n, n))
    pixels = grad.load()
    for y in range(n):
        for x in range(n):
            t = (x + y) / (2 * (n - 1))
            pixels[x, y] = tuple(round(START[i] + (END[i] - START[i]) * t) for i in range(3))

    tile = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    mask = Image.new("L", (n, n), 0)
    md = ImageDraw.Draw(mask)
    if rounded:
        md.rounded_rectangle([0, 0, n - 1, n - 1], radius=CORNER * k, fill=255)
    else:
        md.rectangle([0, 0, n - 1, n - 1], fill=255)
    tile.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(tile)
    d.polygon([(x * k, y * k) for x, y in BOARD], fill=(255, 255, 255, 255))
    d.polygon([(x * k, y * k) for x, y in body_points()], fill=(255, 255, 255, 235))
    d.line(
        [(TASSEL_X * k, TASSEL_TOP_Y * k), (TASSEL_X * k, TASSEL_BOTTOM_Y * k)],
        fill=(255, 255, 255, 255),
        width=round(TASSEL_WIDTH * k),
    )
    r = KNOT_R * k
    cx, cy = TASSEL_X * k, (TASSEL_BOTTOM_Y + 1.6) * k
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, 255))

    return tile.resize((px, px), Image.LANCZOS)


def main() -> None:
    write_svg()
    # One .ico holding the three sizes Windows and the older browsers pick from.
    render(48, rounded=True).save(
        PUBLIC / "favicon.ico",
        sizes=[(16, 16), (32, 32), (48, 48)],
    )
    # Full-bleed: iOS applies its own corner radius and puts black behind any
    # transparency, so rounding it here would show dark corners on a home screen.
    render(180, rounded=False).convert("RGB").save(PUBLIC / "apple-touch-icon.png")
    print(f"wrote favicon.svg, favicon.ico, apple-touch-icon.png to {PUBLIC}")


if __name__ == "__main__":
    main()
