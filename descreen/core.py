"""本地去斜网纹工具：频域分析 + 陷波滤波。

只依赖 numpy / scipy，不依赖任何 GUI 框架，方便单独测试。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, asdict

import numpy as np
from scipy import ndimage

# ---------------------------------------------------------------------------
# 数据模型
# ---------------------------------------------------------------------------


@dataclass
class Notch:
    """一个陷波选区。频率坐标单位为 cycles/pixel（归一化空间频率）。

    kind="point"   : 圆形陷波，ru=rv 为半径
    kind="ellipse" : 椭圆陷波，ru/rv 为两根半轴，angle 为长轴方向（弧度）
    """

    u: float
    v: float
    ru: float
    rv: float
    kind: str = "point"
    angle: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_dict(d: dict) -> "Notch":
        return Notch(**d)


@dataclass
class NotchGroup:
    """一组可整体开关的陷波选区。"""

    name: str
    notches: list[Notch] = field(default_factory=list)
    enabled: bool = True

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "enabled": self.enabled,
            "notches": [n.to_dict() for n in self.notches],
        }

    @staticmethod
    def from_dict(d: dict) -> "NotchGroup":
        return NotchGroup(
            name=d["name"],
            enabled=d.get("enabled", True),
            notches=[Notch.from_dict(n) for n in d.get("notches", [])],
        )


@dataclass
class Peak:
    """频谱上检测到的候选周期分量。"""

    u: float
    v: float
    power: float
    paired: bool = False          # 是否找到了共轭配对 (-u,-v)
    period_px: float = 0.0        # 对应条纹间距（像素）
    angle_deg: float = 0.0        # 对应条纹方向（度，0=水平）

    @property
    def freq(self) -> float:
        return math.hypot(self.u, self.v)


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------

def to_gray(image: np.ndarray) -> np.ndarray:
    """转 float64 灰度，输入可以是 H×W 或 H×W×3。"""
    if image.ndim == 2:
        return image.astype(np.float64)
    if image.ndim == 3 and image.shape[2] >= 3:
        rgb = image[..., :3].astype(np.float64)
        # ITU-R BT.601，扫描杂志图用这个权重足够稳
        return 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
    raise ValueError(f"不支持的图像维度: {image.shape}")


def as_float01(image: np.ndarray) -> np.ndarray:
    img = image.astype(np.float64)
    if img.max() > 1.5 or image.dtype == np.uint8:
        img /= 255.0
    return np.clip(img, 0.0, 1.0)


def to_uint8(image: np.ndarray) -> np.ndarray:
    img = as_float01(image)
    return np.round(img * 255.0).astype(np.uint8)


def _hann2d(h: int, w: int) -> np.ndarray:
    wy = np.hanning(h)
    wx = np.hanning(w)
    return np.outer(wy, wx)


def fft_centered(gray: np.ndarray, window: bool = True) -> np.ndarray:
    """二维 FFT，零频移到中心。分析时加 Hann 窗减少边缘泄漏。"""
    g = gray.astype(np.float64)
    if window:
        g = g * _hann2d(g.shape[0], g.shape[1])
    return np.fft.fftshift(np.fft.fft2(g))


def freq_grid(h: int, w: int) -> tuple[np.ndarray, np.ndarray]:
    """与 fftshift 后频谱对齐的频率网格，单位 cycles/pixel。"""
    vu = np.fft.fftshift(np.fft.fftfreq(w))
    vv = np.fft.fftshift(np.fft.fftfreq(h))
    return np.meshgrid(vu, vv)


# ---------------------------------------------------------------------------
# 频谱分析
# ---------------------------------------------------------------------------

@dataclass
class Spectrum:
    display: np.ndarray          # 0..1 的对数幅度谱，可直接显示
    magnitude: np.ndarray        # 原始幅度谱（与 display 同尺寸）
    fshift: np.ndarray          # 复数频谱
    u: np.ndarray                # 频率网格 u
    v: np.ndarray
    h: int
    w: int

    def to_pixel(self, u: float, v: float) -> tuple[float, float]:
        """cycles/pixel -> 频谱图像素坐标 (x, y)。"""
        x = (u + 0.5) * self.w
        y = (v + 0.5) * self.h
        return x, y

    def to_freq(self, x: float, y: float) -> tuple[float, float]:
        """频谱图像素坐标 -> cycles/pixel。"""
        return x / self.w - 0.5, y / self.h - 0.5


def compute_spectrum(region: np.ndarray, max_side: int = 1024) -> Spectrum:
    """对框选区域计算二维频谱。

    区域过大会先按整数步长缩小（避免在 UI 线程做超大 FFT）。
    cycles/pixel 与采样率无关，因此降采样后的频率坐标仍对应原图，
    不需要额外换算；代价是最高可分析频率随步长降低。
    """
    gray = to_gray(region)
    h, w = gray.shape
    step = max(1, int(math.ceil(max(h, w) / max_side)))
    if step > 1:
        gray = gray[::step, ::step]
        h, w = gray.shape

    fshift = fft_centered(gray, window=True)
    magnitude = np.abs(fshift)
    # 显示用：轻微平滑压下宽带扫描噪声的颗粒感，gamma 进一步突出周期峰。
    # 注意峰值检测仍在未平滑的 magnitude 上进行，不受显示处理影响。
    smooth = ndimage.gaussian_filter(magnitude, sigma=1.2)
    log_mag = np.log1p(smooth)
    lo, hi = np.percentile(log_mag, (5, 99.5))
    if hi - lo < 1e-9:
        display = np.zeros_like(log_mag)
    else:
        normalized = np.clip((log_mag - lo) / (hi - lo), 0.0, 1.0)
        display = normalized ** 3.0

    u, v = freq_grid(h, w)
    # 降采样过的频谱，频率坐标本身已经对应原图（fftfreq 用的是降采样后索引，
    # 但 cycles/pixel 的定义天然与采样率无关），无需额外换算。
    return Spectrum(display=display, magnitude=magnitude, fshift=fshift,
                    u=u, v=v, h=h, w=w)


def find_peaks(spec: Spectrum,
               relative_threshold: float = 0.02,
               min_dist_bins: int | None = None,
               max_peaks: int = 24) -> list[Peak]:
    """在频谱上找显著的非直流峰，并自动标注共轭对。

    relative_threshold: 峰值幅度至少为直流分量的该比例。
    """
    mag = spec.magnitude
    h, w = mag.shape
    cy, cx = h // 2, w // 2
    if min_dist_bins is None:
        min_dist_bins = max(3, min(h, w) // 80)

    dc = mag[cy, cx]
    threshold = max(dc * relative_threshold, np.median(mag) * 5.0)

    # 直流附近排除（低频亮度不是网纹）
    dc_guard = max(4, min(h, w) // 50)
    yy, xx = np.mgrid[0:h, 0:w]
    outside_dc = (yy - cy) ** 2 + (xx - cx) ** 2 > dc_guard ** 2

    size = min_dist_bins * 2 + 1
    local_max = ndimage.maximum_filter(mag, size=size)
    candidates = (mag == local_max) & (mag > threshold) & outside_dc

    coords = np.argwhere(candidates)
    if coords.size == 0:
        return []

    powers = mag[coords[:, 0], coords[:, 1]]
    order = np.argsort(-powers)

    # 贪心保证峰间距
    picked: list[tuple[int, int, float]] = []
    for idx in order:
        y, x = coords[idx]
        p = float(powers[idx])
        if all((y - py) ** 2 + (x - px) ** 2 >= min_dist_bins ** 2
               for py, px, _ in picked):
            picked.append((int(y), int(x), p))
        if len(picked) >= max_peaks:
            break

    peaks: list[Peak] = []
    for y, x, p in picked:
        u, v = spec.to_freq(float(x), float(y))
        f = math.hypot(u, v)
        period = 1.0 / f if f > 1e-12 else 0.0
        # 频率 (u,v) 对应条纹方向与频率矢量垂直
        angle = math.degrees(math.atan2(-u, v))
        peaks.append(Peak(u=u, v=v, power=p, period_px=period,
                          angle_deg=angle))

    # 标注共轭对：真实周期信号一定成对出现在 (u,v) 与 (-u,-v)
    for i, pk in enumerate(peaks):
        if pk.paired:
            continue
        best_j, best_d = -1, (1.5 * min_dist_bins) ** 2
        for j, other in enumerate(peaks):
            if j == i or other.paired:
                continue
            # 频率距离换算成 bin 距离（u、v 方向分别换算）
            d_bin = ((other.u + pk.u) * spec.w) ** 2 + \
                    ((other.v + pk.v) * spec.h) ** 2
            if d_bin < best_d:
                best_d, best_j = d_bin, j
        if best_j >= 0:
            pk.paired = True
            peaks[best_j].paired = True

    return peaks


def notch_from_pixels(x: float, y: float, spec: Spectrum,
                      radius_bins: float) -> Notch:
    """频谱图上点选 -> Notch（坐标存 cycles/pixel，换区域后仍可用）。

    两个半轴分别按 1/w、1/h 换算，保证在非方形频谱上显示仍是正圆。
    """
    u, v = spec.to_freq(x, y)
    rb = max(radius_bins, 1.5)
    return Notch(u=u, v=v, ru=rb / spec.w, rv=rb / spec.h, kind="point")


def ellipse_from_pixel_rect(x0: float, y0: float, x1: float, y1: float,
                            spec: Spectrum) -> Notch:
    """频谱图上框出的矩形 -> 椭圆陷波。"""
    u0, v0 = spec.to_freq(min(x0, x1), min(y0, y1))
    u1, v1 = spec.to_freq(max(x0, x1), max(y0, y1))
    ru = max(abs(u1 - u0) / 2.0, 1.5 / spec.w)
    rv = max(abs(v1 - v0) / 2.0, 1.5 / spec.h)
    return Notch(u=(u0 + u1) / 2.0, v=(v0 + v1) / 2.0,
                 ru=ru, rv=rv, kind="ellipse", angle=0.0)


# ---------------------------------------------------------------------------
# 陷波掩膜与滤波
# ---------------------------------------------------------------------------

def _notch_suppression(U: np.ndarray, V: np.ndarray, n: Notch,
                       feather: float) -> np.ndarray:
    """单个陷波的抑制强度图：1=完全压掉，0=不动。"""
    du = U - n.u
    dv = V - n.v
    if n.kind == "ellipse" and abs(n.angle) > 1e-9:
        c, s = math.cos(-n.angle), math.sin(-n.angle)
        dx = du * c - dv * s
        dy = du * s + dv * c
    else:
        dx, dy = du, dv

    rx = max(n.ru, 1e-6)
    ry = max(n.rv, rx if n.kind == "point" else 1e-6)
    d = np.sqrt((dx / rx) ** 2 + (dy / ry) ** 2)

    r_eff = math.sqrt(rx * ry)
    f = max(feather, 1e-6)
    # 选区内部全抑制，选区外按高斯过渡 —— 边缘不会变成硬切条纹
    sup = np.where(
        d <= 1.0,
        1.0,
        np.exp(-0.5 * (((d - 1.0) * r_eff) / f) ** 2),
    )
    return sup


def build_mask(h: int, w: int, groups: list[NotchGroup],
               feather_cpp: float) -> np.ndarray:
    """根据启用的陷波组构造 0..1 平滑掩膜（1=保留）。"""
    U, V = freq_grid(h, w)
    suppression = np.zeros((h, w), dtype=np.float64)

    for grp in groups:
        if not grp.enabled:
            continue
        for n in grp.notches:
            # 真实信号的频谱共轭对称：(u,v) 和 (-u,-v) 必须一起压，
            # 否则逆变换会留下复数残差对应的伪影
            suppression = np.maximum(
                suppression, _notch_suppression(U, V, n, feather_cpp))
            n_conj = Notch(u=-n.u, v=-n.v, ru=n.ru, rv=n.rv,
                           kind=n.kind, angle=-n.angle)
            suppression = np.maximum(
                suppression, _notch_suppression(U, V, n_conj, feather_cpp))

    # 直流保护：再靠近 0 频的选区也不能抹掉整体亮度
    guard = 2.0 / min(h, w)
    r = np.sqrt(U ** 2 + V ** 2)
    suppression *= np.clip(r / guard, 0.0, 1.0)

    return 1.0 - suppression


def _descreen_channel(ch: np.ndarray, groups: list[NotchGroup],
                      feather_cpp: float, pad: int) -> np.ndarray:
    """单通道陷波滤波。

    先做反射填充再 FFT，避免图像四边的周期不连续经循环卷积
    折回画面内部形成边缘条纹；最后把填充部分裁掉。
    """
    if pad > 0:
        padded = np.pad(ch, ((pad, pad), (pad, pad)), mode="reflect")
    else:
        padded = ch
    mask = build_mask(padded.shape[0], padded.shape[1], groups, feather_cpp)
    spec = np.fft.fftshift(np.fft.fft2(padded))
    filtered = np.real(np.fft.ifft2(np.fft.ifftshift(spec * mask)))
    if pad > 0:
        filtered = filtered[pad:pad + ch.shape[0], pad:pad + ch.shape[1]]
    return filtered


def descreen(image: np.ndarray, groups: list[NotchGroup],
             feather_cpp: float = 0.004) -> np.ndarray:
    """对整图做陷波滤波，返回与原图同形状的 uint8。

    每次都从原图重新计算，绝不基于上一次结果迭代；
    没有任何启用选区时原样返回。
    """
    has_work = any(g.enabled and g.notches for g in groups)
    if not has_work:
        return image.copy()

    src = as_float01(image)
    h, w = src.shape[:2]
    # 填充量取较短边的 8%，限制在 16..128px；极小图再按 1/4 收紧
    pad = int(np.clip(round(min(h, w) * 0.08), 16, 128))
    pad = min(pad, min(h, w) // 4)

    if src.ndim == 2:
        channels = [src]
    else:
        channels = [src[..., c] for c in range(src.shape[2])]

    out = [_descreen_channel(ch, groups, feather_cpp, pad) for ch in channels]

    if src.ndim == 2:
        result = out[0]
    else:
        result = np.stack(out, axis=-1)

    return to_uint8(result)


def signed_diff(original: np.ndarray, processed: np.ndarray,
                gain: float = 4.0) -> np.ndarray:
    """带符号差图：中灰=无差异，偏亮=被压暗，偏暗=被提亮。"""
    a = as_float01(original)
    b = as_float01(processed)
    if a.ndim == 3:
        a, b = to_gray(a), to_gray(b)
    d = np.clip(0.5 + (a - b) * gain, 0.0, 1.0)
    return np.round(d * 255.0).astype(np.uint8)
