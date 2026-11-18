"""Pure data model and compositor for the APNG frame tool.

The model deliberately has no Qt dependency: the UI, the exporter and the
tests all use the same deterministic functions.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any

import numpy as np

MAX_FRAMES = 20
MAX_CANVAS = 512
MIN_CANVAS = 1
MIN_DURATION_MS = 1
MAX_DURATION_MS = 65535
MAX_LOOP_COUNT = 65535

BLEND_REPLACE = "replace"
BLEND_OVER = "over"
BLEND_LABELS = {
    BLEND_REPLACE: "直接替换覆盖区域",
    BLEND_OVER: "按透明度叠加",
}
BLEND_ORDER = (BLEND_REPLACE, BLEND_OVER)

DISPOSE_KEEP = "keep"
DISPOSE_CLEAR = "clear"
DISPOSE_PREVIOUS = "previous"
DISPOSE_LABELS = {
    DISPOSE_KEEP: "播放后保留",
    DISPOSE_CLEAR: "清空本帧区域",
    DISPOSE_PREVIOUS: "恢复到本帧之前画面",
}
DISPOSE_ORDER = (DISPOSE_KEEP, DISPOSE_CLEAR, DISPOSE_PREVIOUS)


class ValidationError(ValueError):
    """Raised when a frame/project cannot be composed or exported."""


def _require_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, np.integer)):
        raise ValidationError(f"{label}必须是整数，当前为 {value!r}")
    return int(value)


def _copy_rgba(tile: Any) -> np.ndarray:
    arr = np.asarray(tile)
    if arr.ndim != 3 or arr.shape[2] != 4:
        shape = "x".join(str(v) for v in arr.shape)
        raise ValidationError(f"图块必须是 RGBA 四通道图像，当前形状为 {shape}")
    if arr.dtype != np.uint8:
        raise ValidationError(f"图块必须是 8 位 RGBA 图像，当前数据类型为 {arr.dtype}")
    if arr.shape[0] < 1 or arr.shape[1] < 1:
        raise ValidationError("图块尺寸必须至少为 1×1 像素")
    return np.array(arr, dtype=np.uint8, copy=True, order="C")


@dataclass
class Frame:
    """One RGBA tile and its placement/playback instructions."""

    tile: np.ndarray
    x: int = 0
    y: int = 0
    duration_ms: int = 120
    blend: str = BLEND_OVER
    dispose: str = DISPOSE_KEEP
    name: str = "图块"

    def __post_init__(self) -> None:
        self.tile = _copy_rgba(self.tile)
        self.x = _require_int(self.x, "图块 X 坐标")
        self.y = _require_int(self.y, "图块 Y 坐标")
        self.duration_ms = _require_int(self.duration_ms, "显示时长")
        if not MIN_DURATION_MS <= self.duration_ms <= MAX_DURATION_MS:
            raise ValidationError(
                f"显示时长必须在 {MIN_DURATION_MS}–{MAX_DURATION_MS} 毫秒之间，"
                f"当前为 {self.duration_ms} ms"
            )
        if self.blend not in BLEND_LABELS:
            raise ValidationError(f"未知覆盖方式：{self.blend!r}")
        if self.dispose not in DISPOSE_LABELS:
            raise ValidationError(f"未知处置方式：{self.dispose!r}")

    @property
    def width(self) -> int:
        return int(self.tile.shape[1])

    @property
    def height(self) -> int:
        return int(self.tile.shape[0])

    def clone(self, **changes: Any) -> "Frame":
        return replace(self, **changes)


@dataclass
class Project:
    """A bounded canvas and an ordered list of frames."""

    canvas_width: int = 96
    canvas_height: int = 96
    frames: list[Frame] = field(default_factory=list)
    loop_count: int = 0

    def __post_init__(self) -> None:
        self.canvas_width = _require_int(self.canvas_width, "画布宽度")
        self.canvas_height = _require_int(self.canvas_height, "画布高度")
        self.loop_count = _require_int(self.loop_count, "循环次数")
        self.validate()

    # ---------------------------------------------------------------- limits
    def validate(self, *, require_frames: bool = False) -> None:
        if not (MIN_CANVAS <= self.canvas_width <= MAX_CANVAS) or not (
            MIN_CANVAS <= self.canvas_height <= MAX_CANVAS
        ):
            raise ValidationError(
                f"画布尺寸无效：{self.canvas_width}×{self.canvas_height}，"
                f"宽和高都必须为 {MIN_CANVAS}–{MAX_CANVAS} 像素"
            )
        if len(self.frames) > MAX_FRAMES:
            raise ValidationError(
                f"帧数量超出上限：最多 {MAX_FRAMES} 帧，当前有 {len(self.frames)} 帧"
            )
        if not (0 <= self.loop_count <= MAX_LOOP_COUNT):
            raise ValidationError(
                f"循环次数必须是 0–{MAX_LOOP_COUNT} 的整数（0 表示无限循环）"
            )
        if require_frames and not self.frames:
            raise ValidationError("至少需要 1 帧才能播放或导出")
        for index, frame in enumerate(self.frames):
            self.validate_frame(frame, index=index)

    def validate_frame(self, frame: Frame, *, index: int | None = None) -> None:
        prefix = f"第 {index + 1} 帧" if index is not None else "该帧"
        if not isinstance(frame, Frame):
            raise ValidationError(f"{prefix}不是有效的帧对象")
        _copy_rgba(frame.tile)
        if not (MIN_DURATION_MS <= frame.duration_ms <= MAX_DURATION_MS):
            raise ValidationError(
                f"{prefix}显示时长无效：{frame.duration_ms} ms，"
                f"必须是 {MIN_DURATION_MS}–{MAX_DURATION_MS} 的整数毫秒"
            )
        if frame.blend not in BLEND_LABELS:
            raise ValidationError(f"{prefix}覆盖方式无效：{frame.blend!r}")
        if frame.dispose not in DISPOSE_LABELS:
            raise ValidationError(f"{prefix}处置方式无效：{frame.dispose!r}")
        tw, th = frame.width, frame.height
        cw, ch = self.canvas_width, self.canvas_height
        if tw > cw or th > ch:
            raise ValidationError(
                f"{prefix}图块尺寸 {tw}×{th} 超过画布 {cw}×{ch}"
            )
        if frame.x < 0 or frame.y < 0:
            raise ValidationError(
                f"{prefix}图块越界：位置 ({frame.x}, {frame.y}) 不能为负数"
            )
        if frame.x + tw > cw or frame.y + th > ch:
            parts = []
            if frame.x + tw > cw:
                parts.append(f"右侧超出 {frame.x + tw - cw} 像素")
            if frame.y + th > ch:
                parts.append(f"底部超出 {frame.y + th - ch} 像素")
            raise ValidationError(
                f"{prefix}图块越界：图块 {tw}×{th} 位于 ({frame.x}, {frame.y})，"
                f"画布 {cw}×{ch}，" + "、".join(parts)
            )

    def bbox(self, index: int) -> tuple[int, int, int, int]:
        frame = self.frame(index)
        return (frame.x, frame.y, frame.x + frame.width, frame.y + frame.height)

    def frame(self, index: int) -> Frame:
        if not isinstance(index, int) or not 0 <= index < len(self.frames):
            raise ValidationError(f"帧索引无效：{index}")
        return self.frames[index]

    # ------------------------------------------------------------- mutations
    def add_frame(self, frame: Frame, index: int | None = None) -> int:
        if len(self.frames) >= MAX_FRAMES:
            raise ValidationError(
                f"帧数量已达上限：最多 {MAX_FRAMES} 帧，无法继续添加"
            )
        self.validate_frame(frame)
        if index is None:
            self.frames.append(frame)
            return len(self.frames) - 1
        if not 0 <= index <= len(self.frames):
            raise ValidationError(f"插入位置无效：{index}")
        self.frames.insert(index, frame)
        return index

    def remove_frame(self, index: int) -> Frame:
        self.frame(index)
        return self.frames.pop(index)

    def move_frame(self, index: int, delta: int) -> int:
        self.frame(index)
        new_index = index + int(delta)
        if not 0 <= new_index < len(self.frames):
            if new_index < 0:
                raise ValidationError("已经是第一帧，无法上移")
            raise ValidationError("已经是最后一帧，无法下移")
        self.frames[index], self.frames[new_index] = (
            self.frames[new_index],
            self.frames[index],
        )
        return new_index

    def update_frame(self, index: int, **changes: Any) -> Frame:
        old = self.frame(index)
        candidate = old.clone(**changes)
        self.validate_frame(candidate, index=index)
        self.frames[index] = candidate
        return candidate

    def set_canvas_size(self, width: int, height: int) -> None:
        width = _require_int(width, "画布宽度")
        height = _require_int(height, "画布高度")
        if not (MIN_CANVAS <= width <= MAX_CANVAS) or not (
            MIN_CANVAS <= height <= MAX_CANVAS
        ):
            raise ValidationError(
                f"画布尺寸无效：{width}×{height}，"
                f"宽和高都必须为 {MIN_CANVAS}–{MAX_CANVAS} 像素"
            )
        old_w, old_h = self.canvas_width, self.canvas_height
        self.canvas_width, self.canvas_height = width, height
        try:
            self.validate()
        except ValidationError:
            self.canvas_width, self.canvas_height = old_w, old_h
            raise

    def set_loop_count(self, count: int) -> None:
        count = _require_int(count, "循环次数")
        if not 0 <= count <= MAX_LOOP_COUNT:
            raise ValidationError(
                f"循环次数必须是 0–{MAX_LOOP_COUNT} 的整数（0 表示无限循环）"
            )
        self.loop_count = count

    @property
    def total_duration_ms(self) -> int:
        return sum(frame.duration_ms for frame in self.frames)

    @property
    def canvas_size(self) -> tuple[int, int]:
        return self.canvas_width, self.canvas_height

    def copy(self) -> "Project":
        return Project(
            canvas_width=self.canvas_width,
            canvas_height=self.canvas_height,
            frames=[frame.clone() for frame in self.frames],
            loop_count=self.loop_count,
        )


def alpha_over(dst: np.ndarray, src: np.ndarray) -> np.ndarray:
    """Source-over compositing for straight-alpha uint8 RGBA arrays.

    Rounding is integer round-half-up.  Fully uncovered destinations become
    transparent black.  The formula is the standard straight-alpha source-over
    formula:

        a_out = a_s + a_d (1 - a_s)
        c_out = (c_s a_s + c_d a_d (1 - a_s)) / a_out
    """

    dst = np.asarray(dst, dtype=np.uint8)
    src = np.asarray(src, dtype=np.uint8)
    if dst.shape != src.shape or dst.ndim != 3 or dst.shape[2] != 4:
        raise ValidationError("叠加运算要求两张同尺寸的 RGBA 图块")

    s = src.astype(np.uint64)
    d = dst.astype(np.uint64)
    sa = s[..., 3:4]
    da = d[..., 3:4]
    inv = 255 - sa
    den = sa * 255 + da * inv  # out_alpha * 255
    num = s[..., :3] * (sa * 255) + d[..., :3] * (da * inv)

    out = np.zeros(src.shape, dtype=np.uint8)
    covered = den[..., 0] > 0
    if np.any(covered):
        out_alpha = ((den[..., 0] + 127) // 255).astype(np.uint8)
        # Only divide where the output alpha is non-zero; the divisor is
        # clamped so fully transparent pixels cannot trigger divide-by-zero.
        divisor = np.where(covered[..., None], 2 * den, 1)
        out_rgb = ((2 * num + den) // divisor).astype(np.uint8)
        out[..., :3] = np.where(covered[..., None], out_rgb, 0)
        out[..., 3] = np.where(covered, out_alpha, 0)
    return out


def _draw_frame(canvas: np.ndarray, frame: Frame) -> None:
    x0, y0 = frame.x, frame.y
    x1, y1 = x0 + frame.width, y0 + frame.height
    region = canvas[y0:y1, x0:x1]
    if frame.blend == BLEND_REPLACE:
        region[...] = frame.tile
    elif frame.blend == BLEND_OVER:
        region[...] = alpha_over(region, frame.tile)
    else:  # pragma: no cover - guarded by validation
        raise ValidationError(f"未知覆盖方式：{frame.blend!r}")


def compose_project(project: Project) -> list[np.ndarray]:
    """Compose every displayed state from frame 0, independent of history.

    ``result[i]`` is the canvas shown while frame ``i`` is displayed.  A
    frame's dispose mode is applied afterwards, before the next frame:

    * keep     – leave the canvas untouched;
    * clear    – zero the frame's own tile rectangle;
    * previous – restore the frame's own tile rectangle to the canvas as it
      was immediately before this frame was drawn.

    The function always starts from a transparent canvas and walks the whole
    sequence, so seeking directly to any frame yields the same pixels.
    """

    project.validate()
    width, height = project.canvas_width, project.canvas_height
    canvas = np.zeros((height, width, 4), dtype=np.uint8)
    displayed: list[np.ndarray] = []
    for frame in project.frames:
        before = canvas.copy()
        _draw_frame(canvas, frame)
        displayed.append(canvas.copy())
        x0, y0 = frame.x, frame.y
        x1, y1 = x0 + frame.width, y0 + frame.height
        if frame.dispose == DISPOSE_CLEAR:
            canvas[y0:y1, x0:x1] = 0
        elif frame.dispose == DISPOSE_PREVIOUS:
            canvas[y0:y1, x0:x1] = before[y0:y1, x0:x1]
    return displayed


def composite_at(project: Project, index: int) -> np.ndarray:
    """Return one displayed composite, recomputed from the start."""

    displayed = compose_project(project)
    if not 0 <= index < len(displayed):
        raise ValidationError(f"帧索引无效：{index}")
    return displayed[index].copy()


def summarize_difference(expected: np.ndarray, actual: np.ndarray) -> str:
    """Human-readable pixel difference summary used by export verification."""

    if expected.shape != actual.shape:
        return f"尺寸不同：期望 {expected.shape}，实际 {actual.shape}"
    if np.array_equal(expected, actual):
        return "完全一致"
    diff = np.any(expected != actual, axis=2)
    count = int(diff.sum())
    ys, xs = np.nonzero(diff)
    y, x = int(ys[0]), int(xs[0])
    return (
        f"{count} 个像素不同；首个差异点 ({x}, {y}) "
        f"期望 {tuple(int(v) for v in expected[y, x])}，"
        f"实际 {tuple(int(v) for v in actual[y, x])}"
    )
