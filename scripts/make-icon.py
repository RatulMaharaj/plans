#!/usr/bin/env python3
"""
The app icon: a page of text with one line changed.

The whole app rests on one idea — chrome is ink at varying opacity, and the only
colour means "this differs from what's committed". The icon says exactly that: a
leaf of warm paper, ruled with ink, and a single amber line. It reads at 1024px
as a page; at 32px it reads as a mark on a page, which is the point.

Drawn rather than traced so the proportions follow the app's own tokens: Day's
paper and ink, and --git-mod for the line that moved.

    python3 scripts/make-icon.py
"""

from PIL import Image, ImageDraw

# The papers, from src/App.css, so a variant is a theme rather than a redraw.
PAPERS = {
    "day": {
        "paper": (251, 251, 249, 255),
        "ink": (23, 24, 27, 255),
        "ink2": (91, 95, 102, 255),
        "mark": (154, 107, 18, 255),
        "edge": (207, 207, 200, 255),
    },
    "sepia": {
        "paper": (233, 223, 203, 255),
        "ink": (51, 41, 31, 255),
        "ink2": (107, 92, 71, 255),
        "mark": (140, 90, 15, 255),
        "edge": (194, 178, 148, 255),
    },
    "night": {
        "paper": (15, 16, 19, 255),
        "ink": (230, 227, 220, 255),
        "ink2": (165, 162, 154, 255),
        "mark": (216, 171, 82, 255),
        "edge": (65, 66, 74, 255),
    },
    # Ink on paper with no colour at all, for the argument that the mark should
    # be weight rather than hue.
    "quiet": {
        "paper": (251, 251, 249, 255),
        "ink": (23, 24, 27, 255),
        "ink2": (154, 160, 168, 255),
        "mark": (23, 24, 27, 255),
        "edge": (207, 207, 200, 255),
    },
}

# Drawn large and reduced, so every edge is antialiased by the downsample.
S = 4096
R = int(S * 0.185)  # macOS-ish corner, squircle enough at this size


def rounded(draw, box, radius, fill, outline=None, width=0):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def build(theme: str = "day", bleed: bool = False) -> Image.Image:
    """`bleed` fills the whole tile with paper, rather than floating a leaf."""
    c = PAPERS[theme]
    PAPER, INK, INK_2, GIT_MOD, EDGE = c["paper"], c["ink"], c["ink2"], c["mark"], c["edge"]
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # The leaf. Inset so the icon has air around it, as macOS icons do — or
    # filling the tile, for the variant that reads as a page rather than on one.
    m = 0 if bleed else int(S * 0.085)
    page = (m, m, S - m, S - m)
    rounded(d, page, R, PAPER)
    # A hairline edge, so the paper reads as a sheet on a dark desktop.
    rounded(d, page, R, None, outline=EDGE, width=int(S * 0.006))

    # Ruled text: a heading, then two short paragraphs, one line of which has
    # moved. Sized from the page rather than from the canvas, and centred as a
    # block, so the whole thing sits on the leaf with even margins.
    inner_l = m + int(S * 0.115)
    inner_r = S - m - int(S * 0.115)
    measure = inner_r - inner_l

    head_h = int(S * 0.052)
    line_h = int(S * 0.034)
    gap = int(S * 0.042)
    para = int(S * 0.030)  # extra space between paragraphs

    # (width fraction, weight) — "head" is the title, "body" the prose.
    rows = [
        (0.62, "head"),
        (1.00, "body"),
        (0.86, "body"),
        (0.94, "mark"),
        (1.00, "body"),
        (0.55, "body"),
    ]
    breaks = {1, 4}  # a paragraph starts here

    total = 0
    for i, (_, kind) in enumerate(rows):
        total += head_h if kind == "head" else line_h
        if i < len(rows) - 1:
            total += gap + (para if (i + 1) in breaks else 0)

    y = m + ((S - 2 * m) - total) // 2

    for i, (frac, kind) in enumerate(rows):
        h = head_h if kind == "head" else line_h
        x2 = inner_l + int(measure * frac)
        colour = INK if kind == "head" else INK_2
        if kind == "mark":
            colour = GIT_MOD
        rounded(d, (inner_l, y, x2, y + h), h // 2, colour)
        y += h + gap + (para if (i + 1) in breaks else 0)

    return img


def main() -> None:
    import os
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "--options":
        out = "scripts/icon-options"
        os.makedirs(out, exist_ok=True)
        for theme in PAPERS:
            for bleed in (False, True):
                name = f"{theme}{'-full' if bleed else ''}"
                img = build(theme, bleed).resize((1024, 1024), Image.LANCZOS)
                img.save(f"{out}/{name}.png")
                # A small copy too, since that is where an icon is really judged.
                img.resize((128, 128), Image.LANCZOS).save(f"{out}/{name}@128.png")
                print(f"wrote {out}/{name}.png")
        return

    theme = sys.argv[1] if len(sys.argv) > 1 else "day"
    out = "scripts/icon-source.png"
    build(theme).resize((1024, 1024), Image.LANCZOS).save(out)
    print(f"wrote {out} ({theme})")


if __name__ == "__main__":
    main()
