"""限幅器核心 DSP。

设计要点
========
* 这是一个**离线 lookahead 限幅器**（与 DAW 里导出渲染的工作方式一致）：
    1. 由输入电平算出每个采样点需要的目标增益 target_gain；
    2. 在长度为 lookahead 的窗口内取最小增益，并把该增益**反向传播**到窗口起点
       （attack / 提前量），保证尖峰到达时增益已经压到位，attack 本身无 clicks；
    3. 正向做 release（恢复）约束，限制每个采样增益最多回升多少，避免增益突变；
    4. 直接把增益包络乘到原信号上 —— 与"延迟信号 L 个采样做因果处理"在采样位置上
       完全等价，导出文件与输入**等长、脉冲索引不变**，无需任何裁剪或补零。
* 立体声联动模式取两声道共同的目标增益（联动声像）；独立模式各走各的包络。
* 采样峰由增益包络数学保证不超过 ceiling；重建峰（true peak）经 4x 过采样实测，
  可选 true-peak 保护：按实测比例反复收紧 ceiling，直到重建峰也不超线。
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass

import numpy as np
from scipy.signal import resample_poly


# ---------------------------------------------------------------------------
# 增益包络
# ---------------------------------------------------------------------------

def _target_gain(x: np.ndarray, ceiling: float) -> np.ndarray:
    """每个采样点为满足 |x| <= ceiling 所需的线性增益（<=1）。"""
    peak = np.abs(x)
    gain = np.ones_like(x, dtype=np.float64)
    hot = peak > ceiling
    gain[hot] = ceiling / peak[hot]
    return gain


def _window_min_forward(g: np.ndarray, lookahead: int) -> np.ndarray:
    """滑动窗口最小值：out[i] = min(g[i : i + lookahead + 1])。

    即每个位置都能"看到"未来 lookahead 个采样内最深的衰减需求，
    这是提前量（attack）能在尖峰之前建立的来源。
    """
    n = g.shape[0]
    out = np.empty_like(g)
    # 单调队列存索引，对应值单调递增；队首即窗口最小值。
    dq: deque[int] = deque()
    for i in range(n):
        while dq and g[dq[-1]] >= g[i]:
            dq.pop()
        dq.append(i)
        # 窗口右沿 i + lookahead 超出信号尾部后，逐步从队首淘汰过期索引。
        expire_before = i - lookahead
        while dq and dq[0] <= expire_before:
            dq.popleft()
        out[i] = g[dq[0]]
    return out


def _smooth_release(g: np.ndarray, release_samples: int) -> np.ndarray:
    """release 约束：增益每个采样最多回升 1 / release_samples。

    下降方向（需要更深衰减）永远立即响应，只有恢复速度被限制。
    release_samples <= 0 表示不限制恢复（瞬时恢复）。
    """
    if release_samples <= 0:
        return g.copy()
    out = np.empty_like(g)
    step = 1.0 / float(release_samples)
    prev = 1.0
    for i in range(g.shape[0]):
        target = g[i]
        if target <= prev:
            prev = target  # 需要压更深：立刻下去
        else:
            prev = min(target, prev + step)  # 恢复：每采样最多 +step
        out[i] = prev
    return out


def gain_envelope(x: np.ndarray, ceiling: float, lookahead: int,
                  release_samples: int) -> np.ndarray:
    """单声道增益包络（线性增益，形状与 x 相同）。"""
    target = _target_gain(x, ceiling)
    anticipated = _window_min_forward(target, max(0, int(lookahead)))
    return _smooth_release(anticipated, max(0, int(release_samples)))


# ---------------------------------------------------------------------------
# 限幅主入口
# ---------------------------------------------------------------------------

@dataclass
class LimiterResult:
    """限幅处理结果。

    Attributes
    ----------
    y: 处理后信号，形状与输入完全一致（等长、脉冲索引不变）。
    gain: 实际增益包络（线性），形状 (N,) 单声道 / (N, 2) 立体声。
    ceiling: 实际使用的采样峰值上限（线性），启用 true-peak 保护时会被收紧。
    lookahead, release_samples: 生效参数。
    linked: 立体声是否联动。
    delay_samples: 算法等效处理延迟（= lookahead），离线渲染已补偿。
    tp_guard_iters: true-peak 保护迭代次数，0 表示未启用或一次达标。
    """

    y: np.ndarray
    gain: np.ndarray
    ceiling: float
    lookahead: int
    release_samples: int
    linked: bool
    delay_samples: int
    tp_guard_iters: int


def limit(x: np.ndarray, ceiling_db: float, lookahead: int,
          release_ms: float, fs: float, linked: bool = True,
          true_peak_guard: bool = False,
          guard_margin_db: float = 0.0) -> LimiterResult:
    """对信号做 lookahead 限幅。

    Parameters
    ----------
    x: 一维（单声道）或二维 (N, 2)（立体声）浮点信号，幅度约 [-1, 1]。
    ceiling_db: 峰值上限，dBFS（如 -1.0 表示 -1 dBFS）。
    lookahead: 提前量，采样数。
    release_ms: 恢复时间，毫秒。
    fs: 采样率 Hz。
    linked: 立体声是否联动（单声道时忽略）。
    true_peak_guard: 是否额外保证重建峰（true peak）也不超线。
    guard_margin_db: true-peak 保护额外预留的余量 dB。
    """
    x = np.asarray(x, dtype=np.float64)
    mono = x.ndim == 1
    if mono:
        x2 = x[:, None]
    else:
        if x.shape[1] != 2:
            raise ValueError("仅支持单声道或双声道立体声信号")
        x2 = x
    n, nch = x2.shape

    ceiling = 10.0 ** (ceiling_db / 20.0)
    release_samples = int(round(release_ms * 1e-3 * fs))
    lookahead = max(0, int(lookahead))

    # 立体声联动：两声道取同一个目标增益（按瞬时电平较大的声道决定）。
    if nch == 2 and linked:
        drive = np.max(np.abs(x2), axis=1)
        env_mono = gain_envelope(drive, ceiling, lookahead, release_samples)
        env = np.repeat(env_mono[:, None], 2, axis=1)
    else:
        env = np.column_stack([
            gain_envelope(x2[:, c], ceiling, lookahead, release_samples)
            for c in range(nch)
        ])

    y = x2 * env
    iters = 0

    if true_peak_guard:
        # 迭代收紧增益包络，直到 4x 过采样实测的重建峰也 <= 用户 ceiling。
        # 为什么不能只按 ceiling 重算一次：sinc 插值的最大重建点会随整体缩放
        # 在脉冲采样与相邻插值点之间易位，过冲比 k = true/sample 随之变化，
        # 单轮缩放后实测值常停在目标附近却仍超标，故按实测过冲逐轮收紧。
        # 注意：只收紧增益包络，ceiling 记录值保持为用户设定 —— 重建峰收敛
        # 到的正是这个 ceiling，采样峰只会比它更低。
        target = ceiling * (10.0 ** (-guard_margin_db / 20.0))
        for _ in range(20):
            tp = true_peak_levels(y, fs, up=4)
            over = tp.max()
            if over <= target:
                break
            env *= target / over
            y = x2 * env
            iters += 1

    if mono:
        y_out = y[:, 0]
        env_out = env[:, 0]
    else:
        y_out = y
        env_out = env

    return LimiterResult(
        y=y_out, gain=env_out, ceiling=ceiling, lookahead=lookahead,
        release_samples=release_samples, linked=linked,
        delay_samples=lookahead, tp_guard_iters=iters,
    )


# ---------------------------------------------------------------------------
# 峰值测量：采样峰 vs 重建峰（true peak）
# ---------------------------------------------------------------------------

def sample_peak(x: np.ndarray) -> np.ndarray:
    """采样峰（线性幅度），单声道返回 1 元素数组，立体声返回每声道一个。"""
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 1:
        return np.array([np.max(np.abs(x)) if x.size else 0.0])
    return np.max(np.abs(x), axis=0)


def true_peak_levels(x: np.ndarray, fs: float, up: int = 4) -> np.ndarray:
    """重建峰（true peak，线性幅度）。

    用 polyphase 加 sinc 抗镜像滤波做 up 倍过采样（等价 ITU-R BS.1770 系
    true-peak 测量思路的简化实现），取过采样信号的最大绝对值。
    返回每声道一个值；单声道返回长度 1 的数组。
    """
    x = np.asarray(x, dtype=np.float64)
    mono = x.ndim == 1
    cols = [x] if mono else [x[:, c] for c in range(x.shape[1])]
    out = []
    for col in cols:
        if col.size == 0:
            out.append(0.0)
            continue
        # up=4, down=1：内部 FIR 低通滤除镜像频谱，再插值。
        osig = resample_poly(col, up=up, down=1, window=("kaiser", 5.0))
        out.append(float(np.max(np.abs(osig))))
    return np.asarray(out)


def to_dbfs(linear: np.ndarray | float) -> np.ndarray | float:
    """线性幅度转 dBFS（0 幅度记为 -inf，由调用方决定如何展示）。"""
    a = np.asarray(linear, dtype=np.float64)
    with np.errstate(divide="ignore"):
        return 20.0 * np.log10(np.maximum(a, 1e-12))
