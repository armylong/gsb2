"""线性光合成与显示变换核心 (纯 numpy, 无 GUI 依赖)。

管线:
  原始通道 (float32, 可 >1)
    -> 乘倍率 (仍为无界 float32)
    -> 按独显开关过滤
    -> 线性求和 linear (无截断, 可 >1 或为负)
    -> 曝光 exposure (线性缩放, 仍无截断)
    -> 色调映射 tonemap (压到 [0,1], 这是唯一的压缩步骤)
    -> sRGB 编码 -> uint8 屏幕色
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .channels import CHANNEL_ORDER, ChannelSet

TONEMAP_MODES = ("clip", "reinhard", "aces")


@dataclass
class ParamState:
    """每路倍率与独显开关。倍率允许为 0 (压掉某盏灯)。"""

    multipliers: dict[str, float] = field(
        default_factory=lambda: {k: 1.0 for k in CHANNEL_ORDER})
    solo: dict[str, bool] = field(
        default_factory=lambda: {k: False for k in CHANNEL_ORDER})

    def active_channels(self) -> set[str]:
        """独显集合: 有任意一路独显时只保留被独显的路, 否则全部参与。"""
        soloed = {k for k, v in self.solo.items() if v}
        return soloed if soloed else set(CHANNEL_ORDER)


@dataclass
class DisplayParams:
    exposure_ev: float = 0.0
    tonemap: str = "reinhard"

    def normalized(self) -> "DisplayParams":
        mode = self.tonemap if self.tonemap in TONEMAP_MODES else "reinhard"
        return DisplayParams(float(self.exposure_ev), mode)


@dataclass
class CompositeResult:
    shape: tuple[int, int]                       # (H, W)
    contributions: dict[str, np.ndarray]         # 乘完倍率、过滤后的各路
    raw: dict[str, np.ndarray | None]            # 原始通道 (缺失为 None)
    included: dict[str, bool]                    # 该路是否参与本次合成
    available: dict[str, bool]
    linear: np.ndarray                           # 线性求和, 无截断
    exposed: np.ndarray                          # 曝光后, 仍无截断
    tonemapped: np.ndarray                       # [0,1] float32
    srgb8: np.ndarray                            # uint8 屏幕色
    missing: list[str]


def _exposure_scale(ev: float) -> float:
    return float(2.0 ** ev)


def apply_exposure(linear: np.ndarray, ev: float) -> np.ndarray:
    return linear * np.float32(_exposure_scale(ev))


def tonemap(x: np.ndarray, mode: str = "reinhard") -> np.ndarray:
    """把曝光后的线性值压到 [0,1]。仅在此处做范围压缩。"""
    x = np.asarray(x, dtype=np.float32)
    if mode == "clip":
        return np.clip(x, 0.0, 1.0)
    if mode == "reinhard":
        # 对称 Reinhard, 负值也能显示而不是被抹成 0
        return x / (1.0 + np.abs(x))
    if mode == "aces":
        # Stephen Hill 的 ACES filmic 拟合
        a, b, c, d, e = 2.51, 0.03, 2.43, 0.59, 0.14
        return np.clip((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0)
    raise ValueError(f"未知色调映射模式: {mode}")


def linear_to_srgb(x: np.ndarray) -> np.ndarray:
    """线性 [0,1] -> sRGB [0,1] float32。"""
    x = np.clip(np.asarray(x, dtype=np.float32), 0.0, 1.0)
    return np.where(x <= 0.0031308, x * 12.92,
                    1.055 * np.power(x, 1.0 / 2.4) - 0.055).astype(np.float32)


def encode_srgb8(tonemapped: np.ndarray) -> np.ndarray:
    """[0,1] 线性 -> sRGB uint8。"""
    s = linear_to_srgb(tonemapped)
    return np.clip(np.rint(s * 255.0), 0, 255).astype(np.uint8)


def display_image(linear: np.ndarray, display: DisplayParams) -> np.ndarray:
    """任意线性图走完整显示链, 返回 sRGB uint8 (逐路对照用同一函数)。"""
    d = display.normalized()
    exposed = apply_exposure(linear, d.exposure_ev)
    return encode_srgb8(tonemap(exposed, d.tonemap))


def compute_composite(
    channel_set: ChannelSet,
    params: ParamState,
    display: DisplayParams,
) -> CompositeResult:
    """按当前参数合成。缺失通道按 0 计并在 missing 中列出, 不做顶替。"""
    d = display.normalized()
    ref = channel_set.reference_shape
    if ref is None:
        raise ValueError("没有任何可用通道, 无法合成")
    h, w = ref
    active = params.active_channels()

    contributions: dict[str, np.ndarray] = {}
    raw: dict[str, np.ndarray | None] = {}
    included: dict[str, bool] = {}
    available: dict[str, bool] = {}
    missing: list[str] = []

    for name in CHANNEL_ORDER:
        ch = channel_set.get(name)
        ok = ch is not None and ch.available
        available[name] = ok
        if not ok:
            raw[name] = None
            missing.append(name)
            included[name] = False
            contributions[name] = np.zeros((h, w, 3), np.float32)
            continue
        raw[name] = ch.data
        if name in active:
            mult = np.float32(params.multipliers.get(name, 1.0))
            contributions[name] = (ch.data * mult).astype(np.float32)
            included[name] = True
        else:
            contributions[name] = np.zeros((h, w, 3), np.float32)
            included[name] = False

    # 线性求和: 全程 float32, 不 clamp
    linear = np.zeros((h, w, 3), np.float32)
    for name in CHANNEL_ORDER:
        linear += contributions[name]

    exposed = apply_exposure(linear, d.exposure_ev)
    mapped = tonemap(exposed, d.tonemap)
    srgb8 = encode_srgb8(mapped)

    return CompositeResult(
        shape=(h, w),
        contributions=contributions,
        raw=raw,
        included=included,
        available=available,
        linear=linear,
        exposed=exposed,
        tonemapped=mapped,
        srgb8=srgb8,
        missing=missing,
    )


@dataclass
class PixelReport:
    x: int
    y: int
    inside: bool
    # 每路: 原始值/乘倍率后值/单路屏幕色/是否参与/是否存在
    rows: dict[str, dict] = field(default_factory=dict)
    total_linear: np.ndarray | None = None     # 合成后、显示前
    total_exposed: np.ndarray | None = None
    total_tonemapped: np.ndarray | None = None
    total_screen8: np.ndarray | None = None


def probe_pixel(
    channel_set: ChannelSet,
    params: ParamState,
    display: DisplayParams,
    x: int,
    y: int,
) -> PixelReport:
    """光标探像素: 给出该像素各路对最终数值的贡献。

    底色为零、镜面高光 (>1) 都如实报告原值, 不做截断修饰。
    """
    d = display.normalized()
    ref = channel_set.reference_shape
    report = PixelReport(x=x, y=y, inside=False)
    if ref is None:
        return report
    h, w = ref
    if not (0 <= x < w and 0 <= y < h):
        return report
    report.inside = True
    active = params.active_channels()

    total = np.zeros(3, np.float32)
    for name in CHANNEL_ORDER:
        ch = channel_set.get(name)
        ok = ch is not None and ch.available
        if not ok:
            report.rows[name] = {
                "available": False, "included": False,
                "raw": None, "scaled": None, "screen8": None,
            }
            continue
        raw_v = ch.data[y, x].astype(np.float32).copy()
        mult = float(params.multipliers.get(name, 1.0))
        scaled = raw_v * np.float32(mult)
        on = name in active
        if on:
            total += scaled
        # 单路屏幕对照: 只对该路做完整显示变换
        screen = display_image(scaled.reshape(1, 1, 3), d)[0, 0]
        report.rows[name] = {
            "available": True,
            "included": on,
            "raw": raw_v,
            "multiplier": mult,
            "scaled": scaled,
            "screen8": screen,
        }

    exposed = apply_exposure(total.reshape(1, 1, 3), d.exposure_ev)[0, 0]
    mapped = tonemap(exposed.reshape(1, 1, 3), d.tonemap)[0, 0]
    screen = encode_srgb8(mapped.reshape(1, 1, 3))[0, 0]
    report.total_linear = total
    report.total_exposed = exposed
    report.total_tonemapped = mapped
    report.total_screen8 = screen
    return report
