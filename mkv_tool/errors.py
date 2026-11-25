from __future__ import annotations

import os
import shutil
from pathlib import Path


class MkvToolError(RuntimeError):
    """Base error for user-visible failures."""


class ToolMissingError(MkvToolError):
    pass


class SourceNotFoundError(MkvToolError):
    pass


class ProbeError(MkvToolError):
    pass


class UnsupportedScopeError(MkvToolError):
    pass


class ExportPlanError(MkvToolError):
    pass


class MuxError(MkvToolError):
    pass


class VerificationFailedError(MkvToolError):
    pass


class SampleGenerationError(MkvToolError):
    pass


def ffmpeg_path(explicit: str | Path | None = None) -> str:
    """Return an executable FFmpeg path.

    The MKV_TOOL_FFMPEG environment variable is useful for tests and portable
    installs.  FFprobe is resolved separately, with the adjacent binary as a
    fallback.
    """
    candidate = explicit or os.environ.get("MKV_TOOL_FFMPEG") or shutil.which("ffmpeg")
    if candidate and Path(candidate).exists():
        return str(candidate)
    raise ToolMissingError("找不到 ffmpeg。请安装 FFmpeg，或设置 MKV_TOOL_FFMPEG。")


def ffprobe_path(explicit: str | Path | None = None) -> str:
    candidate = explicit or os.environ.get("MKV_TOOL_FFPROBE") or shutil.which("ffprobe")
    if candidate and Path(candidate).exists():
        return str(candidate)

    # Common portable layout: ffmpeg and ffprobe in the same directory.
    ff = os.environ.get("MKV_TOOL_FFMPEG") or shutil.which("ffmpeg")
    if ff:
        adjacent = Path(ff).with_name("ffprobe")
        if adjacent.exists():
            return str(adjacent)
    raise ToolMissingError("找不到 ffprobe。请安装 FFmpeg，或设置 MKV_TOOL_FFPROBE。")


def require_source(path: str | Path) -> Path:
    p = Path(path).expanduser().absolute()
    if not p.exists():
        raise SourceNotFoundError(f"源文件不存在或已被移走：{p}")
    if not p.is_file():
        raise SourceNotFoundError(f"源路径不是文件：{p}")
    return p
