"""编码/导出管线:raw 帧 -> ffmpeg(无损 x264rgb),再把源音轨原样拷回。"""
from __future__ import annotations

import subprocess
import shutil


def _ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if not exe:
        raise RuntimeError("未找到 ffmpeg,请先安装(brew install ffmpeg)")
    return exe


def encode_lossless(frames, path: str, fps: float, size: tuple[int, int],
                    audio_src: str | None = None) -> None:
    """把 BGR uint8 帧序列写成无损视频(libx264rgb,crf 0)。

    无损是为了让"带外像素未被改写"可以被逐字节核对。
    audio_src 给定时,用第二条 ffmpeg 命令把其音轨 -c copy 复用进来。
    """
    w, h = size
    tmp = path if audio_src is None else path + ".novideoaudio.mkv"
    cmd = [_ffmpeg(), "-y",
           "-f", "rawvideo", "-pix_fmt", "bgr24",
           "-s", f"{w}x{h}", "-r", f"{fps:.6f}", "-i", "-",
           "-c:v", "libx264rgb", "-crf", "0", "-preset", "veryfast",
           "-pix_fmt", "rgb24", tmp]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        for f in frames:
            proc.stdin.write(f.tobytes())
        proc.stdin.close()
        if proc.wait() != 0:
            raise RuntimeError("ffmpeg 编码失败:\n" + proc.stderr.read().decode("utf-8", "replace")[-2000:])
    except BrokenPipeError:
        raise RuntimeError("ffmpeg 编码中断:\n" + proc.stderr.read().decode("utf-8", "replace")[-2000:])

    if audio_src is not None:
        # 只拷音轨,不重编码;源无音轨时 -map 1:a? 自动跳过
        cmd2 = [_ffmpeg(), "-y", "-i", tmp, "-i", audio_src,
                "-map", "0:v", "-map", "1:a?", "-c:v", "copy", "-c:a", "copy",
                path]
        r = subprocess.run(cmd2, capture_output=True)
        if r.returncode != 0:
            raise RuntimeError("ffmpeg 复用音轨失败:\n" + r.stderr.decode("utf-8", "replace")[-2000:])
        import os
        os.remove(tmp)


def probe(path: str) -> dict:
    """ffprobe 取时长/帧数/帧率/是否有音轨。"""
    exe = shutil.which("ffprobe") or "ffprobe"
    cmd = [exe, "-v", "error", "-show_entries",
           "format=duration:stream=codec_type,nb_frames,r_frame_rate",
           "-of", "json", path]
    r = subprocess.run(cmd, capture_output=True, text=True)
    import json
    data = json.loads(r.stdout)
    info = {"duration": float(data["format"]["duration"]), "has_audio": False,
            "nb_frames": None, "fps": None}
    for s in data.get("streams", []):
        if s["codec_type"] == "video":
            info["nb_frames"] = int(s.get("nb_frames") or 0)
            num, den = s["r_frame_rate"].split("/")
            info["fps"] = float(num) / float(den)
        elif s["codec_type"] == "audio":
            info["has_audio"] = True
    return info
