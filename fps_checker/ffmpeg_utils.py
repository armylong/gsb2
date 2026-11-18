"""ffmpeg / ffprobe 子进程封装。

只做成熟工具的调用包装, 不实现任何编解码器。
"""
from __future__ import annotations

import json
import shutil
import subprocess


class FFmpegError(RuntimeError):
    """ffmpeg / ffprobe 执行失败。"""


def ensure_tools() -> None:
    """确认 ffmpeg 与 ffprobe 在 PATH 中, 缺失时给出明确报错。"""
    missing = [name for name in ("ffmpeg", "ffprobe") if shutil.which(name) is None]
    if missing:
        raise FFmpegError(
            f"未找到 {', '.join(missing)}, 请先安装 ffmpeg 并确保其在 PATH 中"
        )


def run(cmd: list[str], *, stdin_data: bytes | None = None) -> bytes:
    """运行命令并返回 stdout; 失败时抛出带 stderr 摘要的异常。"""
    proc = subprocess.run(
        cmd,
        input=stdin_data,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        tail = proc.stderr.decode("utf-8", "replace").strip().splitlines()[-8:]
        raise FFmpegError(
            f"命令执行失败({proc.returncode}): {' '.join(cmd)}\n" + "\n".join(tail)
        )
    return proc.stdout


def ffprobe_json(args: list[str]) -> dict:
    """以 JSON 格式运行 ffprobe 并解析结果。"""
    out = run(["ffprobe", "-v", "error", *args, "-of", "json"])
    return json.loads(out.decode("utf-8"))


def probe_streams(path: str) -> dict:
    """读取容器与全部流的元数据。"""
    return ffprobe_json(["-show_format", "-show_streams", path])


def probe_frame_timestamps(path: str) -> list[float]:
    """逐帧读取视频流的实际显示时间戳(秒, 容器原始时间轴)。

    优先 pts_time, 缺失时回退 best_effort_timestamp_time。
    返回值按解码/显示顺序排列, VFR 文件各间隔可以不相等。
    """
    data = ffprobe_json([
        "-select_streams", "v:0",
        "-show_entries", "frame=pts_time,best_effort_timestamp_time",
        path,
    ])
    stamps: list[float] = []
    for frame in data.get("frames", []):
        raw = frame.get("pts_time")
        if raw in (None, "N/A"):
            raw = frame.get("best_effort_timestamp_time")
        if raw in (None, "N/A"):
            raise FFmpegError(f"ffprobe 无法给出帧时间戳: {path}")
        stamps.append(float(raw))
    if not stamps:
        raise FFmpegError(f"文件中没有可解码的视频帧: {path}")
    return stamps


def extract_frames(path: str, out_pattern: str) -> None:
    """把视频帧逐帧解码为 JPEG 序列, passthrough 模式保留 VFR 原始节奏。

    out_pattern 形如 /tmp/work/frame_%06d.jpg, 序号从 1 开始,
    调用方按显示顺序减一即可与探测时间戳对齐。
    """
    run([
        "ffmpeg", "-y", "-v", "error",
        "-i", path,
        "-map", "0:v:0",
        "-fps_mode", "passthrough",
        "-q:v", "2",
        out_pattern,
    ])


def extract_audio(path: str, out_path: str, *, start_seconds: float = 0.0) -> bool:
    """抽取音频转 AAC; 没有音频流时返回 False。"""
    meta = probe_streams(path)
    has_audio = any(s.get("codec_type") == "audio" for s in meta.get("streams", []))
    if not has_audio:
        return False
    cmd = ["ffmpeg", "-y", "-v", "error"]
    if start_seconds > 0:
        cmd += ["-ss", f"{start_seconds:.6f}"]
    cmd += [
        "-i", path,
        "-map", "0:a:0",
        "-c:a", "aac", "-b:a", "192k",
        out_path,
    ]
    run(cmd)
    return True


def encode_pipe(
    frame_paths: list[str],
    fps: int,
    out_path: str,
    *,
    audio_path: str | None = None,
    on_progress=None,
) -> None:
    """按给定帧顺序编码恒定帧率 mp4。

    帧 JPEG 从 stdin 管道喂入 image2pipe, 输入输出都锁为 fps,
    输出帧时间戳由 ffmpeg 按 1/fps 等间距生成(CFR)。
    音频作为第二输入原样并入, 不做拉伸或重采样变速。
    """
    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-f", "image2pipe", "-framerate", str(fps), "-i", "-",
    ]
    if audio_path:
        cmd += ["-i", audio_path]
    cmd += [
        "-map", "0:v:0",
    ]
    if audio_path:
        cmd += ["-map", "1:a:0?", "-c:a", "aac", "-b:a", "192k"]
    cmd += [
        "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-r", str(fps),
        "-fps_mode", "cfr",
        out_path,
    ]
    proc = subprocess.Popen(
        cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    assert proc.stdin is not None
    total = len(frame_paths)
    try:
        for i, p in enumerate(frame_paths):
            with open(p, "rb") as fh:
                proc.stdin.write(fh.read())
            if on_progress and (i % 10 == 0 or i == total - 1):
                on_progress(i + 1, total)
        proc.stdin.close()
    except BrokenPipeError:
        pass
    stderr = proc.stderr.read()
    code = proc.wait()
    if code != 0:
        tail = stderr.decode("utf-8", "replace").strip().splitlines()[-8:]
        raise FFmpegError("编码失败:\n" + "\n".join(tail))
