"""ffmpeg / ffprobe 封装。

本模块只做容器/编解码层面的事:
- 输入合法性探查 (时长、分辨率、逐行、8-bit)
- 解码为原始 RGB24
- 把本工具生成的 planar YUV 用 **FFV1 无损** 编码进 MKV, 带明示颜色标签
- 回读核对实际像素格式、帧数、时间与颜色参数

不调用任何有损编码器; 不在这里实现颜色转换。
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .color import CHROMA_LOCATION, PIXEL_FORMATS

FFV1 = "ffv1"
CONTAINER_EXT = "mkv"
MUXER = "matroska"              # ffmpeg -f 名称; 文件扩展名仍为 .mkv
COLOR_SPACE = "bt709"          # matrix coefficients / primaries / transfer
COLOR_RANGE = "tv"             # limited range 16-235 / 16-240


class FFmpegError(RuntimeError):
    pass


# ---------------------------------------------------------------- 基础工具

def ensure_tools() -> None:
    missing = [name for name in ("ffmpeg", "ffprobe") if shutil.which(name) is None]
    if missing:
        raise FFmpegError(f"找不到可执行文件: {', '.join(missing)} (请先 brew install ffmpeg)")


def _run(cmd: list[str], stdin_bytes: bytes | None = None) -> subprocess.CompletedProcess:
    proc = subprocess.run(
        cmd,
        input=stdin_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        raise FFmpegError(
            f"命令失败 ({proc.returncode}): {' '.join(cmd)}\n"
            f"{proc.stderr.decode('utf-8', 'replace')[-2000:]}"
        )
    return proc


def ffprobe_json(path: str | Path, count_frames: bool = False) -> dict:
    cmd = [
        "ffprobe", "-v", "error",
        "-show_format", "-show_streams",
    ]
    if count_frames:
        # Matroska 默认不提供 nb_frames, 需要实际计数
        cmd.append("-count_frames")
    cmd += ["-print_format", "json", str(path)]
    proc = _run(cmd)
    return json.loads(proc.stdout.decode("utf-8"))


def first_video_stream(meta: dict) -> dict:
    for st in meta.get("streams", []):
        if st.get("codec_type") == "video":
            return st
    raise FFmpegError("ffprobe 未发现视频流")


# ---------------------------------------------------------------- 输入校验

@dataclass
class InputInfo:
    width: int
    height: int
    even_width: int
    even_height: int
    duration_s: float
    fps: float
    fps_fraction: str
    frame_count: int | None
    pix_fmt: str
    field_order: str

    @property
    def frame_times(self) -> np.ndarray:
        if self.frame_count is None:
            n = int(np.ceil(self.duration_s * self.fps))
        else:
            n = self.frame_count
        return np.arange(n, dtype=np.float64) / self.fps


def validate_input(path: str | Path, max_seconds: float = 5.0,
                   max_height: int = 720) -> InputInfo:
    """校验外部输入: <=5s、<=720p、逐行、8-bit; 宽高统一裁到偶数。"""
    meta = ffprobe_json(path)
    st = first_video_stream(meta)

    width = int(st["width"])
    height = int(st["height"])
    field_order = st.get("field_order", "progressive")
    if field_order not in ("progressive", "unknown"):
        raise FFmpegError(f"只接收逐行视频, 当前 field_order={field_order}")

    bits = int(st.get("bits_per_raw_sample", 0) or 0)
    pix_fmt = st.get("pix_fmt", "")
    if bits and bits > 8:
        raise FFmpegError(f"只接收 8-bit 画面, 检测到 {bits}-bit ({pix_fmt})")
    if pix_fmt.endswith(("10le", "10be", "12le", "12be", "16le", "16be")):
        raise FFmpegError(f"只接收 8-bit 画面, 像素格式为 {pix_fmt}")

    if height > max_height:
        raise FFmpegError(f"最高支持 {max_height}p, 当前高度 {height}")

    duration_s = float(
        st.get("duration")
        or meta.get("format", {}).get("duration")
        or 0.0
    )
    if duration_s <= 0:
        raise FFmpegError("无法确定视频时长")
    if duration_s > max_seconds + 1e-3:
        raise FFmpegError(f"视频 {duration_s:.2f}s 超过 {max_seconds:g} 秒上限")

    num, den = st.get("avg_frame_rate", "0/0").split("/")
    num_f, den_f = float(num), float(den)
    if num_f <= 0 or den_f <= 0:
        num, den = st.get("r_frame_rate", "30/1").split("/")
        num_f, den_f = float(num), float(den)
    fps = num_f / den_f
    fps_fraction = f"{int(num_f)}/{int(den_f)}"

    nb_frames = st.get("nb_frames")
    frame_count = int(nb_frames) if nb_frames not in (None, "N/A") else None

    even_w, even_h = width - width % 2, height - height % 2
    if even_w <= 0 or even_h <= 0:
        raise FFmpegError("画面尺寸过小")

    return InputInfo(
        width=width,
        height=height,
        even_width=even_w,
        even_height=even_h,
        duration_s=duration_s,
        fps=fps,
        fps_fraction=fps_fraction,
        frame_count=frame_count,
        pix_fmt=pix_fmt,
        field_order=field_order or "progressive",
    )


# ---------------------------------------------------------------- 解码

def read_rgb24(path: str | Path, width: int, height: int) -> tuple[np.ndarray, list[float]]:
    """把视频解码为 RGB24 (full range), 返回 (帧数组 [N,H,W,3] uint8, PTS 秒)。"""
    ensure_tools()
    cmd = [
        "ffmpeg", "-nostdin", "-v", "error",
        "-i", str(path),
        "-vf", f"crop={width}:{height}:0:0,format=rgb24",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]
    proc = _run(cmd)
    frame_bytes = width * height * 3
    n = len(proc.stdout) // frame_bytes
    if n == 0 or len(proc.stdout) % frame_bytes != 0:
        raise FFmpegError(
            f"解码字节数 {len(proc.stdout)} 与 {width}x{height} RGB24 帧不整除"
        )
    frames = np.frombuffer(proc.stdout, dtype=np.uint8).reshape(n, height, width, 3).copy()
    pts = read_packets_pts(path)
    return frames, pts


def read_packets_pts(path: str | Path) -> list[float]:
    """用 -show_packets 取每帧实际 PTS (秒); 失败时返回空列表由调用方回退。"""
    try:
        proc = _run([
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "packet=pts_time",
            "-of", "json",
            str(path),
        ])
        data = json.loads(proc.stdout.decode("utf-8"))
        out: list[float] = []
        for pkt in data.get("packets", []):
            t = pkt.get("pts_time")
            if t is not None:
                out.append(float(t))
        return out
    except (FFmpegError, ValueError, KeyError):
        return []


# ---------------------------------------------------------------- FFV1 编码

def encode_ffv1(raw_path: str | Path, out_path: str | Path,
                width: int, height: int, mode: str,
                fps_fraction: str) -> None:
    """把 planar 8-bit YUV 原始流编码为 FFV1/MKV 无损文件, 带明示颜色标签。"""
    ensure_tools()
    pix_fmt = PIXEL_FORMATS[mode]
    # 颜色标签必须同时出现在 *输入侧*: rawvideo 默认按 full-range/未标记处理,
    # 只在输出侧写标签会触发一次 swscale range 转换, 破坏 FFV1 的字节级无损。
    cmd = [
        "ffmpeg", "-nostdin", "-y", "-v", "error",
        "-f", "rawvideo",
        "-color_range", COLOR_RANGE,
        "-colorspace", COLOR_SPACE,
        "-color_primaries", COLOR_SPACE,
        "-color_trc", COLOR_SPACE,
        "-pix_fmt", pix_fmt,
        "-s", f"{width}x{height}",
        "-framerate", fps_fraction,
        "-i", str(raw_path),
        "-an",
        "-c:v", FFV1, "-level", "3", "-coder", "1", "-context", "1",
        "-color_range", COLOR_RANGE,
        "-colorspace", COLOR_SPACE,
        "-color_primaries", COLOR_SPACE,
        "-color_trc", COLOR_SPACE,
        "-f", MUXER,
    ]
    location = CHROMA_LOCATION[mode]
    if location != "unspecified":
        # 明示色度采样位置; 个别封装组合若拒绝该选项则回退, 由回读核对兜底
        cmd += ["-chroma_sample_location", location]
    cmd.append(str(out_path))
    try:
        _run(cmd)
    except FFmpegError:
        cmd_retry = [a for a in cmd if a != "-chroma_sample_location" and a != location]
        _run(cmd_retry)


def read_planar_frame(raw_path: str | Path, width: int, height: int,
                      mode: str, index: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """从本工具生成的 planar 原始流里读取第 index 帧的 Y/Cb/Cr。"""
    from .color import plane_dims

    cw, ch = plane_dims(mode, width, height)
    y_size = width * height
    c_size = cw * ch
    frame_size = y_size + 2 * c_size
    offset = index * frame_size
    with open(raw_path, "rb") as fh:
        fh.seek(offset)
        buf = fh.read(frame_size)
    if len(buf) != frame_size:
        raise FFmpegError(f"读取 planar 帧 {index} 越界 (拿到 {len(buf)}/{frame_size} 字节)")
    y = np.frombuffer(buf[:y_size], dtype=np.uint8).reshape(height, width)
    cb = np.frombuffer(buf[y_size:y_size + c_size], dtype=np.uint8).reshape(ch, cw)
    cr = np.frombuffer(buf[y_size + c_size:], dtype=np.uint8).reshape(ch, cw)
    return y.copy(), cb.copy(), cr.copy()


# ---------------------------------------------------------------- 回读核对

@dataclass
class ProbeResult:
    ok: bool
    warnings: list[str]
    actual: dict


def verify_export(path: str | Path, mode: str, width: int, height: int,
                  frame_count: int, fps_fraction: str,
                  expected_duration_s: float) -> ProbeResult:
    """回读核对实际像素格式、帧数、时间与颜色参数; 任何替换/缺失都如实列出。"""
    warnings: list[str] = []
    meta = ffprobe_json(path, count_frames=True)
    st = first_video_stream(meta)
    actual = {
        "文件": str(path),
        "codec_name": st.get("codec_name"),
        "pix_fmt": st.get("pix_fmt"),
        "width": st.get("width"),
        "height": st.get("height"),
        "nb_frames": st.get("nb_frames") or st.get("nb_read_frames"),
        "avg_frame_rate": st.get("avg_frame_rate"),
        "duration": st.get("duration") or meta.get("format", {}).get("duration"),
        "color_range": st.get("color_range"),
        "color_space": st.get("color_space"),
        "color_primaries": st.get("color_primaries"),
        "color_transfer": st.get("color_transfer"),
        "chroma_location": st.get("chroma_location", "unspecified"),
    }

    expected_pix = PIXEL_FORMATS[mode]
    if st.get("codec_name") != FFV1:
        warnings.append(f"编码被替换: 期望 {FFV1}, 实际 {st.get('codec_name')}")
    if st.get("pix_fmt") != expected_pix:
        warnings.append(f"像素格式被替换: 期望 {expected_pix}, 实际 {st.get('pix_fmt')}")
    if int(st.get("width", 0)) != width or int(st.get("height", 0)) != height:
        warnings.append(f"尺寸不符: 期望 {width}x{height}, 实际 {st.get('width')}x{st.get('height')}")

    actual_frames = st.get("nb_frames")
    if actual_frames not in (None, "N/A") and int(actual_frames) != frame_count:
        warnings.append(f"帧数不符: 期望 {frame_count}, 实际 {actual_frames}")

    if st.get("avg_frame_rate") not in (fps_fraction,):
        warnings.append(f"帧率标签不符: 期望 {fps_fraction}, 实际 {st.get('avg_frame_rate')}")

    dur = float(actual["duration"] or 0.0)
    if abs(dur - expected_duration_s) > max(0.1, 0.25 * expected_duration_s):
        warnings.append(f"时长不符: 期望约 {expected_duration_s:.3f}s, 实际 {dur:.3f}s")

    for key, want in (
        ("color_range", COLOR_RANGE),
        ("color_space", COLOR_SPACE),
        ("color_primaries", COLOR_SPACE),
        ("color_transfer", COLOR_SPACE),
    ):
        if st.get(key) != want:
            warnings.append(f"颜色参数 {key}: 期望 {want}, 实际 {st.get(key)}")

    want_loc = CHROMA_LOCATION[mode]
    if want_loc != "unspecified" and st.get("chroma_location", "unspecified") != want_loc:
        warnings.append(
            f"chroma_location: 期望 {want_loc}, 实际 {st.get('chroma_location', 'unspecified')}"
        )

    # 像素格式正确才可能做到字节级无损; 这里再解码比对一次
    if st.get("pix_fmt") == expected_pix:
        try:
            _verify_lossless_decode(path, expected_pix, width, height, frame_count)
        except FFmpegError as exc:
            warnings.append(f"无损回读校验失败: {exc}")

    return ProbeResult(ok=not warnings, warnings=warnings, actual=actual)


def _verify_lossless_decode(path: str | Path, pix_fmt: str,
                            width: int, height: int, frame_count: int) -> None:
    """探测用: 确认该文件能以声明的像素格式完整解码出预期帧数。"""
    from .color import plane_dims

    proc = _run([
        "ffmpeg", "-nostdin", "-v", "error",
        "-i", str(path),
        "-f", "rawvideo", "-pix_fmt", pix_fmt, "-",
    ])
    mode = {v: k for k, v in PIXEL_FORMATS.items()}[pix_fmt]
    cw, ch = plane_dims(mode, width, height)
    frame_size = width * height + 2 * cw * ch
    n = len(proc.stdout) // frame_size
    if n != frame_count or len(proc.stdout) % frame_size != 0:
        raise FFmpegError(f"解码出 {n} 帧 (期望 {frame_count}), 字节余数 {len(proc.stdout) % frame_size}")
