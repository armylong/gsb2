"""项目数据模型与位置插值纯逻辑。

坐标约定
========
* 输出画布尺寸/帧率/时长完全继承背景视频, 原点在画布左上角, 单位像素。
* 关键帧存的是叠加层左上角在画布上的整数像素坐标 ``(x, y)``。
* 叠加层必须完整落在画布内, 即 ``0 <= x <= canvas_w - overlay_w``、
  ``0 <= y <= canvas_h - overlay_h``。
* 帧号 ``frame`` 为 0 基的背景实际帧序号, 帧时间 ``t = frame / fps``。

插值约定(预览与导出必须共用本模块, 保证逐帧一致)
==================================================
* 相邻关键帧之间按帧号线性匀速, 最近整数取整用 ``floor(v + 0.5)``
  (非负数即四舍五入), ffmpeg 表达式使用同一公式。
* 首点之前保持首点, 末点之后保持末点; 只有一个点时全程静止。
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from fractions import Fraction


@dataclass(frozen=True)
class Keyframe:
    """一个位置关键帧。"""

    frame: int
    x: int
    y: int

    def time(self, fps: Fraction) -> float:
        return self.frame / float(fps)


def round_half_up(value: float) -> int:
    """非负坐标的最近整数取整: floor(v + 0.5)。

    ffmpeg 导出表达式里写同一个公式, 保证预览/导出舍入完全一致。
    """

    return int(math.floor(value + 0.5))


class Project:
    """一次编辑会话的全部状态(不含 Qt 信号, 界面层自行刷新)。"""

    def __init__(
        self,
        canvas_w: int,
        canvas_h: int,
        fps: Fraction,
        frame_count: int,
        duration: float,
        overlay_w: int,
        overlay_h: int,
        overlay_frame_count: int,
    ) -> None:
        self.canvas_w = canvas_w
        self.canvas_h = canvas_h
        self.fps = fps
        self.frame_count = frame_count
        self.duration = duration
        # 叠加层在画布上的固定显示尺寸(保持原比例, 界面层负责算比例)。
        self.overlay_w = overlay_w
        self.overlay_h = overlay_h
        # 叠加层按背景帧率换算后的帧数; 超过该帧号叠加层消失。
        self.overlay_frame_count = overlay_frame_count
        # 按 frame 升序、同一帧只保留一个。
        self.keyframes: list[Keyframe] = []

    # ------------------------------------------------------------------ bounds
    @property
    def max_x(self) -> int:
        return self.canvas_w - self.overlay_w

    @property
    def max_y(self) -> int:
        return self.canvas_h - self.overlay_h

    def is_in_bounds(self, x: int, y: int) -> bool:
        return 0 <= x <= self.max_x and 0 <= y <= self.max_y

    def clamp_position(self, x: float, y: float) -> tuple[int, int]:
        """把任意坐标夹到合法整数范围(仅用于拖动过程, 不改写已有路径)。"""

        ix, iy = round_half_up(x), round_half_up(y)
        ix = max(0, min(self.max_x, ix))
        iy = max(0, min(self.max_y, iy))
        return ix, iy

    # -------------------------------------------------------------- keyframes
    def upsert_keyframe(self, frame: int, x: int, y: int) -> None:
        """在指定帧新建或覆盖关键帧, 保持列表按帧排序。"""

        if not (0 <= frame < self.frame_count):
            raise ValueError(f"帧号越界: {frame}")
        if not self.is_in_bounds(x, y):
            raise ValueError(f"坐标越界: ({x}, {y})")
        for i, kf in enumerate(self.keyframes):
            if kf.frame == frame:
                self.keyframes[i] = Keyframe(frame, int(x), int(y))
                self.keyframes.sort(key=lambda k: k.frame)
                return
            if kf.frame > frame:
                self.keyframes.insert(i, Keyframe(frame, int(x), int(y)))
                return
        self.keyframes.append(Keyframe(frame, int(x), int(y)))

    def delete_keyframe(self, frame: int) -> bool:
        """删除指定帧的关键帧; 至少要保留一个定位点。"""

        if len(self.keyframes) <= 1:
            return False
        before = len(self.keyframes)
        self.keyframes = [k for k in self.keyframes if k.frame != frame]
        return len(self.keyframes) < before

    def keyframe_at(self, frame: int) -> Keyframe | None:
        for kf in self.keyframes:
            if kf.frame == frame:
                return kf
        return None

    # ------------------------------------------------------------ interpolation
    def position_float(self, frame: int) -> tuple[float, float]:
        """按插值规则计算某帧的连续坐标(未取整)。"""

        if not self.keyframes:
            raise RuntimeError("没有任何关键帧")
        kfs = self.keyframes
        if frame <= kfs[0].frame:
            return float(kfs[0].x), float(kfs[0].y)
        if frame >= kfs[-1].frame:
            return float(kfs[-1].x), float(kfs[-1].y)
        for a, b in zip(kfs, kfs[1:]):
            if a.frame <= frame <= b.frame:
                if b.frame == a.frame:
                    return float(a.x), float(a.y)
                t = (frame - a.frame) / (b.frame - a.frame)
                return (
                    a.x + (b.x - a.x) * t,
                    a.y + (b.y - a.y) * t,
                )
        return float(kfs[-1].x), float(kfs[-1].y)

    def position_at(self, frame: int) -> tuple[int, int]:
        """预览/导出共用的逐帧整数像素坐标。"""

        fx, fy = self.position_float(frame)
        return round_half_up(fx), round_half_up(fy)

    def overlay_visible(self, frame: int) -> bool:
        """叠加层从输出零点开始; 短于背景时在其末帧之后消失。"""

        return 0 <= frame < self.overlay_frame_count

    # ----------------------------------------------------------- size changes
    def out_of_bounds_keyframes(
        self, new_overlay_w: int, new_overlay_h: int
    ) -> list[Keyframe]:
        """列出换成新固定尺寸后会越界的关键帧(不修改任何数据)。"""

        max_x = self.canvas_w - new_overlay_w
        max_y = self.canvas_h - new_overlay_h
        return [
            kf
            for kf in self.keyframes
            if not (0 <= kf.x <= max_x and 0 <= kf.y <= max_y)
        ]

    def apply_overlay_size(self, overlay_w: int, overlay_h: int) -> None:
        """确认无越界后才允许改尺寸; 越界时调用方必须先让用户修正。"""

        bad = self.out_of_bounds_keyframes(overlay_w, overlay_h)
        if bad:
            frames = ", ".join(str(k.frame) for k in bad)
            raise ValueError(f"以下帧的关键帧在新尺寸下越界, 请先修正: {frames}")
        self.overlay_w = overlay_w
        self.overlay_h = overlay_h


def build_ffmpeg_expr(keyframes: list[Keyframe], axis: str,
                      fps: Fraction) -> str:
    """生成与 :meth:`Project.position_float` 等价的 ffmpeg 表达式。

    两个 ffmpeg 实测行为(均在 overlay 滤镜上验证):
    1. overlay 自带的 ``n`` 以主帧率两倍节奏计数(0,2,2,4...),
       与输出帧号不对应; 改用滤镜时间戳 ``floor(t*FPS+0.5)``
       还原整数帧号(时间戳有量化误差, 四舍五入)。
    2. overlay 默认 yuv420 色度子采样会把坐标量化到偶数并丢失小数,
       必须在导出滤镜里指定 ``format=rgb``(见 exporter), 之后表达式的
       浮点除法即正常。这里前置 ``1.0*`` 让段内系数显式按浮点运算。

    Python 端按帧号线性插值再 ``floor(v+0.5)``, 这里数学上同一公式。
    结构为嵌套 ``if(lt(N,f1), 段内线性, 其余递归)``; 单点直接返回常量。
    ``axis`` 取 ``"x"`` 或 ``"y"``。
    """

    if axis not in ("x", "y"):
        raise ValueError(axis)
    if not keyframes:
        raise ValueError("没有关键帧")

    fps_num = float(fps)
    frame_n = f"floor(t*{fps_num:g}+0.5)"

    def build(ks: list[Keyframe]) -> str:
        k0 = ks[0]
        if len(ks) == 1:
            return str(getattr(k0, axis))
        k1 = ks[1]
        v0, v1 = getattr(k0, axis), getattr(k1, axis)
        span = k1.frame - k0.frame
        linear = (
            f"floor({v0}+1.0*({v1}-{v0})*({frame_n}-{k0.frame})/{span}+0.5)"
        )
        return f"if(lt({frame_n},{k1.frame}),{linear},{build(ks[1:])})"

    return build(sorted(keyframes, key=lambda k: k.frame))
