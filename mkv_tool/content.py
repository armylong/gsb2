from __future__ import annotations

import re
from pathlib import Path

from .errors import MkvToolError, ffmpeg_path
from .runner import run_capture

_HASH_RE = re.compile(r"(?:SHA256|sha256)=([0-9a-fA-F]{32,128})")


def packet_stream_hash(
    path: str | Path, stream_index: int, *, ffmpeg: str | Path | None = None
) -> str:
    """Hash the codec packets as FFmpeg's streamhash muxer sees them.

    With ``-c copy`` this is a fast identity check that reordering/muxing did
    not substitute another stream.  The same source/output packet hash is
    stable when an MKV is remuxed.
    """
    exe = ffmpeg_path(ffmpeg)
    result = run_capture(
        [
            exe,
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(path),
            "-map",
            f"0:{stream_index}",
            "-c",
            "copy",
            "-f",
            "streamhash",
            "-hash",
            "sha256",
            "-",
        ]
    )
    if result.returncode != 0:
        raise MkvToolError(
            f"无法计算流 #{stream_index} 的内容哈希：\n{result.stderr_tail()}"
        )
    match = _HASH_RE.search(result.stdout_text)
    if not match:
        raise MkvToolError(f"流 #{stream_index} 没有返回可解析的 streamhash：{result.stdout_text}")
    return match.group(1).lower()
