from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .sequence import IMAGE_SUFFIXES

SAMPLE_PLAN = {
    "visual_frames": 36,
    "file_numbers": "001-037 with 024 missing",
    "missing_number": 24,
    "flash_file_number": 10,
    "pause_file_numbers": [16, 17, 18],
    "motion": "one warm point moves at constant speed except for a three-frame pause",
    "size": [480, 270],
}


@dataclass(frozen=True)
class SampleInfo:
    folder: Path
    paths: list[Path]
    missing_number: int
    flash_index: int
    pause_indices: tuple[int, int, int]


def _add_glow(
    image: np.ndarray,
    xx: np.ndarray,
    yy: np.ndarray,
    cx: float,
    cy: float,
    radius: float,
    color: tuple[float, float, float],
    strength: float,
) -> None:
    d2 = ((xx - cx) ** 2 + (yy - cy) ** 2) / (radius * radius)
    glow = np.exp(-0.5 * d2) * strength
    for c, value in enumerate(color):
        image[..., c] += glow * value


def sample_frames(
    count: int = 36,
    width: int = 480,
    height: int = 270,
    seed: int = 15436,
) -> list[np.ndarray]:
    """Generate same-size RGB frames with motion, a flash, and a pause."""
    rng = np.random.default_rng(seed)
    ys, xs = np.mgrid[0:height, 0:width].astype(np.float32)
    nx = xs / max(1, width - 1)
    ny = ys / max(1, height - 1)

    # Fixed dark blue night base.  It is identical in every frame.
    base = np.empty((height, width, 3), dtype=np.float32)
    base[..., 0] = 7 + 13 * ny + 5 * nx
    base[..., 1] = 10 + 17 * ny
    base[..., 2] = 25 + 24 * ny + 8 * (1.0 - ny)

    # Static skyline blocks.
    for _ in range(18):
        bw = int(rng.integers(18, 58))
        bh = int(rng.integers(28, 95))
        x0 = int(rng.integers(0, max(1, width - bw)))
        y0 = height - bh
        base[y0:height, x0 : x0 + bw] *= rng.uniform(0.45, 0.7)
        # A few dim windows.
        for __ in range(int(rng.integers(2, 8))):
            wx = x0 + int(rng.integers(4, max(5, bw - 6)))
            wy = y0 + int(rng.integers(6, max(7, bh - 8)))
            if 0 <= wy < height and 0 <= wx < width:
                base[wy : wy + 2, wx : wx + 2] += rng.uniform(18, 45)

    # Fixed stars and sensor/hot pixels.  The one-pixel hot pixels are useful
    # for checking isolated-spot suppression.
    for _ in range(55):
        x = int(rng.integers(0, width))
        y = int(rng.integers(0, int(height * 0.58)))
        base[y, x] += float(rng.uniform(25, 70))
    hot_pixels = [(42, 38), (width - 55, 44), (width // 2 + 70, 28), (88, 72), (width - 110, 88)]
    for x, y in hot_pixels:
        base[y, x] = (210, 205, 190)

    x_start, x_end = 38.0, width - 38.0
    # Fourteen moving intervals before the three-frame pause and seventeen
    # afterwards.  Split total travel by those interval counts so speed is the
    # same px/frame on both moving legs.
    pre_end_x = x_start + (x_end - x_start) * (14.0 / (14.0 + 17.0))
    pause = (15, 16, 17)
    frames: list[np.ndarray] = []

    for i in range(count):
        frame = base.copy()
        frame += rng.normal(0.0, 2.2, size=frame.shape).astype(np.float32)

        if i <= 14:
            px = x_start + (pre_end_x - x_start) * (i / 14.0)
        elif i in pause:
            px = pre_end_x
        else:
            tail_t = (i - 18) / max(1, count - 1 - 18)
            px = pre_end_x + (x_end - pre_end_x) * tail_t
        py = height * 0.54 + 15.0 * math.sin(i * 0.22)

        # Warm moving point: broad low glow plus compact bright core.
        _add_glow(frame, xs, ys, px, py, 15.0, (1.0, 0.72, 0.38), 0.42 * 255)
        _add_glow(frame, xs, ys, px, py, 6.0, (1.0, 0.86, 0.58), 0.72 * 255)
        _add_glow(frame, xs, ys, px, py, 2.4, (1.0, 0.97, 0.86), 1.05 * 255)

        # Exactly one temporary strong reflection/flash at visual frame 9
        # (file 010 in the written sample).
        if i == 9:
            cx, cy = width * 0.73, height * 0.70
            anisotropic = ((xs - cx) / (width * 0.17)) ** 2 + ((ys - cy) / (height * 0.20)) ** 2
            reflection = np.exp(-0.5 * anisotropic) * 155.0
            frame += reflection[..., None] * np.array([0.95, 0.98, 1.0], dtype=np.float32)
            # A sharper core makes it visually unmistakable.
            _add_glow(frame, xs, ys, cx + 12, cy - 8, 18.0, (0.9, 0.95, 1.0), 0.55 * 255)

        frame = np.clip(frame, 0, 255).astype(np.uint8)
        frames.append(frame)

    return frames


def written_number(visual_index: int, skip_number: int = 24) -> int:
    """Map zero-based visual frame to sample filename sequence number."""
    one_based = visual_index + 1
    return one_based if one_based < skip_number else one_based + 1


def write_sample_sequence(
    folder: str | Path,
    frames: list[np.ndarray] | None = None,
    skip_number: int = 24,
) -> SampleInfo:
    """Write a local sample sequence and a small JSON description."""
    from .imaging import save_rgb

    target = Path(folder).expanduser()
    target.mkdir(parents=True, exist_ok=True)
    for old in target.glob("light_trail_*.png"):
        old.unlink()

    generated = frames if frames is not None else sample_frames()
    paths: list[Path] = []
    for i, frame in enumerate(generated):
        number = written_number(i, int(skip_number))
        path = target / f"light_trail_{number:03d}.png"
        save_rgb(path, frame)
        paths.append(path)

    info = dict(SAMPLE_PLAN)
    info["folder"] = str(target)
    info["written_files"] = [p.name for p in paths]
    (target / "sample_plan.json").write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")

    return SampleInfo(
        folder=target,
        paths=paths,
        missing_number=int(skip_number),
        flash_index=9,
        pause_indices=(15, 16, 17),
    )


def is_supported_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_SUFFIXES
