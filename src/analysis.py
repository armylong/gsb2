"""Cut detection, temporal window planning, and the two filters.

One frame at a time, so the GUI can step, replay and export without holding the
whole clip in RAM.  The caller passes a frame source with random access by
index (``frameio.Sequence`` or a test stub).

Two filters are computed from the *same* window so they can be compared on
identical input:

``mean``   a straight average of every frame in the window.  Removes grain and
           flicker, but drags the moving subject into a ghost trail.
``atten``  the same average, blended back towards the current frame wherever
           the window shows temporal activity.  Static pixels are filtered exactly
           like ``mean``; pixels touched by the moving subject keep their raw
           value, so no trail is created and only the moving area keeps its grain.

Window policy (deterministic, never mixes shots):

* a window is always clipped to the shot containing the frame;
* it is centred on the frame (``frame - radius .. frame + radius``) and clipped
  at the shot edges - it is never padded, mirrored, or shifted past a cut;
* if the available window has fewer than ``MIN_SAMPLES`` frames (e.g. radius 0,
  or the first two frames of a shot), the frame is passed through unfiltered
  and the result is flagged ``degraded``.  This is the only "not enough samples"
  rule, and it is visible in the UI and in the verification output.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

import cv2
import numpy as np

MIN_SAMPLES = 3
DEFAULT_RADIUS = 2
MAX_RADIUS = 6

# Cut detection: a hard cut moves most of the luma histogram at once, while a
# moving subject touches a minority of pixels.  Both signals must agree.
CUT_HIST_BINS = 64
CUT_HIST_DISTANCE = 0.30      # cosine distance between normalised histograms
CUT_LUMA_DELTA = 10.0         # plus a global mean-luma jump (0..255)
CUT_MIN_SPACING = 8           # frames


class FrameSource(Protocol):
    def read(self, index: int) -> np.ndarray | None: ...


@dataclass(frozen=True)
class Params:
    radius: int = DEFAULT_RADIUS
    motion_threshold: float = 26.0   # luma deviation counted as motion (0..255)

    @property
    def desired_window(self) -> int:
        return 2 * self.radius + 1


@dataclass(frozen=True)
class Shot:
    index: int
    start: int        # inclusive
    end: int          # inclusive

    @property
    def length(self) -> int:
        return self.end - self.start + 1

    def contains(self, frame: int) -> bool:
        return self.start <= frame <= self.end


@dataclass
class Window:
    frames: list[int]
    desired: int
    shot_index: int
    clipped: bool        # shorter than desired because of a shot edge
    degraded: bool       # fewer than MIN_SAMPLES: pass the frame through

    @property
    def size(self) -> int:
        return len(self.frames)


@dataclass
class Result:
    frame: int
    window: Window
    mean: np.ndarray          # BGR uint8
    atten: np.ndarray         # BGR uint8
    activity: np.ndarray      # float32, max channel deviation from temporal median
    motion_mask: np.ndarray   # bool, activity > threshold
    trail: list[tuple[int, int, int]] = field(default_factory=list)


# ------------------------------------------------------------- shots & cuts

def _hist_luma(gray: np.ndarray) -> tuple[np.ndarray, float]:
    hist = cv2.calcHist([gray], [0], None, [CUT_HIST_BINS], [0, 256]).ravel()
    hist = hist / max(1.0, float(hist.sum()))
    return hist.astype(np.float32), float(gray.mean())


def _cosine_distance(a: np.ndarray, b: np.ndarray) -> float:
    denom = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denom <= 1e-9:
        return 0.0
    return 1.0 - float(np.dot(a, b)) / denom


def detect_cuts(frames: list[np.ndarray]) -> list[int]:
    """Frame indices that begin a new shot; always includes 0."""
    cuts = [0]
    prev: tuple[np.ndarray, float] | None = None
    last_cut = 0
    for i, frame in enumerate(frames):
        cur = _hist_luma(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
        if prev is not None and i - last_cut >= CUT_MIN_SPACING:
            if (_cosine_distance(prev[0], cur[0]) >= CUT_HIST_DISTANCE
                    and abs(prev[1] - cur[1]) >= CUT_LUMA_DELTA):
                cuts.append(i)
                last_cut = i
        prev = cur
    return cuts


def build_shots(cuts: list[int], frame_count: int) -> list[Shot]:
    starts = sorted({c for c in cuts if 0 <= c < frame_count}) or [0]
    shots: list[Shot] = []
    for i, start in enumerate(starts):
        end = starts[i + 1] - 1 if i + 1 < len(starts) else frame_count - 1
        if end >= start:
            shots.append(Shot(i, start, end))
    return shots


def shot_at(frame: int, shots: list[Shot]) -> Shot:
    if not shots:
        raise ValueError("no shots")
    for shot in shots:
        if shot.contains(frame):
            return shot
    return shots[0] if frame < shots[0].start else shots[-1]


def window_for(frame: int, shot: Shot, radius: int) -> Window:
    """Centred window clipped to the shot; pass-through below MIN_SAMPLES."""
    desired = 2 * max(0, radius) + 1
    if radius <= 0:
        frames = [frame]
    else:
        frames = list(range(max(shot.start, frame - radius),
                            min(shot.end, frame + radius) + 1))
    return Window(frames, desired, shot.index,
                  clipped=len(frames) < desired,
                  degraded=len(frames) < MIN_SAMPLES)


def plan_windows(shots: list[Shot], radius: int) -> list[Window]:
    return [window_for(f, shot, radius)
            for shot in shots for f in range(shot.start, shot.end + 1)]


# ------------------------------------------------------------------ filtering

def filter_stack(stack: np.ndarray, current_index: int,
                 params: Params) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Filter a (T,H,W,C) uint8 window whose centre-of-interest is ``current_index``.

    Returns ``(mean, atten, activity, motion)``.  Shared by the interactive
    analyser and the exporter so preview and export can never diverge.
    """
    data = stack.astype(np.float32)
    # Spatially denoise each frame before measuring activity: grain is
    # high-frequency and cancels locally, an object edge does not.  Without this
    # the grain's per-frame outliers would trip the motion threshold.
    smooth = np.stack([cv2.GaussianBlur(f, (5, 5), 1.4) for f in data])
    median = np.median(smooth, axis=0)
    mean = data.mean(axis=0)

    # Activity = how far any frame strays from the robust temporal median.  The
    # median is not pulled by the moving subject, so the subject's pixels score
    # high while grain stays below the threshold.
    activity = np.max(np.abs(smooth - median), axis=(0, 3))
    motion = activity > params.motion_threshold

    # weight 1 => keep the current frame (active), 0 => take the filtered mean.
    weight = cv2.GaussianBlur(motion.astype(np.float32), (5, 5), 1.2)
    weight = np.clip(weight, 0.0, 1.0)[:, :, None]
    atten = weight * data[current_index] + (1.0 - weight) * mean
    return (np.clip(mean, 0, 255).astype(np.uint8),
            np.clip(atten, 0, 255).astype(np.uint8),
            activity.astype(np.float32), motion)


