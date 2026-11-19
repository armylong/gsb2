"""转场方案(Plan)、ffmpeg 滤镜图构建、渲染与回读校验.

时间轴约定(输出时间):
  A 段画面/声音: [0, len_a]
  B 段画面/声音: [offset, offset + len_b]   offset = len_a - duration
  重叠(转场)区:  [offset, len_a]
  成品总时长:     total = len_a + len_b - duration
视频用 xfade、音频用 acrossfade, 两者使用同一 offset 与 duration, 保证音画同起止.
"""
from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass

from .media import (FPS, FRAME, HEIGHT, MAX_TRANSITION, MIN_TRANSITION, WIDTH,
                    MediaError, probe_streams, require_ffmpeg, run)

TRANSITION_KINDS = ("fade", "slide", "fadeblack")
TRANSITION_LABELS = {"fade": "叠化", "slide": "水平推移", "fadeblack": "淡黑"}
SLIDE_DIRECTIONS = ("left", "right")
SLIDE_DIRECTION_LABELS = {"left": "向左推移(B 从右进入)", "right": "向右推移(B 从左进入)"}


@dataclass
class ClipSpec:
    path: str
    in_point: float    # 源区间入点(秒)
    out_point: float   # 源区间出点(秒)

    @property
    def length(self) -> float:
        return self.out_point - self.in_point


@dataclass
class Plan:
    clip_a: ClipSpec
    clip_b: ClipSpec
    kind: str = "fade"          # fade | slide | fadeblack
    direction: str = "left"     # 仅 slide 有效
    duration: float = 1.0       # 转场时长(秒)

    @property
    def len_a(self) -> float:
        return self.clip_a.length

    @property
    def len_b(self) -> float:
        return self.clip_b.length

    @property
    def offset(self) -> float:
        """转场起点 = B 段在输出时间轴上的入点."""
        return self.len_a - self.duration

    @property
    def total(self) -> float:
        """成品时长 = 两段长度之和 - 转场长度."""
        return self.len_a + self.len_b - self.duration

    @property
    def xfade_name(self) -> str:
        if self.kind == "slide":
            return "slideleft" if self.direction == "left" else "slideright"
        return self.kind

    def errors(self) -> list[str]:
        errs: list[str] = []
        if self.kind not in TRANSITION_KINDS:
            errs.append(f"未知转场类型: {self.kind}")
        if not (MIN_TRANSITION <= self.duration <= MAX_TRANSITION):
            errs.append(f"转场时长须在 {MIN_TRANSITION}~{MAX_TRANSITION} 秒之间")
        if self.len_a <= 0:
            errs.append("A 段保留区间为空(出点须大于入点)")
        if self.len_b <= 0:
            errs.append("B 段保留区间为空(出点须大于入点)")
        if self.len_a > 0 and self.duration > self.len_a:
            errs.append(
                f"转场时长 {self.duration:.2f}s 超过 A 段保留区间 {self.len_a:.2f}s")
        if self.len_b > 0 and self.duration > self.len_b:
            errs.append(
                f"转场时长 {self.duration:.2f}s 超过 B 段保留区间 {self.len_b:.2f}s")
        return errs


def _video_chain(index: int, clip: ClipSpec, label: str) -> str:
    """裁剪源区间并归一化到 720p30, 保持比例补黑边."""
    return (
        f"[{index}:v]trim=start={clip.in_point:.6f}:end={clip.out_point:.6f},"
        f"setpts=PTS-STARTPTS,fps={FPS},"
        f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
        f"pad={WIDTH}:{HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black,"
        f"setsar=1,format=yuv420p[{label}]"
    )


def _audio_chain(index: int, clip: ClipSpec, length: float, label: str) -> str:
    """裁剪源区间音频, 统一采样率/声道, 并强制区间长度(不足补静音)."""
    return (
        f"[{index}:a]atrim=start={clip.in_point:.6f}:end={clip.out_point:.6f},"
        f"asetpts=PTS-STARTPTS,"
        f"aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,"
        f"apad,atrim=duration={length:.6f}[{label}]"
    )


