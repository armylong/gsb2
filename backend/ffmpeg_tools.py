"""ffprobe / ffmpeg 封装：媒体探测、真实帧时间、帧提取、场景切换检测。

设计要点
--------
* 所有时间都以 ffprobe 输出的 pts_time（展示时间戳）为准，不假设帧间隔均匀，
  因此可变帧率 (VFR) 视频也能拿到每个候选帧的真实时间。
* 旋转信息（display matrix side data 或 rotate tag）统一解析为顺时针角度，
  取帧时用 ``-noautorotate`` + 显式 transpose 处理，保证截图方向正确且不依赖
  ffmpeg 版本对 autorotate 默认值的差异。
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from fractions import Fraction
from typing import Optional


class ProbeError(Exception):
    """媒体文件无法探测或结构不合法（无视频流、文件损坏等）。"""


def ffmpeg_supports(flag: str) -> bool:
    """检测本机 ffmpeg 是否支持某个命令行选项（结果缓存）。

    ffmpeg 5+ 将 ``-vsync`` 更名为 ``-fps_mode``，需要按版本选择。
    """
    if not hasattr(ffmpeg_supports, "_cache"):
        ffmpeg_supports._cache = {}
    if flag in ffmpeg_supports._cache:
        return ffmpeg_supports._cache[flag]
    try:
        proc = subprocess.run(
            ["ffmpeg", "-hide_banner", "-h", "long"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        help_text = proc.stdout + proc.stderr
    except (FileNotFoundError, subprocess.TimeoutExpired):
        help_text = ""
    ffmpeg_supports._cache[flag] = flag in help_text
    return ffmpeg_supports._cache[flag]


def passthrough_flag() -> list[str]:
    """返回当前 ffmpeg 支持的“时间戳直通、不做帧率归一化”参数。"""
    if ffmpeg_supports("-fps_mode"):
        return ["-fps_mode", "passthrough"]
    return ["-vsync", "passthrough"]


def noautorotate_flag() -> list[str]:
    """关闭自动旋转的参数。

    ``-noautorotate`` 是 ffmpeg 长期保留的布尔开关写法（新版的
    ``-autorotate`` 也是布尔型 AVOption，不接受 ``0`` 这样的值参数），
    在 ffmpeg 4.x/5.x/6.x/7.x/9.x 上均可使用，因此直接返回该开关。
    """
    return ["-noautorotate"]


def _ffprobe_json(path: str, args: list[str]) -> dict:
    cmd = ["ffprobe", "-v", "error", *args, "-of", "json", path]
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=120, check=False
        )
    except FileNotFoundError as exc:  # pragma: no cover - 环境问题
        raise ProbeError("系统未找到 ffprobe，请先安装 ffmpeg。") from exc
    except subprocess.TimeoutExpired as exc:
        raise ProbeError("ffprobe 探测超时，文件可能已损坏。") from exc
    if proc.returncode != 0:
        raise ProbeError(
            "ffprobe 无法读取该文件（可能已损坏或格式不受支持）："
            + proc.stderr.strip()[:500]
        )
    try:
        return json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise ProbeError("ffprobe 输出无法解析。") from exc


def parse_rotation(stream: dict) -> int:
    """从流信息中解析顺时针旋转角度，规范化为 0/90/180/270。"""
    # 旧式 metadata tag（部分容器使用）
    tag = stream.get("tags", {}).get("rotate")
    candidates: list[int] = []
    if tag:
        try:
            candidates.append(int(round(float(tag))))
        except ValueError:
            pass
    # display matrix side data（现代 ffmpeg 的常见位置）
    for side in stream.get("side_data_list", []) or []:
        rotation = side.get("rotation")
        if rotation is not None:
            # side data 中的 rotation 单位为度，逆时针为正；取反得到顺时针
            candidates.append(int(round(-float(rotation))))
    for value in candidates:
        value = value % 360
        if value in (0, 90, 180, 270):
            return value
    return 0


@dataclass
class FrameInfo:
    """一个实际解码帧的信息（时间单位：秒）。"""

    frame_index: int  # 在视频流中的解码序号，仅用于定位，不用于推算时间
    pts_time: float
    pict_type: str  # I/P/B 等

    def to_dict(self) -> dict:
        return {
            "frame_index": self.frame_index,
            "pts_time": round(self.pts_time, 6),
            "pict_type": self.pict_type,
        }


@dataclass
class VideoStream:
    index: int
    codec: str
    width: int
    height: int
    rotation: int
    avg_frame_rate: Optional[float]
    r_frame_rate: Optional[float]
    duration: Optional[float]
    nb_frames: Optional[int]

    @property
    def is_vfr(self) -> bool:
        """avg_frame_rate 与 r_frame_rate 不一致通常意味着可变帧率。

        最终判定以真实帧时间间隔为准（见 :func:`list_frames` 后的分析），
        这里只给出一个快速的初步标记。
        """
        if self.avg_frame_rate is None or self.r_frame_rate is None:
            return False
        if self.avg_frame_rate <= 0 or self.r_frame_rate <= 0:
            return False
        return abs(self.avg_frame_rate - self.r_frame_rate) > 0.01 * max(
            self.avg_frame_rate, self.r_frame_rate
        )

    def to_dict(self) -> dict:
        return {
            "index": self.index,
            "codec": self.codec,
            "width": self.width,
            "height": self.height,
            "rotation": self.rotation,
            "avg_frame_rate": round(self.avg_frame_rate, 4)
            if self.avg_frame_rate
            else None,
            "r_frame_rate": round(self.r_frame_rate, 4)
            if self.r_frame_rate
            else None,
            "duration": round(self.duration, 6) if self.duration is not None else None,
            "nb_frames": self.nb_frames,
            "vfr_hint": self.is_vfr,
        }


def _parse_fraction(value: Optional[str]) -> Optional[float]:
    if not value or value == "0/0":
        return None
    try:
        return float(Fraction(value))
    except (ValueError, ZeroDivisionError):
        return None


def probe_media(path: str) -> dict:
    """探测媒体文件，返回格式信息与全部视频流。"""
    data = _ffprobe_json(path, ["-show_format", "-show_streams"])
    fmt = data.get("format", {})
    streams: list[VideoStream] = []
    for raw in data.get("streams", []):
        if raw.get("codec_type") != "video":
            continue
        duration = raw.get("duration")
        if duration is None:
            duration = fmt.get("duration")
        try:
            duration_val = float(duration) if duration is not None else None
        except ValueError:
            duration_val = None
        try:
            nb_frames = int(raw["nb_frames"]) if raw.get("nb_frames") else None
        except ValueError:
            nb_frames = None
        streams.append(
            VideoStream(
                index=int(raw["index"]),
                codec=raw.get("codec_name", "unknown"),
                width=int(raw.get("width") or 0),
                height=int(raw.get("height") or 0),
                rotation=parse_rotation(raw),
                avg_frame_rate=_parse_fraction(raw.get("avg_frame_rate")),
                r_frame_rate=_parse_fraction(raw.get("r_frame_rate")),
                duration=duration_val,
                nb_frames=nb_frames,
            )
        )
    return {
        "format": {
            "name": fmt.get("format_name"),
            "long_name": fmt.get("format_long_name"),
            "duration": float(fmt["duration"]) if fmt.get("duration") else None,
            "bit_rate": int(fmt["bit_rate"]) if fmt.get("bit_rate") else None,
            "size": int(fmt["size"]) if fmt.get("size") else None,
        },
        "video_streams": [s.to_dict() for s in streams],
    }


def list_frames(path: str, stream_index: int) -> list[FrameInfo]:
    """列出视频流中每一帧的真实 pts_time。

    使用 ``-show_frames`` 逐帧读取展示时间戳，整条链路不依赖帧序号 × 标称帧率
    的换算，VFR 视频同样准确。
    """
    data = _ffprobe_json(
        path,
        [
            "-select_streams",
            f"v:{stream_index}",
            "-show_frames",
            "-show_entries",
            "frame=pts_time,pict_type",
        ],
    )
    frames: list[FrameInfo] = []
    for i, raw in enumerate(data.get("frames", [])):
        pts = raw.get("pts_time")
        if pts is None:
            # 极少数容器只给 pts 不给 pts_time
            continue
        try:
            pts_time = float(pts)
        except ValueError:
            continue
        frames.append(
            FrameInfo(
                frame_index=i,
                pts_time=pts_time,
                pict_type=raw.get("pict_type", "?"),
            )
        )
    frames.sort(key=lambda f: f.pts_time)
    # 重新编号，保证 frame_index 与排序后的位置一致
    for pos, frame in enumerate(frames):
        frame.frame_index = pos
    return frames


def frames_are_vfr(frames: list[FrameInfo], tolerance: float = 0.15) -> bool:
    """基于真实帧间隔判断是否为可变帧率。"""
    if len(frames) < 4:
        return False
    deltas = [
        frames[i].pts_time - frames[i - 1].pts_time for i in range(1, len(frames))
    ]
    deltas = [d for d in deltas if d > 0]
    if not deltas:
        return False
    mean = sum(deltas) / len(deltas)
    if mean <= 0:
        return False
    spread = (max(deltas) - min(deltas)) / mean
    return spread > tolerance


def nearest_frame(
    frames: list[FrameInfo], requested: float
) -> Optional[FrameInfo]:
    """找到 pts_time 最接近请求时间的真实帧。"""
    if not frames:
        return None
    import bisect

    times = [f.pts_time for f in frames]
    pos = bisect.bisect_left(times, requested)
    candidates = []
    if pos < len(frames):
        candidates.append(frames[pos])
    if pos > 0:
        candidates.append(frames[pos - 1])
    return min(candidates, key=lambda f: abs(f.pts_time - requested))


def _rotation_filter(rotation: int) -> list[str]:
    """顺时针旋转角度对应的 transpose 滤镜链。"""
    if rotation == 90:
        # 顺时针 90° = transpose=1
        return ["transpose=1"]
    if rotation == 180:
        return ["transpose=1", "transpose=1"]
    if rotation == 270:
        # 顺时针 270° = 逆时针 90° = transpose=2
        return ["transpose=2"]
    return []


def build_extract_cmd(
    path: str,
    stream_index: int,
    frame_indices: list[int],
    out_pattern: str,
    rotation: int,
) -> list[str]:
    """构造一次提取多帧的 ffmpeg 参数（不含程序名，供 :func:`run_ffmpeg` 使用）。

    - ``-noautorotate`` 关闭自动旋转，改由显式 transpose 控制，行为跨版本一致；
    - ``select='eq(n,i)+...'`` 按解码序号选帧，序号来自 ffprobe 真实枚举；
    - ``-vsync passthrough`` 保留原始时间戳，不做帧率归一化。

    输出文件名形如 ``frame_%03d.jpg``，由调用方保证序号与 frame_indices 对齐。
    """
    select_expr = "+".join(f"eq(n\\,{i})" for i in frame_indices)
    chain = [f"select='{select_expr}'"]
    chain.extend(_rotation_filter(rotation))
    return [
        *noautorotate_flag(),
        "-i",
        path,
        "-map",
        f"0:v:{stream_index}",
        "-filter:v",
        ",".join(chain),
        *passthrough_flag(),
        "-frame_pts",
        "0",
        "-y",
        out_pattern,
    ]


def run_ffmpeg(
    args: list[str],
    cancel_event,
    on_progress=None,
    total_duration: Optional[float] = None,
) -> tuple[int, str]:
    """运行 ffmpeg 子进程，支持取消与基于 ``-progress`` 的进度回调。

    ``args`` 为 ffmpeg 参数（不含程序名），输出文件应是最后一个元素。
    返回 ``(returncode, stderr 文本)``；取消时终止进程并返回 ``(-1, stderr)``。
    """
    # 在输出文件（最后一个参数）之前插入 progress 输出，进度信息走 stdout，
    # 诊断日志仍走 stderr。
    progress_args = args[:-1] + [
        "-progress",
        "pipe:1",
        "-nostats",
        args[-1],
    ]
    proc = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-nostdin", *progress_args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    stderr_lines: list[str] = []

    import threading

    def drain_stderr() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            stderr_lines.append(line)

    reader = threading.Thread(target=drain_stderr, daemon=True)
    reader.start()

    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            if cancel_event is not None and cancel_event.is_set():
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                reader.join(timeout=2)
                return -1, "".join(stderr_lines)
            if on_progress and total_duration and line.startswith("out_time_ms="):
                try:
                    out_us = int(line.split("=", 1)[1].strip())
                    ratio = max(0.0, min(0.999, (out_us / 1_000_000) / total_duration))
                    on_progress(ratio)
                except ValueError:
                    pass
        proc.wait()
        reader.join(timeout=2)
        return proc.returncode, "".join(stderr_lines)
    except BaseException:
        proc.kill()
        raise


def run_scene_detect(
    path: str,
    stream_index: int,
    threshold: float,
    cancel_event,
    on_progress=None,
    total_duration: Optional[float] = None,
) -> tuple[list[float], str, int]:
    """运行场景切换检测。

    返回 ``(切换时间 pts_time 列表, stderr, returncode)``；取消时
    returncode 为 -1。threshold 对应 ffmpeg ``select='gt(scene,T)'``
    的场景分数阈值 (0~1)。

    注意只返回时间戳而不返回 showinfo 的 ``n``：该序号是 select 滤镜
    **输出**帧的序号，不是视频流内的解码帧序号，流内位置必须由时间戳
    经 :func:`nearest_frame` 映射回 ffprobe 枚举的真实帧。
    """
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        *noautorotate_flag(),
        "-i",
        path,
        "-map",
        f"0:v:{stream_index}",
        "-filter:v",
        f"select='gt(scene\\,{threshold:.4f})',showinfo",
        "-f",
        "null",
        "-",
    ]
    proc = subprocess.Popen(
        cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True
    )
    scene_times: list[float] = []
    lines: list[str] = []
    import re
    import threading

    cancelled = False

    def reader() -> None:
        nonlocal cancelled
        assert proc.stderr is not None
        # showinfo 行形如 "... n:  50 pts_time:2 ..."，只取时间戳
        pattern = re.compile(r"\bpts_time:([0-9]+(?:\.[0-9]+)?)")
        for line in proc.stderr:
            lines.append(line)
            if "showinfo" in line and "pts_time:" in line:
                m = pattern.search(line)
                if m:
                    scene_times.append(float(m.group(1)))
            if on_progress and total_duration:
                m = re.search(r"time=\s*([0-9:.]+)", line)
                if m:
                    parts = m.group(1).split(":")
                    try:
                        secs = (
                            int(parts[0]) * 3600
                            + int(parts[1]) * 60
                            + float(parts[2])
                        )
                        ratio = max(0.0, min(0.999, secs / total_duration))
                        on_progress(ratio)
                    except (ValueError, IndexError):
                        pass
            if cancel_event is not None and cancel_event.is_set() and not cancelled:
                cancelled = True
                proc.terminate()

    t = threading.Thread(target=reader, daemon=True)
    t.start()
    proc.wait()
    t.join(timeout=2)
    if cancelled:
        return [], "".join(lines), -1
    return scene_times, "".join(lines), proc.returncode
