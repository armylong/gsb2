"""核心分析层: 样例生成 / ffprobe 取证 / 双模式解码 / 脉冲对齐 / 报告导出。

设计原则
--------
1. 所有"结论"都必须挂得上一条可复核的证据 (ffprobe 字段、样本计数、恒等式)。
2. 证据不足时只陈述可确认事实, 明确标注"无法确认", 不做任何推测性补齐。
3. GUI 不做判定, 本模块的数据结构即界面与报告的唯一事实来源。

延迟标记背景 (本工具在 ffmpeg 9.0 上实测确认)
---------------------------------------------
有损编码器 (AAC/MP3 ...) 按固定帧长工作, 输入样本数不是帧长整数倍时会补齐,
同时编码器自身存在前置延迟 (priming)。容器/码流用两类标记记录应丢弃的样本:
  - 头部 skip_samples    : 解码后开头要丢弃的样本数 (含编码器前置延迟)
  - 尾部 discard_padding : 解码后结尾要丢弃的样本数 (帧补齐 padding)
ffmpeg 默认解码会自动应用这些标记; 加 ``-flags2 +skip_manual`` 后不丢弃、
保留全部原始解码帧, 即"忽略延迟标记"。两种模式之差就是标记覆盖的样本数。
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import struct
import subprocess
import wave
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

SAMPLE_RATE = 48000
CHANNELS = 1
SAMPLE_WIDTH = 2  # 16-bit PCM
AMPLITUDE = 24000  # 脉冲幅度 (满幅 32767, 约 -2.7 dBFS), 远高于静音判定门限

# 静音 / 脉冲判定门限 (按 16-bit 满幅 32767 归一)
SILENCE_THRESHOLD = 0.05 * 32767.0   # 单样本绝对值低于 1638 视为静音
PULSE_THRESHOLD = 0.20 * 32767.0     # 单样本绝对值高于 6553 视为脉冲命中

# 样例音频结构 (秒): 前置原始静音 + 片头脉冲 + 中段 + 片尾脉冲 + 尾部原始静音
HEAD_SILENCE_S = 0.100
HEAD_PULSE_S = 0.005
MIDDLE_S = 0.290
TAIL_PULSE_S = 0.005
TAIL_SILENCE_S = 0.100
# 总时长 = 0.500 s = 24000 样本 @48k

# 两种"常用压缩编码"。键为内部标识, 值为 ffmpeg 参数与展示信息。
ENCODERS = {
    "aac": {
        "label": "AAC-LC (MP4/M4A 容器)",
        "ext": ".m4a",
        "ffmpeg_args": ["-c:a", "aac", "-q:a", "1.5"],
    },
    "mp3": {
        "label": "MP3 (libmp3lame)",
        "ext": ".mp3",
        "ffmpeg_args": ["-c:a", "libmp3lame", "-b:a", "128k"],
    },
}


class ToolDependencyError(RuntimeError):
    """本机缺少 ffmpeg/ffprobe 等外部依赖。"""


# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------

@dataclass
class MarkerInfo:
    """容器/码流中的延迟标记与封装声明时长, 全部取自 ffprobe 原始字段。"""

    present: bool = False
    head_skip_samples: int | None = None       # 包级 Skip Samples / skip_samples
    tail_padding_samples: int | None = None    # 包级 discard_padding
    initial_padding: int | None = None         # 流级 initial_padding (AAC/MP4 常见)
    start_time_s: float | None = None          # 流 start_time
    stream_duration_s: float | None = None     # 流级 duration 字段
    format_duration_s: float | None = None     # 容器级 format.duration
    duration_evidence: str = ""                # 时长字段的出处与缺失说明
    raw_evidence: dict = field(default_factory=dict)  # 原样留存, 供报告引用


@dataclass
class DecodeResult:
    """一种解码模式下的实测结果。"""

    mode: str                       # "applied" 应用标记 / "ignored" 忽略标记
    pcm_path: Path
    sample_count: int
    duration_s: float
    head_pulse_index: int | None    # 首个越过脉冲门限的样本下标; None = 未检出
    tail_pulse_index: int | None    # 最后一个越过脉冲门限的样本下标
    leading_silence_samples: int | None
    trailing_silence_samples: int | None
    notes: list[str] = field(default_factory=list)


@dataclass
class FileAnalysis:
    """单个压缩文件的完整分析结论。"""

    file_path: Path
    codec: str
    markers: MarkerInfo
    applied: DecodeResult | None = None
    ignored: DecodeResult | None = None

    # 与参考 PCM 的比对 (无参考时全部为 None, 相关结论标记为无法确认)
    ref_path: Path | None = None
    ref_sample_count: int | None = None
    ref_head_pulse: int | None = None
    ref_tail_pulse: int | None = None

    # 标记恒等式核对: 原始解码帧数 - 头skip - 尾pad == 应用标记后样本数
    identity_ok: bool | None = None
    identity_detail: str = ""

    # 头部空白分解: 编码补齐 vs 原始静音 (仅在参考与标记同时可用时可确认)
    head_encoder_pad_samples: int | None = None
    head_original_silence_samples: int | None = None
    tail_encoder_pad_samples: int | None = None
    tail_original_silence_samples: int | None = None

    facts: list[str] = field(default_factory=list)       # 可确认事实
    unknowns: list[str] = field(default_factory=list)    # 证据不足、明确不硬补的事项

    def to_jsonable(self) -> dict:
        d = asdict(self)
        d["file_path"] = str(self.file_path)
        if self.ref_path is not None:
            d["ref_path"] = str(self.ref_path)
        for key in ("applied", "ignored"):
            if d[key] is not None:
                d[key]["pcm_path"] = str(d[key]["pcm_path"])
        return d


# ---------------------------------------------------------------------------
# 外部工具与基础 PCM 操作
# ---------------------------------------------------------------------------

def ensure_ffmpeg() -> tuple[str, str]:
    """确认 ffmpeg / ffprobe 可执行, 返回二者路径。"""
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        raise ToolDependencyError(
            "未找到 ffmpeg/ffprobe, 请先安装 (macOS: brew install ffmpeg)"
        )
    return ffmpeg, ffprobe


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    """跑外部命令, 失败时带上完整命令与 stderr 抛错。"""
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"命令执行失败 ({proc.returncode}):\n  {' '.join(cmd)}\n{proc.stderr.strip()}"
        )
    return proc


def read_pcm_samples(path: Path) -> list[int]:
    """读 16-bit 单声道 PCM (裸 s16le), 返回有符号整数样本列表。"""
    raw = Path(path).read_bytes()
    count = len(raw) // 2
    return list(struct.unpack("<%dh" % count, raw[: count * 2]))


def write_wav(path: Path, samples: list[int],
              sample_rate: int = SAMPLE_RATE,
              channels: int = CHANNELS,
              sample_width: int = SAMPLE_WIDTH) -> None:
    """把整数样本写成 WAV。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(sample_width)
        wf.setframerate(sample_rate)
        wf.writeframes(struct.pack("<%dh" % len(samples), *samples))


