"""音频引擎：WAV 读写、中侧分解/合成、增益处理、保护衰减与统计量。

全部 DSP 使用 float64 numpy 数组，形状 (帧数, 2)，列顺序为 [左, 右]。

中侧口径（界面中也会明确说明）：
    M = (L + R) / 2      中间分量 = 左右平均
    S = (L - R) / 2      侧边分量 = 左右差的一半
    L = M + S            可逆还原
    R = M - S
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

MAX_DURATION_SEC = 20.0

# 监听/处理模式
MODE_STEREO = "stereo"  # 处理后立体声（正式成品）
MODE_MID = "mid"        # 单听中间
MODE_SIDE = "side"      # 单听侧边
ALL_MODES = (MODE_STEREO, MODE_MID, MODE_SIDE)

GAIN_MIN = 0.0
GAIN_MAX = 2.0


class AudioLoadError(Exception):
    """文件无法加载或不符合工具适用条件。"""


@dataclass
class AudioData:
    """加载后的音频文件。"""

    samples: np.ndarray          # (n,2) float64，单声道时两列相同
    samplerate: int
    subtype: str
    source_path: Path
    is_mono: bool

    @property
    def frames(self) -> int:
        return self.samples.shape[0]

    @property
    def duration(self) -> float:
        return self.frames / self.samplerate


@dataclass
class Params:
    """正式成品参数（单听模式不改变这些设置）。"""

    mid_gain: float = 1.0
    side_gain: float = 1.0
    mode: str = MODE_STEREO
    protect: bool = False


@dataclass
class Stats:
    """处理后立体声在给定区间上的统计量。"""

    correlation: float | None    # 左右皮尔逊相关系数，无有效值时为 None
    peak_left: float
    peak_right: float
    mono_peak: float             # 单声道合听 (L+R)/2 的峰值
    mono_rms: float


# ---------------------------------------------------------------- 读写

def load_wav(path: str | Path) -> AudioData:
    """加载 wav，校验声道数与时长。

    单声道文件照常返回但 is_mono=True，由界面提示不适用；
    超过 20 秒、非双声道（多声道）直接抛 AudioLoadError。
    """
    path = Path(path)
    try:
        info = sf.info(str(path))
    except Exception as exc:  # soundfile 抛出的底层异常类型较多
        raise AudioLoadError(f"无法读取音频文件：{exc}") from exc

    if info.format != "WAV":
        raise AudioLoadError(f"仅支持 WAV 文件，当前格式：{info.format}")
    if info.channels == 1:
        data, sr = sf.read(str(path), dtype="float64", always_2d=True)
        samples = np.repeat(data, 2, axis=1)  # 仅用于展示
        return AudioData(samples, sr, info.subtype, path, is_mono=True)
    if info.channels != 2:
        raise AudioLoadError(f"仅支持双声道 WAV，当前声道数：{info.channels}")
    if info.frames / info.samplerate > MAX_DURATION_SEC + 1e-9:
        raise AudioLoadError(
            f"音频时长 {info.frames / info.samplerate:.2f}s，"
            f"超过 {MAX_DURATION_SEC:.0f} 秒上限"
        )

    data, sr = sf.read(str(path), dtype="float64", always_2d=True)
    return AudioData(np.ascontiguousarray(data), sr, info.subtype, path, is_mono=False)


def write_wav(path: str | Path, samples: np.ndarray, samplerate: int,
              subtype: str) -> None:
    """按输入文件的 subtype 导出立体声 wav。"""
    sf.write(str(path), samples, samplerate, subtype=subtype)


def quantization_step(subtype: str) -> float:
    """各整数量化 subtype 的一个量化单位（满量程归一化）。"""
    bits = {
        "PCM_U8": 8,
        "PCM_S8": 8,
        "PCM_16": 16,
        "PCM_24": 24,
        "PCM_32": 32,
    }.get(subtype)
    if bits is None:
        return 1e-7  # FLOAT / DOUBLE 等，仅给一个很小的容差
    return 2.0 ** (1 - bits)


# ---------------------------------------------------------------- 中侧分解/合成

def lr_to_ms(lr: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """左右 -> (中间 M, 侧边 S)。"""
    mid = (lr[:, 0] + lr[:, 1]) * 0.5
    side = (lr[:, 0] - lr[:, 1]) * 0.5
    return mid, side


def ms_to_lr(mid: np.ndarray, side: np.ndarray) -> np.ndarray:
    """中侧 -> 左右，形状 (n,2)。"""
    return np.column_stack((mid + side, mid - side))


def process_stereo(lr: np.ndarray, mid_gain: float,
                   side_gain: float) -> np.ndarray:
    """正式立体声处理：M、S 分别乘增益后合回左右。

    这是真正的中侧处理，不是左右声像移动：
    侧边增益为 0 时 L'=R'=M；两个增益都为 1 时完全还原原声。
    """
    mid, side = lr_to_ms(lr)
    return ms_to_lr(mid * mid_gain, side * side_gain)


def compute_attenuation(lr: np.ndarray, mid_gain: float,
                        side_gain: float) -> float:
    """统一保护衰减系数（两声道同一个标量，绝不分别归一化）。

    超幅时返回 1/峰值，使最大样本恰好回到 1.0；否则返回 1.0。
    """
    peak = float(np.max(np.abs(process_stereo(lr, mid_gain, side_gain))))
    if peak > 1.0:
        return 1.0 / peak
    return 1.0


def render_product(lr: np.ndarray, params: Params) -> tuple[np.ndarray, float]:
    """渲染正式成品（立体声），返回 (采样, 实际衰减系数)。"""
    out = process_stereo(lr, params.mid_gain, params.side_gain)
    att = 1.0
    if params.protect:
        att = compute_attenuation(lr, params.mid_gain, params.side_gain)
        out = out * att
    return out, att


def render_monitor(lr: np.ndarray, params: Params) -> np.ndarray:
    """渲染监听信号。

    立体声模式等于正式成品；单听中间/侧边为两声道相同的纯监听信号，
    不套用保护衰减（保护只属于正式成品），且不修改 params 本身。
    """
    mid, side = lr_to_ms(lr)
    if params.mode == MODE_MID:
        mono = mid * params.mid_gain
        return np.column_stack((mono, mono))
    if params.mode == MODE_SIDE:
        mono = side * params.side_gain
        return np.column_stack((mono, mono))
    out, _ = render_product(lr, params)
    return out


# ---------------------------------------------------------------- 统计

def correlation(left: np.ndarray, right: np.ndarray) -> float | None:
    """左右皮尔逊相关系数，范围 [-1, 1]；无有效信号返回 None。

    任一路能量为零（含全静音、直流常量）时不存在有效相关值；
    反相信号得到接近 -1，不会被显示成同相。
    """
    if left.size == 0:
        return None
    x = left.astype(np.float64)
    y = right.astype(np.float64)
    xc = x - x.mean()
    yc = y - y.mean()
    # 用相对能量阈值，避免常量信号因浮点残差（~1e-17）被误判为有效
    var_x = float(xc @ xc)
    var_y = float(yc @ yc)
    energy_x = float(x @ x)
    energy_y = float(y @ y)
    eps = 1e-12
    if (var_x <= eps * max(energy_x, 1.0)
            or var_y <= eps * max(energy_y, 1.0)):
        return None
    denom = math.sqrt(var_x * var_y)
    if not np.isfinite(denom):
        return None
    return float(np.clip((xc @ yc) / denom, -1.0, 1.0))


def peak(signal: np.ndarray) -> float:
    if signal.size == 0:
        return 0.0
    return float(np.max(np.abs(signal)))


def rms(signal: np.ndarray) -> float:
    if signal.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(signal, dtype=np.float64))))


def compute_stats(processed_lr: np.ndarray,
                  region: tuple[int, int] | None = None) -> Stats:
    """对处理后立体声计算区间统计（region 为 None 时取整段）。"""
    if region is not None:
        start, end = region
        processed_lr = processed_lr[start:end]
    left, right = processed_lr[:, 0], processed_lr[:, 1]
    mono = (left + right) * 0.5
    return Stats(
        correlation=correlation(left, right),
        peak_left=peak(left),
        peak_right=peak(right),
        mono_peak=peak(mono),
        mono_rms=rms(mono),
    )


def to_dbfs(value: float) -> float:
    """线性幅度 -> dBFS；0 返回 -inf。"""
    if value <= 0.0:
        return float("-inf")
    return 20.0 * math.log10(value)


def format_dbfs(value: float) -> str:
    db = to_dbfs(value)
    if math.isinf(db):
        return "-∞ dBFS"
    return f"{db:.2f} dBFS"


# ---------------------------------------------------------------- 测试信号生成

def _tone(freq: float, n: int, sr: int, amp: float) -> np.ndarray:
    t = np.arange(n) / sr
    sig = amp * np.sin(2.0 * np.pi * freq * t)
    fade = min(int(sr * 0.005), n // 4)  # 5ms 淡入淡出，避免边缘突变
    if fade > 0:
        env = np.ones(n)
        env[:fade] = np.linspace(0.0, 1.0, fade)
        env[-fade:] = np.linspace(1.0, 0.0, fade)
        sig *= env
    return sig


def make_in_phase_signal(sr: int = 48000, duration: float = 1.0) -> np.ndarray:
    """同相信号：L == R，能量全部在中间。"""
    n = int(sr * duration)
    tone = _tone(440.0, n, sr, 0.5)
    return np.column_stack((tone, tone.copy()))


def make_antiphase_signal(sr: int = 48000, duration: float = 1.0) -> np.ndarray:
    """反相信号：R == -L，能量全部在侧边，单声道合听抵消为 0。"""
    n = int(sr * duration)
    tone = _tone(660.0, n, sr, 0.5)
    return np.column_stack((tone, -tone))


def make_distinct_ms_signal(sr: int = 48000,
                            duration: float = 1.0) -> np.ndarray:
    """中侧内容不同的信号：M 是 330Hz，S 是 880Hz，L=M+S、R=M-S。"""
    n = int(sr * duration)
    mid = _tone(330.0, n, sr, 0.5)
    side = _tone(880.0, n, sr, 0.35)
    return ms_to_lr(mid, side)


def make_mono_signal(sr: int = 48000, duration: float = 1.0) -> np.ndarray:
    """单声道信号（形状 (n,1)），用于提示逻辑验证。"""
    n = int(sr * duration)
    return _tone(440.0, n, sr, 0.5)[:, np.newaxis]
