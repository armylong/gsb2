"""媒体探测（ffprobe）与原始平面抽取（ffmpeg rawvideo / 裸 .yuv 直读）。

关键纪律：每个 Media 对象只承载**这一个文件**的声明，切帧不改变声明，
打开新文件时由调用方重新构造对象——绝不沿用上一个文件的 chroma_location。
"""
from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass, field

from .chroma import FFPROBE_SITE, ChromaSite
from .errors import MediaError, RawParamError, UnsupportedPixelFormat
from .formats import PixelFormat, lookup_pixel_format, split_planes


@dataclass
class MediaInfo:
    path: str
    width: int
    height: int
    pixel_format: PixelFormat
    frame_count: int
    fps: float
    declared_site: ChromaSite | None
    """媒体里声明的色度位置；None 表示未声明。"""
    declaration_note: str
    """声明缺失/无法识别/不支持时给用户看的原因。"""
    color_space: str | None
    color_range: str | None
    is_raw: bool
    matrix_key: str
    matrix_note: str
    full_range: bool
    frame_size: int
    # 已抽取的原始字节（短片段一次性驻留内存，保证逐帧随机访问）
    _raw: bytes | None = field(default=None, repr=False)

    @property
    def chroma_dims(self) -> tuple[int, int]:
        return self.pixel_format.chroma_dims(self.width, self.height)

    def read_frame_planes(self, index: int):
        """返回第 index 帧的 (Y, U, V) uint8 数组。"""
        if not 0 <= index < self.frame_count:
            raise MediaError(f"帧号 {index} 越界（共 {self.frame_count} 帧）")
        assert self._raw is not None
        start = index * self.frame_size
        return split_planes(
            self.pixel_format,
            self._raw[start : start + self.frame_size],
            self.width,
            self.height,
        )


def _run(cmd: list[str], binary: bool = False) -> str | bytes:
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=not binary,
            check=False,
            timeout=120,
        )
    except FileNotFoundError as e:
        raise MediaError(f"找不到 {cmd[0]}，请先安装 ffmpeg") from e
    except subprocess.TimeoutExpired as e:
        raise MediaError(f"命令超时：{' '.join(cmd)}") from e
    if proc.returncode != 0:
        stderr = proc.stderr
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", "replace")
        raise MediaError(
            f"{os.path.basename(cmd[0])} 失败（退出码 {proc.returncode}）：\n"
            f"{stderr.strip()[:800]}"
        )
    return proc.stdout


def _probe_stream(path: str) -> dict:
    out = _run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            path,
        ]
    )
    try:
        data = json.loads(out)
    except json.JSONDecodeError as e:
        raise MediaError("ffprobe 输出无法解析") from e
    streams = data.get("streams", [])
    if not streams:
        raise MediaError("文件中没有视频流")
    return streams[0]


def _parse_fps(rate: str | None) -> float:
    if not rate or rate == "0/0":
        return 0.0
    if "/" in rate:
        num, den = rate.split("/")
        den_f = float(den)
        return float(num) / den_f if den_f else 0.0
    return float(rate)


def _count_frames(path: str, stream: dict) -> int:
    declared = stream.get("nb_frames")
    if declared and declared != "N/A":
        try:
            return int(declared)
        except ValueError:
            pass
    out = _run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-count_frames",
            "-show_entries",
            "stream=nb_read_frames",
            "-of",
            "json",
            path,
        ]
    )
    try:
        return int(json.loads(out)["streams"][0]["nb_read_frames"])
    except (json.JSONDecodeError, KeyError, ValueError) as e:
        raise MediaError("无法确定视频帧数") from e


def _decode_declaration(stream: dict) -> tuple[ChromaSite | None, str]:
    """解析媒体声明的色度位置，连同缺失/不支持原因一起返回。"""
    raw = stream.get("chroma_location")
    if raw in (None, "", "unspecified"):
        return None, "媒体未声明 chroma_location（容器/码流缺失该字段）"
    site = FFPROBE_SITE.get(raw)
    if site is None:
        return None, f"媒体声明的 chroma_location={raw!r} 无法识别"
    return site, f"媒体声明：{site.label}"