def detect_pulses(samples: list[int]) -> tuple[int | None, int | None]:
    """返回 (首个越门限样本下标, 最后一个越门限样本下标); 全静音返回 (None, None)。

    门限 PULSE_THRESHOLD 在模块顶部定义, 报告中会同步写出该判定依据。
    """
    first = None
    last = None
    for i, v in enumerate(samples):
        if abs(v) >= PULSE_THRESHOLD:
            if first is None:
                first = i
            last = i
    return first, last


# ---------------------------------------------------------------------------
# 步骤 1: 生成带片头/片尾定位脉冲的参考 WAV
# ---------------------------------------------------------------------------

def generate_reference_wav(out_path: Path,
                           sample_rate: int = SAMPLE_RATE) -> Path:
    """生成结构固定的参考 WAV。

    布局 (48kHz 单声道 s16, 共 0.500 s = 24000 样本)::

        [原始静音 100ms][片头脉冲 5ms][静音 290ms][片尾脉冲 5ms][原始静音 100ms]

    脉冲位于样本 4800 与 19200, 是后续对齐判定的参考基准;
    头尾各 100ms 是"原始静音", 用于和编码补齐产生的静音做区分。
    """
    n_head_sil = round(HEAD_SILENCE_S * sample_rate)
    n_pulse = round(HEAD_PULSE_S * sample_rate)
    n_middle = round(MIDDLE_S * sample_rate)
    n_tail_sil = round(TAIL_SILENCE_S * sample_rate)

    samples: list[int] = []
    samples += [0] * n_head_sil
    samples += [AMPLITUDE] * n_pulse
    samples += [0] * n_middle
    samples += [AMPLITUDE] * n_pulse
    samples += [0] * n_tail_sil

    write_wav(out_path, samples, sample_rate=sample_rate)
    return Path(out_path)


def encode_compressed(wav_path: Path, out_path: Path, codec_key: str) -> Path:
    """把参考 WAV 编码成指定压缩格式 (AAC/m4a 或 MP3)。"""
    if codec_key not in ENCODERS:
        raise ValueError(f"未知编码 {codec_key!r}, 可选: {sorted(ENCODERS)}")
    ffmpeg, _ = ensure_ffmpeg()
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    spec = ENCODERS[codec_key]
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(wav_path),
        *spec["ffmpeg_args"],
        str(out_path),
    ]
    _run(cmd)
    return out_path


