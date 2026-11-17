"""ffmpeg / ffprobe 的薄封装：探测、转码代理、导出与进度解析。

所有函数只接受参数列表调用，不经过 shell，避免路径注入。
"""
from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path


class FFmpegError(RuntimeError):
    """ffmpeg / ffprobe 执行失败。"""


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, check=False, timeout=3600
        )
    except FileNotFoundError as exc:  # pragma: no cover - 环境依赖
        raise FFmpegError(f"找不到可执行文件：{cmd[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise FFmpegError("处理超时（>1 小时），已中止") from exc
    if proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()[-8:]
        raise FFmpegError(
            f"{Path(cmd[0]).name} 退出码 {proc.returncode}：\n" + "\n".join(tail)
        )
    return proc


def _find_bin(name: str) -> str:
    return name  # 依赖 PATH；启动脚本会检查存在性


@dataclass
class MediaInfo:
    path: str
    width: int            # 存储像素宽（旋转前）
    height: int           # 存储像素高（旋转前）
    rotation: int         # 显示旋转角度：0/90/180/270
    duration: float
    fps: float
    has_audio: bool
    display_width: int    # 考虑旋转后的显示宽
    display_height: int

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "width": self.width,
            "height": self.height,
            "rotation": self.rotation,
            "duration": round(self.duration, 3),
            "fps": round(self.fps, 3),
            "has_audio": self.has_audio,
            "display_width": self.display_width,
            "display_height": self.display_height,
        }


def probe(path: str | Path) -> MediaInfo:
    """读取媒体信息，旋转同时兼容 side_data 的 rotation 与 display_rotation。"""
    cmd = [
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ]
    proc = _run(cmd)
    data = json.loads(proc.stdout)
    streams = data.get("streams", [])
    vstreams = [s for s in streams if s.get("codec_type") == "video"]
    if not vstreams:
        raise FFmpegError("文件中没有视频流")
    v = vstreams[0]

    rotation = 0
    side = v.get("side_data_list") or []
    for item in side:
        for key in ("rotation", "display_rotation"):
            if key in item:
                angle = float(item[key])
                rotation = int(round(angle)) % 360
                break

    def _ratio(rate: str) -> float:
        if not rate or rate == "0/0":
            return 0.0
        num, _, den = rate.partition("/")
        den_f = float(den) if den else 1.0
        return float(num) / den_f if den_f else 0.0

    fps = _ratio(v.get("avg_frame_rate") or v.get("r_frame_rate") or "0/1")
    duration = float(data.get("format", {}).get("duration") or v.get("duration") or 0.0)
    has_audio = any(s.get("codec_type") == "audio" for s in streams)

    w, h = int(v["width"]), int(v["height"])
    if rotation in (90, 270):
        dw, dh = h, w
    else:
        dw, dh = w, h
    return MediaInfo(
        path=str(path), width=w, height=h, rotation=rotation,
        duration=duration, fps=fps or 0.0, has_audio=has_audio,
        display_width=dw, display_height=dh,
    )


def make_normalized_proxy(src: str | Path, dst: str | Path) -> None:
    """把带旋转元数据的视频烤正为无旋转 MP4（含音频，时间戳保持一致）。"""
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(src),
        "-map", "0:v:0", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        str(dst),
    ]
    _run(cmd)
    # 确认旋转已被烤掉
    info = probe(dst)
    if info.rotation != 0:
        raise FFmpegError("代理视频仍带有旋转元数据")


def build_export_command(
    src: str | Path, dst: str | Path, crop_w: int, crop_h: int,
    x_expr: str, has_audio: bool,
) -> list[str]:
    """组装导出命令。默认 autorotate 先烤正旋转，再按 x_expr 平移裁切。"""
    vf = f"crop={crop_w}:{crop_h}:{x_expr}:0,setsar=1"
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-nostdin",
        "-progress", "pipe:1", "-loglevel", "error",
        "-i", str(src),
        "-vf", vf,
        "-map", "0:v:0", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-pix_fmt", "yuv420p",
    ]
    if has_audio:
        cmd += ["-c:a", "aac", "-b:a", "192k"]
    else:
        cmd += ["-an"]
    cmd += ["-movflags", "+faststart", str(dst)]
    return cmd


