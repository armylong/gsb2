"""立体声复合信号(MPX)实验 —— 纯 DSP 核心。

信号模型(参考 FM 立体声广播的基带复用结构, 全部在计算机内数字化完成, 不接任何发射设备):

    复合信号 mpx(t) = 0.5*(L+R)          和信号  (0~15 kHz, 普通单声道只读这一段)
                    + 0.5*(L-R)*cos(2π*38kHz*t)   差信号对 38 kHz 副载波做抑制载波调幅
                    + 0.1*cos(2π*19kHz*t)         19 kHz 导频(固定音, 用来识别立体声并恢复副载波)

采样率:
    音频层 48 kHz, 复合层 192 kHz(整数 4 倍上采样), 奈奎斯特 96 kHz,
    足以表示 23~53 kHz 的差信号边带与 19 kHz 导频。

注意: 解码侧只允许拿到复合信号 mpx 与噪声/相位参数, 原始左右声道仅用于事后
指标比对, 任何播放与导出都来自解码输出, 不直接播放输入。
"""

from __future__ import annotations

import wave
from dataclasses import dataclass, field

import numpy as np
from scipy import signal
from scipy.io import wavfile

# ---------------------------------------------------------------- 常量

AUDIO_FS = 48_000          # 音频层采样率 Hz
MPX_FS = 192_000           # 复合信号采样率 Hz
UP = MPX_FS // AUDIO_FS    # 整数上采样倍数 = 4

PILOT_F = 19_000.0         # 导频(固定音)频率
SUBC_F = 38_000.0          # 副载波频率 = 2 倍导频
AUDIO_CUTOFF = 15_000.0    # 和/差支路低通截止
PILOT_AMP = 0.1            # 导频幅度
PILOT_BAND = (18_500.0, 19_500.0)   # 导频带通范围
PILOT_LOCK_RATIO = 0.03    # 导频幅度 / 复合信号 RMS 超过该值才判定锁定

UP_TAPS = 65               # 4 倍上采样抗混叠滤波器(奇数, 群延迟 32 个高速样本)
BASE_TAPS = 505            # 和差支路低通滤波器(奇数, 群延迟 252 个高速样本)
PILOT_TAPS = 2049          # 导频带通滤波器(仅用于把导频分离出来看频谱)

