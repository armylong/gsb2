"""Headless self-check: generate the sample, build the pyramid, verify tiles.

Run with::

    python -m tileviewer.selfcheck

It exits non-zero if any level's stitched tiles differ from the reference,
if tile cores do not cover the level exactly, or if the export of a
selection that crosses tile borders differs from the original pixels.
"""

from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

import numpy as np

from .cache import CacheConfig, CacheManager, LevelState
from .exporter import export_region
from .geometry import Rect
from .sample import build_sample
from .source import load_source

__all__ = ["run"]


def run(
    tile_size: int = 512,
    margin: int = 16,
    width: int = 4001,
    height: int = 2501,
    keep: bool = False,
) -> int:
    problems: list[str] = []
    with tempfile.TemporaryDirectory(prefix="tileviewer-selfcheck-") as temp:
        temp_path = Path(temp)
        sample_path = temp_path / "sample.png"
        image = build_sample(width, height)
        image.save(sample_path, format="PNG")

        source = load_source(sample_path)
        config = CacheConfig(tile_size=tile_size, margin=margin)
        manager = CacheManager(temp_path / "cache", source, config)
        written = manager.generate()
        print(f"source {source.width}x{source.height} sha256 {source.short_hash}")
        print(
            f"generated levels {written} with {tile_size}px tiles / "
            f"{margin}px margin"
        )

        statuses = manager.statuses()
        for status in statuses:
            print("  " + status.describe())
            if status.state is not LevelState.COMPLETE:
                problems.append(f"level {status.index} not complete")

        for status in statuses:
            if status.state is not LevelState.COMPLETE:
                continue
            comparison = manager.compare_level(status.index)
            print("  " + comparison.describe())
            if not comparison.equal:
                problems.append(
                    f"level {status.index} stitched tiles differ from reference"
                )

        # Coverage: union of tile cores must be exactly the level image.
        for index in range(manager.info.level_count):
            geom = manager.geometry(index)
            covered = np.zeros((geom.height, geom.width), dtype=np.uint8)
            for tile in geom.iter_tiles():
                covered[
                    tile.core.y : tile.core.y2, tile.core.x : tile.core.x2
                ] += 1
            if covered.min() != 1 or covered.max() != 1:
                problems.append(f"level {index} core coverage is not exact")

        # Export a selection crossing several tiles and the image edge.
        last_w, last_h = manager.info.sizes[-1]
        selection = Rect(
            max(0, source.width - tile_size - 37),
            max(0, source.height - tile_size - 61),
            tile_size + 120,
            tile_size + 90,
        )
        result = export_region(source.array, selection, fill="transparent")
        inside = selection.clipped_to(source.bounds)
        expected = source.array[
            inside.y : inside.y2, inside.x : inside.x2, :
        ]
        actual = np.array(result.image.convert("RGB"))[
            inside.y - selection.y : inside.y - selection.y + inside.h,
            inside.x - selection.x : inside.x - selection.x + inside.w,
            :,
        ]
        if not np.array_equal(expected, actual):
            problems.append("export of a cross-tile selection differs from source")
        print(
            f"export {selection.w}x{selection.h} -> {result.size[0]}x"
            f"{result.size[1]}, outside px {result.outside_pixels}"
        )

        if keep:
            print(f"temporary data kept at (will vanish): {temp_path}")

    if problems:
        print("SELF-CHECK FAILED", file=sys.stderr)
        for problem in problems:
            print("  - " + problem, file=sys.stderr)
        return 1
    print("SELF-CHECK OK")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tile-size", type=int, default=512)
    parser.add_argument("--margin", type=int, default=16)
    parser.add_argument("--width", type=int, default=4001)
    parser.add_argument("--height", type=int, default=2501)
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args(argv)
    return run(
        tile_size=args.tile_size,
        margin=args.margin,
        width=args.width,
        height=args.height,
        keep=args.keep,
    )


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
