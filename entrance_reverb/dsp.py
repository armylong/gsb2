"""核心 DSP：wav 读写、混响响应（IR）匹配、前置混响渲染、测试信号生成。

设计约定
========
1. 内部统一使用 float64、幅值范围 [-1, 1]，形状 (N, C)，C 取 1 或 2。
2. "前置混响" 的构造方式：把混响响应 **逐声道反转** 后，让它的尾巴（原 IR 的
   起头）精准对齐到用户指定的干声起音点；起音之前湿声做余弦淡出到 0。
3. 干声在输出中的位置只可能被"向前留出"（头部补静音 prepend），干声自身的
   任何采样都不会向后移动——目标起音相对干声内容始终是同一采样。
4. 试听和 wav 导出走同一个 render 函数、同一套 PCM16 量化，保证幅值一致。
"""
from __future__ import annotations

import math
import os
from dataclasses import dataclass, field
from fractions import Fraction

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, lfilter, resample_poly

# ---------------------------------------------------------------------------
# wav 读写
# ---------------------------------------------------------------------------


def read_wav(path: str) -> tuple[int, np.ndarray]:
    """读取 wav，返回 (sample_rate, float64 波形 (N, C))。

    支持 PCM uint8/int16/int32 与 float WAV。超过立体声的文件只取前两声道。
    """
    sr, data = wavfile.read(path)
    data = np.asarray(data)
    if data.ndim == 1:
        data = data[:, None]
    else:
        data = data[:, : min(2, data.shape[1])]

    kind = data.dtype.kind
    if kind == "f":
        audio = data.astype(np.float64)
    elif data.dtype == np.uint8:
        audio = (data.astype(np.float64) - 128.0) / 128.0
    elif kind == "i":
        max_abs = float(2 ** (8 * data.dtype.itemsize - 1))
        audio = data.astype(np.float64) / max_abs
    else:
        raise ValueError(f"暂不支持的 wav 采样格式: {data.dtype}")
    return int(sr), np.ascontiguousarray(audio)


def to_pcm16(audio: np.ndarray) -> np.ndarray:
    """float [-1,1] -> int16，试听与导出共用同一量化（保证幅值一致）。"""
    clipped = np.clip(audio, -1.0, 1.0)
    return np.round(clipped * 32767.0).astype(np.int16)


def write_wav(path: str, sr: int, audio: np.ndarray) -> None:
    """按 int16 PCM 写 wav；单声道写 (N,)，立体声写 (N, 2)。"""
    pcm = to_pcm16(audio)
    if pcm.shape[1] == 1:
        pcm = pcm[:, 0]
    wavfile.write(path, sr, pcm)


# ---------------------------------------------------------------------------
# 内置混响响应
# ---------------------------------------------------------------------------


def builtin_ir(kind: str, sr: int, rng: np.random.Generator | None = None) -> np.ndarray:
    """生成两种内置立体声 IR，返回 (L, 2) float64。

    kind:
      "reflections" —— 短反射：稀疏多 tap 衰减脉冲，约 0.25 s；
      "decay"       —— 一段衰减：噪声经指数包络的长尾，约 1.2 s。
    """
    rng = rng or np.random.default_rng(7)
    if kind == "reflections":
        length = int(0.25 * sr)
        ir = np.zeros((length, 2))
        # (延迟秒, 左增益, 右增益)；Haas 式左右错位，形成明显的早期反射
        taps = [
            (0.000, 0.85, 0.00),
            (0.011, 0.00, 0.70),
            (0.023, 0.42, 0.30),
            (0.041, 0.26, 0.34),
            (0.063, 0.18, 0.12),
            (0.090, 0.10, 0.15),
            (0.130, 0.07, 0.05),
            (0.180, 0.04, 0.03),
        ]
        for delay, gl, gr in taps:
            idx = int(delay * sr)
            n = max(1, int(0.004 * sr))  # 每个 tap 是一小段噪声爆发，而非裸脉冲
            burst = rng.standard_normal(n) * np.hanning(n)
            seg = slice(idx, min(length, idx + n))
            m = seg.stop - seg.start
            ir[seg, 0] += burst[:m] * gl
            ir[seg, 1] += burst[:m] * gr
    elif kind == "decay":
        length = int(1.2 * sr)
        t = np.arange(length) / sr
        # -60dB 约 1.0 s 的指数衰减；左右用独立噪声 + 轻微时间差
        env = np.exp(-np.log(1000.0) * t / 1.0)
        ir = np.empty((length, 2))
        ir[:, 0] = rng.standard_normal(length) * env
        shifted = np.roll(rng.standard_normal(length), int(0.006 * sr))
        ir[:, 1] = shifted * env
        ir[: int(0.006 * sr), 1] = 0.0
    else:
        raise ValueError(f"未知内置 IR 类型: {kind!r}（应为 reflections / decay）")
    peak = np.max(np.abs(ir))
    if peak > 0:
        ir = ir / peak * 0.9
    return ir


