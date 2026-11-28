"""可重复生成的示例纹理, 用于本地验证测量与导出。

所有示例都由固定种子生成, 同一参数每次得到逐像素相同的图。每个示例同时给出
"真值" 基矢 (``truth_t1`` / ``truth_t2``) 与建议的分析区域, 便于自动测试核验
估计结果和平铺位置。

纹理都是"平拍"式: 无透视、无旋转, 同一平面上的像素。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Sequence, Tuple

import numpy as np

from .geometry import CellBasis, Vec


# ---------------------------------------------------------------------------
# 基础绘制
# ---------------------------------------------------------------------------

def _smoothstep(edge0, edge1, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - edge0) / np.maximum(np.asarray(edge1) - np.asarray(edge0), 1e-9),
                0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _fabric_base(h: int, w: int, rng: np.random.Generator,
                 color: Sequence[float] = (0.82, 0.69, 0.53)) -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    weave = (0.030 * np.sin(2 * np.pi * (xx / 4.3 + yy / 5.7))
             + 0.022 * np.sin(2 * np.pi * (xx / 7.1 - yy / 3.9))
             + 0.016 * np.sin(2 * np.pi * (xx / 11.3)))
    # 轻微的光照渐变与暗角, 不破坏局部周期
    light = (1.0
             + 0.045 * (xx / max(w - 1, 1) - 0.5)
             - 0.035 * (yy / max(h - 1, 1) - 0.5))
    vign = 1.0 - 0.06 * (((xx - w / 2) / (w / 2)) ** 2
                         + ((yy - h / 2) / (h / 2)) ** 2) / 2.0
    base = np.array(color, dtype=np.float64)[None, None, :] * light[..., None]
    base = base * (1.0 + weave[..., None]) * vign[..., None]
    base += rng.normal(0.0, 0.006, size=base.shape)
    return base


def _draw_motif(img: np.ndarray, cx: float, cy: float, radius: float,
                main: np.ndarray, accent: np.ndarray, ring: np.ndarray,
                petals: int = 6, phase: float = 0.0) -> None:
    """在浮点 RGB 图上画一个花瓣纹样 (就地混合)。"""
    h, w = img.shape[:2]
    reach = radius * 1.55 + 3.0
    x0 = max(0, int(np.floor(cx - reach)))
    x1 = min(w, int(np.ceil(cx + reach)) + 1)
    y0 = max(0, int(np.floor(cy - reach)))
    y1 = min(h, int(np.ceil(cy + reach)) + 1)
    if x0 >= x1 or y0 >= y1:
        return
    yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float64)
    dx = xx - cx
    dy = yy - cy
    r = np.hypot(dx, dy)
    ang = np.arctan2(dy, dx)

    petal = (0.5 + 0.5 * np.cos(petals * ang + phase)) ** 0.8
    petal_r = radius * (0.52 + 0.48 * petal)
    a_petal = 1.0 - _smoothstep(petal_r - 1.1, petal_r + 0.6, r)
    a_center = 1.0 - _smoothstep(radius * 0.30 - 1.0, radius * 0.30 + 0.5, r)
    a_ring = (1.0 - _smoothstep(radius * 0.80 - 0.8, radius * 0.80 + 0.8, r)) \
        - (1.0 - _smoothstep(radius * 0.68 - 0.8, radius * 0.68 + 0.8, r))

    patch = img[y0:y1, x0:x1]
    alpha = np.clip(a_petal * 0.92, 0.0, 1.0)
    patch[:] = patch * (1 - alpha[..., None]) + main[None, None, :] * alpha[..., None]
    alpha = np.clip(a_center * 0.95, 0.0, 1.0)
    patch[:] = patch * (1 - alpha[..., None]) + accent[None, None, :] * alpha[..., None]
    alpha = np.clip(a_ring * 0.85, 0.0, 1.0)
    patch[:] = patch * (1 - alpha[..., None]) + ring[None, None, :] * alpha[..., None]


def _color_variant(base: Sequence[float], rng: np.random.Generator,
                   amount: float = 0.02) -> np.ndarray:
    c = np.array(base, dtype=np.float64)
    c = c * (1.0 + rng.uniform(-amount, amount))
    c = c + rng.uniform(-amount * 0.5, amount * 0.5, size=3)
    return np.clip(c, 0.0, 1.0)


def _draw_lattice_motifs(img: np.ndarray, t1: Vec, t2: Vec,
                         draw_origin: Vec, radius: float,
                         color_main: Sequence[float],
                         color_accent: Sequence[float],
                         color_ring: Sequence[float],
                         seed: int, wear: float = 0.0,
                         missing: Optional[Sequence[Tuple[int, int]]] = None,
                         jitter_px: float = 0.0,
                         scale_jitter: float = 0.0) -> None:
    h, w = img.shape[:2]
    missing = set(missing or [])
    # 覆盖整幅图所需的格点范围
    corners = np.array([[0, 0], [w, 0], [0, h], [w, h]], dtype=float)
    M = np.array([[t1[0], t2[0]], [t1[1], t2[1]]], dtype=float)
    Minv = np.linalg.inv(M)
    ij = (corners - np.array(draw_origin)) @ Minv.T
    i_lo = int(np.floor(ij[:, 0].min())) - 1
    i_hi = int(np.ceil(ij[:, 0].max())) + 1
    j_lo = int(np.floor(ij[:, 1].min())) - 1
    j_hi = int(np.ceil(ij[:, 1].max())) + 1

    for i in range(i_lo, i_hi + 1):
        for j in range(j_lo, j_hi + 1):
            if (i, j) in missing:
                continue
            crng = np.random.default_rng(
                (seed * 1000003 + (i + 5000) * 7919 + (j + 5000) * 104729) & 0xFFFFFFFF
            )
            cx = draw_origin[0] + i * t1[0] + j * t2[0]
            cy = draw_origin[1] + i * t1[1] + j * t2[1]
            if jitter_px:
                cx += float(crng.uniform(-jitter_px, jitter_px))
                cy += float(crng.uniform(-jitter_px, jitter_px))
            rad = radius * (1.0 + float(crng.uniform(-scale_jitter, scale_jitter)))
            main = _color_variant(color_main, crng, wear)
            accent = _color_variant(color_accent, crng, wear)
            ring = _color_variant(color_ring, crng, wear)
            _draw_motif(img, cx, cy, rad, main, accent, ring,
                        petals=6, phase=float(crng.uniform(-0.25, 0.25)))


def _finish(img: np.ndarray, rng: np.random.Generator, noise: float,
            blur_sigma: float) -> np.ndarray:
    out = img + rng.normal(0.0, noise, size=img.shape)
    out = np.clip(out, 0.0, 1.0)
    if blur_sigma > 0:
        from PIL import Image, ImageFilter
        arr = (out * 255.0 + 0.5).astype(np.uint8)
        arr = np.asarray(
            Image.fromarray(arr).filter(ImageFilter.GaussianBlur(blur_sigma))
        ).astype(np.float64) / 255.0
        out = arr
    return out.astype(np.float32)


# ---------------------------------------------------------------------------
# 示例定义
# ---------------------------------------------------------------------------

@dataclass
class Example:
    key: str
    title: str
    image: np.ndarray            # HxWx3 float32, 0..1
    region: Tuple[int, int, int, int]   # x, y, w, h
    truth_t1: Vec
    truth_t2: Vec
    truth_origin: Vec
    description: str = ""
    tags: List[str] = field(default_factory=list)

    @property
    def suggested_basis(self) -> CellBasis:
        return CellBasis(self.truth_origin, self.truth_t1, self.truth_t2)

    @property
    def size(self) -> Tuple[int, int]:
        return int(self.image.shape[1]), int(self.image.shape[0])


def _square_flower(size: int = 512, seed: int = 20240101) -> Example:
    h = w = size
    t1, t2 = (64.0, 0.0), (0.0, 64.0)
    draw_origin = (32.0, 32.0)
    rng = np.random.default_rng(seed)
    img = _fabric_base(h, w, rng, color=(0.80, 0.68, 0.52))
    _draw_lattice_motifs(
        img, t1, t2, draw_origin, radius=19.0,
        color_main=(0.58, 0.26, 0.22), color_accent=(0.93, 0.78, 0.42),
        color_ring=(0.24, 0.36, 0.46), seed=seed + 1, wear=0.012,
    )
    img = _finish(img, rng, noise=0.012, blur_sigma=0.5)
    return Example(
        key="square", title="方形重复 (64 x 64 像素)",
        image=img, region=(48, 48, 416, 416),
        truth_t1=t1, truth_t2=t2, truth_origin=(0.0, 0.0),
        description="方形格点, 每个单元一枚花瓣纹样; 半步落在空白处, 应提示整步可信。",
        tags=["builtin"],
    )


def _diagonal_flower(size: int = 512, seed: int = 20240202) -> Example:
    h = w = size
    t1, t2 = (52.0, 52.0), (-52.0, 52.0)
    draw_origin = (w / 2, h / 2)
    rng = np.random.default_rng(seed)
    img = _fabric_base(h, w, rng, color=(0.70, 0.74, 0.62))
    _draw_lattice_motifs(
        img, t1, t2, draw_origin, radius=17.0,
        color_main=(0.20, 0.38, 0.50), color_accent=(0.86, 0.62, 0.38),
        color_ring=(0.32, 0.24, 0.38), seed=seed + 1, wear=0.012,
    )
    img = _finish(img, rng, noise=0.012, blur_sigma=0.5)
    return Example(
        key="diagonal", title="斜排重复 (45° 斜向格点)",
        image=img, region=(64, 64, 384, 384),
        truth_t1=t1, truth_t2=t2, truth_origin=(26.0, 0.0),
        description="两列纹样沿 45° 斜向排布, 两个重复方向都不是水平的。",
        tags=["builtin"],
    )


def _stagger_flower(size: int = 536, seed: int = 20240303) -> Example:
    h = w = size
    t1, t2 = (96.0, 0.0), (48.0, 40.0)
    draw_origin = (48.0, 40.0)
    rng = np.random.default_rng(seed)
    img = _fabric_base(h, w, rng, color=(0.76, 0.62, 0.66))
    _draw_lattice_motifs(
        img, t1, t2, draw_origin, radius=16.0,
        color_main=(0.46, 0.20, 0.34), color_accent=(0.88, 0.72, 0.46),
        color_ring=(0.22, 0.30, 0.32), seed=seed + 1, wear=0.012,
    )
    # 砖排的空隙处每格放一枚小圆点 (每个单元都要有, 否则点阵不成立);
    # 圆点在单元里的位置固定, 于是"隔行错开"一眼可见。
    corners = np.array([[0, 0], [w, 0], [0, h], [w, h]], dtype=float)
    M = np.array([[t1[0], t2[0]], [t1[1], t2[1]]], dtype=float)
    ij = (corners - np.array(draw_origin)) @ np.linalg.inv(M).T
    for i in range(int(np.floor(ij[:, 0].min())) - 1,
                   int(np.ceil(ij[:, 0].max())) + 2):
        for j in range(int(np.floor(ij[:, 1].min())) - 1,
                       int(np.ceil(ij[:, 1].max())) + 2):
            cx = draw_origin[0] + i * t1[0] + j * t2[0] + 48.0
            cy = draw_origin[1] + i * t1[1] + j * t2[1] + 20.0
            _draw_motif(img, cx, cy, 5.5,
                        np.array([0.30, 0.30, 0.34]),
                        np.array([0.96, 0.88, 0.72]),
                        np.array([0.30, 0.30, 0.34]), petals=4,
                        phase=0.0)
    img = _finish(img, rng, noise=0.012, blur_sigma=0.5)
    return Example(
        key="stagger", title="隔行错开 (砖排, 半格错位)",
        image=img, region=(56, 56, 424, 424),
        truth_t1=t1, truth_t2=t2, truth_origin=(0.0, 0.0),
        description="每一行相对上一行错开半步; 只看行内会误以为周期是 48, 实际是 96。",
        tags=["builtin"],
    )


def _diagonal_stripes(size: int = 512, seed: int = 20240404,
                      period: float = 28.0,
                      along: float = 16.0,
                      color_shift: float = 0.010,
                      dash: float = 0.03,
                      phase: float = 0.37) -> Example:
    """45° 斜条纹, 沿条纹方向还有一道针脚。

    ``period`` 是 (x+y) 方向的条纹周期。相邻两条颜色几乎一样、条纹上还有
    以 ``period`` 为周期重复的针脚, 所以半周期 (半步) 看起来也很像重复;
    但针脚只在一个完整条纹周期后对齐, 真正的周期是 ``period``。

    真值点阵由两个方向共同决定:
    ``t1 = (period/2, period/2)`` (沿条纹走一个条纹周期),
    ``t2 = (along/2, -along/2)`` (垂直条纹走一个针脚周期)。
    """
    h = w = size
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    s = (xx + yy) + phase
    d = (xx - yy) - phase
    u = s / (period / 2.0)
    # 平滑方波: 偶数条带为 A, 奇数条带为 B; 两种颜色只差一点点
    w_a = 0.5 + 0.5 * np.tanh(9.0 * np.cos(np.pi * u))
    w_b = 1.0 - w_a
    ca = np.array((0.62, 0.47, 0.30), dtype=np.float64)
    cb = ca + np.array([color_shift, -color_shift * 0.5, color_shift * 1.5])
    img = (w_a[..., None] * ca[None, None, :]
           + w_b[..., None] * cb[None, None, :])
    # 条纹上的针脚: 周期 = 完整条纹周期, 平移半周期后针脚错开半个 -> 半步不等价。
    # 针脚本身做成不对称的短脉冲, 这样它的自相关不会在"半周期"上再冒一个峰。
    cyc = np.mod(s / period, 1.0)
    dashpat = np.exp(-((cyc - 0.18) / 0.07) ** 2)
    # 沿条纹走向的斜纹肌理, 周期 along
    herr = 0.065 * np.cos(2 * np.pi * d / along)
    img = img * (1.0 + (dash * dashpat + herr)[..., None])
    light = 1.0 + 0.05 * (xx / size - 0.5) - 0.04 * (yy / size - 0.5)
    img = img * light[..., None]
    rng = np.random.default_rng(seed)
    img = _finish(img, rng, noise=0.010, blur_sigma=0.4)

    truth_t1 = (float(period / 2.0), float(period / 2.0))
    truth_t2 = (float(along / 2.0), float(-along / 2.0))
    ex = Example(
        key="stripes", title=f"斜条纹 (条纹周期 {period:g} px, 半步歧义)",
        image=img, region=(64, 64, 384, 384),
        truth_t1=truth_t1, truth_t2=truth_t2,
        truth_origin=(0.0, 0.0),
        description=("45° 斜条纹, 相邻两条颜色很接近、沿条纹方向的针脚错开半格: "
                     "半周期 (半步) 单看条纹也像重复, 但不是真正的周期。"
                     "用来验证半步提示与平铺导出。"),
        tags=["builtin", "half_decoy"],
    )
    return ex


def _defect_texture(size: int = 512, seed: int = 20240505) -> Example:
    """有缺损的方形纹理: 污渍、划痕、缺一枚纹样、逐格色差。"""
    h = w = size
    t1, t2 = (64.0, 0.0), (0.0, 64.0)
    draw_origin = (32.0, 32.0)
    rng = np.random.default_rng(seed)
    img = _fabric_base(h, w, rng, color=(0.78, 0.72, 0.58))
    _draw_lattice_motifs(
        img, t1, t2, draw_origin, radius=18.0,
        color_main=(0.30, 0.42, 0.30), color_accent=(0.90, 0.80, 0.48),
        color_ring=(0.35, 0.25, 0.22), seed=seed + 1, wear=0.045,
        missing=[(4, 3), (6, 5)],
    )
    # 缺损: 污渍 (软椭圆)
    for cx, cy, rx, ry, strength in (
        (150.0, 210.0, 42.0, 27.0, 0.25),
        (330.0, 120.0, 30.0, 36.0, 0.20),
        (250.0, 390.0, 55.0, 24.0, 0.18),
    ):
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
        d = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2
        a = np.clip(1.0 - d, 0.0, 1.0) ** 1.5 * strength
        img = img * (1 - a[..., None]) + np.array([0.36, 0.30, 0.20]) * a[..., None]
    # 缺损: 一道斜向抽丝/划痕
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    line = np.abs((yy - 0.55 * xx - 80.0))
    a = np.clip(1.0 - line / 1.8, 0.0, 1.0) * 0.35
    img = img * (1 - a[..., None]) + np.array([0.95, 0.93, 0.85]) * a[..., None]
    img = _finish(img, rng, noise=0.015, blur_sigma=0.5)
    return Example(
        key="defect", title="带缺损的方形纹理",
        image=img, region=(48, 48, 416, 416),
        truth_t1=t1, truth_t2=t2, truth_origin=(0.0, 0.0),
        description=("周期仍然成立, 但有污渍、划痕、缺失纹样和逐格色差; "
                     "这些是样本差异, 不是周期测量错误。"),
        tags=["builtin", "defect"],
    )


def _fractional_stripes(size: int = 512, seed: int = 20240606,
                        period: float = 27.4) -> Example:
    """斜条纹, 但真实周期是小数像素。"""
    ex = _diagonal_stripes(size=size, seed=seed, period=period,
                           color_shift=0.010, dash=0.010, phase=0.63)
    ex.key = "stripes_frac"
    ex.title = f"斜条纹 (小数周期 {period:g} px)"
    ex.description = ("真实周期落在小数像素, 单元角点也落在小数像素; "
                      "用来检查小数角点的保存与平铺。")
    ex.tags = ["fractional", "half_decoy"]
    return ex


_EXAMPLE_FACTORIES = {
    "square": _square_flower,
    "diagonal": _diagonal_flower,
    "stagger": _stagger_flower,
    "stripes": _diagonal_stripes,
    "stripes_frac": _fractional_stripes,
    "defect": _defect_texture,
}


def list_examples() -> List[Tuple[str, str]]:
    """[(key, title)]，按界面展示顺序。"""
    order = ["square", "diagonal", "stagger", "stripes", "stripes_frac", "defect"]
    out = []
    for key in order:
        if key == "stripes":
            out.append((key, "斜条纹 (整数周期, 半步歧义)"))
        elif key == "stripes_frac":
            out.append((key, "斜条纹 (小数周期, 半步歧义)"))
        elif key == "defect":
            out.append((key, "带缺损的方形纹理"))
        elif key == "square":
            out.append((key, "方形重复"))
        elif key == "diagonal":
            out.append((key, "斜排重复"))
        elif key == "stagger":
            out.append((key, "隔行错开"))
    return out


def generate_example(key: str, **kwargs) -> Example:
    if key not in _EXAMPLE_FACTORIES:
        raise KeyError(f"未知示例: {key}")
    return _EXAMPLE_FACTORIES[key](**kwargs)


# 真值核对用的工具 ---------------------------------------------------------

def lattice_equivalent(t1: Vec, t2: Vec, u1: Vec, u2: Vec,
                       tol: float = 0.12) -> bool:
    """两组基矢是否张成同一个点阵 (允许互相整数变换)。"""
    from .geometry import solve_basis
    try:
        A = solve_basis(t1, t2)
        B = solve_basis(u1, u2)
        M = np.linalg.inv(A) @ B
    except ValueError:
        return False
    R = np.round(M)
    return bool(np.all(np.abs(M - R) <= tol)
                and abs(abs(np.linalg.det(M)) - abs(np.linalg.det(R))) <= tol * 2)
