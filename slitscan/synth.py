"""Built-in synthetic stripe patterns for local verification.

Three clips are offered, all containing a bright vertical bar moving over a
dim horizontal gradient:

* ``constant``  — constant-speed CFR clip
* ``reverse``   — bar travels right, then reverses direction (still CFR)
* ``vfr``       — constant motion but *uneven frame presentation times*

Each frame also carries its frame number in a luminance barcode on the top
row (see ``ID_*`` constants): a dark start marker, bright sync clocks and
five data bits (index mod 32). Luminance-only coding survives the lossy
h264/yuv420p round trip, so tests can recover the source frame of a strip
column without trusting filenames.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np

PATTERNS = ("constant", "reverse", "vfr")
WIDTH, HEIGHT, BAR_W = 160, 120, 8

# frame-number barcode, all on the top row using luminance only (robust to
# 4:2:0 chroma subsampling):
#   column 0     -> dark start marker
#   columns 1,3,5,7,9,11 -> bright sync clocks
#   columns 2,4,6,8,10   -> 5 data bits, frame index mod 32
ID_COLS = 12
ID_START = 0
ID_SYNC = (1, 3, 5, 7, 9, 11)
ID_BITS = (2, 4, 6, 8, 10)
ID_ON, ID_OFF, ID_THRESHOLD = 235, 25, 100


def _write_id_band(img: np.ndarray, index: int) -> None:
    for c in range(ID_COLS):
        if c == ID_START:
            on = False
        elif c in ID_SYNC:
            on = True
        else:
            on = bool((index >> (ID_BITS.index(c))) & 1)
        img[0, c] = ID_ON if on else ID_OFF


def read_encoded_index(frame: np.ndarray) -> int | None:
    """Recover the frame number from the luminance barcode.

    Reads the top row across ``ID_COLS`` columns; returns ``None`` when the
    full code cannot be read (narrow slice) or the sync markers are lost.
    """
    if frame.shape[1] < ID_COLS:
        return None
    lum = frame[0, :ID_COLS, :].mean(axis=1)
    if lum[ID_START] >= ID_THRESHOLD:
        return None
    if any(lum[c] < ID_THRESHOLD for c in ID_SYNC):
        return None
    value = 0
    for c in ID_BITS:
        if lum[c] >= ID_THRESHOLD:
            value |= 1 << (c // 2 - 1)
    return value


def _bar_x(pattern: str, t: float, duration: float) -> float:
    span = WIDTH - BAR_W
    if pattern == "reverse":
        half = duration / 2
        if t <= half:
            return span * (t / half)
        return span * (1 - (t - half) / half)
    # constant & vfr: steady motion, wrapped at the right edge
    speed = span / duration * 2.0
    return (speed * t) % max(span, 1)


def render_frame(pattern: str, index: int, t: float,
                 duration: float) -> np.ndarray:
    """Render one RGB test frame (uint8 HxWx3)."""
    img = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    # dim horizontal gradient so slit position itself is visible
    img[:, :, 2] = (np.linspace(0, 60, WIDTH, dtype=np.uint8))[None, :]

    x = int(round(_bar_x(pattern, t, duration)))
    img[:, x:x + BAR_W, :] = (230, 230, 230)

    # luminance barcode of the frame number (robust to 4:2:0 chroma loss)
    _write_id_band(img, index)
    # time marker band: brightness of row 2 tracks t (VFR timing check)
    img[2, :, 1] = int(255 * min(max(t / max(duration, 1e-9), 0), 1))
    return img


def _write_png(frame: np.ndarray, path: Path) -> None:
    import PIL.Image
    PIL.Image.fromarray(frame).save(path)


def _encode_cfr(frames_dir: Path, out: Path, fps: int) -> None:
    subprocess.run([
        "ffmpeg", "-y", "-v", "error", "-framerate", str(fps),
        "-i", str(frames_dir / "f_%05d.png"),
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-crf", "18", str(out),
    ], check=True)


def _encode_vfr(frames_dir: Path, pts: list[float], out: Path) -> None:
    """Encode with explicit, uneven per-frame PTS via the concat demuxer.

    ``duration`` entries become PTS *gaps*; each image is listed once so no
    duplicated final frame is produced.  A trailing dummy duration closes the
    last frame's presentation interval without adding a frame.
    """
    n = len(pts)
    gaps = np.diff(pts).tolist() if n > 1 else [1.0]
    lines = []
    for i in range(n):
        lines.append(f"file '{(frames_dir / f'f_{i:05d}.png').as_posix()}'")
        lines.append(f"duration {gaps[i] if i < len(gaps) else gaps[-1]:.6f}")
    list_file = frames_dir / "list.txt"
    list_file.write_text("\n".join(lines))
    subprocess.run([
        "ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0",
        "-i", str(list_file), "-fps_mode", "vfr",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-crf", "18", str(out),
    ], check=True)


def generate(pattern: str, out_path: str,
             n_frames: int = 40, fps: int = 10) -> Path:
    """Render and encode one of the built-in sample clips."""
    if pattern not in PATTERNS:
        raise ValueError(f"unknown pattern {pattern!r}; choose from {PATTERNS}")
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg not found on PATH")

    duration = n_frames / fps
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        if pattern == "vfr":
            # uneven PTS gaps summing to the same nominal duration
            rng = np.random.default_rng(17553)
            gaps = rng.uniform(0.4, 1.8, n_frames)
            gaps = gaps / gaps.sum() * duration
            pts = np.concatenate([[0.0], np.cumsum(gaps)[:-1]])
            for i, t in enumerate(pts):
                _write_png(render_frame(pattern, i, float(t), duration),
                           d / f"f_{i:05d}.png")
            _encode_vfr(d, pts.tolist(), out)
        else:
            for i in range(n_frames):
                t = i / fps
                _write_png(render_frame(pattern, i, t, duration),
                           d / f"f_{i:05d}.png")
            _encode_cfr(d, out, fps)
    return out
