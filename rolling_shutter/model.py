"""滚动快门 / 全局快门合成模拟核心（纯 numpy，不依赖 Qt）。

时间约定
========
所有时间均为相对短片起点的绝对秒。第 n 帧名义起点 ``t0 = n / fps``。

* 全局快门（global）：所有行共用曝光窗 ``[t0, t0 + E]``，读出在曝光结束后
  依次进行，成像内容与读出过程无关。
* 滚动快门（rolling）：第 r 行在读出时刻 ``readout(r)`` 采样，其曝光窗为
  ``[readout(r) - E, readout(r)]``；读出时刻在 ``[t0, t0 + R]`` 内按方向
  线性分布，R 为总读出时间。

物体做匀速直线运动 ``x(t) = x0 + v*t``，每个像素在曝光窗内被物体覆盖的
时间占比用解析式精确求出（常数速度下无需蒙特卡洛采样，结果完全确定）。
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from typing import Literal

import numpy as np

DIRECTION_TOP_DOWN = "top-down"
DIRECTION_BOTTOM_UP = "bottom-up"
DIRECTIONS = (DIRECTION_TOP_DOWN, DIRECTION_BOTTOM_UP)
MODE_GLOBAL = "global"
MODE_ROLLING = "rolling"
MODES = (MODE_GLOBAL, MODE_ROLLING)


@dataclass(frozen=True)
class ObjectSpec:
    """一个水平匀速运动的竖直色条。

    行方向覆盖 ``[y0, y1)``，列方向在时刻 t 覆盖 ``[x0+v*t, x0+v*t+width)``。
    坐标为连续像素坐标，像素列 c 覆盖 x∈[c, c+1)。
    """

    name: str
    x0: float
    velocity: float  # px/s
    width: float  # px
    y0: int
    y1: int
    color: tuple[float, float, float]


def _default_objects() -> tuple[ObjectSpec, ObjectSpec]:
    return (
        ObjectSpec("物体1（快）", x0=10.0, velocity=300.0, width=16.0,
                   y0=18, y1=66, color=(0.20, 0.85, 0.95)),
        ObjectSpec("物体2（慢）", x0=10.0, velocity=120.0, width=10.0,
                   y0=78, y1=106, color=(0.98, 0.55, 0.18)),
    )


@dataclass(frozen=True)
class SimParams:
    # ---- 画面与帧时间 ----
    width: int = 160
    height: int = 120
    fps: float = 30.0
    n_frames: int = 32
    # ---- 快门 ----
    readout_direction: Literal["top-down", "bottom-up"] = DIRECTION_TOP_DOWN
    total_readout: float = 0.030  # 秒，一帧内第一行到最后一行的读出跨度 R
    exposure: float = 0.020  # 秒，单行曝光时长 E
    ambient: float = 0.05  # 背景亮度
    # ---- 闪光（绝对时刻）----
    flash_enabled: bool = False
    flash_start: float = 0.410  # 秒
    flash_duration: float = 0.003  # 秒
    flash_intensity: float = 0.85
    # ---- 运动物体 ----
    objects: tuple[ObjectSpec, ...] = field(default_factory=_default_objects)

    @property
    def frame_period(self) -> float:
        return 1.0 / self.fps

    @property
    def clip_duration(self) -> float:
        return self.n_frames / self.fps

    def to_dict(self) -> dict:
        return asdict(self)

    def canonical_json(self) -> bytes:
        """规范化 JSON。浮点统一保留 9 位小数，亚纳秒级浮点抖动不影响指纹。"""
        def round_floats(obj):
            if isinstance(obj, float):
                return round(obj, 9)
            if isinstance(obj, dict):
                return {k: round_floats(v) for k, v in obj.items()}
            if isinstance(obj, (list, tuple)):
                return [round_floats(v) for v in obj]
            return obj
        return json.dumps(round_floats(self.to_dict()), sort_keys=True,
                          ensure_ascii=False).encode("utf-8")

    def signature(self) -> str:
        """参数指纹：参数不同则指纹不同，用于标记画面属于哪一组设置。"""
        return hashlib.sha256(self.canonical_json()).hexdigest()[:16]

    def validate(self) -> tuple[list[str], list[str]]:
        """返回 (错误, 警告)。错误会阻止渲染，警告只在界面提示。"""
        errors: list[str] = []
        warnings: list[str] = []
        if self.width < 2 or self.height < 2:
            errors.append("画面宽高必须 >= 2 像素")
        if self.fps <= 0:
            errors.append("fps 必须为正数")
        if self.n_frames < 1:
            errors.append("帧数至少为 1")
        if self.total_readout < 0 or self.exposure < 0:
            errors.append("读出时间与曝光时间不能为负")
        if self.flash_duration < 0:
            errors.append("闪光时长不能为负")
        for o in self.objects:
            if not (0 <= o.y0 < o.y1 <= self.height):
                errors.append(f"{o.name} 的行范围 [{o.y0},{o.y1}) 超出画面")
            if o.width <= 0:
                errors.append(f"{o.name} 宽度必须为正")
        if self.total_readout > self.frame_period + 1e-12:
            warnings.append("总读出时间超过帧周期，相邻帧读出会重叠")
        if (self.readout_direction not in DIRECTIONS):
            errors.append(f"未知读出方向: {self.readout_direction}")
        if self.exposure > self.total_readout + 1e-12 and self.total_readout > 0:
            warnings.append("曝光时间大于总读出时间，滚动快门各行曝光窗会重叠")
        if self.flash_enabled and self.flash_start < 0:
            errors.append("闪光开始时刻不能为负")
        return errors, warnings


@dataclass
class Clip:
    """一次渲染的结果。"""

    params: SimParams
    mode: str  # 'global' | 'rolling'
    frames: np.ndarray  # float32 [N,H,W,3]，取值 [0,1]
    windows: np.ndarray  # float64 [N,H,2]，每行曝光窗 (start,end)，绝对秒
    readout_starts: np.ndarray  # float64 [N,H]，每行读出开始时刻
    flash_overlap: np.ndarray  # float64 [N,H]，闪光占该行曝光窗的比例
    row_means: np.ndarray  # float64 [N,H]，每行平均亮度
    frame_times: np.ndarray  # float64 [N]，每帧名义起点 t0
    signature: str

    @property
    def n_frames(self) -> int:
        return self.frames.shape[0]


def row_timing(params: SimParams, mode: str, frame_index: int
               ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """计算一帧内每行的 (曝光窗起点, 曝光窗终点, 读出开始时刻)，长度均为 H。"""
    if mode not in MODES:
        raise ValueError(f"未知模式: {mode}")
    h = params.height
    t0 = frame_index / params.fps
    rows = np.arange(h, dtype=np.float64)
    frac = rows / (h - 1) if h > 1 else np.zeros(h)
    if params.readout_direction == DIRECTION_BOTTOM_UP:
        frac = frac[::-1]
    readout = t0 + frac * params.total_readout
    if mode == MODE_ROLLING:
        starts = readout - params.exposure
        ends = readout.copy()
    else:  # 全局快门：统一曝光，读出在曝光结束后排队进行（不影响成像）
        starts = np.full(h, t0)
        ends = np.full(h, t0 + params.exposure)
    return starts, ends, readout


def _pixel_coverage(cols: np.ndarray, obj: ObjectSpec,
                    a: float, b: float) -> np.ndarray:
    """像素列 cols 在曝光窗 [a,b] 内被物体覆盖的时间比例，解析解。"""
    if b <= a:  # 零时长曝光：按 a 时刻的瞬时位置计算
        x = obj.x0 + obj.velocity * a
        lo = np.maximum(x, cols)
        hi = np.minimum(x + obj.width, cols + 1.0)
        return np.clip(hi - lo, 0.0, 1.0)
    if abs(obj.velocity) < 1e-12:
        lo = np.maximum(obj.x0, cols)
        hi = np.minimum(obj.x0 + obj.width, cols + 1.0)
        return np.clip((hi - lo), 0.0, 1.0)
    # 物体左边缘 L(t)=x0+v*t；像素 c 被覆盖要求 L(t)<=c+1 且 L(t)+w>=c
    t_edge_right = (cols + 1.0 - obj.x0) / obj.velocity
    t_edge_left = (cols - obj.width - obj.x0) / obj.velocity
    lo_t = np.minimum(t_edge_left, t_edge_right)
    hi_t = np.maximum(t_edge_left, t_edge_right)
    lo_t = np.clip(lo_t, a, b)
    hi_t = np.clip(hi_t, a, b)
    return np.clip((hi_t - lo_t) / (b - a), 0.0, 1.0)


def _draw_ruler(frame: np.ndarray) -> None:
    """在画面上下边缘画固定标尺（每 10px 小刻度，每 50px 大刻度）。"""
    h, w, _ = frame.shape
    color = np.array([0.72, 0.72, 0.72], dtype=np.float32)
    for c in range(0, w, 10):
        length = 12 if c % 50 == 0 else 6
        frame[0:length, c] = color
        frame[h - length:h, c] = color


def render_clip(params: SimParams, mode: str) -> Clip:
    """按参数渲染整段短片。global 与 rolling 使用完全相同的场景与帧时间。"""
    if mode not in MODES:
        raise ValueError(f"未知模式: {mode}")
    errors, _ = params.validate()
    if errors:
        raise ValueError("参数无效: " + "; ".join(errors))

    n, h, w = params.n_frames, params.height, params.width
    frames = np.zeros((n, h, w, 3), dtype=np.float32)
    windows = np.zeros((n, h), dtype=np.float64)
    window_ends = np.zeros((n, h), dtype=np.float64)
    readouts = np.zeros((n, h), dtype=np.float64)
    flash_overlap = np.zeros((n, h), dtype=np.float64)
    cols = np.arange(w, dtype=np.float64)

    for fi in range(n):
        starts, ends, readout = row_timing(params, mode, fi)
        img = np.full((h, w, 3), params.ambient, dtype=np.float32)
        for r in range(h):
            a, b = float(starts[r]), float(ends[r])
            row = np.full((w, 3), params.ambient, dtype=np.float32)
            for obj in params.objects:
                if obj.y0 <= r < obj.y1:
                    cov = _pixel_coverage(cols, obj, a, b)
                    row += cov[:, None] * np.asarray(obj.color, np.float32)
            if params.flash_enabled:
                fs = params.flash_start
                fe = fs + params.flash_duration
                lit = max(0.0, min(b, fe) - max(a, fs))
                frac = lit / (b - a) if b > a else (1.0 if a < fe and fs < b else 0.0)
                flash_overlap[fi, r] = np.clip(frac, 0.0, 1.0)
                row += params.flash_intensity * flash_overlap[fi, r]
            img[r] = np.clip(row, 0.0, 1.0)
        _draw_ruler(img)
        frames[fi] = img
        windows[fi] = starts
        window_ends[fi] = ends
        readouts[fi] = readout

    row_means = frames.mean(axis=(2, 3))
    return Clip(
        params=params,
        mode=mode,
        frames=frames,
        windows=np.stack([windows, window_ends], axis=-1),
        readout_starts=readouts,
        flash_overlap=flash_overlap,
        row_means=row_means,
        frame_times=np.arange(n, dtype=np.float64) / params.fps,
        signature=params.signature(),
    )