# ---------------------------------------------------------------------------
# 步骤 2a: ffprobe 取证 (延迟标记 + 封装声明时长)
# ---------------------------------------------------------------------------

def _ffprobe_json(ffprobe: str, args: list[str]) -> dict:
    proc = _run([ffprobe, "-v", "error", *args, "-of", "json"])
    return json.loads(proc.stdout)


def probe_markers(path: Path) -> MarkerInfo:
    """从 ffprobe 提取头部 skip、尾部 padding 与封装声明时长。

    取值优先级与实测依据 (ffmpeg 9.0):
      - 头/尾标记取**包级 side_data**: 首包 Skip Samples.samples、
        末包 Skip Samples.discard_padding, 这是最直接的容器声明;
      - 流级 initial_padding 作为旁证一并记录 (AAC/MP4 上通常等于头 skip);
      - 时长同时记录 stream.duration 与 format.duration, 字段缺失就如实写明。
    """
    _, ffprobe = ensure_ffmpeg()
    path = Path(path)

    streams = _ffprobe_json(ffprobe, ["-show_streams", str(path)])
    packets = _ffprobe_json(ffprobe, ["-show_packets", "-select_streams", "a",
                                      str(path)])

    stream = next((s for s in streams.get("streams", [])
                   if s.get("codec_type") == "audio"), None)
    pkts = [p for p in packets.get("packets", [])
            if p.get("codec_type") == "audio"]
    if stream is None or not pkts:
        raise RuntimeError(f"{path.name}: 未发现音频流/音频包, 无法分析")

    head_skip = tail_pad = None
    first_sd = pkts[0].get("side_data_list", [])
    last_sd = pkts[-1].get("side_data_list", [])
    for sd in first_sd:
        if sd.get("side_data_type") == "Skip Samples":
            head_skip = int(sd.get("skip_samples", 0)) or None
    for sd in last_sd:
        if sd.get("side_data_type") == "Skip Samples":
            tail_pad = int(sd.get("discard_padding", 0)) or None

    initial_padding = stream.get("initial_padding")
    if initial_padding is not None:
        initial_padding = int(initial_padding) or None

    start_time = _maybe_float(stream.get("start_time"))
    stream_dur = _maybe_float(stream.get("duration"))
    fmt_info = _ffprobe_json(ffprobe, ["-show_format", str(path)])
    format_dur = _maybe_float(fmt_info.get("format", {}).get("duration"))

    present = head_skip is not None or tail_pad is not None

    # 时长出处: 两个字段都可能缺失, 缺哪个说哪个, 绝不拿样本数反推冒充声明值
    ev_parts = []
    if stream_dur is not None:
        ev_parts.append(f"stream.duration={stream_dur:.6f}s")
    else:
        ev_parts.append("stream.duration 字段缺失")
    if format_dur is not None:
        ev_parts.append(f"format.duration={format_dur:.6f}s")
    else:
        ev_parts.append("format.duration 字段缺失")

    return MarkerInfo(
        present=present,
        head_skip_samples=head_skip,
        tail_padding_samples=tail_pad,
        initial_padding=initial_padding,
        start_time_s=start_time,
        stream_duration_s=stream_dur,
        format_duration_s=format_dur,
        duration_evidence="; ".join(ev_parts),
        raw_evidence={
            "first_packet_side_data": first_sd,
            "last_packet_side_data": last_sd,
            "stream_initial_padding": stream.get("initial_padding"),
            "stream_start_time": stream.get("start_time"),
        },
    )


def _maybe_float(v) -> float | None:
    try:
        if v is None or v == "N/A":
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# 步骤 2b: 双模式解码 (应用标记 / 忽略标记)
# ---------------------------------------------------------------------------

def decode_pcm(src: Path, out_pcm: Path, ignore_markers: bool) -> Path:
    """解码为裸 s16le 单声道 PCM。

    ignore_markers=False: ffmpeg 默认行为, 自动应用 skip/padding 标记;
    ignore_markers=True : 加 -flags2 +skip_manual, 不丢弃任何样本,
                          保留编码器输出的完整原始帧 (标记仍在帧侧数据里)。
    固定输出采样率与声道, 保证样本计数可直接比较。
    """
    ffmpeg, _ = ensure_ffmpeg()
    out_pcm = Path(out_pcm)
    out_pcm.parent.mkdir(parents=True, exist_ok=True)
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
    if ignore_markers:
        # 输入选项: 作用于解码器
        cmd += ["-flags2", "+skip_manual"]
    cmd += [
        "-i", str(src),
        "-vn",
        "-ac", str(CHANNELS),
        "-ar", str(SAMPLE_RATE),
        "-f", "s16le",
        "-c:a", "pcm_s16le",
        str(out_pcm),
    ]
    _run(cmd)
    return out_pcm


