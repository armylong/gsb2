"""一阶 Ambisonic (FOA / AmbiX) 的旋转、解码与自动化纯 numpy 实现。

约定
----
* 内部通道顺序为 AmbiX = ACN: (W, Y, Z, X)，SN3D 归一化。
* 方位角 ``az`` 为弧度, 0 = 正前方(+X), 逆时针为正, +90° = 正左(+Y)。
* ``yaw`` 为听音者水平朝向(同样逆时针为正)。声场旋转后, 声源表观方位
  变为 ``az - yaw``; yaw 与 yaw+2π 严格等价(余弦/正弦实现, 转一圈回到同一状态)。
* 全部数组按 (帧数, 4) 处理, 单帧用 (4,) 也可。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

# ACN 通道索引
IDX_W, IDX_Y, IDX_Z, IDX_X = 0, 1, 2, 3
ACN_NAMES = ("W", "Y", "Z", "X")
ACN_DESCRIPTIONS = (
    "W  全向(声压)分量, SN3D 归一化, 与方向无关",
    "Y  前后-左右指向分量, 正轴指向左侧(+Y)",
    "Z  垂直指向分量, 水平旋转中保持不变",
    "X  前后指向分量, 正轴指向前方(+X)",
)

SQRT3 = math.sqrt(3.0)

# 试听模式
MODE_FULL = "full"          # 完整一阶信号
MODE_OMNI = "omni"          # 只听全向分量 W
MODE_DIR = "directional"    # 只听指向分量 Y/Z/X
SOLO_MODES = ("solo0", "solo1", "solo2", "solo3")  # 单独听 W/Y/Z/X


def as_2d(b: np.ndarray) -> np.ndarray:
    arr = np.asarray(b, dtype=np.float64)
    if arr.ndim == 1:
        arr = arr[None, :]
    if arr.shape[-1] != 4:
        raise ValueError(f"期望 4 通道 FOA 信号, 得到 shape={arr.shape}")
    return arr


def normalize_deg(deg: float) -> float:
    """归一化到 [0, 360)。"""
    return deg % 360.0


def normalize_rad(rad: float) -> float:
    return rad % (2.0 * math.pi)


def rotate_yaw(b: np.ndarray, yaw: float) -> np.ndarray:
    """把声场按听音者朝向 ``yaw``(弧度)做水平旋转。

    平面波检验: 旋转后 Y/X 指向由 az 变为 az-yaw。
    W、Z 在水平旋转中不变。
    """
    arr = as_2d(b)
    c, s = math.cos(yaw), math.sin(yaw)
    w, y, z, x = arr[:, 0], arr[:, 1], arr[:, 2], arr[:, 3]
    y2 = c * y - s * x
    x2 = s * y + c * x
    out = np.empty_like(arr)
    out[:, 0] = w
    out[:, 1] = y2
    out[:, 2] = z
    out[:, 3] = x2
    if np.asarray(b).ndim == 1:
        return out[0]
    return out


def _decode_matrix(speaker_angle_deg: float, mode: str) -> np.ndarray:
    """返回 2x4 解码矩阵 (L/R 行, W/Y/Z/X 列)。

    虚拟扬声器方位 ±φ, 投影解码权重
    g(φ_s) = 0.5·W + 1/(2√3)·(Y·sinφ_s + X·cosφ_s), Z 不参与水平重放。
    对单位平面波该权重等于 0.5·(1+cos(θ-φ_s)) ∈ [0,1]。
    """
    phi = math.radians(speaker_angle_deg)
    sp, cp = math.sin(phi), math.cos(phi)
    m = np.zeros((2, 4))
    # 完整模式
    m[0, IDX_W] = 0.5
    m[1, IDX_W] = 0.5
    m[0, IDX_Y] = sp / (2.0 * SQRT3)
    m[1, IDX_Y] = -sp / (2.0 * SQRT3)
    m[0, IDX_X] = cp / (2.0 * SQRT3)
    m[1, IDX_X] = cp / (2.0 * SQRT3)
    if mode == MODE_FULL:
        return m
    if mode == MODE_OMNI:
        mm = np.zeros_like(m)
        mm[:, IDX_W] = m[:, IDX_W]
        return mm
    if mode == MODE_DIR:
        mm = m.copy()
        mm[:, IDX_W] = 0.0
        return mm
    if mode in SOLO_MODES:
        ch = int(mode[-1])
        mm = np.zeros_like(m)
        if ch == IDX_Z:
            # Z 是垂直分量, 水平虚拟扬声器无输出; 试听时等幅送入两耳并在界面注明
            mm[:, IDX_Z] = 0.5
        else:
            mm[:, ch] = m[:, ch]
        return mm
    raise ValueError(f"未知试听模式: {mode}")


def decode_stereo(
    b: np.ndarray, speaker_angle_deg: float, mode: str = MODE_FULL
) -> np.ndarray:
    """FOA -> 立体声 (帧数, 2), 列顺序为 (L, R)。"""
    arr = as_2d(b)
    m = _decode_matrix(speaker_angle_deg, mode)
    return arr @ m.T


def plane_wave(az_deg: float, signal: np.ndarray) -> np.ndarray:
    """把单声道信号按方位角 az 编码成 AmbiX FOA (N,4), Z=0。"""
    az = math.radians(az_deg)
    n = np.asarray(signal, dtype=np.float64).shape[0]
    b = np.zeros((n, 4))
    b[:, IDX_W] = signal
    b[:, IDX_Y] = SQRT3 * signal * math.sin(az)
    b[:, IDX_X] = SQRT3 * signal * math.cos(az)
    return b


def intensity_azimuth(b: np.ndarray) -> float | None:
    """用主动强度向量估计块内主导声源方位(弧度)。

    I ∝ E[W·Y], E[W·X]; 平面波给出 atan2(sinθ, cosθ)=θ。
    能量过小(近静音)时返回 None。
    """
    arr = as_2d(b)
    w = arr[:, IDX_W]
    energy = float(np.mean(w * w) + np.mean(arr[:, IDX_Y] ** 2) / 3.0
                   + np.mean(arr[:, IDX_X] ** 2) / 3.0)
    if energy < 1e-10:
        return None
    iy = float(np.mean(w * arr[:, IDX_Y]))
    ix = float(np.mean(w * arr[:, IDX_X]))
    if abs(ix) < 1e-12 and abs(iy) < 1e-12:
        return None
    return math.atan2(iy, ix)


def level_db(x: np.ndarray) -> tuple[float, float]:
    """返回 (RMS dBFS, 峰值 dBFS)。空/静音返回 -inf。"""
    arr = np.asarray(x, dtype=np.float64)
    if arr.size == 0:
        return float("-inf"), float("-inf")
    peak = float(np.max(np.abs(arr)))
    rms = float(np.sqrt(np.mean(arr * arr)))
    to_db = lambda v: float("-inf") if v <= 1e-12 else 20.0 * math.log10(v)
    return to_db(rms), to_db(peak)


# ---------------------------------------------------------------------------
# 通道序转换
# ---------------------------------------------------------------------------

def fuma_to_ambix(b_fuma: np.ndarray) -> np.ndarray:
    """FuMa (W,X,Y,Z, 各自 FuMa 增益) -> AmbiX (W,Y,Z,X, SN3D)。"""
    arr = np.asarray(b_fuma, dtype=np.float64)
    out = np.empty_like(arr)
    out[..., IDX_W] = math.sqrt(2.0) * arr[..., 0]
    out[..., IDX_X] = SQRT3 * arr[..., 1]
    out[..., IDX_Y] = SQRT3 * arr[..., 2]
    out[..., IDX_Z] = SQRT3 * arr[..., 3]
    return out


def custom_to_ambix(b: np.ndarray, permutation: tuple[int, int, int, int]) -> np.ndarray:
    """按“输入的第几路对应 W/Y/Z/X”重排, 不做增益换算(假定已是 SN3D)。"""
    if sorted(permutation) != [0, 1, 2, 3]:
        raise ValueError("通道映射必须是 0..3 的一个排列")
    return np.asarray(b, dtype=np.float64)[..., list(permutation)]


# ---------------------------------------------------------------------------
# 朝向标记与自动化
# ---------------------------------------------------------------------------

DIR_CW = "cw"          # 顺时针(方位角减小方向)
DIR_CCW = "ccw"        # 逆时针(方位角增大方向)
DIR_SHORTEST = "shortest"


def _turn_delta(a_deg: float, b_deg: float, direction: str) -> float:
    """从朝向 a 到 b 应走过的带符号角度(度), 按所选方向处理 0/360 跨界。"""
    if direction == DIR_CCW:
        return (b_deg - a_deg) % 360.0
    if direction == DIR_CW:
        return (b_deg - a_deg) % 360.0 - 360.0
    if direction == DIR_SHORTEST:
        d = (b_deg - a_deg) % 360.0
        return d if d <= 180.0 else d - 360.0
    raise ValueError(f"未知旋转方向: {direction}")


@dataclass
class YawMarkers:
    """少量 (时刻秒, 朝向度) 标记, 标记间线性插值, 两端保持。

    内部把朝向展开为不折返的连续角度, 因此 0° -> 360° 这样的整圈标记
    会真实走完一圈, 而不是被归一化吞成不动。
    """

    markers: list[tuple[float, float]] = field(default_factory=list)
    direction: str = DIR_SHORTEST

    def sorted_markers(self) -> list[tuple[float, float]]:
        return sorted(self.markers, key=lambda p: p[0])

    def _unwrapped(self) -> list[tuple[float, float]]:
        """把标记角按所选方向展开为连续(单调或短弧)的角度序列。

        保留 360°、720° 等显式写出的整圈数, 使 0 -> 360 真实走完一圈,
        而不是被取模吞成原地不动。
        """
        ms = self.sorted_markers()
        if not ms:
            return []
        out = [(ms[0][0], float(ms[0][1]))]
        for t, a in ms[1:]:
            prev = out[-1][1]
            raw = float(a) - prev
            # 仅当 raw 本身就是(近似)整圈时才承认显式圈数,
            # 这样 -340° 不会被当成“-1 圈 +20°”, 而 360°/720° 保留
            nearest_turn = round(raw / 360.0)
            explicit_turns = (
                int(nearest_turn) if abs(raw - nearest_turn * 360.0) < 1e-6 else 0)
            base = (raw - 360.0 * explicit_turns) % 360.0  # [0,360) 同余角差
            if self.direction == DIR_CCW:
                # 逆时针: 非负角差 + 显式整圈(如 0->720)
                delta = base + 360.0 * explicit_turns
            elif self.direction == DIR_CW:
                # 顺时针: 同余角差转负(0 保持 0) + 显式整圈
                delta = (base - 360.0 if base > 0 else 0.0) + 360.0 * explicit_turns
            else:  # 最短方向: 整圈标记保留, 非整圈取短弧
                d = base if base <= 180.0 else base - 360.0
                delta = d + 360.0 * explicit_turns
            out.append((t, prev + delta))
        return out

    def yaw_at(self, t: float) -> float:
        """返回 t 时刻朝向(度, 已归一化到 [0,360))。"""
        ms = self.sorted_markers()
        if not ms:
            return 0.0
        uw = self._unwrapped()
        if t <= uw[0][0]:
            return normalize_deg(uw[0][1])
        if t >= uw[-1][0]:
            return normalize_deg(uw[-1][1])
        for (t0, a0), (t1, a1) in zip(uw[:-1], uw[1:]):
            if t0 <= t <= t1:
                if t1 == t0:
                    return normalize_deg(a1)
                return normalize_deg(a0 + (t - t0) / (t1 - t0) * (a1 - a0))
        return normalize_deg(uw[-1][1])

    def yaw_curve(self, times: np.ndarray) -> np.ndarray:
        return np.deg2rad(np.array([self.yaw_at(float(t)) for t in times]))


# ---------------------------------------------------------------------------
# 离线渲染(导出与回放共用, 保证二者结果一致)
# ---------------------------------------------------------------------------

def render_stereo(
    b: np.ndarray,
    sr: int,
    speaker_angle_deg: float,
    mode: str = MODE_FULL,
    fixed_yaw_deg: float | None = None,
    automation: YawMarkers | None = None,
    start_time: float = 0.0,
    end_time: float | None = None,
    lr_flip: bool = False,
) -> np.ndarray:
    """按参数确定性地渲染立体声 (M,2), 与当前试听位置无关。

    automation 非空时使用标记自动化, 否则使用 fixed_yaw_deg(默认 0)。
    lr_flip=True 时导出列顺序为 (R, L)。
    """
    arr = as_2d(b)
    n = arr.shape[0]
    i0 = max(0, int(round(start_time * sr)))
    i1 = n if end_time is None else min(n, int(round(end_time * sr)))
    part = arr[i0:i1]
    m = part.shape[0]
    if automation is not None and automation.markers:
        times = (np.arange(m, dtype=np.float64) + i0) / sr
        yaws = automation.yaw_curve(times)
        # 逐块旋转(块内朝向近似常量, 1024 样本块误差可忽略且回放同算法)
        out = np.empty((m, 2))
        block = 1024
        for s in range(0, m, block):
            e = min(m, s + block)
            rot = rotate_yaw(part[s:e], float(yaws[s]))
            out[s:e] = decode_stereo(rot, speaker_angle_deg, mode)
    else:
        yaw = math.radians(0.0 if fixed_yaw_deg is None else fixed_yaw_deg)
        out = decode_stereo(rotate_yaw(part, yaw), speaker_angle_deg, mode)
    if lr_flip:
        out = out[:, [1, 0]]
    return out
