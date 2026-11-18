"""360p 代理生成与关联信息(sidecar)。

关联只认文件 sha256 与内容指纹, 绝不以文件名判断"同一份原片"。
"""

from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from .errors import ValidationError
from .ffmedia import FFmpegError, MediaInfo, content_digest, probe, sha256_file

MAX_DURATION_SEC = 15.0
MAX_WIDTH = 1920
MAX_HEIGHT = 1080
TARGET_HEIGHT = 360
SIDECAR_SUFFIX = ".sidecar.json"
SCHEMA_VERSION = 1


def validate_source(info: MediaInfo) -> None:
    """导入约束: mp4 容器、<=15s、<=1080p、CFR(CFR 在 probe 阶段已强制)。"""
    suffix = Path(info.path).suffix.lower()
    if suffix != ".mp4" or "mp4" not in info.container.split(","):
        raise ValidationError(
            f"只支持 mp4 原片, 当前为 {suffix or info.container}: {info.path}"
        )
    if info.duration > MAX_DURATION_SEC + 0.05:
        raise ValidationError(
            f"原片时长 {info.duration:.2f}s 超过 {MAX_DURATION_SEC:.0f}s 上限"
        )
    if info.width > MAX_WIDTH or info.height > MAX_HEIGHT:
        raise ValidationError(
            f"原片分辨率 {info.resolution} 超过 {MAX_WIDTH}x{MAX_HEIGHT} 上限"
        )
    if info.nb_video_frames <= 0:
        raise ValidationError("原片没有可读取的视频帧")


def target_dimensions(src_w: int, src_h: int) -> tuple[int, int]:
    """保持宽高比缩到 360p(高度), 不放大, 宽高强制偶数。"""
    h = min(TARGET_HEIGHT, src_h)
    w = round(src_w * h / src_h / 2) * 2
    h = round(h / 2) * 2
    return max(w, 2), max(h, 2)


def sidecar_path_for(proxy_path: str | Path) -> Path:
    return Path(str(proxy_path) + SIDECAR_SUFFIX)


def load_sidecar(proxy_path: str | Path) -> dict | None:
    p = sidecar_path_for(proxy_path)
    if not p.is_file():
        return None
    with open(p, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _ffmpeg(cmd: list[str]) -> None:
    import subprocess
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise FFmpegError(
            f"ffmpeg 转码失败:\n{proc.stderr.strip()[-800:]}"
        )


def build_proxy(
    source_path: str | Path,
    proxy_path: str | Path,
    progress=None,
) -> tuple[MediaInfo, dict]:
    """生成 360p 代理并写入 sidecar, 返回 (代理 MediaInfo, sidecar dict)。

    失败时不会留下半成品代理, 也不会覆盖任何已有有效代理。
    progress: 可选回调(str)。
    """
    source_path = Path(source_path)
    proxy_path = Path(proxy_path)
    if progress:
        progress("探测原片…")
    src = probe(source_path)
    validate_source(src)

    w, h = target_dimensions(src.width, src.height)
    proxy_path.parent.mkdir(parents=True, exist_ok=True)

    # 先写临时文件, 成功后原子替换, 保证失败不会留下损坏代理。
    fd, tmp_name = tempfile.mkstemp(
        prefix=".proxy_tmp_", suffix=".mp4", dir=str(proxy_path.parent)
    )
    os.close(fd)
    os.unlink(tmp_name)

    cmd = [
        "ffmpeg", "-y", "-v", "error", "-nostdin", "-i", str(source_path),
        "-vf", f"scale={w}:{h}:flags=lanczos,setsar=1",
        "-c:v", "libx264", "-preset", "medium", "-crf", "23",
        "-pix_fmt", "yuv420p", "-r", f"{src.frame_rate:g}",
    ]
    if src.has_audio:
        cmd += ["-c:a", "aac", "-b:a", "128k", "-ar", "48000"]
    else:
        cmd += ["-an"]
    cmd += ["-movflags", "+faststart", tmp_name]

    try:
        if progress:
            progress(f"转码 {src.resolution} -> {w}x{h}…")
        _ffmpeg(cmd)

        if progress:
            progress("校验代理输出…")
        dst = probe(tmp_name)
        if dst.nb_video_frames != src.nb_video_frames:
            raise FFmpegError(
                f"输出帧数 {dst.nb_video_frames} 与原片 {src.nb_video_frames} 不一致"
            )

        if progress:
            progress("计算内容指纹…")
        src.sha256 = sha256_file(source_path)
        dst.sha256 = sha256_file(tmp_name)
        src.content_digest, _ = content_digest(source_path)
        dst.content_digest, _ = content_digest(tmp_name)

        os.replace(tmp_name, proxy_path)
    except BaseException:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)
        raise

    sidecar = {
        "schema_version": SCHEMA_VERSION,
        "tool": "proxy_check",
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "build": {
            "scaler": "lanczos",
            "crf": 23,
            "video_codec": "libx264",
            "audio_codec": "aac" if src.has_audio else None,
            "target_height": TARGET_HEIGHT,
        },
        "source": src.to_dict(),
        "proxy": dst.to_dict(),
    }
    with open(sidecar_path_for(proxy_path), "w", encoding="utf-8") as fh:
        json.dump(sidecar, fh, ensure_ascii=False, indent=2)
    dst.path = str(proxy_path.resolve())
    return dst, sidecar