def _build_decode_result(mode: str, pcm_path: Path) -> DecodeResult:
    samples = read_pcm_samples(pcm_path)
    first, last = detect_pulses(samples)
    leading = first if first is not None else None
    trailing = (len(samples) - 1 - last) if last is not None else None
    notes = []
    if first is None:
        notes.append("未检出越过脉冲门限的样本")
    return DecodeResult(
        mode=mode,
        pcm_path=pcm_path,
        sample_count=len(samples),
        duration_s=len(samples) / SAMPLE_RATE,
        head_pulse_index=first,
        tail_pulse_index=last,
        leading_silence_samples=leading,
        trailing_silence_samples=trailing,
        notes=notes,
    )


# ---------------------------------------------------------------------------
# 步骤 3/4: 综合分析
# ---------------------------------------------------------------------------

def analyze_file(src: Path,
                 work_dir: Path,
                 reference_wav: Path | None = None) -> FileAnalysis:
    """对一个压缩音频做完整分析。

    work_dir      : 解码 PCM 等中间产物目录;
    reference_wav : 编码前的参考 WAV。为 None 时 (外部文件模式),
                    所有依赖参考的对齐/分解结论标记为"无法确认"。
    """
    src = Path(src)
    work_dir = Path(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)

    _, ffprobe = ensure_ffmpeg()
    codec = _probe_codec(ffprobe, src)
    markers = probe_markers(src)

    applied_pcm = work_dir / f"{src.stem}.applied.s16le"
    ignored_pcm = work_dir / f"{src.stem}.ignored.s16le"
    decode_pcm(src, applied_pcm, ignore_markers=False)
    decode_pcm(src, ignored_pcm, ignore_markers=True)
    applied = _build_decode_result("applied", applied_pcm)
    ignored = _build_decode_result("ignored", ignored_pcm)

    ana = FileAnalysis(
        file_path=src, codec=codec, markers=markers,
        applied=applied, ignored=ignored,
    )

    # ---- 参考信息 ----------------------------------------------------------
    if reference_wav is not None and Path(reference_wav).exists():
        ref_samples = _read_wav_samples(Path(reference_wav))
        rf, rl = detect_pulses(ref_samples)
        ana.ref_path = Path(reference_wav)
        ana.ref_sample_count = len(ref_samples)
        ana.ref_head_pulse = rf
        ana.ref_tail_pulse = rl

    _check_identity(ana)
    _decompose_silence(ana)
    _collect_facts(ana)
    return ana


def _probe_codec(ffprobe: str, src: Path) -> str:
    info = _ffprobe_json(ffprobe, ["-show_streams", str(src)])
    stream = next((s for s in info.get("streams", [])
                   if s.get("codec_type") == "audio"), None)
    return stream.get("codec_name", "unknown") if stream else "unknown"


def _read_wav_samples(path: Path) -> list[int]:
    with wave.open(str(path), "rb") as wf:
        nch, sw, sr = wf.getnchannels(), wf.getsampwidth(), wf.getframerate()
        raw = wf.readframes(wf.getnframes())
    if sw != 2:
        raise RuntimeError(f"{path.name}: 仅支持 16-bit WAV, 当前 sampwidth={sw}")
    count = len(raw) // 2
    samples = list(struct.unpack("<%dh" % count, raw[: count * 2]))
    if nch > 1:  # 多声道取首声道, 与解码端 -ac 1 口径一致
        samples = samples[0::nch]
    return samples


def _check_identity(ana: FileAnalysis) -> None:
    """核对标记恒等式: 忽略标记的帧数 - 头skip - 尾pad == 应用标记后样本数。"""
    m = ana.markers
    if (m.head_skip_samples is not None
            and m.tail_padding_samples is not None
            and ana.ignored is not None and ana.applied is not None):
        expect = (ana.ignored.sample_count
                  - m.head_skip_samples - m.tail_padding_samples)
        actual = ana.applied.sample_count
        ana.identity_ok = (expect == actual)
        ana.identity_detail = (
            f"{ana.ignored.sample_count} (忽略标记) "
            f"- {m.head_skip_samples} (头skip) "
            f"- {m.tail_padding_samples} (尾pad) = {expect}; "
            f"应用标记后实测 {actual}; "
            f"{'恒等式成立' if ana.identity_ok else '恒等式不成立, 需人工复核'}"
        )
    else:
        ana.identity_ok = None
        missing = [n for n, v in (
            ("头skip", m.head_skip_samples),
            ("尾padding", m.tail_padding_samples)) if v is None]
        ana.identity_detail = (
            f"缺少 {', '.join(missing)} 标记, 无法核对标记恒等式"
            if missing else "解码结果缺失, 无法核对")


