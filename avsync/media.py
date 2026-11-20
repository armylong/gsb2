"""ffmpeg/ffprobe 后端：样例生成、解码、标记检测、按规则导出。

所有时间统一使用“显示时间轴”：t=0 是视频流起点，音频波形的时间 =
音频流相对视频的起点偏移 + 采样点 / 采样率。音频比视频早开始时偏移为负，
波形视图因此保留负时间区。
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import wave
from dataclasses import dataclass, field

import numpy as np

FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"

# ---- 内置样例参数 ----
FPS = 25
SR = 48000
DURATION = 10.0
EVENTS = [1.0, 3.0, 5.0, 7.0, 9.0]      # 闪屏 + 蜂鸣同时发生的时刻
FLASH_DUR = 1.0 / FPS                    # 闪 1 帧
BEEP_DUR = 0.05                          # 50 ms 蜂鸣
BEEP_FREQ = 1000.0
WIDTH, HEIGHT = 640, 360


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    p = subprocess.run(cmd, capture_output=True)
    if p.returncode != 0:
        raise RuntimeError(
            "命令失败: %s\n%s" % (" ".join(cmd), p.stderr.decode("utf-8", "replace")[-2000:])
        )
    return p


# ---------------------------------------------------------------- 探测

@dataclass
class MediaInfo:
    path: str
    video_start: float = 0.0
    audio_start: float = 0.0   # 相对视频起点的偏移（可能为负）
    fps: float = FPS
    duration: float = 0.0
    has_audio: bool = True


def probe(path: str) -> MediaInfo:
    out = _run([FFPROBE, "-v", "quiet", "-print_format", "json",
                "-show_streams", "-show_format", path]).stdout
    data = json.loads(out)
    info = MediaInfo(path=path, duration=float(data["format"]["duration"]))
    vstart = 0.0
    astart = 0.0
    info.has_audio = False
    for s in data["streams"]:
        st = float(s.get("start_time") or 0.0)
        if s["codec_type"] == "video":
            vstart = st
            num, den = s["r_frame_rate"].split("/")
            info.fps = float(num) / float(den)
        elif s["codec_type"] == "audio":
            astart = st
            info.has_audio = True
    info.video_start = 0.0                      # 时间轴零点 = 视频起点
    info.audio_start = astart - vstart          # 相对偏移，可为负
    return info


# ---------------------------------------------------------------- 样例生成

def _enable_expr(events, dur):
    # filtergraph 里逗号要转义
    return "+".join(f"between(t\\,{t:.3f}\\,{t + dur:.3f})" for t in events)


def make_sample(path: str, offset_ms: float = 0.0, duration: float = DURATION) -> str:
    """生成内置样例：偶数秒闪白帧并同时蜂鸣。

    offset_ms > 0：声音晚于画面（音轨整体后移）
    offset_ms < 0：声音早于画面（音轨整体前移，头部被切）
    返回实际写入的路径。
    """
    flashes = _enable_expr(EVENTS, FLASH_DUR - 0.001)
    beeps = _enable_expr(EVENTS, BEEP_DUR)
    vsrc = (f"color=c=0x181818:s={WIDTH}x{HEIGHT}:r={FPS}:d={duration},"
            f"drawbox=w=iw:h=ih:c=white:t=fill:enable='{flashes}'")
    asrc = (f"aevalsrc=exprs=sin(2*PI*{BEEP_FREQ:.0f}*t)*({beeps}):s={SR}:d={duration}")
    shift = build_audio_filter(offset_ms / 1000.0, "truncate", "truncate", duration)
    cmd = [FFMPEG, "-y",
           "-f", "lavfi", "-i", vsrc,
           "-f", "lavfi", "-i", asrc,
           "-filter_complex", f"[1:a]{shift}[a]",
           "-map", "0:v", "-map", "[a]",
           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
           "-c:a", "aac", "-b:a", "192k",
           "-movflags", "+faststart", path]
    _run(cmd)
    return path


# ---------------------------------------------------------------- 修正规则

def build_audio_filter(shift_s: float, head_mode: str, tail_mode: str,
                       ref_dur: float) -> str:
    """整体音轨修正量的唯一实现：GUI 预览与导出共用此函数。

    shift_s > 0 音轨后移（头部必然补静音）；shift_s < 0 音轨前移。
    head_mode: 'truncate' 切掉 t<0 的音频 / 'pad' 保留（负时间戳，交给容器编辑表）
    tail_mode: 'truncate' 切掉超出视频末尾的部分 / 'pad' 末尾补静音到视频长度
    （在不适用的方向上对应选项为无操作，GUI 会禁用）
    """
    parts: list[str] = []
    ms = round(shift_s * 1000)
    if ms > 0:
        parts.append(f"adelay={ms}:all=1")            # 头部补静音
        if tail_mode == "truncate":
            parts.append(f"atrim=0:{ref_dur:.6f}")    # 切掉探出视频末尾的部分
        # tail 'pad'：保留自然长度（输出比视频长）
    elif ms < 0:
        if head_mode == "truncate":
            parts.append(f"atrim=start={-shift_s:.6f}")  # 切掉 t<0 的头部
            parts.append("asetpts=PTS-STARTPTS")
        else:  # pad：保留 t<0 内容（负 pts，mp4 用编辑表表示）
            parts.append(f"asetpts=PTS{shift_s:+.6f}/TB")
        if tail_mode == "pad":
            parts.append(f"apad=whole_dur={ref_dur:.6f}")  # 末尾补静音到视频长度
        # tail 'truncate'：保持缩短后的长度
    else:
        if tail_mode == "truncate":
            parts.append(f"atrim=0:{ref_dur:.6f}")
        else:
            parts.append(f"apad=whole_dur={ref_dur:.6f}")
    return ",".join(parts) if parts else "anull"


def export(src: str, dst: str, shift_s: float, head_mode: str, tail_mode: str,
           ref_dur: float | None = None) -> str:
    """按修正规则重新解码输出（视频、音频都重编码）。"""
    if ref_dur is None:
        ref_dur = probe(src).duration
    chain = build_audio_filter(shift_s, head_mode, tail_mode, ref_dur)
    cmd = [FFMPEG, "-y", "-i", src,
           "-filter_complex", f"[0:a]{chain}[a]",
           "-map", "0:v", "-map", "[a]",
           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
           "-c:a", "aac", "-b:a", "192k",
           "-movflags", "+faststart", dst]
    _run(cmd)
    return dst


# ---------------------------------------------------------------- 解码

def extract_audio(path: str, sr: int = SR) -> tuple[np.ndarray, int, float]:
    """解码为单声道 int16，返回 (samples, sr, 相对视频起点的偏移秒)。"""
    info = probe(path)
    if not info.has_audio:
        raise RuntimeError("文件没有音频流")
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        tmp = tf.name
    try:
        _run([FFMPEG, "-y", "-i", path, "-map", "0:a:0",
              "-ac", "1", "-ar", str(sr), "-f", "wav", tmp])
        with wave.open(tmp, "rb") as w:
            raw = w.readframes(w.getnframes())
        data = np.frombuffer(raw, dtype=np.int16).copy()
        return data, sr, info.audio_start
    finally:
        os.unlink(tmp)


def decode_frames(path: str, width: int = 160) -> tuple[list[np.ndarray], float, float]:
    """解码全部帧为 RGB 缩略图，返回 (frames, fps, 视频起点)。

    第 i 帧的显示时间 = 视频起点 + i / fps。
    """
    info = probe(path)
    fps = info.fps
    vf = f"fps={fps:.6f},scale={width}:-2"
    p = _run([FFMPEG, "-i", path, "-vf", vf,
              "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
    # 从 ffmpeg stderr 拿缩放后的高度不行（已丢弃），改为自己算：
    # 重新探测缩放尺寸太麻烦，用固定比例解析：先 probe 宽高
    out = _run([FFPROBE, "-v", "quiet", "-print_format", "json",
                "-show_streams", path]).stdout
    for s in json.loads(out)["streams"]:
        if s["codec_type"] == "video":
            w, h = s["width"], s["height"]
            break
    h2 = round(h * width / w)
    h2 += h2 % 2  # -2 对齐到偶数
    frame_size = width * h2 * 3
    raw = p.stdout
    n = len(raw) // frame_size
    arr = np.frombuffer(raw[: n * frame_size], dtype=np.uint8)
    frames = [f.reshape(h2, width, 3).copy() for f in arr.reshape(n, h2, width, 3)]
    return frames, fps, info.video_start


# ---------------------------------------------------------------- 标记检测

def detect_flash_times(path: str) -> list[float]:
    """检测闪白帧，返回每段闪光首帧的显示时间。"""
    frames, fps, vstart = decode_frames(path, width=64)
    luma = np.array([f.mean() for f in frames])
    thresh = max(80.0, luma.mean() + 6 * luma.std())
    hot = luma > thresh
    times, i = [], 0
    while i < len(hot):
        if hot[i]:
            times.append(vstart + i / fps)   # 闪光段首帧的帧起点
            while i < len(hot) and hot[i]:
                i += 1
        else:
            i += 1
    return times


def detect_beep_times(path: str) -> list[float]:
    """检测蜂鸣脉冲起点（包络过阈），返回显示时间。"""
    data, sr, astart = extract_audio(path)
    env = np.abs(data.astype(np.float32))
    # 1 ms 滑动最大值包络
    win = max(1, sr // 1000)
    env = np.maximum.reduceat(env, np.arange(0, len(env), win))
    thresh = 0.3 * env.max()
    hot = env > thresh
    times, i = [], 0
    while i < len(hot):
        if hot[i]:
            times.append(astart + (i * win) / sr)
            while i < len(hot) and hot[i]:
                i += 1
        else:
            i += 1
    return times


def pair_residuals(flashes: list[float], beeps: list[float],
                   max_gap: float = 0.5) -> list[tuple[float, float, float]]:
    """按最近邻配对闪光与蜂鸣，返回 [(flash_t, beep_t, flash_t - beep_t)]。"""
    pairs = []
    used = set()
    for f in flashes:
        best, bd = None, max_gap
        for j, b in enumerate(beeps):
            if j in used:
                continue
            if abs(f - b) < bd:
                best, bd = j, abs(f - b)
        if best is not None:
            used.add(best)
            pairs.append((f, beeps[best], f - beeps[best]))
    return pairs


def suggest_correction(path: str) -> dict:
    """自动检测并给出修正量：corr = 中位数(闪光时刻 - 蜂鸣时刻)。"""
    flashes = detect_flash_times(path)
    beeps = detect_beep_times(path)
    pairs = pair_residuals(flashes, beeps)
    if not pairs:
        raise RuntimeError("未检测到可配对的闪光/蜂鸣标记")
    diffs = np.array([d for _, _, d in pairs])
    return {
        "flashes": flashes,
        "beeps": beeps,
        "pairs": pairs,
        "correction_s": float(np.median(diffs)),
        "max_abs_diff": float(np.abs(diffs).max()),
    }
