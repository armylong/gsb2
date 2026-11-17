"""concat demuxer 拼接：中间片规格一致，直接流拷贝，不重新编码。

相比 filter_complex concat，流拷贝不会在交界处补帧或重排时间戳，
从机制上避免黑帧、重复片段与音画偏移。
"""
from __future__ import annotations

import os

from .runner import FFmpegError, run_ffmpeg


def write_concat_list(clip_paths: list[str], list_path: str) -> str:
    """写 ffmpeg concat 列表文件；路径按 ffmpeg 规则转义单引号。"""
    lines = []
    for path in clip_paths:
        escaped = path.replace("'", "'\\''")
        lines.append(f"file '{escaped}'")
    with open(list_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    return list_path


def concat_clips(clip_paths: list[str], output_path: str,
                 work_dir: str) -> str:
    if not clip_paths:
        raise FFmpegError("没有可拼接的片段")
    # 拼接前确认每个中间片真实存在，否则给出明确片段而非 ffmpeg 的模糊报错
    missing = [p for p in clip_paths if not os.path.isfile(p)]
    if missing:
        raise FFmpegError(f"中间片缺失，无法拼接：{missing[0]}")
    list_path = os.path.abspath(os.path.join(work_dir, "concat_list.txt"))
    write_concat_list(clip_paths, list_path)

    args = [
        "-f", "concat", "-safe", "0",
        "-i", list_path,
        "-c", "copy",
        "-movflags", "+faststart",
        output_path,
    ]
    # 流拷贝很快，没有逐帧进度；直接捕获失败日志
    run_ffmpeg(args, total_duration=None, progress_cb=None,
               status_text="流拷贝拼接")
    _verify_list_consumed(list_path, len(clip_paths))
    return output_path


def _verify_list_consumed(list_path: str, expected: int) -> None:
    with open(list_path, encoding="utf-8") as fh:
        actual = sum(1 for line in fh if line.startswith("file "))
    if actual != expected:
        raise FFmpegError(
            f"拼接列表条目数异常：期望 {expected}，实际 {actual}")