def _decompose_silence(ana: FileAnalysis) -> None:
    """把片头/片尾空白拆成"编码补齐"与"原始静音"两段。

    可确认的前提: 参考脉冲位置已知 + 标记存在 + 两种解码脉冲均检出。
    任一前提不满足就保持 None, 并在 unknowns 里登记, 不做反推。
    """
    m = ana.markers
    if (ana.ref_head_pulse is None or ana.applied is None
            or ana.ignored is None):
        return
    if (ana.applied.head_pulse_index is None
            or ana.ignored.head_pulse_index is None):
        return

    # 头部: 忽略标记模式下脉冲前面的全部样本 = 头skip(编码补齐) + 原始静音
    if m.head_skip_samples is not None:
        raw_lead = ana.ignored.leading_silence_samples
        if raw_lead is not None:
            ana.head_encoder_pad_samples = m.head_skip_samples
            ana.head_original_silence_samples = raw_lead - m.head_skip_samples

    # 尾部: 参考脉冲到参考结尾的原始静音可直接量; 编码补齐取 discard_padding
    if (m.tail_padding_samples is not None
            and ana.ref_tail_pulse is not None
            and ana.ref_sample_count is not None):
        ana.tail_encoder_pad_samples = m.tail_padding_samples
        ana.tail_original_silence_samples = (
            ana.ref_sample_count - 1 - ana.ref_tail_pulse)


def _collect_facts(ana: FileAnalysis) -> None:
    """汇总"可确认事实"与"无法确认事项"两个清单, 报告与界面共用。"""
    m = ana.markers
    f, u = ana.facts, ana.unknowns

    f.append(f"编码: {ana.codec}; 文件: {ana.file_path.name}")
    f.append(f"脉冲判定门限: |样本| >= {PULSE_THRESHOLD:.0f} "
             f"(满幅 32767 的 {PULSE_THRESHOLD / 32767:.0%}); "
             f"静音门限: |样本| < {SILENCE_THRESHOLD:.0f} "
             f"({SILENCE_THRESHOLD / 32767:.0%})")

    # --- 三类时长: 源 PCM / 解码 PCM / 封装声明 ---
    if ana.ref_sample_count is not None:
        f.append(f"源 PCM: {ana.ref_sample_count} 样本, "
                 f"{ana.ref_sample_count / SAMPLE_RATE:.6f} s "
                 f"(参考: {ana.ref_path.name})")
    else:
        u.append("未提供编码前参考 WAV: 源 PCM 样本数无法确认, "
                 "无法区分编码补齐与原始静音, 也无法计算脉冲对齐误差")

    f.append(f"解码 PCM [应用延迟标记]: {ana.applied.sample_count} 样本, "
             f"{ana.applied.duration_s:.6f} s")
    f.append(f"解码 PCM [忽略延迟标记]: {ana.ignored.sample_count} 样本, "
             f"{ana.ignored.duration_s:.6f} s")
    f.append(f"封装声明时长: {m.duration_evidence}")
    if m.start_time_s is not None:
        f.append(f"流 start_time={m.start_time_s:.6f} s "
                 f"(MP3 等裸码流格式常把头部延迟体现在这里)")

    # --- 延迟标记 ---
    if m.present:
        f.append(f"头部标记 skip_samples={m.head_skip_samples} 样本"
                 + (f" ({m.head_skip_samples / SAMPLE_RATE * 1000:.3f} ms)"
                    if m.head_skip_samples is not None else ""))
        f.append(f"尾部标记 discard_padding={m.tail_padding_samples} 样本"
                 + (f" ({m.tail_padding_samples / SAMPLE_RATE * 1000:.3f} ms)"
                    if m.tail_padding_samples is not None else ""))
        if m.initial_padding is not None:
            f.append(f"流级 initial_padding={m.initial_padding} 样本 (旁证)")
        f.append(ana.identity_detail)
    else:
        u.append("ffprobe 未在包级侧数据中发现 skip_samples/discard_padding: "
                 "该文件可能没有延迟标记, 或所用容器/编码器未导出; "
                 "两种解码模式的样本差仍可实测, 但不能归因为标记")

    # --- 脉冲对齐 ---
    if ana.ref_head_pulse is not None:
        for dr, label in ((ana.applied, "应用标记"), (ana.ignored, "忽略标记")):
            if dr.head_pulse_index is None:
                u.append(f"{label}模式未检出片头脉冲, 无法对齐")
                continue
            delta_h = dr.head_pulse_index - ana.ref_head_pulse
            delta_t = (dr.tail_pulse_index - ana.ref_tail_pulse
                       if dr.tail_pulse_index is not None
                       and ana.ref_tail_pulse is not None else None)
            f.append(
                f"脉冲对齐[{label}]: 片头 {dr.head_pulse_index} vs 参考 "
                f"{ana.ref_head_pulse} -> 偏差 {delta_h:+d} 样本 "
                f"({delta_h / SAMPLE_RATE * 1000:+.3f} ms)"
                + (f"; 片尾偏差 {delta_t:+d} 样本 "
                   f"({delta_t / SAMPLE_RATE * 1000:+.3f} ms)"
                   if delta_t is not None else "; 片尾脉冲未检出")
            )
    else:
        u.append("无参考脉冲位置: 解码脉冲的绝对时间可测 "
                 f"(应用模式片头@{ana.applied.head_pulse_index}, "
                 f"忽略模式片头@{ana.ignored.head_pulse_index}), "
                 "但对齐误差无法确认")

    # --- 空白分解 ---
    if ana.head_encoder_pad_samples is not None:
        f.append(
            f"片头空白分解: 编码补齐 {ana.head_encoder_pad_samples} 样本 "
            f"({ana.head_encoder_pad_samples / SAMPLE_RATE * 1000:.3f} ms) "
            f"+ 原始静音 {ana.head_original_silence_samples} 样本 "
            f"({ana.head_original_silence_samples / SAMPLE_RATE * 1000:.3f} ms)")
    if ana.tail_encoder_pad_samples is not None:
        f.append(
            f"片尾空白分解: 编码补齐 {ana.tail_encoder_pad_samples} 样本 "
            f"({ana.tail_encoder_pad_samples / SAMPLE_RATE * 1000:.3f} ms) "
            f"+ 原始静音 {ana.tail_original_silence_samples} 样本 "
            f"({ana.tail_original_silence_samples / SAMPLE_RATE * 1000:.3f} ms)")


