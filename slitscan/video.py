"""Video access through ffmpeg / ffprobe.

Frames are decoded to an in-memory uint8 RGB array.  Per-frame presentation
timestamps come from ``ffprobe -show_frames`` rather than assuming a constant
frame rate, so variable-frame-rate (VFR) videos are handled correctly.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass

import numpy as np


class VideoError(RuntimeError):
    pass


@dataclass
class VideoInfo:
    path: str
    width: int
    height: int
    frame_count: int
    duration: float
    timestamps: np.ndarray  # per-frame pts in seconds

    @property
    def is_vfr(self) -> bool:
        if len(self.timestamps) < 3:
            return False
        dts = np.diff(self.timestamps)
        return float(np.std(dts)) > 1e-4


def _require_tools() -> None:
    for tool in ("ffmpeg", "ffprobe"):
        if shutil.which(tool) is None:
            raise VideoError(f"{tool} not found on PATH")


def probe(path: str) -> VideoInfo:
    """Read stream metadata and per-frame presentation timestamps."""
    _require_tools()

    meta_cmd = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,nb_frames,duration",
        "-of", "json", path,
    ]
    meta = json.loads(subprocess.check_output(meta_cmd))
    streams = meta.get("streams")
    if not streams:
        raise VideoError(f"no video stream in {path}")
    st = streams[0]
    width = int(st["width"])
    height = int(st["height"])

    pts_cmd = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "frame=pts_time", "-of", "csv=p=0", path,
    ]
    raw = subprocess.check_output(pts_cmd, text=True).strip().splitlines()
    pts = []
    for line in raw:
        field = line.split(",", 1)[0].strip()
        if field and field != "N/A":
            pts.append(float(field))
    if not pts:
        # container without per-frame pts: fall back to stream duration/nb_frames
        nb = int(st.get("nb_frames", 0) or 0)
        dur = float(st.get("duration", 0.0) or 0.0)
        if nb and dur:
            pts = list(np.linspace(0, dur, nb, endpoint=False))
    if not pts:
        raise VideoError(f"could not determine frame timestamps for {path}")

    duration = float(st.get("duration") or 0.0) or float(pts[-1])
    return VideoInfo(path=path, width=width, height=height,
                     frame_count=len(pts), duration=duration,
                     timestamps=np.asarray(pts, dtype=float))


def decode_frames(
    path: str,
    info: VideoInfo | None = None,
    max_memory_mb: int = 4096,
) -> tuple[np.ndarray, np.ndarray]:
    """Decode every frame as RGB.

    Returns ``(frames, timestamps)`` with ``frames`` shaped
    ``(N, H, W, 3)`` uint8.  Raises ``VideoError`` if the estimated memory
    footprint exceeds ``max_memory_mb``.
    """
    _require_tools()
    if info is None:
        info = probe(path)

    est_bytes = info.frame_count * info.height * info.width * 3
    if est_bytes > max_memory_mb * 1024 * 1024:
        raise VideoError(
            f"decoded video needs ~{est_bytes / 1024 / 1024:.0f} MB, over the "
            f"{max_memory_mb} MB guard. Trim a shorter time range or use a "
            f"smaller clip."
        )

    # -fps_mode passthrough keeps every original frame (no CFR resampling),
    # which is essential for VFR material. It is an *output* option in
    # modern ffmpeg, so it must come after -i.
    cmd = [
        "ffmpeg", "-v", "error",
        "-i", path, "-fps_mode", "passthrough",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]
    proc = subprocess.run(cmd, check=True, capture_output=True)
    frame_bytes = info.height * info.width * 3
    if len(proc.stdout) % frame_bytes != 0:
        raise VideoError("raw decode size is not a whole number of frames")
    n = len(proc.stdout) // frame_bytes

    frames = np.frombuffer(proc.stdout, dtype=np.uint8).reshape(
        n, info.height, info.width, 3
    ).copy()  # own the buffer (proc.stdout is released after return)

    ts = info.timestamps
    if len(ts) != n:
        # unusual container: keep what probes gave, extrapolate the remainder
        if len(ts) < n:
            delta = float(np.mean(np.diff(ts))) if len(ts) > 1 else 1 / 30
            extra = ts[-1] + np.arange(1, n - len(ts) + 1) * delta
            ts = np.concatenate([ts, extra])
        else:
            ts = ts[:n]
    return frames, ts.astype(float)
