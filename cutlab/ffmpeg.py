"""ffmpeg / ffprobe 的最小封装。

所有对外部程序的调用都集中在这里，便于定位、报错与日志输出。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path
from typing import Iterable, Sequence


class FFmpegError(RuntimeError):
    """ffmpeg / ffprobe 调用失败。"""

    def __init__(self, message: str, command: Sequence[str] | None = None,
                 stderr: str = ""):
        super().__init__(message)
        self.command = list(command or [])
        self.stderr = stderr


def _find(env_name: str, exe: str) -> str:
    override = os.environ.get(env_name)
    if override:
        path = Path(override).expanduser()
        if path.is_file():
            return str(path)
        raise FFmpegError(f"{env_name} 指向的文件不存在: {override}")
    found = shutil.which(exe)
    if not found:
        raise FFmpegError(
            f"找不到 {exe}。请安装 ffmpeg（含 ffprobe），或设置环境变量 "
            f"{env_name} 指向可执行文件。macOS 可用: brew install ffmpeg"
        )
    return found


@lru_cache(maxsize=1)
def ffmpeg_path() -> str:
    return _find("CUTLAB_FFMPEG", "ffmpeg")


@lru_cache(maxsize=1)
def ffprobe_path() -> str:
    return _find("CUTLAB_FFPROBE", "ffprobe")


def version_line() -> str:
    try:
        out = subprocess.run(
            [ffmpeg_path(), "-version"], capture_output=True, text=True,
            timeout=20, check=False,
        ).stdout.splitlines()
        return out[0] if out else "ffmpeg (版本未知)"
    except Exception as exc:  # pragma: no cover - 仅在环境异常时触发
        return f"ffmpeg 不可用: {exc}"


def run(args: Iterable[str], *, stdin_bytes: bytes | None = None,
        timeout: float = 900, check: bool = True) -> subprocess.CompletedProcess:
    """运行命令并返回 CompletedProcess（bytes 模式，避免终端编码问题）。"""
    cmd = [str(a) for a in args]
    try:
        proc = subprocess.run(
            cmd, input=stdin_bytes, capture_output=True, timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        raise FFmpegError(f"无法执行 {cmd[0]}: {exc}", cmd) from exc
    except subprocess.TimeoutExpired as exc:
        raise FFmpegError(f"命令超时（{timeout:.0f}s）: {' '.join(cmd)}", cmd) from exc
    if check and proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip()
        raise FFmpegError(
            f"命令失败（退出码 {proc.returncode}）: {' '.join(cmd)}\n{err}",
            cmd, err,
        )
    return proc


def run_capture(args: Iterable[str], *, timeout: float = 900) -> bytes:
    return run(args, timeout=timeout).stdout


def ffprobe_json(path: str | Path, extra: Sequence[str] = ()) -> dict:
    cmd = [
        ffprobe_path(), "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", *extra, str(path),
    ]
    out = run_capture(cmd)
    try:
        return json.loads(out.decode("utf-8", "replace") or "{}")
    except json.JSONDecodeError as exc:
        raise FFmpegError(f"ffprobe 输出不是合法 JSON: {exc}", cmd) from exc


def ffprobe_frames(path: str | Path, selector: str,
                   entries: str = "best_effort_timestamp_time,key_frame,pict_type",
                   interval: str | None = None) -> list[dict]:
    cmd = [
        ffprobe_path(), "-v", "error", "-select_streams", selector,
        "-show_entries", f"frame={entries}", "-of", "json",
    ]
    if interval:
        cmd += ["-read_intervals", interval]
    cmd.append(str(path))
    data = json.loads(run_capture(cmd).decode("utf-8", "replace") or "{}")
    return data.get("frames", []) or []


def ffprobe_packets(path: str | Path, selector: str,
                    entries: str = "pts_time,duration_time,flags") -> list[dict]:
    cmd = [
        ffprobe_path(), "-v", "error", "-select_streams", selector,
        "-show_entries", f"packet={entries}", "-of", "json", str(path),
    ]
    data = json.loads(run_capture(cmd).decode("utf-8", "replace") or "{}")
    return data.get("packets", []) or []


def extract_frame_png(path: str | Path, out_path: str | Path,
                      absolute_time: float | None = None) -> Path:
    """抽取指定绝对时间点的一帧。

    ``absolute_time`` 是文件时间轴上的 PTS（不是“相对文件起点”的秒数），
    因此总是配合 ``-seek_timestamp 1`` 使用。
    """
    cmd = [ffmpeg_path(), "-v", "error", "-y"]
    if absolute_time is not None:
        cmd += ["-seek_timestamp", "1", "-ss", f"{max(absolute_time, 0.0):.6f}"]
    cmd += ["-i", str(path), "-frames:v", "1", "-update", "1", str(out_path)]
    run(cmd)
    return Path(out_path)


def extract_first_frame_rgb(path: str | Path) -> tuple[bytes, int, int]:
    """返回输出的第一帧（呈现顺序），RGB24 原始字节及尺寸。"""
    probe = ffprobe_json(path)
    video = next((s for s in probe.get("streams", [])
                  if s.get("codec_type") == "video"), None)
    if not video:
        raise FFmpegError(f"{path} 没有视频流")
    width, height = int(video["width"]), int(video["height"])
    cmd = [
        ffmpeg_path(), "-v", "error", "-i", str(path), "-map", "0:v:0",
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]
    data = run_capture(cmd)
    expected = width * height * 3
    if len(data) < expected:
        raise FFmpegError(
            f"读取首帧失败: 期望 {expected} 字节，实际 {len(data)} 字节 ({path})", cmd
        )
    return data[:expected], width, height


def extract_rgb_at(path: str | Path, time: float, width: int,
                   height: int) -> bytes:
    """按绝对 PTS 抽取一帧（配合 ``-seek_timestamp 1``）。"""
    cmd = [
        ffmpeg_path(), "-v", "error", "-seek_timestamp", "1",
        "-ss", f"{max(time, 0.0):.6f}",
        "-i", str(path), "-frames:v", "1", "-f", "rawvideo",
        "-pix_fmt", "rgb24", "-",
    ]
    data = run_capture(cmd)
    expected = width * height * 3
    if len(data) < expected:
        raise FFmpegError(f"读取 {time:.3f}s 处画面失败（{path}）", cmd)
    return data[:expected]


def extract_rgb_frame_number(path: str | Path, frame_number: int,
                             width: int, height: int) -> bytes:
    """按解码后的帧序号（0 起，不受时间戳影响）抽帧。

    某些 TS 的最后一帧无法通过 seek 命中（受 file 尾部索引限制），
    用 ``select=eq(n\\,N)`` 顺序解码能稳定拿到。
    """
    cmd = [
        ffmpeg_path(), "-v", "error", "-i", str(path), "-map", "0:v:0",
        "-vf", f"select=eq(n\\,{max(0, frame_number)})",
        "-fps_mode", "passthrough", "-frames:v", "1",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]
    data = run_capture(cmd)
    expected = width * height * 3
    if len(data) < expected:
        raise FFmpegError(f"读取第 {frame_number} 帧失败（{path}）", cmd)
    return data[:expected]


def first_frame_md5(path: str | Path) -> str | None:
    cmd = [
        ffmpeg_path(), "-v", "error", "-i", str(path), "-map", "0:v:0",
        "-frames:v", "1", "-f", "framemd5", "-",
    ]
    out = run_capture(cmd).decode("utf-8", "replace")
    for line in out.splitlines():
        if line and not line.startswith("#"):
            return line.rsplit(",", 1)[-1].strip()
    return None


def file_size(path: str | Path) -> int:
    try:
        return Path(path).stat().st_size
    except OSError:
        return 0
