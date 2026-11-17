"""ffmpeg 子进程执行与进度解析。"""
from __future__ import annotations

import shutil
import subprocess
from typing import Callable

ProgressCallback = Callable[[float, str], None]
# 参数：(0.0~1.0 的进度, 人类可读状态文本)


class FFmpegError(RuntimeError):
    """ffmpeg 返回非零退出码；保留尾部日志便于定位是哪个片段、什么原因。"""

    def __init__(self, message: str, log_tail: str = ""):
        super().__init__(message)
        self.log_tail = log_tail


def ffmpeg_bin() -> str:
    binary = shutil.which("ffmpeg")
    if not binary:
        raise FFmpegError("系统未找到 ffmpeg，请先安装 ffmpeg 并加入 PATH")
    return binary


def run_ffmpeg(
    args: list[str],
    total_duration: float | None = None,
    progress_cb: ProgressCallback | None = None,
    status_text: str = "",
) -> str:
    """执行 ffmpeg。

    - 统一加 -y -nostdin；进度走 -progress pipe:1，解析 out_time_ms。
    - 日志走 stderr，失败时抛出带最后 12 行日志的 FFmpegError。
    返回 ffmpeg stdout（进度行文本）。
    """
    cmd = [ffmpeg_bin(), "-y", "-nostdin", "-hide_banner", *args,
           "-progress", "pipe:1", "-nostats"]
    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
    except OSError as exc:
        raise FFmpegError(f"无法启动 ffmpeg：{exc}") from exc

    collected: list[str] = []
    assert proc.stdout is not None
    for line in proc.stdout:
        collected.append(line)
        if progress_cb and total_duration and line.startswith("out_time_ms="):
            raw = line.split("=", 1)[1].strip()
            try:
                # ffmpeg 的 out_time_ms 单位实际是微秒
                seconds = int(raw) / 1_000_000
                ratio = min(max(seconds / total_duration, 0.0), 1.0)
                progress_cb(ratio, status_text)
            except ValueError:
                pass

    _, stderr = proc.communicate()
    if proc.returncode != 0:
        tail = "\n".join(stderr.strip().splitlines()[-12:])
        raise FFmpegError(
            f"ffmpeg 退出码 {proc.returncode}：{tail.splitlines()[-1] if tail else '未知错误'}",
            log_tail=tail,
        )
    if progress_cb:
        progress_cb(1.0, status_text)
    return "".join(collected)
