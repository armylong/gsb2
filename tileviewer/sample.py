"""Deterministic sample image with an odd size, fine grid and corner labels.

The sample is designed so that coordinate mistakes are visible at a glance:

* odd width and height, so the last preview row/column cannot be a clean
  multiple of any power of two;
* a 1 px grid every 10 original pixels plus heavier rules every 100 px;
* numbered corner markers at all four corners (0, 0), (w-1, 0), (0, h-1),
  (w-1, h-1), each with its exact coordinate printed next to it;
* a few extra numbered control points whose colours encode their position,
  so an exported crop can be checked pixel by pixel;
* a ruler strip along the top and left edges labelled in original pixels.

Generate it with::

    python -m tileviewer.sample --out samples/sample_grid_4001x2501.png
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

__all__ = ["SAMPLE_WIDTH", "SAMPLE_HEIGHT", "corner_points", "build_sample"]

SAMPLE_WIDTH = 4001
SAMPLE_HEIGHT = 2501

_BACKGROUND_TOP = (18, 26, 44)
_BACKGROUND_BOTTOM = (58, 34, 22)


def corner_points(width: int, height: int) -> list[tuple[str, int, int]]:
    """The numbered corner markers of the sample, in reading order."""
    return [
        ("TL", 0, 0),
        ("TR", width - 1, 0),
        ("BL", 0, height - 1),
        ("BR", width - 1, height - 1),
    ]


def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # pragma: no cover - very old Pillow
        return ImageFont.load_default()


def build_sample(width: int = SAMPLE_WIDTH, height: int = SAMPLE_HEIGHT) -> Image.Image:
    """Render the deterministic RGB sample image."""
    if width < 64 or height < 64:
        raise ValueError("sample must be at least 64x64")

    ramp = np.linspace(0.0, 1.0, height, dtype=np.float32)[:, None]
    top = np.array(_BACKGROUND_TOP, dtype=np.float32)
    bottom = np.array(_BACKGROUND_BOTTOM, dtype=np.float32)
    column = top[None, :] * (1.0 - ramp) + bottom[None, :] * ramp
    array = np.repeat(column[:, None, :], width, axis=1)

    # Soft horizontal bands make seams visible without hiding the grid.
    xs = np.arange(width, dtype=np.float32)
    ys = np.arange(height, dtype=np.float32)
    wave_x = (np.sin(xs / 97.0) * 14.0)[None, :, None]
    wave_y = (np.cos(ys / 61.0) * 10.0)[:, None, None]
    array = array + wave_x + wave_y
    array[:, :, 0] += (xs / max(1, width - 1) * 90.0)[None, :]
    array[:, :, 2] += ((height - 1 - ys) / max(1, height - 1) * 70.0)[:, None]
    array = np.clip(array, 0, 255).astype(np.uint8)
    image = Image.fromarray(array, mode="RGB")
    draw = ImageDraw.Draw(image)

    # Fine grid every 10 px, medium every 50 px, heavy every 100 px.
    for x in range(0, width, 10):
        draw.line([(x, 0), (x, height - 1)], fill=(120, 140, 168))
    for y in range(0, height, 10):
        draw.line([(0, y), (width - 1, y)], fill=(120, 140, 168))
    for x in range(0, width, 50):
        draw.line([(x, 0), (x, height - 1)], fill=(196, 210, 232))
    for y in range(0, height, 50):
        draw.line([(0, y), (width - 1, y)], fill=(196, 210, 232))
    for x in range(0, width, 100):
        draw.line([(x, 0), (x, height - 1)], fill=(255, 238, 180))
    for y in range(0, height, 100):
        draw.line([(0, y), (width - 1, y)], fill=(255, 238, 180))

    # Rulers along the top and left edge.
    draw.rectangle([0, 0, width - 1, 26], fill=(12, 14, 20))
    draw.rectangle([0, 0, 96, height - 1], fill=(12, 14, 20))
    ruler_font = _font(16)
    for x in range(0, width, 100):
        draw.line([(x, 18), (x, 26)], fill=(255, 255, 255))
        draw.text((x + 3, 4), str(x), fill=(230, 240, 255), font=ruler_font)
    for y in range(0, height, 100):
        draw.line([(88, y), (96, y)], fill=(255, 255, 255))
        draw.text((3, y + 1), str(y), fill=(230, 240, 255), font=ruler_font)

    # Corner markers: a coloured border square plus its exact corner pixel,
    # plus the corner coordinate in text.
    label_font = _font(34)
    small_font = _font(20)
    colours = {
        "TL": (255, 70, 70),
        "TR": (70, 220, 120),
        "BL": (80, 150, 255),
        "BR": (255, 210, 60),
    }
    markers = []
    for name, x, y in corner_points(width, height):
        inward_x = 8 if x < width // 2 else -8
        inward_y = 8 if y < height // 2 else -8
        x_a, x_b = sorted((x, x + inward_x * 40))
        y_a, y_b = sorted((y, y + inward_y * 40))
        if x < width // 2:
            text_x = x_b + 6
        else:
            text_x = x_a - 306
        if y < height // 2:
            text_y = y_b + 6
        else:
            text_y = y_a - 50
        text_x = max(2, text_x)
        text_y = max(2, text_y)
        markers.append((name, x, y, x_a, y_a, x_b, y_b, text_x, text_y))

    # Labels first, then the marker squares, then the exact corner pixels
    # last of all, so no label backing can cover a corner pixel.
    for name, x, y, _a, _b, _c, _d, text_x, text_y in markers:
        text = f"{name} {x},{y}"
        draw.rectangle(
            [text_x - 4, text_y - 2, text_x + 300, text_y + 40],
            fill=(10, 10, 14),
        )
        draw.text((text_x, text_y), text, fill=colours[name], font=label_font)
    for name, _x, _y, x_a, y_a, x_b, y_b, _tx, _ty in markers:
        draw.rectangle(
            [x_a, y_a, x_b, y_b], outline=colours[name], width=4
        )

    # Numbered control points in the interior.  Each one has a 5x5 black
    # frame, a coloured centre pixel and its index in plain text.
    control_points = [
        (width // 2, height // 2),
        (width // 4, height // 3),
        (3 * width // 4, height // 3),
        (width // 4, 2 * height // 3),
        (3 * width // 4, 2 * height // 3),
        (width // 2 - 777, height // 2 + 501),
    ]
    for index, (x, y) in enumerate(control_points, start=1):
        draw.rectangle([x - 30, y - 30, x + 30, y + 30], fill=(0, 0, 0))
        draw.rectangle(
            [x - 26, y - 26, x + 26, y + 26],
            outline=(255, 255, 255),
            width=2,
        )
        draw.text(
            (x - 6, y - 12),
            str(index),
            fill=(255, 255, 255),
            font=_font(26),
        )
        draw.text(
            (x + 34, y - 10),
            f"P{index} {x},{y}",
            fill=(255, 255, 255),
            font=small_font,
        )

    draw.text(
        (110, 40),
        f"tileviewer sample  {width}x{height}  (odd size, 1px grid, "
        "corner markers)",
        fill=(255, 255, 255),
        font=small_font,
    )

    # Last step: stamp the exact corner pixels, so nothing drawn afterwards
    # (text backgrounds, control points) can mask them.
    for name, x, y in corner_points(width, height):
        draw.rectangle([x, y, x, y], fill=colours[name])
    return image


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="samples/sample_grid_4001x2501.png")
    parser.add_argument("--width", type=int, default=SAMPLE_WIDTH)
    parser.add_argument("--height", type=int, default=SAMPLE_HEIGHT)
    parser.add_argument("--format", default=None, help="png (default) or tif")
    args = parser.parse_args(argv)

    target = Path(args.out).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)
    image = build_sample(args.width, args.height)
    fmt = (args.format or target.suffix.lstrip(".")).lower()
    if fmt in {"tif", "tiff"}:
        image.save(target, format="TIFF", compression="tiff_deflate")
    elif fmt == "jpg" or fmt == "jpeg":
        raise SystemExit("the sample must stay lossless; use png or tif")
    else:
        image.save(target, format="PNG", compress_level=6)
    print(
        f"wrote {target} ({image.width}x{image.height}, "
        f"{target.stat().st_size / 1e6:.2f} MB)"
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
