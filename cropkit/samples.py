"""Synthetic eight-orientation sample sheets.

The sheet is deliberately asymmetric so that every rotation and mirror is
visible: a numbered corner badge on each corner, an arrow pointing to the
top, and one red dot near the top-left corner.  The corner badges let a
reviewer compare the encoded original and the upright image and confirm
that mirrored orientations keep the correct four-corner ordering.

File naming:
    orientation-<n>-<encoded|upright>.jpg
"""

from __future__ import annotations

import os
from typing import List, Tuple

from PIL import Image, ImageDraw, ImageFont

from cropkit.orientation import Orientation, LABELS

# Distinct reference colours for the display-space corners, used by the
# corner probe and the self-check.
CORNER_COLORS = {
    "TL": (230, 40, 40),
    "TR": (40, 200, 80),
    "BL": (50, 90, 230),
    "BR": (235, 210, 40),
}

SHEET_W, SHEET_H = 720, 480
CORNER_TEXT = {
    "encoded": ("TL", "TR", "BL", "BR"),
    "upright": ("左上", "右上", "左下", "右下"),
}


def _font(size: int):
    for name in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf",
                 "/System/Library/Fonts/Helvetica.ttc",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def make_sheet(upright: bool = True,
               size: Tuple[int, int] = (SHEET_W, SHEET_H)) -> Image.Image:
    """Draw one asymmetric test sheet.

    ``upright=True`` draws the *display* orientation: corner labels read
    normally.  ``upright=False`` draws the *stored* (encoded) orientation
    for orientation 1; rotate it with Pillow to obtain the other encoded
    variants, so the whole sheet is unmatched in every direction.
    """
    w, h = size
    if w < 240 or h < 200:
        raise ValueError("样图尺寸至少 240 x 200")
    img = Image.new("RGB", (w, h), (30, 42, 60))
    d = ImageDraw.Draw(img)
    # background grid, asymmetric spacing so mirroring is obvious
    for x in range(0, w, 48):
        d.line((x, 0, x, h), fill=(44, 60, 84))
    for y in range(0, h, 36):
        d.line((0, y, w, y), fill=(44, 60, 84))
    # a big arrow pointing "up" in display space
    d.polygon([(w // 2, 40), (w // 2 - 40, 150), (w // 2 + 40, 150)],
              fill=(230, 190, 60))
    d.rectangle((w // 2 - 14, 150, w // 2 + 14, 230), fill=(230, 190, 60))
    # red dot near the display top-left
    d.ellipse((60, 60, 120, 120), fill=(220, 70, 70))
    # colour bar down the display left edge
    d.rectangle((10, 180, 34, h - 10), fill=(80, 220, 140))
    # corner badges
    font = _font(34)
    small = _font(22)
    labels = CORNER_TEXT["upright" if upright else "encoded"]
    positions = [(16, 16), (w - 120, 16), (16, h - 60), (w - 120, h - 60)]
    for text, (x, y) in zip(labels, positions):
        d.rectangle((x - 6, y - 6, x + 100, y + 42), fill=(12, 18, 28))
        d.text((x, y), text, font=font, fill=(245, 245, 245))
    title = "显示正向 (upright)" if upright else "编码存储 (stored)"
    d.text((w // 2 - 120, h - 34), title, font=small, fill=(200, 210, 225))
    return img


# Pillow transform that turns a display image into the stored bytes for
# each EXIF orientation.  This is the inverse of Orientation.to_display.
_TO_STORED = {
    1: None,
    2: Image.Transpose.FLIP_LEFT_RIGHT,
    3: Image.Transpose.ROTATE_180,
    4: Image.Transpose.FLIP_TOP_BOTTOM,
    5: Image.Transpose.TRANSPOSE,
    6: Image.Transpose.ROTATE_90,
    7: Image.Transpose.TRANSVERSE,
    8: Image.Transpose.ROTATE_270,
}


def stored_pixels_for(display: Image.Image, orientation: int) -> Image.Image:
    """Encode ``display`` the way a camera would for this orientation."""
    op = _TO_STORED[Orientation(orientation).value]
    return display.copy() if op is None else display.transpose(op)


def save_with_orientation(display: Image.Image, path: str,
                          orientation: int, quality: int = 92) -> None:
    stored = stored_pixels_for(display, orientation)
    exif = Image.Exif()
    exif[0x0112] = Orientation(orientation).value
    exif[0x010F] = "CropKit"
    exif[0x0110] = "synthetic sample"
    stored.save(path, "JPEG", quality=quality, exif=exif.tobytes(),
                subsampling=0)


def write_sample_set(out_dir: str) -> List[str]:
    """Write one JPEG per orientation plus the upright reference image.

    All eight JPEGs share the same upright pixels but a different EXIF
    orientation tag (and, for 5..8, a different stored layout), so opening
    them one after another is a direct test of the orientation handling.
    """
    import json

    os.makedirs(out_dir, exist_ok=True)
    upright = make_sheet(upright=True)
    entries = []
    for value in range(1, 9):
        name = f"orientation-{value}-encoded.jpg"
        jpg = os.path.join(out_dir, name)
        save_with_orientation(upright, jpg, value)
        entries.append({
            "file": name,
            "orientation": value,
            "label": LABELS[value],
            "stored_size": list(stored_pixels_for(upright, value).size),
            "upright_size": list(upright.size),
            "mirrored": Orientation(value).mirrored,
        })
    ref = os.path.join(out_dir, "upright-reference.png")
    upright.save(ref, "PNG")
    index = os.path.join(out_dir, "samples.json")
    with open(index, "w", encoding="utf-8") as fh:
        json.dump({"reference": os.path.basename(ref), "samples": entries},
                  fh, ensure_ascii=False, indent=2)
    return [index] + [os.path.join(out_dir, e["file"]) for e in entries] + [ref]


def make_corner_probe(size: Tuple[int, int] = (160, 120)) -> Image.Image:
    """A four-quadrant colour probe used to verify corner orientation.

    Display corners get distinct colours; any flip/rotation that sends the
    wrong stored corner to a display corner is visible as a wrong patch.
    """
    w, h = size
    img = Image.new("RGB", (w, h), (0, 0, 0))
    d = ImageDraw.Draw(img)
    # box corners as (x0, y0, x1, y1), inclusive on both ends
    boxes = {
        "TL": (0, 0, w // 2 - 1, h // 2 - 1),
        "TR": (w // 2, 0, w - 1, h // 2 - 1),
        "BL": (0, h // 2, w // 2 - 1, h - 1),
        "BR": (w // 2, h // 2, w - 1, h - 1),
    }
    for corner, box in boxes.items():
        d.rectangle(box, fill=CORNER_COLORS[corner])
    # an asymmetric mark in the middle so rotations are distinguishable
    d.polygon([(w // 2, h // 2 - 20), (w // 2 - 20, h // 2 + 15),
               (w // 2 + 20, h // 2 + 15)], fill=(255, 255, 255))
    return img


def describe_sample(value: int) -> str:
    return LABELS[Orientation(value).value]


if __name__ == "__main__":
    import sys

    target = sys.argv[1] if len(sys.argv) > 1 else "samples"
    for p in write_sample_set(target):
        print(p)
