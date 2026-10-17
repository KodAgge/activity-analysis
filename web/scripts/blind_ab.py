#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = ["pillow"]
# ///
"""Compose one blind A/B sheet from our screenshot and the Strava bar.

A critic that knows which panel is ours cannot judge it, so the two are
scaled to a common width, placed side by side in a randomised order and
labelled only A and B. The mapping is written to a separate file, under a
directory the critic is never given, and printed to the caller's stdout.

Both panels are cropped to the same height so neither wins on length alone:
a full-page capture of ours is several times taller than a phone screenshot
of Strava's, and an unequal crop reads as an unequal amount of content.

Run it with `uv run web/scripts/blind_ab.py ...`, which reads the inline
script metadata above and supplies Pillow in a throwaway environment. Pillow
is deliberately not a project dependency: this is a design tool, and `uv run
python web/scripts/blind_ab.py` inside the project environment fails with
ModuleNotFoundError.

Usage:
  blind_ab.py --ours OURS.png --bar BAR.png --out SHEET.png --map MAP.json
              [--ours-offset PX] [--bar-offset PX] [--ours-bottom PX] [--bar-bottom PX]
  [--height PX] [--fit crop|pad]

`--fit crop` (the default) trims both to the shorter one's height. `--fit
pad` letterboxes the shorter one instead, which is what shell comparisons
need: a crop to the shorter panel throws away whichever panel's bottom bar
sits lowest, and the bottom bar is the thing being judged.

`--ours-offset`/`--bar-offset` and `--ours-bottom`/`--bar-bottom` cut a
panel at a given row of its own source image, before any scaling, so the two
panels can be trimmed to the same *span of content* rather than to the same
number of pixels. A full-page
capture of a scrolling view is several times taller than a screenshot of one
phone screen, and cropping it to the shorter one's height hands the critic
the top third of a page - which reads as missing axes and missing sections
that are in fact present further down. Trim to the content instead, then let
`--fit pad` absorb what is left over.
"""

import argparse
import json
import random

from PIL import Image, ImageDraw, ImageFont

PANEL_W = 420

"""How much of a panel a crop may discard before it is refused outright."""
MAX_SILENT_CROP = 0.25
GUTTER = 32
LABEL_H = 56
MARGIN = 24
BG = (255, 255, 255)
LABEL_INK = (0, 0, 0)


def _load(path: str, offset: int, bottom: int = 0) -> Image.Image:
    """Crop in the source image's own pixels, then scale to the panel width.

    Both cuts are taken before the resize so that `--*-offset` and
    `--*-bottom` are quoted in the same units a caller reads off the source
    screenshot. Cropping after the resize silently reinterprets the number as
    scaled pixels, which on a tall page is a different row entirely - an
    offset meant to skip to a list header instead skipped past the end of the
    image and produced a sheet 105 px tall.
    """
    img = Image.open(path).convert("RGB")
    top = min(offset, img.height - 1) if offset else 0
    foot = min(bottom, img.height) if bottom else img.height
    if top or foot != img.height:
        img = img.crop((0, top, img.width, max(foot, top + 1)))
    scale = PANEL_W / img.width
    return img.resize((PANEL_W, max(1, round(img.height * scale))), Image.LANCZOS)


def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ours", required=True)
    parser.add_argument("--bar", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--map", required=True)
    parser.add_argument("--ours-offset", type=int, default=0)
    parser.add_argument("--bar-offset", type=int, default=0)
    parser.add_argument("--ours-bottom", type=int, default=0)
    parser.add_argument("--bar-bottom", type=int, default=0)
    parser.add_argument("--height", type=int, default=0)
    parser.add_argument("--fit", choices=("crop", "pad"), default="crop")
    parser.add_argument("--seed", type=int, default=None)
    args = parser.parse_args()

    ours = _load(args.ours, args.ours_offset, args.ours_bottom)
    bar = _load(args.bar, args.bar_offset, args.bar_bottom)

    if args.fit == "pad":
        height = args.height or max(ours.height, bar.height)
    else:
        height = args.height or min(ours.height, bar.height)

    # A silent truncation is the worst failure this tool has: the critic
    # reviews what it is shown and reports the missing part as a fault, and
    # those findings are indistinguishable from real ones until each is
    # measured back by hand. It has cost three rounds. Refuse instead, and
    # name the two ways out.
    for label, panel in (("ours", ours), ("bar", bar)):
        dropped = panel.height - height
        if dropped > 0 and dropped / panel.height > MAX_SILENT_CROP:
            raise SystemExit(
                f"refusing to drop {100 * dropped / panel.height:.0f}% of the "
                f"{label} panel ({dropped}px of {panel.height}).\n"
                f"A critic shown a fragment reports the missing part as a fault.\n"
                f"Either trim both panels to the same span of content with "
                f"--ours-bottom/--bar-bottom, or pass --fit pad to letterbox "
                f"the shorter one."
            )

    def fit(img: Image.Image) -> Image.Image:
        if img.height >= height:
            return img.crop((0, 0, PANEL_W, height))
        # Padded onto a mid grey that belongs to neither panel's palette, so
        # the letterbox cannot be read as either app's own background.
        padded = Image.new("RGB", (PANEL_W, height), (128, 128, 128))
        padded.paste(img, (0, 0))
        return padded

    ours = fit(ours)
    bar = fit(bar)

    rng = random.Random(args.seed)
    ours_is_left = rng.random() < 0.5
    left, right = (ours, bar) if ours_is_left else (bar, ours)

    sheet_w = MARGIN * 2 + PANEL_W * 2 + GUTTER
    sheet_h = MARGIN * 2 + LABEL_H + height
    sheet = Image.new("RGB", (sheet_w, sheet_h), BG)
    sheet.paste(left, (MARGIN, MARGIN + LABEL_H))
    sheet.paste(right, (MARGIN + PANEL_W + GUTTER, MARGIN + LABEL_H))

    draw = ImageDraw.Draw(sheet)
    font = _font(36)
    draw.text((MARGIN, MARGIN), "A", fill=LABEL_INK, font=font)
    draw.text((MARGIN + PANEL_W + GUTTER, MARGIN), "B", fill=LABEL_INK, font=font)
    sheet.save(args.out)

    mapping = {"A": "ours" if ours_is_left else "bar", "B": "bar" if ours_is_left else "ours"}
    with open(args.map, "w", encoding="utf-8") as handle:
        json.dump(mapping, handle)
    print(json.dumps(mapping))


if __name__ == "__main__":
    main()
