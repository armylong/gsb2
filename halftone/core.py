"""半色调核心算法：灰度转换、墨量曲线、圆点/线网渲染、选区统计。

设计约定
========
1. 灰度口径固定为 ITU-R BT.601:
       Y = round(0.299 R + 0.587 G + 0.114 B)
   彩色输入按同一口径转换，结果在界面上明确标注。
2. 墨量曲线只有一个形状参数 gamma:
       t = 1 - (Y / 255) ** gamma
   Y=0(黑) -> t=1 满墨，Y=255(白) -> t=0 无墨；端点固定，不允许曲线改动端点。
   gamma 越大中间调墨量越少，gamma 越小中间调越重。
3. 输出是严格二值图 (uint8, 仅 0/255)：0=墨(黑)，255=纸(白)。中间灰度完全
   由网点覆盖面积表达，不存在任何残留连续灰阶。每个输出像素由 4x4 个子像素
   做面积判定(见 SUBSAMPLES)，消除角度对齐时的单点走样。
4. 网格在整个图像坐标系上连续一致：
   - 网格原点固定在像素坐标 (0, 0)，相位 (phase_x, phase_y) 以像素为单位
     平移网格原点，改变窗口缩放/预览范围不参与渲染，因此不可能重新排布。
   - 角度 theta 为逆时针旋转角(度)，对全部像素使用同一个旋转后的坐标系，
     不在图像边界处重置相位；落在边界上的网点只截到它落在图内的部分。
5. 圆点覆盖率与阈值做了解析绑定(不是经验阈值)，均匀灰块上实测覆盖量与
   目标墨量一致：
   - t <= 0.5: 独立圆盘，半径 r = P*sqrt(t/pi)，至多与四个邻居相切；
   - t >  0.5: 四象限菱形合并区(白色方孔)，等效白盘半径 sqrt((1-t)/pi)。
   两个工况在 t=0.5 处几何重合，切换不产生覆盖量跳变。
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np

SCREEN_DOT = "dot"
SCREEN_LINE = "line"
SCREEN_LABELS = {SCREEN_DOT: "圆点", SCREEN_LINE: "线网"}

MIN_PERIOD = 2.0
MAX_PERIOD = 200.0
GAMMA_RANGE = (0.2, 5.0)

# 每个输出像素在每边取的子采样点数(SS x SS)。
# 必要性: 角度为 0 等特殊朝向下像素中心会与网格精确对齐，单点判定会产生
# 系统性走样(实测周期 4 时偏差可达 25 个百分点)。子像素面积判定把误差
# 限制在一个像素的面积量级，且网格坐标本身仍对全图连续一致。
# 小周期下圆盘只占很少几个像素，需要更细的子采样，故按周期自适应。
SS_SMALL = 8
SS_NORMAL = 4
SS_SMALL_PERIOD = 6.0
# 分块行数(输出像素)，控制超采样下的临时内存峰值(SS=8 时约百 MB 内)
_CHUNK_ROWS = 32

# 固定 4x4 有序抖动阈值(Bayer)，阈值点居中于各 1/16 区间。
# 作用只是把每个输出像素的"着墨面积占比"二值化：面积占比超过该像素位置的
# 阈值即为墨。它是确定性的、只依赖像素坐标，不引入随机性，也不参与网点网格
# 排布；大面积上的平均覆盖量因此逼近真实面积而不是被 0.5 硬阈值系统性带偏。
_BAYER4 = (
    np.array(
        [
            [0, 8, 2, 10],
            [12, 4, 14, 6],
            [3, 11, 1, 9],
            [15, 7, 13, 5],
        ],
        dtype=np.float32,
    )
    + 0.5
) / 16.0


def _dither_threshold(height: int, width: int) -> np.ndarray:
    """按像素坐标平铺的阈值矩阵 (float32, shape h x w)。"""
    ty = int(np.ceil(height / 4))
    tx = int(np.ceil(width / 4))
    return np.tile(_BAYER4, (ty, tx))[:height, :width]

DEFAULT_PARAMS: dict[str, Any] = {
    "screen": SCREEN_DOT,
    "period": 10.0,      # 网格周期 P, 单位像素
    "angle": 15.0,       # 逆时针旋转角, 度
    "phase_x": 0.0,      # 网格原点水平相位, 像素
    "phase_y": 0.0,      # 网格原点垂直相位, 像素
    "gamma": 1.0,        # 墨量曲线 gamma
}


class HalftoneError(ValueError):
    """参数非法等可向用户展示的普通错误。"""


# ---------------------------------------------------------------------------
# 灰度
# ---------------------------------------------------------------------------
def to_grayscale(bgr: np.ndarray) -> np.ndarray:
    """BGR(或 BGRA) 图像按 BT.601 转单通道灰度。

    使用定点整数权重实现 OpenCV 经典口径(0.299/0.587/0.114)，返回 uint8。
    不透明输入才允许进入本函数(透明图在 io.load_image 阶段被拒绝)。
    """
    arr = np.asarray(bgr)
    if arr.ndim != 3:
        if arr.ndim == 2:
            return arr.astype(np.uint8, copy=True)
        raise HalftoneError("不支持的图像维度")
    b = arr[:, :, 0].astype(np.uint16)
    g = arr[:, :, 1].astype(np.uint16)
    r = arr[:, :, 2].astype(np.uint16)
    # (76 R + 150 G + 29 B + 128) >> 8, 与 cv2.cvtColor COLOR_BGR2GRAY 同口径
    y = (76 * r + 150 * g + 29 * b + 128) >> 8
    return y.astype(np.uint8)


def target_coverage(gray: np.ndarray, gamma: float = 1.0) -> np.ndarray:
    """逐像素目标墨量 t in [0,1]，float32。"""
    if not GAMMA_RANGE[0] <= float(gamma) <= GAMMA_RANGE[1]:
        raise HalftoneError(
            f"gamma 必须在 {GAMMA_RANGE[0]}~{GAMMA_RANGE[1]} 之间"
        )
    y = gray.astype(np.float32) / 255.0
    t = 1.0 - np.power(y, np.float32(gamma))
    return np.clip(t, 0.0, 1.0).astype(np.float32)


# ---------------------------------------------------------------------------
# 参数校验
# ---------------------------------------------------------------------------
def validate_params(params: dict[str, Any]) -> dict[str, Any]:
    """校验并归一化一组网点参数，非法时抛 HalftoneError(普通提示)。"""
    p = dict(DEFAULT_PARAMS)
    p.update(params)

    if p["screen"] not in SCREEN_LABELS:
        raise HalftoneError("网点形式只能是圆点(dot)或线网(line)")

    try:
        period = float(p["period"])
        angle = float(p["angle"])
        px = float(p["phase_x"])
        py = float(p["phase_y"])
        gamma = float(p["gamma"])
    except (TypeError, ValueError) as exc:
        raise HalftoneError("网点参数必须是数值") from exc
    if not math.isfinite(period) or not (MIN_PERIOD <= period <= MAX_PERIOD):
        raise HalftoneError(
            f"网格周期非法：必须是 {MIN_PERIOD:g}~{MAX_PERIOD:g} 像素之间的有限数"
        )
    for name, v in (("角度", angle), ("水平相位", px), ("垂直相位", py)):
        if not math.isfinite(v):
            raise HalftoneError(f"{name}必须是有限数值")
    if not GAMMA_RANGE[0] <= gamma <= GAMMA_RANGE[1]:
        raise HalftoneError(
            f"墨量曲线 gamma 非法：必须在 {GAMMA_RANGE[0]}~{GAMMA_RANGE[1]} 之间"
        )

    return {
        "screen": p["screen"],
        "period": period,
        "angle": angle,
        "phase_x": px,
        "phase_y": py,
        "gamma": gamma,
    }


# ---------------------------------------------------------------------------
# 网格坐标
# ---------------------------------------------------------------------------
def _chunk_grid_coords(
    y0: int,
    y1: int,
    width: int,
    ss: int,
    params: dict[str, Any],
) -> tuple[np.ndarray, np.ndarray]:
    """返回行区间 [y0, y1) 内所有子像素的旋转网格坐标 (u, v)。

    返回数组形状为 ((y1-y0)*ss, width*ss)，取值折回 [-P/2, P/2)。
    子像素坐标直接在整张图像的连续坐标系里生成(不按块重置)，因此分块
    计算与整图计算等价，网格在全图保持连续。
    """
    period = params["period"]
    theta = math.radians(params["angle"])
    c, s = math.cos(theta), math.sin(theta)
    inv = 1.0 / ss

    # 子像素中心: 原像素 (x,y) 的第 (i,j) 个子像素位于 (x+(j+0.5)/ss, ...)
    xs = (np.arange(width * ss, dtype=np.float32) + 0.5) * inv - np.float32(
        params["phase_x"]
    )
    ys = (
        np.arange(y0 * ss, y1 * ss, dtype=np.float32) + 0.5
    ) * inv - np.float32(params["phase_y"])
    xx, yy = np.meshgrid(xs, ys)

    # 逆时针旋转: [u; v] = [[c, s], [-s, c]] [x; y]
    u = c * xx + s * yy
    v = -s * xx + c * yy

    # 折回一个周期, [-P/2, P/2)
    u = (u + 0.5 * period) % period - 0.5 * period
    v = (v + 0.5 * period) % period - 0.5 * period
    return u.astype(np.float32), v.astype(np.float32)


def _aggregate(ink_sub: np.ndarray, ss: int, shape: tuple[int, int]) -> np.ndarray:
    """子像素布尔图 -> 输出像素的着墨面积占比 (float32, 0~1)。

    ink_sub 形状 (h*ss, w*ss)，同一输出像素的子像素在两个轴上各连续 ss 个。
    """
    h, w = shape
    frac = (
        ink_sub.reshape(h, ss, w, ss)
        .mean(axis=(1, 3), dtype=np.float32)
    )
    return frac


# ---------------------------------------------------------------------------
# 网点渲染
# ---------------------------------------------------------------------------
def render_halftone(gray: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    """把灰度图渲染成严格二值半色调图 (uint8, 仅 0/255)。

    0=黑墨, 255=白纸。除端点外每个输出像素取 SS² 个子像素做面积判定，再用
    固定 Bayer 阈值把面积占比二值化，输出仍然只有黑白两值，不存在连续灰。
    阈值矩阵只依赖像素坐标，因此渲染结果对窗口缩放/预览范围完全不敏感。
    """
    p = validate_params(params)
    if gray.ndim != 2 or gray.dtype != np.uint8:
        raise HalftoneError("render_halftone 需要 uint8 单通道灰度图")

    h, w = gray.shape
    ss = SS_SMALL if p["period"] < SS_SMALL_PERIOD else SS_NORMAL
    period = p["period"]
    threshold = _dither_threshold(h, w)
    out = np.empty((h, w), dtype=np.uint8)

    for y0 in range(0, h, _CHUNK_ROWS):
        y1 = min(h, y0 + _CHUNK_ROWS)
        ch = y1 - y0
        u, v = _chunk_grid_coords(y0, y1, w, ss, p)

        # 目标墨量按输出像素给出，扩到子像素分辨率(同像素内 t 恒定)
        t_block = target_coverage(gray[y0:y1, :], p["gamma"])
        t = np.repeat(np.repeat(t_block, ss, axis=0), ss, axis=1)
        full = t >= 1.0
        empty = t <= 0.0
        body = ~full & ~empty
        p2 = period * period

        # 全程整数组向量化，避免布尔花式索引的额外拷贝
        if p["screen"] == SCREEN_DOT:
            low = body & (t <= 0.5)
            high = body & (t > 0.5)
            # 低工况: 独立圆盘，半径平方 = t P²/π
            r2 = t * (p2 / math.pi)
            disk = (u * u + v * v) <= r2
            # 高工况: 四象限菱形顶点白孔，白孔半径平方 = (1-t) P²/π
            rw2 = (1.0 - t) * (p2 / math.pi)
            half = 0.5 * period
            d2 = np.minimum(
                np.minimum((u - half) ** 2 + (v - half) ** 2,
                           (u + half) ** 2 + (v - half) ** 2),
                np.minimum((u - half) ** 2 + (v + half) ** 2,
                           (u + half) ** 2 + (v + half) ** 2),
            )
            hole = d2 <= rw2  # 白孔(纸)
            ink_sub = full | (low & disk) | (high & ~hole)
        else:
            # 线网: 平行等宽线条，半线宽 = P t/2，覆盖面积严格等于 t
            half_width = 0.5 * period * t
            line = np.abs(u) < half_width
            ink_sub = full | (body & line)

        frac = _aggregate(ink_sub, ss, (ch, w))
        # 面积占比与该像素位置的固定阈值比较 -> 严格二值
        block = np.where(frac >= threshold[y0:y1, :], 0, 255).astype(np.uint8)
        # 端点强制: 纯黑/纯白不受面积判定与抖动阈值影响
        block[t_block >= 1.0] = 0
        block[t_block <= 0.0] = 255
        out[y0:y1, :] = block

    return out


# ---------------------------------------------------------------------------
# 选区统计
# ---------------------------------------------------------------------------
@dataclass
class SelectionStats:
    x: int
    y: int
    w: int
    h: int
    pixel_count: int
    input_gray_mean: float          # 输入平均灰度 0~255
    target_ink_mean: float          # 目标墨量(曲线后的平均 t) 0~1
    measured_black_fraction: float  # 实测黑像素占比 0~1

    def as_dict(self) -> dict[str, Any]:
        return {
            "rect": [self.x, self.y, self.w, self.h],
            "pixel_count": self.pixel_count,
            "input_gray_mean": self.input_gray_mean,
            "target_ink_mean": self.target_ink_mean,
            "measured_black_fraction": self.measured_black_fraction,
        }


def _clip_rect(
    shape: tuple[int, int], x: int, y: int, w: int, h: int
) -> tuple[int, int, int, int]:
    height, width = shape
    x0 = max(0, int(x))
    y0 = max(0, int(y))
    x1 = min(width, int(x) + int(w))
    y1 = min(height, int(y) + int(h))
    return x0, y0, max(0, x1 - x0), max(0, y1 - y0)


def selection_stats(
    gray: np.ndarray,
    binary: np.ndarray,
    params: dict[str, Any],
    rect: tuple[int, int, int, int],
) -> SelectionStats:
    """统计选区内：输入平均灰度、目标墨量、实测黑像素占比。

    实测值直接数二值图里的 0(墨)像素，绝不拿理论墨量代替。
    空选区(裁剪后面积为 0)抛 HalftoneError，由界面做普通提示。
    """
    p = validate_params(params)
    x, y, w, h = _clip_rect(gray.shape, *rect)
    if w <= 0 or h <= 0:
        raise HalftoneError("选区为空：请在图像范围内拖出一个有效区域")

    g_roi = gray[y : y + h, x : x + w]
    b_roi = binary[y : y + h, x : x + w]
    t_roi = target_coverage(g_roi, p["gamma"])

    return SelectionStats(
        x=x,
        y=y,
        w=w,
        h=h,
        pixel_count=int(w * h),
        input_gray_mean=float(g_roi.mean()),
        target_ink_mean=float(t_roi.mean()),
        measured_black_fraction=float(np.count_nonzero(b_roi == 0) / (w * h)),
    )


def black_fraction(binary: np.ndarray) -> float:
    """整张二值图的黑像素占比。"""
    if binary.size == 0:
        return 0.0
    return float(np.count_nonzero(binary == 0) / binary.size)