# ---------------------------------------------------------------------------
# 步骤 5: 导出 (对照报告 + 截取的解码音频)
# ---------------------------------------------------------------------------

def _ms(n_samples: int | None) -> str:
    if n_samples is None:
        return "N/A"
    return f"{n_samples / SAMPLE_RATE * 1000:.3f} ms"


def write_report(analyses: list[FileAnalysis], out_path: Path) -> Path:
    """导出带时间依据的 Markdown + JSON 对照报告。

    每个数字后面都给出处 (ffprobe 字段 / 样本下标 / 恒等式),
    无法确认的事项单列一节, 与可确认事实严格分开。
    """
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    lines.append("# 短音频片头片尾空白对照报告")
    lines.append("")
    lines.append(f"生成时间: {datetime.now().isoformat(timespec='seconds')}")
    lines.append(f"采样率: {SAMPLE_RATE} Hz; 声道: {CHANNELS}; 位深: 16-bit")
    lines.append(f"脉冲门限: |样本| >= {PULSE_THRESHOLD:.0f}; "
                 f"静音门限: |样本| < {SILENCE_THRESHOLD:.0f} (满幅 32767)")
    lines.append("")

    for ana in analyses:
        m = ana.markers
        lines.append(f"## {ana.file_path.name} ({ana.codec})")
        lines.append("")
        lines.append("### 1. 三类时长对照 (源 PCM / 解码 PCM / 封装声明)")
        lines.append("")
        lines.append("| 项目 | 样本数 | 时长 | 依据 |")
        lines.append("|---|---:|---:|---|")
        if ana.ref_sample_count is not None:
            lines.append(f"| 源 PCM (参考) | {ana.ref_sample_count} | "
                         f"{ana.ref_sample_count / SAMPLE_RATE:.6f} s | "
                         f"{ana.ref_path.name} 直接计数 |")
        else:
            lines.append("| 源 PCM (参考) | N/A | N/A | 未提供参考 WAV, 无法确认 |")
        lines.append(f"| 解码 PCM·应用标记 | {ana.applied.sample_count} | "
                     f"{ana.applied.duration_s:.6f} s | ffmpeg 默认解码后字节计数 |")
        lines.append(f"| 解码 PCM·忽略标记 | {ana.ignored.sample_count} | "
                     f"{ana.ignored.duration_s:.6f} s | "
                     f"ffmpeg -flags2 +skip_manual 后字节计数 |")
        sd = f"{m.stream_duration_s:.6f} s" if m.stream_duration_s is not None else "字段缺失"
        fd = f"{m.format_duration_s:.6f} s" if m.format_duration_s is not None else "字段缺失"
        lines.append(f"| 封装声明·stream.duration | — | {sd} | ffprobe stream 字段 |")
        lines.append(f"| 封装声明·format.duration | — | {fd} | ffprobe format 字段 |")
        lines.append("")

        lines.append("### 2. 延迟标记 (编码补齐的证据)")
        lines.append("")
        if m.present:
            lines.append("| 标记 | 样本数 | 毫秒 | 出处 |")
            lines.append("|---|---:|---:|---|")
            lines.append(f"| 头部 skip_samples | {m.head_skip_samples} | "
                         f"{_ms(m.head_skip_samples)} | 首包 side_data: Skip Samples |")
            lines.append(f"| 尾部 discard_padding | {m.tail_padding_samples} | "
                         f"{_ms(m.tail_padding_samples)} | 末包 side_data: Skip Samples |")
            if m.initial_padding is not None:
                lines.append(f"| 流级 initial_padding (旁证) | {m.initial_padding} | "
                             f"{_ms(m.initial_padding)} | ffprobe stream 字段 |")
            lines.append("")
            lines.append(f"恒等式核对: {ana.identity_detail}")
        else:
            lines.append("> ffprobe 未发现延迟标记, 编码补齐无法通过标记确认。")
        lines.append("")

        lines.append("### 3. 脉冲对齐 (忽略 vs 应用延迟标记)")
        lines.append("")
        lines.append("| 解码模式 | 片头脉冲下标 | 片头偏差 | 片尾脉冲下标 | 片尾偏差 |")
        lines.append("|---|---:|---:|---:|---:|")
        for dr, label in ((ana.applied, "应用标记"), (ana.ignored, "忽略标记")):
            if ana.ref_head_pulse is None:
                lines.append(f"| {label} | {dr.head_pulse_index} | 无参考, 无法确认 | "
                             f"{dr.tail_pulse_index} | 无参考, 无法确认 |")
                continue
            dh = (dr.head_pulse_index - ana.ref_head_pulse
                  if dr.head_pulse_index is not None else None)
            dt = (dr.tail_pulse_index - ana.ref_tail_pulse
                  if dr.tail_pulse_index is not None
                  and ana.ref_tail_pulse is not None else None)
            lines.append(
                f"| {label} | {dr.head_pulse_index} | "
                f"{dh:+d} 样本 / {_ms(abs(dh)) if dh is not None else 'N/A'} | "
                f"{dr.tail_pulse_index} | "
                f"{dt:+d} 样本 / {_ms(abs(dt)) if dt is not None else 'N/A'} |")
        if ana.ref_head_pulse is not None:
            lines.append("")
            lines.append(f"参考脉冲位置: 片头样本 {ana.ref_head_pulse}, "
                         f"片尾样本 {ana.ref_tail_pulse} "
                         f"(源自 {ana.ref_path.name})")
        lines.append("")

        lines.append("### 4. 片头/片尾空白分解 (编码补齐 vs 原始静音)")
        lines.append("")
        if ana.head_encoder_pad_samples is not None:
            lines.append("| 位置 | 编码补齐 (标记) | 原始静音 (参考 WAV 固有) |")
            lines.append("|---|---:|---:|")
            lines.append(f"| 片头 | {ana.head_encoder_pad_samples} 样本 / "
                         f"{_ms(ana.head_encoder_pad_samples)} | "
                         f"{ana.head_original_silence_samples} 样本 / "
                         f"{_ms(ana.head_original_silence_samples)} |")
            lines.append(f"| 片尾 | {ana.tail_encoder_pad_samples} 样本 / "
                         f"{_ms(ana.tail_encoder_pad_samples)} | "
                         f"{ana.tail_original_silence_samples} 样本 / "
                         f"{_ms(ana.tail_original_silence_samples)} |")
        else:
            lines.append("> 缺少参考 WAV 或标记, 分解无法确认 (见下节)。")
        lines.append("")

        lines.append("### 5. 可确认事实")
        lines.append("")
        for x in ana.facts:
            lines.append(f"- {x}")
        lines.append("")
        lines.append("### 6. 无法确认事项 (证据不足, 不做推测)")
        lines.append("")
        if ana.unknowns:
            for x in ana.unknowns:
                lines.append(f"- {x}")
        else:
            lines.append("- 无")
        lines.append("")

    out_path.write_text("\n".join(lines), encoding="utf-8")

    # 同步导出机器可读 JSON, 字段与界面数据结构一致
    json_path = out_path.with_suffix(".json")
    json_path.write_text(
        json.dumps([a.to_jsonable() for a in analyses],
                   ensure_ascii=False, indent=2),
        encoding="utf-8")
    return out_path


