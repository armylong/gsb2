"""ffprobe / ffmpeg 命令行封装。

只依赖系统里的 ffmpeg 二进制（macOS: brew install ffmpeg），
不绑定任何 Python 视频库，便于排查“播放器到底怎么解释这个文件”。
"""
from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass, field
from fractions import Fraction
from typing import List, Optional

from .geometry import (
    UnsupportedOrientationError,
    VideoGeometry,
    normalize_rotation,
)


class FFmpegNotFoundError(RuntimeError):
    pass


def find_ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if not exe:
        raise FFmpegNotFoundError(
            "未找到 ffmpeg，请先安装：brew install ffmpeg"
        )
    return exe


def find_ffprobe() -> str:
    exe = shutil.which("ffprobe")
    if not exe:
        raise FFmpegNotFoundError(
            "未找到 ffprobe，请先安装：brew install ffmpeg"
        )
    return exe


def _run(cmd: List[str]) -> subprocess.CompletedProcess:
    # 不用 shell，路径作为参数传递，避免注入与转义问题
    return subprocess.run(cmd, capture_output=True, text=True, check=False)


def ffprobe_json(path: str) -> dict:
    proc = _run(
        [
            find_ffprobe(),
            "-hide_banner",
            "-loglevel", "error",
            "-show_format",
            "-show_streams",
            "-print_format", "json",
            path,
        ]
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe 解析失败：{proc.stderr.strip()}")
    return json.loads(proc.stdout)


@dataclass
class AudioInfo:
    codec: str
    duration: Optional[float]
    channels: int


@dataclass
class ProbeResult:
    path: str
    geometry: VideoGeometry
    video_codec: str
    video_duration: Optional[float]
    container_duration: Optional[float]
    audio: Optional[AudioInfo]
    raw_rotation: Optional[float]          # 元数据里的原始角度（可能为 45 等）
    warnings: List[str] = field(default_factory=list)

    @property
    def has_audio(self) -> bool:
        return self.audio is not None


def _parse_fraction(text: Optional[str], default: Fraction = Fraction(1, 1)) -> Fraction:
    if not text or text in ("0:1", "0/1", "N/A"):
        return default
    if ":" in text:
        a, b = text.split(":", 1)
    else:
        a, b = text.split("/", 1)
    a, b = int(a), int(b)
    if b == 0 or a == 0:
        return default
    return Fraction(a, b)


def probe(path: str) -> ProbeResult:
    """读取一个 mp4/mov，返回几何 + 音轨 + 时长信息。

    方向不支持时不抛异常，而是在 geometry 里打上 unsupported_detail，
    让界面仍能展示“它为什么那样显示”，只是禁止导出。
    """
    data = ffprobe_json(path)
    streams = data.get("streams", [])
    vstreams = [s for s in streams if s.get("codec_type") == "video"]
    astreams = [s for s in streams if s.get("codec_type") == "audio"]
    if not vstreams:
        raise RuntimeError("文件中没有视频流")
    vs = vstreams[0]

    par = _parse_fraction(vs.get("sample_aspect_ratio"))
    raw_rotation, mirrored, matrix_warn = _read_display_matrix(vs)

    warnings = list(matrix_warn)
    unsupported = None
    rotation = 0
    if raw_rotation is not None:
        try:
            rotation = normalize_rotation(raw_rotation)
        except UnsupportedOrientationError as exc:
            unsupported = str(exc)
            rotation = int(round(raw_rotation)) % 360
    if mirrored:
        msg = (
            "显示矩阵含镜像翻转（display_hflip/display_vflip），"
            "本工具不处理镜像素材。"
        )
        unsupported = (unsupported + "；" + msg) if unsupported else msg
        warnings.append(msg)

    geom = VideoGeometry(
        coded_width=int(vs["width"]),
        coded_height=int(vs["height"]),
        par_num=par.numerator,
        par_den=par.denominator,
        rotation=rotation,
        mirrored=mirrored,
        unsupported_detail=unsupported,
    )

    audio = None
    if astreams:
        a = astreams[0]
        audio = AudioInfo(
            codec=a.get("codec_name", "unknown"),
            duration=_to_float(a.get("duration")),
            channels=int(a.get("channels", 0) or 0),
        )

    return ProbeResult(
        path=path,
        geometry=geom,
        video_codec=vs.get("codec_name", "unknown"),
        video_duration=_to_float(vs.get("duration")),
        container_duration=_to_float(data.get("format", {}).get("duration")),
        audio=audio,
        raw_rotation=raw_rotation,
        warnings=warnings,
    )


def _read_display_matrix(stream: dict):
    """从 side_data_list 里提取旋转角与镜像标志。

    ffprobe 对 displaymatrix 的 rotation 约定：逆时针为正，
    与 ffmpeg 的 -display_rotation 一致。
    """
    raw = None
    mirrored = False
    warns = []
    for sd in stream.get("side_data_list", []) or []:
        sd_type = sd.get("side_data_type", "")
        if "displaymatrix" in sd_type.lower() or "Display Matrix" in sd_type:
            if "rotation" in sd and sd["rotation"] is not None:
                raw = float(sd["rotation"])
            if sd.get("hflip") or sd.get("vflip"):
                mirrored = True
            # 部分 ffprobe 版本直接给出 3x3 矩阵，行列式为负即镜像
            matrix = sd.get("matrix")
            if matrix and len(matrix) == 9:
                det = (
                    matrix[0] * (matrix[4] * matrix[8] - matrix[5] * matrix[7])
                    - matrix[1] * (matrix[3] * matrix[8] - matrix[5] * matrix[6])
                    + matrix[2] * (matrix[3] * matrix[7] - matrix[4] * matrix[6])
                )
                if det < 0:
                    mirrored = True
    if raw is not None and abs(raw) < 1e-6:
        raw = 0.0
    return raw, mirrored, warns


def _to_float(text) -> Optional[float]:
    try:
        if text is None:
            return None
        return float(text)
    except (TypeError, ValueError):
        return None