# ---------------------------------------------------------------------------
# IR 与干声的声道 / 采样率匹配
# ---------------------------------------------------------------------------


def _resample(audio: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    """按整数比多相重采样，形状 (N, C)。"""
    if sr_in == sr_out:
        return audio
    frac = Fraction(sr_out, sr_in)
    up, down = frac.numerator, frac.denominator
    return np.column_stack(
        [resample_poly(audio[:, c], up, down) for c in range(audio.shape[1])]
    )


def match_ir_to_dry(
    ir: np.ndarray, ir_sr: int, dry_sr: int, dry_channels: int
) -> tuple[np.ndarray, list[str]]:
    """把任意 IR 匹配成与干声同采样率、同声道数的 (L, C)。

    采用的匹配规则（同时以字符串列表返回，界面会原样展示）：
    R1 采样率不同 -> 多相重采样到干声采样率；
    R2 干声单声道、IR 立体声 -> 左右取均值折叠为单声道；
    R3 干声立体声、IR 单声道 -> 同一份 IR 复制到左右；
    R4 IR 多于两声道 -> 只取前两声道；
    R5 左右有效长度不同（尾部全零长度不同）-> 按最长声道统一，短声道尾部补零，
       即两个声道共用同一个对齐基准（反转后尾巴同时抵达起音点）。
    """
    messages: list[str] = []
    if ir.ndim == 1:
        ir = ir[:, None]
    if ir.shape[1] > 2:
        messages.append(f"R4: 响应有 {ir.shape[1]} 声道，只取前两声道。")
        ir = ir[:, :2]
    if ir_sr != dry_sr:
        messages.append(f"R1: 响应采样率 {ir_sr}Hz 与干声 {dry_sr}Hz 不同，已重采样。")
        ir = _resample(ir, ir_sr, dry_sr)
    if dry_channels == 1 and ir.shape[1] == 2:
        messages.append("R2: 干声为单声道，立体声响应左右取均值折叠为单声道。")
        ir = ir.mean(axis=1, keepdims=True)
    elif dry_channels == 2 and ir.shape[1] == 1:
        messages.append("R3: 干声为立体声，单声道响应复制到左右两声道。")
        ir = np.repeat(ir, 2, axis=1)

    # R5：以各声道最后一个有效（超过自身峰值 1e-5）采样为准统一长度。
    # 用相对阈值而非绝对 1e-9，避免重采样数值噪声把静音尾误判成有效内容；
    # 全零声道（如单声道复制前的空轨）不参与长度决定。
    eff_lens = []
    for c in range(ir.shape[1]):
        peak_c = np.max(np.abs(ir[:, c]))
        if peak_c <= 1e-9:
            eff_lens.append(0)
            continue
        nz = np.flatnonzero(np.abs(ir[:, c]) > peak_c * 1e-5)
        eff_lens.append(int(nz[-1]) + 1 if nz.size else 0)
    nonzero_lens = [n for n in eff_lens if n > 0]
    L = max(nonzero_lens) if nonzero_lens else ir.shape[0]
    if len({n for n in eff_lens if n > 0}) > 1:
        messages.append(
            "R5: 左右响应有效长度不同（"
            + ", ".join(f"{n} 采样" for n in eff_lens)
            + f"），按最长 {L} 采样统一，短声道尾部补零。"
        )
    if ir.shape[0] < L:  # 理论上不会发生，防御性处理
        ir = np.pad(ir, ((0, L - ir.shape[0]), (0, 0)))
    return np.ascontiguousarray(ir[:L]), messages


# ---------------------------------------------------------------------------
# 渲染
# ---------------------------------------------------------------------------


@dataclass
class RenderParams:
    """渲染参数。lead_ms / fade_ms 均为毫秒；wet_gain 为线性增益。"""

    lead_ms: float = 200.0
    fade_ms: float = 30.0
    wet_gain: float = 1.0


@dataclass
class RenderResult:
    """一次渲染的全部分轨与对齐信息。三个音频数组等长、同采样率。"""

    dry: np.ndarray          # 干声分轨（前置区为静音）
    wet: np.ndarray          # 前置湿声分轨
    mix: np.ndarray          # 合成 = dry + wet
    sr: int
    prepend: int             # 头部补静音的采样数（新增时长）
    onset_index: int         # 目标起音在输出中的采样位置 = prepend + 用户指定位置
    fade_samples: int
    ir_length: int
    clip: bool = False
    clip_count: int = 0
    messages: list[str] = field(default_factory=list)

    @property
    def total_samples(self) -> int:
        return self.dry.shape[0]

    @property
    def added_seconds(self) -> float:
        return self.prepend / self.sr


def _cos_equal_power(kind: str, n: int) -> np.ndarray:
    """等功率余弦淡变曲线。

    kind="out"：1 -> 0（湿声在起音前淡出）；kind="in"：0 -> 1（干声淡入）。
    两者平方和恒为 1，交界不会出现音量凹陷。
    """
    if n <= 0:
        return np.empty(0)
    x = np.arange(n) / n
    if kind == "out":
        return np.cos(x * math.pi / 2.0)
    return np.sin(x * math.pi / 2.0)


def render_reverse_reverb(
    dry_audio: np.ndarray,
    sr: int,
    onset_sample: int,
    ir: np.ndarray,
    params: RenderParams,
) -> RenderResult:
    """渲染前置混响。

    时间线（输出数组坐标）::

        0 .......... prepend (= onset_index - onset_sample)
        |  湿声前置段  |<-- 起音点 onset_index -->| 干声原样延续 ...
        |             |  交界淡变(起音前 fade)   |

    干声内容一个采样都不移动：onset_sample 处的干声采样永远落在输出的
    onset_index = onset_sample + prepend 位置，prepend 只可能 >= 0。
    """
    dry_audio = np.asarray(dry_audio, dtype=np.float64)
    if dry_audio.ndim == 1:
        dry_audio = dry_audio[:, None]
    n_dry, ch = dry_audio.shape
    L = ir.shape[0]
    if ir.shape[1] != ch:
        raise ValueError("render 前应先用 match_ir_to_dry 统一声道数")

    lead = max(0, int(round(params.lead_ms * sr / 1000.0)))
    fade = min(max(0, int(round(params.fade_ms * sr / 1000.0))), lead)

    # 需要的前置空间；不够就在头部补静音（绝不后挪干声）
    prepend = max(0, lead - onset_sample)
    onset_index = onset_sample + prepend
    wet_start = onset_index - lead
    total = max(n_dry + prepend, wet_start + lead)

    wet = np.zeros((total, ch), dtype=np.float64)
    dry_out = np.zeros_like(wet)
    dry_out[prepend : prepend + n_dry] = dry_audio

    # 反转后的 IR：原 IR 的起头变成尾巴，正好落在起音点
    rev = ir[::-1, :]
    if lead >= L:
        wet_seg = rev.copy()
        place = onset_index - L  # lead 比 IR 长：湿声前面自然留静音
    else:
        wet_seg = rev[L - lead :, :].copy()  # lead 更短：只取反转 IR 的最后 lead 个
        place = wet_start

    # 湿声淡入（lead 被截断时，切掉的是反转 IR 最安静的头部；短淡入防爆音）
    fade_in = min(int(0.005 * sr), wet_seg.shape[0] // 2)
    if fade_in > 1:
        wet_seg[:fade_in] *= _cos_equal_power("in", fade_in)[:, None]
    # 交界淡变：淡变窗永远对齐湿声段结尾（即起音点），注意 wet_seg 可能短于 lead
    fade_eff = min(fade, wet_seg.shape[0])
    if fade_eff > 0:
        wet_seg[wet_seg.shape[0] - fade_eff :] *= (
            _cos_equal_power("out", fade_eff)[:, None]
        )
    wet_seg *= params.wet_gain

    end = min(total, place + wet_seg.shape[0])
    wet[place:end] = wet_seg[: end - place]

    # 干声淡入仅作用在交界窗内、且只放大本来就有的干声（前置区仍是零）
    if fade > 0:
        win0, win1 = onset_index - fade, onset_index
        gain_in = _cos_equal_power("in", fade)
        region = dry_out[win0:win1]
        dry_out[win0:win1] = region * gain_in[:, None]
        # 交界窗内仍保留湿声淡出层；窗外干声原样、湿声为零

    mix = dry_out + wet
    over = np.abs(mix) > 1.0
    clip = bool(np.any(over))
    clip_count = int(np.sum(over))

    messages = [
        f"起音点位于输出第 {onset_index} 采样（{onset_index / sr:.3f} s）。",
        f"头部前置 {prepend} 采样（{prepend / sr:.3f} s 新增时长），干声未后移。",
        f"湿声前置段 {lead} 采样，IR 长 {L} 采样，交界淡变 {fade} 采样。",
    ]
    if lead < L:
        messages.append(
            f"提前量 {lead} 采样短于响应长度 {L}：只采用反转响应的最后 {lead} 个采样。"
        )
    return RenderResult(
        dry=dry_out,
        wet=wet,
        mix=mix,
        sr=sr,
        prepend=prepend,
        onset_index=onset_index,
        fade_samples=fade,
        ir_length=L,
        clip=clip,
        clip_count=clip_count,
        messages=messages,
    )


# ---------------------------------------------------------------------------
# 程序生成的两次击掌验证信号
# ---------------------------------------------------------------------------


def _synth_clap(rng: np.random.Generator, n: int) -> np.ndarray:
    """合成一次短促击掌：宽带噪声 + 快速指数衰减。"""
    t = np.arange(n)
    env = np.exp(-t / max(1.0, n * 0.12))
    return rng.standard_normal(n) * env


def generate_test_claps(
    out_dir: str, sr: int = 48000, rng: np.random.Generator | None = None
) -> dict[str, str]:
    """生成带标记的两次击掌立体声 wav，返回写出的文件路径字典。

    布局（故意把第一击放在很靠近文件头的 0.10 s 处，用来验证"向前留出"）：
      击掌 1：0.10 s（默认干声起音标记）
      击掌 2：1.20 s
      全长  ：2.00 s
    另外写出 clap_markers.csv（标记采样位置与时间）。
    """
    rng = rng or np.random.default_rng(42)
    os.makedirs(out_dir, exist_ok=True)
    total = int(2.0 * sr)
    audio = np.zeros((total, 2))
    clap_n = int(0.05 * sr)
    marks = []
    for i, at_sec in enumerate((0.10, 1.20), start=1):
        start = int(at_sec * sr)
        base = _synth_clap(rng, clap_n)
        b, a = butter(4, 1500.0 / (sr / 2.0), btype="high")
        base = lfilter(b, a, base)
        # 轻微左右错位，模拟立体声击掌
        audio[start : start + clap_n, 0] += base * 0.9
        d = int(0.002 * sr)
        audio[start + d : start + d + clap_n, 1] += base * 0.85
        marks.append((i, start, at_sec))
    peak = np.max(np.abs(audio))
    audio = audio / peak * 0.8

    wav_path = os.path.join(out_dir, "claps.wav")
    marker_path = os.path.join(out_dir, "clap_markers.csv")
    write_wav(wav_path, sr, audio)
    with open(marker_path, "w", encoding="utf-8") as f:
        f.write("name,sample,seconds\n")
        for name, sample, sec in marks:
            f.write(f"clap{name},{sample},{sec:.4f}\n")
    return {"wav": wav_path, "markers": marker_path}