def write_decodings(ana: FileAnalysis, out_dir: Path) -> list[Path]:
    """把两种模式的解码裸 PCM 另存为可播放 WAV, 并各导出一份脉冲定位切片。

    切片规则 (依据全部写在报告里): 各模式片头脉冲前 20ms 起、取 60ms,
    便于直接听/看标记处理与否导致的头部空白差异。
    脉冲未检出时跳过切片并在返回说明里体现。
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    guard = round(0.020 * SAMPLE_RATE)
    clip_len = round(0.060 * SAMPLE_RATE)

    for dr in (ana.applied, ana.ignored):
        if dr is None:
            continue
        tag = "applied" if dr.mode == "applied" else "ignored"
        full_wav = out_dir / f"{ana.file_path.stem}.{tag}.decoded.wav"
        samples = read_pcm_samples(dr.pcm_path)
        write_wav(full_wav, samples)
        written.append(full_wav)

        if dr.head_pulse_index is not None:
            start = max(0, dr.head_pulse_index - guard)
            clip = samples[start:start + clip_len]
            clip_wav = out_dir / f"{ana.file_path.stem}.{tag}.head-clip.wav"
            write_wav(clip_wav, clip)
            written.append(clip_wav)
    return written


# ---------------------------------------------------------------------------
# 自检: 程序内生成样例, 跑完整链路并断言关键事实
# ---------------------------------------------------------------------------

def run_selftest(out_root: Path) -> list[FileAnalysis]:
    """生成参考 WAV + 两种压缩编码, 完整分析, 断言实测结论。

    断言只检查"结构成立"的事实 (标记存在、恒等式、应用模式对齐、
    忽略模式偏差为正), 不硬编码具体编码器版本的样本数。
    """
    out_root = Path(out_root)
    work = out_root / "work"
    exports = out_root / "exports"
    out_root.mkdir(parents=True, exist_ok=True)

    ref_wav = generate_reference_wav(out_root / "reference.wav")
    analyses: list[FileAnalysis] = []
    for key, spec in ENCODERS.items():
        compressed = encode_compressed(
            ref_wav, out_root / f"sample{spec['ext']}", key)
        ana = analyze_file(compressed, work / key, reference_wav=ref_wav)
        analyses.append(ana)

        # --- 断言: 这些是本工具设计上必须成立的事实, 失败即工具/环境异常 ---
        assert ana.markers.present, f"{key}: 未发现延迟标记"
        assert ana.identity_ok is True, f"{key}: 标记恒等式不成立: {ana.identity_detail}"
        assert ana.applied.head_pulse_index == ana.ref_head_pulse, \
            f"{key}: 应用标记后片头脉冲应与参考对齐"
        assert ana.ignored.head_pulse_index > ana.ref_head_pulse, \
            f"{key}: 忽略标记后脉冲位置应因头部延迟而后移"
        assert ana.head_encoder_pad_samples == ana.markers.head_skip_samples
        assert (ana.head_encoder_pad_samples
                + ana.head_original_silence_samples
                == ana.ignored.leading_silence_samples)

    report = write_report(analyses, exports / "report.md")
    for ana in analyses:
        write_decodings(ana, exports)
    print(f"[selftest] 参考 WAV : {ref_wav}")
    for ana in analyses:
        print(f"[selftest] {ana.file_path.name}: "
              f"skip={ana.markers.head_skip_samples} "
              f"pad={ana.markers.tail_padding_samples} "
              f"applied={ana.applied.sample_count} "
              f"ignored={ana.ignored.sample_count} "
              f"对齐偏差(应用)={ana.applied.head_pulse_index - ana.ref_head_pulse:+d}")
    print(f"[selftest] 报告: {report} (同名 .json)")
    print(f"[selftest] 导出目录: {exports}")
    return analyses


# ---------------------------------------------------------------------------
# CLI: 自检 / 单文件分析
# ---------------------------------------------------------------------------

def _cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m audio_delay_inspector.core",
        description="短音频片头片尾空白排查 (ffmpeg + PySide6 工具的核心层)")
    parser.add_argument("--selftest", metavar="DIR",
                        help="在 DIR 内生成样例并跑完整验证链路")
    parser.add_argument("--input", metavar="FILE",
                        help="分析外部压缩音频 (无参考模式, 只报告可确认事实)")
    parser.add_argument("--reference", metavar="WAV",
                        help="与 --input 配套的编码前参考 WAV (可选)")
    parser.add_argument("--outdir", metavar="DIR", default="analysis_out",
                        help="工作与导出目录 (默认 ./analysis_out)")
    args = parser.parse_args(argv)

    try:
        ensure_ffmpeg()
        if args.selftest:
            run_selftest(Path(args.selftest))
            return 0
        if args.input:
            ref = Path(args.reference) if args.reference else None
            ana = analyze_file(Path(args.input),
                               Path(args.outdir) / "work", ref)
            report = write_report([ana], Path(args.outdir) / "exports" / "report.md")
            write_decodings(ana, Path(args.outdir) / "exports")
            print(f"报告已导出: {report}")
            return 0
        parser.print_help()
        return 2
    except ToolDependencyError as e:
        print(f"[依赖缺失] {e}")
        return 3
    except RuntimeError as e:
        print(f"[分析失败] {e}")
        return 1


if __name__ == "__main__":
    raise SystemExit(_cli())
