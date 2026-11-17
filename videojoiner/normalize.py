"""把任意片段统一转码成完全一致的中间规格。

统一项：分辨率（contain 填充 / cover 裁切）、帧率、像素格式、SAR、
音频采样率/声道数/编码；无音频片段补等长静音轨。
所有中间片参数一致后，concat demuxer 才能直接流拷贝且交界不出问题。
"""
from __future__ import annotations

import os

from .probe import MediaInfo
from .runner import ProgressCallback, run_ffmpeg

SAMPLE_RATE = 48000
PIX_FMT = "yuv420p"
VIDEO_CODEC = "libx264"
AUDIO_CODEC = "aac"


def build_video_filter(width: int, height: int, fps: float, fit: str) -> str:
    """生成视频滤镜链。fit: 'contain'（等比缩放+黑边）或 'cover'（等比放大+裁切）。

    两种方式都只做等比变换，绝不拉伸画面；setsar=1 保证像素宽高比为 1。
    """
    if fit == "contain":
        fit_chain = (
            f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black"
        )
    elif fit == "cover":
        fit_chain = (
            f"scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height}"
        )
    else:
        raise ValueError(f"未知适配方式：{fit!r}（仅支持 contain / cover）")
    # fps 放最前：先把输入帧率统一，再做几何变换
    # scale 显式 in/out range=full：样例等全范围素材不会被按有限范围压暗，
    # 有限范围素材也能正确往返，避免颜色漂移影响顺序核对
    return (
        f"fps={fps},{fit_chain},"
        f"scale=in_range=full:out_range=full,"
        f"setsar=1,format={PIX_FMT}"
    )


def _audio_filter(duration: float) -> str:
    # apad 不足则补静音、atrim 超长则裁掉，保证音轨与视频等长、不错位
    return (
        f"aresample={SAMPLE_RATE},"
        f"aformat=sample_rates={SAMPLE_RATE}:channel_layouts=stereo,"
        f"apad,atrim=0:{duration:.6f},asetpts=N/SR/TB"
    )


def normalize_clip(
    info: MediaInfo,
    out_path: str,
    width: int,
    height: int,
    fps: float,
    fit: str,
    progress_cb: ProgressCallback | None = None,
) -> str:
    """转码单个片段到统一规格，返回输出路径。"""
    duration = info.duration
    vf = build_video_filter(width, height, fps, fit)
    common_out = [
        "-c:v", VIDEO_CODEC, "-preset", "medium", "-crf", "20",
        "-pix_fmt", PIX_FMT,
        "-c:a", AUDIO_CODEC, "-b:a", "192k", "-ar", str(SAMPLE_RATE), "-ac", "2",
        "-movflags", "+faststart",
        "-t", f"{duration:.6f}",
        out_path,
    ]
    status = f"统一规格化 {os.path.basename(info.path)}"

    if info.has_audio:
        args = [
            "-i", info.path,
            "-filter_complex", f"[0:v]{vf}[v];[0:a]{_audio_filter(duration)}[a]",
            "-map", "[v]", "-map", "[a]",
            *common_out,
        ]
    else:
        # 无声音片段：生成等长静音源作为独立输入，规则与有声片段完全一致
        args = [
            "-i", info.path,
            "-f", "lavfi", "-t", f"{duration:.6f}",
            "-i", f"anullsrc=channel_layout=stereo:sample_rate={SAMPLE_RATE}",
            "-filter_complex", f"[0:v]{vf}[v]",
            "-map", "[v]", "-map", "1:a",
            *common_out,
        ]

    run_ffmpeg(args, total_duration=duration, progress_cb=progress_cb,
               status_text=status)
    return out_path
