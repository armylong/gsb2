"""盲听台音频处理核心。

职责:
- 调用 ffmpeg/ffprobe 完成 wav 解码、两种有损编码设置的编码与再解码
- BS.1770 集成响度测量 (ffmpeg ebur128)、采样峰值
- 检测有效(非静音)区间, 估计编码延迟样点偏移, 把参考/A/B 裁到共同有效范围
- 响度匹配(带回填保护)
- 内置两类程序合成样例: 敲击(瞬态) 与 安静尾音
"""
from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass, field

import numpy as np

# --------------------------------------------------------------------------- #
# ffmpeg 封装
# --------------------------------------------------------------------------- #

FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE", "ffprobe")


class AudioError(RuntimeError):
    """音频处理失败。"""


def _run(cmd: list[str], *, input_bytes: bytes | None = None) -> subprocess.CompletedProcess:
    try:
        proc = subprocess.run(
            cmd, input=input_bytes, capture_output=True, check=False,
        )
    except FileNotFoundError as exc:  # pragma: no cover - 环境缺 ffmpeg
        raise AudioError(f"找不到可执行文件: {cmd[0]}") from exc
    if proc.returncode != 0:
        raise AudioError(
            f"命令执行失败 ({proc.returncode}): {' '.join(cmd)}\n"
            f"{proc.stderr.decode(errors='ignore')[-1500:]}"
        )
    return proc


def check_toolchain() -> None:
    """启动时确认 ffmpeg / ffprobe 可用。"""
    for tool in (FFMPEG, FFPROBE):
        _run([tool, "-version"])


def probe_stream(path: str) -> tuple[int, int]:
    """返回 (采样率, 声道数)。"""
    proc = _run([
        FFPROBE, "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=sample_rate,channels",
        "-of", "json", path,
    ])
    try:
        stream = json.loads(proc.stdout.decode())["streams"][0]
        return int(stream["sample_rate"]), int(stream["channels"])
    except (KeyError, IndexError, json.JSONDecodeError, ValueError) as exc:
        raise AudioError(f"无法读取音频流信息: {path}") from exc


def decode_float(path: str, sr: int, ch: int) -> np.ndarray:
    """把任意音频解码为 float32  interleaved 前的二维数组 (n_frames, ch)。

    统一重采样到参考采样率/声道, 保证三路缓冲可以用同一条时间轴。
    """
    proc = _run([
        FFMPEG, "-v", "error", "-i", path,
        "-f", "f32le", "-ac", str(ch), "-ar", str(sr),
        "-acodec", "pcm_f32le", "-",
    ])
    data = np.frombuffer(proc.stdout, dtype=np.float32).copy()
    if data.size == 0:
        raise AudioError(f"解码结果为空: {path}")
    frames = data.size // ch
    return data[: frames * ch].reshape(frames, ch)


