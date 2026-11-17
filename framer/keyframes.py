"""关键点插值与 ffmpeg crop 表达式生成。

关键点格式：{"t": 秒, "x": 裁切框左边缘在显示画面中的像素坐标}
- 取景框固定为满高 9:16，只做水平平移
- 相邻关键点之间做分段插值（linear / smoothstep），关键点之外保持端点值
- x 始终被夹在 [0, 显示宽 - 裁切宽] 内，保证不出画面
"""
from __future__ import annotations

import math
from typing import Literal

Easing = Literal["linear", "smoothstep"]


class KeyframeError(ValueError):
    """关键点数据非法。"""


def crop_size(display_width: int, display_height: int) -> tuple[int, int]:
    """满高 9:16 裁切尺寸；宽高向下取偶数以兼容 yuv420p。"""
    h = display_height - (display_height % 2)
    w = (h * 9 // 16) & ~1
    if w < 4 or w > display_width:
        raise KeyframeError(
            f"显示尺寸 {display_width}x{display_height} 无法得到有效的 9:16 取景框"
        )
    return w, h


def max_x(display_width: int, crop_w: int) -> int:
    return display_width - crop_w


def clamp_x(x: float, display_width: int, crop_w: int) -> int:
    upper = max_x(display_width, crop_w)
    if x < 0:
        return 0
    if x > upper:
        return upper
    # 与 JS 端一致的半值向上舍入（避免 Python 银行家舍入产生分歧）
    return int(math.floor(x + 0.5))


def default_keyframes(display_width: int, crop_w: int) -> list[dict]:
    """默认：t=0 处一个居中关键点。"""
    return [{"t": 0.0, "x": clamp_x((display_width - crop_w) / 2, display_width, crop_w)}]


def normalize_keyframes(
    keyframes: list[dict], duration: float, display_width: int, crop_w: int
) -> list[dict]:
    """校验、排序并夹紧关键点；非法时抛 KeyframeError（调用方保留原设置）。"""
    if not isinstance(keyframes, list) or not keyframes:
        raise KeyframeError("至少需要一个关键点")
    cleaned = []
    for kf in keyframes:
        if not isinstance(kf, dict) or "t" not in kf or "x" not in kf:
            raise KeyframeError(f"关键点格式错误：{kf!r}")
        t = float(kf["t"])
        x = float(kf["x"])
        if t != t or x != x:  # NaN
            raise KeyframeError("关键点不能为 NaN")
        if t < 0 or t > duration + 1e-6:
            raise KeyframeError(f"关键点时间 {t:.3f}s 超出视频范围 0~{duration:.3f}s")
        cleaned.append({"t": round(t, 3),
                        "x": clamp_x(x, display_width, crop_w)})
    cleaned.sort(key=lambda k: k["t"])
    prev = None
    for kf in cleaned:
        if prev is not None and abs(kf["t"] - prev) < 1e-6:
            raise KeyframeError(f"存在重复时间点 t={kf['t']}s")
        prev = kf["t"]
    return cleaned


def _ease(u: float, easing: Easing) -> float:
    if easing == "linear":
        return u
    # smoothstep：端点处速度为 0，关键点之间无跳变
    return u * u * (3.0 - 2.0 * u)


def interpolate(
    keyframes: list[dict], t: float,
    display_width: int, crop_w: int, easing: Easing = "smoothstep",
) -> int:
    """求 t 时刻的裁切左边缘 x（像素，已夹紧）。"""
    upper = max_x(display_width, crop_w)
    if t <= keyframes[0]["t"]:
        return int(min(max(keyframes[0]["x"], 0), upper))
    if t >= keyframes[-1]["t"]:
        return int(min(max(keyframes[-1]["x"], 0), upper))
    for i in range(len(keyframes) - 1):
        t1, x1 = keyframes[i]["t"], keyframes[i]["x"]
        t2, x2 = keyframes[i + 1]["t"], keyframes[i + 1]["x"]
        if t1 <= t <= t2:
            dt = t2 - t1
            u = 0.0 if dt == 0 else min(max((t - t1) / dt, 0.0), 1.0)
            x = x1 + (x2 - x1) * _ease(u, easing)
            x = min(max(x, 0), upper)
            return int(math.floor(x + 0.5))
    return keyframes[-1]["x"]  # pragma: no cover


def _ffesc(expr: str) -> str:
    """转义过滤器内表达式的逗号/冒号，避免被当成过滤器分隔符。"""
    return expr.replace("\\", "\\\\").replace(":", "\\:").replace(",", "\\,")


def _segment_expr(t1: float, x1: float, t2: float, x2: float,
                  easing: Easing) -> str:
    dt = t2 - t1
    if dt <= 0:
        return f"{x1:.3f}"
    if easing == "linear":
        return f"({x1:.3f}+({x2 - x1:.3f})*((t-{t1:.3f})/{dt:.6f}))"
    u = f"clip((t-{t1:.3f})/{dt:.6f}\\,0\\,1)"
    s = f"({u})*({u})*(3-2*({u}))"
    return f"({x1:.3f}+({x2 - x1:.3f})*{s})"


def build_x_expression(
    keyframes: list[dict], display_width: int, crop_w: int,
    easing: Easing = "smoothstep",
) -> str:
    """生成 ffmpeg crop 过滤器可用的 x 表达式（变量为时间 t）。"""
    upper = max_x(display_width, crop_w)
    if len(keyframes) == 1:
        inner = f"{keyframes[0]['x']:.3f}"
    else:
        # 从后向前嵌套 if(lt(t,t2), 本段, 其余)
        inner = f"{keyframes[-1]['x']:.3f}"
        for i in range(len(keyframes) - 2, 0, -1):
            seg = _segment_expr(
                keyframes[i]["t"], keyframes[i]["x"],
                keyframes[i + 1]["t"], keyframes[i + 1]["x"], easing,
            )
            inner = f"if(lt(t\\,{keyframes[i + 1]['t']:.3f})\\,{seg}\\,{inner})"
        first_seg = _segment_expr(
            keyframes[0]["t"], keyframes[0]["x"],
            keyframes[1]["t"], keyframes[1]["x"], easing,
        )
        inner = f"if(lt(t\\,{keyframes[1]['t']:.3f})\\,{first_seg}\\,{inner})"
        # 首关键点之前保持首值
        inner = f"if(lt(t\\,{keyframes[0]['t']:.3f})\\,{keyframes[0]['x']:.3f}\\,{inner})"
    return f"clip({inner}\\,0\\,{upper})"