_PROGRESS_TIME = re.compile(r"out_time_ms=(\d+)")


def parse_progress(line: str) -> float | None:
    """解析 ffmpeg -progress 输出，返回已处理秒数。"""
    m = _PROGRESS_TIME.match(line.strip())
    if not m:
        return None
    return int(m.group(1)) / 1_000_000.0


def make_sample(
    dst: str | Path, width: int = 1280, height: int = 720,
    seconds: float = 6.0, fps: int = 30, rotation: int = 0,
    with_audio: bool = True,
) -> list[str] | tuple[list[str], list[str]]:
    """生成本机测试视频：彩色移动方块 + 网格 +（可选）每秒哔声。

    带旋转时返回 (编码命令, 重封装命令)：ffmpeg 9 的 -display_rotation
    是输入选项，需要第二步把它写入输出容器的 Display Matrix。
    """
    # 移动的红方块 + 网格 + 角标方块，便于肉眼与自动检查取景运动。
    # 不使用 drawtext（部分 ffmpeg 构建不含 freetype）。
    draw = (
        f"drawbox=x='mod(t*300,{width}-120)':y=ih/2-60:w=120:h=120:"
        "color=red:t=fill,"
        "drawgrid=width=160:height=120:thickness=2:color=gray@0.6,"
        # 左上角青蓝色角标：旋转方向核对用的固定锚点
        "drawbox=x=20:y=20:w=100:h=60:color=cyan:t=fill,"
        # 右下角黄色角标
        f"drawbox=x={width}-120:y={height}-80:w=100:h=60:color=yellow:t=fill"
    )
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"testsrc2=size={width}x{height}:rate={fps}:duration={seconds}",
    ]
    if with_audio:
        # 1 秒周期、100ms 哔声，音视频同时从 0 开始，便于核对同步
        cmd += [
            "-f", "lavfi", "-i",
            "sine=frequency=880:beep_factor=4:sample_rate=48000:"
            f"duration={seconds}",
        ]
    cmd += ["-vf", draw, "-map", "0:v:0"]
    if with_audio:
        cmd += ["-map", "1:a:0", "-c:a", "aac", "-b:a", "192k"]
    cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
    if not rotation:
        cmd.append(str(dst))
        return cmd
    # 两阶段：先编码到临时文件，再带旋转元数据重封装
    flat = Path(str(dst) + ".flat.mp4")
    cmd.append(str(flat))
    remux = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-display_rotation", str(rotation),
        "-i", str(flat), "-c", "copy", str(dst),
    ]
    return cmd, remux


def generate_sample(dst: str | Path, **kwargs) -> None:
    """执行 make_sample 的全部命令（含旋转重封装），并清理临时文件。"""
    commands = make_sample(dst, **kwargs)
    if isinstance(commands, tuple):
        encode_cmd, remux_cmd = commands
        _run(encode_cmd)
        _run(remux_cmd)
        flat = Path(str(dst) + ".flat.mp4")
        flat.unlink(missing_ok=True)
    else:
        _run(commands)


def extract_png(src: str | Path, time: float, dst: str | Path) -> None:
    _run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-ss", f"{time:.3f}", "-i", str(src),
        "-frames:v", "1", str(dst),
    ])


def crop_png(src: str | Path, dst: str | Path,
             w: int, h: int, x: int, y: int = 0) -> None:
    """对静态图做固定裁切（测试里用来模拟参考取景）。"""
    _run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(src), "-vf", f"crop={w}:{h}:{x}:{y}",
        "-frames:v", "1", str(dst),
    ])


def psnr(reference: str | Path, distorted: str | Path) -> float:
    """返回平均 PSNR(dB)；两流尺寸需一致。"""
    proc = _run([
        "ffmpeg", "-hide_banner",
        "-i", str(reference), "-i", str(distorted),
        "-lavfi", "psnr", "-f", "null", "-",
    ])
    m = re.search(r"average:(\d+\.\d+)", proc.stderr)
    if not m:
        raise FFmpegError("无法解析 PSNR 结果：\n" + proc.stderr[-500:])
    return float(m.group(1))


def to_wav(src: str | Path, dst: str | Path) -> None:
    _run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(src), "-vn", "-ac", "1", "-ar", "48000",
        "-c:a", "pcm_s16le", str(dst),
    ])