def write_wav(buf: np.ndarray, sr: int, ch: int, path: str) -> None:
    """float32 数组 -> 16bit PCM wav。"""
    pcm = np.clip(buf, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2")
    _run([
        FFMPEG, "-y", "-v", "error",
        "-f", "s16le", "-ar", str(sr), "-ac", str(ch), "-i", "-",
        "-c:a", "pcm_s16le", path,
    ], input_bytes=pcm.tobytes())


# --------------------------------------------------------------------------- #
# 有损编码设置
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class EncodeSetting:
    key: str
    label: str
    ext: str
    args: tuple[str, ...]

    def describe(self) -> dict:
        return {"key": self.key, "label": self.label, "ffmpeg_args": list(self.args)}


PRESETS: list[EncodeSetting] = [
    EncodeSetting("mp3_128", "MP3 / LAME 128 kbps", ".mp3",
                  ("-c:a", "libmp3lame", "-b:a", "128k")),
    EncodeSetting("mp3_320", "MP3 / LAME 320 kbps", ".mp3",
                  ("-c:a", "libmp3lame", "-b:a", "320k")),
    EncodeSetting("aac_96", "AAC / 96 kbps", ".m4a",
                  ("-c:a", "aac", "-b:a", "96k")),
    EncodeSetting("aac_256", "AAC / 256 kbps", ".m4a",
                  ("-c:a", "aac", "-b:a", "256k")),
    EncodeSetting("opus_64", "Opus / 64 kbps", ".opus",
                  ("-c:a", "libopus", "-b:a", "64k")),
    EncodeSetting("opus_192", "Opus / 192 kbps", ".opus",
                  ("-c:a", "libopus", "-b:a", "192k")),
    EncodeSetting("vorbis_q2", "Vorbis / q2 (~80 kbps)", ".ogg",
                  ("-c:a", "libvorbis", "-q:a", "2")),
    EncodeSetting("vorbis_q8", "Vorbis / q8 (~256 kbps)", ".ogg",
                  ("-c:a", "libvorbis", "-q:a", "8")),
]
PRESET_BY_KEY = {p.key: p for p in PRESETS}
DEFAULT_PAIR = ("mp3_128", "mp3_320")


def encode_decode(src_wav: str, setting: EncodeSetting, workdir: str,
                  sr: int, ch: int) -> tuple[np.ndarray, str]:
    """编码为有损文件再解码回 float32, 返回 (数组, 编码文件路径)。"""
    out_path = os.path.join(workdir, f"enc_{setting.key}{setting.ext}")
    _run([
        FFMPEG, "-y", "-v", "error", "-i", src_wav,
        *setting.args, out_path,
    ])
    return decode_float(out_path, sr, ch), out_path


# --------------------------------------------------------------------------- #
# 响度 / 静音 / 对齐
# --------------------------------------------------------------------------- #

_SILENCE_THRESH_DB = -50.0
_WINDOW_MS = 20


def measure_loudness(buf: np.ndarray, sr: int, ch: int) -> tuple[float, float]:
    """返回 (集成响度 LUFS, 采样峰值 dBFS)。

    响度走 ffmpeg ebur128 (BS.1770), 极端安静信号可能返回 -inf;
    峰值本地计算, 用于响度匹配的回填保护。
    """
    proc = _run([
        FFMPEG, "-hide_banner", "-f", "f32le",
        "-ar", str(sr), "-ac", str(ch), "-i", "-",
        "-af", "ebur128=peak=true", "-f", "null", "-",
    ], input_bytes=buf.astype(np.float32).tobytes())
    text = proc.stderr.decode(errors="ignore")
    import re
    # 只匹配 Summary 中的整行读数, 避免撞上 "Integrated loudness:" 标题
    m_i = re.search(r"^\s*I:\s+(-?\d+(?:\.\d+)?|-\s*inf)\s+LUFS\s*$",
                    text, re.MULTILINE)
    m_p = re.search(r"^\s*Peak:\s+(-?\d+(?:\.\d+)?|-\s*inf)\s+dBFS\s*$",
                    text, re.MULTILINE)
    lufs = float("-inf")
    if m_i and "inf" not in m_i.group(1):
        lufs = float(m_i.group(1))
    peak_linear = float(np.max(np.abs(buf))) if buf.size else 0.0
    peak_db = 20.0 * np.log10(peak_linear) if peak_linear > 0 else float("-inf")
    if m_p and "inf" not in m_p.group(1) and not np.isfinite(peak_db):
        peak_db = float(m_p.group(1))
    return lufs, peak_db


def active_range(buf: np.ndarray, sr: int,
                 thresh_db: float = _SILENCE_THRESH_DB) -> tuple[int, int]:
    """基于 20ms 窗 RMS 找有效区间 [start, end) 样点。"""
    mono = buf.mean(axis=1)
    win = max(1, int(sr * _WINDOW_MS / 1000))
    n_windows = len(mono) // win
    if n_windows == 0:
        return 0, len(mono)
    trimmed = mono[: n_windows * win].reshape(n_windows, win)
    rms = np.sqrt(np.mean(trimmed.astype(np.float64) ** 2, axis=1) + 1e-12)
    rms_db = 20.0 * np.log10(rms)
    voiced = np.flatnonzero(rms_db > thresh_db)
    if voiced.size == 0:
        return 0, len(mono)
    start = int(voiced[0]) * win
    end = min(len(mono), (int(voiced[-1]) + 1) * win)
    return start, end


def estimate_offset(ref_mono: np.ndarray, cand_mono: np.ndarray,
                    ref_start: int, cand_start: int, sr: int) -> int:
    """估计 cand 相对 ref 的样点偏移: cand 样点 = ref 样点 + offset。

    用有效起点附近最多 3 秒信号做 FFT 互相关, 搜索窗 ±0.5 秒。
    相关峰太弱时退回 "有效起点对齐"。
    """
    seg_len = min(
        int(3.0 * sr),
        len(ref_mono) - ref_start,
        len(cand_mono) - cand_start,
    )
    if seg_len <= 0:
        return cand_start - ref_start
    a = ref_mono[ref_start: ref_start + seg_len].astype(np.float64)
    # 归一化互相关, 固定等长窗: 先零均值化, 让大段静音不主导相关峰
    # (未归一化相关会被静音边界的零块能量支配, 峰落在静音起点)
    pad = int(1.0 * sr)
    lo = max(0, cand_start - pad)
    hi = min(len(cand_mono), cand_start + seg_len + pad)
    b_all = cand_mono[lo:hi].astype(np.float64)
    if len(b_all) < len(a):  # pragma: no cover - 极短素材兜底
        return cand_start - ref_start
    a0 = a - a.mean()
    a_norm = np.sqrt(np.dot(a0, a0))
    if a_norm == 0:
        return cand_start - ref_start
    nfft = 1 << (2 * len(a) - 1).bit_length()
    # 对每个候选偏移 d, 取 b 中与 a 等长的窗做归一化相关
    corr = np.fft.irfft(
        np.fft.rfft(b_all, nfft) * np.conj(np.fft.rfft(a0, nfft)), nfft
    )
    # corr[i] = sum_j b_all[i+j] * a0[j], i 即 b 窗起点;
    # offset = (lo + i) - ref_start
    prior = cand_start - ref_start
    half = min(int(0.5 * sr), len(b_all) - len(a))
    i_center = cand_start - lo
    i_lo = max(0, i_center - half)
    i_hi = min(len(b_all) - len(a), i_center + half)
    indices = np.arange(i_lo, i_hi + 1)
    # 各候选窗的能量 (零均值)
    c_sum = np.convolve(b_all, np.ones(len(a)), mode="valid")[indices]
    c_sq = np.convolve(b_all * b_all, np.ones(len(a)), mode="valid")[indices]
    energy = np.maximum(c_sq - c_sum * c_sum / len(a), 1e-12)
    scores = corr[indices] / (a_norm * np.sqrt(energy))
    best = int(np.argmax(np.abs(scores)))
    # 归一化相关低于 0.5 视为不可信, 退回有效起点对齐
    if abs(float(scores[best])) < 0.5:
        return prior
    return lo + int(indices[best]) - ref_start


def align_buffers(raw: dict[str, np.ndarray], sr: int) -> tuple[dict[str, np.ndarray], dict[str, int]]:
    """把 ref/A/B 对齐并裁成等长。

    返回 (对齐后等长缓冲, 各源相对 ref 的样点偏移)。
    """
    ref = raw["ref"]
    ref_mono = ref.mean(axis=1)
    rs, re_ = active_range(ref, sr)
    ranges = {"ref": (rs, re_)}
    offsets = {"ref": 0}

    # 共同区间在 ref 时间轴上的起止
    common_s, common_e = rs, re_
    for key in ("A", "B"):
        cand = raw[key]
        cs, ce = active_range(cand, sr)
        ranges[key] = (cs, ce)
        off = estimate_offset(ref_mono, cand.mean(axis=1), rs, cs, sr)
        offsets[key] = off
        # cand 有效区间映射到 ref 轴: [cs-off, ce-off)
        common_s = max(common_s, cs - off)
        common_e = min(common_e, ce - off)

    if common_e <= common_s:  # 兜底: 全部按有效起点硬切
        starts = {k: active_range(raw[k], sr)[0] for k in raw}
        length = min(len(raw[k]) - starts[k] for k in raw)
        aligned = {k: raw[k][starts[k]: starts[k] + length].copy() for k in raw}
        return aligned, {k: starts[k] - starts["ref"] for k in raw}

    aligned = {"ref": ref[common_s:common_e].copy()}
    for key in ("A", "B"):
        start = common_s + offsets[key]
        aligned[key] = raw[key][start: start + (common_e - common_s)].copy()
    return aligned, offsets


def crop_common(raw: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    """不做对齐时的处理: 保留各自延迟/静音, 仅按最短长度切齐索引。"""
    length = min(len(b) for b in raw.values())
    return {k: b[:length].copy() for k, b in raw.items()}


def match_loudness(buffers: dict[str, np.ndarray], sr: int, ch: int,
                   target_key: str = "ref") -> tuple[dict[str, np.ndarray], dict[str, dict]]:
    """把各路集成响度匹配到目标路, 带峰值回填保护。"""
    loudness = {}
    for key, buf in buffers.items():
        lufs, peak_db = measure_loudness(buf, sr, ch)
        loudness[key] = {"lufs": lufs, "peak_db": peak_db}
    target = loudness[target_key]["lufs"]
    out: dict[str, np.ndarray] = {}
    gains: dict[str, dict] = {}
    for key, buf in buffers.items():
        lufs = loudness[key]["lufs"]
        if not np.isfinite(lufs) or not np.isfinite(target):
            gain_linear, limited, gain_db = 1.0, False, 0.0
        else:
            gain_db = target - lufs
            gain_linear = 10.0 ** (gain_db / 20.0)
            peak = float(np.max(np.abs(buf))) if buf.size else 0.0
            limited = peak > 0 and peak * gain_linear > 0.999
            if limited:
                gain_linear = 0.999 / peak
                gain_db = 20.0 * np.log10(gain_linear)
        out[key] = buf * gain_linear
        gains[key] = {
            "gain_db": float(gain_db),
            "peak_limited": bool(limited),
            "lufs_before": lufs,
            "peak_db_before": loudness[key]["peak_db"],
        }
    return out, gains


# --------------------------------------------------------------------------- #
# 内置样例(程序合成, 不依赖外部素材)
# --------------------------------------------------------------------------- #

def _stereo(mono: np.ndarray) -> np.ndarray:
    return np.repeat(mono[:, None], 2, axis=1)


def build_sample_transients(sr: int = 48000) -> np.ndarray:
    """敲击样例: 一串指数衰减的短促敲击, 含轻声收尾, 前后留静音。"""
    duration = 2.6
    t = np.arange(int(sr * duration), dtype=np.float64) / sr
    x = np.zeros_like(t)
    hits = [(0.35, 0.85), (0.85, 0.85), (1.35, 0.8), (1.85, 0.7), (2.2, 0.22)]
    rng = np.random.default_rng(16359)
    for hit_t, amp in hits:
        idx = t >= hit_t
        dt = t - hit_t
        # 噪声瞬态 + 高频正弦 "叮" 声, 几十毫秒内衰减完
        burst = rng.standard_normal(len(t)) * np.exp(-dt / 0.004)
        ping = np.sin(2 * np.pi * 1500 * dt) * np.exp(-dt / 0.012)
        x[idx] += amp * (0.7 * burst[idx] + 0.3 * ping[idx])
    x /= max(1.0, np.max(np.abs(x))) / 0.9
    return _stereo(x.astype(np.float32))


def build_sample_quiet_tail(sr: int = 48000) -> np.ndarray:
    """安静尾音样例: 长指数衰减的和弦, 末端接近噪声地板, 尾部留静音。"""
    duration = 3.6
    t = np.arange(int(sr * duration), dtype=np.float64) / sr
    start, body = 0.25, 2.7
    x = np.zeros_like(t)
    idx = (t >= start) & (t < start + body)
    dt = t[idx] - start
    env = np.exp(-dt / 0.85) * 0.6
    tone = (
        np.sin(2 * np.pi * 220 * dt)
        + 0.6 * np.sin(2 * np.pi * 330 * dt)
        + 0.3 * np.sin(2 * np.pi * 440 * dt)
    )
    x[idx] = env * tone / 1.9
    rng = np.random.default_rng(16360)
    x += rng.standard_normal(len(t)) * (10 ** (-60 / 20))  # -60 dBFS 噪声底
    return _stereo(x.astype(np.float32))


BUILTIN_SAMPLES = {
    "sample_transients": ("敲击样例 (瞬态/瞬态噪声)", build_sample_transients),
    "sample_quiet_tail": ("安静尾音样例 (长衰减)", build_sample_quiet_tail),
}


# --------------------------------------------------------------------------- #
# 顶层流水线
# --------------------------------------------------------------------------- #

@dataclass
class SourceInfo:
    kind: str           # "builtin" | "file"
    name: str
    path: str
    sr: int
    ch: int


@dataclass
class ProcessedBundle:
    source: SourceInfo
    setting_a: EncodeSetting
    setting_b: EncodeSetting
    sr: int
    ch: int
    raw: dict[str, np.ndarray]
    final: dict[str, np.ndarray]
    alignment: bool
    loudness_match: bool
    offsets: dict[str, int]
    raw_metrics: dict[str, dict]
    final_metrics: dict[str, dict]
    gains: dict[str, dict] = field(default_factory=dict)
    encoded_paths: dict[str, str] = field(default_factory=dict)


def _metrics_for(buf: np.ndarray, sr: int, ch: int) -> dict:
    lufs, peak_db = measure_loudness(buf, sr, ch)
    start, end = active_range(buf, sr)
    return {
        "duration_s": len(buf) / sr,
        "lufs": lufs,
        "peak_db": peak_db,
        "silence_head_ms": start / sr * 1000.0,
        "silence_tail_ms": (len(buf) - end) / sr * 1000.0,
        "active_start": start,
        "active_end": end,
    }


def rebuild_final(raw: dict[str, np.ndarray], sr: int, ch: int,
                  alignment: bool, loudness_match: bool
                  ) -> tuple[dict[str, np.ndarray], dict[str, np.ndarray],
                             dict[str, int], dict[str, dict], dict[str, dict]]:
    """根据开关从原始解码缓冲重建播放缓冲 (改开关时不必重新编码)。"""
    if alignment:
        aligned, offsets = align_buffers(raw, sr)
    else:
        aligned, offsets = crop_common(raw), {k: 0 for k in raw}
    gains: dict[str, dict] = {}
    if loudness_match:
        final, gains = match_loudness(aligned, sr, ch)
    else:
        final = {k: b.copy() for k, b in aligned.items()}
    final_metrics = {k: _metrics_for(b, sr, ch) for k, b in final.items()}
    return aligned, final, offsets, final_metrics, gains


def full_process(source: SourceInfo, setting_a: EncodeSetting, setting_b: EncodeSetting,
                 workdir: str, alignment: bool, loudness_match: bool,
                 progress=None) -> ProcessedBundle:
    """完整流水线: 解码参考 -> 两路编码/解码 -> 测量 -> 对齐/响度 -> 等长缓冲。"""
    def say(msg: str) -> None:
        if progress:
            progress(msg)

    sr, ch = source.sr, source.ch
    say("解码参考 WAV…")
    ref = decode_float(source.path, sr, ch)
    say(f"编码并解码 A: {setting_a.label}…")
    buf_a, path_a = encode_decode(source.path, setting_a, workdir, sr, ch)
    say(f"编码并解码 B: {setting_b.label}…")
    buf_b, path_b = encode_decode(source.path, setting_b, workdir, sr, ch)

    raw = {"ref": ref, "A": buf_a, "B": buf_b}
    say("测量时长 / 响度 / 静音…")
    raw_metrics = {k: _metrics_for(b, sr, ch) for k, b in raw.items()}
    say("对齐共同有效范围并构建播放缓冲…")
    _, final, offsets, final_metrics, gains = rebuild_final(
        raw, sr, ch, alignment, loudness_match,
    )
    return ProcessedBundle(
        source=source, setting_a=setting_a, setting_b=setting_b,
        sr=sr, ch=ch, raw=raw, final=final,
        alignment=alignment, loudness_match=loudness_match,
        offsets=offsets, raw_metrics=raw_metrics,
        final_metrics=final_metrics, gains=gains,
        encoded_paths={"A": path_a, "B": path_b},
    )