def analyze(src: FrameSource, frame: int, shots: list[Shot],
            params: Params, want_trail: bool = False) -> Result:
    shot = shot_at(frame, shots)
    window = window_for(frame, shot, params.radius)
    frames = [src.read(i) for i in window.frames]
    if any(f is None for f in frames):
        raise ValueError(f"missing frame in window for frame {frame}")
    current = frames[window.frames.index(frame)]

    if window.degraded:
        shape = current.shape[:2]
        return Result(frame, window, current.copy(), current.copy(),
                      np.zeros(shape, np.float32), np.zeros(shape, bool))

    stack = np.stack(frames, axis=0)
    mean, atten, activity, motion = filter_stack(
        stack, window.frames.index(frame), params)
    trail = trail_points(stack, params.motion_threshold) if want_trail else []
    return Result(frame, window, mean, atten, activity, motion, trail)


def trail_points(stack: np.ndarray, threshold: float) -> list[tuple[int, int, int]]:
    """Centroid of the largest active blob in each frame of the window.

    Returns ``(window_index, x, y)`` - the motion trail the viewer draws, and
    the data behind "运动尾迹" in the mean branch.
    """
    data = np.stack([cv2.GaussianBlur(f, (5, 5), 1.4) for f in stack])
    gray = np.stack([cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in data.astype(np.uint8)])
    median = np.median(gray, axis=0)
    points: list[tuple[int, int, int]] = []
    for idx in range(gray.shape[0]):
        mask = (np.abs(gray[idx] - median) > threshold).astype(np.uint8)
        if int(mask.sum()) < 40:
            continue
        count, _, stats, centroids = cv2.connectedComponentsWithStats(mask, 8)
        best, best_area = -1, 0
        for label in range(1, count):
            area = int(stats[label, cv2.CC_STAT_AREA])
            if area > best_area:
                best, best_area = label, area
        if best > 0:
            cx, cy = centroids[best]
            points.append((idx, int(round(cx)), int(round(cy))))
    return points


# ------------------------------------------------------------------- metrics

def rmse(a: np.ndarray, b: np.ndarray, mask: np.ndarray | None = None) -> float:
    sq = (a.astype(np.float32) - b.astype(np.float32)) ** 2
    if sq.ndim == 3:
        sq = sq.mean(axis=2)
    if mask is not None:
        keep = np.asarray(mask, dtype=bool)
        if not keep.any():
            return 0.0
        sq = sq[keep]
    return float(np.sqrt(np.mean(sq)))


def region_masks(mask_frame: np.ndarray | None, shape: tuple[int, int],
                 fallback: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Return (static_mask, motion_mask).

    The sample ships a dilated moving-subject mask; if it is missing, the
    per-window activity mask stands in.  The static mask excludes a 5 px rim
    around the subject so edge mixing doesn't pollute the numbers.
    """
    if mask_frame is not None:
        gray = (mask_frame if mask_frame.ndim == 2
                else cv2.cvtColor(mask_frame, cv2.COLOR_BGR2GRAY))
        motion = cv2.resize(gray, (shape[1], shape[0]),
                            interpolation=cv2.INTER_NEAREST) > 127
    elif fallback is not None:
        motion = np.asarray(fallback, dtype=bool)
    else:
        motion = np.zeros(shape, bool)
    rim = cv2.dilate(motion.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
    return ~rim, motion