def open_media(path: str) -> MediaInfo:
    """打开容器文件（mp4/mkv/mov/avi…），抽取全部原始帧到内存。"""
    if not os.path.isfile(path):
        raise MediaError(f"文件不存在：{path}")

    stream = _probe_stream(path)
    pix_fmt_name = stream.get("pix_fmt") or ""
    try:
        pf = lookup_pixel_format(pix_fmt_name)
    except UnsupportedPixelFormat:
        raise
    width = int(stream["width"])
    height = int(stream["height"])
    _, _, frame_size = pf.plane_sizes(width, height)
    frame_count = _count_frames(path, stream)

    # 直接以原始像素格式抽取，保持平面字节与码流一致（不做任何色彩转换）
    out = _run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            path,
            "-map",
            "0:v:0",
            "-f",
            "rawvideo",
            "-pix_fmt",
            pix_fmt_name,
            "-",
        ],
        binary=True,
    )
    expected = frame_size * frame_count
    if len(out) < expected:
        raise MediaError(
            f"抽取字节数不足：期望 {expected}，实际 {len(out)}（帧数探测可能有误）"
        )

    site, note = _decode_declaration(stream)
    from .color import matrix_from_ffprobe

    color_space = stream.get("color_space")
    color_range = stream.get("color_range")
    matrix_key, matrix_note = matrix_from_ffprobe(color_space)
    full_range = pf.full_range or color_range == "jpeg"

    return MediaInfo(
        path=os.path.abspath(path),
        width=width,
        height=height,
        pixel_format=pf,
        frame_count=frame_count,
        fps=_parse_fps(stream.get("avg_frame_rate")),
        declared_site=site,
        declaration_note=note,
        color_space=color_space if color_space not in (None, "unknown") else None,
        color_range=color_range if color_range not in (None, "unknown") else None,
        is_raw=False,
        matrix_key=matrix_key,
        matrix_note=matrix_note,
        full_range=full_range,
        frame_size=frame_size,
        _raw=out[: expected],
    )


# ---------- 裸 .yuv ----------

def parse_raw_filename(path: str) -> tuple[int, int, str] | None:
    """从文件名推断宽高与格式，如 clip_1920x1080_yuv420p.yuv。"""
    base = os.path.basename(path).lower()
    import re

    m = re.search(r"(\d{2,6})\s*[xX]\s*(\d{2,6})", base)
    if not m:
        return None
    w, h = int(m.group(1)), int(m.group(2))
    fmt = None
    for name in ("yuv420p", "yuvj420p", "yuv422p", "yuvj422p", "yuv444p",
                 "yuvj444p", "nv12", "nv21"):
        if name in base:
            fmt = name
            break
    if fmt is None:
        return None
    return w, h, fmt


def open_raw(
    path: str, width: int, height: int, pix_fmt_name: str
) -> MediaInfo:
    """打开裸 .yuv：无任何容器声明，chroma_location 必然为“缺失”。"""
    if not os.path.isfile(path):
        raise MediaError(f"文件不存在：{path}")
    pf = lookup_pixel_format(pix_fmt_name)
    _, _, frame_size = pf.plane_sizes(width, height)
    with open(path, "rb") as f:
        raw = f.read()
    if len(raw) < frame_size or len(raw) % frame_size != 0:
        raise RawParamError(
            f"文件 {len(raw)} 字节不能被单帧 {frame_size} 字节整除，"
            f"宽 {width} / 高 {height} / 格式 {pix_fmt_name} 可能不对"
        )
    frame_count = len(raw) // frame_size
    return MediaInfo(
        path=os.path.abspath(path),
        width=width,
        height=height,
        pixel_format=pf,
        frame_count=frame_count,
        fps=0.0,
        declared_site=None,
        declaration_note="裸 .yuv 无容器，天然不携带 chroma_location 声明",
        color_space=None,
        color_range=None,
        is_raw=True,
        matrix_key="bt601",
        matrix_note="裸 .yuv 无矩阵声明，回退 BT.601",
        full_range=pf.full_range,
        frame_size=frame_size,
        _raw=raw,
    )


def infer_raw_or_raise(path: str) -> MediaInfo:
    parsed = parse_raw_filename(path)
    if parsed is None:
        raise RawParamError(
            "裸 .yuv 文件名中无法推断宽高与像素格式，需要手动指定"
        )
    return open_raw(path, *parsed)