# 整条解码链路(上采样抗混叠 FIR + fftconvolve same 截断 + 基带 LPF + 4 倍降采样)
# 相对原始音频的净群延迟, 由冲激实测确定 = (UP_TAPS-1)/2/UP = 8 个音频样本。
# 两条解码支路(和、差)共用同一组低通系数, 净延迟完全相同, 彼此天然对齐。
DELAY_AUDIO = (UP_TAPS - 1) // 2 // UP   # = 8
EDGE_MARGIN = max(DELAY_AUDIO, (BASE_TAPS - 1) // 2 // UP)  # 首尾瞬态剔除取较大者 63


# ---------------------------------------------------------------- 滤波器(只构造一次)

def _up_filter() -> np.ndarray:
    # 归一化截止 1/UP -> 高速率下 24 kHz, 乘 UP 补偿上采样插零带来的幅度
    return signal.firwin(UP_TAPS, 1.0 / UP, window="blackmanharris") * UP


def _base_lpf() -> np.ndarray:
    return signal.firwin(BASE_TAPS, AUDIO_CUTOFF, window="blackmanharris", fs=MPX_FS)


def _pilot_bpf() -> np.ndarray:
    return signal.firwin(
        PILOT_TAPS, PILOT_BAND, pass_zero=False, window="blackmanharris", fs=MPX_FS
    )


def _center_kernel(h: np.ndarray) -> np.ndarray:
    """保留 FIR 核原样。

    fftconvolve(mode='same') 取完整卷积的前 N 个样本: 对上采样级输出
    upfirdn 再做 same 卷积时, 基带 LPF 的 (len-1)/2 个前置样本被截掉,
    恰好与降采样索引 [::4] 的相位抵消。整条链路相对原始音频的净群延迟
    用冲激实测为 (UP_TAPS-1)/2/UP = 8 个音频样本, 见 DELAY_AUDIO。
    和、差两条支路用同一个核, 净延迟相同, 彼此天然对齐。
    """
    return h


_UP_H = _up_filter()
_BASE_H = _center_kernel(_base_lpf())
_PILOT_H = _center_kernel(_pilot_bpf())


# ---------------------------------------------------------------- 数据结构

@dataclass
class PilotInfo:
    """导频检测结果。"""
    locked: bool
    amplitude: float          # 相关法估计出的导频幅度
    rms_ratio: float          # 导频幅度 / 复合信号 RMS
    phase: float              # 导频初相 rad
    measured_freq: float      # 频谱峰值法读出的导频频率 Hz


@dataclass
class DecodeResult:
    """一次解码的全部产物。所有播放/导出只能使用这里的数组。"""
    locked: bool
    fallback: bool            # True = 没找到导频(或强制单声道), 已退回单声道
    pilot: PilotInfo
    noise_sigma: float
    phase_offset_deg: float
    # 192 kHz 复合层信号, 供单独看频谱
    mpx: np.ndarray
    sum_mpx: np.ndarray       # 和支路低通后(192k)
    diff_mpx: np.ndarray      # 差支路相干解调并低通后(192k)
    pilot_mpx: np.ndarray     # 带通分离出的导频(192k)
    # 48 kHz 音频层解码输出(已按群延迟与输入对齐, 长度与输入一致)
    left: np.ndarray
    right: np.ndarray
    mono: np.ndarray
    n_audio: int
    delay_audio: int = DELAY_AUDIO
    edge_margin: int = EDGE_MARGIN
    messages: list[str] = field(default_factory=list)


# ---------------------------------------------------------------- 工具函数

def _as_float(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    if np.issubdtype(x.dtype, np.integer):
        x = x / max(abs(np.iinfo(x.dtype).min), np.iinfo(x.dtype).max)
    return x


def _resample_to_48k(x: np.ndarray, fs: int) -> np.ndarray:
    if fs == AUDIO_FS:
        return x.astype(np.float64, copy=False)
    from math import gcd

    g = gcd(int(fs), AUDIO_FS)
    return signal.resample_poly(x, AUDIO_FS // g, int(fs) // g)


def _upsample4(x: np.ndarray, n_target: int) -> np.ndarray:
    """4 倍上采样, 输出截到 4*n_target, 群延迟 32 个高速样本(已知且固定)。"""
    y = signal.upfirdn(_UP_H, x, up=UP)
    return y[: n_target * UP]


def tone_level(x: np.ndarray, fs: float, freq: float, t_skip: float = 0.1) -> float:
    """相关法读出某一频率分量的幅度(抗噪、可读导频/副载波泄漏)。"""
    n0 = int(t_skip * fs)
    n1 = len(x) - int(t_skip * fs)
    if n1 <= n0 + 16:
        n0, n1 = 0, len(x)
    n = np.arange(n0, n1)
    c = np.cos(2 * np.pi * freq * n / fs)
    s = np.sin(2 * np.pi * freq * n / fs)
    a = 2.0 * np.mean(x[n0:n1] * c)
    b = 2.0 * np.mean(x[n0:n1] * s)
    return float(np.hypot(a, b))


def spectrum_db(x: np.ndarray, fs: float) -> tuple[np.ndarray, np.ndarray]:
    """Welch 功率谱, 返回频率与 dB(归一直方幅度, 0 dB 满刻度)。"""
    nperseg = min(8192, 2 ** int(np.log2(max(16, len(x) // 4))))
    f, p = signal.welch(x, fs=fs, nperseg=nperseg, scaling="spectrum")
    return f, 10.0 * np.log10(p + 1e-20)


def rms_db(x: np.ndarray, margin: int = 0) -> float:
    y = x[margin:-margin] if len(x) > 2 * margin else x
    return 20.0 * np.log10(float(np.sqrt(np.mean(y**2))) + 1e-20)


def reconstruction_snr(orig: np.ndarray, dec: np.ndarray, margin: int,
                       floor_db: float = -90.0) -> float:
    """重建信噪比 dB, 首尾 margin 个样本(滤波瞬态)不参与计算。

    参考通道能量接近零(如纯左信号的右路)时封顶到 floor_db, 避免出现
    -300 dB 这类没有物理意义的读数。
    """
    a = orig[margin:-margin]
    b = dec[margin:-margin]
    ref = np.sqrt(np.mean(a**2))
    if ref < 1e-8:
        return floor_db
    err = np.sqrt(np.mean((a - b) ** 2))
    return max(floor_db, 20.0 * np.log10(ref / (err + 1e-20)))


def separation_db(left: np.ndarray, right: np.ndarray, margin: int) -> float:
    """声道分离度 dB: 两路 RMS 之比(纯左/纯右测试时直接反映串扰)。"""
    l = np.sqrt(np.mean(left[margin:-margin] ** 2))
    r = np.sqrt(np.mean(right[margin:-margin] ** 2))
    return 20.0 * np.log10((max(l, r) + 1e-20) / (min(l, r) + 1e-20))


def channel_energy_balance(in_left: np.ndarray, in_right: np.ndarray,
                           margin: int) -> float:
    """左右输入能量比 dB: 纯左/纯右为很大正值, 同相为 0, 双主声道接近 0。"""
    il = np.sqrt(np.mean(in_left[margin:-margin] ** 2)) + 1e-20
    ir = np.sqrt(np.mean(in_right[margin:-margin] ** 2)) + 1e-20
    return abs(20.0 * np.log10(il / ir))


def crosstalk_db(in_left: np.ndarray, in_right: np.ndarray,
                 dec_left: np.ndarray, dec_right: np.ndarray, margin: int) -> float:
    """按输入能量归属定义的串扰/分离度 dB(正值越大越好)。

    一路输入为主(能量比 > 20 dB) -> 另一路解码输出就是串扰;
    否则为同相/双主声道场景, 改为衡量解码两路的差异电平(理想值很大)。
    """
    il = np.sqrt(np.mean(in_left[margin:-margin] ** 2))
    ir = np.sqrt(np.mean(in_right[margin:-margin] ** 2))
    if max(il, ir) <= 1e-9 or channel_energy_balance(in_left, in_right, margin) < 20.0:
        ref = np.sqrt(np.mean(dec_left[margin:-margin] ** 2)) + 1e-20
        diff = np.sqrt(
            np.mean((dec_left[margin:-margin] - dec_right[margin:-margin]) ** 2)
        )
        return 20.0 * np.log10(ref / (diff + 1e-20))
    if il > ir:
        main_, leak = dec_left, dec_right
    else:
        main_, leak = dec_right, dec_left
    m = np.sqrt(np.mean(main_[margin:-margin] ** 2)) + 1e-20
    k = np.sqrt(np.mean(leak[margin:-margin] ** 2))
    return 20.0 * np.log10(m / (k + 1e-20))


# ---------------------------------------------------------------- 测试信号与 WAV 输入

def _fade_env(n: int, fs: int, fade_ms: float = 10.0) -> np.ndarray:
    env = np.ones(n)
    k = int(fs * fade_ms / 1000.0)
    if k > 0:
        ramp = 0.5 * (1 - np.cos(np.pi * np.arange(k) / k))
        env[:k] = ramp
        env[-k:] = ramp[::-1]
    return env


def _tone(n: int, fs: int, freq: float, amp: float = 0.7) -> np.ndarray:
    t = np.arange(n) / fs
    return amp * np.sin(2 * np.pi * freq * t) * _fade_env(n, fs)


def _pulse(n: int, fs: int, at_sec: float, width_ms: float = 2.0) -> np.ndarray:
    """升余弦短脉冲, 用于检验解码前后的位置同步。"""
    out = np.zeros(n)
    center = int(at_sec * fs)
    half = max(1, int(fs * width_ms / 1000.0 / 2))
    i = np.arange(-half, half + 1)
    out[center + i] = 0.9 * 0.5 * (1 + np.cos(np.pi * i / half))
    return out


TEST_KINDS = ("pure_left", "pure_right", "in_phase", "split", "pulses")
TEST_LABELS = {
    "pure_left": "纯左(仅左声道 1 kHz)",
    "pure_right": "纯右(仅右声道 1 kHz)",
    "in_phase": "同相(左右完全相同)",
    "split": "左右可区分(左 440 Hz / 右 880 Hz)",
    "pulses": "定位脉冲(左 0.25 s / 右 0.75 s)",
}


def make_test_signal(kind: str, duration: float = 2.0, fs: int = AUDIO_FS):
    """生成立体声测试信号, 返回 (left, right, fs)。"""
    n = int(duration * fs)
    env = _fade_env(n, fs)
    if kind == "pure_left":
        return _tone(n, fs, 1000), np.zeros(n), fs
    if kind == "pure_right":
        return np.zeros(n), _tone(n, fs, 1000), fs
    if kind == "in_phase":
        y = _tone(n, fs, 1000)
        return y, y.copy(), fs
    if kind == "split":
        return _tone(n, fs, 440), _tone(n, fs, 880), fs
    if kind == "pulses":
        return _pulse(n, fs, 0.25), _pulse(n, fs, 0.75), fs
    raise ValueError(f"未知测试信号类型: {kind}")  # pragma: no cover


def load_wav(path: str):
    """读入 WAV, 统一为 float64 立体声 + 重采样到 48 kHz。返回 (left, right, fs)。"""
    with wave.open(path, "rb") as wf:
        sampwidth = wf.getsampwidth()
    fs_in, data = wavfile.read(path)
    data = data.astype(np.float64, copy=False)
    if data.ndim == 1:
        data = np.column_stack([data, data])
    # 整数归一化; 24 bit WAV 会被 scipy 装进 int32, 按实际位宽定标
    if data.dtype.kind == "i":
        bits = sampwidth * 8
        data = data / float(2 ** (bits - 1))
    left = _resample_to_48k(data[:, 0], fs_in)
    right = _resample_to_48k(data[:, 1], fs_in)
    n = min(len(left), len(right))
    peak = max(np.max(np.abs(left[:n])), np.max(np.abs(right[:n])), 1e-12)
    if peak > 1.0:  # 防止外部文件削顶
        left, right = left / peak, right / peak
    return left[:n], right[:n], AUDIO_FS


def save_wav(path: str, left: np.ndarray, right: np.ndarray | None,
             fs: int = AUDIO_FS, guard_db: float = 1.0) -> float:
    """把解码输出写成 16 bit PCM WAV(立体声或单声道), 返回所用峰值增益。"""
    if right is None:
        y = np.column_stack([left, left])
    else:
        n = min(len(left), len(right))
        y = np.column_stack([left[:n], right[:n]])
    peak = float(np.max(np.abs(y))) if len(y) else 0.0
    gain = (10.0 ** (-guard_db / 20.0)) / peak if peak > 1e-12 else 1.0
    pcm = np.clip(y * gain, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype(np.int16)
    wavfile.write(path, fs, pcm)
    return gain


# ---------------------------------------------------------------- 编码

def encode(left: np.ndarray, right: np.ndarray, fs_in: int = AUDIO_FS,
           *, include_pilot: bool = True):
    """把左右声道编码成一条 192 kHz 复合数字信号。

    返回 (mpx, left48, right48);后两者只用于事后指标比对, 不参与解码播放。
    """
    left = _as_float(left)
    right = _as_float(right)
    if fs_in != AUDIO_FS:
        left = _resample_to_48k(left, fs_in)
        right = _resample_to_48k(right, fs_in)
    n = min(len(left), len(right))
    left, right = left[:n], right[:n]

    n_mpx = n * UP
    lu = _upsample4(left, n)
    ru = _upsample4(right, n)
    t = np.arange(n_mpx) / MPX_FS

    sum_sig = lu + ru                       # L+R
    diff_sig = lu - ru                      # L-R
    mpx = 0.5 * sum_sig + 0.5 * diff_sig * np.cos(2 * np.pi * SUBC_F * t)
    if include_pilot:
        mpx = mpx + PILOT_AMP * np.cos(2 * np.pi * PILOT_F * t)
    return mpx, left.copy(), right.copy()


def add_noise(mpx: np.ndarray, db_rel_rms: float, rng: np.random.Generator) -> np.ndarray:
    """叠加高斯白噪声, 强度以相对复合信号 RMS 的 dB 表示(如 -20 dB)。"""
    if db_rel_rms >= 40:  # 视为不加噪
        return mpx.copy()
    sigma = float(np.sqrt(np.mean(mpx**2))) * 10.0 ** (db_rel_rms / 20.0)
    return mpx + rng.normal(0.0, sigma, size=mpx.shape)


# ---------------------------------------------------------------- 导频检测

def detect_pilot(mpx: np.ndarray) -> PilotInfo:
    """相关法检测 19 kHz 导频: 长窗积分抗噪声, 同时给出初相与锁定状态。"""
    n0 = int(0.1 * MPX_FS)
    n1 = len(mpx) - int(0.1 * MPX_FS)
    if n1 - n0 < 4096:
        n0, n1 = 0, len(mpx)
    n = np.arange(n0, n1)
    c = np.cos(2 * np.pi * PILOT_F * n / MPX_FS)
    s = np.sin(2 * np.pi * PILOT_F * n / MPX_FS)
    seg = mpx[n0:n1]
    a = 2.0 * np.mean(seg * c)
    b = 2.0 * np.mean(seg * s)
    amp = float(np.hypot(a, b))
    phase = float(np.arctan2(b, a))
    rms = float(np.sqrt(np.mean(mpx**2))) + 1e-20
    # 频谱峰值法复核频率(只在 18~20 kHz 窗内找峰)
    f, psd = spectrum_db(mpx, MPX_FS)
    band = (f >= 18_000) & (f <= 20_000)
    measured = float(f[band][np.argmax(psd[band])]) if np.any(band) else PILOT_F
    return PilotInfo(
        locked=(amp / rms) > PILOT_LOCK_RATIO,
        amplitude=amp,
        rms_ratio=amp / rms,
        phase=phase,
        measured_freq=measured,
    )


# ---------------------------------------------------------------- 解码

def _align_to_audio(y_mpx: np.ndarray, n_audio: int) -> np.ndarray:
    """复合层信号降采样到 48k, 并按已知群延迟左移, 使输出[n]对齐输入[n]。"""
    y48 = y_mpx[::UP]
    out = np.zeros(n_audio)
    src = y48[DELAY_AUDIO: DELAY_AUDIO + n_audio]
    k = min(len(src), n_audio)
    out[:k] = src[:k]
    return out


def decode(mpx: np.ndarray, n_audio: int, *,
           phase_offset_deg: float = 0.0,
           force_mono: bool = False,
           noise_sigma: float = 0.0) -> DecodeResult:
    """从复合信号解码。

    单声道解码: 只低通取出 0~15 kHz 和信号, 完全忽略 19 kHz 以上内容。
    立体声解码: 锁导频 -> 倍频恢复 38 kHz 相干副载波(可加固定相位偏移)
              -> 相干解调差信号 -> L = S+D, R = S-D。
    找不到导频(或 force_mono)时明确退回单声道: L=R=mono, fallback=True。
    """
    messages: list[str] = []
    pilot = detect_pilot(mpx)

    # 和支路: 两条解码路径共用, 与差支路同一组滤波器系数 => 群延迟一致
    sum_mpx = signal.fftconvolve(mpx, _BASE_H, mode="same")
    pilot_mpx = signal.fftconvolve(mpx, _PILOT_H, mode="same")
    mono = _align_to_audio(sum_mpx, n_audio)

    fallback = force_mono or (not pilot.locked)
    if force_mono:
        messages.append("已强制单声道模式: 跳过导频与差信号解调。")
    elif not pilot.locked:
        messages.append(
            f"未检测到 19 kHz 导频(测得幅度/RMS={pilot.rms_ratio:.4f},"
            f" 低于锁定门限 {PILOT_LOCK_RATIO}): 立体声解码退回单声道, L=R=和信号。"
        )

    if fallback:
        diff_mpx = np.zeros_like(mpx)
        left = mono.copy()
        right = mono.copy()
    else:
        # 导频初相倍频 => 38 kHz 副载波相位, 再叠加用户给定的固定相位偏移
        phi = 2.0 * pilot.phase + np.deg2rad(phase_offset_deg)
        t = np.arange(len(mpx)) / MPX_FS
        subcarrier = np.cos(2 * np.pi * SUBC_F * t + phi)
        # 相干解调: 乘本地副载波后 ×2 补偿 cos² 的 1/2, 再用与和支路相同的低通
        diff_mpx = 2.0 * signal.fftconvolve(mpx * subcarrier, _BASE_H, mode="same")
        d48 = _align_to_audio(diff_mpx, n_audio)
        left = mono + d48
        right = mono - d48
        if abs(phase_offset_deg) > 1e-9:
            messages.append(
                f"副载波附加相位偏移 {phase_offset_deg:+.1f}°: 差信号按 cos(Δφ) 衰减,"
                " 左右声道发生串扰。"
            )

    return DecodeResult(
        locked=pilot.locked,
        fallback=fallback,
        pilot=pilot,
        noise_sigma=float(noise_sigma),
        phase_offset_deg=float(phase_offset_deg),
        mpx=np.asarray(mpx, dtype=np.float64),
        sum_mpx=sum_mpx,
        diff_mpx=diff_mpx,
        pilot_mpx=pilot_mpx,
        left=left,
        right=right,
        mono=mono,
        n_audio=n_audio,
        messages=messages,
    )