def build_filter_complex(plan: Plan) -> str:
    """视频 xfade 与音频 acrossfade 共用同一 offset/duration."""
    parts = [
        _video_chain(0, plan.clip_a, "v0"),
        _video_chain(1, plan.clip_b, "v1"),
        f"[v0][v1]xfade=transition={plan.xfade_name}"
        f":duration={plan.duration:.6f}:offset={plan.offset:.6f},"
        f"format=yuv420p[v]",
        _audio_chain(0, plan.clip_a, plan.len_a, "a0"),
        _audio_chain(1, plan.clip_b, plan.len_b, "a1"),
        f"[a0][a1]acrossfade=d={plan.duration:.6f}:c1=tri:c2=tri,"
        f"apad,atrim=duration={plan.total:.6f}[a]",
    ]
    return ";".join(parts)


def render(plan: Plan, out_path: str) -> None:
    """按方案渲染 mp4(720p30, h264+aac). 不会改动原始素材."""
    errs = plan.errors()
    if errs:
        raise MediaError("方案不合法:\n" + "\n".join(errs))
    require_ffmpeg()
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    run([
        "ffmpeg", "-y", "-v", "error",
        "-i", plan.clip_a.path, "-i", plan.clip_b.path,
        "-filter_complex", build_filter_complex(plan),
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-c:a", "aac", "-b:a", "192k",
        "-r", str(FPS), "-movflags", "+faststart",
        out_path,
    ])


def readback(path: str) -> dict:
    """回读导出文件的实际时长/音频末端/帧数."""
    return probe_streams(path, count_frames=True)


def check_readback(plan: Plan, path: str) -> dict:
    """对比实际与预计, 偏差以输出帧为单位."""
    info = readback(path)
    expected = plan.total
    dur_dev = abs(info["duration"] - expected)
    audio_dev = (abs(info["audio_duration"] - expected)
                 if info["audio_duration"] is not None else None)
    expected_frames = round(expected * FPS)
    result = {
        "expected_duration": expected,
        "actual_duration": info["duration"],
        "duration_deviation_frames": dur_dev / FRAME,
        "audio_duration": info["audio_duration"],
        "audio_deviation_frames": (audio_dev / FRAME) if audio_dev is not None else None,
        "expected_frames": expected_frames,
        "actual_frames": info["nb_frames"],
        "ok": dur_dev <= FRAME + 1e-6
        and (audio_dev is None or audio_dev <= FRAME + 1e-6)
        and (info["nb_frames"] is None or info["nb_frames"] == expected_frames),
    }
    return result


def extract_frame_rgb(video_path: str, t: float) -> tuple[bytes, int, int]:
    """抽取 t 秒处一帧, 返回 (rgb24 字节, 宽, 高). 精确seek."""
    require_ffmpeg()
    proc = subprocess.run([
        "ffmpeg", "-v", "error", "-ss", f"{t:.6f}", "-i", video_path,
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0 or not proc.stdout:
        raise MediaError(
            f"无法抽取 {t:.3f}s 处画面: "
            + proc.stderr.decode("utf-8", "replace")[-500:])
    # 分辨率以实际输出为准(预览/导出均为 1280x720)
    w, h = WIDTH, HEIGHT
    if len(proc.stdout) != w * h * 3:
        raise MediaError(f"抽取帧大小异常: {len(proc.stdout)} 字节")
    return proc.stdout, w, h


def extract_frame_png(video_path: str, t: float, png_path: str) -> None:
    """抽取 t 秒处一帧保存为 PNG(供界面显示)."""
    require_ffmpeg()
    run([
        "ffmpeg", "-y", "-v", "error", "-ss", f"{t:.6f}", "-i", video_path,
        "-frames:v", "1", png_path,
    ])
    if not os.path.exists(png_path):
        raise MediaError(f"无法抽取 {t:.3f}s 处画面")
